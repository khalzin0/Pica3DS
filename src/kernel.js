// High-level emulation of the 3DS kernel (Horizon): objects, handles, threads, scheduler, SVCs.
(function (EMU) {
  'use strict';

  const hex = EMU.hex;
  const TICKS_PER_SEC = 268111856;
  const TICKS_PER_INSN = 2;
  const SLICE = 20000;
  const RES_TIMEOUT = 0x09401BFE;
  const RES_INVALID_HANDLE = 0xD8E007F7;
  const RES_NOT_OWNER = 0xD8E0041F;
  const RES_NOT_IMPLEMENTED = 0xF8C007F4;
  const RES_NOT_FOUND = 0xD88007FA;

  const nsToTicks = (lo, hi) => {
    const ns = (hi | 0) * 4294967296 + (lo >>> 0);
    if (ns < 0) return Infinity;
    return Math.ceil(ns * TICKS_PER_SEC / 1e9);
  };

  EMU.TICKS_PER_SEC = TICKS_PER_SEC;
  EMU.TICKS_PER_FRAME = Math.round(TICKS_PER_SEC / 59.83);

  // ------------------------------------------------------------------ kernel objects
  class KObject {
    constructor(type) { this.type = type; this.waiters = new Set(); }
    shouldWait() { return false; }
    acquire() {}
  }

  class KEvent extends KObject {
    constructor(resetType, name = '') { super('Event'); this.resetType = resetType; this.signaled = false; this.name = name; }
    shouldWait() { return !this.signaled; }
    acquire() { if (this.resetType === 0) this.signaled = false; }
  }

  class KTimer extends KObject {
    constructor(resetType) { super('Timer'); this.resetType = resetType; this.signaled = false; this.next = Infinity; this.interval = 0; }
    shouldWait() { return !this.signaled; }
    acquire() { if (this.resetType === 0) this.signaled = false; }
  }

  class KMutex extends KObject {
    constructor() { super('Mutex'); this.owner = null; this.count = 0; }
    shouldWait(t) { return this.owner !== null && this.owner !== t; }
    acquire(t) { this.owner = t; this.count++; }
  }

  class KSemaphore extends KObject {
    constructor(count, max) { super('Semaphore'); this.count = count; this.max = max; }
    shouldWait() { return this.count <= 0; }
    acquire() { this.count--; }
  }

  class KThread extends KObject {
    constructor(id, ctx, prio) {
      super('Thread');
      this.id = id; this.ctx = ctx; this.prio = prio;
      this.state = 'ready';   // ready | waiting | dead
      this.waitObjs = null; this.waitAll = false; this.waitN = false;
      this.waitArb = -1; this.deadline = Infinity; this.timeoutResult = RES_TIMEOUT;
    }
    shouldWait() { return this.state !== 'dead'; }
  }

  class KMemBlock extends KObject {
    // addr: where the block goes when an app maps it at address 0 (e.g. the shared font)
    constructor(pages, size, addr = 0) { super('SharedMemory'); this.pages = pages; this.size = size; this.addr = addr; }
  }

  class KSession extends KObject {
    constructor(service) { super('Session'); this.service = service; }
  }

  class KGeneric extends KObject {}

  EMU.KEvent = KEvent; EMU.KTimer = KTimer; EMU.KMutex = KMutex; EMU.KMemBlock = KMemBlock; EMU.KSession = KSession;

  // ------------------------------------------------------------------ kernel
  class Kernel {
    constructor(emu) {
      this.emu = emu;
      this.mem = emu.mem;
      this.cpu = emu.cpu;
      this.handles = new Map();
      this.nextHandle = 0x100;
      this.threads = [];
      this.current = null;  // thread whose context is loaded in the CPU
      this.ticks = 0;
      this.timers = new Set();
      // Linear (GPU-visible) heap: 0x30000000 for apps built for kernel 2.44+, else 0x14000000
      this.linearBase = 0x30000000;
      this.linearNext = this.linearBase;
      this.memUsed = 0;
      this.nextThreadId = 1;
      this.rr = 0;
      this.starve = 0;
      this.process = new KGeneric('Process');
      this.resLimit = new KGeneric('ResourceLimit');
      this.cpu.svcHandler = (n) => this.svc(n);
      this.svcCounts = new Map();
    }

    log(msg) { this.emu.log(msg); }

    createHandle(obj) {
      const h = this.nextHandle++;
      this.handles.set(h, obj);
      return h;
    }

    getObj(h) {
      if (h === 0xFFFF8000) return this.currentThread();
      if (h === 0xFFFF8001) return this.process;
      return this.handles.get(h) || null;
    }

    currentThread() { return this.running; }

    // ---------------------------------------------------------------- threads
    createThread(entry, arg, stackTop, prio) {
      const ctx = this.cpu.newContext();
      ctx.r[0] = arg; ctx.r[13] = stackTop;
      ctx.pc = (entry & ~1) >>> 0; ctx.t = entry & 1;
      const idx = this.threads.length;
      ctx.tls = 0x1FF82000 + idx * 0x200;
      if (idx >= 64) throw new EMU.EmuError('too many threads');
      const t = new KThread(this.nextThreadId++, ctx, prio);
      this.threads.push(t);
      this.mem.fill(ctx.tls, 0x200, 0);
      return t;
    }

    pickThread() {
      let best = null;
      const n = this.threads.length;
      for (let k = 0; k < n; k++) {
        const t = this.threads[(this.rr + k) % n];
        if (t.state === 'ready' && (best === null || t.prio < best.prio)) best = t;
      }
      // Starvation guard: if the same thread hogs the CPU, occasionally let lower-priority threads run.
      if (best && this.starve >= 8) {
        const others = this.threads.filter((t) => t.state === 'ready' && t !== best);
        if (others.length) { best = others[(this.rr++) % others.length]; this.starve = 0; }
      }
      return best;
    }

    // Contexts are saved after every slice, so a thread's ctx is always authoritative
    // (wakeups write their results into it). Always reload it.
    switchTo(t) {
      const sameThread = this.current === t;
      const excl = this.cpu.excl;
      this.cpu.loadContext(t.ctx);
      if (sameThread) this.cpu.excl = excl;
      this.current = t;
    }

    // Run threads until the tick counter reaches `target`.
    runUntil(target) {
      const cpu = this.cpu;
      while (this.ticks < target && !this.emu.halted) {
        this.processTimeouts();
        const t = this.pickThread();
        if (!t) {
          const next = Math.min(this.nextDeadline(), target);
          this.ticks = Math.max(this.ticks, next);
          continue;
        }
        this.switchTo(t);
        this.running = t;
        const budget = Math.min(SLICE, Math.max(1, Math.ceil((target - this.ticks) / TICKS_PER_INSN)));
        let n;
        try {
          n = cpu.run(budget);
        } finally {
          this.running = null;
        }
        this.ticks += n * TICKS_PER_INSN;
        this.emu.insnCount += n;
        if (t.state !== 'dead') cpu.saveContext(t.ctx);
        if (t.state === 'ready' && n >= budget) this.starve++; else this.starve = 0;
        this.rr++;
      }
    }

    nextDeadline() {
      let d = Infinity;
      for (const t of this.threads) if (t.state === 'waiting' && t.deadline < d) d = t.deadline;
      for (const tm of this.timers) if (tm.next < d) d = tm.next;
      return d;
    }

    processTimeouts() {
      const now = this.ticks;
      for (const tm of this.timers) {
        if (tm.next <= now) {
          tm.next = tm.interval > 0 ? tm.next + tm.interval : Infinity;
          if (tm.next !== Infinity && tm.next <= now) tm.next = now + tm.interval;
          this.signal(tm);
          if (tm.resetType === 2) tm.signaled = false;
          if (tm.onFire) tm.onFire();
        }
      }
      for (const t of this.threads) {
        if (t.state === 'waiting' && t.deadline <= now) this.resume(t, t.timeoutResult);
      }
    }

    block(t, objs, waitAll, deadline, waitN) {
      t.state = 'waiting';
      t.waitObjs = objs; t.waitAll = waitAll; t.waitN = waitN;
      t.deadline = deadline; t.timeoutResult = RES_TIMEOUT;
      for (const o of objs) o.waiters.add(t);
      this.cpu.stop = true;
    }

    resume(t, result, index) {
      if (t.waitObjs) for (const o of t.waitObjs) o.waiters.delete(t);
      t.waitObjs = null; t.waitArb = -1; t.deadline = Infinity;
      t.state = 'ready';
      t.ctx.r[0] = result >>> 0;
      if (index !== undefined && t.waitN) t.ctx.r[1] = index;
      if (this.running && t.prio < this.running.prio) this.cpu.stop = true;
    }

    tryWake(t) {
      const objs = t.waitObjs;
      if (t.waitAll) {
        for (const o of objs) if (o.shouldWait(t)) return false;
        for (const o of objs) o.acquire(t);
        this.resume(t, 0, 0);
        return true;
      }
      for (let i = 0; i < objs.length; i++) {
        if (!objs[i].shouldWait(t)) { objs[i].acquire(t); this.resume(t, 0, i); return true; }
      }
      return false;
    }

    // Called whenever an object may have become available.
    signal(obj) {
      if (obj instanceof KEvent || obj instanceof KTimer) obj.signaled = true;
      if (obj.waiters.size === 0) return;
      const ws = [...obj.waiters].sort((a, b) => a.prio - b.prio);
      for (const t of ws) if (t.state === 'waiting' && t.waitObjs) this.tryWake(t);
    }

    signalEvent(ev) {
      this.signal(ev);
      if (ev.resetType === 2) ev.signaled = false;
    }

    exitThread(t) {
      t.state = 'dead';
      if (this.running === t) this.cpu.stop = true;
      // Release mutexes held by the thread.
      for (const obj of this.handles.values()) {
        if (obj instanceof KMutex && obj.owner === t) { obj.owner = null; obj.count = 0; this.signal(obj); }
      }
      this.signal(t);
      if (this.threads.every((x) => x.state === 'dead')) this.emu.halt('All threads exited');
    }

    // ---------------------------------------------------------------- memory
    controlMemory(op, addr0, addr1, size) {
      size = ((size + 0xFFF) & ~0xFFF) >>> 0;
      const type = op & 0xFF;
      switch (type) {
        case 3: { // COMMIT / ALLOC
          let addr = addr0;
          if (op & 0x10000) { addr = addr0 || this.linearNext; this.linearNext = Math.max(this.linearNext, addr + size); }
          if (size) this.mem.alloc(addr, size, 3, 5, op & 0x10000 ? 'linear heap' : 'heap');
          this.memUsed += size;
          return [0, addr];
        }
        case 1: // FREE
          this.mem.unmap(addr0, size);
          this.memUsed -= size;
          return [0, addr0];
        case 4: // MAP (alias addr1 at addr0)
          this.mem.mapPages(addr0, this.mem.getPages(addr1, size), 3, 6, 'alias');
          return [0, addr0];
        case 5: // UNMAP
          this.mem.unmap(addr0, size);
          return [0, addr0];
        case 6: // PROTECT
          return [0, addr0];
      }
      this.log(`svcControlMemory: unsupported op ${hex(op)}`);
      return [RES_NOT_IMPLEMENTED, 0];
    }

    // ---------------------------------------------------------------- SVC dispatch
    svc(num) {
      const r = this.cpu.r, mem = this.mem;
      const t = this.running;
      this.svcCounts.set(num, (this.svcCounts.get(num) || 0) + 1);
      switch (num) {
        case 0x01: { const [res, addr] = this.controlMemory(r[0], r[1], r[2], r[3]); r[0] = res; r[1] = addr; return; }
        case 0x02: { // QueryMemory
          const q = mem.query(r[2]);
          r[0] = 0; r[1] = q.base; r[2] = q.size; r[3] = q.perm; r[4] = q.state; r[5] = 0;
          return;
        }
        case 0x03: this.emu.halt('Process exited (svcExitProcess)'); this.cpu.stop = true; return;
        case 0x08: { // CreateThread(prio, entry, arg, stacktop, core)
          const nt = this.createThread(r[1], r[2], r[3], r[0]);
          r[0] = 0; r[1] = this.createHandle(nt);
          if (nt.prio < t.prio) this.cpu.stop = true;
          return;
        }
        case 0x09: this.exitThread(t); return;
        case 0x0A: { // SleepThread
          const ticks = nsToTicks(r[0], r[1]);
          if (ticks <= 0) { r[0] = 0; this.cpu.stop = true; this.starve = 8; return; }
          this.block(t, [], false, this.ticks + ticks, false);
          t.timeoutResult = 0;
          return;
        }
        case 0x0B: { const o = this.getObj(r[1]); r[0] = 0; r[1] = o && o.prio !== undefined ? o.prio : 0x30; return; }
        case 0x0C: { const o = this.getObj(r[0]); if (o && o.prio !== undefined) o.prio = r[1]; r[0] = 0; this.cpu.stop = true; return; }
        case 0x0D: r[0] = 0; r[1] = 0xF; return; // GetThreadAffinityMask
        case 0x0F: r[0] = 0; return;            // SetThreadAffinityMask
        case 0x10: r[0] = 0; r[1] = 0; return;  // GetThreadIdealProcessor
        case 0x11: r[0] = 0; return;            // GetCurrentProcessorNumber
        case 0x13: { // CreateMutex
          const m = new KMutex();
          if (r[1]) m.acquire(t);
          r[0] = 0; r[1] = this.createHandle(m);
          return;
        }
        case 0x14: { // ReleaseMutex
          const m = this.getObj(r[0]);
          if (!(m instanceof KMutex)) { r[0] = RES_INVALID_HANDLE; return; }
          if (m.owner !== t) { r[0] = RES_NOT_OWNER; return; }
          if (--m.count === 0) { m.owner = null; this.signal(m); }
          r[0] = 0;
          return;
        }
        case 0x15: { const s = new KSemaphore(r[1] | 0, r[2] | 0); r[0] = 0; r[1] = this.createHandle(s); return; }
        case 0x16: { // ReleaseSemaphore(out count, handle, release)
          const s = this.getObj(r[1]);
          if (!(s instanceof KSemaphore)) { r[0] = RES_INVALID_HANDLE; return; }
          const old = s.count;
          s.count = Math.min(s.max, s.count + (r[2] | 0));
          this.signal(s);
          r[0] = 0; r[1] = old;
          return;
        }
        case 0x17: { const e = new KEvent(r[1]); r[0] = 0; r[1] = this.createHandle(e); return; }
        case 0x18: {
          const e = this.getObj(r[0]);
          if (!(e instanceof KEvent)) { r[0] = RES_INVALID_HANDLE; return; }
          this.signalEvent(e); r[0] = 0;
          return;
        }
        case 0x19: { const e = this.getObj(r[0]); if (e) e.signaled = false; r[0] = 0; return; }
        case 0x1A: { const tm = new KTimer(r[1]); r[0] = 0; r[1] = this.createHandle(tm); return; }
        case 0x1B: { // SetTimer(handle, initial = r2:r3, interval = r1:r4)
          const tm = this.getObj(r[0]);
          if (!(tm instanceof KTimer)) { r[0] = RES_INVALID_HANDLE; return; }
          const initial = nsToTicks(r[2], r[3]), interval = nsToTicks(r[1], r[4]);
          tm.next = this.ticks + (initial === Infinity ? 0 : initial);
          tm.interval = interval === Infinity ? 0 : interval;
          this.timers.add(tm);
          r[0] = 0;
          return;
        }
        case 0x1C: { const tm = this.getObj(r[0]); if (tm) { tm.next = Infinity; this.timers.delete(tm); } r[0] = 0; return; }
        case 0x1D: { const tm = this.getObj(r[0]); if (tm) tm.signaled = false; r[0] = 0; return; }
        case 0x1E: { // CreateMemoryBlock(otherperm=r0, addr=r1, size=r2, myperm=r3)
          const size = ((r[2] + 0xFFF) & ~0xFFF) >>> 0;
          let pages;
          if (r[1]) pages = mem.getPages(r[1], size);
          else { const buf = new Uint8Array(size); pages = []; for (let i = 0; i < size; i += 0x1000) pages.push(buf.subarray(i, i + 0x1000)); }
          r[0] = 0; r[1] = this.createHandle(new KMemBlock(pages, size));
          return;
        }
        case 0x1F: { // MapMemoryBlock(handle, addr, myperm, otherperm)
          const b = this.getObj(r[0]);
          if (!(b instanceof KMemBlock)) { r[0] = RES_INVALID_HANDLE; return; }
          const addr = r[1] || b.addr;
          if (!addr) { r[0] = 0xE0E01BF5; return; } // invalid address
          mem.mapPages(addr, b.pages, r[2], 6, 'shared');
          r[0] = 0;
          return;
        }
        case 0x20: { const b = this.getObj(r[0]); if (b instanceof KMemBlock && (r[1] || b.addr)) mem.unmap(r[1] || b.addr, b.size); r[0] = 0; return; }
        case 0x21: r[0] = 0; r[1] = this.createHandle(new KGeneric('AddressArbiter')); return;
        case 0x22: this.arbitrate(t, r[1], r[2], r[3] | 0, r[4], r[5]); return;
        case 0x23: this.handles.delete(r[0]); r[0] = 0; return;
        case 0x24: { // WaitSynchronization1(handle, timeout r2:r3)
          const o = this.getObj(r[0]);
          if (!o) { r[0] = RES_INVALID_HANDLE; return; }
          if (!o.shouldWait(t)) { o.acquire(t); r[0] = 0; return; }
          const ticks = nsToTicks(r[2], r[3]);
          if (ticks === 0) { r[0] = RES_TIMEOUT; return; }
          this.block(t, [o], false, this.ticks + ticks, false);
          return;
        }
        case 0x25: { // WaitSynchronizationN(timeout lo r0, handles r1, count r2, waitAll r3, timeout hi r4)
          const count = r[2] | 0, waitAll = r[3] !== 0;
          const objs = [];
          for (let i = 0; i < count; i++) {
            const o = this.getObj(mem.r32((r[1] + i * 4) >>> 0));
            if (!o) { r[0] = RES_INVALID_HANDLE; return; }
            objs.push(o);
          }
          const ticks = nsToTicks(r[0], r[4]);
          if (waitAll) {
            if (objs.every((o) => !o.shouldWait(t))) { objs.forEach((o) => o.acquire(t)); r[0] = 0; r[1] = 0; return; }
          } else {
            for (let i = 0; i < objs.length; i++) {
              if (!objs[i].shouldWait(t)) { objs[i].acquire(t); r[0] = 0; r[1] = i; return; }
            }
          }
          if (ticks === 0) { r[0] = RES_TIMEOUT; return; }
          this.block(t, objs, waitAll, this.ticks + ticks, true);
          return;
        }
        case 0x27: { const o = this.getObj(r[1]); if (!o) { r[0] = RES_INVALID_HANDLE; return; } r[0] = 0; r[1] = this.createHandle(o); return; }
        case 0x28: { const tk = Math.floor(this.ticks); r[0] = tk >>> 0; r[1] = Math.floor(tk / 4294967296) >>> 0; return; }
        case 0x2A: { // GetSystemInfo(type, param)
          let v = 0;
          if (r[1] === 0) v = this.memUsed + this.emu.codeSize;
          else if (r[1] === 26) v = 5; // number of sysmodules
          r[0] = 0; r[1] = v >>> 0; r[2] = 0;
          return;
        }
        case 0x2B: { // GetProcessInfo(process, type)
          let v = 0;
          if (r[2] === 0 || r[2] === 2) v = this.memUsed + this.emu.codeSize;
          else if (r[2] === 20) v = (0x20000000 - this.linearBase) >>> 0; // linear base offset (vaddr -> paddr)
          r[0] = 0; r[1] = v >>> 0; r[2] = r[2] === 20 ? 0xFFFFFFFF : 0;
          return;
        }
        case 0x2D: { // ConnectToPort(name)
          const name = mem.readCString(r[1], 12);
          const svc = this.emu.services.connectPort(name);
          if (!svc) { this.log(`svcConnectToPort: unknown port "${name}"`); r[0] = RES_NOT_FOUND; return; }
          r[0] = 0; r[1] = this.createHandle(new KSession(svc));
          return;
        }
        case 0x32: { // SendSyncRequest
          const s = this.getObj(r[0]);
          if (!(s instanceof KSession)) { r[0] = RES_INVALID_HANDLE; return; }
          this.emu.services.handleRequest(s.service, (t.ctx.tls + 0x80) >>> 0, t);
          r[0] = 0;
          return;
        }
        case 0x35: r[0] = 0; r[1] = 0x28; return; // GetProcessId
        case 0x36: r[0] = 0; r[1] = 0x28; return; // GetProcessIdOfThread
        case 0x37: { const o = this.getObj(r[1]); r[0] = 0; r[1] = o && o.id !== undefined ? o.id : 0; return; }
        case 0x38: r[0] = 0; r[1] = this.createHandle(this.resLimit); return;
        case 0x39: case 0x3A: { // GetResourceLimitLimitValues / CurrentValues(values*, handle, names*, count)
          for (let i = 0; i < (r[3] | 0); i++) {
            const name = mem.r32((r[2] + i * 4) >>> 0);
            let v = 0;
            if (num === 0x39) v = name === 0 ? 0x18 : name === 1 ? 0x04000000 : 0x20;
            else v = name === 1 ? this.memUsed : name === 2 ? this.threads.length : 0;
            mem.w32((r[0] + i * 8) >>> 0, v); mem.w32((r[0] + i * 8 + 4) >>> 0, 0);
          }
          r[0] = 0;
          return;
        }
        case 0x3C: this.emu.halt(`svcBreak(${hex(r[0])}) called by the application`); this.cpu.stop = true; return;
        case 0x3D: { // OutputDebugString
          const s = new TextDecoder().decode(mem.readBytes(r[0], Math.min(r[1], 4096)));
          this.emu.debugOutput(s);
          r[0] = 0;
          return;
        }
        case 0x3E: r[0] = 0; return; // ControlPerformanceCounter
        case 0xFF: r[0] = 0; return;
      }
      this.log(`Unimplemented SVC ${hex(num, 2)} at ${hex(this.cpu.curPC)}`);
      r[0] = RES_NOT_IMPLEMENTED;
    }

    arbitrate(t, addr, type, value, nsLo, nsHi) {
      const r = this.cpu.r, mem = this.mem;
      r[0] = 0;
      switch (type) {
        case 0: { // SIGNAL: wake up to `value` threads (all if negative)
          const ws = this.threads.filter((x) => x.state === 'waiting' && x.waitArb === addr).sort((a, b) => a.prio - b.prio);
          const n = value < 0 ? ws.length : Math.min(value, ws.length);
          for (let i = 0; i < n; i++) this.resume(ws[i], 0);
          return;
        }
        case 1: case 3: // WAIT_IF_LESS_THAN (with optional timeout)
          if ((mem.r32(addr) | 0) < value) this.arbWait(t, addr, type === 3 ? nsToTicks(nsLo, nsHi) : Infinity);
          return;
        case 2: case 4: { // DECREMENT_AND_WAIT_IF_LESS_THAN
          const v = mem.r32(addr) | 0;
          if (v < value) { mem.w32(addr, v - 1); this.arbWait(t, addr, type === 4 ? nsToTicks(nsLo, nsHi) : Infinity); }
          return;
        }
      }
      r[0] = RES_NOT_IMPLEMENTED;
    }

    arbWait(t, addr, ticks) {
      this.block(t, [], false, this.ticks + ticks, false);
      t.waitArb = addr;
    }
  }

  EMU.Kernel = Kernel;
})(typeof window !== 'undefined' ? window.EMU : globalThis.EMU);

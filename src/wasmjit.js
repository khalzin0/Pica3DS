// WebAssembly CPU: hot ARM blocks are translated a second time, into WebAssembly. The console's RAM lives in one
// WebAssembly memory (the arena) with a page table the generated code reads directly, and the ARM registers are
// kept in WebAssembly locals while a block runs, so the hot paths need no JavaScript calls at all.
//
// Tiers: interpreter -> JavaScript block (cpu.js) -> WebAssembly block (here), once the JavaScript block has
// stayed hot. Blocks are compiled in batches into one module. A WebAssembly block covers the instructions it can
// translate and hands back to the dispatcher at the first one it cannot (that one then runs as before).
(function (EMU) {
  'use strict';

  // Arena layout
  const STATE = 0x1000;    // i32: n, z, c, v, pc, curPC
  const REGS = 0x1100;     // r0-r15 (the CPU's own register array is a view of this)
  const PTAB = 0x10000;    // page table: virtual page -> arena offset of its 4 KB, or 0 (not in the arena)
  const DATA = 0x410000;   // allocations start here
  const PAGE = 0x1000;

  // ------------------------------------------------------------------ arena (the console's RAM)
  class Arena {
    // size: bytes (whole 64 KB WebAssembly pages)
    static newMemory(size) {
      const pages = Math.ceil(size / 65536);
      return new WebAssembly.Memory({ initial: pages, maximum: pages });
    }

    // The largest arena this device allows, or null (then RAM is ordinary arrays and the WebAssembly CPU is off)
    static create() {
      if (typeof WebAssembly === 'undefined') return null;
      for (const mb of [320, 224, 160]) {
        try { return new Arena(Arena.newMemory(mb * 0x100000)); } catch (e) { /* too large here: try smaller */ }
      }
      return null;
    }

    constructor(wmem) {
      this.size = wmem.buffer.byteLength;
      this.free = [[DATA, this.size - DATA]]; // [offset, bytes] runs, sorted
      this.top = DATA;                         // end of the highest allocation (save states store up to here)
      this.attach(wmem);
    }

    attach(wmem) { this.wmem = wmem; this.buffer = wmem.buffer; this.u8 = new Uint8Array(wmem.buffer); }

    // Zeroed bytes, or null when full
    alloc(size) {
      const len = Math.ceil(size / PAGE) * PAGE;
      for (let i = 0; i < this.free.length; i++) {
        const run = this.free[i];
        if (run[1] < len) continue;
        const off = run[0];
        if (run[1] === len) this.free.splice(i, 1); else { run[0] += len; run[1] -= len; }
        this.u8.fill(0, off, off + len);
        this.top = Math.max(this.top, off + len);
        return new Uint8Array(this.buffer, off, size);
      }
      return null;
    }

    release(off, len) {
      const f = this.free;
      let i = 0;
      while (i < f.length && f[i][0] < off) i++;
      f.splice(i, 0, [off, len]);
      if (i + 1 < f.length && off + len === f[i + 1][0]) { f[i][1] += f[i + 1][1]; f.splice(i + 1, 1); }
      if (i > 0 && f[i - 1][0] + f[i - 1][1] === off) { f[i - 1][1] += f[i][1]; f.splice(i, 1); }
    }
  }

  // ------------------------------------------------------------------ WebAssembly encoding
  const OP = {
    unreachable: 0x00, block: 0x02, loop: 0x03, if: 0x04, else: 0x05, end: 0x0B, br: 0x0C, br_if: 0x0D, return: 0x0F,
    call: 0x10, drop: 0x1A, get: 0x20, set: 0x21, tee: 0x22,
    load: 0x28, load8s: 0x2C, load8u: 0x2D, load16s: 0x2E, load16u: 0x2F, store: 0x36, store8: 0x3A, store16: 0x3B,
    const: 0x41, eqz: 0x45, eq: 0x46, ne: 0x47, lt_s: 0x48, lt_u: 0x49, gt_u: 0x4B, le_s: 0x4C, le_u: 0x4D, ge_u: 0x4F,
    i64ge_s: 0x59, add: 0x6A, sub: 0x6B, mul: 0x6C, and: 0x71, or: 0x72, xor: 0x73, shl: 0x74, shr_s: 0x75, shr_u: 0x76,
    rotr: 0x78, i64add: 0x7C, i64sub: 0x7D, i64shr_u: 0x88, wrap: 0xA7, extend_u: 0xAD, ext8s: 0xC0, ext16s: 0xC1,
  };
  const uleb = (out, v) => { v >>>= 0; do { let b = v & 0x7F; v >>>= 7; if (v) b |= 0x80; out.push(b); } while (v); };
  const sleb = (out, v) => {
    v |= 0;
    for (;;) {
      const b = v & 0x7F; v >>= 7;
      if ((v === 0 && !(b & 0x40)) || (v === -1 && (b & 0x40))) { out.push(b); return; }
      out.push(b | 0x80);
    }
  };
  const str = (out, s) => { uleb(out, s.length); for (let i = 0; i < s.length; i++) out.push(s.charCodeAt(i)); };
  const section = (out, id, body) => { out.push(id); uleb(out, body.length); for (const b of body) out.push(b); };

  // Locals: 0 = budget; 1-15 = r0-r14; then flags and scratch; last an i64
  const L_R = 1, L_N = 16, L_Z = 17, L_C = 18, L_V = 19, L_DONE = 20, L_A = 21, L_B = 22, L_RES = 23, L_ADDR = 24;
  const L_P = 25, L_X = 26, L_SC = 27, L_BASE = 28, L_T = 29, L_W = 30;
  const I32_LOCALS = 29;

  // Imported slow paths (pages outside the arena, page-crossing accesses, faults): r8 r16 r32 (addr, pc) -> value;
  // w8 w16 w32 (addr, value, pc)
  const F_R8 = 0, F_R16 = 1, F_R32 = 2, F_W8 = 3, F_W16 = 4, F_W32 = 5, IMPORTS = 6;

  const rorConst = (v, n) => ((n &= 31) === 0 ? v >>> 0 : ((v >>> n) | (v << (32 - n))) >>> 0);
  const popcount16 = (x) => { let n = 0; for (; x; x &= x - 1) n++; return n; };

  // One block's function body
  // regs: registers to write back at exits (a bit mask; null while the first pass finds out which are used)
  class Body {
    constructor(regs = null) { this.c = []; this.depth = 0; this.regs = regs; this.read = 0; this.written = 0; }
    op(...bs) { for (const b of bs) this.c.push(b); return this; }
    get(l) { if (l >= L_R && l < L_R + 15) this.read |= 1 << (l - L_R); this.c.push(OP.get); uleb(this.c, l); return this; }
    set(l) { if (l >= L_R && l < L_R + 15) this.written |= 1 << (l - L_R); this.c.push(OP.set); uleb(this.c, l); return this; }
    tee(l) { if (l >= L_R && l < L_R + 15) this.written |= 1 << (l - L_R); this.c.push(OP.tee); uleb(this.c, l); return this; }
    i32(v) { this.c.push(OP.const); sleb(this.c, v | 0); return this; }
    mem(op, offset = 0) { this.c.push(op, 0); uleb(this.c, offset); return this; } // alignment hint 1 byte
    call(f) { this.c.push(OP.call); uleb(this.c, f); return this; }
    open(kind, type = 0x40) { this.c.push(kind, type); this.depth++; return this; }
    else() { this.c.push(OP.else); return this; }
    end() { this.c.push(OP.end); this.depth--; return this; }
  }

  // ------------------------------------------------------------------ block compiler
  // Returns the body bytes, or null when the block's first instruction cannot be translated
  function compileBlock(cpu, start) {
    const mem = cpu.mem, idx = start >>> 12, pageOff = mem.ptab[idx], page = mem.pages32[idx];
    if (!pageOff || page === null || (start & 3)) return null;
    const f = new Body();
    const words = [];
    let pc = start;
    // Which instructions this block covers (decided first: the entry check compares exactly these words)
    while (words.length < 96 && (pc >>> 12) === idx) {
      const insn = page[(pc & 0xFFF) >>> 2] | 0;
      const kind = classify(insn, pc);
      if (!kind) break;
      words.push(insn);
      pc = (pc + 4) >>> 0;
      if (kind === 'branch') break;
    }
    const N = words.length;
    if (!N) return null;
    const instrs = (g) => {
      g.open(OP.loop);
      let ended = false;
      for (let k = 0; k < N && !ended; k++) ended = emit(g, words[k], (start + k * 4) >>> 0, k, N, start, 0);
      if (!ended) exit(g, pc, (pc - 4) >>> 0, N); // ran off the end (or reached an untranslated instruction)
      g.end();
      g.op(OP.unreachable);
    };
    // First pass: which registers the block reads and writes. Only those are loaded into locals (written ones
    // too: a write may be skipped by its condition) and only the written ones are stored back at exits.
    const probe = new Body(0x7FFF);
    instrs(probe);
    const written = probe.written, live = probe.read | written;
    const g = new Body(written);
    instrs(g);

    // Entry: the code page must still be mapped where it was, holding the same words
    f.i32(0).mem(OP.load, PTAB + idx * 4).i32(pageOff).op(OP.ne);
    for (let i = 0; i < N; i++) {
      f.i32(0).mem(OP.load, pageOff + ((start & 0xFFF) + i * 4)).i32(words[i]).op(OP.ne, OP.or);
    }
    f.open(OP.if).i32(-1).op(OP.return).end();
    // Registers and flags into locals
    for (let i = 0; i < 15; i++) if (live & (1 << i)) f.i32(0).mem(OP.load, REGS + i * 4).set(L_R + i);
    for (let i = 0; i < 4; i++) f.i32(0).mem(OP.load, STATE + i * 4).set(L_N + i);
    for (const b of g.c) f.c.push(b);
    return f.c;
  }

  // Write registers, flags, PC back and return the instruction count (done + k)
  function exit(f, pcValue, curPC, k) {
    for (let i = 0; i < 15; i++) {
      if (!(f.regs & (1 << i))) continue;
      f.i32(0).op(OP.get); uleb(f.c, L_R + i); f.mem(OP.store, REGS + i * 4); // (not counted as a read)
    }
    f.i32(0).i32((curPC + 8) | 0).mem(OP.store, REGS + 15 * 4);
    for (let i = 0; i < 4; i++) f.i32(0).get(L_N + i).mem(OP.store, STATE + i * 4);
    f.i32(0).i32(pcValue | 0).mem(OP.store, STATE + 16);
    f.i32(0).i32(curPC | 0).mem(OP.store, STATE + 20);
    f.get(L_DONE).i32(k).op(OP.add, OP.return);
  }

  // Can this instruction be translated? 'op', 'branch' or null. Mirrors what emit handles.
  function classify(insn, PC) {
    const cond = insn >>> 28, op3 = (insn >>> 25) & 7;
    if (cond === 15) {
      if ((insn & 0x0E000000) === 0x0A000000) return null; // BLX immediate
      return (insn >>> 0) === 0xF57FF01F ? null : 'op';      // CLREX left to the interpreter; hints are no-ops
    }
    const rn = (insn >>> 16) & 15, rd = (insn >>> 12) & 15;
    if (op3 === 5) return 'branch';
    const isDP = (op3 === 0 && (insn & 0x90) !== 0x90 && (insn & 0x01900000) !== 0x01000000 && !(insn & 0x10)) ||
      (op3 === 1 && (insn & 0x01900000) !== 0x01000000);
    if (isDP) return rd === 15 ? null : 'op';
    if (op3 === 2 || (op3 === 3 && !(insn & 0x10))) {
      const L = insn & 0x00100000, wb = !(insn & 0x01000000) || (insn & 0x00200000);
      return (L && rd === 15) || (wb && rn === 15) ? null : 'op';
    }
    if (op3 === 0 && (insn & 0x90) === 0x90) {
      if ((insn & 0x60) !== 0) {
        const L = insn & 0x00100000, sh = (insn >>> 5) & 3, wb = !(insn & 0x01000000) || (insn & 0x00200000);
        return (!L && sh !== 1) || (L && rd === 15) || (wb && rn === 15) ? null : 'op';
      }
      if ((insn & 0x0FC000F0) === 0x00000090) return ((insn >>> 16) & 15) === 15 ? null : 'op';
      return null;
    }
    if (op3 === 3 && (insn & 0x10) && ((insn >>> 5) & 7) === 3) {
      const op1 = (insn >>> 20) & 0x1F;
      return op1 === 10 || op1 === 11 || op1 === 14 || op1 === 15 ? 'op' : null;
    }
    if (op3 === 4) {
      const L = insn & 0x00100000, list = insn & 0xFFFF;
      return rn === 15 || !list || (L && (list & 0x8000)) ? null : 'op';
    }
    return null;
  }

  // Condition as an i32 0/1 on the stack
  function cond(f, c) {
    switch (c) {
      case 0: f.get(L_Z); break;
      case 1: f.get(L_Z).op(OP.eqz); break;
      case 2: f.get(L_C); break;
      case 3: f.get(L_C).op(OP.eqz); break;
      case 4: f.get(L_N); break;
      case 5: f.get(L_N).op(OP.eqz); break;
      case 6: f.get(L_V); break;
      case 7: f.get(L_V).op(OP.eqz); break;
      case 8: f.get(L_C).get(L_Z).op(OP.eqz, OP.and); break;
      case 9: f.get(L_C).op(OP.eqz).get(L_Z).op(OP.or); break;
      case 10: f.get(L_N).get(L_V).op(OP.eq); break;
      case 11: f.get(L_N).get(L_V).op(OP.ne); break;
      case 12: f.get(L_Z).op(OP.eqz).get(L_N).get(L_V).op(OP.eq, OP.and); break;
      default: f.get(L_Z).get(L_N).get(L_V).op(OP.ne, OP.or); break;
    }
  }

  // Register value on the stack (r15 reads as PC + 8)
  const reg = (f, k, PC) => (k === 15 ? f.i32((PC + 8) | 0) : f.get(L_R + k));

  // Memory access at the address in L_ADDR. Loads leave the value on the stack; stores take it from L_T.
  // width: 1, 2, 4; signed: sign-extend loads
  function load(f, width, signed, PC) {
    f.get(L_ADDR).i32(12).op(OP.shr_u).i32(2).op(OP.shl).mem(OP.load, PTAB).tee(L_P).op(OP.eqz, OP.eqz);
    if (width > 1) f.get(L_ADDR).i32(0xFFF).op(OP.and).i32(PAGE - width).op(OP.le_u, OP.and);
    f.open(OP.if, 0x7F);
    f.get(L_P).get(L_ADDR).i32(0xFFF).op(OP.and, OP.add);
    f.mem(width === 4 ? OP.load : width === 2 ? (signed ? OP.load16s : OP.load16u) : (signed ? OP.load8s : OP.load8u));
    f.else();
    f.get(L_ADDR).i32(PC).call(width === 4 ? F_R32 : width === 2 ? F_R16 : F_R8);
    if (signed) f.op(width === 2 ? OP.ext16s : OP.ext8s);
    f.end();
  }
  function store(f, width, PC) {
    f.get(L_ADDR).i32(12).op(OP.shr_u).i32(2).op(OP.shl).mem(OP.load, PTAB).tee(L_P).op(OP.eqz, OP.eqz);
    if (width > 1) f.get(L_ADDR).i32(0xFFF).op(OP.and).i32(PAGE - width).op(OP.le_u, OP.and);
    f.open(OP.if);
    f.get(L_P).get(L_ADDR).i32(0xFFF).op(OP.and, OP.add).get(L_T);
    f.mem(width === 4 ? OP.store : width === 2 ? OP.store16 : OP.store8);
    f.else();
    f.get(L_ADDR).get(L_T);
    if (width === 2) f.i32(0xFFFF).op(OP.and); else if (width === 1) f.i32(0xFF).op(OP.and);
    f.i32(PC).call(width === 4 ? F_W32 : width === 2 ? F_W16 : F_W8);
    f.end();
  }

  // n and z from the value in L_RES
  const nz = (f) => { f.get(L_RES).i32(31).op(OP.shr_u).set(L_N); f.get(L_RES).op(OP.eqz).set(L_Z); };

  // One instruction. Returns true when it ended the block (a branch: every path returned).
  function emit(f, insn, PC, k, N, start, loopDepth) {
    const c = insn >>> 28, op3 = (insn >>> 25) & 7;
    if (c === 15) return false; // hint / barrier: nothing to do
    const rn = (insn >>> 16) & 15, rd = (insn >>> 12) & 15, rm = insn & 15;

    if (op3 === 5) { // B / BL: always the last instruction
      const target = (PC + 8 + ((insn << 8) >> 6)) >>> 0, link = insn & 0x01000000;
      const taken = () => {
        if (link) f.i32((PC + 4) | 0).set(L_R + 14);
        if (target === start && !link) { // loop back to this block's start while the budget allows
          f.get(L_DONE).i32(N).op(OP.add).set(L_DONE);
          f.get(L_DONE).i32(N).op(OP.add).get(0).op(OP.le_s);
          f.op(OP.br_if); uleb(f.c, f.depth - loopDepth - 1); // to the loop around the block's instructions
          exit(f, target, PC, 0);
        } else exit(f, target, PC, N);
      };
      if (c === 14) taken();
      else {
        cond(f, c); f.open(OP.if); taken(); f.else(); exit(f, (PC + 4) >>> 0, PC, N); f.end();
        f.op(OP.unreachable);
      }
      return true;
    }

    if (c < 14) { cond(f, c); f.open(OP.if); }
    body(f, insn, PC, op3, rn, rd, rm);
    if (c < 14) f.end();
    return false;
  }

  function body(f, insn, PC, op3, rn, rd, rm) {
    // ---- data processing (immediate, register, register shifted by immediate)
    const isDP = (op3 === 0 && (insn & 0x90) !== 0x90 && (insn & 0x01900000) !== 0x01000000 && !(insn & 0x10)) ||
      (op3 === 1 && (insn & 0x01900000) !== 0x01000000);
    if (isDP) {
      const op = (insn >>> 21) & 15, S = (insn & 0x00100000) !== 0;
      const needSc = S && (op < 2 || op >= 12 || op === 8 || op === 9);
      // operand 2 -> L_B, shifter carry -> L_SC (read before any flag changes)
      if (insn & 0x02000000) {
        const rot = ((insn >>> 8) & 15) * 2, v = rorConst(insn & 0xFF, rot);
        f.i32(v).set(L_B);
        if (needSc) { if (rot === 0) f.get(L_C).set(L_SC); else f.i32(v >>> 31).set(L_SC); }
      } else if ((insn & 0xFF0) === 0) {
        reg(f, rm, PC).set(L_B);
        if (needSc) f.get(L_C).set(L_SC);
      } else {
        const type = (insn >>> 5) & 3, amt = (insn >>> 7) & 31;
        reg(f, rm, PC).set(L_X);
        switch (type) {
          case 0:
            f.get(L_X); if (amt) f.i32(amt).op(OP.shl); f.set(L_B);
            if (needSc) { if (amt) f.get(L_X).i32(32 - amt).op(OP.shr_u).i32(1).op(OP.and); else f.get(L_C); f.set(L_SC); }
            break;
          case 1:
            if (amt) f.get(L_X).i32(amt).op(OP.shr_u); else f.i32(0); f.set(L_B);
            if (needSc) { if (amt) f.get(L_X).i32(amt - 1).op(OP.shr_u).i32(1).op(OP.and); else f.get(L_X).i32(31).op(OP.shr_u); f.set(L_SC); }
            break;
          case 2:
            f.get(L_X).i32(amt || 31).op(OP.shr_s).set(L_B);
            if (needSc) { if (amt) f.get(L_X).i32(amt - 1).op(OP.shr_u).i32(1).op(OP.and); else f.get(L_X).i32(31).op(OP.shr_u); f.set(L_SC); }
            break;
          default:
            if (amt) f.get(L_X).i32(amt).op(OP.rotr); else f.get(L_C).i32(31).op(OP.shl).get(L_X).i32(1).op(OP.shr_u, OP.or);
            f.set(L_B);
            if (needSc) { if (amt) f.get(L_X).i32(amt - 1).op(OP.shr_u).i32(1).op(OP.and); else f.get(L_X).i32(1).op(OP.and); f.set(L_SC); }
        }
      }
      reg(f, rn, PC).set(L_A);
      const logic = () => { nz(f); f.get(L_SC).set(L_C); };
      // a op b with carry-in through 64-bit arithmetic: result -> L_RES, carry -> L_C (add: sum >> 32; sub: >= 0)
      const add64 = (x, y, carry) => {
        f.get(x).op(OP.extend_u).get(y).op(OP.extend_u).op(OP.i64add);
        if (carry) f.get(L_C).op(OP.extend_u).op(OP.i64add);
        f.tee(L_W).op(OP.wrap).set(L_RES);
        f.get(L_W).op(0x42, 32).op(OP.i64shr_u, OP.wrap).set(L_C); // i64.const 32
      };
      const sub64 = (x, y) => { // x - y - (1 - c)
        f.get(x).op(OP.extend_u).get(y).op(OP.extend_u).op(OP.i64sub);
        f.i32(1).get(L_C).op(OP.sub, OP.extend_u).op(OP.i64sub);
        f.tee(L_W).op(OP.wrap).set(L_RES);
        f.get(L_W).op(0x42, 0).op(OP.i64ge_s).set(L_C); // i64.const 0
      };
      const vAdd = (x, y) => { f.get(x).get(L_RES).op(OP.xor).get(y).get(L_RES).op(OP.xor, OP.and).i32(31).op(OP.shr_u).set(L_V); };
      const vSub = (x, y) => { f.get(x).get(y).op(OP.xor).get(x).get(L_RES).op(OP.xor, OP.and).i32(31).op(OP.shr_u).set(L_V); };
      const subF = (x, y) => { // res = x - y; c = x >= y (unsigned)
        f.get(x).get(y).op(OP.sub).set(L_RES);
        vSub(x, y); f.get(x).get(y).op(OP.ge_u).set(L_C); nz(f);
      };
      const addF = (x, y) => {
        f.get(x).get(y).op(OP.add).set(L_RES);
        vAdd(x, y); f.get(L_RES).get(x).op(OP.lt_u).set(L_C); nz(f);
      };
      switch (op) {
        case 0: f.get(L_A).get(L_B).op(OP.and).set(L_RES); if (S) logic(); break;
        case 1: f.get(L_A).get(L_B).op(OP.xor).set(L_RES); if (S) logic(); break;
        case 2: if (S) subF(L_A, L_B); else f.get(L_A).get(L_B).op(OP.sub).set(L_RES); break;
        case 3: if (S) subF(L_B, L_A); else f.get(L_B).get(L_A).op(OP.sub).set(L_RES); break;
        case 4: if (S) addF(L_A, L_B); else f.get(L_A).get(L_B).op(OP.add).set(L_RES); break;
        case 5:
          if (S) { add64(L_A, L_B, true); vAdd(L_A, L_B); nz(f); } else f.get(L_A).get(L_B).op(OP.add).get(L_C).op(OP.add).set(L_RES);
          break;
        case 6:
          if (S) { sub64(L_A, L_B); vSub(L_A, L_B); nz(f); } else f.get(L_A).get(L_B).op(OP.sub).i32(1).get(L_C).op(OP.sub, OP.sub).set(L_RES);
          break;
        case 7:
          if (S) { sub64(L_B, L_A); vSub(L_B, L_A); nz(f); } else f.get(L_B).get(L_A).op(OP.sub).i32(1).get(L_C).op(OP.sub, OP.sub).set(L_RES);
          break;
        case 8: f.get(L_A).get(L_B).op(OP.and).set(L_RES); logic(); return;
        case 9: f.get(L_A).get(L_B).op(OP.xor).set(L_RES); logic(); return;
        case 10: subF(L_A, L_B); return;
        case 11: addF(L_A, L_B); return;
        case 12: f.get(L_A).get(L_B).op(OP.or).set(L_RES); if (S) logic(); break;
        case 13: f.get(L_B).set(L_RES); if (S) logic(); break;
        case 14: f.get(L_A).get(L_B).i32(-1).op(OP.xor, OP.and).set(L_RES); if (S) logic(); break;
        default: f.get(L_B).i32(-1).op(OP.xor).set(L_RES); if (S) logic();
      }
      f.get(L_RES).set(L_R + rd);
      return;
    }

    // ---- LDR / STR / LDRB / STRB
    if (op3 === 2 || (op3 === 3 && !(insn & 0x10))) {
      const L = insn & 0x00100000, P = insn & 0x01000000, U = insn & 0x00800000, B = insn & 0x00400000;
      const wb = !P || (insn & 0x00200000);
      reg(f, rn, PC).set(L_BASE);
      f.get(L_BASE);
      if (op3 === 2) f.i32(insn & 0xFFF);
      else {
        const type = (insn >>> 5) & 3, amt = (insn >>> 7) & 31;
        reg(f, rm, PC).set(L_X);
        switch (type) {
          case 0: f.get(L_X); if (amt) f.i32(amt).op(OP.shl); break;
          case 1: if (amt) f.get(L_X).i32(amt).op(OP.shr_u); else f.i32(0); break;
          case 2: f.get(L_X).i32(amt || 31).op(OP.shr_s); break;
          default: if (amt) f.get(L_X).i32(amt).op(OP.rotr); else f.get(L_C).i32(31).op(OP.shl).get(L_X).i32(1).op(OP.shr_u, OP.or);
        }
      }
      f.op(U ? OP.add : OP.sub).set(L_A); // offset address
      f.get(P ? L_A : L_BASE).set(L_ADDR);
      if (L) {
        load(f, B ? 1 : 4, false, PC); f.set(L_RES);
        if (wb) f.get(L_A).set(L_R + rn);
        f.get(L_RES).set(L_R + rd);
      } else {
        reg(f, rd, PC).set(L_T);
        store(f, B ? 1 : 4, PC);
        if (wb) f.get(L_A).set(L_R + rn);
      }
      return;
    }

    if (op3 === 0 && (insn & 0x90) === 0x90) {
      // ---- LDRH / STRH / LDRSB / LDRSH
      if ((insn & 0x60) !== 0) {
        const L = insn & 0x00100000, P = insn & 0x01000000, U = insn & 0x00800000, sh = (insn >>> 5) & 3;
        const wb = !P || (insn & 0x00200000);
        reg(f, rn, PC).set(L_BASE);
        f.get(L_BASE);
        if (insn & 0x00400000) f.i32(((insn >>> 4) & 0xF0) | (insn & 0xF)); else reg(f, rm, PC);
        f.op(U ? OP.add : OP.sub).set(L_A);
        f.get(P ? L_A : L_BASE).set(L_ADDR);
        if (L) {
          if (sh === 1) load(f, 2, false, PC); else if (sh === 2) load(f, 1, true, PC); else load(f, 2, true, PC);
          f.set(L_RES);
          if (wb) f.get(L_A).set(L_R + rn);
          f.get(L_RES).set(L_R + rd);
        } else {
          reg(f, rd, PC).set(L_T);
          store(f, 2, PC);
          if (wb) f.get(L_A).set(L_R + rn);
        }
        return;
      }
      // ---- MUL / MLA
      const mrd = (insn >>> 16) & 15, mrn = (insn >>> 12) & 15, rs = (insn >>> 8) & 15;
      reg(f, rm, PC); reg(f, rs, PC); f.op(OP.mul);
      if (insn & 0x00200000) { reg(f, mrn, PC); f.op(OP.add); }
      f.tee(L_RES).set(L_R + mrd);
      if (insn & 0x00100000) nz(f);
      return;
    }

    // ---- SXTB / SXTH / UXTB / UXTH (and the add forms)
    if (op3 === 3) {
      const op1 = (insn >>> 20) & 0x1F, rot = ((insn >>> 10) & 3) * 8;
      reg(f, rm, PC); if (rot) f.i32(rot).op(OP.rotr);
      if (op1 === 10) f.op(OP.ext8s); else if (op1 === 11) f.op(OP.ext16s); else f.i32(op1 === 14 ? 0xFF : 0xFFFF).op(OP.and);
      if (rn !== 15) { reg(f, rn, PC); f.op(OP.add); }
      f.set(L_R + rd);
      return;
    }

    // ---- LDM / STM (no PC in a load list)
    const L = insn & 0x00100000, list = insn & 0xFFFF;
    const U = insn & 0x00800000, P = insn & 0x01000000, W = insn & 0x00200000;
    const cnt = popcount16(list);
    let off = U ? (P ? 4 : 0) : (P ? -cnt * 4 : -cnt * 4 + 4);
    const newBase = U ? cnt * 4 : -cnt * 4;
    f.get(L_R + rn).set(L_BASE);
    if (L && W) f.get(L_BASE).i32(newBase).op(OP.add).set(L_R + rn);
    for (let i = 0; i < 16; i++) {
      if (!(list & (1 << i))) continue;
      f.get(L_BASE).i32(off).op(OP.add).set(L_ADDR);
      if (L) { load(f, 4, false, PC); f.set(L_R + i); }
      else { reg(f, i, PC).set(L_T); store(f, 4, PC); }
      off += 4;
    }
    if (!L && W) f.get(L_BASE).i32(newBase).op(OP.add).set(L_R + rn);
  }

  // ------------------------------------------------------------------ modules
  function buildModule(bodies, memPages) {
    const out = [0x00, 0x61, 0x73, 0x6D, 0x01, 0x00, 0x00, 0x00];
    const I = 0x7F, V64 = 0x7E;
    // Types: 0 = (i32) -> i32 block; 1 = (i32 i32) -> i32 read; 2 = (i32 i32 i32) -> () write
    section(out, 1, [3, 0x60, 1, I, 1, I, 0x60, 2, I, I, 1, I, 0x60, 3, I, I, I, 0]);
    const imp = [];
    uleb(imp, IMPORTS + 1);
    for (const [name, type] of [['r8', 1], ['r16', 1], ['r32', 1], ['w8', 2], ['w16', 2], ['w32', 2]]) { str(imp, 'env'); str(imp, name); imp.push(0); uleb(imp, type); }
    str(imp, 'env'); str(imp, 'mem'); imp.push(2, 1); uleb(imp, memPages); uleb(imp, memPages);
    section(out, 2, imp);
    const fns = []; uleb(fns, bodies.length); for (let i = 0; i < bodies.length; i++) fns.push(0);
    section(out, 3, fns);
    const exp = []; uleb(exp, bodies.length);
    for (let i = 0; i < bodies.length; i++) { str(exp, 'b' + i); exp.push(0); uleb(exp, IMPORTS + i); }
    section(out, 7, exp);
    const code = []; uleb(code, bodies.length);
    for (const b of bodies) {
      const fb = [2]; // local groups
      uleb(fb, I32_LOCALS); fb.push(I);
      fb.push(1, V64);
      for (const x of b) fb.push(x);
      fb.push(OP.end);
      uleb(code, fb.length);
      for (const x of fb) code.push(x);
    }
    section(out, 10, code);
    return new Uint8Array(out);
  }

  // Compile the queued blocks (JavaScript blocks that stayed hot) into one module and attach them
  function compileQueued(cpu) {
    const queue = cpu.wasmQueue;
    if (!queue.length) return;
    cpu.wasmQueue = [];
    const arena = cpu.mem.arena;
    const bodies = [], owners = [];
    for (const b of queue) {
      let body = null;
      try { body = compileBlock(cpu, b.start); } catch (e) { body = null; }
      if (body) { bodies.push(body); owners.push(b); }
    }
    if (!bodies.length) return;
    let inst;
    try {
      const mod = new WebAssembly.Module(buildModule(bodies, arena.wmem.buffer.byteLength / 65536));
      const mem = cpu.mem;
      const at = (pc) => { cpu.curPC = pc >>> 0; };
      inst = new WebAssembly.Instance(mod, { env: {
        mem: arena.wmem,
        r8: (a, pc) => { at(pc); return mem.r8(a >>> 0); },
        r16: (a, pc) => { at(pc); return mem.r16(a >>> 0); },
        r32: (a, pc) => { at(pc); return mem.r32(a >>> 0); },
        w8: (a, v, pc) => { at(pc); mem.w8(a >>> 0, v & 0xFF); },
        w16: (a, v, pc) => { at(pc); mem.w16(a >>> 0, v & 0xFFFF); },
        w32: (a, v, pc) => { at(pc); mem.w32(a >>> 0, v >>> 0); },
      } });
    } catch (e) {
      cpu.wasmErrors = (cpu.wasmErrors || 0) + 1;
      if (cpu.wasmErrors === 1 && typeof console !== 'undefined') console.warn('WebAssembly CPU: compile failed', e);
      return;
    }
    owners.forEach((b, i) => { b.w = inst.exports['b' + i]; });
    cpu.wasmBlocks += owners.length;
  }

  EMU.Arena = Arena;
  EMU.WASM_STATE = STATE; EMU.WASM_REGS = REGS; EMU.WASM_PTAB = PTAB;
  EMU.wasmCompileQueued = compileQueued;
  EMU.wasmCompileBlock = compileBlock; // for tests
  EMU.wasmBuildModule = buildModule;
  Object.assign(EMU.classes || (EMU.classes = {}), { Arena });
})(typeof window !== 'undefined' ? (window.EMU = window.EMU || {}) : (globalThis.EMU = globalThis.EMU || {}));

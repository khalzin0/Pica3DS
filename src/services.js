// High-level emulation of 3DS system services reached through IPC (svcSendSyncRequest).
(function (EMU) {
  'use strict';

  const hex = EMU.hex;
  const ERR_NOT_FOUND = 0xC8804478;

  class Ipc {
    constructor(mem, addr) { this.mem = mem; this.addr = addr; }
    get(i) { return this.mem.r32((this.addr + i * 4) >>> 0); }
    set(i, v) { this.mem.w32((this.addr + i * 4) >>> 0, v >>> 0); }
    // normal[0] is the result code
    reply(id, normal, translate = []) {
      this.set(0, (id << 16) | (normal.length << 6) | translate.length);
      let i = 1;
      for (const v of normal) this.set(i++, v);
      for (const v of translate) this.set(i++, v);
    }
  }

  class Service {
    constructor(emu, name) { this.emu = emu; this.name = name; }
    get kernel() { return this.emu.kernel; }
    get mem() { return this.emu.mem; }
    handle() { return false; }
  }

  // ------------------------------------------------------------------ srv:
  class SrvService extends Service {
    handle(ipc, id) {
      switch (id) {
        case 0x1: ipc.reply(id, [0]); return true; // RegisterClient
        case 0x2: { // EnableNotification
          const sem = this.kernel.createHandle(new EMU.KEvent(1));
          ipc.reply(id, [0], [0, sem]);
          return true;
        }
        case 0x5: { // GetServiceHandle(name[8], length, flags)
          const len = Math.min(ipc.get(3), 8);
          let name = '';
          for (let i = 0; i < len; i++) name += String.fromCharCode(this.mem.r8((ipc.addr + 4 + i) >>> 0));
          const svc = this.emu.services.getService(name);
          const h = this.kernel.createHandle(new EMU.KSession(svc));
          ipc.reply(id, [0], [0x10, h]);
          return true;
        }
        case 0x9: case 0xA: ipc.reply(id, [0]); return true;
        case 0xB: ipc.reply(id, [0, 0]); return true;
        case 0xE: ipc.reply(id, [0, 1]); return true;
      }
      return false;
    }
  }

  // ------------------------------------------------------------------ err:f
  class ErrFService extends Service {
    handle(ipc, id) {
      if (id === 1) {
        const type = ipc.get(1) & 0xFF, code = ipc.get(2), pc = ipc.get(3);
        this.emu.halt(`Fatal error reported by app (err:f type ${type}, result ${hex(code)}, pc ${hex(pc)})`);
        this.kernel.cpu.stop = true;
        ipc.reply(id, [0]);
        return true;
      }
      return false;
    }
  }

  // ------------------------------------------------------------------ APT
  class AptService extends Service {
    constructor(emu, name) {
      super(emu, name);
      this.lock = new EMU.KMutex();
      this.notifEvent = new EMU.KEvent(0, 'APT notification');
      this.paramEvent = new EMU.KEvent(0, 'APT parameter');
      this.params = [];   // queued parameters for the application: { sender, signal, buffer, object }
      this.appletNames = { 0x201: 'software keyboard', 0x401: 'software keyboard', 0x202: 'Mii selector', 0x402: 'Mii selector', 0x206: 'error/EULA display', 0x406: 'error/EULA display' };
    }

    // Deliver a parameter (APT message) to the application.
    sendToApp(param) {
      this.params.push(param);
      this.kernel.signal(this.paramEvent);
    }

    // Library applets are not run; each one answers like an applet that closes straight away.
    appletRequest(applet, signal, buffer) {
      if (signal === 2) { // Request: reply with a capture buffer for the applet's screenshot
        const size = buffer.length >= 4 ? new DataView(buffer.buffer, buffer.byteOffset).getUint32(0, true) : 0;
        const pages = [];
        const mem = new Uint8Array(Math.max(0x1000, (size + 0xFFF) & ~0xFFF));
        for (let o = 0; o < mem.length; o += 0x1000) pages.push(mem.subarray(o, o + 0x1000));
        this.sendToApp({ sender: applet, signal: 3, buffer: new Uint8Array(0), object: new EMU.KMemBlock(pages, mem.length) });
      }
    }

    appletStart(applet, buffer) {
      const name = this.appletNames[applet] || 'applet';
      let detail = '';
      if ((applet & 0xFF) === 6 && buffer.length >= 8) { // error/EULA config: type, error code, ..., text at 0xC
        const dv = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
        const type = dv.getUint32(0, true), code = dv.getInt32(4, true);
        let text = '';
        for (let o = 0xC; o + 1 < buffer.length && text.length < 200; o += 2) { const c = dv.getUint16(o, true); if (!c) break; text += String.fromCharCode(c); }
        detail = ` (type ${type}, code ${code}${text ? `, "${text}"` : ''})`;
      }
      this.emu.log(`APT: ${name} ${hex(applet, 3)} requested${detail}; closing it immediately`);
      // WakeupByExit returns the parameter buffer to the application (the applet's result).
      this.sendToApp({ sender: applet, signal: 0xA, buffer, object: null });
    }

    // The system font lives in shared memory: a 0x80-byte header, then the BCFNT with absolute pointers.
    // Without a dumped font archive, a built-in stand-in font is used.
    sharedFont() {
      if (this.font) return this.font;
      const SIZE = 0x332000, ADDR = 0x18000000; // old linear heap address, as on hardware
      const buf = new Uint8Array(SIZE);
      const cfnt = EMU.buildStandinFont(ADDR + 0x80);
      const dv = new DataView(buf.buffer);
      dv.setUint32(0, 2, true);            // status: loaded
      dv.setUint32(4, 1, true);            // font type: JPN/USA/EUR
      dv.setUint32(8, cfnt.length, true);
      buf.set(cfnt, 0x80);
      const pages = [];
      for (let o = 0; o < SIZE; o += 0x1000) pages.push(buf.subarray(o, o + 0x1000));
      // The app converts the address to physical as old linear heap (+0x0C000000); let the GPU find it.
      this.emu.gpuAliases = (this.emu.gpuAliases || []).concat([{ phys: ADDR + 0x0C000000, virt: ADDR, size: SIZE }]);
      this.emu.log('APT: using a built-in stand-in system font');
      this.font = { addr: ADDR, block: new EMU.KMemBlock(pages, SIZE, ADDR) };
      return this.font;
    }

    handle(ipc, id) {
      const k = this.kernel;
      switch (id) {
        case 0x1: ipc.reply(id, [0, 0, 0], [0x04000000, k.createHandle(this.lock)]); return true; // GetLockHandle
        case 0x2: // Initialize
          ipc.reply(id, [0], [0x04000000, k.createHandle(this.notifEvent), k.createHandle(this.paramEvent)]);
          this.sendToApp({ sender: 0x101, signal: 1, buffer: new Uint8Array(0), object: null }); // HOME menu: wakeup
          return true;
        case 0x3: ipc.reply(id, [0]); return true; // Enable
        case 0x6: ipc.reply(id, [0, 0, 0, 0, 1, 1, 0]); return true; // GetAppletInfo
        case 0x9: ipc.reply(id, [0, 1]); return true; // IsRegistered
        case 0xB: ipc.reply(id, [0, 0]); return true; // InquireNotification
        case 0xD: case 0xE: { // ReceiveParameter / GlanceParameter(appId, bufferSize)
          const p = this.params[0];
          if (!p) { ipc.reply(id, [0xC8A0CFEF, 0, 0, 0], [0, 0, 2, 0]); return true; }
          if (id === 0xD) this.params.shift();
          const max = ipc.get(2), dst = this.mem.r32((ipc.addr + 0x104) >>> 0);
          const n = Math.min(max, p.buffer.length);
          if (n) this.mem.writeBytes(dst, p.buffer.subarray(0, n));
          ipc.reply(id, [0, p.sender, p.signal, n], [0, p.object ? k.createHandle(p.object) : 0, (n << 14) | 2, dst]);
          if (this.params.length) k.signal(this.paramEvent);
          return true;
        }
        case 0x0C: { // SendParameter(src, dst, signal, size, handle, buffer)
          const dstApp = ipc.get(2), signal = ipc.get(3), size = ipc.get(4);
          const buf = size ? this.mem.readBytes(ipc.get(8), size) : new Uint8Array(0);
          if (dstApp >= 0x200 && dstApp < 0x500) this.appletRequest(dstApp, signal, buf);
          ipc.reply(id, [0]);
          return true;
        }
        case 0x16: case 0x17: case 0x18: ipc.reply(id, [0]); return true; // Preload/FinishPreloading/PrepareToStart library applet
        case 0x1E: { // StartLibraryApplet(appId, size, handle, buffer)
          const applet = ipc.get(1), size = ipc.get(2), buf = size ? this.mem.readBytes(ipc.get(6), size) : new Uint8Array(0);
          ipc.reply(id, [0]);
          this.appletStart(applet, buf);
          return true;
        }
        case 0x3B: ipc.reply(id, [0]); return true; // CancelLibraryApplet
        case 0xF: ipc.reply(id, [0, 1]); return true; // CancelParameter
        case 0x27: case 0x28: // CloseApplication
          ipc.reply(id, [0]);
          this.emu.halt('Application closed (APT_CloseApplication)');
          k.cpu.stop = true;
          return true;
        case 0x43: ipc.reply(id, [0]); return true; // NotifyToWait
        case 0x3E: ipc.reply(id, [0]); return true; // ReplySleepQuery
        case 0x44: { // GetSharedFont -> address to map it at, shared memory handle
          const font = this.sharedFont();
          ipc.reply(id, [0, font.addr], [0, k.createHandle(font.block)]);
          return true;
        }
        case 0x4B: ipc.reply(id, [0, 0]); return true; // AppletUtility
        case 0x4F: ipc.reply(id, [0]); return true; // SetAppCpuTimeLimit
        case 0x50: ipc.reply(id, [0, 80]); return true; // GetAppCpuTimeLimit
        case 0x101: case 0x102: ipc.reply(id, [0, 0]); return true; // CheckNew3DS
      }
      return false;
    }
  }

  // ------------------------------------------------------------------ GSP (GPU)
  const GSP_INT = { PSC0: 0, PSC1: 1, VBLANK0: 2, VBLANK1: 3, PPF: 4, P3D: 5, DMA: 6 };
  const BPP = [4, 3, 2, 2, 2, 4, 4, 4];

  function decodePixel(fmt, b, o) {
    switch (fmt) {
      case 0: return [b[o + 3], b[o + 2], b[o + 1], b[o]];                          // RGBA8 (ABGR bytes)
      case 1: return [b[o + 2], b[o + 1], b[o], 255];                               // RGB8 (BGR bytes)
      case 2: { const v = b[o] | (b[o + 1] << 8); return [((v >> 11) & 31) * 255 / 31 | 0, ((v >> 5) & 63) * 255 / 63 | 0, (v & 31) * 255 / 31 | 0, 255]; }
      case 3: { const v = b[o] | (b[o + 1] << 8); return [((v >> 11) & 31) * 255 / 31 | 0, ((v >> 6) & 31) * 255 / 31 | 0, ((v >> 1) & 31) * 255 / 31 | 0, (v & 1) * 255]; }
      case 4: { const v = b[o] | (b[o + 1] << 8); return [((v >> 12) & 15) * 17, ((v >> 8) & 15) * 17, ((v >> 4) & 15) * 17, (v & 15) * 17]; }
    }
    return [0, 0, 0, 255];
  }

  function encodePixel(fmt, b, o, c) {
    switch (fmt) {
      case 0: b[o] = c[3]; b[o + 1] = c[2]; b[o + 2] = c[1]; b[o + 3] = c[0]; return;
      case 1: b[o] = c[2]; b[o + 1] = c[1]; b[o + 2] = c[0]; return;
      case 2: { const v = ((c[0] >> 3) << 11) | ((c[1] >> 2) << 5) | (c[2] >> 3); b[o] = v; b[o + 1] = v >> 8; return; }
      case 3: { const v = ((c[0] >> 3) << 11) | ((c[1] >> 3) << 6) | ((c[2] >> 3) << 1) | (c[3] >> 7); b[o] = v; b[o + 1] = v >> 8; return; }
      case 4: { const v = ((c[0] >> 4) << 12) | ((c[1] >> 4) << 8) | ((c[2] >> 4) << 4) | (c[3] >> 4); b[o] = v; b[o + 1] = v >> 8; return; }
    }
  }

  // Pixel as (r << 24 | g << 16 | b << 8 | a), without allocating
  function decodePacked(fmt, b, o) {
    switch (fmt) {
      case 0: return ((b[o + 3] << 24) | (b[o + 2] << 16) | (b[o + 1] << 8) | b[o]) >>> 0;
      case 1: return ((b[o + 2] << 24) | (b[o + 1] << 16) | (b[o] << 8) | 255) >>> 0;
      default: { const c = decodePixel(fmt, b, o); return ((c[0] << 24) | (c[1] << 16) | (c[2] << 8) | c[3]) >>> 0; }
    }
  }

  function encodePacked(fmt, b, o, v) {
    switch (fmt) {
      case 0: b[o] = v; b[o + 1] = v >>> 8; b[o + 2] = v >>> 16; b[o + 3] = v >>> 24; return;
      case 1: b[o] = v >>> 8; b[o + 1] = v >>> 16; b[o + 2] = v >>> 24; return;
      default: encodePixel(fmt, b, o, [v >>> 24, (v >>> 16) & 255, (v >>> 8) & 255, v & 255]);
    }
  }

  const MORTON8 = new Uint8Array(64);
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
    let m = 0;
    for (let i = 0; i < 3; i++) m |= (((x >> i) & 1) << (2 * i)) | (((y >> i) & 1) << (2 * i + 1));
    MORTON8[y * 8 + x] = m;
  }
  const tiledOffset = (x, y, w, bpp) => ((((y >> 3) * (w >> 3) + (x >> 3)) << 6) + MORTON8[(y & 7) * 8 + (x & 7)]) * bpp;

  EMU.decodePixel = decodePixel;
  EMU.FB_BPP = BPP;

  class GspService extends Service {
    constructor(emu, name) {
      super(emu, name);
      this.shared = new Uint8Array(0x1000);
      this.block = new EMU.KMemBlock([this.shared], 0x1000);
      this.event = null;
      this.threadId = 0;
      this.screens = [null, null];
    }

    u32(o) { const b = this.shared; return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }

    pushInterrupt(id) {
      if (!this.event) return;
      const b = this.shared, base = this.threadId * 0x40;
      const cur = b[base], count = b[base + 1];
      if (count >= 0x34) { b[base + 2] = 1; return; }
      b[base + 0xC + ((cur + count) % 0x34)] = id;
      b[base + 1] = count + 1;
      this.kernel.signalEvent(this.event);
    }

    parseInfo(read) {
      return { active: read(0), fb0: read(1), fb1: read(2), stride: read(3), format: read(4) };
    }

    // Returns the framebuffer info currently shown on a screen (0 = top, 1 = bottom).
    screenInfo(screen) {
      const off = 0x200 + this.threadId * 0x80 + screen * 0x40;
      const b = this.shared;
      if (b[off + 1]) {
        const e = off + 4 + (b[off] & 1) * 0x1C;
        this.screens[screen] = this.parseInfo((i) => this.u32(e + i * 4));
        b[off + 1] = 0;
      }
      return this.screens[screen];
    }

    vblank() {
      this.processGx();
      this.pushInterrupt(GSP_INT.VBLANK0);
      this.pushInterrupt(GSP_INT.VBLANK1);
    }

    handle(ipc, id) {
      const k = this.kernel;
      switch (id) {
        case 0x1: case 0x2: ipc.reply(id, [0]); return true; // WriteHWRegs(WithMask)
        case 0x4: ipc.reply(id, [0]); return true;           // ReadHWRegs
        case 0x5: { // SetBufferSwap(screen, FramebufferInfo)
          const screen = ipc.get(1) & 1;
          this.screens[screen] = this.parseInfo((i) => ipc.get(2 + i));
          ipc.reply(id, [0]);
          return true;
        }
        case 0x8: case 0x9: // FlushDataCache / InvalidateDataCache(addr, size): the GPU must re-read this memory
          this.emu.gpu.invalidateVirt(ipc.get(1), ipc.get(2));
          ipc.reply(id, [0]);
          return true;
        case 0xA: case 0xB: ipc.reply(id, [0]); return true; // SetLcdForceBlack, UpdateHeapRegions
        case 0xC: ipc.reply(id, [0]); this.processGx(); return true;          // TriggerCmdReqQueue
        case 0x13: { // RegisterInterruptRelayQueue(flags, event)
          this.event = k.getObj(ipc.get(3));
          ipc.reply(id, [0x2A07, this.threadId], [0x04000000, k.createHandle(this.block)]);
          return true;
        }
        case 0x14: this.event = null; ipc.reply(id, [0]); return true;
        case 0x15: ipc.reply(id, [0]); return true; // TryAcquireRight
        case 0x16: case 0x17: ipc.reply(id, [0]); return true; // AcquireRight / ReleaseRight
        case 0x18: { // ImportDisplayCaptureInfo
          const words = [0];
          for (const s of [0, 1]) {
            const info = this.screens[s] || { fb0: 0, fb1: 0, format: 0, stride: 0 };
            words.push(info.fb0, info.fb1, info.format, info.stride);
          }
          ipc.reply(id, words);
          return true;
        }
        case 0x19: case 0x1A: case 0x1F: case 0x1C: ipc.reply(id, [0]); return true;
      }
      return false;
    }

    // ---------------------------------------------------------------- GX command queue
    processGx() {
      const b = this.shared, base = 0x800 + this.threadId * 0x200;
      let guard = 0;
      while (b[base + 1] > 0 && guard++ < 16) {
        const idx = b[base];
        const off = base + 0x20 + idx * 0x20;
        const w = [];
        for (let i = 0; i < 8; i++) w.push(this.u32(off + i * 4));
        b[base] = (idx + 1) % 15;
        b[base + 1]--;
        try {
          this.execGx(w);
        } catch (e) {
          this.emu.log(`GX command ${w[0] & 0xFF} failed: ${e.message}`);
        }
      }
    }

    execGx(w) {
      const mem = this.mem;
      switch (w[0] & 0xFF) {
        case 0: { // RequestDma(src, dst, size)
          if (w[3]) { mem.writeBytes(w[2], mem.readBytes(w[1], w[3])); this.emu.gpu.invalidateVirt(w[2], w[3]); }
          this.pushInterrupt(GSP_INT.DMA);
          return;
        }
        case 1: // ProcessCommandList(address, size)
          this.emu.gpu.runCommandList(w[1], w[2]);
          this.pushInterrupt(GSP_INT.P3D);
          return;
        case 2: { // MemoryFill
          const fills = [[w[1], w[2], w[3], w[7] & 0xFFFF], [w[4], w[5], w[6], w[7] >>> 16]];
          fills.forEach(([start, value, end, ctl], i) => {
            if (!start || !(ctl & 1) || end <= start) return;
            const width = (ctl >> 8) & 3;
            const len = end - start;
            const data = new Uint8Array(len);
            const pat = width === 0 ? [value & 0xFF, (value >> 8) & 0xFF] : width === 1 ? [value & 0xFF, (value >> 8) & 0xFF, (value >> 16) & 0xFF] : [value & 0xFF, (value >> 8) & 0xFF, (value >> 16) & 0xFF, value >>> 24];
            for (let j = 0; j < len; j++) data[j] = pat[j % pat.length];
            mem.writeBytes(start, data);
            this.emu.gpu.invalidateVirt(start, len);
            this.pushInterrupt(i === 0 ? GSP_INT.PSC0 : GSP_INT.PSC1);
          });
          return;
        }
        case 3: this.displayTransfer(w[1], w[2], w[3], w[4], w[5]); this.pushInterrupt(GSP_INT.PPF); return;
        case 4: this.textureCopy(w[1], w[2], w[3], w[4], w[5]); this.pushInterrupt(GSP_INT.PPF); return;
        case 5: return; // FlushCacheRegions
      }
      this.emu.log(`Unknown GX command ${hex(w[0])}`);
    }

    displayTransfer(src, dst, inDim, outDim, flags) {
      const inW = inDim & 0xFFFF, inH = inDim >>> 16, outW = outDim & 0xFFFF, outH = outDim >>> 16;
      const inFmt = (flags >> 8) & 7, outFmt = (flags >> 12) & 7;
      const inBpp = BPP[inFmt], outBpp = BPP[outFmt];
      if (!inW || !inH || !outW || !outH) return;
      const input = this.mem.readBytes(src, inW * inH * inBpp);
      if (flags & 8) { // raw copy
        this.mem.writeBytes(dst, input.subarray(0, Math.min(input.length, outW * outH * outBpp)));
        return;
      }
      const output = new Uint8Array(outW * outH * outBpp);
      const flip = flags & 1, outTiled = flags & 2, scale = (flags >> 24) & 3;
      const sx = scale ? 1 : 0, sy = scale === 2 ? 1 : 0;
      const same = inFmt === outFmt;
      for (let y = 0; y < outH; y++) {
        const oy = flip ? outH - 1 - y : y;
        const iy = y << sy;
        if (iy >= inH) break;
        for (let x = 0; x < outW; x++) {
          const ix = x << sx;
          if (ix >= inW) break;
          const so = outTiled ? (iy * inW + ix) * inBpp : tiledOffset(ix, iy, inW, inBpp);
          const doff = outTiled ? tiledOffset(x, oy, outW, outBpp) : (oy * outW + x) * outBpp;
          if (so + inBpp > input.length || doff + outBpp > output.length) continue;
          if (same) for (let k = 0; k < inBpp; k++) output[doff + k] = input[so + k];
          else encodePacked(outFmt, output, doff, decodePacked(inFmt, input, so));
        }
      }
      this.mem.writeBytes(dst, output);
      this.emu.gpu.invalidateVirt(dst, output.length);
    }

    textureCopy(src, dst, size, inLine, outLine) {
      const inW = (inLine & 0xFFFF) * 16, inGap = (inLine >>> 16) * 16;
      const outW = (outLine & 0xFFFF) * 16, outGap = (outLine >>> 16) * 16;
      size &= ~15;
      this.emu.gpu.invalidateVirt(dst, size + outGap * Math.ceil(size / Math.max(outW, 1)));
      if (!inW || !outW) { if (size) this.mem.writeBytes(dst, this.mem.readBytes(src, size)); return; }
      let si = src, di = dst, sRem = inW, dRem = outW, left = size;
      while (left > 0) {
        const n = Math.min(sRem, dRem, left);
        this.mem.writeBytes(di, this.mem.readBytes(si, n));
        si += n; di += n; sRem -= n; dRem -= n; left -= n;
        if (sRem === 0) { si += inGap; sRem = inW; }
        if (dRem === 0) { di += outGap; dRem = outW; }
      }
    }
  }

  // ------------------------------------------------------------------ HID (input)
  class HidService extends Service {
    constructor(emu, name) {
      super(emu, name);
      this.shared = new Uint8Array(0x1000);
      this.block = new EMU.KMemBlock([this.shared], 0x1000);
      this.events = [0, 1, 2, 3, 4].map((i) => new EMU.KEvent(1, `HID event ${i}`));
      this.dv = new DataView(this.shared.buffer);
      this.index = 0;
    }

    handle(ipc, id) {
      const k = this.kernel;
      switch (id) {
        case 0xA: // GetIPCHandles
          ipc.reply(id, [0], [0x14000000, k.createHandle(this.block), ...this.events.map((e) => k.createHandle(e))]);
          return true;
        case 0x11: case 0x12: case 0x13: case 0x14: ipc.reply(id, [0]); return true; // Enable/Disable accel/gyro
        case 0x15: ipc.reply(id, [0, 0x41660000]); return true; // GetGyroscopeRawToDpsCoefficient (14.375f)
        case 0x16: ipc.reply(id, [0, 0, 0, 0, 0, 0]); return true;
        case 0x17: ipc.reply(id, [0, 0x3F]); return true; // GetSoundVolume
      }
      return false;
    }

    update(input) {
      const dv = this.dv, tick = Math.floor(this.kernel.ticks);
      const idx = this.index = (this.index + 1) & 7;
      // PAD section (words 0..41)
      dv.setUint32(0x00, tick >>> 0, true); dv.setUint32(0x04, 0, true);
      dv.setUint32(0x08, (tick - 1000) >>> 0, true); dv.setUint32(0x0C, 0, true);
      dv.setUint32(0x10, idx, true);
      let keys = input.keys;
      const cx = input.cx, cy = input.cy;
      if (cx > 40) keys |= 1 << 28; if (cx < -40) keys |= 1 << 29;
      if (cy > 40) keys |= 1 << 30; if (cy < -40) keys |= 1 << 31;
      if (input.touch) keys |= 1 << 20;
      const e = 0x28 + idx * 0x10;
      const prev = this.prevKeys || 0;
      dv.setUint32(e, keys >>> 0, true);
      dv.setUint32(e + 4, (keys & ~prev) >>> 0, true);
      dv.setUint32(e + 8, (prev & ~keys) >>> 0, true);
      dv.setInt16(e + 12, cx, true); dv.setInt16(e + 14, cy, true);
      this.prevKeys = keys;
      // Touch section (words 42..)
      const tb = 42 * 4;
      dv.setUint32(tb, tick >>> 0, true); dv.setUint32(tb + 4, 0, true);
      dv.setUint32(tb + 8, (tick - 1000) >>> 0, true); dv.setUint32(tb + 12, 0, true);
      dv.setUint32(tb + 16, idx, true);
      const te = tb + 32 + idx * 8;
      dv.setUint16(te, input.touch ? input.tx : 0, true); dv.setUint16(te + 2, input.touch ? input.ty : 0, true);
      dv.setUint32(te + 4, input.touch ? 1 : 0, true);
      for (const ev of this.events.slice(0, 2)) this.kernel.signalEvent(ev);
    }
  }

  // ------------------------------------------------------------------ FS
  // A read-only file session backed by a byte array (used for the RomFS).
  class FileService extends Service {
    constructor(emu, name, data) { super(emu, name); this.data = data; }
    handle(ipc, id) {
      switch (id) {
        case 0x802: { // Read(offset u64, size, buffer)
          const off = ipc.get(1) + ipc.get(2) * 4294967296, size = ipc.get(3), ptr = ipc.get(5);
          const start = Math.min(off, this.data.length), n = Math.min(size, this.data.length - start);
          if (this.emu.traceFs) this.emu.log(`fs: read ${this.name} @${hex(off)} size ${hex(size)}`);
          if (n > 0) this.mem.writeBytes(ptr, this.data.subarray(start, start + n));
          ipc.reply(id, [0, n], [(size << 4) | 0xC, ptr]);
          return true;
        }
        case 0x803: ipc.reply(id, [0xE0C046BE, 0]); return true; // Write: read-only
        case 0x804: ipc.reply(id, [0, this.data.length >>> 0, Math.floor(this.data.length / 4294967296)]); return true; // GetSize
        case 0x808: case 0x809: ipc.reply(id, [0]); return true; // Close, Flush
        case 0x80A: ipc.reply(id, [0]); return true;    // SetPriority
        case 0x80B: ipc.reply(id, [0, 0]); return true; // GetPriority
        case 0x80C: ipc.reply(id, [0], [0x10, this.kernel.createHandle(new EMU.KSession(this))]); return true; // OpenLinkFile
      }
      return false;
    }
  }

  // FS result codes (as returned by real hardware)
  const ERR_FILE_NOT_FOUND = 0xC8804470;
  const ERR_PATH_NOT_FOUND = 0xC8804478;
  const ERR_FILE_EXISTS = 0xC82044BE;
  const ERR_DIR_EXISTS = 0xC82044B9;
  const ERR_NOT_FORMATTED = 0xC8A04554;
  const ERR_EXTDATA_MISSING = 0xC8A04478;
  const ERR_DIR_NOT_EMPTY = 0xC82044F0;

  // A writable, in-memory archive (save data, extdata, SD card, system save).
  class Volume {
    constructor() { this.files = new Map(); this.dirs = new Set(['']); }
    static norm(p) { return p.replace(/\\/g, '/').split('/').filter((s) => s && s !== '.').join('/'); }
    static parent(p) { const i = p.lastIndexOf('/'); return i < 0 ? '' : p.slice(0, i); }
    clear() { this.files.clear(); this.dirs = new Set(['']); }
  }

  // A file in a Volume; writes grow the backing array.
  class VolumeFileService extends Service {
    constructor(emu, vol, path) { super(emu, `file ${path}`); this.vol = vol; this.path = path; }
    get data() { return this.vol.files.get(this.path) || new Uint8Array(0); }
    set data(d) { this.vol.files.set(this.path, d); }
    resize(n) { const old = this.data; if (n === old.length) return; const d = new Uint8Array(n); d.set(old.subarray(0, Math.min(n, old.length))); this.data = d; }
    handle(ipc, id) {
      switch (id) {
        case 0x802: { // Read(offset u64, size, buffer)
          const data = this.data, off = ipc.get(1) + ipc.get(2) * 4294967296, size = ipc.get(3), ptr = ipc.get(5);
          const start = Math.min(off, data.length), n = Math.min(size, data.length - start);
          if (n > 0) this.mem.writeBytes(ptr, data.subarray(start, start + n));
          ipc.reply(id, [0, n], [(size << 4) | 0xC, ptr]);
          return true;
        }
        case 0x803: { // Write(offset u64, size, flags, buffer)
          const off = ipc.get(1) + ipc.get(2) * 4294967296, size = ipc.get(3), ptr = ipc.get(6);
          if (off + size > this.data.length) this.resize(off + size);
          if (size) this.data.set(this.mem.readBytes(ptr, size), off);
          ipc.reply(id, [0, size], [(size << 4) | 0xA, ptr]);
          return true;
        }
        case 0x804: { const n = this.data.length; ipc.reply(id, [0, n >>> 0, Math.floor(n / 4294967296)]); return true; } // GetSize
        case 0x805: this.resize(ipc.get(1) + ipc.get(2) * 4294967296); ipc.reply(id, [0]); return true; // SetSize
        case 0x806: ipc.reply(id, [0, 0]); return true; // GetAttributes
        case 0x807: ipc.reply(id, [0]); return true;    // SetAttributes
        case 0x808: case 0x809: ipc.reply(id, [0]); return true; // Close, Flush
        case 0x80A: ipc.reply(id, [0]); return true;    // SetPriority
        case 0x80B: ipc.reply(id, [0, 0]); return true; // GetPriority
        case 0x80C: ipc.reply(id, [0], [0x10, this.kernel.createHandle(new EMU.KSession(this))]); return true; // OpenLinkFile
      }
      return false;
    }
  }

  // Directory listing session: Read(count) fills 0x228-byte entries.
  class DirectoryService extends Service {
    constructor(emu, vol, path) {
      super(emu, `dir ${path}`);
      const prefix = path ? path + '/' : '';
      const child = (p) => p.startsWith(prefix) && p.length > prefix.length && !p.slice(prefix.length).includes('/');
      this.entries = [
        ...[...vol.dirs].filter(child).map((p) => ({ name: p.slice(prefix.length), dir: true, size: 0 })),
        ...[...vol.files.keys()].filter(child).map((p) => ({ name: p.slice(prefix.length), dir: false, size: vol.files.get(p).length })),
      ];
      this.pos = 0;
    }
    handle(ipc, id) {
      if (id === 0x801) { // Read(count, buffer)
        const count = ipc.get(1), ptr = ipc.get(3);
        let n = 0;
        for (; n < count && this.pos < this.entries.length; n++, this.pos++) {
          const e = this.entries[this.pos], buf = new Uint8Array(0x228), dv = new DataView(buf.buffer);
          for (let i = 0; i < Math.min(e.name.length, 0x105); i++) dv.setUint16(i * 2, e.name.charCodeAt(i), true);
          const dot = e.name.lastIndexOf('.'), base = (dot > 0 ? e.name.slice(0, dot) : e.name).toUpperCase(), ext = dot > 0 ? e.name.slice(dot + 1).toUpperCase() : '';
          for (let i = 0; i < Math.min(base.length, 8); i++) buf[0x20C + i] = base.charCodeAt(i);
          for (let i = 0; i < Math.min(ext.length, 3); i++) buf[0x216 + i] = ext.charCodeAt(i);
          buf[0x21C] = e.dir ? 1 : 0;
          buf[0x21E] = e.dir ? 0 : 1; // archive bit
          dv.setUint32(0x220, e.size >>> 0, true);
          this.mem.writeBytes((ptr + n * 0x228) >>> 0, buf);
        }
        ipc.reply(id, [0, n], [((count * 0x228) << 4) | 0xC, ptr]);
        return true;
      }
      if (id === 0x802) { ipc.reply(id, [0]); return true; } // Close
      return false;
    }
  }

  class FsService extends Service {
    constructor(emu, name) {
      super(emu, name);
      this.archives = new Map(); // handle -> { id, vol }
      this.nextArchive = 0x100;
    }

    // Volumes outlive fs sessions; keyed by archive id (+ path for extdata).
    volume(archiveId, pathKey, create) {
      const store = this.emu.fsVolumes || (this.emu.fsVolumes = this.defaultVolumes());
      const key = `${hex(archiveId)}:${pathKey}`;
      let vol = store.get(key);
      if (!vol && create) { vol = new Volume(); store.set(key, vol); }
      return vol || null;
    }

    // Data the system creates on a real console: shared extdata F000000B with the Play Coin file.
    defaultVolumes() {
      const store = new Map(), shared = new Volume();
      const coins = new Uint8Array(0x14), dv = new DataView(coins.buffer);
      dv.setUint32(0, 0x4F00, true); dv.setUint16(4, 10, true);                       // magic, total coins
      dv.setUint16(0x10, 2014, true); coins[0x12] = 12; coins[0x13] = 29;           // last coin date
      shared.files.set('gamecoin.dat', coins);
      store.set(`${hex(6)}:f000000b`, shared);
      return store;
    }

    // Extdata is identified by the low word of its 64-bit ID (binary path: [media type, ID low, ID high]).
    static extdataKey(pathKey) {
      const h = pathKey.replace(/[^0-9a-f]/gi, '');
      return h.length >= 16 ? h.slice(8, 16).match(/../g).reverse().join('').toLowerCase() : h;
    }

    // Resolve an archive id/path to a Volume, or return an error code.
    mountArchive(archiveId, pathKey) {
      switch (archiveId) {
        case 4: { // SaveData (formatted on demand via FormatSaveData)
          const vol = this.volume(4, '', false);
          return vol ? { vol } : { err: ERR_NOT_FORMATTED };
        }
        case 6: case 7: case 0x12345678: case 0x12345679: { // ExtSaveData (created via CreateExtSaveData)
          const vol = this.volume(6, FsService.extdataKey(pathKey), false);
          return vol ? { vol } : { err: ERR_EXTDATA_MISSING };
        }
        case 8: case 0x567890B2: case 0x567890B4: // System save data
          return { vol: this.volume(archiveId, pathKey, true) };
        case 9: return { vol: this.volume(9, '', true) }; // SDMC
      }
      return { err: ERR_PATH_NOT_FOUND };
    }

    // Binary archive path [title ID low, title ID high, media type, reserved] -> loaded system RomFS.
    systemArchive(ptr) {
      const id = (this.mem.r32((ptr + 4) >>> 0).toString(16).padStart(8, '0') + this.mem.r32(ptr >>> 0).toString(16).padStart(8, '0')).toLowerCase();
      let romfs = this.emu.systemArchives.get(id);
      const name = EMU.SYSTEM_ARCHIVE_NAMES[id];
      if (!romfs && EMU.STANDIN_ARCHIVES && EMU.STANDIN_ARCHIVES[id]) {
        romfs = EMU.STANDIN_ARCHIVES[id]();
        this.emu.systemArchives.set(id, romfs); // reuse for the rest of the session
        this.emu.standinArchives = (this.emu.standinArchives || new Set()).add(id);
        this.emu.log(`fs: system file ${id.toUpperCase()}${name ? ` (${name})` : ''} not added; using a built-in stand-in`);
      }
      if (!romfs) {
        this.emu.missingSystemArchive = { id, name };
        this.emu.log(`fs: missing system file ${id.toUpperCase()}${name ? ` (${name})` : ''}. Dump it from your 3DS and add it with "System files…".`);
      }
      return romfs || null;
    }

    pathKey(type, size, ptr) { return type === 1 ? '' : this.readPath(type, size, ptr); }

    // Extdata key from an ExtSaveDataInfo (media type, save ID u64) in the request words.
    extdataKeyFromInfo(ipc) { return ipc.get(2).toString(16).padStart(8, '0'); }

    archiveOf(ipc, i) { return this.archives.get(ipc.get(i)); }

    openFile(ipc, id, vol, path, flags) {
      path = Volume.norm(path);
      if (!vol.files.has(path)) {
        if (vol.dirs.has(path)) { ipc.reply(id, [ERR_FILE_NOT_FOUND, 0, 0]); return true; }
        if (!(flags & 4)) { ipc.reply(id, [ERR_FILE_NOT_FOUND, 0, 0]); return true; }
        if (!vol.dirs.has(Volume.parent(path))) { ipc.reply(id, [ERR_PATH_NOT_FOUND, 0, 0]); return true; }
        vol.files.set(path, new Uint8Array(0));
      }
      const h = this.kernel.createHandle(new EMU.KSession(new VolumeFileService(this.emu, vol, path)));
      ipc.reply(id, [0], [0x10, h]);
      return true;
    }

    // Reply layout: [header, result, move-handle descriptor, file handle]
    openRomfs(ipc, id) {
      const romfs = this.emu.romfs;
      if (!romfs) { ipc.reply(id, [ERR_NOT_FOUND, 0, 0]); return true; }
      const h = this.kernel.createHandle(new EMU.KSession(new FileService(this.emu, 'RomFS file', romfs)));
      ipc.reply(id, [0], [0x10, h]);
      return true;
    }

    // FS path: type 1 = empty, 2 = binary, 3 = ASCII, 4 = UTF-16
    readPath(type, size, ptr) {
      if (type === 3) { let s = ''; for (let i = 0; i < size; i++) { const c = this.mem.r8((ptr + i) >>> 0); if (!c) break; s += String.fromCharCode(c); } return s; }
      if (type === 4) { let s = ''; for (let i = 0; i + 1 < size; i += 2) { const c = this.mem.r16((ptr + i) >>> 0); if (!c) break; s += String.fromCharCode(c); } return s; }
      if (type === 2) { const b = []; for (let i = 0; i < size; i++) b.push(this.mem.r8((ptr + i) >>> 0).toString(16).padStart(2, '0')); return `[${b.join('')}]`; }
      return '';
    }

    handle(ipc, id) {
      if (this.emu.traceFs) this.emu.log(`fs: cmd ${hex(id, 4)} [${[1, 2, 3, 4, 5, 6].map((i) => hex(ipc.get(i))).join(' ')}]`);
      switch (id) {
        case 0x801: case 0x861: case 0x862: ipc.reply(id, [0]); return true; // Initialize, InitializeWithSdkVersion, SetPriority
        case 0x863: ipc.reply(id, [0, 0]); return true;
        case 0x803: { // OpenFileDirectly(transaction, archiveId, archPath, filePath, flags)
          const aid = ipc.get(2);
          if (aid === 3 || (aid === 0x2345678A && ipc.get(3) === 1)) return this.openRomfs(ipc, id);
          if (aid === 0x2345678A) { // another title's RomFS (system data such as Mii data or fonts)
            const romfs = this.systemArchive(ipc.get(10));
            if (!romfs) { ipc.reply(id, [ERR_NOT_FOUND, 0, 0]); return true; }
            const h = this.kernel.createHandle(new EMU.KSession(new FileService(this.emu, 'system RomFS', romfs)));
            ipc.reply(id, [0], [0x10, h]);
            return true;
          }
          const m = this.mountArchive(aid, this.pathKey(ipc.get(3), ipc.get(4), ipc.get(10)));
          if (m.err) { ipc.reply(id, [m.err, 0, 0]); return true; }
          return this.openFile(ipc, id, m.vol, this.readPath(ipc.get(5), ipc.get(6), ipc.get(12)), ipc.get(7));
        }
        case 0x80C: { // OpenArchive(archiveId, path) -> archive handle (u64)
          const aid = ipc.get(1);
          if (aid === 3 || (aid === 0x2345678A && ipc.get(2) === 1)) {
            if (!this.emu.romfs) { ipc.reply(id, [ERR_NOT_FOUND, 0, 0]); return true; }
            ipc.reply(id, [0, 3, 0]);
            return true;
          }
          if (aid === 0x2345678A) {
            const romfs = this.systemArchive(ipc.get(5));
            if (!romfs) { ipc.reply(id, [ERR_NOT_FOUND, 0, 0]); return true; }
            const h = this.nextArchive++;
            this.archives.set(h, { id: aid, romfs });
            ipc.reply(id, [0, h, 0]);
            return true;
          }
          const m = this.mountArchive(aid, this.pathKey(ipc.get(2), ipc.get(3), ipc.get(5)));
          if (m.err) { ipc.reply(id, [m.err, 0, 0]); return true; }
          const h = this.nextArchive++;
          this.archives.set(h, { id: aid, vol: m.vol });
          ipc.reply(id, [0, h, 0]);
          return true;
        }
        case 0x802: { // OpenFile(transaction, archiveHandle u64, path, flags)
          if (ipc.get(2) === 3) return this.openRomfs(ipc, id);
          const a = this.archiveOf(ipc, 2);
          if (!a) { ipc.reply(id, [ERR_NOT_FOUND, 0, 0]); return true; }
          if (a.romfs) {
            const h = this.kernel.createHandle(new EMU.KSession(new FileService(this.emu, 'system RomFS', a.romfs)));
            ipc.reply(id, [0], [0x10, h]);
            return true;
          }
          return this.openFile(ipc, id, a.vol, this.readPath(ipc.get(4), ipc.get(5), ipc.get(9)), ipc.get(6));
        }
        case 0x804: { // DeleteFile(transaction, archive, path)
          const a = this.archiveOf(ipc, 2), p = a && Volume.norm(this.readPath(ipc.get(4), ipc.get(5), ipc.get(7)));
          if (!a || !a.vol.files.delete(p)) { ipc.reply(id, [ERR_FILE_NOT_FOUND]); return true; }
          ipc.reply(id, [0]);
          return true;
        }
        case 0x805: { // RenameFile(transaction, srcArchive, srcPath, dstArchive, dstPath)
          const a = this.archiveOf(ipc, 2), b = this.archiveOf(ipc, 6);
          const src = Volume.norm(this.readPath(ipc.get(4), ipc.get(5), ipc.get(11))), dst = Volume.norm(this.readPath(ipc.get(8), ipc.get(9), ipc.get(13)));
          if (!a || !b || !a.vol.files.has(src)) { ipc.reply(id, [ERR_FILE_NOT_FOUND]); return true; }
          if (b.vol.files.has(dst)) { ipc.reply(id, [ERR_FILE_EXISTS]); return true; }
          b.vol.files.set(dst, a.vol.files.get(src)); a.vol.files.delete(src);
          ipc.reply(id, [0]);
          return true;
        }
        case 0x806: case 0x807: { // DeleteDirectory, DeleteDirectoryRecursively
          const a = this.archiveOf(ipc, 2), p = a && Volume.norm(this.readPath(ipc.get(4), ipc.get(5), ipc.get(7)));
          if (!a || !p || !a.vol.dirs.has(p)) { ipc.reply(id, [ERR_PATH_NOT_FOUND]); return true; }
          const inside = (q) => q.startsWith(p + '/');
          if (id === 0x806 && ([...a.vol.dirs].some(inside) || [...a.vol.files.keys()].some(inside))) { ipc.reply(id, [ERR_DIR_NOT_EMPTY]); return true; }
          for (const q of [...a.vol.dirs]) if (inside(q)) a.vol.dirs.delete(q);
          for (const q of [...a.vol.files.keys()]) if (inside(q)) a.vol.files.delete(q);
          a.vol.dirs.delete(p);
          ipc.reply(id, [0]);
          return true;
        }
        case 0x808: { // CreateFile(transaction, archive, path, attributes, size u64)
          const a = this.archiveOf(ipc, 2);
          if (!a) { ipc.reply(id, [ERR_NOT_FOUND]); return true; }
          const p = Volume.norm(this.readPath(ipc.get(4), ipc.get(5), ipc.get(10)));
          if (a.vol.files.has(p) || a.vol.dirs.has(p)) { ipc.reply(id, [ERR_FILE_EXISTS]); return true; }
          if (!a.vol.dirs.has(Volume.parent(p))) { ipc.reply(id, [ERR_PATH_NOT_FOUND]); return true; }
          a.vol.files.set(p, new Uint8Array(ipc.get(7) + ipc.get(8) * 4294967296));
          ipc.reply(id, [0]);
          return true;
        }
        case 0x809: { // CreateDirectory(transaction, archive, path, attributes)
          const a = this.archiveOf(ipc, 2);
          if (!a) { ipc.reply(id, [ERR_NOT_FOUND]); return true; }
          const p = Volume.norm(this.readPath(ipc.get(4), ipc.get(5), ipc.get(8)));
          if (a.vol.dirs.has(p) || a.vol.files.has(p)) { ipc.reply(id, [ERR_DIR_EXISTS]); return true; }
          if (!a.vol.dirs.has(Volume.parent(p))) { ipc.reply(id, [ERR_PATH_NOT_FOUND]); return true; }
          a.vol.dirs.add(p);
          ipc.reply(id, [0]);
          return true;
        }
        case 0x80A: { // RenameDirectory
          const a = this.archiveOf(ipc, 2);
          const src = Volume.norm(this.readPath(ipc.get(4), ipc.get(5), ipc.get(11))), dst = Volume.norm(this.readPath(ipc.get(8), ipc.get(9), ipc.get(13)));
          if (!a || !a.vol.dirs.has(src)) { ipc.reply(id, [ERR_PATH_NOT_FOUND]); return true; }
          if (a.vol.dirs.has(dst)) { ipc.reply(id, [ERR_DIR_EXISTS]); return true; }
          const move = (q) => (q === src ? dst : q.startsWith(src + '/') ? dst + q.slice(src.length) : q);
          a.vol.dirs = new Set([...a.vol.dirs].map(move));
          a.vol.files = new Map([...a.vol.files].map(([q, d]) => [move(q), d]));
          ipc.reply(id, [0]);
          return true;
        }
        case 0x80B: { // OpenDirectory(archive u64, path)
          const a = this.archiveOf(ipc, 1);
          const p = a && Volume.norm(this.readPath(ipc.get(3), ipc.get(4), ipc.get(6)));
          if (!a || !a.vol.dirs.has(p)) { ipc.reply(id, [ERR_PATH_NOT_FOUND, 0, 0]); return true; }
          const h = this.kernel.createHandle(new EMU.KSession(new DirectoryService(this.emu, a.vol, p)));
          ipc.reply(id, [0], [0x10, h]);
          return true;
        }
        case 0x80D: ipc.reply(id, [0]); return true; // ControlArchive (commit save data)
        case 0x80E: this.archives.delete(ipc.get(1)); ipc.reply(id, [0]); return true; // CloseArchive
        case 0x84C: { // FormatSaveData(archiveId, path, ...)
          this.volume(4, '', true).clear();
          ipc.reply(id, [0]);
          return true;
        }
        case 0x845: // GetFormatInfo(archiveId, path) -> totalSize, directories, files, duplicateData
          if (ipc.get(1) === 4 && !this.volume(4, '', false)) { ipc.reply(id, [ERR_NOT_FORMATTED, 0, 0, 0, 0]); return true; }
          ipc.reply(id, [0, 0x80000, 10, 10, 0]);
          return true;
        case 0x851: // CreateExtSaveData(info: mediaType u8, pad[3], saveId u64, ...)
          this.volume(6, this.extdataKeyFromInfo(ipc), true);
          ipc.reply(id, [0]);
          return true;
        case 0x852: { // DeleteExtSaveData(info)
          const store = this.emu.fsVolumes;
          if (store) store.delete(`${hex(6)}:${this.extdataKeyFromInfo(ipc)}`);
          ipc.reply(id, [0]);
          return true;
        }
        case 0x849: ipc.reply(id, [0, 0x200, 0x8000, 0x80000, 0x80000]); return true; // GetSdmcArchiveResource
        case 0x817: case 0x818: ipc.reply(id, [0, 0]); return true; // IsSdmcDetected / IsSdmcWritable
      }
      return false;
    }
  }

  // ------------------------------------------------------------------ DSP (audio)
  // The DSP firmware is not run. This answers the audio pipe like the real firmware and ticks
  // every audio frame so the game's sound library runs; no sound is produced yet.
  const DSP_RAM = 0x1FF40000;          // virtual address of DSP data address 0
  const AUDIO_FRAME_SAMPLES = 160, AUDIO_RATE = 32728;
  // Byte offsets of the 15 shared structures inside each of the two shared memory regions.
  // The application learns them from the audio pipe, so the layout only has to be self-consistent.
  const DSP_STRUCTS = [
    0x0000, // frame counter
    0x2000, // source configurations
    0x0400, // source statuses
    0x0800, // ADPCM coefficients
    0x0C00, // DSP configuration
    0x1000, // DSP status
    0x1400, // final samples
    0x4000, // intermediate mix samples
    0x6000, // compressor
    0x1800, // debug
    0x1C00, 0x7000, 0x7400, 0x7800, 0x8000, // unknown structures
  ];

  class DspService extends Service {
    constructor(emu, name) {
      super(emu, name);
      this.semaphoreEvent = new EMU.KEvent(0, 'DSP semaphore');
      this.interrupts = [null, null];   // interrupt types 0 and 1
      this.pipeEvents = [null, null, null, null];
      this.pipes = [[], [], [], []];    // DSP -> application data per pipe
      this.on = false;
      this.timer = null;
      this.frames = 0;
    }

    signalInterrupt(type, pipe) {
      const ev = type === 2 ? this.pipeEvents[pipe] : this.interrupts[type];
      if (ev) this.kernel.signalEvent(ev);
    }

    start() {
      this.on = true;
      if (this.timer) return;
      const tm = new EMU.KTimer(2);
      tm.interval = Math.round(EMU.TICKS_PER_SEC * AUDIO_FRAME_SAMPLES / AUDIO_RATE);
      tm.next = this.kernel.ticks + tm.interval;
      tm.onFire = () => this.tick();
      this.kernel.timers.add(tm);
      this.timer = tm;
    }

    // One audio frame: report statuses, then tell the application the frame is done.
    tick() {
      if (!this.on) return;
      this.frames++;
      this.signalInterrupt(2, 2);
    }

    pipeWrite(pipe, data) {
      if (pipe !== 2 || data.length < 1) return;
      switch (data[0]) {
        case 0: case 2: { // Initialize, Wakeup: reply with the structure addresses
          const out = [DSP_STRUCTS.length];
          for (const off of DSP_STRUCTS) out.push(0x8000 + (off >> 1));
          this.pipes[2] = [];
          for (const v of out) this.pipes[2].push(v & 0xFF, v >>> 8);
          this.start();
          this.signalInterrupt(2, 2);
          return;
        }
        case 1: case 3: this.on = false; return; // Shutdown, Sleep
      }
    }

    // Reply data through the caller's static receive buffer 0 (TLS + 0x180).
    readPipe(ipc, id, channel, size) {
      const q = this.pipes[channel] || [];
      const n = Math.min(size, q.length);
      const dst = this.mem.r32((ipc.addr + 0x104) >>> 0);
      if (n) this.mem.writeBytes(dst, Uint8Array.from(q.splice(0, n)));
      ipc.reply(id, [0, n], [(n << 14) | 2, dst]);
    }

    handle(ipc, id) {
      const k = this.kernel;
      switch (id) {
        case 0x01: ipc.reply(id, [0, this.on ? 0 : 1]); return true;          // RecvData: 0 = running
        case 0x02: ipc.reply(id, [0, 1]); return true;                         // RecvDataIsReady
        case 0x07: case 0x17: ipc.reply(id, [0]); return true;                 // SetSemaphore(Mask)
        case 0x0C: ipc.reply(id, [0, (DSP_RAM + ipc.get(1) * 2) >>> 0]); return true; // ConvertProcessAddressFromDspDram
        case 0x0D: { // WriteProcessPipe(channel, size, buffer)
          const size = ipc.get(2);
          this.pipeWrite(ipc.get(1), size ? this.mem.readBytes(ipc.get(4), size) : new Uint8Array(0));
          ipc.reply(id, [0]);
          return true;
        }
        case 0x0E: case 0x10: this.readPipe(ipc, id, ipc.get(1), ipc.get(3) & 0xFFFF); return true; // ReadPipe(IfPossible)
        case 0x0F: ipc.reply(id, [0, (this.pipes[ipc.get(1)] || []).length]); return true; // GetPipeReadableSize
        case 0x11: // LoadComponent(size, programMask, dataMask, buffer) -> loaded
          if (!this.warned) { this.warned = true; this.emu.log('DSP: audio firmware accepted; audio runs silently (sound output is not emulated yet)'); }
          ipc.reply(id, [0, 1], [(ipc.get(1) << 4) | 0xA, ipc.get(5)]);
          return true;
        case 0x12: this.on = false; ipc.reply(id, [0]); return true;          // UnloadComponent
        case 0x13: case 0x14: ipc.reply(id, [0]); return true;                // Flush/InvalidateDataCache
        case 0x15: { // RegisterInterruptEvents(interrupt, channel, event)
          const type = ipc.get(1), channel = ipc.get(2), ev = ipc.get(4) ? k.getObj(ipc.get(4)) : null;
          if (type === 2) this.pipeEvents[channel & 3] = ev; else this.interrupts[type & 1] = ev;
          ipc.reply(id, [0]);
          return true;
        }
        case 0x16: ipc.reply(id, [0], [0, k.createHandle(this.semaphoreEvent)]); return true; // GetSemaphoreEventHandle
        case 0x1F: case 0x21: ipc.reply(id, [0, 0]); return true;              // GetHeadphoneStatus, GetIsDspOccupied
        case 0x20: ipc.reply(id, [0]); return true;                            // ForceHeadphoneOut
      }
      return false;
    }
  }

  // ------------------------------------------------------------------ CFG
  class CfgService extends Service {
    handle(ipc, id) {
      switch (id) {
        case 0x1: case 0x401: case 0x801: { // GetConfigInfoBlk2/8
          const size = ipc.get(1), blk = ipc.get(2), ptr = ipc.get(4);
          const data = new Uint8Array(size);
          if (blk === 0x50005) { // stereo camera calibration (Citra's defaults)
            const dv = new DataView(data.buffer);
            [62.0, 289.0, 76.80000305175781, 46.08000183105469, 10.0, 5.0, 55.58000183105469, 21.56999969482422]
              .forEach((v, i) => { if (i * 4 + 4 <= size) dv.setFloat32(i * 4, v, true); });
          }
          else if (blk === 0x70001) data[0] = 1;                  // sound output: stereo
          else if (blk === 0xD0000 && size >= 2) { data[0] = 0x7F; data[1] = 0x7F; } // accepted EULA version
          else if (blk === 0xA0002) data[0] = 1;                  // language: English
          else if (blk === 0xB0000 && size >= 4) { data[2] = 1; data[3] = 49; } // country: USA
          else if (blk === 0xA0000) { const n = 'Emu'; for (let i = 0; i < n.length; i++) data[i * 2] = n.charCodeAt(i); }
          try { this.mem.writeBytes(ptr, data); } catch (e) { /* ignore bad buffers */ }
          ipc.reply(id, [0], [(size << 4) | 0xC, ptr]);
          return true;
        }
        case 0x2: ipc.reply(id, [0, 1]); return true;          // SecureInfoGetRegion: USA
        case 0x3: ipc.reply(id, [0, 0x12345678, 0x9ABC]); return true;
        case 0x4: case 0x5: ipc.reply(id, [0, 0]); return true; // GetRegionCanadaUSA, GetSystemModel (CTR)
        case 0x6: ipc.reply(id, [0, 1]); return true;          // GetModelNintendo2DS: not a 2DS
      }
      return false;
    }
  }

  // ------------------------------------------------------------------ PTM
  class PtmService extends Service {
    handle(ipc, id) {
      switch (id) {
        case 0x5: case 0x6: ipc.reply(id, [0, 1]); return true; // GetAdapterState, GetShellState
        case 0x7: ipc.reply(id, [0, 5]); return true;           // GetBatteryLevel
        case 0x8: ipc.reply(id, [0, 0]); return true;           // GetBatteryChargeState
      }
      return false;
    }
  }

  class StubService extends Service {}

  // ------------------------------------------------------------------ registry
  class Services {
    constructor(emu) {
      this.emu = emu;
      this.instances = new Map();
      this.srv = new SrvService(emu, 'srv:');
      this.errf = new ErrFService(emu, 'err:f');
      this.warned = new Set();
    }

    get gsp() { return this.getService('gsp::Gpu'); }
    get hid() { return this.getService('hid:USER'); }

    connectPort(name) {
      if (name === 'srv:') return this.srv;
      if (name === 'err:f') return this.errf;
      return null;
    }

    getService(name) {
      const key = name.startsWith('APT:') ? 'APT' : name.startsWith('hid:') ? 'HID' : name.startsWith('cfg:') ? 'CFG' : name.startsWith('ptm:') ? 'PTM' : name;
      let svc = this.instances.get(key);
      if (!svc) {
        switch (key) {
          case 'APT': svc = new AptService(this.emu, name); break;
          case 'gsp::Gpu': svc = new GspService(this.emu, name); break;
          case 'HID': svc = new HidService(this.emu, name); break;
          case 'fs:USER': svc = new FsService(this.emu, name); break;
          case 'CFG': svc = new CfgService(this.emu, name); break;
          case 'PTM': svc = new PtmService(this.emu, name); break;
          case 'dsp::DSP': svc = new DspService(this.emu, name); break;
          default: svc = new StubService(this.emu, name); this.emu.log(`Service "${name}" is stubbed`);
        }
        this.instances.set(key, svc);
      }
      return svc;
    }

    handleRequest(service, addr) {
      const ipc = new Ipc(this.emu.mem, addr);
      const id = ipc.get(0) >>> 16;
      if (service.handle(ipc, id)) return;
      const key = `${service.name}:${id}`;
      if (!this.warned.has(key)) {
        this.warned.add(key);
        this.emu.log(`Stubbed IPC ${service.name} cmd ${hex(id, 4)}`);
      }
      for (let i = 2; i < 16; i++) ipc.set(i, 0);
      ipc.reply(id, [0]);
    }
  }

  EMU.Services = Services;
})(typeof window !== 'undefined' ? window.EMU : globalThis.EMU);

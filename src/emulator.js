// Ties memory, CPU, kernel and services together; runs frames and renders the two screens.
(function (EMU) {
  'use strict';

  const hex = EMU.hex;

  // Region of a system title from its ID (their icons list every region): HOME Menu IDs per region, and system
  // applications (0004001x) numbered 0x2x000 with x = 0 Japan, 1 USA, 2 Europe. USA when unknown.
  const HOME_MENU_REGIONS = { '0004003000008202': 0, '0004003000008f02': 1, '0004003000009802': 2, '000400300000a102': 4, '000400300000a902': 5, '000400300000b102': 6 };
  function regionFromTitleId(id) {
    if (!id) return 1;
    if (id in HOME_MENU_REGIONS) return HOME_MENU_REGIONS[id];
    const low = parseInt(id.slice(8), 16), r = (low >>> 12) & 0xF;
    return /^0004001[0-9a-f]/.test(id) && (low & 0xFFF00000) === 0 && r <= 2 ? r : 1;
  }

  class Emulator {
    constructor({ onLog = () => {}, onDebug = () => {}, onHalt = () => {} } = {}) {
      this.onLog = onLog;
      this.onDebug = onDebug;
      this.onHalt = onHalt;
      this.input = { keys: 0, cx: 0, cy: 0, touch: false, tx: 0, ty: 0 };
      this.loaded = false;
      this.halted = true;
      this.systemArchives = new Map(); // title ID (16 hex digits) -> RomFS bytes; kept across loads
      this.installedTitles = new Map(); // title ID -> size: the titles the user added, reported as installed (AM)
      // Per-frame timings in ms (wall clock): the whole frame, GPU command lists, and GX copies/fills.
      // CPU + kernel + services time is frame - gpu - xfer.
      this.perf = { frame: 0, gpu: 0, xfer: 0 };
    }

    addSystemArchive(titleId, romfs) { this.systemArchives.set(titleId.toLowerCase(), romfs); }

    // ExeFS files of a title added from the user's console ({ icon, logo, banner }), read by other titles
    addTitleExefs(titleId, files) { (this.titleExefs || (this.titleExefs = new Map())).set(titleId.toLowerCase(), files); }

    // Draw with the host GPU (an EMU.GLRenderer) or, with null, the software rasterizer. Can change while running.
    setRenderer(renderer) {
      this.glRenderer = renderer;
      const gpu = this.gpu;
      if (!gpu || gpu.gl === renderer) return;
      if (gpu.gl) { gpu.gl.syncToMemory(0, 0xFFFFFFFF); gpu.gl.attach(null); } // everything rendered so far into memory
      gpu.state = null;
      gpu.gl = renderer;
      if (renderer) renderer.attach(gpu);
    }

    log(msg) { this.onLog(msg); }

    debugOutput(s) { this.onDebug(s); }

    // A title asks for another one to run: the HOME Menu starting an app or applet ({ titleId } or { appId }), or a
    // title going back to the HOME Menu ({ home: true }). The page (onLaunch) loads it; this one stops quietly.
    // False when nothing handles it.
    requestLaunch(req) {
      if (!this.onLaunch || this.halted) return false;
      this.halted = true;
      this.haltReason = 'launch';
      this.kernel.cpu.stop = true;
      this.onLaunch(req);
      return true;
    }

    // The HOME button: tells the running title (which then saves and goes back to the HOME Menu). False when it
    // can't be told (not running, or it hasn't set up APT).
    pressHome() {
      const apt = !this.halted && this.services && this.services.instances.get('APT');
      if (!apt || !apt.appId || apt.appId === 0x101) return false;
      apt.notify(1);
      return true;
    }

    halt(reason) {
      if (this.halted) return;
      this.halted = true;
      this.haltReason = reason;
      this.onHalt(reason);
    }

    // romfs: optionally the game's RomFS read on demand (an EMU.LazyFile), when bytes holds only the start of a
    // large game file
    load(bytes, name = 'app', romfs = null) {
      this.loadGeneration = (this.loadGeneration || 0) + 1;
      this.halted = false;
      this.haltReason = null;
      this.missingSystemArchive = null;
      this.standinArchives = null; // title ID -> stand-in RomFS built for this load
      this.fsVolumes = null;       // the game's save data, extdata and SD card (see setSaves)
      this.savesDirty = false;
      // The parameter the HOME Menu started this title with (given with its first wake-up), for this load only
      this.startParam = this.nextStartParam || null;
      this.nextStartParam = null;
      this.pendingReads = 0;       // game file reads in flight (a save state waits for them)
      this.insnCount = 0;
      this.frame = 0;
      this.name = name;
      // RAM in one WebAssembly memory when the WebAssembly CPU is on (and the device allows the size)
      this.arena = this.wasmCpu === true && EMU.Arena ? EMU.Arena.create() : null;
      this.mem = new EMU.Memory(this.arena);
      this.cpu = new EMU.CPU(this.mem);
      this.kernel = new EMU.Kernel(this);
      this.services = new EMU.Services(this);
      this.gpu = new EMU.Gpu(this);
      if (this.glRenderer) { this.glRenderer.attach(this.gpu); this.gpu.gl = this.glRenderer; }
      const mem = this.mem;

      const info = EMU.loadExecutable(mem, bytes);
      if (romfs) info.romfs = romfs;
      // Titles built for kernels before 2.44 expect the old linear heap address
      if (info.kernelVersion && info.kernelVersion < 0x22C) this.kernel.linearBase = this.kernel.linearNext = 0x14000000;
      this.codeSize = info.size;
      this.romfs = info.romfs || null;

      const stackSize = Math.max(0x100000, ((info.stackSize || 0) + 0xFFF) & ~0xFFF);
      mem.alloc(0x10000000 - stackSize, stackSize, 3, 5, 'stack');
      mem.alloc(0x1F000000, 0x600000, 3, 6, 'VRAM');
      mem.alloc(0x1FF00000, 0x80000, 3, 6, 'DSP RAM');
      mem.alloc(0x1FF82000, 0x8000, 3, 5, 'TLS');

      // Kernel configuration page (read-only to apps).
      const cfg = new DataView(mem.alloc(0x1FF80000, 0x1000, 1, 3, 'config page').buffer);
      cfg.setUint32(0x00, 0x02390000, true); // kernel version 2.57
      cfg.setUint32(0x14, 1, true);          // ENVINFO: retail
      cfg.setUint32(0x30, 0, true);          // APPMEMTYPE
      this.kernel.appMemory = info.appMemory || 0x04000000; // from the game's system mode (64 MB by default)
      cfg.setUint32(0x40, this.kernel.appMemory, true); // APPMEMALLOC
      cfg.setUint32(0x44, 0x02C00000, true); // SYSMEMALLOC
      cfg.setUint32(0x48, 0x01400000, true); // BASEMEMALLOC
      cfg.setUint32(0x60, 0x02390000, true); // FIRM version

      // Shared page (time, 3D slider, ...).
      const sp = new DataView(mem.alloc(0x1FF81000, 0x1000, 1, 3, 'shared page').buffer);
      sp.setUint32(0x04, 1, true); // RUNNING_HW: retail
      sp.setUint8(0x85, 1 | (5 << 2)); // battery: adapter connected, full (else the HOME Menu warns of a low battery)
      const msSince1900 = Date.now() - new Date(Date.UTC(1900, 0, 1)).getTime() + -new Date().getTimezoneOffset() * 60000;
      for (const off of [0x20, 0x40]) { // osTimeRef_s[2]: value_ms, value_tick, sysclock_hz, drift_ms
        sp.setUint32(off, msSince1900 % 4294967296, true);
        sp.setUint32(off + 4, Math.floor(msSince1900 / 4294967296), true);
        sp.setUint32(off + 0x10, EMU.TICKS_PER_SEC, true);
      }
      sp.setFloat32(0x80, 0, true);

      this.kernel.createThread(info.entry, 0, 0x10000000, info.priority || 0x30);
      this.loaded = true;
      if (info.cryptoFlagUnset) this.log('This game is marked as encrypted in its header, but its contents are decrypted: loading it anyway.');
      this.title = info.title || null;
      // Console region: the one the title is made for (a European HOME Menu needs a European console), else USA
      this.region = info.region != null ? info.region : regionFromTitleId(info.programId);
      this.titleKey = info.programId || name; // which game: saves and save states are kept per game
      const extras = [info.title && `"${info.title}"`, info.programId && `title ID ${info.programId}`, info.romfs && `RomFS ${(info.romfs.length / 1024).toFixed(0)} KB`].filter(Boolean).join(', ');
      this.log(`Loaded ${name} (${info.format}, code ${(info.size / 1024).toFixed(0)} KB${extras ? ', ' + extras : ''}), entry ${hex(info.entry)}`);
      return info;
    }

    // The game's saves (save data, extdata, SD card files) as plain data: { key: { files: [[path, bytes]], dirs } }
    getSaves() {
      const out = {};
      if (this.fsVolumes) for (const [key, vol] of this.fsVolumes) out[key] = { files: [...vol.files], dirs: [...vol.dirs] };
      return out;
    }

    // Put saves back before the game runs (or between frames)
    setSaves(saves) {
      const store = new Map();
      for (const key of Object.keys(saves || {})) {
        const vol = new EMU.Volume(), s = saves[key];
        for (const [p, bytes] of s.files) vol.files.set(p, new Uint8Array(bytes));
        vol.dirs = new Set(s.dirs);
        store.set(key, vol);
      }
      // What the system creates on a console (shared extdata), where the saves lack it
      for (const [key, vol] of EMU.classes.FsService.defaultVolumes()) if (!store.has(key)) store.set(key, vol);
      this.fsVolumes = store;
    }

    runFrame() {
      if (this.halted) return;
      const perf = this.perf, t0 = EMU.now();
      perf.gpu = perf.xfer = 0;
      try {
        if (this.services.instances.has('HID')) this.services.hid.update(this.input);
        this.kernel.runUntil(this.kernel.ticks + EMU.TICKS_PER_FRAME);
        this.cpu.flushWasm();
        if (this.services.instances.has('gsp::Gpu')) this.services.gsp.vblank();
        if (this.gpu.gl) this.gpu.gl.endFrame();
        this.frame++;
      } catch (e) {
        if (!(e instanceof EMU.EmuError)) console.error(e);
        this.halt(`${e.message}\n${this.dumpRegs()}`);
      }
      perf.frame = EMU.now() - t0;
    }

    dumpRegs() {
      const c = this.cpu, r = c.r;
      const lines = [];
      for (let i = 0; i < 16; i += 4) {
        lines.push([0, 1, 2, 3].map((j) => `r${i + j}`.padStart(3) + '=' + hex(i + j === 15 ? c.curPC : r[i + j])).join('  '));
      }
      lines.push(`CPSR=${hex(c.getCPSR())} (${c.t ? 'Thumb' : 'ARM'})  thread=${this.kernel.current ? this.kernel.current.id : '-'}`);
      return lines.join('\n');
    }

    // Draw a screen straight from the host GPU onto a 2D canvas context, when its framebuffer is there. False:
    // use renderScreen.
    presentGL(screen, ctx) {
      const gl = this.gpu && this.gpu.gl;
      const gsp = gl && this.services.instances.get('gsp::Gpu');
      const info = gsp && gsp.screenInfo(screen);
      if (!info || !info.fb0) return false;
      return gl.present(this.gpu.toPhys(info.fb0), info.format, info.stride || 240 * EMU.FB_BPP[info.format & 7], screen === 0 ? 400 : 320, ctx);
    }

    // Draw a screen straight from the host GPU onto the renderer's own canvas shown on the page (see
    // GLRenderer.beginDisplay). False: use renderScreen.
    displayGL(screen, rect, smooth) {
      const gl = this.gpu && this.gpu.gl;
      const gsp = gl && this.services.instances.get('gsp::Gpu');
      const info = gsp && gsp.screenInfo(screen);
      if (!info || !info.fb0) return false;
      return gl.displaySurface(this.gpu.toPhys(info.fb0), info.format, info.stride || 240 * EMU.FB_BPP[info.format & 7], screen === 0 ? 400 : 320, rect, smooth);
    }

    // Render a screen (0 = top 400x240, 1 = bottom 320x240) into RGBA pixels. Returns false if nothing to show.
    // Pixels are written as little-endian 32-bit words (R, G, B, A bytes); conversions match EMU.decodePixel.
    renderScreen(screen, out) {
      const W = screen === 0 ? 400 : 320;
      const gsp = this.services && this.services.instances.get('gsp::Gpu');
      const info = gsp && gsp.screenInfo(screen);
      if (!info || !info.fb0) { out.fill(0); for (let i = 3; i < out.length; i += 4) out[i] = 255; return false; }
      const fmt = info.format & 7, bpp = EMU.FB_BPP[fmt];
      const stride = info.stride || 240 * bpp;
      const size = stride * (W - 1) + 240 * bpp;
      this.gpu.syncToMemoryVirt(info.fb0, size);
      if (!this.fbScratch || this.fbScratch.length < size) this.fbScratch = new Uint8Array(size);
      let data;
      try { data = this.mem.readInto(info.fb0, this.fbScratch.subarray(0, size)); }
      catch (e) { out.fill(0); return false; }
      const out32 = new Uint32Array(out.buffer, out.byteOffset, W * 240);
      for (let x = 0; x < W; x++) {
        const col = x * stride;
        for (let y = 0, o = col + 239 * bpp, p = x; y < 240; y++, o -= bpp, p += W) {
          let r, g, b;
          switch (fmt) {
            case 0: r = data[o + 3]; g = data[o + 2]; b = data[o + 1]; break;
            case 1: r = data[o + 2]; g = data[o + 1]; b = data[o]; break;
            case 2: { const v = data[o] | (data[o + 1] << 8); r = ((v >> 11) & 31) * 255 / 31 | 0; g = ((v >> 5) & 63) * 255 / 63 | 0; b = (v & 31) * 255 / 31 | 0; break; }
            case 3: { const v = data[o] | (data[o + 1] << 8); r = ((v >> 11) & 31) * 255 / 31 | 0; g = ((v >> 6) & 31) * 255 / 31 | 0; b = ((v >> 1) & 31) * 255 / 31 | 0; break; }
            case 4: { const v = data[o] | (data[o + 1] << 8); r = ((v >> 12) & 15) * 17; g = ((v >> 8) & 15) * 17; b = ((v >> 4) & 15) * 17; break; }
            default: r = g = b = 0;
          }
          out32[p] = (r | (g << 8) | (b << 16) | 0xFF000000) >>> 0;
        }
      }
      return true;
    }
  }

  // 3DS button bits as reported by HID.
  EMU.KEYS = {
    A: 1 << 0, B: 1 << 1, SELECT: 1 << 2, START: 1 << 3, DRIGHT: 1 << 4, DLEFT: 1 << 5, DUP: 1 << 6, DDOWN: 1 << 7,
    R: 1 << 8, L: 1 << 9, X: 1 << 10, Y: 1 << 11, ZL: 1 << 14, ZR: 1 << 15,
  };

  EMU.Emulator = Emulator;
})(typeof window !== 'undefined' ? window.EMU : globalThis.EMU);

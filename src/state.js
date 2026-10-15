// Save states: the whole emulated console (memory, CPU, threads, kernel objects, services, GPU and audio state)
// written to bytes and read back. The game's own files (RomFS, system files) are not stored: a state is loaded
// into the same game, and references to them are linked back to the copies already loaded.
(function (EMU) {
  'use strict';

  const MAGIC = 'P3DS-STATE', VERSION = 1;
  // Emulator fields that belong to the page or the current load, not to the console
  const EMU_SKIP = new Set(['onLog', 'onDebug', 'onHalt', 'onAudio', 'glRenderer', 'systemArchives', 'romfs', 'perf', 'input',
    'halted', 'haltReason', 'loaded', 'loadGeneration', 'name', 'savesDirty', 'traceFs', 'pendingReads', 'titleKey']);
  // Per-class fields rebuilt after loading (caches, compiled code, host GPU objects, callbacks)
  const SKIP = {
    CPU: ['blockTab', 'hot', 'svcHandler', 'wasmQueue'],
    Arena: ['wmem', 'buffer', 'u8'],
    Memory: ['pages16', 'pages32'],
    Gpu: ['gl', 'texCache', 'texBytes', 'fullViews', 'state', 'outMap'],
    ShaderUnit: ['compiled', 'compiledBySpec', 'decoded', 'onEmit'],
  };
  const VIEWS = { Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array, Int32Array, Uint32Array, Float32Array, Float64Array, DataView };

  const classes = () => EMU.classes || {};

  // ------------------------------------------------------------------ write
  function encode(emu) {
    const reg = classes(), ids = new Map(), table = [], buffers = [];
    const arena = emu.arena || null; // the WebAssembly memory holding the RAM: stored up to its highest allocation
    // Things that stay outside the state: the emulator itself and the game's files
    const ext = new Map(), extBuf = new Map();
    ext.set(emu, 'emu');
    if (emu.romfs) { ext.set(emu.romfs, 'romfs'); if (emu.romfs.buffer) extBuf.set(emu.romfs.buffer, 'romfs'); }
    for (const [id, bytes] of emu.systemArchives) { ext.set(bytes, 'sys:' + id); extBuf.set(bytes.buffer, 'sys:' + id); }

    const val = (v) => {
      switch (typeof v) {
        case 'number': return Number.isFinite(v) ? v : { n: String(v) };
        case 'string': case 'boolean': return v;
        case 'undefined': return { u: 1 };
        case 'bigint': return { g: String(v) };
        case 'function': return { f: 1 };
        case 'symbol': return { u: 1 };
      }
      if (v === null) return null;
      return { $: ref(v) };
    };
    const ref = (o) => {
      let id = ids.get(o);
      if (id !== undefined) return id;
      id = table.length; ids.set(o, id); table.push(null);
      table[id] = entry(o);
      return id;
    };
    const entry = (o) => {
      if (ext.has(o)) return { t: 'x', k: ext.get(o) };
      if (arena && o === arena.buffer) { buffers.push(new Uint8Array(o, 0, arena.top)); return { t: 'b', i: buffers.length - 1, n: o.byteLength, arena: 1 }; }
      if (o instanceof ArrayBuffer) { buffers.push(new Uint8Array(o)); return { t: 'b', i: buffers.length - 1, n: o.byteLength }; }
      if (ArrayBuffer.isView(o)) {
        const ty = o.constructor.name;
        if (!VIEWS[ty]) throw new Error(`save state: unsupported view ${ty}`);
        const k = extBuf.get(o.buffer);
        return { t: 'v', ty, b: k ? { $: ref(extKeyBuffer(k)) } : { $: ref(o.buffer) }, o: o.byteOffset, l: o instanceof DataView ? o.byteLength : o.length };
      }
      if (o instanceof WeakMap || o instanceof WeakSet) return { t: 'w', s: o instanceof WeakSet };
      if (o instanceof Map) { const e = { t: 'm', v: [] }; for (const [k, x] of o) e.v.push([val(k), val(x)]); return e; }
      if (o instanceof Set) { const e = { t: 's', v: [] }; for (const x of o) e.v.push(val(x)); return e; }
      if (Array.isArray(o)) {
        let used = 0;
        for (let i = 0; i < o.length; i++) if (o[i] != null) used++;
        if (o.length > 1024 && used < o.length / 4) { // mostly empty (page tables): only the filled slots
          const e = { t: 'A', n: o.length, e: [] };
          for (let i = 0; i < o.length; i++) if (o[i] != null) e.e.push([i, val(o[i])]);
          return e;
        }
        const e = { t: 'a', v: new Array(o.length) };
        for (let i = 0; i < o.length; i++) e.v[i] = val(o[i]);
        return e;
      }
      const proto = Object.getPrototypeOf(o);
      let c;
      if (proto !== Object.prototype && proto !== null) {
        c = proto.constructor && proto.constructor.name;
        if (!c || reg[c] !== proto.constructor) throw new Error(`save state: cannot store a ${c || 'value'} object`);
      }
      const skip = c && SKIP[c], p = {};
      for (const k of Object.keys(o)) if (!skip || !skip.includes(k)) p[k] = val(o[k]);
      return c ? { t: 'o', c, p } : { t: 'o', p };
    };
    // Buffers of the game's files are referenced through a stand-in object that names them
    const extBufObjs = new Map();
    const extKeyBuffer = (k) => {
      let o = extBufObjs.get(k);
      if (!o) { o = { extBuffer: k }; extBufObjs.set(k, o); ext.set(o, 'buf:' + k); }
      return o;
    };

    const root = {};
    for (const k of Object.keys(emu)) if (!EMU_SKIP.has(k)) root[k] = val(emu[k]);
    return { root, table, buffers };
  }

  // Header (magic, version, JSON length) + JSON + raw buffers, gzip-compressed where the browser can
  EMU.saveState = async function (emu, meta = {}) {
    if (emu.pendingReads) throw new Error('the game is reading its files; try again in a moment');
    if (emu.gpu && emu.gpu.gl) emu.gpu.gl.syncToMemory(0, 0xFFFFFFFF); // pictures still only on the graphics card
    const { root, table, buffers } = encode(emu);
    const json = new TextEncoder().encode(JSON.stringify({
      magic: MAGIC, version: VERSION, meta: Object.assign({ game: emu.titleKey, title: emu.title, frame: emu.frame, time: Date.now() }, meta),
      root, table, sizes: buffers.map((b) => b.length),
    }));
    const head = new Uint8Array(8); new DataView(head.buffer).setUint32(0, VERSION, true); new DataView(head.buffer).setUint32(4, json.length, true);
    const raw = new Blob([head, json, ...buffers]); // copies the bytes now: the game can keep running
    if (typeof CompressionStream === 'undefined') return raw;
    return new Response(raw.stream().pipeThrough(new CompressionStream('gzip'))).blob();
  };

  async function unpack(blob) {
    let bytes = new Uint8Array(await blob.arrayBuffer());
    if (bytes[0] === 0x1F && bytes[1] === 0x8B) {
      if (typeof DecompressionStream === 'undefined') throw new Error('this browser cannot read compressed save states');
      bytes = new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
    }
    const dv = new DataView(bytes.buffer, bytes.byteOffset);
    const len = dv.getUint32(4, true);
    const doc = JSON.parse(new TextDecoder().decode(bytes.subarray(8, 8 + len)));
    if (doc.magic !== MAGIC) throw new Error('not a Pica3DS save state');
    if (doc.version > VERSION) throw new Error('this save state is from a newer version of Pica3DS');
    const bufs = [];
    let at = 8 + len;
    for (const n of doc.sizes) { bufs.push(bytes.slice(at, at + n).buffer); at += n; }
    return { doc, bufs };
  }

  EMU.readStateInfo = async function (blob) { return (await unpack(blob)).doc.meta; };

  // ------------------------------------------------------------------ read
  EMU.loadState = async function (emu, blob) {
    const { doc, bufs } = await unpack(blob);
    if (doc.meta.game && emu.titleKey && doc.meta.game !== emu.titleKey) throw new Error(`this save state is for another game (${doc.meta.title || doc.meta.game})`);
    const reg = classes(), table = doc.table, objs = new Array(table.length);
    let arenaMem = null;
    const extern = (k) => {
      if (k === 'emu') return emu;
      if (k === 'romfs') return emu.romfs;
      if (k.startsWith('sys:')) return emu.systemArchives.get(k.slice(4));
      if (k.startsWith('buf:')) { const o = extern(k.slice(4)); return o && o.buffer; }
      return undefined;
    };
    // Objects first (without contents), so references in any order resolve
    table.forEach((e, i) => {
      switch (e.t) {
        case 'x': { const o = extern(e.k); if (o === undefined) throw new Error(`save state needs ${e.k}, which is not loaded`); objs[i] = o; break; }
        case 'b':
          if (e.arena) { // a fresh WebAssembly memory of the same size, with the saved part copied in
            try { arenaMem = EMU.Arena.newMemory(e.n); } catch (err) { throw new Error('not enough memory on this device to load this state'); }
            new Uint8Array(arenaMem.buffer).set(new Uint8Array(bufs[e.i]));
            objs[i] = arenaMem.buffer;
          } else objs[i] = bufs[e.i];
          break;
        case 'w': objs[i] = e.s ? new WeakSet() : new WeakMap(); break;
        case 'm': objs[i] = new Map(); break;
        case 's': objs[i] = new Set(); break;
        case 'a': case 'A': objs[i] = []; break;
        case 'o': {
          const cls = e.c ? reg[e.c] : null;
          if (e.c && !cls) throw new Error(`save state: unknown ${e.c}`);
          objs[i] = Object.create(cls ? cls.prototype : Object.prototype);
          break;
        }
      }
    });
    table.forEach((e, i) => {
      if (e.t !== 'v') return;
      const buf = objs[e.b.$], V = VIEWS[e.ty];
      objs[i] = e.ty === 'DataView' ? new DataView(buf, e.o, e.l) : new V(buf, e.o, e.l);
    });
    const val = (v) => {
      if (v === null || typeof v !== 'object') return v;
      if ('$' in v) return objs[v.$];
      if ('n' in v) return Number(v.n);
      if ('g' in v) return BigInt(v.g);
      return undefined; // undefined, functions
    };
    table.forEach((e, i) => {
      const o = objs[i];
      switch (e.t) {
        case 'm': for (const [k, x] of e.v) o.set(val(k), val(x)); break;
        case 's': for (const x of e.v) o.add(val(x)); break;
        case 'a': o.length = e.v.length; for (let j = 0; j < e.v.length; j++) o[j] = val(e.v[j]); break;
        case 'A': o.length = e.n; o.fill(null); for (const [j, x] of e.e) o[j] = val(x); break;
        case 'o': for (const k in e.p) o[k] = val(e.p[k]); break;
      }
    });

    // Swap the console in, then rebuild what was left out
    for (const k of Object.keys(doc.root)) emu[k] = val(doc.root[k]);
    emu.loadGeneration = (emu.loadGeneration || 0) + 1; // reads still in flight for the old state are dropped
    emu.pendingReads = 0;
    emu.halted = false; emu.haltReason = null; emu.loaded = true;
    const mem = emu.mem, cpu = emu.cpu, gpu = emu.gpu, kernel = emu.kernel;
    if (emu.arena && arenaMem) emu.arena.attach(arenaMem);
    mem.pages16 = new Array(mem.pages.length).fill(null);
    mem.pages32 = new Array(mem.pages.length).fill(null);
    for (let i = 0; i < mem.pages.length; i++) if (mem.pages[i]) mem._setPage(i, mem.pages[i]);
    cpu.resetJit();
    cpu.svcHandler = (n) => kernel.svc(n);
    for (const u of [gpu.vs, gpu.gs]) u.resetCompiled();
    gpu.gs.onEmit = (unit) => gpu.gsEmit(unit);
    gpu.texCache = new Map(); gpu.texBytes = 0; gpu.fullViews = new WeakMap(); gpu.state = null; gpu.outMap = null;
    if (gpu.outMapKey) gpu.outMapKey.fill(-1);
    gpu.lutDirty = true; gpu.fogDirty = true; gpu.lutRows = 0xFFFFFF;
    gpu.gl = emu.glRenderer || null;
    if (gpu.gl) gpu.gl.attach(gpu);
    return doc.meta;
  };
})(typeof window !== 'undefined' ? (window.EMU = window.EMU || {}) : (globalThis.EMU = globalThis.EMU || {}));

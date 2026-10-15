// Browser front-end: file loading, frame loop, rendering, sound, keyboard/mouse/gamepad input and the UI.
(function () {
  'use strict';

  const EMU = window.EMU;
  const K = EMU.KEYS;
  const $ = (id) => document.getElementById(id);

  const topCanvas = $('top'), bottomCanvas = $('bottom');
  const topCtx = topCanvas.getContext('2d', { alpha: false }), bottomCtx = bottomCanvas.getContext('2d', { alpha: false });
  const topImg = topCtx.createImageData(400, 240), bottomImg = bottomCtx.createImageData(320, 240);
  const logEl = $('log');

  // Settings kept in this browser (wrapped: storage can be unavailable)
  const store = {
    get(key, fallback) { try { const v = localStorage.getItem('emu3ds-' + key); return v === null ? fallback : v; } catch (e) { return fallback; } },
    set(key, value) { try { localStorage.setItem('emu3ds-' + key, String(value)); } catch (e) { /* storage unavailable */ } },
  };

  // ------------------------------------------------------------------ log and toasts
  let pendingDebug = '', unseenErrors = 0;
  function logLine(text, cls = 'info') {
    const div = document.createElement('div');
    div.className = cls;
    div.textContent = text;
    logEl.appendChild(div);
    while (logEl.childNodes.length > 800) logEl.removeChild(logEl.firstChild);
    logEl.scrollTop = logEl.scrollHeight;
    if (cls === 'err' && $('pane-log').hidden) {
      unseenErrors++;
      $('log-badge').textContent = unseenErrors;
      $('log-badge').hidden = false;
    }
  }

  function toast(text, isError = false, ms = 3200) {
    const el = document.createElement('div');
    el.className = 'toast' + (isError ? ' err' : '');
    el.textContent = text;
    $('toasts').appendChild(el);
    setTimeout(() => el.remove(), ms);
  }

  // ------------------------------------------------------------------ sound
  // Emulated audio (stereo, 32728 Hz) is collected while frames run and, once per animation frame, scheduled
  // on the audio clock as an AudioBuffer that starts exactly where the previous one ends. The browser's audio
  // thread plays scheduled buffers on time however busy this page is (and this works on pages opened from a
  // file, where audio worklets are not allowed).
  //
  // When emulation runs slower than real time there is less than a second of sound per second. Instead of
  // gaps, the sound is time-stretched (WSOLA: overlapping windowed grains, each placed where it best matches
  // the previous one) so it plays continuously at the right pitch. At full speed the stretcher passes the
  // input through unchanged.
  class TimeStretcher {
    constructor() {
      this.N = 1024;          // grain length (31 ms)
      this.H = 512;           // output hop (half a grain: Hann windows at this overlap sum to 1)
      this.tol = 256;         // how far a grain may move to line up with the previous one
      this.win = new Float32Array(this.N).map((_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / this.N));
      this.L = new Float32Array(1 << 16); this.R = new Float32Array(1 << 16);
      this.len = 0;           // input samples held
      this.pos = 0;           // nominal input position of the next grain
      this.natural = -1;      // where the previous grain would naturally continue (-1: none yet)
      this.tailL = new Float32Array(this.H); this.tailR = new Float32Array(this.H);
    }

    clear() { this.len = 0; this.pos = 0; this.natural = -1; this.tailL.fill(0); this.tailR.fill(0); }

    write(L, R) {
      if (this.len + L.length > this.L.length) { // grow
        const n = Math.max(this.L.length * 2, this.len + L.length);
        const nl = new Float32Array(n), nr = new Float32Array(n);
        nl.set(this.L.subarray(0, this.len)); nr.set(this.R.subarray(0, this.len));
        this.L = nl; this.R = nr;
      }
      this.L.set(L, this.len); this.R.set(R, this.len);
      this.len += L.length;
    }

    // Input samples not yet played (approximately)
    pending() { return Math.max(0, this.len - this.pos); }

    // Best start for the next grain near `want`: the offset whose samples look most like the natural
    // continuation of the previous grain (cross-correlation on a decimated mono mix)
    align(want) {
      if (this.natural < 0 || want === this.natural) return want;
      const { L, R, tol } = this, span = this.H, nat = this.natural;
      let best = want, bestScore = -Infinity;
      for (let d = -tol; d <= tol; d += 2) {
        const s = want + d;
        if (s < 0 || s + this.N > this.len) continue;
        let score = 0;
        for (let i = 0; i < span; i += 4) score += (L[s + i] + R[s + i]) * (L[nat + i] + R[nat + i]);
        if (score > bestScore) { bestScore = score; best = s; }
      }
      return best;
    }

    // Produce output at `stretch` (output time / input time); returns [L, R] or null if not enough input
    read(stretch) {
      const { N, H } = this, outL = [], outR = [];
      let produced = 0;
      for (;;) {
        const want = Math.round(this.pos);
        if (want + N + this.tol > this.len) break;
        const s = stretch === 1 && this.natural === want ? want : this.align(want);
        const gl = new Float32Array(H), gr = new Float32Array(H);
        for (let i = 0; i < H; i++) {
          gl[i] = this.tailL[i] + this.L[s + i] * this.win[i];
          gr[i] = this.tailR[i] + this.R[s + i] * this.win[i];
        }
        for (let i = 0; i < H; i++) {
          this.tailL[i] = this.L[s + H + i] * this.win[H + i];
          this.tailR[i] = this.R[s + H + i] * this.win[H + i];
        }
        outL.push(gl); outR.push(gr); produced += H;
        this.natural = s + H;
        this.pos += H / stretch;
      }
      // Drop input that no grain can use any more
      const keep = Math.max(0, Math.min(Math.floor(this.pos), this.natural < 0 ? Infinity : this.natural) - this.tol);
      if (keep > 0) {
        this.L.copyWithin(0, keep, this.len); this.R.copyWithin(0, keep, this.len);
        this.len -= keep; this.pos -= keep; if (this.natural >= 0) this.natural -= keep;
      }
      if (!produced) return null;
      const L = new Float32Array(produced), R = new Float32Array(produced);
      outL.forEach((g, i) => L.set(g, i * H)); outR.forEach((g, i) => R.set(g, i * H));
      return [L, R];
    }
  }

  const audio = {
    ctx: null, gain: null, failed: false,
    stretcher: new TimeStretcher(), stretch: 1, next: 0,
    TARGET: 0.1,   // seconds of sound to keep scheduled ahead
    enabled: store.get('audio', '1') !== '0',
    volume: Math.max(0, Math.min(100, parseInt(store.get('volume', '80'), 10) || 0)),
    muted: store.get('muted', '0') === '1',

    // Must run from a user gesture the first time (browsers start audio suspended)
    unlock() {
      if (this.failed || !this.enabled) return;
      if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) { this.fail('this browser has no Web Audio'); return; }
      try { this.ctx = new Ctx({ sampleRate: EMU.AUDIO_RATE, latencyHint: 'interactive' }); }
      catch (e) { try { this.ctx = new Ctx({ latencyHint: 'interactive' }); } catch (e2) { this.fail(e2.message); return; } }
      this.gain = this.ctx.createGain();
      this.gain.connect(this.ctx.destination);
      this.applyVolume();
    },
    fail(msg) { this.failed = true; logLine(`Sound is unavailable: ${msg}`, 'err'); },

    push(L, R) {
      if (!this.ctx || !this.enabled || this.ctx.state !== 'running') return;
      this.stretcher.write(L, R);
    },

    // Once per animation frame: stretch what was produced and schedule it after what is already queued
    flush() {
      const ctx = this.ctx;
      if (!ctx || ctx.state !== 'running') return;
      const now = ctx.currentTime, rate = EMU.AUDIO_RATE;
      if (this.next < now + 0.005) { // ran dry (or first sound): build a cushion, then start a little ahead
        if (this.stretcher.pending() < rate * this.TARGET * 0.6) return;
        this.next = now + 0.02;
        this.stretch = 1;
      }
      // Seconds of sound already scheduled plus what is waiting in the stretcher
      const ahead = this.next - now + this.stretcher.pending() / rate;
      // Speed control: stretch when running low (emulation slower than real time), play slightly faster when
      // too much has built up, and leave the sound untouched near the target
      let want = 1;
      if (ahead < this.TARGET * 0.75) want = Math.min(3, 1 + (this.TARGET - ahead) / this.TARGET * 2.5);
      else if (ahead > this.TARGET * 2.5) want = 0.85;
      else if (ahead > this.TARGET * 1.6) want = 0.95;
      this.stretch = want === 1 && Math.abs(this.stretch - 1) < 0.03 ? 1 : this.stretch * 0.7 + want * 0.3;
      if (ahead > 0.5) { this.stretcher.clear(); this.next = now + 0.03; return; } // far behind: resynchronise
      const out = this.stretcher.read(this.stretch);
      if (!out) return;
      const buf = ctx.createBuffer(2, out[0].length, rate);
      buf.copyToChannel(out[0], 0); buf.copyToChannel(out[1], 1);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(this.gain);
      src.start(this.next);
      this.next += out[0].length / rate;
    },
    clear() { this.stretcher.clear(); this.next = 0; this.stretch = 1; },
    applyVolume() {
      if (this.gain) this.gain.gain.value = this.muted || !this.enabled ? 0 : Math.pow(this.volume / 100, 2);
      $('vol-waves').toggleAttribute('hidden', this.muted || this.volume === 0);
      $('vol-x').toggleAttribute('hidden', !(this.muted || this.volume === 0));
      $('volume').value = this.volume;
    },
  };

  // ------------------------------------------------------------------ emulator
  const emu = new EMU.Emulator({
    onLog: (m) => logLine(m, 'info'),
    onDebug: (s) => {
      pendingDebug += s;
      const lines = pendingDebug.split('\n');
      pendingDebug = lines.pop();
      for (const l of lines) logLine(l, 'dbg');
      if (pendingDebug.length > 200) { logLine(pendingDebug, 'dbg'); pendingDebug = ''; }
    },
    onHalt: (reason) => {
      const crashed = /fault|undefined|unsupported|Fatal|svcBreak/i.test(reason);
      logLine(reason, crashed ? 'err' : 'info');
      const miss = emu.missingSystemArchive;
      const text = miss
        ? `This game may need the system file ${miss.id.toUpperCase()}${miss.name ? ` (${miss.name})` : ''} from your 3DS (an empty stand-in was used). Dump and decrypt it with GodMode9, add it under Settings → System files, then restart the game.`
        : crashed ? 'The game hit something this emulator does not support yet.' : reason.split('\n')[0];
      showMessage(crashed ? 'Emulation stopped' : 'Game finished', text, crashed ? reason : null);
      setStatus('halted', crashed ? 'Stopped' : 'Finished');
      $('pause').disabled = true;
      audio.clear();
      updateWakeLock();
    },
  });
  emu.onAudio = (L, R) => audio.push(L, R);

  // ------------------------------------------------------------------ UI state
  let fitQueued = false; // a screen fit is waiting for the next animation frame
  let romBytes = null, romName = '', romFs = null; // romFs: RomFS read on demand for large games
  let paused = false;
  let layout = store.get('layout', 'stacked'); // stacked, side, top-only

  function setStatus(kind, text) {
    $('status').className = 'pill ' + kind;
    $('status-text').textContent = text;
  }

  function showWelcome() {
    $('welcome').hidden = false; $('message').hidden = true; $('overlay').hidden = false;
  }

  function showMessage(title, text, detail) {
    $('ov-title').textContent = title;
    $('ov-text').textContent = text;
    $('ov-detail').hidden = !detail;
    $('ov-detail').textContent = detail || '';
    $('ov-reset').hidden = !romBytes;
    $('welcome').hidden = true; $('message').hidden = false; $('overlay').hidden = false;
  }

  function setPaused(p) {
    if (!emu.loaded || emu.halted) return;
    paused = p;
    $('pause').title = paused ? 'Resume (P)' : 'Pause (P)';
    $('pause').setAttribute('aria-label', paused ? 'Resume' : 'Pause');
    $('pause-icon').innerHTML = paused ? '<path d="M7 4.5v15l13-7.5z"/>' : '<rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/>';
    setStatus(paused ? 'paused' : 'running', paused ? 'Paused' : 'Running');
    lastTime = performance.now(); acc = 0;
    if (paused) audio.clear();
    updateWakeLock();
  }

  // Keep the screen on while a game runs (phones dim and lock otherwise)
  let wakeLock = null, wakeBusy = false;
  async function updateWakeLock() {
    if (!navigator.wakeLock || wakeBusy) return;
    const want = emu.loaded && !emu.halted && !paused && document.visibilityState === 'visible';
    if (want === !!wakeLock) return;
    wakeBusy = true;
    try {
      if (want) { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => { wakeLock = null; }); }
      else { const w = wakeLock; wakeLock = null; await w.release(); }
    } catch (e) { wakeLock = null; } // refused (battery saver, no permission): not important
    wakeBusy = false;
  }

  // Renderer: the host graphics card through WebGL 2 (default when available) or the software rasterizer
  // Its canvas is laid over both screens and shows them directly (see present); without WebGL the screens are
  // drawn on their own 2D canvases instead
  let glRenderer = null, glError = '';
  const glCanvas = document.createElement('canvas');
  glCanvas.className = 'gl-screens';
  try { glRenderer = new EMU.GLRenderer(glCanvas, { display: true }); } catch (e) { glError = e.message; }
  let display = glRenderer ? { w: 1, h: 1, rects: [null, null] } : null; // canvas size and screen rects, device pixels
  if (display) $('device').prepend(glCanvas);
  glCanvas.addEventListener('webglcontextlost', () => {
    display = null; glCanvas.remove();
    logLine('The graphics card was reset by the browser (this happens on phones low on memory). Restart the game.', 'err');
  });
  let useGL = !!glRenderer && store.get('renderer', 'webgl') !== 'software';
  function applyRenderer() { emu.setRenderer(useGL && glRenderer ? glRenderer : null); }

  // Compilers for ARM code, shaders and rasterization (on by default; off = interpreters, same output, slower)
  let useJit = store.get('jit', '1') !== '0';
  function applyJit() {
    if (!emu.loaded) return;
    emu.cpu.jit = useJit;
    emu.gpu.vs.jit = useJit;
    emu.gpu.rasterJit = useJit;
    emu.gpu.state = null; // rebuild the render state with the chosen rasterizer
  }

  // Background idle skipping in the scheduler (see Kernel.idleSkip)
  let idleSkip = store.get('idle-skip', '1') !== '0';
  function applyIdleSkip() { if (emu.loaded) emu.kernel.idleSkip = idleSkip; }

  function start(bytes, name, romfs = null) {
    romBytes = bytes; romName = name; romFs = romfs;
    audio.clear();
    try {
      applyRenderer();
      emu.load(bytes, name, romfs);
      applyJit();
      applyIdleSkip();
    } catch (e) {
      logLine(e.message, 'err');
      showMessage('Could not load this file', e.message);
      setStatus('halted', 'Load failed');
      return;
    }
    $('overlay').hidden = true;
    $('game-title').textContent = emu.title || name.replace(/\.[^.]+$/, '');
    document.title = `${$('game-title').textContent} · Pica3DS`;
    $('pause').disabled = false;
    $('reset').disabled = false;
    paused = true; setPaused(false);
    // The game's own saves from earlier sessions go back in before it runs its first frame
    const gen = emu.loadGeneration, key = emu.titleKey;
    paused = true;
    loadShaderCache(key, gen);
    dbGet('saves', key).then((saves) => {
      if (emu.loadGeneration !== gen) return;
      if (saves) { emu.setSaves(saves); logLine('Restored this game\'s saves from the browser.'); }
      paused = true; setPaused(false);
      updateStates();
    });
  }

  function loadFile(file) {
    audio.unlock();
    setStatus('', `Loading ${file.name}…`);
    // Large games: only the headers and code are read now; game data is read from the file as it is needed
    EMU.readGameFile(file).then(({ bytes, romfs }) => {
      if (romfs) logLine(`${file.name} is ${(file.size / 1073741824).toFixed(1)} GB: game data is read from the file as needed.`);
      start(bytes, file.name, romfs);
    }).catch((e) => { showMessage('Could not read this file', `${file.name}: ${e.message}`); setStatus('halted', 'Load failed'); });
  }

  function runDemo() {
    audio.unlock();
    const bin = atob(EMU.DEMO_ROM_B64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    start(bytes, 'demo.3dsx');
  }

  if (/iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)) $('file').removeAttribute('accept');
  $('file').addEventListener('change', (e) => { if (e.target.files[0]) loadFile(e.target.files[0]); e.target.value = ''; });
  $('ov-demo').addEventListener('click', runDemo);
  $('reset').addEventListener('click', () => { audio.unlock(); if (romBytes) start(romBytes, romName, romFs); });
  $('ov-reset').addEventListener('click', () => { audio.unlock(); if (romBytes) start(romBytes, romName, romFs); });
  $('ov-log').addEventListener('click', () => { showPanel(true); selectTab('log'); });
  $('pause').addEventListener('click', () => { audio.unlock(); setPaused(!paused); });

  // ------------------------------------------------------------------ system files (kept in IndexedDB)
  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('emu3ds', 3);
      req.onupgradeneeded = () => {
        for (const s of ['sysdata', 'saves', 'states', 'shaders']) if (!req.result.objectStoreNames.contains(s)) req.result.createObjectStore(s);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  async function dbDo(mode, fn, storeName = 'sysdata') {
    try {
      const db = await openDb();
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, mode);
        fn(tx.objectStore(storeName));
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => reject(tx.error);
      });
    } catch (e) { return null; } // storage unavailable: files last for this session only
  }

  async function dbGet(storeName, key) {
    let out;
    await dbDo('readonly', (s) => { const r = s.get(key); r.onsuccess = () => { out = r.result; }; }, storeName);
    return out;
  }
  const dbPut = (storeName, key, value) => dbDo('readwrite', (s) => s.put(value, key), storeName);
  const dbDelete = (storeName, key) => dbDo('readwrite', (s) => s.delete(key), storeName);

  // ------------------------------------------------------------------ game saves and save states
  // The game's saves are written to the browser shortly after the game changes them
  let savesTimer = 0;
  function flushSaves() {
    if (!emu.loaded || !emu.savesDirty) return;
    emu.savesDirty = false;
    dbPut('saves', emu.titleKey, emu.getSaves());
    $('saves-delete').disabled = false;
  }
  setInterval(() => { if (emu.savesDirty && performance.now() - savesTimer > 1500) { savesTimer = performance.now(); flushSaves(); } }, 500);
  window.addEventListener('pagehide', flushSaves);
  document.addEventListener('visibilitychange', () => { if (document.hidden) flushSaves(); });

  // Shader cache: the GPU shaders each game uses are kept, and built in the background when it starts again
  let shaderList = [], shaderKey = null, shaderSaved = 0;
  function loadShaderCache(key, gen) {
    shaderList = []; shaderKey = key; shaderSaved = 0;
    const cur = emu.gpu && emu.gpu.gl;
    if (cur) { cur.takeShaderPairs(); cur.knownPairs.clear(); } // what is recorded from now on is this game's
    dbGet('shaders', key).then((list) => {
      if (emu.loadGeneration !== gen || !Array.isArray(list)) return;
      shaderList = list.concat(shaderList); shaderSaved = list.length;
      const gl = emu.gpu && emu.gpu.gl;
      if (gl && list.length) gl.warmShaders(list, (n) => logLine(`Shader cache: built ${n} shaders for this game ahead of time.`));
    });
  }
  setInterval(() => {
    const gl = emu.loaded && emu.gpu && emu.gpu.gl;
    if (!gl || emu.titleKey !== shaderKey) return;
    const fresh = gl.takeShaderPairs();
    if (fresh.length) shaderList.push(...fresh);
    if (shaderList.length > 4000) shaderList = shaderList.slice(-4000);
    if (shaderList.length !== shaderSaved) { shaderSaved = shaderList.length; dbPut('shaders', shaderKey, shaderList.slice()); }
  }, 8000);

  const SLOTS = 4;
  const stateKey = (slot) => `${emu.titleKey}#${slot}`;
  function download(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
  }
  const gameFileName = () => ($('game-title').textContent || 'game').replace(/[\\/:*?"<>|]+/g, '').trim() || 'game';

  let statesGen = 0;
  async function updateStates() {
    const gen = ++statesGen, ready = emu.loaded && !emu.halted;
    const metas = [];
    for (let i = 1; i <= SLOTS; i++) metas.push(ready ? await dbGet('states', stateKey(i) + ':meta') : null);
    const hasSaves = emu.loaded && !!(await dbGet('saves', emu.titleKey));
    if (gen !== statesGen) return; // a newer refresh is on its way
    const box = $('state-slots');
    box.textContent = '';
    metas.forEach((meta, k) => {
      const i = k + 1, row = document.createElement('div');
      row.className = 'slot';
      row.innerHTML = `<b>Slot ${i}</b><span></span><button class="btn small" data-a="save">Save</button><button class="btn small" data-a="load">Load</button>`;
      row.querySelector('span').textContent = meta ? new Date(meta.time).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : 'Empty';
      row.querySelector('[data-a=save]').disabled = !ready;
      row.querySelector('[data-a=load]').disabled = !ready || !meta;
      row.querySelector('[data-a=save]').addEventListener('click', () => saveSlot(i));
      row.querySelector('[data-a=load]').addEventListener('click', () => loadSlot(i));
      box.appendChild(row);
    });
    $('state-export').disabled = !ready;
    $('saves-export').disabled = !emu.loaded;
    $('saves-delete').disabled = !hasSaves;
  }

  // Snapshot between frames (saveState copies everything before it returns to the loop)
  async function makeState() {
    for (let tries = 0; emu.pendingReads && tries < 50; tries++) await new Promise((r) => setTimeout(r, 100));
    return EMU.saveState(emu);
  }
  async function saveSlot(i) {
    if (!emu.loaded || emu.halted) return;
    try {
      const blob = await makeState(), meta = { time: Date.now(), frame: emu.frame };
      await dbPut('states', stateKey(i), blob);
      await dbPut('states', stateKey(i) + ':meta', meta);
      toast(`Saved state to slot ${i} (${(blob.size / 1048576).toFixed(1)} MB)`);
    } catch (e) { toast(`Could not save the state: ${e.message}`, true, 5000); logLine(`Save state: ${e.message}`, 'err'); }
    updateStates();
  }
  async function applyState(blob, label) {
    try {
      flushSaves();
      await EMU.loadState(emu, blob);
      audio.clear();
      emu.savesDirty = false;
      lastTime = performance.now(); acc = 0;
      if (paused) present();
      toast(`Loaded ${label}`);
    } catch (e) { toast(`Could not load the state: ${e.message}`, true, 6000); logLine(`Load state: ${e.message}`, 'err'); }
  }
  async function loadSlot(i) {
    if (!emu.loaded) return;
    const blob = await dbGet('states', stateKey(i));
    if (!blob) { toast(`Slot ${i} is empty`); return; }
    applyState(blob, `slot ${i}`);
  }
  $('state-export').addEventListener('click', async () => {
    try { download(await makeState(), `${gameFileName()}.p3ds`); }
    catch (e) { toast(`Could not save the state: ${e.message}`, true, 5000); }
  });
  $('state-import').addEventListener('change', (e) => {
    const f = e.target.files[0]; e.target.value = '';
    if (!f) return;
    if (!emu.loaded) { toast('Open the game first, then load its state', true); return; }
    applyState(f, f.name);
  });

  // Game saves as a file: JSON with each file's bytes in base64
  const toB64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
  const fromB64 = (b) => { const s = atob(b), u8 = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i); return u8; };
  $('saves-export').addEventListener('click', () => {
    const saves = emu.getSaves(), out = { pica3dsSaves: 1, game: emu.titleKey, title: emu.title, volumes: {} };
    for (const k of Object.keys(saves)) out.volumes[k] = { dirs: saves[k].dirs, files: saves[k].files.map(([p, b]) => [p, toB64(b)]) };
    download(new Blob([JSON.stringify(out)], { type: 'application/json' }), `${gameFileName()} saves.json`);
  });
  $('saves-import').addEventListener('change', async (e) => {
    const f = e.target.files[0]; e.target.value = '';
    if (!f) return;
    if (!emu.loaded) { toast('Open the game first, then restore its saves', true); return; }
    try {
      const doc = JSON.parse(await f.text());
      if (!doc.pica3dsSaves) throw new Error('not a Pica3DS saves file');
      if (doc.game && doc.game !== emu.titleKey) throw new Error(`these saves are for another game (${doc.title || doc.game})`);
      const saves = {};
      for (const k of Object.keys(doc.volumes)) saves[k] = { dirs: doc.volumes[k].dirs, files: doc.volumes[k].files.map(([p, b]) => [p, fromB64(b)]) };
      emu.savesDirty = false;
      await dbPut('saves', emu.titleKey, saves);
      toast('Saves restored. Restarting the game to use them…');
      start(romBytes, romName, romFs);
    } catch (err) { toast(`Could not restore saves: ${err.message}`, true, 5000); }
  });
  $('saves-delete').addEventListener('click', async () => {
    if (!emu.loaded || !confirm("Delete this game's saves from the browser? Download them first if you want to keep them.")) return;
    emu.savesDirty = false;
    await dbDelete('saves', emu.titleKey);
    toast('Saves deleted. Restarting the game…');
    start(romBytes, romName, romFs);
  });
  updateStates();

  function updateSysStatus() {
    const names = [...emu.systemArchives.keys()].map((id) => EMU.SYSTEM_ARCHIVE_NAMES[id] || id.toUpperCase());
    $('sys-status').textContent = names.length ? `Added: ${names.join(', ')}` : 'None added (built-in stand-ins are used).';
    $('sys-clear').disabled = !names.length;
  }

  // Adds the bytes if they are a decrypted system data file.
  function tryAddSystemFile(bytes, name) {
    let info;
    try { info = EMU.parseSystemArchive(bytes); } catch (e) { return { ok: false, error: e.message }; }
    if (info.executable) return { ok: false };
    emu.addSystemArchive(info.titleId, info.romfs);
    dbDo('readwrite', (s) => s.put(info.romfs, info.titleId));
    logLine(`Added system file ${info.titleId.toUpperCase()}${info.name ? ` (${info.name})` : ''} from ${name}`);
    return { ok: true };
  }

  async function addSystemFiles(files) {
    let added = 0;
    for (const f of files) {
      const r = tryAddSystemFile(new Uint8Array(await f.arrayBuffer()), f.name);
      if (r.ok) added++;
      else { logLine(`${f.name}: ${r.error || 'not a system data file'}`, 'err'); toast(`${f.name}: ${r.error || 'not a system data file'}`, true, 5000); }
    }
    updateSysStatus();
    if (added) toast(romBytes ? `Added ${added} system file(s). Restart the game to use them.` : `Added ${added} system file(s).`);
  }

  $('sysfiles').addEventListener('change', (e) => { addSystemFiles([...e.target.files]); e.target.value = ''; });
  $('sys-clear').addEventListener('click', () => {
    emu.systemArchives.clear();
    dbDo('readwrite', (s) => s.clear());
    updateSysStatus();
    toast('Removed all system files.');
  });
  dbDo('readonly', (s) => {
    const req = s.openCursor();
    req.onsuccess = () => {
      const c = req.result;
      if (!c) { updateSysStatus(); return; }
      emu.addSystemArchive(String(c.key), new Uint8Array(c.value));
      c.continue();
    };
  });
  updateSysStatus();

  // ------------------------------------------------------------------ panel and tabs
  const TABS = ['perf', 'settings', 'states', 'controls', 'log'];
  function selectTab(name) {
    for (const t of TABS) {
      $('tab-' + t).setAttribute('aria-selected', String(t === name));
      $('pane-' + t).hidden = t !== name;
    }
    if (name === 'log') { unseenErrors = 0; $('log-badge').hidden = true; logEl.scrollTop = logEl.scrollHeight; }
    store.set('tab', name);
  }
  for (const t of TABS) $('tab-' + t).addEventListener('click', () => selectTab(t));
  selectTab(TABS.includes(store.get('tab', 'perf')) ? store.get('tab', 'perf') : 'perf');

  // On narrow screens the panel is a sheet over the screens: it starts closed and its state is not remembered
  const narrow = matchMedia('(max-width: 960px)');
  const panelOpen = () => !$('app').classList.contains('panel-hidden');
  function showPanel(show) {
    $('app').classList.toggle('panel-hidden', !show);
    $('panel-toggle').classList.toggle('active', show);
    $('panel-toggle').setAttribute('aria-pressed', String(show));
    if (!narrow.matches) store.set('panel', show ? '1' : '0');
    if (show) requestAnimationFrame(() => { if (!$('pane-perf').hidden) drawGraph(); });
    fitScreens();
  }
  $('panel-toggle').addEventListener('click', () => showPanel(!panelOpen()));
  $('panel-close').addEventListener('click', () => showPanel(false));
  $('scrim').addEventListener('click', () => showPanel(false));
  showPanel(!narrow.matches && store.get('panel', '1') !== '0');

  $('clear-log').addEventListener('click', () => { logEl.textContent = ''; });
  $('copy-log').addEventListener('click', () => {
    const text = [...logEl.childNodes].map((n) => n.textContent).join('\n');
    navigator.clipboard.writeText(text).then(() => toast('Log copied'), () => toast('Could not copy the log', true));
  });

  // ------------------------------------------------------------------ settings
  $('renderer').value = useGL ? 'webgl' : 'software';
  if (!glRenderer) {
    $('renderer').querySelector('option[value="webgl"]').disabled = true;
    logLine(`WebGL 2 is not available (${glError}); drawing with the software renderer.`, 'err');
  }
  $('renderer').addEventListener('change', () => {
    useGL = $('renderer').value === 'webgl';
    store.set('renderer', useGL ? 'webgl' : 'software');
    applyRenderer();
  });
  $('idle-skip').checked = idleSkip;
  $('idle-skip').addEventListener('change', () => { idleSkip = $('idle-skip').checked; store.set('idle-skip', idleSkip ? '1' : '0'); applyIdleSkip(); });

  // Hardware acceleration: show the graphics device and warn when the browser draws WebGL on the CPU
  if (glRenderer) {
    $('gpu-name').textContent = glRenderer.deviceName;
    $('gpu-accel').textContent = glRenderer.softwareDevice ? 'Not accelerated' : 'Hardware accelerated';
    $('gpu-accel').className = 'pill ' + (glRenderer.softwareDevice ? 'halted' : 'running');
    $('gpu-accel').insertAdjacentHTML('afterbegin', '<i></i>');
    if (glRenderer.softwareDevice) {
      const msg = 'Your browser is drawing WebGL without your graphics card, which makes games much slower. Turn on hardware acceleration in your browser settings (Brave/Chrome: Settings → System → "Use graphics acceleration when available"), then restart the browser.';
      logLine(msg, 'err');
      setTimeout(() => toast(msg, true, 12000), 500);
    }
  } else {
    $('gpu-name').textContent = 'WebGL 2 unavailable';
    $('gpu-accel').innerHTML = '<i></i>Not accelerated'; $('gpu-accel').className = 'pill halted';
  }
  let pauseHidden = store.get('pause-hidden', '1') !== '0';
  $('pause-hidden').checked = pauseHidden;
  $('pause-hidden').addEventListener('change', () => { pauseHidden = $('pause-hidden').checked; store.set('pause-hidden', pauseHidden ? '1' : '0'); });
  $('jit').checked = useJit;
  $('jit').addEventListener('change', () => { useJit = $('jit').checked; store.set('jit', useJit ? '1' : '0'); applyJit(); });

  $('audio-on').checked = audio.enabled;
  $('audio-on').addEventListener('change', () => {
    audio.enabled = $('audio-on').checked;
    store.set('audio', audio.enabled ? '1' : '0');
    if (audio.enabled) audio.unlock(); else audio.clear();
    audio.applyVolume();
  });
  $('volume').addEventListener('input', () => {
    audio.volume = +$('volume').value; audio.muted = false;
    store.set('volume', audio.volume); store.set('muted', '0');
    audio.unlock(); audio.applyVolume();
  });
  function toggleMute() {
    audio.muted = !audio.muted;
    store.set('muted', audio.muted ? '1' : '0');
    audio.unlock(); audio.applyVolume();
  }
  $('mute').addEventListener('click', toggleMute);
  audio.applyVolume();

  // Screen layout and size
  function applyLayout() {
    $('device').classList.toggle('side', layout === 'side');
    $('device').classList.toggle('top-only', layout === 'top-only');
    for (const b of $('layout').querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.v === layout));
    fitScreens();
  }
  $('layout').addEventListener('click', (e) => {
    const v = e.target.dataset && e.target.dataset.v;
    if (!v) return;
    layout = v; store.set('layout', v); applyLayout();
  });

  // Scale both screens together: a fixed factor, or as large as fits the stage
  function queueFit() { if (!fitQueued) { fitQueued = true; requestAnimationFrame(fitScreens); } }
  function fitScreens() {
    fitQueued = false;
    const choice = $('scale').value;
    let s;
    if (choice === 'auto') {
      // Space around the pixels: stage and device padding, screen bezels, and the gaps and hinge between the
      // screens (all smaller on phones, none of the outer ones in fullscreen); below them, the on-screen controls
      const stage = $('stage'), dev = $('device'), vpad = $('vpad');
      const cs = (el) => getComputedStyle(el), sum = (st, a, b) => (parseFloat(st[a]) || 0) + (parseFloat(st[b]) || 0);
      const ss = cs(stage), ds = cs(dev), sc = cs(dev.querySelector('.screen')), hinge = dev.querySelector('.hinge');
      const availW = stage.clientWidth - sum(ss, 'paddingLeft', 'paddingRight') - sum(ds, 'paddingLeft', 'paddingRight') - sum(ds, 'borderLeftWidth', 'borderRightWidth');
      let availH = stage.clientHeight - sum(ss, 'paddingTop', 'paddingBottom') - sum(ds, 'paddingTop', 'paddingBottom') - sum(ds, 'borderTopWidth', 'borderBottomWidth');
      if (vpad.offsetHeight && cs(vpad).position !== 'absolute') availH -= vpad.offsetHeight + (parseFloat(ss.rowGap) || 0);
      const one = sum(sc, 'paddingLeft', 'paddingRight'), gap = parseFloat(ds.rowGap) || 0;
      const two = one * 2 + gap * 2 + (layout === 'side' ? hinge.offsetWidth : hinge.offsetHeight);
      const [w, fw, h, fh] = layout === 'side' ? [720, two, 240, one] : layout === 'stacked' ? [400, one, 480, two] : [400, one, 240, one];
      s = Math.max(0.3, Math.min((availW - fw) / w, (availH - fh) / h));
      if (!$('smooth').checked && s > 1) s = Math.floor(s * 4) / 4; // quarter steps keep pixels even-ish
    } else s = parseFloat(choice);
    const setSize = () => {
      topCanvas.style.width = 400 * s + 'px'; topCanvas.style.height = 240 * s + 'px';
      bottomCanvas.style.width = 320 * s + 'px'; bottomCanvas.style.height = 240 * s + 'px';
    };
    setSize();
    if (choice === 'auto') {
      // Whatever the measurements missed (bars, safe areas, controls): shrink until nothing spills off the stage
      const stage = $('stage'), h = layout === 'stacked' ? 480 : 240;
      for (let i = 0; i < 3; i++) {
        const over = stage.scrollHeight - stage.clientHeight;
        if (over <= 1 || s <= 0.3) break;
        s = Math.max(0.3, s - (over + 1) / h);
        setSize();
      }
    }
    layoutDisplay();
  }

  // The WebGL canvas covers the device at the display's full resolution; each screen is drawn where its 2D canvas
  // sits (those stay underneath for layout and touch)
  function layoutDisplay() {
    if (!display) return;
    const dev = $('device'), dpr = window.devicePixelRatio || 1;
    glCanvas.style.width = dev.clientWidth + 'px'; glCanvas.style.height = dev.clientHeight + 'px';
    const cr = glCanvas.getBoundingClientRect();
    display.w = Math.max(1, Math.round(cr.width * dpr)); display.h = Math.max(1, Math.round(cr.height * dpr));
    [topCanvas, bottomCanvas].forEach((c, i) => {
      const r = c.getBoundingClientRect();
      display.rects[i] = r.width && r.height && !(i && layout === 'top-only')
        ? [Math.round((r.left - cr.left) * dpr), Math.round((r.top - cr.top) * dpr), Math.round(r.width * dpr), Math.round(r.height * dpr)] : null;
    });
    requestAnimationFrame(() => present()); // redraw at the new size (also while paused)
  }
  $('scale').value = store.get('screen-size', 'auto');
  if (!$('scale').value) $('scale').value = 'auto';
  $('scale').addEventListener('change', () => { store.set('screen-size', $('scale').value); fitScreens(); });
  $('smooth').checked = store.get('smooth', '0') === '1';
  let smooth = $('smooth').checked;
  function applySmooth() { smooth = $('smooth').checked; $('stage').classList.toggle('smooth', smooth); }
  $('smooth').addEventListener('change', () => { store.set('smooth', $('smooth').checked ? '1' : '0'); applySmooth(); fitScreens(); });
  applySmooth();
  $('show-hud').checked = store.get('hud', '0') === '1';
  $('show-hud').addEventListener('change', () => { store.set('hud', $('show-hud').checked ? '1' : '0'); $('hud').hidden = !$('show-hud').checked; });
  $('hud').hidden = !$('show-hud').checked;
  window.addEventListener('resize', queueFit);
  window.addEventListener('fitscreens', queueFit);
  { const ro = new ResizeObserver(queueFit); ro.observe($('stage')); ro.observe($('vpad')); }

  // Fullscreen: the browser's fullscreen mode where there is one; iPhones have none for pages, so there the
  // top bar is hidden instead (adding the page to the home screen hides the browser's own bars too)
  const fullElement = () => document.fullscreenElement || document.webkitFullscreenElement;
  function setPseudoFull(on) { document.body.classList.toggle('pseudo-full', on); queueFit(); }
  function toggleFullscreen() {
    if (document.body.classList.contains('pseudo-full')) { setPseudoFull(false); return; }
    if (fullElement()) { (document.exitFullscreen || document.webkitExitFullscreen).call(document); return; }
    const stage = $('stage'), req = stage.requestFullscreen || stage.webkitRequestFullscreen;
    if (!req || !(document.fullscreenEnabled || document.webkitFullscreenEnabled)) { setPseudoFull(true); return; }
    const p = req.call(stage, { navigationUI: 'hide' });
    if (p && p.catch) p.catch(() => setPseudoFull(true));
  }
  $('fullscreen').addEventListener('click', toggleFullscreen);
  document.addEventListener('fullscreenchange', queueFit);
  document.addEventListener('webkitfullscreenchange', queueFit);
  applyLayout();

  // drag & drop
  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; document.body.classList.add('dragging'); });
  window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dragging'); } });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault(); dragDepth = 0; document.body.classList.remove('dragging');
    audio.unlock();
    // Small decrypted system data files are added; the first other file is loaded as the game.
    const files = [...e.dataTransfer.files];
    (async () => {
      let game = null, sys = 0;
      for (const f of files) {
        if (f.size > 64 * 1024 * 1024) { game = game || f; continue; }
        if (tryAddSystemFile(new Uint8Array(await f.arrayBuffer()), f.name).ok) sys++;
        else if (!game) game = f;
      }
      if (sys) { updateSysStatus(); toast(`Added ${sys} system file(s).`); }
      if (game) loadFile(game);
    })();
  });

  // ------------------------------------------------------------------ input
  // Keyboard bindings: 3DS button -> KeyboardEvent.code (rebindable, kept in this browser)
  const BUTTONS = [
    ['A', 'A', 'KeyX'], ['B', 'B', 'KeyZ'], ['X', 'X', 'KeyS'], ['Y', 'Y', 'KeyA'],
    ['L', 'L', 'KeyQ'], ['R', 'R', 'KeyW'], ['ZL', 'ZL', 'Digit1'], ['ZR', 'ZR', 'Digit2'],
    ['START', 'Start', 'Enter'], ['SELECT', 'Select', 'Backspace'],
    ['DUP', 'D-Pad up', 'ArrowUp'], ['DDOWN', 'D-Pad down', 'ArrowDown'], ['DLEFT', 'D-Pad left', 'ArrowLeft'], ['DRIGHT', 'D-Pad right', 'ArrowRight'],
    ['CUP', 'Circle Pad up', 'KeyI'], ['CDOWN', 'Circle Pad down', 'KeyK'], ['CLEFT', 'Circle Pad left', 'KeyJ'], ['CRIGHT', 'Circle Pad right', 'KeyL'],
  ];
  const STICK = { CUP: [0, 1], CDOWN: [0, -1], CLEFT: [-1, 0], CRIGHT: [1, 0] };
  let bindings = {};
  try { bindings = JSON.parse(store.get('keys', '{}')) || {}; } catch (e) { bindings = {}; }
  for (const [id, , def] of BUTTONS) if (typeof bindings[id] !== 'string') bindings[id] = def;
  let codeToButton = new Map();
  function rebuildKeyMap() { codeToButton = new Map(BUTTONS.map(([id]) => [bindings[id], id])); }

  const keyLabel = (code) => code.replace(/^Key/, '').replace(/^Digit/, '').replace(/^Arrow/, '').replace(/^Numpad/, 'Num ') || '—';
  let listening = null; // button whose binding is being changed
  function renderBindings() {
    const box = $('bindings');
    box.textContent = '';
    for (const [id, name] of BUTTONS) {
      const label = document.createElement('span'); label.className = 'name'; label.textContent = name;
      const cap = document.createElement('button'); cap.className = 'keycap' + (listening === id ? ' listening' : '');
      cap.textContent = listening === id ? 'Press a key…' : keyLabel(bindings[id]);
      cap.addEventListener('click', () => { listening = listening === id ? null : id; renderBindings(); });
      box.append(label, cap);
    }
  }
  $('keys-reset').addEventListener('click', () => {
    for (const [id, , def] of BUTTONS) bindings[id] = def;
    store.set('keys', JSON.stringify(bindings)); rebuildKeyMap(); listening = null; renderBindings();
    toast('Controls reset to defaults');
  });
  rebuildKeyMap(); renderBindings();

  const held = new Set(); // button ids held on the keyboard
  window.addEventListener('keydown', (e) => {
    if (listening) {
      e.preventDefault();
      if (e.code !== 'Escape') {
        for (const [id] of BUTTONS) if (bindings[id] === e.code) bindings[id] = ''; // a key drives one button
        bindings[listening] = e.code;
        store.set('keys', JSON.stringify(bindings)); rebuildKeyMap();
      }
      listening = null; renderBindings();
      return;
    }
    const tag = e.target.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || e.ctrlKey || e.metaKey || e.altKey) return;
    const button = codeToButton.get(e.code);
    if (button) { held.add(button); e.preventDefault(); return; }
    if (e.repeat) return;
    const fk = /^F([1-4])$/.exec(e.code);
    if (fk) { e.preventDefault(); if (e.shiftKey) saveSlot(+fk[1]); else loadSlot(+fk[1]); return; }
    if (e.code === 'KeyP') { audio.unlock(); setPaused(!paused); }
    else if (e.code === 'KeyF') toggleFullscreen();
    else if (e.code === 'KeyM') toggleMute();
  });
  window.addEventListener('keyup', (e) => { const b = codeToButton.get(e.code); if (b) held.delete(b); });
  window.addEventListener('blur', () => { held.clear(); vpRelease(); });
  // Browsers only start sound after a user gesture (iOS: only some events count, touchend among them)
  window.addEventListener('pointerdown', () => audio.unlock(), { capture: true });
  window.addEventListener('touchend', () => audio.unlock(), { capture: true });
  window.addEventListener('keydown', () => audio.unlock(), { capture: true });

  // In the background: pause (saves battery, and phones throttle background pages anyway), silence the sound,
  // and let go of everything held; carry on when the page is visible again
  let autoPaused = false;
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      if (pauseHidden && emu.loaded && !emu.halted && !paused) { setPaused(true); autoPaused = true; }
      if (audio.ctx && audio.ctx.state === 'running') audio.ctx.suspend();
      held.clear(); vpRelease();
    } else {
      if (audio.ctx && audio.ctx.state === 'suspended' && audio.enabled) audio.ctx.resume();
      if (autoPaused) { autoPaused = false; setPaused(false); }
    }
    updateWakeLock();
  });

  // ------------------------------------------------------------------ on-screen controls
  // Every finger is tracked on its own. A finger that lands on a button can slide onto the next one (A to B
  // and so on); one that lands on the Circle Pad or D-Pad keeps steering it until it lifts.
  const vpad = $('vpad'), vpStick = $('vp-stick'), vpKnob = vpStick.firstElementChild, vpDpad = $('vp-dpad');
  const vpButtons = [...vpad.querySelectorAll('[data-b], [data-k]')];
  const fingers = new Map(); // pointer id -> { kind: 'stick' | 'dpad' | 'btn' | 'act' | 'none', ... }
  const vp = { keys: 0, x: 0, y: 0 };
  let vpMode = store.get('vpad', 'auto');            // auto, on, off
  let vpLeft = store.get('vpad-left', 'stick');      // stick or dpad
  let vpVibrate = store.get('vpad-vibrate', '0') === '1';
  const coarse = matchMedia('(pointer: coarse)');

  function vpHit(x, y) {
    const el = document.elementFromPoint(x, y);
    return el && vpad.contains(el) ? el.closest('[data-b], [data-act], .vp-stick, .vp-dpad') : null;
  }
  function vpFinger(e, f) {
    if (f && (f.kind === 'stick' || f.kind === 'dpad')) {
      const dx = e.clientX - f.cx, dy = e.clientY - f.cy;
      if (f.kind === 'stick') {
        const len = Math.hypot(dx, dy) / f.r, k = len > 1 ? 1 / len : 1;
        f.x = dx / f.r * k; f.y = dy / f.r * k;
        if (len < 0.12) f.x = f.y = 0; // dead zone
      } else {
        f.bits = 0;
        if (Math.hypot(dx, dy) > f.r * 0.2) { // eight directions
          const oct = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) & 7;
          if (oct === 7 || oct === 0 || oct === 1) f.bits |= K.DRIGHT;
          if (oct >= 1 && oct <= 3) f.bits |= K.DDOWN;
          if (oct >= 3 && oct <= 5) f.bits |= K.DLEFT;
          if (oct >= 5) f.bits |= K.DUP;
        }
      }
      return f;
    }
    const el = vpHit(e.clientX, e.clientY);
    if (f && f.kind === 'act') return f; // runs when the finger lifts
    if (!f && el && el.dataset.act) return { kind: 'act', act: el.dataset.act };
    if (!f && el && (el === vpStick || el === vpDpad)) {
      const r = el.getBoundingClientRect();
      return vpFinger(e, { kind: el === vpStick ? 'stick' : 'dpad', cx: r.left + r.width / 2, cy: r.top + r.height / 2, r: r.width / 2 * 0.8, x: 0, y: 0, bits: 0 });
    }
    return { kind: el && el.dataset.b ? 'btn' : 'none', bits: el && el.dataset.b ? K[el.dataset.b] : 0 };
  }
  function vpUpdate() {
    let keys = 0, x = 0, y = 0, stick = false;
    for (const f of fingers.values()) {
      keys |= f.bits || 0;
      if (f.kind === 'stick') { x += f.x; y += f.y; stick = true; }
    }
    if (vpVibrate && (keys & ~vp.keys) && navigator.vibrate) navigator.vibrate(10);
    vp.keys = keys; vp.x = Math.max(-1, Math.min(1, x)); vp.y = Math.max(-1, Math.min(1, -y));
    for (const el of vpButtons) el.classList.toggle('on', !!(keys & K[el.dataset.b || el.dataset.k]));
    vpStick.classList.toggle('on', stick);
    vpKnob.style.transform = stick ? `translate(${x * 45}%, ${y * 45}%)` : '';
  }
  function vpRelease() { if (fingers.size || vp.keys || vp.x || vp.y) { fingers.clear(); vpUpdate(); } }
  vpad.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    try { vpad.setPointerCapture(e.pointerId); } catch (err) { /* finger already gone */ }
    fingers.set(e.pointerId, vpFinger(e, null));
    vpUpdate();
  });
  vpad.addEventListener('pointermove', (e) => {
    const f = fingers.get(e.pointerId);
    if (!f) return;
    fingers.set(e.pointerId, vpFinger(e, f));
    vpUpdate();
  });
  const vpUp = (e) => {
    const f = fingers.get(e.pointerId);
    if (!f) return;
    fingers.delete(e.pointerId);
    vpUpdate();
    // Fullscreen needs a gesture the browser counts as one, which for touch is lifting the finger
    if (e.type === 'pointerup' && f.kind === 'act') {
      const el = vpHit(e.clientX, e.clientY);
      if (el && el.dataset.act === f.act) {
        if (f.act === 'full') toggleFullscreen();
        else if (f.act === 'swap') setVpLeft(vpLeft === 'stick' ? 'dpad' : 'stick');
      }
    }
  };
  vpad.addEventListener('pointerup', vpUp);
  vpad.addEventListener('pointercancel', vpUp);
  vpad.addEventListener('contextmenu', (e) => e.preventDefault());

  function applyVpad() {
    const show = vpMode === 'on' || (vpMode === 'auto' && coarse.matches && !padName);
    document.body.classList.toggle('touch', show);
    vpStick.hidden = vpLeft !== 'stick';
    vpDpad.hidden = vpLeft !== 'dpad';
    for (const b of $('vpad-left').querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.v === vpLeft));
    if (!show) vpRelease();
    queueFit();
  }
  function setVpLeft(v) { vpLeft = v; store.set('vpad-left', v); vpRelease(); applyVpad(); }
  $('vpad-mode').value = ['auto', 'on', 'off'].includes(vpMode) ? vpMode : 'auto';
  $('vpad-mode').addEventListener('change', () => { vpMode = $('vpad-mode').value; store.set('vpad', vpMode); applyVpad(); });
  $('vpad-left').addEventListener('click', (e) => { const v = e.target.dataset && e.target.dataset.v; if (v) setVpLeft(v); });
  $('vpad-vibrate').checked = vpVibrate;
  $('vpad-vibrate').addEventListener('change', () => { vpVibrate = $('vpad-vibrate').checked; store.set('vpad-vibrate', vpVibrate ? '1' : '0'); });
  if (coarse.addEventListener) coarse.addEventListener('change', applyVpad);

  let touch = null;
  function touchFromEvent(e) {
    const rect = bottomCanvas.getBoundingClientRect();
    const x = Math.floor(((e.clientX - rect.left) / rect.width) * 320);
    const y = Math.floor(((e.clientY - rect.top) / rect.height) * 240);
    return { x: Math.max(0, Math.min(319, x)), y: Math.max(0, Math.min(239, y)) };
  }
  bottomCanvas.addEventListener('pointerdown', (e) => { bottomCanvas.setPointerCapture(e.pointerId); touch = touchFromEvent(e); e.preventDefault(); });
  bottomCanvas.addEventListener('pointermove', (e) => { if (touch) touch = touchFromEvent(e); });
  const endTouch = () => { touch = null; };
  bottomCanvas.addEventListener('pointerup', endTouch);
  bottomCanvas.addEventListener('pointercancel', endTouch);

  // Standard gamepad mapping (Xbox-style layout: bottom face button = B, right = A); 6/7 are the triggers
  const padButtons = [K.B, K.A, K.Y, K.X, K.L, K.R, K.ZL, K.ZR, K.SELECT, K.START, 0, 0, K.DUP, K.DDOWN, K.DLEFT, K.DRIGHT];
  let padName = '';
  function readGamepad() {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    let keys = 0, x = 0, y = 0, name = '';
    for (const p of pads) {
      if (!p) continue;
      name = name || p.id;
      p.buttons.forEach((b, i) => { if (b.pressed && padButtons[i]) keys |= padButtons[i]; });
      const ax = p.axes[0] || 0, ay = p.axes[1] || 0;
      if (Math.abs(ax) > 0.15) x = ax;
      if (Math.abs(ay) > 0.15) y = -ay;
    }
    if (name !== padName) {
      padName = name;
      $('pad-status').textContent = name ? `Connected: ${name}` : 'No gamepad detected. Connect one and press a button.';
      if (name) toast('Gamepad connected');
      applyVpad(); // on-screen controls make way for a gamepad (in Auto)
    }
    return { keys, x, y };
  }
  applyVpad();

  function updateInput() {
    const pad = readGamepad();
    let cx = pad.x + vp.x, cy = pad.y + vp.y, keys = pad.keys | vp.keys;
    for (const b of held) {
      if (STICK[b]) { cx += STICK[b][0]; cy += STICK[b][1]; } else keys |= K[b];
    }
    cx = Math.max(-1, Math.min(1, cx)); cy = Math.max(-1, Math.min(1, cy));
    emu.input.keys = keys;
    emu.input.cx = Math.round(cx * 155);
    emu.input.cy = Math.round(cy * 155);
    emu.input.touch = !!touch;
    if (touch) { emu.input.tx = touch.x; emu.input.ty = touch.y; }
  }

  // ------------------------------------------------------------------ frame loop
  // Emulated frames run on a fixed 59.83 Hz clock, decoupled from the display's refresh rate. Each animation
  // frame runs the emulated frames that are due, but stops catching up once it has used ~12 ms so the page
  // stays responsive; when emulation is slower than real time the game runs slower (Speed < 100%) rather
  // than skipping emulated work.
  // The ~12 ms budget grows when the display gives the page fewer animation frames (iOS Low Power Mode: 30 a
  // second), so two emulated frames per animation frame still fit there.
  const FRAME_MS = 1000 / 59.83, CATCH_UP_MS = 12;
  let lastTime = performance.now(), acc = 0, lastRaf = 0, rafMs = 1000 / 60;
  // Telemetry since the last stats update
  const stat = { time: performance.now(), frames: 0, presents: 0, insns: 0, cpu: 0, gpu: 0, xfer: 0, present: 0, frameMs: [] };
  const history = []; // recent frame times (ms) for the graph

  function present() {
    const t0 = performance.now();
    if (display) {
      // Straight from the graphics card when the game's screen is there, otherwise uploaded from emulated memory
      glRenderer.beginDisplay(display.w, display.h);
      for (let i = 0; i < 2; i++) {
        const rect = display.rects[i];
        if (!rect || (emu.loaded && emu.displayGL(i, rect, smooth))) continue;
        const img = i ? bottomImg : topImg;
        emu.renderScreen(i, img.data);
        glRenderer.displayPixels(i, img.data, i ? 320 : 400, rect, smooth);
      }
      glRenderer.endDisplay();
    } else {
      if (!emu.loaded || !emu.presentGL(0, topCtx)) { emu.renderScreen(0, topImg.data); topCtx.putImageData(topImg, 0, 0); }
      if (layout !== 'top-only' && (!emu.loaded || !emu.presentGL(1, bottomCtx))) { emu.renderScreen(1, bottomImg.data); bottomCtx.putImageData(bottomImg, 0, 0); }
    }
    stat.present += performance.now() - t0;
    stat.presents++;
  }

  function drawGraph() {
    const c = $('graph'), g = c.getContext('2d'), W = c.width, H = c.height;
    g.clearRect(0, 0, W, H);
    const maxMs = 40, y = (ms) => H - Math.min(ms, maxMs) / maxMs * (H - 6) - 3;
    g.strokeStyle = 'rgba(141,149,168,.35)'; g.setLineDash([6, 6]); g.lineWidth = 2;
    g.beginPath(); g.moveTo(0, y(16.7)); g.lineTo(W, y(16.7)); g.stroke(); g.setLineDash([]);
    g.fillStyle = 'rgba(141,149,168,.8)'; g.font = '20px system-ui'; g.fillText('16.7 ms', 8, y(16.7) - 8);
    if (history.length < 2) return;
    const dx = W / (240 - 1);
    g.beginPath();
    history.forEach((ms, i) => { const px = W - (history.length - 1 - i) * dx; if (i) g.lineTo(px, y(ms)); else g.moveTo(px, y(ms)); });
    g.strokeStyle = '#ff3b57'; g.lineWidth = 3; g.stroke();
  }

  function setTone(el, value, good, ok) { el.classList.toggle('good', value >= good); el.classList.toggle('warn', value < good && value >= ok); el.classList.toggle('bad', value < ok); }

  function showStats(now) {
    const dt = now - stat.time, n = stat.frames;
    const ms = stat.frameMs.sort((a, b) => a - b);
    const avg = n ? ms.reduce((a, b) => a + b, 0) / n : 0, p95 = n ? ms[Math.min(n - 1, Math.floor(n * 0.95))] : 0;
    const fps = n * 1000 / dt, speed = Math.round(fps / 59.83 * 100);
    const running = emu.loaded && !emu.halted && !paused;
    $('hud').textContent = running ? `${fps.toFixed(0)} FPS · ${speed}%` : paused ? 'Paused' : '';
    if (panelOpen() && !$('pane-perf').hidden) showPerfPane(running, fps, speed, n, avg, p95, dt);
    Object.assign(stat, { time: now, frames: 0, presents: 0, insns: 0, cpu: 0, gpu: 0, xfer: 0, present: 0, frameMs: [] });
  }

  function showPerfPane(running, fps, speed, n, avg, p95, dt) {
    $('fps').textContent = running ? fps.toFixed(0) : '–';
    $('host-fps').textContent = running ? (stat.presents * 1000 / dt).toFixed(0) : '–';
    $('speed').textContent = running ? speed + '%' : '–';
    setTone($('stat-fps'), running ? fps : 60, 57, 40);
    setTone($('stat-speed'), running ? speed : 100, 95, 70);
    $('perf').textContent = n
      ? `${avg.toFixed(1)} ms average, ${p95.toFixed(1)} ms 95th percentile (budget 16.7 ms). ${stat.cpu > 0 ? (stat.insns / stat.cpu / 1000).toFixed(0) : '–'} million ARM instructions per second.`
      : running ? '' : 'Start a game to see performance.';
    const parts = { cpu: stat.cpu / Math.max(1, n), gpu: stat.gpu / Math.max(1, n), xfer: stat.xfer / Math.max(1, n), present: stat.present / Math.max(1, stat.presents) };
    for (const k in parts) {
      $('bar-' + k).style.width = Math.min(100, parts[k] / 16.7 * 100) + '%';
      $('val-' + k).textContent = n ? parts[k].toFixed(1) + ' ms' : '–';
    }
    drawGraph();
  }

  function loop(now) {
    requestAnimationFrame(loop);
    const gap = now - lastRaf; lastRaf = now;
    if (gap > 4 && gap < 100) rafMs += (gap - rafMs) * 0.05;
    if (now - stat.time >= 500) showStats(now);
    if (!emu.loaded || emu.halted || paused) { lastTime = now; return; }
    acc += Math.min(now - lastTime, 250);
    lastTime = now;
    let ran = 0;
    const t0 = performance.now();
    while (acc >= FRAME_MS && !emu.halted) {
      updateInput();
      const insns = emu.insnCount;
      emu.runFrame();
      acc -= FRAME_MS;
      ran++;
      const p = emu.perf;
      stat.frames++; stat.insns += emu.insnCount - insns;
      stat.cpu += p.frame - p.gpu - p.xfer; stat.gpu += p.gpu; stat.xfer += p.xfer; stat.frameMs.push(p.frame);
      history.push(p.frame); if (history.length > 240) history.shift();
      if (performance.now() - t0 > Math.max(CATCH_UP_MS, rafMs * 0.75)) break;
    }
    if (acc > FRAME_MS) acc = FRAME_MS; // behind: keep at most one frame due instead of building up a backlog
    audio.flush();
    if (ran) present();
  }
  requestAnimationFrame(loop);

  // ------------------------------------------------------------------ installed app (home screen)
  // Opened from the home screen: no browser bars. Otherwise offer to install it (Android: the browser's own install
  // prompt; iPhone and iPad: Share, then Add to Home Screen) on touch devices.
  const installed = matchMedia('(display-mode: fullscreen), (display-mode: standalone)').matches || navigator.standalone === true;
  document.body.classList.toggle('installed', installed);
  const ios = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  let installPrompt = null;
  if (!installed && ios) { $('install').hidden = false; $('install-ios').hidden = false; }
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    installPrompt = e;
    $('install').hidden = false; $('install-btn').hidden = false;
  });
  $('install-btn').addEventListener('click', async () => {
    if (!installPrompt) return;
    installPrompt.prompt();
    const choice = await installPrompt.userChoice.catch(() => null);
    installPrompt = null;
    if (choice && choice.outcome === 'accepted') { $('install').hidden = true; toast('Installed. Open Pica3DS from your home screen.'); }
  });
  window.addEventListener('appinstalled', () => { $('install').hidden = true; });
  // Offline cache for the app's own files (not available when opened from a file)
  if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
    window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch((e) => logLine(`Offline mode is unavailable: ${e.message}`)));
  }

  // For debugging and measuring from the browser console
  window.pica = { emu, pause: (p = true) => setPaused(p), audio, present };

  // Paint the idle screens black.
  present();
  showWelcome();
  fitScreens();
  logLine('Ready. Open a game, drop one on the page, or run the demo.');
  if (new URLSearchParams(location.search).has('demo')) runDemo();
})();

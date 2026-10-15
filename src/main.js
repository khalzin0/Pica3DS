// Browser front-end: file loading, frame loop, rendering, sound, keyboard/mouse/gamepad input and the UI.
(function () {
  'use strict';

  const EMU = window.EMU;
  const K = EMU.KEYS;
  const $ = (id) => document.getElementById(id);

  const topCanvas = $('top'), bottomCanvas = $('bottom');
  const topCtx = topCanvas.getContext('2d'), bottomCtx = bottomCanvas.getContext('2d');
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
  // Emulated audio frames (stereo, 32728 Hz) are collected during each animation frame and handed to an
  // AudioWorklet, which keeps a small buffer, resamples to the output rate when needed and plays it.
  const WORKLET = `
class PicaAudio extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = options.processorOptions;
    this.inRate = o.inRate; this.ratio = o.inRate / sampleRate;
    this.cap = o.inRate;                                  // one second of input
    this.buf = new Float32Array(this.cap * 2);
    this.r = 0; this.w = 0; this.n = 0; this.frac = 0; this.primed = false;
    this.target = Math.round(o.inRate * 0.06);            // aim for ~60 ms buffered
    this.port.onmessage = (e) => {
      const d = e.data;
      if (d === 'flush') { this.r = this.w = this.n = 0; this.primed = false; return; }
      for (let i = 0; i < d.length; i += 2) {
        this.buf[this.w * 2] = d[i]; this.buf[this.w * 2 + 1] = d[i + 1];
        this.w = (this.w + 1) % this.cap;
        if (this.n < this.cap) this.n++; else this.r = (this.r + 1) % this.cap;
      }
      const max = this.target * 3; // emulation ran ahead: drop the oldest audio to keep latency low
      while (this.n > max) { this.r = (this.r + 1) % this.cap; this.n--; }
    };
  }
  process(inputs, outputs) {
    const out = outputs[0], L = out[0], R = out[1] || out[0];
    if (!this.primed) {
      if (this.n < this.target) { L.fill(0); R.fill(0); return true; }
      this.primed = true;
    }
    // Play slightly faster or slower to stay near the target fill level
    const step = this.ratio * (1 + Math.max(-0.005, Math.min(0.005, (this.n - this.target) / this.target * 0.01)));
    for (let i = 0; i < L.length; i++) {
      if (this.n < 2) { L[i] = R[i] = 0; this.primed = false; continue; }
      const a = this.r * 2, b = ((this.r + 1) % this.cap) * 2, f = this.frac;
      L[i] = this.buf[a] + (this.buf[b] - this.buf[a]) * f;
      R[i] = this.buf[a + 1] + (this.buf[b + 1] - this.buf[a + 1]) * f;
      this.frac += step;
      while (this.frac >= 1) { this.frac -= 1; this.r = (this.r + 1) % this.cap; this.n--; }
    }
    return true;
  }
}
registerProcessor('pica-audio', PicaAudio);`;

  const audio = {
    ctx: null, node: null, gain: null, failed: false, pending: [], pendingLen: 0,
    enabled: store.get('audio', '1') !== '0',
    volume: Math.max(0, Math.min(100, parseInt(store.get('volume', '80'), 10) || 0)),
    muted: store.get('muted', '0') === '1',

    // Must run from a user gesture the first time (browsers start audio suspended)
    unlock() {
      if (this.failed || !this.enabled) return;
      if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx || !window.AudioWorkletNode) { this.fail('this browser does not support AudioWorklet'); return; }
      try { this.ctx = new Ctx({ sampleRate: EMU.AUDIO_RATE, latencyHint: 'interactive' }); }
      catch (e) { try { this.ctx = new Ctx({ latencyHint: 'interactive' }); } catch (e2) { this.fail(e2.message); return; } }
      const url = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }));
      this.ctx.audioWorklet.addModule(url).then(() => {
        this.node = new AudioWorkletNode(this.ctx, 'pica-audio', { numberOfInputs: 0, outputChannelCount: [2], processorOptions: { inRate: EMU.AUDIO_RATE } });
        this.gain = this.ctx.createGain();
        this.node.connect(this.gain).connect(this.ctx.destination);
        this.applyVolume();
      }).catch((e) => this.fail(e.message)).finally(() => URL.revokeObjectURL(url));
    },
    fail(msg) { this.failed = true; logLine(`Sound is unavailable: ${msg}`, 'err'); },

    push(L, R) {
      if (!this.node || !this.enabled) return;
      const b = new Float32Array(L.length * 2);
      for (let i = 0; i < L.length; i++) { b[i * 2] = L[i]; b[i * 2 + 1] = R[i]; }
      this.pending.push(b); this.pendingLen += b.length;
    },
    flush() {
      if (!this.pendingLen) return;
      const all = new Float32Array(this.pendingLen);
      let o = 0;
      for (const b of this.pending) { all.set(b, o); o += b.length; }
      this.pending = []; this.pendingLen = 0;
      if (this.node) this.node.port.postMessage(all, [all.buffer]);
    },
    clear() { this.pending = []; this.pendingLen = 0; if (this.node) this.node.port.postMessage('flush'); },
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
    },
  });
  emu.onAudio = (L, R) => audio.push(L, R);

  // ------------------------------------------------------------------ UI state
  let romBytes = null, romName = '';
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
  }

  // Renderer: the host graphics card through WebGL 2 (default when available) or the software rasterizer
  let glRenderer = null, glError = '';
  try { glRenderer = new EMU.GLRenderer(document.createElement('canvas')); } catch (e) { glError = e.message; }
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

  function start(bytes, name) {
    romBytes = bytes; romName = name;
    audio.clear();
    try {
      applyRenderer();
      emu.load(bytes, name);
      applyJit();
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
  }

  function loadFile(file) {
    audio.unlock();
    setStatus('', `Loading ${file.name}…`);
    file.arrayBuffer().then((buf) => start(new Uint8Array(buf), file.name))
      .catch((e) => { showMessage('Could not read this file', `${file.name}: ${e.message}. Very large files (over about 2 GB) cannot be loaded yet.`); setStatus('halted', 'Load failed'); });
  }

  function runDemo() {
    audio.unlock();
    const bin = atob(EMU.DEMO_ROM_B64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    start(bytes, 'demo.3dsx');
  }

  $('file').addEventListener('change', (e) => { if (e.target.files[0]) loadFile(e.target.files[0]); e.target.value = ''; });
  $('ov-demo').addEventListener('click', runDemo);
  $('reset').addEventListener('click', () => { audio.unlock(); if (romBytes) start(romBytes, romName); });
  $('ov-reset').addEventListener('click', () => { audio.unlock(); if (romBytes) start(romBytes, romName); });
  $('ov-log').addEventListener('click', () => { showPanel(true); selectTab('log'); });
  $('pause').addEventListener('click', () => { audio.unlock(); setPaused(!paused); });

  // ------------------------------------------------------------------ system files (kept in IndexedDB)
  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('emu3ds', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('sysdata');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  async function dbDo(mode, fn) {
    try {
      const db = await openDb();
      return await new Promise((resolve, reject) => {
        const tx = db.transaction('sysdata', mode);
        fn(tx.objectStore('sysdata'));
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => reject(tx.error);
      });
    } catch (e) { return null; } // storage unavailable: files last for this session only
  }

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
  const TABS = ['perf', 'settings', 'controls', 'log'];
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

  function showPanel(show) {
    $('app').classList.toggle('panel-hidden', !show);
    $('panel-toggle').classList.toggle('active', show);
    $('panel-toggle').setAttribute('aria-pressed', String(show));
    store.set('panel', show ? '1' : '0');
    fitScreens();
  }
  $('panel-toggle').addEventListener('click', () => showPanel($('app').classList.contains('panel-hidden')));
  showPanel(store.get('panel', '1') !== '0');

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
  function fitScreens() {
    const choice = $('scale').value;
    let s;
    if (choice === 'auto') {
      // Fixed space around the pixels: stage padding (24 each side), device padding (16), screen bezels (8),
      // and the gaps and hinge between the screens (12 + 6 + 12); none of the outer ones in fullscreen
      const stage = $('stage'), full = document.fullscreenElement === stage;
      const outer = full ? 0 : 48 + 32, two = 16 * 2 + 30, one = 16;
      const availW = stage.clientWidth - outer, availH = stage.clientHeight - outer;
      const [w, fw, h, fh] = layout === 'side' ? [720, two, 240, one] : layout === 'stacked' ? [400, one, 480, two] : [400, one, 240, one];
      s = Math.max(0.5, Math.min((availW - fw) / w, (availH - fh) / h));
      if (!$('smooth').checked && s > 1) s = Math.floor(s * 4) / 4; // quarter steps keep pixels even-ish
    } else s = parseFloat(choice);
    topCanvas.style.width = 400 * s + 'px'; topCanvas.style.height = 240 * s + 'px';
    bottomCanvas.style.width = 320 * s + 'px'; bottomCanvas.style.height = 240 * s + 'px';
  }
  $('scale').value = store.get('screen-size', 'auto');
  if (!$('scale').value) $('scale').value = 'auto';
  $('scale').addEventListener('change', () => { store.set('screen-size', $('scale').value); fitScreens(); });
  $('smooth').checked = store.get('smooth', '0') === '1';
  function applySmooth() { $('stage').classList.toggle('smooth', $('smooth').checked); }
  $('smooth').addEventListener('change', () => { store.set('smooth', $('smooth').checked ? '1' : '0'); applySmooth(); fitScreens(); });
  applySmooth();
  $('show-hud').checked = store.get('hud', '0') === '1';
  $('show-hud').addEventListener('change', () => { store.set('hud', $('show-hud').checked ? '1' : '0'); $('hud').hidden = !$('show-hud').checked; });
  $('hud').hidden = !$('show-hud').checked;
  window.addEventListener('resize', fitScreens);
  new ResizeObserver(fitScreens).observe($('stage'));

  function toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen();
    else $('stage').requestFullscreen().catch((e) => toast(`Fullscreen is not available: ${e.message}`, true));
  }
  $('fullscreen').addEventListener('click', toggleFullscreen);
  document.addEventListener('fullscreenchange', fitScreens);
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
    if (e.code === 'KeyP') { audio.unlock(); setPaused(!paused); }
    else if (e.code === 'KeyF') toggleFullscreen();
    else if (e.code === 'KeyM') toggleMute();
  });
  window.addEventListener('keyup', (e) => { const b = codeToButton.get(e.code); if (b) held.delete(b); });
  window.addEventListener('blur', () => held.clear());
  // Browsers only start sound after a user gesture
  window.addEventListener('pointerdown', () => audio.unlock(), { capture: true });
  window.addEventListener('keydown', () => audio.unlock(), { capture: true });

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
    }
    return { keys, x, y };
  }

  function updateInput() {
    const pad = readGamepad();
    let cx = pad.x, cy = pad.y, keys = pad.keys;
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
  const FRAME_MS = 1000 / 59.83, CATCH_UP_MS = 12;
  let lastTime = performance.now(), acc = 0;
  // Telemetry since the last stats update
  const stat = { time: performance.now(), frames: 0, presents: 0, insns: 0, cpu: 0, gpu: 0, xfer: 0, present: 0, frameMs: [] };
  const history = []; // recent frame times (ms) for the graph

  function present() {
    const t0 = performance.now();
    // Straight from the graphics card when possible, otherwise converted from emulated memory
    if (!emu.loaded || !emu.presentGL(0, topCtx)) { emu.renderScreen(0, topImg.data); topCtx.putImageData(topImg, 0, 0); }
    if (layout !== 'top-only' && (!emu.loaded || !emu.presentGL(1, bottomCtx))) { emu.renderScreen(1, bottomImg.data); bottomCtx.putImageData(bottomImg, 0, 0); }
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
    $('hud').textContent = running ? `${fps.toFixed(0)} FPS · ${speed}%` : paused ? 'Paused' : '';
    if (!$('pane-perf').hidden) drawGraph();
    Object.assign(stat, { time: now, frames: 0, presents: 0, insns: 0, cpu: 0, gpu: 0, xfer: 0, present: 0, frameMs: [] });
  }

  function loop(now) {
    requestAnimationFrame(loop);
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
      if (performance.now() - t0 > CATCH_UP_MS) break;
    }
    if (acc > FRAME_MS) acc = FRAME_MS; // behind: keep at most one frame due instead of building up a backlog
    audio.flush();
    if (ran) present();
  }
  requestAnimationFrame(loop);

  // For debugging and measuring from the browser console
  window.pica = { emu, pause: (p = true) => setPaused(p), audio };

  // Paint the idle screens black.
  present();
  showWelcome();
  fitScreens();
  logLine('Ready. Open a game, drop one on the page, or run the demo.');
  if (new URLSearchParams(location.search).has('demo')) runDemo();
})();

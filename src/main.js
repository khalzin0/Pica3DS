// Browser front-end: file loading, frame loop, rendering, keyboard/mouse/gamepad input.
(function () {
  'use strict';

  const EMU = window.EMU;
  const K = EMU.KEYS;
  const $ = (id) => document.getElementById(id);

  const topCanvas = $('top'), bottomCanvas = $('bottom');
  const topCtx = topCanvas.getContext('2d'), bottomCtx = bottomCanvas.getContext('2d');
  const topImg = topCtx.createImageData(400, 240), bottomImg = bottomCtx.createImageData(320, 240);
  const logEl = $('log');

  // ------------------------------------------------------------------ log
  let pendingDebug = '';
  function logLine(text, cls = 'info') {
    const div = document.createElement('div');
    div.className = cls;
    div.textContent = text;
    logEl.appendChild(div);
    while (logEl.childNodes.length > 600) logEl.removeChild(logEl.firstChild);
    logEl.scrollTop = logEl.scrollHeight;
  }

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
        ? `This game needs the system file ${miss.id.toUpperCase()}${miss.name ? ` (${miss.name})` : ''} from your 3DS. Dump and decrypt it with GodMode9, then add it with "System files…" and press Reset.`
        : 'The application hit something this emulator does not support.';
      showOverlay(crashed ? 'Emulation stopped' : 'Application finished', crashed ? text : reason.split('\n')[0], crashed ? reason : null);
      setStatus('halted', crashed ? 'Stopped (error)' : 'Finished');
      $('pause').disabled = true;
    },
  });

  // ------------------------------------------------------------------ UI state
  let romBytes = null, romName = '';
  let paused = false;

  function setStatus(kind, text) {
    $('status').className = 'status ' + kind;
    $('status-text').textContent = text;
  }

  function showOverlay(title, text, detail) {
    $('ov-title').textContent = title;
    $('ov-text').textContent = text;
    const pre = $('ov-detail');
    pre.hidden = !detail;
    pre.textContent = detail || '';
    $('overlay').hidden = false;
  }

  function start(bytes, name) {
    romBytes = bytes; romName = name;
    try {
      emu.load(bytes, name);
    } catch (e) {
      logLine(e.message, 'err');
      showOverlay('Could not load file', e.message);
      setStatus('halted', 'Load failed');
      return;
    }
    $('overlay').hidden = true;
    paused = false;
    $('pause').disabled = false; $('pause').textContent = 'Pause';
    $('reset').disabled = false;
    setStatus('running', `Running ${name}`);
    lastTime = performance.now(); acc = 0;
  }

  function loadFile(file) {
    file.arrayBuffer().then((buf) => start(new Uint8Array(buf), file.name));
  }

  function runDemo() {
    const bin = atob(EMU.DEMO_ROM_B64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    start(bytes, 'demo.3dsx');
  }

  $('file').addEventListener('change', (e) => { if (e.target.files[0]) loadFile(e.target.files[0]); e.target.value = ''; });

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
    $('sys-status').textContent = names.length ? `System files: ${names.join(', ')}` : 'System files: none';
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
      else logLine(`${f.name}: ${r.error || 'not a system data file'}`, 'err');
    }
    updateSysStatus();
    if (added && romBytes) logLine('Press Reset to restart the game with the new system files.');
  }

  $('sysfiles').addEventListener('change', (e) => { addSystemFiles([...e.target.files]); e.target.value = ''; });
  $('sys-clear').addEventListener('click', () => {
    emu.systemArchives.clear();
    dbDo('readwrite', (s) => s.clear());
    updateSysStatus();
    logLine('Removed all system files.');
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
  $('demo').addEventListener('click', runDemo);
  $('ov-demo').addEventListener('click', runDemo);
  $('reset').addEventListener('click', () => { if (romBytes) start(romBytes, romName); });
  $('pause').addEventListener('click', () => {
    if (emu.halted) return;
    paused = !paused;
    $('pause').textContent = paused ? 'Resume' : 'Pause';
    setStatus(paused ? 'paused' : 'running', paused ? 'Paused' : `Running ${romName}`);
    lastTime = performance.now(); acc = 0;
  });
  $('clear-log').addEventListener('click', () => { logEl.textContent = ''; });

  function applyScale() {
    const s = parseFloat($('scale').value);
    topCanvas.style.width = 400 * s + 'px';
    bottomCanvas.style.width = 320 * s + 'px';
    try { localStorage.setItem('emu3ds-scale', $('scale').value); } catch (e) { /* storage unavailable */ }
  }
  try { const s = localStorage.getItem('emu3ds-scale'); if (s) $('scale').value = s; } catch (e) { /* storage unavailable */ }
  $('scale').addEventListener('change', applyScale);
  applyScale();

  // drag & drop
  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; document.body.classList.add('dragging'); });
  window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dragging'); } });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault(); dragDepth = 0; document.body.classList.remove('dragging');
    // Small decrypted system data files are added; the first other file is loaded as the game.
    const files = [...e.dataTransfer.files];
    (async () => {
      let game = null, sys = 0;
      for (const f of files) {
        if (f.size > 64 * 1024 * 1024) { game = game || f; continue; }
        if (tryAddSystemFile(new Uint8Array(await f.arrayBuffer()), f.name).ok) sys++;
        else if (!game) game = f;
      }
      if (sys) updateSysStatus();
      if (game) loadFile(game);
    })();
  });

  // ------------------------------------------------------------------ input
  const keyMap = {
    ArrowUp: K.DUP, ArrowDown: K.DDOWN, ArrowLeft: K.DLEFT, ArrowRight: K.DRIGHT,
    KeyX: K.A, KeyZ: K.B, KeyS: K.X, KeyA: K.Y, KeyQ: K.L, KeyW: K.R,
    Enter: K.START, Backspace: K.SELECT, ShiftRight: K.SELECT,
  };
  const stickKeys = { KeyI: [0, 1], KeyK: [0, -1], KeyJ: [-1, 0], KeyL: [1, 0] };
  let kbKeys = 0;
  const stickHeld = new Set();

  window.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'SELECT' || e.ctrlKey || e.metaKey || e.altKey) return;
    if (keyMap[e.code] !== undefined) { kbKeys |= keyMap[e.code]; e.preventDefault(); }
    else if (stickKeys[e.code]) { stickHeld.add(e.code); e.preventDefault(); }
  });
  window.addEventListener('keyup', (e) => {
    if (keyMap[e.code] !== undefined) kbKeys &= ~keyMap[e.code];
    else if (stickKeys[e.code]) stickHeld.delete(e.code);
  });
  window.addEventListener('blur', () => { kbKeys = 0; stickHeld.clear(); });

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

  // Standard gamepad mapping (Xbox-style layout: bottom face button = B, right = A).
  const padButtons = [K.B, K.A, K.Y, K.X, K.L, K.R, K.L, K.R, K.SELECT, K.START, 0, 0, K.DUP, K.DDOWN, K.DLEFT, K.DRIGHT];
  function readGamepad() {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    let keys = 0, x = 0, y = 0;
    for (const p of pads) {
      if (!p) continue;
      p.buttons.forEach((b, i) => { if (b.pressed && padButtons[i]) keys |= padButtons[i]; });
      const ax = p.axes[0] || 0, ay = p.axes[1] || 0;
      if (Math.abs(ax) > 0.15) x = ax;
      if (Math.abs(ay) > 0.15) y = -ay;
    }
    return { keys, x, y };
  }

  function updateInput() {
    const pad = readGamepad();
    let cx = pad.x, cy = pad.y;
    for (const code of stickHeld) { cx += stickKeys[code][0]; cy += stickKeys[code][1]; }
    cx = Math.max(-1, Math.min(1, cx)); cy = Math.max(-1, Math.min(1, cy));
    emu.input.keys = kbKeys | pad.keys;
    emu.input.cx = Math.round(cx * 155);
    emu.input.cy = Math.round(cy * 155);
    emu.input.touch = !!touch;
    if (touch) { emu.input.tx = touch.x; emu.input.ty = touch.y; }
  }

  // ------------------------------------------------------------------ frame loop
  const FRAME_MS = 1000 / 59.83;
  let lastTime = performance.now(), acc = 0;
  let statFrames = 0, statInsns = 0, statTime = performance.now(), statEmuTime = 0;

  function present() {
    emu.renderScreen(0, topImg.data);
    emu.renderScreen(1, bottomImg.data);
    topCtx.putImageData(topImg, 0, 0);
    bottomCtx.putImageData(bottomImg, 0, 0);
  }

  function loop(now) {
    requestAnimationFrame(loop);
    if (!emu.loaded || emu.halted || paused) { lastTime = now; return; }
    acc += Math.min(now - lastTime, 100);
    lastTime = now;
    let ran = 0;
    const insnBefore = emu.insnCount;
    const t0 = performance.now();
    while (acc >= FRAME_MS && ran < 3 && !emu.halted) {
      updateInput();
      emu.runFrame();
      acc -= FRAME_MS;
      ran++;
    }
    if (ran === 3) acc = 0; // too slow to catch up: drop the backlog
    statEmuTime += performance.now() - t0;
    if (ran) present();
    statFrames += ran;
    statInsns += emu.insnCount - insnBefore;
    const dt = now - statTime;
    if (dt >= 500) {
      const fps = statFrames * 1000 / dt;
      $('fps').textContent = fps.toFixed(0);
      $('mips').textContent = statEmuTime > 0 ? (statInsns / statEmuTime / 1000).toFixed(0) : '–';
      $('speed').textContent = Math.round(fps / 59.83 * 100) + '%';
      statFrames = 0; statInsns = 0; statTime = now; statEmuTime = 0;
    }
  }
  requestAnimationFrame(loop);

  // Paint the idle screens black.
  present();
  logLine('Ready. Open a .3dsx / .elf / .3ds / .cxi file or press "Demo".');
  if (new URLSearchParams(location.search).has('demo')) runDemo();
})();

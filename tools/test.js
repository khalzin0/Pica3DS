// Regression tests: node tools/test.js
// Runs the prebuilt test ROMs headlessly and checks their output.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
for (const f of ['memory.js', 'cpu.js', 'kernel.js', 'services.js', 'gpu.js', 'sysdata.js', 'loader.js', 'emulator.js']) {
  vm.runInThisContext(fs.readFileSync(path.join(ROOT, 'src', f), 'utf8'), { filename: f });
}
const EMU = globalThis.EMU;

function run(rom, frames, keys = () => 0, onFrame = () => {}) {
  let debug = '', halt = null;
  const emu = new EMU.Emulator({ onDebug: (s) => { debug += s; }, onHalt: (r) => { halt = r; } });
  emu.load(new Uint8Array(fs.readFileSync(path.join(ROOT, rom))), path.basename(rom));
  for (let f = 0; f < frames && !emu.halted; f++) { emu.input.keys = keys(f); emu.runFrame(); onFrame(f, emu); }
  return { emu, debug, halt };
}

function screenHasContent(emu, screen) {
  const W = screen ? 320 : 400;
  const px = new Uint8ClampedArray(W * 240 * 4);
  if (!emu.renderScreen(screen, px)) return false;
  for (let i = 0; i < px.length; i += 4) if (px[i] | px[i + 1] | px[i + 2]) return true;
  return false;
}

const tests = [
  ['CPU test (-O2) matches reference output', () => {
    const { debug } = run('tests/roms/cpu-O2.3dsx', 30);
    return debug === fs.readFileSync(path.join(ROOT, 'tests/cputest/expected.txt'), 'utf8');
  }],
  ['CPU test (-O0) matches reference output', () => {
    const { debug } = run('tests/roms/cpu-O0.3dsx', 30);
    return debug === fs.readFileSync(path.join(ROOT, 'tests/cputest/expected.txt'), 'utf8');
  }],
  ['Thumb + interworking test', () => {
    const { debug } = run('tests/roms/thumb.3dsx', 10);
    return (debug.match(/ ok\n/g) || []).length === 6 && !debug.includes('MISMATCH');
  }],
  ['hello-world draws text and exits on START', () => {
    let drew = false;
    const { halt } = run('tests/roms/hello.3dsx', 90, (f) => (f >= 60 && f < 65 ? EMU.KEYS.START : 0), (f, emu) => { if (f === 50) drew = screenHasContent(emu, 0); });
    return drew && /closed|exited/i.test(halt || '');
  }],
  ['threads example runs worker threads', () => {
    const { emu, halt } = run('tests/roms/thread-basic.3dsx', 120);
    return !halt && emu.kernel.threads.length >= 6 && screenHasContent(emu, 0);
  }],
  ['demo runs at full emulated frame rate', () => {
    const { emu, halt } = run('demo/demo.3dsx', 120, (f) => (f > 30 ? EMU.KEYS.DRIGHT : 0));
    return !halt && emu.frame === 120 && screenHasContent(emu, 0) && screenHasContent(emu, 1);
  }],
  ...['romfs.3dsx', 'romfs.3ds', 'romfs-c.3ds', 'romfs.cxi'].map((rom) => [`${rom} loads and reads text files from its RomFS`, () => {
    const { emu, halt } = run(`tests/roms/${rom}`, 30);
    const px = new Uint8ClampedArray(400 * 240 * 4);
    emu.renderScreen(0, px);
    let lit = 0;
    for (let i = 0; i < px.length; i += 4) if (px[i]) lit++;
    return !halt && lit > 1500; // "romfs Init Successful!" alone lights ~360 pixels; the file text adds the rest
  }]),
  ['rejects encrypted .3ds images with a clear error', () => {
    const bytes = new Uint8Array(fs.readFileSync(path.join(ROOT, 'tests/roms/romfs.3ds')));
    bytes[0x4000 + 0x188 + 7] &= ~4; // clear the NoCrypto flag of partition 0
    try { new EMU.Emulator().load(bytes); return false; } catch (e) { return /encrypted/.test(e.message); }
  }],
  ['rejects non-homebrew files with a clear error', () => {
    const emu = new EMU.Emulator();
    try { emu.load(new Uint8Array(1024)); return false; } catch (e) { return /Unrecognized file format/.test(e.message); }
  }],
  ['reads decrypted system data files (and rejects encrypted ones)', () => {
    // Turn the RomFS test title into a data-only title with the Mii data title ID
    const bytes = new Uint8Array(fs.readFileSync(path.join(ROOT, 'tests/roms/romfs.cxi')));
    bytes[0x188 + 5] &= ~2;
    new DataView(bytes.buffer).setBigUint64(0x108, 0x0004009B00010202n, true);
    const info = EMU.parseSystemArchive(bytes);
    const game = new EMU.Emulator();
    game.load(new Uint8Array(fs.readFileSync(path.join(ROOT, 'tests/roms/romfs.cxi'))));
    const sameRomfs = info.romfs.length === game.romfs.length && info.romfs.every((b, i) => b === game.romfs[i]);
    bytes[0x188 + 7] &= ~4;
    let rejected = false;
    try { EMU.parseSystemArchive(bytes); } catch (e) { rejected = /encrypted/.test(e.message); }
    return info.titleId === '0004009b00010202' && info.name === 'Mii data' && !info.executable && sameRomfs && rejected;
  }],
  ['RomFS builder output is readable by libctru (stand-in system files)', () => {
    // Rebuild the test title's RomFS with the builder and check the app still reads both files the same way
    const rom = new Uint8Array(fs.readFileSync(path.join(ROOT, 'tests/roms/romfs.cxi')));
    const screen = (emu) => { const px = new Uint8ClampedArray(400 * 240 * 4); emu.renderScreen(0, px); return px; };
    const a = new EMU.Emulator({ onDebug: () => {} }); a.load(rom);
    const files = {};
    for (const f of EMU.listRomfs(a.romfs)) files[f.path] = a.romfs.slice(f.offset, f.offset + f.size);
    const b = new EMU.Emulator({ onDebug: () => {} }); b.load(rom); b.romfs = EMU.buildRomfs(files);
    for (let i = 0; i < 30; i++) { a.runFrame(); b.runFrame(); }
    const pa = screen(a), pb = screen(b);
    let lit = 0;
    for (let i = 0; i < pa.length; i += 4) if (pa[i]) lit++;
    return Object.keys(files).length === 2 && lit > 1500 && pa.every((v, i) => v === pb[i]) && !b.halted;
  }],
  ...require(path.join(ROOT, 'tests/gpu/scenes.js'))(EMU).tests,
];

let failed = 0;
for (const [name, fn] of tests) {
  let ok = false, err = '';
  try { ok = fn(); } catch (e) { err = ` (${e.message})`; }
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${err}`);
}
console.log(failed ? `\n${failed} test(s) failed` : '\nAll tests passed');
process.exit(failed ? 1 : 0);

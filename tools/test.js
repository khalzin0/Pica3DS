// Regression tests: node tools/test.js
// Runs the prebuilt test ROMs headlessly and checks their output.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
for (const f of ['memory.js', 'wasmjit.js', 'cpu.js', 'kernel.js', 'services.js', 'gpu.js', 'audio.js', 'sysdata.js', 'loader.js', 'emulator.js']) {
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
  ['stand-in system archives: bad word list, shared fonts (LZ11) and an empty fallback', () => {
    const lz11 = (src) => { // LZ11 decompressor (literals and back-references)
      const n = src[1] | (src[2] << 8) | (src[3] << 16), out = new Uint8Array(n);
      let i = 4, o = 0;
      while (o < n) {
        const flags = src[i++];
        for (let b = 7; b >= 0 && o < n; b--) {
          if (!((flags >> b) & 1)) { out[o++] = src[i++]; continue; }
          let len, disp, x = src[i] >> 4;
          if (x === 0) { len = (((src[i] & 15) << 4) | (src[i + 1] >> 4)) + 0x11; disp = (((src[i + 1] & 15) << 8) | src[i + 2]) + 1; i += 3; }
          else if (x === 1) { len = (((src[i] & 15) << 12) | (src[i + 1] << 4) | (src[i + 2] >> 4)) + 0x111; disp = (((src[i + 2] & 15) << 8) | src[i + 3]) + 1; i += 4; }
          else { len = x + 1; disp = (((src[i] & 15) << 8) | src[i + 1]) + 1; i += 2; }
          for (let k = 0; k < len; k++, o++) out[o] = out[o - disp];
        }
      }
      return out;
    };
    const files = (img) => Object.fromEntries(EMU.listRomfs(img).map((f) => [f.path, img.slice(f.offset, f.offset + f.size)]));
    const ng = files(EMU.STANDIN_ARCHIVES['000400db00010302']());
    const ngOk = Object.keys(ng).length === 18 && ng['version.dat'].length === 4 && ng['16.txt'][0] === 0xFF && ng['16.txt'][1] === 0xFE;
    const font = files(EMU.STANDIN_ARCHIVES['0004009b00014002']())['cbf_std.bcfnt.lz'];
    const fontRaw = EMU.buildStandinFont(0, false), fontOut = font && lz11(font);
    const fontOk = !!fontOut && fontOut.length === fontRaw.length && fontOut.every((v, i) => v === fontRaw[i]) && String.fromCharCode(...fontOut.subarray(0, 4)) === 'CFNT';
    return ngOk && fontOk && EMU.listRomfs(EMU.buildEmptyArchive()).length === 0;
  }],
  ...['tests/roms/cpu-O2.3dsx', 'tests/roms/cpu-O0.3dsx', 'tests/roms/thumb.3dsx', 'tests/roms/thread-basic.3dsx', 'demo/demo.3dsx'].map((rom) => [
    `ARM block compiler matches the interpreter in lockstep: ${path.basename(rom)}`, () => lockstep(rom, 90, (f) => (f > 30 ? EMU.KEYS.DRIGHT : 0))]),
  ['ARM block compiler matches the interpreter on 3000 random instruction sequences', () => {
    const err = require(path.join(ROOT, 'tests/cpu/armfuzz.js'))(EMU).check(3000);
    if (err) console.log(`    ${err.split('\n')[0]}`);
    return !err;
  }],
  ...require(path.join(ROOT, 'tests/gpu/scenes.js'))(EMU).tests,
  ...(() => { // GPU regression scenes (reference vs compiled rasterizer, golden hashes)
    const helpers = require(path.join(ROOT, 'tests/gpu/scenes.js'))(EMU);
    return require(path.join(ROOT, 'tests/gpu/regress.js'))(EMU, helpers).tests;
  })(),
  ['GPU: shader compiler matches the interpreter on 2000 random programs', () => {
    const err = require(path.join(ROOT, 'tests/gpu/shaderfuzz.js'))(EMU).check(2000);
    if (err) console.log(`    ${err.split('\n')[0]}`);
    return !err;
  }],
];

// Run a ROM twice, with and without the ARM block compiler, and compare the machine state after every frame
// and all of memory at the end.
function lockstep(rom, frames, keys) {
  const realNow = Date.now;
  Date.now = () => 1760000000000; // same clock for both runs (the shared page holds the time)
  try {
    const make = (jit) => {
      const s = { debug: '' };
      s.emu = new EMU.Emulator({ onDebug: (t) => { s.debug += t; }, onHalt: () => {} });
      s.emu.load(new Uint8Array(fs.readFileSync(path.join(ROOT, rom))), path.basename(rom));
      s.emu.cpu.jit = jit;
      return s;
    };
    const a = make(false), b = make(true);
    b.emu.cpu.jitThreshold = 2; // compile nearly everything, to test as much compiled code as possible
    const state = ({ emu, debug }) => [emu.insnCount, emu.halted, emu.kernel.current && emu.kernel.current.id, emu.cpu.pc, emu.cpu.getCPSR(), ...emu.cpu.r, ...emu.cpu.fu, debug.length].join(',');
    const px = [new Uint8ClampedArray(400 * 240 * 4), new Uint8ClampedArray(400 * 240 * 4)];
    for (let f = 0; f < frames; f++) {
      for (const s of [a, b]) { s.emu.input.keys = keys(f); s.emu.runFrame(); }
      if (state(a) !== state(b)) { console.log(`    frame ${f}: states differ`); return false; }
      if (f % 15 === 14) {
        a.emu.renderScreen(0, px[0]); b.emu.renderScreen(0, px[1]);
        if (!px[0].every((v, i) => v === px[1][i])) { console.log(`    frame ${f}: screens differ`); return false; }
      }
    }
    for (const reg of a.emu.mem.regions) {
      const x = a.emu.mem.readBytes(reg.base, reg.size), y = b.emu.mem.readBytes(reg.base, reg.size);
      if (!x.every((v, i) => v === y[i])) { console.log(`    memory differs in ${reg.name || EMU.hex(reg.base)}`); return false; }
    }
    return a.debug === b.debug && b.emu.cpu.blocksCompiled > 0; // and the compiler was actually used
  } finally {
    Date.now = realNow;
  }
}

let failed = 0;
for (const [name, fn] of tests) {
  let ok = false, err = '';
  try { ok = fn(); } catch (e) { err = ` (${e.message})`; }
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${err}`);
}
console.log(failed ? `\n${failed} test(s) failed` : '\nAll tests passed');
process.exit(failed ? 1 : 0);

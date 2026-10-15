// Headless runner: node tools/run.js <app.3dsx|elf> [frames] [out-prefix] [--keys=A@60-70,...]
// Runs the emulator without a browser and writes PNG screenshots of both screens.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const zlib = require('zlib');

const SRC = path.join(__dirname, '..', 'src');
for (const f of ['memory.js', 'wasmjit.js', 'cpu.js', 'kernel.js', 'services.js', 'gpu.js', 'audio.js', 'sysdata.js', 'loader.js', 'emulator.js']) {
  vm.runInThisContext(fs.readFileSync(path.join(SRC, f), 'utf8'), { filename: f });
}
const EMU = globalThis.EMU;

function writePng(file, w, h, rgba) {
  const crcTable = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; return c; });
  const crc = (buf) => { let c = -1; for (const b of buf) c = crcTable[(c ^ b) & 0xFF] ^ (c >>> 8); return (c ^ -1) >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; Buffer.from(rgba.buffer, y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  fs.writeFileSync(file, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
}

const args = process.argv.slice(2);
const file = args[0];
const frames = parseInt(args[1] || '120', 10);
const out = args[2] || null;
const keyArg = (args.find((a) => a.startsWith('--keys=')) || '').slice(7);
const keyPlan = keyArg ? keyArg.split(',').map((s) => { const [k, range] = s.split('@'); const [a, b] = range.split('-').map(Number); return { k, a, b }; }) : [];

let debugText = '';
const emu = new EMU.Emulator({
  onLog: (m) => console.log('[log]', m),
  onDebug: (s) => { debugText += s; process.stdout.write('[dbg] ' + s + (s.endsWith('\n') ? '' : '\n')); },
  onHalt: (r) => console.log('[halt]', r),
});
emu.load(new Uint8Array(fs.readFileSync(file)), path.basename(file));
const t0 = Date.now();
for (let f = 0; f < frames && !emu.halted; f++) {
  emu.input.keys = 0;
  for (const p of keyPlan) if (f >= p.a && f <= p.b) emu.input.keys |= EMU.KEYS[p.k];
  emu.runFrame();
}
const dt = (Date.now() - t0) / 1000;
console.log(`[stats] frames=${emu.frame} insns=${emu.insnCount} time=${dt.toFixed(2)}s MIPS=${(emu.insnCount / dt / 1e6).toFixed(1)} threads=${emu.kernel.threads.map((t) => `${t.id}:${t.state}@${t.prio.toString(16)}`).join(' ')}`);
if (!emu.halted) console.log('[pc]', EMU.hex(emu.cpu.pc), emu.cpu.t ? 'thumb' : 'arm');
if (out) {
  for (const s of [0, 1]) {
    const W = s ? 320 : 400;
    const px = new Uint8ClampedArray(W * 240 * 4);
    const ok = emu.renderScreen(s, px);
    writePng(`${out}-${s ? 'bottom' : 'top'}.png`, W, 240, new Uint8Array(px.buffer));
    console.log(`[screen] ${s ? 'bottom' : 'top'} ${ok ? 'rendered' : 'no framebuffer'}`);
  }
}

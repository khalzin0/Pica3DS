// Frame-time benchmark: node tools/bench.js <rom> [--frames=N] [--skip=M] [--keys=A@60-70,...] [--3d] [--present] [--json=out.json]
//   [--no-cpu-jit] [--no-shader-jit] [--no-raster-jit]  run with an interpreter instead of the matching compiler
// Runs a ROM headless and reports per-frame wall-clock statistics for frames after --skip (warm-up / boot),
// split into CPU (+ kernel and services), GPU command lists and GX transfers. Frames are emulated one after
// another as fast as possible, so these numbers measure emulation cost, not browser presentation.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, '..', 'src');
for (const f of ['memory.js', 'cpu.js', 'kernel.js', 'services.js', 'gpu.js', 'audio.js', 'sysdata.js', 'loader.js', 'emulator.js']) {
  vm.runInThisContext(fs.readFileSync(path.join(SRC, f), 'utf8'), { filename: f });
}
const EMU = globalThis.EMU;

const BUDGET = 1000 / 59.83;

function percentile(sorted, p) { return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p / 100 * sorted.length))] : 0; }

function summarize(times) {
  const s = Float64Array.from(times).sort();
  const n = s.length, sum = s.reduce((a, b) => a + b, 0), avg = sum / (n || 1);
  const variance = s.reduce((a, b) => a + (b - avg) * (b - avg), 0) / (n || 1);
  return {
    frames: n, avg, median: percentile(s, 50), p95: percentile(s, 95), p99: percentile(s, 99), max: s[n - 1] || 0,
    stddev: Math.sqrt(variance), slow: times.filter((t) => t > BUDGET).length, fps: n ? 1000 / avg : 0,
  };
}

// Run `rom` and collect per-frame timings. Exported for tools that compare runs.
function bench(rom, { frames = 600, skip = 0, keys = [], filter = null, present = false, jit = {} } = {}) {
  const emu = new EMU.Emulator({ onLog: () => {}, onHalt: (r) => console.log('[halt]', r.split('\n')[0]) });
  emu.load(new Uint8Array(fs.readFileSync(rom)), path.basename(rom));
  // Each compiler can be switched off (the interpreters give the same results, slower)
  if (jit.cpu === false) emu.cpu.jit = false;
  if (process.env.JIT_THRESHOLD) emu.cpu.jitThreshold = +process.env.JIT_THRESHOLD;
  if (jit.shader === false) emu.gpu.vs.jit = false;
  if (jit.raster === false) emu.gpu.rasterJit = false;
  const rows = [];
  const top = new Uint8ClampedArray(400 * 240 * 4), bottom = new Uint8ClampedArray(320 * 240 * 4);
  const t0 = EMU.now();
  for (let f = 0; f < frames && !emu.halted; f++) {
    emu.input.keys = 0;
    for (const p of keys) if (f >= p.a && f <= p.b) emu.input.keys |= EMU.KEYS[p.k];
    const tri = emu.gpu.stats.triangles, frags = emu.gpu.stats.fragments, draws = emu.gpu.stats.draws, insns = emu.insnCount;
    emu.runFrame();
    let presentMs = 0;
    if (present) { // what the browser front-end does after each frame (minus the canvas upload)
      const tp = EMU.now();
      emu.renderScreen(0, top); emu.renderScreen(1, bottom);
      presentMs = EMU.now() - tp;
    }
    if (f < skip) continue;
    const p = emu.perf;
    const row = { f, frame: p.frame, present: presentMs, gpu: p.gpu, xfer: p.xfer, cpu: p.frame - p.gpu - p.xfer, tris: emu.gpu.stats.triangles - tri, frags: emu.gpu.stats.fragments - frags, draws: emu.gpu.stats.draws - draws, insns: emu.insnCount - insns };
    if (!filter || filter(row)) rows.push(row);
  }
  return { emu, rows, wall: EMU.now() - t0 };
}

function report(name, rows) {
  const ms = (v) => v.toFixed(2).padStart(7);
  const total = summarize(rows.map((r) => r.frame));
  const part = (k) => rows.reduce((a, r) => a + r[k], 0) / (rows.length || 1);
  const insns = rows.reduce((a, r) => a + r.insns, 0), cpuMs = rows.reduce((a, r) => a + r.cpu, 0);
  console.log(`${name}: ${total.frames} frames`);
  console.log(`  frame time ms  avg${ms(total.avg)}  median${ms(total.median)}  p95${ms(total.p95)}  p99${ms(total.p99)}  max${ms(total.max)}  stddev${ms(total.stddev)}`);
  console.log(`  emulation rate ${total.fps.toFixed(1)} frames/s (${(total.fps / 59.83 * 100).toFixed(0)}% of real time), ${total.slow} frames over ${BUDGET.toFixed(2)} ms`);
  if (rows.some((r) => r.present)) console.log(`  screen conversion ms/frame ${ms(part('present'))} (not included in frame time)`);
  console.log(`  split ms/frame cpu${ms(part('cpu'))}  gpu${ms(part('gpu'))}  xfer${ms(part('xfer'))}   per frame: ${part('draws').toFixed(0)} draws, ${part('tris').toFixed(0)} triangles, ${(part('frags') / 1000).toFixed(0)}k fragments   CPU ${cpuMs > 0 ? (insns / cpuMs / 1000).toFixed(1) : '-'} MIPS`);
  return { ...total, cpu: part('cpu'), gpu: part('gpu'), xfer: part('xfer') };
}

module.exports = { bench, summarize, report };

if (require.main === module) {
  const args = process.argv.slice(2);
  const opt = (k, d) => { const a = args.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };
  const rom = args.find((a) => !a.startsWith('--')) || path.join(__dirname, '..', 'demo', 'demo.3dsx');
  const keys = (opt('keys', '') || '').split(',').filter(Boolean).map((s) => { const [k, r] = s.split('@'); const [a, b] = r.split('-').map(Number); return { k, a, b }; });
  const frames = +opt('frames', 600), skip = +opt('skip', 60);
  const only3d = args.includes('--3d'); // only count frames that drew triangles
  const jit = { cpu: !args.includes('--no-cpu-jit'), shader: !args.includes('--no-shader-jit'), raster: !args.includes('--no-raster-jit') };
  const { rows, wall } = bench(rom, { frames, skip, keys, filter: only3d ? (r) => r.tris > 0 : null, present: args.includes('--present'), jit });
  const res = report(path.basename(rom) + (only3d ? ' (frames with 3D)' : ''), rows);
  console.log(`  wall ${(wall / 1000).toFixed(1)} s`);
  const out = opt('json', '');
  if (out) fs.writeFileSync(out, JSON.stringify({ rom: path.basename(rom), node: process.version, ...res, rows }, null, 1));
}

// Shader compiler fuzz test: random PICA shader programs (arithmetic, MAD, CMP, if/else, loops, calls,
// conditional jumps and breaks, relative addressing, geometry shader EMIT/SETEMIT, special float values) run through the interpreter
// and through the compiler; every output and temporary register must match bit for bit (any NaN matches
// any NaN).
//   node tests/gpu/shaderfuzz.js [programs]
'use strict';

module.exports = (EMU) => {
  function rng(seed) {
    return () => {
      seed = (seed + 0x6D2B79F5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const ARITH = [0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0A, 0x0B, 0x0C, 0x0D, 0x0E, 0x0F, 0x12, 0x13, 0x18, 0x19, 0x1A, 0x1B, 0x21];
  const SPECIAL = [0, -0, 0, -0, NaN, Infinity, -Infinity, 1e30, -1e-30, 1, -1, 0.5, 2, 127.99, -200, 3.4e38];

  function program(r) {
    const code = [], subs = [];
    const pick = (a) => a[r() * a.length | 0];
    const reg7 = () => (r() < 0.5 ? r() * 32 | 0 : 0x20 + (r() * 96 | 0)); // v/r or uniform
    const reg5 = () => r() * 32 | 0;
    const dst = () => (r() < 0.5 ? r() * 8 | 0 : 0x10 + (r() * 16 | 0));
    const desc7 = () => r() * 128 | 0, desc5 = () => r() * 32 | 0;
    const idx = () => (r() < 0.6 ? 0 : 1 + (r() * 3 | 0));
    const flowCond = () => ((r() < 0.5 ? 1 : 0) << 25) | ((r() < 0.5 ? 1 : 0) << 24) | ((r() * 4 | 0) << 22);
    function arith() {
      const k = r();
      if (k < 0.12) { // MAD / MADI
        const madi = r() < 0.4;
        return madi ? ((6 << 29) | (dst() << 24) | (idx() << 22) | (reg5() << 17) | (reg5() << 12) | (reg7() << 5) | desc5()) >>> 0
          : ((7 << 29) | (dst() << 24) | (idx() << 22) | (reg5() << 17) | (reg7() << 10) | (reg5() << 5) | desc5()) >>> 0;
      }
      if (k < 0.2) return ((0x17 << 27) | ((r() * 8 | 0) << 24) | ((r() * 8 | 0) << 21) | (idx() << 19) | (reg7() << 12) | (reg5() << 7) | desc7()) >>> 0;
      const op = pick(ARITH), inv = op >= 0x18 && op <= 0x1B;
      return ((op << 26) | (dst() << 21) | (idx() << 19) | (inv ? (reg5() << 14) | (reg7() << 7) : (reg7() << 12) | (reg5() << 7)) | desc7()) >>> 0;
    }
    const flow = (op, target, num, extra) => ((op << 26) | extra | (target << 10) | num) >>> 0;
    // Emit a block of instructions; returns nothing, appends to code
    function block(depth, inLoop) {
      const n = 1 + (r() * 6 | 0);
      for (let i = 0; i < n; i++) {
        const k = r();
        if (depth < 3 && k < 0.12) { // if/else
          const at = code.length; code.push(0);
          block(depth + 1, inLoop);
          const elseAt = code.length;
          const hasElse = r() < 0.5;
          if (hasElse) block(depth + 1, inLoop);
          const num = code.length - elseAt;
          const ifu = r() < 0.5;
          code[at] = flow(ifu ? 0x27 : 0x28, elseAt, num, ifu ? (r() * 16 | 0) << 22 : flowCond());
        } else if (depth < 3 && k < 0.22) { // loop
          const at = code.length; code.push(0);
          block(depth + 1, true);
          code[at] = flow(0x29, code.length - 1, 0, (r() * 4 | 0) << 22);
        } else if (k < 0.27 && subs.length) { // call a subroutine
          const s = pick(subs), kind = r() * 3 | 0;
          code.push({ call: s, kind, extra: kind === 0 ? 0 : kind === 1 ? flowCond() : (r() * 16 | 0) << 22 });
        } else if (depth < 3 && k < 0.31) { // forward conditional jump
          const at = code.length; code.push(0);
          block(depth + 1, inLoop);
          const uni = r() < 0.5;
          code[at] = flow(uni ? 0x2D : 0x2C, code.length, r() * 2 | 0, uni ? (r() * 16 | 0) << 22 : flowCond());
        } else if (inLoop && k < 0.34) {
          code.push(r() < 0.5 ? flow(0x20, 0, 0, 0) : flow(0x23, 0, 0, flowCond()));
        } else if (k < 0.4) { // geometry shader emitter
          code.push(r() < 0.5 ? flow(0x2B, 0, 0, (r() * 64 | 0) << 22) : flow(0x2A, 0, 0, 0));
        } else code.push(arith());
      }
    }
    // Subroutines are placed first and jumped over
    const subCount = r() * 3 | 0;
    const jmpAt = code.length;
    if (subCount) code.push(0);
    for (let i = 0; i < subCount; i++) {
      const start = code.length;
      const n = 1 + (r() * 5 | 0);
      for (let k = 0; k < n; k++) code.push(arith());
      subs.push({ start, num: code.length - start });
    }
    const entry = subCount ? jmpAt : 0;
    if (subCount) code[jmpAt] = flow(0x2C, code.length, 0, 2 << 22); // JMPC if cx == false (it starts false): skip the subroutines
    block(0, false);
    code.push(0x22 << 26);
    const words = code.map((c) => (typeof c === 'number' ? c : flow([0x24, 0x25, 0x26][c.kind], c.call.start, c.call.num, c.extra)));
    return { words, entry };
  }

  function setup(unit, prog, r, seedVals) {
    unit.code.fill(0); unit.code.set(prog.words);
    for (let i = 0; i < 128; i++) {
      const sel = () => r() * 256 | 0;
      unit.swizzle[i] = ((r() * 16 | 0) | ((r() < 0.3 ? 1 : 0) << 4) | (sel() << 5) | ((r() < 0.3 ? 1 : 0) << 13) | (sel() << 14) | ((r() < 0.3 ? 1 : 0) << 22) | (sel() << 23)) >>> 0;
    }
    unit.R.set(seedVals);
    const bools = r() * 0x10000 | 0, ints = [];
    for (let k = 0; k < 4; k++) ints.push(r() * 4 | 0, r() * 8 | 0, (r() * 5 | 0) - 2);
    unit.invalidate();
    unit.setUniforms(bools, ints);
  }

  function check(count = 2000, seed = 1) {
    const r = rng(seed);
    let flat = 0;
    const a = new EMU.ShaderUnit('interp'), b = new EMU.ShaderUnit('jit');
    a.jit = false;
    // Record every EMIT: the selected slot and flags, and the output registers at that point
    for (const u of [a, b]) u.onEmit = (unit) => unit.emits.push([unit.emitVtx, unit.emitPrim, unit.emitWinding, ...unit.O].join(','));
    const bitsA = new Uint32Array(a.R.buffer), bitsB = new Uint32Array(b.R.buffer);
    const oA = new Uint32Array(a.O.buffer), oB = new Uint32Array(b.O.buffer);
    for (let p = 0; p < count; p++) {
      const prog = program(r);
      const vals = new Float32Array(512);
      for (let i = 0; i < 512; i++) vals[i] = r() < 0.3 ? SPECIAL[r() * SPECIAL.length | 0] : (r() - 0.5) * (r() < 0.2 ? 1000 : 8);
      const swzSeed = (r() * 0xFFFFFFFF) >>> 0;
      setup(a, prog, rng(swzSeed), vals);
      setup(b, prog, rng(swzSeed), vals);
      for (let v = 0; v < 3; v++) { // several vertices: temporaries carry over between runs
        if (v === 2) { // new uniform values: compiled programs are specialised on them
          const ints = Array.from({ length: 12 }, (_, k) => (k % 3 === 0 ? r() * 4 | 0 : k % 3 === 1 ? r() * 8 | 0 : (r() * 5 | 0) - 2));
          const bools = r() * 0x10000 | 0;
          a.setUniforms(bools, ints); b.setUniforms(bools, ints);
        }
        for (let i = 0; i < 64; i++) { const x = (r() - 0.5) * 10; a.R[i] = x; b.R[i] = x; }
        a.O.fill(0); b.O.fill(0);
        a.emits = []; b.emits = [];
        a.run(prog.entry); b.run(prog.entry);
        if (b.compiled.get(prog.entry).flat) flat++;
        if (a.emits.join(';') !== b.emits.join(';')) return `program ${p} vertex ${v}: emitted vertices differ (${a.emits.length} / ${b.emits.length})`;
        // NaN sign and payload bits are not observable (shader results are only used as numbers)
        const same = (x, y, fx) => x === y || fx !== fx;
        for (let i = 0; i < 512; i++) if (!same(bitsA[i], bitsB[i], a.R[i]) || (a.R[i] !== a.R[i]) !== (b.R[i] !== b.R[i])) return `program ${p} vertex ${v}: R[${i}] interpreter ${a.R[i]} compiler ${b.R[i]}\n${prog.words.map((w) => w.toString(16)).join(' ')}`;
        for (let i = 0; i < 64; i++) if (!same(oA[i], oB[i], a.O[i]) || (a.O[i] !== a.O[i]) !== (b.O[i] !== b.O[i])) return `program ${p} vertex ${v}: O[${i}] interpreter ${a.O[i]} compiler ${b.O[i]}\n${prog.words.map((w) => w.toString(16)).join(' ')}`;
      }
    }
    check.flat = flat;
    return null;
  }

  return { check };
};

if (require.main === module) {
  const fs = require('fs'), path = require('path'), vm = require('vm');
  for (const f of ['memory.js', 'gpu.js']) vm.runInThisContext(fs.readFileSync(path.join(__dirname, '../../src', f), 'utf8'), { filename: f });
  const t0 = Date.now();
  const { check } = module.exports(globalThis.EMU);
  const n = +process.argv[2] || 2000, err = check(n);
  console.log(err ? `FAIL  ${err}` : `PASS  (${Date.now() - t0} ms, ${check.flat} of ${n * 3} runs used straight-line code)`);
}

// GPU regression scenes: larger randomized (but seeded, so deterministic) scenes that exercise many
// state combinations at 400x240. Each scene is rendered by the generic reference rasterizer and by the
// generated per-state rasterizers; both must produce identical color and depth/stencil bytes, and the
// result must match the golden hash recorded below. Used by tools/test.js; also runnable on its own:
//   node tests/gpu/regress.js            check
//   node tests/gpu/regress.js --update   print new golden hashes (only after verifying a change on purpose)
'use strict';
const crypto = require('crypto');

module.exports = (EMU, { Scene, Asm, toF24 }) => {
  const W = 400, H = 240;
  const COLOR = 0x1F000000, DEPTH = 0x1F100000;

  function rng(seed) { // mulberry32
    return () => {
      seed = (seed + 0x6D2B79F5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // Vertex shader: copy n inputs to n outputs
  function copyShader(s, n) {
    const a = new Asm();
    for (let i = 0; i < n; i++) a.mov(`o${i}`, `v${i}`);
    return s.shader(a.end());
  }

  // Inputs/outputs for `n` float4 attributes with the given output semantic maps
  function io(s, maps) {
    const n = maps.length;
    s.w(0x04F, n);
    s.w(0x050, ...maps);
    s.w(0x2B9, 0xA0000000 | (n - 1)).w(0x242, n - 1).w(0x2BB, 0x76543210 & ((1 << (n * 4)) - 1), 0).w(0x2BD, (1 << n) - 1);
    return copyShader(s, n);
  }
  const MAP_POS = 0x03020100, MAP_COLOR = 0x0B0A0908, MAP_UV0 = 0x1F1F0D0C, MAP_UV0W_UV1 = 0x0F0E1F10, MAP_UV2 = 0x1F1F1716;
  const MAP_QUAT = 0x07060504, MAP_VIEW = 0x1F141312;

  const fl = (r, a, b) => a + (b - a) * r();
  function randomVertex(r, { wide = false, extra = 0 } = {}) {
    const w = r() < 0.15 ? fl(r, 0.05, 0.4) : fl(r, 0.6, 2);
    const span = wide ? 3 : 1.1;
    const v = [[fl(r, -span, span) * w, fl(r, -span, span) * w, -fl(r, wide ? -0.2 : 0.02, 1.05) * w, w], [r(), r(), r(), r()]];
    for (let k = 0; k < extra; k++) v.push([fl(r, -1.5, 2.5), fl(r, -1.5, 2.5), fl(r, 0.5, 1.5), 1]);
    return v;
  }

  function randomBlend(s, r) {
    const blend = r() < 0.6;
    s.w(0x100, 0x00E40000 | (blend ? 0x100 : 0));
    s.w(0x101, (r() * 5 | 0) | ((r() * 5 | 0) << 8) | ((r() * 15 | 0) << 16) | ((r() * 15 | 0) << 20) | ((r() * 15 | 0) << 24) | ((r() * 15 | 0) << 28));
    s.w(0x102, blend ? 3 : r() * 16 | 0);
    s.w(0x103, (r() * 0xFFFFFFFF) >>> 0);
  }

  function randomTev(s, r, sources) {
    const regs = [0x0C0, 0x0C8, 0x0D0, 0x0D8, 0x0F0, 0x0F8];
    const n = 1 + (r() * 6 | 0);
    regs.forEach((reg, i) => {
      if (i >= n) { s.w(reg, 0x000F000F, 0, 0, 0, 0); return; }
      const src = () => (i === 0 ? sources[r() * sources.length | 0] : [...sources, 15, 15, 13, 14][r() * (sources.length + 4) | 0]);
      const srcW = src() | (src() << 4) | (src() << 8) | (src() << 16) | (src() << 20) | (src() << 24);
      const opd = (r() * 16 | 0) | ((r() * 16 | 0) << 4) | ((r() * 16 | 0) << 8) | ((r() * 8 | 0) << 12) | ((r() * 8 | 0) << 16) | ((r() * 8 | 0) << 20);
      const cmbs = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
      const rgbC = cmbs[r() * 10 | 0], aC = cmbs[r() * 6 | 0];
      s.w(reg, srcW >>> 0, opd >>> 0, rgbC | (aC << 16), (r() * 0xFFFFFFFF) >>> 0, (r() * 3 | 0) | ((r() * 3 | 0) << 16));
    });
    s.w(0x0E0, ((r() * 16 | 0) << 8) | ((r() * 16 | 0) << 12)).w(0x0FD, (r() * 0xFFFFFFFF) >>> 0);
  }

  function randomTexture(s, r, unit) {
    const fmt = r() * 14 | 0, size = [8, 16, 32, 64][r() * 4 | 0], h = [8, 16, 32][r() * 3 | 0];
    const bits = [32, 24, 16, 16, 16, 16, 16, 8, 8, 8, 4, 4, 4, 8][fmt];
    const bytes = new Uint8Array(size * h * bits / 8);
    for (let i = 0; i < bytes.length; i++) bytes[i] = r() * 256;
    const addr = s.phys(s.data(bytes));
    const [border, dim, param, adr, f] = [[0x081, 0x082, 0x083, 0x085, 0x08E], [0x091, 0x092, 0x093, 0x095, 0x096], [0x099, 0x09A, 0x09B, 0x09D, 0x09E]][unit];
    const linear = r() < 0.5 ? 2 : 0, wrapS = r() * 4 | 0, wrapT = r() * 4 | 0;
    s.w(border, (r() * 0xFFFFFFFF) >>> 0).w(dim, h | (size << 16)).w(param, linear | (wrapT << 8) | (wrapS << 12) | (unit === 0 && r() < 0.3 ? 3 << 28 : 0));
    s.w(adr, addr >>> 3).w(f, fmt);
  }

  function drawRandom(s, r, count, opts) {
    const verts = [];
    for (let i = 0; i < count * 3; i++) verts.push(randomVertex(r, opts));
    s.vertices(verts, verts[0].length).drawArrays(verts.length);
  }

  function target(s, colorFmt = 0, depthFmt = 3) {
    s.w(0x116, depthFmt).w(0x117, (colorFmt << 16) | 2);
  }

  const scenes = [];
  const scene = (name, golden, fn) => scenes.push({ name, golden, fn });

  scene('depth-tested colored triangles with clipping', '85edfa796754dc530997fde74ece0c0c', (s, r) => {
    io(s, [MAP_POS, MAP_COLOR]);
    for (let d = 0; d < 12; d++) {
      s.w(0x107, 0x1F00 | 1 | ((r() * 8 | 0) << 4) | (r() < 0.2 ? 0 : 0x1000));
      s.w(0x040, r() * 3 | 0);
      drawRandom(s, r, 25, { wide: d % 3 === 0 });
    }
  });

  scene('textures: all formats, filters, wraps and projection', '8a36f1c13daea94a3c8e05ffd79f0399', (s, r) => {
    io(s, [MAP_POS, MAP_COLOR, MAP_UV0, MAP_UV0W_UV1, MAP_UV2]);
    s.w(0x107, 0x1F00 | 1 | (5 << 4));
    for (let d = 0; d < 16; d++) {
      const units = 1 + (r() * 7 | 0);
      for (let t = 0; t < 3; t++) if (units & (1 << t)) randomTexture(s, r, t);
      s.w(0x080, units | (r() < 0.3 ? 1 << 13 : 0));
      randomTev(s, r, [0, 3, 4, 5]);
      randomBlend(s, r);
      drawRandom(s, r, 8, { extra: 3 });
    }
  });

  scene('texture edge cases: NaN, infinite and huge coordinates, non-power-of-two sizes', '11c7a635347d63a3bd4f6bd28f5d16f7', (s, r) => {
    io(s, [MAP_POS, MAP_COLOR, MAP_UV0]);
    s.w(0x0C0, 3 | (3 << 16), 0, 0, 0, 0);
    const odd = [NaN, Infinity, -Infinity, 1e9, -1e9, 3e12, -7.25e10, 0.5];
    for (let d = 0; d < 24; d++) {
      const pow2 = d % 2 === 0, w = pow2 ? 16 : [24, 40, 8][d % 3], h = pow2 ? 32 : [8, 24, 56][(d >> 1) % 3];
      const bytes = new Uint8Array(w * h * 4);
      for (let i = 0; i < bytes.length; i++) bytes[i] = r() * 256;
      const addr = s.phys(s.data(bytes));
      s.w(0x080, 1).w(0x081, 0xFF00FF00).w(0x082, h | (w << 16), (d >> 2 & 1 ? 2 : 0) | ((d >> 1 & 3) << 8) | ((d >> 3 & 3) << 12)).w(0x085, addr >>> 3).w(0x08E, 0);
      const verts = [];
      for (let i = 0; i < 18; i++) {
        const v = randomVertex(r);
        const uv = [r() < 0.3 ? odd[r() * 8 | 0] : fl(r, -3, 3), r() < 0.3 ? odd[r() * 8 | 0] : fl(r, -3, 3), 0, 1];
        verts.push([v[0], v[1], uv]);
      }
      s.vertices(verts, 3).drawArrays(verts.length);
    }
  });

  scene('blending, logic ops, alpha test and color masks in every color format', '72097aebdc37da62352fd358cffc6d62', (s, r) => {
    io(s, [MAP_POS, MAP_COLOR]);
    for (let d = 0; d < 20; d++) {
      target(s, d % 5, 3);
      randomBlend(s, r);
      s.w(0x104, (r() < 0.5 ? 1 : 0) | ((r() * 8 | 0) << 4) | ((r() * 256 | 0) << 8));
      s.w(0x107, ((r() * 16 | 0) << 8) | 0x1000 | (r() < 0.5 ? 1 | (1 << 4) : 0));
      randomTev(s, r, [0]);
      drawRandom(s, r, 6);
    }
  });

  scene('stencil, scissor and culling', 'acd0d4f7701066ecd8ebea802aa9f036', (s, r) => {
    io(s, [MAP_POS, MAP_COLOR]);
    for (let d = 0; d < 20; d++) {
      s.w(0x105, (r() < 0.8 ? 1 : 0) | ((r() * 8 | 0) << 4) | ((r() * 256 | 0) << 8) | ((r() * 4 | 0) << 16) | ((r() * 256 | 0) << 24));
      s.w(0x106, (r() * 8 | 0) | ((r() * 8 | 0) << 4) | ((r() * 8 | 0) << 8));
      s.w(0x107, ((r() * 16 | 0) << 8) | (r() < 0.5 ? 0x1000 : 0) | (r() < 0.7 ? 1 : 0) | ((r() * 8 | 0) << 4));
      const x0 = r() * 300 | 0, y0 = r() * 200 | 0;
      s.w(0x065, [0, 1, 3][r() * 3 | 0], x0 | (y0 << 16), (x0 + (r() * 200 | 0)) | ((y0 + (r() * 100 | 0)) << 16));
      s.w(0x040, r() * 3 | 0);
      drawRandom(s, r, 6);
    }
  });

  scene('fog and 16/24-bit depth', '2786687820afc1a6bd9d43e7c16ef3ab', (s, r) => {
    io(s, [MAP_POS, MAP_COLOR]);
    s.w(0x0E6, 0);
    for (let i = 0; i < 128; i += 8) {
      const e = [];
      for (let k = 0; k < 8; k++) { const v = Math.round((1 - (i + k) / 128) * 2047); e.push(((v << 13) | ((-16) & 0x1FFF)) >>> 0); }
      for (const v of e) s.w(0x0E8, v);
    }
    for (let d = 0; d < 10; d++) {
      target(s, 0, d < 5 ? 0 : 2);
      s.w(0x0E1, (r() * 0xFFFFFF) >>> 0);
      randomTev(s, r, [0]);
      s.w(0x0E0, 5 | (d & 1 ? 1 << 16 : 0) | ((r() * 16 | 0) << 8));
      s.w(0x107, 0x1F00 | 1 | (5 << 4));
      drawRandom(s, r, 8);
    }
  });

  scene('fragment lighting', 'fa10bb280ab6c0bb7e2ca8f473b802c5', (s, r) => {
    io(s, [MAP_POS, MAP_COLOR, MAP_QUAT, MAP_VIEW]);
    // LUT D0 (0) and RR (6): ramps
    for (const lut of [0, 6]) {
      s.w(0x1C5, lut << 8);
      for (let i = 0; i < 256; i += 8) {
        const e = [];
        for (let k = 0; k < 8; k++) e.push(Math.round((i + k) / 255 * 4095) | (16 << 12));
        for (const v of e) s.w(0x1C8, v);
      }
    }
    s.w(0x08F, 1).w(0x1C0, 0x02008020);
    const f16 = (x) => { if (x === 0) return 0; const sgn = x < 0 ? 0x8000 : 0; x = Math.abs(x); const e = Math.floor(Math.log2(x)); return sgn | ((e + 15) << 10) | Math.round((x / 2 ** e - 1) * 1024); };
    for (let d = 0; d < 8; d++) {
      const num = r() * 3 | 0;
      for (let l = 0; l <= num; l++) {
        const b = 0x140 + l * 0x10;
        s.w(b, 0x3FF00000, 0x000FFC00, (r() * 0x3FFFFFFF) >>> 0, 0x04010040);
        s.w(b + 4, f16(fl(r, -1, 1)) | (f16(fl(r, -1, 1)) << 16), f16(fl(r, 0.2, 1)));
        s.w(b + 9, (r() < 0.5 ? 1 : 0) | (r() < 0.5 ? 2 : 0) | (r() < 0.3 ? 4 : 0));
      }
      s.w(0x1C2, num).w(0x1D9, 0x76543210);
      s.w(0x1C3, ((r() < 0.5 ? 0 : 1) << 4) | (r() < 0.5 ? 1 << 30 : 0) | (r() < 0.3 ? 1 << 27 : 0));
      s.w(0x1C4, 0xFF00 | 0xFF000000 | (r() < 0.5 ? 1 << 20 : 0));
      s.w(0x1D0, (r() * 0xFFFFFFF) & 0x2222222).w(0x1D1, (r() * 4 | 0) | ((r() * 4 | 0) << 24)).w(0x1D2, 0);
      s.w(0x0C0, 1 | (2 << 4) | (1 << 16) | (2 << 20), 0, 2 | (2 << 16), 0, 0);
      s.w(0x107, 0x1F00 | 1 | (5 << 4));
      const verts = [];
      for (let i = 0; i < 24; i++) {
        const v = randomVertex(r);
        const q = [fl(r, -1, 1), fl(r, -1, 1), fl(r, -1, 1), fl(r, -1, 1)];
        verts.push([v[0], v[1], q, [fl(r, -2, 2), fl(r, -2, 2), fl(r, -3, -0.5), 0]]);
      }
      s.vertices(verts, 4).drawArrays(verts.length);
    }
  });

  // configure(scene) runs before drawing (e.g. to attach a WebGL renderer)
  function render(sc, jit, configure) {
    const s = new Scene({ w: W, h: H });
    s.gpu.rasterJit = jit;
    if (configure) configure(s);
    const r = rng([...sc.name].reduce((h, c) => Math.imul(h, 31) + c.charCodeAt(0) | 0, 7));
    s.clear([20, 40, 60, 255], 0xFFFFFF, 0);
    s.setup();
    sc.fn(s, r);
    s.w(0x110, 1).run();
    if (s.gpu.gl) s.gpu.gl.syncToMemory(0, 0xFFFFFFFF);
    const md5 = crypto.createHash('md5');
    md5.update(s.mem.readBytes(COLOR, W * H * 4)).update(s.mem.readBytes(DEPTH, W * H * 4));
    return { hash: md5.digest('hex'), gpu: s.gpu, logs: s.logs, color: s.mem.readBytes(COLOR, W * H * 4), W, H };
  }

  const tests = scenes.map((sc) => [`GPU regression: ${sc.name}`, () => {
    const ref = render(sc, false), jit = render(sc, true);
    if (ref.hash !== jit.hash) { console.log(`    reference ${ref.hash} != compiled ${jit.hash}`); return false; }
    if (ref.hash !== sc.golden) { console.log(`    output ${ref.hash} != golden ${sc.golden}`); return false; }
    return true;
  }]);

  return { tests, scenes, render };
};

if (require.main === module) {
  const fs = require('fs'), path = require('path'), vm = require('vm');
  for (const f of ['memory.js', 'cpu.js', 'kernel.js', 'services.js', 'gpu.js']) vm.runInThisContext(fs.readFileSync(path.join(__dirname, '../../src', f), 'utf8'), { filename: f });
  const helpers = require('./scenes.js')(globalThis.EMU);
  const { tests, scenes, render } = module.exports(globalThis.EMU, helpers);
  if (process.argv.includes('--update')) {
    for (const sc of scenes) { const t0 = Date.now(); const a = render(sc, false); console.log(`'${a.hash}'  ${sc.name}  (${Date.now() - t0} ms, ${a.gpu.stats.triangles} triangles, ${a.gpu.stats.fragments} fragments)`); }
  } else {
    for (const [name, fn] of tests) console.log(`${fn() ? 'PASS' : 'FAIL'}  ${name}`);
  }
}

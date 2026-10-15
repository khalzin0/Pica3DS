// GPU (PICA200) tests: builds command lists and shader binaries by hand, renders them with EMU.Gpu
// into emulated VRAM and checks pixels. Used by tools/test.js; `node tests/gpu/scenes.js out-dir` writes PNGs.
'use strict';

module.exports = (EMU) => {
  const cvt = new DataView(new ArrayBuffer(4));
  const bitsOf = (f) => { cvt.setFloat32(0, f); return cvt.getUint32(0); };
  function toF24(f) {
    if (f === 0) return 0;
    const b = bitsOf(f), sign = b >>> 31, e = ((b >>> 23) & 0xFF) - 64, m = (b >>> 7) & 0xFFFF;
    if (e <= 0) return sign << 23;
    if (e >= 0x7F) return ((sign << 23) | (0x7F << 16)) >>> 0;
    return ((sign << 23) | (e << 16) | m) >>> 0;
  }

  // ---------------------------------------------------------------- tiny PICA shader assembler
  class Asm {
    constructor() { this.code = []; this.swz = []; this.labels = {}; }
    desc(mask = 'xyzw', s1 = 'xyzw', s2 = 'xyzw', s3 = 'xyzw') {
      const sel = (s) => { let neg = 0; if (s[0] === '-') { neg = 1; s = s.slice(1); } s = (s + s[s.length - 1].repeat(4)).slice(0, 4); let v = 0; for (const c of s) v = (v << 2) | 'xyzw'.indexOf(c); return [neg, v]; };
      let m = 0; for (const c of mask) m |= 8 >> 'xyzw'.indexOf(c);
      const [n1, v1] = sel(s1), [n2, v2] = sel(s2), [n3, v3] = sel(s3);
      const d = (m | (n1 << 4) | (v1 << 5) | (n2 << 13) | (v2 << 14) | (n3 << 22) | (v3 << 23)) >>> 0;
      let i = this.swz.indexOf(d);
      if (i < 0) { i = this.swz.length; this.swz.push(d); }
      return i;
    }
    static reg(r) {
      const n = parseInt(r.slice(1), 10);
      return { v: n, r: 0x10 + n, c: 0x20 + n, o: n }[r[0]] ?? (() => { throw new Error(r); })();
    }
    // name dst.mask, src1.swz, src2.swz
    op(opcode, dst, s1, s2 = 'r0', idx = 0) {
      const [d, dm = 'xyzw'] = dst.split('.'), [a, as = 'xyzw'] = s1.split('.'), [b, bs = 'xyzw'] = s2.split('.');
      const neg = (x) => x.startsWith('-');
      const ds = this.desc(dm, (neg(a) ? '-' : '') + as, (neg(b) ? '-' : '') + bs);
      if (Asm.reg(b.replace('-', '')) > 0x1F) throw new Error(`${b}: only src1 can be a uniform`);
      this.code.push(((opcode << 26) | (Asm.reg(d) << 21) | (idx << 19) | (Asm.reg(a.replace('-', '')) << 12) | (Asm.reg(b.replace('-', '')) << 7) | ds) >>> 0);
      return this;
    }
    mad(dst, s1, s2, s3) {
      const [d, dm = 'xyzw'] = dst.split('.'), [a, as = 'xyzw'] = s1.split('.'), [b, bs = 'xyzw'] = s2.split('.'), [c, cs = 'xyzw'] = s3.split('.');
      const ds = this.desc(dm, as, bs, cs);
      if (ds > 31) throw new Error('MAD descriptor index > 31');
      this.code.push(((7 << 29) | (Asm.reg(d) << 24) | (Asm.reg(a) << 17) | (Asm.reg(b) << 10) | (Asm.reg(c) << 5) | ds) >>> 0);
      return this;
    }
    mov(d, s, idx = 0) { return this.op(0x13, d, s, 'r0', idx); }
    setemit(vtx, prim = 0, winding = 0) { return this.flow(0x2B, 0, 0, (vtx << 2) | (prim << 1) | winding); }
    emit() { return this.flow(0x2A, 0, 0); }
    add(d, a, b) { return this.op(0x00, d, a, b); }
    mul(d, a, b) { return this.op(0x08, d, a, b); }
    dp4(d, a, b) { return this.op(0x02, d, a, b); }
    mova(s) { return this.op(0x12, 'r0.xy', s); }
    rcp(d, s) { return this.op(0x0E, d, s); }
    end() { this.code.push(0x22 << 26); return this; }
    flow(op, target, num, extra = 0) { this.code.push(((op << 26) | (extra << 22) | (target << 10) | num) >>> 0); return this; }
    label(name) { this.labels[name] = this.code.length; return this; }
    get pc() { return this.code.length; }
  }

  // ---------------------------------------------------------------- scene helper
  const W = 64, H = 64;
  const COLOR_PHYS = 0x18000000, DEPTH_PHYS = 0x18100000;

  class Scene {
    constructor({ w = W, h = H } = {}) {
      this.W = w; this.H = h;
      this.logs = [];
      const mem = new EMU.Memory();
      mem.alloc(0x1F000000, 0x600000, 3, 6, 'VRAM');
      mem.alloc(0x30000000, 0x400000, 3, 5, 'linear heap');
      this.mem = mem;
      this.emu = { mem, log: (m) => this.logs.push(m) };
      this.gpu = new EMU.Gpu(this.emu);
      this.cmds = [];
      this.next = 0x30000000;
      this.clear([0, 0, 0, 255], 0xFFFFFF, 0);
    }
    alloc(n) { const a = this.next; this.next += (n + 0xFF) & ~0xFF; return a; }
    phys(virt) { return virt - 0x10000000; }
    w(reg, ...vals) {
      this.cmds.push(vals[0] >>> 0, ((reg & 0x3FF) | (0xF << 16) | ((vals.length - 1) << 20) | (vals.length > 1 ? 0x80000000 : 0)) >>> 0);
      for (let i = 1; i < vals.length; i++) this.cmds.push(vals[i] >>> 0);
      if (this.cmds.length & 1) this.cmds.push(0);
      return this;
    }
    wm(reg, mask, val) { this.cmds.push(val >>> 0, ((reg & 0x3FF) | (mask << 16)) >>> 0); return this; }
    data(bytes) { const a = this.alloc(bytes.length); this.mem.writeBytes(a, bytes); return a; }
    floats(arr) { return this.data(new Uint8Array(new Float32Array(arr).buffer)); }
    run() {
      const words = new Uint32Array(this.cmds);
      const a = this.data(new Uint8Array(words.buffer));
      this.cmds = [];
      this.gpu.runCommandList(a, words.length * 4);
      return this;
    }
    clear(rgba, depth = 0xFFFFFF, stencil = 0) {
      const { W, H } = this;
      const c = new Uint8Array(W * H * 4), d = new Uint8Array(W * H * 4);
      for (let i = 0; i < W * H * 4; i += 4) {
        c.set([rgba[3], rgba[2], rgba[1], rgba[0]], i);
        d.set([depth & 0xFF, (depth >>> 8) & 0xFF, depth >>> 16, stencil], i);
      }
      this.mem.writeBytes(0x1F000000, c);
      this.mem.writeBytes(0x1F100000, d);
    }
    // Pixel at (x, y) with y = 0 at the bottom of the render target.
    offset(x, y) {
      const { W, H } = this;
      const fy = H - 1 - y;
      let m = 0;
      for (let i = 0; i < 3; i++) m |= (((x >> i) & 1) << (2 * i)) | (((fy >> i) & 1) << (2 * i + 1));
      return ((fy >> 3) * (W >> 3) + (x >> 3)) * 64 + m;
    }
    pixel(x, y) { const o = 0x1F000000 + this.offset(x, y) * 4; return [this.mem.r8(o + 3), this.mem.r8(o + 2), this.mem.r8(o + 1), this.mem.r8(o)]; }
    depthAt(x, y) { const o = 0x1F100000 + this.offset(x, y) * 4; return this.mem.r32(o) & 0xFFFFFF; }
    stencilAt(x, y) { return this.mem.r8(0x1F100000 + this.offset(x, y) * 4 + 3); }
    image() {
      const { W, H } = this;
      const px = new Uint8Array(W * H * 4);
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const c = this.pixel(x, H - 1 - y); px.set(c, (y * W + x) * 4); px[(y * W + x) * 4 + 3] = 255; }
      return px;
    }

    // Upload a shader program + swizzle table and set the entry point.
    shader(asm) {
      this.w(0x2CB, 0);
      for (let i = 0; i < asm.code.length; i += 8) this.w(0x2CC, ...asm.code.slice(i, i + 8));
      this.w(0x2D5, 0);
      for (let i = 0; i < asm.swz.length; i += 8) this.w(0x2D6, ...asm.swz.slice(i, i + 8));
      this.w(0x2BA, 0x7FFF0000);
      return this;
    }
    uniform(index, x, y, z, w) { return this.w(0x2C0, 0x80000000 | index).w(0x2C1, bitsOf(w), bitsOf(z), bitsOf(y), bitsOf(x)); }
    // Geometry shader program, swizzles, entry point and float uniforms
    gshader(asm) {
      this.w(0x29B, 0);
      for (let i = 0; i < asm.code.length; i += 8) this.w(0x29C, ...asm.code.slice(i, i + 8));
      this.w(0x2A5, 0);
      for (let i = 0; i < asm.swz.length; i += 8) this.w(0x2A6, ...asm.swz.slice(i, i + 8));
      this.w(0x28A, 0x7FFF0000);
      return this;
    }
    guniform(index, x, y, z, w) { return this.w(0x290, 0x80000000 | index).w(0x291, bitsOf(w), bitsOf(z), bitsOf(y), bitsOf(x)); }

    // Common state: 64x64 RGBA8 + D24S8 target, viewport, VS outputs o0 = pos, o1 = color, o2 = uv0.
    setup({ outputs = 3 } = {}) {
      const { W, H } = this;
      this.w(0x040, 0);                                   // no culling
      this.w(0x041, toF24(W / 2)).w(0x043, toF24(H / 2)); // viewport half size
      this.w(0x068, 0);
      this.w(0x04D, toF24(-1)).w(0x04E, 0);               // depth = -z/w
      this.w(0x04F, outputs);
      this.w(0x050, 0x03020100, 0x0B0A0908, 0x1F1F0D0C);  // pos, color, uv0
      this.w(0x065, 0);
      this.w(0x080, 0);
      // TEV: stage 0 = primary color, others pass through
      this.w(0x0C0, 0, 0, 0, 0, 0);
      for (const s of [0x0C8, 0x0D0, 0x0D8, 0x0F0, 0x0F8]) this.w(s, 0x000F000F, 0, 0, 0, 0);
      this.w(0x0E0, 0).w(0x0FD, 0);
      this.w(0x100, 0x00E40000).w(0x101, 0).w(0x102, 3).w(0x104, 0).w(0x105, 0).w(0x106, 0);
      this.w(0x107, 0x1F00);                               // color mask RGBA, depth write, no depth test
      this.w(0x112, 0xF, 0xF, 3, 3);                       // color/depth read+write allowed
      this.w(0x116, 3).w(0x117, 2);                        // D24S8, RGBA8
      this.w(0x11C, DEPTH_PHYS >>> 3, COLOR_PHYS >>> 3, W | ((H - 1) << 12) | (1 << 24));
      this.w(0x08F, 0);
      // VS: three float4 inputs mapped to v0..v2, outputs o0..o2
      this.w(0x2B9, 0xA0000000 | 2).w(0x242, 2).w(0x2BB, 0x210, 0).w(0x2BD, (1 << outputs) - 1);
      this.w(0x25E, 0);
      return this;
    }
    passthroughShader() {
      return this.shader(new Asm().mov('o0', 'v0').mov('o1', 'v1').mov('o2', 'v2').end());
    }
    // Vertex buffer of float4 attributes (pos, color, uv) per vertex
    vertices(verts, perVertex = 3) {
      const flat = [];
      for (const v of verts) for (let a = 0; a < perVertex; a++) flat.push(...(v[a] || [0, 0, 0, 1]));
      const addr = this.phys(this.floats(flat));
      this.vertexBase = addr;
      this.w(0x200, addr >>> 3);
      const fmt = (1 << perVertex * 4) - 1; // all float4
      this.w(0x201, fmt & 0xFFFFFFFF, ((perVertex - 1) << 28) | 0);
      let comps = 0;
      for (let i = 0; i < perVertex; i++) comps |= i << (i * 4);
      this.w(0x203, 0, comps, (perVertex << 28) | ((perVertex * 16) << 16));
      for (let l = 1; l < 12; l++) this.w(0x203 + l * 3, 0, 0, 0);
      return this;
    }
    drawArrays(count, first = 0, topology = 0) {
      return this.wm(0x25E, 0x2, topology << 8).w(0x25F, 1).w(0x228, count).w(0x22A, first).w(0x22E, 1).w(0x110, 1);
    }
    drawElements(indices, topology = 0) {
      const idx = this.phys(this.data(new Uint8Array(new Uint16Array(indices).buffer)));
      return this.wm(0x25E, 0x2, topology << 8).w(0x25F, 1).w(0x228, indices.length)
        .w(0x227, 0x80000000 | (idx - this.vertexBase)).w(0x22F, 1).w(0x110, 1);
    }
  }

  // Vertex helpers (clip space x, y in [-1, 1]; PICA depth: z in [-1, 0] maps to depth [1, 0])
  const P = (x, y, z = -0.5) => [x, y, z, 1];
  const RED = [1, 0, 0, 1], GREEN = [0, 1, 0, 1], BLUE = [0, 0, 1, 1], WHITE = [1, 1, 1, 1];

  // Texture helpers: write an RGBA8 texture in the PICA tiled layout. texel(s, t) uses t = 0 at the bottom.
  function tiledTexture(w, h, texel) {
    const out = new Uint8Array(w * h * 4);
    for (let t = 0; t < h; t++) for (let s = 0; s < w; s++) {
      const y = h - 1 - t; // stored rows run top to bottom
      let m = 0;
      for (let i = 0; i < 3; i++) m |= (((s >> i) & 1) << (2 * i)) | (((y >> i) & 1) << (2 * i + 1));
      const o = (((y >> 3) * (w >> 3) + (s >> 3)) * 64 + m) * 4;
      const [r, g, b, a] = texel(s, t);
      out[o] = a; out[o + 1] = b; out[o + 2] = g; out[o + 3] = r;
    }
    return out;
  }

  const near = (a, b, tol = 3) => a.every((v, i) => Math.abs(v - b[i]) <= tol);

  const tests = [];
  const test = (name, fn) => tests.push([`GPU: ${name}`, fn]);

  test('fills a triangle with flat color inside its edges only', () => {
    const s = new Scene().setup().passthroughShader();
    s.vertices([[P(-1, -1), RED], [P(1, -1), RED], [P(-1, 1), RED]]).drawArrays(3).run();
    return near(s.pixel(5, 5), [255, 0, 0, 255]) && near(s.pixel(60, 60), [0, 0, 0, 255]) && near(s.pixel(30, 30), [255, 0, 0, 255]) && near(s.pixel(33, 33), [0, 0, 0, 255]);
  });

  test('two triangles sharing an edge cover each pixel exactly once', () => {
    const s = new Scene().setup().passthroughShader();
    // additive blending of 64/255 per hit: a pixel hit twice would read 128
    s.w(0x100, 0x00E40100).w(0x101, (1 << 16) | (1 << 20) | (1 << 24) | (1 << 28));
    const c = [0.25, 0.25, 0.25, 0.25];
    s.vertices([[P(-1, -1), c], [P(1, -1), c], [P(1, 1), c], [P(-1, -1), c], [P(1, 1), c], [P(-1, 1), c]]).drawArrays(6).run();
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (s.pixel(x, y)[0] !== 64) return false;
    return true;
  });

  test('interpolates vertex colors', () => {
    const s = new Scene().setup().passthroughShader();
    s.vertices([[P(-1, -1), RED], [P(1, -1), GREEN], [P(-1, 1), BLUE]]).drawArrays(3).run();
    const bl = s.pixel(0, 0), br = s.pixel(62, 0), tl = s.pixel(0, 62), mid = s.pixel(21, 21);
    return bl[0] > 240 && br[1] > 230 && tl[2] > 230 && mid[0] > 60 && mid[1] > 60 && mid[2] > 60;
  });

  test('depth test keeps the nearer surface regardless of draw order', () => {
    const s = new Scene().setup().passthroughShader();
    s.w(0x107, 0x1F00 | 1 | (5 << 4)); // depth test LESS_EQUAL... PICA func 5 = LessThanOrEqual
    const quad = (z, c) => [[P(-1, -1, z), c], [P(1, -1, z), c], [P(1, 1, z), c], [P(-1, -1, z), c], [P(1, 1, z), c], [P(-1, 1, z), c]];
    s.vertices([...quad(-0.2, RED), ...quad(-0.8, GREEN)]).drawArrays(12).run(); // depth 0.2 (red, near) then 0.8 (green, far)
    const ok1 = near(s.pixel(10, 10), [255, 0, 0, 255]) && Math.abs(s.depthAt(10, 10) - Math.round(0.2 * 0xFFFFFF)) < 4;
    const s2 = new Scene().setup().passthroughShader();
    s2.w(0x107, 0x1F00 | 1 | (5 << 4));
    s2.vertices([...quad(-0.8, GREEN), ...quad(-0.2, RED)]).drawArrays(12).run();
    return ok1 && near(s2.pixel(10, 10), [255, 0, 0, 255]);
  });

  test('perspective-correct texture mapping, wrap and tiling', () => {
    const s = new Scene().setup().passthroughShader();
    // 16x16 texture: left half red, right half green; bottom row (t = 0) blue
    const tex = tiledTexture(16, 16, (u, t) => (t === 0 ? [0, 0, 255, 255] : u < 8 ? [255, 0, 0, 255] : [0, 255, 0, 255]));
    const addr = s.phys(s.data(tex));
    s.w(0x080, 1).w(0x082, 16 | (16 << 16), (2 << 8) | (2 << 12)).w(0x085, addr >>> 3).w(0x08E, 0);
    s.w(0x0C0, 3 | (3 << 16), 0, 0, 0, 0); // stage 0 = texture 0
    const uv = (u, v) => [u, v, 0, 1];
    s.vertices([[P(-1, -1), WHITE, uv(0, 0)], [P(1, -1), WHITE, uv(1, 0)], [P(1, 1), WHITE, uv(1, 1)],
      [P(-1, -1), WHITE, uv(0, 0)], [P(1, 1), WHITE, uv(1, 1)], [P(-1, 1), WHITE, uv(0, 1)]]).drawArrays(6).run();
    return near(s.pixel(10, 30), [255, 0, 0, 255]) && near(s.pixel(50, 30), [0, 255, 0, 255]) && near(s.pixel(10, 1), [0, 0, 255, 255]);
  });

  test('decodes ETC1 blocks', () => {
    // Individual mode, base colors (4-bit) 0x8 / 0xF, table 0, all modifiers +2 -> 136+2 and 255
    const block = new Uint8Array(8);
    const hi = (0x8 << 28) | (0xF << 24) | (0x8 << 20) | (0xF << 16) | (0x8 << 12) | (0xF << 8) | 0; // r1 r2 g1 g2 b1 b2, tables 0, no flip
    new DataView(block.buffer).setUint32(4, hi >>> 0, true);
    const tile = new Uint8Array(32);
    for (let i = 0; i < 4; i++) tile.set(block, i * 8);
    const out = EMU.decodeTexture(tile, 0, 8, 8, 12);
    const at = (x, t) => Array.from(out.subarray((t * 8 + x) * 4, (t * 8 + x) * 4 + 4));
    return near(at(0, 7), [138, 138, 138, 255], 0) && near(at(3, 7), [255, 255, 255, 255], 0);
  });

  test('re-decodes only the changed tiles of a cached texture', () => {
    const s = new Scene().setup();
    const ok = [];
    for (const fmt of [0, 4, 10, 13]) { // RGBA8, RGBA4, L4, ETC1A4
      const bytes = (64 * 64 * [32, 16, 4, 8][[0, 4, 10, 13].indexOf(fmt)]) >> 3;
      const src = new Uint8Array(bytes).map((_, i) => (i * 7919 + fmt) & 255);
      const virt = s.data(src), addr = s.phys(virt);
      const t = s.gpu.texture(addr, 64, 64, fmt);
      // Change two separate tiles (one byte, and one run across a tile boundary)
      const tileBytes = bytes / 64;
      for (const o of [5, tileBytes * 17 - 2, tileBytes * 17 + 1]) { src[o] ^= 0x5A; s.mem.w8(virt + o, src[o]); }
      s.gpu.staleTextures(addr, bytes);
      const t2 = s.gpu.texture(addr, 64, 64, fmt), full = EMU.decodeTexture(src, 0, 64, 64, fmt);
      ok.push(t2 === t && t2.data.every((v, i) => v === full[i]));
    }
    return ok.every(Boolean);
  });

  test('vertex shader math, uniforms and indexed strips', () => {
    const s = new Scene().setup();
    // o0 = v0 * c0 (scale), o1 = c1
    s.shader(new Asm().mul('o0', 'c0', 'v0').mov('o1', 'c1').mov('o2', 'v2').end());
    s.uniform(0, 0.5, 0.5, 1, 1).uniform(1, 0, 0, 1, 1);
    s.vertices([[P(-1, -1)], [P(1, -1)], [P(-1, 1)], [P(1, 1)]]);
    s.drawElements([0, 1, 2, 3], 1).run();
    return near(s.pixel(32, 32), [0, 0, 255, 255]) && near(s.pixel(4, 4), [0, 0, 0, 255]) && near(s.pixel(46, 46), [0, 0, 255, 255]);
  });

  test('shader flow control: loop, call and conditional branches', () => {
    const s = new Scene().setup();
    const a = new Asm();
    // r1 = 0; loop 4 times: r1 += c2 (0.25 each) -> 1.0 red; if b0: call subroutine setting green = 1
    a.mov('o0', 'v0').mov('r1', 'c3');            // 0,1: r1 = (0,0,0,1)
    const loopAt = a.pc;
    a.flow(0x29, loopAt + 1, 0, 0);                 // 2: LOOP i0 { 3 }
    a.add('r1.x', 'c2', 'r1');                       // 3: body
    a.flow(0x27, a.pc + 2, 0, 0);                   // 4: IFU b0 -> body is [5, 6)
    a.flow(0x24, 9, 1);                             // 5: CALL 9 (1 instr)
    a.mov('o1', 'r1');                               // 6
    a.end();                                         // 7
    a.end();                                         // 8 (unused)
    a.mov('r1.y', 'c3.w');                            // 9: subroutine: green = 1
    s.shader(a);
    s.uniform(2, 0.25, 0, 0, 0).uniform(3, 0, 0, 0, 1);
    s.w(0x2B1, 3 | (0 << 8) | (1 << 16));           // i0: 4 iterations
    s.w(0x2B0, 0x7FFF0001);                          // b0 = true
    s.vertices([[P(-1, -1)], [P(1, -1)], [P(-1, 1)]]).drawArrays(3).run();
    return near(s.pixel(5, 5), [255, 255, 0, 255]);
  });

  test('immediate-mode vertices, culling and scissor', () => {
    const s = new Scene().setup().passthroughShader();
    s.w(0x040, 2); // keep counter-clockwise
    s.w(0x065, 3, 0, 31 | (63 << 16));                // scissor: left half only
    s.w(0x201, 0xFFF, 2 << 28);
    s.wm(0x25E, 2, 0).w(0x25F, 1).w(0x232, 0xF);
    const vtx = (pos, col) => {
      for (const v of [pos, col, [0, 0, 0, 1]]) {
        const [x, y, z, w] = v.map(toF24);
        s.w(0x233, ((w << 8) | (z >>> 16)) >>> 0, (((z & 0xFFFF) << 16) | (y >>> 8)) >>> 0, (((y & 0xFF) << 24) | x) >>> 0);
      }
    };
    vtx(P(-1, -1), GREEN); vtx(P(1, -1), GREEN); vtx(P(1, 1), GREEN);  // CCW: drawn
    vtx(P(-1, -1), RED); vtx(P(-1, 1), RED); vtx(P(1, 1), RED);        // CW: culled
    s.w(0x110, 1).run();
    return near(s.pixel(28, 5), [0, 255, 0, 255]) && near(s.pixel(40, 5), [0, 0, 0, 255]) && near(s.pixel(5, 40), [0, 0, 0, 255]);
  });

  test('alpha test, stencil and alpha blending', () => {
    const s = new Scene().setup().passthroughShader();
    const quad = (c, x0 = -1, x1 = 1) => [[P(x0, -1), c], [P(x1, -1), c], [P(x1, 1), c], [P(x0, -1), c], [P(x1, 1), c], [P(x0, 1), c]];
    // Pass 1: write stencil = 1 on the left half (color writes off)
    s.w(0x107, 0).w(0x105, 1 | (1 << 4) | (0xFF << 8) | (1 << 16) | (0xFF << 24)).w(0x106, 2 << 8);
    s.vertices(quad(RED, -1, 0)).drawArrays(6).run();
    // Pass 2: draw blue where stencil == 1, 50% alpha over the existing black
    s.w(0x107, 0xF00).w(0x105, 1 | (2 << 4) | (0 << 8) | (1 << 16) | (0xFF << 24)).w(0x106, 0);
    s.w(0x100, 0x00E40100).w(0x101, (6 << 16) | (7 << 20) | (1 << 24) | (0 << 28));
    s.vertices(quad([0, 0, 1, 0.5])).drawArrays(6).run();
    // Pass 3: alpha test (GREATER than 0x80) rejects a half-transparent green quad
    s.w(0x105, 0).w(0x100, 0x00E40000).w(0x104, 1 | (6 << 4) | (0x80 << 8));
    s.vertices(quad([0, 1, 0, 0.4])).drawArrays(6).run();
    return s.stencilAt(10, 10) === 1 && s.stencilAt(50, 10) === 0 && near(s.pixel(10, 10), [0, 0, 128, 128], 2) && near(s.pixel(50, 10), [0, 0, 0, 255]);
  });

  // Each point becomes a quad: two triangles from four emitted vertices (the second one with SETEMIT's winding flag)
  function gsQuads(jit) {
    const s = new Scene().setup({ outputs: 2 }).passthroughShader();
    s.gpu.vs.jit = s.gpu.gs.jit = jit;
    const a = new Asm();
    a.setemit(0).add('o0', 'c0', 'v0').mov('o1', 'v1').emit();
    a.setemit(1).add('o0', 'c1', 'v0').emit();
    a.setemit(2, 1).add('o0', 'c2', 'v0').emit();
    a.setemit(0, 1, 1).add('o0', 'c3', 'v0').emit();
    a.end();
    s.gshader(a);
    const d = 0.2;
    s.guniform(0, -d, -d, 0, 0).guniform(1, d, -d, 0, 0).guniform(2, -d, d, 0, 0).guniform(3, d, d, 0, 0);
    s.w(0x229, 2).w(0x244, 1).w(0x24A, 1);       // geometry stage on, own configuration, 2 VS outputs per vertex
    s.w(0x289, 0x08000000 | 1).w(0x28B, 0x10, 0).w(0x28D, 3); // point mode with 2 inputs (v0, v1), outputs o0, o1
    s.vertices([[P(-0.5, -0.5), RED], [P(0.5, 0.5), GREEN]]);
    s.wm(0x25E, 0x2, 3 << 8).w(0x25F, 1).w(0x228, 2).w(0x22A, 0).w(0x22E, 1).w(0x110, 1).run();
    // quads span 6.4 pixels around (16, 16) and (48, 48)
    return near(s.pixel(16, 16), [255, 0, 0, 255]) && near(s.pixel(12, 20), [255, 0, 0, 255]) && near(s.pixel(20, 12), [255, 0, 0, 255]) &&
      near(s.pixel(48, 48), [0, 255, 0, 255]) && near(s.pixel(52, 44), [0, 255, 0, 255]) &&
      near(s.pixel(32, 32), [0, 0, 0, 255]) && near(s.pixel(16, 26), [0, 0, 0, 255]) && s.gpu.stats.triangles === 4;
  }
  test('geometry shader: points expanded to quads (compiled)', () => gsQuads(true));
  test('geometry shader: points expanded to quads (interpreted)', () => gsQuads(false));

  test('texture combiners: modulate, constant color and combiner buffer', () => {
    const s = new Scene().setup().passthroughShader();
    // stage 0: primary * constant(0.5 gray), written to the buffer; stage 1: add buffer + previous; stage 2: replace previous
    s.w(0x0C0, 0 | (14 << 4) | (0 << 16) | (14 << 20), 0, 1 | (1 << 16), 0x80808080, 0);
    s.w(0x0C8, 15 | (13 << 4) | (15 << 16) | (13 << 20), 0, 2 | (2 << 16), 0, 0);
    s.w(0x0E0, (1 << 8) | (1 << 12)).w(0x0FD, 0);
    s.vertices([[P(-1, -1), WHITE], [P(1, -1), WHITE], [P(-1, 1), WHITE]]).drawArrays(3).run();
    // stage 1 sees buffer = initial buffer color (0) because updates lag one stage -> 128 + 0
    return near(s.pixel(5, 5), [128, 128, 128, 128], 1);
  });

  return { tests, Scene, Asm, toF24, tiledTexture };
};

// Standalone: node tests/gpu/scenes.js
if (require.main === module) {
  const fs = require('fs'), path = require('path'), vm = require('vm');
  for (const f of ['memory.js', 'cpu.js', 'kernel.js', 'services.js', 'gpu.js']) vm.runInThisContext(fs.readFileSync(path.join(__dirname, '../../src', f), 'utf8'), { filename: f });
  const { tests } = module.exports(globalThis.EMU);
  for (const [name, fn] of tests) {
    let ok = false, err = '';
    try { ok = fn(); } catch (e) { err = ` (${e.stack.split('\n').slice(0, 3).join(' | ')})`; }
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${err}`);
  }
}

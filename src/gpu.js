// PICA200 3D GPU: command lists, vertex shader unit, primitive assembly, clipping, rasterizer,
// texture units, texture combiners (TEV) and the output merger. Software rendering into emulated VRAM/FCRAM.
(function (EMU) {
  'use strict';

  const hex = EMU.hex;

  // ------------------------------------------------------------------ number formats
  const cvt = new DataView(new ArrayBuffer(4));

  // 24-bit float: 1 sign, 7 exponent (bias 63), 16 mantissa bits
  function f24(raw) {
    raw &= 0xFFFFFF;
    const sign = raw & 0x800000, e = (raw >>> 16) & 0x7F, m = raw & 0xFFFF;
    if (e === 0) return sign ? -0 : 0;
    if (e === 0x7F) return m ? NaN : sign ? -Infinity : Infinity;
    cvt.setUint32(0, ((sign << 8) | ((e + 64) << 23) | (m << 7)) >>> 0);
    return cvt.getFloat32(0);
  }

  function f32(raw) { cvt.setUint32(0, raw >>> 0); return cvt.getFloat32(0); }

  // 16-bit float (1.5.10, bias 15) used by lighting registers
  function f16(raw) {
    raw &= 0xFFFF;
    const sign = raw & 0x8000 ? -1 : 1, e = (raw >>> 10) & 0x1F, m = raw & 0x3FF;
    if (e === 0) return sign * m * Math.pow(2, -24);
    if (e === 31) return m ? NaN : sign * Infinity;
    return sign * (1 + m / 1024) * Math.pow(2, e - 15);
  }

  // Unpack three words carrying four f24 values (w, z, y, x order).
  function unpackF24x4(buf, out, o) {
    out[o + 3] = f24(buf[0] >>> 8);
    out[o + 2] = f24(((buf[0] & 0xFF) << 16) | (buf[1] >>> 16));
    out[o + 1] = f24(((buf[1] & 0xFFFF) << 8) | (buf[2] >>> 24));
    out[o + 0] = f24(buf[2] & 0xFFFFFF);
  }

  // Morton (Z-order) offset of a texel/pixel inside an 8x8 tile, indexed by y*8+x.
  const MORTON = new Uint8Array(64);
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
    let m = 0;
    for (let i = 0; i < 3; i++) m |= (((x >> i) & 1) << (2 * i)) | (((y >> i) & 1) << (2 * i + 1));
    MORTON[y * 8 + x] = m;
  }

  // ------------------------------------------------------------------ vertex shader unit
  const OP = {
    ADD: 0x00, DP3: 0x01, DP4: 0x02, DPH: 0x03, DST: 0x04, EX2: 0x05, LG2: 0x06, LITP: 0x07, MUL: 0x08, SGE: 0x09,
    SLT: 0x0A, FLR: 0x0B, MAX: 0x0C, MIN: 0x0D, RCP: 0x0E, RSQ: 0x0F, MOVA: 0x12, MOV: 0x13, DPHI: 0x18, DSTI: 0x19,
    SGEI: 0x1A, SLTI: 0x1B, BREAK: 0x20, NOP: 0x21, END: 0x22, BREAKC: 0x23, CALL: 0x24, CALLC: 0x25, CALLU: 0x26,
    IFU: 0x27, IFC: 0x28, LOOP: 0x29, EMIT: 0x2A, SETEMIT: 0x2B, JMPC: 0x2C, JMPU: 0x2D, CMP: 0x2E, MADI: 0x30, MAD: 0x38,
  };

  // PICA multiplication: 0 * inf = 0
  const mul = (a, b) => { const r = a * b; return r !== r && a === a && b === b ? 0 : r; };

  class ShaderUnit {
    constructor(name) {
      this.name = name;
      this.code = new Uint32Array(4096);
      this.swizzle = new Uint32Array(128);
      // Register file indexed by the 7-bit source encoding: v0-v15, r0-r15, c0-c95
      this.R = new Float32Array(128 * 4);
      this.O = new Float32Array(16 * 4);
      this.b = 0;                   // bool uniforms
      this.i = new Int32Array(12);  // int uniforms (x = count, y = init, z = step) x4
      this.decoded = null;
      this.jit = true;          // run compiled programs (false = interpreter; same results)
      this.compiled = new Map(); // entry point -> compiled program (for the current bool/int uniforms)
      this.codeVersion = 0;               // bumped whenever program words or swizzles change
      this.compiled.verified = new Map(); // entry -> codeVersion it was last checked against the program words
      this.compiledBySpec = new Map([['0|0,0,0,0,0,0,0,0,0,0,0,0', this.compiled]]); // uniform values -> such a map
      this.flatten = true;       // allow straight-line programs specialised on the bool/int uniforms
      this.stkEnd = []; this.stkRet = []; this.stkRepeat = []; this.stkInc = []; this.stkStart = []; this.stkLoop = [];
      this.uniBuf = [];         // float uniform words being assembled
      // Geometry shader emitter: SETEMIT selects the vertex slot (0-2), whether EMIT also outputs the
      // triangle, and its winding; EMIT calls onEmit(unit) with the output registers set
      this.emitVtx = 0; this.emitPrim = 0; this.emitWinding = 0;
      this.onEmit = null;
      this.S = [new Float32Array(4), new Float32Array(4), new Float32Array(4)];
      this.D = new Float32Array(4);
    }

    // Drop compiled programs (after loading a save state)
    resetCompiled() {
      this.decoded = null;
      this.codeVersion++;
      this.compiled = new Map();
      this.compiled.verified = new Map();
      this.compiledBySpec = new Map([[`${this.b}|${this.i.join(',')}`, this.compiled]]);
    }

    // Program words or swizzles changed. Compiled programs are kept: each is checked against the words it was
    // built from before its next use (games switch between a few programs many times per frame).
    invalidate() {
      this.decoded = null;
      this.codeVersion++;
    }

    // Set the bool uniforms and the int uniforms (count, init, step) x4; compiled programs depend on them
    setUniforms(b, ints) {
      let same = this.b === b;
      for (let k = 0; same && k < 12; k++) same = this.i[k] === ints[k];
      if (same) return;
      this.b = b; this.i.set(ints);
      // Programs compiled for these values before are kept (games switch between a few sets per frame)
      const key = `${b}|${this.i.join(',')}`;
      let m = this.compiledBySpec.get(key);
      if (!m) {
        if (this.compiledBySpec.size >= 64) { this.compiledBySpec.clear(); }
        m = new Map();
        m.verified = new Map();
        this.compiledBySpec.set(key, m);
      }
      this.compiled = m;
    }

    decode() {
      const out = new Array(4096);
      for (let pc = 0; pc < 4096; pc++) {
        const w = this.code[pc], op = w >>> 26;
        const ins = { op, w };
        if (op >= 0x30) { // MAD / MADI
          const inv = op < 0x38;
          ins.op = inv ? OP.MADI : OP.MAD;
          ins.desc = this.swz(w & 0x1F);
          ins.s1 = (w >>> 17) & 0x1F;
          ins.s2 = inv ? (w >>> 12) & 0x1F : (w >>> 10) & 0x7F;
          ins.s3 = inv ? (w >>> 5) & 0x7F : (w >>> 5) & 0x1F;
          ins.idx = (w >>> 22) & 3;
          ins.dst = (w >>> 24) & 0x1F;
        } else if ((op & 0x3E) === 0x2E) { // CMP
          ins.op = OP.CMP;
          ins.desc = this.swz(w & 0x7F);
          ins.s2 = (w >>> 7) & 0x1F;
          ins.s1 = (w >>> 12) & 0x7F;
          ins.idx = (w >>> 19) & 3;
          ins.cmpy = (w >>> 21) & 7;
          ins.cmpx = (w >>> 24) & 7;
        } else if (op < 0x20) { // arithmetic
          const inv = op >= 0x18 && op <= 0x1B;
          ins.desc = this.swz(w & 0x7F);
          ins.s1 = inv ? (w >>> 14) & 0x1F : (w >>> 12) & 0x7F;
          ins.s2 = inv ? (w >>> 7) & 0x7F : (w >>> 7) & 0x1F;
          ins.inv = inv;
          ins.idx = (w >>> 19) & 3;
          ins.dst = (w >>> 21) & 0x1F;
        } else { // flow control
          ins.num = w & 0xFF;
          ins.target = (w >>> 10) & 0xFFF;
          ins.cop = (w >>> 22) & 3;
          ins.refy = (w >>> 24) & 1;
          ins.refx = (w >>> 25) & 1;
          ins.bid = (w >>> 22) & 0xF;
          ins.iid = (w >>> 22) & 3;
        }
        out[pc] = ins;
      }
      this.decoded = out;
    }

    swz(id) {
      const d = this.swizzle[id];
      const sel = (s) => [(s >>> 6) & 3, (s >>> 4) & 3, (s >>> 2) & 3, s & 3];
      return {
        mask: d & 0xF,
        n1: (d >>> 4) & 1, sw1: sel((d >>> 5) & 0xFF),
        n2: (d >>> 13) & 1, sw2: sel((d >>> 14) & 0xFF),
        n3: (d >>> 22) & 1, sw3: sel((d >>> 23) & 0xFF),
      };
    }

    load(T, raw, sw, neg, offset) {
      const R = this.R;
      if (offset && raw >= 0x20) {
        raw += offset;
        if (raw < 0x20 || raw >= 0x80) { T[0] = T[1] = T[2] = T[3] = 0; return T; }
      }
      const b = raw << 2;
      if (neg) { T[0] = -R[b + sw[0]]; T[1] = -R[b + sw[1]]; T[2] = -R[b + sw[2]]; T[3] = -R[b + sw[3]]; }
      else { T[0] = R[b + sw[0]]; T[1] = R[b + sw[1]]; T[2] = R[b + sw[2]]; T[3] = R[b + sw[3]]; }
      return T;
    }

    store(dst, mask, D) {
      const A = dst < 0x10 ? this.O : this.R, b = (dst & (dst < 0x10 ? 0xF : 0x1F)) << 2;
      if (mask & 8) A[b] = D[0];
      if (mask & 4) A[b + 1] = D[1];
      if (mask & 2) A[b + 2] = D[2];
      if (mask & 1) A[b + 3] = D[3];
    }

    // Run from `entry` until END. Inputs must already be in R[0..63].
    // Compiled program starting at entry, for the current uniforms
    program(entry) {
      const m = this.compiled;
      let fn = m.get(entry);
      if (fn && m.verified.get(entry) !== this.codeVersion) {
        if (sameProgram(this, fn)) m.verified.set(entry, this.codeVersion); else fn = null;
      }
      if (!fn) { fn = compileShader(this, entry); m.set(entry, fn); m.verified.set(entry, this.codeVersion); }
      return fn;
    }

    run(entry) {
      if (this.jit) {
        this.program(entry)(this, SHADER_HELPERS);
        return;
      }
      if (!this.decoded) this.decode();
      const prog = this.decoded, R = this.R, D = this.D, [S1, S2, S3] = this.S;
      const stack = [];
      let pc = entry, a0x = 0, a0y = 0, aL = 0, cx = false, cy = false, steps = 0;
      const cond = (ins) => {
        const x = cx === !!ins.refx, y = cy === !!ins.refy;
        switch (ins.cop) { case 0: return x || y; case 1: return x && y; case 2: return x; default: return y; }
      };
      const call = (offset, num, ret, repeat, inc, loop) => {
        stack.push({ end: offset + num, ret, repeat, inc, start: offset, loop });
        pc = offset;
      };
      for (;;) {
        while (stack.length && pc === stack[stack.length - 1].end) {
          const top = stack[stack.length - 1];
          if (top.loop) aL = (aL + top.inc) | 0;
          if (top.repeat-- <= 0) { pc = top.ret; stack.pop(); } else pc = top.start;
        }
        if (pc >= 4096 || ++steps > 200000) return;
        const ins = prog[pc++];
        const offs = ins.idx === 1 ? a0x : ins.idx === 2 ? a0y : ins.idx === 3 ? aL : 0;
        switch (ins.op) {
          case OP.ADD: case OP.MUL: case OP.MAX: case OP.MIN: case OP.SGE: case OP.SLT: case OP.SGEI: case OP.SLTI: {
            const d = ins.desc;
            this.load(S1, ins.s1, d.sw1, d.n1, ins.inv ? 0 : offs);
            this.load(S2, ins.s2, d.sw2, d.n2, ins.inv ? offs : 0);
            for (let k = 0; k < 4; k++) {
              const a = S1[k], b = S2[k];
              switch (ins.op) {
                case OP.ADD: D[k] = a + b; break;
                case OP.MUL: D[k] = mul(a, b); break;
                case OP.MAX: D[k] = a > b ? a : b; break;
                case OP.MIN: D[k] = a < b ? a : b; break;
                case OP.SGE: case OP.SGEI: D[k] = a >= b ? 1 : 0; break;
                default: D[k] = a < b ? 1 : 0;
              }
            }
            this.store(ins.dst, d.mask, D);
            break;
          }
          case OP.DP3: case OP.DP4: case OP.DPH: case OP.DPHI: {
            const d = ins.desc;
            this.load(S1, ins.s1, d.sw1, d.n1, ins.inv ? 0 : offs);
            this.load(S2, ins.s2, d.sw2, d.n2, ins.inv ? offs : 0);
            if (ins.op === OP.DPH || ins.op === OP.DPHI) S1[3] = 1;
            let r = mul(S1[0], S2[0]) + mul(S1[1], S2[1]) + mul(S1[2], S2[2]);
            if (ins.op !== OP.DP3) r += mul(S1[3], S2[3]);
            D[0] = D[1] = D[2] = D[3] = r;
            this.store(ins.dst, d.mask, D);
            break;
          }
          case OP.DST: case OP.DSTI: {
            const d = ins.desc;
            this.load(S1, ins.s1, d.sw1, d.n1, ins.inv ? 0 : offs);
            this.load(S2, ins.s2, d.sw2, d.n2, ins.inv ? offs : 0);
            D[0] = 1; D[1] = mul(S1[1], S2[1]); D[2] = S1[2]; D[3] = S2[3];
            this.store(ins.dst, d.mask, D);
            break;
          }
          case OP.EX2: case OP.LG2: case OP.RCP: case OP.RSQ: {
            const d = ins.desc;
            const x = this.load(S1, ins.s1, d.sw1, d.n1, offs)[0];
            const r = ins.op === OP.EX2 ? Math.pow(2, x) : ins.op === OP.LG2 ? Math.log2(x) : ins.op === OP.RCP ? 1 / x : 1 / Math.sqrt(x);
            D[0] = D[1] = D[2] = D[3] = r;
            this.store(ins.dst, d.mask, D);
            break;
          }
          case OP.LITP: {
            const d = ins.desc;
            this.load(S1, ins.s1, d.sw1, d.n1, offs);
            D[0] = Math.max(S1[0], 0);
            D[1] = Math.min(Math.max(S1[1], -127.9961), 127.9961);
            D[2] = S1[2];
            D[3] = Math.max(S1[3], 0);
            cx = S1[0] > 0; cy = S1[3] > 0;
            this.store(ins.dst, d.mask, D);
            break;
          }
          case OP.FLR: case OP.MOV: {
            const d = ins.desc;
            this.load(S1, ins.s1, d.sw1, d.n1, offs);
            if (ins.op === OP.FLR) for (let k = 0; k < 4; k++) D[k] = Math.floor(S1[k]);
            else D.set(S1);
            this.store(ins.dst, d.mask, D);
            break;
          }
          case OP.MOVA: {
            const d = ins.desc;
            this.load(S1, ins.s1, d.sw1, d.n1, offs);
            if (d.mask & 8) a0x = Math.trunc(S1[0]) | 0;
            if (d.mask & 4) a0y = Math.trunc(S1[1]) | 0;
            break;
          }
          case OP.CMP: {
            const d = ins.desc;
            this.load(S1, ins.s1, d.sw1, d.n1, offs);
            this.load(S2, ins.s2, d.sw2, d.n2, 0);
            const cmp = (op, a, b) => {
              switch (op) { case 0: return a === b; case 1: return a !== b; case 2: return a < b; case 3: return a <= b; case 4: return a > b; case 5: return a >= b; }
              return true;
            };
            cx = cmp(ins.cmpx, S1[0], S2[0]);
            cy = cmp(ins.cmpy, S1[1], S2[1]);
            break;
          }
          case OP.MAD: case OP.MADI: {
            const d = ins.desc, inv = ins.op === OP.MADI;
            this.load(S1, ins.s1, d.sw1, d.n1, 0);
            this.load(S2, ins.s2, d.sw2, d.n2, inv ? 0 : offs);
            this.load(S3, ins.s3, d.sw3, d.n3, inv ? offs : 0);
            for (let k = 0; k < 4; k++) D[k] = mul(S1[k], S2[k]) + S3[k];
            this.store(ins.dst, d.mask, D);
            break;
          }
          case OP.NOP: break;
          case OP.SETEMIT: this.emitVtx = (ins.w >>> 24) & 3; this.emitPrim = (ins.w >>> 23) & 1; this.emitWinding = (ins.w >>> 22) & 1; break;
          case OP.EMIT: if (this.onEmit) this.onEmit(this); break;
          case OP.END: return;
          case OP.BREAK: case OP.BREAKC: {
            if (ins.op === OP.BREAKC && !cond(ins)) break;
            while (stack.length) {
              const top = stack.pop();
              if (top.loop) { pc = top.ret; break; }
            }
            break;
          }
          case OP.CALL: call(ins.target, ins.num, pc, 0, 0, false); break;
          case OP.CALLC: if (cond(ins)) call(ins.target, ins.num, pc, 0, 0, false); break;
          case OP.CALLU: if ((this.b >>> ins.bid) & 1) call(ins.target, ins.num, pc, 0, 0, false); break;
          case OP.IFU: case OP.IFC: {
            const ok = ins.op === OP.IFU ? (this.b >>> ins.bid) & 1 : cond(ins);
            if (ok) call(pc, ins.target - pc, ins.target + ins.num, 0, 0, false);
            else call(ins.target, ins.num, ins.target + ins.num, 0, 0, false);
            break;
          }
          case OP.LOOP: {
            const i = this.i, k = ins.iid * 3;
            aL = i[k + 1];
            call(pc, ins.target - pc + 1, ins.target + 1, i[k], i[k + 2], true);
            break;
          }
          case OP.JMPC: if (cond(ins)) pc = ins.target; break;
          case OP.JMPU: if (((this.b >>> ins.bid) & 1) === ((ins.num & 1) ^ 1)) pc = ins.target; break;
          default: break;
        }
      }
    }
  }

  // ------------------------------------------------------------------ shader compiler
  // Translates a shader program (from its entry point) into JavaScript: one switch case per reachable
  // instruction, falling through on straight-line code. Register indices and swizzles become constants;
  // flow control keeps the interpreter's call/loop stack so results match ShaderUnit.run exactly
  // (each result is computed in double precision and rounded to float32 once, when stored).
  const shaderCache = new Map();

  // ---- code generation shared by both shader compilers
  // PICA multiplication (0 * inf = 0), inlined: the helper call is not always inlined by the JS engine
  const mulExpr = (a, b) => `(mz = (mx = ${a}) * (my = ${b}), mz === mz || mx !== mx || my !== my ? mz : 0)`;
  // Source operand component c as an expression (after swizzle, negation and relative addressing).
  // offs: '' (none), the name of an address register, or a number (a loop counter known at compile time).
  const shaderSrc = (raw, sw, neg, offs, c) => {
    if (typeof offs === 'number' && raw >= 0x20) {
      const r = raw + offs;
      return r < 0x20 || r >= 0x80 ? '0' : `${neg ? '-' : ''}R[${(r << 2) + sw[c]}]`; // out of range reads as +0
    }
    if (offs && raw >= 0x20) return `((ut = ${raw} + ${offs}) < 0x20 || ut >= 0x80 ? 0 : ${neg ? '-' : ''}R[(ut << 2) + ${sw[c]}])`;
    return `${neg ? '-' : ''}R[${(raw << 2) + sw[c]}]`;
  };
  const dstRef = (dst, c) => (dst < 0x10 ? `O[${(dst << 2) + c}]` : `R[${((dst & 0x1F) << 2) + c}]`);
  const shaderCond = (ins) => {
    const x = `(cx === ${!!ins.refx})`, y = `(cy === ${!!ins.refy})`;
    return [`(${x} || ${y})`, `(${x} && ${y})`, x, y][ins.cop];
  };

  // Code for one instruction that does not change control flow, or null for flow control instructions
  function genShaderOp(ins, offs) {
    const d = ins.desc, src = shaderSrc;
    let code = '';
    // Destination components (in mask order x, y, z, w = bits 3..0)
    const comps = d ? [0, 1, 2, 3].filter((c) => d.mask & (8 >> c)) : [];
    const s1 = (c, off) => src(ins.s1, d.sw1, d.n1, off, c), s2 = (c, off) => src(ins.s2, d.sw2, d.n2, off, c), s3 = (c, off) => src(ins.s3, d.sw3, d.n3, off, c);
    const o1 = ins.inv ? '' : offs, o2 = ins.inv ? offs : '';
      switch (ins.op) {
        case OP.ADD: case OP.MUL: case OP.MAX: case OP.MIN: case OP.SGE: case OP.SLT: case OP.SGEI: case OP.SLTI: {
          if (!comps.length) break;
          code += '{ ';
          for (const c of comps) code += `const a${c} = ${s1(c, o1)}, b${c} = ${s2(c, o2)}; `;
          for (const c of comps) {
            const a = `a${c}`, b = `b${c}`;
            const e = { [OP.ADD]: `${a} + ${b}`, [OP.MUL]: mulExpr(a, b), [OP.MAX]: `${a} > ${b} ? ${a} : ${b}`, [OP.MIN]: `${a} < ${b} ? ${a} : ${b}`,
              [OP.SGE]: `${a} >= ${b} ? 1 : 0`, [OP.SGEI]: `${a} >= ${b} ? 1 : 0` }[ins.op] || `${a} < ${b} ? 1 : 0`;
            code += `${dstRef(ins.dst, c)} = ${e}; `;
          }
          code += '}\n';
          break;
        }
        case OP.DP3: case OP.DP4: case OP.DPH: case OP.DPHI: {
          if (!comps.length) break;
          const n = ins.op === OP.DP3 ? 3 : 4, h = ins.op === OP.DPH || ins.op === OP.DPHI;
          const terms = [];
          for (let c = 0; c < n; c++) terms.push(mulExpr(h && c === 3 ? '1' : s1(c, o1), s2(c, o2)));
          code += `{ const r = ${terms.join(' + ')}; ${comps.map((c) => `${dstRef(ins.dst, c)} = r;`).join(' ')} }\n`;
          break;
        }
        case OP.DST: case OP.DSTI: {
          if (!comps.length) break;
          const v = { 0: '1', 1: mulExpr(s1(1, o1), s2(1, o2)), 2: s1(2, o1), 3: s2(3, o2) };
          // Evaluate all used sources before writing (the destination may be a source)
          code += `{ ${comps.map((c) => `const v${c} = ${v[c]};`).join(' ')} ${comps.map((c) => `${dstRef(ins.dst, c)} = v${c};`).join(' ')} }\n`;
          break;
        }
        case OP.EX2: case OP.LG2: case OP.RCP: case OP.RSQ: {
          if (!comps.length) break;
          const x = s1(0, offs);
          const e = { [OP.EX2]: `Math.pow(2, x)`, [OP.LG2]: 'Math.log2(x)', [OP.RCP]: '1 / x' }[ins.op] || '1 / Math.sqrt(x)';
          code += `{ const x = ${x}, r = ${e}; ${comps.map((c) => `${dstRef(ins.dst, c)} = r;`).join(' ')} }\n`;
          break;
        }
        case OP.LITP: {
          code += `{ const x0 = ${s1(0, offs)}, x1 = ${s1(1, offs)}, x2 = ${s1(2, offs)}, x3 = ${s1(3, offs)};\n`;
          code += 'const v0 = Math.max(x0, 0), v1 = Math.min(Math.max(x1, -127.9961), 127.9961), v2 = x2, v3 = Math.max(x3, 0);\n';
          code += 'cx = x0 > 0; cy = x3 > 0; ';
          code += `${comps.map((c) => `${dstRef(ins.dst, c)} = v${c};`).join(' ')} }\n`;
          break;
        }
        case OP.FLR: case OP.MOV: {
          if (!comps.length) break;
          code += `{ ${comps.map((c) => `const v${c} = ${ins.op === OP.FLR ? `Math.floor(${s1(c, offs)})` : s1(c, offs)};`).join(' ')} `;
          code += `${comps.map((c) => `${dstRef(ins.dst, c)} = v${c};`).join(' ')} }\n`;
          break;
        }
        case OP.MOVA: { // load before either address register changes (the source may be addressed through them)
          if (!(d.mask & 12)) break;
          code += `{ const x = ${s1(0, offs)}, y = ${s1(1, offs)};${d.mask & 8 ? ' a0x = Math.trunc(x) | 0;' : ''}${d.mask & 4 ? ' a0y = Math.trunc(y) | 0;' : ''} }\n`;
          break;
        }
        case OP.CMP: {
          const cmp = (op, a, b) => [`${a} === ${b}`, `${a} !== ${b}`, `${a} < ${b}`, `${a} <= ${b}`, `${a} > ${b}`, `${a} >= ${b}`][op] || 'true';
          code += `{ const a0 = ${s1(0, offs)}, a1 = ${s1(1, offs)}, b0 = ${s2(0, '')}, b1 = ${s2(1, '')}; cx = ${cmp(ins.cmpx, 'a0', 'b0')}; cy = ${cmp(ins.cmpy, 'a1', 'b1')}; }\n`;
          break;
        }
        case OP.MAD: case OP.MADI: {
          if (!comps.length) break;
          const inv = ins.op === OP.MADI;
          code += `{ ${comps.map((c) => `const v${c} = ${mulExpr(s1(c, ''), s2(c, inv ? '' : offs))} + ${s3(c, inv ? offs : '')};`).join(' ')} `;
          code += `${comps.map((c) => `${dstRef(ins.dst, c)} = v${c};`).join(' ')} }\n`;
          break;
        }
        case OP.SETEMIT: code += `vs.emitVtx = ${(ins.w >>> 24) & 3}; vs.emitPrim = ${(ins.w >>> 23) & 1}; vs.emitWinding = ${(ins.w >>> 22) & 1};\n`; break;
        case OP.EMIT: code += 'if (vs.onEmit) vs.onEmit(vs);\n'; break;
        case OP.END: case OP.BREAK: case OP.BREAKC: case OP.CALL: case OP.CALLC: case OP.CALLU:
        case OP.IFU: case OP.IFC: case OP.LOOP: case OP.JMPC: case OP.JMPU: return null;
        default: break; // NOP and unknown opcodes do nothing
      }
    return code;
  }

  // ---- straight-line compiler
  // With the bool and int uniforms fixed, calls, uniform branches and loops are resolved at compile time by
  // following the interpreter's call/loop stack: calls are inlined, loops unrolled (so the loop counter is a
  // constant) and only branches on the compare flags remain, as if/else that rejoin where both paths meet.
  // The result is short code the JS engine optimises well. Programs that do not fit return null.
  const FLAT_LIMIT = 3000; // instructions emitted per program
  const FLAT_FAIL = new Error('shader too large to flatten');

  // The straight-line body of a program (code text), using lang.op(ins, offs) and lang.cond(ins) to generate
  // instructions and flag conditions; null when the program does not fit. Shared with the WebGL renderer,
  // which generates GLSL with the same walk.
  const JS_LANG = { op: (ins, offs) => genShaderOp(ins, offs), cond: (ins) => shaderCond(ins) };

  function flattenShaderBody(unit, entry, lang) {
    if (!unit.decoded) unit.decode();
    const prog = unit.decoded, B = unit.b, IU = unit.i;
    let budget = FLAT_LIMIT;
    const copy = (st) => ({ pc: st.pc, aL: st.aL, stack: st.stack.map((f) => ({ ...f })) });
    const keyOf = (st) => `${st.pc}:${st.aL}:${st.stack.map((f) => `${f.end}.${f.ret}.${f.repeat}.${f.inc}.${f.start}.${f.loop ? 1 : 0}`).join('/')}`;
    // Pop finished call/loop bodies, exactly as ShaderUnit.run does before each instruction
    const settle = (st) => {
      const stk = st.stack;
      while (stk.length && st.pc === stk[stk.length - 1].end) {
        const t = stk[stk.length - 1];
        if (t.loop) st.aL = (st.aL + t.inc) | 0;
        if (t.repeat-- <= 0) { st.pc = t.ret; stk.pop(); } else st.pc = t.start;
      }
    };
    const push = (st, start, num, ret, repeat = 0, inc = 0, loop = false) => {
      st.stack.push({ end: start + num, ret, repeat, inc, start, loop });
      st.pc = start;
    };
    const settled = (st) => { const c = copy(st); settle(c); return c; };

    // Emit code from st until it reaches the state with key `stop` (returns that state) or every path ends
    function walk(st, stop) {
      let code = '';
      for (;;) {
        settle(st);
        if (stop !== null && keyOf(st) === stop) return { code, at: st };
        if (st.pc >= 4096) return { code: code + 'return;\n', at: null };
        if (--budget < 0) throw FLAT_FAIL;
        const ins = prog[st.pc], next = st.pc + 1;
        st.pc = next;
        const g = lang.op(ins, ins.idx === 3 ? st.aL : ['', 'a0x', 'a0y'][ins.idx] || '');
        if (g !== null) { code += g; continue; }
        // Two-way branch on the compare flags: both paths up to their meeting point, then carry on from there
        const fork = (cond, a, b, join) => {
          const stopKey = join ? keyOf(settled(join)) : null;
          const x = walk(a, stopKey), y = walk(b, stopKey);
          code += `if (${cond}) {\n${x.code}} else {\n${y.code}}\n`;
          return x.at || y.at;
        };
        let at = st;
        switch (ins.op) {
          case OP.END: return { code: code + 'return;\n', at: null };
          case OP.CALL: push(st, ins.target, ins.num, next); break;
          case OP.CALLU: if ((B >>> ins.bid) & 1) push(st, ins.target, ins.num, next); break;
          case OP.CALLC: { const a = copy(st); push(a, ins.target, ins.num, next); at = fork(lang.cond(ins), a, st, copy(st)); break; }
          case OP.IFU:
            if ((B >>> ins.bid) & 1) push(st, next, ins.target - next, ins.target + ins.num);
            else push(st, ins.target, ins.num, ins.target + ins.num);
            break;
          case OP.IFC: {
            const join = copy(st); join.pc = ins.target + ins.num;
            const a = copy(st), b = copy(st);
            push(a, next, ins.target - next, ins.target + ins.num);
            push(b, ins.target, ins.num, ins.target + ins.num);
            at = fork(lang.cond(ins), a, b, join);
            break;
          }
          case OP.LOOP: {
            const k = ins.iid * 3;
            st.aL = IU[k + 1];
            push(st, next, ins.target - next + 1, ins.target + 1, IU[k], IU[k + 2], true);
            break;
          }
          case OP.BREAK: case OP.BREAKC: {
            const a = ins.op === OP.BREAKC ? copy(st) : st;
            while (a.stack.length) { const t = a.stack.pop(); if (t.loop) { a.pc = t.ret; break; } }
            if (ins.op === OP.BREAKC) at = fork(lang.cond(ins), a, st, null);
            break;
          }
          case OP.JMPU: if (((B >>> ins.bid) & 1) === ((ins.num & 1) ^ 1)) st.pc = ins.target; break;
          case OP.JMPC: {
            const a = copy(st); a.pc = ins.target;
            at = fork(lang.cond(ins), a, st, ins.target > next - 1 ? a : null); // forward jumps rejoin at the target
            break;
          }
        }
        if (!at) return { code, at: null };
        st = at;
      }
    }

    try { return walk({ pc: entry, aL: 0, stack: [] }, null).code; } catch (e) { if (e === FLAT_FAIL) return null; throw e; }
  }

  function flattenShader(unit, entry) {
    const body = flattenShaderBody(unit, entry, JS_LANG);
    if (body === null) return null;
    const src = `const R = vs.R, O = vs.O;
      let mx = 0, my = 0, mz = 0, ut = 0, a0x = 0, a0y = 0, cx = false, cy = false;
${body}`;
    const fn = new Function('vs', 'H', src);
    fn.source = src;
    fn.flat = true;
    return fn;
  }

  // Is fn (from compileShader) still the program in unit's memory?
  function sameProgram(unit, fn) {
    const pcs = fn.pcs, words = fn.words, code = unit.code;
    for (let k = 0; k < pcs.length; k++) if (code[pcs[k]] !== words[k]) return false;
    const swz = fn.swz, sw = unit.swizzle;
    for (let i = 0; i < 128; i++) if (sw[i] !== swz[i]) return false;
    return true;
  }

  // Remember what a compiled program was built from (see sameProgram)
  function stamp(fn, unit, pcs) {
    if (!fn.pcs) {
      fn.pcs = Int32Array.from(pcs);
      fn.words = Uint32Array.from(pcs, (pc) => unit.code[pc]);
      fn.swz = Uint32Array.from(unit.swizzle);
    }
    return fn;
  }

  function compileShader(unit, entry) {
    if (!unit.decoded) unit.decode();
    const prog = unit.decoded;
    // Reachable instructions, and the pcs where a call/loop body may end
    const reach = new Set(), ends = new Set(), todo = [entry];
    while (todo.length) {
      const pc = todo.pop();
      if (pc >= 4096 || reach.has(pc)) continue;
      reach.add(pc);
      const ins = prog[pc];
      const next = pc + 1;
      switch (ins.op) {
        case OP.END: break;
        case OP.CALL: case OP.CALLC: case OP.CALLU:
          ends.add(ins.target + ins.num); todo.push(ins.target, next, ins.target + ins.num); break;
        case OP.IFU: case OP.IFC:
          ends.add(ins.target); ends.add(ins.target + ins.num); todo.push(next, ins.target, ins.target + ins.num); break;
        case OP.LOOP:
          ends.add(ins.target + 1); todo.push(next, ins.target + 1); break;
        case OP.JMPC: case OP.JMPU: todo.push(next, ins.target); break;
        default: todo.push(next);
      }
    }
    const pcs = [...reach].sort((a, b) => a - b);
    // Cache by program contents: games re-upload the same shaders constantly
    let key = `${entry}:`;
    for (const pc of pcs) key += `${pc}=${unit.code[pc].toString(36)},`;
    key += '|';
    for (let i = 0; i < 128; i++) key += unit.swizzle[i].toString(36) + ',';
    // Straight-line version for these uniform values, when the program allows it
    const flatKey = `${key}|${unit.b}|${unit.i.join(',')}`;
    let fn = shaderCache.get(flatKey);
    if (fn) return stamp(fn, unit, pcs);
    if (unit.flatten) {
      fn = flattenShader(unit, entry);
      if (fn) {
        if (shaderCache.size > 512) shaderCache.clear();
        shaderCache.set(flatKey, fn);
        return stamp(fn, unit, pcs);
      }
    }
    fn = shaderCache.get(key);
    if (fn) { shaderCache.set(flatKey, fn); return stamp(fn, unit, pcs); }

    const OFFS = ['', 'a0x', 'a0y', 'aL'];
    const cond = shaderCond;
    const callCode = (start, num, ret) => `E[sp] = ${start + num}; T[sp] = ${ret}; P[sp] = 0; N[sp] = 0; S[sp] = ${start}; K[sp] = 0; sp++; pc = ${start}; continue;`;

    // End of a call/loop body: repeat the loop or return (possibly several levels), as ShaderUnit.run does
    const UNWIND = 'do { const t = sp - 1; if (K[t]) aL = (aL + N[t]) | 0; if (P[t]-- <= 0) { pc = T[t]; sp--; } else pc = S[t]; } while (sp > 0 && pc === E[sp - 1]);';
    let code = '';
    for (let k = 0; k < pcs.length; k++) {
      const pc = pcs[k], ins = prog[pc], next = pc + 1;
      code += `case ${pc}:\n`;
      if (ends.has(pc)) code += `if (sp > 0 && E[sp - 1] === ${pc}) { pc = ${pc}; ${UNWIND} continue; }\n`;
      code += 'if (++steps > 200000) return;\n';
      let falls = true;
      const g = genShaderOp(ins, OFFS[ins.idx]);
      if (g !== null) code += g;
      else switch (ins.op) {
        case OP.END: code += 'return;\n'; falls = false; break;
        case OP.BREAK: case OP.BREAKC:
          code += `${ins.op === OP.BREAKC ? `if (${cond(ins)}) ` : ''}{ let found = false; while (sp > 0) { sp--; if (K[sp]) { pc = T[sp]; found = true; break; } } if (found) continue; }\n`;
          break;
        case OP.CALL: code += callCode(ins.target, ins.num, next) + '\n'; falls = false; break;
        case OP.CALLC: code += `if (${cond(ins)}) { ${callCode(ins.target, ins.num, next)} }\n`; break;
        case OP.CALLU: code += `if ((vs.b >>> ${ins.bid}) & 1) { ${callCode(ins.target, ins.num, next)} }\n`; break;
        case OP.IFU: case OP.IFC: {
          const ok = ins.op === OP.IFU ? `(vs.b >>> ${ins.bid}) & 1` : cond(ins);
          code += `if (${ok}) { E[sp] = ${ins.target}; T[sp] = ${ins.target + ins.num}; P[sp] = 0; N[sp] = 0; S[sp] = ${next}; K[sp] = 0; sp++; pc = ${next}; }\n`;
          code += `else { E[sp] = ${ins.target + ins.num}; T[sp] = ${ins.target + ins.num}; P[sp] = 0; N[sp] = 0; S[sp] = ${ins.target}; K[sp] = 0; sp++; pc = ${ins.target}; }\ncontinue;\n`;
          falls = false;
          break;
        }
        case OP.LOOP: {
          const ik = ins.iid * 3;
          code += `aL = vs.i[${ik + 1}]; E[sp] = ${ins.target + 1}; T[sp] = ${ins.target + 1}; P[sp] = vs.i[${ik}]; N[sp] = vs.i[${ik + 2}]; S[sp] = ${next}; K[sp] = 1; sp++;\n`;
          code += `pc = ${next}; continue;\n`;
          falls = false;
          break;
        }
        case OP.JMPC: code += `if (${cond(ins)}) { pc = ${ins.target}; continue; }\n`; break;
        case OP.JMPU: code += `if (((vs.b >>> ${ins.bid}) & 1) === ${(ins.num & 1) ^ 1}) { pc = ${ins.target}; continue; }\n`; break;
      }
      if (falls && pcs[k + 1] !== next) code += `pc = ${next}; continue;\n`;
    }

    const src2 = `const R = vs.R, O = vs.O;
      let mx = 0, my = 0, mz = 0, ut = 0;
      const E = vs.stkEnd, T = vs.stkRet, P = vs.stkRepeat, N = vs.stkInc, S = vs.stkStart, K = vs.stkLoop;
      let pc = ${entry}, sp = 0, a0x = 0, a0y = 0, aL = 0, cx = false, cy = false, steps = 0;
      for (;;) {
        switch (pc) {
${code}
          default:
            if (sp > 0 && pc === E[sp - 1]) { ${UNWIND} continue; }
            return;
        }
      }`;
    fn = new Function('vs', 'H', src2);
    fn.source = src2;
    if (shaderCache.size > 512) shaderCache.clear();
    shaderCache.set(key, fn);
    shaderCache.set(flatKey, fn);
    return stamp(fn, unit, pcs);
  }

  const SHADER_HELPERS = {};

  // ------------------------------------------------------------------ textures
  const TEX_BITS = [32, 24, 16, 16, 16, 16, 16, 8, 8, 8, 4, 4, 4, 8];
  const ETC_MOD = [[2, 8], [5, 17], [9, 29], [13, 42], [18, 60], [24, 80], [33, 106], [47, 183]];

  // Decode one ETC1 4x4 block (lo/hi = little-endian 32-bit halves) whose top-left texel is (x0, y0) in a
  // texture w x h; rows in out are ordered by t (texel y goes to row h - 1 - y). Alpha comes from aLo/aHi (4 bits
  // per texel) when hasAlpha, else 255.
  function etc1Block(lo, hi, out, w, h, x0, y0, hasAlpha, aLo, aHi) {
    const flip = hi & 1, diff = (hi >>> 1) & 1;
    let r0, g0, b0, r1, g1, b1;
    if (diff) {
      r0 = (hi >>> 27) & 31; g0 = (hi >>> 19) & 31; b0 = (hi >>> 11) & 31;
      r1 = r0 + (((hi >>> 24) & 7) << 29 >> 29); g1 = g0 + (((hi >>> 16) & 7) << 29 >> 29); b1 = b0 + (((hi >>> 8) & 7) << 29 >> 29);
      r0 = (r0 << 3) | (r0 >> 2); g0 = (g0 << 3) | (g0 >> 2); b0 = (b0 << 3) | (b0 >> 2);
      r1 = (r1 << 3) | (r1 >> 2); g1 = (g1 << 3) | (g1 >> 2); b1 = (b1 << 3) | (b1 >> 2);
    } else {
      r0 = ((hi >>> 28) & 15) * 17; g0 = ((hi >>> 20) & 15) * 17; b0 = ((hi >>> 12) & 15) * 17;
      r1 = ((hi >>> 24) & 15) * 17; g1 = ((hi >>> 16) & 15) * 17; b1 = ((hi >>> 8) & 15) * 17;
    }
    const m0 = ETC_MOD[(hi >>> 5) & 7], m1 = ETC_MOD[(hi >>> 2) & 7];
    for (let sx = 0; sx < 4; sx++) {
      for (let sy = 0; sy < 4; sy++) {
        const texel = 4 * sx + sy;
        const second = flip ? sy >= 2 : sx >= 2;
        let mod = (second ? m1 : m0)[(lo >>> texel) & 1];
        if ((lo >>> (16 + texel)) & 1) mod = -mod;
        const r = (second ? r1 : r0) + mod, g = (second ? g1 : g0) + mod, b = (second ? b1 : b0) + mod;
        const o = ((h - 1 - (y0 + sy)) * w + x0 + sx) * 4;
        out[o] = r < 0 ? 0 : r > 255 ? 255 : r;
        out[o + 1] = g < 0 ? 0 : g > 255 ? 255 : g;
        out[o + 2] = b < 0 ? 0 : b > 255 ? 255 : b;
        out[o + 3] = hasAlpha ? (((texel < 8 ? aLo >>> (texel * 4) : aHi >>> ((texel - 8) * 4)) & 15) * 17) : 255;
      }
    }
  }

  const rd32 = (src, p) => (src[p] | (src[p + 1] << 8) | (src[p + 2] << 16) | (src[p + 3] << 24)) >>> 0;

  // Decode the 8x8 tile (tx, ty) of a tiled texture whose bytes start at src[tb] into out (RGBA8, w x h, rows
  // ordered by sampling t: t = 0 is the last stored row).
  function decodeTile(src, tb, out, w, h, tx, ty, fmt) {
    if (fmt === 12 || fmt === 13) {
      const alpha = fmt === 13;
      for (let sub = 0; sub < 4; sub++) {
        let p = tb + sub * (alpha ? 16 : 8), aLo = 0, aHi = 0;
        if (alpha) { aLo = rd32(src, p); aHi = rd32(src, p + 4); p += 8; }
        etc1Block(rd32(src, p), rd32(src, p + 4), out, w, h, tx * 8 + (sub & 1) * 4, ty * 8 + (sub >> 1) * 4, alpha, aLo, aHi);
      }
      return;
    }
    for (let fy = 0; fy < 8; fy++) {
      const y = ty * 8 + fy, row = (h - 1 - y) * w;
      for (let fx = 0; fx < 8; fx++) {
        const x = tx * 8 + fx, o = (row + x) * 4, m = MORTON[fy * 8 + fx];
        let r = 0, g = 0, b = 0, a = 255;
        switch (fmt) {
          case 0: { const p = tb + m * 4; a = src[p]; b = src[p + 1]; g = src[p + 2]; r = src[p + 3]; break; }
          case 1: { const p = tb + m * 3; b = src[p]; g = src[p + 1]; r = src[p + 2]; break; }
          case 2: { const p = tb + m * 2, v = src[p] | (src[p + 1] << 8); r = (v >>> 11) & 31; g = (v >>> 6) & 31; b = (v >>> 1) & 31; r = (r << 3) | (r >> 2); g = (g << 3) | (g >> 2); b = (b << 3) | (b >> 2); a = v & 1 ? 255 : 0; break; }
          case 3: { const p = tb + m * 2, v = src[p] | (src[p + 1] << 8); r = (v >>> 11) & 31; g = (v >>> 5) & 63; b = v & 31; r = (r << 3) | (r >> 2); g = (g << 2) | (g >> 4); b = (b << 3) | (b >> 2); break; }
          case 4: { const p = tb + m * 2, v = src[p] | (src[p + 1] << 8); r = ((v >>> 12) & 15) * 17; g = ((v >>> 8) & 15) * 17; b = ((v >>> 4) & 15) * 17; a = (v & 15) * 17; break; }
          case 5: { const p = tb + m * 2; r = g = b = src[p + 1]; a = src[p]; break; }
          case 6: { const p = tb + m * 2; r = src[p + 1]; g = src[p]; b = 0; break; }
          case 7: r = g = b = src[tb + m]; break;
          case 8: r = g = b = 0; a = src[tb + m]; break;
          case 9: { const v = src[tb + m]; r = g = b = (v >>> 4) * 17; a = (v & 15) * 17; break; }
          case 10: { const v = src[tb + (m >> 1)]; r = g = b = ((m & 1) ? v >>> 4 : v & 15) * 17; break; }
          case 11: { const v = src[tb + (m >> 1)]; r = g = b = 0; a = ((m & 1) ? v >>> 4 : v & 15) * 17; break; }
        }
        out[o] = r; out[o + 1] = g; out[o + 2] = b; out[o + 3] = a;
      }
    }
  }

  // Decode a whole tiled texture to RGBA8, rows ordered by sampling t (t = 0 is the last stored row).
  function decodeTexture(src, so, w, h, fmt) {
    const out = new Uint8Array(w * h * 4);
    const tileBytes = (64 * (TEX_BITS[fmt] || 32)) >> 3, tilesX = w >> 3;
    for (let ty = 0; ty < (h >> 3); ty++) {
      for (let tx = 0; tx < tilesX; tx++) decodeTile(src, so + (ty * tilesX + tx) * tileBytes, out, w, h, tx, ty, fmt);
    }
    return out;
  }

  // A decoded texture t whose source bytes now differ from t.raw: decode again only the tiles that changed, in
  // place, and (track) list them in t.dirtyTiles (tile indices) for the host GPU's copy. False if most of it
  // changed.
  function updateTiles(t, src, so, w, h, fmt, track) {
    const tileBytes = (64 * (TEX_BITS[fmt] || 32)) >> 3, tilesX = w >> 3, nTiles = tilesX * (h >> 3);
    const raw = t.raw, aligned = !((so + src.byteOffset) & 3) && !(tileBytes & 3);
    const words = tileBytes >> 2;
    const a32 = aligned ? new Uint32Array(raw.buffer, raw.byteOffset, raw.length >> 2) : null;
    const b32 = aligned ? new Uint32Array(src.buffer, src.byteOffset + so, raw.length >> 2) : null;
    const changed = [];
    for (let i = 0; i < nTiles; i++) {
      const o = i * tileBytes;
      let same = true;
      if (aligned) { for (let k = o >> 2, e = k + words; k < e; k++) if (a32[k] !== b32[k]) { same = false; break; } }
      else { for (let k = o, e = o + tileBytes; k < e; k++) if (raw[k] !== src[so + k]) { same = false; break; } }
      if (!same) { changed.push(i); if (changed.length > nTiles >> 1) return false; }
    }
    for (const i of changed) {
      const o = i * tileBytes;
      raw.set(src.subarray(so + o, so + o + tileBytes), o);
      decodeTile(src, so + o, t.data, w, h, i % tilesX, (i / tilesX) | 0, fmt);
    }
    if (changed.length && track) t.dirtyTiles = t.dirtyTiles ? t.dirtyTiles.concat(changed) : changed;
    return true;
  }

  // Does a[0..n) equal b[off..off+n)? Word-wise when both are 4-byte aligned.
  function sameBytes(a, b, off) {
    const n = a.length;
    if (off + n > b.length) return false;
    if (!((off + b.byteOffset) & 3) && !(n & 3)) {
      const x = new Uint32Array(a.buffer, a.byteOffset, n >> 2), y = new Uint32Array(b.buffer, b.byteOffset + off, n >> 2);
      for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
      return true;
    }
    for (let i = 0; i < n; i++) if (a[i] !== b[off + i]) return false;
    return true;
  }

  function wrapCoord(mode, v, size) {
    switch (mode) {
      case 1: return v < 0 || v >= size ? -1 : v;            // clamp to border
      case 2: return ((v % size) + size) % size;              // repeat
      case 3: { const p = size * 2; v = ((v % p) + p) % p; return v >= size ? p - 1 - v : v; } // mirrored repeat
      default: return v < 0 ? 0 : v >= size ? size - 1 : v;   // clamp to edge
    }
  }

  // ------------------------------------------------------------------ fixed-function helpers
  function compare(func, a, b) {
    switch (func) {
      case 0: return false; case 1: return true; case 2: return a === b; case 3: return a !== b;
      case 4: return a < b; case 5: return a <= b; case 6: return a > b; default: return a >= b;
    }
  }

  function stencilOp(op, old, ref) {
    switch (op) {
      case 0: return old; case 1: return 0; case 2: return ref;
      case 3: return old === 255 ? 255 : old + 1;
      case 4: return old === 0 ? 0 : old - 1;
      case 5: return ~old & 0xFF;
      case 6: return (old + 1) & 0xFF;
      default: return (old - 1) & 0xFF;
    }
  }

  // ------------------------------------------------------------------ fragment program compiler
  // The per-pixel work (texturing, texture combiners, fog, alpha test, blending, color write) is
  // generated as JavaScript specialised for the current state, instead of interpreting the
  // register state for every pixel. Generated code is cached by the state that shapes it;
  // constants (colors, references, texture data) are bound when a program is instantiated.
  const fragCache = new Map();

  const OPERANDS_USED = [1, 2, 2, 2, 3, 2, 2, 2, 3, 3]; // per combiner op: Replace, Modulate, Add, ...

  function fragmentKey(st) {
    return JSON.stringify([
      st.tev.map((s) => (s.passthrough ? 0 : [s.rgbSrc, s.aSrc, s.rgbOp, s.aOp, s.rgbCmb, s.aCmb, s.rgbScale, s.aScale])),
      st.updRGB, st.updA, st.tex2uv1, !!st.lighting, st.fog, st.alphaTest ? st.alphaFunc : -1,
      st.textures.map((t) => t && [t.wrapS, t.wrapT, t.linear, t.project, t.pow2]),
      st.blend, st.eqRGB, st.eqA, st.srcRGB, st.dstRGB, st.srcA, st.dstA, st.logic, st.colorMask, st.colorFmt,
    ]);
  }

  function compileFragment(st, gpu) {
    const key = fragmentKey(st);
    let f = fragCache.get(key);
    if (!f) {
      f = { shade: new Function('st', 'gpu', 'H', genShade(st)), write: new Function('st', 'H', genWrite(st)) };
      if (fragCache.size > 512) fragCache.clear();
      fragCache.set(key, f);
    }
    st.shade = f.shade(st, gpu, HELPERS);
    st.write = f.write(st, HELPERS);
  }

  const HELPERS = {
    H0: (x) => (x < 0 ? 0 : x), H2: (x) => (x > 255 ? 255 : x), CL: (x) => (x < 0 ? 0 : x > 255 ? 255 : x),
    MORTON, stencilOp,
    rightOrBottom: (vx, vy, ax, ay, bx, by) => (ay === by ? vy < ay : vx < ax + (bx - ax) * (vy - ay) / (by - ay)),
  };

  // Expression for a source channel (0-3) of TEV source `src` in stage `s`
  function srcExpr(src, ch, s) {
    const c = 'RGBA'[ch];
    switch (src) {
      case 0: return 'p' + c;
      case 1: return 'lp' + c;
      case 2: return 'ls' + c;
      case 3: return 't0' + c;
      case 4: return 't1' + c;
      case 5: return 't2' + c;
      case 6: return '0';
      case 13: return 'b' + c;
      case 14: return `k${s}${c}`;
      default: return 'o' + c;
    }
  }

  function rgbOperandExpr(op, src, s) {
    const e = (ch) => srcExpr(src, ch, s), inv = (x) => `(255 - ${x})`;
    switch (op) {
      case 1: return [inv(e(0)), inv(e(1)), inv(e(2))];
      case 2: return [e(3), e(3), e(3)];
      case 3: return [inv(e(3)), inv(e(3)), inv(e(3))];
      case 4: return [e(0), e(0), e(0)];
      case 5: return [inv(e(0)), inv(e(0)), inv(e(0))];
      case 8: return [e(1), e(1), e(1)];
      case 9: return [inv(e(1)), inv(e(1)), inv(e(1))];
      case 12: return [e(2), e(2), e(2)];
      case 13: return [inv(e(2)), inv(e(2)), inv(e(2))];
      default: return [e(0), e(1), e(2)];
    }
  }

  function alphaOperandExpr(op, src, s) {
    const e = (ch) => srcExpr(src, ch, s);
    return [e(3), `(255 - ${e(3)})`, e(0), `(255 - ${e(0)})`, e(1), `(255 - ${e(1)})`, e(2), `(255 - ${e(2)})`][op] || e(3);
  }

  function combineExpr(op, a, b, c) {
    switch (op) {
      case 1: return `((${a} * ${b} / 255) | 0)`;
      case 2: return `H2(${a} + ${b})`;
      case 3: return `CL(${a} + ${b} - 128)`;
      case 4: return `(((${a} * ${c} + ${b} * (255 - ${c})) / 255) | 0)`;
      case 5: return `H0(${a} - ${b})`;
      case 8: return `H2(((${a} * ${b} + 255 * ${c}) / 255) | 0)`;
      case 9: return `((H2(${a} + ${b}) * ${c} / 255) | 0)`;
      default: return a;
    }
  }

  function genTexture(t, T, st) {
    const u = t === 0 ? 'I[12]' : t === 1 || st.tex2uv1 ? 'I[14]' : 'I[22]';
    const v = t === 0 ? 'I[13]' : t === 1 || st.tex2uv1 ? 'I[15]' : 'I[23]';
    const o = `t${t}`;
    let code = `let ${o}R = 0, ${o}G = 0, ${o}B = 0, ${o}A = 0;\n{ let u = ${u}, v = ${v};\n`;
    if (t === 0 && T.project) code += 'const w = I[16]; if (w) { u /= w; v /= w; }\n';
    // Repeat and mirror wrap with power-of-two sizes use masks: ToInt32 wraps modulo 2^32, so the result equals
    // the floating-point modulo for every finite integer. NaN and infinities must still give NaN (an undefined
    // texel, read as 0); with bilinear filtering their weights are NaN anyway, so the guard is only needed
    // for nearest sampling.
    const wrap = (mode, x, size, guardNaN) => {
      const finite = (code) => (guardNaN ? `if (${x} - ${x} === 0) { ${code} } else ${x} = NaN;` : code);
      switch (mode) {
        case 1: return `if (${x} < 0 || ${x} >= ${size}) out = true;`;
        case 2:
          if (T.pow2) return finite(`${x} &= ${size} - 1;`);
          return `${x} = ((${x} % ${size}) + ${size}) % ${size};`;
        case 3:
          if (T.pow2) return finite(`${x} &= ${size} * 2 - 1; if (${x} >= ${size}) ${x} = ${size} * 2 - 1 - ${x};`);
          return `{ const p = ${size} * 2; ${x} = ((${x} % p) + p) % p; if (${x} >= ${size}) ${x} = p - 1 - ${x}; }`;
        default: return `${x} = ${x} < 0 ? 0 : ${x} >= ${size} ? ${size} - 1 : ${x};`;
      }
    };
    if (T.linear) {
      // Bilinear: wrap the two columns and two rows once, then blend four texels.
      const W = `W${t}`, TH = `TH${t}`, D = `D${t}`, BD = `BD${t}`;
      const wrapB = (mode, x, size, flag) => (mode === 1 ? `const ${flag} = ${x} < 0 || ${x} >= ${size};` : wrap(mode, x, size));
      code += `const fu = u * ${W} - 0.5, fv = v * ${TH} - 0.5;
        let s0 = Math.floor(fu), q0 = Math.floor(fv);
        const ax = fu - s0, ay = fv - q0;
        let s1 = s0 + 1, q1 = q0 + 1;
        ${wrapB(T.wrapS, 's0', W, 'os0')} ${wrapB(T.wrapS, 's1', W, 'os1')}
        ${wrapB(T.wrapT, 'q0', TH, 'oq0')} ${wrapB(T.wrapT, 'q1', TH, 'oq1')}
        const w00 = (1 - ax) * (1 - ay), w10 = ax * (1 - ay), w01 = (1 - ax) * ay, w11 = ax * ay;\n`;
      const tap = (name, sv, qv, os, oq) => {
        const cond = [T.wrapS === 1 ? os : null, T.wrapT === 1 ? oq : null].filter(Boolean).join(' || ');
        const fetch = `D32${t}[${qv} * ${W} + ${sv}]`;
        code += `const ${name} = ${cond ? `${cond} ? BP${t} : ${fetch}` : fetch};\n`;
      };
      tap('x00', 's0', 'q0', 'os0', 'oq0'); tap('x10', 's1', 'q0', 'os1', 'oq0'); tap('x01', 's0', 'q1', 'os0', 'oq1'); tap('x11', 's1', 'q1', 'os1', 'oq1');
      const ch = (x, k) => (k === 3 ? `(${x} >>> 24)` : k ? `((${x} >>> ${k * 8}) & 255)` : `(${x} & 255)`);
      ['R', 'G', 'B', 'A'].forEach((c, k) => {
        code += `${o}${c} = (${ch('x00', k)} * w00 + ${ch('x10', k)} * w10 + ${ch('x01', k)} * w01 + ${ch('x11', k)} * w11 + 0.5) | 0;\n`;
      });
      return code + '}\n';
    }
    code += `let s = Math.floor(u * W${t}), q = Math.floor(v * TH${t}), out = false;\n`;
    code += wrap(T.wrapS, 's', `W${t}`, true) + '\n' + wrap(T.wrapT, 'q', `TH${t}`, true) + '\n';
    code += `if (out) { ${o}R = BD${t}[0]; ${o}G = BD${t}[1]; ${o}B = BD${t}[2]; ${o}A = BD${t}[3]; }\n`;
    code += `else { const x = D32${t}[q * W${t} + s]; ${o}R = x & 255; ${o}G = (x >>> 8) & 255; ${o}B = (x >>> 16) & 255; ${o}A = x >>> 24; }\n}\n`;
    return code;
  }

  function genShadeParts(st) {
    // Which sources do active stages read?
    const used = new Set();
    st.tev.forEach((s) => {
      if (s.passthrough) return;
      const nRgb = s.rgbCmb === 6 || s.rgbCmb === 7 ? 2 : OPERANDS_USED[s.rgbCmb] || 1;
      const nA = s.rgbCmb === 7 ? 0 : OPERANDS_USED[s.aCmb] || 1;
      for (let k = 0; k < nRgb; k++) used.add(s.rgbSrc[k]);
      for (let k = 0; k < nA; k++) used.add(s.aSrc[k]);
    });
    let pre = 'const F = gpu.F, L = st.lighting;\n';
    let body = '';
    if (used.has(0)) body += 'const pR = (I[8] * 255 + 0.5) | 0, pG = (I[9] * 255 + 0.5) | 0, pB = (I[10] * 255 + 0.5) | 0, pA = (I[11] * 255 + 0.5) | 0;\n';
    for (let t = 0; t < 3; t++) {
      if (!used.has(3 + t)) continue;
      const T = st.textures[t];
      if (!T) { body += `const t${t}R = 0, t${t}G = 0, t${t}B = 0, t${t}A = 0;\n`; continue; }
      pre += `const T${t} = st.textures[${t}], D32${t} = T${t}.data32, W${t} = T${t}.w, TH${t} = T${t}.h, BD${t} = T${t}.border, BP${t} = T${t}.borderPacked;\n`;
      body += genTexture(t, T, st);
    }
    if (used.has(1) || used.has(2)) {
      body += st.lighting ? 'gpu.light(L, I);\n' : '';
      body += 'const lpR = F.lp[0], lpG = F.lp[1], lpB = F.lp[2], lpA = F.lp[3], lsR = F.ls[0], lsG = F.ls[1], lsB = F.ls[2], lsA = F.ls[3];\n';
    }
    pre += 'const BI = st.bufferInit;\n';
    body += 'let oR = 0, oG = 0, oB = 0, oA = 0, bR = 0, bG = 0, bB = 0, bA = 0;\n';
    body += 'let nR = BI[0], nG = BI[1], nB = BI[2], nA = BI[3];\n';
    st.tev.forEach((s, i) => {
      if (!s.passthrough) {
        pre += `const k${i}R = st.tev[${i}].konst[0], k${i}G = st.tev[${i}].konst[1], k${i}B = st.tev[${i}].konst[2], k${i}A = st.tev[${i}].konst[3];\n`;
        const A = rgbOperandExpr(s.rgbOp[0], s.rgbSrc[0], i), B = rgbOperandExpr(s.rgbOp[1], s.rgbSrc[1], i), C = rgbOperandExpr(s.rgbOp[2], s.rgbSrc[2], i);
        body += '{\n';
        const n = s.rgbCmb === 6 || s.rgbCmb === 7 ? 2 : OPERANDS_USED[s.rgbCmb] || 1;
        for (let ch = 0; ch < 3; ch++) {
          body += `const a${ch} = ${A[ch]}` + (n > 1 ? `, b${ch} = ${B[ch]}` : '') + (n > 2 ? `, c${ch} = ${C[ch]}` : '') + ';\n';
        }
        if (s.rgbCmb === 6 || s.rgbCmb === 7) {
          body += 'const d = CL(Math.trunc(((a0 * 2 - 255) * (b0 * 2 - 255) + 128) / 256) + Math.trunc(((a1 * 2 - 255) * (b1 * 2 - 255) + 128) / 256) + Math.trunc(((a2 * 2 - 255) * (b2 * 2 - 255) + 128) / 256));\n';
          body += 'let rr = d, rg = d, rb = d;\n';
        } else {
          body += `let rr = ${combineExpr(s.rgbCmb, 'a0', 'b0', 'c0')}, rg = ${combineExpr(s.rgbCmb, 'a1', 'b1', 'c1')}, rb = ${combineExpr(s.rgbCmb, 'a2', 'b2', 'c2')};\n`;
        }
        if (s.rgbCmb === 7) body += 'let ra = rr;\n';
        else {
          const na = OPERANDS_USED[s.aCmb] || 1;
          const aa = alphaOperandExpr(s.aOp[0], s.aSrc[0], i), ab = alphaOperandExpr(s.aOp[1], s.aSrc[1], i), ac = alphaOperandExpr(s.aOp[2], s.aSrc[2], i);
          body += `const xa = ${aa}` + (na > 1 ? `, xb = ${ab}` : '') + (na > 2 ? `, xc = ${ac}` : '') + ';\n';
          body += `let ra = ${combineExpr(s.aCmb, 'xa', 'xb', 'xc')};\n`;
        }
        const sc = (x, k) => (k === 1 ? x : `H2(${x} * ${k})`);
        body += `oR = ${sc('rr', s.rgbScale)}; oG = ${sc('rg', s.rgbScale)}; oB = ${sc('rb', s.rgbScale)}; oA = ${sc('ra', s.aScale)};\n}\n`;
      }
      body += 'bR = nR; bG = nG; bB = nB; bA = nA;\n';
      if (i < 4 && (st.updRGB & (1 << i))) body += 'nR = oR; nG = oG; nB = oB;\n';
      if (i < 4 && (st.updA & (1 << i))) body += 'nA = oA;\n';
    });
    if (st.fog) {
      pre += 'const FL = gpu.fogLut, FC = st.fogColor, FF = st.fogFlip;\n';
      body += `{ const idx = (FF ? 1 - depth : depth) * 128, i = Math.min(127, Math.max(0, Math.floor(idx))), e = FL[i];
        let f = ((e >>> 13) & 0x7FF) / 2047 + (((e & 0x1FFF) << 19) >> 19) / 2047 * (idx - i);
        f = f < 0 ? 0 : f > 1 ? 1 : f;
        oR = (oR * f + FC[0] * (1 - f)) | 0; oG = (oG * f + FC[1] * (1 - f)) | 0; oB = (oB * f + FC[2] * (1 - f)) | 0; }\n`;
    }
    if (st.alphaTest) {
      pre += 'const AREF = st.alphaRef;\n';
      const cmp = ['false', 'true', 'oA === AREF', 'oA !== AREF', 'oA < AREF', 'oA <= AREF', 'oA > AREF', 'oA >= AREF'][st.alphaFunc];
      body += `if (!(${cmp})) return -1;\n`;
    }
    body += 'return ((oR << 24) | (oG << 16) | (oB << 8) | oA) >>> 0;\n';
    return { pre, body };
  }

  // Clamping helpers shared by all generated code (one identity, so call sites stay monomorphic)
  const FRAG_HELPERS = 'const H0 = H.H0, H2 = H.H2, CL = H.CL;\n';

  function genShade(st) {
    const { pre, body } = genShadeParts(st);
    return `${FRAG_HELPERS}${pre}return function shade(I, depth) {\n${body}};`;
  }

  function genWrite(st) {
    const { pre, body } = genWriteParts(st);
    return `${FRAG_HELPERS}${pre}return function write(c, u8, o) {\n${body}};`;
  }

  function genWriteParts(st) {
    const fmt = st.colorFmt;
    const pre = 'const BC = st.blendConst, cR = BC[0], cG = BC[1], cB = BC[2], cA = BC[3];\n';
    const needDst = st.blend || st.logic !== 3 || st.colorMask !== 0xF;
    let body = 'let r = c >>> 24, g = (c >>> 16) & 255, b = (c >>> 8) & 255, a = c & 255;\n';
    if (needDst) {
      body += 'let dR, dG, dB, dA;\n';
      body += [
        'dR = u8[o + 3]; dG = u8[o + 2]; dB = u8[o + 1]; dA = u8[o];',
        'dR = u8[o + 2]; dG = u8[o + 1]; dB = u8[o]; dA = 255;',
        '{ const v = u8[o] | (u8[o + 1] << 8); dR = (v >>> 11) & 31; dG = (v >>> 6) & 31; dB = (v >>> 1) & 31; dR = (dR << 3) | (dR >> 2); dG = (dG << 3) | (dG >> 2); dB = (dB << 3) | (dB >> 2); dA = v & 1 ? 255 : 0; }',
        '{ const v = u8[o] | (u8[o + 1] << 8); dR = (v >>> 11) & 31; dG = (v >>> 5) & 63; dB = v & 31; dR = (dR << 3) | (dR >> 2); dG = (dG << 2) | (dG >> 4); dB = (dB << 3) | (dB >> 2); dA = 255; }',
        '{ const v = u8[o] | (u8[o + 1] << 8); dR = ((v >>> 12) & 15) * 17; dG = ((v >>> 8) & 15) * 17; dB = ((v >>> 4) & 15) * 17; dA = (v & 15) * 17; }',
      ][fmt] + '\n';
    }
    if (st.blend) {
      const S = ['r', 'g', 'b', 'a'], Dn = ['dR', 'dG', 'dB', 'dA'], Cn = ['cR', 'cG', 'cB', 'cA'];
      const factor = (f, ch) => [
        '0', '255', S[ch], `(255 - ${S[ch]})`, Dn[ch], `(255 - ${Dn[ch]})`, 'a', '(255 - a)', 'dA', '(255 - dA)',
        Cn[ch], `(255 - ${Cn[ch]})`, 'cA', '(255 - cA)', ch === 3 ? '255' : 'Math.min(a, 255 - dA)',
      ][f] || '0';
      const eq = (e, ch, sf, df) => {
        const s = S[ch], d = Dn[ch];
        switch (e) {
          case 1: return `CL(((${s} * ${sf} - ${d} * ${df}) / 255) | 0)`;
          case 2: return `CL(((${d} * ${df} - ${s} * ${sf}) / 255) | 0)`;
          case 3: return `Math.min(${s}, ${d})`;
          case 4: return `Math.max(${s}, ${d})`;
          default: return `CL(((${s} * ${sf} + ${d} * ${df}) / 255) | 0)`;
        }
      };
      body += `const nr = ${eq(st.eqRGB, 0, factor(st.srcRGB, 0), factor(st.dstRGB, 0))};\n`;
      body += `const ng = ${eq(st.eqRGB, 1, factor(st.srcRGB, 1), factor(st.dstRGB, 1))};\n`;
      body += `const nb = ${eq(st.eqRGB, 2, factor(st.srcRGB, 2), factor(st.dstRGB, 2))};\n`;
      body += `const na = ${eq(st.eqA, 3, factor(st.srcA, 3), factor(st.dstA, 3))};\n`;
      body += 'r = nr; g = ng; b = nb; a = na;\n';
    } else if (st.logic !== 3) {
      const lop = (s, d) => [
        '0', `${s} & ${d}`, `${s} & ~${d} & 255`, s, '255', `~${s} & 255`, d, `~${d} & 255`, `~(${s} & ${d}) & 255`,
        `${s} | ${d}`, `~(${s} | ${d}) & 255`, `${s} ^ ${d}`, `~(${s} ^ ${d}) & 255`, `~${s} & ${d} & 255`, `(${s} | ~${d}) & 255`, `(~${s} | ${d}) & 255`,
      ][st.logic];
      body += `r = ${lop('r', 'dR')}; g = ${lop('g', 'dG')}; b = ${lop('b', 'dB')}; a = ${lop('a', 'dA')};\n`;
    }
    const cm = st.colorMask;
    if (!(cm & 1)) body += 'r = dR;\n';
    if (!(cm & 2)) body += 'g = dG;\n';
    if (!(cm & 4)) body += 'b = dB;\n';
    if (!(cm & 8)) body += 'a = dA;\n';
    body += [
      'u8[o] = a; u8[o + 1] = b; u8[o + 2] = g; u8[o + 3] = r;',
      'u8[o] = b; u8[o + 1] = g; u8[o + 2] = r;',
      '{ const v = ((r >> 3) << 11) | ((g >> 3) << 6) | ((b >> 3) << 1) | (a >> 7); u8[o] = v; u8[o + 1] = v >> 8; }',
      '{ const v = ((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3); u8[o] = v; u8[o + 1] = v >> 8; }',
      '{ const v = ((r >> 4) << 12) | ((g >> 4) << 8) | ((b >> 4) << 4) | (a >> 4); u8[o] = v; u8[o + 1] = v >> 8; }',
    ][fmt] + '\n';
    return { pre, body };
  }

  // ------------------------------------------------------------------ rasterizer compiler
  // A whole triangle rasterizer generated per state: edge setup, the covered span of each row,
  // depth/stencil tests, perspective-correct interpolation of exactly the attributes the state
  // needs, and the fragment program inlined into the pixel loop. It performs the same arithmetic
  // in the same order as Gpu.rasterize (the reference path), so the output is bit-identical.
  const rasterCache = new Map();

  const cmpExpr = (func, a, b) => ['false', 'true', `${a} === ${b}`, `${a} !== ${b}`, `${a} < ${b}`, `${a} <= ${b}`, `${a} > ${b}`, `${a} >= ${b}`][func];

  function rasterKey(st) {
    return JSON.stringify([
      fragmentKey(st), st.need, st.cull, st.scissor, !!st.color, st.colorBpp, !!st.depth, st.depthBpp, st.depthFmt,
      st.depthTest, st.depthFunc, st.depthWrite, st.stencil, st.stencilFunc, !!st.stencilWriteMask, st.sFail, st.sZFail, st.sZPass,
    ]);
  }

  function genRaster(st) {
    const shade = genShadeParts(st), write = genWriteParts(st);
    const need = st.need, lit = !!st.lighting;
    // Interpolated attributes become locals ($aN); the fragment program reads them directly.
    const used = new Set(need);
    let body = shade.body.replace(/\bI\[(\d+)\]/g, (m, n) => { used.add(+n); return `$a${n}`; });
    body = body.replace(/\bdepth\b/g, '$z');
    body = body.replace(/return -1;/g, 'continue;');
    body = body.replace(/return (\(\(oR << 24\)[^;]*);/, '$col = $1;');
    if (/\breturn\b/.test(body) || /\breturn\b/.test(write.body)) throw new Error('rasterizer: unexpected return in fragment program');
    const fogged = /\$z/.test(body);

    const depth = !!st.depth, dbpp = st.depthBpp, stencil = !!st.stencil;
    const earlyZ = st.depthTest && !stencil;
    const needZ = fogged || (depth && (st.depthTest || st.depthWrite));
    const cov = (x) => `($w0r + $e0a * (${x} - minX) >= 0 && $w1r + $e1a * (${x} - minX) >= 0 && $w2r + $e2a * (${x} - minX) >= 0)`;
    const stencilWrite = (op) => (st.stencilWriteMask ? `{ const nv = SOP(${op}, sv, SREF); DU8[dAddr + 3] = (sv & ~SWM) | (nv & SWM); drawn = true; }` : '');

    // Generated once per state shape; everything that varies between draws of that shape is read from st.
    let code = `${FRAG_HELPERS}const MORTON = H.MORTON, SOP = H.stencilOp, rightOrBottom = H.rightOrBottom;
    return function raster(st, gpu, v0, v1, v2) {
      ${shade.pre}${write.pre}
      const I = gpu.I;
      const FBW = st.fbW, FBH = st.fbH, HREG = st.fbHreg, CBPP = st.colorBpp;
      const SX0 = st.sx0, SY0 = st.sy0, SX1 = st.sx1, SY1 = st.sy1, DSCALE = st.depthScale, DOFF = st.depthOffset;
      const CU8 = st.color && st.color.u8, COFF = st.color ? st.color.off : 0, DU8 = st.depth && st.depth.u8, DOFF8 = st.depth ? st.depth.off : 0;
      const DMAX = st.depthFmt === 0 ? 0xFFFF : 0xFFFFFF;
      const SREF = st.stencilRef, SWM = st.stencilWriteMask, SREFM = st.stencilRef & st.stencilMask, SMASK = st.stencilMask;
      const x0 = Math.round(v0.x * 16), y0 = Math.round(v0.y * 16);
      let x1 = Math.round(v1.x * 16), y1 = Math.round(v1.y * 16);
      let x2 = Math.round(v2.x * 16), y2 = Math.round(v2.y * 16);
      let area = (x1 - x0) * (y2 - y0) - (y1 - y0) * (x2 - x0);
      if (area === 0) return 0;
      ${st.cull === 1 ? 'if (area > 0) return 0;' : st.cull === 2 ? 'if (area < 0) return 0;' : ''}
      if (area < 0) {
        const t = v1; v1 = v2; v2 = t;
        let tt = x1; x1 = x2; x2 = tt; tt = y1; y1 = y2; y2 = tt;
        area = -area;
      }
      let minX = Math.max(0, Math.floor(Math.min(x0, x1, x2) / 16)), maxX = Math.min(FBW - 1, Math.ceil(Math.max(x0, x1, x2) / 16));
      let minY = Math.max(0, Math.floor(Math.min(y0, y1, y2) / 16)), maxY = Math.min(FBH - 1, Math.ceil(Math.max(y0, y1, y2) / 16));
      ${st.scissor === 3 ? 'minX = Math.max(minX, SX0); maxX = Math.min(maxX, SX1); minY = Math.max(minY, SY0); maxY = Math.min(maxY, SY1);' : ''}
      if (minX > maxX || minY > maxY) return 0;
      const bias0 = rightOrBottom(x0, y0, x1, y1, x2, y2) ? -1 : 0;
      const bias1 = rightOrBottom(x1, y1, x2, y2, x0, y0) ? -1 : 0;
      const bias2 = rightOrBottom(x2, y2, x0, y0, x1, y1) ? -1 : 0;
      const $e0a = (y1 - y2) * 16, $e0b = (x2 - x1) * 16, $e1a = (y2 - y0) * 16, $e1b = (x0 - x2) * 16, $e2a = (y0 - y1) * 16, $e2b = (x1 - x0) * 16;
      const px0 = minX * 16 + 8, py0 = minY * 16 + 8;
      let $w0r = (x2 - x1) * (py0 - y1) - (y2 - y1) * (px0 - x1) + bias0;
      let $w1r = (x0 - x2) * (py0 - y2) - (y0 - y2) * (px0 - x2) + bias1;
      let $w2r = (x1 - x0) * (py0 - y0) - (y1 - y0) * (px0 - x0) + bias2;
      const a0 = v0.a, iw0 = v0.iw, iw1 = v1.iw, iw2 = v2.iw;
      let a1 = v1.a, a2 = v2.a;\n`;
    if (lit) code += `{ const flip = (a) => { const d = a0[4] * a[4] + a0[5] * a[5] + a0[6] * a[6] + a0[7] * a[7]; if (d >= 0) return a; const c = Array.from(a); for (let k = 4; k < 8; k++) c[k] = -c[k]; return c; };
        a1 = flip(a1); a2 = flip(a2); }\n`;
    for (const s of need) code += `const P0_${s} = a0[${s}] * iw0, P1_${s} = a1[${s}] * iw1, P2_${s} = a2[${s}] * iw2;\n`;
    code += `const inv = 1 / area, z0 = v0.z, z1 = v1.z, z2 = v2.z;
      let drawn = false, frags = 0;
      for (let y = minY; y <= maxY; y++, $w0r += $e0b, $w1r += $e1b, $w2r += $e2b) {
        const fy = HREG - y;
        if (fy < 0) continue;
        // Covered span of this row: estimate from each edge, then settle on the exact boundary
        let lo = minX, hi = maxX;\n`;
    for (const k of [0, 1, 2]) {
      code += `if ($e${k}a > 0) { if ($w${k}r < 0) lo = Math.max(lo, minX + Math.ceil(-$w${k}r / $e${k}a)); }
        else if ($e${k}a < 0) { if ($w${k}r < 0) continue; hi = Math.min(hi, minX + Math.floor($w${k}r / -$e${k}a)); }
        else if ($w${k}r < 0) continue;\n`;
    }
    code += `while (lo > minX && ${cov('lo - 1')}) lo--;
        while (lo <= hi && !${cov('lo')}) lo++;
        while (hi < maxX && ${cov('hi + 1')}) hi++;
        while (hi >= lo && !${cov('hi')}) hi--;
        if (lo > hi) continue;
        const rowBase = (fy & ~7) * FBW, mrow = (fy & 7) * 8;
        let w0 = $w0r + $e0a * (lo - minX), w1 = $w1r + $e1a * (lo - minX), w2 = $w2r + $e2a * (lo - minX);
        for (let x = lo; x <= hi; x++, w0 += $e0a, w1 += $e1a, w2 += $e2a) {
          ${st.scissor === 1 ? 'if (x >= SX0 && x <= SX1 && y >= SY0 && y <= SY1) continue;' : ''}
          const pix = rowBase + (x & ~7) * 8 + MORTON[mrow + (x & 7)];
          const b0 = w0 * inv, b1 = w1 * inv, b2 = w2 * inv;\n`;
    if (needZ) code += `let $z = (b0 * z0 + b1 * z1 + b2 * z2) * DSCALE + DOFF;
          $z = $z < 0 ? 0 : $z > 1 ? 1 : $z;
          const zi = Math.round($z * DMAX);\n`;
    if (depth) {
      code += `const dAddr = DOFF8 + pix * ${dbpp};
          const stored = ${dbpp === 2 ? 'DU8[dAddr] | (DU8[dAddr + 1] << 8)' : 'DU8[dAddr] | (DU8[dAddr + 1] << 8) | (DU8[dAddr + 2] << 16)'};\n`;
      if (earlyZ) code += `if (!(${cmpExpr(st.depthFunc, 'zi', 'stored')})) continue;\n`;
    }
    code += 'const pw = 1 / (b0 * iw0 + b1 * iw1 + b2 * iw2);\n';
    for (const s of used) {
      if (need.includes(s)) code += `const $a${s} = (b0 * P0_${s} + b1 * P1_${s} + b2 * P2_${s}) * pw;\n`;
      else code += `const $a${s} = I[${s}];\n`; // not interpolated by this state: the reference path reads the last value
    }
    if (lit) for (const s of need) code += `I[${s}] = $a${s};\n`; // the lighting helper reads I
    code += `let $col = 0;\n{\n${body}}\n`;
    if (stencil) {
      code += `const sv = DU8[dAddr + 3];
          if (!(${cmpExpr(st.stencilFunc, 'SREFM', '(sv & SMASK)')})) { ${stencilWrite(st.sFail)} continue; }
          ${st.depthTest ? `if (!(${cmpExpr(st.depthFunc, 'zi', 'stored')})) { ${stencilWrite(st.sZFail)} continue; }` : ''}
          ${stencilWrite(st.sZPass)}\n`;
    }
    if (st.depthWrite) code += `DU8[dAddr] = zi; DU8[dAddr + 1] = zi >>> 8;${dbpp >= 3 ? ' DU8[dAddr + 2] = zi >>> 16;' : ''}\n`;
    code += 'drawn = true; frags++;\n';
    if (st.colorMask) code += `{ const c = $col, u8 = CU8, o = COFF + pix * CBPP;\n${write.body}}\n`;
    code += `}
      }
      if (drawn) st.drawn = true;
      return frags;
    };`;
    return code;
  }

  function compileRaster(st) {
    const key = rasterKey(st);
    let f = rasterCache.get(key);
    if (!f) {
      f = new Function('H', genRaster(st))(HELPERS);
      if (rasterCache.size > 512) rasterCache.clear();
      rasterCache.set(key, f);
    }
    st.raster = f;
  }

  // ------------------------------------------------------------------ the GPU
  // Semantic slots in an output vertex (matching the VS output map encoding)
  const SEM = { POS: 0, QUAT: 4, COLOR: 8, UV0: 12, UV1: 14, UV0W: 16, VIEW: 18, UV2: 22, COUNT: 24 };

  // Clip against the near/far planes, w > 0 and a guard band for x/y.
  const GUARD = 16;
  const CLIP_PLANES = [
    (v) => -v[2],              // z <= 0
    (v) => v[2] + v[3],        // z >= -w
    (v) => v[3] - 1e-5,        // w > 0
    (v) => GUARD * v[3] - v[0], (v) => GUARD * v[3] + v[0],
    (v) => GUARD * v[3] - v[1], (v) => GUARD * v[3] + v[1],
  ];
  const insideClip = (v) => -v[2] >= 0 && v[2] + v[3] >= 0 && v[3] - 1e-5 >= 0 &&
    GUARD * v[3] - v[0] >= 0 && GUARD * v[3] + v[0] >= 0 && GUARD * v[3] - v[1] >= 0 && GUARD * v[3] + v[1] >= 0;

  class Gpu {
    constructor(emu) {
      this.emu = emu;
      this.regs = new Uint32Array(0x400);
      this.vs = new ShaderUnit('vs');
      this.gs = new ShaderUnit('gs');
      this.defaults = new Float32Array(16 * 4);
      this.fixedBuf = [0, 0, 0];
      this.fixedCount = 0;
      this.immediate = [];
      this.uniScratch = new Int32Array(12);
      // Geometry shader input buffer (vertex shader outputs waiting for a full primitive) and emitted vertex slots
      this.gsIn = new Float32Array(16 * 4); this.gsFill = 0;
      this.gsSlots = [null, null, null];
      this.gs.onEmit = (unit) => this.gsEmit(unit);
      this.texCache = new Map();
      this.texBytes = 0;
      this.fullViews = new WeakMap();
      this.state = null;
      this.prim = { topology: 0, buf: [], count: 0, winding: false };
      this.stats = { lists: 0, draws: 0, triangles: 0, fragments: 0 };
      // Host GPU renderer (EMU.GLRenderer) when drawing with WebGL; null = software rasterizer
      this.gl = null;
      this.lutDirty = true; this.fogDirty = true; this.lutRows = 0xFFFFFF; // lighting/fog tables changed since the renderer last read them
      // Generated per-state rasterizers (false = the generic reference rasterizer; same output, slower)
      this.rasterJit = true;
      this.warned = new Set();
      this.lut = new Array(24).fill(null).map(() => new Uint32Array(256)); // lighting LUTs
      this.lutIndex = 0; this.lutSel = 0;
      this.fogLut = new Uint32Array(128); this.fogIndex = 0;
      // Per-fragment scratch registers
      const v4 = () => new Int32Array(4);
      this.F = {
        prim: v4(), lp: v4(), ls: v4(), tex: [v4(), v4(), v4(), v4()], out: v4(), buf: v4(), next: v4(), res: v4(), dst: v4(),
        ops: [new Int32Array(3), new Int32Array(3), new Int32Array(3)],
      };
      this.P0 = new Float64Array(SEM.COUNT); this.P1 = new Float64Array(SEM.COUNT); this.P2 = new Float64Array(SEM.COUNT);
      this.I = new Float64Array(SEM.COUNT);
      this.outMap = null; this.outMapKey = new Float64Array(9).fill(-1);
    }

    get mem() { return this.emu.mem; }

    warn(key, msg) { if (!this.warned.has(key)) { this.warned.add(key); this.emu.log(msg); } }

    // ---------------------------------------------------------------- memory access
    // GPU addresses are physical: VRAM at 0x18000000, FCRAM at 0x20000000.
    toVirt(phys) {
      phys >>>= 0;
      const aliases = this.emu.gpuAliases;
      if (aliases) for (const a of aliases) if (phys >= a.phys && phys < a.phys + a.size) return a.virt + (phys - a.phys);
      if (phys >= 0x18000000 && phys < 0x18600000) return phys + 0x07000000;
      if (phys >= 0x20000000 && phys < 0x28000000) {
        const a = phys + 0x10000000;
        if (this.mem.pages[a >>> 12]) return a >>> 0;
        return phys - 0x0C000000;
      }
      return phys;
    }

    toPhys(virt) {
      virt >>>= 0;
      if (virt >= 0x1F000000 && virt < 0x1F600000) return virt - 0x07000000;
      if (virt >= 0x30000000 && virt < 0x38000000) return virt - 0x10000000;
      if (virt >= 0x14000000 && virt < 0x1C000000) return virt + 0x0C000000;
      return virt;
    }

    // Direct view of `size` bytes at a physical address: { u8, off, copy }. Copies when not contiguous.
    span(phys, size) {
      const mem = this.mem, v = this.toVirt(phys);
      const p0 = mem.pages[v >>> 12];
      if (!p0 || size <= 0) return null;
      const last = (v + size - 1) >>> 0;
      let ok = true;
      for (let a = ((v >>> 12) + 1) * 0x1000, i = 1; a <= last; a += 0x1000, i++) {
        const p = mem.pages[a >>> 12];
        if (!p || p.buffer !== p0.buffer || p.byteOffset !== p0.byteOffset + i * 0x1000) { ok = false; break; }
      }
      if (ok) {
        let full = this.fullViews.get(p0.buffer);
        if (!full) { full = new Uint8Array(p0.buffer); this.fullViews.set(p0.buffer, full); }
        return { u8: full, off: p0.byteOffset + (v & 0xFFF), copy: false, virt: v, size };
      }
      try { return { u8: mem.readBytes(v, size), off: 0, copy: true, virt: v, size }; } catch (e) { return null; }
    }

    // Forget decoded textures overlapping [phys, phys + size).
    // Mark decoded textures overlapping [phys, phys + size) stale. A stale texture is re-checked against its
    // source bytes when next used and decoded again only if they changed (games flush texture memory every
    // frame whether or not they wrote it).
    staleTextures(phys, size) {
      if (!this.texCache.size) return;
      const end = phys + size;
      for (const t of this.texCache.values()) if (t.addr < end && t.addr + t.bytes > phys) t.stale = true;
    }

    // [phys, phys + size) was written (by a GX command or the CPU); fill: { value, bytes } for a memory fill
    invalidatePhys(phys, size, fill) {
      this.staleTextures(phys, size);
      if (this.gl) this.gl.memoryWritten(phys, size, fill);
    }

    // The CPU flushed its cache over [virt, virt + size): it may have written there. Render targets the host GPU
    // holds newer pixels for are kept (a flush alone does not change memory).
    cacheFlushed(virt, size) {
      const phys = this.toPhys(virt);
      this.staleTextures(phys, size);
      if (this.gl) this.gl.cacheFlushed(phys, size);
    }

    // Something is about to read [virt, virt + size) from memory: render targets there must be in memory
    syncToMemoryVirt(virt, size) {
      if (this.gl) this.gl.syncToMemory(this.toPhys(virt), size);
    }

    invalidateVirt(virt, size, fill) { this.invalidatePhys(this.toPhys(virt), size, fill); }

    // ---------------------------------------------------------------- command lists
    runCommandList(virt, size) {
      this.stats.lists++;
      let words = this.readWords(virt, size);
      let i = 0;
      for (let guard = 0; words && i + 1 < words.length && guard < 4000000; guard++) {
        const param = words[i], hdr = words[i + 1];
        const id = hdr & 0x3FF, mask = (hdr >>> 16) & 0xF, extra = (hdr >>> 20) & 0x7FF, seq = hdr >>> 31;
        let jump = this.write(id, param, mask);
        if (id >= 0x2C0) this.shareWithGs(id, param, mask);
        for (let k = 0; k < extra && i + 2 + k < words.length; k++) {
          const reg = seq ? (id + 1 + k) & 0x3FF : id;
          const j = this.write(reg, words[i + 2 + k], mask);
          if (reg >= 0x2C0) this.shareWithGs(reg, words[i + 2 + k], mask);
          if (j) jump = j;
        }
        i += 2 + extra + (extra & 1);
        if (jump) { words = this.readWords(this.toVirt(jump.addr), jump.size); i = 0; }
      }
      this.flushTargets();
    }

    readWords(virt, size) {
      size &= ~7;
      if (size <= 0) return null;
      try {
        const b = this.mem.readBytes(virt >>> 0, size);
        return new Uint32Array(b.buffer, b.byteOffset, size >> 2);
      } catch (e) {
        this.warn('cmdlist', `GPU: command list at ${hex(virt)} is not readable`);
        return null;
      }
    }

    // Masked register write with side effects. Returns {addr, size} for a command buffer jump.
    write(id, value, mask) {
      const r = this.regs;
      const m = (mask & 1 ? 0xFF : 0) | (mask & 2 ? 0xFF00 : 0) | (mask & 4 ? 0xFF0000 : 0) | (mask & 8 ? 0xFF000000 : 0);
      const v = ((r[id] & ~m) | (value & m)) >>> 0;
      r[id] = v;
      if (id < 0x200 && this.state) { this.flushTargets(); this.state = null; }
      switch (id) {
        case 0x110: case 0x111: this.flushTargets(); return null; // framebuffer flush / invalidate
        case 0x1C5: this.lutSel = (v >>> 8) & 0x1F; this.lutIndex = v & 0xFF; return null;
        case 0x1C8: case 0x1C9: case 0x1CA: case 0x1CB: case 0x1CC: case 0x1CD: case 0x1CE: case 0x1CF:
          if (this.lut[this.lutSel] && this.lut[this.lutSel][this.lutIndex & 0xFF] !== v) {
            this.lut[this.lutSel][this.lutIndex & 0xFF] = v;
            this.lutDirty = true;
            this.lutRows |= 1 << this.lutSel; // which tables changed
          }
          this.lutIndex++;
          return null;
        case 0x0E6: this.fogIndex = v & 0x7F; return null;
        case 0x0E8: case 0x0E9: case 0x0EA: case 0x0EB: case 0x0EC: case 0x0ED: case 0x0EE: case 0x0EF:
          this.fogLut[this.fogIndex++ & 0x7F] = v; this.fogDirty = true; return null;
        case 0x22E: this.draw(false); return null;
        case 0x22F: this.draw(true); return null;
        case 0x232: this.fixedCount = 0; if ((v & 0xF) === 0xF) { this.immediate = []; this.startPrimitive(); } return null;
        case 0x233: case 0x234: case 0x235: this.fixedAttr(value); return null;
        case 0x23C: case 0x23D: {
          const n = id - 0x23C;
          return { addr: (r[0x23A + n] & 0x1FFFFFFF) << 3, size: (r[0x238 + n] & 0x1FFFFF) << 3 };
        }
        case 0x25F: this.startPrimitive(); return null;
        case 0x2C0: this.vs.uniBuf = []; return null;
        case 0x2C1: case 0x2C2: case 0x2C3: case 0x2C4: case 0x2C5: case 0x2C6: case 0x2C7: case 0x2C8:
          this.uniformData(this.vs, 0x2C0, value); return null;
        case 0x2CC: case 0x2CD: case 0x2CE: case 0x2CF: case 0x2D0: case 0x2D1: case 0x2D2: case 0x2D3:
          this.setShaderWord(this.vs, this.vs.code, r[0x2CB] & 0xFFF, value); r[0x2CB] = (r[0x2CB] + 1) & 0xFFF; return null;
        case 0x2D6: case 0x2D7: case 0x2D8: case 0x2D9: case 0x2DA: case 0x2DB: case 0x2DC: case 0x2DD:
          this.setShaderWord(this.vs, this.vs.swizzle, r[0x2D5] & 0x7F, value); r[0x2D5] = (r[0x2D5] + 1) & 0x7F; return null;
        // geometry shader unit
        case 0x290: this.gs.uniBuf = []; return null;
        case 0x291: case 0x292: case 0x293: case 0x294: case 0x295: case 0x296: case 0x297: case 0x298:
          this.uniformData(this.gs, 0x290, value); return null;
        case 0x29C: case 0x29D: case 0x29E: case 0x29F: case 0x2A0: case 0x2A1: case 0x2A2: case 0x2A3:
          this.setShaderWord(this.gs, this.gs.code, r[0x29B] & 0xFFF, value); r[0x29B] = (r[0x29B] + 1) & 0xFFF; return null;
        case 0x2A6: case 0x2A7: case 0x2A8: case 0x2A9: case 0x2AA: case 0x2AB: case 0x2AC: case 0x2AD:
          this.setShaderWord(this.gs, this.gs.swizzle, r[0x2A5] & 0x7F, value); r[0x2A5] = (r[0x2A5] + 1) & 0x7F; return null;
      }
      return null;
    }

    setShaderWord(unit, words, index, value) {
      if (words[index] === value >>> 0) return; // unchanged: the compiled program stays valid
      words[index] = value;
      unit.invalidate();
    }

    // In shared configuration mode (0x244 bit 0 clear) program, swizzle and float uniform uploads to the
    // vertex shader unit also reach the geometry shader unit
    shareWithGs(id, value, mask) {
      if (this.regs[0x244] & 1) return;
      if ((id >= 0x2C0 && id <= 0x2C8) || (id >= 0x2CB && id <= 0x2D3) || (id >= 0x2D5 && id <= 0x2DD)) this.write(id - 0x30, value, mask);
    }

    uniformData(unit, setupReg, word) {
      const r = this.regs, setup = r[setupReg], isF32 = setup >>> 31, buf = unit.uniBuf;
      buf.push(word >>> 0);
      const need = isF32 ? 4 : 3;
      if (buf.length < need) return;
      const idx = setup & 0x7F;
      if (idx < 96) {
        const o = (0x20 + idx) * 4;
        if (isF32) for (let k = 0; k < 4; k++) unit.R[o + 3 - k] = f32(buf[k]);
        else unpackF24x4(buf, unit.R, o);
      }
      r[setupReg] = (setup & ~0x7F) | ((idx + 1) & 0x7F);
      unit.uniBuf = [];
    }

    fixedAttr(word) {
      this.fixedBuf[this.fixedCount++] = word >>> 0;
      if (this.fixedCount < 3) return;
      this.fixedCount = 0;
      const r = this.regs, index = r[0x232] & 0xF;
      if (index === 0xF) { // immediate mode: attributes of one vertex at a time
        const v = new Float32Array(4);
        unpackF24x4(this.fixedBuf, v, 0);
        this.immediate.push(v);
        const n = (r[0x242] & 0xF) + 1;
        if (this.immediate.length >= n) {
          const R = this.vs.R;
          for (let a = 0; a < n; a++) R.set(this.immediate[a], this.inputRegister(a) * 4);
          this.immediate = [];
          this.syncShaderUniforms();
          if (this.gsActive()) this.gsSubmit(this.runVertexShaderRaw());
          else this.submitVertex(this.runVertexShader());
        }
        return;
      }
      if (index < 12) unpackF24x4(this.fixedBuf, this.defaults, index * 4);
      r[0x232] = (r[0x232] & ~0xF) | ((index + 1) & 0xF);
    }

    inputRegister(attr) {
      const r = this.regs;
      return attr < 8 ? (r[0x2BB] >>> (attr * 4)) & 0xF : (r[0x2BC] >>> ((attr - 8) * 4)) & 0xF;
    }

    // ---------------------------------------------------------------- vertex processing
    syncShaderUniforms() {
      const r = this.regs;
      const ints = this.uniScratch;
      for (const [unit, base] of [[this.vs, 0x2B0], [this.gs, 0x280]]) {
        for (let k = 0; k < 4; k++) {
          const v = r[base + 1 + k];
          ints[k * 3] = v & 0xFF; ints[k * 3 + 1] = (v >>> 8) & 0xFF; ints[k * 3 + 2] = (v >>> 16) & 0xFF;
        }
        unit.setUniforms(r[base] & 0xFFFF, ints);
      }
    }

    // ---------------------------------------------------------------- geometry shader
    // Geometry shader stage on (GPUREG_GEOSTAGE_CONFIG)
    gsActive() { return (this.regs[0x229] & 3) === 2; }

    // Vertex shader outputs as the geometry shader receives them: the enabled output registers, in order
    runVertexShaderRaw() {
      const r = this.regs, vs = this.vs;
      vs.O.fill(0);
      vs.run(r[0x2BA] & 0xFFFF);
      const mask = r[0x2BD] & 0xFFFF, out = new Float32Array(16 * 4);
      let n = 0;
      for (let reg = 0; reg < 16; reg++) if (mask & (1 << reg)) { out.set(vs.O.subarray(reg * 4, reg * 4 + 4), n * 4); n++; }
      return out;
    }

    // Point mode: vertex shader outputs (GPUREG_VSH_OUTMAP_TOTAL1 + 1 registers per vertex) are queued until the
    // geometry shader's inputs (GPUREG_GSH_INPUTBUFFER_CONFIG) are full, then the geometry shader runs once.
    gsSubmit(attrs) {
      const r = this.regs, cfg = r[0x289];
      if ((cfg >>> 8) & 3) { this.warn('gsmode', 'GPU: only the point mode of geometry shaders is emulated'); return; }
      const perVertex = (r[0x24A] & 0xF) + 1, total = (cfg & 0xF) + 1;
      for (let k = 0; k < perVertex && this.gsFill < total; k++) this.gsIn.set(attrs.subarray(k * 4, k * 4 + 4), (this.gsFill++) * 4);
      if (this.gsFill < total) return;
      this.gsFill = 0;
      const gs = this.gs, R = gs.R;
      for (let a = 0; a < total; a++) {
        const reg = a < 8 ? (r[0x28B] >>> (a * 4)) & 0xF : (r[0x28C] >>> ((a - 8) * 4)) & 0xF;
        R.set(this.gsIn.subarray(a * 4, a * 4 + 4), reg * 4);
      }
      gs.O.fill(0);
      gs.run(r[0x28A] & 0xFFFF);
    }

    // EMIT: store the outputs in the selected slot; with "primitive emit" also output the slots as a triangle
    gsEmit(unit) {
      const slot = unit.emitVtx;
      if (slot > 2) return;
      this.gsSlots[slot] = this.mapOutputs(unit.O, this.regs[0x28D] & 0xFFFF);
      if (!unit.emitPrim) return;
      const [a, b, c] = this.gsSlots;
      if (!a || !b || !c) return;
      if (unit.emitWinding) this.prim.winding = true;
      this.submitVertex(a); this.submitVertex(b); this.submitVertex(c);
    }

    runVertexShader() {
      const r = this.regs, vs = this.vs;
      vs.O.fill(0);
      vs.run(r[0x2BA] & 0xFFFF);
      return this.mapOutputs(vs.O, r[0x2BD] & 0xFFFF);
    }

    // Map the enabled output registers (in order) to semantics.
    mapOutputs(O, mask) {
      // SEM.COUNT slots: position w = 1, the rest 0. Values come from float32 registers, so they stay float32.
      const out = [0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
      const map = this.outputMap(mask);
      for (let k = 0; k < map.length; k += 2) out[map[k]] = O[map[k + 1]];
      for (let c = 0; c < 4; c++) { const v = Math.abs(out[SEM.COLOR + c]); out[SEM.COLOR + c] = v > 1 ? 1 : v; }
      return out;
    }

    // (semantic, output register component) pairs in assignment order, rebuilt when the mapping registers change
    outputMap(mask) {
      const r = this.regs, total = r[0x04F] & 7;
      const key = this.outMapKey;
      let same = key[0] === mask && key[1] === total;
      for (let n = 0; same && n < 7; n++) same = key[2 + n] === r[0x050 + n];
      if (same) return this.outMap;
      key[0] = mask; key[1] = total;
      for (let n = 0; n < 7; n++) key[2 + n] = r[0x050 + n];
      const pairs = [];
      let n = 0;
      for (let reg = 0; reg < 16 && n < 7; reg++) {
        if (!(mask & (1 << reg))) continue;
        if (n < total) {
          const m = r[0x050 + n];
          for (let c = 0; c < 4; c++) {
            const sem = (m >>> (c * 8)) & 0x1F;
            if (sem < SEM.COUNT) pairs.push(sem, reg * 4 + c);
          }
        }
        n++;
      }
      return (this.outMap = Int32Array.from(pairs));
    }

    draw(indexed) {
      const r = this.regs;
      this.stats.draws++;
      const count = r[0x228];
      if (!count) return;
      this.syncShaderUniforms();
      const gsOn = this.gsActive();
      // Vertex shading on the host GPU when the renderer can run this program
      if (this.gl && this.gl.hwVertices && !gsOn && this.gl.drawHardware(this, indexed)) return;

      const base = (r[0x200] & 0x1FFFFFFF) << 3;
      const fmtLo = r[0x201], fmtHi = r[0x202];
      const numAttrs = (fmtHi >>> 28) + 1, fixedMask = (fmtHi >>> 16) & 0xFFF;
      const fmtOf = (i) => (i < 8 ? fmtLo >>> (i * 4) : fmtHi >>> ((i - 8) * 4)) & 0xF;
      const typeSize = [1, 1, 2, 4];

      // Indices
      let indices = null;
      if (indexed) {
        const idxReg = r[0x227], u16 = idxReg >>> 31;
        const sp = this.span(base + (idxReg & 0x0FFFFFFF), count * (u16 ? 2 : 1));
        if (!sp) { this.warn('idx', 'GPU: index buffer not readable'); return; }
        indices = new Uint32Array(count);
        for (let k = 0; k < count; k++) {
          const o = sp.off + k * (u16 ? 2 : 1);
          indices[k] = u16 ? sp.u8[o] | (sp.u8[o + 1] << 8) : sp.u8[o];
        }
      }
      let maxIndex = 0;
      if (indexed) { for (let k = 0; k < count; k++) if (indices[k] > maxIndex) maxIndex = indices[k]; }
      else maxIndex = r[0x22A] + count - 1;

      // Attribute sources from the 12 loaders
      const attrs = [];
      for (let l = 0; l < 12; l++) {
        const offset = r[0x203 + l * 3] & 0x0FFFFFFF, lo = r[0x204 + l * 3], hi = r[0x205 + l * 3];
        const comps = hi >>> 28, stride = (hi >>> 16) & 0xFF;
        if (!comps) continue;
        const sp = this.span(base + offset, Math.max(stride * (maxIndex + 1), 16));
        if (!sp) { this.warn(`ld${l}`, `GPU: vertex array ${l} at ${hex(base + offset)} is not readable`); continue; }
        const dv = new DataView(sp.u8.buffer, sp.u8.byteOffset);
        let off = 0;
        for (let c = 0; c < comps && c < 12; c++) {
          const a = c < 8 ? (lo >>> (c * 4)) & 0xF : (hi >>> ((c - 8) * 4)) & 0xF;
          if (a < 12) {
            const f = fmtOf(a), type = f & 3, n = (f >>> 2) + 1, es = typeSize[type];
            off = (off + es - 1) & ~(es - 1);
            attrs[a] = { u8: sp.u8, dv, start: sp.off + off, stride, type, n };
            off += es * n;
          } else {
            off = (off + 3) & ~3;
            off += (a - 11) * 4;
          }
        }
      }

      const vs = this.vs, R = vs.R;
      const regOf = new Int32Array(12);
      for (let a = 0; a < 12; a++) regOf[a] = this.inputRegister(a) * 4;
      const nIn = Math.min(numAttrs, (r[0x2B9] & 0xF) + 1, 12);

      const loadVertex = (index) => {
        for (let a = 0; a < nIn; a++) {
          const src = attrs[a], o = regOf[a];
          if (src) {
            const p = src.start + index * src.stride;
            for (let c = 0; c < 4; c++) {
              let val;
              if (c >= src.n) val = c === 3 ? 1 : 0;
              else switch (src.type) {
                case 0: val = (src.u8[p + c] << 24) >> 24; break;
                case 1: val = src.u8[p + c]; break;
                case 2: val = src.dv.getInt16(p + c * 2, true); break;
                default: val = src.dv.getFloat32(p + c * 4, true);
              }
              R[o + c] = val;
            }
          } else if (fixedMask & (1 << a)) {
            R[o] = this.defaults[a * 4]; R[o + 1] = this.defaults[a * 4 + 1]; R[o + 2] = this.defaults[a * 4 + 2]; R[o + 3] = this.defaults[a * 4 + 3];
          }
        }
      };

      this.startPrimitive();
      const cache = indexed ? new Map() : null;
      const first = r[0x22A];
      try {
        for (let k = 0; k < count; k++) {
          const index = indexed ? indices[k] : first + k;
          let out = cache ? cache.get(index) : undefined;
          if (!out) {
            loadVertex(index);
            out = gsOn ? this.runVertexShaderRaw() : this.runVertexShader();
            if (cache) cache.set(index, out);
          }
          if (gsOn) this.gsSubmit(out);
          else this.submitVertex(out);
        }
      } catch (e) {
        if (!(e instanceof RangeError)) throw e;
        this.warn('vtxrange', 'GPU: vertex fetch out of range');
      }
      this.flushTargets();
    }

    startPrimitive() {
      this.prim.topology = (this.regs[0x25E] >>> 8) & 3;
      this.prim.buf = [];
      this.prim.count = 0;
      this.prim.winding = false;
      this.gsFill = 0;
      this.gsSlots[0] = this.gsSlots[1] = this.gsSlots[2] = null;
    }

    submitVertex(v) {
      const p = this.prim;
      const b = p.buf;
      if (p.topology === 1) { // strip
        if (b.length === 2) {
          if (p.count & 1) this.triangle(b[1], b[0], v); else this.triangle(b[0], b[1], v);
          p.count++;
          b[0] = b[1]; b[1] = v;
        } else b.push(v);
      } else if (p.topology === 2) { // fan
        if (b.length === 2) { this.triangle(b[0], b[1], v); b[1] = v; } else b.push(v);
      } else { // list (and geometry shader output; SETEMIT's winding flag swaps the first two vertices)
        b.push(v);
        if (b.length === 3) {
          if (p.winding) { p.winding = false; this.triangle(b[1], b[0], b[2]); } else this.triangle(b[0], b[1], b[2]);
          p.buf = [];
        }
      }
    }

    // ---------------------------------------------------------------- clipping
    triangle(a, b, c) {
      this.stats.triangles++;
      const st = this.state || (this.state = this.buildState());
      if (!st) return;
      // Most triangles need no clipping
      if (insideClip(a) && insideClip(b) && insideClip(c)) {
        const s0 = this.toScreen(a, st), s1 = this.toScreen(b, st), s2 = this.toScreen(c, st);
        if (this.gl) this.gl.triangle(st, s0, s1, s2);
        else if (st.raster) this.stats.fragments += st.raster(st, this, s0, s1, s2);
        else this.rasterize(s0, s1, s2, st);
        return;
      }
      let poly = [a, b, c];
      for (const plane of CLIP_PLANES) {
        let allIn = true;
        for (const v of poly) if (plane(v) < 0) { allIn = false; break; }
        if (allIn) continue;
        const out = [];
        for (let k = 0; k < poly.length; k++) {
          const p = poly[k], q = poly[(k + 1) % poly.length];
          const dp = plane(p), dq = plane(q);
          if (dp >= 0) out.push(p);
          if ((dp >= 0) !== (dq >= 0)) {
            const t = dp / (dp - dq), v = new Array(SEM.COUNT);
            for (let s = 0; s < SEM.COUNT; s++) v[s] = Math.fround(p[s] + (q[s] - p[s]) * t); // float32, like the vertex values
            out.push(v);
          }
        }
        poly = out;
        if (poly.length < 3) return;
      }
      const sv = poly.map((v) => this.toScreen(v, st));
      for (let k = 1; k + 1 < sv.length; k++) {
        if (this.gl) this.gl.triangle(st, sv[0], sv[k], sv[k + 1]);
        else if (st.raster) this.stats.fragments += st.raster(st, this, sv[0], sv[k], sv[k + 1]);
        else this.rasterize(sv[0], sv[k], sv[k + 1], st);
      }
    }

    toScreen(v, st) {
      const iw = 1 / v[3];
      return {
        x: (v[0] * iw + 1) * st.halfW + st.offX,
        y: (v[1] * iw + 1) * st.halfH + st.offY,
        z: v[2] * iw,
        iw,
        a: v,
      };
    }

    // ---------------------------------------------------------------- per-draw fixed-function state
    buildState() {
      const r = this.regs;
      const colorAddr = (r[0x11D] & 0x1FFFFFFF) << 3, depthAddr = (r[0x11C] & 0x1FFFFFFF) << 3;
      const dims = r[0x11E], fbW = dims & 0x7FF, fbHreg = (dims >>> 12) & 0x3FF, fbH = fbHreg + 1;
      if (!fbW || !fbH) return null;
      const colorFmt = (r[0x117] >>> 16) & 7, colorBpp = [4, 3, 2, 2, 2][colorFmt] || 4;
      const depthFmt = r[0x116] & 3, depthBpp = [2, 2, 3, 4][depthFmt];
      const om = r[0x100], blendFn = r[0x101], depthCfg = r[0x107];
      const colorWrite = (r[0x113] & 0xF) !== 0 && colorAddr !== 0;
      const colorRead = (r[0x112] & 0xF) !== 0;
      const dsWrite = (r[0x115] & 3) !== 0 && depthAddr !== 0;
      const dsRead = (r[0x114] & 3) !== 0 && depthAddr !== 0;

      const st = {
        fbW, fbH, fbHreg, colorFmt, colorBpp, depthFmt, depthBpp,
        halfW: f24(r[0x041]), halfH: f24(r[0x043]),
        offX: ((r[0x068] & 0x3FF) << 22) >> 22, offY: (((r[0x068] >>> 16) & 0x3FF) << 22) >> 22,
        depthScale: f24(r[0x04D]), depthOffset: f24(r[0x04E]),
        cull: r[0x040] & 3,
        scissor: r[0x065] & 3, sx0: r[0x066] & 0x3FF, sy0: (r[0x066] >>> 16) & 0x3FF, sx1: r[0x067] & 0x3FF, sy1: (r[0x067] >>> 16) & 0x3FF,
        color: null, depth: null,
        blend: (om >>> 8) & 1, logic: r[0x102] & 0xF,
        eqRGB: blendFn & 7, eqA: (blendFn >>> 8) & 7,
        srcRGB: (blendFn >>> 16) & 0xF, dstRGB: (blendFn >>> 20) & 0xF, srcA: (blendFn >>> 24) & 0xF, dstA: blendFn >>> 28,
        blendConst: [r[0x103] & 0xFF, (r[0x103] >>> 8) & 0xFF, (r[0x103] >>> 16) & 0xFF, r[0x103] >>> 24],
        alphaTest: r[0x104] & 1, alphaFunc: (r[0x104] >>> 4) & 7, alphaRef: (r[0x104] >>> 8) & 0xFF,
        stencil: (r[0x105] & 1) && depthFmt === 3, stencilFunc: (r[0x105] >>> 4) & 7, stencilWriteMask: (r[0x105] >>> 8) & 0xFF,
        stencilRef: (r[0x105] >>> 16) & 0xFF, stencilMask: r[0x105] >>> 24,
        sFail: r[0x106] & 7, sZFail: (r[0x106] >>> 4) & 7, sZPass: (r[0x106] >>> 8) & 7,
        depthTest: depthCfg & 1, depthFunc: (depthCfg >>> 4) & 7, colorMask: (depthCfg >>> 8) & 0xF, depthWrite: (depthCfg >>> 12) & 1,
        textures: [null, null, null],
        tev: [],
        bufferInit: [r[0x0FD] & 0xFF, (r[0x0FD] >>> 8) & 0xFF, (r[0x0FD] >>> 16) & 0xFF, r[0x0FD] >>> 24],
        updRGB: (r[0x0E0] >>> 8) & 0xF, updA: (r[0x0E0] >>> 12) & 0xF,
        fog: (r[0x0E0] & 7) === 5, fogFlip: (r[0x0E0] >>> 16) & 1, fogColor: [r[0x0E1] & 0xFF, (r[0x0E1] >>> 8) & 0xFF, (r[0x0E1] >>> 16) & 0xFF],
        tex2uv1: (r[0x080] >>> 13) & 1,
        lighting: null,
        drawn: false,
      };
      if (st.depthScale === 0 && st.depthOffset === 0) st.depthScale = -1;
      if ((r[0x0E0] & 7) === 7) this.warn('gas', 'GPU: gas rendering is not emulated');

      if (colorWrite || colorRead) st.color = this.target(colorAddr, fbW * fbH * colorBpp);
      if (dsWrite || dsRead) st.depth = this.target(depthAddr, fbW * fbH * depthBpp);
      if (!colorWrite) st.colorMask = 0;
      if (!dsWrite) { st.depthWrite = 0; st.stencilWriteMask = 0; }
      if (!dsRead && !dsWrite) { st.depthTest = 0; st.stencil = 0; }
      if (!st.depth) { st.depthTest = 0; st.depthWrite = 0; st.stencil = 0; }
      if (!st.color) st.colorMask = 0;

      // Texture units
      const tcfg = r[0x080];
      const units = [[0x081, 0x085, 0x08E], [0x091, 0x095, 0x096], [0x099, 0x09D, 0x09E]];
      for (let t = 0; t < 3; t++) {
        if (!(tcfg & (1 << t))) continue;
        const [b] = units[t];
        const border = r[b], dim = r[b + 1], param = r[b + 2], addr = (r[units[t][1]] & 0x1FFFFFFF) << 3, fmt = r[units[t][2]] & 0xF;
        const w = (dim >>> 16) & 0x7FF, h = dim & 0x7FF;
        const tex = this.texture(addr, w, h, fmt);
        if (!tex) continue;
        const type = t === 0 ? (param >>> 28) & 7 : 0;
        if (t === 0 && type !== 0 && type !== 3) this.warn(`textype${type}`, `GPU: texture type ${type} (cube/shadow) is sampled as 2D`);
        st.textures[t] = {
          entry: tex, data: tex.data, data32: tex.data32, w, h, wrapS: (param >>> 12) & 7, wrapT: (param >>> 8) & 7,
          borderPacked: border >>> 0, // the border register holds R, G, B, A in bytes 0-3, the same order as data32
          linear: (param >>> 1) & 1, project: type === 3, pow2: (w & (w - 1)) === 0 && (h & (h - 1)) === 0,
          border: [border & 0xFF, (border >>> 8) & 0xFF, (border >>> 16) & 0xFF, border >>> 24],
        };
      }
      if (tcfg & 0x400) this.warn('proctex', 'GPU: procedural textures are not emulated');

      // Texture combiner stages
      const stageRegs = [0x0C0, 0x0C8, 0x0D0, 0x0D8, 0x0F0, 0x0F8];
      for (const s of stageRegs) {
        const src = r[s], opd = r[s + 1], cmb = r[s + 2], cst = r[s + 3], scale = r[s + 4];
        st.tev.push({
          rgbSrc: [src & 0xF, (src >>> 4) & 0xF, (src >>> 8) & 0xF],
          aSrc: [(src >>> 16) & 0xF, (src >>> 20) & 0xF, (src >>> 24) & 0xF],
          rgbOp: [opd & 0xF, (opd >>> 4) & 0xF, (opd >>> 8) & 0xF],
          aOp: [(opd >>> 12) & 7, (opd >>> 16) & 7, (opd >>> 20) & 7],
          rgbCmb: cmb & 0xF, aCmb: (cmb >>> 16) & 0xF,
          konst: Int32Array.of(cst & 0xFF, (cst >>> 8) & 0xFF, (cst >>> 16) & 0xFF, cst >>> 24),
          rgbScale: 1 << (scale & 3), aScale: 1 << ((scale >>> 16) & 3),
          passthrough: (src & 0xF000F) === 0xF000F && (cmb & 0xF000F) === 0 && (opd & 0x700F) === 0 && (scale & 0x30003) === 0, // Replace(Previous)
        });
      }
      const F = this.F;

      // Fragment lighting
      if (r[0x08F] & 1) st.lighting = this.buildLighting();
      else { F.lp.fill(0); F.ls.fill(0); }

      // Attributes the rasterizer has to interpolate
      const need = [SEM.COLOR, SEM.COLOR + 1, SEM.COLOR + 2, SEM.COLOR + 3];
      if (st.textures[0]) need.push(SEM.UV0, SEM.UV0 + 1, SEM.UV0W);
      if (st.textures[1] || (st.textures[2] && st.tex2uv1)) need.push(SEM.UV1, SEM.UV1 + 1);
      if (st.textures[2] && !st.tex2uv1) need.push(SEM.UV2, SEM.UV2 + 1);
      if (st.lighting) need.push(SEM.QUAT, SEM.QUAT + 1, SEM.QUAT + 2, SEM.QUAT + 3, SEM.VIEW, SEM.VIEW + 1, SEM.VIEW + 2);
      st.need = need;
      if (this.gl) { /* drawn by the host GPU */ } else if (this.rasterJit) compileRaster(st);
      else compileFragment(st, this);
      return st;
    }

    target(phys, size) {
      const sp = this.span(phys, size);
      if (!sp) { this.warn(`fb${hex(phys)}`, `GPU: render target ${hex(phys)} is not mapped`); return null; }
      return { ...sp, phys };
    }

    // Write back copied render targets and drop textures that alias them.
    flushTargets() {
      if (this.gl) { this.gl.flush(); this.gl.listDone(); return; }
      const st = this.state;
      if (!st || !st.drawn) return;
      st.drawn = false;
      for (const t of [st.color, st.depth]) {
        if (!t) continue;
        if (t.copy) this.mem.writeBytes(t.virt, t.u8.subarray(0, t.size));
        this.invalidatePhys(t.phys, t.size);
      }
    }

    texture(addr, w, h, fmt) {
      if (!w || !h || !addr) return null;
      const key = `${addr}:${w}:${h}:${fmt}`;
      const bytes = (w * h * (TEX_BITS[fmt] || 32)) >> 3;
      if (this.gl) this.gl.syncToMemory(addr, bytes); // rendered by the host GPU: bring it into memory first
      let t = this.texCache.get(key);
      if (t && !t.stale) return t;
      const sp = this.span(addr, bytes);
      if (!sp) { this.warn(`tex${hex(addr)}`, `GPU: texture at ${hex(addr)} is not mapped`); return null; }
      // Unchanged, or only some tiles changed (games animate parts of big texture atlases): keep the entry
      if (t && updateTiles(t, sp.u8, sp.off, w, h, fmt, !!this.gl)) { t.stale = false; return t; }
      if (t) { this.texCache.delete(key); this.texBytes -= t.cost; }
      const data = decodeTexture(sp.u8, sp.off, w, h, fmt);
      t = { addr, bytes, data, data32: new Uint32Array(data.buffer), raw: sp.u8.slice(sp.off, sp.off + bytes), stale: false, cost: w * h * 4 + bytes };
      // Bounded by count and by memory (decoded RGBA8 + the source copy)
      if (this.texCache.size >= 512 || this.texBytes > 96 * 1024 * 1024) { this.texCache.clear(); this.texBytes = 0; }
      this.texCache.set(key, t);
      this.texBytes += t.cost;
      return t;
    }

    // ---------------------------------------------------------------- fragment lighting
    buildLighting() {
      const r = this.regs;
      const num = (r[0x1C2] & 7) + 1;
      const cfg0 = r[0x1C3], cfg1 = r[0x1C4];
      const absIn = r[0x1D0], lutIn = r[0x1D1], lutScale = r[0x1D2], perm = r[0x1D9];
      const rgb = (v) => [((v >>> 20) & 0xFF) / 255, ((v >>> 10) & 0xFF) / 255, (v & 0xFF) / 255];
      const config = (cfg0 >>> 4) & 0xF;
      // Which LUTs each lighting configuration provides (D0, D1, SP, FR, RB, RG, RR)
      const supported = [
        config !== 1,
        config !== 0 && config !== 1 && config !== 5,
        config !== 2 && config !== 3,
        config !== 0 && config !== 2 && config !== 4,
        config === 4 || config === 5 || config === 8,
        config === 4 || config === 5 || config === 8,
        config !== 3,
      ];
      const disableBit = [16, 17, -1, 19, 22, 21, 20];
      const lights = [];
      for (let k = 0; k < num; k++) {
        const id = (perm >>> (k * 4)) & 7, b = 0x140 + id * 0x10;
        const conf = r[b + 9];
        const s13 = (v) => (v << 19) >> 19;
        lights.push({
          id,
          spec0: rgb(r[b]), spec1: rgb(r[b + 1]), diffuse: rgb(r[b + 2]), ambient: rgb(r[b + 3]),
          pos: [f16(r[b + 4] & 0xFFFF), f16(r[b + 4] >>> 16), f16(r[b + 5] & 0xFFFF)],
          spot: [s13(r[b + 6] & 0x1FFF) / 2047, s13((r[b + 6] >>> 16) & 0x1FFF) / 2047, s13(r[b + 7] & 0x1FFF) / 2047],
          directional: conf & 1, twoSided: (conf >>> 1) & 1, geo0: (conf >>> 2) & 1, geo1: (conf >>> 3) & 1,
          attBias: f20(r[b + 10]), attScale: f20(r[b + 11]),
          spotOn: supported[2] && !((cfg1 >>> (8 + id)) & 1),
          distOn: !((cfg1 >>> (24 + id)) & 1),
        });
      }
      return {
        lights, ambient: rgb(r[0x1C0]), config,
        primaryAlpha: (cfg0 >>> 2) & 1, secondaryAlpha: (cfg0 >>> 3) & 1,
        bumpSel: (cfg0 >>> 22) & 3, clampHighlights: (cfg0 >>> 27) & 1, bumpMode: (cfg0 >>> 28) & 3, renorm: !((cfg0 >>> 30) & 1),
        // per LUT slot (D0, D1, SP, FR, RB, RG, RR): enabled, input, abs, scale, LUT id
        on: supported.map((s, i) => s && (disableBit[i] < 0 || !((cfg1 >>> disableBit[i]) & 1))),
        input: [0, 1, 2, 3, 4, 5, 6].map((i) => (lutIn >>> (i * 4)) & 7),
        abs: [0, 1, 2, 3, 4, 5, 6].map((i) => !((absIn >>> (i * 4 + 1)) & 1)),
        scale: [0, 1, 2, 3, 4, 5, 6].map((i) => [1, 2, 4, 8, 0, 0, 0.25, 0.5][(lutScale >>> (i * 4)) & 7]),
        lutId: [0, 1, -1, 3, 4, 5, 6],
      };
    }

    // ---------------------------------------------------------------- rasterizer
    rasterize(v0, v1, v2, st) {
      const x0 = Math.round(v0.x * 16), y0 = Math.round(v0.y * 16);
      let x1 = Math.round(v1.x * 16), y1 = Math.round(v1.y * 16);
      let x2 = Math.round(v2.x * 16), y2 = Math.round(v2.y * 16);
      let area = (x1 - x0) * (y2 - y0) - (y1 - y0) * (x2 - x0);
      if (area === 0) return;
      if (st.cull === 1 && area > 0) return;
      if (st.cull === 2 && area < 0) return;
      if (area < 0) { // make counter-clockwise
        const t = v1; v1 = v2; v2 = t;
        let tt = x1; x1 = x2; x2 = tt; tt = y1; y1 = y2; y2 = tt;
        area = -area;
      }
      // Bounding box in pixels
      let minX = Math.max(0, Math.floor(Math.min(x0, x1, x2) / 16)), maxX = Math.min(st.fbW - 1, Math.ceil(Math.max(x0, x1, x2) / 16));
      let minY = Math.max(0, Math.floor(Math.min(y0, y1, y2) / 16)), maxY = Math.min(st.fbH - 1, Math.ceil(Math.max(y0, y1, y2) / 16));
      if (st.scissor === 3) {
        minX = Math.max(minX, st.sx0); maxX = Math.min(maxX, st.sx1);
        minY = Math.max(minY, st.sy0); maxY = Math.min(maxY, st.sy1);
      }
      if (minX > maxX || minY > maxY) return;

      // Top-left fill rule (as on hardware: exclude right-side and flat-bottom edges)
      const rightOrBottom = (vx, vy, ax, ay, bx, by) => (ay === by ? vy < ay : vx < ax + (bx - ax) * (vy - ay) / (by - ay));
      const bias0 = rightOrBottom(x0, y0, x1, y1, x2, y2) ? -1 : 0;
      const bias1 = rightOrBottom(x1, y1, x2, y2, x0, y0) ? -1 : 0;
      const bias2 = rightOrBottom(x2, y2, x0, y0, x1, y1) ? -1 : 0;

      // Edge functions: w0 (weight of v0) is the edge v1->v2, etc.
      const e0a = (y1 - y2) * 16, e0b = (x2 - x1) * 16, e1a = (y2 - y0) * 16, e1b = (x0 - x2) * 16, e2a = (y0 - y1) * 16, e2b = (x1 - x0) * 16;
      const px0 = minX * 16 + 8, py0 = minY * 16 + 8;
      let w0row = (x2 - x1) * (py0 - y1) - (y2 - y1) * (px0 - x1) + bias0;
      let w1row = (x0 - x2) * (py0 - y2) - (y0 - y2) * (px0 - x2) + bias1;
      let w2row = (x1 - x0) * (py0 - y0) - (y1 - y0) * (px0 - x0) + bias2;

      // Per-vertex perspective-weighted attributes
      const a0 = v0.a, iw0 = v0.iw, iw1 = v1.iw, iw2 = v2.iw;
      let a1 = v1.a, a2 = v2.a;
      const lit = st.lighting;
      if (lit) { // interpolate quaternions along the short arc
        const flip = (a) => { const d = a0[4] * a[4] + a0[5] * a[5] + a0[6] * a[6] + a0[7] * a[7]; if (d >= 0) return a; const c = Array.from(a); for (let k = 4; k < 8; k++) c[k] = -c[k]; return c; };
        a1 = flip(a1); a2 = flip(a2);
      }
      const need = st.need, nN = need.length;
      const P0 = this.P0, P1 = this.P1, P2 = this.P2, I = this.I;
      for (let k = 0; k < nN; k++) { const s = need[k]; P0[s] = a0[s] * iw0; P1[s] = a1[s] * iw1; P2[s] = a2[s] * iw2; }
      const inv = 1 / area;

      const fx = st.fbW, hreg = st.fbHreg;
      const color = st.color, depth = st.depth;
      const cu8 = color && color.u8, coff = color ? color.off : 0, cbpp = st.colorBpp;
      const du8 = depth && depth.u8, doff = depth ? depth.off : 0, dbpp = st.depthBpp;
      const dmax = st.depthFmt === 0 ? 0xFFFF : 0xFFFFFF;
      const earlyZ = st.depthTest && !st.stencil;
      const z0 = v0.z, z1 = v1.z, z2 = v2.z, dScale = st.depthScale, dOff = st.depthOffset;
      const exclude = st.scissor === 1;
      const shade = st.shade, write = st.write;

      for (let y = minY; y <= maxY; y++, w0row += e0b, w1row += e1b, w2row += e2b) {
        let w0 = w0row, w1 = w1row, w2 = w2row;
        const fy = hreg - y;
        if (fy < 0) continue;
        const rowBase = (fy & ~7) * fx, mrow = (fy & 7) * 8;
        for (let x = minX; x <= maxX; x++, w0 += e0a, w1 += e1a, w2 += e2a) {
          if (w0 < 0 || w1 < 0 || w2 < 0) continue;
          if (exclude && x >= st.sx0 && x <= st.sx1 && y >= st.sy0 && y <= st.sy1) continue;
          const pix = rowBase + (x & ~7) * 8 + MORTON[mrow + (x & 7)];
          const b0 = w0 * inv, b1 = w1 * inv, b2 = w2 * inv;

          // Depth
          let z = (b0 * z0 + b1 * z1 + b2 * z2) * dScale + dOff;
          z = z < 0 ? 0 : z > 1 ? 1 : z;
          const zi = Math.round(z * dmax);
          let dAddr = 0, stored = 0;
          if (depth) {
            dAddr = doff + pix * dbpp;
            stored = dbpp === 2 ? du8[dAddr] | (du8[dAddr + 1] << 8) : du8[dAddr] | (du8[dAddr + 1] << 8) | (du8[dAddr + 2] << 16);
            if (earlyZ && !compare(st.depthFunc, zi, stored)) continue;
          }

          // Perspective-correct interpolation
          const pw = 1 / (b0 * iw0 + b1 * iw1 + b2 * iw2);
          for (let k = 0; k < nN; k++) { const s = need[k]; I[s] = (b0 * P0[s] + b1 * P1[s] + b2 * P2[s]) * pw; }

          const col = shade(I, z);
          if (col < 0) continue;

          // Stencil + depth
          if (st.stencil) {
            const sv = du8[dAddr + 3];
            const pass = compare(st.stencilFunc, st.stencilRef & st.stencilMask, sv & st.stencilMask);
            if (!pass) { this.writeStencil(du8, dAddr, sv, st.sFail, st); continue; }
            if (st.depthTest && !compare(st.depthFunc, zi, stored)) { this.writeStencil(du8, dAddr, sv, st.sZFail, st); continue; }
            this.writeStencil(du8, dAddr, sv, st.sZPass, st);
          } else if (st.depthTest && !earlyZ && !compare(st.depthFunc, zi, stored)) continue;
          if (st.depthWrite) {
            du8[dAddr] = zi; du8[dAddr + 1] = zi >>> 8;
            if (dbpp >= 3) du8[dAddr + 2] = zi >>> 16;
          }
          st.drawn = true;
          this.stats.fragments++;

          // Blending / logic op and color write
          if (st.colorMask) write(col, cu8, coff + pix * cbpp);
        }
      }
    }

    writeStencil(u8, addr, old, op, st) {
      if (!st.stencilWriteMask) return;
      const nv = stencilOp(op, old, st.stencilRef);
      u8[addr + 3] = (old & ~st.stencilWriteMask) | (nv & st.stencilWriteMask);
      st.drawn = true;
    }

    lutValue(id, index, delta) {
      const e = this.lut[id][index & 0xFF];
      return (e & 0xFFF) / 4095 + (((e >>> 12) & 0xFFF) << 20 >> 20) / 4095 * delta;
    }

    // Fragment lighting -> F.lp (primary) and F.ls (secondary) colors.
    light(L, I) {
      const F = this.F;
      // Surface normal/tangent, optionally perturbed by a bump/tangent map.
      let sn = [0, 0, 1], stan = [1, 0, 0];
      if (L.bumpMode) {
        const t = F.tex[L.bumpSel] || F.tex[0];
        const p = [t[0] / 127.5 - 1, t[1] / 127.5 - 1, t[2] / 127.5 - 1];
        if (L.bumpMode === 1) {
          if (L.renorm) p[2] = Math.sqrt(Math.max(1 - p[0] * p[0] - p[1] * p[1], 0));
          sn = p;
        } else if (L.bumpMode === 2) stan = p;
      }
      let qx = I[SEM.QUAT], qy = I[SEM.QUAT + 1], qz = I[SEM.QUAT + 2], qw = I[SEM.QUAT + 3];
      const ql = Math.hypot(qx, qy, qz, qw) || 1;
      qx /= ql; qy /= ql; qz /= ql; qw /= ql;
      const rot = (v) => { // v + 2 * cross(q.xyz, cross(q.xyz, v) + w * v)
        const cx = qy * v[2] - qz * v[1] + qw * v[0], cy = qz * v[0] - qx * v[2] + qw * v[1], cz = qx * v[1] - qy * v[0] + qw * v[2];
        return [v[0] + 2 * (qy * cz - qz * cy), v[1] + 2 * (qz * cx - qx * cz), v[2] + 2 * (qx * cy - qy * cx)];
      };
      const n = rot(sn), tan = rot(stan);
      const view = [I[SEM.VIEW], I[SEM.VIEW + 1], I[SEM.VIEW + 2]];
      const vl = Math.hypot(view[0], view[1], view[2]) || 1;
      const nv = [view[0] / vl, view[1] / vl, view[2] / vl];
      const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

      let dr = 0, dg = 0, db = 0, da = 1, sr = 0, sg = 0, sb = 0, sa = 1;
      const nl = L.lights.length;
      for (let li = 0; li < nl; li++) {
        const l = L.lights[li];
        const lv = l.directional ? [l.pos[0], l.pos[1], l.pos[2]] : [l.pos[0] + view[0], l.pos[1] + view[1], l.pos[2] + view[2]];
        const ll = Math.hypot(lv[0], lv[1], lv[2]) || 1;
        lv[0] /= ll; lv[1] /= ll; lv[2] /= ll;
        const half = [nv[0] + lv[0], nv[1] + lv[1], nv[2] + lv[2]];
        const hl2 = dot(half, half), hl = Math.sqrt(hl2) || 1;
        const nh = [half[0] / hl, half[1] / hl, half[2] / hl];

        const lookup = (slot) => {
          let v;
          switch (L.input[slot]) {
            case 0: v = dot(n, nh); break;
            case 1: v = dot(nv, nh); break;
            case 2: v = dot(n, nv); break;
            case 3: v = dot(lv, n); break;
            case 4: v = dot(lv, l.spot); break;
            case 5: if (L.config === 8) { const d = dot(n, nh); v = dot([nh[0] - n[0] * d, nh[1] - n[1] * d, nh[2] - n[2] * d], tan); } else v = 0; break;
            default: v = 0;
          }
          const id = slot === 2 ? 8 + l.id : L.lutId[slot];
          let index, delta;
          if (L.abs[slot]) {
            v = l.twoSided ? Math.abs(v) : Math.max(v, 0);
            index = Math.min(255, Math.max(0, Math.floor(v * 256)));
            delta = v * 256 - index;
          } else {
            const si = Math.min(127, Math.max(-128, Math.floor(v * 128)));
            delta = v * 128 - si;
            index = si & 0xFF;
          }
          return L.scale[slot] * this.lutValue(id, index, delta);
        };

        let dist = 1;
        if (l.distOn) {
          const d = Math.hypot(-view[0] - l.pos[0], -view[1] - l.pos[1], -view[2] - l.pos[2]);
          const loc = Math.min(1, Math.max(0, l.attScale * d + l.attBias));
          const idx = Math.min(255, Math.max(0, Math.floor(loc * 256)));
          dist = this.lutValue(16 + l.id, idx, loc * 256 - idx);
        }
        const spot = l.spotOn ? lookup(2) : 1;
        const d0 = L.on[0] ? lookup(0) : 1;
        let s0r = d0 * l.spec0[0], s0g = d0 * l.spec0[1], s0b = d0 * l.spec0[2];
        const rr = L.on[6] ? lookup(6) : 1;
        const rg = L.on[5] ? lookup(5) : rr;
        const rb = L.on[4] ? lookup(4) : rr;
        const d1 = L.on[1] ? lookup(1) : 1;
        let s1r = d1 * rr * l.spec1[0], s1g = d1 * rg * l.spec1[1], s1b = d1 * rb * l.spec1[2];
        if (li === nl - 1 && L.on[3]) {
          const fr = lookup(3);
          if (L.primaryAlpha) da = fr;
          if (L.secondaryAlpha) sa = fr;
        }
        let NL = dot(lv, n);
        NL = l.twoSided ? Math.abs(NL) : Math.max(NL, 0);
        const clampH = L.clampHighlights ? (NL === 0 ? 0 : 1) : 1;
        if (l.geo0 || l.geo1) {
          const geo = hl2 === 0 ? 0 : Math.min(NL / hl2, 1);
          if (l.geo0) { s0r *= geo; s0g *= geo; s0b *= geo; }
          if (l.geo1) { s1r *= geo; s1g *= geo; s1b *= geo; }
        }
        const k = dist * spot, ks = clampH * k;
        dr += (l.diffuse[0] * NL + l.ambient[0]) * k; dg += (l.diffuse[1] * NL + l.ambient[1]) * k; db += (l.diffuse[2] * NL + l.ambient[2]) * k;
        sr += (s0r + s1r) * ks; sg += (s0g + s1g) * ks; sb += (s0b + s1b) * ks;
      }
      dr += L.ambient[0]; dg += L.ambient[1]; db += L.ambient[2];
      const c = (v) => (v <= 0 ? 0 : v >= 1 ? 255 : (v * 255) | 0);
      F.lp[0] = c(dr); F.lp[1] = c(dg); F.lp[2] = c(db); F.lp[3] = c(da);
      F.ls[0] = c(sr); F.ls[1] = c(sg); F.ls[2] = c(sb); F.ls[3] = c(sa);
    }
  }

  // 20-bit float (1.7.12) used for distance attenuation
  function f20(raw) {
    raw &= 0xFFFFF;
    const sign = raw & 0x80000 ? -1 : 1, e = (raw >>> 12) & 0x7F, m = raw & 0xFFF;
    if (!e && !m) return 0;
    return sign * (1 + m / 4096) * Math.pow(2, e - 63);
  }

  function sampleTexture(T, u, v, out) {
    const w = T.w, h = T.h, d = T.data;
    if (!(u === u) || !(v === v)) { out[0] = out[1] = out[2] = out[3] = 0; return; }
    if (T.linear) {
      const fu = u * w - 0.5, fv = v * h - 0.5;
      const s0 = Math.floor(fu), t0 = Math.floor(fv), ax = fu - s0, ay = fv - t0;
      let r = 0, g = 0, b = 0, a = 0;
      for (let k = 0; k < 4; k++) {
        const s = wrapCoord(T.wrapS, s0 + (k & 1), w), t = wrapCoord(T.wrapT, t0 + (k >> 1), h);
        const wt = (k & 1 ? ax : 1 - ax) * (k >> 1 ? ay : 1 - ay);
        if (s < 0 || t < 0) { const c = T.border; r += c[0] * wt; g += c[1] * wt; b += c[2] * wt; a += c[3] * wt; continue; }
        const o = (t * w + s) * 4;
        r += d[o] * wt; g += d[o + 1] * wt; b += d[o + 2] * wt; a += d[o + 3] * wt;
      }
      out[0] = (r + 0.5) | 0; out[1] = (g + 0.5) | 0; out[2] = (b + 0.5) | 0; out[3] = (a + 0.5) | 0;
      return;
    }
    const s = wrapCoord(T.wrapS, Math.floor(u * w), w), t = wrapCoord(T.wrapT, Math.floor(v * h), h);
    if (s < 0 || t < 0) { const c = T.border; out[0] = c[0]; out[1] = c[1]; out[2] = c[2]; out[3] = c[3]; return; }
    const o = (t * w + s) * 4;
    out[0] = d[o]; out[1] = d[o + 1]; out[2] = d[o + 2]; out[3] = d[o + 3];
  }

  EMU.Gpu = Gpu;
  EMU.ShaderUnit = ShaderUnit;
  EMU.flattenShaderBody = flattenShaderBody; // for the WebGL renderer
  EMU.SHADER_OP = OP;
  EMU.f24 = f24;
  EMU.decodeTexture = decodeTexture;
  // Classes a save state can hold (see state.js)
  Object.assign(EMU.classes || (EMU.classes = {}), { ShaderUnit, Gpu });
  EMU.gpuDebug = { genRaster, rasterKey, genShade, genWrite }; // for inspecting generated code
})(typeof window !== 'undefined' ? window.EMU : globalThis.EMU);

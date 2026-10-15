// ARM11 MPCore (ARMv6K) user-mode interpreter: ARM, Thumb and VFPv2.
(function (EMU) {
  'use strict';

  const hex = EMU.hex;
  const ror = (v, n) => ((n &= 31) === 0 ? v >>> 0 : ((v >>> n) | (v << (32 - n))) >>> 0);
  const popcount16 = (x) => { let n = 0; while (x) { n += x & 1; x >>>= 1; } return n; };
  const sx8 = (v) => (v << 24) >> 24;
  const sx16 = (v) => (v << 16) >> 16;
  const satS = (v, bits) => { const max = 2 ** (bits - 1) - 1, min = -(2 ** (bits - 1)); return v > max ? max : v < min ? min : v; };
  const satU = (v, bits) => { const max = 2 ** bits - 1; return v > max ? max : v < 0 ? 0 : v; };
  const TWO32 = 4294967296;

  // ================================================================ ARM block compiler
  // Straight-line runs of ARM instructions (within one 4 KB page) are translated into a JavaScript function.
  // Decoding and condition dispatch happen once; common data-processing, load/store, extend and multiply
  // forms get specialised code, and every other instruction calls the interpreter's own handler exactly as
  // CPU.run would. A block re-checks its instruction words against memory each time it runs (so rewritten
  // code is never executed stale) and only runs when the whole block fits in the instruction budget, so
  // instruction counts, and therefore thread scheduling, are identical to the interpreter.
  const BLOCK_MAX = 96;
  const BLOCK_TAB = 1 << 16;
  const COND_EXPR = [
    'c.z === 1', 'c.z === 0', 'c.c === 1', 'c.c === 0', 'c.n === 1', 'c.n === 0', 'c.v === 1', 'c.v === 0',
    'c.c === 1 && c.z === 0', 'c.c === 0 || c.z === 1', 'c.n === c.v', 'c.n !== c.v', 'c.z === 0 && c.n === c.v', 'c.z === 1 || c.n !== c.v',
  ];
  const rorConst = (v, n) => ((n &= 31) === 0 ? v >>> 0 : ((v >>> n) | (v << (32 - n))) >>> 0);

  function compileArmBlock(cpu, start) {
    const pages32 = cpu.mem.pages32, idx = start >>> 12, page = pages32[idx];
    if (page === null || (start & 3)) return null;
    let code = '';
    let checks = '';
    let n = 0, pc = start, ended = false;
    while (n < BLOCK_MAX && (pc >>> 12) === idx && !ended) {
      const insn = page[(pc & 0xFFF) >>> 2] | 0, PC = pc;
      checks += `${n ? ' || ' : ''}P[${(pc & 0xFFF) >>> 2}] !== ${insn >>> 0}`;
      const cond = insn >>> 28;
      const R = (k) => (k === 15 ? `${(PC + 8) >>> 0}` : `r[${k}]`);
      // The interpreter's own steps for one instruction; leave the block if it changed control flow
      const generic = () => `c.curPC = ${PC}; c.pc = ${(PC + 4) >>> 0}; r[15] = ${(PC + 8) >>> 0}; ` +
        `${cond === 15 ? `c.execArmUncond(${insn}, ${PC});` : `c.execArm(${insn}, ${PC});`}` +
        ` if (c.pc !== ${(PC + 4) >>> 0} || c.t || c.stop) return ${n + 1};`;
      let body = null;
      const op3 = (insn >>> 25) & 7;
      if (cond === 15) body = generic();
      else if (op3 === 5) { // B / BL ends the block
        const target = (PC + 8 + ((insn << 8) >> 6)) >>> 0;
        const taken = `${insn & 0x01000000 ? `r[14] = ${(PC + 4) >>> 0}; ` : ''}c.pc = ${target};`;
        code += `c.curPC = ${PC}; r[15] = ${(PC + 8) >>> 0};\n`;
        code += cond === 14 ? `${taken}\n` : `if (${COND_EXPR[cond]}) { ${taken} } else c.pc = ${(PC + 4) >>> 0};\n`;
        code += `return ${n + 1};\n`;
        n++; ended = true;
        break;
      } else body = specialise(insn, PC, R) || generic();
      code += cond >= 14 ? `${body}\n` : `if (${COND_EXPR[cond]}) { ${body} }\n`; // 15: unconditional space
      n++;
      pc = (pc + 4) >>> 0;
    }
    if (!ended) code += `c.pc = ${pc}; c.curPC = ${(pc - 4) >>> 0}; r[15] = ${(pc + 4) >>> 0}; return ${n};\n`;
    const src = `return function block(c, r, mem, P) {\nif (${checks}) return -1;\n${code}};`;
    const fn = new Function(src)();
    return { fn, n, idx, start };
  }

  // Specialised code for common instruction forms, or null to use the generic path
  function specialise(insn, PC, R) {
    const op3 = (insn >>> 25) & 7;
    const rn = (insn >>> 16) & 15, rd = (insn >>> 12) & 15, rm = insn & 15;
    // ---- data processing (immediate, register, register shifted by immediate)
    const isDP = (op3 === 0 && (insn & 0x90) !== 0x90 && (insn & 0x01900000) !== 0x01000000 && !(insn & 0x10)) ||
      (op3 === 1 && (insn & 0x01900000) !== 0x01000000);
    if (isDP) {
      if (rd === 15) return null;
      const op = (insn >>> 21) & 15, S = (insn & 0x00100000) !== 0;
      let b, sc, pre = '';
      if (insn & 0x02000000) {
        const rot = ((insn >>> 8) & 15) * 2, v = rorConst(insn & 0xFF, rot);
        b = `${v}`; sc = rot === 0 ? 'c.c' : `${v >>> 31}`;
      } else if ((insn & 0xFF0) === 0) {
        b = R(rm); sc = 'c.c';
      } else {
        const type = (insn >>> 5) & 3, amt = (insn >>> 7) & 31;
        pre = `const x = ${R(rm)}; `;
        switch (type) {
          case 0: b = amt ? `((x << ${amt}) >>> 0)` : 'x'; sc = amt ? `((x >>> ${32 - amt}) & 1)` : 'c.c'; break;
          case 1: b = amt ? `(x >>> ${amt})` : '0'; sc = amt ? `((x >>> ${amt - 1}) & 1)` : '(x >>> 31)'; break;
          case 2: b = amt ? `(((x | 0) >> ${amt}) >>> 0)` : '((x >>> 31) ? 0xFFFFFFFF : 0)'; sc = amt ? `((x >>> ${amt - 1}) & 1)` : '(x >>> 31)'; break;
          default: b = amt ? `(((x >>> ${amt}) | (x << ${32 - amt})) >>> 0)` : '(((c.c << 31) | (x >>> 1)) >>> 0)'; sc = amt ? `((x >>> ${amt - 1}) & 1)` : '(x & 1)';
        }
      }
      const a = R(rn);
      const logicFlags = (res) => `c.n = ${res} >>> 31; c.z = ${res} === 0 ? 1 : 0; c.c = s;`;
      // sc must be read before any flag changes (RRX reads the old carry)
      const needSc = S && (op < 2 || op >= 12 || op === 8 || op === 9);
      let s = `{ ${pre}const b = ${b};${needSc ? ` const s = ${sc};` : ''} `;
      switch (op) {
        case 0: s += `const res = (${a} & b) >>> 0;`; break;
        case 1: s += `const res = (${a} ^ b) >>> 0;`; break;
        case 2: s += S ? `const res = c.subF(${a}, b);` : `const res = (${a} - b) >>> 0;`; break;
        case 3: s += S ? `const res = c.subF(b, ${a});` : `const res = (b - ${a}) >>> 0;`; break;
        case 4: s += S ? `const res = c.addF(${a}, b);` : `const res = (${a} + b) >>> 0;`; break;
        case 5: s += S ? `const res = c.adcF(${a}, b);` : `const res = (${a} + b + c.c) >>> 0;`; break;
        case 6: s += S ? `const res = c.sbcF(${a}, b);` : `const res = (${a} - b - (1 - c.c)) >>> 0;`; break;
        case 7: s += S ? `const res = c.sbcF(b, ${a});` : `const res = (b - ${a} - (1 - c.c)) >>> 0;`; break;
        case 8: return `${s}const res = (${a} & b) >>> 0; ${logicFlags('res')} }`;
        case 9: return `${s}const res = (${a} ^ b) >>> 0; ${logicFlags('res')} }`;
        case 10: return `${s}c.subF(${a}, b); }`;
        case 11: return `${s}c.addF(${a}, b); }`;
        case 12: s += `const res = (${a} | b) >>> 0;`; break;
        case 13: s += 'const res = b;'; break;
        case 14: s += `const res = (${a} & ~b) >>> 0;`; break;
        default: s += 'const res = (~b) >>> 0;';
      }
      if (S && (op < 2 || op >= 12)) s += ` ${logicFlags('res')}`;
      return `${s} r[${rd}] = res; }`;
    }
    // ---- LDR / STR / LDRB / STRB
    if (op3 === 2 || (op3 === 3 && !(insn & 0x10))) {
      const L = insn & 0x00100000, P = insn & 0x01000000, U = insn & 0x00800000, B = insn & 0x00400000;
      const wb = !P || (insn & 0x00200000);
      if ((L && rd === 15) || (wb && rn === 15)) return null;
      let off;
      if (op3 === 2) off = `${insn & 0xFFF}`;
      else {
        const type = (insn >>> 5) & 3, amt = (insn >>> 7) & 31, x = R(rm);
        switch (type) { // immShift values (the shifter carry is not used by loads/stores)
          case 0: off = amt ? `((${x} << ${amt}) >>> 0)` : x; break;
          case 1: off = amt ? `(${x} >>> ${amt})` : '0'; break;
          case 2: off = amt ? `(((${x} | 0) >> ${amt}) >>> 0)` : `((${x} >>> 31) ? 0xFFFFFFFF : 0)`; break;
          default: off = amt ? `(((${x} >>> ${amt}) | (${x} << ${32 - amt})) >>> 0)` : `(((c.c << 31) | (${x} >>> 1)) >>> 0)`;
        }
      }
      let s = `{ c.curPC = ${PC}; const base = ${R(rn)}, offAddr = (base ${U ? '+' : '-'} ${off}) >>> 0; `;
      const addr = P ? 'offAddr' : 'base';
      if (L) s += `const v = ${B ? `mem.r8(${addr})` : `mem.r32(${addr})`}; ${wb ? `r[${rn}] = offAddr; ` : ''}r[${rd}] = v; }`;
      else s += `const v = ${R(rd)}; ${B ? `mem.w8(${addr}, v & 0xFF)` : `mem.w32(${addr}, v)`}; ${wb ? `r[${rn}] = offAddr; ` : ''}}`;
      return s;
    }
    if (op3 === 0 && (insn & 0x90) === 0x90) {
      // ---- LDRH / STRH / LDRSB / LDRSH (LDRD / STRD use the generic path)
      if ((insn & 0x60) !== 0) {
        const L = insn & 0x00100000, P = insn & 0x01000000, U = insn & 0x00800000, sh = (insn >>> 5) & 3;
        const wb = !P || (insn & 0x00200000);
        if ((!L && sh !== 1) || (L && rd === 15) || (wb && rn === 15)) return null;
        const off = (insn & 0x00400000) ? `${((insn >>> 4) & 0xF0) | (insn & 0xF)}` : R(rm);
        let s = `{ c.curPC = ${PC}; const base = ${R(rn)}, offAddr = (base ${U ? '+' : '-'} ${off}) >>> 0; `;
        const addr = P ? 'offAddr' : 'base';
        if (L) {
          const load = sh === 1 ? `mem.r16(${addr})` : sh === 2 ? `((mem.r8(${addr}) << 24) >> 24)` : `((mem.r16(${addr}) << 16) >> 16)`;
          s += `const v = ${load}; ${wb ? `r[${rn}] = offAddr; ` : ''}r[${rd}] = v; }`;
        } else s += `mem.w16(${addr}, ${R(rd)} & 0xFFFF); ${wb ? `r[${rn}] = offAddr; ` : ''}}`;
        return s;
      }
      // ---- MUL / MLA
      if ((insn & 0x0FC000F0) === 0x00000090) {
        const mrd = (insn >>> 16) & 15, mrn = (insn >>> 12) & 15, rs = (insn >>> 8) & 15;
        if (mrd === 15) return null;
        const acc = insn & 0x00200000 ? ` + ${R(mrn)}` : '';
        return `{ r[${mrd}] = Math.imul(${R(rm)}, ${R(rs)})${acc};${insn & 0x00100000 ? ` const x = r[${mrd}]; c.n = x >>> 31; c.z = x === 0 ? 1 : 0;` : ''} }`;
      }
      return null;
    }
    // ---- SXTB / SXTH / UXTB / UXTH (and the add forms)
    if (op3 === 3 && (insn & 0x10) && ((insn >>> 5) & 7) === 3) {
      const op1 = (insn >>> 20) & 0x1F;
      if (op1 !== 10 && op1 !== 11 && op1 !== 14 && op1 !== 15) return null;
      const rot = ((insn >>> 10) & 3) * 8, x = R(rm);
      const v = rot ? `(((${x} >>> ${rot}) | (${x} << ${32 - rot})) >>> 0)` : x;
      const add = rn !== 15 ? ` + ${R(rn)}` : ' + 0';
      const ext = { 10: `((v << 24) >> 24)`, 11: `((v << 16) >> 16)`, 14: '(v & 0xFF)', 15: '(v & 0xFFFF)' }[op1];
      return `{ const v = ${v}; r[${rd}] = ${ext}${add}; }`;
    }
    return null;
  }

  class CPU {
    constructor(mem) {
      this.mem = mem;
      this.r = new Uint32Array(16);
      this.pc = 0;          // address of the next instruction
      this.t = 0;           // Thumb state
      this.n = 0; this.z = 0; this.c = 0; this.v = 0; this.q = 0; this.ge = 0;
      const fb = new ArrayBuffer(128);
      this.fs = new Float32Array(fb);   // s0-s31
      this.fd = new Float64Array(fb);   // d0-d15 (aliases s registers)
      this.fu = new Uint32Array(fb);    // raw words
      this.fpscr = 0x03C00000;
      this.excl = -1;       // exclusive monitor address
      this.tls = 0;         // CP15 c13 user read-only thread ID (TLS pointer)
      this.tlsRW = 0;
      this.sc = 0;          // shifter carry-out scratch
      this.mlo = 0; this.mhi = 0; // 64-bit multiply scratch
      this.stop = false;
      this.svcHandler = null;
      this.curPC = 0;
      this.jit = true;          // compile hot ARM blocks (false = interpret every instruction; same results)
      // Direct-mapped by address bits: compiled blocks (checked against their start address) and branch-target
      // counters (shared on collisions; they only decide when to compile)
      this.blockTab = new Array(BLOCK_TAB).fill(null);
      this.hot = new Uint16Array(BLOCK_TAB);
      // Blocks are compiled once reached this often: the JS engine only optimises functions that run many
      // times, and a block compiled too early runs slower than the interpreter
      this.jitThreshold = 4096;
      this.blocksCompiled = 0;
    }

    // ---------------------------------------------------------------- context
    newContext() {
      return { r: new Uint32Array(16), pc: 0, t: 0, n: 0, z: 0, c: 0, v: 0, q: 0, ge: 0, fu: new Uint32Array(32), fpscr: 0x03C00000, tls: 0, tlsRW: 0 };
    }

    saveContext(ctx) {
      ctx.r.set(this.r); ctx.pc = this.pc; ctx.t = this.t;
      ctx.n = this.n; ctx.z = this.z; ctx.c = this.c; ctx.v = this.v; ctx.q = this.q; ctx.ge = this.ge;
      ctx.fu.set(this.fu); ctx.fpscr = this.fpscr; ctx.tls = this.tls; ctx.tlsRW = this.tlsRW;
    }

    loadContext(ctx) {
      this.r.set(ctx.r); this.pc = ctx.pc; this.t = ctx.t;
      this.n = ctx.n; this.z = ctx.z; this.c = ctx.c; this.v = ctx.v; this.q = ctx.q; this.ge = ctx.ge;
      this.fu.set(ctx.fu); this.fpscr = ctx.fpscr; this.tls = ctx.tls; this.tlsRW = ctx.tlsRW;
      this.excl = -1;
    }

    getCPSR() {
      return ((this.n << 31) | (this.z << 30) | (this.c << 29) | (this.v << 28) | (this.q << 27) | (this.ge << 16) | (this.t << 5) | 0x10) >>> 0;
    }

    undef(insn, what = 'undefined instruction') {
      throw new EMU.EmuError(`${what} ${hex(insn, this.t ? 4 : 8)} at ${hex(this.curPC)} (${this.t ? 'Thumb' : 'ARM'})`);
    }

    // ---------------------------------------------------------------- main loop
    run(max) {
      this.stop = false;
      const mem = this.mem, r = this.r, pages32 = mem.pages32;
      let i = 0, jumped = true;
      while (i < max && !this.stop) {
        // At a branch target: run a compiled block if there is one and it fits in the budget
        if (jumped && this.jit && !this.t) {
          const start = this.pc, slot = (start >>> 2) & (BLOCK_TAB - 1);
          let b = this.blockTab[slot];
          if (b === null || b.start !== start) {
            b = null;
            const n = this.hot[slot] + 1;
            if (n < this.jitThreshold) this.hot[slot] = n;
            else {
              this.hot[slot] = 0;
              b = compileArmBlock(this, start);
              this.blockTab[slot] = b;
              if (b) this.blocksCompiled++;
            }
          }
          if (b !== null && b.n <= max - i) {
            const P = pages32[b.idx];
            const k = P === null ? -1 : b.fn(this, r, mem, P);
            if (k >= 0) { i += k; continue; }
            this.blockTab[slot] = null; // the code changed: compile again once it is hot
          }
          jumped = false;
        }
        i++;
        const pc = this.pc;
        this.curPC = pc;
        if (this.t) {
          const insn = mem.r16(pc);
          this.pc = (pc + 2) >>> 0;
          r[15] = pc + 4;
          this.execThumb(insn, pc);
        } else {
          const page = pages32[pc >>> 12];
          const insn = (page !== null && (pc & 3) === 0 ? page[(pc & 0xFFF) >>> 2] : mem.r32(pc)) | 0; // int32 keeps V8 off doubles
          this.pc = (pc + 4) >>> 0;
          r[15] = pc + 8;
          const cond = insn >>> 28;
          if (cond === 14 || this.cond(cond)) this.execArm(insn, pc);
          else if (cond === 15) this.execArmUncond(insn, pc);
        }
        jumped = this.pc !== ((pc + (this.t ? 2 : 4)) >>> 0) || this.t !== 0;
      }
      return i;
    }

    cond(c) {
      switch (c) {
        case 0: return this.z === 1;
        case 1: return this.z === 0;
        case 2: return this.c === 1;
        case 3: return this.c === 0;
        case 4: return this.n === 1;
        case 5: return this.n === 0;
        case 6: return this.v === 1;
        case 7: return this.v === 0;
        case 8: return this.c === 1 && this.z === 0;
        case 9: return this.c === 0 || this.z === 1;
        case 10: return this.n === this.v;
        case 11: return this.n !== this.v;
        case 12: return this.z === 0 && this.n === this.v;
        case 13: return this.z === 1 || this.n !== this.v;
        case 14: return true;
        default: return false;
      }
    }

    // Branch with interworking (BX semantics).
    bx(v) {
      if (v & 1) { this.t = 1; this.pc = (v & ~1) >>> 0; }
      else { this.t = 0; this.pc = (v & ~3) >>> 0; }
    }

    // ---------------------------------------------------------------- flag helpers
    nz(v) { this.n = v >>> 31; this.z = v === 0 ? 1 : 0; }

    addF(a, b) {
      const res = a + b, r = res >>> 0;
      this.c = res > 0xFFFFFFFF ? 1 : 0;
      this.v = ((a ^ r) & (b ^ r)) >>> 31;
      this.n = r >>> 31; this.z = r === 0 ? 1 : 0;
      return r;
    }

    adcF(a, b) {
      const res = a + b + this.c, r = res >>> 0;
      this.c = res > 0xFFFFFFFF ? 1 : 0;
      this.v = ((a ^ r) & (b ^ r)) >>> 31;
      this.n = r >>> 31; this.z = r === 0 ? 1 : 0;
      return r;
    }

    subF(a, b) {
      const r = (a - b) >>> 0;
      this.c = a >= b ? 1 : 0;
      this.v = ((a ^ b) & (a ^ r)) >>> 31;
      this.n = r >>> 31; this.z = r === 0 ? 1 : 0;
      return r;
    }

    sbcF(a, b) {
      const res = a - b - (1 - this.c), r = res >>> 0;
      this.c = res >= 0 ? 1 : 0;
      this.v = ((a ^ b) & (a ^ r)) >>> 31;
      this.n = r >>> 31; this.z = r === 0 ? 1 : 0;
      return r;
    }

    // Shift by register amount (bottom byte). Sets this.sc.
    regShift(type, v, amt) {
      if (amt === 0) { this.sc = this.c; return v; }
      switch (type) {
        case 0:
          if (amt < 32) { this.sc = (v >>> (32 - amt)) & 1; return (v << amt) >>> 0; }
          this.sc = amt === 32 ? v & 1 : 0; return 0;
        case 1:
          if (amt < 32) { this.sc = (v >>> (amt - 1)) & 1; return v >>> amt; }
          this.sc = amt === 32 ? v >>> 31 : 0; return 0;
        case 2:
          if (amt < 32) { this.sc = (v >>> (amt - 1)) & 1; return ((v | 0) >> amt) >>> 0; }
          this.sc = v >>> 31; return this.sc ? 0xFFFFFFFF : 0;
        default:
          amt &= 31;
          if (amt === 0) { this.sc = v >>> 31; return v; }
          this.sc = (v >>> (amt - 1)) & 1; return ror(v, amt);
      }
    }

    // Shift by immediate. Sets this.sc.
    immShift(type, v, amt) {
      switch (type) {
        case 0:
          if (amt === 0) { this.sc = this.c; return v; }
          this.sc = (v >>> (32 - amt)) & 1; return (v << amt) >>> 0;
        case 1:
          if (amt === 0) { this.sc = v >>> 31; return 0; }
          this.sc = (v >>> (amt - 1)) & 1; return v >>> amt;
        case 2:
          if (amt === 0) { this.sc = v >>> 31; return this.sc ? 0xFFFFFFFF : 0; }
          this.sc = (v >>> (amt - 1)) & 1; return ((v | 0) >> amt) >>> 0;
        default:
          if (amt === 0) { this.sc = v & 1; return ((this.c << 31) | (v >>> 1)) >>> 0; }
          this.sc = (v >>> (amt - 1)) & 1; return ror(v, amt);
      }
    }

    shifterOperand(insn) {
      const rm = insn & 15;
      const type = (insn >>> 5) & 3;
      if (insn & 0x10) {
        let v = this.r[rm];
        if (rm === 15) v = (v + 4) >>> 0;
        return this.regShift(type, v, this.r[(insn >>> 8) & 15] & 0xFF);
      }
      return this.immShift(type, this.r[rm], (insn >>> 7) & 31);
    }

    // 32x32 -> 64 multiply into this.mlo / this.mhi
    umul64(a, b) {
      const al = a & 0xFFFF, ah = a >>> 16, bl = b & 0xFFFF, bh = b >>> 16;
      const ll = al * bl, mid = al * bh + ah * bl, hh = ah * bh;
      const lo = ll + (mid % 65536) * 65536;
      this.mlo = lo >>> 0;
      this.mhi = (hh + Math.floor(mid / 65536) + Math.floor(lo / TWO32)) >>> 0;
    }

    smul64(a, b) {
      this.umul64(a >>> 0, b >>> 0);
      let hi = this.mhi;
      if (a & 0x80000000) hi -= b >>> 0;
      if (b & 0x80000000) hi -= a >>> 0;
      this.mhi = hi >>> 0;
    }

    add64(hi, lo) {
      const l = this.mlo + lo;
      this.mlo = l >>> 0;
      this.mhi = (this.mhi + hi + (l > 0xFFFFFFFF ? 1 : 0)) >>> 0;
    }

    // ================================================================ ARM
    execArm(insn, pc) {
      switch ((insn >>> 25) & 7) {
        case 0:
          if ((insn & 0x90) === 0x90) {
            if ((insn & 0x60) === 0) {
              if ((insn & 0x0F000000) === 0) this.armMul(insn);
              else if ((insn & 0x0F800000) === 0x01800000) this.armExclusive(insn);
              else if ((insn & 0x0FB00FF0) === 0x01000090) this.armSwap(insn);
              else this.undef(insn);
            } else this.armExtraLS(insn);
            return;
          }
          if ((insn & 0x01900000) === 0x01000000) { this.armMisc(insn, pc); return; }
          this.armDP(insn);
          return;
        case 1:
          if ((insn & 0x01900000) === 0x01000000) {
            if ((insn & 0x0FB00000) === 0x03200000) { // MSR immediate / hints
              const mask = (insn >>> 16) & 15;
              if (mask) this.writePSR(ror(insn & 0xFF, ((insn >>> 8) & 15) * 2), mask);
            } else if ((insn & 0x0FF00000) === 0x03000000) { // MOVW
              this.r[(insn >>> 12) & 15] = ((insn >>> 4) & 0xF000) | (insn & 0xFFF);
            } else if ((insn & 0x0FF00000) === 0x03400000) { // MOVT
              const rd = (insn >>> 12) & 15;
              this.r[rd] = ((((insn >>> 4) & 0xF000) | (insn & 0xFFF)) << 16 | (this.r[rd] & 0xFFFF)) >>> 0;
            } else this.undef(insn);
            return;
          }
          this.armDP(insn);
          return;
        case 2: this.armLS(insn, false); return;
        case 3:
          if (insn & 0x10) this.armMedia(insn); else this.armLS(insn, true);
          return;
        case 4: this.armBlock(insn); return;
        case 5: {
          if (insn & 0x01000000) this.r[14] = pc + 4;
          this.pc = (pc + 8 + ((insn << 8) >> 6)) >>> 0;
          return;
        }
        case 6: this.armCoprocLS(insn); return;
        case 7:
          if (insn & 0x01000000) { this.svcHandler(insn & 0xFFFFFF); return; }
          this.armCoproc(insn);
          return;
      }
    }

    execArmUncond(insn, pc) {
      if ((insn & 0x0E000000) === 0x0A000000) { // BLX immediate
        const off = ((insn << 8) >> 6) | ((insn >>> 23) & 2);
        this.r[14] = pc + 4;
        this.t = 1;
        this.pc = (pc + 8 + off) >>> 0;
        return;
      }
      if ((insn >>> 0) === 0xF57FF01F) { this.excl = -1; return; } // CLREX
      // PLD, DMB/DSB/ISB, CPS, SETEND, SRS/RFE: no-ops in this model
    }

    writePSR(val, mask) {
      if (mask & 8) {
        this.n = val >>> 31; this.z = (val >>> 30) & 1; this.c = (val >>> 29) & 1; this.v = (val >>> 28) & 1; this.q = (val >>> 27) & 1;
      }
      if (mask & 4) this.ge = (val >>> 16) & 15;
    }

    armMisc(insn, pc) {
      const r = this.r;
      const op = (insn >>> 21) & 3;
      switch ((insn >>> 4) & 15) {
        case 0:
          if (op & 1) this.writePSR(r[insn & 15], (insn >>> 16) & 15); // MSR reg
          else r[(insn >>> 12) & 15] = this.getCPSR();                // MRS
          return;
        case 1:
          if (op === 1) { this.bx(r[insn & 15]); return; }
          if (op === 3) { r[(insn >>> 12) & 15] = Math.clz32(r[insn & 15]); return; }
          break;
        case 2:
          if (op === 1) { this.bx(r[insn & 15]); return; } // BXJ
          break;
        case 3:
          if (op === 1) { const target = r[insn & 15]; r[14] = pc + 4; this.bx(target); return; }
          break;
        case 5: { // QADD/QSUB/QDADD/QDSUB
          const rn = (insn >>> 16) & 15, rd = (insn >>> 12) & 15, rm = insn & 15;
          let b = r[rn] | 0;
          if (op & 2) { const d = satS(b * 2, 32); if (d !== b * 2) this.q = 1; b = d; }
          const raw = (op & 1) ? (r[rm] | 0) - b : (r[rm] | 0) + b;
          const res = satS(raw, 32);
          if (res !== raw) this.q = 1;
          r[rd] = res;
          return;
        }
        case 7: this.undef(insn, 'BKPT');
        case 8: case 10: case 12: case 14: { // signed halfword multiplies
          const rd = (insn >>> 16) & 15, rn = (insn >>> 12) & 15, rs = (insn >>> 8) & 15, rm = insn & 15;
          const x = (insn >>> 5) & 1, y = (insn >>> 6) & 1;
          const a = x ? (r[rm] | 0) >> 16 : sx16(r[rm]);
          const b = y ? (r[rs] | 0) >> 16 : sx16(r[rs]);
          switch (op) {
            case 0: { const res = a * b + (r[rn] | 0); if (res !== (res | 0)) this.q = 1; r[rd] = res; return; }
            case 1: {
              const res = Math.floor((r[rm] | 0) * b / 65536);
              if (x === 0) { const acc = res + (r[rn] | 0); if (acc !== (acc | 0)) this.q = 1; r[rd] = acc; }
              else r[rd] = res;
              return;
            }
            case 2: {
              const acc = (BigInt(r[rd] | 0) << 32n) + BigInt(r[rn]) + BigInt(a * b);
              r[rn] = Number(BigInt.asUintN(32, acc));
              r[rd] = Number(BigInt.asUintN(32, acc >> 32n));
              return;
            }
            case 3: r[rd] = a * b; return;
          }
        }
      }
      this.undef(insn);
    }

    armDP(insn) {
      const r = this.r;
      const op = (insn >>> 21) & 15, S = insn & 0x00100000, rn = (insn >>> 16) & 15, rd = (insn >>> 12) & 15;
      let b;
      if (insn & 0x02000000) {
        const rot = ((insn >>> 8) & 15) * 2;
        b = ror(insn & 0xFF, rot);
        this.sc = rot === 0 ? this.c : b >>> 31;
      } else if ((insn & 0xFF0) === 0) {
        b = r[insn & 15];
        this.sc = this.c;
      } else b = this.shifterOperand(insn);
      let a = r[rn];
      if (rn === 15 && (insn & 0x02000010) === 0x10) a = (a + 4) >>> 0;
      let res;
      switch (op) {
        case 0: res = (a & b) >>> 0; break;
        case 1: res = (a ^ b) >>> 0; break;
        case 2: res = S ? this.subF(a, b) : (a - b) >>> 0; break;
        case 3: res = S ? this.subF(b, a) : (b - a) >>> 0; break;
        case 4: res = S ? this.addF(a, b) : (a + b) >>> 0; break;
        case 5: res = S ? this.adcF(a, b) : (a + b + this.c) >>> 0; break;
        case 6: res = S ? this.sbcF(a, b) : (a - b - (1 - this.c)) >>> 0; break;
        case 7: res = S ? this.sbcF(b, a) : (b - a - (1 - this.c)) >>> 0; break;
        case 8: res = (a & b) >>> 0; this.nz(res); this.c = this.sc; return;
        case 9: res = (a ^ b) >>> 0; this.nz(res); this.c = this.sc; return;
        case 10: this.subF(a, b); return;
        case 11: this.addF(a, b); return;
        case 12: res = (a | b) >>> 0; break;
        case 13: res = b; break;
        case 14: res = (a & ~b) >>> 0; break;
        case 15: res = (~b) >>> 0; break;
      }
      if (S && (op < 2 || op >= 12)) { this.nz(res); this.c = this.sc; }
      if (rd === 15) this.pc = (res & ~3) >>> 0;
      else r[rd] = res;
    }

    armLS(insn, regOffset) {
      const r = this.r, mem = this.mem;
      const rn = (insn >>> 16) & 15, rd = (insn >>> 12) & 15;
      const off = regOffset ? this.immShift((insn >>> 5) & 3, r[insn & 15], (insn >>> 7) & 31) : insn & 0xFFF;
      const base = r[rn];
      const offAddr = ((insn & 0x00800000) ? base + off : base - off) >>> 0;
      const P = insn & 0x01000000;
      const addr = P ? offAddr : base;
      const wb = !P || (insn & 0x00200000);
      if (insn & 0x00100000) {
        const v = (insn & 0x00400000) ? mem.r8(addr) : mem.r32(addr);
        if (wb) r[rn] = offAddr;
        if (rd === 15) this.bx(v); else r[rd] = v;
      } else {
        const v = r[rd];
        if (insn & 0x00400000) mem.w8(addr, v & 0xFF); else mem.w32(addr, v);
        if (wb) r[rn] = offAddr;
      }
    }

    armExtraLS(insn) {
      const r = this.r, mem = this.mem;
      const rn = (insn >>> 16) & 15, rd = (insn >>> 12) & 15, sh = (insn >>> 5) & 3;
      const off = (insn & 0x00400000) ? ((insn >>> 4) & 0xF0) | (insn & 0xF) : r[insn & 15];
      const base = r[rn];
      const offAddr = ((insn & 0x00800000) ? base + off : base - off) >>> 0;
      const P = insn & 0x01000000;
      const addr = P ? offAddr : base;
      const wb = !P || (insn & 0x00200000);
      if (insn & 0x00100000) {
        const v = sh === 1 ? mem.r16(addr) : sh === 2 ? sx8(mem.r8(addr)) : sx16(mem.r16(addr));
        if (wb) r[rn] = offAddr;
        if (rd === 15) this.bx(v); else r[rd] = v;
      } else if (sh === 1) {
        mem.w16(addr, r[rd] & 0xFFFF);
        if (wb) r[rn] = offAddr;
      } else if (sh === 2) { // LDRD
        const lo = mem.r32(addr), hi = mem.r32((addr + 4) >>> 0);
        if (wb) r[rn] = offAddr;
        r[rd] = lo; r[rd + 1] = hi;
      } else { // STRD
        mem.w32(addr, r[rd]); mem.w32((addr + 4) >>> 0, r[rd + 1]);
        if (wb) r[rn] = offAddr;
      }
    }

    armBlock(insn) {
      const r = this.r, mem = this.mem;
      const rn = (insn >>> 16) & 15, list = insn & 0xFFFF;
      const cnt = popcount16(list);
      const base = r[rn];
      const U = insn & 0x00800000, P = insn & 0x01000000;
      let addr = U ? (P ? base + 4 : base) : (P ? base - cnt * 4 : base - cnt * 4 + 4);
      const newBase = U ? base + cnt * 4 : base - cnt * 4;
      if (insn & 0x00100000) {
        if (insn & 0x00200000) r[rn] = newBase;
        for (let i = 0; i < 16; i++) {
          if (list & (1 << i)) {
            const v = mem.r32(addr >>> 0);
            addr += 4;
            if (i === 15) this.bx(v); else r[i] = v;
          }
        }
      } else {
        for (let i = 0; i < 16; i++) {
          if (list & (1 << i)) { mem.w32(addr >>> 0, r[i]); addr += 4; }
        }
        if (insn & 0x00200000) r[rn] = newBase;
      }
    }

    armMul(insn) {
      const r = this.r;
      const op = (insn >>> 21) & 7, S = insn & 0x00100000;
      const rd = (insn >>> 16) & 15, rn = (insn >>> 12) & 15, rs = (insn >>> 8) & 15, rm = insn & 15;
      switch (op) {
        case 0: case 1: {
          let res = Math.imul(r[rm], r[rs]);
          if (op === 1) res += r[rn];
          r[rd] = res;
          if (S) this.nz(r[rd]);
          return;
        }
        case 2: // UMAAL
          this.umul64(r[rm], r[rs]); this.add64(0, r[rn]); this.add64(0, r[rd]);
          r[rn] = this.mlo; r[rd] = this.mhi;
          return;
        case 3: r[rd] = r[rn] - Math.imul(r[rm], r[rs]); return; // MLS
        default: {
          if (op & 2) this.smul64(r[rm], r[rs]); else this.umul64(r[rm], r[rs]);
          if (op & 1) this.add64(r[rd], r[rn]);
          r[rn] = this.mlo; r[rd] = this.mhi;
          if (S) { this.n = this.mhi >>> 31; this.z = (this.mhi | this.mlo) === 0 ? 1 : 0; }
        }
      }
    }

    armSwap(insn) {
      const r = this.r, mem = this.mem;
      const rn = (insn >>> 16) & 15, rd = (insn >>> 12) & 15, rm = insn & 15;
      const addr = r[rn];
      if (insn & 0x00400000) { const t = mem.r8(addr); mem.w8(addr, r[rm] & 0xFF); r[rd] = t; }
      else { const t = mem.r32(addr); mem.w32(addr, r[rm]); r[rd] = t; }
    }

    armExclusive(insn) {
      const r = this.r, mem = this.mem;
      const op = (insn >>> 21) & 3, rn = (insn >>> 16) & 15, rd = (insn >>> 12) & 15, rt = insn & 15;
      const addr = r[rn];
      if (insn & 0x00100000) {
        switch (op) {
          case 0: r[rd] = mem.r32(addr); break;
          case 1: r[rd] = mem.r32(addr); r[rd + 1] = mem.r32((addr + 4) >>> 0); break;
          case 2: r[rd] = mem.r8(addr); break;
          case 3: r[rd] = mem.r16(addr); break;
        }
        this.excl = addr;
      } else {
        if (this.excl === addr) {
          switch (op) {
            case 0: mem.w32(addr, r[rt]); break;
            case 1: mem.w32(addr, r[rt]); mem.w32((addr + 4) >>> 0, r[rt + 1]); break;
            case 2: mem.w8(addr, r[rt] & 0xFF); break;
            case 3: mem.w16(addr, r[rt] & 0xFFFF); break;
          }
          r[rd] = 0;
        } else r[rd] = 1;
        this.excl = -1;
      }
    }

    // ---------------------------------------------------------------- ARMv6 media
    armMedia(insn) {
      const r = this.r;
      const op1 = (insn >>> 20) & 0x1F, op2 = (insn >>> 5) & 7;
      const rn = (insn >>> 16) & 15, rd = (insn >>> 12) & 15, rs = (insn >>> 8) & 15, rm = insn & 15;
      if (op1 < 8) { this.parallelAddSub(insn); return; }
      if (op1 < 16) {
        if ((op1 === 10 || op1 === 11 || op1 === 14 || op1 === 15) && (op2 & 1) === 0) { // SSAT / USAT
          const satImm = (insn >>> 16) & 31, amt = (insn >>> 7) & 31;
          let v = r[rm] | 0;
          v = (insn & 0x40) ? (v >> (amt === 0 ? 31 : amt)) : (v << amt);
          if (op1 >= 14) { const s = satU(v, satImm); if (s !== v) this.q = 1; r[rd] = s; }
          else { const s = satS(v, satImm + 1); if (s !== v) this.q = 1; r[rd] = s; }
          return;
        }
        if (op2 === 3) { // extend (and add)
          const v = ror(r[rm], ((insn >>> 10) & 3) * 8);
          const add = rn !== 15 ? r[rn] : 0;
          switch (op1) {
            case 8: case 12: { // SXTB16 / UXTB16
              const sgn = op1 === 8;
              let lo = v & 0xFF, hi = (v >>> 16) & 0xFF;
              if (sgn) { lo = sx8(lo); hi = sx8(hi); }
              lo = (lo + (add & 0xFFFF)) & 0xFFFF;
              hi = (hi + (add >>> 16)) & 0xFFFF;
              r[rd] = (hi << 16) | lo;
              return;
            }
            case 10: r[rd] = sx8(v) + add; return;
            case 11: r[rd] = sx16(v) + add; return;
            case 14: r[rd] = (v & 0xFF) + add; return;
            case 15: r[rd] = (v & 0xFFFF) + add; return;
          }
        }
        if (op1 === 8) {
          if ((op2 & 1) === 0) { // PKHBT / PKHTB
            const amt = (insn >>> 7) & 31;
            if (insn & 0x40) r[rd] = (r[rn] & 0xFFFF0000) | ((((r[rm] | 0) >> (amt === 0 ? 31 : amt))) & 0xFFFF);
            else r[rd] = (r[rn] & 0xFFFF) | ((r[rm] << amt) & 0xFFFF0000);
            return;
          }
          if (op2 === 5) { // SEL
            const a = r[rn], b = r[rm], g = this.ge;
            r[rd] = ((g & 1 ? a : b) & 0xFF) | ((g & 2 ? a : b) & 0xFF00) | ((g & 4 ? a : b) & 0xFF0000) | ((g & 8 ? a : b) & 0xFF000000);
            return;
          }
        }
        if (op1 === 10 && op2 === 1) { // SSAT16
          const sat = ((insn >>> 16) & 15) + 1, v = r[rm];
          const lo = satS(sx16(v), sat), hi = satS((v | 0) >> 16, sat);
          if (lo !== sx16(v) || hi !== (v | 0) >> 16) this.q = 1;
          r[rd] = ((hi & 0xFFFF) << 16) | (lo & 0xFFFF);
          return;
        }
        if (op1 === 14 && op2 === 1) { // USAT16
          const sat = (insn >>> 16) & 15, v = r[rm];
          const lo = satU(sx16(v), sat), hi = satU((v | 0) >> 16, sat);
          if (lo !== sx16(v) || hi !== (v | 0) >> 16) this.q = 1;
          r[rd] = (hi << 16) | lo;
          return;
        }
        if (op1 === 11 && op2 === 1) { // REV
          const v = r[rm];
          r[rd] = ((v & 0xFF) << 24) | ((v & 0xFF00) << 8) | ((v >>> 8) & 0xFF00) | (v >>> 24);
          return;
        }
        if (op1 === 11 && op2 === 5) { // REV16
          const v = r[rm];
          r[rd] = ((v & 0x00FF00FF) << 8) | ((v >>> 8) & 0x00FF00FF);
          return;
        }
        if (op1 === 15 && op2 === 5) { // REVSH
          const v = r[rm];
          r[rd] = sx16(((v & 0xFF) << 8) | ((v >>> 8) & 0xFF));
          return;
        }
        if (op1 === 15 && op2 === 1) { // RBIT
          let v = r[rm], o = 0;
          for (let i = 0; i < 32; i++) { o = (o << 1) | (v & 1); v >>>= 1; }
          r[rd] = o;
          return;
        }
        this.undef(insn);
      }
      if (op1 < 24) { // signed multiplies; fields: Rd=19-16, Ra=15-12, Rm=11-8, Rn=3-0
        const RD = rn, RA = rd, RM = rs, RN = rm;
        const a = r[RN], b = (op2 & 1) ? ror(r[RM], 16) : r[RM];
        const p1 = sx16(a) * sx16(b), p2 = ((a | 0) >> 16) * ((b | 0) >> 16);
        if (op1 === 16) { // SMLAD/SMUAD/SMLSD/SMUSD
          let res = (op2 & 2) ? p1 - p2 : p1 + p2;
          if (RA !== 15) res += r[RA] | 0;
          if (res !== (res | 0)) this.q = 1;
          r[RD] = res;
          return;
        }
        if (op1 === 20) { // SMLALD/SMLSLD
          const sum = BigInt((op2 & 2) ? p1 - p2 : p1 + p2);
          const acc = (BigInt(r[RD] | 0) << 32n) + BigInt(r[RA]) + sum;
          r[RA] = Number(BigInt.asUintN(32, acc));
          r[RD] = Number(BigInt.asUintN(32, acc >> 32n));
          return;
        }
        if (op1 === 21) { // SMMUL/SMMLA/SMMLS
          this.smul64(r[RN], r[RM]);
          if ((op2 & 6) === 6) { // SMMLS: (Ra<<32) - product
            const lo = (0 - this.mlo) >>> 0, borrow = this.mlo !== 0 ? 1 : 0;
            this.mhi = (r[RA] - this.mhi - borrow) >>> 0; this.mlo = lo;
          } else if (RA !== 15) this.mhi = (this.mhi + r[RA]) >>> 0;
          if (op2 & 1) this.add64(0, 0x80000000);
          r[RD] = this.mhi;
          return;
        }
        this.undef(insn);
      }
      if (op1 === 24 && op2 === 0) { // USAD8 / USADA8
        const a = r[rm], b = r[rs];
        let s = 0;
        for (let i = 0; i < 32; i += 8) s += Math.abs(((a >>> i) & 0xFF) - ((b >>> i) & 0xFF));
        r[rn] = s + (rd !== 15 ? r[rd] : 0);
        return;
      }
      const lsb = (insn >>> 7) & 31;
      if ((op1 & 0x1E) === 0x1A && (op2 & 3) === 2) { // SBFX
        const w = ((insn >>> 16) & 31) + 1;
        r[rd] = ((r[rm] << (32 - lsb - w)) | 0) >> (32 - w);
        return;
      }
      if ((op1 & 0x1E) === 0x1E && (op2 & 3) === 2) { // UBFX
        const w = ((insn >>> 16) & 31) + 1;
        r[rd] = w === 32 ? r[rm] : (r[rm] >>> lsb) & ((1 << w) - 1);
        return;
      }
      if ((op1 & 0x1E) === 0x1C && (op2 & 3) === 0) { // BFI / BFC
        const msb = (insn >>> 16) & 31;
        if (msb < lsb) return;
        const w = msb - lsb + 1;
        const mask = (w === 32 ? 0xFFFFFFFF : ((1 << w) - 1) << lsb) >>> 0;
        const src = rm === 15 ? 0 : (r[rm] << lsb);
        r[rd] = (r[rd] & ~mask) | (src & mask);
        return;
      }
      this.undef(insn);
    }

    parallelAddSub(insn) {
      const r = this.r;
      const kind = (insn >>> 20) & 7, op = (insn >>> 5) & 7;
      const rn = (insn >>> 16) & 15, rd = (insn >>> 12) & 15, rm = insn & 15;
      const a = r[rn], b = r[rm];
      const signed = kind < 4;
      const mode = kind & 3; // 1 = modular (sets GE), 2 = saturating, 3 = halving
      if (mode === 0 || op === 5 || op === 6) this.undef(insn);
      let res = 0, ge = 0;
      if (op < 4) { // 16-bit lanes
        const a0 = signed ? sx16(a) : a & 0xFFFF, a1 = signed ? (a | 0) >> 16 : a >>> 16;
        const b0 = signed ? sx16(b) : b & 0xFFFF, b1 = signed ? (b | 0) >> 16 : b >>> 16;
        let r0, r1, add0, add1;
        switch (op) {
          case 0: r0 = a0 + b0; r1 = a1 + b1; add0 = add1 = true; break;      // ADD16
          case 1: r0 = a0 - b1; r1 = a1 + b0; add0 = false; add1 = true; break; // ASX
          case 2: r0 = a0 + b1; r1 = a1 - b0; add0 = true; add1 = false; break; // SAX
          default: r0 = a0 - b0; r1 = a1 - b1; add0 = add1 = false; break;    // SUB16
        }
        const lanes = [[r0, add0], [r1, add1]];
        for (let i = 0; i < 2; i++) {
          let [v, isAdd] = lanes[i];
          if (mode === 1) {
            if (signed ? v >= 0 : (isAdd ? v >= 0x10000 : v >= 0)) ge |= 3 << (i * 2);
          } else if (mode === 2) v = signed ? satS(v, 16) : satU(v, 16);
          else v >>= 1;
          res |= (v & 0xFFFF) << (i * 16);
        }
        if (mode === 1) this.ge = ge;
      } else { // 8-bit lanes: op 4 = ADD8, 7 = SUB8
        const isAdd = op === 4;
        for (let i = 0; i < 4; i++) {
          const sh = i * 8;
          const x = signed ? sx8(a >>> sh) : (a >>> sh) & 0xFF;
          const y = signed ? sx8(b >>> sh) : (b >>> sh) & 0xFF;
          let v = isAdd ? x + y : x - y;
          if (mode === 1) {
            if (signed ? v >= 0 : (isAdd ? v >= 0x100 : v >= 0)) ge |= 1 << i;
          } else if (mode === 2) v = signed ? satS(v, 8) : satU(v, 8);
          else v >>= 1;
          res |= (v & 0xFF) << sh;
        }
        if (mode === 1) this.ge = ge;
      }
      r[rd] = res;
    }

    // ---------------------------------------------------------------- coprocessors / VFP
    armCoprocLS(insn) {
      const cp = (insn >>> 8) & 15;
      if (cp !== 10 && cp !== 11) return; // other coprocessors: ignore
      const r = this.r, mem = this.mem, fu = this.fu;
      const dbl = cp === 11;
      if ((insn & 0x0FE00000) === 0x0C400000) { // VMOV between two core registers and S/D registers
        const rt2 = (insn >>> 16) & 15, rt = (insn >>> 12) & 15;
        const m = dbl ? ((insn & 15) | (((insn >>> 5) & 1) << 4)) * 2 : ((insn & 15) << 1) | ((insn >>> 5) & 1);
        if (insn & 0x00100000) { r[rt] = fu[m]; r[rt2] = fu[m + 1]; }
        else { fu[m] = r[rt]; fu[m + 1] = r[rt2]; }
        return;
      }
      const P = insn & 0x01000000, U = insn & 0x00800000, D = (insn >>> 22) & 1, W = insn & 0x00200000, L = insn & 0x00100000;
      const rn = (insn >>> 16) & 15, vd = (insn >>> 12) & 15, imm8 = insn & 0xFF;
      const first = dbl ? ((vd | (D << 4)) * 2) : ((vd << 1) | D);
      const base = rn === 15 ? (r[15] & ~3) >>> 0 : r[rn];
      let addr, words;
      if (P && !W) { // VLDR / VSTR
        addr = (U ? base + imm8 * 4 : base - imm8 * 4) >>> 0;
        words = dbl ? 2 : 1;
      } else { // VLDM / VSTM
        words = dbl ? imm8 & ~1 : imm8;
        addr = (P ? base - imm8 * 4 : base) >>> 0;
        if (W) r[rn] = U ? base + imm8 * 4 : base - imm8 * 4;
      }
      for (let i = 0; i < words; i++) {
        const idx = (first + i) & 31;
        if (L) fu[idx] = mem.r32((addr + i * 4) >>> 0);
        else mem.w32((addr + i * 4) >>> 0, fu[idx]);
      }
    }

    armCoproc(insn) {
      const cp = (insn >>> 8) & 15;
      const r = this.r;
      if (cp === 15) {
        if (!(insn & 0x10)) return;
        const crn = (insn >>> 16) & 15, crm = insn & 15, opc2 = (insn >>> 5) & 7, rt = (insn >>> 12) & 15;
        if (insn & 0x00100000) { // MRC
          let v = 0;
          if (crn === 13 && crm === 0 && opc2 === 3) v = this.tls;
          else if (crn === 13 && crm === 0 && opc2 === 2) v = this.tlsRW;
          else if (crn === 0 && crm === 0 && opc2 === 5) v = 0; // CPU ID: core 0
          if (rt === 15) { this.n = v >>> 31; this.z = (v >>> 30) & 1; this.c = (v >>> 29) & 1; this.v = (v >>> 28) & 1; }
          else r[rt] = v;
        } else if (crn === 13 && crm === 0 && opc2 === 2) this.tlsRW = r[rt]; // MCR (cache ops, barriers: no-op)
        return;
      }
      if (cp !== 10 && cp !== 11) this.undef(insn, 'unsupported coprocessor');
      if (insn & 0x10) {
        const L = insn & 0x00100000, rt = (insn >>> 12) & 15, opc1 = (insn >>> 21) & 7, fu = this.fu;
        if (cp === 10) {
          if (opc1 === 0) { // VMOV Sn <-> Rt
            const n = (((insn >>> 16) & 15) << 1) | ((insn >>> 7) & 1);
            if (L) r[rt] = fu[n]; else fu[n] = r[rt];
          } else if (opc1 === 7) { // VMRS / VMSR
            const reg = (insn >>> 16) & 15;
            if (L) {
              const v = reg === 1 ? this.fpscr : reg === 0 ? 0x410120B4 : reg === 8 ? 0x40000000 : 0;
              if (rt === 15) { this.n = v >>> 31; this.z = (v >>> 30) & 1; this.c = (v >>> 29) & 1; this.v = (v >>> 28) & 1; }
              else r[rt] = v;
            } else if (reg === 1) this.fpscr = r[rt];
          } else this.undef(insn);
        } else { // VMOV scalar <-> core register (word lanes)
          const d = ((insn >>> 16) & 15) | (((insn >>> 7) & 1) << 4);
          const idx = d * 2 + ((insn >>> 21) & 1);
          if (L) r[rt] = fu[idx]; else fu[idx] = r[rt];
        }
        return;
      }
      this.vfpDataProc(insn);
    }

    setFPFlags(a, b) {
      let f;
      if (a !== a || b !== b) f = 0x3;      // unordered: C V
      else if (a === b) f = 0x6;            // Z C
      else if (a < b) f = 0x8;              // N
      else f = 0x2;                         // C
      this.fpscr = ((this.fpscr & 0x0FFFFFFF) | (f << 28)) >>> 0;
    }

    fpRound(x) {
      switch ((this.fpscr >>> 22) & 3) {
        case 0: { const f = Math.floor(x), d = x - f; return d > 0.5 ? f + 1 : d < 0.5 ? f : (f % 2 === 0 ? f : f + 1); }
        case 1: return Math.ceil(x);
        case 2: return Math.floor(x);
        default: return Math.trunc(x);
      }
    }

    vfpDataProc(insn) {
      const dbl = (insn >>> 8) & 1;
      const D = (insn >>> 22) & 1, N = (insn >>> 7) & 1, M = (insn >>> 5) & 1;
      const Vd = (insn >>> 12) & 15, Vn = (insn >>> 16) & 15, Vm = insn & 15;
      const vd = dbl ? Vd | (D << 4) : (Vd << 1) | D;
      const vn = dbl ? Vn | (N << 4) : (Vn << 1) | N;
      const vm = dbl ? Vm | (M << 4) : (Vm << 1) | M;
      const F = dbl ? this.fd : this.fs;
      const rnd = dbl ? (x) => x : Math.fround;
      const s = (insn >>> 6) & 1;
      const opc = (((insn >>> 23) & 1) << 2) | ((insn >>> 20) & 3);
      switch (opc) {
        case 0: { const p = rnd(F[vn] * F[vm]); F[vd] = F[vd] + (s ? -p : p); return; }   // VMLA / VMLS
        case 1: { const p = rnd(F[vn] * F[vm]); F[vd] = -F[vd] + (s ? -p : p); return; }  // VNMLS / VNMLA
        case 2: { const p = F[vn] * F[vm]; F[vd] = s ? -rnd(p) : p; return; }              // VMUL / VNMUL
        case 3: F[vd] = s ? F[vn] - F[vm] : F[vn] + F[vm]; return;                         // VADD / VSUB
        case 4: if (!s) { F[vd] = F[vn] / F[vm]; return; } break;                          // VDIV
        case 7: break;
        default: this.undef(insn, 'unsupported VFP op');
      }
      if (opc !== 7) this.undef(insn, 'unsupported VFP op');
      if (!s) { // VMOV immediate (VFPv3)
        const imm8 = (Vn << 4) | Vm;
        const e = (imm8 & 0x40) ? ((imm8 >>> 4) & 3) - 3 : ((imm8 >>> 4) & 3) + 1;
        const val = ((16 + (imm8 & 15)) / 16) * 2 ** e;
        F[vd] = (imm8 & 0x80) ? -val : val;
        return;
      }
      const op7 = (insn >>> 7) & 1;
      const fu = this.fu;
      switch (Vn) { // opc2
        // VMOV/VABS/VNEG work on the raw bits: registers often hold integers whose bit
        // patterns are NaNs, which a float copy would canonicalize.
        case 0: case 1: {
          if (Vn === 1 && op7) { F[vd] = Math.sqrt(F[vm]); return; } // VSQRT
          const sign = Vn === 0 ? (op7 ? 0 : -1) : -2;                // -1 keep, 0 clear, -2 flip
          const hi = (w) => (sign === -1 ? w : sign === 0 ? w & 0x7FFFFFFF : w ^ 0x80000000) >>> 0;
          if (dbl) { fu[vd * 2] = fu[vm * 2]; fu[vd * 2 + 1] = hi(fu[vm * 2 + 1]); }
          else fu[vd] = hi(fu[vm]);
          return;
        }
        case 4: this.setFPFlags(F[vd], F[vm]); return;                     // VCMP(E)
        case 5: this.setFPFlags(F[vd], 0); return;                         // VCMP(E) #0
        case 7: // VCVT between single and double
          if (dbl) this.fs[(Vd << 1) | D] = this.fd[vm];
          else this.fd[Vd | (D << 4)] = this.fs[vm];
          return;
        case 8: { // VCVT int -> float (source is always a single register)
          const sm = (Vm << 1) | M;
          F[vd] = op7 ? (fu[sm] | 0) : fu[sm];
          return;
        }
        case 12: case 13: { // VCVT float -> int (dest is always a single register)
          const sd = (Vd << 1) | D;
          const x = F[vm];
          let v = x !== x ? 0 : (op7 ? Math.trunc(x) : this.fpRound(x));
          if (Vn === 13) { v = v > 2147483647 ? 2147483647 : v < -2147483648 ? -2147483648 : v; fu[sd] = v | 0; }
          else { v = v > 4294967295 ? 4294967295 : v < 0 ? 0 : v; fu[sd] = v >>> 0; }
          return;
        }
      }
      this.undef(insn, 'unsupported VFP op');
    }

    // ================================================================ Thumb
    execThumb(insn, pc) {
      const r = this.r, mem = this.mem;
      switch (insn >>> 11) {
        case 0: case 1: case 2: { // shift by immediate
          const rd = insn & 7, v = r[(insn >>> 3) & 7], amt = (insn >>> 6) & 31;
          const res = this.immShift(insn >>> 11, v, amt);
          this.c = this.sc;
          r[rd] = res; this.nz(res);
          return;
        }
        case 3: { // ADD/SUB register or 3-bit immediate
          const rd = insn & 7, a = r[(insn >>> 3) & 7], f = (insn >>> 6) & 7;
          const b = (insn & 0x400) ? f : r[f];
          r[rd] = (insn & 0x200) ? this.subF(a, b) : this.addF(a, b);
          return;
        }
        case 4: { const rd = (insn >>> 8) & 7, v = insn & 0xFF; r[rd] = v; this.nz(v); return; }
        case 5: this.subF(r[(insn >>> 8) & 7], insn & 0xFF); return;
        case 6: { const rd = (insn >>> 8) & 7; r[rd] = this.addF(r[rd], insn & 0xFF); return; }
        case 7: { const rd = (insn >>> 8) & 7; r[rd] = this.subF(r[rd], insn & 0xFF); return; }
        case 8:
          if (insn & 0x400) this.thumbHiReg(insn, pc); else this.thumbALU(insn);
          return;
        case 9: r[(insn >>> 8) & 7] = mem.r32((((pc + 4) & ~3) + (insn & 0xFF) * 4) >>> 0); return;
        case 10: case 11: { // load/store register offset
          const rd = insn & 7, addr = (r[(insn >>> 3) & 7] + r[(insn >>> 6) & 7]) >>> 0;
          switch ((insn >>> 9) & 7) {
            case 0: mem.w32(addr, r[rd]); return;
            case 1: mem.w16(addr, r[rd] & 0xFFFF); return;
            case 2: mem.w8(addr, r[rd] & 0xFF); return;
            case 3: r[rd] = sx8(mem.r8(addr)); return;
            case 4: r[rd] = mem.r32(addr); return;
            case 5: r[rd] = mem.r16(addr); return;
            case 6: r[rd] = mem.r8(addr); return;
            case 7: r[rd] = sx16(mem.r16(addr)); return;
          }
          return;
        }
        case 12: mem.w32((r[(insn >>> 3) & 7] + ((insn >>> 6) & 31) * 4) >>> 0, r[insn & 7]); return;
        case 13: r[insn & 7] = mem.r32((r[(insn >>> 3) & 7] + ((insn >>> 6) & 31) * 4) >>> 0); return;
        case 14: mem.w8((r[(insn >>> 3) & 7] + ((insn >>> 6) & 31)) >>> 0, r[insn & 7] & 0xFF); return;
        case 15: r[insn & 7] = mem.r8((r[(insn >>> 3) & 7] + ((insn >>> 6) & 31)) >>> 0); return;
        case 16: mem.w16((r[(insn >>> 3) & 7] + ((insn >>> 6) & 31) * 2) >>> 0, r[insn & 7] & 0xFFFF); return;
        case 17: r[insn & 7] = mem.r16((r[(insn >>> 3) & 7] + ((insn >>> 6) & 31) * 2) >>> 0); return;
        case 18: mem.w32((r[13] + (insn & 0xFF) * 4) >>> 0, r[(insn >>> 8) & 7]); return;
        case 19: r[(insn >>> 8) & 7] = mem.r32((r[13] + (insn & 0xFF) * 4) >>> 0); return;
        case 20: r[(insn >>> 8) & 7] = ((pc + 4) & ~3) + (insn & 0xFF) * 4; return;
        case 21: r[(insn >>> 8) & 7] = r[13] + (insn & 0xFF) * 4; return;
        case 22: case 23: this.thumbMisc(insn, pc); return;
        case 24: { // STMIA
          const rn = (insn >>> 8) & 7;
          let addr = r[rn];
          for (let i = 0; i < 8; i++) if (insn & (1 << i)) { mem.w32(addr >>> 0, r[i]); addr += 4; }
          r[rn] = addr;
          return;
        }
        case 25: { // LDMIA
          const rn = (insn >>> 8) & 7;
          let addr = r[rn];
          const final = addr + popcount16(insn & 0xFF) * 4;
          for (let i = 0; i < 8; i++) if (insn & (1 << i)) { r[i] = mem.r32(addr >>> 0); addr += 4; }
          if (!(insn & (1 << rn))) r[rn] = final;
          return;
        }
        case 26: case 27: { // conditional branch / SWI
          const c = (insn >>> 8) & 15;
          if (c === 15) { this.svcHandler(insn & 0xFF); return; }
          if (c === 14) this.undef(insn);
          if (this.cond(c)) this.pc = (pc + 4 + (sx8(insn) << 1)) >>> 0;
          return;
        }
        case 28: this.pc = (pc + 4 + (((insn << 21) >> 21) << 1)) >>> 0; return;
        case 29: { // BLX suffix
          const target = (r[14] + ((insn & 0x7FF) << 1)) & ~3;
          r[14] = (pc + 2) | 1;
          this.t = 0; this.pc = target >>> 0;
          return;
        }
        case 30: r[14] = pc + 4 + (((insn << 21) >> 21) << 12); return; // BL prefix
        case 31: { // BL suffix
          const target = (r[14] + ((insn & 0x7FF) << 1)) >>> 0;
          r[14] = (pc + 2) | 1;
          this.pc = (target & ~1) >>> 0;
          return;
        }
      }
    }

    thumbALU(insn) {
      const r = this.r;
      const rd = insn & 7, rm = (insn >>> 3) & 7;
      const a = r[rd], b = r[rm];
      let res;
      switch ((insn >>> 6) & 15) {
        case 0: res = (a & b) >>> 0; break;
        case 1: res = (a ^ b) >>> 0; break;
        case 2: res = this.regShift(0, a, b & 0xFF); this.c = this.sc; break;
        case 3: res = this.regShift(1, a, b & 0xFF); this.c = this.sc; break;
        case 4: res = this.regShift(2, a, b & 0xFF); this.c = this.sc; break;
        case 5: r[rd] = this.adcF(a, b); return;
        case 6: r[rd] = this.sbcF(a, b); return;
        case 7: res = this.regShift(3, a, b & 0xFF); this.c = this.sc; break;
        case 8: this.nz((a & b) >>> 0); return;
        case 9: r[rd] = this.subF(0, b); return;
        case 10: this.subF(a, b); return;
        case 11: this.addF(a, b); return;
        case 12: res = (a | b) >>> 0; break;
        case 13: res = Math.imul(a, b) >>> 0; break;
        case 14: res = (a & ~b) >>> 0; break;
        case 15: res = (~b) >>> 0; break;
      }
      r[rd] = res;
      this.nz(res);
    }

    thumbHiReg(insn, pc) {
      const r = this.r;
      const rd = (insn & 7) | ((insn >>> 4) & 8), rm = (insn >>> 3) & 15;
      switch ((insn >>> 8) & 3) {
        case 0: {
          const v = (r[rd] + r[rm]) >>> 0;
          if (rd === 15) this.pc = (v & ~1) >>> 0; else r[rd] = v;
          return;
        }
        case 1: this.subF(r[rd], r[rm]); return;
        case 2:
          if (rd === 15) this.pc = (r[rm] & ~1) >>> 0; else r[rd] = r[rm];
          return;
        case 3: {
          const target = r[rm];
          if (insn & 0x80) r[14] = (pc + 2) | 1;
          this.bx(target);
          return;
        }
      }
    }

    thumbMisc(insn, pc) {
      const r = this.r, mem = this.mem;
      switch ((insn >>> 8) & 15) {
        case 0: {
          const imm = (insn & 0x7F) * 4;
          r[13] = (insn & 0x80) ? r[13] - imm : r[13] + imm;
          return;
        }
        case 2: {
          const rd = insn & 7, v = r[(insn >>> 3) & 7];
          switch ((insn >>> 6) & 3) {
            case 0: r[rd] = sx16(v); return;
            case 1: r[rd] = sx8(v); return;
            case 2: r[rd] = v & 0xFFFF; return;
            case 3: r[rd] = v & 0xFF; return;
          }
          return;
        }
        case 4: case 5: { // PUSH
          const list = insn & 0xFF, lr = insn & 0x100;
          const cnt = popcount16(list) + (lr ? 1 : 0);
          let addr = r[13] - cnt * 4;
          r[13] = addr;
          for (let i = 0; i < 8; i++) if (list & (1 << i)) { mem.w32(addr >>> 0, r[i]); addr += 4; }
          if (lr) mem.w32(addr >>> 0, r[14]);
          return;
        }
        case 6: return; // CPS / SETEND
        case 10: {
          const rd = insn & 7, v = r[(insn >>> 3) & 7];
          switch ((insn >>> 6) & 3) {
            case 0: r[rd] = ((v & 0xFF) << 24) | ((v & 0xFF00) << 8) | ((v >>> 8) & 0xFF00) | (v >>> 24); return;
            case 1: r[rd] = ((v & 0x00FF00FF) << 8) | ((v >>> 8) & 0x00FF00FF); return;
            case 3: r[rd] = sx16(((v & 0xFF) << 8) | ((v >>> 8) & 0xFF)); return;
          }
          break;
        }
        case 12: case 13: { // POP
          const list = insn & 0xFF;
          let addr = r[13];
          for (let i = 0; i < 8; i++) if (list & (1 << i)) { r[i] = mem.r32(addr >>> 0); addr += 4; }
          if (insn & 0x100) { const v = mem.r32(addr >>> 0); addr += 4; r[13] = addr; this.bx(v); return; }
          r[13] = addr;
          return;
        }
        case 14: this.undef(insn, 'BKPT');
        case 15: return; // hints
      }
      this.undef(insn);
    }
  }

  EMU.CPU = CPU;
  EMU.compileArmBlock = compileArmBlock; // for tests
})(typeof window !== 'undefined' ? window.EMU : globalThis.EMU);

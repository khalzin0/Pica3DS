// ARM block compiler fuzz test: random straight-line ARM code (data processing with every operand form,
// loads/stores with every addressing mode, halfword/signed loads, multiplies, extends, plus instructions
// the compiler leaves to the interpreter) ending in a branch. Each program runs once through the
// interpreter and once as a compiled block from the same state; registers, flags, PC and memory must match.
//   node tests/cpu/armfuzz.js [programs]
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
  const CODE = 0x00100000, DATA = 0x08000000, DATA_SIZE = 0x40000;
  const FILL = new Uint8Array(DATA_SIZE).map((_, i) => (Math.imul(i, 2654435761) >>> 24) ^ i);

  // Registers: r0-r7 free, r8-r11 data pointers (only changed by writeback), r12 a small offset, r13/r14 free
  function program(r) {
    const R = (n) => r() * n | 0;
    const cond = () => (r() < 0.6 ? 14 : R(15));
    const dst = () => [0, 1, 2, 3, 4, 5, 6, 7, 13, 14][R(10)];
    const any = () => R(16);
    const base = () => 8 + R(4);
    const words = [];
    const n = 1 + R(60);
    for (let k = 0; k < n; k++) {
      const c = cond() << 28, kind = r();
      let w;
      if (kind < 0.4) { // data processing
        const op = R(16), S = op >= 8 && op <= 11 ? 1 : R(2);
        let rd = dst(); const rn = any();
        let op2;
        const form = R(4);
        if (form === 0) op2 = (1 << 25) | (R(16) << 8) | R(256);
        else if (form === 1) op2 = any();
        else if (form === 2) op2 = (R(32) << 7) | (R(4) << 5) | any();
        else op2 = (R(15) << 8) | (R(4) << 5) | 0x10 | R(15); // register-shifted register (interpreter path)
        if (op >= 8 && op <= 11) rd = 0;
        w = c | (op << 21) | (S << 20) | (rn << 16) | (rd << 12) | op2;
      } else if (kind < 0.62) { // LDR/STR/LDRB/STRB
        const L = R(2), B = R(2), P = R(2), U = R(2), W = R(2);
        const rd = L ? dst() : any();
        let off;
        if (r() < 0.5) off = R(0x200);
        else { const type = R(3); off = (1 << 25) | ((type === 0 ? R(5) : R(32)) << 7) | (type << 5) | 12; }
        w = c | (1 << 26) | (P << 24) | (U << 23) | (B << 22) | (W << 21) | (L << 20) | (base() << 16) | (rd << 12) | off;
      } else if (kind < 0.74) { // LDRH/STRH/LDRSB/LDRSH
        const L = R(2), P = R(2), U = R(2), W = R(2), sh = L ? 1 + R(3) : 1;
        const rd = L ? dst() : any();
        const I = R(2), hi = I ? R(16) : 0, lo = I ? R(16) : 12;
        w = c | (P << 24) | (U << 23) | (I << 22) | (W << 21) | (L << 20) | (base() << 16) | (rd << 12) | (hi << 8) | (1 << 7) | (sh << 5) | (1 << 4) | lo;
      } else if (kind < 0.8) { // MUL / MLA
        w = c | (R(2) << 21) | (R(2) << 20) | (dst() << 16) | (any() << 12) | (any() << 8) | 0x90 | any();
      } else if (kind < 0.9) { // SXTB/SXTH/UXTB/UXTH (+ add forms)
        const op1 = [10, 11, 14, 15][R(4)];
        w = c | (0x3 << 25) | (op1 << 20) | (any() << 16) | (dst() << 12) | (R(4) << 10) | (3 << 5) | 0x10 | any();
      } else { // instructions the compiler leaves to the interpreter
        const g = R(16);
        if (g === 0) w = c | 0x016F0F10 | (dst() << 12) | any();                       // CLZ
        else if (g === 1) w = c | 0x010F0000 | (dst() << 12);                           // MRS
        else if (g === 2) w = c | 0x0128F000 | any();                                   // MSR CPSR_f, reg
        else if (g === 3) w = c | 0x01000050 | (any() << 16) | (dst() << 12) | any();   // QADD
        else if (g === 4) w = c | 0x06CF0070 | (dst() << 12) | (R(4) << 10) | any();    // UXTB16
        else if (g === 5) w = c | 0x03000000 | (R(16) << 16) | (dst() << 12) | R(0x1000); // MOVW
        else if (g === 6) w = 0xF5D0F000 | (base() << 16) | R(0x1000);                 // PLD (unconditional space, no-op)
        else if (g === 7) w = 0xFA000000 | (R(2) << 24) | R(0x40);                      // BLX to Thumb code (leaves the block)
        else if (g === 8) w = c | 0x06000F10 | ([1, 2, 3, 5, 6, 7][R(6)] << 20) | (any() << 16) | (dst() << 12) | ([0, 1, 2, 3, 4, 7][R(6)] << 5) | any(); // parallel add/sub
        else if (g === 9) w = c | 0x06800FB0 | (any() << 16) | (dst() << 12) | any(); // SEL
        else if (g === 10) w = c | ((R(2) ? 0x37 : 0x35) << 21) | (R(32) << 16) | (dst() << 12) | (R(32) << 7) | (R(2) << 6) | 0x10 | any(); // SSAT / USAT
        else if (g === 11) w = c | (R(2) ? 0x06BF0F30 : 0x06BF0FB0) | (dst() << 12) | any(); // REV / REV16
        else if (g === 12) w = c | 0x07000010 | (dst() << 16) | (any() << 12) | (any() << 8) | (R(4) << 5) | any(); // SMLAD / SMUAD / SMLSD
        else if (g === 13) w = c | 0x0780F010 | (dst() << 16) | (any() << 8) | any(); // USAD8
        else { // LDM / STM (loads never touch the data pointers r8-r12 or PC)
          const L = R(2), list = L ? (R(0x10000) & 0x60FF) : R(0x10000);
          w = c | (4 << 25) | (R(2) << 24) | (R(2) << 23) | (R(2) << 21) | (L << 20) | (base() << 16) | (list || 1);
        }
      }
      words.push(w >>> 0);
    }
    words.push(0xEAFFFFFE); // B . (ends the block)
    return words;
  }

  // Two machines, reused for every program (page tables are large to allocate)
  const machines = [0, 1].map(() => {
    const mem = new EMU.Memory();
    return { mem, code: mem.alloc(CODE, 0x1000, 5, 3, 'code'), data: mem.alloc(DATA, DATA_SIZE, 3, 3, 'data') };
  });

  function machine(m, words, regs) {
    const { mem, data } = m;
    m.code.fill(0);
    for (let i = 0; i < words.length; i++) mem.w32(CODE + i * 4, words[i]);
    data.set(FILL);
    const cpu = new EMU.CPU(mem);
    cpu.r.set(regs.r);
    cpu.n = regs.f & 1; cpu.z = (regs.f >> 1) & 1; cpu.c = (regs.f >> 2) & 1; cpu.v = (regs.f >> 3) & 1;
    cpu.pc = CODE;
    return { cpu, mem, data };
  }
  let faults = 0;

  function check(count = 3000, seed = 7) {
    const r = rng(seed);
    for (let p = 0; p < count; p++) {
      const words = program(r);
      const regs = { r: new Uint32Array(16), f: r() * 16 | 0 };
      for (let i = 0; i < 16; i++) regs.r[i] = r() < 0.3 ? [0, 1, 0x80000000, 0xFFFFFFFF, 0x7FFFFFFF, 31, 32][r() * 7 | 0] : (r() * 0x100000000) >>> 0;
      for (let i = 8; i < 12; i++) regs.r[i] = DATA + 0x10000 + (r() * 0x20000 | 0);
      regs.r[12] = r() * 0x400 | 0;
      const a = machine(machines[0], words, regs), b = machine(machines[1], words, regs);
      a.cpu.jit = false;
      let errA = null, errB = null;
      // The block may leave early (e.g. into Thumb code): the interpreter then runs as many instructions
      const blk = EMU.compileArmBlock(b.cpu, CODE);
      let k = words.length;
      try { k = blk.fn(b.cpu, b.cpu.r, b.mem, b.mem.pages32[CODE >>> 12]); } catch (e) { errB = e.message; }
      if (k < 1) return `program ${p}: block returned ${k}`;
      try { a.cpu.run(k); } catch (e) { errA = e.message; }
      const fail = (what) => `program ${p}: ${what}\n${words.map((w) => w.toString(16).padStart(8, '0')).join(' ')}`;
      if (errA !== errB) return fail(`errors differ: ${errA} / ${errB}`);
      if (errA) { faults++; continue; } // both faulted the same way (state after a fault is not compared)
      for (let i = 0; i < 16; i++) if (a.cpu.r[i] !== b.cpu.r[i]) return fail(`r${i}: interpreter ${a.cpu.r[i].toString(16)} compiled ${b.cpu.r[i].toString(16)}`);
      if (a.cpu.getCPSR() !== b.cpu.getCPSR()) return fail(`CPSR: interpreter ${a.cpu.getCPSR().toString(16)} compiled ${b.cpu.getCPSR().toString(16)}`);
      if (a.cpu.pc !== b.cpu.pc || a.cpu.curPC !== b.cpu.curPC || a.cpu.t !== b.cpu.t) return fail(`pc: interpreter ${a.cpu.pc.toString(16)} compiled ${b.cpu.pc.toString(16)}`);
      const da = new Uint32Array(a.data.buffer), db = new Uint32Array(b.data.buffer);
      for (let i = 0; i < da.length; i++) if (da[i] !== db[i]) return fail(`memory at ${(DATA + i * 4).toString(16)}`);
    }
    check.faults = faults;
    return null;
  }

  return { check };
};

if (require.main === module) {
  const fs = require('fs'), path = require('path'), vm = require('vm');
  for (const f of ['memory.js', 'cpu.js']) vm.runInThisContext(fs.readFileSync(path.join(__dirname, '../../src', f), 'utf8'), { filename: f });
  const t0 = Date.now();
  const { check } = module.exports(globalThis.EMU);
  const err = check(+process.argv[2] || 3000);
  console.log(err ? `FAIL  ${err}` : `PASS  (${Date.now() - t0} ms, ${check.faults} programs stopped at a memory fault)`);
}

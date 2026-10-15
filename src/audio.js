// High-level emulation of the DSP audio pipeline: the application describes up to 24 voices (sources) in DSP
// shared memory; each audio frame (160 samples at 32728 Hz) this reads their configuration, plays their
// buffer queues (PCM8, PCM16, DSP-ADPCM), mixes them with the application's gains and reports each voice's
// status back. The mixed frame goes to emu.onAudio(left, right).
(function (EMU) {
  'use strict';

  const FRAME = 160, SOURCES = 24, CONFIG_SIZE = 0xC0, STATUS_SIZE = 12;
  const f32 = new Float32Array(1), u32 = new Uint32Array(f32.buffer);

  // Source configuration dirty flags (32-bit little-endian word at the start of each configuration)
  const DIRTY = {
    format: 1 << 0, monoStereo: 1 << 1, adpcmCoefs: 1 << 2, partialReset: 1 << 4,
    enable: 1 << 16, interpolation: 1 << 17, rate: 1 << 18, queue: 1 << 19, playPosition: 1 << 21,
    gain0: 1 << 25, gain1: 1 << 26, gain2: 1 << 27, syncCount: 1 << 28, reset: 1 << 29, embedded: 1 << 30,
  };

  function newSource() {
    return {
      enabled: false, syncCount: 0, rate: 1, interpolation: 0,
      gain: [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]],
      stereo: false, format: 1, coefs: new Int16Array(16), yn1: 0, yn2: 0,
      queue: [],        // buffers waiting to play, played lowest buffer ID first
      cur: null,        // { left: Float32Array, right: Float32Array, id }
      pos: 0,           // read position in cur (samples, fractional)
      curId: 0, lastId: 0, bufferUpdate: false,
      frame: [new Float32Array(FRAME), new Float32Array(FRAME)],
    };
  }

  class DspAudio {
    // regions: virtual addresses of the two shared memory regions; layout: byte offsets of the structures
    constructor(emu, regions, layout) {
      this.emu = emu;
      this.mem = emu.mem;
      this.regions = regions;
      this.L = layout;
      this.sources = Array.from({ length: SOURCES }, newSource);
      this.masterVolume = 1;
      this.auxVolume = [1, 1];
      this.left = new Float32Array(FRAME);
      this.right = new Float32Array(FRAME);
      this.mixes = [0, 1, 2].map(() => [0, 1, 2, 3].map(() => new Float32Array(FRAME)));
    }

    r16(a) { return this.mem.r16(a >>> 0); }
    s16(a) { return this.mem.r16(a >>> 0) << 16 >> 16; }
    // DSP 32-bit values are two 16-bit words, high word first
    r32dsp(a) { return ((this.r16(a) << 16) | this.r16(a + 2)) >>> 0; }
    w32dsp(a, v) { this.mem.w16(a >>> 0, v >>> 16); this.mem.w16((a + 2) >>> 0, v & 0xFFFF); }
    rf32(a) { u32[0] = this.mem.r32(a >>> 0); return f32[0]; }

    // The application writes to the region with the newer frame counter; statuses go to the other one
    currentRegions() {
      const [r0, r1] = this.regions;
      const c0 = this.r16(r0 + this.L.frameCounter), c1 = this.r16(r1 + this.L.frameCounter);
      if (c0 === 0xFFFF && c1 !== 0xFFFE) return [r1, r0];
      if (c1 === 0xFFFF && c0 !== 0xFFFE) return [r0, r1];
      return c0 > c1 ? [r0, r1] : [r1, r0];
    }

    tick() {
      const [read, write] = this.currentRegions();
      this.parseDspConfig(read + this.L.dspConfig);
      for (const mix of this.mixes) for (const ch of mix) ch.fill(0);
      for (let i = 0; i < SOURCES; i++) {
        const s = this.sources[i];
        this.parseSourceConfig(s, read + this.L.sourceConfigs + i * CONFIG_SIZE, read + this.L.adpcmCoefs + i * 32);
        this.generate(s);
        this.writeStatus(s, write + this.L.sourceStatuses + i * STATUS_SIZE);
        if (s.enabled || s.cur) this.mixInto(s);
      }
      // Final mix: the main mix plus both auxiliary mixes (effects are not emulated), front + back per side
      const L = this.left, R = this.right, mv = this.masterVolume;
      for (let n = 0; n < FRAME; n++) {
        let l = 0, r = 0;
        for (let m = 0; m < 3; m++) {
          const g = m === 0 ? 1 : this.auxVolume[m - 1], mix = this.mixes[m];
          l += g * (mix[0][n] + mix[2][n]);
          r += g * (mix[1][n] + mix[3][n]);
        }
        l *= mv; r *= mv;
        L[n] = l > 32767 ? 1 : l < -32768 ? -1 : l / 32768;
        R[n] = r > 32767 ? 1 : r < -32768 ? -1 : r / 32768;
      }
      if (this.emu.onAudio) this.emu.onAudio(L, R);
    }

    parseDspConfig(a) {
      const dirty = this.mem.r32(a >>> 0);
      if (!dirty) return;
      const ok = (v) => Number.isFinite(v) && v >= 0 && v <= 8;
      const mv = this.rf32(a + 4), a0 = this.rf32(a + 8), a1 = this.rf32(a + 12);
      if (ok(mv)) this.masterVolume = mv;
      if (ok(a0)) this.auxVolume[0] = a0;
      if (ok(a1)) this.auxVolume[1] = a1;
      this.mem.w32(a >>> 0, 0);
    }

    parseSourceConfig(s, a, coefAddr) {
      const dirty = this.mem.r32(a >>> 0);
      if (!dirty) return;
      if (dirty & DIRTY.reset) { const fresh = newSource(); fresh.frame = s.frame; Object.assign(s, fresh); }
      if (dirty & DIRTY.partialReset) s.queue = [];
      if (dirty & DIRTY.enable) s.enabled = this.mem.r8((a + 0xA0) >>> 0) !== 0;
      if (dirty & DIRTY.syncCount) s.syncCount = this.r16(a + 0xA2);
      if (dirty & DIRTY.rate) { const r = this.rf32(a + 0x34); s.rate = Number.isFinite(r) && r > 0 && r < 64 ? r : 1; }
      if (dirty & DIRTY.adpcmCoefs) for (let i = 0; i < 16; i++) s.coefs[i] = this.s16(coefAddr + i * 2);
      for (let m = 0; m < 3; m++) {
        if (!(dirty & (DIRTY.gain0 << m))) continue;
        for (let c = 0; c < 4; c++) { const g = this.rf32(a + 4 + m * 16 + c * 4); s.gain[m][c] = Number.isFinite(g) ? g : 0; }
      }
      if (dirty & DIRTY.interpolation) s.interpolation = this.mem.r8((a + 0x38) >>> 0);
      const flags1 = this.r16(a + 0xB4);
      if (dirty & (DIRTY.format | DIRTY.embedded)) s.format = (flags1 >> 2) & 3;
      if (dirty & (DIRTY.monoStereo | DIRTY.embedded)) s.stereo = (flags1 & 3) === 2;
      if (dirty & DIRTY.embedded) {
        const flags2 = this.r16(a + 0xBC);
        const playPos = dirty & DIRTY.playPosition ? this.r32dsp(a + 0xA4) : 0;
        this.enqueue(s, {
          phys: this.r32dsp(a + 0xAC), length: this.r32dsp(a + 0xB0), id: this.r16(a + 0xBE),
          adpcmDirty: flags2 & 1, yn1: this.s16(a + 0xB8), yn2: this.s16(a + 0xBA), looping: (flags2 >> 1) & 1,
          fromQueue: false, playPos,
        });
      }
      if (dirty & DIRTY.queue) {
        const mask = this.r16(a + 0x4A);
        for (let i = 0; i < 4; i++) {
          if (!(mask & (1 << i))) continue;
          const b = a + 0x4C + i * 0x14;
          this.enqueue(s, {
            phys: this.r32dsp(b), length: this.r32dsp(b + 4), id: this.r16(b + 0x10),
            adpcmDirty: this.mem.r8((b + 0xE) >>> 0), yn1: this.s16(b + 0xA), yn2: this.s16(b + 0xC),
            looping: this.mem.r8((b + 0xF) >>> 0), fromQueue: true, playPos: 0,
          });
        }
        this.mem.w16((a + 0x4A) >>> 0, 0);
      }
      this.mem.w32(a >>> 0, 0);
    }

    // Buffers take the voice's format and channel count at the time they are queued
    enqueue(s, buf) {
      buf.format = s.format; buf.stereo = s.stereo;
      s.queue.push(buf);
      s.queue.sort((x, y) => x.id - y.id);
    }

    // Start the next queued buffer: decode it whole. False when the queue is empty.
    dequeue(s) {
      const buf = s.queue[0];
      if (!buf) return false;
      if (!buf.looping) s.queue.shift(); // a looping buffer keeps playing until something replaces it
      if (buf.adpcmDirty) { s.yn1 = buf.yn1; s.yn2 = buf.yn2; }
      s.cur = this.decode(s, buf);
      s.pos = Math.min(buf.playPos || 0, s.cur.left.length);
      s.lastId = s.curId;
      s.curId = buf.id;
      s.bufferUpdate = buf.fromQueue;
      return true;
    }

    decode(s, buf) {
      const n = buf.length >>> 0, left = new Float32Array(n), right = buf.stereo ? new Float32Array(n) : left;
      const gpu = this.emu.gpu, addr = gpu ? gpu.toVirt(buf.phys) : buf.phys, mem = this.mem;
      try {
        if (buf.format === 2) { // DSP-ADPCM: 8-byte frames of a header byte and 14 4-bit samples (mono)
          const c = s.coefs;
          let yn1 = s.yn1, yn2 = s.yn2;
          for (let i = 0; i < n; i++) {
            const fa = addr + Math.floor(i / 14) * 8, j = i % 14;
            const header = mem.r8(fa >>> 0), scale = 1 << (header & 0xF), idx = (header >> 4) & 7;
            const byte = mem.r8((fa + 1 + (j >> 1)) >>> 0);
            let nib = j & 1 ? byte & 0xF : byte >> 4;
            if (nib >= 8) nib -= 16;
            let v = ((nib * scale) << 11) + 1024 + c[idx * 2] * yn1 + c[idx * 2 + 1] * yn2;
            v >>= 11;
            v = v > 32767 ? 32767 : v < -32768 ? -32768 : v;
            yn2 = yn1; yn1 = v;
            left[i] = v;
          }
          s.yn1 = yn1; s.yn2 = yn2;
        } else if (buf.format === 1) { // PCM16, interleaved when stereo
          const ch = buf.stereo ? 2 : 1;
          for (let i = 0; i < n; i++) {
            left[i] = mem.r16((addr + i * 2 * ch) >>> 0) << 16 >> 16;
            if (ch === 2) right[i] = mem.r16((addr + i * 4 + 2) >>> 0) << 16 >> 16;
          }
        } else { // PCM8
          const ch = buf.stereo ? 2 : 1;
          for (let i = 0; i < n; i++) {
            left[i] = (mem.r8((addr + i * ch) >>> 0) << 24 >> 24) * 256;
            if (ch === 2) right[i] = (mem.r8((addr + i * 2 + 1) >>> 0) << 24 >> 24) * 256;
          }
        }
      } catch (e) {
        if (!(e instanceof EMU.EmuError)) throw e;
        if (!this.warnedAddr) { this.warnedAddr = true; this.emu.log(`DSP: sound buffer at ${EMU.hex(buf.phys)} is not mapped`); }
      }
      return { left, right };
    }

    // One frame of a voice, resampled by its rate (linear interpolation; also used for polyphase)
    generate(s) {
      const [L, R] = s.frame;
      L.fill(0); R.fill(0);
      if (!s.enabled) return;
      let n = 0;
      while (n < FRAME) {
        if (!s.cur || s.pos >= s.cur.left.length) {
          if (s.cur) s.pos -= s.cur.left.length;
          if (!this.dequeue(s)) {
            s.enabled = false; s.bufferUpdate = true;
            s.lastId = s.curId; s.curId = 0; s.cur = null; s.pos = 0;
            return;
          }
          if (!s.cur.left.length) continue;
        }
        const { left, right } = s.cur, len = left.length, step = s.rate, lin = s.interpolation !== 2;
        for (; n < FRAME && s.pos < len; n++, s.pos += step) {
          const i = s.pos | 0, f = s.pos - i, j = i + 1 < len ? i + 1 : i;
          if (lin && f) { L[n] = left[i] + (left[j] - left[i]) * f; R[n] = right[i] + (right[j] - right[i]) * f; }
          else { L[n] = left[i]; R[n] = right[i]; }
        }
      }
    }

    mixInto(s) {
      const [L, R] = s.frame;
      for (let m = 0; m < 3; m++) {
        const g = s.gain[m], mix = this.mixes[m];
        if (!g[0] && !g[1] && !g[2] && !g[3]) continue;
        for (let n = 0; n < FRAME; n++) {
          mix[0][n] += g[0] * L[n]; mix[1][n] += g[1] * R[n];
          mix[2][n] += g[2] * L[n]; mix[3][n] += g[3] * R[n];
        }
      }
    }

    // Status: [0] enabled, [1] buffer changed, [2] sync count, [4] play position (DSP 32-bit), [8] current
    // buffer ID, [0xA] previous buffer ID
    writeStatus(s, a) {
      const mem = this.mem;
      mem.w8(a >>> 0, s.enabled ? 1 : 0);
      mem.w8((a + 1) >>> 0, s.bufferUpdate ? 1 : 0);
      s.bufferUpdate = false;
      mem.w16((a + 2) >>> 0, s.syncCount);
      this.w32dsp(a + 4, s.cur ? Math.floor(s.pos) : 0);
      mem.w16((a + 8) >>> 0, s.curId);
      mem.w16((a + 10) >>> 0, s.lastId);
    }
  }

  EMU.DspAudio = DspAudio;
  EMU.AUDIO_RATE = 32728;
})(typeof window !== 'undefined' ? window.EMU : globalThis.EMU);

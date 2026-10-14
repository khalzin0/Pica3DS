// Virtual memory: a flat table of 4 KB pages, each a Uint8Array view into some backing buffer.
(function (EMU) {
  'use strict';

  const hex = (v, w = 8) => '0x' + (v >>> 0).toString(16).toUpperCase().padStart(w, '0');
  EMU.hex = hex;

  class EmuError extends Error {}
  EMU.EmuError = EmuError;

  const PAGE_SIZE = 0x1000;

  class Memory {
    constructor() {
      this.pages = new Array(0x100000).fill(null);
      this.pages16 = new Array(0x100000).fill(null); // Uint16Array views for aligned fast paths
      this.pages32 = new Array(0x100000).fill(null); // Uint32Array views for aligned fast paths
      this.regions = []; // { base, size, perm, state, name }
    }

    // Map `size` bytes at `vaddr` onto `backing` (a Uint8Array) starting at `offset`.
    map(vaddr, size, backing, offset = 0, perm = 3, state = 5, name = '') {
      vaddr >>>= 0;
      if ((vaddr | size) & 0xFFF) throw new EmuError(`unaligned map ${hex(vaddr)} size ${hex(size)}`);
      for (let i = 0; i < size; i += PAGE_SIZE) this._setPage((vaddr + i) >>> 12, backing.subarray(offset + i, offset + i + PAGE_SIZE));
      this._addRegion({ base: vaddr, size, perm, state, name });
    }

    // Map an explicit list of page views (used for shared memory blocks and aliases).
    mapPages(vaddr, pages, perm = 3, state = 6, name = '') {
      vaddr >>>= 0;
      for (let i = 0; i < pages.length; i++) this._setPage((vaddr >>> 12) + i, pages[i]);
      this._addRegion({ base: vaddr, size: pages.length * PAGE_SIZE, perm, state, name });
    }

    _setPage(idx, page) {
      this.pages[idx] = page;
      this.pages16[idx] = page && new Uint16Array(page.buffer, page.byteOffset, PAGE_SIZE / 2);
      this.pages32[idx] = page && new Uint32Array(page.buffer, page.byteOffset, PAGE_SIZE / 4);
    }

    getPages(vaddr, size) {
      const out = [];
      for (let i = 0; i < size; i += PAGE_SIZE) {
        const p = this.pages[(vaddr + i) >>> 12];
        if (p === null) throw new EmuError(`getPages: unmapped ${hex(vaddr + i)}`);
        out.push(p);
      }
      return out;
    }

    alloc(vaddr, size, perm = 3, state = 5, name = '') {
      const buf = new Uint8Array(size);
      this.map(vaddr, size, buf, 0, perm, state, name);
      return buf;
    }

    unmap(vaddr, size) {
      vaddr >>>= 0;
      for (let i = 0; i < size; i += PAGE_SIZE) this._setPage((vaddr + i) >>> 12, null);
      this._removeRange(vaddr, size);
    }

    isMapped(addr) { return this.pages[addr >>> 12] !== null; }

    _removeRange(base, size) {
      const end = base + size;
      const out = [];
      for (const r of this.regions) {
        const rEnd = r.base + r.size;
        if (rEnd <= base || r.base >= end) { out.push(r); continue; }
        if (r.base < base) out.push({ ...r, size: base - r.base });
        if (rEnd > end) out.push({ ...r, base: end, size: rEnd - end });
      }
      this.regions = out;
    }

    _addRegion(region) {
      this._removeRange(region.base, region.size);
      this.regions.push(region);
      this.regions.sort((a, b) => a.base - b.base);
    }

    // Returns the region containing addr, or a synthetic free region spanning the gap.
    query(addr) {
      addr >>>= 0;
      let prevEnd = 0;
      for (const r of this.regions) {
        if (addr >= r.base && addr < r.base + r.size) return r;
        if (r.base > addr) return { base: prevEnd, size: r.base - prevEnd, perm: 0, state: 0, name: 'free' };
        prevEnd = r.base + r.size;
      }
      return { base: prevEnd, size: 0x100000000 - prevEnd, perm: 0, state: 0, name: 'free' };
    }

    fault(addr, what) {
      throw new EmuError(`Memory fault: ${what} at unmapped address ${hex(addr)}`);
    }

    r8(a) {
      const p = this.pages[a >>> 12];
      if (p === null) this.fault(a, 'read8');
      return p[a & 0xFFF];
    }

    r16(a) {
      if ((a & 1) === 0) {
        const p = this.pages16[a >>> 12];
        if (p !== null) return p[(a & 0xFFF) >>> 1];
      }
      const o = a & 0xFFF;
      if (o < 0xFFF) {
        const p = this.pages[a >>> 12];
        if (p === null) this.fault(a, 'read16');
        return p[o] | (p[o + 1] << 8);
      }
      return this.r8(a) | (this.r8((a + 1) >>> 0) << 8);
    }

    r32(a) {
      if ((a & 3) === 0) {
        const p = this.pages32[a >>> 12];
        if (p !== null) return p[(a & 0xFFF) >>> 2];
      }
      const o = a & 0xFFF;
      if (o < 0xFFD) {
        const p = this.pages[a >>> 12];
        if (p === null) this.fault(a, 'read32');
        return (p[o] | (p[o + 1] << 8) | (p[o + 2] << 16) | (p[o + 3] << 24)) >>> 0;
      }
      return (this.r16(a) | (this.r16((a + 2) >>> 0) << 16)) >>> 0;
    }

    w8(a, v) {
      const p = this.pages[a >>> 12];
      if (p === null) this.fault(a, 'write8');
      p[a & 0xFFF] = v;
    }

    w16(a, v) {
      if ((a & 1) === 0) {
        const p = this.pages16[a >>> 12];
        if (p !== null) { p[(a & 0xFFF) >>> 1] = v; return; }
      }
      const o = a & 0xFFF;
      if (o < 0xFFF) {
        const p = this.pages[a >>> 12];
        if (p === null) this.fault(a, 'write16');
        p[o] = v; p[o + 1] = v >>> 8;
        return;
      }
      this.w8(a, v); this.w8((a + 1) >>> 0, v >>> 8);
    }

    w32(a, v) {
      if ((a & 3) === 0) {
        const p = this.pages32[a >>> 12];
        if (p !== null) { p[(a & 0xFFF) >>> 2] = v; return; }
      }
      const o = a & 0xFFF;
      if (o < 0xFFD) {
        const p = this.pages[a >>> 12];
        if (p === null) this.fault(a, 'write32');
        p[o] = v; p[o + 1] = v >>> 8; p[o + 2] = v >>> 16; p[o + 3] = v >>> 24;
        return;
      }
      this.w16(a, v); this.w16((a + 2) >>> 0, v >>> 16);
    }

    readBytes(addr, len) {
      const out = new Uint8Array(len);
      let done = 0;
      while (done < len) {
        const a = (addr + done) >>> 0;
        const p = this.pages[a >>> 12];
        if (p === null) this.fault(a, 'readBytes');
        const o = a & 0xFFF;
        const n = Math.min(PAGE_SIZE - o, len - done);
        out.set(p.subarray(o, o + n), done);
        done += n;
      }
      return out;
    }

    writeBytes(addr, data) {
      let done = 0;
      while (done < data.length) {
        const a = (addr + done) >>> 0;
        const p = this.pages[a >>> 12];
        if (p === null) this.fault(a, 'writeBytes');
        const o = a & 0xFFF;
        const n = Math.min(PAGE_SIZE - o, data.length - done);
        p.set(data.subarray(done, done + n), o);
        done += n;
      }
    }

    fill(addr, len, value) {
      for (let i = 0; i < len; i++) this.w8((addr + i) >>> 0, value);
    }

    readCString(addr, max = 256) {
      let s = '';
      for (let i = 0; i < max; i++) {
        const c = this.r8((addr + i) >>> 0);
        if (c === 0) break;
        s += String.fromCharCode(c);
      }
      return s;
    }
  }

  EMU.Memory = Memory;
})(typeof window !== 'undefined' ? (window.EMU = window.EMU || {}) : (globalThis.EMU = globalThis.EMU || {}));

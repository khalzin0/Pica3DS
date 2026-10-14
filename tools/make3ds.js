// Package a homebrew ELF into a decrypted (NoCrypto) .3ds / .cxi image.
//   node tools/make3ds.js app.elf out.3ds [--from3dsx=app.3dsx] [--compress] [--cxi]
// --from3dsx copies the RomFS and SMDH icon/title out of a .3dsx built from the same program.
'use strict';
const fs = require('fs');

const args = process.argv.slice(2);
const opt = (name) => { const a = args.find((x) => x.startsWith(`--${name}`)); return a ? (a.includes('=') ? a.split('=')[1] : true) : null; };
const [elfPath, outPath] = args.filter((a) => !a.startsWith('--'));
if (!elfPath || !outPath) { console.error('usage: node tools/make3ds.js app.elf out.3ds [--from3dsx=app.3dsx] [--compress] [--cxi]'); process.exit(1); }

const align = (v, a = 0x1000) => Math.ceil(v / a) * a;
const MEDIA = 0x200;

// ---- ELF segments -> text / rodata / data
const elf = fs.readFileSync(elfPath);
const phoff = elf.readUInt32LE(28), phent = elf.readUInt16LE(42), phnum = elf.readUInt16LE(44);
const segs = { text: null, ro: null, data: null };
for (let i = 0; i < phnum; i++) {
  const o = phoff + i * phent;
  if (elf.readUInt32LE(o) !== 1) continue;
  const s = { off: elf.readUInt32LE(o + 4), vaddr: elf.readUInt32LE(o + 8), filesz: elf.readUInt32LE(o + 16), memsz: elf.readUInt32LE(o + 20), flags: elf.readUInt32LE(o + 24) };
  if (!s.memsz) continue;
  segs[s.flags & 1 ? 'text' : s.flags & 2 ? 'data' : 'ro'] = s;
}
if (!segs.text) throw new Error('ELF has no executable segment');
const segBytes = (s) => (s ? elf.subarray(s.off, s.off + s.filesz) : Buffer.alloc(0));
const textB = segBytes(segs.text), roB = segBytes(segs.ro), dataB = segBytes(segs.data);
const bss = segs.data ? segs.data.memsz - segs.data.filesz : 0;
let code = Buffer.concat([textB, Buffer.alloc(align(textB.length) - textB.length), roB, Buffer.alloc(align(roB.length) - roB.length), dataB]);

// ---- optional extras from a .3dsx
let romfs = null, icon = null;
if (opt('from3dsx')) {
  const x = fs.readFileSync(opt('from3dsx'));
  if (x.readUInt16LE(4) > 0x20) {
    const smdhOff = x.readUInt32LE(0x20), smdhSize = x.readUInt32LE(0x24), romfsOff = x.readUInt32LE(0x28);
    if (smdhSize) icon = x.subarray(smdhOff, smdhOff + smdhSize);
    if (romfsOff) romfs = x.subarray(romfsOff);
  }
}

// ---- reverse LZSS ("BLZ") compressor: LZ over the reversed data, emitted back to front
function blzCompress(data) {
  const n = data.length;
  const X = Buffer.from(data).reverse();
  const stream = [];
  const head = new Map();
  const prev = new Int32Array(n).fill(-1);
  const key = (p) => X[p] | (X[p + 1] << 8) | (X[p + 2] << 16);
  let p = 0, ctrlPos = -1, bit = 8;
  const pushItem = (isRef, bytes) => {
    if (bit === 8) { ctrlPos = stream.length; stream.push(0); bit = 0; }
    if (isRef) stream[ctrlPos] |= 0x80 >> bit;
    bit++;
    stream.push(...bytes);
  };
  const insert = (q) => { if (q + 2 < n) { const k = key(q); prev[q] = head.has(k) ? head.get(k) : -1; head.set(k, q); } };
  while (p < n) {
    let bestLen = 0, bestDist = 0;
    if (p + 2 < n) {
      let cand = head.get(key(p)), tries = 64;
      while (cand !== undefined && cand >= 0 && tries-- > 0) {
        const d = p - cand;
        if (d > 0x1002) break;
        if (d >= 3) {
          let l = 0;
          while (l < 18 && p + l < n && X[cand + l] === X[p + l]) l++;
          if (l > bestLen) { bestLen = l; bestDist = d; if (l === 18) break; }
        }
        cand = prev[cand];
      }
    }
    if (bestLen >= 3) {
      const v = ((bestLen - 3) << 12) | (bestDist - 3);
      pushItem(true, [v >> 8, v & 0xFF]);
      for (let k = 0; k < bestLen; k++) insert(p + k);
      p += bestLen;
    } else {
      pushItem(false, [X[p]]);
      insert(p);
      p++;
    }
  }
  const body = Buffer.from(stream).reverse();
  const out = Buffer.alloc(body.length + 8);
  body.copy(out, 0);
  out.writeUInt32LE(((8 << 24) | out.length) >>> 0, body.length);
  out.writeUInt32LE(n - out.length, body.length + 4);
  return out;
}

let compressed = false;
if (opt('compress')) {
  const c = blzCompress(code);
  if (c.length < code.length) { code = c; compressed = true; }
}

// ---- ExeFS
const exefsFiles = [['.code', code]];
if (icon) exefsFiles.push(['icon', icon]);
let exefsBody = Buffer.alloc(0);
const exefsHdr = Buffer.alloc(0x200);
exefsFiles.forEach(([name, data], i) => {
  exefsHdr.write(name, i * 16, 'ascii');
  exefsHdr.writeUInt32LE(exefsBody.length, i * 16 + 8);
  exefsHdr.writeUInt32LE(data.length, i * 16 + 12);
  exefsBody = Buffer.concat([exefsBody, data, Buffer.alloc(align(data.length, 0x200) - data.length)]);
});
const exefs = Buffer.concat([exefsHdr, exefsBody]);

// ---- ExHeader
const ex = Buffer.alloc(0x800);
ex.write('HOMEBREW', 0, 'ascii');
ex[0xD] = compressed ? 1 : 0;
const writeSeg = (o, s, b) => { ex.writeUInt32LE(s ? s.vaddr : 0, o); ex.writeUInt32LE(align(b.length) / 0x1000, o + 4); ex.writeUInt32LE(b.length, o + 8); };
writeSeg(0x10, segs.text, textB);
ex.writeUInt32LE(0x40000, 0x1C); // stack size
writeSeg(0x20, segs.ro, roB);
writeSeg(0x30, segs.data, dataB);
ex.writeUInt32LE(bss, 0x3C);
ex.writeBigUInt64LE(0x000400000FF3D000n, 0x200); // program ID
ex[0x20F] = 0x30; // main thread priority

// ---- RomFS section: IVFC header page, then the level-3 image at +0x1000
const romfsSec = romfs ? Buffer.concat([Buffer.from('IVFC'), Buffer.alloc(0x1000 - 4), romfs]) : null;

// ---- NCCH
const hdr = Buffer.alloc(0x200);
let cursor = 0x200 + 0x800; // header + exheader(+access desc)
const exefsOff = align(cursor, MEDIA); cursor = exefsOff + exefs.length;
const romfsOff = romfsSec ? align(cursor, 0x1000) : 0; if (romfsSec) cursor = romfsOff + romfsSec.length;
const total = align(cursor, MEDIA);
hdr.write('NCCH', 0x100, 'ascii');
hdr.writeUInt32LE(total / MEDIA, 0x104);
hdr.writeBigUInt64LE(0x000400000FF3D000n, 0x108);
hdr.writeUInt16LE(2, 0x112); // NCCH version
hdr.writeBigUInt64LE(0x000400000FF3D000n, 0x118);
hdr.write('CTR-P-HBRW', 0x150, 'ascii');
hdr.writeUInt32LE(0x400, 0x180);
hdr[0x188 + 4] = 1;                    // platform: CTR
hdr[0x188 + 5] = 0x3;                  // content: data + executable
hdr[0x188 + 7] = 0x4 | (romfsSec ? 0 : 0x2); // NoCrypto (+ NoRomFs)
hdr.writeUInt32LE(exefsOff / MEDIA, 0x1A0); hdr.writeUInt32LE(exefs.length / MEDIA, 0x1A4);
if (romfsSec) { hdr.writeUInt32LE(romfsOff / MEDIA, 0x1B0); hdr.writeUInt32LE(align(romfsSec.length, MEDIA) / MEDIA, 0x1B4); }
const ncch = Buffer.alloc(total);
hdr.copy(ncch, 0); ex.copy(ncch, 0x200); exefs.copy(ncch, exefsOff); if (romfsSec) romfsSec.copy(ncch, romfsOff);

let out = ncch;
if (!opt('cxi')) { // wrap in an NCSD (.3ds cartridge image) with the NCCH as partition 0
  const ncsdHdr = Buffer.alloc(0x4000);
  ncsdHdr.write('NCSD', 0x100, 'ascii');
  ncsdHdr.writeUInt32LE((0x4000 + total) / MEDIA, 0x104);
  ncsdHdr.writeBigUInt64LE(0x000400000FF3D000n, 0x108);
  ncsdHdr.writeUInt32LE(0x4000 / MEDIA, 0x120);
  ncsdHdr.writeUInt32LE(total / MEDIA, 0x124);
  out = Buffer.concat([ncsdHdr, ncch]);
}
fs.writeFileSync(outPath, out);
console.log(`wrote ${outPath}: ${(out.length / 1024).toFixed(0)} KB, code ${compressed ? 'compressed' : 'raw'} ${code.length} bytes${romfs ? `, RomFS ${romfs.length} bytes` : ''}${icon ? ', icon' : ''}`);

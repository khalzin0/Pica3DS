// Built-in stand-ins for system data archives that games read but that are not dumped yet.
// They let games get past their startup checks; they do not contain Nintendo's data.
(function (EMU) {
  'use strict';

  // Build a level-3 RomFS image from { 'dir/name.ext': Uint8Array }.
  function buildRomfs(files) {
    const dirs = [{ path: '', name: '', parent: 0, dirs: [], files: [] }];
    const dirIndex = new Map([['', 0]]);
    const dirOf = (path) => {
      if (dirIndex.has(path)) return dirIndex.get(path);
      const cut = path.lastIndexOf('/');
      const parent = dirOf(cut < 0 ? '' : path.slice(0, cut));
      const d = { path, name: path.slice(cut + 1), parent, dirs: [], files: [] };
      dirs.push(d);
      dirIndex.set(path, dirs.length - 1);
      dirs[parent].dirs.push(dirs.length - 1);
      return dirs.length - 1;
    };
    const fileList = Object.keys(files).sort().map((p) => {
      const cut = p.lastIndexOf('/');
      const f = { name: p.slice(cut + 1), parent: dirOf(cut < 0 ? '' : p.slice(0, cut)), data: files[p] };
      return f;
    });
    fileList.forEach((f, i) => dirs[f.parent].files.push(i));

    const metaSize = (name) => 0x18 + ((name.length * 2 + 3) & ~3);
    const fileMetaSize = (name) => 0x20 + ((name.length * 2 + 3) & ~3);
    // Metadata offsets
    let off = 0;
    for (const d of dirs) { d.off = off; off += metaSize(d.name); }
    const dirMetaLen = off;
    off = 0;
    for (const f of fileList) { f.off = off; off += fileMetaSize(f.name); }
    const fileMetaLen = off;
    let dataLen = 0;
    for (const f of fileList) { f.dataOff = dataLen; dataLen = (dataLen + f.data.length + 15) & ~15; }

    const buckets = (n) => (n < 3 ? 3 : n < 19 ? n | 1 : n | 1);
    const dirBuckets = buckets(dirs.length), fileBuckets = buckets(fileList.length);
    const hash = (parent, name) => {
      let h = (parent ^ 123456789) >>> 0;
      for (let i = 0; i < name.length; i++) { h = ((h >>> 5) | (h << 27)) >>> 0; h = (h ^ name.charCodeAt(i)) >>> 0; }
      return h;
    };

    const header = 0x28;
    const dirHashOff = header, dirMetaOff = dirHashOff + dirBuckets * 4;
    const fileHashOff = dirMetaOff + dirMetaLen, fileMetaOff = fileHashOff + fileBuckets * 4;
    const dataOff = (fileMetaOff + fileMetaLen + 15) & ~15;
    const out = new Uint8Array(dataOff + dataLen);
    const dv = new DataView(out.buffer);
    [header, dirHashOff, dirBuckets * 4, dirMetaOff, dirMetaLen, fileHashOff, fileBuckets * 4, fileMetaOff, fileMetaLen, dataOff]
      .forEach((v, i) => dv.setUint32(i * 4, v, true));

    const NONE = 0xFFFFFFFF;
    const dirHash = new Array(dirBuckets).fill(NONE), fileHash = new Array(fileBuckets).fill(NONE);
    const writeName = (o, name) => { for (let i = 0; i < name.length; i++) dv.setUint16(o + i * 2, name.charCodeAt(i), true); };

    dirs.forEach((d) => {
      const o = dirMetaOff + d.off;
      const siblings = dirs[d.parent].dirs, si = siblings.indexOf(dirs.indexOf(d));
      const b = hash(dirs[d.parent].off, d.name) % dirBuckets;
      dv.setUint32(o, dirs[d.parent].off, true);
      dv.setUint32(o + 4, d.path && si + 1 < siblings.length ? dirs[siblings[si + 1]].off : NONE, true);
      dv.setUint32(o + 8, d.dirs.length ? dirs[d.dirs[0]].off : NONE, true);
      dv.setUint32(o + 12, d.files.length ? fileList[d.files[0]].off : NONE, true);
      dv.setUint32(o + 16, dirHash[b], true);
      dv.setUint32(o + 20, d.name.length * 2, true);
      writeName(o + 24, d.name);
      dirHash[b] = d.off;
    });
    fileList.forEach((f) => {
      const o = fileMetaOff + f.off;
      const siblings = dirs[f.parent].files, si = siblings.indexOf(fileList.indexOf(f));
      const b = hash(dirs[f.parent].off, f.name) % fileBuckets;
      dv.setUint32(o, dirs[f.parent].off, true);
      dv.setUint32(o + 4, si + 1 < siblings.length ? fileList[siblings[si + 1]].off : NONE, true);
      dv.setBigUint64(o + 8, BigInt(f.dataOff), true);
      dv.setBigUint64(o + 16, BigInt(f.data.length), true);
      dv.setUint32(o + 24, fileHash[b], true);
      dv.setUint32(o + 28, f.name.length * 2, true);
      writeName(o + 32, f.name);
      fileHash[b] = f.off;
      out.set(f.data, dataOff + f.dataOff);
    });
    dirHash.forEach((v, i) => dv.setUint32(dirHashOff + i * 4, v, true));
    fileHash.forEach((v, i) => dv.setUint32(fileHashOff + i * 4, v, true));
    return out;
  }

  // Read the file list of a level-3 RomFS image: [{ path, offset, size }]
  function listRomfs(img) {
    const dv = new DataView(img.buffer, img.byteOffset, img.byteLength);
    const u32 = (o) => dv.getUint32(o, true);
    const dirMeta = u32(12), fileMeta = u32(28), dataOff = u32(36);
    const name = (o, len) => { let s = ''; for (let i = 0; i < len; i += 2) s += String.fromCharCode(dv.getUint16(o + i, true)); return s; };
    const out = [];
    const walk = (dirOff, prefix) => {
      const d = dirMeta + dirOff;
      for (let f = u32(d + 12); f !== 0xFFFFFFFF; f = u32(fileMeta + f + 4)) {
        const e = fileMeta + f;
        out.push({ path: prefix + name(e + 32, u32(e + 28)), offset: dataOff + Number(dv.getBigUint64(e + 8, true)), size: Number(dv.getBigUint64(e + 16, true)) });
      }
      for (let c = u32(d + 8); c !== 0xFFFFFFFF; c = u32(dirMeta + c + 4)) walk(c, prefix + name(dirMeta + c + 24, u32(dirMeta + c + 20)) + '/');
    };
    walk(0, '');
    return out;
  }

  // ------------------------------------------------------------------ stand-in system font
  // 5x8 pixel glyphs (rows top to bottom, bit 4 = leftmost pixel) for ASCII 0x20-0x7E.
  const GLYPHS_5X8 = [
    '0000000000000000', '0404040404000400', '0A0A0A0000000000', '0A0A1F0A1F0A0A00', '040F140E051E0400', '1819020408130300',
    '0C1214081512 0D00', '0C04080000000000', '0204080808040200', '0804020202040800', '0004150E15040000', '0004041F04040000',
    '000000000C040800', '0000001F00000000', '0000000000 0C0C00', '0001020408100000', '0E1113151911 0E00', '040C040404040E00',
    '0E1101020408 1F00', '1F02040201110E00', '02060A121F020200', '1F101E0101110E00', '0608101E11110E00', '1F01020408080800',
    '0E11110E11110E00', '0E11110F01020C00', '000C0C000C0C0000', '000C0C000C040800', '0204081008040200', '00001F001F000000',
    '0804020102040800', '0E11010204000400', '0E11010D15150E00', '0E1111111F111100', '1E11111E11111E00', '0E11101010110E00',
    '1C12111111121C00', '1F10101E10101F00', '1F10101E10101000', '0E1110171111 0F00', '1111111F11111100', '0E04040404040E00',
    '0702020202120C00', '1112141814121100', '1010101010101F00', '111B151511111100', '1111191513111100', '0E11111111110E00',
    '1E11111E10101000', '0E11111115120D00', '1E11111E14121100', '0F10100E01011E00', '1F04040404040400', '1111111111110E00',
    '11111111110A0400', '1111111515150A00', '11110A040A111100', '1111110A04040400', '1F01020408101F00', '0E08080808080E00',
    '0010080402010000', '0E02020202020E00', '040A110000000000', '0000000000001F00', '0804020000000000', '00000E010F110F00',
    '1010161911111E00', '00000E1010110E00', '01010D1311110F00', '00000E111F100E00', '0609081C08080800', '00000F11110F010E',
    '1010161911111100', '04000C0404040E00', '0200060202 02120C', '1010121418141200', '0C04040404040E00', '00001A1515111100',
    '0000161911111100', '00000E1111110E00', '00001E11111E1010', '00000F11110F0101', '0000161910101000', '00000E100E011E00',
    '08081C0808090600', '0000111111130D00', '00001111110A0400', '0000111115150A00', '0000110A040A1100', '000011111 10F010E',
    '00001F0204081F00', '0204040804040200', '0404040404040400', '0804040204040800', '000008150200 0000',
  ].map((s) => s.replace(/ /g, ''));

  // Extra characters: [code, glyph rows] or [code, ASCII character to reuse]
  const EXTRA_GLYPHS = [
    [0xA0, ' '], [0xA9, '0E111719 17110E00'], [0xAE, '0E111D1B1D110E00'], [0x2122, '1D0B0B0000000000'],
    [0x2018, "'"], [0x2019, "'"], [0x201C, '"'], [0x201D, '"'], [0x2013, '-'], [0x2014, '-'], [0x2026, '0000000000001500'],
    [0x2022, '00000E0E0E000000'], [0xB0, '0C12120C00000000'], [0xD7, '00110A040A110000'], [0xA1, '0400040404040400'],
    [0xBF, '040004081011 0E00'], [0xAB, '00050A140A050000'], [0xBB, '00140A050A140000'],
    // 3DS button icons (private use area): A, B, X, Y, L, R, D-pad as inverted letters
    [0xE000, '~A'], [0xE001, '~B'], [0xE002, '~X'], [0xE003, '~Y'], [0xE004, '~L'], [0xE005, '~R'], [0xE006, '~+'],
  ];

  // Build a BCFNT font whose internal pointers assume it is loaded at `base`. relocated: 'CFNU' header as in
  // the system's shared font; otherwise 'CFNT' as in a font file (use base 0, pointers relative to the file).
  function buildStandinFont(base, relocated = true) {
    const glyphs = []; // rows (8 numbers) per glyph index
    const rowsOf = (hex) => hex.replace(/ /g, '').match(/../g).map((h) => parseInt(h, 16));
    GLYPHS_5X8.forEach((g) => glyphs.push(rowsOf(g)));
    const ascii = (ch) => ch.charCodeAt(0) - 0x20;
    const map = []; // [code, glyph index] beyond ASCII
    for (const [code, g] of EXTRA_GLYPHS) {
      if (g.length === 1) map.push([code, ascii(g)]);
      else if (g[0] === '~') { glyphs.push(glyphs[ascii(g[1])].map((r, i) => (i < 7 ? r ^ 0x1F : 0))); map.push([code, glyphs.length - 1]); }
      else { glyphs.push(rowsOf(g)); map.push([code, glyphs.length - 1]); }
    }
    // Accented Latin letters use their base letter
    for (let code = 0xC0; code <= 0x17F; code++) {
      const base0 = String.fromCharCode(code).normalize('NFD')[0];
      if (base0 !== String.fromCharCode(code) && base0 >= 'A' && base0 <= 'z') map.push([code, ascii(base0)]);
    }
    map.sort((a, b) => a[0] - b[0]);
    const unique = map.filter((m, i) => i === 0 || m[0] !== map[i - 1][0]);

    // Metrics: glyphs drawn at 2x into 12x18 cells, baseline at row 15
    const SCALE = 2, CW = 12, CH = 18, BASE = 15, SW = 256, SH = 256;
    const cols = Math.floor(SW / (CW + 1)), lines = Math.floor(SH / (CH + 1));
    if (glyphs.length > cols * lines) throw new Error('stand-in font sheet too small');
    const sheet = new Uint8Array((SW * SH) / 2); // A4, tiled
    const plot = (x, y) => {
      let m = 0;
      for (let i = 0; i < 3; i++) m |= (((x >> i) & 1) << (2 * i)) | (((y >> i) & 1) << (2 * i + 1));
      const idx = ((y >> 3) * (SW >> 3) + (x >> 3)) * 64 + m;
      sheet[idx >> 1] |= idx & 1 ? 0xF0 : 0x0F;
    };
    glyphs.forEach((rows, gi) => {
      const x0 = (gi % cols) * (CW + 1) + 1, y0 = Math.floor(gi / cols) * (CH + 1) + 1 + 1;
      rows.forEach((bits, r) => {
        for (let c = 0; c < 5; c++) {
          if (!(bits & (0x10 >> c))) continue;
          for (let dy = 0; dy < SCALE; dy++) for (let dx = 0; dx < SCALE; dx++) plot(x0 + c * SCALE + dx, y0 + r * SCALE + dy);
        }
      });
    });

    // Layout: header, FINF, TGLP, CWDH, CMAP (direct ASCII), CMAP (scan extras), sheet
    const align4 = (n) => (n + 3) & ~3;
    const offFINF = 0x14, offTGLP = offFINF + 0x20, offCWDH = offTGLP + 0x20;
    const cwdhSize = align4(0x10 + glyphs.length * 3);
    const offCMAP1 = offCWDH + cwdhSize, cmap1Size = 0x14 + 4;
    const offCMAP2 = offCMAP1 + cmap1Size, cmap2Size = align4(0x14 + 2 + unique.length * 4);
    const offSheet = (offCMAP2 + cmap2Size + 0x7F) & ~0x7F;
    const total = offSheet + sheet.length;
    const out = new Uint8Array(total), dv = new DataView(out.buffer);
    const tag = (o, s) => { for (let i = 0; i < 4; i++) out[o + i] = s.charCodeAt(i); };
    const ptr = (o) => (base + o) >>> 0;

    // 'CFNU': pointers are already absolute (relocated); 'CFNT': relative to the file
    tag(0, relocated ? 'CFNU' : 'CFNT'); dv.setUint16(4, 0xFEFF, true); dv.setUint16(6, 0x14, true);
    dv.setUint32(8, 0x03000000, true); dv.setUint32(12, total, true); dv.setUint32(16, 5, true);

    tag(offFINF, 'FINF'); dv.setUint32(offFINF + 4, 0x20, true);
    out[offFINF + 8] = 1; out[offFINF + 9] = CH + 2;                 // font type, line feed
    dv.setUint16(offFINF + 10, ascii('?'), true);                    // replacement glyph
    out[offFINF + 12] = 1; out[offFINF + 13] = 5 * SCALE; out[offFINF + 14] = CW; // default widths
    out[offFINF + 15] = 1;                                           // UTF-16
    dv.setUint32(offFINF + 16, ptr(offTGLP + 8), true);
    dv.setUint32(offFINF + 20, ptr(offCWDH + 8), true);
    dv.setUint32(offFINF + 24, ptr(offCMAP1 + 8), true);
    out[offFINF + 28] = CH; out[offFINF + 29] = CW; out[offFINF + 30] = BASE;

    tag(offTGLP, 'TGLP'); dv.setUint32(offTGLP + 4, 0x20, true);
    out[offTGLP + 8] = CW; out[offTGLP + 9] = CH; out[offTGLP + 10] = BASE; out[offTGLP + 11] = CW;
    dv.setUint32(offTGLP + 12, sheet.length, true);
    dv.setUint16(offTGLP + 16, 1, true); dv.setUint16(offTGLP + 18, 0xB, true); // 1 sheet, A4
    dv.setUint16(offTGLP + 20, cols, true); dv.setUint16(offTGLP + 22, lines, true);
    dv.setUint16(offTGLP + 24, SW, true); dv.setUint16(offTGLP + 26, SH, true);
    dv.setUint32(offTGLP + 28, ptr(offSheet), true);

    tag(offCWDH, 'CWDH'); dv.setUint32(offCWDH + 4, cwdhSize, true);
    dv.setUint16(offCWDH + 8, 0, true); dv.setUint16(offCWDH + 10, glyphs.length - 1, true); dv.setUint32(offCWDH + 12, 0, true);
    glyphs.forEach((g, i) => { const o = offCWDH + 16 + i * 3; out[o] = 1; out[o + 1] = 5 * SCALE; out[o + 2] = CW; });

    tag(offCMAP1, 'CMAP'); dv.setUint32(offCMAP1 + 4, cmap1Size, true);
    dv.setUint16(offCMAP1 + 8, 0x20, true); dv.setUint16(offCMAP1 + 10, 0x7E, true); dv.setUint16(offCMAP1 + 12, 0, true); // direct
    dv.setUint32(offCMAP1 + 16, ptr(offCMAP2 + 8), true);
    dv.setUint16(offCMAP1 + 20, 0, true);

    tag(offCMAP2, 'CMAP'); dv.setUint32(offCMAP2 + 4, cmap2Size, true);
    dv.setUint16(offCMAP2 + 8, 0, true); dv.setUint16(offCMAP2 + 10, 0xFFFF, true); dv.setUint16(offCMAP2 + 12, 2, true); // scan
    dv.setUint32(offCMAP2 + 16, 0, true);
    dv.setUint16(offCMAP2 + 20, unique.length, true);
    unique.forEach(([code, gi], i) => { dv.setUint16(offCMAP2 + 22 + i * 4, code, true); dv.setUint16(offCMAP2 + 24 + i * 4, gi, true); });

    out.set(sheet, offSheet);
    return out;
  }

  EMU.buildRomfs = buildRomfs;
  EMU.listRomfs = listRomfs;
  EMU.buildStandinFont = buildStandinFont;

  // LZ11 container with every byte stored as a literal (valid input for the system's LZ11 decompressor)
  function lz11Literal(data) {
    const n = data.length, out = new Uint8Array(4 + n + Math.ceil(n / 8));
    out[0] = 0x11; out[1] = n & 0xFF; out[2] = (n >>> 8) & 0xFF; out[3] = (n >>> 16) & 0xFF;
    let o = 4;
    for (let i = 0; i < n; i += 8) {
      out[o++] = 0; // flags: next 8 bytes are literals
      for (let k = i; k < Math.min(n, i + 8); k++) out[o++] = data[k];
    }
    return out.subarray(0, o);
  }

  // UTF-16LE text with a byte order mark
  function utf16(text) {
    const out = new Uint8Array(2 + text.length * 2);
    out[0] = 0xFF; out[1] = 0xFE;
    for (let i = 0; i < text.length; i++) { out[2 + i * 2] = text.charCodeAt(i) & 0xFF; out[3 + i * 2] = text.charCodeAt(i) >>> 8; }
    return out;
  }

  // Bad word list: 17 pattern lists (one per language/region slot) and a version number. Each list holds one
  // pattern that no typed text can match, so nothing is filtered.
  function buildNgWordList() {
    const files = { 'version.dat': Uint8Array.of(0x12, 0, 0, 0) };
    const never = '^' + String.fromCharCode(0xFFFF) + '-never-matches$' + String.fromCharCode(10);
    for (let i = 0; i <= 16; i++) files[`${i}.txt`] = utf16(never);
    return buildRomfs(files);
  }

  const fontArchive = (name) => () => buildRomfs({ [name]: lz11Literal(buildStandinFont(0, false)) });

  // Stand-in archives by title ID. Each returns a RomFS image.
  EMU.STANDIN_ARCHIVES = {
    // Mii data: games check that CFL_Res.dat exists and read its header. The stand-in has no Mii models,
    // so a game that actually draws Miis will not show them correctly.
    '0004009b00010202': () => buildRomfs({ 'CFL_Res.dat': new Uint8Array(0x1000) }),
    // Shared fonts opened as archives (most games get the font from APT instead): the stand-in font
    '0004009b00014002': fontArchive('cbf_std.bcfnt.lz'),
    '0004009b00014102': fontArchive('cbf_zh-Hans-CN.bcfnt.lz'),
    '0004009b00014202': fontArchive('cbf_ko-Hang-KR.bcfnt.lz'),
    '0004009b00014302': fontArchive('cbf_zh-Hant-TW.bcfnt.lz'),
    '000400db00010302': buildNgWordList,
  };

  // Any other system data archive: an empty one, so games that only check for it carry on. A game that reads a
  // file from it gets "not found".
  EMU.buildEmptyArchive = () => buildRomfs({});

  // LZ11 decompression (type 0x11 header: 24-bit size, or 0 followed by a 32-bit size)
  function lz11Decompress(src) {
    let n = src[1] | (src[2] << 8) | (src[3] << 16), i = 4;
    if (!n) { n = (src[4] | (src[5] << 8) | (src[6] << 16) | (src[7] << 24)) >>> 0; i = 8; }
    const out = new Uint8Array(n);
    let o = 0;
    while (o < n && i < src.length) {
      const flags = src[i++];
      for (let bit = 7; bit >= 0 && o < n; bit--) {
        if (!(flags & (1 << bit))) { out[o++] = src[i++]; continue; }
        const b0 = src[i++];
        let len, disp;
        switch (b0 >>> 4) {
          case 0: { const b1 = src[i++], b2 = src[i++]; len = (((b0 & 0xF) << 4) | (b1 >>> 4)) + 0x11; disp = (((b1 & 0xF) << 8) | b2) + 1; break; }
          case 1: { const b1 = src[i++], b2 = src[i++], b3 = src[i++]; len = (((b0 & 0xF) << 12) | (b1 << 4) | (b2 >>> 4)) + 0x111; disp = (((b2 & 0xF) << 8) | b3) + 1; break; }
          default: { const b1 = src[i++]; len = (b0 >>> 4) + 1; disp = (((b0 & 0xF) << 8) | b1) + 1; }
        }
        for (let k = 0; k < len && o < n; k++, o++) out[o] = out[o - disp];
      }
    }
    return out;
  }
  EMU.lz11Decompress = lz11Decompress;

  // The real system font from the user's shared font archive, ready to be placed at address base: the BCFNT's
  // section pointers become addresses (base + file offset) and the magic becomes "CFNU", as the system does when it
  // loads the font. Null when the archive has no font.
  EMU.loadSystemFont = function (romfs, base) {
    const f = listRomfs(romfs).find((e) => /\.bcfnt(\.lz)?$/.test(e.path));
    if (!f) return null;
    let font = romfs.slice(f.offset, f.offset + f.size);
    if (font[0] === 0x11) font = lz11Decompress(font);
    const ascii = (o) => String.fromCharCode(font[o], font[o + 1], font[o + 2], font[o + 3]);
    if (ascii(0) !== 'CFNT' && ascii(0) !== 'CFNU') return null;
    const dv = new DataView(font.buffer, font.byteOffset, font.byteLength);
    // Where the pointers point now: TGLP's pointer in FINF minus TGLP's real position (+8 past its header)
    const finf = dv.getUint16(6, true);
    let tglp = -1;
    for (let o = finf; o + 4 <= font.length; o += 4) if (ascii(o) === 'TGLP') { tglp = o; break; }
    if (ascii(finf) !== 'FINF' || tglp < 0) return null;
    const delta = (base - (dv.getUint32(finf + 0x10, true) - (tglp + 8))) >>> 0;
    const fix = (o) => { const v = dv.getUint32(o, true); if (v) dv.setUint32(o, (v + delta) >>> 0, true); };
    const off = (p) => ((p - base) >>> 0); // address -> file offset (after fixing)
    fix(finf + 0x10); fix(finf + 0x14); fix(finf + 0x18);
    fix(tglp + 0x1C); // sheet data
    for (let p = dv.getUint32(finf + 0x14, true); p; ) { const o = off(p) - 8; fix(o + 0x0C); p = dv.getUint32(o + 0x0C, true); } // CWDH chain
    for (let p = dv.getUint32(finf + 0x18, true); p; ) { const o = off(p) - 8; fix(o + 0x10); p = dv.getUint32(o + 0x10, true); } // CMAP chain
    font.set([0x43, 0x46, 0x4E, 0x55]); // "CFNU"
    return font;
  };

  // Stand-in SMDH (a title's icon and names, the ExeFS "icon" file) for titles that are not added: the HOME Menu
  // reads these for the system applications it shows. Names for known system titles (any region), else the ID.
  const SYSTEM_APP_NAMES = { 0x00020000: 'System Settings', 0x00020700: 'Mii Maker' };
  EMU.buildStandinSmdh = function (titleId) {
    const smdh = new Uint8Array(0x36C0), dv = new DataView(smdh.buffer);
    smdh.set([0x53, 0x4D, 0x44, 0x48]); // "SMDH"
    const low = parseInt(titleId.slice(8), 16);
    const name = SYSTEM_APP_NAMES[(low & ~0xF000) >>> 0] || `Title ${titleId.toUpperCase()}`;
    const put = (off, max, s) => { for (let i = 0; i < Math.min(s.length, max / 2 - 1); i++) dv.setUint16(off + i * 2, s.charCodeAt(i), true); };
    for (let lang = 0; lang < 16; lang++) { // short name, long name, publisher
      const t = 0x8 + lang * 0x200;
      put(t, 0x80, name); put(t + 0x80, 0x100, name); put(t + 0x180, 0x80, 'Nintendo');
    }
    dv.setUint32(0x2018, 0x7FFFFFFF, true); // region lock: all regions
    for (let o = 0x2040; o < 0x36C0; o += 2) dv.setUint16(o, 0x7BEF, true); // icons: plain grey (RGB565)
    return smdh;
  };
  EMU.lz11Literal = lz11Literal;
})(typeof window !== 'undefined' ? window.EMU : globalThis.EMU);

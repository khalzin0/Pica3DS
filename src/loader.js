// Loaders for homebrew executables: .3dsx (with relocations) and ARM ELF.
(function (EMU) {
  'use strict';

  const BASE = 0x00100000;
  const align = (v) => (v + 0xFFF) & ~0xFFF;

  function load3dsx(mem, bytes) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const u16 = (o) => dv.getUint16(o, true), u32 = (o) => dv.getUint32(o, true);
    if (u32(0) !== 0x58534433) throw new EMU.EmuError('Not a 3DSX file (bad magic)');
    const headerSize = u16(4), relocHdrSize = u16(6);
    const codeSize = u32(0x10), rodataSize = u32(0x14), dataSize = u32(0x18), bssSize = u32(0x1C);
    const segSizes = [align(codeSize), align(rodataSize), align(dataSize)];
    const total = segSizes[0] + segSizes[1] + segSizes[2];
    const image = new Uint8Array(total);
    const segOff = [0, segSizes[0], segSizes[0] + segSizes[1]];
    const nTables = relocHdrSize / 4;

    let pos = headerSize;
    const relocs = [];
    for (let s = 0; s < 3; s++) {
      const t = [];
      for (let i = 0; i < nTables; i++) t.push(u32(pos + i * 4));
      relocs.push(t);
      pos += relocHdrSize;
    }
    image.set(bytes.subarray(pos, pos + codeSize), segOff[0]); pos += codeSize;
    image.set(bytes.subarray(pos, pos + rodataSize), segOff[1]); pos += rodataSize;
    image.set(bytes.subarray(pos, pos + dataSize - bssSize), segOff[2]); pos += dataSize - bssSize;

    const idv = new DataView(image.buffer);
    const offsets = [segSizes[0], segSizes[0] + segSizes[1]];
    const translate = (a) => (a < offsets[0] ? BASE + a : a < offsets[1] ? BASE + segSizes[0] + a - offsets[0] : BASE + segSizes[0] + segSizes[1] + a - offsets[1]);

    for (let s = 0; s < 3; s++) {
      const end = segOff[s] + segSizes[s];
      for (let tbl = 0; tbl < nTables; tbl++) {
        const n = relocs[s][tbl];
        if (tbl >= 2) { pos += n * 4; continue; }
        let p = segOff[s]; // each table walks the segment from its start
        for (let i = 0; i < n; i++) {
          const skip = u16(pos), patch = u16(pos + 2);
          pos += 4;
          p += skip * 4;
          for (let j = 0; j < patch && p < end; j++, p += 4) {
            const orig = idv.getUint32(p, true);
            const subType = orig >>> 28;
            const addr = translate(orig & 0x0FFFFFFF);
            if (tbl === 0) idv.setUint32(p, addr >>> 0, true);
            else {
              const rel = (addr - (BASE + p)) >>> 0;
              idv.setUint32(p, subType === 1 ? rel & 0x7FFFFFFF : rel, true);
            }
          }
        }
      }
    }

    mem.map(BASE, segSizes[0], image, 0, 5, 3, 'code');
    if (segSizes[1]) mem.map(BASE + segSizes[0], segSizes[1], image, segOff[1], 1, 3, 'rodata');
    if (segSizes[2]) mem.map(BASE + segSizes[0] + segSizes[1], segSizes[2], image, segOff[2], 3, 3, 'data');

    // Extended header: embedded SMDH (icon/title) and RomFS (level-3 image).
    let romfs = null, title = null;
    if (headerSize > 0x20) {
      const smdhOff = u32(0x20), smdhSize = u32(0x24), romfsOff = u32(0x28);
      if (smdhSize) title = smdhTitle(bytes.subarray(smdhOff, smdhOff + smdhSize));
      if (romfsOff && romfsOff < bytes.length) romfs = bytes.subarray(romfsOff);
    }
    return { entry: BASE, size: total, format: '3DSX', romfs, title };
  }

  // English short title from an SMDH icon file.
  function smdhTitle(smdh) {
    if (smdh.length < 0x288 || String.fromCharCode(...smdh.subarray(0, 4)) !== 'SMDH') return null;
    const dv = new DataView(smdh.buffer, smdh.byteOffset, smdh.byteLength);
    let s = '';
    for (let o = 0x208; o < 0x288; o += 2) { const c = dv.getUint16(o, true); if (!c) break; s += String.fromCharCode(c); }
    return s || null;
  }

  // Console region a title is made for (0 JPN, 1 USA, 2 EUR, 4 CHN, 5 KOR, 6 TWN), from its SMDH region lockout;
  // null for titles sold in several of them
  function smdhRegion(smdh) {
    if (!smdh || smdh.length < 0x2020 || String.fromCharCode(...smdh.subarray(0, 4)) !== 'SMDH') return null;
    const lock = new DataView(smdh.buffer, smdh.byteOffset, smdh.byteLength).getUint32(0x2018, true) & 0x7F;
    const regions = [[1, 0], [2, 1], [4 | 8, 2], [0x10, 4], [0x20, 5], [0x40, 6]].filter(([bits]) => lock & bits);
    return regions.length === 1 ? regions[0][1] : null;
  }

  // Reverse LZSS ("BLZ") used for compressed ExeFS .code sections.
  function blzDecompress(c) {
    const dv = new DataView(c.buffer, c.byteOffset, c.byteLength);
    const n = c.length;
    const topBottom = dv.getUint32(n - 8, true), extra = dv.getUint32(n - 4, true);
    const outSize = n + extra;
    const out = new Uint8Array(outSize);
    out.set(c);
    let index = n - (topBottom >>> 24);
    const stop = n - (topBottom & 0xFFFFFF);
    let o = outSize;
    while (index > stop) {
      let control = c[--index];
      for (let i = 0; i < 8 && index > stop && o > 0; i++, control <<= 1) {
        if (control & 0x80) {
          index -= 2;
          const v = c[index] | (c[index + 1] << 8);
          const len = ((v >>> 12) & 15) + 3, disp = (v & 0xFFF) + 2;
          if (o < len || o + disp >= outSize) throw new EMU.EmuError('Corrupt compressed .code section');
          for (let j = 0; j < len; j++) { const b = out[o + disp]; out[--o] = b; }
        } else {
          out[--o] = c[--index];
        }
      }
    }
    return out;
  }
  EMU.blzDecompress = blzDecompress;

  // True when an NCCH's ExeFS header and extended header read as plain data (encrypted ones look random)
  function looksDecrypted(bytes, exefs) {
    if (!exefs || exefs + 0x200 > bytes.length) return false;
    let names = 0;
    for (let i = 0; i < 10; i++) {
      const e = exefs + i * 16;
      if (bytes[e] === 0) continue;
      for (let j = 0; j < 8; j++) { const ch = bytes[e + j]; if (ch !== 0 && (ch < 0x20 || ch > 0x7E)) return false; }
      names++;
    }
    if (!names) return false;
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const textAddr = dv.getUint32(0x210, true), stack = dv.getUint32(0x21C, true);
    return textAddr >= 0x100000 && textAddr < 0x10000000 && (textAddr & 0xFFF) === 0 && stack < 0x4000000;
  }

  // NCCH (CXI) executable partition, as found inside .3ds/.cci images or as a bare .cxi.
  function loadNcch(mem, bytes, mediaUnit = 0x200) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const u32 = (o) => dv.getUint32(o, true);
    const ascii = (o, n) => String.fromCharCode(...bytes.subarray(o, o + n)).replace(/\0.*$/, '');
    if (ascii(0x100, 4) !== 'NCCH') throw new EMU.EmuError('Bad NCCH header');
    const flags = bytes.subarray(0x188, 0x190);
    if (!(flags[5] & 2)) throw new EMU.EmuError('This NCCH partition has no executable code (it is a data-only archive).');
    if (u32(0x180) < 0x400) throw new EMU.EmuError('NCCH has no extended header');
    // Decrypted or not is judged by the contents: some decryption tools leave the "no crypto" flag unset. Plain
    // contents have readable ExeFS file names (".code", "icon", ...) and a sane code layout in the extended header.
    const plain = looksDecrypted(bytes, u32(0x1A0) * mediaUnit);
    if (!plain) {
      throw new EMU.EmuError('This .3ds/.cxi is encrypted. Only decrypted images are supported. Decrypt your own dump on your 3DS first (e.g. GodMode9: "Decrypt file").');
    }
    const flagMismatch = !(flags[7] & 4);

    // Extended header: code set layout, stack size, main thread priority.
    const ex = 0x200;
    const seg = (o) => ({ addr: u32(ex + o), pages: u32(ex + o + 4), size: u32(ex + o + 8) });
    const text = seg(0x10), ro = seg(0x20), data = seg(0x30);
    const stackSize = u32(ex + 0x1C), bssSize = u32(ex + 0x3C);
    const compressed = bytes[ex + 0xD] & 1;
    const priority = bytes[ex + 0x200 + 0xF];
    // Memory the application gets: the Old 3DS system mode in exheader flag0 bits 4-7 (0 = 64 MB, 2 = 96 MB,
    // 3 = 80 MB "extended memory", 4 = 72 MB, 5 = 32 MB); New 3DS-only modes in flag2 bits 0-3 (124/178 MB)
    const o3dsMode = bytes[ex + 0x200 + 0xE] >>> 4, n3dsMode = bytes[ex + 0x200 + 0xD] & 15;
    const appMemory = Math.max({ 2: 96, 3: 80, 4: 72, 5: 32 }[o3dsMode] || 64, { 1: 124, 2: 178, 3: 124 }[n3dsMode] || 0) * 0x100000;

    // ExeFS: find .code (and the icon for the title).
    const exefs = u32(0x1A0) * mediaUnit;
    if (!exefs) throw new EMU.EmuError('NCCH has no ExeFS');
    const files = {};
    for (let i = 0; i < 10; i++) {
      const e = exefs + i * 16;
      const name = ascii(e, 8);
      if (name) files[name] = bytes.subarray(exefs + 0x200 + u32(e + 8), exefs + 0x200 + u32(e + 8) + u32(e + 12));
    }
    if (!files['.code']) throw new EMU.EmuError('ExeFS has no .code section');
    const code = compressed ? blzDecompress(files['.code']) : files['.code'];

    // Segments in .code are page-aligned; .bss follows .data.
    const sz = (s) => Math.max(s.pages * 0x1000, align(s.size));
    const textSz = sz(text), roSz = sz(ro), dataSz = sz(data) + align(bssSize);
    const image = mem.newBuffer ? mem.newBuffer(textSz + roSz + dataSz) : new Uint8Array(textSz + roSz + dataSz);
    image.set(code.subarray(0, Math.min(code.length, image.length)));
    const fileDataEnd = textSz + roSz + data.size;
    image.fill(0, Math.min(fileDataEnd, image.length));
    mem.map(text.addr, textSz, image, 0, 5, 3, 'code');
    if (roSz) mem.map(ro.addr, roSz, image, textSz, 1, 3, 'rodata');
    if (dataSz) mem.map(data.addr, dataSz, image, textSz + roSz, 3, 3, 'data');

    // RomFS: the FS archive exposes the level-3 image, which starts 0x1000 into the IVFC section.
    let romfs = null;
    const romfsOff = u32(0x1B0) * mediaUnit, romfsSize = u32(0x1B4) * mediaUnit;
    if (romfsOff && romfsSize > 0x1000 && !(flags[7] & 2)) romfs = bytes.subarray(romfsOff + 0x1000, romfsOff + romfsSize);

    // ARM11 kernel capabilities (exheader 0x370): the kernel release version descriptor
    let kernelVersion = 0;
    for (let i = 0; i < 28; i++) {
      const d = u32(ex + 0x370 + i * 4);
      if ((d & 0xFE000000) >>> 0 === 0xFC000000) kernelVersion = d & 0xFFFF;
    }

    return {
      entry: text.addr, size: image.length, format: 'NCCH', romfs, kernelVersion, appMemory,
      stackSize, priority: priority || 0x30,
      title: files.icon ? smdhTitle(files.icon) : null,
      region: smdhRegion(files.icon),
      programId: dv.getBigUint64(0x118, true).toString(16).padStart(16, '0'),
      cryptoFlagUnset: flagMismatch,
    };
  }

  function loadNcsd(mem, bytes) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const mediaUnit = 0x200 << bytes[0x188 + 6];
    const off = dv.getUint32(0x120, true) * mediaUnit, size = dv.getUint32(0x124, true) * mediaUnit;
    if (!off || !size || off + 0x200 > bytes.length) throw new EMU.EmuError('.3ds image has no game partition');
    const info = loadNcch(mem, bytes.subarray(off, Math.min(bytes.length, off + size)), mediaUnit);
    info.format = 'NCSD (.3ds)';
    return info;
  }

  // CIA (installable title): header, certificate chain, ticket, title metadata (TMD), then the contents. Content 0
  // is the title's NCCH. Only decrypted CIAs can be used (e.g. GodMode9 "Decrypt file" on a CIA built from your own
  // console); contents encrypted with the title key need Nintendo's keys, which this emulator does not have.
  // head: at least the bytes up to the end of the TMD. Returns { offset, size, titleId } of content 0.
  const align64 = (v) => Math.ceil(v / 64) * 64;
  const SIG_SIZE = { 0x10000: 0x240, 0x10001: 0x140, 0x10002: 0x7C, 0x10003: 0x240, 0x10004: 0x140, 0x10005: 0x7C };
  function isCia(bytes) {
    return bytes.length >= 0x20 && bytes[0] === 0x20 && bytes[1] === 0x20 && bytes[2] === 0 && bytes[3] === 0 && bytes[4] === 0 && bytes[5] === 0;
  }
  function ciaLayout(head) {
    const dv = new DataView(head.buffer, head.byteOffset, head.byteLength);
    const hdr = dv.getUint32(0, true), certs = dv.getUint32(8, true), ticket = dv.getUint32(0xC, true), tmd = dv.getUint32(0x10, true);
    const tmdOff = align64(hdr) + align64(certs) + align64(ticket);
    const contentOff = tmdOff + align64(tmd);
    if (tmdOff + 0x200 > head.length) return { need: tmdOff + tmd };
    const sig = SIG_SIZE[dv.getUint32(tmdOff, false)];
    if (!sig) throw new EMU.EmuError('Bad CIA: unknown TMD signature type');
    const h = tmdOff + sig;
    if (h + 0x9C4 + 0x30 > head.length) return { need: tmdOff + tmd };
    const titleId = dv.getBigUint64(h + 0x4C, false).toString(16).padStart(16, '0');
    const count = dv.getUint16(h + 0x9E, false);
    // Contents follow each other in TMD order; content 0 (the NCCH) comes first when present
    let off = contentOff;
    for (let i = 0; i < count; i++) {
      const c = h + 0x9C4 + i * 0x30;
      if (c + 0x30 > head.length) return { need: c + 0x30 };
      const index = dv.getUint16(c + 4, false), type = dv.getUint16(c + 6, false), size = Number(dv.getBigUint64(c + 8, false));
      if (index === 0) {
        if (type & 1) throw new EMU.EmuError('This .cia is encrypted. Only decrypted CIAs can be used: decrypt it on your 3DS first (GodMode9: select the .cia, then "CIA image options" -> "Decrypt file"), or use a decrypted .3ds/.cxi.');
        return { offset: off, size, titleId };
      }
      off += size;
    }
    throw new EMU.EmuError('This .cia has no main program (content 0)');
  }
  EMU.ciaLayout = ciaLayout;

  function loadCia(mem, bytes) {
    const c = ciaLayout(bytes);
    if (c.need || c.offset + 0x200 > bytes.length) throw new EMU.EmuError('Bad CIA: file is cut short');
    const content = bytes.subarray(c.offset, Math.min(bytes.length, c.offset + c.size));
    if (String.fromCharCode(...content.subarray(0x100, 0x104)) !== 'NCCH') throw new EMU.EmuError('This .cia is encrypted. Only decrypted CIAs can be used.');
    const info = loadNcch(mem, content);
    info.format = 'CIA';
    return info;
  }

  function loadElf(mem, bytes) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (dv.getUint32(0, false) !== 0x7F454C46) throw new EMU.EmuError('Not an ELF file');
    if (bytes[4] !== 1 || bytes[5] !== 1) throw new EMU.EmuError('Only 32-bit little-endian ELF files are supported');
    if (dv.getUint16(18, true) !== 40) throw new EMU.EmuError('ELF is not for ARM');
    const entry = dv.getUint32(24, true);
    const phoff = dv.getUint32(28, true), phentsize = dv.getUint16(42, true), phnum = dv.getUint16(44, true);
    let lo = Infinity, hi = 0;
    const segs = [];
    for (let i = 0; i < phnum; i++) {
      const o = phoff + i * phentsize;
      if (dv.getUint32(o, true) !== 1) continue; // PT_LOAD
      const seg = { off: dv.getUint32(o + 4, true), vaddr: dv.getUint32(o + 8, true), filesz: dv.getUint32(o + 16, true), memsz: dv.getUint32(o + 20, true), flags: dv.getUint32(o + 24, true) };
      if (!seg.memsz) continue;
      segs.push(seg);
      lo = Math.min(lo, seg.vaddr & ~0xFFF);
      hi = Math.max(hi, align(seg.vaddr + seg.memsz));
    }
    if (!segs.length) throw new EMU.EmuError('ELF has no loadable segments');
    const image = new Uint8Array(hi - lo);
    for (const s of segs) image.set(bytes.subarray(s.off, s.off + s.filesz), s.vaddr - lo);
    mem.map(lo, hi - lo, image, 0, 7, 3, 'elf');
    return { entry, size: hi - lo, format: 'ELF' };
  }

  // Known system data archives (title ID high 0004009B)
  EMU.SYSTEM_ARCHIVE_NAMES = {
    '0004009b00010202': 'Mii data',
    '0004009b00014002': 'shared font (JPN/USA/EUR)',
    '0004009b00014102': 'shared font (CHN)',
    '0004009b00014202': 'shared font (KOR)',
    '0004009b00014302': 'shared font (TWN)',
    '0004009b00010402': 'region manifest / country list',
    '000400db00010302': 'bad word list',
    '0004009b00010602': 'public CA certificates',
    '0004009b00011202': 'keyboard dictionary (Dutch)',
    '0004009b00011302': 'keyboard dictionary (English)',
    '0004009b00011502': 'keyboard dictionary (French)',
    '0004009b00011702': 'keyboard dictionary (German)',
    '0004009b00011802': 'keyboard dictionary (Italian)',
    '0004009b00011b02': 'keyboard dictionary (Portuguese)',
    '0004009b00011c02': 'keyboard dictionary (Russian)',
    '0004009b00011d02': 'keyboard dictionary (Spanish)',
    '0004009b00012102': 'system data tables',
    '0004009b00013102': 'system messages',
    '0004009b00015102': 'system data (LZ tables)',
    '000400db00010502': 'Nintendo Zone hotspot list',
    '000400db00016102': 'system version (NVer)',
    '000400db00017102': 'system version and parental key (CVer)',
    '0004001b00010002': 'SSL client certificate (ClCertA)',
    '0004001b00010702': 'title blacklists (NS CFA)',
    '0004001b00010802': 'dummy data',
    '0004001b00018002': 'offline help pages',
    '0004001b00018102': 'offline browser pages',
    '0004001b00018202': 'web browser engine and fonts',
    '0004001b00019002': 'Fangate updater',
  };

  // Applets (0004003x) and system modules / firmware (00040130, 00040138), by low title ID without the region digit
  // where it varies; names from their internal (exheader) names. Apps and applets with an icon use its name instead.
  const APPLET_NAMES = {
    0x8202: 'HOME Menu', 0x8f02: 'HOME Menu', 0x9802: 'HOME Menu', 0xa102: 'HOME Menu', 0xa902: 'HOME Menu', 0xb102: 'HOME Menu',
    0x8a02: 'error display', 0x8a03: 'error display (safe mode)', 0x9902: 'Camera applet',
    0xc502: 'error / EULA applet', 0xc503: 'error / EULA applet (safe mode)', 0xcd02: 'Circle Pad Pro calibration',
    0xd002: 'software keyboard', 0xd003: 'software keyboard (safe mode)', 0xd102: 'Mii selector',
    0xd302: 'photo selector', 0xd402: 'sound selector', 0xd602: 'eShop applet', 0xf602: 'notes library applet',
  };
  const MODULE_NAMES = {
    am: 'title manager', camera: 'camera', cfg: 'system config', codec: 'audio/touch codec', dsp: 'sound processor',
    gpio: 'GPIO', gsp: 'graphics', hid: 'input', i2c: 'I2C bus', mcu: 'power and battery controller', mic: 'microphone',
    pdn: 'power domains', ptm: 'power and time', spi: 'SPI bus', ac: 'network connection', cecd: 'StreetPass',
    csnd: 'sound', dlp: 'Download Play', http: 'HTTP', mp: 'local wireless (DS)', ndm: 'network daemons', nim: 'eShop and updates',
    nwm: 'wireless', socket: 'sockets', ssl: 'SSL', ps: 'crypto (PS)', friends: 'friends', ir: 'infrared', boss: 'SpotPass',
    news: 'notifications', ro: 'code modules', act: 'Nintendo Network ID', nfc: 'NFC (amiibo)', ns: 'title launcher',
    f_native: '3DS firmware (NATIVE_FIRM)', f_twl: 'DS mode firmware (TWL_FIRM)', f_agb: 'GBA mode firmware (AGB_FIRM)',
  };

  // What a system title is: { name, kind, used } (kind: app, applet, data, module, firmware, ds; used: whether Pica3DS
  // uses it). iconName / exName: the title's own names, when known.
  EMU.describeSystemTitle = function (titleId, iconName, exName) {
    const id = titleId.toLowerCase(), hi = id.slice(0, 8), low = parseInt(id.slice(8), 16);
    if (hi === '00040138') {
      const name = MODULE_NAMES[exName] || exName || 'firmware';
      return { name: (id.endsWith('03') && exName === 'f_native' ? 'safe mode firmware (SAFE_MODE_FIRM)' : name), kind: 'firmware', used: false };
    }
    if (hi === '00040130') {
      const name = `system module: ${MODULE_NAMES[exName] || exName || id.slice(8)}${id.endsWith('03') ? ' (safe mode)' : ''}`;
      return { name, kind: 'module', used: false };
    }
    if (/^00048/.test(hi)) return { name: `DS mode title ${String.fromCharCode(...[0, 8, 16, 24].map((s) => (low >>> (24 - s)) & 0xFF))}`, kind: 'ds', used: false };
    const own = iconName && /[A-Za-z]{2}/.test(iconName) && iconName.trim() !== exName ? iconName.trim() : null; // not '???' or blank
    if (hi === '00040030') return { name: (own && own !== 'MINT' ? own : null) || APPLET_NAMES[low & 0xFFFF] || exName || 'applet', kind: 'applet', used: true };
    if (hi === '00040010') return { name: own || (exName ? `system app (${exName})` : 'system app'), kind: 'app', used: true };
    return { name: EMU.SYSTEM_ARCHIVE_NAMES[id] || 'system data', kind: 'data', used: true };
  };

  // A system data archive (e.g. Mii data, shared font): the decrypted .app content of a data-only title.
  EMU.parseSystemArchive = function (bytes) {
    if (isCia(bytes)) {
      const c = ciaLayout(bytes);
      if (!c.need) {
        bytes = bytes.subarray(c.offset, c.offset + c.size);
        // DS-mode (DSi) titles hold a DS program, not an NCCH: recognised, not used
        if (/^00048/.test(c.titleId) && String.fromCharCode(...bytes.subarray(0x100, 0x104)) !== 'NCCH') {
          const about = EMU.describeSystemTitle(c.titleId), title = String.fromCharCode(...bytes.subarray(0, 12)).replace(/[^ -~]/g, '').trim();
          if (title) about.name = `DS mode title: ${title}`; // from the DS program header
          return Object.assign({ titleId: c.titleId, romfs: null, exefs: {}, executable: true }, about);
        }
      }
    }
    const ascii = (o, n) => String.fromCharCode(...bytes.subarray(o, o + n));
    if (bytes.length < 0x200 || ascii(0x100, 4) !== 'NCCH') throw new EMU.EmuError('Not a system data file (expected a decrypted .app containing an NCCH)');
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const flags = bytes.subarray(0x188, 0x190);
    const titleId = dv.getBigUint64(0x108, true).toString(16).padStart(16, '0');
    const romfsOff = dv.getUint32(0x1B0, true) * 0x200, romfsSize = dv.getUint32(0x1B4, true) * 0x200;
    // Judged by the contents (a plain RomFS starts with "IVFC"), as some tools leave the "no crypto" flag unset
    const plainRomfs = romfsOff && romfsOff + 4 <= bytes.length && ascii(romfsOff, 4) === 'IVFC';
    const executable = !!(flags[5] & 2);
    // ExeFS files other titles may read (icon, start-up logo, banner)
    const exefs = {}, exefsOff = dv.getUint32(0x1A0, true) * 0x200;
    let plainExefs = false;
    if (exefsOff && exefsOff + 0x200 <= bytes.length) {
      for (let i = 0; i < 10; i++) {
        const e = exefsOff + i * 16, name = ascii(e, 8).replace(/\0.*$/, '');
        if (!name) continue;
        if (!/^[ -~]+$/.test(name)) { plainExefs = false; break; }
        plainExefs = true;
        const off = exefsOff + 0x200 + dv.getUint32(e + 8, true), size = dv.getUint32(e + 12, true);
        if ((name === 'icon' || name === 'logo' || name === 'banner') && off + size <= bytes.length) exefs[name] = bytes.slice(off, off + size);
      }
    }
    // Titles built for firmware 5.0 and later keep the start-up logo in the NCCH logo region instead of the ExeFS
    const logoOff = dv.getUint32(0x198, true) * 0x200, logoSize = dv.getUint32(0x19C, true) * 0x200;
    if (!exefs.logo && logoOff && logoSize && logoOff + logoSize <= bytes.length) exefs.logo = bytes.slice(logoOff, logoOff + logoSize);
    if (!(flags[7] & 4) && !plainRomfs && !(executable && plainExefs)) throw new EMU.EmuError(`System file ${titleId} is encrypted. Decrypt it on your 3DS first (GodMode9: "NCCH image options" -> "Decrypt file").`);
    const hasRomfs = romfsOff && romfsSize > 0x1000 && !(flags[7] & 2) && romfsOff + romfsSize <= bytes.length;
    if (!hasRomfs && !executable) throw new EMU.EmuError(`System file ${titleId} has no RomFS`);
    const about = EMU.describeSystemTitle(titleId, exefs.icon ? smdhTitle(exefs.icon) : null, executable ? ascii(0x200, 8).replace(/\0.*$/, '') : null);
    return Object.assign({ titleId, romfs: hasRomfs ? bytes.slice(romfsOff + 0x1000, romfsOff + romfsSize) : null, exefs, executable }, about);
  };

  // Part of a large file read on demand (games too big to load whole): 1 MB chunks of a Blob fetched
  // asynchronously and kept in a bounded cache (least recently used chunks are dropped first).
  const CHUNK = 1 << 20, MAX_CHUNKS = 384, READ_AHEAD = 4 << 20;
  class LazyFile {
    constructor(blob, start, length) { this.blob = blob; this.start = start; this.length = length; this.chunks = new Map(); this.pending = new Map(); }

    // Are bytes [off, off + n) in memory?
    has(off, n) {
      for (let c = Math.floor(off / CHUNK), last = Math.floor((off + n - 1) / CHUNK); c <= last; c++) if (!this.chunks.has(c)) return false;
      return true;
    }

    // Copy [off, off + n) into dest; every chunk must be loaded
    copy(off, n, dest) {
      for (let o = 0; o < n;) {
        const p = off + o, c = Math.floor(p / CHUNK), within = p - c * CHUNK, chunk = this.chunks.get(c);
        this.chunks.delete(c); this.chunks.set(c, chunk); // most recently used
        const k = Math.min(n - o, chunk.length - within);
        dest.set(chunk.subarray(within, within + k), o);
        o += k;
      }
    }

    // Fetch the chunks covering [off, off + n) and a little beyond (reads are mostly sequential)
    load(off, n) {
      const lastChunk = Math.floor((this.length - 1) / CHUNK);
      const first = Math.floor(off / CHUNK), last = Math.min(lastChunk, Math.floor((off + Math.max(1, n) - 1 + READ_AHEAD) / CHUNK));
      const jobs = [];
      for (let c = first; c <= last; c++) if (!this.chunks.has(c)) jobs.push(this.fetch(c));
      return Promise.all(jobs);
    }

    fetch(c) {
      if (this.pending.has(c)) return this.pending.get(c);
      const a = this.start + c * CHUNK, b = Math.min(this.start + this.length, a + CHUNK);
      const p = this.blob.slice(a, b).arrayBuffer().then((buf) => {
        this.pending.delete(c);
        this.chunks.set(c, new Uint8Array(buf));
        while (this.chunks.size > MAX_CHUNKS) this.chunks.delete(this.chunks.keys().next().value);
      });
      this.pending.set(c, p);
      return p;
    }
  }
  EMU.LazyFile = LazyFile;
  // Classes a save state can hold (see state.js)
  Object.assign(EMU.classes || (EMU.classes = {}), { LazyFile });

  // Game files bigger than this are not read whole: the start of the file (headers and code) is read, and the
  // RomFS is read on demand. Returns { bytes, romfs } (romfs null when the file is read whole).
  EMU.LARGE_GAME = 256 * 1024 * 1024;
  EMU.readGameFile = async function (file) {
    const whole = async () => ({ bytes: new Uint8Array(await file.arrayBuffer()), romfs: null });
    if (file.size <= EMU.LARGE_GAME) return whole();
    const head = new Uint8Array(await file.slice(0, 0x200).arrayBuffer());
    const ascii = (b, o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
    let part = 0, mu = 0x200;
    if (ascii(head, 0x100) === 'NCSD') {
      mu = 0x200 << head[0x188 + 6];
      part = new DataView(head.buffer).getUint32(0x120, true) * mu;
    } else if (isCia(head)) { // header and TMD first, to find the NCCH
      let n = 0x4000, c;
      for (;;) {
        c = ciaLayout(new Uint8Array(await file.slice(0, n).arrayBuffer()));
        if (!c.need) break;
        if (n >= c.need || n > 0x100000) throw new EMU.EmuError('Bad CIA header');
        n = c.need + 0x1000;
      }
      part = c.offset;
    } else if (ascii(head, 0x100) !== 'NCCH') return whole(); // not a cartridge image: the loader reports it
    const ncch = new DataView(await file.slice(part, part + 0x200).arrayBuffer());
    const exefsEnd = (ncch.getUint32(0x1A0, true) + ncch.getUint32(0x1A4, true)) * mu;
    const romfsOff = ncch.getUint32(0x1B0, true) * mu, romfsSize = ncch.getUint32(0x1B4, true) * mu;
    const bytes = new Uint8Array(await file.slice(0, part + Math.max(exefsEnd, 0xC00)).arrayBuffer());
    const romfs = romfsOff && romfsSize > 0x1000 ? new LazyFile(file, part + romfsOff + 0x1000, romfsSize - 0x1000) : null;
    return { bytes, romfs };
  };

  EMU.loadExecutable = function (mem, bytes) {
    if (bytes.length >= 4 && bytes[0] === 0x33 && bytes[1] === 0x44 && bytes[2] === 0x53 && bytes[3] === 0x58) return load3dsx(mem, bytes);
    if (bytes.length >= 4 && bytes[0] === 0x7F && bytes[1] === 0x45) return loadElf(mem, bytes);
    const magic = bytes.length > 0x200 ? String.fromCharCode(...bytes.subarray(0x100, 0x104)) : '';
    if (magic === 'NCSD') return loadNcsd(mem, bytes);
    if (magic === 'NCCH') return loadNcch(mem, bytes);
    if (isCia(bytes)) return loadCia(mem, bytes);
    throw new EMU.EmuError('Unrecognized file format. Expected .3dsx, .elf, or a decrypted .3ds/.cci/.cxi/.cia.');
  };
})(typeof window !== 'undefined' ? window.EMU : globalThis.EMU);

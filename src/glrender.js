// WebGL 2 renderer for the PICA200: the per-pixel work runs on the host graphics card.
// Vertex and geometry shaders, primitive assembly and clipping stay in EMU.Gpu (gpu.js); this file draws the
// resulting triangles. Each render state becomes a fragment shader (texturing, texture combiners, fragment
// lighting, fog, alpha test) plus GL blend/depth/stencil state. Render targets live on the graphics card and
// are written back to emulated memory only when something reads that memory (display transfers, copies,
// textures); memory written by other means is uploaded before the next draw into it.
(function (EMU) {
  'use strict';

  const MORTON = new Uint8Array(64);
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
    let m = 0;
    for (let i = 0; i < 3; i++) m |= (((x >> i) & 1) << (2 * i)) | (((y >> i) & 1) << (2 * i + 1));
    MORTON[y * 8 + x] = m;
  }
  // Byte offset of pixel (x, row) in a tiled surface, row 0 being the first row in memory
  const tiled = (x, row, w, bpp) => ((((row >> 3) * (w >> 3) + (x >> 3)) << 6) + MORTON[(row & 7) * 8 + (x & 7)]) * bpp;

  const COLOR_BPP = [4, 3, 2, 2, 2];
  // One pixel of a render target (formats: RGBA8, RGB8, RGBA5551, RGB565, RGBA4) as [r, g, b, a]
  function decodeColor(fmt, u8, o) {
    switch (fmt) {
      case 0: return [u8[o + 3], u8[o + 2], u8[o + 1], u8[o]];
      case 1: return [u8[o + 2], u8[o + 1], u8[o], 255];
      case 2: { const v = u8[o] | (u8[o + 1] << 8), x = (c) => (c << 3) | (c >> 2); return [x((v >>> 11) & 31), x((v >>> 6) & 31), x((v >>> 1) & 31), v & 1 ? 255 : 0]; }
      case 3: { const v = u8[o] | (u8[o + 1] << 8); return [((v >>> 11) & 31) << 3 | ((v >>> 11) & 31) >> 2, ((v >>> 5) & 63) << 2 | ((v >>> 5) & 63) >> 4, (v & 31) << 3 | (v & 31) >> 2, 255]; }
      default: { const v = u8[o] | (u8[o + 1] << 8); return [((v >>> 12) & 15) * 17, ((v >>> 8) & 15) * 17, ((v >>> 4) & 15) * 17, (v & 15) * 17]; }
    }
  }
  const HAS_ALPHA = [true, false, true, false, true];
  // Per vertex: window x, y, depth, w | color | uv0, uv1 | uv2, uv0 w, - | quaternion | view
  const VTX = 23;
  const SEM = { QUAT: 4, COLOR: 8, UV0: 12, UV1: 14, UV0W: 16, VIEW: 18, UV2: 22 };

  const VERTEX_SHADER = `#version 300 es
layout(location = 0) in vec4 aPos;
layout(location = 1) in vec4 aColor;
layout(location = 2) in vec4 aUV01;
layout(location = 3) in vec4 aUV2W;
layout(location = 4) in vec4 aQuat;
layout(location = 5) in vec3 aView;
uniform vec2 uSize;
out vec4 vColor; out vec4 vUV01; out vec4 vUV2W; out vec4 vQuat; out vec3 vView;
void main() {
  float w = aPos.w;
  gl_Position = vec4((aPos.x / uSize.x * 2.0 - 1.0) * w, (aPos.y / uSize.y * 2.0 - 1.0) * w, (clamp(aPos.z, 0.0, 1.0) * 2.0 - 1.0) * w, w);
  vColor = aColor; vUV01 = aUV01; vUV2W = aUV2W; vQuat = aQuat; vView = aView;
}`;

  // ------------------------------------------------------------------ fragment shader generation
  const f = (x) => (Number.isInteger(x) ? `${x}.0` : `${x}`);

  function srcExpr(src, ch, s) {
    const c = 'RGBA'[ch];
    switch (src) {
      case 0: return 'p' + c;
      case 1: return 'lp' + c;
      case 2: return 'ls' + c;
      case 3: return 't0' + c;
      case 4: return 't1' + c;
      case 5: return 't2' + c;
      case 6: return '0.0';
      case 13: return 'b' + c;
      case 14: return `uK[${s}].${'xyzw'[ch]}`;
      default: return 'o' + c;
    }
  }
  function rgbOperand(op, src, s) {
    const e = (ch) => srcExpr(src, ch, s), inv = (x) => `(255.0 - ${x})`;
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
  function alphaOperand(op, src, s) {
    const e = (ch) => srcExpr(src, ch, s);
    return [e(3), `(255.0 - ${e(3)})`, e(0), `(255.0 - ${e(0)})`, e(1), `(255.0 - ${e(1)})`, e(2), `(255.0 - ${e(2)})`][op] || e(3);
  }
  // The same integer arithmetic as the software combiners (D(x) = floor(x / 255))
  function combine(op, a, b, c) {
    switch (op) {
      case 1: return `D(${a} * ${b})`;
      case 2: return `min(${a} + ${b}, 255.0)`;
      case 3: return `clamp(${a} + ${b} - 128.0, 0.0, 255.0)`;
      case 4: return `D(${a} * ${c} + ${b} * (255.0 - ${c}))`;
      case 5: return `max(${a} - ${b}, 0.0)`;
      case 8: return `min(D(${a} * ${b} + 255.0 * ${c}), 255.0)`;
      case 9: return `D(min(${a} + ${b}, 255.0) * ${c})`;
      default: return a;
    }
  }
  const OPERANDS_USED = [1, 2, 2, 2, 3, 2, 2, 2, 3, 3];

  // Structure of the lighting setup (what changes the generated code); the numbers are uniforms
  function lightKey(L) {
    if (!L) return '';
    return JSON.stringify([L.config, L.primaryAlpha, L.secondaryAlpha, L.bumpSel, L.clampHighlights, L.bumpMode, L.renorm, L.on, L.input, L.abs, L.scale,
      L.lights.map((l) => [l.id, l.directional, l.twoSided, l.geo0, l.geo1, l.spotOn, l.distOn])]);
  }

  function genLighting(L) {
    let c = `vec3 sn = vec3(0.0, 0.0, 1.0), stan = vec3(1.0, 0.0, 0.0);\n`;
    if (L.bumpMode) {
      const t = `t${L.bumpSel}`;
      c += `{ vec3 p = vec3(${t}R, ${t}G, ${t}B) / 127.5 - 1.0;\n`;
      if (L.bumpMode === 1) c += `${L.renorm ? 'p.z = sqrt(max(1.0 - p.x * p.x - p.y * p.y, 0.0));' : ''} sn = p; }\n`;
      else c += L.bumpMode === 2 ? 'stan = p; }\n' : '}\n';
    }
    c += `vec4 q = vQuat; float ql = length(q); if (ql == 0.0) ql = 1.0; q /= ql;
      vec3 n = rot(q, sn), tng = rot(q, stan);
      vec3 view = vView; float vl = length(view); if (vl == 0.0) vl = 1.0; vec3 nv = view / vl;
      vec3 dif = vec3(0.0), spe = vec3(0.0); float da = 1.0, sa = 1.0;\n`;
    const lutId = [0, 1, -1, 3, 4, 5, 6];
    L.lights.forEach((l, li) => {
      c += `{ vec3 lv = ${l.directional ? `uLPos[${li}]` : `uLPos[${li}] + view`}; float ll = length(lv); if (ll == 0.0) ll = 1.0; lv /= ll;
        vec3 hv = nv + lv; float hl2 = dot(hv, hv); float hl = sqrt(hl2); if (hl == 0.0) hl = 1.0; vec3 nh = hv / hl;\n`;
      const lookup = (slot) => {
        const inputs = ['dot(n, nh)', 'dot(nv, nh)', 'dot(n, nv)', 'dot(lv, n)', `dot(lv, uLSpot[${li}])`,
          L.config === 8 ? 'dot(nh - n * dot(n, nh), tng)' : '0.0'];
        const v = inputs[L.input[slot]] || '0.0';
        const id = slot === 2 ? 8 + l.id : lutId[slot];
        const call = L.abs[slot] ? `lutAbs(${id}, ${v}, ${l.twoSided ? 'true' : 'false'})` : `lutSigned(${id}, ${v})`;
        return `(${f(L.scale[slot])} * ${call})`;
      };
      c += 'float dist = 1.0;\n';
      if (l.distOn) c += `{ float d = length(-view - uLPos[${li}]); float loc = clamp(uLAtt[${li}].y * d + uLAtt[${li}].x, 0.0, 1.0);
        float idx = clamp(floor(loc * 256.0), 0.0, 255.0); dist = lutv(${16 + l.id}, idx, loc * 256.0 - idx); }\n`;
      c += `float spot = ${l.spotOn ? lookup(2) : '1.0'};
        vec3 s0 = ${L.on[0] ? lookup(0) : '1.0'} * uLSpec0[${li}];
        float rr = ${L.on[6] ? lookup(6) : '1.0'};
        float rg = ${L.on[5] ? lookup(5) : 'rr'};
        float rb = ${L.on[4] ? lookup(4) : 'rr'};
        vec3 s1 = ${L.on[1] ? lookup(1) : '1.0'} * vec3(rr, rg, rb) * uLSpec1[${li}];\n`;
      if (li === L.lights.length - 1 && L.on[3]) {
        c += `{ float fr = ${lookup(3)};${L.primaryAlpha ? ' da = fr;' : ''}${L.secondaryAlpha ? ' sa = fr;' : ''} }\n`;
      }
      c += `float NL = dot(lv, n); NL = ${l.twoSided ? 'abs(NL)' : 'max(NL, 0.0)'};
        float clampH = ${L.clampHighlights ? '(NL == 0.0 ? 0.0 : 1.0)' : '1.0'};\n`;
      if (l.geo0 || l.geo1) c += `{ float geo = hl2 == 0.0 ? 0.0 : min(NL / hl2, 1.0);${l.geo0 ? ' s0 *= geo;' : ''}${l.geo1 ? ' s1 *= geo;' : ''} }\n`;
      c += `float k = dist * spot, ks = clampH * k;
        dif += (uLDiff[${li}] * NL + uLAmb[${li}]) * k; spe += (s0 + s1) * ks; }\n`;
    });
    c += `dif += uAmbient;
      float lpR = cl(dif.r), lpG = cl(dif.g), lpB = cl(dif.b), lpA = cl(da);
      float lsR = cl(spe.r), lsG = cl(spe.g), lsB = cl(spe.b), lsA = cl(sa);\n`;
    return c;
  }

  function genFragment(st) {
    const used = new Set();
    st.tev.forEach((s) => {
      if (s.passthrough) return;
      const nRgb = s.rgbCmb === 6 || s.rgbCmb === 7 ? 2 : OPERANDS_USED[s.rgbCmb] || 1;
      const nA = s.rgbCmb === 7 ? 0 : OPERANDS_USED[s.aCmb] || 1;
      for (let k = 0; k < nRgb; k++) used.add(s.rgbSrc[k]);
      for (let k = 0; k < nA; k++) used.add(s.aSrc[k]);
    });
    const L = st.lighting, lit = L && (used.has(1) || used.has(2));
    if (lit && L.bumpMode) used.add(3 + L.bumpSel);
    let c = '';
    c += 'float pR = floor(vColor.r * 255.0 + 0.5), pG = floor(vColor.g * 255.0 + 0.5), pB = floor(vColor.b * 255.0 + 0.5), pA = floor(vColor.a * 255.0 + 0.5);\n';
    for (let t = 0; t < 3; t++) {
      if (!used.has(3 + t)) continue;
      const T = st.textures[t];
      if (!T) { c += `float t${t}R = 0.0, t${t}G = 0.0, t${t}B = 0.0, t${t}A = 0.0;\n`; continue; }
      const uv = t === 0 ? 'vUV01.xy' : t === 1 || st.tex2uv1 ? 'vUV01.zw' : 'vUV2W.xy';
      c += `vec2 uv${t} = ${uv};\n`;
      if (t === 0 && T.project) c += 'if (vUV2W.z != 0.0) uv0 /= vUV2W.z;\n';
      const border = [];
      if (T.wrapS === 1) border.push(`uv${t}.x < 0.0 || uv${t}.x >= 1.0`);
      if (T.wrapT === 1) border.push(`uv${t}.y < 0.0 || uv${t}.y >= 1.0`);
      c += `vec4 c${t} = ${border.length ? `(${border.join(' || ')}) ? uBorder[${t}] : ` : ''}floor(texture(uTex${t}, uv${t}) * 255.0 + 0.5);\n`;
      c += `float t${t}R = c${t}.r, t${t}G = c${t}.g, t${t}B = c${t}.b, t${t}A = c${t}.a;\n`;
    }
    if (lit) c += genLighting(L);
    else if (used.has(1) || used.has(2)) c += 'float lpR = 0.0, lpG = 0.0, lpB = 0.0, lpA = 0.0, lsR = 0.0, lsG = 0.0, lsB = 0.0, lsA = 0.0;\n';
    c += 'float oR = 0.0, oG = 0.0, oB = 0.0, oA = 0.0, bR = 0.0, bG = 0.0, bB = 0.0, bA = 0.0;\n';
    c += 'float nR = uBufInit.r, nG = uBufInit.g, nB = uBufInit.b, nA = uBufInit.a;\n';
    st.tev.forEach((s, i) => {
      if (!s.passthrough) {
        const A = rgbOperand(s.rgbOp[0], s.rgbSrc[0], i), B = rgbOperand(s.rgbOp[1], s.rgbSrc[1], i), C = rgbOperand(s.rgbOp[2], s.rgbSrc[2], i);
        c += '{\n';
        const n = s.rgbCmb === 6 || s.rgbCmb === 7 ? 2 : OPERANDS_USED[s.rgbCmb] || 1;
        for (let ch = 0; ch < 3; ch++) c += `float a${ch} = ${A[ch]}` + (n > 1 ? `, b${ch} = ${B[ch]}` : '') + (n > 2 ? `, c${ch} = ${C[ch]}` : '') + ';\n';
        if (s.rgbCmb === 6 || s.rgbCmb === 7) {
          c += 'float d = clamp(trunc(((a0 * 2.0 - 255.0) * (b0 * 2.0 - 255.0) + 128.0) / 256.0) + trunc(((a1 * 2.0 - 255.0) * (b1 * 2.0 - 255.0) + 128.0) / 256.0) + trunc(((a2 * 2.0 - 255.0) * (b2 * 2.0 - 255.0) + 128.0) / 256.0), 0.0, 255.0);\n';
          c += 'float rr = d, rg = d, rb = d;\n';
        } else c += `float rr = ${combine(s.rgbCmb, 'a0', 'b0', 'c0')}, rg = ${combine(s.rgbCmb, 'a1', 'b1', 'c1')}, rb = ${combine(s.rgbCmb, 'a2', 'b2', 'c2')};\n`;
        if (s.rgbCmb === 7) c += 'float ra = rr;\n';
        else {
          const na = OPERANDS_USED[s.aCmb] || 1;
          c += `float xa = ${alphaOperand(s.aOp[0], s.aSrc[0], i)}` + (na > 1 ? `, xb = ${alphaOperand(s.aOp[1], s.aSrc[1], i)}` : '') + (na > 2 ? `, xc = ${alphaOperand(s.aOp[2], s.aSrc[2], i)}` : '') + ';\n';
          c += `float ra = ${combine(s.aCmb, 'xa', 'xb', 'xc')};\n`;
        }
        const sc = (x, k) => (k === 1 ? x : `min(${x} * ${f(k)}, 255.0)`);
        c += `oR = ${sc('rr', s.rgbScale)}; oG = ${sc('rg', s.rgbScale)}; oB = ${sc('rb', s.rgbScale)}; oA = ${sc('ra', s.aScale)};\n}\n`;
      }
      c += 'bR = nR; bG = nG; bB = nB; bA = nA;\n';
      if (i < 4 && (st.updRGB & (1 << i))) c += 'nR = oR; nG = oG; nB = oB;\n';
      if (i < 4 && (st.updA & (1 << i))) c += 'nA = oA;\n';
    });
    if (st.fog) {
      c += `{ float depth = gl_FragCoord.z; float idx = (${st.fogFlip ? '1.0 - depth' : 'depth'}) * 128.0;
        float i = clamp(floor(idx), 0.0, 127.0); vec2 e = texelFetch(uFogLut, ivec2(int(i), 0), 0).rg;
        float fo = clamp(e.r + e.g * (idx - i), 0.0, 1.0);
        oR = floor(oR * fo + uFogColor.r * (1.0 - fo)); oG = floor(oG * fo + uFogColor.g * (1.0 - fo)); oB = floor(oB * fo + uFogColor.b * (1.0 - fo)); }\n`;
    }
    if (st.alphaTest) {
      const cmp = ['false', 'true', 'oA == uAlphaRef', 'oA != uAlphaRef', 'oA < uAlphaRef', 'oA <= uAlphaRef', 'oA > uAlphaRef', 'oA >= uAlphaRef'][st.alphaFunc];
      c += `if (!(${cmp})) discard;\n`;
    }
    // Logic ops that only need the fragment color (the others are drawn as a plain copy)
    if (!st.blend && st.logic !== 3) {
      if (st.logic === 0) c += 'oR = oG = oB = oA = 0.0;\n';
      else if (st.logic === 4) c += 'oR = oG = oB = oA = 255.0;\n';
      else if (st.logic === 5) c += 'oR = 255.0 - oR; oG = 255.0 - oG; oB = 255.0 - oB; oA = 255.0 - oA;\n';
    }
    c += 'fragColor = vec4(oR, oG, oB, oA) / 255.0;\n';
    return `#version 300 es
precision highp float;
precision highp int;
in vec4 vColor; in vec4 vUV01; in vec4 vUV2W; in vec4 vQuat; in vec3 vView;
uniform sampler2D uTex0, uTex1, uTex2;
uniform highp sampler2D uLut, uFogLut;
uniform vec4 uBorder[3];
uniform vec4 uK[6];
uniform vec4 uBufInit;
uniform float uAlphaRef;
uniform vec3 uFogColor;
uniform vec3 uLSpec0[8], uLSpec1[8], uLDiff[8], uLAmb[8], uLPos[8], uLSpot[8];
uniform vec2 uLAtt[8];
uniform vec3 uAmbient;
out vec4 fragColor;
float D(float x) { return floor(x / 255.0 + 0.001); }
float cl(float v) { return v <= 0.0 ? 0.0 : v >= 1.0 ? 255.0 : floor(v * 255.0); }
float lutv(int id, float index, float delta) { vec2 e = texelFetch(uLut, ivec2(int(index), id), 0).rg; return e.r + e.g * delta; }
float lutAbs(int id, float v, bool twoSided) {
  v = twoSided ? abs(v) : max(v, 0.0);
  float index = clamp(floor(v * 256.0), 0.0, 255.0);
  return lutv(id, index, v * 256.0 - index);
}
float lutSigned(int id, float v) {
  float si = clamp(floor(v * 128.0), -128.0, 127.0);
  return lutv(id, si < 0.0 ? si + 256.0 : si, v * 128.0 - si);
}
vec3 rot(vec4 q, vec3 v) {
  vec3 c = vec3(q.y * v.z - q.z * v.y + q.w * v.x, q.z * v.x - q.x * v.z + q.w * v.y, q.x * v.y - q.y * v.x + q.w * v.z);
  return v + 2.0 * vec3(q.y * c.z - q.z * c.y, q.z * c.x - q.x * c.z, q.x * c.y - q.y * c.x);
}
void main() {
fragColor = vec4(0.0);
${c}}`;
  }

  // ------------------------------------------------------------------ vertex shaders on the host GPU
  // PICA vertex programs are flattened for the current bool/int uniforms (EMU.flattenShaderBody) and written
  // as GLSL. Registers: inputs v0-v15 are attributes, r[] temporaries, C[] float uniforms, o[] outputs.
  function glslSrc(raw, sw, neg, offs, c) {
    const ch = 'xyzw'[sw[c]];
    let e;
    if (raw < 0x10) e = `v${raw}.${ch}`;
    else if (raw < 0x20) e = `r[${raw - 0x10}].${ch}`;
    else if (typeof offs === 'number') {
      const i = raw + offs;
      if (i < 0x20 || i >= 0x80) return '0.0';
      e = `C[${i - 0x20}].${ch}`;
    } else if (offs) e = `CR(${raw - 0x20} + ${offs}).${ch}`;
    else e = `C[${raw - 0x20}].${ch}`;
    return neg ? `(-${e})` : e;
  }

  function glslOp(ins, offs) {
    const OP = EMU.SHADER_OP, d = ins.desc;
    const comps = d ? [0, 1, 2, 3].filter((c) => d.mask & (8 >> c)) : [];
    const dst = (c) => `${ins.dst < 0x10 ? `o[${ins.dst}]` : `r[${ins.dst & 0xF}]`}.${'xyzw'[c]}`;
    const s1 = (c, off) => glslSrc(ins.s1, d.sw1, d.n1, off, c), s2 = (c, off) => glslSrc(ins.s2, d.sw2, d.n2, off, c), s3 = (c, off) => glslSrc(ins.s3, d.sw3, d.n3, off, c);
    const o1 = ins.inv ? '' : offs, o2 = ins.inv ? offs : '';
    // Compute every component first, then write (the destination may also be a source)
    const assign = (vals) => `{ ${comps.map((c) => `float t${c} = ${vals(c)};`).join(' ')} ${comps.map((c) => `${dst(c)} = t${c};`).join(' ')} }\n`;
    switch (ins.op) {
      case OP.ADD: return comps.length ? assign((c) => `${s1(c, o1)} + ${s2(c, o2)}`) : '';
      case OP.MUL: return comps.length ? assign((c) => `M(${s1(c, o1)}, ${s2(c, o2)})`) : '';
      case OP.MAX: return comps.length ? assign((c) => `MX(${s1(c, o1)}, ${s2(c, o2)})`) : '';
      case OP.MIN: return comps.length ? assign((c) => `MN(${s1(c, o1)}, ${s2(c, o2)})`) : '';
      case OP.SGE: case OP.SGEI: return comps.length ? assign((c) => `(${s1(c, o1)} >= ${s2(c, o2)} ? 1.0 : 0.0)`) : '';
      case OP.SLT: case OP.SLTI: return comps.length ? assign((c) => `(${s1(c, o1)} < ${s2(c, o2)} ? 1.0 : 0.0)`) : '';
      case OP.DP3: case OP.DP4: case OP.DPH: case OP.DPHI: {
        if (!comps.length) return '';
        const n = ins.op === OP.DP3 ? 3 : 4, h = ins.op === OP.DPH || ins.op === OP.DPHI;
        const terms = [];
        for (let c = 0; c < n; c++) terms.push(`M(${h && c === 3 ? '1.0' : s1(c, o1)}, ${s2(c, o2)})`);
        return `{ float t = ${terms.join(' + ')}; ${comps.map((c) => `${dst(c)} = t;`).join(' ')} }\n`;
      }
      case OP.DST: case OP.DSTI:
        return comps.length ? assign((c) => [`1.0`, `M(${s1(1, o1)}, ${s2(1, o2)})`, s1(2, o1), s2(3, o2)][c]) : '';
      case OP.EX2: case OP.LG2: case OP.RCP: case OP.RSQ: {
        if (!comps.length) return '';
        const f = { [OP.EX2]: 'exp2(x)', [OP.LG2]: 'log2(x)', [OP.RCP]: '(1.0 / x)' }[ins.op] || 'inversesqrt(x)';
        return `{ float x = ${s1(0, offs)}; float t = ${f}; ${comps.map((c) => `${dst(c)} = t;`).join(' ')} }\n`;
      }
      case OP.LITP: {
        return `{ float x0 = ${s1(0, offs)}, x1 = ${s1(1, offs)}, x2 = ${s1(2, offs)}, x3 = ${s1(3, offs)};
          float t0 = max(x0, 0.0), t1 = clamp(x1, -127.9961, 127.9961), t2 = x2, t3 = max(x3, 0.0);
          cx = x0 > 0.0; cy = x3 > 0.0; ${comps.map((c) => `${dst(c)} = t${c};`).join(' ')} }\n`;
      }
      case OP.FLR: return comps.length ? assign((c) => `floor(${s1(c, offs)})`) : '';
      case OP.MOV: return comps.length ? assign((c) => s1(c, offs)) : '';
      case OP.MOVA: {
        if (!(d.mask & 12)) return '';
        return `{ float x = ${s1(0, offs)}, y = ${s1(1, offs)};${d.mask & 8 ? ' a0x = int(trunc(x));' : ''}${d.mask & 4 ? ' a0y = int(trunc(y));' : ''} }\n`;
      }
      case OP.CMP: {
        const cmp = (op, a, b) => [`${a} == ${b}`, `${a} != ${b}`, `${a} < ${b}`, `${a} <= ${b}`, `${a} > ${b}`, `${a} >= ${b}`][op] || 'true';
        return `{ float a0 = ${s1(0, offs)}, a1 = ${s1(1, offs)}, b0 = ${s2(0, '')}, b1 = ${s2(1, '')}; cx = ${cmp(ins.cmpx, 'a0', 'b0')}; cy = ${cmp(ins.cmpy, 'a1', 'b1')}; }\n`;
      }
      case OP.MAD: case OP.MADI: {
        if (!comps.length) return '';
        const inv = ins.op === OP.MADI;
        return assign((c) => `M(${s1(c, '')}, ${s2(c, inv ? '' : offs)}) + ${s3(c, inv ? offs : '')}`);
      }
      case OP.END: case OP.BREAK: case OP.BREAKC: case OP.CALL: case OP.CALLC: case OP.CALLU:
      case OP.IFU: case OP.IFC: case OP.LOOP: case OP.JMPC: case OP.JMPU: return null;
      default: return ''; // NOP, EMIT, SETEMIT and unknown opcodes
    }
  }
  const GLSL_LANG = {
    op: glslOp,
    cond: (ins) => {
      const x = `(cx == ${ins.refx ? 'true' : 'false'})`, y = `(cy == ${ins.refy ? 'true' : 'false'})`;
      return [`(${x} || ${y})`, `(${x} && ${y})`, x, y][ins.cop];
    },
  };

  // Vertex shader source for the current program, or null if it cannot run on the host GPU
  function genVertexShader(gpu) {
    const r = gpu.regs, vs = gpu.vs;
    const body = EMU.flattenShaderBody(vs, r[0x2BA] & 0xFFFF, GLSL_LANG);
    if (body === null) return null;
    const map = gpu.outputMap(r[0x2BD] & 0xFFFF);
    let out = 'float S[24]; for (int i = 0; i < 24; i++) S[i] = 0.0; S[3] = 1.0;\n';
    for (let k = 0; k < map.length; k += 2) out += `S[${map[k]}] = o[${map[k + 1] >> 2}].${'xyzw'[map[k + 1] & 3]};\n`;
    let inputs = '';
    for (let i = 0; i < 16; i++) inputs += `layout(location = ${i}) in vec4 v${i};\n`;
    return `#version 300 es
precision highp float;
precision highp int;
${inputs}
uniform vec4 C[96];
uniform vec2 uDepth; // PICA depth = scale * z / w + offset
out vec4 vColor; out vec4 vUV01; out vec4 vUV2W; out vec4 vQuat; out vec3 vView;
vec4 r[16]; vec4 o[16];
int a0x = 0, a0y = 0;
bool cx = false, cy = false;
float M(float a, float b) { float p = a * b; return (p != p && a == a && b == b) ? 0.0 : p; } // 0 * inf = 0
float MX(float a, float b) { return a > b ? a : b; }
float MN(float a, float b) { return a < b ? a : b; }
vec4 CR(int i) { return i >= 0 && i < 96 ? C[i] : vec4(0.0); }
void run() {
${body}}
void main() {
  for (int i = 0; i < 16; i++) { r[i] = vec4(0.0); o[i] = vec4(0.0); }
  run();
  ${out}
  // Window depth equals the PICA depth value, and clipping matches its near/far planes for the usual setup
  gl_Position = vec4(S[0], S[1], 2.0 * uDepth.x * S[2] + (2.0 * uDepth.y - 1.0) * S[3], S[3]);
  vColor = min(abs(vec4(S[8], S[9], S[10], S[11])), vec4(1.0));
  vUV01 = vec4(S[12], S[13], S[14], S[15]);
  vUV2W = vec4(S[22], S[23], S[16], 0.0);
  vQuat = vec4(S[4], S[5], S[6], S[7]);
  vView = vec3(S[18], S[19], S[20]);
}`;
  }

  // GL enums for PICA state
  const GL_FUNC = [0x0200, 0x0207, 0x0202, 0x0205, 0x0201, 0x0203, 0x0204, 0x0206]; // never..gequal
  const GL_STENCIL_OP = [0x1E00, 0, 0x1E01, 0x1E02, 0x1E03, 0x150A, 0x8507, 0x8508];  // keep, zero, replace, incr, decr, invert, incr_wrap, decr_wrap
  const GL_BLEND_EQ = [0x8006, 0x800A, 0x800B, 0x8007, 0x8008];                      // add, subtract, reverse subtract, min, max
  const GL_BLEND_FACTOR = [0, 1, 0x0300, 0x0301, 0x0306, 0x0307, 0x0302, 0x0303, 0x0304, 0x0305, 0x8001, 0x8002, 0x8003, 0x8004, 0x0308];

  class GLRenderer {
    constructor(canvas) {
      const gl = canvas.getContext('webgl2', { antialias: false, depth: false, stencil: false, alpha: false, preserveDrawingBuffer: false, powerPreference: 'high-performance' });
      if (!gl) throw new Error('WebGL 2 is not available');
      this.gl = gl;
      this.canvas = canvas;
      this.gpu = null;
      this.batch = new Float32Array(VTX * 3 * 8192);
      this.count = 0;           // vertices in the batch
      this.batchState = null;
      this.surfaces = [];
      this.programs = new Map();
      this.samplers = new Map();
      this.texObjects = new Map(); // decoded texture cache entry -> GL texture
      this.stats = { draws: 0, readbacks: 0, uploads: 0 };
      this.hwVertices = true; // shade vertices on the host GPU when possible (false: on the CPU)
      this.warned = new Set();
      this.scratch = new Uint8Array(0);

      this.vbo = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
      gl.bufferData(gl.ARRAY_BUFFER, this.batch.byteLength, gl.DYNAMIC_DRAW);
      this.vao = gl.createVertexArray();
      gl.bindVertexArray(this.vao);
      const sizes = [4, 4, 4, 4, 4, 3];
      let off = 0;
      sizes.forEach((n, i) => { gl.enableVertexAttribArray(i); gl.vertexAttribPointer(i, n, gl.FLOAT, false, VTX * 4, off * 4); off += n; });
      this.cpuVert = { id: 0, shader: this.compile(gl.VERTEX_SHADER, VERTEX_SHADER) };
      this.fragShaders = new Map();
      this.vertShaders = new Map(); // compiled PICA program (JS function) -> output map -> { id, shader } or null
      this.vertIds = 1;
      // Vertex arrays for draws whose vertices are shaded on the host GPU
      this.hwVao = gl.createVertexArray();
      this.hwBuffers = Array.from({ length: 12 }, () => gl.createBuffer());
      this.hwIndex = gl.createBuffer();

      // Lighting and fog lookup tables: (value, difference to the next entry) per entry
      this.lutTex = this.floatTexture(256, 24);
      this.fogTex = this.floatTexture(128, 1);
      this.lutData = new Float32Array(256 * 24 * 2);
      this.fogData = new Float32Array(128 * 2);

      // Programs for loading depth/stencil from memory
      this.depthProg = this.link(this.compile(gl.VERTEX_SHADER, `#version 300 es
        layout(location = 0) in vec4 aPos; void main() { gl_Position = vec4(aPos.xy, 0.0, 1.0); }`), this.compile(gl.FRAGMENT_SHADER, `#version 300 es
        precision highp float; uniform highp sampler2D uDepth; uniform int uBit; out vec4 c;
        void main() { vec2 d = texelFetch(uDepth, ivec2(gl_FragCoord.xy), 0).rg; gl_FragDepth = d.r;
          if (uBit >= 0 && ((int(d.g) >> uBit) & 1) == 0) discard; c = vec4(0.0); }`));
      this.quad = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 0, 0, 1, -1, 0, 0, -1, 1, 0, 0, 1, 1, 0, 0]), gl.STATIC_DRAW);
      this.quadVao = gl.createVertexArray();
      gl.bindVertexArray(this.quadVao);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 16, 0);
      gl.bindVertexArray(null);
      this.depthTex = this.floatTexture(1, 1);
      const quadVs = this.compile(gl.VERTEX_SHADER, `#version 300 es
        layout(location = 0) in vec4 aPos; void main() { gl_Position = vec4(aPos.xy, 0.0, 1.0); }`);
      // Display transfer: dst texel (x, row) = src pixel (x << sx, y << sy), y = row (or flipped); src rows are bottom-up
      this.transferProg = this.link(quadVs, this.compile(gl.FRAGMENT_SHADER, `#version 300 es
        precision highp float; precision highp int;
        uniform sampler2D uSrc; uniform ivec4 uIn; uniform ivec4 uOut; out vec4 c;
        void main() {
          int x = int(gl_FragCoord.x), row = int(gl_FragCoord.y);
          int y = uOut.z != 0 ? uOut.y - 1 - row : row;
          int ix = x << uOut.w, iy = y << uIn.w;
          if (ix >= uIn.x || iy >= uIn.y) { c = vec4(0.0); return; }
          c = texelFetch(uSrc, ivec2(ix, uIn.z - 1 - iy), 0);
        }`));
      // Present: a screen framebuffer is stored column by column (memory row = screen x, column = 239 - screen y)
      this.presentProg = this.link(quadVs, this.compile(gl.FRAGMENT_SHADER, `#version 300 es
        precision highp float; precision highp int;
        uniform sampler2D uSrc; uniform ivec2 uOrigin; out vec4 c;
        void main() { c = vec4(texelFetch(uSrc, ivec2(uOrigin.x + int(gl_FragCoord.y), uOrigin.y + int(gl_FragCoord.x)), 0).rgb, 1.0); }`));
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.pixelStorei(gl.PACK_ALIGNMENT, 1);
    }

    // Start over for a newly loaded title
    attach(gpu) {
      const gl = this.gl;
      for (const s of this.surfaces) this.deleteSurface(s);
      this.surfaces = [];
      for (const t of this.texObjects.values()) gl.deleteTexture(t);
      this.texObjects.clear();
      this.count = 0; this.batchState = null;
      this.gpu = gpu;
    }

    warn(key, msg) { if (!this.warned.has(key)) { this.warned.add(key); if (this.gpu) this.gpu.warn(key, msg); } }

    compile(type, src) {
      const gl = this.gl, s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(`GL shader: ${gl.getShaderInfoLog(s)}\n${src}`);
      return s;
    }

    link(vs, fs) {
      const gl = this.gl, p = gl.createProgram();
      gl.attachShader(p, vs); gl.attachShader(p, fs);
      gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`GL link: ${gl.getProgramInfoLog(p)}`);
      return p;
    }

    floatTexture(w, h) {
      const gl = this.gl, t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG32F, w, h, 0, gl.RG, gl.FLOAT, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return t;
    }

    // ---------------------------------------------------------------- triangles
    // a, b, c: screen vertices from Gpu.toScreen ({ x, y, z, iw, a: attributes })
    triangle(st, a, b, c) {
      // Culling and degenerate triangles, decided as the software rasterizer does
      const x0 = Math.round(a.x * 16), y0 = Math.round(a.y * 16), x1 = Math.round(b.x * 16), y1 = Math.round(b.y * 16);
      const x2 = Math.round(c.x * 16), y2 = Math.round(c.y * 16);
      const area = (x1 - x0) * (y2 - y0) - (y1 - y0) * (x2 - x0);
      if (area === 0 || (st.cull === 1 && area > 0) || (st.cull === 2 && area < 0)) return;
      if (st !== this.batchState) { this.flush(); this.batchState = st; }
      if ((this.count + 3) * VTX > this.batch.length) this.flush();
      const lit = !!st.lighting;
      for (const v of [a, b, c]) {
        const o = this.count++ * VTX, B = this.batch, A = v.a;
        B[o] = v.x; B[o + 1] = v.y; B[o + 2] = v.z * st.depthScale + st.depthOffset; B[o + 3] = 1 / v.iw;
        B[o + 4] = A[8]; B[o + 5] = A[9]; B[o + 6] = A[10]; B[o + 7] = A[11];
        B[o + 8] = A[12]; B[o + 9] = A[13]; B[o + 10] = A[14]; B[o + 11] = A[15];
        B[o + 12] = A[22]; B[o + 13] = A[23]; B[o + 14] = A[16]; B[o + 15] = 0;
        if (lit) {
          // Quaternions are interpolated along the short arc, relative to the first vertex
          let s = 1;
          if (v !== a) { const q = a.a; s = q[4] * A[4] + q[5] * A[5] + q[6] * A[6] + q[7] * A[7] < 0 ? -1 : 1; }
          B[o + 16] = A[4] * s; B[o + 17] = A[5] * s; B[o + 18] = A[6] * s; B[o + 19] = A[7] * s;
          B[o + 20] = A[18]; B[o + 21] = A[19]; B[o + 22] = A[20];
        }
      }
    }

    flush() {
      if (!this.count) return;
      const st = this.batchState, n = this.count;
      this.count = 0;
      this.draw(st, n);
    }

    // ---------------------------------------------------------------- surfaces
    surface(kind, phys, w, h, fmt) {
      const bpp = kind === 'color' ? COLOR_BPP[fmt] || 4 : [2, 2, 3, 4][fmt];
      const bytes = w * h * bpp;
      let s = this.surfaces.find((x) => x.kind === kind && x.phys === phys && x.w === w && x.h === h && x.fmt === fmt);
      // Overlapping surfaces with newer pixels: write them back first; this one then reloads from memory
      for (const o of this.surfaces) {
        if (o === s || !o.dirty || o.phys >= phys + bytes || o.phys + o.bytes <= phys) continue;
        this.writeBack(o);
        if (s) s.stale = true;
      }
      if (!s) {
        const gl = this.gl;
        s = { kind, phys, w, h, fmt, bpp, bytes, dirty: false, stale: true, used: 0 };
        if (kind === 'color') {
          s.tex = gl.createTexture();
          gl.bindTexture(gl.TEXTURE_2D, s.tex);
          gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, w, h);
        } else {
          s.rb = gl.createRenderbuffer();
          gl.bindRenderbuffer(gl.RENDERBUFFER, s.rb);
          gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH24_STENCIL8, w, h);
        }
        s.fbos = new Map();
        this.surfaces.push(s);
        if (this.surfaces.length > 48) this.evict();
      }
      s.used = this.stats.draws;
      if (s.stale) this.upload(s);
      return s;
    }

    evict() {
      const old = this.surfaces.filter((s) => !s.dirty).sort((a, b) => a.used - b.used).slice(0, 16);
      for (const s of old) { this.deleteSurface(s); this.surfaces.splice(this.surfaces.indexOf(s), 1); }
    }

    deleteSurface(s) {
      const gl = this.gl;
      if (s.dirty) this.writeBack(s);
      for (const o of this.surfaces) for (const [k, fb] of o.fbos) if (k === s || o === s) { gl.deleteFramebuffer(fb); o.fbos.delete(k); }
      if (s.tex) gl.deleteTexture(s.tex);
      if (s.rb) gl.deleteRenderbuffer(s.rb);
    }

    // Framebuffer for a color surface (or a scratch one) and an optional depth surface
    framebuffer(color, depth) {
      const gl = this.gl;
      let fb = color.fbos.get(depth || 0);
      if (fb) return fb;
      fb = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, color.tex, 0);
      if (depth) gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_STENCIL_ATTACHMENT, gl.RENDERBUFFER, depth.rb);
      color.fbos.set(depth || 0, fb);
      return fb;
    }

    // A color surface to pair with a depth-only draw
    scratchColor(w, h) {
      let s = this.surfaces.find((x) => x.kind === 'scratch' && x.w === w && x.h === h);
      if (!s) {
        const gl = this.gl;
        s = { kind: 'scratch', phys: -1, w, h, fmt: 0, bpp: 4, bytes: 0, dirty: false, stale: false, used: 0, fbos: new Map(), tex: gl.createTexture() };
        gl.bindTexture(gl.TEXTURE_2D, s.tex);
        gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, w, h);
        this.surfaces.push(s);
      }
      return s;
    }

    span(s) { return this.gpu.span(s.phys, s.bytes); }

    // Memory -> graphics card
    upload(s) {
      s.stale = false;
      const sp = this.span(s);
      if (!sp) return;
      const gl = this.gl, { w, h, bpp } = s, u8 = sp.u8, base = sp.off;
      this.stats.uploads++;
      const filled = s.fill;
      s.fill = null;
      if (s.kind === 'color') {
        // Every pixel the same (always after a fill that lines up): a clear instead of an upload
        let same = true;
        if (!filled) for (let o = base + bpp; o < base + s.bytes && same; o += bpp) for (let k = 0; k < bpp; k++) if (u8[o + k] !== u8[base + k]) { same = false; break; }
        if (same) {
          const c = decodeColor(s.fmt, u8, base);
          if (!HAS_ALPHA[s.fmt]) c[3] = 255;
          gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer(s, null));
          gl.disable(gl.SCISSOR_TEST);
          gl.colorMask(true, true, true, true);
          gl.clearBufferfv(gl.COLOR, 0, c.map((v) => v / 255));
          return;
        }
        const px = this.scratchBuffer(w * h * 4);
        const alpha = HAS_ALPHA[s.fmt];
        for (let y = 0; y < h; y++) {
          const row = h - 1 - y;
          for (let x = 0; x < w; x++) {
            const o = base + tiled(x, row, w, bpp), p = (y * w + x) * 4;
            let r, g, b, a = 255;
            switch (s.fmt) {
              case 0: r = u8[o + 3]; g = u8[o + 2]; b = u8[o + 1]; a = u8[o]; break;
              case 1: r = u8[o + 2]; g = u8[o + 1]; b = u8[o]; break;
              case 2: { const v = u8[o] | (u8[o + 1] << 8); r = (v >>> 11) & 31; g = (v >>> 6) & 31; b = (v >>> 1) & 31; r = (r << 3) | (r >> 2); g = (g << 3) | (g >> 2); b = (b << 3) | (b >> 2); a = v & 1 ? 255 : 0; break; }
              case 3: { const v = u8[o] | (u8[o + 1] << 8); r = (v >>> 11) & 31; g = (v >>> 5) & 63; b = v & 31; r = (r << 3) | (r >> 2); g = (g << 2) | (g >> 4); b = (b << 3) | (b >> 2); break; }
              default: { const v = u8[o] | (u8[o + 1] << 8); r = ((v >>> 12) & 15) * 17; g = ((v >>> 8) & 15) * 17; b = ((v >>> 4) & 15) * 17; a = (v & 15) * 17; }
            }
            px[p] = r; px[p + 1] = g; px[p + 2] = b; px[p + 3] = alpha ? a : 255;
          }
        }
        gl.bindTexture(gl.TEXTURE_2D, s.tex);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
        return;
      }
      // Depth (and stencil): a plain clear when every pixel holds the same value (the usual memory fill)
      const max = s.fmt === 0 ? 0xFFFF : 0xFFFFFF;
      const depthAt = (o) => (bpp === 2 ? u8[o] | (u8[o + 1] << 8) : u8[o] | (u8[o + 1] << 8) | (u8[o + 2] << 16));
      let same = true;
      const d0 = depthAt(base), s0 = bpp === 4 ? u8[base + 3] : 0;
      if (!filled) for (let o = base; o < base + s.bytes && same; o += bpp) same = depthAt(o) === d0 && (bpp !== 4 || u8[o + 3] === s0);
      const fb = this.framebuffer(this.scratchColor(w, h), s);
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.disable(gl.SCISSOR_TEST);
      gl.depthMask(true); gl.stencilMask(0xFF);
      if (same) { gl.clearBufferfi(gl.DEPTH_STENCIL, 0, d0 / max, s0); return; }
      // Otherwise draw the values: depth with gl_FragDepth, stencil one bit at a time
      const data = new Float32Array(w * h * 2);
      for (let y = 0; y < h; y++) {
        const row = h - 1 - y;
        for (let x = 0; x < w; x++) { const o = base + tiled(x, row, w, bpp), p = (y * w + x) * 2; data[p] = depthAt(o) / max; data[p + 1] = bpp === 4 ? u8[o + 3] : 0; }
      }
      gl.activeTexture(gl.TEXTURE0);
      gl.bindSampler(0, null); // float textures are not filterable: use the texture's own nearest filtering
      gl.bindTexture(gl.TEXTURE_2D, this.depthTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG32F, w, h, 0, gl.RG, gl.FLOAT, data);
      gl.useProgram(this.depthProg);
      gl.uniform1i(gl.getUniformLocation(this.depthProg, 'uDepth'), 0);
      const bitLoc = gl.getUniformLocation(this.depthProg, 'uBit');
      gl.viewport(0, 0, w, h);
      gl.bindVertexArray(this.quadVao);
      gl.colorMask(false, false, false, false);
      gl.disable(gl.BLEND);
      gl.disable(gl.CULL_FACE); // the quad must not depend on the last draw's culling
      gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.ALWAYS);
      gl.clearBufferfi(gl.DEPTH_STENCIL, 0, 1, 0);
      gl.disable(gl.STENCIL_TEST);
      gl.uniform1i(bitLoc, -1);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      if (bpp === 4) {
        gl.depthMask(false);
        gl.enable(gl.STENCIL_TEST);
        gl.stencilOp(gl.KEEP, gl.KEEP, gl.REPLACE);
        gl.stencilFunc(gl.ALWAYS, 0xFF, 0xFF);
        for (let bit = 0; bit < 8; bit++) { gl.stencilMask(1 << bit); gl.uniform1i(bitLoc, bit); gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4); }
      }
      gl.bindVertexArray(this.vao);
    }

    scratchBuffer(n) {
      if (this.scratch.length < n) this.scratch = new Uint8Array(n);
      return this.scratch.subarray(0, n);
    }

    // Graphics card -> memory
    writeBack(s) {
      s.dirty = false;
      if (s.kind === 'linear') { this.writeBackLinear(s); return; }
      if (s.kind !== 'color') { this.warn('depthread', 'GPU (WebGL): depth buffers are not copied back to memory'); return; }
      const sp = this.span(s);
      if (!sp) return;
      const gl = this.gl, { w, h, bpp } = s, u8 = sp.u8, base = sp.off;
      this.stats.readbacks++;
      const px = this.scratchBuffer(w * h * 4);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer(s, null));
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
      // One loop per format; pixels are read as 32-bit words (R, G, B, A bytes)
      const p32 = new Uint32Array(px.buffer, px.byteOffset, w * h), fmt = s.fmt, tilesX = w >> 3;
      const out32 = fmt === 0 && !((u8.byteOffset + base) & 3) ? new Uint32Array(u8.buffer, u8.byteOffset + base, s.bytes >> 2) : null;
      for (let y = 0; y < h; y++) {
        const row = h - 1 - y, rowTile = (row >> 3) * tilesX, m = (row & 7) * 8;
        for (let x = 0, p = y * w; x < w; x++, p++) {
          const i = ((rowTile + (x >> 3)) << 6) + MORTON[m + (x & 7)], v = p32[p];
          if (fmt === 0) {
            const word = ((v & 255) << 24 | ((v >>> 8) & 255) << 16 | ((v >>> 16) & 255) << 8 | (v >>> 24)) >>> 0; // A, B, G, R in memory
            if (out32) out32[i] = word; else { const o = base + i * 4; u8[o] = word; u8[o + 1] = word >>> 8; u8[o + 2] = word >>> 16; u8[o + 3] = word >>> 24; }
            continue;
          }
          const r = v & 255, g = (v >>> 8) & 255, b = (v >>> 16) & 255, a = v >>> 24;
          if (fmt === 1) { const o = base + i * 3; u8[o] = b; u8[o + 1] = g; u8[o + 2] = r; continue; }
          const o = base + i * 2;
          const c = fmt === 2 ? ((r >> 3) << 11) | ((g >> 3) << 6) | ((b >> 3) << 1) | (a >> 7)
            : fmt === 3 ? ((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3)
              : ((r >> 4) << 12) | ((g >> 4) << 8) | ((b >> 4) << 4) | (a >> 4);
          u8[o] = c; u8[o + 1] = c >> 8;
        }
      }
      if (sp.copy) this.gpu.mem.writeBytes(sp.virt, sp.u8.subarray(0, s.bytes));
      this.gpu.staleTextures(s.phys, s.bytes);
    }

    // A display transfer output (GSP formats: RGBA8, RGB8, RGB565, RGB5A1, RGBA4), rows in memory order
    writeBackLinear(s) {
      const sp = this.span(s);
      if (!sp) return;
      const gl = this.gl, { w, h, bpp } = s, u8 = sp.u8, base = sp.off;
      this.stats.readbacks++;
      const px = this.scratchBuffer(w * h * 4);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer(s, null));
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
      for (let i = 0, p = 0; i < w * h; i++, p += 4) {
        const r = px[p], g = px[p + 1], b = px[p + 2], a = px[p + 3], o = base + i * bpp;
        switch (s.fmt) {
          case 0: u8[o] = a; u8[o + 1] = b; u8[o + 2] = g; u8[o + 3] = r; break;
          case 1: u8[o] = b; u8[o + 1] = g; u8[o + 2] = r; break;
          case 2: { const v = ((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3); u8[o] = v; u8[o + 1] = v >> 8; break; }
          case 3: { const v = ((r >> 3) << 11) | ((g >> 3) << 6) | ((b >> 3) << 1) | (a >> 7); u8[o] = v; u8[o + 1] = v >> 8; break; }
          default: { const v = ((r >> 4) << 12) | ((g >> 4) << 8) | ((b >> 4) << 4) | (a >> 4); u8[o] = v; u8[o + 1] = v >> 8; }
        }
      }
      if (sp.copy) this.gpu.mem.writeBytes(sp.virt, sp.u8.subarray(0, s.bytes));
      this.gpu.staleTextures(s.phys, s.bytes);
    }

    // GSP display transfer from a render target held here: done on the host GPU into a linear surface that stands
    // for the destination memory. False: not a case handled here (the caller copies in memory).
    displayTransfer(srcPhys, dstPhys, inW, inH, outW, outH, inFmt, outFmt, flags) {
      if (flags & 0xA) return false; // raw copies and tiled output
      if (this.count) this.flush();
      const src = this.surfaces.find((x) => x.kind === 'color' && x.phys === srcPhys && x.w === inW && x.h === inH && !x.stale);
      if (!src || !src.dirty) return false; // memory already holds the pixels: the CPU copy is as good
      const bpp = [4, 3, 2, 2, 2][outFmt] || 4, bytes = outW * outH * bpp;
      let dst = this.surfaces.find((x) => x.kind === 'linear' && x.phys === dstPhys && x.w === outW && x.h === outH && x.fmt === outFmt);
      for (const o of this.surfaces) { // anything else held for the destination memory is replaced
        if (o === dst || o === src || o.phys >= dstPhys + bytes || o.phys + o.bytes <= dstPhys) continue;
        o.dirty = false; o.stale = true;
      }
      const gl = this.gl;
      if (!dst) {
        dst = { kind: 'linear', phys: dstPhys, w: outW, h: outH, fmt: outFmt, bpp, bytes, dirty: false, stale: false, used: 0, fbos: new Map(), tex: gl.createTexture() };
        gl.bindTexture(gl.TEXTURE_2D, dst.tex);
        gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, outW, outH);
        this.surfaces.push(dst);
      }
      dst.used = this.stats.draws;
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer(dst, null));
      gl.viewport(0, 0, outW, outH);
      gl.disable(gl.BLEND); gl.disable(gl.DEPTH_TEST); gl.disable(gl.STENCIL_TEST); gl.disable(gl.SCISSOR_TEST); gl.disable(gl.CULL_FACE);
      gl.colorMask(true, true, true, true);
      gl.useProgram(this.transferProg);
      gl.activeTexture(gl.TEXTURE0); gl.bindSampler(0, null); gl.bindTexture(gl.TEXTURE_2D, src.tex);
      const scale = (flags >> 24) & 3;
      gl.uniform1i(gl.getUniformLocation(this.transferProg, 'uSrc'), 0);
      gl.uniform4i(gl.getUniformLocation(this.transferProg, 'uIn'), inW, inH, src.h, scale === 2 ? 1 : 0);
      gl.uniform4i(gl.getUniformLocation(this.transferProg, 'uOut'), outW, outH, flags & 1, scale ? 1 : 0);
      gl.bindVertexArray(this.quadVao);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      gl.bindVertexArray(this.vao);
      dst.dirty = true; dst.stale = false;
      this.gpu.staleTextures(dstPhys, bytes);
      this.stats.transfers = (this.stats.transfers || 0) + 1;
      return true;
    }

    // Show a screen whose framebuffer is a display transfer output held here: drawn straight onto ctx (a 2D
    // canvas of W x 240). False: present from memory instead.
    present(phys, format, stride, W, ctx) {
      const s = this.surfaces.find((x) => x.kind === 'linear' && x.dirty && phys >= x.phys && phys < x.phys + x.bytes);
      if (!s || (format & 7) !== s.fmt || stride !== s.w * s.bpp) return false;
      const off = phys - s.phys, row = Math.floor(off / stride), col = (off % stride) / s.bpp;
      if (!Number.isInteger(col) || col + 240 > s.w || row + W > s.h) return false;
      const gl = this.gl, c = this.canvas;
      if (c.width !== W || c.height !== 240) { c.width = W; c.height = 240; }
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, W, 240);
      gl.disable(gl.BLEND); gl.disable(gl.DEPTH_TEST); gl.disable(gl.STENCIL_TEST); gl.disable(gl.SCISSOR_TEST); gl.disable(gl.CULL_FACE);
      gl.colorMask(true, true, true, true);
      gl.useProgram(this.presentProg);
      gl.activeTexture(gl.TEXTURE0); gl.bindSampler(0, null); gl.bindTexture(gl.TEXTURE_2D, s.tex);
      gl.uniform1i(gl.getUniformLocation(this.presentProg, 'uSrc'), 0);
      gl.uniform2i(gl.getUniformLocation(this.presentProg, 'uOrigin'), col, row);
      gl.bindVertexArray(this.quadVao);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      gl.bindVertexArray(this.vao);
      ctx.drawImage(c, 0, 0);
      return true;
    }

    // Something is about to read [phys, phys + size) from memory: write back render targets there
    syncToMemory(phys, size) {
      if (this.count) this.flush();
      for (const s of this.surfaces) if (s.dirty && s.phys < phys + size && s.phys + s.bytes > phys) this.writeBack(s);
    }

    // [phys, phys + size) was written in memory: surfaces there reload before their next use
    memoryWritten(phys, size, fill) {
      for (const s of this.surfaces) {
        if (s.phys >= phys + size || s.phys + s.bytes <= phys) continue;
        if (s.dirty && !fill) this.warn('overwrite', 'GPU (WebGL): memory written over a render target that had not been read back');
        s.dirty = false; s.stale = true;
        // A fill covering the whole surface with a pattern that lines up with its pixels: every pixel is the same
        const covers = fill && s.phys >= phys && s.phys + s.bytes <= phys + size;
        s.fill = covers && s.bpp % fill.bytes === 0 && (s.phys - phys) % fill.bytes === 0 ? fill : null;
      }
    }

    // The CPU flushed its cache over [phys, phys + size): surfaces whose pixels memory already holds reload
    // (the CPU may have drawn there); ones with newer pixels on the host GPU keep them
    cacheFlushed(phys, size) {
      for (const s of this.surfaces) if (!s.dirty && s.phys < phys + size && s.phys + s.bytes > phys) s.stale = true;
    }

    // ---------------------------------------------------------------- drawing
    // Fragment shader for a render state: { key, shader }
    fragmentShader(st) {
      if (st.glFrag) return st.glFrag; // a state's shader never changes
      const key = JSON.stringify([st.tev.map((s) => (s.passthrough ? 0 : [s.rgbSrc, s.aSrc, s.rgbOp, s.aOp, s.rgbCmb, s.aCmb, s.rgbScale, s.aScale])),
        st.updRGB, st.updA, st.tex2uv1, st.fog, st.fogFlip, st.alphaTest ? st.alphaFunc : -1, st.blend ? -1 : st.logic,
        st.textures.map((t) => t && [t.wrapS === 1, t.wrapT === 1, t.project]), lightKey(st.lighting)]);
      let f = this.fragShaders.get(key);
      if (!f) {
        f = { key, shader: this.compile(this.gl.FRAGMENT_SHADER, genFragment(st)) };
        if (this.fragShaders.size > 400) this.fragShaders.clear();
        this.fragShaders.set(key, f);
      }
      st.glFrag = f;
      return f;
    }

    // Linked program for a vertex shader ({ id, shader }; default: the one for CPU-processed vertices) and a state
    program(st, vert = this.cpuVert) {
      const frag = this.fragmentShader(st), key = `${vert.id}|${frag.key}`;
      let p = this.programs.get(key);
      if (!p) {
        const gl = this.gl;
        const prog = this.link(vert.shader, frag.shader);
        const loc = (n) => gl.getUniformLocation(prog, n);
        p = { prog, u: {} };
        for (const n of ['uSize', 'uTex0', 'uTex1', 'uTex2', 'uLut', 'uFogLut', 'uBorder', 'uK', 'uBufInit', 'uAlphaRef', 'uFogColor',
          'uLSpec0', 'uLSpec1', 'uLDiff', 'uLAmb', 'uLPos', 'uLSpot', 'uLAtt', 'uAmbient', 'C', 'uDepth']) p.u[n] = loc(n);
        gl.useProgram(prog);
        gl.uniform1i(p.u.uTex0, 0); gl.uniform1i(p.u.uTex1, 1); gl.uniform1i(p.u.uTex2, 2);
        gl.uniform1i(p.u.uLut, 3); gl.uniform1i(p.u.uFogLut, 4);
        if (this.programs.size > 400) this.programs.clear();
        this.programs.set(key, p);
      }
      return p;
    }

    sampler(T) {
      const key = T.wrapS * 64 + T.wrapT * 2 + T.linear;
      let s = this.samplers.get(key);
      if (!s) {
        const gl = this.gl, wrap = (m) => [gl.CLAMP_TO_EDGE, gl.CLAMP_TO_EDGE, gl.REPEAT, gl.MIRRORED_REPEAT][m] || gl.CLAMP_TO_EDGE;
        s = gl.createSampler();
        gl.samplerParameteri(s, gl.TEXTURE_WRAP_S, wrap(T.wrapS));
        gl.samplerParameteri(s, gl.TEXTURE_WRAP_T, wrap(T.wrapT));
        const filter = T.linear ? gl.LINEAR : gl.NEAREST;
        gl.samplerParameteri(s, gl.TEXTURE_MIN_FILTER, filter);
        gl.samplerParameteri(s, gl.TEXTURE_MAG_FILTER, filter);
        this.samplers.set(key, s);
      }
      return s;
    }

    textureObject(T) {
      const entry = T.entry, gl = this.gl;
      let t = this.texObjects.get(entry);
      if (!t) {
        t = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, t);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, T.w, T.h, 0, gl.RGBA, gl.UNSIGNED_BYTE, T.data);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAX_LEVEL, 0);
        this.texObjects.set(entry, t);
        entry.dirtyTiles = null;
      } else if (entry.dirtyTiles) this.updateTexture(t, T, entry);
      return t;
    }

    // Upload the tiles of a decoded texture that were decoded again (entry.dirtyTiles), one rectangle per run
    // of changed tiles in a tile row
    updateTexture(t, T, entry) {
      const gl = this.gl, w = T.w, h = T.h, tilesX = w >> 3;
      const tiles = [...new Set(entry.dirtyTiles)].sort((a, b) => a - b);
      entry.dirtyTiles = null;
      if (this.count) this.flush(); // queued triangles sample the old texels
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.pixelStorei(gl.UNPACK_ROW_LENGTH, w);
      for (let i = 0; i < tiles.length;) {
        const ty = (tiles[i] / tilesX) | 0, x0 = tiles[i] % tilesX;
        let x1 = x0;
        while (i + 1 < tiles.length && tiles[i + 1] === tiles[i] + 1 && ((tiles[i + 1] / tilesX) | 0) === ty) { i++; x1++; }
        i++;
        const row = h - 8 - ty * 8; // tile row ty covers data rows h - 8 - 8ty .. h - 1 - 8ty
        gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, x0 * 8);
        gl.pixelStorei(gl.UNPACK_SKIP_ROWS, row);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, x0 * 8, row, (x1 - x0 + 1) * 8, 8, gl.RGBA, gl.UNSIGNED_BYTE, T.data);
      }
      gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
      gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0);
      gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 0);
      this.stats.texUpdates = (this.stats.texUpdates || 0) + 1;
    }

    // Free GL textures of decoded textures the GPU cache dropped
    endFrame() {
      if (this.count) this.flush();
      if (this.texObjects.size < 64) return;
      const live = new Set(this.gpu.texCache.values());
      for (const [entry, t] of this.texObjects) if (!live.has(entry)) { this.gl.deleteTexture(t); this.texObjects.delete(entry); }
    }

    updateLuts() {
      const gpu = this.gpu, gl = this.gl;
      if (gpu.lutDirty) {
        gpu.lutDirty = false;
        const d = this.lutData;
        gl.bindTexture(gl.TEXTURE_2D, this.lutTex);
        for (let id = 0; id < 24; id++) {
          if (!(gpu.lutRows & (1 << id))) continue; // only the tables that changed
          const lut = gpu.lut[id];
          for (let i = 0; i < 256; i++) {
            const e = lut[i], o = (id * 256 + i) * 2;
            d[o] = (e & 0xFFF) / 4095; d[o + 1] = (((e >>> 12) & 0xFFF) << 20 >> 20) / 4095;
          }
          gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, id, 256, 1, gl.RG, gl.FLOAT, d, id * 512);
        }
        gpu.lutRows = 0;
      }
      if (gpu.fogDirty) {
        gpu.fogDirty = false;
        const d = this.fogData;
        for (let i = 0; i < 128; i++) { const e = gpu.fogLut[i]; d[i * 2] = ((e >>> 13) & 0x7FF) / 2047; d[i * 2 + 1] = (((e & 0x1FFF) << 19) >> 19) / 2047; }
        gl.bindTexture(gl.TEXTURE_2D, this.fogTex);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 128, 1, gl.RG, gl.FLOAT, d);
      }
    }

    draw(st, n) {
      const gl = this.gl;
      const p = this.setup(st);
      if (!p) return;
      gl.disable(gl.CULL_FACE); // culled with the software rules already
      gl.uniform2f(p.u.uSize, st.fbW, st.fbH);
      gl.viewport(0, 0, st.fbW, st.fbH);
      gl.bindVertexArray(this.vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.batch, 0, n * VTX);
      gl.drawArrays(gl.TRIANGLES, 0, n);
      this.drawn(st, p);
    }

    // Mark what a draw wrote
    drawn(st, p) {
      if (p.color && p.cm) p.color.dirty = true;
      if (p.depth && (st.depthWrite || (st.stencil && st.stencilWriteMask))) p.depth.dirty = true;
    }

    // Bind the render targets, program, textures and fixed-function state for st. Returns the program
    // (with color, depth and cm, the color write mask) or null when there is nothing to draw into.
    setup(st, vert) {
      const gl = this.gl;
      this.stats.draws++;
      const color = st.color && this.surface('color', st.color.phys, st.fbW, st.fbH, st.colorFmt);
      const depth = st.depth && this.surface('depth', st.depth.phys, st.fbW, st.fbH, st.depthFmt);
      if (!color && !depth) return null;
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer(color || this.scratchColor(st.fbW, st.fbH), depth));
      this.updateLuts();

      const p = this.program(st, vert), u = p.u;
      gl.useProgram(p.prog);
      const k = new Float32Array(24);
      st.tev.forEach((s, i) => k.set(s.konst, i * 4));
      gl.uniform4fv(u.uK, k);
      gl.uniform4f(u.uBufInit, ...st.bufferInit);
      gl.uniform1f(u.uAlphaRef, st.alphaRef);
      gl.uniform3f(u.uFogColor, ...st.fogColor);
      const border = new Float32Array(12);
      for (let t = 0; t < 3; t++) {
        const T = st.textures[t];
        gl.activeTexture(gl.TEXTURE0 + t);
        if (!T) { gl.bindTexture(gl.TEXTURE_2D, null); continue; }
        gl.bindTexture(gl.TEXTURE_2D, this.textureObject(T));
        gl.bindSampler(t, this.sampler(T));
        border.set(T.border, t * 4);
      }
      gl.uniform4fv(u.uBorder, border);
      gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, this.lutTex);
      gl.activeTexture(gl.TEXTURE4); gl.bindTexture(gl.TEXTURE_2D, this.fogTex);
      const L = st.lighting;
      if (L) {
        const arr = (pick) => { const a = new Float32Array(24); L.lights.forEach((l, i) => a.set(pick(l), i * 3)); return a; };
        gl.uniform3fv(u.uLSpec0, arr((l) => l.spec0)); gl.uniform3fv(u.uLSpec1, arr((l) => l.spec1));
        gl.uniform3fv(u.uLDiff, arr((l) => l.diffuse)); gl.uniform3fv(u.uLAmb, arr((l) => l.ambient));
        gl.uniform3fv(u.uLPos, arr((l) => l.pos)); gl.uniform3fv(u.uLSpot, arr((l) => l.spot));
        const att = new Float32Array(16);
        L.lights.forEach((l, i) => { att[i * 2] = l.attBias; att[i * 2 + 1] = l.attScale; });
        gl.uniform2fv(u.uLAtt, att);
        gl.uniform3f(u.uAmbient, ...L.ambient);
      }

      // Output merger state
      if (st.blend) {
        gl.enable(gl.BLEND);
        gl.blendEquationSeparate(GL_BLEND_EQ[st.eqRGB] || gl.FUNC_ADD, GL_BLEND_EQ[st.eqA] || gl.FUNC_ADD);
        // WebGL cannot mix constant color and constant alpha factors: use the color ones (approximation)
        let fs = [st.srcRGB, st.dstRGB, st.srcA, st.dstA].map((x) => GL_BLEND_FACTOR[x] ?? 0);
        if (fs.some((x) => x === 0x8001 || x === 0x8002) && fs.some((x) => x === 0x8003 || x === 0x8004)) {
          this.warn('blendconst', 'GPU (WebGL): blending with both constant color and constant alpha is approximated');
          fs = fs.map((x) => (x === 0x8003 ? 0x8001 : x === 0x8004 ? 0x8002 : x));
        }
        gl.blendFuncSeparate(fs[0], fs[1], fs[2], fs[3]);
        const bc = st.blendConst;
        gl.blendColor(bc[0] / 255, bc[1] / 255, bc[2] / 255, bc[3] / 255);
      } else {
        gl.disable(gl.BLEND);
        if (![0, 3, 4, 5, 6].includes(st.logic)) this.warn(`logic${st.logic}`, `GPU (WebGL): logic op ${st.logic} is drawn as a plain copy`);
      }
      const cm = color && !(!st.blend && st.logic === 6) ? st.colorMask : 0;
      gl.colorMask(!!(cm & 1), !!(cm & 2), !!(cm & 4), !!(cm & 8) && HAS_ALPHA[st.colorFmt]);
      if (depth && (st.depthTest || st.depthWrite)) {
        gl.enable(gl.DEPTH_TEST);
        gl.depthFunc(st.depthTest ? GL_FUNC[st.depthFunc] : gl.ALWAYS);
        gl.depthMask(!!st.depthWrite);
      } else gl.disable(gl.DEPTH_TEST);
      if (depth && st.stencil) {
        gl.enable(gl.STENCIL_TEST);
        gl.stencilFunc(GL_FUNC[st.stencilFunc], st.stencilRef, st.stencilMask);
        gl.stencilOp(GL_STENCIL_OP[st.sFail], GL_STENCIL_OP[st.sZFail], GL_STENCIL_OP[st.sZPass]);
        gl.stencilMask(st.stencilWriteMask);
      } else gl.disable(gl.STENCIL_TEST);
      if (st.scissor === 3) {
        gl.enable(gl.SCISSOR_TEST);
        gl.scissor(st.sx0, st.sy0, Math.max(0, st.sx1 - st.sx0 + 1), Math.max(0, st.sy1 - st.sy0 + 1));
      } else {
        gl.disable(gl.SCISSOR_TEST);
        if (st.scissor === 1) this.warn('scissorx', 'GPU (WebGL): exclusive scissor is not emulated');
      }

      p.color = color; p.depth = depth; p.cm = cm;
      return p;
    }

    // ---------------------------------------------------------------- draws shaded on the host GPU
    // Vertex shader for the current PICA program and output map, or null (then the CPU shades the vertices)
    vertexShader(gpu) {
      const r = gpu.regs, fn = gpu.vs.program(r[0x2BA] & 0xFFFF);
      if (!fn.flat) return null;
      const mapKey = gpu.outputMap(r[0x2BD] & 0xFFFF).join(',');
      let byMap = this.vertShaders.get(fn);
      if (!byMap) { byMap = new Map(); if (this.vertShaders.size > 256) this.vertShaders.clear(); this.vertShaders.set(fn, byMap); }
      let v = byMap.get(mapKey);
      if (v === undefined) {
        const src = genVertexShader(gpu);
        v = src ? { id: this.vertIds++, shader: this.compile(this.gl.VERTEX_SHADER, src) } : null;
        byMap.set(mapKey, v);
      }
      return v;
    }

    // Draw the current vertex arrays with the vertex shader on the host GPU. False: use the CPU path instead.
    drawHardware(gpu, indexed) {
      const r = gpu.regs, gl = this.gl;
      // Mode 3 ("geometry primitive") without a geometry shader draws a triangle list, as in Gpu.submitVertex
      const topology = (r[0x25E] >>> 8) & 3;
      const count = r[0x228];
      if (!count) return true;
      const st = gpu.state || (gpu.state = gpu.buildState());
      if (!st) return true;
      if (!(st.halfW > 0 && st.halfH > 0)) return false;
      const vert = this.vertexShader(gpu);
      if (!vert) return false;

      const base = (r[0x200] & 0x1FFFFFFF) << 3;
      // Indices
      let indices = null, maxIndex;
      if (indexed) {
        const idxReg = r[0x227], u16 = idxReg >>> 31;
        const sp = gpu.span(base + (idxReg & 0x0FFFFFFF), count * (u16 ? 2 : 1));
        if (!sp) return false;
        indices = u16 ? new Uint16Array(count) : new Uint8Array(count);
        maxIndex = 0;
        for (let k = 0; k < count; k++) {
          const o = sp.off + k * (u16 ? 2 : 1), v = u16 ? sp.u8[o] | (sp.u8[o + 1] << 8) : sp.u8[o];
          indices[k] = v;
          if (v > maxIndex) maxIndex = v;
        }
      } else maxIndex = r[0x22A] + count - 1;

      // Vertex arrays: the 12 loaders, each a buffer of interleaved attributes
      const fmtLo = r[0x201], fmtHi = r[0x202];
      const numAttrs = (fmtHi >>> 28) + 1, fixedMask = (fmtHi >>> 16) & 0xFFF;
      const fmtOf = (i) => (i < 8 ? fmtLo >>> (i * 4) : fmtHi >>> ((i - 8) * 4)) & 0xF;
      const typeSize = [1, 1, 2, 4], glType = [gl.BYTE, gl.UNSIGNED_BYTE, gl.SHORT, gl.FLOAT];
      const nIn = Math.min(numAttrs, (r[0x2B9] & 0xF) + 1, 12);
      const arrays = [];
      for (let l = 0; l < 12; l++) {
        const offset = r[0x203 + l * 3] & 0x0FFFFFFF, lo = r[0x204 + l * 3], hi = r[0x205 + l * 3];
        const comps = hi >>> 28, stride = (hi >>> 16) & 0xFF;
        if (!comps) continue;
        let off = 0;
        const attrs = [];
        for (let c = 0; c < comps && c < 12; c++) {
          const a = c < 8 ? (lo >>> (c * 4)) & 0xF : (hi >>> ((c - 8) * 4)) & 0xF;
          if (a < 12) {
            const f = fmtOf(a), type = f & 3, n = (f >>> 2) + 1, es = typeSize[type];
            off = (off + es - 1) & ~(es - 1);
            if (stride % es) return false; // WebGL needs strides that are multiples of the element size
            attrs.push({ a, type, n, off });
            off += es * n;
          } else { off = (off + 3) & ~3; off += (a - 11) * 4; }
        }
        const size = Math.max(stride * (maxIndex + 1), off);
        const sp = gpu.span(base + offset, size);
        if (!sp) return false;
        arrays.push({ l, sp, size, stride, attrs });
      }

      // Inputs: every register starts as its current value; arrays and fixed attributes replace them
      this.flush();
      const p = this.setup(st, vert);
      if (!p) return true;
      gl.bindVertexArray(this.hwVao);
      const R = gpu.vs.R;
      for (let i = 0; i < 16; i++) { gl.disableVertexAttribArray(i); gl.vertexAttrib4f(i, R[i * 4], R[i * 4 + 1], R[i * 4 + 2], R[i * 4 + 3]); }
      const inArray = new Set();
      for (const arr of arrays) {
        gl.bindBuffer(gl.ARRAY_BUFFER, this.hwBuffers[arr.l]);
        gl.bufferData(gl.ARRAY_BUFFER, arr.sp.u8.subarray(arr.sp.off, arr.sp.off + arr.size), gl.STREAM_DRAW);
        for (const at of arr.attrs) {
          if (at.a >= nIn) continue;
          const loc = gpu.inputRegister(at.a);
          gl.enableVertexAttribArray(loc);
          gl.vertexAttribPointer(loc, at.n, glType[at.type], false, arr.stride, at.off);
          inArray.add(at.a);
        }
      }
      const D = gpu.defaults;
      for (let a = 0; a < nIn; a++) {
        if (inArray.has(a) || !(fixedMask & (1 << a))) continue;
        gl.vertexAttrib4f(gpu.inputRegister(a), D[a * 4], D[a * 4 + 1], D[a * 4 + 2], D[a * 4 + 3]);
      }
      gl.uniform4fv(p.u.C, R.subarray(0x20 * 4, 0x80 * 4));
      gl.uniform2f(p.u.uDepth, st.depthScale, st.depthOffset);
      gl.viewport(Math.round(st.offX), Math.round(st.offY), Math.round(st.halfW * 2), Math.round(st.halfH * 2));
      if (st.cull) { gl.enable(gl.CULL_FACE); gl.frontFace(gl.CCW); gl.cullFace(st.cull === 1 ? gl.FRONT : gl.BACK); } else gl.disable(gl.CULL_FACE);
      const mode = [gl.TRIANGLES, gl.TRIANGLE_STRIP, gl.TRIANGLE_FAN, gl.TRIANGLES][topology];
      if (indexed) {
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.hwIndex);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STREAM_DRAW);
        gl.drawElements(mode, count, indices instanceof Uint16Array ? gl.UNSIGNED_SHORT : gl.UNSIGNED_BYTE, 0);
      } else gl.drawArrays(mode, r[0x22A], count);
      this.stats.hwDraws = (this.stats.hwDraws || 0) + 1;
      this.drawn(st, p);
      return true;
    }
  }

  EMU.GLRenderer = GLRenderer;
  EMU.glFragmentSource = genFragment; // for inspecting generated code
})(typeof window !== 'undefined' ? window.EMU : globalThis.EMU);

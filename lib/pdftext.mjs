/**
 * 简递 · PDF 文字层提取
 *
 * 为什么不能用「抓括号里的字符串」那套：
 *   中文简历 PDF（WPS / Word / 招聘网站导出）里，中文字体几乎都是 Identity-H 的 CID 字体，
 *   内容流里的字节是「字形编号」而不是 Unicode，直接按 latin1 读出来必然是乱码。
 *   想还原文字，唯一的路是拿字体自带的 /ToUnicode CMap 反查。
 *
 * 这里做的是一个够用的最小 PDF 解析器：
 *   1. 线性扫 `N 0 obj … endobj`（不依赖 xref，坏 xref 也能读）
 *   2. 解压内容流 / ToUnicode 流（FlateDecode、ASCIIHexDecode）
 *   3. 解析 ToUnicode 的 bfchar / bfrange，得到 字形码 → Unicode
 *   4. 按 /Pages → Kids 顺序取每页 /Resources /Font 与 /Contents
 *   5. 逐 token 还原文字，按 Td/TD/Tm/T* 还原换行与空格
 *
 * 做不到的：扫描件（纯图片、没有文字层）。这种情况返回明确原因，由界面引导用户粘贴。
 */
import zlib from 'node:zlib';

const isWs = c => c === ' ' || c === '\n' || c === '\r' || c === '\t' || c === '\f' || c === '\0';
const isDelim = c => '()<>[]{}/%'.includes(c);

// start 指向 '<<'，返回匹配到的 '>>' 之后的下标
function dictEnd(s, start) {
  let d = 0;
  for (let i = start; i < s.length - 1; i++) {
    if (s[i] === '<' && s[i + 1] === '<') { d++; i++; continue; }
    if (s[i] === '>' && s[i + 1] === '>') { d--; i++; if (d === 0) return i + 1; }
  }
  return -1;
}

function readLiteral(str, i) {
  let j = i + 1, depth = 1, out = '';
  const n = str.length;
  while (j < n) {
    const ch = str[j];
    if (ch === '\\') {
      const nx = str[j + 1];
      if (nx === undefined) { j++; break; }
      if (nx === 'n') { out += '\n'; j += 2; }
      else if (nx === 'r') { out += '\r'; j += 2; }
      else if (nx === 't') { out += '\t'; j += 2; }
      else if (nx === 'b') { out += '\b'; j += 2; }
      else if (nx === 'f') { out += '\f'; j += 2; }
      else if (nx === '\n') { j += 2; }
      else if (nx === '\r') { j += str[j + 2] === '\n' ? 3 : 2; }
      else if (nx >= '0' && nx <= '7') {
        let oct = '', k = j + 1;
        while (k < j + 4 && str[k] >= '0' && str[k] <= '7') { oct += str[k]; k++; }
        out += String.fromCharCode(parseInt(oct, 8) & 0xff);
        j = k;
      } else { out += nx; j += 2; }
      continue;
    }
    if (ch === '(') { depth++; out += ch; j++; continue; }
    if (ch === ')') { depth--; if (!depth) { j++; break; } out += ch; j++; continue; }
    out += ch; j++;
  }
  return { next: j, v: out };
}

function readHex(str, i) {
  let j = str.indexOf('>', i + 1);
  if (j < 0) j = str.length;
  let hex = str.slice(i + 1, j).replace(/[^0-9A-Fa-f]/g, '');
  if (hex.length % 2) hex += '0';
  let out = '';
  for (let k = 0; k < hex.length; k += 2) out += String.fromCharCode(parseInt(hex.substr(k, 2), 16));
  return { next: j + 1, v: out };
}

function readArray(str, i) {
  let j = i + 1;
  const items = [];
  const n = str.length;
  while (j < n && str[j] !== ']') {
    const c = str[j];
    if (isWs(c)) { j++; continue; }
    if (c === '(') { const r = readLiteral(str, j); items.push({ t: 's', v: r.v }); j = r.next; continue; }
    if (c === '<' && str[j + 1] !== '<') { const r = readHex(str, j); items.push({ t: 's', v: r.v }); j = r.next; continue; }
    if (/[0-9+\-.]/.test(c)) {
      let k = j;
      while (k < n && /[0-9+\-.]/.test(str[k])) k++;
      const num = parseFloat(str.slice(j, k));
      items.push({ t: 'num', v: Number.isFinite(num) ? num : 0 });
      j = k;
      continue;
    }
    j++;
  }
  return { next: j + 1, items };
}

function unicodeFromHex(hex) {
  let h = (hex || '').replace(/[^0-9A-Fa-f]/g, '');
  if (!h.length) return '';
  if (h.length % 4) h = h.padStart(h.length + (4 - (h.length % 4)), '0');
  let out = '';
  for (let i = 0; i + 4 <= h.length; i += 4) out += String.fromCharCode(parseInt(h.substr(i, 4), 16));
  return out;
}

function parseCMap(text) {
  const map = new Map();
  let srcLen = 0;

  const csr = /begincodespacerange([\s\S]*?)endcodespacerange/.exec(text);
  if (csr) {
    const m = /<([0-9A-Fa-f]+)>/.exec(csr[1]);
    if (m && m[1].length >= 2) srcLen = Math.max(srcLen, m[1].length / 2);
  }

  const reChar = /beginbfchar([\s\S]*?)endbfchar/g;
  let blk;
  while ((blk = reChar.exec(text))) {
    const pr = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]*)>/g;
    let p;
    while ((p = pr.exec(blk[1]))) {
      if (!p[1].length || p[1].length % 2) continue;
      srcLen = Math.max(srcLen, p[1].length / 2);
      const code = parseInt(p[1], 16);
      if (!map.has(code)) map.set(code, unicodeFromHex(p[2]));
    }
  }

  const reRange = /beginbfrange([\s\S]*?)endbfrange/g;
  while ((blk = reRange.exec(text))) {
    const pr = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(<[0-9A-Fa-f]*>|\[[^\]]*\])/g;
    let p;
    while ((p = pr.exec(blk[1]))) {
      srcLen = Math.max(srcLen, p[1].length / 2);
      const lo = parseInt(p[1], 16);
      const hi = parseInt(p[2], 16);
      if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi < lo || hi - lo > 65535) continue;
      if (p[3][0] === '[') {
        const items = p[3].match(/<[0-9A-Fa-f]*>/g) || [];
        for (let k = 0; k <= hi - lo && k < items.length; k++) {
          if (!map.has(lo + k)) map.set(lo + k, unicodeFromHex(items[k].slice(1, -1)));
        }
      } else {
        const base = p[3].slice(1, -1);
        if (base.length < 4) continue;
        const prefix = base.slice(0, -4);
        const start = parseInt(base.slice(-4), 16);
        if (!Number.isFinite(start)) continue;
        for (let k = 0; k <= hi - lo; k++) {
          if (!map.has(lo + k)) map.set(lo + k, unicodeFromHex(prefix + (start + k).toString(16).padStart(4, '0')));
        }
      }
    }
  }

  return { map, srcLen: srcLen || 1 };
}

function latin1Text(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    const c = bytes.charCodeAt(i);
    if (c >= 32 || c === 9) out += bytes[i];
  }
  return out;
}

function utf16beText(bytes) {
  let out = '';
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    out += String.fromCharCode((bytes.charCodeAt(i) << 8) | bytes.charCodeAt(i + 1));
  }
  return out;
}

function decodeBytes(bytes, font) {
  if (!font) return latin1Text(bytes);
  if (font.utf16) return utf16beText(bytes);

  if (font.map && font.map.size) {
    const w = font.srcLen || 2;
    let out = '';
    for (let i = 0; i + w <= bytes.length; i += w) {
      let code = 0;
      for (let k = 0; k < w; k++) code = (code << 8) | (bytes.charCodeAt(i + k) & 0xff);
      const v = font.map.get(code);
      if (v !== undefined) out += v;
      else if (w === 1 && code >= 32) out += String.fromCharCode(code);
    }
    return out;
  }

  // 没有 ToUnicode 的 Type0 字体，字节是字形码，还原不了
  if (font.type0 || font.srcLen === 2) return '';
  return latin1Text(bytes);
}

/**
 * 逐 token 走内容流，还原文字、换行、空格
 */
function textFromContent(str, fonts) {
  let out = '';
  let font = null;
  let fontSize = 0;
  let lastY = null, lastX = null;
  let ops = [];

  const add = t => { if (t) out += t; };
  const nl = () => { if (out && !/\n$/.test(out)) out += '\n'; };
  const sp = () => { if (out && !/[\s\n]$/.test(out)) out += ' '; };
  const lastStr = () => {
    for (let k = ops.length - 1; k >= 0; k--) if (ops[k].t === 's') return ops[k];
    return null;
  };
  const numAt = idx => (ops[idx] && ops[idx].t === 'num' ? ops[idx].v : null);

  let i = 0;
  const n = str.length;
  while (i < n) {
    const c = str[i];

    if (isWs(c)) { i++; continue; }
    if (c === '%') { while (i < n && str[i] !== '\n' && str[i] !== '\r') i++; continue; }

    if (c === '(') { const r = readLiteral(str, i); ops.push({ t: 's', v: r.v }); i = r.next; continue; }
    if (c === '<' && str[i + 1] === '<') { const e = dictEnd(str, i); i = e < 0 ? n : e; ops = []; continue; }
    if (c === '<') { const r = readHex(str, i); ops.push({ t: 's', v: r.v }); i = r.next; continue; }
    if (c === '[') { const r = readArray(str, i); ops.push({ t: 'a', v: r.items }); i = r.next; continue; }
    if (c === ']' || c === '>' || c === '}' || c === '{') { i++; continue; }

    if (c === '/') {
      let j = i + 1;
      while (j < n && !isWs(str[j]) && !isDelim(str[j])) j++;
      ops.push({ t: 'n', v: str.slice(i + 1, j) });
      i = j;
      continue;
    }
    if (/[0-9+\-.]/.test(c)) {
      let j = i;
      while (j < n && /[0-9+\-.]/.test(str[j])) j++;
      const num = parseFloat(str.slice(i, j));
      ops.push({ t: 'num', v: Number.isFinite(num) ? num : 0 });
      i = j;
      continue;
    }

    let j = i;
    while (j < n && !isWs(str[j]) && !isDelim(str[j])) j++;
    const op = str.slice(i, j);
    i = j;

    switch (op) {
      case 'BI': {
        // 内联图片：ID 之后是二进制，找 EI 跳过
        const id = str.indexOf('ID', i);
        let k = id < 0 ? n : id + 2;
        while (k < n - 1) {
          if (str[k] === 'E' && str[k + 1] === 'I' && isWs(str[k - 1]) && (k + 2 >= n || isWs(str[k + 2]) || isDelim(str[k + 2]))) { k += 2; break; }
          k++;
        }
        i = k;
        ops = [];
        break;
      }
      case 'Tf': {
        for (let k = ops.length - 1; k >= 0; k--) {
          if (ops[k].t === 'n') { font = fonts.get(ops[k].v) || null; break; }
        }
        const size = numAt(ops.length - 1);
        if (size !== null && size > 0) fontSize = size;
        ops = [];
        break;
      }
      case 'Tj': {
        const s = lastStr();
        if (s) add(decodeBytes(s.v, font));
        ops = [];
        break;
      }
      case "'":
      case '"': {
        nl();
        const s = lastStr();
        if (s) add(decodeBytes(s.v, font));
        ops = [];
        break;
      }
      case 'TJ': {
        const arr = ops.find(o => o.t === 'a');
        if (arr) {
          for (const it of arr.v) {
            if (it.t === 's') add(decodeBytes(it.v, font));
            else if (it.t === 'num' && it.v <= -280) sp();
          }
        }
        ops = [];
        break;
      }
      case 'Td':
      case 'TD': {
        // 不少导出器会「一字一次 Td」排版，dx 就是字宽，不能当空格
        const dy = numAt(ops.length - 1);
        const limit = Math.max(0.5, (fontSize || 12) * 0.4);
        if (dy !== null && Math.abs(dy) > limit) nl();
        ops = [];
        break;
      }
      case 'Tm': {
        const f = numAt(ops.length - 1), e = numAt(ops.length - 2);
        const a = numAt(0);
        const em = Math.abs((a || 1) * (fontSize || 12));
        if (lastY === null) { if (out && !/\n$/.test(out)) nl(); }
        else if (f !== null && Math.abs(f - lastY) > Math.max(0.5, em * 0.4)) nl();
        if (e !== null) lastX = e;
        if (f !== null) lastY = f;
        ops = [];
        break;
      }
      case 'T*': { nl(); ops = []; break; }
      // 同一行常被拆成多个 BT/ET 文本块，这里不强制换行，交给 Tm/Td 的 Y 变化判断
      case 'BT': { ops = []; break; }
      default: ops = [];
    }
    if (ops.length > 256) ops = ops.slice(-32);
  }
  return out;
}

function tidy(text) {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^[\s\-–—_·•]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function quality(text) {
  if (!text) return 0;
  const good = (text.match(/[\u4e00-\u9fa5\u3400-\u4dbfA-Za-z0-9，。；：、,.;:!?()（）【】\-/%+]/g) || []).length;
  return good / text.length;
}

/**
 * @param {Buffer} buf
 * @returns {{ok:boolean, text?:string, reason?:string, scanned?:boolean, needUnicode?:boolean}}
 */
export function extractPdfText(buf, opts = {}) {
  const stats = { objs: 0, pages: 0, fonts: [], streams: 0, fail: [] };
  const s = buf.toString('latin1');
  if (!/^%PDF-/.test(s.slice(0, 8))) return { ok: false, reason: 'notpdf' };

  const objs = new Map();
  const reObj = /(\d+)\s+(\d+)\s+obj\b/g;
  let m;
  while ((m = reObj.exec(s))) {
    const num = parseInt(m[1], 10);
    const bodyStart = m.index + m[0].length;
    let endObj = s.indexOf('endobj', bodyStart);
    if (endObj < 0) endObj = s.length;
    let dict, streamRaw = null;
    const st = s.indexOf('stream', bodyStart);
    if (st >= 0 && st < endObj) {
      dict = s.slice(bodyStart, st);
      let p = st + 6;
      if (s[p] === '\r') p++;
      if (s[p] === '\n') p++;
      let dataEnd = -1;
      const lm = /\/Length\s+(\d+)(?!\s*\d*\s*R)/.exec(dict);
      if (lm) {
        const cand = p + parseInt(lm[1], 10);
        if (cand <= s.length && /^\s*endstream/.test(s.slice(cand, cand + 24))) dataEnd = cand;
      }
      if (dataEnd < 0) {
        const e2 = s.indexOf('endstream', p);
        dataEnd = e2 < 0 ? endObj : e2;
      }
      streamRaw = { start: p, end: Math.min(dataEnd, s.length) };
      if (streamRaw.end > reObj.lastIndex) reObj.lastIndex = streamRaw.end;
    } else {
      dict = s.slice(bodyStart, endObj);
    }
    if (!objs.has(num)) objs.set(num, { dict: dict || '', streamRaw });
  }

  if (objs.size === 0) return { ok: false, reason: 'broken' };
  stats.objs = objs.size;
  if (/\/Encrypt\s+\d+\s+\d+\s+R/.test(s)) return { ok: false, reason: 'encrypted' };

  const decodeStream = obj => {
    if (!obj || !obj.streamRaw) return null;
    if (obj._dec !== undefined) return obj._dec;
    const filter = (/\/Filter\s*(\[[^\]]*\]|\/[A-Za-z0-9]+)/.exec(obj.dict) || [])[1] || '';
    let data = buf.subarray(obj.streamRaw.start, obj.streamRaw.end);
    if (/DCTDecode|JPXDecode|CCITTFax|JBIG2/.test(filter)) { obj._dec = null; return null; }
    if (/FlateDecode/.test(filter)) {
      let out = null;
      try { out = zlib.inflateSync(data); } catch {
        try { out = zlib.inflateSync(data, { finishFlush: zlib.constants.Z_SYNC_FLUSH }); } catch {
          try { out = zlib.inflateRawSync(data, { finishFlush: zlib.constants.Z_SYNC_FLUSH }); } catch { out = null; }
        }
      }
      if (!out) { obj._dec = null; return null; }
      data = out;
    } else if (/ASCIIHexDecode/.test(filter)) {
      const hex = data.toString('latin1').replace(/[^0-9A-Fa-f]/g, '');
      const out = Buffer.alloc(Math.floor(hex.length / 2));
      for (let k = 0; k < out.length; k++) out[k] = parseInt(hex.substr(k * 2, 2), 16);
      data = out;
    } else if (/ASCII85Decode|LZWDecode|RunLengthDecode/.test(filter)) {
      obj._dec = null;
      return null;
    }
    obj._dec = data;
    return data;
  };

  const refNum = t => { const mm = /(\d+)\s+\d+\s+R/.exec(t || ''); return mm ? parseInt(mm[1], 10) : 0; };
  const directVal = (dict, key) => {
    const r = new RegExp('\\/' + key + '\\s*(<<|\\[[^\\]]*\\]|\\d+\\s+\\d+\\s+R)');
    const mm = r.exec(dict || '');
    if (!mm) return '';
    if (mm[1] === '<<') {
      const start = mm.index + mm[0].length - 2;
      const end = dictEnd(dict, start);
      return end > 0 ? dict.slice(start, end) : '';
    }
    return mm[1];
  };
  const resolveDict = t => {
    if (!t) return '';
    if (t.startsWith('<<')) return t;
    const o = objs.get(refNum(t));
    return o ? o.dict : '';
  };

  const fontsOf = resDict => {
    const fonts = new Map();
    const fd = directVal(resDict, 'Font');
    if (!fd) return fonts;
    const inner = fd.startsWith('<<') ? fd : resolveDict(fd);
    const rr = /\/([^\s\/<>\[\](){}%]+)\s+(\d+)\s+\d+\s+R/g;
    let mm;
    while ((mm = rr.exec(inner))) {
      const fo = objs.get(parseInt(mm[2], 10));
      if (!fo) continue;
      const d = fo.dict;
      let map = null, srcLen = 0;
      const tu = directVal(d, 'ToUnicode');
      if (tu && !tu.startsWith('<<')) {
        const to = objs.get(refNum(tu));
        const cs = to ? decodeStream(to) : null;
        if (cs) {
          const cm = parseCMap(cs.toString('latin1'));
          if (cm.map.size) { map = cm.map; srcLen = cm.srcLen; }
        }
      }
      const enc = (/\/Encoding\s*\/([A-Za-z0-9\-_]+)/.exec(d) || [])[1] || '';
      const utf16 = /^Uni(GB|CNS|JIS|KS)-(UCS2|UTF16)/.test(enc);
      const type0 = /\/Subtype\s*\/Type0/.test(d);
      fonts.set(mm[1], { map, srcLen: srcLen || (type0 ? 2 : 1), utf16, type0 });
      if (opts.debug) stats.fonts.push({ name: mm[1], obj: parseInt(mm[2], 10), tu: !!tu, mapSize: map ? map.size : 0, srcLen: srcLen || (type0 ? 2 : 1) });
    }
    return fonts;
  };

  const pages = [];
  const roots = [];
  for (const [, o] of objs) {
    if (/\/Type\s*\/Pages\b/.test(o.dict) && !/\/Parent\b/.test(o.dict)) roots.push(o);
  }
  const walk = (obj, inheritedRes, depth) => {
    if (!obj || depth > 40) return;
    const resOwn = directVal(obj.dict, 'Resources');
    const res = resOwn ? resolveDict(resOwn) : inheritedRes;
    if (/\/Type\s*\/Page\b/.test(obj.dict)) { pages.push({ obj, res }); return; }
    const kids = directVal(obj.dict, 'Kids');
    if (!kids) return;
    const rr = /(\d+)\s+\d+\s+R/g;
    let mm;
    while ((mm = rr.exec(kids))) walk(objs.get(parseInt(mm[1], 10)), res, depth + 1);
  };
  for (const r of roots) walk(r, '', 0);
  if (!pages.length) {
    for (const [, o] of objs) {
      if (/\/Type\s*\/Page\b/.test(o.dict)) pages.push({ obj: o, res: resolveDict(directVal(o.dict, 'Resources')) });
    }
  }

  const contentsOf = page => {
    const v = directVal(page.obj.dict, 'Contents');
    if (!v) return [];
    if (v.startsWith('[')) {
      const refs = [];
      const rr = /(\d+)\s+\d+\s+R/g;
      let mm;
      while ((mm = rr.exec(v))) refs.push(parseInt(mm[1], 10));
      return refs.map(n => decodeStream(objs.get(n))).filter(Boolean);
    }
    const d = decodeStream(objs.get(refNum(v)));
    return d ? [d] : [];
  };

  const parts = [];
  let fontTotal = 0;
  let needUnicode = 0;

  for (const page of pages) {
    const fonts = fontsOf(page.res);
    fontTotal += fonts.size;
    let pageText = '';
    for (const c of contentsOf(page)) pageText += textFromContent(c.toString('latin1'), fonts) + '\n';
    if (pageText.trim()) parts.push(pageText);
  }

  for (const [, o] of objs) {
    if (/\/Type\s*\/Font/.test(o.dict) && !/\/ToUnicode\b/.test(o.dict) && /\/Subtype\s*\/Type0/.test(o.dict)) needUnicode++;
  }

  const text = tidy(parts.join('\n'));
  stats.pages = pages.length;
  const done = r => { if (opts.debug) r._debug = stats; return r; };
  if (!text) {
    return done({ ok: false, reason: pages.length ? 'notext' : 'nopage', scanned: !fontTotal, needUnicode: needUnicode > 0 });
  }
  if (text.length < 24 || quality(text) < 0.55) {
    return done({ ok: false, reason: 'lowquality', text, scanned: !fontTotal, needUnicode: needUnicode > 0 });
  }
  return done({ ok: true, text });
}

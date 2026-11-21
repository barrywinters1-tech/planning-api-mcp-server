/* XML import for the browser build: JS ports of planner/pmxml.py (Primavera P6 XML) and the
   reader half of planner/mspxml.py (MS Project XML / MSPDI, which Asta Powerproject also
   exports), plus io._xml_root_tag. The output is the same plain project object Python's
   readers give after Project.model_dump(mode="json"): same keys, values and list order.

   There is no DOMParser in node (the parity tests) and DOMParser differs from Python anyway,
   so this file carries a small XML parser that behaves like Python's ElementTree on expat:
   namespaces ('{uri}local' tags, prefixes, xml: and the reserved-name rules), predefined,
   numeric and internal DTD entities, CDATA, comments and processing instructions (which do not
   split text), line-end normalisation, the UTF-8 byte-order mark, and expat's error messages
   and line/column positions ("mismatched tag: line 3, column 2"), which the app shows.
   Not reproduced: the exact byte accounting of expat's entity amplification limit (a cruder cap
   guards against "billion laughs"); external DTDs are never loaded, as in Python. */
'use strict';
(function (global) {
const E = global.PlannerEngine;

// =========================================================================================
// Python-compatible string and number helpers
// =========================================================================================
const PY_WS = '\\t\\n\\x0b\\x0c\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000';   // str.isspace()
const RE_STRIP = new RegExp(`^[${PY_WS}]+|[${PY_WS}]+$`, 'g');
const RE_WS_RUN = new RegExp(`[${PY_WS}]+`, 'g');
const pyStrip = s => s.replace(RE_STRIP, '');
const pySplit = s => pyStrip(s).split(RE_WS_RUN).filter(x => x !== '');          // str.split()
function pySlice(s, n) {                                                            // s[:n], counting code points
  if (s.length <= n) return s;
  let i = 0, k = 0;
  while (i < s.length && k < n) { const c = s.charCodeAt(i); i += (c >= 0xD800 && c <= 0xDBFF && i + 1 < s.length) ? 2 : 1; k++; }
  return s.slice(0, i);
}
const pad = (n, w = 2) => String(n).padStart(w, '0');
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const get = (o, k, d) => has(o, k) ? o[k] : d;
const pyOr = (x, d) => (x === 0 ? d : x);                                           // float `x or d` (NaN is truthy)

// Unicode decimal digits -> ASCII, as int()/float() and re's \d accept them. Nd characters come in
// whole aligned runs of ten (0..9), so a digit's value is its offset from the start of its run.
const RE_ND = /\p{Nd}/u, RE_ND_ALL = /\p{Nd}/gu;
function asciiDigits(s) {
  return s.replace(RE_ND_ALL, ch => {
    const cp = ch.codePointAt(0); if (cp < 128) return ch;
    let start = cp; while (start > 0 && RE_ND.test(String.fromCodePoint(start - 1))) start--;
    return String((cp - start) % 10);
  });
}
const RE_NONPRINT = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Zs}]/u;
function pyRepr(s) {                                                                // repr(str)
  const q = (s.includes("'") && !s.includes('"')) ? '"' : "'";
  let out = q;
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if (ch === '\\') out += '\\\\';
    else if (ch === q) out += '\\' + q;
    else if (ch === '\t') out += '\\t'; else if (ch === '\n') out += '\\n'; else if (ch === '\r') out += '\\r';
    else if (cp < 0x20 || cp === 0x7f) out += '\\x' + pad(cp.toString(16));
    else if (cp >= 0x80 && RE_NONPRINT.test(ch)) out += cp <= 0xff ? '\\x' + pad(cp.toString(16)) : cp <= 0xffff ? '\\u' + pad(cp.toString(16), 4) : '\\U' + pad(cp.toString(16), 8);
    else out += ch;
  }
  return out + q;
}
// float(s): Python's grammar (underscores between digits, inf/nan, surrounding whitespace)
const RE_FLOAT = /^[+-]?(?:(?:\d(?:_?\d)*(?:\.(?:\d(?:_?\d)*)?)?|\.\d(?:_?\d)*)(?:[eE][+-]?\d(?:_?\d)*)?|inf|infinity|nan)$/i;
function pyFloat(s) {
  const t = pyStrip(asciiDigits(String(s)));
  if (!RE_FLOAT.test(t)) throw new Error('could not convert string to float: ' + pyRepr(String(s)));
  const neg = t[0] === '-', body = t.replace(/^[+-]/, '').toLowerCase();
  if (body === 'nan') return NaN;
  if (body === 'inf' || body === 'infinity') return neg ? -Infinity : Infinity;
  return Number(t.replace(/_/g, ''));
}
function pyFloatOr(s, d = 0) { try { return pyFloat(s); } catch (e) { return d; } }  // pmxml._f
const RE_INT = /^[+-]?\d(?:_?\d)*$/;
function pyInt(s) {                                                                 // int(s) for a str
  const t = pyStrip(asciiDigits(String(s)));
  if (!RE_INT.test(t)) throw new Error('invalid literal for int() with base 10: ' + pySlice(pyRepr(String(s)), 200));
  const v = Number(t.replace(/_/g, '')); return v === 0 ? 0 : v;
}
function pyIntOfFloat(x) {                                                          // int(float)
  if (Number.isNaN(x)) throw new Error('cannot convert float NaN to integer');
  if (!Number.isFinite(x)) throw new Error('cannot convert float infinity to integer');
  const v = Math.trunc(x); return v === 0 ? 0 : v;
}
const pyMod = (a, n) => ((a % n) + n) % n;

// max(set(xs), key=xs.count): ties go to whichever value CPython's set iterates first, so the
// set's hash table (CPython 3.11 setobject.c: 8 slots, linear probes of 9, perturb >> 5, resize
// to used*4 at 3/5 full) is replayed with float hashes (x mod 2**61-1, sign kept, -1 -> -2).
const M64 = (1n << 64n) - 1n, PMOD = (1n << 61n) - 1n;
const _hv = new DataView(new ArrayBuffer(8));
function pyFloatHash(x) {
  if (x === 0) return 0n;
  _hv.setFloat64(0, Math.abs(x)); const hi = _hv.getUint32(0), lo = _hv.getUint32(4); const e = (hi >>> 20) & 0x7ff;
  let m = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo), p;
  if (e === 0) p = -1074; else { m |= 1n << 52n; p = e - 1075; }
  let h = ((m % PMOD) * (1n << BigInt(pyMod(p, 61)))) % PMOD;
  if (x < 0) h = -h;
  if (h === -1n) h = -2n;
  return h;
}
function pySetOrder(xs) {
  let mask = 7n, table = new Array(8).fill(null), fill = 0;
  const insertClean = (tbl, msk, key, hash) => {
    let perturb = hash & M64, i = hash & M64 & msk;
    for (;;) {
      if (tbl[Number(i)] === null) { tbl[Number(i)] = [key, hash]; return; }
      if (i + 9n <= msk) for (let j = 1n; j <= 9n; j++) if (tbl[Number(i + j)] === null) { tbl[Number(i + j)] = [key, hash]; return; }
      perturb >>= 5n; i = (i * 5n + 1n + perturb) & msk;
    }
  };
  for (const x of xs) {
    const hash = pyFloatHash(x); let perturb = hash & M64, i = hash & M64 & mask, slot = -1;
    search: for (;;) {
      let k = Number(i), probes = (i + 9n <= mask) ? 9 : 0;
      do {
        const ent = table[k];
        if (ent === null) { slot = k; break search; }
        if (ent[1] === hash && ent[0] === x) break search;          // already present
        k++;
      } while (probes-- > 0);
      perturb >>= 5n; i = (i * 5n + 1n + perturb) & mask;
    }
    if (slot < 0) continue;
    table[slot] = [x, hash]; fill++;
    if (fill * 5 >= Number(mask) * 3) {
      const minused = fill * 4; let size = 8; while (size <= minused) size *= 2;
      const nt = new Array(size).fill(null), nm = BigInt(size - 1);
      for (const ent of table) if (ent !== null) insertClean(nt, nm, ent[0], ent[1]);
      table = nt; mask = nm;
    }
  }
  return table.filter(e => e !== null).map(e => e[0]);
}
function maxByCount(xs) {
  let best = null, bestN = -1;
  for (const v of pySetOrder(xs)) { const n = xs.filter(x => x === v).length; if (n > bestN) { best = v; bestN = n; } }
  return best;
}

// datetime.strptime with CPython's field patterns (re.IGNORECASE; \d is any Unicode digit)
const D1 = '\\p{Nd}';
const F = { Y: `(${D1}${D1}${D1}${D1})`, m: '(1[0-2]|0[1-9]|[1-9])', d: `(3[01]|[12]${D1}|0[1-9]|[1-9]| [1-9])`,
  H: `(2[0-3]|[0-1]${D1}|${D1})`, M: `([0-5]${D1}|${D1})`, S: `(6[0-1]|[0-5]${D1}|${D1})` };
const RE_DT19 = new RegExp(`^${F.Y}-${F.m}-${F.d}T${F.H}:${F.M}:${F.S}$`, 'iu');
const RE_D10 = new RegExp(`^${F.Y}-${F.m}-${F.d}$`, 'iu');
const RE_HMS = new RegExp(`^${F.H}:${F.M}:${F.S}$`, 'iu');
const num = s => +asciiDigits(s);
const leap = y => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
const monthDays = (y, m) => [31, leap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
function ymdOk(y, m, d) { return y >= 1 && d <= monthDays(y, m); }
const isoOf = (y, m, d, h = 0, mi = 0, s = 0) => `${pad(y, 4)}-${pad(m)}-${pad(d)}T${pad(h)}:${pad(mi)}:${pad(s)}`;
function strptime19(s) {
  const g = s.match(RE_DT19); if (!g) return null;
  const [y, m, d, h, mi, sec] = g.slice(1).map(num);
  return (ymdOk(y, m, d) && sec <= 59) ? isoOf(y, m, d, h, mi, sec) : null;
}
function strptime10(s) {
  const g = s.match(RE_D10); if (!g) return null;
  const [y, m, d] = g.slice(1).map(num);
  return ymdOk(y, m, d) ? isoOf(y, m, d) : null;
}
function hmOf(s) {                                                                  // _hm(): time, or 08:00 on failure
  const g = pySlice(s, 8).match(RE_HMS);
  if (g) { const [h, m, sec] = g.slice(1).map(num); if (sec <= 59) return { h, m, s: sec }; }
  return { h: 8, m: 0, s: 0 };
}
const timeStr = t => `${pad(t.h)}:${pad(t.m)}:${pad(t.s)}`;
function nextDay(ymd) {                                                             // date + timedelta(days=1)
  let [y, m, d] = ymd.split('-').map(Number);
  if (++d > monthDays(y, m)) { d = 1; if (++m > 12) { m = 1; y++; } }
  if (y > 9999) throw new Error('date value out of range');
  return `${pad(y, 4)}-${pad(m)}-${pad(d)}`;
}
function nowAt8() {                                                                 // datetime.now().replace(hour=8, ...)
  const n = new Date(); return isoOf(n.getFullYear(), n.getMonth() + 1, n.getDate(), 8);
}

// =========================================================================================
// XML parser (expat + ElementTree semantics, namespace mode)
// =========================================================================================
const XML_NS = 'http://www.w3.org/XML/1998/namespace', XMLNS_NS = 'http://www.w3.org/2000/xmlns/';
const MSG = {
  INVALID: 'not well-formed (invalid token)', UNCLOSED: 'unclosed token', NO_ELEMENTS: 'no element found',
  SYNTAX: 'syntax error', MISMATCH: 'mismatched tag', DUPLICATE: 'duplicate attribute', JUNK: 'junk after document element',
  PE_REF: 'illegal parameter entity reference', UNDEFINED: 'undefined entity', RECURSIVE: 'recursive entity reference',
  ASYNC: 'asynchronous entity', BAD_CHAR_REF: 'reference to invalid character number', BINARY: 'reference to binary entity',
  ATT_EXTERNAL: 'reference to external entity in attribute', MISPLACED: 'XML or text declaration not at start of entity',
  XML_DECL: 'XML declaration not well-formed', UNCLOSED_CDATA: 'unclosed CDATA section', UNBOUND: 'unbound prefix',
  UNDECLARING: 'must not undeclare prefix', PUBLICID: 'illegal character(s) in public id',
  RESERVED_XML: 'reserved prefix (xml) must not be undeclared or bound to another namespace name',
  RESERVED_XMLNS: 'reserved prefix (xmlns) must not be declared or undeclared',
  RESERVED_URI: 'prefix must not be bound to one of the reserved namespace names',
  AMPLIFICATION: 'limit on input amplification factor (from DTD and entities) breached',
};
class XmlParseError extends Error {
  constructor(msg, line, col) { super(`${msg}: line ${line}, column ${col}`); this.name = 'ParseError'; this.position = [line, col]; }
}
function lineCol(s, pos) {                                                          // expat counts characters; CR, LF and CRLF end a line
  let line = 1, col = 0;
  for (let i = 0; i < pos; i++) {
    const c = s.charCodeAt(i);
    if (c === 13) { line++; col = 0; if (i + 1 < pos && s.charCodeAt(i + 1) === 10) i++; }
    else if (c === 10) { line++; col = 0; }
    else { col++; if (c >= 0xD800 && c <= 0xDBFF && i + 1 < pos) i++; }
  }
  return [line, col];
}
// expat's name characters for U+0080..U+FFFF (XML 1.0 2nd edition, Appendix B), measured from expat
// 2.6 itself; characters outside the BMP are never name characters.
const RE_NMSTRT = /[\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u0131\u0134-\u013E\u0141-\u0148\u014A-\u017E\u0180-\u01C3\u01CD-\u01F0\u01F4-\u01F5\u01FA-\u0217\u0250-\u02A8\u02BB-\u02C1\u0386\u0388-\u038A\u038C\u038E-\u03A1\u03A3-\u03CE\u03D0-\u03D6\u03DA\u03DC\u03DE\u03E0\u03E2-\u03F3\u0401-\u040C\u040E-\u044F\u0451-\u045C\u045E-\u0481\u0490-\u04C4\u04C7-\u04C8\u04CB-\u04CC\u04D0-\u04EB\u04EE-\u04F5\u04F8-\u04F9\u0531-\u0556\u0559\u0561-\u0586\u05D0-\u05EA\u05F0-\u05F2\u0621-\u063A\u0641-\u064A\u0671-\u06B7\u06BA-\u06BE\u06C0-\u06CE\u06D0-\u06D3\u06D5\u06E5-\u06E6\u0905-\u0939\u093D\u0958-\u0961\u0985-\u098C\u098F-\u0990\u0993-\u09A8\u09AA-\u09B0\u09B2\u09B6-\u09B9\u09DC-\u09DD\u09DF-\u09E1\u09F0-\u09F1\u0A05-\u0A0A\u0A0F-\u0A10\u0A13-\u0A28\u0A2A-\u0A30\u0A32-\u0A33\u0A35-\u0A36\u0A38-\u0A39\u0A59-\u0A5C\u0A5E\u0A72-\u0A74\u0A85-\u0A8B\u0A8D\u0A8F-\u0A91\u0A93-\u0AA8\u0AAA-\u0AB0\u0AB2-\u0AB3\u0AB5-\u0AB9\u0ABD\u0AE0\u0B05-\u0B0C\u0B0F-\u0B10\u0B13-\u0B28\u0B2A-\u0B30\u0B32-\u0B33\u0B36-\u0B39\u0B3D\u0B5C-\u0B5D\u0B5F-\u0B61\u0B85-\u0B8A\u0B8E-\u0B90\u0B92-\u0B95\u0B99-\u0B9A\u0B9C\u0B9E-\u0B9F\u0BA3-\u0BA4\u0BA8-\u0BAA\u0BAE-\u0BB5\u0BB7-\u0BB9\u0C05-\u0C0C\u0C0E-\u0C10\u0C12-\u0C28\u0C2A-\u0C33\u0C35-\u0C39\u0C60-\u0C61\u0C85-\u0C8C\u0C8E-\u0C90\u0C92-\u0CA8\u0CAA-\u0CB3\u0CB5-\u0CB9\u0CDE\u0CE0-\u0CE1\u0D05-\u0D0C\u0D0E-\u0D10\u0D12-\u0D28\u0D2A-\u0D39\u0D60-\u0D61\u0E01-\u0E2E\u0E30\u0E32-\u0E33\u0E40-\u0E45\u0E81-\u0E82\u0E84\u0E87-\u0E88\u0E8A\u0E8D\u0E94-\u0E97\u0E99-\u0E9F\u0EA1-\u0EA3\u0EA5\u0EA7\u0EAA-\u0EAB\u0EAD-\u0EAE\u0EB0\u0EB2-\u0EB3\u0EBD\u0EC0-\u0EC4\u0F40-\u0F47\u0F49-\u0F69\u10A0-\u10C5\u10D0-\u10F6\u1100\u1102-\u1103\u1105-\u1107\u1109\u110B-\u110C\u110E-\u1112\u113C\u113E\u1140\u114C\u114E\u1150\u1154-\u1155\u1159\u115F-\u1161\u1163\u1165\u1167\u1169\u116D-\u116E\u1172-\u1173\u1175\u119E\u11A8\u11AB\u11AE-\u11AF\u11B7-\u11B8\u11BA\u11BC-\u11C2\u11EB\u11F0\u11F9\u1E00-\u1E9B\u1EA0-\u1EF9\u1F00-\u1F15\u1F18-\u1F1D\u1F20-\u1F45\u1F48-\u1F4D\u1F50-\u1F57\u1F59\u1F5B\u1F5D\u1F5F-\u1F7D\u1F80-\u1FB4\u1FB6-\u1FBC\u1FBE\u1FC2-\u1FC4\u1FC6-\u1FCC\u1FD0-\u1FD3\u1FD6-\u1FDB\u1FE0-\u1FEC\u1FF2-\u1FF4\u1FF6-\u1FFC\u2126\u212A-\u212B\u212E\u2180-\u2182\u3007\u3021-\u3029\u3041-\u3094\u30A1-\u30FA\u3105-\u312C\u4E00-\u9FA5\uAC00-\uD7A3]/, RE_NMEXTRA = /[\u00B7\u02D0-\u02D1\u0300-\u0345\u0360-\u0361\u0387\u0483-\u0486\u0591-\u05A1\u05A3-\u05B9\u05BB-\u05BD\u05BF\u05C1-\u05C2\u05C4\u0640\u064B-\u0652\u0660-\u0669\u0670\u06D6-\u06E4\u06E7-\u06E8\u06EA-\u06ED\u06F0-\u06F9\u0901-\u0903\u093C\u093E-\u094D\u0951-\u0954\u0962-\u0963\u0966-\u096F\u0981-\u0983\u09BC\u09BE-\u09C4\u09C7-\u09C8\u09CB-\u09CD\u09D7\u09E2-\u09E3\u09E6-\u09EF\u0A02\u0A3C\u0A3E-\u0A42\u0A47-\u0A48\u0A4B-\u0A4D\u0A66-\u0A71\u0A81-\u0A83\u0ABC\u0ABE-\u0AC5\u0AC7-\u0AC9\u0ACB-\u0ACD\u0AE6-\u0AEF\u0B01-\u0B03\u0B3C\u0B3E-\u0B43\u0B47-\u0B48\u0B4B-\u0B4D\u0B56-\u0B57\u0B66-\u0B6F\u0B82-\u0B83\u0BBE-\u0BC2\u0BC6-\u0BC8\u0BCA-\u0BCD\u0BD7\u0BE7-\u0BEF\u0C01-\u0C03\u0C3E-\u0C44\u0C46-\u0C48\u0C4A-\u0C4D\u0C55-\u0C56\u0C66-\u0C6F\u0C82-\u0C83\u0CBE-\u0CC4\u0CC6-\u0CC8\u0CCA-\u0CCD\u0CD5-\u0CD6\u0CE6-\u0CEF\u0D02-\u0D03\u0D3E-\u0D43\u0D46-\u0D48\u0D4A-\u0D4D\u0D57\u0D66-\u0D6F\u0E31\u0E34-\u0E3A\u0E46-\u0E4E\u0E50-\u0E59\u0EB1\u0EB4-\u0EB9\u0EBB-\u0EBC\u0EC6\u0EC8-\u0ECD\u0ED0-\u0ED9\u0F18-\u0F19\u0F20-\u0F29\u0F35\u0F37\u0F39\u0F3E-\u0F3F\u0F71-\u0F84\u0F86-\u0F8B\u0F90-\u0F95\u0F97\u0F99-\u0FAD\u0FB1-\u0FB7\u0FB9\u20D0-\u20DC\u20E1\u3005\u302A-\u302F\u3031-\u3035\u3099-\u309A\u309D-\u309E\u30FC-\u30FE]/;
function nmstrt(c) {                                                                // NCName start (':' is separate in namespace mode)
  if (c < 0x80) return (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || c === 95;
  return RE_NMSTRT.test(String.fromCharCode(c));
}
function nmchar(c) {
  if (c < 0x80) return (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || c === 95 || (c >= 48 && c <= 57) || c === 46 || c === 45;
  const ch = String.fromCharCode(c); return RE_NMSTRT.test(ch) || RE_NMEXTRA.test(ch);
}
const isS = c => c === 32 || c === 9 || c === 10 || c === 13;
const nonXml = c => (c < 32 && c !== 9 && c !== 10 && c !== 13) || c === 0xFFFE || c === 0xFFFF;
const isDigit = c => c >= 48 && c <= 57;
const isHex = c => isDigit(c) || (c >= 97 && c <= 102) || (c >= 65 && c <= 70);
const PREDEFINED = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

// token codes
const T_NONE = 0, T_INVALID = 1, T_PARTIAL = 2, T_DATA = 3, T_NEWLINE = 4, T_TRAILING_CR = 5, T_TRAILING_RSQB = 6,
  T_START = 7, T_EMPTY = 8, T_END = 9, T_ENTITY_REF = 10, T_CHAR_REF = 11, T_COMMENT = 12, T_PI = 13, T_XML_DECL = 14,
  T_CDATA_OPEN = 15, T_CDATA_CLOSE = 16, T_ATT_S = 17,
  // prolog
  P_S = 20, P_INSTANCE = 21, P_DECL_OPEN = 22, P_NAME = 23, P_NMTOKEN = 24, P_PREFIXED = 25, P_LITERAL = 26, P_OPEN_BRACKET = 27,
  P_CLOSE_BRACKET = 28, P_DECL_CLOSE = 29, P_PE_REF = 30, P_PERCENT = 31, P_COND_OPEN = 32, P_COND_CLOSE = 33, P_OPEN_PAREN = 34,
  P_CLOSE_PAREN = 35, P_OR = 36, P_COMMA = 37, P_POUND_NAME = 38, P_NAME_SUFFIX = 39, P_CLOSE_PAREN_REP = 40;   // NAME_SUFFIX: name? name* name+; CLOSE_PAREN_REP: )* )? )+

// Python hands expat the str as UTF-8. Like expat, a document whose first byte is NUL is read as
// UTF-16BE and one whose second byte is NUL as UTF-16LE (a BOM-less UTF-16 file decoded as UTF-8).
function expatDocument(input) {
  const str = String(input);
  for (let i = 0, k = 0; i < str.length; i++, k++) {
    const c = str.charCodeAt(i);
    if (c >= 0xD800 && c <= 0xDFFF) {
      if (c <= 0xDBFF && i + 1 < str.length && (str.charCodeAt(i + 1) & 0xFC00) === 0xDC00) { i++; continue; }
      throw new Error(`'utf-8' codec can't encode character '\\u${c.toString(16)}' in position ${k}: surrogates not allowed`);
    }
  }
  const be = str.charCodeAt(0) === 0, le = !be && str.length > 1 && str.charCodeAt(1) === 0 && str.charCodeAt(0) < 0x80;
  if (!be && !le) return [str, false];
  const b = new TextEncoder().encode(str), units = [];
  for (let i = 0; i + 1 < b.length; i += 2) units.push(be ? (b[i] << 8) | b[i + 1] : b[i] | (b[i + 1] << 8));
  for (let i = 0; i < units.length; i++) {                                          // unpaired surrogates are invalid characters
    const u = units[i];
    if (u >= 0xD800 && u <= 0xDBFF && i + 1 < units.length && (units[i + 1] & 0xFC00) === 0xDC00) { i++; continue; }
    if (u >= 0xD800 && u <= 0xDFFF) units[i] = 0xFFFF;
  }
  let out = ''; for (let i = 0; i < units.length; i += 8192) out += String.fromCharCode.apply(null, units.slice(i, i + 8192));
  return [out, b.length % 2 === 1];
}

function parseXml(input) {
  const [src, oddTail] = expatDocument(input), n = src.length;   // oddTail: a lone trailing byte of UTF-16 never completes
  let NX = 0;                                         // where the last token ended (expat's *nextTokPtr)
  let CLOSE_REP = '';                                 // which of )* )? )+ the last P_CLOSE_PAREN_REP was
  let TAG = null;                                     // the start tag scanContent last read
  const fail = (msg, pos) => { const [l, c] = lineCol(src, pos); throw new XmlParseError(msg, l, c); };
  const entities = new Map();                         // name -> { text: string|null, notation, open }
  let hasParamEntityRefs = false, standalone = false, keepProcessing = true, expanded = 0;

  // ---------------- shared scanners (t = text, end = its end) ----------------
  function scanRef(t, j, end) {                       // after '&'
    if (j >= end) return T_PARTIAL;
    let c = t.charCodeAt(j);
    if (c === 35) return scanCharRef(t, j + 1, end);
    if (!nmstrt(c)) { NX = j; return T_INVALID; }
    for (j++; j < end; j++) {
      c = t.charCodeAt(j);
      if (nmchar(c)) continue;
      if (c === 59) { NX = j + 1; return T_ENTITY_REF; }
      NX = j; return T_INVALID;
    }
    return T_PARTIAL;
  }
  function scanCharRef(t, j, end) {                   // after '&#'
    if (j >= end) return T_PARTIAL;
    let c = t.charCodeAt(j); let test = isDigit;
    if (c === 120) { j++; test = isHex; if (j >= end) return T_PARTIAL; c = t.charCodeAt(j); }
    if (!test(c)) { NX = j; return T_INVALID; }
    for (j++; j < end; j++) {
      c = t.charCodeAt(j);
      if (test(c)) continue;
      if (c === 59) { NX = j + 1; return T_CHAR_REF; }
      NX = j; return T_INVALID;
    }
    return T_PARTIAL;
  }
  function charRefNumber(t, s) {                      // s at '&'; -1 when not an XML character
    let i = s + 2, r = 0;
    if (t.charCodeAt(i) === 120) { for (i++; t.charCodeAt(i) !== 59; i++) { r = r * 16 + parseInt(t[i], 16); if (r >= 0x110000) return -1; } }
    else for (; t.charCodeAt(i) !== 59; i++) { r = r * 10 + (t.charCodeAt(i) - 48); if (r >= 0x110000) return -1; }
    if ((r >= 0xD800 && r <= 0xDFFF) || r === 0xFFFE || r === 0xFFFF || (r < 32 && r !== 9 && r !== 10 && r !== 13)) return -1;
    return r;
  }
  function scanComment(t, j, end) {                   // after '<!-'
    if (j >= end) return T_PARTIAL;
    if (t.charCodeAt(j) !== 45) { NX = j; return T_INVALID; }
    for (j++; j < end;) {
      const c = t.charCodeAt(j);
      if (nonXml(c)) { NX = j; return T_INVALID; }
      if (c === 45) {
        j++; if (j >= end) return T_PARTIAL;
        if (t.charCodeAt(j) === 45) {
          j++; if (j >= end) return T_PARTIAL;
          if (t.charCodeAt(j) !== 62) { NX = j; return T_INVALID; }
          NX = j + 1; return T_COMMENT;
        }
        continue;
      }
      j++;
    }
    return T_PARTIAL;
  }
  function scanPi(t, j, end) {                        // after '<?'
    if (j >= end) return T_PARTIAL;
    if (!nmstrt(t.charCodeAt(j))) { NX = j; return T_INVALID; }
    const ts = j;
    for (j++; j < end;) {
      const c = t.charCodeAt(j);
      if (nmchar(c)) { j++; continue; }
      if (!isS(c) && c !== 63) { NX = j; return T_INVALID; }
      const target = t.slice(ts, j); let tok = T_PI;
      if (target.length === 3 && /^[xX][mM][lL]$/.test(target)) { if (target !== 'xml') { NX = j; return T_INVALID; } tok = T_XML_DECL; }
      if (c === 63) { j++; if (j >= end) return T_PARTIAL; if (t.charCodeAt(j) === 62) { NX = j + 1; return tok; } NX = j; return T_INVALID; }
      for (j++; j < end;) {
        const d = t.charCodeAt(j);
        if (nonXml(d)) { NX = j; return T_INVALID; }
        if (d === 63) { j++; if (j >= end) return T_PARTIAL; if (t.charCodeAt(j) === 62) { NX = j + 1; return tok; } continue; }
        j++;
      }
      return T_PARTIAL;
    }
    return T_PARTIAL;
  }
  function scanPercent(t, j, end) {                   // after '%'
    if (j >= end) return T_PARTIAL;
    let c = t.charCodeAt(j);
    if (isS(c) || c === 37) { NX = j; return P_PERCENT; }
    if (!nmstrt(c)) { NX = j; return T_INVALID; }
    for (j++; j < end; j++) {
      c = t.charCodeAt(j);
      if (nmchar(c)) continue;
      if (c === 59) { NX = j + 1; return P_PE_REF; }
      NX = j; return T_INVALID;
    }
    return T_PARTIAL;
  }

  // ---------------- content tokenizer ----------------
  // `internal` is entity replacement text, where expat treats CR as plain whitespace.
  function contentTok(t, i, end, internal) {
    if (i >= end) { NX = i; return T_NONE; }
    let c = t.charCodeAt(i), j = i + 1;
    switch (c) {
      case 60: return scanLt(t, j, end);
      case 38: return scanRef(t, j, end);
      case 13: if (internal) break; if (j >= end) { NX = end; return T_TRAILING_CR; } if (t.charCodeAt(j) === 10) j++; NX = j; return T_NEWLINE;
      case 10: NX = j; return T_NEWLINE;
      case 93:
        if (j >= end) { NX = end; return T_TRAILING_RSQB; }
        if (t.charCodeAt(j) !== 93) break;
        j++; if (j >= end) { NX = end; return T_TRAILING_RSQB; }
        if (t.charCodeAt(j) === 62) { NX = j; return T_INVALID; }
        j--; break;
      default: if (nonXml(c)) { NX = i; return T_INVALID; }
    }
    while (j < end) {
      c = t.charCodeAt(j);
      if (c === 60 || c === 38 || c === 10 || (c === 13 && !internal) || nonXml(c)) break;
      if (c === 93 && end - j >= 2) {
        if (t.charCodeAt(j + 1) !== 93) { j++; continue; }
        if (end - j >= 3) { if (t.charCodeAt(j + 2) !== 62) { j++; continue; } NX = j + 2; return T_INVALID; }
        break;
      }
      if (c === 93) break;
      j++;
    }
    NX = j; return T_DATA;
  }
  function scanLt(t, j, end) {                        // after '<' in content
    if (j >= end) return T_PARTIAL;
    let c = t.charCodeAt(j);
    if (c === 33) {
      j++; if (j >= end) return T_PARTIAL;
      c = t.charCodeAt(j);
      if (c === 45) return scanComment(t, j + 1, end);
      if (c === 91) {
        j++; if (end - j < 6) return T_PARTIAL;
        for (let k = 0; k < 6; k++, j++) if (t[j] !== 'CDATA['[k]) { NX = j; return T_INVALID; }
        NX = j; return T_CDATA_OPEN;
      }
      NX = j; return T_INVALID;
    }
    if (c === 63) return scanPi(t, j + 1, end);
    if (c === 47) return scanEndTag(t, j + 1, end);
    if (!nmstrt(c)) { NX = j; return T_INVALID; }
    const ns = j; let colon = false;
    TAG = { name: '', atts: [] };
    for (j++; j < end;) {
      c = t.charCodeAt(j);
      if (nmchar(c)) { j++; continue; }
      if (c === 58) {
        if (colon) { NX = j; return T_INVALID; }
        colon = true; j++; if (j >= end) return T_PARTIAL;
        if (!nmstrt(t.charCodeAt(j))) { NX = j; return T_INVALID; }
        j++; continue;
      }
      TAG.name = t.slice(ns, j);
      if (c === 62) { NX = j + 1; return T_START; }
      if (c === 47) { j++; if (j >= end) return T_PARTIAL; if (t.charCodeAt(j) !== 62) { NX = j; return T_INVALID; } NX = j + 1; return T_EMPTY; }
      if (!isS(c)) { NX = j; return T_INVALID; }
      for (j++; j < end; j++) {
        c = t.charCodeAt(j);
        if (isS(c)) continue;
        if (nmstrt(c)) return scanAtts(t, j, end);
        if (c === 62) { NX = j + 1; return T_START; }
        if (c === 47) { j++; if (j >= end) return T_PARTIAL; if (t.charCodeAt(j) !== 62) { NX = j; return T_INVALID; } NX = j + 1; return T_EMPTY; }
        NX = j; return T_INVALID;
      }
      return T_PARTIAL;
    }
    return T_PARTIAL;
  }
  function scanAtts(t, j, end) {                      // j at the first attribute name
    let nameStart = j, colon = false, c;
    for (j++; j < end;) {
      c = t.charCodeAt(j);
      if (nmchar(c)) { j++; continue; }
      if (c === 58) {
        if (colon) { NX = j; return T_INVALID; }
        colon = true; j++; if (j >= end) return T_PARTIAL;
        if (!nmstrt(t.charCodeAt(j))) { NX = j; return T_INVALID; }
        j++; continue;
      }
      const name = t.slice(nameStart, j);
      if (isS(c)) {
        for (;;) { j++; if (j >= end) return T_PARTIAL; c = t.charCodeAt(j); if (c === 61) break; if (!isS(c)) { NX = j; return T_INVALID; } }
      } else if (c !== 61) { NX = j; return T_INVALID; }
      let open;
      for (;;) { j++; if (j >= end) return T_PARTIAL; open = t.charCodeAt(j); if (open === 34 || open === 39) break; if (!isS(open)) { NX = j; return T_INVALID; } }
      const valStart = ++j;
      for (;;) {
        if (j >= end) return T_PARTIAL;
        c = t.charCodeAt(j);
        if (c === open) break;
        if (nonXml(c) || c === 60) { NX = j; return T_INVALID; }
        if (c === 38) { const tok = scanRef(t, j + 1, end); if (tok === T_INVALID) return T_INVALID; if (tok === T_PARTIAL) return T_PARTIAL; j = NX; continue; }
        j++;
      }
      TAG.atts.push({ name, namePos: nameStart, valStart, valEnd: j });
      j++; if (j >= end) return T_PARTIAL;
      c = t.charCodeAt(j);
      if (c === 47) { j++; if (j >= end) return T_PARTIAL; if (t.charCodeAt(j) !== 62) { NX = j; return T_INVALID; } NX = j + 1; return T_EMPTY; }
      if (c === 62) { NX = j + 1; return T_START; }
      if (!isS(c)) { NX = j; return T_INVALID; }
      for (;;) {
        j++; if (j >= end) return T_PARTIAL;
        c = t.charCodeAt(j);
        if (isS(c)) continue;
        if (nmstrt(c)) break;
        if (c === 62) { NX = j + 1; return T_START; }
        if (c === 47) { j++; if (j >= end) return T_PARTIAL; if (t.charCodeAt(j) !== 62) { NX = j; return T_INVALID; } NX = j + 1; return T_EMPTY; }
        NX = j; return T_INVALID;
      }
      nameStart = j; colon = false; j++;
    }
    return T_PARTIAL;
  }
  function scanEndTag(t, j, end) {                    // after '</'
    if (j >= end) return T_PARTIAL;
    if (!nmstrt(t.charCodeAt(j))) { NX = j; return T_INVALID; }
    const ns = j;
    for (j++; j < end;) {
      const c = t.charCodeAt(j);
      if (nmchar(c) || c === 58) { j++; continue; }
      TAG = { name: t.slice(ns, j) };
      if (c === 62) { NX = j + 1; return T_END; }
      if (!isS(c)) { NX = j; return T_INVALID; }
      for (j++; j < end; j++) {
        const d = t.charCodeAt(j);
        if (isS(d)) continue;
        if (d === 62) { NX = j + 1; return T_END; }
        NX = j; return T_INVALID;
      }
      return T_PARTIAL;
    }
    return T_PARTIAL;
  }
  function cdataTok(t, i, end, internal) {
    if (i >= end) { NX = i; return T_NONE; }
    let c = t.charCodeAt(i), j = i + 1;
    if (c === 93) {
      if (j >= end) return T_PARTIAL;
      if (t.charCodeAt(j) === 93) {
        if (j + 1 >= end) return T_PARTIAL;
        if (t.charCodeAt(j + 1) === 62) { NX = j + 2; return T_CDATA_CLOSE; }
      }
    } else if (c === 13 && !internal) {
      if (j >= end) return T_PARTIAL; if (t.charCodeAt(j) === 10) j++; NX = j; return T_NEWLINE;
    } else if (c === 10) { NX = j; return T_NEWLINE; }
    else if (nonXml(c)) { NX = i; return T_INVALID; }
    while (j < end) { c = t.charCodeAt(j); if (c === 93 || c === 10 || (c === 13 && !internal) || nonXml(c)) break; j++; }
    NX = j; return T_DATA;
  }

  // ---------------- tree builder (ElementTree's TreeBuilder) ----------------
  let root = null, last = null, lastIsTail = false, buf = [];
  const stack = [];                                   // open elements: { el, raw, bindings }
  const flush = () => { if (buf.length) { if (last) { const s = buf.join(''); if (lastIsTail) last.tail = s; else last.text = s; } buf = []; } };
  const data = s => { if (s) buf.push(s); };
  const ns = new Map([['xml', XML_NS]]);              // prefix -> uri ('' is the default namespace)
  let tagLevel = 0;

  function account(len, pos) {
    expanded += len;
    if (expanded > 8 * 1024 * 1024 && expanded > 100 * n) fail(MSG.AMPLIFICATION, pos);
  }
  function undefinedForET(raw, pos) {                 // ElementTree's own message for skipped entities
    const b = new TextEncoder().encode(raw); const cut = new TextDecoder().decode(b.subarray(0, 100));
    fail(MSG.UNDEFINED + ' ' + cut, pos);
  }
  function addBinding(prefix, uri, base, bindings) {
    if (uri === '' && prefix !== null) fail(MSG.UNDECLARING, base);
    let mustBeXML = false;
    if (prefix === 'xmlns') fail(MSG.RESERVED_XMLNS, base);
    if (prefix === 'xml') mustBeXML = true;
    if (uri.includes('}')) fail(MSG.SYNTAX, base);    // '}' is ElementTree's namespace separator
    const isXML = uri === XML_NS;
    if (mustBeXML !== isXML) fail(mustBeXML ? MSG.RESERVED_XML : MSG.RESERVED_URI, base);
    if (!mustBeXML && uri === XMLNS_NS) fail(MSG.RESERVED_URI, base);
    const key = prefix === null ? '' : prefix;
    bindings.push([key, ns.has(key) ? ns.get(key) : undefined]);
    if (key === '' && uri === '') ns.delete(''); else ns.set(key, uri);
  }
  // attribute value normalisation (expat appendAttributeValue). `main`: the text is the document
  // itself, so error positions point into it; otherwise they stay at `base`. Values of attributes
  // declared with a tokenized type (ID, NMTOKEN, enumerations...) have their spaces collapsed.
  function attValue(t, a, b, internal, main, base, cdata, acc) {
    const space = () => { if (cdata || (acc.v !== '' && !acc.v.endsWith(' '))) acc.v += ' '; };
    let i = a;
    while (i < b) {
      const s = i, c = t.charCodeAt(i);
      if (c === 38) {
        const tok = scanRef(t, i + 1, b);
        if (tok === T_INVALID) fail(MSG.INVALID, main ? NX : base);
        if (tok === T_PARTIAL) fail(MSG.INVALID, main ? s : base);
        const next = NX;
        if (tok === T_CHAR_REF) {
          const r = charRefNumber(t, s); if (r < 0) fail(MSG.BAD_CHAR_REF, main ? s : base);
          if (r === 32) space(); else acc.v += String.fromCodePoint(r);
        } else {
          const name = t.slice(s + 1, next - 1);
          if (has(PREDEFINED, name)) acc.v += PREDEFINED[name];
          else {
            const ent = entities.get(name);
            if (!ent) { if (!hasParamEntityRefs || standalone) fail(MSG.UNDEFINED, base); }
            else {
              if (ent.open) fail(MSG.RECURSIVE, main ? s : base);
              if (ent.notation) fail(MSG.BINARY, main ? s : base);
              if (ent.text === null) fail(MSG.ATT_EXTERNAL, main ? s : base);
              ent.open = true; account(ent.text.length, base);
              attValue(ent.text, 0, ent.text.length, true, false, base, cdata, acc);
              ent.open = false;
            }
          }
        }
        i = next; continue;
      }
      if (c === 60) fail(MSG.INVALID, main ? s : base);
      if (c === 13 && !internal) { i++; if (i < b && t.charCodeAt(i) === 10) i++; space(); continue; }
      if (isS(c)) { space(); i++; continue; }
      let j = i + 1;
      while (j < b) { const d = t.charCodeAt(j); if (d === 38 || d === 60 || isS(d)) break; j++; }
      acc.v += t.slice(i, j); i = j;
    }
  }
  function storeAttValue(t, a, b, internal, main, base, cdata) {
    const acc = { v: '' }; attValue(t, a, b, internal, main, base, cdata, acc);
    return (!cdata && acc.v.endsWith(' ')) ? acc.v.slice(0, -1) : acc.v;
  }
  const attlists = new Map();                         // element raw name -> [{ name, value, cdata }] from <!ATTLIST>
  function defineAttribute(el, att, value) {
    const list = attlists.get(el) || []; attlists.set(el, list);
    if ((value !== null || att.isId) && list.some(d => d.name === att.name)) return;
    list.push({ name: att.name, value, cdata: att.cdata });
  }
  function startElement(t, s, internal, refPos) {
    const base = internal ? refPos : s, tag = TAG, bindings = [], seen = new Set(), atts = [];
    const defaults = attlists.get(tag.name) || [];
    const take = (name, v) => {
      if (name === 'xmlns') addBinding(null, v, base, bindings);
      else if (name.startsWith('xmlns:')) addBinding(name.slice(6), v, base, bindings);
      else atts.push([name, v]);
    };
    for (const a of tag.atts) {
      if (seen.has(a.name)) fail(MSG.DUPLICATE, internal ? refPos : a.namePos);
      seen.add(a.name);
      const decl = defaults.find(d => d.name === a.name);
      take(a.name, storeAttValue(t, a.valStart, a.valEnd, internal, !internal, base, decl ? decl.cdata : true));
    }
    for (const d of defaults) if (d.value !== null && !seen.has(d.name)) { seen.add(d.name); take(d.name, d.value); }
    const attrib = {}, expandedSeen = new Set();
    for (const [name, v] of atts) {
      const k = name.indexOf(':');
      if (k < 0) { attrib[name] = v; continue; }
      const prefix = name.slice(0, k);
      if (!ns.has(prefix)) fail(MSG.UNBOUND, base);
      const full = `{${ns.get(prefix)}}${name.slice(k + 1)}`;
      if (expandedSeen.has(full)) fail(MSG.DUPLICATE, base);
      expandedSeen.add(full); attrib[full] = v;
    }
    let qtag; const k = tag.name.indexOf(':');
    if (k >= 0) { const prefix = tag.name.slice(0, k); if (!ns.has(prefix)) fail(MSG.UNBOUND, base); qtag = `{${ns.get(prefix)}}${tag.name.slice(k + 1)}`; }
    else qtag = ns.has('') ? `{${ns.get('')}}${tag.name}` : tag.name;
    flush();
    const el = { tag: qtag, attrib, text: null, tail: null, children: [] };
    if (stack.length) stack[stack.length - 1].el.children.push(el); else root = el;
    stack.push({ el, raw: tag.name, bindings });
    last = el; lastIsTail = false; tagLevel++;
  }
  function endElement() {
    flush();
    const top = stack.pop();
    for (let i = top.bindings.length - 1; i >= 0; i--) { const [key, old] = top.bindings[i]; if (old === undefined) ns.delete(key); else ns.set(key, old); }
    last = top.el; lastIsTail = true; tagLevel--;
  }

  // doContent: returns where the epilog starts (main text) or end (entity text)
  function doContent(t, i, end, internal, refPos, startLevel) {
    for (;;) {
      const s = i, tok = contentTok(t, i, end, internal), next = NX;
      switch (tok) {
        case T_INVALID: fail(MSG.INVALID, internal ? refPos : next); break;
        case T_PARTIAL: fail(MSG.UNCLOSED, internal ? refPos : s); break;
        case T_NONE:
          if (oddTail && !internal) fail(MSG.UNCLOSED, s);
          if (startLevel > 0) { if (tagLevel !== startLevel) fail(MSG.ASYNC, refPos); return end; }
          fail(MSG.NO_ELEMENTS, s); break;
        case T_TRAILING_CR: case T_TRAILING_RSQB:
          data(tok === T_TRAILING_CR ? '\n' : t.slice(s, end));
          if (startLevel === 0) fail(MSG.NO_ELEMENTS, tok === T_TRAILING_CR ? s : end);
          if (tagLevel !== startLevel) fail(MSG.ASYNC, refPos);
          return end;
        case T_NEWLINE: data('\n'); break;
        case T_DATA: data(t.slice(s, next)); break;
        case T_CHAR_REF: { const r = charRefNumber(t, s); if (r < 0) fail(MSG.BAD_CHAR_REF, internal ? refPos : s); data(String.fromCodePoint(r)); break; }
        case T_ENTITY_REF: {
          const name = t.slice(s + 1, next - 1), pos = internal ? refPos : s;
          if (has(PREDEFINED, name)) { data(PREDEFINED[name]); break; }
          const ent = entities.get(name);
          if (!ent) { if (!hasParamEntityRefs || standalone) fail(MSG.UNDEFINED, pos); undefinedForET(t.slice(s, next), pos); }
          if (ent.open) fail(MSG.RECURSIVE, pos);
          if (ent.notation) fail(MSG.BINARY, pos);
          if (ent.text === null) undefinedForET(t.slice(s, next), pos);
          ent.open = true; account(ent.text.length, pos);
          doContent(ent.text, 0, ent.text.length, true, pos, tagLevel);
          ent.open = false; break;
        }
        case T_XML_DECL: fail(MSG.MISPLACED, internal ? refPos : s); break;
        case T_PI: case T_COMMENT: break;
        case T_CDATA_OPEN: {
          let j = next;
          for (;;) {
            const cs = j, ct = cdataTok(t, j, end, internal);
            if (ct === T_CDATA_CLOSE) break;
            if (ct === T_INVALID) fail(MSG.INVALID, internal ? refPos : NX);
            if (ct === T_NONE && oddTail && !internal) fail(MSG.UNCLOSED, cs);
            if (ct === T_PARTIAL || ct === T_NONE) fail(MSG.UNCLOSED_CDATA, internal ? refPos : cs);
            data(ct === T_NEWLINE ? '\n' : t.slice(cs, NX)); j = NX;
          }
          i = NX; continue;
        }
        case T_START: case T_EMPTY:
          startElement(t, s, internal, refPos);
          if (tok === T_EMPTY) { endElement(); if (tagLevel === 0) return next; }
          break;
        case T_END: {
          if (tagLevel === startLevel) fail(MSG.ASYNC, refPos);
          if (TAG.name !== stack[stack.length - 1].raw) fail(MSG.MISMATCH, internal ? refPos : s + 2);
          endElement(); if (tagLevel === 0) return next;
          break;
        }
      }
      i = next;
    }
  }

  // ---------------- prolog / DTD ----------------
  function prologTok(i) {
    if (i >= n) { NX = i; return T_NONE; }
    let c = src.charCodeAt(i), j = i + 1, tok;
    switch (c) {
      case 34: case 39: {                             // literal
        for (; j < n;) {
          const d = src.charCodeAt(j);
          if (nonXml(d)) { NX = j; return T_INVALID; }
          j++;
          if (d !== c) continue;
          if (j >= n) { NX = n; return P_LITERAL; }
          const e = src.charCodeAt(j); NX = j;
          return (isS(e) || e === 62 || e === 37 || e === 91) ? P_LITERAL : T_INVALID;
        }
        return T_PARTIAL;
      }
      case 60: {
        if (j >= n) return T_PARTIAL;
        c = src.charCodeAt(j);
        if (c === 33) {                               // '<!'
          j++; if (j >= n) return T_PARTIAL;
          c = src.charCodeAt(j);
          if (c === 45) return scanComment(src, j + 1, n);
          if (c === 91) { NX = j + 1; return P_COND_OPEN; }
          if (!((c >= 97 && c <= 122) || (c >= 65 && c <= 90) || c === 95)) { NX = j; return T_INVALID; }
          for (j++; j < n; j++) {
            c = src.charCodeAt(j);
            if (c === 37) { if (n - j < 2) return T_PARTIAL; const e = src.charCodeAt(j + 1); if (isS(e) || e === 37) { NX = j; return T_INVALID; } NX = j; return P_DECL_OPEN; }
            if (isS(c)) { NX = j; return P_DECL_OPEN; }
            if (!((c >= 97 && c <= 122) || (c >= 65 && c <= 90) || c === 95)) { NX = j; return T_INVALID; }
          }
          return T_PARTIAL;
        }
        if (c === 63) return scanPi(src, j + 1, n);
        if (nmstrt(c) || c >= 0x80) { NX = i; return P_INSTANCE; }
        NX = j; return T_INVALID;
      }
      case 13: case 10: case 32: case 9:
        while (j < n && isS(src.charCodeAt(j))) j++;
        NX = j; return P_S;
      case 37: return scanPercent(src, j, n);
      case 44: NX = j; return P_COMMA;
      case 91: NX = j; return P_OPEN_BRACKET;
      case 93:
        if (j >= n) { NX = n; return P_CLOSE_BRACKET; }
        if (src.charCodeAt(j) === 93) { if (n - j < 2) return T_PARTIAL; if (src.charCodeAt(j + 1) === 62) { NX = j + 2; return P_COND_CLOSE; } }
        NX = j; return P_CLOSE_BRACKET;
      case 40: NX = j; return P_OPEN_PAREN;
      case 41: {
        if (j >= n) { NX = n; return P_CLOSE_PAREN; }
        const d = src.charCodeAt(j);
        if (d === 42 || d === 63 || d === 43) { NX = j + 1; CLOSE_REP = String.fromCharCode(d); return P_CLOSE_PAREN_REP; }
        NX = j; return (isS(d) || d === 62 || d === 44 || d === 124 || d === 41) ? P_CLOSE_PAREN : T_INVALID;
      }
      case 124: NX = j; return P_OR;
      case 62: NX = j; return P_DECL_CLOSE;
      case 35: {                                      // '#NAME'
        if (j >= n) return T_PARTIAL;
        if (!nmstrt(src.charCodeAt(j))) { NX = j; return T_INVALID; }
        for (j++; j < n; j++) {
          const d = src.charCodeAt(j);
          if (nmchar(d)) continue;
          if (isS(d) || d === 41 || d === 62 || d === 37 || d === 124) { NX = j; return P_POUND_NAME; }
          NX = j; return T_INVALID;
        }
        NX = n; return P_POUND_NAME;
      }
      default:
        if (nmstrt(c)) tok = P_NAME;
        else if (isDigit(c) || c === 46 || c === 45 || c === 58 || (c >= 0x80 && nmchar(c))) tok = P_NMTOKEN;
        else { NX = i; return T_INVALID; }
    }
    while (j < n) {
      c = src.charCodeAt(j);
      if (nmchar(c)) { j++; continue; }
      if (c === 62 || c === 41 || c === 44 || c === 124 || c === 91 || c === 37 || isS(c)) { NX = j; return tok; }
      if (c === 58) {
        j++;
        if (tok === P_NAME) { if (j >= n) return T_PARTIAL; tok = P_PREFIXED; if (nmchar(src.charCodeAt(j))) j++; else { const d = src.charCodeAt(j); if (d >= 0x80) { NX = j; return T_INVALID; } tok = P_NMTOKEN; } }
        else if (tok === P_PREFIXED) tok = P_NMTOKEN;
        continue;
      }
      if (c === 43 || c === 42 || c === 63) { if (tok === P_NMTOKEN) { NX = j; return T_INVALID; } NX = j + 1; return P_NAME_SUFFIX; }
      NX = j; return T_INVALID;
    }
    NX = n; return tok;
  }
  function xmlDecl(s, next) {                         // expat doParseXmlDecl
    const end = next - 2;
    const ascii = p => { if (p >= end) return -1; const c = src.charCodeAt(p); return c < 128 ? c : -1; };
    const sp = c => c === 32 || c === 9 || c === 10 || c === 13;
    function pseudo(ptr) {                            // -> { ok, name, val, next }; next stays put when there is no name
      const p0 = ptr;
      if (ptr === end) return { ok: true, name: null, next: p0 };
      if (!sp(ascii(ptr))) return { ok: false, next: ptr };
      do ptr++; while (sp(ascii(ptr)));
      if (ptr === end) return { ok: true, name: null, next: p0 };
      const name = ptr; let nameEnd, c;
      for (;;) {
        c = ascii(ptr);
        if (c === -1) return { ok: false, next: ptr };
        if (c === 61) { nameEnd = ptr; break; }
        if (sp(c)) { nameEnd = ptr; do ptr++; while (sp(c = ascii(ptr))); if (c !== 61) return { ok: false, next: ptr }; break; }
        ptr++;
      }
      if (ptr === name) return { ok: false, next: ptr };
      ptr++; c = ascii(ptr);
      while (sp(c)) { ptr++; c = ascii(ptr); }
      if (c !== 34 && c !== 39) return { ok: false, next: ptr };
      const open = c; ptr++; const val = ptr;
      for (;; ptr++) {
        c = ascii(ptr);
        if (c === open) break;
        if (!((c >= 97 && c <= 122) || (c >= 65 && c <= 90) || (c >= 48 && c <= 57) || c === 46 || c === 45 || c === 95)) return { ok: false, next: ptr };
      }
      return { ok: true, name: src.slice(name, nameEnd), namePos: name, val, valEnd: ptr, next: ptr + 1 };
    }
    let ptr = s + 5, r = pseudo(ptr);
    if (!r.ok || r.name === null) fail(MSG.XML_DECL, r.next);
    if (r.name !== 'version') fail(MSG.XML_DECL, r.namePos);
    ptr = r.next; r = pseudo(ptr);
    if (!r.ok) fail(MSG.XML_DECL, r.next);
    if (r.name === null) return;
    if (r.name === 'encoding') {
      const c = ascii(r.val); if (!((c >= 97 && c <= 122) || (c >= 65 && c <= 90))) fail(MSG.XML_DECL, r.val);
      ptr = r.next; r = pseudo(ptr);
      if (!r.ok) fail(MSG.XML_DECL, r.next);
      if (r.name === null) return;
    }
    if (r.name !== 'standalone') fail(MSG.XML_DECL, r.namePos);
    const v = src.slice(r.val, r.valEnd);
    if (v === 'yes') standalone = true; else if (v !== 'no') fail(MSG.XML_DECL, r.val);
    ptr = r.next; while (sp(ascii(ptr))) ptr++;
    if (ptr !== end) fail(MSG.XML_DECL, ptr);
  }
  function checkPubid(s, next) {
    for (let i = s + 1; i < next - 1; i++) {
      const c = src[i];
      if (!/[a-zA-Z0-9\-'()+,./:=?;!*#@$_% \r\n]/.test(c)) fail(MSG.PUBLICID, i);
    }
  }
  function storeEntityValue(a, b) {                   // literal content -> replacement text
    const out = []; let i = a;
    while (i < b) {
      const s = i, c = src.charCodeAt(i);
      if (c === 38) {
        const tok = scanRef(src, i + 1, b);
        if (tok === T_INVALID) fail(MSG.INVALID, NX);
        if (tok === T_PARTIAL) fail(MSG.INVALID, s);
        if (tok === T_CHAR_REF) { const r = charRefNumber(src, s); if (r < 0) fail(MSG.BAD_CHAR_REF, s); out.push(String.fromCodePoint(r)); }
        else out.push(src.slice(s, NX));
        i = NX; continue;
      }
      if (c === 37) {
        const tok = scanPercent(src, i + 1, b);
        if (tok === P_PE_REF) fail(MSG.PE_REF, s);
        if (tok === T_PARTIAL) fail(MSG.INVALID, s);
        fail(MSG.INVALID, NX);
      }
      if (c === 10) { out.push('\n'); i++; continue; }
      if (c === 13) { i++; if (i < b && src.charCodeAt(i) === 10) i++; out.push('\n'); continue; }
      let j = i + 1;
      while (j < b) { const d = src.charCodeAt(j); if (d === 38 || d === 37 || d === 10 || d === 13) break; j++; }
      out.push(src.slice(i, j)); i = j;
    }
    return out.join('');
  }
  function prolog() {
    let i = (n > 0 && src.charCodeAt(0) === 0xFEFF) ? 1 : 0;       // byte-order mark
    let state = 'prolog0', decl = null, declEl = '', declAtt = null, level = 0;
    const define = value => { if (keepProcessing) defineAttribute(declEl, declAtt, value); };
    const named = t => t === P_NAME || t === P_PREFIXED;
    for (;;) {
      const s = i, tok = prologTok(i), next = NX;
      if (tok === T_INVALID) fail(MSG.INVALID, next);
      if (tok === T_PARTIAL || (tok === T_NONE && oddTail)) fail(MSG.UNCLOSED, s);
      if (tok === T_NONE) fail(MSG.NO_ELEMENTS, s);
      const err = () => fail(tok === P_PE_REF ? MSG.PE_REF : tok === T_XML_DECL ? MSG.MISPLACED : MSG.SYNTAX, s);
      const word = () => src.slice(s, next);
      i = next;
      if (tok === P_S) { if (state === 'prolog0') state = 'prolog1'; continue; }
      switch (state) {
        case 'prolog0': case 'prolog1': case 'prolog2':
          if (tok === T_XML_DECL && state === 'prolog0') { xmlDecl(s, next); state = 'prolog1'; }
          else if (tok === T_PI || tok === T_COMMENT) { if (state === 'prolog0') state = 'prolog1'; }
          else if (tok === P_DECL_OPEN && state !== 'prolog2' && src.slice(s + 2, next) === 'DOCTYPE') state = 'doctype0';
          else if (tok === P_INSTANCE) return s;
          else err();
          break;
        case 'doctype0': if (tok === P_NAME || tok === P_PREFIXED) state = 'doctype1'; else err(); break;
        case 'doctype1':
          if (tok === P_OPEN_BRACKET) state = 'internalSubset';
          else if (tok === P_DECL_CLOSE) state = 'prolog2';
          else if (tok === P_NAME && word() === 'SYSTEM') state = 'doctype3';
          else if (tok === P_NAME && word() === 'PUBLIC') state = 'doctype2';
          else err();
          break;
        case 'doctype2': if (tok === P_LITERAL) { checkPubid(s, next); state = 'doctype3'; } else err(); break;
        case 'doctype3': if (tok === P_LITERAL) { hasParamEntityRefs = true; state = 'doctype4'; } else err(); break;
        case 'doctype4': if (tok === P_OPEN_BRACKET) state = 'internalSubset'; else if (tok === P_DECL_CLOSE) state = 'prolog2'; else err(); break;
        case 'doctype5': if (tok === P_DECL_CLOSE) state = 'prolog2'; else err(); break;
        case 'internalSubset': {
          if (tok === P_DECL_OPEN) {
            const w = src.slice(s + 2, next);
            if (w === 'ENTITY') state = 'entity0';
            else if (w === 'ATTLIST') state = 'attlist0';
            else if (w === 'ELEMENT') state = 'element0';
            else if (w === 'NOTATION') state = 'notation0';
            else err();
          } else if (tok === T_PI || tok === T_COMMENT) { /* nothing */ }
          else if (tok === P_PE_REF) { hasParamEntityRefs = true; keepProcessing = standalone; }
          else if (tok === P_CLOSE_BRACKET) state = 'doctype5';
          else err();
          break;
        }
        case 'entity0':
          if (tok === P_PERCENT) state = 'entity1';
          else if (tok === P_NAME) {
            const name = word(); decl = null;
            if (keepProcessing && !entities.has(name)) { decl = { text: null, notation: false, open: false }; entities.set(name, decl); }
            state = 'entity2';
          } else err();
          break;
        case 'entity1': if (tok === P_NAME) { decl = null; state = 'entity7'; } else err(); break;
        case 'entity2': case 'entity7':
          if (tok === P_NAME && word() === 'SYSTEM') state = state === 'entity2' ? 'entity4' : 'entity9';
          else if (tok === P_NAME && word() === 'PUBLIC') state = state === 'entity2' ? 'entity3' : 'entity8';
          else if (tok === P_LITERAL) {
            if (keepProcessing) { const v = storeEntityValue(s + 1, next - 1); if (decl) decl.text = v; }
            state = 'declClose';
          } else err();
          break;
        case 'entity3': case 'entity8': if (tok === P_LITERAL) { checkPubid(s, next); state = state === 'entity3' ? 'entity4' : 'entity9'; } else err(); break;
        case 'entity4': if (tok === P_LITERAL) state = 'entity5'; else err(); break;
        case 'entity9': if (tok === P_LITERAL) state = 'declClose'; else err(); break;
        case 'entity5':
          if (tok === P_DECL_CLOSE) state = 'internalSubset';
          else if (tok === P_NAME && word() === 'NDATA') state = 'entity6';
          else err();
          break;
        case 'entity6': if (tok === P_NAME) { if (decl) decl.notation = true; state = 'declClose'; } else err(); break;
        case 'declClose': if (tok === P_DECL_CLOSE) state = 'internalSubset'; else err(); break;
        // expat xmlrole.c: attlist0..9, element0..7, notation0..4
        case 'attlist0': if (named(tok)) { declEl = word(); state = 'attlist1'; } else err(); break;
        case 'attlist1':
          if (tok === P_DECL_CLOSE) state = 'internalSubset';
          else if (named(tok)) { declAtt = { name: word(), cdata: false, isId: false }; state = 'attlist2'; }
          else err();
          break;
        case 'attlist2':
          if (tok === P_NAME && ['CDATA', 'ID', 'IDREF', 'IDREFS', 'ENTITY', 'ENTITIES', 'NMTOKEN', 'NMTOKENS'].includes(word())) {
            declAtt.cdata = word() === 'CDATA'; declAtt.isId = word() === 'ID'; state = 'attlist8';
          } else if (tok === P_NAME && word() === 'NOTATION') state = 'attlist5';
          else if (tok === P_OPEN_PAREN) state = 'attlist3';
          else err();
          break;
        case 'attlist3': if (tok === P_NMTOKEN || named(tok)) state = 'attlist4'; else err(); break;
        case 'attlist4': if (tok === P_CLOSE_PAREN) state = 'attlist8'; else if (tok === P_OR) state = 'attlist3'; else err(); break;
        case 'attlist5': if (tok === P_OPEN_PAREN) state = 'attlist6'; else err(); break;
        case 'attlist6': if (tok === P_NAME) state = 'attlist7'; else err(); break;
        case 'attlist7': if (tok === P_CLOSE_PAREN) state = 'attlist8'; else if (tok === P_OR) state = 'attlist6'; else err(); break;
        case 'attlist8': case 'attlist9': {
          const w = tok === P_POUND_NAME ? src.slice(s + 1, next) : '';
          if (state === 'attlist8' && (w === 'IMPLIED' || w === 'REQUIRED')) { define(null); state = 'attlist1'; }
          else if (state === 'attlist8' && w === 'FIXED') state = 'attlist9';
          else if (tok === P_LITERAL) {
            if (keepProcessing) define(storeAttValue(src, s + 1, next - 1, false, true, s, declAtt.cdata));
            state = 'attlist1';
          } else err();
          break;
        }
        case 'element0': if (named(tok)) state = 'element1'; else err(); break;
        case 'element1':
          if (tok === P_NAME && (word() === 'EMPTY' || word() === 'ANY')) state = 'declClose';
          else if (tok === P_OPEN_PAREN) { level = 1; state = 'element2'; }
          else err();
          break;
        case 'element2':
          if (tok === P_POUND_NAME && src.slice(s + 1, next) === 'PCDATA') state = 'element3';
          else if (tok === P_OPEN_PAREN) { level = 2; state = 'element6'; }
          else if (named(tok) || tok === P_NAME_SUFFIX) state = 'element7';
          else err();
          break;
        case 'element3':
          if (tok === P_CLOSE_PAREN || (tok === P_CLOSE_PAREN_REP && CLOSE_REP === '*')) state = 'declClose';
          else if (tok === P_OR) state = 'element4';
          else err();
          break;
        case 'element4': if (named(tok)) state = 'element5'; else err(); break;
        case 'element5':
          if (tok === P_CLOSE_PAREN_REP && CLOSE_REP === '*') state = 'declClose';
          else if (tok === P_OR) state = 'element4';
          else err();
          break;
        case 'element6':
          if (tok === P_OPEN_PAREN) level++;
          else if (named(tok) || tok === P_NAME_SUFFIX) state = 'element7';
          else err();
          break;
        case 'element7':
          if (tok === P_CLOSE_PAREN || tok === P_CLOSE_PAREN_REP) { if (--level === 0) state = 'declClose'; }
          else if (tok === P_COMMA || tok === P_OR) state = 'element6';
          else err();
          break;
        case 'notation0': if (tok === P_NAME) state = 'notation1'; else err(); break;
        case 'notation1':
          if (tok === P_NAME && word() === 'SYSTEM') state = 'notation3';
          else if (tok === P_NAME && word() === 'PUBLIC') state = 'notation2';
          else err();
          break;
        case 'notation2': if (tok === P_LITERAL) { checkPubid(s, next); state = 'notation4'; } else err(); break;
        case 'notation3': if (tok === P_LITERAL) state = 'declClose'; else err(); break;
        case 'notation4':
          if (tok === P_LITERAL) state = 'declClose';
          else if (tok === P_DECL_CLOSE) state = 'internalSubset';
          else err();
          break;
        default: err();
      }
    }
  }
  function epilog(i) {
    for (;;) {
      const s = i, tok = prologTok(i);
      if (tok === T_NONE && oddTail) fail(MSG.UNCLOSED, s);
      if (tok === T_NONE) return;
      if (tok === T_INVALID) fail(MSG.INVALID, NX);
      if (tok === T_PARTIAL) fail(MSG.UNCLOSED, s);
      if (tok !== P_S && tok !== T_PI && tok !== T_COMMENT) fail(MSG.JUNK, s);
      i = NX;
    }
  }

  const start = prolog();
  epilog(doContent(src, start, n, false, -1, 0));
  return root;
}

// ElementTree-style lookups over parsed elements
const localName = tag => { const k = tag.indexOf('}'); return k >= 0 ? tag.slice(k + 1) : tag; };   // tag.split("}", 1)[-1]
const tagMatches = (tag, want) => want.startsWith('{}') ? tag === want.slice(2) : tag === want;      // '{}x' == 'x' in ElementPath

// =========================================================================================
// io._xml_root_tag
// =========================================================================================
function xmlRootTag(data) {
  let bytes;
  if (typeof data === 'string') bytes = new TextEncoder().encode(data);
  else if (data instanceof ArrayBuffer) bytes = new Uint8Array(data);
  else bytes = data;
  const head = new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes.subarray(0, 4000));
  const i = head.indexOf('<?xml');
  let j = head.indexOf('<', i >= 0 ? i + 1 : 0);
  while (j >= 0 && (head.startsWith('<!--', j) || head.startsWith('<!DO', j))) {
    const close = head.indexOf('>', j);
    if (close < 0) return '';                          // unterminated comment or DOCTYPE: no root (as planner/io.py)
    j = head.indexOf('<', close + 1);
  }
  if (j < 0) return '';
  const words = pySplit(head.slice(j + 1));
  if (!words.length) throw new Error('list index out of range');
  const tag = words[0].split('>')[0];
  const parts = tag.split(':');
  return parts[parts.length - 1].replace(/^\/+|\/+$/g, '');
}

// =========================================================================================
// model constructors (the defaults pydantic fills in)
// =========================================================================================
const mkCalendar = (id, o = {}) => Object.assign({ id, name: 'Standard', hours_per_day: 8, day_start: '08:00:00', working_days: [0, 1, 2, 3, 4], exceptions: {} }, o);
const mkProject = o => Object.assign({ id: '', name: '', start: null, data_date: null, must_finish_by: null, default_calendar_id: 'std', calendars: {},
  wbs: [], activities: [], relationships: [], resources: [], assignments: [], description: '', assumptions: [], code_types: {}, baselines: [], revisions: [],
  levelled: false, finish: null, scheduled_at: null }, o);
const mkActivity = o => Object.assign({ id: '', name: '', wbs_id: null, calendar_id: null, type: 'task', duration_hours: 0, constraint: 'none',
  constraint_date: null, status: 'not_started', actual_start: null, actual_finish: null, remaining_hours: null, percent_complete: 0,
  baseline_start: null, baseline_finish: null, early_start: null, early_finish: null, late_start: null, late_finish: null,
  total_float_hours: null, free_float_hours: null, critical: false, notes: '', codes: {}, priority: 500, level_delay_hours: 0 }, o);
const mkWbs = (id, name, parent_id, code, seq) => ({ id, name, parent_id, code, seq });
const mkRel = (predecessor_id, successor_id, type, lag_hours) => ({ predecessor_id, successor_id, type, lag_hours, driving: false });
const mkResource = (id, name, type, rate) => ({ id, name, type, unit: 'h', rate, max_units_per_day: null, colour: null });
const mkAssignment = (activity_id, resource_id, units, cost) => ({ activity_id, resource_id, units, cost, actual_cost: 0 });
function finishProject(project, cals) {               // Project(...calendars=cals) + ensure_default_calendar()
  if (!cals.has(project.default_calendar_id)) cals.set(project.default_calendar_id, mkCalendar(project.default_calendar_id));
  const out = {}; for (const [k, v] of cals) out[k] = v;
  project.calendars = out;
  return project;
}

// =========================================================================================
// Primavera P6 XML (planner/pmxml.py)
// =========================================================================================
const P6_ACT_TYPE = { 'Task Dependent': 'task', 'Resource Dependent': 'task', 'Start Milestone': 'start_milestone', 'Finish Milestone': 'finish_milestone',
  'Level of Effort': 'level_of_effort', 'WBS Summary': 'level_of_effort' };
const P6_STATUS = { 'Not Started': 'not_started', 'In Progress': 'in_progress', 'Completed': 'complete' };
const P6_CSTR = { 'Start On or After': 'start_on_or_after', 'Start On or Before': 'start_on_or_before', 'Finish On or After': 'finish_on_or_after',
  'Finish On or Before': 'finish_on_or_before', 'Start On': 'must_start_on', 'Finish On': 'must_finish_on', 'Mandatory Start': 'must_start_on',
  'Mandatory Finish': 'must_finish_on', 'As Late As Possible': 'as_late_as_possible' };
const P6_LINK = { 'Finish to Start': 'FS', 'Start to Start': 'SS', 'Finish to Finish': 'FF', 'Start to Finish': 'SF' };
const P6_DAYS = { Monday: 0, Tuesday: 1, Wednesday: 2, Thursday: 3, Friday: 4, Saturday: 5, Sunday: 6 };
const P6_RES_TYPE = { Labor: 'labour', Nonlabor: 'equipment', Material: 'material' };
// Project/RelationshipLagCalendar (pmxml._lag_calendar): "Predecessor Activity Calendar", "Successor Activity Calendar",
// "24 Hour Calendar" or "Project Default Calendar", matched by keyword; anything else is left unset
function p6LagCalendar(s) {
  s = (s || '').toLowerCase();
  if (s.includes('successor')) return 'successor';
  if (s.includes('24')) return '24h';
  if (s.includes('project')) return 'project';
  if (s.includes('predecessor')) return 'predecessor';
  return null;
}

const kids = (el, name) => el.children.filter(c => localName(c.tag) === name);
function ptext(el, name, d = '') {
  if (!el) return d;
  for (const c of el.children) if (localName(c.tag) === name) return c.text ? c.text : d;
  return d;
}
function pdt(s) { s = pyStrip(s || ''); return s ? strptime19(pySlice(s, 19)) : null; }
function worktimeHours(el) {
  let total = 0, first = null;
  for (const wt of kids(el, 'WorkTime')) {
    const st = ptext(wt, 'Start'), fi = ptext(wt, 'Finish');
    if (!st || !fi) continue;
    const a = hmOf(st), b = hmOf(fi);
    if (first === null) first = a;
    let mins = (b.h * 60 + b.m) - (a.h * 60 + a.m);
    if (b.s === 59 || fi.startsWith('23:59')) mins += 1;
    if (b.m === 59) mins += 1;
    total += Math.max(0, mins) / 60;
  }
  const snapped = E.pyRound(total * 4, 0) / 4;
  return [Math.abs(snapped - total) < 0.06 ? snapped : E.pyRound(total, 2), first];
}
function p6Calendar(el) {
  const cal = mkCalendar(ptext(el, 'ObjectId'), { name: ptext(el, 'Name') || 'Calendar', hours_per_day: pyOr(pyFloatOr(ptext(el, 'HoursPerDay'), 8), 8) });
  const week = kids(el, 'StandardWorkWeek'), wd = [], hours = []; let firstStart = null;
  if (week.length) {
    for (const d of kids(week[0], 'StandardWorkHours')) {
      const name = ptext(d, 'DayOfWeek'); const [h, start] = worktimeHours(d);
      if (h > 0 && has(P6_DAYS, name)) { wd.push(P6_DAYS[name]); hours.push(h); firstStart = firstStart || start; }
    }
  }
  if (wd.length) { cal.working_days = wd.slice().sort((a, b) => a - b); cal.hours_per_day = maxByCount(hours); }
  if (firstStart) cal.day_start = timeStr(firstStart);
  for (const ex of kids(el, 'HolidayOrExceptions')) {
    for (const h of kids(ex, 'HolidayOrException')) {
      const d = pdt(ptext(h, 'Date'));
      if (d) cal.exceptions[d.slice(0, 10)] = worktimeHours(h)[0];
    }
  }
  return cal;
}
function readPmxml(text, projectIndex = 0) {
  const root = parseXml(text);
  if (localName(root.tag) !== 'APIBusinessObjects') throw new Error('Not a P6 XML file (expected <APIBusinessObjects>)');
  const projects = kids(root, 'Project');
  if (!projects.length) throw new Error('P6 XML has no <Project>');
  let idx = Math.min(projectIndex, projects.length - 1);
  if (idx < 0) idx += projects.length;
  if (idx < 0) throw new Error('list index out of range');
  const pe = projects[idx];

  const cals = new Map();
  for (const c of kids(root, 'Calendar').concat(kids(pe, 'Calendar'))) { const cal = p6Calendar(c); cals.set(cal.id, cal); }
  const defaultCal = ptext(pe, 'ActivityDefaultCalendarObjectId') || (cals.size ? cals.keys().next().value : 'std');
  const start = pdt(ptext(pe, 'PlannedStartDate')) || pdt(ptext(pe, 'DataDate')) || nowAt8();
  const project = mkProject({ id: pySlice(ptext(pe, 'Id') || 'PROJ', 20), name: ptext(pe, 'Name') || ptext(pe, 'Id') || 'Project', start,
    data_date: pdt(ptext(pe, 'DataDate')), must_finish_by: pdt(ptext(pe, 'MustFinishByDate')), default_calendar_id: defaultCal,
    description: ptext(pe, 'Description') });
  const lagCalendar = p6LagCalendar(ptext(pe, 'RelationshipLagCalendar'));
  if (lagCalendar) project.lag_calendar = lagCalendar;

  const rootWbs = ptext(pe, 'WBSObjectId'), wbsByObj = new Map();
  for (const w of kids(pe, 'WBS')) {
    const oid = ptext(w, 'ObjectId');
    if (oid === rootWbs || !ptext(w, 'ParentObjectId')) continue;
    wbsByObj.set(oid, ptext(w, 'Code') || oid);
  }
  for (const w of kids(pe, 'WBS')) {
    const oid = ptext(w, 'ObjectId');
    if (!wbsByObj.has(oid)) continue;
    const parent = ptext(w, 'ParentObjectId'), code = wbsByObj.get(oid);
    project.wbs.push(mkWbs(code, ptext(w, 'Name'), wbsByObj.has(parent) ? wbsByObj.get(parent) : null, code, pyIntOfFloat(pyFloatOr(ptext(w, 'SequenceNumber')))));
  }

  const actByObj = new Map();
  for (const a of kids(pe, 'Activity')) {
    const oid = ptext(a, 'ObjectId'), aid = ptext(a, 'Id') || `A${oid}`;
    actByObj.set(oid, aid);
    const status = get(P6_STATUS, ptext(a, 'Status'), 'not_started');
    const planned = pyFloatOr(ptext(a, 'PlannedDuration')), remain = pyFloatOr(ptext(a, 'RemainingDuration'));
    const pctType = ptext(a, 'PercentCompleteType');
    let pct;
    if (status === 'complete') pct = 100;
    else if (status === 'not_started') pct = 0;
    else if (pctType === 'Physical') pct = 100 * pyFloatOr(ptext(a, 'PhysicalPercentComplete'));
    else if (pctType === 'Units') pct = 100 * pyFloatOr(ptext(a, 'UnitsPercentComplete'));
    else pct = ptext(a, 'DurationPercentComplete') ? 100 * pyFloatOr(ptext(a, 'DurationPercentComplete')) : (planned !== 0 ? 100 * (planned - remain) / planned : 0);
    let actStart = pdt(ptext(a, 'ActualStartDate')), actFin = pdt(ptext(a, 'ActualFinishDate'));
    if (status !== 'not_started' && actStart === null) actStart = pdt(ptext(a, 'StartDate')) || pdt(ptext(a, 'PlannedStartDate'));
    if (status === 'complete' && actFin === null) actFin = pdt(ptext(a, 'FinishDate')) || pdt(ptext(a, 'PlannedFinishDate')) || actStart;
    const calId = ptext(a, 'CalendarObjectId'), wbsObj = ptext(a, 'WBSObjectId');
    project.activities.push(mkActivity({
      id: aid, name: ptext(a, 'Name'), wbs_id: wbsByObj.has(wbsObj) ? wbsByObj.get(wbsObj) : null,
      calendar_id: cals.has(calId) ? calId : null,
      type: get(P6_ACT_TYPE, ptext(a, 'Type'), 'task'), duration_hours: planned,
      constraint: get(P6_CSTR, ptext(a, 'PrimaryConstraintType'), 'none'), constraint_date: pdt(ptext(a, 'PrimaryConstraintDate')),
      status, actual_start: actStart, actual_finish: actFin,
      remaining_hours: status !== 'not_started' ? remain : null, percent_complete: E.pyRound(pct, 2),
      early_start: pdt(ptext(a, 'StartDate')), early_finish: pdt(ptext(a, 'FinishDate')),
      late_start: pdt(ptext(a, 'RemainingLateStartDate')), late_finish: pdt(ptext(a, 'RemainingLateFinishDate')),
      baseline_start: pdt(ptext(a, 'PlannedStartDate')), baseline_finish: pdt(ptext(a, 'PlannedFinishDate')),
      notes: pySlice(ptext(a, 'NotesToResources').replace(/<[^>]+>/g, ''), 500),
    }));
  }
  for (const r of kids(pe, 'ActivityRelationship').concat(kids(root, 'ActivityRelationship'))) {
    const p = ptext(r, 'PredecessorActivityObjectId'), s = ptext(r, 'SuccessorActivityObjectId');
    if (actByObj.has(p) && actByObj.has(s)) project.relationships.push(mkRel(actByObj.get(p), actByObj.get(s), get(P6_LINK, ptext(r, 'Type'), 'FS'), pyFloatOr(ptext(r, 'Lag'))));
  }
  const resByObj = new Map();
  for (const r of kids(root, 'Resource').concat(kids(pe, 'Resource'))) {
    const oid = ptext(r, 'ObjectId');
    resByObj.set(oid, mkResource(pySlice(ptext(r, 'Id') || `R${oid}`, 20), ptext(r, 'Name') || oid, get(P6_RES_TYPE, ptext(r, 'ResourceType'), 'labour'), pyFloatOr(ptext(r, 'PricePerUnit'))));
  }
  const used = new Set();
  for (const x of kids(pe, 'ResourceAssignment').concat(kids(root, 'ResourceAssignment'))) {
    const a = ptext(x, 'ActivityObjectId'), r = ptext(x, 'ResourceObjectId');
    if (actByObj.has(a) && resByObj.has(r)) {
      used.add(r);
      project.assignments.push(mkAssignment(actByObj.get(a), resByObj.get(r).id, pyFloatOr(ptext(x, 'PlannedUnits')), pyFloatOr(ptext(x, 'PlannedCost'))));
    }
  }
  project.resources = [...resByObj.keys()].filter(k => used.has(k)).map(k => resByObj.get(k));
  return finishProject(project, cals);
}

// =========================================================================================
// MS Project XML / MSPDI (planner/mspxml.py read_mspdi)
// =========================================================================================
const MSP_NS = 'http://schemas.microsoft.com/project';
const MSP_LINK = { 0: 'FF', 1: 'FS', 2: 'SF', 3: 'SS' };
// LagFormat values that mean elapsed time (mspxml.ELAPSED_LAG_FORMATS)
const MSP_ELAPSED_LAG = new Set(['4', '6', '8', '10', '12', '20', '36', '38', '40', '42', '44', '52']);
const MSP_CSTR = { 0: 'none', 1: 'as_late_as_possible', 2: 'must_start_on', 3: 'must_finish_on', 4: 'start_on_or_after', 5: 'start_on_or_before',
  6: 'finish_on_or_after', 7: 'finish_on_or_before' };
const MSP_RES = { 0: 'material', 1: 'labour', 2: 'cost' };
const RE_DURATION = /^P(?:(\p{Nd}+)D)?T?(?:(\p{Nd}+)H)?(?:(\p{Nd}+)M)?(?:(\p{Nd}+(?:\.\p{Nd}+)?)S)?/u;
function parseDurationHours(s) {                     // PT16H30M0S -> 16.5
  const m = (s || '').match(RE_DURATION);
  if (!m) return 0;
  const [d, h, mi, sec] = m.slice(1).map(x => x ? pyFloat(x) : 0);
  return d * 8 + h + mi / 60 + sec / 3600;
}
function mdt(s) {
  s = pyStrip(s || '');
  if (!s) return null;
  return strptime19(pySlice(s, 19)) || strptime10(pySlice(s, 10));
}

function readMspdi(text) {
  let root = parseXml(text);
  if (root.tag !== `{${MSP_NS}}Project`) {             // tolerate files without the namespace
    root = parseXml(String(text).replace(/xmlns="[^"]*"/, ''));
    return readMsp(root, '');
  }
  return readMsp(root, MSP_NS);
}
function readMsp(root, NS) {
  const q = t => `{${NS}}${t}`;
  const find = (el, t) => { if (!el) return null; const w = q(t); for (const c of el.children) if (tagMatches(c.tag, w)) return c; return null; };
  const findall = (el, ...path) => {
    let res = [el];
    for (const t of path) { const w = q(t), nxt = []; for (const e of res) for (const c of e.children) if (tagMatches(c.tag, w)) nxt.push(c); res = nxt; }
    return res;
  };
  const text = (el, t, d = '') => { const x = find(el, t); return (x && x.text) ? x.text : d; };
  const hoursOf = wts => { let h = 0; for (const wt of wts) { const a = hmOf(text(wt, 'FromTime')), b = hmOf(text(wt, 'ToTime')); h += ((b.h * 60 + b.m) - (a.h * 60 + a.m)) / 60; } return h; };

  const minutesPerDay = pyFloat(text(root, 'MinutesPerDay', '480') || '480');
  const hpdDefault = minutesPerDay / 60;

  const cals = new Map();
  for (const c of findall(root, 'Calendars', 'Calendar')) {
    const uid = text(c, 'UID');
    const cal = mkCalendar(uid, { name: text(c, 'Name') || `Calendar ${uid}`, hours_per_day: hpdDefault });
    const wd = [], hours = []; let firstStart = null;
    for (const day of findall(c, 'WeekDays', 'WeekDay')) {
      const dtype = pyInt(text(day, 'DayType', '0') || '0');
      const working = text(day, 'DayWorking', '0') === '1';
      if (dtype < 1 || dtype > 7) continue;
      if (working) {
        let h = 0;
        for (const wt of findall(day, 'WorkingTimes', 'WorkingTime')) {
          const a = hmOf(text(wt, 'FromTime')), b = hmOf(text(wt, 'ToTime'));
          if (firstStart === null) firstStart = a;
          h += ((b.h * 60 + b.m) - (a.h * 60 + a.m)) / 60;
        }
        wd.push(pyMod(dtype - 2, 7));
        hours.push(pyOr(h, hpdDefault));
      }
    }
    if (wd.length) { cal.working_days = wd.slice().sort((a, b) => a - b); cal.hours_per_day = E.pyRound(maxByCount(hours), 2); }
    if (firstStart) cal.day_start = timeStr(firstStart);
    for (const ex of findall(c, 'Exceptions', 'Exception')) {
      const tp = find(ex, 'TimePeriod');
      const a = mdt(text(tp, 'FromDate')), b = mdt(text(tp, 'ToDate'));
      if (!a || !b) continue;
      const working = text(ex, 'DayWorking', '0') === '1';
      const h = working ? hoursOf(findall(ex, 'WorkingTimes', 'WorkingTime')) : 0;
      let d = a.slice(0, 10); const last = b.slice(0, 10);
      while (d <= last) { cal.exceptions[d] = h; d = nextDay(d); }
    }
    cals.set(uid, cal);
  }

  const defaultCal = text(root, 'CalendarUID') || (cals.size ? cals.keys().next().value : 'std');
  const project = mkProject({
    id: pySlice((text(root, 'Name') || 'PROJECT').replace(/[^A-Za-z0-9_-]+/g, '-'), 20) || 'PROJECT',
    name: text(root, 'Title') || text(root, 'Name') || 'Project',
    start: mdt(text(root, 'StartDate')) || nowAt8(),
    data_date: mdt(text(root, 'StatusDate')),
    default_calendar_id: defaultCal,
  });

  const uidToId = new Map(), stack = [], pending = [], ids = new Set();
  for (const t of findall(root, 'Tasks', 'Task')) {
    const uid = text(t, 'UID'), name = text(t, 'Name');
    const level = pyInt(text(t, 'OutlineLevel', '1') || '1');
    const summary = text(t, 'Summary', '0') === '1';
    if (uid === '0' || level === 0) { if (name) project.name = name; continue; }
    while (stack.length && stack[stack.length - 1][0] >= level) stack.pop();
    const parent = stack.length ? stack[stack.length - 1][1] : null;
    if (summary) {
      const wid = `W${uid}`;
      project.wbs.push(mkWbs(wid, name, parent, text(t, 'OutlineNumber') || null, pyInt(text(t, 'ID', '0') || '0')));
      stack.push([level, wid]);
      continue;
    }
    let aid = text(t, 'WBS') || `A${uid}`;
    if (ids.has(aid)) aid = `A${uid}`;
    uidToId.set(uid, aid);
    const pct = pyFloat(text(t, 'PercentComplete', '0') || '0');
    const actualStart = mdt(text(t, 'ActualStart')), actualFinish = mdt(text(t, 'ActualFinish'));
    const status = (actualFinish || pct >= 100) ? 'complete' : (actualStart || pct > 0) ? 'in_progress' : 'not_started';
    const milestone = text(t, 'Milestone', '0') === '1';
    const dur = parseDurationHours(text(t, 'Duration'));
    const rem = find(t, 'RemainingDuration') ? parseDurationHours(text(t, 'RemainingDuration')) : null;
    const calUid = text(t, 'CalendarUID');
    const baseline = find(t, 'Baseline');
    project.activities.push(mkActivity({
      id: aid, name, wbs_id: parent,
      calendar_id: (calUid && calUid !== '-1' && cals.has(calUid)) ? calUid : null,
      type: (milestone && dur === 0 && find(t, 'PredecessorLink')) ? 'finish_milestone' : (milestone && dur === 0) ? 'start_milestone' : 'task',
      duration_hours: dur,
      constraint: get(MSP_CSTR, text(t, 'ConstraintType', '0'), 'none'),
      constraint_date: mdt(text(t, 'ConstraintDate')),
      status, actual_start: actualStart, actual_finish: actualFinish,
      remaining_hours: status !== 'not_started' ? rem : null, percent_complete: pct,
      early_start: mdt(text(t, 'Start')), early_finish: mdt(text(t, 'Finish')),
      late_start: mdt(text(t, 'LateStart')), late_finish: mdt(text(t, 'LateFinish')),
      baseline_start: baseline ? mdt(text(baseline, 'Start')) : null,
      baseline_finish: baseline ? mdt(text(baseline, 'Finish')) : null,
      notes: text(t, 'Notes'),
    }));
    ids.add(aid);
    for (const link of findall(t, 'PredecessorLink')) pending.push([uid, link]);
  }
  for (const [succUid, link] of pending) {
    const predUid = text(link, 'PredecessorUID');
    if (uidToId.has(predUid) && uidToId.has(succUid)) {
      const lagRaw = pyFloat(text(link, 'LinkLag', '0') || '0');
      const rel = mkRel(uidToId.get(predUid), uidToId.get(succUid), get(MSP_LINK, text(link, 'Type', '1'), 'FS'), lagRaw / 600);
      if (MSP_ELAPSED_LAG.has(text(link, 'LagFormat', '7'))) rel.lag_calendar = '24h';   // elapsed lag runs on the 24-hour calendar
      project.relationships.push(rel);
    }
  }
  const resByUid = new Map();
  for (const r of findall(root, 'Resources', 'Resource')) {
    const uid = text(r, 'UID');
    if (uid === '0' && !text(r, 'Name')) continue;
    const rid = pySlice((text(r, 'Initials') || text(r, 'Name') || `R${uid}`).replace(RE_WS_RUN, '_'), 20);
    const res = mkResource(rid, text(r, 'Name') || rid, get(MSP_RES, text(r, 'Type', '1'), 'labour'), pyFloat(text(r, 'StandardRate', '0') || '0'));
    resByUid.set(uid, res);
    project.resources.push(res);
  }
  for (const x of findall(root, 'Assignments', 'Assignment')) {
    const tu = text(x, 'TaskUID'), ru = text(x, 'ResourceUID');
    if (uidToId.has(tu) && resByUid.has(ru)) {
      project.assignments.push(mkAssignment(uidToId.get(tu), resByUid.get(ru).id, parseDurationHours(text(x, 'Work')), pyFloat(text(x, 'Cost', '0') || '0')));
    }
  }
  return finishProject(project, cals);
}

Object.assign(E, { parseXml, readPmxml, readMspdi, xmlRootTag });
})(typeof window !== 'undefined' ? window : globalThis);

/* PlannerPDF: a self-contained, dependency-free vector PDF writer for Gantt programmes.

   Works in browsers and in node: no DOM, no libraries, no network. Loading the file sets
   globalThis.PlannerPDF = { render, layout, formatDate, encodeText, textWidth }.

   render(doc) -> Uint8Array   a PDF 1.4 file (uncompressed content streams, exact xref).
   layout(doc) -> object       the pagination plan render() will use (pages, rows per page, ...).

   ------------------------------------------------------------------------------------------
   Input `doc`
   ------------------------------------------------------------------------------------------
   {
     meta: {
       project_name, project_id, client, revision, prepared_by,
       title,            // e.g. "Construction programme"
       data_date,        // ISO
       forecast_finish,  // ISO
       deadline,         // ISO | null
       printed_at,       // ISO
       notes             // free text, wrapped into the title block
     },
     page: { size: 'A3'|'A4'|'A2'|'A1', orientation: 'landscape'|'portrait', margins_mm: 10 },
     columns: [{ title, width_mm, align: 'left'|'right'|'center', indent?: bool }],
               // table on the left of every page. Rows are indented by `depth` in the column
               // flagged `indent: true`, else in the widest left-aligned column.
     rows: [{
       kind: 'summary'|'task'|'milestone',
       depth,                         // indent level (0 = outermost)
       cells: [strings matching columns],
       start, finish,                 // ISO
       critical,                      // bool
       pct,                           // 0-100 progress
       baseline_start, baseline_finish, // ISO | null
       late_finish,                   // ISO | null (float line drawn from finish to here)
       label                          // bar text, or ''
     }],
     links: [{ from: rowIndex, to: rowIndex, type: 'FS'|'SS'|'FF'|'SF', critical: bool }],
     range: { t0: ISO, t1: ISO },     // the timescale shown (a date-only t1 is inclusive)
     annotations: [{ date: ISO, row: index|null, text }],  // callouts; row null = whole chart
     options: {
       show_links, show_float, show_baseline, show_progress_line,  // bool
       legend,                        // bool: legend in the title block
       rows_per_page,                 // number | null (null = fit to page height)
       fit_to_pages_wide,             // 1 = timescale fits page width; n = split across n pages
       colour,                        // true; false = greyscale palette for mono printers
       // optional extras (defaults shown):
       shade_weekends: true,          // grey Sat/Sun bands when a day is >= 2 mm wide
       row_height_mm: 5,              // preferred (maximum) row height
       work_hours: [8, 16]            // bar ends: times in this window map linearly onto the day
     },
     cover: null | {                  // optional briefing page, emitted before the Gantt pages
       title,                         // large heading, e.g. "Construction programme"
       subtitle,                      // line beneath it, e.g. "Two-storey house · Rev B · issued 9 Mar 2026"
       headline,                      // bold lead sentence (wrapped, at most three lines)
       paragraphs: [string],          // 2-6 paragraphs; two text columns on landscape when long
       kpis: [[label, value]],        // up to 6 tiles in a row under the headline ({label, value} also accepted)
       milestones: [{ name, date, baseline_date|null, variance_days|null, status }],
                                      // table Milestone | Date | Baseline | Var; the last two columns only
                                      // when some baseline_date is set; at most 18 rows then "and N more"
       watch: [{ name, text }],       // "Watch" list: up to 6 bullet lines, the name in bold
       footer                         // small line at the foot of the page
     }
   }

   Conventions
   - ISO datetimes are naive wall-clock values: the digits are parsed directly and all date
     arithmetic is done in UTC, so the local timezone never shifts a date.
   - Dates print in UK style ("7 Apr 26"); weeks commence Monday.
   - Bars: a time inside options.work_hours maps proportionally across its day, so an
     08:00 start sits at the start of the day and a 16:00 finish at the end of the day.
   - Pages are ordered row-band first, then horizontal sheet: with fit_to_pages_wide = 2,
     page 1 = rows 1..k early dates, page 2 = rows 1..k later dates, page 3 = next rows ...
   - Text uses the standard Helvetica / Helvetica-Bold fonts with WinAnsiEncoding; anything
     WinAnsi cannot represent prints as '?'.
   - A cover is one extra page (page 1 of N) on the same paper, with the same header band and
     title block as the Gantt pages. Its text is wrapped to the page; whatever will not fit is
     cut with an ellipsis rather than spilling off the sheet.
*/
(function (root) {
  'use strict';

  // ---------------------------------------------------------------------------------------
  // constants
  // ---------------------------------------------------------------------------------------
  const MM = 72 / 25.4;                       // points per millimetre
  const DAY = 86400000;
  const PAGE_SIZES = { A4: [210, 297], A3: [297, 420], A2: [420, 594], A1: [594, 841] };
  const GEOMETRY = {
    header_mm: 12,          // header band
    gap_mm: 2,              // gap above the timescale and above the title block
    tier_mm: 4.2,           // each of the three timescale tiers
    info_mm: 21,            // title block info strip
    legend_inline_min_mm: 330, // usable width at which the legend sits inside the info strip
    legend_item_mm: 34,     // legend item width when it runs as a strip above the info strip
    legend_line_mm: 3.6,
    row_mm: 5               // default row height
  };
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August',
    'September', 'October', 'November', 'December'];
  const DAY_LETTERS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];

  // Standard AFM advance widths (1/1000 em) for WinAnsi codes 32..255.
  const HELV = [278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584,350,556,350,222,556,333,1000,556,556,333,1000,667,333,1000,350,611,350,350,222,222,333,333,350,556,1000,333,1000,500,333,944,350,500,667,278,333,556,556,556,556,260,556,333,737,370,556,584,333,737,333,400,584,333,333,333,556,537,278,333,333,365,556,834,834,834,611,667,667,667,667,667,667,1000,722,667,667,667,667,278,278,278,278,722,722,778,778,778,778,778,584,778,722,722,722,722,667,667,611,556,556,556,556,556,556,889,500,556,556,556,556,278,278,278,278,556,556,556,556,556,556,556,584,611,556,556,556,556,500,556,500];
  const HELVB = [278,333,474,556,556,889,722,238,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,333,333,584,584,584,611,975,722,722,722,722,667,611,778,722,278,556,722,611,833,722,778,667,778,722,667,611,722,667,944,667,667,611,333,278,333,584,556,333,556,611,556,611,556,333,611,611,278,278,556,278,889,611,611,611,611,389,556,333,611,556,778,556,556,500,389,280,389,584,350,556,350,278,556,500,1000,556,556,333,1000,667,333,1000,350,611,350,350,278,278,500,500,350,556,1000,333,1000,556,333,944,350,500,667,278,333,556,556,556,556,280,556,333,737,370,556,584,333,737,333,400,584,333,333,333,611,556,278,333,333,365,556,834,834,834,611,722,722,722,722,722,722,1000,722,667,667,667,667,278,278,278,278,722,722,778,778,778,778,778,584,778,722,722,722,722,667,667,611,556,556,556,556,556,556,889,556,556,556,556,556,278,278,278,278,611,611,611,611,611,611,611,584,611,611,611,611,611,556,611,556];

  // Unicode -> WinAnsi (cp1252) for the 0x80-0x9F block; 0xA0-0xFF are Latin-1 identical.
  const CP1252 = { 0x20ac: 128, 0x201a: 130, 0x0192: 131, 0x201e: 132, 0x2026: 133, 0x2020: 134,
    0x2021: 135, 0x02c6: 136, 0x2030: 137, 0x0160: 138, 0x2039: 139, 0x0152: 140, 0x017d: 142,
    0x2018: 145, 0x2019: 146, 0x201c: 147, 0x201d: 148, 0x2022: 149, 0x2013: 150, 0x2014: 151,
    0x02dc: 152, 0x2122: 153, 0x0161: 154, 0x203a: 155, 0x0153: 156, 0x017e: 158, 0x0178: 159 };
  // Characters with an obvious WinAnsi stand-in.
  const APPROX = { 0x2010: 45, 0x2011: 45, 0x2012: 150, 0x2015: 151, 0x2212: 45, 0x2032: 39,
    0x2033: 34, 0x2007: 32, 0x2009: 32, 0x200a: 32, 0x202f: 32, 0x2002: 32, 0x2003: 32,
    0x2219: 183, 0x00ad: 45 };
  const ELLIPSIS = String.fromCharCode(133);

  // ---------------------------------------------------------------------------------------
  // text
  // ---------------------------------------------------------------------------------------
  /** Unicode string -> "byte string" of WinAnsi codes (each char 32..255). */
  function encodeText(s) {
    s = s == null ? '' : String(s);
    let out = '';
    for (const ch of s) {
      const u = ch.codePointAt(0);
      let c;
      if (u === 9 || u === 10 || u === 13) c = 32;
      else if (u >= 32 && u <= 126) c = u;
      else if (u >= 0xa0 && u <= 0xff) c = u === 0xad ? 45 : u;
      else if (CP1252[u] !== undefined) c = CP1252[u];
      else if (APPROX[u] !== undefined) c = APPROX[u];
      else if (u < 32) continue;
      else c = 63; // '?'
      out += String.fromCharCode(c);
    }
    return out;
  }

  /** Width in mm of an encoded string at `pt` points. */
  function widthEnc(enc, pt, bold) {
    const W = bold ? HELVB : HELV;
    let w = 0;
    for (let i = 0; i < enc.length; i++) { const c = enc.charCodeAt(i); w += c >= 32 ? W[c - 32] : 0; }
    return w / 1000 * pt / MM;
  }
  /** Width in mm of a Unicode string at `pt` points. */
  function textWidth(s, pt, bold) { return widthEnc(encodeText(s), pt, bold); }

  /** Truncate an encoded string with an ellipsis so it fits maxW mm ('' if not even that fits). */
  function fitEnc(enc, maxW, pt, bold) {
    if (widthEnc(enc, pt, bold) <= maxW) return enc;
    const W = bold ? HELVB : HELV;
    const ell = W[133 - 32] / 1000 * pt / MM;
    if (ell > maxW) return '';
    let w = ell, i = 0;
    for (; i < enc.length; i++) {
      const cw = W[enc.charCodeAt(i) - 32] / 1000 * pt / MM;
      if (w + cw > maxW) break;
      w += cw;
    }
    return enc.slice(0, i).replace(/ +$/, '') + ELLIPSIS;
  }

  /** Word-wrap an encoded string into at most maxLines lines of maxW mm. */
  function wrapEnc(enc, maxW, pt, bold, maxLines) {
    const words = enc.split(' ').filter(w => w.length);
    const lines = [];
    let cur = '';
    let i = 0;
    for (; i < words.length; i++) {
      const trial = cur ? cur + ' ' + words[i] : words[i];
      if (widthEnc(trial, pt, bold) <= maxW) { cur = trial; continue; }
      if (cur) { lines.push(cur); cur = ''; i--; if (lines.length === maxLines) break; continue; }
      lines.push(fitEnc(words[i], maxW, pt, bold)); // a single over-long word
      if (lines.length === maxLines) { i++; break; }
    }
    if (cur && lines.length < maxLines) { lines.push(cur); i = words.length; }
    if (i < words.length && lines.length) {
      const last = lines.length - 1;
      lines[last] = fitEnc(lines[last] + ' ' + words.slice(i).join(' '), maxW, pt, bold);
      if (!lines[last].endsWith(ELLIPSIS)) lines[last] = fitEnc(lines[last] + ELLIPSIS, maxW, pt, bold);
    }
    return lines;
  }

  /** PDF literal string body for an encoded string. */
  function pdfString(enc) {
    let out = '';
    for (let i = 0; i < enc.length; i++) {
      const c = enc.charCodeAt(i);
      if (c === 40 || c === 41 || c === 92) out += '\\' + enc[i];
      else if (c < 32 || c > 126) out += '\\' + c.toString(8).padStart(3, '0');
      else out += enc[i];
    }
    return out;
  }

  // ---------------------------------------------------------------------------------------
  // dates (naive wall-clock; all arithmetic in UTC)
  // ---------------------------------------------------------------------------------------
  const ISO_RE = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?/;
  /** -> { ms, dateOnly } or null */
  function parseISO(s) {
    if (s == null || s === '') return null;
    const m = ISO_RE.exec(String(s).trim());
    if (!m) return null;
    const ms = Date.UTC(+m[1], +m[2] - 1, +m[3], m[4] ? +m[4] : 0, m[5] ? +m[5] : 0, m[6] ? +m[6] : 0);
    return { ms, dateOnly: m[4] === undefined };
  }
  const msOf = s => { const p = parseISO(s); return p ? p.ms : null; };
  const dayNum = ms => Math.floor(ms / DAY);
  const mdow = dn => ((dn + 3) % 7 + 7) % 7;      // 0 = Monday (1970-01-01 was a Thursday)
  const mondayOf = dn => dn - mdow(dn);
  function ymd(dn) { const d = new Date(dn * DAY); return [d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()]; }
  const dnOf = (y, m, d) => Math.floor(Date.UTC(y, m, d) / DAY);

  /** UK short date "7 Apr 26" from an ISO string (or '' if unparseable). */
  function formatDate(s) {
    const p = typeof s === 'number' ? { ms: s } : parseISO(s);
    if (!p) return '';
    const [y, m, d] = ymd(dayNum(p.ms));
    return d + ' ' + MONTHS[m] + ' ' + String(y % 100).padStart(2, '0');
  }

  // ---------------------------------------------------------------------------------------
  // colour
  // ---------------------------------------------------------------------------------------
  const PALETTE_COLOUR = {
    crit: '#d93f3f', critProg: '#8e1f1f', critEdge: '#a32a2a',
    norm: '#4a78c8', normProg: '#1d3f80', normEdge: '#2f5597',
    summary: '#3a4350', baseline: '#aab3bf', baselineEdge: '#8a94a1', float: '#4b5563',
    link: '#4b5563', linkCrit: '#d93f3f', dd: '#8b5cf6', deadline: '#d93f3f',
    weekend: '#eff1f4', sumRow: '#f2f4f7', headFill: '#e7ebf0', gridMaj: '#c3cad3',
    gridMin: '#e4e8ed', rowLine: '#dfe3e9', frame: '#3a4350', text: '#111827', muted: '#5f6b7a',
    annFill: '#fff6cc', annStroke: '#b8930b', annText: '#3d3300', accent: '#1f2a37',
    msEdge: '#1f2937', white: '#ffffff', progLine: '#8b5cf6'
  };
  const PALETTE_MONO = Object.assign({}, PALETTE_COLOUR, {
    crit: '#333333', critProg: '#000000', critEdge: '#000000',
    norm: '#b3b3b3', normProg: '#5c5c5c', normEdge: '#4d4d4d',
    summary: '#262626', baseline: '#d0d0d0', baselineEdge: '#8c8c8c', float: '#404040',
    link: '#555555', linkCrit: '#111111', dd: '#3c3c3c', deadline: '#000000',
    weekend: '#f0f0f0', sumRow: '#f2f2f2', headFill: '#e8e8e8', gridMaj: '#c4c4c4',
    gridMin: '#e5e5e5', rowLine: '#e0e0e0', frame: '#333333', text: '#111111', muted: '#606060',
    annFill: '#f5f5f5', annStroke: '#555555', annText: '#111111', accent: '#222222',
    msEdge: '#000000', progLine: '#3c3c3c'
  });
  function rgb(hex) {
    const h = hex.replace('#', '');
    return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16) / 255);
  }

  // ---------------------------------------------------------------------------------------
  // content stream builder (coordinates in mm from the top-left corner)
  // ---------------------------------------------------------------------------------------
  const num = v => { const r = Math.round(v * 100) / 100; return Object.is(r, -0) ? '0' : String(r); };

  class Canvas {
    constructor(pageHmm) { this.H = pageHmm; this.o = []; this.st = { f: null, s: null, w: null, d: '' }; this.stack = []; }
    X(x) { return num(x * MM); }
    Y(y) { return num((this.H - y) * MM); }
    push(s) { this.o.push(s); }
    save() { this.push('q'); this.stack.push(Object.assign({}, this.st)); }
    restore() { this.push('Q'); this.st = this.stack.pop(); }
    fill(hex) { if (this.st.f !== hex) { this.st.f = hex; this.push(rgb(hex).map(num).join(' ') + ' rg'); } return this; }
    stroke(hex) { if (this.st.s !== hex) { this.st.s = hex; this.push(rgb(hex).map(num).join(' ') + ' RG'); } return this; }
    lw(mm) { if (this.st.w !== mm) { this.st.w = mm; this.push(num(mm * MM) + ' w'); } return this; }
    dash(arr) {
      const d = arr && arr.length ? '[' + arr.map(v => num(v * MM)).join(' ') + '] 0 d' : '[] 0 d';
      if (this.st.d !== d) { this.st.d = d; this.push(d); }
      return this;
    }
    rectPath(x, y, w, h) { this.push(`${this.X(x)} ${this.Y(y + h)} ${num(w * MM)} ${num(h * MM)} re`); }
    rect(x, y, w, h, fill, stroke, lw) {
      if (w <= 0 || h <= 0) return;
      if (fill) this.fill(fill);
      if (stroke) { this.stroke(stroke); this.lw(lw || 0.1); this.dash(null); }
      this.rectPath(x, y, w, h);
      this.push(fill && stroke ? 'B' : fill ? 'f' : 'S');
    }
    line(x1, y1, x2, y2, col, lw, dash) {
      this.stroke(col).lw(lw).dash(dash);
      this.push(`${this.X(x1)} ${this.Y(y1)} m ${this.X(x2)} ${this.Y(y2)} l S`);
    }
    polyline(pts, col, lw, dash) {
      if (pts.length < 2) return;
      this.stroke(col).lw(lw).dash(dash);
      this.push(pts.map((p, i) => `${this.X(p[0])} ${this.Y(p[1])} ${i ? 'l' : 'm'}`).join(' ') + ' S');
    }
    polygon(pts, fill, stroke, lw) {
      if (fill) this.fill(fill);
      if (stroke) { this.stroke(stroke); this.lw(lw || 0.1); this.dash(null); }
      this.push(pts.map((p, i) => `${this.X(p[0])} ${this.Y(p[1])} ${i ? 'l' : 'm'}`).join(' ') + ' h ' + (fill && stroke ? 'B' : fill ? 'f' : 'S'));
    }
    circle(cx, cy, r, fill, stroke, lw) {
      const k = 0.5523 * r, X = v => this.X(v), Y = v => this.Y(v);
      if (fill) this.fill(fill);
      if (stroke) { this.stroke(stroke); this.lw(lw || 0.1); this.dash(null); }
      this.push(`${X(cx + r)} ${Y(cy)} m ${X(cx + r)} ${Y(cy + k)} ${X(cx + k)} ${Y(cy + r)} ${X(cx)} ${Y(cy + r)} c ` +
        `${X(cx - k)} ${Y(cy + r)} ${X(cx - r)} ${Y(cy + k)} ${X(cx - r)} ${Y(cy)} c ` +
        `${X(cx - r)} ${Y(cy - k)} ${X(cx - k)} ${Y(cy - r)} ${X(cx)} ${Y(cy - r)} c ` +
        `${X(cx + k)} ${Y(cy - r)} ${X(cx + r)} ${Y(cy - k)} ${X(cx + r)} ${Y(cy)} c ` + (fill && stroke ? 'b' : fill ? 'f' : 's'));
    }
    clip(x, y, w, h) { this.rectPath(x, y, w, h); this.push('W n'); }
    /** Text at baseline (x, y) mm. `enc` is an encoded string. align: left|right|center. */
    textEnc(enc, x, y, pt, bold, col, align) {
      if (!enc) return;
      let tx = x;
      if (align === 'right') tx = x - widthEnc(enc, pt, bold);
      else if (align === 'center') tx = x - widthEnc(enc, pt, bold) / 2;
      this.fill(col);
      this.push(`BT /${bold ? 'F2' : 'F1'} ${num(pt)} Tf ${this.X(tx)} ${this.Y(y)} Td (${pdfString(enc)}) Tj ET`);
    }
    text(s, x, y, pt, bold, col, align, maxW) {
      let enc = encodeText(s);
      if (maxW !== undefined) enc = fitEnc(enc, maxW, pt, bold);
      this.textEnc(enc, x, y, pt, bold, col, align);
    }
    toString() { return this.o.join('\n') + '\n'; }
  }

  // ---------------------------------------------------------------------------------------
  // normalisation + layout
  // ---------------------------------------------------------------------------------------
  function normalise(doc) {
    doc = doc || {};
    const meta = Object.assign({ project_name: '', project_id: '', client: '', revision: '', prepared_by: '',
      title: 'Construction programme', data_date: null, forecast_finish: null, deadline: null,
      printed_at: null, notes: '' }, doc.meta || {});
    const page = Object.assign({ size: 'A3', orientation: 'landscape', margins_mm: 10 }, doc.page || {});
    if (!PAGE_SIZES[page.size]) page.size = 'A3';
    if (!(page.margins_mm >= 0)) page.margins_mm = 10;
    const options = Object.assign({ show_links: true, show_float: true, show_baseline: true,
      show_progress_line: false, legend: true, rows_per_page: null, fit_to_pages_wide: 1, colour: true,
      shade_weekends: true, row_height_mm: GEOMETRY.row_mm, work_hours: [8, 16] }, doc.options || {});
    const rows = (doc.rows || []).map(r => Object.assign({ kind: 'task', depth: 0, cells: [], critical: false, pct: 0, label: '' }, r));
    let columns = (doc.columns && doc.columns.length ? doc.columns : [{ title: 'Activity', width_mm: 70, align: 'left' }])
      .map(c => Object.assign({ title: '', width_mm: 20, align: 'left' }, c));
    // timescale range
    let r0 = doc.range && parseISO(doc.range.t0), r1 = doc.range && parseISO(doc.range.t1);
    if (!r0 || !r1) {
      let lo = Infinity, hi = -Infinity;
      for (const r of rows) for (const k of ['start', 'finish', 'baseline_start', 'baseline_finish', 'late_finish']) {
        const v = msOf(r[k]); if (v !== null) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
      }
      if (!isFinite(lo)) { lo = Date.UTC(2026, 0, 5); hi = lo + 28 * DAY; }
      if (!r0) r0 = { ms: (mondayOf(dayNum(lo)) - 7) * DAY, dateOnly: true };
      if (!r1) r1 = { ms: (dayNum(hi) + 14) * DAY, dateOnly: false };
    }
    let d0 = r0.ms / DAY, d1 = r1.ms / DAY + (r1.dateOnly ? 1 : 0);
    if (!(d1 > d0)) d1 = d0 + 7;
    return { meta, page, options, rows, columns, links: doc.links || [], annotations: doc.annotations || [], d0, d1,
      cover: normaliseCover(doc.cover) };
  }

  /** doc.cover -> a cover with every field present and trimmed, or null when there is no cover. */
  function normaliseCover(c) {
    if (!c) return null;
    if (typeof c !== 'object') c = {};
    const str = v => (v == null ? '' : String(v).trim());
    const list = v => (Array.isArray(v) ? v : []);
    const kpis = list(c.kpis).map(k => (Array.isArray(k) ? { label: str(k[0]), value: str(k[1]) }
      : k && typeof k === 'object' ? { label: str(k.label), value: str(k.value) } : null))
      .filter(k => k && (k.label || k.value)).slice(0, 6);
    const milestones = list(c.milestones).filter(m => m && typeof m === 'object').map(m => ({
      name: str(m.name), date: m.date == null ? '' : m.date,
      baseline_date: m.baseline_date == null || m.baseline_date === '' ? null : m.baseline_date,
      variance_days: m.variance_days == null || m.variance_days === '' || !isFinite(+m.variance_days) ? null : Math.round(+m.variance_days),
      status: str(m.status) })).filter(m => m.name || m.date);
    const watch = list(c.watch).map(w => (typeof w === 'string' ? { name: '', text: str(w) }
      : w && typeof w === 'object' ? { name: str(w.name), text: str(w.text) } : null))
      .filter(w => w && (w.name || w.text)).slice(0, 6);
    const paragraphs = (typeof c.paragraphs === 'string' ? [c.paragraphs] : list(c.paragraphs)).map(str).filter(Boolean);
    return { title: str(c.title), subtitle: str(c.subtitle), headline: str(c.headline), paragraphs, kpis, milestones, watch, footer: str(c.footer) };
  }

  const LEGEND_ITEMS = ['Critical activity', 'Non-critical activity', 'Progress', 'Summary', 'Milestone',
    'Baseline', 'Total float', 'Link (critical / other)', 'Data date', 'Deadline', 'Progress line'];

  function legendItems(n) {
    const o = n.options;
    return LEGEND_ITEMS.filter(k => !((k === 'Baseline' && !o.show_baseline) || (k === 'Total float' && !o.show_float) ||
      (k.startsWith('Link') && !o.show_links) || (k === 'Progress line' && !o.show_progress_line) ||
      (k === 'Deadline' && !parseISO(n.meta.deadline))));
  }

  function plan(n) {
    const G = GEOMETRY;
    const [a, b] = PAGE_SIZES[n.page.size];
    const land = n.page.orientation !== 'portrait';
    const W = land ? b : a, H = land ? a : b, m = n.page.margins_mm;
    const usableW = W - 2 * m;
    const legendOn = !!n.options.legend;
    const legendInline = legendOn && usableW >= G.legend_inline_min_mm;
    let legendStrip = 0, legendPerLine = 0;
    if (legendOn && !legendInline) {
      legendPerLine = Math.max(1, Math.floor(usableW / G.legend_item_mm));
      legendStrip = 1.6 + Math.ceil(legendItems(n).length / legendPerLine) * G.legend_line_mm;
    }
    const tbH = G.info_mm + legendStrip;
    const headerY = m, tsY = m + G.header_mm + G.gap_mm, tsH = 3 * G.tier_mm, bodyY = tsY + tsH;
    const tbY = H - m - tbH;
    const bodyH = tbY - G.gap_mm - bodyY;
    const base = n.options.row_height_mm > 0 ? n.options.row_height_mm : G.row_mm;
    let rpp, rowH;
    const req = Math.floor(+n.options.rows_per_page || 0);
    if (req > 0) { rpp = req; rowH = Math.min(base, bodyH / rpp); }
    else { rowH = base; rpp = Math.max(1, Math.floor(bodyH / rowH + 1e-9)); }
    const pagesTall = Math.max(1, Math.ceil(n.rows.length / rpp));
    // columns: the table may take at most 50% of the width (60% on wide sheets). Shrink the
    // indented (name) column first, down to 32 mm, then scale every column.
    const widths = n.columns.map(c => Math.max(0, +c.width_mm || 0));
    let indentCol = n.columns.findIndex(c => c.indent);
    if (indentCol < 0) {
      let best = -1;
      n.columns.forEach((c, i) => { if ((c.align || 'left') === 'left' && (best < 0 || widths[i] > widths[best])) best = i; });
      indentCol = best < 0 ? 0 : best;
    }
    const maxT = usableW * (usableW >= 330 ? 0.6 : 0.5);
    let tableW = widths.reduce((s, w) => s + w, 0);
    if (tableW > maxT) {
      const cut = Math.min(tableW - maxT, Math.max(0, widths[indentCol] - 32));
      widths[indentCol] -= cut; tableW -= cut;
    }
    if (tableW > maxT) { const k = maxT / tableW; for (let i = 0; i < widths.length; i++) widths[i] *= k; tableW = maxT; }
    const cols = [];
    let x = m;
    n.columns.forEach((c, i) => { cols.push(Object.assign({}, c, { x, w: widths[i] })); x += widths[i]; });
    const chartX = m + tableW, chartW = usableW - tableW;
    // horizontal sheets: equal scale, whole weeks per sheet
    const wide = Math.max(1, Math.floor(+n.options.fit_to_pages_wide || 1));
    const slices = [];
    if (wide === 1) slices.push([n.d0, n.d1]);
    else {
      const s0 = mondayOf(Math.floor(n.d0));
      const weeks = Math.max(1, Math.ceil((n.d1 - s0) / 7 / wide));
      for (let i = 0; i < wide; i++) slices.push([s0 + i * weeks * 7, s0 + (i + 1) * weeks * 7]);
    }
    const coverPages = n.cover ? 1 : 0;
    return { W, H, m, usableW, headerY, tsY, tsH, bodyY, bodyH, tbY, tbH, legendInline, legendStrip, legendPerLine,
      rowH, rpp, pagesTall, wide, slices, cols, tableW, indentCol, chartX, chartW, coverPages, pageCount: pagesTall * wide + coverPages };
  }

  /** Public pagination plan. */
  function layout(doc) {
    const n = normalise(doc), p = plan(n);
    const iso = d => { const ms = Math.round(d * DAY); return new Date(ms).toISOString().slice(0, 19); };
    return { page_w_mm: p.W, page_h_mm: p.H, rows_per_page: p.rpp, row_height_mm: p.rowH, body_height_mm: p.bodyH,
      pages_tall: p.pagesTall, pages_wide: p.wide, page_count: p.pageCount, pages: p.pageCount,
      cover: !!n.cover, cover_pages: p.coverPages,
      table_width_mm: p.tableW, chart_width_mm: p.chartW, title_block_mm: p.tbH,
      slices: p.slices.map(([a, b]) => ({ t0: iso(a), t1: iso(b) })) };
  }

  // ---------------------------------------------------------------------------------------
  // page drawing
  // ---------------------------------------------------------------------------------------
  function drawPage(cv, n, P, g, c, pageNo) {
    const C = n.options.colour === false ? PALETTE_MONO : PALETTE_COLOUR;
    const [s0, s1] = P.slices[c];
    const dw = P.chartW / (s1 - s0);                   // mm per day
    const X = d => P.chartX + (d - s0) * dw;
    const wh = n.options.work_hours || [8, 16];
    const ws = +wh[0], we = +wh[1] > +wh[0] ? +wh[1] : +wh[0] + 8;
    const disp = ms => {                               // ms -> display day number
      const dn = dayNum(ms), h = (ms - dn * DAY) / 3600000;
      return dn + (h <= ws ? 0 : h >= we ? 1 : (h - ws) / (we - ws));
    };
    const dispIso = s => { const v = msOf(s); return v === null ? null : disp(v); };
    const rowH = P.rowH;
    const first = g * P.rpp, last = Math.min(n.rows.length, first + P.rpp); // [first, last)
    const rowTop = i => P.bodyY + (i - first) * rowH;
    const fontPt = Math.min(7, rowH * MM * 0.5);
    const bodyBottom = P.bodyY + P.bodyH;
    const chartR = P.chartX + P.chartW;
    const tableL = P.m;

    // ---------- header band ----------
    drawHeader(cv, n, P, C, P.wide > 1 ? `Sheet ${c + 1} of ${P.wide} across  •  ${formatDate(s0 * DAY)} to ${formatDate((s1 - 1) * DAY)}` : null);

    // ---------- backgrounds: header fills, summary rows, weekends ----------
    cv.rect(tableL, P.tsY, P.usableW, P.tsH, C.headFill);
    for (let i = first; i < last; i++) if (n.rows[i].kind === 'summary') cv.rect(tableL, rowTop(i), P.usableW, rowH, C.sumRow);
    cv.save();
    cv.clip(P.chartX, P.tsY, P.chartW, bodyBottom - P.tsY);
    if (n.options.shade_weekends !== false && dw >= 2) {
      for (let d = Math.floor(s0); d < s1; d++) if (mdow(d) === 5) cv.rect(X(d), P.bodyY, 2 * dw, P.bodyH, C.weekend);
    }

    // ---------- timescale ----------
    const tiers = timescaleTiers(s0, s1, dw, n.d0);
    const tierH = GEOMETRY.tier_mm;
    tiers.forEach((tier, ti) => {
      const ty = P.tsY + ti * tierH;
      const pt = ti === 0 ? 6.5 : 6, bold = ti === 0;
      for (const cell of tier.cells) {
        const xa = Math.max(X(cell.a), P.chartX), xb = Math.min(X(cell.b), chartR);
        if (xb <= xa) continue;
        if (cell.a > s0) cv.line(X(cell.a), ty, X(cell.a), ty + tierH, C.gridMaj, 0.12);
        const room = xb - xa - 0.8;
        const lab = cell.labels.map(encodeText).find(e => widthEnc(e, pt, bold) <= room);
        if (lab) cv.textEnc(lab, (xa + xb) / 2, ty + tierH / 2 + 0.72 * pt / MM / 2, pt, bold, C.text, 'center');
      }
      if (ti) cv.line(P.chartX, ty, chartR, ty, C.gridMaj, 0.12);
    });
    // chart grid: week lines (light) and the top tier's boundaries (darker)
    const weekW = 7 * dw;
    if (weekW >= 2.5) { for (let d = mondayOf(Math.ceil(s0)); d < s1; d += 7) if (d > s0) cv.line(X(d), P.bodyY, X(d), bodyBottom, C.gridMin, 0.1); }
    else for (const cell of tiers[2].cells) if (cell.a > s0) cv.line(X(cell.a), P.bodyY, X(cell.a), bodyBottom, C.gridMin, 0.1);
    for (const cell of tiers[0].cells) if (cell.a > s0) cv.line(X(cell.a), P.bodyY, X(cell.a), bodyBottom, C.gridMaj, 0.15);
    cv.restore();

    // ---------- row separators + table ----------
    for (let i = first; i <= last; i++) {
      if (i === first) continue;
      const y = rowTop(i);
      cv.line(tableL, y, chartR, y, C.rowLine, 0.1);
    }
    // column header text (bottom aligned, up to two lines)
    P.cols.forEach((col, ci) => {
      if (ci > 0) cv.line(col.x, P.tsY, col.x, bodyBottom, C.gridMaj, 0.12);
      const pt = 6.5;
      const lines = wrapEnc(encodeText(col.title), col.w - 2, pt, true, 2);
      const lineH = pt / MM * 1.2;
      let y = P.bodyY - 1.4 - (lines.length - 1) * lineH;
      for (const l of lines) {
        const ax = col.align === 'right' ? col.x + col.w - 1 : col.align === 'center' ? col.x + col.w / 2 : col.x + 1;
        cv.textEnc(l, ax, y, pt, true, C.text, col.align || 'left');
        y += lineH;
      }
    });
    for (let i = first; i < last; i++) {
      const r = n.rows[i];
      const bold = r.kind === 'summary';
      const y = rowTop(i) + rowH / 2 + 0.718 * fontPt / MM / 2;
      P.cols.forEach((col, ci) => {
        const indent = ci === P.indentCol ? Math.max(0, +r.depth || 0) * 2.6 : 0;
        const avail = col.w - 2 - indent;
        if (avail <= 0) return;
        const enc = fitEnc(encodeText(r.cells[ci] == null ? '' : r.cells[ci]), avail, fontPt, bold);
        const al = col.align || 'left';
        const ax = al === 'right' ? col.x + col.w - 1 : al === 'center' ? col.x + indent + 1 + avail / 2 : col.x + 1 + indent;
        cv.textEnc(enc, ax, y, fontPt, bold, r.kind === 'summary' ? C.text : C.text, al);
      });
    }

    // ---------- chart contents (clipped) ----------
    cv.save();
    cv.clip(P.chartX, P.bodyY, P.chartW, P.bodyH);
    const anyBaseline = n.options.show_baseline && n.rows.some(r => r.baseline_start && r.baseline_finish);
    const barH = rowH * 0.5;
    const barTopOff = anyBaseline ? rowH * 0.15 : (rowH - barH) / 2;
    const blTopOff = barTopOff + barH + rowH * 0.07, blH = rowH * 0.15;
    const msHalf = Math.min(rowH * 0.34, 1.9);
    const lo = Math.max(0, first - 0), hi = last;
    // geometry for every row referenced on this page (links may reach off-page rows)
    const geo = new Map();
    const geom = i => {
      if (geo.has(i)) return geo.get(i);
      const r = n.rows[i];
      if (!r) return null;
      const s = dispIso(r.start), f = dispIso(r.finish);
      if (s === null && f === null) { geo.set(i, null); return null; }
      const top = rowTop(i);
      const ms = r.kind === 'milestone';
      const xs = X(s !== null ? s : f), xe = Math.max(X(f !== null ? f : s), xs + (ms ? 0 : 0.4));
      const bt = top + (r.kind === 'summary' ? rowH * 0.28 : barTopOff);
      const bh = r.kind === 'summary' ? rowH * 0.2 : barH;
      const yMid = ms ? top + barTopOff + barH / 2 : bt + bh / 2;
      const o = ms
        ? { ms, x: xs, xs: xs - msHalf, xe: xs + msHalf, yMid, top: yMid - msHalf, bottom: yMid + msHalf, rowTop: top }
        : { ms, x: xs, xs, xe, yMid, top: bt, bottom: bt + bh + (r.kind === 'summary' ? rowH * 0.22 : 0), rowTop: top };
      geo.set(i, o);
      return o;
    };

    // baselines
    if (anyBaseline) for (let i = lo; i < hi; i++) {
      const r = n.rows[i];
      const bs = dispIso(r.baseline_start), bf = dispIso(r.baseline_finish);
      if (bs === null || bf === null) continue;
      const top = rowTop(i) + blTopOff;
      if (r.kind === 'milestone') {
        const x = X(bs), h = blH * 1.4;
        cv.polygon([[x, top - h * 0.2], [x + h * 0.6, top + blH / 2], [x, top + blH + h * 0.2], [x - h * 0.6, top + blH / 2]], C.baseline, C.baselineEdge, 0.08);
      } else cv.rect(X(bs), top, Math.max(0.3, X(bf) - X(bs)), blH, C.baseline, C.baselineEdge, 0.08);
    }
    // float lines
    if (n.options.show_float) for (let i = lo; i < hi; i++) {
      const r = n.rows[i];
      if (r.kind === 'summary') continue;
      const lf = dispIso(r.late_finish), gm = geom(i);
      if (lf === null || !gm) continue;
      const x0 = r.kind === 'milestone' ? gm.x : gm.xe, x1 = X(lf);
      if (x1 - x0 < 0.3) continue;
      const y = anyBaseline ? rowTop(i) + blTopOff + blH / 2 : rowTop(i) + barTopOff + barH + rowH * 0.08;
      cv.line(x0, y, x1, y, C.float, 0.18);
      cv.line(x1, y - rowH * 0.1, x1, y + rowH * 0.1, C.float, 0.18);
    }
    // bars (each also becomes an obstacle the annotation callouts try to avoid)
    const obstacles = [];
    for (let i = lo; i < hi; i++) {
      const r = n.rows[i], gm = geom(i);
      if (!gm) continue;
      const crit = !!r.critical;
      obstacles.push({ x: gm.xs, y: rowTop(i), w: gm.xe - gm.xs, h: rowH });
      if (r.kind === 'summary') {
        const t = gm.top, h = rowH * 0.2, tri = rowH * 0.22, w = Math.max(gm.xe - gm.xs, 0.4);
        cv.rect(gm.xs, t, w, h, C.summary);
        const tw = Math.min(tri, w / 2);
        cv.polygon([[gm.xs, t + h], [gm.xs + tw, t + h], [gm.xs, t + h + tri]], C.summary);
        cv.polygon([[gm.xe, t + h], [gm.xe - tw, t + h], [gm.xe, t + h + tri]], C.summary);
      } else if (r.kind === 'milestone') {
        const x = gm.x, y = gm.yMid, hh = msHalf;
        const done = (+r.pct || 0) >= 100;
        cv.polygon([[x, y - hh], [x + hh, y], [x, y + hh], [x - hh, y]],
          done ? (crit ? C.critProg : C.normProg) : (crit ? C.crit : C.norm), C.msEdge, 0.12);
      } else {
        const w = gm.xe - gm.xs;
        cv.rect(gm.xs, gm.top, w, barH, crit ? C.crit : C.norm, crit ? C.critEdge : C.normEdge, 0.1);
        const pct = Math.max(0, Math.min(100, +r.pct || 0));
        if (pct > 0) {
          cv.rect(gm.xs, gm.top, w * pct / 100, barH, crit ? C.critProg : C.normProg);
          cv.rect(gm.xs, gm.top, w, barH, null, crit ? C.critEdge : C.normEdge, 0.1);
        }
      }
    }
    // links
    if (n.options.show_links) {
      for (const L of n.links) {
        const fi = +L.from, ti = +L.to;
        if (!(fi >= 0 && ti >= 0) || fi === ti || fi >= n.rows.length || ti >= n.rows.length) continue;
        // only draw when at least one end is on this page (or the link passes through it)
        const aOn = fi >= first && fi < last, bOn = ti >= first && ti < last;
        if (!aOn && !bOn) continue;
        const a = geom(fi), b = geom(ti);
        if (!a || !b) continue;
        const type = (L.type || 'FS').toUpperCase();
        if (aOn && bOn) drawLink(cv, a, b, type, !!L.critical, rowH, C);
        else drawLinkStub(cv, aOn ? a : b, aOn, ti > fi, type, !!L.critical, rowH, C);
      }
    }
    // bar labels
    const labPt = fontPt * 0.92;
    for (let i = lo; i < hi; i++) {
      const r = n.rows[i], gm = geom(i);
      if (!gm || !r.label) continue;
      const enc = encodeText(r.label);
      const w = widthEnc(enc, labPt, r.kind === 'summary');
      const y = (r.kind === 'summary' ? rowTop(i) + rowH * 0.5 : gm.yMid) + 0.718 * labPt / MM / 2 + (r.kind === 'summary' ? rowH * 0.06 : 0);
      let xr = (r.kind === 'milestone' ? gm.x + msHalf : gm.xe) + 1.5;  // clear of a link drop at +0.8
      if (xr < P.chartX + 0.5) continue;               // bar ends on an earlier sheet
      const bold = r.kind === 'summary';
      if (xr + w <= chartR - 0.5) { cv.textEnc(enc, xr, y, labPt, bold, C.text); obstacles.push({ x: xr, y: rowTop(i), w, h: rowH }); }
      else {
        const xl = (r.kind === 'milestone' ? gm.x - msHalf : gm.xs) - 1.0;
        if (xl - w >= P.chartX + 0.5) { cv.textEnc(enc, xl, y, labPt, bold, C.text, 'right'); obstacles.push({ x: xl - w, y: rowTop(i), w, h: rowH }); }
        else if (chartR - 0.5 - xr > 6) cv.textEnc(fitEnc(enc, chartR - 0.5 - xr, labPt, bold), xr, y, labPt, bold, C.text);
      }
    }
    // progress line
    const ddRaw = msOf(n.meta.data_date);
    const dd = ddRaw === null ? null : disp(ddRaw);
    if (n.options.show_progress_line && dd !== null) {
      const xd = X(dd);
      const pts = [[xd, P.bodyY]];
      for (let i = lo; i < hi; i++) {
        const r = n.rows[i];
        if (r.kind === 'summary') continue;
        const s = dispIso(r.start), f = dispIso(r.finish);
        if (s === null || f === null) continue;
        const pct = Math.max(0, Math.min(100, +r.pct || 0));
        let x = xd;
        if (pct < 100 && !(pct === 0 && s >= dd)) x = X(s + (f - s) * pct / 100);
        if (Math.abs(x - xd) < 0.05) continue;
        const t = rowTop(i);
        pts.push([xd, t + rowH * 0.1], [x, t + rowH / 2], [xd, t + rowH * 0.9]);
      }
      pts.push([xd, P.bodyY + (last - first) * rowH]);
      cv.polyline(pts, C.progLine, 0.3);
    }
    // data date + deadline
    if (dd !== null && dd >= s0 && dd <= s1) cv.line(X(dd), P.bodyY, X(dd), bodyBottom, C.dd, 0.35, [1.6, 1.0]);
    const dlP = parseISO(n.meta.deadline);
    let dlX = null;
    if (dlP) {
      const dl = dlP.dateOnly ? dayNum(dlP.ms) + 1 : disp(dlP.ms);
      if (dl >= s0 && dl <= s1) { dlX = X(dl); cv.line(dlX, P.bodyY, dlX, bodyBottom, C.deadline, 0.35, [2.4, 0.8, 0.5, 0.8]); }
    }
    // annotations
    drawAnnotations(cv, n, P, { first, last, rowTop, X, disp, s0, s1, chartR, rowH, C, obstacles });
    cv.restore();

    // markers on the timescale edge (outside the chart clip so they sit on the boundary)
    if (dd !== null && dd >= s0 && dd <= s1) {
      const x = X(dd);
      cv.polygon([[x - 1.1, P.bodyY - 1.6], [x + 1.1, P.bodyY - 1.6], [x, P.bodyY]], C.dd);
    }
    if (dlX !== null) cv.polygon([[dlX - 1.1, P.bodyY - 1.6], [dlX + 1.1, P.bodyY - 1.6], [dlX, P.bodyY]], C.deadline);

    // ---------- frames ----------
    cv.rect(tableL, P.tsY, P.usableW, bodyBottom - P.tsY, null, C.frame, 0.3);
    cv.line(tableL, P.bodyY, chartR, P.bodyY, C.frame, 0.25);
    cv.line(P.chartX, P.tsY, P.chartX, bodyBottom, C.frame, 0.3);

    // ---------- title block ----------
    drawTitleBlock(cv, n, P, pageNo, g, c, C);
  }

  /** The header band every page carries: accent rule, project name, title, revision and data
      date; `subline` is an optional small right-aligned second line. */
  function drawHeader(cv, n, P, C, subline) {
    const x0 = P.m, y = P.headerY, H = GEOMETRY.header_mm;
    cv.rect(x0, y, P.usableW, 1.1, C.accent);
    const nameEnc = encodeText(n.meta.project_name || 'Untitled project');
    const right = [];
    if (n.meta.revision) right.push('Revision ' + n.meta.revision);
    if (n.meta.data_date) right.push('Data date ' + formatDate(n.meta.data_date));
    const rightTxt = right.join('    ');
    const rightW = textWidth(rightTxt, 8, false);
    cv.textEnc(fitEnc(nameEnc, P.usableW - rightW - 8, 12.5, true), x0, y + 6.6, 12.5, true, C.text);
    cv.text(n.meta.title || '', x0, y + 10.6, 8.5, false, C.muted, 'left', P.usableW - rightW - 8);
    cv.text(rightTxt, x0 + P.usableW, y + 6.6, 8, false, C.text, 'right');
    if (subline) cv.text(subline, x0 + P.usableW, y + 10.6, 7, false, C.muted, 'right');
    cv.line(x0, y + H, x0 + P.usableW, y + H, C.frame, 0.25);
  }

  function timescaleTiers(s0, s1, dw, origin) {
    const a0 = Math.floor(s0), a1 = Math.ceil(s1);
    const months = [], years = [], quarters = [], weeks = [], days = [];
    let [y, m] = ymd(a0);
    for (let d = dnOf(y, m, 1); d < a1;) {
      const [yy, mm] = ymd(d);
      const nx = dnOf(yy, mm + 1, 1);
      months.push({ a: d, b: nx, labels: [MONTHS_LONG[mm] + ' ' + yy, MONTHS[mm] + ' ' + String(yy % 100).padStart(2, '0'), MONTHS[mm], MONTHS[mm][0]] });
      d = nx;
    }
    for (let d = dnOf(ymd(a0)[0], 0, 1); d < a1;) {
      const yy = ymd(d)[0], nx = dnOf(yy + 1, 0, 1);
      years.push({ a: d, b: nx, labels: [String(yy), "'" + String(yy % 100).padStart(2, '0')] });
      d = nx;
    }
    {
      const [yy, mm] = ymd(a0);
      for (let d = dnOf(yy, mm - (mm % 3), 1); d < a1;) {
        const [qy, qm] = ymd(d), nx = dnOf(qy, qm + 3, 1);
        quarters.push({ a: d, b: nx, labels: ['Q' + (qm / 3 + 1)] });
        d = nx;
      }
    }
    const wk0 = mondayOf(Math.floor(origin));
    for (let d = mondayOf(a0); d < a1; d += 7) {
      const [, mm, dd] = ymd(d);
      const no = Math.floor((d - wk0) / 7) + 1;
      weeks.push({ a: d, b: d + 7, labels: ['w/c ' + dd + ' ' + MONTHS[mm], dd + ' ' + MONTHS[mm], String(dd)], no });
    }
    if (dw >= 2) for (let d = a0; d < a1; d++) days.push({ a: d, b: d + 1, labels: [String(ymd(d)[2]), DAY_LETTERS[mdow(d)]] });
    const weekNos = weeks.map(w => ({ a: w.a, b: w.b, labels: ['Week ' + w.no, 'Wk ' + w.no, String(w.no)] }));
    if (dw >= 2) return [{ cells: months }, { cells: weeks }, { cells: days }];
    if (dw >= 0.5) return [{ cells: months }, { cells: weeks.map(w => ({ a: w.a, b: w.b, labels: w.labels.slice(1) })) }, { cells: weekNos }];
    return [{ cells: years }, { cells: quarters }, { cells: months.map(c => ({ a: c.a, b: c.b, labels: c.labels.slice(2) })) }];
  }

  function arrowHead(cv, x, y, dir, col, size) {
    const L = size, Wd = size * 0.42;
    const pts = dir === 'down' ? [[x, y], [x - Wd, y - L], [x + Wd, y - L]]
      : dir === 'up' ? [[x, y], [x - Wd, y + L], [x + Wd, y + L]]
        : dir === 'right' ? [[x, y], [x - L, y - Wd], [x - L, y + Wd]]
          : [[x, y], [x + L, y - Wd], [x + L, y + Wd]];
    cv.polygon(pts, col);
  }

  function drawLink(cv, a, b, type, crit, rowH, C) {
    const col = crit ? C.linkCrit : C.link, lw = crit ? 0.22 : 0.16, ah = Math.min(1.1, rowH * 0.24);
    const down = b.yMid > a.yMid;
    const edgeY = o => (down ? o.top : o.bottom);           // where a vertical arrow enters `b`
    const gapY = down ? b.rowTop : b.rowTop + rowH;          // row boundary next to `b`, on a's side
    const pts = [];
    let dir;
    const sRoute = (px, py, out, tx, entryDir) => {          // out: +1 leave rightwards, -1 leftwards
      const ox = px + out * 1.2, ix = entryDir === 'right' ? tx - 1.2 : tx + 1.2;
      pts.push([px, py], [ox, py], [ox, gapY], [ix, gapY], [ix, b.yMid], [tx, b.yMid]);
      dir = entryDir;
    };
    if (type === 'SS') {
      const px = a.ms ? a.x - (a.xe - a.x) : a.xs, tx = b.ms ? b.xs : b.xs;
      const lx = Math.min(px, tx) - 1.4;
      pts.push([px, a.yMid], [lx, a.yMid], [lx, b.yMid], [tx, b.yMid]); dir = 'right';
    } else if (type === 'FF') {
      const px = a.xe, tx = b.xe;
      const rx = Math.max(px, tx) + 1.4;
      pts.push([px, a.yMid], [rx, a.yMid], [rx, b.yMid], [tx, b.yMid]); dir = 'left';
    } else if (type === 'SF') {
      sRoute(a.xs, a.yMid, -1, b.xe, 'left');
    } else { // FS
      const px = a.xe, py = a.yMid;
      const entryMin = b.ms ? b.x : b.xs + 0.8;
      const dx = Math.max(px + 0.8, entryMin);
      const tx = b.ms ? b.xs : b.xs;                  // left edge / left tip of the successor
      if (tx >= px + 2.0) {
        // successor starts clearly later: drop just after the predecessor (left of its bar
        // label), then run along the successor's row into its start
        pts.push([px, py], [px + 0.8, py], [px + 0.8, b.yMid], [tx, b.yMid]); dir = 'right';
      } else if (b.ms ? Math.abs(dx - b.x) < 0.01 : dx <= b.xe - 0.3) {
        pts.push([px, py], [dx, py], [dx, edgeY(b)]); dir = down ? 'down' : 'up';
      } else if (!a.ms && b.ms && Math.abs(b.x - a.xe) < 0.8 && b.x >= a.xs) {
        pts.push([b.x, down ? a.bottom : a.top], [b.x, edgeY(b)]); dir = down ? 'down' : 'up';
      } else if (a.ms && !b.ms && b.xs <= a.x + 0.3 && b.xe > a.x + 0.5) {
        pts.push([a.x, down ? a.bottom : a.top], [a.x, edgeY(b)]); dir = down ? 'down' : 'up';
      } else sRoute(px, py, 1, b.ms ? b.xs : b.xs, 'right');
    }
    // shorten the last segment by the arrowhead so the line does not poke through its tip
    const [ex, ey] = pts[pts.length - 1];
    const line = pts.slice(0, -1);
    const back = { down: [0, -ah], up: [0, ah], right: [-ah, 0], left: [ah, 0] }[dir];
    line.push([ex + back[0] * 0.8, ey + back[1] * 0.8]);
    cv.polyline(line, col, lw);
    arrowHead(cv, ex, ey, dir, col, ah);
  }

  /** A link whose other end is on another page: a short lead-out (or lead-in) ending in a
      small open circle, rather than a line running off the page edge. */
  function drawLinkStub(cv, o, isFrom, down, type, crit, rowH, C) {
    const col = crit ? C.linkCrit : C.link, lw = crit ? 0.22 : 0.16, ah = Math.min(1.1, rowH * 0.24);
    const len = rowH * 0.6, r = Math.min(0.45, rowH * 0.1);
    if (isFrom) {                                   // successor is off-page
      const fromStart = type === 'SS' || type === 'SF';
      const px = fromStart ? o.xs : o.xe, out = fromStart ? -1.2 : 1.2;
      const vy = down ? o.yMid + len : o.yMid - len;
      cv.polyline([[px, o.yMid], [px + out, o.yMid], [px + out, vy + (down ? -r : r)]], col, lw);
      cv.circle(px + out, vy, r, null, col, lw);
    } else {                                        // predecessor is off-page
      const toStart = type === 'FS' || type === 'SS';
      const ex = o.ms ? o.x : toStart ? Math.min(o.xs + 0.8, (o.xs + o.xe) / 2) : Math.max(o.xe - 0.8, (o.xs + o.xe) / 2);
      // `down` = the link runs downwards, i.e. the predecessor is above this row
      const ey = down ? o.top : o.bottom, sy = down ? ey - len : ey + len;
      cv.polyline([[ex, sy + (down ? r : -r)], [ex, ey + (down ? -ah * 0.8 : ah * 0.8)]], col, lw);
      cv.circle(ex, sy, r, null, col, lw);
      arrowHead(cv, ex, ey, down ? 'down' : 'up', col, ah);
    }
  }

  function drawAnnotations(cv, n, P, ctx) {
    const { first, last, rowTop, X, disp, s0, s1, chartR, rowH, C, obstacles } = ctx;
    const pt = 6, lineH = pt / MM * 1.22, pad = 0.9;
    const placed = [];
    for (const an of n.annotations) {
      const p = parseISO(an.date);
      if (!p || !an.text) continue;
      const d = disp(p.ms);
      if (d < s0 || d > s1) continue;
      const whole = an.row === null || an.row === undefined || an.row === '';
      const ri = +an.row;
      if (!whole && !(ri >= first && ri < last)) continue;
      const ax = X(d);
      const lines = wrapEnc(encodeText(an.text), Math.min(52, Math.max(25, P.chartW * 0.4)), pt, false, 3);
      const w = Math.max(...lines.map(l => widthEnc(l, pt, false))) + 2 * pad;
      const h = lines.length * lineH + 2 * pad - 0.3;
      // candidate positions, best first; take the first inside the chart that is clear of
      // bars, bar labels and earlier callouts (else the first that fits on the chart)
      const cands = [];
      let ay;
      if (whole) {
        ay = P.bodyY;
        cv.line(ax, P.bodyY, ax, P.bodyY + P.bodyH, C.annStroke, 0.18, [0.5, 0.7]);
        for (let k = 0; k < 12; k++) {
          const y = P.bodyY + 0.8 + k * rowH;
          cands.push({ x: ax + 1.2, y, w, h }, { x: ax - 1.2 - w, y, w, h });
        }
      } else {
        const t = rowTop(ri);
        ay = t + rowH / 2;
        for (let k = 0; k < 6; k++) {
          const up = t - h - 0.8 - k * rowH, dn = t + rowH + 0.8 + k * rowH;
          for (const dx of [3.5, 3.5 + 6 * k]) {
            cands.push({ x: ax + dx, y: up, w, h }, { x: ax + dx, y: dn, w, h }, { x: ax - dx - w, y: up, w, h }, { x: ax - dx - w, y: dn, w, h });
          }
        }
      }
      const inside = b => b.x >= P.chartX + 0.5 && b.x + b.w <= chartR - 0.5 && b.y >= P.bodyY + 0.5 && b.y + b.h <= P.bodyY + P.bodyH - 0.5;
      const hit = (b, list) => list.some(o => !(b.x + b.w < o.x || o.x + o.w < b.x || b.y + b.h < o.y || o.y + o.h < b.y));
      const area = (b, list) => list.reduce((s, o) => s + Math.max(0, Math.min(b.x + b.w, o.x + o.w) - Math.max(b.x, o.x)) *
        Math.max(0, Math.min(b.y + b.h, o.y + o.h) - Math.max(b.y, o.y)), 0);
      let box = cands.find(b => inside(b) && !hit(b, placed) && !hit(b, obstacles));
      if (!box) {                                  // nothing clear: least overlap with bars and labels
        let best = Infinity;
        for (const b of cands) {
          if (!inside(b) || hit(b, placed)) continue;
          const a = area(b, obstacles) + Math.hypot(b.x - ax, b.y - ay) * 0.01;
          if (a < best) { best = a; box = b; }
        }
      }
      box = box || cands[0];
      box = Object.assign({}, box, { x: Math.max(P.chartX + 0.5, Math.min(box.x, chartR - 0.5 - w)) });
      placed.push(box);
      // leader to the nearest box edge
      const lx = box.x > ax ? box.x : box.x + box.w;
      const ly = Math.max(box.y, Math.min(box.y + box.h, ay));
      if (!whole) {
        cv.line(ax, ay, lx, ly, C.annStroke, 0.18);
        cv.polygon([[ax, ay - 0.55], [ax + 0.55, ay], [ax, ay + 0.55], [ax - 0.55, ay]], C.annStroke);
      }
      cv.rect(box.x, box.y, box.w, box.h, C.annFill, C.annStroke, 0.18);
      lines.forEach((l, i) => cv.textEnc(l, box.x + pad, box.y + pad + 0.718 * pt / MM + i * lineH, pt, false, C.annText));
    }
  }

  function legendSwatch(cv, key, x, y, w, h, C) {
    const mid = y + h / 2;
    switch (key) {
      case 'Critical activity': cv.rect(x, y + h * 0.2, w, h * 0.6, C.crit, C.critEdge, 0.1); break;
      case 'Non-critical activity': cv.rect(x, y + h * 0.2, w, h * 0.6, C.norm, C.normEdge, 0.1); break;
      case 'Progress':
        cv.rect(x, y + h * 0.2, w, h * 0.6, C.norm); cv.rect(x, y + h * 0.2, w * 0.55, h * 0.6, C.normProg);
        cv.rect(x, y + h * 0.2, w, h * 0.6, null, C.normEdge, 0.1); break;
      case 'Summary': {
        const t = y + h * 0.25, th = h * 0.28, tri = h * 0.3;
        cv.rect(x, t, w, th, C.summary);
        cv.polygon([[x, t + th], [x + tri, t + th], [x, t + th + tri]], C.summary);
        cv.polygon([[x + w, t + th], [x + w - tri, t + th], [x + w, t + th + tri]], C.summary);
        break;
      }
      case 'Milestone': {
        const cx = x + w / 2, r = h * 0.42;
        cv.polygon([[cx, mid - r], [cx + r, mid], [cx, mid + r], [cx - r, mid]], C.crit, C.msEdge, 0.12);
        break;
      }
      case 'Baseline': cv.rect(x, mid - h * 0.12, w, h * 0.24, C.baseline, C.baselineEdge, 0.08); break;
      case 'Total float': cv.line(x, mid, x + w, mid, C.float, 0.18); cv.line(x + w, mid - h * 0.25, x + w, mid + h * 0.25, C.float, 0.18); break;
      case 'Link (critical / other)':
        cv.polyline([[x, mid - h * 0.25], [x + w * 0.4, mid - h * 0.25], [x + w * 0.4, mid + h * 0.15]], C.linkCrit, 0.22);
        arrowHead(cv, x + w * 0.4, mid + h * 0.4, 'down', C.linkCrit, h * 0.28);
        cv.polyline([[x + w * 0.55, mid - h * 0.25], [x + w * 0.95, mid - h * 0.25], [x + w * 0.95, mid + h * 0.15]], C.link, 0.16);
        arrowHead(cv, x + w * 0.95, mid + h * 0.4, 'down', C.link, h * 0.28);
        break;
      case 'Data date': cv.line(x + w / 2, y, x + w / 2, y + h, C.dd, 0.35, [1.0, 0.6]); break;
      case 'Deadline': cv.line(x + w / 2, y, x + w / 2, y + h, C.deadline, 0.35, [1.5, 0.5, 0.35, 0.5]); break;
      case 'Progress line': cv.polyline([[x + w * 0.6, y], [x + w * 0.2, mid], [x + w * 0.6, y + h]], C.progLine, 0.3); break;
      default: break;
    }
  }

  function drawLegend(cv, n, x, y, w, h, perLine, C, withLabel) {
    const items = legendItems(n);
    const pt = 5.6;
    let top = y + 0.8;
    if (withLabel) { cv.text('LEGEND', x + 1.5, y + 3.0, 5, true, C.muted); top = y + 4.0; }
    const cols = perLine || Math.max(1, Math.ceil(items.length / Math.max(1, Math.floor((h - (top - y) - 0.5) / GEOMETRY.legend_line_mm))));
    const colW = (w - 3) / cols;
    items.forEach((k, i) => {
      const cx = x + 1.5 + (i % cols) * colW, cy = top + Math.floor(i / cols) * GEOMETRY.legend_line_mm;
      legendSwatch(cv, k, cx, cy + 0.4, 6, 2.6, C);
      cv.text(k, cx + 7.2, cy + 2.6, pt, false, C.text, 'left', colW - 8);
    });
  }

  /** `band` is the row band shown (0-based), or null on the cover page. */
  function drawTitleBlock(cv, n, P, pageNo, band, sheet, C) {
    const x0 = P.m, W = P.usableW, meta = n.meta;
    let y0 = P.tbY;
    cv.rect(x0, y0, W, P.tbH, '#ffffff', C.frame, 0.45);
    if (P.legendStrip) {
      drawLegend(cv, n, x0, y0, W, P.legendStrip, P.legendPerLine, C, false);
      y0 += P.legendStrip;
      cv.line(x0, y0, x0 + W, y0, C.frame, 0.3);
    }
    const H = GEOMETRY.info_mm;
    const narrow = W < 260;
    // cell widths (mm): fixed parts first, the project (and title) cells share what is left
    const wPage = narrow ? 26 : 30, wDates = narrow ? 42 : 44, wIssue = narrow ? 46 : 44;
    const wLegend = P.legendInline ? 112 : 0;
    const rest = W - wPage - wDates - wIssue - wLegend;
    const wTitle = narrow ? 0 : Math.max(40, rest * 0.48), wProj = rest - wTitle;
    const cells = [['PROJECT', wProj]];
    if (wTitle) cells.push(['TITLE', wTitle]);
    cells.push(['PROGRAMME DATES', wDates], ['ISSUE', wIssue]);
    if (wLegend) cells.push(['LEGEND', wLegend]);
    cells.push(['SHEET', wPage]);
    let x = x0;
    const label = (t, cx) => cv.text(t, cx + 1.5, y0 + 3.0, 5, true, C.muted);
    const kv = (k, v, cx, cy, w) => {
      cv.text(k, cx + 1.5, cy, 6, false, C.muted);
      cv.text(v || '\u2014', cx + w - 1.5, cy, 6.5, true, C.text, 'right', w - 3 - textWidth(k, 6, false) - 1.5);
    };
    // largest size (maxPt..minPt) at which `enc` wraps into `lines` lines without truncation
    const fitSize = (enc, w, maxPt, minPt, lines) => {
      for (let pt = maxPt; pt > minPt; pt -= 0.5) {
        const l = wrapEnc(enc, w, pt, true, lines);
        if (!l.some(t => t.endsWith(ELLIPSIS)) && widthEnc(l.join(' '), pt, true) >= widthEnc(enc, pt, true) - 0.01) return pt;
      }
      return minPt;
    };
    const defs = {};
    for (const [name, w] of cells) { defs[name] = { x, w }; x += w; if (x < x0 + W - 0.01) cv.line(x, y0, x, y0 + H, C.frame, 0.25); }
    // project
    {
      const { x: cx, w } = defs.PROJECT;
      label('PROJECT', cx);
      const enc = encodeText(meta.project_name || '');
      if (narrow) {
        const pt = fitSize(enc, w - 3, 9.5, 7, 1);
        cv.textEnc(fitEnc(enc, w - 3, pt, true), cx + 1.5, y0 + 7.2, pt, true, C.text);
        cv.text(meta.title || '', cx + 1.5, y0 + 10.9, 7, true, C.muted, 'left', w - 3);
        if (meta.project_id) cv.text('Project ID: ' + meta.project_id, cx + 1.5, y0 + 14.5, 6.3, false, C.text, 'left', w - 3);
        if (meta.client) cv.text('Client: ' + meta.client, cx + 1.5, y0 + 17.9, 6.3, false, C.text, 'left', w - 3);
      } else {
        const pt = fitSize(enc, w - 3, 10, 7.5, 2);
        const lines = wrapEnc(enc, w - 3, pt, true, 2);
        const lh = pt / MM * 1.18;
        lines.forEach((l, i) => cv.textEnc(l, cx + 1.5, y0 + 7.4 + i * lh, pt, true, C.text));
        if (meta.project_id) cv.text('Project ID: ' + meta.project_id, cx + 1.5, y0 + H - 5.0, 6.5, false, C.text, 'left', w - 3);
        if (meta.client) cv.text('Client: ' + meta.client, cx + 1.5, y0 + H - 1.8, 6.5, false, C.text, 'left', w - 3);
      }
    }
    // title + notes
    if (defs.TITLE) {
      const { x: cx, w } = defs.TITLE;
      label('TITLE', cx);
      cv.text(meta.title || '', cx + 1.5, y0 + 7.4, 9, true, C.text, 'left', w - 3);
      if (meta.notes) {
        const lines = wrapEnc(encodeText(meta.notes), w - 3, 6, false, 3);
        lines.forEach((l, i) => cv.textEnc(l, cx + 1.5, y0 + 11.6 + i * 2.7, 6, false, C.muted));
      }
    }
    // dates
    {
      const { x: cx, w } = defs['PROGRAMME DATES'];
      label('PROGRAMME DATES', cx);
      kv('Data date', formatDate(meta.data_date), cx, y0 + 7.2, w);
      kv('Forecast finish', formatDate(meta.forecast_finish), cx, y0 + 11.0, w);
      kv('Deadline', formatDate(meta.deadline), cx, y0 + 14.8, w);
      const dl = msOf(meta.deadline), ff = msOf(meta.forecast_finish);
      if (dl !== null && ff !== null) {
        const days = dayNum(dl) - dayNum(ff);
        const t = days >= 0 ? `${days}d ahead of deadline` : `${-days}d beyond deadline`;
        cv.text(t, cx + w - 1.5, y0 + 18.6, 5.6, true, days >= 0 ? C.muted : C.deadline, 'right');
      }
    }
    // issue
    {
      const { x: cx, w } = defs.ISSUE;
      label('ISSUE', cx);
      kv('Revision', meta.revision, cx, y0 + 7.2, w);
      kv('Prepared by', meta.prepared_by, cx, y0 + 11.0, w);
      const pr = parseISO(meta.printed_at);
      kv('Printed', pr ? formatDate(meta.printed_at) + (pr.dateOnly ? '' : ' ' + new Date(pr.ms).toISOString().slice(11, 16)) : '', cx, y0 + 14.8, w);
    }
    if (defs.LEGEND) { const { x: cx, w } = defs.LEGEND; drawLegend(cv, n, cx, y0, w, H, 0, C, true); }
    // page
    {
      const { x: cx, w } = defs.SHEET;
      label('SHEET', cx);
      cv.text(`Page ${pageNo} of ${P.pageCount}`, cx + w / 2, y0 + 10.5, 9, true, C.text, 'center', w - 2);
      if (band === null) cv.text('Briefing', cx + w / 2, y0 + 15, 5.4, false, C.muted, 'center', w - 2);
      else if (P.wide > 1) cv.text(`Rows ${band + 1}/${P.pagesTall}  •  across ${sheet + 1}/${P.wide}`, cx + w / 2, y0 + 15, 5.4, false, C.muted, 'center', w - 2);
      else if (P.pagesTall > 1) cv.text(`Rows ${band * P.rpp + 1}–${Math.min(n.rows.length, band * P.rpp + P.rpp)} of ${n.rows.length}`, cx + w / 2, y0 + 15, 5.4, false, C.muted, 'center', w - 2);
    }
  }

  // ---------------------------------------------------------------------------------------
  // cover (briefing) page
  // ---------------------------------------------------------------------------------------
  /** `enc` with a trailing ellipsis, cut so that it still fits w mm. */
  const ellipsise = (enc, w, pt, bold) => (enc.endsWith(ELLIPSIS) ? enc : fitEnc(enc + ELLIPSIS, w, pt, bold));

  /** Word-wrap with a per-line width, widthOf(lineIndex) in mm (the first line of a watch item
      runs on after its bold name). The last line is cut with an ellipsis when text remains. */
  function wrapFlex(enc, widthOf, pt, bold, maxLines) {
    const words = enc.split(' ').filter(w => w.length);
    const lines = [];
    let cur = '', i = 0;
    while (i < words.length && lines.length < maxLines) {
      const w = widthOf(lines.length);
      const trial = cur ? cur + ' ' + words[i] : words[i];
      if (widthEnc(trial, pt, bold) <= w) { cur = trial; i++; continue; }
      if (cur) { lines.push(cur); cur = ''; continue; }
      lines.push(fitEnc(words[i], w, pt, bold)); i++;      // a single over-long word
    }
    if (cur && lines.length < maxLines) { lines.push(cur); cur = ''; }
    if ((i < words.length || cur) && lines.length) { const k = lines.length - 1; lines[k] = ellipsise(lines[k], widthOf(k), pt, bold); }
    return lines;
  }

  /** The briefing page: heading, headline, KPI tiles, paragraphs (two columns on a landscape
      sheet when the text is long), then the milestone table and the watch list side by side
      (stacked on portrait), and a footer line. Everything is budgeted against the space between
      the header band and the title block: paragraphs take what the fixed parts leave and are cut
      with an ellipsis; the table and watch list lose rows/items before the paragraphs lose their
      last three lines. The content area is clipped as a last defence. */
  function drawCover(cv, n, P, pageNo) {
    const C = n.options.colour === false ? PALETTE_MONO : PALETTE_COLOUR;
    const K = n.cover, G = GEOMETRY;
    const x0 = P.m, W = P.usableW, land = P.W > P.H, wideSheet = W >= 330;
    const top = P.tsY, bottom = P.tbY - G.gap_mm;
    const titlePt = wideSheet ? 24 : 20, subPt = wideSheet ? 10 : 9, headPt = wideSheet ? 12.5 : 11, bodyPt = wideSheet ? 9 : 8.5;
    const bodyLh = bodyPt / MM * 1.4;
    const base = (ty, pt, lh) => ty + (lh + 0.72 * pt / MM) / 2;     // baseline that centres the caps in a line box
    const date = v => formatDate(v) || (v == null ? '' : String(v));
    drawHeader(cv, n, P, C, null);
    cv.save();
    cv.clip(x0, top, W, bottom - top);
    const footerH = K.footer ? 5.5 : 0;
    const limit = bottom - footerH;                  // nothing but the footer goes below this
    let y = top + 1.5;

    // ---------- heading ----------
    let headed = false;
    if (K.title) {
      const lh = titlePt / MM * 1.15;
      cv.textEnc(fitEnc(encodeText(K.title), W, titlePt, true), x0, base(y, titlePt, lh), titlePt, true, C.text);
      y += lh; headed = true;
    }
    if (K.subtitle) {
      const lh = subPt / MM * 1.4;
      cv.text(K.subtitle, x0, base(y, subPt, lh), subPt, false, C.muted, 'left', W);
      y += lh; headed = true;
    }
    if (headed) { y += 1.6; cv.line(x0, y, x0 + W, y, C.frame, 0.3); y += 3.2; }

    // ---------- headline ----------
    if (K.headline && y < limit) {
      const lh = headPt / MM * 1.3;
      const maxL = Math.max(1, Math.min(3, Math.floor((limit - y) / lh)));
      for (const l of wrapEnc(encodeText(K.headline), W, headPt, true, maxL)) { cv.textEnc(l, x0, base(y, headPt, lh), headPt, true, C.text); y += lh; }
      y += 2.5;
    }

    // ---------- KPI tiles ----------
    const tileH = wideSheet ? 14 : 12.5;
    if (K.kpis.length && y + tileH <= limit) {
      const k = K.kpis.length, gap = 3;
      const tw = Math.min(wideSheet ? 72 : 62, (W - gap * (k - 1)) / k);
      K.kpis.forEach((kpi, i) => {
        const x = x0 + i * (tw + gap);
        cv.rect(x, y, tw, tileH, C.sumRow, C.gridMaj, 0.2);
        cv.rect(x, y, 0.9, tileH, C.accent);
        cv.text(kpi.label, x + 3, y + 4.3, 5.5, true, C.muted, 'left', tw - 5);
        const enc = encodeText(kpi.value);
        let pt = wideSheet ? 12 : 10.5;
        while (pt > 7 && widthEnc(enc, pt, true) > tw - 5) pt -= 0.5;
        cv.textEnc(fitEnc(enc, tw - 5, pt, true), x + 3, y + tileH - 3.6, pt, true, C.text);
      });
      y += tileH + 4.5;
    }

    // ---------- measure what sits below the paragraphs: milestone table and watch list ----------
    const sectionGap = 4, gutter = 8, lblH = 4.6;
    const minPara = K.paragraphs.length ? 3 * bodyLh + sectionGap : 0;
    const budget = limit - y - minPara;
    const sideBySide = land && K.milestones.length > 0 && K.watch.length > 0;
    const tblW = sideBySide ? Math.round(W * 0.56) : land ? Math.min(W, Math.max(120, W * 0.6)) : W;
    const wchW = sideBySide ? W - tblW - gutter : W;
    const withBase = K.milestones.some(m => m.baseline_date);
    const tblPt = 7, tblRowH = wideSheet ? 5 : 4.7, tblHeadH = 5.4;
    const tableH = (rows, more) => (rows ? lblH + tblHeadH + rows * tblRowH + (more ? 4.2 : 0) : 0);
    const wPt = bodyPt * 0.95, wLh = wPt / MM * 1.32, wIndent = 4.5;
    const watchLines = items => items.map(it => {
      const nameEnc = fitEnc(encodeText(it.name), (wchW - wIndent) * 0.6, wPt, true);
      const nameW = nameEnc ? widthEnc(nameEnc, wPt, true) + 1.6 : 0;
      const firstW = wchW - wIndent - nameW, restW = wchW - wIndent;
      const textEnc = encodeText(it.text);
      let lines;
      if (!textEnc) lines = [];
      else if (firstW < 20) lines = [''].concat(wrapFlex(textEnc, () => restW, wPt, false, 1));   // long name: text starts on the next line
      else lines = wrapFlex(textEnc, i => (i ? restW : firstW), wPt, false, 2);
      return { nameEnc, nameW, lines };
    });
    const watchH = wl => (wl.length ? lblH + wl.reduce((s, it) => s + Math.max(1, it.lines.length) * wLh + 1.0, 0) : 0);
    let msRows = Math.min(18, K.milestones.length), wItems = K.watch.slice();
    let wl = watchLines(wItems), tH = 0, wH = 0, blockH = 0;
    const measure = () => {
      tH = tableH(msRows, K.milestones.length - msRows); wH = watchH(wl);
      blockH = sideBySide ? Math.max(tH, wH) : tH + wH + (tH && wH ? sectionGap : 0);
      return blockH;
    };
    while (measure() > budget && (msRows > 0 || wItems.length)) {
      if (msRows > 0 && (tH >= wH || !wItems.length)) msRows--;
      else { wItems.pop(); wl = watchLines(wItems); }
    }
    if (blockH > budget) { msRows = 0; wl = []; blockH = 0; }

    // ---------- paragraphs ----------
    const paraBottom = limit - (blockH ? blockH + sectionGap : 0);
    const maxLines = Math.floor((paraBottom - y) / bodyLh + 1e-9);
    let paraEnd = y;
    if (K.paragraphs.length && maxLines > 0) {
      const encs = K.paragraphs.map(encodeText);
      const fullLines = encs.reduce((s, e) => s + wrapEnc(e, W, bodyPt, false, 1e6).length, 0);
      const colN = land && fullLines >= 4 ? 2 : 1;
      const colW = (W - gutter * (colN - 1)) / colN;
      // one flat flow of lines and half-line paragraph gaps, then dealt into balanced columns
      const flow = [];
      encs.forEach((e, pi) => {
        if (pi) flow.push({ gap: true });
        for (const l of wrapEnc(e, colW, bodyPt, false, 1e6)) flow.push({ enc: l });
      });
      const total = flow.reduce((s, it) => s + (it.gap ? 0.5 : 1), 0);
      const cut = total > maxLines * colN + 1e-9;
      const target = cut ? maxLines : Math.ceil(total / colN);
      const cols = Array.from({ length: colN }, () => []);          // items: { enc } | { gap: true }
      let ci = 0, used = 0, placed = 0;
      for (const it of flow) {
        const cost = it.gap ? 0.5 : 1;
        if (it.gap && used === 0) { placed++; continue; }           // no gap at the top of a column
        if (used + cost > target + 1e-9 || (it.gap && used + 1.5 > target + 1e-9)) {
          ci++; used = 0;
          if (ci >= colN) break;
          if (it.gap) { placed++; continue; }
        }
        cols[ci].push(it); used += cost; placed++;
      }
      if (placed < flow.length) {                                    // text remains: mark the last line
        for (let c = colN - 1; c >= 0; c--) {
          const last = cols[c].filter(it => it.enc).pop();
          if (last) { last.enc = ellipsise(last.enc, colW, bodyPt, false); break; }
        }
      }
      cols.forEach((items, c) => {
        const x = x0 + c * (colW + gutter);
        let ty = y;
        for (const it of items) {
          if (it.gap) { ty += bodyLh * 0.5; continue; }
          cv.textEnc(it.enc, x, base(ty, bodyPt, bodyLh), bodyPt, false, C.text);
          ty += bodyLh;
        }
        paraEnd = Math.max(paraEnd, ty);
      });
    }

    // ---------- milestone table and watch list ----------
    if (blockH) {
      let bx = x0, by = paraEnd > y ? paraEnd + sectionGap : y;
      if (msRows) {
        drawMilestones(cv, K.milestones, bx, by, tblW, msRows, withBase, C, { pt: tblPt, rowH: tblRowH, headH: tblHeadH, lblH, date });
        if (sideBySide) bx += tblW + gutter; else by += tH + (wl.length ? sectionGap : 0);
      }
      if (wl.length) drawWatch(cv, wl, bx, by, C, { pt: wPt, lh: wLh, indent: wIndent, lblH });
    }

    // ---------- footer ----------
    if (K.footer) {
      cv.line(x0, limit + 0.8, x0 + W, limit + 0.8, C.rowLine, 0.15);
      cv.text(K.footer, x0, bottom - 1.4, 6.5, false, C.muted, 'left', W);
    }
    cv.restore();
    drawTitleBlock(cv, n, P, pageNo, null, 0, C);
  }

  function drawMilestones(cv, ms, x, y, w, rows, withBase, C, o) {
    cv.text('MILESTONES', x, y + 3.0, 5, true, C.muted);
    y += o.lblH;
    const dateW = Math.min(24, Math.max(16, w * 0.17)), varW = Math.min(14, Math.max(10, w * 0.1));
    const cols = [{ t: 'Milestone', w: w - dateW - (withBase ? dateW + varW : 0), al: 'left' }, { t: 'Date', w: dateW, al: 'right' }];
    if (withBase) cols.push({ t: 'Baseline', w: dateW, al: 'right' }, { t: 'Var', w: varW, al: 'right' });
    let cx = x;
    cols.forEach(c => { c.x = cx; cx += c.w; });
    const tableTop = y;
    const cell = (c, enc, by, pt, bold, col) =>
      cv.textEnc(fitEnc(enc, c.w - 3, pt, bold), c.al === 'right' ? c.x + c.w - 1.5 : c.x + 1.5, by, pt, bold, col, c.al);
    cv.rect(x, y, w, o.headH, C.headFill);
    cols.forEach(c => cell(c, encodeText(c.t), y + o.headH / 2 + 0.72 * 6.5 / MM / 2, 6.5, true, C.text));
    y += o.headH;
    for (let i = 0; i < rows; i++) {
      const m = ms[i], c0 = cols[0];
      const by = y + o.rowH / 2 + 0.72 * o.pt / MM / 2;
      if (i) cv.line(x, y, x + w, y, C.rowLine, 0.1);
      const nameEnc = encodeText(m.name), stEnc = encodeText(m.status);
      if (stEnc) {                                       // status in grey after the name, when there is room
        const nw = widthEnc(nameEnc, o.pt, false), sw = widthEnc(stEnc, 6, false);
        if (nw + 2.5 + sw <= c0.w - 3) cv.textEnc(stEnc, c0.x + 1.5 + nw + 2.5, by, 6, false, C.muted);
      }
      cv.textEnc(fitEnc(nameEnc, c0.w - 3, o.pt, false), c0.x + 1.5, by, o.pt, false, C.text);
      cell(cols[1], encodeText(o.date(m.date)), by, o.pt, false, C.text);
      if (withBase) {
        cell(cols[2], encodeText(m.baseline_date ? o.date(m.baseline_date) : '—'), by, o.pt, false, C.text);
        const v = m.variance_days;
        cell(cols[3], encodeText(v === null ? '—' : (v > 0 ? '+' : '') + v + 'd'), by, o.pt, v !== null && v !== 0, v > 0 ? C.deadline : C.text);
      }
      y += o.rowH;
    }
    cv.rect(x, tableTop, w, y - tableTop, null, C.frame, 0.25);
    cols.forEach((c, i) => { if (i) cv.line(c.x, tableTop, c.x, y, C.gridMaj, 0.12); });
    const more = ms.length - rows;
    if (more > 0) cv.text(`and ${more} more`, x + 1.5, y + 3.2, 6.5, false, C.muted, 'left', w - 3);
  }

  function drawWatch(cv, wl, x, y, C, o) {
    cv.text('WATCH', x, y + 3.0, 5, true, C.muted);
    y += o.lblH;
    const bullet = encodeText('•');
    const off = (o.lh + 0.72 * o.pt / MM) / 2;
    for (const it of wl) {
      cv.textEnc(bullet, x + 1.2, y + off, o.pt, true, C.accent);
      if (it.nameEnc) cv.textEnc(it.nameEnc, x + o.indent, y + off, o.pt, true, C.text);
      it.lines.forEach((l, i) => { if (l) cv.textEnc(l, x + o.indent + (i ? 0 : it.nameW), y + i * o.lh + off, o.pt, false, C.text); });
      y += Math.max(1, it.lines.length) * o.lh + 1.0;
    }
  }

  // ---------------------------------------------------------------------------------------
  // PDF file assembly
  // ---------------------------------------------------------------------------------------
  function pdfDate(s) {
    const p = parseISO(s);
    const d = new Date(p ? p.ms : Date.now());
    const z = (v, k) => String(v).padStart(k || 2, '0');
    return `D:${z(d.getUTCFullYear(), 4)}${z(d.getUTCMonth() + 1)}${z(d.getUTCDate())}${z(d.getUTCHours())}${z(d.getUTCMinutes())}${z(d.getUTCSeconds())}`;
  }

  function assemble(pages, W, H, info) {
    const objs = [];                     // index i -> object i+1 body
    const add = body => { objs.push(body); return objs.length; };
    const catalog = add(null), pagesId = add(null);
    const f1 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
    const f2 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
    const infoId = add(`<< /Title (${pdfString(encodeText(info.title))}) /Subject (${pdfString(encodeText(info.subject))}) /Author (${pdfString(encodeText(info.author))}) /Producer (PlannerPDF) /Creator (Construction programme planner) /CreationDate (${info.date}) >>`);
    const kids = [];
    const mb = `[0 0 ${num(W * MM)} ${num(H * MM)}]`;
    for (const content of pages) {
      const cid = add(`<< /Length ${content.length} >>\nstream\n${content}endstream`);
      kids.push(add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox ${mb} /Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >> /ProcSet [/PDF /Text] >> /Contents ${cid} 0 R >>`));
    }
    objs[catalog - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R /PageLayout /SinglePage >>`;
    objs[pagesId - 1] = `<< /Type /Pages /Kids [${kids.map(k => k + ' 0 R').join(' ')}] /Count ${kids.length} >>`;
    let out = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n';
    const offsets = [];
    objs.forEach((body, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${body}\nendobj\n`; });
    const xref = out.length;
    out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
    for (const o of offsets) out += String(o).padStart(10, '0') + ' 00000 n \n';
    out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R /Info ${infoId} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    const bytes = new Uint8Array(out.length);
    for (let i = 0; i < out.length; i++) bytes[i] = out.charCodeAt(i) & 0xff;
    return bytes;
  }

  function render(doc) {
    const n = normalise(doc);
    const P = plan(n);
    const pages = [];
    let pageNo = 0;
    if (n.cover) {
      pageNo++;
      const cv = new Canvas(P.H);
      drawCover(cv, n, P, pageNo);
      pages.push(cv.toString());
    }
    for (let g = 0; g < P.pagesTall; g++) {
      for (let c = 0; c < P.wide; c++) {
        pageNo++;
        const cv = new Canvas(P.H);
        drawPage(cv, n, P, g, c, pageNo);
        pages.push(cv.toString());
      }
    }
    const title = [n.meta.project_name, n.meta.title].filter(Boolean).join(' - ');
    return assemble(pages, P.W, P.H, { title, subject: n.meta.title || '', author: n.meta.prepared_by || '', date: pdfDate(n.meta.printed_at) });
  }

  root.PlannerPDF = { render, layout, formatDate, encodeText, textWidth, GEOMETRY };
})(typeof globalThis !== 'undefined' ? globalThis : this);

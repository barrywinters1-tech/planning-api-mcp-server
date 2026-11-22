/* PlannerPDF: a self-contained, dependency-free vector PDF writer for Gantt programmes.

   Works in browsers and in node: no DOM, no libraries, no network. Loading the file sets
   globalThis.PlannerPDF = { render, layout, money, formatNumber, formatDate, encodeText, textWidth }.

   render(doc) -> Uint8Array   a PDF 1.4 file (uncompressed content streams, exact xref).
   layout(doc) -> object       the pagination plan render() will use: page_w_mm, page_h_mm,
                               rows_per_page, row_height_mm, body_height_mm, pages_tall, pages_wide,
                               page_count (= pages, every page of the file), rows (printed),
                               bands [{ first, last }] (row indices [first, last) per page band),
                               fit_to_pages_tall, fits, cover, cover_pages, report_pages,
                               chart_pages, gantt_pages, reports, charts (counts), reports_only,
                               currency, table_width_mm, chart_width_mm, title_block_mm,
                               title_layout, logo (bool), slices [{ t0, t1 }].
   money(value, currency)      "£12,500" / "€1,250.50" / "-$300": thousands grouped, no decimals
                               when the value is whole, else two; `currency` is an ISO code (GBP,
                               EUR, USD, AUD, ... an unknown code prints as a prefix, "SEK 1,200")
                               or a symbol; default GBP. A non-numeric value prints as given.

   Page order: cover (if any), report pages, chart pages, Gantt pages; one run of page numbers.

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
       notes,            // free text, wrapped into the title block
       currency,         // 'GBP' (default) | 'EUR' | 'USD' | ... or a symbol: how report columns
                         // flagged `money` and money y-axes print (see money())
       title_layout,     // 'standard' (default) | 'compact' (one-line strip) | 'wide' (two rows:
                         // info cells, then the legend on a row of its own)
       logo              // null | { data: base64 (a data: URL prefix is fine), type: 'jpeg'|'png',
                         //   width_mm, height_mm }  drawn in the title block's project cell.
                         // JPEG is embedded as is (DCTDecode). PNG is embedded without decoding:
                         // its IDAT stream is read by FlateDecode with the PNG predictor, so only
                         // non-interlaced, 1-8 bit grey / RGB / palette PNGs work; a PNG with an
                         // alpha channel, 16-bit samples or interlacing throws a clear Error
                         // (flatten it or use JPEG). Missing width/height follow the pixel aspect.
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
       label,                         // bar text, or ''
       colour,                        // optional '#rrggbb': overrides the bar fill for this row
                                      // (progress and edge are darker shades; greyed when colour: false)
       selected                       // optional bool, read with options.selected_only
     }],
     links: [{ from: rowIndex, to: rowIndex, type: 'FS'|'SS'|'FF'|'SF', critical: bool }],
     range: { t0: ISO, t1: ISO },     // the timescale shown (a date-only t1 is inclusive)
     annotations: [{ date: ISO, row: index|null, text }],  // callouts; row null = whole chart
     period_lines: [{ label, date: ISO, colour?, points: [{ row: index, x_date: ISO }] }],
     shading: [{ from: ISO date, to: ISO date (inclusive), label?, colour? '#rrggbb' }],  // date-range bands behind the bars (shutdowns, holidays, phases)
                                      // closed progress periods: one dashed polyline each, in a
                                      // muted colour (cycled, or `colour`), labelled at the top of
                                      // the chart; it runs down the period's date and jogs through
                                      // x_date at each listed row (the app computes them from its
                                      // on-screen dashed lines). Drawn after the bars and before
                                      // the current progress line.
     options: {
       show_links, show_float, show_baseline, show_progress_line,  // bool
       legend,                        // bool: legend in the title block
       rows_per_page,                 // number | null (null = fit to page height)
       fit_to_pages_wide,             // 1 = timescale fits page width; n = split across n pages
       colour,                        // true; false = greyscale palette for mono printers
       // optional extras (defaults shown):
       shade_weekends: true,          // grey Sat/Sun bands when a day is >= 2 mm wide
       row_height_mm: 5,              // preferred (maximum) row height
       work_hours: [8, 16],           // bar ends: times in this window map linearly onto the day
       fit_to_pages_tall: null,       // integer >= 1: pick rows_per_page so every row fits N pages
                                      // tall, shrinking rows (floor 3.2 mm) and text (floor 6 pt);
                                      // overrides rows_per_page. When even the floor cannot fit,
                                      // the minimum row height is used and layout().fits is false.
       page_break_before_groups: false, // new page before every summary row at depth 0 (unless
                                      // it already starts a page)
       selected_only: false,          // print only rows with `selected`, plus their ancestor
                                      // summary rows (when no row is selected, every row prints);
                                      // links, annotations and period_lines are re-indexed
       legend_items: [],              // [{ label, colour: '#rrggbb' }]: extra swatches after the
                                      // standard legend items (chart coloured by code/resource).
                                      // With more than 12 items the legend leaves the info strip
                                      // and wraps across as many rows as it needs.
       reports_only: false            // true: emit the cover (if any), the report pages and the
                                      // chart pages but no Gantt pages (ignored when that would
                                      // leave the file empty)
     },
     reports: [{                      // the "report pack": table pages after the cover, before the
                                      // Gantt pages, on the same paper; a report that overflows
                                      // continues on further pages with its title and column
                                      // headers repeated
       kind,                          // free tag ('milestones', 'cost', ...), not printed
       title, subtitle,               // heading lines above the table
       columns: [{ key, label, width?, align?: 'left'|'right', num?: true, money?: true }],
                                      // width in mm; columns without one share what is left in
                                      // proportion to their label / longest cell. `num` prints a
                                      // number with thousands separators, `money` with the
                                      // currency symbol (both right-aligned unless `align` says)
       rows: [{ ...cells by key, _bold?: true, _indent?: 0..4, _colour?: '#rrggbb' }],
                                      // _bold: a section heading row (bold, shaded, no zebra);
                                      // _indent: indents the first cell by 2.6 mm a level;
                                      // _colour: a small swatch before the first cell
       notes                          // small text under the table on the report's last page
     }],
     charts: [{                       // one vector page per chart, after the reports
       kind: 'scurve' | 'histogram',  // a tag; series (polylines) and bars (stacked columns per
                                      // date) are both drawn whenever they are given
       title, subtitle,
       series: [{ label, colour, points: [[iso_date, value], ...] }],
       bars: [{ label, colour, points }],      // stacked per date in array order
       x_labels: 'months' | 'weeks',  // tick spacing and labels (default months)
       y_label,                       // axis caption above the y axis
       y_money: false,                // y tick labels as money (meta.currency)
       limit: { label, value },       // a horizontal capacity line
       data_date: iso                 // dashed vertical line
     }],
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
    row_mm: 5,              // default row height
    row_min_mm: 3.2,        // floor for fit_to_pages_tall
    compact_mm: 8           // info strip height for title_layout 'compact'
  };
  const TITLE_LAYOUTS = ['standard', 'compact', 'wide'];
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
  // numbers and money
  // ---------------------------------------------------------------------------------------
  const CURRENCY_SYMBOLS = { GBP: '£', EUR: '€', USD: '$', AUD: 'A$', CAD: 'C$', NZD: 'NZ$', HKD: 'HK$', SGD: 'S$',
    JPY: '¥', CNY: '¥', ZAR: 'R', INR: 'Rs ', CHF: 'CHF ' };
  /** 'GBP' | '£' | 'SEK' | ... -> the prefix money() prints; an unknown ISO code prints as 'SEK '. */
  function currencySymbol(c) {
    const s = c == null ? '' : String(c).trim();
    if (!s) return CURRENCY_SYMBOLS.GBP;
    const up = s.toUpperCase();
    if (CURRENCY_SYMBOLS[up]) return CURRENCY_SYMBOLS[up];
    return /^[A-Z]{3}$/.test(up) ? up + ' ' : s;
  }
  const groupThousands = s => s.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  /** A finite number from a number or a numeric string, else null. */
  function numberOf(v) {
    if (typeof v === 'number') return isFinite(v) ? v : null;
    if (typeof v === 'string' && v.trim() !== '' && isFinite(+v)) return +v;
    return null;
  }
  /** "12,500" or "12,500.50" (two decimals unless the value is whole); non-numbers print as given. */
  function formatNumber(v) {
    const x = numberOf(v);
    if (x === null) return v == null ? '' : String(v);
    const abs = Math.abs(x), whole = Math.abs(abs - Math.round(abs)) < 0.005;
    const [i, d] = (whole ? Math.round(abs).toFixed(0) : abs.toFixed(2)).split('.');
    const body = groupThousands(i) + (d ? '.' + d : '');
    return (x < 0 && body !== '0' ? '-' : '') + body;
  }
  /** "£12,500" / "€1,250.50" / "-$300"; `currency` an ISO code or a symbol (default GBP). */
  function money(value, currency) {
    const x = numberOf(value);
    if (x === null) return value == null ? '' : String(value);
    const body = formatNumber(Math.abs(x));
    return (x < 0 && body !== '0' ? '-' : '') + currencySymbol(currency) + body;
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
    msEdge: '#1f2937', white: '#ffffff', progLine: '#8b5cf6', zebra: '#f7f8fa'
  };
  const PALETTE_MONO = Object.assign({}, PALETTE_COLOUR, {
    crit: '#333333', critProg: '#000000', critEdge: '#000000',
    norm: '#b3b3b3', normProg: '#5c5c5c', normEdge: '#4d4d4d',
    summary: '#262626', baseline: '#d0d0d0', baselineEdge: '#8c8c8c', float: '#404040',
    link: '#555555', linkCrit: '#111111', dd: '#3c3c3c', deadline: '#000000',
    weekend: '#f0f0f0', sumRow: '#f2f2f2', headFill: '#e8e8e8', gridMaj: '#c4c4c4',
    gridMin: '#e5e5e5', rowLine: '#e0e0e0', frame: '#333333', text: '#111111', muted: '#606060',
    annFill: '#f5f5f5', annStroke: '#555555', annText: '#111111', accent: '#222222',
    msEdge: '#000000', progLine: '#3c3c3c', zebra: '#f6f6f6'
  });
  // default colours for chart series (lines) and bars (stacked columns), cycled
  const SERIES_COLOUR = ['#1f5fbf', '#d97706', '#059669', '#7c3aed', '#dc2626', '#0891b2'];
  const BAR_COLOUR = ['#4a78c8', '#9bb8e8', '#d9a441', '#6b8e6b', '#8a7ca8', '#a88a5f'];
  function rgb(hex) {
    const h = hex.replace('#', '');
    return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16) / 255);
  }
  // muted colours for period lines, cycled (greys for the mono palette)
  const PERIOD_COLOUR = ['#6b8e6b', '#8a7ca8', '#5f8fa3', '#a88a5f', '#9a6f85', '#7a8a9a'];
  const PERIOD_MONO = ['#555555', '#7a7a7a', '#999999', '#666666', '#8a8a8a', '#444444'];
  const HEX_RE = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/i;
  /** '#rgb' | '#rrggbb' (hash optional) -> '#rrggbb', or null when it is not a colour. */
  function hexColour(v) {
    const m = HEX_RE.exec(String(v == null ? '' : v).trim());
    if (!m) return null;
    let h = m[1].toLowerCase();
    if (h.length === 3) h = h.replace(/./g, c => c + c);
    return '#' + h;
  }
  const hex2 = v => Math.max(0, Math.min(255, Math.round(v * 255))).toString(16).padStart(2, '0');
  /** `hex` mixed towards black by k (0..1). */
  function shade(hex, k) { return '#' + rgb(hex).map(v => hex2(v * (1 - k))).join(''); }
  /** Greyscale equivalent of `hex` (luminance). */
  function grey(hex) { const [r, g, b] = rgb(hex); return '#' + hex2(0.299 * r + 0.587 * g + 0.114 * b).repeat(3); }
  /** A user colour adjusted to the active palette. */
  const tone = (hex, mono) => (mono ? grey(hex) : hex);

  // ---------------------------------------------------------------------------------------
  // images (meta.logo). JPEG passes straight through (DCTDecode). A PNG is embedded without
  // decoding anything: its IDAT data is zlib output whose rows carry PNG filter bytes, which is
  // exactly what FlateDecode with /Predictor 15 reads.
  // ---------------------------------------------------------------------------------------
  const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  /** base64 (standard or URL-safe, a data: URL prefix allowed) -> byte string. */
  function base64Bytes(s) {
    s = String(s == null ? '' : s).replace(/^data:[^,]*,/, '');
    let out = '', buf = 0, bits = 0;
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (ch === '=') break;
      const v = B64.indexOf(ch === '-' ? '+' : ch === '_' ? '/' : ch);
      if (v < 0) continue;
      buf = (buf << 6) | v; bits += 6;
      if (bits >= 8) { bits -= 8; out += String.fromCharCode((buf >> bits) & 0xff); buf &= (1 << bits) - 1; }
    }
    return out;
  }
  const be16 = (b, i) => (b.charCodeAt(i) << 8) | b.charCodeAt(i + 1);
  const be32 = (b, i) => ((b.charCodeAt(i) << 24) | (b.charCodeAt(i + 1) << 16) | (b.charCodeAt(i + 2) << 8) | b.charCodeAt(i + 3)) >>> 0;

  /** JPEG byte string -> { w, h, dict, data } from its frame header (SOFn). */
  function parseJPEG(b) {
    let i = 2;
    while (i + 4 <= b.length) {
      if (b.charCodeAt(i) !== 0xff) { i++; continue; }
      const m = b.charCodeAt(i + 1);
      if (m === 0xff) { i++; continue; }
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
      if (m === 0xda || m === 0xd9) break;                       // scan data before any frame header
      const len = be16(b, i + 2);
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
        const h = be16(b, i + 5), w = be16(b, i + 7), nc = b.charCodeAt(i + 9);
        if (!w || !h) break;
        const cs = nc === 1 ? '/DeviceGray' : nc === 4 ? '/DeviceCMYK' : '/DeviceRGB';
        return { w, h, data: b, dict: `/ColorSpace ${cs} /BitsPerComponent 8 /Filter /DCTDecode` + (nc === 4 ? ' /Decode [1 0 1 0 1 0 1 0]' : '') };
      }
      i += 2 + len;
    }
    throw new Error('logo: the JPEG has no readable frame header');
  }

  /** PNG byte string -> { w, h, dict, data } with the IDAT stream as FlateDecode data. */
  function parsePNG(b) {
    let i = 8, w = 0, h = 0, depth = 0, ctype = 0, idat = '', plte = '';
    while (i + 12 <= b.length) {
      const len = be32(b, i), type = b.slice(i + 4, i + 8), body = b.slice(i + 8, i + 8 + len);
      if (type === 'IHDR') {
        w = be32(b, i + 8); h = be32(b, i + 12); depth = b.charCodeAt(i + 16); ctype = b.charCodeAt(i + 17);
        if (b.charCodeAt(i + 20)) throw new Error('logo: interlaced PNG is not supported; save it non-interlaced or as JPEG');
      } else if (type === 'PLTE') plte = body;
      else if (type === 'IDAT') idat += body;
      else if (type === 'IEND') break;
      i += 12 + len;
    }
    if (!w || !h || !idat) throw new Error('logo: the PNG has no IHDR or IDAT chunk');
    if (ctype === 4 || ctype === 6) throw new Error('logo: PNG with an alpha channel is not supported; flatten it (no transparency) or use JPEG');
    if (depth > 8) throw new Error('logo: 16-bit PNG is not supported; save it at 8 bits per channel or as JPEG');
    if (ctype === 3 && !plte) throw new Error('logo: palette PNG without a PLTE chunk');
    const colors = ctype === 2 ? 3 : 1;
    let cs = ctype === 2 ? '/DeviceRGB' : '/DeviceGray';
    if (ctype === 3) {
      let hx = '';
      for (let k = 0; k < plte.length; k++) hx += plte.charCodeAt(k).toString(16).padStart(2, '0');
      cs = `[/Indexed /DeviceRGB ${Math.floor(plte.length / 3) - 1} <${hx}>]`;
    }
    return { w, h, data: idat, dict: `/ColorSpace ${cs} /BitsPerComponent ${depth} /Filter /FlateDecode` +
      ` /DecodeParms << /Predictor 15 /Colors ${colors} /BitsPerComponent ${depth} /Columns ${w} >>` };
  }

  /** meta.logo -> { w, h, dict, data, wmm, hmm } or null; throws a clear Error for images it cannot embed. */
  function normaliseLogo(l) {
    if (!l || typeof l !== 'object' || !l.data) return null;
    const bytes = base64Bytes(l.data);
    if (bytes.length < 16) throw new Error('logo: image data is empty or not base64');
    let img;
    if (bytes.charCodeAt(0) === 0xff && bytes.charCodeAt(1) === 0xd8) img = parseJPEG(bytes);
    else if (bytes.slice(0, 8) === '\x89PNG\r\n\x1a\n') img = parsePNG(bytes);
    else throw new Error(`logo: not a JPEG or PNG file (type given: ${l.type || 'none'})`);
    let wmm = +l.width_mm || 0, hmm = +l.height_mm || 0;
    if (!(wmm > 0) && !(hmm > 0)) hmm = 12;
    if (!(wmm > 0)) wmm = hmm * img.w / img.h;
    if (!(hmm > 0)) hmm = wmm * img.h / img.w;
    return Object.assign(img, { wmm, hmm });
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
    /** The page's image XObject /Im1 scaled into the box (x, y, w, h) mm. */
    image(x, y, w, h) {
      if (w <= 0 || h <= 0) return;
      this.push('q'); this.push(`${num(w * MM)} 0 0 ${num(h * MM)} ${this.X(x)} ${this.Y(y + h)} cm /Im1 Do`); this.push('Q');
    }
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
      printed_at: null, notes: '', title_layout: 'standard', logo: null, currency: 'GBP' }, doc.meta || {});
    if (!TITLE_LAYOUTS.includes(meta.title_layout)) meta.title_layout = 'standard';
    if (meta.currency == null || String(meta.currency).trim() === '') meta.currency = 'GBP';
    const logo = normaliseLogo(meta.logo);
    const page = Object.assign({ size: 'A3', orientation: 'landscape', margins_mm: 10 }, doc.page || {});
    if (!PAGE_SIZES[page.size]) page.size = 'A3';
    if (!(page.margins_mm >= 0)) page.margins_mm = 10;
    const options = Object.assign({ show_links: true, show_float: true, show_baseline: true,
      show_progress_line: false, legend: true, rows_per_page: null, fit_to_pages_wide: 1, colour: true,
      shade_weekends: true, row_height_mm: GEOMETRY.row_mm, work_hours: [8, 16],
      fit_to_pages_tall: null, page_break_before_groups: false, selected_only: false, legend_items: [],
      reports_only: false }, doc.options || {});
    options.legend_items = (Array.isArray(options.legend_items) ? options.legend_items : [])
      .map(it => (it && typeof it === 'object' ? { label: it.label == null ? '' : String(it.label).trim(), colour: hexColour(it.colour) || '#888888' } : null))
      .filter(it => it && it.label);
    let rows = (doc.rows || []).map(r => Object.assign({ kind: 'task', depth: 0, cells: [], critical: false, pct: 0, label: '' }, r,
      { colour: hexColour(r && r.colour) }));
    // row index as given -> index in the printed row list (null = dropped); identity unless selecting
    const idx = v => (v === null || v === undefined || v === '' || !Number.isInteger(+v) || +v < 0 ? null : +v);
    let remap = v => { const i = idx(v); return i === null || i >= rows.length ? null : i; };
    if (options.selected_only && rows.some(r => r.selected)) {
      const keep = new Array(rows.length).fill(false);
      for (let i = 0; i < rows.length; i++) {
        if (!rows[i].selected) continue;
        keep[i] = true;
        let d = Math.max(0, +rows[i].depth || 0);
        for (let j = i - 1; j >= 0 && d > 0; j--) {          // ancestors: nearer summaries at lesser depth
          const rj = rows[j], dj = Math.max(0, +rj.depth || 0);
          if (rj.kind === 'summary' && dj < d) { keep[j] = true; d = dj; }
        }
      }
      const map = new Map();
      rows = rows.filter((r, i) => keep[i] && map.set(i, map.size));
      remap = v => { const i = idx(v); return i !== null && map.has(i) ? map.get(i) : null; };
    }
    const links = (doc.links || []).map(L => {
      if (!L || typeof L !== 'object') return null;
      const from = remap(L.from), to = remap(L.to);
      return from === null || to === null ? null : Object.assign({}, L, { from, to });
    }).filter(Boolean);
    const annotations = (doc.annotations || []).map(an => {
      if (!an || typeof an !== 'object') return null;
      if (idx(an.row) === null) return an;                          // whole-chart callout
      const row = remap(an.row);
      return row === null ? null : Object.assign({}, an, { row });
    }).filter(Boolean);
    const period_lines = (Array.isArray(doc.period_lines) ? doc.period_lines : []).map(pl => {
      if (!pl || typeof pl !== 'object' || !parseISO(pl.date)) return null;
      const points = (Array.isArray(pl.points) ? pl.points : [])
        .map(p => (p && typeof p === 'object' && parseISO(p.x_date) ? { row: remap(p.row), x_date: p.x_date } : null))
        .filter(p => p && p.row !== null).sort((a, b) => a.row - b.row);
      return { label: pl.label == null ? '' : String(pl.label), date: pl.date, colour: hexColour(pl.colour), points };
    }).filter(Boolean);
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
    const shading = (Array.isArray(doc.shading) ? doc.shading : []).map(b => { if (!b || typeof b !== 'object') return null; const f = parseISO(b.from), t = parseISO(b.to); if (!f || !t) return null; const a = dayNum(Math.min(f.ms, t.ms)), z = dayNum(Math.max(f.ms, t.ms)) + 1; return { a, z, label: String(b.label || ''), colour: /^#[0-9a-fA-F]{6}$/.test(b.colour || '') ? b.colour : '#ffd166' }; }).filter(Boolean);
    return { shading, meta, page, options, rows, columns, links, annotations, period_lines, logo, d0, d1,
      cover: normaliseCover(doc.cover), reports: normaliseReports(doc.reports), charts: normaliseCharts(doc.charts) };
  }

  const REPORT_INDENT_MAX = 4;
  /** doc.reports -> [{ kind, title, subtitle, notes, columns, rows: [{ cells, bold, indent, colour }] }]. */
  function normaliseReports(list) {
    if (!Array.isArray(list)) return [];
    const str = v => (v == null ? '' : String(v).trim());
    return list.filter(r => r && typeof r === 'object').map(r => {
      const rows = (Array.isArray(r.rows) ? r.rows : []).filter(x => x && typeof x === 'object').map(x => ({
        cells: x, bold: !!x._bold, indent: Math.max(0, Math.min(REPORT_INDENT_MAX, Math.floor(+x._indent || 0))), colour: hexColour(x._colour) }));
      let colDefs = Array.isArray(r.columns) ? r.columns.filter(c => c && typeof c === 'object') : [];
      if (!colDefs.length && rows.length) colDefs = Object.keys(rows[0].cells).filter(k => k[0] !== '_').map(k => ({ key: k, label: k }));
      const columns = colDefs.map((c, i) => ({
        key: c.key == null ? String(i) : String(c.key), label: str(c.label), width: +c.width > 0 ? +c.width : 0,
        align: c.align === 'right' ? 'right' : c.align === 'left' ? 'left' : (c.num || c.money ? 'right' : 'left'),
        num: !!c.num, money: !!c.money }));
      return { kind: str(r.kind), title: str(r.title), subtitle: str(r.subtitle), notes: str(r.notes), columns, rows };
    });
  }

  /** doc.charts -> [{ kind, title, subtitle, x_labels, y_label, y_money, series, bars, limit, data_date }]
      with every point as { d: day number (fractional), v } sorted by date. */
  function normaliseCharts(list) {
    if (!Array.isArray(list)) return [];
    const str = v => (v == null ? '' : String(v).trim());
    const seriesOf = (arr, dflt) => (Array.isArray(arr) ? arr : []).filter(s => s && typeof s === 'object').map((s, i) => ({
      label: str(s.label), colour: hexColour(s.colour) || dflt[i % dflt.length],
      points: (Array.isArray(s.points) ? s.points : []).map(p => {
        const d = Array.isArray(p) ? p[0] : p && typeof p === 'object' ? p.date : null;
        const v = Array.isArray(p) ? p[1] : p && typeof p === 'object' ? p.value : null;
        const t = msOf(d), y = numberOf(v);
        return t === null || y === null ? null : { d: t / DAY, v: y };
      }).filter(Boolean).sort((a, b) => a.d - b.d) }));
    return list.filter(c => c && typeof c === 'object').map(c => {
      const limV = c.limit && typeof c.limit === 'object' ? numberOf(c.limit.value) : numberOf(c.limit);
      return { kind: c.kind === 'histogram' ? 'histogram' : 'scurve', title: str(c.title), subtitle: str(c.subtitle),
        x_labels: c.x_labels === 'weeks' ? 'weeks' : 'months', y_label: str(c.y_label), y_money: !!c.y_money,
        series: seriesOf(c.series, SERIES_COLOUR), bars: seriesOf(c.bars, BAR_COLOUR),
        limit: limV === null ? null : { label: str(c.limit && typeof c.limit === 'object' ? c.limit.label : '') || 'Limit', value: limV },
        data_date: parseISO(c.data_date) ? c.data_date : null };
    });
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

  /** Legend entries: [{ key, label, colour? }] - the standard items that apply, then options.legend_items. */
  function legendItems(n) {
    const o = n.options;
    const std = LEGEND_ITEMS.filter(k => !((k === 'Baseline' && !o.show_baseline) || (k === 'Total float' && !o.show_float) ||
      (k.startsWith('Link') && !o.show_links) || (k === 'Progress line' && !o.show_progress_line) ||
      (k === 'Deadline' && !parseISO(n.meta.deadline)))).map(k => ({ key: k, label: k }));
    return std.concat(o.legend_items.map(it => ({ key: 'custom', label: it.label, colour: it.colour })));
  }

  /** Row bands [first, last) per page: at most `rpp` rows each and, with `breaks`, a new page
      before every summary row at depth 0 unless it starts a page anyway. Always >= 1 band. */
  function bandsFor(rows, rpp, breaks) {
    const bands = [];
    let first = 0;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if (i > first && (i - first >= rpp || (breaks && r.kind === 'summary' && !(+r.depth > 0)))) { bands.push({ first, last: i }); first = i; }
    }
    if (first < rows.length || !bands.length) bands.push({ first, last: rows.length });
    return bands;
  }

  function plan(n) {
    const G = GEOMETRY;
    const [a, b] = PAGE_SIZES[n.page.size];
    const land = n.page.orientation !== 'portrait';
    const W = land ? b : a, H = land ? a : b, m = n.page.margins_mm;
    const usableW = W - 2 * m;
    const titleLayout = n.meta.title_layout;
    const items = legendItems(n);
    const legendOn = !!n.options.legend && items.length > 0;
    // the legend sits inside the info strip only in the standard layout, on a wide sheet, when
    // its 3 x 4 grid holds every item; otherwise it is a strip of its own (above the info strip,
    // or below it for 'wide') wrapping over as many rows as it needs
    const legendInline = legendOn && titleLayout === 'standard' && usableW >= G.legend_inline_min_mm && items.length <= 12;
    let legendStrip = 0, legendPerLine = 0;
    if (legendOn && !legendInline) {
      legendPerLine = Math.max(1, Math.floor(usableW / G.legend_item_mm));
      legendStrip = 1.6 + Math.ceil(items.length / legendPerLine) * G.legend_line_mm;
    }
    const infoH = titleLayout === 'compact' ? G.compact_mm : G.info_mm;
    const tbH = infoH + legendStrip;
    const headerY = m, tsY = m + G.header_mm + G.gap_mm, tsH = 3 * G.tier_mm, bodyY = tsY + tsH;
    const tbY = H - m - tbH;
    const bodyH = tbY - G.gap_mm - bodyY;
    const base = n.options.row_height_mm > 0 ? n.options.row_height_mm : G.row_mm;
    const breaks = !!n.options.page_break_before_groups;
    const fitTall = Math.floor(+n.options.fit_to_pages_tall || 0);
    let rpp, rowH, fits = true;
    const req = Math.floor(+n.options.rows_per_page || 0);
    if (fitTall > 0) {
      // the fewest rows per page (tallest rows) that fits fitTall pages; rows/fitTall is a lower
      // bound, page breaks before groups may need more, and the row height floor caps it
      const maxRpp = Math.max(1, Math.floor(bodyH / G.row_min_mm + 1e-9));
      rpp = Math.max(1, Math.min(maxRpp, Math.floor(bodyH / base + 1e-9)));
      while (bandsFor(n.rows, rpp, breaks).length > fitTall && rpp < maxRpp) {
        rpp = Math.min(maxRpp, Math.max(rpp + 1, Math.ceil(n.rows.length / fitTall)));
      }
      rowH = Math.min(base, bodyH / rpp);
      fits = bandsFor(n.rows, rpp, breaks).length <= fitTall;
    } else if (req > 0) { rpp = req; rowH = Math.min(base, bodyH / rpp); }
    else { rowH = base; rpp = Math.max(1, Math.floor(bodyH / rowH + 1e-9)); }
    const bands = bandsFor(n.rows, rpp, breaks);
    const pagesTall = bands.length;
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
    // report pack: table pages (one or more per report) and one page per chart, between the
    // cover and the Gantt pages, on the same paper; reports_only drops the Gantt pages unless
    // that would leave the file without a page
    const reports = n.reports.map(r => planReport(n, r, usableW, m, tsY, tbY - G.gap_mm));
    const reportPages = reports.reduce((s, r) => s + r.bands.length, 0);
    const chartPages = n.charts.length;
    const reportsOnly = !!n.options.reports_only && coverPages + reportPages + chartPages > 0;
    const ganttPages = reportsOnly ? 0 : pagesTall * wide;
    return { W, H, m, usableW, headerY, tsY, tsH, bodyY, bodyH, tbY, tbH, infoH, titleLayout, legendInline, legendStrip, legendPerLine,
      rowH, rpp, bands, pagesTall, fitTall, fits, wide, slices, cols, tableW, indentCol, chartX, chartW, coverPages,
      reports, reportPages, chartPages, reportsOnly, ganttPages,
      pageCount: coverPages + reportPages + chartPages + ganttPages };
  }

  // ---------------------------------------------------------------------------------------
  // report pages: geometry and pagination
  // ---------------------------------------------------------------------------------------
  const REPORT = { title_pt: 12, sub_pt: 8, head_mm: 6.5, head_pt: 6.5, row_mm: 5, pt: 7, note_pt: 6.5,
    indent_mm: 2.6, swatch_mm: 2.4, pad_mm: 1.5, min_col_mm: 10 };

  /** The text a report cell prints (money / number formatting per its column). */
  function reportCell(n, col, row) {
    const v = row.cells[col.key];
    if (v == null) return '';
    if (col.money) return money(v, n.meta.currency);
    if (col.num) return formatNumber(v);
    return String(v);
  }

  /** Height of the heading block (title, subtitle, rule and gap) above a report or chart; 0 when neither is set. */
  function headingHeight(title, subtitle) {
    if (!title && !subtitle) return 0;
    return (title ? REPORT.title_pt / MM * 1.25 : 0) + (subtitle ? REPORT.sub_pt / MM * 1.4 : 0) + 1.6 + 3.2;
  }

  /** Column positions and row bands for one report. `top`..`bottom` is the content area; the
      table header repeats on every band and the notes take rows from the last band only. */
  function planReport(n, r, usableW, x0, top, bottom) {
    const R = REPORT;
    const headY = top + headingHeight(r.title, r.subtitle);
    // widths: given in mm, else shared out by the widest of the label and the longest cell
    const widths = r.columns.map(c => c.width);
    const free = widths.map(w => !(w > 0));
    const weights = r.columns.map((c, i) => {
      if (!free[i]) return 0;
      let w = textWidth(c.label, R.head_pt, true);
      for (const row of r.rows) {
        const lead = i === 0 ? row.indent * R.indent_mm + (row.colour ? R.swatch_mm + 1 : 0) : 0;
        w = Math.max(w, textWidth(reportCell(n, c, row), R.pt, row.bold) + lead);
      }
      return Math.max(R.min_col_mm, w + 2 * R.pad_mm + 1);
    });
    const nFree = free.filter(Boolean).length;
    let fixed = widths.reduce((s, w, i) => s + (free[i] ? 0 : w), 0);
    if (nFree) {
      const room = R.min_col_mm * nFree;
      if (fixed > usableW - room && fixed > 0) {              // fixed widths leave the free columns their minimum
        const k = Math.max(0, usableW - room) / fixed;
        for (let i = 0; i < widths.length; i++) if (!free[i]) widths[i] *= k;
        fixed *= k;
      }
      const rem = usableW - fixed, wsum = weights.reduce((s, w) => s + w, 0);
      for (let i = 0; i < widths.length; i++) if (free[i]) widths[i] = rem * weights[i] / wsum;
    } else if (fixed > usableW) {
      const k = usableW / fixed;
      for (let i = 0; i < widths.length; i++) widths[i] *= k;
    }
    const cols = [];
    let x = x0;
    r.columns.forEach((c, i) => { cols.push(Object.assign({}, c, { x, w: widths[i] })); x += widths[i]; });
    const tableW = cols.length ? x - x0 : usableW;
    // pagination: `cap` rows under the header on a page; the notes take rows from the last page
    const avail = bottom - headY - R.head_mm;
    const cap = Math.max(1, Math.floor(avail / R.row_mm + 1e-9));
    const noteLh = R.note_pt / MM * 1.3;
    const maxNoteLines = r.notes ? Math.max(0, Math.min(8, Math.floor((avail - R.row_mm - 3) / noteLh))) : 0;
    const noteLines = maxNoteLines ? wrapEnc(encodeText(r.notes), usableW, R.note_pt, false, maxNoteLines) : [];
    const notesH = noteLines.length ? 3 + noteLines.length * noteLh : 0;
    const capLast = Math.max(1, Math.floor((avail - notesH) / R.row_mm + 1e-9));
    const bands = [];
    let first = 0;
    for (;;) {
      if (r.rows.length - first <= capLast) { bands.push({ first, last: r.rows.length }); break; }
      bands.push({ first, last: first + cap });
      first += cap;
    }
    return { r, cols, tableW, headY, bands, noteLines, noteLh };
  }

  /** Public pagination plan. */
  function layout(doc) {
    const n = normalise(doc), p = plan(n);
    const iso = d => { const ms = Math.round(d * DAY); return new Date(ms).toISOString().slice(0, 19); };
    return { page_w_mm: p.W, page_h_mm: p.H, rows_per_page: p.rpp, row_height_mm: p.rowH, body_height_mm: p.bodyH,
      pages_tall: p.pagesTall, pages_wide: p.wide, page_count: p.pageCount, pages: p.pageCount,
      rows: n.rows.length, bands: p.bands.map(b => ({ first: b.first, last: b.last })),   // [first, last) per band
      fit_to_pages_tall: p.fitTall > 0 ? p.fitTall : null, fits: p.fits,
      cover: !!n.cover, cover_pages: p.coverPages,
      report_pages: p.reportPages, chart_pages: p.chartPages, gantt_pages: p.ganttPages,
      reports: n.reports.length, charts: n.charts.length, reports_only: p.reportsOnly, currency: n.meta.currency,
      table_width_mm: p.tableW, chart_width_mm: p.chartW, title_block_mm: p.tbH, title_layout: p.titleLayout,
      logo: !!n.logo,
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
    const { first, last } = P.bands[g];                // rows [first, last) on this page
    const rowTop = i => P.bodyY + (i - first) * rowH;
    const mono = n.options.colour === false;
    // text scales with the row; fit_to_pages_tall keeps it readable (6 pt floor) as rows shrink
    const fontPt = P.fitTall > 0 ? Math.max(6, Math.min(7, rowH * MM * 0.5)) : Math.min(7, rowH * MM * 0.5);
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
    // date-range shading bands: a pale wash of the band colour with its label at the top (grey in black and white)
    for (const b of n.shading) {
      const a = Math.max(b.a, s0), z = Math.min(b.z, s1); if (z <= a) continue;
      const [r, g, bl] = rgb(n.options.colour === false ? grey(b.colour) : b.colour); const wash = '#' + [r, g, bl].map(v => hex2(v + (1 - v) * 0.72)).join('');
      cv.rect(X(a), P.bodyY, (z - a) * dw, P.bodyH, wash);
      if (b.label && b.a >= s0) cv.text(b.label, X(a) + 0.8, P.bodyY + 2.6, 5.5, true, C.text, 'left', Math.max(34, (z - a) * dw - 1.6));   // a narrow band's label may run past it
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
      // a row colour (chart coloured by code / resource) replaces the critical / normal fills
      const own = r.colour ? tone(r.colour, mono) : null;
      const fillC = own || (crit ? C.crit : C.norm);
      const progC = own ? shade(own, 0.45) : (crit ? C.critProg : C.normProg);
      const edgeC = own ? shade(own, 0.3) : (crit ? C.critEdge : C.normEdge);
      if (r.kind === 'summary') {
        const t = gm.top, h = rowH * 0.2, tri = rowH * 0.22, w = Math.max(gm.xe - gm.xs, 0.4);
        const sc = own || C.summary;
        cv.rect(gm.xs, t, w, h, sc);
        const tw = Math.min(tri, w / 2);
        cv.polygon([[gm.xs, t + h], [gm.xs + tw, t + h], [gm.xs, t + h + tri]], sc);
        cv.polygon([[gm.xe, t + h], [gm.xe - tw, t + h], [gm.xe, t + h + tri]], sc);
      } else if (r.kind === 'milestone') {
        const x = gm.x, y = gm.yMid, hh = msHalf;
        const done = (+r.pct || 0) >= 100;
        cv.polygon([[x, y - hh], [x + hh, y], [x, y + hh], [x - hh, y]], done ? progC : fillC, C.msEdge, 0.12);
      } else {
        const w = gm.xe - gm.xs;
        cv.rect(gm.xs, gm.top, w, barH, fillC, edgeC, 0.1);
        const pct = Math.max(0, Math.min(100, +r.pct || 0));
        if (pct > 0) {
          cv.rect(gm.xs, gm.top, w * pct / 100, barH, progC);
          cv.rect(gm.xs, gm.top, w, barH, null, edgeC, 0.1);
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
    // period lines (closed progress periods): dashed, one muted colour each, labelled at the top
    const periodCols = mono ? PERIOD_MONO : PERIOD_COLOUR;
    n.period_lines.forEach((pl, k) => {
      const d = dispIso(pl.date);
      if (d === null || d < s0 || d > s1) return;
      const xd = X(d), col = pl.colour ? tone(pl.colour, mono) : periodCols[k % periodCols.length];
      const pts = [[xd, P.bodyY]];
      for (const p of pl.points) {
        if (!(p.row >= first && p.row < last)) continue;
        const px = dispIso(p.x_date);
        if (px === null) continue;
        const x = X(px);
        if (Math.abs(x - xd) < 0.05) continue;
        const t = rowTop(p.row);
        pts.push([xd, t + rowH * 0.1], [x, t + rowH / 2], [xd, t + rowH * 0.9]);
      }
      pts.push([xd, P.bodyY + (last - first) * rowH]);
      cv.polyline(pts, col, 0.25, [1.2, 0.8]);
      if (pl.label && chartR - xd > 6) cv.text(pl.label, xd + 0.7, P.bodyY + 2.2, 5, false, col, 'left', chartR - xd - 1.2);
    });
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
    const mono = n.options.colour === false;
    const pt = 5.6;
    let top = y + 0.8;
    if (withLabel) { cv.text('LEGEND', x + 1.5, y + 3.0, 5, true, C.muted); top = y + 4.0; }
    const cols = perLine || Math.max(1, Math.ceil(items.length / Math.max(1, Math.floor((h - (top - y) - 0.5) / GEOMETRY.legend_line_mm))));
    const colW = (w - 3) / cols;
    items.forEach((it, i) => {
      const cx = x + 1.5 + (i % cols) * colW, cy = top + Math.floor(i / cols) * GEOMETRY.legend_line_mm;
      if (it.key === 'custom') { const c = tone(it.colour, mono); cv.rect(cx, cy + 0.4 + 2.6 * 0.2, 6, 2.6 * 0.6, c, shade(c, 0.3), 0.1); }
      else legendSwatch(cv, it.key, cx, cy + 0.4, 6, 2.6, C);
      cv.text(it.label, cx + 7.2, cy + 2.6, pt, false, C.text, 'left', colW - 8);
    });
  }

  /** The logo (if any) at the top-left of a cell: returns the width it takes including a gap, or
      0. `maxH` is the room available; the image keeps its aspect ratio. */
  function drawLogo(cv, n, x, y, maxW, maxH) {
    const L = n.logo;
    if (!L || maxW <= 2 || maxH <= 2) return 0;
    const k = Math.min(1, maxH / L.hmm, maxW / L.wmm);
    cv.image(x, y, L.wmm * k, L.hmm * k);
    return L.wmm * k + 2;
  }

  /** `band` is the row band shown (0-based), or null on the cover page. */
  function drawTitleBlock(cv, n, P, pageNo, band, sheet, C) {
    const x0 = P.m, W = P.usableW;
    let y0 = P.tbY;
    cv.rect(x0, y0, W, P.tbH, '#ffffff', C.frame, 0.45);
    const legendAbove = P.legendStrip > 0 && P.titleLayout !== 'wide';
    if (legendAbove) {
      drawLegend(cv, n, x0, y0, W, P.legendStrip, P.legendPerLine, C, false);
      y0 += P.legendStrip;
      cv.line(x0, y0, x0 + W, y0, C.frame, 0.3);
    }
    if (P.titleLayout === 'compact') drawInfoCompact(cv, n, P, pageNo, band, sheet, C, y0);
    else drawInfoStandard(cv, n, P, pageNo, band, sheet, C, y0);
    if (P.legendStrip > 0 && !legendAbove) {               // 'wide': the legend row under the info row
      y0 += P.infoH;
      cv.line(x0, y0, x0 + W, y0, C.frame, 0.3);
      drawLegend(cv, n, x0, y0, W, P.legendStrip, P.legendPerLine, C, false);
    }
  }

  /** The SHEET cell's second line: which rows / sheet this page shows ('' when there is one page).
      `band` is the row band index, null on the cover, or a ready-made note (report / chart pages). */
  function sheetNote(n, P, band, sheet) {
    if (typeof band === 'string') return band;
    if (band === null) return 'Briefing';
    if (P.wide > 1) return `Rows ${band + 1}/${P.pagesTall}  •  across ${sheet + 1}/${P.wide}`;
    if (P.pagesTall > 1) { const b = P.bands[band]; return `Rows ${b.first + 1}–${b.last} of ${n.rows.length}`; }
    return '';
  }

  /** 'compact': a single 8 mm line - project (with logo) and title, dates, issue, page. */
  function drawInfoCompact(cv, n, P, pageNo, band, sheet, C, y0) {
    const x0 = P.m, W = P.usableW, meta = n.meta, H = P.infoH;
    const narrow = W < 260;
    const wPage = narrow ? 20 : 30, wDates = narrow ? 56 : 82, wIssue = narrow ? 56 : 72;
    const cells = [['PROJECT', W - wPage - wDates - wIssue], ['DATES', wDates], ['ISSUE', wIssue], ['SHEET', wPage]];
    const by = y0 + H / 2 + 1.1;                            // one baseline for the strip
    const pt = narrow ? 5.5 : 6;
    let x = x0;
    const defs = {};
    for (const [name, w] of cells) { defs[name] = { x, w }; x += w; if (x < x0 + W - 0.01) cv.line(x, y0, x, y0 + H, C.frame, 0.25); }
    // a labelled cell of "part  •  part" items in display order; when short of room the items
    // with the highest drop rank go first, so the ones that remain print whole
    const labelled = (name, parts) => {
      const { x: cx, w } = defs[name];
      cv.text(name, cx + 1.5, by, 5, true, C.muted);
      const lw = textWidth(name, 5, true) + 1.5, avail = w - 3 - lw;
      const list = parts.filter(p => p[0]);
      while (list.length > 1 && textWidth(list.map(p => p[0]).join('  •  '), pt, false) > avail) {
        let k = 0;
        list.forEach((p, i) => { if (p[1] > list[k][1]) k = i; });
        list.splice(k, 1);
      }
      cv.text(list.map(p => p[0]).join('  •  ') || '—', cx + 1.5 + lw, by, pt, false, C.text, 'left', avail);
    };
    {
      const { x: cx, w } = defs.PROJECT;
      const off = drawLogo(cv, n, cx + 1.5, y0 + 1, (w - 3) * 0.5, H - 2);
      cv.text('PROJECT', cx + 1.5 + off, by, 5, true, C.muted);
      const lw = off + textWidth('PROJECT', 5, true) + 1.5;
      const nameEnc = encodeText(meta.project_name || ''), avail = w - 3 - lw;
      const nw = widthEnc(nameEnc, 7, true);
      if (meta.title && nw + 3 + 6 <= avail) {
        cv.textEnc(nameEnc, cx + 1.5 + lw, by, 7, true, C.text);
        cv.text('•  ' + meta.title, cx + 1.5 + lw + nw + 2, by, pt, false, C.muted, 'left', avail - nw - 2);
      } else cv.textEnc(fitEnc(nameEnc, avail, 7, true), cx + 1.5 + lw, by, 7, true, C.text);
    }
    const dated = (k, v) => (formatDate(v) ? k + ' ' + formatDate(v) : '');
    labelled('DATES', [[dated('Data date', meta.data_date), 0], [dated('Forecast', meta.forecast_finish), 2], [dated('Deadline', meta.deadline), 1]]);
    labelled('ISSUE', [[meta.revision ? 'Rev ' + meta.revision : '', 0], [meta.prepared_by || '', 1], [dated('Printed', meta.printed_at), 2]]);
    {
      const { x: cx, w } = defs.SHEET;
      const note = sheetNote(n, P, band, sheet);
      const pageTxt = `Page ${pageNo} of ${P.pageCount}`;
      if (note && !narrow && textWidth(pageTxt, 7, true) + 2 + textWidth(note, 5, false) <= w - 3) {
        cv.text(pageTxt, cx + 1.5, by, 7, true, C.text);
        cv.text(note, cx + w - 1.5, by, 5, false, C.muted, 'right');
      } else cv.text(pageTxt, cx + w / 2, by, 7, true, C.text, 'center', w - 2);
    }
  }

  /** 'standard' and 'wide': the info strip of labelled cells (the legend inline only when
      plan() put it there). */
  function drawInfoStandard(cv, n, P, pageNo, band, sheet, C, y0) {
    const x0 = P.m, W = P.usableW, meta = n.meta;
    const H = P.infoH;
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
    // project (the logo, when there is one, sits at the left and the text moves right of it)
    {
      const { x: cx, w } = defs.PROJECT;
      label('PROJECT', cx);
      const off = drawLogo(cv, n, cx + 1.5, y0 + 4.4, (w - 3) * 0.5, H - 5.6);
      const tx = cx + 1.5 + off, tw = w - 3 - off;
      const enc = encodeText(meta.project_name || '');
      if (narrow) {
        const pt = fitSize(enc, tw, 9.5, 7, 1);
        cv.textEnc(fitEnc(enc, tw, pt, true), tx, y0 + 7.2, pt, true, C.text);
        cv.text(meta.title || '', tx, y0 + 10.9, 7, true, C.muted, 'left', tw);
        if (meta.project_id) cv.text('Project ID: ' + meta.project_id, tx, y0 + 14.5, 6.3, false, C.text, 'left', tw);
        if (meta.client) cv.text('Client: ' + meta.client, tx, y0 + 17.9, 6.3, false, C.text, 'left', tw);
      } else {
        const pt = fitSize(enc, tw, 10, 7.5, 2);
        const lines = wrapEnc(enc, tw, pt, true, 2);
        const lh = pt / MM * 1.18;
        lines.forEach((l, i) => cv.textEnc(l, tx, y0 + 7.4 + i * lh, pt, true, C.text));
        if (meta.project_id) cv.text('Project ID: ' + meta.project_id, tx, y0 + H - 5.0, 6.5, false, C.text, 'left', tw);
        if (meta.client) cv.text('Client: ' + meta.client, tx, y0 + H - 1.8, 6.5, false, C.text, 'left', tw);
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
      const note = sheetNote(n, P, band, sheet);
      if (note) cv.text(note, cx + w / 2, y0 + 15, 5.4, false, C.muted, 'center', w - 2);
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
  // report pack: table pages and chart pages
  // ---------------------------------------------------------------------------------------
  /** Title and subtitle at the top of a report / chart page with a rule beneath; returns the y
      below them (headingHeight() tall), or `y` unchanged when there is neither. */
  function drawHeading(cv, x0, W, y, title, subtitle, C) {
    if (!title && !subtitle) return y;
    const R = REPORT;
    const base = (ty, pt, lh) => ty + (lh + 0.72 * pt / MM) / 2;
    if (title) { const lh = R.title_pt / MM * 1.25; cv.textEnc(fitEnc(encodeText(title), W, R.title_pt, true), x0, base(y, R.title_pt, lh), R.title_pt, true, C.text); y += lh; }
    if (subtitle) { const lh = R.sub_pt / MM * 1.4; cv.text(subtitle, x0, base(y, R.sub_pt, lh), R.sub_pt, false, C.muted, 'left', W); y += lh; }
    y += 1.6;
    cv.line(x0, y, x0 + W, y, C.frame, 0.3);
    return y + 3.2;
  }

  /** Band `k` of report plan `rp`: heading, column headers, the band's rows (zebra, section rows
      shaded and bold, indents and swatches in the first column), the notes on the last band. */
  function drawReportPage(cv, n, P, rp, k, pageNo, note) {
    const C = n.options.colour === false ? PALETTE_MONO : PALETTE_COLOUR, mono = n.options.colour === false;
    const R = REPORT, r = rp.r, x0 = P.m, W = P.usableW, tw = rp.tableW;
    const { first, last } = rp.bands[k];
    const parts = rp.bands.length;
    drawHeader(cv, n, P, C, parts > 1 ? `${r.title || 'Report'}  •  part ${k + 1} of ${parts}` : null);
    drawHeading(cv, x0, W, P.tsY, r.title ? r.title + (k ? ' (continued)' : '') : '', r.subtitle, C);
    const tableTop = rp.headY;
    // column headers (bottom aligned, up to two lines)
    cv.rect(x0, tableTop, tw, R.head_mm, C.headFill);
    const hlh = R.head_pt / MM * 1.2;
    for (const col of rp.cols) {
      const lines = wrapEnc(encodeText(col.label), Math.max(0, col.w - 2 * R.pad_mm), R.head_pt, true, 2);
      let ty = tableTop + R.head_mm - 1.6 - (lines.length - 1) * hlh;
      for (const l of lines) { cv.textEnc(l, col.align === 'right' ? col.x + col.w - R.pad_mm : col.x + R.pad_mm, ty, R.head_pt, true, C.text, col.align); ty += hlh; }
    }
    // rows
    let ry = tableTop + R.head_mm;
    for (let i = first; i < last; i++) {
      const row = r.rows[i];
      if (row.bold) cv.rect(x0, ry, tw, R.row_mm, C.sumRow);
      else if ((i - first) % 2) cv.rect(x0, ry, tw, R.row_mm, C.zebra);
      if (i > first) cv.line(x0, ry, x0 + tw, ry, C.rowLine, 0.1);
      const by = ry + R.row_mm / 2 + 0.718 * R.pt / MM / 2;
      rp.cols.forEach((col, ci) => {
        let lead = R.pad_mm;
        if (ci === 0) {
          lead += row.indent * R.indent_mm;
          if (row.colour) {
            const c = tone(row.colour, mono);
            cv.rect(col.x + lead, ry + (R.row_mm - R.swatch_mm) / 2, R.swatch_mm, R.swatch_mm, c, shade(c, 0.3), 0.1);
            lead += R.swatch_mm + 1;
          }
        }
        const avail = col.w - lead - R.pad_mm;
        if (avail <= 0) return;
        const enc = fitEnc(encodeText(reportCell(n, col, row)), avail, R.pt, row.bold);
        cv.textEnc(enc, col.align === 'right' ? col.x + col.w - R.pad_mm : col.x + lead, by, R.pt, row.bold, C.text, col.align);
      });
      ry += R.row_mm;
    }
    // frame, header rule, column dividers
    cv.rect(x0, tableTop, tw, ry - tableTop, null, C.frame, 0.3);
    cv.line(x0, tableTop + R.head_mm, x0 + tw, tableTop + R.head_mm, C.frame, 0.25);
    rp.cols.forEach((c, i) => { if (i) cv.line(c.x, tableTop, c.x, ry, C.gridMaj, 0.12); });
    if (k === parts - 1 && rp.noteLines.length) {
      let ny = ry + 3 + 0.718 * R.note_pt / MM;
      for (const l of rp.noteLines) { cv.textEnc(l, x0, ny, R.note_pt, false, C.muted); ny += rp.noteLh; }
    }
    drawTitleBlock(cv, n, P, pageNo, note, 0, C);
  }

  const CHART = { lab_pt: 6, legend_pt: 6.5, legend_lh: 4.2, swatch_mm: 7 };

  /** A round step (1, 2, 2.5, 5 x 10^k) that divides `range` into about `target` intervals. */
  function niceStep(range, target) {
    if (!(range > 0)) return 1;
    const raw = range / target, mag = Math.pow(10, Math.floor(Math.log10(raw))), norm = raw / mag;
    return (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag;
  }

  /** One chart page: heading, legend, axes with a y grid and month (or week) ticks, stacked bars
      per date, series polylines, the limit line and the data date; everything vector. */
  function drawChartPage(cv, n, P, ch, pageNo, note) {
    const C = n.options.colour === false ? PALETTE_MONO : PALETTE_COLOUR, mono = n.options.colour === false;
    const K = CHART, x0 = P.m, W = P.usableW, bottom = P.tbY - GEOMETRY.gap_mm;
    drawHeader(cv, n, P, C, null);
    let y = drawHeading(cv, x0, W, P.tsY, ch.title, ch.subtitle, C);
    // ---------- legend: one row, wrapping ----------
    const items = [];
    for (const s of ch.series) if (s.label) items.push({ kind: 'line', label: s.label, colour: tone(s.colour, mono) });
    for (const b of ch.bars) if (b.label) items.push({ kind: 'bar', label: b.label, colour: tone(b.colour, mono) });
    if (ch.limit) items.push({ kind: 'limit', label: ch.limit.label, colour: C.deadline });
    if (ch.data_date) items.push({ kind: 'dd', label: 'Data date ' + formatDate(ch.data_date), colour: C.dd });
    if (items.length) {
      let lx = x0;
      const lh = K.legend_lh, sw = K.swatch_mm;
      for (const it of items) {
        const w = sw + 2 + textWidth(it.label, K.legend_pt, false) + 6;
        if (lx + w > x0 + W && lx > x0) { lx = x0; y += lh; }
        const mid = y + lh / 2;
        if (it.kind === 'line') cv.line(lx, mid, lx + sw, mid, it.colour, 0.45);
        else if (it.kind === 'bar') cv.rect(lx, mid - 1.3, sw, 2.6, it.colour, shade(it.colour, 0.3), 0.1);
        else if (it.kind === 'limit') cv.line(lx, mid, lx + sw, mid, it.colour, 0.35, [2.4, 0.8, 0.5, 0.8]);
        else cv.line(lx + sw / 2, mid - 1.6, lx + sw / 2, mid + 1.6, it.colour, 0.35, [1.6, 1.0]);
        cv.text(it.label, lx + sw + 2, mid + 0.718 * K.legend_pt / MM / 2, K.legend_pt, false, C.text, 'left', x0 + W - lx - sw - 2);
        lx += w;
      }
      y += lh + 3;
    }
    // ---------- data extent ----------
    let xmin = Infinity, xmax = -Infinity, ymax = 0;
    for (const s of ch.series) for (const p of s.points) { xmin = Math.min(xmin, p.d); xmax = Math.max(xmax, p.d); ymax = Math.max(ymax, p.v); }
    const stacks = new Map();                                // day -> [value per bars series]
    ch.bars.forEach((b, bi) => {
      for (const p of b.points) {
        xmin = Math.min(xmin, p.d); xmax = Math.max(xmax, p.d);
        let st = stacks.get(p.d);
        if (!st) stacks.set(p.d, st = []);
        st[bi] = (st[bi] || 0) + p.v;
      }
    });
    for (const st of stacks.values()) ymax = Math.max(ymax, st.reduce((s, v) => s + Math.max(0, v || 0), 0));
    if (ch.limit) ymax = Math.max(ymax, ch.limit.value);
    const ddDay = ch.data_date ? msOf(ch.data_date) / DAY : null;
    if (ddDay !== null) { xmin = Math.min(xmin, ddDay); xmax = Math.max(xmax, ddDay); }
    if (!isFinite(xmin)) { xmin = n.d0; xmax = n.d1; }
    // the x range padded to whole months (or weeks), with a tick at each boundary
    const weeks = ch.x_labels === 'weeks';
    let a0, a1;
    if (weeks) { a0 = mondayOf(Math.floor(xmin)); a1 = mondayOf(Math.floor(xmax)) + 7; }
    else {
      const [y0, m0] = ymd(Math.floor(xmin)), [y1, m1] = ymd(Math.floor(xmax));
      a0 = dnOf(y0, m0, 1); a1 = dnOf(y1, m1 + 1, 1);
    }
    if (!(a1 > a0)) a1 = a0 + (weeks ? 7 : 28);
    const ticks = [];
    if (weeks) for (let d = a0; d <= a1; d += 7) { const [, mm, dd] = ymd(d); ticks.push({ d, labels: [dd + ' ' + MONTHS[mm]] }); }   // every k-th tick when narrow
    else for (let d = a0; d <= a1;) { const [yy, mm] = ymd(d); ticks.push({ d, labels: [MONTHS_LONG[mm] + ' ' + yy, MONTHS[mm] + ' ' + String(yy % 100).padStart(2, '0'), MONTHS[mm]] }); d = dnOf(yy, mm + 1, 1); }
    // y scale: 0 .. a round top, about five labelled steps
    if (!(ymax > 0)) ymax = 1;
    const step = niceStep(ymax, 5), yTop = Math.ceil(ymax / step - 1e-9) * step;
    const yLab = v => (ch.y_money ? money(v, n.meta.currency) : formatNumber(Math.round(v * 1000) / 1000));
    const yLabels = [];
    for (let i = 0; i * step <= yTop + step * 1e-9; i++) yLabels.push({ v: i * step, text: yLab(i * step) });
    const yLabW = Math.max(...yLabels.map(l => textWidth(l.text, K.lab_pt, false))) + 3;
    if (ch.y_label) { cv.text(ch.y_label, x0, y + 2.6, K.lab_pt, true, C.muted, 'left', W); y += 4.5; }
    // ---------- plot area ----------
    const px0 = x0 + yLabW, px1 = x0 + W - 2, py0 = y + 1.5, py1 = bottom - 7;
    const X = d => px0 + (d - a0) / (a1 - a0) * (px1 - px0);
    const Y = v => py1 - Math.max(0, Math.min(yTop, v)) / yTop * (py1 - py0);
    if (py1 - py0 > 15 && px1 - px0 > 20) {
      for (const l of yLabels) {
        const yy = Y(l.v);
        if (l.v > 0) cv.line(px0, yy, px1, yy, C.gridMin, 0.1);
        cv.text(l.text, px0 - 1.5, yy + 0.718 * K.lab_pt / MM / 2, K.lab_pt, false, C.muted, 'right');
      }
      ticks.forEach((t, i) => { if (i && i < ticks.length - 1) cv.line(X(t.d), py0, X(t.d), py1, C.gridMin, 0.1); });
      // x labels: months centred in their cell, weeks under their tick; when a label does not fit
      // its cell, every k-th cell is labelled with a shorter form
      const cells = weeks ? ticks.map(t => ({ c: X(t.d), room: ticks.length > 1 ? X(ticks[1].d) - X(ticks[0].d) : px1 - px0, labels: t.labels }))
        : ticks.slice(0, -1).map((t, i) => ({ c: (X(t.d) + X(ticks[i + 1].d)) / 2, room: X(ticks[i + 1].d) - X(t.d), labels: t.labels }));
      if (cells.length) {
        // one label form for every cell: the longest whose widest label fits a cell, else the
        // shortest form on every k-th cell
        const forms = cells[0].labels.length;
        const widest = f => Math.max(...cells.map(c => textWidth(c.labels[Math.min(f, c.labels.length - 1)], K.lab_pt, false)));
        let form = 0;
        while (form < forms - 1 && widest(form) > cells[0].room - 1.5) form++;
        const k = Math.max(1, Math.ceil((widest(form) + 1.5) / cells[0].room));
        cells.forEach((cell, i) => {
          if (i % k) return;
          cv.text(cell.labels[Math.min(form, cell.labels.length - 1)], cell.c, py1 + 3.4, K.lab_pt, false, C.muted, 'center', k * cell.room - 1.5);
        });
      }
      // bars (stacked per date), then series, then the limit line and data date, clipped to the plot
      cv.save();
      cv.clip(px0 - 0.1, py0 - 0.1, px1 - px0 + 0.2, py1 - py0 + 0.2);
      const days = Array.from(stacks.keys()).sort((a, b) => a - b);
      if (days.length) {
        let gap = Infinity;
        for (let i = 1; i < days.length; i++) gap = Math.min(gap, X(days[i]) - X(days[i - 1]));
        const barW = Math.max(0.4, Math.min(16, isFinite(gap) ? gap * 0.7 : (px1 - px0) * 0.1));
        for (const d of days) {
          let cum = 0;
          stacks.get(d).forEach((v, bi) => {
            if (!(v > 0)) return;
            const c = tone(ch.bars[bi].colour, mono);
            cv.rect(X(d) - barW / 2, Y(cum + v), barW, Y(cum) - Y(cum + v), c, shade(c, 0.3), 0.1);
            cum += v;
          });
        }
      }
      for (const s of ch.series) {
        if (!s.points.length) continue;
        const c = tone(s.colour, mono);
        const pts = s.points.map(p => [X(p.d), Y(p.v)]);
        if (pts.length > 1) cv.polyline(pts, c, 0.45);
        if (pts.length <= 60) for (const [x, yy] of pts) cv.circle(x, yy, 0.55, c);
      }
      if (ch.limit) {
        const ly = Y(ch.limit.value);
        cv.line(px0, ly, px1, ly, C.deadline, 0.35, [2.4, 0.8, 0.5, 0.8]);
        cv.text(ch.limit.label + '  ' + yLab(ch.limit.value), px1 - 1, ly - 1.2, 5.5, true, C.deadline, 'right', px1 - px0 - 2);
      }
      if (ddDay !== null && ddDay >= a0 && ddDay <= a1) {
        const xd = X(ddDay);
        cv.line(xd, py0, xd, py1, C.dd, 0.35, [1.6, 1.0]);
        const lab = 'Data date', lw = textWidth(lab, 5.5, true);
        if (xd + 1 + lw <= px1 - 1) cv.text(lab, xd + 1, py0 + 2.4, 5.5, true, C.dd);
        else cv.text(lab, xd - 1, py0 + 2.4, 5.5, true, C.dd, 'right');
      }
      cv.restore();
      // axes
      cv.line(px0, py1, px1, py1, C.frame, 0.3);
      cv.line(px0, py0, px0, py1, C.frame, 0.3);
    }
    drawTitleBlock(cv, n, P, pageNo, note, 0, C);
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

  /** `logo` (optional) is the parsed image every page may draw as /Im1. */
  function assemble(pages, W, H, info, logo) {
    const objs = [];                     // index i -> object i+1 body
    const add = body => { objs.push(body); return objs.length; };
    const catalog = add(null), pagesId = add(null);
    const f1 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
    const f2 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
    const infoId = add(`<< /Title (${pdfString(encodeText(info.title))}) /Subject (${pdfString(encodeText(info.subject))}) /Author (${pdfString(encodeText(info.author))}) /Producer (PlannerPDF) /Creator (Construction programme planner) /CreationDate (${info.date}) >>`);
    let xobj = '', procs = '/PDF /Text';
    if (logo) {
      const im = add(`<< /Type /XObject /Subtype /Image /Width ${logo.w} /Height ${logo.h} ${logo.dict} /Length ${logo.data.length} >>\nstream\n${logo.data}\nendstream`);
      xobj = ` /XObject << /Im1 ${im} 0 R >>`; procs += ' /ImageB /ImageC';
    }
    const kids = [];
    const mb = `[0 0 ${num(W * MM)} ${num(H * MM)}]`;
    for (const content of pages) {
      const cid = add(`<< /Length ${content.length} >>\nstream\n${content}endstream`);
      kids.push(add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox ${mb} /Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >>${xobj} /ProcSet [${procs}] >> /Contents ${cid} 0 R >>`));
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
    const emit = draw => { pageNo++; const cv = new Canvas(P.H); draw(cv, pageNo); pages.push(cv.toString()); };
    if (n.cover) emit((cv, no) => drawCover(cv, n, P, no));
    P.reports.forEach((rp, ri) => rp.bands.forEach((b, k) => {
      const note = `Report ${ri + 1}/${P.reports.length}` + (rp.bands.length > 1 ? `  •  part ${k + 1}/${rp.bands.length}` : '');
      emit((cv, no) => drawReportPage(cv, n, P, rp, k, no, note));
    }));
    n.charts.forEach((ch, ci) => emit((cv, no) => drawChartPage(cv, n, P, ch, no, `Chart ${ci + 1}/${n.charts.length}`)));
    if (P.ganttPages) {
      for (let g = 0; g < P.pagesTall; g++) {
        for (let c = 0; c < P.wide; c++) emit((cv, no) => drawPage(cv, n, P, g, c, no));
      }
    }
    const title = [n.meta.project_name, n.meta.title].filter(Boolean).join(' - ');
    return assemble(pages, P.W, P.H, { title, subject: n.meta.title || '', author: n.meta.prepared_by || '', date: pdfDate(n.meta.printed_at) }, n.logo);
  }

  root.PlannerPDF = { render, layout, money, formatNumber, formatDate, encodeText, textWidth, GEOMETRY };
})(typeof globalThis !== 'undefined' ? globalThis : this);

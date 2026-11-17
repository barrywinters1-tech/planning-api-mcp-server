/* PDF runner: builds a realistic programme with web/engine.js, maps it onto the
   PlannerPDF `doc` interface and renders it with web/pdf_export.js.

   stdin:  { cases: [{ out, brief?, copies?, max_rows?, page?, options?, meta? }] }
           out       path to write the PDF to
           copies    repeat the programme n times as Block A, Block B, ... (to make long programmes)
           max_rows  truncate the row list (links to dropped rows are dropped)
   stdout: JSON array, one entry per case:
           { out, bytes, rows, layout, row_names, month_label, doc_meta }

   Used by tests/test_pdf_export.py; also handy for rendering samples by hand. */
'use strict';
const fs = require('fs');
const path = require('path');
require(path.join(__dirname, '..', '..', 'web', 'engine.js'));
require(path.join(__dirname, '..', '..', 'web', 'pdf_export.js'));
const E = globalThis.PlannerEngine;
const PDF = globalThis.PlannerPDF;

const DEFAULT_BRIEF = 'Three storey office building with steel frame, start 6 April 2026, 18 months';
const DAY = 86400000;
const ms = s => { const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/.exec(s); return Date.UTC(+m[1], +m[2] - 1, +m[3], m[4] ? +m[4] : 0, m[5] ? +m[5] : 0); };
const isoDate = t => new Date(t).toISOString().slice(0, 10);
const mondayOnOrBefore = t => { const d = new Date(t); const dow = (d.getUTCDay() + 6) % 7; return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - dow); };

function buildProject(brief) {
  const b = E.parseBrief(brief);
  const d = E.generate(b);
  const p = E.draftToProject(d, b.source_text);
  E.schedule(p);
  E.setBaseline(p, 'Tender');
  const tenderFinish = ms(p.finish);
  // a slip against the baseline, and a contractual deadline three weeks after the tender finish
  const ids = new Set(p.activities.map(a => a.id));
  const slip = p.activities.find(a => a.type === 'task' && /frame/i.test(a.name)) || p.activities.find(a => a.type === 'task' && ids.has(a.id));
  const cmds = [];
  if (slip) cmds.push(`add 2 weeks to ${slip.id}`);
  const deadline = new Date(tenderFinish + 21 * DAY);
  cmds.push(`finish by ${deadline.getUTCDate()} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][deadline.getUTCMonth()]} ${deadline.getUTCFullYear()}`);
  for (const c of cmds) { E.applyPatch(p, E.parseCommand(p, c)); E.schedule(p); }
  return p;
}

function buildDoc(c) {
  const p = buildProject(c.brief || DEFAULT_BRIEF);
  const cal = id => p.calendars[id] || p.calendars[p.default_calendar_id] || { hours_per_day: 8 };
  const start = ms(p.activities.reduce((m, a) => (a.early_start < m ? a.early_start : m), p.activities[0].early_start));
  const dataDate = mondayOnOrBefore(start + 70 * DAY) + 8 * 3600000; // ten weeks in, 08:00
  const dd = new Date(dataDate).toISOString().slice(0, 19);

  // rows: one summary per WBS element, its activities beneath
  const wbs = (p.wbs || []).slice().sort((a, b) => a.seq - b.seq);
  const byWbs = new Map(wbs.map(w => [w.id, []]));
  for (const a of p.activities) { if (!byWbs.has(a.wbs_id)) byWbs.set(a.wbs_id, []); byWbs.get(a.wbs_id).push(a); }
  const wbsName = new Map(wbs.map(w => [w.id, w]));
  const block = [];   // [{ row, actId }]
  let n = 0;
  for (const [wid, acts] of byWbs) {
    if (!acts.length) continue;
    const s = acts.reduce((m, a) => (a.early_start < m ? a.early_start : m), acts[0].early_start);
    const f = acts.reduce((m, a) => (a.early_finish > m ? a.early_finish : m), acts[0].early_finish);
    const bs = acts.every(a => a.baseline_start) ? acts.reduce((m, a) => (a.baseline_start < m ? a.baseline_start : m), acts[0].baseline_start) : null;
    const bf = acts.every(a => a.baseline_finish) ? acts.reduce((m, a) => (a.baseline_finish > m ? a.baseline_finish : m), acts[0].baseline_finish) : null;
    const w = wbsName.get(wid) || { code: wid, name: wid };
    const spanDays = Math.round((ms(f) - ms(s)) / DAY);
    block.push({ row: { kind: 'summary', depth: 0, cells: [w.code, w.name, spanDays + 'd', PDF.formatDate(s), PDF.formatDate(f), ''],
      start: s, finish: f, critical: acts.some(a => a.critical), pct: 0, baseline_start: bs, baseline_finish: bf, late_finish: null, label: '' } });
    for (const a of acts) {
      const ms_ = a.type === 'start_milestone' || a.type === 'finish_milestone';
      const hpd = cal(a.calendar_id).hours_per_day || 8;
      const s0 = ms(a.early_start), f0 = ms(a.early_finish);
      // progress as at the data date: complete before it, part-way across it (every third one behind)
      let pct = 0;
      if (f0 <= dataDate) pct = 100;
      else if (s0 < dataDate) { pct = Math.round(100 * (dataDate - s0) / (f0 - s0)); if (n++ % 3 === 0) pct = Math.max(5, pct - 25); pct = Math.min(95, Math.max(5, pct)); }
      const trade = a.codes && a.codes.Trade && a.codes.Trade !== 'None' ? a.codes.Trade : '';
      block.push({ actId: a.id, row: {
        kind: ms_ ? 'milestone' : 'task', depth: 1,
        cells: [a.id, a.name, ms_ ? '0d' : +(a.duration_hours / hpd).toFixed(1) + 'd', PDF.formatDate(a.early_start), PDF.formatDate(a.early_finish), +(a.total_float_hours / hpd).toFixed(1) + 'd'],
        start: a.early_start, finish: a.early_finish, critical: !!a.critical, pct,
        baseline_start: a.baseline_start, baseline_finish: a.baseline_finish, late_finish: a.late_finish,
        label: ms_ ? PDF.formatDate(a.early_start) : trade } });
    }
  }
  const crit = new Map(p.activities.map(a => [a.id, !!a.critical]));

  // optional copies (Block A, Block B, ...) to make a long programme
  const copies = Math.max(1, c.copies || 1);
  const rows = [], links = [];
  for (let k = 0; k < copies; k++) {
    const idx = new Map();
    const suffix = copies > 1 ? ` (Block ${String.fromCharCode(65 + k)})` : '';
    for (const it of block) {
      const r = JSON.parse(JSON.stringify(it.row));
      if (copies > 1) { r.cells[0] = (k ? String.fromCharCode(65 + k) + '-' : '') + r.cells[0]; r.cells[1] += suffix; }
      if (it.actId) idx.set(it.actId, rows.length);
      rows.push(r);
    }
    for (const rel of p.relationships) {
      if (!idx.has(rel.predecessor_id) || !idx.has(rel.successor_id)) continue;
      links.push({ from: idx.get(rel.predecessor_id), to: idx.get(rel.successor_id), type: rel.type,
        critical: crit.get(rel.predecessor_id) && crit.get(rel.successor_id) && rel.driving !== false });
    }
  }
  let outRows = rows, outLinks = links;
  if (c.max_rows && c.max_rows < rows.length) {
    outRows = rows.slice(0, c.max_rows);
    outLinks = links.filter(l => l.from < c.max_rows && l.to < c.max_rows);
  }

  const finish = ms(p.finish);
  const deadline = p.must_finish_by;
  const t1 = Math.max(finish, deadline ? ms(deadline) : 0) + 14 * DAY;
  const rowOf = re => outRows.findIndex(r => r.kind !== 'summary' && re.test(r.cells[1]));
  const steelRow = rowOf(/steel frame/i), roofRow = rowOf(/roof/i);
  const annotations = [{ date: '2026-12-21', row: null, text: 'Christmas shutdown 24 Dec – 4 Jan' }];
  if (steelRow >= 0) annotations.push({ date: outRows[steelRow].start, row: steelRow, text: 'Steel delivery confirmed by fabricator ‘subject to mill certs’' });
  if (roofRow >= 0) annotations.push({ date: outRows[roofRow].finish, row: roofRow, text: 'Weather-tight target' });

  const doc = {
    meta: Object.assign({
      project_name: 'Riverside Café & Offices — £2.4m Phase 2',
      project_id: p.id, client: 'Northgate Développements Ltd', revision: 'C03', prepared_by: 'J. Okafor (Planning)',
      title: 'Construction programme', data_date: dd, forecast_finish: p.finish, deadline: deadline || null,
      printed_at: '2026-11-17T09:30:00', notes: 'Programme issued for information. Durations in working days on a 5-day calendar with UK bank holidays. Read with the method statement and logistics plan.'
    }, c.meta || {}),
    page: Object.assign({ size: 'A3', orientation: 'landscape', margins_mm: 10 }, c.page || {}),
    columns: [
      { title: 'ID', width_mm: 15, align: 'left' },
      { title: 'Activity name', width_mm: 68, align: 'left', indent: true },
      { title: 'Dur', width_mm: 10, align: 'right' },
      { title: 'Start', width_mm: 15, align: 'right' },
      { title: 'Finish', width_mm: 15, align: 'right' },
      { title: 'Total float', width_mm: 11, align: 'right' }
    ],
    rows: outRows, links: outLinks,
    range: { t0: isoDate(mondayOnOrBefore(start) - 7 * DAY), t1: isoDate(t1) },
    annotations,
    options: Object.assign({ show_links: true, show_float: true, show_baseline: true, show_progress_line: false,
      legend: true, rows_per_page: null, fit_to_pages_wide: 1, colour: true }, c.options || {})
  };
  return doc;
}

function run(c) {
  try {
    const doc = buildDoc(c);
    const bytes = PDF.render(doc);
    if (c.out) fs.writeFileSync(c.out, bytes);
    if (c.doc_out) fs.writeFileSync(c.doc_out, JSON.stringify(doc, null, 1));
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const s = new Date(Date.parse(doc.range.t0 + 'T00:00:00Z') + 28 * DAY);
    return { out: c.out, bytes: bytes.length, rows: doc.rows.length, links: doc.links.length, layout: PDF.layout(doc),
      row_names: doc.rows.map(r => r.cells[1]), row_ids: doc.rows.map(r => r.cells[0]), row_kinds: doc.rows.map(r => r.kind),
      month_label: months[s.getUTCMonth()] + ' ' + s.getUTCFullYear(), doc_meta: doc.meta, range: doc.range };
  } catch (e) { return { error: String((e && e.stack) || e) }; }
}

const input = JSON.parse(fs.readFileSync(0, 'utf8'));
process.stdout.write(JSON.stringify(input.cases.map(run)));

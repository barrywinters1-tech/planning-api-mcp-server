/* Planner UI: spreadsheet + Gantt, pure client logic over the JSON project model. */
'use strict';
const $ = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const pad = n => String(n).padStart(2, '0');
const iso = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:00`;
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const fmtD = s => s ? new Date(s).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : '';
const DAY = 864e5;
const RH = 26, HDR = 44, GX = 20;

const S = {
  pid: null, project: null, report: null, history: { undo: 0, redo: 0 },
  sel: new Set(), active: null, activeCol: 'name', collapsed: new Set(), selLink: null,
  view: { mode: 'gantt', tlSource: 'WBS', pxDay: 8, links: true, float: true, baseline: false, progress: false, critical: false, colour: 'critical', group: '', sort: '', filter: '' },
  cols: ['id', 'name', 'dur', 'start', 'finish', 'tf', 'preds', 'pct'],
  panel: null, histRes: '', hist: null, costs: null, editing: null, drag: null, rowsCache: [],
};
const ALL_COLS = {
  id: { t: 'ID', w: 68, get: a => a.id },
  name: { t: 'Activity', w: 260, get: a => a.name, set: (a, v) => { a.name = v; } },
  dur: { t: 'Dur', w: 52, num: 1, get: a => a.type === 'task' ? fmt1(daysOf(a, a.duration_hours)) + 'd' : '◆', set: (a, v) => { if (a.type !== 'task') return; a.duration_hours = parseDays(v) * hpd(a); if (a.status === 'in_progress') a.remaining_hours = a.duration_hours * (1 - a.percent_complete / 100); } },
  start: { t: 'Start', w: 78, get: a => fmtD(a.actual_start || a.early_start), set: (a, v) => { const d = parseDateInput(v); if (!d) return; if (a.status !== 'not_started') { a.actual_start = iso(d); return; } a.constraint = 'start_on_or_after'; d.setHours(8, 0, 0, 0); a.constraint_date = iso(d); } },
  finish: { t: 'Finish', w: 78, get: a => fmtD(a.actual_finish || a.early_finish), set: (a, v) => { const d = parseDateInput(v); if (!d) return; if (a.status === 'complete') { a.actual_finish = iso(d); return; } const s = new Date(a.actual_start || a.early_start); const wd = workingDaysBetween(calOf(a), s, d); if (a.type === 'task' && wd > 0) a.duration_hours = wd * hpd(a); } },
  tf: { t: 'TF', w: 48, num: 1, get: a => a.total_float_hours == null ? '' : fmt1(daysOf(a, a.total_float_hours)) + 'd', cls: a => a.total_float_hours < 0 ? 'crit' : '' },
  ff: { t: 'FF', w: 48, num: 1, get: a => a.free_float_hours == null ? '' : fmt1(daysOf(a, a.free_float_hours)) + 'd' },
  preds: { t: 'Predecessors', w: 150, get: a => predsText(a), set: (a, v) => setPreds(a, v) },
  succs: { t: 'Successors', w: 150, get: a => succsText(a) },
  pct: { t: '%', w: 42, num: 1, get: a => a.status === 'not_started' ? '' : Math.round(a.percent_complete) + '%', set: (a, v) => setProgress(a, parseFloat(v) || 0) },
  cal: { t: 'Calendar', w: 100, get: a => (S.project.calendars[a.calendar_id || S.project.default_calendar_id] || {}).name || '', options: () => Object.values(S.project.calendars).map(c => [c.id, c.name]), setOpt: (a, v) => { const old = hpd(a); a.calendar_id = v; a.duration_hours = a.duration_hours / old * hpd(a); } },
  constraint: { t: 'Constraint', w: 150, get: a => a.constraint === 'none' ? '' : a.constraint.replaceAll('_', ' ') + ' ' + fmtD(a.constraint_date) },
  astart: { t: 'Actual start', w: 78, get: a => fmtD(a.actual_start), set: (a, v) => { const d = parseDateInput(v); a.actual_start = d ? iso(d) : null; if (d && a.status === 'not_started') { a.status = 'in_progress'; a.remaining_hours = a.duration_hours; } } },
  afinish: { t: 'Actual finish', w: 78, get: a => fmtD(a.actual_finish), set: (a, v) => { const d = parseDateInput(v); a.actual_finish = d ? iso(d) : null; if (d) { a.status = 'complete'; a.percent_complete = 100; a.remaining_hours = 0; if (!a.actual_start) a.actual_start = a.early_start; } } },
  bstart: { t: 'BL start', w: 78, get: a => fmtD(a.baseline_start) },
  bfinish: { t: 'BL finish', w: 78, get: a => fmtD(a.baseline_finish) },
  var: { t: 'Var', w: 48, num: 1, get: a => { if (!a.baseline_finish) return ''; const f = new Date(a.actual_finish || a.early_finish), b = new Date(a.baseline_finish); const d = workingDaysBetween(calOf(a), b, f); return (d > 0 ? '+' : '') + fmt1(d) + 'd'; }, cls: a => { if (!a.baseline_finish) return ''; return new Date(a.actual_finish || a.early_finish) > new Date(a.baseline_finish) ? 'crit' : ''; } },
  res: { t: 'Resources', w: 140, get: a => S.project.assignments.filter(x => x.activity_id === a.id).map(x => (S.project.resources.find(r => r.id === x.resource_id) || { name: x.resource_id }).name).join(', '), set: (a, v) => setResources(a, v) },
  ls: { t: 'Late start', w: 78, get: a => fmtD(a.late_start) },
  lf: { t: 'Late finish', w: 78, get: a => fmtD(a.late_finish) },
  notes: { t: 'Notes', w: 200, get: a => a.notes || '', set: (a, v) => { a.notes = v; } },
  priority: { t: 'Prio', w: 46, num: 1, get: a => a.priority, set: (a, v) => { a.priority = parseInt(v) || 500; } },
  delay: { t: 'Lvl delay', w: 60, num: 1, get: a => a.level_delay_hours ? fmt1(daysOf(a, a.level_delay_hours)) + 'd' : '' },
};
const fmt1 = n => Math.round(n * 10) / 10;
const parseDays = v => { const m = String(v).match(/(-?\d+(?:\.\d+)?)\s*(w|h)?/i); if (!m) return 0; const n = parseFloat(m[1]); return m[2] ? (m[2].toLowerCase() === 'w' ? n * 5 : n / 8) : n; };
function parseDateInput(v) {
  v = String(v).trim(); if (!v) return null;
  let m = v.match(/^(\d{4})-(\d{2})-(\d{2})/); if (m) return new Date(+m[1], +m[2] - 1, +m[3], 8);
  m = v.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})$/); if (m) return new Date(+m[3] + (m[3].length === 2 ? 2000 : 0), +m[2] - 1, +m[1], 8);
  const d = new Date(v); return isNaN(d) ? null : d;
}
// ---------- calendars on the client ----------
const calOf = a => S.project.calendars[a.calendar_id || S.project.default_calendar_id] || { hours_per_day: 8, working_days: [0, 1, 2, 3, 4], exceptions: {} };
const hpd = a => calOf(a).hours_per_day || 8;
const daysOf = (a, h) => h / hpd(a);
function isWorking(cal, d) { const k = ymd(d); if (k in cal.exceptions) return cal.exceptions[k] > 0; return cal.working_days.includes((d.getDay() + 6) % 7); }
function nextWorking(cal, d) { d = new Date(d); for (let i = 0; i < 400; i++) { if (isWorking(cal, d)) return d; d.setDate(d.getDate() + 1); } return d; }
function workingDaysBetween(cal, a, b) { // signed, whole days, finish inclusive
  const sign = b < a ? -1 : 1; let [x, y] = sign > 0 ? [a, b] : [b, a]; let n = 0; const d = new Date(x); d.setHours(0, 0, 0, 0); const end = new Date(y); end.setHours(0, 0, 0, 0);
  while (d < end) { d.setDate(d.getDate() + 1); if (isWorking(cal, d)) n++; }
  return sign * n;
}
const byId = id => S.project.activities.find(a => a.id === id);
const wbsById = id => S.project.wbs.find(w => w.id === id);
function predsText(a) { return S.project.relationships.filter(r => r.successor_id === a.id).map(r => r.predecessor_id + (r.type === 'FS' ? '' : r.type) + (r.lag_hours ? (r.lag_hours > 0 ? '+' : '') + fmt1(daysOf(a, r.lag_hours)) + 'd' : '')).join(', '); }
function succsText(a) { return S.project.relationships.filter(r => r.predecessor_id === a.id).map(r => r.successor_id + (r.type === 'FS' ? '' : r.type)).join(', '); }
function setPreds(a, text) {
  const p = S.project; p.relationships = p.relationships.filter(r => r.successor_id !== a.id);
  text.split(/[,;]/).map(s => s.trim()).filter(Boolean).forEach(tok => {
    const m = tok.match(/^([A-Za-z0-9_.-]+?)(FS|SS|FF|SF)?([+-]\d+(?:\.\d+)?)?d?$/i); if (!m) return;
    const pred = p.activities.find(q => q.id.toLowerCase() === m[1].toLowerCase()); if (!pred || pred.id === a.id) return;
    p.relationships.push({ predecessor_id: pred.id, successor_id: a.id, type: (m[2] || 'FS').toUpperCase(), lag_hours: (+(m[3] || 0)) * hpd(pred) });
  });
}
function setResources(a, text) {
  const p = S.project; p.assignments = p.assignments.filter(x => x.activity_id !== a.id);
  text.split(/[,;]/).map(s => s.trim()).filter(Boolean).forEach(name => {
    let r = p.resources.find(x => x.name.toLowerCase() === name.toLowerCase() || x.id.toLowerCase() === name.toLowerCase());
    if (!r) { r = { id: name.replace(/[^A-Za-z0-9]+/g, '_').toUpperCase().slice(0, 20), name, type: 'labour', unit: 'h', rate: 0, max_units_per_day: null, colour: null }; p.resources.push(r); }
    p.assignments.push({ activity_id: a.id, resource_id: r.id, units: a.duration_hours, cost: 0, actual_cost: 0 });
  });
}
function setProgress(a, pct, asOf) {
  pct = Math.max(0, Math.min(100, pct));
  if (pct >= 100) { a.status = 'complete'; a.percent_complete = 100; a.remaining_hours = 0; if (!a.actual_start) a.actual_start = a.early_start; if (!a.actual_finish) a.actual_finish = asOf ? iso(asOf) : (S.project.data_date || a.early_finish); }
  else if (pct > 0) { a.status = 'in_progress'; a.percent_complete = pct; a.remaining_hours = a.duration_hours * (1 - pct / 100); if (!a.actual_start) a.actual_start = a.early_start; a.actual_finish = null; }
  else { a.status = 'not_started'; a.percent_complete = 0; a.remaining_hours = null; a.actual_start = a.actual_finish = null; }
}

// ---------- api ----------
async function api(path, opts = {}) { const r = await fetch(path, opts); if (!r.ok) { let m = r.statusText; try { m = (await r.json()).detail || m; } catch { } throw new Error(m); } return r.json(); }
const post = (path, body) => api(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
function toast(msg, ms = 2600) { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(t._t); t._t = setTimeout(() => t.hidden = true, ms); }
async function loadList() {
  const list = await api('/api/projects'); const sel = $('#projSel');
  sel.innerHTML = '<option value="">— open —</option>' + list.map(p => `<option value="${esc(p.id)}">${esc(p.name)} (${p.activities})</option>`).join('');
  sel.value = S.pid || '';
}
async function openProject(pid) { if (!pid) return; show(await api('/api/projects/' + encodeURIComponent(pid))); }
function show(v) {
  if (!v || !v.project) return;
  S.project = v.project; S.report = v.report; S.pid = v.project.id; S.history = v.history || S.history; S.extra = v;
  $('#projSel').value = S.pid; try { localStorage.setItem('pid', S.pid); } catch { }
  if (v.message) toast(v.message + (v.still_open && v.still_open.length ? ' Left open: ' + v.still_open[0] : ''), 5000);
  S.sel = new Set([...S.sel].filter(id => byId(id) || wbsById(id)));
  render();
  if (S.panel === 'histogram' || S.panel === 'cost') refreshPanel();
}
async function save(label) {
  try { const v = await api('/api/projects/' + encodeURIComponent(S.pid), { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ project: S.project }) }); show(v); if (label) toast(label, 1500); }
  catch (e) { toast('Not saved: ' + e.message, 5000); await openProject(S.pid); }
}
function mutate(fn, label) { if (!S.project) return; const r = fn(S.project); if (r === false) return; save(label); }
async function act(path, body, method = 'POST') { try { show(await api('/api/projects/' + encodeURIComponent(S.pid) + path, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })); } catch (e) { toast(e.message, 4000); } }

// ---------- rows ----------
function rows() {
  const p = S.project, out = [], f = S.view.filter.trim().toLowerCase();
  let codeF = null; const m = f.match(/^([a-z ]+)\s*[=:]\s*(.+)$/); if (m) codeF = [m[1].trim(), m[2].trim()];
  const pass = a => {
    if (S.view.critical && !a.critical) return false;
    if (codeF) return Object.entries(a.codes || {}).some(([k, v]) => k.toLowerCase() === codeF[0] && v.toLowerCase().includes(codeF[1]));
    if (f) return a.name.toLowerCase().includes(f) || a.id.toLowerCase().includes(f);
    return true;
  };
  const sortFn = { start: (a, b) => (a.early_start || '').localeCompare(b.early_start || ''), finish: (a, b) => (a.early_finish || '').localeCompare(b.early_finish || ''), float: (a, b) => (a.total_float_hours ?? 1e9) - (b.total_float_hours ?? 1e9), id: (a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }), name: (a, b) => a.name.localeCompare(b.name) }[S.view.sort];
  const order = list => sortFn ? [...list].sort(sortFn) : list;
  if (S.view.group) {
    const g = S.view.group; const groups = {};
    p.activities.filter(pass).forEach(a => { const k = (a.codes || {})[g] || '(none)'; (groups[k] = groups[k] || []).push(a); });
    Object.keys(groups).sort().forEach(k => {
      const acts = groups[k];
      out.push({ group: k, depth: 0, start: acts.map(a => a.actual_start || a.early_start).filter(Boolean).sort()[0], finish: acts.map(a => a.actual_finish || a.early_finish).filter(Boolean).sort().slice(-1)[0], colour: ((p.code_types[g] || {})[k]) });
      if (!S.collapsed.has('G:' + k)) order(acts).forEach(a => out.push({ act: a, depth: 1 }));
    });
    return out;
  }
  const byW = {}; p.activities.forEach(a => (byW[a.wbs_id && wbsById(a.wbs_id) ? a.wbs_id : ''] = byW[a.wbs_id && wbsById(a.wbs_id) ? a.wbs_id : ''] || []).push(a));
  const kids = {}; p.wbs.forEach(w => (kids[w.parent_id && wbsById(w.parent_id) ? w.parent_id : ''] = kids[w.parent_id && wbsById(w.parent_id) ? w.parent_id : ''] || []).push(w));
  const collect = wid => { const acc = [...(byW[wid] || [])]; (kids[wid] || []).forEach(k => acc.push(...collect(k.id))); return acc; };
  const walk = (parent, depth) => {
    (kids[parent] || []).sort((a, b) => a.seq - b.seq).forEach(w => {
      const acts = collect(w.id).filter(pass);
      if ((f || S.view.critical) && !acts.length) return;
      const s = acts.map(a => a.actual_start || a.early_start).filter(Boolean).sort()[0];
      const fi = acts.map(a => a.actual_finish || a.early_finish).filter(Boolean).sort().slice(-1)[0];
      out.push({ wbs: w, depth, start: s, finish: fi, n: acts.length, crit: acts.some(a => a.critical), pct: acts.length ? acts.reduce((t, a) => t + a.duration_hours * (a.status === 'complete' ? 100 : a.percent_complete), 0) / Math.max(1, acts.reduce((t, a) => t + a.duration_hours, 0)) : 0 });
      if (S.collapsed.has(w.id)) return;
      order((byW[w.id] || []).filter(pass)).forEach(a => out.push({ act: a, depth: depth + 1 }));
      walk(w.id, depth + 1);
    });
  };
  walk('', 0);
  order((byW[''] || []).filter(pass)).forEach(a => out.push({ act: a, depth: 0 }));
  return out;
}
const rowKey = r => r.act ? r.act.id : r.wbs ? r.wbs.id : 'G:' + r.group;

// ---------- render ----------
function gridWidth() { return S.cols.reduce((t, k) => t + ALL_COLS[k].w, 0) + 1; }
function timeRange() {
  const p = S.project;
  const ds = p.activities.flatMap(a => [a.actual_start || a.early_start, a.actual_finish || a.early_finish, S.view.float ? a.late_finish : null, S.view.baseline ? a.baseline_start : null, S.view.baseline ? a.baseline_finish : null]).filter(Boolean).map(d => new Date(d));
  ds.push(new Date(p.start)); if (p.must_finish_by) ds.push(new Date(p.must_finish_by));
  let t0 = new Date(Math.min(...ds)), t1 = new Date(Math.max(...ds));
  t0 = new Date(t0.getFullYear(), t0.getMonth(), t0.getDate() - ((t0.getDay() + 6) % 7) - 7);
  t1 = new Date(t1.getFullYear(), t1.getMonth(), t1.getDate() + 21);
  return [t0, t1];
}
function render() {
  const p = S.project; if (!p) return;
  renderSummary(); renderToolbarState();
  const rs = rows(); S.rowsCache = rs;
  const gw = gridWidth();
  const [t0, t1] = timeRange(); S.t0 = t0;
  const px = S.view.pxDay; const W = Math.ceil((t1 - t0) / DAY * px) + 40; S.ganttW = W;
  const x = d => GX + (new Date(d) - t0) / DAY * px; S.x = x;
  // header
  $('#hdr').innerHTML = `<div class="hdr-grid" style="width:${gw}px">` + S.cols.map(k => `<div class="c ${S.view.sort === k ? 'sorted' : ''}" style="width:${ALL_COLS[k].w}px" data-col="${k}">${ALL_COLS[k].t}</div>`).join('') + `</div><div class="hdr-time" style="width:${W}px">${timescale(t0, t1, W)}</div>`;
  $$('#hdr .c[data-col]').forEach(el => { const h = document.createElement('span'); h.className = 'colgrip'; el.appendChild(h); h.onmousedown = e => { e.stopPropagation(); e.preventDefault(); const k = el.dataset.col, x0 = e.clientX, w0 = ALL_COLS[k].w; const mv = ev => { ALL_COLS[k].w = Math.max(30, w0 + ev.clientX - x0); el.style.width = ALL_COLS[k].w + 'px'; }; const up = () => { document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up); try { localStorage.setItem('colw', JSON.stringify(Object.fromEntries(Object.entries(ALL_COLS).map(([k, c]) => [k, c.w])))); } catch { } render(); }; document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up); }; });
  $$('#hdr .c[data-col]').forEach(el => el.onclick = () => { const k = el.dataset.col; S.view.sort = S.view.sort === k ? '' : (['start', 'finish', 'tf', 'id', 'name'].includes(k) ? (k === 'tf' ? 'float' : k) : S.view.sort); $('#vSort').value = S.view.sort; render(); });
  // rows
  const bandH = 0;
  const html = [];
  if (S.view.mode === 'tl') { renderTimeLocation(gw, W, t0, t1); return; }
  rs.forEach((r, i) => {
    const key = rowKey(r), sel = S.sel.has(key);
    let cells;
    if (r.act) {
      const a = r.act;
      cells = S.cols.map((k, ci) => {
        const c = ALL_COLS[k]; let v = esc(c.get(a));
        if (ci === 0 || (ci === 1 && k === 'name')) { const indent = k === 'name' ? r.depth * 14 : 0; v = `<span style="display:inline-block;width:${indent}px"></span>` + (k === 'name' && colourOf(a) ? `<span class="swatch" style="background:${colourOf(a)}"></span>` : '') + v; }
        const cls = ['c', c.num ? 'num' : '', c.cls ? c.cls(a) : '', (a.critical && k === 'name') ? 'crit' : '', (S.active === key && S.activeCol === k) ? 'active' : ''].join(' ');
        return `<div class="${cls}" style="width:${c.w}px" data-col="${k}" title="${v.replace(/<[^>]+>/g, '')}">${v}</div>`;
      }).join('');
      html.push(`<div class="row ${sel ? 'sel' : ''}" data-key="${esc(key)}" data-i="${i}"><div class="cells" style="width:${gw}px">${cells}</div></div>`);
    } else {
      const name = r.wbs ? r.wbs.name : r.group; const id = r.wbs ? (r.wbs.code || '') : '';
      const collapsed = S.collapsed.has(key);
      cells = S.cols.map((k, ci) => {
        let v = '';
        if (k === 'id') v = esc(id);
        else if (k === 'name') v = `<span style="display:inline-block;width:${r.depth * 14}px"></span><span class="tw" data-tw="${esc(key)}">${collapsed ? '▸' : '▾'}</span>${r.colour ? `<span class="swatch" style="background:${r.colour}"></span>` : ''}${esc(name)}${r.n != null ? ` <span class="hint">(${r.n})</span>` : ''}`;
        else if (k === 'start') v = fmtD(r.start); else if (k === 'finish') v = fmtD(r.finish); else if (k === 'pct' && r.pct != null) v = Math.round(r.pct) + '%';
        return `<div class="c ${ALL_COLS[k].num ? 'num' : ''} ${(S.active === key && S.activeCol === k) ? 'active' : ''}" style="width:${ALL_COLS[k].w}px" data-col="${k}">${v}</div>`;
      }).join('');
      html.push(`<div class="row ${r.wbs ? 'wbs' : 'group'} ${sel ? 'sel' : ''}" data-key="${esc(key)}" data-i="${i}"><div class="cells" style="width:${gw}px">${cells}</div></div>`);
    }
  });
  const H = rs.length * RH;
  html.push(`<svg class="chart" style="left:${gw}px" width="${W}" height="${H}">${chart(rs, t0, t1, W, H, 0)}</svg>`);
  const band = (S.panel === 'histogram' || S.panel === 'cost');
  if (band) html.push(`<div class="bandrow"><div class="cells" style="width:${gw}px" id="bandLabel"></div><svg id="bandSvg" width="${W}" height="150"></svg></div>`);
  $('#rows').innerHTML = html.join('');
  $('#inner').style.width = (gw + W) + 'px';
  wireRows(); wireChart();
  if (band) renderBand();
  renderPanelBody();
  if (S.pendingEdit) { const pe = S.pendingEdit; S.pendingEdit = null; const i = S.rowsCache.findIndex(r => rowKey(r) === pe.key); if (i >= 0) scrollToRow(i); setTimeout(() => startEdit(pe.key, pe.col), 0); }
  $('#printTitle').innerHTML = `<b>${esc(p.name)}</b> · ${esc(p.id)} · data date ${fmtD(p.data_date || p.start)} · finish ${fmtD(p.finish)} · printed ${new Date().toLocaleDateString('en-GB')}`;
}
function colourOf(a) {
  const c = S.view.colour;
  if (c.startsWith('code:')) { const t = c.slice(5); const v = (a.codes || {})[t]; return v ? ((S.project.code_types[t] || {})[v] || '#888') : null; }
  if (c === 'resource') { const x = S.project.assignments.find(x => x.activity_id === a.id); const r = x && S.project.resources.find(r => r.id === x.resource_id); return r ? (r.colour || hashColour(r.id)) : null; }
  return null;
}
function hashColour(s) { let h = 0; for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) & 0xffff; return `hsl(${h % 360},55%,55%)`; }
function timescale(t0, t1, W) {
  const px = S.view.pxDay, x = S.x; let s = `<svg width="${W}" height="${HDR}">`;
  const tier = px >= 18 ? 'day' : px >= 4 ? 'week' : 'month';
  for (let d = new Date(t0.getFullYear(), t0.getMonth(), 1); d < t1; d.setMonth(d.getMonth() + 1)) {
    const nx = new Date(d.getFullYear(), d.getMonth() + 1, 1);
    s += `<line x1="${x(d)}" y1="0" x2="${x(d)}" y2="${HDR}" stroke="var(--line)"/>`;
    const w = x(nx) - x(d); const label = w > 70 ? d.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' }) : w > 34 ? d.toLocaleDateString('en-GB', { month: 'short', year: '2-digit' }) : w > 14 ? d.toLocaleDateString('en-GB', { month: 'short' })[0] : '';
    s += `<text x="${x(d) + 4}" y="14" fill="var(--ink)" font-weight="600">${label}</text>`;
  }
  if (tier !== 'month') for (let d = new Date(t0); d < t1; d.setDate(d.getDate() + 7)) {
    s += `<line x1="${x(d)}" y1="20" x2="${x(d)}" y2="${HDR}" stroke="var(--grid)"/>`;
    s += `<text x="${x(d) + 2}" y="${tier === 'day' ? 30 : 38}" fill="var(--muted)">${tier === 'day' ? 'w/c ' : ''}${d.getDate()}${tier === 'day' ? ' ' + d.toLocaleDateString('en-GB', { month: 'short' }) : ''}</text>`;
  }
  if (tier === 'day') for (let d = new Date(t0); d < t1; d.setDate(d.getDate() + 1)) s += `<text x="${x(d) + px / 2}" y="41" fill="var(--muted)" text-anchor="middle" font-size="9">${'MTWTFSS'[(d.getDay() + 6) % 7]}</text>`;
  return s + '</svg>';
}
function chart(rs, t0, t1, W, H, bandH) {
  const p = S.project, x = S.x, px = S.view.pxDay; let s = '';
  // non-working shading (weekends) when zoomed in
  const cal = p.calendars[p.default_calendar_id];
  if (px >= 6 && cal) for (let d = new Date(t0); d < t1; d.setDate(d.getDate() + 1)) if (!isWorking(cal, d)) s += `<rect x="${x(d)}" y="0" width="${px}" height="${H - bandH}" fill="var(--grid)" opacity=".55"/>`;
  for (let d = new Date(t0); d < t1; d.setDate(d.getDate() + 7)) s += `<line x1="${x(d)}" y1="0" x2="${x(d)}" y2="${H}" stroke="var(--grid)"/>`;
  for (let d = new Date(t0.getFullYear(), t0.getMonth(), 1); d < t1; d.setMonth(d.getMonth() + 1)) s += `<line x1="${x(d)}" y1="0" x2="${x(d)}" y2="${H}" stroke="var(--line)"/>`;
  // row backgrounds (hit targets)
  rs.forEach((r, i) => { const key = rowKey(r); s += `<rect class="hit rowbg" data-key="${esc(key)}" x="0" y="${i * RH}" width="${W}" height="${RH}" fill="${S.sel.has(key) ? 'var(--sel)' : (r.wbs || r.group) ? 'var(--grid)' : 'transparent'}" opacity="${S.sel.has(key) ? .6 : .5}"/>`; });
  const dd = new Date(p.data_date || p.start);
  s += `<line x1="${x(dd)}" y1="0" x2="${x(dd)}" y2="${H}" stroke="var(--today)" stroke-dasharray="4 3" stroke-width="1.5"/>`;
  if (p.must_finish_by) s += `<line x1="${x(p.must_finish_by)}" y1="0" x2="${x(p.must_finish_by)}" y2="${H - bandH}" stroke="var(--crit)" stroke-dasharray="2 3"/>`;
  const yOf = {}; rs.forEach((r, i) => { if (r.act) yOf[r.act.id] = i * RH; });
  const ids = Object.fromEntries(p.activities.map(a => [a.id, a]));
  if (S.view.links) p.relationships.forEach((r, li) => {
    const a = ids[r.predecessor_id], b = ids[r.successor_id]; if (!a || !b || yOf[a.id] == null || yOf[b.id] == null) return;
    const ax = x(r.type[0] === 'S' ? (a.actual_start || a.early_start) : (a.actual_finish || a.early_finish));
    const bx = x(r.type[1] === 'S' ? (b.actual_start || b.early_start) : (b.actual_finish || b.early_finish));
    const ay = yOf[a.id] + RH / 2, by = yOf[b.id] + RH / 2, crit = a.critical && b.critical;
    const selL = S.selLink && S.selLink.p === a.id && S.selLink.s === b.id;
    const mid = r.type === 'FS' ? (bx >= ax + 12 ? ax + 6 : ax + 6) : ax - 6;
    const pts = r.type === 'FS' && bx < ax + 12 ? `${ax},${ay} ${ax + 6},${ay} ${ax + 6},${ay + RH / 2} ${bx - 8},${ay + RH / 2} ${bx - 8},${by} ${bx},${by}` : `${ax},${ay} ${mid},${ay} ${mid},${by} ${bx},${by}`;
    s += `<polyline class="hit link ${selL ? 'sel' : ''}" data-p="${a.id}" data-s="${b.id}" points="${pts}" fill="none" stroke="${selL ? 'var(--accent)' : crit ? 'var(--crit)' : 'var(--muted)'}" stroke-width="${selL ? 2.5 : 1.2}" opacity=".75" style="cursor:pointer"/>`;
    s += `<polygon points="${bx},${by} ${bx - 6},${by - 3.5} ${bx - 6},${by + 3.5}" fill="${selL ? 'var(--accent)' : crit ? 'var(--crit)' : 'var(--muted)'}"/>`;
  });
  const progressPts = [];
  rs.forEach((r, i) => {
    const y = i * RH;
    if (r.wbs || r.group) {
      if (r.start && r.finish) { const bx = x(r.start), bw = Math.max(2, x(r.finish) - bx); s += `<path d="M${bx},${y + 8} h${bw} v7 l-5,5 l-5,-5 h${-(bw - 20)} l-5,5 l-5,-5 z" fill="${r.colour || (r.crit ? 'var(--crit)' : 'var(--summary)')}" opacity=".85"/>`; }
      return;
    }
    const a = r.act, st = a.actual_start || a.early_start, fi = a.actual_finish || a.early_finish; if (!st) return;
    const fill = colourOf(a) || (S.view.colour === 'critical' && a.critical ? 'var(--crit)' : 'var(--bar)');
    if (S.view.baseline && a.baseline_start && a.baseline_finish) s += `<rect x="${x(a.baseline_start)}" y="${y + 20}" width="${Math.max(2, x(a.baseline_finish) - x(a.baseline_start))}" height="4" fill="var(--baseline)"/>`;
    if (a.type !== 'task' || a.duration_hours === 0) {
      const cx = x(a.type === 'finish_milestone' ? fi : st), cy = y + RH / 2;
      s += `<polygon class="hit bar" data-id="${a.id}" points="${cx},${cy - 7} ${cx + 7},${cy} ${cx},${cy + 7} ${cx - 7},${cy}" fill="${a.status === 'complete' ? 'var(--progress)' : (colourOf(a) || (a.critical ? 'var(--crit)' : 'var(--ms)'))}"/>`;
      s += `<text x="${cx + 10}" y="${cy + 4}" fill="var(--muted)">${esc(a.name)}</text>`;
      if (S.view.progress) progressPts.push([a.status === 'complete' ? x(dd) : Math.min(cx, x(dd)), cy]);
    } else {
      const bx = x(st), bw = Math.max(2, x(fi) - bx);
      if (S.view.float && a.late_finish && a.total_float_hours > 0) s += `<rect x="${bx + bw}" y="${y + 11}" width="${Math.max(0, x(a.late_finish) - (bx + bw))}" height="4" fill="var(--muted)" opacity=".35"/>`;
      if (S.view.float && a.total_float_hours < 0 && a.late_finish) s += `<rect x="${x(a.late_finish)}" y="${y + 11}" width="${Math.max(0, bx + bw - x(a.late_finish))}" height="4" fill="var(--crit)" opacity=".5"/>`;
      s += `<rect class="hit bar" data-id="${a.id}" x="${bx}" y="${y + 6}" width="${bw}" height="14" rx="2" fill="${fill}" stroke="${S.sel.has(a.id) ? 'var(--accent)' : 'none'}" stroke-width="2"/>`;
      const pct = a.status === 'complete' ? 100 : a.percent_complete;
      if (pct > 0) s += `<rect x="${bx}" y="${y + 10}" width="${bw * Math.min(100, pct) / 100}" height="6" fill="var(--progress)"/>`;
      if (a.constraint && a.constraint !== 'none' && a.constraint_date) s += `<text x="${x(a.constraint_date)}" y="${y + 24}" font-size="10" fill="var(--warn)" text-anchor="middle">${a.constraint.includes('start') ? '▲' : '▼'}</text>`;
      s += `<rect class="hit handle" data-id="${a.id}" x="${bx + bw - 5}" y="${y + 6}" width="6" height="14" fill="transparent"/>`;
      s += `<circle class="hit linkdot" data-id="${a.id}" cx="${bx + bw + 5}" cy="${y + 13}" r="4" fill="var(--panel)" stroke="var(--accent)" opacity="${S.sel.has(a.id) ? 1 : 0}"/>`;
      s += `<text x="${bx + bw + 12}" y="${y + 17}" fill="var(--muted)">${esc(a.name)}${(a.codes || {}).Trade && S.view.colour === 'none' ? '' : ''}</text>`;
      if (S.view.progress) { const exp = a.status === 'complete' ? x(dd) : a.status === 'in_progress' ? bx + bw * pct / 100 : Math.min(bx, x(dd)); progressPts.push([exp, y + RH / 2]); }
    }
  });
  if (S.view.progress && progressPts.length) {
    let d = `M${x(dd)},0`; progressPts.forEach(([px_, py]) => d += ` L${px_},${py}`); d += ` L${x(dd)},${H - bandH}`;
    s += `<path d="${d}" fill="none" stroke="var(--today)" stroke-width="1.5" opacity=".9"/>`;
  }
  return s;
}
function renderTimeLocation(gw, W, t0, t1) {
  const p = S.project, x = S.x, src = S.view.tlSource || 'WBS';
  const LH = 44, lw = 180;
  let locs, locOf;
  if (src === 'WBS') { locs = p.wbs.filter(w => !w.parent_id).sort((a, b) => a.seq - b.seq).map(w => w.name); locOf = a => { let w = wbsById(a.wbs_id); while (w && w.parent_id) w = wbsById(w.parent_id); return w ? w.name : null; }; }
  else { locOf = a => (a.codes || {})[src] || null; const first = {}; p.activities.forEach(a => { const l = locOf(a), st = a.actual_start || a.early_start; if (l && st && (!first[l] || st < first[l])) first[l] = st; }); locs = Object.keys(p.code_types[src] || {}).filter(l => first[l]).sort((a, b) => first[a].localeCompare(first[b])); }
  const yOf = Object.fromEntries(locs.map((l, i) => [l, i * LH]));
  const H = Math.max(1, locs.length) * LH;
  const acts = p.activities.filter(a => locOf(a) != null && (a.actual_start || a.early_start) && !(S.view.critical && !a.critical));
  let sv = '';
  const cal = p.calendars[p.default_calendar_id];
  if (S.view.pxDay >= 6 && cal) for (let d = new Date(t0); d < t1; d.setDate(d.getDate() + 1)) if (!isWorking(cal, d)) sv += `<rect x="${x(d)}" y="0" width="${S.view.pxDay}" height="${H}" fill="var(--grid)" opacity=".55"/>`;
  for (let d = new Date(t0); d < t1; d.setDate(d.getDate() + 7)) sv += `<line x1="${x(d)}" y1="0" x2="${x(d)}" y2="${H}" stroke="var(--grid)"/>`;
  locs.forEach((l, i) => sv += `<line x1="0" y1="${(i + 1) * LH}" x2="${W}" y2="${(i + 1) * LH}" stroke="var(--line)"/>`);
  const dd = new Date(p.data_date || p.start); sv += `<line x1="${x(dd)}" y1="0" x2="${x(dd)}" y2="${H}" stroke="var(--today)" stroke-dasharray="4 3" stroke-width="1.5"/>`;
  // line of balance: one sloped line per activity from (start, band top) to (finish, band bottom), grouped by trade
  const trade = a => (a.codes || {}).Trade || (S.project.assignments.find(x => x.activity_id === a.id) || {}).resource_id || 'other';
  const colour = a => colourOf(a) || ((p.code_types.Trade || {})[trade(a)]) || hashColour(trade(a));
  const byTrade = {};
  acts.forEach(a => {
    const y0 = yOf[locOf(a)], s0 = x(a.actual_start || a.early_start), f0 = x(a.actual_finish || a.early_finish);
    const col = colour(a); const crit = a.critical && S.view.colour === 'critical';
    if (a.type !== 'task' || a.duration_hours === 0) sv += `<polygon class="hit bar" data-id="${a.id}" points="${s0},${y0 + 8} ${s0 + 6},${y0 + LH / 2} ${s0},${y0 + LH - 8} ${s0 - 6},${y0 + LH / 2}" fill="${crit ? 'var(--crit)' : col}"/>`;
    else sv += `<polygon class="hit bar" data-id="${a.id}" points="${s0},${y0 + 4} ${f0},${y0 + 4} ${f0},${y0 + LH - 4} ${s0},${y0 + LH - 4}" fill="${col}" opacity=".18"/><line class="hit bar" data-id="${a.id}" x1="${s0}" y1="${y0 + LH - 4}" x2="${f0}" y2="${y0 + 4}" stroke="${crit ? 'var(--crit)' : col}" stroke-width="2.5"/>`;
    (byTrade[trade(a)] = byTrade[trade(a)] || []).push({ a, y0, s0, f0 });
  });
  Object.entries(byTrade).forEach(([t, items]) => { if (items.length < 2) return; items.sort((u, v) => u.s0 - v.s0); for (let i = 0; i < items.length - 1; i++) { const u = items[i], v = items[i + 1]; if (v.y0 === u.y0 || v.s0 < u.f0 - 1 || v.s0 - u.f0 > 60 * S.view.pxDay) continue; sv += `<line x1="${u.f0}" y1="${u.y0 + 4}" x2="${v.s0}" y2="${v.y0 + LH - 4}" stroke="${colour(u.a)}" stroke-dasharray="3 3" opacity=".7"/>`; } });
  acts.forEach(a => { const y0 = yOf[locOf(a)], s0 = x(a.actual_start || a.early_start), f0 = x(a.actual_finish || a.early_finish); if (f0 - s0 < 56 && a.type === 'task') return; sv += `<text x="${s0 + 3}" y="${y0 + 13}" fill="var(--muted)" font-size="10">${esc(a.name.length > Math.max(6, (f0 - s0) / 6) ? a.name.slice(0, Math.max(5, (f0 - s0) / 6)) + '…' : a.name)}</text>`; });
  const leg = Object.keys(byTrade).sort().map(t => `<span><span class="swatch" style="background:${(p.code_types.Trade || {})[t] || hashColour(t)}"></span>${esc(t)}</span>`).join(' ');
  $('#rows').innerHTML = locs.map((l, i) => `<div class="row" style="height:${LH}px"><div class="cells" style="width:${gw}px;height:${LH}px"><div class="c" style="width:${gw}px;font-weight:600">${esc(l)}</div></div></div>`).join('') +
    (locs.length ? '' : `<div class="row"><div class="cells" style="width:${gw}px"><div class="c hint">No locations: choose a code type with values, or add WBS summaries.</div></div></div>`) +
    `<svg class="chart" style="left:${gw}px" width="${W}" height="${H}">${sv}</svg>` +
    `<div class="bandrow" style="height:auto"><div class="cells" style="width:${gw}px;height:auto;padding:4px 8px" ><span class="hint">Time–location: each activity runs from its start (bottom of its location band) to its finish (top). Dashed lines follow a trade from location to location. A steeper line is a faster trade; crossing lines are clashes.</span></div><div style="padding:4px 8px;font-size:12px;display:flex;gap:10px;flex-wrap:wrap">${leg}</div></div>`;
  $('#inner').style.width = (gw + W) + 'px';
  $$('svg.chart .bar[data-id]').forEach(b => { b.onmousemove = e => tipFor(e, byId(b.dataset.id)); b.onmouseleave = hideTip; b.ondblclick = () => activityDialog(b.dataset.id); b.onclick = () => { S.sel = new Set([b.dataset.id]); S.active = b.dataset.id; }; });
  renderPanelBody();
}
function renderSummary() {
  const p = S.project, r = S.report, crit = p.activities.filter(a => a.critical).length;
  $('#summary').innerHTML = [`<span><b>${esc(p.name)}</b> <span class="hint">${esc(p.id)}</span></span>`, `<span>Start <b>${fmtD(p.start)}</b></span>`, `<span>Finish <b>${fmtD(p.finish)}</b></span>`,
    p.must_finish_by ? `<span>Must finish <b>${fmtD(p.must_finish_by)}</b></span>` : '', `<span>Data date <b>${fmtD(p.data_date || p.start)}</b></span>`,
    `<span><b>${p.activities.length}</b> activities · <b>${p.relationships.length}</b> links · <b class="${crit ? 'crit' : ''}">${crit}</b> critical</span>`,
    r ? `<span>Health <b style="color:${r.score >= 90 ? 'var(--ok)' : r.score >= 70 ? 'var(--warn)' : 'var(--crit)'}">${r.score}</b></span>` : '',
    p.levelled ? '<span class="hint">levelled</span>' : '', p.baselines.length ? `<span class="hint">baseline: ${esc(p.baselines[p.baselines.length - 1].name)}</span>` : '',
    S.extra && S.extra.schedule_error ? `<span class="crit">${esc(S.extra.schedule_error)}</span>` : ''].join('');
  $('#dataDate').value = (p.data_date || p.start).slice(0, 10);
}
function renderToolbarState() {
  $('#btnUndo').disabled = !S.history.undo; $('#btnRedo').disabled = !S.history.redo;
  const types = Object.keys(S.project.code_types || {});
  const vc = $('#vColour'); const cur = vc.value; vc.innerHTML = '<option value="critical">Colour: critical</option><option value="none">Colour: plain</option><option value="resource">Colour: resource</option>' + types.map(t => `<option value="code:${esc(t)}">Colour: ${esc(t)}</option>`).join(''); vc.value = [...vc.options].some(o => o.value === cur) ? cur : 'critical'; S.view.colour = vc.value;
  const vg = $('#vGroup'); const cg = vg.value; vg.innerHTML = '<option value="">Group: WBS</option>' + types.map(t => `<option value="${esc(t)}">Group: ${esc(t)}</option>`).join(''); vg.value = [...vg.options].some(o => o.value === cg) ? cg : ''; S.view.group = vg.value;
  $$('[data-panel]').forEach(b => b.classList.toggle('on', b.dataset.panel === S.panel));
  const vt = $('#vTl'); const ct = vt.value; vt.innerHTML = '<option value="WBS">Location: WBS</option>' + types.map(t => `<option value="${esc(t)}">Location: ${esc(t)}</option>`).join(''); vt.value = [...vt.options].some(o => o.value === ct) ? ct : 'WBS'; S.view.tlSource = vt.value; vt.hidden = S.view.mode !== 'tl';
}

// ---------- row + cell wiring ----------
function wireRows() {
  $$('#rows .row[data-key]').forEach(row => {
    row.querySelectorAll('.c').forEach(cell => {
      cell.onmousedown = e => { if (e.button !== 0 || S.editing) return; selectRow(row.dataset.key, e, cell.dataset.col); };
      cell.ondblclick = () => startEdit(row.dataset.key, cell.dataset.col);
    });
    row.oncontextmenu = e => { e.preventDefault(); if (!S.sel.has(row.dataset.key)) selectRow(row.dataset.key, e); contextMenu(e.clientX, e.clientY); };
    const tw = row.querySelector('[data-tw]'); if (tw) tw.onmousedown = e => { e.stopPropagation(); toggleCollapse(tw.dataset.tw); };
  });
}
function toggleCollapse(key) { if (S.collapsed.has(key)) S.collapsed.delete(key); else S.collapsed.add(key); render(); }
function selectRow(key, e, col) {
  const keys = S.rowsCache.map(rowKey);
  if (e && e.shiftKey && S.active) { const a = keys.indexOf(S.active), b = keys.indexOf(key); S.sel = new Set(keys.slice(Math.min(a, b), Math.max(a, b) + 1)); }
  else if (e && (e.ctrlKey || e.metaKey)) { if (S.sel.has(key)) S.sel.delete(key); else S.sel.add(key); S.active = key; }
  else { S.sel = new Set([key]); S.active = key; }
  if (col) S.activeCol = col; S.selLink = null;
  paintSelection();
}
function paintSelection() {
  $$('#rows .row[data-key]').forEach(r => { r.classList.toggle('sel', S.sel.has(r.dataset.key)); r.querySelectorAll('.c').forEach(c => c.classList.toggle('active', S.active === r.dataset.key && S.activeCol === c.dataset.col)); });
  $$('svg.chart .rowbg').forEach(r => { const on = S.sel.has(r.dataset.key); r.setAttribute('fill', on ? 'var(--sel)' : (r.dataset.key.startsWith('G:') || wbsById(r.dataset.key)) ? 'var(--grid)' : 'transparent'); });
  $$('svg.chart .bar[data-id]').forEach(b => { b.setAttribute('stroke', S.sel.has(b.dataset.id) ? 'var(--accent)' : 'none'); });
  $$('svg.chart .linkdot').forEach(d => d.setAttribute('opacity', S.sel.has(d.dataset.id) ? 1 : 0));
  $$('svg.chart .link').forEach(l => { const on = S.selLink && S.selLink.p === l.dataset.p && S.selLink.s === l.dataset.s; l.setAttribute('stroke-width', on ? 2.5 : 1.2); l.setAttribute('stroke', on ? 'var(--accent)' : l.getAttribute('stroke') === 'var(--accent)' ? 'var(--muted)' : l.getAttribute('stroke')); });
}
function startEdit(key, col) {
  const a = byId(key); const w = wbsById(key); const c = ALL_COLS[col];
  if (S.editing) commitEdit();
  const row = $(`#rows .row[data-key="${CSS.escape(key)}"]`); if (!row) return;
  const cell = row.querySelector(`.c[data-col="${col}"]`); if (!cell) return;
  if (w) { if (col !== 'name') return; cell.innerHTML = `<input value="${esc(w.name)}">`; }
  else if (a) {
    if (c.options) { const opts = c.options(); cell.innerHTML = `<select>${opts.map(([v, t]) => `<option value="${esc(v)}" ${(a.calendar_id || S.project.default_calendar_id) === v ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select>`; }
    else if (c.set) { let v = c.get(a); if (col === 'dur') v = String(fmt1(daysOf(a, a.duration_hours))); if (['start', 'finish', 'astart', 'afinish'].includes(col)) { const d = { start: a.actual_start || a.early_start, finish: a.actual_finish || a.early_finish, astart: a.actual_start, afinish: a.actual_finish }[col]; v = d ? d.slice(0, 10) : ''; cell.innerHTML = `<input type="date" value="${v}">`; } else if (col === 'pct') { cell.innerHTML = `<input type="number" min="0" max="100" value="${a.status === 'not_started' ? 0 : a.percent_complete}">`; } else cell.innerHTML = `<input value="${esc(v)}">`; }
    else return;
  } else return;
  const inp = cell.querySelector('input,select'); inp.focus(); if (inp.select) inp.select();
  S.editing = { key, col, inp };
  inp.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); commitEdit(); moveActive(1, 0); } else if (e.key === 'Escape') { cancelEdit(); } else if (e.key === 'Tab') { e.preventDefault(); commitEdit(); moveActive(0, e.shiftKey ? -1 : 1); } e.stopPropagation(); };
  inp.onblur = () => { if (S.editing && S.editing.inp === inp) commitEdit(); };
  if (inp.tagName === 'SELECT') inp.onchange = () => commitEdit();
}
function cancelEdit() { S.editing = null; render(); $('#sheet').focus(); }
function commitEdit() {
  const ed = S.editing; if (!ed) return; S.editing = null;
  const v = ed.inp.value; const a = byId(ed.key), w = wbsById(ed.key), c = ALL_COLS[ed.col];
  let changed = false;
  if (w) { if (v.trim() && v !== w.name) { w.name = v.trim(); changed = true; } }
  else if (a) { const before = JSON.stringify([a, S.project.relationships.length, S.project.assignments.length]); if (c.setOpt) c.setOpt(a, v); else c.set(a, v); changed = JSON.stringify([a, S.project.relationships.length, S.project.assignments.length]) !== before || ed.col === 'preds' || ed.col === 'res'; }
  if (changed) save(); else render();
  $('#sheet').focus();
}
function moveActive(dr, dc) {
  const keys = S.rowsCache.map(rowKey); let i = keys.indexOf(S.active); if (i < 0) i = 0;
  i = Math.max(0, Math.min(keys.length - 1, i + dr));
  let ci = S.cols.indexOf(S.activeCol); ci = Math.max(0, Math.min(S.cols.length - 1, ci + dc));
  S.active = keys[i]; S.activeCol = S.cols[ci]; S.sel = new Set([S.active]); paintSelection(); scrollToRow(i);
}
function scrollToRow(i) { const sheet = $('#sheet'); const y = HDR + i * RH; if (y < sheet.scrollTop + HDR) sheet.scrollTop = y - HDR; else if (y + RH > sheet.scrollTop + sheet.clientHeight) sheet.scrollTop = y + RH - sheet.clientHeight; }

// ---------- chart wiring: drag move / resize / link ----------
function wireChart() {
  const svg = $('svg.chart'); if (!svg) return;
  svg.querySelectorAll('.rowbg').forEach(r => { r.onmousedown = e => { if (e.button === 0) selectRow(r.dataset.key, e); }; r.oncontextmenu = e => { e.preventDefault(); if (!S.sel.has(r.dataset.key)) selectRow(r.dataset.key, e); contextMenu(e.clientX, e.clientY); }; });
  svg.querySelectorAll('.bar[data-id]').forEach(b => {
    b.onmousedown = e => { if (e.button !== 0) return; e.stopPropagation(); if (!S.sel.has(b.dataset.id)) selectRow(b.dataset.id, e); startDrag(e, 'move', b.dataset.id, b); };
    b.onmousemove = e => tipFor(e, byId(b.dataset.id)); b.onmouseleave = hideTip;
    b.oncontextmenu = e => { e.preventDefault(); e.stopPropagation(); if (!S.sel.has(b.dataset.id)) selectRow(b.dataset.id, e); contextMenu(e.clientX, e.clientY); };
    b.ondblclick = () => activityDialog(b.dataset.id);
  });
  svg.querySelectorAll('.handle').forEach(h => h.onmousedown = e => { if (e.button !== 0) return; e.stopPropagation(); selectRow(h.dataset.id, e); startDrag(e, 'resize', h.dataset.id, h.previousElementSibling && h.previousElementSibling.classList.contains('bar') ? h.previousElementSibling : svg.querySelector(`.bar[data-id="${CSS.escape(h.dataset.id)}"]`)); });
  svg.querySelectorAll('.linkdot').forEach(d => d.onmousedown = e => { if (e.button !== 0) return; e.stopPropagation(); startDrag(e, 'link', d.dataset.id, d); });
  svg.querySelectorAll('.link').forEach(l => { l.onmousedown = e => { e.stopPropagation(); S.selLink = { p: l.dataset.p, s: l.dataset.s }; S.sel = new Set(); paintSelection(); }; l.ondblclick = e => { e.stopPropagation(); linkDialog(l.dataset.p, l.dataset.s); }; });
}
function startDrag(e, kind, id, el) {
  const a = byId(id); const sheet = $('#sheet'); const rect = sheet.getBoundingClientRect();
  S.drag = { kind, id, el, x0: e.clientX, moved: false, bx: +el.getAttribute('x') || 0, bw: +el.getAttribute('width') || 0 };
  const svg = $('svg.chart');
  if (kind === 'link') { const g = document.createElementNS('http://www.w3.org/2000/svg', 'line'); g.setAttribute('stroke', 'var(--accent)'); g.setAttribute('stroke-dasharray', '4 3'); g.setAttribute('x1', el.getAttribute('cx')); g.setAttribute('y1', el.getAttribute('cy')); g.setAttribute('x2', el.getAttribute('cx')); g.setAttribute('y2', el.getAttribute('cy')); svg.appendChild(g); S.drag.line = g; }
  const onMove = ev => {
    const d = S.drag; const dx = ev.clientX - d.x0; if (Math.abs(dx) > 3) d.moved = true;
    if (d.kind === 'move' && d.el.tagName === 'rect') { d.el.setAttribute('x', d.bx + dx); d.el.classList.add('drag'); }
    else if (d.kind === 'move') { d.el.setAttribute('transform', `translate(${dx},0)`); }
    else if (d.kind === 'resize') { d.el.setAttribute('width', Math.max(2, d.bw + dx)); }
    else if (d.kind === 'link') { const pt = svgPoint(svg, ev); d.line.setAttribute('x2', pt.x); d.line.setAttribute('y2', pt.y); }
    if (d.kind !== 'link') { const days = Math.round(dx / S.view.pxDay); tipText(ev, d.kind === 'move' ? `${days >= 0 ? '+' : ''}${days} days` : `${fmt1(daysOf(a, a.duration_hours)) + Math.round(dx / S.view.pxDay * 5 / 7)}d approx`); }
  };
  const onUp = ev => {
    document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); hideTip();
    const d = S.drag; S.drag = null; if (!d) return;
    if (d.kind === 'link') { d.line.remove(); const target = document.elementFromPoint(ev.clientX, ev.clientY); const tid = target && target.dataset && target.dataset.id; const tkey = target && target.dataset && target.dataset.key; const sid = tid || (tkey && byId(tkey) ? tkey : null); if (sid && sid !== id) addLink(id, sid, 'FS', 0); return; }
    if (!d.moved) { render(); return; }
    const dx = ev.clientX - d.x0; const days = Math.round(dx / S.view.pxDay); if (!days) { render(); return; }
    if (d.kind === 'move') {
      if (a.status !== 'not_started') { toast('Started activities move by their actual dates'); render(); return; }
      mutate(p => { const s = new Date(a.early_start); s.setDate(s.getDate() + days); const nw = nextWorking(calOf(a), s); nw.setHours(8, 0, 0, 0); if (days < 0 && a.constraint === 'start_on_or_after') { a.constraint = 'none'; a.constraint_date = null; } a.constraint = 'start_on_or_after'; a.constraint_date = iso(nw); }, `${a.id} start on or after ${fmtD(a.constraint_date)}`);
    } else {
      mutate(p => { const f = new Date(a.actual_finish || a.early_finish); f.setDate(f.getDate() + days); const wd = workingDaysBetween(calOf(a), new Date(a.actual_start || a.early_start), f); if (wd < 0.5) return false; a.duration_hours = Math.max(0.5, wd) * hpd(a); if (a.status === 'in_progress') a.remaining_hours = a.duration_hours * (1 - a.percent_complete / 100); }, `${a.id} duration changed`);
    }
  };
  document.addEventListener('mousemove', onMove); document.addEventListener('mouseup', onUp);
}
function svgPoint(svg, ev) { const r = svg.getBoundingClientRect(); return { x: ev.clientX - r.left, y: ev.clientY - r.top }; }
function addLink(p, s, type, lagDays) {
  if (p === s) return;
  mutate(pr => { if (reaches(pr, s, p)) { toast('That link would create a loop'); return false; } pr.relationships = pr.relationships.filter(r => !(r.predecessor_id === p && r.successor_id === s)); pr.relationships.push({ predecessor_id: p, successor_id: s, type, lag_hours: (lagDays || 0) * hpd(byId(p)) }); }, `Linked ${p} → ${s}`);
}
function reaches(p, from, to) { const seen = new Set(), st = [from]; while (st.length) { const n = st.pop(); if (n === to) return true; if (seen.has(n)) continue; seen.add(n); p.relationships.filter(r => r.predecessor_id === n).forEach(r => st.push(r.successor_id)); } return false; }
function tipFor(e, a) { if (!a || S.drag) return; tipText(e, `<b>${esc(a.id)} ${esc(a.name)}</b><br>${fmtD(a.actual_start || a.early_start)} → ${fmtD(a.actual_finish || a.early_finish)} · ${fmt1(daysOf(a, a.duration_hours))}d<br>TF ${fmt1(daysOf(a, a.total_float_hours || 0))}d · FF ${fmt1(daysOf(a, a.free_float_hours || 0))}d${a.constraint !== 'none' ? '<br>' + a.constraint.replaceAll('_', ' ') + ' ' + fmtD(a.constraint_date) : ''}${a.baseline_finish ? '<br>baseline finish ' + fmtD(a.baseline_finish) : ''}${Object.entries(a.codes || {}).map(([k, v]) => `<br>${esc(k)}: ${esc(v)}`).join('')}${a.notes ? '<br><i>' + esc(a.notes) + '</i>' : ''}`); }
function tipText(e, html) { const t = $('#tip'); t.innerHTML = html; t.style.display = 'block'; t.style.left = (e.clientX + 14) + 'px'; t.style.top = (e.clientY + 14) + 'px'; }
function hideTip() { $('#tip').style.display = 'none'; }

// ---------- structural edits ----------
function selectedActs() { return [...S.sel].map(byId).filter(Boolean); }
function selectedRowsInOrder() { return S.rowsCache.filter(r => S.sel.has(rowKey(r))); }
function nextId() { const nums = S.project.activities.map(a => parseInt((a.id.match(/\d+/) || ['0'])[0])); let n = (Math.max(1000, ...nums) + 10); while (byId('A' + n)) n += 10; return 'A' + n; }
function insertActivity() {
  mutate(p => {
    const r = S.rowsCache.find(r => rowKey(r) === S.active); const id = nextId();
    const a = { id, name: 'New activity', wbs_id: r ? (r.act ? r.act.wbs_id : r.wbs ? r.wbs.id : null) : (p.wbs[0] && p.wbs[0].id), calendar_id: null, type: 'task', duration_hours: 5 * 8, constraint: 'none', constraint_date: null, status: 'not_started', actual_start: null, actual_finish: null, remaining_hours: null, percent_complete: 0, baseline_start: null, baseline_finish: null, notes: '', codes: {}, priority: 500, level_delay_hours: 0, critical: false };
    let idx = r && r.act ? p.activities.indexOf(r.act) + 1 : p.activities.length;
    p.activities.splice(idx, 0, a);
    if (r && r.act && r.act.type !== 'finish_milestone') { const succ = p.relationships.filter(x => x.predecessor_id === r.act.id && x.type === 'FS'); p.relationships.push({ predecessor_id: r.act.id, successor_id: id, type: 'FS', lag_hours: 0 }); succ.forEach(x => { x.predecessor_id = id; }); }
    S.sel = new Set([id]); S.active = id; S.activeCol = 'name';
    S.pendingEdit = { key: id, col: 'name' };
  }, 'Activity inserted');
}
function insertSummary() {
  mutate(p => {
    const r = S.rowsCache.find(r => rowKey(r) === S.active); let n = 1; while (wbsById('W' + n)) n++;
    const parent = r ? (r.wbs ? r.wbs.parent_id : r.act ? (r.act.wbs_id && wbsById(r.act.wbs_id) ? wbsById(r.act.wbs_id).parent_id : null) : null) : null;
    const sib = p.wbs.filter(w => (w.parent_id || null) === (parent || null)); const after = r && r.wbs ? r.wbs : (r && r.act && wbsById(r.act.wbs_id)) || null;
    const seq = after ? after.seq + 1 : (Math.max(-1, ...sib.map(w => w.seq)) + 1);
    sib.forEach(w => { if (w.seq >= seq) w.seq += 1; });
    const w = { id: 'W' + n, name: 'New summary', parent_id: parent || null, code: null, seq }; p.wbs.push(w);
    S.sel = new Set([w.id]); S.active = w.id; S.activeCol = 'name'; S.pendingEdit = { key: w.id, col: 'name' };
  }, 'Summary inserted');
}
function deleteSelected() {
  const keys = [...S.sel]; if (!keys.length) return;
  if (S.selLink) { const l = S.selLink; mutate(p => { p.relationships = p.relationships.filter(r => !(r.predecessor_id === l.p && r.successor_id === l.s)); S.selLink = null; }, 'Link removed'); return; }
  mutate(p => {
    keys.forEach(k => {
      const a = byId(k);
      if (a) {
        const preds = p.relationships.filter(r => r.successor_id === k), succs = p.relationships.filter(r => r.predecessor_id === k);
        p.relationships = p.relationships.filter(r => r.predecessor_id !== k && r.successor_id !== k);
        preds.forEach(pr => succs.forEach(sc => { if (pr.type === 'FS' && sc.type === 'FS' && !p.relationships.some(r => r.predecessor_id === pr.predecessor_id && r.successor_id === sc.successor_id)) p.relationships.push({ predecessor_id: pr.predecessor_id, successor_id: sc.successor_id, type: 'FS', lag_hours: 0 }); }));
        p.assignments = p.assignments.filter(x => x.activity_id !== k); p.activities = p.activities.filter(x => x.id !== k);
      }
      const w = wbsById(k);
      if (w) { p.activities.forEach(x => { if (x.wbs_id === k) x.wbs_id = w.parent_id; }); p.wbs.forEach(x => { if (x.parent_id === k) x.parent_id = w.parent_id; }); p.wbs = p.wbs.filter(x => x.id !== k); }
    });
    S.sel = new Set(); S.active = null;
  }, `${keys.length} removed`);
}
function indent(dir) {
  mutate(p => {
    const rs = S.rowsCache; let changed = false;
    selectedRowsInOrder().forEach(r => {
      const i = rs.indexOf(r);
      if (r.act) {
        const a = r.act;
        if (dir > 0) { for (let j = i - 1; j >= 0; j--) { const q = rs[j]; if (q.wbs && q.depth === r.depth) { a.wbs_id = q.wbs.id; changed = true; break; } if (q.wbs && q.depth < r.depth - 1) break; } }
        else { const w = wbsById(a.wbs_id); if (w) { a.wbs_id = w.parent_id || null; changed = true; } }
      } else if (r.wbs) {
        const w = r.wbs;
        if (dir > 0) { for (let j = i - 1; j >= 0; j--) { const q = rs[j]; if (q.wbs && q.depth === r.depth) { w.parent_id = q.wbs.id; changed = true; break; } if (q.wbs && q.depth < r.depth) break; } }
        else { const par = wbsById(w.parent_id); if (par) { w.parent_id = par.parent_id || null; w.seq = par.seq + 0.5; changed = true; } }
      }
    });
    p.wbs.sort((a, b) => a.seq - b.seq).forEach((w, k) => w.seq = k);
    return changed;
  }, dir > 0 ? 'Indented' : 'Outdented');
}
function moveRow(dir) {
  mutate(p => {
    const acts = selectedActs(); if (!acts.length) { const w = wbsById(S.active); if (!w) return false; const sib = p.wbs.filter(x => (x.parent_id || null) === (w.parent_id || null)).sort((a, b) => a.seq - b.seq); const i = sib.indexOf(w); const j = i + dir; if (j < 0 || j >= sib.length) return false; [sib[i].seq, sib[j].seq] = [sib[j].seq, sib[i].seq]; return true; }
    const list = p.activities; const idxs = acts.map(a => list.indexOf(a)).sort((a, b) => a - b);
    if (dir < 0 && idxs[0] === 0) return false; if (dir > 0 && idxs[idxs.length - 1] === list.length - 1) return false;
    (dir < 0 ? idxs : [...idxs].reverse()).forEach(i => { const j = i + dir;[list[i], list[j]] = [list[j], list[i]]; if (list[i].wbs_id !== list[j].wbs_id) { const t = list[i].wbs_id; list[i].wbs_id = list[j].wbs_id; list[j].wbs_id = t; } });
  }, 'Moved');
}
function linkSelected() { const acts = selectedRowsInOrder().filter(r => r.act).map(r => r.act); if (acts.length < 2) return toast('Select two or more activities'); mutate(p => { for (let i = 0; i < acts.length - 1; i++) { if (reaches(p, acts[i + 1].id, acts[i].id)) continue; if (!p.relationships.some(r => r.predecessor_id === acts[i].id && r.successor_id === acts[i + 1].id)) p.relationships.push({ predecessor_id: acts[i].id, successor_id: acts[i + 1].id, type: 'FS', lag_hours: 0 }); } }, 'Linked'); }
function unlinkSelected() { const ids = new Set(selectedActs().map(a => a.id)); if (ids.size < 2 && !S.selLink) return toast('Select two or more linked activities'); mutate(p => { if (S.selLink) { const l = S.selLink; p.relationships = p.relationships.filter(r => !(r.predecessor_id === l.p && r.successor_id === l.s)); S.selLink = null; } else p.relationships = p.relationships.filter(r => !(ids.has(r.predecessor_id) && ids.has(r.successor_id))); }, 'Unlinked'); }
function toggleMilestone() { const acts = selectedActs(); if (!acts.length) return; mutate(p => acts.forEach(a => { if (a.type === 'task') { a.type = p.relationships.some(r => r.successor_id === a.id) ? 'finish_milestone' : 'start_milestone'; a.duration_hours = 0; } else { a.type = 'task'; a.duration_hours = 8 * hpd(a) / 8 * 5; } }), 'Toggled milestone'); }

function copySelected() { const acts = selectedRowsInOrder().filter(r => r.act).map(r => r.act); if (!acts.length) return; S.clip = JSON.parse(JSON.stringify({ acts, links: S.project.relationships.filter(r => acts.some(a => a.id === r.predecessor_id) && acts.some(a => a.id === r.successor_id)), assigns: S.project.assignments.filter(x => acts.some(a => a.id === x.activity_id)) })); toast(`${acts.length} copied`); }
function pasteClip() {
  if (!S.clip) return toast('Nothing copied');
  mutate(p => {
    const r = S.rowsCache.find(r => rowKey(r) === S.active); let idx = r && r.act ? p.activities.indexOf(r.act) + 1 : p.activities.length;
    const wbs = r ? (r.act ? r.act.wbs_id : r.wbs ? r.wbs.id : null) : null; const map = {};
    const nums = p.activities.map(a => parseInt((a.id.match(/\d+/) || ['0'])[0])); let n = Math.max(1000, ...nums);
    S.clip.acts.forEach(src => { n += 10; while (byId('A' + n)) n += 10; const a = { ...src, id: 'A' + n, wbs_id: wbs, status: 'not_started', actual_start: null, actual_finish: null, remaining_hours: null, percent_complete: 0, baseline_start: null, baseline_finish: null, constraint: 'none', constraint_date: null, level_delay_hours: 0, codes: { ...(src.codes || {}) } }; map[src.id] = a.id; p.activities.splice(idx++, 0, a); });
    S.clip.links.forEach(l => p.relationships.push({ predecessor_id: map[l.predecessor_id], successor_id: map[l.successor_id], type: l.type, lag_hours: l.lag_hours }));
    S.clip.assigns.forEach(x => p.assignments.push({ ...x, activity_id: map[x.activity_id] }));
    S.sel = new Set(Object.values(map)); S.active = Object.values(map)[0];
  }, `${S.clip.acts.length} pasted`);
}
// ---------- context menu ----------
function contextMenu(x, y) {
  const acts = selectedActs(); const one = acts.length === 1 ? acts[0] : null; const m = $('#ctx');
  const items = [
    ['Insert activity below', insertActivity], ['Insert summary below', insertSummary], ['Delete', deleteSelected], null,
    ['Copy', copySelected], ['Paste below', pasteClip], null,
    ['Indent', () => indent(1)], ['Outdent', () => indent(-1)], ['Move up', () => moveRow(-1)], ['Move down', () => moveRow(1)], null,
    ['Link selected (FS)', linkSelected], ['Unlink selected', unlinkSelected], null,
    one ? ['Edit…', () => activityDialog(one.id)] : null,
    acts.length ? ['Progress…', progressDialog] : null,
    acts.length ? ['Constraint…', constraintDialog] : null,
    one && one.constraint !== 'none' ? ['Clear constraint', () => mutate(p => { one.constraint = 'none'; one.constraint_date = null; }, 'Constraint cleared')] : null,
    acts.length ? ['Toggle milestone', toggleMilestone] : null,
    one ? ['Notes…', () => notesDialog(one)] : null,
  ].filter(x => x !== undefined);
  m.innerHTML = items.map(it => it === null ? '<hr>' : `<div>${esc(it[0])}</div>`).join('');
  let k = 0; m.querySelectorAll('div').forEach(el => { const it = items.filter(x => x !== null)[k++]; el.onclick = () => { m.hidden = true; it[1](); }; });
  m.hidden = false; m.style.left = Math.min(x, innerWidth - 240) + 'px'; m.style.top = Math.min(y, innerHeight - m.offsetHeight - 10) + 'px';
}
document.addEventListener('mousedown', e => { if (!e.target.closest('#ctx')) $('#ctx').hidden = true; });

// ---------- dialogs ----------
function modal(title, bodyHtml, onOk, okLabel = 'OK') {
  const back = $('#modalBack'), m = $('#modal');
  m.innerHTML = `<h2>${esc(title)}</h2><div class="mbody">${bodyHtml}</div><div class="actions"><button id="mCancel">Cancel</button>${onOk ? `<button class="primary" id="mOk">${esc(okLabel)}</button>` : ''}</div>`;
  back.hidden = false; const close = () => { back.hidden = true; $('#sheet').focus(); };
  $('#mCancel').onclick = close; if (onOk) $('#mOk').onclick = () => { if (onOk(m) !== false) close(); };
  m.onkeydown = e => { if (e.key === 'Escape') close(); e.stopPropagation(); };
  const first = m.querySelector('input,select,textarea'); if (first) first.focus();
  return { m, close };
}
function activityDialog(id) {
  const a = byId(id); if (!a) return; const p = S.project;
  const cals = Object.values(p.calendars).map(c => `<option value="${esc(c.id)}" ${(a.calendar_id || p.default_calendar_id) === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('');
  const cons = ['none', 'start_on_or_after', 'start_on_or_before', 'finish_on_or_after', 'finish_on_or_before', 'must_start_on', 'must_finish_on', 'as_late_as_possible'].map(c => `<option ${a.constraint === c ? 'selected' : ''}>${c}</option>`).join('');
  const codes = Object.keys(p.code_types).map(t => `<label>${esc(t)}<select name="code:${esc(t)}"><option value="">—</option>${Object.keys(p.code_types[t]).map(v => `<option ${(a.codes || {})[t] === v ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select></label>`).join('');
  modal(`${a.id}`, `<div class="grid">
    <label>Name<input name="name" value="${esc(a.name)}"></label>
    <label>Type<select name="type"><option ${a.type === 'task' ? 'selected' : ''}>task</option><option ${a.type === 'start_milestone' ? 'selected' : ''}>start_milestone</option><option ${a.type === 'finish_milestone' ? 'selected' : ''}>finish_milestone</option></select></label>
    <label>Duration (days)<input name="dur" type="number" step="0.5" value="${fmt1(daysOf(a, a.duration_hours))}"></label>
    <label>Calendar<select name="cal">${cals}</select></label>
    <label>Predecessors<input name="preds" value="${esc(predsText(a))}"></label>
    <label>Resources<input name="res" value="${esc(ALL_COLS.res.get(a))}"></label>
    <label>Constraint<select name="con">${cons}</select></label>
    <label>Constraint date<input name="cond" type="date" value="${a.constraint_date ? a.constraint_date.slice(0, 10) : ''}"></label>
    <label>% complete<input name="pct" type="number" min="0" max="100" value="${a.status === 'not_started' ? 0 : a.percent_complete}"></label>
    <label>Actual start<input name="as" type="date" value="${a.actual_start ? a.actual_start.slice(0, 10) : ''}"></label>
    <label>Actual finish<input name="af" type="date" value="${a.actual_finish ? a.actual_finish.slice(0, 10) : ''}"></label>
    <label>Priority<input name="prio" type="number" value="${a.priority}"></label>
    ${codes}
    <label style="grid-column:1/-1">Notes<textarea name="notes" rows="3">${esc(a.notes || '')}</textarea></label>
  </div><p class="hint">ES ${fmtD(a.early_start)} · EF ${fmtD(a.early_finish)} · LS ${fmtD(a.late_start)} · LF ${fmtD(a.late_finish)} · TF ${fmt1(daysOf(a, a.total_float_hours || 0))}d</p>`, m => {
    const f = n => m.querySelector(`[name="${n}"]`).value;
    mutate(p => {
      a.name = f('name'); a.type = f('type'); const oldH = hpd(a); a.calendar_id = f('cal'); a.duration_hours = a.type === 'task' ? (+f('dur') || 0) * hpd(a) : 0;
      setPreds(a, f('preds')); setResources(a, f('res'));
      a.constraint = f('con'); a.constraint_date = a.constraint === 'none' || !f('cond') ? null : f('cond') + (a.constraint.includes('finish') ? 'T16:00:00' : 'T08:00:00'); if (a.constraint !== 'none' && !a.constraint_date) a.constraint = 'none';
      a.priority = +f('prio') || 500; a.notes = f('notes');
      Object.keys(p.code_types).forEach(t => { const v = f('code:' + t); if (v) a.codes[t] = v; else delete a.codes[t]; });
      a.actual_start = f('as') ? f('as') + 'T08:00:00' : null; a.actual_finish = f('af') ? f('af') + 'T16:00:00' : null;
      const pct = +f('pct') || 0;
      if (a.actual_finish) { a.status = 'complete'; a.percent_complete = 100; a.remaining_hours = 0; if (!a.actual_start) a.actual_start = a.actual_finish; }
      else if (a.actual_start || pct > 0) { a.status = 'in_progress'; a.percent_complete = pct; a.remaining_hours = a.duration_hours * (1 - pct / 100); if (!a.actual_start) a.actual_start = a.early_start; }
      else { a.status = 'not_started'; a.percent_complete = 0; a.remaining_hours = null; }
    }, `${a.id} updated`);
  }, 'Save');
}
function linkDialog(pid, sid) {
  const r = S.project.relationships.find(r => r.predecessor_id === pid && r.successor_id === sid); if (!r) return;
  const a = byId(pid);
  modal(`Link ${pid} → ${sid}`, `<div class="grid"><label>Type<select name="t">${['FS', 'SS', 'FF', 'SF'].map(t => `<option ${r.type === t ? 'selected' : ''}>${t}</option>`).join('')}</select></label><label>Lag (days)<input name="lag" type="number" step="0.5" value="${fmt1(daysOf(a, r.lag_hours))}"></label></div><p class="hint">${esc(a.name)} → ${esc(byId(sid).name)}. Delete removes the link.</p><button type="button" id="lDel">Delete link</button>`, m => {
    mutate(p => { r.type = m.querySelector('[name=t]').value; r.lag_hours = (+m.querySelector('[name=lag]').value || 0) * hpd(a); }, 'Link updated');
  }, 'Save');
  $('#lDel').onclick = () => { $('#mCancel').click(); mutate(p => { p.relationships = p.relationships.filter(x => x !== r); S.selLink = null; }, 'Link removed'); };
}
function progressDialog() {
  const acts = selectedActs(); if (!acts.length) return toast('Select activities first');
  modal('Progress', `<div class="grid"><label>% complete<input name="pct" type="number" min="0" max="100" value="50"></label><label>As of (data date)<input name="dd" type="date" value="${(S.project.data_date || S.project.start).slice(0, 10)}"></label></div><p class="hint">Applies to ${acts.length} selected activit${acts.length === 1 ? 'y' : 'ies'}. Not-started activities get an actual start on their early start.</p>`, m => {
    const pct = +m.querySelector('[name=pct]').value, dd = m.querySelector('[name=dd]').value;
    mutate(p => { if (dd) p.data_date = dd + 'T08:00:00'; acts.forEach(a => setProgress(a, pct, dd ? new Date(dd + 'T16:00:00') : null)); }, 'Progress recorded');
  }, 'Apply');
}
function constraintDialog() {
  const acts = selectedActs(); if (!acts.length) return toast('Select activities first');
  const a = acts[0];
  modal('Constraint', `<div class="grid"><label>Type<select name="con">${['none', 'start_on_or_after', 'start_on_or_before', 'finish_on_or_after', 'finish_on_or_before', 'must_start_on', 'must_finish_on', 'as_late_as_possible'].map(c => `<option ${a.constraint === c ? 'selected' : ''}>${c}</option>`).join('')}</select></label><label>Date<input name="d" type="date" value="${a.constraint_date ? a.constraint_date.slice(0, 10) : (a.early_start || '').slice(0, 10)}"></label></div>`, m => {
    const c = m.querySelector('[name=con]').value, d = m.querySelector('[name=d]').value;
    mutate(p => acts.forEach(a => { a.constraint = c; a.constraint_date = c === 'none' || c === 'as_late_as_possible' ? null : (d ? d + (c.includes('finish') ? 'T16:00:00' : 'T08:00:00') : null); if (c !== 'none' && c !== 'as_late_as_possible' && !a.constraint_date) a.constraint = 'none'; }), 'Constraint set');
  }, 'Apply');
}
function notesDialog(a) { modal(`Notes: ${a.id}`, `<textarea name="n" rows="8" style="width:100%">${esc(a.notes || '')}</textarea>`, m => mutate(p => { a.notes = m.querySelector('[name=n]').value; }, 'Notes saved'), 'Save'); }
function calendarsDialog() {
  const p = S.project; let cur = p.default_calendar_id;
  const draw = () => {
    const c = p.calendars[cur];
    return `<div class="bar-row"><label class="row">Calendar <select name="which">${Object.values(p.calendars).map(x => `<option value="${esc(x.id)}" ${x.id === cur ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select></label><button type="button" id="calNew">New</button><button type="button" id="calDel">Delete</button><label class="row"><input type="radio" name="def" ${p.default_calendar_id === cur ? 'checked' : ''}> project default</label></div>
    <div class="grid"><label>Name<input name="name" value="${esc(c.name)}"></label><label>Hours per day<input name="hpd" type="number" step="0.5" value="${c.hours_per_day}"></label><label>Day starts<input name="ds" type="time" value="${String(c.day_start).slice(0, 5)}"></label></div>
    <p class="hint">Working days</p><div class="days">${['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d, i) => `<label class="row"><input type="checkbox" name="wd${i}" ${c.working_days.includes(i) ? 'checked' : ''}>${d}</label>`).join('')}</div>
    <p class="hint">Exceptions (0 hours = non-working)</p><table><tr><th>Date</th><th>Hours</th><th></th></tr>${Object.entries(c.exceptions).sort().map(([d, h]) => `<tr><td>${d}</td><td>${h}</td><td><button type="button" data-ex="${d}">×</button></td></tr>`).join('')}<tr><td><input type="date" name="exd"></td><td><input type="number" name="exh" value="0" step="0.5" style="width:70px"></td><td><button type="button" id="exAdd">Add</button></td></tr></table>
    <p class="hint">Changing hours per day keeps each activity's duration in days.</p>`;
  };
  const { m } = modal('Calendars', draw(), m => { mutate(p => { }); }, 'Close');
  const wire = () => {
    const c = p.calendars[cur]; const body = m.querySelector('.mbody');
    body.querySelector('[name=which]').onchange = e => { cur = e.target.value; body.innerHTML = draw(); wire(); };
    body.querySelector('[name=name]').onchange = e => { c.name = e.target.value; };
    body.querySelector('[name=hpd]').onchange = e => { const nh = +e.target.value || 8; p.activities.forEach(a => { if ((a.calendar_id || p.default_calendar_id) === cur) { const days = a.duration_hours / c.hours_per_day; a.duration_hours = days * nh; } }); c.hours_per_day = nh; };
    body.querySelector('[name=ds]').onchange = e => { c.day_start = e.target.value + ':00'; };
    body.querySelector('[name=def]').onchange = () => { p.default_calendar_id = cur; };
    for (let i = 0; i < 7; i++) body.querySelector(`[name=wd${i}]`).onchange = e => { c.working_days = c.working_days.filter(d => d !== i); if (e.target.checked) c.working_days.push(i); c.working_days.sort(); };
    body.querySelectorAll('[data-ex]').forEach(b => b.onclick = () => { delete c.exceptions[b.dataset.ex]; body.innerHTML = draw(); wire(); });
    body.querySelector('#exAdd').onclick = () => { const d = body.querySelector('[name=exd]').value; if (!d) return; c.exceptions[d] = +body.querySelector('[name=exh]').value || 0; body.innerHTML = draw(); wire(); };
    body.querySelector('#calNew').onclick = () => { let n = 1; while (p.calendars['cal' + n]) n++; p.calendars['cal' + n] = { id: 'cal' + n, name: 'Calendar ' + n, hours_per_day: 8, day_start: '08:00:00', working_days: [0, 1, 2, 3, 4], exceptions: {} }; cur = 'cal' + n; body.innerHTML = draw(); wire(); };
    body.querySelector('#calDel').onclick = () => { if (Object.keys(p.calendars).length < 2 || cur === p.default_calendar_id) return toast('Cannot delete the default calendar'); delete p.calendars[cur]; p.activities.forEach(a => { if (a.calendar_id === cur) a.calendar_id = null; }); cur = p.default_calendar_id; body.innerHTML = draw(); wire(); };
  };
  wire();
}
function resourcesDialog() {
  const p = S.project;
  const draw = () => `<table><tr><th>ID</th><th>Name</th><th>Type</th><th>Max/day</th><th>Rate £/h</th><th>Colour</th><th>Used</th><th></th></tr>${p.resources.map((r, i) => `<tr><td>${esc(r.id)}</td><td><input data-f="name" data-i="${i}" value="${esc(r.name)}"></td><td><select data-f="type" data-i="${i}"><option ${r.type === 'labour' ? 'selected' : ''}>labour</option><option ${r.type === 'equipment' ? 'selected' : ''}>equipment</option><option ${r.type === 'material' ? 'selected' : ''}>material</option></select></td><td><input data-f="max_units_per_day" data-i="${i}" type="number" step="0.5" value="${r.max_units_per_day ?? ''}" style="width:70px"></td><td><input data-f="rate" data-i="${i}" type="number" step="0.5" value="${r.rate}" style="width:70px"></td><td><input data-f="colour" data-i="${i}" type="color" value="${r.colour || hslToHex(hashColour(r.id))}"></td><td>${p.assignments.filter(x => x.resource_id === r.id).length}</td><td><button type="button" data-del="${i}">×</button></td></tr>`).join('')}<tr><td colspan="8"><input name="newres" placeholder="New resource name"> <button type="button" id="resAdd">Add</button></td></tr></table><p class="hint">Max/day is the number of people (or units) available; levelling respects it. Blank = unlimited.</p>`;
  const { m } = modal('Resources', draw(), () => mutate(p => { }), 'Close');
  const wire = () => {
    const body = m.querySelector('.mbody');
    body.querySelectorAll('[data-f]').forEach(el => el.onchange = () => { const r = p.resources[+el.dataset.i]; const f = el.dataset.f; r[f] = f === 'max_units_per_day' ? (el.value === '' ? null : +el.value) : f === 'rate' ? +el.value : el.value; });
    body.querySelectorAll('[data-del]').forEach(b => b.onclick = () => { const r = p.resources[+b.dataset.del]; p.assignments = p.assignments.filter(x => x.resource_id !== r.id); p.resources.splice(+b.dataset.del, 1); body.innerHTML = draw(); wire(); });
    body.querySelector('#resAdd').onclick = () => { const n = body.querySelector('[name=newres]').value.trim(); if (!n) return; p.resources.push({ id: n.replace(/[^A-Za-z0-9]+/g, '_').toUpperCase().slice(0, 20), name: n, type: 'labour', unit: 'h', rate: 0, max_units_per_day: null, colour: null }); body.innerHTML = draw(); wire(); };
  };
  wire();
}
function hslToHex(hsl) { const m = hsl.match(/hsl\((\d+),(\d+)%,(\d+)%\)/); if (!m) return '#888888'; let [h, s, l] = [+m[1], +m[2] / 100, +m[3] / 100]; const k = n => (n + h / 30) % 12; const a = s * Math.min(l, 1 - l); const f = n => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1))); return '#' + [f(0), f(8), f(4)].map(v => Math.round(v * 255).toString(16).padStart(2, '0')).join(''); }
function codesDialog() {
  const p = S.project;
  const draw = () => Object.keys(p.code_types).map(t => `<h3>${esc(t)} <button type="button" data-delt="${esc(t)}" class="hint">delete type</button></h3><table>${Object.entries(p.code_types[t]).map(([v, c]) => `<tr><td>${esc(v)}</td><td><input type="color" data-t="${esc(t)}" data-v="${esc(v)}" value="${c}"></td><td>${p.activities.filter(a => (a.codes || {})[t] === v).length} activities</td><td><button type="button" data-delv="${esc(t)}|${esc(v)}">×</button></td></tr>`).join('')}<tr><td colspan="4"><input data-newv="${esc(t)}" placeholder="New value"> <button type="button" data-addv="${esc(t)}">Add</button></td></tr></table>`).join('') + `<p><input name="newt" placeholder="New code type (e.g. Zone, Subcontractor)"> <button type="button" id="addT">Add type</button></p><p class="hint">Assign values per activity in the activity dialog (double-click a bar) or via Group / Colour in the View group.</p>`;
  const { m } = modal('Activity codes', draw(), () => mutate(p => { }), 'Close');
  const wire = () => {
    const body = m.querySelector('.mbody');
    body.querySelectorAll('input[type=color]').forEach(el => el.onchange = () => { p.code_types[el.dataset.t][el.dataset.v] = el.value; });
    body.querySelectorAll('[data-delt]').forEach(b => b.onclick = () => { const t = b.dataset.delt; delete p.code_types[t]; p.activities.forEach(a => { if (a.codes) delete a.codes[t]; }); body.innerHTML = draw(); wire(); });
    body.querySelectorAll('[data-delv]').forEach(b => b.onclick = () => { const [t, v] = b.dataset.delv.split('|'); delete p.code_types[t][v]; p.activities.forEach(a => { if ((a.codes || {})[t] === v) delete a.codes[t]; }); body.innerHTML = draw(); wire(); });
    body.querySelectorAll('[data-addv]').forEach(b => b.onclick = () => { const t = b.dataset.addv; const v = body.querySelector(`[data-newv="${CSS.escape(t)}"]`).value.trim(); if (!v) return; p.code_types[t][v] = '#' + Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0'); body.innerHTML = draw(); wire(); });
    body.querySelector('#addT').onclick = () => { const t = body.querySelector('[name=newt]').value.trim(); if (!t || p.code_types[t]) return; p.code_types[t] = {}; body.innerHTML = draw(); wire(); };
  };
  wire();
}
function viewsDialog() {
  const load = () => { try { return JSON.parse(localStorage.getItem('views') || '{}'); } catch { return {}; } };
  const views = load();
  modal('Views', `<p class="hint">A view remembers columns, widths, zoom, chart type, toggles, colour, group, sort, filter and panel.</p><table>${Object.keys(views).map(n => `<tr><td>${esc(n)}</td><td><button type="button" data-apply="${esc(n)}">Apply</button> <button type="button" data-del="${esc(n)}">×</button></td></tr>`).join('') || '<tr><td class="hint" colspan="2">No saved views yet</td></tr>'}</table><p><input name="vn" placeholder="Name for the current view"> <button type="button" id="vSave">Save current</button></p>`, null);
  const m = $('#modal');
  const wire = () => {
    m.querySelectorAll('[data-apply]').forEach(b => b.onclick = () => { const v = load()[b.dataset.apply]; if (!v) return; S.cols = v.cols; Object.entries(v.widths || {}).forEach(([k, w]) => { if (ALL_COLS[k]) ALL_COLS[k].w = w; }); Object.assign(S.view, v.view); S.panel = v.panel; ['links', 'float', 'baseline', 'progress', 'critical'].forEach(k => { $('#v' + k[0].toUpperCase() + k.slice(1)).checked = !!S.view[k]; }); $('#vMode').value = S.view.mode; $('#vSort').value = S.view.sort; $('#vFilter').value = S.view.filter; $('#mCancel').click(); render(); refreshPanel(); });
    m.querySelectorAll('[data-del]').forEach(b => b.onclick = () => { const v = load(); delete v[b.dataset.del]; localStorage.setItem('views', JSON.stringify(v)); $('#mCancel').click(); viewsDialog(); });
    m.querySelector('#vSave').onclick = () => { const n = m.querySelector('[name=vn]').value.trim(); if (!n) return; const v = load(); v[n] = { cols: S.cols, widths: Object.fromEntries(S.cols.map(k => [k, ALL_COLS[k].w])), view: { ...S.view }, panel: S.panel }; localStorage.setItem('views', JSON.stringify(v)); $('#mCancel').click(); viewsDialog(); toast('View saved'); };
  };
  wire();
}
function columnsDialog() {
  modal('Columns', `<div class="days">${Object.entries(ALL_COLS).map(([k, c]) => `<label class="row"><input type="checkbox" name="${k}" ${S.cols.includes(k) ? 'checked' : ''}>${esc(c.t)}</label>`).join('')}</div>`, m => { S.cols = Object.keys(ALL_COLS).filter(k => m.querySelector(`[name=${k}]`).checked); if (!S.cols.includes('name')) S.cols.unshift('name'); try { localStorage.setItem('cols', JSON.stringify(S.cols)); } catch { } render(); }, 'Apply');
}
function newProjectDialog() {
  modal('New project', `<div class="grid"><label>Name<input name="name" value="New project"></label><label>Start on site<input name="start" type="date" value="${ymd(new Date())}"></label></div>`, async m => {
    try { show(await post('/api/projects', { name: m.querySelector('[name=name]').value, start: m.querySelector('[name=start]').value })); await loadList(); } catch (e) { toast(e.message); }
  }, 'Create');
}
function generateDialog() {
  const sel = (n, opts, v) => `<select name="${n}"><option value="">auto</option>${opts.map(o => `<option ${o === v ? 'selected' : ''}>${o}</option>`).join('')}</select>`;
  modal('Generate a programme', `<textarea name="text" rows="4" style="width:100%" placeholder="Paste the brief, e.g. New-build 24-unit three-storey apartment block in Leeds, RC frame on CFA piles, brick envelope. Start on site 6 April 2026, handover before Christmas 2027. Brownfield site with a live 11kV cable to divert."></textarea>
  <div class="bar-row"><button type="button" id="gParse">Read brief into form</button><span class="hint">keyword rules, no AI</span></div>
  <div class="grid" id="gForm">
    <label>Name<input name="name"></label><label>Type<select name="building_type">${['house', 'houses', 'apartments', 'office', 'warehouse', 'school', 'refurbishment', 'generic'].map(o => `<option ${o === 'generic' ? 'selected' : ''}>${o}</option>`).join('')}</select></label>
    <label>Storeys<input name="storeys" type="number" min="1" value="2"></label><label>GIA m²<input name="gross_internal_area_m2" type="number" min="0" value="0"></label><label>Units<input name="units" type="number" min="0" value="0"></label>
    <label>Frame${sel('frame', ['masonry', 'rc', 'steel', 'timber'])}</label><label>Foundations${sel('foundations', ['strip', 'raft', 'piled'])}</label><label>Envelope${sel('envelope', ['brick', 'render', 'cladding', 'curtain_wall'])}</label><label>Roof${sel('roof', ['pitched', 'flat'])}</label>
    <label>Fit-out<select name="fit_out"><option>shell</option><option>basic</option><option selected>full</option></select></label><label>Location<input name="location"></label>
    <label>Start<input name="start_date" type="date"></label><label>Must finish by<input name="deadline" type="date"></label><label>Planning conditions discharged<input name="planning_condition_date" type="date"></label>
    <div class="days" style="grid-column:1/-1">${['basement', 'demolition', 'service_diversion', 'contaminated_ground', 'external_works', 'six_day_week'].map(f => `<label class="row"><input type="checkbox" name="${f}" ${f === 'external_works' ? 'checked' : ''}>${f.replaceAll('_', ' ')}</label>`).join('')}</div>
  </div>`, async m => {
    const brief = {}; m.querySelectorAll('#gForm input,#gForm select').forEach(el => { if (el.type === 'checkbox') brief[el.name] = el.checked; else if (el.type === 'number') brief[el.name] = +el.value || 0; else if (el.value !== '') brief[el.name] = el.value; else if (el.type === 'date' || el.tagName === 'SELECT') brief[el.name] = null; });
    const text = m.querySelector('[name=text]').value.trim(); if (!brief.name) brief.name = text.slice(0, 60) || 'New project';
    try { const v = await post('/api/generate', { text: text || null, brief }); show(v); await loadList(); toast(`${v.project.activities.length} activities generated, finish ${fmtD(v.project.finish)}`); } catch (e) { toast(e.message); return false; }
  }, 'Generate');
  $('#gParse').onclick = async () => { const text = $('#modal [name=text]').value.trim(); if (!text) return; try { const b = await post('/api/brief/parse', { text }); $$('#gForm input,#gForm select').forEach(el => { if (!(el.name in b)) return; const v = b[el.name]; if (el.type === 'checkbox') el.checked = !!v; else el.value = v == null ? '' : v; }); } catch (e) { toast(e.message); } };
}

// ---------- panels ----------
function setPanel(name) { S.panel = S.panel === name ? null : name; $('#panel').hidden = !(S.panel === 'health' || S.panel === 'notes'); render(); refreshPanel(); }
async function refreshPanel() {
  if (!S.pid) return;
  try {
    if (S.panel === 'histogram') { S.hist = await api('/api/projects/' + encodeURIComponent(S.pid) + '/histogram'); renderBand(); }
    if (S.panel === 'cost') { S.costs = await api('/api/projects/' + encodeURIComponent(S.pid) + '/costs'); renderBand(); }
  } catch (e) { toast(e.message); }
}
function renderBand() {
  const g = $('#bandSvg'); const label = $('#bandLabel'); if (!g || !label) return;
  const x = S.x, W = S.ganttW, H = 150, px = S.view.pxDay; let s = '';
  if (S.panel === 'histogram' && S.hist) {
    const res = S.hist.resources; if (!S.histRes || !res.find(r => r.resource_id === S.histRes)) S.histRes = res.length ? res.sort((a, b) => b.overallocated_days - a.overallocated_days)[0].resource_id : '';
    const r = res.find(q => q.resource_id === S.histRes);
    label.innerHTML = `<b>Resource histogram</b><select id="histSel" style="margin:4px 0">${res.map(q => `<option value="${esc(q.resource_id)}" ${q.resource_id === S.histRes ? 'selected' : ''}>${esc(q.name)}${q.overallocated_days ? ' ⚠' : ''}</option>`).join('')}</select>` + (r ? `<span class="hint">limit ${r.limit ?? '∞'}/day · peak ${r.peak} · ${r.overallocated_days} day(s) over · ${r.total_units} h total</span>` : '<span class="hint">no resources assigned</span>');
    $('#histSel').onchange = e => { S.histRes = e.target.value; renderBand(); };
    if (r) {
      const weekly = px < 5; const buckets = {};
      r.days.forEach(d => { const dt = new Date(d.date); const k = weekly ? ymd(new Date(dt.getFullYear(), dt.getMonth(), dt.getDate() - ((dt.getDay() + 6) % 7))) : d.date; buckets[k] = (buckets[k] || 0) + d.units; });
      const div = weekly ? 5 : 1; const maxv = Math.max(r.limit || 0, ...Object.values(buckets).map(v => v / div)) || 1; const sc = (H - 30) / maxv;
      Object.entries(buckets).forEach(([k, v]) => { const avg = v / div; const bx = x(k), bw = Math.max(1, px * (weekly ? 7 : 1) - 1); const h = avg * sc; const over = r.limit && avg > r.limit + 1e-6; s += `<rect x="${bx}" y="${H - 10 - h}" width="${bw}" height="${h}" fill="var(--hist)"/>`; if (over) s += `<rect x="${bx}" y="${H - 10 - h}" width="${bw}" height="${(avg - r.limit) * sc}" fill="var(--over)"/>`; });
      if (r.limit) s += `<line x1="0" y1="${H - 10 - r.limit * sc}" x2="${W}" y2="${H - 10 - r.limit * sc}" stroke="var(--crit)" stroke-dasharray="3 3"/><text x="4" y="${H - 14 - r.limit * sc}" fill="var(--crit)">limit ${r.limit}</text>`;
      s += `<text x="4" y="14" fill="var(--muted)">${esc(r.name)} · ${weekly ? 'average per day, by week' : 'people per day'}</text>`;
    }
  } else if (S.panel === 'cost' && S.costs) {
    const c = S.costs, mt = c.metrics; const max = Math.max(1, ...c.weeks.map(w => Math.max(w.planned, w.baseline, w.earned, w.actual))); const sc = (H - 30) / max;
    label.innerHTML = `<b>Cost / earned value</b><div class="hint">budget £${mt.budget.toLocaleString()} · BCWS £${mt.bcws.toLocaleString()} · BCWP £${mt.bcwp.toLocaleString()}${mt.acwp ? ' · ACWP £' + mt.acwp.toLocaleString() : ''}<br>SPI ${mt.spi ?? '–'} · CPI ${mt.cpi ?? '–'} · SV £${mt.sv.toLocaleString()}${c.has_baseline ? '' : ' · set a baseline for BCWS'}</div>`;
    const line = (key, col, dash) => { if (!c.weeks.some(w => w[key])) return ''; return `<polyline points="${c.weeks.map(w => `${x(w.week)},${H - 10 - w[key] * sc}`).join(' ')}" fill="none" stroke="${col}" stroke-width="1.8" ${dash ? 'stroke-dasharray="4 3"' : ''}/>`; };
    s += line('planned', 'var(--hist)') + line('baseline', 'var(--baseline)', true) + line('earned', 'var(--progress)') + line('actual', 'var(--crit)');
    s += `<text x="4" y="14" fill="var(--muted)">cumulative £ · planned (blue), baseline (dashed), earned (green), actual (red)</text>`;
    for (const f of [0.25, 0.5, 0.75, 1]) s += `<line x1="0" y1="${H - 10 - max * f * sc}" x2="${W}" y2="${H - 10 - max * f * sc}" stroke="var(--grid)"/><text x="${W - 60}" y="${H - 12 - max * f * sc}" fill="var(--muted)">£${Math.round(max * f / 1000)}k</text>`;
  }
  g.innerHTML = s;
}
function renderPanelBody() {
  const el = $('#panel'); if (S.panel !== 'health' && S.panel !== 'notes') { el.hidden = true; return; } el.hidden = false;
  const p = S.project, x = S.extra || {};
  if (S.panel === 'health') {
    const r = S.report; if (!r) { el.innerHTML = '<p class="hint">Schedule did not calculate.</p>'; return; }
    el.innerHTML = `<div class="bar-row"><h3 style="margin:0">Health ${r.score}/100</h3><span class="hint">${esc(r.summary)}</span><button id="pFix" class="primary">Auto-repair</button></div>` + r.checks.map(c => `<div class="check ${!c.applicable ? 'na' : c.passed ? '' : 'fail'}"><span class="dot"></span><b>${esc(c.title)}</b> <span class="hint">${c.value != null ? c.value : ''} ${c.threshold ? '· ' + esc(c.threshold) : ''}</span><div class="d">${esc(c.detail)}</div>${c.items && c.items.length ? `<div class="items">${c.items.slice(0, 40).map(i => `<a data-i="${esc(i)}">${esc(i)}</a>`).join(', ')}${c.items.length > 40 ? ' …' : ''}</div>` : ''}</div>`).join('');
    $('#pFix').onclick = () => act('/repair');
    el.querySelectorAll('a[data-i]').forEach(a => a.onclick = () => { const id = a.dataset.i.split('->')[0]; S.sel = new Set([id]); S.active = id; paintSelection(); const i = S.rowsCache.findIndex(r => rowKey(r) === id); if (i >= 0) scrollToRow(i); });
  } else {
    el.innerHTML = `<h3>Notes</h3>${p.description ? `<p style="white-space:pre-wrap">${esc(p.description)}</p>` : ''}<h3>Assumptions</h3><ul>${(p.assumptions || []).map(a => `<li>${esc(a)}</li>`).join('') || '<li class="hint">none</li>'}</ul>${x.draft && x.draft.questions_for_client ? `<h3>Questions for the client</h3><ul>${x.draft.questions_for_client.map(q => `<li>${esc(q)}</li>`).join('')}</ul>` : ''}${x.still_open && x.still_open.length ? `<h3>Left open by the repairer</h3><ul>${x.still_open.map(q => `<li>${esc(q)}</li>`).join('')}</ul>` : ''}${x.log ? `<h3>Log</h3><pre class="hint">${esc(x.log.join('\n'))}</pre>` : ''}<h3>Baselines</h3><ul>${p.baselines.map(b => `<li>${esc(b.name)} · saved ${fmtD(b.saved_at)} · finish ${fmtD(b.finish)} <button data-bl="${esc(b.name)}">use</button></li>`).join('') || '<li class="hint">none</li>'}</ul>`;
    el.querySelectorAll('[data-bl]').forEach(b => b.onclick = () => act('/baseline/use', { name: b.dataset.bl }));
  }
}

// ---------- toolbar wiring ----------
function wireToolbar() {
  $('#projSel').onchange = e => openProject(e.target.value);
  $('#btnNew').onclick = newProjectDialog; $('#btnGenerate').onclick = generateDialog;
  $('#fileIn').onchange = async e => { const f = e.target.files[0]; if (!f) return; const fd = new FormData(); fd.append('file', f); toast('Importing ' + f.name + '…'); try { show(await api('/api/import', { method: 'POST', body: fd })); await loadList(); toast(`Imported ${f.name}: ${S.project.activities.length} activities`); } catch (err) { toast(err.message, 6000); } e.target.value = ''; };
  $$('[data-x]').forEach(a => a.onclick = () => { if (S.pid) location.href = '/api/projects/' + encodeURIComponent(S.pid) + '/export.' + a.dataset.x; });
  $('#btnPrint').onclick = () => window.print();
  $('#btnUndo').onclick = () => act('/undo'); $('#btnRedo').onclick = () => act('/redo');
  $('#btnInsert').onclick = insertActivity; $('#btnSummary').onclick = insertSummary; $('#btnDelete').onclick = deleteSelected;
  $('#btnIndent').onclick = () => indent(1); $('#btnOutdent').onclick = () => indent(-1); $('#btnUp').onclick = () => moveRow(-1); $('#btnDown').onclick = () => moveRow(1);
  $('#btnLink').onclick = linkSelected; $('#btnUnlink').onclick = unlinkSelected;
  $('#btnZoomIn').onclick = () => zoom(1.5); $('#btnZoomOut').onclick = () => zoom(1 / 1.5);
  $('#btnFit').onclick = () => { if (!S.project) return; const [t0, t1] = timeRange(); S.view.pxDay = Math.max(1, ($('#sheet').clientWidth - gridWidth() - 60) / ((t1 - t0) / DAY)); render(); };
  ['links', 'float', 'baseline', 'progress', 'critical'].forEach(k => { const el = $('#v' + k[0].toUpperCase() + k.slice(1)); el.onchange = () => { S.view[k] = el.checked; render(); }; });
  $('#vColour').onchange = e => { S.view.colour = e.target.value; render(); }; $('#vGroup').onchange = e => { S.view.group = e.target.value; render(); }; $('#vSort').onchange = e => { S.view.sort = e.target.value; render(); };
  $('#vFilter').oninput = e => { S.view.filter = e.target.value; render(); };
  $('#btnColumns').onclick = columnsDialog;
  $('#btnToday').onclick = () => { if (!S.project) return; const sheet = $('#sheet'); sheet.scrollLeft = Math.max(0, gridWidth() + S.x(S.project.data_date || S.project.start) - 300 - gridWidth()); };
  $('#btnViews').onclick = viewsDialog;
  $('#vMode').onchange = e => { S.view.mode = e.target.value; $('#vTl').hidden = S.view.mode !== 'tl'; render(); };
  $('#vTl').onchange = e => { S.view.tlSource = e.target.value; render(); };
  $('#dataDate').onchange = e => mutate(p => { p.data_date = e.target.value + 'T08:00:00'; }, 'Data date moved');
  $('#btnProgress').onclick = progressDialog; $('#btnConstraint').onclick = constraintDialog; $('#btnMilestone').onclick = toggleMilestone;
  $('#btnBaseline').onclick = () => modal('Set baseline', `<label>Name<input name="n" value="Baseline ${S.project ? S.project.baselines.length + 1 : 1}"></label>`, m => act('/baseline', { name: m.querySelector('[name=n]').value || 'Baseline' }), 'Store');
  $('#btnBaselineClear').onclick = () => act('/baseline', null, 'DELETE');
  $('#btnLevel').onclick = () => act('/level'); $('#btnUnlevel').onclick = () => act('/unlevel');
  $('#btnCalendars').onclick = calendarsDialog; $('#btnResources').onclick = resourcesDialog; $('#btnCodes').onclick = codesDialog;
  $$('[data-panel]').forEach(b => b.onclick = () => setPanel(b.dataset.panel));
  $('#btnRepair').onclick = () => act('/repair');
  $('#cmdForm').onsubmit = async e => { e.preventDefault(); const t = $('#cmdIn').value.trim(); if (!t || !S.pid) return; $('#cmdIn').value = ''; try { const v = await post('/api/projects/' + encodeURIComponent(S.pid) + '/command', { text: t }); if (v.project) show(v); $('#cmdOut').textContent = v.message.split('\n')[0]; if (v.message.includes('\n')) modal('Commands', `<pre style="white-space:pre-wrap;font-size:12px">${esc(v.message)}</pre>`); } catch (err) { $('#cmdOut').textContent = err.message; } };
  $('#sheet').addEventListener('keydown', onKey);
  $('#sheet').addEventListener('wheel', e => { if (e.ctrlKey) { e.preventDefault(); zoom(e.deltaY < 0 ? 1.25 : 0.8); } }, { passive: false });
  document.addEventListener('keydown', e => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !S.editing && !e.target.matches('input,textarea,select')) { e.preventDefault(); act(e.shiftKey ? '/redo' : '/undo'); } if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y' && !e.target.matches('input,textarea,select')) { e.preventDefault(); act('/redo'); } });
}
function zoom(f) { S.view.pxDay = Math.max(1, Math.min(40, S.view.pxDay * f)); render(); }
function onKey(e) {
  if (S.editing || !S.project) return;
  const k = e.key;
  if (k === 'ArrowDown') { e.preventDefault(); moveActive(1, 0); } else if (k === 'ArrowUp') { e.preventDefault(); moveActive(-1, 0); }
  else if (k === 'ArrowLeft') { e.preventDefault(); moveActive(0, -1); } else if (k === 'ArrowRight') { e.preventDefault(); moveActive(0, 1); }
  else if (k === 'Enter' || k === 'F2') { e.preventDefault(); if (S.active) startEdit(S.active, S.activeCol); }
  else if (k === 'Delete' || k === 'Backspace') { e.preventDefault(); deleteSelected(); }
  else if (k === 'Insert') { e.preventDefault(); insertActivity(); }
  else if (k === 'Tab') { e.preventDefault(); indent(e.shiftKey ? -1 : 1); }
  else if (k === ' ' && wbsById(S.active)) { e.preventDefault(); toggleCollapse(S.active); }
  else if (e.altKey && k === 'ArrowUp') { e.preventDefault(); moveRow(-1); } else if (e.altKey && k === 'ArrowDown') { e.preventDefault(); moveRow(1); }
  else if ((e.ctrlKey || e.metaKey) && k.toLowerCase() === 'l') { e.preventDefault(); linkSelected(); } else if ((e.ctrlKey || e.metaKey) && k.toLowerCase() === 'u') { e.preventDefault(); unlinkSelected(); }
  else if ((e.ctrlKey || e.metaKey) && k.toLowerCase() === 'c') { e.preventDefault(); copySelected(); } else if ((e.ctrlKey || e.metaKey) && k.toLowerCase() === 'v') { e.preventDefault(); pasteClip(); }
  else if ((e.ctrlKey || e.metaKey) && k.toLowerCase() === 'a') { e.preventDefault(); S.sel = new Set(S.rowsCache.map(rowKey)); paintSelection(); }
  else if (k === 'Escape') { S.sel = new Set(); S.selLink = null; paintSelection(); }
  else if (k === '+' || k === '=') zoom(1.25); else if (k === '-') zoom(0.8);
  else if (k.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey && S.active && byId(S.active) && ALL_COLS[S.activeCol].set) { startEdit(S.active, S.activeCol); const inp = S.editing && S.editing.inp; if (inp && inp.type !== 'date' && inp.tagName === 'INPUT') { inp.value = k; e.preventDefault(); } }
}

// ---------- init ----------
(async () => {
  try { const c = JSON.parse(localStorage.getItem('cols') || 'null'); if (Array.isArray(c) && c.length) S.cols = c.filter(k => ALL_COLS[k]); const w = JSON.parse(localStorage.getItem('colw') || 'null'); if (w) Object.entries(w).forEach(([k, v]) => { if (ALL_COLS[k] && v > 20) ALL_COLS[k].w = v; }); } catch { }
  wireToolbar();
  await loadList();
  let last = null; try { last = localStorage.getItem('pid'); } catch { }
  if (last) openProject(last).catch(() => { });
})();

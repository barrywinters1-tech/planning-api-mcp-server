/* Planner UI: portfolio, spreadsheet + Gantt, and monitor, as pure client logic over the JSON project model.
   Runs against the FastAPI server, or entirely in the browser when local_backend.js has set window.__local. */
'use strict';
const $ = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const pad = n => String(n).padStart(2, '0');
const iso = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:00`;
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const fmtD = s => s ? new Date(s).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: '2-digit' }) : '';
const fmtLong = s => s ? new Date(s).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }) : '';
const DAY = 864e5;
const RH = 30, HDR = 60, GX = 20;
const LOCAL = window.__local || null;          // in-browser backend (shareable single page)
const REDUCED = matchMedia('(prefers-reduced-motion: reduce)');

const S = {
  screen: 'projects', pid: null, project: null, report: null, history: { undo: 0, redo: 0 },
  sel: new Set(), active: null, activeCol: 'name', collapsed: new Set(), selLink: null,
  view: { mode: 'gantt', tlSource: 'WBS', pxDay: 8, links: true, float: true, baseline: false, progress: false, critical: false, colour: 'critical', group: '', sort: '', filter: '', show: 'all', level: 0, barText: 'name', periods: 'none' },
  trace: null,
  cols: ['id', 'name', 'dur', 'start', 'finish', 'tf', 'preds', 'pct'],
  panel: null, histRes: '', hist: null, costs: null, editing: null, drag: null, rowsCache: [],
  inspector: false, sideTab: 'activity', list: [], details: {}, staged: {}, ringShown: {},
  mode: 'build', sandbox: null, aiReady: false,
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
  drag: { t: 'Drag', w: 52, num: 1, get: a => S.dragMap && S.dragMap[a.id] != null ? fmt1(S.dragMap[a.id]) + 'd' : '', cls: a => S.dragMap && S.dragMap[a.id] > 0 ? 'crit' : '' },
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
  actualiseStartMilestones(a);
}
// Once work has started, the start milestones in front of it have happened. Leaving them open would
// pin them to the data date with negative float and make the whole programme read as late.
function actualiseStartMilestones(a) {
  if (!a.actual_start || !S.project) return;
  S.project.relationships.filter(r => r.successor_id === a.id).forEach(r => {
    const m = byId(r.predecessor_id);
    if (m && m.type === 'start_milestone' && m.status !== 'complete') { m.status = 'complete'; m.percent_complete = 100; m.remaining_hours = 0; m.actual_start = m.actual_finish = a.actual_start; }
  });
}
// ---------- data: the server API, or the in-browser backend ----------
async function api(path, opts = {}) {
  if (LOCAL) {
    const method = opts.method || 'GET'; let body = opts.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = null; } }
    try { return await LOCAL.route(method, path, body); } catch (e) { throw new Error(e && e.detail ? e.detail : ((e && e.message) || 'Something went wrong')); }
  }
  const r = await fetch(path, opts); if (!r.ok) { let m = r.statusText; try { m = (await r.json()).detail || m; } catch { } throw new Error(m); } return r.json();
}
const post = (path, body) => api(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
const pidPath = (sub = '') => '/api/projects/' + encodeURIComponent(S.pid) + sub;
async function importFile(f) {
  if (LOCAL) return LOCAL.importFile(f);
  const fd = new FormData(); fd.append('file', f); return api('/api/import', { method: 'POST', body: fd });
}
async function exportAs(fmt) {
  if (!S.pid) return;
  if (LOCAL) { try { await LOCAL.download(S.pid, fmt); } catch (e) { toast((e && e.detail) || e.message, { ms: 6000 }); } return; }
  location.href = pidPath('/export.' + fmt);
}
function setStatus(kind, text) { const el = $('#saveStatus'); el.hidden = !kind; el.className = 'status ' + (kind || ''); el.textContent = text || ''; }
async function loadList() {
  try { S.list = await api('/api/projects'); } catch (e) { S.list = []; toast(e.message); }
  if (S.screen === 'projects') renderProjects();
}
async function openProject(pid, screen = 'overview') {
  if (!pid) return;
  try { const v = await api('/api/projects/' + encodeURIComponent(pid)); if (pid !== S.pid) S.staged = {}; S.sel = new Set(); S.active = null; show(v); go(screen); } catch (e) { toast(e.message, { ms: 5000 }); }
}
function show(v) {
  if (!v || !v.project) return;
  S.project = v.project; S.report = v.report; S.pid = v.project.id; S.history = v.history || S.history; S.extra = v;
  S.details[S.pid] = { project: v.project, report: v.report };
  try { localStorage.setItem('pid', S.pid); } catch { }
  if (v.message) toast(v.message + (v.still_open && v.still_open.length ? ' Left open: ' + v.still_open[0] : ''), { ms: 7000 });
  S.sel = new Set([...S.sel].filter(id => byId(id) || wbsById(id)));
  paintChrome();
  if (S.screen === 'plan') { render(); if (S.panel === 'histogram' || S.panel === 'cost') refreshPanel(); }
  else if (S.screen === 'monitor') renderMonitor();
  else if (S.screen === 'overview') renderOverview();
  if (S.inspector) renderInspector();
  paintTry();
}
async function save(label) {
  if (readOnly()) { roBlocked(); await openProject(S.pid, S.screen); return; }
  setStatus('saving', 'Saving');
  try {
    const v = await api(pidPath(), { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ project: S.project }) });
    show(v); setStatus('ok', 'Saved'); if (label) toast(label, { ms: 3200, undo: true });
  } catch (e) { setStatus('error', 'Not saved'); toast('Not saved: ' + e.message, { ms: 6000 }); await openProject(S.pid, S.screen); }
}
function mutate(fn, label) { if (!S.project) return; if (readOnly()) return roBlocked(); const r = fn(S.project); if (r === false) return; save(label); }
async function act(path, body, method = 'POST') {
  if (readOnly()) return roBlocked();
  setStatus('saving', 'Working');
  try { show(await api(pidPath(path), { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })); setStatus('ok', 'Saved'); }
  catch (e) { setStatus('ok', 'Saved'); toast(e.message, { ms: 4000 }); }
}

// ---------- navigation ----------
function go(screen) {
  if (screen !== 'projects' && !S.project) screen = 'projects';
  const prev = S.screen; S.screen = screen;
  $('#scrProjects').hidden = screen !== 'projects'; $('#scrOverview').hidden = screen !== 'overview'; $('#scrPlan').hidden = screen !== 'plan'; $('#scrMonitor').hidden = screen !== 'monitor';
  closePops();
  paintChrome();
  const el = { projects: $('#scrProjects'), overview: $('#scrOverview'), plan: $('#scrPlan'), monitor: $('#scrMonitor') }[screen];
  if (screen === 'projects') { renderProjects(); loadList(); }
  else if (screen === 'overview') renderOverview();
  else if (screen === 'plan') { render(); requestAnimationFrame(() => placeSplitbar()); if (S.panel === 'histogram' || S.panel === 'cost') refreshPanel(); $('#sheet').focus({ preventScroll: true }); }
  else renderMonitor();
  // moving between the two project views slides in the direction of the tab; everything else cross-fades
  if (prev !== screen) {
    const order = { projects: 0, overview: 1, plan: 2, monitor: 3 };
    const dx = prev === 'projects' || screen === 'projects' ? 0 : (order[screen] > order[prev] ? 24 : -24);
    animate(el, { x: 0, opacity: 1 }, { from: { x: dx, opacity: 0 }, response: .34, done: () => { el.style.transform = ''; springs.delete(el); } });
  }
}
function paintChrome() {
  const inProject = !!S.project && S.screen !== 'projects';
  $('#crumbSep').hidden = $('#crumbProject').hidden = !inProject;
  if (S.project) $('#crumbName').textContent = S.project.name;
  $('#seg').hidden = !inProject;
  $$('#seg [data-screen]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.screen === S.screen)));
  if (inProject) requestAnimationFrame(() => moveThumb());
  $('#btnUndo').disabled = !inProject || !S.history.undo; $('#btnRedo').disabled = !inProject || !S.history.redo;
  $('#btnShare').disabled = !S.project;
}
function moveThumb(instant) {
  const b = $(`#seg [data-screen="${S.screen}"]`), th = $('#segThumb'); if (!b || !b.offsetWidth) return;
  th.style.width = b.offsetWidth + 'px';
  animate(th, { x: b.offsetLeft - 3 }, { response: .32, damping: .82, instant: instant || !th.style.transform });
}

// ---------- motion: interruptible springs (damping ratio + response, as UIKit uses) ----------
// Every animation starts from the element's live value and keeps its live velocity, so a sheet,
// popover or panel can be redirected mid-flight without a jump.
const springs = new WeakMap();
function animate(el, targets, o = {}) {
  let st = springs.get(el);
  if (!st) { st = { v: { x: 0, y: 0, scale: 1, opacity: 1 }, vel: { x: 0, y: 0, scale: 0, opacity: 0 }, raf: 0, to: {} }; springs.set(el, st); }
  if (o.from) { Object.assign(st.v, o.from); Object.keys(o.from).forEach(k => { st.vel[k] = 0; }); }
  if (o.velocity) Object.assign(st.vel, o.velocity);
  Object.assign(st.to, targets);
  const apply = () => { el.style.transform = `translate3d(${st.v.x}px,${st.v.y}px,0) scale(${st.v.scale})`; el.style.opacity = st.v.opacity; };
  cancelAnimationFrame(st.raf);
  if (o.instant || REDUCED.matches) {
    // reduced motion: no travel, just the end state (opacity changes still read as feedback)
    Object.assign(st.v, st.to); Object.keys(st.vel).forEach(k => { st.vel[k] = 0; }); apply(); if (o.done) o.done(); return;
  }
  const zeta = o.damping ?? 1, w0 = 2 * Math.PI / (o.response ?? .35);
  let last = performance.now();
  const step = now => {
    const dt = Math.min(.064, (now - last) / 1000); last = now;
    const n = Math.max(1, Math.ceil(dt / .004)), h = dt / n; let settled = true;
    for (const k of Object.keys(st.to)) {
      for (let i = 0; i < n; i++) { const acc = -w0 * w0 * (st.v[k] - st.to[k]) - 2 * zeta * w0 * st.vel[k]; st.vel[k] += acc * h; st.v[k] += st.vel[k] * h; }
      const eps = (k === 'scale' || k === 'opacity') ? .001 : .1;
      if (Math.abs(st.v[k] - st.to[k]) > eps || Math.abs(st.vel[k]) > eps * 10) settled = false;
    }
    if (settled) { Object.assign(st.v, st.to); Object.keys(st.vel).forEach(k => { st.vel[k] = 0; }); apply(); if (o.done) o.done(); return; }
    apply(); st.raf = requestAnimationFrame(step);
  };
  st.raf = requestAnimationFrame(step);
}
const project = (v, d = .998) => (v / 1000) * d / (1 - d);                      // where a flick will come to rest
const rubberband = (o, dim, c = .55) => (o * dim * c) / (dim + c * Math.abs(o));  // resistance past an edge

// ---------- sheets, popovers, toasts ----------
let lastTrigger = null;
document.addEventListener('pointerdown', e => { const b = e.target.closest('button, .tile, .card, [role=button]'); if (b) lastTrigger = b; }, true);
function presentSheet(back, el) {
  const narrow = innerWidth <= 640;
  back._gen = (back._gen || 0) + 1; back._closing = false;   // a sheet opened while the last one closes wins
  back.hidden = false; back.style.pointerEvents = '';
  back.style.transition = 'background-color .28s ease'; back.style.backgroundColor = 'transparent';
  requestAnimationFrame(() => { back.style.backgroundColor = ''; });
  // a sheet grows out of the control that opened it; on a phone it rises from the bottom edge
  if (!narrow && lastTrigger && document.contains(lastTrigger)) {
    const r = lastTrigger.getBoundingClientRect(), s = el.getBoundingClientRect();
    el.style.transformOrigin = `${Math.round(r.left + r.width / 2 - s.left)}px ${Math.round(r.top + r.height / 2 - s.top)}px`;
  } else el.style.transformOrigin = '50% 100%';
  const live = springs.has(el);
  animate(el, { x: 0, y: 0, scale: 1, opacity: 1 }, { from: live ? undefined : (narrow ? { y: el.offsetHeight || 520, scale: 1, opacity: 1 } : { y: 10, scale: .93, opacity: 0 }), response: .4, damping: narrow ? .88 : 1 });
}
function dismissSheet(back, el, velocity, after) {
  if (back.hidden || back._closing) return;
  const narrow = innerWidth <= 640, gen = back._gen; back._closing = true; back.style.pointerEvents = 'none'; back.style.backgroundColor = 'transparent';
  animate(el, narrow ? { y: el.offsetHeight + 40 } : { scale: .95, opacity: 0, y: 8 }, {
    response: .3, velocity: velocity ? { y: velocity } : undefined,
    done: () => { if (back._gen !== gen) return;   // superseded by a sheet opened mid-close
      back.hidden = true; back._closing = false; back.style.pointerEvents = ''; back.style.backgroundColor = ''; el.style.transform = ''; el.style.opacity = ''; springs.delete(el); if (after) after(); },
  });
}
// drag a sheet down to dismiss (phones): tracks 1:1, resists upward, and decides from the projected rest point
function enableSheetDrag(el, getClose) {
  if (el._drag) return; el._drag = true;
  el.addEventListener('pointerdown', e => {
    if (innerWidth > 640 || e.button !== 0) return;
    if (!(e.target.closest('.grab') || e.target.closest('h2') || e.target.closest('.q') || e.target.closest('.steps'))) return;
    const y0 = e.clientY, base = (springs.get(el) || { v: { y: 0 } }).v.y; const hist = [{ y: e.clientY, t: performance.now() }]; let dragging = false;
    el.setPointerCapture(e.pointerId);
    const mv = ev => {
      const dy = ev.clientY - y0; if (!dragging && Math.abs(dy) < 8) return; dragging = true;
      hist.push({ y: ev.clientY, t: performance.now() }); if (hist.length > 6) hist.shift();
      const raw = base + dy; animate(el, { y: raw < 0 ? -rubberband(-raw, el.offsetHeight) : raw }, { instant: true });
    };
    const up = () => {
      el.removeEventListener('pointermove', mv); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up);
      if (!dragging) return;
      const a = hist[0], b = hist[hist.length - 1]; const v = (b.y - a.y) / Math.max(1, b.t - a.t) * 1000;
      const y = springs.get(el).v.y;
      if (y + project(v) > el.offsetHeight * .45) getClose()(v); else animate(el, { y: 0 }, { damping: .8, response: .3, velocity: { y: v } });
    };
    el.addEventListener('pointermove', mv); el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
  });
}
let modalClose = () => { };
function modal(title, bodyHtml, onOk, okLabel = 'OK', o = {}) {
  const back = $('#modalBack'), m = $('#modal');
  m.className = 'sheet' + (o.wide ? ' wide' : '');
  m.innerHTML = `<div class="grab" aria-hidden="true"></div><button type="button" class="icon x" id="mX" aria-label="Close"><svg viewBox="0 0 20 20" class="ic"><path d="M5 5l10 10M15 5L5 15"/></svg></button>${title ? `<h2>${esc(title)}</h2>` : ''}<div class="mbody">${bodyHtml}</div>` +
    (o.noActions ? '' : `<div class="actions"><button type="button" id="mCancel">${onOk ? 'Cancel' : 'Done'}</button>${onOk ? `<button type="button" class="primary" id="mOk">${esc(okLabel)}</button>` : ''}</div>`);
  m.setAttribute('aria-label', title || o.label || 'Dialog');
  const close = v => dismissSheet(back, m, v, () => { if (S.screen === 'plan') $('#sheet').focus({ preventScroll: true }); });
  modalClose = close;
  presentSheet(back, m); enableSheetDrag(m, () => modalClose);
  $('#mX').onclick = () => close(); if ($('#mCancel')) $('#mCancel').onclick = () => close();
  if (onOk) $('#mOk').onclick = async () => { const r = await onOk(m); if (r !== false) close(); };
  back.onpointerdown = e => { if (e.target === back) close(); };
  m.onkeydown = e => { if (e.key === 'Escape') close(); e.stopPropagation(); };
  const first = m.querySelector('.mbody input:not([type=hidden]):not([type=range]), .mbody select, .mbody textarea');
  if (first && innerWidth > 640) first.focus(); else m.setAttribute('tabindex', '-1'), m.focus({ preventScroll: true });
  return { m, close };
}
function openPop(pop, trigger, align = 'left') {
  if (pop._open) { closePop(pop); return; }
  closePops(pop);
  pop.hidden = false; pop._open = true;
  const r = trigger.getBoundingClientRect(), w = pop.offsetWidth, h = pop.offsetHeight;
  let left = align === 'right' ? r.right - w : r.left; left = Math.max(12, Math.min(left, innerWidth - w - 12));
  let top = r.bottom + 6; const below = top + h <= innerHeight - 12; if (!below) top = Math.max(12, r.top - h - 6);
  pop.style.left = left + 'px'; pop.style.top = top + 'px';
  pop.style.transformOrigin = `${Math.round(r.left + r.width / 2 - left)}px ${below ? 0 : h}px`;
  animate(pop, { scale: 1, opacity: 1, y: 0 }, { from: springs.has(pop) ? undefined : { scale: .88, opacity: 0, y: below ? -6 : 6 }, response: .3 });
}
function closePop(pop) { if (!pop._open) return; pop._open = false; animate(pop, { scale: .94, opacity: 0 }, { response: .22, done: () => { pop.hidden = true; springs.delete(pop); } }); }
function closePops(except) { $$('.pop').forEach(p => { if (p !== except) closePop(p); }); }
document.addEventListener('pointerdown', e => { if (!e.target.closest('.pop') && !e.target.closest('[aria-haspopup]')) closePops(); });
function toast(msg, o = {}) {
  if (typeof o === 'number') o = { ms: o };
  const t = $('#toast'); clearTimeout(t._t);
  t.innerHTML = `<span>${esc(msg)}</span>` + (o.undo && S.pid ? '<button type="button" id="tUndo">Undo</button>' : '') + (o.action ? `<button type="button" id="tAct">${esc(o.action.label)}</button>` : '');
  const fresh = t.hidden; t.hidden = false;
  animate(t, { y: 0, opacity: 1, scale: 1 }, { from: fresh ? { y: 28, opacity: 0, scale: .98 } : undefined, response: .36, damping: .9 });
  if ($('#tUndo')) $('#tUndo').onclick = () => { hideToast(); act('/undo'); };
  if ($('#tAct')) $('#tAct').onclick = () => { hideToast(); o.action.fn(); };
  t._t = setTimeout(hideToast, o.ms || 2800);
}
function hideToast() { const t = $('#toast'); if (t.hidden) return; clearTimeout(t._t); animate(t, { y: 28, opacity: 0 }, { response: .3, done: () => { t.hidden = true; springs.delete(t); } }); }
function stepper(id, v, step = 1, min = 0) { return `<span class="stepper"><button type="button" data-step="${-step}" data-for="${id}" aria-label="Less">−</button><input id="${id}" type="number" step="${step}" min="${min}" value="${v}"><button type="button" data-step="${step}" data-for="${id}" aria-label="More">+</button></span>`; }
function wireSteppers(root) {
  root.querySelectorAll('[data-step]').forEach(b => b.onclick = () => {
    const inp = root.querySelector('#' + b.dataset.for); const min = +inp.min || 0;
    inp.value = Math.max(min, Math.round(((+inp.value || 0) + (+b.dataset.step)) * 10) / 10);
    inp.dispatchEvent(new Event('input', { bubbles: true })); inp.dispatchEvent(new Event('change', { bubbles: true }));
    if (navigator.vibrate) try { navigator.vibrate(5); } catch { }
  });
}
function toggleTheme() {
  const root = document.documentElement; const cur = root.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  root.dataset.theme = cur === 'dark' ? 'light' : 'dark'; try { localStorage.setItem('theme', root.dataset.theme); } catch { }
  if (S.screen === 'plan') render();
}
// ---------- rows ----------
function rows() {
  const p = S.project, out = [], f = S.view.filter.trim().toLowerCase();
  const flt = buildFilter(S.view.filter);
  const pass = a => passQuick(a) && (!flt || flt(a));
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
      if ((f || S.view.critical || S.view.show !== 'all') && !acts.length) return;
      const s = acts.map(a => a.actual_start || a.early_start).filter(Boolean).sort()[0];
      const fi = acts.map(a => a.actual_finish || a.early_finish).filter(Boolean).sort().slice(-1)[0];
      out.push({ wbs: w, depth, start: s, finish: fi, n: acts.length, crit: acts.some(a => a.critical), pct: acts.length ? acts.reduce((t, a) => t + a.duration_hours * (a.status === 'complete' ? 100 : a.percent_complete), 0) / Math.max(1, acts.reduce((t, a) => t + a.duration_hours, 0)) : 0 });
      if (S.collapsed.has(w.id) || (S.view.level && depth + 1 >= S.view.level)) return;
      order((byW[w.id] || []).filter(pass)).forEach(a => out.push({ act: a, depth: depth + 1 }));
      walk(w.id, depth + 1);
    });
  };
  walk('', 0);
  order((byW[''] || []).filter(pass)).forEach(a => out.push({ act: a, depth: 0 }));
  return out;
}
const rowKey = r => r.act ? r.act.id : r.wbs ? r.wbs.id : 'G:' + r.group;

// ---------- quick filters, outline levels, logic tracing (Asta-style view tools) ----------
const QUICK = [['all', 'Everything'], ['critical', 'Critical path'], ['near', 'Near-critical (10 days float or less)'], ['lookahead', 'Next 3 weeks'], ['progress', 'In progress'], ['open', 'Not finished'], ['late', 'Behind baseline'], ['milestones', 'Milestones'], ['trace', 'Traced logic']];
const isOpen = a => a.status !== 'complete';
function passQuick(a) {
  const v = S.view.show, p = S.project;
  if (S.view.critical && !a.critical) return false;
  if (v === 'critical') return a.critical;
  if (v === 'near') return isOpen(a) && a.total_float_hours != null && a.total_float_hours <= 10 * hpd(a);
  if (v === 'progress') return a.status === 'in_progress';
  if (v === 'open') return isOpen(a);
  if (v === 'milestones') return a.type === 'start_milestone' || a.type === 'finish_milestone';
  if (v === 'late') return !!a.baseline_finish && new Date(a.actual_finish || a.early_finish) > new Date(a.baseline_finish);
  if (v === 'lookahead') { const dd = new Date(p.data_date || p.start), end = new Date(+dd + 21 * DAY); const st = a.actual_start || a.early_start, fi = a.actual_finish || a.early_finish; return isOpen(a) && st && new Date(st) <= end && new Date(fi) >= dd; }
  if (v === 'trace') return !S.trace || S.trace.set.has(a.id);
  return true;
}
// Walk the logic from the given activities. Backward follows only driving links (the chain that
// actually sets the dates, which is what a planner means by "why is this here"); forward follows
// every successor ("what does this hold up").
function traceSet(starts, dir) {
  const p = S.project, seen = new Set(starts), st = [...starts];
  while (st.length) {
    const id = st.pop();
    p.relationships.forEach(r => {
      const next = dir === 'back' ? (r.successor_id === id && r.driving ? r.predecessor_id : null) : (r.predecessor_id === id ? r.successor_id : null);
      if (next && !seen.has(next)) { seen.add(next); st.push(next); }
    });
  }
  return seen;
}
function finishDrivers() {
  const open = S.project.activities.filter(a => isOpen(a) && a.type !== 'level_of_effort' && a.early_finish);
  const last = open.reduce((m, a) => a.early_finish > m ? a.early_finish : m, '');
  return open.filter(a => a.early_finish === last).map(a => a.id);
}
function setTrace(ids, dir, label) {
  if (!S.project || !ids.length) return;
  S.trace = { ids, dir, set: traceSet(ids, dir), label: label || (dir === 'back' ? `Driving path to ${ids[0]}` : `Everything ${ids[0]} holds up`) };
  if (S.screen !== 'plan') go('plan'); else render();
  toast(`${S.trace.label}: ${S.trace.set.size} activities`);
}
function clearTrace() { if (!S.trace) return; S.trace = null; if (S.view.show === 'trace') S.view.show = 'all'; render(); }
function paintTraceChip() {
  const el = $('#traceChip'); if (!el) return;
  el.hidden = !S.trace; if (!S.trace) return;
  el.innerHTML = `<span class="tc-dot"></span><span class="tc-l">${esc(S.trace.label)} · ${S.trace.set.size}</span><button type="button" id="tcOnly" class="${S.view.show === 'trace' ? 'on' : ''}" title="Hide everything else">Only these</button><button type="button" id="tcX" aria-label="Stop tracing" title="Stop tracing (Esc)"><svg viewBox="0 0 20 20" class="ic"><path d="M6 6l8 8M14 6l-8 8"/></svg></button>`;
  el.querySelector('#tcOnly').onclick = () => { S.view.show = S.view.show === 'trace' ? 'all' : 'trace'; render(); };
  el.querySelector('#tcX').onclick = clearTrace;
}
function syncViewControls() {
  ['links', 'float', 'baseline', 'progress'].forEach(k => { const el = $('#v' + k[0].toUpperCase() + k.slice(1)); if (el) el.checked = !!S.view[k]; });
  if (S.view.critical) { S.view.show = 'critical'; S.view.critical = false; }   // views saved before quick filters
  const vs = $('#vShow'); if (vs) { vs.innerHTML = QUICK.filter(([k]) => k !== 'trace' || S.trace).map(([k, l]) => `<option value="${k}">${l}</option>`).join(''); vs.value = S.view.show; if (vs.value !== S.view.show) { S.view.show = 'all'; vs.value = 'all'; } }
  const depth = w => { let d = 0, x = w; while (x && x.parent_id && wbsById(x.parent_id) && d < 20) { d++; x = wbsById(x.parent_id); } return d; };
  const maxD = Math.max(0, ...S.project.wbs.map(depth)) + 1;
  const vl = $('#vLevel'); if (vl) { vl.innerHTML = '<option value="0">All levels</option>' + Array.from({ length: Math.min(maxD, 6) }, (_, i) => `<option value="${i + 1}">Summaries to level ${i + 1}</option>`).join(''); vl.value = String(S.view.level || 0); }
  const vb = $('#vBarText'); if (vb) vb.value = S.view.barText || 'name';
  const vp = $('#vPeriods'); if (vp) vp.value = S.view.periods || 'none';
  $('#vSort').value = S.view.sort; if (document.activeElement !== $('#vFilter')) $('#vFilter').value = S.view.filter;
}
function barLabel(a) {
  const st = a.actual_start || a.early_start, fi = a.actual_finish || a.early_finish, ms = a.type !== 'task' || a.duration_hours === 0;
  switch (S.view.barText) {
    case 'none': return '';
    case 'id': return `${a.id}  ${a.name}`;
    case 'dates': return ms ? fmtD(a.type === 'finish_milestone' ? fi : st) : `${fmtD(st)} – ${fmtD(fi)}`;
    case 'float': return ms ? `TF ${fmt1(daysOf(a, a.total_float_hours || 0))}d` : `${fmt1(daysOf(a, a.duration_hours))}d · TF ${fmt1(daysOf(a, a.total_float_hours || 0))}d`;
    case 'res': return ALL_COLS.res.get(a);
    default: return a.name;
  }
}
function goToActivity(id) {
  const a = byId(id); if (!a) return toast(`No activity ${id}`);
  if (S.screen !== 'plan') go('plan');
  const visible = () => S.rowsCache.findIndex(r => r.act && r.act.id === id);
  if (visible() < 0) {
    // reveal it: open its summaries and drop any filter hiding it
    let w = a.wbs_id && wbsById(a.wbs_id); while (w) { S.collapsed.delete(w.id); w = w.parent_id && wbsById(w.parent_id); }
    if (S.view.group) S.collapsed.delete('G:' + ((a.codes || {})[S.view.group] || '(none)'));
    S.view.level = 0; render();
    if (visible() < 0) { S.view.filter = ''; S.view.show = 'all'; S.view.critical = false; render(); }
  }
  S.sel = new Set([id]); S.active = id; paintSelection();
  const i = visible(); if (i >= 0) scrollToRow(i);
  const st = a.actual_start || a.early_start; if (st && S.x) { const sheet = $('#sheet'); sheet.scrollTo({ left: Math.max(0, S.x(st) - 80), behavior: REDUCED.matches ? 'auto' : 'smooth' }); }
  openInspector(id);
}
// ---------- CSV export (opens in Excel with real dates and numbers) ----------
const CSV_DATE = { start: a => a.actual_start || a.early_start, finish: a => a.actual_finish || a.early_finish, astart: a => a.actual_start, afinish: a => a.actual_finish, bstart: a => a.baseline_start, bfinish: a => a.baseline_finish, ls: a => a.late_start, lf: a => a.late_finish };
const CSV_NUM = { dur: a => a.type === 'task' ? fmt1(daysOf(a, a.duration_hours)) : 0, tf: a => a.total_float_hours == null ? '' : fmt1(daysOf(a, a.total_float_hours)), ff: a => a.free_float_hours == null ? '' : fmt1(daysOf(a, a.free_float_hours)), pct: a => a.status === 'complete' ? 100 : Math.round(a.percent_complete), delay: a => fmt1(daysOf(a, a.level_delay_hours || 0)), drag: a => S.dragMap && S.dragMap[a.id] != null ? S.dragMap[a.id] : '' };
function csvText() {
  // numbers pass through; text that a spreadsheet would run as a formula is neutralised
  const q = v => { if (typeof v === 'number') return String(v); v = v == null ? '' : String(v); const f = /^[=+\-@\t\r]/.test(v); return f || /[",\n\r]/.test(v) ? '"' + (f ? "'" : '') + v.replace(/"/g, '""') + '"' : v; };
  const head = ['Level', ...S.cols.map(k => ALL_COLS[k].t + (CSV_NUM[k] && k !== 'pct' ? ' (days)' : '')), 'Critical'];
  const lines = [head.map(q).join(',')];
  S.rowsCache.forEach(r => {
    if (r.act) { const a = r.act; lines.push([r.depth, ...S.cols.map(k => CSV_DATE[k] ? (CSV_DATE[k](a) || '').slice(0, 10) : CSV_NUM[k] ? CSV_NUM[k](a) : k.startsWith('f:') ? fieldRaw(a, k) : ALL_COLS[k].get(a)), a.critical ? 'Yes' : ''].map(q).join(',')); }
    else lines.push([r.depth, ...S.cols.map(k => k === 'id' ? (r.wbs ? r.wbs.code || '' : '') : k === 'name' ? (r.wbs ? r.wbs.name : r.group) : k === 'start' ? (r.start || '').slice(0, 10) : k === 'finish' ? (r.finish || '').slice(0, 10) : k === 'pct' && r.pct != null ? Math.round(r.pct) : ''), r.crit ? 'Yes' : ''].map(q).join(','));
  });
  return '﻿' + lines.join('\r\n') + '\r\n';
}
async function saveBlob(filename, blob) {
  let dl = null; try { if (window.claude && window.claude.use) dl = await window.claude.use('downloads'); } catch { dl = null; }
  if (dl) { try { await dl.save({ filename, data: blob }); return true; } catch (e) { if (e && e.code === 'declined') return false; } }
  const url = URL.createObjectURL(blob); const el = document.createElement('a'); el.href = url; el.download = filename; document.body.appendChild(el); el.click(); setTimeout(() => { el.remove(); URL.revokeObjectURL(url); }, 100); return true;
}
async function exportCsv() {
  if (!S.project) return; if (!S.rowsCache.length) render();
  if (await saveBlob(`${S.project.id}-programme.csv`, new Blob([csvText()], { type: 'text/csv;charset=utf-8' }))) toast(`CSV saved: ${S.rowsCache.filter(r => r.act).length} activities, as shown`);
}

// ---------- render ----------
function gridWidth() { return S.cols.reduce((t, k) => t + ALL_COLS[k].w, 0) + 1; }
// The table is a pane beside the chart, like Asta's splitter. On narrow screens it starts at about
// 40% so the bar chart is always visible; drag the grip in the header to resize (double-click to toggle).
function paneWidth() {
  const full = gridWidth(), sw = ($('#sheet') && $('#sheet').clientWidth) || innerWidth;
  let saved = S.paneW; if (saved == null) { try { const v = +localStorage.getItem('paneW'); if (v) saved = v; } catch { } }
  const def = sw >= 1200 ? Math.min(full, Math.round(sw * .55)) : sw < 600 ? Math.min(full, Math.max(140, Math.round(sw * .42))) : Math.min(full, Math.max(220, Math.round(sw * .42)));
  return Math.round(Math.max(110, Math.min(full, Math.max(110, sw - 80), saved || def)));
}
// with a narrow pane the activity name leads, so the table still says what each bar is
function visibleCols(pw) { return pw < 320 && S.cols.includes('name') ? ['name', ...S.cols.filter(k => k !== 'name')] : S.cols; }
// ---------- the divider between table and chart ----------
// A full-height bar you push and pull (mouse, pen or finger; arrow keys when focused). The table pane
// also scrolls sideways on its own (trackpad, shift-wheel, finger, or the ‹ › buttons) so you can reach
// every column while the Gantt stays in view, as in Asta.
const MIN_PANE = 110;
function maxPane() { return Math.max(MIN_PANE, Math.min(gridWidth(), (($('#sheet') && $('#sheet').clientWidth) || innerWidth) - 60)); }
function setPane(w, save = true) {
  w = Math.round(Math.max(MIN_PANE, Math.min(maxPane(), w))); S.paneW = w;
  if (save) { try { localStorage.setItem('paneW', w); } catch { } }
  return w;
}
function layoutPane(w) {      // cheap live update while dragging: no re-render
  $$('#hdr .hdr-grid, #rows .cells').forEach(el => { el.style.width = w + 'px'; });
  const svg = $('svg.chart'); if (svg) svg.style.left = w + 'px';
  $('#inner').style.width = (w + (S.ganttW || 0)) + 'px';
  placeSplitbar(w); setGx(S.gx || 0, w);
}
function placeSplitbar(w) {
  const bar = $('#splitbar'), sheet = $('#sheet'); if (!bar || !sheet) return;
  bar.hidden = !S.project || S.screen !== 'plan';
  bar.style.left = (w ?? paneWidth()) + 'px';
  bar.style.height = sheet.clientHeight + 'px';
  bar.setAttribute('aria-valuenow', String(Math.round(w ?? paneWidth()))); bar.setAttribute('aria-valuemin', String(MIN_PANE)); bar.setAttribute('aria-valuemax', String(maxPane()));
  const seg = $('#paneSeg'); if (seg) { const pw = w ?? paneWidth(), mode = pw >= maxPane() - 2 ? 'table' : pw <= MIN_PANE + 2 ? 'chart' : 'both'; seg.querySelectorAll('[data-pane]').forEach(b => b.classList.toggle('on', b.dataset.pane === mode)); }
}
function setGx(v, pw) {
  pw = pw ?? paneWidth(); const max = Math.max(0, gridWidth() - pw);
  S.gx = Math.round(Math.max(0, Math.min(max, v || 0)));
  const sheet = $('#sheet'); if (sheet) sheet.style.setProperty('--gx', S.gx + 'px');
  const prev = $('#hdr .colpage.prev'), next = $('#hdr .colpage.next');
  if (prev) prev.hidden = S.gx <= 0; if (next) next.hidden = S.gx >= max;
}
function pageCols(dir) {
  const pw = paneWidth(), cols = visibleCols(pw); let x = 0; const edges = cols.map(k => { const e = x; x += ALL_COLS[k].w; return e; });
  const target = dir > 0 ? edges.find(e => e > S.gx + 4) : [...edges].reverse().find(e => e < S.gx - 4);
  setGx(target ?? (dir > 0 ? x : 0), pw);
}
function ensureColVisible(k) {
  const pw = paneWidth(), cols = visibleCols(pw); let x = 0;
  for (const c of cols) { const w = ALL_COLS[c].w; if (c === k) { if (x < S.gx) setGx(x, pw); else if (x + w > S.gx + pw) setGx(x + w - pw, pw); return; } x += w; }
}
function wireSplitter() {
  const bar = $('#splitbar'); if (!bar || bar._wired) return; bar._wired = true;
  bar.onpointerdown = e => {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    e.preventDefault(); try { bar.setPointerCapture(e.pointerId); } catch { } bar.focus({ preventScroll: true });
    const x0 = e.clientX, w0 = paneWidth(); let moved = false; document.body.classList.add('splitting');
    const mv = ev => { if (Math.abs(ev.clientX - x0) > 2) moved = true; if (moved) layoutPane(setPane(w0 + ev.clientX - x0, false)); };
    const up = () => { bar.removeEventListener('pointermove', mv); bar.removeEventListener('pointerup', up); bar.removeEventListener('pointercancel', up); document.body.classList.remove('splitting'); if (!moved) return; setPane(S.paneW); render(); };
    bar.addEventListener('pointermove', mv); bar.addEventListener('pointerup', up); bar.addEventListener('pointercancel', up);
  };
  bar.ondblclick = () => paneMode(paneWidth() >= maxPane() - 2 ? 'both' : 'table');
  bar.onkeydown = e => {
    const step = e.shiftKey ? 120 : 30, w = paneWidth();
    const to = { ArrowLeft: w - step, ArrowRight: w + step, Home: MIN_PANE, End: maxPane() }[e.key];
    if (to == null) return; e.preventDefault(); e.stopPropagation(); setPane(to); render();
  };
  // the table pane scrolls sideways by itself
  const sheet = $('#sheet');
  sheet.addEventListener('wheel', e => {
    if (!e.target.closest || !e.target.closest('.cells, .hdr-grid')) return;
    const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.shiftKey ? e.deltaY : 0; if (!d) return;
    if (gridWidth() <= paneWidth()) return; e.preventDefault(); setGx((S.gx || 0) + d);
  }, { passive: false });
  let pan = null;
  sheet.addEventListener('pointerdown', e => { if (e.pointerType !== 'mouse' && e.target.closest && e.target.closest('.cells, .hdr-grid') && gridWidth() > paneWidth()) pan = { x: e.clientX, y: e.clientY, gx: S.gx || 0, on: false, id: e.pointerId }; });
  sheet.addEventListener('pointermove', e => {
    if (!pan || e.pointerId !== pan.id) return; const dx = e.clientX - pan.x, dy = e.clientY - pan.y;
    if (!pan.on) { if (Math.abs(dx) < 8 || Math.abs(dx) < Math.abs(dy)) { if (Math.abs(dy) > 8) pan = null; return; } pan.on = true; }
    setGx(pan.gx - dx);
  });
  const end = () => { pan = null; }; sheet.addEventListener('pointerup', end); sheet.addEventListener('pointercancel', end);
  addEventListener('resize', () => { if (S.screen === 'plan' && S.project) { clearTimeout(S._rz); S._rz = setTimeout(render, 120); } });
}
function paneMode(m) {
  if (!S.project) return;
  if (m === 'table') setPane(maxPane()); else if (m === 'chart') setPane(MIN_PANE);
  else { S.paneW = null; try { localStorage.removeItem('paneW'); } catch { } }
  if (S.screen !== 'plan') go('plan'); else render();
}
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
  syncFieldCols();
  renderSummary(); renderToolbarState();
  const rs = rows(); S.rowsCache = rs;
  if (S.cols.includes('drag') && S.dragStamp !== p.scheduled_at && p.activities.length <= 1500) { try { computeDrag(true); } catch { } }
  const gw = paneWidth(), cols = visibleCols(gw);
  const [t0, t1] = timeRange(); S.t0 = t0; S.t1 = t1;
  const px = S.view.pxDay; const W = Math.ceil((t1 - t0) / DAY * px) + 40; S.ganttW = W;
  const x = d => GX + (new Date(d) - t0) / DAY * px; S.x = x;
  // header
  $('#hdr').innerHTML = `<div class="hdr-grid" style="width:${gw}px"><button type="button" class="colpage prev" aria-label="Earlier columns" hidden>‹</button><button type="button" class="colpage next" aria-label="More columns" hidden>›</button>` + cols.map(k => `<div class="c ${S.view.sort === k ? 'sorted' : ''}" style="width:${ALL_COLS[k].w}px" data-col="${esc(k)}">${esc(ALL_COLS[k].t)}</div>`).join('') + `</div><div class="hdr-time" style="width:${W}px">${timescale(t0, t1, W)}</div>`;
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
      cells = cols.map((k, ci) => {
        const c = ALL_COLS[k]; let v = esc(c.get(a));
        if (ci === 0 || (ci === 1 && k === 'name')) { const indent = k === 'name' ? r.depth * 14 : 0; v = `<span style="display:inline-block;width:${indent}px"></span>` + (k === 'name' && colourOf(a) ? `<span class="swatch" style="background:${colourOf(a)}"></span>` : '') + v; }
        const cls = ['c', c.num ? 'num' : '', c.cls ? c.cls(a) : '', (a.critical && k === 'name') ? 'crit' : '', (S.active === key && S.activeCol === k) ? 'active' : ''].join(' ');
        return `<div class="${cls}" style="width:${c.w}px" data-col="${esc(k)}" title="${v.replace(/<[^>]+>/g, '')}">${v}</div>`;
      }).join('');
      html.push(`<div class="row ${sel ? 'sel' : ''}" data-key="${esc(key)}" data-i="${i}"><div class="cells" style="width:${gw}px">${cells}</div></div>`);
    } else {
      const name = r.wbs ? r.wbs.name : r.group; const id = r.wbs ? (r.wbs.code || '') : '';
      const collapsed = S.collapsed.has(key);
      cells = cols.map((k, ci) => {
        let v = '';
        if (k === 'id') v = esc(id);
        else if (k === 'name') v = `<span style="display:inline-block;width:${r.depth * 14}px"></span><span class="tw" data-tw="${esc(key)}">${collapsed ? '▸' : '▾'}</span>${r.colour ? `<span class="swatch" style="background:${r.colour}"></span>` : ''}${esc(name)}${r.n != null ? ` <span class="hint">(${r.n})</span>` : ''}`;
        else if (k === 'start') v = fmtD(r.start); else if (k === 'finish') v = fmtD(r.finish); else if (k === 'pct' && r.pct != null) v = Math.round(r.pct) + '%';
        return `<div class="c ${ALL_COLS[k].num ? 'num' : ''} ${(S.active === key && S.activeCol === k) ? 'active' : ''}" style="width:${ALL_COLS[k].w}px" data-col="${esc(k)}">${v}</div>`;
      }).join('');
      html.push(`<div class="row ${r.wbs ? 'wbs' : 'group'} ${sel ? 'sel' : ''}" data-key="${esc(key)}" data-i="${i}"><div class="cells" style="width:${gw}px">${cells}</div></div>`);
    }
  });
  const H = rs.length * RH; S.chartH = H;
  html.push(`<svg class="chart" style="left:${gw}px" width="${W}" height="${H}">${chart(rs, t0, t1, W, H, 0)}</svg>`);
  const band = (S.panel === 'histogram' || S.panel === 'cost');
  if (band) html.push(`<div class="bandrow"><div class="cells" style="width:${gw}px" id="bandLabel"></div><svg id="bandSvg" width="${W}" height="150"></svg></div>`);
  $('#rows').innerHTML = html.join('');
  $('#inner').style.width = (gw + W) + 'px';
  wireRows(); wireChart(); wireSplitter();
  setGx(S.gx || 0, gw); placeSplitbar(gw);
  $$('#hdr .colpage').forEach(b => b.onclick = e => { e.stopPropagation(); pageCols(b.classList.contains('next') ? 1 : -1); });
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
  // three-tier date zone, as in Asta Powerproject: month and year / week commencing / programme week (or day when zoomed in)
  const px = S.view.pxDay, x = S.x, p = S.project; let s = `<svg width="${W}" height="${HDR}">`;
  s += `<rect x="0" y="0" width="${W}" height="${HDR}" fill="var(--surface-2)"/><line x1="0" y1="20" x2="${W}" y2="20" stroke="var(--line)"/><line x1="0" y1="40" x2="${W}" y2="40" stroke="var(--line-2)"/>`;
  for (let d = new Date(t0.getFullYear(), t0.getMonth(), 1); d < t1; d.setMonth(d.getMonth() + 1)) {
    const nx = new Date(d.getFullYear(), d.getMonth() + 1, 1), w = x(nx) - x(d);
    s += `<line x1="${x(d)}" y1="0" x2="${x(d)}" y2="${HDR}" stroke="var(--line)"/>`;
    const vx = Math.max(x(d), GX), vis = x(nx) - vx;
    const label = vis > 104 ? d.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' }) : vis > 52 ? d.toLocaleDateString('en-GB', { month: 'short', year: '2-digit' }) : vis > 18 ? d.toLocaleDateString('en-GB', { month: 'short' })[0] : '';
    if (label) s += `<text x="${vx + 6}" y="14.5" fill="var(--ink)" font-weight="650" font-size="11.5">${label}</text>`;
  }
  const weekW = px * 7, every = weekW >= 26 ? 1 : weekW >= 13 ? 2 : 4;
  const st = new Date(p.start), mon0 = new Date(st.getFullYear(), st.getMonth(), st.getDate() - ((st.getDay() + 6) % 7));
  let k = 0;
  for (let d = new Date(t0); d < t1; d.setDate(d.getDate() + 7), k++) {
    s += `<line x1="${x(d)}" y1="20" x2="${x(d)}" y2="${HDR}" stroke="var(--line-2)"/>`;
    if (k % every) continue;
    s += `<text x="${x(d) + 3}" y="34" fill="var(--ink-2)" font-size="10.5">${d.getDate()}${weekW * every >= 48 ? ' ' + d.toLocaleDateString('en-GB', { month: 'short' }) : ''}</text>`;
    const wk = Math.round((d - mon0) / (7 * DAY)) + 1;
    if (px < 12 && wk >= 1 && weekW * every >= 24) s += `<text x="${x(d) + 3}" y="54" fill="var(--ink-3)" font-size="10">${weekW * every >= 40 ? 'Wk ' : 'W'}${wk}</text>`;
  }
  if (px >= 12) for (let d = new Date(t0); d < t1; d.setDate(d.getDate() + 1)) { const we = (d.getDay() + 6) % 7 > 4; s += `<text x="${x(d) + px / 2}" y="54" fill="${we ? 'var(--ink-3)' : 'var(--ink-2)'}" text-anchor="middle" font-size="9.5">${'MTWTFSS'[(d.getDay() + 6) % 7]}</text>`; }
  const tag = (d, label, col) => { const cx = x(d), w = label.length * 6 + 14; return `<g><rect x="${cx - w / 2}" y="43" width="${w}" height="15" rx="7.5" fill="${col}"/><text x="${cx}" y="53.5" text-anchor="middle" fill="#fff" font-size="10" font-weight="650">${label}</text></g>`; };
  s += tag(p.data_date || p.start, 'Data date', 'var(--dd)');
  if (p.must_finish_by) s += tag(p.must_finish_by, 'Deadline', 'var(--crit)');
  return s + '</svg>';
}
function chart(rs, t0, t1, W, H, bandH) {
  const p = S.project, x = S.x, px = S.view.pxDay; let s = '';
  const cal = p.calendars[p.default_calendar_id];
  if (px >= 5 && cal) for (let d = new Date(t0); d < t1; d.setDate(d.getDate() + 1)) if (!isWorking(cal, d)) s += `<rect x="${x(d)}" y="0" width="${px}" height="${H - bandH}" fill="var(--weekend)"/>`;
  for (let d = new Date(t0); d < t1; d.setDate(d.getDate() + 7)) s += `<line x1="${x(d)}" y1="0" x2="${x(d)}" y2="${H}" stroke="var(--line-2)"/>`;
  for (let d = new Date(t0.getFullYear(), t0.getMonth(), 1); d < t1; d.setMonth(d.getMonth() + 1)) s += `<line x1="${x(d)}" y1="0" x2="${x(d)}" y2="${H}" stroke="var(--line)"/>`;
  rs.forEach((r, i) => { const key = rowKey(r); s += `<rect class="hit rowbg" data-key="${esc(key)}" x="0" y="${i * RH}" width="${W}" height="${RH}" fill="${S.sel.has(key) ? 'var(--sel)' : (r.wbs || r.group) ? 'var(--grid)' : 'transparent'}" opacity="${S.sel.has(key) ? .6 : .5}"/><line x1="0" y1="${(i + 1) * RH - .5}" x2="${W}" y2="${(i + 1) * RH - .5}" stroke="var(--line-2)"/>`; });
  const dd = new Date(p.data_date || p.start);
  s += `<line x1="${x(dd)}" y1="0" x2="${x(dd)}" y2="${H}" stroke="var(--dd)" stroke-dasharray="5 4" stroke-width="1.6"/>`;
  if (p.must_finish_by) s += `<line x1="${x(p.must_finish_by)}" y1="0" x2="${x(p.must_finish_by)}" y2="${H - bandH}" stroke="var(--crit)" stroke-dasharray="2 4" stroke-width="1.4"/>`;
  const yOf = {}; rs.forEach((r, i) => { if (r.act) yOf[r.act.id] = i * RH; });
  const ids = Object.fromEntries(p.activities.map(a => [a.id, a]));
  const mid = RH / 2;
  const T = S.trace && S.trace.set, inTrace = id => !T || T.has(id);
  if (S.view.links) p.relationships.forEach(r => {
    const a = ids[r.predecessor_id], b = ids[r.successor_id]; if (!a || !b || yOf[a.id] == null || yOf[b.id] == null) return;
    const ax = x(r.type[0] === 'S' ? (a.actual_start || a.early_start) : (a.actual_finish || a.early_finish));
    const bx = x(r.type[1] === 'S' ? (b.actual_start || b.early_start) : (b.actual_finish || b.early_finish));
    const ay = yOf[a.id] + mid, by = yOf[b.id] + mid, crit = a.critical && b.critical;
    const selL = S.selLink && S.selLink.p === a.id && S.selLink.s === b.id;
    const traced = T && T.has(a.id) && T.has(b.id) && (S.trace.dir !== 'back' || r.driving);
    const col = selL || traced ? 'var(--accent)' : crit ? 'var(--crit)' : 'var(--ink-3)';
    const dn = by >= ay ? 1 : -1;
    const pts = r.type === 'FS' && bx < ax + 12 ? `${ax},${ay} ${ax + 6},${ay} ${ax + 6},${ay + dn * mid} ${bx - 8},${ay + dn * mid} ${bx - 8},${by} ${bx},${by}` : r.type === 'FS' ? `${ax},${ay} ${ax + 6},${ay} ${ax + 6},${by} ${bx},${by}` : `${ax},${ay} ${ax - 6},${ay} ${ax - 6},${by} ${bx},${by}`;
    s += `<polyline class="hit link ${selL ? 'sel' : ''}" data-p="${a.id}" data-s="${b.id}" points="${pts}" fill="none" stroke="${col}" stroke-width="${selL ? 2.4 : traced ? 2 : 1.15}" stroke-linejoin="round" opacity="${T ? (traced ? 1 : .12) : crit || selL ? .9 : .6}" style="cursor:pointer"/>`;
    s += `<polygon points="${bx},${by} ${bx - 5.5},${by - 3.2} ${bx - 5.5},${by + 3.2}" fill="${col}" opacity="${T && !traced ? .12 : 1}"/>`;
  });
  const progressPts = [];
  rs.forEach((r, i) => {
    const y = i * RH;
    if (r.wbs || r.group) {
      if (r.start && r.finish) {
        const bx = x(r.start), bw = Math.max(2, x(r.finish) - bx), col = r.colour || (r.crit ? 'var(--crit)' : 'var(--summary)');
        s += bw > 22 ? `<path d="M${bx},${y + 10} h${bw} v7 l-5,5 l-5,-5 h${-(bw - 20)} l-5,5 l-5,-5 z" fill="${col}" opacity=".88"/>` : `<rect x="${bx}" y="${y + 10}" width="${bw}" height="7" rx="2" fill="${col}"/>`;
        if (r.pct > 0) s += `<rect x="${bx}" y="${y + 12}" width="${bw * Math.min(100, r.pct) / 100}" height="3" rx="1.5" fill="var(--progress)"/>`;
      }
      return;
    }
    const a = r.act, st = a.actual_start || a.early_start, fi = a.actual_finish || a.early_finish; if (!st) return;
    const dim = !inTrace(a.id); s += `<g class="act${S.sel.has(a.id) ? ' sel' : ''}" data-g="${a.id}"${dim ? ' opacity=".2"' : ''}>`;
    const lbl = barLabel(a);
    const pct = a.status === 'complete' ? 100 : a.percent_complete;
    const fill = colourOf(a) || (S.view.colour === 'critical' && a.critical ? 'var(--crit)' : 'var(--bar)');
    if (S.view.baseline && a.baseline_start && a.baseline_finish) s += `<rect x="${x(a.baseline_start)}" y="${y + 23}" width="${Math.max(2, x(a.baseline_finish) - x(a.baseline_start))}" height="3.5" rx="1.75" fill="var(--baseline)"/>`;
    if (a.type !== 'task' || a.duration_hours === 0) {
      const cx = x(a.type === 'finish_milestone' ? fi : st), cy = y + mid;
      s += `<polygon class="hit bar" data-id="${a.id}" points="${cx},${cy - 7.5} ${cx + 7.5},${cy} ${cx},${cy + 7.5} ${cx - 7.5},${cy}" fill="${a.status === 'complete' ? 'var(--progress)' : (colourOf(a) || (a.critical ? 'var(--crit)' : 'var(--ms)'))}" stroke="${S.sel.has(a.id) ? 'var(--accent)' : 'none'}" stroke-width="2"/>`;
      s += `<circle class="hit linkdot" data-id="${a.id}" data-end="${a.type === 'start_milestone' ? 'S' : 'F'}" cx="${cx + 13}" cy="${cy}" r="5" fill="var(--surface)" stroke="var(--accent)" stroke-width="1.6"/>`;
      if (lbl) s += `<text x="${cx + 21}" y="${cy + 4}" fill="var(--ink-2)" font-weight="600">${esc(lbl)}</text>`;
      if (S.view.progress) progressPts.push([a.status === 'complete' ? x(dd) : Math.min(cx, x(dd)), cy]);
    } else {
      const bx = x(st), bw = Math.max(3, x(fi) - bx), h = 14, by = y + (RH - h) / 2, rr = Math.min(2, bw / 2);
      if (S.view.float && a.late_finish && a.total_float_hours > 0) { const fx = x(a.late_finish); if (fx > bx + bw + 1) s += `<line x1="${bx + bw}" y1="${y + mid}" x2="${fx}" y2="${y + mid}" stroke="var(--ink-3)" stroke-width="1.6" opacity=".45"/><line x1="${fx}" y1="${y + mid - 3.5}" x2="${fx}" y2="${y + mid + 3.5}" stroke="var(--ink-3)" stroke-width="1.6" opacity=".55"/>`; }
      if (S.view.float && a.total_float_hours < 0 && a.late_finish) s += `<rect x="${x(a.late_finish)}" y="${y + mid - 1.5}" width="${Math.max(0, bx + bw - x(a.late_finish))}" height="3" rx="1.5" fill="var(--crit)" opacity=".55"/>`;
      s += `<rect class="hit bar" data-id="${a.id}" x="${bx}" y="${by}" width="${bw}" height="${h}" rx="${rr}" fill="${fill}" stroke="${S.sel.has(a.id) ? 'var(--accent)' : 'none'}" stroke-width="2"/>`;
      if (pct > 0) s += `<rect x="${bx}" y="${by}" width="${Math.max(2, bw * Math.min(100, pct) / 100)}" height="${h}" rx="${rr}" fill="var(--done-ink)" opacity=".34" pointer-events="none"/>`;
      if (a.status === 'in_progress' && a.suspend_date) {   // suspended: a dashed gap until work resumes
        const sx = x(a.suspend_date), rx = x(a.resume_date && a.resume_date > (p.data_date || p.start) ? a.resume_date : (p.data_date || p.start));
        if (rx > sx + 1) s += `<rect x="${sx}" y="${by - 1}" width="${rx - sx}" height="${h + 2}" fill="var(--surface)" stroke="${fill}" stroke-dasharray="3 2" pointer-events="none"/><text x="${(sx + rx) / 2}" y="${by + h - 3}" text-anchor="middle" font-size="9" fill="var(--ink-3)" pointer-events="none">suspended</text>`;
      }
      if (a.constraint && a.constraint !== 'none' && a.constraint_date) { const cx = x(a.constraint_date); s += a.constraint.includes('start') ? `<polygon points="${cx},${by - 1} ${cx - 4},${by - 6} ${cx + 4},${by - 6}" fill="var(--warn)"/>` : `<polygon points="${cx},${by + h + 1} ${cx - 4},${by + h + 6} ${cx + 4},${by + h + 6}" fill="var(--warn)"/>`; }
      const hw = Math.min(8, Math.max(4, bw / 4));     // grab zones at each end: drag to change start or finish
      s += `<rect class="hit handle hs" data-id="${a.id}" data-end="S" x="${bx - 2}" y="${by - 2}" width="${hw}" height="${h + 4}" fill="transparent"/>`;
      s += `<rect class="hit handle hf" data-id="${a.id}" data-end="F" x="${bx + bw - hw + 2}" y="${by - 2}" width="${hw}" height="${h + 4}" fill="transparent"/>`;
      s += `<circle class="hit linkdot" data-id="${a.id}" data-end="S" cx="${bx - 9}" cy="${y + mid}" r="5" fill="var(--surface)" stroke="var(--accent)" stroke-width="1.6"/>`;
      s += `<circle class="hit linkdot" data-id="${a.id}" data-end="F" cx="${bx + bw + 9}" cy="${y + mid}" r="5" fill="var(--surface)" stroke="var(--accent)" stroke-width="1.6"/>`;
      if (lbl) s += `<text x="${bx + bw + 18}" y="${y + mid + 4}" fill="var(--ink-2)">${esc(lbl)}</text>`;
      if (S.view.progress) { const exp = a.status === 'complete' ? x(dd) : a.status === 'in_progress' ? bx + bw * pct / 100 : Math.min(bx, x(dd)); progressPts.push([exp, y + mid]); }
    }
    s += '</g>';
  });
  (p.annotations || []).forEach(n => {          // notes pinned to a date (and a row) on the chart
    const i = n.activity_id ? rs.findIndex(r => r.act && r.act.id === n.activity_id) : -1; if (n.activity_id && i < 0) return;
    const ax = x(n.date), ay = i >= 0 ? i * RH + 3 : 4, w = Math.min(220, 14 + n.text.length * 6.2);
    s += `<g class="hit note" data-note="${esc(n.id)}" style="cursor:pointer"><line x1="${ax}" y1="${ay}" x2="${ax}" y2="${ay + RH - 6}" stroke="var(--warn)" stroke-width="2"/><rect x="${ax + 3}" y="${ay}" width="${w}" height="16" rx="4" fill="var(--warn)" opacity=".92"/><text x="${ax + 9}" y="${ay + 12}" fill="#111" font-size="11" font-weight="600">${esc(n.text.length > 34 ? n.text.slice(0, 33) + '…' : n.text)}</text><title>${esc(n.text)}</title></g>`;
  });
  if (S.view.progress && progressPts.length) {
    let d = `M${x(dd)},0`; progressPts.forEach(([px_, py]) => { d += ` L${px_},${py}`; }); d += ` L${x(dd)},${H - bandH}`;
    s += `<path d="${d}" fill="none" stroke="var(--dd)" stroke-width="1.6" stroke-linejoin="round" opacity=".9"/>`;
  }
  s += periodLines(p, rs, x, RH, H - bandH);
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
  const acts = p.activities.filter(a => locOf(a) != null && (a.actual_start || a.early_start) && passQuick(a));
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
  $$('svg.chart .bar[data-id]').forEach(b => { b.onmousemove = e => tipFor(e, byId(b.dataset.id)); b.onmouseleave = hideTip; b.ondblclick = () => openInspector(b.dataset.id); b.onclick = () => { S.sel = new Set([b.dataset.id]); S.active = b.dataset.id; }; });
  renderPanelBody();
}
function healthColour(score) { return score >= 90 ? 'var(--ok)' : score >= 70 ? 'var(--warn)' : 'var(--crit)'; }
function renderSummary() {
  const p = S.project, r = S.report, crit = p.activities.filter(a => a.critical && a.status !== 'complete').length;
  const [cls, label] = statusOf(p, r);
  const late = p.must_finish_by && p.finish && new Date(p.finish) > new Date(p.must_finish_by);
  $('#summary').innerHTML = [
    `<span class="pname">${esc(p.name)}</span>`, `<span class="chip ${cls}">${label}</span>`,
    `<span class="f-opt">Start <b>${fmtD(p.start)}</b></span>`, `<span>Finish <b class="${late ? 'crit' : ''}">${fmtD(p.finish)}</b></span>`,
    p.must_finish_by ? `<span>Deadline <b>${fmtD(p.must_finish_by)}</b></span>` : '',
    `<span class="f-opt"><b>${p.activities.length}</b> activities · <b class="${crit ? 'crit' : ''}">${crit}</b> critical</span>`,
    r ? `<button type="button" class="linkish" id="fHealth" title="See the health checks">Health <b style="color:${healthColour(r.score)}">${r.score}</b></button>` : '',
    p.levelled ? '<span class="chip plain">Levelled</span>' : '', p.baselines.length ? `<span class="chip plain">Baseline: ${esc(p.baselines[p.baselines.length - 1].name)}</span>` : '',
    S.extra && S.extra.schedule_error ? `<span class="crit">${esc(S.extra.schedule_error)}</span>` : '',
    (() => { const n = oosList().length; return n ? `<button type="button" class="linkish chip warn" id="fOos" title="Progress recorded against the logic">${n} out of sequence</button>` : ''; })(), chartKey()].join('');
  $('#dataDate').value = (p.data_date || p.start).slice(0, 10);
  const fh = $('#fHealth'); if (fh) fh.onclick = () => go('monitor');
  const fo = $('#fOos'); if (fo) fo.onclick = oosDialog;
}
function chartKey() {
  const sw = (fill, label, extra = '') => `<span class="k-i"><svg viewBox="0 0 24 12" aria-hidden="true">${fill}</svg>${label}${extra}</span>`;
  const c = S.view.colour;
  if (c.startsWith('code:')) {
    const t = c.slice(5), vals = Object.entries((S.project.code_types || {})[t] || {}).filter(([v]) => S.project.activities.some(a => (a.codes || {})[t] === v));
    return `<span class="chartkey" aria-label="Key">${vals.slice(0, 12).map(([v, col]) => sw(`<rect x="1" y="2" width="22" height="8" rx="2" fill="${esc(col)}"/>`, esc(v))).join('')}${vals.length > 12 ? `<span class="k-i">+${vals.length - 12} more</span>` : ''}</span>`;
  }
  return `<span class="chartkey" aria-label="Key">${sw('<rect x="1" y="2" width="22" height="8" rx="2" fill="var(--bar)"/>', 'Activity')}${sw('<rect x="1" y="2" width="22" height="8" rx="2" fill="var(--crit)"/>', 'Critical')}${sw('<rect x="1" y="2" width="22" height="8" rx="2" fill="var(--bar)"/><rect x="1" y="2" width="12" height="8" rx="2" fill="var(--done-ink)" opacity=".34"/>', 'Done')}${sw('<path d="M12 1l5 5-5 5-5-5z" fill="var(--ms)"/>', 'Milestone')}${sw('<path d="M1 6h20M21 3v6" stroke="var(--ink-3)" stroke-width="1.6"/>', 'Float')}</span>`;
}
function renderToolbarState() {
  paintChrome();
  const types = Object.keys(S.project.code_types || {});
  const vc = $('#vColour'); vc.innerHTML = '<option value="critical">Critical path</option><option value="none">Plain</option><option value="resource">Resource</option>' + types.map(t => `<option value="code:${esc(t)}">${esc(t)}</option>`).join('');
  vc.value = [...vc.options].some(o => o.value === S.view.colour) ? S.view.colour : 'critical'; S.view.colour = vc.value;
  const vg = $('#vGroup'); vg.innerHTML = '<option value="">WBS</option>' + types.map(t => `<option value="${esc(t)}">${esc(t)}</option>`).join('');
  vg.value = [...vg.options].some(o => o.value === S.view.group) ? S.view.group : ''; S.view.group = vg.value;
  $$('[data-panel]').forEach(b => b.classList.toggle('on', b.dataset.panel === S.panel));
  const vt = $('#vTl'); vt.innerHTML = '<option value="WBS">Locations: WBS</option>' + types.map(t => `<option value="${esc(t)}">Locations: ${esc(t)}</option>`).join('');
  vt.value = [...vt.options].some(o => o.value === S.view.tlSource) ? S.view.tlSource : 'WBS'; S.view.tlSource = vt.value; vt.hidden = S.view.mode !== 'tl';
  $$('#modeSeg [data-mode]').forEach(b => b.classList.toggle('on', b.dataset.mode === S.view.mode));
  $('#btnInspector').classList.toggle('on', S.inspector);
  syncViewControls(); paintTraceChip();
}

// ---------- inspector: a side panel for the selected activity ----------
function openInspector(id) { if (id) { S.sel = new Set([id]); S.active = id; paintSelection(); } S.sideTab = 'activity'; if (S.inspector) renderInspector(); else toggleInspector(true); }
function toggleInspector(on) {
  S.inspector = on ?? !S.inspector; const el = $('#inspector');
  $('#btnInspector').classList.toggle('on', S.inspector);
  if (S.inspector) { el.hidden = false; renderInspector(); animate(el, { x: 0, opacity: 1 }, { from: springs.has(el) ? undefined : { x: 48, opacity: 0 }, response: .36 }); }
  else animate(el, { x: 48, opacity: 0 }, { response: .26, done: () => { el.hidden = true; el.style.transform = ''; springs.delete(el); } });
}
const CONSTRAINTS = [['none', 'None'], ['start_on_or_after', 'Start on or after'], ['start_on_or_before', 'Start on or before'], ['finish_on_or_after', 'Finish on or after'], ['finish_on_or_before', 'Finish on or before'], ['must_start_on', 'Must start on'], ['must_finish_on', 'Must finish on'], ['as_late_as_possible', 'As late as possible']];
function renderInspector() {
  const shell = $('#inspector'); if (!S.inspector || !S.project) return;
  if (!shell.querySelector('#inspBody')) {
    shell.innerHTML = `<div class="side-tabs"><div class="miniseg" role="tablist" aria-label="Side panel"><button type="button" role="tab" data-side="activity">Activity</button><button type="button" role="tab" data-side="progress">Progress</button></div><button type="button" class="icon" id="sideClose" aria-label="Close panel"><svg viewBox="0 0 20 20" class="ic"><path d="M5 5l10 10M15 5L5 15"/></svg></button></div><div id="inspBody"></div>`;
    shell.querySelectorAll('[data-side]').forEach(b => b.onclick = () => { S.sideTab = b.dataset.side; renderInspector(); });
    shell.querySelector('#sideClose').onclick = () => toggleInspector(false);
  }
  shell.querySelectorAll('[data-side]').forEach(b => { b.classList.toggle('on', b.dataset.side === S.sideTab); b.setAttribute('aria-selected', String(b.dataset.side === S.sideTab)); });
  if (S.sideTab === 'progress') { const body = shell.querySelector('#inspBody'); body.innerHTML = progressVisuals(S.project, S.report, true); drawViz(body); return; }
  renderActivityPanel();
}
function renderActivityPanel() {
  const el = $('#inspBody');
  const focusId = document.activeElement && el.contains(document.activeElement) ? document.activeElement.id : null;
  const a = S.active && byId(S.active);
  if (!a) { el.innerHTML = `<div class="empty"><b>Select an activity</b>Click a bar or a row to see its dates, logic and progress here. The Progress tab shows the S-curve, phases and milestones.</div>`; return; }
  const p = S.project; const pct = a.status === 'complete' ? 100 : Math.round(a.percent_complete);
  const tf = a.total_float_hours == null ? null : fmt1(daysOf(a, a.total_float_hours));
  const status = a.status === 'complete' ? '<span class="chip ok">Complete</span>' : a.status === 'in_progress' ? '<span class="chip warn">In progress</span>' : '<span class="chip plain">Not started</span>';
  const crit = a.critical ? '<span class="chip bad">Critical</span>' : (tf != null ? `<span class="chip plain">${tf}d float</span>` : '');
  const preds = p.relationships.filter(r => r.successor_id === a.id), succs = p.relationships.filter(r => r.predecessor_id === a.id);
  const lag = r => r.lag_hours ? ` ${r.lag_hours > 0 ? '+' : ''}${fmt1(daysOf(byId(r.predecessor_id) || a, r.lag_hours))}d` : '';
  const chipFor = (id, extra, drv) => `<button type="button" class="linkchip ${drv ? 'drv' : ''}" data-goto="${esc(id)}" title="${esc((byId(id) || {}).name || '')}${drv ? ' (driving: sets this start)' : ''}">${esc(id)}${esc(extra)}</button>`;
  const cals = Object.values(p.calendars).map(c => `<option value="${esc(c.id)}" ${(a.calendar_id || p.default_calendar_id) === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('');
  const cons = CONSTRAINTS.map(([v, l]) => `<option value="${v}" ${a.constraint === v ? 'selected' : ''}>${l}</option>`).join('');
  const codes = Object.keys(p.code_types).map(t => `<label>${esc(t)}<select data-code="${esc(t)}" id="iCode_${esc(t).replace(/\W+/g, '_')}"><option value="">None</option>${Object.keys(p.code_types[t]).map(v => `<option ${(a.codes || {})[t] === v ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select></label>`).join('');
  el.innerHTML = `
    <div class="insp-head"><div style="min-width:0;flex:1"><div class="id">${esc(a.id)}</div><h3>${esc(a.name)}</h3><div style="display:flex;gap:6px;margin-top:8px;flex-wrap:wrap">${status}${crit}</div></div>
</div>
    <div class="insp-dates">
      <div class="cell"><div class="k">${a.actual_start ? 'Actual start' : 'Start'}</div><div class="v">${fmtLong(a.actual_start || a.early_start)}</div></div>
      <div class="cell"><div class="k">${a.actual_finish ? 'Actual finish' : 'Finish'}</div><div class="v">${fmtLong(a.actual_finish || a.early_finish)}</div></div>
      <div class="cell"><div class="k">Latest start</div><div class="v">${fmtD(a.late_start)}</div></div>
      <div class="cell"><div class="k">Latest finish</div><div class="v">${fmtD(a.late_finish)}</div></div>
    </div>
    ${whyHtml(a)}
    <div class="form">
      <label>Name<input id="iName" value="${esc(a.name)}"></label>
      <div class="row2">
        <label>Duration, working days${a.type === 'task' ? stepper('iDur', fmt1(daysOf(a, a.duration_hours)), .5) : '<input disabled value="Milestone" id="iDurMs">'}</label>
        <label>Calendar<select id="iCal">${cals}</select></label>
      </div>
      <div class="insp-sec">Progress</div>
      <label>Complete <b id="iPctV" style="color:var(--ink)">${pct}%</b><input type="range" id="iPct" min="0" max="100" step="5" value="${pct}" aria-label="Percent complete"></label>
      <div class="row2"><label>Actual start<input type="date" id="iAS" value="${(a.actual_start || '').slice(0, 10)}"></label><label>Actual finish<input type="date" id="iAF" value="${(a.actual_finish || '').slice(0, 10)}"></label></div>
      ${a.status === 'in_progress' ? `<div class="row2"><label>Suspended on<input type="date" id="iSusp" value="${(a.suspend_date || '').slice(0, 10)}"></label><label>Resumes on<input type="date" id="iRes2" value="${(a.resume_date || '').slice(0, 10)}"></label></div>` : ''}
      <div class="insp-sec">Logic</div>
      <div class="bar-row trace-btns"><button type="button" class="btn" id="iTraceBack">Trace driving path</button><button type="button" class="btn" id="iTraceFwd">What it holds up</button></div>
      <div class="hint" style="font-size:12px">Waits for${preds.some(r => r.driving) ? ' · <b class="drv-key">bold</b> sets its start' : ''}</div>
      <div class="links-list">${preds.map(r => chipFor(r.predecessor_id, (r.type === 'FS' ? '' : ' ' + r.type) + lag(r), r.driving)).join('') || '<span class="hint" style="font-size:12.5px">Nothing. It can start on day one.</span>'}</div>
      <label>Predecessors<input id="iPreds" value="${esc(predsText(a))}" placeholder="A1010, A1020SS+2"></label>
      <div class="hint" style="font-size:12px">Holds up</div>
      <div class="links-list">${succs.map(r => chipFor(r.successor_id, r.type === 'FS' ? '' : ' ' + r.type)).join('') || '<span class="hint" style="font-size:12.5px">Nothing waits for it.</span>'}</div>
      <div class="insp-sec">Constraint and resources</div>
      <div class="row2"><label>Constraint<select id="iCon">${cons}</select></label><label>Date<input type="date" id="iConD" value="${a.constraint_date ? a.constraint_date.slice(0, 10) : ''}"></label></div>
      <label>Resources<input id="iRes" value="${esc(ALL_COLS.res.get(a))}" placeholder="Bricklayers, Scaffolders"></label>
      ${codes}
      ${fieldDefs(S.project).length ? `<div class="insp-sec">Custom fields</div>${fieldDefs(S.project).map(d => { const v = (a.fields || {})[d.name]; return `<label>${esc(d.name)}<input data-field="${esc(d.name)}" ${d.type === 'date' ? 'type="date"' : d.type === 'number' ? 'inputmode="decimal"' : ''} value="${esc(v == null ? '' : d.type === 'date' ? String(v).slice(0, 10) : String(v))}"></label>`; }).join('')}` : ''}
      <label>Notes<textarea id="iNotes" rows="3">${esc(a.notes || '')}</textarea></label>
    </div>`;
  const q = s => el.querySelector(s);
  wireSteppers(el);
  el.querySelectorAll('[data-goto]').forEach(b => b.onclick = () => { const id = b.dataset.goto; S.sel = new Set([id]); S.active = id; paintSelection(); const i = S.rowsCache.findIndex(r => rowKey(r) === id); if (i >= 0) scrollToRow(i); renderInspector(); });
  q('#iTraceBack').onclick = () => setTrace([a.id], 'back'); q('#iTraceFwd').onclick = () => setTrace([a.id], 'fwd');
  q('#iName').onchange = e => { const v = e.target.value.trim(); if (v) mutate(() => { a.name = v; }, null); };
  if (q('#iDur')) q('#iDur').onchange = e => mutate(() => { a.duration_hours = Math.max(0, +e.target.value || 0) * hpd(a); if (a.status === 'in_progress') a.remaining_hours = a.duration_hours * (1 - a.percent_complete / 100); }, `${a.id} is now ${fmt1(+e.target.value || 0)} days`);
  q('#iCal').onchange = e => mutate(() => { const old = hpd(a); a.calendar_id = e.target.value; a.duration_hours = a.duration_hours / old * hpd(a); }, `${a.id} calendar changed`);
  q('#iPct').oninput = e => { q('#iPctV').textContent = e.target.value + '%'; };
  q('#iPct').onchange = e => mutate(p => setProgress(a, +e.target.value, p.data_date ? new Date(p.data_date) : null), `${a.id} ${+e.target.value}% complete`);
  q('#iAS').onchange = e => mutate(() => { const v = e.target.value; a.actual_start = v ? v + 'T08:00:00' : null; actualiseStartMilestones(a); if (v && a.status === 'not_started') { a.status = 'in_progress'; a.remaining_hours = a.duration_hours; } if (!v && !a.actual_finish) { a.status = 'not_started'; a.percent_complete = 0; a.remaining_hours = null; } }, `${a.id} actual start set`);
  el.querySelectorAll('[data-why]').forEach(b => b.onclick = () => goToActivity(b.dataset.why));
  const why = el.querySelector('details.why'); if (why) why.ontoggle = () => { S.whyOpen = why.open; };
  if (q('#iSusp')) { q('#iSusp').onchange = e => mutate(() => { a.suspend_date = e.target.value ? e.target.value + 'T16:00:00' : null; if (!a.suspend_date) a.resume_date = null; }, e.target.value ? `${a.id} suspended` : `${a.id} no longer suspended`);
    q('#iRes2').onchange = e => mutate(() => { a.resume_date = e.target.value ? e.target.value + 'T08:00:00' : null; if (a.resume_date && !a.suspend_date) a.suspend_date = (S.project.data_date || a.actual_start); }, e.target.value ? `${a.id} resumes ${fmtD(e.target.value)}` : `${a.id} resume date cleared`); }
  q('#iAF').onchange = e => mutate(() => { const v = e.target.value; a.actual_finish = v ? v + 'T16:00:00' : null; if (v) { a.status = 'complete'; a.percent_complete = 100; a.remaining_hours = 0; if (!a.actual_start) a.actual_start = a.early_start; } else if (a.status === 'complete') { a.status = 'in_progress'; a.percent_complete = 90; a.remaining_hours = a.duration_hours * .1; } }, `${a.id} actual finish set`);
  q('#iPreds').onchange = e => mutate(() => setPreds(a, e.target.value), `${a.id} logic updated`);
  const setCon = () => mutate(() => { const c = q('#iCon').value, d = q('#iConD').value || (a.early_start || '').slice(0, 10); a.constraint = c; a.constraint_date = c === 'none' || c === 'as_late_as_possible' ? null : (d ? d + (c.includes('finish') ? 'T16:00:00' : 'T08:00:00') : null); if (c !== 'none' && c !== 'as_late_as_possible' && !a.constraint_date) a.constraint = 'none'; }, `${a.id} constraint updated`);
  q('#iCon').onchange = setCon; q('#iConD').onchange = setCon;
  q('#iRes').onchange = e => mutate(() => setResources(a, e.target.value), `${a.id} resources updated`);
  el.querySelectorAll('[data-code]').forEach(sel => sel.onchange = () => mutate(() => { a.codes = a.codes || {}; if (sel.value) a.codes[sel.dataset.code] = sel.value; else delete a.codes[sel.dataset.code]; }, null));
  q('#iNotes').onchange = e => mutate(() => { a.notes = e.target.value; }, null);
  el.querySelectorAll('[data-field]').forEach(inp => inp.onchange = () => { const d = fieldDefs(S.project).find(x => x.name === inp.dataset.field); if (!d) return; const v = parseField(d, inp.value); if (v === undefined) return toast(`${d.name} needs a ${d.type}`); mutate(() => setField(a, d.name, v), null); });
  if (focusId && q('#' + CSS.escape(focusId))) q('#' + CSS.escape(focusId)).focus({ preventScroll: true });
}



// ---------- chart notes (annotations), stored with the programme ----------
function noteDialog(n, date, actId) {
  const isNew = !n; n = n || { id: 'N' + Date.now().toString(36), date: date || S.project.data_date || S.project.start, activity_id: actId || null, text: '' };
  const { m } = modal(isNew ? 'Note on the chart' : 'Edit note', `<label>Note<textarea name="t" rows="3" style="width:100%" placeholder="e.g. Road closure booked; crane on site">${esc(n.text)}</textarea></label><div class="row2"><label>Date<input type="date" name="d" value="${String(n.date).slice(0, 10)}"></label><label>Row<select name="a"><option value="">Top of the chart</option>${S.project.activities.map(a => `<option value="${esc(a.id)}" ${a.id === n.activity_id ? 'selected' : ''}>${esc(a.id)} ${esc(a.name.slice(0, 40))}</option>`).join('')}</select></label></div>${isNew ? '' : '<button type="button" class="btn" id="nDel">Delete note</button>'}<p class="hint">Notes print as callouts on the PDF.</p>`,
    mm => { const t = mm.querySelector('[name=t]').value.trim(); if (!t) return false; const d = mm.querySelector('[name=d]').value, a = mm.querySelector('[name=a]').value || null;
      mutate(p => { p.annotations = (p.annotations || []).filter(x => x.id !== n.id).concat([{ id: n.id, date: (d || String(n.date).slice(0, 10)) + 'T12:00:00', activity_id: a, text: t }]); }, isNew ? 'Note added' : 'Note updated'); }, 'Save');
  const del = m.querySelector('#nDel'); if (del) del.onclick = () => { modalClose(); mutate(p => { p.annotations = (p.annotations || []).filter(x => x.id !== n.id); }, 'Note deleted'); };
}
// ---------- PDF for issue: the programme as shown (filters, grouping, columns), on A4-A1 with a title block ----------
// the briefing as the cover page of an issued PDF
function coverFor(o) {
  const p = S.project, b = getBriefing(), k = b.kpis || {}; const lastRev = (p.revisions || []).slice(-1)[0];
  const sub = [p.id, o.revision || (lastRev ? lastRev.name : ''), 'data date ' + fmtD(p.data_date || p.start)].filter(Boolean).join(' · ');
  return { title: o.title || 'Construction programme', subtitle: `${p.name} · ${sub}`, headline: b.headline, paragraphs: String(b.prose || '').split(/\n\n+/).filter(Boolean),
    kpis: [['Forecast finish', fmtD(k.finish || p.finish)], k.deadline ? ['Deadline', fmtD(k.deadline)] : null, ['Progress', `${Math.round(k.pct_complete || 0)}% (${Math.round(k.pct_expected || 0)}% expected)`], ['Critical activities', String(k.critical_open ?? 0)], k.spare_days != null ? [k.spare_days >= 0 ? 'Spare' : 'Overrun', `${fmt1(Math.abs(k.spare_days))} working days`] : null].filter(Boolean),
    milestones: (b.milestones || []).filter(m => m.date).sort((x, y) => x.date.localeCompare(y.date)), watch: (b.watch || []).map(w => ({ name: w.name, text: w.text })),
    footer: [o.prepared_by ? 'Prepared by ' + o.prepared_by : '', 'Printed ' + new Date().toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })].filter(Boolean).join(' · ') };
}
function pdfDoc(o) {
  const p = S.project, rs = S.rowsCache, cols = S.cols.filter(k => k !== 'preds' && k !== 'succs' && k !== 'notes' && k !== 'res').slice(0, 7);
  const columns = cols.map(k => ({ title: ALL_COLS[k].t, width_mm: Math.max(9, Math.round(ALL_COLS[k].w * .2)), align: ALL_COLS[k].num || ['start', 'finish', 'astart', 'afinish', 'bstart', 'bfinish', 'ls', 'lf'].includes(k) ? 'right' : 'left', indent: k === 'name' }));
  const clean = v => String(v == null ? '' : v).replace(/◆/g, '');
  const idx = {}; rs.forEach((r, i) => { if (r.act) idx[r.act.id] = i; });
  const rows = rs.map(r => {
    if (r.act) { const a = r.act, ms = a.type !== 'task' || a.duration_hours === 0; return { kind: ms ? 'milestone' : 'task', depth: r.depth, cells: cols.map(k => clean(ALL_COLS[k].get(a))), start: a.actual_start || a.early_start, finish: a.actual_finish || a.early_finish, critical: !!a.critical, pct: a.status === 'complete' ? 100 : Math.round(a.percent_complete || 0), baseline_start: a.baseline_start || null, baseline_finish: a.baseline_finish || null, late_finish: a.total_float_hours > 0 ? a.late_finish : null, label: barLabel(a) }; }
    const name = r.wbs ? r.wbs.name : r.group;
    return { kind: 'summary', depth: r.depth, cells: cols.map(k => k === 'name' ? name : k === 'id' ? (r.wbs ? r.wbs.code || '' : '') : k === 'start' ? fmtD(r.start) : k === 'finish' ? fmtD(r.finish) : k === 'pct' && r.pct != null ? Math.round(r.pct) + '%' : ''), start: r.start, finish: r.finish, critical: !!r.crit, pct: r.pct || 0, baseline_start: null, baseline_finish: null, late_finish: null, label: '' };
  });
  const links = p.relationships.filter(r => idx[r.predecessor_id] != null && idx[r.successor_id] != null).map(r => ({ from: idx[r.predecessor_id], to: idx[r.successor_id], type: r.type, critical: !!(byId(r.predecessor_id).critical && byId(r.successor_id).critical) }));
  const annotations = (p.annotations || []).map(n => ({ date: n.date, row: n.activity_id ? (idx[n.activity_id] ?? null) : null, text: n.text })).filter(n => !(n.row === null && false));
  const lastRev = (p.revisions || []).slice(-1)[0];
  return {
    meta: { project_name: p.name, project_id: p.id, client: o.client, revision: o.revision || (lastRev ? lastRev.name : ''), prepared_by: o.prepared_by, title: o.title || 'Construction programme', data_date: p.data_date || p.start, forecast_finish: p.finish, deadline: p.must_finish_by || null, printed_at: iso(new Date()), notes: o.notes || '' },
    page: { size: o.size, orientation: o.orientation, margins_mm: 10 },
    columns, rows, links, annotations,
    range: { t0: o.t0 || iso(S.t0), t1: o.t1 || iso(S.t1) },
    cover: o.cover ? coverFor(o) : null,
    options: { show_links: S.view.links, show_float: S.view.float, show_baseline: S.view.baseline, show_progress_line: S.view.progress, legend: true, rows_per_page: o.rows || null, fit_to_pages_wide: o.wide || 1, colour: o.colour },
  };
}
function printSheet() {
  if (!S.project) return; const P = window.PlannerPDF; if (!P) return toast('PDF output is not available on this page');
  if (S.screen !== 'plan') go('plan'); if (!S.rowsCache.length) render();
  let saved = {}; try { saved = JSON.parse(localStorage.getItem('pdfOpts') || '{}'); } catch { }
  const sel = (id, opts, v) => `<select id="${id}">${opts.map(([k, l]) => `<option value="${k}" ${String(v) === String(k) ? 'selected' : ''}>${l}</option>`).join('')}</select>`;
  const { m } = modal('PDF for issue', `<p class="hint" style="margin-top:-4px">Prints the programme as shown: the current filter, grouping, outline level, columns and bar options. ${S.rowsCache.length} rows.</p>
    <div class="risk-set">
      <label>Paper${sel('pSize', [['A3', 'A3'], ['A4', 'A4'], ['A2', 'A2'], ['A1', 'A1']], saved.size || 'A3')}</label>
      <label>Orientation${sel('pOri', [['landscape', 'Landscape'], ['portrait', 'Portrait']], saved.orientation || 'landscape')}</label>
      <label>Timescale across${sel('pWide', [[1, '1 page'], [2, '2 pages'], [3, '3 pages'], [4, '4 pages']], saved.wide || 1)}</label>
      <label>Rows per page${sel('pRows', [['', 'Fit to page'], [30, '30'], [45, '45'], [60, '60'], [100, '100']], saved.rows || '')}</label>
      <label>From<input type="date" id="pT0" value="${iso(S.t0).slice(0, 10)}"></label><label>To<input type="date" id="pT1" value="${iso(S.t1).slice(0, 10)}"></label>
      <label>Colour${sel('pCol', [['1', 'Colour'], ['0', 'Black and white']], saved.colour === false ? '0' : '1')}</label>
    </div>
    <h3>Title block</h3>
    <div class="risk-set"><label>Title<input id="pTitle" value="${esc(saved.title || 'Construction programme')}"></label><label>Client<input id="pClient" value="${esc(saved.client || '')}"></label><label>Prepared by<input id="pBy" value="${esc(saved.prepared_by || '')}"></label><label>Revision<input id="pRev" value="${esc(((S.project.revisions || []).slice(-1)[0] || {}).name || '')}"></label></div>
    <label class="sw" style="margin:8px 0"><span>Cover page: the briefing (status, what changed, watch list, milestones)</span><input type="checkbox" id="pCover" ${saved.cover === false ? '' : 'checked'}><i></i></label>
    <label>Notes in the title block<input id="pNotes" value="${esc((() => { try { return getBriefing().headline || ''; } catch { return ''; } })())}" placeholder="e.g. Programme for acceptance; durations in working days"></label>
    <p class="hint" id="pPlan"></p>`, async mm => {
      const o = readOpts(mm); try { localStorage.setItem('pdfOpts', JSON.stringify({ size: o.size, orientation: o.orientation, wide: o.wide, rows: o.rows, colour: o.colour, title: o.title, client: o.client, prepared_by: o.prepared_by, cover: o.cover })); } catch { }
      let bytes; try { bytes = P.render(pdfDoc(o)); } catch (e) { toast('PDF failed: ' + (e.message || e)); return false; }
      const name = `${S.project.id}${o.revision ? '-' + o.revision.replace(/\s+/g, '') : ''}.pdf`;
      if (await saveBlob(name, new Blob([bytes], { type: 'application/pdf' }))) toast(`${name} saved`);
    }, 'Create PDF', { wide: true });
  const readOpts = mm => ({ size: mm.querySelector('#pSize').value, orientation: mm.querySelector('#pOri').value, wide: +mm.querySelector('#pWide').value, rows: +mm.querySelector('#pRows').value || null, colour: mm.querySelector('#pCol').value === '1', t0: mm.querySelector('#pT0').value ? mm.querySelector('#pT0').value + 'T00:00:00' : null, t1: mm.querySelector('#pT1').value ? mm.querySelector('#pT1').value + 'T23:59:00' : null, title: mm.querySelector('#pTitle').value, client: mm.querySelector('#pClient').value, prepared_by: mm.querySelector('#pBy').value, revision: mm.querySelector('#pRev').value, notes: mm.querySelector('#pNotes').value, cover: mm.querySelector('#pCover').checked });
  const plan = () => { try { const L = P.layout(pdfDoc(readOpts(m))); m.querySelector('#pPlan').textContent = `${L.pages || L.page_count} page${(L.pages || L.page_count) === 1 ? '' : 's'}: ${L.rows_per_page} rows a page${L.pages_wide > 1 ? `, ${L.pages_wide} pages across` : ''}.`; } catch (e) { m.querySelector('#pPlan').textContent = ''; } };
  m.querySelectorAll('select, input').forEach(el => el.addEventListener('change', plan)); plan();
}
// ---------- progress periods: close a period, keep its record, draw its progress line ----------
// A period record is compact: for each activity [start, finish, % complete, status] as it stood at
// that data date, plus the headline numbers. Enough for its progress line and the as-built record.
function periodSnap(p) {
  const acts = {};
  p.activities.forEach(a => { const st = a.actual_start || a.early_start, fi = a.actual_finish || a.early_finish; if (!st || !fi) return; acts[a.id] = [st.slice(0, 16), fi.slice(0, 16), a.status === 'complete' ? 100 : Math.round(a.percent_complete || 0), a.status === 'complete' ? 'c' : a.status === 'in_progress' ? 'p' : 'n']; });
  const pr = progressOf(p);
  return { pct: Math.round(pr.pct * 10) / 10, planned_pct: Math.round(pr.planned * 10) / 10, finish: p.finish || null, acts };
}
const periodsOf = p => (p && p.progress_periods) || [];
const nextPeriod = p => 'Period ' + (periodsOf(p).length + 1);
function periodsShown(p) { const all = periodsOf(p), v = S.view.periods || 'none'; return v === 'all' ? all : v === 'last3' ? all.slice(-3) : v === 'last' ? all.slice(-1) : []; }
async function closePeriod(name, keepCopy) {
  const p = S.project, dd = p.data_date || p.start;
  const rec = { id: 'P' + Date.now().toString(36), name, data_date: dd, closed_at: iso(new Date()), ...periodSnap(p) };
  p.progress_periods = periodsOf(p).filter(x => x.data_date.slice(0, 10) !== dd.slice(0, 10)).concat([rec]).sort((a, b) => a.data_date.localeCompare(b.data_date));
  if (!S.view.periods || S.view.periods === 'none') { S.view.periods = 'last3'; const vp = $('#vPeriods'); if (vp) vp.value = 'last3'; }
  await save(`${name} closed at ${fmtD(dd)}. Its progress line is on the Gantt.`);
  if (keepCopy) await act('/revision', { name, note: 'Progress period closed at data date ' + fmtD(dd) });
}
function closePeriodDialog() {
  const p = S.project; if (!p) return; const dd = (p.data_date || p.start).slice(0, 10);
  const dup = periodsOf(p).find(x => x.data_date.slice(0, 10) === dd);
  modal('Close progress period', `<p class="hint" style="margin-top:-4px">Records where every activity stands at the data date, <b>${fmtD(dd)}</b>: actual dates, % complete and the forecast. Each closed period keeps its own progress line, and the as-built record builds up from them.</p>${dup ? `<p class="hint crit">${esc(dup.name)} already has this data date. Closing again replaces it.</p>` : ''}<label>Name<input name="n" value="${esc(dup ? dup.name : nextPeriod(p))}"></label><label class="sw" style="margin-top:6px"><span>Keep a full copy, so this period can be compared with later ones</span><input type="checkbox" name="rev" checked><i></i></label>`,
    m => closePeriod(m.querySelector('[name=n]').value.trim() || nextPeriod(p), m.querySelector('[name=rev]').checked), 'Close period');
}
function deletePeriod(id) { const pp = periodsOf(S.project).find(x => x.id === id); if (!pp) return; mutate(p => { p.progress_periods = periodsOf(p).filter(x => x.id !== id); }, `${pp.name} removed`); }
function periodLines(p, rs, x, RH, H) {      // dashed line per closed period, drawn from what was recorded then
  const per = periodsShown(p); let s = '';
  per.forEach((pp, k) => {
    const pdx = x(pp.data_date), op = (.45 + .45 * (k + 1) / per.length).toFixed(2); let d = `M${pdx},0`, any = false;
    rs.forEach((r, i) => { if (!r.act) return; const v = pp.acts[r.act.id]; if (!v) return; const [st, fi, pc, k2] = v, cy = i * RH + RH / 2;
      const px = k2 === 'c' ? pdx : k2 === 'p' ? x(st) + (x(fi) - x(st)) * pc / 100 : Math.min(x(st), pdx); d += ` L${px.toFixed(1)},${cy}`; any = true; });
    if (!any) return; d += ` L${pdx},${H}`;
    s += `<path class="pline" d="${d}" fill="none" stroke="var(--period)" stroke-width="1.5" stroke-dasharray="6 3" stroke-linejoin="round" opacity="${op}" pointer-events="none"/><text x="${pdx + 4}" y="11" font-size="10" font-weight="600" fill="var(--period)" opacity="${op}" pointer-events="none">${esc(pp.name)}</text>`;
  });
  return s;
}
function periodsPanel(p) {
  const per = periodsOf(p), revs = new Set((p.revisions || []).map(r => r.name));
  const rows = per.map((pp, i) => { const prev = per[i - 1]; const mv = prev && prev.finish && pp.finish ? Math.round((ms(pp.finish.slice(0, 10)) - ms(prev.finish.slice(0, 10))) / DAY) : null;
    return `<div class="li"><div style="min-width:0"><div class="t">${esc(pp.name)} <span class="hint" style="font-weight:400">· ${fmtD(pp.data_date)}</span></div><div class="s">${Math.round(pp.pct)}% done against ${Math.round(pp.planned_pct)}% expected · finish ${fmtD(pp.finish)}${mv == null ? '' : mv === 0 ? ' · finish held' : ` · finish <b class="${mv > 0 ? 'crit' : 'okc'}">${Math.abs(mv)} day${Math.abs(mv) === 1 ? '' : 's'} ${mv > 0 ? 'later' : 'earlier'}</b>`}</div></div><span style="display:flex;gap:6px">${revs.has(pp.name) ? `<button type="button" class="btn" data-pcmp="${esc(pp.name)}">Compare</button>` : ''}<button type="button" class="icon" data-pdel="${esc(pp.id)}" aria-label="Remove ${esc(pp.name)}" title="Remove this period"><svg viewBox="0 0 20 20" class="ic"><path d="M5 5l10 10M15 5L5 15"/></svg></button></span></div>`; }).reverse().join('');
  return `<section class="panel" aria-labelledby="hPer"><div class="panel-head"><h2 id="hPer">Progress periods</h2><span style="display:flex;gap:8px;flex-wrap:wrap"><button type="button" class="btn" id="perBuilt" ${per.length || p.activities.some(a => a.actual_start) ? '' : 'disabled'}>As-built record</button><button type="button" class="primary" id="perClose">Close period</button></span></div>
    ${per.length ? `<div class="list">${rows}</div>` : '<p class="hint" style="margin:0">None closed yet. Record progress (Site update), then close the period: it keeps a progress line on the Gantt and builds the as-built record.</p>'}</section>`;
}
// as-built record: actual against baseline, and the period each activity started and finished in
const csvCell = v => { if (typeof v === 'number') return String(v); v = v == null ? '' : String(v); const f = /^[=+\-@\t\r]/.test(v); return f || /[",\n\r]/.test(v) ? '"' + (f ? "'" : '') + v.replace(/"/g, '""') + '"' : v; };
function asBuiltCsv(p) {
  const per = periodsOf(p), d10 = s => (s || '').slice(0, 10), days = (a, b) => a && b ? Math.round((ms(d10(b)) - ms(d10(a))) / DAY) : '';
  const firstIn = (id, ok) => { const pp = per.find(q => q.acts[id] && ok(q.acts[id][3])); return pp ? pp.name : ''; };
  const head = ['ID', 'Activity', 'WBS', 'Status', '% complete', 'Planned duration (working days)', 'Baseline start', 'Baseline finish', 'Actual start', 'Actual finish', 'Actual duration (calendar days)', 'Start variance (days, + is late)', 'Finish variance (days, + is late)', 'Started in period', 'Finished in period'];
  const lines = [head.map(csvCell).join(',')];
  p.activities.filter(a => a.type !== 'wbs_summary').forEach(a => {
    const w = wbsById(a.wbs_id);
    lines.push([a.id, a.name, w ? w.name : '', a.status === 'complete' ? 'Complete' : a.status === 'in_progress' ? 'In progress' : 'Not started', a.status === 'complete' ? 100 : Math.round(a.percent_complete || 0), a.type === 'task' ? fmt1(daysOf(a, a.duration_hours)) : 0, d10(a.baseline_start), d10(a.baseline_finish), d10(a.actual_start), d10(a.actual_finish),
      a.actual_start && a.actual_finish ? days(a.actual_start, a.actual_finish) + 1 : '', a.actual_start && a.baseline_start ? days(a.baseline_start, a.actual_start) : '', a.actual_finish && a.baseline_finish ? days(a.baseline_finish, a.actual_finish) : '',
      firstIn(a.id, k => k !== 'n'), firstIn(a.id, k => k === 'c')].map(csvCell).join(','));
  });
  return '﻿' + lines.join('\r\n') + '\r\n';
}
async function exportAsBuilt() {
  const p = S.project; if (!p) return; const n = p.activities.filter(a => a.actual_start).length;
  if (await saveBlob(`${p.id}-as-built.csv`, new Blob([asBuiltCsv(p)], { type: 'text/csv;charset=utf-8' }))) toast(`As-built record saved: ${n} activit${n === 1 ? 'y' : 'ies'} started${p.baselines.length ? '' : '. Set a baseline to get variances.'}`, { ms: 4200 });
}

// ---------- site update: a phone-first sheet for recording progress on the activities in hand ----------
function siteList(p) {
  const dd = new Date(p.data_date || p.start), horizon = +dd + 14 * DAY;
  return p.activities.filter(a => (a.type === 'task' || a.type.endsWith('milestone')) && a.status !== 'complete' && (a.status === 'in_progress' || (a.early_start && +new Date(a.early_start) <= horizon) || (a.baseline_start && +new Date(a.baseline_start) <= +dd)))
    .sort((a, b) => (b.status === 'in_progress') - (a.status === 'in_progress') || (a.actual_start || a.early_start || '').localeCompare(b.actual_start || b.early_start || '')).slice(0, 60);
}
function siteUpdateSheet() {
  const p = S.project; if (!p) return; const acts = siteList(p);
  const asOf0 = (p.data_date || p.start).slice(0, 10), today = iso(new Date()).slice(0, 10);
  const U = {};       // staged updates by id: {st:'n'|'p'|'c', sdate, fdate, pct, left, mode}
  const init = a => ({ st: a.status === 'in_progress' ? 'p' : 'n', sdate: a.actual_start ? a.actual_start.slice(0, 10) : '', fdate: '', pct: Math.round(a.percent_complete || 0), left: +fmt1(daysOf(a, a.remaining_hours != null ? a.remaining_hours : a.duration_hours)), mode: 'pct' });
  const ms_ = a => a.type !== 'task';
  const card = a => { const u = U[a.id] || init(a), o = init(a), ch = !!U[a.id]; const behind = a.status === 'not_started' && a.baseline_start && a.baseline_start.slice(0, 10) < asOf0;
    const seg = ms_(a) ? [['n', 'Not yet'], ['c', 'Achieved']] : [['n', 'Not started'], ['p', 'Started'], ['c', 'Finished']];
    return `<div class="su ${ch ? 'changed' : ''}" data-id="${esc(a.id)}"><div class="su-h"><div style="min-width:0"><b>${a.critical ? '<span class="swatch" style="background:var(--crit)" title="Critical"></span>' : ''}${esc(a.name)}</b><div class="hint"><span class="mono">${esc(a.id)}</span> · ${a.status === 'in_progress' ? 'started ' + fmtD(a.actual_start) : (ms_(a) ? 'due ' : 'planned ') + fmtD(a.early_start)}${ms_(a) ? '' : ' to ' + fmtD(a.early_finish)}${behind ? ' · <b class="crit">behind baseline</b>' : ''}</div></div></div>
      <div class="miniseg su-st" role="group" aria-label="Status of ${esc(a.name)}">${seg.map(([k, l]) => `<button type="button" data-st="${k}" class="${u.st === k ? 'on' : ''}" aria-pressed="${u.st === k}">${l}</button>`).join('')}</div>
      ${u.st === 'p' && !ms_(a) ? `<div class="su-row"><span class="su-l">Done</span><div class="miniseg su-pct">${[10, 25, 50, 75, 90].map(v => `<button type="button" data-pct="${v}" class="${u.mode === 'pct' && u.pct === v ? 'on' : ''}">${v}%</button>`).join('')}</div></div>
        <div class="su-row"><span class="su-l">or days left</span><div class="stepper"><button type="button" data-left="-1" aria-label="One day fewer">−</button><output>${fmt1(u.left)}</output><button type="button" data-left="1" aria-label="One day more">+</button></div><span class="hint">${u.mode === 'left' ? `about ${u.pct}% done` : ''}</span></div>` : ''}
      ${(u.st === 'p' && o.st !== 'p') || (u.st === 'c' && !a.actual_start && !ms_(a)) ? `<label class="su-row"><span class="su-l">Started on</span><input type="date" data-d="sdate" value="${u.sdate || ''}"></label>` : ''}
      ${u.st === 'c' ? `<label class="su-row"><span class="su-l">${ms_(a) ? 'Achieved on' : 'Finished on'}</span><input type="date" data-d="fdate" value="${u.fdate || ''}"></label>` : ''}
    </div>`; };
  const { m } = modal('Site update', `<p class="hint" style="margin-top:-4px">Work in progress, and anything due in the next two weeks. Tap what happened. A start left blank is taken as planned; a finish left blank is the as-of date.</p>
    <div class="su-asof"><label>As of<input type="date" id="suAsOf" value="${asOf0}"></label>${today > asOf0 ? `<button type="button" class="btn" id="suToday">Today</button>` : ''}<span class="hint" id="suCount"></span></div>
    <div id="suList">${acts.length ? '' : '<div class="empty"><b>Nothing in hand</b>No work is in progress or due in the next two weeks.</div>'}</div>
    <label class="sw" style="margin-top:10px"><span>Close the progress period after saving</span><input type="checkbox" id="suClose"><i></i></label>`,
    async () => {
      const asOf = m.querySelector('#suAsOf').value || asOf0, ids = Object.keys(U);
      if (!ids.length) { toast('Nothing changed'); return false; }
      const bad = ids.find(id => [U[id].sdate, U[id].fdate].some(d => d && d > asOf)); if (bad) { toast(`${bad}: a date is after the as-of date ${fmtD(asOf)}`, { ms: 4200 }); return false; }
      const bad2 = ids.find(id => U[id].sdate && U[id].fdate && U[id].fdate < U[id].sdate); if (bad2) { toast(`${bad2}: finishes before it starts`, { ms: 4200 }); return false; }
      ids.forEach(id => { const a = byId(id); if (a) applySiteUpdate(a, U[id], asOf); });
      S.project.data_date = asOf + 'T08:00:00';
      const closeAfter = m.querySelector('#suClose').checked;
      await save(`Site update: ${ids.length} activit${ids.length === 1 ? 'y' : 'ies'} as of ${fmtD(asOf)}`);
      if (closeAfter) await closePeriod(nextPeriod(S.project), true);
    }, 'Save update', { wide: true });
  m.classList.add('su-sheet');
  const list = m.querySelector('#suList'), byIdLocal = Object.fromEntries(acts.map(a => [a.id, a]));
  const count = () => { const n = Object.keys(U).length; m.querySelector('#suCount').textContent = n ? `${n} change${n === 1 ? '' : 's'}` : ''; };
  const paint = id => { const a = byIdLocal[id], el = list.querySelector(`.su[data-id="${CSS.escape(id)}"]`); const t = document.createElement('div'); t.innerHTML = card(a); el.replaceWith(t.firstElementChild); count(); };
  if (acts.length) list.innerHTML = acts.map(card).join('');
  const touch = (a, f) => { const u = U[a.id] || init(a); f(u); const o = init(a); if (u.st === o.st && u.pct === o.pct && u.left === o.left && !u.fdate && u.sdate === o.sdate) delete U[a.id]; else U[a.id] = u; paint(a.id); };
  list.addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return; const a = byIdLocal[b.closest('.su').dataset.id]; if (!a) return;
    const dur = daysOf(a, a.duration_hours);
    if (b.dataset.st) touch(a, u => { u.st = b.dataset.st; if (u.st === 'p' && u.pct === 0 && a.status !== 'in_progress') { u.pct = 0; } });
    else if (b.dataset.pct) touch(a, u => { u.pct = +b.dataset.pct; u.mode = 'pct'; u.left = +fmt1(dur * (1 - u.pct / 100)); });
    else if (b.dataset.left) touch(a, u => { u.left = Math.max(0.5, +fmt1(u.left + +b.dataset.left)); u.mode = 'left'; u.pct = dur ? Math.max(0, Math.min(99, Math.round(100 * (1 - u.left / dur)))) : 0; });
  });
  list.addEventListener('change', e => { const inp = e.target.closest('input[data-d]'); if (!inp) return; const a = byIdLocal[inp.closest('.su').dataset.id]; touch(a, u => { u[inp.dataset.d] = inp.value; }); });
  const td = m.querySelector('#suToday'); if (td) td.onclick = () => { m.querySelector('#suAsOf').value = today; td.remove(); };
}
function applySiteUpdate(a, u, asOf) {
  const at = (d, t) => (d || asOf) + t, h = hpd(a);
  const st0 = () => u.sdate ? u.sdate + 'T08:00:00' : a.early_start && a.early_start.slice(0, 10) <= asOf ? a.early_start : asOf + 'T08:00:00';   // no date given: as planned, unless that is after the as-of date
  if (u.st === 'n') { setProgress(a, 0, null); return; }
  if (u.st === 'c') {
    if (a.type !== 'task') { const t = at(u.fdate, a.type === 'finish_milestone' ? 'T16:00:00' : 'T08:00:00'); a.status = 'complete'; a.percent_complete = 100; a.remaining_hours = 0; a.actual_start = a.actual_finish = t; }
    else { a.status = 'complete'; a.percent_complete = 100; a.remaining_hours = 0; if (!a.actual_start || u.sdate) a.actual_start = st0(); if (u.fdate && a.actual_start.slice(0, 10) > u.fdate) a.actual_start = u.fdate + 'T08:00:00'; a.actual_finish = at(u.fdate, 'T16:00:00'); }
  } else {
    a.status = 'in_progress'; a.actual_finish = null; if (!a.actual_start || u.sdate) a.actual_start = st0();
    if (u.mode === 'left') { a.remaining_hours = Math.max(0, u.left * h); a.percent_complete = u.pct; }
    else { a.percent_complete = u.pct; a.remaining_hours = a.duration_hours * (1 - u.pct / 100); }
  }
  actualiseStartMilestones(a);
}
// ---------- issued revisions and version comparison ----------
const nextRev = p => 'Rev ' + String.fromCharCode(65 + ((p && p.revisions) || []).length % 26);
function revisionDialog() {
  if (!S.project) return;
  modal('Issue revision', `<p class="hint" style="margin-top:-4px">Freezes the programme as it is now, so later versions can be compared with what was issued.</p><label>Name<input name="n" value="${esc(nextRev(S.project))}"></label><label>Note<input name="note" placeholder="e.g. Issued to client for acceptance"></label>`,
    m => act('/revision', { name: m.querySelector('[name=n]').value.trim() || nextRev(S.project), note: m.querySelector('[name=note]').value.trim() }), 'Issue');
}
async function compareSheet(preset) {
  if (!S.project) return; const E = window.PlannerEngine; if (!E || !E.compareProjects) return toast('Comparison is not available on this page');
  const revs = (S.project.revisions || []).slice().reverse(), others = (S.list || []).filter(x => x.id !== S.pid);
  const opts = revs.map(r => `<option value="rev:${esc(r.name)}">${esc(r.name)} · issued ${fmtD(r.issued_at)}</option>`).join('') + others.map(o => `<option value="prj:${esc(o.id)}">${esc(o.name)} (${esc(o.id)})</option>`).join('');
  const { m } = modal('Compare versions', `<div class="cmp-pick"><label>Compare the current programme with<select id="cmpSrc">${opts}<option value="file">A file (XER, P6 XML, MS Project XML, JSON)…</option></select></label><button type="button" class="primary" id="cmpGo">Compare</button></div><input type="file" id="cmpFile" accept=".xer,.xml,.pmxml,.mspdi,.json" hidden><div id="cmpOut">${revs.length ? '' : '<p class="hint">No revisions issued yet. Issue one from More → Issue revision, or when you export.</p>'}</div>`, null, '', { wide: true });
  const run = async old => { try { renderCompare(m.querySelector('#cmpOut'), E.compareProjects(old, S.project)); } catch (e) { m.querySelector('#cmpOut').innerHTML = `<p class="crit">${esc(e.message || e)}</p>`; } };
  const go = async () => {
    const v = m.querySelector('#cmpSrc').value;
    if (v === 'file') return m.querySelector('#cmpFile').click();
    if (v.startsWith('rev:')) { const r = revs.find(x => 'rev:' + x.name === v); return run(r.project); }
    if (v.startsWith('prj:')) { const d = await api('/api/projects/' + encodeURIComponent(v.slice(4))); return run(d.project); }
  };
  m.querySelector('#cmpGo').onclick = go;
  m.querySelector('#cmpFile').onchange = async e => { const f = e.target.files[0]; if (!f) return; try { const old = E.readAny(f.name, new Uint8Array(await f.arrayBuffer())); await run(old); } catch (err) { m.querySelector('#cmpOut').innerHTML = `<p class="crit">${esc(err.message || err)}</p>`; } e.target.value = ''; };
  if (preset) { m.querySelector('#cmpOut').innerHTML = ''; renderCompare(m.querySelector('#cmpOut'), preset); }
  else if (revs.length || others.length) go();
}
function renderCompare(out, r) {
  const E = window.PlannerEngine, text = E.compareNarrative(r), sm = r.summary, c = sm.counts || {};
  const sh = sm.finish_shift_days, shTxt = sh == null ? '–' : sh === 0 ? 'No change' : (sh > 0 ? '+' : '') + sh + 'd';
  const row = (id, name, extra) => `<button type="button" class="crow" data-goto="${esc(id)}" style="grid-template-columns:64px minmax(0,1fr) auto"><span class="cid">${esc(id)}</span><span class="cname">${esc(name || '')}</span><b>${esc(extra || '')}</b></button>`;
  const sec = (title, items) => items.length ? `<h3>${esc(title)}</h3><div class="crit-list">${items.join('')}</div>` : '';
  const moves = (r.date_moves || []).slice(0, 12).map(d => row(d.id, d.name, (d.finish_shift_days > 0 ? '+' : '') + d.finish_shift_days + 'd'));
  const drivers = (r.finish_drivers || []).map(d => row(d.id, d.name, (d.changes || []).map(x => x.kind.replace('_', ' ')).join(', ')));
  out.innerHTML = `<div class="kpis rk-kpis"><div class="kpi"><div class="k">Finish</div><div class="big ${sh > 0 ? 'bad' : sh < 0 ? 'ok' : ''}">${shTxt}</div><div class="note">${fmtD(sm.old_finish)} → ${fmtD(sm.new_finish)}</div></div>
      <div class="kpi"><div class="k">Critical path</div><div class="big">${sm.critical_path_changed ? 'Changed' : 'Same'}</div><div class="note">${(r.critical.joined || []).length} joined · ${(r.critical.left || []).length} left</div></div>
      <div class="kpi"><div class="k">Activities</div><div class="big">${(c.added || 0) + (c.removed || 0) + (c.duration_changes || 0)}</div><div class="note">${c.added || 0} added · ${c.removed || 0} removed · ${c.duration_changes || 0} durations</div></div>
      <div class="kpi"><div class="k">Logic</div><div class="big">${(c.logic_added || 0) + (c.logic_removed || 0) + (c.logic_changed || 0)}</div><div class="note">${c.logic_added || 0} added · ${c.logic_removed || 0} removed · ${c.logic_changed || 0} changed</div></div></div>
    <h3>Commentary</h3><div class="cmp-text" id="cmpText">${esc(text).replace(/\n\n/g, '</p><p>').replace(/^/, '<p>') + '</p>'}</div>
    <div class="bar-row" style="margin:8px 0 4px"><button type="button" class="btn" id="cmpCopy">Copy commentary</button><button type="button" class="btn" id="cmpAi" hidden>Rewrite with Claude</button></div>
    ${sec('What moved the finish', drivers)}${sec('Biggest date moves', moves)}
    ${sec('Added', (r.added || []).map(a => row(a.id, a.name, 'new')))}${sec('Removed', (r.removed || []).map(a => row(a.id, a.name, 'removed')))}
    ${sec('Durations', (r.duration_changes || []).slice(0, 20).map(d => row(d.id, d.name, `${d.old_days}d → ${d.new_days}d`)))}
    ${sec('Logic', [...(r.logic_added || []).map(l => row(l.succ, `${l.pred} → ${l.succ} ${l.type}${l.lag_days ? ' ' + (l.lag_days > 0 ? '+' : '') + l.lag_days + 'd' : ''}`, 'added')), ...(r.logic_removed || []).map(l => row(l.succ, `${l.pred} → ${l.succ} ${l.type}`, 'removed')), ...(r.logic_changed || []).map(l => row(l.succ, `${l.pred} → ${l.succ} ${l.old_type}${l.old_lag_days ? ' ' + l.old_lag_days + 'd' : ''} → ${l.new_type}${l.new_lag_days ? ' ' + l.new_lag_days + 'd' : ''}`, 'changed'))].slice(0, 30))}`;
  out.querySelectorAll('[data-goto]').forEach(b => b.onclick = () => { modalClose(); setTimeout(() => goToActivity(b.dataset.goto), 250); });
  out.querySelector('#cmpCopy').onclick = async () => { try { await navigator.clipboard.writeText(out.querySelector('#cmpText').innerText); toast('Commentary copied'); } catch { toast('Select the text and copy it'); } };
  const ai = out.querySelector('#cmpAi');
  (LOCAL ? getSample() : Promise.resolve(null)).then(sample => { if (!sample) return; ai.hidden = false; ai.onclick = async () => {
    ai.disabled = true; const box = out.querySelector('#cmpText'), orig = box.innerHTML; box.innerHTML = '<p class="hint">Thinking…</p>';
    try { const { text: t } = await sample(`You are a UK construction planner writing the programme commentary that accompanies a revised programme. Rewrite the draft below into clear, professional prose for a client and project manager: lead with the change to completion, then the causes on the critical path, then other notable changes. Keep every number, date and activity id exactly as given; do not add facts. Under 220 words, British English, no headings or bullet points.\n\nDRAFT:\n${text}\n\nSTRUCTURED CHANGES (for reference, JSON):\n${JSON.stringify({ summary: r.summary, finish_drivers: r.finish_drivers }).slice(0, 12000)}`, { onText: ({ text: tt }) => { box.innerHTML = '<p>' + esc(tt).replace(/\n\n/g, '</p><p>') + '</p>'; } });
      box.innerHTML = '<p>' + esc(t).replace(/\n\n/g, '</p><p>') + '</p>'; }
    catch (e) { box.innerHTML = orig; toast(AI_ERRORS[e && e.code] || 'Claude could not rewrite it'); }
    finally { ai.disabled = false; } }; });
}
// ---------- guardrails: why this date, drag, out-of-sequence progress ----------
function oosList() { try { const E = window.PlannerEngine; return S.project && E && E.outOfSequence ? E.outOfSequence(S.project) : []; } catch { return []; } }
function oosDialog() {
  const list = oosList(); if (!list.length) return toast('No out-of-sequence progress');
  const { m } = modal(`${list.length} out of sequence`, `<p class="hint" style="margin-top:-4px">Progress recorded against the logic. Either record the predecessor's actual dates, or change the link if the work really overlaps (often FS to SS with a lag). The schedule keeps the remaining work behind its predecessors (retained logic) until you do.</p>
    <div class="crit-list">${list.map(o => `<button type="button" class="crow" data-goto="${esc(o.successor)}" style="grid-template-columns:64px minmax(0,1fr)"><span class="cid">${esc(o.successor)}</span><span class="cname" style="white-space:normal"><b>${esc(o.successor_name)}</b> ${esc(o.reason)}: <span class="mono">${esc(o.predecessor)}</span> ${esc(o.predecessor_name)} (${esc(o.type)})</span></button>`).join('')}</div>`, null, '', { wide: true });
  m.querySelectorAll('[data-goto]').forEach(b => b.onclick = () => { modalClose(); setTimeout(() => goToActivity(b.dataset.goto), 250); });
}
function computeDrag(silent) {
  const E = window.PlannerEngine; if (!S.project || !E || !E.criticalDrag) return;
  const list = E.criticalDrag(S.project); S.dragMap = Object.fromEntries(list.map(d => [d.id, d.drag_days])); S.dragStamp = S.project.scheduled_at;
  if (!S.cols.includes('drag')) { const i = S.cols.indexOf('tf'); S.cols.splice(i >= 0 ? i + 1 : S.cols.length, 0, 'drag'); }
  if (!silent) { go('plan'); const top = list.filter(d => d.drag_days > 0).slice(0, 3); toast(top.length ? 'Biggest drag: ' + top.map(d => `${d.id} ${d.drag_days}d`).join(', ') + '. Shorten these to bring the finish in.' : 'No single activity adds to the finish: parallel paths would take over.', { ms: 7000 }); }
}
// walk the driving links back from an activity and say, in words, what sets its date
function whyChain(a) {
  const p = S.project, steps = [], seen = new Set(); let cur = a;
  const lagTxt = (r, pred) => r.lag_hours ? ` ${r.lag_hours > 0 ? '+' : ''}${fmt1(daysOf(pred, r.lag_hours))}d` : '';
  const verb = { FS: ['starts after', 'finishes'], SS: ['starts after', 'starts'], FF: ['finishes after', 'finishes'], SF: ['finishes after', 'starts'] };
  for (let i = 0; i < 40 && cur && !seen.has(cur.id); i++) {
    seen.add(cur.id);
    if (cur.status === 'complete') { steps.push({ id: cur.id, text: 'is complete (actual dates)' }); break; }
    if (cur.status === 'in_progress') { steps.push({ id: cur.id, text: `started ${fmtD(cur.actual_start)}; remaining work runs from ${cur.resume_date && cur.resume_date > (p.data_date || p.start) ? 'its resume date ' + fmtD(cur.resume_date) : 'the data date ' + fmtD(p.data_date || p.start)}` }); break; }
    const drv = p.relationships.filter(r => r.successor_id === cur.id && r.driving);
    if (drv.length) { const r = drv[0], pred = byId(r.predecessor_id); const [v1, v2] = verb[r.type] || verb.FS; steps.push({ id: cur.id, text: `${v1} ${r.predecessor_id} ${v2} (${r.type}${lagTxt(r, pred)})`, next: r.predecessor_id }); cur = pred; continue; }
    const c = cur.constraint || 'none';
    if (c !== 'none' && c !== 'as_late_as_possible' && cur.constraint_date) { steps.push({ id: cur.id, text: `held by its constraint: ${c.replaceAll('_', ' ')} ${fmtD(cur.constraint_date)}` }); break; }
    const dd = (p.data_date || p.start || '').slice(0, 10), es = (cur.early_start || '').slice(0, 10);
    steps.push({ id: cur.id, text: p.data_date && es === dd ? `can't start before the data date ${fmtD(p.data_date)}` : es === (p.start || '').slice(0, 10) ? 'starts at the project start' : 'starts as soon as its calendar allows' });
    break;
  }
  return steps;
}
function whyHtml(a) {
  if (!S.project || !a.early_start) return '';
  const steps = whyChain(a); if (!steps.length) return '';
  const bl = a.baseline_start ? workingDaysBetween(calOf(a), new Date(a.baseline_start), new Date(a.actual_start || a.early_start)) : null;
  return `<details class="why" ${S.whyOpen ? 'open' : ''}><summary>Why ${a.status === 'not_started' ? 'it starts' : 'this date'} ${fmtD(a.actual_start || a.early_start)}${bl ? ` <span class="chip ${bl > 0 ? 'bad' : 'ok'}">${bl > 0 ? '+' : ''}${bl}d vs baseline</span>` : ''}</summary><ol>${steps.map(st => `<li><button type="button" class="linkchip" data-why="${esc(st.id)}">${esc(st.id)}</button> ${esc(st.text)}</li>`).join('')}</ol></details>`;
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
  paintSelection(); if (S.inspector) renderInspector();
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
  const cell = row.querySelector(`.c[data-col="${CSS.escape(col)}"]`); if (!cell) return;
  if (w) { if (col !== 'name') return; cell.innerHTML = `<input value="${esc(w.name)}">`; }
  else if (a) {
    if (c.options) { const opts = c.options(); cell.innerHTML = `<select>${opts.map(([v, t]) => `<option value="${esc(v)}" ${(a.calendar_id || S.project.default_calendar_id) === v ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select>`; }
    else if (c.field && c.field.type === 'date') { const v = String((a.fields || {})[c.field.name] || '').slice(0, 10); cell.innerHTML = `<input type="date" value="${esc(v)}">`; }
    else if (c.set) { let v = c.get(a); if (col === 'dur') v = String(fmt1(daysOf(a, a.duration_hours))); if (c.field) v = String(fieldRaw(a, col)); if (['start', 'finish', 'astart', 'afinish'].includes(col)) { const d = { start: a.actual_start || a.early_start, finish: a.actual_finish || a.early_finish, astart: a.actual_start, afinish: a.actual_finish }[col]; v = d ? d.slice(0, 10) : ''; cell.innerHTML = `<input type="date" value="${v}">`; } else if (col === 'pct') { cell.innerHTML = `<input type="number" min="0" max="100" value="${a.status === 'not_started' ? 0 : a.percent_complete}">`; } else cell.innerHTML = `<input value="${esc(v)}">`; }
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
  S.active = keys[i]; S.activeCol = S.cols[ci]; S.sel = new Set([S.active]); paintSelection(); scrollToRow(i); ensureColVisible(S.activeCol); if (S.inspector) renderInspector();
}
function scrollToRow(i) { const sheet = $('#sheet'); const y = HDR + i * RH; if (y < sheet.scrollTop + HDR) sheet.scrollTop = y - HDR; else if (y + RH > sheet.scrollTop + sheet.clientHeight) sheet.scrollTop = y + RH - sheet.clientHeight; }

// ---------- chart wiring: drag move / resize / link ----------
function wireChart() {
  const svg = $('svg.chart'); if (!svg) return;
  svg.querySelectorAll('.rowbg').forEach(r => { r.onmousedown = e => { if (e.button === 0) selectRow(r.dataset.key, e); }; r.oncontextmenu = e => { e.preventDefault(); if (!S.sel.has(r.dataset.key)) selectRow(r.dataset.key, e); const pt = svgPoint(svg, e); S.ctxAt = { date: iso(new Date(+S.t0 + (pt.x - GX) / S.view.pxDay * DAY)), key: r.dataset.key }; contextMenu(e.clientX, e.clientY); S.ctxAt = null; }; });
  svg.querySelectorAll('.note[data-note]').forEach(n => { n.onmousedown = e => e.stopPropagation(); n.onclick = e => { e.stopPropagation(); const a = (S.project.annotations || []).find(x => x.id === n.dataset.note); if (a) noteDialog(a); }; });
  svg.querySelectorAll('.bar[data-id]').forEach(b => {
    b.onpointerdown = e => { if (e.button !== 0) return; e.stopPropagation(); e.preventDefault(); if (!S.sel.has(b.dataset.id)) selectRow(b.dataset.id, e); startDrag(e, 'move', b.dataset.id, b); };
    b.onmousemove = e => tipFor(e, byId(b.dataset.id)); b.onmouseleave = hideTip;
    b.oncontextmenu = e => { e.preventDefault(); e.stopPropagation(); if (!S.sel.has(b.dataset.id)) selectRow(b.dataset.id, e); contextMenu(e.clientX, e.clientY); };
    b.ondblclick = () => openInspector(b.dataset.id);
  });
  svg.querySelectorAll('.handle').forEach(h => { h.onpointerdown = e => { if (e.button !== 0) return; e.stopPropagation(); e.preventDefault(); if (!S.sel.has(h.dataset.id)) selectRow(h.dataset.id, e); startDrag(e, 'resize', h.dataset.id, h); }; h.ondblclick = () => openInspector(h.dataset.id); h.onmousemove = e => tipFor(e, byId(h.dataset.id)); h.onmouseleave = hideTip; });
  svg.querySelectorAll('.linkdot').forEach(d => d.onpointerdown = e => { if (e.button !== 0) return; e.stopPropagation(); e.preventDefault(); startDrag(e, 'link', d.dataset.id, d); });
  svg.querySelectorAll('.link').forEach(l => { l.onmousedown = e => { e.stopPropagation(); S.selLink = { p: l.dataset.p, s: l.dataset.s }; S.sel = new Set(); paintSelection(); }; l.ondblclick = e => { e.stopPropagation(); linkDialog(l.dataset.p, l.dataset.s); }; });
}
// ---------- Asta-style dragging ----------
// Move the bar (push later, pull earlier), drag either end (start or finish), or drag from a link dot onto
// another bar (the ends you leave and land on set FS / SS / FF / SF). While you drag, the programme is
// recalculated live so successors follow; on release the change is saved. Moving sets "start on or
// after", as Asta does; pulling earlier than the logic allows snaps to the earliest start and says why.
const LIVE_LIMIT = 1500;
const ENGINE = () => window.PlannerEngine && window.PlannerEngine.schedule ? window.PlannerEngine : null;
function cloneProject() { return JSON.parse(JSON.stringify(S.project)); }
function runSchedule(p) { const E = ENGINE(); if (!E) return false; try { p.levelled && E.level ? E.level(p) : E.schedule(p); return true; } catch { return false; } }
function workStartOn(a, d) { const c = calOf(a); const n = nextWorking(c, d); const hm = String(c.day_start || '08:00').split(':'); n.setHours(+hm[0] || 8, +hm[1] || 0, 0, 0); return n; }
function logicEarliest(a) {
  // where logic alone would put this activity (its own constraint removed), and what holds it there
  const E = ENGINE(); if (!E) return { es: null, by: [] };
  const c = cloneProject(); const ca = c.activities.find(x => x.id === a.id); ca.constraint = 'none'; ca.constraint_date = null;
  if (!runSchedule(c)) return { es: null, by: [] };
  return { es: ca.early_start, by: c.relationships.filter(r => r.successor_id === a.id && r.driving).map(r => r.predecessor_id) };
}
function applyDrag(act, d, days) {
  // mutate act (in the real project or a preview clone) for a drag of `days` calendar days; return a note
  const cal = calOf(act), b = d.base, minH = hpd(act) / 2;
  const holdStart = T => {
    if (d.es0 && T <= new Date(d.es0)) { act.constraint = 'none'; act.constraint_date = null; return { T: new Date(d.es0), pulled: true }; }
    act.constraint = b.con === 'must_start_on' ? 'must_start_on' : 'start_on_or_after'; act.constraint_date = iso(T); return { T, pulled: false };
  };
  if (d.kind === 'move') {
    const t = new Date(b.st); t.setDate(t.getDate() + days); const r = holdStart(workStartOn(act, t));
    return r.pulled ? { pulled: true } : { start: iso(r.T) };
  }
  if (d.end === 'F') {
    const f = new Date(b.fi); f.setDate(f.getDate() + days);
    const dd = workingDaysBetween(cal, new Date(b.fi), f);
    act.duration_hours = Math.max(minH, b.dur + dd * hpd(act));
    if (act.status === 'in_progress') act.remaining_hours = Math.max(0, (b.rem ?? b.dur) + dd * hpd(act));
    return { dur: act.duration_hours };
  }
  const t = new Date(b.st); t.setDate(t.getDate() + days); const r = holdStart(workStartOn(act, t));
  const dd = workingDaysBetween(cal, new Date(b.st), r.T);
  act.duration_hours = Math.max(minH, b.dur - dd * hpd(act));
  return { dur: act.duration_hours, pulled: r.pulled, start: iso(r.T) };
}
function drawPreview(clone, d) {
  const svg = $('svg.chart'); if (!svg) return;
  const cmap = Object.fromEntries(clone.activities.map(x => [x.id, x]));
  const rs2 = S.rowsCache.map(r => r.act ? Object.assign({}, r, { act: cmap[r.act.id] || r.act }) : r);
  const real = S.project; S.project = clone;
  let html; try { html = chart(rs2, S.t0, S.t1, S.ganttW, S.chartH, 0); } finally { S.project = real; }
  const i = S.rowsCache.findIndex(r => r.act && r.act.id === d.id);
  if (i >= 0 && d.base.st && d.base.fi) {          // where it was: a dashed ghost, as Asta shows while dragging
    const gx = S.x(d.base.st), gw = Math.max(3, S.x(d.base.fi) - gx);
    html += `<rect x="${gx}" y="${i * RH + (RH - 14) / 2}" width="${gw}" height="14" rx="2" fill="none" stroke="var(--ink-3)" stroke-dasharray="3 3" pointer-events="none"/>`;
  }
  svg.innerHTML = html;
}
function dragNote(d, info, clone) {
  const a = clone.activities.find(x => x.id === d.id);
  const shift = (from, to) => { if (!from || !to) return ''; const n = workingDaysBetween(calOf(a), new Date(from), new Date(to)); return n === 0 ? 'unchanged' : (n > 0 ? '+' : '') + n + 'd'; };
  const fin = shift(S.project.finish, clone.finish);
  const head = d.kind === 'move' ? `<b>${esc(d.id)}</b> starts ${fmtD(a.early_start)}` : d.end === 'F' ? `<b>${esc(d.id)}</b> ${fmt1(daysOf(a, a.duration_hours))}d, finishes ${fmtD(a.early_finish)}` : `<b>${esc(d.id)}</b> starts ${fmtD(a.early_start)}, ${fmt1(daysOf(a, a.duration_hours))}d`;
  const held = info.pulled ? `<br>Can't go earlier: ${d.by.length ? 'held by ' + d.by.map(esc).join(', ') : 'held by the data date or project start'}` : '';
  const moved = clone.activities.filter(x => { const o = byId(x.id); return o && x.early_start !== o.early_start; }).length;
  return `${head}${held}<br><span class="hint">${moved} activit${moved === 1 ? 'y moves' : 'ies move'} · finish ${fin}</span>`;
}
function startDrag(e, kind, id, el) {
  const a = byId(id); if (!a) return; const svg = $('svg.chart'), sheet = $('#sheet');
  const end = (el.dataset && el.dataset.end) || 'F';
  const d = S.drag = { kind, id, el, end, x0: e.clientX, sl0: sheet.scrollLeft, moved: false, by: [], base: { st: a.actual_start || a.early_start, fi: a.actual_finish || a.early_finish, dur: a.duration_hours, rem: a.remaining_hours, con: a.constraint } };
  if (kind === 'link') {
    const g = document.createElementNS('http://www.w3.org/2000/svg', 'path'); g.setAttribute('stroke', 'var(--accent)'); g.setAttribute('stroke-width', '1.6'); g.setAttribute('fill', 'none'); g.setAttribute('stroke-dasharray', '4 3');
    d.sx = +el.getAttribute('cx'); d.sy = +el.getAttribute('cy'); svg.appendChild(g); d.line = g;
  } else {
    if (a.status === 'complete' || (a.status === 'in_progress' && !(kind === 'resize' && end === 'F'))) {
      S.drag = null; toast(a.status === 'complete' ? `${id} is complete: change its actual dates instead` : `${id} has started: drag its finish, or change its actual start`); return;
    }
    if (a.type !== 'task' && kind === 'resize') { S.drag = null; return; }
    const le = logicEarliest(a); d.es0 = le.es; d.by = le.by;
    d.live = !!ENGINE() && S.project.activities.length <= LIVE_LIMIT;
    el.classList.add('dragging');
  }
  let raf = 0, last = null;
  const autoScroll = ev => { const r = sheet.getBoundingClientRect(); if (ev.clientX > r.right - 36) sheet.scrollLeft += 14; else if (ev.clientX < r.left + paneWidth() + 36 && sheet.scrollLeft > 0) sheet.scrollLeft -= 14; };
  const onMove = ev => {
    if (!S.drag) return; autoScroll(ev);
    const dx = ev.clientX - d.x0 + (sheet.scrollLeft - d.sl0); if (Math.abs(dx) > 3) d.moved = true; if (!d.moved) return;
    if (d.kind === 'link') {
      const pt = svgPoint(svg, ev); d.line.setAttribute('d', `M${d.sx},${d.sy} C${d.sx + (d.end === 'F' ? 40 : -40)},${d.sy} ${pt.x - 40},${pt.y} ${pt.x},${pt.y}`);
      $$('svg.chart .linktarget').forEach(x => x.classList.remove('linktarget'));
      const t = document.elementFromPoint(ev.clientX, ev.clientY), bar = t && t.closest && t.closest('g.act'), tid = bar && bar.dataset.g;
      d.target = null;
      if (tid && tid !== id) {
        const tb = bar.querySelector('.bar'); const r = tb.getBoundingClientRect(); const tend = ev.clientX < r.left + r.width / 2 ? 'S' : 'F';
        d.target = { id: tid, end: tend, type: d.end + tend }; tb.classList.add('linktarget');
        const ta = byId(tid); tipText(ev, `<b>${esc(d.end === 'F' ? 'Finish' : 'Start')} of ${esc(id)}</b> → <b>${tend === 'S' ? 'start' : 'finish'} of ${esc(tid)}</b> (${d.target.type})<br>${esc(ta ? ta.name : '')}${reaches(S.project, tid, id) ? '<br><span style="color:var(--crit)">Would create a loop</span>' : ''}`);
      } else tipText(ev, `Drop on another bar: left half links to its start, right half to its finish`);
      return;
    }
    const days = Math.round(dx / S.view.pxDay);
    if (last === days) return; last = days;
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      if (!S.drag) return;
      if (d.live) {
        const c = cloneProject(); const ca = c.activities.find(x => x.id === id); const info = applyDrag(ca, d, days);
        if (runSchedule(c)) { drawPreview(c, d); tipText(ev, dragNote(d, info, c)); d.preview = { c, info, days }; return; }
      }
      // fallback for very large programmes: move the bar only
      const px = days * S.view.pxDay; if (d.kind === 'move') d.el.setAttribute('transform', `translate(${px},0)`); tipText(ev, `${days >= 0 ? '+' : ''}${days} days`);
    });
  };
  const onUp = ev => {
    document.removeEventListener('pointermove', onMove); document.removeEventListener('pointerup', onUp); document.removeEventListener('pointercancel', onUp); cancelAnimationFrame(raf); hideTip();
    if (!S.drag) return; S.drag = null;
    if (d.kind === 'link') {
      d.line.remove(); $$('svg.chart .linktarget').forEach(x => x.classList.remove('linktarget'));
      if (!d.target) { const t = document.elementFromPoint(ev.clientX, ev.clientY), key = t && t.dataset && t.dataset.key; if (key && byId(key) && key !== id) addLink(id, key, d.end + 'S', 0); return; }
      addLink(id, d.target.id, d.target.type, 0); return;
    }
    const dx = ev.clientX - d.x0 + (sheet.scrollLeft - d.sl0), days = Math.round(dx / S.view.pxDay);
    if (!d.moved) { d.el.classList.remove('dragging'); return; }   // a click: leave the DOM alone so double-click and right-click work
    if (!days) { render(); return; }
    let info = null;
    mutate(p => { const act = p.activities.find(x => x.id === id); info = applyDrag(act, d, days); }, null);
    const c = d.preview && d.preview.days === days ? d.preview.c : null;
    const fin = c ? workingDaysBetween(calOf(a), new Date(S.project.finish), new Date(c.finish)) : null;
    const tail = fin == null ? '' : fin === 0 ? ' Finish unchanged.' : ` Finish ${fin > 0 ? '+' : ''}${fin} working days.`;
    if (d.kind === 'move') toast(info.pulled ? `${id} pulled back to its earliest start${d.by.length ? ': ' + d.by.join(', ') + ' holds it' : ''}. Constraint removed.${tail}` : `${id} now starts on or after ${fmtD(info.start)} (constraint added).${tail}`, { undo: true });
    else if (d.end === 'F') toast(`${id} is now ${fmt1(daysOf(a, info.dur))} days.${tail}`, { undo: true });
    else toast(`${id} ${info.pulled ? 'starts at its earliest' : 'starts ' + fmtD(info.start)}, now ${fmt1(daysOf(a, info.dur))} days.${tail}`, { undo: true });
  };
  document.addEventListener('pointermove', onMove); document.addEventListener('pointerup', onUp); document.addEventListener('pointercancel', onUp);
}
function svgPoint(svg, ev) { const r = svg.getBoundingClientRect(); return { x: ev.clientX - r.left, y: ev.clientY - r.top }; }
function addLink(p, s, type, lagDays) {
  if (p === s) return;
  mutate(pr => { if (reaches(pr, s, p)) { toast('That link would create a loop'); return false; } pr.relationships = pr.relationships.filter(r => !(r.predecessor_id === p && r.successor_id === s)); pr.relationships.push({ predecessor_id: p, successor_id: s, type, lag_hours: (lagDays || 0) * hpd(byId(p)) }); }, `Linked ${p} → ${s}`);
}
function reaches(p, from, to) { const seen = new Set(), st = [from]; while (st.length) { const n = st.pop(); if (n === to) return true; if (seen.has(n)) continue; seen.add(n); p.relationships.filter(r => r.predecessor_id === n).forEach(r => st.push(r.successor_id)); } return false; }
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
    one ? ['Inspect…', () => openInspector(one.id)] : null,
    one ? ['Trace driving path', () => setTrace([one.id], 'back')] : null,
    one ? ['Trace what it holds up', () => setTrace([one.id], 'fwd')] : null,
    acts.length ? ['Progress…', progressDialog] : null,
    acts.length ? ['Constraint…', constraintDialog] : null,
    one && one.constraint !== 'none' ? ['Clear constraint', () => mutate(p => { one.constraint = 'none'; one.constraint_date = null; }, 'Constraint cleared')] : null,
    acts.length ? ['Toggle milestone', toggleMilestone] : null,
    one ? ['Notes…', () => notesDialog(one)] : null,
    S.ctxAt ? ['Add a note on the chart here', (at => () => noteDialog(null, at.date, byId(at.key) ? at.key : null))(S.ctxAt)] : null,
  ].filter(x => x !== undefined);
  m.innerHTML = items.map(it => it === null ? '<hr>' : `<div>${esc(it[0])}</div>`).join('');
  let k = 0; m.querySelectorAll('div').forEach(el => { const it = items.filter(x => x !== null)[k++]; el.onclick = () => { m.hidden = true; it[1](); }; });
  m.hidden = false; m.style.left = Math.min(x, innerWidth - 240) + 'px'; m.style.top = Math.min(y, innerHeight - m.offsetHeight - 10) + 'px';
}
document.addEventListener('mousedown', e => { if (!e.target.closest('#ctx')) $('#ctx').hidden = true; });
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
// ---------- custom (user-defined) fields: columns, filters, inspector, XER UDFs ----------
const FIELD_TYPES = [['text', 'Text'], ['number', 'Number'], ['date', 'Date']];
const fieldDefs = p => (window.PlannerEngine && PlannerEngine.udfDefs) ? PlannerEngine.udfDefs(p) : (p.user_fields || []);
const fieldText = (d, v) => v == null || v === '' ? '' : d.type === 'number' ? (typeof v === 'number' ? v.toLocaleString('en-GB', { maximumFractionDigits: 2 }) : String(v)) : d.type === 'date' ? fmtD(String(v).slice(0, 10)) : String(v);
function parseField(d, raw) {        // null clears the value; undefined means it does not fit the type
  raw = String(raw == null ? '' : raw).trim(); if (raw === '') return null;
  if (d.type === 'number') { const n = parseFloat(raw.replace(/[£$€,\s]/g, '')); return isNaN(n) ? undefined : n; }
  if (d.type === 'date') { const dt = parseDateInput(raw); return dt ? iso(dt).slice(0, 10) : undefined; }
  return raw;
}
function setField(a, name, v) { if (v === undefined) return false; a.fields = a.fields || {}; if (v === null) delete a.fields[name]; else a.fields[name] = v; if (!Object.keys(a.fields).length) a.fields = null; }
function syncFieldCols() {
  const old = {}; Object.keys(ALL_COLS).forEach(k => { if (k.startsWith('f:')) { old[k] = ALL_COLS[k].w; delete ALL_COLS[k]; } });
  if (S.project) fieldDefs(S.project).forEach(d => { const k = 'f:' + d.name; ALL_COLS[k] = { t: d.name, w: old[k] || (d.type === 'text' ? 120 : 86), num: d.type === 'number' ? 1 : 0, field: d, get: a => fieldText(d, (a.fields || {})[d.name]), set: (a, v) => { setField(a, d.name, parseField(d, v)); } }; });
  S.cols = S.cols.filter(k => ALL_COLS[k]); if (!S.cols.length) S.cols = ['id', 'name'];
}
const fieldRaw = (a, k) => { const v = (a.fields || {})[k.slice(2)]; return v == null ? '' : v; };
// Filters: plain text, or conditions joined by ";" or "and", e.g. Trade=Brick; Float<5; Cost>=10000; Start>1 Apr 2026
function fieldAccessor(name) {
  const p = S.project, n = name.toLowerCase().trim();
  const codeTypes = new Set(Object.keys(p.code_types || {})); p.activities.forEach(a => Object.keys(a.codes || {}).forEach(k => codeTypes.add(k)));
  const ct = [...codeTypes].find(k => k.toLowerCase() === n); if (ct) return { type: 'text', get: a => (a.codes || {})[ct] };
  const d = fieldDefs(p).find(x => x.name.toLowerCase() === n); if (d) return { type: d.type, get: a => (a.fields || {})[d.name] };
  const B = {
    'float|tf|total float': { type: 'number', get: a => a.total_float_hours == null ? null : daysOf(a, a.total_float_hours) },
    'free float|ff': { type: 'number', get: a => a.free_float_hours == null ? null : daysOf(a, a.free_float_hours) },
    'dur|duration': { type: 'number', get: a => a.type === 'task' ? daysOf(a, a.duration_hours) : 0 },
    '%|pct|progress|complete|% complete': { type: 'number', get: a => a.status === 'complete' ? 100 : a.percent_complete || 0 },
    'start': { type: 'date', get: a => (a.actual_start || a.early_start || '').slice(0, 10) }, 'finish': { type: 'date', get: a => (a.actual_finish || a.early_finish || '').slice(0, 10) },
    'name|activity': { type: 'text', get: a => a.name }, 'id': { type: 'text', get: a => a.id },
    'wbs': { type: 'text', get: a => (wbsById(a.wbs_id) || {}).name || '' }, 'status': { type: 'text', get: a => a.status.replace('_', ' ') },
    'critical': { type: 'bool', get: a => !!a.critical }, 'calendar': { type: 'text', get: a => ALL_COLS.cal.get(a) }, 'resource|resources': { type: 'text', get: a => ALL_COLS.res.get(a) },
  };
  const k = Object.keys(B).find(k => k.split('|').includes(n)); return k ? B[k] : null;
}
function buildFilter(text) {
  const t = String(text || '').trim(); if (!t) return null;
  const tests = t.split(/\s*;\s*|\s+and\s+/i).filter(Boolean).map(part => {
    const m = part.match(/^(.+?)\s*(>=|<=|!=|=|:|>|<)\s*(.*)$/), acc = m && fieldAccessor(m[1]);
    if (!acc) { const q = part.toLowerCase(); return a => a.name.toLowerCase().includes(q) || a.id.toLowerCase().includes(q); }
    const op = m[2] === ':' ? '=' : m[2], raw = m[3].trim();
    if (acc.type === 'bool') { const want = !/^(n|no|false|0)$/i.test(raw); return a => (acc.get(a) === want) === (op !== '!='); }
    if (acc.type === 'number') { const n = parseFloat(raw.replace(/[£$€,\s]/g, '')); return a => { const v = acc.get(a); if (v == null || v === '' || isNaN(n)) return op === '!='; const x = +v; return op === '=' ? Math.abs(x - n) < 1e-9 : op === '!=' ? Math.abs(x - n) >= 1e-9 : op === '>' ? x > n : op === '<' ? x < n : op === '>=' ? x >= n : x <= n; }; }
    if (acc.type === 'date') { const d = parseDateInput(raw), r = d ? iso(d).slice(0, 10) : raw; return a => { const v = String(acc.get(a) || '').slice(0, 10); if (!v) return op === '!='; return op === '=' ? v === r : op === '!=' ? v !== r : op === '>' ? v > r : op === '<' ? v < r : op === '>=' ? v >= r : v <= r; }; }
    const r = raw.toLowerCase(); return a => { const v = String(acc.get(a) == null ? '' : acc.get(a)).toLowerCase(); const has = r === '' ? v === '' : v.includes(r); return op === '=' ? has : op === '!=' ? !has : op === '>' ? v > r : op === '<' ? v < r : op === '>=' ? v >= r : v <= r; };
  });
  return a => tests.every(f => f(a));
}
function fieldsDialog() {
  if (!S.project) return;
  const body = () => { const p = S.project, defs = fieldDefs(p);
    return `<p class="hint" style="margin-top:-4px">Your own columns on every activity: package, cost, permit date and so on. They show in the table and inspector, filter (<span class="mono">Cost&gt;5000; Package=Steel</span>), print on the PDF, export to CSV, and travel in XER as P6 user-defined fields.</p>
    <div class="list">${defs.map(d => { const n = p.activities.filter(a => a.fields && a.fields[d.name] != null && a.fields[d.name] !== '').length; return `<div class="li"><div style="min-width:0"><div class="t">${esc(d.name)}</div><div class="s">${(FIELD_TYPES.find(t => t[0] === d.type) || FIELD_TYPES[0])[1]} · ${n} activit${n === 1 ? 'y' : 'ies'} filled</div></div><span style="display:flex;gap:6px"><button type="button" class="btn" data-fshow="${esc(d.name)}">${S.cols.includes('f:' + d.name) ? 'Hide column' : 'Show column'}</button><button type="button" class="icon" data-fdel="${esc(d.name)}" aria-label="Delete ${esc(d.name)}" title="Delete the field and its values"><svg viewBox="0 0 20 20" class="ic"><path d="M5 5l10 10M15 5L5 15"/></svg></button></span></div>`; }).join('') || '<p class="hint" style="margin:0">No custom fields yet.</p>'}</div>
    <div class="row2" style="margin-top:14px"><label>New field<input name="fn" placeholder="e.g. Package"></label><label>Type<select name="ft">${FIELD_TYPES.map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select></label></div><button type="button" class="primary" id="fAdd" style="margin-top:8px">Add field</button>`; };
  const { m } = modal('Custom fields', body(), null);
  const wire = () => {
    const b = m.querySelector('.mbody');
    b.querySelector('#fAdd').onclick = () => { const name = b.querySelector('[name=fn]').value.trim(), type = b.querySelector('[name=ft]').value; if (!name) return; if (fieldDefs(S.project).some(d => d.name.toLowerCase() === name.toLowerCase())) return toast(`There is already a field called ${name}`);
      mutate(p => { p.user_fields = [...(p.user_fields || []), { name, type }]; S.cols = [...S.cols, 'f:' + name]; }, `Field ${name} added as a column`); redraw(); };
    b.querySelectorAll('[data-fshow]').forEach(x => x.onclick = () => { const k = 'f:' + x.dataset.fshow; S.cols = S.cols.includes(k) ? S.cols.filter(c => c !== k) : [...S.cols, k]; try { localStorage.setItem('cols', JSON.stringify(S.cols)); } catch { } render(); redraw(); });
    b.querySelectorAll('[data-fdel]').forEach(x => x.onclick = () => { const n = x.dataset.fdel; mutate(p => { p.user_fields = (p.user_fields || []).filter(d => d.name !== n); if (!p.user_fields.length) p.user_fields = null; p.activities.forEach(a => { if (a.fields && n in a.fields) setField(a, n, null); }); S.cols = S.cols.filter(c => c !== 'f:' + n); }, `Field ${n} deleted`); redraw(); });
  };
  const redraw = () => { syncFieldCols(); m.querySelector('.mbody').innerHTML = body(); wire(); }; wire();
}
// ---------- library: codes, fields and views shared between programmes ----------
function libraryOf(p) { return { kind: 'planner-library', version: 1, code_types: JSON.parse(JSON.stringify(p.code_types || {})), user_fields: fieldDefs(p), views: JSON.parse(JSON.stringify(p.views || [])) }; }
function mergeLibrary(p, lib) {
  let c = 0, f = 0, v = 0;
  Object.entries(lib.code_types || {}).forEach(([t, vals]) => { p.code_types[t] = p.code_types[t] || {}; Object.entries(vals || {}).forEach(([k, col]) => { if (!(k in p.code_types[t])) { p.code_types[t][k] = col || '#7a8aa6'; c++; } }); });
  (lib.user_fields || []).forEach(d => { if (d && d.name && !(p.user_fields || []).some(x => x.name === d.name)) { p.user_fields = [...(p.user_fields || []), { name: String(d.name), type: ['text', 'number', 'date'].includes(d.type) ? d.type : 'text' }]; f++; } });
  (lib.views || []).forEach(x => { if (x && x.name && !(p.views || []).some(y => y.name === x.name)) { p.views = [...(p.views || []), x]; v++; } });
  return { c, f, v };
}
const libSummary = r => [r.c && `${r.c} code value${r.c === 1 ? '' : 's'}`, r.f && `${r.f} field${r.f === 1 ? '' : 's'}`, r.v && `${r.v} view${r.v === 1 ? '' : 's'}`].filter(Boolean).join(', ') || 'nothing new';
function parseCsv(text) {
  text = String(text).replace(/^﻿/, ''); const first = text.split(/\r?\n/)[0] || '';
  const delim = (first.match(/;/g) || []).length > (first.match(/,/g) || []).length ? ';' : ',';
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) { const ch = text[i];
    if (q) { if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch; }
    else if (ch === '"') q = true; else if (ch === delim) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; } else cell += ch; }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(r => r.some(c => c.trim() !== '')).map(r => r.map(c => /^'[=+\-@]/.test(c) ? c.slice(1) : c));
}
function codingSheetCsv(p) {
  const types = [...new Set([...Object.keys(p.code_types || {}), ...p.activities.flatMap(a => Object.keys(a.codes || {}))])], defs = fieldDefs(p);
  const lines = [['ID', 'Activity', ...types, ...defs.map(d => d.name)].map(csvCell).join(',')];
  p.activities.forEach(a => lines.push([a.id, a.name, ...types.map(t => (a.codes || {})[t] || ''), ...defs.map(d => { const v = (a.fields || {})[d.name]; return v == null ? '' : v; })].map(csvCell).join(',')));
  return '﻿' + lines.join('\r\n') + '\r\n';
}
function applyCodingSheet(p, rows) {
  if (rows.length < 2) throw new Error('The sheet has no activity rows.');
  const head = rows[0].map(h => h.trim()), idCol = Math.max(0, head.findIndex(h => /^(id|activity id|task code)$/i.test(h)));
  const skip = new Set([idCol, ...head.map((h, i) => /^(activity|name|activity name)$/i.test(h) ? i : -1).filter(i => i >= 0)]);
  const types = Object.keys(p.code_types || {}), created = [];
  const cols = head.map((h, i) => { if (skip.has(i) || !h) return null; const ct = types.find(t => t.toLowerCase() === h.toLowerCase()); if (ct) return { kind: 'code', name: ct };
    let d = fieldDefs(p).find(x => x.name.toLowerCase() === h.toLowerCase()); if (!d) { d = { name: h, type: 'text' }; p.user_fields = [...(p.user_fields || []), d]; created.push(h); } return { kind: 'field', d }; });
  const ids = new Map(p.activities.map(a => [a.id.toLowerCase(), a])); let n = 0; const missing = [], bad = [];
  rows.slice(1).forEach(r => { const a = ids.get(String(r[idCol] || '').trim().toLowerCase()); if (!a) { if (String(r[idCol] || '').trim()) missing.push(r[idCol].trim()); return; } let ch = false;
    cols.forEach((c, i) => { if (!c) return; const raw = String(r[i] == null ? '' : r[i]).trim();
      if (c.kind === 'code') { const cur = (a.codes || {})[c.name] || ''; if (raw === cur) return; a.codes = a.codes || {}; if (raw) { a.codes[c.name] = raw; if (!(raw in p.code_types[c.name])) p.code_types[c.name][raw] = '#' + Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0'); } else delete a.codes[c.name]; ch = true; }
      else { const v = parseField(c.d, raw); if (v === undefined) { bad.push(`${a.id} ${c.d.name}`); return; } const cur = (a.fields || {})[c.d.name]; if ((cur == null ? null : cur) === v) return; setField(a, c.d.name, v); ch = true; } });
    if (ch) n++; });
  return { n, missing, bad, created };
}
function libraryDialog() {
  if (!S.project) return; const others = (S.list || []).filter(x => x.id !== S.pid);
  const { m } = modal('Codes, fields and views', `<p class="hint" style="margin-top:-4px">Share set-up between programmes: activity codes and their colours, custom fields and saved views. Copying only adds what is missing; nothing here is overwritten.</p>
    <div class="insp-sec">Copy from another programme</div>
    ${others.length ? `<div class="row2"><label>Programme<select id="libSrc">${others.map(o => `<option value="${esc(o.id)}">${esc(o.name)} (${esc(o.id)})</option>`).join('')}</select></label><label>&nbsp;<button type="button" class="btn" id="libCopy">Copy in</button></label></div>` : '<p class="hint">No other programmes here yet. Load a library file instead.</p>'}
    <div class="insp-sec">Library file</div><p class="hint" style="margin:0 0 8px">Save this programme's set-up to load into another, or send to a colleague. Loading also accepts a P6 XER or a programme file, and takes its codes and fields.</p>
    <div style="display:flex;gap:8px;flex-wrap:wrap"><button type="button" class="btn" id="libSave">Save library file</button><button type="button" class="btn" id="libLoad">Load library…</button></div><input type="file" id="libFile" accept=".json,.xer,.xml" hidden>
    <div class="insp-sec">Coding sheet (CSV)</div><p class="hint" style="margin:0 0 8px">One row per activity with its codes and custom fields. Fill it in Excel and load it back: columns that match a code type or field update it, and new columns become text fields.</p>
    <div style="display:flex;gap:8px;flex-wrap:wrap"><button type="button" class="btn" id="csExp">Export coding sheet</button><button type="button" class="btn" id="csImp">Import coding sheet…</button></div><input type="file" id="csFile" accept=".csv,text/csv" hidden>
    <div id="libOut" class="hint" role="status" style="margin-top:10px"></div>`, null);
  const out = t => { m.querySelector('#libOut').textContent = t; };
  const merge = (lib, from) => { let r; mutate(p => { r = mergeLibrary(p, lib); if (!r.c && !r.f && !r.v) return false; }, null); if (r && (r.c || r.f || r.v)) { syncFieldCols(); toast(`Copied from ${from}: ${libSummary(r)}`, { ms: 4200, undo: true }); } out(`From ${from}: ${libSummary(r || {})}.`); };
  const cp = m.querySelector('#libCopy'); if (cp) cp.onclick = async () => { const id = m.querySelector('#libSrc').value; try { const d = await api('/api/projects/' + encodeURIComponent(id)); merge(libraryOf(d.project), d.project.name); } catch (e) { out(e.message || String(e)); } };
  m.querySelector('#libSave').onclick = async () => { const p = S.project; if (await saveBlob(`${p.id}-library.json`, new Blob([JSON.stringify(libraryOf(p), null, 2)], { type: 'application/json' }))) out('Library file saved.'); };
  m.querySelector('#libLoad').onclick = () => m.querySelector('#libFile').click();
  m.querySelector('#libFile').onchange = async e => { const f = e.target.files[0]; if (!f) return; e.target.value = '';
    try { const bytes = new Uint8Array(await f.arrayBuffer()); let lib = null; if (/\.json$/i.test(f.name)) { try { const j = JSON.parse(new TextDecoder().decode(bytes).replace(/^﻿/, '')); if (j && j.kind === 'planner-library') lib = j; } catch { } }
      if (!lib) lib = libraryOf(window.PlannerEngine.readAny(f.name, bytes)); merge(lib, f.name); } catch (err) { out(err.message || String(err)); } };
  m.querySelector('#csExp').onclick = async () => { const p = S.project; if (await saveBlob(`${p.id}-coding-sheet.csv`, new Blob([codingSheetCsv(p)], { type: 'text/csv;charset=utf-8' }))) out(`Coding sheet saved: ${p.activities.length} activities.`); };
  m.querySelector('#csImp').onclick = () => m.querySelector('#csFile').click();
  m.querySelector('#csFile').onchange = async e => { const f = e.target.files[0]; if (!f) return; e.target.value = '';
    try { const rows = parseCsv(await f.text()); let r; mutate(p => { r = applyCodingSheet(p, rows); if (!r.n && !r.created.length) return false; }, null); syncFieldCols();
      const msg = `${r.n} activit${r.n === 1 ? 'y' : 'ies'} updated${r.created.length ? `; new fields: ${r.created.join(', ')}` : ''}${r.missing.length ? `; ${r.missing.length} ID${r.missing.length === 1 ? '' : 's'} not found (${r.missing.slice(0, 5).join(', ')})` : ''}${r.bad.length ? `; ${r.bad.length} value${r.bad.length === 1 ? '' : 's'} did not fit the field type (${r.bad.slice(0, 4).join(', ')})` : ''}.`;
      out(msg); if (r.n || r.created.length) toast(`Coding sheet loaded: ${r.n} updated`, { ms: 3600, undo: true }); } catch (err) { out(err.message || String(err)); } };
}
// ---------- saved views: with the programme (everyone) or on this device ----------
function viewsDialog() {
  const loadLocal = () => { try { return JSON.parse(localStorage.getItem('views') || '{}'); } catch { return {}; } };
  const cur = name => ({ name, cols: [...S.cols], widths: Object.fromEntries(S.cols.map(k => [k, ALL_COLS[k].w])), view: { ...S.view }, panel: S.panel });
  const apply = v => { if (!v) return; syncFieldCols(); const miss = (v.cols || []).filter(k => !ALL_COLS[k]); S.cols = (v.cols || S.cols).filter(k => ALL_COLS[k]); if (!S.cols.includes('name')) S.cols.unshift('name');
    Object.entries(v.widths || {}).forEach(([k, w]) => { if (ALL_COLS[k]) ALL_COLS[k].w = w; }); Object.assign(S.view, v.view || {}); S.panel = v.panel; modalClose(); syncViewControls(); render(); refreshPanel(); toast(`View ${v.name || ''} applied${miss.length ? `; ${miss.length} column${miss.length === 1 ? '' : 's'} not in this programme` : ''}`); };
  const row = (n, src) => `<div class="li"><div class="t">${esc(n)}</div><span style="display:flex;gap:6px"><button type="button" class="btn" data-apply="${src}:${esc(n)}">Apply</button><button type="button" class="icon" data-del="${src}:${esc(n)}" aria-label="Delete view ${esc(n)}"><svg viewBox="0 0 20 20" class="ic"><path d="M5 5l10 10M15 5L5 15"/></svg></button></span></div>`;
  const body = () => { const pv = (S.project.views || []), lv = Object.keys(loadLocal());
    return `<p class="hint" style="margin-top:-4px">A view remembers columns and widths, zoom, chart type, bar options, colour, grouping, sorting, filter and panel.</p>
    <div class="insp-sec">With this programme</div><p class="hint" style="margin:0 0 6px">Everyone who opens the programme gets these, and they travel with it.</p><div class="list">${pv.map(v => row(v.name, 'p')).join('') || '<p class="hint" style="margin:0">None yet.</p>'}</div>
    <div class="insp-sec">On this device only</div><div class="list">${lv.map(n => row(n, 'l')).join('') || '<p class="hint" style="margin:0">None.</p>'}</div>
    <div class="row2" style="margin-top:14px"><label>Save the current view as<input name="vn" placeholder="e.g. Look-ahead for site"></label><label>Keep it<select name="vw"><option value="p">With the programme</option><option value="l">On this device</option></select></label></div><button type="button" class="primary" id="vSave" style="margin-top:8px">Save view</button>`; };
  const { m } = modal('Saved views', body(), null);
  const wire = () => { const b = m.querySelector('.mbody');
    b.querySelectorAll('[data-apply]').forEach(x => x.onclick = () => { const [src, ...rest] = x.dataset.apply.split(':'), n = rest.join(':'); apply(src === 'p' ? (S.project.views || []).find(v => v.name === n) : Object.assign({ name: n }, loadLocal()[n])); });
    b.querySelectorAll('[data-del]').forEach(x => x.onclick = () => { const [src, ...rest] = x.dataset.del.split(':'), n = rest.join(':');
      if (src === 'p') mutate(p => { p.views = (p.views || []).filter(v => v.name !== n); if (!p.views.length) p.views = null; }, `View ${n} deleted`); else { const v = loadLocal(); delete v[n]; try { localStorage.setItem('views', JSON.stringify(v)); } catch { } } redraw(); });
    b.querySelector('#vSave').onclick = () => { const n = b.querySelector('[name=vn]').value.trim(), where = b.querySelector('[name=vw]').value; if (!n) return b.querySelector('[name=vn]').focus();
      if (where === 'p') mutate(p => { p.views = (p.views || []).filter(v => v.name !== n).concat([cur(n)]); }, `View ${n} saved with the programme`);
      else { const v = loadLocal(); v[n] = cur(n); try { localStorage.setItem('views', JSON.stringify(v)); toast(`View ${n} saved on this device`); } catch { toast('This browser will not store views; save it with the programme instead'); } }
      redraw(); };
  };
  const redraw = () => { m.querySelector('.mbody').innerHTML = body(); wire(); }; wire();
}
function columnsDialog() {
  syncFieldCols();
  modal('Columns', `<div class="days">${Object.entries(ALL_COLS).map(([k, c]) => `<label class="row"><input type="checkbox" name="${esc(k)}" ${S.cols.includes(k) ? 'checked' : ''}>${esc(c.t)}</label>`).join('')}</div>`, m => { S.cols = Object.keys(ALL_COLS).filter(k => m.querySelector(`[name="${CSS.escape(k)}"]`).checked); if (!S.cols.includes('name')) S.cols.unshift('name'); try { localStorage.setItem('cols', JSON.stringify(S.cols)); } catch { } render(); }, 'Apply');
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
      if (r.limit) { const ly = H - 10 - r.limit * sc; s += `<line x1="0" y1="${ly}" x2="${W}" y2="${ly}" stroke="var(--crit)" stroke-dasharray="3 3"/><text x="4" y="${ly < 28 ? ly + 13 : ly - 4}" fill="var(--crit)" font-weight="600">crew limit ${r.limit}</text>`; }
      s += `<text x="120" y="14" fill="var(--muted)">${esc(r.name)} · ${weekly ? 'average per day, by week' : 'people per day'}</text>`;
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
  else if (k === 'Escape') { S.sel = new Set(); S.selLink = null; paintSelection(); clearTrace(); }
  else if (k === '+' || k === '=') zoom(1.25); else if (k === '-') zoom(0.8);
  else if (k.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey && S.active && byId(S.active) && ALL_COLS[S.activeCol].set) { startEdit(S.active, S.activeCol); const inp = S.editing && S.editing.inp; if (inp && inp.type !== 'date' && inp.tagName === 'INPUT') { inp.value = k; e.preventDefault(); } }
}

// ---------- AI assistant ----------
function addAi(html, cls, tools) { const el = document.createElement('div'); el.className = 'msg' + (cls ? ' ' + cls : ''); el.innerHTML = html + (tools && tools.length ? `<div class="tools">used: ${esc(tools.join(', '))}</div>` : ''); $('#aiLog').appendChild(el); $('#aiLog').scrollTop = 1e9; return el; }

// ---------- assistant in the shared page: Claude on the viewer's own account (artifact `sample` capability) ----------
// No API key lives in the page. Claude gets the scheduling engine as tools; it never computes dates itself.
// Every change goes through the same routes as the UI, so each one is a normal undo step.
const AI_RULES = `You are an expert UK construction planner working inside a scheduling app. You build and change Primavera-P6-grade programmes by calling the tools provided; the engine computes every date with the critical path method, so never state or invent dates, durations or float yourself - read them from tool results.
How to work:
- To start a programme from a description, call generate_programme with a plain-English brief (type, size, structure, foundations, envelope, start date, deadline, site constraints). It builds the WBS, activities, logic, durations from production rates and milestones, then schedules and health-checks it.
- To change a programme, call run_command once per change with one plain instruction, e.g. "add 2 weeks to A1240", "link A1010 -> A1020 SS+2d", "finish by 1 Nov 2026", "progress A1010 50% as of 20 Apr 2026", "constrain A1100 start on or after 16 Mar 2026", "set A1240 to 15d", "rename A1010 Site set-up", "delete A1045". Use apply_edits only for several structured changes a command cannot express.
- Call get_schedule before answering questions about the plan or choosing what to change. repair fixes failing DCMA checks; level_resources keeps trades within crew limits; set_baseline snapshots dates; risk_analysis runs a Monte Carlo of the finish date.
- Then reply briefly in British English: what you changed, the new finish date and health score from the tool results, and any assumption you made. Ask a question only if you genuinely cannot proceed. Durations and lags are in working days. Activity ids look like A1010.`;
let _sample;
async function getSample() {
  if (S._sampleP) return S._sampleP;
  S._sampleP = getSample0(); S._sampleP.then(sm => { S.aiReady = !!sm; }, () => { });
  return S._sampleP;
}
async function getSample0() {
  if (_sample !== undefined) return _sample;
  try { _sample = window.claude && typeof window.claude.use === 'function' ? await window.claude.use('sample') : null; } catch { _sample = null; }
  if (_sample) { try { const lim = await _sample.limits(); if (!lim || !lim.tools) _sample = null; } catch { _sample = null; } }
  return _sample;
}
function stateLine() {
  const p = S.project; if (!p) return 'No programme is open.';
  const crit = p.activities.filter(a => a.critical && a.status !== 'complete').length;
  return `Open programme: ${p.name} (${p.id}). ${p.activities.length} activities, start ${(p.start || '').slice(0, 10)}, forecast finish ${(p.finish || '').slice(0, 10)}${p.must_finish_by ? ', deadline ' + p.must_finish_by.slice(0, 10) : ''}, data date ${(p.data_date || p.start || '').slice(0, 10)}, ${crit} critical, health ${S.report ? S.report.score + '/100' : 'n/a'}.`;
}
function scheduleText() {
  const p = S.project; if (!p) return 'No programme is open. Call generate_programme first.';
  const preds = id => p.relationships.filter(r => r.successor_id === id).map(r => r.predecessor_id + (r.type !== 'FS' ? r.type : '') + (r.lag_hours ? (r.lag_hours > 0 ? '+' : '') + fmt1(daysOf(byId(r.predecessor_id) || {}, r.lag_hours)) + 'd' : '')).join(' ');
  const lines = p.activities.map(a => [a.id, a.name, a.type === 'task' ? fmt1(daysOf(a, a.duration_hours)) + 'd' : 'milestone', (a.actual_start || a.early_start || '').slice(0, 10), (a.actual_finish || a.early_finish || '').slice(0, 10), 'TF ' + (a.total_float_hours == null ? '?' : fmt1(daysOf(a, a.total_float_hours)) + 'd'), a.critical ? 'CRIT' : '', a.status !== 'not_started' ? Math.round(a.status === 'complete' ? 100 : a.percent_complete) + '%' : '', a.constraint !== 'none' ? a.constraint + ' ' + (a.constraint_date || '').slice(0, 10) : '', preds(a.id) ? 'after ' + preds(a.id) : ''].filter(Boolean).join(' | '));
  const failing = S.report ? S.report.checks.filter(c => c.applicable && !c.passed).map(c => c.title) : [];
  let out = stateLine() + (failing.length ? `\nFailing checks: ${failing.join('; ')}` : '\nAll DCMA checks pass.') + '\nid | name | duration | start | finish | float | critical | progress | constraint | predecessors\n';
  for (const l of lines) { if (out.length + l.length > 26000) { out += `... ${lines.length} activities in all; ask for a narrower question.`; break; } out += l + '\n'; }
  return out;
}
function aiTools(progress) {
  const after = async (v, label) => { if (v && v.project) { show(v); await loadList(); if (S.screen === 'projects') go('plan'); } return (v && v.message ? v.message + ' ' : '') + (label || '') + stateLine(); };
  const need = () => { if (!S.pid) throw new Error('No programme is open. Call generate_programme first.'); };
  const str = { type: 'string' };
  return [
    { name: 'generate_programme', description: 'Build a complete new programme from a plain-English brief and open it. Returns the summary, finish date and health.', inputSchema: { type: 'object', properties: { brief: { type: 'string', description: "e.g. '24-unit three-storey apartment block, RC frame on piles, brick, start 6 April 2026, finish before Christmas 2027'" } }, required: ['brief'] },
      execute: async i => { progress('Building the programme…'); const v = await post('/api/generate', { text: String(i.brief || '') }); return after(v, 'Generated. '); } },
    { name: 'get_schedule', description: 'Read the open programme: every activity with duration, dates, float, critical flag, progress, constraint and predecessors, plus failing DCMA checks.', execute: async () => { progress('Reading the programme…'); return scheduleText(); } },
    { name: 'run_command', description: 'Apply one scheduling change in plain English (the command language). One change per call. Returns what changed and the new state.', inputSchema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
      execute: async i => { need(); progress('Applying: ' + String(i.command || '')); const v = await post(pidPath('/command'), { text: String(i.command || '') }); if (!v.project) return (v.message || 'No change.') + ' ' + stateLine(); return after(v); } },
    { name: 'apply_edits', description: 'Apply several structured edits at once. Each op has "op" (add_activity, remove_activity, rename, set_duration, add_link, remove_link, set_constraint, clear_constraint, set_progress, set_must_finish_by, add_wbs, move_to_wbs) plus its fields (activity_id, name, duration_days, predecessor_id, successor_id, link_type, lag_days, constraint_type, date YYYY-MM-DD, percent_complete, wbs_code).',
      inputSchema: { type: 'object', properties: { ops: { type: 'array', items: { type: 'object', properties: { op: str } } } }, required: ['ops'] },
      execute: async i => { need(); const ops = Array.isArray(i.ops) ? i.ops : []; progress(`Applying ${ops.length} edits…`); return after(await post(pidPath('/patch'), { patch: { ops, message: '' } })); } },
    { name: 'repair', description: 'Auto-fix failing DCMA checks: close open ends, remove leads, soften hard constraints, split over-long activities. Reports what it left for the planner.', execute: async () => { need(); progress('Repairing…'); return after(await post(pidPath('/repair'))); } },
    { name: 'level_resources', description: 'Delay not-started activities so no trade exceeds its crew limit per day. Returns the new finish.', execute: async () => { need(); progress('Levelling…'); return after(await post(pidPath('/level'))); } },
    { name: 'set_baseline', description: 'Save the current dates as a named baseline for variance tracking.', inputSchema: { type: 'object', properties: { name: str } }, execute: async i => { need(); return after(await post(pidPath('/baseline'), { name: String(i.name || 'Baseline') })); } },
    { name: 'risk_analysis', description: 'Monte Carlo of the finish date (300 runs, durations -10% to +30%, more for weather-exposed work). Returns P50/P80/P90, chance of the deadline and the activities most often critical.',
      execute: async () => { need(); progress('Running the risk analysis…'); const r = window.PlannerEngine.riskAnalysis(S.project, { iterations: 300 }); S.risk = { pid: S.pid, stamp: S.project.scheduled_at, r };
        return { planned_finish: r.deterministic_finish, p50: r.p50, p80: r.p80, p90: r.p90, chance_of_planned_finish_pct: Math.round(r.deterministic_probability), chance_of_deadline_pct: r.deadline_probability == null ? null : Math.round(r.deadline_probability), sometimes_critical: r.criticality.filter(c => c.pct < 100).slice(0, 8).map(c => `${c.id} ${c.name} ${Math.round(c.pct)}%`) }; } },
  ];
}
const AI_ERRORS = { not_granted: 'The assistant needs your permission to use Claude. Reopen the page and allow it to try again.', sampling_disabled: 'Claude is not available on this account.', rate_limited: 'Claude is busy or your usage limit is reached. Try again in a little while.', session_expired: 'Sign in to Claude again, then retry.', refused: 'Claude declined that request. Try rephrasing it as a planning change.', empty_completion: 'Claude gave no answer. Try a shorter, more specific request.', prompt_too_large: 'That was too much at once. Ask about part of the programme.', tools_unavailable: 'This view cannot let Claude use the planning tools.' };
async function sendAiLocal(text) {
  const sample = await getSample();
  if (!sample) { addAi(esc(text), 'me'); addAi('The assistant uses your own Claude account when this page is opened inside Claude (claude.ai or the Claude app). Here you can still use Guided setup, Paste a brief, or the command palette (Ctrl+K).'); return; }
  addAi(esc(text), 'me');
  const busy = addAi('Thinking…'); const t0 = Date.now(); let status = 'Thinking…', streamed = '';
  const paint = () => { busy.innerHTML = (streamed ? esc(streamed).replace(/\n/g, '<br>') + '<br>' : '') + `<span class="hint">${esc(status)} ${Math.round((Date.now() - t0) / 1000)}s</span>`; };
  const tick = setInterval(paint, 1000); const used = [];
  const ctl = new AbortController(); S.aiAbort = ctl; $('#aiStop') && ($('#aiStop').hidden = false);
  const tools = aiTools(msg => { status = msg; paint(); }).map(t => Object.assign({}, t, { execute: (i, c) => { used.push(t.name); return t.execute(i, c); } }));
  S.aiTurns = (S.aiTurns || []).slice(-14);
  const before = S.project ? JSON.parse(JSON.stringify(S.project)) : null, pid0 = S.pid, undo0 = (S.history && S.history.undo) || 0;
  const turns = [{ role: 'user', content: AI_RULES + '\n\n' + stateLine() }, ...S.aiTurns, { role: 'user', content: text }];
  try {
    const { text: reply, truncated } = await sample(turns, { tools, signal: ctl.signal, onText: ({ text: t }) => { streamed = t; paint(); } });
    clearInterval(tick); busy.remove();
    S.aiTurns.push({ role: 'user', content: text }, { role: 'assistant', content: reply });
    addAi(esc(reply).replace(/\n/g, '<br>') + (truncated ? '<br><span class="hint">Cut short. Ask for less at a time.</span>' : ''), '', [...new Set(used)]);
    reviewChanges(before, pid0, undo0);
  } catch (e) {
    clearInterval(tick); busy.remove();
    if (e && e.text) addAi(esc(e.text).replace(/\n/g, '<br>'));
    if (!e || e.code !== 'cancelled') addAi('<span class="crit">' + esc(AI_ERRORS[e && e.code] || 'Claude could not finish that. Try again.') + '</span>', '', [...new Set(used)]);
    if (e && ['not_granted', 'sampling_disabled', 'tools_unavailable', 'capability_disabled', 'capability_removed', 'not_declared'].includes(e.code)) _sample = null;
  } finally { S.aiAbort = null; $('#aiStop') && ($('#aiStop').hidden = true); }
}
// after Claude has changed the open programme: say what changed and offer to keep it or undo it all
function reviewChanges(before, pid0, undo0) {
  const E = window.PlannerEngine; if (!before || S.pid !== pid0 || !S.project || !E || !E.compareProjects) return;
  const steps = ((S.history && S.history.undo) || 0) - undo0; if (steps <= 0) return;
  let r; try { r = E.compareProjects(before, S.project); } catch { return; }
  const c = r.summary.counts || {}, sh = r.summary.finish_shift_days;
  const bits = [sh ? `finish ${sh > 0 ? '+' : ''}${sh} working days` : 'finish unchanged', c.duration_changes ? `${c.duration_changes} durations` : '', (c.logic_added || 0) + (c.logic_removed || 0) + (c.logic_changed || 0) ? `${(c.logic_added || 0) + (c.logic_removed || 0) + (c.logic_changed || 0)} links` : '', c.added ? `${c.added} added` : '', c.removed ? `${c.removed} removed` : '', c.constraint_changes ? `${c.constraint_changes} constraints` : '', c.progress_changes ? `${c.progress_changes} progress updates` : ''].filter(Boolean);
  const el = addAi(`<b>Changes to review:</b> ${esc(bits.join(' · '))}<div class="bar-row" style="margin-top:8px"><button type="button" class="btn" data-a="see">See changes</button><button type="button" class="btn" data-a="undo">Undo all (${steps})</button><button type="button" class="btn" data-a="keep">Keep</button></div>`, 'review');
  el.querySelector('[data-a=see]').onclick = () => compareSheet(r);
  el.querySelector('[data-a=keep]').onclick = () => { el.querySelector('.bar-row').innerHTML = '<span class="hint">Kept.</span>'; };
  el.querySelector('[data-a=undo]').onclick = async () => { el.querySelector('.bar-row').innerHTML = '<span class="hint">Undoing…</span>'; for (let i = 0; i < steps; i++) await act('/undo'); el.querySelector('.bar-row').innerHTML = `<span class="hint">Undone. Back to how it was before.</span>`; };
}
function openAssistant(prefill) {
  const el = $('#ai'); if (el.hidden) { el.hidden = false; animate(el, { y: 0, opacity: 1, scale: 1 }, { from: { y: 16, opacity: 0, scale: .98 }, response: .34 }); }
  if (prefill != null) $('#aiIn').value = prefill; $('#aiIn').focus();
}
async function sendAi(text) {
  if (LOCAL) return sendAiLocal(text);
  addAi(esc(text), 'me');
  const busy = addAi('Thinking…'); const t0 = Date.now();
  const tick = setInterval(() => busy.firstChild.textContent = `Thinking… ${Math.round((Date.now() - t0) / 1000)}s`, 1000);
  try {
    const path = S.pid ? '/api/projects/' + encodeURIComponent(S.pid) + '/chat' : '/api/chat';
    const v = await post(path, { message: text, history: S.aiHistory || [] });
    clearInterval(tick); busy.remove();
    S.aiHistory = v.history || S.aiHistory || [];
    if (v.project) { show(v); await loadList(); if (S.screen === 'projects') go('plan'); }
    addAi(esc(v.reply || '(no reply)').replace(/\n/g, '<br>'), '', v.tool_calls);
  } catch (e) { clearInterval(tick); busy.remove(); addAi('<span class="crit">' + esc((e && e.message) || 'error') + '</span>'); }
}
// ---------- status: the same judgement on the portfolio card, the plan header and the monitor ----------
function progressOf(p) {
  const tasks = p.activities.filter(a => a.type === 'task' && a.duration_hours > 0);
  const total = tasks.reduce((s, a) => s + a.duration_hours, 0) || 1;
  const done = tasks.reduce((s, a) => s + a.duration_hours * (a.status === 'complete' ? 100 : a.percent_complete) / 100, 0);
  const dd = new Date(p.data_date || p.start); const baselined = tasks.some(a => a.baseline_start);
  const planned = tasks.reduce((s, a) => {
    const st = a.baseline_start || a.early_start, fi = a.baseline_finish || a.early_finish; if (!st || !fi) return s;
    const t0 = new Date(st), t1 = new Date(fi); const f = dd <= t0 ? 0 : dd >= t1 ? 1 : (dd - t0) / Math.max(1, t1 - t0);
    return s + a.duration_hours * f;
  }, 0);
  return { pct: done / total * 100, planned: planned / total * 100, baselined };
}
function spareDays(p) {
  if (!p.must_finish_by || !p.finish) return null;
  const cal = p.calendars[p.default_calendar_id] || { working_days: [0, 1, 2, 3, 4], exceptions: {} };
  return workingDaysBetween(cal, new Date(p.finish), new Date(p.must_finish_by));
}
function statusOf(p, r) {
  const neg = p.activities.some(a => a.status !== 'complete' && a.total_float_hours != null && a.total_float_hours < -1e-6);
  const spare = spareDays(p); const pr = progressOf(p);
  if (pr.pct >= 99.5) return ['ok', 'Complete'];
  if ((spare != null && spare < 0) || neg) return ['bad', 'Late'];
  if (spare != null && spare < 10) return ['warn', 'At risk'];
  if (pr.baselined && pr.planned - pr.pct > 10) return ['warn', 'Behind plan'];
  if (r && r.score < 70) return ['warn', 'Needs checking'];
  return ['ok', 'On track'];
}

// ---------- Projects: the portfolio ----------
const TYPE_ICONS = {
  house: '<path d="M5 13l9-7 9 7v10H5z"/><path d="M11 23v-6h6v6"/>',
  houses: '<path d="M2 15l6-5 6 5v8H2z"/><path d="M14 15l6-5 6 5v8h-12"/><path d="M6 23v-4h4v4"/>',
  apartments: '<path d="M7 4h14v20H7z"/><path d="M11 8h2M15 8h2M11 12h2M15 12h2M11 16h2M15 16h2M13 24v-4h2v4"/>',
  office: '<path d="M5 24V8l9-4v20"/><path d="M14 10h9v14"/><path d="M8 10h3M8 14h3M8 18h3M17 14h3M17 18h3"/>',
  warehouse: '<path d="M3 24V12l11-6 11 6v12z"/><path d="M8 24v-7h12v7M8 20.5h12"/>',
  school: '<path d="M4 24V12h20v12z"/><path d="M2 12l12-7 12 7"/><path d="M12 24v-5h4v5"/>',
  refurbishment: '<path d="M7 23V11l7-5.5L21 11v12"/><path d="M3 23h22M4 8v15M24 8v15M4 13h20"/>',
  generic: '<path d="M5 8l9-4 9 4v12l-9 4-9-4z"/><path d="M5 8l9 4 9-4M14 12v12"/>',
};
function sparkSvg(p, w = 300, h = 64) {
  // top-level summaries: nodes whose parent is not in the list (P6 hangs WBS off a project node it does
  // not export); a single root is stepped through to its children; no WBS at all draws activities
  const ids = new Set(p.wbs.map(x => x.id)), isTop = x => !x.parent_id || !ids.has(x.parent_id);
  let tops = p.wbs.filter(isTop);
  while (tops.length === 1 && p.wbs.some(x => x.parent_id === tops[0].id)) { const r = tops[0].id; tops = p.wbs.filter(x => x.parent_id === r); }
  tops = tops.sort((a, b) => a.seq - b.seq).slice(0, 7);
  const dates = p.activities.flatMap(a => [a.actual_start || a.early_start, a.actual_finish || a.early_finish]).filter(Boolean).map(d => new Date(d).getTime());
  const t0 = Math.min(new Date(p.start).getTime(), ...dates), t1 = Math.max(new Date(p.finish || p.start).getTime() || t0 + DAY, ...dates); const span = Math.max(DAY, t1 - t0);
  const X = t => 6 + (new Date(t).getTime() - t0) / span * (w - 12);
  const inW = {}; const topIds = new Set(tops.map(x => x.id));
  const parent = id => { let n = p.wbs.find(x => x.id === id), g = 0; while (n && !topIds.has(n.id) && n.parent_id && g++ < 50) n = p.wbs.find(x => x.id === n.parent_id); return n && topIds.has(n.id) ? n.id : null; };
  p.activities.forEach(a => { const k = parent(a.wbs_id); if (k) (inW[k] = inW[k] || []).push(a); });
  if (!tops.length) { const acts = p.activities.filter(a => a.early_start || a.actual_start).sort((a, b) => (a.actual_start || a.early_start).localeCompare(b.actual_start || b.early_start)); const per = Math.ceil(acts.length / 7) || 1; for (let i = 0; i < acts.length; i += per) { const id = '__g' + i; tops.push({ id }); inW[id] = acts.slice(i, i + per); } }
  const rowH = (h - 10) / Math.max(1, tops.length); let s = `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">`;
  tops.forEach((wb, i) => {
    const acts = inW[wb.id] || []; const st = acts.map(a => a.actual_start || a.early_start).filter(Boolean).sort()[0], fi = acts.map(a => a.actual_finish || a.early_finish).filter(Boolean).sort().slice(-1)[0];
    if (!st || !fi) return; const y = 5 + i * rowH + rowH * .2, bh = Math.max(3, rowH * .6);
    const crit = acts.some(a => a.critical && a.status !== 'complete');
    const tot = acts.reduce((t, a) => t + a.duration_hours, 0) || 1; const pc = acts.reduce((t, a) => t + a.duration_hours * (a.status === 'complete' ? 100 : a.percent_complete), 0) / tot;
    const bw = Math.max(bh, X(fi) - X(st)), x0 = Math.max(6, Math.min(X(st), w - 6 - bw));   // keep short bars inside the card
    s += `<rect x="${x0}" y="${y}" width="${bw}" height="${bh}" rx="${bh / 2}" fill="${crit ? 'var(--crit)' : 'var(--bar)'}" opacity="${crit ? .85 : .7}"/>`;
    if (pc > 0) s += `<rect x="${x0}" y="${y}" width="${Math.max(bh, bw * pc / 100)}" height="${bh}" rx="${bh / 2}" fill="var(--progress)"/>`;
  });
  const ddx = X(p.data_date || p.start); s += `<line x1="${ddx}" y1="2" x2="${ddx}" y2="${h - 2}" stroke="var(--dd)" stroke-width="1.5" stroke-dasharray="3 3"/>`;
  if (p.must_finish_by) { const mx = Math.min(w - 2, X(p.must_finish_by)); s += `<line x1="${mx}" y1="2" x2="${mx}" y2="${h - 2}" stroke="var(--crit)" stroke-width="1.5" stroke-dasharray="2 3"/>`; }
  return s + '</svg>';
}
function heroArt() {
  // a stylised programme: a staircase of bars, the critical chain in red, the data date in purple
  const rows = [[4, 16, 0], [14, 30, 1], [26, 22, 1], [34, 26, 0], [44, 30, 1], [58, 18, 0], [66, 22, 1], [80, 14, 1]];
  let s = '<svg viewBox="0 0 400 230" role="img" aria-label="Illustration of a Gantt chart with a critical path">';
  for (let i = 0; i < 6; i++) s += `<line x1="${20 + i * 72}" y1="10" x2="${20 + i * 72}" y2="220" stroke="var(--line-2)"/>`;
  rows.forEach(([x, w, c], i) => { const y = 18 + i * 25; s += `<rect x="${20 + x * 3.6}" y="${y}" width="${w * 3.6}" height="13" rx="6.5" fill="${c ? 'var(--crit)' : 'var(--bar)'}" opacity="${c ? .9 : .65}"/>`; if (i < 3) s += `<rect x="${20 + x * 3.6}" y="${y}" width="${w * 3.6 * (i === 2 ? .45 : 1)}" height="13" rx="6.5" fill="var(--progress)"/>`; });
  s += '<line x1="128" y1="8" x2="128" y2="222" stroke="var(--dd)" stroke-width="2" stroke-dasharray="5 4"/><rect x="98" y="0" width="60" height="16" rx="8" fill="var(--dd)"/><text x="128" y="11.5" text-anchor="middle" fill="#fff" font-size="10" font-weight="650">Data date</text>';
  s += '<path d="M352 212l8-8 8 8-8 8z" fill="var(--ms)"/>';
  return s + '</svg>';
}
async function renderProjects() {
  const el = $('#scrProjects'); const list = S.list || [];
  const missing = list.filter(p => !S.details[p.id] || S.details[p.id].project.scheduled_at !== p.scheduled_at);
  paintProjects(el, list);
  if (missing.length) {
    await Promise.all(missing.slice(0, 30).map(async p => { try { const v = await api('/api/projects/' + encodeURIComponent(p.id)); S.details[p.id] = { project: v.project, report: v.report }; } catch { } }));
    if (S.screen === 'projects') paintProjects(el, S.list || []);
  }
}
function paintProjects(el, list) {
  const scroll = el.scrollTop;
  const card = item => {
    const d = S.details[item.id]; const p = d && d.project;
    if (!p) return `<div class="card" role="button" tabindex="0" data-open="${esc(item.id)}"><div class="card-top"><div><h3>${esc(item.name)}</h3><div class="sub mono">${esc(item.id)}</div></div></div><div class="spark"></div><div class="hint">${item.activities} activities</div></div>`;
    const [cls, label] = statusOf(p, d.report); const pr = progressOf(p); const crit = p.activities.filter(a => a.critical && a.status !== 'complete').length;
    const spare = spareDays(p);
    return `<div class="card" role="button" tabindex="0" data-open="${esc(item.id)}" aria-label="Open ${esc(p.name)}">
      <div class="card-top"><div style="min-width:0"><h3>${esc(p.name)}</h3><div class="sub"><span class="mono">${esc(p.id)}</span> · ${p.activities.length} activities</div></div><span class="chip ${cls}">${label}</span></div>
      ${sparkSvg(p)}
      <div class="card-facts">
        <div class="fact"><div class="k">Finish</div><div class="v" ${spare != null && spare < 0 ? 'style="color:var(--crit)"' : ''}>${fmtD(p.finish)}</div></div>
        <div class="fact"><div class="k">Health</div><div class="v" style="color:${d.report ? healthColour(d.report.score) : 'inherit'}">${d.report ? d.report.score : '–'}</div></div>
        <div class="fact"><div class="k">Critical</div><div class="v">${crit}</div></div>
      </div>
      <div><div style="display:flex;justify-content:space-between;font-size:12px;color:var(--ink-2);margin-bottom:5px"><span>${Math.round(pr.pct)}% complete</span><span>${spare == null ? 'No deadline' : spare >= 0 ? `${spare} days spare` : `${-spare} days over`}</span></div>
      <div class="meter" title="Complete, with a tick at where the programme says it should be by the data date"><b style="width:${Math.min(100, pr.pct)}%"></b><i style="left:${Math.min(99.5, pr.planned)}%"></i></div></div>
      <button type="button" class="icon card-del" data-del="${esc(p.id)}" title="Delete project" aria-label="Delete ${esc(p.name)}"><svg viewBox="0 0 20 20" class="ic"><path d="M4 6h12M8 6V4h4v2M6 6l1 10h6l1-10"/></svg></button>
    </div>`;
  };
  el.innerHTML = `<div class="page">
    <div class="page-head"><div><h1 class="display">Projects</h1><p class="lede">${list.length ? `${list.length} programme${list.length > 1 ? 's' : ''}. Status compares each forecast with its deadline and with the progress expected by its data date.` : 'Plan a building in a minute, then keep it on track week by week.'}</p></div>
      <div class="head-actions"><button type="button" class="btn" id="pAsk" hidden>Describe it to Claude</button><button type="button" class="btn" id="pImport">Import from P6, Asta or MS Project</button><button type="button" class="primary" id="pNew">New programme</button></div></div>
    ${list.length ? '' : `<div class="hero"><div><h2>Describe the job. Get a programme that explains itself.</h2><p>Six questions, or a brief in plain English, become a linked, scheduled, health-checked programme. It briefs you every week on what moved and why, answers questions from the schedule, lets you try changes before you keep them, and opens in P6, Asta Powerproject and MS Project.</p><div class="head-actions"><button type="button" class="primary" id="pNew3">Start a programme</button><button type="button" class="btn" id="pSample">Open a sample</button></div></div><div class="hero-art">${heroArt()}</div></div>`}
    <div class="cards">${list.map(card).join('')}<button type="button" class="card new" id="pNew2"><span class="plus"><svg viewBox="0 0 20 20" class="ic"><path d="M10 4v12M4 10h12"/></svg></span><b style="color:var(--ink)">New programme</b><span class="hint" style="max-width:30ch">Six questions, or a brief, to a linked, scheduled and health-checked programme.</span></button></div>
  </div>`;
  el.scrollTop = scroll;
  ['#pNew', '#pNew2', '#pNew3'].forEach(s => { const b = el.querySelector(s); if (b) b.onclick = () => startFlow(); });
  el.querySelector('#pImport').onclick = () => $('#fileIn').click();
  const ask = el.querySelector('#pAsk'); if (ask) { ask.onclick = () => openAssistant('Plan a '); (LOCAL ? getSample() : Promise.resolve(true)).then(sm => { ask.hidden = !sm; }); }
  const sample = el.querySelector('#pSample'); if (sample) sample.onclick = () => buildFromBrief({ name: 'Sample: two-storey house', building_type: 'house', storeys: 2, units: 0, gross_internal_area_m2: 0, frame: null, foundations: null, envelope: null, roof: null, fit_out: 'full', basement: false, demolition: false, service_diversion: false, contaminated_ground: false, external_works: true, six_day_week: false, start_date: null, deadline: null, planning_condition_date: null });
  el.querySelectorAll('[data-open]').forEach(c => {
    c.onclick = e => { if (e.target.closest('[data-del]')) return; openProject(c.dataset.open, 'overview'); };
    c.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openProject(c.dataset.open, 'overview'); } };
  });
  el.querySelectorAll('[data-del]').forEach(b => b.onclick = async e => {
    e.stopPropagation();
    if (!b.classList.contains('armed')) { b.classList.add('armed'); b.style.color = 'var(--crit)'; b.title = 'Click again to delete'; toast('Click the bin again to delete this project. This cannot be undone.', { ms: 3500 }); setTimeout(() => { b.classList.remove('armed'); b.style.color = ''; }, 3500); return; }
    try { await api('/api/projects/' + encodeURIComponent(b.dataset.del), { method: 'DELETE' }); delete S.details[b.dataset.del]; if (S.pid === b.dataset.del) { S.pid = null; S.project = null; } toast('Project deleted'); loadList(); } catch (err) { toast(err.message); }
  });
}

// ---------- Monitor: forecast, health, look-ahead and progress ----------
function renderMonitor() {
  const p = S.project, r = S.report, el = $('#scrMonitor'); if (!p) return;
  const scroll = el.scrollTop;
  const [cls, label] = statusOf(p, r); const pr = progressOf(p); const spare = spareDays(p);
  const dd = new Date(p.data_date || p.start), horizon = new Date(dd.getTime() + 21 * DAY);
  const crit = p.activities.filter(a => a.critical && a.status !== 'complete' && a.early_start).sort((a, b) => a.early_start.localeCompare(b.early_start));
  const ahead = p.activities.filter(a => a.type === 'task' && a.status !== 'complete' && (a.status === 'in_progress' || (a.early_start && new Date(a.early_start) <= horizon))).sort((a, b) => (a.actual_start || a.early_start || '').localeCompare(b.actual_start || b.early_start || '')).slice(0, 16);
  const C = 2 * Math.PI * 27, score = r ? r.score : 0, ringFrom = S.ringShown[p.id] ? C * (1 - score / 100) : C;
  const failing = r ? r.checks.filter(c => c.applicable && !c.passed) : []; const passing = r ? r.checks.filter(c => c.applicable && c.passed).length : 0;
  const x = S.extra || {};
  const questions = x.draft && x.draft.questions_for_client ? x.draft.questions_for_client : [];
  const finishNote = spare == null ? 'No deadline set. Type “finish by 30 Oct 2026” to add one.' : spare >= 0 ? `${spare} working days inside the ${fmtD(p.must_finish_by)} deadline` : `${-spare} working days past the ${fmtD(p.must_finish_by)} deadline`;
  const progNote = pr.baselined ? `${Math.round(pr.planned)}% expected by the data date against the baseline` : `${Math.round(pr.planned)}% scheduled by the data date. Set a baseline to track slippage.`;
  el.innerHTML = `<div class="page">
    <div class="page-head"><div style="min-width:0"><h1 class="display">${esc(p.name)}</h1><p class="lede">Data date ${fmtLong(p.data_date || p.start)} · <span class="chip ${cls}">${label}</span></p></div>
      <div class="head-actions"><button type="button" class="primary" id="mSite">Site update</button><button type="button" class="btn" id="mPlan">Open the programme</button></div></div>
    <div class="kpis">
      <div class="kpi"><div class="k">Forecast finish</div><div class="big" ${spare != null && spare < 0 ? 'style="color:var(--crit)"' : ''}>${fmtD(p.finish)}</div><div class="note">${finishNote}</div></div>
      <div class="kpi"><div class="k">Schedule health</div><div class="kpi-ring"><svg class="ring" viewBox="0 0 64 64" aria-hidden="true"><circle class="track" cx="32" cy="32" r="27"/><circle id="ringArc" cx="32" cy="32" r="27" stroke="${healthColour(score)}" stroke-dasharray="${C}" stroke-dashoffset="${ringFrom}" style="transition:stroke-dashoffset .9s cubic-bezier(.2,.8,.2,1)"/></svg><div><div class="big">${r ? score : '–'}</div><div class="note">${failing.length ? `${failing.length} of ${failing.length + passing} checks failing` : 'All DCMA checks pass'}</div></div></div></div>
      <div class="kpi"><div class="k">Progress</div><div class="big">${Math.round(pr.pct)}%</div><div class="meter"><b style="width:${Math.min(100, pr.pct)}%"></b><i style="left:${Math.min(99.5, pr.planned)}%"></i></div><div class="note">${progNote}</div></div>
      <div class="kpi"><div class="k">Critical path</div><div class="big">${crit.length}</div><div class="note">activities still to do with no spare time. Any delay to these moves the finish.</div></div>
    </div>
    <div class="mon-grid">
      <div class="mon-main">
        <section class="panel" aria-labelledby="hLook"><div class="panel-head"><h2 id="hLook">Next three weeks</h2><span class="hint">Drag to record progress, then save</span></div>
          ${ahead.length ? ahead.map(a => { const v = S.staged[a.id] ?? (a.status === 'complete' ? 100 : Math.round(a.percent_complete)); return `<div class="upd ${S.staged[a.id] != null ? 'changed' : ''}" data-id="${esc(a.id)}"><div style="min-width:0"><div class="t" style="font-weight:600;overflow-wrap:anywhere">${a.critical ? '<span class="swatch" style="background:var(--crit)" title="Critical"></span>' : ''}${esc(a.name)}</div><div class="s hint" style="font-size:12px"><span class="mono">${esc(a.id)}</span> · ${a.status === 'in_progress' ? 'started ' + fmtD(a.actual_start) : 'starts ' + fmtD(a.early_start)} · finishes ${fmtD(a.early_finish)}</div></div><input type="range" min="0" max="100" step="5" value="${v}" aria-label="Percent complete for ${esc(a.name)}" id="upd_${esc(a.id)}"><span class="pct">${v}%</span></div>`; }).join('') : '<div class="empty"><b>Nothing due</b>No activities start or run in the next three weeks.</div>'}
          <div class="upd-foot"><label class="datefield" style="display:flex;gap:8px;align-items:center;font-size:12.5px;color:var(--ink-2)">As of<input type="date" id="updAsOf" value="${(p.data_date || p.start).slice(0, 10)}"></label><span class="hint" id="updCount">${Object.keys(S.staged).length ? Object.keys(S.staged).length + ' unsaved' : ''}</span><button type="button" class="primary" id="updSave" ${Object.keys(S.staged).length ? '' : 'disabled'}>Save progress</button></div>
        </section>
        ${periodsPanel(p)}
        <section class="panel" aria-labelledby="hDrive"><div class="panel-head"><h2 id="hDrive">What is driving the finish</h2><span class="hint">The critical path, in order</span></div>
          <div class="list">${crit.slice(0, 10).map(a => `<div class="li click" data-goto="${esc(a.id)}" role="button" tabindex="0"><div style="min-width:0"><div class="t">${esc(a.name)}</div><div class="s"><span class="mono">${esc(a.id)}</span> · ${fmtD(a.actual_start || a.early_start)} to ${fmtD(a.early_finish)} · ${fmt1(daysOf(a, a.duration_hours))}d</div></div><span class="chip ${a.total_float_hours < 0 ? 'bad' : 'plain'}">${fmt1(daysOf(a, a.total_float_hours || 0))}d float</span></div>`).join('') || '<div class="empty"><b>No critical path</b>Every remaining activity has spare time.</div>'}${crit.length > 10 ? `<div class="li"><span class="hint">and ${crit.length - 10} more</span></div>` : ''}</div>
        </section>
        <section class="panel" aria-labelledby="hHealth"><div class="panel-head"><h2 id="hHealth">Health checks</h2>${failing.length ? '<button type="button" class="primary" id="mFix">Auto-repair</button>' : '<span class="chip ok">All passing</span>'}</div>
          <div class="list">${failing.map(c => `<div class="check fail"><span class="dot"></span><b>${esc(c.title)}</b><span class="hint mono">${c.value != null ? c.value : ''}${c.threshold ? ' · ' + esc(c.threshold) : ''}</span><div class="d">${esc(c.detail)}</div>${c.items && c.items.length ? `<div class="items">${c.items.slice(0, 24).map(i => `<a data-goto="${esc(i.split('->')[0])}">${esc(i)}</a>`).join(', ')}${c.items.length > 24 ? ' …' : ''}</div>` : ''}</div>`).join('')}
          ${r ? `<div class="check"><span class="dot"></span><b>${passing} checks pass</b><span></span><div class="d">${esc(r.checks.filter(c => c.applicable && c.passed).map(c => c.title).join(', '))}</div></div>` : ''}</div>
        </section>
        <section class="panel" aria-labelledby="hNotes"><div class="panel-head"><h2 id="hNotes">Assumptions and open questions</h2></div>
          ${(p.assumptions || []).length ? `<ul class="bullets">${p.assumptions.map(a => `<li>${esc(a)}</li>`).join('')}</ul>` : '<p class="hint">No assumptions recorded.</p>'}
          ${questions.length ? `<h3 style="font-size:14px;margin:16px 0 6px">Ask the client</h3><ul class="bullets">${questions.map(q => `<li>${esc(q)}</li>`).join('')}</ul>` : ''}
          ${x.still_open && x.still_open.length ? `<h3 style="font-size:14px;margin:16px 0 6px">Left open by the repairer</h3><ul class="bullets">${x.still_open.map(q => `<li>${esc(q)}</li>`).join('')}</ul>` : ''}
          <h3 style="font-size:14px;margin:16px 0 6px">Baselines</h3>${p.baselines.length ? `<div class="list">${p.baselines.map(b => `<div class="li"><div><div class="t">${esc(b.name)}</div><div class="s">saved ${fmtD(b.saved_at)} · finish ${fmtD(b.finish)}</div></div><button type="button" class="btn" data-bl="${esc(b.name)}">Compare</button></div>`).join('')}</div>` : '<p class="hint" style="margin:0">None yet. Set one from Plan, More, before work starts so slippage shows.</p>'}
        </section>
      </div>
      <aside class="mon-side" aria-label="Progress charts">${progressVisuals(p, r, false)}</aside>
    </div></div>`;
  el.scrollTop = scroll; drawViz(el);
  if (!S.ringShown[p.id]) { S.ringShown[p.id] = true; requestAnimationFrame(() => requestAnimationFrame(() => { const arc = $('#ringArc'); if (arc) arc.style.strokeDashoffset = C * (1 - score / 100); })); }
  el.querySelector('#mPlan').onclick = () => go('plan');
  el.querySelector('#mSite').onclick = siteUpdateSheet; el.querySelector('#perClose').onclick = closePeriodDialog; el.querySelector('#perBuilt').onclick = exportAsBuilt;
  el.querySelectorAll('[data-pdel]').forEach(b => b.onclick = () => deletePeriod(b.dataset.pdel));
  el.querySelectorAll('[data-pcmp]').forEach(b => b.onclick = () => { const r = (p.revisions || []).find(x => x.name === b.dataset.pcmp); if (r && window.PlannerEngine) compareSheet(window.PlannerEngine.compareProjects(r.project, S.project)); });
  const fix = el.querySelector('#mFix'); if (fix) fix.onclick = () => act('/repair');
  el.querySelectorAll('[data-goto]').forEach(n => { const goTo = () => { const id = n.dataset.goto; if (!byId(id)) return; go('plan'); S.sel = new Set([id]); S.active = id; paintSelection(); const i = S.rowsCache.findIndex(q => rowKey(q) === id); if (i >= 0) scrollToRow(i); if (S.inspector) renderInspector(); }; n.onclick = goTo; n.onkeydown = e => { if (e.key === 'Enter') goTo(); }; });
  el.querySelectorAll('[data-bl]').forEach(b => b.onclick = () => { act('/baseline/use', { name: b.dataset.bl }); S.view.baseline = true; $('#vBaseline').checked = true; });
  el.querySelectorAll('.upd input[type=range]').forEach(inp => {
    const row = inp.closest('.upd'), id = row.dataset.id, a = byId(id); const orig = a.status === 'complete' ? 100 : Math.round(a.percent_complete);
    inp.oninput = () => { const v = +inp.value; row.querySelector('.pct').textContent = v + '%'; if (v === orig) delete S.staged[id]; else S.staged[id] = v; row.classList.toggle('changed', S.staged[id] != null); const n = Object.keys(S.staged).length; $('#updCount').textContent = n ? n + ' unsaved' : ''; $('#updSave').disabled = !n; };
  });
  el.querySelector('#updSave').onclick = () => {
    const asOf = el.querySelector('#updAsOf').value; const staged = { ...S.staged }; const n = Object.keys(staged).length; if (!n) return;
    S.staged = {};
    mutate(pp => { if (asOf) pp.data_date = asOf + 'T08:00:00'; Object.entries(staged).forEach(([id, v]) => { const a = byId(id); if (a) setProgress(a, v, asOf ? new Date(asOf + 'T16:00:00') : null); }); }, `Progress saved for ${n} activit${n === 1 ? 'y' : 'ies'}${asOf ? ' as of ' + fmtD(asOf) : ''}`);
  };
}
// ---------- progress visuals: S-curve, phases, milestones, three-week look-ahead ----------
const tasksOf = p => p.activities.filter(a => a.type === 'task' && a.duration_hours > 0);
const ms = v => new Date(v).getTime();
function cumAt(list, T, tot) { let s = 0; for (const [d, a, b] of list) s += d * (T <= a ? 0 : T >= b ? 1 : (T - a) / Math.max(1, b - a)); return s / tot * 100; }
function sCurveData(p) {
  const tasks = tasksOf(p); const tot = tasks.reduce((s, a) => s + a.duration_hours, 0) || 1;
  const fc = tasks.filter(a => (a.actual_start || a.early_start) && (a.actual_finish || a.early_finish)).map(a => [a.duration_hours, ms(a.actual_start || a.early_start), ms(a.actual_finish || a.early_finish)]);
  const bl = tasks.some(a => a.baseline_start) ? tasks.filter(a => a.baseline_start && a.baseline_finish).map(a => [a.duration_hours, ms(a.baseline_start), ms(a.baseline_finish)]) : null;
  const all = fc.concat(bl || []); if (!all.length) return null;
  let t0 = Math.min(...all.map(x => x[1]), ms(p.start)), t1 = Math.max(...all.map(x => x[2]));
  const d0 = new Date(t0); t0 = new Date(d0.getFullYear(), d0.getMonth(), d0.getDate() - ((d0.getDay() + 6) % 7)).getTime();
  const weeks = []; for (let t = t0; t <= t1 + 7 * DAY; t += 7 * DAY) weeks.push(t);
  return { weeks, fc: weeks.map(t => cumAt(fc, t, tot)), bl: bl ? weeks.map(t => cumAt(bl, t, tot)) : null, dd: ms(p.data_date || p.start), actual: progressOf(p).pct, periods: periodsOf(p).filter(q => ms(q.data_date) < ms(p.data_date || p.start)).map(q => [ms(q.data_date), q.pct, q.name]) };
}
function phaseRows(p) {
  const dd = ms(p.data_date || p.start); const top = id => { let n = p.wbs.find(x => x.id === id); while (n && n.parent_id) n = p.wbs.find(x => x.id === n.parent_id); return n; };
  const groups = new Map(); p.wbs.filter(w => !w.parent_id).sort((a, b) => a.seq - b.seq).forEach(w => groups.set(w.id, { w, acts: [] }));
  tasksOf(p).forEach(a => { const t = top(a.wbs_id); if (t && groups.has(t.id)) groups.get(t.id).acts.push(a); });
  return [...groups.values()].filter(g => g.acts.length).map(({ w, acts }) => {
    const tot = acts.reduce((s, a) => s + a.duration_hours, 0) || 1;
    const done = acts.reduce((s, a) => s + a.duration_hours * (a.status === 'complete' ? 100 : a.percent_complete), 0) / tot;
    const plan = cumAt(acts.filter(a => (a.baseline_start || a.early_start) && (a.baseline_finish || a.early_finish)).map(a => [a.duration_hours, ms(a.baseline_start || a.early_start), ms(a.baseline_finish || a.early_finish)]), dd, tot);
    const crit = acts.some(a => a.critical && a.status !== 'complete');
    return { name: w.name, done, plan, crit, finish: acts.map(a => a.actual_finish || a.early_finish).filter(Boolean).sort().slice(-1)[0] };
  });
}
function lookAhead(p, n = 12) {
  const dd = new Date(p.data_date || p.start), horizon = new Date(dd.getTime() + 21 * DAY);
  return p.activities.filter(a => a.type === 'task' && a.status !== 'complete' && (a.status === 'in_progress' || (a.early_start && new Date(a.early_start) <= horizon))).sort((a, b) => (a.actual_start || a.early_start || '').localeCompare(b.actual_start || b.early_start || '')).slice(0, n);
}
function milestonesHtml(p) {
  const cal = p.calendars[p.default_calendar_id] || { working_days: [0, 1, 2, 3, 4], exceptions: {} };
  const list = p.activities.filter(a => a.type === 'start_milestone' || a.type === 'finish_milestone').map(a => ({ a, f: a.actual_finish || a.actual_start || (a.type === 'start_milestone' ? a.early_start : a.early_finish) })).filter(x => x.f).sort((x, y) => x.f.localeCompare(y.f));
  if (!list.length) return '<p class="hint" style="margin:0">No milestones in this programme.</p>';
  const last = list[list.length - 1].a;
  return `<div class="mlist">${list.slice(0, 9).map(({ a, f }) => {
    const ref = a.baseline_finish || (a === last && p.must_finish_by) || null; const done = a.status === 'complete';
    let chip = '<span class="chip plain">No target</span>';
    if (done) chip = '<span class="chip ok">Achieved</span>';
    else if (ref) { const v = workingDaysBetween(cal, new Date(ref), new Date(f)); chip = v > 0 ? `<span class="chip bad">${v}d late</span>` : v < 0 ? `<span class="chip ok">${-v}d early</span>` : '<span class="chip ok">On time</span>'; }
    return `<div class="mrow"><svg viewBox="0 0 12 12" class="mdia" aria-hidden="true"><path d="M6 .8L11.2 6 6 11.2.8 6z" fill="${done ? 'var(--ink-3)' : a.critical ? 'var(--crit)' : 'var(--ms)'}"/></svg><div style="min-width:0"><div class="t">${esc(a.name)}</div><div class="s">${done ? 'achieved' : 'forecast'} ${fmtD(f)}${ref && !done ? ` · ${a.baseline_finish ? 'baseline' : 'deadline'} ${fmtD(ref)}` : ''}</div></div>${chip}</div>`;
  }).join('')}</div>${list.length > 9 ? `<p class="hint" style="margin:6px 0 0;font-size:12px">and ${list.length - 9} more</p>` : ''}`;
}
function progressVisuals(p, r, compact) {
  const d = sCurveData(p), pr = progressOf(p), phases = phaseRows(p);
  const key = (kind, label) => `<span class="lg"><svg viewBox="0 0 22 10" aria-hidden="true">${kind === 'fc' ? '<path d="M1 5h20" stroke="var(--accent)" stroke-width="2" stroke-linecap="round"/>' : kind === 'bl' ? '<path d="M1 5h20" stroke="var(--ink-3)" stroke-width="2" stroke-dasharray="4 3"/>' : kind === 'act' ? '<circle cx="11" cy="5" r="4" fill="var(--ink)" stroke="var(--surface)" stroke-width="1.5"/>' : '<path d="M11 0v10" stroke="var(--dd)" stroke-width="1.6" stroke-dasharray="2.5 2"/>'}</svg>${label}</span>`;
  return `
    <section class="vpanel"><div class="vhead"><h3>S-curve</h3><div class="legend">${d && d.bl ? key('bl', 'Baseline') : ''}${key('fc', 'Forecast')}${key('act', 'Actual')}${key('dd', 'Data date')}</div></div>
      ${d ? `<div class="viz" data-viz="scurve" role="img" aria-label="Cumulative progress: ${Math.round(pr.pct)} percent complete against ${Math.round(pr.planned)} percent expected by the data date"></div>` : '<p class="hint">Schedule the programme to see its curve.</p>'}
      <p class="vnote"><b>${Math.round(pr.pct)}%</b> complete against <b>${Math.round(pr.planned)}%</b> ${pr.baselined ? 'planned in the baseline' : 'scheduled'} by the data date${pr.baselined ? '' : '. Set a baseline to compare against the original plan'}.</p></section>
    <section class="vpanel"><div class="vhead"><h3>Progress by phase</h3><span class="hint" style="font-size:12px">tick marks where it should be by now</span></div>
      <div class="phases">${phases.map(g => `<div class="ph" data-tip="${esc(`<b>${esc(g.name)}</b><br>${Math.round(g.done)}% complete · ${Math.round(g.plan)}% expected by the data date<br>finishes ${fmtD(g.finish)}${g.crit ? '<br>on the critical path' : ''}`)}"><div class="ph-name">${g.crit ? '<span class="swatch" style="background:var(--crit)" title="On the critical path"></span>' : ''}${esc(g.name)}</div><div class="ph-bar"><b style="width:${Math.min(100, g.done)}%"></b><i style="left:${Math.min(99.4, g.plan)}%"></i></div><div class="ph-v">${Math.round(g.done)}%</div></div>`).join('') || '<p class="hint">No phases yet.</p>'}</div></section>
    <section class="vpanel"><div class="vhead"><h3>Milestones</h3></div>${milestonesHtml(p)}</section>
    ${compact ? '' : `<section class="vpanel"><div class="vhead"><h3>Three-week look-ahead</h3><span class="hint" style="font-size:12px">from the data date</span></div><div class="viz" data-viz="ahead" role="img" aria-label="Bar chart of the activities running in the next three weeks"></div></section>`}`;
}
function drawViz(root) {
  if (!S.project) return;
  root.querySelectorAll('[data-viz]').forEach(el => { const w = el.clientWidth; if (!w) return; if (el.dataset.viz === 'scurve') drawSCurve(el, w); else if (el.dataset.viz === 'ahead') drawAhead(el, w); });
  root.querySelectorAll('.ph[data-tip]').forEach(n => { n.onpointermove = e => tipText(e, n.dataset.tip); n.onpointerleave = hideTip; });
}
function drawSCurve(el, W) {
  const d = sCurveData(S.project); if (!d) return;
  const H = 190, m = { l: 36, r: 14, t: 10, b: 24 }, iw = W - m.l - m.r, ih = H - m.t - m.b;
  const t0 = d.weeks[0], t1 = d.weeks[d.weeks.length - 1]; const X = t => m.l + (t - t0) / Math.max(1, t1 - t0) * iw, Y = v => m.t + ih - v / 100 * ih;
  let s = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`;
  [0, 25, 50, 75, 100].forEach(v => { s += `<line x1="${m.l}" x2="${W - m.r}" y1="${Y(v)}" y2="${Y(v)}" stroke="var(--line-2)"/><text x="${m.l - 7}" y="${Y(v) + 3.5}" text-anchor="end" fill="var(--ink-3)" font-size="10.5">${v}%</text>`; });
  // month ticks, thinned so labels never touch
  const months = []; for (let dt = new Date(new Date(t0).getFullYear(), new Date(t0).getMonth() + 1, 1); dt.getTime() <= t1; dt.setMonth(dt.getMonth() + 1)) months.push(dt.getTime());
  const step = Math.max(1, Math.ceil(months.length * 46 / iw));
  months.forEach((t, i) => { if (i % step) return; const dt = new Date(t); s += `<line x1="${X(t)}" x2="${X(t)}" y1="${m.t + ih}" y2="${m.t + ih + 4}" stroke="var(--line)"/><text x="${X(t)}" y="${H - 6}" text-anchor="middle" fill="var(--ink-3)" font-size="10.5">${dt.toLocaleDateString('en-GB', { month: 'short' })}${dt.getMonth() === 0 || i === 0 ? ' ' + String(dt.getFullYear()).slice(2) : ''}</text>`; });
  s += `<line x1="${m.l}" x2="${W - m.r}" y1="${Y(0)}" y2="${Y(0)}" stroke="var(--line)"/>`;
  const path = arr => arr.map((v, i) => `${i ? 'L' : 'M'}${X(d.weeks[i]).toFixed(1)},${Y(v).toFixed(1)}`).join('');
  s += `<path d="${path(d.fc)}L${X(t1)},${Y(0)}L${X(t0)},${Y(0)}Z" fill="var(--accent)" opacity=".1"/>`;
  if (d.bl) s += `<path d="${path(d.bl)}" fill="none" stroke="var(--ink-3)" stroke-width="2" stroke-dasharray="5 4" stroke-linejoin="round"/>`;
  s += `<path d="${path(d.fc)}" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
  const ddx = Math.min(W - m.r, Math.max(m.l, X(d.dd)));
  s += `<line x1="${ddx}" x2="${ddx}" y1="${m.t}" y2="${m.t + ih}" stroke="var(--dd)" stroke-width="1.5" stroke-dasharray="4 3"/>`;
  if (d.periods.length) {   // actual progress as recorded at each closed period, joined up to today's figure
    const cl = t => Math.min(W - m.r, Math.max(m.l, X(t))); s += `<path d="${d.periods.map(([t, v], i) => `${i ? 'L' : 'M'}${cl(t).toFixed(1)},${Y(v).toFixed(1)}`).join('')}L${ddx},${Y(d.actual)}" fill="none" stroke="var(--ink)" stroke-width="1.6" stroke-linejoin="round"/>`;
    d.periods.forEach(([t, v, n]) => { s += `<circle cx="${cl(t)}" cy="${Y(v)}" r="3.5" fill="var(--ink)" stroke="var(--surface)" stroke-width="1.5"><title>${esc(n)}: ${Math.round(v)}% done</title></circle>`; });
  }
  const ay = Y(d.actual); s += `<circle cx="${ddx}" cy="${ay}" r="5" fill="var(--ink)" stroke="var(--surface)" stroke-width="2"/>`;
  const lbl = `${Math.round(d.actual)}% done`, right = ddx + 10 + lbl.length * 6.4 < W - m.r;
  s += `<text x="${right ? ddx + 9 : ddx - 9}" y="${ay - 7}" text-anchor="${right ? 'start' : 'end'}" fill="var(--ink)" font-size="11" font-weight="650">${lbl}</text>`;
  s += `<line class="xh" x1="0" x2="0" y1="${m.t}" y2="${m.t + ih}" stroke="var(--ink-3)" stroke-width="1" opacity="0"/><circle class="xd" r="4" fill="var(--accent)" stroke="var(--surface)" stroke-width="2" opacity="0"/>`;
  s += `<rect class="hitbox" x="${m.l}" y="${m.t}" width="${iw}" height="${ih}" fill="transparent"/></svg>`;
  el.innerHTML = s;
  const svg = el.querySelector('svg'), xh = svg.querySelector('.xh'), xd = svg.querySelector('.xd');
  const hit = svg.querySelector('.hitbox');
  hit.onpointermove = e => {
    const r = svg.getBoundingClientRect(); const px = e.clientX - r.left; const t = t0 + (px - m.l) / iw * (t1 - t0);
    const i = Math.max(0, Math.min(d.weeks.length - 1, Math.round((t - t0) / (7 * DAY)))); const x = X(d.weeks[i]);
    xh.setAttribute('x1', x); xh.setAttribute('x2', x); xh.setAttribute('opacity', '.6'); xd.setAttribute('cx', x); xd.setAttribute('cy', Y(d.fc[i])); xd.setAttribute('opacity', '1');
    tipText(e, `<b>Week of ${fmtD(d.weeks[i])}</b><br><b>${Math.round(d.fc[i])}%</b> forecast${d.bl ? `<br><b>${Math.round(d.bl[i])}%</b> baseline` : ''}${d.weeks[i] >= d.dd && d.weeks[i] - 7 * DAY < d.dd ? `<br><b>${Math.round(d.actual)}%</b> actual at the data date` : ''}`);
  };
  hit.onpointerleave = () => { xh.setAttribute('opacity', '0'); xd.setAttribute('opacity', '0'); hideTip(); };
}
function drawAhead(el, W) {
  const p = S.project, acts = lookAhead(p, 12); if (!acts.length) { el.innerHTML = '<p class="hint">Nothing runs in the next three weeks.</p>'; return; }
  const dd = new Date(p.data_date || p.start); const d0 = new Date(dd.getFullYear(), dd.getMonth(), dd.getDate()).getTime(), days = 21, d1 = d0 + days * DAY;
  const rowH = 24, top = 22, lw = Math.min(170, Math.round(W * .4)), iw = W - lw - 8, H = top + acts.length * rowH + 4;
  const X = t => lw + Math.max(0, Math.min(1, (t - d0) / (d1 - d0))) * iw;
  const cal = p.calendars[p.default_calendar_id];
  let s = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`;
  for (let i = 0; i < days; i++) { const t = d0 + i * DAY, dt = new Date(t); if (cal && !isWorking(cal, dt)) s += `<rect x="${X(t)}" y="${top}" width="${iw / days}" height="${H - top}" fill="var(--weekend)"/>`; if (i % 7 === 0) s += `<line x1="${X(t)}" x2="${X(t)}" y1="${top - 4}" y2="${H}" stroke="var(--line)"/><text x="${X(t) + 3}" y="13" fill="var(--ink-3)" font-size="10.5">${dt.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}</text>`; }
  const maxc = Math.max(4, Math.floor((lw - 8) / 6.3));
  acts.forEach((a, i) => {
    const y = top + i * rowH; const s0 = ms(a.actual_start || a.early_start), f0 = ms(a.actual_finish || a.early_finish);
    s += `<line x1="0" x2="${W}" y1="${y + rowH}" y2="${y + rowH}" stroke="var(--line-2)"/>`;
    s += `<text x="0" y="${y + 16}" fill="var(--ink-2)" font-size="11.5">${esc(a.name.length > maxc ? a.name.slice(0, maxc - 1) + '…' : a.name)}</text>`;
    const bx = X(s0), bw = Math.max(3, X(f0) - bx), pct = a.status === 'complete' ? 100 : a.percent_complete;
    const tip = esc(`<b>${esc(a.id)} ${esc(a.name)}</b><br>${fmtD(a.actual_start || a.early_start)} to ${fmtD(a.early_finish)} · ${Math.round(pct)}% complete${a.critical ? '<br>critical' : ''}`);
    s += `<rect class="ab" data-tip="${tip}" x="${bx}" y="${y + 6}" width="${bw}" height="12" rx="2" fill="${a.critical ? 'var(--crit)' : 'var(--bar)'}"/>`;
    if (pct > 0) s += `<rect x="${bx}" y="${y + 6}" width="${bw * Math.min(100, pct) / 100}" height="12" rx="2" fill="#000" opacity=".3" pointer-events="none"/>`;
  });
  s += `<line x1="${X(ms(p.data_date || p.start))}" x2="${X(ms(p.data_date || p.start))}" y1="${top - 4}" y2="${H}" stroke="var(--dd)" stroke-width="1.5" stroke-dasharray="4 3"/></svg>`;
  el.innerHTML = s;
  el.querySelectorAll('.ab').forEach(b => { b.onpointermove = e => tipText(e, b.dataset.tip); b.onpointerleave = hideTip; });
}
let vizResize; addEventListener('resize', () => { clearTimeout(vizResize); vizResize = setTimeout(() => { if (S.screen === 'monitor') drawViz($('#scrMonitor')); if (S.inspector && S.sideTab === 'progress') drawViz($('#inspector')); }, 150); });

// ---------- Start: one guided flow for every new programme ----------
const TYPES = [['house', 'Single house', 'One home'], ['houses', 'Housing scheme', 'Several homes'], ['apartments', 'Apartments', 'A block of flats'], ['office', 'Office', 'Commercial floors'], ['warehouse', 'Warehouse', 'Industrial or logistics'], ['school', 'School', 'Education building'], ['refurbishment', 'Refurbishment', 'Existing building'], ['generic', 'Something else', 'Mixed use or other']];
const DEFAULT_GIA = { house: 150, houses: 95, apartments: 75, office: 1200, warehouse: 3000, school: 2500, refurbishment: 800, generic: 800 };
const BRIEF_KEYS = ['name', 'building_type', 'storeys', 'units', 'frame', 'foundations', 'envelope', 'roof', 'fit_out', 'basement', 'demolition', 'service_diversion', 'contaminated_ground', 'external_works', 'six_day_week', 'start_date', 'deadline', 'planning_condition_date'];
async function buildFromBrief(brief, text) {
  setStatus('saving', 'Building');
  try {
    const v = await post('/api/generate', { brief, text: text || null }); show(v); await loadList(); go('overview'); setStatus('ok', 'Saved');
    toast(`Built ${v.project.activities.length} activities. Forecast finish ${fmtD(v.project.finish)}.`, { ms: 6000, action: { label: 'See health', fn: () => go('monitor') } });
    return true;
  } catch (e) { setStatus('error', 'Not built'); toast(e.message, { ms: 6000 }); return false; }
}
function startFlow(initial = {}) {
  const w = Object.assign({ name: '', building_type: 'house', storeys: 2, units: 0, gia: 0, frame: '', foundations: '', envelope: '', roof: '', fit_out: 'full', basement: false, demolition: false, service_diversion: false, contaminated_ground: false, external_works: true, six_day_week: false, start_date: '', deadline: '', planning_condition_date: '' }, initial);
  let step = 0, mode = 'steps';
  const multi = () => w.building_type === 'houses' || w.building_type === 'apartments';
  const pills = (key, opts) => `<div class="pills" data-key="${key}" role="radiogroup">${opts.map(([v, l]) => `<button type="button" role="radio" aria-checked="${String(w[key]) === String(v)}" data-v="${esc(v)}" class="${String(w[key]) === String(v) ? 'on' : ''}">${esc(l)}</button>`).join('')}</div>`;
  const opt = (label, html) => `<div class="optrow"><span>${label}</span>${html}</div>`;
  const sw = (key, label, sub) => `<label class="sw"><span>${esc(label)}${sub ? `<br><span class="hint" style="font-size:12px;font-weight:400">${esc(sub)}</span>` : ''}</span><input type="checkbox" data-key="${key}" id="sw_${key}" ${w[key] ? 'checked' : ''}><i></i></label>`;
  const estimate = () => { const per = DEFAULT_GIA[w.building_type] || 800; const gia = w.gia || (w.units && multi() ? per * w.units : per * (['office', 'generic'].includes(w.building_type) ? w.storeys : 1)); return { gia, foot: gia / Math.max(1, w.storeys) }; };
  const steps = [
    { q: 'What are you building?', sub: 'Pick the closest type. Every choice after this has a sensible default.', body: () => `<label style="margin-bottom:14px">Project name<input id="sfName" value="${esc(w.name)}" placeholder="e.g. Victoria Road apartments"></label><div class="tiles" role="radiogroup" aria-label="Building type">${TYPES.map(([v, l, s]) => `<button type="button" role="radio" aria-checked="${w.building_type === v}" class="tile ${w.building_type === v ? 'on' : ''}" data-type="${v}"><svg viewBox="0 0 28 28" aria-hidden="true">${TYPE_ICONS[v]}</svg><b>${esc(l)}</b><span>${esc(s)}</span></button>`).join('')}</div>` },
    { q: 'How big is it?', sub: 'Leave the area at 0 and I will estimate it from the type and storeys.', body: () => `<div class="grid"><label>Storeys${stepper('sfStoreys', w.storeys, 1, 1)}</label>${multi() ? `<label>Number of homes${stepper('sfUnits', w.units || (w.building_type === 'apartments' ? 24 : 10), 1, 1)}</label>` : ''}<label>Gross internal area, m²<input type="number" id="sfGia" min="0" step="50" value="${w.gia}"></label></div><p class="hint" id="sfEst" style="margin-top:14px"></p>` },
    { q: 'Structure and envelope', sub: 'Auto picks what an experienced planner would choose for this building.', body: () => opt('Frame', pills('frame', [['', 'Auto'], ['masonry', 'Brick and block'], ['rc', 'Concrete'], ['steel', 'Steel'], ['timber', 'Timber']])) + opt('Foundations', pills('foundations', [['', 'Auto'], ['strip', 'Strip'], ['raft', 'Raft'], ['piled', 'Piled']])) + opt('Envelope', pills('envelope', [['', 'Auto'], ['brick', 'Brick'], ['render', 'Render'], ['cladding', 'Cladding'], ['curtain_wall', 'Curtain wall']])) + opt('Roof', pills('roof', [['', 'Auto'], ['pitched', 'Pitched'], ['flat', 'Flat']])) + opt('Fit-out', pills('fit_out', [['full', 'Full'], ['basic', 'Basic or Cat A'], ['shell', 'Shell and core']])) },
    { q: 'Anything unusual about the site?', sub: 'Each one adds the activities a planner would expect to see.', body: () => `<div class="toggles">${sw('demolition', 'Demolition first', 'Soft strip and knock down')}${sw('contaminated_ground', 'Contaminated ground', 'Remediation and validation')}${sw('service_diversion', 'Service diversions', 'Cables, gas or water mains: adds the undertaker lead-in')}${sw('basement', 'Basement', 'Excavation, propping and retaining walls')}${sw('external_works', 'External works', 'Drainage, roads, parking, landscaping')}${sw('six_day_week', 'Six-day week', 'Saturday working')}</div>` },
    { q: 'When does it start?', sub: 'All optional. With no start date it begins next Monday.', body: () => `<div class="grid"><label>Start on site<input type="date" id="sfStart" value="${w.start_date}"></label><label>Must finish by<input type="date" id="sfDeadline" value="${w.deadline}"></label><label>Planning conditions discharged<input type="date" id="sfPlanning" value="${w.planning_condition_date}"></label></div>` },
    { q: 'Ready to build the programme', sub: 'I will lay out the activities, link them, size them from production rates, schedule them and run the 14-point DCMA health check.', body: () => { const e = estimate(); const t = (TYPES.find(x => x[0] === w.building_type) || [, 'Building'])[1]; const flags = [['demolition', 'demolition'], ['contaminated_ground', 'contaminated ground'], ['service_diversion', 'service diversions'], ['basement', 'basement'], ['six_day_week', 'six-day week']].filter(([k]) => w[k]).map(([, l]) => l); const auto = v => v ? esc(v.replace(/_/g, ' ')) : 'auto'; return `<div class="review"><div class="line"><span>Project</span><b>${esc(w.name || 'New programme')}</b></div><div class="line"><span>Building</span><b>${w.storeys}-storey ${esc(t.toLowerCase())}${multi() && w.units ? `, ${w.units} homes` : ''}</b></div><div class="line"><span>Area</span><b>${w.gia ? pyNum(w.gia) + ' m²' : 'about ' + pyNum(e.gia) + ' m² (estimated)'}</b></div><div class="line"><span>Structure</span><b>${auto(w.frame)} frame, ${auto(w.foundations)} foundations</b></div><div class="line"><span>Envelope and roof</span><b>${auto(w.envelope)}, ${auto(w.roof)} roof, ${esc(w.fit_out)} fit-out</b></div><div class="line"><span>Site</span><b>${flags.length ? esc(flags.join(', ')) : 'nothing unusual'}${w.external_works ? '' : ', no external works'}</b></div><div class="line"><span>Dates</span><b>${w.start_date ? 'start ' + fmtD(w.start_date) : 'start next Monday'}${w.deadline ? ', finish by ' + fmtD(w.deadline) : ''}</b></div></div>`; } },
  ];
  const { m, close } = modal(null, '<div id="sfHost"></div>', null, '', { noActions: true, wide: true, label: 'New programme' });
  const host = m.querySelector('#sfHost');
  const read = () => {
    const v = id => host.querySelector('#' + id);
    if (v('sfName')) w.name = v('sfName').value.trim();
    if (v('sfStoreys')) w.storeys = Math.max(1, Math.round(+v('sfStoreys').value || 1));
    if (v('sfUnits')) w.units = Math.max(0, Math.round(+v('sfUnits').value || 0));
    if (v('sfGia')) w.gia = Math.max(0, +v('sfGia').value || 0);
    if (v('sfStart')) { w.start_date = v('sfStart').value; w.deadline = v('sfDeadline').value; w.planning_condition_date = v('sfPlanning').value; }
  };
  const brief = () => ({ name: w.name || 'New programme', building_type: w.building_type, storeys: w.storeys || 1, units: multi() ? (w.units || 0) : (w.building_type === 'house' ? 1 : 0), gross_internal_area_m2: w.gia || 0, frame: w.frame || null, foundations: w.foundations || null, envelope: w.envelope || null, roof: w.roof || null, fit_out: w.fit_out, basement: w.basement, demolition: w.demolition, service_diversion: w.service_diversion, contaminated_ground: w.contaminated_ground, external_works: w.external_works, six_day_week: w.six_day_week, start_date: w.start_date || null, deadline: w.deadline || null, planning_condition_date: w.planning_condition_date || null });
  function draw(dir = 0) {
    if (mode === 'paste') {
      host.innerHTML = `<h2 class="q">Paste a written brief</h2><p class="qsub">I read the type, size, structure, site conditions and dates, then show you what I understood before building.</p><textarea id="sfText" rows="7" style="width:100%" placeholder="New-build 24-unit three-storey apartment block in Leeds, RC frame on CFA piles, brick envelope. Start on site 6 April 2026, handover before Christmas 2027. Brownfield site with a live 11kV cable to divert."></textarea><div class="actions"><button type="button" id="sfBack">Back</button><button type="button" class="primary" id="sfRead">Read the brief</button></div>`;
      host.querySelector('#sfBack').onclick = () => { mode = 'steps'; draw(-1); };
      host.querySelector('#sfRead').onclick = async () => {
        const text = host.querySelector('#sfText').value.trim(); if (!text) { host.querySelector('#sfText').focus(); return; }
        try { const b = await post('/api/brief/parse', { text }); BRIEF_KEYS.forEach(k => { if (b[k] != null && b[k] !== '') w[k] = b[k]; }); w.gia = b.gross_internal_area_m2 || 0; ['frame', 'foundations', 'envelope', 'roof'].forEach(k => { w[k] = b[k] || ''; }); ['start_date', 'deadline', 'planning_condition_date'].forEach(k => { w[k] = b[k] || ''; }); w._text = text; mode = 'steps'; step = steps.length - 1; draw(1); }
        catch (e) { toast(e.message); }
      };
      setTimeout(() => host.querySelector('#sfText').focus(), 50); return;
    }
    if (mode === 'blank') {
      host.innerHTML = `<h2 class="q">Start from a blank programme</h2><p class="qsub">An empty programme with standard calendars. Add activities in the grid or with commands.</p><div class="grid"><label>Project name<input id="sbName" value="${esc(w.name || 'New project')}"></label><label>Start on site<input id="sbStart" type="date" value="${w.start_date || ymd(new Date())}"></label></div><div class="actions"><button type="button" id="sfBack">Back</button><button type="button" class="primary" id="sbGo">Create</button></div>`;
      host.querySelector('#sfBack').onclick = () => { mode = 'steps'; draw(-1); };
      host.querySelector('#sbGo').onclick = async () => { try { const v = await post('/api/projects', { name: host.querySelector('#sbName').value || 'New project', start: host.querySelector('#sbStart').value || ymd(new Date()) }); close(); show(v); await loadList(); go('plan'); } catch (e) { toast(e.message); } };
      return;
    }
    const s = steps[step], last = step === steps.length - 1;
    host.innerHTML = `<div class="steps" aria-hidden="true">${steps.map((_, i) => `<i class="${i < step ? 'done' : i === step ? 'cur' : ''}"></i>`).join('')}</div>
      <div class="stepbody"><h2 class="q">${esc(s.q)}</h2><p class="qsub">${esc(s.sub)}</p>${s.body()}</div>
      ${step === 0 ? `<div class="alt"><button type="button" id="sfPaste">Paste a written brief instead</button><button type="button" id="sfBlank">Start blank</button><button type="button" id="sfImport">Import from P6, Asta or MS Project</button></div>` : ''}
      <div class="actions">${step > 0 ? '<button type="button" id="sfBack">Back</button>' : ''}<span style="flex:1"></span><span class="hint" style="align-self:center">Step ${step + 1} of ${steps.length}</span><button type="button" class="primary" id="sfNext">${last ? 'Build programme' : 'Continue'}</button></div>`;
    const body = host.querySelector('.stepbody');
    if (dir) animate(body, { x: 0, opacity: 1 }, { from: { x: 28 * dir, opacity: 0 }, response: .36, done: () => { body.style.transform = ''; springs.delete(body); } });
    wireSteppers(host);
    host.querySelectorAll('[data-type]').forEach(t => t.onclick = () => { read(); w.building_type = t.dataset.type; host.querySelectorAll('[data-type]').forEach(o => { o.classList.toggle('on', o === t); o.setAttribute('aria-checked', String(o === t)); }); });
    host.querySelectorAll('.pills').forEach(g => g.querySelectorAll('button').forEach(b => b.onclick = () => { w[g.dataset.key] = b.dataset.v; g.querySelectorAll('button').forEach(o => { o.classList.toggle('on', o === b); o.setAttribute('aria-checked', String(o === b)); }); }));
    host.querySelectorAll('input[data-key]').forEach(c => c.onchange = () => { w[c.dataset.key] = c.checked; });
    const est = host.querySelector('#sfEst');
    if (est) { const upd = () => { read(); const e = estimate(); est.textContent = `${w.gia ? '' : 'Estimated '}${pyNum(e.gia)} m² over ${w.storeys} storey${w.storeys > 1 ? 's' : ''}: a footprint of about ${pyNum(e.foot)} m²${e.foot > 900 ? ', split into zones so trades can follow each other' : ''}.`; }; host.querySelectorAll('input').forEach(i => i.addEventListener('input', upd)); upd(); }
    if (host.querySelector('#sfPaste')) { host.querySelector('#sfPaste').onclick = () => { read(); mode = 'paste'; draw(1); }; host.querySelector('#sfBlank').onclick = () => { read(); mode = 'blank'; draw(1); }; host.querySelector('#sfImport').onclick = () => { close(); $('#fileIn').click(); }; }
    if (host.querySelector('#sfBack')) host.querySelector('#sfBack').onclick = () => { read(); step--; draw(-1); };
    host.querySelector('#sfNext').onclick = async () => {
      read(); if (!last) { step++; draw(1); return; }
      const btn = host.querySelector('#sfNext'); btn.disabled = true; btn.textContent = 'Building';
      const ok = await buildFromBrief(brief(), w._text); if (ok) close(); else { btn.disabled = false; btn.textContent = 'Build programme'; }
    };
    const first = host.querySelector('#sfName, #sfStoreys, #sfStart'); if (first && innerWidth > 640 && !dir) first.focus();
  }
  draw(0);
}
function pyNum(n) { return Math.round(n).toLocaleString('en-GB'); }

// ---------- command palette ----------
const PAL_EXAMPLES = ['add 2 weeks to A1040', 'link A1010 -> A1020 SS+2d', 'finish by 1 Nov 2026', 'progress A1010 50% as of 20 Apr 2026', 'complete A1010 on 24 Apr 2026', 'constrain A1100 start on or after 16 Mar 2026', 'insert "Scaffold inspection" 1d after A1040 before A1050', 'fix', 'help'];
function palActions() {
  return [
    ['New programme', 'Start', () => startFlow()],
    ['All projects', 'Go to', () => go('projects')],
    S.project && ['Overview', 'Go to', () => go('overview')],
    S.project && ['Plan', 'Go to', () => go('plan')],
    S.project && !S.sandbox && ['Try changes safely (sandbox)', 'Plan', tryStart],
    S.project && S.sandbox && ['Keep the tried changes', 'Plan', tryKeep],
    S.project && S.sandbox && ['Discard the tried changes', 'Plan', tryDiscard],
    ['View as Build (all tools)', 'View', () => setMode('build')],
    ['View as Site (progress first)', 'View', () => setMode('site')],
    ['View as Client (read-only)', 'View', () => setMode('client')],
    S.project && ['Progress (health, charts, periods)', 'Go to', () => go('monitor')],
    ['Ask the AI assistant', 'Assist', () => openAssistant()],
    S.project && ['Critical path drag: what to accelerate', 'Analyse', () => computeDrag()],
    S.project && ['Out-of-sequence progress', 'Check', oosDialog],
    S.project && ['Compare versions', 'Analyse', () => compareSheet()],
    S.project && ['PDF for issue (print)', 'File', printSheet],
    S.project && ['Add a note on the chart', 'Plan', () => noteDialog(null, null, S.active && byId(S.active) ? S.active : null)],
    S.project && ['Issue revision', 'Plan', revisionDialog],
    S.project && ['Site update: record progress on site', 'Progress', siteUpdateSheet],
    S.project && ['Close progress period', 'Progress', closePeriodDialog],
    S.project && ['As-built record (CSV)', 'File', exportAsBuilt],
    S.project && ['Custom fields', 'Set-up', fieldsDialog],
    S.project && ['Codes, fields and views library', 'Set-up', libraryDialog],
    S.project && ['Saved views', 'View', viewsDialog],
    S.project && ['Coding sheet (CSV) export and import', 'Set-up', libraryDialog],
    S.project && ['Share and export', 'File', shareSheet],
    S.project && ['Export to Excel (CSV)', 'File', exportCsv],
    S.project && ['Show the longest path to completion', 'Trace', () => setTrace(finishDrivers(), 'back', 'Longest path to completion')],
    S.project && S.trace && ['Stop tracing', 'Trace', clearTrace],
    S.project && ['Show the next 3 weeks', 'Filter', () => { S.view.show = 'lookahead'; go('plan'); }],
    S.project && ['Show near-critical work', 'Filter', () => { S.view.show = 'near'; go('plan'); }],
    S.project && ['Show milestones only', 'Filter', () => { S.view.show = 'milestones'; go('plan'); }],
    S.project && S.view.show !== 'all' && ['Show everything', 'Filter', () => { S.view.show = 'all'; S.view.filter = ''; go('plan'); }],
    S.project && ['Auto-repair failing checks', 'Fix', () => act('/repair')],
    S.project && ['Set a baseline', 'Plan', () => $('#btnBaseline').click()],
    S.project && ['Level to crew limits', 'Plan', () => act('/level')],
    S.project && ['Schedule risk (Monte Carlo)', 'Analyse', riskSheet],
    S.project && ['Show the inspector', 'View', () => { go('plan'); S.sideTab = 'activity'; toggleInspector(true); }],
    S.project && ['Progress charts beside the programme', 'View', () => { go('plan'); S.sideTab = 'progress'; if (S.inspector) renderInspector(); else toggleInspector(true); }],
    ['Import from P6, Asta or MS Project', 'File', () => $('#fileIn').click()],
    ['Switch light or dark', 'View', toggleTheme],
  ].filter(Boolean);
}
let palSel = 0;
function openPalette() {
  const back = $('#palBack'), f = $('#cmdForm'); $('#cmdOut').textContent = ''; $('#cmdIn').value = '';
  back.hidden = false; back.style.backgroundColor = 'transparent'; requestAnimationFrame(() => { back.style.backgroundColor = ''; });
  f.style.transformOrigin = '50% 0';
  animate(f, { y: 0, scale: 1, opacity: 1 }, { from: springs.has(f) ? undefined : { y: -12, scale: .97, opacity: 0 }, response: .32 });
  palSel = 0; paintPalette(); setTimeout(() => $('#cmdIn').focus(), 0);
}
function closePalette() { const back = $('#palBack'), f = $('#cmdForm'); if (back.hidden) return; back.style.backgroundColor = 'transparent'; animate(f, { y: -8, scale: .98, opacity: 0 }, { response: .24, done: () => { back.hidden = true; back.style.backgroundColor = ''; springs.delete(f); } }); }
function palItems() {
  const t = $('#cmdIn').value.trim(), tl = t.toLowerCase(); const items = [];
  // matching actions first, so a word like "longest" runs the action; anything else runs as a command
  if (t && S.project && looksLikeQuestion(t)) items.push({ sec: 'Answer', label: `Ask: “${t}”`, k: 'Enter', run: () => askInPalette(t) });
  palActions().filter(([l]) => !tl || l.toLowerCase().includes(tl)).forEach(([l, k, fn]) => items.push({ sec: 'Actions', label: l, k, run: () => { closePalette(); fn(); } }));
  if (t && S.project && S.aiReady) items.push({ sec: 'Claude', label: `Ask Claude: “${t}”`, k: '', run: () => { closePalette(); openAssistant(); sendAi(t); } });
  if (t && S.project) items.push({ sec: 'Command', label: `Run “${t}”`, k: items.length ? '' : 'Enter', run: () => runCommand(t) });
  if (S.project && tl.length >= 2) S.project.activities.filter(a => a.id.toLowerCase().includes(tl) || a.name.toLowerCase().includes(tl)).slice(0, 7)
    .forEach(a => items.push({ sec: 'Go to activity', label: `${a.id}  ${a.name}`, k: fmtD(a.actual_start || a.early_start), run: () => { closePalette(); goToActivity(a.id); } }));
  if (S.project && !t) askExamples(4).forEach(e => items.push({ sec: 'Ask a question', label: e, k: '', fill: e }));
  if (S.project) PAL_EXAMPLES.filter(e => !tl || e.includes(tl)).slice(0, t ? 4 : 5).forEach(e => items.push({ sec: 'Try a command', label: e, k: '', fill: e }));
  return items;
}
function paintPalette() {
  const items = palItems(); palSel = Math.max(0, Math.min(palSel, items.length - 1)); let sec = '';
  $('#palList').innerHTML = items.map((it, i) => { const h = it.sec !== sec ? `<div class="pal-sec">${esc(it.sec)}</div>` : ''; sec = it.sec; return h + `<div class="pal-item ${i === palSel ? 'on' : ''}" role="option" aria-selected="${i === palSel}" data-i="${i}">${it.fill ? `<span class="mono">${esc(it.label)}</span>` : esc(it.label)}<span class="k">${esc(it.k)}</span></div>`; }).join('') || '<div class="pal-sec">Open or create a project to run schedule commands</div>';
  $$('#palList .pal-item').forEach(el => { el.onpointerdown = e => e.preventDefault(); el.onclick = () => choosePal(items[+el.dataset.i]); el.onpointermove = () => { if (palSel !== +el.dataset.i) { palSel = +el.dataset.i; $$('#palList .pal-item').forEach(x => x.classList.toggle('on', x === el)); } }; });
  const on = $('#palList .pal-item.on'); if (on) on.scrollIntoView({ block: 'nearest' });
}
function choosePal(it) { if (!it) return; if (it.fill) { $('#cmdIn').value = it.fill; palSel = 0; paintPalette(); $('#cmdIn').focus(); if (looksLikeQuestion(it.fill)) askInPalette(it.fill); return; } it.run(); }
async function runCommand(t) {
  try {
    const v = await post(pidPath('/command'), { text: t });
    if (v.message && v.message.includes('\n') && !v.project) { $('#cmdOut').innerHTML = `<pre style="white-space:pre-wrap;margin:0;font:12px/1.5 var(--mono)">${esc(v.message)}</pre>`; return; }
    closePalette(); if (v.project) show(v); else toast(v.message.split('\n')[0]);
  } catch (err) { $('#cmdOut').textContent = err.message; }
}

// ---------- schedule risk: Monte Carlo on the in-page engine (same maths as planner/risk.py) ----------
const RISK = { iterations: 500, optimistic_pct: 10, pessimistic_pct: 30, weather_pct: 20, correlation_pct: 30 };
const dayCal = () => S.project.calendars[S.project.default_calendar_id] || { working_days: [0, 1, 2, 3, 4], exceptions: {} };
function riskSheet() {
  if (!S.project) return;
  const E = window.PlannerEngine; if (!E || !E.riskRunner) return toast('Risk analysis needs the scheduling engine on this page');
  const { m } = modal('Schedule risk', `
    <p class="hint" style="margin-top:-4px">How likely is the finish date? Each run varies every unfinished activity's duration within the range below and recalculates the critical path.</p>
    <div class="risk-set">
      <label>Best case, quicker by<span class="unit">${stepper('rkLo', RISK.optimistic_pct, 5)}<i>%</i></span></label>
      <label>Worst case, slower by<span class="unit">${stepper('rkHi', RISK.pessimistic_pct, 5)}<i>%</i></span></label>
      <label>Extra for weather-exposed work<span class="unit">${stepper('rkWx', RISK.weather_pct, 5)}<i>%</i></span></label>
      <label>How much delays run together<span class="unit">${stepper('rkCor', RISK.correlation_pct, 10)}<i>%</i></span></label>
      <label>Runs<select id="rkN">${[200, 500, 1000].map(n => `<option ${n === RISK.iterations ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
    </div>
    <div class="rk-go"><button type="button" class="primary" id="rkRun">Run analysis</button><div class="rk-prog" id="rkProg" hidden><i></i></div><span class="hint" id="rkProgT"></span></div>
    <div id="rkOut"></div>`, null, '', { wide: true });
  wireSteppers(m);
  m.querySelector('#rkRun').onclick = () => runRisk(m);
  if (S.risk && S.risk.pid === S.pid && S.risk.stamp === S.project.scheduled_at) paintRisk(m, S.risk.r); else runRisk(m);
}
async function runRisk(m) {
  const num = (id, d) => { const v = parseFloat(m.querySelector(id).value); return Number.isFinite(v) ? Math.max(0, v) : d; };
  Object.assign(RISK, { optimistic_pct: Math.min(90, num('#rkLo', 10)), pessimistic_pct: num('#rkHi', 30), weather_pct: num('#rkWx', 20), correlation_pct: Math.min(100, num('#rkCor', 30)), iterations: +m.querySelector('#rkN').value });
  const btn = m.querySelector('#rkRun'), bar = m.querySelector('#rkProg'), txt = m.querySelector('#rkProgT');
  let r; try { r = window.PlannerEngine.riskRunner(S.project, { ...RISK, seed: 1 }); } catch (e) { toast(e.message); return; }
  const token = {}; m._risk = token; btn.disabled = true; bar.hidden = false;
  const t0 = performance.now();
  while (r.step(10) < r.total) {
    bar.firstChild.style.width = (r.step(0) / r.total * 100) + '%'; txt.textContent = `${r.step(0)} of ${r.total} runs`;
    await new Promise(res => setTimeout(res, 0));
    if (m._risk !== token || $('#modalBack').hidden) return;                 // closed or restarted
  }
  const res = r.result(); S.risk = { pid: S.pid, stamp: S.project.scheduled_at, r: res };
  btn.disabled = false; bar.hidden = true; txt.textContent = `${res.iterations} runs in ${((performance.now() - t0) / 1000).toFixed(1)}s`;
  paintRisk(m, res);
}
function paintRisk(m, r) {
  const out = m.querySelector('#rkOut'); if (!out) return;
  const cal = dayCal(), wd = (a, b) => workingDaysBetween(cal, new Date(a), new Date(b));
  const pct = v => v == null ? '–' : (v < 1 && v > 0 ? '<1' : v > 99 && v < 100 ? '>99' : Math.round(v)) + '%';
  const gap = wd(r.deterministic_finish, r.p80);
  const lead = `The planned finish of <b>${fmtD(r.deterministic_finish)}</b> is met in <b>${pct(r.deterministic_probability)}</b> of runs. For 80% confidence, plan on <b>${fmtD(r.p80)}</b>${gap > 0 ? `, ${gap} working days later` : ''}.` +
    (r.deadline ? ` The ${fmtD(r.deadline)} deadline is met in <b>${pct(r.deadline_probability)}</b> of runs.` : ' No deadline is set, so there is no chance-of-deadline figure.');
  const dlTone = r.deadline_probability == null ? '' : r.deadline_probability >= 80 ? 'ok' : r.deadline_probability >= 50 ? 'warn' : 'bad';
  out.innerHTML = `
    <p class="rk-lead">${lead}</p>
    <div class="kpis rk-kpis">
      <div class="kpi"><div class="k">P50</div><div class="big">${fmtD(r.p50)}</div><div class="note">Half the runs finish by</div></div>
      <div class="kpi"><div class="k">P80</div><div class="big">${fmtD(r.p80)}</div><div class="note">The usual date to commit to</div></div>
      <div class="kpi"><div class="k">P90</div><div class="big">${fmtD(r.p90)}</div><div class="note">Range ${fmtD(r.earliest)} to ${fmtD(r.latest)}</div></div>
      <div class="kpi"><div class="k">Deadline</div><div class="big ${dlTone}">${r.deadline ? pct(r.deadline_probability) : '–'}</div><div class="note">${r.deadline ? 'Chance of ' + fmtD(r.deadline) : 'No deadline set'}</div></div>
    </div>
    <h3>When it finishes</h3>
    <div class="rk-chart" id="rkChart" role="img" aria-label="Distribution of finish dates by week, with planned finish, P80 and deadline marked"></div>
    <h3>Where the risk sits</h3>
    ${(() => {
      const always = r.criticality.filter(c => c.pct >= 100), some = r.criticality.filter(c => c.pct < 100).slice(0, 10);
      const row = c => { const a = byId(c.id); return `<button type="button" class="crow" data-goto="${esc(c.id)}"><span class="cid">${esc(c.id)}</span><span class="cname">${esc(c.name)}${a && !a.critical ? ' <span class="chip plain">not critical now</span>' : ''}</span><span class="cbar"><i style="width:${c.pct}%"></i></span><b>${pct(c.pct)}</b></button>`; };
      return `<p class="hint" style="margin:0 0 8px">${always.length ? `<b>${always.length}</b> activities are critical in every run: that is the backbone, and any delay there moves the finish.` : 'No activity is critical in every run.'} ${some.length ? 'These are critical in some runs. The ones not critical today are hidden risks: they can take over the path.' : 'Nothing else ever becomes critical, so the path is stable.'}</p>` +
        (some.length ? `<div class="crit-list">${some.map(row).join('')}</div>` : '') +
        (always.length ? `<details class="rk-always"><summary>Critical in every run (${always.length})</summary><div class="crit-list">${always.map(row).join('')}</div></details>` : '') ||
        '<p class="hint">Nothing left to vary: every activity is complete.</p>';
    })()}
    <p class="hint rk-foot">Durations drawn from a triangular range, ${r.settings.optimistic_pct}% quicker to ${r.settings.pessimistic_pct}% slower; ${r.weather_exposed} of ${r.uncertain_activities} unfinished activities treated as weather-exposed (+${r.settings.weather_pct}%). Activities share ${r.settings.correlation_pct}% of their variation, since delays tend to hit many trades at once. Resource levelling is not re-run. The same settings always give the same answer.</p>`;
  out.querySelectorAll('[data-goto]').forEach(b => b.onclick = () => { modalClose(); setTimeout(() => goToActivity(b.dataset.goto), 250); });
  drawRiskChart(out.querySelector('#rkChart'), r);
}
function drawRiskChart(el, r) {
  const W = Math.max(280, el.clientWidth || 640), pl = 40, pr = 16, pb = 26, WK = 7 * DAY;
  const day = s => { const d = new Date(s); d.setHours(0, 0, 0, 0); return +d; };
  const weeks = r.histogram.map(h => ({ t: +new Date(h.week + 'T00:00:00'), c: h.count }));
  const marks = [['Planned', r.deterministic_finish, 'var(--ink-2)', ''], ['P80', r.p80, 'var(--accent)', ''], r.deadline && ['Deadline', r.deadline, 'var(--crit)', '4 3']].filter(Boolean);
  const placedRows = [];
  const t0 = Math.min(weeks[0].t, ...marks.map(k => day(k[1]))) - WK, t1 = Math.max(weeks[weeks.length - 1].t + WK, ...marks.map(k => day(k[1]))) + WK;
  const xr = t => pl + (t - t0) / (t1 - t0) * (W - pl - pr);
  // marker labels go in rows above the plot, so close dates (P80 next to a deadline) never collide
  const placed = marks.map(k => [...k, xr(day(k[1]) + DAY / 2)]).sort((a, b) => a[4] - b[4]).map(k => {
    const w = (k[0].length + 10) * 6.6; let row = 0;
    while (placedRows.some(p => p.row === row && Math.abs(p.x - k[4]) < (p.w + w) / 2 + 8)) row++;
    const p = { row, x: k[4], w }; placedRows.push(p); return [...k, row];
  });
  const rows = Math.max(...placed.map(k => k[5])) + 1, pt = 14 + rows * 16, H = 170 + rows * 16;
  const x = xr, maxC = Math.max(...weeks.map(w => w.c)), y = c => H - pb - c / maxC * (H - pt - pb);
  let s = '';
  [0, .5, 1].forEach(f => { const yy = y(maxC * f); s += `<line x1="${pl}" x2="${W - pr}" y1="${yy}" y2="${yy}" stroke="var(--line-2)"/><text x="${pl - 6}" y="${yy + 4}" text-anchor="end" class="ax">${Math.round(maxC * f / r.iterations * 100)}%</text>`; });
  for (let d = new Date(t0); +d < t1; d.setDate(d.getDate() + 1)) if (d.getDate() === 1) s += `<text x="${x(+d)}" y="${H - 8}" class="ax" text-anchor="middle">${d.toLocaleDateString('en-GB', { month: 'short' })}${d.getMonth() === 0 ? ' ' + String(d.getFullYear()).slice(2) : ''}</text>`;
  let cum = 0;
  weeks.forEach((w, i) => {
    cum += w.c; const bx = x(w.t) + 1, bw = Math.max(2, x(w.t + WK) - x(w.t) - 2), top = y(w.c), r0 = Math.min(3, bw / 2);
    s += `<path d="M${bx},${H - pb} V${top + r0} q0,${-r0} ${r0},${-r0} H${bx + bw - r0} q${r0},0 ${r0},${r0} V${H - pb} Z" fill="var(--bar)"/>`;
    s += `<rect class="rk-hit" data-i="${i}" data-cum="${cum}" x="${x(w.t)}" y="${pt - 10}" width="${x(w.t + WK) - x(w.t)}" height="${H - pb - pt + 10}" fill="transparent"/>`;
  });
  s += `<line x1="${pl}" x2="${W - pr}" y1="${H - pb}" y2="${H - pb}" stroke="var(--line)"/>`;
  placed.forEach(([lab, d, col, dash, mx, row]) => {
    const ly = 12 + row * 16, anchor = mx > W - 80 ? 'end' : mx < pl + 40 ? 'start' : 'middle';
    s += `<line x1="${mx}" x2="${mx}" y1="${ly + 4}" y2="${H - pb}" stroke="${col}" stroke-width="2" ${dash ? `stroke-dasharray="${dash}"` : ''}/><text x="${mx}" y="${ly}" text-anchor="${anchor}" class="mk" fill="${col}">${lab} ${fmtD(d)}</text>`;
  });
  el.innerHTML = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${s}</svg>`;
  el.querySelectorAll('.rk-hit').forEach(h => {
    h.onpointermove = e => { const w = weeks[+h.dataset.i]; tipText(e, `<b>Week of ${new Date(w.t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}</b><br>${w.c} runs finish this week (${Math.round(w.c / r.iterations * 100)}%)<br>${Math.round(+h.dataset.cum / r.iterations * 100)}% finished by its end`); h.setAttribute('fill', 'var(--accent-soft)'); };
    h.onpointerleave = () => { hideTip(); h.setAttribute('fill', 'transparent'); };
  });
}

// ---------- share and export ----------
function summaryText() {
  try { const b = getBriefing(); if (b && b.prose && window.PlannerEngine && window.PlannerEngine.briefing) return `${S.project.name} (${S.project.id})\n${b.headline}\n\n${b.prose}`; } catch { }
  const p = S.project, r = S.report; const [, label] = statusOf(p, r); const pr = progressOf(p); const spare = spareDays(p);
  const crit = p.activities.filter(a => a.critical && a.status !== 'complete' && a.early_start).sort((a, b) => a.early_start.localeCompare(b.early_start)).slice(0, 5);
  const failing = r ? r.checks.filter(c => c.applicable && !c.passed).map(c => c.title) : [];
  return [`${p.name} (${p.id})`, `Status: ${label}. Data date ${fmtLong(p.data_date || p.start)}.`, `Forecast finish ${fmtLong(p.finish)}` + (spare == null ? '.' : spare >= 0 ? `, ${spare} working days inside the ${fmtD(p.must_finish_by)} deadline.` : `, ${-spare} working days past the ${fmtD(p.must_finish_by)} deadline.`),
    `Progress ${Math.round(pr.pct)}% complete against ${Math.round(pr.planned)}% ${pr.baselined ? 'planned' : 'scheduled'} by the data date.`,
    crit.length ? 'Critical path next: ' + crit.map(a => `${a.name} (${fmtD(a.early_start)})`).join('; ') + '.' : 'No critical activities remaining.',
    r ? `Schedule health ${r.score}/100` + (failing.length ? `; failing: ${failing.join(', ')}.` : '; all DCMA checks pass.') : ''].filter(Boolean).join('\n');
}
function shareSheet() {
  if (!S.project) return;
  const file = '<path d="M7 3h7l5 5v13H7z"/><path d="M14 3v5h5"/>';
  const tiles = [['bundle', 'All three formats', 'One .zip for P6, Asta and MS Project', '<path d="M5 9h18v14H5z"/><path d="M5 9l3-5h12l3 5M12 13h4"/>'], ['xer', 'Primavera P6', '.xer file. Asta imports it too', file], ['xml', 'MS Project and Asta', 'MS Project XML (MSPDI)', file], ['json', 'Planner file', '.json to open here again', file], ['csv', 'Excel', '.csv of the activities as shown', '<path d="M5 4h18v20H5z"/><path d="M5 10h18M5 16h18M11 4v20"/>'], ['pdf', 'PDF for issue', 'Print-ready, with a title block', '<path d="M7 3h10l5 5v17H7z"/><path d="M10 14h8M10 18h8M10 10h4"/>']];
  const { m } = modal('Share and export', `<p class="hint" style="margin-top:-4px">Send the programme to the tools your client and contractors use.</p><div class="exports">${tiles.map(([f, t, s, ic], i) => `<button type="button" class="tile ${i === 0 ? 'on' : ''}" data-x="${f}"><svg viewBox="0 0 28 28" aria-hidden="true">${ic}</svg><b>${t}</b><span>${s}</span></button>`).join('')}</div>
    <h3>Status note</h3><p class="hint" style="margin:0 0 8px">A short update to paste into an email or message.</p><textarea id="shareText" rows="7" style="width:100%" readonly>${esc(summaryText())}</textarea>
    <div class="bar-row" style="margin-top:10px"><button type="button" class="btn" id="shareCopy">Copy status note</button></div>`, null, '', { wide: true });
  m.querySelectorAll('[data-x]').forEach(b => b.onclick = () => { const x = b.dataset.x; if (x === 'csv') return exportCsv(); if (x === 'pdf') return printSheet(); if (['xer', 'xml', 'bundle'].includes(x) && window.PlannerEngine && window.PlannerEngine.fidelityReport) return exportCheck(x); exportAs(x); });
  m.querySelector('#shareCopy').onclick = async () => { const ta = m.querySelector('#shareText'); try { await navigator.clipboard.writeText(ta.value); toast('Status note copied'); } catch { ta.focus(); ta.select(); toast('Selected. Press Ctrl+C or ⌘C to copy.'); } };

}
// before a P6 / MS Project / Asta file leaves: show what the other tool will actually receive
function exportCheck(fmt) {
  const E = window.PlannerEngine; let reps;
  try { reps = (fmt === 'bundle' ? ['xer', 'xml'] : [fmt]).map(f => E.fidelityReport(S.project, f)); }
  catch (e) { return exportAs(fmt); }                  // never block an export on the check itself
  const ok = reps.every(r => r.ok);
  const sec = r => `<h3>${esc(r.tool)}</h3><ul class="fid">${r.items.map(i => `<li class="${i.ok ? 'ok' : 'warn'}"><span class="fi" aria-hidden="true">${i.ok ? '✓' : '!'}</span><div><b>${esc(i.text)}</b>${i.detail ? `<div class="hint">${esc(i.detail)}</div>` : ''}</div></li>`).join('')}</ul>`;
  modal('What the other tool will receive', `<p class="hint" style="margin-top:-4px">${ok ? 'Everything survives the round trip.' : 'Checked by writing the file and reading it back. Items marked ! will not arrive as they are here.'}</p>${reps.map(sec).join('')}<label class="sw" style="margin-top:6px"><span>Record this as issued revision <b>${esc(nextRev(S.project))}</b>, so later versions can be compared with it</span><input type="checkbox" id="xRev" checked><i></i></label>`,
    async m => { const issue = m.querySelector('#xRev').checked; await exportAs(fmt); if (issue) await act('/revision', { name: nextRev(S.project), note: 'Issued as ' + (fmt === 'bundle' ? 'XER, MS Project XML and JSON' : fmt.toUpperCase()) }); }, fmt === 'bundle' ? 'Download all three' : 'Download', { wide: true });
}
function importSummary(p, r) {
  const n = (x, w) => `<li><b>${x}</b> ${w}</li>`, exc = Object.values(p.calendars).reduce((t, c) => t + Object.keys(c.exceptions || {}).length, 0);
  const prog = p.activities.filter(a => a.status !== 'not_started').length, cons = p.activities.filter(a => a.constraint && a.constraint !== 'none').length;
  const failing = r ? r.checks.filter(c => c.applicable && !c.passed).map(c => c.title) : [];
  modal('Imported', `<p class="hint" style="margin-top:-4px">${esc(p.name)}. Recalculated here from the file's logic and calendars.</p><ul class="fid counts">${[n(p.activities.length, 'activities'), n(p.relationships.length, 'links'), n(p.wbs.length, 'WBS summaries'), n(Object.keys(p.calendars).length, `calendars, ${exc} holidays and exceptions`), n((p.resources || []).length, `resources, ${(p.assignments || []).length} assignments`), n(Object.keys(p.code_types || {}).length, 'activity code types'), n(p.activities.filter(a => a.baseline_finish).length, 'activities with baseline dates'), n(prog, 'activities with progress'), n(cons, 'constraints')].join('')}</ul>
    <p>Data date <b>${fmtD(p.data_date || p.start)}</b> · finish <b>${fmtD(p.finish)}</b>${p.must_finish_by ? ` · deadline <b>${fmtD(p.must_finish_by)}</b>` : ''} · health <b>${r ? r.score : '–'}</b></p>${failing.length ? `<p class="hint">Failing checks: ${esc(failing.join(', '))}. Open Monitor for details, or Auto-repair from More.</p>` : ''}`, null, '', { wide: false });
}
function projectsPop(trigger) {
  const pop = $('#popProjects');
  pop.innerHTML = `<div class="pop-sec">Projects</div>${(S.list || []).map(p => `<button type="button" data-pid="${esc(p.id)}" class="${p.id === S.pid ? 'on' : ''}" role="menuitem">${esc(p.name)}</button>`).join('')}<div class="pop-sec"></div><button type="button" id="ppAll" role="menuitem">All projects</button><button type="button" id="ppNew" role="menuitem">New programme</button>`;
  pop.querySelectorAll('[data-pid]').forEach(b => b.onclick = () => { closePop(pop); openProject(b.dataset.pid, S.screen === 'projects' ? 'plan' : S.screen); });
  pop.querySelector('#ppAll').onclick = () => { closePop(pop); go('projects'); };
  pop.querySelector('#ppNew').onclick = () => { closePop(pop); startFlow(); };
  pop.insertAdjacentHTML('beforeend', `<div class="pop-sec">View as</div><div style="padding:4px 8px 6px">${modeSeg('ppMode')}</div>`); wireModeSeg(pop);
  openPop(pop, trigger);
}

// ---------- analysis bands under the Gantt ----------
function setPanel(name) {
  if (name === 'health' || name === 'notes') { go('monitor'); return; }
  S.panel = S.panel === name ? null : name; if (S.screen !== 'plan') go('plan'); else render(); refreshPanel();
}
async function refreshPanel() {
  if (!S.pid) return;
  try {
    if (S.panel === 'histogram') { S.hist = await api(pidPath('/histogram')); renderBand(); }
    if (S.panel === 'cost') { S.costs = await api(pidPath('/costs')); renderBand(); }
  } catch (e) { toast(e.message); }
}
function renderPanelBody() { /* health checks and notes live on the Monitor screen */ }
// ============================================================================
// The reimagined shell: Overview, Build/Site/Client modes, Try mode, Ask, hover cards.
// The engine and every earlier feature are unchanged underneath; this layer decides what the
// person sees first, what the programme says about itself, and how safely changes can be tried.
// ============================================================================

// ---------- modes: Build (planner), Site (phone, progress first), Client (read-only) ----------
const MODES = [['build', 'Build', 'All the planning tools'], ['site', 'Site', 'Progress first; made for a phone'], ['client', 'Client', 'Read-only: the briefing, milestones and the chart']];
function setMode(m, quiet) {
  if (!MODES.some(x => x[0] === m)) m = 'build';
  const was = S.mode; S.mode = m; document.body.dataset.mode = m; try { localStorage.setItem('mode', m); } catch { }
  if (m === 'client') { if (S.editing) cancelEdit(); if (S.inspector) toggleInspector(false); }
  paintChrome();
  if (S.project) { if (S.screen === 'overview') renderOverview(); else if (S.screen === 'plan') render(); else if (S.screen === 'monitor') renderMonitor(); }
  if (!quiet && was !== m) toast(m === 'client' ? 'Client view: read-only. Switch back to Build to change anything.' : m === 'site' ? 'Site view: progress first, sized for a phone.' : 'Build view: every tool.', { ms: 3200 });
}
const readOnly = () => S.mode === 'client';
function roBlocked() { toast('Client view is read-only. Switch to Build to change the programme.', { ms: 4000, action: { label: 'Build view', fn: () => setMode('build') } }); return true; }
function modeSeg(id) { return `<div class="miniseg modeseg" id="${id}" role="group" aria-label="View as">${MODES.map(([k, l, d]) => `<button type="button" data-mode="${k}" class="${S.mode === k ? 'on' : ''}" title="${esc(d)}" aria-pressed="${S.mode === k}">${l}</button>`).join('')}</div>`; }
function wireModeSeg(root) { root.querySelectorAll('.modeseg [data-mode]').forEach(b => b.onclick = () => setMode(b.dataset.mode)); }

// ---------- Try mode: a sandbox you can keep or throw away ----------
// Changes save as normal (so undo, the assistant and every tool work), but the programme as it
// was when Try started is kept aside. The bar shows the finish delta live; Discard puts it back.
function tryStart() {
  if (!S.project || S.sandbox) return; if (readOnly()) return roBlocked();
  S.sandbox = { pid: S.pid, base: cloneProject(), baseFinish: S.project.finish, started: Date.now() };
  paintTry(); if (S.screen !== 'plan') go('plan');
  toast('Try mode. Change anything: the finish delta shows live. Keep or Discard when you are done.', { ms: 5200 });
}
function tryDelta() {
  const sb = S.sandbox, p = S.project; if (!sb) return null;
  const cal = p.calendars[p.default_calendar_id] || { working_days: [0, 1, 2, 3, 4], exceptions: {} };
  const shift = sb.baseFinish && p.finish ? workingDaysBetween(cal, new Date(sb.baseFinish), new Date(p.finish)) : null;
  const old = new Map(sb.base.activities.map(a => [a.id, a])); let changed = 0, added = 0;
  p.activities.forEach(a => { const o = old.get(a.id); if (!o) { added++; return; } if (o.duration_hours !== a.duration_hours || (o.early_start || '') !== (a.early_start || '') || (o.early_finish || '') !== (a.early_finish || '') || o.status !== a.status || (o.constraint || 'none') !== (a.constraint || 'none') || o.name !== a.name) changed++; });
  const removed = sb.base.activities.filter(a => !byId(a.id)).length;
  const links = p.relationships.length - sb.base.relationships.length;
  return { shift, changed, added, removed, links, any: !!(changed || added || removed || links) };
}
function paintTry() {
  const bar = $('#tryBar'); if (!bar) return;
  const sb = S.sandbox; if (!sb || !S.project || sb.pid !== S.pid) { bar.hidden = true; document.body.classList.remove('trying'); const tb = $('#btnTry'); if (tb) tb.classList.remove('on'); return; }
  const d = tryDelta(), p = S.project; const late = p.must_finish_by && p.finish && p.finish > p.must_finish_by;
  const shiftTxt = d.shift == null ? '' : d.shift === 0 ? 'finish unchanged' : `finish ${fmtD(p.finish)} <b class="${d.shift > 0 ? 'crit' : 'okc'}">${d.shift > 0 ? '+' : ''}${fmt1(d.shift)}d</b>`;
  const parts = [d.changed && `${d.changed} moved`, d.added && `${d.added} added`, d.removed && `${d.removed} removed`, d.links && `${d.links > 0 ? '+' : ''}${d.links} link${Math.abs(d.links) === 1 ? '' : 's'}`].filter(Boolean);
  bar.innerHTML = `<span class="try-dot" aria-hidden="true"></span><b>Trying changes</b><span class="try-d">${shiftTxt}${parts.length ? ' · ' + parts.join(', ') : ' · nothing changed yet'}${late ? ' · <span class="crit">past the deadline</span>' : ''}</span><span class="spacer"></span><button type="button" class="btn" id="tryCmp" ${d.any ? '' : 'disabled'}>What changed</button><button type="button" class="btn" id="tryDrop">Discard</button><button type="button" class="primary" id="tryKeep">Keep</button>`;
  bar.hidden = false; document.body.classList.add('trying'); const tb = $('#btnTry'); if (tb) tb.classList.add('on');
  bar.querySelector('#tryCmp').onclick = () => { const E = window.PlannerEngine; if (E && E.compareProjects) compareSheet(E.compareProjects(sb.base, S.project)); };
  bar.querySelector('#tryDrop').onclick = tryDiscard; bar.querySelector('#tryKeep').onclick = tryKeep;
}
async function tryDiscard() {
  const sb = S.sandbox; if (!sb) return; const d = tryDelta(); S.sandbox = null; paintTry();
  if (d.any) { S.project = sb.base; await save('Discarded. The programme is as it was before Try mode.'); } else toast('Nothing was changed. Try mode closed.');
}
async function tryKeep() {
  const sb = S.sandbox; if (!sb) return; const d = tryDelta(); S.sandbox = null; paintTry();
  if (!d.any) return toast('Nothing was changed. Try mode closed.');
  toast(`Kept. ${d.shift == null ? '' : d.shift === 0 ? 'The finish is unchanged.' : `The finish moved ${Math.abs(fmt1(d.shift))} day${Math.abs(d.shift) === 1 ? '' : 's'} ${d.shift > 0 ? 'later' : 'earlier'}.`}`, { ms: 5200, action: { label: 'Issue as revision', fn: revisionDialog } });
}

// ---------- hover card: what a bar is, why it is there, what it holds up ----------
function tipFor(e, a) {
  if (!a || S.drag) return; const p = S.project;
  const st = a.actual_start || a.early_start, fi = a.actual_finish || a.early_finish;
  const tf = a.total_float_hours == null ? null : daysOf(a, a.total_float_hours);
  const why = whyChain(a)[0]; const succ = p.relationships.filter(r => r.predecessor_id === a.id).length;
  const status = a.status === 'complete' ? 'complete' : a.status === 'in_progress' ? `${Math.round(a.percent_complete)}% done` : 'not started';
  const bl = a.baseline_finish && fi ? workingDaysBetween(calOf(a), new Date(a.baseline_finish), new Date(fi)) : null;
  tipText(e, `<div class="hc"><b>${esc(a.id)} ${esc(a.name)}</b><div class="hc-row">${fmtD(st)} → ${fmtD(fi)} · ${a.type === 'task' ? fmt1(daysOf(a, a.duration_hours)) + 'd' : 'milestone'} · ${status}</div>
    <div class="hc-row">${a.critical ? '<span class="chip bad">Critical</span>' : tf != null ? `<span class="chip ${tf < 0 ? 'bad' : tf <= 5 ? 'warn' : 'plain'}">${fmt1(tf)}d float</span>` : ''}${bl != null && bl !== 0 ? ` <span class="chip ${bl > 0 ? 'bad' : 'ok'}">${bl > 0 ? '+' : ''}${bl}d vs baseline</span>` : ''}${a.constraint && a.constraint !== 'none' ? ` <span class="chip warn">${esc(a.constraint.replaceAll('_', ' '))}</span>` : ''}</div>
    ${why ? `<div class="hc-why">${esc(a.id)} ${esc(why.text)}.</div>` : ''}${succ ? `<div class="hc-why">Holds up ${succ} activit${succ === 1 ? 'y' : 'ies'}${a.critical && a.status !== 'complete' ? ', and the finish' : ''}.</div>` : ''}
    <div class="hc-k">Double-click to open · right-click for more</div></div>`);
}

// ---------- Ask: plain-English questions answered from the engine, with the chart as the answer ----------
const QWORDS = /^(when|what|why|how|who|which|where|is|are|will|does|do|can|should|has|have|did|list|show me|tell me|any|anything)\b|\?\s*$/i;
const looksLikeQuestion = t => QWORDS.test(String(t || '').trim());
function askEngine(q) {
  const E = window.PlannerEngine; if (!E || !E.ask || !S.project) return null;
  try { return E.ask(S.project, q); } catch (e) { return { kind: 'error', answer: 'Could not answer that: ' + (e && e.message ? e.message : e), ids: [], filter: '', trace: null, goto: null, confidence: 'low', suggestions: [] }; }
}
function highlightIds(ids, label) {
  if (!ids || !ids.length) return; S.trace = { ids, dir: 'ask', set: new Set(ids), label: label || 'Answer' }; S.view.show = 'trace';
  if (S.screen !== 'plan') go('plan'); else render();
}
function answerHtml(r, q) {
  const acts = (r.ids || []).map(byId).filter(Boolean), btns = [];
  if (acts.length) btns.push(`<button type="button" class="btn" data-ask="show">Show ${acts.length === 1 ? 'it' : 'these ' + acts.length} on the chart</button>`);
  if (r.trace && r.trace.ids && r.trace.ids.length) btns.push('<button type="button" class="btn" data-ask="trace">Trace the logic</button>');
  if (r.filter) btns.push(`<button type="button" class="btn" data-ask="filter">${r.filter.startsWith('quick:') ? 'Show: ' + esc((QUICK.find(q => q[0] === r.filter.slice(6)) || ['', r.filter.slice(6)])[1]) : 'Filter: ' + esc(r.filter)}</button>`);
  if (r.goto && byId(r.goto)) btns.push(`<button type="button" class="btn" data-ask="goto">Open ${esc(r.goto)}</button>`);
  if (r.kind === 'what_if' && !readOnly()) btns.push('<button type="button" class="btn" data-ask="try">Try it</button>');
  return `<div class="ans ${esc(r.confidence || '')}"><div class="ans-t">${esc(r.answer)}</div>${acts.length ? `<div class="ans-ids">${acts.slice(0, 8).map(a => `<button type="button" class="linkchip" data-goto="${esc(a.id)}" title="${esc(a.name)}">${esc(a.id)}</button>`).join('')}${acts.length > 8 ? `<span class="hint">+${acts.length - 8} more</span>` : ''}</div>` : ''}${btns.length ? `<div class="ans-b">${btns.join('')}</div>` : ''}${(r.suggestions || []).length ? `<div class="ans-s">${r.suggestions.slice(0, 3).map(s => `<button type="button" class="chipbtn" data-ask-q="${esc(s)}">${esc(s)}</button>`).join('')}</div>` : ''}</div>`;
}
function wireAnswer(el, r, q, onAsk) {
  const leave = () => { closePalette(); modalClose(); };
  el.querySelectorAll('[data-goto]').forEach(b => b.onclick = () => { leave(); goToActivity(b.dataset.goto); });
  el.querySelectorAll('[data-ask]').forEach(b => b.onclick = () => { const k = b.dataset.ask; leave();
    if (k === 'show') highlightIds(r.ids, q); else if (k === 'trace') setTrace(r.trace.ids, r.trace.dir || 'back', q);
    else if (k === 'filter') { if (r.filter.startsWith('quick:')) { S.view.show = r.filter.slice(6); S.view.filter = ''; } else { S.view.filter = r.filter; S.view.show = 'all'; } if (S.screen !== 'plan') go('plan'); else render(); }
    else if (k === 'goto') goToActivity(r.goto); else if (k === 'try') { tryStart(); openPalette(); $('#cmdIn').value = r.ids && r.ids[0] ? `add 1 week to ${r.ids[0]}` : ''; paintPalette(); } });
  el.querySelectorAll('[data-ask-q]').forEach(b => b.onclick = () => onAsk(b.dataset.askQ));
}
let askTimer = null;
function askInPalette(t) {
  const out = $('#cmdOut'); if (!S.project) return;
  const r = askEngine(t); if (!r) { out.innerHTML = '<span class="hint">Questions need the scheduling engine on this page.</span>'; return; }
  out.innerHTML = answerHtml(r, t); wireAnswer(out, r, t, q => { $('#cmdIn').value = q; palSel = 0; paintPalette(); askInPalette(q); });
}
function askExamples(n = 6) {
  const E = window.PlannerEngine; const ex = (E && E.ASK_EXAMPLES) || ['When do we finish?', 'What is driving the finish?', 'What is happening next week?', 'Why does the roof start when it does?', 'What should we accelerate?', 'What changed since the baseline?'];
  return ex.slice(0, n);
}

// ---------- Overview: the programme reports its own state ----------
const STAGE_HELP = { brief: 'The job described and laid out.', build: 'Logic complete and the health checks passing.', baseline: 'Dates frozen so slippage shows.', update: 'Progress recorded and periods closed.', issue: 'A revision issued as a PDF or file.' };
function stageState(p, r) {
  const linked = new Set(); p.relationships.forEach(x => { linked.add(x.predecessor_id); linked.add(x.successor_id); });
  const openEnds = p.activities.filter(a => a.type !== 'level_of_effort' && !linked.has(a.id)).length;
  const started = p.activities.some(a => a.status !== 'not_started');
  const lastRev = (p.revisions || []).slice(-1)[0], lastPer = periodsOf(p).slice(-1)[0], lastBl = p.baselines.slice(-1)[0];
  return [
    { k: 'brief', t: 'Brief', done: true, s: `${p.activities.length} activities, ${p.relationships.length} links`, action: ['Open the plan', () => go('plan')] },
    { k: 'build', t: 'Build', done: openEnds <= 2 && !!r && r.score >= 70, s: r ? `health ${r.score}/100${openEnds > 2 ? `, ${openEnds} unlinked` : ''}` : 'not checked yet', action: r && r.score < 70 ? ['Fix the checks', () => act('/repair')] : ['Health checks', () => go('monitor')] },
    { k: 'baseline', t: 'Baseline', done: !!lastBl, s: lastBl ? `${lastBl.name}, ${fmtD(lastBl.saved_at)}` : 'none yet', action: lastBl ? ['Compare', () => compareSheet()] : ['Set baseline', () => $('#btnBaseline').click()] },
    { k: 'update', t: 'Update', done: started, s: lastPer ? `${lastPer.name}, ${fmtD(lastPer.data_date)}` : started ? 'progress recorded, no period closed' : 'nothing started', action: ['Site update', siteUpdateSheet] },
    { k: 'issue', t: 'Issue', done: !!lastRev, s: lastRev ? `${lastRev.name}, ${fmtD(lastRev.issued_at)}` : 'not issued yet', action: ['PDF for issue', printSheet] },
  ];
}
// A plain briefing from what the page already knows, used when the briefing engine is not loaded.
function fallbackBriefing(p, r) {
  const [, label] = statusOf(p, r); const spare = spareDays(p); const pr = progressOf(p); const today = (p.data_date || p.start || '').slice(0, 10);
  const open = p.activities.filter(a => a.status !== 'complete' && a.type !== 'level_of_effort');
  const headline = `${label}: forecast finish ${fmtD(p.finish)}` + (spare == null ? '.' : spare >= 0 ? `, ${spare} working days inside the ${fmtD(p.must_finish_by)} deadline.` : `, ${-spare} working days past the ${fmtD(p.must_finish_by)} deadline.`);
  const dd = new Date(p.data_date || p.start), to = new Date(+dd + 14 * DAY);
  const inWin = a => { const st = a.actual_start || a.early_start, fi = a.actual_finish || a.early_finish; return st && fi && new Date(st) <= to && new Date(fi) >= dd; };
  const watch = [];
  open.filter(a => a.total_float_hours != null && a.total_float_hours < -1e-6).slice(0, 4).forEach(a => watch.push({ id: a.id, name: a.name, reason: 'negative_float', severity: 3, text: `${fmt1(-daysOf(a, a.total_float_hours))} days of negative float: it is already past where it needs to be.` }));
  open.filter(a => a.critical && a.status === 'not_started' && a.early_start && new Date(a.early_start) <= to).slice(0, 4).forEach(a => watch.push({ id: a.id, name: a.name, reason: 'critical_soon', severity: 3, text: `Critical and due to start ${fmtD(a.early_start)}: any delay moves the finish.` }));
  oosList().slice(0, 3).forEach(o => { if (!watch.some(w => w.id === o.successor)) watch.push({ id: o.successor, name: o.successor_name, reason: 'out_of_sequence', severity: 2, text: `Started before ${o.predecessor} finished: the logic no longer matches site.` }); });
  const ms = p.activities.filter(a => a.type !== 'task').map(a => ({ id: a.id, name: a.name, date: (a.actual_finish || a.early_finish || a.early_start || '').slice(0, 10), baseline_date: a.baseline_finish ? a.baseline_finish.slice(0, 10) : null, variance_days: null, status: a.status }));
  const actions = [];
  if (!p.baselines.length && pr.pct < 1) actions.push({ kind: 'set_baseline', text: 'Set a baseline before work starts, so slippage shows bar by bar.' });
  if (pr.pct > 0 && !periodsOf(p).length) actions.push({ kind: 'close_period', text: 'Close the first progress period to keep a record of where things stand.' });
  if (r && r.score < 70) actions.push({ kind: 'repair', text: `Health is ${r.score}/100: run Auto-repair and review what it leaves open.` });
  if (!p.must_finish_by) actions.push({ kind: 'add_deadline', text: 'Add the contract completion date so the spare time shows.' });
  return { as_of: today, headline, status: label.toLowerCase().replace(' ', '_'), kpis: { finish: p.finish, deadline: p.must_finish_by || null, spare_days: spare, pct_complete: pr.pct, pct_expected: pr.planned, critical_open: open.filter(a => a.critical).length, health_score: r ? r.score : null, activities_open: open.length, weeks_remaining: p.finish ? Math.max(0, Math.round((new Date(p.finish) - dd) / (7 * DAY) * 10) / 10) : 0 },
    since: { kind: 'none', name: null, date: null, finish_shift_days: null, summary: 'No baseline, revision or closed period to compare with yet.', items: [] },
    watch: watch.sort((a, b) => b.severity - a.severity).slice(0, 8),
    next: { from: today, to: iso(to).slice(0, 10), starting: open.filter(a => a.type === 'task' && a.status === 'not_started' && inWin(a)).slice(0, 10).map(a => ({ id: a.id, name: a.name, date: a.early_start.slice(0, 10) })), finishing: open.filter(a => a.type === 'task' && inWin(a) && new Date(a.early_finish) <= to).slice(0, 10).map(a => ({ id: a.id, name: a.name, date: a.early_finish.slice(0, 10) })), milestones: ms.filter(m => m.status !== 'complete' && m.date >= today && m.date <= iso(to).slice(0, 10)).slice(0, 10) },
    actions, milestones: ms, prose: headline + ` ${Math.round(pr.pct)}% complete against ${Math.round(pr.planned)}% expected by ${fmtD(today)}.` };
}
function getBriefing() {
  const E = window.PlannerEngine;
  if (E && E.briefing) { try { return E.briefing(S.project); } catch (e) { console.warn('briefing', e); } }
  return fallbackBriefing(S.project, S.report);
}
const ACTION_FN = { update_progress: () => siteUpdateSheet(), set_baseline: () => $('#btnBaseline').click(), close_period: () => closePeriodDialog(), issue: () => printSheet(), repair: () => act('/repair'), review_logic: () => oosDialog(), accelerate: () => computeDrag(), run_risk: () => riskSheet(), add_deadline: () => { openPalette(); $('#cmdIn').value = 'finish by '; paintPalette(); } };
const ACTION_LABEL = { update_progress: 'Site update', set_baseline: 'Set baseline', close_period: 'Close period', issue: 'PDF for issue', repair: 'Auto-repair', review_logic: 'Review logic', accelerate: 'Where to accelerate', run_risk: 'Run risk analysis', add_deadline: 'Add deadline' };
const SEV_DOT = { 3: 'var(--crit)', 2: 'var(--warn)', 1: 'var(--ink-3)' };
function renderOverview() {
  const p = S.project, r = S.report, el = $('#scrOverview'); if (!p) return;
  const scroll = el.scrollTop; const mode = S.mode || 'build';
  const b = getBriefing(); const [cls, label] = statusOf(p, r); const k = b.kpis || {};
  const stages = stageState(p, r); const cur = stages.find(s => !s.done) || stages[stages.length - 1];
  const li = (x, extra) => `<div class="li click" data-goto="${esc(x.id)}" role="button" tabindex="0"><div style="min-width:0"><div class="t">${esc(x.name)}</div><div class="s"><span class="mono">${esc(x.id)}</span>${extra ? ' · ' + extra : ''}</div></div>${x.date ? `<span class="chip plain">${fmtD(x.date)}</span>` : ''}</div>`;
  const primary = mode === 'site' ? '<button type="button" class="primary" id="ovSite">Site update</button>' : mode === 'client' ? '<button type="button" class="primary" id="ovPdf">PDF for issue</button>' : '<button type="button" class="primary" id="ovPlan">Open the plan</button>';
  const spine = mode === 'build' ? `<ol class="spine" aria-label="Where the programme is">${stages.map(s => `<li class="${s.done ? 'done' : ''} ${s === cur ? 'cur' : ''}"><span class="sp-dot" aria-hidden="true">${s.done ? '✓' : ''}</span><div class="sp-b"><b>${s.t}</b><span class="sp-s">${esc(s.s)}</span>${s === cur || !s.done ? `<button type="button" class="chipbtn" data-stage="${s.k}">${esc(s.action[0])}</button>` : ''}</div><span class="sp-h hint">${STAGE_HELP[s.k]}</span></li>`).join('')}</ol>` : '';
  const kpis = `<div class="ov-kpis">
      <div class="kpi"><div class="k">Forecast finish</div><div class="big" ${k.spare_days != null && k.spare_days < 0 ? 'style="color:var(--crit)"' : ''}>${fmtD(k.finish || p.finish)}</div><div class="note">${k.deadline ? (k.spare_days >= 0 ? `${fmt1(k.spare_days)} working days inside the ${fmtD(k.deadline)} deadline` : `${fmt1(-k.spare_days)} working days past the ${fmtD(k.deadline)} deadline`) : 'No deadline set'}</div></div>
      <div class="kpi"><div class="k">Progress</div><div class="big">${Math.round(k.pct_complete || 0)}%</div><div class="meter"><b style="width:${Math.min(100, k.pct_complete || 0)}%"></b><i style="left:${Math.min(99.5, k.pct_expected || 0)}%"></i></div><div class="note">${Math.round(k.pct_expected || 0)}% expected by ${fmtD(b.as_of)}</div></div>
      <div class="kpi"><div class="k">Critical path</div><div class="big">${k.critical_open ?? 0}</div><div class="note">open activities with no spare time</div></div>
      ${mode === 'client' ? `<div class="kpi"><div class="k">Remaining</div><div class="big">${fmt1(k.weeks_remaining || 0)} wks</div><div class="note">${k.activities_open ?? 0} activities still to finish</div></div>` : `<div class="kpi"><div class="k">Health</div><div class="big" style="color:${k.health_score != null ? healthColour(k.health_score) : 'inherit'}">${k.health_score ?? '–'}</div><div class="note">${r ? (r.checks.filter(c => c.applicable && !c.passed).length ? r.checks.filter(c => c.applicable && !c.passed).length + ' checks failing' : 'all checks pass') : 'not checked'}</div></div>`}
    </div>`;
  const briefing = `<section class="panel ov-brief" aria-labelledby="hBrief"><div class="panel-head"><h2 id="hBrief">Briefing</h2><span style="display:flex;gap:6px;flex-wrap:wrap"><button type="button" class="btn" id="ovCopy">Copy</button><button type="button" class="btn" id="ovPolish" hidden>Polish with Claude</button></span></div>
      <p class="ov-head">${esc(b.headline)}</p>${b.since && b.since.kind !== 'none' ? `<p class="ov-since"><b>Since ${esc(b.since.name || b.since.kind)}${b.since.date ? ' (' + fmtD(b.since.date) + ')' : ''}:</b> ${esc(b.since.summary)}</p>${(b.since.items || []).length ? `<div class="ov-items">${b.since.items.slice(0, 5).map(it => `<div class="ov-item"><button type="button" class="linkchip" data-goto="${esc(it.id)}">${esc(it.id)}</button><span><b>${esc(it.name || '')}</b>${it.name ? ': ' : ''}${esc(it.text || '')}</span></div>`).join('')}</div>` : ''}` : `<p class="ov-since hint">${esc((b.since && b.since.summary) || '')}</p>`}
      <div id="ovProse" class="ov-prose">${esc(b.prose || '').split(/\n\n+/).map(x => `<p>${esc(x)}</p>`).join('')}</div></section>`;
  const watch = `<section class="panel" aria-labelledby="hWatch"><div class="panel-head"><h2 id="hWatch">Watch</h2><span class="hint">${(b.watch || []).length ? 'What could move the finish' : ''}</span></div>
      ${(b.watch || []).length ? `<div class="list">${b.watch.map(w => `<div class="li click" data-goto="${esc(w.id)}" role="button" tabindex="0"><div style="min-width:0"><div class="t"><span class="swatch" style="background:${SEV_DOT[w.severity] || SEV_DOT[1]}"></span>${esc(w.name)}</div><div class="s">${esc(w.text)}</div></div><span class="mono hint">${esc(w.id)}</span></div>`).join('')}</div>` : '<div class="empty"><b>Nothing to watch</b>No negative float, nothing critical starting soon, no progress out of sequence.</div>'}</section>`;
  const next = `<section class="panel" aria-labelledby="hNext"><div class="panel-head"><h2 id="hNext">Next two weeks</h2><span class="hint">${fmtD(b.next.from)} to ${fmtD(b.next.to)}</span></div>
      ${b.next.milestones.length ? `<h3 class="ov-h3">Milestones</h3><div class="list">${b.next.milestones.map(x => li(x)).join('')}</div>` : ''}
      ${b.next.starting.length ? `<h3 class="ov-h3">Starting</h3><div class="list">${b.next.starting.map(x => li(x)).join('')}</div>` : ''}
      ${b.next.finishing.length ? `<h3 class="ov-h3">Finishing</h3><div class="list">${b.next.finishing.map(x => li(x)).join('')}</div>` : ''}
      ${!b.next.milestones.length && !b.next.starting.length && !b.next.finishing.length ? '<div class="empty"><b>Quiet fortnight</b>Nothing starts or finishes in the next two weeks.</div>' : ''}</section>`;
  const ask = `<section class="panel ov-ask" aria-labelledby="hAsk"><div class="panel-head"><h2 id="hAsk">Ask the programme</h2><span class="hint">Answered from the schedule, not guessed</span></div>
      <form id="ovAskForm" class="ov-askrow"><input id="ovAskIn" placeholder="e.g. ${esc(askExamples(1)[0])}" aria-label="Question" autocomplete="off"><button type="submit" class="primary">Ask</button></form>
      <div class="ans-s" id="ovAskEx">${askExamples(5).map(q => `<button type="button" class="chipbtn" data-ask-q="${esc(q)}">${esc(q)}</button>`).join('')}</div><div id="ovAskOut"></div></section>`;
  const actions = (b.actions || []).length && mode !== 'client' ? `<section class="panel" aria-labelledby="hDo"><div class="panel-head"><h2 id="hDo">Do next</h2></div><div class="list">${b.actions.map(a => `<div class="li"><div class="s" style="font-size:13px;color:var(--ink)">${esc(a.text)}</div>${ACTION_FN[a.kind] ? `<button type="button" class="btn" data-act="${esc(a.kind)}">${ACTION_LABEL[a.kind] || a.kind}</button>` : ''}</div>`).join('')}</div></section>` : '';
  const msRows = (b.milestones || []).filter(m => m.date).sort((a, c) => a.date.localeCompare(c.date));
  const milestones = msRows.length ? `<section class="panel" aria-labelledby="hMs"><div class="panel-head"><h2 id="hMs">Milestones</h2></div><table class="ov-table"><thead><tr><th>Milestone</th><th>Date</th>${msRows.some(m => m.baseline_date) ? '<th>Baseline</th><th>Var</th>' : ''}</tr></thead><tbody>${msRows.map(m => `<tr class="${m.status === 'complete' ? 'done' : ''}" data-goto="${esc(m.id)}"><td>${esc(m.name)}${m.status === 'complete' ? ' <span class="chip ok">done</span>' : ''}</td><td>${fmtD(m.date)}</td>${msRows.some(x => x.baseline_date) ? `<td>${m.baseline_date ? fmtD(m.baseline_date) : ''}</td><td class="${m.variance_days > 0 ? 'crit' : m.variance_days < 0 ? 'okc' : ''}">${m.variance_days == null ? '' : (m.variance_days > 0 ? '+' : '') + fmt1(m.variance_days) + 'd'}</td>` : ''}</tr>`).join('')}</tbody></table></section>` : '';
  const main = mode === 'site' ? [next, watch, ask] : mode === 'client' ? [briefing, milestones, next, ask] : [briefing, watch, ask, next];
  const side = mode === 'site' ? [actions, milestones] : mode === 'client' ? [watch] : [actions, milestones];
  el.innerHTML = `<div class="page ov ov-${mode}">
    <div class="page-head"><div style="min-width:0"><h1 class="display">${esc(p.name)}</h1><p class="lede">Data date ${fmtLong(p.data_date || p.start)} · <span class="chip ${cls}">${label}</span></p></div>
      <div class="head-actions">${modeSeg('ovMode')}<button type="button" class="btn" id="ovAsk">Ask</button>${mode === 'build' ? '<button type="button" class="btn" id="ovTry" title="Try changes safely">Try changes</button>' : ''}${primary}</div></div>
    ${spine}${kpis}
    <div class="mon-grid"><div class="mon-main">${main.join('')}</div><aside class="mon-side">${side.join('')}</aside></div></div>`;
  el.scrollTop = scroll;
  wireModeSeg(el);
  const on = (sel, fn) => { const n = el.querySelector(sel); if (n) n.onclick = fn; };
  on('#ovPlan', () => go('plan')); on('#ovSite', siteUpdateSheet); on('#ovPdf', printSheet); on('#ovAsk', () => { openPalette(); $('#cmdIn').placeholder = 'Ask anything about the programme'; }); on('#ovTry', tryStart);
  el.querySelectorAll('[data-stage]').forEach(btn => btn.onclick = () => { const s = stages.find(x => x.k === btn.dataset.stage); if (s) s.action[1](); });
  el.querySelectorAll('[data-act]').forEach(btn => btn.onclick = () => ACTION_FN[btn.dataset.act]());
  el.querySelectorAll('[data-goto]').forEach(n => { const goTo = () => { if (byId(n.dataset.goto)) goToActivity(n.dataset.goto); }; n.onclick = goTo; n.onkeydown = e => { if (e.key === 'Enter') goTo(); }; });
  on('#ovCopy', async () => { const t = [b.headline, '', b.prose].join('\n'); try { await navigator.clipboard.writeText(t); toast('Briefing copied'); } catch { toast('Select the text and copy it'); } });
  const polish = el.querySelector('#ovPolish');
  if (polish) (LOCAL ? getSample() : Promise.resolve(null)).then(sample => { if (!sample) return; polish.hidden = false; polish.onclick = async () => {
    polish.disabled = true; const box = el.querySelector('#ovProse'), orig = box.innerHTML; box.innerHTML = '<p class="hint">Thinking…</p>';
    try { const { text } = await sample(`You are a UK construction planner writing the weekly programme briefing for the project team and client. Rewrite the draft below as clear, professional prose (UK English, 2-4 short paragraphs, no bullet points, no headings, no preamble). Keep every date, number and activity name exactly as given; do not add facts.\n\nDRAFT:\n${b.headline}\n\n${b.prose}`); box.innerHTML = esc(text).split(/\n\n+/).map(x => `<p>${x}</p>`).join(''); }
    catch (e) { box.innerHTML = orig; toast(AI_ERRORS[e && e.code] || 'Claude could not rewrite it'); } finally { polish.disabled = false; } }; });
  const askOut = el.querySelector('#ovAskOut'), askIn = el.querySelector('#ovAskIn');
  const run = q => { if (!q) return; askIn.value = q; const res = askEngine(q); if (!res) { askOut.innerHTML = '<p class="hint">Questions need the scheduling engine on this page.</p>'; return; } askOut.innerHTML = answerHtml(res, q); wireAnswer(askOut, res, q, run); };
  el.querySelector('#ovAskForm').onsubmit = e => { e.preventDefault(); run(askIn.value.trim()); };
  el.querySelectorAll('#ovAskEx [data-ask-q]').forEach(btn => btn.onclick = () => run(btn.dataset.askQ));
}

// ---------- toolbar wiring ----------
function wireToolbar() {
  $('#btnHome').onclick = () => go('projects');
  $('#crumbProject').onclick = e => projectsPop(e.currentTarget);
  $$('#seg [data-screen]').forEach(b => b.onclick = () => go(b.dataset.screen));
  $('#btnCmd').onclick = openPalette; $('#btnShare').onclick = shareSheet; $('#btnTheme').onclick = toggleTheme;
  const handleImport = async f => {
    toast('Importing ' + f.name);
    try { const v = await importFile(f); show(v); await loadList(); go('overview'); toast(`Imported ${f.name}: ${S.project.activities.length} activities, ${S.project.relationships.length} links`, { ms: 7000, action: { label: 'Details', fn: () => importSummary(S.project, S.report) } }); }
    catch (err) { toast((err && err.detail) || err.message, { ms: 9000 }); }
  };
  $('#fileIn').onchange = async e => { const f = e.target.files[0]; if (f) await handleImport(f); e.target.value = ''; };
  // drop a P6, Asta or MS Project export anywhere on the page
  const hasFiles = e => [...((e.dataTransfer && e.dataTransfer.types) || [])].includes('Files');
  let dragDepth = 0;
  addEventListener('dragenter', e => { if (!hasFiles(e)) return; e.preventDefault(); if (++dragDepth === 1) document.body.classList.add('dropping'); });
  addEventListener('dragover', e => { if (hasFiles(e)) e.preventDefault(); });
  addEventListener('dragleave', e => { if (!hasFiles(e)) return; if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dropping'); } });
  addEventListener('drop', e => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth = 0; document.body.classList.remove('dropping'); const f = e.dataTransfer.files[0]; if (f) handleImport(f); });
  $('#btnUndo').onclick = () => act('/undo'); $('#btnRedo').onclick = () => act('/redo');
  $('#btnInsert').onclick = insertActivity; $('#btnSummary').onclick = insertSummary; $('#btnDelete').onclick = deleteSelected;
  $('#btnIndent').onclick = () => indent(1); $('#btnOutdent').onclick = () => indent(-1); $('#btnUp').onclick = () => moveRow(-1); $('#btnDown').onclick = () => moveRow(1);
  $('#btnLink').onclick = linkSelected; $('#btnUnlink').onclick = unlinkSelected; $('#btnMilestone').onclick = toggleMilestone;
  $('#btnZoomIn').onclick = () => zoom(1.5); $('#btnZoomOut').onclick = () => zoom(1 / 1.5);
  $('#btnFit').onclick = () => { if (!S.project) return; const [t0, t1] = timeRange(); S.view.pxDay = Math.max(1, ($('#sheet').clientWidth - paneWidth() - 60) / ((t1 - t0) / DAY)); render(); };
  $('#btnToday').onclick = () => { if (!S.project) return; const sheet = $('#sheet'); sheet.scrollTo({ left: Math.max(0, S.x(S.project.data_date || S.project.start) - 60), behavior: REDUCED.matches ? 'auto' : 'smooth' }); };
  $('#btnView').onclick = e => openPop($('#popView'), e.currentTarget, 'right');
  $('#btnMore').onclick = e => openPop($('#popMore'), e.currentTarget);
  $$('#popMore button').forEach(b => b.addEventListener('click', () => closePop($('#popMore'))));
  ['links', 'float', 'baseline', 'progress'].forEach(k => { const el = $('#v' + k[0].toUpperCase() + k.slice(1)); el.onchange = () => { S.view[k] = el.checked; render(); }; });
  $('#vColour').onchange = e => { S.view.colour = e.target.value; render(); }; $('#vGroup').onchange = e => { S.view.group = e.target.value; render(); }; $('#vSort').onchange = e => { S.view.sort = e.target.value; render(); };
  $('#vFilter').oninput = e => { S.view.filter = e.target.value; render(); };
  $('#vShow').onchange = e => { S.view.show = e.target.value; render(); };
  $('#vLevel').onchange = e => { S.view.level = +e.target.value; render(); };
  $('#vBarText').onchange = e => { S.view.barText = e.target.value; render(); };
  $('#vPeriods').onchange = e => { S.view.periods = e.target.value; render(); if (e.target.value !== 'none' && !periodsOf(S.project).length) toast('No progress periods closed yet. Close one from More or Monitor.'); };
  $('#btnColumns').onclick = () => { closePops(); columnsDialog(); }; $('#btnViews').onclick = () => { closePops(); viewsDialog(); };
  $$('#modeSeg [data-mode]').forEach(b => b.onclick = () => { S.view.mode = b.dataset.mode; render(); });
  $$('#paneSeg [data-pane]').forEach(b => b.onclick = () => paneMode(b.dataset.pane));
  $('#vTl').onchange = e => { S.view.tlSource = e.target.value; render(); };
  $('#dataDate').onchange = e => { if (e.target.value) mutate(p => { p.data_date = e.target.value + 'T08:00:00'; }, `Data date moved to ${fmtD(e.target.value)}`); };
  $('#btnProgress').onclick = progressDialog; $('#btnConstraint').onclick = constraintDialog;
  $('#btnTry').onclick = () => { if (S.sandbox) paintTry(); else tryStart(); };
  $('#btnBaseline').onclick = () => modal('Set a baseline', `<p class="hint" style="margin-top:0">A baseline freezes today's dates so you can see slippage later, bar by bar.</p><label>Name<input name="n" id="blName" value="Baseline ${S.project ? S.project.baselines.length + 1 : 1}"></label>`, m => act('/baseline', { name: m.querySelector('[name=n]').value || 'Baseline' }), 'Save baseline');
  $('#btnBaselineClear').onclick = () => act('/baseline', null, 'DELETE');
  $('#btnRisk').onclick = riskSheet; $('#btnDrag').onclick = () => computeDrag();
  $('#btnRevision').onclick = revisionDialog; $('#btnCompare').onclick = () => compareSheet();
  $('#btnSite').onclick = siteUpdateSheet; $('#btnPeriod').onclick = closePeriodDialog; $('#btnAsBuilt').onclick = exportAsBuilt;
  $('#btnLevel').onclick = () => act('/level'); $('#btnUnlevel').onclick = () => act('/unlevel');
  $('#btnCalendars').onclick = calendarsDialog; $('#btnResources').onclick = resourcesDialog; $('#btnCodes').onclick = codesDialog;
  $('#btnFields').onclick = fieldsDialog; $('#btnLibrary').onclick = libraryDialog;
  $$('[data-panel]').forEach(b => b.onclick = () => setPanel(b.dataset.panel));
  $('#btnRepair').onclick = () => act('/repair');
  $('#btnInspector').onclick = () => toggleInspector();
  $('#btnAssistant').onclick = () => { const el = $('#ai'); if (!el.hidden) { el.hidden = true; return; } openAssistant(); };
  if ($('#aiStop')) $('#aiStop').onclick = () => { if (S.aiAbort) S.aiAbort.abort(); };
  $('#aiClose').onclick = () => { $('#ai').hidden = true; };
  $('#aiClear').onclick = () => { S.aiHistory = []; S.aiTurns = []; $('#aiLog').innerHTML = ''; addAi('New conversation. What should I build or change?'); };
  $('#aiForm').onsubmit = async e => { e.preventDefault(); const t = $('#aiIn').value.trim(); if (!t) return; $('#aiIn').value = ''; sendAi(t); };
  // command palette
  $('#cmdForm').onsubmit = e => { e.preventDefault(); const items = palItems(); choosePal(items[palSel]); };
  $('#cmdIn').oninput = () => { palSel = 0; $('#cmdOut').textContent = ''; paintPalette(); clearTimeout(askTimer); const t = $('#cmdIn').value.trim(); if (S.project && looksLikeQuestion(t) && t.length > 6 && S.project.activities.length <= 800) askTimer = setTimeout(() => { if ($('#cmdIn').value.trim() === t) askInPalette(t); }, 350); };
  $('#cmdIn').onkeydown = e => {
    if (e.key === 'ArrowDown') { e.preventDefault(); palSel++; paintPalette(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); palSel = Math.max(0, palSel - 1); paintPalette(); }
    else if (e.key === 'Escape') { e.preventDefault(); closePalette(); }
    e.stopPropagation();
  };
  $('#palBack').onpointerdown = e => { if (e.target === $('#palBack')) closePalette(); };
  $('#sheet').addEventListener('keydown', onKey);
  $('#sheet').addEventListener('wheel', e => { if (e.ctrlKey) { e.preventDefault(); zoom(e.deltaY < 0 ? 1.25 : 0.8); } }, { passive: false });
  document.addEventListener('keydown', e => {
    const typing = e.target.matches('input,textarea,select');
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); if ($('#palBack').hidden) openPalette(); else closePalette(); return; }
    if (e.key === 'Escape') {
      const layered = !$('#palBack').hidden || !$('#modalBack').hidden || $$('.pop').some(p => p._open);
      closePops(); if (!$('#palBack').hidden) closePalette();
      if (!layered && !typing && !S.editing && S.trace) clearTrace();   // Esc peels one layer at a time
    }
    if (typing || S.editing) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && S.project) { e.preventDefault(); act(e.shiftKey ? '/redo' : '/undo'); }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y' && S.project) { e.preventDefault(); act('/redo'); }
    if (S.screen === 'plan' && !e.ctrlKey && !e.metaKey && !e.altKey && e.key.toLowerCase() === 'i' && document.activeElement && document.activeElement.id !== 'sheet') { e.preventDefault(); toggleInspector(); }
  });
  addEventListener('resize', () => moveThumb(true));
}
function zoom(f) { S.view.pxDay = Math.max(1, Math.min(40, S.view.pxDay * f)); render(); }

// ---------- start-up ----------
(async () => {
  try { const t = localStorage.getItem('theme'); if (t === 'dark' || t === 'light') document.documentElement.dataset.theme = t; } catch { }
  try { const c = JSON.parse(localStorage.getItem('cols') || 'null'); if (Array.isArray(c) && c.length) S.cols = c.filter(k => ALL_COLS[k]); const w = JSON.parse(localStorage.getItem('colw') || 'null'); if (w) Object.entries(w).forEach(([k, v]) => { if (ALL_COLS[k] && v > 20) ALL_COLS[k].w = v; }); } catch { }
  if (LOCAL && window.__DEMO) { try { const l = await api('/api/projects'); if (!l.length) LOCAL.store(JSON.parse(JSON.stringify(window.__DEMO))); } catch { } }
  wireToolbar();
  try { setMode(localStorage.getItem('mode') || 'build', true); } catch { setMode('build', true); }
  await loadList();
  go('projects');
})();

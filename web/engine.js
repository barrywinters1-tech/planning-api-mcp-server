/* Browser engine: a faithful JS port of the tested Python planner (planner/*.py).
   Same data model, same critical-path arithmetic, same DCMA checks, generator,
   levelling, analysis, patches, commands and repairer. No backend. */
'use strict';
(function (global) {
const EPS = 1e-6;
const HARD = new Set(['must_start_on', 'must_finish_on']);

// ---------- datetime helpers (Date <-> "YYYY-MM-DDTHH:MM:SS") ----------
const P2 = n => String(n).padStart(2, '0');
function D(iso) { if (iso == null) return null; if (iso instanceof Date) return iso; const m = String(iso).match(/(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/); if (!m) return null; return new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)); }
function ISO(d) { return d ? `${d.getFullYear()}-${P2(d.getMonth() + 1)}-${P2(d.getDate())}T${P2(d.getHours())}:${P2(d.getMinutes())}:${P2(d.getSeconds())}` : null; }
function YMD(d) { return `${d.getFullYear()}-${P2(d.getMonth() + 1)}-${P2(d.getDate())}`; }
const dow = d => (d.getDay() + 6) % 7;              // Mon=0 .. Sun=6
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const dateOnly = d => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const hoursDiff = (a, b) => (b - a) / 3600000;

// ---------- Calendar ----------
class Cal {
  constructor(c) {
    this.id = c.id; this.name = c.name || 'Standard';
    this.hours_per_day = c.hours_per_day != null ? c.hours_per_day : 8;
    this.day_start = c.day_start || '08:00:00';
    this.working_days = c.working_days || [0, 1, 2, 3, 4];
    this.exceptions = c.exceptions || {};
    const hm = String(this.day_start).split(':'); this._sh = +hm[0]; this._sm = +hm[1] || 0;
  }
  hours_on(d) { const k = YMD(d); if (k in this.exceptions) return this.exceptions[k]; return this.working_days.includes(dow(d)) ? this.hours_per_day : 0; }
  is_working(d) { return this.hours_on(d) > 0; }
  _shift(d) { const s = new Date(d.getFullYear(), d.getMonth(), d.getDate(), this._sh, this._sm, 0); const e = new Date(s.getTime() + this.hours_on(d) * 3600000); return [s, e]; }
  next_working_start(dt) { let d = dateOnly(dt); for (let i = 0; i < 3660; i++) { if (this.is_working(d)) { const [s, e] = this._shift(d); if (dt < s) return s; if (dt < e) return dt; } d = addDays(d, 1); dt = new Date(d); } throw new Error('no working time'); }
  prev_working_end(dt) { let d = dateOnly(dt); for (let i = 0; i < 3660; i++) { if (this.is_working(d)) { const [s, e] = this._shift(d); if (dt > e) return e; if (dt > s) return dt; } d = addDays(d, -1); dt = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59); } throw new Error('no working time'); }
  in_shift(dt) { if (!this.is_working(dt)) return false; const [s, e] = this._shift(dt); return dt >= s && dt <= e; }
  add_hours(dt, hours) {
    if (hours === 0) return dt;
    if (hours > 0) { dt = this.next_working_start(dt); let rem = hours; for (let i = 0; i < 20000; i++) { const [s, e] = this._shift(dt); const avail = hoursDiff(dt, e); if (rem <= avail + 1e-9) return new Date(dt.getTime() + rem * 3600000); rem -= avail; dt = this.next_working_start(new Date(dateOnly(addDays(dt, 1)))); } }
    else { dt = this.prev_working_end(dt); let rem = -hours; for (let i = 0; i < 20000; i++) { const [s, e] = this._shift(dt); const avail = hoursDiff(s, dt); if (rem <= avail + 1e-9) return new Date(dt.getTime() - rem * 3600000); rem -= avail; dt = this.prev_working_end(new Date(dateOnly(addDays(dt, -1)).getFullYear(), dateOnly(addDays(dt, -1)).getMonth(), dateOnly(addDays(dt, -1)).getDate(), 23, 59, 59)); } }
    throw new Error('add_hours overflow');
  }
  hours_between(a, b) { if (b < a) return -this.hours_between(b, a); let total = 0; let d = dateOnly(a); const end = dateOnly(b); while (d <= end) { if (this.is_working(d)) { const [s, e] = this._shift(d); const lo = a > s ? a : s, hi = b < e ? b : e; if (hi > lo) total += hoursDiff(lo, hi); } d = addDays(d, 1); } return total; }
  days_to_hours(x) { return x * this.hours_per_day; }
  hours_to_days(h) { return this.hours_per_day ? h / this.hours_per_day : 0; }
}

// ---------- project helpers over the plain JSON model ----------
function calFor(p, a) { const cid = a.calendar_id || p.default_calendar_id; return new Cal(p.calendars[cid] || p.calendars[p.default_calendar_id] || { id: 'std' }); }
function amap(p) { const m = {}; p.activities.forEach(a => m[a.id] = a); return m; }
const predsOf = (p, id) => p.relationships.filter(r => r.successor_id === id);
const succsOf = (p, id) => p.relationships.filter(r => r.predecessor_id === id);
const isMs = a => a.type === 'start_milestone' || a.type === 'finish_milestone';
function ensureDefaultCal(p) { if (!p.calendars) p.calendars = {}; if (!(p.default_calendar_id in p.calendars)) { p.default_calendar_id = 'standard'; if (!p.calendars.standard) p.calendars.standard = { id: 'standard', name: 'Standard', hours_per_day: 8, working_days: [0, 1, 2, 3, 4], exceptions: {} }; } }
function remHours(a) { if (a.status === 'complete') return 0; if (a.remaining_hours != null) return Math.max(0, a.remaining_hours); if (a.status === 'in_progress') return Math.max(0, a.duration_hours * (1 - a.percent_complete / 100)); return a.duration_hours; }

function topo(p) {
  const ids = p.activities.map(a => a.id), known = new Set(ids), indeg = {}, succ = {};
  ids.forEach(i => { indeg[i] = 0; succ[i] = []; });
  for (const r of p.relationships) {
    if (!known.has(r.predecessor_id) || !known.has(r.successor_id)) throw new Error(`Relationship ${r.predecessor_id}->${r.successor_id} references an unknown activity`);
    if (r.predecessor_id === r.successor_id) throw new Error(`Activity ${r.predecessor_id} is linked to itself`);
    succ[r.predecessor_id].push(r.successor_id); indeg[r.successor_id]++;
  }
  const q = ids.filter(i => indeg[i] === 0), order = [];
  while (q.length) { const n = q.shift(); order.push(n); for (const s of succ[n]) { if (--indeg[s] === 0) q.push(s); } }
  if (order.length !== ids.length) { const stuck = ids.filter(i => indeg[i] > 0); throw new Error('Schedule contains a logic loop involving: ' + stuck.slice(0, 10).join(', ')); }
  const m = amap(p); return order.map(i => m[i]);
}

function schedule(p) {
  ensureDefaultCal(p);
  const order = topo(p), m = amap(p);
  const dataDate = D(p.data_date) || D(p.start), start = D(p.start);
  const preds = {}, succs = {};
  p.activities.forEach(a => { preds[a.id] = []; succs[a.id] = []; });
  for (const r of p.relationships) { preds[r.successor_id].push(r); succs[r.predecessor_id].push(r); }
  const maxD = (a, b) => (a && b) ? (a > b ? a : b) : (a || b);

  for (const a of order) {
    const cal = calFor(p, a), rem = remHours(a);
    if (a.status === 'complete' && a.actual_start && a.actual_finish) { a.early_start = a.actual_start; a.early_finish = a.actual_finish; continue; }
    let es_floor = cal.next_working_start(maxD(start, dataDate)), ef_floor = null;
    if (a.status === 'in_progress' && a.actual_start) { es_floor = D(a.actual_start); ef_floor = cal.add_hours(cal.next_working_start(dataDate), rem); }
    for (const r of preds[a.id]) {
      const pr = m[r.predecessor_id], pcal = calFor(p, pr);
      if (r.type === 'FS') { const t = pcal.add_hours(D(pr.early_finish), r.lag_hours); if (t > es_floor) es_floor = t; }
      else if (r.type === 'SS') { const t = pcal.add_hours(D(pr.early_start), r.lag_hours); if (t > es_floor) es_floor = t; }
      else if (r.type === 'FF') { const t = pcal.add_hours(D(pr.early_finish), r.lag_hours); ef_floor = ef_floor === null ? t : maxD(ef_floor, t); }
      else if (r.type === 'SF') { const t = pcal.add_hours(D(pr.early_start), r.lag_hours); ef_floor = ef_floor === null ? t : maxD(ef_floor, t); }
    }
    const cd = D(a.constraint_date);
    if (cd) {
      if (a.constraint === 'start_on_or_after' || a.constraint === 'must_start_on') es_floor = a.constraint === 'start_on_or_after' ? maxD(es_floor, cd) : cd;
      else if (a.constraint === 'finish_on_or_after' || a.constraint === 'must_finish_on') ef_floor = (ef_floor === null || a.constraint === 'must_finish_on') ? cd : maxD(ef_floor, cd);
    }
    let es, ef;
    if (a.status === 'in_progress' && a.actual_start) { es = D(a.actual_start); ef = ef_floor !== null ? ef_floor : cal.add_hours(cal.next_working_start(dataDate), rem); }
    else if (a.type === 'finish_milestone') { const target = ef_floor === null ? es_floor : maxD(es_floor, ef_floor); es = ef = cal.in_shift(target) ? target : cal.prev_working_end(target); }
    else { es = cal.next_working_start(es_floor); ef = rem > 0 ? cal.add_hours(es, rem) : es; if (ef_floor !== null && ef_floor > ef) { ef = rem > 0 ? ef_floor : cal.prev_working_end(ef_floor); es = rem > 0 ? cal.add_hours(ef, -rem) : ef; } }
    if (a.status === 'not_started' && cd) { if (a.constraint === 'must_start_on') { es = cd; ef = rem > 0 ? cal.add_hours(es, rem) : es; } else if (a.constraint === 'must_finish_on') { ef = cd; es = rem > 0 ? cal.add_hours(ef, -rem) : ef; } }
    a.early_start = ISO(es); a.early_finish = ISO(ef);
  }
  let pfin = null; for (const a of p.activities) { const f = D(a.early_finish); if (f && (!pfin || f > pfin)) pfin = f; }
  pfin = pfin || start; p.finish = ISO(pfin);
  const lateAnchor = D(p.must_finish_by) || pfin;

  for (let i = order.length - 1; i >= 0; i--) {
    const a = order[i], cal = calFor(p, a), rem = remHours(a);
    if (a.status === 'complete' && a.actual_finish) { a.late_start = a.early_start; a.late_finish = a.early_finish; a.total_float_hours = 0; a.free_float_hours = 0; a.critical = false; continue; }
    let lf_ceil = cal.prev_working_end(lateAnchor), ls_ceil = null;
    for (const r of succs[a.id]) {
      const s = m[r.successor_id]; if (s.status === 'complete') continue;
      if (r.type === 'FS') { const t = cal.add_hours(D(s.late_start), -r.lag_hours); if (t < lf_ceil) lf_ceil = t; }
      else if (r.type === 'SS') { const t = cal.add_hours(D(s.late_start), -r.lag_hours); ls_ceil = ls_ceil === null ? t : (t < ls_ceil ? t : ls_ceil); }
      else if (r.type === 'FF') { const t = cal.add_hours(D(s.late_finish), -r.lag_hours); if (t < lf_ceil) lf_ceil = t; }
      else if (r.type === 'SF') { const t = cal.add_hours(D(s.late_finish), -r.lag_hours); ls_ceil = ls_ceil === null ? t : (t < ls_ceil ? t : ls_ceil); }
    }
    const cd = D(a.constraint_date);
    if (cd) {
      if (a.constraint === 'finish_on_or_before' || a.constraint === 'must_finish_on') lf_ceil = a.constraint === 'finish_on_or_before' ? (cd < lf_ceil ? cd : lf_ceil) : cd;
      else if (a.constraint === 'start_on_or_before' || a.constraint === 'must_start_on') ls_ceil = (ls_ceil === null || a.constraint === 'must_start_on') ? cd : (cd < ls_ceil ? cd : ls_ceil);
    }
    let lf = cal.prev_working_end(lf_ceil), ls = rem > 0 ? cal.add_hours(lf, -rem) : lf;
    if (ls_ceil !== null && ls_ceil < ls) { ls = rem === 0 ? cal.prev_working_end(ls_ceil) : ls_ceil; lf = rem > 0 ? cal.add_hours(ls, rem) : ls; }
    if (a.status === 'in_progress' && a.actual_start) ls = D(a.actual_start);
    a.late_start = ISO(ls); a.late_finish = ISO(lf);
    a.total_float_hours = Math.round(cal.hours_between(D(a.early_finish), D(a.late_finish)) * 1e4) / 1e4;
    let ff = null;
    for (const r of succs[a.id]) {
      const s = m[r.successor_id]; let slack;
      if (r.type === 'FS') slack = cal.hours_between(cal.add_hours(D(a.early_finish), r.lag_hours), D(s.early_start));
      else if (r.type === 'SS') slack = cal.hours_between(cal.add_hours(D(a.early_start), r.lag_hours), D(s.early_start));
      else if (r.type === 'FF') slack = cal.hours_between(cal.add_hours(D(a.early_finish), r.lag_hours), D(s.early_finish));
      else slack = cal.hours_between(cal.add_hours(D(a.early_start), r.lag_hours), D(s.early_finish));
      ff = ff === null ? slack : Math.min(ff, slack);
    }
    a.free_float_hours = Math.round((ff === null ? a.total_float_hours : Math.max(0, ff)) * 1e4) / 1e4;
  }
  const openTf = p.activities.filter(a => a.status !== 'complete' && a.total_float_hours != null).map(a => a.total_float_hours);
  const threshold = openTf.length ? Math.max(0, Math.min(...openTf)) : 0;
  for (const a of p.activities) a.critical = (a.status === 'complete' || a.total_float_hours == null) ? false : a.total_float_hours <= threshold + EPS;

  for (const a of p.activities) {
    if (a.type !== 'level_of_effort' || a.status === 'complete') continue;
    const cal = calFor(p, a);
    let starts = preds[a.id].filter(r => r.type === 'SS').map(r => D(m[r.predecessor_id].early_start)).filter(Boolean);
    let ends = preds[a.id].filter(r => r.type === 'FF').map(r => D(m[r.predecessor_id].early_finish)).filter(Boolean);
    if (!starts.length && !ends.length) { const peers = p.activities.filter(x => x.wbs_id === a.wbs_id && x.id !== a.id && x.type !== 'level_of_effort' && x.early_start); starts = peers.map(x => D(x.actual_start || x.early_start)); ends = peers.map(x => D(x.actual_finish || x.early_finish)); }
    if (starts.length) { const mn = new Date(Math.min(...starts)); a.early_start = a.late_start = ISO(mn); }
    if (ends.length) { const mx = new Date(Math.max(...ends)); a.early_finish = a.late_finish = ISO(mx); }
    if (a.early_start && a.early_finish) { a.duration_hours = Math.round(cal.hours_between(D(a.early_start), D(a.early_finish)) * 100) / 100; a.total_float_hours = a.free_float_hours = 0; a.critical = false; }
  }
  for (const a of p.activities) if (a.constraint === 'as_late_as_possible' && a.status === 'not_started') { a.early_start = a.late_start; a.early_finish = a.late_finish; a.total_float_hours = 0; a.free_float_hours = 0; }
  p.scheduled_at = ISO(new Date());
  return p;
}

global.PlannerEngine = { EPS, HARD, Cal, D, ISO, YMD, dow, addDays, dateOnly, calFor, amap, predsOf, succsOf, isMs, ensureDefaultCal, remHours, schedule };
})(typeof window !== 'undefined' ? window : globalThis);

/* ---- part 2: DCMA, generator, patches, commands, repair, levelling, analysis, files ---- */
(function (global) {
const E = global.PlannerEngine;
const { D, ISO, YMD, dow, addDays, dateOnly, calFor, amap, predsOf, succsOf, isMs, ensureDefaultCal, remHours, schedule, EPS, HARD } = E;
const clone = o => JSON.parse(JSON.stringify(o));
const round = (x, n = 0) => { const f = 10 ** n; return Math.round(x * f) / f; };
const pct = (n, d) => d ? round(100 * n / d, 1) : 0;
const HIGH_FLOAT = 44, HIGH_DUR = 44;

// ---------- DCMA ----------
function healthCheck(p) {
  const checks = [];
  const acts = p.activities.filter(a => a.type !== 'level_of_effort');
  const incomplete = acts.filter(a => a.status !== 'complete');
  const nInc = incomplete.length;
  const dataDate = D(p.data_date) || D(p.start);
  const C = (key, title, passed, o = {}) => checks.push(Object.assign({ key, title, passed, value: null, threshold: null, detail: '', items: [], applicable: true }, o));

  const missing = incomplete.filter(a => !((predsOf(p, a.id).length || a.type === 'start_milestone') && (succsOf(p, a.id).length || a.type === 'finish_milestone'))).map(a => a.id);
  C('logic', 'Missing logic', pct(missing.length, nInc) <= 5, { value: pct(missing.length, nInc), threshold: '≤ 5%', detail: `${missing.length} of ${nInc} incomplete activities lack a predecessor or successor.`, items: missing });
  const leads = p.relationships.filter(r => r.lag_hours < 0).map(r => `${r.predecessor_id}->${r.successor_id}`);
  C('leads', 'Leads (negative lag)', leads.length === 0, { value: pct(leads.length, p.relationships.length), threshold: '0%', detail: `${leads.length} relationships use negative lag.`, items: leads });
  const lags = p.relationships.filter(r => r.lag_hours > 0).map(r => `${r.predecessor_id}->${r.successor_id}`);
  C('lags', 'Lags', pct(lags.length, p.relationships.length) <= 5, { value: pct(lags.length, p.relationships.length), threshold: '≤ 5%', detail: `${lags.length} of ${p.relationships.length} relationships carry positive lag.`, items: lags });
  const fs = p.relationships.filter(r => r.type === 'FS').length;
  C('rel_types', 'Finish-to-start share', pct(fs, p.relationships.length) >= 90 || !p.relationships.length, { value: pct(fs, p.relationships.length), threshold: '≥ 90%', detail: `${fs} of ${p.relationships.length} links are FS.` });
  const hard = incomplete.filter(a => HARD.has(a.constraint)).map(a => a.id);
  C('hard_constraints', 'Hard constraints', pct(hard.length, nInc) <= 5, { value: pct(hard.length, nInc), threshold: '≤ 5%', detail: `${hard.length} incomplete activities have must-start/finish-on constraints.`, items: hard });
  const hf = incomplete.filter(a => a.total_float_hours != null && calFor(p, a).hours_to_days(a.total_float_hours) > HIGH_FLOAT).map(a => a.id);
  C('high_float', 'High float', pct(hf.length, nInc) <= 5, { value: pct(hf.length, nInc), threshold: '≤ 5%', detail: `${hf.length} incomplete activities have more than ${HIGH_FLOAT} days total float.`, items: hf });
  const nf = incomplete.filter(a => a.total_float_hours != null && a.total_float_hours < -1e-6).map(a => a.id);
  C('negative_float', 'Negative float', !nf.length, { value: nf.length, threshold: '0', detail: `${nf.length} activities have negative total float.`, items: nf });
  const hd = incomplete.filter(a => !isMs(a) && calFor(p, a).hours_to_days(a.remaining_hours != null ? a.remaining_hours : a.duration_hours) > HIGH_DUR).map(a => a.id);
  C('high_duration', 'High duration', pct(hd.length, nInc) <= 5, { value: pct(hd.length, nInc), threshold: '≤ 5%', detail: `${hd.length} incomplete activities are longer than ${HIGH_DUR} working days.`, items: hd });
  let bad = [];
  for (const a of acts) {
    if (a.status === 'not_started' && a.early_start && D(a.early_start) < dataDate) bad.push(a.id);
    if (a.actual_start && D(a.actual_start) > dataDate) bad.push(a.id);
    if (a.actual_finish && D(a.actual_finish) > dataDate) bad.push(a.id);
    if (a.status === 'complete' && !a.actual_finish) bad.push(a.id);
  }
  bad = [...new Set(bad)].sort();
  C('invalid_dates', 'Invalid dates', !bad.length, { value: bad.length, threshold: '0', detail: `${bad.length} activities have forecast dates before, or actual dates after, the data date.`, items: bad });
  const assigned = new Set(p.assignments.map(x => x.activity_id));
  const unres = incomplete.filter(a => !isMs(a) && a.duration_hours > 0 && !assigned.has(a.id)).map(a => a.id);
  C('resources', 'Unresourced activities', !unres.length, { value: pct(unres.length, nInc), threshold: '0% (informational)', applicable: !!p.resources.length, detail: `${unres.length} activities with duration have no resource assigned.`, items: unres });
  const baselined = acts.filter(a => a.baseline_finish);
  const due = baselined.filter(a => D(a.baseline_finish) <= dataDate);
  const missed = due.filter(a => a.status !== 'complete' || (a.actual_finish && D(a.actual_finish) > D(a.baseline_finish))).map(a => a.id);
  C('missed_tasks', 'Missed tasks', pct(missed.length, due.length) <= 5, { value: pct(missed.length, due.length), threshold: '≤ 5%', applicable: !!baselined.length, detail: `${missed.length} of ${due.length} baseline-due activities missed their finish.`, items: missed });
  const [cpOk, cpDetail] = cpTest(p);
  C('cp_test', 'Critical path test', cpOk, { threshold: 'finish moves with critical delay', detail: cpDetail, applicable: nInc > 0 });
  if (p.must_finish_by && p.finish) { const cal = new E.Cal(p.calendars[p.default_calendar_id]); const cpl = cal.hours_between(dataDate, D(p.finish)); const tf = cal.hours_between(D(p.finish), D(p.must_finish_by)); const cpli = cpl > 0 ? round((cpl + tf) / cpl, 2) : 1; C('cpli', 'Critical path length index', cpli >= 0.95, { value: cpli, threshold: '≥ 0.95', detail: `Critical path ${Math.round(cal.hours_to_days(cpl))}d, float to must-finish ${Math.round(cal.hours_to_days(tf))}d.` }); }
  else C('cpli', 'Critical path length index', true, { applicable: false, detail: 'Set a must-finish-by date to compute CPLI.' });
  const plannedDone = due, actuallyDone = acts.filter(a => a.status === 'complete');
  if (plannedDone.length) { const bei = round(actuallyDone.length / plannedDone.length, 2); C('bei', 'Baseline execution index', bei >= 0.95, { value: bei, threshold: '≥ 0.95', detail: `${actuallyDone.length} complete vs ${plannedDone.length} planned complete by data date.` }); }
  else C('bei', 'Baseline execution index', true, { applicable: false, detail: 'Needs a baseline with activities due by the data date.' });
  const starts = incomplete.filter(a => !predsOf(p, a.id).length).map(a => a.id);
  const finishes = incomplete.filter(a => !succsOf(p, a.id).length).map(a => a.id);
  C('open_ends', 'Single start and finish', starts.length <= 1 && finishes.length <= 1, { value: starts.length + finishes.length, threshold: '1 start, 1 finish', detail: `${starts.length} activities have no predecessor, ${finishes.length} have no successor.`, items: [...new Set([...starts, ...finishes])].sort() });
  let dangling = [];
  for (const a of incomplete) { if (isMs(a)) continue; const outs = succsOf(p, a.id); if (outs.length && outs.every(r => r.type === 'SS')) dangling.push(a.id); const ins = predsOf(p, a.id); if (ins.length && ins.every(r => r.type === 'FF')) dangling.push(a.id); }
  dangling = [...new Set(dangling)].sort();
  C('dangling', 'Dangling logic', !dangling.length, { value: dangling.length, threshold: '0', detail: `${dangling.length} activities only drive successors by their start, or are only driven on their finish.`, items: dangling });
  const applicable = checks.filter(c => c.applicable);
  const score = applicable.length ? Math.round(100 * applicable.filter(c => c.passed).length / applicable.length) : 100;
  const fails = applicable.filter(c => !c.passed).map(c => c.title);
  return { score, checks, summary: fails.length ? 'Failing: ' + fails.join(', ') + '.' : 'Schedule passes all applicable checks.', failing: () => checks.filter(c => c.applicable && !c.passed) };
}
function cpTest(p) {
  const crit = p.activities.filter(a => a.critical && a.status !== 'complete' && !isMs(a));
  if (!crit.length || !p.finish) return [true, 'No incomplete critical activities to test.'];
  const trial = clone(p); const t = trial.activities.find(a => a.id === crit[0].id);
  const push = new E.Cal(trial.calendars[t.calendar_id || trial.default_calendar_id]).days_to_hours(600);
  if (t.status === 'in_progress' && t.remaining_hours != null) t.remaining_hours += push; else { t.duration_hours += push; if (t.remaining_hours != null) t.remaining_hours += push; }
  try { schedule(trial); } catch (e) { return [false, 'Could not schedule the trial: ' + e.message]; }
  const moved = Math.round((D(trial.finish) - D(p.finish)) / 86400000);
  return [moved >= 540, `Adding 600 days to ${t.id} moved the finish by ${moved} calendar days.`];
}

// ---------- patches ----------
const STD_CALS = { standard: { name: 'Standard 5d x 8h', hours_per_day: 8, working_days: [0, 1, 2, 3, 4] }, six_day: { name: 'Six day 8h', hours_per_day: 8, working_days: [0, 1, 2, 3, 4, 5] }, seven_day: { name: 'Seven day (continuous)', hours_per_day: 8, working_days: [0, 1, 2, 3, 4, 5, 6] } };
const UK_HOL = ['2026-01-01','2026-04-03','2026-04-06','2026-05-04','2026-05-25','2026-08-31','2026-12-25','2026-12-28','2027-01-01','2027-03-26','2027-03-29','2027-05-03','2027-05-31','2027-08-30','2027-12-27','2027-12-28'];
function ensureCalendars(p) {
  if (!p.calendars) p.calendars = {};
  for (const [key, spec] of Object.entries(STD_CALS)) if (!(key in p.calendars)) { const c = { id: key, name: spec.name, hours_per_day: spec.hours_per_day, day_start: '08:00:00', working_days: spec.working_days.slice(), exceptions: {} }; if (key !== 'seven_day') UK_HOL.forEach(h => c.exceptions[h] = 0); p.calendars[key] = c; }
  p.default_calendar_id = 'standard';
}
function parseDate(s, hour = 8) { if (!s) return null; const m = String(s).match(/(\d{4})-(\d{2})-(\d{2})/); if (m) return `${m[1]}-${m[2]}-${m[3]}T${P2h(hour)}:00:00`; const dm = String(s).match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/); if (dm) return `${dm[3]}-${P2h(+dm[2])}-${P2h(+dm[1])}T${P2h(hour)}:00:00`; return null; }
const P2h = n => String(n).padStart(2, '0');
function dedupe(p) { const seen = new Set(), out = []; for (const r of p.relationships) { const k = r.predecessor_id + '|' + r.successor_id + '|' + r.type; if (!seen.has(k)) { seen.add(k); out.push(r); } } p.relationships = out; }
function d2h(p, a, days) { return calFor(p, a).days_to_hours(days); }
function calById(p, cid) { return new E.Cal(p.calendars[cid] || p.calendars[p.default_calendar_id]); }

function applyPatch(p, patch) {
  ensureCalendars(p); const log = []; const m = amap(p);
  const mk = (o) => Object.assign({ op: '', activity_id: null, predecessor_id: null, successor_id: null, link_type: null, lag_days: null, name: null, duration_days: null, activity_type: null, calendar: null, wbs_code: null, parent_wbs_code: null, constraint_type: null, date: null, percent_complete: null, remaining_days: null, actual_start: null, actual_finish: null, trade: null, reason: '' }, o);
  for (let op of patch.ops) {
    op = mk(op);
    try {
      if (op.op === 'add_activity') {
        if (!op.activity_id || m[op.activity_id]) throw new Error('needs a new unique activity_id');
        const calkey = op.calendar || 'standard', atype = op.activity_type || 'task';
        const a = { id: op.activity_id, name: op.name || op.activity_id, wbs_id: p.wbs.some(w => w.id === op.wbs_code) ? op.wbs_code : null, calendar_id: calkey, type: atype, duration_hours: atype !== 'task' ? 0 : calById(p, calkey).days_to_hours(op.duration_days || 0), constraint: 'none', constraint_date: null, status: 'not_started', actual_start: null, actual_finish: null, remaining_hours: null, percent_complete: 0, baseline_start: null, baseline_finish: null, early_start: null, early_finish: null, late_start: null, late_finish: null, total_float_hours: null, free_float_hours: null, critical: false, notes: op.reason || '', codes: {}, priority: 500, level_delay_hours: 0 };
        p.activities.push(a); m[a.id] = a;
        if (op.trade) { const rid = op.trade.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '').toUpperCase().slice(0, 20); if (!p.resources.some(r => r.id === rid)) p.resources.push({ id: rid, name: op.trade, type: 'labour', unit: 'h', rate: 0, max_units_per_day: null, colour: null }); p.assignments.push({ activity_id: a.id, resource_id: rid, units: a.duration_hours, cost: 0, actual_cost: 0 }); }
        if (op.predecessor_id && m[op.predecessor_id]) p.relationships.push({ predecessor_id: op.predecessor_id, successor_id: a.id, type: op.link_type || 'FS', lag_hours: d2h(p, m[op.predecessor_id], op.lag_days || 0) });
        if (op.successor_id && m[op.successor_id]) p.relationships.push({ predecessor_id: a.id, successor_id: op.successor_id, type: 'FS', lag_hours: 0 });
        log.push(`added ${a.id} ${a.name}`);
      } else if (op.op === 'remove_activity') {
        const a = m[op.activity_id]; if (!a) throw new Error('unknown'); delete m[op.activity_id];
        const preds = predsOf(p, a.id), succs = succsOf(p, a.id);
        p.activities = p.activities.filter(x => x.id !== a.id);
        p.relationships = p.relationships.filter(r => r.predecessor_id !== a.id && r.successor_id !== a.id);
        p.assignments = p.assignments.filter(x => x.activity_id !== a.id);
        for (const pr of preds) for (const s of succs) if (pr.type === 'FS' && s.type === 'FS') p.relationships.push({ predecessor_id: pr.predecessor_id, successor_id: s.successor_id, type: 'FS', lag_hours: 0 });
        log.push(`removed ${a.id} and bridged ${preds.length}x${succs.length} links`);
      } else if (op.op === 'rename') { if (!m[op.activity_id]) throw new Error('unknown'); m[op.activity_id].name = op.name || m[op.activity_id].name; log.push(`renamed ${op.activity_id}`); }
      else if (op.op === 'set_duration') { const a = m[op.activity_id]; if (!a) throw new Error('unknown'); a.duration_hours = d2h(p, a, Math.max(0, op.duration_days || 0)); if (a.status === 'in_progress') a.remaining_hours = op.remaining_days != null ? d2h(p, a, op.remaining_days) : Math.max(0, a.duration_hours * (1 - a.percent_complete / 100)); log.push(`${a.id} duration -> ${op.duration_days}d`); }
      else if (op.op === 'set_type') { const a = m[op.activity_id]; if (!a) throw new Error('unknown'); a.type = op.activity_type || 'task'; if (a.type !== 'task') a.duration_hours = 0; log.push(`${a.id} type -> ${a.type}`); }
      else if (op.op === 'set_calendar') { const a = m[op.activity_id]; if (!a) throw new Error('unknown'); const old = calFor(p, a); a.calendar_id = op.calendar || 'standard'; a.duration_hours = calFor(p, a).days_to_hours(old.hours_to_days(a.duration_hours)); log.push(`${a.id} calendar -> ${a.calendar_id}`); }
      else if (op.op === 'add_link') { if (!m[op.predecessor_id] || !m[op.successor_id]) throw new Error('unknown activity in link'); if (op.predecessor_id === op.successor_id) throw new Error('cannot link an activity to itself'); const lt = op.link_type || 'FS'; p.relationships = p.relationships.filter(r => !(r.predecessor_id === op.predecessor_id && r.successor_id === op.successor_id && r.type === lt)); p.relationships.push({ predecessor_id: op.predecessor_id, successor_id: op.successor_id, type: lt, lag_hours: d2h(p, m[op.predecessor_id], op.lag_days || 0) }); log.push(`linked ${op.predecessor_id} -${lt}-> ${op.successor_id}`); }
      else if (op.op === 'remove_link') { const b = p.relationships.length; p.relationships = p.relationships.filter(r => !(r.predecessor_id === op.predecessor_id && r.successor_id === op.successor_id && (op.link_type == null || r.type === op.link_type))); log.push(`removed ${b - p.relationships.length} link(s) ${op.predecessor_id}->${op.successor_id}`); }
      else if (op.op === 'set_constraint') { const a = m[op.activity_id]; if (!a) throw new Error('unknown'); a.constraint = op.constraint_type || 'start_on_or_after'; a.constraint_date = parseDate(op.date, a.constraint.includes('finish') ? 16 : 8); log.push(`${a.id} constraint -> ${a.constraint} ${op.date}`); }
      else if (op.op === 'clear_constraint') { const a = m[op.activity_id]; if (!a) throw new Error('unknown'); a.constraint = 'none'; a.constraint_date = null; log.push(`${a.id} constraint cleared`); }
      else if (op.op === 'set_progress') { const a = m[op.activity_id]; if (!a) throw new Error('unknown'); if (op.actual_start) a.actual_start = parseDate(op.actual_start); if (op.actual_finish) { a.actual_finish = parseDate(op.actual_finish, 16); a.status = 'complete'; a.percent_complete = 100; a.remaining_hours = 0; } else if (op.percent_complete != null || op.remaining_days != null || a.actual_start) { a.status = 'in_progress'; if (op.percent_complete != null) a.percent_complete = op.percent_complete; a.remaining_hours = op.remaining_days != null ? d2h(p, a, op.remaining_days) : Math.max(0, a.duration_hours * (1 - a.percent_complete / 100)); if (!a.actual_start) a.actual_start = p.data_date || p.start; } log.push(`${a.id} progress -> ${a.status} ${a.percent_complete}%`); }
      else if (op.op === 'set_project_start') { p.start = parseDate(op.date) || p.start; if (p.data_date && D(p.data_date) < D(p.start)) p.data_date = p.start; log.push(`project start -> ${op.date}`); }
      else if (op.op === 'set_must_finish_by') { p.must_finish_by = parseDate(op.date, 16); log.push(`must finish by -> ${op.date}`); }
      else if (op.op === 'add_wbs') { if (op.wbs_code && !p.wbs.some(w => w.id === op.wbs_code)) p.wbs.push({ id: op.wbs_code, code: op.wbs_code, name: op.name || op.wbs_code, parent_id: op.parent_wbs_code || null, seq: p.wbs.length }); log.push(`added WBS ${op.wbs_code}`); }
      else if (op.op === 'move_to_wbs') { if (!m[op.activity_id]) throw new Error('unknown'); m[op.activity_id].wbs_id = op.wbs_code; log.push(`${op.activity_id} -> WBS ${op.wbs_code}`); }
      else if (op.op === 'note') { if (op.activity_id && m[op.activity_id]) { const a = m[op.activity_id]; a.notes = (a.notes ? a.notes + ' | ' : '') + op.reason; } else p.assumptions.push(op.reason); log.push('noted'); }
    } catch (e) { log.push(`skipped ${op.op} ${op.activity_id || ''}: ${e.message}`); }
  }
  dedupe(p); return log;
}

global.PlannerEngine.healthCheck = healthCheck;
global.PlannerEngine.applyPatch = applyPatch;
global.PlannerEngine.ensureCalendars = ensureCalendars;
global.PlannerEngine.parseDate = parseDate;
global.PlannerEngine.clone = clone;
})(typeof window !== 'undefined' ? window : globalThis);

/* ---- part 3: generator, draft_to_project, levelling, analysis, repair, commands ---- */
(function (global) {
const E = global.PlannerEngine;
const { D, ISO, YMD, dow, addDays, dateOnly, calFor, amap, predsOf, succsOf, isMs, schedule, EPS, HARD, applyPatch, healthCheck, ensureCalendars, parseDate, clone } = E;

const RATES = { site_setup_base: 5, site_setup_per_1000m2: 1, demolition_m2_per_day: 120, service_diversion_days: 15, remediation_m2_per_day: 100, reduce_level_m2_per_day: 250, basement_m2_per_day: 25, strip_found_m2_per_day: 60, raft_m2_per_day: 90, piles_per_day: 8, m2_per_pile: 12, pile_caps_m2_per_day: 120, drainage_m2_per_day: 150, ground_slab_m2_per_day: 120, frame_masonry_m2_per_day: 35, frame_rc_m2_per_day: 45, rc_cure_days: 3, frame_steel_m2_per_day: 180, steel_deck_m2_per_day: 150, frame_timber_m2_per_day: 120, roof_m2_per_day: 70, envelope_brick_m2_per_day: 45, envelope_render_m2_per_day: 70, envelope_cladding_m2_per_day: 110, envelope_curtain_wall_m2_per_day: 90, windows_base: 3, windows_per_storey: 2, first_fix_m2_per_day: 90, drylining_m2_per_day: 70, screed_m2_per_day: 250, second_fix_m2_per_day: 80, decoration_m2_per_day: 110, finishes_m2_per_day: 160, commissioning_base: 10, commissioning_per_storey: 2, externals_base: 10, externals_m2_per_day: 120, snagging_days: 10, max_activity_days: 40, zone_m2: 900 };
const DEFAULT_GIA = { house: 150, houses: 95, apartments: 75, office: 1200, warehouse: 3000, school: 2500, refurbishment: 800, generic: 800 };
const MONTHS = {}; ['january','february','march','april','may','june','july','august','september','october','november','december'].forEach((m, i) => { MONTHS[m] = i + 1; MONTHS[m.slice(0, 3)] = i + 1; });
const WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, single: 1, twelve: 12, twenty: 20 };
const monthAlt = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join('|');
function numTok(t) { t = t.toLowerCase().replace(/,/g, ''); if (t in WORDS) return WORDS[t]; const n = parseFloat(t); return isNaN(n) ? null : n; }
const isoDate = (y, mo, d) => `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

function findDates(text) {
  const out = []; const t = text.toLowerCase();
  let re = new RegExp('(\\d{1,2})(?:st|nd|rd|th)?\\s+(' + monthAlt + ')\\w*\\s+(\\d{4})', 'g'), m;
  while ((m = re.exec(t))) out.push([m.index, isoDate(+m[3], MONTHS[m[2]], +m[1])]);
  re = new RegExp('\\b(' + monthAlt + ')\\w*\\s+(\\d{4})\\b', 'g');
  while ((m = re.exec(t))) { if (out.some(o => Math.abs(o[0] - m.index) < 12)) continue; out.push([m.index, isoDate(+m[2], MONTHS[m[1]], 1)]); }
  re = /\b(\d{4})-(\d{2})-(\d{2})\b/g; while ((m = re.exec(t))) out.push([m.index, isoDate(+m[1], +m[2], +m[3])]);
  re = /\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/g; while ((m = re.exec(t))) out.push([m.index, isoDate(+m[3], +m[2], +m[1])]);
  re = /christmas\s+(\d{4})/g; while ((m = re.exec(t))) out.push([m.index, isoDate(+m[1], 12, 18)]);
  re = /\b(?:q([1-4])|(?:end|start)\s+of\s+(\d{4}))\b/g;
  while ((m = re.exec(t))) { if (m[1]) { const yr = t.slice(m.index + m[0].length, m.index + m[0].length + 8).match(/(\d{4})/); if (yr) out.push([m.index, isoDate(+yr[1], 3 * +m[1], 28)]); } else if (m[2]) { const end = m[0].includes('end'); out.push([m.index, isoDate(+m[2], end ? 12 : 1, end ? 15 : 6)]); } }
  return out.sort((a, b) => a[0] - b[0]);
}
function parseBrief(text) {
  const t = text.toLowerCase();
  const b = { name: 'New project', building_type: 'generic', storeys: 2, gross_internal_area_m2: 0, units: 0, frame: null, foundations: null, envelope: null, roof: null, fit_out: 'full', basement: false, demolition: false, service_diversion: false, contaminated_ground: false, external_works: true, start_date: null, deadline: null, six_day_week: false, planning_condition_date: null, location: '', source_text: text.trim() };
  for (const [key, pat] of [['apartments', /apartment|flat|unit block|residential block/], ['houses', /houses|dwellings|plots|housing/], ['house', /\bhouse\b|dwelling|bungalow/], ['warehouse', /warehouse|industrial|distribution|shed/], ['office', /office|commercial/], ['school', /school|academy|college|classroom/], ['refurbishment', /refurb|retrofit|conversion|remodel|extension/]]) if (pat.test(t)) { b.building_type = key; break; }
  if (b.building_type === 'houses' && /\b(one|1|a|single)\s+(new\s+)?(house|dwelling)/.test(t)) b.building_type = 'house';
  let m = t.match(new RegExp('(\\d+|' + Object.keys(WORDS).join('|') + ')[\\s-]*(?:storey|story|stories|storeys|floors?|levels?)\\b')); if (m && numTok(m[1])) b.storeys = Math.floor(numTok(m[1]));
  if (/\bbungalow\b|single[\s-]storey/.test(t)) b.storeys = 1;
  m = t.match(/(\d[\d,]*(?:\.\d+)?)\s*(?:m2|m²|sqm|sq\.?\s*m|square met)/); if (m) b.gross_internal_area_m2 = parseFloat(m[1].replace(/,/g, ''));
  m = t.match(/(\d[\d,]*(?:\.\d+)?)\s*(?:sq\.?\s*ft|ft2|square feet)/); if (m && !b.gross_internal_area_m2) b.gross_internal_area_m2 = Math.round(parseFloat(m[1].replace(/,/g, '')) / 10.764);
  m = t.match(/(\d+)[\s-]*(?:unit|flat|apartment|dwelling|house|plot|bed)/); if (m) b.units = +m[1];
  if (/\brc\b|reinforced concrete|concrete frame|in[\s-]situ/.test(t)) b.frame = 'rc'; else if (/steel[\s-]frame|steel portal|portal frame|structural steel/.test(t)) b.frame = 'steel'; else if (/timber[\s-]frame|clt|cross[\s-]laminated|sips/.test(t)) b.frame = 'timber'; else if (/masonry|brick and block|blockwork|traditional/.test(t)) b.frame = 'masonry';
  if (/pil(e|ing)/.test(t)) b.foundations = 'piled'; else if (/\braft\b/.test(t)) b.foundations = 'raft'; else if (/strip found|trench fill/.test(t)) b.foundations = 'strip';
  if (/curtain wall|glazed facade|unitised/.test(t)) b.envelope = 'curtain_wall'; else if (/cladding|rainscreen|composite panel|metal panel/.test(t)) b.envelope = 'cladding'; else if (/brick/.test(t)) b.envelope = 'brick'; else if (/\brender/.test(t)) b.envelope = 'render';
  if (/flat roof|single ply|green roof|membrane roof/.test(t)) b.roof = 'flat'; else if (/pitched|tiled roof|slate|trusses/.test(t)) b.roof = 'pitched';
  if (/shell (and|&) core|shell-and-core/.test(t)) b.fit_out = 'shell'; else if (/cat ?a\b|basic fit/.test(t)) b.fit_out = 'basic';
  b.basement = /basement|undercroft/.test(t); b.demolition = /demoli|strip[\s-]out|knock down|clearance of (the )?existing/.test(t);
  b.service_diversion = /diver(t|sion)|\bkv\b|live cable|gas main|water main|utility/.test(t); b.contaminated_ground = /contaminat|remediat|brownfield|asbestos|made ground/.test(t);
  b.external_works = !/no external works|excluding externals/.test(t); b.six_day_week = /six[\s-]day|6[\s-]day|saturday/.test(t);
  m = text.match(/\b(?:in|at|near)\s+([A-Z][a-z]+(?:\s[A-Z][a-z]+)?)/); if (m) b.location = m[1];
  let prevEnd = 0;
  for (const [pos, dt] of findDates(text)) { const before = t.slice(Math.max(prevEnd, pos - 40), pos); prevEnd = pos + 6;
    if (/start|commenc|possession|mobilis|on site|begin/.test(before)) b.start_date = b.start_date || dt;
    else if (/handover|complet|finish|deadline|by|before|open|occupy|deliver|christmas|end/.test(before + ' ' + dt)) b.deadline = b.deadline || dt;
    else if (/planning|condition|discharg/.test(before)) b.planning_condition_date = dt;
    else if (!b.start_date) b.start_date = dt; else if (!b.deadline) b.deadline = dt;
  }
  m = text.match(/\s*([^.\n]{8,80})/); if (m) { let n = m[1].trim().replace(/,+$/, '').slice(0, 60); b.name = n.charAt(0).toUpperCase() + n.slice(1); }
  return b;
}
function defaults(b) {
  b = Object.assign({}, b);
  if (!b.gross_internal_area_m2) { const per = DEFAULT_GIA[b.building_type]; b.gross_internal_area_m2 = (b.units && ['houses', 'apartments'].includes(b.building_type)) ? per * b.units : per * (['office', 'generic'].includes(b.building_type) ? b.storeys : 1); }
  if (b.storeys < 1) b.storeys = 1;
  if (!b.frame) b.frame = ['house', 'houses'].includes(b.building_type) ? 'masonry' : ['warehouse', 'office'].includes(b.building_type) ? 'steel' : (b.storeys >= 4 || b.building_type === 'apartments') ? 'rc' : 'masonry';
  if (!b.foundations) b.foundations = (b.storeys >= 4 || b.contaminated_ground || b.basement) ? 'piled' : b.building_type === 'warehouse' ? 'raft' : 'strip';
  if (!b.envelope) b.envelope = b.building_type === 'warehouse' ? 'cladding' : (b.building_type === 'office' && b.storeys >= 5) ? 'curtain_wall' : 'brick';
  if (!b.roof) b.roof = (['house', 'houses'].includes(b.building_type) || (b.frame === 'masonry' && b.storeys <= 3)) ? 'pitched' : 'flat';
  if (!b.start_date) { const t = new Date(); const off = (7 - dow(t)) % 7 || 7; b.start_date = YMD(addDays(t, off)); }
  return b;
}
function bround(x){const fl=Math.floor(x);const fr=x-fl;if(Math.abs(fr-0.5)<1e-9)return fl%2===0?fl:fl+1;return Math.round(x);}
const gdays = (x, lo = 1) => Math.max(lo, bround(x * 2) / 2);
const commas = n => n.toLocaleString('en-GB', { maximumFractionDigits: 0 });

function generate(brief) {
  const b = defaults(brief), R = RATES;
  const acts = [], wbs = []; let n = 990; const assumptions = [];
  const cal = b.six_day_week ? 'six_day' : 'standard';
  const nid = () => { n += 10; return 'A' + n; };
  const add = (name, w, days, preds = [], trade = '', atype = 'task', calendar = null, crew = 0) => { const aid = nid(); const links = (preds || []).map(x => typeof x === 'string' ? { predecessor_id: x, type: 'FS', lag_days: 0 } : { predecessor_id: x[0], type: x[1], lag_days: x[2] }); acts.push({ id: aid, name, wbs_code: w, type: atype, duration_days: atype !== 'task' ? 0 : gdays(days), calendar: calendar || cal, predecessors: links, trade, crew_size: crew, codes: {} }); return aid; };
  const chain = (name, w, total, preds, trade, zones) => { if (zones <= 1) { const a = add(name, w, total, preds, trade); return [[a], a]; } const per = total / zones; const ids = []; for (let z = 0; z < zones; z++) { const pr = z === 0 ? preds : [ids[ids.length - 1]]; ids.push(add(`${name} - zone ${z + 1}`, w, per, pr, trade)); } return [ids, ids[ids.length - 1]]; };
  const gia = b.gross_internal_area_m2, storeys = b.storeys, footprint = gia / storeys;
  const zones = Math.max(1, Math.min(4, Math.ceil(footprint / R.zone_m2)));
  assumptions.push(`Gross internal area ${commas(gia)} m² over ${storeys} storey(s); footprint ${commas(footprint)} m²` + (zones > 1 ? ` split into ${zones} zones for trade flow` : ''));
  assumptions.push(`Frame: ${b.frame}; foundations: ${b.foundations}; envelope: ${b.envelope}; roof: ${b.roof}; fit-out: ${b.fit_out}`);
  assumptions.push('Working week ' + (b.six_day_week ? 'Monday to Saturday' : 'Monday to Friday') + ', 8 hours, UK bank holidays non-working');
  assumptions.push('Durations from the RATES production table; single gang per trade unless zoned');
  const wnames = ['Enabling works', 'Substructure', 'Frame and upper floors', 'Roof and envelope', 'Internal fit-out', 'External works', 'Commissioning and handover'];
  wnames.forEach((w, i) => wbs.push({ code: String(i + 1), name: w }));
  const W = {}; wnames.forEach((w, i) => W[w] = String(i + 1));
  const start = add('Start on site', W['Enabling works'], 0, [], '', 'start_milestone');
  const setup = add('Site set-up, welfare, hoarding and temporary works', W['Enabling works'], R.site_setup_base + R.site_setup_per_1000m2 * footprint / 1000, [start], 'Groundworks gang', 'task', null, 3);
  let enabling = [setup];
  if (b.service_diversion) { enabling.push(add('Service diversions and temporary supplies', W['Enabling works'], R.service_diversion_days, [start], 'Utilities contractor')); assumptions.push('Statutory undertaker diversions assumed 15 working days once on site; confirm with DNO/water'); }
  if (b.demolition) enabling = [add('Soft strip and demolition', W['Enabling works'], footprint / R.demolition_m2_per_day + 3, enabling, 'Demolition contractor', 'task', null, 4)];
  if (b.contaminated_ground) enabling = [add('Ground remediation and validation', W['Enabling works'], footprint / R.remediation_m2_per_day + 5, enabling, 'Remediation contractor')];
  let dig = add('Strip topsoil and reduce levels', W['Enabling works'], footprint / R.reduce_level_m2_per_day + 1, enabling, 'Groundworks gang', 'task', null, 3);
  const S = W['Substructure']; let found;
  if (b.basement) dig = add('Basement excavation, propping and retaining walls', S, footprint / R.basement_m2_per_day, [dig], 'Groundworks gang', 'task', null, 6);
  if (b.foundations === 'piled') { const piles = Math.ceil(footprint / R.m2_per_pile); const pil = add(`Piling (${piles} piles)`, S, piles / R.piles_per_day + 2, [dig], 'Piling contractor', 'task', null, 4); found = add('Pile caps and ground beams', S, footprint / R.pile_caps_m2_per_day + 4, [[pil, 'SS', 5], pil], 'Groundworks gang', 'task', null, 4); assumptions.push(`${piles} CFA piles at one per ${R.m2_per_pile} m² of footprint, ${R.piles_per_day} per rig-day`); }
  else if (b.foundations === 'raft') found = add('Raft foundation (formwork, rebar, pour)', S, footprint / R.raft_m2_per_day + 4, [dig], 'Groundworks gang', 'task', null, 5);
  else { const exc = add('Excavate and pour strip foundations', S, footprint / R.strip_found_m2_per_day + 2, [dig], 'Groundworks gang', 'task', null, 4); const insp = add('Building control inspection - foundations', S, 1, [[exc, 'SS', Math.max(1, footprint / R.strip_found_m2_per_day)]], 'Site manager'); found = add('Blockwork to DPC', S, footprint / 90 + 3, [exc, insp], 'Bricklayers', 'task', null, 4); }
  const cure = add('Concrete cure', S, R.rc_cure_days, [found], '', 'task', 'seven_day');
  const drain = add('Below-ground drainage', S, footprint / R.drainage_m2_per_day + 2, [dig], 'Groundworks gang', 'task', null, 3);
  const slab = add('Ground floor slab, DPM and insulation', S, footprint / R.ground_slab_m2_per_day + 2, [cure, drain], 'Groundworks gang', 'task', null, 4);
  const subDone = add('Substructure complete', S, 0, [slab], '', 'finish_milestone');
  const F = W['Frame and upper floors']; const frameIds = []; let prev = subDone;
  for (let lvl = 0; lvl < storeys; lvl++) {
    const label = lvl === 0 ? 'ground floor' : `level ${lvl}`;
    if (b.frame === 'rc') { const cols = add(`RC columns and walls - ${label}`, F, footprint / R.frame_rc_m2_per_day + 2, [prev], 'RC frame contractor', 'task', null, 8); const deck = add(`Suspended slab formwork, rebar and pour - ${label}`, F, footprint / R.frame_rc_m2_per_day + 3, [cols], 'RC frame contractor', 'task', null, 8); prev = add(`Slab cure - ${label}`, F, R.rc_cure_days, [deck], '', 'task', 'seven_day'); }
    else if (b.frame === 'steel') { if (lvl === 0) { prev = add('Steel frame erection (all levels)', F, gia / R.frame_steel_m2_per_day + 4, [prev], 'Steel erectors', 'task', null, 6); assumptions.push('Steel frame erected in one continuous visit; decking and concrete floors follow floor by floor'); } if (lvl > 0) prev = add(`Metal decking and concrete topping - ${label}`, F, footprint / R.steel_deck_m2_per_day + 2, lvl === 1 ? [prev] : [[prev, 'FS', 0]], 'Decking contractor', 'task', null, 4); }
    else if (b.frame === 'timber') prev = add(`Timber frame panels and floor cassettes - ${label}`, F, footprint / R.frame_timber_m2_per_day + 1, [prev], 'Timber frame erectors', 'task', null, 5);
    else { const lift = add(`Brick and block to ${lvl === 0 ? 'first floor' : lvl + 1 < storeys ? 'level ' + (lvl + 1) : 'wall plate'}`, F, footprint / R.frame_masonry_m2_per_day, [prev], 'Bricklayers', 'task', null, 6); prev = lvl + 1 < storeys ? add(`Floor joists or precast planks - level ${lvl + 1}`, F, footprint / 300 + 2, [lift], 'Carpenters', 'task', null, 3) : lift; }
    frameIds.push(prev);
  }
  const frameDone = add('Frame complete', F, 0, [prev], '', 'finish_milestone');
  const En = W['Roof and envelope'];
  const roof = add('Roof structure' + (b.roof === 'pitched' ? ' and trusses' : ' and screed to falls'), En, footprint / R.roof_m2_per_day + 3, [frameDone], b.roof === 'pitched' ? 'Roofers' : 'Roofing contractor', 'task', null, 4);
  const roofCover = add('Roof covering' + (b.roof === 'pitched' ? ' (felt, batten, tile)' : ' (membrane and insulation)'), En, footprint / R.roof_m2_per_day + 2, [roof], 'Roofers', 'task', null, 4);
  const envRate = R['envelope_' + b.envelope + '_m2_per_day']; const perim = 4 * Math.sqrt(footprint); const wallPer = perim * 3.2;
  const envIds = []; let envPrev = null;
  for (let lvl = 0; lvl < storeys; lvl++) { const label = lvl === 0 ? 'ground floor' : `level ${lvl}`; const preds = b.frame !== 'masonry' ? [frameIds[Math.min(lvl + 1, storeys - 1)]] : [frameDone]; if (envPrev) preds.push(envPrev); envPrev = add(`External envelope (${b.envelope.replace(/_/g, ' ')}) - ${label}`, En, wallPer / envRate + 1, preds, ['brick', 'render'].includes(b.envelope) ? 'Bricklayers' : 'Cladding contractor', 'task', null, 6); envIds.push(envPrev); }
  if (b.frame === 'masonry') assumptions.push('Masonry frame: external leaf built with the structure, envelope activities cover pointing, cavity closers and render/brick feature work');
  const windows = add('Windows, curtain walling and external doors', En, R.windows_base + R.windows_per_storey * storeys, [envIds[envIds.length - 1]], 'Window fitters', 'task', null, 3);
  const rwg = add('Fascias, soffits and rainwater goods', En, footprint / 200 + 2, [roofCover], 'Roofers');
  const watertight = add('Watertight', En, 0, [roofCover, windows, envIds[envIds.length - 1]], '', 'finish_milestone');
  const strike = add('Strike scaffold', En, 2 + storeys, [rwg, windows, envIds[envIds.length - 1]], 'Scaffolders');
  const I = W['Internal fit-out']; let lastSecond = []; const prevFloor = {};
  if (b.fit_out !== 'shell') {
    for (let lvl = 0; lvl < storeys; lvl++) {
      const label = lvl === 0 ? 'ground floor' : `level ${lvl}`, area = footprint;
      const stage = (key, name, rk, preds, trade) => { const p = preds.slice(); if (key in prevFloor) p.push(prevFloor[key]); const [ids, last] = chain(`${name} - ${label}`, I, area / R[rk], p, trade, zones); prevFloor[key] = last; return last; };
      const ffPred = lvl === storeys - 1 ? [watertight] : [frameIds[Math.min(lvl + 1, storeys - 1)], envIds[lvl]];
      const carp = stage('carp1', 'First fix carpentry and partitions', 'first_fix_m2_per_day', ffPred, 'Carpenters');
      const mep1 = stage('mep1', 'First fix mechanical and electrical', 'first_fix_m2_per_day', [carp], 'M&E contractor');
      const dry = stage('dry', 'Drylining, plastering and ceilings', 'drylining_m2_per_day', [carp, mep1], 'Dryliners');
      let base;
      if (b.fit_out === 'full') { const scr = stage('screed', 'Screed', 'screed_m2_per_day', [dry], 'Screeders'); const dryOut = add(`Drying out - ${label}`, I, 5, [scr, dry], '', 'task', 'seven_day'); base = [dryOut]; } else base = [dry];
      const carp2 = stage('carp2', 'Second fix carpentry, doors and joinery', 'second_fix_m2_per_day', base, 'Carpenters');
      const mep2 = stage('mep2', 'Second fix mechanical and electrical', 'second_fix_m2_per_day', [carp2], 'M&E contractor');
      if (b.fit_out === 'full') { let decPred; if (['house', 'houses', 'apartments'].includes(b.building_type)) { const kit = stage('kit', 'Kitchens, bathrooms and tiling', 'second_fix_m2_per_day', [carp2, mep2], 'Kitchen and bathroom fitters'); decPred = [kit, mep2]; } else decPred = [carp2, mep2]; const dec = stage('dec', 'Decoration', 'decoration_m2_per_day', decPred, 'Decorators'); const fin = stage('fin', 'Floor finishes', 'finishes_m2_per_day', [dec], 'Floor layers'); lastSecond.push(fin, mep2); } else lastSecond.push(carp2, mep2);
    }
  } else { assumptions.push('Shell and core only: no internal fit-out beyond first fix of landlord services'); lastSecond = [add('Landlord services and core fit-out', I, gia / R.first_fix_m2_per_day + 5, [watertight], 'M&E contractor', 'task', null, 4)]; }
  const X = W['External works']; let extIds = [];
  if (b.external_works) { const e1 = add('External drainage, services connections and paving', X, R.externals_base + footprint / R.externals_m2_per_day, [strike], 'Groundworks gang', 'task', null, 4); const e2 = add('Roads, car parking, fencing and landscaping', X, R.externals_base + footprint / R.externals_m2_per_day, [e1], 'Groundworks gang', 'task', null, 4); extIds = [e2]; } else { assumptions.push('External works excluded from this programme'); extIds = [strike]; }
  const Cw = W['Commissioning and handover'];
  const power = add('Power on', Cw, 0, [lastSecond.length ? lastSecond[lastSecond.length - 1] : watertight], '', 'finish_milestone');
  const comm = add('Testing, commissioning and O&M manuals', Cw, R.commissioning_base + R.commissioning_per_storey * storeys, [power, ...lastSecond], 'M&E contractor', 'task', null, 3);
  const bc = add('Building control completion and certificates', Cw, 2, [comm, ...extIds, ...(extIds.includes(strike) ? [] : [strike])], 'Site manager');
  const snag = add('Snagging, builder\'s clean and client inspections', Cw, R.snagging_days, [bc], 'Site manager', 'task', null, 4);
  add('Practical completion', Cw, 0, [snag], '', 'finish_milestone');
  const constraints = [];
  if (b.planning_condition_date) constraints.push({ activity_id: dig, type: 'start_on_or_after', date: b.planning_condition_date, reason: 'Pre-commencement planning conditions' });
  const questions = ['Confirm gross internal area and storey heights from the drawings', 'Confirm procurement lead-ins for frame, windows and M&E plant (not modelled as activities)', 'Is a phased handover acceptable?'];
  if (b.deadline) questions.push('Is the completion date contractual (LADs) or a target?');
  const pid = (b.location || b.building_type).replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').toUpperCase().slice(0, 8) || 'PROJ';
  acts.forEach(a => { const w = wbs.find(w => w.code === a.wbs_code); a.codes = { Phase: w ? w.name : '', Trade: a.trade || 'None' }; });
  const yy = b.start_date.slice(2, 4) + b.start_date.slice(5, 7);
  return { project_id: `${pid}-${yy}`, project_name: b.name, start_date: b.start_date, must_finish_by: b.deadline || null, wbs, activities: acts, constraints, assumptions, questions_for_client: questions, summary: `Generated programme: ${acts.length} activities, ${storeys}-storey ${b.building_type} of ${commas(gia)} m², ${b.frame} frame on ${b.foundations} foundations.` };
}

const PALETTE = ['#4e79a7', '#f28e2b', '#59a14f', '#e15759', '#76b7b2', '#edc948', '#b07aa1', '#ff9da7', '#9c755f', '#bab0ac', '#1f77b4', '#2ca02c', '#d62728', '#9467bd', '#8c564b', '#e377c2', '#17becf', '#bcbd22'];
function draftToProject(draft, description = '') {
  const start = parseDate(draft.start_date) || ISO(new Date());
  const pid = (draft.project_id || '').replace(/[^A-Za-z0-9-]+/g, '-').replace(/^-|-$/g, '').slice(0, 12) || 'PROJ';
  const p = { id: pid, name: draft.project_name, start, data_date: start, must_finish_by: parseDate(draft.must_finish_by, 16), default_calendar_id: 'standard', calendars: {}, wbs: [], activities: [], relationships: [], resources: [], assignments: [], description, assumptions: (draft.assumptions || []).slice(), code_types: {}, baselines: [], levelled: false, finish: null, scheduled_at: null };
  ensureCalendars(p);
  (draft.wbs || []).forEach((w, i) => p.wbs.push({ id: w.code, code: w.code, name: w.name, parent_id: w.parent_code || null, seq: i }));
  const knownW = new Set(p.wbs.map(w => w.id)); const trades = {};
  for (const a of draft.activities) {
    const cal = new E.Cal(p.calendars[a.calendar]);
    const act = { id: a.id.trim(), name: a.name.trim(), wbs_id: knownW.has(a.wbs_code) ? a.wbs_code : null, calendar_id: a.calendar, type: a.type, duration_hours: a.type !== 'task' ? 0 : cal.days_to_hours(Math.max(0, a.duration_days)), constraint: 'none', constraint_date: null, status: 'not_started', actual_start: null, actual_finish: null, remaining_hours: null, percent_complete: 0, baseline_start: null, baseline_finish: null, early_start: null, early_finish: null, late_start: null, late_finish: null, total_float_hours: null, free_float_hours: null, critical: false, notes: a.rationale || '', codes: Object.assign({}, a.codes), priority: 500, level_delay_hours: 0 };
    p.activities.push(act);
    if (a.trade) { const rid = a.trade.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '').toUpperCase().slice(0, 20); if (!trades[rid]) trades[rid] = { id: rid, name: a.trade, type: 'labour', unit: 'h', rate: 32, max_units_per_day: a.crew_size || null, colour: null }; else if (a.crew_size && (trades[rid].max_units_per_day || 0) < a.crew_size) trades[rid].max_units_per_day = a.crew_size; p.assignments.push({ activity_id: act.id, resource_id: rid, units: act.duration_hours * (a.crew_size || 1), cost: 0, actual_cost: 0 }); }
  }
  p.resources = Object.values(trades);
  for (const act of p.activities) for (const [ct, val] of Object.entries(act.codes)) { const vals = p.code_types[ct] = p.code_types[ct] || {}; if (!(val in vals)) vals[val] = PALETTE[Object.keys(vals).length % PALETTE.length]; }
  const ids = new Set(p.activities.map(a => a.id));
  for (const a of draft.activities) { const pcal = new E.Cal(p.calendars[a.calendar]); for (const l of a.predecessors || []) if (ids.has(l.predecessor_id) && l.predecessor_id !== a.id) p.relationships.push({ predecessor_id: l.predecessor_id, successor_id: a.id, type: l.type, lag_hours: pcal.days_to_hours(l.lag_days) }); }
  const am = amap(p);
  for (const c of draft.constraints || []) if (ids.has(c.activity_id)) { const act = am[c.activity_id]; act.constraint = c.type; act.constraint_date = parseDate(c.date, c.type.includes('finish') ? 16 : 8); if (c.reason) act.notes = (act.notes ? act.notes + ' | ' : '') + 'Constraint: ' + c.reason; }
  dedupeLinks(p);
  return p;
}
function dedupeLinks(p) { const seen = new Set(), out = []; for (const r of p.relationships) { const k = r.predecessor_id + '|' + r.successor_id + '|' + r.type; if (!seen.has(k)) { seen.add(k); out.push(r); } } p.relationships = out; }

// ---------- levelling ----------
function dailyDemand(p, a) { const cal = calFor(p, a); if (cal.hours_to_days(a.duration_hours) <= 0) return {}; const out = {}; for (const x of p.assignments) if (x.activity_id === a.id && x.units > 0) out[x.resource_id] = (out[x.resource_id] || 0) + x.units / a.duration_hours; return out; }
function level(p) {
  schedule(p);
  const limits = {}; p.resources.forEach(r => { if (r.max_units_per_day) limits[r.id] = r.max_units_per_day; });
  if (!Object.keys(limits).length) { p.levelled = false; return p; }
  const m = amap(p), usage = {}, preds = {}, succs = {}, indeg = {};
  p.activities.forEach(a => { preds[a.id] = []; succs[a.id] = []; indeg[a.id] = 0; });
  for (const r of p.relationships) { preds[r.successor_id].push(r); succs[r.predecessor_id].push(r); indeg[r.successor_id]++; }
  const ready = p.activities.filter(a => indeg[a.id] === 0).map(a => ({ k: D(a.late_start || a.early_start || p.start).getTime(), pr: a.priority, id: a.id }));
  const pop = () => { let bi = 0; for (let i = 1; i < ready.length; i++) if (ready[i].k < ready[bi].k || (ready[i].k === ready[bi].k && ready[i].pr < ready[bi].pr)) bi = i; return ready.splice(bi, 1)[0]; };
  const done = {}, dataDate = D(p.data_date) || D(p.start);
  while (ready.length) {
    const { id: aid } = pop(); const a = m[aid], cal = calFor(p, a), origEs = D(a.early_start); let start, finish;
    if (a.status === 'complete' || a.status === 'in_progress') { start = D(a.early_start); finish = D(a.early_finish); }
    else {
      let floor = cal.next_working_start(D(p.start) > dataDate ? D(p.start) : dataDate), efFloor = null;
      for (const r of preds[aid]) { const pr = m[r.predecessor_id], pcal = calFor(p, pr); const dd = done[pr.id] || [D(pr.early_start), D(pr.early_finish)]; const ps = dd[0], pf = dd[1]; if (r.type === 'FS') { const t = pcal.add_hours(pf, r.lag_hours); if (t > floor) floor = t; } else if (r.type === 'SS') { const t = pcal.add_hours(ps, r.lag_hours); if (t > floor) floor = t; } else if (r.type === 'FF') { const t = pcal.add_hours(pf, r.lag_hours); efFloor = efFloor === null || t > efFloor ? t : efFloor; } else { const t = pcal.add_hours(ps, r.lag_hours); efFloor = efFloor === null || t > efFloor ? t : efFloor; } }
      if (a.constraint_date && ['start_on_or_after', 'must_start_on'].includes(a.constraint)) { const cd = D(a.constraint_date); if (cd > floor) floor = cd; }
      const es0 = D(a.early_start) || floor; start = cal.next_working_start(floor > es0 ? floor : es0);
      const rem = a.duration_hours; finish = rem > 0 ? cal.add_hours(start, rem) : start;
      if (efFloor && efFloor > finish) { finish = rem > 0 ? efFloor : cal.prev_working_end(efFloor); start = rem > 0 ? cal.add_hours(finish, -rem) : finish; }
      const demand = {}; for (const [rid, u] of Object.entries(dailyDemand(p, a))) if (rid in limits) demand[rid] = u;
      if (Object.keys(demand).length && rem > 0) {
        for (let guard = 0; guard < 5000; guard++) {
          let conflict = null; let d = dateOnly(start); const end = dateOnly(finish);
          while (d <= end) { if (cal.is_working(d)) { for (const [rid, u] of Object.entries(demand)) { const key = YMD(d); if ((usage[rid] && usage[rid][key] || 0) + u > limits[rid] + EPS) { conflict = new Date(d); break; } } } if (conflict) break; d = addDays(d, 1); }
          if (!conflict) break;
          start = cal.next_working_start(new Date(dateOnly(addDays(conflict, 1)))); finish = cal.add_hours(start, rem);
        }
        let d = dateOnly(start); const end = dateOnly(finish);
        while (d <= end) { if (cal.is_working(d)) for (const [rid, u] of Object.entries(demand)) { usage[rid] = usage[rid] || {}; const key = YMD(d); usage[rid][key] = (usage[rid][key] || 0) + u; } d = addDays(d, 1); }
      }
    }
    done[aid] = [start, finish]; a.level_delay_hours = origEs ? Math.round(cal.hours_between(origEs, start) * 100) / 100 : 0;
    a.early_start = ISO(start); a.early_finish = ISO(finish);
    for (const r of succs[aid]) { if (--indeg[r.successor_id] === 0) { const s = m[r.successor_id]; ready.push({ k: D(s.late_start || s.early_start || p.start).getTime(), pr: s.priority, id: s.id }); } }
  }
  let fin = null; for (const a of p.activities) { const f = D(a.early_finish); if (f && (!fin || f > fin)) fin = f; } p.finish = ISO(fin || D(p.start));
  for (const a of p.activities) if (a.late_finish && a.early_finish) { const cal = calFor(p, a); a.total_float_hours = Math.round(cal.hours_between(D(a.early_finish), D(a.late_finish)) * 1e4) / 1e4; a.critical = a.total_float_hours <= EPS; }
  p.levelled = true; return p;
}
function unlevel(p) { p.activities.forEach(a => a.level_delay_hours = 0); p.levelled = false; return schedule(p); }
function setBaseline(p, name = 'Baseline') { schedule(p); const bl = { name, saved_at: ISO(new Date()), finish: p.finish, dates: {} }; for (const a of p.activities) { const s = a.actual_start || a.early_start, f = a.actual_finish || a.early_finish; bl.dates[a.id] = { start: s, finish: f, duration_hours: a.duration_hours }; a.baseline_start = s; a.baseline_finish = f; } p.baselines = p.baselines.filter(b => b.name !== name).concat([bl]); return bl; }
function useBaseline(p, name) { const bl = p.baselines.find(b => b.name === name); if (!bl) return false; for (const a of p.activities) { const d = bl.dates[a.id]; a.baseline_start = d && d.start || null; a.baseline_finish = d && d.finish || null; } return true; }
function clearBaseline(p) { p.activities.forEach(a => { a.baseline_start = null; a.baseline_finish = null; }); }

// ---------- analysis ----------
function workingDaysList(p, a) { const s = D(a.actual_start || a.early_start), f = D(a.actual_finish || a.early_finish); if (!s || !f) return []; const cal = calFor(p, a); const out = []; let d = dateOnly(s); const end = dateOnly(f); const [ds] = cal._shift(dateOnly(f)); while (d <= end) { if (cal.is_working(d) && (YMD(d) !== YMD(f) || f > ds)) out.push(new Date(d)); d = addDays(d, 1); } return out.length ? out : [dateOnly(s)]; }
const weekOf = d => { const x = dateOnly(d); return addDays(x, -dow(x)); };
function activityCost(p, a) { const rates = {}; p.resources.forEach(r => rates[r.id] = r.rate); let t = 0; for (const x of p.assignments) if (x.activity_id === a.id) t += x.cost ? x.cost : x.units * (rates[x.resource_id] || 0); return t; }
function histogram(p, resourceId) {
  const perRes = {};
  for (const a of p.activities) { const dem = dailyDemand(p, a); if (!Object.keys(dem).length) continue; const days = workingDaysList(p, a); for (const d of days) for (const [rid, u] of Object.entries(dem)) { perRes[rid] = perRes[rid] || {}; const k = YMD(d); perRes[rid][k] = (perRes[rid][k] || 0) + u; } }
  const limits = {}, names = {}; p.resources.forEach(r => { limits[r.id] = r.max_units_per_day; names[r.id] = r.name; });
  const out = [];
  for (const [rid, series] of Object.entries(perRes)) { if (resourceId && rid !== resourceId) continue; const rows = Object.entries(series).sort().map(([d, u]) => ({ date: d, units: Math.round(u * 100) / 100 })); const over = rows.filter(r => limits[rid] && r.units > limits[rid] + 1e-6); const vals = Object.values(series); out.push({ resource_id: rid, name: names[rid] || rid, limit: limits[rid] ?? null, days: rows, peak: vals.length ? Math.round(Math.max(...vals) * 100) / 100 : 0, overallocated_days: over.length, total_units: Math.round(vals.reduce((a, b) => a + b, 0) * 10) / 10 }); }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return { resources: out };
}
function costCurve(p) {
  const dataDate = dateOnly(D(p.data_date) || D(p.start));
  const wp = {}, wb = {}, we = {}, wa = {}; let budget = 0, bcws = 0, bcwp = 0, acwp = 0;
  const bump = (o, k, v) => o[k] = (o[k] || 0) + v;
  for (const a of p.activities) {
    const cost = activityCost(p, a); if (cost <= 0) continue; budget += cost;
    const days = workingDaysList(p, a); if (days.length) { const per = cost / days.length; for (const d of days) bump(wp, +weekOf(d), per); }
    if (a.baseline_start && a.baseline_finish) { const cal = calFor(p, a); const bdays = []; let d = dateOnly(D(a.baseline_start)); const end = dateOnly(D(a.baseline_finish)); while (d <= end) { if (cal.is_working(d)) bdays.push(new Date(d)); d = addDays(d, 1); } if (bdays.length) { const per = cost / bdays.length; for (const d of bdays) { bump(wb, +weekOf(d), per); if (d <= dataDate) bcws += per; } } }
    else { for (const d of days) if (d <= dataDate) bcws += cost / days.length; }
    const pc = a.status === 'complete' ? 100 : a.percent_complete; const earned = cost * pc / 100; bcwp += earned;
    if (earned > 0 && days.length) { const dd = days.filter(d => d <= dataDate); const list = dd.length ? dd : days.slice(0, 1); const per = earned / list.length; for (const d of list) bump(we, +weekOf(d), per); }
    const actual = p.assignments.filter(x => x.activity_id === a.id).reduce((t, x) => t + (x.actual_cost || 0), 0); acwp += actual;
    if (actual > 0 && days.length) { const dd = days.filter(d => d <= dataDate); const list = dd.length ? dd : days.slice(0, 1); for (const d of list) bump(wa, +weekOf(d), actual / list.length); }
  }
  const weeks = [...new Set([...Object.keys(wp), ...Object.keys(wb), ...Object.keys(we), ...Object.keys(wa)].map(Number))].sort((a, b) => a - b);
  const rows = []; let cp = [0, 0, 0, 0];
  for (const w of weeks) { cp[0] += wp[w] || 0; cp[1] += wb[w] || 0; cp[2] += we[w] || 0; cp[3] += wa[w] || 0; rows.push({ week: YMD(new Date(w)), planned: Math.round(cp[0]), baseline: Math.round(cp[1]), earned: Math.round(cp[2]), actual: Math.round(cp[3]) }); }
  const metrics = { budget: Math.round(budget), bcws: Math.round(bcws), bcwp: Math.round(bcwp), acwp: Math.round(acwp), spi: bcws ? Math.round(bcwp / bcws * 100) / 100 : null, cpi: acwp ? Math.round(bcwp / acwp * 100) / 100 : null, sv: Math.round(bcwp - bcws), cv: acwp ? Math.round(bcwp - acwp) : null, data_date: YMD(dataDate) };
  return { weeks: rows, metrics, has_baseline: p.activities.some(a => a.baseline_start) };
}
function variance(p) { const out = []; for (const a of p.activities) { if (!a.baseline_finish) continue; const cal = calFor(p, a); const f = D(a.actual_finish || a.early_finish), s = D(a.actual_start || a.early_start); out.push({ id: a.id, name: a.name, start_variance_days: a.baseline_start && s ? Math.round(cal.hours_to_days(cal.hours_between(D(a.baseline_start), s)) * 10) / 10 : null, finish_variance_days: f ? Math.round(cal.hours_to_days(cal.hours_between(D(a.baseline_finish), f)) * 10) / 10 : null }); } return out; }

// ---------- repair ----------
function reaches(p, src, dst) { const seen = new Set(), st = [src]; while (st.length) { const n = st.pop(); if (n === dst) return true; if (seen.has(n)) continue; seen.add(n); succsOf(p, n).forEach(r => st.push(r.successor_id)); } return false; }
function planRepairs(p, report) {
  const ops = [], notes = [], stillOpen = []; const m = amap(p); const order = p.activities.map(a => a.id); const pos = {}; order.forEach((id, i) => pos[id] = i);
  const starts = p.activities.filter(a => a.type === 'start_milestone'), finishes = p.activities.filter(a => a.type === 'finish_milestone');
  let startMs = starts.length ? starts[0].id : null, finishMs = finishes.length ? finishes[finishes.length - 1].id : null;
  const incomplete = p.activities.filter(a => a.status !== 'complete' && a.type !== 'level_of_effort');
  if (!startMs && incomplete.length) { startMs = 'A0000'; ops.push({ op: 'add_activity', activity_id: startMs, name: 'Start', activity_type: 'start_milestone', wbs_code: p.activities[0].wbs_id, reason: 'No start milestone existed' }); notes.push('added a start milestone'); }
  if (!finishMs && incomplete.length) { finishMs = 'A9999'; ops.push({ op: 'add_activity', activity_id: finishMs, name: 'Finish', activity_type: 'finish_milestone', wbs_code: p.activities[p.activities.length - 1].wbs_id, reason: 'No finish milestone existed' }); notes.push('added a finish milestone'); }
  for (const a of incomplete) {
    if (a.id === startMs || a.id === finishMs) continue;
    if (!predsOf(p, a.id).length && a.type !== 'start_milestone') { let prev = null; for (let j = pos[a.id] - 1; j >= 0; j--) { const cand = p.activities[j]; if (cand.wbs_id === a.wbs_id && cand.id !== a.id && cand.type !== 'level_of_effort' && !reaches(p, a.id, cand.id)) { prev = cand.id; break; } } const target = prev || startMs; if (target && target !== a.id) ops.push({ op: 'add_link', predecessor_id: target, successor_id: a.id, link_type: 'FS', reason: `${a.id} had no predecessor; linked from ${prev ? 'previous activity in its WBS' : 'the start milestone'}` }); }
    if (!succsOf(p, a.id).length && a.type !== 'finish_milestone' && finishMs && finishMs !== a.id) ops.push({ op: 'add_link', predecessor_id: a.id, successor_id: finishMs, link_type: 'FS', reason: `${a.id} had no successor; linked to the finish milestone` });
  }
  for (const r of p.relationships) if (r.lag_hours < 0) ops.push({ op: 'add_link', predecessor_id: r.predecessor_id, successor_id: r.successor_id, link_type: r.type, lag_days: 0, reason: 'Negative lag (lead) removed; DCMA does not allow leads' });
  for (const a of incomplete) if (HARD.has(a.constraint) && a.constraint_date) { const soft = a.constraint === 'must_start_on' ? 'start_on_or_after' : 'finish_on_or_before'; ops.push({ op: 'set_constraint', activity_id: a.id, constraint_type: soft, date: a.constraint_date.slice(0, 10), reason: `Hard constraint on ${a.id} softened to ${soft.replace(/_/g, ' ')}` }); }
  for (const a of incomplete) { if (isMs(a)) continue; const outs = succsOf(p, a.id); if (outs.length && outs.every(r => r.type === 'SS')) { const s = outs[0]; ops.push({ op: 'add_link', predecessor_id: a.id, successor_id: s.successor_id, link_type: 'FF', lag_days: 0, reason: `${a.id} only drove ${s.successor_id} by its start; added FF so its finish matters` }); } const ins = predsOf(p, a.id); if (ins.length && ins.every(r => r.type === 'FF')) { const pr = ins[0]; ops.push({ op: 'add_link', predecessor_id: pr.predecessor_id, successor_id: a.id, link_type: 'SS', lag_days: 0, reason: `${a.id} was only driven on its finish; added SS from ${pr.predecessor_id}` }); } }
  for (const a of incomplete) { if (isMs(a) || a.status !== 'not_started') continue; const cal = calFor(p, a); const days = cal.hours_to_days(a.duration_hours); if (days > 44) { const parts = Math.ceil(days / 44); const per = Math.round(days / parts * 10) / 10; let prev = a.id; ops.push({ op: 'set_duration', activity_id: a.id, duration_days: per, reason: `Split ${a.id} (${Math.round(days)}d) into ${parts} stages` }); ops.push({ op: 'rename', activity_id: a.id, name: `${a.name} - stage 1` }); const succs = succsOf(p, a.id); for (let i = 2; i <= parts; i++) { const nid = `${a.id}-${i}`; ops.push({ op: 'add_activity', activity_id: nid, name: `${a.name} - stage ${i}`, duration_days: per, wbs_code: a.wbs_id, calendar: ['standard', 'six_day', 'seven_day'].includes(a.calendar_id) ? a.calendar_id : null, predecessor_id: prev, link_type: 'FS', reason: 'stage split' }); prev = nid; } for (const s of succs) if (s.type === 'FS' || s.type === 'FF') { ops.push({ op: 'remove_link', predecessor_id: a.id, successor_id: s.successor_id, link_type: s.type }); ops.push({ op: 'add_link', predecessor_id: prev, successor_id: s.successor_id, link_type: s.type, lag_days: cal.hours_to_days(s.lag_hours), reason: 'moved successor link to last stage' }); } } }
  const neg = incomplete.filter(a => a.total_float_hours != null && a.total_float_hours < 0);
  if (neg.length) { const worst = neg.reduce((a, b) => a.total_float_hours <= b.total_float_hours ? a : b); const cal = calFor(p, worst); let cause = p.must_finish_by ? 'the must-finish-by date' : 'a finish constraint'; const con = neg.find(a => ['finish_on_or_before', 'must_finish_on', 'start_on_or_before'].includes(a.constraint)); if (con) cause = `the ${con.constraint.replace(/_/g, ' ')} constraint on ${con.id}`; stillOpen.push(`Negative float of ${Math.round(cal.hours_to_days(worst.total_float_hours))} days against ${cause}. Options: move the date, add resource to critical activities, or re-sequence.`); }
  const byk = {}; report.checks.forEach(c => byk[c.key] = c);
  if (byk.high_float && !byk.high_float.passed) stillOpen.push('High float on ' + byk.high_float.items.slice(0, 6).join(', ') + ': usually missing logic or a very early deadline; review after the links above are added.');
  if (byk.lags && !byk.lags.passed) stillOpen.push('Positive lags exceed 5% of links. Replace the longest with a real activity (cure, drying, approval) if the reviewer is strict.');
  if (byk.resources && byk.resources.applicable && !byk.resources.passed) stillOpen.push("Some activities have no trade assigned; assign with the command 'assign <id> <trade>'.");
  const nLinks = ops.filter(o => o.op === 'add_link').length;
  let msg = ops.length ? `Applied ${ops.length} repair operations (${nLinks} links, ${ops.filter(o => o.op === 'set_constraint').length} constraints softened, ${ops.filter(o => o.op === 'add_activity').length} activities added).` : 'Nothing to repair automatically.';
  if (notes.length) msg += ' ' + notes.join('; ') + '.';
  return { ops, message: msg, still_open: stillOpen };
}

Object.assign(global.PlannerEngine, { RATES, parseBrief, generate, draftToProject, level, unlevel, setBaseline, useBaseline, clearBaseline, histogram, costCurve, variance, planRepairs, dailyDemand });
})(typeof window !== 'undefined' ? window : globalThis);

/* ---- part 4: command language ---- */
(function (global) {
const E = global.PlannerEngine;
const HELP = `add 2 weeks to A1240        extend by 10 days
shorten A1240 by 3d          reduce
set A1240 to 15d             absolute duration
link A1010 -> A1020 SS+2d    add or replace a link
unlink A1010 A1020
rename A1010 New name
delete A1045
insert "Scaffold" 3d after A1040 before A1050
start 2026-05-04             move project start
finish by 1 Nov 2026         set must-finish-by
constrain A1100 start on or after 16 Mar 2026
unconstrain A1100
progress A1010 50% as of 20 Apr 2026
complete A1010 on 24 Apr 2026
data date 2026-04-20
assign A1020 Piling gang
fix                          run the DCMA repairer
help`;
function CommandError(msg) { const e = new Error(msg); e.name = 'CommandError'; return e; }
function cdate(text) { const f = E.parseBrief ? null : null; const found = require_dates(text); if (found.length) return found[0]; const m = String(text).match(/\b(\d{1,2})[\/-](\d{1,2})[\/-](\d{2,4})\b/); if (m) { let y = +m[3] + (+m[3] < 100 ? 2000 : 0); return `${y}-${String(+m[2]).padStart(2,'0')}-${String(+m[1]).padStart(2,'0')}`; } return null; }
// reuse the generator's date finder via a light regex set
const MONTHS2 = {}; ['january','february','march','april','may','june','july','august','september','october','november','december'].forEach((m,i)=>{MONTHS2[m]=i+1;MONTHS2[m.slice(0,3)]=i+1;});
const monthAlt2 = Object.keys(MONTHS2).sort((a,b)=>b.length-a.length).join('|');
function require_dates(text){const t=text.toLowerCase();const out=[];let re=new RegExp('(\\d{1,2})(?:st|nd|rd|th)?\\s+('+monthAlt2+')\\w*\\s+(\\d{4})','g'),m;while((m=re.exec(t)))out.push([m.index,`${m[3]}-${String(MONTHS2[m[2]]).padStart(2,'0')}-${String(+m[1]).padStart(2,'0')}`]);re=/\b(\d{4})-(\d{2})-(\d{2})\b/g;while((m=re.exec(t)))out.push([m.index,`${m[1]}-${m[2]}-${m[3]}`]);out.sort((a,b)=>a[0]-b[0]);return out.map(o=>o[1]);}
function cdays(text) { const m = String(text).match(/(\d+(?:\.\d+)?)\s*(w|wk|wks|week|weeks|d|day|days|h|hr|hrs|hour|hours|m|mo|month|months)?\b/); if (!m) return null; const n = +m[1], u = (m[2] || 'd')[0]; return u === 'w' ? n * 5 : u === 'h' ? n / 8 : u === 'm' ? n * 21 : n; }
function resolve(p, tok) { tok = tok.trim().replace(/^["']|["']$/g, ''); const ids = {}; p.activities.forEach(a => ids[a.id.toLowerCase()] = a.id); if (ids[tok.toLowerCase()]) return ids[tok.toLowerCase()]; const hits = p.activities.filter(a => a.name.toLowerCase().includes(tok.toLowerCase())); if (hits.length === 1) return hits[0].id; if (!hits.length) throw CommandError(`No activity matches '${tok}'.`); throw CommandError(`'${tok}' matches ${hits.length} activities: ` + hits.slice(0, 5).map(a => a.id + ' ' + a.name).join(', ')); }
const hpd = (p, id) => { const a = p.activities.find(x => x.id === id) || {}; const c = p.calendars[a.calendar_id || p.default_calendar_id]; return c ? c.hours_per_day : 8; };
const ID = "(\"[^\"]+\"|'[^']+'|[A-Za-z][A-Za-z0-9_.-]*\\d[A-Za-z0-9_.-]*|[A-Za-z][A-Za-z0-9 _'/-]{2,40}?)";

function parseCommand(p, text) {
  const t = text.trim(), low = t.toLowerCase(); const ops = [];
  const P = (o) => ops.push(o);
  if (low === 'help' || low === '?') return { ops: [], message: HELP };
  if (['fix', 'repair', 'fix it', 'fix the failing checks'].includes(low)) return { ops: [{ op: 'note', reason: '__repair__' }], message: 'repair' };
  let m = t.match(new RegExp('^(add|extend|push|delay)\\s+(.+?)\\s+(?:to|on)\\s+' + ID + '\\s*$', 'i')) || t.match(new RegExp('^(extend|add to|lengthen)\\s+' + ID + '\\s+by\\s+(.+)$', 'i'));
  if (m) { const g = m.slice(1); let amount, aid; if (['add', 'extend', 'push', 'delay'].includes(g[0].toLowerCase()) && g.length === 3 && /\d/.test(g[1])) { amount = g[1]; aid = g[2]; } else { amount = g[2]; aid = g[1]; } aid = resolve(p, aid); const a = p.activities.find(x => x.id === aid); const cur = a.duration_hours / hpd(p, aid); const d = cdays(amount); if (d == null) throw CommandError("How much? e.g. 'add 2 weeks to A1240'"); const nv = cur + d; P({ op: 'set_duration', activity_id: aid, duration_days: nv, reason: t }); return { ops, message: `${aid} ${a.name}: ${g0(cur)}d → ${g0(nv)}d.` }; }
  m = t.match(new RegExp('^(shorten|reduce|cut|shrink)\\s+' + ID + '\\s+by\\s+(.+)$', 'i'));
  if (m) { const aid = resolve(p, m[2]); const a = p.activities.find(x => x.id === aid); const cur = a.duration_hours / hpd(p, aid); const nv = Math.max(0.5, cur - (cdays(m[3]) || 0)); P({ op: 'set_duration', activity_id: aid, duration_days: nv, reason: t }); return { ops, message: `${aid} ${a.name}: ${g0(cur)}d → ${g0(nv)}d.` }; }
  m = t.match(new RegExp('^(?:set\\s+)?' + ID + '\\s*(?:=|to|duration)\\s*(\\d+(?:\\.\\d+)?\\s*[a-z]*)\\s*$', 'i'));
  if (m) { const aid = resolve(p, m[1]); const d = cdays(m[2]); P({ op: 'set_duration', activity_id: aid, duration_days: d, reason: t }); return { ops, message: `${aid} duration set to ${g0(d)}d.` }; }
  m = t.match(new RegExp('^link\\s+' + ID + '\\s*(?:->|to|→)\\s*' + ID + '\\s*(FS|SS|FF|SF)?\\s*([+-]\\s*\\d+(?:\\.\\d+)?\\s*[a-z]*)?\\s*$', 'i'));
  if (m) { const pr = resolve(p, m[1]), s = resolve(p, m[2]); let lag = 0; if (m[4]) lag = (cdays(m[4].replace(/\s/g, '').slice(1)) || 0) * (m[4].trim().startsWith('-') ? -1 : 1); P({ op: 'add_link', predecessor_id: pr, successor_id: s, link_type: (m[3] || 'FS').toUpperCase(), lag_days: lag, reason: t }); return { ops, message: `Linked ${pr} ${(m[3] || 'FS').toUpperCase()}${lag ? (lag > 0 ? '+' : '') + lag + 'd' : ''} ${s}.` }; }
  m = t.match(new RegExp('^unlink\\s+' + ID + '\\s*(?:->|to|from|→|,)?\\s*' + ID + '\\s*$', 'i'));
  if (m) { const pr = resolve(p, m[1]), s = resolve(p, m[2]); P({ op: 'remove_link', predecessor_id: pr, successor_id: s, reason: t }); P({ op: 'remove_link', predecessor_id: s, successor_id: pr, reason: t }); return { ops, message: `Removed links between ${pr} and ${s}.` }; }
  m = t.match(new RegExp('^rename\\s+' + ID + '\\s+(?:to\\s+)?(.+)$', 'i'));
  if (m) { const aid = resolve(p, m[1]); P({ op: 'rename', activity_id: aid, name: m[2].trim().replace(/^["']|["']$/g, ''), reason: t }); return { ops, message: `Renamed ${aid}.` }; }
  m = t.match(new RegExp('^(delete|remove)\\s+' + ID + '\\s*$', 'i'));
  if (m) { const aid = resolve(p, m[2]); P({ op: 'remove_activity', activity_id: aid, reason: t }); return { ops, message: `Removed ${aid}; predecessors were linked straight to successors.` }; }
  m = t.match(new RegExp('^(?:insert|add activity|new)\\s+["\'](.+?)["\']\\s+(\\d+(?:\\.\\d+)?\\s*[a-z]*)\\s*(?:after\\s+' + ID + ')?\\s*(?:before\\s+' + ID + ')?\\s*$', 'i'));
  if (m) { const pred = m[3] ? resolve(p, m[3]) : null, succ = m[4] ? resolve(p, m[4]) : null; const nums = p.activities.map(a => parseInt((a.id.match(/\d+/) || ['0'])[0])); const nid = 'A' + ((nums.length ? Math.max(...nums) : 1000) + 10); const wbs = pred ? (p.activities.find(a => a.id === pred) || {}).wbs_id : succ ? (p.activities.find(a => a.id === succ) || {}).wbs_id : null; P({ op: 'add_activity', activity_id: nid, name: m[1], duration_days: cdays(m[2]), wbs_code: wbs, predecessor_id: pred, successor_id: succ, reason: t }); if (pred && succ) P({ op: 'remove_link', predecessor_id: pred, successor_id: succ, reason: 'inserted between' }); return { ops, message: `Inserted ${nid} '${m[1]}' (${g0(cdays(m[2]))}d)${pred && succ ? ` between ${pred} and ${succ}` : ''}.` }; }
  if (/^(project\s+)?start(s|ing)?(\s+on)?\s+/.test(low)) { const d = cdate(t); if (!d) throw CommandError("Give a date, e.g. 'start 4 May 2026'."); P({ op: 'set_project_start', date: d, reason: t }); return { ops, message: `Project start moved to ${d}.` }; }
  if (/^(must\s+)?(finish|complete|handover|deadline|end)\s*(by|on|before|date)?\s+/.test(low) || low.startsWith('deadline')) { const d = cdate(t); if (!d) throw CommandError("Give a date, e.g. 'finish by 1 Nov 2026'."); P({ op: 'set_must_finish_by', date: d, reason: t }); return { ops, message: `Must finish by ${d}. Float is now measured against that date.` }; }
  m = t.match(/^(?:data\s+date|status\s+date|progress\s+to|update\s+to)\s+(.+)$/i);
  if (m) { const d = cdate(m[1]); if (!d) throw CommandError('Give a date.'); return { ops: [{ op: 'note', reason: '__data_date__' + d }], message: `Data date set to ${d}.` }; }
  m = t.match(new RegExp('^constrain\\s+' + ID + '\\s+(start|finish)\\s+(on or after|on or before|no earlier than|no later than|by|on|before|after)\\s+(.+)$', 'i'));
  if (m) { const aid = resolve(p, m[1]); const d = cdate(m[4]); if (!d) throw CommandError('Give a date.'); const which = m[2].toLowerCase(), how = m[3].toLowerCase(); let ctype; if (how === 'on') ctype = `must_${which}_on`; else if (['on or after', 'no earlier than', 'after'].includes(how)) ctype = `${which}_on_or_after`; else ctype = `${which}_on_or_before`; P({ op: 'set_constraint', activity_id: aid, constraint_type: ctype, date: d, reason: t }); return { ops, message: `${aid}: ${ctype.replace(/_/g, ' ')} ${d}.` }; }
  m = t.match(new RegExp('^unconstrain\\s+' + ID + '\\s*$', 'i'));
  if (m) { const aid = resolve(p, m[1]); P({ op: 'clear_constraint', activity_id: aid, reason: t }); return { ops, message: `Constraint removed from ${aid}.` }; }
  m = t.match(new RegExp('^(?:progress|update)\\s+' + ID + '\\s+(\\d+(?:\\.\\d+)?)\\s*%(?:\\s+(?:as\\s+of|on|at)\\s+(.+))?$', 'i'));
  if (m) { const aid = resolve(p, m[1]); const d = m[3] ? cdate(m[3]) : null; const o = [{ op: 'set_progress', activity_id: aid, percent_complete: +m[2], actual_start: null, reason: t }]; let msg = `${aid} marked ${m[2]}% complete.`; if (d) { o.unshift({ op: 'note', reason: '__data_date__' + d }); msg += ` Data date ${d}.`; } return { ops: o, message: msg }; }
  m = t.match(new RegExp('^(?:complete|finished?|done)\\s+' + ID + '(?:\\s+(?:on|at)\\s+(.+))?$', 'i'));
  if (m) { const aid = resolve(p, m[1]); const d = m[2] ? cdate(m[2]) : (p.data_date || p.start).slice(0, 10); P({ op: 'set_progress', activity_id: aid, actual_finish: d, reason: t }); return { ops, message: `${aid} complete on ${d}.` }; }
  m = t.match(new RegExp('^(?:started?|begin|actual start)\\s+' + ID + '(?:\\s+(?:on|at)\\s+(.+))?$', 'i'));
  if (m) { const aid = resolve(p, m[1]); const d = m[2] ? cdate(m[2]) : (p.data_date || p.start).slice(0, 10); P({ op: 'set_progress', activity_id: aid, actual_start: d, percent_complete: 0, reason: t }); return { ops, message: `${aid} started on ${d}.` }; }
  m = t.match(new RegExp('^assign\\s+' + ID + '\\s+(?:to\\s+)?(.+)$', 'i'));
  if (m) { const aid = resolve(p, m[1]); return { ops: [{ op: 'note', reason: `__assign__${aid}__${m[2].trim()}` }], message: `Assigned '${m[2].trim()}' to ${aid}.` }; }
  m = t.match(new RegExp('^(?:move|put)\\s+' + ID + '\\s+(?:to|into|under)\\s+wbs\\s+(\\S+)', 'i'));
  if (m) { const aid = resolve(p, m[1]); P({ op: 'move_to_wbs', activity_id: aid, wbs_code: m[2], reason: t }); return { ops, message: `${aid} moved to WBS ${m[2]}.` }; }
  throw CommandError("I did not understand that. Type 'help' for the command list.");
}
function g0(n) { return Math.round(n * 100) / 100; }
Object.assign(global.PlannerEngine, { parseCommand, CommandError, COMMAND_HELP: HELP });
})(typeof window !== 'undefined' ? window : globalThis);

/* ---- part 5: file export (JSON always; XER for P6/Asta; MSPDI XML for Asta/MS Project) ---- */
(function (global) {
const E = global.PlannerEngine;
const { D } = E;
const TASK_TYPE_OUT = { task: 'TT_Task', start_milestone: 'TT_Mile', finish_milestone: 'TT_FinMile', level_of_effort: 'TT_LOE' };
const STATUS_OUT = { not_started: 'TK_NotStart', in_progress: 'TK_Active', complete: 'TK_Complete' };
const CSTR_OUT = { start_on_or_after: 'CS_MSOA', start_on_or_before: 'CS_MSOB', finish_on_or_after: 'CS_MEOA', finish_on_or_before: 'CS_MEOB', must_start_on: 'CS_MSO', must_finish_on: 'CS_MEO', as_late_as_possible: 'CS_ALAP' };
const LINK_OUT = { FS: 'PR_FS', SS: 'PR_SS', FF: 'PR_FF', SF: 'PR_SF' };
const RSRC_OUT = { labour: 'RT_Labor', material: 'RT_Mat', equipment: 'RT_Equip' };
const CSTR_MSP = { none: '0', as_late_as_possible: '1', must_start_on: '2', must_finish_on: '3', start_on_or_after: '4', start_on_or_before: '5', finish_on_or_after: '6', finish_on_or_before: '7' };
const LINK_MSP = { FF: '0', FS: '1', SF: '2', SS: '3' };
const RES_MSP = { material: '0', labour: '1', equipment: '1', cost: '2' };
const EXCEL_EPOCH = Date.UTC(1899, 11, 30);
const P2 = n => String(n).padStart(2, '0');
const KEY = (a, b) => JSON.stringify([a, b]);
function fmtDt(iso) { if (!iso) return ''; const d = D(iso); return d.getFullYear() + '-' + P2(d.getMonth() + 1) + '-' + P2(d.getDate()) + ' ' + P2(d.getHours()) + ':' + P2(d.getMinutes()); }
function fmtDtSec(iso) { if (!iso) return ''; const d = D(iso); return d.getFullYear() + '-' + P2(d.getMonth() + 1) + '-' + P2(d.getDate()) + 'T' + P2(d.getHours()) + ':' + P2(d.getMinutes()) + ':' + P2(d.getSeconds()); }
function fmtDur(h) { const hh = Math.floor(h), mm = Math.round((h - hh) * 60); return 'PT' + hh + 'H' + mm + 'M0S'; }
function colorInt(hex) { try { hex = (hex || '').replace('#', ''); const r = parseInt(hex.slice(0, 2), 16), g = parseInt(hex.slice(2, 4), 16), b = parseInt(hex.slice(4, 6), 16); return r | (g << 8) | (b << 16); } catch (e) { return 0; } }
const aStart = a => a.actual_start || a.early_start;
const aFinish = a => a.actual_finish || a.early_finish;
const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
function table(name, fields, rows) { const out = ['%T\t' + name, '%F\t' + fields.join('\t')]; for (const r of rows) out.push('%R\t' + fields.map(f => r[f] == null ? '' : String(r[f])).join('\t')); return out.join('\n'); }

function buildClndrData(cal) {
  const c = new E.Cal(cal);
  const shift = h => { const hm = c.day_start.split(':'); const s = new Date(2020, 0, 1, +hm[0], +hm[1]); const e = new Date(s.getTime() + h * 3600000); return '0||0(s|' + P2(s.getHours()) + ':' + P2(s.getMinutes()) + '|f|' + P2(e.getHours()) + ':' + P2(e.getMinutes()) + ')'; };
  const days = []; for (let p6 = 1; p6 <= 7; p6++) { const wd = (p6 - 2 + 7) % 7; days.push('0||' + p6 + '()' + (c.working_days.includes(wd) ? '( ' + shift(c.hours_per_day) + ' )' : '( )')); }
  const exc = []; const ex = Object.entries(c.exceptions).sort(); ex.forEach((pair, i) => { const d = pair[0], h = pair[1]; const serial = Math.round((Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)) - EXCEL_EPOCH) / 86400000); exc.push('0||' + i + '(d|' + serial + ')' + (h > 0 ? '( ' + shift(h) + ' )' : '( )')); });
  return '(0||CalendarType()( 0||DaysOfWeek()( ' + days.join(' ') + ' ) 0||VIEW(ShowTotal|Y)() 0||Exceptions()( ' + exc.join(' ') + ' ) ))';
}

function writeXer(p) {
  E.ensureCalendars(p); const now = new Date(); const nowS = fmtDt(E.ISO(now)); const pid = 1;
  const calIds = {}; Object.keys(p.calendars).forEach((c, i) => calIds[c] = i + 1);
  const taskIds = {}; p.activities.forEach((a, i) => taskIds[a.id] = i + 1);
  const wbsIds = {}; p.wbs.forEach((w, i) => wbsIds[w.id] = i + 2);
  const rsrcIds = {}; p.resources.forEach((r, i) => rsrcIds[r.id] = i + 1);
  const header = ['ERMHDR', '19.12', now.getFullYear() + '-' + P2(now.getMonth() + 1) + '-' + P2(now.getDate()), 'Project', 'admin', 'admin', 'dbxDatabaseNoName', 'Project Management', 'GBP'].join('\t');
  const currtype = table('CURRTYPE', ['curr_id', 'decimal_digit_cnt', 'curr_symbol', 'decimal_symbol', 'digit_group_symbol', 'pos_curr_fmt_type', 'neg_curr_fmt_type', 'curr_type', 'curr_short_name', 'group_digit_cnt', 'base_exch_rate'], [{ curr_id: 1, decimal_digit_cnt: 2, curr_symbol: 'GBP', decimal_symbol: '.', digit_group_symbol: ',', pos_curr_fmt_type: '#1,1.1', neg_curr_fmt_type: '(#1,1.1)', curr_type: 'Pound Sterling', curr_short_name: 'GBP', group_digit_cnt: 3, base_exch_rate: 1 }]);
  const calendar = table('CALENDAR', ['clndr_id', 'default_flag', 'clndr_name', 'proj_id', 'base_clndr_id', 'last_chng_date', 'clndr_type', 'day_hr_cnt', 'week_hr_cnt', 'month_hr_cnt', 'year_hr_cnt', 'rsrc_private', 'clndr_data'], Object.values(p.calendars).map(c => ({ clndr_id: calIds[c.id], default_flag: c.id === p.default_calendar_id ? 'Y' : 'N', clndr_name: c.name, proj_id: '', base_clndr_id: '', last_chng_date: nowS, clndr_type: 'CA_Base', day_hr_cnt: c.hours_per_day, week_hr_cnt: c.hours_per_day * c.working_days.length, month_hr_cnt: Math.round(c.hours_per_day * c.working_days.length * 52 / 12 * 10) / 10, year_hr_cnt: c.hours_per_day * c.working_days.length * 52, rsrc_private: 'N', clndr_data: buildClndrData(c) })));
  const finish = p.finish || p.start;
  const projFields = ['proj_id', 'fy_start_month_num', 'rsrc_self_add_flag', 'allow_complete_flag', 'allow_neg_act_flag', 'def_complete_pct_type', 'proj_short_name', 'clndr_id', 'task_code_base', 'task_code_step', 'priority_num', 'wbs_max_sum_level', 'strgy_priority_num', 'critical_drtn_hr_cnt', 'def_cost_per_qty', 'last_recalc_date', 'plan_start_date', 'plan_end_date', 'scd_end_date', 'add_date', 'def_duration_type', 'task_code_prefix', 'guid', 'def_qty_type', 'add_by_name', 'def_rate_type', 'add_act_remain_flag', 'act_this_per_link_flag', 'def_task_type', 'act_pct_link_flag', 'critical_path_type', 'task_code_prefix_flag', 'def_rollup_dates_flag', 'use_project_baseline_flag', 'rem_target_link_flag', 'reset_planned_flag', 'sum_assign_level', 'export_flag', 'loaded_scope_level', 'close_period_flag', 'trsrcsum_loaded'];
  const projT = table('PROJECT', projFields, [{ proj_id: pid, fy_start_month_num: 1, rsrc_self_add_flag: 'N', allow_complete_flag: 'N', allow_neg_act_flag: 'N', def_complete_pct_type: 'CP_Drtn', proj_short_name: p.id.slice(0, 20), clndr_id: calIds[p.default_calendar_id], task_code_base: 1000, task_code_step: 10, priority_num: 10, wbs_max_sum_level: 0, strgy_priority_num: 500, critical_drtn_hr_cnt: 0, def_cost_per_qty: 0, last_recalc_date: fmtDt(p.data_date || p.start), plan_start_date: fmtDt(p.start), plan_end_date: fmtDt(p.must_finish_by), scd_end_date: fmtDt(finish), add_date: nowS, def_duration_type: 'DT_FixedDrtn', task_code_prefix: 'A', guid: '', def_qty_type: 'QT_Hour', add_by_name: 'admin', def_rate_type: 'COST_PER_QTY', add_act_remain_flag: 'N', act_this_per_link_flag: 'Y', def_task_type: 'TT_Task', act_pct_link_flag: 'Y', critical_path_type: 'CT_TotFloat', task_code_prefix_flag: 'Y', def_rollup_dates_flag: 'Y', use_project_baseline_flag: 'Y', rem_target_link_flag: 'Y', reset_planned_flag: 'N', sum_assign_level: 'SL_Taskrsrc', export_flag: 'Y', loaded_scope_level: 7, close_period_flag: 'N', trsrcsum_loaded: 'N' }]);
  const wbsBase = { wbs_id: 1, proj_id: pid, obs_id: '', seq_num: 0, proj_node_flag: 'Y', sum_data_flag: 'Y', status_code: 'WS_Open', wbs_short_name: p.id.slice(0, 20), wbs_name: p.name, parent_wbs_id: '', ev_user_pct: 6, ev_etc_user_value: 0.88, orig_cost: 0, indep_remain_total_cost: 0, ann_dscnt_rate_pct: 0, dscnt_period_type: '', indep_remain_work_qty: 0, anticip_start_date: '', anticip_end_date: '', ev_compute_type: 'EC_Cmp_pct', ev_etc_compute_type: 'EE_Rem_hrs' };
  const wbsRows = [wbsBase];
  for (const w of p.wbs) wbsRows.push(Object.assign({}, wbsBase, { wbs_id: wbsIds[w.id], seq_num: w.seq, proj_node_flag: 'N', wbs_short_name: (w.code || w.id).slice(0, 20), wbs_name: w.name, parent_wbs_id: w.parent_id ? (wbsIds[w.parent_id] || 1) : 1 }));
  const projwbs = table('PROJWBS', Object.keys(wbsBase), wbsRows);
  const rsrc = table('RSRC', ['rsrc_id', 'clndr_id', 'rsrc_seq_num', 'rsrc_name', 'rsrc_short_name', 'def_qty_per_hr', 'cost_qty_type', 'ot_factor', 'active_flag', 'auto_compute_act_flag', 'def_cost_qty_link_flag', 'ot_flag', 'curr_id', 'rsrc_type', 'load_tasks_flag', 'level_flag'], p.resources.map((r, i) => ({ rsrc_id: rsrcIds[r.id], clndr_id: calIds[p.default_calendar_id], rsrc_seq_num: i + 1, rsrc_name: r.name, rsrc_short_name: r.id.slice(0, 20), def_qty_per_hr: 1, cost_qty_type: 'QT_Hour', ot_factor: 1, active_flag: 'Y', auto_compute_act_flag: 'Y', def_cost_qty_link_flag: 'Y', ot_flag: 'N', curr_id: 1, rsrc_type: RSRC_OUT[r.type] || 'RT_Labor', load_tasks_flag: 'N', level_flag: 'N' })));
  const taskFields = ['task_id', 'proj_id', 'wbs_id', 'clndr_id', 'phys_complete_pct', 'complete_pct_type', 'task_type', 'duration_type', 'status_code', 'task_code', 'task_name', 'total_float_hr_cnt', 'free_float_hr_cnt', 'remain_drtn_hr_cnt', 'target_drtn_hr_cnt', 'cstr_date', 'act_start_date', 'act_end_date', 'late_start_date', 'late_end_date', 'early_start_date', 'early_end_date', 'restart_date', 'reend_date', 'target_start_date', 'target_end_date', 'rem_late_start_date', 'rem_late_end_date', 'cstr_type', 'priority_type', 'driving_path_flag', 'create_date', 'update_date', 'create_user', 'update_user'];
  const taskRows = p.activities.map(a => { const rem = a.remaining_hours != null ? a.remaining_hours : (a.status === 'complete' ? 0 : a.duration_hours); return { task_id: taskIds[a.id], proj_id: pid, wbs_id: a.wbs_id ? (wbsIds[a.wbs_id] || 1) : 1, clndr_id: calIds[a.calendar_id || p.default_calendar_id] || calIds[p.default_calendar_id], phys_complete_pct: a.percent_complete, complete_pct_type: 'CP_Drtn', task_type: TASK_TYPE_OUT[a.type], duration_type: 'DT_FixedDrtn', status_code: STATUS_OUT[a.status], task_code: a.id.slice(0, 20), task_name: a.name.slice(0, 120), total_float_hr_cnt: a.total_float_hours == null ? '' : a.total_float_hours, free_float_hr_cnt: a.free_float_hours == null ? '' : a.free_float_hours, remain_drtn_hr_cnt: rem, target_drtn_hr_cnt: a.duration_hours, cstr_date: a.constraint !== 'none' ? fmtDt(a.constraint_date) : '', act_start_date: fmtDt(a.actual_start), act_end_date: fmtDt(a.actual_finish), late_start_date: fmtDt(a.late_start), late_end_date: fmtDt(a.late_finish), early_start_date: fmtDt(a.early_start), early_end_date: fmtDt(a.early_finish), restart_date: fmtDt(a.early_start), reend_date: fmtDt(a.early_finish), target_start_date: fmtDt(a.baseline_start || aStart(a)), target_end_date: fmtDt(a.baseline_finish || aFinish(a)), rem_late_start_date: fmtDt(a.late_start), rem_late_end_date: fmtDt(a.late_finish), cstr_type: CSTR_OUT[a.constraint] || '', priority_type: 'PT_Normal', driving_path_flag: a.critical ? 'Y' : 'N', create_date: nowS, update_date: nowS, create_user: 'admin', update_user: 'admin' }; });
  const task = table('TASK', taskFields, taskRows);
  const taskpred = table('TASKPRED', ['task_pred_id', 'task_id', 'pred_task_id', 'proj_id', 'pred_proj_id', 'pred_type', 'lag_hr_cnt'], p.relationships.filter(r => taskIds[r.successor_id] && taskIds[r.predecessor_id]).map((r, i) => ({ task_pred_id: i + 1, task_id: taskIds[r.successor_id], pred_task_id: taskIds[r.predecessor_id], proj_id: pid, pred_proj_id: pid, pred_type: LINK_OUT[r.type], lag_hr_cnt: r.lag_hours })));
  const taskrsrc = table('TASKRSRC', ['taskrsrc_id', 'task_id', 'proj_id', 'cost_qty_link_flag', 'rsrc_id', 'skill_level', 'remain_qty', 'target_qty', 'target_cost', 'remain_cost', 'rollup_dates_flag', 'rate_type', 'cost_per_qty_source_type', 'create_user', 'create_date', 'has_rsrchours'], p.assignments.filter(x => taskIds[x.activity_id] && rsrcIds[x.resource_id]).map((x, i) => ({ taskrsrc_id: i + 1, task_id: taskIds[x.activity_id], proj_id: pid, cost_qty_link_flag: 'Y', rsrc_id: rsrcIds[x.resource_id], skill_level: 3, remain_qty: x.units, target_qty: x.units, target_cost: x.cost, remain_cost: x.cost, rollup_dates_flag: 'Y', rate_type: 'COST_PER_QTY', cost_per_qty_source_type: 'ST_Rsrc', create_user: 'admin', create_date: nowS, has_rsrchours: 'N' })));
  const lib = {}; for (const kv of Object.entries(p.code_types || {})) lib[kv[0]] = Object.assign({}, kv[1]);
  for (const a of p.activities) for (const cv of Object.entries(a.codes || {})) { lib[cv[0]] = lib[cv[0]] || {}; if (!(cv[1] in lib[cv[0]])) lib[cv[0]][cv[1]] = '#7a8aa6'; }
  const typeIds = {}; Object.keys(lib).forEach((ct, i) => typeIds[ct] = i + 1); const valIds = {}; let vc = 0;
  for (const ct of Object.keys(lib)) for (const val of Object.keys(lib[ct])) valIds[KEY(ct, val)] = ++vc;
  const actvtype = table('ACTVTYPE', ['actv_code_type_id', 'actv_short_len', 'seq_num', 'actv_code_type', 'proj_id', 'wbs_id', 'actv_code_type_scope'], Object.keys(lib).map((ct, i) => ({ actv_code_type_id: typeIds[ct], actv_short_len: 20, seq_num: i, actv_code_type: ct.slice(0, 40), proj_id: pid, wbs_id: '', actv_code_type_scope: 'AS_Project' })));
  const actvRows = []; for (const ct of Object.keys(lib)) { let j = 0; for (const vcpair of Object.entries(lib[ct])) { actvRows.push({ actv_code_id: valIds[KEY(ct, vcpair[0])], parent_actv_code_id: '', actv_code_type_id: typeIds[ct], actv_code_name: vcpair[0].slice(0, 120), short_name: vcpair[0].slice(0, 20), seq_num: j++, color: colorInt(vcpair[1]), total_assign_cnt: p.activities.filter(a => (a.codes || {})[ct] === vcpair[0]).length }); } }
  const actvcode = table('ACTVCODE', ['actv_code_id', 'parent_actv_code_id', 'actv_code_type_id', 'actv_code_name', 'short_name', 'seq_num', 'color', 'total_assign_cnt'], actvRows);
  const taskactvRows = []; for (const a of p.activities) for (const cv of Object.entries(a.codes || {})) if (valIds[KEY(cv[0], cv[1])]) taskactvRows.push({ task_id: taskIds[a.id], actv_code_type_id: typeIds[cv[0]], actv_code_id: valIds[KEY(cv[0], cv[1])], proj_id: pid });
  const taskactv = table('TASKACTV', ['task_id', 'actv_code_type_id', 'actv_code_id', 'proj_id'], taskactvRows);
  return [header, currtype, calendar, projT, projwbs, rsrc, actvtype, actvcode, task, taskpred, taskrsrc, taskactv, '%E', ''].join('\n');
}

function writeMspdi(p) {
  E.ensureCalendars(p); const NS = 'http://schemas.microsoft.com/project';
  const calUid = {}; Object.keys(p.calendars).forEach((c, i) => calUid[c] = i + 1);
  const dcal = new E.Cal(p.calendars[p.default_calendar_id]);
  const now = E.ISO(new Date());
  const endTime = h => { const hm = dcal.day_start.split(':'); const e = new Date(2020, 0, 1, +hm[0], +hm[1]); e.setTime(e.getTime() + h * 3600000); return P2(e.getHours()) + ':' + P2(e.getMinutes()) + ':00'; };
  const L = []; const el = (tag, val) => L.push('<' + tag + '>' + esc(val) + '</' + tag + '>');
  L.push('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'); L.push('<Project xmlns="' + NS + '">');
  el('SaveVersion', 14); el('Name', p.name); el('Title', p.name); el('ScheduleFromStart', 1);
  el('StartDate', fmtDtSec(p.start)); el('FinishDate', fmtDtSec(p.finish || p.start)); el('StatusDate', fmtDtSec(p.data_date || p.start)); el('CurrentDate', now);
  el('CalendarUID', calUid[p.default_calendar_id]); el('DefaultStartTime', dcal.day_start); el('DefaultFinishTime', endTime(dcal.hours_per_day));
  el('MinutesPerDay', Math.round(dcal.hours_per_day * 60)); el('MinutesPerWeek', Math.round(dcal.hours_per_day * 60 * dcal.working_days.length)); el('DaysPerMonth', 20); el('DurationFormat', 7); el('NewTasksAreManual', 0);
  L.push('<Calendars>');
  for (const cidPair of Object.entries(p.calendars)) { const cid = cidPair[0]; const c = new E.Cal(cidPair[1]); L.push('<Calendar>'); el('UID', calUid[cid]); el('Name', c.name); el('IsBaseCalendar', 1); el('BaseCalendarUID', -1); L.push('<WeekDays>'); for (let dt = 1; dt <= 7; dt++) { L.push('<WeekDay>'); el('DayType', dt); const working = c.working_days.includes((dt - 2 + 7) % 7); el('DayWorking', working ? 1 : 0); if (working) { L.push('<WorkingTimes><WorkingTime>'); el('FromTime', c.day_start); el('ToTime', endTime(c.hours_per_day)); L.push('</WorkingTime></WorkingTimes>'); } L.push('</WeekDay>'); } L.push('</WeekDays>'); const exs = Object.entries(c.exceptions).sort(); if (exs.length) { L.push('<Exceptions>'); for (const dh of exs) { const d = dh[0], h = dh[1]; L.push('<Exception>'); L.push('<TimePeriod>'); el('FromDate', d + 'T00:00:00'); el('ToDate', d + 'T23:59:00'); L.push('</TimePeriod>'); el('Occurrences', 1); el('Name', h == 0 ? 'Non-working' : 'Working exception'); el('Type', 1); el('DayWorking', h > 0 ? 1 : 0); if (h > 0) { L.push('<WorkingTimes><WorkingTime>'); el('FromTime', c.day_start); el('ToTime', endTime(h)); L.push('</WorkingTime></WorkingTimes>'); } L.push('</Exception>'); } L.push('</Exceptions>'); } L.push('</Calendar>'); }
  L.push('</Calendars>'); L.push('<Tasks>');
  L.push('<Task>'); el('UID', 0); el('ID', 0); el('Name', p.name); el('Type', 1); el('OutlineNumber', 0); el('OutlineLevel', 0); el('Summary', 1); el('Start', fmtDtSec(p.start)); el('Finish', fmtDtSec(p.finish || p.start)); L.push('</Task>');
  const children = {}; p.wbs.forEach(w => { const k = w.parent_id || ''; (children[k] = children[k] || []).push(w); });
  const wset = new Set(p.wbs.map(w => w.id)); const actsByWbs = {}; p.activities.forEach(a => { const k = (a.wbs_id && wset.has(a.wbs_id)) ? a.wbs_id : ''; (actsByWbs[k] = actsByWbs[k] || []).push(a); });
  const taskUid = {}; let counter = 0; const emit = [];
  function walk(parent, level, prefix) { let n = 0; (children[parent] || []).slice().sort((a, b) => a.seq - b.seq || a.name.localeCompare(b.name)).forEach(w => { n++; counter++; emit.push({ wbs: w, uid: counter, level: level, outlineNo: prefix + n }); walk(w.id, level + 1, prefix + n + '.'); }); (actsByWbs[parent] || []).forEach(a => { n++; counter++; taskUid[a.id] = counter; emit.push({ act: a, uid: counter, level: level, outlineNo: prefix + n }); }); }
  walk('', 1, '');
  const fmtSlack = h => Math.round(h * 600);
  for (const e of emit) {
    if (e.wbs) { L.push('<Task>'); el('UID', e.uid); el('ID', e.uid); el('Name', e.wbs.name); el('Type', 1); el('OutlineNumber', e.outlineNo); el('OutlineLevel', e.level); el('Summary', 1); el('WBS', e.wbs.code || e.wbs.id); L.push('</Task>'); continue; }
    const a = e.act;
    L.push('<Task>'); el('UID', e.uid); el('ID', e.uid); el('Name', a.name); el('Type', 1); el('IsNull', 0); el('WBS', a.id); el('OutlineNumber', e.outlineNo); el('OutlineLevel', e.level); el('Priority', 500);
    el('Start', fmtDtSec(aStart(a))); el('Finish', fmtDtSec(aFinish(a))); el('Duration', fmtDur(a.duration_hours)); el('DurationFormat', 7);
    const rem = a.remaining_hours != null ? a.remaining_hours : (a.status === 'complete' ? 0 : a.duration_hours);
    el('RemainingDuration', fmtDur(rem)); el('ManualStart', fmtDtSec(aStart(a))); el('ManualFinish', fmtDtSec(aFinish(a))); el('ManualDuration', fmtDur(a.duration_hours));
    el('ConstraintType', CSTR_MSP[a.constraint] || '0'); if (a.constraint_date && a.constraint !== 'none') el('ConstraintDate', fmtDtSec(a.constraint_date));
    el('CalendarUID', a.calendar_id ? (calUid[a.calendar_id] != null ? calUid[a.calendar_id] : -1) : -1);
    el('Milestone', E.isMs(a) ? 1 : 0); el('Summary', 0); el('Critical', a.critical ? 1 : 0); el('IsSubproject', 0);
    el('EarlyStart', fmtDtSec(a.early_start)); el('EarlyFinish', fmtDtSec(a.early_finish)); el('LateStart', fmtDtSec(a.late_start)); el('LateFinish', fmtDtSec(a.late_finish));
    if (a.total_float_hours != null) { el('TotalSlack', fmtSlack(a.total_float_hours)); el('FreeSlack', fmtSlack(a.free_float_hours || 0)); }
    el('PercentComplete', Math.round(a.status === 'complete' ? 100 : a.percent_complete));
    if (a.actual_start) el('ActualStart', fmtDtSec(a.actual_start));
    if (a.actual_finish) el('ActualFinish', fmtDtSec(a.actual_finish));
    if (a.notes) el('Notes', a.notes);
    if (a.baseline_start || a.baseline_finish) { L.push('<Baseline>'); el('Number', 0); el('Start', fmtDtSec(a.baseline_start)); el('Finish', fmtDtSec(a.baseline_finish)); L.push('</Baseline>'); }
    for (const r of E.predsOf(p, a.id)) { if (taskUid[r.predecessor_id] == null) continue; L.push('<PredecessorLink>'); el('PredecessorUID', taskUid[r.predecessor_id]); el('Type', LINK_MSP[r.type]); el('CrossProject', 0); el('LinkLag', Math.round(r.lag_hours * 600)); el('LagFormat', 7); L.push('</PredecessorLink>'); }
    L.push('</Task>');
  }
  L.push('</Tasks>');
  const resUid = {}; p.resources.forEach((r, i) => resUid[r.id] = i + 1);
  L.push('<Resources>'); for (const r of p.resources) { L.push('<Resource>'); el('UID', resUid[r.id]); el('ID', resUid[r.id]); el('Name', r.name); el('Type', RES_MSP[r.type] || '1'); el('Initials', r.id.slice(0, 10)); el('StandardRate', r.rate); el('MaxUnits', r.max_units_per_day || 1); L.push('</Resource>'); } L.push('</Resources>');
  L.push('<Assignments>'); p.assignments.forEach((x, i) => { if (taskUid[x.activity_id] == null || resUid[x.resource_id] == null) return; L.push('<Assignment>'); el('UID', i + 1); el('TaskUID', taskUid[x.activity_id]); el('ResourceUID', resUid[x.resource_id]); el('Units', 1); el('Work', fmtDur(x.units)); el('Cost', x.cost); L.push('</Assignment>'); }); L.push('</Assignments>');
  L.push('</Project>');
  return L.join('\n');
}

function writeAny(p, fmt) {
  fmt = fmt.toLowerCase().replace(/^\./, '');
  if (fmt === 'json') return [JSON.stringify(p, null, 1), 'application/json', p.id + '.json'];
  if (fmt === 'xer') return [writeXer(p), 'text/plain', p.id + '.xer'];
  if (fmt === 'xml' || fmt === 'mspdi' || fmt === 'msproject') return [writeMspdi(p), 'application/xml', p.id + '.xml'];
  throw new Error('format must be json, xer or xml');
}
Object.assign(global.PlannerEngine, { writeXer, writeMspdi, writeAny, buildClndrData });
})(typeof window !== 'undefined' ? window : globalThis);

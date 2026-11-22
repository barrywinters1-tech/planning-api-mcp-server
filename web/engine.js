/* Browser engine: a faithful JS port of the tested Python planner (planner/*.py).
   Same data model, same critical-path arithmetic, same DCMA checks, generator,
   levelling, analysis, patches, commands and repairer. No backend. */
'use strict';
(function (global) {
const EPS = 1e-6;
const HARD = new Set(['must_start_on', 'must_finish_on']);

// ---------- datetime helpers (Date <-> "YYYY-MM-DDTHH:MM:SS") ----------
// Schedule datetimes are naive wall-clock times, exactly like Python's naive datetime.
// They are held in Date objects pinned to UTC, which has no daylight saving: every day is
// 24 hours and every wall-clock time exists. Using local time here made the browser lose
// or gain an hour across DST changes (and lose whole days where clocks change at midnight).
// Only ever read these with the getUTC* accessors.
const P2 = n => String(n).padStart(2, '0');
const mk = (y, mo, d, h = 0, mi = 0, s = 0) => new Date(Date.UTC(y, mo, d, h, mi, s));
function D(iso) { if (iso == null) return null; if (iso instanceof Date) return iso; const m = String(iso).match(/(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/); if (!m) return null; return mk(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)); }
function ISO(d) { return d ? `${d.getUTCFullYear()}-${P2(d.getUTCMonth() + 1)}-${P2(d.getUTCDate())}T${P2(d.getUTCHours())}:${P2(d.getUTCMinutes())}:${P2(d.getUTCSeconds())}` : null; }
function YMD(d) { return `${d.getUTCFullYear()}-${P2(d.getUTCMonth() + 1)}-${P2(d.getUTCDate())}`; }
const dow = d => (d.getUTCDay() + 6) % 7;           // Mon=0 .. Sun=6
const addDays = (d, n) => { const x = new Date(d); x.setUTCDate(x.getUTCDate() + n); return x; };
const dateOnly = d => mk(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
const hoursDiff = (a, b) => (b - a) / 3600000;
// "now" and "today" are the user's local wall clock, expressed as naive values
function nowISO() { const n = new Date(); return `${n.getFullYear()}-${P2(n.getMonth() + 1)}-${P2(n.getDate())}T${P2(n.getHours())}:${P2(n.getMinutes())}:${P2(n.getSeconds())}`; }
function today() { const n = new Date(); return mk(n.getFullYear(), n.getMonth(), n.getDate()); }

// ---------- Python-exact number formatting ----------
// Python rounds half-to-even on the exact binary value of a float (round(), f"{x:.1f}", f"{x:g}");
// Math.round rounds half-up on an inexact x*10^n. Both engines must print and round identically,
// so these work on the double's exact decimal expansion (BigInt) and never on float products.
const _dv = new DataView(new ArrayBuffer(8));
function exactDec(x) {            // |x| = N / 10^s exactly
  _dv.setFloat64(0, x); const hi = _dv.getUint32(0), lo = _dv.getUint32(4);
  const neg = (hi >>> 31) === 1, e = (hi >>> 20) & 0x7ff;
  let m = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo), p;
  if (e === 0) p = -1074; else { m |= 1n << 52n; p = e - 1075; }
  return p >= 0 ? { neg, N: m << BigInt(p), s: 0 } : { neg, N: m * 5n ** BigInt(-p), s: -p };
}
function roundDec(N, s, keep) {   // N/10^s rounded half-to-even to `keep` decimal places -> integer over 10^keep
  if (keep >= s) return N * 10n ** BigInt(keep - s);
  const div = 10n ** BigInt(s - keep), q = N / div, r2 = (N % div) * 2n;
  return (r2 > div || (r2 === div && (q & 1n))) ? q + 1n : q;
}
function placeDec(q, n) { const t = q.toString().padStart(n + 1, '0'); return n ? t.slice(0, -n) + '.' + t.slice(-n) : t; }
function pyFixed(x, n = 0) {      // f"{x:.{n}f}"
  if (!Number.isFinite(x)) return isNaN(x) ? 'nan' : (x > 0 ? 'inf' : '-inf');
  const { neg, N, s } = exactDec(x); return (neg ? '-' : '') + placeDec(roundDec(N, s, n), n);
}
function pyRound(x, n = 0) { if (Number.isInteger(x) || !Number.isFinite(x)) return x; return Number(pyFixed(x, n)); }   // round(x, n); integers pass straight through
function pyGroup(x) {             // f"{x:,.0f}"
  const t = pyFixed(x, 0), neg = t[0] === '-', d = neg ? t.slice(1) : t;
  return (neg ? '-' : '') + d.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}
function pyG(x, plus = false) {   // f"{x:g}" (and "%+g" with plus)
  const sign = (x < 0 || Object.is(x, -0)) ? '-' : (plus ? '+' : '');
  if (!Number.isFinite(x)) return sign + (isNaN(x) ? 'nan' : 'inf');
  if (x === 0) return sign + '0';
  const P = 6, { N, s } = exactDec(x);
  const keep = P - 1 - (N.toString().length - 1 - s);
  const q = roundDec(N, s, keep), exp = q.toString().length - 1 - keep;
  const strip = t => t.includes('.') ? t.replace(/0+$/, '').replace(/\.$/, '') : t;
  if (exp >= -4 && exp < P) return sign + strip(placeDec(q, Math.max(0, keep)));
  const dg = q.toString(), mant = strip(dg[0] + '.' + dg.slice(1, P));
  return sign + mant + 'e' + (exp < 0 ? '-' : '+') + P2(Math.abs(exp));
}
function pyStr(x) {               // str(float) / repr: shortest round-trip digits, Python's layout
  if (!Number.isFinite(x)) return isNaN(x) ? 'nan' : (x > 0 ? 'inf' : '-inf');
  if (x === 0) return Object.is(x, -0) ? '-0.0' : '0.0';
  const [mant, es] = Math.abs(x).toExponential().split('e'), exp = +es, dg = mant.replace('.', ''), sign = x < 0 ? '-' : '';
  if (exp < -4 || exp >= 16) return sign + mant + 'e' + (exp < 0 ? '-' : '+') + P2(Math.abs(exp));
  if (exp < 0) return sign + '0.' + '0'.repeat(-exp - 1) + dg;
  return sign + (dg.length <= exp + 1 ? dg + '0'.repeat(exp + 1 - dg.length) + '.0' : dg.slice(0, exp + 1) + '.' + dg.slice(exp + 1));
}
function pyFloorDiv(a, b) {       // a // b for floats (CPython float_floor_div)
  const mod = a % b; let div = (a - mod) / b;
  if (mod && ((b < 0) !== (mod < 0))) div -= 1;
  let fl = Math.floor(div); if (div - fl > 0.5) fl += 1; return fl;
}

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
  _shift(d) { const s = mk(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), this._sh, this._sm, 0); const e = new Date(s.getTime() + this.hours_on(d) * 3600000); return [s, e]; }
  next_working_start(dt) { let d = dateOnly(dt); for (let i = 0; i < 3660; i++) { if (this.is_working(d)) { const [s, e] = this._shift(d); if (dt < s) return s; if (dt < e) return dt; } d = addDays(d, 1); dt = new Date(d); } throw new Error('no working time'); }
  prev_working_end(dt) { let d = dateOnly(dt); for (let i = 0; i < 3660; i++) { if (this.is_working(d)) { const [s, e] = this._shift(d); if (dt > e) return e; if (dt > s) return dt; if (dt.getTime() === s.getTime()) { const y = addDays(d, -1); if (this.is_working(y) && this._shift(y)[1].getTime() === s.getTime()) return dt; } } d = addDays(d, -1); dt = mk(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 23, 59, 59); } throw new Error('no working time'); }   // continuous (24-hour) calendars: midnight ends the previous day
  in_shift(dt) { if (!this.is_working(dt)) return false; const [s, e] = this._shift(dt); return dt >= s && dt <= e; }
  add_hours(dt, hours) {
    if (hours === 0) return dt;
    if (hours > 0) { dt = this.next_working_start(dt); let rem = hours; for (let i = 0; i < 20000; i++) { const [s, e] = this._shift(dt); const avail = hoursDiff(dt, e); if (rem <= avail + 1e-9) return new Date(dt.getTime() + pyRound(rem * 3600) * 1000); rem -= avail; dt = this.next_working_start(new Date(dateOnly(addDays(dt, 1)))); } }
    else { dt = this.prev_working_end(dt); let d = dateOnly(dt); if (dt.getTime() === this._shift(d)[0].getTime()) d = addDays(d, -1);   // midnight on a continuous (24-hour) calendar is the end of the previous day's shift
      let rem = -hours; for (let i = 0; i < 20000; i++) { const [s] = this._shift(d); const avail = hoursDiff(s, dt); if (rem <= avail + 1e-9) return new Date(dt.getTime() - pyRound(rem * 3600) * 1000); rem -= avail; d = addDays(d, -1); let g = 0; while (!this.is_working(d) && g++ < 3660) d = addDays(d, -1); dt = this._shift(d)[1]; } }   // the previous working day's end
    throw new Error('add_hours overflow');
  }
  hours_between(a, b) { if (b < a) return -this.hours_between(b, a); let total = 0; let d = dateOnly(a); const end = dateOnly(b); while (d <= end) { if (this.is_working(d)) { const [s, e] = this._shift(d); const lo = a > s ? a : s, hi = b < e ? b : e; if (hi > lo) total += hoursDiff(lo, hi); } d = addDays(d, 1); } return total; }
  days_to_hours(x) { return x * this.hours_per_day; }
  hours_to_days(h) { return this.hours_per_day ? h / this.hours_per_day : 0; }
}

// ---------- project helpers over the plain JSON model ----------
function calFor(p, a) { const cid = a.calendar_id || p.default_calendar_id; return new Cal(p.calendars[cid] || p.calendars[p.default_calendar_id] || { id: 'std' }); }
// elapsed-duration activities (a.elapsed): scheduled on calendar time, 24 hours a day, seven days (cpm.ELAPSED_CALENDAR / sched_calendar)
const ELAPSED_CAL = new Cal({ id: '24h', name: 'Elapsed (24-hour)', hours_per_day: 24, day_start: '00:00:00', working_days: [0, 1, 2, 3, 4, 5, 6], exceptions: {} });
function schedCal(p, a) { return a.elapsed ? ELAPSED_CAL : calFor(p, a); }
// calendar days between an activity's start (actual or early) and finish, to two decimals; null until scheduled (cpm.elapsed_days)
function elapsedDays(p, a) { const s = D(a.actual_start || a.early_start), f = D(a.actual_finish || a.early_finish); if (!s || !f) return null; return pyRound((f - s) / 86400000, 2); }
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

// P6 suspend/resume: remaining work of an in-progress activity restarts at the resume date, never before the data date
function resumeFrom(a, dataDate) { const r = D(a.resume_date); return r && r > dataDate ? r : dataDate; }
// Lag calendar (cpm._lag_calendar): the calendar a relationship's lag is measured on, by the link's own lag_calendar or the
// project's: 'predecessor' (P6 default, also when unset), 'successor', 'project' (default calendar) or '24h' (null: elapsed hours)
const LAG_CALENDARS = ['predecessor', 'successor', 'project', '24h'];
function lagCal(p, r, pr, s) {
  const mode = r.lag_calendar || p.lag_calendar || 'predecessor';
  if (mode === 'successor') return schedCal(p, s);
  if (mode === 'project') return new Cal(p.calendars[p.default_calendar_id]);
  if (mode === '24h') return null;
  return schedCal(p, pr);
}
// dt plus a lag: working hours on cal, or wall-clock hours when cal is null, landing on whole seconds as add_hours does (cpm._add_lag)
function addLag(cal, dt, hours) { if (cal !== null) return cal.add_hours(dt, hours); if (hours === 0) return dt; return new Date(dt.getTime() + pyRound(hours * 3600) * 1000); }
// Scheduling options (the exact semantics are the docstring of planner/cpm.py; this port applies the same rules):
// progress_logic 'data_date' (default) | 'retained' | 'override', float_paths 1-10, start_on_new_day, near_critical_days (10 when unset)
const PROGRESS_LOGIC = ['data_date', 'retained', 'override'];
const DEFAULT_NEAR_CRITICAL_DAYS = 10, MAX_FLOAT_PATHS = 10;
const progressLogic = p => PROGRESS_LOGIC.includes(p.progress_logic) ? p.progress_logic : 'data_date';
const inProgress = a => a.status === 'in_progress' && a.actual_start != null;
// Asta "start on new day": a start part-way through a working day moves to the next working day's start (cpm._new_day_start)
function newDayStart(cal, es) { const [s] = cal._shift(es); if (es <= s) return es; return cal.next_working_start(dateOnly(addDays(es, 1))); }
function schedule(p) {
  ensureDefaultCal(p);
  const order = topo(p), m = amap(p);
  const dataDate = D(p.data_date) || D(p.start), start = D(p.start);
  const mode = progressLogic(p), newDay = !!p.start_on_new_day;
  const preds = {}, succs = {};
  p.activities.forEach(a => { preds[a.id] = []; succs[a.id] = []; });
  for (const r of p.relationships) { r.driving = false; preds[r.successor_id].push(r); succs[r.predecessor_id].push(r); }
  const maxD = (a, b) => (a && b) ? (a > b ? a : b) : (a || b);
  const remEs = {}, remLs = {};   // retained logic: where an in-progress activity's remaining work starts (early / late)

  for (const a of order) {
    const cal = schedCal(p, a), rem = remHours(a);
    if (a.status === 'complete' && a.actual_start && a.actual_finish) { a.early_start = a.actual_start; a.early_finish = a.actual_finish; continue; }
    let es_floor = cal.next_working_start(maxD(start, dataDate)), ef_floor = null;
    const inProg = inProgress(a), resume = inProg ? cal.next_working_start(resumeFrom(a, dataDate)) : null;
    if (inProg) { es_floor = D(a.actual_start); if (mode !== 'retained') ef_floor = cal.add_hours(resume, rem); }
    const startLinks = [], finishLinks = [];   // [relationship, date it imposes]
    for (const r of preds[a.id]) {
      const pr = m[r.predecessor_id];
      if (inProg && mode === 'override' && pr.status !== 'complete') continue;   // progress override: an unfinished predecessor no longer holds the started activity
      const lcal = lagCal(p, r, pr, a);
      if (r.type === 'FS') { const t = addLag(lcal, D(pr.early_finish), r.lag_hours); if (t > es_floor) es_floor = t; startLinks.push([r, t]); }
      else if (r.type === 'SS') { const t = addLag(lcal, D(pr.early_start), r.lag_hours); if (t > es_floor) es_floor = t; startLinks.push([r, t]); }
      else if (r.type === 'FF') { const t = addLag(lcal, D(pr.early_finish), r.lag_hours); ef_floor = ef_floor === null ? t : maxD(ef_floor, t); finishLinks.push([r, t]); }
      else if (r.type === 'SF') { const t = addLag(lcal, D(pr.early_start), r.lag_hours); ef_floor = ef_floor === null ? t : maxD(ef_floor, t); finishLinks.push([r, t]); }
    }
    const cd = D(a.constraint_date);
    if (cd) {
      if (a.constraint === 'start_on_or_after' || a.constraint === 'must_start_on') es_floor = a.constraint === 'start_on_or_after' ? maxD(es_floor, cd) : cd;
      else if (a.constraint === 'finish_on_or_after' || a.constraint === 'must_finish_on') ef_floor = (ef_floor === null || a.constraint === 'must_finish_on') ? cd : maxD(ef_floor, cd);
    }
    let es, ef;
    if (inProg && mode === 'retained') {
      // remaining work by the logic: after every FS/SS predecessor date, never before the resume point
      es = D(a.actual_start);
      let rs_floor = resume; for (const [, t] of startLinks) if (t > rs_floor) rs_floor = t;
      const rs = cal.next_working_start(rs_floor); remEs[a.id] = rs;
      ef = rem > 0 ? cal.add_hours(rs, rem) : rs;
      const finishRules = ef_floor !== null && ef_floor >= ef, startRules = !(ef_floor !== null && ef_floor > ef);
      if (ef_floor !== null && ef_floor > ef) ef = ef_floor;
      for (const [r, t] of startLinks) r.driving = startRules && t.getTime() === rs_floor.getTime();
      for (const [r, t] of finishLinks) r.driving = finishRules && t.getTime() === ef_floor.getTime();
    }
    else if (inProg) { es = D(a.actual_start); ef = ef_floor !== null ? ef_floor : cal.add_hours(resume, rem); }
    else if (a.type === 'finish_milestone') { const target = ef_floor === null ? es_floor : maxD(es_floor, ef_floor); es = ef = cal.in_shift(target) ? target : cal.prev_working_end(target); for (const [r, t] of startLinks.concat(finishLinks)) r.driving = t.getTime() === target.getTime(); }
    else {
      es = cal.next_working_start(es_floor); if (newDay && a.status === 'not_started') es = newDayStart(cal, es);
      ef = rem > 0 ? cal.add_hours(es, rem) : es;
      const finishRules = ef_floor !== null && ef_floor >= ef, startRules = !(ef_floor !== null && ef_floor > ef);
      if (ef_floor !== null && ef_floor > ef) { ef = rem > 0 ? ef_floor : cal.prev_working_end(ef_floor); es = rem > 0 ? cal.add_hours(ef, -rem) : ef; }
      for (const [r, t] of startLinks) r.driving = startRules && t.getTime() === es_floor.getTime();
      for (const [r, t] of finishLinks) r.driving = finishRules && t.getTime() === ef_floor.getTime();
    }
    if (a.status === 'not_started' && cd && (a.constraint === 'must_start_on' || a.constraint === 'must_finish_on')) for (const [r] of startLinks.concat(finishLinks)) r.driving = false;
    if (a.status === 'not_started' && cd) { if (a.constraint === 'must_start_on') { es = cd; ef = rem > 0 ? cal.add_hours(es, rem) : es; } else if (a.constraint === 'must_finish_on') { ef = cd; es = rem > 0 ? cal.add_hours(ef, -rem) : ef; } }
    a.early_start = ISO(es); a.early_finish = ISO(ef);
  }
  let pfin = null; for (const a of p.activities) { const f = D(a.early_finish); if (f && (!pfin || f > pfin)) pfin = f; }
  pfin = pfin || start; p.finish = ISO(pfin);
  const lateAnchor = D(p.must_finish_by) || pfin;

  for (let i = order.length - 1; i >= 0; i--) {
    const a = order[i], cal = schedCal(p, a), rem = remHours(a);
    if (a.status === 'complete' && a.actual_finish) { a.late_start = a.early_start; a.late_finish = a.early_finish; a.total_float_hours = 0; a.free_float_hours = 0; a.critical = false; continue; }
    let lf_ceil = cal.prev_working_end(lateAnchor), ls_ceil = null;
    for (const r of succs[a.id]) {
      const s = m[r.successor_id]; if (s.status === 'complete' || (mode === 'override' && inProgress(s))) continue;
      const lcal = lagCal(p, r, a, s);
      const sLs = mode === 'retained' && remLs[s.id] ? remLs[s.id] : D(s.late_start);
      if (r.type === 'FS') { const t = addLag(lcal, sLs, -r.lag_hours); if (t < lf_ceil) lf_ceil = t; }
      else if (r.type === 'SS') { const t = addLag(lcal, sLs, -r.lag_hours); ls_ceil = ls_ceil === null ? t : (t < ls_ceil ? t : ls_ceil); }
      else if (r.type === 'FF') { const t = addLag(lcal, D(s.late_finish), -r.lag_hours); if (t < lf_ceil) lf_ceil = t; }
      else if (r.type === 'SF') { const t = addLag(lcal, D(s.late_finish), -r.lag_hours); ls_ceil = ls_ceil === null ? t : (t < ls_ceil ? t : ls_ceil); }
    }
    const cd = D(a.constraint_date);
    if (cd) {
      if (a.constraint === 'finish_on_or_before' || a.constraint === 'must_finish_on') lf_ceil = a.constraint === 'finish_on_or_before' ? (cd < lf_ceil ? cd : lf_ceil) : cd;
      else if (a.constraint === 'start_on_or_before' || a.constraint === 'must_start_on') ls_ceil = (ls_ceil === null || a.constraint === 'must_start_on') ? cd : (cd < ls_ceil ? cd : ls_ceil);
    }
    let lf = cal.prev_working_end(lf_ceil), ls = rem > 0 ? cal.add_hours(lf, -rem) : lf;
    if (ls_ceil !== null && ls_ceil < ls) { ls = rem === 0 ? cal.prev_working_end(ls_ceil) : ls_ceil; lf = rem > 0 ? cal.add_hours(ls, rem) : ls; }
    if (a.status === 'in_progress' && a.actual_start) { remLs[a.id] = ls; ls = D(a.actual_start); }
    a.late_start = ISO(ls); a.late_finish = ISO(lf);
    a.total_float_hours = pyRound(cal.hours_between(D(a.early_finish), D(a.late_finish)), 4);
    let ff = null;
    for (const r of succs[a.id]) {
      const s = m[r.successor_id]; if (mode === 'override' && inProgress(s)) continue;
      const lcal = lagCal(p, r, a, s); let slack;
      const sEs = mode === 'retained' && remEs[s.id] ? remEs[s.id] : D(s.early_start);
      if (r.type === 'FS') slack = cal.hours_between(addLag(lcal, D(a.early_finish), r.lag_hours), sEs);
      else if (r.type === 'SS') slack = cal.hours_between(addLag(lcal, D(a.early_start), r.lag_hours), sEs);
      else if (r.type === 'FF') slack = cal.hours_between(addLag(lcal, D(a.early_finish), r.lag_hours), D(s.early_finish));
      else slack = cal.hours_between(addLag(lcal, D(a.early_start), r.lag_hours), D(s.early_finish));
      ff = ff === null ? slack : Math.min(ff, slack);
    }
    a.free_float_hours = pyRound(ff === null ? a.total_float_hours : Math.max(0, ff), 4);
  }
  // critical = the longest path traced back from the finish through driving links (negative float is reported separately)
  const openActs = openActivities(p);
  let onPath = new Set();
  if (openActs.length) {
    let end = null; for (const a of openActs) { const f = D(a.early_finish); if (!end || f > end) end = f; }
    onPath = traceDriving(openActs.filter(a => D(a.early_finish) >= end), preds, m, new Set());
  }
  for (const a of p.activities) a.critical = (a.status === 'complete' || a.total_float_hours == null) ? false : onPath.has(a.id);
  // multiple float paths (P6): path 1 is the longest path above, then the next most critical chains
  const paths = p.float_paths ? floatPaths(p, p.float_paths) : {};
  for (const a of p.activities) a.float_path = paths[a.id] != null ? paths[a.id] : null;

  for (const a of p.activities) {
    if (a.type !== 'level_of_effort' || a.status === 'complete') continue;
    const cal = schedCal(p, a);
    let starts = preds[a.id].filter(r => r.type === 'SS').map(r => D(m[r.predecessor_id].early_start)).filter(Boolean);
    let ends = preds[a.id].filter(r => r.type === 'FF').map(r => D(m[r.predecessor_id].early_finish)).filter(Boolean);
    if (!starts.length && !ends.length) { const peers = p.activities.filter(x => x.wbs_id === a.wbs_id && x.id !== a.id && x.type !== 'level_of_effort' && x.early_start); starts = peers.map(x => D(x.actual_start || x.early_start)); ends = peers.map(x => D(x.actual_finish || x.early_finish)); }
    if (starts.length) { const mn = new Date(Math.min(...starts)); a.early_start = a.late_start = ISO(mn); }
    if (ends.length) { const mx = new Date(Math.max(...ends)); a.early_finish = a.late_finish = ISO(mx); }
    if (a.early_start && a.early_finish) { a.duration_hours = pyRound(cal.hours_between(D(a.early_start), D(a.early_finish)), 2); a.total_float_hours = a.free_float_hours = 0; a.critical = false; }
  }
  for (const a of p.activities) if (a.constraint === 'as_late_as_possible' && a.status === 'not_started') { a.early_start = a.late_start; a.early_finish = a.late_finish; a.total_float_hours = 0; a.free_float_hours = 0; }
  // near-critical: open, off the longest path, total float within the threshold (working days of the activity's own calendar)
  const nearDays = p.near_critical_days == null ? DEFAULT_NEAR_CRITICAL_DAYS : p.near_critical_days;
  for (const a of p.activities) a.near_critical = a.status !== 'complete' && a.type !== 'level_of_effort' && !a.critical && a.total_float_hours != null && a.total_float_hours <= nearDays * schedCal(p, a).hours_per_day;
  p.scheduled_at = nowISO();
  return p;
}
// the activities the longest path and float paths are traced over: unfinished, scheduled, not hammocks (cpm._open_activities)
const openActivities = p => p.activities.filter(a => a.status !== 'complete' && a.early_finish && a.type !== 'level_of_effort');
// trace back from seeds through driving links over open, non-hammock predecessors, never entering `taken` (cpm._trace_driving)
function traceDriving(seeds, preds, m, taken) {
  const found = new Set(), stack = seeds.slice();
  while (stack.length) { const a = stack.pop(); if (found.has(a.id) || taken.has(a.id)) continue; found.add(a.id); for (const r of preds[a.id]) { const q = m[r.predecessor_id]; if (r.driving && q.status !== 'complete' && q.type !== 'level_of_effort') stack.push(q); } }
  return found;
}
// P6-style multiple float paths over a scheduled project, {id: path number}; a pure function (the algorithm is cpm.float_paths's docstring)
function floatPaths(p, n) {
  if (!n || n < 1) return {};
  n = Math.min(Math.trunc(n), MAX_FLOAT_PATHS);
  const m = amap(p), preds = {}; p.activities.forEach(a => preds[a.id] = []); for (const r of p.relationships) preds[r.successor_id].push(r);
  const openActs = openActivities(p), out = {};
  if (!openActs.length) return out;
  const taken = new Set();
  let end = null; for (const a of openActs) { const f = D(a.early_finish); if (!end || f > end) end = f; }
  let seeds = openActs.filter(a => D(a.early_finish) >= end);
  for (let k = 1; k <= n; k++) {
    if (k > 1) {
      const rest = openActs.filter(a => !taken.has(a.id));
      if (!rest.length) break;
      let best = null;   // least total float, then the latest early finish, then project order
      for (const a of rest) {
        const tf = a.total_float_hours == null ? Infinity : a.total_float_hours, ef = D(a.early_finish).getTime();
        if (best === null || tf < best.tf || (tf === best.tf && ef > best.ef)) best = { tf, ef, a };
      }
      seeds = [best.a];
    }
    for (const id of traceDriving(seeds, preds, m, taken)) { out[id] = k; taken.add(id); }
  }
  return out;
}

global.PlannerEngine = { EPS, HARD, Cal, D, ISO, YMD, dow, addDays, dateOnly, mk, nowISO, today, calFor, amap, predsOf, succsOf, isMs, ensureDefaultCal, remHours, schedule,
  LAG_CALENDARS, lagCal, addLag, PROGRESS_LOGIC, DEFAULT_NEAR_CRITICAL_DAYS, MAX_FLOAT_PATHS, floatPaths, ELAPSED_CAL, schedCal, elapsedDays, pyRound, pyFixed, pyGroup, pyG, pyStr, pyFloorDiv };
})(typeof window !== 'undefined' ? window : globalThis);

/* ---- part 2: DCMA, generator, patches, commands, repair, levelling, analysis, files ---- */
(function (global) {
const E = global.PlannerEngine;
const { D, ISO, YMD, dow, addDays, dateOnly, calFor, amap, predsOf, succsOf, isMs, ensureDefaultCal, remHours, schedule, EPS, HARD, pyFixed, pyStr } = E;
const clone = o => JSON.parse(JSON.stringify(o));
const round = E.pyRound;
const pct = (n, d) => d ? round(100 * n / d, 1) : 0;
const HIGH_FLOAT = 44, HIGH_DUR = 44;

// ---------- health checks: DCMA 14-point and CIOB Planning Protocol 2021 (planner/dcma.py; the docstring there has each check's rationale) ----------
const CHECK_SETS = ['dcma', 'pp21'];
const DCMA_THRESHOLDS = { logic_pct: 5, leads_pct: 0, lags_pct: 5, fs_pct: 90, hard_constraints_pct: 5, high_float_days: HIGH_FLOAT, high_float_pct: 5, high_duration_days: HIGH_DUR, high_duration_pct: 5, missed_pct: 5, cpli_min: 0.95, bei_min: 0.95 };
const PP21_THRESHOLDS = { max_duration_days: 44, duration_pct: 0, open_ends_pct: 0, lag_pct: 20, density_min: 1, density_max: 4, constraints_pct: 5, max_working_days: 7 };
const g = x => E.pyG(x);                                   // a threshold as text (dcma._g)
const within = (n, d, t) => t <= 0 ? n === 0 : pct(n, d) <= t;   // dcma._within: a zero threshold means none at all
// the effective thresholds: the set's defaults, then p.check_thresholds (the planner's saved edits), then the call's (dcma.check_thresholds)
function checkThresholds(p, checkSet, thresholds) { const out = Object.assign({}, checkSet === 'pp21' ? PP21_THRESHOLDS : DCMA_THRESHOLDS); for (const src of [p.check_thresholds, thresholds]) for (const [k, v] of Object.entries(src || {})) if (v != null && k in out) out[k] = v; return out; }
// healthCheck(p, { checkSet: 'dcma' | 'pp21', thresholds: {...} }); the score is the share of applicable checks that pass
function healthCheck(p, opts) {
  opts = opts || {};
  const want = opts.checkSet || opts.check_set, checkSet = CHECK_SETS.includes(want) ? want : 'dcma';
  const th = checkThresholds(p, checkSet, opts.thresholds);
  const checks = checkSet === 'pp21' ? pp21Checks(p, th) : dcmaChecks(p, th);
  const applicable = checks.filter(c => c.applicable);
  const score = applicable.length ? round(100 * applicable.filter(c => c.passed).length / applicable.length) : 100;
  const fails = applicable.filter(c => !c.passed).map(c => c.title);
  return { score, checks, summary: fails.length ? 'Failing: ' + fails.join(', ') + '.' : 'Schedule passes all applicable checks.', check_set: checkSet, thresholds: th, failing: () => checks.filter(c => c.applicable && !c.passed) };
}
const mkCheck = (checks) => (key, title, passed, o = {}) => checks.push(Object.assign({ key, title, passed, value: null, threshold: null, detail: '', items: [], applicable: true }, o));
const missingLogic = (p, incomplete) => incomplete.filter(a => !((predsOf(p, a.id).length || a.type === 'start_milestone') && (succsOf(p, a.id).length || a.type === 'finish_milestone'))).map(a => a.id);
const negativeFloat = incomplete => incomplete.filter(a => a.total_float_hours != null && a.total_float_hours < -1e-6).map(a => a.id);
const longTasks = (p, incomplete, maxDays) => incomplete.filter(a => !isMs(a) && calFor(p, a).hours_to_days(a.remaining_hours != null ? a.remaining_hours : a.duration_hours) > maxDays).map(a => a.id);
function dcmaChecks(p, th) {
  const checks = [], C = mkCheck(checks);
  const acts = p.activities.filter(a => a.type !== 'level_of_effort');
  const incomplete = acts.filter(a => a.status !== 'complete');
  const nInc = incomplete.length;
  const dataDate = D(p.data_date) || D(p.start);
  const missing = missingLogic(p, incomplete);
  C('logic', 'Missing logic', within(missing.length, nInc, th.logic_pct), { value: pct(missing.length, nInc), threshold: `≤ ${g(th.logic_pct)}%`, detail: `${missing.length} of ${nInc} incomplete activities lack a predecessor or successor.`, items: missing });
  const leads = p.relationships.filter(r => r.lag_hours < 0).map(r => `${r.predecessor_id}->${r.successor_id}`);
  C('leads', 'Leads (negative lag)', within(leads.length, p.relationships.length, th.leads_pct), { value: pct(leads.length, p.relationships.length), threshold: th.leads_pct <= 0 ? `${g(th.leads_pct)}%` : `≤ ${g(th.leads_pct)}%`, detail: `${leads.length} relationships use negative lag.`, items: leads });
  const lags = p.relationships.filter(r => r.lag_hours > 0).map(r => `${r.predecessor_id}->${r.successor_id}`);
  C('lags', 'Lags', within(lags.length, p.relationships.length, th.lags_pct), { value: pct(lags.length, p.relationships.length), threshold: `≤ ${g(th.lags_pct)}%`, detail: `${lags.length} of ${p.relationships.length} relationships carry positive lag.`, items: lags });
  const fs = p.relationships.filter(r => r.type === 'FS').length;
  C('rel_types', 'Finish-to-start share', pct(fs, p.relationships.length) >= th.fs_pct || !p.relationships.length, { value: pct(fs, p.relationships.length), threshold: `≥ ${g(th.fs_pct)}%`, detail: `${fs} of ${p.relationships.length} links are FS.` });
  const hard = incomplete.filter(a => HARD.has(a.constraint)).map(a => a.id);
  C('hard_constraints', 'Hard constraints', within(hard.length, nInc, th.hard_constraints_pct), { value: pct(hard.length, nInc), threshold: `≤ ${g(th.hard_constraints_pct)}%`, detail: `${hard.length} incomplete activities have must-start/finish-on constraints.`, items: hard });
  const hf = incomplete.filter(a => a.total_float_hours != null && calFor(p, a).hours_to_days(a.total_float_hours) > th.high_float_days).map(a => a.id);
  C('high_float', 'High float', within(hf.length, nInc, th.high_float_pct), { value: pct(hf.length, nInc), threshold: `≤ ${g(th.high_float_pct)}%`, detail: `${hf.length} incomplete activities have more than ${g(th.high_float_days)} days total float.`, items: hf });
  const nf = negativeFloat(incomplete);
  C('negative_float', 'Negative float', !nf.length, { value: nf.length, threshold: '0', detail: `${nf.length} activities have negative total float.`, items: nf });
  const hd = longTasks(p, incomplete, th.high_duration_days);
  C('high_duration', 'High duration', within(hd.length, nInc, th.high_duration_pct), { value: pct(hd.length, nInc), threshold: `≤ ${g(th.high_duration_pct)}%`, detail: `${hd.length} incomplete activities are longer than ${g(th.high_duration_days)} working days.`, items: hd });
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
  C('missed_tasks', 'Missed tasks', within(missed.length, due.length, th.missed_pct), { value: pct(missed.length, due.length), threshold: `≤ ${g(th.missed_pct)}%`, applicable: !!baselined.length, detail: `${missed.length} of ${due.length} baseline-due activities missed their finish.`, items: missed });
  const [cpOk, cpDetail] = cpTest(p);
  C('cp_test', 'Critical path test', cpOk, { threshold: 'finish moves with critical delay', detail: cpDetail, applicable: nInc > 0 });
  if (p.must_finish_by && p.finish) { const cal = new E.Cal(p.calendars[p.default_calendar_id]); const cpl = cal.hours_between(dataDate, D(p.finish)); const tf = cal.hours_between(D(p.finish), D(p.must_finish_by)); const cpli = cpl > 0 ? round((cpl + tf) / cpl, 2) : 1; C('cpli', 'Critical path length index', cpli >= th.cpli_min, { value: cpli, threshold: `≥ ${g(th.cpli_min)}`, detail: `Critical path ${pyFixed(cal.hours_to_days(cpl), 0)}d, float to must-finish ${pyFixed(cal.hours_to_days(tf), 0)}d.` }); }
  else C('cpli', 'Critical path length index', true, { applicable: false, detail: 'Set a must-finish-by date to compute CPLI.' });
  const plannedDone = due, actuallyDone = acts.filter(a => a.status === 'complete');
  if (plannedDone.length) { const bei = round(actuallyDone.length / plannedDone.length, 2); C('bei', 'Baseline execution index', bei >= th.bei_min, { value: bei, threshold: `≥ ${g(th.bei_min)}`, detail: `${actuallyDone.length} complete vs ${plannedDone.length} planned complete by data date.` }); }
  else C('bei', 'Baseline execution index', true, { applicable: false, detail: 'Needs a baseline with activities due by the data date.' });
  const starts = incomplete.filter(a => !predsOf(p, a.id).length).map(a => a.id);
  const finishes = incomplete.filter(a => !succsOf(p, a.id).length).map(a => a.id);
  C('open_ends', 'Single start and finish', starts.length <= 1 && finishes.length <= 1, { value: starts.length + finishes.length, threshold: '1 start, 1 finish', detail: `${starts.length} activities have no predecessor, ${finishes.length} have no successor.`, items: [...new Set([...starts, ...finishes])].sort() });
  let dangling = [];
  for (const a of incomplete) { if (isMs(a)) continue; const outs = succsOf(p, a.id); if (outs.length && outs.every(r => r.type === 'SS')) dangling.push(a.id); const ins = predsOf(p, a.id); if (ins.length && ins.every(r => r.type === 'FF')) dangling.push(a.id); }
  dangling = [...new Set(dangling)].sort();
  C('dangling', 'Dangling logic', !dangling.length, { value: dangling.length, threshold: '0', detail: `${dangling.length} activities only drive successors by their start, or are only driven on their finish.`, items: dangling });
  return checks;
}
function pp21Checks(p, th) {
  const checks = [], C = mkCheck(checks);
  const acts = p.activities.filter(a => a.type !== 'level_of_effort');
  const incomplete = acts.filter(a => a.status !== 'complete');
  const nInc = incomplete.length, nRel = p.relationships.length, m = amap(p);
  const dataDate = D(p.data_date) || D(p.start);
  const hd = longTasks(p, incomplete, th.max_duration_days);
  C('pp21_duration', 'Task duration', within(hd.length, nInc, th.duration_pct), { value: pct(hd.length, nInc), threshold: `≤ ${g(th.max_duration_days)} working days (${g(th.duration_pct)}% may exceed)`, detail: `${hd.length} of ${nInc} incomplete tasks are longer than ${g(th.max_duration_days)} working days.`, items: hd });
  const missing = missingLogic(p, incomplete);
  C('pp21_open_ends', 'Open ends', within(missing.length, nInc, th.open_ends_pct), { value: pct(missing.length, nInc), threshold: `≤ ${g(th.open_ends_pct)}%`, detail: `${missing.length} of ${nInc} incomplete activities lack a predecessor or successor.`, items: missing });
  const nf = negativeFloat(incomplete);
  C('pp21_negative_float', 'Negative float', !nf.length, { value: nf.length, threshold: '0', detail: `${nf.length} activities have negative total float.`, items: nf });
  const leads = p.relationships.filter(r => r.lag_hours < 0).map(r => `${r.predecessor_id}->${r.successor_id}`);
  C('pp21_leads', 'Leads (negative lag)', !leads.length, { value: leads.length, threshold: '0', detail: `${leads.length} relationships use negative lag.`, items: leads });
  const longLags = [];
  for (const r of p.relationships) { const sc = m[r.successor_id]; if (r.lag_hours > 0 && sc && r.lag_hours > th.lag_pct / 100 * sc.duration_hours + 1e-9) longLags.push(`${r.predecessor_id}->${r.successor_id}`); }
  C('pp21_lags', 'Lag length', !longLags.length, { value: pct(longLags.length, nRel), threshold: `lag ≤ ${g(th.lag_pct)}% of successor duration`, detail: `${longLags.length} of ${nRel} relationships carry a lag longer than ${g(th.lag_pct)}% of their successor.`, items: longLags });
  const density = acts.length ? round(nRel / acts.length, 2) : 0;
  C('pp21_logic_density', 'Logic density', th.density_min <= density && density <= th.density_max, { value: density, threshold: `${g(th.density_min)} to ${g(th.density_max)} links per activity`, applicable: !!acts.length, detail: `${nRel} relationships over ${acts.length} activities: ${g(density)} per activity.` });
  const con = incomplete.filter(a => a.constraint !== 'none').map(a => a.id);
  C('pp21_constraints', 'Constraints', within(con.length, nInc, th.constraints_pct), { value: pct(con.length, nInc), threshold: `≤ ${g(th.constraints_pct)}%`, detail: `${con.length} of ${nInc} incomplete activities carry a date constraint.`, items: con });
  const msBad = [];
  for (const a of incomplete) { if (a.type === 'start_milestone' && !succsOf(p, a.id).length) msBad.push(a.id); else if (a.type === 'finish_milestone' && !predsOf(p, a.id).length) msBad.push(a.id); }
  const nMs = incomplete.filter(isMs).length;
  C('pp21_milestones', 'Milestones linked', !msBad.length, { value: msBad.length, threshold: '0', applicable: nMs > 0, detail: `${msBad.length} of ${nMs} milestones are not linked to the work.`, items: msBad });
  let bad = [];
  for (const a of acts) {
    if (a.actual_start && D(a.actual_start) > dataDate) bad.push(a.id);
    if (a.actual_finish && D(a.actual_finish) > dataDate) bad.push(a.id);
    if (a.status === 'not_started' && a.early_start && D(a.early_start) < dataDate) bad.push(a.id);
    if (a.status === 'in_progress' && (!a.actual_start || (a.early_finish && D(a.early_finish) < dataDate))) bad.push(a.id);
    if (a.status === 'complete' && !a.actual_finish) bad.push(a.id);
  }
  bad = [...new Set(bad)].sort();
  C('pp21_progress', 'Progress consistent', !bad.length, { value: bad.length, threshold: '0', detail: `${bad.length} activities have actual dates after, or remaining work before, the data date.`, items: bad });
  const openActs = incomplete.filter(a => a.early_finish), crit = openActs.filter(a => a.critical);
  let ok = true, atEnd = [], detail = 'No open activities.';
  if (openActs.length) {
    let end = null; for (const a of openActs) { const f = D(a.early_finish); if (!end || f > end) end = f; }
    atEnd = crit.filter(a => D(a.early_finish) >= end).map(a => a.id);
    ok = crit.length > 0 && atEnd.length > 0;
    detail = ok ? `${crit.length} critical activities; the path ends at the finish (${atEnd.slice(0, 5).join(', ')}).` : crit.length ? 'No critical activity ends at the programme finish.' : 'No critical path.';
  }
  C('pp21_critical_path', 'Critical path', ok, { value: crit.length, threshold: 'exists, ends at the finish', applicable: !!openActs.length, detail, items: atEnd });
  const calBad = [], calIds = Object.keys(p.calendars || {}).sort();
  for (const cid of calIds) { const c = p.calendars[cid], hpd = c.hours_per_day != null ? c.hours_per_day : 8, days = c.working_days || [0, 1, 2, 3, 4]; const wd = new Set(days.filter(d => d >= 0 && d <= 6)); if (!(hpd > 0 && hpd <= 24) || !wd.size || wd.size > th.max_working_days || wd.size !== days.length) calBad.push(cid); }
  C('pp21_calendars', 'Calendars', !calBad.length, { value: calBad.length, threshold: `1 to ${g(th.max_working_days)} working days, 0 to 24 hours`, applicable: calIds.length > 0, detail: `${calBad.length} of ${calIds.length} calendars have an impossible working week or day.`, items: calBad });
  return checks;
}
function cpTest(p) {
  const crit = p.activities.filter(a => a.critical && a.status !== 'complete' && !isMs(a));
  if (!crit.length || !p.finish) return [true, 'No incomplete critical activities to test.'];
  const trial = clone(p); const t = trial.activities.find(a => a.id === crit[0].id);
  const push = E.schedCal(trial, t).days_to_hours(600);
  if (t.status === 'in_progress' && t.remaining_hours != null) t.remaining_hours += push; else { t.duration_hours += push; if (t.remaining_hours != null) t.remaining_hours += push; }
  try { schedule(trial); } catch (e) { return [false, 'Could not schedule the trial: ' + e.message]; }
  const moved = Math.floor((D(trial.finish) - D(p.finish)) / 86400000);   // timedelta.days floors
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
// Port of planner.plan._parse_date: datetime.strptime over four formats, using CPython's own
// field patterns (anchored, case-insensitive), then the same calendar validation. A supplied
// time is kept; a bare date (or midnight) gets `hour`.
const P2h = n => String(n).padStart(2, '0');
const SP = { Y: '(\\d\\d\\d\\d)', m: '(1[0-2]|0[1-9]|[1-9])', d: '(3[01]|[12]\\d|0[1-9]|[1-9]| [1-9])', H: '(2[0-3]|[0-1]\\d|\\d)', M: '([0-5]\\d|\\d)', S: '(6[0-1]|[0-5]\\d|\\d)' };
const DATE_FORMATS = [
  [new RegExp(`^${SP.Y}-${SP.m}-${SP.d}$`, 'i'), g => [g[1], g[2], g[3], 0, 0, 0]],
  [new RegExp(`^${SP.Y}-${SP.m}-${SP.d}T${SP.H}:${SP.M}:${SP.S}$`, 'i'), g => [g[1], g[2], g[3], g[4], g[5], g[6]]],
  [new RegExp(`^${SP.Y}-${SP.m}-${SP.d}\\s+${SP.H}:${SP.M}$`, 'i'), g => [g[1], g[2], g[3], g[4], g[5], 0]],
  [new RegExp(`^${SP.d}/${SP.m}/${SP.Y}$`, 'i'), g => [g[3], g[2], g[1], 0, 0, 0]],
];
function parseDate(s, hour = 8) {
  if (!s) return null; const t = String(s).trim();
  for (const [re, pick] of DATE_FORMATS) {
    const g = t.match(re); if (!g) continue;
    const [y, mo, d, h, mi, sec] = pick(g).map(Number);
    if (y < 1 || d > new Date(Date.UTC(y, mo, 0)).getUTCDate() || sec > 59) continue;   // datetime() would raise
    return `${String(y).padStart(4, '0')}-${P2h(mo)}-${P2h(d)}T${P2h(h || mi ? h : hour)}:${P2h(mi)}:${P2h(sec)}`;
  }
  return null;
}
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
      else if (op.op === 'set_duration') { const a = m[op.activity_id]; if (!a) throw new Error('unknown'); a.duration_hours = d2h(p, a, Math.max(0, op.duration_days || 0)); if (a.status === 'in_progress') a.remaining_hours = op.remaining_days != null ? d2h(p, a, op.remaining_days) : Math.max(0, a.duration_hours * (1 - a.percent_complete / 100)); log.push(`${a.id} duration -> ${op.duration_days == null ? 'None' : pyStr(op.duration_days)}d`); }
      else if (op.op === 'set_type') { const a = m[op.activity_id]; if (!a) throw new Error('unknown'); a.type = op.activity_type || 'task'; if (a.type !== 'task') a.duration_hours = 0; log.push(`${a.id} type -> ${a.type}`); }
      else if (op.op === 'set_calendar') { const a = m[op.activity_id]; if (!a) throw new Error('unknown'); const old = calFor(p, a); a.calendar_id = op.calendar || 'standard'; a.duration_hours = calFor(p, a).days_to_hours(old.hours_to_days(a.duration_hours)); log.push(`${a.id} calendar -> ${a.calendar_id}`); }
      else if (op.op === 'add_link') { if (!m[op.predecessor_id] || !m[op.successor_id]) throw new Error('unknown activity in link'); if (op.predecessor_id === op.successor_id) throw new Error('cannot link an activity to itself'); const lt = op.link_type || 'FS'; p.relationships = p.relationships.filter(r => !(r.predecessor_id === op.predecessor_id && r.successor_id === op.successor_id && r.type === lt)); p.relationships.push({ predecessor_id: op.predecessor_id, successor_id: op.successor_id, type: lt, lag_hours: d2h(p, m[op.predecessor_id], op.lag_days || 0) }); log.push(`linked ${op.predecessor_id} -${lt}${op.lag_days ? '+' + pyStr(op.lag_days) + 'd' : ''}-> ${op.successor_id}`); }
      else if (op.op === 'remove_link') { const b = p.relationships.length; p.relationships = p.relationships.filter(r => !(r.predecessor_id === op.predecessor_id && r.successor_id === op.successor_id && (op.link_type == null || r.type === op.link_type))); log.push(`removed ${b - p.relationships.length} link(s) ${op.predecessor_id}->${op.successor_id}`); }
      else if (op.op === 'set_constraint') { const a = m[op.activity_id]; if (!a) throw new Error('unknown'); a.constraint = op.constraint_type || 'start_on_or_after'; a.constraint_date = parseDate(op.date, a.constraint.includes('finish') ? 16 : 8); log.push(`${a.id} constraint -> ${a.constraint} ${op.date}`); }
      else if (op.op === 'clear_constraint') { const a = m[op.activity_id]; if (!a) throw new Error('unknown'); a.constraint = 'none'; a.constraint_date = null; log.push(`${a.id} constraint cleared`); }
      else if (op.op === 'set_progress') { const a = m[op.activity_id]; if (!a) throw new Error('unknown'); if (op.actual_start) a.actual_start = parseDate(op.actual_start); if (op.actual_finish) { a.actual_finish = parseDate(op.actual_finish, 16); a.status = 'complete'; a.percent_complete = 100; a.remaining_hours = 0; } else if (op.percent_complete != null || op.remaining_days != null || a.actual_start) { a.status = 'in_progress'; if (op.percent_complete != null) a.percent_complete = op.percent_complete; a.remaining_hours = op.remaining_days != null ? d2h(p, a, op.remaining_days) : Math.max(0, a.duration_hours * (1 - a.percent_complete / 100)); if (!a.actual_start) a.actual_start = p.data_date || p.start; } log.push(`${a.id} progress -> ${a.status} ${pyStr(a.percent_complete)}%`); }
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
global.PlannerEngine.checkThresholds = checkThresholds;
global.PlannerEngine.CHECK_SETS = CHECK_SETS;
global.PlannerEngine.DCMA_THRESHOLDS = DCMA_THRESHOLDS;
global.PlannerEngine.PP21_THRESHOLDS = PP21_THRESHOLDS;
global.PlannerEngine.applyPatch = applyPatch;
global.PlannerEngine.ensureCalendars = ensureCalendars;
global.PlannerEngine.parseDate = parseDate;
global.PlannerEngine.clone = clone;
})(typeof window !== 'undefined' ? window : globalThis);

/* ---- part 3: generator, draft_to_project, levelling, analysis, repair, commands ---- */
(function (global) {
const E = global.PlannerEngine;
const { D, ISO, YMD, dow, addDays, dateOnly, calFor, amap, predsOf, succsOf, isMs, schedule, EPS, HARD, applyPatch, healthCheck, ensureCalendars, parseDate, clone, pyRound, pyFixed, pyGroup, pyFloorDiv } = E;

const RATES = { site_setup_base: 5, site_setup_per_1000m2: 1, demolition_m2_per_day: 120, service_diversion_lead_in_days: 40, service_diversion_days: 15, remediation_m2_per_day: 100, reduce_level_m2_per_day: 250, basement_m2_per_day: 25, strip_found_m2_per_day: 60, raft_m2_per_day: 90, piles_per_day: 8, m2_per_pile: 40, pile_caps_m2_per_day: 120, drainage_m2_per_day: 150, ground_slab_m2_per_day: 120, masonry_wall_m2_per_day: 12, masonry_features_m2_per_day: 150, frame_rc_m2_per_day: 45, rc_cure_days: 3, frame_steel_m2_per_day: 180, steel_deck_m2_per_day: 150, frame_timber_m2_per_day: 120, roof_m2_per_day: 70, envelope_brick_m2_per_day: 45, envelope_render_m2_per_day: 70, envelope_cladding_m2_per_day: 70, envelope_curtain_wall_m2_per_day: 25, windows_base: 3, windows_per_storey: 2, scaffold_base: 3, scaffold_per_storey: 2, first_fix_m2_per_day: 90, drylining_m2_per_day: 70, screed_m2_per_day: 250, second_fix_m2_per_day: 80, decoration_m2_per_day: 110, finishes_m2_per_day: 160, commissioning_base: 10, commissioning_per_storey: 2, externals_base: 10, externals_m2_per_day: 120, snagging_days: 10, max_activity_days: 40, zone_m2: 900 };
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
  while ((m = re.exec(t))) {
    if (out.some(o => Math.abs(o[0] - m.index) < 12)) continue;
    const y = +m[2], mo = MONTHS[m[1]];
    // "end of November 2026" is the last day of the month; a bare "November 2026" is the 1st
    const last = /\bend(?:\s+of)?\s+$/.test(t.slice(Math.max(0, m.index - 8), m.index));
    out.push([m.index, last ? isoDate(y, mo, new Date(Date.UTC(y, mo, 0)).getUTCDate()) : isoDate(y, mo, 1)]);
  }
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
  m = t.match(/(\d[\d,]*(?:\.\d+)?)\s*(?:sq\.?\s*ft|ft2|square feet)/); if (m && !b.gross_internal_area_m2) b.gross_internal_area_m2 = pyRound(parseFloat(m[1].replace(/,/g, '')) / 10.764);
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
  m = text.match(/^\s*([^.\n]{8,80})/); if (m) { let n = m[1].trim(); const first = n.split(',')[0].trim(); n = (first.length >= 8 ? first : n).replace(/,+$/, '').slice(0, 60); b.name = n.charAt(0).toUpperCase() + n.slice(1); }
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
  if (!b.start_date) { const t = E.today(); const off = (7 - dow(t)) % 7 || 7; b.start_date = YMD(addDays(t, off)); }
  return b;
}
const gdays = (x, lo = 1) => Math.max(lo, pyRound(x * 2) / 2);
const commas = pyGroup;

function generate(brief) {
  const b = defaults(brief), R = RATES;
  const acts = [], wbs = []; let n = 990; const assumptions = [];
  const cal = b.six_day_week ? 'six_day' : 'standard';
  const nid = () => { n += 10; return 'A' + n; };
  const add = (name, w, days, preds = [], trade = '', atype = 'task', calendar = null, crew = 0) => { const aid = nid(); const links = (preds || []).map(x => typeof x === 'string' ? { predecessor_id: x, type: 'FS', lag_days: 0 } : { predecessor_id: x[0], type: x[1], lag_days: x[2] }); acts.push({ id: aid, name, wbs_code: w, type: atype, duration_days: atype !== 'task' ? 0 : gdays(days), calendar: calendar || cal, predecessors: links, trade, crew_size: crew, codes: {} }); return aid; };
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
  if (b.service_diversion) { const leadIn = add('Statutory diversion lead-in (application, design and quotation)', W['Enabling works'], R.service_diversion_lead_in_days, [start]); enabling.push(add('Service diversions and temporary supplies', W['Enabling works'], R.service_diversion_days, [leadIn], 'Utilities contractor')); assumptions.push(`Statutory diversions: ${Math.floor(R.service_diversion_lead_in_days / 5)}-week undertaker lead-in, then ${R.service_diversion_days} working days on site. Undertakers quote 8-26 weeks, so confirm with the DNO/water/gas before relying on this date`); }
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
  const F = W['Frame and upper floors']; const frameIds = []; let firstLift = null; const perim = 4 * Math.sqrt(footprint); const wallPer = perim * 3.2; let prev = subDone;
  for (let lvl = 0; lvl < storeys; lvl++) {
    const label = lvl === 0 ? 'ground floor' : `level ${lvl}`;
    if (b.frame === 'rc') { const cols = add(`RC columns and walls - ${label}`, F, footprint / R.frame_rc_m2_per_day + 2, [prev], 'RC frame contractor', 'task', null, 8); const deck = add(`Suspended slab formwork, rebar and pour - ${label}`, F, footprint / R.frame_rc_m2_per_day + 3, [cols], 'RC frame contractor', 'task', null, 8); prev = add(`Slab cure - ${label}`, F, R.rc_cure_days, [deck], '', 'task', 'seven_day'); }
    else if (b.frame === 'steel') { if (lvl === 0) { prev = add('Steel frame erection (all levels)', F, gia / R.frame_steel_m2_per_day + 4, [prev], 'Steel erectors', 'task', null, 6); assumptions.push('Steel frame erected in one continuous visit; decking and concrete floors follow floor by floor'); } if (lvl > 0) prev = add(`Metal decking and concrete topping - ${label}`, F, footprint / R.steel_deck_m2_per_day + 2, lvl === 1 ? [prev] : [[prev, 'FS', 0]], 'Decking contractor', 'task', null, 4); }
    else if (b.frame === 'timber') prev = add(`Timber frame panels and floor cassettes - ${label}`, F, footprint / R.frame_timber_m2_per_day + 1, [prev], 'Timber frame erectors', 'task', null, 5);
    else { const lift = add(`Brick and block to ${lvl === 0 ? 'first floor' : lvl + 1 < storeys ? 'level ' + (lvl + 1) : 'wall plate'}`, F, wallPer / R.masonry_wall_m2_per_day, [prev], 'Bricklayers', 'task', null, 6); firstLift = firstLift || lift; prev = lvl + 1 < storeys ? add(`Floor joists or precast planks - level ${lvl + 1}`, F, footprint / 300 + 2, [lift], 'Carpenters', 'task', null, 3) : lift; }
    frameIds.push(prev);
  }
  const frameDone = add('Frame complete', F, 0, [prev], '', 'finish_milestone');
  const En = W['Roof and envelope'];
  const scaffold = add('Erect scaffold, inspect and hand over', En, R.scaffold_base + R.scaffold_per_storey * storeys, firstLift ? [[firstLift, 'SS', 0]] : [frameIds[0]], 'Scaffolders', 'task', null, 4);
  const roof = add('Roof structure' + (b.roof === 'pitched' ? ' and trusses' : ' and screed to falls'), En, footprint / R.roof_m2_per_day + 3, [frameDone, scaffold], b.roof === 'pitched' ? 'Roofers' : 'Roofing contractor', 'task', null, 4);
  const roofCover = add('Roof covering' + (b.roof === 'pitched' ? ' (felt, batten, tile)' : ' (membrane and insulation)'), En, footprint / R.roof_m2_per_day + 2, [roof], 'Roofers', 'task', null, 4);
  const shellBuilt = b.frame === 'masonry' && b.envelope === 'brick'; const envRate = shellBuilt ? R.masonry_features_m2_per_day : R['envelope_' + b.envelope + '_m2_per_day'];
  const envIds = []; let envPrev = null;
  for (let lvl = 0; lvl < storeys; lvl++) { const label = lvl === 0 ? 'ground floor' : `level ${lvl}`; const preds = b.frame !== 'masonry' ? [frameIds[Math.min(lvl + 1, storeys - 1)]] : [frameDone]; if (envPrev) preds.push(envPrev); else preds.push(scaffold); envPrev = add(`${shellBuilt ? 'Pointing, cavity closers and brick features' : `External envelope (${b.envelope.replace(/_/g, ' ')})`} - ${label}`, En, wallPer / envRate + 1, preds, ['brick', 'render'].includes(b.envelope) ? 'Bricklayers' : 'Cladding contractor', 'task', null, 6); envIds.push(envPrev); }
  if (b.frame === 'masonry') assumptions.push(`Masonry shell: both leaves built with the structure at ${R.masonry_wall_m2_per_day} m² of wall per gang-day` + (shellBuilt ? '; envelope activities cover pointing, cavity closers and feature brick only' : `; ${b.envelope.replace(/_/g, ' ')} applied once the shell is up`));
  const windows = add('Windows, curtain walling and external doors', En, R.windows_base + R.windows_per_storey * storeys, [envIds[envIds.length - 1]], 'Window fitters', 'task', null, 3);
  const rwg = add('Fascias, soffits and rainwater goods', En, footprint / 200 + 2, [roofCover], 'Roofers');
  const watertight = add('Watertight', En, 0, [roofCover, windows, envIds[envIds.length - 1]], '', 'finish_milestone');
  const strike = add('Strike scaffold', En, 2 + storeys, [rwg, windows, envIds[envIds.length - 1]], 'Scaffolders');
  const I = W['Internal fit-out']; let lastSecond = []; const prevFloor = {};
  if (b.fit_out !== 'shell') {
    for (let lvl = 0; lvl < storeys; lvl++) {
      const label = lvl === 0 ? 'ground floor' : `level ${lvl}`, area = footprint;
      // One trade across the floor in zones, flowing like a production line: zone z waits for the
      // previous trades' zone z, not their whole floor. preds items: an id (gates zone 1) or a zone list.
      const stage = (key, name, rk, preds, trade) => { const total = area / R[rk], own = []; for (let z = 0; z < zones; z++) { let p; if (z === 0) { p = preds.map(q => typeof q === 'string' ? q : q[0]); if (key in prevFloor) p.push(prevFloor[key]); } else { p = [own[own.length - 1]].concat(preds.filter(q => typeof q !== 'string').map(q => q[z])); } own.push(add(`${name} - ${label}` + (zones > 1 ? ` - zone ${z + 1}` : ''), I, total / zones, p, trade)); } prevFloor[key] = own[own.length - 1]; return own; };
      const ffPred = lvl === storeys - 1 ? [watertight] : [frameIds[Math.min(lvl + 1, storeys - 1)], envIds[lvl]];
      const carp = stage('carp1', 'First fix carpentry and partitions', 'first_fix_m2_per_day', ffPred, 'Carpenters');
      const mep1 = stage('mep1', 'First fix mechanical and electrical', 'first_fix_m2_per_day', [carp], 'M&E contractor');
      const dry = stage('dry', 'Drylining, plastering and ceilings', 'drylining_m2_per_day', [carp, mep1].concat(lvl < storeys - 1 ? [watertight] : []), 'Dryliners');
      let base;
      if (b.fit_out === 'full') { const scr = stage('screed', 'Screed', 'screed_m2_per_day', [dry], 'Screeders'); const dryOut = []; for (let z = 0; z < zones; z++) dryOut.push(add(`Drying out - ${label}` + (zones > 1 ? ` - zone ${z + 1}` : ''), I, 5, [scr[z], dry[z]], '', 'task', 'seven_day')); base = [dryOut]; } else base = [dry];
      const carp2 = stage('carp2', 'Second fix carpentry, doors and joinery', 'second_fix_m2_per_day', base, 'Carpenters');
      const mep2 = stage('mep2', 'Second fix mechanical and electrical', 'second_fix_m2_per_day', [carp2], 'M&E contractor');
      if (b.fit_out === 'full') { let decPred; if (['house', 'houses', 'apartments'].includes(b.building_type)) { const kit = stage('kit', 'Kitchens, bathrooms and tiling', 'second_fix_m2_per_day', [carp2, mep2], 'Kitchen and bathroom fitters'); decPred = [kit, mep2]; } else decPred = [carp2, mep2]; const dec = stage('dec', 'Decoration', 'decoration_m2_per_day', decPred, 'Decorators'); const fin = stage('fin', 'Floor finishes', 'finishes_m2_per_day', [dec], 'Floor layers'); lastSecond.push(fin[fin.length - 1], mep2[mep2.length - 1]); } else lastSecond.push(carp2[carp2.length - 1], mep2[mep2.length - 1]);
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
  const start = parseDate(draft.start_date) || E.nowISO();
  const pid = (draft.project_id || '').replace(/[^A-Za-z0-9-]+/g, '-').replace(/^-|-$/g, '').slice(0, 12) || 'PROJ';
  const p = { id: pid, name: draft.project_name, start, data_date: start, must_finish_by: parseDate(draft.must_finish_by, 16), default_calendar_id: 'standard', calendars: {}, wbs: [], activities: [], relationships: [], resources: [], assignments: [], description, assumptions: (draft.assumptions || []).slice(), code_types: {}, baselines: [], revisions: [], levelled: false, finish: null, scheduled_at: null };
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
// level(p, options): options over p.levelling; resources, from, to, within_float, order, preserve_actuals; the exact rules and the
// report records {id, delay_hours, resource_id, waited_for, reason} are the docstring of planner/levelling.py
const LEVEL_ORDERS = ['late_start', 'priority', 'total_float', 'early_start'], LEVEL_REASONS = ['capacity', 'within_float_blocked', 'window'];
function levelOptions(p, options) { return Object.assign({}, p.levelling || {}, options || {}); }
function levelKey(a, order, p) {
  const ls = D(a.late_start || a.early_start || p.start).getTime();
  if (order === 'priority') return [a.priority, ls, a.id];
  if (order === 'total_float') return [a.total_float_hours == null ? Infinity : a.total_float_hours, ls, a.priority, a.id];
  if (order === 'early_start') return [D(a.early_start || p.start).getTime(), a.priority, a.id];
  return [ls, a.priority, a.id];
}
const keyLess = (x, y) => { for (let i = 0; i < x.length; i++) { if (x[i] < y[i]) return true; if (x[i] > y[i]) return false; } return false; };
function levellingReport(p) { return (p.levelling_report || []).map(r => Object.assign({}, r)); }
function level(p, options) {
  schedule(p);
  const opts = levelOptions(p, options);
  const subset = opts.resources && opts.resources.length ? new Set(opts.resources) : null;
  const limits = {}; p.resources.forEach(r => { if (r.max_units_per_day && (!subset || subset.has(r.id))) limits[r.id] = r.max_units_per_day; });
  if (!Object.keys(limits).length) { p.levelled = false; p.levelling_report = null; return p; }
  const order = LEVEL_ORDERS.includes(opts.order) ? opts.order : 'late_start', withinFloat = !!opts.within_float;
  const wFrom = opts.from ? YMD(D(opts.from)) : null, wTo = opts.to ? YMD(D(opts.to)) : null;
  const m = amap(p), usage = {}, users = {}, preds = {}, succs = {}, indeg = {};
  p.activities.forEach(a => { preds[a.id] = []; succs[a.id] = []; indeg[a.id] = 0; });
  for (const r of p.relationships) { preds[r.successor_id].push(r); succs[r.predecessor_id].push(r); indeg[r.successor_id]++; }
  const ready = p.activities.filter(a => indeg[a.id] === 0).map(a => ({ k: levelKey(a, order, p), id: a.id }));
  const pop = () => { let bi = 0; for (let i = 1; i < ready.length; i++) if (keyLess(ready[i].k, ready[bi].k)) bi = i; return ready.splice(bi, 1)[0]; };
  const done = {}, dataDate = D(p.data_date) || D(p.start), report = [];
  const firstConflict = (cal, start, finish, demand) => { let d = dateOnly(start); const end = dateOnly(finish); while (d <= end) { if (cal.is_working(d)) { const key = YMD(d); for (const rid of Object.keys(demand).sort()) if ((usage[rid] && usage[rid][key] || 0) + demand[rid] > limits[rid] + EPS) return [d, rid]; } d = addDays(d, 1); } return [null, null]; };
  while (ready.length) {
    const { id: aid } = pop(); const a = m[aid], cal = E.schedCal(p, a), origEs = D(a.early_start); let start, finish;
    let resourceId = null, waitedFor = null, reason = null;
    if (a.status === 'complete' || a.status === 'in_progress') { start = D(a.early_start); finish = D(a.early_finish); }
    else {
      let floor = cal.next_working_start(D(p.start) > dataDate ? D(p.start) : dataDate), floorBy = null, efFloor = null;
      for (const r of preds[aid]) { const pr = m[r.predecessor_id], lcal = E.lagCal(p, r, pr, a); const dd = done[pr.id] || [D(pr.early_start), D(pr.early_finish)]; const ps = dd[0], pf = dd[1]; if (r.type === 'FS') { const t = E.addLag(lcal, pf, r.lag_hours); if (t > floor) { floor = t; floorBy = pr.id; } } else if (r.type === 'SS') { const t = E.addLag(lcal, ps, r.lag_hours); if (t > floor) { floor = t; floorBy = pr.id; } } else if (r.type === 'FF') { const t = E.addLag(lcal, pf, r.lag_hours); efFloor = efFloor === null || t > efFloor ? t : efFloor; } else { const t = E.addLag(lcal, ps, r.lag_hours); efFloor = efFloor === null || t > efFloor ? t : efFloor; } }
      if (a.constraint_date && ['start_on_or_after', 'must_start_on'].includes(a.constraint)) { const cd = D(a.constraint_date); if (cd > floor) floor = cd; }
      const es0 = D(a.early_start) || floor; start = cal.next_working_start(floor > es0 ? floor : es0);
      const rem = a.duration_hours; finish = rem > 0 ? cal.add_hours(start, rem) : start;
      if (efFloor && efFloor > finish) { finish = rem > 0 ? efFloor : cal.prev_working_end(efFloor); start = rem > 0 ? cal.add_hours(finish, -rem) : finish; }
      const demand = {}; for (const [rid, u] of Object.entries(dailyDemand(p, a))) if (rid in limits) demand[rid] = u;
      if (Object.keys(demand).length && rem > 0) {
        const logicStart = start, logicFinish = finish, esDay = YMD(origEs || start);
        const inWindow = (!wFrom || esDay >= wFrom) && (!wTo || esDay <= wTo);
        for (let guard = 0; guard < 5000; guard++) {
          const [conflict, rid] = firstConflict(cal, start, finish, demand);
          if (!conflict) break;
          resourceId = rid; reason = 'capacity';
          const u = users[rid] && users[rid][YMD(conflict)]; waitedFor = u && u.length ? u[u.length - 1] : null;
          if (!inWindow) { reason = 'window'; break; }
          start = cal.next_working_start(new Date(dateOnly(addDays(conflict, 1)))); finish = cal.add_hours(start, rem);
          if (withinFloat && a.late_start && start > D(a.late_start)) { start = logicStart; finish = logicFinish; reason = 'within_float_blocked'; break; }
        }
        let d = dateOnly(start); const end = dateOnly(finish);
        while (d <= end) { if (cal.is_working(d)) for (const [rid, u] of Object.entries(demand)) { usage[rid] = usage[rid] || {}; users[rid] = users[rid] || {}; const key = YMD(d); usage[rid][key] = (usage[rid][key] || 0) + u; (users[rid][key] = users[rid][key] || []).push(aid); } d = addDays(d, 1); }
      }
      if (reason === null && origEs && start > origEs && floorBy) { reason = 'capacity'; waitedFor = floorBy; }
    }
    done[aid] = [start, finish]; a.level_delay_hours = origEs ? pyRound(cal.hours_between(origEs, start), 2) : 0;
    a.early_start = ISO(start); a.early_finish = ISO(finish);
    if (reason !== null && (a.level_delay_hours > 0 || reason !== 'capacity')) report.push({ id: aid, delay_hours: a.level_delay_hours, resource_id: resourceId, waited_for: waitedFor, reason });
    for (const r of succs[aid]) { if (--indeg[r.successor_id] === 0) { const sc = m[r.successor_id]; ready.push({ k: levelKey(sc, order, p), id: sc.id }); } }
  }
  let fin = null; for (const a of p.activities) { const f = D(a.early_finish); if (f && (!fin || f > fin)) fin = f; } p.finish = ISO(fin || D(p.start));
  for (const a of p.activities) if (a.late_finish && a.early_finish) { const cal = E.schedCal(p, a); a.total_float_hours = pyRound(cal.hours_between(D(a.early_finish), D(a.late_finish)), 4); a.critical = a.total_float_hours <= EPS; }
  p.levelling_report = report.sort((x, y) => x.id < y.id ? -1 : x.id > y.id ? 1 : 0);
  p.levelled = true; return p;
}
function unlevel(p) { p.activities.forEach(a => a.level_delay_hours = 0); p.levelled = false; p.levelling_report = null; return schedule(p); }
function setBaseline(p, name = 'Baseline') { schedule(p); const bl = { name, saved_at: E.nowISO(), finish: p.finish, dates: {} }; for (const a of p.activities) { const s = a.actual_start || a.early_start, f = a.actual_finish || a.early_finish; bl.dates[a.id] = { start: s, finish: f, duration_hours: a.duration_hours }; a.baseline_start = s; a.baseline_finish = f; } p.baselines = p.baselines.filter(b => b.name !== name).concat([bl]); return bl; }
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
  for (const [rid, series] of Object.entries(perRes)) { if (resourceId && rid !== resourceId) continue; const rows = Object.entries(series).sort().map(([d, u]) => ({ date: d, units: pyRound(u, 2) })); const over = rows.filter(r => limits[rid] && r.units > limits[rid] + 1e-6); const vals = Object.values(series); out.push({ resource_id: rid, name: names[rid] || rid, limit: limits[rid] ?? null, days: rows, peak: vals.length ? pyRound(Math.max(...vals), 2) : 0, overallocated_days: over.length, total_units: pyRound(vals.reduce((a, b) => a + b, 0), 1) }); }
  out.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);   // Python sorts by code point, not locale
  const [d0, d1] = span(p);
  return { from: d0, to: d1, resources: out };
}
function span(p) {
  const starts = p.activities.map(a => a.actual_start || a.early_start).filter(Boolean).map(D);
  const ends = p.activities.map(a => a.actual_finish || a.early_finish).filter(Boolean).map(D);
  if (!starts.length) return [YMD(D(p.start)), YMD(D(p.start))];
  return [YMD(new Date(Math.min(...starts))), YMD(new Date(Math.max(...ends)))];
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
  for (const w of weeks) { cp[0] += wp[w] || 0; cp[1] += wb[w] || 0; cp[2] += we[w] || 0; cp[3] += wa[w] || 0; rows.push({ week: YMD(new Date(w)), planned: pyRound(cp[0]), baseline: pyRound(cp[1]), earned: pyRound(cp[2]), actual: pyRound(cp[3]) }); }
  const metrics = { budget: pyRound(budget), bcws: pyRound(bcws), bcwp: pyRound(bcwp), acwp: pyRound(acwp), spi: bcws ? pyRound(bcwp / bcws, 2) : null, cpi: acwp ? pyRound(bcwp / acwp, 2) : null, sv: pyRound(bcwp - bcws), cv: acwp ? pyRound(bcwp - acwp) : null, data_date: YMD(dataDate) };
  return { weeks: rows, metrics, has_baseline: p.activities.some(a => a.baseline_start) };
}
function variance(p) { const out = []; for (const a of p.activities) { if (!a.baseline_finish) continue; const cal = calFor(p, a); const f = D(a.actual_finish || a.early_finish), s = D(a.actual_start || a.early_start); out.push({ id: a.id, name: a.name, start_variance_days: a.baseline_start && s ? pyRound(cal.hours_to_days(cal.hours_between(D(a.baseline_start), s)), 1) : null, finish_variance_days: f ? pyRound(cal.hours_to_days(cal.hours_between(D(a.baseline_finish), f)), 1) : null }); } return out; }

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
  for (const a of incomplete) { if (isMs(a) || a.status !== 'not_started') continue; const cal = calFor(p, a); const days = cal.hours_to_days(a.duration_hours); if (days > 44) { const parts = -pyFloorDiv(-days, 44); const per = pyRound(days / parts, 1); let prev = a.id; ops.push({ op: 'set_duration', activity_id: a.id, duration_days: per, reason: `Split ${a.id} (${pyFixed(days, 0)}d) into ${parts} stages` }); ops.push({ op: 'rename', activity_id: a.id, name: `${a.name} - stage 1` }); const succs = succsOf(p, a.id); for (let i = 2; i <= parts; i++) { const nid = `${a.id}-${i}`; ops.push({ op: 'add_activity', activity_id: nid, name: `${a.name} - stage ${i}`, duration_days: per, wbs_code: a.wbs_id, calendar: ['standard', 'six_day', 'seven_day'].includes(a.calendar_id) ? a.calendar_id : null, predecessor_id: prev, link_type: 'FS', reason: 'stage split' }); prev = nid; } for (const s of succs) if (s.type === 'FS' || s.type === 'FF') { ops.push({ op: 'remove_link', predecessor_id: a.id, successor_id: s.successor_id, link_type: s.type }); ops.push({ op: 'add_link', predecessor_id: prev, successor_id: s.successor_id, link_type: s.type, lag_days: cal.hours_to_days(s.lag_hours), reason: 'moved successor link to last stage' }); } } }
  const neg = incomplete.filter(a => a.total_float_hours != null && a.total_float_hours < 0);
  if (neg.length) { const worst = neg.reduce((a, b) => a.total_float_hours <= b.total_float_hours ? a : b); const cal = calFor(p, worst); let cause = p.must_finish_by ? 'the must-finish-by date' : 'a finish constraint'; const con = neg.find(a => ['finish_on_or_before', 'must_finish_on', 'start_on_or_before'].includes(a.constraint)); if (con) cause = `the ${con.constraint.replace(/_/g, ' ')} constraint on ${con.id}`; stillOpen.push(`Negative float of ${pyFixed(cal.hours_to_days(worst.total_float_hours), 0)} days against ${cause}. Options: move the date, add resource to critical activities, or re-sequence. Use commands to try each.`); }
  const byk = {}; report.checks.forEach(c => byk[c.key] = c);
  if (byk.high_float && !byk.high_float.passed) stillOpen.push('High float on ' + byk.high_float.items.slice(0, 6).join(', ') + ': usually missing logic or a very early deadline; review after the links above are added.');
  if (byk.lags && !byk.lags.passed) stillOpen.push('Positive lags exceed 5% of links. Replace the longest with a real activity (cure, drying, approval) if the client\'s reviewer is strict.');
  if (byk.resources && byk.resources.applicable && !byk.resources.passed) stillOpen.push("Some activities have no trade assigned; assign with the command 'assign <id> <trade>'.");
  const nLinks = ops.filter(o => o.op === 'add_link').length;
  let msg = ops.length ? `Applied ${ops.length} repair operations (${nLinks} links, ${ops.filter(o => o.op === 'set_constraint').length} constraints softened, ${ops.filter(o => o.op === 'add_activity').length} activities added).` : 'Nothing to repair automatically.';
  if (notes.length) msg += ' ' + notes.join('; ') + '.';
  return { ops, message: msg, still_open: stillOpen };
}

Object.assign(global.PlannerEngine, { RATES, parseBrief, generate, draftToProject, level, unlevel, levellingReport, levelOptions, LEVEL_ORDERS, LEVEL_REASONS, setBaseline, useBaseline, clearBaseline, histogram, costCurve, variance, planRepairs, dailyDemand });

// ---------- guardrails: port of planner/guardrails.py (bit-identical, parity tested) ----------
const _startedG = a => a.status !== 'not_started' && a.actual_start != null;
const _finishedG = a => a.status === 'complete' && a.actual_finish != null;
function outOfSequence(p) {
  const m = amap(p), out = [];
  for (const r of p.relationships) {
    const s = m[r.successor_id], q = m[r.predecessor_id]; if (!s || !q) continue;
    let reason = '';
    if (r.type === 'FS' && _startedG(s)) { if (!_finishedG(q)) reason = 'started before its predecessor finished'; else if (D(s.actual_start) < D(q.actual_finish)) reason = "started before its predecessor's actual finish"; }
    else if (r.type === 'SS' && _startedG(s)) { if (!_startedG(q)) reason = 'started before its predecessor started'; else if (D(s.actual_start) < D(q.actual_start)) reason = "started before its predecessor's actual start"; }
    else if (r.type === 'FF' && _finishedG(s) && !_finishedG(q)) reason = 'finished before its predecessor finished';
    else if (r.type === 'SF' && _finishedG(s) && !_startedG(q)) reason = 'finished before its predecessor started';
    if (reason) out.push({ successor: s.id, successor_name: s.name, predecessor: q.id, predecessor_name: q.name, type: r.type, reason });
  }
  return out;
}
function criticalDrag(project) {
  const base = JSON.parse(JSON.stringify(project)); schedule(base);
  const dcal = new E.Cal(base.calendars[base.default_calendar_id]), f0 = base.finish, out = [];
  for (const a of base.activities) {
    const rem = E.remHours(a);
    if (!a.critical || a.type !== 'task' || a.status === 'complete' || rem <= 0) continue;
    const q = JSON.parse(JSON.stringify(base)), qa = q.activities.find(x => x.id === a.id);
    if (qa.status === 'in_progress') qa.remaining_hours = 0.0; else qa.duration_hours = 0.0;
    schedule(q);
    const hpd = dcal.hours_per_day || 8.0;
    const drag = q.finish && f0 ? pyRound(dcal.hours_between(D(q.finish), D(f0)) / hpd, 1) : 0.0;
    const own = calFor(base, a);
    out.push({ id: a.id, name: a.name, drag_days: Math.max(0.0, drag), remaining_days: pyRound(rem / (own.hours_per_day || 8.0), 1) });
  }
  out.sort((x, y) => (y.drag_days - x.drag_days) || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  return out;
}
Object.assign(global.PlannerEngine, { outOfSequence, criticalDrag });

// ---------- schedule risk analysis: port of planner/risk.py (bit-identical, parity tested) ----------
const WEATHER_WORDS = ['excavat', 'topsoil', 'reduce level', 'foundation', 'pil', 'drainage', 'groundwork', 'ground beam',
  'pile cap', 'slab', 'concrete', 'scaffold', 'brick', 'block', 'envelope', 'cladding', 'curtain wall',
  'roof', 'steel', 'frame', 'external', 'landscap', 'fencing', 'driveway', 'paving', 'surfacing',
  'facade', 'render', 'window', 'crane', 'demolition', 'earthworks'];
function weatherExposed(name, cid) {
  const n = String(name).toLowerCase();
  if (n.includes('cure') || n.includes('drying') || String(cid || '').startsWith('seven')) return false;
  return WEATHER_WORDS.some(w => n.includes(w));
}
function mulberry32(seed) { let a = seed | 0; return () => { a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
function triangular(u, lo, mode, hi) {
  if (hi <= lo) return mode;
  const c = (mode - lo) / (hi - lo);
  return u < c ? lo + Math.sqrt(u * (hi - lo) * (mode - lo)) : hi - Math.sqrt((1 - u) * (hi - lo) * (hi - mode));
}
// Runs in steps so a page can keep painting: r = riskRunner(p, opts); while (r.step(25) < r.total); r.result()
function riskRunner(project, o = {}) {
  const total = Math.max(1, Math.min(Math.trunc(o.iterations ?? 500), 5000));
  const opt = o.optimistic_pct ?? 10, pes = o.pessimistic_pct ?? 30, wea = o.weather_pct ?? 20, cor = o.correlation_pct ?? 30, seed = o.seed ?? 1;
  const base = JSON.parse(JSON.stringify(project)); base.baselines = []; schedule(base);
  const det = base.finish;
  const work = JSON.parse(JSON.stringify(base));
  const tasks = work.activities.filter(a => a.type === 'task' && a.status !== 'complete' && a.duration_hours > 0);
  const orig = tasks.map(a => [a.duration_hours, a.remaining_hours]);
  const wet = tasks.map(a => weatherExposed(a.name, a.calendar_id));
  const lo = 1 - opt / 100, rho = cor / 100, rnd = mulberry32(seed);
  const finishes = [], crit = {};
  let done = 0;
  function step(k) {
    for (let n = 0; n < k && done < total; n++, done++) {
      const shared = rnd();
      tasks.forEach((a, j) => {
        const pick = rnd(), own = rnd(), u = pick < rho ? shared : own;
        const f = triangular(u, lo, 1.0, 1 + (pes + (wet[j] ? wea : 0)) / 100);
        a.duration_hours = Math.max(1, pyRound(orig[j][0] * f));
        if (a.status === 'in_progress' && orig[j][1] != null) a.remaining_hours = Math.max(0, pyRound(orig[j][1] * f));
      });
      schedule(work);
      finishes.push(work.finish);
      tasks.forEach(a => { if (a.critical) crit[a.id] = (crit[a.id] || 0) + 1; });
    }
    return done;
  }
  function result() {
    const fs = finishes.slice().sort(), n = fs.length, q = v => fs[Math.max(0, Math.ceil(v * n) - 1)];
    const weeks = new Map();
    fs.forEach(f => { const d = dateOnly(D(f)); const wk = YMD(addDays(d, -dow(d))); weeks.set(wk, (weeks.get(wk) || 0) + 1); });
    const names = Object.fromEntries(work.activities.map(a => [a.id, a.name]));
    const ranked = Object.entries(crit).sort((x, y) => (y[1] - x[1]) || (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0));
    const dl = project.must_finish_by ? ISO(D(project.must_finish_by)) : null;
    return {
      iterations: n, seed,
      settings: { optimistic_pct: opt, pessimistic_pct: pes, weather_pct: wea, correlation_pct: cor },
      uncertain_activities: tasks.length, weather_exposed: wet.filter(Boolean).length,
      deterministic_finish: det || null, deadline: dl,
      p10: q(.1), p50: q(.5), p80: q(.8), p90: q(.9), earliest: fs[0], latest: fs[n - 1],
      deterministic_probability: fs.filter(f => det && f <= det).length * 100 / n,
      deadline_probability: dl ? fs.filter(f => f <= dl).length * 100 / n : null,
      histogram: [...weeks].map(([week, count]) => ({ week, count })),
      criticality: ranked.map(([id, c]) => ({ id, name: names[id] ?? id, pct: c * 100 / n })),
    };
  }
  return { total, step, result };
}
function riskAnalysis(project, o = {}) { const r = riskRunner(project, o); r.step(r.total); return r.result(); }
Object.assign(global.PlannerEngine, { riskRunner, riskAnalysis, weatherExposed, mulberry32, triangular, ensureCalendars });
})(typeof window !== 'undefined' ? window : globalThis);

/* ---- part 4: command language ---- */
(function (global) {
const E = global.PlannerEngine;
const HELP = `    add 2 weeks to A1240              extend A1240 by 10 days
    shorten A1240 by 3d               reduce
    set A1240 to 15d                  absolute duration
    link A1010 -> A1020 SS+2d         add or replace a link
    unlink A1010 A1020
    rename A1010 Excavate strip foundations
    delete A1045
    insert "Scaffold lift" 3d after A1040 before A1050
    start 2026-05-04                  move the project start
    finish by 1 Nov 2026              set must-finish-by
    constrain A1100 start on or after 16 Mar 2026
    unconstrain A1100
    progress A1010 50% as of 20 Apr 2026
    complete A1010 on 24 Apr 2026
    data date 2026-04-20
    assign A1020 Piling gang
    fix                               run the DCMA repairer
    help
`;   // verbatim copy of planner.commands.HELP
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

// every Patch carries still_open, as the Python model does
function parseCommand(p, text) { const r = parseCommand0(p, text); if (!r.still_open) r.still_open = []; return r; }
function parseCommand0(p, text) {
  const t = text.trim(), low = t.toLowerCase(); const ops = [];
  const P = (o) => ops.push(o);
  if (low === 'help' || low === '?') return { ops: [], message: HELP };
  if (['fix', 'repair', 'fix it', 'fix the failing checks'].includes(low)) return { ops: [{ op: 'note', reason: '__repair__' }], message: 'repair' };
  let m = t.match(new RegExp('^(add|extend|push|delay)\\s+(.+?)\\s+(?:to|on)\\s+' + ID + '\\s*$', 'i')) || t.match(new RegExp('^(extend|add to|lengthen)\\s+' + ID + '\\s+by\\s+(.+)$', 'i'));
  if (m) { const g = m.slice(1); let amount, aid; if (['add', 'extend', 'push', 'delay'].includes(g[0].toLowerCase()) && g.length === 3 && /\d/.test(g[1])) { amount = g[1]; aid = g[2]; } else { amount = g[2]; aid = g[1]; } aid = resolve(p, aid); const a = p.activities.find(x => x.id === aid); const cur = a.duration_hours / hpd(p, aid); const d = cdays(amount); if (d == null) throw CommandError("How much? e.g. 'add 2 weeks to A1240'"); const nv = cur + d; P({ op: 'set_duration', activity_id: aid, duration_days: nv, reason: t }); return { ops, message: `${aid} ${a.name}: ${E.pyG(cur)}d → ${E.pyG(nv)}d.` }; }
  m = t.match(new RegExp('^(shorten|reduce|cut|shrink)\\s+' + ID + '\\s+by\\s+(.+)$', 'i'));
  if (m) { const aid = resolve(p, m[2]); const a = p.activities.find(x => x.id === aid); const cur = a.duration_hours / hpd(p, aid); const nv = Math.max(0.5, cur - (cdays(m[3]) || 0)); P({ op: 'set_duration', activity_id: aid, duration_days: nv, reason: t }); return { ops, message: `${aid} ${a.name}: ${E.pyG(cur)}d → ${E.pyG(nv)}d.` }; }
  m = t.match(new RegExp('^(?:set\\s+)?' + ID + '\\s*(?:=|to|duration)\\s*(\\d+(?:\\.\\d+)?\\s*[a-z]*)\\s*$', 'i'));
  if (m) { const aid = resolve(p, m[1]); const d = cdays(m[2]); P({ op: 'set_duration', activity_id: aid, duration_days: d, reason: t }); return { ops, message: `${aid} duration set to ${E.pyG(d)}d.` }; }
  m = t.match(new RegExp('^link\\s+' + ID + '\\s*(?:->|to|→)\\s*' + ID + '\\s*(FS|SS|FF|SF)?\\s*([+-]\\s*\\d+(?:\\.\\d+)?\\s*[a-z]*)?\\s*$', 'i'));
  if (m) { const pr = resolve(p, m[1]), s = resolve(p, m[2]); let lag = 0; if (m[4]) lag = (cdays(m[4].replace(/\s/g, '').slice(1)) || 0) * (m[4].trim().startsWith('-') ? -1 : 1); P({ op: 'add_link', predecessor_id: pr, successor_id: s, link_type: (m[3] || 'FS').toUpperCase(), lag_days: lag, reason: t }); return { ops, message: `Linked ${pr} ${(m[3] || 'FS').toUpperCase()}${lag ? E.pyG(lag, true) + 'd' : ''} ${s}.` }; }
  m = t.match(new RegExp('^unlink\\s+' + ID + '\\s*(?:->|to|from|→|,)?\\s*' + ID + '\\s*$', 'i'));
  if (m) { const pr = resolve(p, m[1]), s = resolve(p, m[2]); P({ op: 'remove_link', predecessor_id: pr, successor_id: s, reason: t }); P({ op: 'remove_link', predecessor_id: s, successor_id: pr, reason: t }); return { ops, message: `Removed links between ${pr} and ${s}.` }; }
  m = t.match(new RegExp('^rename\\s+' + ID + '\\s+(?:to\\s+)?(.+)$', 'i'));
  if (m) { const aid = resolve(p, m[1]); P({ op: 'rename', activity_id: aid, name: m[2].trim().replace(/^["']|["']$/g, ''), reason: t }); return { ops, message: `Renamed ${aid}.` }; }
  m = t.match(new RegExp('^(delete|remove)\\s+' + ID + '\\s*$', 'i'));
  if (m) { const aid = resolve(p, m[2]); P({ op: 'remove_activity', activity_id: aid, reason: t }); return { ops, message: `Removed ${aid}; predecessors were linked straight to successors.` }; }
  m = t.match(new RegExp('^(?:insert|add activity|new)\\s+["\'](.+?)["\']\\s+(\\d+(?:\\.\\d+)?\\s*[a-z]*)\\s*(?:after\\s+' + ID + ')?\\s*(?:before\\s+' + ID + ')?\\s*$', 'i'));
  if (m) { const pred = m[3] ? resolve(p, m[3]) : null, succ = m[4] ? resolve(p, m[4]) : null; const nums = p.activities.map(a => parseInt((a.id.match(/\d+/) || ['0'])[0])); const nid = 'A' + ((nums.length ? Math.max(...nums) : 1000) + 10); const wbs = pred ? (p.activities.find(a => a.id === pred) || {}).wbs_id : succ ? (p.activities.find(a => a.id === succ) || {}).wbs_id : null; P({ op: 'add_activity', activity_id: nid, name: m[1], duration_days: cdays(m[2]), wbs_code: wbs, predecessor_id: pred, successor_id: succ, reason: t }); if (pred && succ) P({ op: 'remove_link', predecessor_id: pred, successor_id: succ, reason: 'inserted between' }); return { ops, message: `Inserted ${nid} '${m[1]}' (${E.pyG(cdays(m[2]))}d)${pred && succ ? ` between ${pred} and ${succ}` : ''}.` }; }
  m = t.match(new RegExp('^(?:complete|finished?|done)\\s+' + ID + '(?:\\s+(?:on|at)\\s+(.+))?$', 'i'));
  if (m) { const aid = resolve(p, m[1]); const d = m[2] ? cdate(m[2]) : (p.data_date || p.start).slice(0, 10); P({ op: 'set_progress', activity_id: aid, actual_finish: d, reason: t }); return { ops, message: `${aid} complete on ${d}.` }; }
  m = t.match(new RegExp('^(?:started?|begin|actual start)\\s+' + ID + '(?:\\s+(?:on|at)\\s+(.+))?$', 'i'));
  if (m) { const aid = resolve(p, m[1]); const d = m[2] ? cdate(m[2]) : (p.data_date || p.start).slice(0, 10); P({ op: 'set_progress', activity_id: aid, actual_start: d, percent_complete: 0, reason: t }); return { ops, message: `${aid} started on ${d}.` }; }
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
  m = t.match(new RegExp('^assign\\s+' + ID + '\\s+(?:to\\s+)?(.+)$', 'i'));
  if (m) { const aid = resolve(p, m[1]); return { ops: [{ op: 'note', reason: `__assign__${aid}__${m[2].trim()}` }], message: `Assigned '${m[2].trim()}' to ${aid}.` }; }
  m = t.match(new RegExp('^(?:move|put)\\s+' + ID + '\\s+(?:to|into|under)\\s+wbs\\s+(\\S+)', 'i'));
  if (m) { const aid = resolve(p, m[1]); P({ op: 'move_to_wbs', activity_id: aid, wbs_code: m[2], reason: t }); return { ops, message: `${aid} moved to WBS ${m[2]}.` }; }
  throw CommandError("I did not understand that. Type 'help' for the command list.");
}

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
function fmtDt(iso) { if (!iso) return ''; const d = D(iso); return d.getUTCFullYear() + '-' + P2(d.getUTCMonth() + 1) + '-' + P2(d.getUTCDate()) + ' ' + P2(d.getUTCHours()) + ':' + P2(d.getUTCMinutes()); }
function fmtDtSec(iso) { if (!iso) return ''; const d = D(iso); return d.getUTCFullYear() + '-' + P2(d.getUTCMonth() + 1) + '-' + P2(d.getUTCDate()) + 'T' + P2(d.getUTCHours()) + ':' + P2(d.getUTCMinutes()) + ':' + P2(d.getUTCSeconds()); }
function fmtDur(h) { const hh = Math.floor(h), mm = Math.round((h - hh) * 60); return 'PT' + hh + 'H' + mm + 'M0S'; }
function colorInt(hex) { try { hex = (hex || '').replace('#', ''); const r = parseInt(hex.slice(0, 2), 16), g = parseInt(hex.slice(2, 4), 16), b = parseInt(hex.slice(4, 6), 16); return r | (g << 8) | (b << 16); } catch (e) { return 0; } }
const aStart = a => a.actual_start || a.early_start;
const aFinish = a => a.actual_finish || a.early_finish;
const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
function table(name, fields, rows) { const out = ['%T\t' + name, '%F\t' + fields.join('\t')]; for (const r of rows) out.push('%R\t' + fields.map(f => r[f] == null ? '' : String(r[f])).join('\t')); return out.join('\n'); }

function buildClndrData(cal) {
  const c = new E.Cal(cal);
  const shift = h => { const hm = c.day_start.split(':'); const s = E.mk(2020, 0, 1, +hm[0], +hm[1]); const e = new Date(s.getTime() + h * 3600000); return '0||0(s|' + P2(s.getUTCHours()) + ':' + P2(s.getUTCMinutes()) + '|f|' + P2(e.getUTCHours()) + ':' + P2(e.getUTCMinutes()) + ')'; };
  const days = []; for (let p6 = 1; p6 <= 7; p6++) { const wd = (p6 - 2 + 7) % 7; days.push('0||' + p6 + '()' + (c.working_days.includes(wd) ? '( ' + shift(c.hours_per_day) + ' )' : '( )')); }
  const exc = []; const ex = Object.entries(c.exceptions).sort(); ex.forEach((pair, i) => { const d = pair[0], h = pair[1]; const serial = Math.round((Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)) - EXCEL_EPOCH) / 86400000); exc.push('0||' + i + '(d|' + serial + ')' + (h > 0 ? '( ' + shift(h) + ' )' : '( )')); });
  return '(0||CalendarType()( 0||DaysOfWeek()( ' + days.join(' ') + ' ) 0||VIEW(ShowTotal|Y)() 0||Exceptions()( ' + exc.join(' ') + ' ) ))';
}

// P6 and MS Project allow one link between two activities; this model allows several (an SS+FF ladder).
// Keep the driving link of each pair (the first if none drives). Port of Project.export_relationships.
function exportRelationships(p) {
  const best = new Map();
  for (const r of p.relationships) { const k = r.predecessor_id + '\u0000' + r.successor_id; const b = best.get(k); if (!b || (r.driving && !b.driving)) best.set(k, r); }
  const keep = new Set(best.values());
  return [p.relationships.filter(r => keep.has(r)), p.relationships.filter(r => !keep.has(r))];
}
const UDF_OUT = { text: 'FT_TEXT', number: 'FT_FLOAT_2_DECIMALS', date: 'FT_START_DATE' };
// the project's user-defined fields, plus any field an activity carries that was never declared (xer.udf_defs)
function udfDefs(p) {
  const defs = (p.user_fields || []).filter(d => d && d.name).map(d => ({ name: d.name, type: UDF_OUT[d.type] ? d.type : 'text' })), seen = new Set(defs.map(d => d.name));
  for (const a of p.activities) for (const [k, v] of Object.entries(a.fields || {})) if (!seen.has(k)) { seen.add(k); defs.push({ name: k, type: typeof v === 'number' ? 'number' : 'text' }); }
  return defs;
}
// MS Project local task custom field ids written to MSPDI (mspxml.FIELD_IDS: the PjCustomField enumeration values, sources
// in planner/mspxml.py): Text1-30, Number1-20, Date1-10
const MSP_RANGE = (a, b) => Array.from({ length: b - a }, (_, i) => a + i);
const MSP_FIELD_IDS = {
  text: ['Text', [188743731, 188743734, 188743737, 188743740, 188743743, 188743746, 188743747, 188743748, 188743749, 188743750].concat(MSP_RANGE(188743997, 188744017))],
  number: ['Number', MSP_RANGE(188743767, 188743772).concat(MSP_RANGE(188743982, 188743997))],
  date: ['Date', MSP_RANGE(188743945, 188743955)],
};
// the custom fields an MSPDI export carries (mspxml.custom_fields): the user fields, then each activity code type as a text
// field named after it (so Asta / MS Project users see the codes as columns); MS Project's 30/20/10 limits drop the rest
function mspdiFields(p) {
  const defs = udfDefs(p).map(d => Object.assign({ code: false }, d)), names = new Set(defs.map(d => d.name));
  for (const ct of Object.keys(p.code_types || {}).concat(p.activities.flatMap(a => Object.keys(a.codes || {})))) if (ct && !names.has(ct)) { names.add(ct); defs.push({ name: ct, type: 'text', code: true }); }
  const used = { text: 0, number: 0, date: 0 }, out = [];
  for (const d of defs) { const [prefix, ids] = MSP_FIELD_IDS[d.type], n = used[d.type]; if (n < ids.length) { used[d.type] = n + 1; out.push(Object.assign({}, d, { fieldId: ids[n], fieldName: prefix + (n + 1) })); } }
  return out;
}
function mspdiValue(typ, v) {                                  // mspxml._field_value_text: null = not written
  if (v == null) return null;
  if (typ === 'number') { const n = Number(v); return (v === '' || isNaN(n)) ? null : String(n); }
  if (typ === 'date') return v ? String(v).slice(0, 10) + 'T00:00:00' : null;
  return String(v) !== '' ? String(v) : null;
}
// target P6 version for the ERMHDR line (xer.XER_VERSIONS): a major alone becomes the release P6 stamps, a full string is
// written as given. Only the header differs between versions: every table and column written here has existed unchanged
// since P6 8, and the columns later releases added are optional on import. Default 19.12, as before.
const XER_VERSIONS = { 8: '8.4', 15: '15.2', 16: '16.2', 17: '17.12', 18: '18.8', 19: '19.12', 20: '20.12', 21: '21.12', 22: '22.12', 23: '23.12', 24: '24.12' };
function xerVersion(v) { v = String(v || '19.12').trim(); return Object.prototype.hasOwnProperty.call(XER_VERSIONS, v) ? XER_VERSIONS[v] : v; }

function writeXer(p, opts) {
  E.ensureCalendars(p); const now = E.nowISO(); const nowS = fmtDt(now); const pid = 1;
  const calIds = {}; Object.keys(p.calendars).forEach((c, i) => calIds[c] = i + 1);
  const taskIds = {}; p.activities.forEach((a, i) => taskIds[a.id] = i + 1);
  const wbsIds = {}; p.wbs.forEach((w, i) => wbsIds[w.id] = i + 2);
  const rsrcIds = {}; p.resources.forEach((r, i) => rsrcIds[r.id] = i + 1);
  const header = ['ERMHDR', xerVersion(opts && opts.version), now.slice(0, 10), 'Project', 'admin', 'admin', 'dbxDatabaseNoName', 'Project Management', 'GBP'].join('\t');
  const currtype = table('CURRTYPE', ['curr_id', 'decimal_digit_cnt', 'curr_symbol', 'decimal_symbol', 'digit_group_symbol', 'pos_curr_fmt_type', 'neg_curr_fmt_type', 'curr_type', 'curr_short_name', 'group_digit_cnt', 'base_exch_rate'], [{ curr_id: 1, decimal_digit_cnt: 2, curr_symbol: 'GBP', decimal_symbol: '.', digit_group_symbol: ',', pos_curr_fmt_type: '#1,1.1', neg_curr_fmt_type: '(#1,1.1)', curr_type: 'Pound Sterling', curr_short_name: 'GBP', group_digit_cnt: 3, base_exch_rate: 1 }]);
  const calendar = table('CALENDAR', ['clndr_id', 'default_flag', 'clndr_name', 'proj_id', 'base_clndr_id', 'last_chng_date', 'clndr_type', 'day_hr_cnt', 'week_hr_cnt', 'month_hr_cnt', 'year_hr_cnt', 'rsrc_private', 'clndr_data'], Object.values(p.calendars).map(c => ({ clndr_id: calIds[c.id], default_flag: c.id === p.default_calendar_id ? 'Y' : 'N', clndr_name: c.name, proj_id: '', base_clndr_id: '', last_chng_date: nowS, clndr_type: 'CA_Base', day_hr_cnt: c.hours_per_day, week_hr_cnt: c.hours_per_day * c.working_days.length, month_hr_cnt: Math.round(c.hours_per_day * c.working_days.length * 52 / 12 * 10) / 10, year_hr_cnt: c.hours_per_day * c.working_days.length * 52, rsrc_private: 'N', clndr_data: buildClndrData(c) })));
  const finish = p.finish || p.start;
  const projFields = ['proj_id', 'fy_start_month_num', 'rsrc_self_add_flag', 'allow_complete_flag', 'allow_neg_act_flag', 'def_complete_pct_type', 'proj_short_name', 'clndr_id', 'task_code_base', 'task_code_step', 'priority_num', 'wbs_max_sum_level', 'strgy_priority_num', 'critical_drtn_hr_cnt', 'def_cost_per_qty', 'last_recalc_date', 'plan_start_date', 'plan_end_date', 'scd_end_date', 'add_date', 'def_duration_type', 'task_code_prefix', 'guid', 'def_qty_type', 'add_by_name', 'def_rate_type', 'add_act_remain_flag', 'act_this_per_link_flag', 'def_task_type', 'act_pct_link_flag', 'critical_path_type', 'task_code_prefix_flag', 'def_rollup_dates_flag', 'use_project_baseline_flag', 'rem_target_link_flag', 'reset_planned_flag', 'sum_assign_level', 'export_flag', 'loaded_scope_level', 'close_period_flag', 'trsrcsum_loaded'];
  const LAG_CAL_XER = { predecessor: 'rcal_Predecessor', successor: 'rcal_Successor', project: 'rcal_Project', '24h': 'rcal_24Hour' };
  const schedoptions = table('SCHEDOPTIONS', ['schedoptions_id', 'proj_id', 'sched_outer_depend_type', 'sched_open_critical_flag', 'sched_lag_early_start_flag', 'sched_retained_logic', 'sched_setplantoforecast', 'sched_float_type', 'sched_calendar_on_relationship_lag', 'sched_use_expect_end_flag', 'sched_progress_override', 'level_float_thrs_cnt', 'level_outer_assign_flag', 'level_outer_assign_priority', 'level_over_alloc_pct', 'level_within_float_flag', 'level_keep_sched_date_flag', 'level_all_rsrc_flag', 'sched_use_project_end_date_for_float', 'enable_multiple_longest_path_calc', 'limit_multiple_longest_path_calc', 'max_multiple_longest_path', 'use_total_float_multiple_longest_paths', 'key_activity_for_multiple_longest_paths', 'LevelPriorityList'],
    [{ schedoptions_id: 1, proj_id: pid, sched_outer_depend_type: 'SD_Both', sched_open_critical_flag: 'N', sched_lag_early_start_flag: 'Y', sched_retained_logic: p.progress_logic === 'override' ? 'N' : 'Y', sched_setplantoforecast: 'N', sched_float_type: 'FT_FF', sched_calendar_on_relationship_lag: LAG_CAL_XER[p.lag_calendar] || 'rcal_Predecessor', sched_use_expect_end_flag: 'Y', sched_progress_override: p.progress_logic === 'override' ? 'Y' : 'N', level_float_thrs_cnt: 0, level_outer_assign_flag: 'N', level_outer_assign_priority: 5, level_over_alloc_pct: 25, level_within_float_flag: 'N', level_keep_sched_date_flag: 'Y', level_all_rsrc_flag: 'Y', sched_use_project_end_date_for_float: 'Y', enable_multiple_longest_path_calc: 'N', limit_multiple_longest_path_calc: 'Y', max_multiple_longest_path: 10, use_total_float_multiple_longest_paths: 'Y', key_activity_for_multiple_longest_paths: '', LevelPriorityList: 'priority_type,ASC' }]);
  const projT = table('PROJECT', projFields, [{ proj_id: pid, fy_start_month_num: 1, rsrc_self_add_flag: 'N', allow_complete_flag: 'N', allow_neg_act_flag: 'N', def_complete_pct_type: 'CP_Drtn', proj_short_name: p.id.slice(0, 20), clndr_id: calIds[p.default_calendar_id], task_code_base: 1000, task_code_step: 10, priority_num: 10, wbs_max_sum_level: 0, strgy_priority_num: 500, critical_drtn_hr_cnt: 0, def_cost_per_qty: 0, last_recalc_date: fmtDt(p.data_date || p.start), plan_start_date: fmtDt(p.start), plan_end_date: fmtDt(p.must_finish_by), scd_end_date: fmtDt(finish), add_date: nowS, def_duration_type: 'DT_FixedDrtn', task_code_prefix: 'A', guid: '', def_qty_type: 'QT_Hour', add_by_name: 'admin', def_rate_type: 'COST_PER_QTY', add_act_remain_flag: 'N', act_this_per_link_flag: 'Y', def_task_type: 'TT_Task', act_pct_link_flag: 'Y', critical_path_type: 'CT_TotFloat', task_code_prefix_flag: 'Y', def_rollup_dates_flag: 'Y', use_project_baseline_flag: 'Y', rem_target_link_flag: 'Y', reset_planned_flag: 'N', sum_assign_level: 'SL_Taskrsrc', export_flag: 'Y', loaded_scope_level: 7, close_period_flag: 'N', trsrcsum_loaded: 'N' }]);
  const wbsBase = { wbs_id: 1, proj_id: pid, obs_id: '', seq_num: 0, proj_node_flag: 'Y', sum_data_flag: 'Y', status_code: 'WS_Open', wbs_short_name: p.id.slice(0, 20), wbs_name: p.name, parent_wbs_id: '', ev_user_pct: 6, ev_etc_user_value: 0.88, orig_cost: 0, indep_remain_total_cost: 0, ann_dscnt_rate_pct: 0, dscnt_period_type: '', indep_remain_work_qty: 0, anticip_start_date: '', anticip_end_date: '', ev_compute_type: 'EC_Cmp_pct', ev_etc_compute_type: 'EE_Rem_hrs' };
  const wbsRows = [wbsBase];
  for (const w of p.wbs) wbsRows.push(Object.assign({}, wbsBase, { wbs_id: wbsIds[w.id], seq_num: w.seq, proj_node_flag: 'N', wbs_short_name: (w.code || w.id).slice(0, 20), wbs_name: w.name, parent_wbs_id: w.parent_id ? (wbsIds[w.parent_id] || 1) : 1 }));
  const projwbs = table('PROJWBS', Object.keys(wbsBase), wbsRows);
  const rsrc = table('RSRC', ['rsrc_id', 'clndr_id', 'rsrc_seq_num', 'rsrc_name', 'rsrc_short_name', 'def_qty_per_hr', 'cost_qty_type', 'ot_factor', 'active_flag', 'auto_compute_act_flag', 'def_cost_qty_link_flag', 'ot_flag', 'curr_id', 'rsrc_type', 'load_tasks_flag', 'level_flag'], p.resources.map((r, i) => ({ rsrc_id: rsrcIds[r.id], clndr_id: calIds[p.default_calendar_id], rsrc_seq_num: i + 1, rsrc_name: r.name, rsrc_short_name: r.id.slice(0, 20), def_qty_per_hr: 1, cost_qty_type: 'QT_Hour', ot_factor: 1, active_flag: 'Y', auto_compute_act_flag: 'Y', def_cost_qty_link_flag: 'Y', ot_flag: 'N', curr_id: 1, rsrc_type: RSRC_OUT[r.type] || 'RT_Labor', load_tasks_flag: 'N', level_flag: 'N' })));
  const taskFields = ['task_id', 'proj_id', 'wbs_id', 'clndr_id', 'phys_complete_pct', 'complete_pct_type', 'task_type', 'duration_type', 'status_code', 'task_code', 'task_name', 'total_float_hr_cnt', 'free_float_hr_cnt', 'remain_drtn_hr_cnt', 'target_drtn_hr_cnt', 'cstr_date', 'act_start_date', 'act_end_date', 'suspend_date', 'resume_date', 'late_start_date', 'late_end_date', 'early_start_date', 'early_end_date', 'restart_date', 'reend_date', 'target_start_date', 'target_end_date', 'rem_late_start_date', 'rem_late_end_date', 'cstr_type', 'priority_type', 'driving_path_flag', 'create_date', 'update_date', 'create_user', 'update_user'];
  const taskRows = p.activities.map(a => { const rem = a.remaining_hours != null ? a.remaining_hours : (a.status === 'complete' ? 0 : a.duration_hours); return { task_id: taskIds[a.id], proj_id: pid, wbs_id: a.wbs_id ? (wbsIds[a.wbs_id] || 1) : 1, clndr_id: calIds[a.calendar_id || p.default_calendar_id] || calIds[p.default_calendar_id], phys_complete_pct: a.percent_complete, complete_pct_type: 'CP_Drtn', task_type: TASK_TYPE_OUT[a.type], duration_type: 'DT_FixedDrtn', status_code: STATUS_OUT[a.status], task_code: a.id.slice(0, 20), task_name: a.name.slice(0, 120), total_float_hr_cnt: a.total_float_hours == null ? '' : a.total_float_hours, free_float_hr_cnt: a.free_float_hours == null ? '' : a.free_float_hours, remain_drtn_hr_cnt: rem, target_drtn_hr_cnt: a.duration_hours, cstr_date: a.constraint !== 'none' ? fmtDt(a.constraint_date) : '', act_start_date: fmtDt(a.actual_start), act_end_date: fmtDt(a.actual_finish), suspend_date: fmtDt(a.suspend_date), resume_date: fmtDt(a.resume_date), late_start_date: fmtDt(a.late_start), late_end_date: fmtDt(a.late_finish), early_start_date: fmtDt(a.early_start), early_end_date: fmtDt(a.early_finish), restart_date: fmtDt(a.early_start), reend_date: fmtDt(a.early_finish), target_start_date: fmtDt(a.baseline_start || aStart(a)), target_end_date: fmtDt(a.baseline_finish || aFinish(a)), rem_late_start_date: fmtDt(a.late_start), rem_late_end_date: fmtDt(a.late_finish), cstr_type: CSTR_OUT[a.constraint] || '', priority_type: 'PT_Normal', driving_path_flag: a.critical ? 'Y' : 'N', create_date: nowS, update_date: nowS, create_user: 'admin', update_user: 'admin' }; });
  const task = table('TASK', taskFields, taskRows);
  const taskpred = table('TASKPRED', ['task_pred_id', 'task_id', 'pred_task_id', 'proj_id', 'pred_proj_id', 'pred_type', 'lag_hr_cnt'], exportRelationships(p)[0].filter(r => taskIds[r.successor_id] && taskIds[r.predecessor_id]).map((r, i) => ({ task_pred_id: i + 1, task_id: taskIds[r.successor_id], pred_task_id: taskIds[r.predecessor_id], proj_id: pid, pred_proj_id: pid, pred_type: LINK_OUT[r.type], lag_hr_cnt: r.lag_hours })));
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
  const memoHtml = t => '<HTML><BODY>' + t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\t/g, ' ').replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n/g, '<br>') + '</BODY></HTML>';
  const memotype = table('MEMOTYPE', ['memo_type_id', 'seq_num', 'eps_flag', 'proj_flag', 'wbs_flag', 'task_flag', 'memo_type'], [{ memo_type_id: 1, seq_num: 0, eps_flag: 'N', proj_flag: 'N', wbs_flag: 'Y', task_flag: 'Y', memo_type: 'Notes' }]);
  const taskmemo = table('TASKMEMO', ['memo_id', 'task_id', 'memo_type_id', 'proj_id', 'task_memo'], p.activities.filter(a => a.notes && taskIds[a.id]).map((a, i) => ({ memo_id: i + 1, task_id: taskIds[a.id], memo_type_id: 1, proj_id: pid, task_memo: memoHtml(a.notes) })));
  // user-defined fields: UDFTYPE per field, UDFVALUE per value (mirrors xer.write_xer)
  const defs = udfDefs(p); if (p.activities.some(a => a.elapsed && taskIds[a.id]) && defs.every(d => d.name !== 'elapsed')) defs.push({ name: 'elapsed', type: 'text' });   // elapsed-duration flag as a task UDF, Y (xer.ELAPSED_UDF)
  const udfIds = {}, udfTy = {}; defs.forEach((d, i) => { udfIds[d.name] = i + 1; udfTy[d.name] = d.type; });
  const udftype = table('UDFTYPE', ['udf_type_id', 'table_name', 'udf_type_name', 'udf_type_label', 'logical_data_type', 'super_flag', 'indicator_expression', 'summary_indicator_expression', 'export_flag'], defs.map(d => ({ udf_type_id: udfIds[d.name], table_name: 'TASK', udf_type_name: 'user_field_' + udfIds[d.name], udf_type_label: d.name.slice(0, 40), logical_data_type: UDF_OUT[d.type], super_flag: 'N', export_flag: 'Y' })));
  const udfRows = [];
  for (const a of p.activities) { if (!taskIds[a.id]) continue; for (const [k, v] of Object.entries(a.fields || {})) { if (v == null || !udfIds[k]) continue; const ty = udfTy[k]; let row = null;
    if (ty === 'number') { const n = Number(v); if (v !== '' && !isNaN(n)) row = { udf_number: String(n) }; } else if (ty === 'date') { if (v) row = { udf_date: String(v).slice(0, 10) + ' 00:00' }; } else if (String(v) !== '') row = { udf_text: String(v).replace(/[\t\r\n]/g, ' ') };
    if (row) udfRows.push(Object.assign({ udf_type_id: udfIds[k], fk_id: taskIds[a.id], proj_id: pid }, row)); }
    if (a.elapsed && udfIds.elapsed && !('elapsed' in (a.fields || {}))) udfRows.push({ udf_type_id: udfIds.elapsed, fk_id: taskIds[a.id], proj_id: pid, udf_text: 'Y' }); }
  const udfvalue = table('UDFVALUE', ['udf_type_id', 'fk_id', 'proj_id', 'udf_date', 'udf_number', 'udf_text', 'udf_code_id'], udfRows);
  return [header, currtype, memotype, calendar, projT, schedoptions, projwbs, rsrc, actvtype, actvcode].concat(defs.length ? [udftype] : [], [task, taskpred, taskrsrc, taskactv, taskmemo], defs.length ? [udfvalue] : [], ['%E', '']).join('\n');
}

function writeMspdi(p) {
  E.ensureCalendars(p); const NS = 'http://schemas.microsoft.com/project';
  const calUid = {}; Object.keys(p.calendars).forEach((c, i) => calUid[c] = i + 1);
  const dcal = new E.Cal(p.calendars[p.default_calendar_id]);
  const now = E.nowISO();
  const endTime = h => { const hm = dcal.day_start.split(':'); const e = E.mk(2020, 0, 1, +hm[0], +hm[1]); e.setTime(e.getTime() + h * 3600000); return P2(e.getUTCHours()) + ':' + P2(e.getUTCMinutes()) + ':00'; };
  const L = []; const el = (tag, val) => L.push('<' + tag + '>' + esc(val) + '</' + tag + '>');
  L.push('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'); L.push('<Project xmlns="' + NS + '">');
  el('SaveVersion', 14); el('Name', p.name); el('Title', p.name); el('ScheduleFromStart', 1);
  el('StartDate', fmtDtSec(p.start)); el('FinishDate', fmtDtSec(p.finish || p.start)); el('StatusDate', fmtDtSec(p.data_date || p.start)); el('CurrentDate', now);
  el('CalendarUID', calUid[p.default_calendar_id]); el('DefaultStartTime', dcal.day_start); el('DefaultFinishTime', endTime(dcal.hours_per_day));
  el('MinutesPerDay', Math.round(dcal.hours_per_day * 60)); el('MinutesPerWeek', Math.round(dcal.hours_per_day * 60 * dcal.working_days.length)); el('DaysPerMonth', 20); el('DurationFormat', 7); el('NewTasksAreManual', 0);
  // custom fields (user fields, then code types as text fields) are declared before the calendars, as the schema orders
  const fields = mspdiFields(p);
  if (fields.length) { L.push('<ExtendedAttributes>'); for (const f of fields) { L.push('<ExtendedAttribute>'); el('FieldID', f.fieldId); el('FieldName', f.fieldName); el('Alias', f.name); L.push('</ExtendedAttribute>'); } L.push('</ExtendedAttributes>'); }
  L.push('<Calendars>');
  for (const cidPair of Object.entries(p.calendars)) { const cid = cidPair[0]; const c = new E.Cal(cidPair[1]); L.push('<Calendar>'); el('UID', calUid[cid]); el('Name', c.name); el('IsBaseCalendar', 1); el('BaseCalendarUID', -1); L.push('<WeekDays>'); for (let dt = 1; dt <= 7; dt++) { L.push('<WeekDay>'); el('DayType', dt); const working = c.working_days.includes((dt - 2 + 7) % 7); el('DayWorking', working ? 1 : 0); if (working) { L.push('<WorkingTimes><WorkingTime>'); el('FromTime', c.day_start); el('ToTime', endTime(c.hours_per_day)); L.push('</WorkingTime></WorkingTimes>'); } L.push('</WeekDay>'); } L.push('</WeekDays>'); const exs = Object.entries(c.exceptions).sort(); if (exs.length) { L.push('<Exceptions>'); for (const dh of exs) { const d = dh[0], h = dh[1]; L.push('<Exception>'); L.push('<TimePeriod>'); el('FromDate', d + 'T00:00:00'); el('ToDate', d + 'T23:59:00'); L.push('</TimePeriod>'); el('Occurrences', 1); el('Name', h == 0 ? 'Non-working' : 'Working exception'); el('Type', 1); el('DayWorking', h > 0 ? 1 : 0); if (h > 0) { L.push('<WorkingTimes><WorkingTime>'); el('FromTime', c.day_start); el('ToTime', endTime(h)); L.push('</WorkingTime></WorkingTimes>'); } L.push('</Exception>'); } L.push('</Exceptions>'); } L.push('</Calendar>'); }
  L.push('</Calendars>'); L.push('<Tasks>');
  L.push('<Task>'); el('UID', 0); el('ID', 0); el('Name', p.name); el('Type', 1); el('OutlineNumber', 0); el('OutlineLevel', 0); el('Summary', 1); el('Start', fmtDtSec(p.start)); el('Finish', fmtDtSec(p.finish || p.start)); L.push('</Task>');
  const children = {}; p.wbs.forEach(w => { const k = w.parent_id || ''; (children[k] = children[k] || []).push(w); });
  const wset = new Set(p.wbs.map(w => w.id)); const actsByWbs = {}; p.activities.forEach(a => { const k = (a.wbs_id && wset.has(a.wbs_id)) ? a.wbs_id : ''; (actsByWbs[k] = actsByWbs[k] || []).push(a); });
  const taskUid = {}; let counter = 0; const emit = []; const kept = exportRelationships(p)[0];
  function walk(parent, level, prefix) { let n = 0; (children[parent] || []).slice().sort((a, b) => a.seq - b.seq || a.name.localeCompare(b.name)).forEach(w => { n++; counter++; emit.push({ wbs: w, uid: counter, level: level, outlineNo: prefix + n }); walk(w.id, level + 1, prefix + n + '.'); }); (actsByWbs[parent] || []).forEach(a => { n++; counter++; taskUid[a.id] = counter; emit.push({ act: a, uid: counter, level: level, outlineNo: prefix + n }); }); }
  walk('', 1, '');
  const fmtSlack = h => Math.round(h * 600);
  for (const e of emit) {
    if (e.wbs) { L.push('<Task>'); el('UID', e.uid); el('ID', e.uid); el('Name', e.wbs.name); el('Type', 1); el('OutlineNumber', e.outlineNo); el('OutlineLevel', e.level); el('Summary', 1); el('WBS', e.wbs.code || e.wbs.id); L.push('</Task>'); continue; }
    const a = e.act;
    L.push('<Task>'); el('UID', e.uid); el('ID', e.uid); el('Name', a.name); el('Type', 1); el('IsNull', 0); el('WBS', a.id); el('OutlineNumber', e.outlineNo); el('OutlineLevel', e.level); el('Priority', 500);
    el('Start', fmtDtSec(aStart(a))); el('Finish', fmtDtSec(aFinish(a))); el('Duration', fmtDur(a.duration_hours)); el('DurationFormat', a.elapsed ? 8 : 7);
    const rem = a.remaining_hours != null ? a.remaining_hours : (a.status === 'complete' ? 0 : a.duration_hours);
    el('RemainingDuration', fmtDur(rem)); el('ManualStart', fmtDtSec(aStart(a))); el('ManualFinish', fmtDtSec(aFinish(a))); el('ManualDuration', fmtDur(a.duration_hours));
    el('ConstraintType', CSTR_MSP[a.constraint] || '0'); if (a.constraint_date && a.constraint !== 'none') el('ConstraintDate', fmtDtSec(a.constraint_date));
    if (a.deadline) el('Deadline', fmtDtSec(a.deadline));
    el('CalendarUID', a.calendar_id ? (calUid[a.calendar_id] != null ? calUid[a.calendar_id] : -1) : -1);
    el('Milestone', E.isMs(a) ? 1 : 0); el('Summary', 0); el('Critical', a.critical ? 1 : 0); el('IsSubproject', 0);
    el('EarlyStart', fmtDtSec(a.early_start)); el('EarlyFinish', fmtDtSec(a.early_finish)); el('LateStart', fmtDtSec(a.late_start)); el('LateFinish', fmtDtSec(a.late_finish));
    if (a.total_float_hours != null) { el('TotalSlack', fmtSlack(a.total_float_hours)); el('FreeSlack', fmtSlack(a.free_float_hours || 0)); }
    el('PercentComplete', Math.round(a.status === 'complete' ? 100 : a.percent_complete));
    if (a.actual_start) el('ActualStart', fmtDtSec(a.actual_start));
    if (a.actual_finish) el('ActualFinish', fmtDtSec(a.actual_finish));
    if (a.notes) el('Notes', a.notes);
    for (const f of fields) { const s = mspdiValue(f.type, f.code ? (a.codes || {})[f.name] : (a.fields || {})[f.name]); if (s != null) { L.push('<ExtendedAttribute>'); el('FieldID', f.fieldId); el('Value', s); L.push('</ExtendedAttribute>'); } }   // between Notes and Baseline, as the Task schema orders
    if (a.baseline_start || a.baseline_finish) { L.push('<Baseline>'); el('Number', 0); el('Start', fmtDtSec(a.baseline_start)); el('Finish', fmtDtSec(a.baseline_finish)); L.push('</Baseline>'); }
    for (const r of kept.filter(x => x.successor_id === a.id)) { if (taskUid[r.predecessor_id] == null) continue; L.push('<PredecessorLink>'); el('PredecessorUID', taskUid[r.predecessor_id]); el('Type', LINK_MSP[r.type]); el('CrossProject', 0); el('LinkLag', Math.round(r.lag_hours * 600)); el('LagFormat', (r.lag_calendar || p.lag_calendar) === '24h' ? 8 : 7); L.push('</PredecessorLink>'); }
    L.push('</Task>');
  }
  L.push('</Tasks>');
  const resUid = {}; p.resources.forEach((r, i) => resUid[r.id] = i + 1);
  L.push('<Resources>'); for (const r of p.resources) { L.push('<Resource>'); el('UID', resUid[r.id]); el('ID', resUid[r.id]); el('Name', r.name); el('Type', RES_MSP[r.type] || '1'); el('Initials', r.id.slice(0, 10)); el('StandardRate', r.rate); el('MaxUnits', r.max_units_per_day || 1); L.push('</Resource>'); } L.push('</Resources>');
  L.push('<Assignments>'); p.assignments.forEach((x, i) => { if (taskUid[x.activity_id] == null || resUid[x.resource_id] == null) return; L.push('<Assignment>'); el('UID', i + 1); el('TaskUID', taskUid[x.activity_id]); el('ResourceUID', resUid[x.resource_id]); el('Units', 1); el('Work', fmtDur(x.units)); el('Cost', x.cost); L.push('</Assignment>'); }); L.push('</Assignments>');
  L.push('</Project>');
  return L.join('\n');
}

function writeAny(p, fmt, opts) {
  fmt = fmt.toLowerCase().replace(/^\./, '');
  if (fmt === 'json') return [JSON.stringify(p, null, 1), 'application/json', p.id + '.json'];
  if (fmt === 'xer') return [writeXer(p, opts), 'text/plain', p.id + '.xer'];
  if (fmt === 'xml' || fmt === 'mspdi' || fmt === 'msproject') return [writeMspdi(p), 'application/xml', p.id + '.xml'];
  throw new Error('format must be json, xer or xml');
}
Object.assign(global.PlannerEngine, { writeXer, writeMspdi, writeAny, buildClndrData, exportRelationships, udfDefs, mspdiFields, xerVersion, XER_VERSIONS });
})(typeof window !== 'undefined' ? window : globalThis);

/* ---- part 6: export bundle (store-only ZIP of .xer + .xml + .json) ---- */
(function (global) {
const E = global.PlannerEngine;
const CRC = (function () { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c >>> 0; } return t; })();
function crc32(b) { let c = 0xFFFFFFFF; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
function zipStore(files) {
  const enc = new TextEncoder(); const u16 = n => [n & 255, (n >> 8) & 255]; const u32 = n => [n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >> 24) & 255];
  const parts = []; const central = []; let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name); const data = f.bytes; const crc = crc32(data); const sz = data.length;
    const lfh = new Uint8Array([0x50, 0x4b, 0x03, 0x04, ...u16(20), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(crc), ...u32(sz), ...u32(sz), ...u16(name.length), ...u16(0)]);
    parts.push(lfh, name, data);
    central.push({ hdr: new Uint8Array([0x50, 0x4b, 0x01, 0x02, ...u16(20), ...u16(20), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(crc), ...u32(sz), ...u32(sz), ...u16(name.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(offset)]), name: name });
    offset += lfh.length + name.length + sz;
  }
  let cdSize = 0; const cd = [];
  for (const c of central) { cd.push(c.hdr, c.name); cdSize += c.hdr.length + c.name.length; }
  const eocd = new Uint8Array([0x50, 0x4b, 0x05, 0x06, ...u16(0), ...u16(0), ...u16(central.length), ...u16(central.length), ...u32(cdSize), ...u32(offset), ...u16(0)]);
  const all = parts.concat(cd, [eocd]); let total = 0; for (const a of all) total += a.length;
  const out = new Uint8Array(total); let p = 0; for (const a of all) { out.set(a, p); p += a.length; } return out;
}
function writeBundle(p, opts) {
  const enc = new TextEncoder();
  return zipStore([
    { name: p.id + '.xer', bytes: enc.encode(E.writeXer(p, opts)) },
    { name: p.id + '.xml', bytes: enc.encode(E.writeMspdi(p)) },
    { name: p.id + '.json', bytes: enc.encode(JSON.stringify(p, null, 1)) },
    { name: 'README.txt', bytes: enc.encode('Programme export for construction scheduling software.\n\n' + p.id + '.xer  - Primavera P6 (File > Import > XER); also Asta Powerproject (File > Import).\n' + p.id + '.xml  - Microsoft Project (Open) and Asta Powerproject (File > Import, MS Project XML).\n' + p.id + '.json - this planner\'s own format (re-import here).\n') },
  ]);
}
Object.assign(global.PlannerEngine, { writeBundle, zipStore, crc32 });
})(typeof window !== 'undefined' ? window : globalThis);

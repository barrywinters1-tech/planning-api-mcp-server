/* Programme comparison: a line-for-line port of planner/compare.py. Load after engine.js.
   compareProjects(old, new) -> result (same shape and values as Python's compare())
   compareNarrative(result)  -> the same plain-English commentary as Python's narrative()
   The inputs are never mutated: both are cloned and scheduled when they have no dates yet.
   tests/test_compare_parity.py holds the two engines to identical output. */
'use strict';
(function (global) {
const E = global.PlannerEngine;
const { D, ISO, Cal, calFor, amap, schedule, pyRound, pyFixed } = E;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const EPS = 1e-9;
const MAX_DRIVERS = 4;
const MAX_NAMED = 3;
const LOE = 'level_of_effort';
const P2 = n => String(n).padStart(2, '0');
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);   // Python str ordering (code points; same for BMP text)

// ---------------------------------------------------------------------------- helpers
const r1 = x => pyRound(x, 1) + 0;                    // + 0 turns -0 into 0, as Python's + 0.0 does
const iso = x => (x == null || x === '' ? null : ISO(D(x)));
const startOf = a => iso(a.actual_start || a.early_start);
const finishOf = a => iso(a.actual_finish || a.early_finish);
const status = a => a.status || 'not_started';
const pct = a => a.percent_complete || 0;
const dur = a => a.duration_hours || 0;

function scheduled(p) {
  const q = JSON.parse(JSON.stringify(p));
  if (!q.finish || q.activities.some(a => !a.early_start)) schedule(q);
  return q;
}
function defaultCal(p) { const c = (p.calendars || {})[p.default_calendar_id]; return new Cal(c || { id: p.default_calendar_id }); }
function calOf(p, m, aid) { const a = m[aid]; return a ? calFor(p, a) : defaultCal(p); }
function daysBetween(cal, a, b) {
  if (a == null || b == null) return null;
  return r1(cal.hours_to_days(cal.hours_between(D(a), D(b))));
}

function calSig(c) {
  const k = new Cal(c);
  const exc = {}; for (const [d, v] of Object.entries(k.exceptions || {})) exc[d] = v;
  return { name: k.name, hours_per_day: k.hours_per_day, day_start: P2(k._sh) + ':' + P2(k._sm),
           working_days: k.working_days.slice().sort((a, b) => a - b), exceptions: exc };
}
const sameList = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

function calendarUsers(p) {
  const out = {};
  for (const a of p.activities) { const cid = a.calendar_id || p.default_calendar_id; out[cid] = (out[cid] || 0) + 1; }
  return out;
}
function calendarChanges(o, n) {
  const oc = o.calendars || {}, nc = n.calendars || {}, out = [];
  const ou = calendarUsers(o), nu = calendarUsers(n);
  const ids = Array.from(new Set(Object.keys(oc).concat(Object.keys(nc)))).sort(cmp);
  for (const cid of ids) {
    if (!(cid in oc)) { out.push({ calendar: cid, change: 'added', used_by: nu[cid] || 0, fields: [], exceptions_added: [], exceptions_removed: [], exceptions_changed: [] }); continue; }
    if (!(cid in nc)) { out.push({ calendar: cid, change: 'removed', used_by: ou[cid] || 0, fields: [], exceptions_added: [], exceptions_removed: [], exceptions_changed: [] }); continue; }
    const a = calSig(oc[cid]), b = calSig(nc[cid]);
    const fields = ['name', 'hours_per_day', 'day_start', 'working_days'].filter(f => (f === 'working_days' ? !sameList(a[f], b[f]) : a[f] !== b[f]));
    const ea = a.exceptions, eb = b.exceptions;
    const added = Object.keys(eb).filter(k => !(k in ea)).sort(cmp);
    const removed = Object.keys(ea).filter(k => !(k in eb)).sort(cmp);
    const changed = Object.keys(eb).filter(k => (k in ea) && ea[k] !== eb[k]).sort(cmp);
    if (added.length || removed.length || changed.length) fields.push('exceptions');
    if (fields.length) out.push({ calendar: cid, change: 'changed', used_by: nu[cid] || 0, fields, exceptions_added: added, exceptions_removed: removed, exceptions_changed: changed });
  }
  return out;
}

const SEP = '\u0000';
function relIndex(p) {
  const out = new Map();
  for (const r of p.relationships) { const k = [r.predecessor_id, r.successor_id, r.type || 'FS'].join(SEP); if (!out.has(k)) out.set(k, r); }
  return out;
}

function walkDriving(p) {
  const m = amap(p);
  const open = p.activities.filter(a => status(a) !== 'complete' && a.type !== LOE && a.early_finish);
  if (!open.length) return [null, new Set()];
  let end = null; for (const a of open) { const f = D(a.early_finish).getTime(); if (end === null || f > end) end = f; }
  const ends = open.filter(a => D(a.early_finish).getTime() === end);
  const tied = new Set(ends.map(a => a.id));
  const feeding = new Set(p.relationships.filter(r => tied.has(r.successor_id) && tied.has(r.predecessor_id)).map(r => r.predecessor_id));
  const finishAct = ends.find(a => !feeding.has(a.id)) || ends[0];   // e.g. the finish milestone, not the task feeding it
  const preds = {};
  for (const r of p.relationships) (preds[r.successor_id] = preds[r.successor_id] || []).push(r);
  const seen = new Set(), stack = ends.map(a => a.id);
  while (stack.length) {
    const aid = stack.pop();
    if (seen.has(aid)) continue;
    seen.add(aid);
    for (const r of preds[aid] || []) { const q = m[r.predecessor_id]; if (r.driving && q && q.type !== LOE) stack.push(q.id); }
  }
  return [finishAct, seen];
}

// ---------------------------------------------------------------------------- compare
function compareProjects(oldP, newP) {
  const o = scheduled(oldP), n = scheduled(newP);
  const calendar_changes = calendarChanges(o, n);
  const om = amap(o), nm = amap(n);
  const ocal = defaultCal(o), ncal = defaultCal(n);

  const added = n.activities.filter(a => !(a.id in om)).map(a => ({ id: a.id, name: a.name }));
  const removed = o.activities.filter(a => !(a.id in nm)).map(a => ({ id: a.id, name: a.name }));
  const renamed = [], duration_changes = [], date_moves = [], constraint_changes = [], progress_changes = [], cal_moves = [];
  const shifts = {};

  for (const na of n.activities) {
    const oa = om[na.id];
    if (!oa) continue;
    const cal = calFor(n, na), oc = calFor(o, oa);
    if (oa.name !== na.name) renamed.push({ id: na.id, old: oa.name, new: na.name });
    if (oa.type !== LOE && na.type !== LOE) {
      const od = oc.hours_to_days(dur(oa)), nd = cal.hours_to_days(dur(na));
      if (Math.abs(nd - od) > EPS) duration_changes.push({ id: na.id, name: na.name, old_days: r1(od), new_days: r1(nd), delta_days: r1(nd - od) });
    }
    const ocid = oa.calendar_id || o.default_calendar_id, ncid = na.calendar_id || n.default_calendar_id;
    if (ocid !== ncid) cal_moves.push({ id: na.id, name: na.name, old: ocid, new: ncid });
    const ocon = { type: oa.constraint || 'none', date: iso(oa.constraint_date) };
    const ncon = { type: na.constraint || 'none', date: iso(na.constraint_date) };
    if (ocon.type !== ncon.type || ocon.date !== ncon.date) constraint_changes.push({ id: na.id, name: na.name, old: ocon, new: ncon });
    if (status(oa) !== status(na) || Math.abs(pct(oa) - pct(na)) > EPS || iso(oa.actual_start) !== iso(na.actual_start) || iso(oa.actual_finish) !== iso(na.actual_finish)) {
      progress_changes.push({ id: na.id, name: na.name, old_status: status(oa), new_status: status(na),
        old_pct: r1(pct(oa)), new_pct: r1(pct(na)),
        old_actual_start: iso(oa.actual_start), new_actual_start: iso(na.actual_start),
        old_actual_finish: iso(oa.actual_finish), new_actual_finish: iso(na.actual_finish) });
    }
    const os = startOf(oa), of = finishOf(oa), ns = startOf(na), nf = finishOf(na);
    const ss = daysBetween(cal, os, ns), fs = daysBetween(cal, of, nf);
    shifts[na.id] = [ss, fs];
    if (os !== ns || of !== nf) {
      date_moves.push({ id: na.id, name: na.name, start_shift_days: ss, finish_shift_days: fs,
        old_start: os, new_start: ns, old_finish: of, new_finish: nf });
    }
  }
  date_moves.sort((a, b) => (Math.abs(b.finish_shift_days || 0) - Math.abs(a.finish_shift_days || 0)) || cmp(a.id, b.id));

  // ---- logic ----
  const oi = relIndex(o), ni = relIndex(n);
  const lag = (p, m, r) => r1(calOf(p, m, r.predecessor_id).hours_to_days(r.lag_hours || 0));
  const parts = k => k.split(SEP);
  const pairOf = k => { const x = parts(k); return x[0] + SEP + x[1]; };
  const oOnly = Array.from(oi.keys()).filter(k => !ni.has(k));
  const nOnly = Array.from(ni.keys()).filter(k => !oi.has(k));
  const oPairs = {}, nPairs = {};
  for (const k of oOnly) (oPairs[pairOf(k)] = oPairs[pairOf(k)] || []).push(k);
  for (const k of nOnly) (nPairs[pairOf(k)] = nPairs[pairOf(k)] || []).push(k);
  const logic_added = [], logic_removed = [], logic_changed = [];
  const consumed = new Set();
  for (const [k, nr] of ni) {
    const [pr, su, ty] = parts(k);
    if (oi.has(k)) {
      const orr = oi.get(k);
      if (Math.abs((orr.lag_hours || 0) - (nr.lag_hours || 0)) > 1e-6) {
        logic_changed.push({ pred: pr, succ: su, old_type: ty, new_type: ty, old_lag_days: lag(o, om, orr), new_lag_days: lag(n, nm, nr) });
      }
    } else if (nPairs[pairOf(k)].length === 1 && (oPairs[pairOf(k)] || []).length === 1) {
      const ok = oPairs[pairOf(k)][0];
      consumed.add(ok);
      logic_changed.push({ pred: pr, succ: su, old_type: parts(ok)[2], new_type: ty, old_lag_days: lag(o, om, oi.get(ok)), new_lag_days: lag(n, nm, nr) });
    } else {
      logic_added.push({ pred: pr, succ: su, type: ty, lag_days: lag(n, nm, nr) });
    }
  }
  for (const k of oOnly) {
    if (consumed.has(k)) continue;
    const [pr, su, ty] = parts(k);
    logic_removed.push({ pred: pr, succ: su, type: ty, lag_days: lag(o, om, oi.get(k)) });
  }

  // ---- critical path ----
  const ocIds = new Set(o.activities.filter(a => a.critical).map(a => a.id));
  const ncIds = new Set(n.activities.filter(a => a.critical).map(a => a.id));
  const joined = n.activities.filter(a => a.critical && !ocIds.has(a.id)).map(a => a.id);
  const left = o.activities.filter(a => a.critical && !ncIds.has(a.id)).map(a => a.id);

  // ---- finish drivers ----
  function changesFor(aid, inOld, inNew) {
    const ch = [];
    if (!inOld) ch.push({ kind: 'added' });
    if (!inNew) ch.push({ kind: 'removed' });
    for (const d of duration_changes) if (d.id === aid) ch.push({ kind: 'duration', old_days: d.old_days, new_days: d.new_days, delta_days: d.delta_days });
    for (const [kind, lst] of [['logic_added', logic_added], ['logic_changed', logic_changed], ['logic_removed', logic_removed]]) {
      for (const l of lst) if (l.succ === aid) ch.push(Object.assign({ kind }, l));
    }
    for (const c of constraint_changes) if (c.id === aid) ch.push({ kind: 'constraint', old: c.old, new: c.new });
    for (const c of progress_changes) if (c.id === aid) ch.push({ kind: 'progress', old_status: c.old_status, new_status: c.new_status, old_pct: c.old_pct, new_pct: c.new_pct });
    for (const c of cal_moves) if (c.id === aid) ch.push({ kind: 'calendar', old: c.old, new: c.new });
    return ch;
  }
  function chainChanges(p, isNew) {
    const [end, ids] = walkDriving(p);
    const items = [];
    for (const a of p.activities) {
      if (!ids.has(a.id)) continue;
      const ch = changesFor(a.id, isNew ? (a.id in om) : true, isNew ? true : (a.id in nm));
      if (ch.length) {
        const [ss, fs] = shifts[a.id] || [null, null];
        items.push({ id: a.id, name: a.name, start: startOf(a), start_shift_days: ss, finish_shift_days: fs, changes: ch });
      }
    }
    items.sort((x, y) => cmp(x.start || '', y.start || '') || cmp(x.id, y.id));
    return [end, items];
  }
  const [finAct, finish_drivers] = chainChanges(n, true);
  const former_path_changes = chainChanges(o, false)[1];

  const margin = (p, cal) => (p.must_finish_by ? daysBetween(cal, iso(p.finish), iso(p.must_finish_by)) : null);
  const counts = { added: added.length, removed: removed.length, renamed: renamed.length, duration_changes: duration_changes.length,
    date_moves: date_moves.length, logic_added: logic_added.length, logic_removed: logic_removed.length,
    logic_changed: logic_changed.length, constraint_changes: constraint_changes.length,
    progress_changes: progress_changes.length, calendar_changes: calendar_changes.length + cal_moves.length,
    critical_joined: joined.length, critical_left: left.length };
  const summary = {
    old_start: iso(o.start), new_start: iso(n.start),
    old_finish: iso(o.finish), new_finish: iso(n.finish),
    finish_shift_days: daysBetween(ncal, iso(o.finish), iso(n.finish)),
    old_must_finish_by: iso(o.must_finish_by), new_must_finish_by: iso(n.must_finish_by),
    old_margin_days: margin(o, ocal), new_margin_days: margin(n, ncal),
    finish_activity_id: finAct ? finAct.id : null,
    finish_activity_name: finAct ? finAct.name : null,
    critical_path_changed: !!(joined.length || left.length),
    counts,
  };
  return {
    summary,
    added, removed, renamed,
    duration_changes, date_moves,
    logic_added, logic_removed, logic_changed,
    constraint_changes, progress_changes,
    calendar_changes: { calendars: calendar_changes, activities: cal_moves },
    data_date: { old: iso(o.data_date), new: iso(n.data_date) },
    critical: { joined, left },
    finish_drivers,
    former_path_changes,
  };
}

// ---------------------------------------------------------------------------- narrative
const fd_ = s => `${+s.slice(8, 10)} ${MONTHS[+s.slice(5, 7) - 1]} ${+s.slice(0, 4)}`;
const num = x => (Number.isInteger(x) ? String(x) : pyFixed(x, 1));
const sgn = x => (x > 0 ? '+' : '') + num(x);
const count = (k, one, many) => `${k} ${k === 1 ? one : many}`;
const countN = (x, one, many) => `${num(x)} ${x === 1 ? one : many}`;
const wd = x => countN(Math.abs(x), 'working day', 'working days');
const and = items => (items.length <= 1 ? items.join('') : items.slice(0, -1).join(', ') + ' and ' + items[items.length - 1]);
function top(items) { const more = items.length - MAX_NAMED; return items.slice(0, MAX_NAMED).join(', ') + (more > 0 ? ` and ${more} more` : ''); }
const link = (t, lag) => t + (lag ? sgn(lag) + 'd' : '');
function cons(c) { if (c.type === 'none') return 'none'; const t = c.type.split('_').join(' '); return t + (c.date ? ' ' + fd_(c.date) : ''); }

function changeText(c) {
  const k = c.kind;
  if (k === 'added') return 'new activity';
  if (k === 'removed') return 'since removed';
  if (k === 'duration') return `${sgn(c.delta_days)}d duration`;
  if (k === 'logic_added') { const extra = (c.type === 'FS' && !c.lag_days) ? '' : ' ' + link(c.type, c.lag_days); return `new link ${c.pred}→${c.succ}${extra}`; }
  if (k === 'logic_removed') return `link ${c.pred}→${c.succ} removed`;
  if (k === 'logic_changed') return `link ${c.pred}→${c.succ} now ${link(c.new_type, c.new_lag_days)}, was ${link(c.old_type, c.old_lag_days)}`;
  if (k === 'constraint') return c.new.type === 'none' ? `constraint removed, was ${cons(c.old)}` : `constraint now ${cons(c.new)}`;
  if (k === 'progress') {
    if (c.new_status !== c.old_status) {
      if (c.new_status === 'complete') return 'now complete';
      if (c.new_status === 'in_progress') return `started, ${num(c.new_pct)}% complete`;
      return 'progress removed';
    }
    if (c.new_pct !== c.old_pct) return `progress ${num(c.old_pct)}% to ${num(c.new_pct)}%`;
    return 'actual dates revised';
  }
  return `calendar ${c.old} to ${c.new}`;
}
const itemText = it => `${it.id} ${it.name} (` + it.changes.map(changeText).join('; ') + ')';

function pick(items, shift) {
  const sh = shift || 0, sign = sh > 0 ? 1 : sh < 0 ? -1 : 0;
  const first = [];
  items.forEach((it, i) => { if (sign && (it.finish_shift_days == null || it.finish_shift_days * sign > 0)) first.push(i); });
  const fset = new Set(first);
  const rest = items.map((_, i) => i).filter(i => !fset.has(i));
  return first.concat(rest).slice(0, MAX_DRIVERS).sort((a, b) => a - b).map(i => items[i]);
}

function compareNarrative(result) {
  const s = result.summary, cnt = s.counts, dd = result.data_date;
  const moved = s.old_finish !== s.new_finish;
  const cc = result.calendar_changes;
  const calItems = cc.calendars.filter(c => c.used_by).map(c => c.calendar + ' ' + c.change).concat(cc.activities.map(c => c.id + ' to ' + c.new));
  const quiet = new Set(['date_moves', 'critical_joined', 'critical_left', 'calendar_changes']);
  const nothing = Object.entries(cnt).every(([k, v]) => quiet.has(k) || v === 0) && !calItems.length && dd.old === dd.new
    && s.old_start === s.new_start && s.old_must_finish_by === s.new_must_finish_by;
  const paras = [];

  // ---- headline ----
  const head = [];
  if (!moved) {
    if (nothing) head.push(`The programme is unchanged between the two versions. Forecast completion remains ${fd_(s.new_finish)}.`);
    else head.push(`Forecast completion is unchanged at ${fd_(s.new_finish)}.`);
  } else {
    const fs = s.finish_shift_days || 0;
    if (fs === 0) head.push(`Forecast completion has moved from ${fd_(s.old_finish)} to ${fd_(s.new_finish)}, by less than a tenth of a working day.`);
    else head.push(`Forecast completion has moved ${fs > 0 ? 'later' : 'earlier'} by ${wd(fs)}, from ${fd_(s.old_finish)} to ${fd_(s.new_finish)}.`);
  }
  const omfb = s.old_must_finish_by, nmfb = s.new_must_finish_by;
  if (nmfb) {
    let what = `the required completion date of ${fd_(nmfb)}`;
    if (omfb !== nmfb) {
      head.push(omfb ? `The required completion date moved from ${fd_(omfb)} to ${fd_(nmfb)}.` : `A required completion date of ${fd_(nmfb)} has been set.`);
      what = 'it';
    }
    const m = s.new_margin_days;
    let txt;
    if (m > 0) txt = `The forecast is ${wd(m)} ahead of ${what}`;
    else if (m < 0) txt = `The forecast is ${wd(m)} behind ${what}`;
    else txt = `The forecast meets ${what}`;
    const om = s.old_margin_days;
    if (omfb === nmfb && om != null && om !== m) txt += om !== 0 ? `, previously ${wd(om)} ${om > 0 ? 'ahead' : 'behind'}` : ', previously on the date';
    head.push(txt + '.');
  } else if (omfb) {
    head.push(`The required completion date of ${fd_(omfb)} has been removed.`);
  }
  paras.push(head.join(' '));

  // ---- drivers on the longest path ----
  const drv = [];
  const fdr = result.finish_drivers;
  if (fdr.length) {
    const named = and(pick(fdr, moved ? s.finish_shift_days : 0).map(itemText));
    const target = `${s.finish_activity_id} ${s.finish_activity_name}`;
    if (moved) drv.push(`On the longest path to ${target}, the movement is driven by ${named}.`);
    else drv.push(`Changes on the longest path to ${target}: ${named}.`);
    if (fdr.length > MAX_DRIVERS) drv.push(`${count(fdr.length - MAX_DRIVERS, 'further changed activity lies', 'further changed activities lie')} on that path.`);
  } else if (moved) {
    const fp = result.former_path_changes;
    if (fp.length) drv.push('No changed activity lies on the new longest path; the former longest path changed at ' + and(pick(fp, 0).map(itemText)) + '.');
    else if (s.old_start !== s.new_start) drv.push(`No changed activity lies on the longest path; the movement follows the project start moving from ${fd_(s.old_start)} to ${fd_(s.new_start)}.`);
    else if (dd.old !== dd.new && dd.old && dd.new) drv.push(`No changed activity lies on the longest path; the movement follows the data date moving from ${fd_(dd.old)} to ${fd_(dd.new)}.`);
    else drv.push('No changed activity lies on the longest path; the movement comes from changes elsewhere in the programme.');
  }
  if (s.critical_path_changed) {
    const cr = result.critical, parts = [];
    if (cr.joined.length) parts.push(`${count(cr.joined.length, 'activity', 'activities')} joined (${top(cr.joined)})`);
    if (cr.left.length) parts.push(`${count(cr.left.length, 'activity', 'activities')} left (${top(cr.left)})`);
    drv.push('The critical path has changed: ' + parts.join(' and ') + '.');
  }
  if (drv.length) paras.push(drv.join(' '));

  // ---- everything else ----
  const parts = [];
  const R = result;
  if (R.added.length) parts.push(`${count(R.added.length, 'activity', 'activities')} added (${top(R.added.map(x => x.id + ' ' + x.name))})`);
  if (R.removed.length) parts.push(`${count(R.removed.length, 'activity', 'activities')} removed (${top(R.removed.map(x => x.id + ' ' + x.name))})`);
  if (R.renamed.length) parts.push(`${R.renamed.length} renamed (${top(R.renamed.map(x => x.id))})`);
  if (R.duration_changes.length) parts.push(`${count(R.duration_changes.length, 'duration', 'durations')} changed (${top(R.duration_changes.map(x => x.id + ' ' + sgn(x.delta_days) + 'd'))})`);
  const logic = [];
  for (const [key, verb] of [['logic_added', 'added'], ['logic_removed', 'removed'], ['logic_changed', 'changed']]) {
    if (R[key].length) logic.push(`${count(R[key].length, 'link', 'links')} ${verb}`);
  }
  if (logic.length) parts.push(and(logic));
  if (R.constraint_changes.length) parts.push(`${count(R.constraint_changes.length, 'constraint', 'constraints')} changed (${top(R.constraint_changes.map(x => x.id))})`);
  if (R.progress_changes.length) parts.push(`progress updated on ${count(R.progress_changes.length, 'activity', 'activities')} (${top(R.progress_changes.map(x => x.id + ' ' + num(x.new_pct) + '%'))})`);
  if (calItems.length) parts.push(`${count(calItems.length, 'calendar change', 'calendar changes')} (${top(calItems)})`);
  if (dd.old !== dd.new) {
    if (dd.old && dd.new) parts.push(`the data date moved from ${fd_(dd.old)} to ${fd_(dd.new)}`);
    else if (dd.new) parts.push(`a data date of ${fd_(dd.new)} was set`);
    else parts.push('the data date was cleared');
  }
  if (s.old_start !== s.new_start) parts.push(`the project start moved from ${fd_(s.old_start)} to ${fd_(s.new_start)}`);
  if (R.date_moves.length) parts.push(`${count(R.date_moves.length, 'activity has', 'activities have')} moved in date`);
  if (parts.length) paras.push('Across the programme: ' + parts.join('; ') + '.');
  return paras.join('\n\n');
}

Object.assign(global.PlannerEngine, { compareProjects, compareNarrative });
})(typeof window !== 'undefined' ? window : globalThis);

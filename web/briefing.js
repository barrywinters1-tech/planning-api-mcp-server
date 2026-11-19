/* Briefing: a line-for-line port of planner/briefing.py. Load after engine.js and compare.js.
   briefing(project, {today}) -> the same dict as Python's briefing(project, today=...): headline, status,
   kpis, what changed since the last period / revision / baseline, watch list, next two weeks, actions,
   milestones and the whole thing as prose. "today" defaults to the data date (or the start), so the
   output is deterministic. The input is never mutated: a clone is scheduled.
   tests/test_briefing_parity.py holds the two engines to identical output. */
'use strict';
(function (global) {
const E = global.PlannerEngine;
const { D, ISO, YMD, dateOnly, Cal, calFor, predsOf, succsOf, isMs, schedule, pyRound, pyFixed, HARD } = E;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const EPS = 1e-6;
const LOOKAHEAD_DAYS = 14;
const NEAR_DAYS = 28;
const NEAR_FLOAT = 5;
const THIN_MARGIN = 5;
const BEHIND_BASELINE = 5;
const HIGH_DRAG = 5;
const LONG_DURATION = 44;
const PERIOD_DUE = 21;
const REPAIR_BELOW = 70;
const RISK_FROM = 40;
const MAX_ITEMS = 8;
const MAX_LIST = 10;
const MAX_ACTIONS = 5;
const MAX_NAMES = 5;
const WATCH_IN_PROSE = 4;
const LOE = 'level_of_effort';

// ---- every string the briefing can emit: a verbatim copy of T in planner/briefing.py. Keep the two tables identical. ----
const T = {
  head_on_track: 'On track: forecast finish {finish}, {margin}.',
  head_at_risk: 'At risk: forecast finish {finish}, {margin}{neg}.',
  head_at_risk_no_deadline: 'At risk: forecast finish {finish}, no deadline set{neg}.',
  head_late: 'Late: forecast finish {finish}, {margin}.',
  head_no_deadline: 'Forecast finish {finish}; no deadline has been set.',
  head_not_started: 'Not started: forecast finish {finish}, {margin}.',
  head_not_started_no_deadline: 'Not started: forecast finish {finish}; no deadline has been set.',
  head_complete: 'Complete: all {n} finished, final finish {finish}.',
  head_empty: 'Not started: the programme has no activities yet.',
  neg_clause: ', with {k} on negative float',
  margin_inside: '{n} inside the {deadline} deadline',
  margin_exact: 'meeting the {deadline} deadline exactly',
  margin_beyond: '{n} beyond the {deadline} deadline',
  since_none: 'No baseline, revision or closed period yet.',
  since_period: 'What changed since {name} ({date}): {parts}.',
  since_revision: 'What changed since {name} (issued {date}): {parts}.',
  since_baseline: 'Against the {name} baseline (saved {date}): {parts}.',
  since_baseline_nodate: 'Against the {name} baseline: {parts}.',
  finish_later: 'finish moved {n} later',
  finish_earlier: 'finish moved {n} earlier',
  finish_same: 'finish unchanged at {finish}',
  finish_unrecorded: 'no finish was recorded at the period',
  finish_later_baseline: 'finish {n} later than the baseline',
  finish_earlier_baseline: 'finish {n} earlier than the baseline',
  finish_same_baseline: 'finish on the baseline date of {finish}',
  slipped: '{k} slipped',
  progress_clause: 'progress {pct}% against {was}% at the period',
  completed_clause: '{k} completed since',
  cnt_added: '{k} added',
  cnt_removed: '{k} removed',
  cnt_durations: '{k} changed',
  cnt_links: '{k} changed',
  cnt_constraints: '{k} changed',
  cnt_progress: 'progress updated on {k}',
  cnt_moved: '{k} moved in date',
  no_other_changes: 'no other changes',
  behind_clause: '{k} behind their baseline finish',
  ahead_clause: '{k} ahead of it',
  on_baseline: 'every activity on its baseline dates',
  item_slip: 'finish moved {n} later, {old} to {new}',
  item_behind: 'finish {n} later than the baseline, {old} to {new}',
  item_rev_moved: 'finish moved {n} {dir}{changes}',
  item_rev_same: 'dates unchanged{changes}',
  dir_later: 'later',
  dir_earlier: 'earlier',
  ch_added: 'new activity',
  ch_removed: 'since removed',
  ch_duration: 'duration {delta}d',
  ch_logic_added: 'new link from {pred}',
  ch_logic_removed: 'link from {pred} removed',
  ch_logic_changed: 'link from {pred} changed',
  ch_constraint: 'constraint changed',
  ch_progress: 'progress updated',
  ch_calendar: 'calendar changed',
  w_negative_float: 'Negative float of {n}: the dates required of it cannot be met through the logic.',
  w_critical_soon: 'Critical and due to start {date}: any delay moves the finish day for day.',
  w_near_critical: 'Only {n} of float and due to start {date}.',
  w_behind_baseline: 'Running {n} behind its baseline finish of {date}.',
  w_out_of_sequence: 'Progressed out of sequence: {reason} ({pred}).',
  w_high_drag: 'Carries {n} of drag: shortening it brings the finish forward.',
  w_constraint: 'Hard constraint ({constraint}) on the critical path: the logic cannot move it.',
  w_open_end: 'Open end: no {what} drives its dates.',
  w_long_duration: '{n} remaining in a single activity: consider splitting it so progress can be tracked.',
  w_no_progress: 'In progress with no progress recorded since {name} ({date}).',
  what_pred: 'predecessor',
  what_succ: 'successor',
  what_both: 'predecessor or successor',
  a_set_baseline: 'Set a baseline before work starts so progress can be measured against the agreed programme.',
  a_close_period: 'Close a progress period at the {date} data date so this update is kept as a record.',
  a_close_period_first: 'No progress period has been closed yet: close one at the {date} data date to start the record.',
  a_repair: 'Schedule health is {score}/100 ({fails}): run the repair.',
  a_accelerate: 'Recover {n} of negative float, starting with {act}, which carries the most drag ({drag}).',
  a_accelerate_plain: 'Recover {n} of negative float on the critical path.',
  a_add_deadline: 'Set a must-finish-by date so float is measured against the commitment.',
  a_review_logic: '{k} progressed out of sequence: review the logic so the forecast follows how the work is actually being done.',
  a_issue: 'Issue a revision: the last one ({name}) predates {period}.',
  a_issue_first: 'Issue a revision so the programme at {period} is kept for comparison.',
  a_run_risk: 'Run the risk analysis: with {k} open, a finish range is worth having.',
  p_kpis: 'The programme is {pct}% complete against {exp}% expected at {as_of}, with {open} still open ({crit} on the critical path), {weeks} to run and a schedule health of {score}/100.',
  p_movers: ' The biggest movers: {names}.',
  p_watch: 'To watch: {items}',
  p_watch_none: 'Nothing is flagged for attention.',
  p_watch_item: '{id} {name}: {text}',
  p_next: 'In the next two weeks ({from} to {to}): {starting} starting, {finishing} finishing, {milestones} due{ms}.',
  p_next_none: 'Nothing starts or finishes in the next two weeks ({from} to {to}).',
  p_actions: 'Next steps: {items}',
  more: ' and {n} more',
  working_day: 'working day',
  working_days: 'working days',
  activity: 'activity',
  activities: 'activities',
  milestone: 'milestone',
  milestones: 'milestones',
  duration: 'duration',
  durations: 'durations',
  link: 'link',
  links: 'links',
  constraint: 'constraint',
  constraints: 'constraints',
  week: 'week',
  weeks: 'weeks',
  none: 'no',
  colon_list: ': {names}',
};

// ---------------------------------------------------------------------------- helpers
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);     // Python str ordering (code points; same for BMP text)
const r1 = x => pyRound(x, 1) + 0;                      // + 0 turns -0 into 0, as Python's + 0.0 does
const dt = x => (x == null || x === '' ? null : D(x));
const iso = x => (x == null || x === '' ? null : ISO(D(x)));
const ymd = d => YMD(d);
const fd_ = s => `${+s.slice(8, 10)} ${MONTHS[+s.slice(5, 7) - 1]} ${+s.slice(0, 4)}`;
const num = x => (Number.isInteger(x) ? String(x) : pyFixed(x, 1));
const sgn = x => (x > 0 ? '+' : '') + num(x);
const k_ = (k, one, many) => `${k === 0 ? T.none : num(k)} ${T[k === 1 ? one : many]}`;
const wd = x => k_(Math.abs(x), 'working_day', 'working_days');
const and = items => (items.length <= 1 ? items.join('') : items.slice(0, -1).join(', ') + ' and ' + items[items.length - 1]);
function names(items) { const more = items.length - MAX_NAMES; return and(items.slice(0, MAX_NAMES)) + (more > 0 ? t('more', { n: more }) : ''); }
function t(key, kw) { return T[key].replace(/\{(\w+)\}/g, (_, k) => { const v = (kw || {})[k]; return v == null ? '' : String(v); }); }
const status = a => a.status || 'not_started';
const pct = a => a.percent_complete || 0;
const aStart = a => a.actual_start || a.early_start || null;
const aFinish = a => a.actual_finish || a.early_finish || null;
const label = a => `${a.id} ${a.name}`;

function scheduled(p) {
  const q = JSON.parse(JSON.stringify(p));
  if (!q.levelled || !q.finish || q.activities.some(a => !a.early_start)) schedule(q);
  return q;
}
function defaultCal(p) { const c = (p.calendars || {})[p.default_calendar_id]; return new Cal(c || { id: p.default_calendar_id }); }
function daysBetween(cal, a, b) {
  if (a == null || b == null) return null;
  return r1(cal.hours_to_days(cal.hours_between(D(a), D(b))));
}
const calDays = (a, b) => Math.round((dateOnly(D(b)) - dateOnly(D(a))) / 86400000);
const tm = d => (d ? d.getTime() : null);

function finishClause(shift, finIso, sameKey, laterKey, earlierKey) {
  if (shift == null || shift === 0) return t(sameKey, { finish: fd_(finIso) });
  return t(shift > 0 ? laterKey : earlierKey, { n: wd(shift) });
}

// ---------------------------------------------------------------------------- progress figures
function progressOf(p, acts, now) {
  let total = 0, done = 0, planned = 0, n = 0, nDone = 0, nDue = 0;
  for (const a of acts) {
    n += 1;
    const [s, f] = (a.baseline_start && a.baseline_finish) ? [dt(a.baseline_start), dt(a.baseline_finish)] : [dt(aStart(a)), dt(aFinish(a))];
    if (status(a) === 'complete') nDone += 1;
    if (f != null && f <= now) nDue += 1;
    const w = a.duration_hours || 0;
    if (w <= 0) continue;
    total += w;
    if (status(a) === 'complete') done += w;
    else if (status(a) === 'in_progress') done += w * pct(a) / 100;
    if (s != null && f != null) {
      const cal = calFor(p, a);
      const span = cal.hours_between(s, f);
      const frac = span <= 0 ? (now >= f ? 1 : 0) : Math.min(1, Math.max(0, cal.hours_between(s, now) / span));
      planned += w * frac;
    }
  }
  if (total <= 0) return n ? [r1(100 * nDone / n), r1(100 * nDue / n)] : [0, 0];
  return [r1(100 * done / total), r1(100 * planned / total)];
}

// ---------------------------------------------------------------------------- since
function periodsOf(p) {
  const out = (p.progress_periods || []).filter(x => x.data_date);
  out.sort((a, b) => cmp(iso(a.data_date), iso(b.data_date)) || cmp(String(a.id || ''), String(b.id || '')));
  return out;
}
function lastPeriod(periods, now) {
  const earlier = periods.filter(x => ymd(dt(x.data_date)) < ymd(now));
  return earlier.length ? earlier[earlier.length - 1] : (periods.length ? periods[periods.length - 1] : null);
}
function lastRevision(p) {
  let best = null;
  for (const r of p.revisions || []) {
    const a = dt(r.issued_at), b = best ? dt(best.issued_at) : null;
    if (best === null || (a ? a.getTime() : -Infinity) >= (b ? b.getTime() : -Infinity)) best = r;
  }
  return best;
}
function lastBaseline(p, acts) {
  let best = null;
  for (const b of p.baselines || []) {
    const a = dt(b.saved_at), c = best ? dt(best.saved_at) : null;
    if (best === null || (a ? a.getTime() : -Infinity) >= (c ? c.getTime() : -Infinity)) best = b;
  }
  if (best !== null) return { name: best.name, saved_at: dt(best.saved_at), finish: best.finish, dates: best.dates || {} };
  if (acts.some(a => a.baseline_finish)) return { name: 'Baseline', saved_at: null, finish: null, dates: {} };
  return null;
}
function changeText(c) {
  const k = c.kind;
  if (k === 'duration') return t('ch_duration', { delta: sgn(c.delta_days) });
  if (k === 'logic_added' || k === 'logic_removed' || k === 'logic_changed') return t('ch_' + k, { pred: c.pred });
  return T['ch_' + k];
}

function since(p, acts, now, dcal, finish, period, pctNow) {
  const rev = lastRevision(p), bl = lastBaseline(p, acts);
  const cands = [period ? ['period', period, dt(period.closed_at) || dt(period.data_date)] : null,
                 rev ? ['revision', rev, dt(rev.issued_at)] : null,
                 bl ? ['baseline', bl, bl.saved_at] : null];
  let pick = null;
  for (const c of cands) {
    if (c === null) continue;
    if (pick === null || (c[2] != null && (pick[2] == null || tm(c[2]) > tm(pick[2])))) pick = c;
  }
  if (pick === null) return { kind: 'none', name: null, date: null, finish_shift_days: null, summary: T.since_none, items: [] };
  const [kind, rec] = pick;
  const finIso = iso(finish);

  if (kind === 'period') {
    const recFinish = dt(rec.finish);
    const shift = daysBetween(dcal, recFinish, finish);
    const pacts = rec.acts || {};
    const slipped = []; let completed = 0;
    for (const a of acts) {
      const r = pacts[a.id];
      if (!r) continue;
      if (r[3] !== 'c' && status(a) === 'complete') completed += 1;
      const slip = daysBetween(calFor(p, a), dt(r[1]), aFinish(a));
      if (slip != null && slip > 0) slipped.push([a, slip, r[1]]);
    }
    slipped.sort((x, y) => (y[1] - x[1]) || cmp(x[0].id, y[0].id));
    const items = slipped.slice(0, MAX_ITEMS).map(([a, slip, old]) => ({ id: a.id, name: a.name, text: t('item_slip', { n: wd(slip), old: fd_(old), new: fd_(iso(aFinish(a))) }) }));
    const parts = [recFinish == null ? T.finish_unrecorded : finishClause(shift, finIso, 'finish_same', 'finish_later', 'finish_earlier')];
    if (slipped.length) parts.push(t('slipped', { k: k_(slipped.length, 'activity', 'activities') }));
    if (rec.pct != null) parts.push(t('progress_clause', { pct: num(pctNow), was: num(r1(rec.pct)) }));
    if (completed) parts.push(t('completed_clause', { k: k_(completed, 'activity', 'activities') }));
    const date = iso(rec.data_date);
    return { kind, name: rec.name == null ? null : rec.name, date, finish_shift_days: shift,
             summary: t('since_period', { name: rec.name, date: fd_(date), parts: parts.join('; ') }), items };
  }

  if (kind === 'revision') {
    const res = E.compareProjects(rec.project, p);
    const s = res.summary, cnt = s.counts;
    const shift = s.old_finish !== s.new_finish ? s.finish_shift_days : null;
    const items = [], seen = new Set();
    for (const it of res.finish_drivers) {
      if (items.length >= MAX_ITEMS) break;
      seen.add(it.id);
      const ch = it.changes.map(changeText).join('; ');
      const fs = it.finish_shift_days;
      const changes = ch ? ` (${ch})` : '';
      const text = fs ? t('item_rev_moved', { n: wd(fs), dir: T[fs > 0 ? 'dir_later' : 'dir_earlier'], changes }) : t('item_rev_same', { changes });
      items.push({ id: it.id, name: it.name, text });
    }
    for (const m of res.date_moves) {
      if (items.length >= MAX_ITEMS) break;
      const fs = m.finish_shift_days;
      if (seen.has(m.id) || !fs) continue;
      seen.add(m.id);
      items.push({ id: m.id, name: m.name, text: t('item_rev_moved', { n: wd(fs), dir: T[fs > 0 ? 'dir_later' : 'dir_earlier'], changes: '' }) });
    }
    const parts = [finishClause(shift, finIso, 'finish_same', 'finish_later', 'finish_earlier')];
    const extra = [];
    if (cnt.added) extra.push(t('cnt_added', { k: k_(cnt.added, 'activity', 'activities') }));
    if (cnt.removed) extra.push(t('cnt_removed', { k: k_(cnt.removed, 'activity', 'activities') }));
    if (cnt.duration_changes) extra.push(t('cnt_durations', { k: k_(cnt.duration_changes, 'duration', 'durations') }));
    const links = cnt.logic_added + cnt.logic_removed + cnt.logic_changed;
    if (links) extra.push(t('cnt_links', { k: k_(links, 'link', 'links') }));
    if (cnt.constraint_changes) extra.push(t('cnt_constraints', { k: k_(cnt.constraint_changes, 'constraint', 'constraints') }));
    if (cnt.progress_changes) extra.push(t('cnt_progress', { k: k_(cnt.progress_changes, 'activity', 'activities') }));
    if (cnt.date_moves) extra.push(t('cnt_moved', { k: k_(cnt.date_moves, 'activity', 'activities') }));
    for (const x of (extra.length ? extra : [T.no_other_changes])) parts.push(x);
    const date = iso(rec.issued_at);
    return { kind, name: rec.name == null ? null : rec.name, date, finish_shift_days: shift,
             summary: t('since_revision', { name: rec.name, date: date ? fd_(date) : '', parts: parts.join('; ') }), items };
  }

  // baseline
  const blFinish = dt(rec.finish);
  const shift = daysBetween(dcal, blFinish, finish);
  const behind = []; let ahead = 0;
  for (const a of acts) {
    const d = rec.dates[a.id] || {};
    const bf = dt(d.finish) || dt(a.baseline_finish);
    const v = daysBetween(calFor(p, a), bf, aFinish(a));
    if (v == null) continue;
    if (v > 0) behind.push([a, v, iso(bf)]);
    else if (v < 0) ahead += 1;
  }
  behind.sort((x, y) => (y[1] - x[1]) || cmp(x[0].id, y[0].id));
  const items = behind.slice(0, MAX_ITEMS).map(([a, v, old]) => ({ id: a.id, name: a.name, text: t('item_behind', { n: wd(v), old: fd_(old), new: fd_(iso(aFinish(a))) }) }));
  const parts = [];
  if (blFinish != null) parts.push(finishClause(shift, finIso, 'finish_same_baseline', 'finish_later_baseline', 'finish_earlier_baseline'));
  if (behind.length) parts.push(t('behind_clause', { k: k_(behind.length, 'activity', 'activities') }));
  if (ahead) parts.push(t('ahead_clause', { k: k_(ahead, 'activity', 'activities') }));
  if (!behind.length && !ahead) parts.push(T.on_baseline);
  const date = rec.saved_at ? ISO(rec.saved_at) : null;
  const summary = date ? t('since_baseline', { name: rec.name, date: fd_(date), parts: parts.join('; ') })
    : t('since_baseline_nodate', { name: rec.name, parts: parts.join('; ') });
  return { kind, name: rec.name, date, finish_shift_days: shift, summary, items };
}

// ---------------------------------------------------------------------------- briefing
function briefing(project, opts) {
  const o = opts || {};
  const p = scheduled(project);
  const dcal = defaultCal(p);
  const now = dt(o.today) || dt(p.data_date) || dt(p.start);
  const acts = p.activities.filter(a => a.type !== LOE);
  const open = acts.filter(a => status(a) !== 'complete');
  const started = acts.filter(a => status(a) !== 'not_started');
  const finish = dt(p.finish) || dt(p.start);
  const finIso = iso(finish);
  const deadline = dt(p.must_finish_by);
  const spare = deadline != null ? daysBetween(dcal, finish, deadline) : null;
  const neg = open.filter(a => a.total_float_hours != null && a.total_float_hours < -EPS);
  const report = acts.length ? E.healthCheck(p) : null;
  const drag = open.length ? E.criticalDrag(p) : [];
  const oos = E.outOfSequence(p);
  const [pctNow, pctExp] = progressOf(p, acts, now);
  const periods = periodsOf(p);
  const period = lastPeriod(periods, now);
  const periodBefore = period && ymd(dt(period.data_date)) < ymd(now) ? period : null;

  // ---- status and headline ----
  let st;
  if (!acts.length) st = 'not_started';
  else if (!open.length) st = 'complete';
  else if (spare != null && spare < 0) st = 'late';
  else if (!started.length) st = 'not_started';
  else if (spare == null) st = neg.length ? 'at_risk' : 'no_deadline';
  else if (spare < THIN_MARGIN || neg.length) st = 'at_risk';
  else st = 'on_track';

  const margin = () => {
    if (spare > 0) return t('margin_inside', { n: wd(spare), deadline: fd_(iso(deadline)) });
    if (spare < 0) return t('margin_beyond', { n: wd(spare), deadline: fd_(iso(deadline)) });
    return t('margin_exact', { deadline: fd_(iso(deadline)) });
  };
  const negClause = neg.length ? t('neg_clause', { k: k_(neg.length, 'activity', 'activities') }) : '';
  const fd = fd_(finIso);
  let headline;
  if (!acts.length) headline = T.head_empty;
  else if (st === 'complete') headline = t('head_complete', { n: k_(acts.length, 'activity', 'activities'), finish: fd });
  else if (st === 'late') headline = t('head_late', { finish: fd, margin: margin() });
  else if (st === 'not_started') headline = spare != null ? t('head_not_started', { finish: fd, margin: margin() }) : t('head_not_started_no_deadline', { finish: fd });
  else if (st === 'at_risk') headline = spare != null ? t('head_at_risk', { finish: fd, margin: margin(), neg: negClause }) : t('head_at_risk_no_deadline', { finish: fd, neg: negClause });
  else if (st === 'no_deadline') headline = t('head_no_deadline', { finish: fd });
  else headline = t('head_on_track', { finish: fd, margin: margin() });

  const kpis = {
    finish: finIso, deadline: iso(deadline), spare_days: spare,
    pct_complete: pctNow, pct_expected: pctExp,
    critical_open: open.filter(a => a.critical).length,
    health_score: report ? report.score : null,
    activities_open: open.length,
    weeks_remaining: r1(Math.max(0, calDays(now, finish)) / 7),
  };

  const sinceOut = since(p, acts, now, dcal, finish, period, pctNow);

  // ---- watch ----
  const watch = new Map();
  const flag = (a, reason, text, severity) => {
    let w = watch.get(a.id);
    if (!w) { w = { id: a.id, name: a.name, reason, texts: [], severity, date: iso(aStart(a)) || '' }; watch.set(a.id, w); }
    if (severity > w.severity) { w.severity = severity; w.reason = reason; }
    w.texts.push(text);
  };
  const oosBy = {};
  for (const x of oos) (oosBy[x.successor] = oosBy[x.successor] || []).push(x);
  const dragBy = {}; for (const d of drag) dragBy[d.id] = d;
  const logic = report ? report.checks.find(c => c.key === 'logic') : null;
  const openEnds = new Set(logic ? logic.items : []);
  const pacts = periodBefore ? (periodBefore.acts || {}) : {};
  for (const a of open) {
    const cal = calFor(p, a);
    const tf = a.total_float_hours != null ? cal.hours_to_days(a.total_float_hours) : null;
    const toStart = aStart(a) ? calDays(now, aStart(a)) : null;
    if (a.total_float_hours != null && a.total_float_hours < -EPS) flag(a, 'negative_float', t('w_negative_float', { n: wd(r1(-tf)) }), 3);
    if (a.critical && status(a) === 'not_started' && toStart != null && toStart >= 0 && toStart <= LOOKAHEAD_DAYS) flag(a, 'critical_soon', t('w_critical_soon', { date: fd_(iso(aStart(a))) }), 3);
    for (const x of oosBy[a.id] || []) flag(a, 'out_of_sequence', t('w_out_of_sequence', { reason: x.reason, pred: x.predecessor }), 2);
    if (a.baseline_finish && aFinish(a)) {
      const v = daysBetween(cal, a.baseline_finish, aFinish(a));
      if (v > BEHIND_BASELINE) flag(a, 'behind_baseline', t('w_behind_baseline', { n: wd(v), date: fd_(iso(a.baseline_finish)) }), 2);
    }
    const d = dragBy[a.id];
    if (d && d.drag_days >= HIGH_DRAG) flag(a, 'high_drag', t('w_high_drag', { n: wd(d.drag_days) }), 2);
    if (!a.critical && tf != null && tf >= -EPS && tf <= NEAR_FLOAT && status(a) === 'not_started' && toStart != null && toStart >= 0 && toStart <= NEAR_DAYS) {
      flag(a, 'near_critical', t('w_near_critical', { n: wd(r1(tf)), date: fd_(iso(aStart(a))) }), 1);
    }
    if (a.critical && HARD.has(a.constraint)) flag(a, 'constraint', t('w_constraint', { constraint: a.constraint.split('_').join(' ') }), 1);
    const r = pacts[a.id];
    if (status(a) === 'in_progress' && r && r[3] === 'p' && pyRound(pct(a)) <= r[2]) {
      flag(a, 'no_progress', t('w_no_progress', { name: periodBefore.name, date: fd_(iso(periodBefore.data_date)) }), 1);
    }
    if (openEnds.has(a.id)) {
      const hasPred = predsOf(p, a.id).length > 0, hasSucc = succsOf(p, a.id).length > 0;
      const what = (!hasPred && !hasSucc) ? T.what_both : !hasPred ? T.what_pred : T.what_succ;
      flag(a, 'open_end', t('w_open_end', { what }), 1);
    }
    if (!isMs(a)) {
      const rem = a.remaining_hours != null ? a.remaining_hours : (a.duration_hours || 0);
      if (cal.hours_to_days(rem) > LONG_DURATION) flag(a, 'long_duration', t('w_long_duration', { n: wd(r1(cal.hours_to_days(rem))) }), 1);
    }
  }
  const watchList = Array.from(watch.values()).sort((x, y) => (y.severity - x.severity) || cmp(x.date, y.date) || cmp(x.id, y.id)).slice(0, MAX_ITEMS);
  const watchOut = watchList.map(w => ({ id: w.id, name: w.name, reason: w.reason, text: w.texts.join(' '), severity: w.severity }));

  // ---- next two weeks ----
  const wFrom = dateOnly(now), wTo = new Date(wFrom.getTime() + LOOKAHEAD_DAYS * 86400000);
  const inWin = x => { const d = dateOnly(D(x)); return d >= wFrom && d <= wTo; };
  const starting = [], finishing = [], due = [];
  for (const a of acts) {
    if (isMs(a)) {
      const d0 = aFinish(a) || aStart(a);
      if (status(a) !== 'complete' && d0 != null && inWin(d0)) due.push({ id: a.id, name: a.name, date: iso(d0) });
      continue;
    }
    if (status(a) === 'not_started' && aStart(a) != null && inWin(aStart(a))) starting.push({ id: a.id, name: a.name, date: iso(aStart(a)) });
    if (status(a) !== 'complete' && aFinish(a) != null && inWin(aFinish(a))) finishing.push({ id: a.id, name: a.name, date: iso(aFinish(a)) });
  }
  for (const lst of [starting, finishing, due]) lst.sort((x, y) => cmp(x.date, y.date) || cmp(x.id, y.id));
  const nxt = { from: YMD(wFrom), to: YMD(wTo), starting: starting.slice(0, MAX_LIST), finishing: finishing.slice(0, MAX_LIST), milestones: due.slice(0, MAX_LIST) };

  // ---- actions ----
  let actions = [];
  const hasBaseline = (p.baselines || []).length > 0 || acts.some(a => a.baseline_finish);
  if (acts.length && !started.length && !hasBaseline) actions.push({ kind: 'set_baseline', text: T.a_set_baseline });
  const inProgress = acts.some(a => status(a) === 'in_progress');
  const lastAny = periods.length ? periods[periods.length - 1] : null;
  if (inProgress && (lastAny === null || calDays(dt(lastAny.data_date), now) > PERIOD_DUE)) {
    actions.push({ kind: 'close_period', text: t(lastAny ? 'a_close_period' : 'a_close_period_first', { date: fd_(ISO(now)) }) });
  }
  if (report && report.score < REPAIR_BELOW) {
    const fails = report.checks.filter(c => c.applicable && !c.passed).map(c => c.title);
    actions.push({ kind: 'repair', text: t('a_repair', { score: report.score, fails: names(fails) }) });
  }
  if (neg.length) {
    // the days to recover: the deadline shortfall when late, otherwise the deepest negative float
    let worst = -Infinity; for (const a of neg) worst = Math.max(worst, r1(-calFor(p, a).hours_to_days(a.total_float_hours)));
    if (spare != null && spare < 0) worst = -spare;
    const top = drag.length && drag[0].drag_days > 0 ? drag[0] : null;
    actions.push({ kind: 'accelerate', text: top ? t('a_accelerate', { n: wd(worst), act: `${top.id} ${top.name}`, drag: wd(top.drag_days) }) : t('a_accelerate_plain', { n: wd(worst) }) });
  }
  if (deadline == null && acts.length) actions.push({ kind: 'add_deadline', text: T.a_add_deadline });
  if (oos.length) actions.push({ kind: 'review_logic', text: t('a_review_logic', { k: k_(Object.keys(oosBy).length, 'activity', 'activities') }) });
  if (lastAny !== null) {
    const rev = lastRevision(p);
    const closed = dt(lastAny.closed_at) || dt(lastAny.data_date);
    const issued = rev ? dt(rev.issued_at) : null;
    if (rev === null || issued === null || issued < closed) {
      actions.push({ kind: 'issue', text: rev ? t('a_issue', { name: rev.name, period: lastAny.name }) : t('a_issue_first', { period: lastAny.name }) });
    }
  }
  if (p.risk == null && open.length >= RISK_FROM) actions.push({ kind: 'run_risk', text: t('a_run_risk', { k: k_(open.length, 'activity', 'activities') }) });
  actions = actions.slice(0, MAX_ACTIONS);

  // ---- milestones ----
  const ms = [];
  for (const a of acts) {
    if (!isMs(a)) continue;
    const d0 = aFinish(a) || aStart(a);
    const b0 = a.baseline_finish || a.baseline_start || null;
    ms.push({ id: a.id, name: a.name, date: iso(d0), baseline_date: iso(b0), variance_days: daysBetween(calFor(p, a), b0, d0), status: status(a) });
  }
  ms.sort((x, y) => cmp(x.date || '', y.date || '') || cmp(x.id, y.id));

  // ---- prose ----
  const paras = [];
  const p1 = [headline];
  if (acts.length && st !== 'complete') {
    p1.push(t('p_kpis', { pct: num(pctNow), exp: num(pctExp), as_of: fd_(ymd(now)), open: k_(open.length, 'activity', 'activities'),
      crit: kpis.critical_open, weeks: k_(kpis.weeks_remaining, 'week', 'weeks'), score: kpis.health_score }));
  }
  if (sinceOut.kind === 'none') p1.push(sinceOut.summary);
  paras.push(p1.join(' '));
  if (sinceOut.kind !== 'none') paras.push(sinceOut.summary + (sinceOut.items.length ? t('p_movers', { names: names(sinceOut.items.map(i => `${i.id} ${i.name}`)) }) : ''));
  const p3 = [watchOut.length ? t('p_watch', { items: watchOut.slice(0, WATCH_IN_PROSE).map(w => t('p_watch_item', { id: w.id, name: w.name, text: w.text })).join(' ') }) : T.p_watch_none];
  if (starting.length || finishing.length || due.length) {
    p3.push(t('p_next', { from: fd_(nxt.from), to: fd_(nxt.to), starting: k_(starting.length, 'activity', 'activities'),
      finishing: k_(finishing.length, 'activity', 'activities'), milestones: k_(due.length, 'milestone', 'milestones'),
      ms: due.length ? t('colon_list', { names: names(due.map(m => `${m.id} ${m.name} (${fd_(m.date)})`)) }) : '' }));
  } else {
    p3.push(t('p_next_none', { from: fd_(nxt.from), to: fd_(nxt.to) }));
  }
  paras.push(p3.join(' '));
  if (actions.length) paras.push(t('p_actions', { items: actions.map(a => a.text).join(' ') }));

  return {
    as_of: ymd(now),
    headline,
    status: st,
    kpis,
    since: sinceOut,
    watch: watchOut,
    next: nxt,
    actions,
    milestones: ms,
    prose: paras.join('\n\n'),
  };
}

Object.assign(global.PlannerEngine, { briefing });
})(typeof window !== 'undefined' ? window : globalThis);

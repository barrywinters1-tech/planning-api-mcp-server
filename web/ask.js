/* Plain-English questions answered from the engine: a line-for-line port of planner/ask.py.
   Load after engine.js and compare.js.
     ask(project, question, { today }) -> { kind, answer, ids, filter, trace, goto, confidence, suggestions }
   Deterministic ("today" is the data date unless given), never mutates the project, never throws.
   The string tables T, STOP, SUGGEST and ASK_EXAMPLES are copied verbatim from planner/ask.py; change both together.
   tests/test_ask_parity.py holds the two engines to identical output. */
'use strict';
(function (global) {
const E = global.PlannerEngine;
const { D, ISO, YMD, dow, addDays, dateOnly, mk, Cal, calFor, amap, isMs, remHours, schedule, pyRound, pyFixed } = E;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH_NUM = { january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
  jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const MONTH_RE = 'january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept|sep|oct|nov|dec';
const NUM_WORDS = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
const MAX_IDS = 12;
const MAX_NAMED = 6;
const NEAR_DAYS = 10;
const WHY_STEPS = 6;
const QUESTION_CHARS = 500;
const LOE = 'level_of_effort';
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// ---- shared string tables: copied verbatim from planner/ask.py --------------------------------------
const T = {
  error: 'The programme could not be scheduled: {error}',
  empty: 'The programme has no activities yet, so there is nothing to ask about.',
  unknown: 'I did not catch that. Ask about dates ("when does A1240 start"), the finish ("are we on track"), the critical path, float, what an activity holds up, a time window ("what\'s happening next week"), a trade, counts, a what-if ("what if A1240 takes 2 weeks longer"), the health checks or what changed since a revision.',
  no_match: 'No activity matches "{text}". Try its ID or a word from its name.',
  which: 'Which activity do you mean? Name one, for example "{example}".',
  others: ' Other matches: {list}.',
  from_today: ', {wd} from today',
  today: ', today',
  ago: ', {wd} ago',
  start_fc: '{label} is forecast to start on {start}{rel}; it finishes on {finish}.',
  finish_fc: '{label} is forecast to finish on {finish}{rel}; it starts on {start}.',
  started: '{label} started on {start} and is {pct}% complete; it is forecast to finish on {finish}{rel}.',
  complete: '{label} is complete: it started on {start} and finished on {finish}.',
  ms_fc: '{label} is forecast for {date}{rel}.',
  ms_done: '{label} was achieved on {date}.',
  crit_zero: ' It is on the critical path, with no float.',
  crit_float: ' It is on the critical path, with {wd} of float to the required completion date.',
  crit_neg: ' It is on the critical path and {wd} behind the required completion date (negative float).',
  neg_float: ' It has negative float of {wd}: it cannot meet the required completion date as planned.',
  near_float: ' It is near-critical, with {wd} of total float.',
  float: ' It has {wd} of total float.',
  float_full: '{label} has {tf} of total float and {ff} of free float.',
  dur: '{label} is {wd} long on the {cal} calendar.',
  dur_ms: '{label} is a milestone: it has no duration.',
  dur_left: ' It is {pct}% complete with {wd} remaining; it is forecast to finish on {finish}.',
  dur_none: ' None of it has been done yet; it is forecast to run from {start} to {finish}.',
  dur_done: ' It is complete.',
  pf_head: 'The programme is forecast to finish on {finish} ({label}){rel}.',
  pf_ahead: ' The required completion date is {deadline}: the forecast is {wd} ahead of it.',
  pf_behind: ' The required completion date is {deadline}: the forecast is {wd} behind it.',
  pf_meets: ' The forecast meets the required completion date of {deadline} exactly.',
  pf_nodead: ' No required completion date is set.',
  pf_progress: ' At the data date of {dd} the programme is {pct}% complete against {planned}% planned.',
  pf_notstarted: ' Work has not started: the data date is {dd}.',
  crit_head: 'The longest path to {label} ({finish}) runs through {n} activities: {list}.',
  crit_none: 'No activity is critical: every remaining activity has float, so the finish is set by a constraint, the data date or a milestone.',
  crit_neg_n: ' {n} have negative float: {list}.',
  crit_neg_one: ' One has negative float: {list}.',
  crit_margin: ' The path has {wd} of float to the required completion date of {deadline}.',
  crit_nomargin: ' The path has no float.',
  why_driven: '{label} starts on {start}{rel}, driven by {pred} ({link}), which {verb} on {date}.',
  why_chain: ' That in turn follows {list}.',
  why_cons: '{label} starts on {start}{rel}, set by its {constraint} constraint of {date}.',
  why_cons_also: ' It also carries a {constraint} constraint of {date}.',
  why_dd: '{label} starts on {start}{rel}: nothing holds it back, so it begins at the data date of {dd}.',
  why_prog: '{label} started on {start} and is {pct}% complete; its remaining work runs from the data date of {dd}.',
  why_done: '{label} is complete: it ran from {start} to {finish}.',
  why_cal: ' It works to the {cal} calendar.',
  holds: '{label} holds up {n} activities, through to {last} on {date}: {list}.',
  holds_none: '{label} holds nothing up: no activity follows it.',
  holds_slip: ' If it slipped by a week, the programme finish would move {wd} later, to {finish}.',
  holds_noslip: ' If it slipped by a week the finish would not move: its float absorbs the delay.',
  holds_done: ' It is complete, so it can no longer move anything.',
  win_head: '{n} activities run {label}: {list}.',
  win_one: 'One activity runs {label}: {list}.',
  win_none: 'Nothing is scheduled {label}.',
  win_crit: ' {n} of them are on the critical path: {list}.',
  win_crit_one: ' One of them is on the critical path: {list}.',
  win_nocrit: ' None of them is on the critical path.',
  due_head: '{n} activities are due to finish {label}: {list}.',
  due_one: 'One activity is due to finish {label}: {list}.',
  due_none: 'Nothing is due to finish {label}.',
  list_progress: '{acts} in progress: {list}.',
  list_progress_none: 'Nothing is in progress at the data date of {dd}.',
  list_late: '{acts} behind baseline finish: {list}.',
  list_late_none: 'Nothing is behind its baseline finish.',
  list_nobaseline: 'No baseline is set, so lateness is measured as negative float. {acts} with negative float: {list}.',
  list_nobaseline_none: 'No baseline is set and no activity has negative float, so nothing is late against the required completion date.',
  list_notstarted: '{acts} not started, the next to start being {list}.',
  list_notstarted_none: 'Every activity has started.',
  list_open: '{acts} not finished ({p} in progress and {s} not started), the next to finish being {list}.',
  list_open_none: 'Every activity is finished.',
  list_complete: '{acts} complete, the most recent being {list}.',
  list_complete_none: 'Nothing is complete yet.',
  list_ms: '{ms}: {list}.',
  list_ms_none: 'The programme has no milestones.',
  list_near: '{acts} near-critical ({days} working days of float or less): {list}.',
  list_near_none: 'No open activity has {days} working days of float or less beyond the critical path.',
  res_head: '{who} has {n} activities{where}, from {start} to {finish}: {list}.',
  res_one: '{who} has one activity{where}, {list}, from {start} to {finish}.',
  res_none: '{who} has nothing scheduled{where}.',
  res_crit: ' {n} of them are on the critical path.',
  res_crit_one: ' One of them is on the critical path.',
  res_unknown: 'No trade or resource matches "{text}". The programme has {list}.',
  res_nothing: 'The programme has no resources or activity codes to answer that with.',
  onsite: 'On site {label}: {list}.',
  onsite_none: 'Nobody is on site {label}.',
  count_all: 'The programme has {acts} ({tasks} and {ms}): {done} complete, {prog} in progress and {todo} not started.',
  count_complete: '{done} of {n} activities are complete: {pct}% of the work by duration.',
  count_length: 'The programme runs {weeks} weeks, from {start} to {finish} ({wd} on the default calendar).',
  count_pct: 'The programme is {pct}% complete by duration, against {planned}% planned at the data date of {dd}.',
  count_critical: '{n} of {total} open activities are on the critical path.',
  count_links: 'The programme has {n} activities and {links} relationships.',
  wi_dur: 'If {label} took {wd} longer, the programme would finish on {finish}, {shift} later than the current forecast of {now}.',
  wi_start: 'If {label} started {wd} later, the programme would finish on {finish}, {shift} later than the current forecast of {now}.',
  wi_same_dur: 'If {label} took {wd} longer, the programme finish would stay at {now}: its float absorbs the delay.',
  wi_same_start: 'If {label} started {wd} later, the programme finish would stay at {now}: its float absorbs the delay.',
  wi_done: '{label} is complete, so a change to it cannot move the programme.',
  wi_miss: ' That would miss the required completion date of {deadline} by {wd}.',
  wi_meet: ' That would still meet the required completion date of {deadline}, with {wd} to spare.',
  wi_exact: ' That would land exactly on the required completion date of {deadline}.',
  wi_assumed: ' (No duration was given, so a week was assumed.)',
  try_mode: ' Use Try mode to make the change and see it on the chart.',
  health_ok: 'The programme passes all {n} applicable schedule checks, scoring {score}/100.',
  health_fail: 'The programme scores {score}/100: {k} of {n} checks fail. {list}',
  health_more: ' And {n} more.',
  oos: ' {acts} progressed out of sequence: {list}.',
  oos_none: ' Nothing has progressed out of sequence.',
  cmp_none: 'No earlier version is stored to compare with. Issue a revision or close a progress period first.',
  cmp_rev: 'Against {name}: {text}',
  cmp_rev_missing: 'No revision called "{text}". Issued revisions: {list}.',
  cmp_base: 'Against the baseline, the finish is {finish} versus {base}: {shift}. {acts} behind baseline finish, the biggest slips being {list}.',
  cmp_base_ok: 'Against the baseline, the finish is {finish} versus {base}: {shift}. No activity is behind its baseline finish.',
  cmp_base_none: 'No baseline is set, so there is nothing to compare against. Set a baseline first.',
  cmp_period: 'Since {name} (data date {dd}) the forecast finish has moved from {then} to {now} ({shift}) and progress has gone from {p1}% to {p2}%.',
  cmp_period_nofinish: 'Since {name} (data date {dd}) progress has gone from {p1}% to {p2}%; the forecast finish is now {now}.',
  cmp_period_none: 'No progress period has been closed yet, so there is no earlier update to compare with.',
  shift_later: '{wd} later',
  shift_earlier: '{wd} earlier',
  shift_same: 'unchanged',
  drag_head: 'Shortening these critical activities would bring the finish forward most: {list}.',
  drag_tail: ' Drag is the time an activity adds to the finish; beyond it a parallel path takes over.',
  drag_none: 'No unfinished critical task carries drag: the finish is set by milestones, constraints or the data date.',
  drag_item: '{label} ({wd} of drag)',
  risk: 'Risk analysis is not stored with the programme. Run it to see the P50 and P80 finish dates and the chance of meeting the required completion date.',
  risk_fc: ' The deterministic forecast is {finish}{margin}.',
  risk_margin_ahead: ', {wd} ahead of the required completion date',
  risk_margin_behind: ', {wd} behind the required completion date',
  link_lag: '{type}{lag}d',
  finishes: 'finishes',
  starts: 'starts',
  wd_one: 'working day',
  wd_many: 'working days',
  act_one: 'activity',
  act_many: 'activities',
  task_one: 'task',
  task_many: 'tasks',
  ms_one: 'milestone',
  ms_many: 'milestones',
  more: ' and {n} more',
};

// question words, verbs and intent words that never identify an activity by name
const STOP = new Set(`a an the is are was were be been being do does did will would can could should shall may might have has had
i we you it its they them this that these those there here what whats which who whom whose when whens where why how
s t d ll re ve m hasn haven isn aren don doesn didn won wouldn couldn shouldn cannot
of on in at to for by with from into onto about as and or not no but if than then so up out over under before after
until till between during next last coming me my our us get got going go
start starts started starting finish finishes finished finishing end ends ended ending due date dates
day days week weeks fortnight month months year years today tomorrow yesterday now time long much many far soon
late later early earlier ahead behind hold holds holding held depend depends dependent waiting wait waits
driving driven drive drives driver drivers float slack remaining left duration status happening happen happens
running scheduled schedule programme program project job activity activities task tasks milestone milestones
work works complete completed completion done progress critical path impact delay delayed delays slip slips slipped
take takes took taking longer shorter more less extra plus minus all any some every each please tell show list give
find know need want like think just also still yet only even very really actually right ok okay hi hello thanks thank
versus vs since changed change changes compare compared baseline rev revision period doing trade trades gang gangs
resource resources crew able likely risk chance wrong health check checks logic sound open accelerate save
because hit meet track deadline forecast expected planned plan currently current one two three four five six seven
eight nine ten january february march april may june july august september october november december jan feb mar
apr jun jul aug sep sept oct nov dec`.split(/\s+/));

const SUGGEST = {
  unknown: ['When do we finish?', "What's critical?", "What's happening next week?"],
  when_start: ['Why does {id} start then?', 'What does {id} hold up?', 'How much float does {id} have?'],
  when_finish: ['Why does {id} start then?', 'What does {id} hold up?', 'How much float does {id} have?'],
  milestone: ['What is driving {id}?', "What's critical?", 'What if {id} slips 2 weeks?'],
  project_finish: ['What is driving the finish?', 'What should we accelerate?', "What's behind baseline?"],
  critical: ['What should we accelerate?', 'Why does {id} start then?', 'What if {id} takes a week longer?'],
  why: ['What does {id} hold up?', 'How much float does {id} have?', 'What if {id} starts a week later?'],
  holds_up: ['Why does {id} start then?', 'What if {id} takes 2 weeks longer?', "What's critical?"],
  float: ['Why does {id} start then?', 'What does {id} hold up?', "What's near-critical?"],
  duration: ['When does {id} finish?', 'What if {id} takes a week longer?', 'How much float does {id} have?'],
  window: ["What's critical?", 'Who is on site next week?', "What's in progress?"],
  list: ["What's critical?", "What's happening next week?", 'When do we finish?'],
  resources: ["What's happening next week?", "What's critical?", 'How many activities are there?'],
  counts: ['When do we finish?', "What's in progress?", "What's wrong with the programme?"],
  what_if: ['What is driving the finish?', 'What does {id} hold up?', 'What should we accelerate?'],
  health: ["What's critical?", 'What should we accelerate?', 'When do we finish?'],
  compare: ['What is driving the finish?', "What's behind baseline?", "What's critical?"],
  drag: ['What is driving the finish?', 'What does {id} hold up?', 'What if {id} takes a week longer?'],
  risk: ['When do we finish?', "What's critical?", 'What should we accelerate?'],
};

const ASK_EXAMPLES = ['When do we finish?', 'Are we on track?', "What's critical?", "What's happening next week?",
  'When does brickwork start?', 'Why does A1240 start then?', 'What does A1240 hold up?',
  'How much float does A1240 have?', 'What if A1240 takes 2 weeks longer?', 'What are the bricklayers doing?',
  "What's wrong with the programme?", 'What should we accelerate?'];

// ---- formatting helpers ----------------------------------------------------------------------------
const r1 = x => pyRound(x, 1) + 0;
const fd = dt => `${dt.getUTCDate()} ${MONTHS[dt.getUTCMonth()]} ${dt.getUTCFullYear()}`;
const num = x => (Number.isInteger(x) ? String(x) : pyFixed(x, 1));
const sgn = x => (x > 0 ? '+' : '') + num(x);
const countN = (x, one, many) => `${num(x)} ${x === 1 ? one : many}`;
const wd = x => countN(Math.abs(x), T.wd_one, T.wd_many);
const actsN = n => countN(n, T.act_one, T.act_many);
const and = items => (items.length <= 1 ? items.join('') : items.slice(0, -1).join(', ') + ' and ' + items[items.length - 1]);
function top(items, limit = MAX_NAMED) { if (items.length <= limit) return and(items); return items.slice(0, limit).join(', ') + t_('more', { n: items.length - limit }); }
function t_(key, kw = {}) { let s = T[key]; for (const k of Object.keys(kw)) s = s.split('{' + k + '}').join(String(kw[k])); return s; }
const label = a => `${a.id} ${a.name}`;
const wdays = (cal, a, b) => r1(cal.hours_to_days(cal.hours_between(a, b)));
function rel(cal, today, dt) { const n = wdays(cal, today, dt); if (n > 0) return t_('from_today', { wd: wd(n) }); if (n < 0) return t_('ago', { wd: wd(n) }); return T.today; }
function shiftText(x) { if (x > 0) return t_('shift_later', { wd: wd(x) }); if (x < 0) return t_('shift_earlier', { wd: wd(x) }); return T.shift_same; }
function link(r, pcal) { const lag = r1(pcal.hours_to_days(r.lag_hours || 0)); const ty = r.type || 'FS'; return lag ? t_('link_lag', { type: ty, lag: sgn(lag) }) : ty; }
const consText = a => (a.constraint || 'none').split('_').join(' ');
const day0 = dt => dateOnly(dt);
const dayEnd = dt => mk(dt.getUTCFullYear(), dt.getUTCMonth(), dt.getUTCDate(), 23, 59, 59);
function daysInMonth(y, m) { if (m === 2) return (y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0)) ? 29 : 28; return [4, 6, 9, 11].includes(m) ? 30 : 31; }
const mkdate = (y, m, d) => mk(y, m - 1, Math.max(1, Math.min(d, daysInMonth(y, m))));

// ---- schedule helpers ------------------------------------------------------------------------------
const st = a => a.status || 'not_started';
const typ = a => a.type || 'task';
const startOf = a => D(a.actual_start || a.early_start);
const finishOf = a => D(a.actual_finish || a.early_finish);
const startIso = a => { const d = startOf(a); return d ? ISO(d) : ''; };
const finishIso = a => { const d = finishOf(a); return d ? ISO(d) : ''; };
const isLoe = a => typ(a) === LOE;
function scheduled(p) { const q = JSON.parse(JSON.stringify(p)); schedule(q); return q; }
function defaultCal(p) { const c = (p.calendars || {})[p.default_calendar_id]; return new Cal(c || { id: p.default_calendar_id }); }
const isOpen = a => st(a) !== 'complete';
const tfDays = (p, a) => r1(calFor(p, a).hours_to_days(a.total_float_hours || 0));
const byStart = (p, acts) => acts.slice().sort((a, b) => cmp(startIso(a), startIso(b)) || cmp(a.id, b.id));

function progressOf(p, dd) {
  let tot = 0, done = 0, plan = 0;
  for (const a of p.activities) {
    if (typ(a) !== 'task' || !(a.duration_hours > 0)) continue;
    const cal = calFor(p, a), dur = a.duration_hours;
    const pc = st(a) === 'complete' ? 100 : st(a) === 'in_progress' ? (a.percent_complete || 0) : 0;
    tot += dur;
    done += dur * pc / 100;
    const s = D(a.baseline_start) || startOf(a), f = D(a.baseline_finish) || finishOf(a);
    let frac;
    if (s && f && f > s) { const span = cal.hours_between(s, f); frac = span > 0 ? Math.min(1, Math.max(0, cal.hours_between(s, dd) / span)) : (f <= dd ? 1 : 0); }
    else frac = (f && f <= dd) ? 1 : 0;
    plan += dur * frac;
  }
  if (tot <= 0) return [0, 0];
  return [r1(100 * done / tot), r1(100 * plan / tot)];
}

function floatSentence(p, a, warnOnly = false) {
  if (st(a) === 'complete') return '';
  const tf = tfDays(p, a);
  if (a.critical) {
    if (tf > 0 && p.must_finish_by) return t_('crit_float', { wd: wd(tf) });
    if (tf < 0) return t_('crit_neg', { wd: wd(tf) });
    return T.crit_zero;
  }
  if (tf < 0) return t_('neg_float', { wd: wd(tf) });
  if (tf <= NEAR_DAYS) return t_('near_float', { wd: wd(tf) });
  return warnOnly ? '' : t_('float', { wd: wd(tf) });
}

function lengthen(x, hours) {
  if (st(x) === 'in_progress') x.remaining_hours = remHours(x) + hours;
  else { x.duration_hours = (x.duration_hours || 0) + hours; if (x.remaining_hours != null) x.remaining_hours += hours; }
}
function slipWeek(p, a) {
  const q = JSON.parse(JSON.stringify(p)), x = q.activities.find(z => z.id === a.id), cal = calFor(q, x);
  lengthen(x, cal.days_to_hours(5));
  schedule(q);
  return [q, wdays(defaultCal(p), D(p.finish), D(q.finish))];
}

// walk back from the activity that sets the finish through driving links (copy of planner.compare._walk_driving)
function walkDriving(p) {
  const m = amap(p);
  const open = p.activities.filter(a => st(a) !== 'complete' && typ(a) !== LOE && a.early_finish);
  if (!open.length) return [null, new Set()];
  let end = null; for (const a of open) { const f = D(a.early_finish).getTime(); if (end === null || f > end) end = f; }
  const ends = open.filter(a => D(a.early_finish).getTime() === end);
  const tied = new Set(ends.map(a => a.id));
  const feeding = new Set(p.relationships.filter(r => tied.has(r.successor_id) && tied.has(r.predecessor_id)).map(r => r.predecessor_id));
  const finishAct = ends.find(a => !feeding.has(a.id)) || ends[0];
  const preds = {};
  for (const r of p.relationships) (preds[r.successor_id] = preds[r.successor_id] || []).push(r);
  const seen = new Set(), stack = ends.map(a => a.id);
  while (stack.length) {
    const aid = stack.pop();
    if (seen.has(aid)) continue;
    seen.add(aid);
    for (const r of preds[aid] || []) { const q = m[r.predecessor_id]; if (r.driving && q && typ(q) !== LOE) stack.push(q.id); }
  }
  return [finishAct, seen];
}

// ---- question parsing -------------------------------------------------------------------------------
function norm(question) {
  let s = question == null ? '' : String(question);
  s = Array.from(s).slice(0, QUESTION_CHARS).join('').replace(/[^\x20-\x7e]+/g, ' ');
  return s.replace(/\s+/g, ' ').trim();
}
const tokens = s => s.match(/[a-z0-9]+/g) || [];
const isDigits = x => /^\d+$/.test(x);

function lev1(a, b) {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0, j = 0, edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    edits++;
    if (edits > 1) return false;
    if (a.length > b.length) i++; else if (b.length > a.length) j++; else { i++; j++; }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}
function stem(w) {   // strip a common English suffix so "decorating" and "decoration" meet at "decorat"
  for (const suf of ['ing', 'ions', 'ion', 'ies', 'es', 'ed', 'er', 's']) if (w.endsWith(suf) && w.length - suf.length >= 4) return w.slice(0, -suf.length);
  return w;
}
const prefix = (a, b) => a.length >= 4 && b.length >= 4 && (b.startsWith(a) || a.startsWith(b));
function tokMatch(q, n) {
  if (q === n) return true;
  const qs = stem(q), ns = stem(n);
  if (qs === ns || prefix(q, n) || prefix(qs, ns)) return true;
  return q.length >= 5 && n.length >= 5 && lev1(q, n);
}
function nameTokens(name) { const toks = tokens(String(name).toLowerCase()); const kept = toks.filter(x => !STOP.has(x)); return kept.length ? kept : toks; }
function score(qtoks, ntoks) { let k = 0; for (const q of qtoks) { for (const n of ntoks) { if (tokMatch(q, n)) { k++; break; } } } return k; }

function findActs(p, toks, raw) {
  const ids = {}; for (const a of p.activities) ids[a.id.toLowerCase()] = a;
  const byId = [];
  toks.forEach((tk, i) => { const a = ids[tk]; if (a && (!STOP.has(tk) || raw[i] === a.id) && byId.every(x => x.id !== a.id)) byId.push(a); });
  if (byId.length) return [byId, true];
  // a number in the question only counts when some activity name carries it ("lift 2", "level 1"), so dates stay out
  const nameDigits = new Set(); for (const a of p.activities) for (const x of tokens(String(a.name).toLowerCase())) if (isDigits(x)) nameDigits.add(x);
  const q = toks.filter(x => !STOP.has(x) && (!isDigits(x) || nameDigits.has(x)));
  if (!q.length) return [[], false];
  const scored = [];
  p.activities.forEach((a, i) => { const nt = nameTokens(a.name); const k = score(q, nt); if (k) scored.push([-k, -(k / nt.length), i, a]); });
  scored.sort((x, y) => (x[0] - y[0]) || (x[1] - y[1]) || (x[2] - y[2]));
  if (!scored.length) return [[], false];
  const best = -scored[0][0];
  if (best < 2 && best < q.length && -scored[0][1] < 0.5) return [[], false];
  return [scored.filter(x => -x[0] === best).map(x => x[3]), false];
}

function codeTypes(p) { const out = Object.keys(p.code_types || {}); for (const a of p.activities) for (const k of Object.keys(a.codes || {})) if (!out.includes(k)) out.push(k); return out; }
function codeValues(p, ct) { const out = Object.keys((p.code_types || {})[ct] || {}); for (const a of p.activities) { const v = (a.codes || {})[ct]; if (v != null && !out.includes(v)) out.push(v); } return out; }

// ---- dates and windows in the question -----------------------------------------------------------------
function yearFor(today, m, d) { const y = today.getUTCFullYear(); let dt = mkdate(y, m, d); if (dt < addDays(day0(today), -183)) dt = mkdate(y + 1, m, d); return dt; }
function finditer(re, t) { const out = []; const g = new RegExp(re.source, 'g'); let m; while ((m = g.exec(t))) { out.push(m); if (!m[0].length) g.lastIndex++; } return out; }
function datesIn(t, today) {
  const found = [];
  for (const m of finditer(new RegExp('(\\d{1,2})(?:st|nd|rd|th)? (' + MONTH_RE + ')(?: (\\d{4}))?(?!\\d)'), t)) {
    const mo = MONTH_NUM[m[2]]; const dt = m[3] ? mkdate(+m[3], mo, +m[1]) : yearFor(today, mo, +m[1]); found.push([m.index, m.index + m[0].length, dt]);
  }
  for (const m of finditer(new RegExp('(' + MONTH_RE + ') (\\d{1,2})(?:st|nd|rd|th)?(?:,? (\\d{4}))?(?!\\d)'), t)) {
    const mo = MONTH_NUM[m[1]]; const dt = m[3] ? mkdate(+m[3], mo, +m[2]) : yearFor(today, mo, +m[2]); found.push([m.index, m.index + m[0].length, dt]);
  }
  for (const m of finditer(/(\d{4})-(\d{2})-(\d{2})/, t)) found.push([m.index, m.index + m[0].length, mkdate(+m[1], Math.max(1, Math.min(12, +m[2])), +m[3])]);
  for (const m of finditer(/(\d{1,2})\/(\d{1,2})\/(\d{4})/, t)) found.push([m.index, m.index + m[0].length, mkdate(+m[3], Math.max(1, Math.min(12, +m[2])), +m[1])]);
  found.sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]));
  const out = []; let lastEnd = -1;
  for (const [s, e, dt] of found) { if (s < lastEnd) continue; out.push(dt); lastEnd = e; }
  return out;
}

function span(a, b) { const lab = YMD(a) === YMD(b) ? 'on ' + fd(a) : fd(a) + ' to ' + fd(b); return [a, dayEnd(b), lab]; }

function windowOf(t, today) {
  const d0 = day0(today), mon = addDays(d0, -dow(d0));
  const monthSpan = (y, mo) => span(mkdate(y, mo, 1), mkdate(y, mo, daysInMonth(y, mo)));
  let m = t.match(new RegExp('between (\\d{1,2})(?:st|nd|rd|th)? and (\\d{1,2})(?:st|nd|rd|th)? (' + MONTH_RE + ')(?: (\\d{4}))?(?!\\d)'));
  if (m) {
    const mo = MONTH_NUM[m[3]];
    if (m[4]) return span(mkdate(+m[4], mo, +m[1]), mkdate(+m[4], mo, +m[2]));
    return span(yearFor(today, mo, +m[1]), yearFor(today, mo, +m[2]));
  }
  const dates = datesIn(t, today);
  if (dates.length >= 2 && /\b(between|from) .+ (and|to|until|till) /.test(t)) { const a = dates[0], b = dates[1]; return b >= a ? span(a, b) : span(b, a); }
  if (/\btoday\b/.test(t)) return span(d0, d0);
  if (/\btomorrow\b/.test(t)) return span(addDays(d0, 1), addDays(d0, 1));
  if (/\b(this|the current) week\b/.test(t)) return span(mon, addDays(mon, 6));
  if (/\bnext week\b/.test(t)) return span(addDays(mon, 7), addDays(mon, 13));
  if (/\b(this|the current) month\b/.test(t)) return monthSpan(d0.getUTCFullYear(), d0.getUTCMonth() + 1);
  if (/\bnext month\b/.test(t)) { const y = d0.getUTCMonth() === 11 ? d0.getUTCFullYear() + 1 : d0.getUTCFullYear(), mo = d0.getUTCMonth() === 11 ? 1 : d0.getUTCMonth() + 2; return monthSpan(y, mo); }
  m = t.match(/\bnext (\d+|two|three|four|five|six|seven|eight|nine|ten|few|couple of|a|the) ?(day|days|week|weeks|fortnight|month|months)\b/);
  if (m) {
    const w = m[1];
    const n = w === 'few' ? 3 : w === 'couple of' ? 2 : isDigits(w) ? +w : (NUM_WORDS[w] || 1);
    const u = m[2];
    const days = u.startsWith('week') ? n * 7 : u === 'fortnight' ? n * 14 : u.startsWith('month') ? n * 30 : n;
    return span(d0, addDays(d0, Math.max(1, days) - 1));
  }
  if (/\b(week commencing|w\/c|week of|week beginning) /.test(t) && dates.length) { const a = addDays(dates[0], -dow(dates[0])); return span(a, addDays(a, 6)); }
  m = t.match(new RegExp('\\b(in|during|for|throughout|over) (' + MONTH_RE + ')(?: (\\d{4}))?(?!\\d)'));
  if (m && !new RegExp('\\d{1,2} (' + MONTH_RE + ')').test(t)) {
    const mo = MONTH_NUM[m[2]];
    if (m[3]) return monthSpan(+m[3], mo);
    return monthSpan(yearFor(today, mo, 1).getUTCFullYear(), mo);
  }
  if (dates.length && /\b(on|around|at|for) /.test(t)) return span(dates[0], dates[0]);
  if (/\blookahead\b/.test(t)) return span(d0, addDays(d0, 20));
  return null;
}

function inWindow(a, ws, we) { const s = startOf(a), f = finishOf(a); return !isLoe(a) && s != null && f != null && s <= we && f >= ws; }

function amount(t) {
  const m = t.match(/\b(\d+(?:\.\d+)?|a|an|one|two|three|four|five|six|seven|eight|nine|ten) ?-?(day|days|d|week|weeks|wk|wks|w|month|months|fortnight)\b/);
  if (!m) return null;
  const w = m[1];
  const n = /^\d/.test(w) ? parseFloat(w) : (NUM_WORDS[w] || 1);
  const u = m[2];
  if (u === 'fortnight') return n * 10;
  if (u.startsWith('w')) return n * 5;
  if (u.startsWith('m')) return n * 21;
  return n;
}

// ---- result --------------------------------------------------------------------------------------------
function res(kind, answer, ids, filt, trace, goto, confidence, exampleId = null) {
  const uniq = []; for (const i of ids) if (!uniq.includes(i)) uniq.push(i);
  const sid = exampleId || goto || (uniq.length ? uniq[0] : '');
  const sugg = (SUGGEST[kind] || SUGGEST.unknown).filter(s => sid || !s.includes('{id}')).map(s => s.split('{id}').join(sid)).slice(0, 3);
  while (sugg.length < 3) sugg.push(SUGGEST.unknown.filter(s => !sugg.includes(s))[0]);
  return { kind, answer, ids: uniq.slice(0, MAX_IDS), filter: filt, trace, goto, confidence, suggestions: sugg };
}

// ---- the engine ----------------------------------------------------------------------------------------
function ask(project, question, opts = {}) {
  try { return ask0(project, question, opts && opts.today); }
  catch (e) { return res('unknown', t_('error', { error: String((e && e.message) || e) }), [], '', null, null, 'low'); }
}

function parseToday(today) {
  if (!today) return null;
  const m = String(today).match(/^\s*(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (!m) return null;
  const y = +m[1], mo = +m[2], d = +m[3], h = +(m[4] || 0), mi = +(m[5] || 0), s = +(m[6] || 0);
  if (mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo) || h > 23 || mi > 59 || s > 59) return null;
  return mk(y, mo - 1, d, h, mi, s);
}

function ask0(project, question, todayS) {
  const rawT = norm(question);
  const t = rawT.toLowerCase();
  const toks = tokens(t);
  const raw = rawT.match(/[A-Za-z0-9]+/g) || [];
  if (!toks.length) return res('unknown', T.unknown, [], '', null, null, 'low');
  if (!project.activities || !project.activities.length) return res('unknown', T.empty, [], '', null, null, 'low');
  const q = scheduled(project);
  const dd = D(q.data_date) || D(q.start);
  const today = parseToday(todayS) || dd;
  const dcal = defaultCal(q);
  const [acts, exact] = findActs(q, toks, raw);
  const act = acts.length ? acts[0] : null;
  const others = acts.slice(1);
  const conf = (act !== null && (exact || acts.length === 1)) ? 'high' : 'medium';
  const othersText = others.length ? t_('others', { list: top(others.map(label), 3) }) : '';
  const ex = q.activities[Math.min(3, q.activities.length - 1)].id;
  let win = windowOf(t, today);
  if (win === null && /\bon site\b/.test(t)) win = span(day0(today), day0(today));
  const fuzzyWin = win !== null && (act === null || (!exact && /\b(what|which|who|anything|everything|all)\b/.test(t)));

  // ---- intents with their own keywords, project-wide first ----
  if (/\b(what if|if .* (takes?|took|slips?|slipped|starts? .* later|is delayed|were delayed|was delayed|delayed|overruns?|ran over|runs over)|impact of|delay(ed)? (to|on)|slip(s|ped)? by|late by|takes? .* longer|took .* longer|longer than)/.test(t)
      && !/\b(hold|holds|depend|depends)\b/.test(t)) return whatIf(q, t, act, othersText, dd, dcal, ex);
  if (/\b(changed|change|changes|since|compared?|comparison|versus|vs|difference|different|moved since)\b/.test(t)) return compareQ(q, t, dd, dcal);
  if (/\b(wrong|health|checks?|dcma|quality|issues?|problems?|dangl\w*|open ends?|logic|sound|hard constraints?|negative float|leads|lags|out of sequence)\b/.test(t)) return health(q);
  if (/\b(accelerate|save time|speed up|crash|compress|recover|bring .* forward|faster|quicker|drag|shorten|pull .* back|make up time)\b/.test(t)) return drag(q, dcal);
  if (/\b(how likely|likely|likelihood|probab\w*|chance|confiden\w*|risk|risky|p80|p50|p90|monte carlo)\b/.test(t)) return risk(q, dcal);
  if (/\b(holds? up|holding up|held up|depends? on|dependent on|downstream|successors?|follows? (on )?from|follows? it|affected by|rel(y|ies) on|what does .* affect|knock.?on|pushes?)\b/.test(t)) {
    if (act === null) return res('holds_up', t_('which', { example: ex }), [], '', null, null, 'low', ex);
    return holdsUp(q, act, othersText, conf, dcal);
  }
  if (/\b(why|waiting (for|on)|driven by|what is driving \w+\d|drives|reason)\b/.test(t) && act !== null
      && !/\bwhy (is|does|will|do) (the )?(finish|completion|project|programme|end|handover)\b/.test(t)) return why(q, act, othersText, conf, today, dd);
  if (/\b(critical|longest path|driving|drivers?|driven|why|near.?critical|least float|lowest float|zero float)\b/.test(t) && act === null) {
    if (/\b(near.?critical|near critical)\b/.test(t)) return list(q, 'near', dd, dcal);
    return critical(q, dcal);
  }
  if (/\b(float|slack|spare time|leeway|margin)\b/.test(t)) {
    if (act === null) return critical(q, dcal);
    return floatQ(q, act, othersText, conf);
  }
  if (/\b(how long|duration|days left|weeks left|remaining|left on|to go on|how many days)\b/.test(t) && act !== null) return duration(q, act, othersText, conf);
  if (/\b(how many|how long|count|number of|percent|percentage|per cent|how far|how complete|overall progress|statistics|stats|summary|size)\b/.test(t) && act === null) return counts(q, t, dd, dcal);
  const m = t.match(/\b([a-z][a-z0-9 _-]*?) ?[=:] ?([a-z0-9][a-z0-9 _&\/-]*)/);
  if (m || /\b(who|whose|doing|trade|trades|gang|gangs|resource|resources|crew|crews|subcontractors?|labour|working on|on site)\b/.test(t)) {
    const r = resources(q, t, m, win, toks, dd);
    if (r !== null) return r;
  }
  if (fuzzyWin) return windowAnswer(q, t, win, dd);
  if (act === null && /\b(are we|will we|do we|can we|shall we)\b/.test(t) && !/\bbaseline\b/.test(t)) return projectFinish(q, dd, dcal, today);
  if (act === null) { const lst = listIntent(t); if (lst) return list(q, lst, dd, dcal); }
  if (/\b(when|what date|which date|dates?|how soon|due|start|starts|starting|finish|finishes|finishing|complete|completion|end|ends)\b/.test(t)) {
    if (act !== null) {
      if (isMs(act)) return milestone(q, act, othersText, conf, today);
      const which = /\b(finish|finishes|finished|finishing|complete|completed|completion|end|ends|done|due)\b/.test(t) ? 'finish' : 'start';
      return when(q, act, which, othersText, conf, today);
    }
    return projectFinish(q, dd, dcal, today);
  }
  if (/\b(on track|deadline|on time|overrun|late|handover|hit|make it|finish|forecast|outlook|position)\b/.test(t) && act === null) return projectFinish(q, dd, dcal, today);
  if (act !== null) {
    if (isMs(act)) return milestone(q, act, othersText, conf, today);
    return when(q, act, 'start', othersText, conf, today);
  }
  return res('unknown', T.unknown, [], '', null, null, 'low');
}

// ---- intent answers ---------------------------------------------------------------------------------------
function when(q, a, which, others, conf, today) {
  const cal = calFor(q, a), s = startOf(a), f = finishOf(a);
  let head;
  if (st(a) === 'complete') head = t_('complete', { label: label(a), start: fd(s), finish: fd(f) });
  else if (st(a) === 'in_progress' && a.actual_start) head = t_('started', { label: label(a), start: fd(s), pct: num(r1(a.percent_complete || 0)), finish: fd(f), rel: rel(cal, today, f) });
  else if (which === 'finish') head = t_('finish_fc', { label: label(a), finish: fd(f), rel: rel(cal, today, f), start: fd(s) });
  else head = t_('start_fc', { label: label(a), start: fd(s), rel: rel(cal, today, s), finish: fd(f) });
  const kind = which === 'finish' ? 'when_finish' : 'when_start';
  return res(kind, head + floatSentence(q, a) + others, [a.id], '', null, a.id, conf);
}

function milestone(q, a, others, conf, today) {
  const cal = calFor(q, a), f = finishOf(a);
  const head = st(a) === 'complete' ? t_('ms_done', { label: label(a), date: fd(f) }) : t_('ms_fc', { label: label(a), date: fd(f), rel: rel(cal, today, f) });
  return res('milestone', head + floatSentence(q, a) + others, [a.id], '', null, a.id, conf);
}

function floatQ(q, a, others, conf) {
  const cal = calFor(q, a), tf = tfDays(q, a), ff = r1(cal.hours_to_days(a.free_float_hours || 0));
  const head = t_('float_full', { label: label(a), tf: wd(tf), ff: wd(ff) });
  return res('float', head + floatSentence(q, a, true) + others, [a.id], '', null, a.id, conf);
}

function duration(q, a, others, conf) {
  const cal = calFor(q, a);
  let head;
  if (isMs(a)) head = t_('dur_ms', { label: label(a) });
  else {
    head = t_('dur', { label: label(a), wd: wd(r1(cal.hours_to_days(a.duration_hours || 0))), cal: cal.name });
    if (st(a) === 'complete') head += T.dur_done;
    else if (st(a) === 'in_progress') head += t_('dur_left', { pct: num(r1(a.percent_complete || 0)), wd: wd(r1(cal.hours_to_days(remHours(a)))), finish: fd(finishOf(a)) });
    else head += t_('dur_none', { start: fd(startOf(a)), finish: fd(finishOf(a)) });
  }
  return res('duration', head + others, [a.id], '', null, a.id, conf);
}

function projectFinish(q, dd, dcal, today) {
  const [fin] = walkDriving(q);
  const f = D(q.finish);
  const lab = fin !== null ? label(fin) : 'no open activity';
  let text = t_('pf_head', { finish: fd(f), label: lab, rel: rel(dcal, today, f) });
  if (q.must_finish_by) {
    const m = wdays(dcal, f, D(q.must_finish_by));
    if (m > 0) text += t_('pf_ahead', { deadline: fd(D(q.must_finish_by)), wd: wd(m) });
    else if (m < 0) text += t_('pf_behind', { deadline: fd(D(q.must_finish_by)), wd: wd(m) });
    else text += t_('pf_meets', { deadline: fd(D(q.must_finish_by)) });
  } else text += T.pf_nodead;
  const [pct, planned] = progressOf(q, dd);
  if (q.activities.some(a => st(a) !== 'not_started')) text += t_('pf_progress', { dd: fd(dd), pct: num(pct), planned: num(planned) });
  else text += t_('pf_notstarted', { dd: fd(dd) });
  const ids = fin !== null ? [fin.id] : [];
  return res('project_finish', text, ids, '', null, fin !== null ? fin.id : null, 'high');
}

function critical(q, dcal) {
  const [fin, onPath] = walkDriving(q);
  const chain = byStart(q, q.activities.filter(a => onPath.has(a.id) && isOpen(a)));
  if (fin === null || !chain.length) return res('critical', T.crit_none, [], 'critical=yes', null, null, 'high');
  let text = t_('crit_head', { label: label(fin), finish: fd(D(q.finish)), n: chain.length, list: top(chain.map(label)) });
  const neg = q.activities.filter(a => isOpen(a) && !isLoe(a) && tfDays(q, a) < 0);
  if (neg.length) text += t_(neg.length === 1 ? 'crit_neg_one' : 'crit_neg_n', { n: neg.length, list: top(byStart(q, neg).map(label), 3) });
  else if (q.must_finish_by && tfDays(q, fin) > 0) text += t_('crit_margin', { wd: wd(tfDays(q, fin)), deadline: fd(D(q.must_finish_by)) });
  else text += T.crit_nomargin;
  const ids = chain.map(a => a.id).slice(-MAX_IDS);
  return res('critical', text, ids, 'critical=yes', { ids: [fin.id], dir: 'back' }, null, 'high', ids[0]);
}

function why(q, a, others, conf, today, dd) {
  const m = amap(q), cal = calFor(q, a);
  const chain = [a.id], steps = [];
  let cur = a;
  for (let i = 0; i < WHY_STEPS; i++) {
    const drv = q.relationships.filter(r => r.successor_id === cur.id && r.driving);
    if (!drv.length) break;
    const r = drv[0], p = m[r.predecessor_id];
    steps.push([r, p]); chain.push(p.id); cur = p;
  }
  const s = startOf(a);
  let text;
  if (st(a) === 'complete') text = t_('why_done', { label: label(a), start: fd(s), finish: fd(finishOf(a)) });
  else if (st(a) === 'in_progress' && a.actual_start) text = t_('why_prog', { label: label(a), start: fd(s), pct: num(r1(a.percent_complete || 0)), dd: fd(dd) });
  else if (steps.length) {
    const [r, p] = steps[0];
    const onStart = ['SS', 'SF'].includes(r.type || 'FS');
    text = t_('why_driven', { label: label(a), start: fd(s), rel: rel(cal, today, s), pred: label(p), link: link(r, calFor(q, p)),
      verb: onStart ? T.starts : T.finishes, date: fd(onStart ? startOf(p) : finishOf(p)) });
    if (steps.length > 1) text += t_('why_chain', { list: and(steps.slice(1).map(([r2, p2]) => `${label(p2)} (${link(r2, calFor(q, p2))})`)) });
    if ((a.constraint || 'none') !== 'none' && a.constraint_date) text += t_('why_cons_also', { constraint: consText(a), date: fd(D(a.constraint_date)) });
  } else if ((a.constraint || 'none') !== 'none' && a.constraint_date) {
    text = t_('why_cons', { label: label(a), start: fd(s), rel: rel(cal, today, s), constraint: consText(a), date: fd(D(a.constraint_date)) });
  } else text = t_('why_dd', { label: label(a), start: fd(s), rel: rel(cal, today, s), dd: fd(dd) });
  text += t_('why_cal', { cal: cal.name }) + floatSentence(q, a) + others;
  return res('why', text, chain, '', { ids: [a.id], dir: 'back' }, a.id, conf);
}

function holdsUp(q, a, others, conf, dcal) {
  const m = amap(q), seen = new Set(), stack = [a.id];
  while (stack.length) {
    const cur = stack.pop();
    for (const r of q.relationships) {
      if (r.predecessor_id === cur && !seen.has(r.successor_id) && r.successor_id !== a.id && m[r.successor_id]) { seen.add(r.successor_id); stack.push(r.successor_id); }
    }
  }
  const fwd = byStart(q, q.activities.filter(x => seen.has(x.id)));
  let text;
  if (!fwd.length) text = t_('holds_none', { label: label(a) });
  else {
    let last = fwd[0];
    for (const x of fwd) {
      const xf = finishOf(x), lf = finishOf(last);
      if (xf != null && (lf == null || xf > lf || (xf.getTime() === lf.getTime() && x.id < last.id))) last = x;
    }
    text = t_('holds', { label: label(a), n: fwd.length, last: label(last), date: fd(finishOf(last)), list: top(fwd.map(label)) });
  }
  if (st(a) === 'complete') text += T.holds_done;
  else { const [q2, shift] = slipWeek(q, a); text += shift > 0 ? t_('holds_slip', { wd: wd(shift), finish: fd(D(q2.finish)) }) : T.holds_noslip; }
  return res('holds_up', text + others, fwd.map(x => x.id), '', { ids: [a.id], dir: 'fwd' }, a.id, conf);
}

function windowAnswer(q, t, win, dd) {
  const [ws, we, lab] = win;
  const due = /\b(due|finish|finishes|finishing|complete|completes|completing|end|ends|ending)\b/.test(t);
  let acts;
  if (due) acts = q.activities.filter(a => !isLoe(a) && finishOf(a) != null && ws <= finishOf(a) && finishOf(a) <= we && isOpen(a));
  else acts = q.activities.filter(a => inWindow(a, ws, we));
  acts = byStart(q, acts);
  acts = acts.filter(a => a.critical).concat(acts.filter(a => !a.critical));
  const names = acts.map(label);
  let text;
  if (due) text = !acts.length ? t_('due_none', { label: lab }) : t_(acts.length === 1 ? 'due_one' : 'due_head', { n: acts.length, label: lab, list: top(names) });
  else text = !acts.length ? t_('win_none', { label: lab }) : t_(acts.length === 1 ? 'win_one' : 'win_head', { n: acts.length, label: lab, list: top(names) });
  if (acts.length) {
    const crit = acts.filter(a => a.critical);
    text += crit.length ? t_(crit.length === 1 ? 'win_crit_one' : 'win_crit', { n: crit.length, list: top(crit.map(label), 3) }) : T.win_nocrit;
  }
  return res('window', text, acts.map(a => a.id), '', null, null, 'high');
}

function listIntent(t) {
  if (/\b(not started|hasn.?t started|haven.?t started|has not started|have not started|yet to start|unstarted|still to start|to start)\b/.test(t)) return 'notstarted';
  if (/\b(in progress|progressing|underway|under way|ongoing|live|active|started)\b/.test(t)) return 'progress';
  if (/\b(late|behind|slipping|slipped|overdue|delayed|missed|behind baseline|behind programme)\b/.test(t)) return 'late';
  if (/\b(open|not finished|unfinished|outstanding|remaining|left to do|to do|incomplete)\b/.test(t)) return 'open';
  if (/\b(complete|completed|finished|done)\b/.test(t)) return 'complete';
  if (/\bmilestones?\b/.test(t)) return 'milestones';
  if (/\bnear.?critical\b/.test(t)) return 'near';
  return null;
}

function list(q, which, dd, dcal) {
  const acts = q.activities.filter(a => !isLoe(a));
  let sel, text;
  if (which === 'progress') {
    sel = byStart(q, acts.filter(a => st(a) === 'in_progress'));
    text = sel.length ? t_('list_progress', { acts: actsN(sel.length), list: top(sel.map(label)) }) : t_('list_progress_none', { dd: fd(dd) });
    return res('list', text, sel.map(a => a.id), 'status=in progress', null, null, 'high');
  }
  if (which === 'late') {
    if (acts.some(a => a.baseline_finish)) {
      const slip = a => wdays(calFor(q, a), D(a.baseline_finish), finishOf(a));
      sel = acts.filter(a => a.baseline_finish && finishOf(a) != null && finishOf(a) > D(a.baseline_finish));
      sel.sort((a, b) => (slip(b) - slip(a)) || cmp(a.id, b.id));
      text = sel.length ? t_('list_late', { acts: actsN(sel.length), list: top(sel.map(a => `${label(a)} (${sgn(slip(a))}d)`)) }) : T.list_late_none;
      return res('list', text, sel.map(a => a.id), 'quick:late', null, null, 'high');
    }
    sel = acts.filter(a => isOpen(a) && tfDays(q, a) < 0);
    sel.sort((a, b) => (tfDays(q, a) - tfDays(q, b)) || cmp(a.id, b.id));
    text = sel.length ? t_('list_nobaseline', { acts: actsN(sel.length), list: top(sel.map(a => `${label(a)} (${num(tfDays(q, a))}d)`)) }) : T.list_nobaseline_none;
    return res('list', text, sel.map(a => a.id), sel.length ? 'Float<0' : '', null, null, 'medium');
  }
  if (which === 'notstarted') {
    sel = byStart(q, acts.filter(a => st(a) === 'not_started'));
    text = sel.length ? t_('list_notstarted', { acts: actsN(sel.length), list: top(sel.map(label)) }) : T.list_notstarted_none;
    return res('list', text, sel.map(a => a.id), 'status=not started', null, null, 'high');
  }
  if (which === 'open') {
    sel = acts.filter(isOpen).sort((a, b) => cmp(finishIso(a), finishIso(b)) || cmp(a.id, b.id));
    const p = sel.filter(a => st(a) === 'in_progress').length;
    text = sel.length ? t_('list_open', { acts: actsN(sel.length), p, s: sel.length - p, list: top(sel.map(label)) }) : T.list_open_none;
    return res('list', text, sel.map(a => a.id), 'status!=complete', null, null, 'high');
  }
  if (which === 'complete') {
    sel = acts.filter(a => st(a) === 'complete').sort((a, b) => cmp(finishIso(b), finishIso(a)) || cmp(b.id, a.id));
    text = sel.length ? t_('list_complete', { acts: actsN(sel.length), list: top(sel.map(label)) }) : T.list_complete_none;
    return res('list', text, sel.map(a => a.id), 'status=complete', null, null, 'high');
  }
  if (which === 'near') {
    sel = acts.filter(a => isOpen(a) && !a.critical && a.total_float_hours != null && tfDays(q, a) <= NEAR_DAYS);
    sel.sort((a, b) => (tfDays(q, a) - tfDays(q, b)) || cmp(a.id, b.id));
    text = sel.length ? t_('list_near', { acts: actsN(sel.length), days: NEAR_DAYS, list: top(sel.map(a => `${label(a)} (${num(tfDays(q, a))}d)`)) }) : t_('list_near_none', { days: NEAR_DAYS });
    return res('list', text, sel.map(a => a.id), `Float<=${NEAR_DAYS}; critical=no`, null, null, 'high');
  }
  sel = acts.filter(isMs).sort((a, b) => cmp(finishIso(a), finishIso(b)) || cmp(a.id, b.id));
  text = sel.length ? t_('list_ms', { ms: countN(sel.length, T.ms_one, T.ms_many), list: top(sel.map(a => `${label(a)} (${fd(finishOf(a))})`)) }) : T.list_ms_none;
  return res('list', text, sel.map(a => a.id), 'quick:milestones', null, null, 'high');
}

function resources(q, t, m, win, toks, dd) {
  const cts = codeTypes(q);
  let who = null, filt = null, sel = [];
  const resList = q.resources || [], assigns = q.assignments || [];
  if (m) {
    const key = m[1].trim(), words = m[2].trim().split(' ');
    const ct = cts.find(c => key === c.toLowerCase() || key.endsWith(' ' + c.toLowerCase()));
    if (ct !== undefined) {
      let vals = [], val = words[0];
      for (let k = words.length; k > 0; k--) { val = words.slice(0, k).join(' '); vals = codeValues(q, ct).filter(v => v.toLowerCase().includes(val)); if (vals.length) break; }
      if (vals.length) { who = `${ct} ${vals[0]}`; filt = `${ct}=${vals[0]}`; sel = q.activities.filter(a => vals.includes((a.codes || {})[ct])); }
      else { who = `${ct} ${val}`; filt = `${ct}=${val}`; }
    } else if (['resource', 'resources', 'trade', 'trades', 'gang', 'crew'].includes(key.split(' ').pop())) {
      let rs = [];
      for (let k = words.length; k > 0; k--) { const val = words.slice(0, k).join(' '); rs = resList.filter(r => r.name.toLowerCase().includes(val)); if (rs.length) break; }
      if (rs.length) {
        const rid = new Set(rs.map(r => r.id));
        who = rs[0].name; filt = `resource=${rs[0].name}`;
        const aids = new Set(assigns.filter(x => rid.has(x.resource_id)).map(x => x.activity_id));
        sel = q.activities.filter(a => aids.has(a.id));
      }
    }
  }
  if (who === null) {
    const qt = tokens(t.replace(/\bon site\b/g, ' ')).filter(x => !STOP.has(x) && !isDigits(x));
    let best = null;   // [-score, order, kind, obj]
    resList.forEach((r, i) => { const k = score(qt, nameTokens(r.name)); if (k && (best === null || -k < best[0] || (-k === best[0] && i < best[1]))) best = [-k, i, 'res', r]; });
    let n0 = resList.length;
    for (const ct of cts) {
      for (const v of codeValues(q, ct)) {
        if (['none', ''].includes(v.toLowerCase())) continue;
        const k = score(qt, nameTokens(v));
        if (k && (best === null || -k < best[0] || (-k === best[0] && n0 < best[1]))) best = [-k, n0, 'code', [ct, v]];
        n0++;
      }
    }
    if (best !== null && best[2] === 'res') {
      const r = best[3];
      const aids = new Set(assigns.filter(x => x.resource_id === r.id).map(x => x.activity_id));
      who = r.name; filt = `resource=${r.name}`; sel = q.activities.filter(a => aids.has(a.id));
    } else if (best !== null) {
      const [ct, v] = best[3];
      who = `${ct} ${v}`; filt = `${ct}=${v}`; sel = q.activities.filter(a => (a.codes || {})[ct] === v);
    }
  }
  if (who === null) {
    if (win === null) {
      if (m === null && !/\b(who|whose|trade|trades|gang|gangs|resource|resources|crew|crews|subcontractors?|labour)\b/.test(t)) return null;
      const names = resList.length ? resList.map(r => r.name) : (cts.length ? codeValues(q, cts[0]) : []);
      if (!names.length) return res('resources', T.res_nothing, [], '', null, null, 'low');
      const qt = toks.filter(x => !STOP.has(x)).join(' ') || t;
      return res('resources', t_('res_unknown', { text: qt, list: top(names) }), [], '', null, null, 'low');
    }
    if (!(resList.length && assigns.length) && !cts.length) return windowAnswer(q, t, win, dd);
    return onsite(q, win, cts);
  }
  let where = '';
  if (win !== null) { const [ws, we, lab] = win; sel = sel.filter(a => inWindow(a, ws, we)); where = ' ' + lab; }
  sel = byStart(q, sel.filter(a => !isLoe(a)));
  if (!sel.length) return res('resources', t_('res_none', { who, where }), [], filt, null, null, 'high');
  const first = sel[0];
  let last = sel[0];
  for (const a of sel) { const af = finishOf(a), lf = finishOf(last); if (af != null && (lf == null || af > lf)) last = a; }
  const key = sel.length === 1 ? 'res_one' : 'res_head';
  let text = t_(key, { who, n: sel.length, where, start: fd(startOf(first)), finish: fd(finishOf(last)), list: top(sel.map(label)) });
  const crit = sel.filter(a => a.critical);
  if (crit.length) text += t_(crit.length === 1 ? 'res_crit_one' : 'res_crit', { n: crit.length });
  return res('resources', text, sel.map(a => a.id), filt, null, null, 'high');
}

function onsite(q, win, cts) {
  const [ws, we, lab] = win;
  const acts = byStart(q, q.activities.filter(a => inWindow(a, ws, we) && isOpen(a)));
  const groups = [];   // [name, count]
  const bump = nm => { const i = groups.findIndex(g => g[0] === nm); if (i < 0) groups.push([nm, 1]); else groups[i] = [nm, groups[i][1] + 1]; };
  if ((q.assignments || []).length && (q.resources || []).length) {
    const rname = {}; for (const r of q.resources) rname[r.id] = r.name;
    for (const a of acts) for (const x of q.assignments) if (x.activity_id === a.id && x.resource_id in rname) bump(rname[x.resource_id]);
  } else if (cts.length) {
    for (const a of acts) { const v = (a.codes || {})[cts[0]]; if (v == null || v.toLowerCase() === 'none') continue; bump(v); }
  }
  groups.sort((a, b) => (b[1] - a[1]) || cmp(a[0], b[0]));
  const names = groups.map(g => `${g[0]} (${actsN(g[1])})`);
  const text = !groups.length ? t_('onsite_none', { label: lab }) : t_('onsite', { label: lab, list: top(names) });
  return res('resources', text, acts.map(a => a.id), '', null, null, 'high');
}

function counts(q, t, dd, dcal) {
  const acts = q.activities.filter(a => !isLoe(a));
  const tasks = acts.filter(a => !isMs(a)), ms = acts.filter(isMs);
  const done = acts.filter(a => st(a) === 'complete').length, prog = acts.filter(a => st(a) === 'in_progress').length;
  const todo = acts.length - done - prog;
  const [pct, planned] = progressOf(q, dd);
  const general = t_('count_all', { acts: actsN(acts.length), tasks: countN(tasks.length, T.task_one, T.task_many), ms: countN(ms.length, T.ms_one, T.ms_many), done, prog, todo });
  const days = Math.round((dateOnly(D(q.finish)) - dateOnly(D(q.start))) / 86400000);
  const length = () => t_('count_length', { weeks: num(r1(days / 7)), start: fd(D(q.start)), finish: fd(D(q.finish)), wd: wd(wdays(dcal, D(q.start), D(q.finish))) });
  let text;
  if (/\b(percent|percentage|per cent|progress|far)\b/.test(t)) text = t_('count_pct', { pct: num(pct), planned: num(planned), dd: fd(dd) }) + ' ' + general;
  else if (/\b(complete|completed|finished|done)\b/.test(t)) text = t_('count_complete', { done, n: acts.length, pct: num(pct) }) + ' ' + general;
  else if (/\b(week|weeks|long|duration|month|months|take)\b/.test(t)) text = length() + ' ' + general;
  else if (/\bmilestones?\b/.test(t)) text = general;
  else if (/\bcritical\b/.test(t)) { const open = acts.filter(isOpen); text = t_('count_critical', { n: open.filter(a => a.critical).length, total: open.length }) + ' ' + general; }
  else if (/\b(links?|relationships?|logic|dependencies)\b/.test(t)) text = t_('count_links', { n: acts.length, links: q.relationships.length }) + ' ' + general;
  else text = general + ' ' + length();
  return res('counts', text, [], '', null, null, 'high');
}

function whatIf(q, t, a, others, dd, dcal, ex) {
  if (a === null) return res('what_if', t_('which', { example: ex }), [], '', null, null, 'low', ex);
  if (st(a) === 'complete') return res('what_if', t_('wi_done', { label: label(a) }) + others, [a.id], '', null, a.id, 'high');
  const amt = amount(t);
  const assumed = amt === null;
  const n = assumed ? 5 : amt;
  const push = /\b(start|starts|started|starting|slip|slips|slipped|delay|delayed|late|later|push|pushed|postpone|postponed|move|moved)\b/.test(t)
    && !/\b(long|longer|take|takes|took|extend|extended|duration|overrun|overruns|ran over|runs over)\b/.test(t);
  const q2 = JSON.parse(JSON.stringify(q));
  const x = q2.activities.find(z => z.id === a.id), cal = calFor(q2, x);
  const hours = cal.days_to_hours(n);
  if (push && st(x) === 'not_started' && x.early_start) { x.constraint = 'start_on_or_after'; x.constraint_date = ISO(cal.add_hours(D(x.early_start), hours)); }
  else lengthen(x, hours);
  schedule(q2);
  const shift = wdays(dcal, D(q.finish), D(q2.finish));
  const key = shift > 0 ? (push ? 'wi_start' : 'wi_dur') : (push ? 'wi_same_start' : 'wi_same_dur');
  let text = t_(key, { label: label(a), wd: wd(n), finish: fd(D(q2.finish)), shift: wd(shift), now: fd(D(q.finish)) });
  if (q.must_finish_by && shift > 0) {
    const m = wdays(dcal, D(q2.finish), D(q.must_finish_by));
    if (m < 0) text += t_('wi_miss', { deadline: fd(D(q.must_finish_by)), wd: wd(m) });
    else if (m > 0) text += t_('wi_meet', { deadline: fd(D(q.must_finish_by)), wd: wd(m) });
    else text += t_('wi_exact', { deadline: fd(D(q.must_finish_by)) });
  }
  if (assumed) text += T.wi_assumed;
  text += others + T.try_mode;
  return res('what_if', text, [a.id], '', null, a.id, 'high');
}

function health(q) {
  const rep = E.healthCheck(q);
  const applicable = rep.checks.filter(c => c.applicable), failing = applicable.filter(c => !c.passed);
  let ids = [], text;
  if (!failing.length) text = t_('health_ok', { n: applicable.length, score: rep.score });
  else {
    const items = failing.slice(0, 4).map(c => `${c.title}: ${c.detail}`);
    text = t_('health_fail', { score: rep.score, k: failing.length, n: applicable.length, list: items.join(' ') });
    if (failing.length > 4) text += t_('health_more', { n: failing.length - 4 });
    for (const c of failing) for (const it of c.items || []) ids.push(String(it).split('->')[0]);
  }
  const oos = E.outOfSequence(q);
  if (oos.length) { text += t_('oos', { acts: actsN(oos.length), list: top(oos.map(o => `${o.successor} ${o.successor_name}`), 3) }); ids = ids.concat(oos.map(o => o.successor)); }
  else text += T.oos_none;
  return res('health', text, ids, '', null, null, 'high');
}

function compareQ(q, t, dd, dcal) {
  const revs = q.revisions || [], periods = q.progress_periods || [];
  const hasBase = q.activities.some(a => a.baseline_finish);
  let named = revs.find(r => r.name && t.includes(String(r.name).toLowerCase())) || null;
  if (named === null && /\brev(ision)? [a-z0-9]+\b/.test(t) && !/\b(last|latest|previous|issued) rev/.test(t)) {
    const m = t.match(/\brev(?:ision)? ([a-z0-9]+)\b/);
    return res('compare', t_('cmp_rev_missing', { text: 'rev ' + m[1], list: top(revs.map(r => String(r.name))) || 'none' }), [], '', null, null, 'low');
  }
  if (named === null && /\bbaseline\b/.test(t)) return compareBaseline(q, dcal, hasBase);
  if (named === null && /\b(period|update|last week|last report|progress report|last month)\b/.test(t)) return comparePeriod(q, periods, dd, dcal);
  if (named === null && revs.length) named = revs[revs.length - 1];
  if (named === null) {
    if (periods.length) return comparePeriod(q, periods, dd, dcal);
    if (hasBase) return compareBaseline(q, dcal, hasBase);
    return res('compare', T.cmp_none, [], '', null, null, 'low');
  }
  const result = E.compareProjects(named.project, q);
  const text = t_('cmp_rev', { name: String(named.name), text: E.compareNarrative(result).split('\n\n').join(' ') });
  const ids = result.finish_drivers.map(x => x.id).concat(result.date_moves.map(x => x.id));
  return res('compare', text, ids, '', null, null, 'high');
}

function compareBaseline(q, dcal, hasBase) {
  if (!hasBase) return res('compare', T.cmp_base_none, [], '', null, null, 'low');
  const bls = q.baselines || [];
  let bf = (bls.length && bls[bls.length - 1].finish) ? D(bls[bls.length - 1].finish) : null;
  if (bf === null) { for (const a of q.activities) { const b = D(a.baseline_finish); if (b && (bf === null || b > bf)) bf = b; } }
  const slips = [];
  for (const a of q.activities) {
    if (a.baseline_finish && finishOf(a) != null && !isLoe(a)) { const s = wdays(calFor(q, a), D(a.baseline_finish), finishOf(a)); if (s > 0) slips.push([s, a]); }
  }
  slips.sort((x, y) => (y[0] - x[0]) || cmp(x[1].id, y[1].id));
  const shift = shiftText(wdays(dcal, bf, D(q.finish)));
  let text;
  if (slips.length) text = t_('cmp_base', { finish: fd(D(q.finish)), base: fd(bf), shift, acts: actsN(slips.length), list: top(slips.map(([s, a]) => `${label(a)} (${sgn(s)}d)`), 3) });
  else text = t_('cmp_base_ok', { finish: fd(D(q.finish)), base: fd(bf), shift });
  return res('compare', text, slips.map(x => x[1].id), 'quick:late', null, null, 'high');
}

function comparePeriod(q, periods, dd, dcal) {
  if (!periods.length) return res('compare', T.cmp_period_none, [], '', null, null, 'low');
  const last = periods[periods.length - 1];
  const [pct] = progressOf(q, dd);
  const p1 = num(r1(+(last.pct || 0)));
  const pdd = parseToday(last.data_date) || dd;
  const pf = parseToday(last.finish);
  const name = String(last.name || 'the last period');
  let text;
  if (pf === null) text = t_('cmp_period_nofinish', { name, dd: fd(pdd), p1, p2: num(pct), now: fd(D(q.finish)) });
  else text = t_('cmp_period', { name, dd: fd(pdd), then: fd(pf), now: fd(D(q.finish)), shift: shiftText(wdays(dcal, pf, D(q.finish))), p1, p2: num(pct) });
  return res('compare', text, [], '', null, null, 'high');
}

function drag(q, dcal) {
  const topD = E.criticalDrag(q).filter(d => d.drag_days > 0).slice(0, 5);
  if (!topD.length) return res('drag', T.drag_none, [], 'critical=yes', null, null, 'high');
  const text = t_('drag_head', { list: and(topD.map(d => t_('drag_item', { label: `${d.id} ${d.name}`, wd: wd(d.drag_days) }))) }) + T.drag_tail;
  return res('drag', text, topD.map(d => d.id), 'critical=yes', null, null, 'high');
}

function risk(q, dcal) {
  let margin = '';
  if (q.must_finish_by) { const m = wdays(dcal, D(q.finish), D(q.must_finish_by)); margin = m > 0 ? t_('risk_margin_ahead', { wd: wd(m) }) : m < 0 ? t_('risk_margin_behind', { wd: wd(m) }) : ''; }
  return res('risk', T.risk + t_('risk_fc', { finish: fd(D(q.finish)), margin }), [], '', null, null, 'medium');
}

Object.assign(global.PlannerEngine, { ask, ASK_EXAMPLES });
})(typeof window !== 'undefined' ? window : globalThis);

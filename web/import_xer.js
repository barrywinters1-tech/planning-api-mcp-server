/* Primavera P6 XER import for the browser build: a faithful port of planner/xer.py read_xer
   (and of the byte decoding in planner/io.py read_any). readXer(text) returns the same plain
   object Python's read_xer(text).model_dump(mode="json") does: same keys, values and list order.
   tests/test_import_parity_xer.py checks the two side by side, then schedules both.

   Python semantics reproduced here on purpose:
   - str.splitlines() line breaks and str.strip() whitespace (Unicode, not JS's \s set)
   - float() / int() string syntax (underscores, inf/nan, surrounding whitespace)
   - datetime.strptime() field patterns and its "match, then require the whole string" rule
   - dict order: first insertion keeps its place, the last write wins
   - max(set(hours), key=hours.count) breaking ties in CPython's set iteration order
   - KeyError / IndexError / ValueError texts for malformed files */
'use strict';
(function (global) {
const E = global.PlannerEngine;

const TASK_TYPE_IN = { TT_Task: 'task', TT_Rsrc: 'task', TT_Mile: 'start_milestone', TT_FinMile: 'finish_milestone', TT_LOE: 'level_of_effort', TT_WBS: 'level_of_effort' };
const STATUS_IN = { TK_NotStart: 'not_started', TK_Active: 'in_progress', TK_Complete: 'complete' };
const CSTR_IN = { CS_MSOA: 'start_on_or_after', CS_MSOB: 'start_on_or_before', CS_MEOA: 'finish_on_or_after', CS_MEOB: 'finish_on_or_before', CS_MSO: 'must_start_on', CS_MEO: 'must_finish_on', CS_ALAP: 'as_late_as_possible' };
const LINK_IN = { PR_FS: 'FS', PR_SS: 'SS', PR_FF: 'FF', PR_SF: 'SF' };
const RSRC_IN = { RT_Labor: 'labour', RT_Mat: 'material', RT_Equip: 'equipment' };
const EXCEL_EPOCH = Date.UTC(1899, 11, 30);
const MAX_SERIAL = (Date.UTC(9999, 11, 31) - EXCEL_EPOCH) / 86400000;   // date.max - EXCEL_EPOCH
const P2 = n => String(n).padStart(2, '0');

// ---------- Python dict / str / number semantics ----------
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const lookup = (o, k, dflt) => (typeof k === 'string' && own(o, k)) ? o[k] : dflt;         // dict.get(k, default)
function put(o, k, v) {                                                                      // d[k] = v for any string key
  if (k === '__proto__') Object.defineProperty(o, k, { value: v, writable: true, enumerable: true, configurable: true });
  else o[k] = v;
}
const keyError = k => new Error(`'${k}'`);                                                   // str(KeyError('k'))
const get = (r, k) => r.get(k);                                                              // row.get(k) -> undefined plays None
const getd = (r, k, d) => r.has(k) ? r.get(k) : d;                                          // row.get(k, d)
function req(r, k) { if (!r.has(k)) throw keyError(k); return r.get(k); }                   // row[k]

const WS = '\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000';   // str.isspace()
const STRIP_RE = new RegExp(`^[${WS}]+|[${WS}]+$`, 'g');
const pyStrip = s => s.replace(STRIP_RE, '');
const LINE_BREAK = /\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/;                          // str.splitlines()

const FLOAT_RE = /^[+-]?(?:\d(?:_?\d)*(?:\.(?:\d(?:_?\d)*)?)?|\.\d(?:_?\d)*)(?:[eE][+-]?\d(?:_?\d)*)?$/;
const FLOAT_SPECIAL = /^([+-]?)(inf|infinity|nan)$/i;
const INT_RE = /^[+-]?\d(?:_?\d)*$/;
function pyFloat(s) {             // float(s), or undefined where Python raises
  if (typeof s !== 'string') return undefined;
  const t = pyStrip(s);
  if (FLOAT_RE.test(t)) return Number(t.replace(/_/g, ''));
  const m = FLOAT_SPECIAL.exec(t);
  if (m) return m[2].toLowerCase() === 'nan' ? NaN : (m[1] === '-' ? -Infinity : Infinity);
  return undefined;
}
function _f(s, dflt = 0) { const v = pyFloat(s); return v === undefined ? dflt : v; }
function intOfFloat(x) {          // int(float)
  if (Number.isNaN(x)) throw new Error('cannot convert float NaN to integer');
  if (!Number.isFinite(x)) throw new Error('cannot convert float infinity to integer');
  return Math.trunc(x) + 0;
}
const truthyNum = x => x !== 0;   // Python: 0.0 and -0.0 are falsy, nan is truthy (JS || gets nan wrong)

// datetime.strptime with "%Y-%m-%d %H:%M", "%Y-%m-%d %H:%M:%S", "%Y-%m-%d" (CPython's _strptime patterns;
// a space in the format becomes \s+). Python matches from the start and then rejects leftovers, so the
// patterns are anchored at the start only and the match length is checked.
const Y = '(\\d\\d\\d\\d)', Mo = '(1[0-2]|0[1-9]|[1-9])', Dd = '(3[0-1]|[1-2]\\d|0[1-9]|[1-9]| [1-9])';
const Hh = '(2[0-3]|[0-1]\\d|\\d)', Mi = '([0-5]\\d|\\d)', Ss = '(6[0-1]|[0-5]\\d|\\d)', SP = `[${WS}]+`;
const DT_FORMATS = [
  new RegExp(`^${Y}-${Mo}-${Dd}${SP}${Hh}:${Mi}`),
  new RegExp(`^${Y}-${Mo}-${Dd}${SP}${Hh}:${Mi}:${Ss}`),
  new RegExp(`^${Y}-${Mo}-${Dd}`),
];
const isLeap = y => y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
const daysIn = (y, m) => [31, isLeap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
function _dt(s) {                 // "YYYY-MM-DDTHH:MM:SS" or null
  s = pyStrip(s || '');
  if (!s) return null;
  for (const re of DT_FORMATS) {
    const m = re.exec(s);
    if (!m || m[0].length !== s.length) continue;
    const y = +m[1], mo = +m[2], d = +m[3], h = +(m[4] || 0), mi = +(m[5] || 0), sec = +(m[6] || 0);
    if (y < 1 || d > daysIn(y, mo) || sec > 59) continue;   // datetime() would raise ValueError
    return `${String(y).padStart(4, '0')}-${P2(mo)}-${P2(d)}T${P2(h)}:${P2(mi)}:${P2(sec)}`;
  }
  return null;
}

function colorHex(v) {            // P6 stores colours as a decimal BGR integer
  if (typeof v !== 'string') return '#7a8aa6';
  const t = pyStrip(v);
  if (!INT_RE.test(t)) return '#7a8aa6';
  const n = BigInt(t.replace(/_/g, ''));
  const h = x => (x & 0xFFn).toString(16).padStart(2, '0');
  return '#' + h(n) + h(n >> 8n) + h(n >> 16n);
}

// ---------- CPython set iteration order (for max(set(xs), key=xs.count) tie-breaks) ----------
const HASH_MOD = (1n << 61n) - 1n;
const _dv = new DataView(new ArrayBuffer(8));
function hashFloat(x) {           // hash(float) as size_t, for finite x
  if (x === 0) return 0n;
  _dv.setFloat64(0, x); const hi = _dv.getUint32(0), lo = _dv.getUint32(4);
  const neg = (hi >>> 31) === 1, e = (hi >>> 20) & 0x7ff;
  let m = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo), p;
  if (e === 0) p = -1074; else { m |= 1n << 52n; p = e - 1075; }
  let h = ((m % HASH_MOD) << BigInt(((p % 61) + 61) % 61)) % HASH_MOD;   // m * 2^p mod (2^61 - 1)
  if (neg) h = -h;
  if (h === -1n) h = -2n;
  return BigInt.asUintN(64, h);
}
function setOrder(values) {       // iteration order of set(values), CPython 3.x setobject.c
  const LINEAR_PROBES = 9;
  let mask = 7, table = new Array(8).fill(null), fill = 0;
  const nextIndex = (i, perturb, msk) => Number((BigInt(i) * 5n + 1n + perturb) & BigInt(msk));
  function insertClean(tbl, msk, key, hash) {
    let perturb = hash, i = Number(hash & BigInt(msk));
    for (;;) {
      if (tbl[i] === null) { tbl[i] = { key, hash }; return; }
      if (i + LINEAR_PROBES <= msk) for (let j = 1; j <= LINEAR_PROBES; j++) if (tbl[i + j] === null) { tbl[i + j] = { key, hash }; return; }
      perturb >>= 5n; i = nextIndex(i, perturb, msk);
    }
  }
  for (const key of values) {
    if (!Number.isFinite(key)) throw new Error('unhashable shift length');   // cannot happen: shifts are finite
    const hash = hashFloat(key);
    let perturb = hash, i = Number(hash & BigInt(mask)), slot = -1;
    search: for (;;) {
      const probes = i + LINEAR_PROBES <= mask ? LINEAR_PROBES : 0;
      for (let j = 0; j <= probes; j++) {
        const ent = table[i + j];
        if (ent === null) { slot = i + j; break search; }
        if (ent.hash === hash && ent.key === key) break search;            // already present
      }
      perturb >>= 5n; i = nextIndex(i, perturb, mask);
    }
    if (slot < 0) continue;
    table[slot] = { key, hash }; fill++;
    if (fill * 5 >= mask * 3) {
      let size = 8; while (size <= fill * 4) size *= 2;
      const old = table; table = new Array(size).fill(null); mask = size - 1;
      for (const ent of old) if (ent !== null) insertClean(table, mask, ent.key, ent.hash);
    }
  }
  return table.filter(x => x !== null).map(x => x.key);
}
function modeOf(xs) {             // max(set(xs), key=xs.count)
  let best, bestN = -1;
  for (const v of setOrder(xs)) { const n = xs.filter(x => x === v).length; if (n > bestN) { best = v; bestN = n; } }
  return best;
}

// ---------- low level ----------
function parseTables(text) {      // -> Map(table name -> [Map(field -> value)])
  const tables = new Map(); let name = null, fields = [];
  for (const raw of text.split(LINE_BREAK)) {
    if (!raw) continue;
    const parts = raw.split('\t'), tag = parts[0];
    if (tag === '%T') {
      if (parts.length < 2) throw new Error('list index out of range');
      name = parts[1]; fields = [];
      if (!tables.has(name)) tables.set(name, []);
    } else if (tag === '%F') {
      fields = parts.slice(1);
    } else if (tag === '%R' && name) {
      const row = parts.slice(1), rec = new Map();
      fields.forEach((f, i) => rec.set(f, i < row.length ? row[i] : ''));
      tables.get(name).push(rec);
    }
  }
  return tables;
}

// ---------- calendar data (the "(0||CalendarType()( ... ))" blob) ----------
const CAL_TOKEN = /0\|\|([^(]*)\(([^()]*)\)|\(|\)/g;
function parseNodes(s) {
  const root = { name: 'root', attrs: '', children: [] };
  const stack = [root];
  const tokens = Array.from(s.matchAll(CAL_TOKEN));
  let i = 0;
  while (i < tokens.length) {
    const tok = tokens[i][0];
    if (tok === '(') { stack.push(null); i++; continue; }
    if (tok === ')') { if (stack.length > 1) stack.pop(); i++; continue; }
    const node = { name: pyStrip(tokens[i][1]), attrs: tokens[i][2], children: [] };
    let parent = root;
    for (let j = stack.length - 1; j >= 0; j--) if (stack[j] !== null) { parent = stack[j]; break; }
    parent.children.push(node);
    if (i + 1 < tokens.length && tokens[i + 1][0] === '(') { stack.push(node); i += 2; } else i++;
  }
  return root.children;
}
const SHIFT_RE = /s\|(\d{1,2}):(\d{2})\|f\|(\d{1,2}):(\d{2})/;
function shiftHours(children) {
  let total = 0;
  for (const sh of children) {
    const m = SHIFT_RE.exec(sh.attrs);
    if (m) { const a = +m[1] * 60 + +m[2]; let b = +m[3] * 60 + +m[4]; if (b <= a) b += 24 * 60; total += (b - a) / 60; }
  }
  return total;
}
function excelDate(digits) {      // EXCEL_EPOCH + timedelta(days=int(digits))
  const n = BigInt(digits);
  if (n > 999999999n) throw new Error(`days=${n}; must have magnitude <= 999999999`);
  if (n > BigInt(MAX_SERIAL)) throw new Error('date value out of range');
  const d = new Date(EXCEL_EPOCH + Number(n) * 86400000);
  return `${String(d.getUTCFullYear()).padStart(4, '0')}-${P2(d.getUTCMonth() + 1)}-${P2(d.getUTCDate())}`;
}
function parseClndrData(blob, cal) {
  if (!blob) return cal;
  const flat = [];
  const walk = ns => { for (const x of ns) { flat.push(x); walk(x.children); } };
  walk(parseNodes(blob));
  for (const node of flat) {
    if (node.name === 'DaysOfWeek') {
      const wd = [], hours = []; let firstStart = null;
      for (const day of node.children) {
        if (!/^[0-9]+$/.test(day.name)) continue;
        const h = shiftHours(day.children);
        if (h > 0) {
          wd.push(Number((((BigInt(day.name) - 2n) % 7n) + 7n) % 7n));   // P6 1=Sun .. 7=Sat -> Mon=0
          hours.push(h);
          if (firstStart === null && day.children.length) {
            const m = /s\|(\d{1,2}):(\d{2})/.exec(day.children[0].attrs);
            if (m) {
              if (+m[1] > 23) throw new Error('hour must be in 0..23');
              if (+m[2] > 59) throw new Error('minute must be in 0..59');
              firstStart = `${P2(+m[1])}:${m[2]}:00`;
            }
          }
        }
      }
      if (wd.length) {
        cal.working_days = wd.sort((a, b) => a - b);
        cal.hours_per_day = E.pyRound(modeOf(hours), 2);
      }
      if (firstStart) cal.day_start = firstStart;
    } else if (node.name === 'Exceptions') {
      for (const ex of node.children) {
        const m = /d\|(\d+)/.exec(ex.attrs);
        if (!m) continue;
        const d = excelDate(m[1]);
        put(cal.exceptions, d, shiftHours(ex.children));
      }
    }
  }
  return cal;
}

const newCalendar = (id, name = 'Standard', hpd = 8) => ({ id, name, hours_per_day: hpd, day_start: '08:00:00', working_days: [0, 1, 2, 3, 4], exceptions: {} });
function localMorning() { const n = new Date(); return `${n.getFullYear()}-${P2(n.getMonth() + 1)}-${P2(n.getDate())}T08:00:00`; }   // datetime.now().replace(hour=8, ...)

// ---------- read ----------
const MEMO_ENT = [['&lt;', '<'], ['&gt;', '>'], ['&quot;', '"'], ['&#39;', "'"], ['&apos;', "'"], ['&nbsp;', ' ']];
function memoText(s) {
  s = String(s).split('\x7f\x7f').join('\n');
  s = s.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li)>/gi, '\n').replace(/<[^>]*>/g, '');
  for (const [k, v] of MEMO_ENT) s = s.split(k).join(v);
  s = s.replace(/&#([0-9]{1,7});/g, (m, d) => { const n = parseInt(d, 10); return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : ''; });
  s = s.split('&amp;').join('&');
  return s.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n').map(l => l.replace(/\s+$/, '')).join('\n').trim();
}
function readXer(text, projectIndex = 0) {
  const t = parseTables(String(text));
  const tbl = n => t.get(n) || [];
  const allProjects = tbl('PROJECT');
  let projects = allProjects.filter(r => getd(r, 'export_flag', 'Y') !== 'N');
  if (!projects.length) projects = allProjects;
  if (!projects.length) throw new Error('XER has no PROJECT table');
  let idx = Math.min(projectIndex, projects.length - 1);
  if (idx < 0) idx += projects.length;
  if (idx < 0) throw new Error('list index out of range');
  const pr = projects[idx];
  const pid = req(pr, 'proj_id');

  const cals = new Map();
  for (const r of tbl('CALENDAR')) {
    const id = req(r, 'clndr_id');
    const name = get(r, 'clndr_name') || req(r, 'clndr_id');
    const hpd = _f(get(r, 'day_hr_cnt'), 8.0);
    const cal = newCalendar(id, name, truthyNum(hpd) ? hpd : 8.0);
    parseClndrData(getd(r, 'clndr_data', ''), cal);
    cals.set(cal.id, cal);
  }

  const wbsRows = tbl('PROJWBS').filter(r => get(r, 'proj_id') === pid);
  const rootIds = new Set();
  for (const r of wbsRows) if (get(r, 'proj_node_flag') === 'Y') rootIds.add(req(r, 'wbs_id'));
  let root = null;
  for (const r of wbsRows) if (rootIds.has(req(r, 'wbs_id'))) { root = r; break; }
  const name = (root ? get(root, 'wbs_name') : undefined) || get(pr, 'proj_short_name') || pid;
  const wbs = [];
  for (const r of wbsRows) {
    if (rootIds.has(req(r, 'wbs_id'))) continue;
    const parent = get(r, 'parent_wbs_id');
    wbs.push({ id: req(r, 'wbs_id'), name: getd(r, 'wbs_name', ''), parent_id: rootIds.has(parent) ? null : (parent || null),
               code: get(r, 'wbs_short_name') ?? null, seq: intOfFloat(_f(get(r, 'seq_num'), 0)) });
  }

  const taskRows = tbl('TASK').filter(r => get(r, 'proj_id') === pid);
  const idByTask = new Map(), acts = [];
  for (const r of taskRows) {
    const code = get(r, 'task_code') || req(r, 'task_id');
    idByTask.set(req(r, 'task_id'), code);
    const status = lookup(STATUS_IN, getd(r, 'status_code', ''), 'not_started');
    const target = _f(get(r, 'target_drtn_hr_cnt')), remain = _f(get(r, 'remain_drtn_hr_cnt'));
    let pct;
    if (status === 'complete') pct = 100.0;
    else if (status === 'not_started') pct = 0.0;
    else if (get(r, 'complete_pct_type') === 'CP_Phys') pct = _f(get(r, 'phys_complete_pct'));
    else pct = target > 0 ? E.pyRound(100.0 * (target - remain) / target, 2) : _f(get(r, 'phys_complete_pct'));   // CP_Drtn, the P6 default
    let actStart = _dt(getd(r, 'act_start_date', '')), actEnd = _dt(getd(r, 'act_end_date', ''));
    if (status !== 'not_started' && actStart === null) actStart = _dt(getd(r, 'target_start_date', '')) || _dt(getd(r, 'early_start_date', ''));
    if (status === 'complete' && actEnd === null) actEnd = _dt(getd(r, 'target_end_date', '')) || _dt(getd(r, 'early_end_date', '')) || actStart;
    const wid = get(r, 'wbs_id'), tf = get(r, 'total_float_hr_cnt'), ff = get(r, 'free_float_hr_cnt');
    acts.push({
      id: code, name: getd(r, 'task_name', ''),
      wbs_id: rootIds.has(wid) ? null : (wid || null),
      calendar_id: get(r, 'clndr_id') || null,
      type: lookup(TASK_TYPE_IN, getd(r, 'task_type', ''), 'task'),
      duration_hours: _f(get(r, 'target_drtn_hr_cnt')),
      constraint: lookup(CSTR_IN, getd(r, 'cstr_type', ''), 'none'),
      constraint_date: _dt(getd(r, 'cstr_date', '')),
      status,
      actual_start: actStart, actual_finish: actEnd,
      suspend_date: status === 'in_progress' ? _dt(getd(r, 'suspend_date', '')) : null,
      resume_date: status === 'in_progress' ? _dt(getd(r, 'resume_date', '')) : null,
      remaining_hours: status !== 'not_started' ? remain : null,
      percent_complete: pct,
      baseline_start: _dt(getd(r, 'target_start_date', '')), baseline_finish: _dt(getd(r, 'target_end_date', '')),
      early_start: _dt(getd(r, 'early_start_date', '')), early_finish: _dt(getd(r, 'early_end_date', '')),
      late_start: _dt(getd(r, 'late_start_date', '')), late_finish: _dt(getd(r, 'late_end_date', '')),
      total_float_hours: tf ? _f(tf) : null,
      free_float_hours: ff ? _f(ff) : null,
      critical: false, notes: '', codes: {}, priority: 500, level_delay_hours: 0.0,
    });
  }

  const rels = [];
  for (const r of tbl('TASKPRED')) {
    const ti = get(r, 'task_id'), pi = get(r, 'pred_task_id');
    if (idByTask.has(ti) && idByTask.has(pi)) {
      rels.push({ predecessor_id: idByTask.get(pi), successor_id: idByTask.get(ti),
                  type: lookup(LINK_IN, getd(r, 'pred_type', ''), 'FS'), lag_hours: _f(get(r, 'lag_hr_cnt')), driving: false });
    }
  }

  // schedule options: the calendar relationship lag is measured on, and how progressed activities are scheduled
  // (rows without a proj_id apply to every project). P6 stores the three-way progress option as two Y/N flags
  // (xer.progress_logic_in): retained Y = retained logic (our default, left unset), override Y = progress override, both N = actual dates
  const LAG_CAL_IN = { rcal_Predecessor: 'predecessor', rcal_Successor: 'successor', rcal_Project: 'project', rcal_24Hour: '24h' };
  const progressLogicIn = r => {
    const retained = getd(r, 'sched_retained_logic', ''), override = getd(r, 'sched_progress_override', '');
    if (override === 'Y') return 'override';
    if (getd(r, 'sched_use_actual_dates', '') === 'Y') return 'actual_dates';
    if (retained === 'N' && override === 'N') return 'actual_dates';
    return null;
  };
  let lagCalendar = null, progressLogic = null;
  for (const r of tbl('SCHEDOPTIONS')) {
    if (getd(r, 'proj_id', pid) === pid) { lagCalendar = lookup(LAG_CAL_IN, getd(r, 'sched_calendar_on_relationship_lag', ''), null); progressLogic = progressLogicIn(r); break; }
  }

  const res = new Map();
  for (const r of tbl('RSRC')) {
    const key = req(r, 'rsrc_id');
    res.set(key, { id: get(r, 'rsrc_short_name') || req(r, 'rsrc_id'), name: getd(r, 'rsrc_name', ''),
                   type: lookup(RSRC_IN, getd(r, 'rsrc_type', ''), 'labour'), unit: 'h', rate: 0.0, max_units_per_day: null, colour: null });
  }
  const assigns = [], used = new Set();
  for (const r of tbl('TASKRSRC')) {
    const ti = get(r, 'task_id'), ri = get(r, 'rsrc_id');
    if (idByTask.has(ti) && res.has(ri)) {
      used.add(ri);
      assigns.push({ activity_id: idByTask.get(ti), resource_id: res.get(ri).id,
                     units: _f(get(r, 'target_qty')), cost: _f(get(r, 'target_cost')), actual_cost: 0.0 });
    }
  }

  // activity codes
  const codeTypes = new Map();
  for (const r of tbl('ACTVTYPE')) { const k = req(r, 'actv_code_type_id'); codeTypes.set(k, getd(r, 'actv_code_type', '')); }
  const codeVals = new Map();
  for (const r of tbl('ACTVCODE')) {
    const k = req(r, 'actv_code_id');
    codeVals.set(k, [get(r, 'actv_code_type_id'), get(r, 'actv_code_name') || getd(r, 'short_name', ''), getd(r, 'color', '')]);
  }
  const codeLib = {}, actMap = new Map();
  for (const a of acts) actMap.set(a.id, a);
  for (const r of tbl('TASKACTV')) {
    const ti = get(r, 'task_id'), ci = get(r, 'actv_code_id');
    if (!(idByTask.has(ti) && codeVals.has(ci))) continue;
    const [typeId, val, color] = codeVals.get(ci);
    const ctype = codeTypes.has(typeId) ? codeTypes.get(typeId) : (typeId || 'Code');
    if (!ctype || !val) continue;
    put(actMap.get(idByTask.get(ti)).codes, ctype, val);
    if (!own(codeLib, ctype)) put(codeLib, ctype, {});
    put(codeLib[ctype], val, colorHex(color));
  }

  // notebook topics (TASKMEMO): HTML, with line breaks as <br> or two DEL characters (port of xer._memo_text)
  for (const r of tbl('TASKMEMO')) {
    const ti = get(r, 'task_id'); if (!idByTask.has(ti)) continue;
    const txt = memoText(getd(r, 'task_memo', '')); if (!txt) continue;
    const a = actMap.get(idByTask.get(ti)); a.notes = a.notes ? a.notes + '\n\n' + txt : txt;
  }

  // user-defined fields on activities (UDFTYPE / UDFVALUE), port of the same block in xer.read_xer
  const UDF_IN = { FT_TEXT: 'text', FT_STATICTYPE: 'text', FT_INT: 'number', FT_FLOAT_2_DECIMALS: 'number', FT_MONEY: 'number', FT_START_DATE: 'date', FT_END_DATE: 'date' };
  const udfTypes = new Map();
  for (const r of tbl('UDFTYPE')) {
    const label = get(r, 'udf_type_label') || get(r, 'udf_type_name') || '';
    if (getd(r, 'table_name', '') === 'TASK' && label && ![...udfTypes.values()].some(v => v[0] === label)) udfTypes.set(getd(r, 'udf_type_id', ''), [label, lookup(UDF_IN, getd(r, 'logical_data_type', ''), 'text')]);
  }
  for (const r of tbl('UDFVALUE')) {
    const ut = udfTypes.get(getd(r, 'udf_type_id', '')), fk = get(r, 'fk_id');
    if (!ut || !idByTask.has(fk)) continue;
    const [label, typ] = ut, raw = getd(r, typ === 'number' ? 'udf_number' : typ === 'date' ? 'udf_date' : 'udf_text', '');
    if (raw === '') continue;
    const a = actMap.get(idByTask.get(fk)); if (!a.fields) a.fields = {};
    put(a.fields, label, typ === 'number' ? _f(raw) : typ === 'date' ? raw.slice(0, 10) : raw);
  }
  const userFields = [...udfTypes.values()].map(([name, type]) => ({ name, type }));

  const defaultCal = get(pr, 'clndr_id') || (cals.size ? cals.keys().next().value : 'std');
  const calendars = {};
  for (const [k, v] of cals) put(calendars, k, v);
  const usedRes = Array.from(res.entries()).filter(([k]) => used.has(k)).map(([, v]) => v);
  const proj = {
    id: get(pr, 'proj_short_name') || pid, name,
    start: _dt(getd(pr, 'plan_start_date', '')) || localMorning(),
    data_date: _dt(getd(pr, 'last_recalc_date', '')),
    must_finish_by: _dt(getd(pr, 'plan_end_date', '')),
    default_calendar_id: defaultCal, calendars, wbs, activities: acts, relationships: rels,
    resources: usedRes.length ? usedRes : Array.from(res.values()), assignments: assigns,
    description: '', assumptions: [], code_types: codeLib, baselines: [], revisions: [], levelled: false, finish: null, scheduled_at: null,
  };
  if (userFields.length) proj.user_fields = userFields;
  if (lagCalendar) proj.lag_calendar = lagCalendar;
  if (progressLogic) proj.progress_logic = progressLogic;
  if (!own(calendars, defaultCal)) put(calendars, defaultCal, newCalendar(defaultCal));   // Project.ensure_default_calendar()
  return proj;
}

// ---------- bytes -> text, as planner/io.py read_any does for .xer ----------
// UTF-8 (strict, BOM kept as U+FEFF like Python's "utf-8" codec), else cp1252 with errors="replace".
// Python's cp1252 leaves 0x81 0x8D 0x8F 0x90 0x9D undefined (U+FFFD); the WHATWG "windows-1252"
// decoder maps them to C1 controls, so the table is spelled out here.
const CP1252_HIGH = [0x20AC, 0xFFFD, 0x201A, 0x0192, 0x201E, 0x2026, 0x2020, 0x2021, 0x02C6, 0x2030, 0x0160, 0x2039, 0x0152, 0xFFFD, 0x017D, 0xFFFD,
                     0xFFFD, 0x2018, 0x2019, 0x201C, 0x201D, 0x2022, 0x2013, 0x2014, 0x02DC, 0x2122, 0x0161, 0x203A, 0x0153, 0xFFFD, 0x017E, 0x0178];
function decodeCp1252(bytes) {
  const out = []; const CHUNK = 8192;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const codes = Array.from(bytes.subarray(i, i + CHUNK), b => (b >= 0x80 && b < 0xA0) ? CP1252_HIGH[b - 0x80] : b);
    out.push(String.fromCharCode.apply(null, codes));
  }
  return out.join('');
}
function decodeXerBytes(bytes) {
  if (!(bytes instanceof Uint8Array)) bytes = new Uint8Array(bytes);
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch (e) { return decodeCp1252(bytes); }
}

Object.assign(E, { readXer, decodeXerBytes, parseXerTables: parseTables, parseClndrData });
})(typeof window !== 'undefined' ? window : globalThis);

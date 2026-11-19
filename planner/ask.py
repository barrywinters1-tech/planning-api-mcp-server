"""Plain-English questions answered from the scheduling engine, with no AI involved.

    ask(project, question, today=None) -> dict

The answer is computed from the schedule itself (CPM dates, floats, driving links, the DCMA
checks, drag, comparison with issued revisions) and written as one to four UK-English sentences.
The result also carries what the UI needs to show the answer on the chart:

    kind         the intent that was recognised (see INTENTS), or "unknown"
    answer       the text
    ids          activity ids the answer is about (at most MAX_IDS), for highlighting
    filter       a filter the UI can apply: the table filter grammar ("critical=yes", "Trade=Brick",
                 "status=in progress", "Float<=10") or "quick:<name>" for one of the UI's quick filters
                 (late, milestones); "" when the ids say it all
    trace        {"ids": [...], "dir": "back"|"fwd"} when the answer is a logic chain, else None
    goto         one activity id when the answer is about one activity, else None
    confidence   "high" | "medium" | "low"
    suggestions  up to three follow-up questions

Deterministic: "today" is the data date (or the project start) unless `today` is given as an ISO
date string. The project is never mutated; a clone is scheduled when it has no dates. Any string
is accepted and nothing raises: a question that is not understood gives kind "unknown".

web/ask.js is a line-for-line port and must produce identical results (tests/test_ask_parity.py).
Every string constant lives in the tables below (T, STOP, SUGGEST, ASK_EXAMPLES) and is copied
verbatim into web/ask.js; change both together.
"""
from __future__ import annotations

import re
from datetime import datetime, timedelta
from typing import Optional

from .compare import _walk_driving, compare, narrative
from .cpm import _remaining_hours, schedule
from .dcma import health_check
from .guardrails import critical_drag, out_of_sequence
from .model import Activity, ActivityType, Calendar, Constraint, Project, Status

MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
MONTH_NUM = {"january": 1, "february": 2, "march": 3, "april": 4, "may": 5, "june": 6, "july": 7, "august": 8,
             "september": 9, "october": 10, "november": 11, "december": 12, "jan": 1, "feb": 2, "mar": 3, "apr": 4,
             "jun": 6, "jul": 7, "aug": 8, "sep": 9, "sept": 9, "oct": 10, "nov": 11, "dec": 12}
MONTH_RE = "january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept|sep|oct|nov|dec"
NUM_WORDS = {"a": 1, "an": 1, "one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7, "eight": 8, "nine": 9, "ten": 10}
MAX_IDS = 12       # ids returned for highlighting
MAX_NAMED = 6      # names written out before "and N more"
NEAR_DAYS = 10     # near-critical threshold, as the UI's quick filter
WHY_STEPS = 6      # driving predecessors walked for "why"
QUESTION_CHARS = 500
LOE = ActivityType.LOE

INTENTS = ["when_start", "when_finish", "milestone", "project_finish", "critical", "why", "holds_up", "float", "duration",
           "window", "list", "resources", "counts", "what_if", "health", "compare", "drag", "risk", "unknown"]

# ---- shared string tables: copied verbatim into web/ask.js --------------------------------------
T = {
    "error": "The programme could not be scheduled: {error}",
    "empty": "The programme has no activities yet, so there is nothing to ask about.",
    "unknown": "I did not catch that. Ask about dates (\"when does A1240 start\"), the finish (\"are we on track\"), the critical path, float, what an activity holds up, a time window (\"what's happening next week\"), a trade, counts, a what-if (\"what if A1240 takes 2 weeks longer\"), the health checks or what changed since a revision.",
    "no_match": "No activity matches \"{text}\". Try its ID or a word from its name.",
    "which": "Which activity do you mean? Name one, for example \"{example}\".",
    "others": " Other matches: {list}.",
    "from_today": ", {wd} from today",
    "today": ", today",
    "ago": ", {wd} ago",
    "start_fc": "{label} is forecast to start on {start}{rel}; it finishes on {finish}.",
    "finish_fc": "{label} is forecast to finish on {finish}{rel}; it starts on {start}.",
    "started": "{label} started on {start} and is {pct}% complete; it is forecast to finish on {finish}{rel}.",
    "complete": "{label} is complete: it started on {start} and finished on {finish}.",
    "ms_fc": "{label} is forecast for {date}{rel}.",
    "ms_done": "{label} was achieved on {date}.",
    "crit_zero": " It is on the critical path, with no float.",
    "crit_float": " It is on the critical path, with {wd} of float to the required completion date.",
    "crit_neg": " It is on the critical path and {wd} behind the required completion date (negative float).",
    "neg_float": " It has negative float of {wd}: it cannot meet the required completion date as planned.",
    "near_float": " It is near-critical, with {wd} of total float.",
    "float": " It has {wd} of total float.",
    "float_full": "{label} has {tf} of total float and {ff} of free float.",
    "dur": "{label} is {wd} long on the {cal} calendar.",
    "dur_ms": "{label} is a milestone: it has no duration.",
    "dur_left": " It is {pct}% complete with {wd} remaining; it is forecast to finish on {finish}.",
    "dur_none": " None of it has been done yet; it is forecast to run from {start} to {finish}.",
    "dur_done": " It is complete.",
    "pf_head": "The programme is forecast to finish on {finish} ({label}){rel}.",
    "pf_ahead": " The required completion date is {deadline}: the forecast is {wd} ahead of it.",
    "pf_behind": " The required completion date is {deadline}: the forecast is {wd} behind it.",
    "pf_meets": " The forecast meets the required completion date of {deadline} exactly.",
    "pf_nodead": " No required completion date is set.",
    "pf_progress": " At the data date of {dd} the programme is {pct}% complete against {planned}% planned.",
    "pf_notstarted": " Work has not started: the data date is {dd}.",
    "crit_head": "The longest path to {label} ({finish}) runs through {n} activities: {list}.",
    "crit_none": "No activity is critical: every remaining activity has float, so the finish is set by a constraint, the data date or a milestone.",
    "crit_neg_n": " {n} have negative float: {list}.",
    "crit_neg_one": " One has negative float: {list}.",
    "crit_margin": " The path has {wd} of float to the required completion date of {deadline}.",
    "crit_nomargin": " The path has no float.",
    "why_driven": "{label} starts on {start}{rel}, driven by {pred} ({link}), which {verb} on {date}.",
    "why_chain": " That in turn follows {list}.",
    "why_cons": "{label} starts on {start}{rel}, set by its {constraint} constraint of {date}.",
    "why_cons_also": " It also carries a {constraint} constraint of {date}.",
    "why_dd": "{label} starts on {start}{rel}: nothing holds it back, so it begins at the data date of {dd}.",
    "why_prog": "{label} started on {start} and is {pct}% complete; its remaining work runs from the data date of {dd}.",
    "why_done": "{label} is complete: it ran from {start} to {finish}.",
    "why_cal": " It works to the {cal} calendar.",
    "holds": "{label} holds up {n} activities, through to {last} on {date}: {list}.",
    "holds_none": "{label} holds nothing up: no activity follows it.",
    "holds_slip": " If it slipped by a week, the programme finish would move {wd} later, to {finish}.",
    "holds_noslip": " If it slipped by a week the finish would not move: its float absorbs the delay.",
    "holds_done": " It is complete, so it can no longer move anything.",
    "win_head": "{n} activities run {label}: {list}.",
    "win_one": "One activity runs {label}: {list}.",
    "win_none": "Nothing is scheduled {label}.",
    "win_crit": " {n} of them are on the critical path: {list}.",
    "win_crit_one": " One of them is on the critical path: {list}.",
    "win_nocrit": " None of them is on the critical path.",
    "due_head": "{n} activities are due to finish {label}: {list}.",
    "due_one": "One activity is due to finish {label}: {list}.",
    "due_none": "Nothing is due to finish {label}.",
    "list_progress": "{acts} in progress: {list}.",
    "list_progress_none": "Nothing is in progress at the data date of {dd}.",
    "list_late": "{acts} behind baseline finish: {list}.",
    "list_late_none": "Nothing is behind its baseline finish.",
    "list_nobaseline": "No baseline is set, so lateness is measured as negative float. {acts} with negative float: {list}.",
    "list_nobaseline_none": "No baseline is set and no activity has negative float, so nothing is late against the required completion date.",
    "list_notstarted": "{acts} not started, the next to start being {list}.",
    "list_notstarted_none": "Every activity has started.",
    "list_open": "{acts} not finished ({p} in progress and {s} not started), the next to finish being {list}.",
    "list_open_none": "Every activity is finished.",
    "list_complete": "{acts} complete, the most recent being {list}.",
    "list_complete_none": "Nothing is complete yet.",
    "list_ms": "{ms}: {list}.",
    "list_ms_none": "The programme has no milestones.",
    "list_near": "{acts} near-critical ({days} working days of float or less): {list}.",
    "list_near_none": "No open activity has {days} working days of float or less beyond the critical path.",
    "res_head": "{who} has {n} activities{where}, from {start} to {finish}: {list}.",
    "res_one": "{who} has one activity{where}, {list}, from {start} to {finish}.",
    "res_none": "{who} has nothing scheduled{where}.",
    "res_crit": " {n} of them are on the critical path.",
    "res_crit_one": " One of them is on the critical path.",
    "res_unknown": "No trade or resource matches \"{text}\". The programme has {list}.",
    "res_nothing": "The programme has no resources or activity codes to answer that with.",
    "onsite": "On site {label}: {list}.",
    "onsite_none": "Nobody is on site {label}.",
    "count_all": "The programme has {acts} ({tasks} and {ms}): {done} complete, {prog} in progress and {todo} not started.",
    "count_complete": "{done} of {n} activities are complete: {pct}% of the work by duration.",
    "count_length": "The programme runs {weeks} weeks, from {start} to {finish} ({wd} on the default calendar).",
    "count_pct": "The programme is {pct}% complete by duration, against {planned}% planned at the data date of {dd}.",
    "count_critical": "{n} of {total} open activities are on the critical path.",
    "count_links": "The programme has {n} activities and {links} relationships.",
    "wi_dur": "If {label} took {wd} longer, the programme would finish on {finish}, {shift} later than the current forecast of {now}.",
    "wi_start": "If {label} started {wd} later, the programme would finish on {finish}, {shift} later than the current forecast of {now}.",
    "wi_same_dur": "If {label} took {wd} longer, the programme finish would stay at {now}: its float absorbs the delay.",
    "wi_same_start": "If {label} started {wd} later, the programme finish would stay at {now}: its float absorbs the delay.",
    "wi_done": "{label} is complete, so a change to it cannot move the programme.",
    "wi_miss": " That would miss the required completion date of {deadline} by {wd}.",
    "wi_meet": " That would still meet the required completion date of {deadline}, with {wd} to spare.",
    "wi_exact": " That would land exactly on the required completion date of {deadline}.",
    "wi_assumed": " (No duration was given, so a week was assumed.)",
    "try_mode": " Use Try mode to make the change and see it on the chart.",
    "health_ok": "The programme passes all {n} applicable schedule checks, scoring {score}/100.",
    "health_fail": "The programme scores {score}/100: {k} of {n} checks fail. {list}",
    "health_more": " And {n} more.",
    "oos": " {acts} progressed out of sequence: {list}.",
    "oos_none": " Nothing has progressed out of sequence.",
    "cmp_none": "No earlier version is stored to compare with. Issue a revision or close a progress period first.",
    "cmp_rev": "Against {name}: {text}",
    "cmp_rev_missing": "No revision called \"{text}\". Issued revisions: {list}.",
    "cmp_base": "Against the baseline, the finish is {finish} versus {base}: {shift}. {acts} behind baseline finish, the biggest slips being {list}.",
    "cmp_base_ok": "Against the baseline, the finish is {finish} versus {base}: {shift}. No activity is behind its baseline finish.",
    "cmp_base_none": "No baseline is set, so there is nothing to compare against. Set a baseline first.",
    "cmp_period": "Since {name} (data date {dd}) the forecast finish has moved from {then} to {now} ({shift}) and progress has gone from {p1}% to {p2}%.",
    "cmp_period_nofinish": "Since {name} (data date {dd}) progress has gone from {p1}% to {p2}%; the forecast finish is now {now}.",
    "cmp_period_none": "No progress period has been closed yet, so there is no earlier update to compare with.",
    "shift_later": "{wd} later",
    "shift_earlier": "{wd} earlier",
    "shift_same": "unchanged",
    "drag_head": "Shortening these critical activities would bring the finish forward most: {list}.",
    "drag_tail": " Drag is the time an activity adds to the finish; beyond it a parallel path takes over.",
    "drag_none": "No unfinished critical task carries drag: the finish is set by milestones, constraints or the data date.",
    "drag_item": "{label} ({wd} of drag)",
    "risk": "Risk analysis is not stored with the programme. Run it to see the P50 and P80 finish dates and the chance of meeting the required completion date.",
    "risk_fc": " The deterministic forecast is {finish}{margin}.",
    "risk_margin_ahead": ", {wd} ahead of the required completion date",
    "risk_margin_behind": ", {wd} behind the required completion date",
    "link_lag": "{type}{lag}d",
    "finishes": "finishes",
    "starts": "starts",
    "wd_one": "working day",
    "wd_many": "working days",
    "act_one": "activity",
    "act_many": "activities",
    "task_one": "task",
    "task_many": "tasks",
    "ms_one": "milestone",
    "ms_many": "milestones",
    "more": " and {n} more",
}

# question words, verbs and intent words that never identify an activity by name
STOP = set("""a an the is are was were be been being do does did will would can could should shall may might have has had
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
apr jun jul aug sep sept oct nov dec""".split())

SUGGEST = {
    "unknown": ["When do we finish?", "What's critical?", "What's happening next week?"],
    "when_start": ["Why does {id} start then?", "What does {id} hold up?", "How much float does {id} have?"],
    "when_finish": ["Why does {id} start then?", "What does {id} hold up?", "How much float does {id} have?"],
    "milestone": ["What is driving {id}?", "What's critical?", "What if {id} slips 2 weeks?"],
    "project_finish": ["What is driving the finish?", "What should we accelerate?", "What's behind baseline?"],
    "critical": ["What should we accelerate?", "Why does {id} start then?", "What if {id} takes a week longer?"],
    "why": ["What does {id} hold up?", "How much float does {id} have?", "What if {id} starts a week later?"],
    "holds_up": ["Why does {id} start then?", "What if {id} takes 2 weeks longer?", "What's critical?"],
    "float": ["Why does {id} start then?", "What does {id} hold up?", "What's near-critical?"],
    "duration": ["When does {id} finish?", "What if {id} takes a week longer?", "How much float does {id} have?"],
    "window": ["What's critical?", "Who is on site next week?", "What's in progress?"],
    "list": ["What's critical?", "What's happening next week?", "When do we finish?"],
    "resources": ["What's happening next week?", "What's critical?", "How many activities are there?"],
    "counts": ["When do we finish?", "What's in progress?", "What's wrong with the programme?"],
    "what_if": ["What is driving the finish?", "What does {id} hold up?", "What should we accelerate?"],
    "health": ["What's critical?", "What should we accelerate?", "When do we finish?"],
    "compare": ["What is driving the finish?", "What's behind baseline?", "What's critical?"],
    "drag": ["What is driving the finish?", "What does {id} hold up?", "What if {id} takes a week longer?"],
    "risk": ["When do we finish?", "What's critical?", "What should we accelerate?"],
}

ASK_EXAMPLES = ["When do we finish?", "Are we on track?", "What's critical?", "What's happening next week?",
                "When does brickwork start?", "Why does A1240 start then?", "What does A1240 hold up?",
                "How much float does A1240 have?", "What if A1240 takes 2 weeks longer?", "What are the bricklayers doing?",
                "What's wrong with the programme?", "What should we accelerate?"]


# ---- formatting helpers ------------------------------------------------------------------------
def _r1(x: float) -> float:
    return round(x, 1) + 0.0


def _d(dt: datetime) -> str:
    return f"{dt.day} {MONTHS[dt.month - 1]} {dt.year}"


def _n(x: float) -> str:
    x = float(x)
    return str(int(x)) if x.is_integer() else f"{x:.1f}"


def _s(x: float) -> str:
    return ("+" if x > 0 else "") + _n(x)


def _count_n(x: float, one: str, many: str) -> str:
    return f"{_n(x)} {one if x == 1 else many}"


def _wd(x: float) -> str:
    return _count_n(abs(x), T["wd_one"], T["wd_many"])


def _acts(n: int) -> str:
    return _count_n(n, T["act_one"], T["act_many"])


def _and(items: list[str]) -> str:
    if len(items) <= 1:
        return "".join(items)
    return ", ".join(items[:-1]) + " and " + items[-1]


def _top(items: list[str], limit: int = MAX_NAMED) -> str:
    if len(items) <= limit:
        return _and(items)
    return ", ".join(items[:limit]) + _t("more", n=len(items) - limit)


def _t(key: str, **kw) -> str:
    s = T[key]
    for k, v in kw.items():
        s = s.replace("{" + k + "}", str(v))
    return s


def _label(a: Activity) -> str:
    return f"{a.id} {a.name}"


def _wdays(cal: Calendar, a: datetime, b: datetime) -> float:
    return _r1(cal.hours_to_days(cal.hours_between(a, b)))


def _rel(cal: Calendar, today: datetime, dt: datetime) -> str:
    n = _wdays(cal, today, dt)
    if n > 0:
        return _t("from_today", wd=_wd(n))
    if n < 0:
        return _t("ago", wd=_wd(n))
    return T["today"]


def _shift_text(x: float) -> str:
    if x > 0:
        return _t("shift_later", wd=_wd(x))
    if x < 0:
        return _t("shift_earlier", wd=_wd(x))
    return T["shift_same"]


def _link(r, pcal: Calendar) -> str:
    lag = _r1(pcal.hours_to_days(r.lag_hours))
    return _t("link_lag", type=r.type.value, lag=_s(lag)) if lag else r.type.value


def _cons_text(a: Activity) -> str:
    return a.constraint.value.replace("_", " ")


def _day0(dt: datetime) -> datetime:
    return dt.replace(hour=0, minute=0, second=0, microsecond=0)


def _day_end(dt: datetime) -> datetime:
    return dt.replace(hour=23, minute=59, second=59, microsecond=0)


def _days_in_month(y: int, m: int) -> int:
    if m == 2:
        return 29 if (y % 4 == 0 and (y % 100 != 0 or y % 400 == 0)) else 28
    return 30 if m in (4, 6, 9, 11) else 31


def _mkdate(y: int, m: int, d: int) -> datetime:
    return datetime(y, m, max(1, min(d, _days_in_month(y, m))))


# ---- schedule helpers --------------------------------------------------------------------------
def _scheduled(p: Project) -> Project:
    """A scheduled clone. Always rescheduled: a saved file may carry dates but stale driving flags."""
    q = p.model_copy(deep=True)
    schedule(q)
    return q


def _default_cal(p: Project) -> Calendar:
    return p.calendars.get(p.default_calendar_id) or Calendar(id=p.default_calendar_id)


def _is_open(a: Activity) -> bool:
    return a.status != Status.COMPLETE


def _tf_days(p: Project, a: Activity) -> float:
    return _r1(p.calendar_for(a).hours_to_days(a.total_float_hours or 0.0))


def _by_start(p: Project, acts: list[Activity]) -> list[Activity]:
    return sorted(acts, key=lambda a: ((a.start.isoformat() if a.start else ""), a.id))


def _progress(p: Project, dd: datetime) -> tuple[float, float]:
    """(% complete, % planned at the data date), weighted by task duration."""
    tot = done = plan = 0.0
    for a in p.activities:
        if a.type != ActivityType.TASK or a.duration_hours <= 0:
            continue
        cal = p.calendar_for(a)
        dur = a.duration_hours
        pc = 100.0 if a.status == Status.COMPLETE else (a.percent_complete or 0.0) if a.status == Status.IN_PROGRESS else 0.0
        tot += dur
        done += dur * pc / 100
        s = a.baseline_start or a.start
        f = a.baseline_finish or a.finish
        if s is not None and f is not None and f > s:
            span = cal.hours_between(s, f)
            frac = min(1.0, max(0.0, cal.hours_between(s, dd) / span)) if span > 0 else (1.0 if f <= dd else 0.0)
        else:
            frac = 1.0 if (f is not None and f <= dd) else 0.0
        plan += dur * frac
    if tot <= 0:
        return 0.0, 0.0
    return _r1(100 * done / tot), _r1(100 * plan / tot)


def _float_sentence(p: Project, a: Activity, warn_only: bool = False) -> str:
    if a.status == Status.COMPLETE:
        return ""
    tf = _tf_days(p, a)
    if a.critical:
        if tf > 0 and p.must_finish_by is not None:
            return _t("crit_float", wd=_wd(tf))
        if tf < 0:
            return _t("crit_neg", wd=_wd(tf))
        return T["crit_zero"]
    if tf < 0:
        return _t("neg_float", wd=_wd(tf))
    if tf <= NEAR_DAYS:
        return _t("near_float", wd=_wd(tf))
    return "" if warn_only else _t("float", wd=_wd(tf))


def _slip_week(p: Project, a: Activity) -> tuple[Optional[Project], float]:
    """Reschedule a clone with a week added to the activity; (clone, finish shift in default-calendar days)."""
    q = p.model_copy(deep=True)
    x = q.activity(a.id)
    cal = q.calendar_for(x)
    _lengthen(x, cal.days_to_hours(5))
    schedule(q)
    return q, _wdays(_default_cal(p), p.finish, q.finish)


def _lengthen(x: Activity, hours: float) -> None:
    if x.status == Status.IN_PROGRESS:
        x.remaining_hours = _remaining_hours(x) + hours
    else:
        x.duration_hours += hours
        if x.remaining_hours is not None:
            x.remaining_hours += hours


# ---- question parsing ---------------------------------------------------------------------------
def _norm(question) -> str:
    """The question as printable ASCII with single spaces, original case (emoji and accents become spaces in both engines)."""
    s = "" if question is None else str(question)
    s = re.sub(r"[^\x20-\x7e]+", " ", s[:QUESTION_CHARS])
    return re.sub(r"\s+", " ", s).strip()


def _tokens(s: str) -> list[str]:
    return re.findall(r"[a-z0-9]+", s)


def _lev1(a: str, b: str) -> bool:
    """Edit distance of at most one (a typo), for tokens of the same or neighbouring length."""
    if a == b:
        return True
    if abs(len(a) - len(b)) > 1:
        return False
    i = j = 0
    edits = 0
    while i < len(a) and j < len(b):
        if a[i] == b[j]:
            i += 1
            j += 1
            continue
        edits += 1
        if edits > 1:
            return False
        if len(a) > len(b):
            i += 1
        elif len(b) > len(a):
            j += 1
        else:
            i += 1
            j += 1
    return edits + (len(a) - i) + (len(b) - j) <= 1


def _stem(w: str) -> str:
    """Strip a common English suffix so "decorating" and "decoration" meet at "decorat"."""
    for suf in ("ing", "ions", "ion", "ies", "es", "ed", "er", "s"):
        if w.endswith(suf) and len(w) - len(suf) >= 4:
            return w[:-len(suf)]
    return w


def _prefix(a: str, b: str) -> bool:
    return len(a) >= 4 and len(b) >= 4 and (b.startswith(a) or a.startswith(b))


def _tok_match(q: str, n: str) -> bool:
    if q == n:
        return True
    qs, ns = _stem(q), _stem(n)
    if qs == ns or _prefix(q, n) or _prefix(qs, ns):
        return True
    return len(q) >= 5 and len(n) >= 5 and _lev1(q, n)


def _name_tokens(name: str) -> list[str]:
    toks = _tokens(name.lower())
    kept = [x for x in toks if x not in STOP]
    return kept or toks


def _score(qtoks: list[str], ntoks: list[str]) -> int:
    k = 0
    for q in qtoks:
        for n in ntoks:
            if _tok_match(q, n):
                k += 1
                break
    return k


def _find_acts(p: Project, toks: list[str], raw: list[str]) -> tuple[list[Activity], bool]:
    """Activities the question names: by id first, then by word overlap with the name. (matches, exact)
    A question word such as "a" or "d" only names a one-letter id when it is spelt exactly like it."""
    ids = {a.id.lower(): a for a in p.activities}
    by_id = []
    for i, tk in enumerate(toks):
        a = ids.get(tk)
        if a is not None and (tk not in STOP or raw[i] == a.id) and all(x.id != a.id for x in by_id):
            by_id.append(a)
    if by_id:
        return by_id, True
    # a number in the question only counts when some activity name carries it ("lift 2", "level 1"), so dates stay out
    name_digits = {x for a in p.activities for x in _tokens(a.name.lower()) if x.isdigit()}
    q = [x for x in toks if x not in STOP and (not x.isdigit() or x in name_digits)]
    if not q:
        return [], False
    scored = []
    for i, a in enumerate(p.activities):
        nt = _name_tokens(a.name)
        k = _score(q, nt)
        if k:
            scored.append((-k, -(k / len(nt)), i, a))
    scored.sort(key=lambda x: (x[0], x[1], x[2]))
    if not scored:
        return [], False
    best = -scored[0][0]
    if best < 2 and best < len(q) and -scored[0][1] < 0.5:
        return [], False
    return [x[3] for x in scored if -x[0] == best], False


def _code_types(p: Project) -> list[str]:
    out = list(p.code_types.keys())
    for a in p.activities:
        for k in a.codes:
            if k not in out:
                out.append(k)
    return out


def _code_values(p: Project, ct: str) -> list[str]:
    out = list((p.code_types.get(ct) or {}).keys())
    for a in p.activities:
        v = a.codes.get(ct)
        if v is not None and v not in out:
            out.append(v)
    return out


# ---- dates and windows in the question ----------------------------------------------------------
def _year_for(today: datetime, m: int, d: int) -> datetime:
    y = today.year
    dt = _mkdate(y, m, d)
    if dt < _day0(today) - timedelta(days=183):
        dt = _mkdate(y + 1, m, d)
    return dt


def _dates_in(t: str, today: datetime) -> list[datetime]:
    found: list[tuple[int, int, datetime]] = []
    for m in re.finditer(r"(\d{1,2})(?:st|nd|rd|th)? (" + MONTH_RE + r")(?: (\d{4}))?(?!\d)", t):
        mo = MONTH_NUM[m.group(2)]
        dt = _mkdate(int(m.group(3)), mo, int(m.group(1))) if m.group(3) else _year_for(today, mo, int(m.group(1)))
        found.append((m.start(), m.end(), dt))
    for m in re.finditer(r"(" + MONTH_RE + r") (\d{1,2})(?:st|nd|rd|th)?(?:,? (\d{4}))?(?!\d)", t):
        mo = MONTH_NUM[m.group(1)]
        dt = _mkdate(int(m.group(3)), mo, int(m.group(2))) if m.group(3) else _year_for(today, mo, int(m.group(2)))
        found.append((m.start(), m.end(), dt))
    for m in re.finditer(r"(\d{4})-(\d{2})-(\d{2})", t):
        found.append((m.start(), m.end(), _mkdate(int(m.group(1)), max(1, min(12, int(m.group(2)))), int(m.group(3)))))
    for m in re.finditer(r"(\d{1,2})/(\d{1,2})/(\d{4})", t):
        found.append((m.start(), m.end(), _mkdate(int(m.group(3)), max(1, min(12, int(m.group(2)))), int(m.group(1)))))
    found.sort(key=lambda x: (x[0], x[1]))
    out: list[datetime] = []
    last_end = -1
    for s, e, dt in found:
        if s < last_end:
            continue
        out.append(dt)
        last_end = e
    return out


def _span(a: datetime, b: datetime) -> tuple[datetime, datetime, str]:
    label = ("on " + _d(a)) if a.date() == b.date() else (_d(a) + " to " + _d(b))
    return a, _day_end(b), label


def _window(t: str, today: datetime) -> Optional[tuple[datetime, datetime, str]]:
    """(start 00:00, end 23:59:59, label) for the period the question names, or None."""
    d0 = _day0(today)
    mon = d0 - timedelta(days=d0.weekday())
    span = _span

    def month_span(y: int, mo: int):
        return span(_mkdate(y, mo, 1), _mkdate(y, mo, _days_in_month(y, mo)))

    m = re.search(r"between (\d{1,2})(?:st|nd|rd|th)? and (\d{1,2})(?:st|nd|rd|th)? (" + MONTH_RE + r")(?: (\d{4}))?(?!\d)", t)
    if m:
        mo = MONTH_NUM[m.group(3)]
        if m.group(4):
            return span(_mkdate(int(m.group(4)), mo, int(m.group(1))), _mkdate(int(m.group(4)), mo, int(m.group(2))))
        return span(_year_for(today, mo, int(m.group(1))), _year_for(today, mo, int(m.group(2))))
    dates = _dates_in(t, today)
    if len(dates) >= 2 and re.search(r"\b(between|from) .+ (and|to|until|till) ", t):
        a, b = dates[0], dates[1]
        return span(a, b) if b >= a else span(b, a)
    if re.search(r"\btoday\b", t):
        return span(d0, d0)
    if re.search(r"\btomorrow\b", t):
        return span(d0 + timedelta(days=1), d0 + timedelta(days=1))
    if re.search(r"\b(this|the current) week\b", t):
        return span(mon, mon + timedelta(days=6))
    if re.search(r"\bnext week\b", t):
        return span(mon + timedelta(days=7), mon + timedelta(days=13))
    if re.search(r"\b(this|the current) month\b", t):
        return month_span(d0.year, d0.month)
    if re.search(r"\bnext month\b", t):
        y, mo = (d0.year + 1, 1) if d0.month == 12 else (d0.year, d0.month + 1)
        return month_span(y, mo)
    m = re.search(r"\bnext (\d+|two|three|four|five|six|seven|eight|nine|ten|few|couple of|a|the) ?(day|days|week|weeks|fortnight|month|months)\b", t)
    if m:
        w = m.group(1)
        n = 3 if w == "few" else 2 if w == "couple of" else int(w) if w.isdigit() else NUM_WORDS.get(w, 1)
        u = m.group(2)
        days = n * 7 if u.startswith("week") else n * 14 if u == "fortnight" else n * 30 if u.startswith("month") else n
        return span(d0, d0 + timedelta(days=max(1, days) - 1))
    if re.search(r"\b(week commencing|w/c|week of|week beginning) ", t) and dates:
        a = dates[0] - timedelta(days=dates[0].weekday())
        return span(a, a + timedelta(days=6))
    m = re.search(r"\b(in|during|for|throughout|over) (" + MONTH_RE + r")(?: (\d{4}))?(?!\d)", t)
    if m and not re.search(r"\d{1,2} (" + MONTH_RE + r")", t):
        mo = MONTH_NUM[m.group(2)]
        if m.group(3):
            return month_span(int(m.group(3)), mo)
        return month_span(_year_for(today, mo, 1).year, mo)
    if dates and re.search(r"\b(on|around|at|for) ", t):
        return span(dates[0], dates[0])
    if re.search(r"\blookahead\b", t):
        return span(d0, d0 + timedelta(days=20))
    return None


def _in_window(a: Activity, ws: datetime, we: datetime) -> bool:
    return a.type != LOE and a.start is not None and a.finish is not None and a.start <= we and a.finish >= ws


def _amount(t: str) -> Optional[float]:
    """A duration in the question, in working days (weeks x5, months x21), or None."""
    m = re.search(r"\b(\d+(?:\.\d+)?|a|an|one|two|three|four|five|six|seven|eight|nine|ten) ?-?(day|days|d|week|weeks|wk|wks|w|month|months|fortnight)\b", t)
    if not m:
        return None
    w = m.group(1)
    n = float(w) if re.match(r"^\d", w) else float(NUM_WORDS.get(w, 1))
    u = m.group(2)
    if u == "fortnight":
        return n * 10
    if u.startswith("w"):
        return n * 5
    if u.startswith("m"):
        return n * 21
    return n


# ---- result -------------------------------------------------------------------------------------
def _res(kind: str, answer: str, ids: list[str], filt: str, trace: Optional[dict], goto: Optional[str],
         confidence: str, example_id: Optional[str] = None) -> dict:
    uniq: list[str] = []
    for i in ids:
        if i not in uniq:
            uniq.append(i)
    sid = example_id or goto or (uniq[0] if uniq else "")
    sugg = [s.replace("{id}", sid) for s in SUGGEST.get(kind, SUGGEST["unknown"]) if sid or "{id}" not in s][:3]
    while len(sugg) < 3:
        sugg.append([s for s in SUGGEST["unknown"] if s not in sugg][0])
    return {"kind": kind, "answer": answer, "ids": uniq[:MAX_IDS], "filter": filt, "trace": trace, "goto": goto,
            "confidence": confidence, "suggestions": sugg}


# ---- the engine ---------------------------------------------------------------------------------
def ask(project: Project, question, *, today: Optional[str] = None) -> dict:
    try:
        return _ask(project, question, today)
    except Exception as e:  # noqa: BLE001 - never raise on a question
        return _res("unknown", _t("error", error=str(e)), [], "", None, None, "low")


def _parse_today(today) -> Optional[datetime]:
    if not today:
        return None
    m = re.match(r"^\s*(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?", str(today))
    if not m:
        return None
    try:
        return datetime(int(m.group(1)), int(m.group(2)), int(m.group(3)), int(m.group(4) or 0), int(m.group(5) or 0), int(m.group(6) or 0))
    except ValueError:
        return None


def _ask(project: Project, question, today_s) -> dict:
    raw_t = _norm(question)
    t = raw_t.lower()
    toks = _tokens(t)
    raw = re.findall(r"[A-Za-z0-9]+", raw_t)
    if not toks:
        return _res("unknown", T["unknown"], [], "", None, None, "low")
    if not project.activities:
        return _res("unknown", T["empty"], [], "", None, None, "low")
    q = _scheduled(project)
    dd = q.data_date or q.start
    today = _parse_today(today_s) or dd
    dcal = _default_cal(q)
    acts, exact = _find_acts(q, toks, raw)
    act = acts[0] if acts else None
    others = acts[1:]
    conf = "high" if (act is not None and (exact or len(acts) == 1)) else "medium"
    others_text = _t("others", list=_top([_label(a) for a in others], 3)) if others else ""
    ex = q.activities[min(3, len(q.activities) - 1)].id
    win = _window(t, today)
    if win is None and re.search(r"\bon site\b", t):
        win = _span(_day0(today), _day0(today))
    fuzzy_win = win is not None and (act is None or (not exact and re.search(r"\b(what|which|who|anything|everything|all)\b", t) is not None))

    # ---- intents with their own keywords, project-wide first ----
    if re.search(r"\b(what if|if .* (takes?|took|slips?|slipped|starts? .* later|is delayed|were delayed|was delayed|delayed|overruns?|ran over|runs over)|impact of|delay(ed)? (to|on)|slip(s|ped)? by|late by|takes? .* longer|took .* longer|longer than)", t) \
            and not re.search(r"\b(hold|holds|depend|depends)\b", t):
        return _what_if(q, t, act, others_text, dd, dcal, ex)
    if re.search(r"\b(changed|change|changes|since|compared?|comparison|versus|vs|difference|different|moved since)\b", t):
        return _compare(q, t, dd, dcal)
    if re.search(r"\b(wrong|health|checks?|dcma|quality|issues?|problems?|dangl\w*|open ends?|logic|sound|hard constraints?|negative float|leads|lags|out of sequence)\b", t):
        return _health(q)
    if re.search(r"\b(accelerate|save time|speed up|crash|compress|recover|bring .* forward|faster|quicker|drag|shorten|pull .* back|make up time)\b", t):
        return _drag(q, dcal)
    if re.search(r"\b(how likely|likely|likelihood|probab\w*|chance|confiden\w*|risk|risky|p80|p50|p90|monte carlo)\b", t):
        return _risk(q, dcal)
    if re.search(r"\b(holds? up|holding up|held up|depends? on|dependent on|downstream|successors?|follows? (on )?from|follows? it|affected by|rel(y|ies) on|what does .* affect|knock.?on|pushes?)\b", t):
        if act is None:
            return _res("holds_up", _t("which", example=ex), [], "", None, None, "low", ex)
        return _holds_up(q, act, others_text, conf, dcal)
    if re.search(r"\b(why|waiting (for|on)|driven by|what is driving \w+\d|drives|reason)\b", t) and act is not None \
            and not re.search(r"\bwhy (is|does|will|do) (the )?(finish|completion|project|programme|end|handover)\b", t):
        return _why(q, act, others_text, conf, today, dd)
    if re.search(r"\b(critical|longest path|driving|drivers?|driven|why|near.?critical|least float|lowest float|zero float)\b", t) and act is None:
        if re.search(r"\b(near.?critical|near critical)\b", t):
            return _list(q, "near", dd, dcal)
        return _critical(q, dcal)
    if re.search(r"\b(float|slack|spare time|leeway|margin)\b", t):
        if act is None:
            return _critical(q, dcal)
        return _float(q, act, others_text, conf)
    if re.search(r"\b(how long|duration|days left|weeks left|remaining|left on|to go on|how many days)\b", t) and act is not None:
        return _duration(q, act, others_text, conf)
    if re.search(r"\b(how many|how long|count|number of|percent|percentage|per cent|how far|how complete|overall progress|statistics|stats|summary|size)\b", t) and act is None:
        return _counts(q, t, dd, dcal)
    m = re.search(r"\b([a-z][a-z0-9 _-]*?) ?[=:] ?([a-z0-9][a-z0-9 _&/-]*)", t)
    if m or re.search(r"\b(who|whose|doing|trade|trades|gang|gangs|resource|resources|crew|crews|subcontractors?|labour|working on|on site)\b", t):
        r = _resources(q, t, m, win, toks, dd)
        if r is not None:
            return r
    if fuzzy_win:
        return _window_answer(q, t, win, dd)
    if act is None and re.search(r"\b(are we|will we|do we|can we|shall we)\b", t) and not re.search(r"\bbaseline\b", t):
        return _project_finish(q, dd, dcal, today)
    if act is None:
        lst = _list_intent(t)
        if lst:
            return _list(q, lst, dd, dcal)
    if re.search(r"\b(when|what date|which date|dates?|how soon|due|start|starts|starting|finish|finishes|finishing|complete|completion|end|ends)\b", t):
        if act is not None:
            if act.is_milestone:
                return _milestone(q, act, others_text, conf, today)
            which = "finish" if re.search(r"\b(finish|finishes|finished|finishing|complete|completed|completion|end|ends|done|due)\b", t) else "start"
            return _when(q, act, which, others_text, conf, today)
        return _project_finish(q, dd, dcal, today)
    if re.search(r"\b(on track|deadline|on time|overrun|late|handover|hit|make it|finish|forecast|outlook|position)\b", t) and act is None:
        return _project_finish(q, dd, dcal, today)
    if act is not None:
        if act.is_milestone:
            return _milestone(q, act, others_text, conf, today)
        return _when(q, act, "start", others_text, conf, today)
    return _res("unknown", T["unknown"], [], "", None, None, "low")


# ---- intent answers -------------------------------------------------------------------------------
def _when(q: Project, a: Activity, which: str, others: str, conf: str, today: datetime) -> dict:
    cal = q.calendar_for(a)
    s, f = a.start, a.finish
    if a.status == Status.COMPLETE:
        head = _t("complete", label=_label(a), start=_d(s), finish=_d(f))
    elif a.status == Status.IN_PROGRESS and a.actual_start is not None:
        head = _t("started", label=_label(a), start=_d(s), pct=_n(_r1(a.percent_complete or 0.0)), finish=_d(f), rel=_rel(cal, today, f))
    elif which == "finish":
        head = _t("finish_fc", label=_label(a), finish=_d(f), rel=_rel(cal, today, f), start=_d(s))
    else:
        head = _t("start_fc", label=_label(a), start=_d(s), rel=_rel(cal, today, s), finish=_d(f))
    kind = "when_finish" if which == "finish" else "when_start"
    return _res(kind, head + _float_sentence(q, a) + others, [a.id], "", None, a.id, conf)


def _milestone(q: Project, a: Activity, others: str, conf: str, today: datetime) -> dict:
    cal = q.calendar_for(a)
    f = a.finish
    if a.status == Status.COMPLETE:
        head = _t("ms_done", label=_label(a), date=_d(f))
    else:
        head = _t("ms_fc", label=_label(a), date=_d(f), rel=_rel(cal, today, f))
    return _res("milestone", head + _float_sentence(q, a) + others, [a.id], "", None, a.id, conf)


def _float(q: Project, a: Activity, others: str, conf: str) -> dict:
    cal = q.calendar_for(a)
    tf = _tf_days(q, a)
    ff = _r1(cal.hours_to_days(a.free_float_hours or 0.0))
    head = _t("float_full", label=_label(a), tf=_wd(tf), ff=_wd(ff))
    return _res("float", head + _float_sentence(q, a, True) + others, [a.id], "", None, a.id, conf)


def _duration(q: Project, a: Activity, others: str, conf: str) -> dict:
    cal = q.calendar_for(a)
    if a.is_milestone:
        head = _t("dur_ms", label=_label(a))
    else:
        head = _t("dur", label=_label(a), wd=_wd(_r1(cal.hours_to_days(a.duration_hours))), cal=cal.name)
        if a.status == Status.COMPLETE:
            head += T["dur_done"]
        elif a.status == Status.IN_PROGRESS:
            head += _t("dur_left", pct=_n(_r1(a.percent_complete or 0.0)), wd=_wd(_r1(cal.hours_to_days(_remaining_hours(a)))), finish=_d(a.finish))
        else:
            head += _t("dur_none", start=_d(a.start), finish=_d(a.finish))
    return _res("duration", head + others, [a.id], "", None, a.id, conf)


def _project_finish(q: Project, dd: datetime, dcal: Calendar, today: datetime) -> dict:
    fin, _ = _walk_driving(q)
    f = q.finish
    label = _label(fin) if fin is not None else "no open activity"
    text = _t("pf_head", finish=_d(f), label=label, rel=_rel(dcal, today, f))
    if q.must_finish_by is not None:
        m = _wdays(dcal, f, q.must_finish_by)
        if m > 0:
            text += _t("pf_ahead", deadline=_d(q.must_finish_by), wd=_wd(m))
        elif m < 0:
            text += _t("pf_behind", deadline=_d(q.must_finish_by), wd=_wd(m))
        else:
            text += _t("pf_meets", deadline=_d(q.must_finish_by))
    else:
        text += T["pf_nodead"]
    pct, planned = _progress(q, dd)
    if any(a.status != Status.NOT_STARTED for a in q.activities):
        text += _t("pf_progress", dd=_d(dd), pct=_n(pct), planned=_n(planned))
    else:
        text += _t("pf_notstarted", dd=_d(dd))
    ids = [fin.id] if fin is not None else []
    return _res("project_finish", text, ids, "", None, fin.id if fin is not None else None, "high")


def _critical(q: Project, dcal: Calendar) -> dict:
    fin, on_path = _walk_driving(q)
    chain = _by_start(q, [a for a in q.activities if a.id in on_path and _is_open(a)])
    if fin is None or not chain:
        return _res("critical", T["crit_none"], [], "critical=yes", None, None, "high")
    text = _t("crit_head", label=_label(fin), finish=_d(q.finish), n=len(chain), list=_top([_label(a) for a in chain]))
    neg = [a for a in q.activities if _is_open(a) and a.type != LOE and _tf_days(q, a) < 0]
    if neg:
        text += _t("crit_neg_one" if len(neg) == 1 else "crit_neg_n", n=len(neg), list=_top([_label(a) for a in _by_start(q, neg)], 3))
    elif q.must_finish_by is not None and _tf_days(q, fin) > 0:
        text += _t("crit_margin", wd=_wd(_tf_days(q, fin)), deadline=_d(q.must_finish_by))
    else:
        text += T["crit_nomargin"]
    ids = [a.id for a in chain][-MAX_IDS:]
    return _res("critical", text, ids, "critical=yes", {"ids": [fin.id], "dir": "back"}, None, "high", ids[0])


def _why(q: Project, a: Activity, others: str, conf: str, today: datetime, dd: datetime) -> dict:
    amap = q.activity_map()
    cal = q.calendar_for(a)
    chain = [a.id]
    steps: list[tuple] = []
    cur = a
    for _ in range(WHY_STEPS):
        drv = [r for r in q.relationships if r.successor_id == cur.id and r.driving]
        if not drv:
            break
        r = drv[0]
        p = amap[r.predecessor_id]
        steps.append((r, p))
        chain.append(p.id)
        cur = p
    s = a.start
    if a.status == Status.COMPLETE:
        text = _t("why_done", label=_label(a), start=_d(s), finish=_d(a.finish))
    elif a.status == Status.IN_PROGRESS and a.actual_start is not None:
        text = _t("why_prog", label=_label(a), start=_d(s), pct=_n(_r1(a.percent_complete or 0.0)), dd=_d(dd))
    elif steps:
        r, p = steps[0]
        on_start = r.type.value in ("SS", "SF")
        text = _t("why_driven", label=_label(a), start=_d(s), rel=_rel(cal, today, s), pred=_label(p), link=_link(r, q.calendar_for(p)),
                  verb=T["starts"] if on_start else T["finishes"], date=_d(p.start if on_start else p.finish))
        if len(steps) > 1:
            text += _t("why_chain", list=_and([f"{_label(p2)} ({_link(r2, q.calendar_for(p2))})" for r2, p2 in steps[1:]]))
        if a.constraint != Constraint.NONE and a.constraint_date is not None:
            text += _t("why_cons_also", constraint=_cons_text(a), date=_d(a.constraint_date))
    elif a.constraint != Constraint.NONE and a.constraint_date is not None:
        text = _t("why_cons", label=_label(a), start=_d(s), rel=_rel(cal, today, s), constraint=_cons_text(a), date=_d(a.constraint_date))
    else:
        text = _t("why_dd", label=_label(a), start=_d(s), rel=_rel(cal, today, s), dd=_d(dd))
    text += _t("why_cal", cal=cal.name) + _float_sentence(q, a) + others
    return _res("why", text, chain, "", {"ids": [a.id], "dir": "back"}, a.id, conf)


def _holds_up(q: Project, a: Activity, others: str, conf: str, dcal: Calendar) -> dict:
    amap = q.activity_map()
    seen: set[str] = set()
    stack = [a.id]
    while stack:
        cur = stack.pop()
        for r in q.relationships:
            if r.predecessor_id == cur and r.successor_id not in seen and r.successor_id != a.id and r.successor_id in amap:
                seen.add(r.successor_id)
                stack.append(r.successor_id)
    fwd = _by_start(q, [x for x in q.activities if x.id in seen])
    if not fwd:
        text = _t("holds_none", label=_label(a))
    else:
        last = fwd[0]
        for x in fwd:
            if x.finish is not None and (last.finish is None or x.finish > last.finish or (x.finish == last.finish and x.id < last.id)):
                last = x
        text = _t("holds", label=_label(a), n=len(fwd), last=_label(last), date=_d(last.finish), list=_top([_label(x) for x in fwd]))
    if a.status == Status.COMPLETE:
        text += T["holds_done"]
    else:
        q2, shift = _slip_week(q, a)
        text += _t("holds_slip", wd=_wd(shift), finish=_d(q2.finish)) if shift > 0 else T["holds_noslip"]
    return _res("holds_up", text + others, [x.id for x in fwd], "", {"ids": [a.id], "dir": "fwd"}, a.id, conf)


def _window_answer(q: Project, t: str, win: tuple, dd: datetime) -> dict:
    ws, we, label = win
    due = bool(re.search(r"\b(due|finish|finishes|finishing|complete|completes|completing|end|ends|ending)\b", t))
    if due:
        acts = [a for a in q.activities if a.type != LOE and a.finish is not None and ws <= a.finish <= we and _is_open(a)]
    else:
        acts = [a for a in q.activities if _in_window(a, ws, we)]
    acts = _by_start(q, acts)
    acts = [a for a in acts if a.critical] + [a for a in acts if not a.critical]
    names = [_label(a) for a in acts]
    if due:
        text = _t("due_none", label=label) if not acts else _t("due_one" if len(acts) == 1 else "due_head", n=len(acts), label=label, list=_top(names))
    else:
        text = _t("win_none", label=label) if not acts else _t("win_one" if len(acts) == 1 else "win_head", n=len(acts), label=label, list=_top(names))
    if acts:
        crit = [a for a in acts if a.critical]
        text += _t("win_crit_one" if len(crit) == 1 else "win_crit", n=len(crit), list=_top([_label(a) for a in crit], 3)) if crit else T["win_nocrit"]
    return _res("window", text, [a.id for a in acts], "", None, None, "high")


def _list_intent(t: str) -> Optional[str]:
    if re.search(r"\b(not started|hasn.?t started|haven.?t started|has not started|have not started|yet to start|unstarted|still to start|to start)\b", t):
        return "notstarted"
    if re.search(r"\b(in progress|progressing|underway|under way|ongoing|live|active|started)\b", t):
        return "progress"
    if re.search(r"\b(late|behind|slipping|slipped|overdue|delayed|missed|behind baseline|behind programme)\b", t):
        return "late"
    if re.search(r"\b(open|not finished|unfinished|outstanding|remaining|left to do|to do|incomplete)\b", t):
        return "open"
    if re.search(r"\b(complete|completed|finished|done)\b", t):
        return "complete"
    if re.search(r"\bmilestones?\b", t):
        return "milestones"
    if re.search(r"\bnear.?critical\b", t):
        return "near"
    return None


def _list(q: Project, which: str, dd: datetime, dcal: Calendar) -> dict:
    acts = [a for a in q.activities if a.type != LOE]
    if which == "progress":
        sel = _by_start(q, [a for a in acts if a.status == Status.IN_PROGRESS])
        text = _t("list_progress", acts=_acts(len(sel)), list=_top([_label(a) for a in sel])) if sel else _t("list_progress_none", dd=_d(dd))
        return _res("list", text, [a.id for a in sel], "status=in progress", None, None, "high")
    if which == "late":
        if any(a.baseline_finish is not None for a in acts):
            sel = [a for a in acts if a.baseline_finish is not None and a.finish is not None and a.finish > a.baseline_finish]
            sel.sort(key=lambda a: (-_wdays(q.calendar_for(a), a.baseline_finish, a.finish), a.id))
            text = _t("list_late", acts=_acts(len(sel)), list=_top([f"{_label(a)} ({_s(_wdays(q.calendar_for(a), a.baseline_finish, a.finish))}d)" for a in sel])) if sel else T["list_late_none"]
            return _res("list", text, [a.id for a in sel], "quick:late", None, None, "high")
        sel = [a for a in acts if _is_open(a) and _tf_days(q, a) < 0]
        sel.sort(key=lambda a: (_tf_days(q, a), a.id))
        text = _t("list_nobaseline", acts=_acts(len(sel)), list=_top([f"{_label(a)} ({_n(_tf_days(q, a))}d)" for a in sel])) if sel else T["list_nobaseline_none"]
        return _res("list", text, [a.id for a in sel], "Float<0" if sel else "", None, None, "medium")
    if which == "notstarted":
        sel = _by_start(q, [a for a in acts if a.status == Status.NOT_STARTED])
        text = _t("list_notstarted", acts=_acts(len(sel)), list=_top([_label(a) for a in sel])) if sel else T["list_notstarted_none"]
        return _res("list", text, [a.id for a in sel], "status=not started", None, None, "high")
    if which == "open":
        sel = [a for a in acts if _is_open(a)]
        sel.sort(key=lambda a: ((a.finish.isoformat() if a.finish else ""), a.id))
        p = sum(1 for a in sel if a.status == Status.IN_PROGRESS)
        text = _t("list_open", acts=_acts(len(sel)), p=p, s=len(sel) - p, list=_top([_label(a) for a in sel])) if sel else T["list_open_none"]
        return _res("list", text, [a.id for a in sel], "status!=complete", None, None, "high")
    if which == "complete":
        sel = [a for a in acts if a.status == Status.COMPLETE]
        sel.sort(key=lambda a: ((a.finish.isoformat() if a.finish else ""), a.id), reverse=True)
        text = _t("list_complete", acts=_acts(len(sel)), list=_top([_label(a) for a in sel])) if sel else T["list_complete_none"]
        return _res("list", text, [a.id for a in sel], "status=complete", None, None, "high")
    if which == "near":
        sel = [a for a in acts if _is_open(a) and not a.critical and a.total_float_hours is not None and _tf_days(q, a) <= NEAR_DAYS]
        sel.sort(key=lambda a: (_tf_days(q, a), a.id))
        text = _t("list_near", acts=_acts(len(sel)), days=NEAR_DAYS, list=_top([f"{_label(a)} ({_n(_tf_days(q, a))}d)" for a in sel])) if sel else _t("list_near_none", days=NEAR_DAYS)
        return _res("list", text, [a.id for a in sel], f"Float<={NEAR_DAYS}; critical=no", None, None, "high")
    sel = [a for a in acts if a.is_milestone]
    sel.sort(key=lambda a: ((a.finish.isoformat() if a.finish else ""), a.id))
    text = _t("list_ms", ms=_count_n(len(sel), T["ms_one"], T["ms_many"]), list=_top([f"{_label(a)} ({_d(a.finish)})" for a in sel])) if sel else T["list_ms_none"]
    return _res("list", text, [a.id for a in sel], "quick:milestones", None, None, "high")


def _resources(q: Project, t: str, m, win, toks: list[str], dd: datetime) -> Optional[dict]:
    """Activities by resource name or activity code value; None when the question is not about a trade."""
    cts = _code_types(q)
    who = filt = None
    sel: list[Activity] = []
    if m:
        key, words = m.group(1).strip(), m.group(2).strip().split(" ")
        ct = next((c for c in cts if key == c.lower() or key.endswith(" " + c.lower())), None)
        if ct is not None:
            vals: list[str] = []
            val = words[0]
            for k in range(len(words), 0, -1):
                val = " ".join(words[:k])
                vals = [v for v in _code_values(q, ct) if val in v.lower()]
                if vals:
                    break
            if vals:
                who, filt = f"{ct} {vals[0]}", f"{ct}={vals[0]}"
                sel = [a for a in q.activities if a.codes.get(ct) in vals]
            else:
                who, filt = f"{ct} {val}", f"{ct}={val}"
        elif key.split(" ")[-1] in ("resource", "resources", "trade", "trades", "gang", "crew"):
            rs: list = []
            for k in range(len(words), 0, -1):
                val = " ".join(words[:k])
                rs = [r for r in q.resources if val in r.name.lower()]
                if rs:
                    break
            if rs:
                rid = {r.id for r in rs}
                who, filt = rs[0].name, f"resource={rs[0].name}"
                aids = {x.activity_id for x in q.assignments if x.resource_id in rid}
                sel = [a for a in q.activities if a.id in aids]
    if who is None:
        qt = [x for x in _tokens(re.sub(r"\bon site\b", " ", t)) if x not in STOP and not x.isdigit()]
        best = None   # (-score, order, kind, obj)
        for i, r in enumerate(q.resources):
            k = _score(qt, _name_tokens(r.name))
            if k and (best is None or (-k, i) < (best[0], best[1])):
                best = (-k, i, "res", r)
        n0 = len(q.resources)
        for ct in cts:
            for v in _code_values(q, ct):
                if v.lower() in ("none", ""):
                    continue
                k = _score(qt, _name_tokens(v))
                if k and (best is None or (-k, n0) < (best[0], best[1])):
                    best = (-k, n0, "code", (ct, v))
                n0 += 1
        if best is not None and best[2] == "res":
            r = best[3]
            aids = {x.activity_id for x in q.assignments if x.resource_id == r.id}
            who, filt, sel = r.name, f"resource={r.name}", [a for a in q.activities if a.id in aids]
        elif best is not None:
            ct, v = best[3]
            who, filt, sel = f"{ct} {v}", f"{ct}={v}", [a for a in q.activities if a.codes.get(ct) == v]
    if who is None:
        if win is None:
            if m is None and not re.search(r"\b(who|whose|trade|trades|gang|gangs|resource|resources|crew|crews|subcontractors?|labour)\b", t):
                return None
            names = [r.name for r in q.resources] or (_code_values(q, cts[0]) if cts else [])
            if not names:
                return _res("resources", T["res_nothing"], [], "", None, None, "low")
            qt = " ".join(x for x in toks if x not in STOP) or t
            return _res("resources", _t("res_unknown", text=qt, list=_top(names)), [], "", None, None, "low")
        if not (q.resources and q.assignments) and not cts:
            return _window_answer(q, t, win, dd)
        return _onsite(q, win, cts)
    where = ""
    if win is not None:
        ws, we, label = win
        sel = [a for a in sel if _in_window(a, ws, we)]
        where = " " + label
    sel = _by_start(q, [a for a in sel if a.type != LOE])
    if not sel:
        return _res("resources", _t("res_none", who=who, where=where), [], filt, None, None, "high")
    first = sel[0]
    last = sel[0]
    for a in sel:
        if a.finish is not None and (last.finish is None or a.finish > last.finish):
            last = a
    key = "res_one" if len(sel) == 1 else "res_head"
    text = _t(key, who=who, n=len(sel), where=where, start=_d(first.start), finish=_d(last.finish), list=_top([_label(a) for a in sel]))
    crit = [a for a in sel if a.critical]
    if crit:
        text += _t("res_crit_one" if len(crit) == 1 else "res_crit", n=len(crit))
    return _res("resources", text, [a.id for a in sel], filt, None, None, "high")


def _onsite(q: Project, win: tuple, cts: list[str]) -> dict:
    ws, we, label = win
    acts = _by_start(q, [a for a in q.activities if _in_window(a, ws, we) and _is_open(a)])
    groups: list[tuple[str, int]] = []
    if q.assignments and q.resources:
        rname = {r.id: r.name for r in q.resources}
        for a in acts:
            for x in q.assignments:
                if x.activity_id == a.id and x.resource_id in rname:
                    nm = rname[x.resource_id]
                    hit = next((g for g in groups if g[0] == nm), None)
                    if hit is None:
                        groups.append((nm, 1))
                    else:
                        groups[groups.index(hit)] = (nm, hit[1] + 1)
    elif cts:
        for a in acts:
            v = a.codes.get(cts[0])
            if v is None or v.lower() == "none":
                continue
            hit = next((g for g in groups if g[0] == v), None)
            if hit is None:
                groups.append((v, 1))
            else:
                groups[groups.index(hit)] = (v, hit[1] + 1)
    groups.sort(key=lambda g: (-g[1], g[0]))
    names = [f"{g[0]} ({_acts(g[1])})" for g in groups]
    text = _t("onsite_none", label=label) if not groups else _t("onsite", label=label, list=_top(names))
    return _res("resources", text, [a.id for a in acts], "", None, None, "high")


def _counts(q: Project, t: str, dd: datetime, dcal: Calendar) -> dict:
    acts = [a for a in q.activities if a.type != LOE]
    tasks = [a for a in acts if not a.is_milestone]
    ms = [a for a in acts if a.is_milestone]
    done = sum(1 for a in acts if a.status == Status.COMPLETE)
    prog = sum(1 for a in acts if a.status == Status.IN_PROGRESS)
    todo = len(acts) - done - prog
    pct, planned = _progress(q, dd)
    general = _t("count_all", acts=_acts(len(acts)), tasks=_count_n(len(tasks), T["task_one"], T["task_many"]),
                 ms=_count_n(len(ms), T["ms_one"], T["ms_many"]), done=done, prog=prog, todo=todo)
    days = (q.finish.date() - q.start.date()).days
    if re.search(r"\b(percent|percentage|per cent|progress|far)\b", t):
        text = _t("count_pct", pct=_n(pct), planned=_n(planned), dd=_d(dd)) + " " + general
    elif re.search(r"\b(complete|completed|finished|done)\b", t):
        text = _t("count_complete", done=done, n=len(acts), pct=_n(pct)) + " " + general
    elif re.search(r"\b(week|weeks|long|duration|month|months|take)\b", t):
        text = _t("count_length", weeks=_n(_r1(days / 7)), start=_d(q.start), finish=_d(q.finish), wd=_wd(_wdays(dcal, q.start, q.finish))) + " " + general
    elif re.search(r"\bmilestones?\b", t):
        text = general
    elif re.search(r"\bcritical\b", t):
        open_ = [a for a in acts if _is_open(a)]
        text = _t("count_critical", n=sum(1 for a in open_ if a.critical), total=len(open_)) + " " + general
    elif re.search(r"\b(links?|relationships?|logic|dependencies)\b", t):
        text = _t("count_links", n=len(acts), links=len(q.relationships)) + " " + general
    else:
        text = general + " " + _t("count_length", weeks=_n(_r1(days / 7)), start=_d(q.start), finish=_d(q.finish), wd=_wd(_wdays(dcal, q.start, q.finish)))
    return _res("counts", text, [], "", None, None, "high")


def _what_if(q: Project, t: str, a: Optional[Activity], others: str, dd: datetime, dcal: Calendar, ex: str) -> dict:
    if a is None:
        return _res("what_if", _t("which", example=ex), [], "", None, None, "low", ex)
    if a.status == Status.COMPLETE:
        return _res("what_if", _t("wi_done", label=_label(a)) + others, [a.id], "", None, a.id, "high")
    amount = _amount(t)
    assumed = amount is None
    n = 5.0 if assumed else amount
    push = bool(re.search(r"\b(start|starts|started|starting|slip|slips|slipped|delay|delayed|late|later|push|pushed|postpone|postponed|move|moved)\b", t)) \
        and not re.search(r"\b(long|longer|take|takes|took|extend|extended|duration|overrun|overruns|ran over|runs over)\b", t)
    q2 = q.model_copy(deep=True)
    x = q2.activity(a.id)
    cal = q2.calendar_for(x)
    hours = cal.days_to_hours(n)
    if push and x.status == Status.NOT_STARTED and x.early_start is not None:
        x.constraint = Constraint.START_ON_OR_AFTER
        x.constraint_date = cal.add_hours(x.early_start, hours)
    else:
        _lengthen(x, hours)
    schedule(q2)
    shift = _wdays(dcal, q.finish, q2.finish)
    key = ("wi_start" if push else "wi_dur") if shift > 0 else ("wi_same_start" if push else "wi_same_dur")
    text = _t(key, label=_label(a), wd=_wd(n), finish=_d(q2.finish), shift=_wd(shift), now=_d(q.finish))
    if q.must_finish_by is not None and shift > 0:
        m = _wdays(dcal, q2.finish, q.must_finish_by)
        if m < 0:
            text += _t("wi_miss", deadline=_d(q.must_finish_by), wd=_wd(m))
        elif m > 0:
            text += _t("wi_meet", deadline=_d(q.must_finish_by), wd=_wd(m))
        else:
            text += _t("wi_exact", deadline=_d(q.must_finish_by))
    if assumed:
        text += T["wi_assumed"]
    text += others + T["try_mode"]
    return _res("what_if", text, [a.id], "", None, a.id, "high")


def _health(q: Project) -> dict:
    rep = health_check(q)
    applicable = [c for c in rep.checks if c.applicable]
    failing = [c for c in applicable if not c.passed]
    ids: list[str] = []
    if not failing:
        text = _t("health_ok", n=len(applicable), score=rep.score)
    else:
        items = [f"{c.title}: {c.detail}" for c in failing[:4]]
        text = _t("health_fail", score=rep.score, k=len(failing), n=len(applicable), list=" ".join(items))
        if len(failing) > 4:
            text += _t("health_more", n=len(failing) - 4)
        for c in failing:
            for it in c.items:
                ids.append(it.split("->")[0])
    oos = out_of_sequence(q)
    if oos:
        text += _t("oos", acts=_acts(len(oos)), list=_top([f"{o['successor']} {o['successor_name']}" for o in oos], 3))
        ids += [o["successor"] for o in oos]
    else:
        text += T["oos_none"]
    return _res("health", text, ids, "", None, None, "high")


def _compare(q: Project, t: str, dd: datetime, dcal: Calendar) -> dict:
    revs = q.revisions or []
    periods = q.progress_periods or []
    has_base = any(a.baseline_finish is not None for a in q.activities)
    named = next((r for r in revs if r.get("name") and str(r["name"]).lower() in t), None)
    if named is None and re.search(r"\brev(ision)? [a-z0-9]+\b", t) and not re.search(r"\b(last|latest|previous|issued) rev", t):
        m = re.search(r"\brev(?:ision)? ([a-z0-9]+)\b", t)
        return _res("compare", _t("cmp_rev_missing", text="rev " + m.group(1), list=_top([str(r.get("name")) for r in revs]) or "none"), [], "", None, None, "low")
    if named is None and re.search(r"\bbaseline\b", t):
        return _compare_baseline(q, dcal, has_base)
    if named is None and re.search(r"\b(period|update|last week|last report|progress report|last month)\b", t):
        return _compare_period(q, periods, dd, dcal)
    if named is None and revs:
        named = revs[-1]
    if named is None:
        if periods:
            return _compare_period(q, periods, dd, dcal)
        if has_base:
            return _compare_baseline(q, dcal, has_base)
        return _res("compare", T["cmp_none"], [], "", None, None, "low")
    old = Project.model_validate(named["project"])
    res = compare(old, q)
    text = _t("cmp_rev", name=str(named.get("name")), text=narrative(res).replace("\n\n", " "))
    ids = [x["id"] for x in res["finish_drivers"]] + [x["id"] for x in res["date_moves"]]
    return _res("compare", text, ids, "", None, None, "high")


def _compare_baseline(q: Project, dcal: Calendar, has_base: bool) -> dict:
    if not has_base:
        return _res("compare", T["cmp_base_none"], [], "", None, None, "low")
    bf = q.baselines[-1].finish if (q.baselines and q.baselines[-1].finish is not None) else None
    if bf is None:
        bf = max(a.baseline_finish for a in q.activities if a.baseline_finish is not None)
    slips = []
    for a in q.activities:
        if a.baseline_finish is not None and a.finish is not None and a.type != LOE:
            s = _wdays(q.calendar_for(a), a.baseline_finish, a.finish)
            if s > 0:
                slips.append((s, a))
    slips.sort(key=lambda x: (-x[0], x[1].id))
    shift = _shift_text(_wdays(dcal, bf, q.finish))
    if slips:
        text = _t("cmp_base", finish=_d(q.finish), base=_d(bf), shift=shift, acts=_acts(len(slips)), list=_top([f"{_label(a)} ({_s(s)}d)" for s, a in slips], 3))
    else:
        text = _t("cmp_base_ok", finish=_d(q.finish), base=_d(bf), shift=shift)
    return _res("compare", text, [a.id for _, a in slips], "quick:late", None, None, "high")


def _compare_period(q: Project, periods: list, dd: datetime, dcal: Calendar) -> dict:
    if not periods:
        return _res("compare", T["cmp_period_none"], [], "", None, None, "low")
    last = periods[-1]
    pct, _ = _progress(q, dd)
    p1 = _n(_r1(float(last.get("pct") or 0)))
    pdd = _parse_today(last.get("data_date")) or dd
    pf = _parse_today(last.get("finish"))
    name = str(last.get("name") or "the last period")
    if pf is None:
        text = _t("cmp_period_nofinish", name=name, dd=_d(pdd), p1=p1, p2=_n(pct), now=_d(q.finish))
    else:
        text = _t("cmp_period", name=name, dd=_d(pdd), then=_d(pf), now=_d(q.finish), shift=_shift_text(_wdays(dcal, pf, q.finish)), p1=p1, p2=_n(pct))
    return _res("compare", text, [], "", None, None, "high")


def _drag(q: Project, dcal: Calendar) -> dict:
    top = [d for d in critical_drag(q) if d["drag_days"] > 0][:5]
    if not top:
        return _res("drag", T["drag_none"], [], "critical=yes", None, None, "high")
    text = _t("drag_head", list=_and([_t("drag_item", label=f"{d['id']} {d['name']}", wd=_wd(d["drag_days"])) for d in top])) + T["drag_tail"]
    return _res("drag", text, [d["id"] for d in top], "critical=yes", None, None, "high")


def _risk(q: Project, dcal: Calendar) -> dict:
    margin = ""
    if q.must_finish_by is not None:
        m = _wdays(dcal, q.finish, q.must_finish_by)
        margin = _t("risk_margin_ahead", wd=_wd(m)) if m > 0 else _t("risk_margin_behind", wd=_wd(m)) if m < 0 else ""
    return _res("risk", T["risk"] + _t("risk_fc", finish=_d(q.finish), margin=margin), [], "", None, None, "medium")

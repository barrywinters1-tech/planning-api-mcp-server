"""Briefing: the programme reports its own state in plain English, deterministically, from the schedule.

    briefing(project, *, today=None) -> dict

"today" is the project's data date (or its start) unless given, so the briefing is reproducible: the
same programme always says the same thing. The project is never mutated: a clone is scheduled when
it carries no dates. The result holds a one-sentence headline, a status, the headline figures, what
changed since the most recent of the last closed progress period / issued revision / baseline, a watch
list, the next two weeks, the actions to take next, every milestone, and the whole thing as prose
suitable for an email or a PDF cover note.

Working days are measured on the activity's own calendar (the project's default calendar for the
project finish), rounded to 1 dp with Python's round(). web/briefing.js is a line-for-line port and
must produce identical output (tests/test_briefing_parity.py).
"""
from __future__ import annotations

from datetime import date, datetime, time, timedelta
from typing import Optional

from .compare import compare
from .cpm import schedule
from .dcma import health_check
from .guardrails import critical_drag, out_of_sequence
from .model import Activity, ActivityType, Calendar, HARD_CONSTRAINTS, Project, Status

MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
EPS = 1e-6
LOOKAHEAD_DAYS = 14       # calendar days covered by "next", and by "critical and starting soon"
NEAR_DAYS = 28            # near-critical activities starting within this many calendar days
NEAR_FLOAT = 5            # working days of float that count as near-critical
THIN_MARGIN = 5           # working days to the deadline below which the programme is at risk
BEHIND_BASELINE = 5       # working days behind the baseline finish before an activity is watched
HIGH_DRAG = 5             # working days of drag before an activity is watched
LONG_DURATION = 44        # working days remaining before an open activity is watched (DCMA)
PERIOD_DUE = 21           # calendar days without a closed period before closing one is suggested
REPAIR_BELOW = 70         # health score below which the repair is suggested
RISK_FROM = 40            # open activities from which a risk run is suggested
MAX_ITEMS = 8             # since.items and watch
MAX_LIST = 10             # each list in next
MAX_ACTIONS = 5
MAX_NAMES = 5             # names in a prose list before "and N more"
WATCH_IN_PROSE = 4

# ---- every string the briefing can emit. web/briefing.js carries a verbatim copy of this table: keep the two identical. ----
T = {
    "head_on_track": "On track: forecast finish {finish}, {margin}.",
    "head_at_risk": "At risk: forecast finish {finish}, {margin}{neg}.",
    "head_at_risk_no_deadline": "At risk: forecast finish {finish}, no deadline set{neg}.",
    "head_late": "Late: forecast finish {finish}, {margin}.",
    "head_no_deadline": "Forecast finish {finish}; no deadline has been set.",
    "head_not_started": "Not started: forecast finish {finish}, {margin}.",
    "head_not_started_no_deadline": "Not started: forecast finish {finish}; no deadline has been set.",
    "head_complete": "Complete: all {n} finished, final finish {finish}.",
    "head_empty": "Not started: the programme has no activities yet.",
    "neg_clause": ", with {k} on negative float",
    "margin_inside": "{n} inside the {deadline} deadline",
    "margin_exact": "meeting the {deadline} deadline exactly",
    "margin_beyond": "{n} beyond the {deadline} deadline",
    "since_none": "No baseline, revision or closed period yet.",
    "since_period": "What changed since {name} ({date}): {parts}.",
    "since_revision": "What changed since {name} (issued {date}): {parts}.",
    "since_baseline": "Against the {name} baseline (saved {date}): {parts}.",
    "since_baseline_nodate": "Against the {name} baseline: {parts}.",
    "finish_later": "finish moved {n} later",
    "finish_earlier": "finish moved {n} earlier",
    "finish_same": "finish unchanged at {finish}",
    "finish_unrecorded": "no finish was recorded at the period",
    "finish_later_baseline": "finish {n} later than the baseline",
    "finish_earlier_baseline": "finish {n} earlier than the baseline",
    "finish_same_baseline": "finish on the baseline date of {finish}",
    "slipped": "{k} slipped",
    "progress_clause": "progress {pct}% against {was}% at the period",
    "completed_clause": "{k} completed since",
    "cnt_added": "{k} added",
    "cnt_removed": "{k} removed",
    "cnt_durations": "{k} changed",
    "cnt_links": "{k} changed",
    "cnt_constraints": "{k} changed",
    "cnt_progress": "progress updated on {k}",
    "cnt_moved": "{k} moved in date",
    "no_other_changes": "no other changes",
    "behind_clause": "{k} behind their baseline finish",
    "ahead_clause": "{k} ahead of it",
    "on_baseline": "every activity on its baseline dates",
    "item_slip": "finish moved {n} later, {old} to {new}",
    "item_behind": "finish {n} later than the baseline, {old} to {new}",
    "item_rev_moved": "finish moved {n} {dir}{changes}",
    "item_rev_same": "dates unchanged{changes}",
    "dir_later": "later",
    "dir_earlier": "earlier",
    "ch_added": "new activity",
    "ch_removed": "since removed",
    "ch_duration": "duration {delta}d",
    "ch_logic_added": "new link from {pred}",
    "ch_logic_removed": "link from {pred} removed",
    "ch_logic_changed": "link from {pred} changed",
    "ch_constraint": "constraint changed",
    "ch_progress": "progress updated",
    "ch_calendar": "calendar changed",
    "w_negative_float": "Negative float of {n}: the dates required of it cannot be met through the logic.",
    "w_critical_soon": "Critical and due to start {date}: any delay moves the finish day for day.",
    "w_near_critical": "Only {n} of float and due to start {date}.",
    "w_behind_baseline": "Running {n} behind its baseline finish of {date}.",
    "w_out_of_sequence": "Progressed out of sequence: {reason} ({pred}).",
    "w_high_drag": "Carries {n} of drag: shortening it brings the finish forward.",
    "w_constraint": "Hard constraint ({constraint}) on the critical path: the logic cannot move it.",
    "w_open_end": "Open end: no {what} drives its dates.",
    "w_long_duration": "{n} remaining in a single activity: consider splitting it so progress can be tracked.",
    "w_no_progress": "In progress with no progress recorded since {name} ({date}).",
    "what_pred": "predecessor",
    "what_succ": "successor",
    "what_both": "predecessor or successor",
    "a_set_baseline": "Set a baseline before work starts so progress can be measured against the agreed programme.",
    "a_close_period": "Close a progress period at the {date} data date so this update is kept as a record.",
    "a_close_period_first": "No progress period has been closed yet: close one at the {date} data date to start the record.",
    "a_repair": "Schedule health is {score}/100 ({fails}): run the repair.",
    "a_accelerate": "Recover {n} of negative float, starting with {act}, which carries the most drag ({drag}).",
    "a_accelerate_plain": "Recover {n} of negative float on the critical path.",
    "a_add_deadline": "Set a must-finish-by date so float is measured against the commitment.",
    "a_review_logic": "{k} progressed out of sequence: review the logic so the forecast follows how the work is actually being done.",
    "a_issue": "Issue a revision: the last one ({name}) predates {period}.",
    "a_issue_first": "Issue a revision so the programme at {period} is kept for comparison.",
    "a_run_risk": "Run the risk analysis: with {k} open, a finish range is worth having.",
    "p_kpis": "The programme is {pct}% complete against {exp}% expected at {as_of}, with {open} still open ({crit} on the critical path), {weeks} to run and a schedule health of {score}/100.",
    "p_movers": " The biggest movers: {names}.",
    "p_watch": "To watch: {items}",
    "p_watch_none": "Nothing is flagged for attention.",
    "p_watch_item": "{id} {name}: {text}",
    "p_next": "In the next two weeks ({from} to {to}): {starting} starting, {finishing} finishing, {milestones} due{ms}.",
    "p_next_none": "Nothing starts or finishes in the next two weeks ({from} to {to}).",
    "p_actions": "Next steps: {items}",
    "more": " and {n} more",
    "working_day": "working day",
    "working_days": "working days",
    "activity": "activity",
    "activities": "activities",
    "milestone": "milestone",
    "milestones": "milestones",
    "duration": "duration",
    "durations": "durations",
    "link": "link",
    "links": "links",
    "constraint": "constraint",
    "constraints": "constraints",
    "week": "week",
    "weeks": "weeks",
    "none": "no",
    "colon_list": ": {names}",
}


# ----------------------------------------------------------------------------------------
# helpers
# ----------------------------------------------------------------------------------------
def _r1(x: float) -> float:
    return round(x, 1) + 0.0          # + 0.0 turns -0.0 into 0.0 (JSON has no negative zero)


def _dt(x) -> Optional[datetime]:
    if x is None or x == "":
        return None
    if isinstance(x, datetime):
        return x
    if isinstance(x, date):
        return datetime.combine(x, time.min)
    return datetime.fromisoformat(str(x)[:19])


def _iso(d: Optional[datetime]) -> Optional[str]:
    return d.replace(microsecond=0).isoformat() if d is not None else None


def _ymd(d: datetime) -> str:
    return d.date().isoformat()


def _d(iso: str) -> str:
    return f"{int(iso[8:10])} {MONTHS[int(iso[5:7]) - 1]} {int(iso[:4])}"


def _n(x: float) -> str:
    return str(int(x)) if float(x).is_integer() else f"{x:.1f}"


def _s(x: float) -> str:
    return ("+" if x > 0 else "") + _n(x)


def _k(k: float, one: str, many: str) -> str:
    """'no activities', '1 activity', '3 activities' (k already rounded)."""
    return f"{T['none'] if k == 0 else _n(k)} {T[one] if k == 1 else T[many]}"


def _wd(x: float) -> str:
    return _k(abs(x), "working_day", "working_days")


def _and(items: list[str]) -> str:
    if len(items) <= 1:
        return "".join(items)
    return ", ".join(items[:-1]) + " and " + items[-1]


def _names(items: list[str]) -> str:
    more = len(items) - MAX_NAMES
    return _and(items[:MAX_NAMES]) + (T["more"].format(n=more) if more > 0 else "")


def _t(key: str, **kw) -> str:
    return T[key].format(**{k: ("" if v is None else v) for k, v in kw.items()})


def _scheduled(p: Project) -> Project:
    """A fresh schedule of a clone, so floats, critical flags and drag all come from the same pass
    (stored flags can be stale). A levelled programme keeps its levelled dates when it has them."""
    q = p.model_copy(deep=True)
    if not q.levelled or q.finish is None or any(a.early_start is None for a in q.activities):
        schedule(q)
    return q


def _default_cal(p: Project) -> Calendar:
    return p.calendars.get(p.default_calendar_id) or Calendar(id=p.default_calendar_id)


def _days_between(cal: Calendar, a: Optional[datetime], b: Optional[datetime]) -> Optional[float]:
    if a is None or b is None:
        return None
    return _r1(cal.hours_to_days(cal.hours_between(a, b)))


def _cal_days(a: datetime, b: datetime) -> int:
    return (b.date() - a.date()).days


def _label(a: Activity) -> str:
    return f"{a.id} {a.name}"


def _finish_clause(shift: Optional[float], finish_iso: str, same_key: str, later_key: str, earlier_key: str) -> str:
    if shift is None or shift == 0:
        return _t(same_key, finish=_d(finish_iso))
    return _t(later_key if shift > 0 else earlier_key, n=_wd(shift))


# ----------------------------------------------------------------------------------------
# progress figures
# ----------------------------------------------------------------------------------------
def _progress(p: Project, acts: list[Activity], now: datetime) -> tuple[float, float]:
    """Duration-weighted percent complete, and the percent that should be complete at `now` on the
    baseline dates (the current dates where there is no baseline). Milestone-only programmes count."""
    total = done = planned = 0.0
    n = n_done = n_due = 0
    for a in acts:
        n += 1
        s, f = (a.baseline_start, a.baseline_finish) if (a.baseline_start and a.baseline_finish) else (a.start, a.finish)
        if a.status == Status.COMPLETE:
            n_done += 1
        if f is not None and f <= now:
            n_due += 1
        w = a.duration_hours
        if w <= 0:
            continue
        total += w
        if a.status == Status.COMPLETE:
            done += w
        elif a.status == Status.IN_PROGRESS:
            done += w * a.percent_complete / 100.0
        if s is not None and f is not None:
            cal = p.calendar_for(a)
            span = cal.hours_between(s, f)
            frac = (1.0 if now >= f else 0.0) if span <= 0 else min(1.0, max(0.0, cal.hours_between(s, now) / span))
            planned += w * frac
    if total <= 0:
        return (_r1(100.0 * n_done / n), _r1(100.0 * n_due / n)) if n else (0.0, 0.0)
    return _r1(100.0 * done / total), _r1(100.0 * planned / total)


# ----------------------------------------------------------------------------------------
# since: the most recent of the last closed period, the last issued revision, or the baseline
# ----------------------------------------------------------------------------------------
def _periods(p: Project) -> list[dict]:
    out = [x for x in (p.progress_periods or []) if x.get("data_date")]
    out.sort(key=lambda x: (_iso(_dt(x["data_date"])), str(x.get("id") or "")))
    return out


def _last_period(periods: list[dict], now: datetime) -> Optional[dict]:
    """The last period closed at an earlier data date than today; failing that the last period."""
    earlier = [x for x in periods if _ymd(_dt(x["data_date"])) < _ymd(now)]
    return earlier[-1] if earlier else (periods[-1] if periods else None)


def _last_revision(p: Project) -> Optional[dict]:
    best = None
    for r in p.revisions or []:
        if best is None or (_dt(r.get("issued_at")) or datetime.min) >= (_dt(best.get("issued_at")) or datetime.min):
            best = r
    return best


def _last_baseline(p: Project, acts: list[Activity]) -> Optional[dict]:
    best = None
    for b in p.baselines or []:
        if best is None or b.saved_at >= best.saved_at:
            best = b
    if best is not None:
        return {"name": best.name, "saved_at": best.saved_at, "finish": best.finish, "dates": best.dates}
    if any(a.baseline_finish for a in acts):
        return {"name": "Baseline", "saved_at": None, "finish": None, "dates": {}}
    return None


def _change_text(c: dict) -> str:
    k = c["kind"]
    if k == "duration":
        return _t("ch_duration", delta=_s(c["delta_days"]))
    if k in ("logic_added", "logic_removed", "logic_changed"):
        return _t("ch_" + k, pred=c["pred"])
    return T["ch_" + k]


def _since(p: Project, acts: list[Activity], now: datetime, dcal: Calendar, finish: datetime,
           period: Optional[dict], pct_now: float) -> dict:
    rev, bl = _last_revision(p), _last_baseline(p, acts)
    cands = [("period", period, _dt(period.get("closed_at")) or _dt(period["data_date"])) if period else None,
             ("revision", rev, _dt(rev.get("issued_at"))) if rev else None,
             ("baseline", bl, bl["saved_at"]) if bl else None]
    pick = None
    for c in cands:
        if c is None:
            continue
        if pick is None or (c[2] is not None and (pick[2] is None or c[2] > pick[2])):
            pick = c
    if pick is None:
        return {"kind": "none", "name": None, "date": None, "finish_shift_days": None, "summary": T["since_none"], "items": []}
    kind, rec, _ = pick
    fin_iso = _iso(finish)

    if kind == "period":
        rec_finish = _dt(rec.get("finish"))
        shift = _days_between(dcal, rec_finish, finish)
        pacts = rec.get("acts") or {}
        slipped, completed = [], 0
        for a in acts:
            r = pacts.get(a.id)
            if not r:
                continue
            if r[3] != "c" and a.status == Status.COMPLETE:
                completed += 1
            slip = _days_between(p.calendar_for(a), _dt(r[1]), a.finish)
            if slip is not None and slip > 0:
                slipped.append((a, slip, r[1]))
        slipped.sort(key=lambda x: (-x[1], x[0].id))
        items = [{"id": a.id, "name": a.name, "text": _t("item_slip", n=_wd(slip), old=_d(old), new=_d(_iso(a.finish)))}
                 for a, slip, old in slipped[:MAX_ITEMS]]
        parts = [T["finish_unrecorded"] if rec_finish is None else _finish_clause(shift, fin_iso, "finish_same", "finish_later", "finish_earlier")]
        if slipped:
            parts.append(_t("slipped", k=_k(len(slipped), "activity", "activities")))
        if rec.get("pct") is not None:
            parts.append(_t("progress_clause", pct=_n(pct_now), was=_n(_r1(float(rec["pct"])))))
        if completed:
            parts.append(_t("completed_clause", k=_k(completed, "activity", "activities")))
        date_ = _iso(_dt(rec["data_date"]))
        return {"kind": kind, "name": rec.get("name"), "date": date_, "finish_shift_days": shift,
                "summary": _t("since_period", name=rec.get("name"), date=_d(date_), parts="; ".join(parts)), "items": items}

    if kind == "revision":
        res = compare(Project.model_validate(rec["project"]), p)
        s, cnt = res["summary"], res["summary"]["counts"]
        shift = s["finish_shift_days"] if s["old_finish"] != s["new_finish"] else None
        items, seen = [], set()
        for it in res["finish_drivers"]:
            if len(items) >= MAX_ITEMS:
                break
            seen.add(it["id"])
            ch = "; ".join(_change_text(c) for c in it["changes"])
            fs = it["finish_shift_days"]
            changes = f" ({ch})" if ch else ""
            text = (_t("item_rev_moved", n=_wd(fs), dir=T["dir_later" if fs > 0 else "dir_earlier"], changes=changes)
                    if fs else _t("item_rev_same", changes=changes))
            items.append({"id": it["id"], "name": it["name"], "text": text})
        for m in res["date_moves"]:
            if len(items) >= MAX_ITEMS:
                break
            fs = m["finish_shift_days"]
            if m["id"] in seen or not fs:
                continue
            seen.add(m["id"])
            items.append({"id": m["id"], "name": m["name"],
                          "text": _t("item_rev_moved", n=_wd(fs), dir=T["dir_later" if fs > 0 else "dir_earlier"], changes="")})
        parts = [_finish_clause(shift, fin_iso, "finish_same", "finish_later", "finish_earlier")]
        extra = []
        if cnt["added"]:
            extra.append(_t("cnt_added", k=_k(cnt["added"], "activity", "activities")))
        if cnt["removed"]:
            extra.append(_t("cnt_removed", k=_k(cnt["removed"], "activity", "activities")))
        if cnt["duration_changes"]:
            extra.append(_t("cnt_durations", k=_k(cnt["duration_changes"], "duration", "durations")))
        links = cnt["logic_added"] + cnt["logic_removed"] + cnt["logic_changed"]
        if links:
            extra.append(_t("cnt_links", k=_k(links, "link", "links")))
        if cnt["constraint_changes"]:
            extra.append(_t("cnt_constraints", k=_k(cnt["constraint_changes"], "constraint", "constraints")))
        if cnt["progress_changes"]:
            extra.append(_t("cnt_progress", k=_k(cnt["progress_changes"], "activity", "activities")))
        if cnt["date_moves"]:
            extra.append(_t("cnt_moved", k=_k(cnt["date_moves"], "activity", "activities")))
        parts += extra if extra else [T["no_other_changes"]]
        date_ = _iso(_dt(rec.get("issued_at")))
        return {"kind": kind, "name": rec.get("name"), "date": date_, "finish_shift_days": shift,
                "summary": _t("since_revision", name=rec.get("name"), date=_d(date_) if date_ else "", parts="; ".join(parts)), "items": items}

    # baseline
    bl_finish = _dt(rec["finish"])
    shift = _days_between(dcal, bl_finish, finish)
    behind, ahead = [], 0
    for a in acts:
        d = rec["dates"].get(a.id) or {}
        bf = _dt(d.get("finish")) or a.baseline_finish
        v = _days_between(p.calendar_for(a), bf, a.finish)
        if v is None:
            continue
        if v > 0:
            behind.append((a, v, _iso(bf)))
        elif v < 0:
            ahead += 1
    behind.sort(key=lambda x: (-x[1], x[0].id))
    items = [{"id": a.id, "name": a.name, "text": _t("item_behind", n=_wd(v), old=_d(old), new=_d(_iso(a.finish)))}
             for a, v, old in behind[:MAX_ITEMS]]
    parts = []
    if bl_finish is not None:
        parts.append(_finish_clause(shift, fin_iso, "finish_same_baseline", "finish_later_baseline", "finish_earlier_baseline"))
    if behind:
        parts.append(_t("behind_clause", k=_k(len(behind), "activity", "activities")))
    if ahead:
        parts.append(_t("ahead_clause", k=_k(ahead, "activity", "activities")))
    if not behind and not ahead:
        parts.append(T["on_baseline"])
    date_ = _iso(rec["saved_at"])
    summary = (_t("since_baseline", name=rec["name"], date=_d(date_), parts="; ".join(parts)) if date_
               else _t("since_baseline_nodate", name=rec["name"], parts="; ".join(parts)))
    return {"kind": kind, "name": rec["name"], "date": date_, "finish_shift_days": shift, "summary": summary, "items": items}


# ----------------------------------------------------------------------------------------
# briefing
# ----------------------------------------------------------------------------------------
def briefing(project: Project, *, today=None) -> dict:
    p = _scheduled(project)
    dcal = _default_cal(p)
    now = _dt(today) or p.data_date or p.start
    acts = [a for a in p.activities if a.type != ActivityType.LOE]
    open_ = [a for a in acts if a.status != Status.COMPLETE]
    started = [a for a in acts if a.status != Status.NOT_STARTED]
    finish = p.finish or p.start
    fin_iso = _iso(finish)
    deadline = p.must_finish_by
    spare = _days_between(dcal, finish, deadline) if deadline is not None else None
    neg = [a for a in open_ if a.total_float_hours is not None and a.total_float_hours < -EPS]
    report = health_check(p) if acts else None
    drag = critical_drag(p) if open_ else []
    oos = out_of_sequence(p)
    pct_now, pct_exp = _progress(p, acts, now)
    periods = _periods(p)
    period = _last_period(periods, now)
    period_before = period if period and _ymd(_dt(period["data_date"])) < _ymd(now) else None

    # ---- status and headline ----
    if not acts:
        status = "not_started"
    elif not open_:
        status = "complete"
    elif spare is not None and spare < 0:
        status = "late"
    elif not started:
        status = "not_started"
    elif spare is None:
        status = "at_risk" if neg else "no_deadline"
    elif spare < THIN_MARGIN or neg:
        status = "at_risk"
    else:
        status = "on_track"

    def margin() -> str:
        if spare > 0:
            return _t("margin_inside", n=_wd(spare), deadline=_d(_iso(deadline)))
        if spare < 0:
            return _t("margin_beyond", n=_wd(spare), deadline=_d(_iso(deadline)))
        return _t("margin_exact", deadline=_d(_iso(deadline)))

    neg_clause = _t("neg_clause", k=_k(len(neg), "activity", "activities")) if neg else ""
    fd = _d(fin_iso)
    if not acts:
        headline = T["head_empty"]
    elif status == "complete":
        headline = _t("head_complete", n=_k(len(acts), "activity", "activities"), finish=fd)
    elif status == "late":
        headline = _t("head_late", finish=fd, margin=margin())
    elif status == "not_started":
        headline = _t("head_not_started", finish=fd, margin=margin()) if spare is not None else _t("head_not_started_no_deadline", finish=fd)
    elif status == "at_risk":
        headline = _t("head_at_risk", finish=fd, margin=margin(), neg=neg_clause) if spare is not None else _t("head_at_risk_no_deadline", finish=fd, neg=neg_clause)
    elif status == "no_deadline":
        headline = _t("head_no_deadline", finish=fd)
    else:
        headline = _t("head_on_track", finish=fd, margin=margin())

    kpis = {
        "finish": fin_iso, "deadline": _iso(deadline), "spare_days": spare,
        "pct_complete": pct_now, "pct_expected": pct_exp,
        "critical_open": sum(1 for a in open_ if a.critical),
        "health_score": int(report.score) if report else None,
        "activities_open": len(open_),
        "weeks_remaining": _r1(max(0, _cal_days(now, finish)) / 7.0),
    }

    since = _since(p, acts, now, dcal, finish, period, pct_now)

    # ---- watch ----
    watch: dict[str, dict] = {}

    def flag(a: Activity, reason: str, text: str, severity: int) -> None:
        w = watch.get(a.id)
        if w is None:
            w = watch[a.id] = {"id": a.id, "name": a.name, "reason": reason, "texts": [], "severity": severity, "date": _iso(a.start) or ""}
        if severity > w["severity"]:
            w["severity"], w["reason"] = severity, reason
        w["texts"].append(text)

    oos_by: dict[str, list] = {}
    for x in oos:
        oos_by.setdefault(x["successor"], []).append(x)
    drag_by = {d["id"]: d for d in drag}
    open_ends = set(next((c.items for c in report.checks if c.key == "logic"), [])) if report else set()
    pacts = (period_before.get("acts") or {}) if period_before else {}
    for a in open_:
        cal = p.calendar_for(a)
        tf = cal.hours_to_days(a.total_float_hours) if a.total_float_hours is not None else None
        to_start = _cal_days(now, a.start) if a.start else None
        if a.total_float_hours is not None and a.total_float_hours < -EPS:
            flag(a, "negative_float", _t("w_negative_float", n=_wd(_r1(-tf))), 3)
        if a.critical and a.status == Status.NOT_STARTED and to_start is not None and 0 <= to_start <= LOOKAHEAD_DAYS:
            flag(a, "critical_soon", _t("w_critical_soon", date=_d(_iso(a.start))), 3)
        for x in oos_by.get(a.id, []):
            flag(a, "out_of_sequence", _t("w_out_of_sequence", reason=x["reason"], pred=x["predecessor"]), 2)
        if a.baseline_finish is not None and a.finish is not None:
            v = _days_between(cal, a.baseline_finish, a.finish)
            if v > BEHIND_BASELINE:
                flag(a, "behind_baseline", _t("w_behind_baseline", n=_wd(v), date=_d(_iso(a.baseline_finish))), 2)
        d = drag_by.get(a.id)
        if d is not None and d["drag_days"] >= HIGH_DRAG:
            flag(a, "high_drag", _t("w_high_drag", n=_wd(d["drag_days"])), 2)
        if (not a.critical and tf is not None and -EPS <= tf <= NEAR_FLOAT and a.status == Status.NOT_STARTED
                and to_start is not None and 0 <= to_start <= NEAR_DAYS):
            flag(a, "near_critical", _t("w_near_critical", n=_wd(_r1(tf)), date=_d(_iso(a.start))), 1)
        if a.critical and a.constraint in HARD_CONSTRAINTS:
            flag(a, "constraint", _t("w_constraint", constraint=a.constraint.value.replace("_", " ")), 1)
        r = pacts.get(a.id)
        if a.status == Status.IN_PROGRESS and r and r[3] == "p" and round(a.percent_complete) <= r[2]:
            flag(a, "no_progress", _t("w_no_progress", name=period_before.get("name"), date=_d(_iso(_dt(period_before["data_date"])))), 1)
        if a.id in open_ends:
            has_pred, has_succ = bool(p.predecessors_of(a.id)), bool(p.successors_of(a.id))
            what = T["what_both"] if not has_pred and not has_succ else T["what_pred"] if not has_pred else T["what_succ"]
            flag(a, "open_end", _t("w_open_end", what=what), 1)
        if not a.is_milestone:
            rem = a.remaining_hours if a.remaining_hours is not None else a.duration_hours
            if cal.hours_to_days(rem) > LONG_DURATION:
                flag(a, "long_duration", _t("w_long_duration", n=_wd(_r1(cal.hours_to_days(rem)))), 1)
    watch_list = sorted(watch.values(), key=lambda w: (-w["severity"], w["date"], w["id"]))[:MAX_ITEMS]
    watch_out = [{"id": w["id"], "name": w["name"], "reason": w["reason"], "text": " ".join(w["texts"]), "severity": w["severity"]} for w in watch_list]

    # ---- next two weeks ----
    w_from, w_to = now.date(), now.date() + timedelta(days=LOOKAHEAD_DAYS)
    starting, finishing, due = [], [], []
    for a in acts:
        if a.is_milestone:
            d0 = a.finish or a.start
            if a.status != Status.COMPLETE and d0 is not None and w_from <= d0.date() <= w_to:
                due.append({"id": a.id, "name": a.name, "date": _iso(d0)})
            continue
        if a.status == Status.NOT_STARTED and a.start is not None and w_from <= a.start.date() <= w_to:
            starting.append({"id": a.id, "name": a.name, "date": _iso(a.start)})
        if a.status != Status.COMPLETE and a.finish is not None and w_from <= a.finish.date() <= w_to:
            finishing.append({"id": a.id, "name": a.name, "date": _iso(a.finish)})
    for lst in (starting, finishing, due):
        lst.sort(key=lambda x: (x["date"], x["id"]))
    nxt = {"from": w_from.isoformat(), "to": w_to.isoformat(), "starting": starting[:MAX_LIST], "finishing": finishing[:MAX_LIST], "milestones": due[:MAX_LIST]}

    # ---- actions ----
    actions: list[dict] = []
    has_baseline = bool(p.baselines) or any(a.baseline_finish for a in acts)
    if acts and not started and not has_baseline:
        actions.append({"kind": "set_baseline", "text": T["a_set_baseline"]})
    in_progress = any(a.status == Status.IN_PROGRESS for a in acts)
    last_any = periods[-1] if periods else None
    if in_progress and (last_any is None or _cal_days(_dt(last_any["data_date"]), now) > PERIOD_DUE):
        actions.append({"kind": "close_period", "text": _t("a_close_period" if last_any else "a_close_period_first", date=_d(_iso(now)))})
    if report and report.score < REPAIR_BELOW:
        fails = [c.title for c in report.failing()]
        actions.append({"kind": "repair", "text": _t("a_repair", score=int(report.score), fails=_names(fails))})
    if neg:
        # the days to recover: the deadline shortfall when late, otherwise the deepest negative float
        worst = -spare if spare is not None and spare < 0 else max(_r1(-p.calendar_for(a).hours_to_days(a.total_float_hours)) for a in neg)
        top = drag[0] if drag and drag[0]["drag_days"] > 0 else None
        actions.append({"kind": "accelerate", "text": _t("a_accelerate", n=_wd(worst), act=f"{top['id']} {top['name']}", drag=_wd(top["drag_days"]))
                        if top else _t("a_accelerate_plain", n=_wd(worst))})
    if deadline is None and acts:
        actions.append({"kind": "add_deadline", "text": T["a_add_deadline"]})
    if oos:
        actions.append({"kind": "review_logic", "text": _t("a_review_logic", k=_k(len(oos_by), "activity", "activities"))})
    if last_any is not None:
        rev = _last_revision(p)
        closed = _dt(last_any.get("closed_at")) or _dt(last_any["data_date"])
        issued = _dt(rev.get("issued_at")) if rev else None
        if rev is None or issued is None or issued < closed:
            actions.append({"kind": "issue", "text": _t("a_issue", name=rev.get("name"), period=last_any.get("name")) if rev
                            else _t("a_issue_first", period=last_any.get("name"))})
    if getattr(p, "risk", None) is None and len(open_) >= RISK_FROM:
        actions.append({"kind": "run_risk", "text": _t("a_run_risk", k=_k(len(open_), "activity", "activities"))})
    actions = actions[:MAX_ACTIONS]

    # ---- milestones ----
    ms = []
    for a in acts:
        if not a.is_milestone:
            continue
        d0 = a.finish or a.start
        b0 = a.baseline_finish or a.baseline_start
        ms.append({"id": a.id, "name": a.name, "date": _iso(d0), "baseline_date": _iso(b0),
                   "variance_days": _days_between(p.calendar_for(a), b0, d0), "status": a.status.value})
    ms.sort(key=lambda x: (x["date"] or "", x["id"]))

    # ---- prose ----
    paras: list[str] = []
    p1 = [headline]
    if acts and status != "complete":
        p1.append(_t("p_kpis", pct=_n(pct_now), exp=_n(pct_exp), as_of=_d(_ymd(now)), open=_k(len(open_), "activity", "activities"),
                     crit=kpis["critical_open"], weeks=_k(kpis["weeks_remaining"], "week", "weeks"), score=kpis["health_score"]))
    if since["kind"] == "none":
        p1.append(since["summary"])
    paras.append(" ".join(p1))
    if since["kind"] != "none":
        paras.append(since["summary"] + (_t("p_movers", names=_names([f"{i['id']} {i['name']}" for i in since["items"]])) if since["items"] else ""))
    p3 = [_t("p_watch", items=" ".join(_t("p_watch_item", id=w["id"], name=w["name"], text=w["text"]) for w in watch_out[:WATCH_IN_PROSE]))
          if watch_out else T["p_watch_none"]]
    if starting or finishing or due:
        p3.append(_t("p_next", **{"from": _d(nxt["from"]), "to": _d(nxt["to"]), "starting": _k(len(starting), "activity", "activities"),
                                  "finishing": _k(len(finishing), "activity", "activities"), "milestones": _k(len(due), "milestone", "milestones"),
                                  "ms": _t("colon_list", names=_names([f"{m['id']} {m['name']} ({_d(m['date'])})" for m in due])) if due else ""}))
    else:
        p3.append(_t("p_next_none", **{"from": _d(nxt["from"]), "to": _d(nxt["to"])}))
    paras.append(" ".join(p3))
    if actions:
        paras.append(_t("p_actions", items=" ".join(a["text"] for a in actions)))

    return {
        "as_of": _ymd(now),
        "headline": headline,
        "status": status,
        "kpis": kpis,
        "since": since,
        "watch": watch_out,
        "next": nxt,
        "actions": actions,
        "milestones": ms,
        "prose": "\n\n".join(paras),
    }

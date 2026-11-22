"""Schedule health checks: the DCMA 14-point assessment and the CIOB Planning Protocol 2021 check set.

Every check returns a `Check` with pass/fail, the measured value, the threshold and
the offending activity ids so the UI (or the AI) can act on it.

health_check(project, check_set="dcma" | "pp21", thresholds=None): the set's default thresholds
(DCMA_THRESHOLDS / PP21_THRESHOLDS) are overridden by Project.check_thresholds (a planner's saved edits)
and then by the `thresholds` argument; the effective values are returned on the report. The score is the
share of applicable checks that pass, 0-100, for either set. web/engine.js healthCheck() is the same code.

DCMA set (check keys and threshold keys)
  logic (logic_pct 5), leads (leads_pct 0), lags (lags_pct 5), rel_types (fs_pct 90), hard_constraints
  (hard_constraints_pct 5), high_float (high_float_days 44, high_float_pct 5), negative_float, high_duration
  (high_duration_days 44, high_duration_pct 5), invalid_dates, resources, missed_tasks (missed_pct 5), cp_test,
  cpli (cpli_min 0.95), bei (bei_min 0.95), plus the planner's open_ends and dangling checks.

CIOB Planning Protocol 2021 set (check keys, threshold keys and the rationale behind each)
  pp21_duration (max_duration_days 44, duration_pct 0): PP21 caps a task at the reporting cycle times a few, 44
      working days (two months), so progress can be measured rather than estimated; remaining duration is used.
  pp21_open_ends (open_ends_pct 0): every activity but the start and finish has a predecessor and a successor, so
      the critical path and float are real; PP21 allows none, where DCMA allows 5%.
  pp21_negative_float: negative float means the programme already misses a date; it must be resolved, not reported.
  pp21_leads: negative lag makes a successor start before its predecessor's logic is complete; PP21 bars leads.
  pp21_lags (lag_pct 20): a lag is a hidden activity; PP21 allows one no longer than a fifth of the successor it
      delays, so long lags (curing, approvals) are modelled as activities instead. A lag into a milestone fails.
  pp21_logic_density (density_min 1, density_max 4): links per activity between 1 and 4 on average; below it the
      network is under-linked, above it is over-constrained and brittle to change.
  pp21_constraints (constraints_pct 5): any date constraint (soft or hard) overrides logic; at most 5% of the
      incomplete activities may carry one.
  pp21_milestones: every milestone is linked (a start milestone has a successor, a finish milestone a predecessor),
      so key dates move with the work.
  pp21_progress: progress is consistent with the data date: no actual date after it, no remaining work before it,
      in-progress activities have an actual start and complete ones an actual finish.
  pp21_critical_path: a critical path exists and ends at the programme finish, so the longest path is the one
      driving completion.
  pp21_calendars (max_working_days 7): every calendar has between one and seven working days a week and more than
      zero (and at most 24) hours a day; anything else is a data error that silently changes durations.
"""
from __future__ import annotations

import copy
from datetime import timedelta
from typing import Optional

from pydantic import BaseModel, Field

from .cpm import schedule, ScheduleError, sched_calendar
from .model import ActivityType, Constraint, HARD_CONSTRAINTS, LinkType, Project, Status

HIGH_FLOAT_DAYS = 44
HIGH_DURATION_DAYS = 44

CHECK_SETS = ("dcma", "pp21")
DCMA_THRESHOLDS = {"logic_pct": 5, "leads_pct": 0, "lags_pct": 5, "fs_pct": 90, "hard_constraints_pct": 5,
                   "high_float_days": HIGH_FLOAT_DAYS, "high_float_pct": 5, "high_duration_days": HIGH_DURATION_DAYS,
                   "high_duration_pct": 5, "missed_pct": 5, "cpli_min": 0.95, "bei_min": 0.95}
PP21_THRESHOLDS = {"max_duration_days": 44, "duration_pct": 0, "open_ends_pct": 0, "lag_pct": 20, "density_min": 1,
                   "density_max": 4, "constraints_pct": 5, "max_working_days": 7}


class Check(BaseModel):
    key: str
    title: str
    passed: bool
    value: Optional[float] = None
    threshold: Optional[str] = None
    detail: str = ""
    items: list[str] = Field(default_factory=list)
    applicable: bool = True


class HealthReport(BaseModel):
    score: int  # 0-100
    checks: list[Check]
    summary: str
    check_set: str = "dcma"
    thresholds: dict = Field(default_factory=dict)   # the effective thresholds the checks were run with

    def failing(self) -> list[Check]:
        return [c for c in self.checks if c.applicable and not c.passed]


def _pct(n: int, d: int) -> float:
    return round(100.0 * n / d, 1) if d else 0.0


def _g(x) -> str:
    """A threshold as text: 5 -> "5", 2.5 -> "2.5", 0.95 -> "0.95" (Python's :g; web/engine.js pyG)."""
    return f"{float(x):g}"


def _within(count: int, total: int, pct_threshold) -> bool:
    """count is within pct_threshold % of total; a zero threshold means none at all (not a rounded 0.0%)."""
    return count == 0 if pct_threshold <= 0 else _pct(count, total) <= pct_threshold


def check_thresholds(project: Project, check_set: str = "dcma", thresholds: Optional[dict] = None) -> dict:
    """The effective thresholds: the set's defaults, then Project.check_thresholds, then the argument."""
    out = dict(PP21_THRESHOLDS if check_set == "pp21" else DCMA_THRESHOLDS)
    for src in (project.check_thresholds, thresholds):
        for k, v in (src or {}).items():
            if v is not None and k in out:
                out[k] = v
    return out


def health_check(project: Project, check_set: str = "dcma", thresholds: Optional[dict] = None) -> HealthReport:
    check_set = check_set if check_set in CHECK_SETS else "dcma"
    th = check_thresholds(project, check_set, thresholds)
    checks = _pp21_checks(project, th) if check_set == "pp21" else _dcma_checks(project, th)
    applicable = [c for c in checks if c.applicable]
    score = int(round(100 * sum(1 for c in applicable if c.passed) / len(applicable))) if applicable else 100
    fails = [c.title for c in applicable if not c.passed]
    summary = "Schedule passes all applicable checks." if not fails else "Failing: " + ", ".join(fails) + "."
    return HealthReport(score=score, checks=checks, summary=summary, check_set=check_set, thresholds=th)


def _dcma_checks(project: Project, th: dict) -> list[Check]:
    checks: list[Check] = []
    acts = [a for a in project.activities if a.type != ActivityType.LOE]
    incomplete = [a for a in acts if a.status != Status.COMPLETE]
    n_inc = len(incomplete)
    data_date = project.data_date or project.start

    # 1 Logic
    missing = _missing_logic(project, incomplete)
    p = _pct(len(missing), n_inc)
    checks.append(Check(key="logic", title="Missing logic", passed=_within(len(missing), n_inc, th["logic_pct"]), value=p,
                        threshold=f"≤ {_g(th['logic_pct'])}%",
                        detail=f"{len(missing)} of {n_inc} incomplete activities lack a predecessor or successor.",
                        items=missing))

    # 2 Leads
    leads = [f"{r.predecessor_id}->{r.successor_id}" for r in project.relationships if r.lag_hours < 0]
    p = _pct(len(leads), len(project.relationships))
    checks.append(Check(key="leads", title="Leads (negative lag)", passed=_within(len(leads), len(project.relationships), th["leads_pct"]),
                        value=p, threshold=f"{_g(th['leads_pct'])}%" if th["leads_pct"] <= 0 else f"≤ {_g(th['leads_pct'])}%",
                        detail=f"{len(leads)} relationships use negative lag.", items=leads))

    # 3 Lags
    lags = [f"{r.predecessor_id}->{r.successor_id}" for r in project.relationships if r.lag_hours > 0]
    p = _pct(len(lags), len(project.relationships))
    checks.append(Check(key="lags", title="Lags", passed=_within(len(lags), len(project.relationships), th["lags_pct"]), value=p,
                        threshold=f"≤ {_g(th['lags_pct'])}%",
                        detail=f"{len(lags)} of {len(project.relationships)} relationships carry positive lag.", items=lags))

    # 4 Relationship types
    fs = sum(1 for r in project.relationships if r.type == LinkType.FS)
    p = _pct(fs, len(project.relationships))
    checks.append(Check(key="rel_types", title="Finish-to-start share", passed=p >= th["fs_pct"] or not project.relationships,
                        value=p, threshold=f"≥ {_g(th['fs_pct'])}%", detail=f"{fs} of {len(project.relationships)} links are FS."))

    # 5 Hard constraints
    hard = [a.id for a in incomplete if a.constraint in HARD_CONSTRAINTS]
    p = _pct(len(hard), n_inc)
    checks.append(Check(key="hard_constraints", title="Hard constraints", passed=_within(len(hard), n_inc, th["hard_constraints_pct"]),
                        value=p, threshold=f"≤ {_g(th['hard_constraints_pct'])}%",
                        detail=f"{len(hard)} incomplete activities have must-start/finish-on constraints.", items=hard))

    # 6 High float
    hf = []
    for a in incomplete:
        cal = project.calendar_for(a)
        if a.total_float_hours is not None and cal.hours_to_days(a.total_float_hours) > th["high_float_days"]:
            hf.append(a.id)
    p = _pct(len(hf), n_inc)
    checks.append(Check(key="high_float", title="High float", passed=_within(len(hf), n_inc, th["high_float_pct"]), value=p,
                        threshold=f"≤ {_g(th['high_float_pct'])}%",
                        detail=f"{len(hf)} incomplete activities have more than {_g(th['high_float_days'])} days total float.", items=hf))

    # 7 Negative float
    nf = _negative_float(incomplete)
    checks.append(Check(key="negative_float", title="Negative float", passed=not nf, value=float(len(nf)), threshold="0",
                        detail=f"{len(nf)} activities have negative total float.", items=nf))

    # 8 High duration
    hd = _long_tasks(project, incomplete, th["high_duration_days"])
    p = _pct(len(hd), n_inc)
    checks.append(Check(key="high_duration", title="High duration", passed=_within(len(hd), n_inc, th["high_duration_pct"]), value=p,
                        threshold=f"≤ {_g(th['high_duration_pct'])}%",
                        detail=f"{len(hd)} incomplete activities are longer than {_g(th['high_duration_days'])} working days.", items=hd))

    # 9 Invalid dates
    bad = []
    for a in acts:
        if a.status == Status.NOT_STARTED and a.early_start and a.early_start < data_date:
            bad.append(a.id)
        if a.actual_start and a.actual_start > data_date:
            bad.append(a.id)
        if a.actual_finish and a.actual_finish > data_date:
            bad.append(a.id)
        if a.status == Status.COMPLETE and not a.actual_finish:
            bad.append(a.id)
    bad = sorted(set(bad))
    checks.append(Check(key="invalid_dates", title="Invalid dates", passed=not bad, value=float(len(bad)), threshold="0",
                        detail=f"{len(bad)} activities have forecast dates before, or actual dates after, the data date.", items=bad))

    # 10 Resources
    assigned = {x.activity_id for x in project.assignments}
    unres = [a.id for a in incomplete if not a.is_milestone and a.duration_hours > 0 and a.id not in assigned]
    checks.append(Check(key="resources", title="Unresourced activities", passed=not unres, value=_pct(len(unres), n_inc),
                        threshold="0% (informational)", applicable=bool(project.resources),
                        detail=f"{len(unres)} activities with duration have no resource assigned.", items=unres))

    # 11 Missed tasks (needs baseline)
    baselined = [a for a in acts if a.baseline_finish]
    missed = [a.id for a in baselined if a.baseline_finish <= data_date and
              (a.status != Status.COMPLETE or (a.actual_finish and a.actual_finish > a.baseline_finish))]
    due = [a for a in baselined if a.baseline_finish <= data_date]
    p = _pct(len(missed), len(due))
    checks.append(Check(key="missed_tasks", title="Missed tasks", passed=_within(len(missed), len(due), th["missed_pct"]), value=p,
                        threshold=f"≤ {_g(th['missed_pct'])}%",
                        applicable=bool(baselined), detail=f"{len(missed)} of {len(due)} baseline-due activities missed their finish.",
                        items=missed))

    # 12 Critical path test
    cp_ok, cp_detail = _critical_path_test(project)
    checks.append(Check(key="cp_test", title="Critical path test", passed=cp_ok, threshold="finish moves with critical delay",
                        detail=cp_detail, applicable=n_inc > 0))

    # 13 CPLI
    if project.must_finish_by and project.finish:
        cal = project.ensure_default_calendar()
        cpl = cal.hours_between(data_date, project.finish)
        tf = cal.hours_between(project.finish, project.must_finish_by)
        cpli = round((cpl + tf) / cpl, 2) if cpl > 0 else 1.0
        checks.append(Check(key="cpli", title="Critical path length index", passed=cpli >= th["cpli_min"], value=cpli,
                            threshold=f"≥ {_g(th['cpli_min'])}",
                            detail=f"Critical path {cal.hours_to_days(cpl):.0f}d, float to must-finish {cal.hours_to_days(tf):.0f}d."))
    else:
        checks.append(Check(key="cpli", title="Critical path length index", passed=True, applicable=False,
                            detail="Set a must-finish-by date to compute CPLI."))

    # 14 BEI
    planned_done = [a for a in baselined if a.baseline_finish <= data_date]
    actually_done = [a for a in acts if a.status == Status.COMPLETE]
    if planned_done:
        bei = round(len(actually_done) / len(planned_done), 2)
        checks.append(Check(key="bei", title="Baseline execution index", passed=bei >= th["bei_min"], value=bei,
                            threshold=f"≥ {_g(th['bei_min'])}",
                            detail=f"{len(actually_done)} complete vs {len(planned_done)} planned complete by data date."))
    else:
        checks.append(Check(key="bei", title="Baseline execution index", passed=True, applicable=False,
                            detail="Needs a baseline with activities due by the data date."))

    # --- extra planner checks -------------------------------------------------
    starts = [a.id for a in incomplete if not project.predecessors_of(a.id)]
    finishes = [a.id for a in incomplete if not project.successors_of(a.id)]
    checks.append(Check(key="open_ends", title="Single start and finish", passed=len(starts) <= 1 and len(finishes) <= 1,
                        value=float(len(starts) + len(finishes)), threshold="1 start, 1 finish",
                        detail=f"{len(starts)} activities have no predecessor, {len(finishes)} have no successor.",
                        items=sorted(set(starts + finishes))))
    dangling = []
    for a in incomplete:
        if a.is_milestone:
            continue
        outs = project.successors_of(a.id)
        if outs and all(r.type == LinkType.SS for r in outs):
            dangling.append(a.id)
        ins = project.predecessors_of(a.id)
        if ins and all(r.type == LinkType.FF for r in ins):
            dangling.append(a.id)
    dangling = sorted(set(dangling))
    checks.append(Check(key="dangling", title="Dangling logic", passed=not dangling, value=float(len(dangling)), threshold="0",
                        detail=f"{len(dangling)} activities only drive successors by their start, or are only driven on their finish.",
                        items=dangling))
    return checks


def _pp21_checks(project: Project, th: dict) -> list[Check]:
    checks: list[Check] = []
    acts = [a for a in project.activities if a.type != ActivityType.LOE]
    incomplete = [a for a in acts if a.status != Status.COMPLETE]
    n_inc = len(incomplete)
    n_rel = len(project.relationships)
    amap = project.activity_map()
    data_date = project.data_date or project.start

    # 1 Task duration
    hd = _long_tasks(project, incomplete, th["max_duration_days"])
    checks.append(Check(key="pp21_duration", title="Task duration", passed=_within(len(hd), n_inc, th["duration_pct"]),
                        value=_pct(len(hd), n_inc), threshold=f"≤ {_g(th['max_duration_days'])} working days ({_g(th['duration_pct'])}% may exceed)",
                        detail=f"{len(hd)} of {n_inc} incomplete tasks are longer than {_g(th['max_duration_days'])} working days.", items=hd))

    # 2 Open ends
    missing = _missing_logic(project, incomplete)
    checks.append(Check(key="pp21_open_ends", title="Open ends", passed=_within(len(missing), n_inc, th["open_ends_pct"]),
                        value=_pct(len(missing), n_inc), threshold=f"≤ {_g(th['open_ends_pct'])}%",
                        detail=f"{len(missing)} of {n_inc} incomplete activities lack a predecessor or successor.", items=missing))

    # 3 Negative float
    nf = _negative_float(incomplete)
    checks.append(Check(key="pp21_negative_float", title="Negative float", passed=not nf, value=float(len(nf)), threshold="0",
                        detail=f"{len(nf)} activities have negative total float.", items=nf))

    # 4 Leads
    leads = [f"{r.predecessor_id}->{r.successor_id}" for r in project.relationships if r.lag_hours < 0]
    checks.append(Check(key="pp21_leads", title="Leads (negative lag)", passed=not leads, value=float(len(leads)), threshold="0",
                        detail=f"{len(leads)} relationships use negative lag.", items=leads))

    # 5 Lag length: no lag longer than lag_pct of the successor's duration (a lag into a milestone always exceeds it)
    long_lags = []
    for r in project.relationships:
        s = amap.get(r.successor_id)
        if r.lag_hours > 0 and s is not None and r.lag_hours > th["lag_pct"] / 100.0 * s.duration_hours + 1e-9:
            long_lags.append(f"{r.predecessor_id}->{r.successor_id}")
    checks.append(Check(key="pp21_lags", title="Lag length", passed=not long_lags, value=_pct(len(long_lags), n_rel),
                        threshold=f"lag ≤ {_g(th['lag_pct'])}% of successor duration",
                        detail=f"{len(long_lags)} of {n_rel} relationships carry a lag longer than {_g(th['lag_pct'])}% of their successor.",
                        items=long_lags))

    # 6 Logic density
    density = round(n_rel / len(acts), 2) if acts else 0.0
    checks.append(Check(key="pp21_logic_density", title="Logic density", passed=th["density_min"] <= density <= th["density_max"],
                        value=density, threshold=f"{_g(th['density_min'])} to {_g(th['density_max'])} links per activity",
                        applicable=bool(acts), detail=f"{n_rel} relationships over {len(acts)} activities: {_g(density)} per activity."))

    # 7 Constraints (any date constraint)
    con = [a.id for a in incomplete if a.constraint != Constraint.NONE]
    checks.append(Check(key="pp21_constraints", title="Constraints", passed=_within(len(con), n_inc, th["constraints_pct"]),
                        value=_pct(len(con), n_inc), threshold=f"≤ {_g(th['constraints_pct'])}%",
                        detail=f"{len(con)} of {n_inc} incomplete activities carry a date constraint.", items=con))

    # 8 Milestones linked
    ms_bad = []
    for a in incomplete:
        if a.type == ActivityType.START_MILESTONE and not project.successors_of(a.id):
            ms_bad.append(a.id)
        elif a.type == ActivityType.FINISH_MILESTONE and not project.predecessors_of(a.id):
            ms_bad.append(a.id)
    n_ms = sum(1 for a in incomplete if a.is_milestone)
    checks.append(Check(key="pp21_milestones", title="Milestones linked", passed=not ms_bad, value=float(len(ms_bad)), threshold="0",
                        applicable=n_ms > 0, detail=f"{len(ms_bad)} of {n_ms} milestones are not linked to the work.", items=ms_bad))

    # 9 Progress consistent with the data date
    bad = []
    for a in acts:
        if a.actual_start and a.actual_start > data_date:
            bad.append(a.id)
        if a.actual_finish and a.actual_finish > data_date:
            bad.append(a.id)
        if a.status == Status.NOT_STARTED and a.early_start and a.early_start < data_date:
            bad.append(a.id)
        if a.status == Status.IN_PROGRESS and (not a.actual_start or (a.early_finish and a.early_finish < data_date)):
            bad.append(a.id)
        if a.status == Status.COMPLETE and not a.actual_finish:
            bad.append(a.id)
    bad = sorted(set(bad))
    checks.append(Check(key="pp21_progress", title="Progress consistent", passed=not bad, value=float(len(bad)), threshold="0",
                        detail=f"{len(bad)} activities have actual dates after, or remaining work before, the data date.", items=bad))

    # 10 Critical path exists and ends at the finish
    open_acts = [a for a in incomplete if a.early_finish]
    crit = [a for a in open_acts if a.critical]
    if open_acts:
        end = max(a.early_finish for a in open_acts)
        at_end = [a.id for a in crit if a.early_finish >= end]
        ok = bool(crit) and bool(at_end)
        detail = (f"{len(crit)} critical activities; the path ends at the finish ({', '.join(at_end[:5])})." if ok
                  else "No critical activity ends at the programme finish." if crit else "No critical path.")
    else:
        ok, at_end, detail = True, [], "No open activities."
    checks.append(Check(key="pp21_critical_path", title="Critical path", passed=ok, value=float(len(crit)),
                        threshold="exists, ends at the finish", applicable=bool(open_acts), detail=detail, items=at_end))

    # 11 Calendars sensible
    cal_bad = []
    for cid in sorted(project.calendars):
        c = project.calendars[cid]
        wd = {d for d in c.working_days if 0 <= d <= 6}
        if not (0 < c.hours_per_day <= 24) or not wd or len(wd) > th["max_working_days"] or len(wd) != len(c.working_days):
            cal_bad.append(cid)
    checks.append(Check(key="pp21_calendars", title="Calendars", passed=not cal_bad, value=float(len(cal_bad)),
                        threshold=f"1 to {_g(th['max_working_days'])} working days, 0 to 24 hours",
                        applicable=bool(project.calendars),
                        detail=f"{len(cal_bad)} of {len(project.calendars)} calendars have an impossible working week or day.", items=cal_bad))
    return checks


def _missing_logic(project: Project, incomplete) -> list[str]:
    missing = []
    for a in incomplete:
        has_pred = bool(project.predecessors_of(a.id)) or a.type == ActivityType.START_MILESTONE
        has_succ = bool(project.successors_of(a.id)) or a.type == ActivityType.FINISH_MILESTONE
        if not (has_pred and has_succ):
            missing.append(a.id)
    return missing


def _negative_float(incomplete) -> list[str]:
    return [a.id for a in incomplete if a.total_float_hours is not None and a.total_float_hours < -1e-6]


def _long_tasks(project: Project, incomplete, max_days) -> list[str]:
    """Incomplete tasks whose remaining duration exceeds max_days working days of their own calendar."""
    hd = []
    for a in incomplete:
        if a.is_milestone:
            continue
        cal = project.calendar_for(a)
        rem = a.remaining_hours if a.remaining_hours is not None else a.duration_hours
        if cal.hours_to_days(rem) > max_days:
            hd.append(a.id)
    return hd


def _critical_path_test(project: Project) -> tuple[bool, str]:
    """Push one critical activity out by 600 days and confirm the project finish moves with it."""
    crit = [a for a in project.activities if a.critical and a.status != Status.COMPLETE and not a.is_milestone]
    if not crit or project.finish is None:
        return True, "No incomplete critical activities to test."
    trial = copy.deepcopy(project)
    target = trial.activity(crit[0].id)
    cal = sched_calendar(trial, target)
    push = cal.days_to_hours(600)
    if target.status == Status.IN_PROGRESS and target.remaining_hours is not None:
        target.remaining_hours += push
    else:
        target.duration_hours += push
        if target.remaining_hours is not None:
            target.remaining_hours += push
    try:
        schedule(trial)
    except ScheduleError as e:
        return False, f"Could not schedule the trial: {e}"
    moved = (trial.finish - project.finish).days
    ok = moved >= 600 * 0.9
    return ok, f"Adding 600 days to {target.id} moved the finish by {moved} calendar days."

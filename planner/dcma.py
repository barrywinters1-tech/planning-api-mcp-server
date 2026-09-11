"""DCMA 14-point schedule assessment plus a few extra checks an experienced planner runs.

Every check returns a `Check` with pass/fail, the measured value, the threshold and
the offending activity ids so the UI (or the AI) can act on it.
"""
from __future__ import annotations

import copy
from datetime import timedelta
from typing import Optional

from pydantic import BaseModel, Field

from .cpm import schedule, ScheduleError
from .model import ActivityType, Constraint, HARD_CONSTRAINTS, LinkType, Project, Status

HIGH_FLOAT_DAYS = 44
HIGH_DURATION_DAYS = 44


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

    def failing(self) -> list[Check]:
        return [c for c in self.checks if c.applicable and not c.passed]


def _pct(n: int, d: int) -> float:
    return round(100.0 * n / d, 1) if d else 0.0


def health_check(project: Project) -> HealthReport:
    checks: list[Check] = []
    acts = [a for a in project.activities if a.type != ActivityType.LOE]
    incomplete = [a for a in acts if a.status != Status.COMPLETE]
    n_inc = len(incomplete)
    amap = project.activity_map()
    data_date = project.data_date or project.start

    # 1 Logic
    missing = []
    for a in incomplete:
        has_pred = bool(project.predecessors_of(a.id)) or a.type == ActivityType.START_MILESTONE
        has_succ = bool(project.successors_of(a.id)) or a.type == ActivityType.FINISH_MILESTONE
        if not (has_pred and has_succ):
            missing.append(a.id)
    p = _pct(len(missing), n_inc)
    checks.append(Check(key="logic", title="Missing logic", passed=p <= 5, value=p, threshold="≤ 5%",
                        detail=f"{len(missing)} of {n_inc} incomplete activities lack a predecessor or successor.",
                        items=missing))

    # 2 Leads
    leads = [f"{r.predecessor_id}->{r.successor_id}" for r in project.relationships if r.lag_hours < 0]
    p = _pct(len(leads), len(project.relationships))
    checks.append(Check(key="leads", title="Leads (negative lag)", passed=len(leads) == 0, value=p, threshold="0%",
                        detail=f"{len(leads)} relationships use negative lag.", items=leads))

    # 3 Lags
    lags = [f"{r.predecessor_id}->{r.successor_id}" for r in project.relationships if r.lag_hours > 0]
    p = _pct(len(lags), len(project.relationships))
    checks.append(Check(key="lags", title="Lags", passed=p <= 5, value=p, threshold="≤ 5%",
                        detail=f"{len(lags)} of {len(project.relationships)} relationships carry positive lag.", items=lags))

    # 4 Relationship types
    fs = sum(1 for r in project.relationships if r.type == LinkType.FS)
    p = _pct(fs, len(project.relationships))
    checks.append(Check(key="rel_types", title="Finish-to-start share", passed=p >= 90 or not project.relationships,
                        value=p, threshold="≥ 90%", detail=f"{fs} of {len(project.relationships)} links are FS."))

    # 5 Hard constraints
    hard = [a.id for a in incomplete if a.constraint in HARD_CONSTRAINTS]
    p = _pct(len(hard), n_inc)
    checks.append(Check(key="hard_constraints", title="Hard constraints", passed=p <= 5, value=p, threshold="≤ 5%",
                        detail=f"{len(hard)} incomplete activities have must-start/finish-on constraints.", items=hard))

    # 6 High float
    hf = []
    for a in incomplete:
        cal = project.calendar_for(a)
        if a.total_float_hours is not None and cal.hours_to_days(a.total_float_hours) > HIGH_FLOAT_DAYS:
            hf.append(a.id)
    p = _pct(len(hf), n_inc)
    checks.append(Check(key="high_float", title="High float", passed=p <= 5, value=p, threshold="≤ 5%",
                        detail=f"{len(hf)} incomplete activities have more than {HIGH_FLOAT_DAYS} days total float.", items=hf))

    # 7 Negative float
    nf = [a.id for a in incomplete if a.total_float_hours is not None and a.total_float_hours < -1e-6]
    checks.append(Check(key="negative_float", title="Negative float", passed=not nf, value=float(len(nf)), threshold="0",
                        detail=f"{len(nf)} activities have negative total float.", items=nf))

    # 8 High duration
    hd = []
    for a in incomplete:
        if a.is_milestone:
            continue
        cal = project.calendar_for(a)
        rem = a.remaining_hours if a.remaining_hours is not None else a.duration_hours
        if cal.hours_to_days(rem) > HIGH_DURATION_DAYS:
            hd.append(a.id)
    p = _pct(len(hd), n_inc)
    checks.append(Check(key="high_duration", title="High duration", passed=p <= 5, value=p, threshold="≤ 5%",
                        detail=f"{len(hd)} incomplete activities are longer than {HIGH_DURATION_DAYS} working days.", items=hd))

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
    checks.append(Check(key="missed_tasks", title="Missed tasks", passed=p <= 5, value=p, threshold="≤ 5%",
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
        checks.append(Check(key="cpli", title="Critical path length index", passed=cpli >= 0.95, value=cpli, threshold="≥ 0.95",
                            detail=f"Critical path {cal.hours_to_days(cpl):.0f}d, float to must-finish {cal.hours_to_days(tf):.0f}d."))
    else:
        checks.append(Check(key="cpli", title="Critical path length index", passed=True, applicable=False,
                            detail="Set a must-finish-by date to compute CPLI."))

    # 14 BEI
    planned_done = [a for a in baselined if a.baseline_finish <= data_date]
    actually_done = [a for a in acts if a.status == Status.COMPLETE]
    if planned_done:
        bei = round(len(actually_done) / len(planned_done), 2)
        checks.append(Check(key="bei", title="Baseline execution index", passed=bei >= 0.95, value=bei, threshold="≥ 0.95",
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

    applicable = [c for c in checks if c.applicable]
    score = int(round(100 * sum(1 for c in applicable if c.passed) / len(applicable))) if applicable else 100
    fails = [c.title for c in applicable if not c.passed]
    summary = "Schedule passes all applicable checks." if not fails else "Failing: " + ", ".join(fails) + "."
    return HealthReport(score=score, checks=checks, summary=summary)


def _critical_path_test(project: Project) -> tuple[bool, str]:
    """Push one critical activity out by 600 days and confirm the project finish moves with it."""
    crit = [a for a in project.activities if a.critical and a.status != Status.COMPLETE and not a.is_milestone]
    if not crit or project.finish is None:
        return True, "No incomplete critical activities to test."
    trial = copy.deepcopy(project)
    target = trial.activity(crit[0].id)
    cal = trial.calendar_for(target)
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

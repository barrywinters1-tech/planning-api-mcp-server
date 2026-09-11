"""Critical Path Method scheduler.

Forward and backward pass over a Project with per-activity calendars, all four
relationship types with lags (lag measured on the predecessor's calendar, as P6
does by default), date constraints, and progress against a data date.
"""
from __future__ import annotations

from collections import defaultdict, deque
from datetime import datetime
from typing import Optional

from .model import Activity, ActivityType, Constraint, LinkType, Project, Status

EPS = 1e-6


class ScheduleError(Exception):
    pass


def topological_order(project: Project) -> list[Activity]:
    ids = [a.id for a in project.activities]
    known = set(ids)
    indeg = {i: 0 for i in ids}
    succ: dict[str, list[str]] = defaultdict(list)
    for r in project.relationships:
        if r.predecessor_id not in known or r.successor_id not in known:
            raise ScheduleError(
                f"Relationship {r.predecessor_id}->{r.successor_id} references an unknown activity"
            )
        if r.predecessor_id == r.successor_id:
            raise ScheduleError(f"Activity {r.predecessor_id} is linked to itself")
        succ[r.predecessor_id].append(r.successor_id)
        indeg[r.successor_id] += 1
    queue = deque(i for i in ids if indeg[i] == 0)
    order: list[str] = []
    while queue:
        n = queue.popleft()
        order.append(n)
        for s in succ[n]:
            indeg[s] -= 1
            if indeg[s] == 0:
                queue.append(s)
    if len(order) != len(ids):
        stuck = [i for i in ids if indeg[i] > 0]
        raise ScheduleError(f"Schedule contains a logic loop involving: {', '.join(stuck[:10])}")
    amap = project.activity_map()
    return [amap[i] for i in order]


def _remaining_hours(a: Activity) -> float:
    if a.status == Status.COMPLETE:
        return 0.0
    if a.remaining_hours is not None:
        return max(0.0, a.remaining_hours)
    if a.status == Status.IN_PROGRESS:
        return max(0.0, a.duration_hours * (1 - a.percent_complete / 100.0))
    return a.duration_hours


def schedule(project: Project) -> Project:
    """Compute early/late dates, floats and the critical path in place."""
    project.ensure_default_calendar()
    order = topological_order(project)
    amap = project.activity_map()
    data_date = project.data_date or project.start
    preds = defaultdict(list)
    succs = defaultdict(list)
    for r in project.relationships:
        preds[r.successor_id].append(r)
        succs[r.predecessor_id].append(r)

    # ---------------- forward pass ----------------
    for a in order:
        cal = project.calendar_for(a)
        rem = _remaining_hours(a)

        if a.status == Status.COMPLETE and a.actual_start and a.actual_finish:
            a.early_start, a.early_finish = a.actual_start, a.actual_finish
            continue

        es_floor = cal.next_working_start(max(project.start, data_date))
        ef_floor: Optional[datetime] = None

        if a.status == Status.IN_PROGRESS and a.actual_start:
            # retained logic: remaining work resumes at the data date
            es_floor = a.actual_start
            ef_floor = cal.add_hours(cal.next_working_start(data_date), rem)

        for r in preds[a.id]:
            p = amap[r.predecessor_id]
            pcal = project.calendar_for(p)
            if r.type == LinkType.FS:
                t = pcal.add_hours(p.early_finish, r.lag_hours)
                es_floor = max(es_floor, t)
            elif r.type == LinkType.SS:
                t = pcal.add_hours(p.early_start, r.lag_hours)
                es_floor = max(es_floor, t)
            elif r.type == LinkType.FF:
                t = pcal.add_hours(p.early_finish, r.lag_hours)
                ef_floor = t if ef_floor is None else max(ef_floor, t)
            elif r.type == LinkType.SF:
                t = pcal.add_hours(p.early_start, r.lag_hours)
                ef_floor = t if ef_floor is None else max(ef_floor, t)

        cd = a.constraint_date
        if cd is not None:
            if a.constraint in (Constraint.START_ON_OR_AFTER, Constraint.MUST_START_ON):
                es_floor = max(es_floor, cd) if a.constraint == Constraint.START_ON_OR_AFTER else cd
            elif a.constraint in (Constraint.FINISH_ON_OR_AFTER, Constraint.MUST_FINISH_ON):
                ef_floor = cd if (ef_floor is None or a.constraint == Constraint.MUST_FINISH_ON) else max(ef_floor, cd)

        if a.status == Status.IN_PROGRESS and a.actual_start:
            es = a.actual_start
            ef = ef_floor if ef_floor is not None else cal.add_hours(cal.next_working_start(data_date), rem)
        elif a.type == ActivityType.FINISH_MILESTONE:
            # finish milestones sit on the predecessor's finish, not the next morning
            target = es_floor if ef_floor is None else max(es_floor, ef_floor)
            es = ef = target if cal.in_shift(target) else cal.prev_working_end(target)
        else:
            es = cal.next_working_start(es_floor)
            ef = cal.add_hours(es, rem) if rem > 0 else es
            if ef_floor is not None and ef_floor > ef:
                ef = ef_floor if rem > 0 else cal.prev_working_end(ef_floor)
                es = cal.add_hours(ef, -rem) if rem > 0 else ef
        if a.status == Status.NOT_STARTED and cd is not None:
            if a.constraint == Constraint.MUST_START_ON:
                es = cd
                ef = cal.add_hours(es, rem) if rem > 0 else es
            elif a.constraint == Constraint.MUST_FINISH_ON:
                ef = cd
                es = cal.add_hours(ef, -rem) if rem > 0 else ef
        a.early_start, a.early_finish = es, ef

    project_finish = max((a.early_finish for a in project.activities if a.early_finish), default=project.start)
    project.finish = project_finish
    late_anchor = project.must_finish_by or project_finish

    # ---------------- backward pass ----------------
    for a in reversed(order):
        cal = project.calendar_for(a)
        rem = _remaining_hours(a)
        if a.status == Status.COMPLETE and a.actual_finish:
            a.late_start, a.late_finish = a.early_start, a.early_finish
            a.total_float_hours = 0.0
            a.free_float_hours = 0.0
            a.critical = False
            continue

        lf_ceil = cal.prev_working_end(late_anchor)
        ls_ceil: Optional[datetime] = None
        for r in succs[a.id]:
            s = amap[r.successor_id]
            if s.status == Status.COMPLETE:
                continue
            if r.type == LinkType.FS:
                t = cal.add_hours(s.late_start, -r.lag_hours)
                lf_ceil = min(lf_ceil, t)
            elif r.type == LinkType.SS:
                t = cal.add_hours(s.late_start, -r.lag_hours)
                ls_ceil = t if ls_ceil is None else min(ls_ceil, t)
            elif r.type == LinkType.FF:
                t = cal.add_hours(s.late_finish, -r.lag_hours)
                lf_ceil = min(lf_ceil, t)
            elif r.type == LinkType.SF:
                t = cal.add_hours(s.late_finish, -r.lag_hours)
                ls_ceil = t if ls_ceil is None else min(ls_ceil, t)

        cd = a.constraint_date
        if cd is not None:
            if a.constraint in (Constraint.FINISH_ON_OR_BEFORE, Constraint.MUST_FINISH_ON):
                lf_ceil = min(lf_ceil, cd) if a.constraint == Constraint.FINISH_ON_OR_BEFORE else cd
            elif a.constraint in (Constraint.START_ON_OR_BEFORE, Constraint.MUST_START_ON):
                ls_ceil = cd if (ls_ceil is None or a.constraint == Constraint.MUST_START_ON) else min(ls_ceil, cd)

        lf = cal.prev_working_end(lf_ceil)
        ls = cal.add_hours(lf, -rem) if rem > 0 else lf
        if ls_ceil is not None and ls_ceil < ls:
            ls = cal.prev_working_end(ls_ceil) if rem == 0 else ls_ceil
            lf = cal.add_hours(ls, rem) if rem > 0 else ls
        if a.status == Status.IN_PROGRESS and a.actual_start:
            ls = a.actual_start
        a.late_start, a.late_finish = ls, lf

        a.total_float_hours = round(cal.hours_between(a.early_finish, a.late_finish), 4)
        # free float: earliest successor-driven slack
        ff: Optional[float] = None
        for r in succs[a.id]:
            s = amap[r.successor_id]
            if r.type == LinkType.FS:
                slack = cal.hours_between(cal.add_hours(a.early_finish, r.lag_hours), s.early_start)
            elif r.type == LinkType.SS:
                slack = cal.hours_between(cal.add_hours(a.early_start, r.lag_hours), s.early_start)
            elif r.type == LinkType.FF:
                slack = cal.hours_between(cal.add_hours(a.early_finish, r.lag_hours), s.early_finish)
            else:
                slack = cal.hours_between(cal.add_hours(a.early_start, r.lag_hours), s.early_finish)
            ff = slack if ff is None else min(ff, slack)
        a.free_float_hours = round(a.total_float_hours if ff is None else max(0.0, ff), 4)

    # critical = zero or negative float; if a must-finish-by date leaves float everywhere,
    # flag the longest path (least float) instead, as P6's "longest path" option does
    open_tf = [a.total_float_hours for a in project.activities
               if a.status != Status.COMPLETE and a.total_float_hours is not None]
    threshold = max(0.0, min(open_tf)) if open_tf else 0.0
    for a in project.activities:
        if a.status == Status.COMPLETE or a.total_float_hours is None:
            a.critical = False
        else:
            a.critical = a.total_float_hours <= threshold + EPS

    # hammocks (level of effort): start with the earliest SS predecessor, finish with the latest FF predecessor;
    # with no such links they span the activities in their own WBS node
    for a in project.activities:
        if a.type != ActivityType.LOE or a.status == Status.COMPLETE:
            continue
        cal = project.calendar_for(a)
        starts = [amap[r.predecessor_id].early_start for r in preds[a.id] if r.type == LinkType.SS and amap[r.predecessor_id].early_start]
        ends = [amap[r.predecessor_id].early_finish for r in preds[a.id] if r.type == LinkType.FF and amap[r.predecessor_id].early_finish]
        if not starts and not ends:
            peers = [x for x in project.activities if x.wbs_id == a.wbs_id and x.id != a.id and x.type != ActivityType.LOE and x.early_start]
            starts = [x.actual_start or x.early_start for x in peers]
            ends = [x.actual_finish or x.early_finish for x in peers]
        if starts:
            a.early_start = a.late_start = min(starts)
        if ends:
            a.early_finish = a.late_finish = max(ends)
        if a.early_start and a.early_finish:
            a.duration_hours = round(cal.hours_between(a.early_start, a.early_finish), 2)
            a.total_float_hours = a.free_float_hours = 0.0
            a.critical = False

    # ALAP activities sit on their late dates
    for a in project.activities:
        if a.constraint == Constraint.AS_LATE_AS_POSSIBLE and a.status == Status.NOT_STARTED:
            a.early_start, a.early_finish = a.late_start, a.late_finish
            a.total_float_hours = 0.0
            a.free_float_hours = 0.0

    project.scheduled_at = datetime.now()
    return project


def critical_path(project: Project) -> list[Activity]:
    return [a for a in project.activities if a.critical and a.status != Status.COMPLETE]

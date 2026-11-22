"""Resource levelling (serial method) and baselines.

Levelling delays not-started activities so that no resource is used beyond its
`max_units_per_day`. Activities are taken in topological order, ties broken by
late start then priority, which is what P6 and Asta do by default. The levelled
dates replace the early dates; `level_delay_hours` records how far each moved.

Options (level(project, options) first, then Project.levelling; every key optional, the defaults
give the long-standing behaviour):
  resources: [ids]      only these resources are limited (each still needs a max_units_per_day); default every
                        resource with a max
  from, to: ISO dates   only activities whose scheduled (pre-levelling) early start falls on or between these dates
                        may be delayed; others keep their logic dates and, if over-allocated, are reported ("window")
  within_float: bool    never delay an activity beyond its late start; one that cannot fit within its float keeps
                        its logic dates, stays over-allocated and is reported ("within_float_blocked")
  order: str            tie-break order among the activities ready to be placed: "late_start" (default: late start,
                        then priority, then id), "priority" (priority, late start, id), "total_float" (total float,
                        late start, priority, id) or "early_start" (early start, priority, id)
  preserve_actuals: true  always: complete and in-progress activities keep their dates (actual start, remaining work
                        from the data date); only not-started activities are moved. The key is accepted for files
                        that spell the rule out; false is not supported and behaves as true.
Lags are measured on the lag calendar the scheduler uses (Project.lag_calendar / Relationship.lag_calendar,
cpm._lag_calendar), and elapsed-duration activities run on the 24-hour calendar (cpm.sched_calendar).

Report: level() stores Project.levelling_report, one record per activity it moved or could not move, ordered by id:
  {id, delay_hours, resource_id, waited_for, reason}
  delay_hours   working hours (of the activity's scheduling calendar) between its scheduled and levelled early start
  resource_id   the resource whose limit it last waited on (null when it only moved because a predecessor did)
  waited_for    the activity that was using that resource on the day it last waited on (or the predecessor that set its
                start when it only moved with the logic); null when nothing did
  reason        "capacity" (delayed to stay within a limit), "within_float_blocked" (would have had to pass its late
                start; left over-allocated) or "window" (over-allocated but outside the from/to window; left alone)
levelling_report(project) returns that list (empty until levelled). web/engine.js level() applies the same rules.
"""
from __future__ import annotations

import heapq
from collections import defaultdict
from datetime import datetime, timedelta
from typing import Optional

from .cpm import EPS, _add_lag, _lag_calendar, sched_calendar, schedule
from .model import Activity, Baseline, LinkType, Project, Status

LEVEL_ORDERS = ("late_start", "priority", "total_float", "early_start")
LEVEL_REASONS = ("capacity", "within_float_blocked", "window")


def daily_demand(project: Project, a: Activity) -> dict[str, float]:
    """Units per working day for each resource assigned to the activity."""
    cal = project.calendar_for(a)
    days = cal.hours_to_days(a.duration_hours)
    if days <= 0:
        return {}
    out: dict[str, float] = defaultdict(float)
    for x in project.assignments:
        if x.activity_id == a.id and x.units > 0:
            out[x.resource_id] += x.units / a.duration_hours  # hours per hour = people
    return dict(out)


def level_options(project: Project, options: Optional[dict] = None) -> dict:
    """The effective levelling options: the argument's keys over Project.levelling's."""
    opts = dict(project.levelling or {})
    opts.update(options or {})
    return opts


def _order_key(a: Activity, order: str, project: Project):
    ls = a.late_start or a.early_start or project.start
    if order == "priority":
        return (a.priority, ls, a.id)
    if order == "total_float":
        return (a.total_float_hours if a.total_float_hours is not None else float("inf"), ls, a.priority, a.id)
    if order == "early_start":
        return (a.early_start or project.start, a.priority, a.id)
    return (ls, a.priority, a.id)


def _window_date(v) -> Optional[datetime]:
    if not v:
        return None
    return v if isinstance(v, datetime) else datetime.fromisoformat(str(v)[:19])


def levelling_report(project: Project) -> list[dict]:
    """The records level() stored on the project (see the module docstring); [] until levelled."""
    return [dict(r) for r in (project.levelling_report or [])]


def level(project: Project, options: Optional[dict] = None) -> Project:
    schedule(project)
    opts = level_options(project, options)
    subset = opts.get("resources")
    subset = set(subset) if subset else None
    limits = {r.id: r.max_units_per_day for r in project.resources
              if r.max_units_per_day and (subset is None or r.id in subset)}
    if not limits:
        project.levelled = False
        project.levelling_report = None
        return project
    order = opts.get("order") if opts.get("order") in LEVEL_ORDERS else "late_start"
    within_float = bool(opts.get("within_float"))
    w_from, w_to = _window_date(opts.get("from")), _window_date(opts.get("to"))
    amap = project.activity_map()
    usage: dict[str, dict] = defaultdict(lambda: defaultdict(float))  # rid -> date -> units
    users: dict[str, dict] = defaultdict(lambda: defaultdict(list))   # rid -> date -> [activity ids placed]
    preds = defaultdict(list)
    succs = defaultdict(list)
    indeg = {a.id: 0 for a in project.activities}
    for r in project.relationships:
        preds[r.successor_id].append(r)
        succs[r.predecessor_id].append(r)
        indeg[r.successor_id] += 1
    ready = [(_order_key(a, order, project), a.id) for a in project.activities if indeg[a.id] == 0]
    heapq.heapify(ready)
    done: dict[str, tuple[datetime, datetime]] = {}
    data_date = project.data_date or project.start
    report: list[dict] = []

    def first_conflict(cal, start, finish, demand):
        d = start.date()
        while d <= finish.date():
            if cal.is_working(d):
                for rid in sorted(demand):
                    if usage[rid][d] + demand[rid] > limits[rid] + EPS:
                        return d, rid
            d += timedelta(days=1)
        return None, None

    while ready:
        _, aid = heapq.heappop(ready)
        a = amap[aid]
        cal = sched_calendar(project, a)
        orig_es = a.early_start
        resource_id = waited_for = reason = None
        if a.status == Status.COMPLETE or a.status == Status.IN_PROGRESS:
            start, finish = a.early_start, a.early_finish
        else:
            floor = cal.next_working_start(max(project.start, data_date))
            floor_by = None
            ef_floor = None
            for r in preds[aid]:
                p = amap[r.predecessor_id]
                lcal = _lag_calendar(project, r, p, a)
                ps, pf = done.get(p.id, (p.early_start, p.early_finish))
                if r.type == LinkType.FS:
                    t = _add_lag(lcal, pf, r.lag_hours)
                    if t > floor:
                        floor, floor_by = t, p.id
                elif r.type == LinkType.SS:
                    t = _add_lag(lcal, ps, r.lag_hours)
                    if t > floor:
                        floor, floor_by = t, p.id
                elif r.type == LinkType.FF:
                    t = _add_lag(lcal, pf, r.lag_hours)
                    ef_floor = t if ef_floor is None else max(ef_floor, t)
                else:
                    t = _add_lag(lcal, ps, r.lag_hours)
                    ef_floor = t if ef_floor is None else max(ef_floor, t)
            if a.constraint_date and a.constraint.value in ("start_on_or_after", "must_start_on"):
                floor = max(floor, a.constraint_date)
            start = cal.next_working_start(max(floor, a.early_start or floor))
            rem = a.duration_hours
            finish = cal.add_hours(start, rem) if rem > 0 else start
            if ef_floor and ef_floor > finish:
                finish = ef_floor if rem > 0 else cal.prev_working_end(ef_floor)
                start = cal.add_hours(finish, -rem) if rem > 0 else finish
            demand = {rid: u for rid, u in daily_demand(project, a).items() if rid in limits}
            if demand and rem > 0:
                logic_start, logic_finish = start, finish
                es0 = (orig_es or start).date()
                in_window = (w_from is None or es0 >= w_from.date()) and (w_to is None or es0 <= w_to.date())
                for _ in range(5000):
                    conflict, rid = first_conflict(cal, start, finish, demand)
                    if conflict is None:
                        break
                    resource_id, reason = rid, "capacity"
                    waited_for = users[rid][conflict][-1] if users[rid][conflict] else None
                    if not in_window:
                        reason = "window"
                        break
                    start = cal.next_working_start(datetime.combine(conflict + timedelta(days=1), datetime.min.time()))
                    finish = cal.add_hours(start, rem)
                    if within_float and a.late_start and start > a.late_start:
                        start, finish, reason = logic_start, logic_finish, "within_float_blocked"
                        break
                d = start.date()
                while d <= finish.date():
                    if cal.is_working(d):
                        for rid, u in demand.items():
                            usage[rid][d] += u
                            users[rid][d].append(aid)
                    d += timedelta(days=1)
            if reason is None and orig_es and start > orig_es and floor_by:
                reason, waited_for = "capacity", floor_by
        done[aid] = (start, finish)
        a.level_delay_hours = round(cal.hours_between(orig_es, start), 2) if orig_es else 0.0
        a.early_start, a.early_finish = start, finish
        if reason is not None and (a.level_delay_hours > 0 or reason != "capacity"):
            report.append({"id": aid, "delay_hours": a.level_delay_hours, "resource_id": resource_id,
                           "waited_for": waited_for, "reason": reason})
        for r in succs[aid]:
            indeg[r.successor_id] -= 1
            if indeg[r.successor_id] == 0:
                s = amap[r.successor_id]
                heapq.heappush(ready, (_order_key(s, order, project), s.id))
    project.finish = max((a.early_finish for a in project.activities if a.early_finish), default=project.start)
    for a in project.activities:
        if a.late_finish and a.early_finish:
            cal = sched_calendar(project, a)
            a.total_float_hours = round(cal.hours_between(a.early_finish, a.late_finish), 4)
            a.critical = a.total_float_hours <= EPS
    project.levelling_report = sorted(report, key=lambda r: r["id"])
    project.levelled = True
    return project


def unlevel(project: Project) -> Project:
    for a in project.activities:
        a.level_delay_hours = 0.0
    project.levelled = False
    project.levelling_report = None
    return schedule(project)


# ------------------------------------------------------------------------------------
# baselines
# ------------------------------------------------------------------------------------
def set_baseline(project: Project, name: str = "Baseline") -> Baseline:
    schedule(project)
    bl = Baseline(name=name, saved_at=datetime.now(), finish=project.finish)
    for a in project.activities:
        s, f = a.actual_start or a.early_start, a.actual_finish or a.early_finish
        bl.dates[a.id] = {"start": s.isoformat() if s else None, "finish": f.isoformat() if f else None, "duration_hours": a.duration_hours}
        a.baseline_start, a.baseline_finish = s, f
    project.baselines = [b for b in project.baselines if b.name != name] + [bl]
    return bl


def use_baseline(project: Project, name: str) -> bool:
    for bl in project.baselines:
        if bl.name == name:
            for a in project.activities:
                d = bl.dates.get(a.id)
                a.baseline_start = datetime.fromisoformat(d["start"]) if d and d.get("start") else None
                a.baseline_finish = datetime.fromisoformat(d["finish"]) if d and d.get("finish") else None
            return True
    return False


def clear_baseline(project: Project) -> None:
    for a in project.activities:
        a.baseline_start = a.baseline_finish = None

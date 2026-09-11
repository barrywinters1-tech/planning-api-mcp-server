"""Resource levelling (serial method) and baselines.

Levelling delays not-started activities so that no resource is used beyond its
`max_units_per_day`. Activities are taken in topological order, ties broken by
late start then priority, which is what P6 and Asta do by default. The levelled
dates replace the early dates; `level_delay_hours` records how far each moved.
"""
from __future__ import annotations

import heapq
from collections import defaultdict
from datetime import datetime, timedelta

from .cpm import EPS, schedule
from .model import Activity, Baseline, LinkType, Project, Status


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


def level(project: Project) -> Project:
    schedule(project)
    limits = {r.id: r.max_units_per_day for r in project.resources if r.max_units_per_day}
    if not limits:
        project.levelled = False
        return project
    amap = project.activity_map()
    usage: dict[str, dict] = defaultdict(lambda: defaultdict(float))  # rid -> date -> units
    preds = defaultdict(list)
    succs = defaultdict(list)
    indeg = {a.id: 0 for a in project.activities}
    for r in project.relationships:
        preds[r.successor_id].append(r)
        succs[r.predecessor_id].append(r)
        indeg[r.successor_id] += 1
    ready = [((a.late_start or a.early_start or project.start), a.priority, a.id) for a in project.activities if indeg[a.id] == 0]
    heapq.heapify(ready)
    done: dict[str, tuple[datetime, datetime]] = {}
    data_date = project.data_date or project.start
    while ready:
        _, _, aid = heapq.heappop(ready)
        a = amap[aid]
        cal = project.calendar_for(a)
        orig_es = a.early_start
        if a.status == Status.COMPLETE or a.status == Status.IN_PROGRESS:
            start, finish = a.early_start, a.early_finish
        else:
            floor = cal.next_working_start(max(project.start, data_date))
            ef_floor = None
            for r in preds[aid]:
                p = amap[r.predecessor_id]
                pcal = project.calendar_for(p)
                ps, pf = done.get(p.id, (p.early_start, p.early_finish))
                if r.type == LinkType.FS:
                    floor = max(floor, pcal.add_hours(pf, r.lag_hours))
                elif r.type == LinkType.SS:
                    floor = max(floor, pcal.add_hours(ps, r.lag_hours))
                elif r.type == LinkType.FF:
                    t = pcal.add_hours(pf, r.lag_hours)
                    ef_floor = t if ef_floor is None else max(ef_floor, t)
                else:
                    t = pcal.add_hours(ps, r.lag_hours)
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
                for _ in range(5000):
                    conflict = None
                    d = start.date()
                    while d <= finish.date():
                        if cal.is_working(d):
                            for rid, u in demand.items():
                                if usage[rid][d] + u > limits[rid] + EPS:
                                    conflict = d
                                    break
                        if conflict:
                            break
                        d += timedelta(days=1)
                    if conflict is None:
                        break
                    start = cal.next_working_start(datetime.combine(conflict + timedelta(days=1), datetime.min.time()))
                    finish = cal.add_hours(start, rem)
                d = start.date()
                while d <= finish.date():
                    if cal.is_working(d):
                        for rid, u in demand.items():
                            usage[rid][d] += u
                    d += timedelta(days=1)
        done[aid] = (start, finish)
        a.level_delay_hours = round(cal.hours_between(orig_es, start), 2) if orig_es else 0.0
        a.early_start, a.early_finish = start, finish
        for r in succs[aid]:
            indeg[r.successor_id] -= 1
            if indeg[r.successor_id] == 0:
                s = amap[r.successor_id]
                heapq.heappush(ready, ((s.late_start or s.early_start or project.start), s.priority, s.id))
    project.finish = max((a.early_finish for a in project.activities if a.early_finish), default=project.start)
    for a in project.activities:
        if a.late_finish and a.early_finish:
            cal = project.calendar_for(a)
            a.total_float_hours = round(cal.hours_between(a.early_finish, a.late_finish), 4)
            a.critical = a.total_float_hours <= EPS
    project.levelled = True
    return project


def unlevel(project: Project) -> Project:
    for a in project.activities:
        a.level_delay_hours = 0.0
    project.levelled = False
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

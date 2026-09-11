"""Resource histograms, cost curves and earned value. Pure arithmetic over the scheduled model."""
from __future__ import annotations

from collections import defaultdict
from datetime import date, datetime, timedelta

from .levelling import daily_demand
from .model import Activity, Project, Status


def _span(project: Project) -> tuple[date, date]:
    starts = [a.actual_start or a.early_start for a in project.activities if (a.actual_start or a.early_start)]
    ends = [a.actual_finish or a.early_finish for a in project.activities if (a.actual_finish or a.early_finish)]
    if not starts:
        return project.start.date(), project.start.date()
    return min(starts).date(), max(ends).date()


def _working_days(project: Project, a: Activity) -> list[date]:
    s, f = a.actual_start or a.early_start, a.actual_finish or a.early_finish
    if not s or not f:
        return []
    cal = project.calendar_for(a)
    out, d = [], s.date()
    while d <= f.date():
        if cal.is_working(d) and (d != f.date() or f.time() > cal.day_start):
            out.append(d)
        d += timedelta(days=1)
    return out or [s.date()]


def histogram(project: Project, resource_id: str | None = None) -> dict:
    """Daily demand per resource with the availability limit. Weekly totals are summed by the client."""
    d0, d1 = _span(project)
    per_res: dict[str, dict[date, float]] = defaultdict(lambda: defaultdict(float))
    for a in project.activities:
        dem = daily_demand(project, a)
        if not dem:
            continue
        days = _working_days(project, a)
        for d in days:
            for rid, u in dem.items():
                per_res[rid][d] += u
    limits = {r.id: r.max_units_per_day for r in project.resources}
    names = {r.id: r.name for r in project.resources}
    out = []
    for rid, series in per_res.items():
        if resource_id and rid != resource_id:
            continue
        rows = [{"date": d.isoformat(), "units": round(u, 2)} for d, u in sorted(series.items())]
        over = [r for r in rows if limits.get(rid) and r["units"] > limits[rid] + 1e-6]
        out.append({"resource_id": rid, "name": names.get(rid, rid), "limit": limits.get(rid), "days": rows,
                    "peak": round(max(series.values()), 2) if series else 0, "overallocated_days": len(over),
                    "total_units": round(sum(series.values()), 1)})
    return {"from": d0.isoformat(), "to": d1.isoformat(), "resources": sorted(out, key=lambda x: x["name"])}


def activity_cost(project: Project, a: Activity) -> float:
    rates = {r.id: r.rate for r in project.resources}
    total = 0.0
    for x in project.assignments:
        if x.activity_id == a.id:
            total += x.cost if x.cost else x.units * rates.get(x.resource_id, 0.0)
    return total


def cost_curve(project: Project) -> dict:
    """Weekly planned (early dates), baseline and earned cost, cumulative, plus EV metrics at the data date."""
    data_date = (project.data_date or project.start).date()
    weekly_planned: dict[date, float] = defaultdict(float)
    weekly_baseline: dict[date, float] = defaultdict(float)
    weekly_earned: dict[date, float] = defaultdict(float)
    weekly_actual: dict[date, float] = defaultdict(float)
    budget = bcws = bcwp = acwp = 0.0

    def week_of(d: date) -> date:
        return d - timedelta(days=d.weekday())

    for a in project.activities:
        cost = activity_cost(project, a)
        if cost <= 0:
            continue
        budget += cost
        days = _working_days(project, a)
        if days:
            per = cost / len(days)
            for d in days:
                weekly_planned[week_of(d)] += per
        if a.baseline_start and a.baseline_finish:
            cal = project.calendar_for(a)
            bdays, d = [], a.baseline_start.date()
            while d <= a.baseline_finish.date():
                if cal.is_working(d):
                    bdays.append(d)
                d += timedelta(days=1)
            if bdays:
                per = cost / len(bdays)
                for d in bdays:
                    weekly_baseline[week_of(d)] += per
                    if d <= data_date:
                        bcws += per
        else:
            for d in days:
                if d <= data_date:
                    bcws += cost / len(days)
        pct = 100.0 if a.status == Status.COMPLETE else a.percent_complete
        earned = cost * pct / 100.0
        bcwp += earned
        if earned > 0 and days:
            done_days = [d for d in days if d <= data_date] or days[:1]
            per = earned / len(done_days)
            for d in done_days:
                weekly_earned[week_of(d)] += per
        actual = sum(x.actual_cost for x in project.assignments if x.activity_id == a.id)
        acwp += actual
        if actual > 0 and days:
            done_days = [d for d in days if d <= data_date] or days[:1]
            for d in done_days:
                weekly_actual[week_of(d)] += actual / len(done_days)

    weeks = sorted(set(weekly_planned) | set(weekly_baseline) | set(weekly_earned) | set(weekly_actual))
    rows, cp = [], [0.0, 0.0, 0.0, 0.0]
    for w in weeks:
        cp[0] += weekly_planned[w]; cp[1] += weekly_baseline[w]; cp[2] += weekly_earned[w]; cp[3] += weekly_actual[w]
        rows.append({"week": w.isoformat(), "planned": round(cp[0]), "baseline": round(cp[1]), "earned": round(cp[2]), "actual": round(cp[3])})
    metrics = {"budget": round(budget), "bcws": round(bcws), "bcwp": round(bcwp), "acwp": round(acwp),
               "spi": round(bcwp / bcws, 2) if bcws else None, "cpi": round(bcwp / acwp, 2) if acwp else None,
               "sv": round(bcwp - bcws), "cv": round(bcwp - acwp) if acwp else None, "data_date": data_date.isoformat()}
    return {"weeks": rows, "metrics": metrics, "has_baseline": any(a.baseline_start for a in project.activities)}


def variance(project: Project) -> list[dict]:
    out = []
    for a in project.activities:
        if not a.baseline_finish:
            continue
        cal = project.calendar_for(a)
        f = a.actual_finish or a.early_finish
        s = a.actual_start or a.early_start
        out.append({"id": a.id, "name": a.name,
                    "start_variance_days": round(cal.hours_to_days(cal.hours_between(a.baseline_start, s)), 1) if a.baseline_start and s else None,
                    "finish_variance_days": round(cal.hours_to_days(cal.hours_between(a.baseline_finish, f)), 1) if f else None})
    return out

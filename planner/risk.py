"""Schedule risk analysis: Monte Carlo on activity durations (what Asta Risk and P6 Risk do).

Each iteration draws every unfinished task's duration from a triangular distribution around
its planned duration, re-runs the critical path and records the finish. The result is the
range of likely completion dates (P10/P50/P80/P90), the chance of meeting the deadline and of
meeting today's planned finish, and how often each activity ends up critical (criticality).

Exactly reproducible: the random numbers come from a seeded mulberry32 generator, which is
plain 32-bit integer arithmetic, so web/engine.js produces the identical result in the browser
(checked by tests/test_parity.py). Resource levelling is not re-run inside the iterations.

Ranges are percentages of the planned duration:
  optimistic_pct   how much quicker the best case is            (default 10)
  pessimistic_pct  how much slower the worst case is            (default 30)
  weather_pct      extra worst case for weather-exposed work    (default 20)
  correlation_pct  how much activities run late together        (default 30)
Independent draws understate the spread of a real job, because the causes of delay
(ground, weather, labour, design) hit many activities at once. Correlation is modelled by
each draw using a shared per-iteration random number with that probability.
"""
from __future__ import annotations

import math
from datetime import datetime, timedelta
from typing import Optional

from .cpm import schedule
from .model import ActivityType, Project, Status

WEATHER_WORDS = ("excavat", "topsoil", "reduce level", "foundation", "pil", "drainage", "groundwork", "ground beam",
                 "pile cap", "slab", "concrete", "scaffold", "brick", "block", "envelope", "cladding", "curtain wall",
                 "roof", "steel", "frame", "external", "landscap", "fencing", "driveway", "paving", "surfacing",
                 "facade", "render", "window", "crane", "demolition", "earthworks")


def weather_exposed(name: str, calendar_id: Optional[str]) -> bool:
    """External work a wet winter slows down. Cures and drying (seven-day calendars) are not."""
    n = name.lower()
    if "cure" in n or "drying" in n or (calendar_id or "").startswith("seven"):
        return False
    return any(w in n for w in WEATHER_WORDS)


def mulberry32(seed: int):
    a = seed & 0xFFFFFFFF

    def imul(x: int, y: int) -> int:
        return (x * y) & 0xFFFFFFFF

    def nxt() -> float:
        nonlocal a
        a = (a + 0x6D2B79F5) & 0xFFFFFFFF
        t = a
        t = imul(t ^ (t >> 15), t | 1)
        t ^= (t + imul(t ^ (t >> 7), t | 61)) & 0xFFFFFFFF
        t &= 0xFFFFFFFF
        return ((t ^ (t >> 14)) & 0xFFFFFFFF) / 4294967296
    return nxt


def triangular(u: float, lo: float, mode: float, hi: float) -> float:
    if hi <= lo:
        return mode
    c = (mode - lo) / (hi - lo)
    if u < c:
        return lo + math.sqrt(u * (hi - lo) * (mode - lo))
    return hi - math.sqrt((1 - u) * (hi - lo) * (hi - mode))


def _q(sorted_vals: list, q: float):
    """Nearest-rank percentile."""
    return sorted_vals[max(0, math.ceil(q * len(sorted_vals)) - 1)]


def risk_analysis(project: Project, iterations: int = 500, optimistic_pct: float = 10, pessimistic_pct: float = 30,
                  weather_pct: float = 20, correlation_pct: float = 30, seed: int = 1) -> dict:
    """Run the Monte Carlo. The project passed in is not changed."""
    iterations = max(1, min(int(iterations), 5000))
    base = project.model_copy(deep=True)
    base.baselines = []
    schedule(base)
    det_finish = base.finish
    work = base.model_copy(deep=True)
    tasks = [a for a in work.activities
             if a.type == ActivityType.TASK and a.status != Status.COMPLETE and a.duration_hours > 0]
    orig = [(a.duration_hours, a.remaining_hours) for a in tasks]
    wet = [weather_exposed(a.name, a.calendar_id) for a in tasks]
    lo = 1 - optimistic_pct / 100
    rho = correlation_pct / 100
    rnd = mulberry32(seed)
    finishes: list[datetime] = []
    crit: dict[str, int] = {}
    for _ in range(iterations):
        shared = rnd()
        for j, a in enumerate(tasks):
            pick = rnd()
            own = rnd()
            u = shared if pick < rho else own
            f = triangular(u, lo, 1.0, 1 + (pessimistic_pct + (weather_pct if wet[j] else 0)) / 100)
            # whole hours, as a planner would enter them (round half to even, as the JS engine's pyRound)
            a.duration_hours = max(1, round(orig[j][0] * f))
            if a.status == Status.IN_PROGRESS and orig[j][1] is not None:
                a.remaining_hours = max(0, round(orig[j][1] * f))
        schedule(work)
        finishes.append(work.finish)
        for a in tasks:
            if a.critical:
                crit[a.id] = crit.get(a.id, 0) + 1
    fs = sorted(finishes)
    weeks: dict = {}
    for f in fs:
        d = f.date()
        wk = d - timedelta(days=d.weekday())
        weeks[wk] = weeks.get(wk, 0) + 1
    names = {a.id: a.name for a in work.activities}
    ranked = sorted(crit.items(), key=lambda kv: (-kv[1], kv[0]))
    deadline = project.must_finish_by
    return {
        "iterations": iterations, "seed": seed,
        "settings": {"optimistic_pct": optimistic_pct, "pessimistic_pct": pessimistic_pct,
                     "weather_pct": weather_pct, "correlation_pct": correlation_pct},
        "uncertain_activities": len(tasks), "weather_exposed": sum(wet),
        "deterministic_finish": det_finish.isoformat() if det_finish else None,
        "deadline": deadline.isoformat() if deadline else None,
        "p10": _q(fs, .1).isoformat(), "p50": _q(fs, .5).isoformat(),
        "p80": _q(fs, .8).isoformat(), "p90": _q(fs, .9).isoformat(),
        "earliest": fs[0].isoformat(), "latest": fs[-1].isoformat(),
        "deterministic_probability": sum(1 for f in fs if det_finish and f <= det_finish) * 100 / iterations,
        "deadline_probability": (sum(1 for f in fs if f <= deadline) * 100 / iterations) if deadline else None,
        "histogram": [{"week": w.isoformat(), "count": c} for w, c in sorted(weeks.items())],
        "criticality": [{"id": i, "name": names.get(i, i), "pct": c * 100 / iterations} for i, c in ranked],
    }

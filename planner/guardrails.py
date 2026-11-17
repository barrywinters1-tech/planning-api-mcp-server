"""Planner guardrails: out-of-sequence progress and critical path drag.

out_of_sequence(project): activities whose recorded progress breaks their logic, the way P6 flags
"out-of-sequence progress": a successor started before its finish-to-start predecessor finished,
before its start-to-start predecessor started, or finished before its finish-to-finish predecessor.

critical_drag(project): for each unfinished critical activity, how many working days it adds to
the project finish (Devaux's "drag"): set its remaining duration to zero, recalculate, and measure
how far the finish comes in. It is never more than the activity's own remaining duration, and is
less when a parallel path takes over.

Both have bit-identical ports in web/engine.js (checked by tests/test_parity.py).
"""
from __future__ import annotations

from .cpm import schedule
from .model import ActivityType, LinkType, Project, Status


def _started(a) -> bool:
    return a.status != Status.NOT_STARTED and a.actual_start is not None


def _finished(a) -> bool:
    return a.status == Status.COMPLETE and a.actual_finish is not None


def out_of_sequence(project: Project) -> list[dict]:
    amap = project.activity_map()
    out: list[dict] = []
    for r in project.relationships:
        s, p = amap.get(r.successor_id), amap.get(r.predecessor_id)
        if s is None or p is None:
            continue
        reason = ""
        if r.type == LinkType.FS and _started(s):
            if not _finished(p):
                reason = "started before its predecessor finished"
            elif s.actual_start < p.actual_finish:
                reason = "started before its predecessor's actual finish"
        elif r.type == LinkType.SS and _started(s):
            if not _started(p):
                reason = "started before its predecessor started"
            elif s.actual_start < p.actual_start:
                reason = "started before its predecessor's actual start"
        elif r.type == LinkType.FF and _finished(s) and not _finished(p):
            reason = "finished before its predecessor finished"
        elif r.type == LinkType.SF and _finished(s) and not _started(p):
            reason = "finished before its predecessor started"
        if reason:
            out.append({"successor": s.id, "successor_name": s.name, "predecessor": p.id, "predecessor_name": p.name,
                        "type": r.type.value, "reason": reason})
    return out


def _remaining(a) -> float:
    if a.status == Status.COMPLETE:
        return 0.0
    if a.remaining_hours is not None:
        return max(0.0, a.remaining_hours)
    if a.status == Status.IN_PROGRESS:
        return max(0.0, a.duration_hours * (1 - a.percent_complete / 100.0))
    return a.duration_hours


def critical_drag(project: Project) -> list[dict]:
    base = project.model_copy(deep=True)
    schedule(base)
    dcal = base.ensure_default_calendar()
    f0 = base.finish
    out: list[dict] = []
    for a in base.activities:
        rem = _remaining(a)
        if not a.critical or a.type != ActivityType.TASK or a.status == Status.COMPLETE or rem <= 0:
            continue
        q = base.model_copy(deep=True)
        qa = q.activity(a.id)
        if qa.status == Status.IN_PROGRESS:
            qa.remaining_hours = 0.0
        else:
            qa.duration_hours = 0.0
        schedule(q)
        hpd = dcal.hours_per_day or 8.0
        drag = round(dcal.hours_between(q.finish, f0) / hpd, 1) if q.finish and f0 else 0.0
        own = base.calendar_for(a)
        out.append({"id": a.id, "name": a.name, "drag_days": max(0.0, drag),
                    "remaining_days": round(rem / (own.hours_per_day or 8.0), 1)})
    out.sort(key=lambda d: (-d["drag_days"], d["id"]))
    return out

"""Critical Path Method scheduler.

Forward and backward pass over a Project with per-activity calendars, all four
relationship types with lags, date constraints, and progress against a data date.

Lag is measured on the calendar Project.lag_calendar names (P6's "calendar for scheduling
relationship lag"): the predecessor's (the P6 default, used when None), the successor's, the
project default calendar, or "24h" (elapsed wall-clock hours). A relationship may override the
project setting with its own lag_calendar. Durations and floats always use the activity's own calendar.

Scheduling options on the Project (each None = the long-standing default; web/engine.js applies the same rules):

progress_logic - how the remaining work of an in-progress activity (status in_progress with an actual start) is
scheduled. In every mode its early start is its actual start, which never moves, and its remaining work never
starts before the resume point R = the next working time at or after max(data date, resume_date). Not-started and
complete activities schedule the same in every mode: a complete activity's successors always follow its actual dates.
  "data_date" (default, also when None: the engine's long-standing behaviour): the remaining work runs from R; the
      early finish is the later of R + remaining and the finish-side (FF/SF) link dates from its predecessors. FS/SS
      links into the activity cannot move its start, so they do not hold the remaining work, but they stay in the
      backward pass: an unfinished predecessor that was overtaken out of sequence is pulled back to the successor's
      actual start and shows negative float. Not a P6 mode.
  "retained" (P6 retained logic): the remaining work is scheduled by the logic, never earlier than R: it starts at
      the later of R and the FS/SS link dates from all predecessors, and finishes no earlier than the FF/SF link dates.
      The link that sets the resume point or the finish is driving, so the longest path runs through it, and the
      backward pass and free float measure start-side links against the remaining work's late and early start
      rather than the actual start, so a predecessor that holds the remaining work carries its true float.
  "override" (P6 progress override): links from predecessors that are not complete are ignored for the in-progress
      activity in both passes (so neither its finish nor the predecessor's late dates are set by them; they are never
      driving) and the remaining work runs from R. Links from complete predecessors carry actual dates and still count.
      An in-progress activity that is itself an out-of-sequence successor is treated the same way.
  P6's third option, "actual dates", has no equivalent here: it is the retained/override hybrid that also lets actual
  dates after the data date drive, which this engine does in every mode. An unknown value behaves as "data_date".

float_paths - when set (1-10), schedule() also computes P6-style multiple float paths (see float_paths()) and stores
each activity's path number in Activity.float_path (None when on no path, or when the option is unset).

start_on_new_day - when true (Asta "start on new day"), a not-started task or start milestone whose early start would
fall part-way through a working day (after a lag, or a mid-day predecessor finish) starts at the next working day's
start instead. A start derived from a finish-side link or constraint, a must-start-on date, an in-progress
activity's actual start and late dates are not moved.

near_critical_days - the threshold, in working days of the activity's own calendar, at or below which an open activity
that is not on the longest path (and not a hammock) is flagged Activity.near_critical; 10 when None. No scheduling effect.

Elapsed-duration activities (Activity.elapsed = True) run on calendar time whatever calendar they name: curing, drying,
lead times, approval periods. Their duration_hours and remaining_hours are wall-clock hours and they are scheduled on
ELAPSED_CALENDAR (24 hours a day, seven days, no exceptions, days starting at midnight), so a 72-hour cure starting
Friday 08:00 finishes Monday 08:00. Both passes, floats, the lag measured on their calendar (as predecessor or successor)
and resource levelling use that calendar (sched_calendar()); elapsed_days() gives the calendar days any activity spans.
The activity keeps its own calendar_id for files and reports: XER carries the flag as the task UDF "elapsed" = Y and
MS Project XML as <DurationFormat> 8 (elapsed days); other elapsed DurationFormat codes read back as elapsed too.
"""
from __future__ import annotations

from collections import defaultdict, deque
from datetime import datetime, time, timedelta
from typing import Optional

from .model import Activity, ActivityType, Calendar, Constraint, LinkType, Project, Relationship, Status

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


def _resume_from(a: Activity, data_date: datetime) -> datetime:
    return max(data_date, a.resume_date) if a.resume_date else data_date


PROGRESS_LOGIC = ("data_date", "retained", "override")
DEFAULT_NEAR_CRITICAL_DAYS = 10.0
MAX_FLOAT_PATHS = 10


def _progress_logic(project: Project) -> str:
    mode = project.progress_logic
    return mode if mode in PROGRESS_LOGIC else "data_date"


def _in_progress(a: Activity) -> bool:
    return a.status == Status.IN_PROGRESS and a.actual_start is not None


def _new_day_start(cal: Calendar, es: datetime) -> datetime:
    """Asta "start on new day": a start part-way through a working day moves to the next working day's start."""
    s, _ = cal._shift(es.date())
    if es <= s:
        return es
    return cal.next_working_start(datetime.combine(es.date() + timedelta(days=1), time.min))


# the calendar an elapsed-duration activity is scheduled on: 24 hours a day, seven days, no exceptions
ELAPSED_CALENDAR = Calendar(id="24h", name="Elapsed (24-hour)", hours_per_day=24.0, day_start=time(0, 0),
                            working_days=[0, 1, 2, 3, 4, 5, 6])


def sched_calendar(project: Project, a: Activity) -> Calendar:
    """The calendar an activity is scheduled on: ELAPSED_CALENDAR when Activity.elapsed, else its own (Project.calendar_for)."""
    return ELAPSED_CALENDAR if a.elapsed else project.calendar_for(a)


def elapsed_days(project: Project, a: Activity) -> Optional[float]:
    """Calendar days between an activity's start (actual or early) and finish, to two decimals; None until scheduled."""
    s, f = a.actual_start or a.early_start, a.actual_finish or a.early_finish
    if s is None or f is None:
        return None
    return round((f - s).total_seconds() / 86400.0, 2)


LAG_CALENDARS = ("predecessor", "successor", "project", "24h")


def _lag_calendar(project: Project, r: Relationship, pred: Activity, succ: Activity) -> Optional[Calendar]:
    """The calendar this relationship's lag is measured on; None means elapsed (24-hour) time.
    An unknown value falls back to the predecessor's calendar, the P6 default."""
    mode = r.lag_calendar or project.lag_calendar or "predecessor"
    if mode == "successor":
        return sched_calendar(project, succ)
    if mode == "project":
        return project.calendars[project.default_calendar_id]
    if mode == "24h":
        return None
    return sched_calendar(project, pred)


def _add_lag(cal: Optional[Calendar], dt: datetime, hours: float) -> datetime:
    """dt plus a lag: working hours on cal, or wall-clock hours when cal is None (24-hour lag).
    Elapsed lag lands on whole seconds, as Calendar.add_hours does, so both engines agree."""
    if cal is not None:
        return cal.add_hours(dt, hours)
    if hours == 0:
        return dt
    return dt + timedelta(seconds=round(hours * 3600))


def schedule(project: Project) -> Project:
    """Compute early/late dates, floats and the critical path in place."""
    project.ensure_default_calendar()
    order = topological_order(project)
    amap = project.activity_map()
    data_date = project.data_date or project.start
    mode = _progress_logic(project)
    new_day = bool(project.start_on_new_day)
    preds = defaultdict(list)
    succs = defaultdict(list)
    for r in project.relationships:
        r.driving = False
        preds[r.successor_id].append(r)
        succs[r.predecessor_id].append(r)
    rem_es: dict[str, datetime] = {}   # retained logic: where an in-progress activity's remaining work starts (early / late)
    rem_ls: dict[str, datetime] = {}

    # ---------------- forward pass ----------------
    for a in order:
        cal = sched_calendar(project, a)
        rem = _remaining_hours(a)

        if a.status == Status.COMPLETE and a.actual_start and a.actual_finish:
            a.early_start, a.early_finish = a.actual_start, a.actual_finish
            continue

        es_floor = cal.next_working_start(max(project.start, data_date))
        ef_floor: Optional[datetime] = None
        in_prog = _in_progress(a)
        resume = cal.next_working_start(_resume_from(a, data_date)) if in_prog else None

        if in_prog:
            # remaining work resumes at the data date, or at a later P6 resume date; under retained logic the
            # finish is built from the logic below instead of being floored here
            es_floor = a.actual_start
            if mode != "retained":
                ef_floor = cal.add_hours(resume, rem)

        start_links: list = []   # (relationship, date it imposes) for FS/SS
        finish_links: list = []  # ... and for FF/SF
        for r in preds[a.id]:
            p = amap[r.predecessor_id]
            if in_prog and mode == "override" and p.status != Status.COMPLETE:
                continue   # progress override: an unfinished predecessor no longer holds the started activity
            lcal = _lag_calendar(project, r, p, a)
            if r.type == LinkType.FS:
                t = _add_lag(lcal, p.early_finish, r.lag_hours)
                es_floor = max(es_floor, t); start_links.append((r, t))
            elif r.type == LinkType.SS:
                t = _add_lag(lcal, p.early_start, r.lag_hours)
                es_floor = max(es_floor, t); start_links.append((r, t))
            elif r.type == LinkType.FF:
                t = _add_lag(lcal, p.early_finish, r.lag_hours)
                ef_floor = t if ef_floor is None else max(ef_floor, t); finish_links.append((r, t))
            elif r.type == LinkType.SF:
                t = _add_lag(lcal, p.early_start, r.lag_hours)
                ef_floor = t if ef_floor is None else max(ef_floor, t); finish_links.append((r, t))

        cd = a.constraint_date
        if cd is not None:
            if a.constraint in (Constraint.START_ON_OR_AFTER, Constraint.MUST_START_ON):
                es_floor = max(es_floor, cd) if a.constraint == Constraint.START_ON_OR_AFTER else cd
            elif a.constraint in (Constraint.FINISH_ON_OR_AFTER, Constraint.MUST_FINISH_ON):
                ef_floor = cd if (ef_floor is None or a.constraint == Constraint.MUST_FINISH_ON) else max(ef_floor, cd)

        if in_prog and mode == "retained":
            # remaining work by the logic: after every FS/SS predecessor date, never before the resume point
            es = a.actual_start
            rs_floor = resume
            for r, t in start_links:
                if t > rs_floor:
                    rs_floor = t
            rs = cal.next_working_start(rs_floor)
            rem_es[a.id] = rs
            ef = cal.add_hours(rs, rem) if rem > 0 else rs
            finish_rules = ef_floor is not None and ef_floor >= ef
            start_rules = not (ef_floor is not None and ef_floor > ef)
            if ef_floor is not None and ef_floor > ef:
                ef = ef_floor
            for r, t in start_links:
                r.driving = start_rules and t == rs_floor
            for r, t in finish_links:
                r.driving = finish_rules and t == ef_floor
        elif in_prog:
            es = a.actual_start
            ef = ef_floor if ef_floor is not None else cal.add_hours(resume, rem)
        elif a.type == ActivityType.FINISH_MILESTONE:
            # finish milestones sit on the predecessor's finish, not the next morning
            target = es_floor if ef_floor is None else max(es_floor, ef_floor)
            es = ef = target if cal.in_shift(target) else cal.prev_working_end(target)
            for r, t in start_links + finish_links:
                r.driving = t == target
        else:
            es = cal.next_working_start(es_floor)
            if new_day and a.status == Status.NOT_STARTED:
                es = _new_day_start(cal, es)
            ef = cal.add_hours(es, rem) if rem > 0 else es
            finish_rules = ef_floor is not None and ef_floor >= ef
            start_rules = not (ef_floor is not None and ef_floor > ef)
            if ef_floor is not None and ef_floor > ef:
                ef = ef_floor if rem > 0 else cal.prev_working_end(ef_floor)
                es = cal.add_hours(ef, -rem) if rem > 0 else ef
            for r, t in start_links:
                r.driving = start_rules and t == es_floor
            for r, t in finish_links:
                r.driving = finish_rules and t == ef_floor
        if a.status == Status.NOT_STARTED and cd is not None and a.constraint in (Constraint.MUST_START_ON, Constraint.MUST_FINISH_ON):
            for r, _ in start_links + finish_links:
                r.driving = False
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
        cal = sched_calendar(project, a)
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
            if s.status == Status.COMPLETE or (mode == "override" and _in_progress(s)):
                continue
            lcal = _lag_calendar(project, r, a, s)
            s_ls = rem_ls.get(s.id, s.late_start) if mode == "retained" else s.late_start
            if r.type == LinkType.FS:
                t = _add_lag(lcal, s_ls, -r.lag_hours)
                lf_ceil = min(lf_ceil, t)
            elif r.type == LinkType.SS:
                t = _add_lag(lcal, s_ls, -r.lag_hours)
                ls_ceil = t if ls_ceil is None else min(ls_ceil, t)
            elif r.type == LinkType.FF:
                t = _add_lag(lcal, s.late_finish, -r.lag_hours)
                lf_ceil = min(lf_ceil, t)
            elif r.type == LinkType.SF:
                t = _add_lag(lcal, s.late_finish, -r.lag_hours)
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
            rem_ls[a.id] = ls
            ls = a.actual_start
        a.late_start, a.late_finish = ls, lf

        a.total_float_hours = round(cal.hours_between(a.early_finish, a.late_finish), 4)
        # free float: earliest successor-driven slack
        ff: Optional[float] = None
        for r in succs[a.id]:
            s = amap[r.successor_id]
            if mode == "override" and _in_progress(s):
                continue
            lcal = _lag_calendar(project, r, a, s)
            s_es = rem_es.get(s.id, s.early_start) if mode == "retained" else s.early_start
            if r.type == LinkType.FS:
                slack = cal.hours_between(_add_lag(lcal, a.early_finish, r.lag_hours), s_es)
            elif r.type == LinkType.SS:
                slack = cal.hours_between(_add_lag(lcal, a.early_start, r.lag_hours), s_es)
            elif r.type == LinkType.FF:
                slack = cal.hours_between(_add_lag(lcal, a.early_finish, r.lag_hours), s.early_finish)
            else:
                slack = cal.hours_between(_add_lag(lcal, a.early_start, r.lag_hours), s.early_finish)
            ff = slack if ff is None else min(ff, slack)
        a.free_float_hours = round(a.total_float_hours if ff is None else max(0.0, ff), 4)

    # critical = the longest path: trace back from the activities that set the project finish
    # through driving links (P6's and Asta's "longest path"). Negative float is reported separately (DCMA).
    # Tracing logic, rather than picking the lowest float, stays right with mixed calendars,
    # deadlines and parallel chains that happen to share a float value.
    open_acts = _open_activities(project)
    on_path: set[str] = set()
    if open_acts:
        end = max(a.early_finish for a in open_acts)
        on_path = _trace_driving([a for a in open_acts if a.early_finish >= end], preds, amap, set())
    for a in project.activities:
        if a.status == Status.COMPLETE or a.total_float_hours is None:
            a.critical = False
        else:
            a.critical = a.id in on_path

    # multiple float paths (P6): path 1 is the longest path above, then the next most critical chains
    paths = float_paths(project, project.float_paths) if project.float_paths else {}
    for a in project.activities:
        a.float_path = paths.get(a.id)

    # hammocks (level of effort): start with the earliest SS predecessor, finish with the latest FF predecessor;
    # with no such links they span the activities in their own WBS node
    for a in project.activities:
        if a.type != ActivityType.LOE or a.status == Status.COMPLETE:
            continue
        cal = sched_calendar(project, a)
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

    # near-critical: open, off the longest path, total float within the threshold (working days of the activity's own calendar)
    near_days = DEFAULT_NEAR_CRITICAL_DAYS if project.near_critical_days is None else project.near_critical_days
    for a in project.activities:
        a.near_critical = (a.status != Status.COMPLETE and a.type != ActivityType.LOE and not a.critical
                           and a.total_float_hours is not None
                           and a.total_float_hours <= near_days * sched_calendar(project, a).hours_per_day)

    project.scheduled_at = datetime.now()
    return project


def _open_activities(project: Project) -> list[Activity]:
    """The activities the longest path and float paths are traced over: unfinished, scheduled, not hammocks."""
    return [a for a in project.activities if a.status != Status.COMPLETE and a.early_finish and a.type != ActivityType.LOE]


def _trace_driving(seeds: list[Activity], preds, amap, taken: set[str]) -> set[str]:
    """Trace back from seeds through driving links over open, non-hammock predecessors, never entering `taken`."""
    found: set[str] = set()
    stack = list(seeds)
    while stack:
        a = stack.pop()
        if a.id in found or a.id in taken:
            continue
        found.add(a.id)
        for r in preds[a.id]:
            p = amap[r.predecessor_id]
            if r.driving and p.status != Status.COMPLETE and p.type != ActivityType.LOE:
                stack.append(p)
    return found


def float_paths(project: Project, n: Optional[int]) -> dict[str, int]:
    """P6-style multiple float paths over a scheduled project: {activity id: path number}, a pure function.

    Path 1 is the longest path: the driving-link chain traced back from the open activities that finish last.
    Path k (k = 2..n, n capped at 10) takes the open activities on no earlier path, seeds on the one with the least
    total float (ties: the latest early finish, then the earliest in project order, so a chain is entered at its end)
    and traces the driving-link chain back from it, stopping at activities already on a path, at complete activities
    and at hammocks. Tracing stops when every open activity has a path. Needs early dates, floats and driving flags, so
    call it on a scheduled project; schedule() does so itself when Project.float_paths is set."""
    if not n or n < 1:
        return {}
    n = min(int(n), MAX_FLOAT_PATHS)
    amap = project.activity_map()
    preds = defaultdict(list)
    for r in project.relationships:
        preds[r.successor_id].append(r)
    open_acts = _open_activities(project)
    out: dict[str, int] = {}
    if not open_acts:
        return out
    taken: set[str] = set()
    end = max(a.early_finish for a in open_acts)
    seeds = [a for a in open_acts if a.early_finish >= end]
    for k in range(1, n + 1):
        if k > 1:
            rest = [a for a in open_acts if a.id not in taken]
            if not rest:
                break
            best = None
            for i, a in enumerate(rest):
                tf = a.total_float_hours if a.total_float_hours is not None else float("inf")
                key = (tf, -a.early_finish.timestamp(), i)
                if best is None or key < best[0]:
                    best = (key, a)
            seeds = [best[1]]
        for aid in _trace_driving(seeds, preds, amap, taken):
            out[aid] = k
            taken.add(aid)
    return out


def critical_path(project: Project) -> list[Activity]:
    return [a for a in project.activities if a.critical and a.status != Status.COMPLETE]

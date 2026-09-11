"""MS Project XML (MSPDI) import / export.

This is the interchange route for Asta Powerproject: Asta opens and saves MSPDI
XML natively, so `Asta -> Export MS Project XML -> here -> Export -> Asta` is a
lossless-enough loop for logic, durations, calendars and progress.
"""
from __future__ import annotations

import re
from datetime import date, datetime, time, timedelta
from xml.etree import ElementTree as ET

from .model import (Activity, ActivityType, Assignment, Calendar, Constraint, LinkType, Project,
                    Relationship, Resource, Status, WBSNode)

NS = "http://schemas.microsoft.com/project"
ISO = "%Y-%m-%dT%H:%M:%S"
LINK_IN = {"0": LinkType.FF, "1": LinkType.FS, "2": LinkType.SF, "3": LinkType.SS}
LINK_OUT = {v: k for k, v in LINK_IN.items()}
CSTR_IN = {
    "0": Constraint.NONE, "1": Constraint.AS_LATE_AS_POSSIBLE, "2": Constraint.MUST_START_ON,
    "3": Constraint.MUST_FINISH_ON, "4": Constraint.START_ON_OR_AFTER, "5": Constraint.START_ON_OR_BEFORE,
    "6": Constraint.FINISH_ON_OR_AFTER, "7": Constraint.FINISH_ON_OR_BEFORE,
}
CSTR_OUT = {v: k for k, v in CSTR_IN.items()}
RES_IN = {"0": "material", "1": "labour", "2": "cost"}
RES_OUT = {"material": "0", "labour": "1", "equipment": "1", "cost": "2"}


def _q(tag: str) -> str:
    return f"{{{NS}}}{tag}"


def _text(el: ET.Element | None, tag: str, default: str = "") -> str:
    if el is None:
        return default
    x = el.find(_q(tag))
    return (x.text or default) if x is not None and x.text is not None else default


def _dt(s: str) -> datetime | None:
    s = (s or "").strip()
    if not s:
        return None
    try:
        return datetime.strptime(s[:19], ISO)
    except ValueError:
        try:
            return datetime.strptime(s[:10], "%Y-%m-%d")
        except ValueError:
            return None


def parse_duration_hours(s: str) -> float:
    """PT16H30M0S -> 16.5"""
    m = re.match(r"P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?", s or "")
    if not m:
        return 0.0
    d, h, mi, sec = (float(x) if x else 0.0 for x in m.groups())
    return d * 8 + h + mi / 60 + sec / 3600


def fmt_duration(hours: float) -> str:
    h = int(hours)
    m = int(round((hours - h) * 60))
    return f"PT{h}H{m}M0S"


def _fmt(dt: datetime | None) -> str:
    return dt.strftime(ISO) if dt else ""


# --------------------------------------------------------------------------------------
# read
# --------------------------------------------------------------------------------------
def read_mspdi(text: str) -> Project:
    root = ET.fromstring(text)
    if root.tag != _q("Project"):
        # tolerate files without the namespace
        ns_free = re.sub(r'xmlns="[^"]*"', "", text, count=1)
        root = ET.fromstring(ns_free)
        global NS
        saved, NS = NS, ""
        try:
            return _read(root)
        finally:
            NS = saved
    return _read(root)


def _read(root: ET.Element) -> Project:
    minutes_per_day = float(_text(root, "MinutesPerDay", "480") or 480)
    hpd_default = minutes_per_day / 60

    cals: dict[str, Calendar] = {}
    for c in root.findall(f"{_q('Calendars')}/{_q('Calendar')}"):
        uid = _text(c, "UID")
        cal = Calendar(id=uid, name=_text(c, "Name") or f"Calendar {uid}", hours_per_day=hpd_default)
        wd, hours, first_start = [], [], None
        for day in c.findall(f"{_q('WeekDays')}/{_q('WeekDay')}"):
            dtype = int(_text(day, "DayType", "0") or 0)
            working = _text(day, "DayWorking", "0") == "1"
            if dtype < 1 or dtype > 7:
                continue
            if working:
                h = 0.0
                for wt in day.findall(f"{_q('WorkingTimes')}/{_q('WorkingTime')}"):
                    a, b = _hm(_text(wt, "FromTime")), _hm(_text(wt, "ToTime"))
                    if first_start is None:
                        first_start = a
                    h += ((b.hour * 60 + b.minute) - (a.hour * 60 + a.minute)) / 60
                wd.append((dtype - 2) % 7)
                hours.append(h or hpd_default)
        if wd:
            cal.working_days = sorted(wd)
            cal.hours_per_day = round(max(set(hours), key=hours.count), 2)
        if first_start:
            cal.day_start = first_start
        for ex in c.findall(f"{_q('Exceptions')}/{_q('Exception')}"):
            tp = ex.find(_q("TimePeriod"))
            a, b = _dt(_text(tp, "FromDate")), _dt(_text(tp, "ToDate"))
            if not a or not b:
                continue
            working = _text(ex, "DayWorking", "0") == "1"
            h = 0.0
            if working:
                for wt in ex.findall(f"{_q('WorkingTimes')}/{_q('WorkingTime')}"):
                    fa, fb = _hm(_text(wt, "FromTime")), _hm(_text(wt, "ToTime"))
                    h += ((fb.hour * 60 + fb.minute) - (fa.hour * 60 + fa.minute)) / 60
            d = a.date()
            while d <= b.date():
                cal.exceptions[d] = h
                d += timedelta(days=1)
        cals[uid] = cal

    default_cal = _text(root, "CalendarUID") or (next(iter(cals)) if cals else "std")
    project = Project(
        id=re.sub(r"[^A-Za-z0-9_-]+", "-", _text(root, "Name") or "PROJECT")[:20] or "PROJECT",
        name=_text(root, "Title") or _text(root, "Name") or "Project",
        start=_dt(_text(root, "StartDate")) or datetime.now().replace(hour=8, minute=0, second=0, microsecond=0),
        data_date=_dt(_text(root, "StatusDate")),
        default_calendar_id=default_cal, calendars=cals,
    )

    uid_to_id: dict[str, str] = {}
    stack: list[tuple[int, str]] = []  # (outline level, wbs id)
    pending_links: list[tuple[str, ET.Element]] = []
    for t in root.findall(f"{_q('Tasks')}/{_q('Task')}"):
        uid = _text(t, "UID")
        name = _text(t, "Name")
        level = int(_text(t, "OutlineLevel", "1") or 1)
        summary = _text(t, "Summary", "0") == "1"
        if uid == "0" or level == 0:
            if name:
                project.name = name
            continue
        while stack and stack[-1][0] >= level:
            stack.pop()
        parent = stack[-1][1] if stack else None
        if summary:
            wid = f"W{uid}"
            project.wbs.append(WBSNode(id=wid, name=name, parent_id=parent, code=_text(t, "OutlineNumber") or None,
                                       seq=int(_text(t, "ID", "0") or 0)))
            stack.append((level, wid))
            continue
        aid = _text(t, "WBS") or f"A{uid}"
        if any(a.id == aid for a in project.activities):
            aid = f"A{uid}"
        uid_to_id[uid] = aid
        pct = float(_text(t, "PercentComplete", "0") or 0)
        actual_start, actual_finish = _dt(_text(t, "ActualStart")), _dt(_text(t, "ActualFinish"))
        status = Status.COMPLETE if actual_finish or pct >= 100 else Status.IN_PROGRESS if actual_start or pct > 0 else Status.NOT_STARTED
        milestone = _text(t, "Milestone", "0") == "1"
        dur = parse_duration_hours(_text(t, "Duration"))
        rem = parse_duration_hours(_text(t, "RemainingDuration")) if t.find(_q("RemainingDuration")) is not None else None
        cal_uid = _text(t, "CalendarUID")
        a = Activity(
            id=aid, name=name, wbs_id=parent,
            calendar_id=cal_uid if cal_uid and cal_uid != "-1" and cal_uid in cals else None,
            type=(ActivityType.FINISH_MILESTONE if milestone and dur == 0 and t.find(_q("PredecessorLink")) is not None
                  else ActivityType.START_MILESTONE if milestone and dur == 0 else ActivityType.TASK),
            duration_hours=dur,
            constraint=CSTR_IN.get(_text(t, "ConstraintType", "0"), Constraint.NONE),
            constraint_date=_dt(_text(t, "ConstraintDate")),
            status=status, actual_start=actual_start, actual_finish=actual_finish,
            remaining_hours=rem if status != Status.NOT_STARTED else None, percent_complete=pct,
            early_start=_dt(_text(t, "Start")), early_finish=_dt(_text(t, "Finish")),
            late_start=_dt(_text(t, "LateStart")), late_finish=_dt(_text(t, "LateFinish")),
            baseline_start=_dt(_text(t.find(f"{_q('Baseline')}"), "Start")) if t.find(_q("Baseline")) is not None else None,
            baseline_finish=_dt(_text(t.find(f"{_q('Baseline')}"), "Finish")) if t.find(_q("Baseline")) is not None else None,
            notes=_text(t, "Notes"),
        )
        project.activities.append(a)
        for link in t.findall(_q("PredecessorLink")):
            pending_links.append((uid, link))

    for succ_uid, link in pending_links:
        pred_uid = _text(link, "PredecessorUID")
        if pred_uid in uid_to_id and succ_uid in uid_to_id:
            lag_raw = float(_text(link, "LinkLag", "0") or 0)
            lag_fmt = _text(link, "LagFormat", "7")
            lag_hours = lag_raw / 600.0 if lag_fmt not in ("19", "35", "51", "53") else lag_raw / 600.0
            project.relationships.append(Relationship(
                predecessor_id=uid_to_id[pred_uid], successor_id=uid_to_id[succ_uid],
                type=LINK_IN.get(_text(link, "Type", "1"), LinkType.FS), lag_hours=lag_hours))

    res_by_uid: dict[str, Resource] = {}
    for r in root.findall(f"{_q('Resources')}/{_q('Resource')}"):
        uid = _text(r, "UID")
        if uid == "0" and not _text(r, "Name"):
            continue
        rid = re.sub(r"\s+", "_", _text(r, "Initials") or _text(r, "Name") or f"R{uid}")[:20]
        res = Resource(id=rid, name=_text(r, "Name") or rid, type=RES_IN.get(_text(r, "Type", "1"), "labour"),
                       rate=float(_text(r, "StandardRate", "0") or 0))
        res_by_uid[uid] = res
        project.resources.append(res)
    for x in root.findall(f"{_q('Assignments')}/{_q('Assignment')}"):
        tu, ru = _text(x, "TaskUID"), _text(x, "ResourceUID")
        if tu in uid_to_id and ru in res_by_uid:
            project.assignments.append(Assignment(activity_id=uid_to_id[tu], resource_id=res_by_uid[ru].id,
                                                  units=parse_duration_hours(_text(x, "Work")),
                                                  cost=float(_text(x, "Cost", "0") or 0)))
    project.ensure_default_calendar()
    return project


def _hm(s: str) -> time:
    try:
        return datetime.strptime(s[:8], "%H:%M:%S").time()
    except ValueError:
        return time(8, 0)


def read_mspdi_file(path: str) -> Project:
    return read_mspdi(open(path, "rb").read().decode("utf-8", errors="replace"))


# --------------------------------------------------------------------------------------
# write
# --------------------------------------------------------------------------------------
def _sub(parent: ET.Element, tag: str, text: str | int | float | None = None) -> ET.Element:
    el = ET.SubElement(parent, _q(tag))
    if text is not None:
        el.text = str(text)
    return el


def write_mspdi(project: Project) -> str:
    project.ensure_default_calendar()
    ET.register_namespace("", NS)
    root = ET.Element(f"{{{NS}}}Project")
    cal_uid = {cid: i + 1 for i, cid in enumerate(project.calendars)}
    dcal = project.calendars[project.default_calendar_id]
    _sub(root, "SaveVersion", 14)
    _sub(root, "Name", project.name)
    _sub(root, "Title", project.name)
    _sub(root, "ScheduleFromStart", 1)
    _sub(root, "StartDate", _fmt(project.start))
    _sub(root, "FinishDate", _fmt(project.finish or project.start))
    _sub(root, "StatusDate", _fmt(project.data_date or project.start))
    _sub(root, "CurrentDate", _fmt(datetime.now()))
    _sub(root, "CalendarUID", cal_uid[project.default_calendar_id])
    _sub(root, "DefaultStartTime", dcal.day_start.strftime("%H:%M:%S"))
    end = (datetime.combine(date.today(), dcal.day_start) + timedelta(hours=dcal.hours_per_day)).time()
    _sub(root, "DefaultFinishTime", end.strftime("%H:%M:%S"))
    _sub(root, "MinutesPerDay", int(dcal.hours_per_day * 60))
    _sub(root, "MinutesPerWeek", int(dcal.hours_per_day * 60 * len(dcal.working_days)))
    _sub(root, "DaysPerMonth", 20)
    _sub(root, "DurationFormat", 7)
    _sub(root, "NewTasksAreManual", 0)

    cals = _sub(root, "Calendars")
    for cid, cal in project.calendars.items():
        c = _sub(cals, "Calendar")
        _sub(c, "UID", cal_uid[cid])
        _sub(c, "Name", cal.name)
        _sub(c, "IsBaseCalendar", 1)
        _sub(c, "BaseCalendarUID", -1)
        wds = _sub(c, "WeekDays")
        for dtype in range(1, 8):
            wd = _sub(wds, "WeekDay")
            _sub(wd, "DayType", dtype)
            working = (dtype - 2) % 7 in cal.working_days
            _sub(wd, "DayWorking", 1 if working else 0)
            if working:
                wts = _sub(wd, "WorkingTimes")
                wt = _sub(wts, "WorkingTime")
                _sub(wt, "FromTime", cal.day_start.strftime("%H:%M:%S"))
                fin = (datetime.combine(date.today(), cal.day_start) + timedelta(hours=cal.hours_per_day)).time()
                _sub(wt, "ToTime", fin.strftime("%H:%M:%S"))
        if cal.exceptions:
            exs = _sub(c, "Exceptions")
            for d, h in sorted(cal.exceptions.items()):
                ex = _sub(exs, "Exception")
                tp = _sub(ex, "TimePeriod")
                _sub(tp, "FromDate", datetime.combine(d, time.min).strftime(ISO))
                _sub(tp, "ToDate", datetime.combine(d, time(23, 59)).strftime(ISO))
                _sub(ex, "Occurrences", 1)
                _sub(ex, "Name", "Non-working" if h == 0 else "Working exception")
                _sub(ex, "Type", 1)
                _sub(ex, "DayWorking", 1 if h > 0 else 0)
                if h > 0:
                    wts = _sub(ex, "WorkingTimes")
                    wt = _sub(wts, "WorkingTime")
                    _sub(wt, "FromTime", cal.day_start.strftime("%H:%M:%S"))
                    fin = (datetime.combine(date.today(), cal.day_start) + timedelta(hours=h)).time()
                    _sub(wt, "ToTime", fin.strftime("%H:%M:%S"))

    tasks = _sub(root, "Tasks")
    uid = 0
    t0 = _sub(tasks, "Task")
    _sub(t0, "UID", 0); _sub(t0, "ID", 0); _sub(t0, "Name", project.name); _sub(t0, "Type", 1)
    _sub(t0, "OutlineNumber", 0); _sub(t0, "OutlineLevel", 0); _sub(t0, "Summary", 1)
    _sub(t0, "Start", _fmt(project.start)); _sub(t0, "Finish", _fmt(project.finish or project.start))

    # order: WBS tree depth-first, activities under their WBS, unassigned activities last
    children: dict[str | None, list[WBSNode]] = {}
    for w in project.wbs:
        children.setdefault(w.parent_id, []).append(w)
    acts_by_wbs: dict[str | None, list[Activity]] = {}
    for a in project.activities:
        acts_by_wbs.setdefault(a.wbs_id if any(w.id == a.wbs_id for w in project.wbs) else None, []).append(a)
    task_uid: dict[str, int] = {}
    counter = [0]

    def outline(parent: str | None, level: int, prefix: str):
        n = 0
        for w in sorted(children.get(parent, []), key=lambda x: (x.seq, x.name)):
            n += 1
            counter[0] += 1
            el = _sub(tasks, "Task")
            _sub(el, "UID", counter[0]); _sub(el, "ID", counter[0]); _sub(el, "Name", w.name); _sub(el, "Type", 1)
            _sub(el, "OutlineNumber", f"{prefix}{n}"); _sub(el, "OutlineLevel", level); _sub(el, "Summary", 1)
            _sub(el, "WBS", w.code or w.id)
            outline(w.id, level + 1, f"{prefix}{n}.")
        for a in acts_by_wbs.get(parent, []):
            n += 1
            counter[0] += 1
            task_uid[a.id] = counter[0]
            _task(tasks, a, counter[0], level, f"{prefix}{n}")

    def _task(parent_el, a: Activity, uid_: int, level: int, outline_no: str):
        el = _sub(parent_el, "Task")
        _sub(el, "UID", uid_); _sub(el, "ID", uid_); _sub(el, "Name", a.name); _sub(el, "Type", 1)
        _sub(el, "IsNull", 0)
        _sub(el, "WBS", a.id)
        _sub(el, "OutlineNumber", outline_no); _sub(el, "OutlineLevel", level)
        _sub(el, "Priority", 500)
        _sub(el, "Start", _fmt(a.start)); _sub(el, "Finish", _fmt(a.finish))
        _sub(el, "Duration", fmt_duration(a.duration_hours)); _sub(el, "DurationFormat", 7)
        rem = a.remaining_hours if a.remaining_hours is not None else (0 if a.status == Status.COMPLETE else a.duration_hours)
        _sub(el, "RemainingDuration", fmt_duration(rem))
        _sub(el, "ManualStart", _fmt(a.start)); _sub(el, "ManualFinish", _fmt(a.finish))
        _sub(el, "ManualDuration", fmt_duration(a.duration_hours))
        _sub(el, "ConstraintType", CSTR_OUT.get(a.constraint, "0"))
        if a.constraint_date and a.constraint != Constraint.NONE:
            _sub(el, "ConstraintDate", _fmt(a.constraint_date))
        _sub(el, "CalendarUID", cal_uid.get(a.calendar_id, -1) if a.calendar_id else -1)
        _sub(el, "Milestone", 1 if a.is_milestone else 0)
        _sub(el, "Summary", 0)
        _sub(el, "Critical", 1 if a.critical else 0)
        _sub(el, "IsSubproject", 0)
        _sub(el, "EarlyStart", _fmt(a.early_start)); _sub(el, "EarlyFinish", _fmt(a.early_finish))
        _sub(el, "LateStart", _fmt(a.late_start)); _sub(el, "LateFinish", _fmt(a.late_finish))
        if a.total_float_hours is not None:
            _sub(el, "TotalSlack", int(a.total_float_hours * 600)); _sub(el, "FreeSlack", int((a.free_float_hours or 0) * 600))
        _sub(el, "PercentComplete", int(a.percent_complete if a.status != Status.COMPLETE else 100))
        if a.actual_start:
            _sub(el, "ActualStart", _fmt(a.actual_start))
        if a.actual_finish:
            _sub(el, "ActualFinish", _fmt(a.actual_finish))
        if a.notes:
            _sub(el, "Notes", a.notes)
        if a.baseline_start or a.baseline_finish:
            b = _sub(el, "Baseline")
            _sub(b, "Number", 0)
            _sub(b, "Start", _fmt(a.baseline_start)); _sub(b, "Finish", _fmt(a.baseline_finish))
        return el

    outline(None, 1, "")
    # predecessor links need every UID assigned first
    for el in tasks.findall(_q("Task")):
        wbs = _text(el, "WBS")
        if _text(el, "Summary") == "1" or wbs not in task_uid:
            continue
        for r in project.predecessors_of(wbs):
            if r.predecessor_id not in task_uid:
                continue
            link = _sub(el, "PredecessorLink")
            _sub(link, "PredecessorUID", task_uid[r.predecessor_id])
            _sub(link, "Type", LINK_OUT[r.type])
            _sub(link, "CrossProject", 0)
            _sub(link, "LinkLag", int(r.lag_hours * 600))
            _sub(link, "LagFormat", 7)

    res_uid = {r.id: i + 1 for i, r in enumerate(project.resources)}
    resources = _sub(root, "Resources")
    for r in project.resources:
        el = _sub(resources, "Resource")
        _sub(el, "UID", res_uid[r.id]); _sub(el, "ID", res_uid[r.id]); _sub(el, "Name", r.name)
        _sub(el, "Type", RES_OUT.get(r.type, "1")); _sub(el, "Initials", r.id[:10])
        _sub(el, "StandardRate", r.rate); _sub(el, "MaxUnits", (r.max_units_per_day or 1))
    assignments = _sub(root, "Assignments")
    for i, x in enumerate(project.assignments):
        if x.activity_id not in task_uid or x.resource_id not in res_uid:
            continue
        el = _sub(assignments, "Assignment")
        _sub(el, "UID", i + 1); _sub(el, "TaskUID", task_uid[x.activity_id]); _sub(el, "ResourceUID", res_uid[x.resource_id])
        _sub(el, "Units", 1); _sub(el, "Work", fmt_duration(x.units)); _sub(el, "Cost", x.cost)

    ET.indent(root)
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' + ET.tostring(root, encoding="unicode")


def write_mspdi_file(project: Project, path: str) -> None:
    with open(path, "w", encoding="utf-8") as f:
        f.write(write_mspdi(project))

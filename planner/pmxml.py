"""Primavera P6 XML (PMXML, root <APIBusinessObjects>) reader.

P6 Professional and EPPM export this from File > Export > Primavera P6 XML.
Namespaces vary by version, so tags are matched by local name.
"""
from __future__ import annotations

import re
from datetime import datetime, time, timedelta
from xml.etree import ElementTree as ET

from .model import (Activity, ActivityType, Assignment, Calendar, Constraint, LinkType, Project,
                    Relationship, Resource, Status, WBSNode)

ACT_TYPE = {"Task Dependent": ActivityType.TASK, "Resource Dependent": ActivityType.TASK,
            "Start Milestone": ActivityType.START_MILESTONE, "Finish Milestone": ActivityType.FINISH_MILESTONE,
            "Level of Effort": ActivityType.LOE, "WBS Summary": ActivityType.LOE}
STATUS = {"Not Started": Status.NOT_STARTED, "In Progress": Status.IN_PROGRESS, "Completed": Status.COMPLETE}
CSTR = {"Start On or After": Constraint.START_ON_OR_AFTER, "Start On or Before": Constraint.START_ON_OR_BEFORE,
        "Finish On or After": Constraint.FINISH_ON_OR_AFTER, "Finish On or Before": Constraint.FINISH_ON_OR_BEFORE,
        "Start On": Constraint.MUST_START_ON, "Finish On": Constraint.MUST_FINISH_ON,
        "Mandatory Start": Constraint.MUST_START_ON, "Mandatory Finish": Constraint.MUST_FINISH_ON,
        "As Late As Possible": Constraint.AS_LATE_AS_POSSIBLE}
LINK = {"Finish to Start": LinkType.FS, "Start to Start": LinkType.SS, "Finish to Finish": LinkType.FF, "Start to Finish": LinkType.SF}
DAYS = {"Monday": 0, "Tuesday": 1, "Wednesday": 2, "Thursday": 3, "Friday": 4, "Saturday": 5, "Sunday": 6}
RES_TYPE = {"Labor": "labour", "Nonlabor": "equipment", "Material": "material"}


def _local(tag: str) -> str:
    return tag.split("}", 1)[-1]


def _kids(el: ET.Element, name: str) -> list[ET.Element]:
    return [c for c in el if _local(c.tag) == name]


def _text(el: ET.Element | None, name: str, default: str = "") -> str:
    if el is None:
        return default
    for c in el:
        if _local(c.tag) == name:
            return (c.text or default) if c.text is not None else default
    return default


def _dt(s: str) -> datetime | None:
    s = (s or "").strip()
    if not s:
        return None
    try:
        return datetime.strptime(s[:19], "%Y-%m-%dT%H:%M:%S")
    except ValueError:
        return None


def _f(s: str, default: float = 0.0) -> float:
    try:
        return float(s)
    except (TypeError, ValueError):
        return default


def _hm(s: str) -> time:
    try:
        return datetime.strptime(s[:8], "%H:%M:%S").time()
    except ValueError:
        return time(8, 0)


def _worktime_hours(el: ET.Element) -> tuple[float, time | None]:
    total, first = 0.0, None
    for wt in _kids(el, "WorkTime"):
        st, fi = _text(wt, "Start"), _text(wt, "Finish")
        if not st or not fi:
            continue
        a, b = _hm(st), _hm(fi)
        if first is None:
            first = a
        mins = (b.hour * 60 + b.minute) - (a.hour * 60 + a.minute)
        if b.second == 59 or fi.startswith("23:59"):
            mins += 1
        if b.minute == 59:  # P6 writes 15:59:00 for a shift ending 16:00
            mins += 1
        total += max(0, mins) / 60
    snapped = round(total * 4) / 4  # P6 writes 15:59 for a 16:00 finish; snap to the quarter hour
    return (snapped if abs(snapped - total) < 0.06 else round(total, 2)), first


def _calendar(el: ET.Element) -> Calendar:
    cal = Calendar(id=_text(el, "ObjectId"), name=_text(el, "Name") or "Calendar", hours_per_day=_f(_text(el, "HoursPerDay"), 8) or 8)
    week = _kids(el, "StandardWorkWeek")
    wd, hours, first_start = [], [], None
    if week:
        for d in _kids(week[0], "StandardWorkHours"):
            name = _text(d, "DayOfWeek")
            h, start = _worktime_hours(d)
            if h > 0 and name in DAYS:
                wd.append(DAYS[name])
                hours.append(h)
                first_start = first_start or start
    if wd:
        cal.working_days = sorted(wd)
        cal.hours_per_day = max(set(hours), key=hours.count)
    if first_start:
        cal.day_start = first_start
    for ex in _kids(el, "HolidayOrExceptions"):
        for h in _kids(ex, "HolidayOrException"):
            d = _dt(_text(h, "Date"))
            if d:
                cal.exceptions[d.date()] = _worktime_hours(h)[0]
    return cal


def read_pmxml(text: str, project_index: int = 0) -> Project:
    root = ET.fromstring(text)
    if _local(root.tag) != "APIBusinessObjects":
        raise ValueError("Not a P6 XML file (expected <APIBusinessObjects>)")
    projects = _kids(root, "Project")
    if not projects:
        raise ValueError("P6 XML has no <Project>")
    pe = projects[min(project_index, len(projects) - 1)]

    cals: dict[str, Calendar] = {}
    for c in _kids(root, "Calendar") + _kids(pe, "Calendar"):
        cal = _calendar(c)
        cals[cal.id] = cal

    default_cal = _text(pe, "ActivityDefaultCalendarObjectId") or (next(iter(cals)) if cals else "std")
    start = _dt(_text(pe, "PlannedStartDate")) or _dt(_text(pe, "DataDate")) or datetime.now().replace(hour=8, minute=0, second=0, microsecond=0)
    project = Project(id=(_text(pe, "Id") or "PROJ")[:20], name=_text(pe, "Name") or _text(pe, "Id") or "Project",
                      start=start, data_date=_dt(_text(pe, "DataDate")), must_finish_by=_dt(_text(pe, "MustFinishByDate")),
                      default_calendar_id=default_cal, calendars=cals, description=_text(pe, "Description"))

    root_wbs = _text(pe, "WBSObjectId")
    wbs_by_obj: dict[str, str] = {}
    for w in _kids(pe, "WBS"):
        oid = _text(w, "ObjectId")
        if oid == root_wbs or not _text(w, "ParentObjectId"):
            continue
        code = _text(w, "Code") or oid
        wbs_by_obj[oid] = code
    for w in _kids(pe, "WBS"):
        oid = _text(w, "ObjectId")
        if oid not in wbs_by_obj:
            continue
        parent = _text(w, "ParentObjectId")
        project.wbs.append(WBSNode(id=wbs_by_obj[oid], code=wbs_by_obj[oid], name=_text(w, "Name"),
                                   parent_id=wbs_by_obj.get(parent), seq=int(_f(_text(w, "SequenceNumber")))))

    act_by_obj: dict[str, str] = {}
    for a in _kids(pe, "Activity"):
        oid = _text(a, "ObjectId")
        aid = _text(a, "Id") or f"A{oid}"
        act_by_obj[oid] = aid
        status = STATUS.get(_text(a, "Status"), Status.NOT_STARTED)
        planned, remain = _f(_text(a, "PlannedDuration")), _f(_text(a, "RemainingDuration"))
        pct_type = _text(a, "PercentCompleteType")
        if status == Status.COMPLETE:
            pct = 100.0
        elif status == Status.NOT_STARTED:
            pct = 0.0
        elif pct_type == "Physical":
            pct = 100 * _f(_text(a, "PhysicalPercentComplete"))
        elif pct_type == "Units":
            pct = 100 * _f(_text(a, "UnitsPercentComplete"))
        else:
            pct = 100 * _f(_text(a, "DurationPercentComplete")) if _text(a, "DurationPercentComplete") else (100 * (planned - remain) / planned if planned else 0)
        act_start, act_fin = _dt(_text(a, "ActualStartDate")), _dt(_text(a, "ActualFinishDate"))
        if status != Status.NOT_STARTED and act_start is None:
            act_start = _dt(_text(a, "StartDate")) or _dt(_text(a, "PlannedStartDate"))
        if status == Status.COMPLETE and act_fin is None:
            act_fin = _dt(_text(a, "FinishDate")) or _dt(_text(a, "PlannedFinishDate")) or act_start
        cal_id = _text(a, "CalendarObjectId")
        project.activities.append(Activity(
            id=aid, name=_text(a, "Name"), wbs_id=wbs_by_obj.get(_text(a, "WBSObjectId")),
            calendar_id=cal_id if cal_id in cals else None,
            type=ACT_TYPE.get(_text(a, "Type"), ActivityType.TASK), duration_hours=planned,
            constraint=CSTR.get(_text(a, "PrimaryConstraintType"), Constraint.NONE),
            constraint_date=_dt(_text(a, "PrimaryConstraintDate")),
            status=status, actual_start=act_start, actual_finish=act_fin,
            remaining_hours=remain if status != Status.NOT_STARTED else None, percent_complete=round(pct, 2),
            early_start=_dt(_text(a, "StartDate")), early_finish=_dt(_text(a, "FinishDate")),
            late_start=_dt(_text(a, "RemainingLateStartDate")), late_finish=_dt(_text(a, "RemainingLateFinishDate")),
            baseline_start=_dt(_text(a, "PlannedStartDate")), baseline_finish=_dt(_text(a, "PlannedFinishDate")),
            notes=re.sub(r"<[^>]+>", "", _text(a, "NotesToResources"))[:500],
        ))

    for r in _kids(pe, "ActivityRelationship") + _kids(root, "ActivityRelationship"):
        p, s = _text(r, "PredecessorActivityObjectId"), _text(r, "SuccessorActivityObjectId")
        if p in act_by_obj and s in act_by_obj:
            project.relationships.append(Relationship(predecessor_id=act_by_obj[p], successor_id=act_by_obj[s],
                                                      type=LINK.get(_text(r, "Type"), LinkType.FS), lag_hours=_f(_text(r, "Lag"))))

    res_by_obj: dict[str, Resource] = {}
    for r in _kids(root, "Resource") + _kids(pe, "Resource"):
        oid = _text(r, "ObjectId")
        res = Resource(id=(_text(r, "Id") or f"R{oid}")[:20], name=_text(r, "Name") or oid,
                       type=RES_TYPE.get(_text(r, "ResourceType"), "labour"), rate=_f(_text(r, "PricePerUnit")))
        res_by_obj[oid] = res
    used = set()
    for x in _kids(pe, "ResourceAssignment") + _kids(root, "ResourceAssignment"):
        a, r = _text(x, "ActivityObjectId"), _text(x, "ResourceObjectId")
        if a in act_by_obj and r in res_by_obj:
            used.add(r)
            project.assignments.append(Assignment(activity_id=act_by_obj[a], resource_id=res_by_obj[r].id,
                                                  units=_f(_text(x, "PlannedUnits")), cost=_f(_text(x, "PlannedCost"))))
    project.resources = [res_by_obj[k] for k in res_by_obj if k in used]
    project.ensure_default_calendar()
    return project


def read_pmxml_file(path: str, project_index: int = 0) -> Project:
    return read_pmxml(open(path, "rb").read().decode("utf-8", errors="replace"), project_index)

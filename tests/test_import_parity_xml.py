"""Golden-master parity for XML import: web/import_xml.js must read P6 XML (PMXML) and MS Project
XML (MSPDI, also what Asta Powerproject exports) exactly as planner/pmxml.py and planner/mspxml.py
do, then schedule identically. Each case is read (and scheduled) by both; the read project, the
scheduled project and any error text are compared, with node under every timezone of the main
parity test. The XML parser itself is compared against ElementTree, error messages included.

Skipped when node is not installed.
"""
from __future__ import annotations

import base64
import copy
import json
import os
import re
import shutil
import subprocess
import xml.etree.ElementTree as ET
from datetime import date, datetime
from pathlib import Path
from zoneinfo import ZoneInfo
from xml.sax.saxutils import escape

import pytest

from planner.cpm import schedule
from planner.io import _xml_root_tag
from planner.levelling import set_baseline
from planner.model import Project, Status
from planner.mspxml import read_mspdi, write_mspdi
from planner.pmxml import read_pmxml
from tests.test_parity import BRIEFS, TIMEZONES, _generated, constraints, diff, hammocks, links_and_lags, norm, progress

ROOT = Path(__file__).resolve().parents[1]
FIX = Path(__file__).parent / "fixtures"
RUNNER = Path(__file__).parent / "parity" / "xml_runner.js"
NODE = shutil.which("node")
MSP_NS = "http://schemas.microsoft.com/project"
P6_NS = "http://xmlns.oracle.com/Primavera/P6Professional/V8.4/API/BusinessObjects"

pytestmark = pytest.mark.skipif(NODE is None, reason="node is not installed")


def _node(cases: list[dict], tz: str = "UTC") -> list[dict]:
    res = subprocess.run([NODE, str(RUNNER)], input=json.dumps({"cases": cases}), capture_output=True, text=True,
                         env={**os.environ, "TZ": tz}, timeout=300)
    assert res.returncode == 0, res.stderr[-3000:]
    return json.loads(res.stdout)


# ----------------------------------------------------------------------------------------
# sources
# ----------------------------------------------------------------------------------------
def _scheduled(data: dict) -> Project:
    p = Project.model_validate(copy.deepcopy(data))
    schedule(p)
    return p


def _corpus() -> list[tuple[str, dict]]:
    """Projects written out as MSPDI by both writers."""
    out = [(f"gen{i}", _generated(BRIEFS[i])) for i in (0, 1, 2, 4, 6)]
    out += [("progress", progress()), ("constraints", constraints()), ("hammocks", hammocks()), ("links", links_and_lags())]
    for name, fn in (("progress+baseline", progress), ("constraints+baseline", constraints)):
        p = Project.model_validate(fn())
        set_baseline(p, "Tender")                           # baseline dates, then move on: progress and a slip
        p.activities[-2].duration_hours += 16
        if name.startswith("constraints"):
            p.activities[1].status, p.activities[1].actual_start, p.activities[1].percent_complete = Status.IN_PROGRESS, p.activities[1].early_start, 30
        out.append((name, p.model_dump(mode="json")))
    odd = Project.model_validate(_generated(BRIEFS[2]))     # names that need escaping, and non-ASCII
    odd.name = "Résidence Ørsted & Co <2026> \"phase\" 'two'"
    odd.activities[3].name = "Café façade – phase 2 & <east> ✓ 𝔘"
    odd.activities[4].notes = "Line one\r\nline two & <three>\ttab"
    odd.resources[0].name = "Équipe façade & vitrage"
    out.append(("non-ascii", odd.model_dump(mode="json")))
    return out


def _mspdi_variants(text: str) -> list[tuple[str, str]]:
    """The same MSPDI document with its namespace spelled differently."""
    bare = text.replace(f' xmlns="{MSP_NS}"', "", 1)
    prefixed = re.sub(r"<(/?)([A-Za-z]\w*)", r"<\1msp:\2", text).replace(f'<msp:Project xmlns="{MSP_NS}"', f'<msp:Project xmlns:msp="{MSP_NS}"')
    other = text.replace(f'xmlns="{MSP_NS}"', 'xmlns="urn:example:other"', 1)
    return [("no-namespace", bare), ("prefixed", prefixed), ("other-namespace", other), ("bom", "﻿" + text),
            ("crlf", text.replace("\n", "\r\n"))]


P6_TYPE = {"task": "Task Dependent", "start_milestone": "Start Milestone", "finish_milestone": "Finish Milestone", "level_of_effort": "Level of Effort"}
P6_STATUS = {"not_started": "Not Started", "in_progress": "In Progress", "complete": "Completed"}
P6_CSTR = {"start_on_or_after": "Start On or After", "start_on_or_before": "Start On or Before", "finish_on_or_after": "Finish On or After",
           "finish_on_or_before": "Finish On or Before", "must_start_on": "Mandatory Start", "must_finish_on": "Finish On",
           "as_late_as_possible": "As Late As Possible"}
P6_LINK = {"FS": "Finish to Start", "SS": "Start to Start", "FF": "Finish to Finish", "SF": "Start to Finish"}
P6_DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]


def _e(tag: str, val) -> str:
    return f"<{tag}/>" if val is None else f"<{tag}>{escape(str(val))}</{tag}>"


def _p6(data: dict, *, ns: str = "default", pct_types=("Duration", "Physical", "Units", "")) -> str:
    """A P6-style XML export of a scheduled project (the shape P6 Professional writes)."""
    p = data
    cal_oid = {cid: 100 + i for i, cid in enumerate(p["calendars"])}
    wbs_oid = {w["id"]: 1000 + i for i, w in enumerate(p["wbs"])}
    act_oid = {a["id"]: 5000 + i for i, a in enumerate(p["activities"])}
    res_oid = {r["id"]: 700 + i for i, r in enumerate(p["resources"])}
    L = []
    for k, (cid, c) in enumerate(p["calendars"].items()):
        h, m, _ = (int(x) for x in c["day_start"].split(":"))
        fin = h * 60 + m + round(c["hours_per_day"] * 60)
        fin_s = f"{fin // 60:02d}:{fin % 60 - 1:02d}:00" if k % 2 == 0 and fin % 60 else f"{fin // 60:02d}:{fin % 60:02d}:00"
        if k % 2 == 0 and fin % 60 == 0:
            fin_s = f"{fin // 60 - 1:02d}:59:00"                          # P6 writes 15:59 for a 16:00 finish
        days = "".join(
            "<StandardWorkHours>" + _e("DayOfWeek", P6_DAYS[d]) +
            (f"<WorkTime>{_e('Start', c['day_start'])}{_e('Finish', fin_s)}</WorkTime>" if d in c["working_days"] else "<WorkTime/>") +
            "</StandardWorkHours>" for d in range(7))
        hols = "".join(f"<HolidayOrException>{_e('Date', d + 'T00:00:00')}" +
                       (f"<WorkTime>{_e('Start', '08:00:00')}{_e('Finish', '12:00:00')}</WorkTime>" if hrs else "") +
                       "</HolidayOrException>" for d, hrs in sorted(c["exceptions"].items()))
        L.append(f"<Calendar>{_e('HoursPerDay', c['hours_per_day'])}{_e('Name', c['name'])}{_e('ObjectId', cal_oid[cid])}"
                 f"<StandardWorkWeek>{days}</StandardWorkWeek><HolidayOrExceptions>{hols}</HolidayOrExceptions></Calendar>")
    for r in p["resources"]:
        rt = {"labour": "Labor", "equipment": "Nonlabor", "material": "Material"}.get(r["type"], "Labor")
        L.append(f"<Resource>{_e('Id', r['id'])}{_e('Name', r['name'])}{_e('ObjectId', res_oid[r['id']])}"
                 f"{_e('PricePerUnit', r['rate'])}{_e('ResourceType', rt)}</Resource>")
    pr = [_e("ActivityDefaultCalendarObjectId", cal_oid[p["default_calendar_id"]]), _e("DataDate", p.get("data_date") or p["start"]),
          _e("Description", "Imported &amp; checked"), _e("Id", p["id"]), _e("MustFinishByDate", p.get("must_finish_by")),
          _e("Name", p["name"]), _e("ObjectId", 1), _e("PlannedStartDate", p["start"]), _e("WBSObjectId", 999)]
    pr.append(f"<WBS>{_e('Code', p['id'])}{_e('Name', p['name'])}{_e('ObjectId', 999)}<ParentObjectId xsi:nil='true'/></WBS>")
    for w in p["wbs"]:
        pr.append(f"<WBS>{_e('Code', w.get('code') or w['id'])}{_e('Name', w['name'])}{_e('ObjectId', wbs_oid[w['id']])}"
                  f"{_e('ParentObjectId', wbs_oid.get(w.get('parent_id'), 999))}{_e('SequenceNumber', w.get('seq', 0))}</WBS>")
    for i, a in enumerate(p["activities"]):
        st = a["status"]
        typ = pct_types[i % len(pct_types)]
        rem = a.get("remaining_hours") if a.get("remaining_hours") is not None else (0 if st == "complete" else a["duration_hours"])
        f = [_e("ActualFinishDate", a.get("actual_finish")), _e("ActualStartDate", a.get("actual_start")),
             _e("CalendarObjectId", cal_oid.get(a.get("calendar_id"), 42)), _e("FinishDate", a.get("early_finish")),
             _e("Id", a["id"]), _e("Name", a["name"]), _e("ObjectId", act_oid[a["id"]]),
             _e("PercentCompleteType", typ), _e("PlannedDuration", a["duration_hours"]),
             _e("PlannedFinishDate", a.get("baseline_finish") or a.get("early_finish")),
             _e("PlannedStartDate", a.get("baseline_start") or a.get("early_start")),
             _e("PrimaryConstraintDate", a.get("constraint_date")), _e("PrimaryConstraintType", P6_CSTR.get(a["constraint"])),
             _e("RemainingDuration", rem), _e("RemainingLateFinishDate", a.get("late_finish")),
             _e("RemainingLateStartDate", a.get("late_start")), _e("StartDate", a.get("early_start")),
             _e("Status", P6_STATUS[st]), _e("Type", P6_TYPE[a["type"]]), _e("WBSObjectId", wbs_oid.get(a.get("wbs_id"), 999))]
        pct = a["percent_complete"] / 100
        if typ == "Duration" and i % 3:
            f.append(_e("DurationPercentComplete", pct))
        f.append(_e("PhysicalPercentComplete", round(pct * 0.9, 4)))
        f.append(_e("UnitsPercentComplete", round(pct * 1.1, 4)))
        if a.get("notes") or i % 5 == 0:
            f.append(_e("NotesToResources", f"<html><body><p>{a.get('notes') or 'Check'} &amp; sign off</p></body></html>"))
        pr.append("<Activity>" + "".join(f) + "</Activity>")
    rels = []
    for k, r in enumerate(p["relationships"]):
        rels.append((k, f"<ActivityRelationship>{_e('Lag', r['lag_hours'])}{_e('PredecessorActivityObjectId', act_oid[r['predecessor_id']])}"
                        f"{_e('SuccessorActivityObjectId', act_oid[r['successor_id']])}{_e('Type', P6_LINK[r['type']])}</ActivityRelationship>"))
    pr += [x for k, x in rels if k % 3]
    for x in p["assignments"]:
        if x["resource_id"] in res_oid and x["activity_id"] in act_oid:
            pr.append(f"<ResourceAssignment>{_e('ActivityObjectId', act_oid[x['activity_id']])}{_e('PlannedCost', x['cost'])}"
                      f"{_e('PlannedUnits', x['units'])}{_e('ResourceObjectId', res_oid[x['resource_id']])}</ResourceAssignment>")
    L.append("<Project>" + "".join(pr) + "</Project>")
    L += [x for k, x in rels if not k % 3]                                   # some links at the top level, as EPPM writes them
    body = "\n  ".join(L)
    xsi = 'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"'
    if ns == "default":
        return f'<?xml version="1.0" encoding="UTF-8"?>\n<APIBusinessObjects xmlns="{P6_NS}" {xsi}>\n  {body}\n</APIBusinessObjects>\n'
    if ns == "none":
        return f'<?xml version="1.0" encoding="UTF-8"?>\n<APIBusinessObjects {xsi}>\n  {body}\n</APIBusinessObjects>\n'
    doc = f'<APIBusinessObjects xmlns:p6="{P6_NS}" {xsi}>\n  {body}\n</APIBusinessObjects>'
    return re.sub(r"<(/?)(?!xsi)([A-Za-z]\w*)", r"<\1p6:\2", doc)


MSPDI_HAND = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<!-- written by hand to reach the reader's corners -->
<Project xmlns="http://schemas.microsoft.com/project">
  <Name>Hand made: Ünïcode &amp; entities</Name>
  <StartDate>2026-03-02T08:00:00</StartDate>
  <StatusDate>2026-03-20</StatusDate>
  <CalendarUID>7</CalendarUID>
  <MinutesPerDay>450</MinutesPerDay>
  <Calendars>
    <Calendar><UID>7</UID><Name>Split shifts &#x26; ties</Name>
      <WeekDays>
        <WeekDay><DayType>1</DayType><DayWorking>0</DayWorking></WeekDay>
        <WeekDay><DayType>2</DayType><DayWorking>1</DayWorking><WorkingTimes>
          <WorkingTime><FromTime>07:30:00</FromTime><ToTime>12:00:00</ToTime></WorkingTime>
          <WorkingTime><FromTime>12:30:00</FromTime><ToTime>17:30:00</ToTime></WorkingTime></WorkingTimes></WeekDay>
        <WeekDay><DayType>3</DayType><DayWorking>1</DayWorking><WorkingTimes>
          <WorkingTime><FromTime>07:30:00</FromTime><ToTime>17:30:00</ToTime></WorkingTime></WorkingTimes></WeekDay>
        <WeekDay><DayType>4</DayType><DayWorking>1</DayWorking><WorkingTimes>
          <WorkingTime><FromTime>08:00:00</FromTime><ToTime>14:15:00</ToTime></WorkingTime></WorkingTimes></WeekDay>
        <WeekDay><DayType>5</DayType><DayWorking>1</DayWorking><WorkingTimes>
          <WorkingTime><FromTime>08:00:00</FromTime><ToTime>14:15:00</ToTime></WorkingTime></WorkingTimes></WeekDay>
        <WeekDay><DayType>6</DayType><DayWorking>1</DayWorking></WeekDay>
        <WeekDay><DayType>9</DayType><DayWorking>1</DayWorking></WeekDay>
        <WeekDay><DayType>7</DayType><DayWorking>0</DayWorking></WeekDay>
      </WeekDays>
      <Exceptions>
        <Exception><TimePeriod><FromDate>2026-04-02T00:00:00</FromDate><ToDate>2026-04-07T23:59:00</ToDate></TimePeriod><DayWorking>0</DayWorking></Exception>
        <Exception><TimePeriod><FromDate>2026-03-07</FromDate><ToDate>2026-03-07</ToDate></TimePeriod><DayWorking>1</DayWorking>
          <WorkingTimes><WorkingTime><FromTime>08:00:00</FromTime><ToTime>12:00:00</ToTime></WorkingTime></WorkingTimes></Exception>
        <Exception><TimePeriod><FromDate>not a date</FromDate><ToDate>2026-05-01T00:00:00</ToDate></TimePeriod></Exception>
        <Exception><DayWorking>0</DayWorking></Exception>
      </Exceptions>
    </Calendar>
    <Calendar><UID>8</UID><Name></Name><WeekDays>
        <WeekDay><DayType>2</DayType><DayWorking>1</DayWorking><WorkingTimes><WorkingTime><FromTime>bad</FromTime><ToTime>16:00:00</ToTime></WorkingTime></WorkingTimes></WeekDay>
        <WeekDay><DayType>3</DayType><DayWorking>1</DayWorking></WeekDay>
      </WeekDays></Calendar>
  </Calendars>
  <Tasks>
    <Task><UID>0</UID><ID>0</ID><Name>Renamed by task zero</Name><OutlineLevel>0</OutlineLevel><Summary>1</Summary></Task>
    <Task><UID>1</UID><ID>1</ID><Name>Zone A &lt;north&gt;</Name><OutlineNumber>1</OutlineNumber><OutlineLevel>1</OutlineLevel><Summary>1</Summary></Task>
    <Task><UID>2</UID><ID>2</ID><Name>Start</Name><WBS>S</WBS><OutlineLevel>2</OutlineLevel><Milestone>1</Milestone><Duration>PT0H0M0S</Duration>
      <PercentComplete>100</PercentComplete><ActualStart>2026-03-02T08:00:00</ActualStart></Task>
    <Task><UID>3</UID><ID>3</ID><Name>Dig <![CDATA[<trench> & "drain"]]><!-- c --> &#233;&#x1F600;</Name><WBS>A1</WBS><OutlineLevel>2</OutlineLevel>
      <Duration>P1DT4H30M0S</Duration><RemainingDuration>PT6H0M0S</RemainingDuration><PercentComplete>40</PercentComplete>
      <ActualStart>2026-03-03T07:30:00</ActualStart><CalendarUID>7</CalendarUID><ConstraintType>4</ConstraintType>
      <ConstraintDate>2026-03-03T07:30:00</ConstraintDate><Notes>Watch the
services.</Notes>
      <Baseline><Number>0</Number><Start>2026-03-02T08:00:00</Start><Finish>2026-03-04T12:00:00</Finish></Baseline>
      <Baseline><Number>1</Number><Start>2026-01-01T08:00:00</Start></Baseline>
      <PredecessorLink><PredecessorUID>2</PredecessorUID><Type>1</Type><LinkLag>0</LinkLag></PredecessorLink></Task>
    <Task><UID>4</UID><ID>4</ID><Name>Duplicate WBS code</Name><WBS>A1</WBS><OutlineLevel>2</OutlineLevel><Duration>PT٨H0M0S</Duration>
      <CalendarUID>-1</CalendarUID><ConstraintType>7</ConstraintType><ConstraintDate>٢٠٢٦-04-30T17:00:00</ConstraintDate>
      <PredecessorLink><PredecessorUID>3</PredecessorUID><Type>3</Type><LinkLag>1_200</LinkLag><LagFormat>7</LagFormat></PredecessorLink>
      <PredecessorLink><PredecessorUID>99</PredecessorUID></PredecessorLink></Task>
    <Task><UID>5</UID><ID>5</ID><Name>Zone B</Name><OutlineNumber>2</OutlineNumber><OutlineLevel>1</OutlineLevel><Summary>1</Summary></Task>
    <Task><UID>6</UID><ID>6</ID><Name>Fit out</Name><OutlineLevel>3</OutlineLevel><Duration>PT30H</Duration><CalendarUID>8</CalendarUID>
      <ConstraintType>3</ConstraintType><ConstraintDate>2026-05-29</ConstraintDate>
      <PredecessorLink><PredecessorUID>4</PredecessorUID><Type>0</Type><LinkLag>-2400</LinkLag></PredecessorLink>
      <PredecessorLink><PredecessorUID>3</PredecessorUID><Type>2</Type></PredecessorLink></Task>
    <Task><UID>7</UID><ID>7</ID><Name>Done, no dates</Name><OutlineLevel>2</OutlineLevel><Duration>PT8H0M0S</Duration><PercentComplete>100</PercentComplete>
      <ActualFinish>2026-03-05T16:00:00</ActualFinish><ActualStart>2026-03-04T08:00:00</ActualStart></Task>
    <Task><UID>8</UID><ID>8</ID><Name>Handover</Name><OutlineLevel>1</OutlineLevel><Milestone>1</Milestone><Duration>PT0H0M0S</Duration>
      <CalendarUID>12</CalendarUID><Start>2026-06-01T08:00:00.000</Start><LateStart>2026-06-01T08:00:00</LateStart>
      <PredecessorLink><PredecessorUID>6</PredecessorUID></PredecessorLink><PredecessorLink><PredecessorUID>7</PredecessorUID><Type>9</Type></PredecessorLink></Task>
    <Task><UID>9</UID><ID>9</ID><Name>Loose start</Name><OutlineLevel>1</OutlineLevel><Milestone>1</Milestone><Duration>PT0H0M0S</Duration></Task>
  </Tasks>
  <Resources>
    <Resource><UID>0</UID></Resource>
    <Resource><UID>1</UID><Name>Ground  workers</Name><Type>1</Type><StandardRate>35.5</StandardRate></Resource>
    <Resource><UID>2</UID><Name>Concrete</Name><Initials>C 30</Initials><Type>0</Type></Resource>
    <Resource><UID>3</UID><Name>A very long resource name indeed</Name><Type>2</Type><StandardRate>1e3</StandardRate></Resource>
    <Resource><UID>4</UID><Type>7</Type></Resource>
  </Resources>
  <Assignments>
    <Assignment><UID>1</UID><TaskUID>3</TaskUID><ResourceUID>1</ResourceUID><Work>PT24H0M0S</Work><Cost>852</Cost></Assignment>
    <Assignment><UID>2</UID><TaskUID>4</TaskUID><ResourceUID>2</ResourceUID><Work>PT8H30M0S</Work></Assignment>
    <Assignment><UID>3</UID><TaskUID>1</TaskUID><ResourceUID>1</ResourceUID><Work>PT8H</Work></Assignment>
    <Assignment><UID>4</UID><TaskUID>6</TaskUID><ResourceUID>0</ResourceUID></Assignment>
  </Assignments>
</Project>
"""

P6_HAND = """<?xml version="1.0" encoding="UTF-8"?>
<APIBusinessObjects xmlns="http://xmlns.oracle.com/Primavera/P6Professional/V8.4/API/BusinessObjects">
  <Calendar><ObjectId>11</ObjectId><Name>Ties: 2 x 10h, 2 x 8h, 1 x 6h</Name><HoursPerDay>0</HoursPerDay>
    <StandardWorkWeek>
      <StandardWorkHours><DayOfWeek>Monday</DayOfWeek><WorkTime><Start>07:00:00</Start><Finish>17:00:00</Finish></WorkTime></StandardWorkHours>
      <StandardWorkHours><DayOfWeek>Tuesday</DayOfWeek><WorkTime><Start>08:00:00</Start><Finish>15:59:00</Finish></WorkTime></StandardWorkHours>
      <StandardWorkHours><DayOfWeek>Wednesday</DayOfWeek><WorkTime><Start>07:00:00</Start><Finish>16:59:00</Finish></WorkTime></StandardWorkHours>
      <StandardWorkHours><DayOfWeek>Thursday</DayOfWeek><WorkTime><Start>08:00:00</Start><Finish>12:00:00</Finish></WorkTime>
        <WorkTime><Start>12:30:00</Start><Finish>16:29:59</Finish></WorkTime></StandardWorkHours>
      <StandardWorkHours><DayOfWeek>Friday</DayOfWeek><WorkTime><Start>08:00:00</Start><Finish>14:00:00</Finish></WorkTime></StandardWorkHours>
      <StandardWorkHours><DayOfWeek>Saturday</DayOfWeek><WorkTime><Start>06:00:00</Start><Finish>06:59:00</Finish></WorkTime>
        <WorkTime><Start>08:00:00</Start><Finish>08:59:00</Finish></WorkTime><WorkTime><Start>10:00:00</Start><Finish>10:59:00</Finish></WorkTime>
        <WorkTime><Start>12:00:00</Start><Finish>12:59:00</Finish></WorkTime></StandardWorkHours>
      <StandardWorkHours><DayOfWeek>Funday</DayOfWeek><WorkTime><Start>08:00:00</Start><Finish>14:00:00</Finish></WorkTime></StandardWorkHours>
      <StandardWorkHours><DayOfWeek>Sunday</DayOfWeek><WorkTime><Start>00:00:00</Start><Finish>23:59:00</Finish></WorkTime></StandardWorkHours>
    </StandardWorkWeek>
    <HolidayOrExceptions>
      <HolidayOrException><Date>2026-04-03T00:00:00</Date></HolidayOrException>
      <HolidayOrException><Date>2026-04-11T00:00:00</Date><WorkTime><Start>08:00:00</Start><Finish>12:20:00</Finish></WorkTime></HolidayOrException>
      <HolidayOrException><Date>2026-02-30T00:00:00</Date></HolidayOrException>
      <HolidayOrException><Date>2026-04-18T00:00:00</Date><WorkTime><Start>06:00:00</Start><Finish>06:59:00</Finish></WorkTime>
        <WorkTime><Start>08:00:00</Start><Finish>08:59:00</Finish></WorkTime><WorkTime><Start>10:00:00</Start><Finish>10:59:00</Finish></WorkTime>
        <WorkTime><Start>12:00:00</Start><Finish>12:59:00</Finish></WorkTime></HolidayOrException>
    </HolidayOrExceptions></Calendar>
  <Calendar><ObjectId>12</ObjectId><HoursPerDay>abc</HoursPerDay></Calendar>
  <Resource><ObjectId>1</ObjectId><Id>RES WITH A VERY LONG IDENTIFIER</Id><ResourceType>Nonlabor</ResourceType><PricePerUnit>12.5</PricePerUnit></Resource>
  <Resource><ObjectId>2</ObjectId><Name>Unused</Name></Resource>
  <Project><Id>FIRST-PROJECT</Id><PlannedStartDate>2025-01-06T08:00:00</PlannedStartDate>
    <Activity><ObjectId>1</ObjectId><Id>X1</Id><Name>Only in the first project</Name><PlannedDuration>8</PlannedDuration></Activity></Project>
  <Project><Id>SECOND-PROJECT-WITH-A-LONG-ID</Id><Name>Second &amp; last</Name><DataDate>2026-03-16T08:00:00</DataDate>
    <ActivityDefaultCalendarObjectId>11</ActivityDefaultCalendarObjectId><MustFinishByDate>2026-12-18T16:00:00</MustFinishByDate>
    <WBSObjectId>50</WBSObjectId>
    <Calendar><ObjectId>13</ObjectId><Name>Project calendar</Name><HoursPerDay>7.5</HoursPerDay></Calendar>
    <WBS><ObjectId>50</ObjectId><ParentObjectId>1</ParentObjectId><Code>ROOT</Code><Name>Root</Name></WBS>
    <WBS><ObjectId>51</ObjectId><ParentObjectId>50</ParentObjectId><Name>No code</Name><SequenceNumber>2.9</SequenceNumber></WBS>
    <WBS><ObjectId>52</ObjectId><ParentObjectId>51</ParentObjectId><Code>W.2</Code><Name>Child</Name><SequenceNumber>-1</SequenceNumber></WBS>
    <WBS><ObjectId>53</ObjectId><ParentObjectId></ParentObjectId><Code>LOOSE</Code></WBS>
    <Activity><ObjectId>10</ObjectId><Id>A10</Id><Name>Complete, no actuals</Name><Status>Completed</Status><PlannedDuration>16</PlannedDuration>
      <StartDate>2026-03-02T08:00:00</StartDate><FinishDate>2026-03-03T16:00:00</FinishDate><WBSObjectId>52</WBSObjectId><CalendarObjectId>13</CalendarObjectId></Activity>
    <Activity><ObjectId>11</ObjectId><Name>No Id, in progress by duration</Name><Status>In Progress</Status><PlannedDuration>40</PlannedDuration>
      <RemainingDuration>30</RemainingDuration><PlannedStartDate>2026-03-04T08:00:00</PlannedStartDate><WBSObjectId>51</WBSObjectId>
      <NotesToResources>&lt;p&gt;Two&lt;br/&gt;lines &amp;amp; more&lt;/p&gt;</NotesToResources></Activity>
    <Activity><ObjectId>12</ObjectId><Id>A12</Id><Name>Physical</Name><Status>In Progress</Status><PercentCompleteType>Physical</PercentCompleteType>
      <PhysicalPercentComplete>0.333333</PhysicalPercentComplete><PlannedDuration>24</PlannedDuration><RemainingDuration>16</RemainingDuration>
      <ActualStartDate>2026-03-05T08:00:00</ActualStartDate><PrimaryConstraintType>Start On</PrimaryConstraintType>
      <PrimaryConstraintDate>2026-03-05T08:00:00</PrimaryConstraintDate><CalendarObjectId>99</CalendarObjectId></Activity>
    <Activity><ObjectId>13</ObjectId><Id>A13</Id><Name>Units</Name><Status>In Progress</Status><PercentCompleteType>Units</PercentCompleteType>
      <UnitsPercentComplete>0.125</UnitsPercentComplete><PlannedDuration>0</PlannedDuration><Type>Resource Dependent</Type></Activity>
    <Activity><ObjectId>14</ObjectId><Id>A14</Id><Name>Explicit duration %</Name><Status>In Progress</Status>
      <DurationPercentComplete>0.4567</DurationPercentComplete><PlannedDuration>80</PlannedDuration><RemainingDuration>abc</RemainingDuration>
      <StartDate>2026-03-09T08:00:00</StartDate><PrimaryConstraintType>Unknown</PrimaryConstraintType></Activity>
    <Activity><ObjectId>15</ObjectId><Id>M15</Id><Name>Finish milestone</Name><Type>Finish Milestone</Type><Status>Not Started</Status>
      <PrimaryConstraintType>Finish On or Before</PrimaryConstraintType><PrimaryConstraintDate>2026-09-30T16:00:00</PrimaryConstraintDate></Activity>
    <Activity><ObjectId>16</ObjectId><Id>L16</Id><Name>Hammock</Name><Type>WBS Summary</Type><WBSObjectId>51</WBSObjectId><PlannedDuration>8</PlannedDuration></Activity>
    <ActivityRelationship><PredecessorActivityObjectId>10</PredecessorActivityObjectId><SuccessorActivityObjectId>11</SuccessorActivityObjectId></ActivityRelationship>
    <ActivityRelationship><PredecessorActivityObjectId>11</PredecessorActivityObjectId><SuccessorActivityObjectId>14</SuccessorActivityObjectId>
      <Type>Start to Start</Type><Lag>8.5</Lag></ActivityRelationship>
    <ActivityRelationship><PredecessorActivityObjectId>1</PredecessorActivityObjectId><SuccessorActivityObjectId>14</SuccessorActivityObjectId></ActivityRelationship>
    <ResourceAssignment><ActivityObjectId>11</ActivityObjectId><ResourceObjectId>1</ResourceObjectId><PlannedUnits>40</PlannedUnits><PlannedCost>500</PlannedCost></ResourceAssignment>
    <ResourceAssignment><ActivityObjectId>99</ActivityObjectId><ResourceObjectId>2</ResourceObjectId></ResourceAssignment>
  </Project>
  <ActivityRelationship><PredecessorActivityObjectId>14</PredecessorActivityObjectId><SuccessorActivityObjectId>15</SuccessorActivityObjectId>
    <Type>Finish to Finish</Type><Lag>-4</Lag></ActivityRelationship>
  <ActivityRelationship><PredecessorActivityObjectId>12</PredecessorActivityObjectId><SuccessorActivityObjectId>15</SuccessorActivityObjectId>
    <Type>Start to Finish</Type></ActivityRelationship>
  <ResourceAssignment><ActivityObjectId>12</ActivityObjectId><ResourceObjectId>1</ResourceObjectId><PlannedUnits>1_0</PlannedUnits></ResourceAssignment>
</APIBusinessObjects>
"""

BAD_XML = ["", " ", "not xml", "﻿", "<a>", "<a></b>", "<a/><b/>", "<a/>junk", "<a>&foo;</a>", "<a>&#0;</a>",
           "<a>x<![CDATA[<z>]]>y</a>", " <?xml version='1.0'?><a/>", "<p:a/>", "<a x='1' x='2'/>", "<a xmlns:p=''/>",
           "<a><!-- a -- b --></a>", "<?xml?><a/>", "<?xml version='1.0' standalone='maybe'?><a/>", "<a><![CDATA[x",
           "<a></a", "\n\n<a>", "<a>\n  é<b>\n</c>", "<!DOCTYPE a [<!ENTITY e '<b>'>]><a>&e;</b></a>", "<a>]]></a>",
           "<!DOCTYPE a SYSTEM 'x.dtd'><a>&e;</a>", "<a b='<'/>", "<a>\x01</a>", "<é/>", "<😀/>", "\x00<\x00a\x00/\x00>"]

PARSE = BAD_XML + [
    "<a>x<!--c-->y<?pi d?>z</a>", "<a>&lt;&gt;&amp;&apos;&quot;&#233;&#x1F600;</a>", "<a>\r\nx\ry</a>", "<a x='\r\n\t&#9;'/>",
    "<a xmlns='u'><b xmlns=''>t</b><c/></a>", "<a xmlns:p='u' xmlns:q='v' p:x='1' q:x='2' x='3'><p:b xml:lang='en'/></a>",
    "<!DOCTYPE a [<!ENTITY e 'hi &amp; <b>bold</b>'><!ATTLIST a k NMTOKENS ' x  y ' d CDATA 'dflt'>]><a>&e;tail</a>",
    "<a><b>1</b>tail<!--c--><c/>t2</a>", "<?xml version='1.0' encoding='windows-1252'?><a>é</a>", "<a>\x85 </a>",
]


def build_cases() -> list[tuple[str, dict]]:
    cases: list[tuple[str, dict]] = []
    for f in sorted(FIX.iterdir()):
        if f.suffix not in (".xml", ".pmxml"):
            continue
        text = f.read_bytes().decode("utf-8", errors="replace")
        cases.append((f"fixture-{f.name}", {"kind": "pmxml" if f.suffix == ".pmxml" else "mspdi", "text": text}))
        cases.append((f"fixture-{f.name}-dispatch", {"kind": "xml", "text": text}))
    if (FIX / "msproject_relations.xml").exists():
        for v, t in _mspdi_variants((FIX / "msproject_relations.xml").read_bytes().decode("utf-8", "replace")):
            cases.append((f"fixture-mspdi-{v}", {"kind": "mspdi", "text": t}))

    corpus = _corpus()
    for name, data in corpus:
        text = write_mspdi(_scheduled(data))
        cases.append((f"py-writer-{name}", {"kind": "mspdi", "text": text}))
        cases.append((f"py-writer-{name}-dispatch", {"kind": "xml", "text": text}))
    for v, t in _mspdi_variants(write_mspdi(_scheduled(corpus[0][1]))):
        cases.append((f"py-writer-gen0-{v}", {"kind": "mspdi", "text": t}))
    if NODE is not None:                                    # the browser's own writer, read back by both readers
        written = _node([{"kind": "write", "project": copy.deepcopy(d)} for _, d in corpus])
        for (name, _), w in zip(corpus, written):
            assert "text" in w, (name, w)
            cases.append((f"js-writer-{name}", {"kind": "mspdi", "text": w["text"]}))
        cases.append(("js-writer-gen0-no-namespace", {"kind": "mspdi", "text": _mspdi_variants(written[0]["text"])[0][1]}))

    cases.append(("mspdi-hand", {"kind": "mspdi", "text": MSPDI_HAND}))
    cases.append(("mspdi-hand-no-namespace", {"kind": "mspdi", "text": MSPDI_HAND.replace(f' xmlns="{MSP_NS}"', "")}))
    cases.append(("mspdi-wrong-root", {"kind": "mspdi", "text": "<Schedule><Name>Odd one</Name><StartDate>2026-01-05T08:00:00</StartDate></Schedule>"}))
    cases.append(("mspdi-bad-float", {"kind": "mspdi", "text": f'<Project xmlns="{MSP_NS}"><MinutesPerDay>4 80</MinutesPerDay></Project>'}))
    cases.append(("mspdi-bad-int", {"kind": "mspdi", "text": MSPDI_HAND.replace("<DayType>4</DayType>", "<DayType>4.0</DayType>")}))
    cases.append(("mspdi-bad-outline", {"kind": "mspdi", "text": MSPDI_HAND.replace("<OutlineLevel>3</OutlineLevel>", "<OutlineLevel>'3'</OutlineLevel>")}))
    cases.append(("mspdi-bad-percent", {"kind": "mspdi", "text": MSPDI_HAND.replace("<PercentComplete>40</PercentComplete>", "<PercentComplete>forty</PercentComplete>")}))
    cases.append(("mspdi-truncated", {"kind": "mspdi", "text": MSPDI_HAND[: len(MSPDI_HAND) // 2]}))

    for v in ("default", "none", "prefix"):
        for name, data in (("gen1", _generated(BRIEFS[1])), ("progress", progress()), ("hammocks", hammocks())):
            p = _scheduled(data)
            if name == "gen1":
                set_baseline(p, "Tender")
            cases.append((f"pmxml-{name}-{v}", {"kind": "pmxml", "text": _p6(p.model_dump(mode="json"), ns=v)}))
    odd = dict(_corpus()[-1][1])
    cases.append(("pmxml-non-ascii", {"kind": "pmxml", "text": _p6(_scheduled(odd).model_dump(mode="json"))}))
    cases.append(("pmxml-non-ascii-dispatch", {"kind": "xml", "text": _p6(_scheduled(odd).model_dump(mode="json"))}))
    for idx in (0, 1, 5, -1, -2, -3):
        cases.append((f"pmxml-hand-project{idx}", {"kind": "pmxml", "text": P6_HAND, "index": idx}))
    cases.append(("pmxml-hand-no-namespace", {"kind": "pmxml", "text": P6_HAND.replace(f' xmlns="{P6_NS}"', ""), "index": 1}))
    cases.append(("pmxml-hand-dispatch", {"kind": "xml", "text": P6_HAND}))
    cases.append(("pmxml-no-project", {"kind": "pmxml", "text": f'<APIBusinessObjects xmlns="{P6_NS}"><Calendar/></APIBusinessObjects>'}))
    cases.append(("pmxml-wrong-root", {"kind": "pmxml", "text": '<?xml version="1.0"?><Project><Name>x</Name></Project>'}))
    cases.append(("pmxml-bad-sequence", {"kind": "pmxml", "index": 1, "text": P6_HAND.replace("<SequenceNumber>2.9</SequenceNumber>", "<SequenceNumber>inf</SequenceNumber>")}))
    cases.append(("pmxml-nan-sequence", {"kind": "pmxml", "index": 1, "text": P6_HAND.replace("<SequenceNumber>2.9</SequenceNumber>", "<SequenceNumber>NaN</SequenceNumber>")}))

    for i, t in enumerate(BAD_XML):
        for kind in ("pmxml", "mspdi", "xml"):
            cases.append((f"malformed-{kind}-{i}", {"kind": kind, "text": t}))
    cases.append(("xml-wrong-root", {"kind": "xml", "text": "<?xml version='1.0'?><Schedule/>"}))
    cases.append(("xml-prefixed-root", {"kind": "xml", "text": f'<?xml version="1.0"?><!-- x --><msp:Project xmlns:msp="{MSP_NS}"><msp:Name>P</msp:Name>'
                                                         f'<msp:StartDate>2026-01-05T08:00:00</msp:StartDate></msp:Project>'}))
    for i, t in enumerate(PARSE):
        cases.append((f"parse-{i}", {"kind": "parse", "text": t}))

    roots = [b"", b"<", b"<a", b"   \n", b"<?xml version='1.0'?>", b"<?xml version='1.0'?>\n<!-- c --><!DOCTYPE p><p:Project xmlns:p='x'/>",
             b"\xef\xbb\xbf<?xml version='1.0'?><APIBusinessObjects>", b"<Project\txmlns='x'>", b"<Project/>", b"<!--a--><!--b--><Root>",
             b"<?xml?><!DOCTYPE x [ <!ENTITY a 'b'> ]><x/>", b"\xff\xfe<\x00P\x00", b"<\xc3\xa9t\xc3\xa9:Proj\xe9ct>", b"text only",
             b"<?xml version='1.0'?><!-- unterminated", b"<a:b:c/>", b"<//Project//>", "<Projet x>".encode()]
    for i, b in enumerate(roots):
        cases.append((f"root-{i}", {"kind": "root", "b64": base64.b64encode(b).decode()}))
    return cases


# ----------------------------------------------------------------------------------------
# the Python side (mirrors tests/parity/xml_runner.js)
# ----------------------------------------------------------------------------------------
def _read_xml(text: str) -> Project:
    root = _xml_root_tag(text.encode("utf-8"))
    if root == "Project":
        return read_mspdi(text)
    if root == "APIBusinessObjects":
        return read_pmxml(text)
    raise ValueError(f"Unrecognised XML root <{root}>. Expected MS Project XML (<Project>) or P6 XML (<APIBusinessObjects>).")


def _tree(e: ET.Element) -> dict:
    return {"tag": e.tag, "attrib": dict(e.attrib), "text": e.text, "tail": e.tail, "children": [_tree(c) for c in e]}


def run_py(c: dict) -> dict:
    try:
        k = c["kind"]
        if k == "root":
            return {"root": _xml_root_tag(base64.b64decode(c["b64"]))}
        if k == "parse":
            return {"tree": _tree(ET.fromstring(c["text"]))}
        p = read_pmxml(c["text"], c.get("index", 0)) if k == "pmxml" else read_mspdi(c["text"]) if k == "mspdi" else _read_xml(c["text"])
        read = p.model_dump(mode="json")
        try:
            schedule(p)
        except Exception as e:  # noqa: BLE001 - the error text itself is compared
            return {"read": read, "error": str(e)}
        return {"read": read, "project": p.model_dump(mode="json")}
    except Exception as e:  # noqa: BLE001
        return {"error": str(e)}


CASES = build_cases()
# io._xml_root_tag used to loop forever on an unterminated leading comment or DOCTYPE; both sides
# now report no root, so every case runs in Python too.
NO_PY: set[str] = set()


@pytest.fixture(scope="module")
def py_results():
    return [None if n in NO_PY else norm(json.loads(json.dumps(run_py(copy.deepcopy(c))))) for n, c in CASES]


@pytest.fixture(scope="module", params=TIMEZONES)
def js_results(request):
    return request.param, [norm(r) for r in _node([c for _, c in CASES], request.param)]


@pytest.mark.parametrize("idx", range(len(CASES)), ids=[n for n, _ in CASES])
def test_xml_readers_agree(idx, py_results, js_results):
    tz, js = js_results
    if py_results[idx] is None:
        assert js[idx] == {"root": ""}
        return
    py = py_results[idx]
    # A file with no start date falls back to "today": Python's today (this process's zone) and the
    # browser's local today differ for a few hours a day in far-off zones, so only compare when they agree.
    fallback = date.today().isoformat() + "T08:00:00"
    if isinstance(py, dict) and isinstance(py.get("read"), dict) and py["read"].get("start") == fallback \
            and datetime.now(ZoneInfo(tz)).date() != date.today():
        pytest.skip(f"start falls back to today, which is a different date in {tz} right now")
    d = diff(py, js[idx])
    assert not d, f"{CASES[idx][0]} under TZ={tz}: {len(d)}+ differences\n  " + "\n  ".join(d)


def test_cases_exercise_the_readers():
    """Guard against a corpus that silently stops reaching the readers (every case erroring)."""
    res = [run_py(copy.deepcopy(c)) for n, c in CASES if c["kind"] in ("pmxml", "mspdi", "xml")]
    ok = [r for r in res if "project" in r]
    assert len(ok) >= 60, len(ok)
    assert sum(1 for r in ok if r["project"]["relationships"]) >= 40
    assert any(a["status"] == "in_progress" for r in ok for a in r["project"]["activities"])
    assert any(a.get("baseline_start") for r in ok for a in r["project"]["activities"])

"""Golden-master parity: the browser engine (web/engine.js) must match the Python engine exactly.

The shareable preview runs web/engine.js; the API, MCP server and agent run planner/*.py.
Each case below goes through the same pipeline in both, and every scheduled date, float,
critical flag, DCMA result, levelling delay, repair, command patch and analysis figure is
compared. Node runs under several timezones, because JS Dates are timezone-aware and
Python's naive datetimes are not: London (DST at 01:00), Santiago (DST at midnight, so
local midnight does not exist on the change day), Lord Howe (30-minute DST) and UTC.

Skipped when node is not installed.
"""
from __future__ import annotations

import copy
import json
import os
import random
import shutil
import subprocess
from datetime import date, datetime
from pathlib import Path

import pytest

from planner.analysis import cost_curve, histogram, variance
from planner.commands import parse_command
from planner.cpm import schedule
from planner.dcma import health_check
from planner.generator import generate, parse_brief
from planner.levelling import level, set_baseline
from planner.model import Project
from planner.plan import UK_BANK_HOLIDAYS_2026_27, _parse_date, apply_patch, draft_to_project
from planner.repair import plan_repairs
from planner.risk import risk_analysis
from planner.guardrails import critical_drag, out_of_sequence

ROOT = Path(__file__).resolve().parents[1]
RUNNER = Path(__file__).parent / "parity" / "js_runner.js"
NODE = shutil.which("node")
TIMEZONES = ["UTC", "Europe/London", "America/Santiago", "Australia/Lord_Howe"]

pytestmark = pytest.mark.skipif(NODE is None, reason="node is not installed")


# ----------------------------------------------------------------------------------------
# corpus
# ----------------------------------------------------------------------------------------
def _cal(cid, hpd=8.0, start="08:00:00", days=(0, 1, 2, 3, 4), holidays=True):
    exc = {d.isoformat(): 0 for d in UK_BANK_HOLIDAYS_2026_27} if holidays else {}
    return {"id": cid, "name": cid, "hours_per_day": hpd, "day_start": start, "working_days": list(days), "exceptions": exc}


def _act(aid, hours=0.0, cal="standard", typ="task", **kw):
    return {"id": aid, "name": f"Activity {aid}", "calendar_id": cal, "type": typ, "duration_hours": hours, **kw}


def _ln(p, s, t="FS", lag=0.0):
    return {"predecessor_id": p, "successor_id": s, "type": t, "lag_hours": lag}


def _project(pid, start, cals, acts, links, **kw) -> dict:
    data = {"id": pid, "name": pid, "start": start, "default_calendar_id": "standard",
            "calendars": {c["id"]: c for c in cals}, "activities": acts, "relationships": links, **kw}
    return Project.model_validate(data).model_dump(mode="json")


STD = _cal("standard")
SIX = _cal("six_day", days=(0, 1, 2, 3, 4, 5))
TEN = _cal("ten_hour", hpd=10.0, start="07:00:00")
EARLY = _cal("early", start="00:00:00", days=(0, 1, 2, 3, 4, 5, 6), holidays=False)  # 00:00-08:00 crosses 01:00/02:00 DST changes


def links_and_lags():
    acts = [_act("A", typ="start_milestone"), _act("B", 40), _act("C", 24, "six_day"), _act("D", 40, "ten_hour"),
            _act("E", 16), _act("F", 30, "ten_hour"), _act("G", 12.5), _act("H", 64), _act("Z", typ="finish_milestone")]
    links = [_ln("A", "B"), _ln("B", "C", "SS", 16), _ln("B", "D", "FF", 8), _ln("C", "E", "SF", 0), _ln("D", "F", "FS", -10),
             _ln("A", "G"), _ln("G", "H", "FS", 20), _ln("E", "Z"), _ln("F", "Z"), _ln("H", "Z")]
    return _project("LINKS", "2026-03-23T08:00:00", [STD, SIX, TEN], acts, links)


def constraints():
    acts = [_act("A", typ="start_milestone"),
            _act("B", 40, constraint="start_on_or_after", constraint_date="2026-04-14T08:00:00"),
            _act("C", 24, constraint="start_on_or_before", constraint_date="2026-04-10T08:00:00"),
            _act("D", 32, constraint="finish_on_or_after", constraint_date="2026-05-01T16:00:00"),
            _act("E", 16, constraint="finish_on_or_before", constraint_date="2026-04-24T16:00:00"),
            _act("F", 24, constraint="must_start_on", constraint_date="2026-05-11T08:00:00"),
            _act("G", 24, constraint="must_finish_on", constraint_date="2026-05-29T16:00:00"),
            _act("H", 8, constraint="as_late_as_possible"),
            _act("Z", typ="finish_milestone")]
    links = [_ln("A", "B"), _ln("A", "C"), _ln("B", "D"), _ln("C", "E"), _ln("D", "F"), _ln("E", "F"),
             _ln("F", "G"), _ln("A", "H"), _ln("G", "Z"), _ln("H", "Z")]
    return _project("CONS", "2026-04-06T08:00:00", [STD], acts, links, must_finish_by="2026-05-22T16:00:00")


def progress():
    acts = [_act("A", typ="start_milestone", status="complete", actual_start="2026-03-02T08:00:00", actual_finish="2026-03-02T08:00:00", percent_complete=100),
            _act("B", 80, status="complete", actual_start="2026-03-02T08:00:00", actual_finish="2026-03-16T16:00:00", percent_complete=100),
            _act("C", 120, status="in_progress", actual_start="2026-03-17T08:00:00", remaining_hours=52, percent_complete=40),
            _act("D", 64, status="in_progress", actual_start="2026-03-20T08:00:00", percent_complete=25),
            _act("E", 40, status="in_progress", actual_start="2026-03-25T08:00:00", percent_complete=10),  # out of sequence: pred C not done
            _act("F", 40), _act("G", 24), _act("Z", typ="finish_milestone")]
    links = [_ln("A", "B"), _ln("B", "C"), _ln("B", "D"), _ln("C", "E"), _ln("D", "F"), _ln("E", "G"), _ln("F", "G"), _ln("G", "Z")]
    return _project("PROG", "2026-03-02T08:00:00", [STD], acts, links, data_date="2026-03-30T08:00:00")


def hammocks():
    wbs = [{"id": "W1", "name": "Zone 1"}, {"id": "W2", "name": "Zone 2"}]
    acts = [_act("A", typ="start_milestone", wbs_id="W1"), _act("B", 40, wbs_id="W1"), _act("C", 56, wbs_id="W1"),
            _act("D", 24, wbs_id="W2"), _act("E", 32, wbs_id="W2"),
            _act("L1", 0, typ="level_of_effort", wbs_id="W1"), _act("L2", 0, typ="level_of_effort", wbs_id="W2"),
            _act("Z", typ="finish_milestone", wbs_id="W2")]
    links = [_ln("A", "B"), _ln("B", "C"), _ln("C", "D"), _ln("D", "E"), _ln("E", "Z"), _ln("B", "L1", "SS"), _ln("C", "L1", "FF")]
    return _project("LOE", "2026-06-01T08:00:00", [STD], acts, links, wbs=wbs)


def dst_year():
    """Two long chains through every 2026 DST change in London, Santiago and Lord Howe."""
    acts, links = [_act("S", typ="start_milestone")], []
    prev = "S"
    for i in range(52):
        aid = f"E{i:02d}"
        acts.append(_act(aid, 40 + (i % 9) + 0.5 * (i % 3), "early"))
        links.append(_ln(prev, aid, "FS" if i % 5 else "SS", 0 if i % 4 else 6))
        prev = aid
    e_last = prev
    prev = "S"
    for i in range(30):
        aid = f"W{i:02d}"
        acts.append(_act(aid, 56 + (i % 4) * 4))
        links.append(_ln(prev, aid))
        if i % 6 == 3:
            links.append(_ln(f"E{i:02d}", aid, "SS", 4))
        prev = aid
    acts.append(_act("Z", typ="finish_milestone"))
    links += [_ln(e_last, "Z"), _ln(prev, "Z")]
    acts[10]["constraint"], acts[10]["constraint_date"] = "start_on_or_after", "2026-03-29T00:00:00"
    acts[60]["constraint"], acts[60]["constraint_date"] = "finish_on_or_before", "2026-09-07T16:00:00"
    return _project("DST", "2026-01-05T00:00:00", [STD, EARLY], acts, links)


def logic_loop():
    acts = [_act("A", 8), _act("B", 8), _act("C", 8)]
    return _project("LOOP", "2026-03-02T08:00:00", [STD], acts, [_ln("A", "B"), _ln("B", "C"), _ln("C", "A")])


LAG_CALENDARS = (None, "predecessor", "successor", "project", "24h")
PROGRESS_LOGIC = ("retained", "override", "actual_dates")


def oos_chains():
    """Out-of-sequence progress of every kind for the progress-logic options: an FS successor started before its
    predecessor (not started / in progress), an SS successor started first, FF and SF links into started work, lags,
    a mid-day actual start and mixed calendars, with a not-started tail that the choice of logic moves."""
    acts = [_act("A", 40), _act("B", 32, "six_day", status="in_progress", actual_start="2026-03-24T13:00:00", remaining_hours=20, percent_complete=35),
            _act("C", 24, status="in_progress", actual_start="2026-03-26T08:00:00", percent_complete=50),
            _act("D", 48, "ten_hour", status="in_progress", actual_start="2026-03-25T07:00:00", remaining_hours=30, percent_complete=40),
            _act("E", 16, status="in_progress", actual_start="2026-03-27T08:00:00", remaining_hours=12, percent_complete=25),
            _act("F", 24, "six_day"), _act("G", 16), _act("H", 8, "ten_hour"),
            _act("K", 40, status="complete", actual_start="2026-03-23T08:00:00", actual_finish="2026-03-27T16:00:00", percent_complete=100),
            _act("Z", typ="finish_milestone")]
    links = [_ln("A", "B", "FS", 8), _ln("B", "C", "SS", 4), _ln("A", "D", "FF", 16), _ln("C", "E", "SF", 24), _ln("K", "E", "FS", 0),
             _ln("A", "F"), _ln("B", "F", "FS", -4), _ln("C", "G"), _ln("D", "G", "SS", 8), _ln("E", "H"), _ln("D", "H", "FF", 4),
             _ln("F", "Z"), _ln("G", "Z"), _ln("H", "Z")]
    return _project("OOS", "2026-03-23T08:00:00", [STD, SIX, TEN], acts, links, data_date="2026-03-30T08:00:00")


def lag_calendars(mode, link_modes=()):
    """Every link type with lags and a lead across four calendars (incl. a midnight-starting seven-day one), the lag
    measured on `mode`'s calendar; `link_modes` gives (link index, lag_calendar) overrides for some links."""
    acts = [_act("A", typ="start_milestone"), _act("B", 40), _act("C", 24, "six_day"), _act("D", 40, "ten_hour"),
            _act("E", 16, "early"), _act("F", 30, "ten_hour"), _act("G", 12.5), _act("H", 64, "early"),
            _act("I", 20, "six_day"), _act("Z", typ="finish_milestone")]
    links = [_ln("A", "B"), _ln("B", "C", "SS", 16), _ln("B", "D", "FF", 8), _ln("C", "E", "SF", 12), _ln("D", "F", "FS", -10),
             _ln("A", "G"), _ln("G", "H", "FS", 20), _ln("E", "Z", "FS", 3.5), _ln("F", "Z"), _ln("H", "Z", "FF", 4),
             _ln("H", "I", "FS", 30), _ln("D", "I", "SS", 100), _ln("I", "Z")]
    for i, m in link_modes:
        links[i]["lag_calendar"] = m
    return _project(f"LAGCAL-{mode or 'default'}", "2026-03-23T08:00:00", [STD, SIX, TEN, EARLY], acts, links, lag_calendar=mode)


BRIEFS = [
    "Two-storey detached house, 180 m2, timber frame on strip foundations, brick and block, start 2 March 2026, finish by end of 2026",
    "24-unit four-storey apartment block, RC frame on piles, brick facade, contaminated ground, start 6 April 2026, finish before Christmas 2027",
    "Three-storey office, 2,400 m2, steel frame, curtain wall, raft foundation, service diversion needed, start 1 June 2026",
    "Single-storey warehouse, 6000 m2, portal frame, cladding, start 13 July 2026, complete by 30 April 2027",
    "Two-storey primary school extension, steel frame, brick, piled foundations, start 7 September 2026",
    "Pair of two-storey semi-detached houses, brick and block, 190 m2, start 4 May 2026",
    "Three-storey care home, masonry, render, 2100 m2, gas main diversion, start 7 September 2026, handover by June 2027",
    "Six-storey office, 4,800 m2, start 1 February 2027, finish by end of 2028",
    "Two-storey house in York, start 6 April 2026, finish by end of November 2026",
    "Hi. Three-storey office in Leeds, steel frame, start 1 June 2026",
]

COMMANDS = ["add 2 weeks to A1040", "link A1010 -> A1030 SS+2d", "finish by 1 Nov 2026", "set A1060 to 15d",
            "constrain A1100 start on or after 16 Mar 2026", "progress A1010 100%", "rename A1020 Site set-up and hoarding",
            "delete A1050", "fix", "help", "shorten A1060 by 3d", "set A1060 to 3.33333d", "add 1.5 weeks to A1040",
            'insert "Scaffold inspection" 1d after A1040 before A1050', "link A1020 -> A1040 FS-1d", "link A1020 -> A1040 FF+1.5d",
            "unlink A1010 A1020", "complete A1010 on 6 Mar 2026", "started A1020 on 9 Mar 2026", "unconstrain A1100",
            "data date 2026-04-20", "assign A1020 Piling gang", "move A1060 to wbs 3", "progress A1030 37.5% as of 20 Apr 2026",
            "constrain A1100 finish on 30 Jun 2026", "do a backflip", "start 4 May 2026", "extend A1040 by 4 days"]

ROUND_VALUES = [(0.5, 0), (1.5, 0), (2.5, 0), (-0.5, 0), (-2.5, 0), (12.5, 0), (62.5, 0), (87.5, 0), (2.675, 2), (1.00005, 4),
                (0.125, 2), (0.375, 2), (123.45675, 4), (5e-05, 4), (0.03125, 4), (7.99999, 0), (1.0005, 3), (2.5, 1), (40.00005, 4)]

DATE_INPUTS = [("2026-03-02", 8), ("2026-3-2", 8), ("2026-03-02T10:30:00", 8), ("2026-03-02T00:00:00", 16), ("2026-03-02T00:00:30", 8),
               ("2026-03-02 10:30", 8), ("2/3/2026", 8), ("02/03/2026", 16), ("2026-02-30", 8), ("2026-03-02 garbage", 8),
               ("  2026-03-02  ", 8), ("31/4/2026", 8), ("", 8), ("2026-13-01", 8), ("2026-03-02T24:00:00", 8), ("2026-03-02T7:5:3", 8),
               ("2026-03-02T16:00:00", 8), ("29/02/2028", 16)]


def _rand_rounds(n=300, seed=7):
    rng = random.Random(seed)
    out = []
    for _ in range(n):
        nd = rng.randint(0, 4)
        base = rng.randint(-200000, 200000) / 10 ** nd
        out.append((base + 0.5 / 10 ** nd, nd))      # decimal ties: exact value sits just above or below .5
        out.append((rng.uniform(-1000, 1000), nd))
    return out


def _rand_numbers(n=1500, seed=11) -> list[float]:
    rng = random.Random(seed)
    xs = [0.0, -0.0, 0.5, -0.5, 1.5, 2.5, 12.5, 62.5, 6.25, 2.675, 1.00005, 0.03125, 1e-05, 1.5e-05, 0.0001, 123456.5,
          999999.5, 1234565.0, 1e16, 1e15, 9.9999995, 13.333333333333334, 35.25, 88.0, 88.00000000000001, -152.4, 1e-300, 5e-324]
    for _ in range(n):
        kind = rng.randint(0, 4)
        if kind == 0:
            xs.append(rng.uniform(-1e4, 1e4))
        elif kind == 1:
            nd = rng.randint(0, 6)
            xs.append(rng.randint(-10 ** 7, 10 ** 7) / 10 ** nd + 0.5 / 10 ** nd)  # decimal near-ties
        elif kind == 2:
            xs.append(rng.randint(-10 ** 9, 10 ** 9) / 8)                            # exact binary ties
        elif kind == 3:
            xs.append(rng.uniform(-1, 1) * 10 ** rng.randint(-12, 20))
        else:
            xs.append(float(rng.randint(10 ** 5, 10 ** 8)))                          # 6-sig-fig integer ties
    return xs


def build_cases() -> list[tuple[str, dict]]:
    cases: list[tuple[str, dict]] = []
    for fn in (links_and_lags, constraints, progress, hammocks, dst_year, logic_loop):
        cases.append((f"schedule-{fn.__name__}", {"kind": "schedule", "project": fn()}))
    demo = json.loads((ROOT / "examples" / "demo_house.json").read_text())
    cases.append(("schedule-demo_house", {"kind": "schedule", "project": Project.model_validate(demo).model_dump(mode="json")}))
    # lag calendars: each project-level option, per-link overrides, and 24-hour lags across a year of DST changes
    for mode in LAG_CALENDARS:
        cases.append((f"schedule-lag_calendar-{mode or 'default'}", {"kind": "schedule", "project": lag_calendars(mode)}))
    cases.append(("schedule-lag_calendar-link-overrides", {"kind": "schedule", "project": lag_calendars(
        "successor", [(1, "24h"), (2, "project"), (4, "predecessor"), (6, "24h"), (9, "24h"), (11, "project")])}))
    cases.append(("schedule-lag_calendar-overrides-on-default", {"kind": "schedule", "project": lag_calendars(
        None, [(3, "successor"), (7, "24h"), (10, "24h"), (11, "successor")])}))
    for mode in ("successor", "24h"):
        cases.append((f"schedule-dst_year-lag-{mode}", {"kind": "schedule", "project": {**dst_year(), "lag_calendar": mode}}))
    cases.append(("level-lag_calendar-24h", {"kind": "level", "project": lag_calendars("24h")}))
    cases.append(("repair-lag_calendar-successor", {"kind": "repair", "project": {**lag_calendars("successor"), "must_finish_by": "2026-04-10T16:00:00"}}))
    # scheduling options: progress logic (out-of-sequence work, with suspend/resume and the lag calendar), float paths,
    # start on new day, the near-critical threshold, and all of them together
    oos_opts = progress()
    for a in oos_opts["activities"]:
        if a["id"] == "E":
            a.update({"suspend_date": "2026-03-27T12:00:00", "resume_date": "2026-04-08T08:00:00"})
    for mode in PROGRESS_LOGIC:
        cases.append((f"schedule-progress_logic-{mode}", {"kind": "schedule", "project": {**progress(), "progress_logic": mode}}))
        cases.append((f"schedule-progress_logic-{mode}-resume", {"kind": "schedule", "project": {**oos_opts, "progress_logic": mode}}))
        cases.append((f"schedule-progress_logic-{mode}-lag24h", {"kind": "schedule", "project": {**oos_chains(), "progress_logic": mode, "lag_calendar": "24h"}}))
        cases.append((f"guard-progress_logic-{mode}", {"kind": "guard", "project": {**oos_chains(), "progress_logic": mode}}))
    for name, fn, n in (("links", links_and_lags, 3), ("constraints", constraints, 4), ("progress", progress, 4), ("hammocks", hammocks, 2), ("dst", dst_year, 10)):
        cases.append((f"schedule-float_paths-{name}-{n}", {"kind": "schedule", "project": {**fn(), "float_paths": n}}))
    cases.append(("schedule-float_paths-demo_house-5", {"kind": "schedule", "project": {**Project.model_validate(demo).model_dump(mode="json"), "float_paths": 5}}))
    cases.append(("schedule-float_paths-capped-99", {"kind": "schedule", "project": {**oos_chains(), "float_paths": 99}}))
    for name, fn in (("links", links_and_lags), ("constraints", constraints), ("progress", progress), ("dst", dst_year)):
        cases.append((f"schedule-start_on_new_day-{name}", {"kind": "schedule", "project": {**fn(), "start_on_new_day": True}}))
    cases.append(("schedule-start_on_new_day-lag24h", {"kind": "schedule", "project": {**lag_calendars("24h"), "start_on_new_day": True}}))
    cases.append(("schedule-start_on_new_day-lag-successor", {"kind": "schedule", "project": {**lag_calendars("successor"), "start_on_new_day": True}}))
    for name, fn, days in (("links-0", links_and_lags, 0), ("links-2.5", links_and_lags, 2.5), ("dst-1", dst_year, 1), ("hammocks-100", hammocks, 100)):
        cases.append((f"schedule-near_critical-{name}", {"kind": "schedule", "project": {**fn(), "near_critical_days": days}}))
    for mode in PROGRESS_LOGIC:
        everything = {**oos_opts, "progress_logic": mode, "lag_calendar": "successor", "float_paths": 6, "start_on_new_day": True, "near_critical_days": 3}
        cases.append((f"schedule-all_options-{mode}", {"kind": "schedule", "project": everything}))
        cases.append((f"guard-all_options-{mode}", {"kind": "guard", "project": everything}))
    cases.append(("level-all_options", {"kind": "level", "project": {**lag_calendars("project"), "float_paths": 4, "start_on_new_day": True, "near_critical_days": 1}}))
    cases.append(("repair-all_options", {"kind": "repair", "project": {**lag_calendars("24h"), "must_finish_by": "2026-04-10T16:00:00", "float_paths": 3, "start_on_new_day": True, "progress_logic": "override"}}))
    for i, b in enumerate(BRIEFS):
        cases.append((f"generate-{i}", {"kind": "generate", "brief": b}))
        proj = _generated(b)
        cases.append((f"level-{i}", {"kind": "level", "project": proj}))
        squeezed = copy.deepcopy(proj)
        squeezed["must_finish_by"] = squeezed["start"][:4] + "-10-30T16:00:00"
        cases.append((f"repair-{i}", {"kind": "repair", "project": squeezed}))
        cases.append((f"analysis-{i}", {"kind": "analysis", "project": proj, "commands": ["add 3 weeks to A1060", "progress A1010 100%"]}))
    # Monte Carlo: same seeded draws, so every percentile and criticality count must match
    for i in (0, 3, 6):
        proj = _generated(BRIEFS[i])
        proj["must_finish_by"] = proj["start"][:4] + "-12-18T16:00:00"
        cases.append((f"risk-{i}", {"kind": "risk", "project": proj, "opts": {"iterations": 40, "seed": 7 + i}}))
    cases.append(("risk-progress", {"kind": "risk", "project": progress(),
                  "opts": {"iterations": 60, "optimistic_pct": 5, "pessimistic_pct": 50, "weather_pct": 0, "correlation_pct": 80, "seed": 3}}))
    # guardrails: out-of-sequence progress and critical path drag (incl. suspend/resume and mixed calendars)
    for i in (0, 2, 5):
        cases.append((f"guard-{i}", {"kind": "guard", "project": _generated(BRIEFS[i])}))
    oos = progress()
    for a in oos["activities"]:
        if a["id"] == "E":
            a.update({"suspend_date": "2026-03-27T12:00:00", "resume_date": "2026-04-08T08:00:00"})
    cases.append(("guard-progress", {"kind": "guard", "project": oos}))
    cases.append(("schedule-suspend-resume", {"kind": "schedule", "project": oos}))
    house = _generated(BRIEFS[0])
    for j, cmd in enumerate(COMMANDS):
        cases.append((f"command-{j}", {"kind": "command", "project": house, "command": cmd}))
    cases.append(("round-fixed", {"kind": "round", "values": ROUND_VALUES}))
    cases.append(("round-random", {"kind": "round", "values": _rand_rounds()}))
    cases.append(("number-formatting", {"kind": "numfmt", "values": _rand_numbers()}))
    cases.append(("parse_date", {"kind": "parse_date", "values": DATE_INPUTS}))
    return cases


def _generated(brief: str) -> dict:
    b = parse_brief(brief)
    p = draft_to_project(generate(b), b.source_text)
    return p.model_dump(mode="json")


# ----------------------------------------------------------------------------------------
# the Python side of each pipeline (mirrors tests/parity/js_runner.js)
# ----------------------------------------------------------------------------------------
def run_py(c: dict) -> dict:
    try:
        k = c["kind"]
        if k == "schedule":
            p = Project.model_validate(c["project"]); schedule(p)
            return {"project": p.model_dump(mode="json"), "health": health_check(p).model_dump(mode="json")}
        if k == "generate":
            b = parse_brief(c["brief"]); d = generate(b)
            p = draft_to_project(d, b.source_text); schedule(p)
            return {"brief": b.model_dump(mode="json"), "draft": d.model_dump(mode="json"),
                    "project": p.model_dump(mode="json"), "health": health_check(p).model_dump(mode="json")}
        if k == "level":
            p = Project.model_validate(c["project"]); level(p)
            return {"project": p.model_dump(mode="json")}
        if k == "repair":
            p = Project.model_validate(c["project"]); schedule(p)
            patch = plan_repairs(p, health_check(p)); log = apply_patch(p, patch); schedule(p)
            return {"patch": patch.model_dump(mode="json"), "log": log, "project": p.model_dump(mode="json"),
                    "health": health_check(p).model_dump(mode="json")}
        if k == "command":
            p = Project.model_validate(c["project"])
            patch = parse_command(p, c["command"]); log = apply_patch(p, patch); schedule(p)
            return {"patch": patch.model_dump(mode="json"), "log": log, "project": p.model_dump(mode="json")}
        if k == "analysis":
            p = Project.model_validate(c["project"]); schedule(p); set_baseline(p, "Tender")
            for cmd in c["commands"]:
                apply_patch(p, parse_command(p, cmd))
            schedule(p)
            return json.loads(json.dumps({"histogram": histogram(p), "cost": cost_curve(p), "variance": variance(p)}, default=_jsonable))
        if k == "guard":
            p = Project.model_validate(c["project"]); schedule(p)
            return {"out_of_sequence": out_of_sequence(p), "drag": critical_drag(p)}
        if k == "risk":
            return risk_analysis(Project.model_validate(c["project"]), **c["opts"])
        if k == "parse_date":
            return {"values": [(lambda d: d.isoformat() if d else None)(_parse_date(s, h)) for s, h in c["values"]]}
        if k == "round":
            return {"values": [round(x, n) for x, n in c["values"]]}
        if k == "numfmt":
            return {"values": [[f"{x:.0f}", f"{x:.1f}", f"{x:.4f}", f"{x:g}", "%+g" % x, str(x), f"{x:,.0f}", x // 44]
                               for x in c["values"]]}
        return {"error": f"unknown kind {k}"}
    except Exception as e:  # noqa: BLE001 - the error text itself is compared
        return {"error": str(e)}


def _jsonable(o):
    if isinstance(o, (datetime, date)):
        return o.isoformat()
    raise TypeError(type(o))


# ----------------------------------------------------------------------------------------
# comparison
# ----------------------------------------------------------------------------------------
VOLATILE = {"scheduled_at", "saved_at"}


def norm(x):
    if isinstance(x, dict):
        # None and "" are how pydantic spells "not set"; the JS objects simply omit the key
        return {k: norm(v) for k, v in x.items() if k not in VOLATILE and v is not None and v != ""}
    if isinstance(x, list):
        return [norm(v) for v in x]
    if isinstance(x, (int, float)) and not isinstance(x, bool):
        if abs(x) >= 2 ** 53:      # beyond exact integers: JSON hands Python an int for JS's double
            return float(x)
        if isinstance(x, float) and x.is_integer():
            return int(x)
    return x


def diff(a, b, path="", out=None, limit=25):
    out = [] if out is None else out
    if len(out) >= limit:
        return out
    if isinstance(a, dict) and isinstance(b, dict):
        for k in sorted(set(a) | set(b)):
            if k not in a or k not in b:
                out.append(f"{path}.{k}: py={a.get(k, '<missing>')!r} js={b.get(k, '<missing>')!r}")
            else:
                diff(a[k], b[k], f"{path}.{k}", out, limit)
    elif isinstance(a, list) and isinstance(b, list):
        if len(a) != len(b):
            out.append(f"{path}: length py={len(a)} js={len(b)}")
        for i, (x, y) in enumerate(zip(a, b)):
            label = x.get("id") if isinstance(x, dict) and "id" in x else i
            diff(x, y, f"{path}[{label}]", out, limit)
    elif isinstance(a, bool) or isinstance(b, bool):
        if a is not b:
            out.append(f"{path}: py={a!r} js={b!r}")
    elif a != b:
        out.append(f"{path}: py={a!r} js={b!r}")
    return out


CASES = build_cases()


@pytest.fixture(scope="module")
def py_results():
    return [norm(run_py(copy.deepcopy(c))) for _, c in CASES]


@pytest.fixture(scope="module", params=TIMEZONES)
def js_results(request):
    payload = json.dumps({"cases": [c for _, c in CASES]})
    res = subprocess.run([NODE, str(RUNNER)], input=payload, capture_output=True, text=True,
                         env={**os.environ, "TZ": request.param}, timeout=300)
    assert res.returncode == 0, res.stderr
    return request.param, [norm(r) for r in json.loads(res.stdout)]


@pytest.mark.parametrize("idx", range(len(CASES)), ids=[n for n, _ in CASES])
def test_engines_agree(idx, py_results, js_results):
    tz, js = js_results
    d = diff(py_results[idx], js[idx])
    assert not d, f"{CASES[idx][0]} under TZ={tz}: {len(d)}+ differences\n  " + "\n  ".join(d)

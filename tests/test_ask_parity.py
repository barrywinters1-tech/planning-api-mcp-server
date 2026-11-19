"""Golden-master parity for the question engine: web/ask.js must match planner/ask.py.

Each case is a (project, question, today) triple. Both engines answer it and the result dicts must be
identical after norm() (key order included; only int/float spelling is normalised), under every
timezone in tests.test_parity.TIMEZONES. Neither engine may mutate the project it was given.

Skipped when node is not installed.
"""
from __future__ import annotations

import copy
import json
import os
import subprocess
from datetime import datetime
from pathlib import Path

import pytest

from planner.ask import ask
from planner.commands import parse_command
from planner.cpm import schedule
from planner.levelling import set_baseline
from planner.model import Project
from planner.plan import apply_patch
from tests.test_parity import BRIEFS, NODE, TIMEZONES, _generated, constraints, diff, hammocks, links_and_lags, norm, progress

ROOT = Path(__file__).resolve().parents[1]
RUNNER = Path(__file__).parent / "parity" / "ask_runner.js"

pytestmark = pytest.mark.skipif(NODE is None, reason="node is not installed")


def progressed_house() -> dict:
    """The generated house with a baseline, an issued revision, progress to 23 Mar 2026 and a closed period."""
    p = Project.model_validate(_generated(BRIEFS[0]))
    schedule(p)
    set_baseline(p, "Tender")
    rev = {"name": "Rev A", "issued_at": "2026-03-01T09:00:00", "note": "", "project": p.model_dump(mode="json", exclude={"revisions"})}
    for cmd in ["started A1010 on 2 Mar 2026", "complete A1010 on 9 Mar 2026", "started A1020 on 9 Mar 2026",
                "progress A1020 50% as of 16 Mar 2026", "add 2 weeks to A1100", "link A1020 -> A1030 FS+2d"]:
        apply_patch(p, parse_command(p, cmd))
    p.data_date = datetime(2026, 3, 23, 8)
    schedule(p)
    p.revisions = [rev]
    p.progress_periods = [{"id": "P1", "name": "Period 1", "data_date": "2026-03-16T08:00:00", "closed_at": "2026-03-16T17:00:00",
                           "pct": 3.5, "planned_pct": 4.0, "finish": "2026-12-01T16:00:00", "acts": {}}]
    return p.model_dump(mode="json")


DEMO_QUESTIONS = [
    "when does brickwork start", "when will the roof be finished", "finish date of A1240", "when do we finish", "completion date",
    "are we on track", "what's critical", "what is driving the finish", "why does A1240 start on 20 May", "what is A1240 waiting for",
    "what does A1240 hold up", "what depends on brick to wall plate", "how much float does A1280 have", "how long is A1210",
    "how many days left on A1440", "what's happening next week", "what's happening in June", "what's on between 1 and 14 April",
    "in the next 3 weeks", "today", "what's in progress", "what's late", "what hasn't started", "milestones", "what's due this month",
    "what are the bricklayers doing", "who is on site in May", "activities for Trade=Groundworks", "how many activities",
    "how many are complete", "how many weeks is the programme", "percent complete", "what if A1240 takes 2 weeks longer",
    "impact of a 5 day delay to A1210", "when is watertight", "what's wrong with the programme", "what changed since Rev A",
    "what should we accelerate", "how likely is the finish", "", "\U0001F3D7️ when does the roof start \U0001F3D7️", "blah blah",
    "what's near-critical", "what's open", "Who is on site week commencing 6 April 2026?", "what if A1100 starts 3 days later",
    "when does the plasterboad start", "status of A1700", "when does decorating start", "when does plastering start",
]
HOUSE_QUESTIONS = [
    ("what changed since Rev A", None), ("what changed since the last period", None), ("what changed since the baseline", None),
    ("what changed", None), ("what's behind baseline", "2026-03-30"), ("what's in progress", None), ("who is on site today", "2026-03-30"),
    ("when does A1020 finish", "2026-03-30"), ("why does A1030 start then", None), ("what if A1020 takes a week longer", None),
    ("are we on track", "2026-04-06T09:00:00"), ("what's happening next week", "2026-03-30"), ("what changed since rev b", None),
    ("what's late", None), ("what's complete", None), ("how many are complete", None),
]
CORPUS_QUESTIONS = ["what's critical", "when does C finish", "why does E start then", "what does D hold up", "what's late", "are we on track",
                    "what's wrong", "what if C takes a week longer", "when is Z", "what's happening this week", "float on B", "how long is C"]


def build_cases() -> list[tuple[str, dict]]:
    demo = json.loads((ROOT / "examples" / "demo_house.json").read_text())
    cases: list[tuple[str, dict]] = []
    for q in DEMO_QUESTIONS:
        cases.append((f"demo: {q[:40] or '<empty>'}", {"project": demo, "question": q, "today": None}))
    house = progressed_house()
    for q, today in HOUSE_QUESTIONS:
        cases.append((f"house: {q}" + (f" @{today}" if today else ""), {"project": house, "question": q, "today": today}))
    for fn in (progress, constraints, hammocks, links_and_lags):
        for q in CORPUS_QUESTIONS:
            cases.append((f"{fn.__name__}: {q}", {"project": fn(), "question": q, "today": None}))
    gen = _generated(BRIEFS[3])
    for q in ["when do we finish", "what's critical", "who is on site in September", "what should we accelerate", "what are the cladders doing"]:
        cases.append((f"brief3: {q}", {"project": gen, "question": q, "today": None}))
    return cases


def run_py(c: dict) -> dict:
    try:
        p = Project.model_validate(copy.deepcopy(c["project"]))
        before = p.model_dump_json()
        r = ask(p, c["question"], today=c["today"])
        return {"result": json.loads(json.dumps(r)), "mutated": p.model_dump_json() != before}
    except Exception as e:  # noqa: BLE001 - the error text itself is compared
        return {"error": str(e)}


CASES = build_cases()


@pytest.fixture(scope="module")
def py_results():
    return [run_py(c) for _, c in CASES]


@pytest.fixture(scope="module", params=TIMEZONES)
def js_results(request):
    payload = json.dumps({"cases": [c for _, c in CASES]})
    res = subprocess.run([NODE, str(RUNNER)], input=payload, capture_output=True, text=True, encoding="utf-8",
                         env={**os.environ, "TZ": request.param}, timeout=600)
    assert res.returncode == 0, res.stderr
    return request.param, json.loads(res.stdout)


@pytest.mark.parametrize("idx", range(len(CASES)), ids=[n for n, _ in CASES])
def test_ask_engines_agree(idx, py_results, js_results):
    tz, js = js_results
    py, jr = py_results[idx], js[idx]
    name = CASES[idx][0]
    assert "error" not in py, f"{name}: Python failed: {py['error']}"
    assert "error" not in jr, f"{name}: JS failed under TZ={tz}: {jr['error']}"
    assert not py["mutated"] and not jr["mutated"], f"{name}: ask mutated its project (py={py['mutated']} js={jr['mutated']})"
    assert list(py["result"]) == list(jr["result"]), f"{name}: key order differs"
    d = diff(norm(py["result"]), norm(jr["result"]))
    assert not d, f"{name} under TZ={tz}: {len(d)}+ differences\n  " + "\n  ".join(d)


def test_cases_cover_every_intent(py_results):
    kinds = {r["result"]["kind"] for r in py_results if "result" in r}
    expected = {"when_start", "when_finish", "milestone", "project_finish", "critical", "why", "holds_up", "float", "duration", "window", "list",
                "resources", "counts", "what_if", "health", "compare", "drag", "risk", "unknown"}
    assert expected <= kinds, expected - kinds

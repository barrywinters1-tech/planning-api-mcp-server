"""Plain-English questions (planner.ask) over the demo house and the generated/corpus projects."""
from __future__ import annotations

import copy
import json
import random
import string
from datetime import datetime
from pathlib import Path

import pytest

from planner.ask import ASK_EXAMPLES, INTENTS, SUGGEST, T, ask
from planner.commands import parse_command
from planner.cpm import schedule
from planner.levelling import set_baseline
from planner.model import Project
from planner.plan import apply_patch
from tests.test_parity import BRIEFS, _generated, constraints, hammocks, links_and_lags, progress

ROOT = Path(__file__).resolve().parents[1]
KEYS = ["kind", "answer", "ids", "filter", "trace", "goto", "confidence", "suggestions"]


@pytest.fixture(scope="module")
def demo() -> Project:
    return Project.model_validate(json.loads((ROOT / "examples" / "demo_house.json").read_text()))


@pytest.fixture(scope="module")
def progressed() -> Project:
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
    return p


def shape_ok(r: dict) -> None:
    assert list(r) == KEYS
    assert r["kind"] in INTENTS
    assert isinstance(r["answer"], str) and r["answer"]
    assert isinstance(r["ids"], list) and len(r["ids"]) <= 12 and len(set(r["ids"])) == len(r["ids"])
    assert isinstance(r["filter"], str)
    assert r["trace"] is None or (set(r["trace"]) == {"ids", "dir"} and r["trace"]["dir"] in ("back", "fwd"))
    assert r["goto"] is None or isinstance(r["goto"], str)
    assert r["confidence"] in ("high", "medium", "low")
    assert len(r["suggestions"]) == 3 and all(s and "{id}" not in s for s in r["suggestions"])


# ----------------------------------------------------------------------------------------
# demo house, data date 2 Mar 2026
# ----------------------------------------------------------------------------------------
DEMO_CASES = [
    ("when does brickwork start", "when_start", ["A1210"], "20 Apr 2026", "33 working days from today", "Other matches: A1240"),
    ("when will the roof be finished", "when_finish", ["A1250"], "17 Jun 2026", "Other matches: A1260"),
    ("finish date of A1240", "when_finish", ["A1240"], "10 Jun 2026", "critical path"),
    ("when do we finish", "project_finish", ["A1730"], "29 Sep 2026", "30 Oct 2026", "23 working days ahead"),
    ("are we on track", "project_finish", ["A1730"], "Work has not started"),
    ("will we hit the deadline", "project_finish", ["A1730"], "ahead of it"),
    ("what's critical", "critical", ["A1720", "A1730"], "longest path to A1730 Practical completion", "29 activities"),
    ("what is driving the finish", "critical", ["A1730"], "longest path"),
    ("why is the finish in October", "critical", ["A1730"], "longest path"),
    ("why does A1240 start on 20 May", "why", ["A1240", "A1230", "A1220"], "driven by A1230 Scaffold lift 2 (FS)", "finishes on 19 May 2026"),
    ("what is A1240 waiting for", "why", ["A1240"], "driven by"),
    ("what does A1240 hold up", "holds_up", ["A1250", "A1290"], "holds up 26 activities", "through to A1720", "move 5 working days later, to 6 Oct 2026"),
    ("what depends on brick to wall plate", "holds_up", ["A1250"], "A1240 Brick and block to wall plate holds up"),
    ("how much float does A1280 have", "float", ["A1280"], "32 working days of total float", "9 working days of free float"),
    ("how long is A1210", "duration", ["A1210"], "15 working days long", "20 Apr 2026 to 11 May 2026"),
    ("how many days left on A1440", "duration", ["A1440"], "12 working days long"),
    ("what's happening next week", "window", ["A1020", "A1030"], "9 Mar 2026 to 15 Mar 2026", "2 activities run"),
    ("what's happening in June", "window", ["A1240", "A1260"], "1 Jun 2026 to 30 Jun 2026", "5 of them are on the critical path"),
    ("what's on between 1 and 14 April", "window", ["A1140", "A1160"], "1 Apr 2026 to 14 Apr 2026"),
    ("in the next 3 weeks", "window", ["A1000", "A1100"], "2 Mar 2026 to 22 Mar 2026"),
    ("today", "window", ["A1000", "A1010", "A1020"], "on 2 Mar 2026"),
    ("what's in progress", "list", [], "Nothing is in progress at the data date of 2 Mar 2026"),
    ("what's late", "list", [], "No baseline is set"),
    ("what hasn't started", "list", ["A1000"], "43 activities not started"),
    ("milestones", "list", ["A1000", "A1170", "A1290", "A1730"], "4 milestones", "A1290 Watertight (29 Jun 2026)"),
    ("what's due this month", "window", ["A1100"], "due to finish 1 Mar 2026 to 31 Mar 2026"),
    ("what are the bricklayers doing", "resources", ["A1140", "A1210", "A1240"], "Bricklayers has 3 activities", "3 of them are on the critical path"),
    ("who is on site in May", "resources", ["A1210", "A1240"], "On site 1 May 2026 to 31 May 2026", "Bricklayers (2 activities)"),
    ("activities for Trade=Groundworks", "resources", ["A1010", "A1150"], "Trade Groundworks gang has 8 activities"),
    ("how many activities", "counts", [], "43 activities (39 tasks and 4 milestones)", "30.1 weeks"),
    ("how many are complete", "counts", [], "0 of 43 activities are complete"),
    ("how many weeks is the programme", "counts", [], "runs 30.1 weeks, from 2 Mar 2026 to 29 Sep 2026 (147 working days"),
    ("percent complete", "counts", [], "0% complete by duration"),
    ("what if A1240 takes 2 weeks longer", "what_if", ["A1240"], "took 10 working days longer", "13 Oct 2026", "10 working days later",
     "still meet the required completion date of 30 Oct 2026, with 13 working days to spare", "Use Try mode to make the change and see it on the chart."),
    ("impact of a 5 day delay to A1210", "what_if", ["A1210"], "started 5 working days later", "6 Oct 2026"),
    ("when is watertight", "milestone", ["A1290"], "A1290 Watertight is forecast for 29 Jun 2026", "82 working days from today"),
    ("when is practical completion", "milestone", ["A1730"], "29 Sep 2026"),
    ("what's wrong with the programme", "health", ["A1400", "A1270"], "scores 79/100: 3 of 14 checks fail", "Lags:", "Nothing has progressed out of sequence"),
    ("is the logic sound", "health", [], "checks fail"),
    ("what changed since Rev A", "compare", [], 'No revision called "rev a"'),
    ("what changed since the last period", "compare", [], "No progress period has been closed"),
    ("what changed since the baseline", "compare", [], "No baseline is set"),
    ("what should we accelerate", "drag", ["A1210", "A1240", "A1440"], "A1210 Brick and block to first floor (15 working days of drag)", "Drag is the time"),
    ("where can we save time", "drag", ["A1210"], "drag"),
    ("how likely is the finish", "risk", [], "Risk analysis is not stored", "29 Sep 2026, 23 working days ahead"),
    ("A1240", "when_start", ["A1240"], "20 May 2026"),
    ("what's near-critical", "list", [], "No open activity has 10 working days of float or less"),
    ("what's open", "list", ["A1000"], "43 activities not finished (0 in progress and 43 not started)"),
]


@pytest.mark.parametrize("case", DEMO_CASES, ids=[c[0] for c in DEMO_CASES])
def test_demo_questions(demo, case):
    question, kind, ids, *phrases = case
    r = ask(demo, question)
    shape_ok(r)
    assert r["kind"] == kind, r["answer"]
    for i in ids:
        assert i in r["ids"], (r["ids"], r["answer"])
    for ph in phrases:
        assert ph in r["answer"], r["answer"]


def test_result_details_for_ui(demo):
    r = ask(demo, "what's critical")
    assert r["filter"] == "critical=yes" and r["trace"] == {"ids": ["A1730"], "dir": "back"} and r["confidence"] == "high"
    assert len(r["ids"]) == 12   # the 12 nearest the finish, in chain order
    r = ask(demo, "why does A1240 start then")
    assert r["trace"] == {"ids": ["A1240"], "dir": "back"} and r["goto"] == "A1240"
    assert r["ids"][:3] == ["A1240", "A1230", "A1220"] and len(r["ids"]) == 7   # X plus six driving steps
    r = ask(demo, "what does A1240 hold up")
    assert r["trace"] == {"ids": ["A1240"], "dir": "fwd"} and r["goto"] == "A1240"
    assert ask(demo, "what's in progress")["filter"] == "status=in progress"
    assert ask(demo, "what hasn't started")["filter"] == "status=not started"
    assert ask(demo, "milestones")["filter"] == "quick:milestones"
    assert ask(demo, "what are the bricklayers doing")["filter"] == "resource=Bricklayers"
    assert ask(demo, "activities for Trade=Groundworks")["filter"] == "Trade=Groundworks gang"
    assert ask(demo, "what's near-critical")["filter"] == "Float<=10; critical=no"
    assert ask(demo, "finish date of A1240")["suggestions"] == ["Why does A1240 start then?", "What does A1240 hold up?", "How much float does A1240 have?"]


def test_unknown_questions_explain_what_can_be_asked(demo):
    for q in ["", "   ", "blah blah", "\U0001F3D7️\U0001F3D7️", "¿qué?", None, 42]:
        r = ask(demo, q)
        shape_ok(r)
        assert r["kind"] == "unknown" and r["confidence"] == "low"
        assert r["answer"] == T["unknown"] and r["suggestions"] == SUGGEST["unknown"]


def test_fuzz_never_raises(demo):
    rng = random.Random(3)
    alphabet = string.ascii_letters + string.digits + " ?!=:/-'\"\n\t" + "éü€\U0001F3D7"
    words = ["when", "what", "A1240", "start", "finish", "if", "takes", "2 weeks", "longer", "float", "hold up", "why", "between", "1 and 14 April",
             "next", "week", "critical", "who", "Trade=", "brick", "since", "rev", "how many", "complete", "today", "in June", "late", "9 March 2026"]
    for i in range(200):
        if i % 2:
            q = " ".join(rng.choice(words) for _ in range(rng.randint(1, 9)))
        else:
            q = "".join(rng.choice(alphabet) for _ in range(rng.randint(0, 60)))
        r = ask(demo, q)
        shape_ok(r)
    shape_ok(ask(demo, "x" * 10000))
    shape_ok(ask(demo, "when does " + "brick " * 3000))
    shape_ok(ask(demo, "\U0001F3D7️" * 2000))


def test_never_mutates_and_schedules_an_unscheduled_project():
    p = Project.model_validate(links_and_lags())
    assert p.finish is None
    before = p.model_dump_json()
    r = ask(p, "when do we finish")
    assert r["kind"] == "project_finish" and "forecast to finish on" in r["answer"]
    assert p.model_dump_json() == before


def test_empty_project_and_logic_loop():
    p = Project.model_validate(links_and_lags())
    p.activities, p.relationships = [], []
    assert ask(p, "when do we finish")["answer"] == T["empty"]
    from tests.test_parity import logic_loop
    r = ask(Project.model_validate(logic_loop()), "when do we finish")
    assert r["kind"] == "unknown" and "logic loop" in r["answer"]


def test_today_override(demo):
    r0 = ask(demo, "when is watertight")
    r1 = ask(demo, "when is watertight", today="2026-06-22")
    assert "82 working days from today" in r0["answer"]
    assert "6 working days from today" in r1["answer"]      # Mon 22 Jun 00:00 to Mon 29 Jun 16:00
    r2 = ask(demo, "what's happening this week", today="2026-06-24T10:00:00")
    assert "22 Jun 2026 to 28 Jun 2026" in r2["answer"] and "A1260" in r2["ids"]
    assert ask(demo, "today", today="not a date")["answer"] == ask(demo, "today")["answer"]
    r3 = ask(demo, "when is watertight", today="2026-07-06")
    assert "4 working days ago" in r3["answer"]


def test_progressed_project(progressed):
    p = progressed
    r = ask(p, "what changed since Rev A")
    assert r["kind"] == "compare" and r["answer"].startswith("Against Rev A: Forecast completion has moved later by 23.5 working days")
    assert "A1100" in r["ids"] and "A1020" in r["ids"]
    r = ask(p, "what changed since rev b")
    assert r["kind"] == "compare" and r["confidence"] == "low" and "Issued revisions: Rev A" in r["answer"]
    r = ask(p, "what changed since the last period")
    assert "Since Period 1 (data date 16 Mar 2026)" in r["answer"] and "from 1 Dec 2026 to 28 Jul 2026 (89 working days earlier)" in r["answer"]
    assert "progress has gone from 3.5% to 3.8%" in r["answer"]
    r = ask(p, "what changed since the baseline")
    assert r["filter"] == "quick:late" and "28 Jul 2026 versus 25 Jun 2026: 23.5 working days later" in r["answer"]
    r = ask(p, "what's behind baseline")
    assert r["kind"] == "list" and r["filter"] == "quick:late" and "49 activities behind baseline finish" in r["answer"] and "(+34d)" in r["answer"]
    r = ask(p, "what's in progress")
    assert r["ids"] == ["A1020"] and "1 activity in progress" in r["answer"]
    r = ask(p, "what's complete")
    assert r["ids"] == ["A1010"] and r["filter"] == "status=complete"
    r = ask(p, "are we on track")
    assert "3.8% complete against 13.7% planned" in r["answer"]
    r = ask(p, "when does A1020 finish")
    assert r["kind"] == "when_finish" and "started on 9 Mar 2026 and is 50% complete" in r["answer"]
    r = ask(p, "why does A1030 start then")
    assert "driven by A1020 Strip topsoil and reduce levels (FS+2d)" in r["answer"] and r["ids"] == ["A1030", "A1020"]
    r = ask(p, "who is on site today", today="2026-03-30")
    assert r["kind"] == "resources" and "Groundworks gang (1 activity)" in r["answer"] and "A1030" in r["ids"]
    r = ask(p, "what if A1010 takes a week longer")
    assert "is complete, so a change to it cannot move the programme" in r["answer"]


def test_corpus_projects():
    pr = Project.model_validate(progress())
    r = ask(pr, "when does C finish")
    assert "C Activity C started on 17 Mar 2026 and is 40% complete" in r["answer"] and "negative float" in r["answer"]
    r = ask(pr, "what's late")
    assert "negative float" in r["answer"] and r["ids"] == ["C"] and r["filter"] == "Float<0"
    r = ask(pr, "what's wrong")
    assert "1 activity progressed out of sequence: E Activity E" in r["answer"] and "E" in r["ids"]
    r = ask(pr, "what if a takes a week longer")     # "a" is a word here, not activity A
    assert r["kind"] == "what_if" and r["confidence"] == "low" and r["answer"].startswith("Which activity")
    r = ask(pr, "when does A finish")
    assert r["kind"] == "milestone" and "A Activity A was achieved on 2 Mar 2026" in r["answer"]
    c = Project.model_validate(constraints())
    r = ask(c, "why does F start then")
    assert "set by its must start on constraint of 11 May 2026" in r["answer"]
    r = ask(c, "when is Z")
    assert "4 working days behind the required completion date (negative float)" in r["answer"]
    r = ask(c, "what's critical")
    assert "One has negative float: Z Activity Z" in r["answer"]
    h = Project.model_validate(hammocks())
    r = ask(h, "how long is L1")
    assert r["kind"] == "duration" and "L1" in r["ids"]
    r = ask(h, "what's happening this week")
    assert r["kind"] == "window" and "L1" not in r["ids"]   # hammocks are not listed


def test_name_matching_is_tolerant():
    demo = Project.model_validate(json.loads((ROOT / "examples" / "demo_house.json").read_text()))
    assert ask(demo, "when does the plasterboad start")["goto"] == "A1440"       # one-letter typo
    assert ask(demo, "when does decorating start")["goto"] == "A1520"           # stem: decorating / decoration
    assert ask(demo, "when does plastering start")["goto"] == "A1440"           # prefix: plaster / plasterboard
    assert ask(demo, "when does the scaffolding start")["goto"] == "A1300"      # prefix; "Strike scaffold" has the best coverage
    assert ask(demo, "when does scaffold lift 2 start")["goto"] == "A1230"      # the number tells lift 2 from lift 1
    assert ask(demo, "when does a1240 start")["goto"] == "A1240"                # id in lower case
    assert ask(demo, "when does scaffold lift 2 start")["goto"] == "A1230"
    r = ask(demo, "when does first fix start")
    assert r["goto"] == "A1410" and "Other matches: A1420 First fix plumbing and heating and A1400" in r["answer"] and r["confidence"] == "medium"


def test_examples_are_all_understood(demo):
    assert len(ASK_EXAMPLES) == 12
    for q in ASK_EXAMPLES:
        assert ask(demo, q)["kind"] != "unknown", q


def test_api_route(tmp_path, monkeypatch):
    import api
    from fastapi.testclient import TestClient
    from planner import store
    monkeypatch.setattr(store, "DATA_DIR", tmp_path)
    c = TestClient(api.app)
    j = c.post("/api/generate", json={"text": "Two-storey house in Leeds, start 6 April 2026"}).json()
    pid = (j.get("project") or j)["id"]
    r = c.post(f"/api/projects/{pid}/ask", json={"question": "when do we finish"})
    assert r.status_code == 200 and r.json()["kind"] == "project_finish"
    r = c.post(f"/api/projects/{pid}/ask", json={"question": "what's happening this week", "today": "2026-04-13"})
    assert r.json()["kind"] == "window" and "13 Apr 2026 to 19 Apr 2026" in r.json()["answer"]
    assert c.post("/api/projects/nope/ask", json={"question": "hi"}).status_code == 404


def test_mcp_tool(tmp_path, monkeypatch):
    import mcp_server
    from planner import store
    monkeypatch.setattr(store, "DATA_DIR", tmp_path)
    p = Project.model_validate(copy.deepcopy(_generated(BRIEFS[0])))
    store.save(p)
    r = mcp_server.ask_programme(p.id, "what's critical")
    assert r["kind"] == "critical" and r["filter"] == "critical=yes"
    assert "error" in mcp_server.ask_programme("missing", "hi")

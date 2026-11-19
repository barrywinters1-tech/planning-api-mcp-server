"""The briefing: the programme reports its own state in plain English, deterministically.

Scenario builders here are shared with tests/test_briefing_parity.py, so every project is built in
Python (period records the way app.js closes a period, revisions the way api.py issues them) and the
same JSON goes through both engines.
"""
from __future__ import annotations

import copy
import json
import re
from datetime import date, datetime, timedelta
from pathlib import Path

import pytest

from planner.briefing import T, briefing
from planner.cpm import schedule
from planner.levelling import level, set_baseline
from planner.model import ActivityType, Project, Status
from tests.test_compare_parity import _step
from tests.test_parity import BRIEFS, _generated, constraints, links_and_lags, progress

ROOT = Path(__file__).resolve().parents[1]
MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
KEYS = ["as_of", "headline", "status", "kpis", "since", "watch", "next", "actions", "milestones", "prose"]
KPI_KEYS = ["finish", "deadline", "spare_days", "pct_complete", "pct_expected", "critical_open", "health_score", "activities_open", "weeks_remaining"]
STATUSES = {"on_track", "at_risk", "late", "no_deadline", "not_started", "complete"}
REASONS = {"negative_float", "critical_soon", "near_critical", "behind_baseline", "out_of_sequence", "high_drag", "constraint",
           "open_end", "long_duration", "no_progress"}
ORDER = ["set_baseline", "close_period", "repair", "accelerate", "add_deadline", "review_logic", "issue", "run_risk"]


def _fmt(d: date) -> str:
    return f"{d.day} {MONTHS[d.month - 1]} {d.year}"


def reasons_in(w: dict) -> set[str]:
    """Every reason a watch entry carries: the top one in `reason`, the rest merged into its text.
    Each reason is recognised by the longest literal run of its template in the string table."""
    out = {w["reason"]}
    for r in REASONS:
        sig = max(re.split(r"\{\w+\}", T["w_" + r]), key=len)
        if sig in w["text"]:
            out.add(r)
    return out


def _dd(iso: str) -> str:
    return _fmt(date.fromisoformat(iso[:10]))


# ----------------------------------------------------------------------------------------
# scenario builders
# ----------------------------------------------------------------------------------------
def house(i: int = 0) -> Project:
    return Project.model_validate(_generated(BRIEFS[i]))


def period_record(p: Project, name: str, closed_at: datetime | None = None) -> dict:
    """The record app.js keeps when a period is closed (periodSnap): per activity [start, finish, %, status]."""
    schedule(p)
    acts = {}
    for a in p.activities:
        st, fi = a.start, a.finish
        if not st or not fi:
            continue
        acts[a.id] = [st.isoformat()[:16], fi.isoformat()[:16], 100 if a.status == Status.COMPLETE else round(a.percent_complete),
                      "c" if a.status == Status.COMPLETE else "p" if a.status == Status.IN_PROGRESS else "n"]
    tasks = [a for a in p.activities if a.type == ActivityType.TASK and a.duration_hours > 0]
    total = sum(a.duration_hours for a in tasks) or 1
    done = sum(a.duration_hours * (100 if a.status == Status.COMPLETE else a.percent_complete) / 100 for a in tasks)
    dd = p.data_date or p.start
    return {"id": "P" + name.replace(" ", ""), "name": name, "data_date": dd.isoformat(), "closed_at": (closed_at or dd).isoformat(),
            "pct": round(done / total * 100, 1), "planned_pct": round(done / total * 100, 1), "finish": p.finish.isoformat(), "acts": acts}


def revision_record(p: Project, name: str, issued_at: datetime) -> dict:
    return {"name": name, "issued_at": issued_at.isoformat(), "note": "", "project": p.model_dump(mode="json", exclude={"revisions"})}


def tracked(i: int = 0, *, baseline=True, period=True, revision=True, revision_after_period=True, stale=False, second_period=False,
            same_name=False) -> Project:
    """A generated house four weeks in: a Tender baseline, Period 1 closed at week two, Rev A issued either just
    after it (so the revision is the most recent record) or before it, then two more weeks of progress and a
    two-week slip on the critical foundations. `stale` records no progress on A1020 after Period 1."""
    p = house(i)
    schedule(p)
    if baseline:
        set_baseline(p, "Tender")
        p.baselines[0].saved_at = p.start
    s = p.start.date()
    d = lambda k: _fmt(s + timedelta(days=k))  # noqa: E731
    for cmd in (f"complete A1000 on {d(0)}", f"started A1010 on {d(0)}", f"complete A1010 on {d(4)}", f"started A1020 on {d(7)}",
                f"data date {(s + timedelta(days=14)).isoformat()}"):
        _step(p, cmd)
    schedule(p)
    per = period_record(p, "Period 1")
    # same_name: the revision the UI issues alongside a closed period ("keep a full copy"), carrying the period's name
    rev = revision_record(p, "Period 1" if same_name else "Rev A",
                          datetime.combine(s + timedelta(days=14 if revision_after_period else 10), datetime.min.time()).replace(hour=12))
    steps = ["add 2 weeks to A1100", f"data date {(s + timedelta(days=28)).isoformat()}"]
    if not stale:
        steps.insert(0, f"progress A1020 40% as of {d(21)}")
    for cmd in steps:
        _step(p, cmd)
    schedule(p)
    p.progress_periods = [per] if period else None
    if period and second_period:
        p.progress_periods.append(period_record(p, "Period 2"))
    p.revisions = [rev] if revision else []
    return p


def tight_deadline(i: int = 0) -> Project:
    p = house(i)
    p.must_finish_by = (p.start + timedelta(days=60)).replace(hour=16)
    return p


def complete_house(i: int = 0) -> Project:
    p = house(i)
    schedule(p)
    for a in p.activities:
        a.status, a.percent_complete = Status.COMPLETE, 100.0
        a.actual_start, a.actual_finish = a.early_start, a.early_finish
    p.data_date = p.finish + timedelta(days=1)
    schedule(p)
    return p


def levelled_house(i: int = 5) -> Project:
    p = house(i)
    level(p)
    return p


def synthesised_baseline(i: int = 0) -> Project:
    """Baseline dates on the activities (as a P6 import leaves them) but no baseline record."""
    p = house(i)
    set_baseline(p, "Imported")
    p.baselines = []
    _step(p, "add 1 week to A1100")
    schedule(p)
    return p


def open_end_and_long() -> Project:
    """The links-and-lags corpus project with G -> H removed (G has no successor, H no predecessor) and H a 50-day task."""
    p = Project.model_validate(links_and_lags())
    p.relationships = [r for r in p.relationships if not (r.predecessor_id == "G" and r.successor_id == "H")]
    p.activity("H").duration_hours = 50 * 8
    return p


def milestones_only() -> Project:
    data = {"id": "MS", "name": "Milestones", "start": "2026-03-02T08:00:00", "default_calendar_id": "standard",
            "calendars": {"standard": {"id": "standard", "name": "Standard"}},
            "activities": [{"id": "M1", "name": "Start", "type": "start_milestone"},
                           {"id": "M2", "name": "Mid", "type": "finish_milestone", "constraint": "start_on_or_after", "constraint_date": "2026-03-10T08:00:00"},
                           {"id": "M3", "name": "End", "type": "finish_milestone", "constraint": "start_on_or_after", "constraint_date": "2026-04-01T08:00:00"}],
            "relationships": [{"predecessor_id": "M1", "successor_id": "M2"}, {"predecessor_id": "M2", "successor_id": "M3"}],
            "must_finish_by": "2026-04-10T16:00:00"}
    return Project.model_validate(data)


def empty_project() -> Project:
    return Project(id="empty", name="Empty", start="2026-03-02T08:00:00")


def bare_period(i: int = 0) -> Project:
    """A period record with no finish or percentage recorded (an older or hand-made record)."""
    p = tracked(i, revision=False)
    p.progress_periods[0]["finish"] = None
    p.progress_periods[0]["pct"] = None
    return p


def demo_house() -> Project:
    return Project.model_validate(json.loads((ROOT / "examples" / "demo_house.json").read_text()))


# ----------------------------------------------------------------------------------------
# shape
# ----------------------------------------------------------------------------------------
def check_shape(b: dict) -> None:
    assert list(b) == KEYS
    assert list(b["kpis"]) == KPI_KEYS
    assert b["status"] in STATUSES
    assert re.fullmatch(r"\d{4}-\d{2}-\d{2}", b["as_of"])
    assert b["headline"].endswith(".") and "\n" not in b["headline"]
    assert b["since"]["kind"] in {"period", "revision", "baseline", "none"} and len(b["since"]["items"]) <= 8
    assert len(b["watch"]) <= 8
    sev = [w["severity"] for w in b["watch"]]
    assert sev == sorted(sev, reverse=True) and all(s in (1, 2, 3) for s in sev)
    assert all(w["reason"] in REASONS and w["text"] for w in b["watch"])
    assert len({w["id"] for w in b["watch"]}) == len(b["watch"])
    for k in ("starting", "finishing", "milestones"):
        assert len(b["next"][k]) <= 10
        assert [x["date"] for x in b["next"][k]] == sorted(x["date"] for x in b["next"][k])
    kinds = [a["kind"] for a in b["actions"]]
    assert len(kinds) <= 5 and kinds == sorted(kinds, key=ORDER.index) and len(set(kinds)) == len(kinds)
    paras = b["prose"].split("\n\n")
    assert 2 <= len(paras) <= 4 and all(paras)
    assert paras[0].startswith(b["headline"])
    assert _dd(b["kpis"]["finish"]) in b["prose"]
    for m in b["milestones"]:
        assert list(m) == ["id", "name", "date", "baseline_date", "variance_days", "status"]


# ----------------------------------------------------------------------------------------
# tests
# ----------------------------------------------------------------------------------------
def test_demo_house():
    p = demo_house()
    b = briefing(p)
    check_shape(b)
    assert b["as_of"] == "2026-03-02"
    assert b["status"] == "not_started"
    assert b["headline"] == "Not started: forecast finish 29 Sep 2026, 23 working days inside the 30 Oct 2026 deadline."
    assert b["kpis"]["finish"] == "2026-09-29T16:00:00" and b["kpis"]["deadline"] == "2026-10-30T16:00:00"
    assert b["kpis"]["spare_days"] == 23 and b["kpis"]["activities_open"] == 43 and b["kpis"]["pct_complete"] == 0
    assert b["kpis"]["health_score"] == 79 and b["kpis"]["weeks_remaining"] == 30.1
    assert b["since"]["kind"] == "none" and b["since"]["summary"] == T["since_none"]
    # the stored critical flags are stale: the briefing reschedules, so the foundations show as critical and imminent
    top = b["watch"][0]
    assert top["id"] == "A1100" and top["reason"] == "critical_soon" and top["severity"] == 3
    # with nothing started nearly every critical task carries drag: it is not news, so it is not watched
    assert [w["reason"] for w in b["watch"]] == ["critical_soon"]
    assert b["next"]["from"] == "2026-03-02" and b["next"]["to"] == "2026-03-16"
    assert [x["id"] for x in b["next"]["milestones"]] == ["A1000"]
    assert [a["kind"] for a in b["actions"]] == ["set_baseline", "run_risk"]
    assert b["milestones"][0]["id"] == "A1000" and b["milestones"][-1]["date"] == "2026-09-29T16:00:00"
    assert all(m["baseline_date"] is None and m["variance_days"] is None for m in b["milestones"])
    assert "29 Sep 2026" in b["prose"] and "No baseline, revision or closed period yet." in b["prose"]
    assert "Next steps: Set a baseline" in b["prose"]


@pytest.mark.parametrize("i", range(len(BRIEFS)))
def test_generated_projects(i):
    raw = _generated(BRIEFS[i])
    p = Project.model_validate(raw)
    before = p.model_dump_json()
    b = briefing(p)
    check_shape(b)
    assert p.model_dump_json() == before, "briefing mutated its input"
    assert p.finish is None, "the unscheduled input stayed unscheduled"
    assert b["status"] in ("not_started", "late") and b["actions"][0]["kind"] == "set_baseline"   # brief 3 is generated late
    assert briefing(Project.model_validate(raw)) == b, "not deterministic"


def test_since_picks_the_most_recent_record():
    b = briefing(tracked())                                   # Rev A issued four hours after Period 1 was closed
    check_shape(b)
    assert b["since"]["kind"] == "revision" and b["since"]["name"] == "Rev A"
    assert b["since"]["finish_shift_days"] and b["since"]["finish_shift_days"] > 0
    assert b["since"]["summary"].startswith("What changed since Rev A (issued ")
    assert "finish moved" in b["since"]["summary"] and "duration" in b["since"]["summary"]
    assert any(it["id"] == "A1100" and "+10d" in it["text"] for it in b["since"]["items"])

    b = briefing(tracked(same_name=True))                     # the "keep a full copy" revision, named after the period
    assert b["since"]["kind"] == "revision" and b["since"]["name"] == "Period 1"
    assert b["since"]["date"] == "2026-03-16T08:00:00", "dated by the period's data date, not the clock when it was issued"
    assert b["since"]["summary"].startswith("What changed since Period 1 (data date 16 Mar 2026): finish moved ")
    assert "What changed since Period 1 (data date 16 Mar 2026)" in b["prose"] and "issued" not in b["prose"]

    b = briefing(tracked(revision_after_period=False))        # Rev A predates Period 1
    assert b["since"]["kind"] == "period" and b["since"]["name"] == "Period 1"
    assert b["since"]["summary"].startswith("What changed since Period 1 (data date 16 Mar 2026): ")
    assert b["since"]["finish_shift_days"] and b["since"]["finish_shift_days"] > 0
    assert "slipped" in b["since"]["summary"] and "progress " in b["since"]["summary"]
    assert len(b["since"]["items"]) == 8 and all(" later, " in it["text"] for it in b["since"]["items"])
    slips = [float(re.search(r"moved ([\d.]+) working", it["text"]).group(1)) for it in b["since"]["items"]]
    assert slips == sorted(slips, reverse=True), "biggest slips first"
    assert "issue" in [a["kind"] for a in b["actions"]]

    b = briefing(tracked(period=False, revision=False))
    assert b["since"]["kind"] == "baseline" and b["since"]["name"] == "Tender"
    assert b["since"]["summary"].startswith("Against the Tender baseline (saved ")
    assert "behind their baseline finish" in b["since"]["summary"]

    b = briefing(tracked(baseline=False, period=False, revision=False))
    assert b["since"]["kind"] == "none"

    b = briefing(synthesised_baseline())
    assert b["since"]["kind"] == "baseline" and b["since"]["date"] is None
    assert b["since"]["summary"].startswith("Against the Baseline baseline: ")

    b = briefing(bare_period())
    assert b["since"]["kind"] == "period" and b["since"]["finish_shift_days"] is None
    assert b["since"]["summary"].startswith("What changed since Period 1") and "no finish was recorded" in b["since"]["summary"]


def test_period_closed_today_compares_with_the_one_before():
    b = briefing(tracked(revision=False, second_period=True))
    assert b["since"]["kind"] == "period" and b["since"]["name"] == "Period 1"
    assert "close_period" not in [a["kind"] for a in b["actions"]]


def test_watch_reasons():
    b = briefing(Project.model_validate(progress()))
    check_shape(b)
    by = {w["id"]: w for w in b["watch"]}
    assert b["status"] == "at_risk" and b["headline"].startswith("At risk: forecast finish 20 Apr 2026, no deadline set, with 1 activity on negative float.")
    assert by["C"]["reason"] == "negative_float" and by["C"]["severity"] == 3 and "9.5 working days" in by["C"]["text"]
    assert by["E"]["reason"] == "out_of_sequence" and "(C)" in by["E"]["text"]
    assert by["F"]["reason"] == "critical_soon" and by["F"]["severity"] == 3 and "drag" in by["F"]["text"], "reasons merge into one entry"
    assert by["D"]["reason"] == "high_drag"

    b = briefing(tight_deadline())
    assert b["status"] == "late" and b["headline"].startswith("Late: ")
    assert b["watch"][0]["reason"] == "negative_float" and b["watch"][0]["severity"] == 3
    acc = next(a for a in b["actions"] if a["kind"] == "accelerate")
    assert acc["text"].startswith("Recover ") and "most drag" in acc["text"]

    b = briefing(tracked())
    reasons = set()
    for w in b["watch"]:
        reasons |= reasons_in(w)
    assert "behind_baseline" in reasons
    assert "high_drag" not in reasons, "drag is only watched when the programme is late or at risk"
    assert not any("high_drag" in reasons_in(w) for w in briefing(demo_house())["watch"])
    late = briefing(tight_deadline())
    assert sum("high_drag" in reasons_in(w) for w in late["watch"]) <= 2

    b = briefing(Project.model_validate(constraints()))
    by = {w["id"]: w for w in b["watch"]}
    assert by["G"]["reason"] == "constraint" and "must finish on" in by["G"]["text"]
    assert any(w["reason"] == "near_critical" for w in b["watch"])

    b = briefing(open_end_and_long())
    by = {w["id"]: w for w in b["watch"]}
    assert by["G"]["reason"] == "open_end" and "no successor" in by["G"]["text"]
    # H is critical and imminent, an open end and a 50-day task: one entry under its top reason, every reason in the text
    assert by["H"]["reason"] == "critical_soon" and "no predecessor" in by["H"]["text"] and "50 working days remaining" in by["H"]["text"]

    b = briefing(tracked(stale=True, revision=False))
    by = {w["id"]: w for w in b["watch"]}
    assert "no_progress" in reasons_in(by["A1020"]) and "since Period 1" in by["A1020"]["text"]
    assert by["A1020"]["reason"] == "behind_baseline", "the top reason wins; the rest are in the text"
    assert "long_duration" in reasons_in({"reason": "critical_soon", "text": T["w_long_duration"].format(n="50 working days")})


def test_actions_order():
    assert [a["kind"] for a in briefing(Project.model_validate(progress()))["actions"]] == ["close_period", "accelerate", "add_deadline", "review_logic"]
    assert [a["kind"] for a in briefing(demo_house())["actions"]] == ["set_baseline", "run_risk"]
    b = briefing(Project.model_validate(constraints()))
    kinds = [a["kind"] for a in b["actions"]]
    assert kinds == ["set_baseline", "repair", "accelerate"]
    assert "run the repair" in b["actions"][1]["text"] and "/100" in b["actions"][1]["text"]
    kinds = [a["kind"] for a in briefing(tracked(revision_after_period=False))["actions"]]
    assert "issue" in kinds and kinds == sorted(kinds, key=ORDER.index)
    kinds = [a["kind"] for a in briefing(tracked(revision=False, period=False))["actions"]]
    assert kinds[0] == "close_period", "work is in progress and no period has ever been closed"
    assert "close_period" not in [a["kind"] for a in briefing(tracked())["actions"]], "Period 1 is only two weeks old: none is due yet"
    b = briefing(tracked(2, baseline=False))
    assert b["status"] == "no_deadline" and "add_deadline" in [a["kind"] for a in b["actions"]]


def test_no_dates_empty_and_complete():
    b = briefing(empty_project())
    check_shape(b)
    assert b["status"] == "not_started" and b["headline"] == T["head_empty"]
    assert b["kpis"]["activities_open"] == 0 and b["kpis"]["health_score"] is None and b["watch"] == [] and b["actions"] == []
    assert b["prose"].count("\n\n") == 1

    b = briefing(complete_house())
    check_shape(b)
    assert b["status"] == "complete" and b["headline"].startswith("Complete: all 49 activities finished")
    assert b["kpis"]["pct_complete"] == 100 and b["kpis"]["activities_open"] == 0 and b["kpis"]["weeks_remaining"] == 0
    assert b["watch"] == [] and b["next"]["starting"] == [] and b["actions"] == []

    b = briefing(milestones_only())
    check_shape(b)
    assert b["kpis"]["pct_complete"] == 0 and len(b["milestones"]) == 3 and b["status"] == "not_started"

    p = levelled_house()
    b = briefing(p)
    check_shape(b)
    assert b["kpis"]["finish"] == p.finish.isoformat(), "a levelled programme keeps its levelled dates"


def test_today_parameter():
    p = demo_house()
    for today in ("2026-05-04", date(2026, 5, 4), datetime(2026, 5, 4, 8)):
        b = briefing(p, today=today)
        assert b["as_of"] == "2026-05-04" and b["next"]["from"] == "2026-05-04" and b["next"]["to"] == "2026-05-18"
        assert "at 4 May 2026" in b["prose"]
    b = briefing(tracked(), today="2026-04-20")
    assert b["as_of"] == "2026-04-20" and b["since"]["kind"] == "revision"


def test_prose_reads_as_a_cover_note():
    b = briefing(tracked())
    paras = b["prose"].split("\n\n")
    assert len(paras) == 4
    assert paras[0].startswith(b["headline"]) and "% complete against" in paras[0]
    assert paras[1].startswith("What changed since Rev A") and "The biggest movers:" in paras[1]
    assert paras[2].startswith("To watch: ") and "In the next two weeks (" in paras[2]
    assert paras[3].startswith("Next steps: ")
    assert " and " in paras[1] and "  " not in b["prose"]


def test_string_table_matches_the_js_port():
    js = (ROOT / "web" / "briefing.js").read_text(encoding="utf-8")
    body = js[js.index("const T = {"):js.index("\n};", js.index("const T = {"))]
    table = {}
    for m in re.finditer(r"^\s+(\w+): '((?:[^'\\]|\\.)*)',\s*$", body, re.M):
        table[m.group(1)] = m.group(2).replace("\\'", "'").replace("\\\\", "\\")
    assert table == T


def test_api_and_mcp(tmp_path, monkeypatch):
    from fastapi.testclient import TestClient
    from planner import store
    monkeypatch.setattr(store, "DATA_DIR", tmp_path)
    import api
    import mcp_server
    p = tracked()
    store.save(p)
    c = TestClient(api.app)
    r = c.get(f"/api/projects/{p.id}/briefing")
    assert r.status_code == 200
    j = r.json()
    assert list(j) == KEYS and j["since"]["kind"] == "revision"
    assert c.get(f"/api/projects/{p.id}/briefing", params={"today": "2026-05-04"}).json()["as_of"] == "2026-05-04"
    assert c.get("/api/projects/nope/briefing").status_code == 404
    m = mcp_server.programme_briefing(p.id)
    assert m["headline"] == j["headline"] and m["prose"] == j["prose"]
    assert "error" not in m

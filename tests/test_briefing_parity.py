"""Golden-master parity for the briefing: web/briefing.js must match planner/briefing.py.

Every case is a project built in Python (tests/test_briefing.py's scenario builders: progressed
programmes with baselines, closed periods and issued revisions, tight deadlines, out-of-sequence
progress, levelled and complete programmes, the demo house, the generator corpus, an empty project)
plus an optional "today". Both engines produce the briefing from the same JSON; the result must be
identical (key order included, None kept as null; only int/float spelling is normalised) under every
timezone in tests.test_parity.TIMEZONES. Neither engine may mutate its input.

Skipped when node is not installed.
"""
from __future__ import annotations

import copy
import json
import os
import subprocess
from pathlib import Path

import pytest

from planner.briefing import briefing
from planner.model import Project
from tests.test_briefing import (REASONS, ORDER, bare_period, complete_house, demo_house, empty_project, levelled_house,
                                 milestones_only, open_end_and_long, reasons_in, synthesised_baseline, tight_deadline, tracked)
from tests.test_compare_parity import canon
from tests.test_parity import (BRIEFS, NODE, TIMEZONES, _generated, constraints, diff, dst_year, hammocks, links_and_lags, norm,
                               progress)

RUNNER = Path(__file__).parent / "parity" / "briefing_runner.js"

pytestmark = pytest.mark.skipif(NODE is None, reason="node is not installed")


def _j(p: Project) -> dict:
    return p.model_dump(mode="json")


def build_cases() -> list[tuple[str, dict]]:
    oos = progress()
    for a in oos["activities"]:
        if a["id"] == "E":
            a.update({"suspend_date": "2026-03-27T12:00:00", "resume_date": "2026-04-08T08:00:00"})
    cases: list[tuple[str, dict]] = [
        ("demo-house", {"project": _j(demo_house())}),
        ("demo-house-today", {"project": _j(demo_house()), "today": "2026-05-04"}),
        ("corpus-progress", {"project": progress()}),
        ("corpus-progress-suspended", {"project": oos}),
        ("corpus-constraints", {"project": constraints()}),
        ("corpus-links-and-lags", {"project": links_and_lags()}),
        ("corpus-hammocks", {"project": hammocks()}),
        ("corpus-dst-year", {"project": dst_year()}),
        ("tracked-revision-latest", {"project": _j(tracked())}),
        ("tracked-period-latest", {"project": _j(tracked(revision_after_period=False))}),
        ("tracked-baseline-only", {"project": _j(tracked(period=False, revision=False))}),
        ("tracked-no-records", {"project": _j(tracked(baseline=False, period=False, revision=False))}),
        ("tracked-no-deadline", {"project": _j(tracked(2, baseline=False))}),
        ("tracked-stale-progress", {"project": _j(tracked(stale=True, revision=False))}),
        ("tracked-period-closed-today", {"project": _j(tracked(revision=False, second_period=True))}),
        ("tracked-today-given", {"project": _j(tracked()), "today": "2026-04-20"}),
        ("tracked-bare-period", {"project": _j(bare_period())}),
        ("tracked-same-name-revision", {"project": _j(tracked(same_name=True))}),
        ("fresh-house", {"project": _generated(BRIEFS[0])}),
        ("tight-deadline", {"project": _j(tight_deadline())}),
        ("tight-deadline-apartments", {"project": _j(tight_deadline(1))}),
        ("complete", {"project": _j(complete_house())}),
        ("levelled", {"project": _j(levelled_house())}),
        ("synthesised-baseline", {"project": _j(synthesised_baseline())}),
        ("open-end-and-long", {"project": _j(open_end_and_long())}),
        ("milestones-only", {"project": _j(milestones_only())}),
        ("empty", {"project": _j(empty_project())}),
    ]
    for i in (1, 3, 6, 8, 9):
        cases.append((f"generated-{i}", {"project": _generated(BRIEFS[i])}))
    return cases


def run_py(c: dict) -> dict:
    try:
        p = Project.model_validate(copy.deepcopy(c["project"]))
        before = p.model_dump_json()
        result = briefing(p, today=c.get("today"))
        return {"result": json.loads(json.dumps(result)), "mutated": p.model_dump_json() != before}
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
def test_briefing_engines_agree(idx, py_results, js_results):
    tz, js = js_results
    py, jr = py_results[idx], js[idx]
    name = CASES[idx][0]
    assert "error" not in py, f"{name}: Python failed: {py['error']}"
    assert "error" not in jr, f"{name}: JS failed under TZ={tz}: {jr['error']}\n{jr.get('stack', '')}"
    assert not py["mutated"] and not jr["mutated"], f"{name}: briefing mutated its input (py={py['mutated']} js={jr['mutated']})"
    a = json.dumps(canon(py["result"]), ensure_ascii=False)
    b = json.dumps(canon(jr["result"]), ensure_ascii=False)
    if a != b:
        d = diff(norm(py["result"]), norm(jr["result"]))
        k = next((i for i, (x, y) in enumerate(zip(a, b)) if x != y), min(len(a), len(b)))
        pytest.fail(f"{name} under TZ={tz}: result differs at char {k}: py=...{a[max(0, k - 80):k + 80]}... "
                    f"js=...{b[max(0, k - 80):k + 80]}...\n  " + "\n  ".join(d))


def test_cases_exercise_every_kind(py_results):
    """The corpus is only useful if it reaches every status, since-kind, watch reason and action."""
    statuses, kinds, reasons, actions = set(), set(), set(), set()
    for r in py_results:
        b = r["result"]
        statuses.add(b["status"])
        kinds.add(b["since"]["kind"])
        for w in b["watch"]:
            reasons |= reasons_in(w)
        actions |= {a["kind"] for a in b["actions"]}
    assert statuses == {"on_track", "at_risk", "late", "no_deadline", "not_started", "complete"}, statuses
    assert kinds == {"period", "revision", "baseline", "none"}, kinds
    assert reasons == REASONS, REASONS - reasons
    assert actions == set(ORDER), set(ORDER) - actions
    by_name = {n: r["result"] for (n, _), r in zip(CASES, py_results)}
    # a fresh programme is not told about drag; a same-named revision is dated by its period's data date
    for n in ("fresh-house", "demo-house"):
        assert not any("high_drag" in reasons_in(w) for w in by_name[n]["watch"]), n
    s = by_name["tracked-same-name-revision"]["since"]
    assert s["kind"] == "revision" and s["date"] == "2026-03-16T08:00:00" and "(data date 16 Mar 2026)" in s["summary"]

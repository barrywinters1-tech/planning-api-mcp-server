"""Golden-master parity for programme comparison: web/compare.js must match planner/compare.py.

Each case takes an old project, edits an independent copy in each engine with the command
language (planner.commands.parse_command + planner.plan.apply_patch in Python,
E.parseCommand + E.applyPatch in JS), plus a few raw patch ops and calendar edits the
command language cannot express, schedules the new copy, then compares old with new.
The result dict must be identical (key order included, None kept as null; only int/float
spelling is normalised) and the narrative text byte-identical, under every timezone in
tests.test_parity.TIMEZONES. Neither engine may mutate its inputs.

Skipped when node is not installed.
"""
from __future__ import annotations

import copy
import json
import os
import subprocess
from datetime import date, datetime, timedelta
from pathlib import Path

import pytest

from planner.commands import parse_command
from planner.compare import compare, narrative
from planner.cpm import schedule
from planner.model import Project
from planner.plan import Patch, PatchOp, apply_patch
from tests.test_parity import BRIEFS, NODE, TIMEZONES, _generated, constraints, diff, hammocks, links_and_lags, norm, progress

RUNNER = Path(__file__).parent / "parity" / "compare_runner.js"
MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

pytestmark = pytest.mark.skipif(NODE is None, reason="node is not installed")


def _fmt(d: date) -> str:
    return f"{d.day} {MONTHS[d.month - 1]} {d.year}"


def _sequences(start: date) -> dict[str, list]:
    d = lambda k: _fmt(start + timedelta(days=k))  # noqa: E731
    iso = lambda k: (start + timedelta(days=k)).isoformat()  # noqa: E731
    return {
        "durations": ["add 2 weeks to A1100", "shorten A1110 by 2d", "set A1080 to 7.5d"],
        "logic": ["link A1090 -> A1110 SS+2d", "link A1100 -> A1110 FS+3d", "unlink A1110 A1120", "link A1110 -> A1120 SS+1d",
                  "link A1010 -> A1030 FS-1d"],
        "constraints": [f"constrain A1100 start on or after {d(150)}", f"finish by {d(220)}", f"constrain A1080 finish on or before {d(30)}"],
        "progress": [f"started A1010 on {d(0)}", f"complete A1010 on {d(4)}", f"started A1020 on {d(7)}",
                     f"progress A1020 40% as of {d(21)}", f"data date {iso(28)}"],
        "structure": ["rename A1020 Topsoil strip and dig", "delete A1050", 'insert "Scaffold inspection" 1d after A1100 before A1110',
                      'insert "Client walkround" 2d after A1090'],
        "calendars": [{"patch": [{"op": "set_calendar", "activity_id": "A1100", "calendar": "six_day", "reason": "weekend working"}]},
                      {"cal_exception": ["standard", (start + timedelta(days=37)).isoformat(), 0]},
                      {"cal_exception": ["six_day", (start + timedelta(days=40)).isoformat(), 4]}],
        "start": [f"start {d(14)}"],
        "unchanged": [],
        "mixed": ["add 2 weeks to A1100", "link A1090 -> A1110 SS+2d", "link A1100 -> A1110 FS+3d", "unlink A1010 A1020",
                  f"constrain A1110 start on or after {d(120)}", f"started A1010 on {d(0)}", f"progress A1010 60% as of {d(7)}",
                  "rename A1020 Topsoil strip and dig", "delete A1050", 'insert "Scaffold inspection" 1d after A1100 before A1110'],
    }


CORPUS = {
    "progress": (progress, ["progress 'Activity C' 70%", "complete 'Activity D' on 2 Apr 2026", "data date 2026-04-06", "add 3d to 'Activity F'",
                            "unlink 'Activity E' 'Activity G'", "link 'Activity E' -> 'Activity G' FF+1d"]),
    "constraints": (constraints, ["unconstrain 'Activity F'", "constrain 'Activity B' start on or after 21 Apr 2026", "finish by 29 May 2026",
                                  "add 2d to 'Activity G'", "constrain 'Activity H' finish on or before 15 May 2026"]),
    "hammocks": (hammocks, ["add 1 week to 'Activity C'", "link 'Activity B' -> 'Activity D' SS+1d", "delete 'Activity E'", "rename 'Activity Z' Handover"]),
    "links_and_lags": (links_and_lags, ["link 'Activity B' -> 'Activity C' SS+3d", "unlink 'Activity D' 'Activity F'", "link 'Activity D' -> 'Activity F' SS",
                                        "link 'Activity B' -> 'Activity D' SS+1d",
                                        {"patch": [{"op": "set_calendar", "activity_id": "G", "calendar": "six_day", "reason": ""},
                                                   {"op": "remove_link", "predecessor_id": "B", "successor_id": "D", "link_type": "FF", "reason": ""}]},
                                        {"cal_exception": ["ten_hour", "2026-04-08", 5]}]),
}


def build_cases() -> list[tuple[str, dict]]:
    cases: list[tuple[str, dict]] = []
    for i, brief in enumerate(BRIEFS):
        proj = _generated(brief)
        seqs = _sequences(datetime.fromisoformat(proj["start"]).date())
        names = list(seqs) if i in (0, 3, 7) else ["mixed"]
        for j, name in enumerate(names):
            cases.append((f"brief{i}-{name}", {"old": proj, "steps": seqs[name], "schedule_old": (i + j) % 2 == 0}))
    for name, (fn, steps) in CORPUS.items():
        cases.append((f"corpus-{name}", {"old": fn(), "steps": steps, "schedule_old": True}))
        cases.append((f"corpus-{name}-unscheduled-old", {"old": fn(), "steps": steps[:2], "schedule_old": False}))
        cases.append((f"corpus-{name}-unchanged", {"old": fn(), "steps": [], "schedule_old": True}))
    # the finish moves but nothing on the new longest path changed: the narrative falls back to the former path
    cases.append(("former-path-shortened", {"old": links_and_lags(), "steps": ["shorten 'Activity H' by 6d"], "schedule_old": True}))
    open_end = Project.model_validate(links_and_lags())
    apply_patch(open_end, Patch(ops=[PatchOp(op="remove_activity", activity_id="Z")], message=""))
    cases.append(("former-path-removed", {"old": open_end.model_dump(mode="json"), "steps": ["delete 'Activity H'"], "schedule_old": False}))
    return cases


# ----------------------------------------------------------------------------------------
# the Python side (mirrors tests/parity/compare_runner.js)
# ----------------------------------------------------------------------------------------
def _step(p: Project, s) -> None:
    if isinstance(s, str):
        patch = parse_command(p, s)
        real: list[PatchOp] = []
        for op in patch.ops:
            if op.op == "note" and op.reason.startswith("__data_date__"):
                p.data_date = datetime.strptime(op.reason[len("__data_date__"):], "%Y-%m-%d").replace(hour=8)
            else:
                real.append(op)
        apply_patch(p, Patch(ops=real, message=""))
    elif "patch" in s:
        apply_patch(p, Patch(ops=[PatchOp(**op) for op in s["patch"]], message=""))
    elif "cal_exception" in s:
        cid, d, hours = s["cal_exception"]
        p.calendars[cid].exceptions[date.fromisoformat(d)] = float(hours)


def run_py(c: dict) -> dict:
    try:
        old, new = Project.model_validate(copy.deepcopy(c["old"])), Project.model_validate(copy.deepcopy(c["old"]))
        for s in c["steps"]:
            _step(new, s)
        schedule(new)
        if c["schedule_old"]:
            schedule(old)
        before = (old.model_dump_json(), new.model_dump_json())
        result = compare(old, new)
        text = narrative(result)
        return {"result": json.loads(json.dumps(result)), "narrative": text,
                "mutated": (old.model_dump_json(), new.model_dump_json()) != before}
    except Exception as e:  # noqa: BLE001 - the error text itself is compared
        return {"error": str(e)}


def canon(x):
    """Spell numbers the same way in both engines (JSON gives JS's 5 for Python's 5.0); keep everything else,
    including None and key order, so the comparison is as strict as byte-identical JSON allows."""
    if isinstance(x, dict):
        return {k: canon(v) for k, v in x.items()}
    if isinstance(x, list):
        return [canon(v) for v in x]
    if isinstance(x, float) and x.is_integer():
        return int(x)
    return x


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
def test_compare_engines_agree(idx, py_results, js_results):
    tz, js = js_results
    py, jr = py_results[idx], js[idx]
    name = CASES[idx][0]
    assert "error" not in py, f"{name}: Python failed: {py['error']}"
    assert "error" not in jr, f"{name}: JS failed under TZ={tz}: {jr['error']}"
    assert not py["mutated"] and not jr["mutated"], f"{name}: compare mutated its inputs (py={py['mutated']} js={jr['mutated']})"
    a = json.dumps(canon(py["result"]), ensure_ascii=False)
    b = json.dumps(canon(jr["result"]), ensure_ascii=False)
    if a != b:
        d = diff(norm(py["result"]), norm(jr["result"]))
        k = next((i for i, (x, y) in enumerate(zip(a, b)) if x != y), min(len(a), len(b)))
        pytest.fail(f"{name} under TZ={tz}: result differs at char {k}: py=...{a[max(0, k - 80):k + 80]}... "
                    f"js=...{b[max(0, k - 80):k + 80]}...\n  " + "\n  ".join(d))
    assert py["narrative"] == jr["narrative"], f"{name} under TZ={tz}: narrative differs\npy: {py['narrative']}\njs: {jr['narrative']}"


def test_cases_exercise_every_change_kind(py_results):
    """The corpus is only useful if it actually produces each kind of difference somewhere."""
    seen = {k: 0 for k in ("added", "removed", "renamed", "duration_changes", "date_moves", "logic_added", "logic_removed",
                           "logic_changed", "constraint_changes", "progress_changes", "critical_joined", "critical_left")}
    type_changes = lag_changes = cal_defs = cal_moves = drivers = former = unchanged = data_dates = 0
    for r in py_results:
        res = r["result"]
        for k in seen:
            seen[k] += res["summary"]["counts"][k]
        type_changes += sum(1 for x in res["logic_changed"] if x["old_type"] != x["new_type"])
        lag_changes += sum(1 for x in res["logic_changed"] if x["old_type"] == x["new_type"])
        cal_defs += len(res["calendar_changes"]["calendars"])
        cal_moves += len(res["calendar_changes"]["activities"])
        drivers += len(res["finish_drivers"])
        former += len(res["former_path_changes"])
        unchanged += "unchanged between the two versions" in r["narrative"]
        data_dates += res["data_date"]["old"] != res["data_date"]["new"]
    assert all(seen.values()), seen
    assert type_changes and lag_changes and cal_defs and cal_moves and drivers and former and unchanged and data_dates

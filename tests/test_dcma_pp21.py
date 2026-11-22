"""The CIOB Planning Protocol 2021 check set and threshold overrides (planner/dcma.py docstring).

Expected results are worked from the parity corpora by hand: links_and_lags has one lead (D->F, -10h) and two lags
longer than a fifth of their successor (B->C 16h into a 24h task, G->H 20h into a 64h task; B->D 8h into a 40h task
is exactly 20% and passes); constraints has seven constrained activities out of nine and negative float on the finish
against must_finish_by; progress has negative float on C (the overtaken predecessor of E, data-date logic)."""
import json
from pathlib import Path

from planner import Calendar, Project, schedule, health_check
from planner.dcma import CHECK_SETS, DCMA_THRESHOLDS, PP21_THRESHOLDS, check_thresholds
from tests.test_parity import constraints, hammocks, links_and_lags, progress

ROOT = Path(__file__).resolve().parents[1]
PP21_KEYS = ["pp21_duration", "pp21_open_ends", "pp21_negative_float", "pp21_leads", "pp21_lags", "pp21_logic_density",
             "pp21_constraints", "pp21_milestones", "pp21_progress", "pp21_critical_path", "pp21_calendars"]


def report(fn, check_set="pp21", **kw):
    p = Project.model_validate(fn()) if callable(fn) else fn
    schedule(p)
    return p, health_check(p, check_set, **kw)


def by_key(rep):
    return {c.key: c for c in rep.checks}


def test_check_sets_and_defaults():
    assert CHECK_SETS == ("dcma", "pp21")
    assert PP21_THRESHOLDS == {"max_duration_days": 44, "duration_pct": 0, "open_ends_pct": 0, "lag_pct": 20, "density_min": 1,
                               "density_max": 4, "constraints_pct": 5, "max_working_days": 7}
    assert set(DCMA_THRESHOLDS) == {"logic_pct", "leads_pct", "lags_pct", "fs_pct", "hard_constraints_pct", "high_float_days",
                                    "high_float_pct", "high_duration_days", "high_duration_pct", "missed_pct", "cpli_min", "bei_min"}
    _, rep = report(links_and_lags)
    assert [c.key for c in rep.checks] == PP21_KEYS
    assert rep.check_set == "pp21" and rep.thresholds == PP21_THRESHOLDS
    _, dcma = report(links_and_lags, "dcma")
    assert dcma.check_set == "dcma" and dcma.thresholds == DCMA_THRESHOLDS and dcma.checks[0].key == "logic"
    # an unknown set is the DCMA set
    assert report(links_and_lags, "pmi")[1].check_set == "dcma"


def test_pp21_links_and_lags_corpus():
    _, rep = report(links_and_lags)
    k = by_key(rep)
    assert {c.key: c.passed for c in rep.checks} == {**{x: True for x in PP21_KEYS}, "pp21_leads": False, "pp21_lags": False}
    assert k["pp21_leads"].items == ["D->F"] and k["pp21_leads"].value == 1.0
    assert k["pp21_lags"].items == ["B->C", "G->H"] and k["pp21_lags"].value == 20.0     # 2 of 10 links
    assert k["pp21_lags"].threshold == "lag ≤ 20% of successor duration"
    assert k["pp21_logic_density"].value == 1.11 and k["pp21_logic_density"].detail == "10 relationships over 9 activities: 1.11 per activity."
    assert k["pp21_critical_path"].items == ["H", "Z"] and k["pp21_critical_path"].value == 4.0
    assert k["pp21_duration"].threshold == "≤ 44 working days (0% may exceed)"
    assert k["pp21_calendars"].threshold == "1 to 7 working days, 0 to 24 hours"
    assert all(c.applicable for c in rep.checks)
    assert rep.score == 82 and rep.summary == "Failing: Leads (negative lag), Lag length."
    assert [c.key for c in rep.failing()] == ["pp21_leads", "pp21_lags"]


def test_pp21_constraints_and_progress_corpora():
    _, rep = report(constraints)
    k = by_key(rep)
    assert rep.score == 82
    assert [c.key for c in rep.failing()] == ["pp21_negative_float", "pp21_constraints"]
    assert k["pp21_negative_float"].items == ["Z"]
    assert k["pp21_constraints"].items == list("BCDEFGH") and k["pp21_constraints"].value == 77.8
    assert k["pp21_constraints"].threshold == "≤ 5%"
    _, rep = report(progress)
    assert rep.score == 91 and [c.key for c in rep.failing()] == ["pp21_negative_float"]
    assert by_key(rep)["pp21_negative_float"].items == ["C"]
    assert by_key(rep)["pp21_progress"].passed and by_key(rep)["pp21_logic_density"].value == 1.0
    _, rep = report(hammocks)
    assert rep.score == 100 and rep.summary == "Schedule passes all applicable checks."


def test_pp21_generated_and_demo_programmes():
    demo = Project.model_validate(json.loads((ROOT / "examples" / "demo_house.json").read_text()))
    _, rep = report(demo)
    assert rep.check_set == "pp21" and 0 <= rep.score <= 100 and len(rep.checks) == 11
    assert by_key(rep)["pp21_critical_path"].passed


def test_thresholds_override_order():
    """Argument over Project.check_thresholds over the set's defaults; unknown keys are ignored; the report says what applied."""
    p = Project.model_validate(links_and_lags())
    schedule(p)
    rep = health_check(p, "pp21", {"lag_pct": 50})
    assert by_key(rep)["pp21_lags"].items == ["B->C"] and rep.thresholds["lag_pct"] == 50
    assert by_key(rep)["pp21_lags"].threshold == "lag ≤ 50% of successor duration"
    p.check_thresholds = {"lag_pct": 100, "bogus": 1, "leads_pct": 50}
    rep = health_check(p, "pp21")
    assert by_key(rep)["pp21_lags"].passed and rep.thresholds["lag_pct"] == 100 and "bogus" not in rep.thresholds
    assert rep.score == 91 and [c.key for c in rep.failing()] == ["pp21_leads"]
    rep = health_check(p, "pp21", {"lag_pct": 20})
    assert by_key(rep)["pp21_lags"].items == ["B->C", "G->H"]
    assert check_thresholds(p, "pp21", {"lag_pct": 20, "density_max": 2.5}) == {**PP21_THRESHOLDS, "lag_pct": 20, "density_max": 2.5}
    # the DCMA set takes the same route: leads_pct 50 lets the single lead through, high_duration_days 7 flags the 8-day task
    rep = health_check(p, "dcma", {"high_duration_days": 7})
    assert by_key(rep)["leads"].passed and by_key(rep)["leads"].threshold == "≤ 50%"
    assert by_key(rep)["high_duration"].items == ["H"] and by_key(rep)["high_duration"].threshold == "≤ 5%"
    assert by_key(rep)["high_duration"].detail == "1 incomplete activities are longer than 7 working days."
    assert not by_key(rep)["high_duration"].passed
    p.check_thresholds = None
    rep = health_check(p)
    assert not by_key(rep)["leads"].passed and by_key(rep)["leads"].threshold == "0%"
    assert by_key(rep)["high_float"].detail.endswith("more than 44 days total float.")


def test_pp21_duration_and_calendar_checks():
    p = Project.model_validate(links_and_lags())
    p.activity("H").duration_hours = 8 * 45                       # 45 working days
    p.calendars["odd"] = Calendar(id="odd", hours_per_day=0)
    p.calendars["dup"] = Calendar(id="dup", working_days=[0, 0, 1, 2, 3, 4, 5, 6])
    _, rep = report(p)
    k = by_key(rep)
    assert k["pp21_duration"].items == ["H"] and not k["pp21_duration"].passed and k["pp21_duration"].value == 11.1
    assert k["pp21_calendars"].items == ["dup", "odd"] and not k["pp21_calendars"].passed
    rep = health_check(p, "pp21", {"max_duration_days": 45, "duration_pct": 20})
    assert by_key(rep)["pp21_duration"].passed and by_key(rep)["pp21_duration"].threshold == "≤ 45 working days (20% may exceed)"
    rep = health_check(p, "pp21", {"max_working_days": 6})
    assert by_key(rep)["pp21_calendars"].items == ["dup", "odd"]       # seven-day calendars are not in this corpus; dup/odd still fail
    p.calendars["seven"] = Calendar(id="seven", working_days=[0, 1, 2, 3, 4, 5, 6])
    assert by_key(health_check(p, "pp21", {"max_working_days": 6}))["pp21_calendars"].items == ["dup", "odd", "seven"]


def test_pp21_milestones_progress_and_density():
    p = Project.model_validate(links_and_lags())
    p.relationships = [r for r in p.relationships if not (r.predecessor_id == "A" and r.successor_id == "B")]
    _, rep = report(p)
    k = by_key(rep)
    assert k["pp21_open_ends"].items == ["B"] and not k["pp21_open_ends"].passed            # B lost its predecessor
    assert k["pp21_milestones"].passed                                                        # A still drives G
    p.relationships = [r for r in p.relationships if r.predecessor_id != "A"]
    _, rep = report(p)
    assert by_key(rep)["pp21_milestones"].items == ["A"] and not by_key(rep)["pp21_milestones"].passed
    # a sparse network fails the density floor, a saturated one the ceiling
    p = Project.model_validate(hammocks())
    p.relationships = p.relationships[:3]
    assert not by_key(report(p)[1])["pp21_logic_density"].passed
    assert by_key(report(p, thresholds={"density_min": 0.5})[1])["pp21_logic_density"].passed
    # progress: an actual date after the data date, remaining work before it
    p = Project.model_validate(progress())
    p.activity("F").status = "in_progress"
    p.activity("F").actual_start = None
    p.activity("B").actual_finish = p.data_date.replace(day=31)
    _, rep = report(p)
    assert by_key(rep)["pp21_progress"].items == ["B", "F"] and not by_key(rep)["pp21_progress"].passed

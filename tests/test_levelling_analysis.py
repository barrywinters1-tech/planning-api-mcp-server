from datetime import date, datetime

from planner import schedule, health_check, Status
from planner.analysis import cost_curve, histogram, variance
from planner.generator import Brief, generate
from planner.levelling import clear_baseline, level, set_baseline, unlevel, use_baseline
from planner.plan import draft_to_project, run_schedule
from planner.xer import read_xer, write_xer
from planner import history, store


def block():
    p = draft_to_project(generate(Brief(name="Block", building_type="apartments", storeys=3, units=24, foundations="piled", start_date=date(2026, 4, 6))))
    run_schedule(p)
    return p


def test_levelling_removes_overallocation_and_is_reversible():
    p = block()
    f0 = p.finish
    before = histogram(p)
    assert any(r["overallocated_days"] for r in before["resources"])
    level(p)
    assert p.levelled and p.finish >= f0
    assert all(r["overallocated_days"] == 0 for r in histogram(p)["resources"])
    assert any(a.level_delay_hours > 0 for a in p.activities)
    # logic still respected after levelling
    amap = p.activity_map()
    for r in p.relationships:
        a, b = amap[r.predecessor_id], amap[r.successor_id]
        if r.type.value == "FS":
            assert b.early_start >= a.early_finish, (r.predecessor_id, r.successor_id)
    unlevel(p)
    assert not p.levelled and p.finish == f0


def test_baseline_variance_and_cost():
    p = block()
    set_baseline(p, "Tender")
    assert p.baselines[0].name == "Tender" and all(a.baseline_finish for a in p.activities)
    task = next(a for a in p.activities if a.critical and a.duration_hours > 0)
    task.duration_hours += 80
    run_schedule(p)
    v = {x["id"]: x for x in variance(p)}
    assert v[p.activities[-1].id]["finish_variance_days"] >= 10
    cc = cost_curve(p)
    assert cc["metrics"]["budget"] > 0 and cc["has_baseline"] and len(cc["weeks"]) > 40
    assert cc["weeks"][-1]["planned"] == cc["metrics"]["budget"]
    # progress -> earned value
    first = p.activities[1]
    first.status, first.actual_start, first.percent_complete, first.remaining_hours = Status.IN_PROGRESS, p.start, 50, first.duration_hours / 2
    p.data_date = datetime(2026, 4, 13, 8)
    run_schedule(p)
    m = cost_curve(p)["metrics"]
    assert m["bcwp"] > 0 and m["bcws"] > 0 and m["spi"] is not None
    clear_baseline(p)
    assert not any(a.baseline_finish for a in p.activities)
    assert use_baseline(p, "Tender") and all(a.baseline_finish for a in p.activities)
    assert not use_baseline(p, "Nope")


def test_codes_roundtrip_xer():
    p = block()
    assert p.activities[3].codes.get("Trade") and p.code_types["Trade"]
    q = read_xer(write_xer(p))
    assert q.activities[3].codes == p.activities[3].codes
    assert set(q.code_types) == set(p.code_types)
    trade_val = p.activities[3].codes["Trade"]
    assert q.code_types["Trade"][trade_val] == p.code_types["Trade"][trade_val]


def test_undo_redo(tmp_path, monkeypatch):
    monkeypatch.setattr(store, "DATA_DIR", tmp_path)
    p = block()
    store.save(p)
    history.snapshot(p.id)
    p.activities[1].name = "Changed"
    store.save(p)
    assert history.depth(p.id) == {"undo": 1, "redo": 0}
    back = history.undo(p.id)
    assert back.activities[1].name != "Changed" and history.depth(p.id) == {"undo": 0, "redo": 1}
    fwd = history.redo(p.id)
    assert fwd.activities[1].name == "Changed"
    assert history.undo(p.id) is not None and history.undo(p.id) is None
    assert store.list_projects()[0]["id"] == p.id
    store.delete(p.id)
    assert not list(tmp_path.glob("*"))

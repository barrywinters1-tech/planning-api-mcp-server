"""Deterministic half of the AI planner: draft -> project and patches. No API calls."""
from datetime import datetime

from planner import schedule, health_check, Constraint, Status
from planner.ai_planner import (DraftPlan, PlanActivity, PlanLink, PlanWBS, PlanConstraint, Patch, PatchOp,
                                draft_to_project, apply_patch, schedule_digest)


def draft() -> DraftPlan:
    return DraftPlan(
        project_id="HOUSE", project_name="Two-storey house", start_date="2026-03-02", must_finish_by="2026-09-30",
        wbs=[PlanWBS(code="1", name="Enabling"), PlanWBS(code="2", name="Substructure"), PlanWBS(code="3", name="Superstructure")],
        activities=[
            PlanActivity(id="A1000", name="Start on site", wbs_code="1", type="start_milestone", duration_days=0),
            PlanActivity(id="A1010", name="Set up site", wbs_code="1", duration_days=5, predecessors=[PlanLink(predecessor_id="A1000")], trade="Groundworks gang", crew_size=3),
            PlanActivity(id="A1020", name="Strip foundations", wbs_code="2", duration_days=10, predecessors=[PlanLink(predecessor_id="A1010")], trade="Groundworks gang"),
            PlanActivity(id="A1030", name="Cure concrete", wbs_code="2", duration_days=7, calendar="seven_day", predecessors=[PlanLink(predecessor_id="A1020")]),
            PlanActivity(id="A1040", name="Blockwork to DPC", wbs_code="2", duration_days=5, predecessors=[PlanLink(predecessor_id="A1030")], trade="Bricklayers"),
            PlanActivity(id="A1050", name="Frame", wbs_code="3", duration_days=15, predecessors=[PlanLink(predecessor_id="A1040")], trade="Bricklayers"),
            PlanActivity(id="A1060", name="Practical completion", wbs_code="3", type="finish_milestone", duration_days=0, predecessors=[PlanLink(predecessor_id="A1050")]),
        ],
        constraints=[PlanConstraint(activity_id="A1020", type="start_on_or_after", date="2026-03-16", reason="Planning condition discharge")],
        assumptions=["Ground is suitable for strip foundations"], questions_for_client=["Is the site secured?"], summary="Simple house.")


def test_draft_to_project_and_schedule():
    p = draft_to_project(draft(), "a house")
    assert p.start == datetime(2026, 3, 2, 8)
    assert p.must_finish_by == datetime(2026, 9, 30, 16)
    assert len(p.activities) == 7 and len(p.relationships) == 6
    assert p.activity("A1030").calendar_id == "seven_day" and p.activity("A1030").duration_hours == 56
    assert p.activity("A1020").constraint == Constraint.START_ON_OR_AFTER
    assert {r.id for r in p.resources} == {"GROUNDWORKS_GANG", "BRICKLAYERS"}
    rep = health_check(schedule(p))
    assert p.activity("A1020").early_start == datetime(2026, 3, 16, 8)
    assert p.finish == datetime(2026, 5, 5, 16)
    assert p.activity("A1060").total_float_hours > 0  # must-finish-by 30 Sept leaves float, as P6 would show
    assert all(a.total_float_hours >= p.activity("A1060").total_float_hours for a in p.activities)
    assert p.activity("A1060").critical and p.activity("A1050").critical  # longest path is flagged
    byk = {c.key: c for c in rep.checks}
    assert byk["logic"].passed and byk["open_ends"].passed and byk["cp_test"].passed
    # seven-day curing starts on the Saturday straight after excavation and runs 7 calendar days
    a = p.activity("A1030")
    assert a.early_start == datetime(2026, 3, 28, 8) and a.early_finish == datetime(2026, 4, 3, 16)
    # blockwork is on the standard calendar: Good Friday and Easter Monday are bank holidays
    assert p.activity("A1040").early_start == datetime(2026, 4, 7, 8)
    assert "A1030" in schedule_digest(p, rep)


def test_patch_ops():
    p = draft_to_project(draft())
    schedule(p)
    finish_before = p.finish
    patch = Patch(message="ok", ops=[
        PatchOp(op="set_duration", activity_id="A1050", duration_days=25, reason="client asked"),
        PatchOp(op="add_activity", activity_id="A1045", name="Scaffold", duration_days=3, wbs_code="3",
                predecessor_id="A1040", successor_id="A1050", trade="Scaffolders"),
        PatchOp(op="remove_link", predecessor_id="A1040", successor_id="A1050"),
        PatchOp(op="set_constraint", activity_id="A1060", constraint_type="finish_on_or_before", date="2026-05-01"),
        PatchOp(op="set_progress", activity_id="A1010", actual_start="2026-03-02", percent_complete=40),
        PatchOp(op="rename", activity_id="A1020", name="Excavate strip foundations"),
        PatchOp(op="set_duration", activity_id="NOPE", duration_days=1),
    ])
    log = apply_patch(p, patch)
    assert any(l.startswith("skipped") for l in log)
    schedule(p)
    assert p.finish > finish_before
    assert p.activity("A1045").name == "Scaffold"
    assert {(r.predecessor_id, r.successor_id) for r in p.relationships} >= {("A1040", "A1045"), ("A1045", "A1050")}
    assert ("A1040", "A1050") not in {(r.predecessor_id, r.successor_id) for r in p.relationships}
    assert p.activity("A1010").status == Status.IN_PROGRESS and p.activity("A1010").remaining_hours == 24
    assert p.activity("A1060").total_float_hours < 0  # finish-on-or-before 1 May is not achievable
    assert p.activity("A1020").name == "Excavate strip foundations"
    rm = Patch(message="", ops=[PatchOp(op="remove_activity", activity_id="A1045")])
    apply_patch(p, rm)
    assert ("A1040", "A1050") in {(r.predecessor_id, r.successor_id) for r in p.relationships}

"""plan_from_description / edit_with_instruction with the model call mocked out."""
from datetime import date

from planner import ai_planner as ap
from planner.ai_planner import DraftPlan, Patch, PatchOp, PlanActivity, PlanLink, PlanWBS
from tests.test_ai_apply import draft as good_draft


def bad_draft() -> DraftPlan:
    """Open-ended and looped, the way a careless first draft can be."""
    return DraftPlan(
        project_id="BAD", project_name="Bad draft", start_date="2026-03-02",
        wbs=[PlanWBS(code="1", name="Works")],
        activities=[
            PlanActivity(id="A1000", name="Start", wbs_code="1", type="start_milestone", duration_days=0),
            PlanActivity(id="A1010", name="Dig", wbs_code="1", duration_days=5, predecessors=[PlanLink(predecessor_id="A1000")]),
            PlanActivity(id="A1020", name="Pour", wbs_code="1", duration_days=5, predecessors=[PlanLink(predecessor_id="A1010"), PlanLink(predecessor_id="A1030")]),
            PlanActivity(id="A1030", name="Cure", wbs_code="1", duration_days=3, predecessors=[PlanLink(predecessor_id="A1020")]),
            PlanActivity(id="A1040", name="Orphan", wbs_code="1", duration_days=2),
            PlanActivity(id="A1050", name="Finish", wbs_code="1", type="finish_milestone", duration_days=0, predecessors=[PlanLink(predecessor_id="A1030")]),
        ],
        assumptions=[], questions_for_client=[], summary="")


def test_plan_fixes_loop_then_reviews(monkeypatch):
    calls = []

    def fake(system, user, output_format, **kw):
        calls.append(output_format.__name__)
        if output_format is DraftPlan:
            return bad_draft()
        if "logic loop" in user:
            return Patch(message="removed the back link", ops=[PatchOp(op="remove_link", predecessor_id="A1030", successor_id="A1020")])
        return Patch(message="closed open ends", ops=[
            PatchOp(op="add_link", predecessor_id="A1010", successor_id="A1040"),
            PatchOp(op="add_link", predecessor_id="A1040", successor_id="A1050"),
        ], still_open=[])

    monkeypatch.setattr(ap, "_structured", fake)
    res = ap.plan_from_description("Build a small thing on a site somewhere in Yorkshire.", today=date(2026, 2, 1))
    assert calls == ["DraftPlan", "Patch", "Patch"]
    assert res.project.finish is not None
    byk = {c.key: c for c in res.report.checks}
    assert byk["logic"].passed and byk["open_ends"].passed
    assert any("schedule error" in l for l in res.log)


def test_plan_reverts_review_that_introduces_loop(monkeypatch):
    def fake(system, user, output_format, **kw):
        if output_format is DraftPlan:
            d = good_draft()
            d.activities[1].predecessors = []  # A1010 loses its predecessor -> logic check fails -> review runs
            return d
        return Patch(message="oops", ops=[PatchOp(op="add_link", predecessor_id="A1060", successor_id="A1010")])

    monkeypatch.setattr(ap, "_structured", fake)
    res = ap.plan_from_description("A house in Harrogate with two storeys and a garage.")
    assert any("reverting review" in l for l in res.log)
    assert res.project.finish is not None


def test_edit_with_instruction(monkeypatch):
    p = ap.draft_to_project(good_draft())
    ap.run_schedule(p)
    before = p.finish
    monkeypatch.setattr(ap, "_structured", lambda s, u, f, **kw: Patch(
        message="Frame now 25 days.", ops=[PatchOp(op="set_duration", activity_id="A1050", duration_days=25)]))
    patch, log, report = ap.edit_with_instruction(p, "add ten days to the frame")
    assert patch.message.startswith("Frame")
    assert p.activity("A1050").duration_hours == 200
    assert p.finish > before and report.score >= 0

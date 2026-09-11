"""Build a realistic ~40-activity two-storey house programme without calling the AI.

    python examples/demo.py            # writes examples/demo_house.json, .xer and .xml
    python examples/demo.py --serve    # also saves it into the app's project store
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from planner import schedule, health_check
from planner.ai_planner import DraftPlan, PlanActivity as A, PlanLink as L, PlanWBS as W, PlanConstraint, draft_to_project
from planner.xer import write_xer_file
from planner.mspxml import write_mspdi_file


def fs(*ids, **kw):
    return [L(predecessor_id=i, **kw) for i in ids]


def build() -> DraftPlan:
    acts = [
        A(id="A1000", name="Start on site", wbs_code="1", type="start_milestone", duration_days=0),
        A(id="A1010", name="Site set-up, welfare and hoarding", wbs_code="1", duration_days=5, predecessors=fs("A1000"), trade="Groundworks gang", crew_size=3),
        A(id="A1020", name="Service diversions and temporary supplies", wbs_code="1", duration_days=10, predecessors=fs("A1000"), trade="Utilities contractor"),
        A(id="A1030", name="Strip topsoil and reduce levels", wbs_code="1", duration_days=4, predecessors=fs("A1010"), trade="Groundworks gang", crew_size=3),
        A(id="A1100", name="Set out and excavate strip foundations", wbs_code="2", duration_days=6, predecessors=fs("A1030"), trade="Groundworks gang", crew_size=4),
        A(id="A1110", name="Building control inspection - foundations", wbs_code="2", duration_days=1, predecessors=fs("A1100"), trade="Site manager"),
        A(id="A1120", name="Pour foundation concrete", wbs_code="2", duration_days=2, predecessors=fs("A1110"), trade="Groundworks gang", crew_size=4),
        A(id="A1130", name="Concrete cure", wbs_code="2", duration_days=3, calendar="seven_day", predecessors=fs("A1120")),
        A(id="A1140", name="Blockwork to DPC", wbs_code="2", duration_days=6, predecessors=fs("A1130"), trade="Bricklayers", crew_size=4),
        A(id="A1150", name="Below-ground drainage", wbs_code="2", duration_days=8, predecessors=fs("A1030") + [L(predecessor_id="A1020")], trade="Groundworks gang", crew_size=3),
        A(id="A1160", name="Oversite, DPM, insulation and ground floor slab", wbs_code="2", duration_days=5, predecessors=fs("A1140", "A1150"), trade="Groundworks gang", crew_size=4),
        A(id="A1170", name="Substructure complete", wbs_code="2", type="finish_milestone", duration_days=0, predecessors=fs("A1160")),
        A(id="A1200", name="Scaffold lift 1", wbs_code="3", duration_days=2, predecessors=fs("A1170"), trade="Scaffolders"),
        A(id="A1210", name="Brick and block to first floor", wbs_code="3", duration_days=15, predecessors=fs("A1200"), trade="Bricklayers", crew_size=6),
        A(id="A1220", name="First floor joists and decking", wbs_code="3", duration_days=4, predecessors=fs("A1210"), trade="Carpenters", crew_size=3),
        A(id="A1230", name="Scaffold lift 2", wbs_code="3", duration_days=2, predecessors=fs("A1220"), trade="Scaffolders"),
        A(id="A1240", name="Brick and block to wall plate", wbs_code="3", duration_days=15, predecessors=fs("A1230"), trade="Bricklayers", crew_size=6),
        A(id="A1250", name="Roof trusses and bracing", wbs_code="3", duration_days=5, predecessors=fs("A1240"), trade="Carpenters", crew_size=3),
        A(id="A1260", name="Felt, batten and tile roof", wbs_code="3", duration_days=8, predecessors=fs("A1250"), trade="Roofers", crew_size=3),
        A(id="A1270", name="Fascias, soffits and rainwater goods", wbs_code="3", duration_days=4, predecessors=fs("A1260"), trade="Roofers"),
        A(id="A1280", name="Windows and external doors", wbs_code="3", duration_days=4, predecessors=fs("A1240"), trade="Window fitters"),
        A(id="A1290", name="Watertight", wbs_code="3", type="finish_milestone", duration_days=0, predecessors=fs("A1260", "A1280")),
        A(id="A1300", name="Strike scaffold", wbs_code="3", duration_days=2, predecessors=fs("A1270", "A1280"), trade="Scaffolders"),
        A(id="A1400", name="First fix carpentry (studwork, door linings)", wbs_code="4", duration_days=8, predecessors=fs("A1290"), trade="Carpenters", crew_size=3),
        A(id="A1410", name="First fix electrics", wbs_code="4", duration_days=6, predecessors=[L(predecessor_id="A1400", type="SS", lag_days=3)], trade="Electricians", crew_size=2),
        A(id="A1420", name="First fix plumbing and heating", wbs_code="4", duration_days=6, predecessors=[L(predecessor_id="A1400", type="SS", lag_days=3)], trade="Plumbers", crew_size=2),
        A(id="A1430", name="Insulation and vapour control", wbs_code="4", duration_days=4, predecessors=fs("A1400", "A1410", "A1420"), trade="Dryliners"),
        A(id="A1440", name="Plasterboard and skim", wbs_code="4", duration_days=12, predecessors=fs("A1430"), trade="Plasterers", crew_size=4),
        A(id="A1450", name="Drying out", wbs_code="4", duration_days=7, calendar="seven_day", predecessors=fs("A1440")),
        A(id="A1460", name="Screed ground floor", wbs_code="4", duration_days=2, predecessors=fs("A1440"), trade="Screeders"),
        A(id="A1470", name="Second fix carpentry (doors, skirting, stairs)", wbs_code="4", duration_days=8, predecessors=fs("A1450", "A1460"), trade="Carpenters", crew_size=3),
        A(id="A1480", name="Second fix electrics", wbs_code="4", duration_days=5, predecessors=[L(predecessor_id="A1470", type="SS", lag_days=2)], trade="Electricians", crew_size=2),
        A(id="A1490", name="Second fix plumbing, sanitaryware and boiler", wbs_code="4", duration_days=6, predecessors=[L(predecessor_id="A1470", type="SS", lag_days=2)], trade="Plumbers", crew_size=2),
        A(id="A1500", name="Kitchen installation", wbs_code="4", duration_days=5, predecessors=fs("A1470") + [L(predecessor_id="A1490", type="FF")], trade="Kitchen fitters"),
        A(id="A1510", name="Tiling", wbs_code="4", duration_days=5, predecessors=fs("A1490", "A1500"), trade="Tilers"),
        A(id="A1520", name="Decoration", wbs_code="4", duration_days=8, predecessors=fs("A1480", "A1510"), trade="Decorators", crew_size=3),
        A(id="A1530", name="Floor finishes", wbs_code="4", duration_days=3, predecessors=fs("A1520"), trade="Floor layers"),
        A(id="A1600", name="External drainage connections and paths", wbs_code="5", duration_days=6, predecessors=fs("A1300"), trade="Groundworks gang", crew_size=3),
        A(id="A1610", name="Driveway, fencing and landscaping", wbs_code="5", duration_days=8, predecessors=fs("A1600"), trade="Groundworks gang", crew_size=3),
        A(id="A1700", name="Test and commission services", wbs_code="6", duration_days=3, predecessors=fs("A1480", "A1490"), trade="Electricians"),
        A(id="A1710", name="Building control final inspection and EPC", wbs_code="6", duration_days=1, predecessors=fs("A1530", "A1700", "A1610"), trade="Site manager"),
        A(id="A1720", name="Snagging and clean", wbs_code="6", duration_days=5, predecessors=fs("A1710"), trade="Site manager"),
        A(id="A1730", name="Practical completion", wbs_code="6", type="finish_milestone", duration_days=0, predecessors=fs("A1720")),
    ]
    return DraftPlan(
        project_id="HOUSE-01", project_name="Two-storey detached house, Harrogate", start_date="2026-03-02", must_finish_by="2026-10-30",
        wbs=[W(code="1", name="Enabling works"), W(code="2", name="Substructure"), W(code="3", name="Superstructure and envelope"),
             W(code="4", name="Internal fit-out"), W(code="5", name="External works"), W(code="6", name="Commissioning and handover")],
        activities=acts,
        constraints=[PlanConstraint(activity_id="A1100", type="start_on_or_after", date="2026-03-16", reason="Planning condition 4 (construction management plan) discharged 13 March")],
        assumptions=["Traditional masonry construction, strip foundations on good ground", "Single bricklaying gang of six",
                     "Bank holidays taken from the UK 2026 list", "Client supplies kitchen on 10 days' notice"],
        questions_for_client=["Is the 11kV diversion confirmed with the DNO?", "Do you want a fixed handover date written into the contract?"],
        summary="A 34-week programme for a traditional two-storey house. Critical path runs through the masonry, roof, plastering and drying-out.")


if __name__ == "__main__":
    project = draft_to_project(build(), "Two-storey detached house in Harrogate, traditional masonry construction.")
    schedule(project)
    report = health_check(project)
    out = Path(__file__).parent
    (out / "demo_house.json").write_text(project.model_dump_json(indent=1))
    write_xer_file(project, str(out / "demo_house.xer"))
    write_mspdi_file(project, str(out / "demo_house.xml"))
    print(f"{project.name}: {len(project.activities)} activities, finish {project.finish:%d %b %Y}, health {report.score}/100")
    for c in report.failing():
        print(f"  FAIL {c.title}: {c.detail}")
    if "--serve" in sys.argv:
        from planner import store
        store.save(project)
        print("saved to project store")

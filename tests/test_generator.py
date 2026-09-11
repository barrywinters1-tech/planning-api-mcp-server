from datetime import date

from planner.generator import Brief, generate, parse_brief
from planner.plan import draft_to_project, run_schedule


BRIEF = ("New-build 24-unit three-storey apartment block in Leeds, RC frame on CFA piles, brick and render envelope, "
         "gas-free with ASHPs. Start on site 6 April 2026, client wants handover before Christmas 2027. "
         "Site is a cleared brownfield plot with a live 11kV cable to divert.")


def test_parse_brief_extracts_the_facts():
    b = parse_brief(BRIEF)
    assert b.building_type == "apartments" and b.storeys == 3 and b.units == 24
    assert b.frame == "rc" and b.foundations == "piled" and b.envelope == "brick"
    assert b.start_date == date(2026, 4, 6) and b.deadline == date(2027, 12, 18)
    assert b.service_diversion and b.contaminated_ground and b.location == "Leeds"
    assert b.name.startswith("New-build 24-unit")


def test_parse_brief_other_phrasings():
    b = parse_brief("Two storey detached house, 180 sqm, traditional masonry with a pitched tiled roof. Possession 4/5/2026, complete by end of 2026. Planning conditions discharged 20 April 2026.")
    assert b.building_type == "house" and b.storeys == 2 and b.gross_internal_area_m2 == 180
    assert b.frame == "masonry" and b.roof == "pitched"
    assert b.start_date == date(2026, 5, 4) and b.deadline == date(2026, 12, 15)
    assert b.planning_condition_date == date(2026, 4, 20)
    w = parse_brief("Steel portal frame warehouse 5,000 m2 with composite cladding, single storey, saturday working")
    assert w.building_type == "warehouse" and w.frame == "steel" and w.envelope == "cladding" and w.storeys == 1 and w.six_day_week


def test_generate_is_closed_logic_and_schedulable():
    d = generate(parse_brief(BRIEF))
    p = draft_to_project(d)
    r = run_schedule(p)
    byk = {c.key: c for c in r.checks}
    assert 50 <= len(p.activities) <= 120
    assert byk["logic"].passed and byk["open_ends"].passed and byk["leads"].passed
    assert byk["negative_float"].passed and byk["cp_test"].passed and byk["dangling"].passed
    assert byk["rel_types"].passed and byk["lags"].passed
    assert p.must_finish_by is not None and p.finish < p.must_finish_by
    assert p.activity("A1000").type.value == "start_milestone"
    names = [a.name for a in p.activities]
    assert any("Piling" in n for n in names) and any("Service diversions" in n for n in names) and any("remediation" in n.lower() for n in names)
    assert names[-1] == "Practical completion"


def test_generate_variants_all_schedule():
    for b in [Brief(name="House", building_type="house", storeys=2, start_date=date(2026, 3, 2)),
              Brief(name="Shed", building_type="warehouse", storeys=1, gross_internal_area_m2=4000, start_date=date(2026, 3, 2)),
              Brief(name="Office", building_type="office", storeys=6, gross_internal_area_m2=6000, frame="steel", envelope="curtain_wall", basement=True, start_date=date(2026, 3, 2)),
              Brief(name="Shell", building_type="office", storeys=3, fit_out="shell", external_works=False, start_date=date(2026, 3, 2)),
              Brief(name="Timber", building_type="houses", units=12, frame="timber", demolition=True, start_date=date(2026, 3, 2)),
              Brief(name="Six", building_type="school", storeys=2, six_day_week=True, start_date=date(2026, 3, 2))]:
        p = draft_to_project(generate(b))
        r = run_schedule(p)
        byk = {c.key: c for c in r.checks}
        assert byk["logic"].passed and byk["open_ends"].passed and byk["cp_test"].passed, b.name
        assert p.finish > p.start


def test_bigger_building_takes_longer():
    small = draft_to_project(generate(Brief(building_type="office", storeys=2, gross_internal_area_m2=1000, start_date=date(2026, 3, 2))))
    big = draft_to_project(generate(Brief(building_type="office", storeys=6, gross_internal_area_m2=9000, start_date=date(2026, 3, 2))))
    run_schedule(small); run_schedule(big)
    assert big.finish > small.finish
    assert len(big.activities) > len(small.activities)

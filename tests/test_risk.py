from datetime import date

from fastapi.testclient import TestClient

from planner.generator import Brief, generate
from planner.plan import draft_to_project, run_schedule
from planner.risk import mulberry32, risk_analysis, triangular, weather_exposed


def house():
    p = draft_to_project(generate(Brief(name="House", building_type="house", storeys=2, start_date=date(2026, 4, 6))))
    run_schedule(p)
    return p


def test_rng_matches_reference_mulberry32():
    r = mulberry32(1)
    assert [r() for _ in range(3)] == [0.6270739405881613, 0.002735721180215478, 0.5274470399599522]


def test_triangular_bounds_and_mode():
    assert triangular(0, .9, 1, 1.3) == .9 and triangular(1, .9, 1, 1.3) == 1.3
    assert abs(triangular(.25, .9, 1, 1.3) - 1) < 1e-12        # c = (1-.9)/(1.3-.9) = .25 lands on the mode
    assert triangular(.5, 1, 1, 1) == 1


def test_weather_classification():
    assert weather_exposed("Felt, batten and tile roof", "standard")
    assert weather_exposed("Below-ground drainage", None)
    assert not weather_exposed("Concrete cure", "seven_day") and not weather_exposed("Second fix electrics", "standard")


def test_risk_is_reproducible_ordered_and_leaves_project_alone():
    p = house(); f0 = p.finish; d0 = [a.duration_hours for a in p.activities]
    p.must_finish_by = p.finish
    r = risk_analysis(p, 120, seed=5)
    assert p.finish == f0 and [a.duration_hours for a in p.activities] == d0
    assert r == risk_analysis(p, 120, seed=5) and r != risk_analysis(p, 120, seed=6)
    assert r["earliest"] <= r["p10"] <= r["p50"] <= r["p80"] <= r["p90"] <= r["latest"]
    assert sum(h["count"] for h in r["histogram"]) == 120
    assert r["deadline_probability"] == r["deterministic_probability"]
    # the triangle is skewed late (-10%/+30%), so the deterministic finish is optimistic
    assert r["p50"] > r["deterministic_finish"] and r["deterministic_probability"] < 50
    assert r["criticality"] and all(0 < c["pct"] <= 100 for c in r["criticality"])


def test_wider_range_and_correlation_widen_the_spread():
    p = house()
    span = lambda r: r["p90"] > r["p10"] and (r["p90"], r["p10"])
    narrow = risk_analysis(p, 150, 5, 10, 0, 0)
    wide = risk_analysis(p, 150, 10, 50, 20, 80)
    assert wide["p90"] > narrow["p90"]
    assert span(wide)


def test_zero_range_reproduces_the_plan():
    p = house()
    r = risk_analysis(p, 20, 0, 0, 0, 0)
    assert r["p10"] == r["p90"] == r["deterministic_finish"] and r["deterministic_probability"] == 100


def test_api_endpoint(tmp_path, monkeypatch):
    import api
    from planner import store
    monkeypatch.setattr(store, "DATA_DIR", tmp_path)
    c = TestClient(api.app)
    j = c.post("/api/generate", json={"text": "Two-storey house in Leeds, start 6 April 2026"}).json()
    pid = (j.get("project") or j)["id"]
    r = c.post(f"/api/projects/{pid}/risk", json={"iterations": 30}).json()
    assert r["iterations"] == 30 and r["p80"] >= r["p50"]

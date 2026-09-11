"""Real P6 / MS Project files (see tests/fixtures/README.md)."""
from datetime import date, datetime
from pathlib import Path

import pytest

from planner import schedule, health_check, Status
from planner.io import read_any
from planner import mpxj_bridge

FIX = Path(__file__).parent / "fixtures"


def load(name):
    return read_any(name, (FIX / name).read_bytes())


def test_real_xer_calendar_and_complete_activity():
    p = load("p6_complete_activity.xer")
    cal = p.calendars[p.default_calendar_id]
    assert cal.name == "5 Day" and cal.working_days == [0, 1, 2, 3, 4] and cal.hours_per_day == 8
    assert len(cal.exceptions) == 14 and cal.exceptions[date(2019, 12, 25)] == 0.0
    a = p.activities[0]
    assert a.status == Status.COMPLETE and a.actual_start == datetime(2019, 6, 10, 8) and a.actual_finish == datetime(2019, 6, 12, 17)
    schedule(p)
    assert a.early_start == datetime(2019, 6, 10, 8) and a.early_finish == datetime(2019, 6, 12, 17)
    assert p.data_date == datetime(2019, 10, 2)


def test_real_xer_percent_complete_types():
    p = load("p6_percent_complete.xer")
    by = {a.name: a for a in p.activities}
    assert by["Duration 25%"].percent_complete == 25 and by["Duration 25%"].remaining_hours == 600
    assert by["Duration 100%"].percent_complete == 100 and by["Duration 100%"].status == Status.IN_PROGRESS
    assert by["Physical 75%"].percent_complete == 75 and by["Physical 75%"].remaining_hours == 800
    assert by["Duration 0%"].status == Status.NOT_STARTED and by["Duration 0%"].remaining_hours is None
    schedule(p)
    assert health_check(p).score > 0


def test_real_pmxml_matches_xer():
    x = load("p6_percent_complete.xer")
    m = load("p6_percent_complete.pmxml")
    assert [a.id for a in x.activities] == [a.id for a in m.activities]
    for a, b in zip(x.activities, m.activities):
        assert a.name == b.name and a.duration_hours == b.duration_hours and a.status == b.status, a.id
        assert a.remaining_hours == b.remaining_hours, a.id
        if not a.name.startswith("Units"):  # units % needs resource assignments; P6 XML stores it, XER derives it
            assert a.percent_complete == b.percent_complete, a.id
    cal = m.calendars[m.default_calendar_id]
    assert cal.working_days == [0, 1, 2, 3, 4] and cal.hours_per_day == 8 and len(cal.exceptions) == 24
    assert m.data_date == datetime(2015, 2, 24)
    schedule(x); schedule(m)
    for a, b in zip(x.activities, m.activities):
        assert a.early_start == b.early_start and a.early_finish == b.early_finish, a.id


def test_real_mspdi_relations():
    p = load("msproject_relations.xml")
    assert len(p.activities) == 5 and len(p.relationships) == 4
    types = sorted(r.type.value for r in p.relationships)
    assert types == ["FF", "FS", "SF", "SS"]
    schedule(p)
    assert p.finish is not None


@pytest.mark.skipif(not mpxj_bridge.available(), reason="MPXJ bridge (Java + mpxj) not installed")
def test_binary_mpp_via_mpxj_bridge():
    p = load("msproject_sample.mpp")
    assert len(p.activities) == 18 and len(p.relationships) == 6 and len(p.wbs) == 4
    schedule(p)
    assert p.finish.year == 2003


def test_unknown_binary_gives_clear_error():
    with pytest.raises(ValueError):
        read_any("file.xyz", b"\x00\x01\x02")

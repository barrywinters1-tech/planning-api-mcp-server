from datetime import date, datetime, time

import pytest

from planner import (Activity, ActivityType, Calendar, Constraint, LinkType, Project,
                     Relationship, Status, schedule, ScheduleError, health_check)


def proj(**kw):
    p = Project(id="P", name="Test", start=datetime(2026, 1, 5, 8), **kw)  # Monday
    p.ensure_default_calendar()
    return p


def days(h):
    return h / 8


def test_calendar_arithmetic():
    cal = Calendar(id="std")
    fri = datetime(2026, 1, 9, 8)
    assert cal.add_hours(fri, 8) == datetime(2026, 1, 9, 16)
    assert cal.add_hours(fri, 16) == datetime(2026, 1, 12, 16)  # skips weekend
    assert cal.add_hours(datetime(2026, 1, 12, 16), -16) == fri
    assert cal.hours_between(fri, datetime(2026, 1, 12, 16)) == 16
    cal.exceptions[date(2026, 1, 12)] = 0
    assert cal.add_hours(fri, 16) == datetime(2026, 1, 13, 16)


def test_simple_chain_and_float():
    p = proj()
    p.activities = [
        Activity(id="A", name="A", duration_hours=16),
        Activity(id="B", name="B", duration_hours=24),
        Activity(id="C", name="C", duration_hours=8),
        Activity(id="D", name="D", duration_hours=8),
    ]
    p.relationships = [
        Relationship(predecessor_id="A", successor_id="B"),
        Relationship(predecessor_id="A", successor_id="C"),
        Relationship(predecessor_id="B", successor_id="D"),
        Relationship(predecessor_id="C", successor_id="D"),
    ]
    schedule(p)
    a, b, c, d = p.activities
    assert a.early_start == datetime(2026, 1, 5, 8)
    assert a.early_finish == datetime(2026, 1, 6, 16)
    assert b.early_start == datetime(2026, 1, 7, 8)
    assert b.early_finish == datetime(2026, 1, 9, 16)
    assert d.early_start == datetime(2026, 1, 12, 8)
    assert p.finish == datetime(2026, 1, 12, 16)
    assert a.critical and b.critical and d.critical and not c.critical
    assert days(c.total_float_hours) == 2
    assert days(c.free_float_hours) == 2
    assert a.total_float_hours == 0


def test_link_types_and_lag():
    p = proj()
    p.activities = [
        Activity(id="A", name="A", duration_hours=40),
        Activity(id="B", name="B", duration_hours=16),  # SS+8h
        Activity(id="C", name="C", duration_hours=8),   # FF+0 with A
        Activity(id="M", name="Done", type=ActivityType.FINISH_MILESTONE),
    ]
    p.relationships = [
        Relationship(predecessor_id="A", successor_id="B", type=LinkType.SS, lag_hours=8),
        Relationship(predecessor_id="A", successor_id="C", type=LinkType.FF),
        Relationship(predecessor_id="A", successor_id="M"),
        Relationship(predecessor_id="B", successor_id="M"),
        Relationship(predecessor_id="C", successor_id="M"),
    ]
    schedule(p)
    a, b, c, m = p.activities
    assert b.early_start == datetime(2026, 1, 6, 8)
    assert c.early_finish == a.early_finish == datetime(2026, 1, 9, 16)
    assert c.early_start == datetime(2026, 1, 9, 8)
    assert m.early_finish == datetime(2026, 1, 9, 16)
    assert m.critical


def test_constraints():
    p = proj()
    p.activities = [
        Activity(id="A", name="A", duration_hours=8),
        Activity(id="B", name="B", duration_hours=8, constraint=Constraint.START_ON_OR_AFTER,
                 constraint_date=datetime(2026, 1, 14, 8)),
        Activity(id="C", name="C", duration_hours=8, constraint=Constraint.FINISH_ON_OR_BEFORE,
                 constraint_date=datetime(2026, 1, 6, 16)),
    ]
    p.relationships = [Relationship(predecessor_id="A", successor_id="B"), Relationship(predecessor_id="A", successor_id="C")]
    schedule(p)
    a, b, c = p.activities
    assert b.early_start == datetime(2026, 1, 14, 8)
    assert c.late_finish == datetime(2026, 1, 6, 16)
    assert c.total_float_hours == 0
    assert a.late_finish == datetime(2026, 1, 5, 16)


def test_negative_float_with_must_finish():
    p = proj(must_finish_by=datetime(2026, 1, 6, 16))
    p.activities = [Activity(id="A", name="A", duration_hours=40)]
    schedule(p)
    assert p.activities[0].total_float_hours == -24


def test_progress_retained_logic():
    p = proj(data_date=datetime(2026, 1, 8, 8))
    p.activities = [
        Activity(id="A", name="A", duration_hours=16, status=Status.COMPLETE,
                 actual_start=datetime(2026, 1, 5, 8), actual_finish=datetime(2026, 1, 6, 16)),
        Activity(id="B", name="B", duration_hours=24, status=Status.IN_PROGRESS,
                 actual_start=datetime(2026, 1, 7, 8), remaining_hours=8),
        Activity(id="C", name="C", duration_hours=8),
    ]
    p.relationships = [Relationship(predecessor_id="A", successor_id="B"), Relationship(predecessor_id="B", successor_id="C")]
    schedule(p)
    a, b, c = p.activities
    assert b.early_finish == datetime(2026, 1, 8, 16)
    assert c.early_start == datetime(2026, 1, 9, 8)
    assert a.total_float_hours == 0 and not a.critical


def test_loop_detected():
    p = proj()
    p.activities = [Activity(id="A", name="A", duration_hours=8), Activity(id="B", name="B", duration_hours=8)]
    p.relationships = [Relationship(predecessor_id="A", successor_id="B"), Relationship(predecessor_id="B", successor_id="A")]
    with pytest.raises(ScheduleError):
        schedule(p)


def test_health_check_flags_open_ends():
    p = proj()
    p.activities = [Activity(id="A", name="A", duration_hours=8), Activity(id="B", name="B", duration_hours=8)]
    schedule(p)
    rep = health_check(p)
    byk = {c.key: c for c in rep.checks}
    assert not byk["logic"].passed
    assert byk["cp_test"].passed
    assert rep.score < 100


def test_hammock_spans_linked_activities():
    p = proj()
    p.activities = [
        Activity(id="A", name="A", duration_hours=16),
        Activity(id="B", name="B", duration_hours=24),
        Activity(id="H", name="Hammock", type=ActivityType.LOE),
        Activity(id="S", name="Supervision", type=ActivityType.LOE, wbs_id="X"),
        Activity(id="C", name="C", duration_hours=8, wbs_id="X"),
    ]
    p.relationships = [
        Relationship(predecessor_id="A", successor_id="B"),
        Relationship(predecessor_id="A", successor_id="H", type=LinkType.SS),
        Relationship(predecessor_id="B", successor_id="H", type=LinkType.FF),
        Relationship(predecessor_id="B", successor_id="C"),
    ]
    schedule(p)
    a, b, h, s, c = p.activities
    assert h.early_start == a.early_start and h.early_finish == b.early_finish
    assert h.duration_hours == 40 and not h.critical
    assert s.early_start == c.early_start and s.early_finish == c.early_finish  # spans its WBS node
    rep = health_check(p)
    assert "H" not in {i for ch in rep.checks for i in ch.items}  # LOE ignored by logic checks

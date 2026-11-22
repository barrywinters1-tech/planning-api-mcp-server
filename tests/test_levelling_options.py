"""Resource levelling options and the levelling report (planner/levelling.py docstring).

The hand project: a single gang (max 1) shared by A (3 days), B (1 day, after P) and C (2 days, priority 100) and a
crane (max 1) shared by C and L (a five-day activity that sets the finish). Start Monday 2 March 2026, 08:00-16:00,
no holidays. Scheduled: A, C, L, P start Monday; B Wednesday; Z (finish) Friday 16:00. Late starts: A Wed, C Thu,
B Fri, P Wed, L Mon. Every expected date below is worked by hand from the serial method."""
from datetime import datetime

import pytest

from planner import Activity, Assignment, Calendar, LinkType, Project, Relationship, Resource, schedule
from planner.levelling import LEVEL_ORDERS, LEVEL_REASONS, level, level_options, levelling_report, unlevel


def _dt(day, hour=8):
    return datetime(2026, 3, day, hour)


def hand_project(**kw) -> Project:
    p = Project(id="ORD", name="ORD", start=_dt(2), calendars={"std": Calendar(id="std")},
                activities=[Activity(id="A", name="A", duration_hours=24), Activity(id="B", name="B", duration_hours=8),
                            Activity(id="C", name="C", duration_hours=16, priority=100), Activity(id="L", name="L", duration_hours=40),
                            Activity(id="P", name="P", duration_hours=16), Activity(id="Z", name="Z", type="finish_milestone")],
                relationships=[Relationship(predecessor_id="P", successor_id="B")]
                + [Relationship(predecessor_id=x, successor_id="Z") for x in "ABCL"],
                resources=[Resource(id="gang", name="Gang", max_units_per_day=1), Resource(id="crane", name="Crane", max_units_per_day=1)],
                assignments=[Assignment(activity_id="A", resource_id="gang", units=24), Assignment(activity_id="B", resource_id="gang", units=8),
                             Assignment(activity_id="C", resource_id="gang", units=16), Assignment(activity_id="C", resource_id="crane", units=16),
                             Assignment(activity_id="L", resource_id="crane", units=40)], **kw)
    return p


def dates(p):
    return {a.id: (a.early_start, a.early_finish, a.level_delay_hours) for a in p.activities}


def rec(id, delay, resource, waited, reason):
    return {"id": id, "delay_hours": delay, "resource_id": resource, "waited_for": waited, "reason": reason}


def test_scheduled_dates_before_levelling():
    p = schedule(hand_project())
    assert {a.id: a.early_start for a in p.activities} == {"A": _dt(2), "B": _dt(4), "C": _dt(2), "L": _dt(2), "P": _dt(2), "Z": _dt(6, 16)}
    assert {a.id: a.late_start for a in p.activities if a.id != "Z"} == {"A": _dt(4), "B": _dt(6), "C": _dt(5), "L": _dt(2), "P": _dt(4)}
    assert p.levelling_report is None and levelling_report(p) == []


def test_default_levelling_limits_every_resource_and_reports():
    """No options: both resources limited. L takes the crane all week, so C waits for it until Monday 9th; B waits
    for the gang behind A; Z follows C. The report names the resource and the activity each one waited for."""
    p = level(hand_project())
    d = dates(p)
    assert d["A"] == (_dt(2), _dt(4, 16), 0.0)
    assert d["B"] == (_dt(5), _dt(5, 16), 8.0)
    assert d["C"] == (_dt(9), _dt(10, 16), 40.0)
    assert d["L"] == (_dt(2), _dt(6, 16), 0.0) and d["P"] == (_dt(2), _dt(3, 16), 0.0)
    assert d["Z"] == (_dt(11), _dt(11), 16.0)
    assert p.levelled and p.finish == _dt(11)
    assert levelling_report(p) == [rec("B", 8.0, "gang", "A", "capacity"), rec("C", 40.0, "crane", "L", "capacity"),
                                   rec("Z", 16.0, None, "C", "capacity")]
    assert levelling_report(p) == p.levelling_report
    unlevel(p)
    assert p.levelling_report is None and not p.levelled


def test_resources_option_limits_only_the_named_resources():
    """resources=["gang"]: the crane is unlimited, so C only waits for A (Thursday) and B queues behind C (Monday 9th);
    resources=["crane"]: the gang is unlimited, so B keeps Wednesday and only C waits for L."""
    p = level(hand_project(), {"resources": ["gang"]})
    d = dates(p)
    assert d["A"] == (_dt(2), _dt(4, 16), 0.0) and d["C"] == (_dt(5), _dt(6, 16), 24.0)
    assert d["B"] == (_dt(9), _dt(9, 16), 24.0) and d["Z"] == (_dt(10), _dt(10), 8.0)
    assert levelling_report(p) == [rec("B", 24.0, "gang", "C", "capacity"), rec("C", 24.0, "gang", "A", "capacity"),
                                   rec("Z", 8.0, None, "B", "capacity")]
    p = level(hand_project(), {"resources": ["crane"]})
    d = dates(p)
    assert d["B"] == (_dt(4), _dt(4, 16), 0.0) and d["C"] == (_dt(9), _dt(10, 16), 40.0) and d["Z"] == (_dt(11), _dt(11), 16.0)
    assert levelling_report(p) == [rec("C", 40.0, "crane", "L", "capacity"), rec("Z", 16.0, None, "C", "capacity")]
    # a subset naming no limited resource levels nothing
    p = level(hand_project(), {"resources": ["nobody"]})
    assert not p.levelled and p.levelling_report is None and dates(p)["C"] == (_dt(2), _dt(3, 16), 0.0)


def test_order_options():
    base = {"resources": ["gang"]}
    # late_start (the default): A (LS Wed) before C (LS Thu, priority 100) before B (LS Fri)
    for opts in ({**base}, {**base, "order": "late_start"}, {**base, "order": "nonsense"}):
        d = dates(level(hand_project(), opts))
        assert (d["A"][0], d["C"][0], d["B"][0]) == (_dt(2), _dt(5), _dt(9))
    # priority: C (100) goes first, A waits two days behind it, B queues behind A
    d = dates(level(hand_project(), {**base, "order": "priority"}))
    assert (d["C"], d["A"], d["B"]) == ((_dt(2), _dt(3, 16), 0.0), (_dt(4), _dt(6, 16), 16.0), (_dt(9), _dt(9, 16), 24.0))
    # total_float: B (16h float) is placed before C (24h float), so B takes Thursday and C slips to Friday-Monday
    p = level(hand_project(), {**base, "order": "total_float"})
    d = dates(p)
    assert (d["A"], d["B"], d["C"]) == ((_dt(2), _dt(4, 16), 0.0), (_dt(5), _dt(5, 16), 8.0), (_dt(6), _dt(9, 16), 32.0))
    assert levelling_report(p) == [rec("B", 8.0, "gang", "A", "capacity"), rec("C", 32.0, "gang", "B", "capacity"),
                                   rec("Z", 8.0, None, "C", "capacity")]
    # early_start: all start Monday, so priority decides: C first, then A, then B (same as the priority order here)
    d = dates(level(hand_project(), {**base, "order": "early_start"}))
    assert (d["C"][0], d["A"][0], d["B"][0]) == (_dt(2), _dt(4), _dt(9))
    assert LEVEL_ORDERS == ("late_start", "priority", "total_float", "early_start")


def test_within_float_blocks_an_activity_that_cannot_fit():
    """C fits within its float (Thursday start = late start). B would have to start Monday 9th, past its late start
    (Friday), so it keeps Wednesday, stays over-allocated and is reported; Z is not delayed."""
    p = level(hand_project(), {"resources": ["gang"], "within_float": True})
    d = dates(p)
    assert d["C"] == (_dt(5), _dt(6, 16), 24.0)
    assert d["B"] == (_dt(4), _dt(4, 16), 0.0)
    assert d["Z"][2] == 0.0
    assert levelling_report(p) == [rec("B", 0.0, "gang", "C", "within_float_blocked"), rec("C", 24.0, "gang", "A", "capacity")]


def test_window_only_moves_activities_starting_inside_it():
    """from/to Tuesday 3rd to Wednesday 4th: only B (scheduled Wednesday) may move; C starts Monday, so it stays
    over-allocated against A and is reported as outside the window."""
    p = level(hand_project(), {"resources": ["gang"], "from": "2026-03-03", "to": "2026-03-04"})
    d = dates(p)
    assert d["C"] == (_dt(2), _dt(3, 16), 0.0) and d["B"] == (_dt(5), _dt(5, 16), 8.0)
    assert levelling_report(p) == [rec("B", 8.0, "gang", "A", "capacity"), rec("C", 0.0, "gang", "A", "window")]
    # a datetime window and an open-ended one behave the same way
    p2 = level(hand_project(), {"resources": ["gang"], "from": "2026-03-03T00:00:00"})
    assert dates(p2) == d
    assert set(LEVEL_REASONS) == {"capacity", "within_float_blocked", "window"}


def test_options_stored_on_the_project_and_the_argument_wins():
    p = hand_project(levelling={"resources": ["gang"], "order": "total_float"})
    assert level_options(p) == {"resources": ["gang"], "order": "total_float"}
    assert level_options(p, {"order": "priority"}) == {"resources": ["gang"], "order": "priority"}
    d = dates(level(p))
    assert d["B"][0] == _dt(5) and d["C"][0] == _dt(6)          # total_float from the project
    d = dates(level(hand_project(levelling={"resources": ["gang"], "order": "total_float"}), {"order": "priority"}))
    assert d["C"][0] == _dt(2) and d["A"][0] == _dt(4)          # priority from the argument
    # preserve_actuals is accepted and changes nothing
    assert dates(level(hand_project(), {"resources": ["gang"], "preserve_actuals": True})) == dates(level(hand_project(), {"resources": ["gang"]}))
    # a round trip through JSON keeps the options and the report
    q = Project.model_validate(level(p).model_dump(mode="json"))
    assert q.levelling == {"resources": ["gang"], "order": "total_float"} and q.levelling_report == p.levelling_report


def test_levelling_measures_lag_on_the_lag_calendar():
    """P -> B with a 16-hour lag measured as elapsed time: the scheduler puts B at Tuesday 08:00 (Monday 16:00 + 16h),
    and levelling, which now walks the same lag calendar, leaves it there with no delay."""
    p = Project(id="LAG", name="LAG", start=_dt(2), lag_calendar="24h", calendars={"std": Calendar(id="std")},
                activities=[Activity(id="P", name="P", duration_hours=8), Activity(id="B", name="B", duration_hours=8)],
                relationships=[Relationship(predecessor_id="P", successor_id="B", lag_hours=16)],
                resources=[Resource(id="gang", name="Gang", max_units_per_day=1)],
                assignments=[Assignment(activity_id="B", resource_id="gang", units=8)])
    schedule(p)
    assert p.activities[1].early_start == _dt(3)
    level(p)
    assert p.activities[1].early_start == _dt(3) and p.activities[1].level_delay_hours == 0.0
    assert p.levelling_report == []
    # the same lag on the predecessor's working calendar lands Wednesday 16:00 -> B starts Thursday
    p.lag_calendar = "predecessor"
    level(p)
    assert p.activities[1].early_start == _dt(5) and p.activities[1].level_delay_hours == 0.0


def test_elapsed_activity_is_levelled_on_calendar_time():
    """A (48 elapsed hours from Monday 08:00, finishing Wednesday 08:00) holds the gang on Monday, Tuesday and
    Wednesday; B, a one-day task, is pushed to Thursday."""
    p = Project(id="EL", name="EL", start=_dt(2), calendars={"std": Calendar(id="std")},
                activities=[Activity(id="A", name="A", duration_hours=48, elapsed=True), Activity(id="B", name="B", duration_hours=8)],
                resources=[Resource(id="gang", name="Gang", max_units_per_day=1)],
                assignments=[Assignment(activity_id="A", resource_id="gang", units=48), Assignment(activity_id="B", resource_id="gang", units=8)])
    level(p)
    d = dates(p)
    assert d["A"] == (_dt(2), _dt(4), 0.0)
    assert d["B"] == (_dt(5), _dt(5, 16), 24.0)
    assert levelling_report(p) == [rec("B", 24.0, "gang", "A", "capacity")]


@pytest.mark.parametrize("order", LEVEL_ORDERS)
def test_every_order_respects_logic_and_limits(order):
    from planner.analysis import histogram
    p = level(hand_project(), {"order": order})
    amap = p.activity_map()
    for r in p.relationships:
        if r.type == LinkType.FS:
            assert amap[r.successor_id].early_start >= amap[r.predecessor_id].early_finish
    assert all(r["overallocated_days"] == 0 for r in histogram(p)["resources"])
    assert [r["id"] for r in levelling_report(p)] == sorted(r["id"] for r in levelling_report(p))

from datetime import date, datetime, time

import pytest

from planner import (Activity, ActivityType, Calendar, Constraint, LinkType, Project,
                     Relationship, Status, schedule, ScheduleError, health_check)
from planner.cpm import float_paths


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


def test_longest_path_across_calendars():
    """Critical = the chain of driving links back from the finish, not "float <= 0".

    A (5-day) -> cure C (7-day, works Sat) -> D, in parallel with B -> D. The cure ends
    Saturday, so A, B and C all carry 8h of calendar float, yet A-C-D is what sets D's
    start. A float threshold would flag only D; the longest path flags A, C and D."""
    p = proj()
    p.calendars["seven"] = Calendar(id="seven", working_days=list(range(7)))
    p.activities = [Activity(id="A", name="A", duration_hours=24), Activity(id="B", name="B", duration_hours=32),
                    Activity(id="C", name="Cure", duration_hours=24, calendar_id="seven"),
                    Activity(id="D", name="D", duration_hours=8)]
    p.relationships = [Relationship(predecessor_id="A", successor_id="C"), Relationship(predecessor_id="C", successor_id="D"),
                       Relationship(predecessor_id="B", successor_id="D")]
    schedule(p)
    a = p.activity_map()
    assert a["C"].early_finish == datetime(2026, 1, 10, 16)       # Saturday
    assert a["D"].early_start == datetime(2026, 1, 12, 8)         # Monday
    assert [a[x].total_float_hours for x in "ABC"] == [8, 8, 8]
    assert [x for x in "ABCD" if a[x].critical] == ["A", "C", "D"]
    drv = {(r.predecessor_id, r.successor_id): r.driving for r in p.relationships}
    assert drv == {("A", "C"): True, ("C", "D"): True, ("B", "D"): False}


# ---- lag calendars ------------------------------------------------------------------------
def _lag_project(mode=None, link_mode=None, lag=16.0, typ=LinkType.FS):
    """A (five-day) -> B (seven-day) with a +2d lag (16h on A's 8h days); the project default calendar works six days,
    so each lag-calendar option lands B on a different day."""
    p = Project(id="P", name="Lag", start=datetime(2026, 1, 5, 8), default_calendar_id="six", lag_calendar=mode)
    p.calendars = {"five": Calendar(id="five"), "six": Calendar(id="six", working_days=[0, 1, 2, 3, 4, 5]),
                   "seven": Calendar(id="seven", working_days=list(range(7)))}
    p.activities = [Activity(id="A", name="A", duration_hours=40, calendar_id="five"),
                    Activity(id="B", name="B", duration_hours=16, calendar_id="seven")]
    p.relationships = [Relationship(predecessor_id="A", successor_id="B", type=typ, lag_hours=lag, lag_calendar=link_mode)]
    return p


@pytest.mark.parametrize("mode, b_start", [
    (None, datetime(2026, 1, 14, 8)),           # unset = P6 default: A's five-day calendar; Fri 16:00 + 16h -> Tue 16:00
    ("predecessor", datetime(2026, 1, 14, 8)),
    ("successor", datetime(2026, 1, 12, 8)),    # B's seven-day calendar: Sat and Sun carry the lag
    ("project", datetime(2026, 1, 13, 8)),      # the six-day default calendar: Sat and Mon
    ("24h", datetime(2026, 1, 10, 8)),          # 16 wall-clock hours from Fri 16:00 is Sat 08:00, a working time for B
    ("bogus", datetime(2026, 1, 14, 8)),        # an unknown value behaves as the default
])
def test_lag_calendar_options(mode, b_start):
    p = _lag_project(mode)
    schedule(p)
    a, b = p.activities
    assert a.early_finish == datetime(2026, 1, 9, 16)
    assert b.early_start == b_start
    assert b.early_finish == p.calendars["seven"].add_hours(b_start, 16)
    assert p.relationships[0].driving and a.critical and b.critical
    # the backward pass measures the lag on the same calendar, so A has no float whatever the option
    assert a.late_finish == a.early_finish and a.total_float_hours == 0 and a.free_float_hours == 0
    assert b.late_start == b.early_start


def test_relationship_lag_calendar_overrides_the_project_setting():
    p = _lag_project("successor", link_mode="24h")
    schedule(p)
    assert p.activities[1].early_start == datetime(2026, 1, 10, 8)
    p = _lag_project("24h", link_mode="predecessor")
    schedule(p)
    assert p.activities[1].early_start == datetime(2026, 1, 14, 8)


def test_24h_lag_lands_on_the_successors_next_working_time():
    """48 elapsed hours from Fri 16:00 is Sun 16:00; a five-day successor starts Monday morning."""
    p = _lag_project("24h", lag=48)
    p.activities[1].calendar_id = "five"
    schedule(p)
    assert p.activities[1].early_start == datetime(2026, 1, 12, 8)
    assert p.relationships[0].driving


def test_24h_lag_on_finish_links_and_leads():
    # FF +16h elapsed: B's finish is pinned 16 wall-clock hours after A's, exactly as a working-calendar FF floor would be
    p = _lag_project("24h", lag=16, typ=LinkType.FF)
    schedule(p)
    b = p.activities[1]
    assert b.early_finish == datetime(2026, 1, 10, 8)
    assert b.early_start == datetime(2026, 1, 8, 8)      # 16h of B's own seven-day calendar back from the finish
    assert p.relationships[0].driving
    # a lead (negative lag) runs backwards in elapsed time: Fri 16:00 - 8h = Fri 08:00
    p = _lag_project("24h", lag=-8)
    schedule(p)
    assert p.activities[1].early_start == datetime(2026, 1, 9, 8)


def test_driving_link_follows_the_lag_calendar():
    """Which predecessor drives D depends on the calendar its lag is measured on; the longest path follows it."""
    def build(mode):
        p = proj(lag_calendar=mode)
        p.activities = [Activity(id="A", name="A", duration_hours=40), Activity(id="B", name="B", duration_hours=48),
                        Activity(id="D", name="D", duration_hours=8)]
        p.relationships = [Relationship(predecessor_id="A", successor_id="D", lag_hours=16),
                           Relationship(predecessor_id="B", successor_id="D")]
        schedule(p)
        return p
    p = build("24h")                                      # A + 16 elapsed hours = Sat 08:00, so B (Mon 16:00) sets D
    a = p.activity_map()
    assert a["D"].early_start == datetime(2026, 1, 13, 8)
    assert {r.predecessor_id: r.driving for r in p.relationships} == {"A": False, "B": True}
    assert [x for x in "ABD" if a[x].critical] == ["B", "D"]
    assert a["A"].total_float_hours == 8                  # late finish Mon 16:00: D's late start less 16 elapsed hours
    p = build("predecessor")                              # A + 16 working hours = Tue 16:00, so A sets D
    a = p.activity_map()
    assert a["D"].early_start == datetime(2026, 1, 14, 8)
    assert {r.predecessor_id: r.driving for r in p.relationships} == {"A": True, "B": False}
    assert [x for x in "ABD" if a[x].critical] == ["A", "D"]
    assert a["B"].total_float_hours == 8


# ---- scheduling options ---------------------------------------------------------------------
def _oos_project(mode=None):
    """A (40h, not started) -> B (in progress since Tue 6 Jan, 16h left) -> C, and A -FF+8h-> F (in progress, 4h left);
    data date Thu 8 Jan. B and F both started out of sequence: A has not started."""
    p = proj(data_date=datetime(2026, 1, 8, 8), progress_logic=mode)
    p.activities = [Activity(id="A", name="A", duration_hours=40),
                    Activity(id="B", name="B", duration_hours=24, status=Status.IN_PROGRESS, actual_start=datetime(2026, 1, 6, 8), remaining_hours=16),
                    Activity(id="C", name="C", duration_hours=8),
                    Activity(id="F", name="F", duration_hours=8, status=Status.IN_PROGRESS, actual_start=datetime(2026, 1, 7, 8), remaining_hours=4)]
    p.relationships = [Relationship(predecessor_id="A", successor_id="B"), Relationship(predecessor_id="B", successor_id="C"),
                       Relationship(predecessor_id="A", successor_id="F", type=LinkType.FF, lag_hours=8)]
    schedule(p)
    return p, p.activity_map(), {(r.predecessor_id, r.successor_id): r.driving for r in p.relationships}


@pytest.mark.parametrize("mode", [None, "data_date", "bogus"])
def test_progress_logic_data_date_is_the_default(mode):
    """The engine's long-standing default, not a P6 mode: remaining work runs from the data date; the finish-side link
    from A still holds F, the start-side link into B cannot move B's start but pulls A's late finish back to B's
    actual start (negative float)."""
    p, a, drv = _oos_project(mode)
    assert a["A"].early_finish == datetime(2026, 1, 14, 16)
    assert a["B"].early_finish == datetime(2026, 1, 9, 16) and a["C"].early_start == datetime(2026, 1, 12, 8)
    assert a["F"].early_finish == datetime(2026, 1, 15, 16) and a["F"].critical and a["F"].total_float_hours == 0
    assert a["A"].late_finish == datetime(2026, 1, 5, 16) and a["A"].total_float_hours == -56 and not a["A"].critical
    assert a["B"].total_float_hours == 24 and a["C"].total_float_hours == 24
    assert drv == {("A", "B"): False, ("B", "C"): True, ("A", "F"): False}
    assert p.finish == datetime(2026, 1, 15, 16)


def test_progress_logic_override_ignores_unfinished_predecessors():
    """Both passes drop the links from A (not complete) into the started B and F: F finishes its 4h at once, A is
    no longer pulled back by B and becomes the longest path to the (earlier) finish."""
    p, a, drv = _oos_project("override")
    assert a["B"].early_finish == datetime(2026, 1, 9, 16) and a["C"].early_start == datetime(2026, 1, 12, 8)
    assert a["F"].early_finish == datetime(2026, 1, 8, 12) and a["F"].total_float_hours == 36 and a["F"].free_float_hours == 36
    assert a["A"].late_finish == datetime(2026, 1, 14, 16) and a["A"].total_float_hours == 0 and a["A"].critical
    assert a["B"].total_float_hours == 16 and a["B"].free_float_hours == 0 and a["C"].total_float_hours == 16
    assert drv == {("A", "B"): False, ("B", "C"): True, ("A", "F"): False}
    assert p.finish == datetime(2026, 1, 14, 16)


def test_progress_logic_retained_holds_remaining_work_by_logic():
    """P6 retained logic: B's 16 remaining hours wait for A (Wed 14 Jan 16:00) and run Thu-Fri; its actual start never
    moves; the links that hold the remaining work are driving, so A-B-C is the longest path and A carries no float."""
    p, a, drv = _oos_project("retained")
    assert a["B"].early_start == datetime(2026, 1, 6, 8) and a["B"].early_finish == datetime(2026, 1, 16, 16)
    assert a["C"].early_start == datetime(2026, 1, 19, 8) and p.finish == datetime(2026, 1, 19, 16)
    assert a["F"].early_finish == datetime(2026, 1, 15, 16) and a["F"].total_float_hours == 16 and not a["F"].critical
    assert a["A"].late_finish == datetime(2026, 1, 14, 16) and a["A"].total_float_hours == 0 and a["A"].free_float_hours == 0
    assert [x for x in "ABCF" if a[x].critical] == ["A", "B", "C"]
    assert a["B"].late_start == datetime(2026, 1, 6, 8) and a["B"].total_float_hours == 0
    assert drv == {("A", "B"): True, ("B", "C"): True, ("A", "F"): True}


def test_progress_logic_modes_agree_without_out_of_sequence_progress():
    """With the logic intact the three modes give the same dates (retained may add driving flags)."""
    dates = {}
    for mode in (None, "override", "retained"):
        p = proj(data_date=datetime(2026, 1, 8, 8), progress_logic=mode)
        p.activities = [Activity(id="A", name="A", duration_hours=16, status=Status.COMPLETE,
                                 actual_start=datetime(2026, 1, 5, 8), actual_finish=datetime(2026, 1, 6, 16)),
                        Activity(id="B", name="B", duration_hours=24, status=Status.IN_PROGRESS,
                                 actual_start=datetime(2026, 1, 7, 8), remaining_hours=8),
                        Activity(id="C", name="C", duration_hours=8)]
        p.relationships = [Relationship(predecessor_id="A", successor_id="B"), Relationship(predecessor_id="B", successor_id="C")]
        schedule(p)
        dates[mode] = [(x.early_start, x.early_finish, x.late_start, x.late_finish, x.total_float_hours, x.critical) for x in p.activities]
    assert dates[None] == dates["override"] == dates["retained"]
    assert dates[None][1][1] == datetime(2026, 1, 8, 16)


def _two_chains(**kw):
    """S -> A1 -> A2 -> Z (the longest path), S -> B1 -> B2 -> Z (3 days of float) and S -> C1 -> Z (9 days)."""
    p = proj(**kw)
    p.activities = [Activity(id="S", name="S", type=ActivityType.START_MILESTONE),
                    Activity(id="A1", name="A1", duration_hours=40), Activity(id="A2", name="A2", duration_hours=40),
                    Activity(id="B1", name="B1", duration_hours=24), Activity(id="B2", name="B2", duration_hours=32),
                    Activity(id="C1", name="C1", duration_hours=8),
                    Activity(id="Z", name="Z", type=ActivityType.FINISH_MILESTONE)]
    p.relationships = [Relationship(predecessor_id=x, successor_id=y) for x, y in
                       (("S", "A1"), ("A1", "A2"), ("A2", "Z"), ("S", "B1"), ("B1", "B2"), ("B2", "Z"), ("S", "C1"), ("C1", "Z"))]
    schedule(p)
    return p, p.activity_map()


def test_float_paths():
    p, a = _two_chains(float_paths=3)
    assert {x: a[x].float_path for x in a} == {"S": 1, "A1": 1, "A2": 1, "Z": 1, "B1": 2, "B2": 2, "C1": 3}
    assert [x for x in a if a[x].critical] == ["S", "A1", "A2", "Z"]
    assert [a[x].total_float_hours for x in ("B1", "B2", "C1")] == [24, 24, 72]
    # the pure function on the scheduled project, with fewer paths and with the option off
    assert float_paths(p, 2) == {"S": 1, "A1": 1, "A2": 1, "Z": 1, "B1": 2, "B2": 2}
    assert float_paths(p, 1) == {"S": 1, "A1": 1, "A2": 1, "Z": 1}
    assert float_paths(p, None) == {} and float_paths(p, 0) == {}
    assert float_paths(p, 99) == float_paths(p, 10) == float_paths(p, 3)   # no fourth chain, capped at ten
    p.float_paths = None
    schedule(p)
    assert all(x.float_path is None for x in p.activities)


def test_float_paths_skip_complete_work_and_hammocks():
    p, a = _two_chains(float_paths=5, data_date=datetime(2026, 1, 8, 8))
    for x in ("S", "B1"):
        a[x].status, a[x].actual_start = Status.COMPLETE, datetime(2026, 1, 5, 8)
        a[x].actual_finish = datetime(2026, 1, 5, 8) if x == "S" else datetime(2026, 1, 7, 16)
    p.activities.append(Activity(id="H", name="Hammock", type=ActivityType.LOE))
    p.relationships += [Relationship(predecessor_id="B2", successor_id="H", type=LinkType.SS),
                        Relationship(predecessor_id="C1", successor_id="H", type=LinkType.FF)]
    schedule(p)
    a = p.activity_map()
    assert {x: a[x].float_path for x in a} == {"S": None, "A1": 1, "A2": 1, "Z": 1, "B1": None, "B2": 2, "C1": 3, "H": None}


def test_start_on_new_day():
    """A (Mon-Fri) feeds B through a 4h lag and C (4h) feeds D: both would start at 12:00 on Mon 12 Jan; with the
    option they start Tue 08:00. The start milestone M moves too; E's start, set back from its FF link, does not."""
    def build(flag):
        p = proj(start_on_new_day=flag)
        p.activities = [Activity(id="A", name="A", duration_hours=40), Activity(id="B", name="B", duration_hours=16),
                        Activity(id="C", name="C", duration_hours=4), Activity(id="D", name="D", duration_hours=8),
                        Activity(id="M", name="M", type=ActivityType.START_MILESTONE), Activity(id="E", name="E", duration_hours=8)]
        p.relationships = [Relationship(predecessor_id="A", successor_id="B", lag_hours=4), Relationship(predecessor_id="A", successor_id="C"),
                           Relationship(predecessor_id="C", successor_id="D"), Relationship(predecessor_id="A", successor_id="M", lag_hours=4),
                           Relationship(predecessor_id="A", successor_id="E", type=LinkType.FF, lag_hours=4)]
        schedule(p)
        return p, p.activity_map()
    p, a = build(None)
    assert a["B"].early_start == datetime(2026, 1, 12, 12) and a["B"].early_finish == datetime(2026, 1, 14, 12)
    assert a["D"].early_start == datetime(2026, 1, 12, 12) and a["M"].early_start == datetime(2026, 1, 12, 12)
    assert p.finish == datetime(2026, 1, 14, 12)
    p, a = build(True)
    assert a["B"].early_start == datetime(2026, 1, 13, 8) and a["B"].early_finish == datetime(2026, 1, 14, 16)
    assert a["C"].early_finish == datetime(2026, 1, 12, 12) and a["D"].early_start == datetime(2026, 1, 13, 8)
    assert a["M"].early_start == datetime(2026, 1, 13, 8)
    assert a["E"].early_start == datetime(2026, 1, 9, 12) and a["E"].early_finish == datetime(2026, 1, 12, 12)
    assert p.finish == datetime(2026, 1, 14, 16)
    assert a["A"].critical and a["B"].critical and p.relationships[0].driving
    assert a["A"].total_float_hours == 4          # late dates are not rounded: A may finish 4h later and B still starts Tuesday
    assert a["B"].total_float_hours == 0 and a["D"].total_float_hours == 8


def test_start_on_new_day_leaves_started_work_alone():
    p = proj(start_on_new_day=True, data_date=datetime(2026, 1, 5, 12))
    p.activities = [Activity(id="G", name="G", duration_hours=8, status=Status.IN_PROGRESS, actual_start=datetime(2026, 1, 5, 8), remaining_hours=4),
                    Activity(id="N", name="N", duration_hours=8)]
    schedule(p)
    g, n = p.activities
    assert g.early_finish == datetime(2026, 1, 5, 16)      # remaining work resumes at the data date, mid-day
    assert n.early_start == datetime(2026, 1, 6, 8)        # not started: the data date is mid-day, so the next day


def test_near_critical_threshold():
    p, a = _two_chains()                                   # default: 10 working days
    assert {x: a[x].near_critical for x in a} == {"S": False, "A1": False, "A2": False, "Z": False, "B1": True, "B2": True, "C1": True}
    p, a = _two_chains(near_critical_days=3)               # B1/B2 carry exactly 3 days (24h), C1 nine
    assert [x for x in a if a[x].near_critical] == ["B1", "B2"]
    p, a = _two_chains(near_critical_days=2.5)
    assert not any(a[x].near_critical for x in a)
    p, a = _two_chains(near_critical_days=0)
    assert not any(a[x].near_critical for x in a)
    # the threshold is in the activity's own working days, has no effect on dates, and complete work is never flagged
    p7, a7 = _two_chains(near_critical_days=3)
    assert [(a7[x].early_start, a7[x].total_float_hours) for x in a7] == [(a[x].early_start, a[x].total_float_hours) for x in a]
    p7.calendars["long"] = Calendar(id="long", hours_per_day=12)
    a7["C1"].calendar_id = "long"
    schedule(p7)
    assert a7["C1"].total_float_hours == 108 and not a7["C1"].near_critical    # 9 days of 12h: 3 days is not near
    p7.near_critical_days = 9
    schedule(p7)
    assert a7["C1"].near_critical
    a7["B1"].status, a7["B1"].actual_start, a7["B1"].actual_finish = Status.COMPLETE, datetime(2026, 1, 5, 8), datetime(2026, 1, 7, 16)
    schedule(p7)
    assert a7["B1"].near_critical is False
    assert Activity(id="x", name="x").near_critical is None   # unscheduled

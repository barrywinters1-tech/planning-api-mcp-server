from datetime import date, datetime

from planner import (Activity, ActivityType, Assignment, Calendar, Constraint, LinkType, Project,
                     Relationship, Resource, Status, WBSNode, schedule)
from planner.xer import read_xer, write_xer, parse_clndr_data, build_clndr_data
from planner.mspxml import read_mspdi, write_mspdi


def sample() -> Project:
    cal = Calendar(id="std", name="5d x 8h", exceptions={date(2026, 12, 25): 0.0})
    six = Calendar(id="six", name="6d x 10h", hours_per_day=10, working_days=[0, 1, 2, 3, 4, 5])
    p = Project(id="DEMO", name="Demo build", start=datetime(2026, 1, 5, 8), data_date=datetime(2026, 1, 5, 8),
                calendars={"std": cal, "six": six}, must_finish_by=datetime(2026, 3, 31, 16))
    p.wbs = [WBSNode(id="W1", name="Enabling", seq=1), WBSNode(id="W2", name="Substructure", seq=2),
             WBSNode(id="W21", name="Piling", parent_id="W2", seq=1)]
    p.activities = [
        Activity(id="A1000", name="Start", type=ActivityType.START_MILESTONE, wbs_id="W1"),
        Activity(id="A1010", name="Site set-up", duration_hours=40, wbs_id="W1"),
        Activity(id="A1020", name="Piling", duration_hours=80, wbs_id="W21", calendar_id="six"),
        Activity(id="A1030", name="Pile caps", duration_hours=40, wbs_id="W2",
                 constraint=Constraint.START_ON_OR_AFTER, constraint_date=datetime(2026, 2, 2, 8)),
        Activity(id="A1040", name="Substructure complete", type=ActivityType.FINISH_MILESTONE, wbs_id="W2"),
    ]
    p.relationships = [
        Relationship(predecessor_id="A1000", successor_id="A1010"),
        Relationship(predecessor_id="A1010", successor_id="A1020", type=LinkType.SS, lag_hours=16),
        Relationship(predecessor_id="A1020", successor_id="A1030", type=LinkType.FS, lag_hours=8),
        Relationship(predecessor_id="A1030", successor_id="A1040"),
    ]
    p.resources = [Resource(id="PILER", name="Piling gang", type="labour"), Resource(id="RIG", name="Piling rig", type="equipment")]
    p.assignments = [Assignment(activity_id="A1020", resource_id="PILER", units=160), Assignment(activity_id="A1020", resource_id="RIG", units=80)]
    schedule(p)
    return p


def _assert_same(a: Project, b: Project, floats: bool = True):
    assert [x.id for x in a.activities] == [x.id for x in b.activities]
    for x, y in zip(a.activities, b.activities):
        assert x.name == y.name
        assert x.type == y.type
        assert x.duration_hours == y.duration_hours
        assert x.constraint == y.constraint
        assert x.constraint_date == y.constraint_date
    assert sorted((r.predecessor_id, r.successor_id, r.type, r.lag_hours) for r in a.relationships) == \
           sorted((r.predecessor_id, r.successor_id, r.type, r.lag_hours) for r in b.relationships)
    assert sorted(r.id for r in a.resources) == sorted(r.id for r in b.resources)
    assert len(a.assignments) == len(b.assignments)
    # rescheduling the round-tripped project gives the same dates
    schedule(b)
    for x, y in zip(a.activities, b.activities):
        assert x.early_start == y.early_start, x.id
        assert x.early_finish == y.early_finish, x.id
        if floats:
            assert x.total_float_hours == y.total_float_hours, x.id


def test_xer_roundtrip():
    p = sample()
    text = write_xer(p)
    assert text.startswith("ERMHDR")
    assert "%T\tTASK" in text and "%T\tTASKPRED" in text
    q = read_xer(text)
    assert q.name == "Demo build"
    assert q.must_finish_by == p.must_finish_by
    assert {c.name for c in q.calendars.values()} == {"5d x 8h", "6d x 10h"}
    six = next(c for c in q.calendars.values() if c.name == "6d x 10h")
    assert six.working_days == [0, 1, 2, 3, 4, 5] and six.hours_per_day == 10
    std = next(c for c in q.calendars.values() if c.name == "5d x 8h")
    assert std.exceptions.get(date(2026, 12, 25)) == 0.0
    assert {w.name for w in q.wbs} == {"Enabling", "Substructure", "Piling"}
    piling = next(w for w in q.wbs if w.name == "Piling")
    assert next(w for w in q.wbs if w.id == piling.parent_id).name == "Substructure"
    _assert_same(p, q)


def test_clndr_data_parse_real_shape():
    blob = ("(0||CalendarType()( 0||DaysOfWeek()( 0||1()( ) 0||2()( 0||0(s|08:00|f|12:00) 0||1(s|13:00|f|17:00) ) "
            "0||3()( 0||0(s|08:00|f|12:00) 0||1(s|13:00|f|17:00) ) 0||4()( 0||0(s|08:00|f|12:00) 0||1(s|13:00|f|17:00) ) "
            "0||5()( 0||0(s|08:00|f|12:00) 0||1(s|13:00|f|17:00) ) 0||6()( 0||0(s|08:00|f|12:00) 0||1(s|13:00|f|17:00) ) "
            "0||7()( ) ) 0||VIEW(ShowTotal|Y)() 0||Exceptions()( 0||0(d|46016)( ) 0||1(d|46017)( 0||0(s|08:00|f|12:00) ) ) ))")
    cal = parse_clndr_data(blob, Calendar(id="x"))
    assert cal.working_days == [0, 1, 2, 3, 4]
    assert cal.hours_per_day == 8
    assert cal.day_start.hour == 8
    assert cal.exceptions[date(2025, 12, 25)] == 0.0
    assert cal.exceptions[date(2025, 12, 26)] == 4.0
    again = parse_clndr_data(build_clndr_data(cal), Calendar(id="y"))
    assert again.working_days == cal.working_days and again.exceptions == cal.exceptions


def test_mspdi_roundtrip():
    p = sample()
    text = write_mspdi(p)
    assert "<PredecessorLink>" in text
    q = read_mspdi(text)
    assert q.name == "Demo build"
    assert {w.name for w in q.wbs} == {"Enabling", "Substructure", "Piling"}
    _assert_same(p, q, floats=False)  # MSPDI has no must-finish-by, so late dates differ


def test_mspdi_progress_survives():
    p = sample()
    a = p.activity("A1010")
    a.status, a.actual_start, a.percent_complete, a.remaining_hours = Status.IN_PROGRESS, datetime(2026, 1, 5, 8), 50, 20
    p.data_date = datetime(2026, 1, 8, 8)
    schedule(p)
    q = read_mspdi(write_mspdi(p))
    b = q.activity("A1010")
    assert b.status == Status.IN_PROGRESS and b.actual_start == a.actual_start and b.remaining_hours == 20
    q2 = read_xer(write_xer(p))
    c = q2.activity("A1010")
    assert c.status == Status.IN_PROGRESS and c.remaining_hours == 20

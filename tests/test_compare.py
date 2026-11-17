"""Programme comparison (planner.compare) on small hand-built programmes."""
from __future__ import annotations

from datetime import datetime

from planner.commands import parse_command
from planner.compare import compare, narrative
from planner.cpm import schedule
from planner.model import Constraint, LinkType, Project, Relationship, Status
from planner.plan import apply_patch
from tests.test_parity import BRIEFS, _act, _cal, _generated, _ln, _project

STD = _cal("standard")


def chain(**kw) -> Project:
    """S -> A (5d) -> B (10d) -> C (3d) -> Z, with a parallel D (4d) from S to Z. Starts Mon 2 Mar 2026."""
    acts = [_act("S", typ="start_milestone"), _act("A", 40), _act("B", 80), _act("C", 24), _act("D", 32), _act("Z", typ="finish_milestone")]
    links = [_ln("S", "A"), _ln("A", "B"), _ln("B", "C"), _ln("C", "Z"), _ln("S", "D"), _ln("D", "Z")]
    return Project.model_validate(_project("CMP", "2026-03-02T08:00:00", [STD], acts, links, **kw))


def edited(p: Project, fn) -> Project:
    q = p.model_copy(deep=True)
    fn(q)
    return q


def rel(p: Project, pred: str, succ: str, t: str = "FS") -> Relationship:
    return next(r for r in p.relationships if r.predecessor_id == pred and r.successor_id == succ and r.type.value == t)


def test_unchanged_programme_gives_unchanged_narrative():
    p = chain()
    r = compare(p, p)
    assert all(v == 0 for k, v in r["summary"]["counts"].items())
    assert r["summary"]["finish_shift_days"] == 0.0 and not r["summary"]["critical_path_changed"]
    assert r["finish_drivers"] == [] and r["date_moves"] == []
    text = narrative(r)
    assert "unchanged" in text and "Forecast completion remains 25 Mar 2026" in text
    assert "\n" not in text   # nothing else to say


def test_inputs_are_not_mutated_and_unscheduled_inputs_are_scheduled():
    old, new = chain(), edited(chain(), lambda q: setattr(q.activity("B"), "duration_hours", 120.0))
    before = (old.model_dump_json(), new.model_dump_json())
    assert old.activities[0].early_start is None
    r = compare(old, new)
    assert (old.model_dump_json(), new.model_dump_json()) == before
    assert r["summary"]["old_finish"] == "2026-03-25T16:00:00"
    assert r["summary"]["new_finish"] == "2026-04-01T16:00:00"
    assert r["summary"]["finish_shift_days"] == 5.0


def test_duration_change_on_the_longest_path_drives_the_finish():
    old = chain()
    new = edited(old, lambda q: setattr(q.activity("B"), "duration_hours", 160.0))   # 10d -> 20d
    r = compare(old, new)
    s = r["summary"]
    assert s["new_finish"] == "2026-04-10T16:00:00"   # 25 Mar + 10 working days, skipping Good Friday and Easter Monday
    assert s["finish_shift_days"] == 10.0
    assert r["duration_changes"] == [{"id": "B", "name": "Activity B", "old_days": 10.0, "new_days": 20.0, "delta_days": 10.0}]
    assert [d["id"] for d in r["finish_drivers"]] == ["B"]
    assert r["finish_drivers"][0]["changes"] == [{"kind": "duration", "old_days": 10.0, "new_days": 20.0, "delta_days": 10.0}]
    assert r["finish_drivers"][0]["finish_shift_days"] == 10.0
    assert s["finish_activity_id"] == "Z"
    # date moves sorted by |finish shift| then id: B, C and Z all finish 10 days later
    assert [m["id"] for m in r["date_moves"]][:3] == ["B", "C", "Z"]
    text = narrative(r)
    assert text.startswith("Forecast completion has moved later by 10 working days, from 25 Mar 2026 to 10 Apr 2026.")
    assert "driven by B Activity B (+10d duration)" in text


def test_renames_added_and_removed():
    old = chain()

    def fn(q: Project):
        q.activity("A").name = "Excavate"
        apply_patch(q, parse_command(q, "insert \"Scaffold inspection\" 1d after 'Activity C' before 'Activity Z'"))
        apply_patch(q, parse_command(q, "delete 'Activity D'"))
    new = edited(old, fn)
    r = compare(old, new)
    assert r["renamed"] == [{"id": "A", "old": "Activity A", "new": "Excavate"}]
    assert [x["id"] for x in r["added"]] == ["A10"]
    assert r["removed"] == [{"id": "D", "name": "Activity D"}]
    assert {(x["pred"], x["succ"]) for x in r["logic_added"]} == {("C", "A10"), ("A10", "Z"), ("S", "Z")}   # S->Z bridges the deleted D
    assert {(x["pred"], x["succ"]) for x in r["logic_removed"]} == {("C", "Z"), ("S", "D"), ("D", "Z")}
    drivers = {d["id"]: d for d in r["finish_drivers"]}
    assert drivers["A10"]["changes"][0] == {"kind": "added"} and drivers["A10"]["finish_shift_days"] is None
    text = narrative(r)
    assert "1 activity added (A10 Scaffold inspection)" in text and "1 activity removed (D Activity D)" in text
    assert "1 renamed (A)" in text


def test_lag_only_change_is_a_change_not_add_and_remove():
    old = chain()
    new = edited(old, lambda q: setattr(rel(q, "A", "B"), "lag_hours", 16.0))
    r = compare(old, new)
    assert r["logic_added"] == [] and r["logic_removed"] == []
    assert r["logic_changed"] == [{"pred": "A", "succ": "B", "old_type": "FS", "new_type": "FS", "old_lag_days": 0.0, "new_lag_days": 2.0}]
    assert r["summary"]["finish_shift_days"] == 2.0
    assert "B Activity B (link A→B now FS+2d, was FS)" in narrative(r)


def test_single_link_type_change_is_a_change():
    old = chain()
    new = edited(old, lambda q: setattr(rel(q, "A", "B"), "type", LinkType.SS))
    r = compare(old, new)
    assert r["logic_changed"] == [{"pred": "A", "succ": "B", "old_type": "FS", "new_type": "SS", "old_lag_days": 0.0, "new_lag_days": 0.0}]
    assert r["logic_added"] == [] and r["logic_removed"] == []


def test_duplicate_pair_links_are_keyed_by_type():
    old = chain()
    old.relationships.append(Relationship(predecessor_id="A", successor_id="B", type=LinkType.FF, lag_hours=8.0))

    # SS added beside the existing FS and FF: an addition, nothing changed
    r = compare(old, edited(old, lambda q: q.relationships.append(Relationship(predecessor_id="A", successor_id="B", type=LinkType.SS))))
    assert [(x["pred"], x["succ"], x["type"]) for x in r["logic_added"]] == [("A", "B", "SS")]
    assert r["logic_changed"] == [] and r["logic_removed"] == []

    # FF lag changed, FS untouched: only the FF is reported, as a change
    r = compare(old, edited(old, lambda q: setattr(rel(q, "A", "B", "FF"), "lag_hours", 24.0)))
    assert r["logic_changed"] == [{"pred": "A", "succ": "B", "old_type": "FF", "new_type": "FF", "old_lag_days": 1.0, "new_lag_days": 3.0}]
    assert r["logic_added"] == [] and r["logic_removed"] == []

    # FF removed, FS kept: a removal, not a type change
    r = compare(old, edited(old, lambda q: q.relationships.remove(rel(q, "A", "B", "FF"))))
    assert r["logic_removed"] == [{"pred": "A", "succ": "B", "type": "FF", "lag_days": 1.0}]
    assert r["logic_changed"] == [] and r["logic_added"] == []

    # both replaced by a single SS: two old links against one new, so removals plus an addition
    def swap(q: Project):
        q.relationships = [x for x in q.relationships if not (x.predecessor_id == "A" and x.successor_id == "B")]
        q.relationships.append(Relationship(predecessor_id="A", successor_id="B", type=LinkType.SS, lag_hours=8.0))
    r = compare(old, edited(old, swap))
    assert [x["type"] for x in r["logic_removed"]] == ["FS", "FF"]
    assert [x["type"] for x in r["logic_added"]] == ["SS"] and r["logic_changed"] == []


def test_progress_and_data_date():
    old = chain(data_date="2026-03-02T08:00:00")

    def fn(q: Project):
        a = q.activity("A")
        a.status, a.actual_start, a.actual_finish, a.percent_complete = Status.COMPLETE, datetime(2026, 3, 2, 8), datetime(2026, 3, 6, 16), 100.0
        b = q.activity("B")
        b.status, b.actual_start, b.percent_complete = Status.IN_PROGRESS, datetime(2026, 3, 9, 8), 25.0
        q.data_date = datetime(2026, 3, 16, 8)
    r = compare(old, edited(old, fn))
    pc = {x["id"]: x for x in r["progress_changes"]}
    assert set(pc) == {"A", "B"}
    assert pc["A"] == {"id": "A", "name": "Activity A", "old_status": "not_started", "new_status": "complete", "old_pct": 0.0, "new_pct": 100.0,
                       "old_actual_start": None, "new_actual_start": "2026-03-02T08:00:00",
                       "old_actual_finish": None, "new_actual_finish": "2026-03-06T16:00:00"}
    assert pc["B"]["new_status"] == "in_progress" and pc["B"]["new_pct"] == 25.0
    assert r["data_date"] == {"old": "2026-03-02T08:00:00", "new": "2026-03-16T08:00:00"}
    # B is 25% done by the data date a week after it started: 7.5d remain from 16 Mar, 2.5d later than planned
    assert r["summary"]["finish_shift_days"] == 2.5
    assert any(c["kind"] == "progress" for d in r["finish_drivers"] for c in d["changes"])
    text = narrative(r)
    assert "B Activity B (started, 25% complete)" in text
    assert "the data date moved from 2 Mar 2026 to 16 Mar 2026" in text
    assert "progress updated on 2 activities (A 100%, B 25%)" in text


def test_constraint_that_drives_the_finish_and_deadline():
    old = chain(must_finish_by="2026-04-10T16:00:00")

    def fn(q: Project):
        c = q.activity("C")
        c.constraint, c.constraint_date = Constraint.START_ON_OR_AFTER, datetime(2026, 4, 13, 8)
    r = compare(old, edited(old, fn))
    assert r["constraint_changes"] == [{"id": "C", "name": "Activity C", "old": {"type": "none", "date": None},
                                        "new": {"type": "start_on_or_after", "date": "2026-04-13T08:00:00"}}]
    s = r["summary"]
    assert s["new_finish"] == "2026-04-15T16:00:00"
    assert s["old_margin_days"] == 10.0 and s["new_margin_days"] == -3.0
    assert [d["id"] for d in r["finish_drivers"]] == ["C"]   # the constraint, not B, now sets C's start
    assert r["critical"] == {"joined": [], "left": ["S", "A", "B"]}   # C and Z stay critical, now hanging off the constraint
    text = narrative(r)
    assert "C Activity C (constraint now start on or after 13 Apr 2026)" in text
    assert "3 working days behind the required completion date of 10 Apr 2026, previously 10 working days ahead" in text
    assert "1 constraint changed (C)" in text


def test_finish_moving_with_nothing_changed_on_the_new_path_names_the_former_path():
    old = chain()
    # A, B and C cut to 1d each: the parallel D (4d) now drives Z, and nothing on S -> D -> Z changed
    new = edited(old, lambda q: [setattr(q.activity(x), "duration_hours", 8.0) for x in ("A", "B", "C")])
    r = compare(old, new)
    assert r["finish_drivers"] == []
    assert [d["id"] for d in r["former_path_changes"]] == ["A", "B", "C"]
    text = narrative(r)
    assert "No changed activity lies on the new longest path; the former longest path changed at A Activity A (-4d duration)" in text


def test_calendar_changes():
    old = chain()
    old.calendars["six_day"] = old.calendars["standard"].model_copy(update={"id": "six_day", "working_days": [0, 1, 2, 3, 4, 5]}, deep=True)

    def fn(q: Project):
        q.activity("B").calendar_id = "six_day"
        q.calendars["standard"].exceptions[datetime(2026, 3, 18).date()] = 0.0
        q.calendars["spare"] = q.calendars["standard"].model_copy(update={"id": "spare"}, deep=True)
    r = compare(old, edited(old, fn))
    cc = r["calendar_changes"]
    assert cc["activities"] == [{"id": "B", "name": "Activity B", "old": "standard", "new": "six_day"}]
    by = {c["calendar"]: c for c in cc["calendars"]}
    assert by["standard"]["fields"] == ["exceptions"] and by["standard"]["exceptions_added"] == ["2026-03-18"]
    assert by["spare"]["change"] == "added" and by["spare"]["used_by"] == 0
    text = narrative(r)
    assert "calendar changes (standard changed, B to six_day)" in text   # the unused 'spare' is not worth a mention


def test_generated_programme_narrative_is_short_and_deterministic():
    old = Project.model_validate(_generated(BRIEFS[1]))
    new = old.model_copy(deep=True)
    for cmd in ["add 2 weeks to A1100", "link A1090 -> A1110 SS+2d", "link A1100 -> A1110 FS+3d", "unlink A1010 A1020",
                "rename A1020 Topsoil strip and dig", "delete A1050", 'insert "Scaffold inspection" 1d after A1100 before A1110',
                "constrain A1110 start on or after 4 Aug 2026"]:
        apply_patch(new, parse_command(new, cmd))
    schedule(new)
    r1, r2 = compare(old, new), compare(old, new)
    assert r1 == r2 and narrative(r1) == narrative(r2)
    text = narrative(r1)
    assert len(text.split()) < 250
    assert text.startswith("Forecast completion has moved later by")
    assert "AI" not in text

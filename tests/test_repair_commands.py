import copy
from datetime import date, datetime

import pytest

from planner import Constraint, LinkType, Relationship, Status
from planner.commands import CommandError, parse_command
from planner.generator import Brief, generate
from planner.plan import apply_patch, draft_to_project, run_schedule
from planner.repair import plan_repairs


def project():
    p = draft_to_project(generate(Brief(name="House", building_type="house", storeys=2, start_date=date(2026, 3, 2), deadline=date(2026, 12, 18))))
    run_schedule(p)
    return p


def test_repair_closes_open_ends_leads_hard_constraints_and_splits():
    p = project()
    victim, victim2 = p.activities[5].id, p.activities[10].id
    p.relationships = [r for r in p.relationships if r.successor_id != victim and r.predecessor_id != victim2]
    p.relationships.append(Relationship(predecessor_id=p.activities[2].id, successor_id=p.activities[3].id, lag_hours=-16))
    p.activities[7].constraint, p.activities[7].constraint_date = Constraint.MUST_START_ON, datetime(2026, 5, 4, 8)
    p.activities[8].duration_hours = 8 * 100
    before = run_schedule(p)
    assert not before.failing() == []
    patch = plan_repairs(p, before)
    ops = {o.op for o in patch.ops}
    assert {"add_link", "set_constraint", "set_duration", "add_activity"} <= ops
    apply_patch(p, patch)
    after = run_schedule(p)
    byk = {c.key: c for c in after.checks}
    assert byk["logic"].passed and byk["leads"].passed and byk["hard_constraints"].passed and byk["high_duration"].passed
    assert after.score > before.score
    stages = [a for a in p.activities if a.id.startswith(p.activities[8].id)]
    assert len(stages) == 3 and all("stage" in a.name for a in stages)


def test_repair_explains_negative_float_instead_of_compressing():
    p = project()
    p.must_finish_by = datetime(2026, 6, 1, 16)
    rep = run_schedule(p)
    patch = plan_repairs(p, rep)
    assert any("Negative float" in s for s in patch.still_open)
    assert not any(o.op == "set_duration" for o in patch.ops)


def test_commands():
    p = project()
    a = next(x for x in p.activities if x.type == Status.NOT_STARTED.__class__ or True)  # any activity
    task = next(x for x in p.activities if x.duration_hours > 0)
    dur = p.calendar_for(task).hours_to_days(task.duration_hours)
    pt = parse_command(p, f"add 2 weeks to {task.id}")
    assert pt.ops[0].op == "set_duration" and pt.ops[0].duration_days == dur + 10
    pt = parse_command(p, f"shorten {task.id} by 1 day")
    assert pt.ops[0].duration_days == dur - 1
    pt = parse_command(p, f"set {task.id} to 3d")
    assert pt.ops[0].duration_days == 3
    b, c = p.activities[3].id, p.activities[4].id
    pt = parse_command(p, f"link {b} -> {c} SS+2d")
    assert pt.ops[0].op == "add_link" and pt.ops[0].link_type == "SS" and pt.ops[0].lag_days == 2
    pt = parse_command(p, f"unlink {b} {c}")
    assert all(o.op == "remove_link" for o in pt.ops)
    pt = parse_command(p, "finish by 1 Nov 2026")
    assert pt.ops[0].op == "set_must_finish_by" and pt.ops[0].date == "2026-11-01"
    pt = parse_command(p, "start 2026-05-04")
    assert pt.ops[0].op == "set_project_start" and pt.ops[0].date == "2026-05-04"
    pt = parse_command(p, f"progress {task.id} 50% as of 20 Apr 2026")
    assert [o.op for o in pt.ops] == ["note", "set_progress"] and pt.ops[1].percent_complete == 50
    pt = parse_command(p, f"complete {task.id} on 24/04/2026")
    assert pt.ops[0].actual_finish == "2026-04-24"
    pt = parse_command(p, f"constrain {task.id} start on or after 16 Mar 2026")
    assert pt.ops[0].constraint_type == "start_on_or_after" and pt.ops[0].date == "2026-03-16"
    pt = parse_command(p, f'insert "Scaffold lift" 3d after {b} before {c}')
    assert pt.ops[0].op == "add_activity" and pt.ops[0].duration_days == 3
    pt = parse_command(p, f"rename {task.id} to Something else")
    assert pt.ops[0].name == "Something else"
    assert parse_command(p, "fix").ops[0].reason == "__repair__"
    assert "link" in parse_command(p, "help").message
    # name matching
    pt = parse_command(p, 'add 1 day to "Practical completion"')
    assert pt.ops[0].activity_id == p.activities[-1].id
    with pytest.raises(CommandError):
        parse_command(p, "do something odd")
    with pytest.raises(CommandError):
        parse_command(p, "add 1 day to ZZZ9")


def test_commands_apply_end_to_end():
    p = project()
    task = next(x for x in p.activities if x.duration_hours > 0 and x.critical)
    finish_before = p.finish
    apply_patch(p, parse_command(p, f"add 2 weeks to {task.id}"))
    run_schedule(p)
    assert p.finish > finish_before

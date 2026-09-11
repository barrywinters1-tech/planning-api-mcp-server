"""Deterministic DCMA repairer: turns failing health checks into patch operations.

It only makes changes an experienced planner would make without asking:
close open ends, remove leads, soften hard constraints, split long activities,
close dangling logic. Negative float is reported with its cause, not "fixed",
because compressing scope is a decision, not a rule.
"""
from __future__ import annotations

from .dcma import HIGH_DURATION_DAYS, HealthReport
from .model import ActivityType, Constraint, HARD_CONSTRAINTS, LinkType, Project, Status
from .plan import Patch, PatchOp


def plan_repairs(project: Project, report: HealthReport) -> Patch:
    ops: list[PatchOp] = []
    notes: list[str] = []
    still_open: list[str] = []
    amap = project.activity_map()
    order = [a.id for a in project.activities]
    pos = {aid: i for i, aid in enumerate(order)}
    starts = [a for a in project.activities if a.type == ActivityType.START_MILESTONE]
    finishes = [a for a in project.activities if a.type == ActivityType.FINISH_MILESTONE]
    start_ms = starts[0].id if starts else None
    finish_ms = finishes[-1].id if finishes else None
    incomplete = [a for a in project.activities if a.status != Status.COMPLETE and a.type != ActivityType.LOE]

    # 0. make sure there is one start and one finish milestone to hang logic on
    if not start_ms and incomplete:
        start_ms = "A0000"
        ops.append(PatchOp(op="add_activity", activity_id=start_ms, name="Start", activity_type="start_milestone",
                           wbs_code=project.activities[0].wbs_id, reason="No start milestone existed"))
        notes.append("added a start milestone")
    if not finish_ms and incomplete:
        finish_ms = "A9999"
        ops.append(PatchOp(op="add_activity", activity_id=finish_ms, name="Finish", activity_type="finish_milestone",
                           wbs_code=project.activities[-1].wbs_id, reason="No finish milestone existed"))
        notes.append("added a finish milestone")

    # 1. missing logic: no predecessor -> previous activity in the same WBS, else start milestone; no successor -> finish milestone
    for a in incomplete:
        if a.id in (start_ms, finish_ms):
            continue
        if not project.predecessors_of(a.id) and a.type != ActivityType.START_MILESTONE:
            prev = None
            for cand in reversed(project.activities[:pos[a.id]]):
                if cand.wbs_id == a.wbs_id and cand.id != a.id and cand.type != ActivityType.LOE and not _reaches(project, a.id, cand.id):
                    prev = cand.id
                    break
            target = prev or start_ms
            if target and target != a.id:
                ops.append(PatchOp(op="add_link", predecessor_id=target, successor_id=a.id, link_type="FS",
                                   reason=f"{a.id} had no predecessor; linked from {'previous activity in its WBS' if prev else 'the start milestone'}"))
        if not project.successors_of(a.id) and a.type != ActivityType.FINISH_MILESTONE and finish_ms and finish_ms != a.id:
            ops.append(PatchOp(op="add_link", predecessor_id=a.id, successor_id=finish_ms, link_type="FS",
                               reason=f"{a.id} had no successor; linked to the finish milestone"))

    # 2. leads -> zero lag
    for r in project.relationships:
        if r.lag_hours < 0:
            ops.append(PatchOp(op="add_link", predecessor_id=r.predecessor_id, successor_id=r.successor_id, link_type=r.type.value,
                               lag_days=0, reason="Negative lag (lead) removed; DCMA does not allow leads"))

    # 3. hard constraints -> soft
    for a in incomplete:
        if a.constraint in HARD_CONSTRAINTS and a.constraint_date:
            soft = "start_on_or_after" if a.constraint == Constraint.MUST_START_ON else "finish_on_or_before"
            ops.append(PatchOp(op="set_constraint", activity_id=a.id, constraint_type=soft, date=a.constraint_date.strftime("%Y-%m-%d"),
                               reason=f"Hard constraint on {a.id} softened to {soft.replace('_', ' ')}"))

    # 4. dangling: SS-only successors get an FF to the same successor; FF-only predecessors get an SS from the same predecessor
    for a in incomplete:
        if a.is_milestone:
            continue
        outs = project.successors_of(a.id)
        if outs and all(r.type == LinkType.SS for r in outs):
            s = outs[0]
            ops.append(PatchOp(op="add_link", predecessor_id=a.id, successor_id=s.successor_id, link_type="FF", lag_days=0,
                               reason=f"{a.id} only drove {s.successor_id} by its start; added FF so its finish matters"))
        ins = project.predecessors_of(a.id)
        if ins and all(r.type == LinkType.FF for r in ins):
            p = ins[0]
            ops.append(PatchOp(op="add_link", predecessor_id=p.predecessor_id, successor_id=a.id, link_type="SS", lag_days=0,
                               reason=f"{a.id} was only driven on its finish; added SS from {p.predecessor_id}"))

    # 5. high duration -> split into equal stages (only for not-started activities)
    for a in incomplete:
        if a.is_milestone or a.status != Status.NOT_STARTED:
            continue
        cal = project.calendar_for(a)
        days = cal.hours_to_days(a.duration_hours)
        if days > HIGH_DURATION_DAYS:
            parts = int(-(-days // HIGH_DURATION_DAYS))
            per = round(days / parts, 1)
            prev = a.id
            ops.append(PatchOp(op="set_duration", activity_id=a.id, duration_days=per, reason=f"Split {a.id} ({days:.0f}d) into {parts} stages"))
            ops.append(PatchOp(op="rename", activity_id=a.id, name=f"{a.name} - stage 1"))
            succs = project.successors_of(a.id)
            for i in range(2, parts + 1):
                nid = f"{a.id}-{i}"
                ops.append(PatchOp(op="add_activity", activity_id=nid, name=f"{a.name} - stage {i}", duration_days=per, wbs_code=a.wbs_id,
                                   calendar=a.calendar_id if a.calendar_id in ("standard", "six_day", "seven_day") else None,
                                   predecessor_id=prev, link_type="FS", trade=None, reason="stage split"))
                prev = nid
            for s in succs:
                if s.type in (LinkType.FS, LinkType.FF):
                    ops.append(PatchOp(op="remove_link", predecessor_id=a.id, successor_id=s.successor_id, link_type=s.type.value))
                    ops.append(PatchOp(op="add_link", predecessor_id=prev, successor_id=s.successor_id, link_type=s.type.value,
                                       lag_days=cal.hours_to_days(s.lag_hours), reason="moved successor link to last stage"))

    # 6. negative float: explain, don't compress
    neg = [a for a in incomplete if a.total_float_hours is not None and a.total_float_hours < 0]
    if neg:
        worst = min(neg, key=lambda a: a.total_float_hours)
        cal = project.calendar_for(worst)
        cause = ("the must-finish-by date" if project.must_finish_by else "a finish constraint")
        constrained = [a for a in neg if a.constraint in (Constraint.FINISH_ON_OR_BEFORE, Constraint.MUST_FINISH_ON, Constraint.START_ON_OR_BEFORE)]
        if constrained:
            cause = f"the {constrained[0].constraint.value.replace('_', ' ')} constraint on {constrained[0].id}"
        still_open.append(f"Negative float of {cal.hours_to_days(worst.total_float_hours):.0f} days against {cause}. "
                          "Options: move the date, add resource to critical activities, or re-sequence. Use commands to try each.")

    # 7. high float / lags / resources: informational
    byk = {c.key: c for c in report.checks}
    if byk.get("high_float") and not byk["high_float"].passed:
        still_open.append("High float on " + ", ".join(byk["high_float"].items[:6]) + ": usually missing logic or a very early deadline; review after the links above are added.")
    if byk.get("lags") and not byk["lags"].passed:
        still_open.append("Positive lags exceed 5% of links. Replace the longest with a real activity (cure, drying, approval) if the client's reviewer is strict.")
    if byk.get("resources") and byk["resources"].applicable and not byk["resources"].passed:
        still_open.append("Some activities have no trade assigned; assign with the command 'assign <id> <trade>'.")

    n_links = sum(1 for o in ops if o.op == "add_link")
    msg = (f"Applied {len(ops)} repair operations ({n_links} links, {sum(1 for o in ops if o.op == 'set_constraint')} constraints softened, "
           f"{sum(1 for o in ops if o.op == 'add_activity')} activities added)." if ops else "Nothing to repair automatically.")
    if notes:
        msg += " " + "; ".join(notes) + "."
    return Patch(ops=ops, message=msg, still_open=still_open)


def _reaches(project: Project, src: str, dst: str) -> bool:
    """True if dst is downstream of src (adding dst -> src would create a loop)."""
    seen, stack = set(), [src]
    while stack:
        n = stack.pop()
        if n == dst:
            return True
        if n in seen:
            continue
        seen.add(n)
        stack.extend(r.successor_id for r in project.successors_of(n))
    return False

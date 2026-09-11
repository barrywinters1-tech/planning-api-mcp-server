"""The AI planner: description -> draft plan -> scheduled project -> self-review -> patched project.

Everything the model produces is a structured object (a DraftPlan or a Patch).
Applying it to the schedule is deterministic code, so the CPM engine, not the
model, decides the dates.
"""
from __future__ import annotations

import json
import os
import re
from datetime import date, datetime, time, timedelta
from typing import Literal, Optional

import anthropic
from pydantic import BaseModel, Field

from .cpm import ScheduleError, schedule
from .dcma import HealthReport, health_check
from .model import (Activity, ActivityType, Assignment, Calendar, Constraint, LinkType, Project,
                    Relationship, Resource, Status, WBSNode)

MODEL = os.environ.get("PLANNER_MODEL", "claude-opus-5")
FALLBACK_BETA = "server-side-fallback-2026-07-01"

# ------------------------------------------------------------------------------------
# structured shapes the model fills in
# ------------------------------------------------------------------------------------
class PlanLink(BaseModel):
    predecessor_id: str
    type: Literal["FS", "SS", "FF", "SF"] = "FS"
    lag_days: float = 0


class PlanActivity(BaseModel):
    id: str = Field(description="Short unique code, e.g. A1010. Increment by 10.")
    name: str
    wbs_code: str = Field(description="Code of the WBS node this sits under, e.g. '2.1'")
    type: Literal["task", "start_milestone", "finish_milestone"] = "task"
    duration_days: float = Field(description="Working days. 0 for milestones.")
    calendar: Literal["standard", "six_day", "seven_day"] = "standard"
    predecessors: list[PlanLink] = Field(default_factory=list)
    trade: str = Field(default="", description="Gang / trade / resource responsible, e.g. 'Groundworks gang'")
    crew_size: float = Field(default=0, description="People on the gang, 0 if unknown")
    rationale: str = Field(default="", description="One line on why this duration and logic")


class PlanWBS(BaseModel):
    code: str = Field(description="Hierarchical code, e.g. '1', '1.2'")
    name: str
    parent_code: Optional[str] = None


class PlanConstraint(BaseModel):
    activity_id: str
    type: Literal["start_on_or_after", "finish_on_or_before", "must_finish_on", "must_start_on"]
    date: str = Field(description="YYYY-MM-DD")
    reason: str = ""


class DraftPlan(BaseModel):
    project_id: str = Field(description="Short code, letters/digits/hyphens, max 12 chars")
    project_name: str
    start_date: str = Field(description="YYYY-MM-DD; a Monday unless the client fixed a date")
    must_finish_by: Optional[str] = Field(default=None, description="YYYY-MM-DD if the brief gives a deadline")
    wbs: list[PlanWBS]
    activities: list[PlanActivity]
    constraints: list[PlanConstraint] = Field(default_factory=list)
    assumptions: list[str] = Field(description="Every assumption you made because the brief was silent")
    questions_for_client: list[str] = Field(description="Things a planner would ask before issuing this")
    summary: str = Field(description="Three or four sentences a client would read")


class PatchOp(BaseModel):
    op: Literal["add_activity", "remove_activity", "rename", "set_duration", "set_type", "set_calendar",
                "add_link", "remove_link", "set_constraint", "clear_constraint", "set_progress",
                "set_project_start", "set_must_finish_by", "add_wbs", "move_to_wbs", "note"]
    activity_id: Optional[str] = None
    predecessor_id: Optional[str] = None
    successor_id: Optional[str] = None
    link_type: Optional[Literal["FS", "SS", "FF", "SF"]] = None
    lag_days: Optional[float] = None
    name: Optional[str] = None
    duration_days: Optional[float] = None
    activity_type: Optional[Literal["task", "start_milestone", "finish_milestone"]] = None
    calendar: Optional[Literal["standard", "six_day", "seven_day"]] = None
    wbs_code: Optional[str] = None
    parent_wbs_code: Optional[str] = None
    constraint_type: Optional[Literal["start_on_or_after", "start_on_or_before", "finish_on_or_after",
                                      "finish_on_or_before", "must_start_on", "must_finish_on",
                                      "as_late_as_possible"]] = None
    date: Optional[str] = Field(default=None, description="YYYY-MM-DD")
    percent_complete: Optional[float] = None
    remaining_days: Optional[float] = None
    actual_start: Optional[str] = None
    actual_finish: Optional[str] = None
    trade: Optional[str] = None
    reason: str = Field(default="", description="Why this change")


class Patch(BaseModel):
    ops: list[PatchOp]
    message: str = Field(description="Plain-English reply to the person, two to five sentences")
    still_open: list[str] = Field(default_factory=list, description="Problems you chose not to fix and why")


# ------------------------------------------------------------------------------------
# prompts
# ------------------------------------------------------------------------------------
PLANNER_SYSTEM = """You are a senior construction planner with twenty years on UK building and civils projects, fluent in Primavera P6 and Asta Powerproject. You produce tender and construction programmes that survive a DCMA 14-point check and a client review.

How you plan:
- Read the brief. Where it is silent, make the assumption an experienced planner would make and record it. Never invent client decisions; record those as questions.
- Structure the work breakdown by phase then by element (enabling works, substructure, superstructure/frame, envelope, fit-out, MEP, external works, commissioning, handover). Two or three levels, no more.
- One start milestone at the top, one finish milestone at the bottom. Every other activity has at least one predecessor and one successor. No open ends, no dangling logic.
- Prefer finish-to-start links. Use start-to-start with lag for trades that follow each other floor-by-floor or zone-by-zone. Never use negative lag. Keep positive lags rare and short.
- Durations in working days. Size them from realistic gang outputs and quantities. Split anything longer than about 40 working days into stages or zones so progress can be measured.
- Include the boring but real items: mobilisation, temporary works, inspections and approvals, curing and drying times (model these as lag or as a zero-resource activity), commissioning, snagging, client handover.
- Respect sequencing physics: you cannot build the frame before the foundations, cannot close the envelope before the frame, cannot commission before power-on, cannot fit ceilings before first-fix services above them.
- Use constraints sparingly and only for genuine external dates (planning conditions, possession, statutory connections, client deadline). Prefer soft constraints (start-on-or-after, finish-on-or-before) over must-start/finish.
- Calendars: 'standard' is Monday to Friday 8h. Use 'six_day' only for trades the brief says work Saturdays. 'seven_day' only for curing or continuous processes.
- Activity ids: A1000, A1010, A1020 ... in order.
- British English. Concise names a site manager would recognise ("Excavate pile caps", not "Perform excavation of pile cap areas").
"""

REVIEWER_SYSTEM = """You are the same senior planner, now reviewing a schedule that has been run through a critical-path engine and a DCMA 14-point check. Your job is to fix what is wrong with the fewest, safest changes, expressed as patch operations.

Rules:
- Fix every failing check you can with logic, duration or constraint changes. Do not delete scope to make a check pass.
- Missing logic: add the FS link an experienced planner would add. Dangling SS-only or FF-only activities need a matching finish or start link.
- Negative float: first remove or soften the constraint that causes it; only then compress durations, and say so.
- High duration: split into stages (add_activity + links) or accept it with a reason in still_open if it is genuinely one continuous process.
- Do not add lags to hide missing logic. Do not use negative lags.
- If the person's instruction is the reason for the change (e.g. "add two weeks to piling"), do exactly that and report the effect.
- Keep ids stable. New activities continue the A#### sequence.
- Everything you leave alone goes in still_open with a one-line reason.
"""


# ------------------------------------------------------------------------------------
# helpers
# ------------------------------------------------------------------------------------
def _client() -> anthropic.Anthropic:
    return anthropic.Anthropic(timeout=900.0, max_retries=2)


def _parse_date(s: Optional[str], hour: int = 8) -> Optional[datetime]:
    if not s:
        return None
    for fmt in ("%Y-%m-%d", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%d %H:%M", "%d/%m/%Y"):
        try:
            d = datetime.strptime(s.strip(), fmt)
            return d if d.hour or d.minute else d.replace(hour=hour)
        except ValueError:
            continue
    return None


def _structured(system: str, user: str, output_format: type[BaseModel], effort: str = "high",
                max_tokens: int = 64000, on_text=None) -> BaseModel:
    client = _client()
    with client.beta.messages.stream(
        model=MODEL,
        max_tokens=max_tokens,
        system=[{"type": "text", "text": system, "cache_control": {"type": "ephemeral"}}],
        messages=[{"role": "user", "content": user}],
        output_format=output_format,
        output_config={"effort": effort},
        betas=[FALLBACK_BETA],
        fallbacks="default",
    ) as stream:
        for text in stream.text_stream:
            if on_text:
                on_text(text)
        msg = stream.get_final_message()
    if msg.stop_reason == "refusal":
        cat = getattr(getattr(msg, "stop_details", None), "category", None)
        raise RuntimeError(f"The model declined this request ({cat}).")
    for block in msg.content:
        if block.type == "text":
            parsed = getattr(block, "parsed_output", None)
            if parsed is not None:
                return parsed
            return output_format.model_validate(json.loads(block.text))
    raise RuntimeError("No text block in the model's response")


STANDARD_CALENDARS = {
    "standard": dict(name="Standard 5d x 8h", hours_per_day=8, working_days=[0, 1, 2, 3, 4]),
    "six_day": dict(name="Six day 8h", hours_per_day=8, working_days=[0, 1, 2, 3, 4, 5]),
    "seven_day": dict(name="Seven day (continuous)", hours_per_day=8, working_days=[0, 1, 2, 3, 4, 5, 6]),
}

UK_BANK_HOLIDAYS_2026_27 = [
    date(2026, 1, 1), date(2026, 4, 3), date(2026, 4, 6), date(2026, 5, 4), date(2026, 5, 25), date(2026, 8, 31),
    date(2026, 12, 25), date(2026, 12, 28), date(2027, 1, 1), date(2027, 3, 26), date(2027, 3, 29), date(2027, 5, 3),
    date(2027, 5, 31), date(2027, 8, 30), date(2027, 12, 27), date(2027, 12, 28),
]


def _ensure_calendars(project: Project) -> None:
    for key, spec in STANDARD_CALENDARS.items():
        if key not in project.calendars:
            cal = Calendar(id=key, **spec)
            if key != "seven_day":
                cal.exceptions = {d: 0.0 for d in UK_BANK_HOLIDAYS_2026_27}
            project.calendars[key] = cal
    project.default_calendar_id = "standard"


# ------------------------------------------------------------------------------------
# draft -> project
# ------------------------------------------------------------------------------------
def draft_to_project(draft: DraftPlan, description: str = "") -> Project:
    start = _parse_date(draft.start_date) or datetime.combine(date.today() + timedelta(days=(7 - date.today().weekday()) % 7 or 7), time(8))
    pid = re.sub(r"[^A-Za-z0-9-]+", "-", draft.project_id).strip("-")[:12] or "PROJ"
    project = Project(id=pid, name=draft.project_name, start=start, data_date=start,
                      must_finish_by=_parse_date(draft.must_finish_by, hour=16), description=description,
                      assumptions=list(draft.assumptions))
    _ensure_calendars(project)
    for i, w in enumerate(draft.wbs):
        project.wbs.append(WBSNode(id=w.code, code=w.code, name=w.name, parent_id=w.parent_code or None, seq=i))
    known_wbs = {w.id for w in project.wbs}
    trades: dict[str, Resource] = {}
    for a in draft.activities:
        cal = project.calendars[a.calendar]
        act = Activity(id=a.id.strip(), name=a.name.strip(), wbs_id=a.wbs_code if a.wbs_code in known_wbs else None,
                       calendar_id=a.calendar, type=ActivityType(a.type),
                       duration_hours=0.0 if a.type != "task" else cal.days_to_hours(max(0.0, a.duration_days)),
                       notes=a.rationale)
        project.activities.append(act)
        if a.trade:
            rid = re.sub(r"[^A-Za-z0-9]+", "_", a.trade).strip("_").upper()[:20]
            if rid not in trades:
                trades[rid] = Resource(id=rid, name=a.trade, type="labour")
            project.assignments.append(Assignment(activity_id=act.id, resource_id=rid,
                                                  units=act.duration_hours * (a.crew_size or 1)))
    project.resources = list(trades.values())
    ids = {a.id for a in project.activities}
    for a in draft.activities:
        pcal = project.calendars[a.calendar]
        for l in a.predecessors:
            if l.predecessor_id in ids and l.predecessor_id != a.id:
                project.relationships.append(Relationship(predecessor_id=l.predecessor_id, successor_id=a.id,
                                                          type=LinkType(l.type), lag_hours=pcal.days_to_hours(l.lag_days)))
    for c in draft.constraints:
        if c.activity_id in ids:
            act = project.activity(c.activity_id)
            act.constraint = Constraint(c.type)
            act.constraint_date = _parse_date(c.date, hour=16 if "finish" in c.type else 8)
            if c.reason:
                act.notes = (act.notes + " | " if act.notes else "") + f"Constraint: {c.reason}"
    _dedupe_links(project)
    return project


def _dedupe_links(project: Project) -> None:
    seen, out = set(), []
    for r in project.relationships:
        k = (r.predecessor_id, r.successor_id, r.type)
        if k not in seen:
            seen.add(k)
            out.append(r)
    project.relationships = out


# ------------------------------------------------------------------------------------
# patches
# ------------------------------------------------------------------------------------
def apply_patch(project: Project, patch: Patch) -> list[str]:
    """Apply ops in order. Returns a log line per op (applied or why not)."""
    _ensure_calendars(project)
    log: list[str] = []
    amap = project.activity_map()

    def cal_for(a: Activity) -> Calendar:
        return project.calendar_for(a)

    for op in patch.ops:
        try:
            if op.op == "add_activity":
                if not op.activity_id or op.activity_id in amap:
                    raise ValueError("needs a new unique activity_id")
                calkey = op.calendar or "standard"
                atype = ActivityType(op.activity_type or "task")
                a = Activity(id=op.activity_id, name=op.name or op.activity_id, calendar_id=calkey, type=atype,
                             wbs_id=op.wbs_code if any(w.id == op.wbs_code for w in project.wbs) else None,
                             duration_hours=0.0 if atype != ActivityType.TASK else project.calendars[calkey].days_to_hours(op.duration_days or 0),
                             notes=op.reason)
                project.activities.append(a)
                amap[a.id] = a
                if op.trade:
                    rid = re.sub(r"[^A-Za-z0-9]+", "_", op.trade).strip("_").upper()[:20]
                    if not any(r.id == rid for r in project.resources):
                        project.resources.append(Resource(id=rid, name=op.trade))
                    project.assignments.append(Assignment(activity_id=a.id, resource_id=rid, units=a.duration_hours))
                if op.predecessor_id and op.predecessor_id in amap:
                    project.relationships.append(Relationship(predecessor_id=op.predecessor_id, successor_id=a.id,
                                                              type=LinkType(op.link_type or "FS"),
                                                              lag_hours=cal_for(amap[op.predecessor_id]).days_to_hours(op.lag_days or 0)))
                if op.successor_id and op.successor_id in amap:
                    project.relationships.append(Relationship(predecessor_id=a.id, successor_id=op.successor_id))
                log.append(f"added {a.id} {a.name}")
            elif op.op == "remove_activity":
                a = amap.pop(op.activity_id)
                preds = project.predecessors_of(a.id)
                succs = project.successors_of(a.id)
                project.activities.remove(a)
                project.relationships = [r for r in project.relationships if a.id not in (r.predecessor_id, r.successor_id)]
                project.assignments = [x for x in project.assignments if x.activity_id != a.id]
                # bridge the gap so logic stays closed
                for p in preds:
                    for s in succs:
                        if p.type == LinkType.FS and s.type == LinkType.FS:
                            project.relationships.append(Relationship(predecessor_id=p.predecessor_id, successor_id=s.successor_id))
                log.append(f"removed {a.id} and bridged {len(preds)}x{len(succs)} links")
            elif op.op == "rename":
                amap[op.activity_id].name = op.name or amap[op.activity_id].name
                log.append(f"renamed {op.activity_id}")
            elif op.op == "set_duration":
                a = amap[op.activity_id]
                a.duration_hours = cal_for(a).days_to_hours(max(0.0, op.duration_days or 0))
                if a.status == Status.IN_PROGRESS and op.remaining_days is not None:
                    a.remaining_hours = cal_for(a).days_to_hours(op.remaining_days)
                elif a.status == Status.IN_PROGRESS:
                    a.remaining_hours = max(0.0, a.duration_hours * (1 - a.percent_complete / 100))
                log.append(f"{a.id} duration -> {op.duration_days}d")
            elif op.op == "set_type":
                a = amap[op.activity_id]
                a.type = ActivityType(op.activity_type or "task")
                if a.type != ActivityType.TASK:
                    a.duration_hours = 0.0
                log.append(f"{a.id} type -> {a.type.value}")
            elif op.op == "set_calendar":
                a = amap[op.activity_id]
                old = cal_for(a)
                a.calendar_id = op.calendar or "standard"
                a.duration_hours = cal_for(a).days_to_hours(old.hours_to_days(a.duration_hours))
                log.append(f"{a.id} calendar -> {a.calendar_id}")
            elif op.op == "add_link":
                if op.predecessor_id not in amap or op.successor_id not in amap:
                    raise ValueError("unknown activity in link")
                if op.predecessor_id == op.successor_id:
                    raise ValueError("cannot link an activity to itself")
                lt = LinkType(op.link_type or "FS")
                project.relationships = [r for r in project.relationships
                                         if not (r.predecessor_id == op.predecessor_id and r.successor_id == op.successor_id and r.type == lt)]
                project.relationships.append(Relationship(predecessor_id=op.predecessor_id, successor_id=op.successor_id, type=lt,
                                                          lag_hours=cal_for(amap[op.predecessor_id]).days_to_hours(op.lag_days or 0)))
                log.append(f"linked {op.predecessor_id} -{lt.value}{('+' + str(op.lag_days) + 'd') if op.lag_days else ''}-> {op.successor_id}")
            elif op.op == "remove_link":
                before = len(project.relationships)
                project.relationships = [r for r in project.relationships
                                         if not (r.predecessor_id == op.predecessor_id and r.successor_id == op.successor_id
                                                 and (op.link_type is None or r.type == LinkType(op.link_type)))]
                log.append(f"removed {before - len(project.relationships)} link(s) {op.predecessor_id}->{op.successor_id}")
            elif op.op == "set_constraint":
                a = amap[op.activity_id]
                a.constraint = Constraint(op.constraint_type or "start_on_or_after")
                a.constraint_date = _parse_date(op.date, hour=16 if "finish" in a.constraint.value else 8)
                log.append(f"{a.id} constraint -> {a.constraint.value} {op.date}")
            elif op.op == "clear_constraint":
                a = amap[op.activity_id]
                a.constraint, a.constraint_date = Constraint.NONE, None
                log.append(f"{a.id} constraint cleared")
            elif op.op == "set_progress":
                a = amap[op.activity_id]
                if op.actual_start:
                    a.actual_start = _parse_date(op.actual_start)
                if op.actual_finish:
                    a.actual_finish = _parse_date(op.actual_finish, hour=16)
                    a.status, a.percent_complete, a.remaining_hours = Status.COMPLETE, 100.0, 0.0
                elif op.percent_complete is not None or op.remaining_days is not None or a.actual_start:
                    a.status = Status.IN_PROGRESS
                    if op.percent_complete is not None:
                        a.percent_complete = op.percent_complete
                    if op.remaining_days is not None:
                        a.remaining_hours = cal_for(a).days_to_hours(op.remaining_days)
                    else:
                        a.remaining_hours = max(0.0, a.duration_hours * (1 - a.percent_complete / 100))
                    if a.actual_start is None:
                        a.actual_start = project.data_date or project.start
                log.append(f"{a.id} progress -> {a.status.value} {a.percent_complete}%")
            elif op.op == "set_project_start":
                project.start = _parse_date(op.date) or project.start
                if project.data_date and project.data_date < project.start:
                    project.data_date = project.start
                log.append(f"project start -> {op.date}")
            elif op.op == "set_must_finish_by":
                project.must_finish_by = _parse_date(op.date, hour=16)
                log.append(f"must finish by -> {op.date}")
            elif op.op == "add_wbs":
                if op.wbs_code and not any(w.id == op.wbs_code for w in project.wbs):
                    project.wbs.append(WBSNode(id=op.wbs_code, code=op.wbs_code, name=op.name or op.wbs_code,
                                               parent_id=op.parent_wbs_code, seq=len(project.wbs)))
                log.append(f"added WBS {op.wbs_code}")
            elif op.op == "move_to_wbs":
                amap[op.activity_id].wbs_id = op.wbs_code
                log.append(f"{op.activity_id} -> WBS {op.wbs_code}")
            elif op.op == "note":
                if op.activity_id and op.activity_id in amap:
                    a = amap[op.activity_id]
                    a.notes = (a.notes + " | " if a.notes else "") + op.reason
                else:
                    project.assumptions.append(op.reason)
                log.append("noted")
        except (KeyError, ValueError) as e:
            log.append(f"skipped {op.op} {op.activity_id or ''}: {e}")
    _dedupe_links(project)
    return log


# ------------------------------------------------------------------------------------
# schedule summaries the model reads
# ------------------------------------------------------------------------------------
def schedule_digest(project: Project, report: Optional[HealthReport] = None, max_rows: int = 400) -> str:
    lines = [f"Project {project.id} '{project.name}' start {project.start:%Y-%m-%d} data date {(project.data_date or project.start):%Y-%m-%d}"
             + (f" must finish by {project.must_finish_by:%Y-%m-%d}" if project.must_finish_by else "")
             + (f" scheduled finish {project.finish:%Y-%m-%d}" if project.finish else "")]
    if project.wbs:
        lines.append("WBS: " + "; ".join(f"{w.id} {w.name}" + (f" (under {w.parent_id})" if w.parent_id else "") for w in project.wbs))
    lines.append("id | name | wbs | type | dur(d) | cal | ES | EF | TF(d) | status | preds | constraint")
    for a in project.activities[:max_rows]:
        cal = project.calendar_for(a)
        preds = ", ".join(f"{r.predecessor_id}{r.type.value}{'+' + str(round(cal.hours_to_days(r.lag_hours), 1)) + 'd' if r.lag_hours else ''}"
                          for r in project.predecessors_of(a.id))
        tf = "" if a.total_float_hours is None else str(round(cal.hours_to_days(a.total_float_hours), 1))
        cstr = f"{a.constraint.value} {a.constraint_date:%Y-%m-%d}" if a.constraint != Constraint.NONE and a.constraint_date else ""
        lines.append(" | ".join([a.id, a.name, a.wbs_id or "", a.type.value, str(round(cal.hours_to_days(a.duration_hours), 1)),
                                 a.calendar_id or project.default_calendar_id,
                                 a.early_start.strftime("%Y-%m-%d") if a.early_start else "",
                                 a.early_finish.strftime("%Y-%m-%d") if a.early_finish else "", tf, a.status.value, preds, cstr]))
    if len(project.activities) > max_rows:
        lines.append(f"... {len(project.activities) - max_rows} more activities")
    if report:
        lines.append("")
        lines.append(f"Health score {report.score}/100. {report.summary}")
        for c in report.checks:
            if c.applicable and not c.passed:
                lines.append(f"FAIL {c.key}: {c.detail} Items: {', '.join(c.items[:40])}")
    return "\n".join(lines)


# ------------------------------------------------------------------------------------
# public entry points
# ------------------------------------------------------------------------------------
class PlanResult(BaseModel):
    project: Project
    report: HealthReport
    draft: Optional[DraftPlan] = None
    review: Optional[Patch] = None
    log: list[str] = Field(default_factory=list)


def run_schedule(project: Project) -> HealthReport:
    schedule(project)
    return health_check(project)


def plan_from_description(description: str, today: Optional[date] = None, review: bool = True,
                          effort: str = "high", on_text=None) -> PlanResult:
    today = today or date.today()
    user = (f"Today is {today:%A %d %B %Y}.\n\nClient brief:\n\"\"\"\n{description.strip()}\n\"\"\"\n\n"
            "Produce the full programme as a DraftPlan. Be complete: a tender programme for this brief would normally "
            "have between 40 and 150 activities depending on scale. Every activity except the start milestone needs "
            "at least one predecessor; every activity except the finish milestone needs at least one successor.")
    draft = _structured(PLANNER_SYSTEM, user, DraftPlan, effort=effort, on_text=on_text)
    project = draft_to_project(draft, description)
    log: list[str] = [f"draft: {len(project.activities)} activities, {len(project.relationships)} links"]
    try:
        report = run_schedule(project)
    except ScheduleError as e:
        log.append(f"schedule error: {e}")
        patch = review_project(project, None, f"The schedule failed to calculate: {e}. Fix the logic loop.", effort=effort)
        log += apply_patch(project, patch)
        report = run_schedule(project)
    patch = None
    if review and report.failing():
        patch = review_project(project, report, effort=effort)
        log += apply_patch(project, patch)
        try:
            report = run_schedule(project)
        except ScheduleError as e:
            log.append(f"review introduced a loop: {e}; reverting review")
            project = draft_to_project(draft, description)
            report = run_schedule(project)
    return PlanResult(project=project, report=report, draft=draft, review=patch, log=log)


def review_project(project: Project, report: Optional[HealthReport], instruction: str = "", effort: str = "high") -> Patch:
    digest = schedule_digest(project, report)
    ask = instruction or "Review the failing checks and return the patch that fixes them."
    user = f"Current schedule:\n\n{digest}\n\nInstruction: {ask}\n\nReturn a Patch."
    return _structured(REVIEWER_SYSTEM, user, Patch, effort=effort, max_tokens=32000)


def edit_with_instruction(project: Project, instruction: str, effort: str = "high") -> tuple[Patch, list[str], HealthReport]:
    """Natural-language change request -> patch -> rescheduled project."""
    try:
        report = run_schedule(project)
    except ScheduleError:
        report = None
    patch = review_project(project, report, instruction=instruction, effort=effort)
    log = apply_patch(project, patch)
    report = run_schedule(project)
    return patch, log, report

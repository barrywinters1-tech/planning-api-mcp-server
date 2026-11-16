"""LLM agent that plans and edits construction programmes by driving the deterministic engine.

The model never computes dates or invents a schedule. It calls tools — generate a
programme from a brief, run a command, apply structured edits, read the schedule,
repair, level, baseline — and the pure-code engine does the work. This is the only
place the product talks to an AI service, and it runs server-side with the operator's
own ANTHROPIC_API_KEY. Everything else (the generator, CPM, DCMA, exports) is AI-free.

Run requirements: `pip install anthropic` and ANTHROPIC_API_KEY set on the server.
Model defaults to claude-opus-5; override with PLANNER_MODEL.
"""
from __future__ import annotations

import json
import os
from typing import Any, Callable, Optional

from .cpm import ScheduleError, schedule
from .dcma import health_check
from .commands import CommandError, execute as run_command_text
from .generator import generate, parse_brief
from .levelling import level, set_baseline
from .model import Project
from .plan import Patch, PatchOp, apply_patch, draft_to_project, schedule_digest
from .repair import plan_repairs

MODEL = os.environ.get("PLANNER_MODEL", "claude-opus-5")
MAX_STEPS = 20

SYSTEM = """You are an expert construction planner embedded in a scheduling tool. You help the user build and change a Primavera-P6-grade programme by calling tools; the tool engine computes every date with the critical path method, so you never guess dates or durations yourself.

How you work:
- To start a programme from a description, call generate_programme with a plain-English brief. It builds the WBS, activities, logic, durations (from production rates) and milestones, then schedules and health-checks it.
- To change a programme, prefer run_command with one plain instruction at a time: "add 2 weeks to Piling", "link A1010 -> A1020 SS+2d", "finish by 1 Nov 2026", "progress A1010 50% as of 20 Apr 2026", "constrain A1100 start on or after 16 Mar 2026", "assign A1020 Piling gang", "set A1240 to 15d", "rename A1010 ...", "delete A1045". Call run_command once per change.
- Use apply_edits for several structured changes at once, or edits a command cannot express.
- Call get_schedule to see the current activities, dates, float and failing checks before you answer questions about the plan or decide what to change. Call health_check for just the DCMA result.
- Call repair to auto-fix failing DCMA checks (open ends, leads, hard constraints, over-long activities). Call level_resources to delay activities so no trade exceeds its crew limit. Call set_baseline to snapshot the current dates.
- After making changes, tell the user plainly what changed and the new finish date and health score. Keep replies short. Ask a clarifying question only when you genuinely cannot proceed; otherwise make the sensible planner's assumption and say what you assumed.
- British English. Durations and lags are in working days. Activity ids look like A1010."""


# ------------------------------------------------------------------------------------
# tool definitions
# ------------------------------------------------------------------------------------
TOOLS: list[dict] = [
    {"name": "generate_programme", "description": "Build a complete new programme from a plain-English brief (type, size, structure, dates, site conditions). Replaces the current project. Returns a summary, finish date and health.",
     "input_schema": {"type": "object", "properties": {"brief": {"type": "string", "description": "The project description, e.g. '24-unit three-storey apartment block, RC frame on piles, brick, start 6 April 2026, finish before Christmas 2027'."}}, "required": ["brief"]}},
    {"name": "get_schedule", "description": "Read the current programme: activities with dates, float and the critical path, plus any failing DCMA checks. Call before answering questions about the plan.",
     "input_schema": {"type": "object", "properties": {}}},
    {"name": "health_check", "description": "Run the DCMA 14-point check and return the score and failing checks.",
     "input_schema": {"type": "object", "properties": {}}},
    {"name": "run_command", "description": "Apply one scheduling instruction in plain English (the command language). One change per call.",
     "input_schema": {"type": "object", "properties": {"command": {"type": "string", "description": "e.g. 'add 2 weeks to Piling', 'finish by 1 Nov 2026', 'link A1010 -> A1020 SS+2d', 'progress A1010 50% as of 20 Apr 2026', 'fix'."}}, "required": ["command"]}},
    {"name": "apply_edits", "description": "Apply several structured edit operations at once. Each op is one of: add_activity, remove_activity, rename, set_duration, set_type, set_calendar, add_link, remove_link, set_constraint, clear_constraint, set_progress, set_project_start, set_must_finish_by, add_wbs, move_to_wbs, note.",
     "input_schema": {"type": "object", "properties": {"ops": {"type": "array", "items": {"type": "object", "properties": {
         "op": {"type": "string"}, "activity_id": {"type": "string"}, "predecessor_id": {"type": "string"}, "successor_id": {"type": "string"},
         "link_type": {"type": "string", "enum": ["FS", "SS", "FF", "SF"]}, "lag_days": {"type": "number"}, "name": {"type": "string"},
         "duration_days": {"type": "number"}, "activity_type": {"type": "string", "enum": ["task", "start_milestone", "finish_milestone"]},
         "calendar": {"type": "string", "enum": ["standard", "six_day", "seven_day"]}, "wbs_code": {"type": "string"}, "parent_wbs_code": {"type": "string"},
         "constraint_type": {"type": "string"}, "date": {"type": "string", "description": "YYYY-MM-DD"}, "percent_complete": {"type": "number"},
         "remaining_days": {"type": "number"}, "actual_start": {"type": "string"}, "actual_finish": {"type": "string"}, "trade": {"type": "string"}, "reason": {"type": "string"}},
         "required": ["op"]}}}, "required": ["ops"]}},
    {"name": "repair", "description": "Run the deterministic DCMA repairer: close open ends, remove leads, soften hard constraints, split over-long activities. Reports what it will not decide for you.",
     "input_schema": {"type": "object", "properties": {}}},
    {"name": "level_resources", "description": "Delay not-started activities so no resource exceeds its crew limit per day. Returns how many moved and the new finish.",
     "input_schema": {"type": "object", "properties": {}}},
    {"name": "set_baseline", "description": "Snapshot the current dates as a baseline for variance tracking.",
     "input_schema": {"type": "object", "properties": {"name": {"type": "string"}}}},
]


# ------------------------------------------------------------------------------------
# tool dispatch (pure; testable without the model)
# ------------------------------------------------------------------------------------
class Holder:
    def __init__(self, project: Optional[Project]):
        self.project = project
        self.log: list[str] = []


def _state_line(p: Project) -> str:
    try:
        schedule(p)
        rep = health_check(p)
        crit = sum(1 for a in p.activities if a.critical)
        mfb = f", must finish {p.must_finish_by:%Y-%m-%d}" if p.must_finish_by else ""
        fails = "; failing: " + ", ".join(c.title for c in rep.failing()) if rep.failing() else "; all checks pass"
        return (f"{len(p.activities)} activities, {len(p.relationships)} links, {crit} critical. "
                f"Finish {p.finish:%Y-%m-%d}{mfb}. Health {rep.score}/100{fails}.")
    except ScheduleError as e:
        return f"Schedule error: {e}"


def dispatch(name: str, args: dict, h: Holder) -> str:
    """Run one tool. Returns a short text result the model reads. Mutates h.project."""
    if name == "generate_programme":
        brief = parse_brief(args.get("brief", ""))
        p = draft_to_project(generate(brief), brief.source_text)
        h.project = p
        h.log.append(f"generated {len(p.activities)} activities")
        return f"Built '{p.name}' ({p.id}). {_state_line(p)}"

    if h.project is None:
        return "No programme yet. Call generate_programme first with a brief describing the project."
    p = h.project

    if name == "get_schedule":
        try:
            schedule(p)
            rep = health_check(p)
        except ScheduleError as e:
            return f"Schedule error: {e}"
        return schedule_digest(p, rep, max_rows=300)
    if name == "health_check":
        try:
            schedule(p)
            rep = health_check(p)
        except ScheduleError as e:
            return f"Schedule error: {e}"
        lines = [f"Health {rep.score}/100. {rep.summary}"]
        for c in rep.failing():
            lines.append(f"- {c.title}: {c.detail} {', '.join(c.items[:20])}")
        return "\n".join(lines)
    if name == "run_command":
        try:
            res = run_command_text(p, args.get("command", ""))
        except CommandError as e:
            return f"Could not apply: {e}"
        h.log += res["log"]
        extra = (" Left open: " + "; ".join(res["still_open"])) if res.get("still_open") else ""
        return f"{res['message']}{extra} {_state_line(p)}"
    if name == "apply_edits":
        ops = [PatchOp(**{k: v for k, v in o.items() if v is not None}) for o in args.get("ops", [])]
        log = apply_patch(p, Patch(ops=ops, message=""))
        h.log += log
        return "Applied. " + "; ".join(log[:12]) + (" ..." if len(log) > 12 else "") + " " + _state_line(p)
    if name == "repair":
        try:
            schedule(p)
            rep = health_check(p)
        except ScheduleError as e:
            return f"Schedule error: {e}"
        patch = plan_repairs(p, rep)
        h.log += apply_patch(p, patch)
        extra = (" Left open: " + "; ".join(patch.still_open)) if patch.still_open else ""
        return f"{patch.message}{extra} {_state_line(p)}"
    if name == "level_resources":
        try:
            level(p)
        except ScheduleError as e:
            return f"Schedule error: {e}"
        moved = sum(1 for a in p.activities if a.level_delay_hours > 0)
        return f"Levelled: {moved} activities delayed to stay within resource limits. {_state_line(p)}"
    if name == "set_baseline":
        bl = set_baseline(p, args.get("name") or "Baseline")
        return f"Baseline '{bl.name}' saved at finish {bl.finish:%Y-%m-%d}."
    return f"Unknown tool {name}."


# ------------------------------------------------------------------------------------
# chat loop
# ------------------------------------------------------------------------------------
def _anthropic_client():
    import anthropic  # imported lazily so the module loads without the package
    if not (os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN")):
        raise RuntimeError("Set ANTHROPIC_API_KEY on the server to use the AI assistant.")
    return anthropic.Anthropic(timeout=600.0, max_retries=2)


def chat(project: Optional[Project], history: list[dict], user_message: str,
         client: Any = None, model: str = MODEL) -> dict:
    """One assistant turn. `history` is prior [{role, text}] turns (user/assistant only).

    Returns {reply, project, history, log, tool_calls}. `project` may be newly created.
    Pass a stub `client` with a `.messages.create(...)` method to test without the API."""
    client = client or _anthropic_client()
    h = Holder(project)
    cur = _state_line(project) if project else "No programme loaded yet."
    system = SYSTEM + f"\n\nCurrent programme: {cur}"
    messages: list[dict] = []
    for turn in history[-20:]:
        messages.append({"role": turn["role"], "content": turn["text"]})
    messages.append({"role": "user", "content": user_message})

    tool_calls: list[str] = []
    reply = ""
    for _ in range(MAX_STEPS):
        resp = client.messages.create(model=model, max_tokens=8000, system=system, tools=TOOLS, messages=messages)
        messages.append({"role": "assistant", "content": resp.content})
        if resp.stop_reason == "tool_use":
            results = []
            for block in resp.content:
                if getattr(block, "type", None) == "tool_use":
                    args = block.input if isinstance(block.input, dict) else json.loads(block.input)
                    tool_calls.append(block.name)
                    out = dispatch(block.name, args, h)
                    results.append({"type": "tool_result", "tool_use_id": block.id, "content": out})
            messages.append({"role": "user", "content": results})
            continue
        reply = "".join(b.text for b in resp.content if getattr(b, "type", None) == "text").strip()
        break
    new_history = list(history) + [{"role": "user", "text": user_message}, {"role": "assistant", "text": reply}]
    return {"reply": reply, "project": h.project, "history": new_history, "log": h.log, "tool_calls": tool_calls}

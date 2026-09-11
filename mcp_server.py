"""MCP server: lets Claude (Desktop, Code, or any MCP client) act as the planner.

Run with stdio for Claude Desktop / Claude Code:
    python mcp_server.py
Or over HTTP:
    MCP_TRANSPORT=streamable-http python mcp_server.py

The AI on the other end builds the schedule with these tools; the CPM engine
here computes the dates and the DCMA check keeps it honest.
"""
from __future__ import annotations

import os
from datetime import date, datetime
from typing import Optional

from mcp.server.fastmcp import FastMCP

from planner import Project, schedule, health_check, ScheduleError
from planner import store
from planner.ai_planner import (Patch, PatchOp, PLANNER_SYSTEM, apply_patch, _ensure_calendars, schedule_digest,
                                draft_to_project, DraftPlan)
from planner.io import read_any, write_any

mcp = FastMCP(
    "AI Construction Planner",
    instructions=(
        "Build and maintain construction programmes. Typical flow: create_project -> add_wbs -> add_activities "
        "(with predecessors) -> calculate -> read the health report -> apply_patch to fix failing checks -> export. "
        "Durations and lags are in working days. Link types FS, SS, FF, SF. Follow the planning rules in "
        "planning_guidelines() before drafting."
    ),
    host="0.0.0.0",
    port=int(os.environ.get("PORT", "8010")),
)


def _load(pid: str) -> Project:
    try:
        return store.load(pid)
    except KeyError:
        raise ValueError(f"No project '{pid}'. Call list_projects.")


def _calc(project: Project) -> dict:
    try:
        schedule(project)
    except ScheduleError as e:
        store.save(project)
        return {"error": str(e)}
    report = health_check(project)
    store.save(project)
    return {"finish": project.finish.isoformat(), "health_score": report.score, "summary": report.summary,
            "failing": [{"check": c.key, "detail": c.detail, "items": c.items[:30]} for c in report.failing()],
            "digest": schedule_digest(project, report)}


@mcp.tool()
def planning_guidelines() -> str:
    """The planning rules an experienced planner follows. Read before drafting a programme."""
    return PLANNER_SYSTEM


@mcp.tool()
def list_projects() -> list[dict]:
    """List saved projects."""
    return store.list_projects()


@mcp.tool()
def create_project(project_id: str, name: str, start_date: str, must_finish_by: Optional[str] = None,
                   description: str = "") -> dict:
    """Create an empty project. Dates YYYY-MM-DD. Standard calendars (standard, six_day, seven_day) are added."""
    start = datetime.strptime(start_date, "%Y-%m-%d").replace(hour=8)
    mfb = datetime.strptime(must_finish_by, "%Y-%m-%d").replace(hour=16) if must_finish_by else None
    p = Project(id=project_id, name=name, start=start, data_date=start, must_finish_by=mfb, description=description)
    _ensure_calendars(p)
    store.save(p)
    return {"created": p.id}


@mcp.tool()
def create_project_from_draft(draft: DraftPlan) -> dict:
    """Create a whole project in one call from a DraftPlan (WBS, activities with predecessors, constraints,
    assumptions). This is the fastest route: draft the entire programme, submit it, then read the health report."""
    p = draft_to_project(draft)
    if any(x["id"] == p.id for x in store.list_projects()):
        p.id = f"{p.id}-2"
    return {"project_id": p.id, **_calc(p)}


@mcp.tool()
def add_wbs(project_id: str, nodes: list[dict]) -> dict:
    """Add WBS nodes: [{"code": "2.1", "name": "Piling", "parent_code": "2"}]."""
    p = _load(project_id)
    ops = [PatchOp(op="add_wbs", wbs_code=n["code"], name=n.get("name", n["code"]), parent_wbs_code=n.get("parent_code")) for n in nodes]
    log = apply_patch(p, Patch(ops=ops, message=""))
    store.save(p)
    return {"log": log}


@mcp.tool()
def add_activities(project_id: str, activities: list[dict]) -> dict:
    """Add activities. Each: {"id": "A1010", "name": "...", "wbs_code": "2.1", "duration_days": 5,
    "type": "task|start_milestone|finish_milestone", "calendar": "standard|six_day|seven_day",
    "trade": "Groundworks gang", "predecessors": [{"predecessor_id": "A1000", "type": "FS", "lag_days": 0}]}"""
    p = _load(project_id)
    ops = []
    for a in activities:
        ops.append(PatchOp(op="add_activity", activity_id=a["id"], name=a.get("name", a["id"]), wbs_code=a.get("wbs_code"),
                           duration_days=a.get("duration_days", 0), activity_type=a.get("type", "task"),
                           calendar=a.get("calendar", "standard"), trade=a.get("trade")))
    for a in activities:
        for l in a.get("predecessors", []):
            ops.append(PatchOp(op="add_link", predecessor_id=l["predecessor_id"], successor_id=a["id"],
                               link_type=l.get("type", "FS"), lag_days=l.get("lag_days", 0)))
    log = apply_patch(p, Patch(ops=ops, message=""))
    store.save(p)
    return {"log": log, "activities": len(p.activities), "links": len(p.relationships)}


@mcp.tool()
def add_links(project_id: str, links: list[dict]) -> dict:
    """Add relationships: [{"predecessor_id": "A1010", "successor_id": "A1020", "type": "FS", "lag_days": 0}]"""
    p = _load(project_id)
    ops = [PatchOp(op="add_link", predecessor_id=l["predecessor_id"], successor_id=l["successor_id"],
                   link_type=l.get("type", "FS"), lag_days=l.get("lag_days", 0)) for l in links]
    log = apply_patch(p, Patch(ops=ops, message=""))
    store.save(p)
    return {"log": log}


@mcp.tool()
def apply_patch_ops(project_id: str, patch: Patch) -> dict:
    """Apply any set of edits (rename, set_duration, add_link, remove_link, set_constraint, set_progress,
    remove_activity, add_activity, set_project_start, set_must_finish_by, note...) then recalculate."""
    p = _load(project_id)
    log = apply_patch(p, patch)
    return {"log": log, **_calc(p)}


@mcp.tool()
def calculate(project_id: str) -> dict:
    """Run the critical-path calculation and the DCMA 14-point health check. Returns dates, floats and failures."""
    return _calc(_load(project_id))


@mcp.tool()
def get_schedule(project_id: str) -> dict:
    """Full project JSON (activities with early/late dates, float, critical flag, links, calendars, resources)."""
    p = _load(project_id)
    try:
        schedule(p)
    except ScheduleError as e:
        return {"error": str(e)}
    return p.model_dump(mode="json")


@mcp.tool()
def set_status_date(project_id: str, data_date: str) -> dict:
    """Move the data (status) date, YYYY-MM-DD. Then use apply_patch_ops set_progress ops to record actuals."""
    p = _load(project_id)
    p.data_date = datetime.strptime(data_date, "%Y-%m-%d").replace(hour=8)
    return _calc(p)


@mcp.tool()
def import_schedule(path: str) -> dict:
    """Import a Primavera XER or MS Project XML (what Asta Powerproject exports) file from disk."""
    data = open(path, "rb").read()
    p = read_any(os.path.basename(path), data)
    if any(x["id"] == p.id for x in store.list_projects()):
        p.id = f"{p.id}-imp"
    return {"project_id": p.id, **_calc(p)}


@mcp.tool()
def export_schedule(project_id: str, path: str, fmt: str = "xer") -> dict:
    """Write the project to disk as xer (Primavera P6 / Asta), xml (MS Project / Asta) or json."""
    p = _load(project_id)
    try:
        schedule(p)
    except ScheduleError as e:
        return {"error": str(e)}
    content, _, _ = write_any(p, fmt)
    enc = "cp1252" if fmt == "xer" else "utf-8"
    with open(path, "w", encoding=enc, errors="replace", newline="") as f:
        f.write(content)
    return {"written": path, "activities": len(p.activities)}


@mcp.tool()
def delete_project(project_id: str) -> dict:
    """Delete a saved project."""
    return {"deleted": store.delete(project_id)}


if __name__ == "__main__":
    mcp.run(transport=os.environ.get("MCP_TRANSPORT", "stdio"))

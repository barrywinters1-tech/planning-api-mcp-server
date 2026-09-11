"""HTTP API + web UI. Pure code: generator, CPM, DCMA, repairer, command language, file interop.

    uvicorn api:app --reload --port 8080
"""
from __future__ import annotations

import uuid
from pathlib import Path
from typing import Any, Optional

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel

from planner import Project, schedule, health_check, ScheduleError
from planner import store
from planner.commands import CommandError, HELP, parse_command
from planner.generator import Brief, RATES, generate, parse_brief
from planner.io import read_any, write_any
from planner import mpxj_bridge
from planner.plan import Patch, PatchOp, apply_patch, draft_to_project, schedule_digest
from planner.repair import plan_repairs
from planner.model import Assignment, Resource

app = FastAPI(title="Planner", version="0.2")
WEB = Path(__file__).parent / "web"


def _view(project: Project, report=None, extra: Optional[dict] = None) -> dict:
    if report is None:
        try:
            schedule(project)
            report = health_check(project)
        except ScheduleError as e:
            report = None
            extra = {**(extra or {}), "schedule_error": str(e)}
    out = {"project": project.model_dump(mode="json"), "report": report.model_dump(mode="json") if report else None}
    if extra:
        out.update(extra)
    return out


def _load(pid: str) -> Project:
    try:
        return store.load(pid)
    except KeyError:
        raise HTTPException(404, "no such project")


def _exists(pid: str) -> bool:
    try:
        store.load(pid)
        return True
    except KeyError:
        return False


def _unique(pid: str) -> str:
    return pid if not _exists(pid) else f"{pid}-{uuid.uuid4().hex[:4]}"


# ---------------------------------------------------------------- pages
@app.get("/")
def index():
    return FileResponse(WEB / "index.html")


@app.get("/favicon.ico")
def favicon():
    return Response(status_code=204)


@app.get("/api/capabilities")
def capabilities():
    return {"mpxj_bridge": mpxj_bridge.available(), "mpxj_reason": mpxj_bridge.why_unavailable(), "rates": RATES, "help": HELP}


# ---------------------------------------------------------------- projects
@app.get("/api/projects")
def list_projects():
    return store.list_projects()


@app.get("/api/projects/{pid}")
def get_project(pid: str):
    return _view(_load(pid))


class ProjectIn(BaseModel):
    project: Project


@app.put("/api/projects/{pid}")
def put_project(pid: str, body: ProjectIn):
    project = body.project
    project.id = pid
    try:
        schedule(project)
        report = health_check(project)
    except ScheduleError as e:
        raise HTTPException(422, str(e))
    store.save(project)
    return _view(project, report)


@app.delete("/api/projects/{pid}")
def delete_project(pid: str):
    return {"deleted": store.delete(pid)}


@app.post("/api/projects/{pid}/schedule")
def reschedule(pid: str):
    project = _load(pid)
    view = _view(project)
    store.save(project)
    return view


class PatchIn(BaseModel):
    patch: Patch


@app.post("/api/projects/{pid}/patch")
def patch_project(pid: str, body: PatchIn):
    project = _load(pid)
    log = apply_patch(project, body.patch)
    view = _view(project, extra={"log": log})
    store.save(project)
    return view


# ---------------------------------------------------------------- generator
class BriefIn(BaseModel):
    text: Optional[str] = None
    brief: Optional[Brief] = None


@app.post("/api/brief/parse")
def brief_parse(body: BriefIn):
    if not body.text:
        raise HTTPException(422, "text required")
    return parse_brief(body.text).model_dump(mode="json")


@app.post("/api/generate")
def generate_project(body: BriefIn):
    if body.brief is None and not body.text:
        raise HTTPException(422, "Give a brief (form) or text.")
    brief = body.brief or parse_brief(body.text or "")
    if body.brief is not None and body.text:
        brief.source_text = body.text
    draft = generate(brief)
    project = draft_to_project(draft, brief.source_text)
    project.id = _unique(project.id)
    try:
        schedule(project)
        report = health_check(project)
    except ScheduleError as e:
        raise HTTPException(500, f"generator produced a loop: {e}")
    store.save(project)
    return {**_view(project, report), "brief": brief.model_dump(mode="json"),
            "draft": {"summary": draft.summary, "assumptions": draft.assumptions, "questions_for_client": draft.questions_for_client}}


# ---------------------------------------------------------------- commands and repair
class CommandIn(BaseModel):
    text: str


def _run_patch(project: Project, patch: Patch) -> list[str]:
    """Apply a patch, handling the command language's special notes."""
    log: list[str] = []
    real: list[PatchOp] = []
    for op in patch.ops:
        if op.op == "note" and op.reason.startswith("__data_date__"):
            from datetime import datetime
            project.data_date = datetime.strptime(op.reason[len("__data_date__"):], "%Y-%m-%d").replace(hour=8)
            log.append(f"data date -> {project.data_date:%Y-%m-%d}")
        elif op.op == "note" and op.reason.startswith("__assign__"):
            _, aid, trade = op.reason.split("__")[2:5]
            rid = "".join(ch if ch.isalnum() else "_" for ch in trade).strip("_").upper()[:20]
            if not any(r.id == rid for r in project.resources):
                project.resources.append(Resource(id=rid, name=trade))
            project.assignments = [x for x in project.assignments if x.activity_id != aid]
            project.assignments.append(Assignment(activity_id=aid, resource_id=rid, units=project.activity(aid).duration_hours))
            log.append(f"{aid} assigned {trade}")
        elif op.op == "note" and op.reason == "__repair__":
            try:
                schedule(project)
                rep = health_check(project)
            except ScheduleError as e:
                log.append(f"cannot repair: {e}")
                continue
            rp = plan_repairs(project, rep)
            log += apply_patch(project, rp)
            patch.message = rp.message
            patch.still_open = rp.still_open
        else:
            real.append(op)
    if real:
        log += apply_patch(project, Patch(ops=real, message=""))
    return log


@app.post("/api/projects/{pid}/command")
def command(pid: str, body: CommandIn):
    project = _load(pid)
    try:
        patch = parse_command(project, body.text)
    except CommandError as e:
        raise HTTPException(422, str(e))
    if not patch.ops:
        return {"message": patch.message, "log": [], "project": None}
    log = _run_patch(project, patch)
    view = _view(project, extra={"log": log, "message": patch.message, "still_open": patch.still_open})
    store.save(project)
    return view


@app.post("/api/projects/{pid}/repair")
def repair(pid: str):
    project = _load(pid)
    try:
        schedule(project)
        rep = health_check(project)
    except ScheduleError as e:
        raise HTTPException(422, str(e))
    patch = plan_repairs(project, rep)
    log = apply_patch(project, patch)
    view = _view(project, extra={"log": log, "message": patch.message, "still_open": patch.still_open,
                                 "ops": [o.model_dump(mode="json", exclude_none=True) for o in patch.ops]})
    store.save(project)
    return view


# ---------------------------------------------------------------- import / export
@app.post("/api/import")
async def import_file(file: UploadFile = File(...)):
    data = await file.read()
    try:
        project = read_any(file.filename or "", data)
    except ValueError as e:
        raise HTTPException(422, str(e))
    except RuntimeError as e:
        raise HTTPException(501, str(e))
    project.id = _unique(project.id)
    view = _view(project)
    store.save(project)
    return view


@app.get("/api/projects/{pid}/export.{fmt}")
def export(pid: str, fmt: str):
    project = _load(pid)
    try:
        content, media, filename = write_any(project, fmt)
    except ValueError as e:
        raise HTTPException(422, str(e))
    body = content.encode("cp1252", errors="replace") if fmt == "xer" else content.encode("utf-8")
    return Response(body, media_type=media, headers={"Content-Disposition": f'attachment; filename="{filename}"'})


@app.get("/api/projects/{pid}/digest")
def digest(pid: str):
    project = _load(pid)
    try:
        schedule(project)
        report = health_check(project)
    except ScheduleError as e:
        return {"digest": f"schedule error: {e}"}
    return {"digest": schedule_digest(project, report)}

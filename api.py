"""HTTP API + web UI for the AI planner.

    uvicorn api:app --reload --port 8080

Long AI calls run as background jobs; the UI polls /api/jobs/{id}.
"""
from __future__ import annotations

import os
import threading
import traceback
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any, Optional

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel

from planner import Project, schedule, health_check, ScheduleError
from planner import store
from planner.ai_planner import (Patch, apply_patch, edit_with_instruction, plan_from_description, schedule_digest)
from planner.io import read_any, write_any

app = FastAPI(title="AI Planner", version="0.1")
WEB = Path(__file__).parent / "web"

_jobs: dict[str, dict[str, Any]] = {}
_lock = threading.Lock()


def _run_job(job_id: str, fn, *args):
    try:
        result = fn(*args)
        with _lock:
            _jobs[job_id].update(status="done", result=result, finished=datetime.now().isoformat())
    except Exception as e:  # noqa: BLE001 - surface anything to the UI
        with _lock:
            _jobs[job_id].update(status="error", error=str(e), trace=traceback.format_exc(),
                                 finished=datetime.now().isoformat())


def _start_job(kind: str, fn, *args) -> dict:
    job_id = uuid.uuid4().hex[:12]
    with _lock:
        _jobs[job_id] = {"id": job_id, "kind": kind, "status": "running", "started": datetime.now().isoformat()}
    threading.Thread(target=_run_job, args=(job_id, fn, *args), daemon=True).start()
    return {"job_id": job_id}


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


# ---------------------------------------------------------------- pages
@app.get("/")
def index():
    return FileResponse(WEB / "index.html")


@app.get("/favicon.ico")
def favicon():
    return Response(status_code=204)


# ---------------------------------------------------------------- projects
@app.get("/api/projects")
def list_projects():
    return store.list_projects()


@app.get("/api/projects/{pid}")
def get_project(pid: str):
    try:
        return _view(store.load(pid))
    except KeyError:
        raise HTTPException(404, "no such project")


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
    try:
        project = store.load(pid)
    except KeyError:
        raise HTTPException(404, "no such project")
    view = _view(project)
    store.save(project)
    return view


class PatchIn(BaseModel):
    patch: Patch


@app.post("/api/projects/{pid}/patch")
def patch_project(pid: str, body: PatchIn):
    try:
        project = store.load(pid)
    except KeyError:
        raise HTTPException(404, "no such project")
    log = apply_patch(project, body.patch)
    view = _view(project, extra={"log": log})
    store.save(project)
    return view


# ---------------------------------------------------------------- AI jobs
class PlanIn(BaseModel):
    description: str
    review: bool = True
    effort: str = "high"


def _plan(description: str, review: bool, effort: str) -> dict:
    result = plan_from_description(description, review=review, effort=effort)
    project = result.project
    if store_exists(project.id):
        project.id = f"{project.id}-{uuid.uuid4().hex[:4]}"
    store.save(project)
    return {**_view(project, result.report), "log": result.log,
            "draft": {"summary": result.draft.summary, "assumptions": result.draft.assumptions,
                      "questions_for_client": result.draft.questions_for_client} if result.draft else None,
            "review": result.review.model_dump(mode="json") if result.review else None}


def store_exists(pid: str) -> bool:
    try:
        store.load(pid)
        return True
    except KeyError:
        return False


@app.post("/api/plan")
def plan(body: PlanIn):
    if not os.environ.get("ANTHROPIC_API_KEY") and not os.environ.get("ANTHROPIC_AUTH_TOKEN"):
        # the SDK can also pick up an `ant auth login` profile, so only warn
        pass
    if len(body.description.strip()) < 20:
        raise HTTPException(422, "Describe the project in at least a sentence or two.")
    return _start_job("plan", _plan, body.description, body.review, body.effort)


class EditIn(BaseModel):
    instruction: str
    effort: str = "high"


def _edit(pid: str, instruction: str, effort: str) -> dict:
    project = store.load(pid)
    patch, log, report = edit_with_instruction(project, instruction, effort=effort)
    store.save(project)
    return {**_view(project, report), "log": log, "patch": patch.model_dump(mode="json")}


@app.post("/api/projects/{pid}/edit")
def edit(pid: str, body: EditIn):
    if not store_exists(pid):
        raise HTTPException(404, "no such project")
    return _start_job("edit", _edit, pid, body.instruction, body.effort)


@app.get("/api/jobs/{job_id}")
def job(job_id: str):
    with _lock:
        j = _jobs.get(job_id)
    if not j:
        raise HTTPException(404, "no such job")
    return j


# ---------------------------------------------------------------- import / export
@app.post("/api/import")
async def import_file(file: UploadFile = File(...)):
    data = await file.read()
    try:
        project = read_any(file.filename or "", data)
    except ValueError as e:
        raise HTTPException(422, str(e))
    if store_exists(project.id):
        project.id = f"{project.id}-{uuid.uuid4().hex[:4]}"
    view = _view(project)
    store.save(project)
    return view


@app.get("/api/projects/{pid}/export.{fmt}")
def export(pid: str, fmt: str):
    try:
        project = store.load(pid)
    except KeyError:
        raise HTTPException(404, "no such project")
    try:
        content, media, filename = write_any(project, fmt)
    except ValueError as e:
        raise HTTPException(422, str(e))
    body = content.encode("cp1252", errors="replace") if fmt == "xer" else content.encode("utf-8")
    return Response(body, media_type=media, headers={"Content-Disposition": f'attachment; filename="{filename}"'})


@app.get("/api/projects/{pid}/digest")
def digest(pid: str):
    try:
        project = store.load(pid)
    except KeyError:
        raise HTTPException(404, "no such project")
    try:
        schedule(project)
        report = health_check(project)
    except ScheduleError as e:
        return {"digest": f"schedule error: {e}"}
    return {"digest": schedule_digest(project, report)}

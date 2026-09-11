"""Tiny JSON-on-disk project store. One file per project."""
from __future__ import annotations

import os
import re
from pathlib import Path

from .model import Project

DATA_DIR = Path(os.environ.get("PLANNER_DATA_DIR", "data/projects"))


def _path(pid: str) -> Path:
    safe = re.sub(r"[^A-Za-z0-9_-]+", "-", pid)
    return DATA_DIR / f"{safe}.json"


def save(project: Project) -> Path:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    p = _path(project.id)
    p.write_text(project.model_dump_json(indent=1), encoding="utf-8")
    return p


def load(pid: str) -> Project:
    p = _path(pid)
    if not p.exists():
        raise KeyError(pid)
    return Project.model_validate_json(p.read_text(encoding="utf-8"))


def delete(pid: str) -> bool:
    p = _path(pid)
    if p.exists():
        p.unlink()
        return True
    return False


def list_projects() -> list[dict]:
    out = []
    if not DATA_DIR.exists():
        return out
    for f in sorted(DATA_DIR.glob("*.json")):
        try:
            pr = Project.model_validate_json(f.read_text(encoding="utf-8"))
        except Exception:
            continue
        out.append({"id": pr.id, "name": pr.name, "start": pr.start.isoformat(),
                    "finish": pr.finish.isoformat() if pr.finish else None,
                    "activities": len(pr.activities), "scheduled_at": pr.scheduled_at.isoformat() if pr.scheduled_at else None})
    return out

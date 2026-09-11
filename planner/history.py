"""Undo / redo as JSON snapshots next to the project file."""
from __future__ import annotations

import json
from pathlib import Path

from . import store
from .model import Project

LIMIT = 60


def _paths(pid: str) -> tuple[Path, Path]:
    base = store._path(pid)
    return base.with_suffix(".undo.json"), base.with_suffix(".redo.json")


def _read(p: Path) -> list[str]:
    return json.loads(p.read_text(encoding="utf-8")) if p.exists() else []


def _write(p: Path, items: list[str]) -> None:
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(items[-LIMIT:]), encoding="utf-8")


def snapshot(pid: str) -> None:
    """Call before mutating: pushes the stored state onto the undo stack and clears redo."""
    try:
        current = store.load(pid)
    except KeyError:
        return
    u, r = _paths(pid)
    items = _read(u)
    items.append(current.model_dump_json())
    _write(u, items)
    if r.exists():
        r.unlink()


def undo(pid: str) -> Project | None:
    u, r = _paths(pid)
    items = _read(u)
    if not items:
        return None
    current = store.load(pid)
    redo_items = _read(r)
    redo_items.append(current.model_dump_json())
    _write(r, redo_items)
    prev = Project.model_validate_json(items.pop())
    _write(u, items)
    store.save(prev)
    return prev


def redo(pid: str) -> Project | None:
    u, r = _paths(pid)
    items = _read(r)
    if not items:
        return None
    current = store.load(pid)
    undo_items = _read(u)
    undo_items.append(current.model_dump_json())
    _write(u, undo_items)
    nxt = Project.model_validate_json(items.pop())
    _write(r, items)
    store.save(nxt)
    return nxt


def depth(pid: str) -> dict:
    u, r = _paths(pid)
    return {"undo": len(_read(u)), "redo": len(_read(r))}


def clear(pid: str) -> None:
    for p in _paths(pid):
        if p.exists():
            p.unlink()

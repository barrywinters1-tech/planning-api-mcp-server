"""Format detection helpers shared by the API and the MCP server."""
from __future__ import annotations

from .model import Project
from .mspxml import read_mspdi, write_mspdi
from .xer import read_xer, write_xer


def read_any(filename: str, data: bytes) -> Project:
    name = (filename or "").lower()
    head = data[:200].lstrip()
    if name.endswith(".xer") or head.startswith(b"ERMHDR"):
        try:
            text = data.decode("utf-8")
        except UnicodeDecodeError:
            text = data.decode("cp1252", errors="replace")
        return read_xer(text)
    if name.endswith(".xml") or head.startswith(b"<?xml") or head.startswith(b"<Project"):
        return read_mspdi(data.decode("utf-8", errors="replace"))
    if name.endswith(".json") or head.startswith(b"{"):
        return Project.model_validate_json(data.decode("utf-8"))
    if name.endswith(".pp"):
        raise ValueError("Asta .pp is a closed binary format. In Powerproject use File > Export > MS Project XML (or Primavera XER) and import that instead.")
    raise ValueError("Unrecognised file. Accepts Primavera XER, MS Project XML (MSPDI, which Asta exports) or this tool's JSON.")


def write_any(project: Project, fmt: str) -> tuple[str, str, str]:
    """returns (content, media type, filename)"""
    fmt = fmt.lower().lstrip(".")
    if fmt == "xer":
        return write_xer(project), "text/plain; charset=cp1252", f"{project.id}.xer"
    if fmt in ("xml", "mspdi", "msproject"):
        return write_mspdi(project), "application/xml", f"{project.id}.xml"
    if fmt == "json":
        return project.model_dump_json(indent=1), "application/json", f"{project.id}.json"
    raise ValueError("format must be xer, xml or json")

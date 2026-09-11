"""Format detection helpers shared by the API and the MCP server."""
from __future__ import annotations

import os

from . import mpxj_bridge
from .model import Project
from .mspxml import read_mspdi, write_mspdi
from .xer import read_xer, write_xer


def _xml_root_tag(data: bytes) -> str:
    head = data[:4000].decode("utf-8", errors="replace")
    i = head.find("<?xml")
    j = head.find("<", i + 1 if i >= 0 else 0)
    while j >= 0 and head[j:j + 4] in ("<!--", "<!DO"):
        j = head.find("<", head.find(">", j) + 1)
    if j < 0:
        return ""
    tag = head[j + 1:].split()[0].split(">")[0]
    return tag.split(":")[-1].strip("/")


def read_any(filename: str, data: bytes) -> Project:
    name = (filename or "").lower()
    ext = os.path.splitext(name)[1]
    head = data[:200].lstrip()
    if ext == ".xer" or head.startswith(b"ERMHDR"):
        try:
            text = data.decode("utf-8")
        except UnicodeDecodeError:
            text = data.decode("cp1252", errors="replace")
        return read_xer(text)
    if ext in (".xml", ".mspdi", ".pmxml") or head.startswith(b"<?xml") or head.startswith(b"<Project"):
        root = _xml_root_tag(data)
        if root == "Project":
            return read_mspdi(data.decode("utf-8", errors="replace"))
        if root == "APIBusinessObjects":
            from .pmxml import read_pmxml
            return read_pmxml(data.decode("utf-8", errors="replace"))
        raise ValueError(f"Unrecognised XML root <{root}>. Expected MS Project XML (<Project>) or P6 XML (<APIBusinessObjects>).")
    if ext == ".json" or head.startswith(b"{"):
        return Project.model_validate_json(data.decode("utf-8"))
    if ext in mpxj_bridge.BRIDGE_EXTENSIONS or ext == "":
        reason = mpxj_bridge.why_unavailable()
        if reason:
            hint = (" For Asta, File > Export > MS Project XML from Powerproject also works." if ext == ".pp" else "")
            raise ValueError(f"{ext or 'This file'} needs the MPXJ bridge. {reason}{hint}")
        return mpxj_bridge.read_bytes_with_mpxj(filename, data)
    raise ValueError("Unrecognised file. Accepts Primavera XER, P6 XML, MS Project XML, and (with the MPXJ bridge) Asta .pp, .mpp and others.")


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

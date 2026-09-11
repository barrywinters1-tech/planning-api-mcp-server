"""Optional bridge to MPXJ (https://www.mpxj.org) for formats we do not parse natively.

MPXJ is a Java library with a reverse-engineered reader for Asta Powerproject
``.pp`` files, plus MS Project ``.mpp``, P6 PMXML, P3, SureTrak and more. We let
MPXJ read the file, ask it to write MS Project XML, and feed that into our own
MSPDI reader. Requires:

    pip install mpxj JPype1     # and a Java 11+ runtime on PATH

If either is missing, `available()` is False and `read_any` gives a clear error.
"""
from __future__ import annotations

import os
import tempfile
from typing import Optional

from .model import Project
from .mspxml import read_mspdi

BRIDGE_EXTENSIONS = {".pp", ".mpp", ".mpx", ".mpd", ".pmxml", ".p3", ".prx", ".stx", ".gan", ".planner",
                     ".pod", ".ppx", ".sp", ".sdef", ".bk3", ".edpx", ".zip"}

_status: Optional[str] = None


def available() -> bool:
    return why_unavailable() is None


def why_unavailable() -> Optional[str]:
    global _status
    if _status is not None:
        return _status or None
    try:
        import jpype  # noqa: F401
        import mpxj  # noqa: F401
    except ImportError as e:
        _status = f"MPXJ bridge not installed ({e.name}). Run: pip install mpxj JPype1 (needs Java 11+)."
        return _status
    try:
        _start_jvm()
    except Exception as e:  # noqa: BLE001
        _status = f"MPXJ bridge could not start Java: {e}"
        return _status
    _status = ""
    return None


def _start_jvm() -> None:
    import jpype
    import mpxj  # noqa: F401  (adds jars to the classpath on import)
    if not jpype.isJVMStarted():
        jpype.startJVM(convertStrings=True)


def read_with_mpxj(path: str) -> Project:
    reason = why_unavailable()
    if reason:
        raise RuntimeError(reason)
    from org.mpxj.reader import UniversalProjectReader
    from org.mpxj.writer import FileFormat, UniversalProjectWriter

    pf = UniversalProjectReader().read(path)
    if pf is None:
        raise ValueError(f"MPXJ could not recognise {os.path.basename(path)} as a schedule file.")
    with tempfile.TemporaryDirectory() as tmp:
        out = os.path.join(tmp, "bridge.xml")
        UniversalProjectWriter(FileFormat.MSPDI).write(pf, out)
        project = read_mspdi(open(out, encoding="utf-8").read())
    title = pf.getProjectProperties().getProjectTitle() or pf.getProjectProperties().getName()
    if title:
        project.name = str(title)
    stem = os.path.splitext(os.path.basename(path))[0]
    project.id = "".join(ch if ch.isalnum() or ch in "-_" else "-" for ch in stem)[:20] or project.id
    project.description = f"Imported from {os.path.basename(path)} via MPXJ"
    return project


def read_bytes_with_mpxj(filename: str, data: bytes) -> Project:
    ext = os.path.splitext(filename or "")[1].lower() or ".bin"
    with tempfile.NamedTemporaryFile(suffix=ext, delete=False) as f:
        f.write(data)
        tmp = f.name
    try:
        return read_with_mpxj(tmp)
    finally:
        os.unlink(tmp)

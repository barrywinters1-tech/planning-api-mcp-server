"""Browser import end to end: web/import_any.js readAny must give the same programme as
planner/io.py read_any for the same file bytes (format detection, decoding, reading, then
scheduling), and must explain binary formats it cannot read. Skipped without node."""
from __future__ import annotations

import base64
import json
import shutil
import subprocess
from pathlib import Path

import pytest

from planner.cpm import schedule
from planner.io import read_any
from planner.mspxml import write_mspdi
from planner.xer import write_xer
from tests.test_parity import BRIEFS, _generated, diff, norm
from planner.model import Project

ROOT = Path(__file__).resolve().parents[1]
FIX = Path(__file__).parent / "fixtures"
NODE = shutil.which("node")
READERS = [ROOT / "web" / f for f in ("import_xer.js", "import_xml.js", "import_any.js")]
pytestmark = [pytest.mark.skipif(NODE is None, reason="node is not installed"),
              pytest.mark.skipif(not all(f.exists() for f in READERS), reason="browser file readers not built yet")]

RUNNER = r"""
const path = require('path');
for (const f of ['engine.js', 'import_xer.js', 'import_xml.js', 'import_any.js']) require(path.join(process.argv[1], 'web', f));
const E = globalThis.PlannerEngine;
const cases = JSON.parse(require('fs').readFileSync(0, 'utf8'));
const out = cases.map(c => {
  try { const p = E.readAny(c.name, new Uint8Array(Buffer.from(c.b64, 'base64'))); E.schedule(p); return { project: p }; }
  catch (e) { return { error: String((e && e.message) || e) }; }
});
process.stdout.write(JSON.stringify(out));
"""


def _xer_bytes(p: Project) -> bytes:
    import tempfile
    from planner.xer import write_xer_file
    with tempfile.TemporaryDirectory() as d:
        fp = Path(d) / "x.xer"
        write_xer_file(p, str(fp))
        return fp.read_bytes()


def cases() -> list[tuple[str, bytes]]:
    cs = [(f.name, f.read_bytes()) for f in sorted(FIX.iterdir()) if f.suffix in (".xer", ".xml", ".pmxml")]
    cs += [("bom-" + f.stem, b"\xef\xbb\xbf" + f.read_bytes()) for f in sorted(FIX.iterdir()) if f.suffix in (".xer", ".xml", ".pmxml")]
    for i in (0, 2, 6):
        p = Project.model_validate(_generated(BRIEFS[i]))
        p.activities[3].name = "Café façade – phase 2 & <east>"
        schedule(p)
        cs.append((f"gen{i}.xer", _xer_bytes(p)))
        cs.append((f"gen{i}.xml", write_mspdi(p).encode("utf-8")))
    cs.append(("empty.xer", b""))
    cs.append(("notes.txt", b"hello"))
    cs.append(("wrong.xml", b"<?xml version='1.0'?><Schedule/>"))
    return cs


def run_py(name: str, data: bytes) -> dict:
    try:
        p = read_any(name, data)
        schedule(p)
        return {"project": p.model_dump(mode="json")}
    except Exception as e:  # noqa: BLE001 - the message is compared
        return {"error": str(e)}


@pytest.fixture(scope="module")
def results():
    cs = cases()
    payload = json.dumps([{"name": n, "b64": base64.b64encode(b).decode()} for n, b in cs])
    r = subprocess.run([NODE, "-e", RUNNER, str(ROOT)], input=payload, capture_output=True, text=True, timeout=300)
    assert r.returncode == 0, r.stderr[-2000:]
    return cs, json.loads(r.stdout)


def test_browser_import_matches_python(results):
    cs, js = results
    bad = []
    for (name, data), j in zip(cs, js):
        py = json.loads(json.dumps(run_py(name, data)))
        if name in ("notes.txt",):                   # message wording differs by design (no MPXJ bridge in a browser)
            assert "error" in py and "error" in j, (name, py, j)
            continue
        d = diff(norm(py), norm(j))
        if d:
            bad.append((name, d[:6]))
    assert not bad, json.dumps(bad, indent=1, default=str)[:6000]


def test_binary_formats_explain_how_to_export(results):
    script = r"""
const path = require('path');
for (const f of ['engine.js', 'import_xer.js', 'import_xml.js', 'import_any.js']) require(path.join(process.argv[1], 'web', f));
const E = globalThis.PlannerEngine; const out = {};
for (const n of ['job.pp', 'job.mpp', 'job.zip']) { try { E.readAny(n, new Uint8Array([80, 75, 3, 4, 0, 1])); out[n] = 'no error'; } catch (e) { out[n] = e.message; } }
process.stdout.write(JSON.stringify(out));
"""
    r = subprocess.run([NODE, "-e", script, str(ROOT)], capture_output=True, text=True, timeout=60)
    out = json.loads(r.stdout)
    assert "Export" in out["job.pp"] and "MS Project XML" in out["job.pp"]
    assert "XML Format" in out["job.mpp"]
    assert "zip" in out["job.zip"]

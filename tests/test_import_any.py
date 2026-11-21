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
        p.activities[4].notes = "Hold point: engineer to inspect.\nCafé £5 & <b>bold</b>\tend"
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


def test_fidelity_report_covers_custom_fields_and_codes():
    """fidelityReport: custom fields are carried in MS Project XML, and activity codes are reported as carried as text
    fields (or lost once MS Project's 30 text fields run out)."""
    p = Project.model_validate(_generated(BRIEFS[0]))
    for a in p.activities:                                     # the generator codes every activity; start from none
        a.codes, a.fields = {}, None
    p.user_fields = [{"name": "Package", "type": "text"}, {"name": "Cost", "type": "number"}, {"name": "Due", "type": "date"}]
    p.activities[0].fields = {"Package": "Steel", "Cost": 1200.0, "Due": "2026-04-01"}
    p.activities[1].fields = {"Cost": "not a number", "Extra": "x"}
    p.code_types = {"Trade": {"Brick": "#ff0000"}}
    p.activities[2].codes = {"Trade": "Brick"}
    p.activities[3].codes = {"Trade": "Steel", "Zone": "North"}
    schedule(p)
    script = r"""
const path = require('path');
for (const f of ['engine.js', 'import_xer.js', 'import_xml.js', 'import_any.js']) require(path.join(process.argv[1], 'web', f));
const E = globalThis.PlannerEngine; const p = JSON.parse(require('fs').readFileSync(0, 'utf8'));
const out = { xml: E.fidelityReport(p, 'xml').items, xer: E.fidelityReport(p, 'xer').items };
for (let i = 0; i < 31; i++) { p.code_types['Code ' + i] = {}; p.activities[0].codes['Code ' + i] = 'v' + i; }
out.many = E.fidelityReport(p, 'xml').items;
process.stdout.write(JSON.stringify(out));
"""
    r = subprocess.run([NODE, "-e", script, str(ROOT)], input=p.model_dump_json(), capture_output=True, text=True, timeout=120)
    assert r.returncode == 0, r.stderr[-2000:]
    out = json.loads(r.stdout)
    by_text = lambda items, needle: next(i for i in items if needle in i["text"])  # noqa: E731
    fields = by_text(out["xml"], "custom field values")
    assert fields["text"] == "4 of 5 custom field values" and not fields["ok"] and "Text1-30" in fields["detail"]
    codes = by_text(out["xml"], "activity code values")
    assert codes["text"] == "3 of 3 activity code values carried as text fields" and codes["ok"] and "text custom field" in codes["detail"]
    assert by_text(out["xer"], "activity code values")["text"] == "3 of 3 activity code values"
    assert by_text(out["xer"], "custom field values")["text"] == "4 of 5 custom field values"
    many = by_text(out["many"], "activity code values")
    assert many["text"].endswith("of 34 activity code values carried as text fields") and not many["ok"] and "30 text fields" in many["detail"]
    # 30 text slots: Package and Extra, then the code types in order (Trade, Code 0-30, Zone) until they run out, so Trade
    # and Code 0-26 go (28 types); Trade carries 2 values, the 27 Code types one each
    assert int(many["text"].split()[0]) == 29


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

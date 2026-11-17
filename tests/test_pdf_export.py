"""Vector PDF export (web/pdf_export.js).

tests/parity/pdf_runner.js generates and schedules a realistic programme with web/engine.js,
maps it onto the PlannerPDF `doc` interface and renders it. This test then checks the PDF
with a small pure-Python reader (header, xref offsets, stream lengths, %%EOF, page count,
text drawn on each page), the pagination for A3, A4, horizontal splitting and an explicit
rows-per-page, WinAnsi encoding of £ / é / dashes / quotes, file size, timezone independence
and, when pypdf / pypdfium2 or poppler are available, that a real PDF library parses,
extracts and rasterises it.

Skipped when node is not installed.
"""
from __future__ import annotations

import json
import math
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
RUNNER = Path(__file__).parent / "parity" / "pdf_runner.js"
PDF_JS = ROOT / "web" / "pdf_export.js"
NODE = shutil.which("node")

pytestmark = pytest.mark.skipif(NODE is None, reason="node is not installed")

PROJECT_NAME = "Riverside Café & Offices — £2.4m Phase 2"

# Geometry documented in web/pdf_export.js (GEOMETRY), in mm.
HEADER, GAP, TIER, INFO, ROW = 12, 2, 4.2, 21, 5
LEGEND_INLINE_MIN, LEGEND_ITEM, LEGEND_LINE = 330, 34, 3.6
PAGE_SIZES = {"A4": (210, 297), "A3": (297, 420), "A2": (420, 594), "A1": (594, 841)}


# ----------------------------------------------------------------------------------------
# a minimal PDF reader (enough for files PlannerPDF writes)
# ----------------------------------------------------------------------------------------
class Pdf:
    def __init__(self, data: bytes):
        self.data = data
        assert data.startswith(b"%PDF-1.4\n"), data[:12]
        assert data.rstrip().endswith(b"%%EOF")
        m = re.search(rb"startxref\s+(\d+)\s+%%EOF\s*$", data)
        assert m, "no startxref"
        xref = int(m.group(1))
        assert data[xref:xref + 4] == b"xref", "startxref does not point at the xref table"
        head = re.match(rb"xref\n0 (\d+)\n", data[xref:])
        assert head
        n = int(head.group(1))
        pos = xref + head.end()
        self.offsets = {}
        for i in range(n):
            entry = data[pos + 20 * i: pos + 20 * (i + 1)]
            assert len(entry) == 20 and entry.endswith(b" \n"), entry
            off, gen, kind = entry[:10], entry[11:16], entry[17:18]
            if i == 0:
                assert kind == b"f"
                continue
            assert kind == b"n"
            self.offsets[i] = int(off)
        trailer = data[pos + 20 * n:]
        assert trailer.startswith(b"trailer"), trailer[:20]
        assert re.search(rb"/Size %d\b" % n, trailer)
        self.root = int(re.search(rb"/Root (\d+) 0 R", trailer).group(1))
        self.objects = {}
        for num, off in self.offsets.items():
            hdr = b"%d 0 obj\n" % num
            assert data[off:off + len(hdr)] == hdr, f"xref offset for object {num} is wrong"
            end = data.index(b"\nendobj", off)
            self.objects[num] = data[off + len(hdr):end]

    def obj(self, num: int) -> bytes:
        return self.objects[num]

    def stream(self, num: int) -> bytes:
        body = self.obj(num)
        length = int(re.search(rb"/Length (\d+)", body).group(1))
        start = body.index(b"stream\n") + len(b"stream\n")
        content = body[start:start + length]
        assert body[start + length:].startswith(b"endstream"), "stream /Length is wrong"
        return content

    def pages(self) -> list[int]:
        cat = self.obj(self.root)
        pages_id = int(re.search(rb"/Pages (\d+) 0 R", cat).group(1))
        pages = self.obj(pages_id)
        kids = [int(k) for k in re.findall(rb"(\d+) 0 R", re.search(rb"/Kids \[(.*?)\]", pages).group(1))]
        count = int(re.search(rb"/Count (\d+)", pages).group(1))
        assert count == len(kids)
        return kids

    def page_content(self, page_id: int) -> bytes:
        return self.stream(int(re.search(rb"/Contents (\d+) 0 R", self.obj(page_id)).group(1)))

    def page_texts(self) -> list[list[str]]:
        return [strings(self.page_content(p)) for p in self.pages()]


_ESC = {b"n": b"\n", b"r": b"\r", b"t": b"\t", b"b": b"\b", b"f": b"\f", b"(": b"(", b")": b")", b"\\": b"\\"}


def unescape(raw: bytes) -> bytes:
    out, i = bytearray(), 0
    while i < len(raw):
        c = raw[i:i + 1]
        if c != b"\\":
            out += c
            i += 1
            continue
        nxt = raw[i + 1:i + 2]
        if nxt.isdigit():
            m = re.match(rb"[0-7]{1,3}", raw[i + 1:])
            out.append(int(m.group(0), 8))
            i += 1 + len(m.group(0))
        else:
            out += _ESC.get(nxt, nxt)
            i += 2
    return bytes(out)


def strings(content: bytes) -> list[str]:
    """Every (string) Tj in a content stream, decoded from WinAnsi (cp1252)."""
    return [unescape(m.group(1)).decode("cp1252") for m in re.finditer(rb"\(((?:\\.|[^\\)])*)\) Tj", content, re.S)]


# ----------------------------------------------------------------------------------------
# fixtures
# ----------------------------------------------------------------------------------------
CASES = {
    "a3": {"page": {"size": "A3", "orientation": "landscape"}, "options": {"show_progress_line": True}},
    "a4": {"page": {"size": "A4", "orientation": "landscape"}},
    "a4p_mono": {"page": {"size": "A4", "orientation": "portrait"}, "options": {"colour": False}},
    "wide2": {"page": {"size": "A3", "orientation": "landscape"}, "options": {"fit_to_pages_wide": 2}},
    "a3_200": {"copies": 3, "max_rows": 200, "options": {"rows_per_page": 100}},
}


def run_runner(cases: dict, tmp: Path, tz: str = "UTC") -> dict:
    payload = {"cases": []}
    for name, c in cases.items():
        payload["cases"].append(dict(c, out=str(tmp / f"{name}.pdf")))
    env = dict(os.environ, TZ=tz)
    proc = subprocess.run([NODE, str(RUNNER)], input=json.dumps(payload), capture_output=True, text=True, env=env, timeout=120)
    assert proc.returncode == 0, proc.stderr
    results = json.loads(proc.stdout)
    out = {}
    for name, r in zip(cases, results):
        assert "error" not in r, r.get("error")
        r["pdf"] = Path(r["out"]).read_bytes()
        out[name] = r
    return out


@pytest.fixture(scope="module")
def rendered(tmp_path_factory):
    return run_runner(CASES, tmp_path_factory.mktemp("pdf"))


def expected_rows_per_page(size: str, orientation: str, rows_per_page=None, margins=10, legend_items=10) -> int:
    a, b = PAGE_SIZES[size]
    w, h = (b, a) if orientation == "landscape" else (a, b)
    usable_w = w - 2 * margins
    strip = 0.0
    if usable_w < LEGEND_INLINE_MIN:
        per_line = max(1, math.floor(usable_w / LEGEND_ITEM))
        strip = 1.6 + math.ceil(legend_items / per_line) * LEGEND_LINE
    body = h - 2 * margins - HEADER - GAP - 3 * TIER - GAP - INFO - strip
    if rows_per_page:
        return rows_per_page
    return max(1, math.floor(body / ROW + 1e-9))


# ----------------------------------------------------------------------------------------
# tests
# ----------------------------------------------------------------------------------------
@pytest.mark.parametrize("name", list(CASES))
def test_structure(rendered, name):
    r = rendered[name]
    pdf = Pdf(r["pdf"])                       # header, xref offsets, trailer, %%EOF
    pages = pdf.pages()
    assert len(pages) == r["layout"]["page_count"]
    for p in pages:
        body = pdf.obj(p)
        assert b"/Type /Page" in body and b"/MediaBox" in body
        content = pdf.page_content(p)         # checks /Length against endstream
        ops = content.split(b"\n")
        assert sum(o.startswith(b"BT ") for o in ops) == sum(o.endswith(b" Tj ET") for o in ops) > 10
        assert ops.count(b"q") == ops.count(b"Q") >= 1  # balanced graphics state (clips)
        # vector only: no images or inline image data
        assert b"/Image" not in body and b" BI" not in content and b"Do\n" not in content
    fonts = [o for o in pdf.objects.values() if b"/Type /Font" in o]
    assert {re.search(rb"/BaseFont /(\S+)", f).group(1) for f in fonts} == {b"Helvetica", b"Helvetica-Bold"}
    assert all(b"/Encoding /WinAnsiEncoding" in f for f in fonts)


@pytest.mark.parametrize("name,size,orientation,wide,rpp", [
    ("a3", "A3", "landscape", 1, None),
    ("a4", "A4", "landscape", 1, None),
    ("a4p_mono", "A4", "portrait", 1, None),
    ("wide2", "A3", "landscape", 2, None),
    ("a3_200", "A3", "landscape", 1, 100),
])
def test_pagination(rendered, name, size, orientation, wide, rpp):
    r = rendered[name]
    legend_items = 11 if name == "a3" else 10       # the progress line adds a legend item
    per_page = expected_rows_per_page(size, orientation, rpp, legend_items=legend_items)
    assert r["layout"]["rows_per_page"] == per_page
    tall = math.ceil(r["rows"] / per_page)
    assert r["layout"]["pages_tall"] == tall and r["layout"]["pages_wide"] == wide
    texts = Pdf(r["pdf"]).page_texts()
    assert len(texts) == tall * wide
    # every page of band g shows exactly the row IDs of rows g*per_page .. (g+1)*per_page-1
    ids = r["row_ids"]
    assert len(set(ids)) == len(ids)
    for g in range(tall):
        band = set(ids[g * per_page:(g + 1) * per_page])
        for c in range(wide):
            page = texts[g * wide + c]
            assert band <= set(page), (g, c, sorted(band - set(page))[:5])
            others = {i for i in set(ids) - band if re.search(r"[A-Z]\d", i)}   # activity IDs, not WBS numbers
            assert not others & set(page), (g, c, sorted(others & set(page))[:5])
            assert f"Page {g * wide + c + 1} of {tall * wide}" in page


def test_page_count_examples(rendered):
    # 92 rows: A3 landscape fits 45 rows a page, A4 landscape 26, A4 portrait 43
    assert rendered["a3"]["rows"] == 92
    assert len(Pdf(rendered["a3"]["pdf"]).pages()) == 3
    assert len(Pdf(rendered["a4"]["pdf"]).pages()) == 4
    assert len(Pdf(rendered["a4p_mono"]["pdf"]).pages()) == 3
    assert len(Pdf(rendered["wide2"]["pdf"]).pages()) == 6
    assert len(Pdf(rendered["a3_200"]["pdf"]).pages()) == 2


def test_expected_text(rendered):
    r = rendered["a3"]
    texts = Pdf(r["pdf"]).page_texts()
    first = texts[0]
    assert PROJECT_NAME in first                      # header and title block
    assert first.count(PROJECT_NAME) >= 2
    assert "Page 1 of 3" in first and "Page 3 of 3" in texts[2]
    assert "Construction programme" in first
    assert "Site set-up, welfare, hoarding and temporary works" in first   # an activity name
    assert "April 2026" in first and "May 2026" in first                  # month labels
    assert "15 Jun 26" in first                       # data date, UK format
    assert "Christmas shutdown 24 Dec – 4 Jan" in first              # whole-chart annotation
    for page in texts:                                # timescale + table header repeat
        assert "Activity name" in page and "April 2026" in page and "Data date" in page
    # title block fields
    assert "C03" in first and "J. Okafor (Planning)" in first and "17 Nov 26 09:30" in first
    assert "Client: Northgate Développements Ltd" in first


def test_horizontal_split(rendered):
    r = rendered["wide2"]
    texts = Pdf(r["pdf"]).page_texts()
    s = r["layout"]["slices"]
    assert len(s) == 2 and s[0]["t1"] == s[1]["t0"]
    assert s[0]["t0"][:10] <= r["range"]["t0"] and s[1]["t1"][:10] > r["range"]["t1"]
    assert any(t.startswith("Sheet 1 of 2 across") for t in texts[0])
    assert any(t.startswith("Sheet 2 of 2 across") for t in texts[1])
    # the table repeats on both sheets; the timescale differs
    assert "Site set-up, welfare, hoarding and temporary works" in texts[0]
    assert "Site set-up, welfare, hoarding and temporary works" in texts[1]
    assert "April 2026" in texts[0] and "April 2026" not in texts[1]
    assert "January 2027" in texts[1]


def test_winansi_round_trip(rendered):
    raw = Pdf(rendered["a3"]["pdf"]).page_content(Pdf(rendered["a3"]["pdf"]).pages()[0])
    # é = 0xE9, — = 0x97, £ = 0xA3, escaped as octal in the literal string
    assert rb"(Riverside Caf\351 & Offices \227 \2432.4m Phase 2) Tj" in raw
    assert raw.isascii()                              # every non-ASCII byte is escaped


def test_encoding_and_metrics():
    script = (
        f"require({json.dumps(str(PDF_JS))});"
        "const P = globalThis.PlannerPDF;"
        "const enc = P.encodeText('£–—‘’“”é€…中\U0001F600x\\ty');"
        "console.log(JSON.stringify({codes: [...enc].map(c => c.charCodeAt(0)),"
        " w: P.textWidth('Hello', 10, false), wb: P.textWidth('Hello', 10, true),"
        " d: [P.formatDate('2026-04-07T23:30:00'), P.formatDate('2027-01-01'), P.formatDate('2026-03-29T00:30:00Z')]}));"
    )
    out = json.loads(subprocess.run([NODE, "-e", script], capture_output=True, text=True, check=True,
                                    env=dict(os.environ, TZ="Pacific/Kiritimati")).stdout)
    assert out["codes"] == [163, 150, 151, 145, 146, 147, 148, 233, 128, 133, 63, 63, 120, 32, 121]
    # AFM: H 722 + e 556 + l 222 + l 222 + o 556 = 2278/1000 em; bold 722+556+278+278+611
    assert out["w"] == pytest.approx(22.78 * 25.4 / 72)
    assert out["wb"] == pytest.approx(24.45 * 25.4 / 72)
    assert out["d"] == ["7 Apr 26", "1 Jan 27", "29 Mar 26"]


def test_size_reasonable(rendered):
    r = rendered["a3_200"]
    assert r["rows"] == 200 and r["layout"]["page_count"] == 2
    assert len(r["pdf"]) < 1_000_000
    for name in ("a3", "a4", "wide2"):
        assert len(rendered[name]["pdf"]) < 600_000


def test_timezone_independent(rendered, tmp_path):
    subset = {k: CASES[k] for k in ("a3", "wide2")}
    for tz in ("America/Santiago", "Australia/Lord_Howe"):
        other = run_runner(subset, tmp_path, tz)
        for k in subset:
            assert other[k]["pdf"] == rendered[k]["pdf"], f"{k} differs under TZ={tz}"


def test_mono_palette(rendered):
    colour = Pdf(rendered["a3"]["pdf"])
    mono = Pdf(rendered["a4p_mono"]["pdf"])
    crit = b"0.85 0.25 0.25 rg"                       # #d93f3f
    assert crit in colour.page_content(colour.pages()[0])
    for p in mono.pages():
        for r_, g_, b_ in re.findall(rb"([\d.]+) ([\d.]+) ([\d.]+) (?:rg|RG)", mono.page_content(p)):
            assert r_ == g_ == b_, "greyscale output must not contain colour"


# ----------------------------------------------------------------------------------------
# a real PDF library, when one is available (this interpreter, another python3, or poppler)
# ----------------------------------------------------------------------------------------
_CHECK = r"""
import json, sys
path = sys.argv[1]
res = {}
import pypdf
r = pypdf.PdfReader(path, strict=True)
res["pages"] = len(r.pages)
res["text"] = r.pages[0].extract_text()
try:
    import pypdfium2 as pdfium
    img = pdfium.PdfDocument(path)[0].render(scale=0.5).to_pil().convert("L")
    hist = img.histogram()
    res["ink"] = sum(hist[:200]) / (img.width * img.height)
except ImportError:
    pass
print(json.dumps(res))
"""


def _pypdf_python():
    cands = [sys.executable, "python3", "python3.13", "python3.12", "python3.11"]
    for c in cands:
        exe = shutil.which(c) if not os.path.isabs(c) else c
        if not exe:
            continue
        ok = subprocess.run([exe, "-c", "import pypdf"], capture_output=True).returncode == 0
        if ok:
            return exe
    return None


def test_parses_with_pdf_library(rendered, tmp_path):
    path = tmp_path / "a3.pdf"
    path.write_bytes(rendered["a3"]["pdf"])
    py = _pypdf_python()
    if py:
        proc = subprocess.run([py, "-c", _CHECK, str(path)], capture_output=True, text=True, timeout=120)
        assert proc.returncode == 0, proc.stderr
        res = json.loads(proc.stdout)
        assert res["pages"] == 3
        text = res["text"]
        assert "Riverside Café" in text and "£2.4m" in text
        assert "Page 1 of 3" in text and "Strip topsoil and reduce levels" in text
        if "ink" in res:
            assert 0.01 < res["ink"] < 0.5, res["ink"]   # rendered, and not a blank or black page
        return
    pdftotext = shutil.which("pdftotext")
    if pdftotext:
        text = subprocess.run([pdftotext, "-layout", str(path), "-"], capture_output=True, text=True, check=True).stdout
        assert "Riverside Café" in text and "Page 1 of 3" in text
        return
    pytest.skip("no pypdf or poppler available")

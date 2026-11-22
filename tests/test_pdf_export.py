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

import base64
import json
import math
import os
import re
import shutil
import struct
import subprocess
import sys
import zlib
from datetime import date, timedelta
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

    def stream(self, num: int, eol: bytes = b"") -> bytes:
        """The stream's data; `eol` is the end-of-line the writer puts before `endstream`
        (none for content streams, b"\\n" for binary image data)."""
        body = self.obj(num)
        length = int(re.search(rb"/Length (\d+)", body).group(1))
        start = body.index(b"stream\n") + len(b"stream\n")
        content = body[start:start + length]
        assert body[start + length:].startswith(eol + b"endstream"), "stream /Length is wrong"
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


# ----------------------------------------------------------------------------------------
# cover (briefing) page: doc.cover
# ----------------------------------------------------------------------------------------
COVER = {
    "title": "Programme briefing",
    "subtitle": "Two-storey detached house, Harrogate · Rev B · issued 9 Mar 2026",
    "headline": "On track: forecast finish 29 Sep 2026, 19 working days inside the 30 Oct 2026 deadline.",
    "paragraphs": [
        "The programme has been reissued at revision B following the two-week slip to the steel frame reported "
        "in February. The fabricator has confirmed delivery for the week commencing 23 March, subject to mill "
        "certificates, and the erection sequence has been re-planned to start at the north gable.",
        "Progress to the data date stands at 6 per cent against 6 per cent planned. Groundworks and the ground-floor "
        "slab are complete; the remaining critical works are the frame, the roof and the envelope, after which the "
        "finishes trades run in parallel. Total float on the finishes is between eight and fifteen working days.",
        "The Christmas shutdown is built into the calendar and the weather allowance for the envelope has been "
        "kept at ten days; this will be reviewed once the roof is watertight.",
        "Risks carried in this revision: late receipt of mill certificates (one week) and a lead time on the "
        "curtain-wall brackets which the subcontractor is yet to confirm in writing.",
    ],
    "kpis": [["Forecast finish", "29 Sep 2026"], ["Deadline", "30 Oct 2026"], ["Progress", "6% (6% expected)"],
             ["Critical activities", "31"]],
    "milestones": [
        {"name": "Start on site", "date": "2026-03-02", "baseline_date": "2026-03-02", "variance_days": 0, "status": "complete"},
        {"name": "Frame complete", "date": "2026-05-15", "baseline_date": "2026-05-01", "variance_days": 10, "status": "late"},
        {"name": "Watertight", "date": "2026-07-17", "baseline_date": "2026-07-10", "variance_days": 5, "status": "late"},
        {"name": "Power on", "date": "2026-08-21", "baseline_date": None, "variance_days": None, "status": ""},
        {"name": "Practical completion", "date": "2026-09-29", "baseline_date": "2026-10-02", "variance_days": -3, "status": "on track"},
    ],
    "watch": [
        {"name": "Steel frame", "text": "Fabricator’s mill certificates outstanding; delivery slips a week if they are not received by 20 March."},
        {"name": "Curtain wall", "text": "Bracket lead time not yet confirmed in writing by the subcontractor."},
        {"name": "Boundary wall", "text": "Asbestos survey of the retained wall due this week."},
    ],
    "footer": "Prepared by Graeme · Printed 9 Mar 2026 14:02",
}

_FILLER = (" This sentence is here only to make the paragraph a great deal longer than any reasonable briefing"
           " would be, so that the writer has to cut it.")
LONG_COVER = dict(
    COVER,
    headline="A very long headline that goes on and on. " * 12,
    paragraphs=[f"Paragraph {i + 1}." + _FILLER * 8 + f" UNIQUE-END-{i + 1}." for i in range(12)],
    kpis=[[f"KPI label {i + 1}", f"Value number {i + 1}"] for i in range(8)],
    milestones=[{"name": f"Milestone number {i + 1}", "date": f"2026-0{1 + i % 9}-1{i % 9}",
                 "baseline_date": "2026-05-01" if i % 2 else None, "variance_days": i if i % 2 else None,
                 "status": "late" if i % 3 else "on track"} for i in range(25)],
    watch=[{"name": f"Watch item {i + 1} with a fairly long name",
            "text": "A long explanation that goes on and on, far further than one line could hold on an A4 "
                    "sheet, so it has to wrap and then be cut." * 2} for i in range(10)],
)

_COVER_SCRIPT = r"""
const fs = require('fs');
const [pdfJs, docPath, coverPath, out] = process.argv.slice(1);
require(pdfJs);
const P = globalThis.PlannerPDF;
const doc = JSON.parse(fs.readFileSync(docPath, 'utf8'));
const base = P.layout(doc);
doc.cover = JSON.parse(fs.readFileSync(coverPath, 'utf8'));
const bytes = P.render(doc);
fs.writeFileSync(out, bytes);
process.stdout.write(JSON.stringify({ base, layout: P.layout(doc), bytes: bytes.length, rows: doc.rows.length,
  first_row: doc.rows[0].cells[1] }));
"""


def render_cover(tmp: Path, cover, page=None, options=None) -> dict:
    """The runner's programme (via doc_out) with `cover` attached, rendered by PlannerPDF."""
    case = {"doc_out": str(tmp / "doc.json")}
    if page:
        case["page"] = page
    if options:
        case["options"] = options
    run_runner({"base": case}, tmp)
    (tmp / "cover.json").write_text(json.dumps(cover), encoding="utf-8")
    out = tmp / "cover.pdf"
    proc = subprocess.run([NODE, "-e", _COVER_SCRIPT, str(PDF_JS), str(tmp / "doc.json"), str(tmp / "cover.json"), str(out)],
                          capture_output=True, text=True, timeout=120, env=dict(os.environ, TZ="UTC"))
    assert proc.returncode == 0, proc.stderr
    r = json.loads(proc.stdout)
    r["pdf"] = out.read_bytes()
    return r


def text_positions(content: bytes, w_mm: float, h_mm: float) -> list[tuple[float, float]]:
    """(x, y) in mm from the top-left for every text string drawn in a content stream."""
    pts = [(float(x), float(y)) for x, y in re.findall(rb"Tf ([-\d.]+) ([-\d.]+) Td \(", content)]
    return [(x * 25.4 / 72, h_mm - y * 25.4 / 72) for x, y in pts]


def test_cover_page(tmp_path):
    r = render_cover(tmp_path, COVER, page={"size": "A3", "orientation": "landscape"})
    L, base = r["layout"], r["base"]
    assert base["cover"] is False and base["cover_pages"] == 0
    assert L["cover"] is True and L["cover_pages"] == 1
    assert L["page_count"] == base["page_count"] + 1 == 4
    assert L["pages"] == L["page_count"]                      # app.js reads `pages || page_count` as a number
    assert L["rows_per_page"] == base["rows_per_page"] and L["pages_tall"] == base["pages_tall"]
    pdf = Pdf(r["pdf"])
    pages = pdf.pages()
    assert len(pages) == 4
    texts = pdf.page_texts()
    first, joined = texts[0], " ".join(texts[0])
    # heading, headline, a KPI value, a milestone (with its baseline and variance), the watch text
    assert "Programme briefing" in first
    assert "Two-storey detached house, Harrogate · Rev B · issued 9 Mar 2026" in first
    assert COVER["headline"] in joined
    assert "29 Sep 2026" in first and "Forecast finish" in first and "6% (6% expected)" in first
    assert "Watertight" in first and "17 Jul 26" in first and "10 Jul 26" in first and "+5d" in first and "-3d" in first
    assert "Milestone" in first and "Date" in first and first.count("Baseline") == 2 and "Var" in first   # table + legend
    assert "Steel frame" in first and "Curtain wall" in first
    assert "Bracket lead time not yet confirmed in writing by the subcontractor." in joined
    assert "Prepared by Graeme · Printed 9 Mar 2026 14:02" in first
    assert "Fabricator’s mill certificates outstanding" in joined          # curly quote survives WinAnsi
    # the full paragraphs are on the page, uncut
    for para in COVER["paragraphs"]:
        assert para in joined
    assert not any(t.endswith("…") for t in first)
    # same title block as the other pages: Page 1 of N, project and issue details
    assert "Page 1 of 4" in first and PROJECT_NAME in first and "C03" in first and "J. Okafor (Planning)" in first
    assert "Briefing" in first
    # the Gantt pages follow, renumbered, with their row bands intact
    assert "Page 2 of 4" in texts[1] and r["first_row"] in texts[1] and "Page 4 of 4" in texts[3]
    assert any(t.startswith("Rows 1") for t in texts[1])
    assert "Programme briefing" not in texts[1]
    # a well-formed vector page: balanced clip, text ops only, every string inside the content area
    content = pdf.page_content(pages[0])
    ops = content.split(b"\n")
    assert ops.count(b"q") == ops.count(b"Q") >= 1
    assert sum(o.startswith(b"BT ") for o in ops) == sum(o.endswith(b" Tj ET") for o in ops) > 40
    for x, y in text_positions(content, L["page_w_mm"], L["page_h_mm"]):
        assert 10 <= x <= L["page_w_mm"] - 10 + 0.01 and 10 <= y <= L["page_h_mm"] - 10 + 0.01, (x, y)


def test_cover_without_baseline_omits_columns(tmp_path):
    cover = dict(COVER, milestones=[dict(m, baseline_date=None, variance_days=None) for m in COVER["milestones"]])
    r = render_cover(tmp_path, cover, page={"size": "A4", "orientation": "landscape"})
    first = Pdf(r["pdf"]).page_texts()[0]
    assert "Watertight" in first and "17 Jul 26" in first
    assert first.count("Baseline") == 1 and "Var" not in first and "10 Jul 26" not in first   # legend only


@pytest.mark.parametrize("size,orientation,colour", [("A4", "portrait", False), ("A3", "landscape", True), ("A4", "landscape", True)])
def test_cover_overflow_is_truncated(tmp_path, size, orientation, colour):
    r = render_cover(tmp_path, LONG_COVER, page={"size": size, "orientation": orientation}, options={"colour": colour})
    L = r["layout"]
    assert L["page_count"] == r["base"]["page_count"] + 1
    assert L["page_w_mm"] == PAGE_SIZES[size][0 if orientation == "portrait" else 1]
    pdf = Pdf(r["pdf"])
    pages = pdf.pages()
    assert len(pages) == L["page_count"]
    first, joined = pdf.page_texts()[0], " ".join(pdf.page_texts()[0])
    assert "Page 1 of %d" % L["page_count"] in first and "Programme briefing" in first
    # the text was cut with an ellipsis rather than drawn off the page
    assert any(t.endswith("…") for t in first)
    assert "Paragraph 1." in joined and "UNIQUE-END-12." not in joined
    # at most 6 KPI tiles, 6 watch items, 18 milestone rows followed by "and N more"
    assert "Value number 6" in first and "Value number 7" not in first
    assert any(t.startswith("Watch item 6") for t in first) and not any(t.startswith("Watch item 7") for t in first)
    shown = [m for m in LONG_COVER["milestones"] if m["name"] in first]
    assert 1 <= len(shown) <= 18 and shown == LONG_COVER["milestones"][:len(shown)]
    assert f"and {25 - len(shown)} more" in first
    # every string sits inside the margins; nothing spills past the title block
    content = pdf.page_content(pages[0])
    for x, y in text_positions(content, L["page_w_mm"], L["page_h_mm"]):
        assert 10 <= x <= L["page_w_mm"] - 10 + 0.01 and 10 <= y <= L["page_h_mm"] - 10 + 0.01, (x, y)
    ops = content.split(b"\n")
    assert ops.count(b"q") == ops.count(b"Q") >= 1
    if not colour:
        for r_, g_, b_ in re.findall(rb"([\d.]+) ([\d.]+) ([\d.]+) (?:rg|RG)", content):
            assert r_ == g_ == b_, "greyscale cover must not contain colour"


def test_cover_minimal_and_absent(tmp_path):
    # a bare cover still renders as a full page; cover: null / false / {} absent means no page
    r = render_cover(tmp_path, {"title": "Programme briefing"})
    assert r["layout"]["page_count"] == r["base"]["page_count"] + 1
    first = Pdf(r["pdf"]).page_texts()[0]
    assert "Programme briefing" in first and "Page 1 of %d" % r["layout"]["page_count"] in first
    for absent in (None, False):
        r2 = render_cover(tmp_path, absent)
        assert r2["layout"]["page_count"] == r2["base"]["page_count"] and r2["layout"]["cover"] is False
        assert len(Pdf(r2["pdf"]).pages()) == r2["base"]["page_count"]


def test_cover_parses_with_pdf_library(tmp_path):
    r = render_cover(tmp_path, COVER, page={"size": "A3", "orientation": "landscape"})
    path = tmp_path / "cover_a3.pdf"
    path.write_bytes(r["pdf"])
    py = _pypdf_python()
    if py:
        proc = subprocess.run([py, "-c", _CHECK, str(path)], capture_output=True, text=True, timeout=120)
        assert proc.returncode == 0, proc.stderr
        res = json.loads(proc.stdout)
        assert res["pages"] == 4
        text = res["text"]
        for s in ("Programme briefing", "29 Sep 2026", "Watertight", "Curtain wall", "Page 1 of 4", "Riverside Café"):
            assert s in text, s
        if "ink" in res:
            assert 0.01 < res["ink"] < 0.5, res["ink"]
        return
    pdftotext = shutil.which("pdftotext")
    if pdftotext:
        text = subprocess.run([pdftotext, "-f", "1", "-l", "1", "-layout", str(path), "-"], capture_output=True, text=True, check=True).stdout
        assert "Programme briefing" in text and "Watertight" in text and "Page 1 of 4" in text
        return
    pytest.skip("no pypdf or poppler available")


# ----------------------------------------------------------------------------------------
# fit to pages tall, page breaks before groups, selected rows only, legend items and row
# colours, period lines, logo, title-block layouts
# ----------------------------------------------------------------------------------------
_PATCH_SCRIPT = r"""
const fs = require('fs');
const [pdfJs, docPath, patchPath, out] = process.argv.slice(1);
require(pdfJs);
const P = globalThis.PlannerPDF;
const doc = JSON.parse(fs.readFileSync(docPath, 'utf8'));
const patch = JSON.parse(fs.readFileSync(patchPath, 'utf8'));
const base = P.layout(doc);
Object.assign(doc.options, patch.options || {});
Object.assign(doc.meta, patch.meta || {});
if (patch.page) Object.assign(doc.page, patch.page);
if (patch.period_lines) doc.period_lines = patch.period_lines;
if (patch.shading) doc.shading = patch.shading;
if (patch.reports) doc.reports = patch.reports;
if (patch.charts) doc.charts = patch.charts;
if (patch.cover) doc.cover = patch.cover;
for (const [i, r] of Object.entries(patch.rows || {})) Object.assign(doc.rows[+i], r);
let error = null, layout = null;
try { const bytes = P.render(doc); fs.writeFileSync(out, bytes); layout = P.layout(doc); } catch (e) { error = String(e.message || e); }
process.stdout.write(JSON.stringify({ base, layout, error, data_date: doc.meta.data_date, range: doc.range,
  rows: doc.rows.map(r => ({ kind: r.kind, depth: r.depth, id: r.cells[0], name: r.cells[1], start: r.start, finish: r.finish, pct: r.pct })) }));
"""

# a 1 x 1 baseline greyscale JPEG written by hand: DQT (all ones), SOF0, one-code DC and AC
# Huffman tables, SOS and a single byte of scan data (DC category 0, then EOB)
JPEG_1PX = (b"\xff\xd8" + b"\xff\xdb\x00\x43\x00" + b"\x01" * 64
            + b"\xff\xc0\x00\x0b\x08\x00\x01\x00\x01\x01\x01\x11\x00"
            + b"\xff\xc4\x00\x14\x00" + b"\x01" + b"\x00" * 15 + b"\x00"
            + b"\xff\xc4\x00\x14\x10" + b"\x01" + b"\x00" * 15 + b"\x00"
            + b"\xff\xda\x00\x08\x01\x01\x00\x00\x3f\x00" + b"\x3f" + b"\xff\xd9")
PNG_ROW = bytes([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 0])      # 4 RGB pixels: red, green, blue, yellow


def make_png(width=4, height=3, colour_type=2, interlace=0) -> bytes:
    """A small 8-bit PNG built with zlib only (filter byte 0 on every row)."""
    bpp = {0: 1, 2: 3, 4: 2, 6: 4}[colour_type]
    if colour_type == 2:
        row = b"\x00" + PNG_ROW[:width * 3]
    else:
        row = b"\x00" + bytes((x * 61 + c * 17) % 256 for x in range(width) for c in range(bpp))

    def chunk(tag, body):
        return struct.pack(">I", len(body)) + tag + body + struct.pack(">I", zlib.crc32(tag + body) & 0xFFFFFFFF)
    ihdr = struct.pack(">IIBBBBB", width, height, 8, colour_type, 0, 0, interlace)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(row * height)) + chunk(b"IEND", b"")


def b64(data: bytes) -> str:
    return base64.b64encode(data).decode()


def render_patched(tmp: Path, patch: dict, page=None, options=None, copies=None) -> dict:
    """The runner's programme (via doc_out) with `patch` applied (options, meta, page, period_lines,
    reports, charts, cover, rows: {index: fields}), rendered by PlannerPDF. `error` carries a render
    exception's message; `base` is the layout before the patch and base.pdf the runner's own render
    of the document."""
    tmp.mkdir(parents=True, exist_ok=True)
    case = {"doc_out": str(tmp / "doc.json")}
    if page:
        case["page"] = page
    if options:
        case["options"] = options
    if copies:
        case["copies"] = copies
    run_runner({"base": case}, tmp)
    (tmp / "patch.json").write_text(json.dumps(patch), encoding="utf-8")
    out = tmp / "patched.pdf"
    if out.exists():
        out.unlink()
    proc = subprocess.run([NODE, "-e", _PATCH_SCRIPT, str(PDF_JS), str(tmp / "doc.json"), str(tmp / "patch.json"), str(out)],
                          capture_output=True, text=True, timeout=120, env=dict(os.environ, TZ="UTC"))
    assert proc.returncode == 0, proc.stderr
    r = json.loads(proc.stdout)
    r["pdf"] = out.read_bytes() if out.exists() else b""
    return r


def body_height(size: str, orientation: str, legend_items=10, info=INFO, margins=10) -> float:
    """Chart body height in mm, as plan() computes it (the legend strip applies on narrow sheets,
    with more than 12 legend entries, or in the compact / wide title layouts)."""
    a, b = PAGE_SIZES[size]
    w, h = (b, a) if orientation == "landscape" else (a, b)
    usable_w = w - 2 * margins
    strip = 0.0
    if usable_w < LEGEND_INLINE_MIN or legend_items > 12 or info != INFO:
        per_line = max(1, math.floor(usable_w / LEGEND_ITEM))
        strip = 1.6 + math.ceil(legend_items / per_line) * LEGEND_LINE
    return h - 2 * margins - HEADER - GAP - 3 * TIER - GAP - info - strip


def colour_op(hex_colour: str, shade=0.0, op="rg") -> bytes:
    """The content-stream operator PlannerPDF writes for a colour (optionally mixed towards black)."""
    def comp(i):
        v = int(hex_colour[i:i + 2], 16) / 255
        if shade:
            v = round(v * (1 - shade) * 255) / 255
        return str(math.floor(v * 100 + 0.5) / 100)
    return (" ".join(comp(i) for i in (1, 3, 5)) + " " + op).encode()


def texts_with_positions(content: bytes, h_mm: float) -> list[tuple[str, float, float, float]]:
    """(string, x_mm, y_mm, pt) for every text drawn in a content stream."""
    out = []
    for pt, x, y, raw in re.findall(rb"/F[12] ([\d.]+) Tf ([-\d.]+) ([-\d.]+) Td \(((?:\\.|[^\\)])*)\) Tj", content, re.S):
        out.append((unescape(raw).decode("cp1252"), float(x) * 25.4 / 72, h_mm - float(y) * 25.4 / 72, float(pt)))
    return out


def assert_inside_margins(pdf: Pdf, L: dict):
    for p in pdf.pages():
        for x, y in text_positions(pdf.page_content(p), L["page_w_mm"], L["page_h_mm"]):
            assert 10 <= x <= L["page_w_mm"] - 10 + 0.01 and 10 <= y <= L["page_h_mm"] - 10 + 0.01, (x, y)


def test_fit_to_pages_tall(tmp_path):
    r = run_runner({
        "fit2": {"copies": 2, "max_rows": 120, "options": {"fit_to_pages_tall": 2}},
        "fit1000": {"copies": 11, "max_rows": 1000, "page": {"size": "A4", "orientation": "landscape"}, "options": {"fit_to_pages_tall": 1}},
        "fit_easy": {"options": {"fit_to_pages_tall": 5}},
    }, tmp_path)
    # 120 rows on two A3 pages: 60 rows a page, rows shrunk to fit but above the 3.2 mm floor
    L = r["fit2"]["layout"]
    assert r["fit2"]["rows"] == 120
    assert L["fit_to_pages_tall"] == 2 and L["fits"] is True
    assert L["rows_per_page"] == 60 and L["pages_tall"] == 2 and L["page_count"] == 2
    assert L["row_height_mm"] == pytest.approx(body_height("A3", "landscape") / 60) and 3.2 <= L["row_height_mm"] < 5
    assert L["bands"] == [{"first": 0, "last": 60}, {"first": 60, "last": 120}]
    pdf = Pdf(r["fit2"]["pdf"])
    texts = pdf.page_texts()
    assert len(texts) == 2
    ids = r["fit2"]["row_ids"]
    assert set(ids[:60]) <= set(texts[0]) and set(ids[60:]) <= set(texts[1])
    assert "Page 2 of 2" in texts[1] and any(t.startswith("Rows 61") for t in texts[1])
    # 1000 rows cannot fit one A4 page: the floor applies and the layout says so honestly
    L = r["fit1000"]["layout"]
    assert r["fit1000"]["rows"] == 1000
    assert L["fits"] is False and L["fit_to_pages_tall"] == 1
    max_rpp = math.floor(body_height("A4", "landscape") / 3.2 + 1e-9)
    assert L["rows_per_page"] == max_rpp
    assert 3.2 <= L["row_height_mm"] < 3.3
    pdf = Pdf(r["fit1000"]["pdf"])
    assert L["pages_tall"] == math.ceil(1000 / max_rpp) == L["page_count"] == len(pdf.pages())
    # text never drops below 6 pt in fit mode: the activity names on page 1 are 6 pt
    content = pdf.page_content(pdf.pages()[0])
    sizes = {pt for s, _x, _y, pt in texts_with_positions(content, L["page_h_mm"]) if s == "Strip topsoil and reduce levels (Block A)"}
    assert sizes == {6.0}
    # a budget larger than needed changes nothing
    L = r["fit_easy"]["layout"]
    assert L["fits"] is True and L["rows_per_page"] == 45 and L["row_height_mm"] == 5 and L["pages_tall"] == 3


def test_page_break_before_groups(rendered, tmp_path):
    r = run_runner({"brk": {"options": {"page_break_before_groups": True}}}, tmp_path)["brk"]
    L, kinds, names = r["layout"], r["row_kinds"], r["row_names"]
    groups = [i for i, k in enumerate(kinds) if k == "summary"]
    assert len(groups) > 3 and groups[0] == 0
    # every group starts a page; a group longer than a page (45 rows) continues on the next
    starts = [b["first"] for b in L["bands"]]
    assert set(groups) <= set(starts) and L["rows_per_page"] == 45
    for k, b in enumerate(L["bands"]):
        assert b["last"] - b["first"] <= 45
        if b["first"] not in groups:
            assert L["bands"][k - 1]["last"] - L["bands"][k - 1]["first"] == 45
    assert len(groups) <= L["page_count"] == len(L["bands"]) and L["page_count"] > rendered["a3"]["layout"]["page_count"]
    assert L["bands"][-1]["last"] == r["rows"]
    pdf = Pdf(r["pdf"])
    pages = pdf.pages()
    texts = pdf.page_texts()
    assert len(pages) == L["page_count"]
    ids = r["row_ids"]
    for g, (band, page) in enumerate(zip(L["bands"], pages)):
        band_names = names[band["first"]:band["last"]]
        assert set(ids[band["first"]:band["last"]]) <= set(texts[g])
        others = {i for i in set(ids) - set(ids[band["first"]:band["last"]]) if re.search(r"[A-Z]\d", i)}
        assert not others & set(texts[g])
        if g:
            assert names[band["first"]] not in texts[g - 1]
        # the group title is the topmost row of its page
        if band["first"] in groups:
            assert kinds[band["first"]] == "summary"
            pos = {s: y for s, _x, y, _pt in texts_with_positions(pdf.page_content(page), L["page_h_mm"]) if s in band_names}
            assert pos[names[band["first"]]] == min(pos.values())
        assert f"Page {g + 1} of {L['page_count']}" in texts[g]


def test_page_breaks_with_fit_to_pages(tmp_path):
    # fit_to_pages_tall counts the pages the breaks produce: 8 groups cannot fit 2 pages
    r = render_patched(tmp_path, {"options": {"page_break_before_groups": True, "fit_to_pages_tall": 2}})
    L = r["layout"]
    assert L["fits"] is False and 2 < L["pages_tall"] <= 8
    assert all(r["rows"][b["first"]]["kind"] == "summary" for b in L["bands"])
    r = render_patched(tmp_path, {"options": {"page_break_before_groups": True, "fit_to_pages_tall": 10}})
    assert r["layout"]["fits"] is True and r["layout"]["pages_tall"] == 8 and r["layout"]["row_height_mm"] == 5


def test_selected_only(tmp_path):
    base = render_patched(tmp_path, {})
    rows = base["rows"]
    groups = [i for i, r in enumerate(rows) if r["kind"] == "summary"]
    # nest part of the second group: a sub-summary with two children beneath it
    sub = groups[1] + 2
    patch_rows = {str(sub): {"kind": "summary", "depth": 1}, str(sub + 1): {"depth": 2}, str(sub + 2): {"depth": 2, "selected": True},
                  str(groups[3] + 1): {"selected": True}, str(groups[3] + 3): {"selected": True}}
    r = render_patched(tmp_path, {"options": {"selected_only": True}, "rows": patch_rows})
    L = r["layout"]
    kept = sorted({sub + 2, groups[1], sub, groups[3] + 1, groups[3] + 3, groups[3]})
    assert L["rows"] == len(kept) == 6 and L["page_count"] == 1 < base["layout"]["page_count"]
    pdf = Pdf(r["pdf"])
    first = pdf.page_texts()[0]
    for i in kept:
        assert rows[i]["name"] in first, rows[i]["name"]
    dropped = [rows[i]["name"] for i in range(len(rows)) if i not in kept]
    assert dropped and not any(n in first for n in dropped)
    # the kept rows print in their original order
    ys = {s: y for s, _x, y, _pt in texts_with_positions(pdf.page_content(pdf.pages()[0]), L["page_h_mm"]) if s in {rows[i]["name"] for i in kept}}
    assert [n for n, _ in sorted(ys.items(), key=lambda kv: kv[1])] == [rows[i]["name"] for i in kept]
    # selected_only with nothing selected prints everything
    r = render_patched(tmp_path, {"options": {"selected_only": True}})
    assert r["layout"]["rows"] == len(rows) and r["layout"]["page_count"] == base["layout"]["page_count"]


def test_legend_items_and_row_colours(tmp_path):
    items = [{"label": "Groundworks", "colour": "#8a5a2b"}, {"label": "Frame", "colour": "#2b6a8a"}, {"label": "Envelope", "colour": "#5a8a2b"},
             {"label": "Fit-out", "colour": "#8a2b6a"}, {"label": "M&E", "colour": "#c28a1a"}]
    r = run_runner({"leg": {"options": {"legend_items": items}}, "leg2": {"options": {"legend_items": items[:2]}}}, tmp_path)
    # 15 legend entries leave the info strip and wrap into two rows above it; 12 stay inline
    L = r["leg"]["layout"]
    assert L["rows_per_page"] == math.floor(body_height("A3", "landscape", legend_items=15) / ROW + 1e-9) == 43
    assert L["title_block_mm"] == pytest.approx(INFO + 1.6 + 2 * LEGEND_LINE)
    assert r["leg2"]["layout"]["rows_per_page"] == 45 and r["leg2"]["layout"]["title_block_mm"] == INFO
    for name in ("leg", "leg2"):
        pdf = Pdf(r[name]["pdf"])
        shown = items if name == "leg" else items[:2]
        for page, p in zip(pdf.page_texts(), pdf.pages()):
            for it in shown:
                assert it["label"] in page
            assert "Critical activity" in page and "Milestone" in page
            assert colour_op("#8a5a2b") in pdf.page_content(p)              # the Groundworks swatch
        assert_inside_margins(pdf, r[name]["layout"])
    # a row colour replaces the bar fill (and shades the progress and edge); mono output greys it
    base = render_patched(tmp_path, {})
    task = next(i for i, row in enumerate(base["rows"]) if row["kind"] == "task" and 0 < row["pct"] < 100)
    r2 = render_patched(tmp_path, {"rows": {str(task): {"colour": "#c28a1a"}}})
    content = Pdf(r2["pdf"]).page_content(Pdf(r2["pdf"]).pages()[0])
    assert colour_op("#c28a1a") in content and colour_op("#c28a1a", 0.45) in content and colour_op("#c28a1a", 0.3, "RG") in content
    assert colour_op("#c28a1a") not in Pdf(base["pdf"]).page_content(Pdf(base["pdf"]).pages()[0])
    r3 = render_patched(tmp_path, {"rows": {str(task): {"colour": "#c28a1a"}}, "options": {"colour": False, "legend_items": items}})
    mono = Pdf(r3["pdf"])
    for p in mono.pages():
        for r_, g_, b_ in re.findall(rb"([\d.]+) ([\d.]+) ([\d.]+) (?:rg|RG)", mono.page_content(p)):
            assert r_ == g_ == b_, "greyscale output must not contain colour"


def test_period_lines(tmp_path):
    base = render_patched(tmp_path, {})
    rows, d0 = base["rows"], date.fromisoformat(base["data_date"][:10])
    p2, p1 = (d0 - timedelta(days=28)).isoformat(), (d0 - timedelta(days=56)).isoformat()
    tasks = [i for i, r in enumerate(rows) if r["kind"] == "task" and r["start"]][:6]
    points = [{"row": i, "x_date": (d0 - timedelta(days=33)).isoformat()} for i in tasks]
    assert len(points) >= 3
    lines = [{"label": "Period 2 (to " + p2 + ")", "date": p2, "points": points}, {"label": "Period 1", "date": p1, "points": [], "colour": "#aa3366"}]
    r = render_patched(tmp_path, {"period_lines": lines, "options": {"show_progress_line": True}})
    L = r["layout"]
    assert r["error"] is None and L["page_count"] == base["layout"]["page_count"]
    pdf = Pdf(r["pdf"])
    pages = pdf.pages()
    texts = pdf.page_texts()
    assert "Period 2 (to " + p2 + ")" in texts[0] and "Period 1" in texts[0]
    content = pdf.page_content(pages[0])
    ops = content.split(b"\n")
    # the first line: dashed, the first muted colour, one jog (three segments) per point on the page
    i = ops.index(colour_op("#6b8e6b", 0, "RG"))
    stroke = next(o for o in ops[i:i + 4] if o.endswith(b" S"))
    assert b"[3.4 2.27] 0 d" in ops[i:i + 4]                              # dash [1.2 0.8] mm
    on_page = [p for p in points if p["row"] < L["rows_per_page"]]
    assert len(on_page) >= 3 and stroke.count(b" l") == 3 * len(on_page) + 1
    # the second line in its own colour, straight; both before the current progress line
    j = ops.index(colour_op("#aa3366", 0, "RG"))
    assert next(o for o in ops[j:j + 4] if o.endswith(b" S")).count(b" l") == 1
    assert ops.index(colour_op("#8b5cf6", 0, "RG")) > max(i, j)
    # every page carries the lines (the dates are on every page's timescale); none in the base document
    assert all(b"[3.4 2.27] 0 d" in pdf.page_content(p) for p in pages)
    assert b"[3.4 2.27] 0 d" not in Pdf(base["pdf"]).page_content(Pdf(base["pdf"]).pages()[0])


def test_logo_jpeg(tmp_path):
    logo = {"data": b64(JPEG_1PX), "type": "jpeg", "width_mm": 24, "height_mm": 12}
    r = render_patched(tmp_path, {"meta": {"logo": logo}})
    assert r["error"] is None and r["layout"]["logo"] is True and r["layout"]["page_count"] == r["base"]["page_count"]
    pdf = Pdf(r["pdf"])
    images = [num for num, o in pdf.objects.items() if b"/Subtype /Image" in o]
    assert len(images) == 1
    im = pdf.obj(images[0])
    assert b"/Width 1 /Height 1" in im and b"/ColorSpace /DeviceGray" in im and b"/Filter /DCTDecode" in im
    assert pdf.stream(images[0], eol=b"\n") == JPEG_1PX
    for p in pdf.pages():
        body = pdf.obj(p)
        assert b"/XObject << /Im1 %d 0 R >>" % images[0] in body and b"/ImageC" in body
        content = pdf.page_content(p)
        ops = content.split(b"\n")
        assert ops.count(b"q") == ops.count(b"Q")
        cms = re.findall(rb"([\d.]+) 0 0 ([\d.]+) ([\d.]+) ([\d.]+) cm /Im1 Do", content)
        assert len(cms) == 1
        w, h, x, _y = (float(v) * 25.4 / 72 for v in cms[0])
        assert (w, h) == pytest.approx((24, 12), abs=0.01) and x == pytest.approx(11.5, abs=0.01)   # at the left of the project cell
    assert PROJECT_NAME in pdf.page_texts()[0]
    assert_inside_margins(pdf, r["layout"])
    py = _pypdf_python()
    if py:
        path = tmp_path / "logo.pdf"
        path.write_bytes(r["pdf"])
        check = ("import pypdf, sys; r = pypdf.PdfReader(sys.argv[1], strict=True); x = r.pages[0]['/Resources']['/XObject']['/Im1'].get_object();"
                 " print(len(r.pages), x['/Width'], len(x.get_data()))")
        proc = subprocess.run([py, "-c", check, str(path)], capture_output=True, text=True, timeout=120)
        assert proc.returncode == 0, proc.stderr
        assert proc.stdout.split() == [str(r["layout"]["page_count"]), "1", str(len(JPEG_1PX))]


def test_logo_png(tmp_path):
    r = render_patched(tmp_path, {"meta": {"logo": {"data": "data:image/png;base64," + b64(make_png()), "type": "png", "height_mm": 9}}})
    assert r["error"] is None
    pdf = Pdf(r["pdf"])
    images = [num for num, o in pdf.objects.items() if b"/Subtype /Image" in o]
    assert len(images) == 1
    im = pdf.obj(images[0])
    assert b"/Width 4 /Height 3" in im and b"/ColorSpace /DeviceRGB" in im and b"/BitsPerComponent 8" in im
    assert b"/Filter /FlateDecode /DecodeParms << /Predictor 15 /Colors 3 /BitsPerComponent 8 /Columns 4 >>" in im
    content = pdf.page_content(pdf.pages()[0])
    cms = re.findall(rb"([\d.]+) 0 0 ([\d.]+) ([\d.]+) ([\d.]+) cm /Im1 Do", content)
    assert len(cms) == 1 and float(cms[0][0]) / float(cms[0][1]) == pytest.approx(4 / 3, abs=0.01)   # width from the pixel aspect
    py = _pypdf_python()
    if py:   # FlateDecode with the PNG predictor yields the pixel rows exactly
        path = tmp_path / "logo_png.pdf"
        path.write_bytes(r["pdf"])
        check = ("import pypdf, sys; r = pypdf.PdfReader(sys.argv[1], strict=True);"
                 " sys.stdout.buffer.write(r.pages[0]['/Resources']['/XObject']['/Im1'].get_object().get_data())")
        proc = subprocess.run([py, "-c", check, str(path)], capture_output=True, timeout=120)
        assert proc.returncode == 0, proc.stderr
        assert proc.stdout == PNG_ROW * 3
    # images the writer cannot embed are refused with a clear message and no file
    for data, msg in ((make_png(colour_type=6), "alpha"), (make_png(interlace=1), "interlaced"), (b"not an image at all, honestly", "not a JPEG or PNG")):
        r = render_patched(tmp_path, {"meta": {"logo": {"data": b64(data), "type": "png"}}})
        assert r["error"] and msg in r["error"], r["error"]
        assert r["pdf"] == b""


@pytest.mark.parametrize("layout_name", ["standard", "compact", "wide"])
@pytest.mark.parametrize("size,orientation", [("A3", "landscape"), ("A4", "portrait")])
def test_title_layouts(tmp_path, layout_name, size, orientation):
    logo = {"data": b64(JPEG_1PX), "type": "jpeg", "width_mm": 20, "height_mm": 10}
    r = render_patched(tmp_path, {"meta": {"title_layout": layout_name, "logo": logo}, "page": {"size": size, "orientation": orientation},
                                  "options": {"show_progress_line": True}})
    assert r["error"] is None, r["error"]
    L = r["layout"]
    assert L["title_layout"] == layout_name
    a, b = PAGE_SIZES[size]
    usable_w = (b if orientation == "landscape" else a) - 20
    strip = 1.6 + math.ceil(11 / max(1, math.floor(usable_w / LEGEND_ITEM))) * LEGEND_LINE
    inline = layout_name == "standard" and usable_w >= LEGEND_INLINE_MIN
    assert L["title_block_mm"] == pytest.approx((8 if layout_name == "compact" else INFO) + (0 if inline else strip))
    assert L["rows_per_page"] == max(1, math.floor(L["body_height_mm"] / ROW + 1e-9))
    pdf = Pdf(r["pdf"])
    pages = pdf.pages()
    assert len(pages) == L["page_count"]
    tb_top = L["page_h_mm"] - 10 - L["title_block_mm"]
    for g, (p, page) in enumerate(zip(pages, pdf.page_texts())):
        joined = " | ".join(page)
        assert f"Page {g + 1} of {L['page_count']}" in page
        assert PROJECT_NAME in page and "Critical activity" in page and "Progress line" in page
        assert "15 Jun 26" in joined and "C03" in joined
        if layout_name == "compact":
            assert "DATES" in page and "ISSUE" in page and any(t.startswith("Data date 15 Jun 26") for t in page)
            assert "PROGRAMME DATES" not in page
            assert not any(t.endswith("…") for t in page if t.startswith(("Data date", "Rev ")))   # parts dropped, never cut
            if usable_w >= 260:
                assert "Forecast 23 Apr 27" in joined and "Printed 17 Nov 26" in joined
        else:
            assert "PROGRAMME DATES" in page and "J. Okafor (Planning)" in page and "17 Nov 26 09:30" in page
        content = pdf.page_content(p)
        assert len(re.findall(rb"cm /Im1 Do", content)) == 1
        ops = content.split(b"\n")
        assert ops.count(b"q") == ops.count(b"Q") >= 1
        # every string inside the margins; the title block's labels and legend inside the block
        for s, x, y, _pt in texts_with_positions(content, L["page_h_mm"]):
            assert 10 <= x <= L["page_w_mm"] - 10 + 0.01 and 10 <= y <= L["page_h_mm"] - 10 + 0.01, (s, x, y)
            if s in ("PROJECT", "ISSUE", "SHEET", "DATES", "PROGRAMME DATES", "Critical activity", "Progress line"):
                assert tb_top <= y <= L["page_h_mm"] - 10, (s, y)


def test_new_options_leave_defaults_unchanged(tmp_path):
    # explicit defaults for every new option render byte-for-byte what the plain document renders
    r = render_patched(tmp_path, {"options": {"fit_to_pages_tall": None, "page_break_before_groups": False, "selected_only": False, "legend_items": []},
                                  "meta": {"title_layout": "standard", "logo": None}, "period_lines": []})
    assert r["error"] is None
    assert r["pdf"] == (tmp_path / "base.pdf").read_bytes()
    L = r["layout"]
    assert L["page_count"] == r["base"]["page_count"] and L["fits"] is True and L["fit_to_pages_tall"] is None and L["logo"] is False
    assert L["bands"] == [{"first": 0, "last": 45}, {"first": 45, "last": 90}, {"first": 90, "last": 92}] and L["rows"] == 92


# ----------------------------------------------------------------------------------------
# report pack: doc.reports (table pages), doc.charts (S-curve / histogram pages), money
# ----------------------------------------------------------------------------------------
def milestone_report(n_rows: int, title="Milestone report") -> dict:
    rows = [{"name": "Phase 1 — substructure", "_bold": True}]
    for i in range(n_rows):
        rows.append({"name": f"M-{i + 1:03d} milestone number {i + 1}", "date": f"2026-{1 + i % 12:02d}-{1 + i % 27:02d}",
                     "baseline": f"2026-{1 + i % 12:02d}-01", "var": (i % 7) - 3, "cost": 1250.5 * (i + 1),
                     "_indent": i % 3, "_colour": "#c28a1a" if i % 4 == 0 else None})
        if i == n_rows // 2:
            rows.append({"name": "Phase 2 — superstructure", "_bold": True})
    return {"kind": "milestones", "title": title, "subtitle": "Forecast against the tender baseline",
            "columns": [{"key": "name", "label": "Milestone"}, {"key": "date", "label": "Forecast", "width": 24},
                        {"key": "baseline", "label": "Baseline", "width": 24}, {"key": "var", "label": "Var (days)", "num": True},
                        {"key": "cost", "label": "Value", "money": True}],
            "rows": rows, "notes": "Variance is forecast minus baseline in working days. Values are the activity budgets at the data date."}


def scurve_chart() -> dict:
    planned = [[f"2026-{m:02d}-01", (m - 1) ** 2 * 10000] for m in range(1, 13)]
    actual = [[f"2026-{m:02d}-01", (m - 1) ** 2 * 9500] for m in range(1, 7)]
    return {"kind": "scurve", "title": "Cost S-curve", "subtitle": "Cumulative planned and actual value",
            "y_label": "Cumulative value", "y_money": True, "data_date": "2026-06-15",
            "series": [{"label": "Planned value", "colour": "#1f5fbf", "points": planned},
                       {"label": "Actual value", "colour": "#d97706", "points": actual}]}


def histogram_chart() -> dict:
    dates = [(date(2026, 3, 2) + timedelta(days=7 * i)).isoformat() for i in range(20)]
    return {"kind": "histogram", "title": "Labour histogram", "x_labels": "weeks", "y_label": "Operatives on site",
            "limit": {"label": "Site capacity", "value": 42}, "data_date": "2026-06-15",
            "bars": [{"label": "Groundworks", "colour": "#8a5a2b", "points": [[d, 5 + i % 7] for i, d in enumerate(dates)]},
                     {"label": "Frame", "colour": "#2b6a8a", "points": [[d, 10 + (i % 5) * 4] for i, d in enumerate(dates)]}],
            "series": [{"label": "Planned total", "colour": "#1f5fbf", "points": [[d, 20 + i % 9] for i, d in enumerate(dates)]}]}


def fonts_of(content: bytes, text: str) -> set[str]:
    """The font resources (F1 regular, F2 bold) a string is drawn with on a page."""
    body = re.escape(text.encode("cp1252").replace(b"\x97", b"\\227"))
    return {m.decode() for m in re.findall(rb"/(F[12]) [\d.]+ Tf [-\d.]+ [-\d.]+ Td \(" + body + rb"\) Tj", content)}


def test_report_pages_overflow_and_repeat_headers(tmp_path):
    report = milestone_report(120)
    r = render_patched(tmp_path, {"reports": [report]}, page={"size": "A4", "orientation": "landscape"})
    assert r["error"] is None, r["error"]
    L, base = r["layout"], r["base"]
    assert L["reports"] == 1 and L["charts"] == 0 and L["chart_pages"] == 0
    assert L["report_pages"] >= 3 and L["gantt_pages"] == base["page_count"]
    assert L["page_count"] == L["pages"] == L["cover_pages"] + L["report_pages"] + L["chart_pages"] + L["gantt_pages"]
    assert base["report_pages"] == 0 and base["pages"] == base["page_count"]
    pdf = Pdf(r["pdf"])
    pages = pdf.pages()
    texts = pdf.page_texts()
    assert len(pages) == L["page_count"]
    names = [row["name"] for row in report["rows"] if not row.get("_bold")]
    seen = []
    for k in range(L["report_pages"]):
        page = texts[k]
        # title (continued after the first page), subtitle and every column header on every page
        assert any(t.startswith("Milestone report") for t in page)
        assert ("Milestone report (continued)" in page) == (k > 0)
        assert "Forecast against the tender baseline" in page
        for label in ("Milestone", "Forecast", "Baseline", "Var (days)", "Value"):
            assert label in page, (k, label)
        on_page = [n for n in names if n in page]
        assert on_page, k
        seen += on_page
        assert f"Page {k + 1} of {L['page_count']}" in page
        assert any(t.startswith("Report 1/1") for t in page)
    # every row printed once, in order, split across the report pages; the notes on the last page
    assert seen == names
    assert "Variance is forecast minus baseline in working days." in " ".join(texts[L["report_pages"] - 1])
    assert not any(t.startswith("Variance is forecast") for k in range(L["report_pages"] - 1) for t in texts[k])
    # section rows are bold; ordinary rows regular; money and numbers formatted
    first = pdf.page_content(pages[0])
    assert fonts_of(first, "Phase 1 — substructure") == {"F2"}
    assert fonts_of(first, "M-001 milestone number 1") == {"F1"}
    assert "£1,250.50" in texts[0] and "£2,501" in texts[0] and "-3" in texts[0]
    assert colour_op("#c28a1a") in first                                    # the row swatch
    # the Gantt pages follow, renumbered, with their row bands intact
    g = L["report_pages"]
    assert r["rows"][0]["name"] in texts[g] and any(t.startswith("Rows 1") for t in texts[g])
    assert "Milestone report" not in texts[g]
    assert_inside_margins(pdf, L)
    for p in pages:
        ops = pdf.page_content(p).split(b"\n")
        assert ops.count(b"q") == ops.count(b"Q")


def test_report_indent_and_truncation(tmp_path):
    long_name = "A milestone whose name is far too long to fit in its column " * 4
    report = {"title": "Narrow", "columns": [{"key": "name", "label": "Name", "width": 40}, {"key": "x", "label": "X", "width": 20}],
              "rows": [{"name": "Root", "_indent": 0}, {"name": "Child", "_indent": 1}, {"name": "Grandchild", "_indent": 2}, {"name": long_name, "_indent": 9}]}
    r = render_patched(tmp_path, {"reports": [report]}, options={"reports_only": True})
    assert r["error"] is None
    L = r["layout"]
    assert L["reports_only"] is True and L["gantt_pages"] == 0 and L["page_count"] == 1
    pdf = Pdf(r["pdf"])
    content = pdf.page_content(pdf.pages()[0])
    pos = {s: x for s, x, _y, _pt in texts_with_positions(content, L["page_h_mm"]) if s in ("Root", "Child", "Grandchild")}
    assert pos["Root"] < pos["Child"] < pos["Grandchild"]
    assert pos["Child"] - pos["Root"] == pytest.approx(2.6, abs=0.02) and pos["Grandchild"] - pos["Child"] == pytest.approx(2.6, abs=0.02)
    cut = [s for s in pdf.page_texts()[0] if s.startswith("A milestone whose")]
    assert len(cut) == 1 and cut[0].endswith("…") and len(cut[0]) < len(long_name)
    assert_inside_margins(pdf, L)


def test_money_formatting():
    script = (
        f"require({json.dumps(str(PDF_JS))});"
        "const P = globalThis.PlannerPDF;"
        "console.log(JSON.stringify([P.money(12500, 'GBP'), P.money(12500, 'EUR'), P.money(12500, 'USD'), P.money(1250.5, 'GBP'),"
        " P.money(-300, 'USD'), P.money(0.004, 'GBP'), P.money('99.999', 'SEK'), P.money(1200, '£'), P.money(1200), P.money('n/a', 'GBP'),"
        " P.money(null, 'GBP'), P.money(1234567.891, 'eur'), P.formatNumber(1234567.891), P.formatNumber(-5), P.formatNumber('x')]));"
    )
    out = json.loads(subprocess.run([NODE, "-e", script], capture_output=True, text=True, check=True).stdout)
    assert out == ["£12,500", "€12,500", "$12,500", "£1,250.50", "-$300", "£0", "SEK 100", "£1,200", "£1,200", "n/a", "",
                   "€1,234,567.89", "1,234,567.89", "-5", "x"]


@pytest.mark.parametrize("currency,symbol", [("GBP", "£"), ("EUR", "€"), ("USD", "$")])
def test_report_money_column_uses_meta_currency(tmp_path, currency, symbol):
    report = {"title": "Cost", "columns": [{"key": "item", "label": "Item"}, {"key": "cost", "label": "Cost", "money": True}],
              "rows": [{"item": "Brickwork", "cost": 12500}, {"item": "Roof", "cost": 8250.25}]}
    r = render_patched(tmp_path, {"reports": [report], "meta": {"currency": currency}}, options={"reports_only": True})
    assert r["error"] is None and r["layout"]["currency"] == currency
    first = Pdf(r["pdf"]).page_texts()[0]
    assert f"{symbol}12,500" in first and f"{symbol}8,250.25" in first
    for other in "£€$".replace(symbol, ""):
        assert not any(t.startswith(other) for t in first)


def test_scurve_page(tmp_path):
    chart = scurve_chart()
    r = render_patched(tmp_path, {"charts": [chart]}, page={"size": "A4", "orientation": "landscape"})
    assert r["error"] is None, r["error"]
    L = r["layout"]
    assert L["charts"] == 1 and L["chart_pages"] == 1 and L["report_pages"] == 0
    assert L["page_count"] == r["base"]["page_count"] + 1
    pdf = Pdf(r["pdf"])
    pages = pdf.pages()
    first, content = pdf.page_texts()[0], pdf.page_content(pdf.pages()[0])
    assert "Cost S-curve" in first and "Cumulative planned and actual value" in first
    assert "Planned value" in first and "Actual value" in first                # legend
    assert "Cumulative value" in first                                        # y axis caption
    assert "Data date 15 Jun 26" in first and "Data date" in first
    assert "£0" in first and any(re.fullmatch(r"£\d{1,3}(,\d{3})+", t) for t in first)   # money y ticks
    assert "January 2026" in first and "December 2026" in first               # month ticks
    assert f"Page 1 of {L['page_count']}" in first and any(t.startswith("Chart 1/1") for t in first)
    # two polylines in the series colours, a dashed data date line, no images
    ops = content.split(b"\n")
    for colour, n_pts in (("#1f5fbf", 12), ("#d97706", 6)):
        starts = [i for i, o in enumerate(ops) if o == colour_op(colour, 0, "RG")]      # legend swatch, then the series
        strokes = [o for i in starts for o in ops[i:i + 4] if o.endswith(b" S")]
        assert [s.count(b" l") for s in strokes] == [1, n_pts - 1]
    assert colour_op("#8b5cf6", 0, "RG") in ops and b"[4.54 2.83] 0 d" in ops
    assert ops.count(b"q") == ops.count(b"Q") >= 1
    assert b"/Image" not in pdf.obj(pages[0]) and b"Do\n" not in content
    assert_inside_margins(pdf, L)
    # the Gantt pages follow
    assert r["rows"][0]["name"] in pdf.page_texts()[1]


def test_histogram_page_with_limit(tmp_path):
    chart = histogram_chart()
    r = render_patched(tmp_path, {"charts": [chart]}, options={"reports_only": True})
    assert r["error"] is None, r["error"]
    L = r["layout"]
    assert L["page_count"] == 1 and L["chart_pages"] == 1 and L["gantt_pages"] == 0
    pdf = Pdf(r["pdf"])
    first, content = pdf.page_texts()[0], pdf.page_content(pdf.pages()[0])
    assert "Labour histogram" in first and "Operatives on site" in first
    assert "Groundworks" in first and "Frame" in first and "Planned total" in first and "Site capacity" in first
    assert "Site capacity  42" in first                                      # the limit line's label
    assert "0" in first and "40" in first and "50" in first                   # y ticks reach above the limit
    assert "2 Mar" in first and "13 Jul" in first                             # week ticks
    ops = content.split(b"\n")
    # 20 stacked bars per series filled in the bar colour (plus that colour's legend swatch)
    def fills(colour):
        last, n = None, 0
        for o in ops:
            if o.endswith(b" rg"):
                last = o
            elif o.endswith(b" re") and last == colour_op(colour):
                n += 1
        return n
    assert fills("#8a5a2b") == 21 and fills("#2b6a8a") == 21
    # the limit line: dashed, in the deadline colour
    i = ops.index(colour_op("#d93f3f", 0, "RG"))
    assert b"[6.8 2.27 1.42 2.27] 0 d" in ops[i:i + 4]
    assert ops.count(b"q") == ops.count(b"Q") >= 1
    assert_inside_margins(pdf, L)


def test_report_pack_order_and_reports_only(tmp_path):
    patch = {"reports": [milestone_report(10), milestone_report(60, title="Second report")], "charts": [scurve_chart(), histogram_chart()],
             "cover": {"title": "Programme briefing", "headline": "On track."}}
    r = render_patched(tmp_path / "pack", patch, page={"size": "A4", "orientation": "portrait"})
    assert r["error"] is None, r["error"]
    L = r["layout"]
    assert L["cover_pages"] == 1 and L["reports"] == 2 and L["charts"] == 2 and L["chart_pages"] == 2
    assert L["report_pages"] >= 2 and L["gantt_pages"] == r["base"]["page_count"] > 0
    assert L["page_count"] == 1 + L["report_pages"] + 2 + L["gantt_pages"]
    texts = Pdf(r["pdf"]).page_texts()
    assert len(texts) == L["page_count"]
    assert "Programme briefing" in texts[0] and "Briefing" in texts[0]
    assert any(t.startswith("Milestone report") for t in texts[1]) and any(t.startswith("Report 1/2") for t in texts[1])
    assert any(t.startswith("Second report") for t in texts[L["report_pages"]]) and any(t.startswith("Report 2/2") for t in texts[L["report_pages"]])
    assert "Cost S-curve" in texts[1 + L["report_pages"]] and "Labour histogram" in texts[2 + L["report_pages"]]
    assert any(t.startswith("Rows 1") for t in texts[3 + L["report_pages"]])
    for k, page in enumerate(texts):
        assert f"Page {k + 1} of {L['page_count']}" in page
    # reports_only: the same pages without the Gantt
    r2 = render_patched(tmp_path / "only", dict(patch, options={"reports_only": True}), page={"size": "A4", "orientation": "portrait"})
    L2 = r2["layout"]
    assert L2["reports_only"] is True and L2["gantt_pages"] == 0
    assert L2["page_count"] == L2["pages"] == 1 + L2["report_pages"] + 2 == L["page_count"] - L["gantt_pages"]
    texts2 = Pdf(r2["pdf"]).page_texts()
    assert len(texts2) == L2["page_count"] and not any("Rows 1" in t for page in texts2 for t in page)
    assert f"Page {L2['page_count']} of {L2['page_count']}" in texts2[-1] and "Labour histogram" in texts2[-1]
    # reports_only with nothing to print keeps the Gantt rather than writing an empty file
    r3 = render_patched(tmp_path / "none", {"options": {"reports_only": True}})
    assert r3["layout"]["reports_only"] is False and r3["layout"]["page_count"] == r3["base"]["page_count"] == len(Pdf(r3["pdf"]).pages())


def test_report_pack_deterministic(tmp_path):
    patch = {"reports": [milestone_report(50)], "charts": [scurve_chart(), histogram_chart()], "meta": {"currency": "EUR"}}
    a = render_patched(tmp_path / "a", patch)
    b = render_patched(tmp_path / "b", patch)
    assert a["error"] is None and len(a["pdf"]) > 10000
    assert a["pdf"] == b["pdf"]
    # the same pack under another timezone, byte for byte
    proc = subprocess.run([NODE, "-e", _PATCH_SCRIPT, str(PDF_JS), str(tmp_path / "a" / "doc.json"), str(tmp_path / "a" / "patch.json"), str(tmp_path / "tz.pdf")],
                          capture_output=True, text=True, timeout=120, env=dict(os.environ, TZ="Australia/Lord_Howe"))
    assert proc.returncode == 0, proc.stderr
    assert (tmp_path / "tz.pdf").read_bytes() == a["pdf"]


def test_report_pack_absent_leaves_output_unchanged(tmp_path):
    r = render_patched(tmp_path, {"reports": [], "charts": [], "meta": {"currency": "GBP"}, "options": {"reports_only": False}})
    assert r["error"] is None
    assert r["pdf"] == (tmp_path / "base.pdf").read_bytes()
    L = r["layout"]
    assert L["report_pages"] == 0 and L["chart_pages"] == 0 and L["gantt_pages"] == L["page_count"] == r["base"]["page_count"]


def test_shading_bands(tmp_path):
    """Date-range shading bands (shutdowns, holidays, phases) print behind the bars with their label."""
    base = render_patched(tmp_path, {})
    d0 = date.fromisoformat(base["data_date"][:10])
    bands = [{"from": (d0 + timedelta(days=21)).isoformat(), "to": (d0 + timedelta(days=34)).isoformat(), "label": "Christmas shutdown", "colour": "#ffd166"},
             {"from": "not a date", "to": "2026-01-01", "label": "ignored"}]
    r = render_patched(tmp_path, {"shading": bands})
    assert r["error"] is None and r["layout"]["page_count"] == base["layout"]["page_count"]
    texts = Pdf(r["pdf"]).page_texts()
    assert "Christmas shutdown" in texts[0] and all("ignored" not in t for page in texts for t in page)
    assert r["pdf"] != base["pdf"]
    again = render_patched(tmp_path / "again", {"shading": bands})
    assert again["pdf"] == r["pdf"]                       # deterministic
    assert render_patched(tmp_path / "none", {"shading": []})["pdf"] == base["pdf"]

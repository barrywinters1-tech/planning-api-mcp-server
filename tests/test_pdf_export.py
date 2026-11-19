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

# Planner

Describe a project. The generator drafts the programme from production rates and sequencing rules. The critical-path engine computes every date. A DCMA 14-point check flags what a reviewer would, and a deterministic repairer fixes what a planner would fix without asking. Export to Primavera P6 (XER) or Asta Powerproject / MS Project (XML).

Pure code. No AI service, no API key, nothing leaves your machine.

## What it does

| Layer | File | What |
|---|---|---|
| Model | `planner/model.py` | Project, WBS, activities, calendars (working days, hours, exceptions), links FS/SS/FF/SF with lag, constraints, resources, progress |
| Engine | `planner/cpm.py` | Forward and backward pass, per-activity calendars, lag on the predecessor calendar (P6 default), constraints, retained-logic progress against a data date, total and free float, loop detection. Critical = the longest path: the chain of driving links (each link that actually sets its successor's date) traced back from the finish, as in P6's longest-path option and Asta's driving logic. With mixed calendars this is not the same as float ≤ 0: a five-day task feeding a seven-day cure can carry calendar float and still drive the finish |
| Health | `planner/dcma.py` | DCMA 14-point assessment (logic, leads, lags, FS share, hard constraints, high float, negative float, high duration, invalid dates, resources, missed tasks, critical path test, CPLI, BEI) plus open-ends and dangling-logic checks |
| Generator | `planner/generator.py` | `parse_brief` pulls type, storeys, area, units, frame, foundations, envelope, dates and site flags out of plain English with keyword rules. `generate` builds WBS, activities, durations (from the `RATES` table), trade flow and milestones |
| Repairer | `planner/repair.py` | Turns failing checks into patch operations: closes open ends, removes leads, softens hard constraints, splits over-long activities, closes dangling logic. Negative float is explained, not silently compressed |
| Commands | `planner/commands.py` | `add 2 weeks to A1240`, `link A1010 -> A1020 SS+2d`, `finish by 1 Nov 2026`, `progress A1010 50% as of 20 Apr 2026`, `fix` … type `help` |
| Patches | `planner/plan.py` | `DraftPlan` (neutral programme description) and `Patch` / `apply_patch` (small auditable edits) used by everything above |
| P6 | `planner/xer.py`, `planner/pmxml.py` | XER read and write (including the `clndr_data` blob); P6 XML read |
| Asta / MS Project | `planner/mspxml.py` | MSPDI XML read and write: outline WBS, calendars, links, constraints, progress, baseline, resources |
| Anything else | `planner/mpxj_bridge.py` | Optional. With `pip install mpxj JPype1` and Java 11+, reads Asta `.pp`, MS Project `.mpp`, P3, SureTrak and more through [MPXJ](https://www.mpxj.org) |
| Levelling, baselines | `planner/levelling.py` | Serial-method resource levelling against `max_units_per_day`; named baselines |
| Analysis | `planner/analysis.py` | Resource histograms, cost S-curve, earned value (BCWS, BCWP, ACWP, SPI, CPI), baseline variance |
| Guardrails | `planner/guardrails.py` | Out-of-sequence progress (P6's definition) and critical path drag: how many working days each unfinished critical activity adds to the finish. In-progress activities can be suspended and resumed (P6 `suspend_date` / `resume_date`, carried in XER) |
| Risk | `planner/risk.py` | Monte Carlo schedule risk: triangular duration ranges, extra for weather-exposed work, correlation, P10/P50/P80/P90, chance of the deadline, criticality index. Seeded, so the browser and Python give identical answers |
| History | `planner/history.py` | Undo / redo as snapshots next to the project file |
| Web | `api.py`, `web/` | Ribbon UI: spreadsheet with inline editing and keyboard navigation, Gantt beside the table as two panes with a full-height divider you push and pull (mouse, finger or arrow keys; double-click or the Table / Both / Gantt buttons for one tap), the table scrolling sideways on its own so every column is reachable while the bars stay in view, narrow screens opening at about 40/60, Asta-style bar dragging with the programme recalculated live (move to push or pull, with a ghost of the old position and a count of what moves; drag either end to change start or finish; drag from an end dot onto another bar's start or finish half to link FS/SS/FF/SF; pulling earlier than the logic allows snaps back and names the driving activity), link selection, context menu, indent/outdent, insert/delete summaries and activities, undo/redo, zoom, baseline bars, float bars, progress line, colour-by code or resource, group and sort and filter, calendar / resource / code editors, resource histogram and cost bands pinned under the chart, time–location (line of balance) view, DCMA health with auto-repair, command bar, print, import/export |
| MCP | `mcp_server.py` | Optional. Exposes the same engine as tools for an MCP client. The engine itself never calls a model |
| UK planning data | `server.py` | The original planning.data.gov.uk MCP server, unchanged |

## Files

| Source | Route | Read | Write |
|---|---|---|---|
| Primavera P6 | File > Export > XER | yes | yes |
| Primavera P6 | File > Export > Primavera P6 XML | yes | no (use XER) |
| Asta Powerproject | File > Export > MS Project XML | yes | yes |
| Asta Powerproject | File > Export > Primavera XER | yes | yes |
| Asta Powerproject | native `.pp` | with the MPXJ bridge | no |
| MS Project | `.mpp` | with the MPXJ bridge | no (use XML) |
| MS Project | XML | yes | yes |

The readers are tested against real files from the MPXJ project's test suite (`tests/fixtures/`), cross-checked against MPXJ's own parse of the same files.

## Run it

```bash
pip install -r requirements.txt
python examples/demo.py --serve       # optional: a 43-activity house programme to play with
uvicorn api:app --port 8080
```

Open http://localhost:8080. Paste a brief, press **Read brief into form**, check the parameters, press **Generate programme**. Or import a file you already have.

For `.pp` and `.mpp`: `pip install mpxj JPype1` with a Java runtime installed; the import button then accepts them.

Project files live in `data/projects/` (override with `PLANNER_DATA_DIR`).

### Python

```python
from planner.generator import parse_brief, generate
from planner.plan import draft_to_project, run_schedule
from planner.repair import plan_repairs
from planner.plan import apply_patch
from planner.xer import write_xer_file

p = draft_to_project(generate(parse_brief("Two storey house, 180 sqm, start 4 May 2026, finish by end of 2026")))
report = run_schedule(p)
apply_patch(p, plan_repairs(p, report))
run_schedule(p)
write_xer_file(p, "house.xer")
```

### MCP (optional)

```json
{ "mcpServers": { "planner": { "command": "python", "args": ["/path/to/mcp_server.py"] } } }
```

Tools: `generate_programme`, `run_command`, `repair_schedule`, `create_project_from_draft`, `add_wbs`, `add_activities`, `add_links`, `apply_patch_ops`, `calculate`, `get_schedule`, `set_status_date`, `import_schedule`, `export_schedule`.

## How the generator works

1. **Parse.** Keyword rules read the brief: building type, storeys, GIA or units, frame, foundations, envelope, roof, fit-out level, basement / demolition / diversions / contamination, start, deadline, planning-condition date, six-day week.
2. **Default.** Anything the brief leaves out gets the choice an experienced planner would make (a four-storey block gets an RC frame on piles; a warehouse gets a steel portal frame on a raft). Every default is written to the assumptions list.
3. **Size.** Durations come from `RATES` (m² per gang-day and similar). Floor plates over 900 m² are zoned. One gang per trade moves floor to floor and zone to zone finish-to-start, so the logic is nearly all FS and DCMA-clean.
4. **Sequence.** Enabling → substructure → frame per storey → roof and envelope → watertight → fit-out per floor (first fix, M&E, drylining, screed, drying, second fix, kitchens, decoration, finishes) → externals → power on → commissioning → building control → snagging → practical completion.
5. **Schedule and check.** CPM, then DCMA. Auto-repair if you want it.

Tune `RATES` in `planner/generator.py` to your own outputs. Everything is deterministic: same brief, same programme.

## Against Asta Powerproject

Reviewed against Asta's own documentation and release notes, ranked by how often a working planner uses each feature. "Better" means it does something Asta does not; anything not marked is parity at best.

**Have**

| Area | Status |
|---|---|
| Bar chart and spreadsheet, summaries, indent/outdent, expand/collapse, outline levels | Have |
| Links (FS/SS/FF/SF, lags), constraints, milestones, hammocks, per-activity calendars with exceptions | Have |
| Critical path as longest path, driving links | Have |
| Logic tracing: driving path back, everything held up forward, longest path to completion, "only these" | Have |
| Quick filters (critical, near-critical, next 3 weeks, in progress, behind baseline, milestones), text and code filters, group and sort | Have |
| Bar text options, colour by code or resource, float bars, baseline bars, progress line | Have |
| Resources, histograms under the chart, serial levelling | Have |
| Baselines and variance, progress against a data date, cost S-curve and earned value | Have |
| Time–location (line of balance) view | Have |
| DCMA 14-point check with auto-repair | Better: Asta's schedule check reports; this also fixes |
| Schedule risk (Monte Carlo) | Better: Asta Risk is a separate product; here it is built in, reproducible, and flags activities that are not critical today but take over the path in some runs |
| Programme from a plain-English brief, command language, AI assistant | Better: no equivalent |
| Interop: XER and P6 XML read, XER write, MSPDI XML read/write, `.pp` via MPXJ, CSV export | Have (Asta reads XER and MSPDI) |
| Runs in a browser with no install, phone layout | Better |

**Backlog, in order**

1. Lag calendar option (predecessor, successor, 24-hour, project default). Imported P6 and Asta jobs that use successor or 24-hour lag calendars schedule differently here today, so this is a correctness item.
2. Several tasks on one bar line. Asta's signature presentation, used for zone-by-zone and repetitive work. Needs a "line" concept above activities, plus import/export mapping.
3. Annotations: text, arrows and boxes pinned to dates on the chart.
4. Print and PDF page setup: title block, logo, revision box, legend, date range, fit to pages. Programmes are issued as PDFs, so this matters more than its size suggests.
5. Progress periods: several report dates per project, a progress line per period, and dragging the progress line to record progress.
6. Views saved with the project: filters with several conditions, columns, bar styles and grouping in one named view (now in browser storage only).
7. User-defined fields and code libraries shared across projects.
8. Subprojects and multi-project (expanded tasks, master programmes).
9. Cash flow with payment terms; cost centres.
10. Split tasks and buffer tasks.
11. Site progress companion app (phase 2, agreed separately).

## Tests

```bash
pytest -q
```

Engine against hand-worked examples; XER, P6 XML and MSPDI round trips and real files; the generator across building types; the repairer; the command language.

`tests/test_parity.py` is a golden-master check that the browser engine (`web/engine.js`) and the Python engine agree exactly. A corpus of projects (every link type and constraint, progress, hammocks, a year of DST changes) and briefs runs through both, and every date, float, critical flag, DCMA result, levelling delay, repair, command patch, histogram, cost figure and Monte Carlo result (same seeded draws) is diffed, along with Python's rounding and number formatting over a few thousand values. Node runs it under UTC, London, Santiago (clocks change at midnight) and Lord Howe (30-minute DST). It needs `node` on the path and skips without it.

## Known limits

- One shift per working day per calendar. P6 multi-shift calendars collapse to hours per day. A shift is looked up by the date it starts on, so shifts that run past midnight (nights, 24-hour working) are not modelled correctly.
- Schedule times are kept to the whole second.
- Levelling is the serial method with day-level demand; no resource curves or smoothing. Risk analysis does not re-level inside its runs.
- Progress uses retained logic only.
- Lags use the predecessor's calendar (P6's default); there is no per-link or project lag-calendar option yet.
- `must_finish_by` has no MSPDI field, so it does not survive an XML round trip.
- In the browser, calendars with number-like IDs (P6 ObjectIds such as `178`) are held in numeric rather than file order. Dates and the default calendar are unaffected; calendar numbering on re-export can differ from the Python app.
- The brief parser is keyword-based. If it misreads something, correct the form before generating.
- Generator rates are generic UK tender figures, not your firm's. Tune them.

## Browser build (no backend)

`web/engine.js` is a faithful JavaScript port of the Python engine (CPM, DCMA, generator, levelling, analysis, risk, patches, commands, repairer) plus XER / MS Project XML writers. `web/local_backend.js` runs the same REST shapes against `localStorage`, so `web/standalone.html` is a single self-contained page that needs no server. `tests/test_parity.py` holds the two engines to identical output in four timezones (see Tests); the engine keeps dates as naive wall-clock times in UTC-pinned `Date`s so daylight saving cannot shift them. Python also reads back the browser-written XER and MSPDI. The browser build imports Primavera XER, P6 XML and MS Project XML (what Asta Powerproject exports) through `web/import_xer.js`, `web/import_xml.js` (with its own XML parser, matched against Python's ElementTree and expat) and `web/import_any.js`; `tests/test_import_parity_xer.py`, `tests/test_import_parity_xml.py` and `tests/test_import_any.py` hold them to Python's readers byte for byte. Binary `.pp` and `.mpp` files need the MPXJ bridge in the full local app; the browser explains how to export XER or XML instead.

## Guided setup and one-click interoperability

The browser build adds a **Guided setup** wizard: a seven-step interview (building type, size, structure, envelope, site conditions, dates) that assembles a brief and generates the full programme — the same deterministic generator, no AI service. The command bar drives edits in plain phrases (`add 2 weeks to piling`, `finish by 1 Nov 2026`, `fix`).

**Export to all three leading tools in one file:** Export > *All three* writes a `.zip` containing `<id>.xer` (Primavera P6 and Asta Powerproject), `<id>.xml` (Microsoft Project and Asta Powerproject, MS Project XML) and `<id>.json`. The zip is a store-only archive written in-browser; its XER and MSPDI parse back through the Python readers unchanged. In the hosted preview the zip downloads with its real extension (the sandbox allows `.zip`); the individual `.xer`/`.xml` items download as `.txt` there, so the zip is the clean route to P6, Asta and MS Project.

## AI assistant (optional, full app, needs a key)

With `ANTHROPIC_API_KEY` set on the server, the full app gains an **Assistant** chat: you type free-form ("plan a 20-unit two-storey housing scheme, brick, start April 2026, finish by next Christmas", then "compress it by three weeks", or "what's driving the finish?") and a Claude model drives the engine through tools — generate from a brief, run a command, apply structured edits, read the schedule, repair, level, baseline. The model never computes dates; the deterministic engine does, so the AI cannot invent a schedule. Code is in `planner/agent.py` (tool dispatch and the chat loop) with endpoints `POST /api/chat` and `POST /api/projects/{id}/chat`. Model defaults to `claude-opus-5-5` at effort `high` (`PLANNER_MODEL`, `PLANNER_EFFORT`), with server-side refusal fallbacks on (`PLANNER_FALLBACKS=off` to disable). Set the key in your shell before starting the server (`export ANTHROPIC_API_KEY=...`, or `ant auth login`); never put it in the page or the repo.

The shared browser page needs no key: opened inside Claude (claude.ai or the Claude app), its Assistant asks Claude through the viewer's own account using the artifact `sample` capability, with the same engine tools (generate, command, structured edits, read schedule, repair, level, baseline, risk) running in the page. Each change is an ordinary undo step, and the model never computes dates. Opened anywhere else, the Assistant explains that it needs Claude and the rest of the page works as before.

Run with the assistant:

```bash
pip install -r requirements.txt anthropic
export ANTHROPIC_API_KEY=...
uvicorn api:app --port 8080
```

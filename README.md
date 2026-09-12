# Planner

Describe a project. The generator drafts the programme from production rates and sequencing rules. The critical-path engine computes every date. A DCMA 14-point check flags what a reviewer would, and a deterministic repairer fixes what a planner would fix without asking. Export to Primavera P6 (XER) or Asta Powerproject / MS Project (XML).

Pure code. No AI service, no API key, nothing leaves your machine.

## What it does

| Layer | File | What |
|---|---|---|
| Model | `planner/model.py` | Project, WBS, activities, calendars (working days, hours, exceptions), links FS/SS/FF/SF with lag, constraints, resources, progress |
| Engine | `planner/cpm.py` | Forward and backward pass, per-activity calendars, lag on the predecessor calendar (P6 default), constraints, retained-logic progress against a data date, total and free float, critical or longest path, loop detection |
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
| History | `planner/history.py` | Undo / redo as snapshots next to the project file |
| Web | `api.py`, `web/` | Ribbon UI: spreadsheet with inline editing and keyboard navigation, Gantt with drag-to-move, drag-to-resize, drag-to-link, link selection, context menu, indent/outdent, insert/delete summaries and activities, undo/redo, zoom, baseline bars, float bars, progress line, colour-by code or resource, group and sort and filter, calendar / resource / code editors, resource histogram and cost bands pinned under the chart, time–location (line of balance) view, DCMA health with auto-repair, command bar, print, import/export |
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

## What it covers of Asta Powerproject

Done: bar chart with spreadsheet, hierarchy (summaries, indent/outdent, expand/collapse), links with lags and all four types, constraints (flags), milestones, hammocks, calendars with exceptions, per-activity calendars, resources with limits and rates, resource histogram, levelling, baselines and variance, progress with data date and progress line, cost and earned value, activity codes with colour-coding, group / sort / filter, undo/redo, time–location chart, print, XER / P6 XML / MSPDI interop, `.pp` through the MPXJ bridge.

Not yet: multi-project and sub-projects, task splitting, multiple named views and print profiles, Site Progress mobile, risk analysis, code libraries shared across projects, cash-flow with payment terms, timesheets.

## Tests

```bash
pytest -q
```

Engine against hand-worked examples; XER, P6 XML and MSPDI round trips and real files; the generator across building types; the repairer; the command language.

## Known limits

- One shift per working day per calendar. P6 multi-shift calendars collapse to hours per day.
- No resource levelling. Resources and assignments are carried through so P6 / Asta can level.
- Progress uses retained logic only.
- `must_finish_by` has no MSPDI field, so it does not survive an XML round trip.
- The brief parser is keyword-based. If it misreads something, correct the form before generating.
- Generator rates are generic UK tender figures, not your firm's. Tune them.

## Browser build (no backend)

`web/engine.js` is a faithful JavaScript port of the Python engine (CPM, DCMA, generator, levelling, analysis, patches, commands, repairer) plus XER / MS Project XML writers. `web/local_backend.js` runs the same REST shapes against `localStorage`, so `web/standalone.html` is a single self-contained page that needs no server. It is validated by reproducing the Python-scheduled demo exactly and by cross-checking the generator, DCMA, levelling and file writers against the Python outputs (Python reads back the browser-written XER and MSPDI). The browser build imports its own JSON export; Primavera XER, P6 XML and Asta .pp import stay in the full local app.

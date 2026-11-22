# Planner

Describe a project. The generator drafts the programme from production rates and sequencing rules. The critical-path engine computes every date. A DCMA 14-point check flags what a reviewer would, and a deterministic repairer fixes what a planner would fix without asking. Export to Primavera P6 (XER) or Asta Powerproject / MS Project (XML).

Pure code. No AI service, no API key, nothing leaves your machine.

## How it feels to use

The engine does the arithmetic; the shell is built around a planner's week.

- **Overview first.** Opening a programme lands on a page that reports its own state: a journey spine (Brief → Build → Baseline → Update → Issue) with the next step on each stage, a written briefing (headline, what changed since the last period, revision or baseline, what to watch, the next two weeks, what to do next), milestones, and an Ask box. Everything on it is computed from the schedule by `web/briefing.js` / `planner/briefing.py`; Claude only polishes the prose if the viewer has it.
- **Ask anything.** The ⌘K bar takes questions as well as commands: *when do we finish, what is driving the finish, why does the roof start on 11 June, what does brickwork hold up, what is happening next week, what if piling takes two weeks longer.* `web/ask.js` / `planner/ask.py` answer from the engine, deterministically, and every answer can be shown on the chart (highlight, trace the logic, filter, open). Same questions through the API (`POST /api/projects/{id}/ask`) and MCP (`ask_programme`).
- **Try changes safely.** *Try* keeps the programme as it was; every change you make shows the finish delta live in a bar across the top, *What changed* opens the full comparison, *Keep* commits (with one click to issue as a revision), *Discard* puts it all back.
- **Three faces.** *Build* has every tool. *Site* leads with the phone-sized site update and the next two weeks. *Client* is read-only: briefing, milestones, chart and PDF for issue, with the editing tools gone and every change blocked.
- **Asta-style dragging, by mouse or finger.** Drag a bar to push it (successors follow live); drag earlier than the logic allows and it snaps back and names the driver; drag either end to extend or shrink; drag the dot at a bar end onto another bar to link (FS/SS/FF/SF by the end you leave and the half you land on). On a phone a finger on a bar drags it, a finger on empty chart space scrolls.
- **Asta hands.** Press and drag on empty chart space (or the blank row at the bottom) to draw a new activity across those days, name ready to type. Link Tasks mode (planbar toggle) links each new or drawn activity from the one selected before it. Select several rows and the inspector becomes one form for all of them: duration set or change, calendar, codes, resources, custom fields, deadline, notes, in one undo step. View → Snap drags to weeks puts every drag and drawn bar on Monday-to-Monday. Collapse all, expand all and collapse completed summaries live in View, the palette and Ctrl+Shift+[ / ].
- **Scheduling options, named as P6 names them.** More → Scheduling options: out-of-sequence progress as the planner default (remaining work from the data date), Retained logic or Progress override; multiple float paths (Path column, colour by path, path 1 the longest); start on new day; the near-critical threshold the quick filter and briefing use.
- **The site loop on paper or Excel.** Site update exports a lookahead sheet (CSV) the site fills in: status, % complete, actual dates, days left and a comment. Import the returned sheet and the changes are staged in the Site update sheet for the planner to check before saving; comments land in the activity notes, dated. Paste a block of cells from Excel into the grid (Ctrl+V with a cell active): matching rows update, extra rows become new activities. Chart notes take a photo (shrunk to 900px, kept with the programme). Columns Orig dur, Act dur, Rem (editable) and Status complete the tracking table.
- **Group by two things.** View → Group, then by: trade then month, zone then week, any code then any other. Each sub-group collapses on its own; Collapse all and Expand all cover both levels.
- **Notes that point at things.** A chart note can be a callout, a dashed box round a date range and rows, or an arrow from one bar to another, with a photo if wanted. Notes, boxes, arrows and shaded date ranges all print on the PDF.
- **Pictures and pages for people without the software.** Share → Picture or web page copies the chart with its activity names to the clipboard as a PNG (what is on screen, or the whole programme), or saves the table as a static HTML page. The Overview shows a key-dates strip of the milestones with status, also copyable as a picture.
- **Reuse.** More → Save as template keeps a programme's activities, logic, calendars, resources, codes and views without its history; New from template starts the next job from it on a new start date. More → Fragnets saves a selection as a named block and inserts it as many times as needed (per plot, per floor), numbered, chained or side by side, with its logic and resources.
- **Portfolio.** With two or more programmes the Projects screen shows them on one timeline with their milestones, deadlines and status, and a table of the trades they share: peak demand a day, the crew limit, who needs them that week, and how many weeks run over.
- **Files that fit the receiver.** Export asks which P6 release to stamp the XER with, and can send one summary or the selected activities as their own file (a subcontractor's package, with its links, resources and baseline dates). More → Renumber activity IDs gives prefix, start and step in the order shown, and links, resources, baselines, periods and notes follow.
- **Bars that explain themselves.** Hover a bar for its dates, float, baseline variance, constraint, why it starts when it does (its driving predecessor) and what it holds up.
- **Issue.** PDF for issue carries the briefing headline in the title block and, optionally, the briefing as a cover page.

Design rules for the interface (tokens, roles, states, motion), written for people and agents alike, are in [`docs/design-conventions.md`](docs/design-conventions.md).

## What it does

| Layer | File | What |
|---|---|---|
| Model | `planner/model.py` | Project, WBS, activities, calendars (working days, hours, exceptions), links FS/SS/FF/SF with lag, constraints, resources, progress |
| Engine | `planner/cpm.py` | Forward and backward pass, per-activity calendars, lag on the predecessor, successor or project calendar or as elapsed 24-hour time (P6's lag-calendar option, per programme or per link), constraints, progress against a data date with a choice of progress logic (P6's retained logic or progress override, or the engine's own data-date mode), P6-style multiple float paths, Asta's start-on-new-day, a near-critical threshold, elapsed-duration activities (`Activity.elapsed`: curing, drying and lead times run on calendar time, 24 hours a day and seven days, whatever calendar they name; `elapsed_days()` gives the calendar days any activity spans), total and free float, loop detection. Critical = the longest path: the chain of driving links (each link that actually sets its successor's date) traced back from the finish, as in P6's longest-path option and Asta's driving logic. With mixed calendars this is not the same as float ≤ 0: a five-day task feeding a seven-day cure can carry calendar float and still drive the finish |
| Health | `planner/dcma.py` | Two check sets, `health_check(p, check_set=...)`: `dcma`, the DCMA 14-point assessment (logic, leads, lags, FS share, hard constraints, high float, negative float, high duration, invalid dates, resources, missed tasks, critical path test, CPLI, BEI) plus open-ends and dangling-logic checks; and `pp21`, the CIOB Planning Protocol 2021 set (task duration capped at 44 working days, no open ends, no negative float, no leads, lags no longer than 20% of the successor, logic density 1-4 links per activity, constraints at most 5%, every milestone linked, progress consistent with the data date, a critical path that ends at the finish, sensible calendars). Every threshold has a key (`DCMA_THRESHOLDS`, `PP21_THRESHOLDS`) a planner can override per project (`Project.check_thresholds`) or per call; the report carries the set and the effective thresholds and scores the share of applicable checks that pass. The rationale for each PP21 check is in the module docstring |
| Generator | `planner/generator.py` | `parse_brief` pulls type, storeys, area, units, frame, foundations, envelope, dates and site flags out of plain English with keyword rules. `generate` builds WBS, activities, durations (from the `RATES` table), trade flow and milestones |
| Repairer | `planner/repair.py` | Turns failing checks into patch operations: closes open ends, removes leads, softens hard constraints, splits over-long activities, closes dangling logic. Negative float is explained, not silently compressed |
| Commands | `planner/commands.py` | `add 2 weeks to A1240`, `link A1010 -> A1020 SS+2d`, `finish by 1 Nov 2026`, `progress A1010 50% as of 20 Apr 2026`, `fix` … type `help` |
| Patches | `planner/plan.py` | `DraftPlan` (neutral programme description) and `Patch` / `apply_patch` (small auditable edits) used by everything above |
| P6 | `planner/xer.py`, `planner/pmxml.py` | XER read and write (including the `clndr_data` blob), with a target P6 version for the header (`write_xer(p, version="24")`: 15.2, 19, 21, 24 ...; only the ERMHDR version differs, every table written exists unchanged since P6 8); P6 XML read |
| Asta / MS Project | `planner/mspxml.py` | MSPDI XML read and write: outline WBS, calendars, links, constraints, deadlines, progress, baseline, resources, custom fields (`ExtendedAttributes` with the standard Text1-30 / Number1-20 / Date1-10 FieldIDs, aliases as names; Start, Finish and Cost fields read too) and activity codes written as a text field per code type, read back as codes when the receiving programme has that code type |
| Anything else | `planner/mpxj_bridge.py` | Optional. With `pip install mpxj JPype1` and Java 11+, reads Asta `.pp`, MS Project `.mpp`, P3, SureTrak and more through [MPXJ](https://www.mpxj.org) |
| Levelling, baselines | `planner/levelling.py` | Serial-method resource levelling against `max_units_per_day`, with options (`level(p, options)` or `Project.levelling`): `resources` (limit only these), `from` / `to` (only activities starting in the window may move), `within_float` (never past the late start), `order` (`late_start`, `priority`, `total_float`, `early_start`), `preserve_actuals` (always on). Lags are walked on the scheduler's lag calendar and elapsed activities on calendar time. `level()` stores `Project.levelling_report`: for every activity moved or left over-allocated, `{id, delay_hours, resource_id, waited_for, reason}` with reason `capacity`, `within_float_blocked` or `window` (`levelling_report(p)` returns it). Named baselines |
| Analysis | `planner/analysis.py` | Resource histograms, cost S-curve, earned value (BCWS, BCWP, ACWP, SPI, CPI), baseline variance |
| Compare | `planner/compare.py`, `web/compare.js` | Two versions of a programme: activities added, removed, renamed; duration, logic, constraint, progress and calendar changes; date moves; critical path joined/left; and a plain-English commentary of why the finish moved, walking the new longest path. Issued revisions (Rev A, Rev B...) are frozen copies stored with the project for this. Parity tested |
| PDF | `web/pdf_export.js` | Dependency-free vector PDF of the Gantt: three-tier timescale, table, bars, links, float, baseline, data date and deadline lines, annotations, progress-period lines, Asta/P6-style title block (standard, compact or wide layouts, company logo) with legend and page numbers, a briefing cover page; A4-A1, portrait or landscape, rows per page, pages wide, fit to N pages tall, a page per top-level summary, selected rows only, legend for the colour-by key. A report pack between the cover and the Gantt pages (`doc.reports`, `doc.charts`, or on its own with `reports_only`): table report pages with repeated column headers, zebra rows, bold section rows, indents and colour swatches, money columns in the programme currency (`meta.currency`, `PlannerPDF.money()`), and vector S-curve / histogram pages with month or week ticks, legend, data date, stacked bars and a capacity line |
| Progress periods | `web/app.js` | Site update sheet (phone-first: Not started / Started / Finished, % or days left, actual dates, as-of date), closed progress periods stored with the project (`progress_periods`), a dashed progress line per period on the Gantt (View → Period lines), period points on the S-curve, finish movement per period, and an as-built CSV (actual against baseline, the period each activity started and finished in). Closing a period can also freeze a full copy for Compare |
| Custom fields, library, views | `web/app.js`, `planner/xer.py`, `web/engine.js`, `web/import_xer.js` | User-defined fields (text, number, date) as table columns, inspector inputs, PDF and CSV columns, and P6 UDFs in XER both ways (parity tested); filters with several conditions (`Trade=Brick; Float<5; Cost>=10000`); a library to copy codes, fields and views between programmes or via a library file (also reads codes and fields from an XER); a coding sheet CSV to fill codes and fields in Excel; saved views stored with the programme or on the device |
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

Tools: `generate_programme`, `run_command`, `repair_schedule`, `create_project_from_draft`, `add_wbs`, `add_activities`, `add_links`, `apply_patch_ops`, `calculate` (with `check_set` `dcma` or `pp21`), `level_resources` (with the levelling options; returns the levelling report), `get_schedule`, `set_status_date`, `import_schedule`, `export_schedule`. The REST API takes the same choices: `POST /api/projects/{id}/level` with `{"options": {...}}`, `GET /api/projects/{id}/health?check_set=pp21`, and `check_set` on `GET /api/projects/{id}` and `POST .../schedule`.

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

1. Several tasks on one bar line. Asta's signature presentation, used for zone-by-zone and repetitive work. Needs a "line" concept above activities, plus import/export mapping.
2. Annotations: arrows and boxes (text notes pinned to a date and row are done).
3. PDF: company logo in the title block, and period lines on the print (title block, revision, legend, date range and fit to pages are done).
4. Progress: dragging the progress line to record progress (periods, per-period lines and the site update sheet are done).
5. Bar styles per code or field in saved views (views with the project, multi-condition filters and columns are done).
6. Custom fields in MS Project XML (ExtendedAttribute) and P6 XML; a shared organisation-wide library once there is a hosted service (fields, the library file and XER UDFs are done).
7. Subprojects and multi-project (expanded tasks, master programmes).
8. Cash flow with payment terms; cost centres.
9. Split tasks and buffer tasks.
10. Site progress companion app (phase 2, agreed separately).

Done from this list: the lag calendar option. `Project.lag_calendar` is `predecessor` (P6's default, also when unset), `successor`, `project` (the default calendar) or `24h` (elapsed hours), and a relationship can override it with its own `lag_calendar`. XER reads and writes it as `SCHEDOPTIONS.sched_calendar_on_relationship_lag` (`rcal_Predecessor`, `rcal_Successor`, `rcal_Project`, `rcal_24Hour`), P6 XML reads `RelationshipLagCalendar`, and MS Project XML maps elapsed lags (`LagFormat` 4, 6, 8, 10, 12, 20 and their estimated variants) to a per-link `24h` override, writing `LagFormat` 8 (elapsed days) for links whose effective lag calendar is 24-hour.

## Tests

```bash
pytest -q
```

Engine against hand-worked examples; XER, P6 XML and MSPDI round trips and real files; the generator across building types; the repairer; the command language.

`tests/test_parity.py` is a golden-master check that the browser engine (`web/engine.js`) and the Python engine agree exactly. A corpus of projects (every link type and constraint, progress, hammocks, a year of DST changes) and briefs runs through both, and every date, float, critical flag, DCMA result, levelling delay, repair, command patch, histogram, cost figure and Monte Carlo result (same seeded draws) is diffed, along with Python's rounding and number formatting over a few thousand values. Node runs it under UTC, London, Santiago (clocks change at midnight) and Lord Howe (30-minute DST). It needs `node` on the path and skips without it.

## Known limits

- One shift per working day per calendar. P6 multi-shift calendars collapse to hours per day. A shift is looked up by the date it starts on, so shifts that run past midnight (nights, 24-hour working) are not modelled correctly.
- Schedule times are kept to the whole second.
- Levelling is the serial method with day-level demand; no resource curves or smoothing. Risk analysis does not re-level inside its runs. Complete and in-progress activities never move (`preserve_actuals` is always true; `false` is not supported) and the resource use of in-progress work is not counted against the limits, so not-started work is levelled around the logic, not around the gangs already on site. `within_float` leaves an activity that cannot fit over-allocated rather than splitting it. Finish milestones pushed by levelling land at the start of the next working day rather than on their predecessor's finish time.
- Progress logic: `Project.progress_logic` is `data_date` (the default, also when unset), `retained` (P6 Retained Logic) or `override` (P6 Progress Override). The default is the engine's long-standing behaviour and not a P6 mode: an in-progress activity's remaining work resumes at the data date and keeps only its finish-side (FF/SF) links, so an FS or SS predecessor that was overtaken out of sequence does not hold the remaining work (it is pulled back in the backward pass and shows negative float instead). `retained` schedules the remaining work after its unfinished predecessors, as P6 does; `override` ignores them in both passes. P6's third option, Actual Dates, has no equivalent. In every mode a complete activity's successors follow its actual dates, so P6's retained-logic hold on the successors of a *completed* out-of-sequence activity is not modelled. XER writes `SCHEDOPTIONS.sched_retained_logic` / `sched_progress_override` as `N/Y` for `override` and `Y/N` otherwise, and on import takes over only `N/Y` (progress override): P6's own default is Retained Logic, but a file on it is left unset so it keeps the dates this engine has always given it; a planner picks `retained` in the project settings. The exact rules are the docstring of `planner/cpm.py`.
- Multiple float paths (`Project.float_paths`, 1-10) use total float and driving links only; the P6 free-float variant and its key-activity option are not offered. Start on new day moves early starts only; late dates keep their time of day, so a driving predecessor can show a few hours of float.
- Elapsed-duration activities: `duration_hours` and `remaining_hours` are wall-clock hours (72 = three days), so a 72-hour cure that starts Friday 08:00 finishes Monday 08:00. The activity keeps its own `calendar_id` for reports and files; histograms and the DCMA duration checks still count its days on that calendar. XER carries the flag as a task UDF named `elapsed` (text, `Y`), which is never read back as a user field; MS Project XML writes `DurationFormat` 8 (elapsed days) and reads any elapsed `DurationFormat` as the flag. P6 XML does not carry it.
- PP21 checks are the engine's reading of the Planning Protocol's guidance, with every threshold editable. The lag check compares a lag's hours with 20% of the successor's `duration_hours` without converting between calendars; logic density counts relationships over non-hammock activities.
- Lag calendars: the scheduler and resource levelling honour the project setting (predecessor, successor, project, 24-hour) and per-link overrides. A 24-hour lag on an FF or SF link pins the successor's finish to the elapsed time, which can fall outside its shift, just as a finish-to-finish link from a seven-day predecessor into a five-day successor does today.
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

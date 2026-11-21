# 08 Gap diff: Asta Powerproject feature inventory against Planner

Written 2026-11-21 from the three inventories in this folder (01, 02, 03: 531 feature rows) and a read of the app's feature surface: `README.md`, `web/app.js` (section headers, `ALL_COLS`, `QUICK`, `buildFilter`, `palActions`, context menu, inspector, dragging, PDF, periods, site update, library, saved views), the More menu and View popover in `web/index.html`, `planner/*.py` module docstrings, `web/engine.js` exports, `web/pdf_export.js` header, `web/import_xer.js` / `web/import_xml.js`. Nothing was run.

Status key:
- **have**: Planner does this; the row names where.
- **partial**: Planner does part; the row says what is missing.
- **missing**: not there.
- **n/a**: BIM/4D, NEC-specific template content, Enterprise/Vision server features, Windows-only mechanics (printer drivers, OLE, companion .exe), or `.pp`/Easyplan lock-in a browser tool cannot open. Also release-note summary rows that only restate other rows.
- **in progress**: landed or landing since the inventories were written. Dragging the progress line along a bar to record progress is built (`web/app.js` `startProgressDrag`, row 2.7 = have). A lag-calendar option (predecessor / successor / project / 24-hour) is being built in both engines by another agent (rows 1.5, 1.6 = in progress, counted as have below).

Effort: **S** under a day, **M** 1-3 days, **L** a week or more. Where a change alters scheduling output it needs `planner/cpm.py` (or the module named) **and** the `web/engine.js` port **and** a case in `tests/test_parity.py`; the build note says so. UI-only work is `web/app.js` (plus `web/pdf_export.js` when it must print). Daily use = my judgement of whether a UK construction planner reaches for it most working days.

## Summary counts

| Area (inventory section) | Rows | have | partial | missing | n/a |
|---|---|---|---|---|---|
| 01-A Bar chart and interaction | 69 | 19 | 26 | 22 | 2 |
| 01-B Views, tables, sort, filter, group, codes | 50 | 19 | 17 | 14 | 0 |
| 01-C Printing and output | 30 | 8 | 14 | 6 | 2 |
| 01-D Library Explorer and libraries | 33 | 6 | 13 | 13 | 1 |
| 02-1 Scheduling and logic | 64 | 24 (2 in progress) | 19 | 20 | 1 |
| 02-2 Progress | 31 | 12 | 13 | 6 | 0 |
| 02-3 Baselines and comparison | 24 | 9 | 9 | 5 | 1 |
| 02-4 Resources and cost | 34 | 8 | 11 | 14 | 1 |
| 02-5 Risk analysis | 13 | 3 | 7 | 2 | 1 |
| 02-6 Quality checks | 40 | 21 | 9 | 7 | 3 |
| 03-1 File interoperability | 31 | 14 | 8 | 4 | 5 |
| 03-2 UI conventions | 45 | 19 | 21 | 4 | 1 |
| 03-3 Taught workflow | 27 | 13 | 9 | 2 | 3 |
| 03-4 Collaboration, multi-user, mobile | 15 | 4 | 3 | 0 | 8 |
| 03-5 Conventions a planner expects | 25 | 9 | 9 | 7 | 0 |
| **Total** | **531** | **188** | **188** | **126** | **29** |

Of the 502 rows that apply, Planner fully covers 37% (188), partly covers 37% (188) and lacks 25% (126). The gaps cluster in four places: (1) Asta's bar-line model (several tasks per bar and everything that hangs off it: 12 rows), (2) presentation libraries (formulae, named tables/filters/sorts, link and annotation categories, milestone shapes, border designer: about 30 rows), (3) resource and cost depth (effort-driven modelling, demand/scheduled, curves, cost centres, rates by time type: about 20 rows) and (4) deeper scheduling options (buffers, interruptible, maximum lag, percentage lag, work patterns: about 15 rows). The things a planner does every day (draw, link, drag, progress, baseline, filter, colour, issue a PDF) are mostly have or partial with S-sized gaps.

## 01-A Bar chart and its interaction

| Feature | Status | Where in Planner / what is missing | Effort | Daily use | Build note |
|---|---|---|---|---|---|
| A1 Draw a task with the mouse | partial | Insert (button, Insert key, context menu) adds a 5d activity then drag either end; no press-and-drag on an empty row to draw one | S | yes: fastest way to rough out a programme | `app.js` chart wiring: pointerdown on empty space of a row creates an activity spanning the drag, snapped to working days; UI only |
| A2 Snapping and snapping time unit | partial | Drags snap to the start of a working day (`workStartOn`); no choice of unit (hour, day, week) | S | yes: week-snapping when sketching | View popover "Snap to: day / week / none"; `applyDrag` rounds `days` to the unit; UI only |
| A3 Custom time units | missing | Durations are hours shown as days; `parseDays` accepts d/w/h | M | no: shifts and accounting periods are niche | Presentation unit table in `app.js` (`fmt1`/`parseDays`) and `ALL_COLS.dur`; no engine change |
| A4 Several tasks per bar (bar vs task model) | missing | One activity per row (README backlog #2) | L | yes: zone-by-zone and repetitive work is Asta's everyday layout | New "line" grouping over activities in `model.py` + `engine.js` row builder; render stacked tasks on one row; MSPDI/XER mapping (Asta splits them on export anyway); parity tests for import/export, not for dates |
| A5 One-task-per-line mode | missing | Depends on A4 | M | yes: with A4 | Toggle per line and per view in `rows()` |
| A6 Overlapping tasks on a bar | missing | Depends on A4 | M | no | Stacking layout inside a line row |
| A7 Overlap and milestone row settings | missing | Depends on A6 | S | no | View popover settings |
| A8 Roll tasks up onto one bar | missing | Depends on A4 | S | no | Context menu: move selected activities onto one line |
| A9 Unroll tasks | missing | Depends on A4 | S | no | Reverse of A8 |
| A10 Insert bar above / below | partial | Insert below only, auto-linked FS into the chain; no "above" | S | yes | `insertActivity(dir)` with `dir = -1`; context menu entry; UI only |
| A11 Move tasks and bars horizontally by dragging | have | `startDrag` move: pushes or pulls with live reschedule, ghost of old position, snaps back to logic and names the driver | – | – | Whole-bar (ALT-click) belongs with A4 |
| A12 Copy by CTRL-drag / right-drag menu | partial | Copy and Paste below (Ctrl+C/V, context menu) keep internal links and assignments; no CTRL-drag copy or right-button drag menu | S | no | Modifier on drop in `startDrag`; UI only |
| A13 Resize by dragging an end | have | Drag either end; duration or start changes with live recalculation | – | – | |
| A14 Move bars/tasks vertically, keep dates | partial | Move up/down (Alt+Up/Down), indent/outdent, context menu; no mouse drag of rows | M | yes: reordering by drag is how planners tidy a programme | Pointer drag on the row handle with a drop indicator, reorder `activities`/`wbs.seq`; UI only |
| A15 Object Edit toolbar (multi-edit) | partial | Inspector edits one activity; Progress… and Constraint… dialogs apply to a selection; no nudge buttons, no bulk duration/calendar/code edit | S | yes: "give all these the 6-day calendar" | Inspector shows a bulk form when `S.sel.size > 1` (duration delta, calendar, codes, resources); UI only |
| A16 Properties view (docked) | have | Inspector side panel: dates, why-chain, duration, calendar, progress, suspend/resume, logic chips, constraint, resources, codes, custom fields, notes | – | – | |
| A17 Bar and Task Properties dialog | have | Same inspector; double-click a bar opens it | – | – | No cost tab (see 4.29) |
| A18 Draw links with the mouse | have | Drag from a bar-end dot onto another bar; the end you leave and the half you land on set FS/SS/FF/SF | – | – | |
| A19 Link Tasks mode (auto-link while drawing) | partial | Insert activity auto-links FS into the chain; no toggle that links each newly drawn/selected task to the previous one | S | yes: building a chain quickly | Planbar toggle; `insertActivity`/draw hooks read it; UI only |
| A20 Block-link selected tasks | have | Ctrl+L links the selection in row order FS, skipping links that would loop | – | – | Last-to-first / corresponding variants depend on A4 |
| A21 Select links, cycle through overlapping | partial | Click selects a link (`S.selLink`), Delete removes, double-click edits; no cycling through stacked links | S | no | Repeat-click at the same point advances through links under the cursor; UI only |
| A22 Chase link logic | have | Inspector link chips jump pred/succ; Trace driving path / what it holds up; why-chain | – | – | |
| A23 Area select tool | missing | Click, Ctrl-click, Ctrl+A only | S | no | Rubber band on the chart SVG adds rows to `S.sel`; UI only |
| A24 Multi-selection | have | `S.sel` set; Ctrl+A; selection-wide Progress/Constraint/Link | – | – | |
| A25 Select by filter | have | Filter the view, then Ctrl+A selects what is shown | – | – | |
| A26 Cut, copy, paste, Paste and Retain Links, Paste Values | partial | Copy/Paste below with internal links; no Cut, no retaining links to activities outside the selection, no paste of values into cells | S | yes: moving blocks about | `cutSelected` = copy + delete-with-bridging; paste option to keep external links; UI only |
| A27 Mark for hiding | missing | Client mode hides tools, not rows | S | no | `hidden` flag on activity; honoured by `rows()`, PDF and CSV; UI only |
| A28 Default appearance by task type / lead resource | have | Fixed styles for task, milestone, summary, critical; Colour by resource | – | – | Not user-configurable |
| A29 Colour tasks by code library | have | View › Colour: any code type | – | – | One library at a time |
| A30 Colour tasks by assigned resource | have | View › Colour: resource | – | – | |
| A31 Variable task height / colour from data | missing | | M | no | Map a numeric field to bar height/colour in `chart()` and PDF; UI only |
| A32 Bar and task information text | partial | Bar text: name, ID+name, dates, duration+float, resources, none; no left/right placement choice, no arbitrary column or custom field | S | yes: "trade left, dates right" on issued programmes | Bar text picks any `ALL_COLS` key for left / on / right; PDF `label` gains left/right; UI only |
| A33 Task notes popup | partial | Notes column and inspector; hover card shows dates, float, baseline, why; not the note | S | no | Add first line of `notes` to `tipFor` and a small marker on bars with notes |
| A34 Display switches | partial | Toggles: links, float, baseline, progress line, period lines; no toggle for critical colouring, constraint flags, non-driving links, grid lines, annotations | S | yes | Extend View popover and `S.view`; PDF options follow; UI only |
| A35 Critical path and float display options | partial | Critical = longest path (fixed); near-critical quick filter at 10d; no critical-gap setting, no free-float bar, no part-critical shading | S | no | Near-critical threshold input in View popover; free float bar in `chart()` |
| A36 Link display options | partial | All links on or off; `driving` flag exists but non-driving links cannot be hidden or dimmed | S | yes: hide non-driving to read the logic | View › Links: all / driving only / none; dim non-driving in `chart()` and PDF |
| A37 Link categories | missing | No category on `Relationship` | M | no | `Relationship.category` in `model.py` and engine; reschedule "ignore category" changes dates so both engines + parity; XER/MSPDI have no field (keep in JSON) |
| A38 Progress display options | partial | Progress fill on bars and a jagged progress line; no colour override, half-height or per-period shading | S | no | View popover options; UI only |
| A39 Non-working time shading | have | Weekend/non-working bands from the default calendar when zoomed in enough | – | – | Per-row calendar shading would be S |
| A40 Fold non-working time out of view | missing | | M | no | Alternative x-scale skipping non-working days in `S.x`; every overlay uses `S.x`, PDF too |
| A41 Date range shading | missing | Annotations are text at a date; no shaded date bands | S | no | `project.shading: [{from,to,label,colour}]`, rects in `chart()` and `pdf_export.js`; UI only |
| A42 Vertical grid lines | partial | Month lines and week ticks in the date zone, weekend bands; no configurable grid | S | no | Grid option (week / month) drawn down the chart |
| A43 Vertical scale (row heights) | missing | Fixed `RH` | S | no | View › Row height compact/normal/comfortable; CSS variable + `RH`; PDF has `row_height_mm` already |
| A44 General chart options | partial | Theme, panes, outline level; no chart background, project-start line, summary colouring options | S | no | View popover additions |
| A45 Hierarchy appearance and banding | partial | Summary rows styled by depth indent; no per-level colour or banding | S | no | CSS per `depth` class |
| A46 Summary / hammock display (subheading, necking) | partial | Collapse/expand and outline levels; no "show as subheading" or necked summaries | S | no | Row style option |
| A47 Date zone (timescale header) | have | Three-tier timescale: month and year / week commencing / programme week or day | – | – | |
| A48 Edit date zone lines directly | missing | Tiers fixed | M | no | Configurable tier list in `timescale()`; UI only |
| A49 Date zone line types and formats | partial | Programme week numbers from project start; no fiscal/working-unit lines | S | no | Tier type option |
| A50 Date zero, fiscal year, week/month start | partial | Weeks start Monday, week 1 at project start; nothing else | S | no | Options in View popover |
| A51 Multiple horizontal scales (up to 3 zones) | missing | One scale | M | no | Piecewise `S.x`; PDF the same |
| A52 Zoom / chart scale | have | Zoom buttons, + / -, Ctrl+wheel, Fit | – | – | |
| A53 Progress lines and shading in the date zone | missing | Period lines are on the chart only | S | no | Draw period markers in `timescale()` |
| A54 Scroll and pan | have | Scroll, finger pan, draggable divider | – | – | |
| A55 Jump to a date | partial | Today (data date) button only | S | no | Palette: "go to 14 Mar 2027" scrolls `S.x(date)`; UI only |
| A56 Go to selection | have | `goToActivity`, palette "Go to activity" | – | – | |
| A57 Text annotations | partial | Notes pinned to a date and a row (or chart top), printed as PDF callouts; no free boxes, arrows, fonts, watermark (README backlog #3) | M | yes: issued programmes carry notes and arrows | Annotation gains `kind` (callout / box / arrow), size and style; drag to place in `chart()`; mirror in `pdf_export.js`; UI only |
| A58 Fields in annotations | missing | | S | no | Token substitution (`#finish#`, `#pct#`) when rendering annotation text |
| A59 Picture annotations | missing | | M | no | Image data URI in annotation; PDF image XObject (JPEG) in `pdf_export.js` |
| A60 OLE object annotations | n/a | Windows-only mechanism | – | – | |
| A61 Attach annotations to a bar or to the view | have | Note on a row or at the top of the chart | – | – | |
| A62 Annotation categories | missing | | S | no | `category` on annotations, filter in View popover |
| A63 Filtered and automatic annotations | missing | | M | no | Rule: filter text → annotation template, evaluated in `rows()` |
| A64 Manual page breaks | missing | PDF has rows per page / fit to page | S | no | `page_break` flag on WBS/activity honoured by `pdf_export.js` `layout()` |
| A65 Project timeline pane | partial | Overview and Monitor list milestones with status; no draggable scope box, export or colour by code | M | no | Milestone strip component in Overview with a window that sets `S.t0/S.t1`; copy as PNG |
| A66 Milestone appearances | partial | One diamond; start and finish milestone types | S | no | Shape per code or per milestone in `chart()` and PDF |
| A67 Highlighting critical tasks | have | Critical bars red; Colour by critical is the default | – | – | Critical outline when coloured by code would be S |
| A68 "Spotlight" | n/a | Not an Asta feature; covered by filters and tracing | – | – | |
| A69 Keyboard shortcut set | partial | Arrows, Enter/F2, Del, Insert, Tab, Alt+arrows, Ctrl+L/U/C/V/A, +/-, Ctrl+K, Ctrl+Z/Y; no shortcut sheet, no reassignment | S | yes: discoverability | Palette action "Keyboard shortcuts" opening a sheet generated from one table; UI only |

## 01-B Views, tables, sorting, filtering, grouping, hierarchy and codes

| Feature | Status | Where in Planner / what is missing | Effort | Daily use | Build note |
|---|---|---|---|---|---|
| B1 Named views (what a view stores) | have | Saved views: columns, widths, zoom, chart type, bar options, colour, group, sort, filter, panel; stored with the programme or on the device | – | – | No print profile or scope in a view |
| B2 Create a new view | have | Saved views dialog | – | – | |
| B3 Save view as | have | Save the current view under a name | – | – | |
| B4 Open a view (with active scope) | have | Apply from the dialog | – | – | Scope has no equivalent (no subcharts) |
| B5 View categories | missing | Flat list | S | no | `category` on saved views; grouped list |
| B6 Lock view settings | missing | | S | no | `locked` flag; Save refuses overwrite |
| B7 Default views per project / per user | partial | Last columns, mode and theme remembered on the device; no project default view | S | no | `project.default_view` applied on open |
| B8 Tabbed views, tab groups, tiling | missing | One Plan view at a time (Overview / Plan / Progress screens) | M | no | Multiple view states in `S`; tab strip above the planbar; UI only |
| B9 Coloured view tabs | missing | Depends on B8 | S | no | |
| B10 Calendar (diary) views | missing | | M | no | Month grid of activities by start/finish; UI only |
| B11 RBS and CBS views | partial | Group by WBS or any code type; not by resource or cost | S | no | Add resource as a group key (duplicating multi-assigned rows) |
| B12 Project view pane (tree) | partial | The WBS outline in the table is the hierarchy; no separate tree pane with libraries | M | no | Collapsible tree beside the table; drag onto it moves activities; UI only |
| B13 Expand / contract hierarchy | have | Chevrons, Space, `S.collapsed` | – | – | |
| B14 Show To Level | have | View › Outline: summaries to level n | – | – | |
| B15 Summary tasks and expanded tasks (subcharts) | partial | WBS summaries roll up; no expanded tasks / subcharts / subprojects (README backlog #8) | L | no | Sub-programme as an activity whose duration comes from a child project: `model.py`, `cpm.py`, `engine.js`, parity, XER/MSPDI mapping |
| B16 Rearrange, create, rename, delete summaries | have | Insert summary, indent/outdent, move up/down, rename inline, delete | – | – | |
| B17 Find in project view | have | Palette searches ID and name; filter box text | – | – | |
| B18 Find on user-defined fields | have | Filter grammar `Field=value` on custom fields | – | – | |
| B19 Add / replace spreadsheet columns | have | Columns… dialog; drag column edge to resize; header click sorts | – | – | Reordering columns is S (see 03-2 row 21) |
| B20 Search for a field by name | partial | Checkbox list in Columns… | S | no | Type-to-filter box in the dialog |
| B21 Table definitions (primary and allocation rows) | partial | Activity rows only; no allocation sub-rows | M | no | Optional assignment rows under each activity in `rows()` |
| B22 Saved tables (table library) | partial | Columns are saved inside a view, not as a reusable named table | S | no | Split `cols`+`widths` into named tables referenced by views |
| B23 Column shows a specific task on a multi-task bar | missing | Depends on A4 | S | no | |
| B24 Code library entries in columns | partial | Codes show via Group, Colour, inspector and the coding sheet; no code column in the table | S | yes: a Trade or Zone column is on most programmes | `syncFieldCols` pattern: add `c:<type>` entries to `ALL_COLS` with a select editor; flows to CSV and PDF |
| B25 Free-text columns via string UDF | have | Custom text fields as columns; Notes column | – | – | |
| B26 Formula columns | missing | | L | no | Safe expression evaluator over activity fields and dates (no `eval`), typed results, in `app.js`; CSV/PDF; filter grammar can then use formula names; UI only but a real parser |
| B27 Formula Properties editor | missing | With B26 | M | no | Field/function picker and live validation |
| B28 Format cells | partial | UK dates, `d` durations, red for negative float / late; no user number formats, fonts, wrap, strikethrough | M | no | Per-column format options in `ALL_COLS` and cell CSS |
| B29 Alternate row shading and status indicators | partial | Row hover and selection styles; status chips in inspector; no status indicator column | S | no | `status` column with coloured dot (critical/started/complete) |
| B30 Sort by spreadsheet column | have | Header click; View › Sort start/finish/float/ID/name | – | – | |
| B31 Sorts/groups (named, saved) | partial | One group key (WBS or a code type) and one sort key, saved inside views; no multi-level or named sort/group | M | no | `view.group` becomes a list; nested group headers in `rows()`; UI only |
| B32 Sort/group criteria (multi-level) | missing | As B31 | M | no | Same change |
| B33 Group by day/week/month | missing | Lookahead filter is flat | S | yes: look-ahead by week is the standard site hand-out | Group key "Start week" / "Finish week" / "Month" computed from dates in `rows()`; headers like "W/C 4 May 26" |
| B34 Subheadings and banding | partial | Group header rows with rolled-up dates and %; no colour banding | S | no | CSS per group header |
| B35 Automatic page breaks per group | missing | | S | no | PDF `layout()` breaks before each group header when asked |
| B36 Filters and TQL | have | Quick filters plus a typed grammar with several conditions: `Trade=Brick; Float<5; Cost>=10000; status=in progress` | – | – | AND only; OR/NOT would be S |
| B37 Filter Wizard and Filter Properties | partial | Typed grammar only; no guided builder, no "show passing summaries' contents", no saved filter library | S | yes: site and client filters are built daily and typed grammar is a barrier for some | Builder sheet that composes the grammar (field, operator, value rows); saved filters as named items reusable by views; UI only |
| B38 Filter pages for slip, late start, link type | partial | Behind-baseline quick filter; no slip threshold, no link-type filter | S | no | Grammar keys `slip`, `linktype` |
| B39 Combine filters | have | `;` ANDs conditions; quick filter combines with text | – | – | |
| B40 Apply filter to project view | partial | Filtered table hides activities; summary rows with nothing passing still appear in some cases | S | no | Drop empty summaries in `rows()` when a filter is on |
| B41 Look-ahead views | have | Next 3 weeks quick filter, Monitor look-ahead, Overview next two weeks, site update horizon | – | – | Window length fixed at 3 weeks (S to parametrise) |
| B42 Filter and sort categories | missing | | S | no | With B5 |
| B43 Code libraries for colour, filter, sort, group | have | Colour by code, `Trade=Brick` filter, group by code | – | – | Sort by code value would be S |
| B44 Code breakdown structure | have | Group by a code type gives a header per value | – | – | |
| B45 Assign codes | have | Inspector selects; coding sheet CSV round trip; library copy | – | – | Drag assignment is D8 |
| B46 Default codes for new activities | missing | | S | no | `default` flag per code value, applied in `insertActivity` |
| B47 Code library properties: single select, critical style | have | Codes are single-valued per type by design | – | – | Critical outline over code colour is S (A67) |
| B48 Hierarchical code libraries | missing | Flat values per type | M | no | `parent` on code values; grouped headers; XER ACTVCODE `parent_actv_code_id` already written/read flat |
| B49 Flatten hierarchy | partial | Group by code flattens WBS; no explicit flat toggle | S | no | Group option "None (flat list)" |
| B50 Priority indicators | partial | `Prio` numeric column for levelling | S | no | Indicator rendering per band |

## 01-C Printing and output

| Feature | Status | Where in Planner / what is missing | Effort | Daily use | Build note |
|---|---|---|---|---|---|
| C1 Print the active view | have | PDF for issue prints the programme as shown: filter, grouping, outline level, columns, bar options | – | – | |
| C2 Output to printer, clipboard or picture | partial | PDF only | S | no | Serialise the chart SVG to PNG via canvas for clipboard/download |
| C3 Page range, selection, copies | partial | Date range, rows per page, pages wide; no page range or selection-only print | S | no | "Selected rows only" option feeding `pdfDoc` |
| C4 Print preview | partial | Text plan ("4 pages: 45 rows a page") updates live; no visual preview | M | yes: planners check the sheet before issuing | Render `P.render()` to a blob URL in an `<iframe>` inside the sheet, re-rendered on option change; UI only |
| C5 Output Fields dialog | have | Title, client, prepared by, revision, notes in the PDF dialog | – | – | |
| C6 Border files (title blocks) | partial | Fixed Asta/P6-style title block with legend and page numbers; no logo, no alternative layouts (README backlog #4) | M | yes: every issued sheet carries the company block | Logo upload (JPEG data URI → PDF XObject) and two or three block layouts in `pdf_export.js`; stored in the project or device |
| C7 Powerdraw border editor | n/a | Windows companion application | – | – | A layout picker (C6) covers the need |
| C8 Select, browse, embed, delete border | missing | One block | S | no | With C6 |
| C9 Missing-border prompt from Vision | n/a | Vision | – | – | |
| C10 Border text language | missing | English | S | no | String table in `pdf_export.js` |
| C11 Paper size and orientation | have | A4-A1, portrait or landscape | – | – | |
| C12 Tiled vs paginated output | partial | One title block per page; no single border around the whole tiled set | S | no | `layout()` option |
| C13 Fit to pages | have | Timescale across 1-4 pages; rows per page or fit to page height | – | – | "Fit to n pages tall" is S |
| C14 Override print scales | partial | Date range and pages wide set the scale implicitly; no units/cm or row height input | S | no | `row_height_mm` and `mm_per_week` inputs |
| C15 Page breaks and fit lines per page | partial | Rows per page | S | no | With A64 |
| C16 Print order and page numbering | have | Page x of y in the block; row-band then sheet order | – | – | |
| C17 Print a date range | have | From / To in the PDF dialog | – | – | |
| C18 Legends | partial | Legend for bar states (critical, baseline, float, milestone); no legend for the colour-by code or resource, nor periods | S | yes: a coloured programme needs its key | Pass the active colour map into `doc.options.legend_items`; `pdf_export.js` lays them out |
| C19 Appearance options for printed objects | partial | Colour / greyscale, weekend shading, links/float/baseline follow the view | S | no | More options as needed |
| C20 Spreadsheet font scaling | missing | Fixed point sizes | S | no | Font size option in `pdf_export.js` |
| C21 PDF output | have (better) | Native vector PDF with no driver | – | – | |
| C22 Print profiles | partial | Last PDF options remembered on the device | S | no | Named profiles saved with views or the project |
| C23 Printing calendar views | missing | With B10 | S | no | |
| C24 Hide elements for printing | have | Toggle links/float/baseline/progress in View; the PDF follows | – | – | |
| C25 Tabular reports | partial | CSV of the table as shown, as-built CSV, coding sheet; no report templates or printable table-only reports | M | no | PDF table-only mode in `pdf_export.js` plus saved report definitions (columns, filter, sort) |
| C26 Resource reports | partial | Histogram and cost bands on screen only | M | no | Band to PDF page |
| C27 Business Intelligence export to Excel | partial | CSV per view | M | no | Multi-sheet workbook (activities, links, resources, assignments, periods) via the xlsx skill or a minimal OOXML writer |
| C28 Export / print the timeline | missing | With A65 | S | no | |
| C29 Views available in the free viewer | partial | Client mode and the shared page show everything read-only; no per-view flag | S | no | `client_visible` on saved views |
| C30 Date shading only in the date zone when printing | missing | With A41 | S | no | |

## 01-D Library Explorer and the libraries

| Feature | Status | Where in Planner / what is missing | Effort | Daily use | Build note |
|---|---|---|---|---|---|
| D1 Library Explorer window | partial | Separate dialogs: Calendars, Resources and crews, Activity codes, Custom fields, Codes/fields/views library | M | no | One tabbed "Set-up" sheet wrapping the existing dialogs; UI only |
| D2 Full list of 37 libraries | partial | Present: calendars, resources, codes, custom fields, views, baselines, revisions, progress periods, annotations. Absent: the rest (see rows below) | L | no | Informational row; effort is the sum of the rows below |
| D3 Create objects and folders | partial | Create in each dialog; no folders or inheritance | S | no | `folder` on codes/resources |
| D4 Paste lists from Excel | partial | Coding sheet CSV import creates code values and fields; no paste of a resource or code list | S | no | Paste handler on the codes/resources dialogs (one value per line) |
| D5 Edit properties in data columns | have | Inline tables in the dialogs | – | – | |
| D6 Customise libraries and columns shown | missing | | S | no | With D1 |
| D7 Select, move, copy objects | partial | Library copy between programmes and via file; no drag or folders | S | no | With D3 |
| D8 Assign by drag and drop from the library | missing | Assignment via inspector selects, Resources column text, `assign` command, coding sheet | S | no | Draggable chips in a codes/resources palette dropping onto bars; UI only |
| D9 Assign from the project view | missing | As D8 | S | no | |
| D10 Calendars | have | Working days, hours per day, day start, dated exceptions; per activity; project default | – | – | Shift patterns are 1.58 |
| D11 Work patterns, exceptions, work units | partial | Exceptions are date → hours; no shift patterns, exception categories or work units | M | no | Exception categories are UI; patterns are 1.58 (both engines) |
| D12 Code libraries | have | Code types with coloured values | – | – | Hierarchy is B48 |
| D13 Cost centres | missing | Costs hang off resource assignments only (README backlog #9) | L | no | `CostCentre` and cost allocations in `model.py`, `analysis.py` cost curve, `engine.js`, parity on cost figures; MSPDI/XER cost mapping |
| D14 Permanent resources | have | Labour and equipment with max per day, rate, colour | – | – | Skills, dates, folders are 4.2 |
| D15 Consumable resources | partial | `material` type exists with rate × units; no quantity consumption modelling | M | no | Quantity and delivery fields; histogram of consumption |
| D16 Allocation groups and materials | missing | | M | no | Named bundles of assignments applied in one step |
| D17 Task pools (fragnets / templates) | partial | Copy/paste blocks within a programme; the library file carries codes, fields and views but not task networks | M | yes: per-plot, per-floor and per-house fragnets are everyday in housing and fit-out | Library file gains `fragnets: [{name, activities, links}]`; "Insert fragnet at date" renumbers IDs and offsets dates; data + UI only, no engine change |
| D18 User-defined fields | have | Text, number, date fields: columns, filters, inspector, PDF, CSV, P6 UDFs both ways | – | – | Boolean/duration/URL types are S |
| D19 Formulae library | missing | With B26 | L | no | |
| D20 Filters library | partial | Filters live inside saved views | S | no | Named filters reusable across views |
| D21 Sorts/groups library | partial | Inside saved views | S | no | With B31 |
| D22 Table definitions library | partial | Inside saved views | S | no | With B22 |
| D23 View categories library | missing | | S | no | With B5 |
| D24 Print profiles library | partial | Device-remembered PDF options | S | no | With C22 |
| D25 Tabular reports library | missing | | M | no | With C25 |
| D26 Milestone appearances library | missing | | S | no | With A66 |
| D27 Link categories library | missing | | M | no | With A37 |
| D28 Annotation categories library | missing | | S | no | With A62 |
| D29 Time units library | missing | | M | no | With A3 |
| D30 Currency units | missing | Sterling fixed | S | no | Currency symbol setting used by cost band and PDF |
| D31 Progress periods, users, security groups, quality checks, resource curves, histogram reports, standard work, task activity templates | partial | Progress periods: have. Quality check: fixed DCMA set. The others absent | L | no | Sum of rows 6.1, 4.9, 1.55 and the n/a security rows |
| D32 Global Library Explorer / Vision global libraries | n/a | Vision server | – | – | The library file and copy-from-programme cover sharing between programmes |
| D33 Copy library objects between projects | have | Codes, fields and views library: copy from another programme or a file (also reads codes/fields from an XER) | – | – | |

## 02-1 Scheduling and logic

| Feature | Status | Where in Planner / what is missing | Effort | Daily use | Build note |
|---|---|---|---|---|---|
| 1.1 Four link types | have | FS/SS/FF/SF in `cpm.py` and `engine.js`; drawn by bar ends | – | – | |
| 1.2 Mid-task links | have | Expressed as lag on the link, as Asta stores them | – | – | |
| 1.3 Lead/lag at either or both ends | have | One lag per link; a lag at both ends is the sum | – | – | |
| 1.4 Lag type: duration or percentage | missing | Hours only | M | no | `lag_pct` on `Relationship`; `cpm.py` + `engine.js` + parity; no XER/MSPDI field |
| 1.5 Lag calendars | in progress | Lags use the predecessor calendar today (README known limit); predecessor / successor / project / 24-hour option is being built in both engines by another agent | – | yes: correctness for imported P6 and Asta jobs | Needs the parity corpus case and XER `clndr`/MSPDI mapping when it lands |
| 1.6 Per-link calendar field | in progress | As 1.5; confirm whether the option is per project or per link when it lands | – | no | |
| 1.7 Draw links with lead/lag by SHIFT-drag | partial | Lag typed in the link dialog (double-click a link) or in the Predecessors cell (`A1020SS+2`) | S | no | Shift while dropping a link opens the lag field |
| 1.8 Maximum lag (maximum slope) | missing | | M | no | Reverse constraint in the forward pass pulls the predecessor; `cpm.py`, `engine.js`, parity |
| 1.9 Maintain task offsets links | missing | | M | no | Per-link "keep offset" turning drag offsets into lags; both engines, parity |
| 1.10 Link categories | missing | As A37 | M | no | |
| 1.11 Link diagnostics on the link | partial | `driving` flag, critical when both ends critical, lag; no on-loop, link float, slope | S | no | Compute link free float in the link dialog from early/late dates |
| 1.12 Implied links between tasks on one bar | missing | As A4 | L | yes | With A4 |
| 1.13 Link logic tracing (Links tab) | have | Inspector chips with driving in bold; trace back/forward; why-chain | – | – | |
| 1.14 Constraint flags | have | Start/finish on-or-after, on-or-before, must start/finish on, ALAP (`CONSTRAINTS`) | – | – | "Work between" = must start on + must finish on |
| 1.15 Deadline flag | partial | Project deadline (`must_finish_by`) drives the backward pass, CPLI and the deadline line; no per-activity deadline | S | yes: sectional completions and key dates with their own deadlines | `Activity.deadline` (no effect on dates), marker on the bar, `late` filter and briefing watch item, MSPDI `<Deadline>` both ways; no engine change |
| 1.16 Holding pin | missing | Dragging sets start-on-or-after, as Asta does, but it does not move with a reschedule | M | no | Constraint kind that re-anchors to the current early start on each schedule; both engines, parity |
| 1.17 Flag priority rules | have | Hard flags beat soft in the passes | – | – | |
| 1.18 Start on new day | missing | Successors start mid-day when the predecessor finishes mid-day | S | no | Flag rounding early start to the next day start in `cpm.py` and `engine.js`; parity |
| 1.19 Must complete within (period / shift) | missing | | M | no | Both engines, parity |
| 1.20 Placement ASAP / ALAP / Force critical | partial | ASAP and ALAP; no Force critical | S | no | Flag that zeroes float in the backward pass; both engines, parity |
| 1.21 Imposed start / imposed finish | have | Project start and `must_finish_by` as the late anchor (negative float when breached), P6 style | – | – | Backward scheduling of early dates is not offered (no) |
| 1.22 Delivery date | have | `must_finish_by`: deadline line, spare days, CPLI, briefing, `finish by` command | – | – | |
| 1.23 Reschedule scopes | partial | Whole programme, always | S | no | Low value with automatic recalculation |
| 1.24 Options for tasks with no links | partial | Unlinked work goes ASAP from the data date or project start | S | no | "Leave where drawn" would set a constraint on import |
| 1.25 Compatibility reschedule options | missing | | S | no | Legacy behaviours; skip |
| 1.26 Out-of-sequence handling | partial | Retained logic only (README known limit); out-of-sequence list in guardrails | M | no | Progress-override option in `cpm.py` and `engine.js`; parity |
| 1.27 Truncate float within chart boundaries | missing | | S | no | Needs subcharts (B15) |
| 1.28 Straighten progress line to the report date | have | Remaining work is scheduled from the data date on every recalculation | – | – | |
| 1.29 Ignore link categories during reschedule | missing | With 1.10 | M | no | |
| 1.30 Critical path drag | have | `critical_drag` in guardrails; Drag column; palette action | – | – | |
| 1.31 Cascade activity numbers | missing | | S | no | Sort option "Logic order" from `topological_order`; UI only |
| 1.32 Critical path integrity check | have | DCMA critical path test (`cp_test`) | – | – | |
| 1.33 Automatic reschedule | have | Every edit recalculates; live during drags | – | – | |
| 1.34 Reschedule report | partial | DCMA report, loop error, out-of-sequence list, Compare commentary, Try-mode finish delta; no single reschedule log with milestones before and after | S | no | Compare current with the pre-edit snapshot after each mutate and list moved milestones in a toast/panel |
| 1.35 Reschedule errors and warning popup | partial | Loop detection raises an error; negative float flagged in health; Monitor rows jump to activities | S | no | "Show failing activities" filter from a failed check |
| 1.36 Float fields | have | TF, FF, late start, late finish, Var columns; near-critical quick filter | – | – | |
| 1.37 Float display on the bar chart | have | Float bars toggle | – | – | Free float bar is A35 |
| 1.38 Definition of critical | partial | Longest path, fixed; near-critical at 10 days, fixed | S | no | Threshold input |
| 1.39 Summaries and buffers shown as non-critical | partial | Summary rows red when their contents are critical; not switchable | S | no | View option |
| 1.40 Negative float / super-critical | have | Negative float against the deadline; DCMA check; inspector chip | – | – | |
| 1.41 Logical paths (float-path analysis) | missing | | M | no | Number driving chains by rising float from `driving` flags in `app.js`; group by path; UI only |
| 1.42 Slip field and slip filter | partial | Var (finish vs baseline) and Behind-baseline filter; no slip vs report date per period | S | no | `slip` column from the last closed period snapshot |
| 1.43 Critical-task filtering | have | Critical and near-critical quick filters; `Float<5` grammar; Drag column | – | – | |
| 1.44 Buffer (contingency) tasks | missing | README backlog #10 | L | no | Activity type whose duration flexes to a deadline; `cpm.py`, `engine.js`, parity; MSPDI mapping as task + deadline |
| 1.45 Buffer consumption monitoring | missing | With 1.44 | M | no | |
| 1.46 Interruptible tasks and milestones | missing | | M | no | Both engines, parity |
| 1.47 NEC contract support | n/a | NEC template content; custom fields can hold TRA and justification today | – | – | |
| 1.48 Hammocks | have | `level_of_effort` type spans its SS/FF predecessors | – | – | |
| 1.49 Summary tasks and groups | have | WBS summaries roll up dates and % | – | – | |
| 1.50 Expanded tasks, subcharts, portfolio | missing | As B15 | L | no | |
| 1.51 Rules for parent tasks | partial | Summaries cannot carry links here (Asta allows start-in / end-out); progress rolls up | S | no | Links to WBS mapped onto first/last child on entry |
| 1.52 Task pools | partial | As D17 | M | yes | |
| 1.53 Milestones: start and finish types | have | `start_milestone` / `finish_milestone`; Toggle milestone picks the type from its links | – | – | |
| 1.54 Task types available | partial | Task, start/finish milestone, WBS summary, hammock; no buffer, interruptible or expanded | L | no | Sum of 1.44, 1.46, 1.50 |
| 1.55 Task activities (weighted sub-steps) | missing | | M | no | `steps: [{name, weight, done}]` on an activity feeding `percent_complete`; both engines for the % roll-up; parity |
| 1.56 Task work modelling (work / rate) | partial | The generator sizes durations from `RATES` at generation; no live quantity × rate on an activity | M | no | `quantity`, `rate` fields with duration recomputed on edit; UI + `plan.py` patch op |
| 1.57 Calendars: structure | partial | One weekly pattern plus dated exceptions per calendar | M | no | Multiple dated patterns is 1.58 |
| 1.58 Work patterns and shifts | missing | One shift per working day (README known limit) | L | no | Shift list per weekday in `Calendar`, `add_hours`/`hours_between` in `model.py` and `engine.js`, DST-safe; parity corpus |
| 1.59 Exceptions (holidays, overtime, categories) | partial | Date → hours (0 = holiday, more = overtime); no categories, Excel import or overrun | S | no | Paste a date list into the Calendars dialog |
| 1.60 Per-task calendars | have | Calendar column and inspector; durations kept in days on change | – | – | |
| 1.61 Resource calendars | missing | Resources have no calendar | M | no | `Resource.calendar_id` used by levelling and histograms; both engines, parity |
| 1.62 Default calendar | have | Project default in the Calendars dialog; drives non-working shading | – | – | |
| 1.63 Duration and elapsed duration fields | partial | Working-day durations; as-built CSV gives actual calendar days | S | no | `edur` column |
| 1.64 P6 compatibility mode and export/import checkers | have (better) | "What the other tool will receive" fidelity check before every XER/XML export; import summary; Compare with a file | – | – | A planning-time mode is 03-1 row 14 |

## 02-2 Progress

| Feature | Status | Where in Planner / what is missing | Effort | Daily use | Build note |
|---|---|---|---|---|---|
| 2.1 Progress periods library | have | Closed periods with data date, per-activity snapshot, headline figures, period lines | – | – | Per-period colours are 2.20 |
| 2.2 Progress entry period | have | The data date | – | – | |
| 2.3 Changing a period's report date | have | Data date field; `data date` command; site update as-of | – | – | |
| 2.4 Locking progress periods | partial | Closed periods are frozen snapshots; actuals before them can still be edited | S | no | Warn when an actual date is before the last closed period |
| 2.5 Progress basis: duration % vs overall % | partial | One % tied to remaining duration | M | no | Independent overall % field; both engines for roll-up; parity |
| 2.6 Entry mode: update in step / fill to line | partial | % sets remaining; days-left sets %; remaining is scheduled from the data date | S | no | Option to leave remaining duration untouched when % changes |
| 2.7 Mark progress by dragging on the bar | have | `startProgressDrag` on the bar's progress handle | – | – | New since the inventories |
| 2.8 Progress Up To a date | partial | `progress A1010 50% as of <date>` command; site update treats a blank start as "as planned"; no one-click "progress the selection as planned to the data date" | S | yes: the Monday update for work that went to plan | Progress dialog option "As planned to the data date" for the selection, computing % from the planned span; UI only |
| 2.9 Progress as planned | have | Site update: blank dates = as planned | – | – | |
| 2.10 Enter Progress dialog | have | Progress dialog (% and as-of) for the selection; inspector %, actual dates, suspend/resume; site update days-left | – | – | No cost/quantity rows (4.29) |
| 2.11 Progress % on a multi-selection | have | Progress dialog applies to all selected | – | – | |
| 2.12 Progress via spreadsheet fields | have | %, Actual start, Actual finish columns editable | – | – | |
| 2.13 Top-down / bottom-up from allocations | missing | | M | no | Per-assignment actual units feeding activity %; both engines |
| 2.14 Task activity progress | missing | With 1.55 | M | no | |
| 2.15 Actual, remaining, original duration; resume date | partial | `remaining_hours`, suspend and resume dates; no actual or original duration columns | S | no | `rem`, `adur`, `odur` in `ALL_COLS` |
| 2.16 Percent-complete types | partial | One duration-based %; planned % at programme level | M | no | With 2.5 |
| 2.17 Parent progress method and weighting | partial | Summary % rolls up; not configurable | S | no | Option duration / count weighting |
| 2.18 Task splitting by progress | partial | Suspend/resume splits the remaining work in the engine; the bar is drawn whole | S | no | Draw the gap in `chart()` and PDF |
| 2.19 Out-of-sequence progress handling | have | Retained logic; guardrails list with reasons | – | – | |
| 2.20 Progress lines: straight or jagged | have | Jagged progress line through % points; dashed line per closed period | – | – | Colour per period is S |
| 2.21 Progress lines in the date zone | missing | As A53 | S | no | |
| 2.22 Show only completed or uncompleted work | partial | In-progress and Not-finished quick filters | S | no | Draw only the remaining part option |
| 2.23 Status date and straightening | have | Data date | – | – | |
| 2.24 Selectively remove progress by period | partial | Undo; "Not started" in site update per activity | S | no | Bulk "clear progress after <period>" from a period snapshot |
| 2.25 Transfer progress between projects | missing | | M | no | Copy actuals by ID from another programme or file |
| 2.26 Progress reports | have (better) | Briefing (what changed, watch, next two weeks), Monitor, periods panel, as-built CSV, Compare commentary, status note | – | – | |
| 2.27 Project timeline | partial | As A65 | M | no | |
| 2.28 Progress period parameter in formulae | missing | With B26 | L | no | |
| 2.29 Maintain allocation profiles on progress | missing | No profiles (4.9) | M | no | |
| 2.30 Asta Siteprogress (mobile capture) | partial | Site mode: phone-first update sheet in the same app, no install; no offline app, photos, approval queue (README backlog #11) | L | no | Phase 2; photos as dated notes would be M |
| 2.31 Dated notes on tasks | partial | One notes field | S | no | `notes` becomes a list of `{at, text, url}`; inspector list |

## 02-3 Baselines and comparison

| Feature | Status | Where in Planner / what is missing | Effort | Daily use | Build note |
|---|---|---|---|---|---|
| 3.1 Unlimited baselines | have | Named baselines list; one in use | – | – | |
| 3.2 Baseline wizard: scope and storage | partial | Whole programme, stored with the project | S | no | "Baseline selected activities only" merging into the active baseline |
| 3.3 Baseline manager dialog | partial | Set baseline…, use, clear via More and API; no grid with description, appearance, merge, revert | S | no | Baselines sheet listing name, date, finish, with use/delete |
| 3.4 Current baseline | have | `use_baseline` | – | – | |
| 3.5 Active / inactive baselines | have | Only the baseline in use is drawn | – | – | |
| 3.6 Project baselines per sub-project | missing | No sub-projects | L | no | With B15 |
| 3.7 Merging live data into a baseline | missing | | S | no | Copy live dates for selected or new activities into the active baseline; `levelling.py` + `engine.js` helper; parity on the stored dates |
| 3.8 Revert to baseline (what-if) | partial | Undo/redo, Try mode keep/discard, frozen revisions | S | no | "Restore revision" and "Restore baseline dates as constraints" |
| 3.9 Open a baseline as a project | partial | Revisions can be compared, not opened | S | no | Open a revision read-only in Client mode |
| 3.10 Import a project or XER as a baseline | partial | Compare with a file; cannot set a file as the baseline | S | no | "Use as baseline" on the Compare sheet, matching by ID |
| 3.11 Export / embed baselines | have | Baselines travel in the project JSON, XER target dates and MSPDI `<Baseline>` | – | – | |
| 3.12 Baseline user-defined fields | missing | | S | no | `fields` on `Baseline` |
| 3.13 Baseline bars | have | Baseline bars beneath live, toggle | – | – | |
| 3.14 Baseline progress period lines | missing | | S | no | Store period lines inside the baseline record |
| 3.15 Default and per-baseline colours | missing | Fixed colour | S | no | `colour` on `Baseline` |
| 3.16 Variance fields | partial | BL start, BL finish, Var (finish); no start or duration variance columns, no sign convention switch | S | yes: variance columns are on every progress report | `svar`, `dvar` in `ALL_COLS` mirroring `var`; CSV/PDF follow |
| 3.17 Variance tab per task | partial | Inspector and hover show days vs baseline | S | no | Live / baseline / difference block in the inspector |
| 3.18 Jagged progress view | have | Progress line and period lines against live bars | – | – | Against baseline bars is S |
| 3.19 Baseline data in histograms | partial | Cost band draws the baseline S-curve (BCWS); resource histogram has none | S | no | Baseline demand series from `Baseline.dates` |
| 3.20 Baseline-based filters | have | Behind-baseline quick filter | – | – | |
| 3.21 Baseline conformity metrics | have | BEI and missed tasks in DCMA | – | – | |
| 3.22 Planned fields derived from baseline | partial | Planned % at programme level (briefing, periods); not per activity | S | no | `ppc` column |
| 3.23 Vision baselines | n/a | Vision | – | – | |
| 3.24 Compare views / project comparison | have (better) | Compare versions: added/removed/renamed, durations, logic, constraints, progress, calendars, date moves, critical path joined/left, plain-English commentary; revisions frozen with the project | – | – | |

## 02-4 Resources and cost

| Feature | Status | Where in Planner / what is missing | Effort | Daily use | Build note |
|---|---|---|---|---|---|
| 4.1 Permanent, consumable, materials, allocation groups | partial | Labour, equipment, material types; no folders or groups | M | no | With D16 |
| 4.2 Resource properties: availability, dates, calendar, skills | partial | Max per day, rate, colour | M | no | Dated availability and calendar; `levelling.py` + `engine.js`, parity |
| 4.3 Assigning resources and costs | have | Resources column, inspector, `assign` command, Resources dialog | – | – | |
| 4.4 Demand vs scheduled allocations | missing | | L | no | Role-level demand satisfied by named resources; both engines |
| 4.5 Resource modelling (effort-driven) | missing | Duration-driven only | M | no | `effort_driven` on activities: duration = units / (people × hours); `cpm.py`, `engine.js`, parity |
| 4.6 Own effort / share effort | missing | With 4.5 | S | no | |
| 4.7 Work rate, quantity-from-task logistics | missing | Generator rates only | M | no | With 1.56 |
| 4.8 Availability check on assignment | partial | Histogram flags over-allocation with days over; no popup when assigning | S | no | Toast from `dailyDemand` after an assignment edit |
| 4.9 Nonlinear allocations and resource curves | missing | README known limit | M | no | Curve on assignment used by `analysis.py`/`levelling.py` and `engine.js`; parity |
| 4.10 Histograms | partial | Per-resource daily/weekly band under the chart with the crew limit; cost band; no cumulative, stacked or exported histograms | S | no | Cumulative toggle and PNG/CSV export |
| 4.11 22 default graph definitions | missing | | M | no | Several series from `dailyDemand` |
| 4.12 Filter allocations in histograms | missing | | S | no | Histogram respects the view filter |
| 4.13 Resource usage view (time-phased table) | missing | | M | no | Table of `dailyDemand` by week per resource; UI only |
| 4.14 Calendar views of allocations | missing | With B10 | M | no | |
| 4.15 Resource levelling methods | partial | Serial delay only; no split or stretch | M | no | `levelling.py` + `engine.js`, parity |
| 4.16 Leveller dialog options | partial | One-click level, priority field; no date range, granularity, resource choice | S | no | Options passed to `level()` |
| 4.17 Per-resource / per-allocation levelling options | missing | | M | no | With 4.15 |
| 4.18 Task levelling priority and delay | have | Prio and Lvl delay columns | – | – | |
| 4.19 Leveller behaviour rules | have | Topological order, late start then priority, as P6/Asta | – | – | |
| 4.20 Undo levelling | have | Remove levelling; undo | – | – | |
| 4.21 Manual levelling with live histograms | have | Band recalculates on every edit | – | – | |
| 4.22 Cost centres (budgets) | missing | As D13 | L | no | |
| 4.23 Direct cost / income allocations | partial | Assignment planned/actual cost, or rate × units | S | no | Fixed-cost assignment with no resource |
| 4.24 Rates by time type, income rates | missing | | M | no | Rate table on resource; `analysis.py` + `engine.js` |
| 4.25 Consumable resource costs | partial | Material rate × units | S | no | Cost per use |
| 4.26 Cash flow / income and expenditure | partial | Cost S-curve planned, baseline, earned, actual; no income or payment terms (README backlog #9) | M | no | Payment terms shifting cost into cash in `analysis.py` + `engine.js`; parity |
| 4.27 Expenditure limit | missing | | S | no | Budget line on the cost band |
| 4.28 Currencies | missing | Sterling | S | no | With D30 |
| 4.29 Task-level cost fields | partial | `Cost>=10000` works in the filter grammar; no cost column or inspector field | S | no | `cost` in `ALL_COLS` from `activity_cost` |
| 4.30 Earned value analysis | have | BCWS, BCWP, ACWP, SPI, CPI, SV in `analysis.py` and the cost band | – | – | EAC per activity is S |
| 4.31 S-curves | have | Cost S-curve with period points; Monitor S-curve | – | – | |
| 4.32 Budget vs planned vs actual | have | Cost band | – | – | |
| 4.33 Resource editing permissions | n/a | Enterprise security | – | – | |
| 4.34 Task-level effort fields | partial | Assignment units (hours); no demand or remaining effort | S | no | Remaining units from % complete |

## 02-5 Risk analysis

| Feature | Status | Where in Planner / what is missing | Effort | Daily use | Build note |
|---|---|---|---|---|---|
| 5.1 Built-in quantitative risk | have (better) | Monte Carlo in `risk.py` and `engine.js`, seeded and identical | – | – | |
| 5.2 Duration uncertainty per task | partial | Global optimistic/pessimistic %, extra for weather-exposed names; no per-task min/max or probability | M | no | `risk: {min_pct, max_pct, probability}` on activities read by both engines; parity |
| 5.3 Uncertainty via code libraries | missing | With 5.2 | S | no | Code value → range table |
| 5.4 Default percentages and precedence | partial | Global defaults | S | no | With 5.2 |
| 5.5 Risk settings | partial | Iterations, percentages, correlation, seed; whole programme | S | no | Scope by filter |
| 5.6 Distributions | partial | Triangular only | S | no | Uniform/normal draws in both engines; parity |
| 5.7 Sampling methods | partial | Monte Carlo only | S | no | Latin hypercube is a stratified `u`; both engines |
| 5.8 Treatment of progressed tasks | have | Complete excluded; remaining duration varied | – | – | |
| 5.9 Sensitivity reports | partial | Criticality index; no duration-sensitivity correlation ranking | S | no | Pearson of task duration vs finish per iteration in both engines |
| 5.10 Likelihood and distribution reports | have | P10/P50/P80/P90, chance of deadline and of today's finish, histogram in the risk sheet | – | – | |
| 5.11 Apply an iteration / baseline from it | missing | | S | no | Set P80 dates as a baseline |
| 5.12 Export of risk results | partial | On screen | S | no | CSV of the iteration finishes and criticality |
| 5.13 Tornado, correlation, risk register | n/a | Not offered by Asta either; Planner's correlation and criticality go further | – | – | |

## 02-6 Quality checks and schedule problems

| Feature | Status | Where in Planner / what is missing | Effort | Daily use | Build note |
|---|---|---|---|---|---|
| 6.1 Schedule Quality Check (library object) | partial | Fixed DCMA 14 + open ends + dangling with a score; thresholds and weights not editable | M | no | Check definitions as data with thresholds; `dcma.py` + `engine.js`; parity |
| 6.2 Quality check scope | partial | Whole programme; complete work excluded where DCMA says so | S | no | Scope by filter |
| 6.3 Executing and reviewing checks | have (better) | Monitor health with offending activities, go-to, auto-repair | – | – | |
| 6.4 DCMA 14-point and CIOB PP21 templates | partial | DCMA yes; no CIOB Planning Protocol 2021 set | S | no | Second threshold table and name in `dcma.py` + `engine.js`; parity |
| 6.5 Rescheduled correctly | have | Loop detection; negative float check | – | – | |
| 6.6 Critical activities % | missing | | S | no | One check in both engines |
| 6.7 Detail (long durations) | have | High duration | – | – | |
| 6.8 Resourced or costed | have | Unresourced activities | – | – | |
| 6.9 Unique names | missing | | S | no | One check |
| 6.10 Invalid dates | have | Invalid dates | – | – | |
| 6.11 Unique task IDs | have | IDs are unique by model | – | – | |
| 6.12 Link logic (open ends) | have | Missing logic, single start and finish, dangling logic | – | – | |
| 6.13 Critical path test | have | `cp_test` | – | – | |
| 6.14 Link logic density | missing | | S | no | One check |
| 6.15 Lags | have | | – | – | |
| 6.16 Leads | have | | – | – | |
| 6.17 Merge hotspot | missing | | S | no | One check |
| 6.18 FS links with lead/lag | partial | Lags and leads counted over all links | S | no | FS-only variant |
| 6.19 Logic type (SS/FF share) | have | Finish-to-start share | – | – | |
| 6.20 Link activity finishes | have | Dangling logic covers it | – | – | |
| 6.21 Hard constraints | have | | – | – | |
| 6.22 Soft constraints | missing | | S | no | One check |
| 6.23 Negative float | have | | – | – | |
| 6.24 Large float | have | High float | – | – | |
| 6.25 CPLI | have | | – | – | |
| 6.26 BEI | have | | – | – | |
| 6.27 Missed tasks | have | | – | – | |
| 6.28 Baseline variance metric | missing | | S | no | One check |
| 6.29 Rollup tasks not linked | have | Summaries cannot carry links here | – | – | |
| 6.30 Rollup tasks not resourced | have | Summaries cannot carry resources | – | – | |
| 6.31 ASAP force critical | n/a | No such flag | – | – | |
| 6.32 Start-to-finish links % | missing | | S | no | One check |
| 6.33 Finish-to-start links % | have | | – | – | |
| 6.34 Middle-to-middle links | n/a | Single lag per link | – | – | |
| 6.35 Reschedule report as a problems list | partial | As 1.34 | S | no | |
| 6.36 Post-reschedule warning with problem-task view | partial | Health score in Monitor; Monitor rows jump to activities | S | no | Toast with "show them" after an edit that breaks a check |
| 6.37 Unschedulable / integrity / on-loop flags | partial | Loop error; Drag column; no per-activity flags | S | no | Column from check results |
| 6.38 Filter pages for schedule hygiene | partial | Critical, near-critical, behind-baseline quick filters; `Float` grammar; no constraint-type or link-type filter | S | no | `constraint=`, `linktype=` grammar keys |
| 6.39 Spreadsheet status indicator | partial | Red for negative float and late; status chips in inspector | S | no | With B29 |
| 6.40 Quality checks in Asta Vision | n/a | Vision | – | – | |

## 03-1 File interoperability

| Feature | Status | Where in Planner / what is missing | Effort | Daily use | Build note |
|---|---|---|---|---|---|
| Native .PP project file | n/a | Proprietary; read-only through the MPXJ bridge in the full app | – | – | |
| Save in a previous Powerproject version | n/a | | – | – | |
| Save as template | partial | Library file (codes, fields, views) and the generator; no programme template file | S | no | "Save as template" = project JSON minus progress and baselines; "New from template" in the Start flow; UI only |
| Asta Easyplan format | n/a | Proprietary | – | – | |
| Backstage Import/Export menu | have | Share & export sheet; Import button (XER, P6 XML, MSPDI, JSON, .pp/.mpp via bridge) | – | – | |
| Microsoft Project XML import | have | `mspxml.py` / `import_xml.js`, parity tested | – | – | |
| Microsoft Project MPP import/export | have | Read through the MPXJ bridge (full app); write as MSPDI | – | – | |
| Microsoft Project export wizard | have | MSPDI writer with the fidelity check | – | – | |
| MS Project conversion rules | have | Fidelity report lists what the other tool receives | – | – | |
| Primavera P6 import (XER / XML), SureTrak | have | XER and PMXML natively; SureTrak via bridge | – | – | |
| P6 Import Checker | have | Import summary and Compare with a file | – | – | |
| Primavera P6 export (XER / XML) | have | XER with calendars, codes, UDFs; no P6 XML writer (XER covers it) | – | – | |
| P6 Export Checker | have (better) | Runs before every export | – | – | |
| Primavera compatibility mode | partial | Checked at export, not while planning | S | no | Live badge in the facts strip from `fidelityReport` |
| Primavera conversion rules | have | Documented by the fidelity report | – | – | |
| TILOS XML import | missing | | M | no | Reader in `import_any.js` + Python; parity |
| CSV export | have | Export to Excel (CSV) of the table as shown | – | – | |
| HTML export | partial | Shareable browser page instead of an HTML table | S | no | Static HTML table + SVG download |
| Clipboard / WMF / picture output | missing | | S | no | As C2 |
| Excel interchange by copy/paste | partial | Coding sheet CSV out and in; no paste of cells or rows from Excel into the table | M | yes: pasting an activity list or dates from Excel is everyday | Paste handler on `#sheet`: TSV rows → new activities or cell values by column; UI only |
| Calendar exceptions from Excel | missing | | S | no | As 1.59 |
| Business Intelligence export | partial | As C27 | M | no | |
| Tabular report outputs | partial | As C25 | M | no | |
| PDF output | have (better) | Native | – | – | |
| Import a project / XER / XML as a baseline | partial | As 3.10 | S | no | |
| Archive files (Enterprise) | n/a | | – | – | |
| PPV viewer file (4D) | n/a | BIM/4D | – | – | |
| Project Viewer (free read-only viewer) | have (better) | Shared page, Client mode and `standalone.html` open anywhere without install | – | – | |
| OLE automation / macros | have (better) | REST API, MCP tools, Python package | – | – | |
| Publishing allocations to Outlook / SMTP | missing | Unverified in Asta too | S | no | mailto with the status note is nearly there |
| Site Progress export/import | partial | As 2.30 | L | no | |

## 03-2 User-interface conventions planners rely on

| Feature | Status | Where in Planner / what is missing | Effort | Daily use | Build note |
|---|---|---|---|---|---|
| Window anatomy | partial | Top bar, planbar, table, Gantt, divider, inspector, bands, Monitor; no project-view pane or status bar | S | no | Facts strip is the status bar; see row 15 |
| Ribbon tabs | have | Planbar groups Edit / Schedule / View, More menu, ⌘K palette with every action | – | – | |
| Backstage (File tab) | have | Share & export, Import, Projects, Start flow | – | – | |
| Ribbon minimise / colour scheme / customisation | missing | Theme only | M | no | Low value with the palette |
| Quick Access toolbar | have | ⌘K palette | – | – | |
| Project view (hierarchy pane) | partial | As B12 | M | no | |
| Spreadsheet | have | Inline edit, F2/Enter, `3d` / `2w` durations, typed dates, resizable columns | – | – | Bold/strikethrough is B28 |
| Bar chart: bars vs tasks | missing | As A4 | L | yes | |
| Date zone | partial | Three fixed tiers; Ctrl+wheel and buttons zoom; no drag-to-rescale or line editing | S | no | Drag on the header to zoom |
| Properties view (docked) | have | Inspector | – | – | |
| Bar and Task Properties dialog | have | Inspector on double-click | – | – | |
| Link Properties dialog | have | Double-click a link: type, lag, delete | – | – | |
| Enter Progress dialog | have | Progress dialog, inspector, site update | – | – | |
| Object Edit toolbar | partial | As A15 | S | yes | |
| Status bar | partial | Facts strip (start, finish, deadline, health) and the trace chip; the active text filter and quick filter have no indicator to clear with one click | S | no | Filter chip with × next to the search box |
| Right-click menu on a bar / task | have | Context menu: insert, delete, copy, paste, indent, move, link, inspect, trace, progress, constraint, milestone, notes, chart note | – | – | |
| Right-click menu on a link | have | Click to select, Delete key, double-click to edit | – | – | Right-click on a link itself is S |
| Right-click in the Line column | partial | No line-number column; insert below from any row | S | no | Row-number gutter |
| Right-click a blank bar-chart area | have | "Add a note on the chart here"; View popover for format | – | – | |
| Right-click menus in the project view | partial | No pane; defaults set in dialogs | S | no | With B12 |
| Right-click a spreadsheet column heading | partial | Click sorts, drag resizes, Columns… dialog; no add/replace/remove at position, no reorder | S | yes: adding a column where you want it | Header context menu (insert column…, hide, sort) and drag-to-reorder of `S.cols`; UI only |
| Keyboard: scheduling and selection | partial | Ctrl+L link, Ctrl+U unlink, Del, arrows, Ctrl+A; no Link Tasks mode key; F9 unnecessary (automatic) | S | no | With A19 and A69 |
| Keyboard: files, windows, views | partial | Ctrl+Z/Y, Ctrl+K, F2; no Ctrl+P (PDF) or Ctrl+S (autosave) | S | no | Bind Ctrl+P to the PDF sheet |
| Keyboard: bar chart scrolling | partial | Browser scroll, + / -, Fit, Today | S | no | Alt+arrows pan |
| Show/Hide toggles | partial | As A34 | S | yes | |
| Task pools (fragnets) | partial | As D17 | M | yes | |
| Drag-and-drop from pane onto tasks | missing | As D8 | S | no | |
| Dragging a task horizontally | have | Push or pull with live recalculation, ghost, snap-back with reason | – | – | |
| Dragging a task end | have | Either end; minimum half a day (no shrink-to-milestone) | – | – | |
| Dragging vertically / between bars | partial | As A14 | M | yes | |
| Snapping | partial | As A2 | S | yes | |
| Drawing tasks | partial | As A1 | S | yes | |
| Drawing and editing links | have | Drag from end dots; type from the ends | – | – | Re-attaching by dragging a link end is S |
| Link Tasks mode, block linking, delete and relink | partial | Block link (Ctrl+L) and delete-with-bridging exist; no Link Tasks mode | S | yes | As A19 |
| Links via spreadsheet text | have | Predecessors column: `A1010, A1020SS+2` | – | – | |
| Progress Entry Mode (on-chart drag) | have | `startProgressDrag` | – | – | |
| Opening / closing summary and expanded tasks | have | Chevron, Space, outline levels | – | – | Double-click convention differs: see 03-5 row 1 |
| Navigating the bar chart | have | Scroll, Fit, Today, go to activity, zoom | – | – | |
| Views and tabs | partial | Saved views; no tabs | M | no | As B8 |
| Filters and sort/group | have | Filter box, quick filters, group, sort | – | – | |
| Hide / show marked items | missing | As A27 | S | no | |
| Library Explorer | partial | As D1 | M | no | |
| Options dialog | partial | Options sit where they apply (View popover, PDF sheet, theme); no edit-behaviour options | S | no | Settings sheet for the few behaviours that exist |
| Project timeline pane | partial | As A65 | M | no | |
| Multi-user lock colouring | n/a | Enterprise / Vision Live | – | – | |

## 03-3 Typical workflow taught by the tutorial and training

| Feature / step | Status | Where in Planner / what is missing | Effort | Daily use | Build note |
|---|---|---|---|---|---|
| Tutorial sequence | partial | Guided setup wizard, Overview journey spine (Brief → Build → Baseline → Update → Issue) with the next step on each stage, Ask examples; no walk-through | S | no | Help sheet from the journey spine |
| Eleco two-day course content | partial | Covered where the rows above say so; task pools, hammocks, timelines partial | – | no | Informational |
| Introduction Part 1 / Part 2 outlines | partial | Subcharts and buffers missing | – | no | Informational |
| 1. Create a programme from a template | partial | Brief, wizard, import; no template file | S | no | As 03-1 "Save as template" |
| 2. Configure calendars | have | Calendars dialog, per-activity calendars | – | – | |
| 3. Enter bars and tasks | have | Insert, type name and `3d` | – | – | Drawing on the bar is A1 |
| 4. Structure with summary and expanded tasks | partial | Summaries, indent/outdent; no expanded tasks | L | no | As B15 |
| 5. Link the logic | have | Drag, Ctrl+L, Predecessors column, link dialog | – | – | |
| 6. Constraints, milestones, hammocks, buffers | partial | All but buffers, holding pin, must-complete-within | L | no | As 1.44 |
| 7. Reschedule and check the critical path | have | Automatic; trace; float; DCMA; drag | – | – | |
| 8. Code libraries and colour-coding | have | Codes dialog; colour by code | – | – | |
| 9. Resources and costs | partial | Assign, level, histogram, cost band; no modelling, groups or cost centres | M | no | Section 02-4 |
| 10. Task activities | missing | As 1.55 | M | no | |
| 11. Baseline the programme | have | Set baseline; baseline bars | – | – | |
| 12. Report variances | have | BL start, BL finish, Var columns; Behind-baseline filter | – | – | Start variance is 3.16 |
| 13. Set up progress periods | have | Close progress period | – | – | |
| 14. Progress weekly | have | Site update, drag progress, % column, data date, straightened automatically, close period | – | – | |
| 15. Merge live data into the baseline | missing | As 3.7 | S | no | |
| 16. Schedule quality check | have | DCMA with repair | – | – | CIOB set is 6.4 |
| 17. Build reporting views | have | Saved views with filter, group, columns | – | – | |
| 18. Timeline and tabular reports | partial | Milestone lists; CSV | M | no | As A65, C25 |
| 19. Print and issue | have | PDF for issue, revision on export | – | – | Logo is C6 |
| 20. Save, back up, hand over | have | Autosave, undo snapshots, revisions, export all three, shared page | – | – | |
| 21. Reuse: templates and task pools | partial | Library file; no fragnets or template file | M | yes | As D17 |
| Release additions v15 | n/a | Restates rows above | – | – | |
| Release additions v16 | n/a | Restates rows above | – | – | |
| Release additions v17 | n/a | Restates rows above | – | – | |

## 03-4 Collaboration, multi-user and mobile

| Feature | Status | Where in Planner / what is missing | Effort | Daily use | Build note |
|---|---|---|---|---|---|
| Standalone / SaaS single-user model | have | One editor per programme; server store or localStorage | – | – | |
| Asta Enterprise (multi-user server) | n/a | Server product | – | – | |
| Access rights / security groups | partial | Client mode is read-only in the page, not enforced by the server | L | no | Needs accounts; out of scope for a browser tool today |
| Asta Vision | n/a | | – | – | |
| Vision commands inside Powerproject | n/a | | – | – | |
| Asta Vision Live | n/a | | – | – | |
| Check out to an Enterprise server | n/a | | – | – | |
| Asta Siteprogress app | partial | Site mode in the same page | L | no | As 2.30 |
| Siteprogress office cycle | partial | Site update → close period → automatic reschedule; no export jobs or approval | L | no | As 2.30 |
| Siteprogress compatibility, pricing | n/a | | – | – | |
| Sharing with Project Viewer | have (better) | Shared page, Client mode, standalone file | – | – | |
| Powerproject SaaS | have (better) | Browser build with no install | – | – | |
| Cloud concurrent licensing | n/a | | – | – | |
| BI Controller / dashboards | have | REST API and MCP for dashboards | – | – | |
| Collaboration Cloud bundle | n/a | | – | – | |

## 03-5 Conventions a planner expects an Asta-like tool to honour

| Convention | Status | Where in Planner / what is missing | Effort | Daily use | Build note |
|---|---|---|---|---|---|
| 1 Double-click toggles structure, not properties | partial | Double-click opens the inspector; chevron or Space toggles a summary | S | yes: muscle memory on every summary row | Double-click on a summary row toggles collapse; keep inspector on activities; UI only |
| 2 Properties from right-click > Properties | have | Inspect… in the context menu | – | – | |
| 3 Dragging the body moves in time, keeping duration | have | | – | – | |
| 4 Dragging an end changes only that date, popup shows dates | have | Drag note shows the change | – | – | |
| 5 Shrink to zero makes a milestone | partial | Minimum half a day; Toggle milestone button | S | no | Allow drag to zero → milestone |
| 6 Vertical drag to another bar; SHIFT keeps dates; CTRL copies | missing | As A14 | M | yes | |
| 7 ALT-click selects a whole bar | missing | Needs A4 | S | no | |
| 8 Tasks on one bar shunt along | missing | Needs A4 | L | no | With A4 |
| 9 Everything snaps to the snapping unit | partial | As A2 | S | yes | |
| 10 Draw a task by dragging on an empty bar | partial | As A1 | S | yes | |
| 11 Link by dragging from the predecessor edge | have | From the end dots | – | – | |
| 12 Right-click link Properties / Delete; drag end to re-attach | partial | Double-click and Delete; no re-attach by drag | S | no | Drag a selected link's arrowhead to another bar |
| 13 Link Tasks mode / block link | partial | Block link yes; mode no | S | yes | As A19 |
| 14 Predecessor columns accept typed logic | have | `A1010, A1020SS+2` | – | – | |
| 15 Progress recorded against a period with a report date | have | Data date; closed periods | – | – | |
| 16 Progress by drag, % column or dialog; milestones 0/100 | have | | – | – | |
| 17 Progress line jagged until an explicit reschedule | have | Automatic reschedule straightens at once; the line stays jagged through the % points | – | – | Different mechanism, same reading |
| 18 Right-click date zone: Properties, Insert Line, scale zone | missing | As A48 | M | no | |
| 19 Drag a library object onto a task assigns it | missing | As D8 | S | no | |
| 20 Drag a task pool into the chart | missing | As D17 | M | yes | |
| 21 + / − switches bar-per-line and one-task-per-line | missing | Needs A4/A5 | M | yes | |
| 22 Right-click Line column inserts; heading adds/replaces/removes | partial | Insert below; Columns… dialog | S | yes | As 03-2 row 21 |
| 23 Baselines as bars beneath, toggle, current baseline | have | | – | – | |
| 24 ALT+SHIFT display overlays | partial | View popover toggles; no shortcuts | S | no | With A69 |
| 25 Each view a tab remembering its settings; status bar shows filter | partial | Saved views; trace chip; no tabs or filter chip | M | no | As B8 and 03-2 row 15 |

## Top 30 gaps to close

Ranked by daily use first, then effort small-first, then whether Asta's documentation presents the feature as a signature strength. Each line gives the minimum version a planner would accept.

| # | Gap | Rows | Effort | Minimum version |
|---|---|---|---|---|
| 1 | Draw a task on an empty row | A1, 03-2 Drawing tasks, conv 10 | S | Press and drag on empty chart space in a row creates an activity spanning the drag, snapped to working days, with the name cell ready to type. |
| 2 | Snapping unit | A2, conv 9 | S | A View setting (day / week / none) that every drag honours, with week snapping to Monday. |
| 3 | Link Tasks mode | A19, 03-2 Link Tasks, conv 13 | S | A planbar toggle: while on, each inserted or drawn activity is linked FS to the previously selected one. |
| 4 | Insert above | A10 | S | "Insert activity above" in the context menu and Shift+Insert, bridged into the chain like insert-below. |
| 5 | Cut, and paste that keeps outside links | A26 | S | Ctrl+X removes with bridging; paste has a "keep links to activities outside the block" option. |
| 6 | Filter builder with saved filters | B37 | S | A sheet with field / operator / value rows that writes the existing grammar, and named filters reusable in any view. |
| 7 | Group by week or month | B33 | S | Group keys "Start week", "Finish week", "Month" with headers like "W/C 4 May 26", printable, so a weekly look-ahead is one view. |
| 8 | Code columns | B24 | S | Each code type available as a table column with a select editor, in CSV and PDF. |
| 9 | Bar text from any column, left and right | A32 | S | Bar text picks any column for left / on / right of the bar, saved in views and printed. |
| 10 | Display switches | A34, 03-2 Show/Hide | S | Toggles for critical colouring, constraint flags, annotations and grid lines alongside the existing ones, honoured by the PDF. |
| 11 | Hide non-driving links | A36 | S | View › Links: all / driving only / none, with non-driving dimmed in the "all" mode. |
| 12 | Multi-edit panel | A15, 03-2 Object Edit | S | With several rows selected the inspector offers duration ±, calendar, code values and resources applied to all. |
| 13 | Progress the selection as planned | 2.8 | S | Progress dialog option "as planned to the data date" that sets actual dates and % from the planned span for every selected activity. |
| 14 | Start and duration variance columns | 3.16 | S | `BL var start` and `BL var dur` columns beside the existing finish variance, red when late. |
| 15 | Activity deadlines | 1.15 | S | A per-activity deadline date with a marker on the bar, a "past deadline" filter, a briefing watch line and MSPDI `<Deadline>` round trip. |
| 16 | Legend for colour-by | C18 | S | When coloured by code or resource the PDF legend lists each value and its colour. |
| 17 | Column header menu | 03-2 heading, conv 22 | S | Right-click a header: insert column here, hide this column, sort; drag headers to reorder. |
| 18 | Double-click toggles summaries | conv 1 | S | Double-click on a summary row collapses or expands it; activities keep opening the inspector. |
| 19 | Keyboard shortcut sheet | A69 | S | A palette action and `?` key showing every shortcut, generated from one table. |
| 20 | Drag rows vertically | A14, 03-2 vertical drag, conv 6 | M | Drag a row handle to reorder or move into another summary with a drop line; Shift keeps nothing special since dates are logic-driven; Ctrl copies. |
| 21 | Company title block with logo | C6 | M | Logo image and one of two or three block layouts, saved with the project, printed on every page. |
| 22 | Annotations: boxes and arrows | A57 | M | A note can be a callout, a box or an arrow between two dates/rows, dragged into place and printed. |
| 23 | Print preview | C4 | M | The PDF rendered live in the sheet as options change, before download. |
| 24 | Fragnets (task pools) | D17, 1.52, 03-2 task pools, step 21, conv 20 | M | Save a selection as a named fragnet in the library file; insert it at a chosen date and summary with new IDs and its internal links. |
| 25 | Paste from Excel | 03-1 Excel interchange | M | Paste TSV rows into the table: new activities with name, duration, dates and codes by column header, or values into selected cells. |
| 26 | Several tasks on one bar | A4, A5, 1.12, 03-2 bars vs tasks, conv 21 | L | A "line" that holds several activities drawn on one row with implied FS between them, a +/− to expand to one per row, and export as separate activities. |
| 27 | Date range shading | A41, C30 | S | Shaded, labelled date bands (shutdowns, holidays, phases) stored with the project and printed. |
| 28 | Merge live dates into the baseline | 3.7, step 15 | S | "Update baseline for selected / new activities" copies live dates into the active baseline without touching the rest. |
| 29 | CIOB Planning Protocol 2021 check set | 6.4 | S | A second named threshold table selectable in Monitor, scored like DCMA, in both engines with a parity case. |
| 30 | Per-activity risk ranges | 5.2 | M | Optional min/max % and probability per activity (or per code value) used by the Monte Carlo in both engines, with a parity case. |

Not in the top 30 but worth noting as the largest structural gaps: expanded tasks / sub-programmes (B15, 1.50, 3.6: L), buffer tasks (1.44: L), shift-pattern calendars (1.58: L), effort-driven resource modelling and cost centres (4.5, 4.22: M and L), formula columns (B26: L) and link categories (A37: M). Each changes scheduling or cost output and so needs both engines and parity tests.

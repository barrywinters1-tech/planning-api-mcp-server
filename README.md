# AI Planner

Describe a project. The AI drafts the programme like an experienced planner would. The critical-path engine computes every date. A DCMA 14-point check tells the AI what it got wrong and it fixes it. Export to Primavera P6 (XER) or Asta Powerproject / MS Project (XML).

Built to replace the tedious half of P6 and Asta, not to reproduce their UI.

## What it does

| Layer | File | What |
|---|---|---|
| Model | `planner/model.py` | Project, WBS, activities, calendars (working days, hours, exceptions), links FS/SS/FF/SF with lag, constraints, resources, progress |
| Engine | `planner/cpm.py` | Forward and backward pass, per-activity calendars, lag on the predecessor calendar (P6 default), constraints, retained-logic progress against a data date, total and free float, critical or longest path, loop detection |
| Health | `planner/dcma.py` | DCMA 14-point assessment (logic, leads, lags, FS share, hard constraints, high float, negative float, high duration, invalid dates, resources, missed tasks, critical path test, CPLI, BEI) plus open-ends and dangling-logic checks |
| P6 | `planner/xer.py` | XER read and write: PROJECT, CALENDAR (including the `clndr_data` blob), PROJWBS, TASK, TASKPRED, RSRC, TASKRSRC |
| Asta / MS Project | `planner/mspxml.py` | MSPDI XML read and write: outline WBS, calendars, links, constraints, progress, baseline, resources, assignments |
| AI | `planner/ai_planner.py` | Brief to `DraftPlan`, schedule, self-review to `Patch`, natural-language edits to `Patch`. All model output is structured; dates come only from the engine |
| Web | `api.py`, `web/index.html` | Gantt with critical path, float bars, links, data date; activity table; inline editor; health panel; chat to change the plan; import/export |
| MCP | `mcp_server.py` | Tools so Claude Desktop or Claude Code can be the planner without an API key on this server |
| UK planning data | `server.py` | The original planning.data.gov.uk MCP server, unchanged |

## Asta and the `.pp` file

Asta's native `.pp` is a closed binary format with no public specification. Nothing outside Elecosoft reads it. The supported route is the one Asta itself provides: **File > Export > MS Project XML** (or Primavera XER) out of Powerproject, and **File > Import** back in. Both formats are read and written here. P6 reads and writes XER natively.

## Run it

```bash
pip install -r requirements.txt
export ANTHROPIC_API_KEY=...          # only needed for the in-app AI planner
python examples/demo.py --serve       # optional: a 43-activity house programme to play with
uvicorn api:app --port 8080
```

Open http://localhost:8080. Paste a brief, press **Plan it**. Or import an XER / XML you already have.

Model defaults to `claude-opus-5`; override with `PLANNER_MODEL`. Project files live in `data/projects/` (override with `PLANNER_DATA_DIR`).

### Claude as the planner over MCP

```json
{
  "mcpServers": {
    "planner": { "command": "python", "args": ["/path/to/mcp_server.py"] }
  }
}
```

Tools: `planning_guidelines`, `create_project_from_draft`, `add_wbs`, `add_activities`, `add_links`, `apply_patch_ops`, `calculate`, `get_schedule`, `set_status_date`, `import_schedule`, `export_schedule`. The client model drafts the plan, the engine here schedules it, `calculate` returns the failing checks for it to fix.

### Python

```python
from planner import schedule, health_check
from planner.xer import read_xer_file, write_xer_file

p = read_xer_file("tender.xer")
schedule(p)
print(p.finish, [a.id for a in p.activities if a.critical])
print(health_check(p).summary)
write_xer_file(p, "tender-rescheduled.xer")
```

## How the AI plans

1. **Draft.** The brief goes to the model with a senior-planner system prompt and it returns a `DraftPlan`: WBS, activities with working-day durations, trades, predecessors with link types and lags, constraints with reasons, assumptions, questions for the client.
2. **Schedule.** Deterministic code turns that into a `Project` with UK bank-holiday calendars and runs the CPM.
3. **Review.** The scheduled digest and the DCMA failures go back to the model. It returns a `Patch` of small operations (add link, set duration, split activity, soften constraint) with a reason for each. The patch is applied, the schedule recalculated. A patch that introduces a loop is reverted.
4. **Edit.** "Add two weeks to piling", "client wants handover by 1 November", "mark site set-up 50% done as of 20 April" go through the same patch path.

The model never sets a date. It sets durations and logic; the engine sets dates.

## Tests

```bash
pytest -q
```

17 tests: calendar arithmetic, CPM against hand-worked examples, constraints, negative float, progress, loop detection, XER and MSPDI round trips, `clndr_data` parsing, patch operations, and the plan/review orchestration with the model mocked.

## Known limits (v1)

- One shift per working day per calendar. P6 multi-shift calendars are collapsed to hours per day.
- No resource levelling. Resources and assignments are carried through so P6 / Asta can level.
- Progress uses retained logic only (no progress override).
- Baselines are stored per activity and read from files, but not created in the UI yet.
- `must_finish_by` has no MSPDI field, so it does not survive an XML round trip.
- Asta-specific data (subheadings, code libraries, hammocks) is whatever Asta puts in its own XML export.

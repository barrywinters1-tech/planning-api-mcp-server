# Planner, reimagined: overnight report

Test link (same URL, version republished): https://claude.ai/artifact/R2X3i5PNo2QJUL2YA8inKh
Branch: `claude/ai-project-planning-ux-c4sxcq`

## The idea

The engine was already good. What was missing was a product around it. Asta and P6 are tools you operate; this is a programme that works for you. Four things make that true:

1. **It reports its own state.** Open a programme and the first thing you see is a briefing written from the schedule: where it stands, what moved since the last period or revision, what to watch, what's coming in the next two weeks, what to do next.
2. **You can ask it questions.** "When do we finish", "what is driving the finish", "why does the roof start when it does", "what if piling takes two weeks longer". Answered from the engine, deterministically, and every answer can be shown on the chart.
3. **You can try things safely.** Try mode keeps the programme aside, shows the finish delta live as you change things, and lets you keep or discard the lot.
4. **It has a face for each person.** Build for the planner, Site for the phone on site, Client for the read-only briefing, milestones and PDF.

None of this needs Claude. Claude, when the viewer has it, polishes the briefing prose and answers what the engine cannot.

## What was built (evidenced: tested in a headless browser at phone and desktop sizes, and in the Python suite)

| Piece | What it does |
|---|---|
| Overview screen | New first screen per programme. Journey spine (Brief → Build → Baseline → Update → Issue) with the next step on each stage, four KPIs, the briefing, a watch list, the next two weeks, milestones, "do next" actions and an Ask box. Opening a programme, importing a file and building from a brief all land here. |
| Briefing engine | `planner/briefing.py` + `web/briefing.js`, identical output in both (31 cases × 4 time zones). Headline, status, KPIs, "since" (last period, revision or baseline, whichever is latest), watch list (negative float, critical starting soon, out of sequence, behind baseline, drag, near-critical, constraints, stale progress, open ends, long tasks), next two weeks, actions, milestones, and 2–4 paragraphs of prose. Also `GET /api/projects/{id}/briefing` and MCP `programme_briefing`. |
| Ask engine | `planner/ask.py` + `web/ask.js`, identical output in both (121 questions × 4 time zones). 18 intents: start/finish dates, milestones, project finish, critical path, why, what it holds up, float, duration, time windows, status lists, resources and trades, counts, what-if, health, compare, drag, risk, unknown. Tolerates typos and partial names. Also `POST /api/projects/{id}/ask` and MCP `ask_programme`. |
| Ask bar | ⌘K now takes questions as well as commands. Answers appear as you type, with buttons: show on the chart, trace the logic, filter, open, and "Try it" for a what-if. "Ask Claude" appears when the viewer has Claude. The Overview has the same box. |
| Try mode | Toolbar button and Overview button. Bar across the top with the live finish delta and change counts; What changed (full comparison), Discard (restores exactly), Keep (with one-click issue as revision). |
| Modes | Build / Site / Client switcher on the Overview and in the project menu, remembered per device. Client mode hides every editing tool and blocks every change; Site mode leads with the site update. |
| Hover cards | Hover a bar: dates, duration, status, float or Critical, baseline variance, constraint, why it starts when it does, what it holds up. |
| PDF cover page | PDF for issue gains an optional cover page: title, headline, KPI tiles, the briefing prose, milestones and the watch list, numbered as page 1. The briefing headline also sits in the title block. |
| Status note | Share → status note is now the briefing. |

## Tests

- Python suite: 2486 passed, 1 skipped (was 1790 + 4). New: 20 briefing unit + 129 parity, 61 ask unit + 485 parity, 7 PDF cover.
- Browser checks (Playwright, Chromium): the new shell at 1440 px and 390 px; the Ask UI and PDF cover; all six earlier checks (site update, print, trace/filters, drag, custom fields) still pass.
- The PDF was opened and read back: cover page text, page numbering and the Gantt pages are correct.

## Not done, and why

- **Claude features untested live.** The assistant, "Polish with Claude" and "Ask Claude" run on the viewer's own account inside Claude; here they were exercised with a stand-in only. Everything else works without Claude.
- **The account's 5-hour limit hit at ~04:30 UTC** and stopped the three parallel builds until 05:50. They resumed from saved work; nothing was lost, it just finished later.
- **Try mode is per browser tab.** Reloading mid-Try keeps the changes (they are saved as normal) but loses the Discard point. Acceptable for now; a server-side sandbox is the proper fix.
- Still parked from before: AI query limits and top-ups (needs a hosted service), period lines on the PDF, custom fields in MS Project XML, drag-to-record progress, real-time collaboration, multi-project.

## Inference, not evidence

- Planners will read the Overview before the Gantt. That is the bet of the whole redesign and only Graeme using it on a live job will confirm it.
- The question engine understands the way planners actually phrase things. It handles 121 test phrasings; real ones will find gaps, and each gap is a small rule to add.

## What to look at first

1. Open the sample house. Read the briefing. Press ⌘K and type "why does the roof start when it does".
2. Click Try changes, drag a bar, watch the finish delta, then Discard.
3. Switch to Client, then Site, on your phone.
4. Share → PDF for issue, with the cover page on.

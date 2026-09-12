/* In-browser backend: same JSON shapes as api.py, backed by localStorage + PlannerEngine. */
'use strict';
(function () {
const E = window.PlannerEngine;
const LSK = 'planner:projects';
const undoStacks = {}, redoStacks = {}, LIMIT = 60;
function loadAll() { try { return JSON.parse(localStorage.getItem(LSK) || '{}'); } catch { return {}; } }
function saveAll(o) { try { localStorage.setItem(LSK, JSON.stringify(o)); } catch (e) { } }
function load(pid) { const a = loadAll(); if (!(pid in a)) throw { status: 404, detail: 'no such project' }; return a[pid]; }
function store(p) { const a = loadAll(); a[p.id] = p; saveAll(a); }
function del(pid) { const a = loadAll(); const had = pid in a; delete a[pid]; saveAll(a); delete undoStacks[pid]; delete redoStacks[pid]; return had; }
function snapshot(pid) { const a = loadAll(); if (!(pid in a)) return; (undoStacks[pid] = undoStacks[pid] || []).push(JSON.stringify(a[pid])); if (undoStacks[pid].length > LIMIT) undoStacks[pid].shift(); redoStacks[pid] = []; }
function depth(pid) { return { undo: (undoStacks[pid] || []).length, redo: (redoStacks[pid] || []).length }; }
function unique(pid) { const a = loadAll(); if (!(pid in a)) return pid; return pid + '-' + Math.random().toString(36).slice(2, 6); }

function view(p, report, extra) {
  if (!report) { try { p.levelled ? E.level(p) : E.schedule(p); report = E.healthCheck(p); } catch (e) { report = null; extra = Object.assign({}, extra, { schedule_error: e.message }); } }
  const out = { project: p, report: report ? { score: report.score, checks: report.checks, summary: report.summary } : null, history: depth(p.id) };
  return Object.assign(out, extra || {});
}
function runPatch(p, patch) {
  const log = []; const real = [];
  for (const op of patch.ops) {
    if (op.op === 'note' && op.reason && op.reason.indexOf('__data_date__') === 0) { p.data_date = op.reason.slice('__data_date__'.length) + 'T08:00:00'; log.push('data date -> ' + p.data_date.slice(0, 10)); }
    else if (op.op === 'note' && op.reason && op.reason.indexOf('__assign__') === 0) { const parts = op.reason.split('__'); const aid = parts[2], trade = parts.slice(3).join('__'); const rid = trade.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '').toUpperCase().slice(0, 20); if (!p.resources.some(r => r.id === rid)) p.resources.push({ id: rid, name: trade, type: 'labour', unit: 'h', rate: 0, max_units_per_day: null, colour: null }); p.assignments = p.assignments.filter(x => x.activity_id !== aid); const a = p.activities.find(x => x.id === aid); p.assignments.push({ activity_id: aid, resource_id: rid, units: a ? a.duration_hours : 0, cost: 0, actual_cost: 0 }); log.push(aid + ' assigned ' + trade); }
    else if (op.op === 'note' && op.reason === '__repair__') { try { E.schedule(p); const rep = E.healthCheck(p); const rp = E.planRepairs(p, rep); log.push(...E.applyPatch(p, rp)); patch.message = rp.message; patch.still_open = rp.still_open; } catch (e) { log.push('cannot repair: ' + e.message); } }
    else real.push(op);
  }
  if (real.length) log.push(...E.applyPatch(p, { ops: real, message: '' }));
  return log;
}

async function route(method, path, body) {
  const seg = path.replace(/^\/api\/?/, '').split('/');
  method = (method || 'GET').toUpperCase();
  if (path === '/api/projects' && method === 'GET') { const a = loadAll(); return Object.values(a).map(p => ({ id: p.id, name: p.name, start: p.start, finish: p.finish, activities: p.activities.length, scheduled_at: p.scheduled_at })); }
  if (path === '/api/projects' && method === 'POST') { const start = body.start + 'T08:00:00'; let p = { id: unique((body.project_id || (body.name || 'PROJ').replace(/[^A-Za-z0-9]+/g, '-').slice(0, 12)).toUpperCase() || 'PROJ'), name: body.name || 'New project', start, data_date: start, must_finish_by: null, default_calendar_id: 'standard', calendars: {}, wbs: [{ id: '1', code: '1', name: 'Works', parent_id: null, seq: 0 }], activities: [{ id: 'A1000', name: 'Start', wbs_id: '1', calendar_id: null, type: 'start_milestone', duration_hours: 0, constraint: 'none', constraint_date: null, status: 'not_started', actual_start: null, actual_finish: null, remaining_hours: null, percent_complete: 0, baseline_start: null, baseline_finish: null, notes: '', codes: {}, priority: 500, level_delay_hours: 0, critical: false }, { id: 'A1010', name: 'New activity', wbs_id: '1', calendar_id: null, type: 'task', duration_hours: 40, constraint: 'none', constraint_date: null, status: 'not_started', actual_start: null, actual_finish: null, remaining_hours: null, percent_complete: 0, baseline_start: null, baseline_finish: null, notes: '', codes: {}, priority: 500, level_delay_hours: 0, critical: false }, { id: 'A1020', name: 'Finish', wbs_id: '1', calendar_id: null, type: 'finish_milestone', duration_hours: 0, constraint: 'none', constraint_date: null, status: 'not_started', actual_start: null, actual_finish: null, remaining_hours: null, percent_complete: 0, baseline_start: null, baseline_finish: null, notes: '', codes: {}, priority: 500, level_delay_hours: 0, critical: false }], relationships: [{ predecessor_id: 'A1000', successor_id: 'A1010', type: 'FS', lag_hours: 0 }, { predecessor_id: 'A1010', successor_id: 'A1020', type: 'FS', lag_hours: 0 }], resources: [], assignments: [], description: '', assumptions: [], code_types: {}, baselines: [], levelled: false, finish: null, scheduled_at: null }; E.ensureCalendars(p); const v = view(p); store(p); return v; }
  if (path === '/api/brief/parse' && method === 'POST') return E.parseBrief(body.text || '');
  if (path === '/api/generate' && method === 'POST') { const brief = body.brief || E.parseBrief(body.text || ''); if (body.brief && body.text) brief.source_text = body.text; const draft = E.generate(brief); const p = E.draftToProject(draft, brief.source_text || ''); p.id = unique(p.id); E.schedule(p); const rep = E.healthCheck(p); store(p); return Object.assign(view(p, rep), { brief, draft: { summary: draft.summary, assumptions: draft.assumptions, questions_for_client: draft.questions_for_client } }); }
  const pid = decodeURIComponent(seg[1] || ''); const sub = seg[2] || '';
  if (seg[0] === 'projects' && pid) {
    let p;
    if (method === 'GET' && !sub) return view(load(pid));
    if (method === 'PUT' && !sub) { p = body.project; p.id = pid; snapshot(pid); const v = view(p); store(p); return v; }
    if (method === 'DELETE' && !sub) return { deleted: del(pid) };
    if (sub === 'schedule') { p = load(pid); const v = view(p); store(p); return v; }
    if (sub === 'patch') { p = load(pid); snapshot(pid); const log = E.applyPatch(p, body.patch); const v = view(p, null, { log }); store(p); return v; }
    if (sub === 'command') { p = load(pid); let patch; try { patch = E.parseCommand(p, body.text); } catch (e) { throw { status: 422, detail: e.message }; } if (!patch.ops.length) return { message: patch.message, log: [], project: null }; snapshot(pid); const log = runPatch(p, patch); const v = view(p, null, { log, message: patch.message, still_open: patch.still_open }); store(p); return v; }
    if (sub === 'repair') { p = load(pid); E.schedule(p); const rep = E.healthCheck(p); const patch = E.planRepairs(p, rep); snapshot(pid); const log = E.applyPatch(p, patch); const v = view(p, null, { log, message: patch.message, still_open: patch.still_open }); store(p); return v; }
    if (sub === 'undo') { const st = undoStacks[pid] || []; if (!st.length) throw { status: 409, detail: 'nothing to undo' }; (redoStacks[pid] = redoStacks[pid] || []).push(JSON.stringify(load(pid))); p = JSON.parse(st.pop()); store(p); return view(p); }
    if (sub === 'redo') { const st = redoStacks[pid] || []; if (!st.length) throw { status: 409, detail: 'nothing to redo' }; (undoStacks[pid] = undoStacks[pid] || []).push(JSON.stringify(load(pid))); p = JSON.parse(st.pop()); store(p); return view(p); }
    if (sub === 'level') { p = load(pid); snapshot(pid); E.level(p); const rep = E.healthCheck(p); const moved = p.activities.filter(a => a.level_delay_hours > 0).length; const v = view(p, rep, { message: `Levelled: ${moved} activities delayed to stay within resource limits.` }); store(p); return v; }
    if (sub === 'unlevel') { p = load(pid); snapshot(pid); E.unlevel(p); const v = view(p); store(p); return v; }
    if (sub === 'baseline' && method === 'POST') { p = load(pid); snapshot(pid); E.setBaseline(p, body.name || 'Baseline'); const v = view(p); store(p); return v; }
    if (sub === 'baseline' && method === 'DELETE') { p = load(pid); snapshot(pid); E.clearBaseline(p); const v = view(p); store(p); return v; }
    if (seg[2] === 'baseline' && seg[3] === 'use') { p = load(pid); if (!E.useBaseline(p, body.name)) throw { status: 404, detail: 'no such baseline' }; snapshot(pid); const v = view(p); store(p); return v; }
    if (sub === 'histogram') { p = load(pid); p.levelled ? E.level(p) : E.schedule(p); return E.histogram(p); }
    if (sub === 'costs') { p = load(pid); p.levelled ? E.level(p) : E.schedule(p); return E.costCurve(p); }
    if (sub === 'variance') { p = load(pid); p.levelled ? E.level(p) : E.schedule(p); return E.variance(p); }
  }
  throw { status: 404, detail: 'not found: ' + method + ' ' + path };
}

async function importFile(file) {
  const name = (file.name || '').toLowerCase();
  const text = await file.text();
  if (name.endsWith('.json') || text.trimStart().startsWith('{')) {
    const p = JSON.parse(text); p.id = unique(p.id || 'IMPORT'); E.ensureCalendars(p); const v = view(p); store(p); return v;
  }
  throw { status: 501, detail: 'This preview imports its own JSON export. For Primavera XER, P6 XML, MS Project XML and Asta .pp import, use the full local app.' };
}
async function download(pid, fmt) {
  const p = load(pid); const parts = E.writeAny(p, fmt); const content = parts[0], mime = parts[1], filename = parts[2];
  let dl = null; try { if (window.claude && window.claude.use) dl = await window.claude.use('downloads'); } catch (e) { dl = null; }
  if (dl) { let fn = filename; if (fmt === 'xer') fn = p.id + '.xer.txt'; else if (fmt === 'xml' || fmt === 'mspdi' || fmt === 'msproject') fn = p.id + '.xml.txt'; try { await dl.save({ filename: fn, data: content }); return; } catch (e) { if (e && e.code === 'declined') return; throw { detail: 'Download unavailable here (' + ((e && e.code) || 'error') + '). JSON export works; for .xer/.xml use the full local app.' }; } }
  const blob = new Blob([content], { type: mime }); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = filename; document.body.appendChild(a); a.click(); setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 100);
}

window.__local = { route, importFile, download, load, store };
})();

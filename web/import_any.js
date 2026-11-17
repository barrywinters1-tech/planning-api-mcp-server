/* File import for the browser build: the JS twin of planner/io.py read_any.
   Detects the format from the name and the first bytes, decodes the way Python does
   (XER: UTF-8, falling back to Windows-1252 as P6 writes it), and hands the text to the
   ported readers (import_xer.js, import_xml.js). Binary formats a browser cannot read
   (.pp, .mpp ...) get a message saying how to export a readable file instead. */
'use strict';
(function (global) {
const E = global.PlannerEngine;

const BINARY = {
  '.pp': 'Asta Powerproject .pp files are a binary format a browser cannot read. In Powerproject use File > Export and choose MS Project XML (or Primavera P6 XER), then import that file here.',
  '.mpp': 'MS Project .mpp files are binary. In MS Project use File > Save As and choose XML Format (*.xml), then import that file here.',
  '.mpt': 'MS Project templates are binary. Open it in MS Project, Save As XML Format (*.xml), then import that file here.',
  '.mpx': 'MPX is not supported here. Save it from MS Project as XML Format (*.xml), then import that file here.',
  '.p3': 'P3 files need conversion. Open the project in P6 and export XER, then import that file here.',
  '.stx': 'SureTrak files need conversion. Open the project in P6 and export XER, then import that file here.',
  '.pod': 'ProjectLibre .pod files are not supported. Save as MS Project XML, then import that file here.',
  '.gan': 'GanttProject files are not supported. Export to MS Project XML, then import that file here.',
  '.planner': 'Gnome Planner files are not supported. Export to MS Project XML, then import that file here.',
};
const ACCEPTS = 'Accepts Primavera P6 XER, P6 XML, MS Project XML (which Asta Powerproject also exports) and this app\'s own .json.';

function startsWithBytes(b, s) { if (b.length < s.length) return false; for (let i = 0; i < s.length; i++) if (b[i] !== s.charCodeAt(i)) return false; return true; }
function head(bytes) {
  let i = 0;
  if (bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) i = 3;           // UTF-8 byte-order mark
  while (i < bytes.length && i < 200 && (bytes[i] === 0x20 || bytes[i] === 0x09 || bytes[i] === 0x0A || bytes[i] === 0x0D)) i++;
  return bytes.subarray(i, i + 200);
}
function utf8(bytes, fatal) { return new TextDecoder('utf-8', { fatal: !!fatal }).decode(bytes); }
function decodeXer(bytes) {
  if (E.decodeXerBytes) return E.decodeXerBytes(bytes);
  try { return utf8(bytes, true); } catch (e) { return new TextDecoder('windows-1252').decode(bytes); }
}
const stripBom = s => s.charCodeAt(0) === 0xFEFF ? s.slice(1) : s;

// readAny(filename, Uint8Array) -> project object (unscheduled), or throws Error with a user-facing message
function readAny(filename, bytes) {
  const name = String(filename || '').toLowerCase();
  const m = name.match(/\.[^./\\]+$/); const ext = m ? m[0] : '';
  const h = head(bytes);
  if (ext === '.xer' || startsWithBytes(h, 'ERMHDR')) {
    if (!E.readXer) throw new Error('Primavera XER import is not available in this build.');
    return E.readXer(stripBom(decodeXer(bytes)));
  }
  if (['.xml', '.mspdi', '.pmxml'].includes(ext) || startsWithBytes(h, '<?xml') || startsWithBytes(h, '<Project')) {
    if (!E.readMspdi || !E.xmlRootTag) throw new Error('XML import is not in this preview yet. Export Primavera P6 XER instead (in Asta: File > Export > Primavera P6 XER) and import that.');
    const text = stripBom(utf8(bytes, false));
    const root = E.xmlRootTag(bytes);
    if (root === 'Project') return E.readMspdi(text);
    if (root === 'APIBusinessObjects') return E.readPmxml(text);
    throw new Error(`Unrecognised XML root <${root}>. Expected MS Project XML (<Project>) or P6 XML (<APIBusinessObjects>).`);
  }
  if (ext === '.json' || startsWithBytes(h, '{')) {
    let p; try { p = JSON.parse(stripBom(utf8(bytes, false))); } catch (e) { throw new Error('This .json file is not valid JSON: ' + e.message); }
    if (!p || !Array.isArray(p.activities)) throw new Error('This .json file is not a programme exported from this app.');
    return p;
  }
  if (BINARY[ext]) throw new Error(BINARY[ext]);
  if (startsWithBytes(h, 'PK')) throw new Error('This looks like a zip archive. Unzip it and import the .xer or .xml file inside.');
  throw new Error('Unrecognised file. ' + ACCEPTS);
}

// ---------- what the other tool will receive ----------
// Write the file, read it back with our own readers (which mirror what P6 / MS Project / Asta accept),
// re-schedule, and list what survived, what changed and what was dropped. Honest by construction:
// anything the round trip loses is reported, not assumed.
function fidelityReport(project, fmt) {
  const p = JSON.parse(JSON.stringify(project)); E.schedule(p);
  const content = E.writeAny(p, fmt)[0];
  const q = fmt === 'xer' ? E.readXer(content) : E.readMspdi(content);
  try { E.schedule(q); } catch (e) { /* reported below through the finish line */ }
  const tool = fmt === 'xer' ? 'Primavera P6 (and Asta via XER import)' : 'MS Project (and Asta via XML import)';
  const items = [];
  const add = (ok, text, detail) => items.push({ ok, text, detail: detail || '' });
  const byName = new Map(q.activities.map(a => [a.name, a])), byId = new Map(q.activities.map(a => [a.id, a]));
  const twin = a => byId.get(a.id) || byName.get(a.name);
  const missing = p.activities.filter(a => !twin(a));
  add(!missing.length && q.activities.length === p.activities.length, `${q.activities.length} of ${p.activities.length} activities`, missing.slice(0, 5).map(a => a.id + ' ' + a.name).join('; '));
  const [kept, dropped] = E.exportRelationships(p);
  add(!dropped.length, `${q.relationships.length} of ${p.relationships.length} links`, dropped.length ? `${tool.split(' (')[0]} allows one link between two activities, so ${dropped.length} extra link${dropped.length > 1 ? 's' : ''} of a pair ${dropped.length > 1 ? 'were' : 'was'} left out (the driving one is kept): ` + dropped.slice(0, 6).map(r => `${r.predecessor_id}→${r.successor_id} ${r.type}`).join(', ') : '');
  const lagLost = kept.filter(r => { const t = q.relationships.find(x => (twin(p.activities.find(a => a.id === r.predecessor_id)) || {}).id === x.predecessor_id && (twin(p.activities.find(a => a.id === r.successor_id)) || {}).id === x.successor_id); return t && (t.type !== r.type || Math.abs(t.lag_hours - r.lag_hours) > 0.01); });
  if (lagLost.length) add(false, `${lagLost.length} links changed type or lag`, lagLost.slice(0, 6).map(r => `${r.predecessor_id}→${r.successor_id}`).join(', '));
  const cons = a => a.constraint && a.constraint !== 'none' ? a.constraint + '@' + String(a.constraint_date || '').slice(0, 10) : '';
  const conLost = p.activities.filter(a => cons(a) && twin(a) && cons(twin(a)) !== cons(a));
  if (p.activities.some(a => cons(a))) add(!conLost.length, `${p.activities.filter(a => cons(a)).length - conLost.length} of ${p.activities.filter(a => cons(a)).length} constraints`, conLost.slice(0, 6).map(a => `${a.id} ${a.constraint.replaceAll('_', ' ')}`).join('; '));
  const loe = p.activities.filter(a => a.type === 'level_of_effort'), loeLost = loe.filter(a => twin(a) && twin(a).type !== 'level_of_effort');
  if (loe.length) add(!loeLost.length, `${loe.length - loeLost.length} of ${loe.length} hammocks (level of effort)`, loeLost.length ? 'These become ordinary tasks in the other tool: ' + loeLost.slice(0, 6).map(a => a.id).join(', ') : '');
  const prog = p.activities.filter(a => a.status !== 'not_started'), progLost = prog.filter(a => twin(a) && (twin(a).status !== a.status || String(twin(a).actual_start || '').slice(0, 10) !== String(a.actual_start || '').slice(0, 10)));
  if (prog.length) add(!progLost.length, `${prog.length - progLost.length} of ${prog.length} progressed activities`, progLost.slice(0, 6).map(a => a.id).join(', '));
  const nCal = Object.keys(p.calendars).length, nCalQ = Object.keys(q.calendars).length;
  const exc = c => Object.keys(c.exceptions || {}).length, excP = Object.values(p.calendars).reduce((t, c) => t + exc(c), 0), excQ = Object.values(q.calendars).reduce((t, c) => t + exc(c), 0);
  add(nCalQ >= nCal && excQ >= excP, `${nCalQ} of ${nCal} calendars, ${excQ} of ${excP} holidays and exceptions`);
  const bl = p.activities.filter(a => a.baseline_finish), blQ = q.activities.filter(a => a.baseline_finish);
  if (bl.length) add(blQ.length >= bl.length, `${blQ.length} of ${bl.length} baseline dates`, blQ.length < bl.length ? (fmt === 'xer' ? 'XER carries the current schedule only; send the baseline as its own XER, or use MS Project XML.' : 'Some baseline dates were not carried.') : '');
  const nRes = (p.resources || []).length; if (nRes) add((q.resources || []).length >= nRes, `${(q.resources || []).length} of ${nRes} resources, ${(q.assignments || []).length} of ${(p.assignments || []).length} assignments`);
  const codeVals = x => x.activities.reduce((t, a) => t + Object.keys(a.codes || {}).length, 0);
  if (codeVals(p)) add(codeVals(q) >= codeVals(p), `${codeVals(q)} of ${codeVals(p)} activity code values`, codeVals(q) < codeVals(p) ? (fmt === 'xml' ? 'MS Project XML has no activity codes; they are left out.' : '') : '');
  const notes = p.activities.filter(a => a.notes).length; if (notes) add(q.activities.filter(a => a.notes).length >= notes, `${q.activities.filter(a => a.notes).length} of ${notes} activity notes`);
  if ((p.annotations || []).length) add(false, `${p.annotations.length} chart note${p.annotations.length > 1 ? 's' : ''} not carried`, 'Notes on the chart print on the PDF but have no place in this format.');
  if (p.must_finish_by) add(!!q.must_finish_by, q.must_finish_by ? 'Deadline (must finish by) carried' : 'Deadline (must finish by) not carried', q.must_finish_by ? '' : 'This format has no field for it. Add it as a constraint on the completion milestone if the other tool must see it.');
  const days = (a, b) => a && b ? Math.round((new Date(b) - new Date(a)) / 864e5) : null, fd = days(p.finish, q.finish);
  add(fd === 0, fd === 0 ? `Finish ${String(p.finish).slice(0, 10)} matches after recalculation` : fd == null ? 'Finish could not be recalculated from the file' : `Finish recalculates ${fd > 0 ? fd + ' days later' : -fd + ' days earlier'} (${String(q.finish).slice(0, 10)})`, fd ? 'Usually calendar or constraint conversion; check the items above.' : '');
  return { format: fmt, tool, items, ok: items.every(i => i.ok) };
}

Object.assign(E, { readAny, IMPORT_ACCEPTS: ACCEPTS, fidelityReport });
})(typeof window !== 'undefined' ? window : globalThis);

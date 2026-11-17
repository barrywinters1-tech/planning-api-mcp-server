/* Parity runner: drives web/engine.js over the cases the Python test sends on stdin
   and prints the raw results as JSON. tests/test_parity.py runs the identical pipeline
   in Python and diffs the two, under several timezones (set TZ before launching node). */
'use strict';
const fs = require('fs');
const path = require('path');
require(path.join(__dirname, '..', '..', 'web', 'engine.js'));
const E = globalThis.PlannerEngine;

const health = h => { const o = Object.assign({}, h); delete o.failing; return o; };

function run(c) {
  try {
    switch (c.kind) {
      case 'schedule': { const p = c.project; E.schedule(p); return { project: p, health: health(E.healthCheck(p)) }; }
      case 'generate': {
        const b = E.parseBrief(c.brief); const d = E.generate(b);
        const p = E.draftToProject(d, b.source_text); E.schedule(p);
        return { brief: b, draft: d, project: p, health: health(E.healthCheck(p)) };
      }
      case 'level': { const p = c.project; E.level(p); return { project: p }; }
      case 'repair': {
        const p = c.project; E.schedule(p); const patch = E.planRepairs(p, E.healthCheck(p));
        const log = E.applyPatch(p, patch); E.schedule(p);
        return { patch, log, project: p, health: health(E.healthCheck(p)) };
      }
      case 'command': {
        const p = c.project; const patch = E.parseCommand(p, c.command);
        const log = E.applyPatch(p, patch); E.schedule(p);
        return { patch, log, project: p };
      }
      case 'analysis': {
        const p = c.project; E.schedule(p); E.setBaseline(p, 'Tender');
        for (const cmd of c.commands) E.applyPatch(p, E.parseCommand(p, cmd));
        E.schedule(p);
        return { histogram: E.histogram(p), cost: E.costCurve(p), variance: E.variance(p) };
      }
      case 'risk': return E.riskAnalysis(c.project, c.opts);
      case 'guard': return { out_of_sequence: E.outOfSequence((E.schedule(c.project), c.project)), drag: E.criticalDrag(c.project) };
      case 'parse_date': return { values: c.values.map(([s, h]) => E.parseDate(s, h)) };
      case 'round': return { values: c.values.map(([x, n]) => E.pyRound(x, n)) };
      case 'numfmt': return { values: c.values.map(x => [E.pyFixed(x, 0), E.pyFixed(x, 1), E.pyFixed(x, 4), E.pyG(x), E.pyG(x, true), E.pyStr(x), E.pyGroup(x), E.pyFloorDiv(x, 44)]) };
      default: return { error: 'unknown kind ' + c.kind };
    }
  } catch (e) { return { error: String((e && e.message) || e) }; }
}

const input = JSON.parse(fs.readFileSync(0, 'utf8'));
process.stdout.write(JSON.stringify(input.cases.map(run)));

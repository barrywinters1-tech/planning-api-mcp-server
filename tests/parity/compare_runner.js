/* Parity runner for programme comparison: drives web/engine.js + web/compare.js over the
   cases tests/test_compare_parity.py sends on stdin and prints the raw results as JSON.
   Each case edits an independent copy of the old project with the command language (and a
   few raw patch / calendar steps), schedules it, then compares old with new. */
'use strict';
const fs = require('fs');
const path = require('path');
require(path.join(__dirname, '..', '..', 'web', 'engine.js'));
require(path.join(__dirname, '..', '..', 'web', 'compare.js'));
const E = globalThis.PlannerEngine;

const clone = x => JSON.parse(JSON.stringify(x));

function step(p, s) {
  if (typeof s === 'string') {
    const patch = E.parseCommand(p, s);
    const real = [];
    for (const op of patch.ops) {
      if (op.op === 'note' && op.reason && op.reason.indexOf('__data_date__') === 0) p.data_date = op.reason.slice('__data_date__'.length) + 'T08:00:00';
      else real.push(op);
    }
    E.applyPatch(p, { ops: real, message: '' });
  } else if (s.patch) {
    E.applyPatch(p, { ops: s.patch, message: '' });
  } else if (s.cal_exception) {
    const [cid, d, hours] = s.cal_exception;
    p.calendars[cid].exceptions[d] = hours;
  }
}

function run(c) {
  try {
    const oldP = clone(c.old), newP = clone(c.old);
    for (const s of c.steps) step(newP, s);
    E.schedule(newP);
    if (c.schedule_old) E.schedule(oldP);
    const before = JSON.stringify([oldP, newP]);
    const result = E.compareProjects(oldP, newP);
    const text = E.compareNarrative(result);
    return { result, narrative: text, mutated: JSON.stringify([oldP, newP]) !== before };
  } catch (e) { return { error: String((e && e.message) || e) }; }
}

const input = JSON.parse(fs.readFileSync(0, 'utf8'));
process.stdout.write(JSON.stringify(input.cases.map(run)));

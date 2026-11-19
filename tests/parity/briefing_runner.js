/* Parity runner for the briefing: drives web/engine.js + web/compare.js + web/briefing.js over the
   cases tests/test_briefing_parity.py sends on stdin and prints the raw results as JSON. Each case is a
   project (already built in Python) and an optional "today"; the briefing must not mutate the project. */
'use strict';
const fs = require('fs');
const path = require('path');
require(path.join(__dirname, '..', '..', 'web', 'engine.js'));
require(path.join(__dirname, '..', '..', 'web', 'compare.js'));
require(path.join(__dirname, '..', '..', 'web', 'briefing.js'));
const E = globalThis.PlannerEngine;

function run(c) {
  try {
    const p = JSON.parse(JSON.stringify(c.project));
    const before = JSON.stringify(p);
    const result = E.briefing(p, { today: c.today || null });
    return { result, mutated: JSON.stringify(p) !== before };
  } catch (e) { return { error: String((e && e.message) || e), stack: String(e && e.stack) }; }
}

const input = JSON.parse(fs.readFileSync(0, 'utf8'));
process.stdout.write(JSON.stringify(input.cases.map(run)));

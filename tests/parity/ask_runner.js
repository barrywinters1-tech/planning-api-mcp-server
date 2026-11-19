/* Parity runner for the question engine: drives web/engine.js + web/compare.js + web/ask.js over the
   (project, question, today) cases tests/test_ask_parity.py sends on stdin and prints the results as JSON.
   Each case also reports whether ask() mutated the project it was given. */
'use strict';
const fs = require('fs');
const path = require('path');
require(path.join(__dirname, '..', '..', 'web', 'engine.js'));
require(path.join(__dirname, '..', '..', 'web', 'compare.js'));
require(path.join(__dirname, '..', '..', 'web', 'ask.js'));
const E = globalThis.PlannerEngine;

function run(c) {
  try {
    const p = JSON.parse(JSON.stringify(c.project));
    const before = JSON.stringify(p);
    const result = E.ask(p, c.question, { today: c.today || null });
    return { result, mutated: JSON.stringify(p) !== before };
  } catch (e) { return { error: String((e && e.message) || e) }; }
}

const input = JSON.parse(fs.readFileSync(0, 'utf8'));
process.stdout.write(JSON.stringify(input.cases.map(run)));

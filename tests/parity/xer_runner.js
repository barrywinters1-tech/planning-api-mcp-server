/* XER import parity runner: decodes and reads each case's bytes with web/import_xer.js, then
   schedules the result with web/engine.js, and prints the raw results as JSON.
   tests/test_import_parity_xer.py runs the same pipeline in Python and diffs the two,
   under several timezones (set TZ before launching node). */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
require(path.join(__dirname, '..', '..', 'web', 'engine.js'));
require(path.join(__dirname, '..', '..', 'web', 'import_xer.js'));
const E = globalThis.PlannerEngine;

const msg = e => String((e && e.message) || e);

function run(c) {
  const text = E.decodeXerBytes(new Uint8Array(Buffer.from(c.data, 'base64')));
  const out = { text_sha256: crypto.createHash('sha256').update(text, 'utf8').digest('hex') };
  let p;
  try { p = c.index == null ? E.readXer(text) : E.readXer(text, c.index); } catch (e) { out.error = msg(e); return out; }
  out.read = JSON.parse(JSON.stringify(p));
  try { E.schedule(p); out.project = p; } catch (e) { out.schedule_error = msg(e); }
  return out;
}

const input = JSON.parse(fs.readFileSync(0, 'utf8'));
process.stdout.write(JSON.stringify(input.cases.map(run)));

/* Parity runner for the XML readers: drives web/import_xml.js (on top of web/engine.js) over
   the cases tests/test_import_parity_xml.py sends on stdin and prints the raw results as JSON.
   The Python test runs planner/pmxml.py, planner/mspxml.py and io._xml_root_tag on the same
   cases and diffs the two, under several timezones (set TZ before launching node). */
'use strict';
const fs = require('fs');
const path = require('path');
require(path.join(__dirname, '..', '..', 'web', 'engine.js'));
require(path.join(__dirname, '..', '..', 'web', 'import_xml.js'));
const E = globalThis.PlannerEngine;

// io.read_any's XML branch: sniff the root tag from the bytes, then hand the text to a reader
function readXml(text) {
  const root = E.xmlRootTag(new TextEncoder().encode(text));
  if (root === 'Project') return E.readMspdi(text);
  if (root === 'APIBusinessObjects') return E.readPmxml(text);
  throw new Error(`Unrecognised XML root <${root}>. Expected MS Project XML (<Project>) or P6 XML (<APIBusinessObjects>).`);
}

function run(c) {
  try {
    switch (c.kind) {
      case 'write': { const p = c.project; E.schedule(p); return { text: E.writeMspdi(p) }; }
      case 'root': return { root: E.xmlRootTag(new Uint8Array(Buffer.from(c.b64, 'base64'))) };
      case 'parse': return { tree: E.parseXml(c.text) };
      case 'pmxml': case 'mspdi': case 'xml': {
        const p = c.kind === 'pmxml' ? E.readPmxml(c.text, c.index || 0) : c.kind === 'mspdi' ? E.readMspdi(c.text) : readXml(c.text);
        const read = JSON.parse(JSON.stringify(p));
        try { E.schedule(p); } catch (e) { return { read, error: String((e && e.message) || e) }; }
        return { read, project: p };
      }
      default: return { error: 'unknown kind ' + c.kind };
    }
  } catch (e) { return { error: String((e && e.message) || e) }; }
}

const input = JSON.parse(fs.readFileSync(0, 'utf8'));
process.stdout.write(JSON.stringify(input.cases.map(run)));

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
    if (!E.readMspdi || !E.xmlRootTag) throw new Error('XML import is not available in this build.');
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

Object.assign(E, { readAny, IMPORT_ACCEPTS: ACCEPTS });
})(typeof window !== 'undefined' ? window : globalThis);

#!/usr/bin/env node
// Checks every method the controller script calls on a Bitwig object against
// the Controller API reference that ships with Bitwig Studio: the name must
// exist there, and not only as a deprecated method.
//
//   npm run check:api
//   BITWIG_API_DOCS=/path/to/control-surface/api npm run check:api
//
// The check works on names, not types: it reports a name that no API class
// has, so a guessed or misspelled method is caught. It cannot tell which class
// a call goes to.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const DEFAULT_DOCS = "/Applications/Bitwig Studio.app/Contents/Resources/Documentation/control-surface/api";
const docs = process.env.BITWIG_API_DOCS || DEFAULT_DOCS;
const controllerPath = process.env.BITWIG_CONTROLLER || new URL("../controller/BitwigAgentBridge.control.js", import.meta.url);

// Method names that are plain JavaScript or Java, not Bitwig API.
const LANGUAGE_METHODS = new Set([
  "push", "pop", "shift", "unshift", "splice", "slice", "concat", "join", "indexOf", "lastIndexOf", "map", "filter", "forEach",
  "some", "every", "reduce", "sort", "reverse", "keys", "hasOwnProperty", "charAt", "charCodeAt", "trim", "toLowerCase",
  "toUpperCase", "replace", "split", "substring", "substr", "match", "test", "exec", "toFixed", "toString", "apply", "call",
  "stringify", "parse", "floor", "ceil", "round", "abs", "min", "max", "pow", "log", "sqrt", "isArray", "fromCharCode", "now",
  "normalize", "localeCompare", "padStart", "fromString", "getBytes", "length"
]);

function walk(directory) {
  return readdirSync(directory).flatMap(entry => {
    const path = join(directory, entry);
    return statSync(path).isDirectory() ? walk(path) : path.endsWith(".html") ? [path] : [];
  });
}

let files;
try {
  files = walk(docs);
} catch {
  console.error(`No Controller API reference at ${docs}. Install Bitwig Studio or set BITWIG_API_DOCS.`);
  process.exit(2);
}

// method name -> { current, deprecated } counts across all classes
const api = new Map();
for (const file of files) {
  const html = readFileSync(file, "utf8");
  for (const match of html.matchAll(/<section class="detail" id="([A-Za-z_$][\w$]*)\(([^"]*)\)">([\s\S]*?)<\/section>/g)) {
    const entry = api.get(match[1]) || { current: 0, deprecated: 0 };
    if (/class="deprecation-block"/.test(match[3])) entry.deprecated += 1;
    else entry.current += 1;
    api.set(match[1], entry);
  }
}
if (!api.size) {
  console.error(`Found no method documentation under ${docs}.`);
  process.exit(2);
}

const source = readFileSync(controllerPath, "utf8")
  .replace(/\/\/.*$/gm, "")
  .replace(/"(?:[^"\\\n]|\\.)*"/g, '""');
// Functions and properties the script defines itself (request.cleanup = function, ...).
const own = new Set([
  ...[...source.matchAll(/function\s+([A-Za-z_$][\w$]*)/g)].map(m => m[1]),
  ...[...source.matchAll(/\.([A-Za-z_$][\w$]*)\s*=\s*function/g)].map(m => m[1]),
  ...[...source.matchAll(/([A-Za-z_$][\w$]*)\s*:\s*function/g)].map(m => m[1])
]);

const unknown = new Map();
const deprecatedOnly = new Map();
const lines = source.split("\n");
lines.forEach((line, index) => {
  for (const match of line.matchAll(/\.([A-Za-z_$][\w$]*)\s*\(/g)) {
    const name = match[1];
    if (LANGUAGE_METHODS.has(name) || own.has(name)) continue;
    const entry = api.get(name);
    const target = !entry ? unknown : entry.current === 0 ? deprecatedOnly : null;
    if (!target) continue;
    if (!target.has(name)) target.set(name, []);
    target.get(name).push(index + 1);
  }
});

const report = (title, map) => {
  if (!map.size) return;
  console.error(title);
  for (const [name, at] of map) console.error(`  ${name}  (line ${at.slice(0, 5).join(", ")}${at.length > 5 ? ", ..." : ""})`);
};
report("Not in the Controller API reference:", unknown);
report("Only deprecated in the Controller API reference:", deprecatedOnly);
if (unknown.size || deprecatedOnly.size) process.exit(1);
console.log(`All method calls in the controller match the Controller API reference (${api.size} documented method names in ${files.length} files).`);

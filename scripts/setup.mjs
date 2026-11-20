#!/usr/bin/env node
// Local setup for Bitwig Agent Bridge. Safe to re-run at any time.
//
//   npm run setup                       install deps, create the secret,
//                                       install the controller script
//   npm run setup -- --skip-install     skip `npm install` (dev loop)
//   npm run setup -- --skip-controller  do not (re)install the controller

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const args = new Set(process.argv.slice(2));

const tokenFile = path.join(root, "data", "bridge-token");
const controllerSource = path.join(root, "controller", "BitwigAgentBridge.control.js");
const controllerTargetDirectory = path.join(homedir(), "Documents", "Bitwig Studio", "Controller Scripts", "Bitwig Agent Bridge");
const controllerTarget = path.join(controllerTargetDirectory, "BitwigAgentBridge.control.js");

let failures = 0;

function ok(message) { console.log(`  ✓ ${message}`); }
function fail(message) { failures += 1; console.log(`  ✗ ${message}`); }
function heading(message) { console.log(`\n${message}`); }

heading("Bitwig Agent Bridge setup");
console.log(`  Install location: ${root}`);

const nodeMajor = Number(process.versions.node.split(".")[0]);
if (nodeMajor < 20) {
  console.log(`\n  Node.js 20 or newer is required; you have ${process.versions.node}.\n`);
  process.exit(1);
}
ok(`Node.js ${process.versions.node}`);

// ------------------------------------------------------------- dependencies
if (!args.has("--skip-install")) {
  heading("Dependencies");
  const install = spawnSync("npm", ["install", "--no-fund", "--no-audit"], { cwd: root, encoding: "utf8" });
  if (install.status === 0) ok("MCP server dependencies installed");
  else {
    fail("npm install failed");
    console.log(install.stderr || install.stdout);
  }
}

// ------------------------------------------------------------------- secret
heading("Bridge secret");
await mkdir(path.dirname(tokenFile), { recursive: true });
if (existsSync(tokenFile)) {
  ok("Using the existing bridge secret");
} else {
  await writeFile(tokenFile, `${randomUUID()}\n`, { mode: 0o600 });
  ok("Generated a new bridge secret (data/bridge-token)");
}
const token = (await readFile(tokenFile, "utf8")).trim();

// --------------------------------------------------------------- controller
if (!args.has("--skip-controller")) {
  heading("Bitwig controller script");
  const source = await readFile(controllerSource, "utf8");
  const placeholder = "__BRIDGE_TOKEN__";
  if (!source.includes(placeholder)) {
    fail(`controller/BitwigAgentBridge.control.js is missing the token placeholder ${placeholder}.`);
  } else {
    await mkdir(controllerTargetDirectory, { recursive: true });
    await writeFile(controllerTarget, source.replace(placeholder, token), { mode: 0o600 });
    ok(`Installed to ${controllerTarget}`);
  }
}

// ------------------------------------------------------------------ summary
if (failures > 0) {
  heading(`Setup finished with ${failures} problem${failures === 1 ? "" : "s"}; see the ✗ lines above.`);
  process.exit(1);
}

heading("Setup complete. Next steps:");
console.log(`
  1. In Bitwig: Settings → Controllers → + Add Controller → vendor and
     controller "Bitwig Agent Bridge". (Already added? Toggle its power button
     off and on so Bitwig reloads the script.)
  2. Register the MCP server with your agent, for example Claude Code:
     claude mcp add bitwig -- node ${path.join(root, "src", "index.mjs")}
`);

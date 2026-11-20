#!/usr/bin/env node
// Local setup for Agent Bridge for Bitwig. Safe to re-run at any time.
//
//   npm run setup                       install deps, create the secret,
//                                       install the controller script
//   npm run setup -- --skip-install     skip `npm install` (dev loop)
//   npm run setup -- --skip-controller  do not (re)install the controller
//   npm run setup -- --controller-dir "<path>"
//                                       install into this "Controller Scripts"
//                                       folder instead of Bitwig's default

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CONTROLLER_FILE_NAME, CONTROLLER_FOLDER_NAME, resolveControllerScripts, windowsDocumentsFolder } from "./bitwig-folder.mjs";

const root = path.dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const argv = process.argv.slice(2);
const args = new Set(argv);
const isWindows = process.platform === "win32";

function optionValue(name) {
  const index = argv.indexOf(name);
  if (index < 0) return "";
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    console.log(`\n  ${name} needs a folder, for example: npm run setup -- ${name} "<path>"\n`);
    process.exit(1);
  }
  return path.resolve(value);
}

const tokenFile = path.join(root, "data", "bridge-token");
const controllerSource = path.join(root, "controller", CONTROLLER_FILE_NAME);
const explicitControllerScripts = optionValue("--controller-dir");

let failures = 0;

function ok(message) { console.log(`  ✓ ${message}`); }
function fail(message) { failures += 1; console.log(`  ✗ ${message}`); }
function heading(message) { console.log(`\n${message}`); }

heading("Agent Bridge for Bitwig setup");
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
  // On Windows npm is a .cmd script, which Node only starts through a shell.
  const install = spawnSync("npm", ["install", "--no-fund", "--no-audit"], { cwd: root, encoding: "utf8", shell: isWindows });
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
  const scripts = resolveControllerScripts({
    platform: process.platform,
    home: homedir(),
    documents: isWindows ? windowsDocumentsFolder() : "",
    explicit: explicitControllerScripts
  });
  const source = await readFile(controllerSource, "utf8");
  const placeholder = "__BRIDGE_TOKEN__";
  if (scripts.error) {
    fail(scripts.error);
  } else if (!source.includes(placeholder)) {
    fail(`controller/${CONTROLLER_FILE_NAME} is missing the token placeholder ${placeholder}.`);
  } else {
    const targetDirectory = path.join(scripts.directory, CONTROLLER_FOLDER_NAME);
    const target = path.join(targetDirectory, CONTROLLER_FILE_NAME);
    await mkdir(targetDirectory, { recursive: true });
    await writeFile(target, source.replace(placeholder, token), { mode: 0o600 });
    ok(`Installed to ${target}`);

    // Before 2.0.0 the project was called Bitwig Agent Bridge and installed
    // here. Both copies share one controller id, so the old one has to go.
    const legacyDirectory = path.join(scripts.directory, "Bitwig Agent Bridge");
    const legacyController = path.join(legacyDirectory, "BitwigAgentBridge.control.js");
    if (existsSync(legacyController)) {
      await rm(legacyController);
      const left = await readdir(legacyDirectory);
      if (left.length === 0) await rm(legacyDirectory, { recursive: true });
      ok(`Removed the copy installed under the old name (${legacyController})`);
    }
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
     controller "Agent Bridge for Bitwig". (Already added? Toggle its power
     button off and on so Bitwig reloads the script.)
  2. Register the MCP server with your agent, for example Claude Code:
     claude mcp add --scope user bitwig -- node "${path.join(root, "src", "index.mjs")}"
  3. Optional: check the connection with Bitwig open:
     npm run smoke
`);

#!/usr/bin/env node
// Command-line entry point of the npm package.
//
//   agent-bridge-for-bitwig            run the MCP server over stdio (what agents start)
//   agent-bridge-for-bitwig setup      create the secret, install the controller script
//   agent-bridge-for-bitwig smoke      check the connection to a running Bitwig
import { readFileSync } from "node:fs";

const USAGE = `Agent Bridge for Bitwig: an MCP server for Bitwig Studio 6.

Usage:
  agent-bridge-for-bitwig                 run the MCP server over stdio (agents start this)
  agent-bridge-for-bitwig setup [flags]   create the secret and install the controller script
                                          into Bitwig; flags: --controller-dir "<path>",
                                          --skip-controller
  agent-bridge-for-bitwig smoke [--write] check the connection with Bitwig open; --write also
                                          creates, checks and deletes a test track
  agent-bridge-for-bitwig --version       print the version

Docs: https://github.com/zkyron-de/agent-bridge-for-bitwig#readme`;

const [command, ...rest] = process.argv.slice(2);
const scripts = { setup: "../scripts/setup.mjs", smoke: "../scripts/smoke.mjs" };

if (command === undefined || command === "serve") {
  if (command === undefined && process.stdin.isTTY) {
    // Started by hand in a terminal: the server would sit waiting for an agent.
    console.log(`${USAGE}\n\nTo run the server here anyway, use: agent-bridge-for-bitwig serve`);
  } else {
    await import("../src/index.mjs");
  }
} else if (Object.hasOwn(scripts, command)) {
  // The scripts read their flags from process.argv, as when run directly.
  process.argv = [process.argv[0], command, ...rest];
  await import(scripts[command]);
} else if (command === "--version" || command === "-v") {
  console.log(JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version);
} else if (command === "--help" || command === "-h" || command === "help") {
  console.log(USAGE);
} else {
  console.error(`Unknown command: ${command}\n\n${USAGE}`);
  process.exit(1);
}

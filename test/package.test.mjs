import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = relative => readFileSync(new URL(`../${relative}`, import.meta.url), "utf8");
const pkg = JSON.parse(read("package.json"));
const server = JSON.parse(read("server.json"));
const cli = new URL("../bin/agent-bridge-for-bitwig.mjs", import.meta.url).pathname;

test("every place names the same version", () => {
  const { version } = pkg;
  assert.match(read("src/index.mjs"), new RegExp(`version: "${version.replaceAll(".", "\\.")}"`));
  const controller = read("controller/AgentBridgeForBitwig.control.js");
  assert.ok(controller.includes(`var BRIDGE_VERSION = "${version}";`), "controller BRIDGE_VERSION");
  assert.ok(controller.includes(`"Agent Bridge for Bitwig", "${version}",`), "controller defineController version");
  assert.equal(server.version, version);
  assert.equal(server.packages[0].version, version);
  assert.match(read("CHANGELOG.md"), new RegExp(`## \\[${version.replaceAll(".", "\\.")}\\]`));

  for (const doc of ["README.md", "docs/setup.md"]) {
    const pinned = [...read(doc).matchAll(/agent-bridge-for-bitwig@(\d+\.\d+\.\d+)/g)].map(match => match[1]);
    assert.ok(pinned.length > 0, `${doc} shows the npx command`);
    assert.deepEqual([...new Set(pinned)], [version], `${doc} pins the current version`);
  }
});

test("the registry entry matches the npm package", () => {
  assert.equal(pkg.mcpName, server.name);
  assert.equal(server.packages[0].identifier, pkg.name);
  assert.equal(server.packages[0].registryType, "npm");
  assert.ok(server.description.length <= 100, "the registry allows 100 characters");
  assert.equal(pkg.bin[pkg.name], "bin/agent-bridge-for-bitwig.mjs");
});

test("the package ships everything the CLI loads", () => {
  for (const file of ["bin/", "src/", "controller/", "scripts/setup.mjs", "scripts/smoke.mjs", "scripts/bitwig-folder.mjs"]) {
    assert.ok(pkg.files.includes(file), `files lists ${file}`);
  }
});

test("CLI: --version, --help and unknown commands", () => {
  const run = args => spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });
  assert.equal(run(["--version"]).stdout.trim(), pkg.version);
  const help = run(["--help"]);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /agent-bridge-for-bitwig setup/);
  const unknown = run(["frobnicate"]);
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /Unknown command: frobnicate/);
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { registerTools } from "../src/tools.mjs";

// The tool registry as the MCP server sees it: name, config and the
// controller method each handler calls.
const tools = [];
registerTools({ registerTool: (name, config, handler) => tools.push({ name, config, handler }) }, (method, params) => ({ method, params }));
for (const tool of tools) tool.method = (await tool.handler({})).method;

const controller = readFileSync(new URL("../controller/BitwigAgentBridge.control.js", import.meta.url), "utf8");
const dispatchBody = controller.slice(controller.indexOf("function dispatch(request) {"));
const dispatched = [...dispatchBody.slice(0, dispatchBody.indexOf("\n}\n")).matchAll(/case "([a-z_]+)":/g)].map(m => m[1]);
const help = readFileSync(new URL("../HELP.md", import.meta.url), "utf8");
const reference = help.slice(help.indexOf("## MCP tool reference"), help.indexOf("\n## ", help.indexOf("## MCP tool reference") + 5));

test("there are at most 25 tools, each with a unique bitwig_ name and a description", () => {
  assert.ok(tools.length <= 25, `${tools.length} tools`);
  assert.equal(new Set(tools.map(t => t.name)).size, tools.length);
  for (const tool of tools) {
    assert.match(tool.name, /^bitwig_[a-z_]+$/);
    assert.ok(tool.config.description && tool.config.description.length > 40, `${tool.name} needs a description`);
  }
});

// Walks a zod 4 schema and returns the paths of objects that accept unknown keys.
function looseObjects(schema, path) {
  const def = schema._zod.def;
  if (def.type === "object") {
    const loose = def.catchall && def.catchall._zod.def.type === "never" ? [] : [path];
    return loose.concat(...Object.entries(def.shape).map(([key, value]) => looseObjects(value, `${path}.${key}`)));
  }
  if (def.type === "array") return looseObjects(def.element, `${path}[]`);
  if (def.innerType) return looseObjects(def.innerType, path);
  return [];
}

test("every tool has a strict input schema, nested objects included", () => {
  for (const tool of tools) {
    assert.ok(tool.config.inputSchema && tool.config.inputSchema._zod, `${tool.name} has no zod schema`);
    assert.deepEqual(looseObjects(tool.config.inputSchema, tool.name), [], `${tool.name} accepts unknown keys`);
    const result = tool.config.inputSchema.safeParse({ notAField: 1 });
    assert.equal(result.success, false, `${tool.name} accepted an unknown field`);
  }
});

test("every tool calls a method the controller dispatches, and every dispatched method has a tool", () => {
  const called = new Set(tools.map(t => t.method));
  for (const tool of tools) assert.ok(dispatched.includes(tool.method), `${tool.name} calls ${tool.method}, which the controller does not dispatch`);
  assert.deepEqual(dispatched.filter(method => !called.has(method)), [], "dispatched methods without a tool");
});

test("HELP.md documents exactly the registered tools and counts them right", () => {
  const documented = [...reference.matchAll(/^- \*\*(bitwig_[a-z_]+)\*\*/gm)].map(m => m[1]);
  assert.deepEqual([...documented].sort(), tools.map(t => t.name).sort());
  assert.match(reference, new RegExp(`All ${tools.length} tools`));
});

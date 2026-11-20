#!/usr/bin/env node
import { appendFile, mkdir } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { BitwigClient } from "./bitwig-client.mjs";
import { registerTools } from "./tools.mjs";

const client = new BitwigClient();
const server = new McpServer({ name: "agent-bridge-for-bitwig", version: "2.0.0" });
const logDirectory = new URL("../logs/", import.meta.url);
const logFile = new URL("agent-bridge-for-bitwig.jsonl", logDirectory);

function output(data) {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }], structuredContent: data };
}

function logValue(value) {
  const serialized = JSON.stringify(value);
  if (serialized.length <= 12000) return value;
  return { truncated: true, bytes: Buffer.byteLength(serialized), preview: serialized.slice(0, 12000) };
}

async function writeLog(entry) {
  try {
    await mkdir(logDirectory, { recursive: true });
    await appendFile(logFile, JSON.stringify({ timestamp: new Date().toISOString(), ...entry }) + "\n", "utf8");
  } catch {
    // Logging must never break music control.
  }
}

async function call(method, params = {}, timeoutMs) {
  const startedAt = performance.now();
  try {
    const response = await client.request(method, params, timeoutMs);
    await writeLog({ method, arguments: params, durationMs: Math.round(performance.now() - startedAt), success: true, response: logValue(response) });
    return output(response);
  } catch (error) {
    await writeLog({ method, arguments: params, durationMs: Math.round(performance.now() - startedAt), success: false, error: error.message });
    return { content: [{ type: "text", text: error.message }], isError: true };
  }
}

registerTools(server, call);

const transport = new StdioServerTransport();
await server.connect(transport);

process.on("SIGINT", () => {
  client.close();
  process.exit(0);
});

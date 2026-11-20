#!/usr/bin/env node
// End-to-end check against a running Bitwig Studio: starts the MCP server
// like an agent would, calls a few tools and prints one line per step.
//
//   npm run smoke               read-only: changes nothing in Bitwig
//   npm run smoke -- --write    also creates a track "Smoke test", writes a
//                               clip, reads it back and deletes the track;
//                               use an empty project for this
//
// Exits 1 if a step fails. Paste the output into an issue when reporting.
import { platform, release } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = path.dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const write = process.argv.includes("--write");
let failures = 0;

console.log(`Agent Bridge for Bitwig smoke test (${write ? "read and write" : "read-only"})`);
console.log(`  System: ${platform()} ${release()}, Node.js ${process.versions.node}`);

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(root, "src", "index.mjs")],
  cwd: root,
  stderr: "inherit"
});
const client = new Client({ name: "agent-bridge-smoke-test", version: "1" });
await client.connect(transport);

// Calls one tool. Returns the parsed reply, or null after printing the error.
async function step(label, tool, args, check = () => "") {
  try {
    const result = await client.callTool({ name: tool, arguments: args });
    const text = result.content?.[0]?.text ?? "";
    if (result.isError) throw new Error(text);
    const reply = JSON.parse(text);
    const note = check(reply);
    console.log(`  ✓ ${label}${note ? `: ${note}` : ""}`);
    return reply;
  } catch (error) {
    failures += 1;
    console.log(`  ✗ ${label}: ${String(error.message || error).split("\n")[0].slice(0, 300)}`);
    return null;
  }
}

const status = await step("bitwig_status", "bitwig_status", {}, reply =>
  `${reply.bridge} ${reply.version}, connected ${reply.connected}, project "${reply.project}"`);

if (status) {
  await step("bitwig_transport (read)", "bitwig_transport", {}, reply => `tempo ${reply.tempo}, playing ${reply.playing}`);
  await step("bitwig_tracks", "bitwig_tracks", {}, reply => `${reply.tracks.length} tracks, ${reply.effectTracks.length} effect tracks`);
  await step("bitwig_launcher", "bitwig_launcher", { sceneLimit: 4 }, reply => `${reply.scenes?.length ?? 0} scenes read`);
  await step("bitwig_actions", "bitwig_actions", { query: "undo", limit: 3 }, reply => `${reply.total ?? reply.actions?.length} matches`);

  if (write) {
    const notes = [
      { beat: 0, pitch: 36, duration: 0.5, velocity: 100 },
      { beat: 1, pitch: 43, duration: 0.5, velocity: 90 },
      { beat: 2, pitch: 48, duration: 0.5, velocity: 100 },
      { beat: 3, pitch: 46, duration: 0.5, velocity: 90 }
    ];
    const created = await step("bitwig_create_track", "bitwig_create_track", { kind: "instrument", name: "Smoke test" }, reply => {
      if (!reply.created?.id) throw new Error("the reply has no created.id");
      return `id ${reply.created.id}`;
    });
    const track = created?.created;
    if (track) {
      await step("bitwig_write_clip", "bitwig_write_clip", { trackId: track.id, slotIndex: 0, name: "Smoke clip", lengthBeats: 4, notes });
      await step("bitwig_read_clip", "bitwig_read_clip", { trackId: track.id, slotIndex: 0 }, reply => {
        const pitches = (reply.notes || []).map(note => note.pitch).join(",");
        const expected = notes.map(note => note.pitch).join(",");
        if (pitches !== expected) throw new Error(`read back pitches ${pitches}, expected ${expected}`);
        return `${reply.notes.length} notes read back`;
      });
      // Runs even if writing or reading failed, so no test track is left over.
      await step("bitwig_delete (track)", "bitwig_delete", { what: "track", trackId: track.id }, reply => `removed ${reply.removedCount}`);
    }
  }
}

await client.close();
console.log(failures ? `\n${failures} step${failures === 1 ? "" : "s"} failed.` : "\nAll steps passed.");
process.exit(failures ? 1 : 0);

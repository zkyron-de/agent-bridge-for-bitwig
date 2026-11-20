# Bitwig Agent Bridge — Help & Reference

Everything about installing, using, troubleshooting, and understanding Bitwig Agent Bridge. For a quick start, see the [README](README.md); this file is the complete reference.

---

## Contents

1. [What Bitwig Agent Bridge is](#what-bitwig-agent-bridge-is)
2. [Compatibility](#compatibility)
3. [The pieces](#the-pieces)
4. [Installing](#installing)
5. [Setting up Bitwig](#setting-up-bitwig)
6. [Connecting agents](#connecting-agents)
7. [MCP tool reference](README.md#tool-reference)
8. [Files and locations](#files-and-locations)
9. [Troubleshooting](#troubleshooting)
10. [Uninstalling](#uninstalling)
11. [Security model](#security-model)

---

## What Bitwig Agent Bridge is

Bitwig Agent Bridge lets an agent operate Bitwig Studio the way a careful engineer would: every action names its exact target, ambiguous requests are refused, and every change is read back from Bitwig before being reported as done. It speaks the [Model Context Protocol](https://modelcontextprotocol.io) (MCP), an open standard for connecting agents to tools.

## Compatibility

| Requirement | Minimum |
|---|---|
| macOS | 13 Ventura or newer (Apple silicon and Intel) |
| Bitwig Studio | 6.x with Controller API 25 (tested with 6.1.7) |
| Node.js | 20 or newer |

Only the controller-script install path in `scripts/setup.mjs` is macOS-specific.

## The pieces

1. **The controller script** (`controller/BitwigAgentBridge.control.js`) — a Bitwig controller extension that runs *inside* Bitwig. It listens on local UDP port `50701` for authenticated requests and is the only thing that actually touches your project. Installed into Bitwig by setup with your private secret stamped in.
2. **The MCP server** (`src/index.mjs`, tools in `src/tools.mjs`) — the part your agent talks to. Each agent launches its own copy on demand over stdio (it is not a background service) and it relays requests to the controller script.

## Installing

Run `npm run setup` in the checkout. It installs the MCP server's dependencies, generates the per-install secret, and installs the controller script with the secret stamped in. Flags: `--skip-install`, `--skip-controller`. It is safe to re-run at any time.

## Setting up Bitwig

Setup installs the controller script into Bitwig's default controller-script folder (`~/Documents/Bitwig Studio/Controller Scripts/Bitwig Agent Bridge/`). Add it once:

1. In Bitwig, open the Dashboard (the Bitwig logo, top center) → **Settings** → **Controllers**.
2. Click **+ Add Controller**.
3. Choose vendor **Bitwig Agent Bridge**, then the controller of the same name, and click **Add**.
4. The entry's power button should be on. You'll see the **"Bitwig Agent Bridge online"** popup, and the script console (the `>` icon on the controller entry) logs `Bitwig Agent Bridge <version> listening on UDP 50701`.

**Reloading.** After re-running setup (which re-stamps the secret into the controller script), make Bitwig reload it: restart Bitwig, or toggle the controller's power button off and on in Settings → Controllers.

**If the controller isn't listed at all**, Bitwig is probably looking in a non-default location: Settings → **Locations** → "My Controller Scripts" should point at `~/Documents/Bitwig Studio/Controller Scripts` (the default). If you've customized it, either restore the default or copy the `Bitwig Agent Bridge` folder into your custom location — but always the setup-installed copy, never the repo file, which has no secret stamped in.

## Connecting agents

- **Command:** `node <install-path>/src/index.mjs`
- **Transport:** stdio — no URL, no port, no network setup
- Bitwig must be open for tools to work; the agent config is one-time.

### Setup snippets

Replace `/path/to/bitwig-agent-bridge` with your install folder. The server name `bitwig` is up to you.

**Claude Code** — adds it for every project:

```sh
claude mcp add --scope user bitwig -- node /path/to/bitwig-agent-bridge/src/index.mjs
```

**OpenAI Codex** — the CLI, IDE extension and desktop app share this setting:

```sh
codex mcp add bitwig -- node /path/to/bitwig-agent-bridge/src/index.mjs
```

Or add it to `~/.codex/config.toml`:

```toml
[mcp_servers.bitwig]
command = "node"
args = ["/path/to/bitwig-agent-bridge/src/index.mjs"]
```

**Grok CLI** — saves it to `~/.grok/config.toml`:

```sh
grok mcp add bitwig -- node /path/to/bitwig-agent-bridge/src/index.mjs
```

**GitHub Copilot in VS Code** — run **MCP: Add Server** from the Command Palette, choose **Command (stdio)**, enter `node /path/to/bitwig-agent-bridge/src/index.mjs`, name it `bitwig`, then pick **Global** → **Copilot Global**. That writes `~/.copilot/mcp-config.json`, which you can also edit directly:

```json
{
  "mcpServers": {
    "bitwig": {
      "command": "node",
      "args": ["/path/to/bitwig-agent-bridge/src/index.mjs"]
    }
  }
}
```

**Claude Desktop, Cursor, Windsurf and Cline** use the standard `mcpServers` block:

```json
{
  "mcpServers": {
    "bitwig": {
      "command": "node",
      "args": ["/path/to/bitwig-agent-bridge/src/index.mjs"]
    }
  }
}
```

Merge it into the file each one reads, then restart it or refresh its MCP list:

- **Claude Desktop:** Settings → Developer → Edit Config opens `~/Library/Application Support/Claude/claude_desktop_config.json`.
- **Cursor:** `~/.cursor/mcp.json`, or `.cursor/mcp.json` in a project.
- **Windsurf:** in the Cascade panel, open the `...` menu and choose **Open MCP config file** to edit `mcp_config.json`.
- **Cline:** click the MCP Servers icon in the Cline panel, open **Configure**, then **Configure MCP Servers**. The Cline CLI can add it in one line: `cline mcp add bitwig --yes -- node /path/to/bitwig-agent-bridge/src/index.mjs`.

## MCP tool reference

The tool reference and the limitations live in the [README](README.md#tool-reference).

## Files and locations

| What | Where |
|---|---|
| Per-install secret | `<install>/data/bridge-token` |
| MCP request log | `<install>/logs/bitwig-agent-bridge.jsonl` |
| Controller script (installed copy) | `~/Documents/Bitwig Studio/Controller Scripts/Bitwig Agent Bridge/` |

Port (loopback-only): `50701/udp` bridge.

## Troubleshooting

**Tools time out.** Bitwig isn't open, or the controller isn't active. In Bitwig: Settings → Controllers → confirm "Bitwig Agent Bridge" exists and is enabled. `bitwig_status` is the cheapest way to check what the agent sees.

**Requests time out even though Bitwig Agent Bridge is enabled.** The controller script and the MCP server may disagree about the secret, usually because the controller was installed before the current `data/bridge-token`. The bridge ignores requests with the wrong secret without replying, shows a popup in Bitwig the first time, and logs the count. Run setup again (it re-stamps the controller), then reload the controller in Bitwig.

**The controller refuses to start and mentions a missing token.** The repo copy of the controller was installed by hand instead of through setup, so the secret placeholder was never stamped. Run setup; never copy `controller/BitwigAgentBridge.control.js` into Bitwig manually.

**"No track has the id …".** The track was deleted, or it lies beyond the first 64 main or 16 effect tracks the bridge reaches. Track ids stay the same when a track is renamed or moved; list the tracks again with `bitwig_tracks`. Tracks may share a name, and Bitwig renumbers default names such as "Inst 2" when tracks before them move or go away, so use the id, not the name.

**The selected track flickers while a tool runs.** Device, sample and clip tools work through Bitwig's selection, so they select their track for a moment. When the tool finishes, Bitwig Agent Bridge selects your track again, and your device too when the tool worked on that same track. Selection is left alone when your track moved or was deleted, and when you had the master, an effect track or a track past the first 64 selected. `bitwig_create_track` still leaves the new track selected.

**The browser does not offer a device or preset.** Bitwig's browser only lists what fits the insertion point: at the end of an empty instrument track it shows instruments, at the end of an audio track audio effects, before an instrument note effects. Search at the place you want to insert. A location that does not exist there is refused with the list of locations Bitwig offers.

**A sample is not found in the browser.** Bitwig's API cannot switch its browser to the Samples tab, so samples are loaded by file path with `bitwig_insert_sample`.

**A track got renamed after inserting.** Bitwig names a track that still has its default name ("Inst 1") after the first instrument or sample on it. The reply then carries `trackRenamedTo`; use that name next.

**A direct parameter ends up at a tiny value.** Some plug-ins report a value written through a direct parameter divided by 16384. The reply says so; set that parameter through a remote control instead.

**"Bitwig's answer is … bytes, over the 60000-byte limit for one reply."** Each answer from Bitwig travels in one local network message, capped at 60,000 bytes. Ask for less at once: a smaller `limit`, an `offset`, or a `query` filter.

**"Bitwig could not send the … reply."** macOS refused the message from Bitwig, usually because it was larger than the system allows for one message. Ask for less at once, as above. The Controller Script Console shows the same error with the size.

## Uninstalling

```sh
rm -rf ~/Documents/"Bitwig Studio"/"Controller Scripts"/"Bitwig Agent Bridge"
```

Then remove the controller in Bitwig's Settings → Controllers, delete the install folder, and remove the server from your agent (for Claude Code: `claude mcp remove bitwig`). Bitwig Agent Bridge writes nowhere else.

## Security model

- Everything binds to `127.0.0.1`. Nothing listens on, or connects to, any network.
- Every bridge request carries a per-install secret generated on your machine and never committed anywhere. The controller refuses to run without one.
- Mutations require exact targets (track ids; index plus current name for devices, scenes and clips) and are refused on mismatch or ambiguity, so a confused agent fails loudly instead of editing the wrong thing.
- The MCP server logs requests locally to `logs/bitwig-agent-bridge.jsonl` so you can audit what an agent did.

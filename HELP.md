# Bitwig Agent Bridge — Help & Reference

Everything about installing, using, troubleshooting, and understanding Bitwig Agent Bridge. For a quick start, see the [README](README.md); this file is the complete reference.

---

## Contents

1. [What Bitwig Agent Bridge is](#what-bitwig-agent-bridge-is)
2. [Compatibility](#compatibility)
3. [The pieces](#the-pieces)
4. [Installing](#installing)
5. [Setting up Bitwig](#setting-up-bitwig)
6. [Connecting SI agents](#connecting-si-agents)
7. [MCP tool reference](#mcp-tool-reference)
8. [Files and locations](#files-and-locations)
9. [Troubleshooting](#troubleshooting)
10. [Uninstalling](#uninstalling)
11. [Security model](#security-model)

---

## What Bitwig Agent Bridge is

Bitwig Agent Bridge lets an SI agent operate Bitwig Studio the way a careful engineer would: every action names its exact target, ambiguous requests are refused, and every change is read back from Bitwig before being reported as done. It speaks the [Model Context Protocol](https://modelcontextprotocol.io) (MCP), an open standard for connecting agents to tools.

## Compatibility

| Requirement | Minimum |
|---|---|
| macOS | 13 Ventura or newer (Apple silicon and Intel) |
| Bitwig Studio | 6.x with Controller API 25 (tested with 6.1.7) |
| Node.js | 20 or newer |

Only the controller-script install path in `scripts/setup.mjs` and the plug-in scanner's folder paths are macOS-specific.

## The pieces

1. **The controller script** (`controller/BitwigAgentBridge.control.js`) — a Bitwig controller extension that runs *inside* Bitwig. It listens on local UDP port `50701` for authenticated requests and is the only thing that actually touches your project. Installed into Bitwig by setup with your private secret stamped in.
2. **The MCP server** (`src/index.mjs`) — the part your SI agent talks to. Each agent launches its own copy on demand over stdio (it is not a background service) and it relays requests to the controller script.

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

## Connecting SI agents

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

All 36 tools follow the same contract: **exact targets** (mutations require both index and current name; stale names are refused), **no preset loading** (only Bitwig's Devices browser is used), and **readback verification** (writes report the value Bitwig actually shows afterward).

### Status & session

- **bitwig_status** — Check Bitwig Agent Bridge, Bitwig, the current project, transport, current selection, and whether Bitwig's audio engine is on.
- **bitwig_actions** — Search Bitwig Studio's native action registry by action id, name, or menu text. Matching ignores case, returns up to 100 actions, and reports how many matched in total.
- **bitwig_invoke_action** — Invoke one exact Bitwig action id previously returned by `bitwig_actions`.
- **bitwig_transport** — Read or control Bitwig transport. Tempo changes are read back before success is reported.
- **bitwig_track_meters** — Read peak signal activity captured for every track, or reset the captured maxima before a playback test. When tracks are added, deleted or moved, a track that lands on a new position starts a fresh maximum instead of inheriting the previous track's peak.

### Tracks

- **bitwig_tracks** — List tracks with exact names, positions, safety references, types, and states.
- **bitwig_create_track** — Create an empty track without opening the Browser or loading any preset. The bridge finds the track Bitwig added by comparing the track list before and after, then names it and checks the name. Effect tracks are reported with their `effectTrackIndex` in the effect track list. With 128 main tracks (or 32 effect tracks) it refuses before creating anything.
- **bitwig_set_track_mix** — Set exact mixer values on one verified track and read the resulting state back.
- **bitwig_rename_track** — Rename one verified track without changing its routing.
- **bitwig_delete_track** — Delete one exact track; the supplied name must still match, preventing index-drift mistakes. It succeeds only after Bitwig's track list shows the track gone and every other track in its place. Deleting a group also removes its tracks, and the reply's `removedCount` says how many went.

### Clips & arrangement

- **bitwig_clips** — List populated launcher clips in every scene for one exact track, with the project's scene count. Clip and scene tools take slot and scene numbers from 0 to 1023, and creating a clip one slot past the last scene adds a new scene for it.
- **bitwig_read_clip** — Read one launcher clip: name, color, loop (`enabled`, `startBeats`, `lengthBeats`), play state, and every note with `beat`, `pitch`, `channel`, `velocity`, `duration`, `timbre`, `pan`, `gain` and `muted`. Notes outside the loop are read too. `stepsPerBeat` (1–960, default 4) sets the read grid: a note that starts between two steps comes back at the step it starts in, so use 96 or more to keep off-grid timing. Long clips are paged with `offset` and `limit` (up to 300 notes per reply).
- **bitwig_write_clip** — Create a launcher MIDI clip (or replace one with `replace: true`) and write its complete content: `name`, `lengthBeats`, optional `loop` and `color` (`#RRGGBB`), and `notes`. Every note start must lie on the `stepsPerBeat` grid, so fine timing is written exactly. The whole clip is then read back; a missing, changed or extra note, or a property Bitwig did not take, fails the call and names the first five differences. If Bitwig stops part-way, the reply says what the clip holds now.
- **bitwig_edit_clip** — Change an existing clip without rewriting it. `setNotes` adds a note or changes only the given fields of the note at that `beat`/`pitch`/`channel`; `removeNotes` deletes single notes. `name`, `loop` and `color` can change too. Mistakes in the request (removing a note that isn't there, setting and removing the same note, a new note without a duration) are refused before anything changes. The whole clip is read before and after, and every untouched note must come back unchanged.

  Note fields and ranges: `velocity` 1–127 (new notes default to 100), `duration` in beats, `timbre` −1…1, `pan` −1…1, `gain` 0…1 on Bitwig's NoteStep scale, `muted`. Per-note **pressure is not offered**: in Bitwig 6.1.7 a pressure written through the Controller API does not persist (it was lost again when notes were added, when timbre, pan or gain changed, and on later reads). A clip's length is its loop: change `loop.lengthBeats` to make it longer or shorter. One request may cover at most 16384 grid steps (clip span × `stepsPerBeat`), e.g. 170 beats at 96 steps per beat.
- **bitwig_arrange_launcher_clips** — Record existing launcher clips into the Arranger across exact beat regions, merging contiguous regions. Recording starts at the earliest region and runs at 666 BPM, and one print covers at most 1024 beats. While it records, armed tracks are disarmed and Arranger and Launcher overdub are off, so nothing else gets recorded. Afterwards, and also when the print fails or times out, Bitwig gets back its tempo, loop, overdub, track arms and playhead position.
- **bitwig_launch_scene** — Launch one scene immediately and from the start across all tracks.
- **bitwig_cue_markers** — List Arranger cue markers, or create/update a named marker set at exact beat positions with readback verification. New markers are added at the playhead and moved into place, so playback does not jump. If the transport is stopped on an existing marker, the playhead is moved aside for a moment and put back.

### Devices

- **bitwig_devices** — List devices on one exact track (reads the chain directly; never inspects presets).
- **bitwig_find_devices** — Search Bitwig's Devices browser only. Returns actual device names; presets are excluded by design.
- **bitwig_insert_device** — Insert one exact device at the end of an exact track; refused if the name is ambiguous.
- **bitwig_insert_stock_device** — Insert a stock Bitwig device by its stable UUID, optionally before a verified device — including note-processing positions the end-of-chain Browser omits.
- **bitwig_insert_clap_device** — Insert a CLAP plug-in directly by its stable ID, bypassing Browser filters and redundant-format hiding.
- **bitwig_nest_device** — Move one verified top-level device into another device's native nested chain and verify both chains.
- **bitwig_save_device_preset** — Open Bitwig's native Save-to-Library flow for one verified device, without mouse automation.
- **bitwig_delete_device** — Delete one exact device; both track and device names must still match. It succeeds only after Bitwig's device list shows the device gone and every other device in its place.
- **bitwig_open_device_window** — Open the native window for one exact device or plug-in.

### Samples

- **bitwig_find_samples** — Search Bitwig's indexed Samples browser for one exact instrument track.
- **bitwig_insert_sample** — Load one exact indexed sample into a new Sampler at the end of an instrument track.
- **bitwig_insert_sample_file** — Load an absolute WAV/AIFF/FLAC path into a new Sampler and verify the loaded sample name.

### Parameters

- **bitwig_device_parameters** — Read a device's full direct parameter list — third-party plug-ins included — with stable IDs and current values.
- **bitwig_set_device_parameter** — Set one parameter by stable ID and verify the normalized value through readback.
- **bitwig_remote_controls** — Show the compact eight-knob Remote Controls section for one exact device; optionally select a named page.
- **bitwig_selected_device_remote_controls** — Show or hide Remote Controls for the currently selected device, including nested devices.
- **bitwig_set_remote_control** — Set one visible Remote Control by page and control name via the same native path as the on-screen knobs, then verify.

### Plug-in library

- **bitwig_plugins** — Search the bridge's local inventory of installed VST3, VST2, AU, and CLAP plug-ins without opening Bitwig's Browser.
- **bitwig_refresh_plugin_index** — Rebuild that inventory after installing or removing plug-ins.

## Files and locations

| What | Where |
|---|---|
| Per-install secret | `<install>/data/bridge-token` |
| Plug-in inventory | `<install>/data/plugin-index.json` |
| MCP request log | `<install>/logs/bitwig-agent-bridge.jsonl` |
| Controller script (installed copy) | `~/Documents/Bitwig Studio/Controller Scripts/Bitwig Agent Bridge/` |

Port (loopback-only): `50701/udp` bridge.

## Troubleshooting

**Tools time out.** Bitwig isn't open, or the controller isn't active. In Bitwig: Settings → Controllers → confirm "Bitwig Agent Bridge" exists and is enabled. `bitwig_status` is the cheapest way to check what the agent sees.

**Requests time out even though Bitwig Agent Bridge is enabled.** The controller script and the MCP server may disagree about the secret, usually because the controller was installed before the current `data/bridge-token`. The bridge ignores requests with the wrong secret without replying, shows a popup in Bitwig the first time, and logs the count. Run setup again (it re-stamps the controller), then reload the controller in Bitwig.

**The controller refuses to start and mentions a missing token.** The repo copy of the controller was installed by hand instead of through setup, so the secret placeholder was never stamped. Run setup; never copy `controller/BitwigAgentBridge.control.js` into Bitwig manually.

**A tool says several tracks "are all named" the same.** The bridge does not use track IDs yet, so Bitwig Agent Bridge finds a track by its position and checks its name. When two tracks share a name, that check can't catch a track that moved, so tools refuse them. `bitwig_tracks` lists the clashing names under `duplicateNames`. Give each track a unique name, in Bitwig or with `bitwig_rename_track`, which still works on duplicates and refuses a name another track already has.

**Save to Library opened, but nothing was saved.** Bitwig's API can open the dialog but can't type into it, so `bitwig_save_device_preset` leaves the dialog open for you to name and save. With `confirm: true` it presses Enter to accept the prefilled name, and only when the same device is still selected. Compare `presetNameBefore` and `presetNameAfter` in the reply, then check the Library.

**The selected track flickers while a tool runs.** Device, sample and clip tools work through Bitwig's selection, so they select their track for a moment. When the tool finishes, Bitwig Agent Bridge selects your track again, and your device too when the tool worked on that same track. Selection is left alone when your track moved or was deleted, and when you had the master, an effect track or a track past the first 128 selected. `bitwig_create_track` still leaves the new track selected.

**Plug-in list is empty or stale.** Run `bitwig_refresh_plugin_index` or `npm run index:plugins`.

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
- Mutations require exact index-plus-name targets and are refused on mismatch or ambiguity, so a confused agent fails loudly instead of editing the wrong thing.
- The MCP server logs requests locally to `logs/bitwig-agent-bridge.jsonl` so you can audit what an agent did.

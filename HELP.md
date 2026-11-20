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

All 25 tools follow the same contract: **exact targets** (mutations require both index and current name; stale names are refused), **strict inputs** (unknown fields are rejected), and **readback verification** (a write succeeds only once Bitwig shows the requested value; otherwise the reply lists what it holds).

### Status & session

- **bitwig_status** — Check Bitwig Agent Bridge, Bitwig, the current project, transport, current selection, and whether Bitwig's audio engine is on.
- **bitwig_actions** — Search Bitwig's action registry (about 780 menu and shortcut commands) by id, name, menu text or category, ignoring case; `category` narrows it to one category id (`includeCategories: true` lists them), `offset` and `limit` (up to 200) page it. Ids are stable and English, names and menu text follow Bitwig's display language. Blocked actions are listed with the reason.
- **bitwig_invoke_action** — Run exactly one of: `actionId` (an exact id from `bitwig_actions`), `command` (`undo` or `redo`) or `panelLayout` (`ARRANGE`, `MIX`, `EDIT`). Bitwig does not confirm actions, so the reply lists what the bridge saw change in tracks, scenes, selection, transport, undo state and panel layout (`observedChanges`); view, selection and editor actions usually show no change there. Undo and redo are refused when Bitwig has nothing to undo or redo, and confirmed through its undo state; the panel layout is read back. Actions that create, open or close a project, quit Bitwig, or answer an open dialog (`New`, `Open`, `Close`, `Quit`, `new_from_template`, `Dialog: Yes`, `Dialog: No`, `Dialog: OK`) are refused; do those in Bitwig yourself.
- **bitwig_transport** — Without fields, read the full transport: playing, arranger record, tempo, time signature, playhead and play-start position, arranger loop, metronome (on/off, volume with display text), pre-roll, arranger and launcher overdub, arranger automation write and its mode, and the default launch quantization. With fields, change any of them in one call: `playback` (`play`, `stop`, `continue`, `restart`), `arrangerRecord`, `tempo` (20–666 BPM), `timeSignature` (`7/8`), `positionBeats`, `loop` (`enabled`, `startBeats`, `lengthBeats`), `metronome` (`enabled`, normalized `volume`), `preRoll` (`none`, `one_bar`, `two_bars`, `four_bars`), `arrangerOverdub`, `launcherOverdub`, `automationWrite` (`arranger`, `mode`: `latch`, `touch`, `write`) and `defaultLaunchQuantization`. Settings go first, then the position, then record and playback; everything is read back, and a value Bitwig refuses (such as the time signature 7/3) fails with what it holds.
  Measured in Bitwig 6.1.7: setting the position also moves the play-start marker, and works while playing too (the playhead jumps). Stopping turns launcher overdub off, so `playback: "stop"` with `launcherOverdub: true` is refused. Arranger record switches arranger automation write on and off with it, in Bitwig's own transport bar too. `restart` while playing jumps back to the play start; while stopped it started at beat 0.
- **bitwig_track_meters** — Read peak signal activity captured for every track, or reset the captured maxima before a playback test. When tracks are added, deleted or moved, a track that lands on a new position starts a fresh maximum instead of inheriting the previous track's peak.

### Tracks

- **bitwig_tracks** — List the main tracks (up to 64), effect tracks (up to 16) and the master track: index, exact name, type, color, mute, solo, `volumeDb` (`null` is −∞), `pan`, and for main tracks `position`, `arm` and `sends` (index, target effect track, `levelDb`, `enabled`, `mode`).
- **bitwig_create_track** — Create an empty track without opening the Browser or loading any preset. The bridge finds the track Bitwig added by comparing the track list before and after, then names it and checks the name. Effect tracks are reported with their `effectTrackIndex` in the effect track list. With 64 main tracks (or 16 effect tracks) it refuses before creating anything, because the bridge could not reach the new track.
- **bitwig_set_track** — Change one exact track: `name`, `color` (`#RRGGBB`), `volumeDb` (−120 to +6 dB), `pan` (−1 = 100 % left, 1 = 100 % right), `mute`, `solo`, `arm`, and `sends` (`levelDb` −120 to 0 dB, `enabled`, `mode` AUTO/PRE/POST; each send names its target effect track as a safety check). `trackKind` picks the list: `main` (default), `effect`, or `master` (index 0); arm and sends are for main tracks only. Only the given fields change, every one is read back, and a value Bitwig did not take fails the call with what it holds. Setting a send level switches the send on in Bitwig, so `enabled: false` is applied after the level. Renaming works on a track whose name another track shares, so clashes can be fixed; a name another track already has is refused.
- **bitwig_delete_track** — Delete one exact track; the supplied name must still match, preventing index-drift mistakes. It succeeds only after Bitwig's track list shows the track gone and every other track in its place. Deleting a group also removes its tracks, and the reply's `removedCount` says how many went.

### Clips & arrangement

- **bitwig_read_clip** — Read one launcher clip: name, color, loop (`enabled`, `startBeats`, `lengthBeats`), play state, and every note with `beat`, `pitch`, `channel`, `velocity`, `duration`, `timbre`, `pan`, `gainDb` and `muted`. Notes outside the loop are read too. `stepsPerBeat` (1–960, default 4) sets the read grid: a note that starts between two steps comes back at the step it starts in, so use 96 or more to keep off-grid timing. Long clips are paged with `offset` and `limit` (up to 300 notes per reply).
- **bitwig_write_clip** — Create a launcher MIDI clip (or replace one with `replace: true`) and write its complete content: `name`, `lengthBeats`, optional `loop` and `color` (`#RRGGBB`), and `notes`. Every note start must lie on the `stepsPerBeat` grid, so fine timing is written exactly. The whole clip is then read back; a missing, changed or extra note, or a property Bitwig did not take, fails the call and names the first five differences. If Bitwig stops part-way, the reply says what the clip holds now.
- **bitwig_edit_clip** — Change an existing clip without rewriting it. `setNotes` adds a note or changes only the given fields of the note at that `beat`/`pitch`/`channel`; `removeNotes` deletes single notes. `name`, `loop` and `color` can change too. Mistakes in the request (removing a note that isn't there, setting and removing the same note, a new note without a duration) are refused before anything changes. The whole clip is read before and after, and every untouched note must come back unchanged.

  Note fields and ranges: `velocity` 1–127 (new notes default to 100; Bitwig's Inspector shows it as a percentage, 100 = 78.7 %), `duration` in beats, `timbre` −1…1 and `pan` −1…1 (the Inspector shows ±100 %), `gainDb` −100…+18 dB (new notes get 0 dB; use `muted` for silence), `muted`. A note whose gain was never set (for example one drawn by hand) reads back as `gainDb: null`: it plays at 0 dB, but the Controller API reports the same value as for −∞, so the bridge cannot tell the two apart. Pitch 60 is C3 in Bitwig's note names. Per-note **pressure is not offered**: in Bitwig 6.1.7 a pressure written through the Controller API does not persist (it was lost again when notes were added, when timbre, pan or gain changed, and on later reads). A clip's length is its loop: change `loop.lengthBeats` to make it longer or shorter. One request may cover at most 16384 grid steps (clip span × `stepsPerBeat`), e.g. 170 beats at 96 steps per beat.
- **bitwig_arrange_launcher_clips** — Record existing launcher clips into the Arranger across exact beat regions, merging contiguous regions. Recording starts at the earliest region and runs at 666 BPM, and one print covers at most 1024 beats. While it records, armed tracks are disarmed and Arranger and Launcher overdub are off, so nothing else gets recorded. Afterwards, and also when the print fails or times out, Bitwig gets back its tempo, loop, overdub, track arms and playhead position.
- **bitwig_cue_markers** — List Arranger cue markers, or create/update a named marker set at exact beat positions with readback verification. New markers are added at the playhead and moved into place, so playback does not jump. If the transport is stopped on an existing marker, the playhead is moved aside for a moment and put back.

### Scenes & launcher

Scene and slot numbers run from 0 to 1023; creating a clip one slot past the last scene adds a new scene for it. Scenes are checked by index and exact current name. Bitwig names an unnamed scene by its position ("Scene 3"), and that name moves with the position when scenes are added or removed, so the name check only protects scenes you have named. Only main tracks are covered; effect tracks' launcher slots are not reached.

- **bitwig_launcher** — Read the clip launcher: every scene (index, name, color, clip count) with its clips (track, name, color, state `playing`, `queued`, `stopQueued`, `stopped`, `recording` or `recordingQueued`), each main track's `stopped` and `stopQueued`, and the transport. Paged with `sceneOffset` and `sceneLimit` (up to 128); `trackIndex` and `trackName` narrow it to one track. A launched clip reads `playing` even while the transport is stopped: it is the clip that plays once the transport runs.
- **bitwig_edit_scene** — Add a scene at the end (`create: true`), duplicate one scene with its clips (`duplicate: true`, the copy lands right after it), and set a scene's `name` and `color`. The new or changed scene is read back, and a duplicate must hold as many clips as its original. A scene color cannot be reset to "no color" through the API: setting Bitwig's default gray `#494949` reads back as `#515151`.
- **bitwig_launch** — `action: "launch"` launches one scene (`sceneIndex`, `sceneName`) or one clip (`trackIndex`, `trackName`, `slotIndex`), with `quantization` (`default`, `none`, `8`, `4`, `2`, `1`, `1/2`, `1/4`, `1/8`, `1/16` bars) and `launchMode` (`default`, `from_start`, `continue_or_from_start`, `continue_or_synced`, `synced`); `default` uses Bitwig's own settings. It succeeds once every clip involved is playing or queued, and refuses empty slots and scenes without clips. Launching starts the transport. `action: "stop"` and `"returnToArrangement"` work on one track or, without a track, on all tracks, and succeed once no clip on them is playing or queued (`stopQueued`, a stop that waits for the bar, counts).

### Devices

- **bitwig_devices** — List the top-level devices on one exact track (up to 32): name, type, plug-in or not, enabled, window open, expanded, remote controls shown, preset name and loaded sample.
- **bitwig_browser_search** — Search Bitwig's browser as it opens at the end of a track's chain, or before one device: devices, Bitwig presets and plug-ins. Narrow it with `location` (an entry of the browser's location column, such as `Devices`, `Presets`, a device name like `Polymer` for its presets, or `System VST 3 Plug-ins` / `System CLAP Plug-ins`), `deviceType` and `category`. `includeFilters: true` also returns every available entry of those three columns.
- **bitwig_insert_device** — Insert one device, preset or plug-in by its exact browser name, at the end of the chain or before one device (`beforeDeviceIndex` plus `beforeDeviceName`). A name with several entries is refused; narrow it with the same filters. Expert alternative: `bitwigId`, `clapId` or `vst3Id`. It succeeds only once the chain shows a new device at the expected position whose name, or preset name, is the requested one; otherwise the reply says what Bitwig inserted.
- **bitwig_insert_sample** — Load a WAV, AIFF or FLAC file by absolute path into a new Sampler on an instrument or hybrid track, and confirm Bitwig reports the sample.
- **bitwig_set_device** — Turn a device on or off, open or close its plug-in window, expand or collapse it, show or hide its remote controls, and pick the remote-controls page shown. Every change is read back.
- **bitwig_delete_device** — Delete one exact device; both track and device names must still match. It succeeds only after Bitwig's device list shows the device gone and every other device in its place.

### Parameters

- **bitwig_device_parameters** — Read one device's eight remote controls of one page (the page shown, or one picked by name or index; the page shown before is restored), its page names, and its full direct parameter list (stable IDs, names, normalized 0–1 values and display text), filterable by `query` and paged.
- **bitwig_set_device_parameters** — Set up to 32 parameters on one device at once, each by direct parameter ID or by remote control (page and control, by name or index), to a normalized value 0–1. Every target is checked before anything is written, every value is read back with its display text, and values Bitwig did not take are listed with what it holds. Direct parameters are written in 1/127 steps; remote controls take the full resolution.

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

**A tool says several tracks "are all named" the same.** The bridge does not use track IDs yet, so Bitwig Agent Bridge finds a track by its position and checks its name. When two tracks share a name, that check can't catch a track that moved, so tools refuse them. `bitwig_tracks` lists the clashing names under `duplicateNames`. Give each track a unique name, in Bitwig or with `bitwig_set_track` and `name`, which still works on duplicates and refuses a name another track already has.

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
- Mutations require exact index-plus-name targets and are refused on mismatch or ambiguity, so a confused agent fails loudly instead of editing the wrong thing.
- The MCP server logs requests locally to `logs/bitwig-agent-bridge.jsonl` so you can audit what an agent did.

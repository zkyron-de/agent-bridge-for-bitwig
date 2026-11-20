# Changelog

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `bitwig_read_clip`, `bitwig_write_clip` and `bitwig_edit_clip` replace `bitwig_clip_notes` and `bitwig_create_note_clip`. They read and write clip name, color and loop, notes with velocity, duration, channel, mute and the per-note expressions timbre, pan and gain (in dB, as Bitwig's Inspector shows it), and work on any grid from 1 to 960 steps per beat, so off-grid timing is kept. `bitwig_edit_clip` adds, changes or deletes single notes and checks that every other note stays as it was. Tool inputs are strict: unknown fields are rejected.

- `bitwig_set_track` replaces `bitwig_set_track_mix` and `bitwig_rename_track`. It sets name, color, volume and pan, mute, solo and arm, and send level, on/off and pre/post mode, on main tracks, effect tracks and the master track, and reads every value back. Volume and send levels are in dB and pan runs from −1 to 1, as Bitwig's mixer shows them.
- `bitwig_tracks` also lists effect tracks and the master track, and gives each track its color, volume in dB, pan and sends.
- `bitwig_browser_search`, `bitwig_set_device` and `bitwig_set_device_parameters`. The browser search filters by the browser's location column (devices, presets, a device's presets, plug-in folders), device type and category, at the end of a chain or before one device. `bitwig_set_device` sets enabled, plug-in window, expanded, remote controls shown and the page shown. `bitwig_set_device_parameters` sets up to 32 parameters per call by direct ID or remote control, checks every target before writing and reads every value back.
- `bitwig_transport` reads and sets, in one call, playback (play, stop, continue, restart), arranger record, tempo, time signature, playhead position (also while playing), arranger loop, metronome and its volume, pre-roll, arranger and launcher overdub, arranger automation write and its mode, and the default launch quantization. Every change is read back; without fields it returns the full transport state.
- `bitwig_actions` searches by category too, pages its results and marks blocked actions. `bitwig_invoke_action` also runs undo and redo (confirmed through Bitwig's undo state) and switches the panel layout (read back). Because Bitwig does not confirm actions, every call returns the project state it saw change. Actions that create, open or close a project, quit Bitwig or answer an open dialog are refused.
- `bitwig_launcher`, `bitwig_edit_scene` and `bitwig_launch` replace `bitwig_clips` and `bitwig_launch_scene`. The launcher read covers every scene and main track at once, with scene names, colors and clip counts and each clip's play state. Scenes can be created, duplicated (with their clips), named and colored. Launches take Bitwig's quantization and launch modes, stop and return to the arrangement work per track or for all tracks, and every launch or stop is confirmed through the slots' play states.
- `bitwig_insert_device` inserts devices, Bitwig presets and plug-ins by exact browser name, or by `bitwigId`, `clapId` or `vst3Id`, at the end of the chain or before one device, and confirms the new device's name or preset. `bitwig_insert_sample` loads a file by path. `bitwig_device_parameters` returns the remote controls of any page together with the direct parameters. Device listings report `expanded` and `remoteControlsVisible`.

### Removed

- `bitwig_set_track_mix` and `bitwig_rename_track` (see `bitwig_set_track`). The track list no longer carries `reference`, `volumeNormalized` or `panNormalized`.
- `bitwig_clip_notes` and `bitwig_create_note_clip` (see Added). Per-note pressure is not offered because Bitwig does not keep a pressure written through the Controller API.
- `bitwig_find_devices`, `bitwig_insert_stock_device`, `bitwig_insert_clap_device`, `bitwig_insert_sample_file`, `bitwig_remote_controls`, `bitwig_selected_device_remote_controls`, `bitwig_set_remote_control`, `bitwig_set_device_parameter` and `bitwig_open_device_window` (see Added). `bitwig_find_samples` and loading a sample by name: Bitwig 6 ignores switching its browser to the Samples tab through the API, so samples load by path only.
- `bitwig_transport`'s `action` field (`status`, `play`, `stop`, `toggle`, `set_tempo`, `set_position`); see Added. Toggle is gone; read the state and pass `playback`.
- `bitwig_clips` and `bitwig_launch_scene` (see Added). Launching a scene no longer forces immediate, from-start launching; pass `quantization: "none"` and `launchMode: "from_start"` for that.
- `bitwig_nest_device` and `bitwig_save_device_preset` (Save to Library needs keyboard input the API cannot give).
- The local plug-in inventory: `bitwig_plugins`, `bitwig_refresh_plugin_index`, `npm run index:plugins` and `src/plugin-index.mjs`. Bitwig's browser lists the installed plug-ins.
- Direct parameter writes no longer compensate a plug-in that reports the value divided by 16384, and the MatrixBrute special case is gone; the reply names the problem instead.

- The Next.js dashboard (`dashboard/`), its local status service (`src/dashboard-server.mjs`, `src/local-http.mjs`), the macOS WebKit wrapper (`macos/`), the CoreMIDI auto-detect helper (`native/`), the double-click installer, `PORTING.md`, and the launchd agents that started them. No MCP tool used any of them.
- The controller script no longer declares MIDI ports or a discovery pair, so Bitwig no longer auto-adds it; add it once in Settings → Controllers.

### Changed

- The bridge reaches the first 64 main tracks and 16 effect tracks (was 128 and 32), with 8 sends per track, and 32 devices per track (was 64).
- Renamed the project to **Bitwig Agent Bridge**: package and MCP server name `bitwig-agent-bridge`, controller script `controller/BitwigAgentBridge.control.js` (vendor and name "Bitwig Agent Bridge", new extension UUID), install folder `Controller Scripts/Bitwig Agent Bridge/`, wire protocol `bitwig-agent-bridge/1`, environment variables `BITWIG_AGENT_BRIDGE_HOST`, `_PORT` and `_TOKEN`, and request log `logs/bitwig-agent-bridge.jsonl`. The UDP port stays 50701. An installed Control Deck script does not talk to the renamed server; remove it from Bitwig and add Bitwig Agent Bridge instead.
- The controller uses the non-deprecated five-argument `defineController` with an author.
- The controller now targets Controller API 25 (Bitwig Studio 6, tested with 6.1.7) instead of 18. `bitwig_status` reports the requested and the host API version. The deprecated `Device.isParameterPageSectionVisible` is no longer used, so the remote-controls replies drop `parameterListVisible`, and cue markers are positioned with `SettableBeatTimeValue.set`.
- `npm run setup` now only installs dependencies, creates the bridge secret, and installs the controller script. `--skip-build` and `--skip-agents` are gone; `--skip-install` skips `npm install`.

## [1.2.1] - 2026-10-28

Fixes security advisories in the dashboard and MCP server dependencies, lists the agents Control Deck works with in the docs and on the Connect page, and clears the dashboard lint errors.

### Security

- Updated Next.js to 16.4.1, which fixes GHSA-2464-fhr4-w9xw, GHSA-673q-mjm6-r5xr and GHSA-p3m5-59mp-jv5r (CVE-2026-94482) in the dashboard.
- Updated the MCP server's dependencies body-parser (2.4.0), fast-uri (3.1.9), ip-address (10.7.5) and qs (6.17.1), which fixes GHSA-27r3-jxmh-p828, GHSA-w74x-v6f9-j3xg, GHSA-xhq7-xmqj-769h, GHSA-wjr9-j795-jxcr, GHSA-333x-w4r6-6crp, GHSA-rxp7-6hxx-x8q5 and GHSA-6pq8-jhm2-2vcw.
- Updated zod to 4.6.7 in the MCP server, which fixes GHSA-mrhx-c7xc-m3w5. Tool inputs validate the same way as before.
- Updated zod to 4.6.7 in the dashboard's lint tooling, which fixes GHSA-mrhx-c7xc-m3w5 there too.

### Changed

- README and HELP list the agents Control Deck works with: Claude Desktop, Claude Code, Cursor, OpenAI Codex, Grok CLI, Windsurf, Cline, and GitHub Copilot in VS Code, plus any MCP-compatible agent that can run a local server, with setup snippets for each.
- The dashboard's Connect page lists the same agents, with a snippet for each that uses your real install path.
- Docs and the setup script use SI wording.

### Fixed

- Fixed the dashboard lint errors. Saved preferences are now read as an external store, and the Settings draft and default format follow saved changes without effects. The dashboard behaves the same as before.

## [1.2.0] - 2026-10-28

Makes the bridge safer and more exact: it ignores requests with the wrong auth token, track and device tools check Bitwig's lists before reporting success, launcher tools reach every scene, and your selection and transport settings come back after a tool runs. Tested live in Bitwig Studio 6.1.3.

### Security

- The bridge no longer replies to requests with the wrong auth token, including from its error path. It shows a popup the first time and logs the 1st and every 100th ignored request.

### Changed

- `bitwig_actions` now matches case-insensitively after trimming the query, and reports `totalActions` and `matched` alongside up to 100 actions.
- `bitwig_status` reports `audioEngineActive`.

### Fixed

- A reply too large for one message could silently never arrive, and the client only saw a timeout. The bridge now checks every reply against a 60,000-byte limit (the same limit the client uses for requests) and sends a clear error instead. If Bitwig cannot send a reply at all, the bridge logs it as an error and tries to tell the client with a short error reply.
- After a request timed out or failed, its remaining delayed steps kept running. They could keep changing Bitwig, and an error in one of them could fail the next, unrelated request. Those steps are now dropped once their request has been answered.
- Device, sample and clip tools selected their track (and device) in Bitwig and left it that way, so your selection moved every time an agent worked. The selection you had now comes back when the tool finishes, whether it succeeded or failed.
- `bitwig_save_device_preset` pressed Enter by default about a second after opening Save to Library, whether or not the dialog had appeared, so the key could land somewhere else in Bitwig. The dialog now stays open by default. With `confirm: true`, Enter is pressed only if the same device is still selected, and the reply shows the device's preset name before and after.
- `bitwig_track_meters` kept peak maxima by track position, so after tracks were added, deleted or moved, a track could report another track's peak. A maximum now belongs to the track it was measured on and starts again when a different track takes that position.
- Tools identified a track by its index and checked its name, but two tracks with the same name could pass that check after the tracks moved. Track tools now refuse a track whose name another track shares and ask for a rename. `bitwig_rename_track` still works on duplicates, refuses a name that another track already has, and `bitwig_tracks` reports clashing names under `duplicateNames`. Permanent track IDs need controller API 20 and are planned for a later version.
- `bitwig_create_track` created the track first and only then checked the 128-track limit, so a 129th track was created and reported as a failure. It now refuses before creating anything.
- `bitwig_create_track` assumed the new track was the last one in the main track list. Effect tracks never appear there, so creating one always reported an error after the track was made, and a track Bitwig placed elsewhere could leave the wrong track renamed. The bridge now compares the track list (or the effect track list) before and after, names the track that was added, and checks the name took. If the new track cannot be told apart from a neighbour with the same name, it is left unnamed and the tool says so.
- `bitwig_delete_track` and `bitwig_delete_device` reported success without checking anything. They now succeed only once Bitwig's list shows the item gone and the rest in their original order. A deleted group reports how many tracks went with it.
- `bitwig_cue_markers` upsert moved the playhead to a spot past the last marker for every new marker and then jumped back, which was audible during playback. New markers are now added at the current playhead and moved into place, so the playhead stays where it is. The only exception is a stopped transport with a marker already under the playhead: the bridge then moves the playhead aside for the add and puts it back before replying.
- Launcher tools are no longer limited to the first eight scenes. `bitwig_create_note_clip`, `bitwig_clip_notes` and `bitwig_launch_scene` accept slots up to 1023 and scroll Bitwig's scene window to reach them, and `bitwig_clips` lists clips in every scene.
- `bitwig_create_note_clip` can add a clip one slot past the last scene; Bitwig creates the scene for it.
- `bitwig_arrange_launcher_clips` disarms armed tracks and turns off Arranger and Launcher overdub while it records, so live input and overdub no longer land in the print. Both are put back afterwards.
- `bitwig_arrange_launcher_clips` starts recording at the earliest requested region instead of beat 0, and refuses a print longer than 1024 beats, which could not finish inside its time limit.
- `bitwig_arrange_launcher_clips` stops with an error as soon as the transport stops mid-print, instead of waiting out its 115-second limit.
- When `bitwig_arrange_launcher_clips` fails or times out, Bitwig gets back its tempo, loop, overdub, track arms and playhead position, and the tracks return to the Arranger. This now happens as soon as the request ends, without waiting for the recording loop to notice. The playhead is moved back a second time once the stop lands, because Bitwig can drop a move made while the transport is still stopping.

### Removed

- The bridge methods `audio_engine`, `restart_bridge`, `selection_state` and `list_actions`. No MCP tool, dashboard view or script used them. `list_actions` was a second copy of the action search and is now the only one, behind `bitwig_actions`. Engine on/off switching could cut audio during a session, so only the read-only engine state remains, in `bitwig_status`. `restart_bridge` could not help a stuck bridge because it waited in the same request queue, and `selection_state` repeated what `bitwig_status` and `bitwig_devices` already report.
- Unused copy-and-paste arrangement code in the controller script, and the Bitwig actions only it used.

## [1.1.0] - 2026-10-28

Adds note read-back for launcher clips and checks every note clip write against what Bitwig reports. Tested in Bitwig Studio 6.1.3 with 16- and 128-beat clips, grids down to 1/128 notes, and notes on several MIDI channels.

### Added

- `bitwig_clip_notes` reads every note in a launcher clip, with start, pitch, velocity, length, MIDI channel and mute state, across all 16 channels and the full clip length.

### Changed

- `bitwig_create_note_clip` re-reads the clip after writing and reports an error if any note is missing, changed or extra. The result now includes `notesVerified`.
- Note clip writes can take up to 120 seconds, up from 30, to leave room for the read-back on long clips.
- `bitwig_arrange_launcher_clips` keeps notes on every MIDI channel when it copies clip notes, not only channel 1.

## [1.0.2] - 2026-10-11

### Fixed

- Device tools refused every track inside a group with "Bitwig did not select the requested track", even though Bitwig had selected it. The check compared track positions, which Bitwig counts within the group for the selected track but across the whole project in the track list. The bridge now asks Bitwig whether the selected track is the requested one. Tested with the Ferrous Rhythm demo project in Bitwig Studio 6.3.

## [1.0.1] - 2026-10-10

Fixes a case where the bridge could stop responding until Bitwig was restarted, and reports tempo, mixer and parameter changes as errors when Bitwig does not confirm them. Tested with Bitwig Studio 6.1.3.

### Fixed

- The bridge no longer stops responding after an internal error. One failed step could leave it busy until the controller script was restarted, so every later request timed out or was refused as busy.
- Requests that run too long inside Bitwig now end with an error at their time limit, and requests the client has already stopped waiting for are skipped.
- Recording launcher clips into the Arranger restores the project's own tempo afterwards. It previously set 122 BPM unless `restoreTempo` was given.
- Tempo changes are read back from Bitwig and reported as an error, with the actual tempo, when Bitwig did not apply them.
- Volume, pan, mute, solo and arm changes are read back the same way.
- Parameter and Remote Control changes that Bitwig does not confirm are reported as errors showing the requested and actual values. They previously returned success with `verifiedByBitwigReadback: false`.
- Large note clips no longer fail with a misleading "make sure Control Deck Bridge is enabled" timeout. Requests larger than macOS's default 9 KB message size now go through, and a request too large for one message is refused straight away with a clear explanation.

### Changed

- Note clips are limited to 750 notes per request. The previous limit of 4,096 could never fit in a single message to Bitwig.
- `restoreTempo` on `bitwig_arrange_launcher_clips` is now optional.

### Security

- The status service only answers requests addressed to `localhost` or `127.0.0.1`, which stops web pages from reaching it through DNS rebinding, and it no longer sends a fixed fallback CORS origin.
- Updated the MCP SDK to 1.32.1, which fixes advisory GHSA-6qxp-vccf-f47h, and Next.js to 16.4.0. This clears the npm audit advisories in the code that ships.

## [1.0.0] - 2026-08-17

First release of Bitwig Control Deck, a local MCP bridge that lets an AI agent control Bitwig Studio 6 on your Mac and checks its changes against what Bitwig reports. It needs macOS 13 or newer and Node.js 20 or newer.

### Added

- One-step installer, `Install Control Deck.command`, that sets up the bridge, the Bitwig controller extension and the background services, then opens a connection guide. It is safe to run again at any time.
- Transport control for play, stop, tempo and playback position, plus Arranger cue markers placed at exact beat positions.
- Track tools to list, create, rename and delete tracks, set volume, pan, mute, solo and arm, and read peak meters. Renaming and deleting need the track's exact current name, so a shifted track list cannot redirect a change.
- Clip tools to write launcher MIDI clips with their full note content, launch scenes, and record existing launcher clips into the Arranger at exact beat positions.
- Device tools that search Bitwig's Devices browser and insert one exact device, refusing ambiguous names. Stock devices and CLAP plug-ins can also be inserted by stable ID, and devices can be nested, deleted, opened in their own window or saved through Bitwig's Save to Library flow.
- Parameter control for native and third-party devices: read the full parameter list with stable IDs, set a value by ID or through a Remote Controls page, and get back the value Bitwig reports after the change.
- Sample loading from Bitwig's Samples browser, or from a WAV, AIFF or FLAC file, into a new Sampler device on an exact track.
- Action tools to search Bitwig's built-in action list and run one action by its exact ID.
- Local dashboard at `http://127.0.0.1:50703` showing bridge health, the current session, loaded devices and a searchable inventory of installed VST3, VST2, Audio Unit and CLAP plug-ins. Its Connect page has copy-paste setup guides for Claude Code, Codex, Cursor, VS Code, Gemini CLI, local LLM setups and other MCP clients.
- Local operation: the status service and dashboard listen on this Mac only, and every request to the Bitwig bridge must carry a secret generated for your install.

[Unreleased]: https://github.com/remymazmanian/bitwig-control-deck/compare/v1.2.1...HEAD
[1.2.1]: https://github.com/remymazmanian/bitwig-control-deck/compare/v1.2.0...v1.2.1
[1.2.0]: https://github.com/remymazmanian/bitwig-control-deck/releases/tag/v1.2.0
[1.1.0]: https://github.com/remymazmanian/bitwig-control-deck/releases/tag/v1.1.0
[1.0.2]: https://github.com/remymazmanian/bitwig-control-deck/releases/tag/v1.0.2
[1.0.1]: https://github.com/remymazmanian/bitwig-control-deck/releases/tag/v1.0.1
[1.0.0]: https://github.com/remymazmanian/bitwig-control-deck/releases/tag/v1.0.0

# Tool reference

All 24 tools follow the same contract:

- **Exact targets.** Tracks by their id, which survives renaming and moving; devices, scenes and clips by index plus their current name, so stale names are refused.
- **Strict inputs.** Unknown fields are rejected.
- **Read back.** A write succeeds only once Bitwig shows the requested value; otherwise the reply lists what Bitwig holds.

The bridge reaches the first 64 main tracks, 16 effect tracks, 8 sends per track, 32 top-level devices per track and 1024 scenes. Each reply from Bitwig is at most 60,000 bytes; listings are paged with `offset` and `limit` where they can grow.

## Status & session

### bitwig_status

Check Bitwig Agent Bridge, Bitwig, the current project, transport, current selection, and whether Bitwig's audio engine is on.
### bitwig_actions

Search Bitwig's action registry (about 780 menu and shortcut commands) by id, name, menu text or category, ignoring case; `category` narrows it to one category id (`includeCategories: true` lists them), `offset` and `limit` (up to 200) page it. Ids are stable and English, names and menu text follow Bitwig's display language. Blocked actions are listed with the reason.
### bitwig_invoke_action

Run exactly one of: `actionId` (an exact id from `bitwig_actions`), `command` (`undo` or `redo`) or `panelLayout` (`ARRANGE`, `MIX`, `EDIT`). Bitwig does not confirm actions, so the reply lists what the bridge saw change in tracks, scenes, selection, transport, undo state and panel layout (`observedChanges`); view, selection and editor actions usually show no change there. Undo and redo are refused when Bitwig has nothing to undo or redo, and confirmed through its undo state; the panel layout is read back. Actions that create, open or close a project, quit Bitwig, or answer an open dialog (`New`, `Open`, `Close`, `Quit`, `new_from_template`, `Dialog: Yes`, `Dialog: No`, `Dialog: OK`) are refused; do those in Bitwig yourself.
### bitwig_transport

Without fields, read the full transport: playing, arranger record, tempo, time signature, playhead and play-start position, arranger loop, metronome (on/off, volume with display text), pre-roll, arranger and launcher overdub, arranger automation write and its mode, and the default launch quantization. With fields, change any of them in one call: `playback` (`play`, `stop`, `continue`, `restart`), `arrangerRecord`, `tempo` (20–666 BPM), `timeSignature` (`7/8`), `positionBeats`, `loop` (`enabled`, `startBeats`, `lengthBeats`), `metronome` (`enabled`, normalized `volume`), `preRoll` (`none`, `one_bar`, `two_bars`, `four_bars`), `arrangerOverdub`, `launcherOverdub`, `automationWrite` (`arranger`, `mode`: `latch`, `touch`, `write`) and `defaultLaunchQuantization`. Settings go first, then the position, then record and playback; everything is read back, and a value Bitwig refuses (such as the time signature 7/3) fails with what it holds.

Measured in Bitwig 6.1.7: setting the position also moves the play-start marker, and works while playing too (the playhead jumps). Stopping turns launcher overdub off, so `playback: "stop"` with `launcherOverdub: true` is refused. Arranger record switches arranger automation write on and off with it, in Bitwig's own transport bar too. `restart` while playing jumps back to the play start; while stopped it started at beat 0.
### bitwig_track_meters

Read peak signal activity captured for every track, or reset the captured maxima before a playback test. When tracks are added, deleted or moved, a track that lands on a new position starts a fresh maximum instead of inheriting the previous track's peak.

## Tracks

### bitwig_tracks

List the main tracks (up to 64), effect tracks (up to 16) and the master track: `id`, index, name, type, color, mute, solo, `volumeDb` (`null` is −∞), `pan`, and for main tracks `position`, `arm` and `sends` (index, target effect track, `levelDb`, `enabled`, `mode`).
### bitwig_create_track

Create an empty track at the end of its list without opening the browser or loading a preset. The bridge finds the track Bitwig added by comparing the track ids before and after, then names it, checks the name and returns its `id`. Effect tracks are reported with their `effectTrackIndex` in the effect track list. With 64 main tracks (or 16 effect tracks) it refuses before creating anything, because the bridge could not reach the new track.
### bitwig_set_track

Change one track (main, effect or master, by `trackId`): `name`, `color` (`#RRGGBB`), `volumeDb` (−120 to +6 dB), `pan` (−1 = 100 % left, 1 = 100 % right), `mute`, `solo`, `arm`, and `sends` (`levelDb` −120 to 0 dB, `enabled`, `mode` AUTO/PRE/POST; each send names its target effect track as a safety check). Arm and sends are for main tracks only. Only the given fields change, every one is read back, and a value Bitwig did not take fails the call with what it holds. Setting a send level switches the send on in Bitwig, so `enabled: false` is applied after the level.
### bitwig_delete

Delete one item, checked before and confirmed after: `what: "track"` (main or effect track by `trackId`; the master cannot be deleted; a group takes its tracks with it and `removedCount` says how many went), `"device"` (`trackId`, `deviceIndex`, `deviceName`), `"scene"` (`sceneIndex`, `sceneName`, with its clips; the scene after it must move up) or `"clip"` (`trackId`, `slotIndex`, `clipName`; the slot must be empty afterwards). Fields that do not belong to the kind are refused. Bitwig's undo (`bitwig_invoke_action` with `command: "undo"`) brings a deleted item back.

## Clips & arrangement

### bitwig_read_clip

Read one launcher clip: name, color, loop (`enabled`, `startBeats`, `lengthBeats`), play state, and every note with `beat`, `pitch`, `channel`, `velocity`, `duration`, `timbre`, `pan`, `gainDb` and `muted`. Notes outside the loop are read too. `stepsPerBeat` (1–960, default 4) sets the read grid: a note that starts between two steps comes back at the step it starts in, so use 96 or more to keep off-grid timing. Long clips are paged with `offset` and `limit` (up to 300 notes per reply).
### bitwig_write_clip

Create a launcher MIDI clip (or replace one with `replace: true`) and write its complete content: `name`, `lengthBeats`, optional `loop` and `color` (`#RRGGBB`), and `notes`. Every note start must lie on the `stepsPerBeat` grid, so fine timing is written exactly. The whole clip is then read back; a missing, changed or extra note, or a property Bitwig did not take, fails the call and names the first five differences. If Bitwig stops part-way, the reply says what the clip holds now.
### bitwig_edit_clip

Change an existing clip without rewriting it. `setNotes` adds a note or changes only the given fields of the note at that `beat`/`pitch`/`channel`; `removeNotes` deletes single notes. `name`, `loop` and `color` can change too. Mistakes in the request (removing a note that isn't there, setting and removing the same note, a new note without a duration) are refused before anything changes. The whole clip is read before and after, and every untouched note must come back unchanged.

Note fields and ranges: `velocity` 1–127 (new notes default to 100; Bitwig's Inspector shows it as a percentage, 100 = 78.7 %), `duration` in beats, `timbre` −1…1 and `pan` −1…1 (the Inspector shows ±100 %), `gainDb` −100…+18 dB (new notes get 0 dB; use `muted` for silence), `muted`. A note whose gain was never set (for example one drawn by hand) reads back as `gainDb: null`: it plays at 0 dB, but the Controller API reports the same value as for −∞, so the bridge cannot tell the two apart. Pitch 60 is C3 in Bitwig's note names. Per-note **pressure is not offered**: in Bitwig 6.1.7 a pressure written through the Controller API does not persist (it was lost again when notes were added, when timbre, pan or gain changed, and on later reads). A clip's length is its loop: change `loop.lengthBeats` to make it longer or shorter. One request may cover at most 16384 grid steps (clip span × `stepsPerBeat`), e.g. 170 beats at 96 steps per beat.
### bitwig_arrange_launcher_clips

Record existing launcher clips into the Arranger across exact beat regions, merging contiguous regions. Recording starts at the earliest region and runs at 666 BPM, and one print covers at most 1024 beats. While it records, armed tracks are disarmed and Arranger and Launcher overdub are off, so nothing else gets recorded. Afterwards, and also when the print fails or times out, Bitwig gets back its tempo, loop, overdub, track arms and playhead position.
### bitwig_cue_markers

List Arranger cue markers, or create/update a named marker set at exact beat positions with readback verification. New markers are added at the playhead and moved into place, so playback does not jump. If the transport is stopped on an existing marker, the playhead is moved aside for a moment and put back.

## Scenes & launcher

Scene and slot numbers run from 0 to 1023; creating a clip one slot past the last scene adds a new scene for it. Scenes are checked by index and exact current name. Bitwig names an unnamed scene by its position ("Scene 3"), and that name moves with the position when scenes are added or removed, so the name check only protects scenes you have named. Only main tracks are covered; effect tracks' launcher slots are not reached.

### bitwig_launcher

Read the clip launcher: every scene (index, name, color, clip count) with its clips (track, name, color, state `playing`, `queued`, `stopQueued`, `stopped`, `recording` or `recordingQueued`), each main track's `stopped` and `stopQueued`, and the transport. Paged with `sceneOffset` and `sceneLimit` (up to 128); `trackId` narrows it to one track; clips and tracks carry their track id. A launched clip reads `playing` even while the transport is stopped: it is the clip that plays once the transport runs.
### bitwig_edit_scene

Add a scene at the end (`create: true`), duplicate one scene with its clips (`duplicate: true`, the copy lands right after it), and set a scene's `name` and `color`. The new or changed scene is read back, and a duplicate must hold as many clips as its original. A scene color cannot be reset to "no color" through the API: setting Bitwig's default gray `#494949` reads back as `#515151`.
### bitwig_launch

`action: "launch"` launches one scene (`sceneIndex`, `sceneName`) or one clip (`trackId`, `slotIndex`), with `quantization` (`default`, `none`, `8`, `4`, `2`, `1`, `1/2`, `1/4`, `1/8`, `1/16` bars) and `launchMode` (`default`, `from_start`, `continue_or_from_start`, `continue_or_synced`, `synced`); `default` uses Bitwig's own settings. It succeeds once every clip involved is playing or queued, and refuses empty slots and scenes without clips. Launching starts the transport. `action: "stop"` and `"returnToArrangement"` work on one track or, without a track, on all tracks, and succeed once no clip on them is playing or queued (`stopQueued`, a stop that waits for the bar, counts).

## Devices

### bitwig_devices

List the top-level devices on one exact track (up to 32): name, type, plug-in or not, enabled, window open, expanded, remote controls shown, preset name and loaded sample.
### bitwig_browser_search

Search Bitwig's browser as it opens at the end of a track's chain, or before one device: devices, Bitwig presets and plug-ins. Narrow it with `location` (an entry of the browser's location column, such as `Devices`, `Presets`, a device name like `Polymer` for its presets, or `System VST 3 Plug-ins` / `System CLAP Plug-ins`), `deviceType` and `category`. `includeFilters: true` also returns every available entry of those three columns.
### bitwig_insert_device

Insert one device, preset or plug-in by its exact browser name, at the end of the chain or before one device (`beforeDeviceIndex` plus `beforeDeviceName`). A name with several entries is refused; narrow it with the same filters. Expert alternative: `bitwigId`, `clapId` or `vst3Id`. It succeeds only once the chain shows a new device at the expected position whose name, or preset name, is the requested one; otherwise the reply says what Bitwig inserted.
### bitwig_insert_sample

Load a WAV, AIFF or FLAC file by absolute path into a new Sampler on an instrument or hybrid track, and confirm Bitwig reports the sample.
### bitwig_set_device

Turn a device on or off, open or close its plug-in window, expand or collapse it, show or hide its remote controls, and pick the remote-controls page shown. Every change is read back.

## Parameters

### bitwig_device_parameters

Read one device's eight remote controls of one page (the page shown, or one picked by name or index; the page shown before is restored), its page names, and its full direct parameter list (stable IDs, names, normalized 0–1 values and display text), filterable by `query` and paged.
### bitwig_set_device_parameters

Set up to 32 parameters on one device at once, each by direct parameter ID or by remote control (page and control, by name or index), to a normalized value 0–1. Every target is checked before anything is written, every value is read back with its display text, and values Bitwig did not take are listed with what it holds. Direct parameters are written in 1/127 steps; remote controls take the full resolution.

See [Limitations](limitations.md) for what the Controller API cannot do and Bitwig behavior the tools work with.

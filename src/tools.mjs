// The MCP tools of Agent Bridge for Bitwig: their names, descriptions and strict
// input schemas, and the controller method each one calls. Kept apart from
// the stdio server so tests can inspect the registry without starting it.
import { z } from "zod";

// Tracks are addressed by Bitwig's channel id, which stays the same when a
// track is renamed or moved.
const trackId = z.string().uuid().describe("Track id from bitwig_tracks; it stays the same when the track is renamed or moved");
const trackSelector = { trackId };
const deviceSelector = {
  ...trackSelector,
  deviceIndex: z.number().int().nonnegative().describe("Zero-based device index returned by bitwig_devices"),
  deviceName: z.string().min(1).describe("Exact device name returned by bitwig_devices; used as a safety check")
};

// Clip and note schemas shared by the clip tools. Limits mirror the controller
// (MAX_STEPS_PER_BEAT, MAX_CLIP_BEATS, NOTE_EXPRESSIONS, MAX_NOTES_PER_REPLY).
const slotIndex = z.number().int().min(0).max(1023).default(0).describe("Launcher slot (scene) index, 0-based");
const stepsPerBeat = z.number().int().min(1).max(960).default(4)
  .describe("Grid resolution for note starts in steps per beat (4 = 1/16 at 4/4, 96 for fine timing). Every note start must lie on this grid. Clip span × stepsPerBeat may not exceed 16384");
const clipColor = z.string().regex(/^#[0-9a-fA-F]{6}$/).describe("Clip color as #RRGGBB");
const clipLoop = z.strictObject({
  enabled: z.boolean().optional(),
  startBeats: z.number().min(0).max(512).optional(),
  lengthBeats: z.number().positive().max(512).optional()
}).describe("Clip loop. Values not given are left as they are");
const noteFields = {
  beat: z.number().min(0).describe("Start in beats from the clip start; must lie on the stepsPerBeat grid"),
  pitch: z.number().int().min(0).max(127),
  channel: z.number().int().min(0).max(15).default(0),
  velocity: z.number().int().min(1).max(127).optional().describe("1-127; new notes default to 100"),
  timbre: z.number().min(-1).max(1).optional().describe("Per-note timbre expression, -1 to 1"),
  pan: z.number().min(-1).max(1).optional().describe("Per-note pan expression, -1 (left) to 1 (right)"),
  gainDb: z.number().min(-100).max(18).optional().describe("Per-note gain in dB, -100 to +18 (Bitwig's Inspector 'Lautstärke'/'Gain'). New notes default to 0 dB. Use muted for silence"),
  muted: z.boolean().optional()
};
const newNote = z.strictObject({ ...noteFields, duration: z.number().positive().describe("Length in beats") });
const noteChange = z.strictObject({ ...noteFields, duration: z.number().positive().optional().describe("Length in beats; required for a new note") });
const noteRef = z.strictObject({ beat: noteFields.beat, pitch: noteFields.pitch, channel: noteFields.channel });

export function registerTools(server, call) {
  server.registerTool("bitwig_status", {
    description: "Check the bridge, Bitwig, the current project, transport, current selection, and whether Bitwig's audio engine is on.",
    inputSchema: z.strictObject({})
  }, async () => call("status"));

  server.registerTool("bitwig_actions", {
    description: "Search Bitwig's action registry (menu and shortcut commands) by id, name, menu text or category. Ids are stable and English; names follow Bitwig's display language. Blocked actions (closing or replacing the project, quitting, answering dialogs) are listed with the reason.",
    inputSchema: z.strictObject({
      query: z.string().max(120).default("").describe("Case-insensitive part of id, name, menu text or category"),
      category: z.string().min(1).optional().describe("Exact category id, e.g. arranger, clip_launcher, panel_management"),
      offset: z.number().int().nonnegative().default(0),
      limit: z.number().int().min(1).max(200).default(50),
      includeCategories: z.boolean().default(false).describe("Also list every category id with its name and action count")
    })
  }, async args => call("find_actions", args));

  server.registerTool("bitwig_invoke_action", {
    description: "Run exactly one of: an action by exact id from bitwig_actions; command undo or redo (refused when there is nothing to undo or redo, confirmed through Bitwig's undo state); or panelLayout ARRANGE, MIX or EDIT (read back). Bitwig does not confirm actions, so the reply lists the project state the bridge saw change (tracks, scenes, selection, transport, undo state, panel layout).",
    inputSchema: z.strictObject({
      actionId: z.string().min(1).max(160).optional(),
      command: z.enum(["undo", "redo"]).optional(),
      panelLayout: z.enum(["ARRANGE", "MIX", "EDIT"]).optional()
    })
  }, async args => call("invoke_action", args, 15000));

  server.registerTool("bitwig_transport", {
    description: "Read the transport (no fields), or change it: playback, arranger record, tempo, time signature, playhead position, arranger loop, metronome, pre-roll, overdub, automation write and default launch quantization. Settings are applied first, then position, then record and playback; every change is read back and the reply is the full transport state.",
    inputSchema: z.strictObject({
      playback: z.enum(["play", "stop", "continue", "restart"]).optional().describe("play starts, continue resumes from the playhead, restart jumps back to the play start while playing (Bitwig 6.1.7 started at beat 0 when stopped). Stopping also turns launcher overdub off"),
      arrangerRecord: z.boolean().optional().describe("Arranger record; while playing this records onto armed tracks. Bitwig switches arranger automation write along with it"),
      tempo: z.number().min(20).max(666).optional().describe("BPM"),
      timeSignature: z.string().regex(/^\d{1,2}\/\d{1,2}$/).optional().describe("e.g. 4/4, 6/8, 7/8"),
      positionBeats: z.number().min(0).max(1000000).optional().describe("Playhead position in beats (quarter notes) from the project start; also moves the play start marker. Works while playing too"),
      loop: z.strictObject({
        enabled: z.boolean().optional(),
        startBeats: z.number().min(0).max(1000000).optional(),
        lengthBeats: z.number().positive().max(1000000).optional()
      }).optional().describe("Arranger loop"),
      metronome: z.strictObject({
        enabled: z.boolean().optional(),
        volume: z.number().min(0).max(1).optional().describe("Normalized 0-1; the reply shows Bitwig's display value")
      }).optional(),
      preRoll: z.enum(["none", "one_bar", "two_bars", "four_bars"]).optional(),
      arrangerOverdub: z.boolean().optional(),
      launcherOverdub: z.boolean().optional(),
      automationWrite: z.strictObject({
        arranger: z.boolean().optional().describe("Arranger automation write on or off"),
        mode: z.enum(["latch", "touch", "write"]).optional()
      }).optional(),
      defaultLaunchQuantization: z.enum(["none", "8", "4", "2", "1", "1/2", "1/4", "1/8", "1/16"]).optional()
    })
  }, async args => call("transport", args, 15000));

  server.registerTool("bitwig_cue_markers", {
    description: "List Arranger cue markers, or create/update a named marker set at exact beat positions with Bitwig readback verification.",
    inputSchema: z.strictObject({
      action: z.enum(["list", "upsert"]).default("list"),
      markers: z.array(z.strictObject({
        name: z.string().min(1).max(120),
        positionBeats: z.number().nonnegative()
      })).min(1).max(64).optional()
    })
  }, async args => call("cue_markers", args, 30000));

  server.registerTool("bitwig_tracks", {
    description: "List the project's main tracks (up to 64), effect tracks (up to 16) and the master track with id, index, name, type, color, mute, solo, volumeDb (null = -inf), pan (-1 left to 1 right) and, for main tracks, arm and sends (index, target effect track name, levelDb, enabled, mode). Other tools take the id as trackId. Tracks may share a name; Bitwig numbers default names (\"Inst 2\") by position.",
    inputSchema: z.strictObject({})
  }, async () => call("list_tracks"));

  server.registerTool("bitwig_track_meters", {
    description: "Read peak signal activity captured for every Bitwig track, or reset the captured maxima before a playback test.",
    inputSchema: z.strictObject({
      action: z.enum(["read", "reset"]).default("read"),
      resetAfterRead: z.boolean().default(false)
    })
  }, async args => call("track_meters", args));

  server.registerTool("bitwig_create_track", {
    description: "Create an empty instrument, audio or effect track at the end of its list, without opening the browser or loading a preset, name it and return it with its id. Effect tracks live in a separate list and come back with effectTrackIndex.",
    inputSchema: z.strictObject({
      kind: z.enum(["instrument", "audio", "effect"]),
      name: z.string().min(1).max(120).describe("Track name")
    })
  }, async args => call("create_track", args));

  server.registerTool("bitwig_set_track", {
    description: "Change one track (main, effect or master, by id): name, color, volume, pan, mute, solo, arm and send levels. Only the given fields change; every one is read back from Bitwig, and the call fails with the exact differences if Bitwig holds something else.",
    inputSchema: z.strictObject({
      ...trackSelector,
      name: z.string().min(1).max(120).optional().describe("New name"),
      color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional().describe("Track color as #RRGGBB"),
      volumeDb: z.number().min(-120).max(6).optional().describe("Fader level in dB, -120 to +6; use mute for silence"),
      pan: z.number().min(-1).max(1).optional().describe("-1 is 100 % left, 0 center, 1 is 100 % right"),
      mute: z.boolean().optional(),
      solo: z.boolean().optional(),
      arm: z.boolean().optional().describe("Record arm; main tracks only"),
      sends: z.array(z.strictObject({
        sendIndex: z.number().int().min(0).max(7),
        sendName: z.string().min(1).describe("Exact name of the effect track this send goes to, as bitwig_tracks lists it; a safety check"),
        levelDb: z.number().min(-120).max(0).optional().describe("Send level in dB, -120 to 0"),
        enabled: z.boolean().optional().describe("Send on or off. Setting a level alone switches a send on"),
        mode: z.enum(["AUTO", "PRE", "POST"]).optional().describe("Pre- or post-fader; AUTO follows the effect track's setting")
      })).max(8).optional().describe("Main tracks only")
    })
  }, async args => call("set_track", args));

  server.registerTool("bitwig_devices", {
    description: "List the top-level devices on one exact track (up to 32): index, exact name, type, plug-in or not, enabled, window open, expanded, remote controls shown, preset name and loaded sample.",
    inputSchema: z.strictObject(trackSelector)
  }, async args => call("list_devices", args));

  // Where a new device goes: the end of the chain, or right before one device.
  const insertBefore = {
    beforeDeviceIndex: z.number().int().nonnegative().optional().describe("Insert right before this device (index from bitwig_devices); default is the end of the chain"),
    beforeDeviceName: z.string().min(1).optional().describe("Exact name of that device; required with beforeDeviceIndex as a safety check")
  };
  const browserFilters = {
    location: z.string().min(1).optional().describe("Exact entry of the browser's location column, e.g. 'Devices', 'Presets', a device name such as 'Polymer' for its presets, or a plug-in folder such as 'System VST 3 Plug-ins' or 'System CLAP Plug-ins'"),
    deviceType: z.string().min(1).optional().describe("Exact device-type filter entry as Bitwig shows it (localized, e.g. 'Instrument', 'Audioeffekt')"),
    category: z.string().min(1).optional().describe("Exact category filter entry, e.g. 'Bass'")
  };

  server.registerTool("bitwig_browser_search", {
    description: "Search Bitwig's browser as it opens at a track's insertion point (end of chain, or before one device): devices, Bitwig presets and plug-ins, narrowed by location, device type and category. Returns entry names for bitwig_insert_device. Bitwig offers what fits that insertion point (an empty instrument track lists instruments). Samples cannot be reached through the browser; use bitwig_insert_sample with a file path.",
    inputSchema: z.strictObject({
      ...trackSelector,
      ...insertBefore,
      ...browserFilters,
      query: z.string().default("").describe("Case-insensitive part of the name; empty lists everything after the filters"),
      offset: z.number().int().nonnegative().default(0),
      limit: z.number().int().min(1).max(200).default(50),
      includeFilters: z.boolean().default(false).describe("Also return every available location, device type and category entry")
    })
  }, async args => call("browser_search", args, 60000));

  server.registerTool("bitwig_insert_device", {
    description: "Insert one device, Bitwig preset or plug-in on one exact track, at the end of the chain or right before one device. By default it is found in the browser by its exact name (use location/deviceType/category when a name has several entries; ambiguous names are refused). Expert alternative: a stable bitwigId, clapId or vst3Id. Success is reported only after the device chain shows the new device at the expected position with that name or preset. Bitwig may rename a track that still has its default name; the reply then carries trackRenamedTo.",
    inputSchema: z.strictObject({
      ...trackSelector,
      ...insertBefore,
      name: z.string().min(1).optional().describe("Exact browser entry name (device, preset or plug-in)"),
      ...browserFilters,
      bitwigId: z.string().uuid().optional().describe("Expert: Bitwig device UUID"),
      clapId: z.string().min(1).optional().describe("Expert: CLAP plug-in ID, e.g. com.vital.synth"),
      vst3Id: z.string().min(1).optional().describe("Expert: VST3 plug-in class ID")
    })
  }, async args => call("insert_device", args, 60000));

  server.registerTool("bitwig_insert_sample", {
    description: "Load an audio file (absolute path to WAV, AIFF or FLAC) as a new sampler device on one exact instrument or hybrid track, at the end of the chain or right before one device, and confirm Bitwig reports the loaded sample.",
    inputSchema: z.strictObject({
      ...trackSelector,
      ...insertBefore,
      path: z.string().min(1).describe("Absolute file path on this Mac")
    })
  }, async args => call("insert_sample", args, 30000));

  const remotePage = {
    remoteControlsPage: z.string().min(1).optional().describe("Remote-controls page by name"),
    remoteControlsPageIndex: z.number().int().nonnegative().optional().describe("Remote-controls page by index")
  };

  server.registerTool("bitwig_set_device", {
    description: "Change one exact device's state: enabled (bypass when false), plug-in window open, expanded, remote-controls section shown, and the remote-controls page shown. Every change is read back.",
    inputSchema: z.strictObject({
      ...deviceSelector,
      enabled: z.boolean().optional(),
      windowOpen: z.boolean().optional().describe("Open or close the plug-in window"),
      expanded: z.boolean().optional(),
      remoteControlsVisible: z.boolean().optional(),
      ...remotePage
    })
  }, async args => call("set_device", args, 15000));

  server.registerTool("bitwig_device_parameters", {
    description: "Read one exact device's parameters: the eight remote controls of one page (default: the page shown; the page shown is restored afterwards) with page names, and the device's full direct parameter list (stable IDs, names, normalized values 0-1 and display text), filterable and paged.",
    inputSchema: z.strictObject({
      ...deviceSelector,
      ...remotePage,
      query: z.string().optional().describe("Case-insensitive part of a direct parameter name"),
      offset: z.number().int().nonnegative().default(0),
      limit: z.number().int().min(1).max(200).default(100)
    })
  }, async args => call("device_parameters", args, 15000));

  server.registerTool("bitwig_set_device_parameters", {
    description: "Set up to 32 parameters on one exact device in one call, each addressed either by direct parameter ID or by remote control (page by name or index, control by name or index), to a normalized value 0-1. All targets are checked before anything is written; every value is read back with its display text, and values Bitwig did not take are listed with what it holds. Direct parameters are written in 1/127 steps; remote controls take the full resolution. Parameters with fixed steps snap to the nearest one.",
    inputSchema: z.strictObject({
      ...deviceSelector,
      parameters: z.array(z.strictObject({
        parameterId: z.string().min(1).optional().describe("Direct parameter ID from bitwig_device_parameters"),
        page: z.string().min(1).optional().describe("Remote-controls page name"),
        pageIndex: z.number().int().nonnegative().optional(),
        control: z.string().min(1).optional().describe("Remote control name on that page"),
        controlIndex: z.number().int().min(0).max(7).optional(),
        value: z.number().min(0).max(1).describe("Normalized value 0-1")
      })).min(1).max(32)
    })
  }, async args => call("set_device_parameters", args, 30000));

  server.registerTool("bitwig_write_clip", {
    description: "Create a launcher MIDI clip (or replace one with replace=true) on one exact track, set its name, length (as its loop) and color, write all its notes, and read the whole clip back. Any missing, changed or extra note or clip property fails the call with the exact differences. Slot = one past the last scene adds a new scene.",
    inputSchema: z.strictObject({
      ...trackSelector,
      slotIndex,
      name: z.string().min(1).max(120),
      lengthBeats: z.number().positive().max(512).describe("Clip length in beats. The clip loops from 0 to lengthBeats unless loop says otherwise"),
      loop: clipLoop.optional().describe("Defaults to an enabled loop from 0 to lengthBeats"),
      color: clipColor.optional(),
      stepsPerBeat,
      replace: z.boolean().default(false).describe("Replace a clip already in the slot"),
      notes: z.array(newNote).max(750).describe("Complete note content; up to 750 notes (one request must fit in a 60 KB message)")
    })
  }, async args => call("write_clip", args, 120000));

  server.registerTool("bitwig_read_clip", {
    description: "Read one launcher clip on one exact track: name, color, loop, play state, and its notes with velocity, duration, channel, timbre, pan, gainDb and mute. gainDb is null when Bitwig reads 0: the note's gain was never set (it plays at 0 dB) or it is -inf; the API cannot tell these apart. Note starts are read on the stepsPerBeat grid; a note between two steps reads back at the step it starts in, so use a finer grid to keep off-grid timing.",
    inputSchema: z.strictObject({
      ...trackSelector,
      slotIndex,
      stepsPerBeat,
      offset: z.number().int().nonnegative().default(0).describe("First note to return, for clips with more notes than limit"),
      limit: z.number().int().min(1).max(300).default(300)
    })
  }, async args => call("read_clip", args, 120000));

  server.registerTool("bitwig_edit_clip", {
    description: "Change an existing launcher clip on one exact track without rewriting it: set name, loop (start, length, on/off) or color; add or change single notes (setNotes, matched by beat, pitch and channel; only given fields change); delete single notes (removeNotes). The whole clip is read before and after; every untouched note must come back unchanged, or the call fails with the exact differences.",
    inputSchema: z.strictObject({
      ...trackSelector,
      slotIndex,
      stepsPerBeat,
      name: z.string().min(1).max(120).optional(),
      loop: clipLoop.optional().describe("Loop region and on/off; this is how a launcher clip's length is changed"),
      color: clipColor.optional(),
      setNotes: z.array(noteChange).max(750).default([]).describe("Notes to add, or to change where a note already starts on that cell"),
      removeNotes: z.array(noteRef).max(750).default([]).describe("Notes to delete; each must exist")
    })
  }, async args => call("edit_clip", args, 120000));

  server.registerTool("bitwig_arrange_launcher_clips", {
    description: "Record existing launcher clips into Bitwig's Arranger across exact requested beat regions, merging contiguous regions. Recording starts at the earliest region and covers at most 1024 beats. Armed tracks are disarmed and overdub is off while it records; tempo, loop, overdub, arms and playhead are restored afterward, also on failure.",
    inputSchema: z.strictObject({
      regions: z.array(z.strictObject({
        ...trackSelector,
        slotIndex: z.number().int().min(0).max(7).default(0).describe("Launcher slot 0-7; the print reads only the first eight scenes"),
        startBeats: z.number().nonnegative(),
        lengthBeats: z.number().int().min(1).max(512),
        clipName: z.string().min(1).max(120)
      })).min(1).max(64),
      restoreTempo: z.number().min(20).max(666).optional().describe("Tempo to set after recording; defaults to the project's tempo before recording")
    })
  }, async args => call("arrange_launcher_clips", args, 120000));

  const sceneSelector = {
    sceneIndex: z.number().int().min(0).max(1023).describe("Scene index from bitwig_launcher"),
    sceneName: z.string().describe("Exact current scene name as a safety check; \"\" for an unnamed scene")
  };

  server.registerTool("bitwig_launcher", {
    description: "Read the clip launcher: scenes (index, name, color, clip count) with the clips in each (track, clip name, color, state: playing, queued, stopQueued, stopped, recording, recordingQueued), every main track's stopped/stop-queued state, and the transport. Paged over scenes; optionally one track only. Effect tracks are not covered.",
    inputSchema: z.strictObject({
      trackId: trackId.optional().describe("Only this track"),
      sceneOffset: z.number().int().nonnegative().default(0),
      sceneLimit: z.number().int().min(1).max(128).default(32)
    })
  }, async args => call("launcher", args, 60000));

  server.registerTool("bitwig_edit_scene", {
    description: "Create a scene at the end (create: true), duplicate one exact scene with its clips (duplicate: true; the copy lands right after it), and/or set the scene's name and color. The new or edited scene is read back. Scene deletion is not part of this tool.",
    inputSchema: z.strictObject({
      sceneIndex: sceneSelector.sceneIndex.optional(),
      sceneName: sceneSelector.sceneName.optional(),
      create: z.boolean().optional(),
      duplicate: z.boolean().optional(),
      name: z.string().min(1).max(120).optional(),
      color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional().describe("#RRGGBB")
    })
  }, async args => call("edit_scene", args, 30000));

  server.registerTool("bitwig_launch", {
    description: "Launch one exact scene or clip, or stop launcher playback / return to the arrangement on one exact track or on all tracks. A launch succeeds once every clip involved is playing or queued; a stop once no clip on the affected tracks is playing or queued (stop-queued counts as stopping). quantization and launchMode default to Bitwig's own settings.",
    inputSchema: z.strictObject({
      action: z.enum(["launch", "stop", "returnToArrangement"]).default("launch"),
      sceneIndex: sceneSelector.sceneIndex.optional(),
      sceneName: sceneSelector.sceneName.optional(),
      trackId: trackId.optional().describe("The clip's track, or the one track to stop or return"),
      slotIndex: z.number().int().min(0).max(1023).optional().describe("Clip slot (scene index) on that track"),
      quantization: z.enum(["default", "none", "8", "4", "2", "1", "1/2", "1/4", "1/8", "1/16"]).optional().describe("Bars as Bitwig counts them; none launches at once"),
      launchMode: z.enum(["default", "from_start", "continue_or_from_start", "continue_or_synced", "synced"]).optional()
    })
  }, async args => call("launch", args, 30000));

  server.registerTool("bitwig_delete", {
    description: "Delete one exact item, checked before and confirmed after: what 'track' (main or effect track by trackId; a group takes its tracks with it), 'device' (trackId, deviceIndex and deviceName), 'scene' (sceneIndex and sceneName, with its clips) or 'clip' (launcher clip by trackId, slotIndex and clipName). Bitwig's undo brings it back.",
    inputSchema: z.strictObject({
      what: z.enum(["track", "device", "scene", "clip"]),
      trackId: trackId.optional(),
      deviceIndex: deviceSelector.deviceIndex.optional(),
      deviceName: deviceSelector.deviceName.optional(),
      sceneIndex: sceneSelector.sceneIndex.optional(),
      sceneName: sceneSelector.sceneName.optional(),
      slotIndex: z.number().int().min(0).max(1023).optional(),
      clipName: z.string().optional().describe("Exact current clip name as a safety check")
    })
  }, async args => call("delete", args));
}

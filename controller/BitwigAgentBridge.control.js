loadAPI(25);

host.defineController("Bitwig Agent Bridge", "Bitwig Agent Bridge", "1.2.1", "8A319A60-5BAF-4C0D-B613-16D646B1E8A6", "_zkyron, based on Bitwig Control Deck by Remy Mazmanian");
// No MIDI: all control data uses an authenticated local UDP channel that never
// leaves this Mac. Without MIDI ports there is nothing for Bitwig to auto-detect,
// so the controller is added once by hand in Settings → Controllers.
host.defineMidiPorts(0, 0);

var BRIDGE_VERSION = "1.2.1";
var BRIDGE_PROTOCOL = "bitwig-agent-bridge/1";
var BRIDGE_PORT = 50701;
// Stamped with a per-install secret by `npm run setup`. The bridge refuses to
// start while the placeholder is still in place.
var BRIDGE_TOKEN = "__BRIDGE_TOKEN__";
// Bank sizes, fixed at init as the Controller API requires.
var MAX_TRACKS = 64;
// Sends per track; send i goes to effect track i.
var MAX_SENDS = 8;
var MAX_DEVICES = 64;
var MAX_SCENES = 8;
// Highest launcher slot or scene the tools accept. Bitwig shows MAX_SCENES of
// them at a time, and withSceneSlot scrolls that window to reach the rest.
var MAX_SCENE_SLOTS = 1024;
var MAX_CUE_MARKERS = 256;
// Longest stretch one launcher print records: about 92 seconds at 666 BPM,
// inside the print's 115-second limit.
var MAX_PRINT_SPAN_BEATS = 1024;
var BROWSER_PAGE = 128;
var MAX_BROWSER_RESULTS = 16384;
var MAX_EFFECT_TRACKS = 16;
// Track volume and send levels. Measured in Bitwig 6.1.7 against the mixer
// display: Parameter.getRaw() is an amplitude root with dB = 60 * log10(raw)
// (0 is -inf). Track volume tops out at +6.02 dB (raw 2^(1/3)), sends at 0 dB
// (raw 1). Track pan's raw value runs from -1 (100 % left) to 1 (100 % right).
var MIN_LEVEL_DB = -120;
var MAX_TRACK_VOLUME_DB = 6;
var MAX_SEND_DB = 0;
var LEVEL_TOLERANCE_DB = 0.05;
var PAN_TOLERANCE = 0.002;
var SEND_MODES = ["AUTO", "PRE", "POST"];
// Note grid of the launcher cursor clip: steps per window and keys (all 128
// MIDI pitches). Reads and writes scroll this window across the clip.
var CLIP_GRID_WIDTH = 256;
var CLIP_GRID_HEIGHT = 128;
// Grid resolution of note starts, in steps per beat. 4 is a 1/16 grid at 4/4.
var DEFAULT_STEPS_PER_BEAT = 4;
var MAX_STEPS_PER_BEAT = 960;
// Longest clip the note tools read or write, and most notes in one request.
var MAX_CLIP_BEATS = 512;
var MAX_CLIP_NOTES = 4096;
// Most grid steps one request may cover (clip span × stepsPerBeat): 64 grid
// pages, which bounds a read to about 12 s and a verified write to about 30 s.
var MAX_GRID_STEPS = 16384;
// Largest difference per color channel (0..1) that still counts as the
// requested color: a bit more than one 8-bit step.
var COLOR_TOLERANCE = 1.5 / 255;
// Most notes one read_clip reply carries; page with offset for more.
var MAX_NOTES_PER_REPLY = 300;
// Per-note expressions the note tools write, with the range each accepts, and
// how far a read-back value may differ from the requested one. The ranges are
// the ones Bitwig's NoteStep setters enforce (measured in Bitwig 6.1.7; the
// API reference does not state them). Pressure is left out on purpose: a value
// written with NoteStep.setPressure does not persist (it is reset when notes
// are added, when timbre, pan or gain change, and on later reads).
var NOTE_EXPRESSIONS = { timbre: [-1, 1], pan: [-1, 1] };
var NOTE_EXPRESSION_TOLERANCE = 0.001;
// Per-note gain. Tools speak dB (gainDb); Bitwig's NoteStep.setGain takes
// 0..1 and NoteStep.gain() reads twice that. Measured in Bitwig 6.1.7 against
// the Inspector: dB = 60 * log10(2 * setGain value), so 0.5 is 0 dB, 1 is
// +18.1 dB and 0 is -inf. A note whose gain was never set plays at 0 dB but
// reads 0, the same as -inf, so new notes get 0 dB written explicitly and a
// read of 0 is reported as gainDb null.
var NOTE_GAIN_READ_SCALE = 2;
var NOTE_GAIN_DB_RANGE = [-100, 18];
var NOTE_DEFAULT_GAIN = 0.5;
// NoteStep setters, in the order they are called.
var NOTE_SETTER_FIELDS = ["velocity", "duration", "muted", "timbre", "pan", "gain"];
// Waits that let Bitwig's grid observers catch up after a scroll or a write.
var NOTE_SCROLL_SETTLE_MS = 60;
var NOTE_PAGE_SETTLE_MS = 180;
var CLIP_FOCUS_SETTLE_MS = 160;
// Largest reply sent back in one datagram. Mirrors MAX_PACKET_BYTES in
// src/bitwig-client.mjs, which reads replies on a 65536-byte socket buffer.
var MAX_REPLY_BYTES = 60000;

var application;
var arranger;
var cueMarkerBank;
var project;
var transport;
var trackBank;
var effectTrackBank;
var masterTrack;
var cursorTrack;
var trackIsCursor = [];
var deviceBank;
var cursorDevice;
var cursorDeviceSlot;
var cursorRemoteControlsPage;
var nestedDeviceBank;
var launcherClip;
var sceneBank;
var popupBrowser;
var resultColumn;
var resultBank;
var deviceTypeBank;
var categoryBank;
var tagBank;
var fileTypeBank;
var creatorBank;
var directIds = [];
var directNames = {};
var directValues = {};
var directDisplays = {};
var directDisplayObserver;
var saveToLibraryAction;
var jumpToBeginningAction;
var trackMeterLatest = [];
var trackMeterMaximum = [];
// Name of the track each maximum was measured on. Maxima are stored by bank
// position, so a track that moves to another position must not inherit them.
var trackMeterOwner = [];
var requestQueue = [];
var requestBusy = false;
var currentRequest = null;
// Requests from older clients carry no timeout; outlast the longest tool call.
var DEFAULT_REQUEST_LIMIT_MS = 130000;

function interested(value) {
   value.markInterested();
   return value;
}

// Every delayed step runs through here. An exception in a step used to leave the
// bridge busy forever; now it fails the request that scheduled the step instead.
// Steps of a request that already finished, failed or timed out are dropped, so
// they can't keep changing Bitwig or schedule steps under the next request.
function later(delay, callback) {
   var owner = currentRequest;
   host.scheduleTask(function() {
      if (owner && owner.done) return;
      try {
         callback();
      } catch (error) {
         host.errorln("Bitwig Agent Bridge step error: " + error);
         if (owner && !owner.done) finish(owner, false, { message: String(error.message || error) });
      }
   }, delay);
}

function arrayCopy(values) {
   var copy = [];
   if (!values) return copy;
   for (var i = 0; i < values.length; i++) copy.push(String(values[i]));
   return copy;
}

function normalizeText(value) {
   return String(value || "").toLowerCase().trim();
}

function unsignedByte(value) {
   var number = Number(value);
   return number < 0 ? number + 256 : number;
}

function decodeUtf8(bytes) {
   var result = "";
   var index = 0;
   while (index < bytes.length) {
      var first = unsignedByte(bytes[index++]);
      var codePoint;
      if (first < 128) {
         codePoint = first;
      } else if ((first & 224) === 192 && index < bytes.length) {
         codePoint = ((first & 31) << 6) | (unsignedByte(bytes[index++]) & 63);
      } else if ((first & 240) === 224 && index + 1 < bytes.length) {
         codePoint = ((first & 15) << 12) |
            ((unsignedByte(bytes[index++]) & 63) << 6) |
            (unsignedByte(bytes[index++]) & 63);
      } else if ((first & 248) === 240 && index + 2 < bytes.length) {
         codePoint = ((first & 7) << 18) |
            ((unsignedByte(bytes[index++]) & 63) << 12) |
            ((unsignedByte(bytes[index++]) & 63) << 6) |
            (unsignedByte(bytes[index++]) & 63);
      } else {
         codePoint = 65533;
      }

      if (codePoint <= 65535) result += String.fromCharCode(codePoint);
      else {
         codePoint -= 65536;
         result += String.fromCharCode(55296 + (codePoint >> 10), 56320 + (codePoint & 1023));
      }
   }
   return result;
}

function signedByte(value) {
   return value > 127 ? value - 256 : value;
}

function encodeUtf8(value) {
   var text = String(value);
   var bytes = [];
   for (var index = 0; index < text.length; index++) {
      var codePoint = text.charCodeAt(index);
      if (codePoint >= 55296 && codePoint <= 56319 && index + 1 < text.length) {
         var second = text.charCodeAt(index + 1);
         if (second >= 56320 && second <= 57343) {
            codePoint = 65536 + ((codePoint - 55296) << 10) + (second - 56320);
            index++;
         }
      }

      if (codePoint < 128) {
         bytes.push(signedByte(codePoint));
      } else if (codePoint < 2048) {
         bytes.push(signedByte(192 | (codePoint >> 6)));
         bytes.push(signedByte(128 | (codePoint & 63)));
      } else if (codePoint < 65536) {
         bytes.push(signedByte(224 | (codePoint >> 12)));
         bytes.push(signedByte(128 | ((codePoint >> 6) & 63)));
         bytes.push(signedByte(128 | (codePoint & 63)));
      } else {
         bytes.push(signedByte(240 | (codePoint >> 18)));
         bytes.push(signedByte(128 | ((codePoint >> 12) & 63)));
         bytes.push(signedByte(128 | ((codePoint >> 6) & 63)));
         bytes.push(signedByte(128 | (codePoint & 63)));
      }
   }
   return bytes;
}

function readTransport() {
   return {
      playing: transport.isPlaying().get(),
      recording: transport.isArrangerRecordEnabled().get(),
      tempo: transport.tempo().value().getRaw(),
      tempoDisplay: transport.tempo().value().displayedValue().get(),
      positionBeats: transport.getPosition().get()
   };
}

function cueMarkerSnapshot(marker, index) {
   return {
      index: index,
      name: marker.name().get(),
      positionBeats: marker.position().get()
   };
}

function listCueMarkers() {
   var total = cueMarkerBank.itemCount().get();
   var count = Math.min(total, MAX_CUE_MARKERS);
   var markers = [];
   for (var index = 0; index < count; index++) {
      var marker = cueMarkerBank.getItemAt(index);
      if (marker.exists().get()) markers.push(cueMarkerSnapshot(marker, index));
   }
   return {
      total: total,
      returned: markers.length,
      truncated: total > MAX_CUE_MARKERS,
      markers: markers
   };
}

function cueMarkerAtPosition(positionBeats) {
   var count = Math.min(cueMarkerBank.itemCount().get(), MAX_CUE_MARKERS);
   for (var index = 0; index < count; index++) {
      var marker = cueMarkerBank.getItemAt(index);
      if (marker.exists().get() && Math.abs(marker.position().get() - positionBeats) < 0.0001) {
         return { marker: marker, index: index };
      }
   }
   return null;
}

function cueMarkerFingerprintCounts() {
   var counts = {};
   var count = Math.min(cueMarkerBank.itemCount().get(), MAX_CUE_MARKERS);
   for (var index = 0; index < count; index++) {
      var marker = cueMarkerBank.getItemAt(index);
      if (!marker.exists().get()) continue;
      var key = JSON.stringify([marker.name().get(), marker.position().get()]);
      counts[key] = Number(counts[key] || 0) + 1;
   }
   return counts;
}

function levelDb(raw) {
   return raw > 0 ? roundTo(60 * Math.log(raw) / Math.LN10, 2) : null;
}

function levelRaw(db) {
   return Math.pow(10, db / 60);
}

function sendSnapshot(send, index) {
   return {
      index: index,
      name: send.name().get(),
      levelDb: levelDb(send.getRaw()),
      enabled: send.isEnabled().get(),
      mode: String(send.sendMode().get())
   };
}

// One track's state. kind is "main", "effect" or "master"; only main tracks
// have arm and sends here (the effect and master banks are created without).
function trackSnapshot(track, index, kind) {
   kind = kind || "main";
   var state = {
      index: index,
      name: track.name().get(),
      type: track.trackType().get(),
      color: colorHex(track.color()),
      mute: track.mute().get(),
      solo: track.solo().get(),
      volumeDb: levelDb(track.volume().getRaw()),
      volumeDisplay: track.volume().displayedValue().get(),
      pan: roundTo(track.pan().getRaw(), 4)
   };
   if (kind === "main") {
      state.position = track.position().get();
      state.arm = track.arm().get();
      var sends = [];
      for (var s = 0; s < MAX_SENDS; s++) {
         var send = track.sendBank().getItemAt(s);
         if (send.exists().get()) sends.push(sendSnapshot(send, s));
      }
      state.sends = sends;
   }
   return state;
}

function listTracks() {
   var total = trackBank.itemCount().get();
   var count = Math.min(total, MAX_TRACKS);
   var tracks = [];
   for (var i = 0; i < count; i++) {
      var track = trackBank.getItemAt(i);
      if (track.exists().get()) tracks.push(trackSnapshot(track, i, "main"));
   }
   var effectTotal = effectTrackBank.itemCount().get();
   var effectTracks = [];
   for (var e = 0; e < Math.min(effectTotal, MAX_EFFECT_TRACKS); e++) {
      var effectTrack = effectTrackBank.getItemAt(e);
      if (effectTrack.exists().get()) effectTracks.push(trackSnapshot(effectTrack, e, "effect"));
   }
   var result = {
      total: total, returned: tracks.length, truncated: total > MAX_TRACKS, tracks: tracks,
      effectTracks: effectTracks, effectTracksTruncated: effectTotal > MAX_EFFECT_TRACKS,
      master: trackSnapshot(masterTrack, 0, "master")
   };
   var duplicates = duplicateTrackNames(tracks).concat(duplicateTrackNames(effectTracks));
   if (duplicates.length) {
      result.duplicateNames = duplicates;
      result.note = "Tools refuse tracks that share a name. Rename them with bitwig_set_track first.";
   }
   return result;
}

function duplicateTrackNames(tracks) {
   var seen = {};
   var duplicates = [];
   for (var i = 0; i < tracks.length; i++) {
      var key = "=" + tracks[i].name;
      seen[key] = Number(seen[key] || 0) + 1;
      if (seen[key] === 2) duplicates.push(tracks[i].name);
   }
   return duplicates;
}

// Indices of the reachable tracks in a bank with exactly this name.
function trackIndicesNamed(name, bank, limit) {
   bank = bank || trackBank;
   var count = Math.min(bank.itemCount().get(), limit || MAX_TRACKS);
   var indices = [];
   for (var i = 0; i < count; i++) {
      var track = bank.getItemAt(i);
      if (track.exists().get() && track.name().get() === name) indices.push(i);
   }
   return indices;
}

function readTrackMeters(resetAfterRead) {
   var total = Math.min(trackBank.itemCount().get(), MAX_TRACKS);
   var meters = [];
   for (var i = 0; i < total; i++) {
      var track = trackBank.getItemAt(i);
      if (!track.exists().get()) continue;
      var maximum = meterMaximumFor(i, track.name().get());
      meters.push({
         index: i,
         name: track.name().get(),
         latest: Number(trackMeterLatest[i] || 0),
         maximum: maximum,
         maximumNormalized: maximum / 127
      });
      if (resetAfterRead) trackMeterMaximum[i] = Number(trackMeterLatest[i] || 0);
   }
   return { range: 128, meters: meters };
}

// A track is identified by index plus name. When two tracks share the name, a
// shifted index could land on the wrong one and still pass, so such tracks are
// refused unless the caller is renaming one of them.
function requireTrack(params, allowDuplicateName) {
   return requireChannel(params, allowDuplicateName).track;
}

// Like requireTrack, for params.trackKind "main" (default), "effect" or
// "master". Returns { track, kind, bank, limit, index }.
function requireChannel(params, allowDuplicateName) {
   var kind = params.trackKind === undefined ? "main" : String(params.trackKind);
   var index = Number(params.trackIndex);
   if (kind === "master") {
      if (index !== 0) throw new Error("The master track has index 0.");
      if (masterTrack.name().get() !== String(params.trackName)) {
         throw new Error("Safety check failed: the master track is named ‘" + masterTrack.name().get() + "’, not ‘" + params.trackName + "’. Refresh first.");
      }
      return { track: masterTrack, kind: kind, bank: null, limit: 1, index: 0 };
   }
   if (kind !== "main" && kind !== "effect") throw new Error("trackKind must be main, effect or master.");
   var bank = kind === "effect" ? effectTrackBank : trackBank;
   var limit = kind === "effect" ? MAX_EFFECT_TRACKS : MAX_TRACKS;
   var label = kind === "effect" ? "Effect track" : "Track";
   if (!(index >= 0 && index < limit && index < bank.itemCount().get()) || Math.floor(index) !== index) {
      throw new Error(label + " index " + params.trackIndex + " is not available. Refresh with bitwig_tracks.");
   }
   var track = bank.getItemAt(index);
   if (!track.exists().get()) throw new Error(label + " " + index + " no longer exists.");
   var currentName = track.name().get();
   if (currentName !== String(params.trackName)) {
      throw new Error("Safety check failed: " + label.toLowerCase() + " " + index + " is now named ‘" + currentName + "’, not ‘" + params.trackName + "’. Refresh first.");
   }
   if (!allowDuplicateName) {
      var sameName = trackIndicesNamed(currentName, bank, limit);
      if (sameName.length > 1) {
         throw new Error(label + "s " + sameName.join(", ") + " are all named ‘" + currentName + "’, so Bitwig Agent Bridge cannot be sure which one is meant. " +
            "Rename them with bitwig_set_track so each name is unique, then try again.");
      }
   }
   return { track: track, kind: kind, bank: bank, limit: limit, index: index };
}

function selectTrack(request, params, callback) {
   var track = requireTrack(params);
   var index = Number(params.trackIndex);
   var expectedName = track.name().get();
   rememberSelection(request);
   track.selectInMixer();
   later(140, function() {
      try {
         // Ask Bitwig whether the cursor now is this track. Comparing positions
         // fails for tracks inside a group: the cursor reports its position
         // within the group, the main track bank its position in the whole list.
         if (cursorTrack.name().get() !== expectedName || !trackIsCursor[index].get()) {
            throw new Error("Bitwig did not select the requested track. No device operation was performed.");
         }
         callback(track);
      } catch (error) {
         finish(request, false, { message: String(error.message || error) });
      }
   });
}

// Tools that work through Bitwig's cursor move the track (and device) selection.
// The first time a request does that, note what was selected, and put it back
// when the request ends, whether it succeeded or failed.
function rememberSelection(request) {
   if (request.selectionRemembered) return;
   request.selectionRemembered = true;
   var count = Math.min(trackBank.itemCount().get(), MAX_TRACKS);
   var saved = null;
   for (var i = 0; i < count; i++) {
      if (trackIsCursor[i].get()) {
         saved = { trackIndex: i, trackName: trackBank.getItemAt(i).name().get(), deviceName: null, devicePosition: -1 };
         break;
      }
   }
   // Master, effect tracks and tracks past the first 128 can't be selected again
   // from the main track list, so their selection is left where the tool put it.
   if (!saved) return;
   if (cursorDevice.exists().get() && !cursorDevice.isNested().get()) {
      saved.deviceName = cursorDevice.name().get();
      saved.devicePosition = cursorDevice.position().get();
   }
   var previousCleanup = request.cleanup;
   request.cleanup = function() {
      if (previousCleanup) previousCleanup();
      restoreSelection(saved);
   };
}

function restoreSelection(saved) {
   var track = trackBank.getItemAt(saved.trackIndex);
   // The track moved or was deleted by the tool: there is nothing safe to go back to.
   if (!track.exists().get() || track.name().get() !== saved.trackName) return;
   if (!trackIsCursor[saved.trackIndex].get()) {
      track.selectInMixer();
      return;
   }
   // Same track: put the device selection back, following the device by name
   // when the tool inserted or removed devices in front of it.
   if (saved.deviceName === null) return;
   if (cursorDevice.exists().get() && cursorDevice.name().get() === saved.deviceName &&
      cursorDevice.position().get() === saved.devicePosition) return;
   var count = Math.min(deviceBank.itemCount().get(), MAX_DEVICES);
   var best = -1;
   for (var d = 0; d < count; d++) {
      if (deviceBank.getItemAt(d).name().get() !== saved.deviceName) continue;
      if (best < 0 || Math.abs(d - saved.devicePosition) < Math.abs(best - saved.devicePosition)) best = d;
   }
   if (best >= 0) cursorDevice.selectDevice(deviceBank.getItemAt(best));
}

function deviceSnapshot(device, index) {
   return {
      index: index,
      name: device.name().get(),
      type: device.deviceType().get(),
      position: device.position().get(),
      nested: device.isNested().get(),
      plugin: device.isPlugin().get(),
      enabled: device.isEnabled().get(),
      windowOpen: device.isWindowOpen().get(),
      presetName: device.presetName().get(),
      sampleName: device.sampleName().get()
   };
}

function listDevicesNow() {
   var total = deviceBank.itemCount().get();
   var count = Math.min(total, MAX_DEVICES);
   var devices = [];
   for (var i = 0; i < count; i++) {
      var device = deviceBank.getItemAt(i);
      if (device.exists().get()) devices.push(deviceSnapshot(device, i));
   }
   return { total: total, returned: devices.length, truncated: total > MAX_DEVICES, devices: devices };
}

function listNestedDevicesNow() {
   var total = nestedDeviceBank.itemCount().get();
   var count = Math.min(total, MAX_DEVICES);
   var devices = [];
   for (var i = 0; i < count; i++) {
      var device = nestedDeviceBank.getItemAt(i);
      if (device.exists().get()) devices.push(deviceSnapshot(device, i));
   }
   return { total: total, returned: devices.length, truncated: total > MAX_DEVICES, devices: devices };
}

function requireDevice(params) {
   var index = Number(params.deviceIndex);
   if (index < 0 || index >= MAX_DEVICES || index >= deviceBank.itemCount().get()) {
      throw new Error("Device index " + index + " is not available. Refresh with bitwig_devices.");
   }
   var device = deviceBank.getItemAt(index);
   if (!device.exists().get()) throw new Error("Device " + index + " no longer exists.");
   var currentName = device.name().get();
   if (currentName !== String(params.deviceName)) {
      throw new Error("Safety check failed: device " + index + " is now ‘" + currentName + "’, not ‘" + params.deviceName + "’. Refresh first.");
   }
   return device;
}

function selectDevice(request, params, callback) {
   selectTrack(request, params, function() {
      try {
         var device = requireDevice(params);
         var expectedName = device.name().get();
         var expectedPosition = device.position().get();
         cursorDevice.selectDevice(device);

         var attempts = 0;
         function verifySelection() {
            try {
               attempts++;
               var selected = cursorDevice.exists().get() &&
                  cursorDevice.name().get() === expectedName &&
                  cursorDevice.position().get() === expectedPosition;
               if (!selected && attempts < 12) {
                  later(80, verifySelection);
                  return;
               }
               if (!selected) {
                  throw new Error("Bitwig did not select device " + expectedPosition + " ‘" + expectedName + "’. No parameter was changed.");
               }
               // The direct-parameter observer follows the cursor device. Give
               // it one additional update cycle before any read or write.
               later(100, function() {
                  try {
                     callback(device);
                  } catch (error) {
                     finish(request, false, { message: String(error.message || error) });
                  }
               });
            } catch (error) {
               finish(request, false, { message: String(error.message || error) });
            }
         }
         later(80, verifySelection);
      } catch (error) {
         finish(request, false, { message: String(error.message || error) });
      }
   });
}

function parameterSnapshot(id) {
   return {
      id: id,
      name: directNames[id] || id,
      normalizedValue: directValues[id] === undefined ? null : directValues[id],
      displayValue: directDisplays[id] || ""
   };
}

function remoteControlsSnapshot() {
   var pageNames = arrayCopy(cursorRemoteControlsPage.pageNames().get());
   var selectedPageIndex = cursorRemoteControlsPage.selectedPageIndex().get();
   var controls = [];
   for (var i = 0; i < 8; i++) {
      var control = cursorRemoteControlsPage.getParameter(i);
      controls.push({
         index: i,
         exists: control.exists().get(),
         name: control.name().get(),
         normalizedValue: control.get(),
         displayValue: control.displayedValue().get()
      });
   }
   return {
      remoteControlsVisible: cursorDevice.isRemoteControlsSectionVisible().get(),
      pageCount: cursorRemoteControlsPage.pageCount().get(),
      pageNames: pageNames,
      selectedPageIndex: selectedPageIndex,
      selectedPageName: selectedPageIndex >= 0 && selectedPageIndex < pageNames.length ? pageNames[selectedPageIndex] : "",
      controls: controls
   };
}

var authFailureCount = 0;

function isAuthorized(request) {
   return !!request && typeof request === "object" && request.token === BRIDGE_TOKEN;
}

// Packets with a wrong token get no reply, so nothing on the machine can use
// the bridge to probe it. The first failure shows a popup, then the log notes
// the 1st and every 100th failure so a stale client is easy to spot.
function noteAuthFailure() {
   authFailureCount += 1;
   if (authFailureCount === 1) {
      host.showPopupNotification("Bitwig Agent Bridge ignored a request with the wrong auth token. Run `npm run setup` to reinstall the controller script.");
   }
   if (authFailureCount === 1 || authFailureCount % 100 === 0) {
      host.errorln("Bitwig Agent Bridge ignored " + authFailureCount + " request(s) with the wrong auth token.");
   }
}

function encodeReply(id, ok, payload) {
   return encodeUtf8(JSON.stringify({
      protocol: BRIDGE_PROTOCOL,
      id: String(id),
      ok: Boolean(ok),
      payload: payload || {}
   }));
}

// A reply has to fit in one datagram. An oversized reply is replaced by a short
// error the client can show, and a failed send is logged as an error and
// reported to the client with a short error reply when that still gets through.
function respond(replyPort, id, ok, payload, method) {
   var what = method ? "the " + method + " reply" : "the reply";
   var bytes = encodeReply(id, ok, payload);
   if (bytes.length > MAX_REPLY_BYTES) {
      host.errorln("Bitwig Agent Bridge: " + what + " is " + bytes.length + " bytes, over the " + MAX_REPLY_BYTES + "-byte limit.");
      bytes = encodeReply(id, false, {
         message: "Bitwig's answer is " + bytes.length + " bytes, over the " + MAX_REPLY_BYTES + "-byte limit for one reply. Ask for less, for example with a smaller limit, an offset or a query.",
         replyBytes: bytes.length,
         maxReplyBytes: MAX_REPLY_BYTES
      });
   }
   try {
      host.sendDatagramPacket("127.0.0.1", Number(replyPort), bytes);
   } catch (error) {
      host.errorln("Bitwig Agent Bridge could not send " + what + " (" + bytes.length + " bytes): " + error);
      try {
         host.sendDatagramPacket("127.0.0.1", Number(replyPort), encodeReply(id, false, {
            message: "Bitwig could not send " + what + " (" + bytes.length + " bytes): " + String(error.message || error),
            replyBytes: bytes.length
         }));
      } catch (secondError) {
         host.errorln("Bitwig Agent Bridge could not send the error reply either: " + secondError);
      }
   }
}

// Each request is answered exactly once. Late steps of a request that already
// failed or timed out are ignored, so they can't release the next request early.
function finish(request, ok, payload) {
   if (request.done) return;
   if (request.cleanup) {
      try {
         request.cleanup();
      } catch (error) {
         host.errorln("Bitwig Agent Bridge cleanup error: " + error);
      }
   }
   request.done = true;
   respond(request.source, request.id, ok, payload, request.method);
   if (currentRequest === request) {
      currentRequest = null;
      requestBusy = false;
      later(1, processNextRequest);
   }
}

function processNextRequest() {
   if (requestBusy) return;
   var now = Date.now();
   // The client stops waiting at its deadline, so don't start work nobody is waiting for.
   while (requestQueue.length && requestQueue[0].deadline < now) requestQueue.shift();
   if (requestQueue.length === 0) return;
   requestBusy = true;
   var request = requestQueue.shift();
   currentRequest = request;
   host.scheduleTask(function() {
      if (!request.done) {
         finish(request, false, {
            message: "Bitwig did not finish " + request.method + " within " + request.limitMs + " ms. The bridge has recovered and is ready for the next request."
         });
      }
   }, request.limitMs);
   try {
      dispatch(request);
   } catch (error) {
      finish(request, false, { message: String(error.message || error) });
   }
}

function enqueue(source, id, method, params, timeoutMs) {
   if (requestQueue.length >= 32) {
      respond(source, id, false, { message: "Bitwig Agent Bridge is busy. Try the request again." });
      return;
   }
   var clientTimeout = Number(timeoutMs);
   var hasTimeout = isFinite(clientTimeout) && clientTimeout > 0;
   requestQueue.push({
      source: source,
      id: id,
      method: method,
      params: params || {},
      deadline: hasTimeout ? Date.now() + clientTimeout : Infinity,
      limitMs: hasTimeout ? Math.max(1000, clientTimeout + 1000) : DEFAULT_REQUEST_LIMIT_MS
   });
   processNextRequest();
}

function readFilterOptions(bank) {
   var options = [];
   var count = Math.min(bank.itemCount().get(), bank.getSizeOfBank());
   for (var i = 0; i < count; i++) {
      var item = bank.getItemAt(i);
      if (item.exists().get()) options.push(item.name().get());
   }
   return options;
}

function resetBrowserFilters() {
   popupBrowser.smartCollectionColumn().getWildcardItem().isSelected().set(true);
   popupBrowser.locationColumn().getWildcardItem().isSelected().set(true);
   popupBrowser.deviceColumn().getWildcardItem().isSelected().set(true);
   popupBrowser.deviceTypeColumn().getWildcardItem().isSelected().set(true);
   popupBrowser.categoryColumn().getWildcardItem().isSelected().set(true);
   popupBrowser.tagColumn().getWildcardItem().isSelected().set(true);
   popupBrowser.fileTypeColumn().getWildcardItem().isSelected().set(true);
   popupBrowser.creatorColumn().getWildcardItem().isSelected().set(true);
   deviceTypeBank.scrollPosition().set(0);
   categoryBank.scrollPosition().set(0);
   tagBank.scrollPosition().set(0);
   fileTypeBank.scrollPosition().set(0);
   creatorBank.scrollPosition().set(0);
   resultBank.scrollPosition().set(0);
}

function selectFilterValue(request, label, bank, value, callback) {
   if (!value) {
      callback();
      return;
   }
   bank.scrollPosition().set(0);
   later(90, function() {
      try {
         var wanted = normalizeText(value);
         var count = Math.min(bank.itemCount().get(), bank.getSizeOfBank());
         var match = null;
         for (var i = 0; i < count; i++) {
            var item = bank.getItemAt(i);
            if (item.exists().get() && normalizeText(item.name().get()) === wanted) match = item;
         }
         if (!match) {
            throw new Error("No exact " + label + " filter named ‘" + value + "’. Available: " + readFilterOptions(bank).join(", "));
         }
         match.isSelected().set(true);
         later(180, callback);
      } catch (error) {
         popupBrowser.cancel();
         finish(request, false, { message: String(error.message || error) });
      }
   });
}

function prepareBrowser(request, params, callback) {
   cursorTrack.endOfDeviceChainInsertionPoint().browse();
   later(280, function() {
      try {
         if (!popupBrowser.exists().get()) throw new Error("Bitwig did not open its insertion browser.");
         var contentTypes = arrayCopy(popupBrowser.contentTypeNames().get());
         var contentType = String(params.contentType || "Devices");
         var contentTypeIndex = contentTypes.indexOf(contentType);
         if (contentTypeIndex < 0) throw new Error("Bitwig browser content type ‘" + contentType + "’ is unavailable. Available: " + contentTypes.join(", "));
         popupBrowser.selectedContentTypeIndex().set(contentTypeIndex);
         later(180, function() {
            if (contentType === "Devices") {
               resetBrowserFilters();
               later(1000, function() {
                  selectFilterValue(request, "device type", deviceTypeBank, params.deviceType, function() {
                     selectFilterValue(request, "category", categoryBank, params.category, function() {
                        selectFilterValue(request, "tag", tagBank, params.tag, function() {
                           selectFilterValue(request, "file type", fileTypeBank, params.fileType, function() {
                              selectFilterValue(request, "creator", creatorBank, params.creator, callback);
                           });
                        });
                     });
                  });
               });
            } else {
               resultBank.scrollPosition().set(0);
               later(180, callback);
            }
         });
      } catch (error) {
         popupBrowser.cancel();
         finish(request, false, { message: String(error.message || error) });
      }
   });
}

function scanBrowserResults(request, query, exact, limit, callback) {
   var wanted = normalizeText(query);
   var total = Math.min(resultColumn.entryCount().get(), MAX_BROWSER_RESULTS);
   var matches = [];
   var offset = 0;

   function scanPage() {
      resultBank.scrollPosition().set(offset);
      later(100, function() {
         try {
            var pageCount = Math.min(BROWSER_PAGE, Math.max(0, total - offset));
            for (var i = 0; i < pageCount; i++) {
               var item = resultBank.getItemAt(i);
               if (!item.exists().get()) continue;
               var name = item.name().get();
               var comparable = normalizeText(name);
               var hit = exact ? comparable === wanted : comparable.indexOf(wanted) !== -1;
               if (hit) matches.push({ resultIndex: offset + i, name: name });
            }
            offset += BROWSER_PAGE;
            if (offset < total && (exact || matches.length < limit)) scanPage();
            else callback(matches, resultColumn.entryCount().get());
         } catch (error) {
            popupBrowser.cancel();
            finish(request, false, { message: String(error.message || error) });
         }
      });
   }

   scanPage();
}

function countDeviceName(name) {
   var wanted = normalizeText(name);
   var count = 0;
   var total = Math.min(deviceBank.itemCount().get(), MAX_DEVICES);
   for (var i = 0; i < total; i++) {
      var item = deviceBank.getItemAt(i);
      if (item.exists().get() && normalizeText(item.name().get()) === wanted) count++;
   }
   return count;
}

function handleFindDevices(request) {
   var params = request.params;
   selectTrack(request, params, function() {
      prepareBrowser(request, params, function() {
         scanBrowserResults(request, params.query, false, Number(params.limit || 50), function(matches, total) {
            popupBrowser.cancel();
            finish(request, true, {
               session: "Devices",
               presetSearch: false,
               totalDevicesAfterFilters: total,
               returned: Math.min(matches.length, Number(params.limit || 50)),
               matches: matches.slice(0, Number(params.limit || 50))
            });
         });
      });
   });
}

function handleFindSamples(request) {
   var params = request.params;
   params.contentType = "Samples";
   selectTrack(request, params, function() {
      prepareBrowser(request, params, function() {
         scanBrowserResults(request, params.query, false, Number(params.limit || 50), function(matches, total) {
            popupBrowser.cancel();
            finish(request, true, {
               session: "Samples",
               totalSamplesAfterFilters: total,
               returned: Math.min(matches.length, Number(params.limit || 50)),
               matches: matches.slice(0, Number(params.limit || 50))
            });
         });
      });
   });
}

function handleInsertSample(request) {
   var params = request.params;
   params.contentType = "Samples";
   selectTrack(request, params, function() {
      var beforeCount = deviceBank.itemCount().get();
      prepareBrowser(request, params, function() {
         scanBrowserResults(request, params.exactName, true, 20, function(matches) {
            if (matches.length === 0) {
               popupBrowser.cancel();
               finish(request, false, { message: "No indexed sample named exactly ‘" + params.exactName + "’ was found in Bitwig's Samples browser." });
               return;
            }
            if (matches.length !== 1) {
               popupBrowser.cancel();
               finish(request, false, {
                  message: "Sample insertion refused because ‘" + params.exactName + "’ has " + matches.length + " exact matches.",
                  matches: matches
               });
               return;
            }

            var resultIndex = matches[0].resultIndex;
            var pageOffset = Math.floor(resultIndex / BROWSER_PAGE) * BROWSER_PAGE;
            var indexInPage = resultIndex - pageOffset;
            resultBank.scrollPosition().set(pageOffset);
            later(110, function() {
               try {
                  var item = resultBank.getItemAt(indexInPage);
                  if (!item.exists().get() || normalizeText(item.name().get()) !== normalizeText(params.exactName)) {
                     throw new Error("The Samples browser results changed before insertion. Nothing was loaded; try again.");
                  }
                  item.isSelected().set(true);
                  later(80, function() {
                     popupBrowser.commit();
                     later(1000, function() {
                        var afterCount = deviceBank.itemCount().get();
                        if (afterCount <= beforeCount) {
                           finish(request, false, { message: "Bitwig did not confirm a sampler device after loading the sample." });
                           return;
                        }
                        var devices = listDevicesNow();
                        var inserted = devices.devices[devices.devices.length - 1];
                        finish(request, true, {
                           insertedSample: params.exactName,
                           session: "Samples",
                           verifiedByDeviceChainReadback: true,
                           sampler: inserted,
                           devices: devices.devices
                        });
                     });
                  });
               } catch (error) {
                  popupBrowser.cancel();
                  finish(request, false, { message: String(error.message || error) });
               }
            });
         });
      });
   });
}

function handleInsertSampleFile(request) {
   var params = request.params;
   var path = String(params.path || "");
   if (path.charAt(0) !== "/" || !/\.(wav|aif|aiff|flac)$/i.test(path)) {
      throw new Error("Sample path must be an absolute WAV, AIFF, or FLAC file path.");
   }
   selectTrack(request, params, function() {
      var beforeCount = deviceBank.itemCount().get();
      cursorTrack.endOfDeviceChainInsertionPoint().insertFile(path);
      later(1200, function() {
         try {
            var afterCount = deviceBank.itemCount().get();
            if (afterCount <= beforeCount) throw new Error("Bitwig did not create a sampler device from ‘" + path + "’. Nothing was inserted.");
            var devices = listDevicesNow();
            var inserted = devices.devices[devices.devices.length - 1];
            if (!inserted || !inserted.sampleName) throw new Error("Bitwig created a device but did not confirm its loaded sample name.");
            finish(request, true, {
               insertedFile: path,
               verifiedByDeviceChainReadback: true,
               sampler: inserted,
               devices: devices.devices
            });
         } catch (error) {
            finish(request, false, { message: String(error.message || error) });
         }
      });
   });
}

function handleInsertDevice(request) {
   var params = request.params;
   selectTrack(request, params, function() {
      var beforeCount = deviceBank.itemCount().get();
      var beforeOccurrences = countDeviceName(params.exactName);
      prepareBrowser(request, params, function() {
         scanBrowserResults(request, params.exactName, true, 20, function(matches) {
            if (matches.length === 0) {
               popupBrowser.cancel();
               finish(request, false, { message: "No device named exactly ‘" + params.exactName + "’ was found in Bitwig's Devices browser." });
               return;
            }
            if (matches.length !== 1) {
               popupBrowser.cancel();
               finish(request, false, {
                  message: "Insertion refused because ‘" + params.exactName + "’ has " + matches.length + " exact device matches. Supply deviceType to disambiguate.",
                  matches: matches
               });
               return;
            }

            var resultIndex = matches[0].resultIndex;
            var pageOffset = Math.floor(resultIndex / BROWSER_PAGE) * BROWSER_PAGE;
            var indexInPage = resultIndex - pageOffset;
            resultBank.scrollPosition().set(pageOffset);
            later(110, function() {
               try {
                  var item = resultBank.getItemAt(indexInPage);
                  if (!item.exists().get() || normalizeText(item.name().get()) !== normalizeText(params.exactName)) {
                     throw new Error("The Browser results changed before insertion. Nothing was loaded; try again.");
                  }
                  item.isSelected().set(true);
                  later(80, function() {
                     popupBrowser.commit();
                     later(700, function() {
                        var afterCount = deviceBank.itemCount().get();
                        var afterOccurrences = countDeviceName(params.exactName);
                        if (afterCount <= beforeCount || afterOccurrences <= beforeOccurrences) {
                           finish(request, false, { message: "Bitwig did not confirm the new device in the chain. Refresh the device list before continuing." });
                           return;
                        }
                        var devices = listDevicesNow();
                        finish(request, true, {
                           inserted: params.exactName,
                           session: "Devices",
                           presetLoaded: false,
                           verifiedByDeviceChainReadback: true,
                           devices: devices.devices
                        });
                     });
                  });
               } catch (error) {
                  popupBrowser.cancel();
                  finish(request, false, { message: String(error.message || error) });
               }
            });
         });
      });
   });
}

function handleInsertClapDevice(request) {
   var params = request.params;
   var clapId = String(params.clapId || "").trim();
   if (!clapId) throw new Error("A CLAP plug-in ID is required.");
   var hasBeforeIndex = params.beforeDeviceIndex !== undefined && params.beforeDeviceIndex !== null;
   var hasBeforeName = params.beforeDeviceName !== undefined && params.beforeDeviceName !== null;
   if (hasBeforeIndex !== hasBeforeName) {
      throw new Error("beforeDeviceIndex and beforeDeviceName must be supplied together.");
   }

   selectTrack(request, params, function() {
      try {
         var beforeCount = deviceBank.itemCount().get();
         var insertionPoint = cursorTrack.endOfDeviceChainInsertionPoint();
         var insertedIndex = beforeCount;
         var target = null;
         if (hasBeforeIndex) {
            target = requireDevice({
               deviceIndex: params.beforeDeviceIndex,
               deviceName: params.beforeDeviceName
            });
            insertedIndex = Number(params.beforeDeviceIndex);
            insertionPoint = target.beforeDeviceInsertionPoint();
         }
         insertionPoint.insertCLAPDevice(clapId);
         later(1200, function() {
            try {
            var afterCount = deviceBank.itemCount().get();
            if (afterCount <= beforeCount) {
               throw new Error("Bitwig did not insert the CLAP device ‘" + clapId + "’. The plug-in may not be available to the current engine.");
            }
            var devices = listDevicesNow();
            finish(request, true, {
               insertedClapId: clapId,
               insertedBefore: target ? {
                  index: Number(params.beforeDeviceIndex),
                  name: String(params.beforeDeviceName)
               } : null,
               browserBypassed: true,
               verifiedByDeviceChainReadback: true,
               device: devices.devices[insertedIndex] || null,
               devices: devices.devices
            });
            } catch (error) {
               finish(request, false, { message: String(error.message || error) });
            }
         });
      } catch (error) {
         finish(request, false, { message: String(error.message || error) });
      }
   });
}

function handleInsertBitwigDevice(request) {
   var params = request.params;
   var bitwigId = String(params.bitwigId || "").trim();
   if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(bitwigId)) {
      throw new Error("A valid Bitwig device UUID is required.");
   }

   var hasBeforeIndex = params.beforeDeviceIndex !== undefined && params.beforeDeviceIndex !== null;
   var hasBeforeName = params.beforeDeviceName !== undefined && params.beforeDeviceName !== null;
   if (hasBeforeIndex !== hasBeforeName) {
      throw new Error("beforeDeviceIndex and beforeDeviceName must be supplied together.");
   }

   selectTrack(request, params, function() {
      try {
         var beforeCount = deviceBank.itemCount().get();
         var insertionPoint;
         var target = null;
         var insertedIndex = beforeCount;

         if (hasBeforeIndex) {
            target = requireDevice({
               deviceIndex: params.beforeDeviceIndex,
               deviceName: params.beforeDeviceName
            });
            insertedIndex = Number(params.beforeDeviceIndex);
            insertionPoint = target.beforeDeviceInsertionPoint();
         } else {
            insertionPoint = cursorTrack.endOfDeviceChainInsertionPoint();
         }

         insertionPoint.insertBitwigDevice(java.util.UUID.fromString(bitwigId));
         later(850, function() {
            try {
               var afterCount = deviceBank.itemCount().get();
               if (afterCount <= beforeCount) {
                  throw new Error("Bitwig did not insert stock device ‘" + bitwigId + "’ at the requested position.");
               }
               var devices = listDevicesNow();
               finish(request, true, {
                  insertedBitwigId: bitwigId,
                  insertedBefore: target ? {
                     index: Number(params.beforeDeviceIndex),
                     name: String(params.beforeDeviceName)
                  } : null,
                  verifiedByDeviceChainReadback: true,
                  device: devices.devices[insertedIndex] || null,
                  devices: devices.devices
               });
            } catch (error) {
               finish(request, false, { message: String(error.message || error) });
            }
         });
      } catch (error) {
         finish(request, false, { message: String(error.message || error) });
      }
   });
}

function handleNestDevice(request) {
   var params = request.params;
   selectTrack(request, params, function() {
      try {
         var parent = requireDevice({
            deviceIndex: params.parentDeviceIndex,
            deviceName: params.parentDeviceName
         });
         var child = requireDevice({
            deviceIndex: params.childDeviceIndex,
            deviceName: params.childDeviceName
         });
         if (Number(params.parentDeviceIndex) === Number(params.childDeviceIndex)) {
            throw new Error("A device cannot be nested inside itself.");
         }
         var beforeCount = deviceBank.itemCount().get();
         cursorDevice.selectDevice(parent);
         later(180, function() {
            try {
               var slotNames = arrayCopy(cursorDevice.slotNames().get());
               var requestedSlot = String(params.slotName || "Post FX");
               if (slotNames.indexOf(requestedSlot) === -1) {
                  throw new Error("Device ‘" + params.parentDeviceName + "’ does not expose the ‘" + requestedSlot + "’ slot. Available slots: " + slotNames.join(", "));
               }
               cursorDeviceSlot.selectInEditor();
               later(140, function() {
                  var currentSlot = cursorDeviceSlot.name().get();
                  if (currentSlot && currentSlot !== requestedSlot) {
                     finish(request, false, { message: "Bitwig selected slot ‘" + currentSlot + "’ instead of ‘" + requestedSlot + "’." });
                     return;
                  }
                  cursorDeviceSlot.endOfDeviceChainInsertionPoint().moveDevices(child);
                  later(850, function() {
                  try {
                     var topLevel = listDevicesNow();
                     var nested = listNestedDevicesNow();
                     if (topLevel.total !== beforeCount - 1) {
                        throw new Error("Bitwig did not move ‘" + params.childDeviceName + "’ into the parent device. The top-level chain was left unchanged.");
                     }
                     var nestedBankVerified = nested.total >= 1 && nested.devices[0].name === String(params.childDeviceName);
                     var cursorVerified = cursorDevice.exists().get() &&
                        cursorDevice.name().get() === String(params.childDeviceName) &&
                        cursorDevice.isNested().get();
                     if (!nestedBankVerified && !cursorVerified) {
                        throw new Error("Bitwig changed the chain but did not verify ‘" + params.childDeviceName + "’ inside ‘" + params.parentDeviceName + "’. Refresh before saving.");
                     }
                     parent.selectInEditor();
                     finish(request, true, {
                        nestedDevice: String(params.childDeviceName),
                        parentDevice: String(params.parentDeviceName),
                        slotName: requestedSlot,
                        topLevel: topLevel,
                        nested: nested,
                        verifiedByDeviceChainReadback: nestedBankVerified,
                        verifiedByNestedCursorReadback: cursorVerified
                     });
                  } catch (error) {
                     finish(request, false, { message: String(error.message || error) });
                  }
                  });
               });
            } catch (error) {
               finish(request, false, { message: String(error.message || error) });
            }
         });
      } catch (error) {
         finish(request, false, { message: String(error.message || error) });
      }
   });
}

// Bitwig's API can open the Save to Library dialog but can't see it or type
// into it. Enter goes to whatever has keyboard focus, so it is only pressed
// when the caller asks for it (confirm: true) and the same device is still
// selected on the same track right before the key press.
function handleSaveDevicePreset(request) {
   var params = request.params;
   if (!saveToLibraryAction) throw new Error("This Bitwig version has no Save to Library action, so the preset can't be saved from Bitwig Agent Bridge.");
   selectDevice(request, params, function(device) {
      try {
         var presetName = String(params.presetName || "").trim();
         var confirm = params.confirm === true;
         var trackName = cursorTrack.name().get();
         var deviceName = device.name().get();
         var devicePosition = device.position().get();
         var presetNameBefore = device.presetName().get();
         device.selectInEditor();
         later(180, function() {
            try {
               saveToLibraryAction.invoke();
               later(700, function() {
                  try {
                     if (confirm) {
                        var stillSelected = cursorTrack.name().get() === trackName &&
                           cursorDevice.exists().get() &&
                           cursorDevice.name().get() === deviceName &&
                           cursorDevice.position().get() === devicePosition;
                        if (!stillSelected) {
                           throw new Error("The selection changed while Bitwig's Save to Library dialog was opening, so Enter was not pressed. Check Bitwig and close the dialog if it is open.");
                        }
                        application.enter();
                     }
                     later(450, function() {
                        var presetNameAfter = device.presetName().get();
                        finish(request, true, {
                           device: deviceSnapshot(device, Number(params.deviceIndex)),
                           requestedPresetName: presetName,
                           saveToLibraryOpened: true,
                           confirmationSent: confirm,
                           presetNameBefore: presetNameBefore,
                           presetNameAfter: presetNameAfter,
                           note: confirm
                              ? "Bitwig doesn't report whether the dialog saved. A changed presetNameAfter is a good sign; check the Library to be sure."
                              : "The dialog is open in Bitwig. Type the name and press Save there.",
                           nameEntryRequired: !confirm && !!presetName,
                           suggestedPresetName: presetName || null
                        });
                     });
                  } catch (error) {
                     finish(request, false, { message: String(error.message || error) });
                  }
               });
            } catch (error) {
               finish(request, false, { message: String(error.message || error) });
            }
         });
      } catch (error) {
         finish(request, false, { message: String(error.message || error) });
      }
   });
}

// Re-reads Bitwig until check() reports no mismatch (returns "") or about a
// second passes, then fails the request with what Bitwig actually holds.
function verifyReadback(request, check, onVerified, attempt) {
   attempt = attempt || 1;
   later(100, function() {
      var mismatch = check();
      if (!mismatch) {
         onVerified();
      } else if (attempt >= 10) {
         finish(request, false, { message: "Bitwig did not confirm the change: " + mismatch });
      } else {
         verifyReadback(request, check, onVerified, attempt + 1);
      }
   });
}

function differs(actual, requested, tolerance) {
   return !(Math.abs(Number(actual) - Number(requested)) <= tolerance);
}

function handleTransport(request) {
   var params = request.params;
   var action = String(params.action || "status");
   if (action === "play") transport.play();
   else if (action === "stop") transport.stop();
   else if (action === "toggle") transport.togglePlay();
   else if (action === "set_tempo") {
      var tempo = Number(params.tempo);
      if (!(tempo >= 20 && tempo <= 666)) throw new Error("Tempo must be between 20 and 666 BPM.");
      transport.tempo().value().setRaw(tempo);
      verifyReadback(request, function() {
         var actual = transport.tempo().value().getRaw();
         return differs(actual, tempo, 0.01) ? "tempo is " + actual + " BPM, requested " + tempo + " BPM." : "";
      }, function() {
         finish(request, true, readTransport());
      });
      return;
   } else if (action === "set_position") {
      var position = Number(params.positionBeats);
      if (!(position >= 0)) throw new Error("Position must be zero or greater.");
      transport.setPosition(position);
   } else if (action !== "status") throw new Error("Unknown transport action: " + action);

   later(action === "status" ? 1 : 100, function() {
      finish(request, true, readTransport());
   });
}

function handleCueMarkers(request) {
   var params = request.params;
   var action = String(params.action || "list");
   if (action === "list") {
      finish(request, true, listCueMarkers());
      return;
   }
   if (action !== "upsert") throw new Error("Cue marker action must be list or upsert.");

   var specifications = params.markers || [];
   if (!specifications.length) throw new Error("At least one cue marker is required.");
   if (specifications.length > 64) throw new Error("A maximum of 64 cue markers can be created at once.");

   var normalized = [];
   var seenPositions = {};
   for (var specificationIndex = 0; specificationIndex < specifications.length; specificationIndex++) {
      var requested = specifications[specificationIndex];
      var markerName = String(requested.name || "").trim();
      var markerPosition = Number(requested.positionBeats);
      if (!markerName) throw new Error("Cue marker names must not be empty.");
      if (!(markerPosition >= 0)) throw new Error("Cue marker positions must be zero or greater.");
      var positionKey = markerPosition.toFixed(6);
      if (seenPositions[positionKey]) throw new Error("Cue marker positions must be unique within one request.");
      seenPositions[positionKey] = true;
      normalized.push({ name: markerName, positionBeats: markerPosition });
   }

   var created = 0;
   var updated = 0;
   var current = 0;
   var originalTransportPosition = transport.getPosition().get();
   var movedPlayhead = false;
   // A new marker at the playhead itself goes last, so it cannot sit under the
   // playhead while the other new markers are added.
   normalized.sort(function(left, right) {
      return Number(Math.abs(left.positionBeats - originalTransportPosition) < 0.0001) -
         Number(Math.abs(right.positionBeats - originalTransportPosition) < 0.0001);
   });
   var temporaryPosition = 64;
   var existingMarkers = listCueMarkers().markers;
   for (var existingIndex = 0; existingIndex < existingMarkers.length; existingIndex++) {
      temporaryPosition = Math.max(temporaryPosition, existingMarkers[existingIndex].positionBeats + 64);
   }
   for (var requestedIndex = 0; requestedIndex < normalized.length; requestedIndex++) {
      temporaryPosition = Math.max(temporaryPosition, normalized[requestedIndex].positionBeats + 64);
   }

   // Bitwig 18 can only add a cue marker at the play position, so new markers
   // are added where the playhead already is and then moved into place. The
   // playhead is moved only when the transport is stopped and a marker already
   // sits under it, and it is put back before the reply.
   function restorePlayhead() {
      if (movedPlayhead) transport.setPosition(originalTransportPosition);
   }

   function fail(error) {
      restorePlayhead();
      finish(request, false, { message: String(error.message || error), cueMarkers: listCueMarkers() });
   }

   function verifyAndFinish() {
      restorePlayhead();
      later(movedPlayhead ? 220 : 120, function() {
         try {
            var verified = [];
            var missing = [];
            for (var verifyIndex = 0; verifyIndex < normalized.length; verifyIndex++) {
               var expected = normalized[verifyIndex];
               var match = cueMarkerAtPosition(expected.positionBeats);
               if (match && match.marker.name().get() === expected.name) {
                  verified.push(cueMarkerSnapshot(match.marker, match.index));
               } else {
                  missing.push(expected);
               }
            }
            if (missing.length) {
               finish(request, false, {
                  message: "Bitwig did not verify every requested cue marker.",
                  missing: missing,
                  cueMarkers: listCueMarkers()
               });
               return;
            }
            finish(request, true, {
               created: created,
               updated: updated,
               verified: verified.length,
               markers: verified,
               cueMarkers: listCueMarkers()
            });
         } catch (error) {
            finish(request, false, { message: String(error.message || error) });
         }
      });
   }

   function addAndPlace(expected) {
      var beforeCounts = cueMarkerFingerprintCounts();
      var beforeTotal = cueMarkerBank.itemCount().get();
      transport.addCueMarkerAtPlaybackPosition();
      var identifyAttempt = 0;

      function identifyInsertedMarker() {
         try {
            var afterTotal = cueMarkerBank.itemCount().get();
            if (afterTotal <= beforeTotal) {
               if (identifyAttempt++ < 20) {
                  later(100, identifyInsertedMarker);
                  return;
               }
               throw new Error("Bitwig did not create a new cue marker at the play position.");
            }

            var afterSeen = {};
            var inserted = null;
            var count = Math.min(afterTotal, MAX_CUE_MARKERS);
            for (var markerIndex = 0; markerIndex < count; markerIndex++) {
               var marker = cueMarkerBank.getItemAt(markerIndex);
               if (!marker.exists().get()) continue;
               var fingerprint = JSON.stringify([marker.name().get(), marker.position().get()]);
               afterSeen[fingerprint] = Number(afterSeen[fingerprint] || 0) + 1;
               if (!inserted && afterSeen[fingerprint] > Number(beforeCounts[fingerprint] || 0)) {
                  inserted = marker;
               }
            }
            if (!inserted) throw new Error("Bitwig created a cue marker but the bridge could not identify it.");

            inserted.name().set(expected.name);
            inserted.position().set(expected.positionBeats);
            created++;
            later(240, processNext);
         } catch (error) {
            fail(error);
         }
      }
      later(100, identifyInsertedMarker);
   }

   function addAtTemporaryPosition(expected) {
      var insertionPosition = temporaryPosition;
      temporaryPosition += 4;
      movedPlayhead = true;
      transport.setPosition(insertionPosition);
      var positionAttempt = 0;

      function waitForInsertionPosition() {
         try {
            if (Math.abs(transport.getPosition().get() - insertionPosition) >= 0.0001) {
               if (positionAttempt++ < 20) {
                  later(100, waitForInsertionPosition);
                  return;
               }
               throw new Error("Bitwig did not verify the temporary cue-marker insertion position.");
            }
            addAndPlace(expected);
         } catch (error) {
            fail(error);
         }
      }
      later(100, waitForInsertionPosition);
   }

   function processNext() {
      try {
         if (current >= normalized.length) {
            verifyAndFinish();
            return;
         }

         var expected = normalized[current++];
         var existing = cueMarkerAtPosition(expected.positionBeats);
         if (existing) {
            existing.marker.name().set(expected.name);
            existing.marker.position().set(expected.positionBeats);
            updated++;
            later(160, processNext);
            return;
         }

         if (!transport.isPlaying().get() && cueMarkerAtPosition(transport.getPosition().get())) {
            addAtTemporaryPosition(expected);
            return;
         }
         addAndPlace(expected);
      } catch (error) {
         fail(error);
      }
   }

   arranger.areCueMarkersVisible().set(true);
   later(180, processNext);
}

// Names of the tracks or devices a bank shows, in order, for before/after
// comparisons around a create or delete.
function bankNames(bank, limit) {
   var count = Math.min(bank.itemCount().get(), limit);
   var names = [];
   for (var index = 0; index < count; index++) {
      var item = bank.getItemAt(index);
      names.push(item.exists().get() ? String(item.name().get()) : null);
   }
   return names;
}

// Where `after` equals `before` with one item inserted, returns that item's
// index. Returns -1 when the lists differ in some other way, and null when the
// new item's name matches a neighbour so its position cannot be told apart.
function insertedIndex(before, after) {
   if (after.length !== before.length + 1) return -1;
   var prefix = 0;
   while (prefix < before.length && before[prefix] === after[prefix]) prefix++;
   var suffix = 0;
   while (suffix < before.length && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix++;
   if (prefix + suffix < before.length) return -1;
   return prefix + suffix === before.length ? prefix : null;
}

// Where the bank lost `removed` items starting at `index` and everything else
// kept its order, returns true. Only the names the bank shows are compared, so
// this also works when the project has more items than the bank can reach.
function isRemovedRun(before, after, index, removed) {
   if (removed < 1 || index + removed > before.length) return false;
   for (var i = 0; i < index; i++) {
      if (before[i] !== after[i]) return false;
   }
   for (var j = index; j < after.length && j + removed < before.length; j++) {
      if (before[j + removed] !== after[j]) return false;
   }
   return true;
}

function handleCreateTrack(request) {
   var params = request.params;
   var effect = params.kind === "effect";
   if (params.kind !== "instrument" && params.kind !== "audio" && !effect) {
      throw new Error("Track kind must be instrument, audio, or effect.");
   }
   var bank = effect ? effectTrackBank : trackBank;
   var limit = effect ? MAX_EFFECT_TRACKS : MAX_TRACKS;
   var before = bankNames(bank, limit);
   if (bank.itemCount().get() >= limit) {
      throw new Error("The project already has " + bank.itemCount().get() + " " + (effect ? "effect" : "main") +
         " tracks, and Bitwig Agent Bridge can reach only the first " + limit + ". No track was created.");
   }
   if (params.kind === "instrument") application.createInstrumentTrack(-1);
   else if (params.kind === "audio") application.createAudioTrack(-1);
   else application.createEffectTrack(-1);

   var attempt = 0;
   function locate() {
      try {
         var after = bankNames(bank, limit);
         var index = insertedIndex(before, after);
         if (index !== -1 && index !== null) {
            nameTrack(index);
            return;
         }
         if (attempt++ < 20) {
            later(100, locate);
            return;
         }
         if (index === -1) {
            throw new Error("Bitwig did not show exactly one new track in the " + (effect ? "effect" : "main") +
               " track list, so the new track was left unnamed. Check the project with bitwig_tracks.");
         }
         throw new Error("Bitwig gave the new track the same name as the track next to it, " +
            "so the bridge cannot tell which one is new. It was left unnamed.");
      } catch (error) {
         finish(request, false, { message: String(error.message || error) });
      }
   }

   function nameTrack(index) {
      var track = bank.getItemAt(index);
      track.setName(String(params.name));
      if (!effect) track.selectInMixer();
      var nameAttempt = 0;
      function verifyName() {
         try {
            if (track.name().get() !== String(params.name)) {
               if (nameAttempt++ < 10) {
                  later(100, verifyName);
                  return;
               }
               throw new Error("Bitwig created the track at index " + index + " but did not apply the name ‘" + params.name + "’.");
            }
            var created = trackSnapshot(track, index, effect ? "effect" : "main");
            created.kind = params.kind;
            if (effect) created.effectTrackIndex = index;
            finish(request, true, { created: created, emptyDeviceChain: true, presetLoaded: false });
         } catch (error) {
            finish(request, false, { message: String(error.message || error) });
         }
      }
      later(140, verifyName);
   }
   later(200, locate);
}

// Deletes one track or device and checks Bitwig's list afterwards: the item
// must be gone and everything else must still be in the same order.
function deleteAndVerify(request, bank, limit, index, item, deleted, what) {
   var before = bankNames(bank, limit);
   var totalBefore = bank.itemCount().get();
   item.deleteObject();
   var attempt = 0;
   function verify() {
      try {
         var after = bankNames(bank, limit);
         var removed = totalBefore - bank.itemCount().get();
         if (!isRemovedRun(before, after, index, removed)) {
            if (attempt++ < 20) {
               later(100, verify);
               return;
            }
            finish(request, false, {
               message: "Bitwig did not confirm that the " + what + " ‘" + deleted.name + "’ was removed and the rest left in place. Check it in Bitwig.",
               previousCount: totalBefore,
               verifiedCount: bank.itemCount().get()
            });
            return;
         }
         var payload = { deleted: deleted, previousCount: totalBefore, verifiedCount: totalBefore - removed, removedCount: removed };
         if (removed > 1) payload.note = "Bitwig removed " + removed + " " + what + "s; a group takes its contents with it.";
         finish(request, true, payload);
      } catch (error) {
         finish(request, false, { message: String(error.message || error) });
      }
   }
   later(250, verify);
}

function markSlot(slot) {
   interested(slot.exists());
   interested(slot.name());
   interested(slot.hasContent());
   interested(slot.isSelected());
   interested(slot.isPlaying());
}

function clipSnapshot(slot, slotIndex) {
   return {
      slotIndex: slotIndex,
      exists: slot.exists().get(),
      name: slot.name().get(),
      hasContent: slot.hasContent().get(),
      selected: slot.isSelected().get(),
      playing: slot.isPlaying().get()
   };
}

function requireLevel(value, max, label) {
   var db = Number(value);
   if (!(db >= MIN_LEVEL_DB && db <= max)) throw new Error(label + " must be from " + MIN_LEVEL_DB + " to " + max + " dB; use mute for silence.");
   return db;
}

// Validates a set_track request completely before anything changes.
function parseTrackChanges(params, target) {
   var changes = { sends: [] };
   var any = false;
   if (params.name !== undefined) {
      var name = String(params.name).trim();
      if (!name || name.length > 120) throw new Error("Track name must contain 1 to 120 characters.");
      if (target.kind === "master") throw new Error("The master track cannot be renamed.");
      var taken = trackIndicesNamed(name, target.bank, target.limit);
      for (var t = 0; t < taken.length; t++) {
         if (taken[t] !== target.index) {
            throw new Error((target.kind === "effect" ? "Effect track " : "Track ") + taken[t] + " is already named ‘" + name + "’. Pick a unique name so tools can tell the tracks apart.");
         }
      }
      changes.name = name;
      any = true;
   }
   if (params.color !== undefined) {
      changes.color = parseHexColor(params.color, "Track color");
      any = true;
   }
   if (params.volumeDb !== undefined) {
      changes.volumeDb = requireLevel(params.volumeDb, MAX_TRACK_VOLUME_DB, "Track volume");
      any = true;
   }
   if (params.pan !== undefined) {
      var pan = Number(params.pan);
      if (!(pan >= -1 && pan <= 1)) throw new Error("Track pan must be from -1 (left) to 1 (right).");
      changes.pan = pan;
      any = true;
   }
   var switches = ["mute", "solo", "arm"];
   for (var w = 0; w < switches.length; w++) {
      if (params[switches[w]] === undefined) continue;
      if (switches[w] === "arm" && target.kind !== "main") throw new Error("Only main tracks can be armed.");
      changes[switches[w]] = Boolean(params[switches[w]]);
      any = true;
   }
   var sends = params.sends || [];
   if (!Array.isArray(sends)) throw new Error("sends must be an array.");
   if (sends.length && target.kind !== "main") throw new Error("Sends can only be set on main tracks.");
   var seen = {};
   for (var i = 0; i < sends.length; i++) {
      var request = sends[i] || {};
      var sendIndex = Number(request.sendIndex);
      if (!(sendIndex >= 0 && sendIndex < MAX_SENDS) || Math.floor(sendIndex) !== sendIndex) {
         throw new Error("Send index must be a whole number from 0 to " + (MAX_SENDS - 1) + ".");
      }
      if (seen[sendIndex]) throw new Error("Send " + sendIndex + " is listed twice.");
      seen[sendIndex] = true;
      var send = target.track.sendBank().getItemAt(sendIndex);
      if (!send.exists().get()) throw new Error("Track ‘" + target.track.name().get() + "’ has no send " + sendIndex + ". Refresh with bitwig_tracks.");
      if (send.name().get() !== String(request.sendName)) {
         throw new Error("Safety check failed: send " + sendIndex + " goes to ‘" + send.name().get() + "’, not ‘" + request.sendName + "’. Refresh first.");
      }
      var change = { index: sendIndex, send: send };
      if (request.levelDb !== undefined) change.levelDb = requireLevel(request.levelDb, MAX_SEND_DB, "Send level");
      if (request.enabled !== undefined) change.enabled = Boolean(request.enabled);
      if (request.mode !== undefined) {
         change.mode = String(request.mode);
         if (SEND_MODES.indexOf(change.mode) === -1) throw new Error("Send mode must be AUTO, PRE or POST.");
      }
      if (change.levelDb === undefined && change.enabled === undefined && change.mode === undefined) {
         throw new Error("Send " + sendIndex + " has nothing to change: pass levelDb, enabled or mode.");
      }
      changes.sends.push(change);
      any = true;
   }
   if (!any) throw new Error("Nothing to change: pass name, color, volumeDb, pan, mute, solo, arm or sends.");
   return changes;
}

function trackChangeProblems(track, changes) {
   var problems = [];
   if (changes.name !== undefined && track.name().get() !== changes.name) {
      problems.push("name is ‘" + track.name().get() + "’, requested ‘" + changes.name + "’");
   }
   if (changes.color && !sameColor(track.color(), changes.color)) {
      problems.push("color is " + colorHex(track.color()) + ", requested " + changes.color.hex);
   }
   if (changes.volumeDb !== undefined) {
      var volume = levelDb(track.volume().getRaw());
      if (volume === null || differs(volume, changes.volumeDb, LEVEL_TOLERANCE_DB)) {
         problems.push("volume is " + track.volume().displayedValue().get() + ", requested " + changes.volumeDb + " dB");
      }
   }
   if (changes.pan !== undefined && differs(track.pan().getRaw(), changes.pan, PAN_TOLERANCE)) {
      problems.push("pan is " + roundTo(track.pan().getRaw(), 4) + ", requested " + changes.pan);
   }
   // Bitwig's script host only supports direct method calls on these values.
   if (changes.mute !== undefined && track.mute().get() !== changes.mute) problems.push("mute is " + track.mute().get() + ", requested " + changes.mute);
   if (changes.solo !== undefined && track.solo().get() !== changes.solo) problems.push("solo is " + track.solo().get() + ", requested " + changes.solo);
   if (changes.arm !== undefined && track.arm().get() !== changes.arm) problems.push("arm is " + track.arm().get() + ", requested " + changes.arm);
   for (var i = 0; i < changes.sends.length; i++) {
      var change = changes.sends[i];
      var send = change.send;
      var label = "send " + change.index + " (" + send.name().get() + ")";
      if (change.levelDb !== undefined) {
         var level = levelDb(send.getRaw());
         if (level === null || differs(level, change.levelDb, LEVEL_TOLERANCE_DB)) {
            problems.push(label + " level is " + send.displayedValue().get() + ", requested " + change.levelDb + " dB");
         }
      }
      if (change.enabled !== undefined && send.isEnabled().get() !== change.enabled) {
         problems.push(label + " is " + (send.isEnabled().get() ? "enabled" : "disabled") + ", requested " + (change.enabled ? "enabled" : "disabled"));
      }
      if (change.mode !== undefined && String(send.sendMode().get()) !== change.mode) {
         problems.push(label + " mode is " + send.sendMode().get() + ", requested " + change.mode);
      }
   }
   return problems.join("; ");
}

// Sets name, color, volume, pan, mute, solo, arm and sends on one track,
// then reads every requested value back.
function handleSetTrack(request) {
   var params = request.params;
   var target = requireChannel(params, params.name !== undefined);
   var changes = parseTrackChanges(params, target);
   var track = target.track;
   if (changes.name !== undefined) track.setName(changes.name);
   if (changes.color) track.color().set(changes.color.red, changes.color.green, changes.color.blue);
   if (changes.volumeDb !== undefined) track.volume().setRaw(levelRaw(changes.volumeDb));
   if (changes.pan !== undefined) track.pan().setRaw(changes.pan);
   if (changes.mute !== undefined) track.mute().set(changes.mute);
   if (changes.solo !== undefined) track.solo().set(changes.solo);
   if (changes.arm !== undefined) track.arm().set(changes.arm);
   for (var i = 0; i < changes.sends.length; i++) {
      var change = changes.sends[i];
      // Setting a level switches a disabled send on (measured in Bitwig
      // 6.1.7), so the requested on/off state is applied after the level.
      if (change.levelDb !== undefined) change.send.setRaw(levelRaw(change.levelDb));
      if (change.enabled !== undefined) change.send.isEnabled().set(change.enabled);
      if (change.mode !== undefined) change.send.sendMode().set(change.mode);
   }
   verifyReadback(request, function() {
      return trackChangeProblems(track, changes);
   }, function() {
      finish(request, true, { trackKind: target.kind, track: trackSnapshot(track, target.index, target.kind) });
   });
}

// Bitwig shows MAX_SCENES launcher slots at a time. This scrolls that window
// until slotIndex is in view and calls callback(item, localIndex), where item
// is the track's slot, or the scene when track is null. The window goes back to
// the first scenes when the request ends.
function withSceneSlot(request, track, slotIndex, callback) {
   var sceneCount = sceneBank.itemCount().get();
   if (slotIndex >= sceneCount) {
      throw new Error("Slot " + slotIndex + " does not exist. The project has " + sceneCount + " scenes, so slots run from 0 to " + (sceneCount - 1) + ".");
   }
   // Run after any cleanup the request already has, such as putting the
   // selection back, and only add it once per request.
   if (!request.sceneWindowCleanup) {
      request.sceneWindowCleanup = true;
      var previousCleanup = request.cleanup;
      request.cleanup = function() {
         resetSceneWindow();
         if (previousCleanup) previousCleanup();
      };
   }
   var target = Math.floor(slotIndex / MAX_SCENES) * MAX_SCENES;
   var attempts = 0;
   function showSlot() {
      var position = sceneBank.scrollPosition().get();
      if (slotIndex >= position && slotIndex < position + MAX_SCENES) {
         var localIndex = slotIndex - position;
         callback(track ? track.clipLauncherSlotBank().getItemAt(localIndex) : sceneBank.getItemAt(localIndex), localIndex);
         return;
      }
      if (attempts++ >= 20) throw new Error("Bitwig did not scroll its scene window to slot " + slotIndex + ".");
      sceneBank.scrollPosition().set(target);
      later(50, showSlot);
   }
   showSlot();
}

function resetSceneWindow() {
   if (sceneBank.scrollPosition().get() !== 0) sceneBank.scrollPosition().set(0);
}

function requireSlotIndex(value, label) {
   var slotIndex = Number(value);
   if (!(slotIndex >= 0 && slotIndex < MAX_SCENE_SLOTS) || Math.floor(slotIndex) !== slotIndex) {
      throw new Error(label + " slot must be a whole number from 0 to " + (MAX_SCENE_SLOTS - 1) + ".");
   }
   return slotIndex;
}

// ------------------------------------------------------------ clips & notes
//
// Bitwig exposes clip notes only through a step grid: a window of
// CLIP_GRID_WIDTH steps by CLIP_GRID_HEIGHT keys on the launcher cursor clip,
// scrolled across the clip. A note is addressed by the grid cell its start
// falls in (channel, step, pitch). A note that starts between two steps reads
// back at the step it starts in, so off-grid timing survives only when the
// clip is read and written with a fine enough grid (stepsPerBeat).

// Note-start cells Bitwig reports for the launcher cursor clip's visible grid
// window, keyed "channel:x:pitch". init() registers onLauncherNoteStep, so the
// map follows every scroll; reads confirm each cell with getStep() before use.
var launcherNoteCells = {};

function onLauncherNoteStep(step) {
   var key = step.channel() + ":" + step.x() + ":" + step.y();
   if (String(step.state()) === "NoteOn") launcherNoteCells[key] = true;
   else delete launcherNoteCells[key];
}

function roundTo(value, digits) {
   var factor = Math.pow(10, digits);
   return Math.round(Number(value) * factor) / factor;
}

function requireStepsPerBeat(value) {
   var stepsPerBeat = value === undefined || value === null ? DEFAULT_STEPS_PER_BEAT : Number(value);
   if (!(stepsPerBeat >= 1 && stepsPerBeat <= MAX_STEPS_PER_BEAT) || Math.floor(stepsPerBeat) !== stepsPerBeat) {
      throw new Error("stepsPerBeat must be a whole number from 1 to " + MAX_STEPS_PER_BEAT + ".");
   }
   return stepsPerBeat;
}

function requireBeats(value, label, allowZero) {
   var beats = Number(value);
   if (!(allowZero ? beats >= 0 : beats > 0) || beats > MAX_CLIP_BEATS) {
      throw new Error(label + " must be " + (allowZero ? "from 0" : "greater than 0") + " to " + MAX_CLIP_BEATS + " beats.");
   }
   return beats;
}

function requireGridSpan(endBeats, stepsPerBeat) {
   if (endBeats * stepsPerBeat > MAX_GRID_STEPS) {
      throw new Error("A clip span of " + roundTo(endBeats, 6) + " beats at " + stepsPerBeat + " steps per beat is " +
         Math.ceil(endBeats * stepsPerBeat) + " grid steps, over the " + MAX_GRID_STEPS + "-step limit. Use a smaller stepsPerBeat.");
   }
}

function parseHexColor(value, label) {
   var match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(value || ""));
   if (!match) throw new Error(label + " must be a #RRGGBB color.");
   return {
      hex: "#" + match.slice(1).join("").toUpperCase(),
      red: parseInt(match[1], 16) / 255,
      green: parseInt(match[2], 16) / 255,
      blue: parseInt(match[3], 16) / 255
   };
}

function colorHex(colorValue) {
   function channel(component) {
      var hex = Math.max(0, Math.min(255, Math.round(Number(component) * 255))).toString(16).toUpperCase();
      return hex.length < 2 ? "0" + hex : hex;
   }
   return "#" + channel(colorValue.red()) + channel(colorValue.green()) + channel(colorValue.blue());
}

// Bitwig stores colors with slightly less than 8-bit precision per channel
// (#E0A030 reads back as #E0A02F), so one step per channel counts as equal.
function sameColor(colorValue, requested) {
   return Math.abs(colorValue.red() - requested.red) <= COLOR_TOLERANCE &&
      Math.abs(colorValue.green() - requested.green) <= COLOR_TOLERANCE &&
      Math.abs(colorValue.blue() - requested.blue) <= COLOR_TOLERANCE;
}

function noteCell(channel, step, pitch) {
   return channel + ":" + step + ":" + pitch;
}

function noteLabel(note, stepsPerBeat) {
   return "pitch " + note.pitch + " at beat " + roundTo(note.step / stepsPerBeat, 6) + " (channel " + note.channel + ")";
}

// Validates one requested note. Returns its grid cell and only the fields the
// request set; defaults are the caller's business, because an update keeps
// the fields it does not name.
function parseNote(note, index, stepsPerBeat, endBeats, requireAll) {
   note = note || {};
   var beat = Number(note.beat);
   var pitch = Number(note.pitch);
   var channel = note.channel === undefined ? 0 : Number(note.channel);
   var step = Math.round(beat * stepsPerBeat);
   var where = "Note " + index + " (pitch " + note.pitch + " at beat " + note.beat + ")";
   if (!(beat >= 0 && beat < endBeats)) throw new Error(where + " must start between beat 0 and the clip end at beat " + endBeats + ".");
   if (Math.abs(step / stepsPerBeat - beat) > 0.000001) {
      throw new Error(where + " does not start on the 1/" + stepsPerBeat + "-beat grid. Use a larger stepsPerBeat.");
   }
   if (!(pitch >= 0 && pitch <= 127) || Math.floor(pitch) !== pitch) throw new Error(where + " has an invalid MIDI pitch.");
   if (!(channel >= 0 && channel <= 15) || Math.floor(channel) !== channel) throw new Error(where + " has an invalid MIDI channel.");
   var parsed = { step: step, pitch: pitch, channel: channel, fields: {} };
   if (note.velocity !== undefined) {
      var velocity = Number(note.velocity);
      if (!(velocity >= 1 && velocity <= 127) || Math.floor(velocity) !== velocity) throw new Error(where + " has an invalid velocity.");
      parsed.fields.velocity = velocity;
   }
   if (note.duration !== undefined) {
      var duration = Number(note.duration);
      if (!(duration > 0 && beat + duration <= endBeats + 0.000001)) {
         throw new Error(where + " needs a duration greater than 0 that ends by the clip end at beat " + endBeats + ".");
      }
      parsed.fields.duration = duration;
   } else if (requireAll) {
      throw new Error(where + " needs a duration.");
   }
   for (var name in NOTE_EXPRESSIONS) {
      if (note[name] === undefined) continue;
      var range = NOTE_EXPRESSIONS[name];
      var amount = Number(note[name]);
      if (!(amount >= range[0] && amount <= range[1])) throw new Error(where + " has " + name + " " + note[name] + "; it must be from " + range[0] + " to " + range[1] + ".");
      parsed.fields[name] = amount;
   }
   if (note.gainDb !== undefined) {
      var db = Number(note.gainDb);
      if (!(db >= NOTE_GAIN_DB_RANGE[0] && db <= NOTE_GAIN_DB_RANGE[1])) {
         throw new Error(where + " has gainDb " + note.gainDb + "; it must be from " + NOTE_GAIN_DB_RANGE[0] + " to " + NOTE_GAIN_DB_RANGE[1] + " dB. Use muted for silence.");
      }
      parsed.fields.gain = gainFromDb(db);
   }
   if (note.muted !== undefined) parsed.fields.muted = Boolean(note.muted);
   return parsed;
}

function gainFromDb(db) {
   return Math.pow(10, db / 60) / 2;
}

function dbFromGain(gain) {
   return gain > 0 ? roundTo(60 * Math.log(2 * gain) / Math.LN10, 2) : null;
}

function parseNoteList(notes, stepsPerBeat, endBeats, requireAll) {
   if (!Array.isArray(notes)) throw new Error("Notes must be an array.");
   if (notes.length > MAX_CLIP_NOTES) throw new Error("A request can contain at most " + MAX_CLIP_NOTES + " notes.");
   var parsed = [];
   var seen = {};
   for (var i = 0; i < notes.length; i++) {
      var note = parseNote(notes[i], i, stepsPerBeat, endBeats, requireAll);
      var cell = noteCell(note.channel, note.step, note.pitch);
      if (seen[cell] !== undefined) {
         throw new Error("Notes " + seen[cell] + " and " + i + " both start at " + noteLabel(note, stepsPerBeat) + "; Bitwig keeps one note per grid cell.");
      }
      seen[cell] = i;
      parsed.push(note);
   }
   return parsed;
}

// Reads every note in the launcher cursor clip that starts before endBeats.
function readClipNotes(stepsPerBeat, endBeats, callback) {
   var stepCount = Math.ceil(endBeats * stepsPerBeat - 0.000001);
   var notes = [];
   launcherClip.setStepSize(1 / stepsPerBeat);
   launcherClip.scrollToKey(0);

   function readPage(pageStart) {
      if (pageStart >= stepCount) {
         launcherClip.scrollToStep(0);
         notes.sort(function(a, b) { return a.step - b.step || a.pitch - b.pitch || a.channel - b.channel; });
         callback(null, notes);
         return;
      }
      launcherClip.scrollToStep(pageStart);
      later(NOTE_PAGE_SETTLE_MS, function() {
         try {
            var keys = Object.keys(launcherNoteCells);
            for (var i = 0; i < keys.length; i++) {
               var parts = keys[i].split(":");
               var channel = Number(parts[0]);
               var x = Number(parts[1]);
               var pitch = Number(parts[2]);
               if (pageStart + x >= stepCount) continue;
               var step = launcherClip.getStep(channel, x, pitch);
               if (String(step.state()) !== "NoteOn") continue;
               notes.push(noteFromStep(step, pageStart + x, stepsPerBeat));
            }
            readPage(pageStart + CLIP_GRID_WIDTH);
         } catch (error) {
            callback(error);
         }
      });
   }

   readPage(0);
}

function noteFromStep(step, absoluteStep, stepsPerBeat) {
   return {
      step: absoluteStep,
      beat: roundTo(absoluteStep / stepsPerBeat, 6),
      pitch: step.y(),
      channel: step.channel(),
      velocity: Math.max(1, Math.min(127, Math.round(step.velocity() * 127))),
      duration: roundTo(step.duration(), 6),
      timbre: roundTo(step.timbre(), 4),
      pan: roundTo(step.pan(), 4),
      gain: roundTo(step.gain() / NOTE_GAIN_READ_SCALE, 6),
      muted: step.isMuted()
   };
}

// Notes as tools return them: without the internal step number.
function publicNotes(notes) {
   var result = [];
   for (var i = 0; i < notes.length; i++) {
      var note = notes[i];
      result.push({
         beat: note.beat, pitch: note.pitch, channel: note.channel, velocity: note.velocity, duration: note.duration,
         timbre: note.timbre, pan: note.pan, gainDb: dbFromGain(note.gain), muted: note.muted
      });
   }
   return result;
}

// Compares the notes Bitwig holds with the notes expected after a change.
// Every field an expected note carries must match; notes nobody asked for
// count as unexpected. Returns one line per difference.
function compareNotes(expected, actual, stepsPerBeat) {
   var byCell = {};
   for (var a = 0; a < actual.length; a++) byCell[noteCell(actual[a].channel, actual[a].step, actual[a].pitch)] = actual[a];
   var used = {};
   var problems = [];
   for (var e = 0; e < expected.length; e++) {
      var want = expected[e];
      var cell = noteCell(want.channel, want.step, want.pitch);
      var got = byCell[cell];
      if (!got) {
         problems.push(noteLabel(want, stepsPerBeat) + " is missing");
         continue;
      }
      used[cell] = true;
      var diffs = [];
      for (var field in want.fields) {
         var requested = want.fields[field];
         var held = got[field];
         var tolerance = field === "duration" ? 0.0001 : NOTE_EXPRESSIONS[field] || field === "gain" ? NOTE_EXPRESSION_TOLERANCE : 0;
         var same = typeof requested === "boolean" ? held === requested : Math.abs(Number(held) - requested) <= tolerance;
         if (!same) {
            if (field === "muted") diffs.push(requested ? "note is not muted" : "note is muted");
            else if (field === "gain") diffs.push("gainDb is " + (held > 0 ? dbFromGain(held) : "0 or unset (Bitwig reads 0)") + ", requested " + dbFromGain(requested));
            else diffs.push(field + " is " + held + ", requested " + requested);
         }
      }
      if (diffs.length) problems.push(noteLabel(want, stepsPerBeat) + ": " + diffs.join(", "));
   }
   for (var u = 0; u < actual.length; u++) {
      var extra = actual[u];
      if (!used[noteCell(extra.channel, extra.step, extra.pitch)]) problems.push("unexpected " + noteLabel(extra, stepsPerBeat));
   }
   return problems;
}

function describeProblems(problems) {
   var shown = problems.slice(0, 5).join("; ");
   return shown + (problems.length > 5 ? "; and " + (problems.length - 5) + " more" : "") + ".";
}

// Applies note operations. Each operation is one of
//   { kind: "create", step, pitch, channel, fields }   new note (setStep)
//   { kind: "update", step, pitch, channel, fields }   change an existing note
//   { kind: "remove", step, pitch, channel }           delete a note
// It runs in two passes over the grid pages: removes and creates first, then
// the NoteStep setters once Bitwig shows the new notes on the grid.
function applyNoteOperations(operations, stepsPerBeat, callback) {
   var pages = {};
   for (var i = 0; i < operations.length; i++) {
      var operation = operations[i];
      var pageStart = Math.floor(operation.step / CLIP_GRID_WIDTH) * CLIP_GRID_WIDTH;
      if (!pages[pageStart]) pages[pageStart] = [];
      pages[pageStart].push(operation);
   }
   var pageStarts = Object.keys(pages).map(Number).sort(function(a, b) { return a - b; });

   function writeGrid(page, pageStart) {
      for (var p = 0; p < page.length; p++) {
         var op = page[p];
         var x = op.step - pageStart;
         if (op.kind === "remove") launcherClip.clearStep(op.channel, x, op.pitch);
         else if (op.kind === "create") launcherClip.setStep(op.channel, x, op.pitch, op.fields.velocity, op.fields.duration);
      }
   }

   function setFields(fields) {
      return function(page, pageStart) {
         for (var q = 0; q < page.length; q++) {
            var change = page[q];
            if (change.kind === "remove") continue;
            var setters = noteSetterFields(change, fields);
            if (!setters.length) continue;
            var step = launcherClip.getStep(change.channel, change.step - pageStart, change.pitch);
            if (String(step.state()) !== "NoteOn") {
               throw new Error("Bitwig shows no note at pitch " + change.pitch + ", step " + change.step + " (channel " + change.channel + ") to set " + setters.join(", ") + " on.");
            }
            for (var s = 0; s < setters.length; s++) setNoteField(step, setters[s], change.fields[setters[s]]);
         }
      };
   }

   // Runs `action` on every page in turn, waiting `settleMs` after each
   // scroll so Bitwig's grid shows that page, then calls next().
   function eachPage(settleMs, action, next) {
      function run(index) {
         if (index >= pageStarts.length) {
            next();
            return;
         }
         var pageStart = pageStarts[index];
         launcherClip.scrollToStep(pageStart);
         later(settleMs, function() {
            try {
               action(pages[pageStart], pageStart);
               run(index + 1);
            } catch (error) {
               callback(error);
            }
         });
      }
      run(0);
   }

   function done() {
      launcherClip.scrollToStep(0);
      callback(null);
   }

   launcherClip.setStepSize(1 / stepsPerBeat);
   launcherClip.scrollToKey(0);
   eachPage(NOTE_SCROLL_SETTLE_MS, writeGrid, function() {
      later(NOTE_PAGE_SETTLE_MS, function() {
         eachPage(NOTE_PAGE_SETTLE_MS, setFields(NOTE_SETTER_FIELDS), done);
      });
   });
}

// The fields among `allowed` that need a NoteStep setter: all of them on an
// update; on a new note only those setStep did not write and that differ from
// Bitwig's defaults.
function noteSetterFields(operation, allowed) {
   var names = [];
   for (var i = 0; i < allowed.length; i++) {
      var field = allowed[i];
      if (operation.fields[field] === undefined) continue;
      if (operation.kind === "create") {
         if (field === "velocity" || field === "duration") continue;
         if (field === "muted" ? !operation.fields.muted : operation.fields[field] === 0) continue;
      }
      names.push(field);
   }
   return names;
}

// Bitwig's script host only supports direct method calls on these objects, so
// each setter is spelled out.
function setNoteField(step, field, value) {
   if (field === "velocity") step.setVelocity(value / 127);
   else if (field === "duration") step.setDuration(value);
   else if (field === "timbre") step.setTimbre(value);
   else if (field === "pan") step.setPan(value);
   else if (field === "gain") step.setGain(value);
   else if (field === "muted") step.setIsMuted(value);
   else throw new Error("Unknown note field " + field + ".");
}

// Clip length is reported and set through the loop only: Clip.getPlayStart()
// and getPlayStop() do not follow loop changes consistently (measured in
// Bitwig 6.1.7: moving the loop start to beat 2 made them read 8 and 10).
function clipState(slot, slotIndex) {
   return {
      slotIndex: slotIndex,
      name: slot.name().get(),
      color: colorHex(launcherClip.color()),
      loop: {
         enabled: launcherClip.isLoopEnabled().get(),
         startBeats: roundTo(launcherClip.getLoopStart().get(), 6),
         lengthBeats: roundTo(launcherClip.getLoopLength().get(), 6)
      },
      playing: slot.isPlaying().get()
   };
}

// Where note reads stop: the loop end, or Bitwig's play-stop value when that
// is later, so notes outside the loop are read too. Capped at MAX_CLIP_BEATS.
function clipEndBeats() {
   var end = Math.max(launcherClip.getPlayStop().get(), launcherClip.getLoopStart().get() + launcherClip.getLoopLength().get());
   return Math.min(MAX_CLIP_BEATS, end);
}

// Validates name, loop and color from a request. Returns the properties to
// write, or null when the request sets none.
function parseClipProperties(params) {
   var properties = {};
   var any = false;
   if (params.name !== undefined) {
      var name = String(params.name).trim();
      if (!name || name.length > 120) throw new Error("Clip name must contain 1 to 120 characters.");
      properties.name = name;
      any = true;
   }
   if (params.loop !== undefined) {
      var loop = params.loop || {};
      properties.loop = {};
      if (loop.enabled !== undefined) properties.loop.enabled = Boolean(loop.enabled);
      if (loop.startBeats !== undefined) properties.loop.startBeats = requireBeats(loop.startBeats, "Loop start", true);
      if (loop.lengthBeats !== undefined) properties.loop.lengthBeats = requireBeats(loop.lengthBeats, "Loop length");
      any = true;
   }
   if (params.color !== undefined) {
      properties.color = parseHexColor(params.color, "Clip color");
      any = true;
   }
   return any ? properties : null;
}

function writeClipProperties(properties) {
   if (properties.name !== undefined) launcherClip.setName(properties.name);
   if (properties.loop) {
      if (properties.loop.startBeats !== undefined) launcherClip.getLoopStart().set(properties.loop.startBeats);
      if (properties.loop.lengthBeats !== undefined) launcherClip.getLoopLength().set(properties.loop.lengthBeats);
      if (properties.loop.enabled !== undefined) launcherClip.isLoopEnabled().set(properties.loop.enabled);
   }
   if (properties.color) launcherClip.color().set(properties.color.red, properties.color.green, properties.color.blue);
}

function clipPropertyProblems(properties, slot) {
   var problems = [];
   function beats(label, actual, requested) {
      if (differs(actual, requested, 0.0001)) problems.push(label + " is " + roundTo(actual, 6) + ", requested " + requested);
   }
   if (properties.name !== undefined && slot.name().get() !== properties.name) {
      problems.push("name is ‘" + slot.name().get() + "’, requested ‘" + properties.name + "’");
   }
   if (properties.loop) {
      if (properties.loop.enabled !== undefined && launcherClip.isLoopEnabled().get() !== properties.loop.enabled) {
         problems.push("loop.enabled is " + launcherClip.isLoopEnabled().get() + ", requested " + properties.loop.enabled);
      }
      if (properties.loop.startBeats !== undefined) beats("loop.startBeats", launcherClip.getLoopStart().get(), properties.loop.startBeats);
      if (properties.loop.lengthBeats !== undefined) beats("loop.lengthBeats", launcherClip.getLoopLength().get(), properties.loop.lengthBeats);
   }
   if (properties.color && !sameColor(launcherClip.color(), properties.color)) {
      problems.push("color is " + colorHex(launcherClip.color()) + ", requested " + properties.color.hex);
   }
   return problems;
}

// Puts the clip in a track's launcher slot into Bitwig's launcher cursor clip
// and calls back once Bitwig reports it there.
function focusClip(request, slot, slotIndex, callback) {
   slot.select();
   slot.showInEditor();
   var attempts = 0;
   function check() {
      try {
         if (!slot.isSelected().get() || !launcherClip.exists().get()) {
            if (attempts++ < 10) {
               later(80, check);
               return;
            }
            throw new Error("Bitwig did not expose the launcher clip in slot " + slotIndex + ".");
         }
         // Give the clip's loop and grid observers one more cycle to follow
         // the newly selected clip before anything reads them.
         later(CLIP_FOCUS_SETTLE_MS, function() {
            try {
               callback();
            } catch (error) {
               finish(request, false, { message: String(error.message || error) });
            }
         });
      } catch (error) {
         finish(request, false, { message: String(error.message || error) });
      }
   }
   later(80, check);
}

// Reads the clip back after a change and fails with every difference from the
// expected notes and clip properties.
function verifyClip(request, slot, slotIndex, stepsPerBeat, endBeats, expected, properties, onVerified) {
   later(NOTE_PAGE_SETTLE_MS, function() {
      readClipNotes(stepsPerBeat, endBeats, function(error, actual) {
         if (error) {
            finish(request, false, { message: "Could not read the clip back after the change: " + String(error.message || error) });
            return;
         }
         var problems = compareNotes(expected, actual, stepsPerBeat);
         if (problems.length) {
            finish(request, false, {
               message: "Note verification failed: clip slot " + slotIndex + " does not hold the " + expected.length + " expected notes. " + describeProblems(problems)
            });
            return;
         }
         if (!properties) {
            onVerified(actual);
            return;
         }
         verifyReadback(request, function() {
            return clipPropertyProblems(properties, slot).join("; ");
         }, function() {
            onVerified(actual);
         });
      });
   });
}

// Bitwig stopped part-way through a change. Reads the clip back so the error
// says exactly how it now differs from the request.
function failWithClipState(request, error, slotIndex, stepsPerBeat, endBeats, expected) {
   var message = "Bitwig stopped the change part-way: " + String(error.message || error);
   later(NOTE_PAGE_SETTLE_MS, function() {
      readClipNotes(stepsPerBeat, endBeats, function(readError, actual) {
         if (readError) {
            finish(request, false, { message: message + " The clip could not be read back afterwards." });
            return;
         }
         var problems = compareNotes(expected, actual, stepsPerBeat);
         finish(request, false, {
            message: message + (problems.length
               ? " Clip slot " + slotIndex + " now differs from the request: " + describeProblems(problems)
               : " Clip slot " + slotIndex + " nevertheless matches the request.")
         });
      });
   });
}

function handleReadClip(request) {
   var params = request.params;
   var slotIndex = requireSlotIndex(params.slotIndex, "Clip");
   var stepsPerBeat = requireStepsPerBeat(params.stepsPerBeat);
   var offset = Math.max(0, Math.floor(Number(params.offset || 0)));
   var limit = Math.max(1, Math.min(MAX_NOTES_PER_REPLY, Math.floor(Number(params.limit || MAX_NOTES_PER_REPLY))));

   selectTrack(request, params, function(track) {
      withSceneSlot(request, track, slotIndex, function(slot) {
         if (!slot.hasContent().get()) throw new Error("Clip slot " + slotIndex + " has no clip.");
         focusClip(request, slot, slotIndex, function() {
            var endBeats = clipEndBeats();
            if (!(endBeats > 0)) throw new Error("Bitwig reports no length for the clip in slot " + slotIndex + ".");
            requireGridSpan(endBeats, stepsPerBeat);
            var state = clipState(slot, slotIndex);
            readClipNotes(stepsPerBeat, endBeats, function(error, notes) {
               if (error) {
                  finish(request, false, { message: String(error.message || error) });
                  return;
               }
               finish(request, true, {
                  track: { index: params.trackIndex, name: params.trackName },
                  clip: state,
                  stepsPerBeat: stepsPerBeat,
                  note: "Note starts are read on a 1/" + stepsPerBeat + "-beat grid; a note between two steps reads back at the step it starts in.",
                  noteCount: notes.length,
                  offset: offset,
                  returned: Math.max(0, Math.min(limit, notes.length - offset)),
                  notes: publicNotes(notes.slice(offset, offset + limit))
               });
            });
         });
      });
   });
}

// Creates or replaces a launcher clip, writes its properties and all of its
// notes, and verifies the whole clip.
function handleWriteClip(request) {
   var params = request.params;
   var slotIndex = requireSlotIndex(params.slotIndex, "Clip");
   var stepsPerBeat = requireStepsPerBeat(params.stepsPerBeat);
   var lengthBeats = requireBeats(params.lengthBeats, "Clip length");
   var properties = parseClipProperties({
      name: params.name,
      loop: {
         enabled: params.loop && params.loop.enabled !== undefined ? params.loop.enabled : true,
         startBeats: params.loop && params.loop.startBeats !== undefined ? params.loop.startBeats : 0,
         lengthBeats: params.loop && params.loop.lengthBeats !== undefined ? params.loop.lengthBeats : lengthBeats
      },
      color: params.color
   });
   requireGridSpan(Math.max(lengthBeats, properties.loop.startBeats + properties.loop.lengthBeats), stepsPerBeat);
   var notes = parseNoteList(params.notes || [], stepsPerBeat, lengthBeats, true);
   var operations = [];
   for (var i = 0; i < notes.length; i++) {
      var note = notes[i];
      if (note.fields.velocity === undefined) note.fields.velocity = 100;
      if (note.fields.muted === undefined) note.fields.muted = false;
      if (note.fields.gain === undefined) note.fields.gain = NOTE_DEFAULT_GAIN;
      operations.push({ kind: "create", step: note.step, pitch: note.pitch, channel: note.channel, fields: note.fields });
   }

   selectTrack(request, params, function(track) {
      var sceneCount = sceneBank.itemCount().get();
      if (slotIndex > sceneCount) {
         throw new Error("Slot " + slotIndex + " is past the end of the launcher. The project has " + sceneCount +
            " scenes, so a new clip can go in slot " + sceneCount + " at most.");
      }
      // Bitwig creates clips with whole-beat lengths; the exact length is set
      // with the other clip properties.
      var creationBeats = Math.ceil(lengthBeats);
      function fill(slot) {
         later(180, function() {
            focusClip(request, slot, slotIndex, function() {
               writeClipProperties(properties);
               applyNoteOperations(operations, stepsPerBeat, function(error) {
                  if (error) {
                     failWithClipState(request, error, slotIndex, stepsPerBeat, lengthBeats, notes);
                     return;
                  }
                  verifyClip(request, slot, slotIndex, stepsPerBeat, Math.max(lengthBeats, properties.loop.startBeats + properties.loop.lengthBeats), notes, properties, function(actual) {
                     finish(request, true, {
                        track: { index: params.trackIndex, name: params.trackName },
                        clip: clipState(slot, slotIndex),
                        stepsPerBeat: stepsPerBeat,
                        notesWritten: notes.length,
                        notesVerified: actual.length
                     });
                  });
               });
            });
         });
      }
      if (slotIndex === sceneCount) {
         createInNewScene(request, track, slotIndex, creationBeats, function() {
            withSceneSlot(request, track, slotIndex, fill);
         });
         return;
      }
      withSceneSlot(request, track, slotIndex, function(slot) {
         later(100, function() {
            try {
               if (slot.hasContent().get() && !params.replace) {
                  throw new Error("Clip slot " + slotIndex + " already has content. Pass replace=true to replace it.");
               }
               function create() {
                  slot.createEmptyClip(creationBeats);
                  fill(slot);
               }
               if (slot.hasContent().get()) {
                  slot.deleteObject();
                  later(180, create);
               } else create();
            } catch (error) {
               finish(request, false, { message: String(error.message || error) });
            }
         });
      });
   });
}

// Bitwig creates the clip and a new scene for it when slotIndex is one past
// the last scene, then reports the extra scene.
function createInNewScene(request, track, slotIndex, lengthBeats, callback) {
   track.createNewLauncherClip(slotIndex, lengthBeats);
   var attempts = 0;
   function waitForScene() {
      if (sceneBank.itemCount().get() > slotIndex) {
         callback();
         return;
      }
      if (attempts++ >= 20) throw new Error("Bitwig did not add a scene for the new clip in slot " + slotIndex + ".");
      later(50, waitForScene);
   }
   later(50, waitForScene);
}

// Changes an existing clip: its properties and single notes. Notes the
// request does not touch must come back unchanged.
function handleEditClip(request) {
   var params = request.params;
   var slotIndex = requireSlotIndex(params.slotIndex, "Clip");
   var stepsPerBeat = requireStepsPerBeat(params.stepsPerBeat);
   var properties = parseClipProperties(params);
   var upserts = params.setNotes || [];
   var removals = params.removeNotes || [];
   if (!properties && !upserts.length && !removals.length) {
      throw new Error("Nothing to change: pass clip properties, setNotes or removeNotes.");
   }

   selectTrack(request, params, function(track) {
      withSceneSlot(request, track, slotIndex, function(slot) {
         if (!slot.hasContent().get()) throw new Error("Clip slot " + slotIndex + " has no clip.");
         focusClip(request, slot, slotIndex, function() {
            var endBefore = clipEndBeats();
            var endAfter = endBefore;
            if (properties && properties.loop) {
               var loopStart = properties.loop.startBeats !== undefined ? properties.loop.startBeats : launcherClip.getLoopStart().get();
               var loopLength = properties.loop.lengthBeats !== undefined ? properties.loop.lengthBeats : launcherClip.getLoopLength().get();
               endAfter = Math.max(endAfter, loopStart + loopLength);
            }
            var readEnd = Math.min(MAX_CLIP_BEATS, Math.max(endBefore, endAfter));
            requireGridSpan(readEnd, stepsPerBeat);
            var sets = parseNoteList(upserts, stepsPerBeat, readEnd, false);
            var removes = parseNoteList(removals, stepsPerBeat, readEnd, false);

            readClipNotes(stepsPerBeat, readEnd, function(error, before) {
               try {
                  if (error) throw error;
                  var plan = planNoteEdits(before, sets, removes, stepsPerBeat);
                  if (properties) writeClipProperties(properties);
                  applyNoteOperations(plan.operations, stepsPerBeat, function(applyError) {
                     if (applyError) {
                        failWithClipState(request, applyError, slotIndex, stepsPerBeat, readEnd, plan.expected);
                        return;
                     }
                     verifyClip(request, slot, slotIndex, stepsPerBeat, readEnd, plan.expected, properties, function(actual) {
                        finish(request, true, {
                           track: { index: params.trackIndex, name: params.trackName },
                           clip: clipState(slot, slotIndex),
                           stepsPerBeat: stepsPerBeat,
                           notesCreated: plan.created,
                           notesUpdated: plan.updated,
                           notesRemoved: plan.removed,
                           notesVerified: actual.length
                        });
                     });
                  });
               } catch (planError) {
                  finish(request, false, { message: String(planError.message || planError) });
               }
            });
         });
      });
   });
}

// Turns requested note edits into grid operations and the full set of notes
// the clip must hold afterwards. Refuses, before anything changes, to remove
// a note that is not there or to both set and remove the same note.
function planNoteEdits(before, sets, removes, stepsPerBeat) {
   var current = {};
   var order = [];
   for (var b = 0; b < before.length; b++) {
      var held = before[b];
      var cell = noteCell(held.channel, held.step, held.pitch);
      current[cell] = {
         step: held.step, pitch: held.pitch, channel: held.channel,
         fields: {
            velocity: held.velocity, duration: held.duration, timbre: held.timbre,
            pan: held.pan, gain: held.gain, muted: held.muted
         }
      };
      order.push(cell);
   }
   var operations = [];
   var removedCells = {};
   for (var r = 0; r < removes.length; r++) {
      var removal = removes[r];
      var removeCell = noteCell(removal.channel, removal.step, removal.pitch);
      if (!current[removeCell]) throw new Error("Cannot remove " + noteLabel(removal, stepsPerBeat) + ": the clip has no note there. Nothing was changed.");
      removedCells[removeCell] = true;
      operations.push({ kind: "remove", step: removal.step, pitch: removal.pitch, channel: removal.channel });
   }
   var created = 0;
   var updated = 0;
   for (var s = 0; s < sets.length; s++) {
      var set = sets[s];
      var setCell = noteCell(set.channel, set.step, set.pitch);
      if (removedCells[setCell]) throw new Error(noteLabel(set, stepsPerBeat) + " is both set and removed. Nothing was changed.");
      var existing = current[setCell];
      if (existing) {
         var changes = {};
         var anyChange = false;
         for (var field in set.fields) {
            changes[field] = set.fields[field];
            existing.fields[field] = set.fields[field];
            anyChange = true;
         }
         if (anyChange) {
            operations.push({ kind: "update", step: set.step, pitch: set.pitch, channel: set.channel, fields: changes });
            updated++;
         }
      } else {
         if (set.fields.duration === undefined) throw new Error("New note " + noteLabel(set, stepsPerBeat) + " needs a duration. Nothing was changed.");
         if (set.fields.velocity === undefined) set.fields.velocity = 100;
         if (set.fields.muted === undefined) set.fields.muted = false;
         if (set.fields.gain === undefined) set.fields.gain = NOTE_DEFAULT_GAIN;
         current[setCell] = set;
         order.push(setCell);
         operations.push({ kind: "create", step: set.step, pitch: set.pitch, channel: set.channel, fields: set.fields });
         created++;
      }
   }
   var expected = [];
   for (var o = 0; o < order.length; o++) {
      if (!removedCells[order[o]]) expected.push(current[order[o]]);
   }
   return { operations: operations, expected: expected, created: created, updated: updated, removed: removes.length };
}

function handleRecordLauncherArrangement(request) {
   var specifications = request.params.regions || [];
   if (!specifications.length) throw new Error("At least one arrangement region is required.");
   if (specifications.length > 64) throw new Error("A maximum of 64 arrangement regions can be recorded at once.");
   // The print reads slots 0-7 through the first scene window.
   if (sceneBank.scrollPosition().get() !== 0) {
      resetSceneWindow();
      throw new Error("Bitwig's scene window was still scrolled from the previous request. Try again.");
   }

   var trackPlans = {};
   var orderedTrackPlans = [];
   var startPosition = Infinity;
   var endBeats = 0;
   for (var regionIndex = 0; regionIndex < specifications.length; regionIndex++) {
      var region = specifications[regionIndex];
      var track = requireTrack(region);
      var slotIndex = Number(region.slotIndex);
      var startBeats = Number(region.startBeats);
      var lengthBeats = Number(region.lengthBeats);
      if (!(slotIndex >= 0 && slotIndex < MAX_SCENES) || Math.floor(slotIndex) !== slotIndex) {
         throw new Error("Region " + regionIndex + " has an invalid launcher slot.");
      }
      if (!(startBeats >= 0)) throw new Error("Region " + regionIndex + " has an invalid start position.");
      if (!(lengthBeats >= 1 && lengthBeats <= 512) || Math.floor(lengthBeats) !== lengthBeats) {
         throw new Error("Region " + regionIndex + " must be between 1 and 512 whole beats long.");
      }
      var sourceSlot = track.clipLauncherSlotBank().getItemAt(slotIndex);
      if (!sourceSlot.hasContent().get()) {
         throw new Error("Track ‘" + region.trackName + "’ launcher slot " + slotIndex + " has no clip to record.");
      }
      var trackKey = String(region.trackIndex);
      var plan = trackPlans[trackKey];
      if (!plan) {
         plan = {
            track: track,
            trackIndex: Number(region.trackIndex),
            trackName: String(region.trackName),
            slotIndex: slotIndex,
            intervals: []
         };
         trackPlans[trackKey] = plan;
         orderedTrackPlans.push(plan);
      } else if (plan.slotIndex !== slotIndex) {
         throw new Error("Each track must use one launcher slot throughout a recorded arrangement.");
      }
      plan.intervals.push({ start: startBeats, end: startBeats + lengthBeats });
      endBeats = Math.max(endBeats, startBeats + lengthBeats);
      startPosition = Math.min(startPosition, startBeats);
   }

   var events = [];
   var recordedIntervals = [];
   for (var planIndex = 0; planIndex < orderedTrackPlans.length; planIndex++) {
      var trackPlan = orderedTrackPlans[planIndex];
      trackPlan.intervals.sort(function(a, b) { return a.start - b.start; });
      var merged = [];
      for (var intervalIndex = 0; intervalIndex < trackPlan.intervals.length; intervalIndex++) {
         var interval = trackPlan.intervals[intervalIndex];
         var last = merged.length ? merged[merged.length - 1] : null;
         if (last && interval.start <= last.end) last.end = Math.max(last.end, interval.end);
         else merged.push({ start: interval.start, end: interval.end });
      }
      for (var mergedIndex = 0; mergedIndex < merged.length; mergedIndex++) {
         var mergedInterval = merged[mergedIndex];
         events.push({ beat: mergedInterval.start, type: "start", plan: trackPlan });
         events.push({ beat: mergedInterval.end, type: "stop", plan: trackPlan });
         recordedIntervals.push({
            trackIndex: trackPlan.trackIndex,
            trackName: trackPlan.trackName,
            slotIndex: trackPlan.slotIndex,
            startBeats: mergedInterval.start,
            lengthBeats: mergedInterval.end - mergedInterval.start
         });
      }
   }
   events.sort(function(a, b) {
      if (a.beat !== b.beat) return a.beat - b.beat;
      return a.type === "stop" ? -1 : 1;
   });

   var spanBeats = endBeats - startPosition;
   if (spanBeats > MAX_PRINT_SPAN_BEATS) {
      throw new Error("The regions run from beat " + startPosition + " to beat " + endBeats + ", " + spanBeats +
         " beats in one print. One print can cover at most " + MAX_PRINT_SPAN_BEATS + " beats; split it into smaller prints.");
   }

   // Recording runs at an accelerated tempo; put the project's own tempo back
   // afterwards unless the caller asks for a specific one.
   var restoreTempo = request.params.restoreTempo === undefined || request.params.restoreTempo === null
      ? transport.tempo().value().getRaw()
      : Number(request.params.restoreTempo);
   if (!(restoreTempo >= 20 && restoreTempo <= 666)) throw new Error("Restore tempo must be between 20 and 666 BPM.");

   // Everything the print changes is put back by restoreState, on success, on
   // any error, and when the watchdog gives up on the request.
   var saved = {
      loopEnabled: transport.isArrangerLoopEnabled().get(),
      position: transport.getPosition().get(),
      arrangerOverdub: transport.isArrangerOverdubEnabled().get(),
      launcherOverdub: transport.isClipLauncherOverdubEnabled().get(),
      armedTracks: []
   };
   var trackCount = Math.min(trackBank.itemCount().get(), MAX_TRACKS);
   for (var armIndex = 0; armIndex < trackCount; armIndex++) {
      var candidate = trackBank.getItemAt(armIndex);
      if (candidate.exists().get() && candidate.arm().get()) saved.armedTracks.push(candidate);
   }
   var acceleratedTempo = 666;
   var nextEvent = 0;
   var startTimestamp = Date.now();
   var completed = false;
   var restored = false;

   function restoreState() {
      if (restored) return;
      restored = true;
      transport.stop();
      transport.isArrangerRecordEnabled().set(false);
      for (var planIndex = 0; planIndex < orderedTrackPlans.length; planIndex++) {
         orderedTrackPlans[planIndex].track.stop();
         orderedTrackPlans[planIndex].track.returnToArrangement();
      }
      transport.isArrangerLoopEnabled().set(saved.loopEnabled);
      transport.isArrangerOverdubEnabled().set(saved.arrangerOverdub);
      transport.isClipLauncherOverdubEnabled().set(saved.launcherOverdub);
      for (var armIndex = 0; armIndex < saved.armedTracks.length; armIndex++) saved.armedTracks[armIndex].arm().set(true);
      transport.tempo().value().setRaw(restoreTempo);
      transport.setPosition(saved.position);
      // Bitwig drops a playhead move made while the transport is still
      // stopping, so move it again once the stop has landed.
      host.scheduleTask(function() { transport.setPosition(saved.position); }, 200);
   }
   request.cleanup = restoreState;

   function fail(error) {
      if (completed) return;
      completed = true;
      restoreState();
      finish(request, false, { message: String(error.message || error), recordedIntervals: recordedIntervals });
   }

   function complete() {
      if (completed) return;
      completed = true;
      restoreState();
      later(450, function() {
         finish(request, true, {
            recorded: true,
            tracks: orderedTrackPlans.length,
            regionsRequested: specifications.length,
            mergedIntervals: recordedIntervals.length,
            startBeats: startPosition,
            endBeats: endBeats,
            acceleratedTempo: acceleratedTempo,
            restoredTempo: transport.tempo().value().getRaw(),
            restoredPositionBeats: transport.getPosition().get(),
            restoredArmedTracks: saved.armedTracks.length,
            durationMs: Date.now() - startTimestamp,
            intervals: recordedIntervals,
            projectModified: project.isModified().get(),
            arrangerRecordEnabled: transport.isArrangerRecordEnabled().get()
         });
      });
   }

   function runDueEvents(positionBeats) {
      while (nextEvent < events.length) {
         var event = events[nextEvent];
         var atStart = event.beat === startPosition;
         var leadBeats = atStart ? 0 : 0.75;
         if (positionBeats < event.beat - leadBeats) break;
         if (event.type === "start") {
            event.plan.track.clipLauncherSlotBank().getItemAt(event.plan.slotIndex)
               .launchWithOptions(atStart ? "none" : "1", "from_start");
         } else event.plan.track.stop();
         nextEvent++;
      }
   }

   function monitorRecording() {
      if (completed || restored) return;
      try {
         var positionBeats = transport.getPosition().get();
         runDueEvents(positionBeats);
         if (positionBeats >= endBeats + 0.5) {
            complete();
            return;
         }
         if (!transport.isPlaying().get()) {
            throw new Error("Bitwig's transport stopped at beat " + positionBeats + " before the print reached beat " + endBeats + ".");
         }
         if (Date.now() - startTimestamp > 115000) {
            throw new Error("Timed out while recording Launcher clips into the Arranger.");
         }
         later(10, monitorRecording);
      } catch (error) {
         fail(error);
      }
   }

   function stillArmed() {
      for (var armIndex = 0; armIndex < saved.armedTracks.length; armIndex++) {
         if (saved.armedTracks[armIndex].arm().get()) return true;
      }
      return false;
   }

   function moveToStart() {
      transport.setPosition(startPosition);
      if (startPosition === 0) jumpToBeginningAction.invoke();
   }

   try {
      transport.stop();
      transport.isArrangerRecordEnabled().set(false);
      transport.isArrangerLoopEnabled().set(false);
      transport.isArrangerOverdubEnabled().set(false);
      transport.isClipLauncherOverdubEnabled().set(false);
      for (var unarmIndex = 0; unarmIndex < saved.armedTracks.length; unarmIndex++) saved.armedTracks[unarmIndex].arm().set(false);
      for (var stopIndex = 0; stopIndex < orderedTrackPlans.length; stopIndex++) orderedTrackPlans[stopIndex].track.stop();
      transport.tempo().value().setRaw(acceleratedTempo);
      moveToStart();
   } catch (error) {
      fail(error);
      return;
   }
   var preparationAttempts = 0;
   function retryOr(message) {
      if (preparationAttempts++ < 30) {
         later(100, beginWhenReady);
         return;
      }
      throw new Error(message);
   }
   function beginWhenReady() {
      if (completed || restored) return;
      try {
         if (Math.abs(transport.tempo().value().getRaw() - acceleratedTempo) > 0.01) {
            retryOr("Bitwig did not verify the temporary recording tempo.");
            return;
         }
         if (transport.isArrangerLoopEnabled().get()) {
            transport.isArrangerLoopEnabled().set(false);
            retryOr("Bitwig did not disable the Arranger loop for recording.");
            return;
         }
         if (transport.isArrangerOverdubEnabled().get() || transport.isClipLauncherOverdubEnabled().get()) {
            transport.isArrangerOverdubEnabled().set(false);
            transport.isClipLauncherOverdubEnabled().set(false);
            retryOr("Bitwig did not turn off overdub for recording.");
            return;
         }
         if (stillArmed()) {
            for (var armIndex = 0; armIndex < saved.armedTracks.length; armIndex++) saved.armedTracks[armIndex].arm().set(false);
            retryOr("Bitwig did not disarm the armed tracks for recording.");
            return;
         }
         if (Math.abs(transport.getPosition().get() - startPosition) > 0.01) {
            moveToStart();
            retryOr("Bitwig did not verify the recording start position at beat " + startPosition + ".");
            return;
         }
         transport.isArrangerRecordEnabled().set(true);
         runDueEvents(startPosition);
         transport.play();
         later(180, function() {
            if (!transport.isPlaying().get()) {
               fail(new Error("Bitwig did not start the Arranger recording transport."));
               return;
            }
            monitorRecording();
         });
      } catch (error) {
         fail(error);
      }
   }
   later(350, beginWhenReady);
}

function handleListClips(request) {
   var params = request.params;
   var track = requireTrack(params);
   var sceneCount = Math.min(sceneBank.itemCount().get(), MAX_SCENE_SLOTS);
   var clips = [];
   function readWindow(windowStart) {
      if (windowStart >= sceneCount) {
         finish(request, true, {
            track: { index: params.trackIndex, name: params.trackName },
            sceneCount: sceneBank.itemCount().get(),
            clips: clips
         });
         return;
      }
      withSceneSlot(request, track, windowStart, function(firstSlot, firstLocal) {
         later(60, function() {
            var slots = track.clipLauncherSlotBank();
            var position = windowStart - firstLocal;
            var end = Math.min(position + MAX_SCENES, sceneCount);
            for (var slotIndex = windowStart; slotIndex < end; slotIndex++) {
               var snapshot = clipSnapshot(slots.getItemAt(slotIndex - position), slotIndex);
               if (snapshot.hasContent) clips.push(snapshot);
            }
            readWindow(end);
         });
      });
   }
   later(120, function() {
      readWindow(0);
   });
}

function handleLaunchScene(request) {
   var slotIndex = requireSlotIndex(request.params.slotIndex, "Scene");
   withSceneSlot(request, null, slotIndex, function(scene) {
      scene.launchWithOptions("none", "from_start");
      later(180, function() {
         finish(request, true, { slotIndex: slotIndex, transport: readTransport() });
      });
   });
}

function dispatch(request) {
   var params = request.params;
   switch (request.method) {
      case "status":
         finish(request, true, {
            connected: true,
            bridge: "Bitwig Agent Bridge",
            version: BRIDGE_VERSION,
            apiVersion: 25,
            hostApiVersion: host.getHostApiVersion(),
            project: application.projectName().get(),
            projectModified: project.isModified().get(),
            transport: readTransport(),
            selectedTrack: cursorTrack.exists().get() ? { name: cursorTrack.name().get(), position: cursorTrack.position().get() } : null,
            selectedDevice: cursorDevice.exists().get() ? { name: cursorDevice.name().get(), position: cursorDevice.position().get() } : null,
            audioEngineActive: application.hasActiveEngine().get()
         });
         return;
      case "transport":
         handleTransport(request);
         return;
      case "cue_markers":
         handleCueMarkers(request);
         return;
      case "invoke_action":
         var requestedActionId = String(params.actionId || "");
         var requestedAction = application.getAction(requestedActionId);
         if (!requestedAction) {
            finish(request, false, { message: "Bitwig action ‘" + requestedActionId + "’ was not found." });
            return;
         }
         requestedAction.invoke();
         later(180, function() {
            finish(request, true, { id: requestedActionId, invoked: true });
         });
         return;
      case "list_tracks":
         finish(request, true, listTracks());
         return;
      case "find_actions":
         var actionQuery = normalizeText(params.query || "");
         var availableActions = application.getActions();
         var matchingActions = [];
         for (var actionIndex = 0; actionIndex < availableActions.length; actionIndex++) {
            var availableAction = availableActions[actionIndex];
            var actionId = String(availableAction.getId() || "");
            var actionName = String(availableAction.getName() || "");
            var actionMenuText = String(availableAction.getMenuItemText() || "");
            var actionSearchText = normalizeText(actionId + " " + actionName + " " + actionMenuText);
            if (!actionQuery || actionSearchText.indexOf(actionQuery) !== -1) {
               matchingActions.push({ id: actionId, name: actionName, menuItemText: actionMenuText });
            }
         }
         finish(request, true, {
            query: String(params.query || ""),
            totalActions: availableActions.length,
            matched: matchingActions.length,
            actions: matchingActions.slice(0, 100)
         });
         return;
      case "track_meters":
         if (params.action === "reset") {
            for (var meterIndex = 0; meterIndex < MAX_TRACKS; meterIndex++) {
               trackMeterLatest[meterIndex] = 0;
               trackMeterMaximum[meterIndex] = 0;
            }
            finish(request, true, { reset: true, range: 128 });
         } else finish(request, true, readTrackMeters(Boolean(params.resetAfterRead)));
         return;
      case "create_track":
         handleCreateTrack(request);
         return;
      case "set_track":
         handleSetTrack(request);
         return;
      case "delete_track":
         var track = requireTrack(params);
         deleteAndVerify(request, trackBank, MAX_TRACKS, Number(params.trackIndex), track, trackSnapshot(track, Number(params.trackIndex)), "track");
         return;
      case "list_devices":
         selectTrack(request, params, function() {
            var snapshot = listDevicesNow();
            snapshot.track = { index: params.trackIndex, name: params.trackName };
            finish(request, true, snapshot);
         });
         return;
      case "nest_device":
         handleNestDevice(request);
         return;
      case "save_device_preset":
         handleSaveDevicePreset(request);
         return;
      case "write_clip":
         handleWriteClip(request);
         return;
      case "read_clip":
         handleReadClip(request);
         return;
      case "edit_clip":
         handleEditClip(request);
         return;
      case "arrange_launcher_clips":
         handleRecordLauncherArrangement(request);
         return;
      case "list_clips":
         handleListClips(request);
         return;
      case "launch_scene":
         handleLaunchScene(request);
         return;
      case "find_devices":
         handleFindDevices(request);
         return;
      case "insert_device":
         handleInsertDevice(request);
         return;
      case "insert_bitwig_device":
         handleInsertBitwigDevice(request);
         return;
      case "insert_clap_device":
         handleInsertClapDevice(request);
         return;
      case "find_samples":
         handleFindSamples(request);
         return;
      case "insert_sample":
         handleInsertSample(request);
         return;
      case "insert_sample_file":
         handleInsertSampleFile(request);
         return;
      case "delete_device":
         selectTrack(request, params, function() {
            try {
               var device = requireDevice(params);
               deleteAndVerify(request, deviceBank, MAX_DEVICES, Number(params.deviceIndex), device, deviceSnapshot(device, Number(params.deviceIndex)), "device");
            } catch (error) {
               finish(request, false, { message: String(error.message || error) });
            }
         });
         return;
      case "list_parameters":
         selectDevice(request, params, function(device) {
            var query = normalizeText(params.query || "");
            var filtered = [];
            for (var i = 0; i < directIds.length; i++) {
               var parameter = parameterSnapshot(directIds[i]);
               if (!query || normalizeText(parameter.name).indexOf(query) !== -1) filtered.push(parameter);
            }
            var offset = Math.max(0, Number(params.offset || 0));
            var limit = Math.max(1, Math.min(200, Number(params.limit || 100)));
            finish(request, true, {
               device: deviceSnapshot(cursorDevice, Number(params.deviceIndex)),
               totalDirectParameters: directIds.length,
               matched: filtered.length,
               offset: offset,
               returned: Math.min(limit, Math.max(0, filtered.length - offset)),
               parameters: filtered.slice(offset, offset + limit)
            });
         });
         return;
      case "remote_controls":
         selectDevice(request, params, function(device) {
            var action = String(params.action || "status");
            if (action !== "status" && action !== "show" && action !== "hide") {
               throw new Error("Remote-controls action must be status, show, or hide.");
            }
            var pageNames = arrayCopy(cursorRemoteControlsPage.pageNames().get());
            var requestedIndex = params.pageIndex === undefined ? null : Number(params.pageIndex);
            if (params.pageName !== undefined) {
               var requestedName = normalizeText(params.pageName);
               requestedIndex = -1;
               for (var pageIndex = 0; pageIndex < pageNames.length; pageIndex++) {
                  if (normalizeText(pageNames[pageIndex]) === requestedName) {
                     requestedIndex = pageIndex;
                     break;
                  }
               }
               if (requestedIndex < 0) {
                  throw new Error("Remote-control page ‘" + params.pageName + "’ is not available on this device.");
               }
            }
            if (requestedIndex !== null) {
               if (!isFinite(requestedIndex) || requestedIndex < 0 || requestedIndex >= pageNames.length) {
                  throw new Error("Remote-control page index " + requestedIndex + " is not available on this device.");
               }
            }

            // The cursor can target a device for controller purposes without
            // moving Bitwig's visible Device Panel editor. Select the exact
            // bank item in the editor first, then reveal its native Remote
            // Controls pane. Otherwise the host can select the requested page
            // while leaving the plug-in's long generic parameter view onscreen.
            if (action !== "status") device.selectInEditor();
            later(action === "status" ? 1 : 120, function() {
               try {
                  if (action === "show") {
                     // Collapse the device body and show only the eight
                     // remote controls.
                     device.isExpanded().set(false);
                     device.isRemoteControlsSectionVisible().set(true);
                  } else if (action === "hide") {
                     device.isRemoteControlsSectionVisible().set(false);
                  }
                  if (requestedIndex !== null) cursorRemoteControlsPage.selectedPageIndex().set(requestedIndex);
                  later(250, function() {
                     finish(request, true, remoteControlsSnapshot());
                  });
               } catch (error) {
                  finish(request, false, { message: String(error.message || error) });
               }
            });
         });
         return;
      case "selected_device_remote_controls":
         try {
            var selectedAction = String(params.action || "status");
            var expectedSelectedName = String(params.deviceName || "").trim();
            if (selectedAction !== "status" && selectedAction !== "show" && selectedAction !== "hide") {
               throw new Error("Remote-controls action must be status, show, or hide.");
            }
            if (!cursorDevice.exists().get()) throw new Error("No Bitwig device is currently selected.");
            if (expectedSelectedName && cursorDevice.name().get() !== expectedSelectedName) {
               throw new Error("Safety check failed: the selected device is ‘" + cursorDevice.name().get() + "’, not ‘" + expectedSelectedName + "’.");
            }
            var selectedPageNames = arrayCopy(cursorRemoteControlsPage.pageNames().get());
            var selectedPageIndex = params.pageIndex === undefined ? null : Number(params.pageIndex);
            if (params.pageName !== undefined) {
               var selectedRequestedName = normalizeText(params.pageName);
               selectedPageIndex = -1;
               for (var selectedIndex = 0; selectedIndex < selectedPageNames.length; selectedIndex++) {
                  if (normalizeText(selectedPageNames[selectedIndex]) === selectedRequestedName) {
                     selectedPageIndex = selectedIndex;
                     break;
                  }
               }
               if (selectedPageIndex < 0) {
                  throw new Error("Remote-control page ‘" + params.pageName + "’ is not available on the selected device.");
               }
            }
            if (selectedPageIndex !== null &&
               (!isFinite(selectedPageIndex) || selectedPageIndex < 0 || selectedPageIndex >= selectedPageNames.length)) {
               throw new Error("Remote-control page index " + selectedPageIndex + " is not available on the selected device.");
            }
            if (selectedAction !== "status") cursorDevice.selectInEditor();
            later(selectedAction === "status" ? 1 : 120, function() {
               try {
                  if (selectedAction === "show") {
                     // A nested device must remain expanded for Bitwig to draw
                     // its Remote Controls section.
                     cursorDevice.isExpanded().set(true);
                     cursorDevice.isRemoteControlsSectionVisible().set(true);
                  } else if (selectedAction === "hide") {
                     cursorDevice.isRemoteControlsSectionVisible().set(false);
                  }
                  if (selectedPageIndex !== null) cursorRemoteControlsPage.selectedPageIndex().set(selectedPageIndex);
                  later(250, function() {
                     finish(request, true, {
                        device: deviceSnapshot(cursorDevice, cursorDevice.position().get()),
                        remoteControls: remoteControlsSnapshot()
                     });
                  });
               } catch (error) {
                  finish(request, false, { message: String(error.message || error) });
               }
            });
         } catch (error) {
            finish(request, false, { message: String(error.message || error) });
         }
         return;
      case "set_remote_control":
         selectDevice(request, params, function() {
            var requested = Number(params.value);
            if (!(requested >= 0 && requested <= 1)) {
               finish(request, false, { message: "Normalized remote-control value must be between 0 and 1." });
               return;
            }
            var pageNames = arrayCopy(cursorRemoteControlsPage.pageNames().get());
            var pageIndex = params.pageIndex === undefined
               ? pageNames.indexOf(String(params.pageName || ""))
               : Number(params.pageIndex);
            if (!(pageIndex >= 0 && pageIndex < pageNames.length)) {
               finish(request, false, { message: "Remote Controls page was not found." });
               return;
            }
            cursorRemoteControlsPage.selectedPageIndex().set(pageIndex);
            later(200, function() {
               var controlIndex = params.controlIndex === undefined ? -1 : Number(params.controlIndex);
               if (controlIndex < 0 && params.controlName !== undefined) {
                  var requestedName = String(params.controlName);
                  for (var i = 0; i < 8; i++) {
                     if (cursorRemoteControlsPage.getParameter(i).name().get() === requestedName) {
                        controlIndex = i;
                        break;
                     }
                  }
               }
               if (!(controlIndex >= 0 && controlIndex < 8)) {
                  finish(request, false, { message: "Remote control was not found on page ‘" + pageNames[pageIndex] + "’." });
                  return;
               }
               var control = cursorRemoteControlsPage.getParameter(controlIndex);
               if (!control.exists().get()) {
                  finish(request, false, { message: "The requested Remote Control slot is empty." });
                  return;
               }
               control.setImmediately(requested);
               later(400, function() {
                  var actual = control.get();
                  if (differs(actual, requested, 0.02)) {
                     finish(request, false, {
                        message: "Bitwig did not confirm ‘" + control.name().get() + "’: it reads " + actual +
                           " (" + control.displayedValue().get() + "), requested " + requested +
                           ". The control may snap to fixed steps."
                     });
                     return;
                  }
                  finish(request, true, {
                     pageIndex: pageIndex,
                     pageName: pageNames[pageIndex],
                     controlIndex: controlIndex,
                     controlName: control.name().get(),
                     requestedNormalizedValue: requested,
                     actualNormalizedValue: actual,
                     displayValue: control.displayedValue().get(),
                     verifiedByBitwigReadback: Math.abs(actual - requested) <= 0.02
                  });
               });
            });
         });
         return;
      case "set_parameter":
         selectDevice(request, params, function(device) {
            var id = String(params.parameterId);
            if (directIds.indexOf(id) === -1) {
               finish(request, false, { message: "Parameter ID ‘" + id + "’ is not exposed by the selected device. Refresh its parameters." });
               return;
            }
            var requested = Number(params.value);
            if (!(requested >= 0 && requested <= 1)) {
               finish(request, false, { message: "Normalized parameter value must be between 0 and 1." });
               return;
            }
            // Bitwig's bundled generic-device controllers use 128 here. It is
            // also the portable resolution for VST3 direct parameters; larger
            // resolutions are accepted by stock devices but some plug-ins
            // apply their own second scaling pass.
            var resolution = cursorDevice.name().get().indexOf("MatrixBrute") !== -1 &&
               directNames[id] === "Preset" ? 256 : 128;
            var scaledValue = Math.round(requested * (resolution - 1));
            var parameterDevice = resolution === 256 ? cursorDevice : device;
            // Write through the exact device-bank item, not the cursor. This
            // matters when a chain contains several devices with the same
            // name and identical parameter IDs (such as MatrixBrute CC banks).
            parameterDevice.setDirectParameterValueNormalized(id, scaledValue, resolution);
            later(400, function() {
               var actual = directValues[id];
               var difference = actual === undefined ? null : Math.abs(actual - requested);
               var doubleNormalized = parameterDevice.isPlugin().get() &&
                  requested > 0.02 && actual !== undefined && actual < 0.001 &&
                  Math.abs((actual * 16384) - requested) <= 0.02;

               function reply(mode, writtenValue) {
                  actual = directValues[id];
                  difference = actual === undefined ? null : Math.abs(actual - requested);
                  if (!(actual !== undefined && difference <= 0.02)) {
                     finish(request, false, {
                        message: "Bitwig did not confirm parameter ‘" + (directNames[id] || id) + "’: it reads " +
                           (actual === undefined ? "no value" : actual) + ", requested " + requested +
                           ". The parameter may snap to fixed steps or ignore remote changes."
                     });
                     return;
                  }
                  finish(request, true, {
                     parameter: parameterSnapshot(id),
                     requestedNormalizedValue: requested,
                     scaledIntegerValue: writtenValue,
                     resolution: resolution,
                     compatibilityMode: mode,
                     actualNormalizedValue: actual,
                     difference: difference,
                     verifiedByBitwigReadback: actual !== undefined && difference <= 0.02
                  });
               }

               if (!doubleNormalized) {
                  reply("standard", scaledValue);
                  return;
               }

               // Some nonlinear VST3 parameters are normalized a second time
               // by Bitwig. Only compensate after readback proves that exact
               // 1/16384 signature, then verify the compensated result again.
               var compatibilityValue = scaledValue * 16384;
               parameterDevice.setDirectParameterValueNormalized(id, compatibilityValue, resolution);
               later(400, function() { reply("vst3-double-normalization", compatibilityValue); });
            });
         });
         return;
      case "open_device_window":
         selectDevice(request, params, function() {
            cursorDevice.isWindowOpen().set(true);
            later(120, function() {
               finish(request, true, { device: cursorDevice.name().get(), windowOpen: cursorDevice.isWindowOpen().get() });
            });
         });
         return;
      default:
         throw new Error("Unknown Bitwig Agent Bridge method: " + request.method);
   }
}

function markTrack(track) {
   interested(track.exists());
   interested(track.name());
   interested(track.trackType());
   interested(track.mute());
   interested(track.solo());
   interested(track.volume());
   interested(track.volume().displayedValue());
   interested(track.pan());
   interested(track.pan().displayedValue());
   interested(track.color());
}

function markMainTrack(track) {
   markTrack(track);
   interested(track.position());
   interested(track.arm());
   for (var s = 0; s < MAX_SENDS; s++) {
      var send = track.sendBank().getItemAt(s);
      interested(send.exists());
      interested(send.name());
      interested(send);
      interested(send.displayedValue());
      interested(send.isEnabled());
      interested(send.sendMode());
   }
}

function observeTrackMeter(track, index) {
   track.addVuMeterObserver(128, -1, true, function(value) {
      var numeric = Number(value || 0);
      trackMeterLatest[index] = numeric;
      var name = track.name().get();
      if (trackMeterOwner[index] !== name) {
         trackMeterOwner[index] = name;
         trackMeterMaximum[index] = numeric;
      } else if (numeric > Number(trackMeterMaximum[index] || 0)) trackMeterMaximum[index] = numeric;
   });
}

// The maximum only counts when it was measured on the track that sits at this
// position now. After tracks are added, deleted or moved, it starts again from
// the latest level.
function meterMaximumFor(index, name) {
   if (trackMeterOwner[index] !== name) {
      trackMeterOwner[index] = name;
      trackMeterMaximum[index] = Number(trackMeterLatest[index] || 0);
   }
   return Number(trackMeterMaximum[index] || 0);
}

function markDevice(device) {
   interested(device.exists());
   interested(device.name());
   interested(device.deviceType());
   interested(device.position());
   interested(device.isNested());
   interested(device.isPlugin());
   interested(device.isEnabled());
   interested(device.isWindowOpen());
   interested(device.presetName());
   interested(device.sampleName());
}

function markBrowserItem(item) {
   interested(item.exists());
   interested(item.name());
   interested(item.isSelected());
}

function markCueMarker(marker) {
   interested(marker.exists());
   interested(marker.name());
   interested(marker.position());
}

function init() {
   application = host.createApplication();
   arranger = host.createArranger();
   cueMarkerBank = arranger.createCueMarkerBank(MAX_CUE_MARKERS);
   project = host.getProject();
   transport = host.createTransport();
   trackBank = host.createMainTrackBank(MAX_TRACKS, MAX_SENDS, MAX_SCENES);
   masterTrack = host.createMasterTrack(0);
   markTrack(masterTrack);
   sceneBank = trackBank.sceneBank();
   interested(sceneBank.itemCount());
   interested(sceneBank.scrollPosition());
   cursorTrack = host.createCursorTrack("AGENT_BRIDGE_TRACK_CURSOR", "Agent Bridge Track Cursor", 0, MAX_SCENES, true);
   cursorDevice = cursorTrack.createCursorDevice();
   cursorDeviceSlot = cursorDevice.getCursorSlot();
   cursorRemoteControlsPage = cursorDevice.createCursorRemoteControlsPage(8);
   nestedDeviceBank = cursorDeviceSlot.createDeviceBank(MAX_DEVICES);
   effectTrackBank = host.createEffectTrackBank(MAX_EFFECT_TRACKS, 0);
   deviceBank = cursorTrack.createDeviceBank(MAX_DEVICES);
   launcherClip = host.createLauncherCursorClip(CLIP_GRID_WIDTH, CLIP_GRID_HEIGHT);
   launcherClip.addNoteStepObserver(onLauncherNoteStep);

   interested(application.projectName());
   interested(arranger.areCueMarkersVisible());
   interested(cueMarkerBank.itemCount());
   interested(project.isModified());
   interested(trackBank.itemCount());
   interested(trackBank.scrollPosition());
   interested(cursorTrack.exists());
   interested(cursorTrack.name());
   interested(cursorTrack.position());
   interested(deviceBank.itemCount());
   interested(deviceBank.scrollPosition());
   interested(nestedDeviceBank.itemCount());
   interested(nestedDeviceBank.scrollPosition());
   interested(cursorDevice.exists());
   interested(cursorDevice.name());
   interested(cursorDevice.deviceType());
   interested(cursorDevice.position());
   interested(cursorDevice.isNested());
   interested(cursorDevice.isPlugin());
   interested(cursorDevice.isEnabled());
   interested(cursorDevice.isWindowOpen());
   interested(cursorDevice.presetName());
   interested(cursorDevice.sampleName());
   interested(cursorDevice.hasSlots());
   interested(cursorDevice.slotNames());
   interested(cursorDeviceSlot.exists());
   interested(cursorDeviceSlot.name());
   interested(cursorDevice.isExpanded());
   interested(cursorDevice.isRemoteControlsSectionVisible());
   interested(cursorRemoteControlsPage.getName());
   interested(cursorRemoteControlsPage.pageNames());
   interested(cursorRemoteControlsPage.selectedPageIndex());
   interested(cursorRemoteControlsPage.pageCount());
   for (var remoteIndex = 0; remoteIndex < 8; remoteIndex++) {
      var remoteControl = cursorRemoteControlsPage.getParameter(remoteIndex);
      interested(remoteControl.exists());
      interested(remoteControl.name());
      interested(remoteControl);
      interested(remoteControl.displayedValue());
   }
   interested(launcherClip.exists());
   interested(launcherClip.getLoopStart());
   interested(launcherClip.getLoopLength());
   interested(launcherClip.getPlayStart());
   interested(launcherClip.getPlayStop());
   interested(launcherClip.isLoopEnabled());
   interested(launcherClip.color());

   interested(transport.isPlaying());
   interested(transport.isArrangerRecordEnabled());
   interested(transport.isArrangerLoopEnabled());
   interested(transport.isArrangerOverdubEnabled());
   interested(transport.isClipLauncherOverdubEnabled());
   interested(transport.tempo().value());
   interested(transport.tempo().value().displayedValue());
   interested(transport.getPosition());
   interested(application.hasActiveEngine());

   for (var i = 0; i < MAX_TRACKS; i++) {
      var markedTrack = trackBank.getItemAt(i);
      markMainTrack(markedTrack);
      trackIsCursor[i] = markedTrack.createEqualsValue(cursorTrack);
      interested(trackIsCursor[i]);
      observeTrackMeter(markedTrack, i);
      for (var s = 0; s < MAX_SCENES; s++) markSlot(markedTrack.clipLauncherSlotBank().getItemAt(s));
   }
   for (var j = 0; j < MAX_DEVICES; j++) markDevice(deviceBank.getItemAt(j));
   for (var nestedIndex = 0; nestedIndex < MAX_DEVICES; nestedIndex++) markDevice(nestedDeviceBank.getItemAt(nestedIndex));
   for (var cueMarkerIndex = 0; cueMarkerIndex < MAX_CUE_MARKERS; cueMarkerIndex++) {
      markCueMarker(cueMarkerBank.getItemAt(cueMarkerIndex));
   }
   interested(effectTrackBank.itemCount());
   for (var effectIndex = 0; effectIndex < MAX_EFFECT_TRACKS; effectIndex++) {
      markTrack(effectTrackBank.getItemAt(effectIndex));
   }

   cursorDevice.addDirectParameterIdObserver(function(ids) {
      directIds = arrayCopy(ids);
      directNames = {};
      directValues = {};
      directDisplays = {};
      // Display strings are opt-in in Bitwig's Controller API. Observing the
      // current device's IDs lets Bitwig Agent Bridge verify enumerated routing parameters
      // (for example a HW Instrument MIDI output) by their visible names.
      directDisplayObserver.setObservedParameterIds(directIds);
   });
   cursorDevice.addDirectParameterNameObserver(256, function(id, name) {
      directNames[String(id)] = String(name);
   });
   cursorDevice.addDirectParameterNormalizedValueObserver(function(id, value) {
      directValues[String(id)] = Number(value);
   });
   directDisplayObserver = cursorDevice.addDirectParameterValueDisplayObserver(256, function(id, value) {
      directDisplays[String(id)] = String(value);
   });
   saveToLibraryAction = application.getAction("add_to_library");
   jumpToBeginningAction = application.getAction("jump_to_beginning_of_arrangement");
   popupBrowser = host.createPopupBrowser();
   resultColumn = popupBrowser.resultsColumn();
   resultBank = resultColumn.createItemBank(BROWSER_PAGE);
   deviceTypeBank = popupBrowser.deviceTypeColumn().createItemBank(64);
   categoryBank = popupBrowser.categoryColumn().createItemBank(64);
   tagBank = popupBrowser.tagColumn().createItemBank(64);
   fileTypeBank = popupBrowser.fileTypeColumn().createItemBank(64);
   creatorBank = popupBrowser.creatorColumn().createItemBank(128);

   interested(popupBrowser.exists());
   interested(popupBrowser.contentTypeNames());
   interested(popupBrowser.selectedContentTypeIndex());
   interested(resultColumn.exists());
   interested(resultColumn.entryCount());
   interested(popupBrowser.deviceTypeColumn().exists());
   interested(popupBrowser.deviceTypeColumn().entryCount());
   interested(popupBrowser.categoryColumn().exists());
   interested(popupBrowser.categoryColumn().entryCount());
   interested(popupBrowser.tagColumn().exists());
   interested(popupBrowser.tagColumn().entryCount());
   interested(popupBrowser.fileTypeColumn().exists());
   interested(popupBrowser.fileTypeColumn().entryCount());
   interested(popupBrowser.creatorColumn().exists());
   interested(popupBrowser.creatorColumn().entryCount());
   interested(popupBrowser.smartCollectionColumn().exists());
   interested(popupBrowser.locationColumn().exists());
   interested(popupBrowser.deviceColumn().exists());
   interested(resultBank.itemCount());
   interested(resultBank.scrollPosition());
   interested(deviceTypeBank.itemCount());
   interested(deviceTypeBank.scrollPosition());
   interested(categoryBank.itemCount());
   interested(categoryBank.scrollPosition());
   interested(tagBank.itemCount());
   interested(tagBank.scrollPosition());
   interested(fileTypeBank.itemCount());
   interested(fileTypeBank.scrollPosition());
   interested(creatorBank.itemCount());
   interested(creatorBank.scrollPosition());
   interested(popupBrowser.deviceTypeColumn().getWildcardItem().isSelected());
   interested(popupBrowser.categoryColumn().getWildcardItem().isSelected());
   interested(popupBrowser.tagColumn().getWildcardItem().isSelected());
   interested(popupBrowser.fileTypeColumn().getWildcardItem().isSelected());
   interested(popupBrowser.creatorColumn().getWildcardItem().isSelected());
   interested(popupBrowser.smartCollectionColumn().getWildcardItem().isSelected());
   interested(popupBrowser.locationColumn().getWildcardItem().isSelected());
   interested(popupBrowser.deviceColumn().getWildcardItem().isSelected());
   for (var r = 0; r < BROWSER_PAGE; r++) markBrowserItem(resultBank.getItemAt(r));
   for (var t = 0; t < 64; t++) {
      markBrowserItem(deviceTypeBank.getItemAt(t));
      markBrowserItem(categoryBank.getItemAt(t));
      markBrowserItem(tagBank.getItemAt(t));
      markBrowserItem(fileTypeBank.getItemAt(t));
      markBrowserItem(creatorBank.getItemAt(t));
   }
   for (var c = 64; c < 128; c++) markBrowserItem(creatorBank.getItemAt(c));

   if (BRIDGE_TOKEN === "__BRIDGE" + "_TOKEN__") {
      host.showPopupNotification("Bitwig Agent Bridge has no auth token. Run `npm run setup` and reinstall the controller script.");
      host.errorln("Bitwig Agent Bridge refused to start: the auth token placeholder was never stamped. Run `npm run setup` in the project folder.");
      return;
   }

   var datagramBound = host.addDatagramPacketObserver("Bitwig Agent Bridge", BRIDGE_PORT, function(data) {
      var request = null;
      try {
         request = JSON.parse(decodeUtf8(data));
         var replyPort = Number(request.replyPort);
         if (!request || request.protocol !== BRIDGE_PROTOCOL || !request.id || !request.method ||
             !isFinite(replyPort) || replyPort < 1024 || replyPort > 65535) {
            throw new Error("Malformed Bitwig Agent Bridge packet");
         }
         if (!isAuthorized(request)) {
            noteAuthFailure();
            return;
         }
         enqueue(replyPort, String(request.id), String(request.method), request.params || {}, request.timeoutMs);
      } catch (error) {
         host.println("Bitwig Agent Bridge request error: " + error);
         if (isAuthorized(request) && request.id && request.replyPort) {
            respond(request.replyPort, request.id, false, { message: "Invalid Bitwig Agent Bridge request: " + error });
         }
      }
   });
   if (!datagramBound) throw new Error("Bitwig Agent Bridge could not bind UDP port " + BRIDGE_PORT);
   host.showPopupNotification("Bitwig Agent Bridge online");
   host.println("Bitwig Agent Bridge " + BRIDGE_VERSION + " listening on UDP " + BRIDGE_PORT);
}

function flush() {}

function exit() {
   host.println("Bitwig Agent Bridge offline");
}

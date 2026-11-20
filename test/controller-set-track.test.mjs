import assert from "node:assert/strict";
import test from "node:test";
import { loadController, value } from "./support/load-controller.mjs";

// A fake channel that behaves like Bitwig 6.1.7 as measured: volume and send
// levels are raw amplitude roots (dB = 60 * log10(raw)), pan runs -1..1, and
// setting a send level switches the send on. `ignore` lists fields Bitwig
// should silently keep, to test the read-back.
function fakeChannel(name, { type = "Audio", sends = [], ignore = [] } = {}) {
  const state = {
    name, color: [0.5, 0.5, 0.5], volume: 1, pan: 0, mute: false, solo: false, arm: false,
    sends: sends.map(target => ({ name: target, level: 0, enabled: false, mode: "AUTO" }))
  };
  const keeps = field => ignore.includes(field);
  const dbText = raw => (raw > 0 ? `${(60 * Math.log10(raw)).toFixed(1)} dB` : "-Inf dB");
  const sendAt = index => {
    const send = state.sends[index];
    return {
      exists: () => value(() => Boolean(send)),
      name: () => value(() => send.name),
      getRaw: () => send.level,
      setRaw: raw => { if (!keeps("sendLevel")) { send.level = raw; send.enabled = true; } },
      displayedValue: () => value(() => dbText(send.level)),
      isEnabled: () => value(() => send.enabled, next => { if (!keeps("sendEnabled")) send.enabled = next; }),
      sendMode: () => value(() => send.mode, next => { if (!keeps("sendMode")) send.mode = next; })
    };
  };
  const flag = key => value(() => state[key], next => { if (!keeps(key)) state[key] = next; });
  return {
    state,
    exists: () => value(() => true),
    name: () => value(() => state.name),
    setName: next => { if (!keeps("name")) state.name = next; },
    trackType: () => value(() => type),
    position: () => value(() => 0),
    color: () => ({
      red: () => state.color[0], green: () => state.color[1], blue: () => state.color[2],
      set: (r, g, b) => { if (!keeps("color")) state.color = [r, g, b]; }
    }),
    volume: () => ({
      getRaw: () => state.volume,
      setRaw: raw => { if (!keeps("volume")) state.volume = raw; },
      displayedValue: () => value(() => dbText(state.volume))
    }),
    pan: () => ({ getRaw: () => state.pan, setRaw: raw => { if (!keeps("pan")) state.pan = raw; } }),
    mute: () => flag("mute"),
    solo: () => flag("solo"),
    arm: () => flag("arm"),
    sendBank: () => ({ getItemAt: sendAt })
  };
}

function bank(channels) {
  return { itemCount: () => value(() => channels.length), getItemAt: index => channels[index] || { exists: () => value(() => false) } };
}

function setup({ ignore = [] } = {}) {
  const loaded = loadController();
  const { context } = loaded;
  context.dispatch = loaded.originalDispatch;
  const main = [fakeChannel("Drums", { sends: ["Reverb", "Delay"], ignore }), fakeChannel("Bass", { sends: ["Reverb", "Delay"], ignore })];
  const effects = [fakeChannel("Reverb", { type: "Effect", ignore }), fakeChannel("Delay", { type: "Effect", ignore })];
  const master = fakeChannel("Master", { type: "Master", ignore });
  context.trackBank = bank(main);
  context.effectTrackBank = bank(effects);
  context.masterTrack = master;
  function run(params) {
    context.enqueue(5000, "1", "set_track", params, 5000);
    loaded.advance(2000);
    return loaded.responses[0];
  }
  return { ...loaded, main, effects, master, run };
}

const plain = value => JSON.parse(JSON.stringify(value));

test("set_track sets every field and reports what Bitwig reads back", () => {
  const { run, main } = setup();
  const response = run({
    trackIndex: 1, trackName: "Bass", name: "Sub", color: "#3366CC", volumeDb: -6.5, pan: -0.3,
    mute: true, solo: true, arm: true,
    sends: [{ sendIndex: 1, sendName: "Delay", levelDb: -12, enabled: false, mode: "PRE" }]
  });
  assert.equal(response.ok, true, JSON.stringify(response.payload));
  const track = plain(response.payload.track);
  assert.equal(track.name, "Sub");
  assert.equal(track.color, "#3366CC");
  assert.equal(track.volumeDb, -6.5);
  assert.equal(track.pan, -0.3);
  assert.deepEqual([track.mute, track.solo, track.arm], [true, true, true]);
  assert.deepEqual(track.sends[1], { index: 1, name: "Delay", levelDb: -12, enabled: false, mode: "PRE" });
  assert.ok(Math.abs(main[1].state.volume - Math.pow(10, -6.5 / 60)) < 1e-12, "volume is written as a raw amplitude root");
  assert.equal(main[1].state.sends[1].enabled, false, "enabled is applied after the level, which switches the send on");
});

test("set_track works on effect tracks and the master track", () => {
  const effect = setup().run({ trackKind: "effect", trackIndex: 1, trackName: "Delay", volumeDb: -3, pan: 0.5 });
  assert.equal(effect.ok, true, JSON.stringify(effect.payload));
  assert.equal(effect.payload.track.volumeDb, -3);
  assert.equal(effect.payload.track.sends, undefined);
  const master = setup().run({ trackKind: "master", trackIndex: 0, trackName: "Master", volumeDb: 6 });
  assert.equal(master.ok, true, JSON.stringify(master.payload));
  assert.equal(master.payload.track.volumeDb, 6);
});

const keptFields = [
  ["volume", { volumeDb: -6 }, /volume is 0\.0 dB, requested -6 dB/],
  ["pan", { pan: 0.5 }, /pan is 0, requested 0\.5/],
  ["color", { color: "#112233" }, /color is #808080, requested #112233/],
  ["name", { name: "Sub" }, /name is ‘Bass’, requested ‘Sub’/],
  ["mute", { mute: true }, /mute is false, requested true/],
  ["sendLevel", { sends: [{ sendIndex: 0, sendName: "Reverb", levelDb: -10 }] }, /send 0 \(Reverb\) level is -Inf dB, requested -10 dB/],
  ["sendMode", { sends: [{ sendIndex: 0, sendName: "Reverb", mode: "POST" }] }, /send 0 \(Reverb\) mode is AUTO, requested POST/],
  ["sendEnabled", { sends: [{ sendIndex: 0, sendName: "Reverb", enabled: true }] }, /send 0 \(Reverb\) is disabled, requested enabled/]
];

for (const [field, change, message] of keptFields) {
  test(`set_track fails with what Bitwig holds when it keeps the ${field}`, () => {
    const response = setup({ ignore: [field] }).run({ trackIndex: 1, trackName: "Bass", ...change });
    assert.equal(response.ok, false);
    assert.match(response.payload.message, /^Bitwig did not confirm the change: /);
    assert.match(response.payload.message, message);
  });
}

const refusals = [
  ["arm on an effect track", { trackKind: "effect", trackIndex: 0, trackName: "Reverb", arm: true }, /Only main tracks can be armed/],
  ["sends on the master track", { trackKind: "master", trackIndex: 0, trackName: "Master", sends: [{ sendIndex: 0, sendName: "Reverb", levelDb: -6 }] }, /Sends can only be set on main tracks/],
  ["renaming the master track", { trackKind: "master", trackIndex: 0, trackName: "Master", name: "Main" }, /cannot be renamed/],
  ["a send to a different effect track", { trackIndex: 0, trackName: "Drums", sends: [{ sendIndex: 0, sendName: "Delay", levelDb: -6 }] }, /send 0 goes to ‘Reverb’, not ‘Delay’/],
  ["a send the track does not have", { trackIndex: 0, trackName: "Drums", sends: [{ sendIndex: 4, sendName: "X", levelDb: -6 }] }, /has no send 4/],
  ["a send listed twice", { trackIndex: 0, trackName: "Drums", sends: [{ sendIndex: 0, sendName: "Reverb", levelDb: -6 }, { sendIndex: 0, sendName: "Reverb", mode: "PRE" }] }, /Send 0 is listed twice/],
  ["a send above 0 dB", { trackIndex: 0, trackName: "Drums", sends: [{ sendIndex: 0, sendName: "Reverb", levelDb: 3 }] }, /Send level must be from -120 to 0 dB/],
  ["a volume above +6 dB", { trackIndex: 0, trackName: "Drums", volumeDb: 7 }, /Track volume must be from -120 to 6 dB/],
  ["an effect track name used twice", { trackKind: "effect", trackIndex: 1, trackName: "Delay", name: "Reverb" }, /Effect track 0 is already named ‘Reverb’/],
  ["a stale track name", { trackIndex: 1, trackName: "Drums", mute: true }, /track 1 is now named ‘Bass’, not ‘Drums’/],
  ["an empty change", { trackIndex: 1, trackName: "Bass" }, /Nothing to change/]
];

for (const [name, params, message] of refusals) {
  test(`set_track refuses ${name} before anything changes`, () => {
    const { run, main, effects, master } = setup();
    const before = JSON.stringify([main, effects, master].flat().map(c => c.state));
    const response = run(params);
    assert.equal(response.ok, false);
    assert.match(response.payload.message, message);
    assert.equal(JSON.stringify([main, effects, master].flat().map(c => c.state)), before);
  });
}

test("bitwig_tracks lists main tracks with sends, effect tracks and the master", () => {
  const { context } = setup();
  const result = plain(context.listTracks());
  assert.deepEqual(result.tracks.map(t => t.name), ["Drums", "Bass"]);
  assert.deepEqual(result.tracks[0].sends.map(s => [s.index, s.name, s.levelDb, s.enabled, s.mode]), [[0, "Reverb", null, false, "AUTO"], [1, "Delay", null, false, "AUTO"]]);
  assert.deepEqual(result.effectTracks.map(t => [t.index, t.name, t.volumeDb]), [[0, "Reverb", 0], [1, "Delay", 0]]);
  assert.equal(result.master.name, "Master");
  assert.equal(result.tracks[0].volumeDb, 0);
});

import test from "node:test";
import assert from "node:assert/strict";
import { loadController, value } from "./support/load-controller.mjs";

// Tracks are found by channel id. In Bitwig 6.1.7 the id stays with a track
// when it is renamed or moved, while default names follow the position.
function setup(main, effects = ["FX 1"]) {
  const loaded = loadController();
  const { context } = loaded;
  context.dispatch = loaded.originalDispatch;
  const channel = (name, id) => ({
    exists: () => value(() => true),
    name: () => value(() => name),
    channelId: () => value(() => id)
  });
  const mainItems = main.map((name, i) => channel(name, `main-${i}`));
  const effectItems = effects.map((name, i) => channel(name, `fx-${i}`));
  const bank = items => ({ itemCount: () => value(() => items.length), getItemAt: i => items[i] || { exists: () => value(() => false) } });
  context.trackBank = bank(mainItems);
  context.effectTrackBank = bank(effectItems);
  context.masterTrack = channel("Master", "master");
  context.trackSnapshot = (track, index) => ({ id: track.channelId().get(), index, name: track.name().get() });
  return { ...loaded, mainItems };
}

test("a track id finds its track even when other tracks share its name", () => {
  const { context } = setup(["Audio", "Bass", "Audio"]);
  const params = { trackId: "main-2" };
  assert.equal(context.requireTrack(params), context.trackBank.getItemAt(2));
  assert.deepEqual([params.trackKind, params.trackIndex, params.trackName], ["main", 2, "Audio"]);
});

test("a track id still finds the track after it moved", () => {
  const { context, mainItems } = setup(["Inst 1", "Audio 2"]);
  mainItems.reverse();
  const params = { trackId: "main-1" };
  context.requireTrack(params);
  assert.equal(params.trackIndex, 0);
});

test("effect tracks and the master are found by id for tools that take them", () => {
  const { context } = setup(["Drums"]);
  assert.equal(context.requireChannel({ trackId: "fx-0" }).kind, "effect");
  assert.equal(context.requireChannel({ trackId: "master" }).kind, "master");
});

test("main-track tools refuse an effect track or the master", () => {
  const { context } = setup(["Drums"]);
  assert.throws(() => context.requireTrack({ trackId: "fx-0" }), /main tracks only; ‘FX 1’ is an effect track/);
  assert.throws(() => context.requireTrack({ trackId: "master" }), /the master track/);
});

test("an unknown track id is refused", () => {
  const { context, responses, advance } = setup(["Drums"]);
  context.enqueue(5000, "1", "set_track", { trackId: "gone", mute: true }, 5000);
  advance(1000);
  assert.equal(responses[0].ok, false);
  assert.match(responses[0].payload.message, /No track has the id ‘gone’.*Refresh with bitwig_tracks/);
});

test("bitwig_tracks lists ids and no longer flags shared names", () => {
  const { context } = setup(["Audio", "Audio"]);
  const result = JSON.parse(JSON.stringify(context.listTracks()));
  assert.deepEqual(result.tracks.map(t => t.id), ["main-0", "main-1"]);
  assert.equal(result.duplicateNames, undefined);
});

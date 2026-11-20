import test from "node:test";
import assert from "node:assert/strict";
import { loadController, value } from "./support/load-controller.mjs";

// Track and device lists that change a tick after a create or delete, like
// Bitwig's banks do. Each item has a name and a channel id; `onDelete` says
// how many items a delete removes (a group takes its tracks along).
let nextId = 0;
const newId = () => `id-${nextId++}`;
function fakeBank(context, names, onDelete) {
  const items = names.map(name => ({ name, id: newId() }));
  const bank = {
    items,
    itemCount: () => value(() => items.length),
    getItemAt: index => {
      const item = () => items[index];
      return {
        exists: () => value(() => Boolean(item())),
        name: () => value(() => (item() ? item().name : "")),
        channelId: () => value(() => (item() ? item().id : "")),
        setName: next => { const target = item(); context.host.scheduleTask(() => { target.name = next; }, 20); },
        selectInMixer: () => {},
        deleteObject: () => {
          const target = item();
          context.host.scheduleTask(() => {
            const at = items.indexOf(target);
            items.splice(at, onDelete ? onDelete(target) : 1);
          }, 30);
        }
      };
    }
  };
  return bank;
}

function setup({ tracks = ["Drums", "Bass"], effects = ["Reverb"], devices = ["EQ+", "Compressor", "Delay+"], groupSize } = {}) {
  const loaded = loadController();
  const { context } = loaded;
  context.dispatch = loaded.originalDispatch;
  context.trackBank = fakeBank(context, tracks, groupSize ? target => (target.name === "Group" ? groupSize : 1) : null);
  context.effectTrackBank = fakeBank(context, effects);
  context.deviceBank = fakeBank(context, devices);
  context.trackSnapshot = (track, index) => ({ id: track.channelId().get(), index, name: track.name().get() });
  context.masterTrack = { channelId: () => value(() => "master"), name: () => value(() => "Master") };
  context.deviceSnapshot = (device, index) => ({ index, name: device.name().get() });
  context.selectTrack = (request, params, callback) => callback();
  const created = [];
  const add = (bank, name, position) => context.host.scheduleTask(() => {
    bank.items.splice(position < 0 ? bank.items.length : position, 0, { name, id: newId() });
  }, 40);
  context.application = {
    createInstrumentTrack: position => { created.push("instrument"); add(context.trackBank, context.nextDefaultName || "Inst", position); },
    createAudioTrack: position => { created.push("audio"); add(context.trackBank, context.nextDefaultName || "Audio", position); },
    createEffectTrack: position => { created.push("effect"); add(context.effectTrackBank, context.nextDefaultName || "FX", position); }
  };
  return { ...loaded, created };
}

const names = bank => bank.items.map(item => item.name);
const TRACK_ID = (context, index) => context.trackBank.items[index].id;

test("create_track names the track Bitwig actually added", () => {
  const { context, responses, advance } = setup();
  context.enqueue(5000, "1", "create_track", { kind: "instrument", name: "Lead" }, 5000);
  advance(3000);
  assert.equal(responses[0].ok, true, JSON.stringify(responses[0].payload));
  assert.equal(responses[0].payload.created.index, 2);
  assert.deepEqual(names(context.trackBank), ["Drums", "Bass", "Lead"]);
});

test("create_track finds the new track when Bitwig inserts it mid-list", () => {
  const { context, responses, advance } = setup();
  context.application.createAudioTrack = () => context.host.scheduleTask(() => context.trackBank.items.splice(1, 0, { name: "Audio", id: newId() }), 40);
  context.enqueue(5000, "1", "create_track", { kind: "audio", name: "Vox" }, 5000);
  advance(3000);
  assert.equal(responses[0].ok, true, JSON.stringify(responses[0].payload));
  assert.equal(responses[0].payload.created.index, 1);
  assert.deepEqual(names(context.trackBank), ["Drums", "Vox", "Bass"]);
});

test("create_track names new effect tracks in the effect track list", () => {
  const { context, responses, advance } = setup();
  context.enqueue(5000, "1", "create_track", { kind: "effect", name: "Delay Bus" }, 5000);
  advance(3000);
  assert.equal(responses[0].ok, true, JSON.stringify(responses[0].payload));
  assert.equal(responses[0].payload.created.effectTrackIndex, 1);
  assert.deepEqual(names(context.effectTrackBank), ["Reverb", "Delay Bus"]);
  assert.deepEqual(names(context.trackBank), ["Drums", "Bass"]);
});

test("create_track refuses at 64 main tracks before creating anything", () => {
  const tracks = Array.from({ length: 64 }, (_, i) => "T" + i);
  const { context, responses, advance, created } = setup({ tracks });
  context.enqueue(5000, "1", "create_track", { kind: "instrument", name: "Lead" }, 5000);
  advance(3000);
  assert.equal(responses[0].ok, false);
  assert.match(responses[0].payload.message, /already has 64 main tracks.*No track was created/);
  assert.deepEqual(created, []);
});

test("create_track tells the new track apart by id when its default name repeats", () => {
  const { context, responses, advance } = setup({ tracks: ["Inst", "Inst"] });
  context.enqueue(5000, "1", "create_track", { kind: "instrument", name: "Lead" }, 5000);
  advance(5000);
  assert.equal(responses[0].ok, true, JSON.stringify(responses[0].payload));
  assert.deepEqual(names(context.trackBank), ["Inst", "Inst", "Lead"]);
  assert.equal(responses[0].payload.created.id, context.trackBank.items[2].id);
});

test("create_track fails when no new track shows up", () => {
  const { context, responses, advance } = setup();
  context.application.createInstrumentTrack = () => {};
  context.enqueue(5000, "1", "create_track", { kind: "instrument", name: "Lead" }, 5000);
  advance(5000);
  assert.equal(responses[0].ok, false);
  assert.match(responses[0].payload.message, /did not show exactly one new track/);
});

test("delete track succeeds only once the track is gone and the rest kept their order", () => {
  const { context, responses, advance } = setup({ tracks: ["Drums", "Bass", "Keys"] });
  context.enqueue(5000, "1", "delete", { what: "track", trackId: TRACK_ID(context, 1) }, 5000);
  advance(3000);
  assert.equal(responses[0].ok, true, JSON.stringify(responses[0].payload));
  assert.equal(responses[0].payload.removedCount, 1);
  assert.equal(responses[0].payload.verifiedCount, 2);
});

test("delete track reports a group's contents going with it", () => {
  const { context, responses, advance } = setup({ tracks: ["Drums", "Group", "Kick", "Snare", "Keys"], groupSize: 3 });
  context.enqueue(5000, "1", "delete", { what: "track", trackId: TRACK_ID(context, 1) }, 5000);
  advance(3000);
  assert.equal(responses[0].ok, true, JSON.stringify(responses[0].payload));
  assert.equal(responses[0].payload.removedCount, 3);
  assert.match(responses[0].payload.note, /group/);
});

test("delete track fails when Bitwig keeps the track", () => {
  const { context, responses, advance } = setup();
  context.trackBank.getItemAt = (original => index => ({ ...original(index), deleteObject: () => {} }))(context.trackBank.getItemAt);
  context.enqueue(5000, "1", "delete", { what: "track", trackId: TRACK_ID(context, 0) }, 5000);
  advance(5000);
  assert.equal(responses[0].ok, false);
  assert.match(responses[0].payload.message, /did not confirm that the track ‘Drums’ was removed/);
});

test("delete device fails when a different device disappears", () => {
  const { context, responses, advance } = setup();
  context.deviceBank.getItemAt = (original => index => ({
    ...original(index),
    deleteObject: () => context.host.scheduleTask(() => context.deviceBank.items.splice(2, 1), 30)
  }))(context.deviceBank.getItemAt);
  context.enqueue(5000, "1", "delete", { what: "device", trackId: TRACK_ID(context, 0), deviceIndex: 1, deviceName: "Compressor" }, 5000);
  advance(5000);
  assert.equal(responses[0].ok, false);
  assert.match(responses[0].payload.message, /device ‘Compressor’/);
});

test("delete device verifies the device is gone", () => {
  const { context, responses, advance } = setup();
  context.enqueue(5000, "1", "delete", { what: "device", trackId: TRACK_ID(context, 0), deviceIndex: 1, deviceName: "Compressor" }, 5000);
  advance(3000);
  assert.equal(responses[0].ok, true, JSON.stringify(responses[0].payload));
  assert.deepEqual(names(context.deviceBank), ["EQ+", "Delay+"]);
});

test("delete track passes when Bitwig renumbers the default names after it", () => {
  const { context, responses, advance } = setup({ tracks: ["Inst 1", "Inst 2", "Inst 3"] });
  context.trackBank.getItemAt = (original => index => ({
    ...original(index),
    deleteObject: () => context.host.scheduleTask(() => {
      context.trackBank.items.splice(index, 1);
      context.trackBank.items.forEach((item, i) => { item.name = `Inst ${i + 1}`; });
    }, 30)
  }))(context.trackBank.getItemAt);
  context.enqueue(5000, "1", "delete", { what: "track", trackId: TRACK_ID(context, 0) }, 5000);
  advance(3000);
  assert.equal(responses[0].ok, true, JSON.stringify(responses[0].payload));
  assert.deepEqual(names(context.trackBank), ["Inst 1", "Inst 2"]);
});

test("delete track works on effect tracks and refuses the master", () => {
  const effect = setup();
  effect.context.enqueue(5000, "1", "delete", { what: "track", trackId: effect.context.effectTrackBank.items[0].id }, 5000);
  effect.advance(3000);
  assert.equal(effect.responses[0].ok, true, JSON.stringify(effect.responses[0].payload));
  assert.deepEqual(names(effect.context.effectTrackBank), []);
  const master = setup();
  master.context.enqueue(5000, "1", "delete", { what: "track", trackId: "master" }, 5000);
  master.advance(1000);
  assert.match(master.responses[0].payload.message, /master track cannot be deleted/);
});

const deleteRefusals = [
  ["a missing field", { what: "device", deviceIndex: 0, deviceName: "EQ+" }, /Deleting a device needs trackId, deviceIndex, deviceName/],
  ["a field that does not belong", { what: "scene", sceneIndex: 0, sceneName: "Scene 1", deviceIndex: 0 }, /Deleting a scene takes sceneIndex, sceneName; not deviceIndex/],
  ["an unknown kind", { what: "marker" }, /what must be track, device, scene or clip/]
];
for (const [name, params, message] of deleteRefusals) {
  test(`delete refuses ${name}`, () => {
    const { context, responses, advance } = setup();
    context.enqueue(5000, "1", "delete", params, 5000);
    advance(1000);
    assert.equal(responses[0].ok, false);
    assert.match(responses[0].payload.message, message);
    assert.deepEqual(names(context.trackBank), ["Drums", "Bass"]);
  });
}

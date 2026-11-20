import test from "node:test";
import assert from "node:assert/strict";
import { loadController, value } from "./support/load-controller.mjs";

// A scene window of eight that scrolls like Bitwig's: the move shows up on the
// next tick, and `clamp` mimics a bank that stops once the last scene is in view.
function setup({ sceneCount = 20, clips = {}, clamp = false, stuck = false } = {}) {
  const loaded = loadController();
  const { context } = loaded;
  context.dispatch = loaded.originalDispatch;
  const state = { sceneCount, position: 0, launched: [], selected: [], created: [] };
  const scrollPosition = value(() => state.position, next => {
    if (stuck) return;
    const target = clamp ? Math.max(0, Math.min(next, state.sceneCount - 8)) : next;
    context.host.scheduleTask(() => { state.position = target; }, 10);
  });
  const slot = absolute => ({
    absolute,
    exists: () => value(() => absolute < state.sceneCount),
    name: () => value(() => (clips[absolute] || "")),
    hasContent: () => value(() => Boolean(clips[absolute])),
    isSelected: () => value(() => false),
    isPlaying: () => value(() => false),
    select: () => state.selected.push(absolute),
    showInEditor: () => {},
    createEmptyClip: () => { clips[absolute] = "New"; },
    deleteObject: () => { delete clips[absolute]; }
  });
  const track = {
    clipLauncherSlotBank: () => ({ getItemAt: local => slot(state.position + local) }),
    createNewLauncherClip: (slotIndex, lengthBeats) => {
      state.created.push({ slotIndex, lengthBeats });
      context.host.scheduleTask(() => { state.sceneCount = Math.max(state.sceneCount, slotIndex + 1); clips[slotIndex] = "New"; }, 30);
    }
  };
  context.sceneBank = {
    itemCount: () => value(() => state.sceneCount),
    scrollPosition: () => scrollPosition,
    getItemAt: local => ({ launchWithOptions: (q, m) => state.launched.push({ scene: state.position + local, q, m }) })
  };
  context.requireTrack = () => track;
  context.selectTrack = (request, params, callback) => {
    try { callback(track); } catch (error) { context.finish(request, false, { message: String(error.message || error) }); }
  };
  context.readTransport = () => ({});
  return { ...loaded, state, track, clips };
}

const TRACK = { trackIndex: 0, trackName: "Keys" };

test("read_clip selects the clip in the requested scene", () => {
  const { context, responses, advance, state } = setup({ sceneCount: 20, clips: { 10: "Riff" } });
  context.launcherClip = { exists: () => value(() => false) };
  context.enqueue(5000, "1", "read_clip", { ...TRACK, slotIndex: 10 }, 60000);
  advance(2000);
  assert.deepEqual(state.selected, [10]);
  assert.match(responses[0].payload.message, /launcher clip in slot 10/);
});

test("write_clip writes into a slot past the first eight", () => {
  const { context, responses, advance, state, clips } = setup({ sceneCount: 20 });
  let filled;
  context.focusClip = (request, slot, slotIndex) => {
    filled = { absolute: slot.absolute, slotIndex };
    context.finish(request, true, {});
  };
  context.enqueue(5000, "1", "write_clip", { ...TRACK, slotIndex: 14, name: "Riff", lengthBeats: 4, notes: [] }, 60000);
  advance(2000);
  assert.equal(responses[0].ok, true, JSON.stringify(responses[0].payload));
  assert.deepEqual(filled, { absolute: 14, slotIndex: 14 });
  assert.equal(clips[14], "New");
  assert.deepEqual(state.created, []);
});

test("write_clip one past the last scene asks Bitwig for a new scene", () => {
  const { context, responses, advance, state } = setup({ sceneCount: 8 });
  let filled;
  context.focusClip = (request, slot, slotIndex) => {
    filled = { absolute: slot.absolute, slotIndex };
    context.finish(request, true, {});
  };
  context.enqueue(5000, "1", "write_clip", { ...TRACK, slotIndex: 8, name: "Riff", lengthBeats: 16, notes: [] }, 60000);
  advance(2000);
  assert.equal(responses[0].ok, true, JSON.stringify(responses[0].payload));
  assert.deepEqual(state.created, [{ slotIndex: 8, lengthBeats: 16 }]);
  assert.deepEqual(filled, { absolute: 8, slotIndex: 8 });
});

test("write_clip refuses a slot more than one past the last scene", () => {
  const { context, responses, advance, state } = setup({ sceneCount: 8 });
  context.enqueue(5000, "1", "write_clip", { ...TRACK, slotIndex: 9, name: "Riff", lengthBeats: 4, notes: [] }, 60000);
  advance(1000);
  assert.equal(responses[0].ok, false);
  assert.match(responses[0].payload.message, /a new clip can go in slot 8 at most/);
  assert.deepEqual(state.created, []);
});

test("the launcher print waits until the scene window is back on the first scenes", () => {
  const { context, responses, advance, state } = setup();
  state.position = 8;
  context.enqueue(5000, "1", "arrange_launcher_clips", { regions: [{ ...TRACK, slotIndex: 0, startBeats: 0, lengthBeats: 4, clipName: "x" }] }, 120000);
  advance(100);
  assert.equal(responses[0].ok, false);
  assert.match(responses[0].payload.message, /still scrolled/);
  assert.equal(state.position, 0);
});

test("the scene window reset keeps a cleanup the request already had", () => {
  const { context, responses, advance, state } = setup({ sceneCount: 20 });
  const order = [];
  context.selectTrack = (request, params, callback) => {
    request.cleanup = () => order.push("selection");
    callback(context.requireTrack());
  };
  context.enqueue(5000, "1", "read_clip", { ...TRACK, slotIndex: 12 }, 5000);
  advance(2000);
  assert.ok(responses.length === 1);
  assert.deepEqual(order, ["selection"]);
  advance(100);
  assert.equal(state.position, 0);
});

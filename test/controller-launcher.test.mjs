import assert from "node:assert/strict";
import test from "node:test";
import { loadController, value } from "./support/load-controller.mjs";

// A launcher shaped like Bitwig 6.1.7 as measured: a scene window of eight
// that scrolls on the next tick (`clamp` stops it at the last full window),
// unnamed scenes named by position ("Scene 3"), a duplicate landing right
// after its original, and slot states that change a few ticks after a launch
// or stop. `ignore` lists actions Bitwig should not carry out.
function setup({ scenes: sceneSpecs = 12, tracks: trackNames = ["Keys", "Bass"], clips = {}, clamp = false, stuck = false, ignore = [] } = {}) {
  const loaded = loadController();
  const { context } = loaded;
  context.dispatch = loaded.originalDispatch;
  const later = (fn, ms = 30) => context.host.scheduleTask(fn, ms);
  const log = [];
  const scenes = Array.from({ length: sceneSpecs }, () => ({ name: "", color: [0x49 / 255, 0x49 / 255, 0x49 / 255], clips: {} }));
  for (const [key, spec] of Object.entries(clips)) {
    const [t, s] = key.split(":").map(Number);
    scenes[s].clips[t] = typeof spec === "string" ? { name: spec, state: "stopped" } : { state: "stopped", ...spec };
  }
  const state = { position: 0, transportReturned: false };
  const sceneName = i => scenes[i].name || `Scene ${i + 1}`;
  const scrollPosition = value(() => state.position, next => {
    if (stuck) return;
    const target = clamp ? Math.max(0, Math.min(next, scenes.length - 8)) : next;
    later(() => { state.position = target; }, 10);
  });
  const colorValue = get => ({ red: () => get()[0], green: () => get()[1], blue: () => get()[2] });
  const setState = (clip, next) => { if (clip) clip.state = next; };

  const slot = (t, local) => {
    const clip = () => scenes[state.position + local] && scenes[state.position + local].clips[t];
    const is = s => value(() => Boolean(clip()) && clip().state === s);
    return {
      exists: () => value(() => state.position + local < scenes.length),
      hasContent: () => value(() => Boolean(clip())),
      name: () => value(() => (clip() ? clip().name : "")),
      color: () => colorValue(() => [0.2, 0.4, 0.8]),
      isPlaying: () => is("playing"), isPlaybackQueued: () => is("queued"), isStopQueued: () => is("stopQueued"),
      isRecording: () => is("recording"), isRecordingQueued: () => is("recordingQueued"),
      launchWithOptions: (q, m) => {
        const target = clip();
        log.push(["launchClip", t, state.position + local, q, m]);
        if (!ignore.includes("launch")) later(() => setState(target, "queued"));
      }
    };
  };
  const scene = local => {
    const index = () => state.position + local;
    return {
      exists: () => value(() => index() < scenes.length),
      name: () => value(() => sceneName(index()), next => { if (!ignore.includes("name")) { const i = index(); later(() => { scenes[i].name = next; }); } }),
      color: () => Object.assign(colorValue(() => scenes[index()].color), { set: (r, g, b) => { scenes[index()].color = [r, g, b]; } }),
      clipCount: () => value(() => Object.keys(scenes[index()].clips).length),
      launchWithOptions: (q, m) => {
        const i = index();
        log.push(["launchScene", i, q, m]);
        if (!ignore.includes("launch")) later(() => Object.values(scenes[i].clips).forEach(c => setState(c, "playing")));
      },
      duplicateObject: () => {
        const i = index();
        log.push(["duplicate", i]);
        const copy = ignore.includes("copyClips") ? { name: "", color: scenes[i].color, clips: {} } : { ...scenes[i], clips: JSON.parse(JSON.stringify(scenes[i].clips)) };
        later(() => scenes.splice(i + 1, 0, copy));
      },
      deleteObject: () => { const i = index(); log.push(["delete", i]); later(() => scenes.splice(i, 1)); }
    };
  };
  const stopTrack = t => scenes.forEach(s => { const c = s.clips[t]; if (c && ["playing", "queued"].includes(c.state)) c.state = "stopQueued"; });
  const tracks = trackNames.map((name, t) => ({
    exists: () => value(() => true),
    name: () => value(() => name),
    isStopped: () => value(() => !scenes.some(s => s.clips[t] && s.clips[t].state === "playing")),
    isQueuedForStop: () => value(() => scenes.some(s => s.clips[t] && s.clips[t].state === "stopQueued")),
    clipLauncherSlotBank: () => ({ getItemAt: local => slot(t, local) }),
    stop: () => { log.push(["stop", t]); if (!ignore.includes("stop")) later(() => stopTrack(t)); },
    returnToArrangement: () => { log.push(["return", t]); later(() => stopTrack(t)); }
  }));
  context.trackBank = { itemCount: () => value(() => tracks.length), getItemAt: i => tracks[i] };
  context.sceneBank = { itemCount: () => value(() => scenes.length), scrollPosition: () => scrollPosition, getItemAt: scene };
  context.project = { createScene: () => { log.push(["create"]); later(() => scenes.push({ name: "", color: [0x49 / 255, 0x49 / 255, 0x49 / 255], clips: {} })); } };
  context.transport = { returnToArrangement: () => { log.push(["transportReturn"]); later(() => trackNames.forEach((_, t) => stopTrack(t))); } };
  context.readTransport = () => ({ playing: true });

  function run(method, params, ms = 20000) {
    context.enqueue(5000, "1", method, params, 60000);
    loaded.advance(ms);
    return loaded.responses[0];
  }
  return { ...loaded, scenes, state, log, run, sceneName };
}

const plain = v => JSON.parse(JSON.stringify(v));

// ---------------------------------------------------------- bitwig_launcher

test("launcher lists every scene with its clips and states, and scrolls the window back", () => {
  const { run, state } = setup({ scenes: 20, clips: { "0:2": "A", "1:9": { name: "B", state: "playing" }, "0:17": "C" } });
  const response = run("launcher", { sceneLimit: 128 });
  assert.equal(response.ok, true, JSON.stringify(response.payload));
  assert.equal(response.payload.returned, 20);
  const withClips = response.payload.scenes.filter(s => s.clips.length).map(s => [s.index, s.name, s.clips.map(c => [c.trackName, c.name, c.state])]);
  assert.deepEqual(plain(withClips), [[2, "Scene 3", [["Keys", "A", "stopped"]]], [9, "Scene 10", [["Bass", "B", "playing"]]], [17, "Scene 18", [["Keys", "C", "stopped"]]]]);
  assert.deepEqual(plain(response.payload.tracks.map(t => [t.name, t.stopped])), [["Keys", true], ["Bass", false]]);
  assert.equal(state.position, 0);
});

test("launcher reads the last scenes when Bitwig stops scrolling at the last full window", () => {
  const { run } = setup({ scenes: 12, clips: { "0:0": "A", "0:11": "Z" }, clamp: true });
  const response = run("launcher", {});
  assert.deepEqual(plain(response.payload.scenes.filter(s => s.clips.length).map(s => s.index)), [0, 11]);
});

test("launcher pages over scenes and narrows to one track", () => {
  const { run } = setup({ scenes: 20, clips: { "0:5": "A", "1:5": "B", "0:15": "C" } });
  const response = run("launcher", { trackIndex: 1, trackName: "Bass", sceneOffset: 4, sceneLimit: 3 });
  assert.equal(response.ok, true, JSON.stringify(response.payload));
  assert.deepEqual(plain(response.payload.scenes.map(s => [s.index, s.clips.map(c => c.name)])), [[4, []], [5, ["B"]], [6, []]]);
  assert.deepEqual(plain(response.payload.tracks.map(t => t.name)), ["Bass"]);
});

// ---------------------------------------------------------- bitwig_edit_scene

test("edit_scene creates a scene at the end and names and colors it", () => {
  const { run, scenes } = setup({ scenes: 8 });
  const response = run("edit_scene", { create: true, name: "Outro", color: "#33AA55" });
  assert.equal(response.ok, true, JSON.stringify(response.payload));
  assert.deepEqual(plain(response.payload.scene), { index: 8, name: "Outro", color: "#33AA55", clipCount: 0 });
  assert.equal(scenes.length, 9);
});

test("edit_scene duplicates a scene with its clips right after it", () => {
  const { run, scenes } = setup({ scenes: 10, clips: { "0:9": "A", "1:9": "B" } });
  const response = run("edit_scene", { sceneIndex: 9, sceneName: "Scene 10", duplicate: true, name: "Chorus 2" });
  assert.equal(response.ok, true, JSON.stringify(response.payload));
  assert.deepEqual(plain([response.payload.scene.index, response.payload.scene.name, response.payload.scene.clipCount]), [10, "Chorus 2", 2]);
  assert.equal(response.payload.duplicatedFrom.index, 9);
  assert.equal(scenes.length, 11);
});

test("edit_scene reports a duplicate that did not copy the clips", () => {
  const { run } = setup({ scenes: 4, clips: { "0:1": "A" }, ignore: ["copyClips"] });
  const response = run("edit_scene", { sceneIndex: 1, sceneName: "Scene 2", duplicate: true, name: "x" });
  assert.equal(response.ok, false);
  assert.match(response.payload.message, /scene 2 holds 0 clips where the copy of scene 1 should hold 1\. Nothing else was changed\./);
});

test("edit_scene fails with what Bitwig holds when it keeps the old name", () => {
  const response = setup({ ignore: ["name"] }).run("edit_scene", { sceneIndex: 0, sceneName: "Scene 1", name: "Intro" });
  assert.equal(response.ok, false);
  assert.match(response.payload.message, /name is ‘Scene 1’, requested ‘Intro’/);
});

const sceneRefusals = [
  ["a stale scene name", { sceneIndex: 0, sceneName: "Verse", name: "x" }, /scene 0 is now named ‘Scene 1’, not ‘Verse’/],
  ["create with a scene", { create: true, sceneIndex: 0, sceneName: "Scene 1" }, /create adds a scene at the end; it takes no sceneIndex/],
  ["create and duplicate", { create: true, duplicate: true }, /create or duplicate, not both/],
  ["nothing to change", { sceneIndex: 0, sceneName: "Scene 1" }, /Nothing to change/],
  ["a scene the project does not have", { sceneIndex: 12, sceneName: "Scene 13", name: "x" }, /Slot 12 does not exist\. The project has 12 scenes/]
];
for (const [name, params, message] of sceneRefusals) {
  test(`edit_scene refuses ${name}`, () => {
    const { run, log } = setup();
    const response = run("edit_scene", params);
    assert.equal(response.ok, false);
    assert.match(response.payload.message, message);
    assert.deepEqual(log, []);
  });
}

test("delete_scene removes one exact scene and checks the next one moved up", () => {
  const { run, scenes } = setup({ scenes: 4, clips: { "0:1": "A", "0:2": "B", "1:2": "C" } });
  const response = run("delete_scene", { sceneIndex: 1, sceneName: "Scene 2" });
  assert.equal(response.ok, true, JSON.stringify(response.payload));
  assert.equal(scenes.length, 3);
  assert.equal(response.payload.deleted.clipCount, 1);
});

// ---------------------------------------------------------- bitwig_launch

test("launch starts every clip of a scene past the first eight", () => {
  const { run, log, state } = setup({ scenes: 20, clips: { "0:12": "A", "1:12": "B" } });
  const response = run("launch", { sceneIndex: 12, sceneName: "Scene 13", quantization: "1", launchMode: "from_start" });
  assert.equal(response.ok, true, JSON.stringify(response.payload));
  assert.deepEqual(plain(log), [["launchScene", 12, "1", "from_start"]]);
  assert.deepEqual(plain(response.payload.clips.map(c => [c.trackName, c.state])), [["Keys", "playing"], ["Bass", "playing"]]);
  assert.equal(state.position, 0);
});

test("launch starts one clip with Bitwig's default options", () => {
  const { run, log } = setup({ clips: { "1:3": "Bassline" } });
  const response = run("launch", { trackIndex: 1, trackName: "Bass", slotIndex: 3 });
  assert.equal(response.ok, true, JSON.stringify(response.payload));
  assert.deepEqual(plain(log), [["launchClip", 1, 3, "default", "default"]]);
  assert.equal(response.payload.launched.state, "queued");
});

test("launch fails when Bitwig does not start the clip", () => {
  const response = setup({ clips: { "1:3": "Bassline" }, ignore: ["launch"] }).run("launch", { trackIndex: 1, trackName: "Bass", slotIndex: 3 });
  assert.equal(response.ok, false);
  assert.match(response.payload.message, /Bitwig did not start the clip: ‘Bass’ slot 3 is stopped/);
});

test("stop stops one track and accepts a stop that waits for the bar", () => {
  const { run, log } = setup({ clips: { "0:1": { name: "A", state: "playing" }, "1:1": { name: "B", state: "playing" } } });
  const response = run("launch", { action: "stop", trackIndex: 0, trackName: "Keys" });
  assert.equal(response.ok, true, JSON.stringify(response.payload));
  assert.deepEqual(plain(log), [["stop", 0]]);
  assert.deepEqual(plain(response.payload.tracks.map(t => [t.name, t.stopQueued])), [["Keys", true]]);
});

test("stop fails when a clip keeps playing", () => {
  const response = setup({ clips: { "0:9": { name: "A", state: "playing" } }, ignore: ["stop"] }).run("launch", { action: "stop" });
  assert.equal(response.ok, false);
  assert.match(response.payload.message, /did not stop every launcher clip: ‘Keys’ slot 9 is playing/);
});

test("returnToArrangement on all tracks goes through the transport", () => {
  const { run, log } = setup({ clips: { "0:0": { name: "A", state: "playing" } } });
  const response = run("launch", { action: "returnToArrangement" });
  assert.equal(response.ok, true, JSON.stringify(response.payload));
  assert.deepEqual(plain(log), [["transportReturn"]]);
});

const launchRefusals = [
  ["a scene without clips", { sceneIndex: 4, sceneName: "Scene 5" }, /Scene 4 has no clips on the tracks the bridge reaches; nothing was launched/],
  ["an empty slot", { trackIndex: 0, trackName: "Keys", slotIndex: 4 }, /Slot 4 on ‘Keys’ is empty; nothing was launched/],
  ["a scene and a clip at once", { sceneIndex: 0, sceneName: "Scene 1", trackIndex: 0, trackName: "Keys", slotIndex: 0 }, /Launch a scene .* or a clip/],
  ["an unknown quantization", { trackIndex: 0, trackName: "Keys", slotIndex: 0, quantization: "3" }, /quantization must be one of default, none/],
  ["a stop with a slot", { action: "stop", trackIndex: 0, trackName: "Keys", slotIndex: 0 }, /takes no scene, slot or launch options/],
  ["a slot above 1023", { trackIndex: 0, trackName: "Keys", slotIndex: 1024 }, /from 0 to 1023/],
  ["a stale track name", { trackIndex: 0, trackName: "Lead", slotIndex: 0 }, /track 0 is now named ‘Keys’, not ‘Lead’/]
];
for (const [name, params, message] of launchRefusals) {
  test(`launch refuses ${name}`, () => {
    const { run, log } = setup({ clips: { "0:0": "A" } });
    const response = run("launch", params);
    assert.equal(response.ok, false);
    assert.match(response.payload.message, message);
    assert.deepEqual(log, []);
  });
}

test("a scene window that will not scroll fails the request", () => {
  const response = setup({ scenes: 20, clips: { "0:12": "A" }, stuck: true }).run("launch", { sceneIndex: 12, sceneName: "Scene 13" }, 3000);
  assert.equal(response.ok, false);
  assert.match(response.payload.message, /did not scroll its scene window to slot 12/);
});

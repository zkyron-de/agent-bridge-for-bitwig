import assert from "node:assert/strict";
import test from "node:test";
import { loadController } from "./support/load-controller.mjs";

// Fake launcher cursor clip that behaves like Bitwig 6.1.7 as measured:
// notes live at absolute beats; the visible grid is CLIP_GRID_WIDTH steps from
// the scroll position; every scroll or step-size change reports changed cells
// through the controller's note-step observer; a note between steps shows up
// at the step it starts in; NoteStep setters reject out-of-range values; and
// NoteStep.gain() reads twice the value setGain() takes.
function fakeClip(context, { notes = [], loop = { enabled: true, start: 0, length: 4 }, hooks = {} } = {}) {
  const width = context.CLIP_GRID_WIDTH;
  const state = {
    notes: notes.map(n => ({ channel: 0, velocity: 100, timbre: 0, pan: 0, gain: 0, muted: false, ...n })),
    stepSize: 0.25, scroll: 0, visible: new Set(), exists: true, loop: { ...loop },
    color: [0.5, 0.5, 0.5], log: []
  };
  const stepOf = note => Math.floor(note.beat / state.stepSize + 1e-9);
  const noteAt = (channel, x, y) => state.notes.find(n => n.channel === channel && n.pitch === y && stepOf(n) === state.scroll + x);
  const ranged = (name, min, max, apply) => value => {
    if (!(value >= min && value <= max)) throw new Error(`Parameter ${name} (=${value}) must be in the range ${min} to ${max}`);
    apply(value);
  };
  const step = (channel, x, y) => {
    const note = noteAt(channel, x, y);
    const set = (field, transform = v => v) => value => {
      if (!note) return;
      const next = hooks.onSet ? hooks.onSet(note, field, transform(value)) : transform(value);
      if (next !== undefined) note[field] = next;
    };
    return {
      channel: () => channel, x: () => x, y: () => y,
      state: () => (note ? "NoteOn" : "Empty"),
      velocity: () => (note ? note.velocity / 127 : 0),
      duration: () => (note ? note.duration : 0),
      timbre: () => (note ? note.timbre : 0),
      pan: () => (note ? note.pan : 0),
      gain: () => (note ? note.gain * 2 : 0),
      isMuted: () => (note ? note.muted : false),
      setVelocity: set("velocity", v => Math.round(v * 127)),
      setDuration: set("duration"),
      setTimbre: ranged("timbre", -1, 1, set("timbre")),
      setPan: ranged("pan", -1, 1, set("pan")),
      setGain: ranged("gain", 0, 1, set("gain")),
      setIsMuted: set("muted")
    };
  };
  function refresh() {
    const next = new Set();
    for (const note of state.notes) {
      const x = stepOf(note) - state.scroll;
      if (x >= 0 && x < width) next.add(`${note.channel}:${x}:${note.pitch}`);
    }
    for (const key of state.visible) if (!next.has(key)) context.onLauncherNoteStep(step(...key.split(":").map(Number)));
    for (const key of next) context.onLauncherNoteStep(step(...key.split(":").map(Number)));
    state.visible = next;
  }
  const value = (get, set) => ({ get, set: set || (() => {}) });
  const clip = {
    state,
    exists: () => value(() => state.exists),
    getLoopStart: () => value(() => state.loop.start, v => { state.loop.start = v; }),
    getLoopLength: () => value(() => state.loop.length, v => { state.loop.length = v; }),
    isLoopEnabled: () => value(() => state.loop.enabled, v => { state.loop.enabled = v; }),
    getPlayStart: () => value(() => 0),
    getPlayStop: () => value(() => state.loop.start + state.loop.length),
    color: () => ({
      red: () => state.color[0], green: () => state.color[1], blue: () => state.color[2],
      set: (r, g, b) => { if (!hooks.ignoreColor) state.color = [r, g, b]; }
    }),
    setName(name) { if (!hooks.ignoreName) state.name = name; },
    setStepSize(size) { state.stepSize = size; refresh(); },
    scrollToKey() {},
    scrollToStep(position) { state.scroll = position; refresh(); },
    getStep: step,
    setStep(channel, x, pitch, velocity, duration) {
      state.log.push(["setStep", channel, state.scroll + x, pitch]);
      state.notes = state.notes.filter(n => !(n.channel === channel && n.pitch === pitch && stepOf(n) === state.scroll + x));
      let note = { beat: (state.scroll + x) * state.stepSize, pitch, velocity, duration, channel, timbre: 0, pan: 0, gain: 0, muted: false };
      if (hooks.onCreate) note = hooks.onCreate(note);
      if (note) state.notes.push(note);
      refresh();
    },
    clearStep(channel, x, pitch) {
      state.log.push(["clearStep", channel, state.scroll + x, pitch]);
      state.notes = state.notes.filter(n => !(n.channel === channel && n.pitch === pitch && stepOf(n) === state.scroll + x));
      if (hooks.onClear) hooks.onClear(state);
      refresh();
    }
  };
  return clip;
}

function fakeSlot(clip, { hasContent = true } = {}) {
  const slot = {
    content: hasContent,
    selected: false,
    exists: () => ({ get: () => true }),
    name: () => ({ get: () => clip.state.name || "Clip" }),
    hasContent: () => ({ get: () => slot.content }),
    isSelected: () => ({ get: () => slot.selected }),
    isPlaying: () => ({ get: () => false }),
    select() { slot.selected = true; },
    showInEditor() {},
    deleteObject() { slot.content = false; clip.state.notes = []; },
    createEmptyClip(lengthBeats) {
      slot.content = true;
      clip.state.created = lengthBeats;
      clip.state.loop = { enabled: true, start: 0, length: lengthBeats };
    }
  };
  return slot;
}

function withClip(options = {}) {
  const loaded = loadController();
  const { context } = loaded;
  context.dispatch = loaded.originalDispatch;
  const clip = fakeClip(context, options);
  const slot = fakeSlot(clip, options.slot);
  const track = { clipLauncherSlotBank: () => ({ getItemAt: () => slot }) };
  context.launcherClip = clip;
  context.sceneBank = { itemCount: () => ({ get: () => 8 }), scrollPosition: () => ({ get: () => 0, set() {} }) };
  context.selectTrack = (request, params, callback) => {
    try { callback(track); } catch (error) { context.finish(request, false, { message: String(error.message || error) }); }
  };
  function run(method, params, ms = 30000) {
    loaded.context.enqueue(5000, "1", method, { ...TRACK, slotIndex: 0, ...params }, 120000);
    loaded.advance(ms);
    return loaded.responses[0];
  }
  return { ...loaded, clip, slot, track, run };
}

const TRACK = { trackIndex: 0, trackName: "Inst 1" };
const plain = value => JSON.parse(JSON.stringify(value));

// ------------------------------------------------------------------ read_clip

test("read_clip reads notes with expressions across pages and channels", () => {
  const notes = [
    { beat: 0, pitch: 60, velocity: 100, duration: 0.5, timbre: -0.5, pan: 0.25, gain: 0.4 },
    { beat: 0, pitch: 64, velocity: 90, duration: 0.25, channel: 3 },
    { beat: 70.5, pitch: 67, velocity: 1, duration: 1, muted: true },
    { beat: 127.75, pitch: 127, velocity: 127, duration: 0.25 }
  ];
  const { run } = withClip({ notes, loop: { enabled: true, start: 0, length: 128 } });
  const response = run("read_clip", {});
  assert.equal(response.ok, true, JSON.stringify(response.payload));
  assert.equal(response.payload.noteCount, 4);
  assert.deepEqual(plain(response.payload.clip.loop), { enabled: true, startBeats: 0, lengthBeats: 128 });
  assert.deepEqual(plain(response.payload.notes), [
    { beat: 0, pitch: 60, channel: 0, velocity: 100, duration: 0.5, timbre: -0.5, pan: 0.25, gain: 0.4, muted: false },
    { beat: 0, pitch: 64, channel: 3, velocity: 90, duration: 0.25, timbre: 0, pan: 0, gain: 0, muted: false },
    { beat: 70.5, pitch: 67, channel: 0, velocity: 1, duration: 1, timbre: 0, pan: 0, gain: 0, muted: true },
    { beat: 127.75, pitch: 127, channel: 0, velocity: 127, duration: 0.25, timbre: 0, pan: 0, gain: 0, muted: false }
  ]);
});

test("read_clip keeps off-grid timing on a fine grid and snaps it on a coarse one", () => {
  const notes = [{ beat: 1.03125, pitch: 60, duration: 0.25 }];
  const fine = withClip({ notes }).run("read_clip", { stepsPerBeat: 96 });
  assert.equal(fine.payload.notes[0].beat, 1.03125);
  const coarse = withClip({ notes }).run("read_clip", { stepsPerBeat: 4 });
  assert.equal(coarse.payload.notes[0].beat, 1);
  assert.match(coarse.payload.note, /1\/4-beat grid/);
});

test("read_clip reads notes outside the loop and pages long results", () => {
  const notes = Array.from({ length: 10 }, (_, i) => ({ beat: i, pitch: 60, duration: 0.5 }));
  const { run } = withClip({ notes, loop: { enabled: true, start: 0, length: 12 } });
  const response = run("read_clip", { offset: 4, limit: 3 });
  assert.equal(response.payload.noteCount, 10);
  assert.equal(response.payload.returned, 3);
  assert.deepEqual(plain(response.payload.notes.map(n => n.beat)), [4, 5, 6]);
});

test("read_clip fails on an empty slot", () => {
  const response = withClip({ slot: { hasContent: false } }).run("read_clip", {});
  assert.equal(response.ok, false);
  assert.match(response.payload.message, /Clip slot 0 has no clip/);
});

test("read_clip fails when Bitwig does not expose the clip", () => {
  const run = withClip();
  run.clip.state.exists = false;
  const response = run.run("read_clip", {});
  assert.equal(response.ok, false);
  assert.match(response.payload.message, /did not expose the launcher clip in slot 0/);
});

test("read_clip skips observer cells that getStep no longer confirms", () => {
  const run = withClip({ notes: [{ beat: 0, pitch: 60, duration: 1 }] });
  run.context.launcherNoteCells["0:5:70"] = true;
  const response = run.run("read_clip", {});
  assert.deepEqual(plain(response.payload.notes.map(n => n.pitch)), [60]);
});

test("read_clip refuses a grid finer than the step limit before reading", () => {
  const { run, clip } = withClip({ loop: { enabled: true, start: 0, length: 512 } });
  const response = run("read_clip", { stepsPerBeat: 96 });
  assert.equal(response.ok, false);
  assert.match(response.payload.message, /49152 grid steps, over the 16384-step limit/);
  assert.equal(clip.state.stepSize, 0.25, "the grid was not touched");
});

test("read_clip refuses stepsPerBeat outside 1-960", () => {
  const response = withClip().run("read_clip", { stepsPerBeat: 1000 });
  assert.match(response.payload.message, /stepsPerBeat must be a whole number from 1 to 960/);
});

// ----------------------------------------------------------------- write_clip

const WRITE = {
  name: "Riff", lengthBeats: 128, color: "#3366CC",
  notes: [
    { beat: 0, pitch: 60, velocity: 100, duration: 0.5, timbre: 0.5, gain: 0.25 },
    { beat: 0.5, pitch: 64, velocity: 90, duration: 0.25, channel: 2, pan: -1 },
    { beat: 96, pitch: 67, velocity: 110, duration: 1, muted: true }
  ]
};

function write(params = WRITE, options = {}) {
  return withClip({ slot: { hasContent: false }, ...options });
}

test("write_clip succeeds only after every note and property reads back", () => {
  const run = write();
  const response = run.run("write_clip", WRITE);
  assert.equal(response.ok, true, JSON.stringify(response.payload));
  assert.equal(response.payload.notesWritten, 3);
  assert.equal(response.payload.notesVerified, 3);
  assert.equal(response.payload.clip.name, "Riff");
  assert.equal(response.payload.clip.color, "#3366CC");
  assert.deepEqual(plain(response.payload.clip.loop), { enabled: true, startBeats: 0, lengthBeats: 128 });
  const stored = run.clip.state.notes.find(n => n.pitch === 60);
  assert.equal(stored.timbre, 0.5);
  assert.equal(stored.gain, 0.25, "gain is written on the setter's scale");
});

test("write_clip writes fine-grid notes at their exact position", () => {
  const run = write();
  const params = { name: "Fine", lengthBeats: 4, stepsPerBeat: 96, notes: [{ beat: 1.03125, pitch: 36, duration: 0.0625 }] };
  const response = run.run("write_clip", params);
  assert.equal(response.ok, true, JSON.stringify(response.payload));
  assert.equal(run.clip.state.notes[0].beat, 1.03125);
});

test("write_clip creates a fractional-length clip as its loop", () => {
  const run = write();
  const response = run.run("write_clip", { name: "Odd", lengthBeats: 6.5, notes: [] });
  assert.equal(response.ok, true, JSON.stringify(response.payload));
  assert.equal(run.clip.state.created, 7, "Bitwig creates whole-beat clips");
  assert.deepEqual(plain(response.payload.clip.loop), { enabled: true, startBeats: 0, lengthBeats: 6.5 });
});

const mismatches = [
  ["a dropped note", { onCreate: note => (note.pitch === 67 ? null : note) }, /pitch 67 at beat 96 \(channel 0\) is missing/],
  ["a wrong velocity", { onCreate: note => ({ ...note, velocity: note.pitch === 60 ? 99 : note.velocity }) }, /pitch 60 at beat 0 \(channel 0\): velocity is 99, requested 100/],
  ["a wrong duration", { onCreate: note => ({ ...note, duration: note.pitch === 64 ? 0.5 : note.duration }) }, /pitch 64 at beat 0.5 \(channel 2\): duration is 0.5, requested 0.25/],
  ["a shifted pitch", { onCreate: note => ({ ...note, pitch: note.pitch === 60 ? 61 : note.pitch }) }, /pitch 60 at beat 0 \(channel 0\) is missing.*unexpected pitch 61 at beat 0 \(channel 0\)/],
  ["a shifted start", { onCreate: note => ({ ...note, beat: note.pitch === 67 ? 96.25 : note.beat }) }, /pitch 67 at beat 96 \(channel 0\) is missing.*unexpected pitch 67 at beat 96.25/],
  ["a wrong channel", { onCreate: note => ({ ...note, channel: note.pitch === 64 ? 0 : note.channel }) }, /pitch 64 at beat 0.5 \(channel 2\) is missing.*unexpected pitch 64 at beat 0.5 \(channel 0\)/],
  ["an unmuted note", { onSet: (note, field, value) => (field === "muted" ? false : value) }, /pitch 67 at beat 96 \(channel 0\): note is not muted/],
  ["a lost timbre", { onSet: (note, field, value) => (field === "timbre" ? 0 : value) }, /pitch 60 at beat 0 \(channel 0\): timbre is 0, requested 0.5/],
  ["a wrong gain", { onSet: (note, field, value) => (field === "gain" ? 0.3 : value) }, /pitch 60 at beat 0 \(channel 0\): gain is 0.3, requested 0.25/]
];

for (const [name, hooks, message] of mismatches) {
  test(`write_clip fails loudly on ${name}`, () => {
    const response = write(WRITE, { hooks }).run("write_clip", WRITE);
    assert.equal(response.ok, false, `expected a failure for ${name}`);
    // A note that never appears stops the setter pass part-way; either way the
    // reply must carry the exact difference between request and clip.
    assert.match(response.payload.message, /^(Note verification failed: clip slot 0 does not hold the 3 expected notes|Bitwig stopped the change part-way: .* Clip slot 0 now differs from the request)/);
    assert.match(response.payload.message, message);
  });
}

test("write_clip fails when Bitwig does not apply the clip color", () => {
  const response = write(WRITE, { hooks: { ignoreColor: true } }).run("write_clip", WRITE);
  assert.equal(response.ok, false);
  assert.match(response.payload.message, /color is #808080, requested #3366CC/);
});

test("write_clip fails when Bitwig does not apply the clip name", () => {
  const response = write(WRITE, { hooks: { ignoreName: true } }).run("write_clip", WRITE);
  assert.match(response.payload.message, /name is ‘Clip’, requested ‘Riff’/);
});

test("write_clip accepts a color one 8-bit step off, as Bitwig stores it", () => {
  const run = write();
  run.clip.color = () => ({
    red: () => 0xE0 / 255, green: () => 0xA0 / 255, blue: () => 0x2F / 255, set() {}
  });
  const response = run.run("write_clip", { name: "Amber", lengthBeats: 4, color: "#E0A030", notes: [] });
  assert.equal(response.ok, true, JSON.stringify(response.payload));
});

test("write_clip lists at most five differences and counts the rest", () => {
  const notes = Array.from({ length: 8 }, (_, i) => ({ beat: i, pitch: 60 + i, duration: 0.25 }));
  const response = write(WRITE, { hooks: { onCreate: () => null } }).run("write_clip", { ...WRITE, notes });
  assert.match(response.payload.message, /does not hold the 8 expected notes/);
  assert.match(response.payload.message, /; and 3 more\.$/);
});

const refusals = [
  ["an off-grid start", { beat: 0.1, pitch: 60, duration: 0.25 }, /does not start on the 1\/4-beat grid/],
  ["a start past the clip end", { beat: 4, pitch: 60, duration: 0.25 }, /must start between beat 0 and the clip end at beat 4/],
  ["a note running past the clip end", { beat: 3.5, pitch: 60, duration: 1 }, /ends by the clip end at beat 4/],
  ["a timbre above 1", { beat: 0, pitch: 60, duration: 1, timbre: 1.5 }, /timbre 1.5; it must be from -1 to 1/],
  ["a negative gain", { beat: 0, pitch: 60, duration: 1, gain: -0.5 }, /gain -0.5; it must be from 0 to 1/],
  ["a missing duration", { beat: 0, pitch: 60 }, /needs a duration/]
];

for (const [name, note, message] of refusals) {
  test(`write_clip refuses ${name} before Bitwig is touched`, () => {
    const run = write();
    const response = run.run("write_clip", { name: "x", lengthBeats: 4, notes: [note] });
    assert.equal(response.ok, false);
    assert.match(response.payload.message, message);
    assert.equal(run.slot.content, false, "no clip was created");
  });
}

test("write_clip refuses two notes on the same grid cell before Bitwig is touched", () => {
  const run = write();
  const note = { beat: 1, pitch: 60, duration: 0.25 };
  const response = run.run("write_clip", { name: "x", lengthBeats: 4, notes: [note, { ...note, velocity: 50 }] });
  assert.match(response.payload.message, /Notes 0 and 1 both start at pitch 60 at beat 1 \(channel 0\)/);
  assert.equal(run.slot.content, false);
});

test("write_clip refuses a slot with content unless replace is set", () => {
  const run = withClip({ notes: [{ beat: 0, pitch: 50, duration: 1 }] });
  const refused = run.run("write_clip", { name: "x", lengthBeats: 4, notes: [] });
  assert.match(refused.payload.message, /already has content\. Pass replace=true/);
  assert.equal(run.clip.state.notes.length, 1, "the old clip is untouched");
});

test("write_clip with replace deletes the old clip first", () => {
  const run = withClip({ notes: [{ beat: 0, pitch: 50, duration: 1 }] });
  const response = run.run("write_clip", { name: "New", lengthBeats: 4, replace: true, notes: [{ beat: 1, pitch: 60, duration: 1 }] });
  assert.equal(response.ok, true, JSON.stringify(response.payload));
  assert.deepEqual(run.clip.state.notes.map(n => n.pitch), [60]);
});

test("write_clip reports the clip state when Bitwig stops part-way", () => {
  const hooks = { onSet: (note, field, value) => { if (field === "gain") throw new Error("Parameter gain (=0.25) must be in the range 0.0 to 1.0"); return value; } };
  const response = write(WRITE, { hooks }).run("write_clip", WRITE);
  assert.equal(response.ok, false);
  assert.match(response.payload.message, /^Bitwig stopped the change part-way: Parameter gain/);
  assert.match(response.payload.message, /now differs from the request: pitch 60 at beat 0 \(channel 0\): gain is 0, requested 0.25/);
});

// ------------------------------------------------------------------ edit_clip

const EXISTING = [
  { beat: 0, pitch: 60, velocity: 100, duration: 0.5, timbre: 0.2, gain: 0.4 },
  { beat: 1, pitch: 62, velocity: 80, duration: 0.25 },
  { beat: 2, pitch: 64, velocity: 70, duration: 1, pan: -0.5 }
];

function edit(options = {}) {
  return withClip({ notes: EXISTING, loop: { enabled: true, start: 0, length: 4 }, ...options });
}

test("edit_clip changes only the given fields and keeps every other note", () => {
  const run = edit();
  const response = run.run("edit_clip", { setNotes: [{ beat: 0, pitch: 60, velocity: 64, pan: 0.5 }] });
  assert.equal(response.ok, true, JSON.stringify(response.payload));
  assert.equal(response.payload.notesUpdated, 1);
  assert.equal(response.payload.notesVerified, 3);
  const note = run.clip.state.notes.find(n => n.pitch === 60);
  assert.deepEqual([note.velocity, note.pan, note.timbre, note.gain, note.duration], [64, 0.5, 0.2, 0.4, 0.5]);
  assert.equal(run.clip.state.log.length, 0, "an update uses NoteStep setters, not setStep");
});

test("edit_clip adds and removes single notes", () => {
  const run = edit();
  const response = run.run("edit_clip", {
    setNotes: [{ beat: 3, pitch: 67, duration: 0.5, timbre: -1 }],
    removeNotes: [{ beat: 1, pitch: 62 }]
  });
  assert.equal(response.ok, true, JSON.stringify(response.payload));
  assert.deepEqual([response.payload.notesCreated, response.payload.notesRemoved], [1, 1]);
  assert.deepEqual(run.clip.state.notes.map(n => n.pitch).sort(), [60, 64, 67]);
  assert.equal(run.clip.state.notes.find(n => n.pitch === 67).timbre, -1);
});

test("edit_clip changes name, loop and color", () => {
  const run = edit();
  const response = run.run("edit_clip", { name: "Verse", color: "#112233", loop: { startBeats: 1, lengthBeats: 2, enabled: false } });
  assert.equal(response.ok, true, JSON.stringify(response.payload));
  assert.equal(response.payload.clip.name, "Verse");
  assert.equal(response.payload.clip.color, "#112233");
  assert.deepEqual(plain(response.payload.clip.loop), { enabled: false, startBeats: 1, lengthBeats: 2 });
  assert.equal(response.payload.notesVerified, 3, "notes outside the new loop are still read");
});

test("edit_clip fails when a note it did not touch changes", () => {
  const hooks = { onClear: state => { state.notes.find(n => n.pitch === 64).velocity = 1; } };
  const response = edit({ hooks }).run("edit_clip", { removeNotes: [{ beat: 1, pitch: 62 }] });
  assert.equal(response.ok, false);
  assert.match(response.payload.message, /pitch 64 at beat 2 \(channel 0\): velocity is 1, requested 70/);
});

test("edit_clip fails when Bitwig keeps a removed note", () => {
  const run = edit();
  run.clip.clearStep = () => {};
  const response = run.run("edit_clip", { removeNotes: [{ beat: 1, pitch: 62 }] });
  assert.match(response.payload.message, /unexpected pitch 62 at beat 1 \(channel 0\)/);
});

const editRefusals = [
  ["removing a note that is not there", { removeNotes: [{ beat: 3, pitch: 60 }] }, /Cannot remove pitch 60 at beat 3 \(channel 0\): the clip has no note there\. Nothing was changed\./],
  ["setting and removing the same note", { setNotes: [{ beat: 1, pitch: 62, velocity: 1 }], removeNotes: [{ beat: 1, pitch: 62 }] }, /is both set and removed\. Nothing was changed\./],
  ["a new note without a duration", { setNotes: [{ beat: 3, pitch: 70 }] }, /New note pitch 70 at beat 3 \(channel 0\) needs a duration\. Nothing was changed\./],
  ["an empty change", {}, /Nothing to change/]
];

for (const [name, params, message] of editRefusals) {
  test(`edit_clip refuses ${name} without changing anything`, () => {
    const run = edit();
    const before = JSON.stringify(run.clip.state.notes);
    const response = run.run("edit_clip", params);
    assert.equal(response.ok, false);
    assert.match(response.payload.message, message);
    assert.equal(JSON.stringify(run.clip.state.notes), before);
    assert.equal(run.clip.state.log.length, 0);
  });
}

import assert from "node:assert/strict";
import test from "node:test";
import { loadController, value } from "./support/load-controller.mjs";

// A transport shaped like Bitwig 6.1.7 as measured: changes show up a tick
// later, setPosition is ignored while playing, jumpToPlayStartPosition starts
// a stopped transport, the metronome volume ignores set(), stopping turns
// launcher overdub off, and arranger record drags automation write along.
// `ignore` lists settings Bitwig should keep unchanged.
function setup({ playing = false, ignore = [] } = {}) {
  const loaded = loadController();
  const { context } = loaded;
  context.dispatch = loaded.originalDispatch;
  const later = fn => context.host.scheduleTask(fn, 20);
  const log = [];
  const s = {
    playing, record: false, tempo: 120, numerator: 4, denominator: 4, position: 10, playStart: 10,
    loop: false, loopStart: 0, loopLength: 8, metronome: false, metronomeVolume: 0.75,
    preRoll: "none", arrangerOverdub: false, launcherOverdub: false, automationArranger: false, automationMode: "latch", launchQuantization: "1"
  };
  const settable = (key, onSet) => value(() => s[key], next => {
    log.push([key, next]);
    if (ignore.includes(key)) return;
    later(() => { s[key] = next; if (onSet) onSet(next); });
  });
  const enumValue = key => settable(key);
  context.transport = {
    isPlaying: () => value(() => s.playing),
    isArrangerRecordEnabled: () => settable("record", next => { s.automationArranger = next; }),
    tempo: () => ({ value: () => ({ getRaw: () => s.tempo, setRaw: next => { log.push(["tempo", next]); if (!ignore.includes("tempo")) later(() => { s.tempo = next; }); }, displayedValue: () => value(() => `${s.tempo} BPM`) }) }),
    timeSignature: () => ({
      set: text => {
        log.push(["timeSignature", text]);
        const [n, d] = text.split("/").map(Number);
        if (![1, 2, 4, 8, 16, 32].includes(d) || n > 32) return;
        later(() => { s.numerator = n; s.denominator = d; });
      },
      numerator: () => value(() => s.numerator),
      denominator: () => value(() => s.denominator)
    }),
    getPosition: () => value(() => s.position),
    setPosition: beats => { log.push(["setPosition", beats]); if (!s.playing) later(() => { s.position = beats; s.playStart = beats; }); },
    playStartPosition: () => value(() => s.playStart, next => { log.push(["playStart", next]); s.playStart = next; if (!s.playing) s.position = next; }),
    jumpToPlayStartPosition: () => { log.push(["jump"]); later(() => { s.position = s.playStart; s.playing = true; }); },
    isArrangerLoopEnabled: () => settable("loop"),
    arrangerLoopStart: () => settable("loopStart"),
    arrangerLoopDuration: () => settable("loopLength"),
    isMetronomeEnabled: () => settable("metronome"),
    metronomeVolume: () => ({
      get: () => s.metronomeVolume,
      set: next => log.push(["metronomeVolume.set", next]),
      setImmediately: next => { log.push(["metronomeVolume", next]); s.metronomeVolume = next; },
      displayedValue: () => value(() => `${(s.metronomeVolume * 48 - 48).toFixed(1)} dB`)
    }),
    preRoll: () => enumValue("preRoll"),
    isArrangerOverdubEnabled: () => settable("arrangerOverdub"),
    isClipLauncherOverdubEnabled: () => settable("launcherOverdub"),
    isArrangerAutomationWriteEnabled: () => settable("automationArranger"),
    automationWriteMode: () => enumValue("automationMode"),
    defaultLaunchQuantization: () => enumValue("launchQuantization"),
    play: () => { log.push(["play"]); later(() => { s.playing = true; }); },
    stop: () => { log.push(["stop"]); if (!ignore.includes("stop")) later(() => { s.playing = false; s.launcherOverdub = false; }); },
    continuePlayback: () => { log.push(["continue"]); later(() => { s.playing = true; }); },
    restart: () => { log.push(["restart"]); later(() => { s.playing = true; s.position = s.playStart; }); }
  };

  function run(params, ms = 3000) {
    context.enqueue(5000, "1", "transport", params, 15000);
    loaded.advance(ms);
    return loaded.responses[0];
  }
  return { ...loaded, s, log, run };
}

const plain = v => JSON.parse(JSON.stringify(v));

test("transport without fields reads the full state and changes nothing", () => {
  const { run, log } = setup();
  const response = run({});
  assert.equal(response.ok, true);
  assert.deepEqual(plain(response.payload.loop), { enabled: false, startBeats: 0, lengthBeats: 8 });
  assert.equal(response.payload.timeSignature, "4/4");
  assert.equal(response.payload.metronome.volumeDisplay, "-12.0 dB");
  assert.deepEqual(log, []);
});

test("transport applies and reads back every setting", () => {
  const { run, s } = setup();
  const response = run({
    tempo: 128, timeSignature: "7/8", loop: { enabled: true, startBeats: 16, lengthBeats: 14 }, metronome: { enabled: true, volume: 0.5 },
    preRoll: "one_bar", arrangerOverdub: true, launcherOverdub: true, automationWrite: { arranger: true, mode: "touch" }, defaultLaunchQuantization: "1/4"
  });
  assert.equal(response.ok, true, JSON.stringify(response.payload));
  assert.deepEqual(plain([s.tempo, s.numerator, s.denominator, s.loop, s.loopStart, s.loopLength, s.metronome, s.metronomeVolume, s.preRoll, s.automationMode, s.launchQuantization]),
    [128, 7, 8, true, 16, 14, true, 0.5, "one_bar", "touch", "1/4"]);
  assert.equal(response.payload.timeSignature, "7/8");
});

test("transport sets the metronome volume with setImmediately, which Bitwig takes", () => {
  const { run, log } = setup();
  assert.equal(run({ metronome: { volume: 0.5 } }).ok, true);
  assert.ok(!log.some(entry => entry[0] === "metronomeVolume.set"));
});

test("transport moves a stopped playhead with setPosition and does not start playback", () => {
  const { run, s, log } = setup();
  const response = run({ positionBeats: 32 });
  assert.equal(response.ok, true, JSON.stringify(response.payload));
  assert.deepEqual([s.position, s.playStart, s.playing], [32, 32, false]);
  assert.ok(!log.some(entry => entry[0] === "jump"));
});

test("transport moves a running playhead by jumping to a new play start", () => {
  const { run, s, log } = setup({ playing: true });
  const response = run({ positionBeats: 64 });
  assert.equal(response.ok, true, JSON.stringify(response.payload));
  assert.deepEqual(plain(log), [["playStart", 64], ["jump"]]);
  assert.equal(s.position, 64);
});

test("transport sets the position before it starts playback", () => {
  const { run, log } = setup();
  const response = run({ positionBeats: 4, playback: "play" });
  assert.equal(response.ok, true, JSON.stringify(response.payload));
  assert.deepEqual(plain(log.map(entry => entry[0])), ["setPosition", "play"]);
});

test("transport fails with what Bitwig holds", () => {
  const response = setup({ ignore: ["tempo", "preRoll"] }).run({ tempo: 128, preRoll: "two_bars" });
  assert.equal(response.ok, false);
  assert.match(response.payload.message, /tempo is 120 BPM, requested 128 BPM; preRoll is none, requested two_bars/);
});

test("transport reports a time signature Bitwig refuses", () => {
  const response = setup().run({ timeSignature: "7/3" });
  assert.equal(response.ok, false);
  assert.match(response.payload.message, /timeSignature is 4\/4, requested 7\/3/);
});

test("transport fails when Bitwig keeps playing after stop", () => {
  const response = setup({ playing: true, ignore: ["stop"] }).run({ playback: "stop" });
  assert.equal(response.ok, false);
  assert.match(response.payload.message, /playing is true, requested false/);
});

const refusals = [
  ["stop with launcher overdub on", { playback: "stop", launcherOverdub: true }, /turns launcher overdub off when the transport stops/],
  ["an unknown playback action", { playback: "pause" }, /playback must be one of play, stop, continue, restart/],
  ["a tempo out of range", { tempo: 700 }, /tempo must be from 20 to 666 BPM/],
  ["a malformed time signature", { timeSignature: "4-4" }, /timeSignature must look like 4\/4/],
  ["an empty loop", { loop: {} }, /loop needs enabled, startBeats or lengthBeats/],
  ["a zero loop length", { loop: { lengthBeats: 0 } }, /loop.lengthBeats must be above 0/],
  ["a metronome volume above 1", { metronome: { volume: 2 } }, /metronome.volume must be a normalized value/],
  ["an unknown automation mode", { automationWrite: { mode: "trim" } }, /automationWrite.mode must be one of latch, touch, write/]
];
for (const [name, params, message] of refusals) {
  test(`transport refuses ${name} before changing anything`, () => {
    const { run, log } = setup();
    const response = run(params);
    assert.equal(response.ok, false);
    assert.match(response.payload.message, message);
    assert.deepEqual(log, []);
  });
}

import assert from "node:assert/strict";
import test from "node:test";
import { loadController, value } from "./support/load-controller.mjs";

// An action registry and undo history shaped like Bitwig 6.1.7: localized
// names, stable English ids, invoke() that reports nothing, and undo state
// that changes a tick after undo or redo.
function setup({ canUndo = true, canRedo = false, ignore = [] } = {}) {
  const loaded = loadController();
  const { context } = loaded;
  context.dispatch = loaded.originalDispatch;
  const later = fn => context.host.scheduleTask(fn, 20);
  const s = { canUndo, canRedo, layout: "ARRANGE", scenes: 8, metronome: false };
  const log = [];
  const categories = {};
  const action = (id, name, category, run) => {
    const a = { getId: () => id, getName: () => name, getMenuItemText: () => name, getCategory: () => categories[category], invoke: () => { log.push(["invoke", id]); if (run) later(run); } };
    categories[category] = categories[category] || { getId: () => category, getName: () => category.toUpperCase(), list: [] };
    categories[category].getActions = () => categories[category].list;
    categories[category].list.push(a);
    return a;
  };
  const actions = [
    action("toggle_metronome", "Metronome ein- oder ausstellen", "document", () => { s.metronome = !s.metronome; }),
    action("Create Scene", "Neue Szene", "document", () => { s.scenes += 1; s.canUndo = true; }),
    action("Save", "Sichern", "file"),
    action("Quit", "Beenden", "file"),
    action("Dialog: OK", "OK", "dialog")
  ];
  context.application = {
    getActions: () => actions,
    getAction: id => actions.find(a => a.getId() === id) || null,
    getActionCategories: () => Object.values(categories),
    getActionCategory: id => categories[id] || null,
    projectName: () => value(() => "Song"),
    canUndo: () => value(() => s.canUndo),
    canRedo: () => value(() => s.canRedo),
    panelLayout: () => value(() => s.layout),
    setPanelLayout: layout => { log.push(["layout", layout]); if (!ignore.includes("layout")) later(() => { s.layout = layout; }); },
    undo: () => { log.push(["undo"]); if (!ignore.includes("undo")) later(() => { s.scenes -= 1; s.canRedo = true; }); },
    redo: () => { log.push(["redo"]); later(() => { s.scenes += 1; s.canUndo = true; s.canRedo = false; }); }
  };
  context.project = { isModified: () => value(() => true) };
  context.transportSnapshot = () => ({ playing: false, arrangerRecord: false, tempo: 120, timeSignature: "4/4", loop: { enabled: false }, metronome: { enabled: s.metronome }, arrangerOverdub: false, automationWrite: { arranger: false } });
  context.listTracks = () => ({ tracks: [{ name: "Keys" }], effectTracks: [] });
  context.sceneBank = { itemCount: () => value(() => s.scenes) };
  context.cursorTrack = { exists: () => value(() => true), name: () => value(() => "Keys") };
  context.cursorDevice = { exists: () => value(() => false) };

  function run(method, params) {
    context.enqueue(5000, "1", method, params, 15000);
    loaded.advance(3000);
    return loaded.responses[0];
  }
  return { ...loaded, s, log, run };
}

const plain = v => JSON.parse(JSON.stringify(v));

test("actions are found by localized name or id, ignoring case and spaces", () => {
  const response = setup().run("find_actions", { query: "  SZENE " });
  assert.deepEqual(plain(response.payload.actions.map(a => [a.id, a.category])), [["Create Scene", "document"]]);
  assert.equal(response.payload.totalActions, 5);
});

test("action search narrows to one category and marks blocked actions", () => {
  const response = setup().run("find_actions", { category: "file" });
  assert.deepEqual(plain(response.payload.actions.map(a => [a.id, a.blocked || ""])), [["Save", ""], ["Quit", "quits Bitwig Studio"]]);
});

test("action search pages its results", () => {
  const response = setup().run("find_actions", { offset: 1, limit: 2 });
  assert.deepEqual(plain([response.payload.matched, response.payload.returned, response.payload.actions.map(a => a.id)]), [5, 2, ["Create Scene", "Save"]]);
});

test("action search lists categories on request and refuses an unknown one", () => {
  const listed = setup().run("find_actions", { includeCategories: true, limit: 1 });
  assert.deepEqual(plain(listed.payload.categories.map(c => [c.id, c.actions])), [["document", 2], ["file", 2], ["dialog", 1]]);
  assert.equal(listed.payload.returned, 1);
  assert.match(setup().run("find_actions", { category: "nope" }).payload.message, /no action category ‘nope’/);
});

test("an invoked action reports what the bridge saw change", () => {
  const response = setup().run("invoke_action", { actionId: "Create Scene" });
  assert.equal(response.ok, true, JSON.stringify(response.payload));
  assert.deepEqual(plain(response.payload.observedChanges), { sceneCount: { before: 8, after: 9 } });
});

test("an action without visible effect says so instead of claiming success", () => {
  const response = setup().run("invoke_action", { actionId: "Save" });
  assert.equal(response.ok, true);
  assert.deepEqual(plain(response.payload.observedChanges), {});
  assert.match(response.payload.note, /does not report whether an action did anything.*nothing there changed/);
});

test("undo is confirmed through Bitwig's undo state", () => {
  const response = setup().run("invoke_action", { command: "undo" });
  assert.equal(response.ok, true, JSON.stringify(response.payload));
  assert.deepEqual(plain(response.payload.observedChanges.sceneCount), { before: 8, after: 7 });
});

test("undo fails when Bitwig leaves nothing to redo", () => {
  const response = setup({ ignore: ["undo"] }).run("invoke_action", { command: "undo" });
  assert.equal(response.ok, false);
  assert.match(response.payload.message, /nothing to redo afterwards, so Bitwig did not undo/);
});

test("the panel layout is read back", () => {
  assert.equal(setup().run("invoke_action", { panelLayout: "MIX" }).ok, true);
  const ignored = setup({ ignore: ["layout"] }).run("invoke_action", { panelLayout: "MIX" });
  assert.match(ignored.payload.message, /panel layout is ARRANGE, requested MIX/);
});

const refusals = [
  ["a blocked action", { actionId: "Quit" }, /does not invoke ‘Quit’: it quits Bitwig Studio/],
  ["a dialog answer", { actionId: "Dialog: OK" }, /answers whatever dialog is open/],
  ["an unknown action", { actionId: "nope" }, /no action with the id ‘nope’/],
  ["redo with nothing to redo", { command: "redo" }, /nothing to redo/],
  ["two things at once", { actionId: "Save", command: "undo" }, /exactly one of actionId, command or panelLayout/]
];
for (const [name, params, message] of refusals) {
  test(`invoke_action refuses ${name}`, () => {
    const { run, log } = setup();
    const response = run("invoke_action", params);
    assert.equal(response.ok, false);
    assert.match(response.payload.message, message);
    assert.deepEqual(log, []);
  });
}

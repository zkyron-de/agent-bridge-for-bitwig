import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const SOURCE = readFileSync(new URL("../controller/BitwigAgentBridge.control.js", import.meta.url), "utf8");

// Loads the controller script against a fake Bitwig host with a manual clock,
// so request handling can be tested without Bitwig running.
function loadController() {
  const clock = { now: 0, tasks: [] };
  const responses = [];
  const host = {
    defineController() {},
    defineMidiPorts() {},
    addDeviceNameBasedDiscoveryPair() {},
    scheduleTask(callback, delay) { clock.tasks.push({ at: clock.now + delay, callback }); },
    println() {},
    errorln() {}
  };
  const context = vm.createContext({ loadAPI() {}, host, Date: { now: () => clock.now } });
  vm.runInContext(SOURCE, context);
  context.respond = (port, id, ok, payload) => responses.push({ id, ok, payload });

  function advance(ms) {
    const end = clock.now + ms;
    for (;;) {
      clock.tasks.sort((a, b) => a.at - b.at);
      const next = clock.tasks[0];
      if (!next || next.at > end) break;
      clock.tasks.shift();
      clock.now = next.at;
      next.callback();
    }
    clock.now = end;
  }

  return { context, responses, advance, originalDispatch: context.dispatch };
}

test("a step that throws fails its own request and frees the bridge", () => {
  const { context, responses, advance } = loadController();
  context.dispatch = request => {
    if (request.method === "bad") context.later(10, () => { throw new Error("boom"); });
    else context.finish(request, true, { done: true });
  };
  context.enqueue(5000, "1", "bad", {}, 5000);
  context.enqueue(5000, "2", "good", {}, 5000);
  advance(100);
  assert.deepEqual(responses.map(r => [r.id, r.ok]), [["1", false], ["2", true]]);
  assert.match(responses[0].payload.message, /boom/);
  assert.equal(context.requestBusy, false);
});

test("a request that stalls inside Bitwig times out and the next one runs", () => {
  const { context, responses, advance } = loadController();
  context.dispatch = request => {
    if (request.method === "good") context.finish(request, true, {});
  };
  context.enqueue(5000, "1", "hang", {}, 500);
  context.enqueue(5000, "2", "good", {}, 5000);
  advance(1400);
  assert.equal(responses.length, 0, "still within the stalled request's limit");
  advance(200);
  assert.deepEqual(responses.map(r => [r.id, r.ok]), [["1", false], ["2", true]]);
  assert.match(responses[0].payload.message, /did not finish hang within 1500 ms/);
});

test("late steps of a timed-out request don't answer twice or release the next request", () => {
  const { context, responses, advance } = loadController();
  context.dispatch = request => {
    if (request.method === "slow") context.later(2000, () => context.finish(request, true, { late: true }));
    if (request.method === "second") context.later(1000, () => context.finish(request, true, {}));
  };
  context.enqueue(5000, "1", "slow", {}, 500);
  context.enqueue(5000, "2", "second", {}, 5000);
  advance(2100);
  assert.deepEqual(responses.map(r => [r.id, r.ok]), [["1", false]]);
  assert.equal(context.currentRequest.id, "2", "second request is still running");
  advance(500);
  assert.deepEqual(responses.map(r => [r.id, r.ok]), [["1", false], ["2", true]]);
});

test("requests the client already gave up on are skipped", () => {
  const { context, responses, advance } = loadController();
  const dispatched = [];
  context.dispatch = request => dispatched.push(request.method);
  context.enqueue(5000, "1", "hang", {}, 500);
  context.enqueue(5000, "2", "abandoned", {}, 1000);
  advance(1600);
  assert.deepEqual(dispatched, ["hang"]);
  assert.deepEqual(responses.map(r => r.id), ["1"]);
});

test("requests with the wrong token get no reply and are counted", () => {
  const { context } = loadController();
  const popups = [];
  const errors = [];
  context.host.showPopupNotification = message => popups.push(message);
  context.host.errorln = message => errors.push(message);
  assert.equal(context.isAuthorized({ token: "wrong" }), false);
  assert.equal(context.isAuthorized(null), false);
  assert.equal(context.isAuthorized({ token: context.BRIDGE_TOKEN }), true);
  for (let i = 0; i < 100; i += 1) context.noteAuthFailure();
  assert.equal(popups.length, 1);
  assert.equal(errors.length, 2);
  assert.match(errors[1], /ignored 100 request/);
});

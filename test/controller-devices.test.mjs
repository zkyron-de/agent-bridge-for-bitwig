import assert from "node:assert/strict";
import test from "node:test";
import { loadController, value } from "./support/load-controller.mjs";

// Fakes for the device chain, the popup browser and the remote-controls page,
// shaped like Bitwig 6.1.7 as measured: the browser filters by location,
// committing a result inserts a device a few ticks later, and a remote page
// change shows up on the next tick.
function setup({ devices = ["EQ+"], results = [], locations = ["All Locations", "Devices", "Presets"], trackType = "Audio", trackName = "Bus", pages = { Gains: ["1 Gain", "2 Gain"], Freqs: ["1 Freq"] }, onCommit, onInsertFile, ignore = [] } = {}) {
  const loaded = loadController();
  const { context } = loaded;
  context.dispatch = loaded.originalDispatch;
  const log = [];
  const later = (fn, ms = 30) => context.host.scheduleTask(fn, ms);

  // Device chain.
  const chain = devices.map(spec => (typeof spec === "string" ? { name: spec } : spec)).map(d => ({ presetName: "init", sampleName: "", enabled: true, windowOpen: false, expanded: true, remoteVisible: false, plugin: false, type: "audio-effect", ...d }));
  const flag = (d, key, name) => value(() => d[key], next => { if (!ignore.includes(name)) d[key] = next; });
  const deviceAt = index => {
    const d = () => chain[index];
    return {
      exists: () => value(() => Boolean(d())),
      name: () => value(() => (d() ? d().name : "")),
      deviceType: () => value(() => d().type),
      position: () => value(() => index),
      isPlugin: () => value(() => d().plugin),
      isEnabled: () => flag(d(), "enabled", "enabled"),
      isWindowOpen: () => flag(d(), "windowOpen", "windowOpen"),
      isExpanded: () => flag(d(), "expanded", "expanded"),
      isRemoteControlsSectionVisible: () => flag(d(), "remoteVisible", "remoteControlsVisible"),
      presetName: () => value(() => (d() ? d().presetName : "")),
      sampleName: () => value(() => (d() ? d().sampleName : "")),
      selectInEditor: () => log.push(["selectInEditor", index]),
      beforeDeviceInsertionPoint: () => insertionPoint(index),
      setDirectParameterValueNormalized: (id, scaled, resolution) => {
        log.push(["direct", id, scaled, resolution]);
        later(() => { if (!ignore.includes(id)) params.values[id] = scaled / (resolution - 1); });
      }
    };
  };
  const insert = (at, device) => later(() => chain.splice(at, 0, { presetName: "init", sampleName: "", enabled: true, windowOpen: false, expanded: true, remoteVisible: false, plugin: false, type: "audio-effect", ...device }), 60);
  function insertionPoint(at) {
    return {
      at,
      browse: () => { browser.open = true; browser.at = at; },
      insertBitwigDevice: id => { log.push(["bitwig", String(id), at]); insert(at, { name: "Stock" }); },
      insertCLAPDevice: id => { log.push(["clap", id, at]); insert(at, { name: "Clap Synth", plugin: true }); },
      insertVST3Device: id => { log.push(["vst3", id, at]); insert(at, { name: "Vst Synth", plugin: true }); },
      insertFile: path => { log.push(["file", path, at]); if (onInsertFile) onInsertFile(at, insert); else insert(at, { name: "Sampler", sampleName: path.split("/").pop() }); }
    };
  }
  context.deviceBank = { itemCount: () => value(() => chain.length), getItemAt: deviceAt };

  // Track and cursor.
  const track = { name: () => value(() => trackName), trackType: () => value(() => trackType) };
  context.cursorTrack = { name: () => value(() => trackName), endOfDeviceChainInsertionPoint: () => insertionPoint(chain.length) };
  context.selectTrack = (request, params, callback) => {
    try { callback(track); } catch (error) { context.finish(request, false, { message: String(error.message || error) }); }
  };
  context.selectDevice = (request, params, callback) => {
    try { callback(context.requireDevice(params)); } catch (error) { context.finish(request, false, { message: String(error.message || error) }); }
  };
  context.java = { util: { UUID: { fromString: s => `uuid:${s}` } } };

  // Browser: results filtered by the selected location.
  const browser = { open: false, location: null, scroll: 0 };
  const visible = () => results.filter(r => !browser.location || browser.location === "All Locations" || r.location === browser.location);
  const filterBank = (entries, onSelect) => {
    const bank = { scroll: 0 };
    return Object.assign(bank, {
      getSizeOfBank: () => 64,
      itemCount: () => value(() => entries.length),
      scrollPosition: () => value(() => bank.scroll, next => { bank.scroll = next; }),
      getItemAt: i => ({
        exists: () => value(() => bank.scroll + i < entries.length),
        name: () => value(() => entries[bank.scroll + i]),
        isSelected: () => value(() => false, () => onSelect(entries[bank.scroll + i]))
      })
    });
  };
  context.locationBank = filterBank(locations, name => { browser.location = name; });
  context.deviceTypeBank = filterBank(["All Device Types", "Instrument"], () => {});
  context.categoryBank = filterBank(["All Categories", "Bass"], () => {});
  context.resultColumn = { entryCount: () => value(() => visible().length) };
  context.resultBank = {
    scrollPosition: () => value(() => browser.scroll, next => { browser.scroll = next; }),
    getItemAt: i => ({
      exists: () => value(() => browser.scroll + i < visible().length),
      name: () => value(() => visible()[browser.scroll + i].name),
      isSelected: () => value(() => false, () => { browser.selected = visible()[browser.scroll + i]; })
    })
  };
  const wildcard = { getWildcardItem: () => ({ isSelected: () => value(() => true, () => { browser.location = null; }) }) };
  context.popupBrowser = {
    exists: () => value(() => browser.open),
    cancel: () => { browser.open = false; log.push(["cancel"]); },
    commit: () => {
      browser.open = false;
      log.push(["commit", browser.selected.name]);
      if (onCommit) onCommit(browser.at, browser.selected, insert);
      else insert(browser.at, browser.selected.device || { name: browser.selected.name });
    },
    smartCollectionColumn: () => wildcard, locationColumn: () => wildcard, deviceColumn: () => wildcard, deviceTypeColumn: () => wildcard,
    categoryColumn: () => wildcard, tagColumn: () => wildcard, fileTypeColumn: () => wildcard, creatorColumn: () => wildcard
  };

  // Remote-controls page of the cursor device, and its direct parameters.
  const pageNames = Object.keys(pages);
  const remote = { page: 0, values: {} };
  context.cursorRemoteControlsPage = {
    pageNames: () => value(() => pageNames),
    selectedPageIndex: () => value(() => remote.page, next => { log.push(["page", next]); later(() => { remote.page = next; }); }),
    getParameter: i => {
      const key = () => `${remote.page}:${i}`;
      const names = () => pages[pageNames[remote.page]] || [];
      return {
        exists: () => value(() => i < names().length),
        name: () => value(() => names()[i]),
        get: () => (remote.values[key()] === undefined ? 0.5 : remote.values[key()]),
        setImmediately: v => { const k = key(); log.push(["remote", k, v]); if (!ignore.includes(k)) remote.values[k] = v; },
        displayedValue: () => value(() => `v${remote.values[key()] === undefined ? 0.5 : remote.values[key()]}`)
      };
    }
  };
  const params = { values: { "P/CUT": 0.25, "P/RES": 0.5 } };
  context.directIds = ["P/CUT", "P/RES"];
  context.directNames = { "P/CUT": "Cutoff", "P/RES": "Resonance" };
  context.directDisplays = {};
  Object.defineProperty(context, "directValues", { get: () => params.values, set() {}, configurable: true });

  function run(method, request, ms = 20000) {
    context.enqueue(5000, "1", method, { trackIndex: 0, trackName, ...request }, 60000);
    loaded.advance(ms);
    return loaded.responses[0];
  }
  return { ...loaded, chain, log, browser, remote, params, run };
}

const plain = value => JSON.parse(JSON.stringify(value));
const names = chain => chain.map(d => d.name);

// ---------------------------------------------------------- browser search

test("browser_search lists matching entries after the location filter", () => {
  const { run, browser } = setup({ results: [{ name: "EQ+", location: "Devices" }, { name: "EQ-5", location: "Devices" }, { name: "Warm EQ", location: "Presets" }] });
  const response = run("browser_search", { query: "eq", location: "Devices" });
  assert.equal(response.ok, true, JSON.stringify(response.payload));
  assert.deepEqual(plain(response.payload.results), ["EQ+", "EQ-5"]);
  assert.equal(response.payload.entriesAfterFilters, 2);
  assert.equal(browser.open, false, "the browser is closed again");
});

test("browser_search names the available locations when one is missing", () => {
  const { run, browser } = setup({ locations: ["All Locations", "Devices"] });
  const response = run("browser_search", { query: "x", location: "Polymer" });
  assert.equal(response.ok, false);
  assert.match(response.payload.message, /no location named ‘Polymer’ here\. Available: All Locations, Devices\./);
  assert.equal(browser.open, false, "the browser is closed after a failure");
});

test("browser_search pages through a long location column", () => {
  const locations = ["All Locations", ...Array.from({ length: 100 }, (_, i) => `Folder ${i}`)];
  const { run } = setup({ locations, results: [{ name: "Deep Preset", location: "Folder 90" }] });
  const response = run("browser_search", { location: "Folder 90" });
  assert.equal(response.ok, true, JSON.stringify(response.payload));
  assert.deepEqual(plain(response.payload.results), ["Deep Preset"]);
});

// ---------------------------------------------------------- device insert

test("insert_device by name adds the device at the end and confirms it", () => {
  const { run, chain, log } = setup({ results: [{ name: "Compressor", location: "Devices" }] });
  const response = run("insert_device", { name: "Compressor", location: "Devices" });
  assert.equal(response.ok, true, JSON.stringify(response.payload));
  assert.deepEqual(names(chain), ["EQ+", "Compressor"]);
  assert.equal(response.payload.inserted.index, 1);
  assert.ok(log.some(entry => entry[0] === "commit"));
});

test("insert_device places a device right before another one", () => {
  const { run, chain } = setup({ devices: ["EQ+", "Delay+"], results: [{ name: "Compressor", location: "Devices" }] });
  const response = run("insert_device", { name: "Compressor", beforeDeviceIndex: 1, beforeDeviceName: "Delay+" });
  assert.equal(response.ok, true, JSON.stringify(response.payload));
  assert.deepEqual(names(chain), ["EQ+", "Compressor", "Delay+"]);
  assert.match(response.payload.insertionPoint, /before device 1 ‘Delay\+’/);
});

test("insert_device accepts a preset entry by the preset its device loads", () => {
  const preset = { name: "Additive Pad", location: "Presets", device: { name: "Polymer", presetName: "Additive Pad", type: "instrument" } };
  const { run, chain } = setup({ devices: [], results: [preset] });
  const response = run("insert_device", { name: "Additive Pad", location: "Presets" });
  assert.equal(response.ok, true, JSON.stringify(response.payload));
  assert.deepEqual([chain[0].name, chain[0].presetName], ["Polymer", "Additive Pad"]);
});

test("insert_device refuses a name with several browser entries", () => {
  const { run, chain, log } = setup({ results: [{ name: "Delay", location: "Devices" }, { name: "Delay", location: "Presets" }] });
  const response = run("insert_device", { name: "Delay" });
  assert.equal(response.ok, false);
  assert.match(response.payload.message, /matches 2 browser entries, so nothing was inserted/);
  assert.deepEqual(names(chain), ["EQ+"]);
  assert.ok(!log.some(entry => entry[0] === "commit"));
});

test("insert_device fails when Bitwig inserts something else, and says it is still there", () => {
  const { run } = setup({ results: [{ name: "Compressor", location: "Devices" }], onCommit: (at, selected, insert) => insert(at, { name: "Gate" }) });
  const response = run("insert_device", { name: "Compressor" });
  assert.equal(response.ok, false);
  assert.match(response.payload.message, /Bitwig inserted ‘Gate’ \(preset ‘init’\) at position 1, which is neither a device nor a preset named ‘Compressor’\. It is still in the chain\./);
});

test("insert_device fails when the chain does not change", () => {
  const { run } = setup({ results: [{ name: "Compressor", location: "Devices" }], onCommit: () => {} });
  const response = run("insert_device", { name: "Compressor" });
  assert.equal(response.ok, false);
  assert.match(response.payload.message, /Bitwig did not insert anything; the device chain is unchanged/);
});

test("insert_device inserts by stable ID without the browser", () => {
  const { run, log, browser } = setup();
  const response = run("insert_device", { clapId: "com.example.synth", beforeDeviceIndex: 0, beforeDeviceName: "EQ+" });
  assert.equal(response.ok, true, JSON.stringify(response.payload));
  assert.deepEqual(plain(log.find(entry => entry[0] === "clap")), ["clap", "com.example.synth", 0]);
  assert.equal(browser.open, false);
  const stock = setup().run("insert_device", { bitwigId: "6d621c1c-ab64-43b4-aea3-dad37e6f649c" });
  assert.equal(stock.ok, true, JSON.stringify(stock.payload));
});

const insertRefusals = [
  ["two sources", { name: "EQ+", clapId: "x" }, /exactly one of name, bitwigId, clapId or vst3Id/],
  ["filters with an ID", { vst3Id: "ABC", location: "Devices" }, /filters only apply when inserting by name/],
  ["a stale before-device name", { name: "EQ+", beforeDeviceIndex: 0, beforeDeviceName: "Delay+" }, /device 0 is now ‘EQ\+’, not ‘Delay\+’/],
  ["half a before-device", { name: "EQ+", beforeDeviceIndex: 0 }, /beforeDeviceIndex and beforeDeviceName go together/]
];
for (const [name, request, message] of insertRefusals) {
  test(`insert_device refuses ${name}`, () => {
    const { run, chain } = setup();
    const response = run("insert_device", request);
    assert.equal(response.ok, false);
    assert.match(response.payload.message, message);
    assert.deepEqual(names(chain), ["EQ+"]);
  });
}

test("insert_sample loads a file into a sampler on an instrument track", () => {
  const { run, chain } = setup({ devices: [], trackType: "Instrument" });
  const response = run("insert_sample", { path: "/Samples/kick.wav" });
  assert.equal(response.ok, true, JSON.stringify(response.payload));
  assert.equal(chain[0].sampleName, "kick.wav");
});

test("insert_sample refuses an audio track, where Bitwig would load a Convolution", () => {
  const { run, log } = setup({ trackType: "Audio" });
  const response = run("insert_sample", { path: "/Samples/kick.wav" });
  assert.match(response.payload.message, /only on instrument or hybrid tracks; ‘Bus’ has track type Audio/);
  assert.ok(!log.some(entry => entry[0] === "file"));
});

test("insert_sample fails when the new device reports no sample", () => {
  const { run } = setup({ devices: [], trackType: "Instrument", onInsertFile: (at, insert) => insert(at, { name: "Sampler" }) });
  const response = run("insert_sample", { path: "/Samples/kick.wav" });
  assert.match(response.payload.message, /Bitwig inserted ‘Sampler’ but reports no loaded sample/);
});

// ---------------------------------------------------------- device state

test("set_device changes the device state and selects a page", () => {
  const { run, chain, remote } = setup();
  const response = run("set_device", { deviceIndex: 0, deviceName: "EQ+", enabled: false, remoteControlsVisible: true, remoteControlsPage: "freqs" });
  assert.equal(response.ok, true, JSON.stringify(response.payload));
  assert.deepEqual([chain[0].enabled, chain[0].remoteVisible, remote.page], [false, true, 1]);
});

test("set_device fails with what Bitwig holds", () => {
  const response = setup({ ignore: ["enabled"] }).run("set_device", { deviceIndex: 0, deviceName: "EQ+", enabled: false });
  assert.equal(response.ok, false);
  assert.match(response.payload.message, /enabled is true, requested false/);
});

// ---------------------------------------------------------- parameters

test("device_parameters reads another page and shows the old page again afterwards", () => {
  const { run, remote, advance } = setup();
  const response = run("device_parameters", { deviceIndex: 0, deviceName: "EQ+", remoteControlsPage: "Freqs" });
  assert.equal(response.ok, true, JSON.stringify(response.payload));
  assert.deepEqual(plain(response.payload.remoteControls.controls.map(c => c.name)), ["1 Freq"]);
  assert.equal(response.payload.directParameters.total, 2);
  advance(200);
  assert.equal(remote.page, 0);
});

test("set_device_parameters writes direct and remote-control values and reads them back", () => {
  const { run, params, remote } = setup();
  const response = run("set_device_parameters", {
    deviceIndex: 0, deviceName: "EQ+",
    parameters: [{ parameterId: "P/CUT", value: 0.6 }, { page: "Freqs", control: "1 freq", value: 0.3 }, { pageIndex: 0, controlIndex: 1, value: 0.9 }]
  });
  assert.equal(response.ok, true, JSON.stringify(response.payload));
  assert.ok(Math.abs(params.values["P/CUT"] - Math.round(0.6 * 127) / 127) < 1e-9, "direct values are written in 1/127 steps");
  assert.deepEqual([remote.values["1:0"], remote.values["0:1"]], [0.3, 0.9]);
  assert.deepEqual(plain(response.payload.parameters.map(p => [p.change, p.kind, p.name])), [[0, "direct", "Cutoff"], [1, "remoteControl", "1 Freq"], [2, "remoteControl", "2 Gain"]]);
});

test("set_device_parameters checks every target before writing anything", () => {
  const { run, log } = setup();
  const response = run("set_device_parameters", { deviceIndex: 0, deviceName: "EQ+", parameters: [{ parameterId: "P/CUT", value: 0.6 }, { page: "Gains", control: "Nope", value: 0.1 }] });
  assert.equal(response.ok, false);
  assert.match(response.payload.message, /page 0 has no control ‘Nope’\. Controls: 1 Gain, 2 Gain\. Nothing was changed\./);
  assert.ok(!log.some(entry => entry[0] === "direct" || entry[0] === "remote"));
});

test("set_device_parameters lists the values Bitwig did not take", () => {
  const response = setup({ ignore: ["0:0"] }).run("set_device_parameters", {
    deviceIndex: 0, deviceName: "EQ+", parameters: [{ pageIndex: 0, controlIndex: 0, value: 0.8 }, { parameterId: "P/RES", value: 0.2 }]
  });
  assert.equal(response.ok, false);
  assert.match(response.payload.message, /did not confirm 1 of 2 parameter changes: ‘1 Gain’ on page ‘Gains’ is 0\.5 \(v0\.5\), requested 0\.8/);
  assert.match(response.payload.message, /The others were written and confirmed/);
});

test("set_device_parameters names Bitwig's double scaling instead of compensating it", () => {
  const { run, params, context } = setup();
  const original = context.deviceBank.getItemAt;
  context.deviceBank.getItemAt = index => ({
    ...original(index),
    setDirectParameterValueNormalized: (id, scaled, resolution) => {
      context.host.scheduleTask(() => { params.values[id] = scaled / (resolution - 1) / 16384; }, 30);
    }
  });
  const response = run("set_device_parameters", { deviceIndex: 0, deviceName: "EQ+", parameters: [{ parameterId: "P/CUT", value: 0.6 }] });
  assert.equal(response.ok, false);
  assert.match(response.payload.message, /Bitwig scaled this plug-in parameter twice; set it through a remote control instead/);
});

const parameterRefusals = [
  ["a value outside 0-1", [{ parameterId: "P/CUT", value: 1.5 }], /value must be a normalized number from 0 to 1/],
  ["both addressing kinds", [{ parameterId: "P/CUT", page: "Gains", control: "1 Gain", value: 0.5 }], /pass either parameterId or a remote control/],
  ["an unknown parameter", [{ parameterId: "P/NOPE", value: 0.5 }], /has no parameter ‘P\/NOPE’/],
  ["the same parameter twice", [{ parameterId: "P/CUT", value: 0.5 }, { parameterId: "P/CUT", value: 0.6 }], /Changes 0 and 1 set the same parameter/],
  ["an unknown page", [{ page: "Qs", control: "1 Q", value: 0.5 }], /no remote-controls page ‘Qs’\. Pages: Gains, Freqs/]
];
for (const [name, parameters, message] of parameterRefusals) {
  test(`set_device_parameters refuses ${name}`, () => {
    const { run, log } = setup();
    const response = run("set_device_parameters", { deviceIndex: 0, deviceName: "EQ+", parameters });
    assert.equal(response.ok, false);
    assert.match(response.payload.message, message);
    assert.ok(!log.some(entry => entry[0] === "direct" || entry[0] === "remote"));
  });
}

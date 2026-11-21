import assert from "node:assert/strict";
import test from "node:test";
import { readBridgeToken } from "../src/bitwig-client.mjs";
import { logDirectory, tokenFile, userDataDirectory } from "../src/paths.mjs";

test("user data folder per system", () => {
  assert.equal(
    userDataDirectory({ platform: "darwin", env: {}, home: "/Users/ada" }),
    "/Users/ada/Library/Application Support/agent-bridge-for-bitwig"
  );
  assert.equal(
    userDataDirectory({ platform: "win32", env: { APPDATA: "C:\\Users\\Ada\\AppData\\Roaming" }, home: "C:\\Users\\Ada" }),
    "C:\\Users\\Ada\\AppData\\Roaming\\agent-bridge-for-bitwig"
  );
  assert.equal(
    userDataDirectory({ platform: "win32", env: {}, home: "C:\\Users\\Ada" }),
    "C:\\Users\\Ada\\AppData\\Roaming\\agent-bridge-for-bitwig"
  );
  assert.equal(userDataDirectory({ platform: "linux", env: {}, home: "/home/ada" }), "/home/ada/.config/agent-bridge-for-bitwig");
  assert.equal(
    userDataDirectory({ platform: "linux", env: { XDG_CONFIG_HOME: "/data/config" }, home: "/home/ada" }),
    "/data/config/agent-bridge-for-bitwig"
  );
});

test("secret and log sit in the user data folder", () => {
  const options = { platform: "win32", env: { APPDATA: "C:\\Roaming" }, home: "C:\\Users\\Ada" };
  assert.equal(tokenFile(options), "C:\\Roaming\\agent-bridge-for-bitwig\\bridge-token");
  assert.equal(logDirectory(options), "C:\\Roaming\\agent-bridge-for-bitwig\\logs");
  assert.equal(tokenFile({ platform: "linux", env: {}, home: "/home/ada" }), "/home/ada/.config/agent-bridge-for-bitwig/bridge-token");
});

test("the secret comes from the environment, then the first file that has one", () => {
  const files = { "/new": "", "/old": "legacy-secret\n" };
  const read = file => {
    if (!(file in files)) throw new Error("ENOENT");
    return files[file];
  };
  assert.equal(readBridgeToken({ env: { AGENT_BRIDGE_FOR_BITWIG_TOKEN: "from-env" }, files: ["/new"], read }), "from-env");
  assert.equal(readBridgeToken({ env: {}, files: ["/missing", "/new", "/old"], read }), "legacy-secret");
  files["/new"] = "current-secret\n";
  assert.equal(readBridgeToken({ env: {}, files: ["/new", "/old"], read }), "current-secret");
  assert.throws(() => readBridgeToken({ env: {}, files: ["/missing"], read }), /No Agent Bridge for Bitwig secret found at \/missing/);
});

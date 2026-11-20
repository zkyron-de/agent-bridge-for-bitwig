import assert from "node:assert/strict";
import test from "node:test";
import { bitwigUserFolderCandidates, resolveControllerScripts, windowsDocumentsFolder } from "../scripts/bitwig-folder.mjs";

test("each system looks for Bitwig's user folder in its default place", () => {
  assert.deepEqual(bitwigUserFolderCandidates("darwin", "/Users/ada"), ["/Users/ada/Documents/Bitwig Studio"]);
  assert.deepEqual(bitwigUserFolderCandidates("linux", "/home/ada"), ["/home/ada/Bitwig Studio", "/home/ada/Documents/Bitwig Studio"]);
  assert.deepEqual(
    bitwigUserFolderCandidates("win32", "C:\\Users\\ada", "C:\\Users\\ada\\OneDrive\\Dokumente"),
    ["C:\\Users\\ada\\OneDrive\\Dokumente\\Bitwig Studio", "C:\\Users\\ada\\Documents\\Bitwig Studio"]
  );
  assert.deepEqual(bitwigUserFolderCandidates("win32", "C:\\Users\\ada", "C:\\Users\\ada\\Documents"), ["C:\\Users\\ada\\Documents\\Bitwig Studio"]);
});

test("the first existing user folder gives the Controller Scripts folder", () => {
  const exists = folder => folder === "/home/ada/Documents/Bitwig Studio";
  assert.deepEqual(resolveControllerScripts({ platform: "linux", home: "/home/ada", exists }), { directory: "/home/ada/Documents/Bitwig Studio/Controller Scripts" });
});

test("a missing user folder is reported with every place looked at", () => {
  const result = resolveControllerScripts({ platform: "linux", home: "/home/ada", exists: () => false });
  assert.match(result.error, /\/home\/ada\/Bitwig Studio/);
  assert.match(result.error, /Start Bitwig Studio once/);
  assert.match(result.error, /--controller-dir/);
});

test("--controller-dir wins, and must exist", () => {
  assert.deepEqual(resolveControllerScripts({ platform: "darwin", home: "/Users/ada", explicit: "/Volumes/Music/Controller Scripts", exists: () => true }), { directory: "/Volumes/Music/Controller Scripts" });
  assert.match(resolveControllerScripts({ platform: "darwin", home: "/Users/ada", explicit: "/nope", exists: () => false }).error, /does not exist: \/nope/);
});

test("the Windows Documents folder comes from PowerShell, or is left out", () => {
  assert.equal(windowsDocumentsFolder(() => ({ status: 0, stdout: "D:\\Docs\r\n" })), "D:\\Docs");
  assert.equal(windowsDocumentsFolder(() => ({ status: null, error: new Error("ENOENT") })), "");
});

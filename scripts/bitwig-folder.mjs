// Finds Bitwig's "Controller Scripts" folder on macOS, Windows and Linux.
//
// Bitwig keeps its user files in a folder named "Bitwig Studio". Where it
// lives depends on the system:
//   macOS    ~/Documents/Bitwig Studio
//   Windows  <Documents>\Bitwig Studio, where <Documents> is the real
//            Documents folder (it may be redirected, e.g. into OneDrive)
//   Linux    ~/Bitwig Studio
// Bitwig creates the folder on its first start. Only macOS is tested so far;
// the Windows and Linux locations follow Bitwig's defaults and still need a
// check on a real machine. --controller-dir covers every other case.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

export const CONTROLLER_FOLDER_NAME = "Agent Bridge for Bitwig";
export const CONTROLLER_FILE_NAME = "AgentBridgeForBitwig.control.js";

// Asks Windows for the real Documents folder, which may differ from
// %USERPROFILE%\Documents. Returns "" if that does not work.
export function windowsDocumentsFolder(run = spawnSync) {
  const result = run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "[Environment]::GetFolderPath('MyDocuments')"], { encoding: "utf8" });
  return result.status === 0 ? String(result.stdout || "").trim() : "";
}

// The "Bitwig Studio" folders worth looking at, most likely first.
export function bitwigUserFolderCandidates(platform, home, documents = "") {
  const join = platform === "win32" ? path.win32.join : path.posix.join;
  const candidates = [];
  if (platform === "darwin") candidates.push(join(home, "Documents", "Bitwig Studio"));
  else if (platform === "win32") {
    if (documents) candidates.push(join(documents, "Bitwig Studio"));
    candidates.push(join(home, "Documents", "Bitwig Studio"));
  } else {
    candidates.push(join(home, "Bitwig Studio"), join(home, "Documents", "Bitwig Studio"));
  }
  return [...new Set(candidates)];
}

// Picks the "Controller Scripts" folder setup installs into. An explicit
// folder wins; otherwise the first existing "Bitwig Studio" folder is used.
// Returns { directory } or { error } with a message for the user.
export function resolveControllerScripts({ platform, home, documents = "", explicit = "", exists = existsSync }) {
  if (explicit) {
    return exists(explicit)
      ? { directory: explicit }
      : { error: `The folder given with --controller-dir does not exist: ${explicit}` };
  }
  const candidates = bitwigUserFolderCandidates(platform, home, documents);
  const found = candidates.find(candidate => exists(candidate));
  if (found) {
    const join = platform === "win32" ? path.win32.join : path.posix.join;
    return { directory: join(found, "Controller Scripts") };
  }
  return {
    error: [
      "Could not find Bitwig's user folder. Looked in:",
      ...candidates.map(candidate => `      ${candidate}`),
      "    Start Bitwig Studio once so it creates the folder, then run setup again.",
      "    If Bitwig keeps its files somewhere else, run setup again with",
      "    --controller-dir \"<path>\" and the folder that holds Bitwig's controller scripts."
    ].join("\n")
  };
}

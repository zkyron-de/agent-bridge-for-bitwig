// Where Agent Bridge for Bitwig keeps its own files: the per-install secret
// and the request log. They live in the user's data folder, not next to the
// code, so they survive updates and installs through npx.
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const FOLDER_NAME = "agent-bridge-for-bitwig";

// Before 2.2.0 the secret lived in the checkout. Still read, and moved by setup.
export const LEGACY_TOKEN_FILE = fileURLToPath(new URL("../data/bridge-token", import.meta.url));

function joinFor(platform) {
  return platform === "win32" ? path.win32.join : path.posix.join;
}

export function userDataDirectory({ platform = process.platform, env = process.env, home = homedir() } = {}) {
  const join = joinFor(platform);
  if (platform === "win32") return join(env.APPDATA || join(home, "AppData", "Roaming"), FOLDER_NAME);
  if (platform === "darwin") return join(home, "Library", "Application Support", FOLDER_NAME);
  return join(env.XDG_CONFIG_HOME || join(home, ".config"), FOLDER_NAME);
}

export function tokenFile(options = {}) {
  return joinFor(options.platform ?? process.platform)(userDataDirectory(options), "bridge-token");
}

export function logDirectory(options = {}) {
  return joinFor(options.platform ?? process.platform)(userDataDirectory(options), "logs");
}

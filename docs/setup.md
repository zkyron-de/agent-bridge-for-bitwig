# Setup

The [README](../README.md#quick-start) has the short version for Claude Code. This page covers every step in detail, other agents, and uninstalling.

## Requirements

| Requirement | Minimum |
|---|---|
| System | macOS 13 Ventura or newer (Apple silicon and Intel), Windows or Linux |
| Bitwig Studio | 6.x with Controller API 25 (tested with 6.1.7) |
| Node.js | 20 or newer |

**Tested on** macOS, Windows 11 and Linux with Bitwig 6.1.7 (on Linux as Flatpak on Kubuntu). Loading a sample by a Windows path (`C:\…`) has not been tried in Bitwig yet. If your setup differs, run the [smoke test](#check-the-connection) and [open an issue](https://github.com/zkyron-de/agent-bridge-for-bitwig/issues/new/choose) with its output, whether it passes or not.

## Install

Start Bitwig once first (see below), then run:

```sh
npx agent-bridge-for-bitwig@2.2.0 setup
```

It creates a per-install secret in your [user data folder](#files-and-locations) and installs the controller script, with the secret stamped in, into Bitwig's controller-script folder. At the end it prints the exact commands for the next steps. It is safe to re-run at any time. It also removes a copy installed under the project's old name, Bitwig Agent Bridge.

**From a checkout** instead, for development or to run unreleased changes: clone the repository and run `npm run setup` in it. It also installs the dependencies, and moves a secret from an older checkout (`data/bridge-token`) to the user data folder, so an installed controller keeps working. Wherever this page says `npx agent-bridge-for-bitwig@2.2.0 <command>`, a checkout uses `npm run <command>`, with `--` before any flags (`npm run setup -- --controller-dir "<path>"`).

Setup looks for Bitwig's user folder, which Bitwig creates on its first start, so start Bitwig once before running setup:

| System | Bitwig's user folder |
|---|---|
| macOS | `~/Documents/Bitwig Studio` |
| Windows | `Bitwig Studio` in your Documents folder, also when Documents is redirected, for example into OneDrive |
| Linux | `~/Bitwig Studio` (also for the Flatpak), then `~/Documents/Bitwig Studio` |

The script goes into `Controller Scripts/Agent Bridge for Bitwig/` inside it.

Flags:

- `--controller-dir "<path>"` installs into this controller-script folder instead, for example if you moved Bitwig's "My Controller Scripts" location. The folder must exist.
- `--skip-install` skips `npm install` (checkout only).
- `--skip-controller` does not install the controller script.

## Set up Bitwig

Setup installs the controller script into Bitwig's controller-script folder (on macOS `~/Documents/Bitwig Studio/Controller Scripts/Agent Bridge for Bitwig/`). Add it once:

1. In Bitwig, open the Dashboard (the Bitwig logo, top center) → **Settings** → **Controllers**.
2. Click **+ Add Controller**.
3. Choose vendor **Agent Bridge for Bitwig**, then the controller of the same name, and click **Add**.
4. The entry's power button should be on. You'll see the **"Agent Bridge for Bitwig online"** popup, and the script console (the `>` icon on the controller entry) logs `Agent Bridge for Bitwig <version> listening on UDP 50701`.

**Reloading.** After re-running setup (which re-stamps the secret into the controller script), Bitwig usually reloads the script by itself. If it does not, toggle the controller's power button off and on in Settings → Controllers, or restart Bitwig.

**If the controller isn't listed at all**, Bitwig is probably looking in a non-default location: Settings → **Locations** → "My Controller Scripts" should point at the `Controller Scripts` folder setup printed. If you've customized it, run setup again with `--controller-dir "<that folder>"`. Don't copy the controller file there by hand: it has no secret stamped in.

## Check the connection

With Bitwig open and the controller added, run:

```sh
npx agent-bridge-for-bitwig@2.2.0 smoke
```

It starts the MCP server like an agent would, calls a few read-only tools and prints one line per step. With `--write` it also creates a track named "Smoke test", writes a short clip, reads it back and deletes the track again; use an empty project for it.

## Connect your agent

- **Command:** `npx -y agent-bridge-for-bitwig@2.2.0` (from a checkout: `node <checkout>/src/index.mjs`)
- **Transport:** stdio — no URL, no port, no network setup
- Bitwig must be open for tools to work; the agent config is one-time.

Use the version setup installed: setup prints it. Server and controller script then always come from the same release. From a checkout, replace `npx -y agent-bridge-for-bitwig@2.2.0` below with `node /path/to/agent-bridge-for-bitwig/src/index.mjs` (in JSON: `"command": "node"`, `"args": ["/path/to/agent-bridge-for-bitwig/src/index.mjs"]`).

**Windows:** `npx` is a batch script there, which agents can only start through `cmd`. Put `cmd /c` in front of the command (`cmd /c npx -y agent-bridge-for-bitwig@2.2.0`), and in JSON use `"command": "cmd"` with `"args": ["/c", "npx", "-y", "agent-bridge-for-bitwig@2.2.0"]`.

### Agent configuration

The server name `bitwig` is up to you.

**Claude Code** — adds it for every project:

```sh
claude mcp add --scope user bitwig -- npx -y agent-bridge-for-bitwig@2.2.0
```

**OpenAI Codex** — the CLI, IDE extension and desktop app share this setting:

```sh
codex mcp add bitwig -- npx -y agent-bridge-for-bitwig@2.2.0
```

Or add it to `~/.codex/config.toml`:

```toml
[mcp_servers.bitwig]
command = "npx"
args = ["-y", "agent-bridge-for-bitwig@2.2.0"]
```

**Grok CLI** — saves it to `~/.grok/config.toml`:

```sh
grok mcp add bitwig -- npx -y agent-bridge-for-bitwig@2.2.0
```

**GitHub Copilot in VS Code** — run **MCP: Add Server** from the Command Palette, choose **Command (stdio)**, enter `npx -y agent-bridge-for-bitwig@2.2.0`, name it `bitwig`, then pick **Global** → **Copilot Global**. That writes `~/.copilot/mcp-config.json`, which you can also edit directly:

```json
{
  "mcpServers": {
    "bitwig": {
      "command": "npx",
      "args": ["-y", "agent-bridge-for-bitwig@2.2.0"]
    }
  }
}
```

**Claude Desktop, Cursor, Windsurf and Cline** use the standard `mcpServers` block:

```json
{
  "mcpServers": {
    "bitwig": {
      "command": "npx",
      "args": ["-y", "agent-bridge-for-bitwig@2.2.0"]
    }
  }
}
```

Merge it into the file each one reads, then restart it or refresh its MCP list:

- **Claude Desktop:** Settings → Developer → Edit Config opens `~/Library/Application Support/Claude/claude_desktop_config.json`.
- **Cursor:** `~/.cursor/mcp.json`, or `.cursor/mcp.json` in a project.
- **Windsurf:** in the Cascade panel, open the `...` menu and choose **Open MCP config file** to edit `mcp_config.json`.
- **Cline:** click the MCP Servers icon in the Cline panel, open **Configure**, then **Configure MCP Servers**. The Cline CLI can add it in one line: `cline mcp add bitwig --yes -- npx -y agent-bridge-for-bitwig@2.2.0`.

With Claude Code, check the connection with `claude mcp list` (or `/mcp` inside a session), then ask something like "Call bitwig_status and list the tracks". The tools appear as `mcp__bitwig__bitwig_status` and so on; allow them once, or add `mcp__bitwig` to the allowed tools with `/permissions`.

## Update

Run setup with the new version, for example `npx agent-bridge-for-bitwig@latest setup`. It keeps the secret and installs the new controller script; reload it in Bitwig if it doesn't reload by itself. Then point your agent at the version setup printed, for Claude Code:

```sh
claude mcp remove bitwig
claude mcp add --scope user bitwig -- npx -y agent-bridge-for-bitwig@<new version>
```

From a checkout: pull, then run `npm run setup` again.

## Files and locations

| What | Where |
|---|---|
| User data folder | macOS `~/Library/Application Support/agent-bridge-for-bitwig/`, Windows `%APPDATA%\agent-bridge-for-bitwig\`, Linux `~/.config/agent-bridge-for-bitwig/` (or under `$XDG_CONFIG_HOME`) |
| Per-install secret | `bridge-token` in the user data folder, readable only by you |
| MCP request log | `logs/agent-bridge-for-bitwig.jsonl` in the user data folder |
| Controller script (installed copy) | `Controller Scripts/Agent Bridge for Bitwig/` in Bitwig's user folder (see [Install](#install)) |

Port: `50701/udp`. Bitwig opens it on all network interfaces; the Controller API cannot limit it to loopback. Requests without the secret are dropped unanswered, and replies go only to `127.0.0.1`. To keep the port off the network, block incoming UDP `50701` in your firewall ([Security policy](../SECURITY.md)).

## Uninstall

```sh
rm -rf ~/Documents/"Bitwig Studio"/"Controller Scripts"/"Agent Bridge for Bitwig"
```

That is the macOS path; on Windows and Linux delete the same folder in Bitwig's user folder. Then remove the controller in Bitwig's Settings → Controllers, delete the user data folder (see above) and, if you used one, the checkout, and remove the server from your agent (for Claude Code: `claude mcp remove bitwig`). npx keeps a cached copy of the package, which `npm cache clean --force` removes. Agent Bridge for Bitwig writes nowhere else.

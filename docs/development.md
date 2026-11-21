# Development

## How it works

- A Bitwig controller extension (`controller/AgentBridgeForBitwig.control.js`, Controller API 25) runs inside Bitwig and listens on UDP port `50701` for authenticated requests, which the MCP server sends to `127.0.0.1`. It is the only part that touches your project.
- The MCP server (`src/index.mjs`, tools in `src/tools.mjs`) is started by your agent over stdio and relays tool calls to the extension.
- Every request carries the per-install secret. Requests with the wrong secret get no answer.

```
agent ──stdio──▶ MCP server (src/index.mjs, src/tools.mjs)
                     │  UDP 127.0.0.1:50701, per-install secret
                     ▼
                 controller script inside Bitwig (controller/AgentBridgeForBitwig.control.js)
```

## Security model

- The MCP server binds its reply socket to `127.0.0.1` and sends only there; the controller replies only to `127.0.0.1`. Nothing connects to any network.
- The controller's port is opened by Bitwig, and the Controller API cannot choose the address (`addDatagramPacketObserver` takes only a port): Bitwig opens UDP `50701` on all network interfaces, as `lsof -nP -iUDP:50701` shows. A request from another machine needs the secret, which never leaves yours; without it the controller drops the request unanswered. To keep the port off the network entirely, block incoming UDP `50701` (or incoming connections to Bitwig) in your firewall.
- Every bridge request carries a per-install secret generated on your machine and never committed anywhere. The controller refuses to run without one.
- Mutations require exact targets (track ids; index plus current name for devices, scenes and clips) and are refused on mismatch or ambiguity, so a confused agent fails loudly instead of editing the wrong thing.
- The MCP server logs requests locally to `logs/agent-bridge-for-bitwig.jsonl` so you can audit what an agent did.

## Checks

```sh
npm run check          # syntax-check all sources
npm test               # unit tests, no Bitwig needed; includes the tool registry check
npm run check:api      # check every API method the controller calls against Bitwig's bundled reference
npm run docs           # regenerate the Inputs tables in docs/tools.md after changing a schema
```

The registry test fails when there are more than 25 tools, a schema accepts unknown fields, a tool and the controller disagree about a method, [tools.md](tools.md) or the README's tool overview disagree with the registered tools, or the Inputs tables are out of date.

Controller API calls are checked against the reference bundled with Bitwig Studio (`/Applications/Bitwig Studio.app/Contents/Resources/Documentation/control-surface/api`); set `BITWIG_API_DOCS` if yours is elsewhere.

## Environment variables

| Variable | Used by | Effect |
|---|---|---|
| `AGENT_BRIDGE_FOR_BITWIG_TOKEN` | MCP server | Use this secret instead of the `bridge-token` file in the user data folder. It must match the one stamped into the controller. |
| `AGENT_BRIDGE_FOR_BITWIG_HOST`, `AGENT_BRIDGE_FOR_BITWIG_PORT` | MCP server | Where the server sends requests (default `127.0.0.1`, `50701`). The controller always listens on port `50701` and replies to `127.0.0.1`, so these are only useful for tests. |
| `BITWIG_API_DOCS` | `npm run check:api` | Location of Bitwig's Controller API reference |
| `BITWIG_CONTROLLER` | `npm run check:api` | Check another controller file |

## Project layout

| Path | What |
|---|---|
| `controller/AgentBridgeForBitwig.control.js` | The controller script that runs inside Bitwig |
| `src/index.mjs` | MCP server over stdio, request log |
| `src/tools.mjs` | Tool names, descriptions and strict input schemas |
| `src/bitwig-client.mjs` | UDP client that talks to the controller |
| `src/paths.mjs` | The user data folder: secret and request log |
| `bin/agent-bridge-for-bitwig.mjs` | The npm package's command: server, `setup`, `smoke` |
| `server.json` | Entry for the official MCP Registry |
| `scripts/setup.mjs` | Install: dependencies, secret, controller script |
| `scripts/bitwig-folder.mjs` | Finds Bitwig's controller-script folder on macOS, Windows and Linux |
| `scripts/smoke.mjs` | End-to-end check against a running Bitwig (`npm run smoke`) |
| `scripts/check-api.mjs` | API name check against Bitwig's reference |
| `scripts/tool-docs.mjs` | Generates the Inputs tables in `docs/tools.md` from the schemas |
| `test/` | Unit tests with fake Bitwig objects, the registry test, and a package test that checks every file names the same version |
| `docs/` | Setup, tool reference, limitations, troubleshooting, this page |

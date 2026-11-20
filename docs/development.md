# Development

## How it works

- A Bitwig controller extension (`controller/BitwigAgentBridge.control.js`, Controller API 25) runs inside Bitwig and listens on `127.0.0.1` UDP port `50701` for authenticated requests. It is the only part that touches your project.
- The MCP server (`src/index.mjs`, tools in `src/tools.mjs`) is started by your agent over stdio and relays tool calls to the extension.
- Every request carries the per-install secret. Requests with the wrong secret get no answer.

```
agent ──stdio──▶ MCP server (src/index.mjs, src/tools.mjs)
                     │  UDP 127.0.0.1:50701, per-install secret
                     ▼
                 controller script inside Bitwig (controller/BitwigAgentBridge.control.js)
```

## Security model

- Everything binds to `127.0.0.1`. Nothing listens on, or connects to, any network.
- Every bridge request carries a per-install secret generated on your machine and never committed anywhere. The controller refuses to run without one.
- Mutations require exact targets (track ids; index plus current name for devices, scenes and clips) and are refused on mismatch or ambiguity, so a confused agent fails loudly instead of editing the wrong thing.
- The MCP server logs requests locally to `logs/bitwig-agent-bridge.jsonl` so you can audit what an agent did.

## Checks

```sh
npm run check          # syntax-check all sources
npm test               # unit tests, no Bitwig needed; includes the tool registry check
npm run check:api      # check every API method the controller calls against Bitwig's bundled reference
```

The registry test fails when there are more than 25 tools, a schema accepts unknown fields, a tool and the controller disagree about a method, or [tools.md](tools.md) and the README's tool overview disagree with the registered tools.

Controller API calls are checked against the reference bundled with Bitwig Studio (`/Applications/Bitwig Studio.app/Contents/Resources/Documentation/control-surface/api`); set `BITWIG_API_DOCS` if yours is elsewhere.

## Project layout

| Path | What |
|---|---|
| `controller/BitwigAgentBridge.control.js` | The controller script that runs inside Bitwig |
| `src/index.mjs` | MCP server over stdio, request log |
| `src/tools.mjs` | Tool names, descriptions and strict input schemas |
| `src/bitwig-client.mjs` | UDP client that talks to the controller |
| `scripts/setup.mjs` | Install: dependencies, secret, controller script |
| `scripts/check-api.mjs` | API name check against Bitwig's reference |
| `test/` | Unit tests with fake Bitwig objects, and the registry test |
| `docs/` | Setup, tool reference, limitations, troubleshooting, this page |

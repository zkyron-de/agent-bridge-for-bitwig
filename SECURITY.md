# Security policy

## Supported versions

Only the latest release gets fixes. Agent Bridge for Bitwig is a hobby project, maintained on a best-effort basis.

## Reporting a vulnerability

Please don't open a public issue for a security problem. Report it privately instead: on the repository's **Security** tab, click **Report a vulnerability**. Describe what an attacker could do, the steps to reproduce it, and your system, Bitwig and Node.js versions.

You'll get an answer as soon as I can manage, and credit in the changelog if you like.

## What the bridge protects

- **Local traffic.** The MCP server talks to the controller script over loopback (`127.0.0.1`), and the controller replies only there. Nothing connects to any network.
- **Per-install secret.** Every request carries a secret that setup generates on your machine (`bridge-token` in your user data folder, readable only by you; see [Files and locations](docs/setup.md#files-and-locations)). The controller ignores requests with a wrong or missing secret and does not even reply to them. Without a secret stamped in, it refuses to start.
- **Exact targets.** Changes need exact targets and are refused on a mismatch, so a confused agent fails instead of editing the wrong thing.

The bridge does not protect against software that already runs as your user: it can read the secret like any of your files. Bitwig opens the controller's UDP port `50701` on all network interfaces, because the Controller API cannot limit it to loopback. Other machines on your network can send packets to it; without the secret they are dropped unanswered, but a flood of them could slow the bridge down. Block incoming UDP `50701` in your firewall if your network isn't trusted. And whatever you allow your agent to do in Bitwig, the bridge carries out. Review what the agent proposes before you approve it.

More detail: [Security model](docs/development.md#security-model).

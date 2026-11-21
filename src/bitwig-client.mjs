import { randomUUID } from "node:crypto";
import dgram from "node:dgram";
import { readFileSync } from "node:fs";
import { LEGACY_TOKEN_FILE, tokenFile } from "./paths.mjs";

export const BRIDGE_HOST = process.env.AGENT_BRIDGE_FOR_BITWIG_HOST || "127.0.0.1";
export const BRIDGE_PORT = Number(process.env.AGENT_BRIDGE_FOR_BITWIG_PORT || 50701);
export const BRIDGE_PROTOCOL = "agent-bridge-for-bitwig/1";
// macOS caps a UDP datagram at the socket's send buffer, which defaults to
// 9216 bytes (net.inet.udp.maxdgram). Raising it lets large note clips through.
export const SEND_BUFFER_BYTES = 65536;
// Largest request packet the client will try to send to Bitwig.
export const MAX_PACKET_BYTES = 60000;

// The per-install secret shared with the Bitwig controller script. Created by
// setup in the user's data folder; checkouts from before 2.2.0 kept it in
// data/bridge-token, which is still read.
export function readBridgeToken({
  env = process.env,
  files = [tokenFile(), LEGACY_TOKEN_FILE],
  read = file => readFileSync(file, "utf8")
} = {}) {
  if (env.AGENT_BRIDGE_FOR_BITWIG_TOKEN) return env.AGENT_BRIDGE_FOR_BITWIG_TOKEN;
  for (const file of files) {
    try {
      const token = read(file).trim();
      if (token) return token;
    } catch {
      // Try the next location.
    }
  }
  throw new Error(
    `No Agent Bridge for Bitwig secret found at ${files[0]}. Run setup once (\`npx agent-bridge-for-bitwig setup\`, or \`npm run setup\` in a checkout) to create it and install the controller script, or set AGENT_BRIDGE_FOR_BITWIG_TOKEN.`
  );
}

export class BitwigClient {
  constructor({ host = BRIDGE_HOST, port = BRIDGE_PORT, token, timeoutMs = 5000 } = {}) {
    if (token === undefined) token = readBridgeToken();
    this.host = host;
    this.port = port;
    this.token = token;
    this.timeoutMs = timeoutMs;
    this.pending = new Map();
    this.readyPromise = new Promise((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });

    this.udp = dgram.createSocket({ type: "udp4", sendBufferSize: SEND_BUFFER_BYTES });
    this.udp.on("listening", () => this.resolveReady());
    this.udp.on("error", error => {
      if (this.rejectReady) this.rejectReady(error);
      for (const { reject, timer } of this.pending.values()) {
        clearTimeout(timer);
        reject(error);
      }
      this.pending.clear();
    });
    this.udp.on("message", packet => {
      try {
        this.onMessage(JSON.parse(packet.toString("utf8")));
      } catch {
        // Ignore unrelated or malformed local UDP packets.
      }
    });
    this.udp.bind(0, "127.0.0.1");
  }

  onMessage(message) {
    if (message?.protocol !== BRIDGE_PROTOCOL || !message.id) return;
    const { id, ok, payload } = message;
    const pending = this.pending.get(String(id));
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(String(id));
    if (ok === true) pending.resolve(payload);
    else pending.reject(new Error(payload?.message || "Bitwig rejected the request"));
  }

  async request(method, params = {}, timeoutMs = this.timeoutMs) {
    await this.readyPromise;
    const id = randomUUID();
    const response = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Bitwig did not answer ${method} within ${timeoutMs} ms. Make sure Agent Bridge for Bitwig is enabled in Bitwig. If it is, run setup again so the bridge and this client share the same auth token.`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });

    const packet = Buffer.from(JSON.stringify({
      protocol: BRIDGE_PROTOCOL,
      token: this.token,
      id,
      method,
      params,
      replyPort: this.udp.address().port,
      // Lets the bridge drop requests the client has already given up on and
      // recover if a request stalls inside Bitwig.
      timeoutMs
    }), "utf8");
    if (packet.length > MAX_PACKET_BYTES) {
      this.failPending(id, new Error(`The ${method} request is ${packet.length} bytes, over the ${MAX_PACKET_BYTES}-byte limit for one message to Bitwig. Split it into smaller requests.`));
      return response;
    }
    this.udp.send(packet, this.port, this.host, error => {
      if (error) this.failPending(id, new Error(`Could not send ${method} to Bitwig (${packet.length} bytes): ${error.message}`));
    });
    return response;
  }

  failPending(id, error) {
    const pending = this.pending.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(id);
    pending.reject(error);
  }

  close() {
    this.udp.close();
  }
}

/**
 * Newline-delimited JSON over a Unix domain socket. Connects the short-lived
 * CLI invocations (`fiber-snatcher state`) to the long-running `start` process
 * that owns the browser.
 *
 * Rationale: Playwright's persistent-context launch costs ~1.5s. If every
 * command cold-launches, Claude eats 1.5s per tool call. With the daemon, it's
 * a sub-50ms unix-socket round-trip. Dev loops get meaningfully faster.
 */

import net from "node:net";

export type IpcRequest = { id: string; op: string; [k: string]: unknown };
export type IpcResponse = { id: string; ok: true; data?: unknown } | { id: string; ok: false; error: string; code?: string };

export async function sendRequest(socketPath: string, req: IpcRequest, timeoutMs = 15000): Promise<IpcResponse> {
  return new Promise((resolve, reject) => {
    const client = net.createConnection(socketPath);
    let buf = "";
    const timer = setTimeout(() => {
      client.destroy();
      reject(new Error("ipc timeout"));
    }, timeoutMs);

    client.on("connect", () => {
      client.write(JSON.stringify(req) + "\n");
    });
    client.on("data", (chunk) => {
      buf += chunk.toString();
      const nl = buf.indexOf("\n");
      if (nl >= 0) {
        const line = buf.slice(0, nl);
        clearTimeout(timer);
        client.end();
        try {
          resolve(JSON.parse(line));
        } catch (e) {
          reject(e);
        }
      }
    });
    client.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

export function startServer(socketPath: string, handler: (req: IpcRequest) => Promise<IpcResponse>): net.Server {
  const server = net.createServer((sock) => {
    let buf = "";
    sock.on("data", async (chunk) => {
      buf += chunk.toString();
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        try {
          const req = JSON.parse(line) as IpcRequest;
          const res = await handler(req);
          sock.write(JSON.stringify(res) + "\n");
        } catch (e) {
          sock.write(JSON.stringify({ id: "unknown", ok: false, error: String(e) }) + "\n");
        }
      }
    });
  });
  return server;
}

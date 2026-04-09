import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import type { ApiResponse } from "./types.js";

type RouteHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void> | void;

export interface Routes {
  [method_path: string]: RouteHandler;
}

export function parseBody<T>(req: IncomingMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      try {
        const body = Buffer.concat(chunks).toString();
        resolve(body.length > 0 ? JSON.parse(body) : ({} as T));
      } catch (err) {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

export function sendJson<T>(res: ServerResponse, status: number, data: ApiResponse<T>): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

export function createHttpServer(routes: Routes): Server {
  const server = createServer(async (req, res) => {
    const key = `${req.method} ${req.url}`;

    const handler = routes[key];
    if (!handler) {
      sendJson(res, 404, { ok: false, error: "Not found" });
      return;
    }

    try {
      await handler(req, res);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Internal server error";
      console.error(`[server] Error handling ${key}:`, err);
      sendJson(res, 500, { ok: false, error: message });
    }
  });

  return server;
}

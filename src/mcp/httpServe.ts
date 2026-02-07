import http from "node:http";
import crypto from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

type EventStore = {
  storeEvent: (streamId: string, message: any) => Promise<string>;
  replayEventsAfter: (
    lastEventId: string,
    opts: { send: (eventId: string, message: any) => Promise<void> }
  ) => Promise<string>;
};

// Copy of the SDK example InMemoryEventStore, kept tiny and dependency-free.
class InMemoryEventStore implements EventStore {
  private readonly events = new Map<string, { streamId: string; message: any }>();

  private generateEventId(streamId: string) {
    return `${streamId}_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`;
  }

  private getStreamIdFromEventId(eventId: string) {
    const parts = eventId.split("_");
    return parts.length > 0 ? parts[0] : "";
  }

  async storeEvent(streamId: string, message: any) {
    const eventId = this.generateEventId(streamId);
    this.events.set(eventId, { streamId, message });
    return eventId;
  }

  async replayEventsAfter(lastEventId: string, { send }: { send: (eventId: string, message: any) => Promise<void> }) {
    if (!lastEventId || !this.events.has(lastEventId)) return "";

    const streamId = this.getStreamIdFromEventId(lastEventId);
    if (!streamId) return "";

    let found = false;
    const sorted = [...this.events.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    for (const [eventId, { streamId: sid, message }] of sorted) {
      if (sid !== streamId) continue;
      if (eventId === lastEventId) {
        found = true;
        continue;
      }
      if (found) await send(eventId, message);
    }

    return streamId;
  }
}

function readJsonBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      data += chunk;
    });
    req.on("end", () => {
      if (!data.trim()) return resolve(null);
      try {
        resolve(JSON.parse(data));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

function unauthorized(res: http.ServerResponse, message = "Unauthorized") {
  res.statusCode = 401;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ error: message }));
}

function badRequest(res: http.ServerResponse, message = "Bad Request") {
  res.statusCode = 400;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ error: message }));
}

function methodNotAllowed(res: http.ServerResponse, message = "Method Not Allowed") {
  res.statusCode = 405;
  res.setHeader("content-type", "text/plain");
  res.end(message);
}

function notFound(res: http.ServerResponse) {
  res.statusCode = 404;
  res.setHeader("content-type", "text/plain");
  res.end("Not Found");
}

function getAuthHeader(req: http.IncomingMessage) {
  // Node lowercases header keys.
  const h = req.headers["x-octssh-key"];
  if (typeof h === "string") return h;
  if (Array.isArray(h)) return h[0];
  return undefined;
}

function getBearer(req: http.IncomingMessage) {
  const h = req.headers["authorization"];
  const v = typeof h === "string" ? h : Array.isArray(h) ? h[0] : "";
  const m = /^Bearer\s+(.+)$/i.exec(v);
  return m?.[1];
}

export type ServeConfig = {
  host: string;
  port: number;
  authKey?: string;
};

export async function runStreamableHttpServer(params: {
  server: McpServer;
  config: ServeConfig;
}) {
  const authKey =
    params.config.authKey ?? crypto.randomBytes(24).toString("base64url");

  // Map of active transports per session.
  const transports: Record<string, StreamableHTTPServerTransport> = {};

  const httpServer = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      if (url.pathname !== "/mcp") return notFound(res);

      const provided = getAuthHeader(req) ?? getBearer(req);
      if (!provided || provided !== authKey) {
        return unauthorized(res, "Missing or invalid OctSSH auth key");
      }

      const method = (req.method ?? "GET").toUpperCase();
      const sidHeader = req.headers["mcp-session-id"];
      const sessionId =
        typeof sidHeader === "string" ? sidHeader : Array.isArray(sidHeader) ? sidHeader[0] : undefined;

      if (method === "POST") {
        let body: any;
        try {
          body = await readJsonBody(req);
        } catch {
          return badRequest(res, "Invalid JSON body");
        }

        let transport: StreamableHTTPServerTransport | undefined;

        if (sessionId && transports[sessionId]) {
          transport = transports[sessionId];
        } else if (!sessionId && isInitializeRequest(body)) {
          const eventStore = new InMemoryEventStore();
          transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => crypto.randomUUID(),
            eventStore,
            onsessioninitialized: (sid) => {
              transports[sid] = transport!;
            },
          });
          transport.onclose = () => {
            const sid = transport!.sessionId;
            if (sid && transports[sid]) delete transports[sid];
          };

          await params.server.connect(transport);
          await transport.handleRequest(req, res, body);
          return;
        } else {
          return badRequest(res, "Bad Request: missing session ID or not an initialize request");
        }

        await transport.handleRequest(req, res, body);
        return;
      }

      if (method === "GET" || method === "DELETE") {
        // The StreamableHTTP client transport may probe GET /mcp before initialization.
        // Per spec this is optional; returning 405 tells clients to proceed without it.
        if (method === "GET" && !sessionId) {
          return methodNotAllowed(res, "SSE stream not available before session initialization");
        }

        if (!sessionId || !transports[sessionId]) {
          return badRequest(res, "Invalid or missing session ID");
        }
        await transports[sessionId].handleRequest(req, res);
        return;
      }

      return methodNotAllowed(res);
    } catch (err) {
      // Best-effort error.
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ error: "Internal server error" }));
      }
    }
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.listen(params.config.port, params.config.host, () => resolve());
    httpServer.on("error", reject);
  });

  const address = httpServer.address();
  const port = typeof address === "object" && address ? address.port : params.config.port;
  const baseUrl = `http://${params.config.host}:${port}/mcp`;

  return {
    url: baseUrl,
    authKey,
    close: async () => {
      for (const sid of Object.keys(transports)) {
        try {
          await transports[sid].close();
        } catch {
          // ignore
        }
        delete transports[sid];
      }
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}

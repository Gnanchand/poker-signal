import { DurableObject } from "cloudflare:workers";

const ROOM_RE = /^[a-f0-9]{10}$/i;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/") {
      return new Response("Poker signaling server is running.", { status: 200 });
    }

    const match = url.pathname.match(/^\/room\/([a-f0-9]{10})$/i);
    if (!match) return new Response("Not found", { status: 404 });

    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("WebSocket endpoint", { status: 426 });
    }

    const room = match[1].toLowerCase();
    const role = url.searchParams.get("role");
    if (!ROOM_RE.test(room) || !["host", "guest"].includes(role)) {
      return new Response("Invalid room or role", { status: 400 });
    }

    const id = env.POKER_ROOM.idFromName(room);
    return env.POKER_ROOM.get(id).fetch(request);
  },
};

export class PokerRoom extends DurableObject {
  async fetch(request) {
    const url = new URL(request.url);
    const role = url.searchParams.get("role");

    if (!role || !["host", "guest"].includes(role)) {
      return new Response("Invalid role", { status: 400 });
    }

    const oldConnections = this.ctx.getWebSockets(role);
    for (const old of oldConnections) {
      try { old.close(4000, "Replaced by a new connection"); } catch (_) {}
    }

    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server, [role]);
    server.serializeAttachment({ role });

    // If the other side arrived first, send the waiting status. If an offer
    // already exists, immediately give it to the guest.
    const otherRole = role === "host" ? "guest" : "host";
    const other = this.ctx.getWebSockets(otherRole);
    if (other.length) {
      server.send(JSON.stringify({ type: "peer-joined" }));
    }

    if (role === "guest") {
      const offer = await this.ctx.storage.get("offer");
      if (offer) {
        server.send(JSON.stringify({ type: "offer", offer }));
      }
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, message) {
    let data;
    try {
      data = JSON.parse(typeof message === "string" ? message : new TextDecoder().decode(message));
    } catch (_) {
      return;
    }

    const state = ws.deserializeAttachment() || {};
    const role = state.role;

    if (data.type === "offer" && role === "host" && typeof data.offer === "string") {
      await this.ctx.storage.put("offer", data.offer);
      for (const guest of this.ctx.getWebSockets("guest")) {
        if (guest.readyState === WebSocket.OPEN) {
          guest.send(JSON.stringify({ type: "offer", offer: data.offer }));
        }
      }
      return;
    }

    if (data.type === "answer" && role === "guest" && typeof data.answer === "string") {
      for (const host of this.ctx.getWebSockets("host")) {
        if (host.readyState === WebSocket.OPEN) {
          host.send(JSON.stringify({ type: "answer", answer: data.answer }));
        }
      }
      // The SDP is no longer needed once the answer has been delivered.
      await this.ctx.storage.delete("offer");
    }
  }

  webSocketClose(ws, code, reason) {
    // Cloudflare completes the WebSocket close handshake automatically on
    // current compatibility dates.
  }

  webSocketError(ws, error) {
    console.error("Poker signaling WebSocket error", error);
  }
}

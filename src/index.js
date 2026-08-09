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

    // Only one connection per role. Re-opening the invite replaces a stale tab.
    for (const old of this.ctx.getWebSockets(role)) {
      try { old.close(4000, "Replaced by a new connection"); } catch (_) {}
    }

    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server, [role]);
    server.serializeAttachment({ role });

    // Tell both phones when the room has exactly one host and one guest.
    const otherRole = role === "host" ? "guest" : "host";
    const other = this.ctx.getWebSockets(otherRole);
    if (other.length) {
      const ready = JSON.stringify({ type: "peer-connected" });
      if (server.readyState === WebSocket.OPEN) server.send(ready);
      for (const peer of other) {
        if (peer.readyState === WebSocket.OPEN) peer.send(ready);
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

    // Relay every poker message to the other player. The browser game remains
    // authoritative on the host side; this object only transports messages.
    const { role } = ws.deserializeAttachment() || {};
    if (!role) return;
    const otherRole = role === "host" ? "guest" : "host";
    const payload = JSON.stringify(data);
    for (const peer of this.ctx.getWebSockets(otherRole)) {
      if (peer.readyState === WebSocket.OPEN) {
        try { peer.send(payload); } catch (_) {}
      }
    }
  }

  webSocketClose() {}
  webSocketError(ws, error) {
    console.error("Poker room WebSocket error", error);
  }
}

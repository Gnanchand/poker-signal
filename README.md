# Poker signaling Worker

Cloudflare Worker + SQLite-backed Durable Object used only for WebRTC signaling.

Worker name: `poker-signal`
Durable Object binding: `POKER_ROOM`
Durable Object class: `PokerRoom`

Deploy with Wrangler:

```bash
npx wrangler deploy
```

The poker game connects to:

`wss://poker-signal.gnanchandch.workers.dev/room/<10-hex-room-id>?role=host`

or `?role=guest`.

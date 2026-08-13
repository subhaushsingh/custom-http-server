# TCP HTTP Server (Node.js, from scratch)

A raw HTTP/1.1 server built on Node's `net` module, no `http` module involved.
Connection buffering, request parsing, chunked and content-length bodies,
range requests, gzip compression, static file serving, and a full WebSocket
implementation are all hand-rolled — handshake, framing, masking,
fragmentation, ping/pong. No external deps.

Started as an exercise to see what `http.createServer` is actually doing
underneath. Turned into something usable for learning, not something meant
to sit in front of production traffic.

## Why

Most HTTP work stops at `app.get(...)`. This goes lower: reading raw bytes
off a socket, figuring out where one message ends and the next begins,
handling partial reads and backpressure, doing the WebSocket upgrade by
hand. Worth building once if you actually want to understand the protocol
instead of just calling it.

## What's in it

- Custom TCP connection wrapper (`soInit`, `soRead`, `soWrite`) — promise-based
  read/write over raw `net.Socket` events, with backpressure handled via `drain`.
- A growable dynamic buffer (`DynBuf`) for accumulating partial reads until a
  full HTTP message is available.
- Manual request line and header parsing, validated against actual token
  grammar instead of a naive split.
- Request bodies handled all three ways: `Content-Length`, chunked transfer
  encoding, EOF/connection-close.
- Response bodies handled the same three ways, plus a generator-based
  streaming reader for incrementally produced content (`/sheep`).
- Conditional gzip compression based on `Accept-Encoding`, skipped for ranged
  or already-special responses.
- Static file serving with `Range` support (single range, `206 Partial
  Content`), `Last-Modified` / `If-Modified-Since` caching, path traversal
  protection.
- WebSocket server from the RFC 6455 handshake up — frame parsing, masking,
  fragmented message reassembly, control frames, an internal async queue
  decoupling frame reads from message consumption.
- Basic CORS handling and an `OPTIONS` preflight response.

## Routes

- `GET /` — plaintext landing message
- `GET /echo` — echoes the request body back
- `GET /sheep` — streams generated text, one line every 50ms — good for
  testing chunked/streaming responses
- `GET /files/<path>` — static files out of a `www` directory relative to
  the working directory, range + caching support
- `GET /ws` — WebSocket endpoint, currently an echo server

## Running

```bash
npm install typescript ts-node @types/node
npx ts-node server.ts
```

Listens on `127.0.0.1:1234`. Static files come from a `www` directory in the
working directory doesn't exist by default, `/files` will 404 until it's
there.

No build step beyond whatever tsconfig is in place. Compiling to plain JS is
a separate step, not wired up here.

## Deployment

This is a stateful, long-lived TCP server, not a stateless request handler
that changes where it can run.

To get a custom `server.ts` like this online, you need a hosting environment
that supports long-running background processes. Vercel is fantastic for
standard full-stack web apps, but a raw `net.Socket` server requires a
persistent environment where it can continuously listen for TCP connections.
Serverless platforms shut down between requests, which breaks custom socket
implementations and WebSockets.

Realistically that means a small VPS, or a container on Railway / Render /
Fly.io something that keeps a process alive and bound to a port instead of
spinning one up per request. Still deciding which of those fits this
project best; will fill this section in properly once that's settled.

## Known limitations

- Single range requests only, no multipart `Range`.
- No HTTP/2, no TLS termination put a reverse proxy in front if either is
  needed.
- WebSocket route is an echo implementation, no routing or sub-protocol
  negotiation beyond that.
- No automated test suite yet.
- Parsing is validated but this hasn't been hardened against adversarial
  input beyond that — not something to expose directly to the internet
  without more review.

## License

MIT.

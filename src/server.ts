import * as net from "net";
import * as fs from "fs/promises";
import * as path from "path";
import * as crypto from "crypto";
import * as zlib from "zlib";
import { Readable } from "stream";
import { once } from "events";

type TCPConn = {
    socket: net.Socket;
    err: Error | null;
    ended: boolean;
    reader: null | {
        resolve: (value: Buffer) => void;
        reject: (reason: Error) => void;
    };
};

type DynBuf = {
    data: Buffer;
    length: number;
};

type HTTPReq = {
    method: string;
    uri: Buffer;
    version: string;
    headers: Buffer[];
};

type BodyReader = {
    length: number;
    read: () => Promise<Buffer>;
    close?: () => Promise<void>;
};

type HTTPRes = {
    code: number;
    headers: Buffer[];
    body: BodyReader;
};

const WS_DATA_TEXT = 0x01;
const WS_DATA_BINARY = 0x02;

type WSMsg = {
    type: number;
    length: number;
    read: () => Promise<Buffer>;
};

type WSServer = {
    send: (msg: WSMsg) => Promise<void>;
    recv: () => Promise<WSMsg | null>;
    close: () => void;
};

type WSApplication = (ws: WSServer) => Promise<void>;

class HTTPError extends Error {
    code: number;
    constructor(code: number, message: string) {
        super(message);
        this.code = code;
    }
}

function bufPush(buf: DynBuf, data: Buffer): void {
    const newLen = buf.length + data.length;
    if (buf.data.length < newLen) {
        let cap = Math.max(buf.data.length, 32);
        while (cap < newLen) cap *= 2;
        const grown = Buffer.alloc(cap);
        buf.data.copy(grown, 0, 0, buf.length);
        buf.data = grown;
    }
    data.copy(buf.data, buf.length);
    buf.length = newLen;
}

function bufPop(buf: DynBuf, len: number): void {
    if (len < 0 || len > buf.length) throw new Error("bad buffer pop");
    buf.data.copyWithin(0, len, buf.length);
    buf.length -= len;
}

function soInit(socket: net.Socket): TCPConn {
    const conn: TCPConn = { socket, err: null, ended: false, reader: null };

    socket.on("data", (data: Buffer) => {
        socket.pause();
        const reader = conn.reader;
        if (!reader) {
            conn.err = new Error("unexpected socket data without active reader");
            socket.destroy(conn.err);
            return;
        }
        conn.reader = null;
        reader.resolve(data);
    });

    socket.on("end", () => {
        conn.ended = true;
        if (conn.reader) {
            const reader = conn.reader;
            conn.reader = null;
            reader.resolve(Buffer.alloc(0));
        }
    });

    socket.on("error", (err: Error) => {
        conn.err = err;
        if (conn.reader) {
            const reader = conn.reader;
            conn.reader = null;
            reader.reject(err);
        }
    });

    return conn;
}

function soRead(conn: TCPConn): Promise<Buffer> {
    if (conn.reader) return Promise.reject(new Error("concurrent socket reads"));
    if (conn.err) return Promise.reject(conn.err);
    if (conn.ended) return Promise.resolve(Buffer.alloc(0));

    return new Promise((resolve, reject) => {
        conn.reader = { resolve, reject };
        conn.socket.resume();
    });
}

async function soWrite(conn: TCPConn, data: Buffer): Promise<void> {
    if (data.length === 0) return;
    if (conn.err) throw conn.err;
    if (conn.socket.destroyed) throw new Error("socket closed");

    const ok = conn.socket.write(data);
    if (!ok) await once(conn.socket, "drain");
}

function splitLines(data: Buffer): Buffer[] {
    const out: Buffer[] = [];
    let start = 0;
    while (true) {
        const idx = data.indexOf("\r\n", start, "latin1");
        if (idx < 0) break;
        out.push(data.subarray(start, idx));
        start = idx + 2;
    }
    if (start !== data.length) throw new HTTPError(400, "bad HTTP header");
    return out;
}

function validateToken(s: string): boolean {
    return /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(s);
}

function parseRequestLine(line: Buffer): [string, Buffer, string] {
    const text = line.toString("latin1");
    const m = /^([!#$%&'*+\-.^_`|~0-9A-Za-z]+) ([^ ]+) HTTP\/(1\.[01])$/.exec(text);
    if (!m) throw new HTTPError(400, "bad request line");
    const method = m[1]!;
    const uri = m[2]!;
    const version = m[3]!;

    return [method, Buffer.from(uri, "latin1"), version];
}

function validateHeader(line: Buffer): boolean {
    const idx = line.indexOf(":");
    if (idx <= 0) return false;
    const name = line.subarray(0, idx).toString("latin1");
    if (!validateToken(name)) return false;
    return !line.includes("\r") && !line.includes("\n");
}

function parseHTTPReq(data: Buffer): HTTPReq {
    const lines = splitLines(data);
    if (lines.length < 2 || lines[lines.length - 1]!.length !== 0) {
        throw new HTTPError(400, "bad HTTP header");
    }

    const [method, uri, version] = parseRequestLine(lines[0]!);
    const headers: Buffer[] = [];

    for (let i = 1; i < lines.length - 1; i++) {
        const h = Buffer.from(lines[i]!);
        if (!validateHeader(h)) throw new HTTPError(400, "bad header field");
        headers.push(h);
    }

    return { method, uri, version, headers };
}

function cutMessage(buf: DynBuf): HTTPReq | null {
    const idx = buf.data.subarray(0, buf.length).indexOf("\r\n\r\n");
    if (idx < 0) {
        if (buf.length > 64 * 1024) throw new HTTPError(431, "header too large");
        return null;
    }

    const msg = parseHTTPReq(Buffer.from(buf.data.subarray(0, idx + 4)));
    bufPop(buf, idx + 4);
    return msg;
}

function fieldGet(headers: Buffer[], name: string): Buffer | null {
    const lower = name.toLowerCase();
    for (const h of headers) {
        const idx = h.indexOf(":");
        if (idx < 0) continue;
        if (h.subarray(0, idx).toString("latin1").trim().toLowerCase() === lower) {
            return Buffer.from(h.subarray(idx + 1).toString("latin1").trim(), "latin1");
        }
    }
    return null;
}

function fieldGetList(headers: Buffer[], name: string): string[] {
    const lower = name.toLowerCase();
    const out: string[] = [];
    for (const h of headers) {
        const idx = h.indexOf(":");
        if (idx < 0) continue;
        if (h.subarray(0, idx).toString("latin1").trim().toLowerCase() === lower) {
            for (const x of h.subarray(idx + 1).toString("latin1").split(",")) {
                const v = x.trim().toLowerCase();
                if (v) out.push(v);
            }
        }
    }
    return out;
}

function hasToken(headers: Buffer[], name: string, token: string): boolean {
    return fieldGetList(headers, name).some(
        x => x.split(";")[0]!.trim() === token.toLowerCase()
    );
}

function readerFromMemory(data: Buffer): BodyReader {
    let done = false;
    return {
        length: data.length,
        read: async () => {
            if (done) return Buffer.alloc(0);
            done = true;
            return data;
        },
    };
}

function readerFromGenerator(gen: AsyncGenerator<Buffer, void, void>): BodyReader {
    return {
        length: -1,
        read: async () => {
            const r = await gen.next();
            return r.done ? Buffer.alloc(0) : r.value;
        },
        close: async () => {
            await gen.return(undefined);
        },
    };
}

function readerFromConnLength(conn: TCPConn, buf: DynBuf, length: number): BodyReader {
    let remain = length;

    return {
        length,
        read: async () => {
            if (remain === 0) return Buffer.alloc(0);

            if (buf.length === 0) {
                const data = await soRead(conn);
                if (data.length === 0) throw new HTTPError(400, "unexpected EOF");
                bufPush(buf, data);
            }

            const n = Math.min(buf.length, remain, 64 * 1024);
            const data = Buffer.from(buf.data.subarray(0, n));
            bufPop(buf, n);
            remain -= n;
            return data;
        },
    };
}


function readerFromConnEOF(conn: TCPConn, buf: DynBuf): BodyReader {
    return {
        length: -1,
        read: async () => {
            if (buf.length > 0) {
                const data = Buffer.from(buf.data.subarray(0, buf.length));
                bufPop(buf, buf.length);
                return data;
            }
            return await soRead(conn);
        },
    };
}


function readerFromChunked(conn: TCPConn, buf: DynBuf): BodyReader {
    let remain = 0;
    let ended = false;
    let needCRLF = false;

    async function fill(): Promise<boolean> {
        const d = await soRead(conn);
        if (d.length === 0) return false;
        bufPush(buf, d);
        return true;
    }

    async function readLine(): Promise<Buffer> {
        while (true) {
            const idx = buf.data.subarray(0, buf.length).indexOf("\r\n");
            if (idx >= 0) {
                const line = Buffer.from(buf.data.subarray(0, idx));
                bufPop(buf, idx + 2);
                return line;
            }
            if (buf.length > 8192) throw new HTTPError(400, "chunk line too long");
            if (!(await fill())) throw new HTTPError(400, "unexpected EOF in chunked body");
        }
    }

    return {
        length: -1,
        read: async () => {
            if (ended) return Buffer.alloc(0);

            if (needCRLF) {
                while (buf.length < 2) {
                    if (!(await fill())) throw new HTTPError(400, "unexpected EOF");
                }
                if (buf.data[0] !== 13 || buf.data[1] !== 10) {
                    throw new HTTPError(400, "bad chunk terminator");
                }
                bufPop(buf, 2);
                needCRLF = false;
            }

            if (remain === 0) {
                const line = (await readLine()).toString("latin1");
                const sizeText = line.split(";", 1)[0]!.trim();
                if (!/^[0-9A-Fa-f]+$/.test(sizeText)) throw new HTTPError(400, "bad chunk size");
                remain = parseInt(sizeText, 16);

                if (remain === 0) {
                    // Ignore trailer fields, but consume them correctly.
                    while ((await readLine()).length !== 0) { }
                    ended = true;
                    return Buffer.alloc(0);
                }
            }

            if (buf.length === 0) {
                if (!(await fill())) throw new HTTPError(400, "unexpected EOF");
            }

            const n = Math.min(buf.length, remain, 64 * 1024);
            const out = Buffer.from(buf.data.subarray(0, n));
            bufPop(buf, n);
            remain -= n;
            if (remain === 0) needCRLF = true;
            return out;
        },
    };
}

function readerFromReq(conn: TCPConn, buf: DynBuf, req: HTTPReq): BodyReader {
    const te = fieldGet(req.headers, "Transfer-Encoding");
    const cl = fieldGet(req.headers, "Content-Length");

    if (te && cl) throw new HTTPError(400, "ambiguous body length");

    if (te) {
        const values = fieldGetList(req.headers, "Transfer-Encoding");
        if (values.length !== 1 || values[0] !== "chunked") {
            throw new HTTPError(501, "unsupported transfer encoding");
        }
        return readerFromChunked(conn, buf);
    }

    if (cl) {
        const text = cl.toString("latin1");
        if (!/^\d+$/.test(text)) throw new HTTPError(400, "bad content-length");
        const n = Number(text);
        if (!Number.isSafeInteger(n)) throw new HTTPError(400, "content-length too large");
        return readerFromConnLength(conn, buf, n);
    }

    return readerFromMemory(Buffer.alloc(0));
}

const STATUS: Record<number, string> = {
    101: "Switching Protocols",
    200: "OK",
    206: "Partial Content",
    304: "Not Modified",
    400: "Bad Request",
    403: "Forbidden",
    404: "Not Found",
    405: "Method Not Allowed",
    411: "Length Required",
    416: "Range Not Satisfiable",
    431: "Request Header Fields Too Large",
    500: "Internal Server Error",
    501: "Not Implemented",
};

function encodeHTTPResp(resp: HTTPRes): Buffer {
    const reason = STATUS[resp.code] ?? "Unknown";
    const lines = [
        `HTTP/1.1 ${resp.code} ${reason}`,
        "Server: build-your-own-ts",
        ...resp.headers.map(h => h.toString("latin1")),
        "",
        "",
    ];
    return Buffer.from(lines.join("\r\n"), "latin1");
}

async function writeHTTPHeader(conn: TCPConn, resp: HTTPRes): Promise<void> {
    if (resp.code !== 101 && resp.code !== 304) {
        if (resp.body.length < 0) {
            if (!fieldGet(resp.headers, "Transfer-Encoding")) {
                resp.headers.push(Buffer.from("Transfer-Encoding: chunked"));
            }
        } else if (!fieldGet(resp.headers, "Content-Length")) {
            resp.headers.push(Buffer.from(`Content-Length: ${resp.body.length}`));
        }
    }
    await soWrite(conn, encodeHTTPResp(resp));
}

async function writeHTTPBody(conn: TCPConn, body: BodyReader, raw = false): Promise<void> {
    if (raw) {
        while (true) {
            const data = await body.read();
            if (data.length === 0) return;
            await soWrite(conn, data);
        }
    }

    if (body.length >= 0) {
        while (true) {
            const data = await body.read();
            if (data.length === 0) return;
            await soWrite(conn, data);
        }
    }

    const crlf = Buffer.from("\r\n");
    while (true) {
        const data = await body.read();
        if (data.length === 0) {
            await soWrite(conn, Buffer.from("0\r\n\r\n"));
            return;
        }
        await soWrite(conn, Buffer.concat([
            Buffer.from(data.length.toString(16)),
            crlf,
            data,
            crlf,
        ]));
    }
}


async function readAll(reader: BodyReader, limit = 32 * 1024 * 1024): Promise<Buffer> {
    const parts: Buffer[] = [];
    let total = 0;
    while (true) {
        const d = await reader.read();
        if (d.length === 0) break;
        total += d.length;
        if (total > limit) throw new HTTPError(400, "body too large");
        parts.push(d);
    }
    return Buffer.concat(parts);
}

function gzipFilter(source: BodyReader): BodyReader {
    const input = new Readable({
        read() { },
    });
    const gzip = zlib.createGzip({ flush: zlib.constants.Z_SYNC_FLUSH });
    input.pipe(gzip);

    let pumping = false;
    let ended = false;

    async function pump(): Promise<void> {
        if (pumping) return;
        pumping = true;
        try {
            const d = await source.read();
            if (d.length === 0) {
                ended = true;
                input.push(null);
            } else {
                input.push(d);
            }
        } catch (e) {
            input.destroy(e as Error);
        } finally {
            pumping = false;
        }
    }

    const iter = gzip[Symbol.asyncIterator]();

    return {
        length: -1,
        read: async () => {
            if (!ended) await pump();
            const r = await iter.next();
            if (!r.done) return Buffer.from(r.value);
            return Buffer.alloc(0);
        },
        close: async () => {
            input.destroy();
            gzip.destroy();
            await source.close?.();
        },
    };
}

function enableCompression(req: HTTPReq, res: HTTPRes): void {
    res.headers.push(Buffer.from("Vary: Accept-Encoding"));

    if (fieldGet(req.headers, "Range")) return;
    if (!hasToken(req.headers, "Accept-Encoding", "gzip")) return;
    if (res.code === 101 || res.code === 206 || res.code === 304) return;

    res.headers = res.headers.filter(h => {
        const idx = h.indexOf(":");
        return idx < 0 || h.subarray(0, idx).toString("latin1").toLowerCase() !== "content-length";
    });
    res.headers.push(Buffer.from("Content-Encoding: gzip"));
    res.body = gzipFilter(res.body);
}

function parseSingleRange(value: string, size: number): [number, number] | null {
    const m = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
    if (!m) return null;

    if (m[1] === "" && m[2] === "") return null;

    let start: number;
    let end: number;

    if (m[1] === "") {
        const suffix = Number(m[2]);
        if (!Number.isSafeInteger(suffix) || suffix <= 0) return null;
        start = Math.max(0, size - suffix);
        end = size - 1;
    } else {
        start = Number(m[1]);
        if (!Number.isSafeInteger(start) || start >= size) return null;
        end = m[2] === "" ? size - 1 : Number(m[2]);
        if (!Number.isSafeInteger(end) || end < start) return null;
        end = Math.min(end, size - 1);
    }

    return [start, end];
}


function fileReader(handle: fs.FileHandle, start: number, length: number): BodyReader {
    let pos = start;
    let remain = length;
    let closed = false;

    return {
        length,
        read: async () => {
            if (remain <= 0) return Buffer.alloc(0);
            const buf = Buffer.allocUnsafe(Math.min(64 * 1024, remain));
            const r = await handle.read(buf, 0, buf.length, pos);
            if (r.bytesRead === 0) return Buffer.alloc(0);
            pos += r.bytesRead;
            remain -= r.bytesRead;
            return buf.subarray(0, r.bytesRead);
        },
        close: async () => {
            if (!closed) {
                closed = true;
                await handle.close();
            }
        },
    };
}


function mimeType(p: string): string {
    const ext = path.extname(p).toLowerCase();
    return ({
        ".html": "text/html; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".js": "text/javascript; charset=utf-8",
        ".json": "application/json",
        ".txt": "text/plain; charset=utf-8",
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".gif": "image/gif",
        ".svg": "image/svg+xml",
        ".pdf": "application/pdf",
    } as Record<string, string>)[ext] ?? "application/octet-stream";
}

function wsKeyAccept(key: Buffer): string {
    return crypto
        .createHash("sha1")
        .update(key)
        .update("258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
        .digest("base64");
}

function getWSApp(req: HTTPReq): WSApplication | null {
    const uri = req.uri.toString("latin1").split("?")[0];
    if (uri !== "/ws") return null;
    if (req.method !== "GET" || req.version !== "1.1") return null;
    if (!hasToken(req.headers, "Upgrade", "websocket")) return null;
    if (!hasToken(req.headers, "Connection", "upgrade")) return null;
    if (!fieldGet(req.headers, "Sec-WebSocket-Key")) return null;
    if (fieldGet(req.headers, "Sec-WebSocket-Version")?.toString("latin1") !== "13") return null;

    return async (ws: WSServer) => {
        while (true) {
            const msg = await ws.recv();
            if (!msg) return;

            const data = await readAll({
                length: msg.length,
                read: msg.read,
            });

            await ws.send({
                type: msg.type,
                length: data.length,
                read: (() => {
                    let done = false;
                    return async () => {
                        if (done) return Buffer.alloc(0);
                        done = true;
                        return data;
                    };
                })(),
            });
        }
    };
}

function wsFrame(opcode: number, payload: Buffer, fin = true): Buffer {
    const first = (fin ? 0x80 : 0) | opcode;
    let head: Buffer;

    if (payload.length < 126) {
        head = Buffer.from([first, payload.length]);
    } else if (payload.length <= 0xffff) {
        head = Buffer.alloc(4);
        head[0] = first;
        head[1] = 126;
        head.writeUInt16BE(payload.length, 2);
    } else {
        head = Buffer.alloc(10);
        head[0] = first;
        head[1] = 127;
        head.writeBigUInt64BE(BigInt(payload.length), 2);
    }

    return Buffer.concat([head, payload]);
}


async function createWSServer(input: BodyReader): Promise<[WSServer, BodyReader]> {
    const incoming = createQueue<WSMsg>(1);
    const outgoing = createQueue<Buffer>(4);
    let closed = false;

    const ibuf: DynBuf = { data: Buffer.alloc(0), length: 0 };

    async function ensure(n: number): Promise<boolean> {
        while (ibuf.length < n) {
            const d = await input.read();
            if (d.length === 0) return false;
            bufPush(ibuf, d);
        }
        return true;
    }

    async function take(n: number): Promise<Buffer> {
        if (!(await ensure(n))) throw new Error("unexpected WebSocket EOF");
        const out = Buffer.from(ibuf.data.subarray(0, n));
        bufPop(ibuf, n);
        return out;
    }

    async function protocolReader(): Promise<void> {
        let fragmentedType: number | null = null;
        let fragments: Buffer[] = [];
        let fragmentBytes = 0;

        try {
            while (!closed) {
                if (!(await ensure(2))) break;
                const h = await take(2);
                const fin = !!(h[0]! & 0x80);
                const rsv = h[0]! & 0x70;
                const opcode = h[0]! & 0x0f;
                const masked = !!(h[1]! & 0x80);
                let len = h[1]! & 0x7f;

                if (rsv !== 0) throw new Error("unsupported WebSocket extension");
                if (!masked) throw new Error("client WebSocket frames must be masked");

                if (len === 126) {
                    len = (await take(2)).readUInt16BE(0);
                } else if (len === 127) {
                    const big = (await take(8)).readBigUInt64BE(0);
                    if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("frame too large");
                    len = Number(big);
                }

                const control = opcode >= 0x8;
                if (control && (!fin || len > 125)) throw new Error("invalid control frame");
                if (len > 16 * 1024 * 1024) throw new Error("WebSocket frame too large");

                const mask = await take(4);
                const payload = await take(len);
                for (let i = 0; i < payload.length; i++) {
                    payload[i] = payload[i]! ^ mask[i & 3]!;
                }

                if (opcode === 0x8) {
                    await outgoing.pushBack(wsFrame(0x8, payload.subarray(0, 125)));
                    break;
                }

                if (opcode === 0x9) {
                    await outgoing.pushBack(wsFrame(0xA, payload));
                    continue;
                }

                if (opcode === 0xA) continue;

                if (opcode === WS_DATA_TEXT || opcode === WS_DATA_BINARY) {
                    if (fragmentedType !== null) throw new Error("unexpected new data frame");

                    if (fin) {
                        let done = false;
                        const copy = Buffer.from(payload);
                        await incoming.pushBack({
                            type: opcode,
                            length: copy.length,
                            read: async () => {
                                if (done) return Buffer.alloc(0);
                                done = true;
                                return copy;
                            },
                        });
                    } else {
                        fragmentedType = opcode;
                        fragments = [Buffer.from(payload)];
                        fragmentBytes = payload.length;
                    }
                    continue;
                }

                if (opcode === 0x0) {
                    if (fragmentedType === null) throw new Error("unexpected continuation frame");
                    fragments.push(Buffer.from(payload));
                    fragmentBytes += payload.length;
                    if (fragmentBytes > 32 * 1024 * 1024) throw new Error("message too large");

                    if (fin) {
                        const message = Buffer.concat(fragments, fragmentBytes);
                        const type = fragmentedType;
                        fragmentedType = null;
                        fragments = [];
                        fragmentBytes = 0;

                        let done = false;
                        await incoming.pushBack({
                            type,
                            length: message.length,
                            read: async () => {
                                if (done) return Buffer.alloc(0);
                                done = true;
                                return message;
                            },
                        });
                    }
                    continue;
                }

                throw new Error("unsupported WebSocket opcode");
            }
        } finally {
            incoming.close();
            outgoing.close();
        }
    }

    protocolReader().catch(err => {
        console.error("WebSocket protocol error:", err);
        incoming.close();
        outgoing.close();
    });

    const ws: WSServer = {
        async send(msg: WSMsg): Promise<void> {
            if (closed) throw new Error("WebSocket closed");
            if (msg.type !== WS_DATA_TEXT && msg.type !== WS_DATA_BINARY) {
                throw new Error("bad WebSocket message type");
            }

            const payload = await readAll({
                length: msg.length,
                read: msg.read,
            }, 32 * 1024 * 1024);

            await outgoing.pushBack(wsFrame(msg.type, payload));
        },

        recv(): Promise<WSMsg | null> {
            return incoming.popFront();
        },

        close(): void {
            if (closed) return;
            closed = true;
            incoming.close();
            outgoing.close();
        },
    };

    const responseBody: BodyReader = {
        length: -1,
        read: async () => {
            const frame = await outgoing.popFront();
            return frame ?? Buffer.alloc(0);
        },
        close: async () => {
            ws.close();
            await input.close?.();
        },
    };

    return [ws, responseBody];
}


async function handleWS(
    req: HTTPReq,
    reqBody: BodyReader,
    app: WSApplication,
): Promise<HTTPRes> {
    const key = fieldGet(req.headers, "Sec-WebSocket-Key");
    if (!key) throw new HTTPError(400, "missing WebSocket key");

    const [ws, resBody] = await createWSServer(reqBody);

    app(ws)
        .catch(err => console.error("WebSocket app error:", err))
        .finally(() => ws.close());

    return {
        code: 101,
        headers: [
            Buffer.from("Upgrade: websocket"),
            Buffer.from("Connection: Upgrade"),
            Buffer.from(`Sec-WebSocket-Accept: ${wsKeyAccept(key)}`),
        ],
        body: resBody,
    };
}

/* ------------------------------- Main loop -------------------------------- */

function errorResponse(err: unknown): HTTPRes {
    const code = err instanceof HTTPError ? err.code : 500;
    const message = err instanceof Error ? err.message : "internal error";
    return {
        code,
        headers: [Buffer.from("Content-Type: text/plain; charset=utf-8")],
        body: readerFromMemory(Buffer.from(`${code} ${STATUS[code] ?? "Error"}\n${message}\n`)),
    };
}

async function serveClient(socket: net.Socket): Promise<void> {
    const conn = soInit(socket);
    const buf: DynBuf = { data: Buffer.alloc(0), length: 0 };

    while (true) {
        let msg: HTTPReq | null = null;

        try {
            while (!msg) {
                msg = cutMessage(buf);
                if (msg) break;

                const data = await soRead(conn);
                if (data.length === 0) return;
                bufPush(buf, data);
            }

            const wsapp = getWSApp(msg);
            let reqBody: BodyReader;
            let res: HTTPRes;

            if (wsapp) {
                reqBody = readerFromConnEOF(conn, buf);
                res = await handleWS(msg, reqBody, wsapp);
            } else {
                reqBody = readerFromReq(conn, buf, msg);
                res = await handleReq(msg, reqBody);
            }

            try {
                if (!wsapp) enableCompression(msg, res);

                await writeHTTPHeader(conn, res);

                if (msg.method !== "HEAD") {
                    await writeHTTPBody(conn, res.body, !!wsapp);
                }
            } finally {
                await res.body.close?.();
            }

            if (wsapp || msg.version === "1.0" || hasToken(msg.headers, "Connection", "close")) {
                return;
            }

            // A handler may intentionally ignore the request body.
            while ((await reqBody.read()).length > 0) { }
        } catch (err) {
            console.error("request error:", err);
            try {
                const res = errorResponse(err);
                res.headers.push(Buffer.from("Connection: close"));
                await writeHTTPHeader(conn, res);
                await writeHTTPBody(conn, res.body);
                await res.body.close?.();
            } catch { }
            return;
        }
    }
}

async function newConn(socket: net.Socket): Promise<void> {
    console.log("new connection", socket.remoteAddress, socket.remotePort);
    try {
        await serveClient(socket);
    } catch (err) {
        console.error("connection exception:", err);
    } finally {
        socket.destroy();
    }
}

const server = net.createServer({ pauseOnConnect: true });

server.on("connection", socket => {
    void newConn(socket);
});

server.on("error", err => {
    console.error("server error:", err);
});

server.listen({ host: "127.0.0.1", port: 1234 }, () => {
    console.log("listening on http://127.0.0.1:1234");
});

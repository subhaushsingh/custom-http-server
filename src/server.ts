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
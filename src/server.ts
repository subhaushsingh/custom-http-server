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
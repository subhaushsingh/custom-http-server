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

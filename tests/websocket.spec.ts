import { test, expect } from "@playwright/test";
import WebSocket from "ws";

function openSocket(): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket("ws://127.0.0.1:1234/ws");
        ws.once("open", () => resolve(ws));
        ws.once("error", reject);
    });
}

test.describe("WebSocket /ws (echo server)", () => {
    test("echoes a text message back unchanged", async () => {
        const ws = await openSocket();

        const received = new Promise<string>((resolve) => {
            ws.once("message", (data) => resolve(data.toString()));
        });

        ws.send("hello from playwright");
        expect(await received).toBe("hello from playwright");

        ws.close();
    });

    test("echoes a binary message unchanged", async () => {
        const ws = await openSocket();
        const payload = Buffer.from([1, 2, 3, 4, 5]);

        const received = new Promise<Buffer>((resolve) => {
            ws.once("message", (data) => resolve(data as Buffer));
        });

        ws.send(payload);
        const echoed = await received;
        expect(Buffer.compare(echoed, payload)).toBe(0);

        ws.close();
    });

    test("responds to ping with pong", async () => {
        const ws = await openSocket();

        const gotPong = new Promise<void>((resolve) => {
            ws.once("pong", () => resolve());
        });

        ws.ping();
        await gotPong;

        ws.close();
    });

    test("server closes cleanly on client close frame", async () => {
        const ws = await openSocket();

        const closed = new Promise<number>((resolve) => {
            ws.once("close", (code) => resolve(code));
        });

        ws.close(1000);
        const code = await closed;
        expect(code).toBe(1000);
    });
});
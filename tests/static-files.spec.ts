import { test, expect } from "@playwright/test";

const FIXTURE_PATH = "/files/test.txt";

test.describe("static file serving", () => {
    test("serves an existing file with correct headers", async ({ request }) => {
        const res = await request.get(FIXTURE_PATH);
        expect(res.status()).toBe(200);
        expect(res.headers()["accept-ranges"]).toBe("bytes");
        expect(res.headers()["last-modified"]).toBeTruthy();
    });

    test("missing file returns 404", async ({ request }) => {
        const res = await request.get("/files/does-not-exist.txt");
        expect(res.status()).toBe(404);
    });

    test("path traversal outside www is rejected", async ({ request }) => {
        const res = await request.get("/files/../../etc/passwd");
        expect([403, 404]).toContain(res.status());
    });

    test("range request returns 206 with correct Content-Range", async ({ request }) => {
        const full = await request.get(FIXTURE_PATH);
        const fullBody = await full.text();
        test.skip(fullBody.length < 5, "fixture file too small for a meaningful range test");

        const res = await request.get(FIXTURE_PATH, {
            headers: { Range: "bytes=0-4" },
        });
        expect(res.status()).toBe(206);
        expect(res.headers()["content-range"]).toMatch(/^bytes 0-4\//);
        const body = await res.text();
        expect(body.length).toBe(5);
        expect(body).toBe(fullBody.slice(0, 5));
    });

    test("unsatisfiable range returns 416", async ({ request }) => {
        const res = await request.get(FIXTURE_PATH, {
            headers: { Range: "bytes=999999-1000000" },
        });
        expect(res.status()).toBe(416);
        expect(res.headers()["content-range"]).toMatch(/^bytes \*\//);
    });

    test("If-Modified-Since returns 304 when unchanged", async ({ request }) => {
        const first = await request.get(FIXTURE_PATH);
        const lastModified = first.headers()["last-modified"];
        expect(lastModified).toBeTruthy();

        const second = await request.get(FIXTURE_PATH, {
            headers: { "If-Modified-Since": lastModified! },
        });
        expect(second.status()).toBe(304);
    });
});
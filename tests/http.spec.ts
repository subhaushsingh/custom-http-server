import { test, expect } from "@playwright/test";

test.describe("basic routes", () => {
    test("GET / returns the landing message", async ({ request }) => {
        const res = await request.get("/");
        expect(res.status()).toBe(200);
        expect(res.headers()["content-type"]).toContain("text/plain");
        const body = await res.text();
        expect(body).toContain("Hello from your web server");
    });

    test("unknown route returns 404", async ({ request }) => {
        const res = await request.get("/does-not-exist");
        expect(res.status()).toBe(404);
    });

    test("unsupported method returns 405 with Allow header", async ({ request }) => {
        const res = await request.fetch("/", { method: "DELETE" });
        expect(res.status()).toBe(405);
        expect(res.headers()["allow"]).toContain("GET");
    });

    test("OPTIONS returns CORS preflight headers", async ({ request }) => {
        const res = await request.fetch("/", { method: "OPTIONS" });
        expect(res.status()).toBe(204);
        expect(res.headers()["access-control-allow-origin"]).toBe("*");
    });
});

test.describe("/echo", () => {
    test("echoes the request body back exactly", async ({ request }) => {
        const payload = "the quick brown fox";
        const res = await request.post("/echo", { data: payload });
        expect(res.status()).toBe(200);
        expect(await res.text()).toBe(payload);
    });

    test("handles an empty body", async ({ request }) => {
        const res = await request.get("/echo");
        expect(res.status()).toBe(200);
        expect(await res.text()).toBe("");
    });
});

test.describe("/sheep (streaming / chunked response)", () => {
    test("streams a chunked response with expected content", async ({ request }) => {
        const res = await request.get("/sheep");
        expect(res.status()).toBe(200);
        const body = await res.text();
        expect(body).toContain("0 sheep...");
        expect(body).toContain("99 sheep...");
    });
});

test.describe("gzip compression", () => {
    test("compresses when Accept-Encoding includes gzip", async ({ request }) => {
        const res = await request.get("/", {
            headers: { "Accept-Encoding": "gzip" },
        });
        expect(res.headers()["content-encoding"]).toBe("gzip");
        expect(await res.text()).toContain("Hello from your web server");
    });

    test("does not compress when Accept-Encoding is omitted", async ({ request }) => {
        const res = await request.get("/", {
            headers: { "Accept-Encoding": "identity" },
        });
        expect(res.headers()["content-encoding"]).toBeUndefined();
    });
});
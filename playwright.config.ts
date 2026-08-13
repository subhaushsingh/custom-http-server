import { defineConfig } from "@playwright/test";

export default defineConfig({
    testDir: "./tests",
    fullyParallel: false,
    retries: 0,
    reporter: "html",

    use: {
        baseURL: "http://127.0.0.1:1234",
    },
    webServer: {
        command: "npx tsx src/server.ts",
        url: "http://127.0.0.1:1234",
        reuseExistingServer: !process.env.CI,
        timeout: 10_000,
    },
});
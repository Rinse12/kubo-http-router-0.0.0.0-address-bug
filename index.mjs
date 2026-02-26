/**
 * Reproduction script for https://github.com/ipfs/kubo/issues/10087
 *
 * Kubo announces raw listen addresses (0.0.0.0) to HTTP routers via
 * Routing V1 PUT /routing/v1/providers, instead of the resolved
 * interface addresses it reports via `ipfs id`.
 *
 * This script:
 * 1. Starts a minimal HTTP Routing V1 server that records incoming requests
 * 2. Starts a fresh Kubo daemon configured to use it as an HTTP router
 * 3. Adds content and triggers `routing provide`
 * 4. Compares addresses from `ipfs id` with those sent to the HTTP router
 */

import http from "node:http";
import { execSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { path as getKuboPath } from "kubo";

// ─── Minimal HTTP Routing V1 server ────────────────────────────────────────

function createMockHttpRouter() {
    const requests = [];

    const server = http.createServer((req, res) => {
        const chunks = [];
        req.on("data", (chunk) => chunks.push(chunk));
        req.on("end", () => {
            const body = Buffer.concat(chunks).toString("utf-8");
            requests.push({ method: req.method, url: req.url, body });

            // Accept PUT provider records
            if (req.method === "PUT" && req.url.startsWith("/routing/v1/providers")) {
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ ok: true }));
                return;
            }

            // Return empty for GET (not needed for this test)
            if (req.method === "GET") {
                res.writeHead(404, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ Providers: null }));
                return;
            }

            res.writeHead(501);
            res.end("Not Implemented");
        });
    });

    return {
        requests,
        start: () =>
            new Promise((resolve) => {
                server.listen(0, "127.0.0.1", () => {
                    const { port } = server.address();
                    resolve({ url: `http://127.0.0.1:${port}`, port });
                });
            }),
        stop: () => new Promise((resolve) => server.close(resolve))
    };
}

// ─── Helpers ───────────────────────────────────────────────────────────────

const kuboBin = getKuboPath();
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kubo-addr-repro-"));
const apiPort = 15199;
const swarmPort = 24199;

function kuboCmd(args) {
    return execSync(`${kuboBin} ${args}`, {
        env: { ...process.env, IPFS_PATH: tmpDir },
        encoding: "utf-8",
        timeout: 30000
    }).trim();
}

async function waitForApi() {
    const start = Date.now();
    while (Date.now() - start < 30000) {
        try {
            const res = await fetch(`http://127.0.0.1:${apiPort}/api/v0/id`, { method: "POST" });
            if (res.ok) return;
        } catch {}
        await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error("Kubo API not ready after 30s");
}

// ─── Main ──────────────────────────────────────────────────────────────────

let kuboProcess = null;
const router = createMockHttpRouter();

async function cleanup() {
    if (kuboProcess) {
        try {
            kuboProcess.kill("SIGTERM");
        } catch {}
        await new Promise((r) => setTimeout(r, 2000));
    }
    await router.stop().catch(() => {});
    fs.rmSync(tmpDir, { recursive: true, force: true });
}

try {
    console.log("Kubo version:", kuboCmd("version"));
    console.log("Temp repo:", tmpDir);
    console.log();

    // 1. Start mock HTTP router
    const { url: routerUrl } = await router.start();
    console.log(`Mock HTTP router listening at ${routerUrl}\n`);

    // 2. Init and configure Kubo (default Addresses.Swarm is already 0.0.0.0,
    //    we only override ports to avoid conflicts with other running instances)
    kuboCmd("init");
    kuboCmd(`config Addresses.API /ip4/127.0.0.1/tcp/${apiPort}`);
    kuboCmd(`config Addresses.Gateway ""`);
    kuboCmd(`config --json Addresses.Swarm '["/ip4/0.0.0.0/tcp/${swarmPort}", "/ip6/::/tcp/${swarmPort}", "/ip4/0.0.0.0/udp/${swarmPort}/quic-v1", "/ip6/::/udp/${swarmPort}/quic-v1", "/ip4/0.0.0.0/udp/${swarmPort}/quic-v1/webtransport", "/ip6/::/udp/${swarmPort}/quic-v1/webtransport", "/ip4/0.0.0.0/udp/${swarmPort}/webrtc-direct", "/ip6/::/udp/${swarmPort}/webrtc-direct"]'`);
    kuboCmd("bootstrap rm --all");
    kuboCmd("config --json Discovery.MDNS.Enabled false");

    const routingConfig = JSON.stringify({
        Type: "custom",
        Methods: {
            "find-providers": { RouterName: "HttpRouter" },
            provide: { RouterName: "HttpRouter" },
            "find-peers": { RouterName: "HttpRouter" },
            "get-ipns": { RouterName: "HttpRouter" },
            "put-ipns": { RouterName: "HttpRouter" }
        },
        Routers: {
            HttpRouter: {
                Type: "http",
                Parameters: { Endpoint: routerUrl }
            }
        }
    });
    kuboCmd(`config --json Routing '${routingConfig}'`);

    // 3. Start daemon
    kuboProcess = spawn(kuboBin, ["daemon"], {
        env: { ...process.env, IPFS_PATH: tmpDir },
        stdio: ["ignore", "pipe", "pipe"]
    });
    kuboProcess.stderr.on("data", () => {});
    kuboProcess.stdout.on("data", () => {});

    await waitForApi();
    console.log("Kubo daemon started.\n");

    // 4. Get addresses from `ipfs id`
    const apiBase = `http://127.0.0.1:${apiPort}/api/v0`;
    const idRes = await fetch(`${apiBase}/id`, { method: "POST" });
    const idData = await idRes.json();

    console.log("=== Addresses reported by `ipfs id` ===");
    for (const addr of idData.Addresses) {
        console.log(`  ${addr}`);
    }
    console.log();

    // 5. Add content and provide it
    const boundary = "----Boundary" + Math.random().toString(36).slice(2);
    const body =
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="test.txt"\r\n` +
        `Content-Type: application/octet-stream\r\n\r\ntest-${Date.now()}\r\n--${boundary}--\r\n`;

    const addRes = await fetch(`${apiBase}/add`, {
        method: "POST",
        headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
        body
    });
    const { Hash: cid } = await addRes.json();
    console.log(`Added content: ${cid}`);

    await fetch(`${apiBase}/routing/provide?arg=${cid}`, { method: "POST" });
    await new Promise((r) => setTimeout(r, 3000));

    // 6. Inspect what the HTTP router received
    const putRequests = router.requests.filter(
        (r) => r.method === "PUT" && r.url.startsWith("/routing/v1/providers")
    );

    console.log(`\n=== Addresses sent to HTTP router (${putRequests.length} PUT requests) ===`);

    let hasBadAddrs = false;
    for (const req of putRequests) {
        let parsed;
        try {
            parsed = JSON.parse(req.body);
        } catch {
            continue;
        }
        for (const provider of parsed.Providers || []) {
            const addrs = provider?.Payload?.Addrs || provider?.Addrs || [];
            for (const addr of addrs) {
                const bad = addr.includes("0.0.0.0");
                if (bad) hasBadAddrs = true;
                console.log(`  ${addr}${bad ? "  <-- BUG: raw listen address" : ""}`);
            }
        }
    }

    // 7. Verdict
    console.log("\n=== Result ===");
    if (putRequests.length === 0) {
        console.log("No PUT requests received -- could not verify.");
    } else if (hasBadAddrs) {
        console.log(
            "FAIL: Kubo sent raw 0.0.0.0 listen addresses to the HTTP router.\n" +
                "      `ipfs id` resolves these to real interface addresses, but the\n" +
                "      HTTP Routing V1 provider records contain the unresolved values.\n" +
                "      See https://github.com/ipfs/kubo/issues/10087"
        );
        process.exitCode = 1;
    } else {
        console.log("PASS: All addresses sent to the HTTP router are resolved (no 0.0.0.0).");
    }
} finally {
    await cleanup();
}

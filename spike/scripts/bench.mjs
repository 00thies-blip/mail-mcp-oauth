#!/usr/bin/env node
/**
 * Phase 0 Go/No-Go measurement script.
 *
 * Fires N calls each against list_folders and list_messages(limit=5) on
 * a deployed mail-mcp-spike Worker, and captures the PLATFORM-REPORTED
 * CPU time per invocation via `wrangler tail --format=json` running
 * alongside (Cloudflare Workers Free enforces a 10ms CPU/request budget
 * and errors with code 1102 past it -- CPU time is what the Go/No-Go
 * criterion is measured against, NOT client-observed wall-clock latency,
 * which also includes network RTT and has nothing to do with the
 * platform's limit).
 *
 * Usage:
 *   SPIKE_URL=https://mail-mcp-spike.<subdomain>.workers.dev \
 *   SPIKE_TOKEN=... \
 *   MAILBOX=INBOX \
 *   ACCOUNT=gmail \
 *   node scripts/bench.mjs [N=20]
 *
 * Requires `wrangler` to be logged in (or CLOUDFLARE_API_TOKEN set) and
 * run from the spike/ directory so `wrangler tail` resolves the right
 * worker via wrangler.toml.
 *
 * IMPORTANT: `wrangler tail`'s exact JSON field names have moved across
 * versions. This script looks for a `cpuTime` field (top-level, then
 * inside `.event`) and prints the raw first captured line if it can't
 * find one, so you can adjust CPU_TIME_PATHS below to match your
 * installed wrangler version instead of trusting silently-wrong numbers.
 */
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { writeFile, readFile, rm } from "node:fs/promises";

const SPIKE_URL = process.env.SPIKE_URL;
const SPIKE_TOKEN = process.env.SPIKE_TOKEN;
const MAILBOX = process.env.MAILBOX ?? "INBOX";
const ACCOUNT = process.env.ACCOUNT; // optional
const N = parseInt(process.argv[2] ?? process.env.N ?? "20", 10);
const TAIL_LOG = new URL("../.tail-capture.jsonl", import.meta.url).pathname;

if (!SPIKE_URL || !SPIKE_TOKEN) {
  console.error("Set SPIKE_URL and SPIKE_TOKEN env vars first.");
  process.exit(1);
}

function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

function stats(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    n: sorted.length,
    min: sorted[0] ?? null,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    max: sorted[sorted.length - 1] ?? null,
  };
}

async function callTool(name, args) {
  const start = performance.now();
  const res = await fetch(`${SPIKE_URL}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${SPIKE_TOKEN}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: `${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  const bodyText = await res.text();
  const wallMs = performance.now() - start;
  let ok = res.ok;
  let isError = false;
  try {
    const body = JSON.parse(bodyText);
    isError = Boolean(body?.result?.isError) || Boolean(body?.error);
  } catch {
    ok = false;
  }
  return { wallMs, httpStatus: res.status, ok: ok && !isError, bodyText };
}

async function runCalls(name, args, count) {
  const wallTimes = [];
  let failures = 0;
  for (let i = 0; i < count; i++) {
    const { wallMs, ok, httpStatus, bodyText } = await callTool(name, args);
    wallTimes.push(wallMs);
    if (!ok) {
      failures++;
      console.error(`  [${name} #${i + 1}] FAILED (HTTP ${httpStatus}): ${bodyText.slice(0, 300)}`);
    }
    // Small gap so wrangler tail events don't overlap ambiguously and we
    // don't trip the Free plan's concurrent-connection ceiling.
    await sleep(150);
  }
  return { wallTimes, failures };
}

function extractCpuMs(entry) {
  // Try the shapes seen across wrangler versions; adjust if your
  // installed version differs (print one raw line to check).
  const candidates = [entry?.cpuTime, entry?.event?.cpuTime, entry?.metrics?.cpuTime, entry?.wallTime && undefined];
  for (const c of candidates) {
    if (typeof c === "number") return c;
  }
  return null;
}

async function main() {
  console.log(`Target: ${SPIKE_URL}  N=${N} per tool  mailbox=${MAILBOX}${ACCOUNT ? `  account=${ACCOUNT}` : ""}`);

  await rm(TAIL_LOG, { force: true });
  console.log("Starting `wrangler tail --format=json` to capture platform CPU time...");
  const tail = spawn("npx", ["wrangler", "tail", "--format=json"], {
    cwd: new URL("..", import.meta.url).pathname,
    stdio: ["ignore", "pipe", "inherit"],
  });
  const tailChunks = [];
  tail.stdout.on("data", (d) => tailChunks.push(d));
  await sleep(4000); // give the tail session time to attach

  const folderRun = await runCalls("list_folders", ACCOUNT ? { account: ACCOUNT } : {}, N);
  const messageRun = await runCalls(
    "list_messages",
    { mailbox: MAILBOX, limit: 5, ...(ACCOUNT ? { account: ACCOUNT } : {}) },
    N
  );

  await sleep(3000); // let trailing log lines flush
  tail.kill("SIGINT");
  await sleep(500);

  const raw = Buffer.concat(tailChunks).toString("utf8");
  await writeFile(TAIL_LOG, raw);
  const lines = raw.split("\n").filter((l) => l.trim().startsWith("{"));
  const entries = lines.map((l) => {
    try {
      return JSON.parse(l);
    } catch {
      return null;
    }
  }).filter(Boolean);

  const cpuTimes = entries.map(extractCpuMs).filter((v) => v !== null);

  console.log(`\nCaptured ${entries.length} tail events, ${cpuTimes.length} with a recognized CPU-time field.`);
  if (entries.length > 0 && cpuTimes.length === 0) {
    console.log("Could not find a cpuTime field automatically. First raw event for manual inspection:");
    console.log(JSON.stringify(entries[0], null, 2));
    console.log(`\n(Full capture saved to ${TAIL_LOG})`);
  }

  console.log("\n=== Wall-clock latency (client-observed, includes network RTT) ===");
  console.log("list_folders :", JSON.stringify(stats(folderRun.wallTimes)));
  console.log("list_messages:", JSON.stringify(stats(messageRun.wallTimes)));
  console.log(`failures: list_folders=${folderRun.failures}/${N}  list_messages=${messageRun.failures}/${N}`);

  if (cpuTimes.length > 0) {
    console.log("\n=== Platform CPU time (ms, from wrangler tail) -- this is the Go/No-Go number ===");
    console.log(JSON.stringify(stats(cpuTimes)));
    const p95 = stats(cpuTimes).p95;
    console.log(`\nGo/No-Go: p95 CPU ${p95 <= 8 ? "PASS" : "FAIL"} (need < 8ms, got ${p95}ms)`);
  } else {
    console.log("\nNo CPU-time numbers captured automatically -- read them from the Cloudflare dashboard");
    console.log("(Workers & Pages -> mail-mcp-spike -> Metrics -> CPU time) or inspect the raw capture file.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

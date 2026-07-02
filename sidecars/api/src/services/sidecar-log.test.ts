import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  appendSidecarLog,
  createSidecarLogger,
  redactLogValue,
  sidecarLogFile,
  type SidecarLogEntry
} from "./sidecar-log";

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length) {
    const dir = tempDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
  delete process.env.MINERADIO_SIDECAR_LOG_FILE;
});

async function tempLogPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mineradio-sidecar-log-"));
  tempDirs.push(dir);
  return join(dir, "sidecar-runtime.log");
}

async function readLines(path: string): Promise<SidecarLogEntry[]> {
  const text = await readFile(path, "utf8");
  return text.trim().split("\n").map((line: string) => JSON.parse(line) as SidecarLogEntry);
}

test("sidecarLogFile reads MINERADIO_SIDECAR_LOG_FILE and ignores blanks", () => {
  delete process.env.MINERADIO_SIDECAR_LOG_FILE;
  expect(sidecarLogFile()).toBe(null);
  process.env.MINERADIO_SIDECAR_LOG_FILE = "   ";
  expect(sidecarLogFile()).toBe(null);
  process.env.MINERADIO_SIDECAR_LOG_FILE = "/tmp/sidecar-runtime.log";
  expect(sidecarLogFile()).toBe("/tmp/sidecar-runtime.log");
});

test("redactLogValue removes cookie and auth fields recursively without changing safe metadata", () => {
  const redacted = redactLogValue({
    route: "/providers/qq/session-cookie",
    cookie: "uin=1; qqmusic_key=secret",
    headers: {
      authorization: "Bearer secret",
      "x-safe": "ok"
    },
    nested: {
      MUSIC_U: "secret",
      message: "qqmusic_key=secret should not leak",
      list: [{ wxskey: "secret" }, "safe"]
    }
  });
  const serialized = JSON.stringify(redacted);
  expect(serialized).not.toContain("qqmusic_key");
  expect(serialized).not.toContain("MUSIC_U");
  expect(serialized).not.toContain("wxskey");
  expect(serialized).not.toContain("Bearer secret");
  expect(serialized).not.toContain("secret should not leak");
  expect(serialized).toContain("x-safe");
  expect(serialized).toContain("ok");
});

test("redactLogValue removes token-like values in strings without changing safe paths", () => {
  expect(redactLogValue("/tmp/mineradio/logs/sidecar-runtime.log")).toBe(
    "/tmp/mineradio/logs/sidecar-runtime.log"
  );
  expect(redactLogValue("/tmp/access_token=secret/sidecar-runtime.log")).toBe("[redacted]");
  expect(redactLogValue("/tmp/auth_token:secret/sidecar-runtime.log")).toBe("[redacted]");
  expect(redactLogValue("provider failed with token=secret")).toBe("[redacted]");
});

test("appendSidecarLog writes bounded JSONL entries and creates the parent directory", async () => {
  const path = await tempLogPath();
  await appendSidecarLog(path, { event: "startup", port: 1234 }, { now: () => "2026-06-29T00:00:00.000Z" });
  await appendSidecarLog(path, { event: "request", method: "GET", path: "/health", status: 200 }, { now: () => "2026-06-29T00:00:01.000Z" });
  const lines = await readLines(path);
  expect(lines.length).toBe(2);
  expect(lines[0]).toEqual({ ts: "2026-06-29T00:00:00.000Z", event: "startup", port: 1234 });
  expect(lines[1].path).toBe("/health");
});

test("appendSidecarLog trims old data when maxBytes is exceeded", async () => {
  const path = await tempLogPath();
  for (let i = 0; i < 20; i++) {
    await appendSidecarLog(path, { event: "request", index: i, payload: "x".repeat(30) }, {
      maxBytes: 360,
      now: () => `2026-06-29T00:00:${String(i).padStart(2, "0")}.000Z`
    });
  }
  const info = await stat(path);
  expect(info.size).toBeLessThanOrEqual(360);
  const lines = await readLines(path);
  expect(lines.length).toBeGreaterThan(0);
  expect(lines[0].index).toBeGreaterThan(0);
  expect(lines.at(-1)?.index).toBe(19);
});

test("createSidecarLogger is a no-op without log file and writes sanitized events with one configured", async () => {
  const noop = createSidecarLogger({ filePath: null, now: () => "2026-06-29T00:00:00.000Z" });
  await noop.log({ event: "request", cookie: "qqmusic_key=secret" });

  const path = await tempLogPath();
  const logger = createSidecarLogger({ filePath: path, now: () => "2026-06-29T00:00:00.000Z" });
  await logger.log({ event: "request", path: "/providers/qq/session-cookie", cookie: "qqmusic_key=secret" });
  await logger.flush?.();
  const text = await readFile(path, "utf8");
  expect(text).toContain("/providers/qq/session-cookie");
  expect(text).not.toContain("qqmusic_key");
  expect(text).not.toContain("secret");
});

test("createSidecarLogger batches entries off the request path until flushed", async () => {
  const path = await tempLogPath();
  const logger = createSidecarLogger({
    filePath: path,
    flushDelayMs: 1000,
    now: () => "2026-06-29T00:00:00.000Z"
  });

  await logger.log({ event: "request", index: 1 });
  await logger.log({ event: "request", index: 2 });
  let existsBeforeFlush = true;
  try {
    await readFile(path, "utf8");
  } catch {
    existsBeforeFlush = false;
  }
  expect(existsBeforeFlush).toBe(false);

  await logger.flush?.();

  const lines = await readLines(path);
  expect(lines.map((line) => line.index)).toEqual([1, 2]);
});

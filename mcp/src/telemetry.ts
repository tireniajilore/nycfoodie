// Telemetry for the nycfoodie MCP server.
//
// Two channels:
//  - Call log: one JSON line per tool call (tool name, args, duration,
//    success/error, result size). Never throws — telemetry must not break
//    serving.
//  - Feedback table: structured rows from the submit_feedback tool.

import { appendFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import type { Database } from "better-sqlite3";

export interface CallEntry {
  ts: string;
  tool: string;
  args: unknown;
  duration_ms: number;
  ok: boolean;
  error?: string;
  result_bytes?: number;
}

export type CallLogger = (entry: CallEntry) => void;

export function createCallLogger(path: string): CallLogger {
  return (entry: CallEntry) => {
    try {
      appendFileSync(path, JSON.stringify(entry) + "\n");
    } catch {
      // Telemetry failure is silent by design.
    }
  };
}

export interface FeedbackInput {
  tool_name?: string;
  rating?: number;
  comment?: string;
}

/**
 * Anonymised client fingerprint: SHA-256 of "ip|user-agent", truncated to
 * 16 hex chars. Distinct clients can be counted; the value cannot be
 * reversed into an IP or device string.
 */
export function hashClient(ip: string, userAgent: string): string {
  return createHash("sha256").update(`${ip}|${userAgent}`).digest("hex").slice(0, 16);
}

export interface UsageEntry {
  ts: string;
  tool: string;
  city: string | null;
  clientHash: string | null;
  latencyMs: number;
  ok: boolean;
}

/**
 * Insert one usage row. Never throws — telemetry must not break serving.
 */
export function recordUsage(db: Database, entry: UsageEntry): void {
  try {
    db.prepare(
      `INSERT INTO usage_log (ts, tool, city, client_hash, latency_ms, ok)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      entry.ts,
      entry.tool,
      entry.city,
      entry.clientHash,
      entry.latencyMs,
      entry.ok ? 1 : 0
    );
  } catch {
    // Telemetry failure is silent by design.
  }
}

/** Insert a feedback row; throws on invalid input (caller reports it). */
export function saveFeedback(db: Database, input: FeedbackInput): string {
  const rating = input.rating ?? null;
  const comment = input.comment?.trim() || null;
  if (rating === null && comment === null) {
    throw new Error("Provide at least one of rating or comment.");
  }
  if (rating !== null && (!Number.isInteger(rating) || rating < 1 || rating > 5)) {
    throw new Error("rating must be an integer from 1 to 5.");
  }
  const id = randomUUID();
  const ts = new Date().toISOString();
  const toolName = input.tool_name?.trim() || null;
  db.prepare(
    `INSERT INTO feedback (id, created_at, tool_name, rating, comment)
     VALUES (?, ?, ?, ?, ?)`
  ).run(id, ts, toolName, rating, comment);
  // Structured trail on stderr (stdout is the JSON-RPC channel in stdio mode;
  // Railway captures stderr in deploy logs). Second sink independent of the DB.
  process.stderr.write(
    JSON.stringify({ event: "feedback", id, ts, tool_name: toolName, rating, comment }) + "\n"
  );
  return id;
}

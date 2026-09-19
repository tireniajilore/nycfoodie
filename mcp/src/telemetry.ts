// Telemetry for the nycfoodie MCP server.
//
// Two channels:
//  - Call log: one JSON line per tool call (tool name, args, duration,
//    success/error, result size). Never throws — telemetry must not break
//    serving.
//  - Feedback table: structured rows from the submit_feedback tool.

import { appendFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
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

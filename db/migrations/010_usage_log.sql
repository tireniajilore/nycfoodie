-- 010_usage_log.sql: privacy-respecting usage analytics.
--
-- One row per MCP tool call: timestamp, tool name, the coarse city param,
-- an anonymised client fingerprint (truncated SHA-256 of IP + user agent),
-- latency and success. Deliberately stores NO query arguments, NO raw IPs
-- and NO user agents: enough to answer "how many people, when, which tools"
-- without retaining what anyone asked about.
CREATE TABLE IF NOT EXISTS usage_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  tool TEXT NOT NULL,
  city TEXT,
  client_hash TEXT,
  latency_ms INTEGER,
  ok INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_usage_log_ts ON usage_log (ts);
CREATE INDEX IF NOT EXISTS idx_usage_log_tool_ts ON usage_log (tool, ts);

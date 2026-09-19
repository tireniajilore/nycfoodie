-- 006_feedback.sql
--
-- User/agent feedback on tool results. Written by the MCP server's
-- submit_feedback tool; read back for quality review. At least one of
-- rating or comment is required.

CREATE TABLE IF NOT EXISTS feedback (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  tool_name TEXT,
  rating INTEGER CHECK (rating BETWEEN 1 AND 5),
  comment TEXT,
  CHECK (rating IS NOT NULL OR comment IS NOT NULL)
);

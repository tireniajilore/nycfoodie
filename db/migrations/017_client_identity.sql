-- 017_client_identity.sql: client software identity on usage_log.
--
-- client_name / client_version come from the MCP initialize handshake's
-- clientInfo (e.g. "claude-code" / "2.1.0") — the client telling us what
-- software it is. user_agent is the HTTP User-Agent with parenthesised
-- platform details stripped ("Mozilla/5.0 (Windows NT 10.0; Win64; x64)"
-- becomes "Mozilla/5.0"), stored only when it carries no more identifying
-- info than the self-reported name/version; NULL otherwise.
--
-- All three are NULL for rows recorded before this migration, for
-- transports without a handshake (stdio), and when the client sends no
-- usable identity. Privacy posture unchanged: no raw IPs, no query
-- arguments, 180-day pruning (server.ts).
ALTER TABLE usage_log ADD COLUMN client_name TEXT;
ALTER TABLE usage_log ADD COLUMN client_version TEXT;
ALTER TABLE usage_log ADD COLUMN user_agent TEXT;

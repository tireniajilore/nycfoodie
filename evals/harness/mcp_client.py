#!/usr/bin/env python3
"""Minimal MCP-over-Streamable-HTTP client for the NYC Foodie eval agent.

The eval agent never touches chat MCP tooling. Every server interaction goes
through this script, and every request/response is logged as JSONL so any
claim in findings.json can be reproduced by re-running the stored envelope.

Transport note: this VM's egress goes through an HTTP(S) proxy that drops
Python-urllib tunneled requests to the Railway edge, while curl succeeds.
Therefore the transport below shells out to the system `curl` binary with an
argument list (no shell), which is proven to work in this environment.

Usage:
    python3 mcp_client.py init
    python3 mcp_client.py tools
    python3 mcp_client.py call --name search_restaurants --args '{"query":"cookies"}' --id f-001
    python3 mcp_client.py suite --file regression.json --out results.json

Suite files are JSON lists of:
    {"id": "f-001", "tool": "search_restaurants", "args": {...}}

Results are JSON lists of:
    {"id": ..., "envelope": {...}, "response": {...} or {"error": ...}}
"""

import argparse
import json
import os
import subprocess
import sys
import tempfile

BASE_URL = os.environ.get("NYCFOODIE_URL", "https://nycfoodie-production.up.railway.app")
HERE = os.path.dirname(os.path.abspath(__file__))
EVALS_DIR = os.path.dirname(HERE)
SESSION_FILE = os.path.join(EVALS_DIR, ".session")
CALL_LOG = os.path.join(EVALS_DIR, "rounds", "calls.jsonl")
PROTOCOL_VERSION = "2025-06-18"
TIMEOUT = 30


def curl_post(payload, session_id=None):
    """POST payload (dict or None) via curl. Returns (resp_headers, body, error)."""
    body_file = tempfile.NamedTemporaryFile(delete=False)
    body_path = body_file.name
    body_file.close()
    head_file = tempfile.NamedTemporaryFile(delete=False)
    head_path = head_file.name
    head_file.close()
    try:
        cmd = [
            "curl", "-s", "-S", "--max-time", str(TIMEOUT),
            "-D", head_path, "-o", body_path,
            "-w", "%{http_code}",
            "-X", "POST", BASE_URL + "/mcp",
            "-H", "Content-Type: application/json",
            "-H", "Accept: application/json, text/event-stream",
        ]
        if session_id:
            cmd += ["-H", "Mcp-Session-Id: " + session_id]
        if payload is not None:
            data_path = body_path + ".req"
            with open(data_path, "w") as f:
                json.dump(payload, f)
            cmd += ["--data", "@" + data_path]
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=TIMEOUT + 10)
        http_code = proc.stdout.strip()
        with open(head_path) as f:
            headers = f.read()
        with open(body_path) as f:
            body = f.read()
        if proc.returncode != 0:
            return headers, body, {"curl_exit": proc.returncode,
                                   "stderr": proc.stderr[:300], "http_code": http_code}
        return headers, body, None
    finally:
        for p in (body_path, head_path, body_path + ".req"):
            try:
                os.unlink(p)
            except OSError:
                pass


def session_id_from_headers(headers):
    for line in headers.splitlines():
        if line.lower().startswith("mcp-session-id:"):
            return line.split(":", 1)[1].strip()
    return None


def parse_sse(body):
    """Extract the first JSON-RPC message from an SSE stream (or plain JSON)."""
    body = body.strip()
    if body.startswith("{") or body.startswith("["):
        return json.loads(body)
    for line in body.splitlines():
        line = line.strip()
        if line.startswith("data:"):
            data = line[len("data:"):].strip()
            if data and data != "[DONE]":
                return json.loads(data)
    raise ValueError("no JSON-RPC message in SSE body: " + body[:200])


def init_session():
    payload = {
        "jsonrpc": "2.0",
        "id": "init",
        "method": "initialize",
        "params": {
            "protocolVersion": PROTOCOL_VERSION,
            "capabilities": {},
            "clientInfo": {"name": "nycfoodie-eval", "version": "1.0"},
        },
    }
    headers, body, err = curl_post(payload)
    if err:
        raise RuntimeError("initialize transport failed: %r" % err)
    msg = parse_sse(body)
    if "error" in msg:
        raise RuntimeError("initialize error: %s" % json.dumps(msg["error"])[:300])
    session_id = session_id_from_headers(headers)
    if not session_id:
        # Server is stateless: no session id issued. Record that and skip
        # the Mcp-Session-Id header on later calls (curl_post does this when
        # the session value is empty).
        session_id = ""
    with open(SESSION_FILE, "w") as f:
        f.write(session_id)
    # required per spec after initialize
    curl_post({"jsonrpc": "2.0", "method": "notifications/initialized"}, session_id=session_id)
    print(json.dumps({"session_id": session_id, "server": msg["result"].get("serverInfo")}))
    return session_id


def load_session():
    with open(SESSION_FILE) as f:
        return f.read().strip()


def log_call(envelope, response):
    with open(CALL_LOG, "a") as f:
        f.write(json.dumps({"envelope": envelope, "response": response}) + "\n")


def rpc(method, params, call_id, session_id, log=True):
    envelope = {"jsonrpc": "2.0", "id": call_id, "method": method, "params": params}
    headers, body, transport_err = curl_post(envelope, session_id=session_id)
    if transport_err:
        resp = {"transport_error": transport_err, "body": body[:500]}
        if log:
            log_call(envelope, resp)
        return resp
    try:
        msg = parse_sse(body)
    except Exception as e:
        resp = {"parse_error": str(e), "body": body[:500]}
        if log:
            log_call(envelope, resp)
        return resp
    if log:
        log_call(envelope, msg)
    return msg


def list_tools(session_id):
    msg = rpc("tools/list", {}, "list-tools", session_id)
    if "result" in msg:
        return [t["name"] for t in msg["result"].get("tools", [])], msg["result"]
    raise RuntimeError("tools/list failed: %s" % json.dumps(msg)[:500])


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("init")
    sub.add_parser("tools")
    c = sub.add_parser("call")
    c.add_argument("--name", required=True)
    c.add_argument("--args", default="{}")
    c.add_argument("--id", default="adhoc")
    s = sub.add_parser("suite")
    s.add_argument("--file", required=True)
    s.add_argument("--out", required=True)
    s.add_argument("--tag", default="")
    args = ap.parse_args()

    if args.cmd == "init":
        init_session()
        return

    session_id = load_session()

    if args.cmd == "tools":
        names, full = list_tools(session_id)
        out_path = os.path.join(EVALS_DIR, "metrics", "tool_catalog.json")
        with open(out_path, "w") as f:
            json.dump(full, f, indent=2)
        print(json.dumps({"tools": names, "catalog": out_path}))
        return

    if args.cmd == "call":
        tool_args = json.loads(args.args)
        msg = rpc("tools/call", {"name": args.name, "arguments": tool_args}, args.id, session_id)
        print(json.dumps(msg, indent=2)[:20000])
        return

    if args.cmd == "suite":
        with open(args.file) as f:
            items = json.load(f)
        results = []
        for item in items:
            call_id = args.tag + item["id"] if args.tag else item["id"]
            msg = rpc("tools/call",
                      {"name": item["tool"], "arguments": item.get("args", {})},
                      call_id, session_id)
            results.append({"id": item["id"], "envelope": {
                "jsonrpc": "2.0", "id": call_id, "method": "tools/call",
                "params": {"name": item["tool"], "arguments": item.get("args", {})}},
                "response": msg})
            status = "ERR" if ("error" in msg or "transport_error" in msg or "parse_error" in msg) else "ok"
            print("%s %s" % (status, call_id), flush=True)
        with open(args.out, "w") as f:
            json.dump(results, f, indent=2)
        print("wrote %s" % args.out)


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""MCP server for Snack Approval.

Speaks MCP over stdio (JSON-RPC 2.0) so an assistant can file snack requests,
read the all-time board, and — if it is the approver's session — rule on it.

    ./snack_mcp.py            run the server (a client normally starts this)
    ./snack_mcp.py --selftest exercise every tool locally and print the results

Two tools reach a real human: snack_request DMs the approver, and snack_rule
DMs the requester. Both say so in their descriptions so a client can prompt.

Standard library only. Nothing is written to stdout except protocol frames;
diagnostics go to stderr.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
import traceback

import snackapi as api

PROTOCOL = "2025-06-18"
SERVER = {"name": "snack-approval", "version": "3.0.0", "title": "Snack Approval"}

_client: api.Client | None = None
_cache: dict = {"rows": None, "at": 0.0}
CACHE_TTL = 5.0


def client() -> api.Client:
    global _client
    if _client is None:
        _client = api.Client()
    return _client


def rows(fresh: bool = False) -> list[dict]:
    if fresh or _cache["rows"] is None or time.time() - _cache["at"] > CACHE_TTL:
        _cache["rows"] = client().fetch_all()
        _cache["at"] = time.time()
    return _cache["rows"]


def log(msg: str) -> None:
    print(f"[snack-mcp] {msg}", file=sys.stderr, flush=True)


# --------------------------------------------------------------------------
# tools
# --------------------------------------------------------------------------

def t_whoami(_args: dict) -> str:
    me = client().me()
    p = api.player_stats(rows(), str(me.get("email") or "").lower())
    lines = [
        f"{me.get('fullName')} <{me.get('email')}>",
        f"team: {me.get('team') or 'unknown'}   slack: {me.get('slackId') or 'unknown'}",
        f"level {p['level']} {p['rank']} — {p['xp']} XP ({p['into']}/{p['need']} to next)",
        f"approved {p['approved']}   denied {p['denied']}   waiting {p['pending']}"
        f"   streak {p['streak']}   yes rate {p['rate']}%",
        f"usual order: {p['favourite'][0] + ' x' + str(p['favourite'][1]) if p['favourite'] else 'nothing yet'}",
        "",
        f"can rule on requests: {'yes' if client().is_god(me) else 'no'}"
        f" (only {api.APPROVER['name']} can)",
    ]
    return "\n".join(lines)


def t_request(args: dict) -> str:
    out = api.file_request(
        client(),
        args.get("snack", ""),
        args.get("where", "") or "",
        (args.get("portion") or "NORMAL").upper(),
        args.get("case", "") or "",
        notify=args.get("notify", True),
    )
    _cache["rows"] = None
    rec = out["record"]
    return (f"{out['notice']}\n"
            f"id: {rec.get('id')}\n"
            f"snack: {rec.get('snack')} ({rec.get('category')})\n"
            f"portion: {rec.get('size')}   from: {rec.get('where') or 'not stated'}\n"
            f"status: pending — {api.APPROVER['name']} decides\n"
            f"xp: +{out['xp']} so far, +{api.XP['APPROVED']} more if approved")


def t_feed(args: dict) -> str:
    want = (args.get("filter") or "all").lower()
    query = (args.get("query") or "").lower()
    limit = max(1, min(int(args.get("limit") or 20), 200))
    data = rows()
    me_key = str(client().me().get("email") or "").lower()

    if want == "mine":
        data = [r for r in data if api.identity_key(r) == me_key]
    elif want in ("pending", "approved", "denied"):
        data = [r for r in data if r.get("status") == want]
    if query:
        data = [r for r in data if any(
            query in str(r.get(f) or "").lower()
            for f in ("snack", "requester_name", "verdict_note", "plea", "where", "category"))]

    if not data:
        return "No requests match."

    out = [f"{len(data)} matching request(s), newest first"
           + (f" (showing {limit})" if len(data) > limit else "")]
    for r in data[:limit]:
        label, _ = api.VERDICTS.get(r.get("status"), api.VERDICTS["pending"])
        line = (f"- {r.get('snack')} — {label.lower()} — {r.get('requester_name')}"
                f" — {api.ago(r.get('created_at'))}")
        if r.get("status") != "pending":
            note = (r.get("verdict_note")
                    or ("no conditions" if r["status"] == "approved" else "no reason given"))
            line += f' — "{note}"'
            took = api.wait_seconds(r)
            if took:
                line += f" (ruled in {api.dur(took)})"
        elif r.get("plea"):
            line += f' — their case: "{r["plea"]}"'
        out.append(line)
    return "\n".join(out)


def t_board(args: dict) -> str:
    by = (args.get("by") or "xp").lower()
    if by not in api.SORTS:
        by = "xp"
    board = api.leaderboard(rows(), by)
    if not board:
        return "Nobody has asked for anything yet."
    label, _ = api.SORTS[by]
    me_key = str(client().me().get("email") or "").lower()
    out = [f"All-time board, ranked by {label.lower()} — "
           f"{len(board)} people, {len(rows())} requests",
           "  #  name                      lvl     xp   yes   no  rate  usual"]
    for i, p in enumerate(board):
        rate = f"{p['rate']}%" if p["decided"] >= 3 else "-"
        mark = " <- you" if p["key"] == me_key else ""
        out.append(f"{i + 1:3d}  {p['name'][:24]:24s}  {p['level']:3d}  {p['xp']:5d}"
                   f"  {p['approved']:4d} {p['denied']:4d} {rate:>5s}  {p['usual'][:18]}{mark}")
    return "\n".join(out)


def t_stats(_args: dict) -> str:
    st = api.office_stats(rows())
    if not st["total"]:
        return "No requests yet."
    hours = ", ".join(f"{h:02d}:00 x{n}" for h, n in
                      sorted(enumerate(st["by_hour"]), key=lambda kv: -kv[1])[:5] if n)
    out = [
        f"requests ever   {st['total']}",
        f"people          {st['people']}",
        f"approved        {st['approved']}",
        f"denied          {st['denied']}",
        f"yes rate        {st['rate']}%",
        f"waiting         {st['pending']}",
        f"median ruling   {api.dur(st['median_wait'])}",
        f"longest wait    {api.dur(st['slowest'])}",
        f"filed today     {st['today']}",
        f"busiest hours   {hours or 'n/a'}",
        "",
        "most requested: " + ", ".join(f"{s['label']} x{s['n']}" for s in st["top_snacks"]),
        "categories: " + ", ".join(f"{c} x{n}" for c, n in st["categories"]),
    ]
    if st["oldest_pending"]:
        o = st["oldest_pending"]
        out.append(f"longest current wait: {o.get('snack')} for {o.get('requester_name')}"
                   f" ({api.ago(o.get('created_at'))})")
    if st["last_ruling"]:
        out.append(f"last ruling: {api.ago(st['last_ruling'].get('decided_at'))}")
    return "\n".join(out)


def t_pending(_args: dict) -> str:
    queue = [r for r in rows(fresh=True) if r.get("status") == "pending"]
    if not queue:
        return "Nothing waiting. The kitchen is calm."
    out = [f"{len(queue)} waiting on {api.APPROVER['name']} (ids are for snack_rule)"]
    for r in queue:
        line = (f"- {r['id']}  {r.get('snack')} — {r.get('requester_name')}"
                f" — asked {api.ago(r.get('created_at'))}")
        if r.get("plea"):
            line += f' — "{r["plea"]}"'
        out.append(line)
    return "\n".join(out)


def t_rule(args: dict) -> str:
    verdict = (args.get("verdict") or "").lower()
    if verdict in ("approve", "yes", "approved"):
        verdict = "approved"
    elif verdict in ("deny", "no", "denied"):
        verdict = "denied"
    out = api.rule_on(client(), args.get("id", ""), verdict, args.get("reason", "") or "")
    _cache["rows"] = None
    rec = out["record"]
    return (f"{out['notice']}\n"
            f"{rec.get('snack')} for {rec.get('requester_name')} is now {verdict}.")


def t_visits(args: dict) -> str:
    if not client().is_owner():
        raise api.SnackError(
            f"The visit log belongs to {api.OWNER['name'] or 'the site owner'}. "
            f"You are signed in as {client().me().get('email', 'unknown')}.")
    hours = max(1, min(int(args.get("hours") or 24), 24 * 90))
    rows = client().fetch_all("visits", page=200)
    if not rows:
        return "No visits logged yet."

    cutoff = time.time() - hours * 3600
    def when(r):
        t = api.parse_time(r.get("at") or r.get("created_at"))
        return t.timestamp() if t else 0
    window = [r for r in rows if when(r) >= cutoff]

    by_person: dict = {}
    for r in window:
        k = r.get("email") or "unknown"
        slot = by_person.setdefault(k, {"name": r.get("name") or k, "n": 0,
                                        "pages": set(), "last": r.get("at")})
        slot["n"] += 1
        slot["pages"].add(r.get("page") or "?")
        if str(r.get("at") or "") > str(slot["last"] or ""):
            slot["last"] = r.get("at")

    pages: dict = {}
    for r in window:
        pages[r.get("page") or "?"] = pages.get(r.get("page") or "?", 0) + 1

    live = [r for r in rows if when(r) > time.time() - 900]
    out = [f"{len(window)} page views in the last {hours}h from {len(by_person)} people "
           f"({len(rows)} views logged all time)."]
    if live:
        out.append("On the site in the last 15 minutes: "
                   + ", ".join(sorted({r.get("name") or r.get("email") for r in live})))
    out.append("")
    for p in sorted(by_person.values(), key=lambda p: -p["n"]):
        out.append(f"- {p['name']}: {p['n']} views, last {api.ago(p['last'])}, "
                   f"pages: {', '.join(sorted(p['pages']))}")
    out.append("")
    out.append("pages: " + ", ".join(f"{k} x{v}" for k, v in
                                     sorted(pages.items(), key=lambda kv: -kv[1])))
    return "\n".join(out)


def t_reasons(_args: dict) -> str:
    return ("Canned approval reasons:\n- " + "\n- ".join(api.YES_REASONS) +
            "\n\nCanned denial reasons:\n- " + "\n- ".join(api.NO_REASONS) +
            "\n\nSuggested pleas for a requester:\n- " + "\n- ".join(api.PLEAS))


READ = {"readOnlyHint": True, "openWorldHint": True}
WRITE = {"readOnlyHint": False, "destructiveHint": False, "idempotentHint": False,
         "openWorldHint": True}

TOOLS = [
    {
        "name": "snack_whoami",
        "title": "Who am I",
        "description": "Identity of the signed-in person plus their snack record: level, "
                       "rank, XP, approvals, denials, streak, and whether they are allowed "
                       f"to rule on requests (only {api.APPROVER['name']} is).",
        "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False},
        "annotations": READ,
        "handler": t_whoami,
    },
    {
        "name": "snack_request",
        "title": "File a snack request",
        "description": "File a request to eat or drink something. WRITES to the shared "
                       f"database and sends {api.APPROVER['name']} a Slack DM for a ruling — "
                       f"a real person is messaged, so confirm with the user before calling. "
                       "Only `snack` is required; it is free text and is categorised "
                       "automatically.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "snack": {"type": "string", "maxLength": 90,
                          "description": "What you want, e.g. 'flat white' or 'two cookies'"},
                "where": {"type": "string", "maxLength": 60,
                          "description": "Optional: where it came from, e.g. 'kitchen'"},
                "portion": {"type": "string", "enum": api.PORTIONS,
                            "description": "Optional portion size. Default NORMAL."},
                "case": {"type": "string", "maxLength": 280,
                         "description": "Optional plea. Worth +3 XP."},
                "notify": {"type": "boolean",
                           "description": "Send the Slack DM. Default true. False files "
                                          "silently, which nobody will ever rule on."},
            },
            "required": ["snack"],
            "additionalProperties": False,
        },
        "annotations": WRITE,
        "handler": t_request,
    },
    {
        "name": "snack_feed",
        "title": "Read the request log",
        "description": "Every snack request ever filed, newest first, with optional status "
                       "filter and text search across snack, person, reason, and plea.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "filter": {"type": "string",
                           "enum": ["all", "pending", "approved", "denied", "mine"]},
                "query": {"type": "string", "description": "Free-text search"},
                "limit": {"type": "integer", "minimum": 1, "maximum": 200, "default": 20},
            },
            "additionalProperties": False,
        },
        "annotations": READ,
        "handler": t_feed,
    },
    {
        "name": "snack_board",
        "title": "All-time leaderboard",
        "description": "Everyone who has ever filed a request, ranked. Sort by xp, "
                       "approvals, requests, rate (yes rate, needs 3+ rulings), or denied "
                       "(most denied first).",
        "inputSchema": {
            "type": "object",
            "properties": {"by": {"type": "string", "enum": list(api.SORTS)}},
            "additionalProperties": False,
        },
        "annotations": READ,
        "handler": t_board,
    },
    {
        "name": "snack_stats",
        "title": "Office snack stats",
        "description": "Totals, yes rate, ruling times, busiest hours, most requested "
                       "snacks, category mix, and the longest wait right now.",
        "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False},
        "annotations": READ,
        "handler": t_stats,
    },
    {
        "name": "snack_pending",
        "title": "The queue",
        "description": "Requests waiting on a ruling, with their ids. Always fetches fresh. "
                       "Use this to get an id for snack_rule.",
        "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False},
        "annotations": READ,
        "handler": t_pending,
    },
    {
        "name": "snack_rule",
        "title": "Approve or deny a request",
        "description": f"Rule on a pending request. ONLY WORKS for {api.APPROVER['name']} — every "
                       "other session gets an error, including whoever built the app. "
                       "WRITES the verdict and DMs the requester on Slack, so confirm before "
                       "calling. Get ids from snack_pending.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "id": {"type": "string", "description": "Request id from snack_pending"},
                "verdict": {"type": "string", "enum": ["approved", "denied"]},
                "reason": {"type": "string", "maxLength": 140,
                           "description": "Optional. Shown in the feed and in the DM."},
            },
            "required": ["id", "verdict"],
            "additionalProperties": False,
        },
        "annotations": WRITE,
        "handler": t_rule,
    },
    {
        "name": "snack_visits",
        "title": "Who has been on the site",
        "description": f"Visit log: who opened which page and when, plus who is on the site "
                       f"right now. Owner only — works for "
                       f"{api.OWNER['name'] or 'the configured owner'} and errors for everyone "
                       f"else. People are told in the app that visits are logged.",
        "inputSchema": {
            "type": "object",
            "properties": {"hours": {"type": "integer", "minimum": 1, "maximum": 2160,
                                     "default": 24,
                                     "description": "How far back to look. Default 24."}},
            "additionalProperties": False,
        },
        "annotations": READ,
        "handler": t_visits,
    },
    {
        "name": "snack_reasons",
        "title": "Canned lines",
        "description": "The canned approval reasons, denial reasons, and suggested pleas the "
                       "web app offers, for when you want to sound like the house style.",
        "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False},
        "annotations": READ,
        "handler": t_reasons,
    },
]

BY_NAME = {t["name"]: t for t in TOOLS}


def tool_list() -> list[dict]:
    return [{k: v for k, v in t.items() if k != "handler"} for t in TOOLS]


# --------------------------------------------------------------------------
# JSON-RPC plumbing
# --------------------------------------------------------------------------

def result(req_id, payload) -> dict:
    return {"jsonrpc": "2.0", "id": req_id, "result": payload}


def error(req_id, code: int, message: str) -> dict:
    return {"jsonrpc": "2.0", "id": req_id, "error": {"code": code, "message": message}}


def text_result(text: str, is_error: bool = False) -> dict:
    out = {"content": [{"type": "text", "text": text}]}
    if is_error:
        out["isError"] = True
    return out


def call_tool(params: dict) -> dict:
    name = params.get("name")
    args = params.get("arguments") or {}
    tool = BY_NAME.get(name)
    if not tool:
        return text_result(f"No tool named {name!r}. Available: "
                           f"{', '.join(BY_NAME)}", is_error=True)
    try:
        return text_result(tool["handler"](args))
    except api.SnackError as e:
        return text_result(str(e), is_error=True)
    except Exception as e:  # noqa: BLE001 - a tool must not kill the server
        log("tool crashed:\n" + traceback.format_exc())
        return text_result(f"{type(e).__name__}: {e}", is_error=True)


def handle(msg: dict):
    method = msg.get("method")
    req_id = msg.get("id")
    params = msg.get("params") or {}

    if method == "initialize":
        asked = params.get("protocolVersion")
        return result(req_id, {
            "protocolVersion": asked if isinstance(asked, str) and asked else PROTOCOL,
            "capabilities": {"tools": {"listChanged": False}},
            "serverInfo": SERVER,
            "instructions": (
                "Snack requests for a Shopify office. Anyone can file a request with "
                f"snack_request, which DMs {api.APPROVER['name']} on Slack. Only they can call "
                "snack_rule; everyone else gets an error by design. Confirm with the user "
                "before either write, because both message a real person."
            ),
        })

    if method in ("notifications/initialized", "notifications/cancelled",
                  "notifications/roots/list_changed"):
        return None                      # notifications get no reply

    if method == "ping":
        return result(req_id, {})
    if method == "tools/list":
        return result(req_id, {"tools": tool_list()})
    if method == "tools/call":
        return result(req_id, call_tool(params))
    if method in ("resources/list", "prompts/list"):
        key = method.split("/")[0]
        return result(req_id, {key: []})

    if req_id is None:
        return None
    return error(req_id, -32601, f"Method not found: {method}")


def serve() -> int:
    log(f"ready on stdio, {len(TOOLS)} tools, site {api.SITE}")
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError as e:
            print(json.dumps(error(None, -32700, f"Parse error: {e}")), flush=True)
            continue
        try:
            out = handle(msg)
        except Exception as e:  # noqa: BLE001
            log("handler crashed:\n" + traceback.format_exc())
            out = error(msg.get("id"), -32603, f"Internal error: {e}")
        if out is not None:
            print(json.dumps(out), flush=True)
    log("stdin closed, exiting")
    return 0


def selftest() -> int:
    """Exercise every read tool plus the protocol handshake. No writes."""
    ok = True
    print("handshake")
    init = handle({"jsonrpc": "2.0", "id": 1, "method": "initialize",
                   "params": {"protocolVersion": PROTOCOL, "capabilities": {},
                              "clientInfo": {"name": "selftest", "version": "0"}}})
    print("  protocolVersion:", init["result"]["protocolVersion"])
    print("  serverInfo:", init["result"]["serverInfo"])
    listed = handle({"jsonrpc": "2.0", "id": 2, "method": "tools/list"})["result"]["tools"]
    print(f"  tools: {len(listed)} -> {', '.join(t['name'] for t in listed)}")
    for t in listed:
        for field in ("name", "description", "inputSchema"):
            if not t.get(field):
                print(f"  MISSING {field} on {t.get('name')}")
                ok = False

    for name, args in [("snack_whoami", {}), ("snack_stats", {}), ("snack_pending", {}),
                       ("snack_board", {"by": "denied"}),
                       ("snack_feed", {"limit": 3, "filter": "mine"}),
                       ("snack_reasons", {})]:
        print(f"\n--- {name} {args or ''}")
        res = call_tool({"name": name, "arguments": args})
        body = res["content"][0]["text"]
        if res.get("isError"):
            ok = False
            print("  ERROR:", body)
        else:
            print("  " + "\n  ".join(body.splitlines()[:8]))

    print("\n--- guard rails")
    bad = call_tool({"name": "snack_nope", "arguments": {}})
    print("  unknown tool ->", "isError" if bad.get("isError") else "NOT FLAGGED")
    ok &= bool(bad.get("isError"))
    blank = call_tool({"name": "snack_request", "arguments": {"snack": "  "}})
    print("  empty snack ->", blank["content"][0]["text"])
    ok &= bool(blank.get("isError"))
    rule = call_tool({"name": "snack_rule",
                      "arguments": {"id": "does-not-exist", "verdict": "approved"}})
    print("  rule as non-authority ->", rule["content"][0]["text"].split(".")[0])
    ok &= bool(rule.get("isError"))
    unknown = handle({"jsonrpc": "2.0", "id": 9, "method": "does/not/exist"})
    print("  unknown method ->", unknown["error"]["code"])
    ok &= unknown["error"]["code"] == -32601

    print("\nSELFTEST", "PASS" if ok else "FAIL")
    return 0 if ok else 1


def main() -> int:
    ap = argparse.ArgumentParser(description="MCP server for Snack Approval.")
    ap.add_argument("--selftest", action="store_true",
                    help="exercise the protocol and every read-only tool, then exit")
    args = ap.parse_args()
    return selftest() if args.selftest else serve()


if __name__ == "__main__":
    sys.exit(main())

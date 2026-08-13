"""Shared client and scoring for the snack approval terminal tools.

Talks to the same host the web app is served from, read from snack.config.json.

Auth reuses the identity token the `quick` CLI already manages, so there is no
separate login: the token is shelled out once, cached in memory, and refreshed
if the host answers 401 or 403.

Scoring, ranks, categories, and stats mirror js/core.js. If you change one,
change the other, or the terminal and the browser will disagree about who is
winning.

Standard library only. No pip install.
"""

from __future__ import annotations

import json
import os
import pathlib
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import defaultdict
from datetime import datetime, timezone

class SnackError(RuntimeError):
    pass


# The approver's identity lives in snack.config.json beside this package, which
# is deliberately not in git: it holds a real person's email and Slack ID. The
# browser reads the same file. See snack.config.example.json.
CONFIG_PATH = pathlib.Path(
    os.environ.get("SNACK_CONFIG")
    or pathlib.Path(__file__).resolve().parent.parent / "snack.config.json"
)


# Importing this module must never explode: `snack demo` and the MCP tool list
# work with no config at all. Problems are recorded and raised on first use.
CONFIG_ERROR = ""


def _load_config() -> dict:
    global CONFIG_ERROR
    try:
        with open(CONFIG_PATH) as fh:
            return json.load(fh)
    except FileNotFoundError:
        CONFIG_ERROR = (f"No config at {CONFIG_PATH}. Copy "
                        f"snack.config.example.json to snack.config.json and "
                        f"fill in the approver.")
    except json.JSONDecodeError as e:
        CONFIG_ERROR = f"{CONFIG_PATH} is not valid JSON: {e}"
    return {}


_CFG = _load_config()

SITE = os.environ.get("SNACK_SITE") or _CFG.get("site") or "snack-approval"
BASE = os.environ.get("SNACK_BASE_URL") or _CFG.get("baseUrl") or ""
COLLECTION = _CFG.get("collection") or "snacks"
if not BASE and not CONFIG_ERROR:
    CONFIG_ERROR = f"{CONFIG_PATH} has no baseUrl, so there is nothing to talk to."

_appr = _CFG.get("approver") or {}
APPROVER = {
    "slack_id": _appr.get("slackId", ""),
    "email": str(_appr.get("email", "")).lower(),
    "name": _appr.get("name", "the approver"),
    "short": _appr.get("short") or _appr.get("name", "the approver"),
}
_own = _CFG.get("owner") or {}
OWNER = {"name": _own.get("name", ""), "email": str(_own.get("email", "")).lower()}

if not CONFIG_ERROR and (not APPROVER["slack_id"] or not APPROVER["email"]):
    CONFIG_ERROR = (f"{CONFIG_PATH} has no approver email or Slack ID, so "
                    f"nobody can be asked and nobody can rule.")


def require_config() -> None:
    if CONFIG_ERROR:
        raise SnackError(CONFIG_ERROR)

XP = {"LOG": 10, "APPROVED": 25, "DENIED": 5, "PHOTO": 5, "PLEA": 3, "PER_LEVEL": 100}

RANKS = [
    "CRUMB CLERK", "VENDING NOVICE", "PANTRY REGULAR", "SNACK ANALYST",
    "SENIOR SNACKER", "PANTRY PRINCIPAL", "SNACK ARCHITECT",
    "DIRECTOR OF SNACKS", "VP OF CHEWING", "SNACK LAUREATE",
]

PORTIONS = ["A NIBBLE", "NORMAL", "GENEROUS", "SECOND HELPING", "DO NOT ASK"]

VERDICTS = {
    "pending": ("PENDING", "*"),
    "approved": ("APPROVED", "+"),
    "denied": ("DENIED", "x"),
}

CATEGORY_RULES = [
    ("DRINK", ("coffee", "latte", "flat white", "cappuccino", "cortado", "macchiato",
               "mocha", "espresso", "americano", "decaf", "tea", "matcha", "juice",
               "smoothie", "soda", "coke", "pepsi", "kombucha", "sparkling", "water",
               "cold brew", "chai", "hot chocolate", "milkshake", "lemonade", "red bull",
               "celsius", "energy")),
    ("FRUIT", ("apple", "banana", "orange", "grape", "berry", "berries", "mango",
               "melon", "peach", "pear", "pineapple", "kiwi", "plum", "cherry",
               "clementine", "mandarin", "fruit")),
    ("SWEET", ("cookie", "brownie", "chocolate", "candy", "cake", "donut", "doughnut",
               "muffin", "ice cream", "gelato", "pastry", "croissant", "danish", "tart",
               "pie", "caramel", "toffee", "gummy", "gummies", "marshmallow", "sweet",
               "sugar", "kitkat", "snickers", "oreo", "maltesers", "timbit")),
    ("SAVOURY", ("chip", "chips", "crisps", "pretzel", "popcorn", "cracker", "nuts",
                 "almond", "cashew", "peanut", "jerky", "hummus", "olive", "pickle",
                 "seaweed", "wasabi", "doritos", "pringles", "takis", "salt")),
    ("DAIRY", ("yogurt", "yoghurt", "cheese", "milk", "kefir", "skyr", "cottage")),
    ("BAKED", ("bread", "bagel", "toast", "scone", "biscuit", "roll", "pizza",
               "focaccia", "sandwich", "wrap", "burrito", "empanada", "samosa")),
    ("PROTEIN", ("protein", "bar", "granola", "egg", "edamame", "tofu", "chicken",
                 "tuna", "shake", "oat")),
    ("FROZEN", ("popsicle", "freezie", "frozen", "sorbet")),
]

PLEAS = [
    "I skipped lunch. This is basically medicine.",
    "Standup ran long. I have earned this.",
    "It was already open. Waste is worse.",
    "My blood sugar is a team dependency.",
    "I fixed a flaky test. Pay me in sugar.",
    "This is the last one in the box. Someone has to.",
    "Deploy is green. Let me live.",
    "I am on call. Morale is infrastructure.",
]

YES_REASONS = ["You have earned it", "It is Friday", "Take two"]
NO_REASONS = ["Too much sugar", "Not before lunch", "Share with the team",
              "You had one already", "I was not offered any"]


# --------------------------------------------------------------------------
# transport
# --------------------------------------------------------------------------

class Client:
    def __init__(self, base: str = "", timeout: float = 20.0):
        require_config()
        self.base = (base or BASE).rstrip("/")
        self.timeout = timeout
        self._token: str | None = None
        self._me: dict | None = None

    # -- auth ------------------------------------------------------------

    def token(self, refresh: bool = False) -> str:
        if self._token and not refresh:
            return self._token
        try:
            out = subprocess.run(
                ["quick", "auth", "print-identity-token"],
                capture_output=True, text=True, timeout=90, check=True,
            )
        except FileNotFoundError:
            raise SnackError("`quick` is not on PATH. Install the Quick CLI (tec toolchain).")
        except subprocess.CalledProcessError as e:
            raise SnackError(f"quick auth failed: {(e.stderr or '').strip() or e}")
        except subprocess.TimeoutExpired:
            raise SnackError("quick auth timed out. Run `quick auth` once by hand.")
        self._token = out.stdout.strip()
        if not self._token:
            raise SnackError("quick auth returned an empty token. Run `quick auth`.")
        return self._token

    # -- http ------------------------------------------------------------

    def _raw(self, method: str, path: str, body=None, token: str | None = None):
        url = self.base + path
        data = None
        headers = {"Authorization": f"Bearer {token or self.token()}",
                   "Accept": "application/json"}
        if body is not None:
            data = json.dumps(body).encode()
            headers["Content-Type"] = "application/json"
        req = urllib.request.Request(url, data=data, headers=headers, method=method)
        with urllib.request.urlopen(req, timeout=self.timeout) as resp:
            raw = resp.read()
        if not raw:
            return None
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            # An HTML sign-in page means the token was not accepted.
            raise SnackError("Site returned non-JSON. Your IAP session may have expired.")

    def request(self, method: str, path: str, body=None):
        try:
            return self._raw(method, path, body)
        except urllib.error.HTTPError as e:
            if e.code in (401, 403):
                try:
                    return self._raw(method, path, body, token=self.token(refresh=True))
                except urllib.error.HTTPError as e2:
                    raise SnackError(f"{method} {path} failed: HTTP {e2.code} {e2.reason}")
            detail = ""
            try:
                detail = json.loads(e.read()).get("error", "")
            except Exception:
                pass
            raise SnackError(f"{method} {path} failed: HTTP {e.code} {e.reason} {detail}".strip())
        except urllib.error.URLError as e:
            raise SnackError(f"Cannot reach {self.base}: {e.reason}")

    # -- identity --------------------------------------------------------

    def me(self) -> dict:
        if self._me is None:
            self._me = self.request("GET", "/api/id/") or {}
        return self._me

    def is_owner(self, user: dict | None = None) -> bool:
        """Whoever runs the site. Can see the visit log; still cannot rule."""
        u = user if user is not None else self.me()
        if not OWNER["email"]:
            return False
        return str(u.get("email", "")).lower() == OWNER["email"]

    def is_god(self, user: dict | None = None) -> bool:
        u = user if user is not None else self.me()
        if not APPROVER["email"] and not APPROVER["slack_id"]:
            return False
        return (str(u.get("email", "")).lower() == APPROVER["email"]
                or str(u.get("slackId", "")) == APPROVER["slack_id"])

    # -- collections -----------------------------------------------------

    def fetch_all(self, collection: str = COLLECTION, page: int = 100) -> list[dict]:
        """Every row, newest first.

        Advances by rows actually returned rather than by the requested page
        size, so a server-side cap on `limit` cannot silently truncate history.
        """
        rows: list[dict] = []
        offset = 0
        while offset < 4000:
            q = urllib.parse.urlencode(
                {"orderBy": "created_at:desc", "limit": page, "offset": offset})
            got = self.request("GET", f"/api/db/{collection}?{q}") or []
            if not isinstance(got, list) or not got:
                break
            rows.extend(got)
            offset += len(got)
        seen, out = set(), []
        for r in rows:
            if r.get("id") and r["id"] not in seen:
                seen.add(r["id"])
                out.append(r)
        return out

    def create(self, collection: str, doc: dict) -> dict:
        return self.request("POST", f"/api/db/{collection}", doc) or {}

    def update(self, collection: str, doc_id: str, patch: dict) -> dict:
        # PUT, not PATCH: the Quick db API merges on PUT and answers 405 to PATCH.
        # Full replacement would need ?overwriteExisting=true, which we never want.
        return self.request("PUT", f"/api/db/{collection}/{doc_id}", patch) or {}

    def find_by_id(self, collection: str, doc_id: str) -> dict | None:
        try:
            return self.request("GET", f"/api/db/{collection}/{doc_id}")
        except SnackError:
            return None

    # -- slack (through the site's authenticated proxy) -------------------

    def slack_post(self, channel: str, text: str, blocks=None, thread_ts=None) -> dict:
        """Post as the site's Slack bot.

        The browser client does the same thing: the site proxies to Slack and
        substitutes `env:SLACK_BOT_TOKEN` server-side, so no token is handled
        here.
        """
        payload: dict = {"channel": channel, "text": text}
        if blocks:
            payload["blocks"] = blocks
        if thread_ts:
            payload["thread_ts"] = thread_ts
        res = self.request("POST", "/api/http/post", {
            "url": "https://slack.com/api/chat.postMessage",
            "headers": {"Authorization": "Bearer env:SLACK_BOT_TOKEN",
                        "Content-Type": "application/json"},
            "body": json.dumps(payload),
        }) or {}
        if not res.get("ok"):
            raise SnackError(f"Slack refused the message: {res.get('error', 'unknown')}")
        return res


# --------------------------------------------------------------------------
# domain helpers
# --------------------------------------------------------------------------

def categorise(snack: str) -> str:
    s = (snack or "").lower()
    for name, words in CATEGORY_RULES:
        if any(w in s for w in words):
            return name
    return "UNCLASSIFIED"


def identity_key(rec: dict) -> str:
    return str(rec.get("requester_email") or rec.get("requester_name") or "unknown").lower()


def score_one(rec: dict) -> int:
    xp = XP["LOG"]
    if rec.get("status") == "approved":
        xp += XP["APPROVED"]
    if rec.get("status") == "denied":
        xp += XP["DENIED"]
    if rec.get("photo_url"):
        xp += XP["PHOTO"]
    if rec.get("plea"):
        xp += XP["PLEA"]
    return xp


def level_of(xp: int) -> dict:
    level = xp // XP["PER_LEVEL"] + 1
    return {
        "level": level,
        "rank": RANKS[min(level - 1, len(RANKS) - 1)],
        "into": xp % XP["PER_LEVEL"],
        "need": XP["PER_LEVEL"],
        "pct": round((xp % XP["PER_LEVEL"]) / XP["PER_LEVEL"] * 100),
    }


def pct(n: int, d: int) -> int:
    return round(n / d * 100) if d else 0


def parse_time(value) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None


def ago(value) -> str:
    t = parse_time(value)
    if not t:
        return ""
    secs = max(0.0, (datetime.now(timezone.utc) - t.astimezone(timezone.utc)).total_seconds())
    if secs < 45:
        return "just now"
    if secs < 3600:
        return f"{int(secs // 60)}m ago"
    if secs < 86400:
        return f"{int(secs // 3600)}h ago"
    if secs < 86400 * 7:
        return f"{int(secs // 86400)}d ago"
    return t.astimezone().strftime("%b %-d")


def dur(seconds: float) -> str:
    if not seconds or seconds <= 0:
        return "-"
    if seconds < 90:
        return f"{round(seconds)}s"
    if seconds < 5400:
        return f"{round(seconds / 60)}m"
    if seconds < 86400 * 2:
        return f"{seconds / 3600:.1f}h"
    return f"{round(seconds / 86400)}d"


def player_stats(rows: list[dict], key: str) -> dict:
    key = (key or "unknown").lower()
    mine = [r for r in rows if identity_key(r) == key]
    xp = sum(score_one(r) for r in mine)
    approved = sum(1 for r in mine if r.get("status") == "approved")
    denied = sum(1 for r in mine if r.get("status") == "denied")
    pending = sum(1 for r in mine if r.get("status") == "pending")

    streak = 0
    for r in [r for r in mine if r.get("status") != "pending"]:
        if r.get("status") == "approved":
            streak += 1
        else:
            break

    counts: dict[str, int] = defaultdict(int)
    for r in mine:
        name = (r.get("snack") or "").strip()
        if name:
            counts[name] += 1
    favourite = max(counts.items(), key=lambda kv: kv[1]) if counts else None

    out = {
        "mine": mine, "xp": xp, "approved": approved, "denied": denied,
        "pending": pending, "photos": sum(1 for r in mine if r.get("photo_url")),
        "streak": streak, "favourite": favourite,
        "decided": approved + denied, "rate": pct(approved, approved + denied),
    }
    out.update(level_of(xp))
    return out


SORTS = {
    "xp": ("XP", lambda r: r["xp"]),
    "approvals": ("APPROVALS", lambda r: r["approved"]),
    "requests": ("REQUESTS", lambda r: r["n"]),
    "rate": ("YES RATE", lambda r: r["rate"] if r["decided"] >= 3 else -1),
    "denied": ("MOST DENIED", lambda r: r["denied"]),
}


def leaderboard(rows: list[dict], by: str = "xp") -> list[dict]:
    people: dict[str, dict] = {}
    for r in rows:
        k = identity_key(r)
        p = people.setdefault(k, {
            "key": k, "name": r.get("requester_name") or r.get("requester_email") or "Someone",
            "xp": 0, "n": 0, "approved": 0, "denied": 0, "pending": 0, "snacks": defaultdict(int),
        })
        p["xp"] += score_one(r)
        p["n"] += 1
        status = r.get("status")
        if status in ("approved", "denied", "pending"):
            p[status] += 1
        name = (r.get("snack") or "").strip()
        if name:
            p["snacks"][name] += 1

    out = []
    for p in people.values():
        p["decided"] = p["approved"] + p["denied"]
        p["rate"] = pct(p["approved"], p["decided"])
        p["usual"] = max(p["snacks"].items(), key=lambda kv: kv[1])[0] if p["snacks"] else ""
        p.update(level_of(p["xp"]))
        out.append(p)

    label, getter = SORTS.get(by, SORTS["xp"])
    out.sort(key=lambda r: (getter(r), r["xp"], r["name"]), reverse=True)
    return out


def office_stats(rows: list[dict]) -> dict:
    approved = [r for r in rows if r.get("status") == "approved"]
    denied = [r for r in rows if r.get("status") == "denied"]
    pending = [r for r in rows if r.get("status") == "pending"]

    waits = []
    for r in rows:
        a, b = parse_time(r.get("created_at")), parse_time(r.get("decided_at"))
        if a and b and b > a:
            waits.append((b - a).total_seconds())
    waits.sort()

    by_hour = [0] * 24
    by_day = [0] * 7
    for r in rows:
        t = parse_time(r.get("created_at"))
        if t:
            local = t.astimezone()
            by_hour[local.hour] += 1
            by_day[local.weekday()] += 1

    names: dict[str, dict] = {}
    for r in rows:
        name = (r.get("snack") or "").strip()
        if name:
            slot = names.setdefault(name.lower(), {"label": name, "n": 0, "approved": 0})
            slot["n"] += 1
            if r.get("status") == "approved":
                slot["approved"] += 1

    cats: dict[str, int] = defaultdict(int)
    for r in rows:
        cats[r.get("category") or categorise(r.get("snack"))] += 1

    today = datetime.now().astimezone().date()
    ruled = [r for r in rows if r.get("decided_at")]
    ruled.sort(key=lambda r: r["decided_at"], reverse=True)

    return {
        "total": len(rows),
        "approved": len(approved),
        "denied": len(denied),
        "pending": len(pending),
        "rate": pct(len(approved), len(approved) + len(denied)),
        "median_wait": waits[len(waits) // 2] if waits else 0,
        "slowest": waits[-1] if waits else 0,
        "by_hour": by_hour,
        "by_day": by_day,
        "peak_hour": by_hour.index(max(by_hour)) if rows else 0,
        "top_snacks": sorted(names.values(), key=lambda s: s["n"], reverse=True)[:10],
        "categories": sorted(cats.items(), key=lambda kv: kv[1], reverse=True),
        "today": sum(1 for r in rows
                     if (parse_time(r.get("created_at")) or datetime.now(timezone.utc))
                     .astimezone().date() == today),
        "people": len({identity_key(r) for r in rows}),
        "oldest_pending": min(pending, key=lambda r: r.get("created_at") or "") if pending else None,
        "last_ruling": ruled[0] if ruled else None,
    }


def wait_seconds(rec: dict) -> float:
    a, b = parse_time(rec.get("created_at")), parse_time(rec.get("decided_at"))
    return (b - a).total_seconds() if a and b and b > a else 0.0


# --------------------------------------------------------------------------
# actions shared by the TUI and the MCP server
# --------------------------------------------------------------------------

def slack_safe(text) -> str:
    return (str(text or "").replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;"))


def file_request(client: Client, snack: str, where: str = "", portion: str = "NORMAL",
                 case: str = "", notify: bool = True) -> dict:
    """Create a request and DM the approver. Returns (record, notice)."""
    snack = (snack or "").strip()
    if not snack:
        raise SnackError("Name the snack.")
    if len(snack) > 90:
        raise SnackError("Snack name is capped at 90 characters.")

    me = client.me()
    rows = client.fetch_all()
    before = player_stats(rows, str(me.get("email") or me.get("fullName") or "").lower())

    rec = client.create(COLLECTION, {
        "snack": snack,
        "category": categorise(snack),
        "where": (where or "").strip(),
        "size": portion if portion in PORTIONS else "NORMAL",
        "plea": (case or "").strip(),
        "photo_url": "",
        "photo_full_url": "",
        "status": "pending",
        "verdict_note": "",
        "decided_by": None,
        "decided_by_email": None,
        "decided_at": None,
        "requester_name": me.get("fullName") or me.get("email") or "Someone",
        "requester_email": me.get("email") or "",
        "requester_slack": me.get("slackId") or "",
        "requester_avatar": me.get("slackImageUrl") or "",
        "requester_handle": me.get("slackHandle") or "",
        "source": "terminal",
    })

    notice = "Filed. Slack notification skipped."
    if notify:
        who = slack_safe(rec.get("requester_name"))
        first = who.split(" ")[0] if who else "someone"
        blocks = [
            {"type": "header", "text": {"type": "plain_text", "text": "Snack request"}},
            {"type": "section", "text": {"type": "mrkdwn",
             "text": f"*{who}* would like to eat *{slack_safe(snack)}*.\n\nYour ruling, please."}},
            {"type": "section", "fields": [
                {"type": "mrkdwn", "text": f"*Snack*\n{slack_safe(snack)}"},
                {"type": "mrkdwn", "text": f"*Type*\n{rec.get('category')}"},
                {"type": "mrkdwn", "text": f"*Portion*\n{rec.get('size')}"},
                {"type": "mrkdwn", "text": f"*From*\n{rec.get('where') or 'not stated'}"},
                {"type": "mrkdwn", "text": f"*Requester*\n{first} - level {before['level']}, "
                                           f"{before['rank'].lower()}"},
                {"type": "mrkdwn", "text": f"*Record*\n{before['approved']} approved / "
                                           f"{before['denied']} denied"},
            ]},
        ]
        if rec.get("plea"):
            blocks.append({"type": "section", "text": {"type": "mrkdwn",
                           "text": f'Their case: _"{slack_safe(rec["plea"])}"_'}})
        blocks += [
            {"type": "divider"},
            {"type": "section", "text": {"type": "mrkdwn",
             "text": f"<{client.base}/judge.html?id={rec.get('id')}|Open the judgement room>"}},
            {"type": "context", "elements": [{"type": "mrkdwn", "text": "Sent from a terminal"}]},
        ]
        try:
            res = client.slack_post(APPROVER["slack_id"],
                                    f"{who} is asking to eat {snack}.", blocks)
            notice = f"Filed and sent to {APPROVER['short']}."
        except SnackError as e:
            notice = f"Filed, but Slack failed: {e}"
            res = {}
        # Storing the thread stamp is a nice-to-have: it lets the verdict reply in
        # the same Slack thread. Never let it mask the outcome above.
        ts = res.get("ts") or ""
        if ts:
            try:
                client.update(COLLECTION, rec["id"], {"slack_ts": ts})
            except SnackError:
                pass

    return {"record": rec, "notice": notice, "xp": XP["LOG"] + (XP["PLEA"] if case else 0)}


def rule_on(client: Client, doc_id: str, verdict: str, reason: str = "") -> dict:
    """Approve or deny a request. Approver only, same gate as the web app."""
    if verdict not in ("approved", "denied"):
        raise SnackError("Verdict must be 'approved' or 'denied'.")
    me = client.me()
    if not client.is_god(me):
        raise SnackError(
            f"Only {APPROVER['name']} can rule on snack requests. "
            f"You are signed in as {me.get('email', 'unknown')}."
        )

    rec = client.find_by_id(COLLECTION, doc_id)
    if not rec:
        raise SnackError(f"No request with id {doc_id}.")

    by = me.get("fullName") or me.get("email") or APPROVER["name"]
    client.update(COLLECTION, doc_id, {
        "status": verdict,
        "verdict_note": (reason or "").strip(),
        "decided_by": by,
        "decided_by_email": str(me.get("email") or "").lower(),
        "decided_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    })

    approved = verdict == "approved"
    headline = "Snack approved" if approved else "Snack denied"
    first = slack_safe((rec.get("requester_name") or "").split(" ")[0] or "there")
    body = (f"{first}, your request for *{slack_safe(rec.get('snack'))}* is approved. Enjoy it."
            if approved else
            f"{first}, your request for *{slack_safe(rec.get('snack'))}* is denied.")
    note = (f'Reason: _"{slack_safe(reason)}"_' if reason
            else ("_No conditions._" if approved else "_No reason given._"))
    blocks = [
        {"type": "header", "text": {"type": "plain_text", "text": headline}},
        {"type": "section", "text": {"type": "mrkdwn", "text": body}},
        {"type": "section", "fields": [
            {"type": "mrkdwn", "text": f"*Ruled by*\n{slack_safe(by)}"},
            {"type": "mrkdwn", "text": f"*XP*\n+{XP['APPROVED'] if approved else XP['DENIED']}"},
        ]},
        {"type": "section", "text": {"type": "mrkdwn", "text": note}},
        {"type": "divider"},
        {"type": "section", "text": {"type": "mrkdwn",
         "text": f"<{client.base}/|Open snack approval>"}},
        {"type": "context", "elements": [{"type": "mrkdwn", "text": "Ruled from a terminal"}]},
    ]

    notice = f"{headline}."
    text = f"{headline}: {rec.get('snack')}"
    if rec.get("requester_slack"):
        try:
            client.slack_post(rec["requester_slack"], text, blocks)
            notice += f" {rec.get('requester_name', 'They')} has been told."
        except SnackError as e:
            notice += f" DM failed: {e}"
    if rec.get("slack_ts"):
        try:
            client.slack_post(APPROVER["slack_id"], text, thread_ts=rec["slack_ts"])
        except SnackError:
            pass

    return {"record": rec, "notice": notice}

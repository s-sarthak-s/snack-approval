#!/usr/bin/env python3
"""Snack Approval in a terminal.

    ./snack_tui.py                 full-screen TUI
    ./snack_tui.py --plain board   print one view and exit (works in a pipe)

Same data and same rules as the web app: anyone can file a request, only the
configured approver can rule on one.

Keys
  1-5 / tab      switch view          n  new request      N  new with details
  j k / arrows   move                 /  search feed      f  cycle feed filter
  s              cycle board sort     r  reload           m  mute the bell
  a x            approve / deny (judge view, approver only)
  ?              help                 q  quit

Standard library only.
"""

from __future__ import annotations

import argparse
import curses
import random
import sys
import textwrap
import threading
import time
from datetime import datetime

import snackapi as api

VIEWS = ["request", "feed", "board", "stats", "judge"]
FILTERS = ["all", "pending", "approved", "denied", "mine"]

# colour pair ids
C_TEXT, C_ACC, C_DIM, C_OK, C_BAD, C_WARN, C_INV, C_FAINT = range(1, 9)


def init_colours() -> None:
    curses.start_color()
    try:
        curses.use_default_colors()
        bg = -1
    except curses.error:
        bg = curses.COLOR_BLACK
    wide = curses.COLORS >= 256
    amber = 214 if wide else curses.COLOR_YELLOW
    dim = 244 if wide else curses.COLOR_WHITE
    faint = 240 if wide else curses.COLOR_BLUE
    text = 253 if wide else curses.COLOR_WHITE
    ok = 114 if wide else curses.COLOR_GREEN
    bad = 203 if wide else curses.COLOR_RED
    warn = 179 if wide else curses.COLOR_YELLOW
    curses.init_pair(C_TEXT, text, bg)
    curses.init_pair(C_ACC, amber, bg)
    curses.init_pair(C_DIM, dim, bg)
    curses.init_pair(C_OK, ok, bg)
    curses.init_pair(C_BAD, bad, bg)
    curses.init_pair(C_WARN, warn, bg)
    curses.init_pair(C_INV, curses.COLOR_BLACK, amber)
    curses.init_pair(C_FAINT, faint, bg)


class Store:
    """Rows plus a background refresh, so the UI never blocks on the network."""

    def __init__(self, client=None) -> None:
        self.client = client or api.Client()
        self.rows: list[dict] = []
        self.me: dict = {}
        self.god = False
        self.error = ""
        self.loading = False
        self.loaded_at = 0.0
        self._lock = threading.Lock()
        self._seen: dict[str, str] = {}
        self.events: list[str] = []

    def key(self) -> str:
        return str(self.me.get("email") or self.me.get("fullName") or "unknown").lower()

    def refresh(self, blocking: bool = False) -> None:
        if self.loading:
            return
        self.loading = True

        def work() -> None:
            try:
                if not self.me:
                    self.me = self.client.me()
                    self.god = self.client.is_god(self.me)
                rows = self.client.fetch_all()
                with self._lock:
                    self._diff(rows)
                    self.rows = rows
                    self.loaded_at = time.time()
                    self.error = ""
            except api.SnackError as e:
                self.error = str(e)
            except Exception as e:  # noqa: BLE001 - the UI must survive anything
                self.error = f"{type(e).__name__}: {e}"
            finally:
                self.loading = False

        if blocking:
            work()
        else:
            threading.Thread(target=work, daemon=True).start()

    def _diff(self, rows: list[dict]) -> None:
        """Notice verdicts that landed on your own requests since last poll."""
        mine = self.key()
        for r in rows:
            prev = self._seen.get(r["id"])
            self._seen[r["id"]] = r.get("status", "")
            if prev and prev != r.get("status") and r.get("status") != "pending":
                if api.identity_key(r) == mine:
                    verdict = "approved" if r["status"] == "approved" else "denied"
                    note = r.get("verdict_note") or "no reason given"
                    self.events.append(f"{r.get('snack')} was {verdict} - {note}")

    def player(self) -> dict:
        return api.player_stats(self.rows, self.key())

    def stats(self) -> dict:
        return api.office_stats(self.rows)


class FakeClient:
    """Canned data for --demo: no network, no Slack, and you are the authority.

    Exists so the judge view can be exercised without impersonating anyone and
    so the app can be shown to people who are not signed in.
    """

    base = "https://snack-approval.example"

    def __init__(self) -> None:
        now = time.time()
        people = [(api.APPROVER["name"], api.APPROVER["email"]),
                  ("Ada Placeholder", "ada@example.com"),
                  ("Bo Sample", "bo@example.com"),
                  ("Cy Fixture", "cy@example.com")]
        items = ["flat white", "triple chocolate cookie", "banana", "pretzels",
                 "cold brew", "the last samosa", "greek yogurt", "leftover cake"]
        rng = random.Random(11)
        self.rows = []
        for i in range(16):
            name, email = rng.choice(people)
            status = rng.choice(["approved"] * 5 + ["denied"] * 3 + ["pending"] * 3)
            made = now - rng.random() * 6 * 86400 - i * 900
            ruled = made + rng.random() * 5400
            self.rows.append({
                "id": f"demo-{i}", "snack": rng.choice(items),
                "category": "", "where": rng.choice(["kitchen", "3rd floor", ""]),
                "size": rng.choice(api.PORTIONS), "status": status,
                "plea": rng.choice(["", "", api.PLEAS[i % len(api.PLEAS)]]),
                "verdict_note": "" if status == "pending" else rng.choice(
                    api.YES_REASONS + api.NO_REASONS),
                "decided_by": None if status == "pending" else api.APPROVER["name"],
                "decided_by_email": None if status == "pending" else api.APPROVER["email"],
                "decided_at": None if status == "pending" else _iso(ruled),
                "created_at": _iso(made),
                "requester_name": name, "requester_email": email, "requester_slack": "",
            })
        self.rows.sort(key=lambda r: r["created_at"], reverse=True)

    def me(self):
        return {"fullName": api.APPROVER["name"], "firstName": api.APPROVER["short"],
                "email": api.APPROVER["email"], "slackId": api.APPROVER["slack_id"]}

    def is_god(self, user=None):
        return True

    def fetch_all(self, collection="snacks", page=100):
        return list(self.rows) if collection == "snacks" else []

    def create(self, collection, doc):
        doc = dict(doc, id=f"demo-new-{len(self.rows)}", created_at=_iso(time.time()))
        self.rows.insert(0, doc)
        return doc

    def update(self, collection, doc_id, patch):
        for r in self.rows:
            if r["id"] == doc_id:
                r.update(patch)
                return r
        return {}

    def find_by_id(self, collection, doc_id):
        return next((r for r in self.rows if r["id"] == doc_id), None)

    def slack_post(self, *a, **k):
        return {"ok": True, "ts": "0"}


def _iso(epoch: float) -> str:
    from datetime import timezone as _tz
    return datetime.fromtimestamp(epoch, _tz.utc).isoformat().replace("+00:00", "Z")


class UI:
    def __init__(self, scr, store: Store, muted: bool = False) -> None:
        self.scr = scr
        self.store = store
        self.view = "request"
        self.sel = 0
        self.scroll = 0
        self.filter = "all"
        self.sort = "xp"
        self.query = ""
        self.muted = muted
        self.status = "Loading..."
        self.status_kind = C_DIM
        self.tick = 0

    # -- drawing helpers -------------------------------------------------

    def put(self, y: int, x: int, text: str, pair: int = C_TEXT, bold: bool = False) -> None:
        h, w = self.scr.getmaxyx()
        if y < 0 or y >= h or x >= w:
            return
        room = w - x - 1
        if room <= 0:
            return
        attr = curses.color_pair(pair) | (curses.A_BOLD if bold else 0)
        try:
            self.scr.addnstr(y, x, text, room, attr)
        except curses.error:
            pass

    def hrule(self, y: int, pair: int = C_FAINT) -> None:
        """Draw a horizontal line. Named hrule, not rule: `rule` used to collide
        with the approve/deny action below, which made every repaint open a deny
        prompt for whoever was allowed to judge."""
        _, w = self.scr.getmaxyx()
        self.put(y, 0, "-" * (w - 1), pair)

    def bar(self, value: int, total: int, width: int) -> str:
        filled = 0 if total <= 0 else max(0, min(width, round(value / total * width)))
        return "#" * filled + "." * (width - filled)

    def beep(self) -> None:
        if not self.muted:
            curses.flash()
            try:
                curses.beep()
            except curses.error:
                pass

    def say(self, msg: str, kind: int = C_DIM) -> None:
        self.status = msg
        self.status_kind = kind

    # -- chrome ----------------------------------------------------------

    def draw_header(self) -> None:
        h, w = self.scr.getmaxyx()
        self.put(0, 0, "SNACK", C_TEXT, bold=True)
        self.put(0, 6, "APPROVAL", C_ACC, bold=True)
        p = self.store.player()
        who = self.store.me.get("fullName") or "connecting"
        right = f"{who} - L{p['level']} {p['rank']}"
        if self.store.god:
            right += " - AUTHORITY"
        self.put(0, max(16, w - len(right) - 1), right, C_DIM)

        x = 0
        pending = self.store.stats()["pending"]
        for i, name in enumerate(VIEWS):
            if name == "judge" and not self.store.god:
                continue
            label = f" {i + 1} {name.upper()}"
            if name == "judge" and pending:
                label += f" ({pending})"
            label += " "
            self.put(1, x, label, C_INV if name == self.view else C_DIM,
                     bold=name == self.view)
            x += len(label) + 1

        clock = datetime.now().strftime("%H:%M:%S")
        dot = "*" if self.store.loading else ("." if self.tick % 2 else " ")
        self.put(1, max(x + 2, w - 12), f"{dot} {clock}",
                 C_WARN if self.store.loading else C_FAINT)
        self.hrule(2)

    def draw_footer(self) -> None:
        h, w = self.scr.getmaxyx()
        self.hrule(h - 2)
        hint = {
            "request": "n new  N details  r reload  ? help  q quit",
            "feed": "j/k move  f filter  / search  r reload  q quit",
            "board": "s sort  j/k move  r reload  q quit",
            "stats": "r reload  ? help  q quit",
            "judge": "a approve  x deny  j/k move  r reload  q quit",
        }[self.view]
        left = self.status[: max(0, w - len(hint) - 4)]
        self.put(h - 1, 0, left, self.status_kind)
        self.put(h - 1, max(0, w - len(hint) - 1), hint, C_FAINT)

    # -- views -----------------------------------------------------------

    def body_rows(self) -> tuple[int, int]:
        h, _ = self.scr.getmaxyx()
        return 3, h - 3  # first line, last line + 1

    def draw_request(self) -> None:
        top, end = self.body_rows()
        _, w = self.scr.getmaxyx()
        p = self.store.player()
        st = self.store.stats()
        y = top + 1

        self.put(y, 2, self.store.me.get("fullName") or "-", C_TEXT, bold=True)
        self.put(y, max(30, w - 34), f"{p['xp']} XP total", C_DIM)
        y += 1
        self.put(y, 2, f"Level {p['level']}  {p['rank']}", C_ACC)
        y += 2

        width = max(10, min(46, w - 30))
        self.put(y, 2, "[" + self.bar(p["into"], p["need"], width) + "]", C_ACC)
        self.put(y, width + 5, f"{p['into']}/{p['need']} to L{p['level'] + 1}", C_FAINT)
        y += 2

        cells = [
            (str(p["approved"]), "approved", C_OK),
            (str(p["denied"]), "denied", C_BAD),
            (str(p["pending"]), "waiting", C_WARN),
            (str(p["streak"]), "streak", C_ACC),
            (f"{p['rate']}%" if p["decided"] else "-", "yes rate", C_TEXT),
        ]
        x = 2
        for value, label, pair in cells:
            if x + 14 > w:
                break
            self.put(y, x, value.rjust(4), pair, bold=True)
            self.put(y + 1, x, label[:13], C_FAINT)
            x += 14
        y += 3

        usual = f"{p['favourite'][0]} x{p['favourite'][1]}" if p["favourite"] else "nothing yet"
        self.put(y, 2, f"Usual order: {usual}", C_DIM)
        y += 1
        self.put(y, 2, f"Office queue: {st['pending']} waiting"
                       f"   Median ruling time: {api.dur(st['median_wait'])}", C_DIM)
        y += 2

        self.put(y, 2, "PRESS n TO ASK FOR SOMETHING", C_ACC, bold=True)
        y += 2
        self.put(y, 2, "YOUR LAST FEW", C_FAINT)
        y += 1
        if not p["mine"]:
            self.put(y, 2, "Nothing yet.", C_DIM)
            return
        for rec in p["mine"][: max(0, (end - y) // 2)]:
            label, mark = api.VERDICTS.get(rec.get("status"), api.VERDICTS["pending"])
            pair = {"approved": C_OK, "denied": C_BAD}.get(rec.get("status"), C_WARN)
            self.put(y, 2, mark, pair, bold=True)
            self.put(y, 4, str(rec.get("snack"))[: max(1, w - 30)], C_TEXT)
            self.put(y, max(20, w - 24), label.rjust(9), pair)
            meta = f"{api.ago(rec.get('created_at'))}"
            if rec.get("verdict_note"):
                meta += f' - "{rec["verdict_note"]}"'
            self.put(y + 1, 4, meta[: max(1, w - 6)], C_FAINT)
            y += 2

    def filtered(self) -> list[dict]:
        mine = self.store.key()
        rows = self.store.rows
        if self.filter == "mine":
            rows = [r for r in rows if api.identity_key(r) == mine]
        elif self.filter in ("pending", "approved", "denied"):
            rows = [r for r in rows if r.get("status") == self.filter]
        if self.query:
            q = self.query.lower()
            rows = [r for r in rows if any(
                q in str(r.get(f) or "").lower()
                for f in ("snack", "requester_name", "verdict_note", "plea", "where", "category"))]
        return rows

    def draw_feed(self) -> None:
        top, end = self.body_rows()
        _, w = self.scr.getmaxyx()
        rows = self.filtered()

        head = f"filter: {self.filter}"
        if self.query:
            head += f"   search: {self.query}"
        head += f"   {len(rows)} of {len(self.store.rows)}"
        self.put(top, 2, head, C_DIM)

        per = 3
        room = max(1, (end - top - 1) // per)
        self.sel = max(0, min(self.sel, max(0, len(rows) - 1)))
        self.scroll = max(min(self.scroll, self.sel), self.sel - room + 1)
        y = top + 1

        for i in range(self.scroll, min(len(rows), self.scroll + room)):
            rec = rows[i]
            label, mark = api.VERDICTS.get(rec.get("status"), api.VERDICTS["pending"])
            pair = {"approved": C_OK, "denied": C_BAD}.get(rec.get("status"), C_WARN)
            cur = i == self.sel
            self.put(y, 0, ">" if cur else " ", C_ACC, bold=True)
            self.put(y, 2, mark, pair, bold=True)
            self.put(y, 4, str(rec.get("snack"))[: max(1, w - 32)], C_TEXT, bold=cur)
            self.put(y, max(20, w - 25), label.rjust(9), pair)
            cat = rec.get("category") or api.categorise(rec.get("snack"))
            meta = f"{rec.get('requester_name')} - {api.ago(rec.get('created_at'))} - {cat.lower()}"
            self.put(y + 1, 4, meta[: max(1, w - 6)], C_FAINT)
            if rec.get("status") != "pending":
                note = rec.get("verdict_note") or ("no conditions" if rec["status"] == "approved"
                                                   else "no reason given")
                took = api.wait_seconds(rec)
                line = f'{rec.get("decided_by") or api.APPROVER["name"]}: "{note}"'
                if took:
                    line += f" ({api.dur(took)})"
                self.put(y + 2, 4, line[: max(1, w - 6)], C_DIM)
            elif rec.get("plea"):
                self.put(y + 2, 4, f'"{rec["plea"]}"'[: max(1, w - 6)], C_DIM)
            y += per

        if not rows:
            self.put(top + 2, 2, "Nothing matches.", C_DIM)

    def draw_board(self) -> None:
        top, end = self.body_rows()
        _, w = self.scr.getmaxyx()
        board = api.leaderboard(self.store.rows, self.sort)
        label, _ = api.SORTS[self.sort]
        self.put(top, 2, f"ranked by {label.lower()}   "
                         f"{len(board)} people   {len(self.store.rows)} requests", C_DIM)
        self.put(top + 1, 2, "  #  NAME                      LVL   XP   YES   NO  RATE  USUAL",
                 C_FAINT)
        mine = self.store.key()
        y = top + 2
        for i, p in enumerate(board):
            if y >= end:
                break
            me = p["key"] == mine
            pair = C_ACC if me else C_TEXT
            rate = f"{p['rate']}%" if p["decided"] >= 3 else "-"
            line = (f"{i + 1:3d}  {p['name'][:24]:24s}  {p['level']:3d} {p['xp']:5d} "
                    f"{p['approved']:5d} {p['denied']:4d} {rate:>5s}  {p['usual'][:18]}")
            self.put(y, 2, line, pair, bold=me or i == 0)
            y += 1

    def draw_stats(self) -> None:
        top, end = self.body_rows()
        _, w = self.scr.getmaxyx()
        st = self.store.stats()
        y = top

        cells = [
            (str(st["total"]), "requests ever"), (str(st["people"]), "people"),
            (str(st["approved"]), "approved"), (str(st["denied"]), "denied"),
            (f"{st['rate']}%", "yes rate"), (str(st["pending"]), "waiting"),
            (api.dur(st["median_wait"]), "median ruling"),
            (api.dur(st["slowest"]), "longest wait"),
            (str(st["today"]), "filed today"),
            (api.ago(st["last_ruling"]["decided_at"]) if st["last_ruling"] else "-", "last ruling"),
        ]
        x = 2
        for value, label in cells:
            if x + 16 > w:
                x = 2
                y += 3
            self.put(y, x, value.rjust(5), C_ACC, bold=True)
            self.put(y + 1, x, label[:15], C_FAINT)
            x += 16
        y += 3

        self.put(y, 2, f"BY HOUR   busiest around {st['peak_hour']:02d}:00", C_FAINT)
        y += 1
        peak = max(st["by_hour"]) or 1
        height = 6
        for level in range(height, 0, -1):
            line = "".join("#" if v / peak * height >= level - 0.5 else " "
                           for v in st["by_hour"])
            self.put(y, 4, "".join(f"{c} " for c in line), C_ACC)
            y += 1
        self.put(y, 4, "0 . . 3 . . 6 . . 9 . . 12. . 15. . 18. . 21. .", C_FAINT)
        y += 2

        if y < end - 2:
            self.put(y, 2, "MOST REQUESTED", C_FAINT)
            y += 1
            top_n = max(1, max((s["n"] for s in st["top_snacks"]), default=1))
            for s in st["top_snacks"]:
                if y >= end:
                    break
                self.put(y, 4, s["label"][:22].ljust(23), C_TEXT)
                self.put(y, 28, self.bar(s["n"], top_n, min(22, max(4, w - 44))), C_ACC)
                self.put(y, 28 + min(22, max(4, w - 44)) + 2, str(s["n"]), C_DIM)
                y += 1

    def pending(self) -> list[dict]:
        return [r for r in self.store.rows if r.get("status") == "pending"]

    def draw_judge(self) -> None:
        top, end = self.body_rows()
        _, w = self.scr.getmaxyx()

        if not self.store.god:
            y = top + 2
            for line in ("[ LOCKED ]", "", f"This room belongs to {api.APPROVER['name']}.",
                         "Rulings are the authority's job and nobody else's.",
                         "The person who built this is locked out too.", "",
                         f"Signed in as {self.store.me.get('email', 'unknown')}"):
                self.put(y, 4, line, C_BAD if line.startswith("[") else C_DIM,
                         bold=line.startswith("["))
                y += 1
            return

        queue = self.pending()
        st = self.store.stats()
        self.put(top, 2, f"{len(queue)} waiting   mercy rate {st['rate']}%   "
                         f"median {api.dur(st['median_wait'])}", C_DIM)
        if not queue:
            self.put(top + 2, 2, "Nothing waiting. The kitchen is calm.", C_DIM)
            return

        self.sel = max(0, min(self.sel, len(queue) - 1))
        per = 3
        room = max(1, (end - top - 1) // per)
        self.scroll = max(min(self.scroll, self.sel), self.sel - room + 1)
        y = top + 1
        for i in range(self.scroll, min(len(queue), self.scroll + room)):
            rec = queue[i]
            cur = i == self.sel
            self.put(y, 0, ">" if cur else " ", C_ACC, bold=True)
            self.put(y, 2, str(rec.get("snack"))[: max(1, w - 30)], C_TEXT, bold=cur)
            self.put(y, max(20, w - 26), api.ago(rec.get("created_at")).rjust(10), C_WARN)
            cat = rec.get("category") or api.categorise(rec.get("snack"))
            self.put(y + 1, 4, f"{rec.get('requester_name')} - {cat.lower()} - "
                               f"{str(rec.get('size') or '').lower()}"[: max(1, w - 6)], C_FAINT)
            if rec.get("plea"):
                self.put(y + 2, 4, f'"{rec["plea"]}"'[: max(1, w - 6)], C_DIM)
            y += per

    # -- input -----------------------------------------------------------

    def prompt(self, label: str, options: list[str] | None = None, default: str = "") -> str | None:
        """One-line editor on the footer. Tab cycles canned options. Esc cancels."""
        h, w = self.scr.getmaxyx()
        buf = list(default)
        pick = -1
        curses.curs_set(1)
        try:
            while True:
                self.put(h - 1, 0, " " * (w - 1), C_TEXT)
                text = "".join(buf)
                self.put(h - 1, 0, label, C_ACC, bold=True)
                self.put(h - 1, len(label) + 1, text[: max(1, w - len(label) - 3)], C_TEXT)
                self.scr.move(h - 1, min(w - 2, len(label) + 1 + len(text)))
                self.scr.refresh()
                ch = self.scr.getch()
                if ch in (27,):                      # Esc
                    return None
                if ch in (10, 13, curses.KEY_ENTER):
                    return "".join(buf).strip()
                if ch in (curses.KEY_BACKSPACE, 127, 8):
                    if buf:
                        buf.pop()
                elif ch == 9 and options:            # Tab
                    pick = (pick + 1) % len(options)
                    buf = list(options[pick])
                elif ch == 21:                       # Ctrl-U
                    buf = []
                elif 32 <= ch < 127:
                    if len(buf) < 90:
                        buf.append(chr(ch))
        finally:
            curses.curs_set(0)
            self.scr.timeout(500)
            self.scr.clear()

    def new_request(self, with_details: bool = False) -> None:
        snack = self.prompt("snack>", options=None)
        if not snack:
            self.say("Cancelled.", C_DIM)
            return
        where = portion = case = ""
        if with_details:
            where = self.prompt("where from>") or ""
            portion = self.prompt("portion (tab cycles)>", api.PORTIONS, "NORMAL") or "NORMAL"
            case = self.prompt("your case (tab for a suggestion)>", api.PLEAS) or ""
        self.say("Filing...", C_WARN)
        self.draw()
        try:
            out = api.file_request(self.store.client, snack, where,
                                  portion or "NORMAL", case)
            self.say(out["notice"], C_OK)
            self.beep()
        except api.SnackError as e:
            self.say(str(e), C_BAD)
        self.store.refresh()

    def cast_verdict(self, verdict: str) -> None:
        if not self.store.god:
            self.say(f"Only {api.APPROVER['name']} can rule.", C_BAD)
            self.beep()
            return
        queue = self.pending()
        if not queue:
            return
        rec = queue[max(0, min(self.sel, len(queue) - 1))]
        options = api.YES_REASONS if verdict == "approved" else api.NO_REASONS
        word = "approve" if verdict == "approved" else "deny"
        reason = self.prompt(f"{word} '{str(rec.get('snack'))[:24]}' - reason (tab cycles)>",
                             options)
        if reason is None:
            self.say("Cancelled.", C_DIM)
            return
        self.say(f"{word.title()}ing...", C_WARN)
        self.draw()
        try:
            out = api.rule_on(self.store.client, rec["id"], verdict, reason)
            self.say(out["notice"], C_OK if verdict == "approved" else C_BAD)
            self.beep()
        except api.SnackError as e:
            self.say(str(e), C_BAD)
        self.store.refresh()

    def help_overlay(self) -> None:
        h, w = self.scr.getmaxyx()
        lines = [
            "SNACK APPROVAL - TERMINAL",
            "",
            "1-5 / tab    switch view",
            "n            new request (snack only)",
            "N            new request with portion, place, and a written case",
            "j k / arrows move within a list",
            "f            cycle feed filter: all, pending, approved, denied, mine",
            "/            search the feed",
            "s            cycle board sort: xp, approvals, requests, yes rate, denials",
            f"a x          approve / deny the selected request ({api.APPROVER['short']} only)",
            "r            reload now (it also polls every 30s)",
            "m            mute the bell",
            "q            quit",
            "",
            f"Filing a request DMs {api.APPROVER['short']}. Same database as the web app.",
            "press any key",
        ]
        box_h = len(lines) + 2
        box_w = min(w - 2, max(len(x) for x in lines) + 4)
        y0 = max(0, (h - box_h) // 2)
        x0 = max(0, (w - box_w) // 2)
        for i in range(box_h):
            self.put(y0 + i, x0, " " * box_w, C_TEXT)
        self.put(y0, x0, "+" + "-" * (box_w - 2) + "+", C_FAINT)
        self.put(y0 + box_h - 1, x0, "+" + "-" * (box_w - 2) + "+", C_FAINT)
        for i, line in enumerate(lines):
            pair = C_ACC if i == 0 else (C_FAINT if line == "press any key" else C_TEXT)
            self.put(y0 + 1 + i, x0 + 2, line, pair, bold=i == 0)
        self.scr.refresh()
        self.scr.timeout(-1)
        self.scr.getch()
        self.scr.timeout(500)

    # -- loop ------------------------------------------------------------

    def repaint(self) -> None:
        """Force a from-scratch redraw. Cheap, and it defends against a
        terminal whose idea of the screen has drifted from ours."""
        self.scr.clear()

    def draw(self) -> None:
        self.scr.erase()
        h, w = self.scr.getmaxyx()
        if w < 54 or h < 14:
            self.put(0, 0, "Terminal too small.", C_BAD)
            self.put(1, 0, f"{w}x{h}; need 54x14.", C_DIM)
            self.scr.refresh()
            return
        self.draw_header()
        {"request": self.draw_request, "feed": self.draw_feed, "board": self.draw_board,
         "stats": self.draw_stats, "judge": self.draw_judge}[self.view]()
        self.draw_footer()
        self.scr.refresh()

    def run(self) -> None:
        self.store.refresh()
        last_poll = time.time()
        while True:
            self.tick += 1
            if self.store.events:
                self.say(self.store.events.pop(0), C_ACC)
                self.beep()
            elif self.store.error:
                self.say(self.store.error, C_BAD)
            elif self.status.startswith("Loading") and self.store.loaded_at:
                self.say(f"{len(self.store.rows)} requests loaded.", C_DIM)
            self.draw()

            ch = self.scr.getch()
            if ch == -1:
                if time.time() - last_poll > 30:
                    last_poll = time.time()
                    self.store.refresh()
                continue

            if ch in (ord("q"), ord("Q")):
                return
            if ch == ord("?"):
                self.help_overlay()
            elif ch in (ord("r"), ord("R")):
                self.say("Reloading...", C_WARN)
                self.store.refresh()
                last_poll = time.time()
            elif ch in (ord("m"), ord("M")):
                self.muted = not self.muted
                self.say("Bell muted." if self.muted else "Bell on.", C_DIM)
            elif ch == ord("n"):
                self.new_request(False)
            elif ch == ord("N"):
                self.new_request(True)
            elif ch == ord("a"):
                self.cast_verdict("approved")
            elif ch == ord("x"):
                self.cast_verdict("denied")
            elif ch == ord("f") and self.view == "feed":
                self.filter = FILTERS[(FILTERS.index(self.filter) + 1) % len(FILTERS)]
                self.sel = self.scroll = 0
                self.repaint()
            elif ch == ord("/") and self.view == "feed":
                self.query = self.prompt("search>", default=self.query) or ""
                self.sel = self.scroll = 0
                self.repaint()
            elif ch == ord("s") and self.view == "board":
                keys = list(api.SORTS)
                self.sort = keys[(keys.index(self.sort) + 1) % len(keys)]
                self.repaint()
            elif ch in (ord("j"), curses.KEY_DOWN):
                self.sel += 1
            elif ch in (ord("k"), curses.KEY_UP):
                self.sel = max(0, self.sel - 1)
            elif ch in (curses.KEY_NPAGE,):
                self.sel += 5
            elif ch in (curses.KEY_PPAGE,):
                self.sel = max(0, self.sel - 5)
            elif ch == 9:  # Tab
                order = [v for v in VIEWS if v != "judge" or self.store.god]
                self.view = order[(order.index(self.view) + 1) % len(order)]
                self.sel = self.scroll = 0
                self.repaint()
            elif ord("1") <= ch <= ord("5"):
                name = VIEWS[ch - ord("1")]
                if name != "judge" or self.store.god:
                    self.view = name
                    self.sel = self.scroll = 0
                    self.repaint()
                else:
                    self.say(f"Judging is {api.APPROVER['short']}'s alone.", C_BAD)


def boot_splash(scr) -> None:
    lines = ["SNACK APPROVAL SYSTEM  v3", "", "self test .............. ok",
             "identity ............... checking", "pantry link ............ online",
             f"authority .............. {api.APPROVER['name'].upper()}", "", "ready"]
    scr.erase()
    for i, line in enumerate(lines):
        try:
            scr.addnstr(2 + i, 4, line, max(1, scr.getmaxyx()[1] - 6),
                        curses.color_pair(C_ACC))
            scr.refresh()
        except curses.error:
            pass
        time.sleep(0.07)
    time.sleep(0.25)


def tui(scr, muted: bool, boot: bool, demo: bool = False) -> None:
    curses.curs_set(0)
    init_colours()
    scr.timeout(500)
    if boot:
        boot_splash(scr)
    store = Store(FakeClient() if demo else None)
    ui = UI(scr, store, muted=muted)
    if demo:
        ui.say("DEMO - canned data, nothing is sent anywhere.", C_WARN)
    ui.run()


# --------------------------------------------------------------------------
# plain-text mode, for pipes and quick looks
# --------------------------------------------------------------------------

def plain(what: str) -> int:
    try:
        store = Store()
    except api.SnackError as e:
        print(e, file=sys.stderr)
        return 1
    store.refresh(blocking=True)
    if store.error:
        print(store.error, file=sys.stderr)
        return 1
    rows, st = store.rows, store.stats()

    if what == "board":
        print(f"ALL-TIME BOARD  -  {st['people']} people, {st['total']} requests\n")
        print("  #  NAME                      LVL     XP   YES    NO  RATE  USUAL")
        for i, p in enumerate(api.leaderboard(rows)):
            rate = f"{p['rate']}%" if p["decided"] >= 3 else "-"
            print(f"{i + 1:3d}  {p['name'][:24]:24s}  {p['level']:3d}  {p['xp']:5d} "
                  f"{p['approved']:5d} {p['denied']:5d} {rate:>5s}  {p['usual'][:20]}")
    elif what == "feed":
        for r in rows:
            label, mark = api.VERDICTS.get(r.get("status"), api.VERDICTS["pending"])
            line = (f"{mark} {str(r.get('snack'))[:34]:34s} {label:9s} "
                    f"{str(r.get('requester_name'))[:20]:20s} {api.ago(r.get('created_at'))}")
            if r.get("verdict_note"):
                line += f'  "{r["verdict_note"]}"'
            print(line)
    elif what == "stats":
        print(f"requests ever   {st['total']}\npeople          {st['people']}\n"
              f"approved        {st['approved']}\ndenied          {st['denied']}\n"
              f"yes rate        {st['rate']}%\nwaiting         {st['pending']}\n"
              f"median ruling   {api.dur(st['median_wait'])}\n"
              f"longest wait    {api.dur(st['slowest'])}\n"
              f"filed today     {st['today']}\nbusiest hour    {st['peak_hour']:02d}:00")
        print("\nmost requested")
        for s in st["top_snacks"]:
            print(f"  {s['label'][:28]:28s} {s['n']:3d}")
    elif what == "me":
        p = store.player()
        print(f"{store.me.get('fullName')}  <{store.me.get('email')}>")
        print(f"level {p['level']}  {p['rank']}  {p['xp']} XP  "
              f"({p['into']}/{p['need']} to next)")
        print(f"approved {p['approved']}  denied {p['denied']}  waiting {p['pending']}  "
              f"streak {p['streak']}  yes rate {p['rate']}%")
        print(f"can rule: {'yes' if store.god else 'no'}")
        for r in p["mine"][:10]:
            label, _ = api.VERDICTS.get(r.get("status"), api.VERDICTS["pending"])
            print(f"  {label:9s} {str(r.get('snack'))[:30]:30s} {api.ago(r.get('created_at'))}")
    elif what == "pending":
        queue = [r for r in rows if r.get("status") == "pending"]
        if not queue:
            print("Nothing waiting.")
        for r in queue:
            print(f"{r['id']}  {str(r.get('snack'))[:30]:30s} "
                  f"{str(r.get('requester_name'))[:20]:20s} {api.ago(r.get('created_at'))}")
    else:
        print(f"unknown view: {what}", file=sys.stderr)
        return 2
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="Snack Approval in a terminal.")
    ap.add_argument("--plain", metavar="VIEW", nargs="?", const="board",
                    choices=["board", "feed", "stats", "me", "pending"],
                    help="print one view and exit")
    ap.add_argument("--ask", metavar="SNACK", help="file a request and exit")
    ap.add_argument("--where", default="")
    ap.add_argument("--portion", default="NORMAL", choices=api.PORTIONS)
    ap.add_argument("--case", default="", help="your written case")
    ap.add_argument("--mute", action="store_true", help="start with the bell off")
    ap.add_argument("--no-boot", action="store_true", help="skip the start-up splash")
    ap.add_argument("--demo", action="store_true",
                    help="offline canned data, and you are the authority; nothing is sent")
    args = ap.parse_args()

    if args.ask:
        try:
            client = api.Client()
            out = api.file_request(client, args.ask, args.where, args.portion, args.case)
        except api.SnackError as e:
            print(e, file=sys.stderr)
            return 1
        print(f"{out['notice']}  (+{out['xp']} XP)  id={out['record'].get('id')}")
        return 0

    if args.plain:
        return plain(args.plain)

    if not sys.stdout.isatty():
        print("Not a terminal. Use --plain board|feed|stats|me|pending.", file=sys.stderr)
        return 2

    try:
        curses.wrapper(tui, muted=args.mute, boot=not args.no_boot, demo=args.demo)
    except KeyboardInterrupt:
        pass
    except api.SnackError as e:
        print(e, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())

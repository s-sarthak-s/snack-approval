# Snack Approval

An office toy. You file a request to eat something, one designated person gets a
Slack message, they approve or deny it, and you get a DM back. Everything anyone
has ever asked for stays on an all-time leaderboard.

Three ways in: a web app, a terminal UI, and an MCP server. All three share one
database and one rule — anyone can ask, only the approver can rule.

Built for a Shopify intern cohort, so it deploys to an internal, SSO-only static
host. The interesting parts are the front end and the terminal client; the
hosting is swappable.

```
 SNACK APPROVAL                          Sarthak Sethi - L3 PANTRY REGULAR
  1 REQUEST   2 FEED   3 BOARD   4 STATS
 -------------------------------------------------------------------------
   Level 3  PANTRY REGULAR
   [##########################################....] 92/100 to L4

      3             5             0             1           38%
   approved      denied        waiting       streak        yes rate
```

## What it does

- **One field to ask.** Type "flat white" and press Enter. No category to pick,
  no icon to choose. Snacks are tagged automatically from the text.
- **A ruling comes back over Slack.** The approver gets a message with the
  request and a link; the verdict arrives as a DM.
- **Everyone who has ever asked is on the board**, sortable by XP, approvals,
  requests, yes rate, or most denied.
- **XP and ranks**, from CRUMB CLERK to SNACK LAUREATE, plus fourteen badges.
- **Stats**: requests by hour and weekday, most requested, ruling times.
- **Four themes**, chiptune sound effects generated in the browser, optional CRT
  scanlines, and a settings page to turn all of it off.

No emoji anywhere. That was a requirement.

## Pages

| URL | What it is |
| --- | --- |
| `/` | File a request; your level, badges, and recent rulings |
| `/feed.html` | Every request ever, searchable and filterable |
| `/board.html` | All-time board, five sort modes |
| `/stats.html` | Histograms, most requested, ruling times |
| `/judge.html` | Rulings. Approver only; everyone else gets a locked door |
| `/settings.html` | Sound, colour, motion, density, exports |
| `/admin.html` | Operator dashboard. Owner only |

## Terminal client

`cli/` has a curses TUI and an MCP server. Standard library only, no
`pip install`. Both reuse the identity token the host's CLI already manages, so
there is no second login.

```bash
cd cli
./snack                    # full-screen TUI
./snack demo               # canned data, offline, and you are the approver
./snack board              # print a view and exit; also feed, stats, me, pending
./snack visits             # who has been on the site (owner only)
./snack ask "flat white"   # file a request without opening anything
```

| Key | Does |
| --- | --- |
| `1`-`5`, Tab | request, feed, board, stats, judge |
| `n` / `N` | new request / new request with portion, place, and a written case |
| `j` `k` | move; `f` filter, `/` search, `s` cycle board sort |
| `a` / `x` | approve / deny (approver only) |
| `r` `m` `?` `q` | reload, mute, help, quit |

`./snack demo` needs no config and no network, which makes it the easy way to
see the thing.

## MCP server

`cli/snack_mcp.py` speaks MCP over stdio, so an assistant can read the board and
file requests for you.

| Tool | |
| --- | --- |
| `snack_whoami` | read: your record, and whether you may rule |
| `snack_feed` | read: the log, filterable and searchable |
| `snack_board` | read: the all-time board |
| `snack_stats` | read: totals, ruling times, busiest hours |
| `snack_pending` | read: the queue, with ids |
| `snack_reasons` | read: the canned approval and denial lines |
| `snack_visits` | read: who opened what and when. Owner only |
| `snack_request` | **write**: files a request and DMs the approver |
| `snack_rule` | **write**: approves or denies, and DMs the requester |

The two writes message a real person, and their descriptions say so, so a client
can confirm first. `snack_rule` enforces the approver check and errors for
everyone else.

```bash
./snack mcp --selftest     # handshake, schemas, every read tool, guard rails
claude mcp add snack-approval -s user -- python3 "$PWD/cli/snack_mcp.py"
```

## Configure

```bash
cp snack.config.example.json snack.config.json
```

```json
{
  "approver": {
    "name": "Firstname Lastname",
    "short": "Firstname",
    "email": "approver@example.com",
    "slackId": "U00000000000"
  },
  "owner": {
    "name": "Your Name",
    "email": "you@example.com"
  },
  "baseUrl": "https://your-site.example.com",
  "site": "your-site",
  "collection": "snacks"
}
```

`approver` is the one person who can rule. `owner` is whoever runs the thing and
sees the admin dashboard. They are separate: the owner still cannot approve a
snack. Leave `owner` blank and the dashboard is off for everybody.

`snack.config.json` is gitignored on purpose: it holds a real person's email and
Slack ID. The browser fetches it at boot and the Python client reads the same
file, so there is one source of truth. With no config, nobody is the approver
and the judge room stays shut — it fails closed.

## Run and deploy

```bash
quick serve . snack-approval          # local dev
open 'http://localhost:1337/?demo=1'  # seed sample rows, browser-local

./deploy.sh staging                   # then check it
./deploy.sh prod
```

`deploy.sh` assembles a clean bundle rather than uploading the working tree, so
`.git/` never ships and a missing config stops the deploy instead of shipping a
broken site.

## How it fits together

```
index.html …          one file per page, each sets window.PAGE
css/style.css         the whole design system
js/core.js            config, prefs, scoring, categories, stats, CSV
js/sfx.js             WebAudio chiptune, three packs, no audio files
js/views.js           HTML-returning render functions, no network calls
js/shell.js           header, nav, identity, one data load, toasts, keys
js/page-*.js          per-page controller, ends with Shell.start()
cli/snackapi.py       API client plus scoring, mirrors js/core.js
cli/snack_tui.py      curses TUI, --plain for pipes, --demo offline
cli/snack_mcp.py      MCP stdio server
```

Scoring, ranks, and categories exist twice, in `js/core.js` and
`cli/snackapi.py`. A shared source would mean a build step for a joke app, so
the rule is to change both together.

## Admin dashboard

`/admin.html` shows the owner who has been on the site: page views by person,
who is on right now, first and last seen, which pages get opened, visits by
hour, the raw visit log, every request, and the judge room's door log. CSV export
for the visit log and the requests.

Each page load writes one row to a `visits` collection: email, name, page,
timestamp, timezone, viewport, and whether it was a phone. That is a log of
colleagues' behaviour, so the app says so plainly on the settings page rather
than doing it quietly. If you do not want it, delete the `logVisit` call in
`js/shell.js`; nothing else depends on it.

## A note on the locks

The approver and owner checks run on the client, against a database any signed-in
employee can read and write. They are not real authorisation and are not
pretending to be. What they do is keep the pages out of the way and make
tampering obvious: any verdict not signed with the approver's email is labelled
**Unsanctioned** in the feed.

Nothing here is private, including the visit log. Anyone who can open the site
can read every request, name, plea, and visit row if they go looking.

## Licence

MIT. See [LICENSE](LICENSE).

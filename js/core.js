/* ==========================================================
   SNACK APPROVAL — core
   config, prefs, data access, scoring, stats, helpers
   ========================================================== */

/* The one and only judge. Not the person who built this.

   Filled in from snack.config.json at boot, which is deliberately not in git:
   it holds a real person's email and Slack ID. See snack.config.example.json.
   Every read happens inside a function called after loadConfig(), so mutating
   this object in place is safe. */
const APPROVER = {
  slackId: "",
  email: "",
  name: "the approver",
  short: "the approver",
  title: "SNACK APPROVAL AUTHORITY",
};

/* Whoever runs the thing. Sees the admin dashboard, including who visited.
   Separate from APPROVER on purpose: the owner still cannot rule. */
const OWNER = { name: "", email: "" };

let CONFIG = { site: "", collection: "snacks" };
let CONFIG_ERROR = "";

async function loadConfig() {
  try {
    const res = await fetch("/snack.config.json", { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const cfg = await res.json();
    Object.assign(APPROVER, cfg.approver || {});
    Object.assign(OWNER, cfg.owner || {});
    CONFIG = Object.assign(CONFIG, cfg);
    if (!APPROVER.slackId || !APPROVER.email) {
      CONFIG_ERROR = "snack.config.json has no approver email or Slack ID, so "
        + "nobody can be asked and nobody can rule.";
    }
  } catch (e) {
    CONFIG_ERROR = "Could not load snack.config.json (" + (e.message || e)
      + "). Copy snack.config.example.json and fill it in.";
  }
  return CONFIG_ERROR;
}

const SNACKS = () => quick.db.collection(CONFIG.collection || "snacks");
const VISITS = () => quick.db.collection("visits");
const ATTEMPTS = () => quick.db.collection("chamber_attempts");
const SITE_URL = () => window.location.origin;

const XP = { LOG: 10, APPROVED: 25, DENIED: 5, PHOTO: 5, PLEA: 3, PER_LEVEL: 100 };

const RANKS = [
  "CRUMB CLERK",
  "VENDING NOVICE",
  "PANTRY REGULAR",
  "SNACK ANALYST",
  "SENIOR SNACKER",
  "PANTRY PRINCIPAL",
  "SNACK ARCHITECT",
  "DIRECTOR OF SNACKS",
  "VP OF CHEWING",
  "SNACK LAUREATE",
];

const VERDICT = {
  pending: { label: "PENDING", cls: "pending", mark: "\u25CF" },
  approved: { label: "APPROVED", cls: "approved", mark: "\u2713" },
  denied: { label: "DENIED", cls: "denied", mark: "\u2715" },
};

const PORTIONS = ["A NIBBLE", "NORMAL", "GENEROUS", "SECOND HELPING", "DO NOT ASK"];

const PLEAS = [
  "I skipped lunch. This is basically medicine.",
  "Standup ran long. I have earned this.",
  "It was already open. Waste is worse.",
  "My blood sugar is a team dependency.",
  "I fixed a flaky test. Pay me in sugar.",
  "This is the last one in the box. Someone has to.",
  "I brought these in. Surely that counts.",
  "Deploy is green. Let me live.",
  "I am on call. Morale is infrastructure.",
  "It is technically fruit adjacent.",
];

/* ---------------- preferences ---------------- */

const PREF_KEY = "snackapproval.prefs.v3";

const DEFAULT_PREFS = {
  theme: "amber",
  sound: true,
  volume: 0.5,
  pack: "arcade",
  clicks: true,
  scanlines: true,
  flicker: false,
  motion: true,
  shake: true,
  density: "cosy",
  boot: true,
  confirmSmite: false,
};

const PREFS = (() => {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(PREF_KEY) || "{}"); } catch (e) { saved = {}; }
  return Object.assign({}, DEFAULT_PREFS, saved);
})();

function savePrefs() {
  try { localStorage.setItem(PREF_KEY, JSON.stringify(PREFS)); } catch (e) {}
  applyPrefs();
}

function applyPrefs() {
  const r = document.documentElement;
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  r.dataset.theme = PREFS.theme;
  r.dataset.scanlines = PREFS.scanlines ? "on" : "off";
  r.dataset.flicker = PREFS.flicker && PREFS.motion && !reduced ? "on" : "off";
  r.dataset.motion = PREFS.motion && !reduced ? "on" : "off";
  r.dataset.density = PREFS.density;
}

function resetPrefs() {
  Object.assign(PREFS, DEFAULT_PREFS);
  savePrefs();
}

/* ---------------- data ---------------- */

/* Pull the whole history, not just a recent window — the board is all-time.
   Pages by rows actually returned rather than by the requested size, so an
   unknown server-side cap on `limit` cannot silently truncate the board. */
async function fetchAll(pageSize = 100, hardStop = 4000) {
  const out = [];
  let offset = 0;
  while (offset < hardStop) {
    const rows = await SNACKS()
      .orderBy("created_at", "desc")
      .limit(pageSize)
      .offset(offset)
      .find();
    if (!Array.isArray(rows) || rows.length === 0) break;
    out.push(...rows);
    offset += rows.length;
  }
  /* Defensive: the API can hand back duplicates across pages if rows are written mid-scan. */
  const seen = new Set();
  return out.filter((r) => (r && r.id && !seen.has(r.id) ? seen.add(r.id) : false));
}

function isOwner(user) {
  if (!user || !OWNER.email) return false;
  return String(user.email || "").toLowerCase() === String(OWNER.email).toLowerCase();
}

/* Record that somebody opened a page. The admin dashboard reads these, and the
   settings page says out loud that it happens — logging colleagues quietly
   would not be okay. One row per navigation, not per poll. */
async function logVisit(user, page) {
  if (!user || !user.email) return;
  try {
    await VISITS().create({
      email: String(user.email).toLowerCase(),
      name: user.fullName || user.email,
      page: page || "unknown",
      at: new Date().toISOString(),
      tz: Intl.DateTimeFormat().resolvedOptions().timeZone || "",
      screen: `${window.innerWidth}x${window.innerHeight}`,
      mobile: window.innerWidth <= 720,
      referrer: document.referrer ? new URL(document.referrer).pathname : "",
    });
  } catch (e) {
    /* Never let bookkeeping break the page. */
  }
}

function isGod(user) {
  if (!user) return false;
  /* With no configured approver, nobody is the approver. Failing closed keeps a
     misconfigured deploy from handing the room to the first visitor. */
  if (!APPROVER.email && !APPROVER.slackId) return false;
  const email = String(user.email || "").toLowerCase();
  const slack = String(user.slackId || "");
  return (!!APPROVER.email && email === String(APPROVER.email).toLowerCase())
    || (!!slack && slack === APPROVER.slackId);
}

function identityKey(rec) {
  return String(rec.requester_email || rec.requester_name || "unknown").toLowerCase();
}

/* ---------------- helpers ---------------- */

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

/* Slack mrkdwn only needs these three neutralised. */
function slackSafe(s) {
  return String(s ?? "").replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]));
}

function ago(iso) {
  if (!iso) return "";
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 45) return "just now";
  if (s < 3600) return Math.floor(s / 60) + "m ago";
  if (s < 86400) return Math.floor(s / 3600) + "h ago";
  if (s < 86400 * 7) return Math.floor(s / 86400) + "d ago";
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function dur(ms) {
  if (!isFinite(ms) || ms <= 0) return "—";
  const s = ms / 1000;
  if (s < 90) return Math.round(s) + "s";
  if (s < 5400) return Math.round(s / 60) + "m";
  if (s < 86400 * 2) return (s / 3600).toFixed(1) + "h";
  return Math.round(s / 86400) + "d";
}

function initials(name) {
  const parts = String(name || "?").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  return (parts[0][0] + (parts[1] ? parts[1][0] : "")).toUpperCase();
}

function firstNameOf(rec) {
  return String(rec.requester_name || "").trim().split(/\s+/)[0] || "there";
}

function pct(n, d) {
  return d ? Math.round((n / d) * 100) : 0;
}

/* ---------------- snack categories ----------------
   Replaces the old icon picker: you type a snack, we tag it.
   Nothing to select, nothing to get wrong.                */

const CATEGORY_RULES = [
  ["DRINK", /coffee|latte|flat white|cappuccino|cortado|macchiato|mocha|espresso|americano|decaf|tea|matcha|juice|smoothie|soda|coke|pepsi|kombucha|sparkling|water|cold brew|chai|hot chocolate|milkshake|lemonade|red bull|celsius|energy/i],
  ["FRUIT", /apple|banana|orange|grape|berry|berries|mango|melon|peach|pear|pineapple|kiwi|plum|cherry|clementine|mandarin|fruit/i],
  ["SWEET", /cookie|brownie|chocolate|candy|cake|donut|doughnut|muffin|ice cream|gelato|pastry|croissant|danish|tart|pie|caramel|toffee|gummy|gummies|marshmallow|sweet|sugar|kitkat|snickers|oreo|maltesers|timbit/i],
  ["SAVOURY", /chip|chips|crisps|pretzel|popcorn|cracker|nuts|almond|cashew|peanut|jerky|hummus|olive|pickle|seaweed|wasabi|doritos|pringles|takis|salt/i],
  ["DAIRY", /yogurt|yoghurt|cheese|milk|kefir|skyr|cottage/i],
  ["BAKED", /bread|bagel|toast|scone|biscuit|roll|pizza|focaccia|sandwich|wrap|burrito|empanada|samosa/i],
  ["PROTEIN", /protein|bar|granola|egg|edamame|tofu|chicken|tuna|shake|oat/i],
  ["FROZEN", /popsicle|freezie|frozen|sorbet/i],
];

function categorise(snack) {
  const s = String(snack || "");
  for (const [name, re] of CATEGORY_RULES) if (re.test(s)) return name;
  return "UNCLASSIFIED";
}

/* ---------------- scoring ---------------- */

function scoreOne(s) {
  let xp = XP.LOG;
  if (s.status === "approved") xp += XP.APPROVED;
  if (s.status === "denied") xp += XP.DENIED;
  if (s.photo_url) xp += XP.PHOTO;
  if (s.plea) xp += XP.PLEA;
  return xp;
}

function levelOf(xp) {
  const level = Math.floor(xp / XP.PER_LEVEL) + 1;
  return {
    level,
    rank: RANKS[Math.min(level - 1, RANKS.length - 1)],
    into: xp % XP.PER_LEVEL,
    need: XP.PER_LEVEL,
    pct: Math.round(((xp % XP.PER_LEVEL) / XP.PER_LEVEL) * 100),
  };
}

function playerStats(all, key) {
  const k = String(key || "unknown").toLowerCase();
  const mine = all.filter((s) => identityKey(s) === k);
  const xp = mine.reduce((n, s) => n + scoreOne(s), 0);
  const approved = mine.filter((s) => s.status === "approved").length;
  const denied = mine.filter((s) => s.status === "denied").length;
  const pending = mine.filter((s) => s.status === "pending").length;
  const photos = mine.filter((s) => s.photo_url).length;
  const distinct = new Set(mine.map((s) => String(s.snack || "").trim().toLowerCase())).size;

  /* Current run of approvals, newest first, stopped by the first denial. */
  let streak = 0;
  for (const s of mine.filter((s) => s.status !== "pending")) {
    if (s.status === "approved") streak++;
    else break;
  }
  let best = 0, run = 0;
  for (const s of [...mine].reverse()) {
    if (s.status === "approved") { run++; best = Math.max(best, run); }
    else if (s.status === "denied") run = 0;
  }

  const counts = {};
  mine.forEach((s) => {
    const n = String(s.snack || "").trim();
    if (n) counts[n] = (counts[n] || 0) + 1;
  });
  const favourite = Object.entries(counts).sort((a, b) => b[1] - a[1])[0] || null;

  return {
    mine, xp, approved, denied, pending, photos, distinct, streak, bestStreak: best,
    favourite, decided: approved + denied, rate: pct(approved, approved + denied), ...levelOf(xp),
  };
}

const ACHIEVEMENTS = [
  { code: "A1", name: "FIRST BITE", desc: "Filed one request", has: (p) => p.mine.length >= 1 },
  { code: "A2", name: "APPROVED", desc: "Got a yes", has: (p) => p.approved >= 1 },
  { code: "A3", name: "DENIED", desc: "Got a no. Character building.", has: (p) => p.denied >= 1 },
  { code: "A4", name: "EVIDENCE", desc: "Attached a photo", has: (p) => p.photos >= 1 },
  { code: "A5", name: "ON A ROLL", desc: "Three approvals back to back", has: (p) => p.bestStreak >= 3 },
  { code: "A6", name: "REGULAR", desc: "Ten requests filed", has: (p) => p.mine.length >= 10 },
  { code: "A7", name: "NIGHT SHIFT", desc: "Filed after 22:00", has: (p) => p.mine.some((s) => new Date(s.created_at).getHours() >= 22) },
  { code: "A8", name: "EARLY BIRD", desc: "Filed before 08:00", has: (p) => p.mine.some((s) => new Date(s.created_at).getHours() < 8) },
  { code: "A9", name: "MONDAY MORALE", desc: "Filed on a Monday", has: (p) => p.mine.some((s) => new Date(s.created_at).getDay() === 1) },
  { code: "B1", name: "WORDSMITH", desc: "Wrote a plea over 100 characters", has: (p) => p.mine.some((s) => (s.plea || "").length > 100) },
  { code: "B2", name: "BROAD PALATE", desc: "Five different snacks", has: (p) => p.distinct >= 5 },
  { code: "B3", name: "CREATURE OF HABIT", desc: "Same snack three times", has: (p) => !!p.favourite && p.favourite[1] >= 3 },
  { code: "B4", name: "MARTYR", desc: "Five denials survived", has: (p) => p.denied >= 5 },
  { code: "B5", name: "LEVEL FIVE", desc: "Reached level 5", has: (p) => p.level >= 5 },
];

/* ---------------- leaderboard ---------------- */

/* Everyone who has ever asked. No cut-off, no top-six.  */
function leaderboard(all) {
  const by = new Map();
  all.forEach((s) => {
    const k = identityKey(s);
    if (!by.has(k)) {
      by.set(k, {
        key: k,
        name: s.requester_name || s.requester_email || "Someone",
        avatar: s.requester_avatar || "",
        xp: 0, n: 0, approved: 0, denied: 0, pending: 0, photos: 0,
        first: s.created_at, last: s.created_at, streak: 0, snacks: {},
      });
    }
    const r = by.get(k);
    if (s.requester_avatar && !r.avatar) r.avatar = s.requester_avatar;
    r.xp += scoreOne(s);
    r.n++;
    if (s.status === "approved") r.approved++;
    if (s.status === "denied") r.denied++;
    if (s.status === "pending") r.pending++;
    if (s.photo_url) r.photos++;
    if (s.created_at < r.first) r.first = s.created_at;
    if (s.created_at > r.last) r.last = s.created_at;
    const nm = String(s.snack || "").trim();
    if (nm) r.snacks[nm] = (r.snacks[nm] || 0) + 1;
  });

  return [...by.values()].map((r) => {
    const decided = r.approved + r.denied;
    const top = Object.entries(r.snacks).sort((a, b) => b[1] - a[1])[0];
    return Object.assign(r, {
      rate: pct(r.approved, decided),
      decided,
      usual: top ? top[0] : "",
      ...levelOf(r.xp),
    });
  });
}

const SORTS = {
  xp: { label: "XP", get: (r) => r.xp, fmt: (r) => r.xp + " XP" },
  approved: { label: "APPROVALS", get: (r) => r.approved, fmt: (r) => r.approved + " yes" },
  requests: { label: "REQUESTS", get: (r) => r.n, fmt: (r) => r.n + " filed" },
  rate: { label: "YES RATE", get: (r) => (r.decided >= 3 ? r.rate : -1), fmt: (r) => (r.decided >= 3 ? r.rate + "%" : "n/a") },
  denied: { label: "MOST DENIED", get: (r) => r.denied, fmt: (r) => r.denied + " no" },
};

function sortBoard(rows, key) {
  const s = SORTS[key] || SORTS.xp;
  return [...rows].sort((a, b) => s.get(b) - s.get(a) || b.xp - a.xp || a.name.localeCompare(b.name));
}

/* ---------------- office-wide stats ---------------- */

function officeStats(all) {
  const approved = all.filter((s) => s.status === "approved");
  const denied = all.filter((s) => s.status === "denied");
  const pending = all.filter((s) => s.status === "pending");
  const decided = approved.length + denied.length;

  const waits = all
    .filter((s) => s.decided_at && s.created_at)
    .map((s) => new Date(s.decided_at) - new Date(s.created_at))
    .filter((n) => n > 0)
    .sort((a, b) => a - b);
  const median = waits.length ? waits[Math.floor(waits.length / 2)] : 0;

  const oldestPending = pending.length
    ? pending.reduce((a, b) => (a.created_at < b.created_at ? a : b))
    : null;

  const byHour = new Array(24).fill(0);
  const byDay = new Array(7).fill(0);
  all.forEach((s) => {
    const d = new Date(s.created_at);
    if (!isNaN(d)) { byHour[d.getHours()]++; byDay[d.getDay()]++; }
  });

  const names = {};
  all.forEach((s) => {
    const n = String(s.snack || "").trim();
    if (n) {
      const k = n.toLowerCase();
      names[k] = names[k] || { label: n, n: 0, approved: 0 };
      names[k].n++;
      if (s.status === "approved") names[k].approved++;
    }
  });

  const cats = {};
  all.forEach((s) => {
    const c = s.category || categorise(s.snack);
    cats[c] = (cats[c] || 0) + 1;
  });

  const today = new Date().toDateString();
  const week = Date.now() - 7 * 86400000;

  return {
    total: all.length,
    approved: approved.length,
    denied: denied.length,
    pending: pending.length,
    rate: pct(approved.length, decided),
    medianWait: median,
    slowest: waits.length ? waits[waits.length - 1] : 0,
    fastest: waits.length ? waits[0] : 0,
    oldestPending,
    byHour,
    byDay,
    peakHour: byHour.indexOf(Math.max(...byHour)),
    topSnacks: Object.values(names).sort((a, b) => b.n - a.n).slice(0, 10),
    categories: Object.entries(cats).sort((a, b) => b[1] - a[1]),
    today: all.filter((s) => new Date(s.created_at).toDateString() === today).length,
    thisWeek: all.filter((s) => new Date(s.created_at).getTime() >= week).length,
    people: new Set(all.map(identityKey)).size,
    lastVerdict: all.filter((s) => s.decided_at).sort((a, b) => (a.decided_at < b.decided_at ? 1 : -1))[0] || null,
  };
}

/* ---------------- CSV export ---------------- */

function toCSV(rows) {
  const cols = ["created_at", "requester_name", "snack", "category", "size", "where", "status", "verdict_note", "decided_by", "decided_at"];
  const cell = (v) => {
    const s = String(v ?? "");
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  return [cols.join(","), ...rows.map((r) => cols.map((c) => cell(r[c])).join(","))].join("\n");
}

function download(filename, text, type = "text/csv") {
  const blob = new Blob([text], { type });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

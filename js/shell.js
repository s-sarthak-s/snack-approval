/* ==========================================================
   SNACK APPROVAL — shell
   Shared chrome for every page: header, navigation, identity,
   one data load, toasts, sound wiring, keyboard shortcuts.
   Each page sets window.PAGE and calls Shell.onData(render).
   ========================================================== */

const PAGES = [
  { id: "request",  label: "Request",  href: "/",              title: "File a request",   blurb: "Type what you want. Nothing else is required." },
  { id: "feed",     label: "Feed",     href: "/feed.html",     title: "Every request",    blurb: "The whole log, newest first, searchable." },
  { id: "board",    label: "Board",    href: "/board.html",    title: "All-time board",   blurb: "Everyone who has ever asked, ranked however you like." },
  { id: "stats",    label: "Stats",    href: "/stats.html",    title: "Office telemetry", blurb: "When this office snacks, and on what." },
  { id: "judge",    label: "Judge",    href: "/judge.html",    title: "Judgement room",   blurb: "One person rules here.", godOnly: true },
  { id: "settings", label: "Settings", href: "/settings.html", title: "Settings",         blurb: "Sound, display, and export." },
  { id: "admin",    label: "Admin",    href: "/admin.html",    title: "Admin",            blurb: "Who is here, what they asked for, and when.", ownerOnly: true },
];

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const Shell = {
  me: {},
  god: false,
  owner: false,
  all: [],
  attempts: [],
  loaded: false,
  page: window.PAGE || "request",
  handlers: [],
  signature: "",

  onData(cb) {
    this.handlers.push(cb);
    if (this.loaded) cb(this.all);
  },

  emit() {
    this.handlers.forEach((cb) => {
      try { cb(this.all); } catch (e) { console.error(e); }
    });
  },

  myKey() {
    return String(this.me.email || this.me.fullName || "unknown").toLowerCase();
  },

  player() {
    return playerStats(this.all, this.myKey());
  },

  stats() {
    return officeStats(this.all);
  },
};

/* ---------------- chrome ---------------- */

function navHTML(current, pending) {
  return PAGES.filter((p) => (!p.godOnly || Shell.god) && (!p.ownerOnly || Shell.owner))
    .map((p) => {
      const badge = p.id === "judge" && pending ? `<span class="count">${pending}</span>` : "";
      return `<a class="tab ${p.id === "judge" ? "god" : ""}${p.id === "admin" ? " owner" : ""}" href="${p.href}"
        aria-current="${p.id === current ? "page" : "false"}">${esc(p.label)}${badge}</a>`;
    })
    .join("");
}

function mountChrome() {
  const page = PAGES.find((p) => p.id === Shell.page) || PAGES[0];

  const header = document.createElement("header");
  header.className = "topbar";
  header.innerHTML = `
    <div class="topbar-in">
      <a class="brand" href="/">SNACK<span>APPROVAL</span> <small>v3</small></a>
      <span class="spacer"></span>
      <span class="led pulse" id="led" title="live"></span>
      <span class="who" id="who"><span class="muted">connecting…</span></span>
    </div>
    <nav class="tabs" id="tabs" aria-label="Pages"></nav>`;
  document.body.insertBefore(header, document.body.firstChild);

  const nav = document.createElement("nav");
  nav.className = "navbar";
  nav.id = "navbar";
  nav.setAttribute("aria-label", "Pages");
  document.body.appendChild(nav);

  const main = $("main");
  if (main && !$(".page-hd")) {
    const hd = document.createElement("div");
    hd.className = "page-hd";
    hd.innerHTML = `<h1>${esc(page.title)}</h1><p>${esc(page.blurb)}</p>`;
    main.insertBefore(hd, main.firstChild);
  }

  const extras = document.createElement("div");
  extras.innerHTML = `
    <div class="toast-wrap" id="toasts"></div>
    <div class="sheet" id="keysheet">
      <div class="card">
        <h3>Keyboard</h3>
        <div class="keys">
          <div><span>New request</span><kbd>N</kbd></div>
          <div><span>Search the feed</span><kbd>/</kbd></div>
          <div><span>Jump to a page</span><kbd>1</kbd><kbd>…</kbd><kbd>6</kbd></div>
          <div><span>Reload data</span><kbd>R</kbd></div>
          <div><span>Mute or unmute</span><kbd>M</kbd></div>
          <div><span>Close anything</span><kbd>Esc</kbd></div>
          <div><span>This list</span><kbd>?</kbd></div>
        </div>
        <div style="margin-top:16px"><button class="btn btn-sm" data-close="keysheet">Close</button></div>
      </div>
    </div>
    <div class="lightbox" id="lightbox"><img alt="snack photo" id="lightboximg"></div>
    <div class="boot" id="boot"><div class="lines" id="bootlines"></div></div>`;
  while (extras.firstElementChild) document.body.appendChild(extras.firstElementChild);

  if (main) {
    const foot = document.createElement("footer");
    foot.className = "pagefoot";
    foot.innerHTML = PAGES.filter((p) => (!p.godOnly || Shell.god)
        && (!p.ownerOnly || Shell.owner) && p.id !== Shell.page)
      .map((p) => `<a href="${p.href}">${esc(p.label)}</a>`)
      .join('<span class="dot">·</span>') +
      `<div class="tiny faint" style="margin-top:10px">Rulings by ${esc(APPROVER.name)}. Press <kbd>?</kbd> for shortcuts.</div>`;
    main.appendChild(foot);
  }

  paintNav();
}

function paintNav() {
  const pending = Shell.all.filter((s) => s.status === "pending").length;
  const html = navHTML(Shell.page, pending);
  const tabs = $("#tabs");
  const bar = $("#navbar");
  if (tabs) tabs.innerHTML = html;
  if (bar) bar.innerHTML = html;
}

function paintWho() {
  const el = $("#who");
  if (!el) return;
  el.innerHTML = Shell.me.fullName
    ? `${avatarHTML(Shell.me.fullName, Shell.me.slackImageUrl)}<b>${esc(Shell.me.firstName || Shell.me.fullName)}</b>${
        Shell.god ? '<span class="tag">authority</span>' : ""
      }`
    : `<span class="muted">signed out</span>`;
}

/* ---------------- toasts and flourishes ---------------- */

function toast(msg, kind = "") {
  const wrap = $("#toasts");
  if (!wrap) return;
  const el = document.createElement("div");
  el.className = "toast " + kind;
  el.textContent = msg;
  wrap.appendChild(el);
  setTimeout(() => {
    el.style.transition = "opacity .3s linear";
    el.style.opacity = "0";
    setTimeout(() => el.remove(), 320);
  }, kind === "err" ? 7000 : 4200);
  while (wrap.children.length > 3) wrap.firstChild.remove();
}

function floatText(text, x, y) {
  if (!PREFS.motion) return;
  const d = document.createElement("div");
  d.className = "floater";
  d.textContent = text;
  d.style.left = x + "px";
  d.style.top = y + "px";
  document.body.appendChild(d);
  setTimeout(() => d.remove(), 1200);
}

function shake(el) {
  if (!PREFS.shake || !PREFS.motion || !el) return;
  el.classList.remove("shake");
  void el.offsetWidth;
  el.classList.add("shake");
  setTimeout(() => el.classList.remove("shake"), 400);
}

/* ---------------- boot sequence ---------------- */

async function runBoot() {
  if (Shell.page !== "request") return;
  if (sessionStorage.getItem("snackapproval.booted") || !PREFS.boot || !PREFS.motion) return;
  sessionStorage.setItem("snackapproval.booted", "1");

  const box = $("#boot");
  const out = $("#bootlines");
  if (!box) return;
  box.classList.add("on");
  SFX.play("boot");

  const lines = [
    "SNACK APPROVAL SYSTEM  v3", "",
    "self test .............. ok",
    "pantry link ............ online",
    "authority .............. " + APPROVER.name.toUpperCase(),
    "requests ............... ready", "",
    "press any key",
  ];

  let text = "";
  for (const line of lines) {
    text += line + "\n";
    out.innerHTML = esc(text) + '<span class="cur">\u2588</span>';
    await new Promise((r) => setTimeout(r, line ? 80 : 30));
  }
  await new Promise((r) => {
    const done = () => { clearTimeout(t); r(); };
    const t = setTimeout(done, 650);
    window.addEventListener("keydown", done, { once: true });
    window.addEventListener("pointerdown", done, { once: true });
  });
  box.classList.remove("on");
}

/* ---------------- data ---------------- */

async function loadData(quiet = false) {
  try {
    const rows = await fetchAll();
    const sig = rows.map((r) => r.id + r.status).join("|");
    if (Shell.signature && sig !== Shell.signature && !quiet) announceChanges(Shell.all, rows);

    Shell.all = rows;
    Shell.signature = sig;
    Shell.loaded = true;
    const led = $("#led");
    if (led) led.className = "led pulse";

    if (Shell.god && Shell.page === "judge" && !Shell.attempts.length) {
      try { Shell.attempts = await ATTEMPTS().orderBy("created_at", "desc").limit(50).find(); }
      catch (e) { Shell.attempts = []; }
    }

    paintNav();
    Shell.emit();
  } catch (e) {
    const led = $("#led");
    if (led) led.className = "led bad";
    if (!quiet) toast("Could not reach the pantry database: " + (e.message || e), "err");
  }
}

/* Tell people when their own verdict lands while the page is open. */
function announceChanges(before, after) {
  const mine = Shell.myKey();
  const prev = new Map(before.map((r) => [r.id, r.status]));
  after.forEach((r) => {
    if (identityKey(r) !== mine) return;
    const was = prev.get(r.id);
    if (!was || was === r.status || r.status === "pending") return;
    if (r.status === "approved") {
      SFX.play("approve");
      toast(`Approved: ${r.snack}. ${r.verdict_note || "Go on then."}`, "ok");
    } else {
      SFX.play("deny");
      shake(document.body);
      toast(`Denied: ${r.snack}. ${r.verdict_note || "No reason given."}`, "err");
    }
  });
}

/* ---------------- shared events ---------------- */

function wireShell() {
  document.addEventListener("click", (e) => {
    const tab = e.target.closest(".tab, .brand");
    if (tab) { SFX.ui("move"); return; }

    const zoom = e.target.closest("[data-zoom]");
    if (zoom) {
      $("#lightboximg").src = zoom.dataset.zoom;
      $("#lightbox").classList.add("on");
      SFX.ui("open");
      return;
    }
    if (e.target.closest("#lightbox")) { $("#lightbox").classList.remove("on"); return; }

    const close = e.target.closest("[data-close]");
    if (close) { $("#" + close.dataset.close).classList.remove("on"); return; }
  });

  window.addEventListener("keydown", (e) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
    if (e.key === "Escape") {
      $("#lightbox")?.classList.remove("on");
      $("#keysheet")?.classList.remove("on");
      if (typing) e.target.blur();
      return;
    }
    if (typing || e.metaKey || e.ctrlKey || e.altKey) return;

    if (e.key === "?") { $("#keysheet").classList.add("on"); SFX.ui("open"); return; }
    if (e.key === "/") {
      e.preventDefault();
      if (Shell.page === "feed") $("#search")?.focus();
      else location.href = "/feed.html#search";
      return;
    }
    if (e.key.toLowerCase() === "n") {
      if (Shell.page === "request") $("#snack")?.focus();
      else location.href = "/";
      return;
    }
    if (e.key.toLowerCase() === "r") { SFX.ui("click"); loadData(); toast("Reloaded."); return; }
    if (e.key.toLowerCase() === "m") {
      PREFS.sound = !PREFS.sound;
      savePrefs();
      toast(PREFS.sound ? "Sound on." : "Sound off.");
      if (PREFS.sound) SFX.play("toggle");
      if (Shell.page === "settings") Shell.emit();
      return;
    }
    const n = Number(e.key);
    if (n >= 1 && n <= 9) {
      const p = PAGES.filter((x) => (!x.godOnly || Shell.god)
        && (!x.ownerOnly || Shell.owner))[n - 1];
      if (p) { SFX.ui("move"); location.href = p.href; }
    }
  });
}

/* ---------------- start ---------------- */

Shell.start = async function start() {
  applyPrefs();
  await loadConfig();
  mountChrome();
  wireShell();
  if (CONFIG_ERROR) {
    const main = $("main");
    if (main) {
      const warn = document.createElement("div");
      warn.className = "panel bad";
      warn.innerHTML = `<b>Not configured.</b><p class="tiny muted" style="margin:6px 0 0">`
        + esc(CONFIG_ERROR) + `</p>`;
      main.insertBefore(warn, main.firstChild.nextSibling || null);
    }
  }

  const bootJob = runBoot();
  Shell.me = (await quick.id.waitForUser()) || {};
  Shell.god = isGod(Shell.me);
  Shell.owner = isOwner(Shell.me);
  paintWho();
  paintNav();
  logVisit(Shell.me, Shell.page);

  await loadData(true);
  await bootJob;

  try {
    SNACKS().subscribe({
      onCreate: () => loadData(), onUpdate: () => loadData(), onDelete: () => loadData(), onError: () => {},
    });
  } catch (e) {}
  setInterval(() => loadData(true), 45000);
};

/* ==========================================================
   Page: Admin — the operator's view
   Owner only. Shows who has been on the site, when, on which
   page, alongside the request log and queue health.

   Same honest caveat as the judge room: this is a client-side
   check against a database anyone signed in can read. It keeps
   the page out of the way, it does not make the data secret.
   ========================================================== */

let VISIT_ROWS = [];
let VISIT_WINDOW = 7;      // days
let VISIT_LIMIT = 60;      // rows in the log table

async function loadVisits() {
  try {
    const rows = [];
    let offset = 0;
    while (offset < 3000) {
      const page = await VISITS().orderBy("at", "desc").limit(200).offset(offset).find();
      if (!Array.isArray(page) || !page.length) break;
      rows.push(...page);
      offset += page.length;
    }
    VISIT_ROWS = rows;
  } catch (e) {
    VISIT_ROWS = [];
  }
}

function withinDays(iso, days) {
  const t = new Date(iso || 0).getTime();
  return isFinite(t) && Date.now() - t <= days * 86400000;
}

/* One row per person: when they first showed up, when they were last seen,
   how many pages, and what they have actually asked for. */
function people(visits, requests) {
  const map = new Map();
  const touch = (email, name) => {
    const k = String(email || "unknown").toLowerCase();
    if (!map.has(k)) {
      map.set(k, { key: k, name: name || k, visits: 0, first: null, last: null,
                   pages: {}, requests: 0, approved: 0, denied: 0, pending: 0 });
    }
    const p = map.get(k);
    if (name && (!p.name || p.name === p.key)) p.name = name;
    return p;
  };

  visits.forEach((v) => {
    const p = touch(v.email, v.name);
    p.visits++;
    p.pages[v.page || "?"] = (p.pages[v.page || "?"] || 0) + 1;
    const at = v.at || v.created_at;
    if (!p.first || at < p.first) p.first = at;
    if (!p.last || at > p.last) p.last = at;
  });

  requests.forEach((r) => {
    const p = touch(r.requester_email, r.requester_name);
    p.requests++;
    if (r.status === "approved") p.approved++;
    if (r.status === "denied") p.denied++;
    if (r.status === "pending") p.pending++;
    const at = r.created_at;
    if (!p.first || at < p.first) p.first = at;
    if (!p.last || at > p.last) p.last = at;
  });

  return [...map.values()].sort((a, b) => String(b.last || "").localeCompare(String(a.last || "")));
}

function busiest(visits) {
  const byHour = new Array(24).fill(0);
  visits.forEach((v) => {
    const d = new Date(v.at || v.created_at);
    if (!isNaN(d)) byHour[d.getHours()]++;
  });
  return byHour;
}

function render() {
  const box = $("#adminroom");

  if (!Shell.owner) {
    box.innerHTML = `<div class="panel bad">
      <div class="lock">
        <div class="glyph">[ NOT YOURS ]</div>
        <h3>Operator dashboard</h3>
        <p>This page belongs to whoever runs the site. Nothing here affects your snacks.</p>
        <p class="tiny faint">Signed in as ${esc(Shell.me.email || "unknown")}</p>
        <div class="btn-row" style="max-width:260px;margin:18px auto 0">
          <a class="btn btn-sm" href="/">Back to requests</a>
        </div>
      </div></div>`;
    return;
  }

  const reqs = Shell.all;
  const st = Shell.stats();
  const recent = VISIT_ROWS.filter((v) => withinDays(v.at || v.created_at, VISIT_WINDOW));
  const today = VISIT_ROWS.filter((v) => withinDays(v.at || v.created_at, 1));
  const live = VISIT_ROWS.filter((v) => Date.now() - new Date(v.at || v.created_at).getTime() < 15 * 60000);
  const roster = people(recent, reqs);
  const mobile = recent.filter((v) => v.mobile).length;

  const cells = [
    ["acc", live.length, "Active in 15 min"],
    ["", new Set(today.map((v) => v.email)).size, "People today"],
    ["", today.length, "Page views today"],
    ["", recent.length, `Views in ${VISIT_WINDOW}d`],
    ["", new Set(VISIT_ROWS.map((v) => v.email)).size, "People ever"],
    ["", pct(mobile, recent.length) + "%", "On mobile"],
    ["acc", st.total, "Requests ever"],
    ["", st.pending, "Queue right now"],
    ["ok", st.rate + "%", "Yes rate"],
    ["", dur(st.medianWait), "Median ruling"],
  ];

  const pageCounts = {};
  recent.forEach((v) => { pageCounts[v.page || "?"] = (pageCounts[v.page || "?"] || 0) + 1; });

  box.innerHTML = `
    <div class="panel acc">
      <p style="margin:0">Only you see this page. It is a client-side check, not a lock:
      anyone signed in could read the same rows straight out of the database.
      The settings page tells people their visits are logged.</p>
    </div>

    <div class="sec-hd"><h2>Right now</h2><span class="rule"></span>
      <span class="hint" id="lastsync"></span></div>
    <div class="stat-grid">${cells.map(([cls, v, label]) =>
      `<div class="stat ${cls}"><b>${esc(String(v))}</b><span>${esc(label)}</span></div>`).join("")}</div>

    ${live.length ? `<div class="panel" style="margin-top:16px">
      <div class="mono-lbl">On the site in the last 15 minutes</div>
      <div class="chips" style="margin-top:8px">${
        [...new Map(live.map((v) => [v.email, v])).values()].map((v) =>
          `<span class="chip" style="cursor:default">${esc(v.name || v.email)}
            <span class="faint"> · ${esc(v.page)} · ${ago(v.at || v.created_at)}</span></span>`).join("")
      }</div></div>` : ""}

    <div class="sec-hd"><h2>Everyone, most recent first</h2><span class="rule"></span>
      <span class="hint">${roster.length} people</span></div>
    <div class="panel flush"><table class="tbl">
      <tr class="mono-lbl"><td>Person</td><td>Views</td><td>Requests</td><td>Y / N / wait</td>
        <td>First seen</td><td>Last seen</td></tr>
      ${roster.length ? roster.map((p) => `<tr>
        <td>${esc(p.name)}<br><span class="faint tiny">${esc(p.key)}</span></td>
        <td class="n">${p.visits}</td>
        <td class="n">${p.requests}</td>
        <td class="n">${p.approved} / ${p.denied} / ${p.pending}</td>
        <td class="faint">${esc(ago(p.first))}</td>
        <td>${esc(ago(p.last))}</td>
      </tr>`).join("") : `<tr><td class="muted">Nobody logged yet.</td></tr>`}
    </table></div>

    <div class="sec-hd"><h2>Pages opened</h2><span class="rule"></span></div>
    <div class="panel flush"><table class="tbl">${
      barTableHTML(Object.entries(pageCounts)
        .map(([label, n]) => ({ label, n }))
        .sort((a, b) => b.n - a.n))
    }</table></div>

    <div class="sec-hd"><h2>Visits by hour</h2><span class="rule"></span></div>
    <div class="panel">
      <div class="hist">${histHTML(busiest(recent))}</div>
      <div class="hist-axis"><span>00</span><span>06</span><span>12</span><span>18</span><span>23</span></div>
    </div>

    <div class="sec-hd"><h2>Visit log</h2><span class="rule"></span>
      <span class="hint">newest ${Math.min(VISIT_LIMIT, recent.length)} of ${VISIT_ROWS.length}</span></div>
    <div class="panel flush"><table class="tbl">
      ${recent.slice(0, VISIT_LIMIT).map((v) => `<tr>
        <td>${esc(v.name || v.email)}</td>
        <td class="g">${esc(v.page || "?")}${v.mobile ? ' <span class="tag">mobile</span>' : ""}</td>
        <td class="n">${esc(new Date(v.at || v.created_at).toLocaleString(undefined,
          { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }))}</td>
      </tr>`).join("") || `<tr><td class="muted">No visits in this window.</td></tr>`}
    </table></div>

    <div class="sec-hd"><h2>Every request, newest first</h2><span class="rule"></span>
      <span class="hint">${reqs.length} total</span></div>
    <div class="panel flush">${
      reqs.length ? reqs.slice(0, 40).map((s) => recHTML(s)).join("")
                  : `<div class="empty">No requests yet.</div>`}</div>

    <div class="sec-hd"><h2>Door log</h2><span class="rule"></span>
      <span class="hint">${Shell.attempts.length} tried the judge room</span></div>
    <div class="panel flush">${
      Shell.attempts.length ? Shell.attempts.slice(0, 20).map((a) => `<div class="rec">
        <div class="mark">!</div>
        <div class="body"><div class="ttl">${esc(a.name || a.email || "Unknown")}</div>
        <div class="meta">tried the judgement door<span class="dot">·</span>${ago(a.created_at)}</div></div>
      </div>`).join("") : `<div class="empty">Nobody has tried the door.</div>`}</div>

    <div class="sec-hd"><h2>Export</h2><span class="rule"></span></div>
    <div class="panel flush">
      <div class="setting">
        <div class="txt"><b>Visit log</b><span>${VISIT_ROWS.length} rows as CSV.</span></div>
        <div class="ctl"><button class="btn btn-sm" id="dlvisits">Download</button></div>
      </div>
      <div class="setting">
        <div class="txt"><b>All requests</b><span>${reqs.length} rows as CSV.</span></div>
        <div class="ctl"><button class="btn btn-sm" id="dlreqs">Download</button></div>
      </div>
      <div class="setting">
        <div class="txt"><b>Window</b><span>How far back the counts and the log reach.</span></div>
        <div class="ctl seg" id="window">
          ${[1, 7, 30, 3650].map((d) => `<button data-days="${d}" aria-pressed="${d === VISIT_WINDOW}">${
            d === 1 ? "24h" : d === 3650 ? "All" : d + "d"}</button>`).join("")}
        </div>
      </div>
    </div>`;

  const sync = $("#lastsync");
  if (sync) sync.textContent = "synced " + new Date().toLocaleTimeString();
}

document.addEventListener("click", (e) => {
  const win = e.target.closest("[data-days]");
  if (win) {
    VISIT_WINDOW = Number(win.dataset.days);
    SFX.ui("click");
    return render();
  }
  if (e.target.closest("#dlvisits")) {
    const cols = ["at", "name", "email", "page", "mobile", "screen", "tz", "referrer"];
    const cell = (v) => /[",\n]/.test(String(v ?? "")) ? '"' + String(v).replace(/"/g, '""') + '"' : String(v ?? "");
    download("snack-visits.csv",
      [cols.join(","), ...VISIT_ROWS.map((r) => cols.map((c) => cell(r[c])).join(","))].join("\n"));
    return toast("Visit log downloaded.", "ok");
  }
  if (e.target.closest("#dlreqs")) {
    download("snack-requests.csv", toCSV(Shell.all));
    return toast("Requests downloaded.", "ok");
  }
});

Shell.onData(render);

(async function boot() {
  await Shell.start();
  if (!Shell.owner) return;
  /* The judge room's door log is useful here too. */
  if (!Shell.attempts.length) {
    try { Shell.attempts = await ATTEMPTS().orderBy("created_at", "desc").limit(50).find(); }
    catch (e) { Shell.attempts = []; }
  }
  await loadVisits();
  render();
  setInterval(async () => { await loadVisits(); render(); }, 30000);
})();

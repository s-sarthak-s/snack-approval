/* ==========================================================
   SNACK APPROVAL — views
   Every function here returns an HTML string. All state lives
   in app.js; nothing in this file touches the network.
   ========================================================== */

const YES_REASONS = [
  "You have earned it",
  "It is Friday",
  "Take two",
];

const NO_REASONS = [
  "Too much sugar",
  "Not before lunch",
  "Share with the team",
  "You had one already",
  "I was not offered any",
];

function avatarHTML(name, url, cls = "") {
  if (url) return `<img class="avatar ${cls}" src="${esc(url)}" alt="" loading="lazy">`;
  return `<span class="avatar ${cls}">${esc(initials(name))}</span>`;
}

/* ---------------- one request row ---------------- */

function recHTML(s, opts = {}) {
  const v = VERDICT[s.status] || VERDICT.pending;
  const cat = s.category || categorise(s.snack);
  const bits = [esc(s.requester_name || "Someone"), ago(s.created_at)];
  if (s.where) bits.push(esc(s.where));
  if (s.size) bits.push(esc(String(s.size).toLowerCase()));

  const quote = s.plea ? `<div class="quote">${esc(s.plea)}</div>` : "";
  const shot = s.photo_url
    ? `<div class="shot"><img src="${esc(s.photo_url)}" alt="Photo for ${esc(s.snack)}" loading="lazy" data-zoom="${esc(s.photo_url)}"></div>`
    : "";

  let ruling = "";
  let flag = "";
  if (s.status !== "pending") {
    const who = s.decided_by || APPROVER.name;
    const legit = !s.decided_by_email || s.decided_by_email.toLowerCase() === APPROVER.email;
    const took = s.decided_at && s.created_at ? dur(new Date(s.decided_at) - new Date(s.created_at)) : null;
    const note = s.verdict_note
      ? `“${esc(s.verdict_note)}”`
      : s.status === "approved" ? "No conditions." : "No reason given.";
    ruling = `<div class="ruling"><b>${esc(who)}</b>${took ? ` · ruled in ${took}` : ""} — ${note}</div>`;
    if (!legit) flag = `<span class="badge unsanctioned" title="Not ruled by the snack approval authority">Unsanctioned</span>`;
  }

  const controls = opts.controls ? judgeControlsHTML(s) : "";

  return `<div class="rec ${v.cls}" data-rec="${esc(s.id)}">
    <div class="mark">${v.mark}</div>
    <div class="body">
      <div class="ttl">${esc(s.snack || "(unnamed snack)")} <span class="tag">${esc(cat)}</span></div>
      <div class="meta">${bits.join('<span class="dot">·</span>')}</div>
      ${quote}${shot}${ruling}${controls}
    </div>
    <div style="display:flex;flex-direction:column;gap:6px;align-items:flex-end">
      <span class="badge ${v.cls}">${v.label}</span>${flag}
    </div>
  </div>`;
}

/* Buttons first, reason optional, canned lines folded away. A queue of
   twelve chips per card was unreadable. */
function judgeControlsHTML(s) {
  const chips = (list, cls) => list
    .map((r) => `<button class="chip ${cls}" data-fill="${esc(r)}" data-for="${esc(s.id)}">${esc(r)}</button>`)
    .join("");
  return `<div class="stack" style="margin-top:13px">
    <div class="btn-row">
      <button class="btn btn-ok" data-act="approved" data-id="${esc(s.id)}">Approve</button>
      <button class="btn btn-bad" data-act="denied" data-id="${esc(s.id)}">Deny</button>
    </div>
    <input type="text" id="note-${esc(s.id)}" maxlength="140" autocomplete="off" placeholder="Reason (optional)">
    <details class="more slim">
      <summary>Canned reasons</summary>
      <div class="body"><div class="chips">${chips(YES_REASONS, "ok")}${chips(NO_REASONS, "bad")}</div></div>
    </details>
  </div>`;
}

/* ---------------- request tab ---------------- */

function playerCardHTML(me, p) {
  const name = me.fullName || me.email || "Anonymous snacker";
  const usual = p.favourite ? `${esc(p.favourite[0])} ×${p.favourite[1]}` : "nothing yet";
  return `<div class="player">
      ${avatarHTML(name, me.slackImageUrl, "lg")}
      <div style="min-width:0">
        <div class="nm">${esc(name)}</div>
        <div class="rk">Level ${p.level} · ${esc(p.rank)}</div>
      </div>
    </div>
    <div class="xp">
      <div class="track"><i style="width:${p.pct}%"></i></div>
      <div class="legend"><span>${p.into} / ${p.need} XP to level ${p.level + 1}</span><span>${p.xp} XP total</span></div>
    </div>
    <div class="stat-grid" style="margin-top:16px">
      <div class="stat ok"><b>${p.approved}</b><span>Approved</span></div>
      <div class="stat bad"><b>${p.denied}</b><span>Denied</span></div>
      <div class="stat"><b>${p.pending}</b><span>Waiting</span></div>
      <div class="stat acc"><b>${p.streak}</b><span>Streak</span></div>
      <div class="stat"><b>${p.decided ? p.rate + "%" : "—"}</b><span>Yes rate</span></div>
    </div>
    <p class="tiny faint" style="margin:12px 0 0">Usual order: ${usual}</p>`;
}

function achHTML(p) {
  return ACHIEVEMENTS.map((a) => {
    const got = a.has(p);
    return `<div class="ach ${got ? "" : "locked"}">
      <span class="code">${a.code}</span>
      <span><b>${esc(a.name)}</b><span>${got ? esc(a.desc) : "Locked"}</span></span>
    </div>`;
  }).join("");
}

function recentChipsHTML(p) {
  const seen = [];
  for (const s of p.mine) {
    const n = String(s.snack || "").trim();
    if (n && !seen.some((x) => x.toLowerCase() === n.toLowerCase())) seen.push(n);
    if (seen.length >= 5) break;
  }
  if (!seen.length) return "";
  return `<label class="lbl">Ask again</label>
    <div class="chips">${seen.map((n) => `<button class="chip" data-again="${esc(n)}">${esc(n)}</button>`).join("")}</div>`;
}

/* ---------------- board ---------------- */

function boardSortHTML(active) {
  return Object.entries(SORTS)
    .map(([k, s]) => `<button data-sort="${k}" aria-pressed="${k === active}">${esc(s.label)}</button>`)
    .join("");
}

function boardHTML(rows, sortKey, myKey) {
  if (!rows.length) return `<div class="empty">Nobody has asked for anything yet.</div>`;
  const fmt = (SORTS[sortKey] || SORTS.xp).fmt;
  return rows.map((r, i) => {
    const mine = r.key === myKey;
    const sub = [`L${r.level} ${r.rank}`, `${r.n} filed`, r.decided >= 3 ? `${r.rate}% yes` : null]
      .filter(Boolean).join(" · ");
    return `<div class="lb-row ${mine ? "me" : ""} ${i < 3 ? "top" : ""}">
      <span class="pos">${String(i + 1).padStart(2, "0")}</span>
      ${avatarHTML(r.name, r.avatar)}
      <span class="nm"><b>${esc(r.name)}${mine ? " — you" : ""}</b><span>${esc(sub)}</span></span>
      <span class="val">${esc(fmt(r))}<small>${r.approved} yes / ${r.denied} no</small></span>
    </div>`;
  }).join("");
}

/* ---------------- stats ---------------- */

function statGridHTML(st) {
  const cells = [
    ["", st.total, "Requests ever"],
    ["", st.people, "People involved"],
    ["ok", st.approved, "Approved"],
    ["bad", st.denied, "Denied"],
    ["acc", st.rate + "%", "Yes rate"],
    ["", st.pending, "Awaiting ruling"],
    ["", dur(st.medianWait), "Median ruling time"],
    ["", dur(st.slowest), "Longest ever wait"],
    ["acc", st.today, "Filed today"],
    ["", st.lastVerdict ? ago(st.lastVerdict.decided_at) : "—", "Last ruling"],
  ];
  return `<div class="stat-grid">${cells
    .map(([cls, v, label]) => `<div class="stat ${cls}"><b>${esc(String(v))}</b><span>${esc(label)}</span></div>`)
    .join("")}</div>`;
}

function histHTML(byHour) {
  const max = Math.max(1, ...byHour);
  const peak = byHour.indexOf(Math.max(...byHour));
  return byHour
    .map((n, h) => `<i class="${n && h === peak ? "hot" : ""}" style="height:${Math.round((n / max) * 100)}%" title="${String(h).padStart(2, "0")}:00 — ${n}"></i>`)
    .join("");
}

function barTableHTML(rows) {
  if (!rows.length) return `<tr><td class="muted">No data yet.</td></tr>`;
  const max = Math.max(1, ...rows.map((r) => r.n));
  return rows
    .map((r) => `<tr>
      <td>${esc(r.label)}</td>
      <td class="g"><span class="gtrack"><span class="gbar" style="width:${Math.max(2, Math.round((r.n / max) * 100))}%"></span></span></td>
      <td class="n">${r.n}${r.extra ? ` <span class="faint">${esc(r.extra)}</span>` : ""}</td>
    </tr>`)
    .join("");
}

/* ---------------- judge ---------------- */

function judgeHTML(all, st, attempts) {
  const pending = all.filter((s) => s.status === "pending");
  const decided = all.filter((s) => s.status !== "pending");
  return `<div class="panel acc">
      <p style="margin:0">Rulings are signed with your name and sent to the requester as a Slack DM.</p>
    </div>

    <div class="sec-hd"><h2>Waiting on you</h2><span class="rule"></span>
      <span class="hint">${pending.length} pending</span></div>
    ${pending.length > 1 ? `<div class="btn-row" style="margin-bottom:12px">
        <button class="btn btn-ok btn-sm" id="blessall">Approve all ${pending.length}</button>
        <button class="btn btn-sm" id="copyqueue">Copy queue as text</button>
      </div>` : ""}
    <div class="panel flush" id="queue">${
      pending.length
        ? pending.map((s) => recHTML(s, { controls: true })).join("")
        : `<div class="empty">Nothing waiting. The kitchen is calm.</div>`
    }</div>

    <div class="sec-hd"><h2>Your record</h2><span class="rule"></span></div>
    <div class="stat-grid">
      <div class="stat ok"><b>${st.approved}</b><span>Approved</span></div>
      <div class="stat bad"><b>${st.denied}</b><span>Denied</span></div>
      <div class="stat acc"><b>${st.rate}%</b><span>Mercy rate</span></div>
      <div class="stat"><b>${dur(st.medianWait)}</b><span>Median response</span></div>
      <div class="stat"><b>${st.oldestPending ? ago(st.oldestPending.created_at) : "—"}</b><span>Oldest wait</span></div>
    </div>

    <div class="sec-hd"><h2>Past rulings</h2><span class="rule"></span></div>
    <div class="panel flush">${
      decided.length
        ? decided.slice(0, 40).map((s) => recHTML(s)).join("")
        : `<div class="empty">No rulings yet.</div>`
    }</div>

    <div class="sec-hd"><h2>Door log</h2><span class="rule"></span><span class="hint">${attempts.length} attempts</span></div>
    <div class="panel flush">${
      attempts.length
        ? attempts.slice(0, 25).map((a) => `<div class="rec">
            <div class="mark">!</div>
            <div class="body">
              <div class="ttl">${esc(a.name || a.email || "Unknown")}</div>
              <div class="meta">tried the judgement door<span class="dot">·</span>${ago(a.created_at)}${a.note ? `<span class="dot">·</span>${esc(a.note)}` : ""}</div>
            </div>
          </div>`).join("")
        : `<div class="empty">Nobody has tried the door.</div>`
    }</div>`;
}

function lockHTML(me, p) {
  const name = me.firstName || me.fullName || "friend";
  return `<div class="panel bad">
      <div class="lock">
        <div class="glyph">[ LOCKED ]</div>
        <h3>This room belongs to ${esc(APPROVER.name)}</h3>
        <p>Sorry ${esc(name)} — rulings are the authority's job and nobody else's.
           The person who built this app is locked out of here too. That was the deal.</p>
        <p class="tiny faint">Signed in as ${esc(me.email || "unknown")}</p>
        <div class="btn-row" style="max-width:340px;margin:18px auto 0">
          <button class="btn btn-sm" id="petition">Send a polite nudge</button>
          <a class="btn btn-sm" href="/">Back to requests</a>
        </div>
      </div>
    </div>
    <div class="sec-hd"><h2>Where you stand</h2><span class="rule"></span></div>
    <div class="stat-grid">
      <div class="stat"><b>${p.mine.length}</b><span>Requests filed</span></div>
      <div class="stat ok"><b>${p.approved}</b><span>Approved</span></div>
      <div class="stat bad"><b>${p.denied}</b><span>Denied</span></div>
      <div class="stat acc"><b>${p.pending}</b><span>Waiting on a ruling</span></div>
    </div>`;
}

/* ---------------- settings ---------------- */

function switchHTML(key, label, blurb) {
  return `<div class="setting">
    <div class="txt"><b>${esc(label)}</b><span>${esc(blurb)}</span></div>
    <div class="ctl"><button class="sw" role="switch" data-pref="${key}"
      aria-pressed="${!!PREFS[key]}" aria-label="${esc(label)}"></button></div>
  </div>`;
}

function settingsSoundHTML() {
  const pack = PACKS[PREFS.pack] || PACKS.arcade;
  return switchHTML("sound", "Sound effects", "Chiptune blips generated in the browser. No audio files.") +
    `<div class="setting">
      <div class="txt"><b>Volume</b><span>Currently ${Math.round(PREFS.volume * 100)}%</span></div>
      <div class="ctl"><input type="range" id="vol" min="0" max="100" value="${Math.round(PREFS.volume * 100)}"></div>
    </div>
    <div class="setting" style="flex-wrap:wrap">
      <div class="txt"><b>Sound pack</b><span>${esc(pack.blurb)}</span></div>
      <div class="ctl seg" id="packs">${Object.entries(PACKS)
        .map(([k, p]) => `<button data-pack="${k}" aria-pressed="${k === PREFS.pack}">${esc(p.label)}</button>`)
        .join("")}</div>
    </div>` +
    switchHTML("clicks", "Interface clicks", "The small ticks on taps and tab changes. Verdict sounds stay either way.");
}

function settingsScreenHTML() {
  const themes = { amber: "#ffb020", phosphor: "#3ddc7f", ice: "#6fc9ff", paper: "#b8501e" };
  return `<div class="setting">
      <div class="txt"><b>Colour</b><span>Amber CRT, green phosphor, cold blue, or dot-matrix paper.</span></div>
      <div class="ctl swatches" id="themes">${Object.entries(themes)
        .map(([k, c]) => `<button class="swatch" data-theme-set="${k}" aria-pressed="${k === PREFS.theme}" title="${k}"><i style="background:${c}"></i></button>`)
        .join("")}</div>
    </div>` +
    switchHTML("scanlines", "Scanlines", "Off looks like a flat LCD.") +
    switchHTML("flicker", "Screen flicker", "Occasional dimming, like a tube warming up. Off by default for a reason.") +
    switchHTML("motion", "Animations", "Row fades and bar fills. Off means instant.") +
    switchHTML("shake", "Shake on denial", "The screen flinches when a request is turned down.") +
    switchHTML("boot", "Boot sequence", "Terminal start-up text on first load of a session.") +
    `<div class="setting">
      <div class="txt"><b>Density</b><span>Compact tightens the padding for small screens.</span></div>
      <div class="ctl seg" id="density">
        <button data-density="cosy" aria-pressed="${PREFS.density === "cosy"}">Cosy</button>
        <button data-density="compact" aria-pressed="${PREFS.density === "compact"}">Compact</button>
      </div>
    </div>`;
}

function settingsDataHTML(count) {
  return `<div class="setting">
      <div class="txt"><b>Export everything</b><span>${count} requests as a CSV file.</span></div>
      <div class="ctl"><button class="btn btn-sm" id="exportcsv">Download CSV</button></div>
    </div>
    <div class="setting">
      <div class="txt"><b>Export my requests</b><span>Only your own rows, as JSON.</span></div>
      <div class="ctl"><button class="btn btn-sm" id="exportmine">Download JSON</button></div>
    </div>
    <div class="setting">
      <div class="txt"><b>Share this app</b><span>Copy the link for the group chat.</span></div>
      <div class="ctl"><button class="btn btn-sm" id="copylink">Copy link</button></div>
    </div>
    <div class="setting">
      <div class="txt"><b>Reset preferences</b><span>Back to defaults. Your requests are untouched.</span></div>
      <div class="ctl"><button class="btn btn-sm btn-bad" id="resetprefs">Reset</button></div>
    </div>`;
}

function aboutHTML(st, me) {
  return `<p style="margin:0 0 10px">Requests are filed here and ruled on by ${esc(APPROVER.name)}, who gets a
    Slack message for each one and answers from a room only he can open. Verdicts come back as a DM.</p>
    <p style="margin:0 0 10px">${st.total} requests from ${st.people} people are stored so far. Data lives in this site's
    Quick database — treat everything here as visible to anyone at Shopify who opens the page.</p>
    <p style="margin:0 0 10px">Page visits are logged — who opened which page and when — and the
    person who runs this can see that list. Requests, names, and photos are visible to everyone.</p>
    <p style="margin:0">Signed in as ${esc(me.email || "unknown")}. Press <kbd>?</kbd> for keyboard shortcuts.</p>`;
}

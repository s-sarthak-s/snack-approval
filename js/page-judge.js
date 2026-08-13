/* ==========================================================
   Page: Judge — the only room with a lock on it
   Access belongs to the configured approver alone. Whoever built and deploys
   the app is deliberately not on the list.
   ========================================================== */

const FOCUS_ID = new URLSearchParams(location.search).get("id");

function render() {
  const box = $("#judgeroom");

  if (!Shell.god) {
    box.innerHTML = lockHTML(Shell.me, Shell.player());
    return;
  }

  box.innerHTML = judgeHTML(Shell.all, Shell.stats(), Shell.attempts);

  if (FOCUS_ID) {
    const el = box.querySelector(`[data-rec="${FOCUS_ID}"]`);
    if (el) {
      el.scrollIntoView({ block: "center", behavior: PREFS.motion ? "smooth" : "auto" });
      el.classList.add("flash");
    } else {
      toast("That request has already been ruled on.");
    }
  }
}

/* ---------------- rulings ---------------- */

async function decide(id, status, silent = false) {
  if (!Shell.god) { SFX.play("lock"); return toast(`Only ${APPROVER.name} can rule on requests.`, "err"); }

  const input = $("#note-" + id);
  const note = input ? input.value.trim() : "";
  $$(`button[data-id="${id}"]`).forEach((b) => (b.disabled = true));

  try {
    const s = await SNACKS().findById(id);
    if (!s) throw new Error("That request no longer exists");

    const by = Shell.me.fullName || Shell.me.email || APPROVER.name;
    await SNACKS().update(id, {
      status,
      verdict_note: note,
      decided_by: by,
      decided_by_email: String(Shell.me.email || "").toLowerCase(),
      decided_at: new Date().toISOString(),
    });

    await tellRequester(s, status, note, by);

    if (!silent) {
      SFX.play(status === "approved" ? "approve" : "deny");
      toast(`${status === "approved" ? "Approved" : "Denied"} — ${s.requester_name || "they"} have been told.`,
        status === "approved" ? "ok" : "");
      await loadData(true);
    }
  } catch (e) {
    SFX.play("error");
    toast("Ruling failed: " + (e.message || e), "err");
    $$(`button[data-id="${id}"]`).forEach((b) => (b.disabled = false));
  }
}

async function tellRequester(s, status, note, by) {
  const approved = status === "approved";
  const first = slackSafe(firstNameOf(s));
  const headline = approved ? "Snack approved" : "Snack denied";
  const text = `${headline}: ${s.snack}`;
  const b = quick.slack.createBlocks()
    .header(headline)
    .section(approved
      ? `${first}, your request for *${slackSafe(s.snack)}* is approved. Enjoy it.`
      : `${first}, your request for *${slackSafe(s.snack)}* is denied.`)
    .fields([
      { title: "Ruled by", value: slackSafe(by) },
      { title: "XP", value: `+${approved ? XP.APPROVED : XP.DENIED}` },
    ])
    .section(note ? `Reason: _"${slackSafe(note)}"_` : (approved ? "_No conditions._" : "_No reason given._"))
    .divider()
    .section(`<${SITE_URL()}/|Open snack approval>`);

  if (s.requester_slack) {
    try { await quick.slack.sendMessage(s.requester_slack, text, { blocks: b.build() }); }
    catch (e) { toast("Ruling saved, but the DM failed: " + (e.message || e), "err"); }
  }
  if (s.slack_ts) {
    try { await quick.slack.sendMessage(APPROVER.slackId, text, { thread_ts: s.slack_ts }); } catch (e) {}
  }
}

async function approveAll() {
  const pending = Shell.all.filter((s) => s.status === "pending");
  if (!pending.length) return;
  if (!confirm(`Approve all ${pending.length} pending requests?`)) return;
  toast("Working through the queue…");
  for (const s of pending) await decide(s.id, "approved", true);
  SFX.play("level");
  toast(`Approved ${pending.length}. Generous.`, "ok");
  await loadData(true);
}

/* ---------------- the locked door ---------------- */

async function petition() {
  const key = "snackapproval.petition";
  const last = Number(localStorage.getItem(key) || 0);
  if (Date.now() - last < 2 * 3600 * 1000) {
    SFX.play("lock");
    return toast("You already nudged him. Give it a couple of hours.", "err");
  }
  try {
    await ATTEMPTS().create({
      name: Shell.me.fullName || "Unknown",
      email: Shell.me.email || "",
      slack: Shell.me.slackId || "",
      note: "asked for access",
    });
    await quick.slack.sendMessage(
      APPROVER.slackId,
      `${slackSafe(Shell.me.fullName || "Someone")} tried the judgement room door on snack approval. It held.`
    );
    localStorage.setItem(key, String(Date.now()));
    SFX.play("toggle");
    toast("He has been informed. The door stays shut.", "ok");
  } catch (e) {
    SFX.play("error");
    toast("Could not send that: " + (e.message || e), "err");
  }
}

/* ---------------- wiring ---------------- */

document.addEventListener("click", (e) => {
  const fill = e.target.closest("[data-fill]");
  if (fill) {
    const box = $("#note-" + fill.dataset.for);
    if (box) { box.value = fill.dataset.fill; box.focus(); }
    SFX.ui("click");
    return;
  }

  const act = e.target.closest("[data-act]");
  if (act) { decide(act.dataset.id, act.dataset.act); return; }

  if (e.target.closest("#blessall")) { approveAll(); return; }
  if (e.target.closest("#petition")) { petition(); return; }
  if (e.target.closest("#copyqueue")) {
    const text = Shell.all.filter((s) => s.status === "pending")
      .map((s) => `- ${s.snack} (${s.requester_name})`).join("\n");
    if (navigator.clipboard) navigator.clipboard.writeText(text || "Queue is empty");
    toast("Queue copied.", "ok");
  }
});

Shell.onData(render);
Shell.start();

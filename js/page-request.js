/* ==========================================================
   Page: Request — file a snack request
   ========================================================== */

let PHOTO = null;

function render(all) {
  const p = Shell.player();
  const st = Shell.stats();

  $("#playercard").innerHTML = playerCardHTML(Shell.me, p);
  $("#ach").innerHTML = achHTML(p);
  $("#achcount").textContent = ACHIEVEMENTS.filter((a) => a.has(p)).length + " of " + ACHIEVEMENTS.length;
  $("#recent").innerHTML = recentChipsHTML(p);
  $("#queuehint").textContent = st.pending
    ? st.pending + (st.pending === 1 ? " request is" : " requests are") + " waiting on a ruling."
    : "The queue is empty.";

  $("#mine").innerHTML = p.mine.length
    ? p.mine.slice(0, 5).map((s) => recHTML(s)).join("")
    : `<div class="empty">You have not asked for anything yet.<br>The box above takes about four seconds.</div>`;

  /* Type-ahead from everything ever requested, so nobody spells it out twice. */
  const names = [...new Set(all.map((s) => String(s.snack || "").trim()).filter(Boolean))].slice(0, 400);
  $("#known-snacks").innerHTML = names.map((n) => `<option value="${esc(n)}">`).join("");
}

/* ---------------- submit ---------------- */

async function submitRequest() {
  const input = $("#snack");
  const btn = $("#send");
  const snack = input.value.trim();

  if (!snack) {
    SFX.play("error");
    shake(input);
    input.focus();
    return toast("Type what you want first.", "err");
  }

  btn.disabled = true;
  const label = btn.textContent;
  btn.textContent = "Sending…";
  SFX.play("send");

  try {
    const before = Shell.player();
    const plea = $("#plea").value.trim();
    const rec = await SNACKS().create({
      snack,
      category: categorise(snack),
      where: $("#where").value.trim(),
      size: $("#size").value,
      plea,
      photo_url: PHOTO ? PHOTO.url : "",
      photo_full_url: PHOTO ? PHOTO.fullUrl : "",
      status: "pending",
      verdict_note: "",
      decided_by: null,
      decided_by_email: null,
      decided_at: null,
      requester_name: Shell.me.fullName || Shell.me.email || "Someone",
      requester_email: Shell.me.email || "",
      requester_slack: Shell.me.slackId || "",
      requester_avatar: Shell.me.slackImageUrl || "",
      requester_handle: Shell.me.slackHandle || "",
    });

    await notifyAuthority(rec, before);

    const gained = XP.LOG + (PHOTO ? XP.PHOTO : 0) + (plea ? XP.PLEA : 0);
    const box = btn.getBoundingClientRect();
    floatText(`+${gained} XP`, box.left + box.width / 2 - 24, box.top - 8);

    input.value = "";
    $("#plea").value = "";
    $("#where").value = "";
    clearPhoto();
    $("#detailsbox").open = false;

    await loadData(true);
    const after = Shell.player();
    if (after.level > before.level) {
      SFX.play("level");
      toast(`Level ${after.level} — ${after.rank}.`, "ok");
    }
  } catch (e) {
    SFX.play("error");
    toast("Could not file that: " + (e.message || e), "err");
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

async function notifyAuthority(rec, before) {
  const url = `${SITE_URL()}/judge.html?id=${rec.id}`;
  const who = slackSafe(rec.requester_name);
  const first = slackSafe(String(rec.requester_name || "").split(" ")[0] || "someone");
  const b = quick.slack.createBlocks()
    .header("Snack request")
    .section(`*${who}* would like to eat *${slackSafe(rec.snack)}*.\n\nYour ruling, please.`)
    .fields([
      { title: "Snack", value: slackSafe(rec.snack) },
      { title: "Type", value: rec.category || "unclassified" },
      { title: "Portion", value: rec.size || "not stated" },
      { title: "From", value: rec.where || "not stated" },
      { title: "Requester", value: `${first} — level ${before.level}, ${before.rank.toLowerCase()}` },
      { title: "Record", value: `${before.approved} approved / ${before.denied} denied` },
    ]);
  if (rec.plea) b.section(`Their case: _"${slackSafe(rec.plea)}"_`);
  if (rec.photo_full_url) b.section(`<${rec.photo_full_url}|Photo evidence>`);
  b.divider().section(`<${url}|Open the judgement room>`);

  try {
    const msg = await quick.slack.sendMessage(
      APPROVER.slackId,
      `${who} is asking to eat ${rec.snack}.`,
      { blocks: b.build() }
    );
    const ts = msg && msg.slack_response && msg.slack_response.ts;
    if (ts) await SNACKS().update(rec.id, { slack_ts: ts });
    toast(`Sent to ${APPROVER.short.toLowerCase()}. Watch Slack for the verdict.`, "ok");
  } catch (e) {
    toast("Request saved, but the Slack message failed: " + (e.message || e), "err");
  }
}

/* ---------------- photo ---------------- */

async function handleFile(file) {
  if (!file) return;
  if (!file.type.startsWith("image/")) { SFX.play("error"); return toast("That is not an image.", "err"); }
  if (file.size > 8 * 1024 * 1024) { SFX.play("error"); return toast("Too big — 8 MB is the ceiling.", "err"); }

  const wrap = $("#progwrap");
  const bar = $("#prog");
  wrap.style.display = "";
  bar.style.width = "6%";
  try {
    const res = await quick.fs.uploadFile(file, {
      onProgress: ({ percentage }) => (bar.style.width = Math.max(6, percentage || 0) + "%"),
    });
    bar.style.width = "100%";
    PHOTO = { url: res.url, fullUrl: res.fullUrl || SITE_URL() + res.url };
    $("#preview").innerHTML = `<div class="thumb">
        <img src="${esc(PHOTO.url)}" alt="Attached photo">
        <div><p class="tiny muted" style="margin:0 0 8px">Attached. Worth +${XP.PHOTO} XP.</p>
        <button class="btn btn-sm" id="rmphoto" type="button">Remove</button></div>
      </div>`;
    $("#rmphoto").onclick = clearPhoto;
    SFX.ui("open");
    setTimeout(() => (wrap.style.display = "none"), 600);
  } catch (e) {
    SFX.play("error");
    wrap.style.display = "none";
    toast("Upload failed: " + (e.message || e), "err");
  }
}

function clearPhoto() {
  PHOTO = null;
  $("#preview").innerHTML = "";
  $("#file").value = "";
}

/* ---------------- wiring ---------------- */

$("#size").innerHTML = PORTIONS.map((p, i) =>
  `<option ${i === 1 ? "selected" : ""}>${esc(p)}</option>`).join("");

$("#send").onclick = submitRequest;
$("#snack").addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); submitRequest(); }
});
$("#pleagen").onclick = () => {
  $("#plea").value = PLEAS[Math.floor(Math.random() * PLEAS.length)];
  SFX.ui("click");
};

document.addEventListener("click", (e) => {
  const again = e.target.closest("[data-again]");
  if (again) {
    $("#snack").value = again.dataset.again;
    $("#snack").focus();
    SFX.ui("click");
  }
});

const drop = $("#drop");
drop.onclick = () => $("#file").click();
$("#file").onchange = (e) => handleFile(e.target.files[0]);
["dragenter", "dragover"].forEach((ev) =>
  drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("over"); }));
["dragleave", "drop"].forEach((ev) =>
  drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("over"); }));
drop.addEventListener("drop", (e) => handleFile(e.dataTransfer && e.dataTransfer.files[0]));
window.addEventListener("paste", (e) => {
  const item = [...((e.clipboardData && e.clipboardData.items) || [])].find((i) => i.type.startsWith("image/"));
  if (item) { $("#detailsbox").open = true; handleFile(item.getAsFile()); }
});

Shell.onData(render);
Shell.start();

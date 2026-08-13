/* ==========================================================
   Page: Feed — every request, filtered and searched
   ========================================================== */

const F = { filter: "all", query: "", limit: 25 };

function rows() {
  const q = F.query.trim().toLowerCase();
  const mine = Shell.myKey();
  return Shell.all.filter((s) => {
    if (F.filter === "mine" && identityKey(s) !== mine) return false;
    if (F.filter === "photo" && !s.photo_url) return false;
    if (["pending", "approved", "denied"].includes(F.filter) && s.status !== F.filter) return false;
    if (!q) return true;
    return [s.snack, s.requester_name, s.verdict_note, s.plea, s.where, s.category || categorise(s.snack)]
      .some((v) => String(v || "").toLowerCase().includes(q));
  });
}

function render() {
  const all = rows();
  const shown = all.slice(0, F.limit);
  $("#feed").innerHTML = shown.length
    ? shown.map((s) => recHTML(s)).join("")
    : `<div class="empty">Nothing matches that.<br>Try another filter.</div>`;

  const total = Shell.all.length;
  $("#feedcount").textContent = all.length === total
    ? `${total} requests in total`
    : `${all.length} of ${total} requests`;

  const more = $("#feedmore");
  more.style.display = all.length > shown.length ? "" : "none";
  more.textContent = `Show more (${all.length - shown.length} left)`;
}

$("#feedfilter").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  F.filter = b.dataset.f;
  F.limit = 25;
  $$("#feedfilter button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
  SFX.ui("click");
  render();
});

$("#search").addEventListener("input", (e) => {
  F.query = e.target.value;
  F.limit = 25;
  render();
});

$("#feedmore").onclick = () => { F.limit += 25; SFX.ui("click"); render(); };

if (location.hash === "#search") setTimeout(() => $("#search").focus(), 120);

Shell.onData(render);
Shell.start();

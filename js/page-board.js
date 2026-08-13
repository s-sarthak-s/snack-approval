/* ==========================================================
   Page: Board — the all-time leaderboard
   ========================================================== */

let sortKey = new URLSearchParams(location.search).get("by") || "xp";
if (!SORTS[sortKey]) sortKey = "xp";

function render() {
  const rows = sortBoard(leaderboard(Shell.all), sortKey);
  $("#boardsort").innerHTML = boardSortHTML(sortKey);
  $("#board").innerHTML = boardHTML(rows, sortKey, Shell.myKey());
  $("#boardcount").textContent = rows.length
    ? `${rows.length} ${rows.length === 1 ? "person has" : "people have"} asked, ${Shell.all.length} requests between them`
    : "";

  $("#xprules").innerHTML = [
    ["Filing a request", `+${XP.LOG} XP`],
    ["Getting approved", `+${XP.APPROVED} XP`],
    ["Getting denied anyway", `+${XP.DENIED} XP`],
    ["Attaching a photo", `+${XP.PHOTO} XP`],
    ["Writing your case", `+${XP.PLEA} XP`],
    ["Next level", `every ${XP.PER_LEVEL} XP`],
  ].map(([k, v]) => `<tr><td>${esc(k)}</td><td class="n">${esc(v)}</td></tr>`).join("");
}

$("#boardsort").addEventListener("click", (e) => {
  const b = e.target.closest("[data-sort]");
  if (!b) return;
  sortKey = b.dataset.sort;
  SFX.ui("click");
  history.replaceState(null, "", "?by=" + sortKey);
  render();
});

Shell.onData(render);
Shell.start();

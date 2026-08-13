/* ==========================================================
   Page: Stats — office-wide telemetry
   ========================================================== */

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function render() {
  const st = Shell.stats();

  $("#statgrid").innerHTML = statGridHTML(st);
  $("#hist").innerHTML = histHTML(st.byHour);
  $("#peakhint").textContent = st.total
    ? "busiest around " + String(st.peakHour).padStart(2, "0") + ":00"
    : "";

  $("#weekdays").innerHTML = barTableHTML(st.byDay.map((n, i) => ({ label: DAY_NAMES[i], n })));
  $("#topsnacks").innerHTML = barTableHTML(
    st.topSnacks.map((r) => ({ label: r.label, n: r.n, extra: r.n >= 2 ? pct(r.approved, r.n) + "% yes" : "" }))
  );
  $("#cats").innerHTML = barTableHTML(st.categories.map(([label, n]) => ({ label, n })));

  $("#oldest").innerHTML = st.oldestPending
    ? recHTML(st.oldestPending)
    : `<div class="empty">Nothing is waiting. Unusually responsive.</div>`;
}

Shell.onData(render);
Shell.start();

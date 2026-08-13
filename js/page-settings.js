/* ==========================================================
   Page: Settings — sound, screen, data
   ========================================================== */

function render() {
  const st = Shell.stats();
  $("#set-sound").innerHTML = settingsSoundHTML();
  $("#set-screen").innerHTML = settingsScreenHTML();
  $("#set-data").innerHTML = settingsDataHTML(st.total);
  $("#about").innerHTML = aboutHTML(st, Shell.me);
}

document.addEventListener("click", (e) => {
  const sw = e.target.closest(".sw");
  if (sw) {
    const key = sw.dataset.pref;
    PREFS[key] = !PREFS[key];
    sw.setAttribute("aria-pressed", String(!!PREFS[key]));
    savePrefs();
    if (key === "sound" && PREFS.sound) { SFX.unlock(); SFX.play("toggle"); }
    else SFX.ui("click");
    return;
  }

  const pack = e.target.closest("[data-pack]");
  if (pack) {
    PREFS.pack = pack.dataset.pack;
    savePrefs();
    SFX.unlock();
    SFX.play("send");
    return render();
  }

  const theme = e.target.closest("[data-theme-set]");
  if (theme) {
    PREFS.theme = theme.dataset.themeSet;
    savePrefs();
    SFX.ui("toggle");
    return render();
  }

  const dens = e.target.closest("[data-density]");
  if (dens) {
    PREFS.density = dens.dataset.density;
    savePrefs();
    SFX.ui("click");
    return render();
  }

  if (e.target.closest("#exportcsv")) {
    download("snack-approval-all.csv", toCSV(Shell.all));
    return toast("CSV downloaded.", "ok");
  }
  if (e.target.closest("#exportmine")) {
    const mine = Shell.all.filter((s) => identityKey(s) === Shell.myKey());
    download("snack-approval-mine.json", JSON.stringify(mine, null, 2), "application/json");
    return toast(`${mine.length} of your requests downloaded.`, "ok");
  }
  if (e.target.closest("#copylink")) {
    if (navigator.clipboard) navigator.clipboard.writeText(SITE_URL() + "/");
    return toast("Link copied.", "ok");
  }
  if (e.target.closest("#resetprefs")) {
    resetPrefs();
    render();
    return toast("Preferences reset.", "ok");
  }
});

document.addEventListener("input", (e) => {
  if (e.target.id !== "vol") return;
  SFX.setVolume(Number(e.target.value) / 100);
  savePrefs();
  const txt = e.target.closest(".setting").querySelector(".txt span");
  if (txt) txt.textContent = `Currently ${e.target.value}%`;
});

document.addEventListener("change", (e) => {
  if (e.target.id === "vol") SFX.play("toggle");
});

Shell.onData(render);
Shell.start();

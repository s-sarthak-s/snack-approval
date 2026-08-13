/* ==========================================================
   SNACK APPROVAL — sound
   Pure WebAudio chiptune. No audio files, no network, no CDN.
   Three packs, master volume, and a hard mute that sticks.
   ========================================================== */

const PACKS = {
  arcade: {
    label: "ARCADE",
    blurb: "Square waves. Cabinet in the corner of a 1987 pizza place.",
    wave: "square",
    gain: 0.09,
    detune: 0,
    glide: 0,
  },
  beeper: {
    label: "BEEPER",
    blurb: "Thin one-bit pulses. Sounds like a machine that owes you money.",
    wave: "square",
    gain: 0.055,
    detune: 1200,
    glide: 0,
  },
  soft: {
    label: "SOFT",
    blurb: "Rounded sine tones. For open-plan offices and thin walls.",
    wave: "sine",
    gain: 0.13,
    detune: -1200,
    glide: 0.01,
  },
};

/* note name -> frequency, so the sequences below stay readable */
const NOTE = (() => {
  const base = { C: -9, D: -7, E: -5, F: -4, G: -2, A: 0, B: 2 };
  const map = {};
  for (const [n, semi] of Object.entries(base)) {
    for (let oct = 2; oct <= 7; oct++) {
      map[n + oct] = 440 * Math.pow(2, (semi + (oct - 4) * 12) / 12);
      map[n + "s" + oct] = 440 * Math.pow(2, (semi + 1 + (oct - 4) * 12) / 12);
    }
  }
  return map;
})();

const SEQ = {
  click: [["E5", 0.03]],
  move: [["C5", 0.025], ["G5", 0.03]],
  open: [["G4", 0.04], ["C5", 0.05]],
  close: [["C5", 0.04], ["G4", 0.05]],
  send: [["G4", 0.06], ["C5", 0.06], ["E5", 0.06], ["G5", 0.12]],
  approve: [["C5", 0.07], ["E5", 0.07], ["G5", 0.07], ["C6", 0.2]],
  deny: [["E4", 0.1], ["C4", 0.1], ["G3", 0.24]],
  error: [["A3", 0.08], ["F3", 0.14]],
  level: [["C5", 0.06], ["D5", 0.06], ["E5", 0.06], ["G5", 0.06], ["C6", 0.24]],
  lock: [["A3", 0.06], ["A3", 0.06], ["F3", 0.18]],
  boot: [["C4", 0.05], ["G4", 0.05], ["C5", 0.05], ["E5", 0.1]],
  toggle: [["Fs5", 0.04], ["A5", 0.05]],
};

const SFX = {
  ctx: null,
  master: null,

  get enabled() { return !!PREFS.sound; },

  boot() {
    if (this.ctx) return this.ctx;
    try {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      this.master = this.ctx.createGain();
      this.master.gain.value = PREFS.volume;
      this.master.connect(this.ctx.destination);
    } catch (e) {
      PREFS.sound = false;
    }
    return this.ctx;
  },

  setVolume(v) {
    PREFS.volume = Math.max(0, Math.min(1, v));
    if (this.master) this.master.gain.value = PREFS.volume;
  },

  /* Browsers keep the context suspended until a real gesture happens. */
  unlock() {
    if (!this.enabled) return;
    this.boot();
    if (this.ctx && this.ctx.state === "suspended") this.ctx.resume();
  },

  tone(freq, start, dur, pack) {
    const t0 = this.ctx.currentTime + start;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = pack.wave;
    osc.detune.value = pack.detune;
    osc.frequency.setValueAtTime(freq, t0);
    if (pack.glide) osc.frequency.linearRampToValueAtTime(freq, t0 + pack.glide);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(pack.gain, t0 + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g).connect(this.master);
    osc.start(t0);
    osc.stop(t0 + dur + 0.03);
  },

  play(name) {
    if (!this.enabled) return;
    const seq = SEQ[name];
    if (!seq) return;
    if (!this.boot()) return;
    if (this.ctx.state === "suspended") this.ctx.resume();
    const pack = PACKS[PREFS.pack] || PACKS.arcade;
    let t = 0;
    seq.forEach(([note, d]) => {
      this.tone(NOTE[note] || 440, t, d, pack);
      t += d;
    });
  },

  /* UI chatter is separately mutable — some people only want the verdicts. */
  ui(name) {
    if (!PREFS.clicks) return;
    this.play(name);
  },

  preview(pack) {
    const prev = PREFS.pack;
    PREFS.pack = pack;
    this.play("send");
    PREFS.pack = prev;
  },
};

/* One-time unlock on the first interaction anywhere. */
["pointerdown", "keydown"].forEach((ev) =>
  window.addEventListener(ev, () => SFX.unlock(), { once: true, passive: true })
);

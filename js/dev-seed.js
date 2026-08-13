/* ==========================================================
   Local development only.
   `quick serve` gives each browser its own empty database, which
   makes layout work painful. Open http://localhost:1337/?demo=1
   once to fill it with sample requests. Never runs on the
   deployed site — the hostname check below is the whole guard.
   ========================================================== */

(function () {
  const local = /(^|\.)localhost$|^127\.0\.0\.1$/.test(location.hostname);
  const asked = new URLSearchParams(location.search).has("demo");
  if (!local || !asked) return;

  const PEOPLE = [
    ["Ada Placeholder", "ada@example.com"],
    ["Bo Sample", "bo@example.com"],
    ["Cy Fixture", "cy@example.com"],
    ["Dee Testcase", "dee@example.com"],
  ];
  const ITEMS = [
    "flat white", "triple chocolate cookie", "two cookies actually", "banana",
    "salt and vinegar crisps", "greek yogurt", "cold brew", "the last samosa",
    "protein bar", "matcha latte", "pretzels", "leftover birthday cake",
  ];
  const YES = ["You have earned it", "It is Friday", "Protein detected", ""];
  const NO = ["Too much sugar", "Share with the team", "I was not offered any"];

  const pick = (a) => a[Math.floor(Math.random() * a.length)];

  (async function seed() {
    for (let i = 0; i < 40 && typeof window.quick === "undefined"; i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const col = quick.db.collection("snacks");
    const existing = await col.limit(1).find();
    if (existing && existing.length) return;

    for (let i = 0; i < 18; i++) {
      const [name, email] = pick(PEOPLE);
      const snack = pick(ITEMS);
      const roll = Math.random();
      const status = roll < 0.55 ? "approved" : roll < 0.82 ? "denied" : "pending";
      const created = new Date(Date.now() - Math.random() * 12 * 86400000);
      await col.create({
        snack,
        category: typeof categorise === "function" ? categorise(snack) : "",
        where: pick(["kitchen", "3rd floor", "my desk", ""]),
        size: pick(["A NIBBLE", "NORMAL", "GENEROUS", "SECOND HELPING"]),
        plea: Math.random() < 0.4 ? "I skipped lunch. This is basically medicine." : "",
        status,
        verdict_note: status === "approved" ? pick(YES) : status === "denied" ? pick(NO) : "",
        decided_by: status === "pending" ? null : "Ada Placeholder",
        decided_by_email: status === "pending" ? null : "ada@example.com",
        decided_at: status === "pending" ? null : new Date(created.getTime() + Math.random() * 6e6).toISOString(),
        created_at: created.toISOString(),
        requester_name: name,
        requester_email: email,
        requester_slack: "",
      });
    }
    location.replace(location.pathname);
  })();
})();

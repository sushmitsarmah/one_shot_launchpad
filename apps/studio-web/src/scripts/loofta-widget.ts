/**
 * Loofta "pay the creator" widget for a token page (/t/<slug>), shown only when the creator enabled it and has a
 * Loofta key or payout target. The page only knows the route and a masked label: the payment URL (a fresh Loofta
 * checkout made with the creator's key on the server, or Loofta Send with the creator's target) comes from
 * POST /api/loofta/checkout per click. Loofta has no testnet, so payments are always real, on every Yeetpad
 * deployment. Loofta's pages can't be framed (frame-ancestors 'none'), so the payment opens in a new tab.
 */
export interface LooftaCtx {
  api: string;
  site: string;
  sym: string;
  loofta: { enabled: true; route: "checkout" | "send"; label: string; preview?: boolean };
}

const PRESETS = [5, 10, 25];
const MIN = 1;
const MAX = 10_000;
/** Loofta's checkout hosts: Send lives on pay.loofta.com, API-created checkout links on pay.loofta.xyz. */
const PAY_ORIGINS = new Set(["https://pay.loofta.com", "https://pay.loofta.xyz"]);
const h = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> & { cls?: string } = {}, ...kids: (Node | string | null)[]) => {
  const el = document.createElement(tag);
  const { cls, ...rest } = props;
  if (cls) el.className = cls;
  Object.assign(el, rest);
  for (const k of kids) if (k !== null) el.append(k);
  return el;
};
/** USD with at most 2 decimals inside Loofta's range, else null. */
export function parseUsd(raw: string): number | null {
  const s = raw.trim().replace(/^\$/, "");
  if (!/^\d{1,5}(\.\d{1,2})?$/.test(s)) return null;
  const n = Number(s);
  return n >= MIN && n <= MAX ? n : null;
}
/** Only Loofta's own pages may be opened. */
export function safeLooftaUrl(u: unknown): string | null {
  if (typeof u !== "string") return null;
  try {
    const url = new URL(u);
    return PAY_ORIGINS.has(url.origin) && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

export function mountLoofta(host: HTMLElement, ctx: LooftaCtx) {
  const amount = h("input", { cls: "tki-in", inputMode: "decimal", placeholder: "Amount in USD", ariaLabel: "amount in USD", value: "10" } as never) as HTMLInputElement;
  const note = h("input", { cls: "tki-in", placeholder: "Note (optional)", ariaLabel: "note", maxLength: 200 } as never) as HTMLInputElement;
  const presets = h(
    "div",
    { cls: "tki-tabs" },
    ...PRESETS.map((v) => {
      const b = h("button", { cls: "tki-tab", type: "button", textContent: `$${v}` });
      b.addEventListener("click", () => {
        amount.value = String(v);
        sync();
      });
      return b;
    }),
  );
  const pay = h("button", { cls: "btn tki-btn tkl-pay", type: "button", textContent: "Pay with Loofta ↗" });
  const msg = h("p", { cls: "tki-msg", role: "status" } as never);
  const how =
    ctx.loofta.route === "checkout"
      ? "Opens Loofta's checkout in a new tab: pay with USDC, SOL, ETH, BTC and 150+ other tokens from any chain. No Loofta account needed."
      : "Opens Loofta in a new tab with the recipient filled in; pay from a Solana wallet. The creator claims it with their email or social account.";
  const foot = h(
    "p",
    { cls: "tki-foot" },
    "Payments by ",
    h("a", { href: "https://loofta.com", target: "_blank", rel: "noreferrer", textContent: "Loofta" }),
    ". Loofta's fees are shown at checkout and paid by the sender; this page adds no fee.",
  );

  const sync = () => {
    const ok = parseUsd(amount.value) !== null;
    pay.disabled = !ok;
    for (const b of presets.querySelectorAll("button")) b.classList.toggle("is-on", b.textContent === `$${amount.value.trim()}`);
    if (!ok && amount.value.trim()) setMsg(`Enter $${MIN}–$${MAX.toLocaleString()} (up to 2 decimals).`, true);
    else setMsg("");
  };
  const setMsg = (t: string, bad = false) => {
    msg.textContent = t;
    msg.classList.toggle("is-bad", bad);
  };
  amount.addEventListener("input", sync);

  pay.addEventListener("click", async () => {
    const usd = parseUsd(amount.value);
    if (usd === null) return sync();
    // Open the tab inside the click (popup blockers), then point it at Loofta once the API answers.
    const win = window.open("about:blank", "_blank");
    pay.disabled = true;
    setMsg("Opening Loofta…");
    try {
      const r = await fetch(`${ctx.api}/api/loofta/checkout`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ site: ctx.site, amount: usd, ...(note.value.trim() ? { message: note.value.trim() } : {}) }),
      });
      const j = (await r.json().catch(() => ({}))) as { url?: string | null; note?: string; error?: string };
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
      if (!j.url) throw new Error(j.note ?? "Loofta didn't return a payment link");
      const url = safeLooftaUrl(j.url);
      if (!url) throw new Error("unexpected payment link");
      if (win) {
        win.opener = null;
        win.location.href = url;
      } else window.open(url, "_blank", "noopener");
      setMsg(`Loofta opened in a new tab for $${usd}. Finish the payment there.`);
    } catch (e) {
      win?.close();
      setMsg(`Couldn't start the payment: ${(e as Error).message}`, true);
    } finally {
      pay.disabled = parseUsd(amount.value) === null;
    }
  });

  const card = h(
    "div",
    { cls: "tk-card tk-intents tk-loofta" },
    h("h2", { textContent: `Tip the $${ctx.sym} creator` }),
    h("p", { cls: "tki-small", textContent: `Send a tip to ${ctx.loofta.label} with Loofta. ${how} Payments are real.` }),
    presets,
    h("div", { cls: "tki-grid" }, h("label", { cls: "tki-field" }, h("span", { textContent: "Amount (USD)" }), amount), h("label", { cls: "tki-field" }, h("span", { textContent: "Note" }), note)),
    h("div", { cls: "tki-actions" }, pay),
    msg,
    foot,
  );
  host.replaceChildren(card);
  sync();
}

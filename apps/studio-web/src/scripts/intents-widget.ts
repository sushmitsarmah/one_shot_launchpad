/**
 * NEAR Intents widget for a token page (/t/<slug>), shown only when the creator enabled it.
 * Buy: pay any supported asset -> 1Click delivers wNEAR to your NEAR account -> swap wNEAR -> $TOKEN on
 * Rhea with your wallet (1Click can't route into brand-new tokens). Tip: pay any asset -> creator gets USDC/wNEAR.
 * Quotes/status go through our API (proxy of 1Click). Deposit addresses are only ever taken from that answer.
 * Off mainnet the API only returns price-only quotes, so this never shows a deposit address on testnet.
 */
import qrcode from "qrcode-generator";
import { viewCall } from "../lib/near";
import { formatUnits, isMainnetAccount, minOut, parseUnits, payOptions, rheaBuyCalls, STATUS_TEXT, TERMINAL, type IntentsStatus, type IntentsToken } from "../lib/intents";

export interface IntentsCtx {
  api: string;
  site: string;
  sym: string;
  tokenId: string;
  intents: { enabled: boolean; mode: "buy" | "tip" | "both"; tipAsset?: "usdc" | "wnear"; recipient?: string };
  network: "testnet" | "mainnet";
  rhea: { dcl: string; wnear: string; poolId: string; url: string | null } | null;
  buyUrl: string;
  owner: string;
}

const DEPOSIT_RE = /^[A-Za-z0-9._:\-]{10,128}$/;
const h = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> & { cls?: string } = {}, ...kids: (Node | string | null)[]) => {
  const el = document.createElement(tag);
  const { cls, ...rest } = props;
  if (cls) el.className = cls;
  Object.assign(el, rest);
  for (const k of kids) if (k !== null) el.append(k);
  return el;
};

export function mountIntents(host: HTMLElement, ctx: IntentsCtx) {
  const mainnet = ctx.network === "mainnet";
  const modes: ("buy" | "tip")[] = ctx.intents.mode === "both" ? ["buy", "tip"] : [ctx.intents.mode];
  let mode = modes[0];
  let tokens: ReturnType<typeof payOptions> = [];
  let polling: number | null = null;

  const title = h("h2", {});
  const tabs = h("div", { cls: "tki-tabs", role: "tablist" } as never);
  const note = h("p", { cls: "tki-note" });
  if (!mainnet)
    note.textContent = "Preview: NEAR Intents settles on NEAR mainnet only. This testnet page shows live prices but can't take payments, so no deposit address is shown.";
  else note.hidden = true;
  const asset = h("select", { cls: "tki-in", ariaLabel: "pay with" } as never) as HTMLSelectElement;
  const amount = h("input", { cls: "tki-in", inputMode: "decimal", placeholder: "Amount", ariaLabel: "amount" } as never) as HTMLInputElement;
  const recipient = h("input", { cls: "tki-in", placeholder: "your-account.near", ariaLabel: "your NEAR account", autocomplete: "off", spellcheck: false } as never) as HTMLInputElement;
  const refund = h("input", { cls: "tki-in", placeholder: "Refund address on the chain you pay from", ariaLabel: "refund address", autocomplete: "off", spellcheck: false } as never) as HTMLInputElement;
  const recipRow = h("label", { cls: "tki-field" }, h("span", { textContent: "Your NEAR account (gets wNEAR)" }), recipient);
  const refundRow = h("label", { cls: "tki-field" }, h("span", { textContent: "Refund address (if the swap can't complete)" }), refund);
  if (!mainnet) refundRow.hidden = true;
  const quoteBtn = h("button", { cls: "btn tki-btn", type: "button", textContent: "Get quote" });
  const depositBtn = h("button", { cls: "btn btn-ghost tki-btn", type: "button", textContent: "Get deposit address", hidden: true });
  const msg = h("p", { cls: "tki-msg", role: "status" } as never);
  const quoteBox = h("div", { cls: "tki-quote", hidden: true });
  const depositBox = h("div", { cls: "tki-deposit", hidden: true });
  const step2 = h("div", { cls: "tki-step2", hidden: true });
  const foot = h("p", { cls: "tki-foot" }, "Powered by ", h("a", { href: "https://near-intents.org", target: "_blank", rel: "noreferrer", textContent: "NEAR Intents" }), " (1Click API). This page adds no fee; 1Click's fee is already in the quote.");

  const card = h(
    "div",
    { cls: "tk-card tk-intents" },
    title,
    tabs,
    note,
    h("div", { cls: "tki-grid" }, h("label", { cls: "tki-field" }, h("span", { textContent: "Pay with" }), asset), h("label", { cls: "tki-field" }, h("span", { textContent: "Amount" }), amount)),
    recipRow,
    refundRow,
    h("div", { cls: "tki-actions" }, quoteBtn, depositBtn),
    msg,
    quoteBox,
    depositBox,
    step2,
    foot,
  );
  host.replaceChildren(card);

  const sel = () => tokens.find((t) => t.assetId === asset.value);
  const setMsg = (t: string, bad = false) => {
    msg.textContent = t;
    msg.classList.toggle("is-bad", bad);
  };
  const render = () => {
    title.textContent = mode === "buy" ? `Buy $${ctx.sym} with any crypto` : "Tip the creator in any crypto";
    tabs.replaceChildren(
      ...(modes.length > 1
        ? modes.map((m) => {
            const b = h("button", { type: "button", cls: `tki-tab${m === mode ? " is-on" : ""}`, textContent: m === "buy" ? `Buy $${ctx.sym}` : "Tip the creator" });
            b.setAttribute("role", "tab");
            b.setAttribute("aria-selected", String(m === mode));
            b.onclick = () => {
              mode = m;
              reset();
              render();
            };
            return b;
          })
        : []),
    );
    recipRow.hidden = mode !== "buy";
    step2.hidden = mode !== "buy";
    if (mode === "buy") renderStep2();
  };
  const reset = () => {
    quoteBox.hidden = true;
    depositBox.hidden = true;
    depositBtn.hidden = true;
    if (polling) clearInterval(polling);
    polling = null;
    setMsg("");
  };

  const body = (dry: boolean) => {
    const t = sel();
    if (!t) throw new Error("Pick what you pay with.");
    const units = parseUnits(amount.value, t.decimals);
    if (!units) throw new Error(`Enter an amount of ${t.symbol} (up to ${t.decimals} decimals).`);
    const b: Record<string, unknown> = { site: ctx.site, mode, originAsset: t.assetId, amount: units.toString(), dry };
    const r = recipient.value.trim();
    if (mode === "buy" && r) {
      if (mainnet && !isMainnetAccount(r)) throw new Error("Enter a NEAR mainnet account like you.near.");
      if (mainnet) b.recipient = r;
    }
    if (!dry) {
      if (mode === "buy" && !r) throw new Error("Enter the NEAR account that should receive wNEAR.");
      if (!refund.value.trim()) throw new Error(`Enter a refund address on ${t.label.split(" · ")[1]}.`);
      b.refundTo = refund.value.trim();
    }
    return b;
  };
  const call = async (b: Record<string, unknown>) => {
    const r = await fetch(`${ctx.api}/api/intents/quote`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
    return j;
  };

  quoteBtn.onclick = async () => {
    reset();
    try {
      quoteBtn.disabled = true;
      setMsg("Asking NEAR Intents solvers for a price…");
      const q = await call(body(true));
      const t = sel()!;
      const outSym = q.destinationAsset === "nep141:wrap.near" ? "wNEAR" : "USDC";
      const usd = (v: string | null) => (v ? ` (~$${Number(v).toFixed(2)})` : "");
      quoteBox.replaceChildren(
        h("p", {}, h("strong", { textContent: "You send " }), `${q.amountInFormatted} ${t.symbol} on ${t.label.split(" · ")[1]}${usd(q.amountInUsd)}`),
        h("p", {}, h("strong", { textContent: mode === "buy" ? "You get " : "Creator gets " }), `≈ ${Number(q.amountOutFormatted).toPrecision(6)} ${outSym} on NEAR${usd(q.amountOutUsd)}`),
        h("p", { cls: "tki-small", textContent: `${q.timeEstimate ? `About ${q.timeEstimate < 90 ? `${q.timeEstimate} s` : `${Math.round(q.timeEstimate / 60)} min`} after your deposit confirms.` : ""}${mode === "tip" ? ` Tips go to ${ctx.intents.recipient ?? ctx.owner}.` : ""}` }),
      );
      quoteBox.hidden = false;
      if (mode === "buy" && q.amountOut) void estimateTokens(BigInt(q.amountOut));
      depositBtn.hidden = !mainnet;
      setMsg(mainnet ? "Prices move; the deposit address step gets a fresh, binding quote." : "Preview only on testnet: swaps settle on NEAR mainnet.");
    } catch (e) {
      setMsg((e as Error).message, true);
    } finally {
      quoteBtn.disabled = false;
    }
  };

  const estimateTokens = async (wnearOut: bigint) => {
    if (!ctx.rhea) return;
    try {
      const r = await viewCall<{ amount: string }>(ctx.rhea.dcl, "quote", { pool_ids: [ctx.rhea.poolId], input_token: ctx.rhea.wnear, output_token: ctx.tokenId, input_amount: wnearOut.toString(), tag: null });
      const dec = (await viewCall<{ decimals: number }>(ctx.tokenId, "ft_metadata")).decimals;
      quoteBox.append(h("p", { cls: "tki-small", textContent: `Then on Rhea that's ≈ ${Number(formatUnits(BigInt(r.amount), dec, 2)).toLocaleString()} $${ctx.sym} at today's pool price (step 2).` }));
    } catch {
      /* the estimate is optional */
    }
  };

  depositBtn.onclick = async () => {
    try {
      depositBtn.disabled = true;
      setMsg("Getting a deposit address…");
      const q = await call(body(false));
      const addr = q.depositAddress;
      if (typeof addr !== "string" || !DEPOSIT_RE.test(addr)) throw new Error("NEAR Intents didn't return a usable deposit address; nothing to send.");
      const t = sel()!;
      const qr = qrcode(0, "M");
      qr.addData(addr);
      qr.make();
      const qrBox = h("div", { cls: "tki-qr" });
      qrBox.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
      const copy = h("button", { cls: "btn btn-ghost tki-copy", type: "button", textContent: "Copy address" });
      copy.onclick = async () => {
        await navigator.clipboard?.writeText(addr);
        copy.textContent = "Copied ✓";
      };
      const status = h("p", { cls: "tki-status", textContent: STATUS_TEXT.PENDING_DEPOSIT });
      depositBox.replaceChildren(
        h("p", {}, h("strong", { textContent: `Send exactly ${q.amountInFormatted} ${t.symbol}` }), ` on ${t.label.split(" · ")[1]} to:`),
        qrBox,
        h("code", { cls: "tki-addr", textContent: addr }),
        ...(q.depositMemo ? [h("p", {}, h("strong", { textContent: "Memo (required): " }), h("code", { textContent: q.depositMemo }))] : []),
        copy,
        h("p", { cls: "tki-small", textContent: `Only send ${t.symbol} on ${t.label.split(" · ")[1]}. Valid until ${q.deadline ? new Date(q.deadline).toLocaleString() : "the quote deadline"}; after that it's refunded to ${refund.value.trim()}.` }),
        status,
      );
      depositBox.hidden = false;
      setMsg("");
      if (polling) clearInterval(polling);
      const poll = async () => {
        const u = new URL(`${ctx.api}/api/intents/status`);
        u.searchParams.set("depositAddress", addr);
        if (q.depositMemo) u.searchParams.set("depositMemo", q.depositMemo);
        const r = await fetch(u).then((x) => x.json()).catch(() => null);
        if (!r?.status) return;
        const s = r.status as IntentsStatus;
        status.textContent = STATUS_TEXT[s] ?? s;
        if (TERMINAL.includes(s) && polling) {
          clearInterval(polling);
          polling = null;
          if (s === "SUCCESS" && mode === "buy") {
            status.textContent += ` wNEAR is in ${recipient.value.trim()}. Now swap it for $${ctx.sym} below.`;
            step2.scrollIntoView({ behavior: "smooth", block: "nearest" });
          }
        }
      };
      polling = window.setInterval(poll, 6000);
      void poll();
    } catch (e) {
      setMsg((e as Error).message, true);
    } finally {
      depositBtn.disabled = false;
    }
  };

  // ---- Step 2 (buy): wNEAR -> token on Rhea, signed by the visitor's NEAR wallet ----
  const renderStep2 = () => {
    if (!ctx.rhea) {
      step2.replaceChildren(
        h("h3", { textContent: `Step 2: get $${ctx.sym}` }),
        h("p", { cls: "tki-small" }, `$${ctx.sym} isn't in a Rhea pool, so this page can't swap for you. Use your wNEAR where it trades: `, h("a", { href: ctx.buyUrl, target: "_blank", rel: "noreferrer", textContent: "token page ↗" })),
      );
      return;
    }
    const rhea = ctx.rhea;
    const amt = h("input", { cls: "tki-in", inputMode: "decimal", placeholder: "wNEAR (or NEAR) to spend", ariaLabel: "wNEAR to swap" } as never) as HTMLInputElement;
    const btn = h("button", { cls: "btn tki-btn", type: "button", textContent: "Connect wallet & swap on Rhea" });
    const out = h("p", { cls: "tki-small", role: "status" } as never);
    step2.replaceChildren(
      h("h3", { textContent: `Step 2: swap wNEAR → $${ctx.sym} on Rhea` }),
      h("p", { cls: "tki-small", textContent: `1Click can't deliver brand-new tokens, so it delivers wNEAR and your wallet swaps it in the token's Rhea pool. Max 1% price slippage.${mainnet ? "" : " (Testnet: this step works with testnet wNEAR/NEAR.)"}` }),
      h("div", { cls: "tki-actions" }, amt, btn),
      out,
      ...(rhea.url ? [h("p", { cls: "tki-small" }, h("a", { href: rhea.url, target: "_blank", rel: "noreferrer", textContent: "Or open the pool on Rhea ↗" }))] : []),
    );
    btn.onclick = async () => {
      try {
        btn.disabled = true;
        const amountIn = parseUnits(amt.value, 24);
        if (!amountIn) throw new Error("Enter how much wNEAR to swap.");
        out.textContent = "Opening your wallet…";
        const [w] = await Promise.all([import("../lib/wallet"), import("@near-wallet-selector/modal-ui/styles.css"), import("../styles/wallet-modal.css")]);
        const { selector, modal } = await w.initWallet();
        let account = selector.store.getState().accounts.find((a) => a.active)?.accountId;
        if (!account) {
          modal.show();
          account = await new Promise<string>((res, rej) => {
            const sub = selector.store.observable.subscribe((s) => {
              const a = s.accounts.find((x) => x.active)?.accountId;
              if (a) (sub.unsubscribe(), res(a));
            });
            setTimeout(() => (sub.unsubscribe(), rej(new Error("No wallet connected."))), 120_000);
          });
        }
        out.textContent = "Quoting the Rhea pool…";
        const q = await viewCall<{ amount: string }>(rhea.dcl, "quote", { pool_ids: [rhea.poolId], input_token: rhea.wnear, output_token: ctx.tokenId, input_amount: amountIn.toString(), tag: null });
        const quoted = BigInt(q.amount);
        if (quoted === 0n) throw new Error("The pool can't fill that right now.");
        const wbal = BigInt(await viewCall<string>(rhea.wnear, "ft_balance_of", { account_id: account }).catch(() => "0"));
        const calls = rheaBuyCalls({
          dcl: rhea.dcl,
          wnear: rhea.wnear,
          poolId: rhea.poolId,
          token: ctx.tokenId,
          amountIn,
          minAmountOut: minOut(quoted, 100),
          wrapNear: wbal >= amountIn ? 0n : amountIn - wbal,
          registerToken: !(await viewCall(ctx.tokenId, "storage_balance_of", { account_id: account }).catch(() => null)),
          registerWnear: !(await viewCall(rhea.wnear, "storage_balance_of", { account_id: account }).catch(() => null)),
        });
        const dec = (await viewCall<{ decimals: number }>(ctx.tokenId, "ft_metadata")).decimals;
        out.textContent = `Approve in your wallet: ≈ ${Number(formatUnits(quoted, dec, 2)).toLocaleString()} $${ctx.sym} (at least ${Number(formatUnits(minOut(quoted, 100), dec, 2)).toLocaleString()}).`;
        await w.signCallsInChunks(calls, 10, { persist: false });
        out.textContent = `Swapped ✓ $${ctx.sym} is in ${account}.`;
      } catch (e) {
        out.textContent = (await import("../lib/wallet")).friendlyWalletError(e).message;
      } finally {
        btn.disabled = false;
      }
    };
  };

  render();
  fetch(`${ctx.api}/api/intents/tokens`)
    .then((r) => r.json())
    .then((j: { tokens?: IntentsToken[] }) => {
      tokens = payOptions(j.tokens ?? []);
      asset.replaceChildren(...tokens.map((t) => h("option", { value: t.assetId, textContent: t.label })));
      const usdc = tokens.find((t) => t.symbol === "USDC" && t.blockchain === "base") ?? tokens[0];
      if (usdc) asset.value = usdc.assetId;
    })
    .catch(() => setMsg("NEAR Intents is unreachable right now.", true));
}

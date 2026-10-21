/**
 * Wallet sign-in: sign a NEP-413 message once, exchange it at the API for a ~24h session token.
 * Inline wallets (Meteor, HERE, MyNearWallet popup) return the signature directly; redirect-style
 * flows come back to /app/ with accountId/publicKey/signature in the URL hash (or query), which
 * `completeRedirectSignIn()` picks up on page load.
 */
import { buildSignInMessage, type SessionResponse } from "@osl/schema";
import { API_URL, VAULT_CONTRACT } from "./config";
import { initWallet } from "./wallet";

/** NEP-413 recipient; must match the API's AUTH_RECIPIENT (defaults to the vault id). */
export const AUTH_RECIPIENT = VAULT_CONTRACT;
const SESSION_KEY = "osl.session";
const PENDING_KEY = "osl.pendingSignIn";

interface Pending {
  accountId: string;
  message: string;
  nonce: string; // base64
  recipient: string;
  callbackUrl: string;
}

const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));

export function getSession(accountId: string | null): SessionResponse | null {
  if (!accountId) return null;
  try {
    const s = JSON.parse(localStorage.getItem(SESSION_KEY) ?? "null") as SessionResponse | null;
    if (s && s.accountId === accountId && s.expiresAt > Date.now() + 60_000) return s;
  } catch {}
  return null;
}

export function clearSession() {
  localStorage.removeItem(SESSION_KEY);
  localStorage.removeItem(PENDING_KEY);
}

async function exchange(p: Pending, signed: { accountId: string; publicKey: string; signature: string }) {
  if (signed.accountId && signed.accountId !== p.accountId) throw new Error("wallet signed with a different account");
  const r = await fetch(`${API_URL}/api/auth/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      accountId: p.accountId,
      publicKey: signed.publicKey,
      signature: signed.signature,
      message: p.message,
      nonce: p.nonce,
      recipient: p.recipient,
      callbackUrl: p.callbackUrl,
    }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error ?? `sign-in failed (HTTP ${r.status})`);
  const s = j as SessionResponse;
  localStorage.setItem(SESSION_KEY, JSON.stringify(s));
  localStorage.removeItem(PENDING_KEY);
  return s;
}

/**
 * Returns a valid session for `accountId`, asking the wallet to sign if needed.
 * Resolves to null if the wallet navigated away (redirect flow); the page finishes on return.
 */
export async function ensureSession(accountId: string): Promise<SessionResponse | null> {
  const existing = getSession(accountId);
  if (existing) return existing;

  const nonce = crypto.getRandomValues(new Uint8Array(32));
  const pending: Pending = {
    accountId,
    message: buildSignInMessage(accountId),
    nonce: b64(nonce),
    recipient: AUTH_RECIPIENT,
    callbackUrl: `${location.origin}/app/`,
  };
  localStorage.setItem(PENDING_KEY, JSON.stringify(pending));

  const { selector } = await initWallet();
  const wallet = await selector.wallet();
  if (!("signMessage" in wallet) || typeof wallet.signMessage !== "function") {
    throw new Error(`${wallet.metadata.name} can't sign messages; try Meteor or MyNearWallet`);
  }
  const signed = await wallet.signMessage({
    message: pending.message,
    recipient: pending.recipient,
    nonce: Buffer.from(nonce),
    callbackUrl: pending.callbackUrl,
  });
  if (!signed) return null; // redirected; completeRedirectSignIn() handles the return
  return exchange(pending, signed);
}

/** On /app/ load: finish a redirect-based signMessage (params in #hash or ?query). */
export async function completeRedirectSignIn(): Promise<SessionResponse | null> {
  const hash = new URLSearchParams(location.hash.replace(/^#/, ""));
  const query = new URLSearchParams(location.search);
  const params = hash.has("signature") || hash.has("error") ? hash : query;
  const signature = params.get("signature");
  const error = params.get("error");
  if (!signature && !error) return null;

  // Strip the auth params from the URL either way.
  for (const k of ["accountId", "publicKey", "signature", "state", "error"]) {
    hash.delete(k);
    query.delete(k);
  }
  const qs = query.toString();
  const hs = hash.toString();
  history.replaceState(null, "", `${location.pathname}${qs ? `?${qs}` : ""}${hs ? `#${hs}` : ""}`);

  const pending = JSON.parse(localStorage.getItem(PENDING_KEY) ?? "null") as Pending | null;
  if (error) {
    localStorage.removeItem(PENDING_KEY);
    throw new Error(`wallet sign-in cancelled: ${error}`);
  }
  if (!pending) throw new Error("wallet returned a signature but no sign-in was pending; try again");
  return exchange(pending, {
    accountId: params.get("accountId") ?? pending.accountId,
    publicKey: params.get("publicKey") ?? "",
    signature: signature!,
  });
}

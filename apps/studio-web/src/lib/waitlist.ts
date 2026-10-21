/**
 * Whitelist (waitlist) signup. Deliberately tiny (no wallet SDKs, no zod) so the landing page can use it.
 * The API re-validates everything; these checks are just for friendly inline errors.
 */
import { API_URL } from "./config";

const ACCOUNT_RE = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
const EMAIL_RE = /^[^\s@<>"'`]{1,64}@[^\s@<>"'`]+\.[^\s@<>"'`]{2,}$/;
const HANDLE_RE = /^@[A-Za-z0-9_.-]{1,50}$/;
export const CONTACT_MAX = 100;

export function accountError(account: string): string | null {
  const a = account.trim().toLowerCase();
  if (!a) return "we need your NEAR account id";
  if (a.length < 2 || a.length > 64 || !ACCOUNT_RE.test(a)) return "that doesn't look like a NEAR account (e.g. yeeter.testnet)";
  return null;
}

export function contactError(contact: string): string | null {
  const c = contact.trim();
  if (!c) return null;
  if (c.length > CONTACT_MAX) return `keep it under ${CONTACT_MAX} characters`;
  if (!EMAIL_RE.test(c) && !HANDLE_RE.test(c)) return "an email or an @handle, please";
  return null;
}

/** Joins the waitlist (idempotent). `already` is true if the account was on it before. */
export async function joinWaitlist(account: string, contact?: string): Promise<{ ok: true; account: string; already: boolean }> {
  const r = await fetch(`${API_URL}/api/whitelist`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ account: account.trim().toLowerCase(), ...(contact?.trim() ? { contact: contact.trim() } : {}) }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
  return j;
}

/**
 * Wallet auth: NEP-413 signed sign-in message -> short-lived HMAC session token.
 *
 * NEP-413 hash = sha256( borsh(u32 tag = 2^31 + 413) || borsh(Payload) ), where
 * Payload = { message: string, nonce: [u8; 32], recipient: string, callbackUrl: Option<string> }.
 * The wallet signs that hash with ed25519; we verify it, check the key is a FullAccess key
 * of the account on chain, check the message is fresh and the recipient is ours.
 */
import { PublicKey, baseDecode } from "near-api-js";
import { parseSignInMessage, type SessionRequest } from "@osl/schema";

export const NEP413_TAG = 2147484061; // 2^31 + 413
export const MAX_MESSAGE_AGE_MS = 10 * 60 * 1000;
export const MAX_CLOCK_SKEW_MS = 60 * 1000;
export const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

const enc = new TextEncoder();

function u32le(n: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, true);
  return b;
}
function borshString(s: string): Uint8Array[] {
  const bytes = enc.encode(s);
  return [u32le(bytes.length), bytes];
}
function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export interface Nep413Payload {
  message: string;
  nonce: Uint8Array; // 32 bytes
  recipient: string;
  callbackUrl?: string | null;
}

/** Borsh bytes that get hashed: tag || message || nonce || recipient || Option<callbackUrl>. */
export function serializeNep413(p: Nep413Payload): Uint8Array {
  if (p.nonce.length !== 32) throw new Error("nonce must be 32 bytes");
  const parts: Uint8Array[] = [u32le(NEP413_TAG), ...borshString(p.message), p.nonce, ...borshString(p.recipient)];
  if (p.callbackUrl == null) parts.push(Uint8Array.of(0));
  else parts.push(Uint8Array.of(1), ...borshString(p.callbackUrl));
  return concat(parts);
}

export async function hashNep413(p: Nep413Payload): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", serializeNep413(p) as BufferSource));
}

// ---------- encoding helpers ----------
export function b64decode(s: string): Uint8Array {
  const norm = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(norm + "=".repeat((4 - (norm.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
export function b64encode(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s);
}
const b64url = (b: Uint8Array) => b64encode(b).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** Wallets return the signature as base64; tolerate base58 / "ed25519:" prefixed too. */
export function decodeSignature(sig: string): Uint8Array {
  const s = sig.replace(/^ed25519:/, "");
  try {
    const b = b64decode(s);
    if (b.length === 64) return b;
  } catch {}
  const b = baseDecode(s);
  if (b.length === 64) return b;
  throw new Error("signature must be 64 bytes");
}

// ---------- verification ----------
export class AuthError extends Error {
  constructor(message: string, readonly status = 401) {
    super(message);
  }
}

export interface VerifyOptions {
  /** Expected NEP-413 recipient (we use the vault contract id). */
  recipient: string;
  now?: number;
  /** Return true if publicKey is a FullAccess key of accountId. Omit to skip (mock mode only). */
  isFullAccessKey?: (accountId: string, publicKey: string) => Promise<boolean>;
  /** Return false if this nonce was already used (replay). */
  consumeNonce?: (nonceB64: string, expiresAt: number) => boolean;
}

/** Verifies a NEP-413 sign-in. Returns the authenticated account id or throws AuthError. */
export async function verifySignIn(req: SessionRequest, opts: VerifyOptions): Promise<string> {
  const now = opts.now ?? Date.now();
  if (req.recipient !== opts.recipient) throw new AuthError("wrong recipient");

  const parsed = parseSignInMessage(req.message);
  if (!parsed) throw new AuthError("unrecognised sign-in message");
  if (parsed.accountId !== req.accountId) throw new AuthError("message account does not match accountId");
  if (now - parsed.issuedAt > MAX_MESSAGE_AGE_MS) throw new AuthError("sign-in message expired; sign again");
  if (parsed.issuedAt - now > MAX_CLOCK_SKEW_MS) throw new AuthError("sign-in message issued in the future");

  let nonce: Uint8Array;
  try {
    nonce = b64decode(req.nonce);
  } catch {
    throw new AuthError("nonce must be base64");
  }
  if (nonce.length !== 32) throw new AuthError("nonce must be 32 bytes");

  let pk: PublicKey;
  let sig: Uint8Array;
  try {
    pk = PublicKey.fromString(req.publicKey);
    sig = decodeSignature(req.signature);
  } catch (e) {
    throw new AuthError(`bad key or signature encoding: ${(e as Error).message}`);
  }
  if (!req.publicKey.startsWith("ed25519:")) throw new AuthError("only ed25519 keys are supported");

  // Wallets differ on whether callbackUrl is part of the signed payload; accept either form.
  const variants = [...new Set([req.callbackUrl ?? null, null])];
  let ok = false;
  for (const callbackUrl of variants) {
    const hash = await hashNep413({ message: req.message, nonce, recipient: req.recipient, callbackUrl });
    if (pk.verify(hash, sig)) {
      ok = true;
      break;
    }
  }
  if (!ok) throw new AuthError("invalid signature");

  if (opts.isFullAccessKey && !(await opts.isFullAccessKey(req.accountId, req.publicKey))) {
    throw new AuthError("public key is not a full-access key of this account");
  }
  if (opts.consumeNonce && !opts.consumeNonce(req.nonce, parsed.issuedAt + MAX_MESSAGE_AGE_MS)) {
    throw new AuthError("nonce already used");
  }
  return req.accountId;
}

/** Best-effort replay cache (per process / Worker isolate); the 10-minute freshness window is the main guard. */
const usedNonces = new Map<string, number>();
export function consumeNonceInMemory(nonce: string, expiresAt: number, now = Date.now()): boolean {
  if (usedNonces.size > 5000) for (const [k, exp] of usedNonces) if (exp < now) usedNonces.delete(k);
  if (usedNonces.has(nonce)) return false;
  usedNonces.set(nonce, expiresAt);
  return true;
}

// ---------- session tokens: base64url(json).base64url(hmac-sha256) ----------
const keyCache = new Map<string, Promise<CryptoKey>>();
function hmacKey(secret: string) {
  let k = keyCache.get(secret);
  if (!k) {
    k = crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
    keyCache.set(secret, k);
  }
  return k;
}

export async function issueSession(accountId: string, secret: string, now = Date.now(), ttlMs = SESSION_TTL_MS) {
  const expiresAt = now + ttlMs;
  const body = b64url(enc.encode(JSON.stringify({ sub: accountId, exp: expiresAt, v: 1 })));
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(body)));
  return { token: `${body}.${b64url(mac)}`, accountId, expiresAt };
}

export async function verifySession(token: string, secret: string, now = Date.now()): Promise<string> {
  const [body, mac, extra] = token.split(".");
  if (!body || !mac || extra !== undefined) throw new AuthError("malformed session token");
  let macBytes: Uint8Array;
  try {
    macBytes = b64decode(mac);
  } catch {
    throw new AuthError("malformed session token");
  }
  const valid = await crypto.subtle.verify("HMAC", await hmacKey(secret), macBytes as BufferSource, enc.encode(body));
  if (!valid) throw new AuthError("invalid session token");
  const claims = JSON.parse(new TextDecoder().decode(b64decode(body))) as { sub?: string; exp?: number };
  if (!claims.sub || typeof claims.exp !== "number") throw new AuthError("malformed session token");
  if (claims.exp < now) throw new AuthError("session expired; sign in again");
  return claims.sub;
}

import { describe, expect, test } from "bun:test";
import { KeyPair } from "near-api-js";
import { buildSignInMessage } from "@osl/schema";
import {
  AuthError,
  MAX_MESSAGE_AGE_MS,
  b64encode,
  consumeNonceInMemory,
  hashNep413,
  issueSession,
  verifySession,
  verifySignIn,
} from "./auth";
import { signIn } from "./test-helpers";

const RECIPIENT = "launch-vault.test.testnet";
const kp = KeyPair.fromRandom("ed25519");
const pk = kp.getPublicKey().toString();
const fullAccess = async (acc: string, key: string) => acc === "alice.testnet" && key === pk;

const rejects = async (p: Promise<unknown>, re: RegExp) => {
  const e = await p.then(() => null, (err) => err);
  expect(e).toBeInstanceOf(AuthError);
  expect((e as Error).message).toMatch(re);
};

describe("NEP-413 sign-in verification", () => {
  test("hash matches the NEP-413 test vector shape (tag + borsh payload, sha256)", async () => {
    // Sanity: signing our hash directly gives the same signature as near-api-js's NEP-413 signer.
    const nonce = new Uint8Array(32).fill(7);
    const req = await signIn(kp, "alice.testnet", RECIPIENT, { nonce, message: buildSignInMessage("alice.testnet") });
    const hash = await hashNep413({ message: req.message, nonce, recipient: RECIPIENT, callbackUrl: null });
    expect(b64encode(kp.sign(hash).signature)).toBe(req.signature);
  });

  test("valid signature passes", async () => {
    const req = await signIn(kp, "alice.testnet", RECIPIENT);
    expect(await verifySignIn(req, { recipient: RECIPIENT, isFullAccessKey: fullAccess })).toBe("alice.testnet");
  });

  test("valid signature with callbackUrl in the payload passes", async () => {
    const req = await signIn(kp, "alice.testnet", RECIPIENT, { callbackUrl: "https://example.com/app/" });
    expect(await verifySignIn(req, { recipient: RECIPIENT, isFullAccessKey: fullAccess })).toBe("alice.testnet");
  });

  test("wrong account fails (claims bob, key belongs to alice)", async () => {
    const req = await signIn(kp, "bob.testnet", RECIPIENT);
    await rejects(verifySignIn(req, { recipient: RECIPIENT, isFullAccessKey: fullAccess }), /full-access key/);
  });

  test("accountId swapped after signing fails", async () => {
    const req = await signIn(kp, "alice.testnet", RECIPIENT);
    await rejects(verifySignIn({ ...req, accountId: "bob.testnet" }, { recipient: RECIPIENT }), /does not match/);
  });

  test("wrong recipient fails", async () => {
    const req = await signIn(kp, "alice.testnet", "evil.testnet");
    await rejects(verifySignIn(req, { recipient: RECIPIENT }), /wrong recipient/);
    // ...and lying about the recipient breaks the signature
    await rejects(verifySignIn({ ...req, recipient: RECIPIENT }, { recipient: RECIPIENT }), /invalid signature/);
  });

  test("stale timestamp fails", async () => {
    const old = new Date(Date.now() - MAX_MESSAGE_AGE_MS - 1000);
    const req = await signIn(kp, "alice.testnet", RECIPIENT, { issuedAt: old });
    await rejects(verifySignIn(req, { recipient: RECIPIENT }), /expired/);
  });

  test("future timestamp fails", async () => {
    const req = await signIn(kp, "alice.testnet", RECIPIENT, { issuedAt: new Date(Date.now() + 10 * 60_000) });
    await rejects(verifySignIn(req, { recipient: RECIPIENT }), /future/);
  });

  test("tampered message fails", async () => {
    const req = await signIn(kp, "alice.testnet", RECIPIENT);
    const tampered = req.message.replace(/issued: .*/, `issued: ${new Date(Date.now() + 1000).toISOString()}`);
    await rejects(verifySignIn({ ...req, message: tampered }, { recipient: RECIPIENT }), /invalid signature/);
  });

  test("tampered nonce fails", async () => {
    const req = await signIn(kp, "alice.testnet", RECIPIENT);
    await rejects(
      verifySignIn({ ...req, nonce: b64encode(new Uint8Array(32).fill(1)) }, { recipient: RECIPIENT }),
      /invalid signature/,
    );
  });

  test("signature from a different key fails", async () => {
    const other = KeyPair.fromRandom("ed25519");
    const req = await signIn(other, "alice.testnet", RECIPIENT);
    await rejects(verifySignIn({ ...req, publicKey: pk }, { recipient: RECIPIENT }), /invalid signature/);
  });

  test("non-full-access key fails", async () => {
    const req = await signIn(kp, "alice.testnet", RECIPIENT);
    await rejects(verifySignIn(req, { recipient: RECIPIENT, isFullAccessKey: async () => false }), /full-access/);
  });

  test("replayed nonce fails", async () => {
    const req = await signIn(kp, "alice.testnet", RECIPIENT);
    const opts = { recipient: RECIPIENT, consumeNonce: (n: string, e: number) => consumeNonceInMemory(n, e) };
    await verifySignIn(req, opts);
    await rejects(verifySignIn(req, opts), /nonce already used/);
  });
});

describe("session tokens", () => {
  test("round trip", async () => {
    const s = await issueSession("alice.testnet", "s3cret");
    expect(await verifySession(s.token, "s3cret")).toBe("alice.testnet");
  });
  test("wrong secret / tampered / expired fail", async () => {
    const s = await issueSession("alice.testnet", "s3cret");
    await rejects(verifySession(s.token, "other"), /invalid session/);
    const [body, mac] = s.token.split(".");
    const forged = btoa(JSON.stringify({ sub: "bob.testnet", exp: s.expiresAt, v: 1 })).replace(/=+$/, "");
    await rejects(verifySession(`${forged}.${mac}`, "s3cret"), /invalid session/);
    await rejects(verifySession(`${body}`, "s3cret"), /malformed/);
    const old = await issueSession("alice.testnet", "s3cret", Date.now() - 2 * 86_400_000);
    await rejects(verifySession(old.token, "s3cret"), /expired/);
  });
});

describe("sign-in message", () => {
  test("new Yeetpad title and the pre-rebrand title both parse", async () => {
    const { buildSignInMessage, parseSignInMessage } = await import("@osl/schema");
    expect(buildSignInMessage("alice.testnet").startsWith("Sign in to Yeetpad\n")).toBe(true);
    const old = "Sign in to One Shot Launchpad\naccount: alice.testnet\nissued: 2026-10-21T10:00:00.000Z";
    expect(parseSignInMessage(old)?.accountId).toBe("alice.testnet");
    expect(parseSignInMessage("Sign in to Evilpad\naccount: alice.testnet\nissued: 2026-10-21T10:00:00.000Z")).toBeNull();
  });
});

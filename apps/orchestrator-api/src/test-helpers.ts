// Test-only helpers: build NEP-413 sign-in requests with near-api-js's own signer
// (independent of src/auth.ts's serializer, so the tests cross-check it).
import { KeyPair, KeyPairSigner } from "near-api-js";
import { buildSignInMessage, type SessionRequest } from "@osl/schema";
import { b64encode } from "./auth";

export async function signIn(
  kp: KeyPair,
  accountId: string,
  recipient: string,
  o: { issuedAt?: Date; message?: string; nonce?: Uint8Array; callbackUrl?: string } = {},
): Promise<SessionRequest> {
  const message = o.message ?? buildSignInMessage(accountId, o.issuedAt ?? new Date());
  const nonce = o.nonce ?? crypto.getRandomValues(new Uint8Array(32));
  const signed = await new KeyPairSigner(kp).signNep413Message(accountId, {
    message,
    recipient,
    nonce,
    callbackUrl: o.callbackUrl,
  });
  return {
    accountId,
    publicKey: kp.getPublicKey().toString(),
    signature: b64encode(signed.signature),
    message,
    nonce: b64encode(nonce),
    recipient,
    callbackUrl: o.callbackUrl ?? null,
  };
}

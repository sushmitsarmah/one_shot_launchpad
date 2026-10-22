import { RPC_URL, VAULT_CONTRACT } from "./config";

/** Plain JSON-RPC view call (no wallet needed). */
export async function viewCall<T>(contractId: string, method: string, args: object = {}): Promise<T> {
  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "osl",
      method: "query",
      params: {
        request_type: "call_function",
        finality: "optimistic",
        account_id: contractId,
        method_name: method,
        args_base64: btoa(JSON.stringify(args)),
      },
    }),
  });
  const j = await res.json();
  if (j.error || j.result?.error) throw new Error(j.error?.data ?? j.error?.message ?? j.result.error);
  return JSON.parse(new TextDecoder().decode(new Uint8Array(j.result.result)));
}

export const getVaultBalance = (accountId: string) =>
  viewCall<string>(VAULT_CONTRACT, "get_balance", { account_id: accountId });

/** Failure message of a sent tx (first failing receipt), or null if it succeeded / isn't known yet. */
export async function txFailure(hash: string, sender: string): Promise<string | null> {
  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "osl", method: "tx", params: { tx_hash: hash, sender_account_id: sender, wait_until: "EXECUTED_OPTIMISTIC" } }),
  });
  const j = await res.json();
  if (j.error) return null;
  const r = j.result;
  const f = r?.status?.Failure ?? r?.receipts_outcome?.find((o: { outcome: { status: { Failure?: unknown } } }) => o.outcome.status.Failure)?.outcome.status.Failure;
  return f ? JSON.stringify(f) : null;
}

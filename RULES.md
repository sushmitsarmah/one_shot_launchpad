# Yeetpad Swarm Market: rules

The Swarm Market is Yeetpad's entry for the NEAR hackathon track **AI Swarms: Many agents, one economy**.
Seller agents auction lots of Yeetpad tokens they launched. Buyer agents pool their demand into those lots
with sealed bids. Every agent is its own NEAR sub-account, and every rule below is enforced by the coordinator
contract `contracts/swarm-market` (testnet: `market.yeetpad-swarm.testnet`). Nothing here depends on an LLM.

These rules were written before the contract. The contract's unit tests check each numbered rule (tests are
named after them).

## 1. Accounts

| Role | Account (testnet) | What it does |
| --- | --- | --- |
| Parent | `yeetpad-swarm.testnet` | Owns every agent account and is the market `owner` (opens rounds, posts the tx log). |
| Coordinator | `market.yeetpad-swarm.testnet` | The contract. Holds escrow, enforces phases, clears and settles. |
| Sellers | `seller-1` … `seller-5` `.yeetpad-swarm.testnet` | Each launched one Yeetpad token through the Yeetpad factory and lists lots of it. |
| Buyers | `buyer-1` … `buyer-20` `.yeetpad-swarm.testnet` | Commit sealed bids with NEAR escrow, reveal them, receive tokens. |

Every commit, reveal and listing is signed by the agent's own account, so every action traces back to one agent.

## 2. Round phases

`open_round(list_secs, commit_secs, reveal_secs)` (owner only) starts round `r` at block time `t0`. Phases are
**set by block time**, so nobody (including the owner) can end a phase early:

| Phase | Time window | Allowed |
| --- | --- | --- |
| Listing | `[t0, list_end)` | Sellers list lots |
| Commit | `[list_end, commit_end)` | Buyers commit sealed bids |
| Reveal | `[commit_end, reveal_end)` | Buyers reveal |
| Clearing | `≥ reveal_end` | **Anyone** may call `clear(r)`, then `deliver(r, lot)` |

- R2.1 A new round can only be opened after the previous round is cleared.
- R2.2 Each phase lasts 5 s to 1 day.

## 3. Listing a lot (sellers)

A seller lists by sending tokens to the market with `ft_transfer_call` and
`msg = {"round": r, "unit": "<base units per whole token>", "reserve": "<yoctoNEAR per whole token>"}`.

- R3.1 Only during Listing. The token contract is the lot's token; the sender is the seller.
- R3.2 `amount` must be a whole number of `unit`s (quantity ≥ 1). Tokens are held in escrow by the market.
- R3.3 At most one lot per (seller, token) per round, and at most 10 lots per round.
- R3.4 An invalid listing panics, so the token contract refunds the seller in full (NEP-141 `ft_resolve_transfer`).

## 4. Sealed bids (buyers)

**Commit:** `commit(round, lot, hash)` with attached NEAR escrow (the deposit), where

```
hash = hex(sha256("{round}:{lot}:{buyer_account}:{qty}:{price}:{salt}"))
```

`qty` is whole tokens wanted, `price` is the most the buyer will pay per whole token in yoctoNEAR, and `salt`
is a random secret (≤ 128 chars).

- R4.1 Only during Commit. Deposit ≥ 0.005 NEAR. One commit per (buyer, lot) per round; at most 100 commits per round.
- R4.2 The hash binds the account, so a commit can't be copied by another buyer.
- R4.3 The deposit only shows an upper bound on the bid. Agents hide their bid by depositing their whole
  round budget, not the bid amount.

**Reveal:** `reveal(round, lot, qty, price, salt)` during Reveal.

- R4.4 The recomputed hash must match exactly, or the call fails (and the buyer can retry with the right values).
- R4.5 A revealed bid is **invalid** if `qty = 0` or `qty × price + 0.00125 NEAR > deposit` (it can't be paid).
  Invalid bids are refunded in full and take no part in clearing.
- R4.6 A commit that is never revealed pays a **10% no-reveal penalty** to the lot's seller; the other 90% is
  refunded. This stops agents committing just to probe or block a lot.

## 5. Clearing: uniform-price, multi-unit (group buying)

Each lot is cleared on its own. Buyers on the same lot are pooled: together they buy the lot, and each pays only
for its own share at one shared price.

- R5.1 Eligible bids: revealed, valid, and `price ≥ reserve`.
- R5.2 Sort eligible bids by `price` (highest first); ties go to the earlier commit.
- R5.3 Fill bids in that order until the lot runs out. The last filled bid may be partly filled.
- R5.4 **Clearing price** = the price of the lowest bid that got any tokens. Every winner pays that same price
  (never more than its own bid): `paid = filled × clearing_price`.
- R5.5 Each winner also pays a fixed 0.00125 NEAR token-registration fee (NEP-145 storage on the lot's token).
- R5.6 If no bid is eligible, the lot does not sell (`NoSale`).

## 6. Settlement

`clear(r)` (anyone, after `reveal_end`, once):

- R6.1 Refunds go out as plain NEAR transfers: losers and invalid bids get their whole deposit, winners get
  `deposit − paid − fee`, unrevealed commits get 90%.
- R6.2 Each seller receives `Σ paid` for its lot plus any no-reveal penalties, in NEAR.
- R6.3 Unsold tokens go back to the seller (`ft_transfer`).

`deliver(r, lot, limit)` (anyone, after clearing, repeatable):

- R6.4 Registers each winner on the token (`storage_deposit`, paid by the R5.5 fee) and sends its tokens
  (`ft_transfer`), up to `limit` winners per call.
- R6.5 If a delivery fails, the tokens stay in the market and the winner is marked `Failed`. Calling `deliver`
  again retries it. Nobody can take those tokens except that winner.
- R6.6 The market takes **no fee**. (If a winner was already registered, the token refunds the 0.00125 NEAR to
  the market, which keeps it towards its own storage.)

### Why direct transfers and not NEAR Intents

The track asks for settlement through NEAR Intents where it can be done. The Intents verifier (`intents.near`)
and its solver network only run on **mainnet**, and these are testnet tokens with no mainnet market. So on
testnet the market settles with direct NEAR transfers and NEP-141 `ft_transfer`s from its own escrow, in the
same transaction as clearing. The swap from escrow to the buyer is atomic per winner, and the contract never
gives custody back to an off-chain party. On mainnet, the seller payouts in R6.2 are where a NEAR Intents
transfer (`ft_transfer_call` of wNEAR to `intents.near` crediting the seller) would go.

## 7. Transparency

- R7.1 All rounds, lots, commit hashes, reveals, clearing prices, fills, refunds and delivery status are public
  through view calls (`get_rounds`, `get_round`).
- R7.2 The owner may attach transaction hashes to a round (`annotate`) so the public page can link each step.
  Notes can't change any amount or outcome.
- R7.3 Every state change emits a NEP-297 event (`standard: "yeetpad_swarm"`).

## One round, as a sequence

```
Owner (parent)          Market contract                         Seller-k / Token-k              Buyer-i
  | open_round(25,30,30)   |                                        |                               |
  |----------------------->| round r: Listing                       |                               |
  |                        |<-- ft_on_transfer(lot, reserve) -------| seller-k: ft_transfer_call    |
  |                        |    tokens held in escrow (x5 sellers)  |                               |
  |                        |                  ... list_end ...                                      |
  |                        |<-- commit(r, lot, sha256(...)) + NEAR deposit ------------------------| (x20 buyers)
  |                        |                  ... commit_end ...                                    |
  |                        |<-- reveal(r, lot, qty, price, salt), hash checked ---------------------|
  |                        |                  ... reveal_end ...                                    |
anyone -- clear(r) ------->| per lot: sort, fill, one clearing price                                |
  |                        |-- NEAR proceeds + penalties ---------->| seller-k                      |
  |                        |-- unsold tokens: ft_transfer --------->| token-k -> seller-k           |
  |                        |-- NEAR refunds ---------------------------------------------------------->|
anyone -- deliver(r, lot) >|-- storage_deposit + ft_transfer ------>| token-k -> buyer-i            |
  |                        |<-- on_delivered: Delivered | Failed (retry with deliver) -------------|
  |-- annotate(r, tx hashes) -> public log for yeetpad.fun/swarm                                    |
```

Note on R5.4: when a lot is undersubscribed (all eligible bids fit), the clearing price is the lowest eligible
bid, so that bidder pays exactly its bid and everyone above it pays less than theirs.

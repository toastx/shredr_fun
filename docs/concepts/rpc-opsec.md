---
description: "The enclave hides execution. It does not hide who connected to it, from where, or when."
icon: route
---

# RPC operational security

The private ephemeral rollup runs inside a TEE, so the validator operator cannot read what executes. That is a strong guarantee about *execution*. It says nothing about everything that happens before execution starts.

A transaction reaches the enclave over a network. Someone accepted the connection, someone routed the bytes, someone saw a packet leave your machine at a particular size at a particular moment. None of that is inside the enclave. All of it is linkable.

This page is about that gap.

## What actually leaks

Assume the cryptography is perfect and the enclave is sound. An adversary who can watch the RPC edge still learns:

| Signal | What it gives them |
|---|---|
| Source IP | The user. Directly, or via the ISP subpoena that follows. |
| TLS SNI / ALPN | Which service you are talking to, before any encryption of payload matters. |
| Connection timing | A deposit on L1 at T and a rollup connection at T+2s is one user, twice. |
| Payload size | Instruction count and account count, from the encrypted frame length alone. |
| Request cadence | Session boundaries: when a user started, how long they stayed. |
| Error responses | Whether an account exists, whether it is delegated, before any state changes. |

The last four survive TLS. Encryption hides content, not shape.

For a B2B pool this is the whole ballgame. There are not many depositors. A treasury desk moving eight figures is identifiable from timing and size alone, against a background of a few dozen other users, without anyone breaking a single cipher.

## The router

Clients do not talk to a rollup validator. They talk to a **router** that resolves which ephemeral rollup owns the accounts a transaction touches, then forwards it.

That makes the router the single most sensitive component in the system that is not the enclave, because it is the one place where the *identity* of a request and its *content* are in the same process at the same time. Everything below follows from taking that seriously.

### It terminates TLS, so it must be treated as hostile

The router sees plaintext requests and source addresses together. Design as if it will eventually be compromised:

* **No request logging.** Not sampled, not "errors only", not to disk. An error log with a source IP and an account address is the correlation the whole design exists to prevent, sitting in a file with a retention policy.
* **Strip on ingress.** `X-Forwarded-For`, `X-Real-IP`, `Forwarded`, `Via`, `User-Agent`, `Referer`, and anything else the client volunteered. The router does not need them and must not pass them on.
* **No client identity upstream.** Whatever the router sends to the enclave carries the router's identity, not the caller's.
* **Ephemeral state only.** In-memory routing tables, no request history, no per-client counters that outlive the connection.
* **Crash without a core dump.** A dump of the router's address space is a dump of plaintext transactions.

Reverse proxies, load balancers and CDNs in front of the router log by default, and are usually not under the same operational control. Each one is a copy of the correlation.

### Connection-level hygiene

**Connection pooling and reuse.** A fresh TCP connection per request is a fresh timing signal per request. Pool, keep alive, and keep session boundaries invisible.

**One endpoint for everything.** If reads and writes, or deposits and withdrawals, hit different hosts or paths, DNS and SNI classify traffic before a packet of payload is read. One hostname, one path, one indistinguishable stream.

**No conditional endpoints.** A client that only calls `/attest` when it has an attestation to submit has told the observer it has one. Uniform call patterns, including calls that do nothing.

**HTTP/2 or HTTP/3 with multiplexing.** Multiple logical requests in one connection blur per-request boundaries. Padding on top of that is cheap; a fixed-size request envelope costs bandwidth and removes size as a signal entirely.

### Where the client connects from

The router can be perfect and the source IP still identifies the user. That is not the router's problem to solve, and pretending otherwise is how systems ship with a hole in them.

For a B2B deployment the honest options, in order of how much they actually help:

1. **Egress through infrastructure the user already trusts** — their own VPN concentrator or cloud NAT. The observed IP is the company's, which the counterparty already knows. This removes nothing about *which company*, and everything about *which employee, from where*.
2. **A shared exit pool.** All clients egress through the same small set of addresses. An observer sees the pool, not the member. This is the highest-value change per unit of effort, and it is mostly a deployment decision.
3. **Tor or a mixnet.** Removes the IP entirely; adds latency that fights the sub-50ms execution the rollup was chosen for. Reasonable for the deposit leg, usually not for interactive rollup traffic.

State plainly which of these a deployment uses. A privacy product whose threat model quietly assumes users are behind a VPN is making a promise the code does not keep.

### Timing

The two legs of a cycle are the correlation an observer wants most: an L1 deposit and, shortly after, an L1 withdrawal of a suspiciously similar amount.

The rollup hides the hop between them. It does not hide their timestamps, and the base layer records both.

Mitigations are client policy, not program policy — the program accepts any amount and imposes no delay, and [`constants`](../program/accounts-and-state.md) says so explicitly rather than implying otherwise:

* **Amount normalisation.** Deposits and withdrawals in fixed denominations. Two legs that match to the lamport link themselves regardless of what happened in between.
* **Randomised delay.** A uniform jitter window between legs, sized against expected pool traffic. A delay that is always ~5 minutes is itself a signature.
* **Batching.** Where the business flow allows it, several deposits committing together.

None of these are RPC concerns strictly speaking. They are here because the RPC layer is where people expect timing protection to come from, and it cannot provide it. The router can hide who connected. It cannot hide that an L1 transaction landed.

## The rollup fee payer

Everything above is about observers outside the system. The shielded pool adds a
party inside it.

Its spend instruction carries the note secret in its data, because there is no
proof system to replace it with. Anyone who handles that transaction before it
reaches the enclave can hash the secret twice and pair the deposit commitment
with the withdrawal nullifier themselves — which is the one link the pool exists
to hide.

The party who handles it is the fee payer. So for a pool deployment:

* **Run a dedicated Kora instance for rollup traffic.** `KORA_ROLLUP_RELAYER_URL`
  already exists as a separate endpoint; here that separation is load-bearing
  rather than a convenience.
* **Put it in the enclave's trust domain.** Same operator, same host if possible,
  same no-logging posture as the router above.
* **Never point it at a shared or third-party paymaster.** A public paymaster
  seeing pool spends is a public paymaster that can deanonymise every one of
  them.

See [The shielded pool](shielded-pool.md) for what removing this dependency would
cost — it is a proof system, not a configuration change.

## Enclave attestation

Everything above assumes the thing on the far side of the router is the enclave you think it is. Verify it, do not assume it:

* **Check the remote attestation quote** before sending anything sensitive, and check it against a pinned measurement — not merely that a quote parsed.
* **Pin the validator identity.** `constants::tee_validator()` pins `MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo` on mainnet. The devnet default is `None`, deferring to the network's choice, which is safe only while that choice is stable — and both PDAs in a cycle must land on the *same* validator or the private transfer is not executable at all.
* **Fail closed on attestation failure.** No fallback to a non-TEE validator. A fallback path is the path an attacker will arrange for you to take.
* **Re-verify on reconnect.** Endpoints move.

## Deployment checklist

* [ ] Router logging disabled at the process level, not filtered
* [ ] Ingress headers stripped; nothing client-supplied forwarded upstream
* [ ] No CDN, WAF or load balancer in front that logs independently
* [ ] TLS terminates once, on hardware you control
* [ ] Core dumps disabled on the router process
* [ ] One hostname and one path for all rollup traffic
* [ ] Connection pooling on; keep-alive tuned so sessions do not fragment
* [ ] Client egress strategy chosen, documented, and stated to users
* [ ] Enclave attestation verified against a pinned measurement before first use
* [ ] Validator identity pinned on mainnet
* [ ] Amount normalisation and delay policy configured client-side
* [ ] Relayer screening logs stored separately from anything that sees IPs

## What this does not fix

Being explicit about the residue matters more than the checklist:

* **The pool's own size.** A pool with six depositors offers six-depositor privacy no matter how the network is configured.
* **The relayer knows.** The screening service sees `(depositor, burner)` by construction — that pairing is what makes the deposit auditable. Its logs are the deanonymisation set, and they are a compliance requirement, not a bug. Store them like the liability they are: separate host, separate keys, separate access control from anything that ever sees an IP address.
* **Kora knows it paid.** The fee payer sees the transaction it signs.
* **On-chain amounts are public on both legs.** Only the hop between them is hidden.

The design's claim is narrow and worth stating precisely: *an observer with the full Solana ledger cannot link a deposit to a withdrawal.* It is not "nobody knows". Two named parties know, deliberately, and the point of the architecture is that they are the two parties a regulator would ask.

## See also

* [KYT gating](kyt-gating.md) — the deposit-side check and the relayer that feeds it
* [Ephemeral rollups](ephemeral-rollups.md) — delegation, the TEE validator, and settlement
* [The privacy model](privacy-model.md) — what the system claims and what it does not

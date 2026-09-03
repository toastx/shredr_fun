---
description: "How a B2B privacy pool screens depositors without the chain ever learning who they are."
icon: shield-check
---

# KYT gating

A privacy pool that anyone can deposit into is a mixer. A privacy pool that screens who deposits, while still hiding what they do afterwards, is a business product. The difference is one instruction.

This page specifies that instruction, the off-chain relayer that feeds it, and how the two fit around the MagicBlock private ephemeral rollup.

## The shape of the problem

Solana programs cannot make network calls. A compliance check — sanctions lists, exposure scoring, whatever the provider sells — happens off-chain by definition. So the on-chain question is never "is this wallet clean?" It is:

> Did someone I trust to answer that question say yes, about *this* deposit, recently?

Answering it needs three things: a key the program recognises, a message that cannot be reinterpreted, and a signature check the program can actually perform.

## Why the ed25519 precompile

Verifying an ed25519 signature inside a program costs compute and, more importantly, means writing curve arithmetic. Solana already ships the answer: the `Ed25519SigVerify111111111111111111111111111` precompile.

A transaction carries the precompile instruction alongside the deposit. The runtime executes precompiles **before** any program runs, and a failed signature fails the whole transaction. By the time `InitializeAndDelegate` starts, one thing is already established: every signature the precompile was pointed at is valid.

What is *not* established is anything else. The precompile does not know what SHREDR is. It will happily verify a signature from a random key over a random message. So the program's job is the rest of it:

1. There is an `Ed25519SigVerify` instruction in this transaction.
2. It checked the **KYT authority's** public key, not some other key.
3. The message it covered is a SHREDR attestation, current version.
4. That attestation is bound to **this burner** and covers **this amount**.
5. It has not expired, and the verdict is *allow*.

Drop any one and the gate is decorative.

### The offsets trap

The precompile's instruction data is a header of byte offsets pointing at the public key, signature and message. Each offset carries an *instruction index*: `u16::MAX` means "in my own data", anything else means "in instruction N of this transaction".

That is the sharp edge. An attacker can build a precompile instruction whose message offset points into a *different* instruction, have the precompile verify a real signature over bytes we never look at, and leave a forged attestation sitting in its own data blob for us to read. The signature verifies. The message we read is not the message that was signed.

`kyt::attested_message` requires all three indices to be `u16::MAX`. That single check is what makes reading the message back out of the same blob sound. The rest of the parser follows from treating every offset as attacker-controlled: overflow-check each end, bound it against the blob length, and only then slice.

Two more refusals worth naming:

* **Multiple signatures.** Only the first offsets entry is read, so a blob declaring three signatures would carry two nobody examined. Refused outright rather than partially checked.
* **A non-precompile program id.** The scan matches on program id. Bytes shaped like an attestation, sitting in some other program's instruction, were never verified by anything.

## The attestation

90 bytes, fixed:

```
[ 0.. 8]  magic          b"SHREDRKY"
[ 8]      version        1
[ 9]      verdict        1 = allow, anything else = screened and refused
[10..42]  depositor      the L1 wallet the relayer screened
[42..74]  burner         binds the attestation to one stealth PDA
[74..82]  max_amount     u64 LE, lamports ceiling
[82..90]  expiry_unix    i64 LE, unix seconds, inclusive
```

**Magic** exists because the KYT authority is a key that signs other things. Without a domain tag, any 90-byte message it ever signs for another purpose becomes a deposit attestation.

**Version** is rejected rather than guessed at. A future layout means these offsets read different fields; reading them anyway is how a "compatible" parser turns a ceiling into a timestamp.

**Depositor** is never checked on-chain, and cannot be. The funding wallet does not appear in the deposit transaction — the deposit arrives from a one-time burner, which is the entire point of the design. The program has nothing to compare it against. It is in the message so that an auditor holding the relayer's log can prove, later, which wallet was cleared for which burner. The relayer's signature is the binding.

**Burner** is what stops an attestation being lifted onto someone else's deposit.

**max_amount** and **expiry_unix** bound the damage if one leaks.

### Replay ceiling

An attestation is bound to one burner, and burners are one-time, so it cannot be moved to another deposit. It *can* be presented again for a top-up of the same PDA until it expires, each time capped at `max_amount`.

That is a deliberate ceiling, not an oversight — the relayer controls expiry, so the window is a policy dial rather than a code change. If per-deposit single use is ever required, the upgrade is a used-attestation PDA keyed by the message hash, closed on undelegate.

## The authority key

`constants::KYT_ATTESTATION_AUTHORITY` is compiled in, so rotating it is a redeploy rather than a runtime toggle. There is no admin instruction that can point the gate at a different key, because an admin instruction that can point the gate at a different key can point it at the attacker's key.

```sh
SHREDR_KYT_AUTHORITY=<base58 pubkey> cargo build-sbf --features mainnet
```

Unset behaviour differs by network, on purpose:

| Build | Fallback | Effect |
|---|---|---|
| `--features mainnet` | all-zero address | `KytAuthorityUnset` — **every deposit refused** |
| default (devnet) | `KYT_AUTHORITY_PLACEHOLDER` | a real key shape nobody holds a secret for |

The mainnet fallback is the important one. A compliance gate that is missing must take no deposits at all; a build that silently accepted them because a variable was unset would be worse than having no gate, because it would look like it had one.

The devnet placeholder is `sha256("shredr devnet kyt placeholder")`, base58-encoded — a nothing-up-my-sleeve value that lets the test suite build well-formed attestations without anyone holding a signing key. It is not a weaker gate: the precompile rejects any signature claiming to be from it, so a devnet build that forgets to configure a real relayer still clears nothing. It only moves the failure from "no authority" to "bad signature".

## Both legs are gated

A cycle uses two stealth PDAs and both are created by `InitializeAndDelegate` — one funded (the deposit leg), one empty (the exit leg). The gate applies to both.

This is not thoroughness for its own sake. The program deliberately does not distinguish the two roles, and gating only the funded one would hand an observer a free classifier: attestation present means deposit, absent means exit. The uniform check keeps the two instructions indistinguishable on-chain, which is the same reason every account carries a receipt commitment whether or not the client uses it.

## The relayer

The screening service is a small HTTP service holding one ed25519 keypair. Its whole job:

```
POST /api/kyt/screen
  { depositor, burner, maxAmount, ttlSeconds? }

  1. call the compliance provider for `depositor`
  2. map the provider's answer to allow / refuse
  3. build the 90-byte message
  4. sign it with the KYT authority key
  5. return { verdict, message, signature, authority, expiresAt }
```

Design notes that are not obvious:

**It signs, it does not send.** The relayer never sees a transaction, never holds user funds, and cannot broadcast on a user's behalf. It emits an attestation. That keeps its blast radius to "can clear deposits it should not have" rather than "can move money". Fee payment and transaction submission stay with Kora, which is a separate key and a separate service.

**It is bound before it is signed.** `burner` and `maxAmount` come from the request and go into the signed message. A relayer that signed only "this depositor is clean" would be issuing a bearer token good for every deposit that wallet ever makes.

**Its expiry is short.** The TTL is the replay window. Minutes, not days.

**It refuses in-band.** A refused screening still returns a signed message, with `verdict = 0`. The client gets a definite, attributable answer instead of a timeout it might retry into a race. On-chain that message produces `KytScreeningRejected`, which is a different error from a missing attestation — the difference between "we screened you and said no" and "you did not ask".

**Its logs are the audit trail.** `(depositor, burner, verdict, provider response, signature)` is the record that connects a cleared wallet to an on-chain deposit. Nothing else in the system can reconstruct it, and nothing on-chain reveals it.

## System flow

```
 ┌────────┐                                                   ┌──────────┐
 │ client │                                                   │ relayer  │
 └───┬────┘                                                   └────┬─────┘
     │  1. derive one-time burner from mainKey + nonce             │
     │                                                             │
     │  2. POST /api/kyt/screen { depositor, burner, maxAmount }    │
     ├────────────────────────────────────────────────────────────▶│
     │                                        ┌────────────────────┤
     │                                        │ compliance provider │
     │                                        └────────────────────┤
     │  3. { verdict, message, signature }                          │
     │◀────────────────────────────────────────────────────────────┤
     │                                                              │
     │  4. verdict = 0 → stop here. Nothing was broadcast.           │
     │                                                              │
     │  5. build tx: [ Ed25519SigVerify | InitializeAndDelegate ]    │
     │     sign as burner, hand to Kora as fee payer                 │
     ▼
 ┌─────────────────────────────────────────────────────────────────────┐
 │ Solana L1                                                            │
 │                                                                      │
 │   runtime verifies the ed25519 signature ─── bad ──▶ tx fails         │
 │                    │ ok                                              │
 │                    ▼                                                 │
 │   InitializeAndDelegate                                              │
 │     verify_stealth_pda                                               │
 │     verify_deposit_attestation  ─── refused ──▶ revert, nothing moved │
 │            │ cleared                                                 │
 │            ▼                                                         │
 │     create PDA (relayer pays rent) → sweep burner → ACL → delegate   │
 └────────────────────────────┬─────────────────────────────────────────┘
                              │ state leaves L1
                              ▼
 ┌─────────────────────────────────────────────────────────────────────┐
 │ MagicBlock private ephemeral rollup (TEE)                            │
 │                                                                      │
 │   PrivateTransfer: deposit PDA ──▶ exit PDA     sub-50ms, unobserved  │
 │   the hop never appears on Solana                                    │
 └────────────────────────────┬─────────────────────────────────────────┘
                              │ commit + undelegate
                              ▼
 ┌─────────────────────────────────────────────────────────────────────┐
 │ Solana L1                                                            │
 │   Withdraw: exit PDA ──▶ any address                                 │
 └─────────────────────────────────────────────────────────────────────┘
```

Note where the gate sits: **on the way in, once.** The rollup does not re-screen, because there is nothing new to screen — value entered the pool through a checked door, and the private transfer moves it between two accounts that both already passed. Screening inside the rollup would also mean an enclave making outbound network calls, which is precisely the leak the enclave exists to prevent.

The account the deposit came *from* is not on-chain at all. What a chain observer sees is a burner address being swept and delegated. What a regulator with the relayer's logs sees is the full path. That split — provable to an auditor, invisible to an observer — is the product.

## Failure modes

| Error | Code | Means |
|---|---|---|
| `KytAuthorityUnset` | 6015 | build has no authority; refuses everything |
| `KytAttestationMissing` | 6016 | no `Ed25519SigVerify` instruction carried one |
| `KytAttestationMalformed` | 6017 | bad length, magic, version, offsets, or multiple signatures |
| `KytUnknownAuthority` | 6018 | signed by a key that is not the configured authority |
| `KytAttestationBurnerMismatch` | 6019 | bound to a different burner |
| `KytAttestationAmountExceeded` | 6020 | deposit larger than what was cleared |
| `KytAttestationExpired` | 6021 | past `expiry_unix` |
| `KytScreeningRejected` | 6022 | the relayer screened the depositor and said no |

The scan keeps the most specific failure it saw rather than returning a flat "missing", so a relayer debugging a rejected deposit is told whether its attestation was late, small, or for the wrong burner.

## See also

* [The Kora relayer](relayer.md) — fee payment, a separate key and a separate service
* [Ephemeral rollups](ephemeral-rollups.md) — what happens after the gate
* [RPC operational security](rpc-opsec.md) — protecting the metadata this design does not put on-chain

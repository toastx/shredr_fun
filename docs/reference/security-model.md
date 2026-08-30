---
description: "Consolidated security properties and on-chain invariants."
icon: lock
---

# Security model

A consolidated view of what the code enforces and how.

{% hint style="info" %}
shredr currently runs on Solana **devnet**.
{% endhint %}

## Custody

**shredr is non-custodial.** No party other than the user can move user funds.

| Party | Can move funds? | Why not |
|---|---|---|
| The user | Yes | Holds the wallet that derives the main burner |
| The backend | No | Stores only encrypted blobs; has no keys |
| The relayer | No | Signs as fee payer; is never an owner |
| The program | Only per its rules | Requires the recorded owner's signature |
| MagicBlock validator | No | Executes; does not own |

## Key security

All keys derive from one wallet signature over `SHREDR_V1:<wallet address>`.

```
masterSeed     = SHA256( signature ‖ "SHREDR_NONCE_MASTER" )
storageKey     = SHA256( signature ‖ "SHREDR_STORAGE_KEY"  )
burnerSeed     = SHA256( signature ‖ "SHREDR_BURNER_MASTER")
mainBurnerSeed = SHA256( signature ‖ "SHREDR_MAIN_BURNER"  )
auditSeed      = SHA256( signature ‖ "SHREDR_AUDIT_MASTER" )
```

| Property | Implementation |
|---|---|
| Domain separation | Five distinct tags; a leak in one context does not compromise the others |
| Selective disclosure | One viewing key per invoice, derived via HKDF; opens that payment and provably nothing else — see [Viewing keys](../concepts/viewing-keys.md) |
| Forward secrecy of receive addresses | `nonce[N] = SHA256(nonce[N-1])` — a leaked nonce reveals future addresses, never past ones |
| Main burner isolation | Derived from the signature directly, so no nonce leak can reach it |
| No transmission | Signature, seeds, and keypairs stay in browser memory |
| Memory hygiene | `zeroMemory()` overwrites with random bytes, then zeros |
| Non-extractable storage key | `crypto.subtle.importKey(..., extractable: false)` |
| No seed phrase | The wallet is the backup |

→ [Key derivation](../concepts/key-derivation.md)

## Encryption

| | Value |
|---|---|
| Algorithm | AES-GCM, 256-bit |
| IV | 12 random bytes per encryption, prepended |
| Authentication | GCM tag — tampering and wrong keys fail loudly |
| Key derivation | SHA-256 of signature + domain tag |

Applied to IndexedDB records and backend blobs.

`DecryptionError` distinguishes `wrong_key` (auth failure — "not my blob") from `corrupted` (malformed data), which is what makes blind blob-scanning recovery work.

## On-chain invariants

Enforced by the program:

| Invariant | Enforcement | Error on violation |
|---|---|---|
| PDAs match their derivation | `verify_stealth_pda()` re-derives and compares | `InvalidStealthPDA` (6000) |
| Accounts are program-owned | `owned_by(&PROGRAM_ADDRESS)` | `InvalidProgramOwner` (6001) |
| Data is a real stealth account | Length + `SHREDRSA` discriminator | `AccountDataTooSmall` (6002), `InvalidDiscriminator` (6003) |
| Only the owner moves funds | Signer compared to recorded `owner` | `IllegalOwner` |
| No withdrawal while delegated | `delegated` flag check | `AlreadyDelegated` (6004) |
| No re-initialization | `lamports() > 0` rejected | `AccountAlreadyInitialized` (6010) |
| Rent-exemption preserved | Explicit floor check in `Withdraw` | `BalanceInvariantViolation` (6009) |
| No account aliasing | Source ≠ destination | `SelfTransferNotAllowed` (6011) |
| No integer overflow | `checked_add` / `checked_sub` everywhere | `ArithmeticOverflow`, `InsufficientFunds` |
| Required signers present | `is_signer()` checks | `MissingSigner` (6007) |

### The balance invariant

```
account lamports = rent-exempt minimum  +  deposited_amount
                   (relayer's, locked)     (user's, withdrawable)
```

`deposited_amount` is tracked in state, independent of the raw lamport balance. Withdrawals are capped at it, and a second explicit floor check catches any desync — dropping below rent would let the runtime reap the account and strand the residual lamports.

### Validation placement

Every instruction validates in `TryFrom`, before `process()` runs. This is a deliberate audit affordance: all checks for an instruction live in one place, and the business logic can assume its inputs are good.

### Unsafe code

`helpers.rs` contains the only `unsafe` blocks, all in `get_stealth_mut()` and `write_stealth_discriminator()`. Each is guarded by explicit preconditions checked immediately before:

1. Program ownership
2. Sufficient data length
3. Discriminator match

The documented safety contract requires **no aliasing mutable references**, which is why `PrivateTransfer` rejects self-transfers before touching state.

## Privacy properties

| Property | Mechanism | Holds? |
|---|---|---|
| Sender cannot find your main wallet | One-time burners + off-graph rollup transfer | **Yes** |
| Senders cannot link to each other | Forward-only nonce chain | **Yes** |
| Your wallet never appears on-chain | Main burner signs; relayer pays | **Yes** |
| Backend cannot read state | AES-GCM under a key it never has | **Yes** |
| Backend cannot identify users | No identifiers in blobs; no auth | **Yes** |
| Amounts are hidden | Use normalized denominations | User-side |

## Known weaknesses

Summarized here; detailed in [Limitations](limitations.md).

| Weakness | Severity | Status |
|---|---|---|
| Timing correlation | **High** | Delay constants defined, **not implemented** |
| Blob trial-decryption is O(total blobs) | Medium | Client pages the full set; cost grows with adoption |
| Main PDA cannot be re-delegated | Medium | Detected and reported, not solved |
| Committed Helius API key | Low | In the client bundle |
| WebSocket subscriptions never released | Low | Compensated by on-chain re-checks |
| Backend CORS defaults to permissive | Low | Configuration hazard |

## Attack surface

<details>
<summary><strong>Client</strong></summary>

* XSS in the app → full key compromise while the page is open
* Malicious browser extension → same
* Supply-chain compromise of a dependency → same
* Compromised RPC → misleading balances, though not fund loss (the program validates independently)

The non-extractable storage key limits what an XSS payload can *exfiltrate*, but not what it can *do* while the page is open.
</details>

<details>
<summary><strong>Program</strong></summary>

* The `unsafe` casts in `helpers.rs` — guarded, but the aliasing contract is a caller obligation
* CPI interactions with the delegation and permission programs
* `UndelegationCallback` does not verify its caller, relying on the SDK's checks
* No pause mechanism — `ProgramConfig` is defined but unimplemented, so there is no way to halt the program if a bug is found
</details>

<details>
<summary><strong>Backend</strong></summary>

* Unauthenticated writes, mitigated only by IP rate limiting
* `X-Forwarded-For` spoofing without a trusted proxy
* Blob-table growth is unbounded (soft deletes)
* Nothing here endangers funds
</details>

<details>
<summary><strong>Relayer</strong></summary>

* Censorship
* Request-log correlation
* Denial of service if unfunded — every on-chain action fails, with no fallback
</details>

## For auditors

Start here:

| Priority | Files |
|---|---|
| 1 | `shredr-program/src/helpers.rs` — all `unsafe` code |
| 2 | `shredr-program/src/instructions/*.rs` — validation in `try_from` |
| 3 | `src/lib/BurnerService.ts`, `NonceService.ts` — key derivation |
| 4 | `src/lib/ShredrClient.ts` — flow orchestration and error handling |
| 5 | `src/lib/StorageService.ts` — encryption and concurrency |
| 6 | `shredr-backend/src/db/db.rs` — SQL and validation |

Known-unfinished areas are documented in [Limitations](limitations.md) rather than hidden. The unused denomination and delay constants are the clearest signal of what was planned but not built.

## Next

* [Limitations and known gaps](limitations.md)
* [The privacy model](../concepts/privacy-model.md)

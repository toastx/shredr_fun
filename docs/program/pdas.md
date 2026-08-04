---
description: "Every program-derived address shredr uses, and how to derive it."
icon: sitemap
---

# PDA derivation

shredr uses five PDAs per stealth account: one it owns, and four required by MagicBlock delegation.

## The stealth PDA

The only one shredr derives itself.

```
seeds   = ["shredr_stealth_address", burner_pubkey]
program = H9pUQeNA2RwBHRwx52V8nqWpCAKReSA3gGUuRFHbEjG6
```

{% tabs %}
{% tab title="TypeScript" %}
```typescript
export function deriveStealthPDA(burnerPubkey: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [SEEDS.STEALTH_ADDRESS, burnerPubkey.toBuffer()],
    SHREDR_PROGRAM_ID,
  );
}
```

Synchronous by design — the Codama-generated finder is async because kit hashes via SubtleCrypto, which is awkward in UI code.
{% endtab %}

{% tab title="Rust" %}
```rust
pub fn derive_stealth_account_from_pubkey(
    burner_pubkey: &Address,
) -> Result<(Address, u8), ProgramError> {
    Address::derive_program_address(
        &[seeds::STEALTH_ADDRESS, burner_pubkey.as_ref()],
        &PROGRAM_ADDRESS,
    )
    .ok_or(ProgramError::InvalidAccountData)
}
```
{% endtab %}
{% endtabs %}

The burner pubkey is the only variable. Since every burner is one-time, that alone makes the PDA unique — no salt required.

### Verification

The program never trusts a passed-in account. `InitializeAndDelegate` re-derives and compares:

```rust
pub fn verify_stealth_pda(
    account: &AccountView,
    burner_pubkey: &Address,
) -> Result<u8, ProgramError> {
    let (expected_pda, bump) = derive_stealth_account_from_pubkey(burner_pubkey)?;
    if account.address() != &expected_pda {
        return Err(ShredrError::InvalidStealthPDA.into());
    }
    Ok(bump)
}
```

It returns the bump, which becomes part of the signer seeds for the ACL and delegation CPIs.

### The main PDA

Derived **identically**, just with the main burner:

```typescript
const [mainPda] = deriveStealthPDA(mainBurnerPubkey);
```

There is nothing structurally special about it. It is "main" only because its burner never rotates.

## Delegation PDAs

Created by the MagicBlock delegation flow. shredr must derive them correctly to pass them into `InitializeAndDelegate`.

```typescript
const {
  permissionAccount,
  delegationBuffer,
  delegationRecord,
  delegationMetadata,
} = deriveDelegationPDAs(stealthPda);
```

| PDA | Seeds | **Owning program** |
|---|---|---|
| Permission | `["permission", stealthPda]` | `EPHpaA1tt7nJpEgAjRwkPx5tWHiV6cfKZjPPDDZxFKa9` |
| Buffer | `["buffer", stealthPda]` | **`H9pUQeNA...` (shredr)** |
| Delegation record | `["delegation", stealthPda]` | `DELeGGvX...` (delegation) |
| Delegation metadata | `["delegation-metadata", stealthPda]` | `DELeGGvX...` (delegation) |

{% hint style="danger" %}
**The buffer is derived under the shredr program, not the delegation program.**

MagicBlock derives the buffer under the *delegated account's owner program*, which for a stealth PDA is shredr. Getting this wrong produces an account mismatch that fails deep inside a CPI with an unhelpful error. It is the most common mistake in this derivation set.
{% endhint %}

Note the seeds use the **stealth PDA**, not the burner.

```typescript
const BUFFER_SEED              = Buffer.from("buffer");
const DELEGATION_SEED          = Buffer.from("delegation");
const DELEGATION_METADATA_SEED = Buffer.from("delegation-metadata");
const PERMISSION_SEED          = Buffer.from("permission");
```

### What each is for

| PDA | Purpose |
|---|---|
| **Permission** | ACL listing who may act on the account inside the rollup. shredr registers the burner as the sole member |
| **Buffer** | Stages account state during settlement. `UndelegationCallback` reads from it |
| **Delegation record** | Tracks that the account is delegated, and to which validator |
| **Delegation metadata** | Delegation configuration |

## Reserved seeds

Defined but unused:

| Seed | Constant | Intended for |
|---|---|---|
| `shredr_program_config` | `seeds::PROGRAM_CONFIG` | Global admin config (`ProgramConfig`) |
| `shredr_user_address` | `seeds::USER_ADDRESS` | Per-user aggregation (`UserAddress`) |

Present in both `constants.rs` and the client's `SEEDS`. No instruction references them.

## Derivation chain

```
Wallet signature
      │
      ├──▶ nonce[N] ──▶ burner[N] ──▶ PDA(["shredr_stealth_address", burner[N]])
      │                                        │
      │                                        ├──▶ PDA(["permission", pda])          @ permission program
      │                                        ├──▶ PDA(["buffer", pda])              @ SHREDR program
      │                                        ├──▶ PDA(["delegation", pda])          @ delegation program
      │                                        └──▶ PDA(["delegation-metadata", pda]) @ delegation program
      │
      └──▶ mainBurner ──▶ PDA(["shredr_stealth_address", mainBurner])
                                     │
                                     └──▶ (the same four delegation PDAs)
```

## Keeping the two sides in sync

Seeds are defined in three places and must match:

| Location | Constant |
|---|---|
| `src/lib/ShredrProgram.ts` | `SEEDS.STEALTH_ADDRESS` |
| `shredr-program/src/constants.rs` | `seeds::STEALTH_ADDRESS` |
| `src/generated/pdas/` | Codama-generated finders |

`tests/ShredrProgram.test.ts` cross-checks the synchronous `deriveStealthPDA()` against the generated async finder, so drift between the client and the IDL fails in `npm test`. Drift between the client and the Rust constants is **not** automatically caught — the TypeScript file is the documented source of truth.

## Next

* [Instructions](instructions/README.md) — where these accounts get passed
* [Ephemeral rollups](../concepts/ephemeral-rollups.md) — what the delegation PDAs do

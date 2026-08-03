---
description: "PDA derivation, instruction builders, and account parsing for the on-chain program."
icon: code
---

# ShredrProgram

`src/lib/ShredrProgram.ts` — a `@solana/web3.js` v1 facade over the Codama-generated `@solana/kit` client in `src/generated`.

It exists because the rest of the app uses web3.js v1 while the generated client is written against kit, and because the generated PDA finders are async (kit hashes via SubtleCrypto) whereas UI code wants synchronous derivation.

```typescript
import {
  deriveStealthPDA,
  createInitializeAndDelegateInstruction,
  parseStealthAccount,
} from './lib/ShredrProgram';
```

## Constants

```typescript
SHREDR_PROGRAM_ID      // H9pUQeNA2RwBHRwx52V8nqWpCAKReSA3gGUuRFHbEjG6
STEALTH_ACCOUNT_LEN    // 96 = 8-byte discriminator + StealthAccount
MAGIC_BLOCK_PROGRAM_ID // DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSS
MAGIC_CONTEXT          // MagicContext1111111111111111111111111111111
PERMISSION_PROGRAM_ID  // EPHpaA1tt7nJpEgAjRwkPx5tWHiV6cfKZjPPDDZxFKa9

SEEDS = {
  STEALTH_ADDRESS: Buffer.from("shredr_stealth_address"),
  PROGRAM_CONFIG:  Buffer.from("shredr_program_config"),   // reserved
  USER_ADDRESS:    Buffer.from("shredr_user_address"),     // reserved
}

StealthInstruction = {
  InitializeAndDelegate: 0,
  PrivateTransfer: 1,
  CommitStealth: 2,
  CommitAndUndelegateStealth: 3,
  Withdraw: 4,
  UndelegationCallback: 0xff,
}
```

## PDA derivation

### Stealth PDA

```typescript
const [pda, bump] = deriveStealthPDA(burnerPubkey);
```

Seeds `["shredr_stealth_address", burner_pubkey]` under the shredr program. Synchronous, and used for both rotating stealth PDAs and the main PDA — they are derived identically.

### Delegation PDAs

```typescript
const {
  permissionAccount,
  delegationBuffer,
  delegationRecord,
  delegationMetadata,
} = deriveDelegationPDAs(stealthPda);
```

| PDA | Seeds | Owning program |
|---|---|---|
| `permissionAccount` | `["permission", stealthPda]` | Permission program |
| `delegationBuffer` | `["buffer", stealthPda]` | **shredr program** |
| `delegationRecord` | `["delegation", stealthPda]` | Delegation program |
| `delegationMetadata` | `["delegation-metadata", stealthPda]` | Delegation program |

{% hint style="warning" %}
The buffer is derived under the **shredr program**, not the delegation program — MagicBlock derives it under the delegated account's *owner*. This is the easiest of the four to get wrong.
{% endhint %}

## Instruction builders

Each returns a web3.js v1 `TransactionInstruction`, ready to drop into a transaction.

### InitializeAndDelegate

```typescript
createInitializeAndDelegateInstruction(
  relayer: PublicKey,
  burner: PublicKey,
  depositAmount: bigint,
): TransactionInstruction
```

Derives the stealth PDA and all four delegation PDAs internally, so callers pass only the two pubkeys and an amount.

`depositAmount = 0n` creates an empty delegated PDA — how the main PDA is prepared.

→ [Reference](../program/instructions/initialize-and-delegate.md)

### PrivateTransfer

```typescript
createPrivateTransferInstruction(
  sourceBurner: PublicKey,
  sourcePda: PublicKey,
  destinationPda: PublicKey,
  amount: bigint,
): TransactionInstruction
```

Must be sent to the **rollup RPC**. The source burner signs; the program checks it against the source PDA's recorded `owner`.

→ [Reference](../program/instructions/private-transfer.md)

### Commit instructions

```typescript
createCommitStealthInstruction(relayer, stealthAccount, magicProgram?, magicContext?)
createCommitAndUndelegateStealthInstruction(relayer, stealthAccount, magicProgram?, magicContext?)
```

MagicBlock accounts default to the constants. Both go to the rollup RPC. Only the relayer signs.

`createCommitStealthInstruction` is built and tested but unused by the app flow — shredr always commits and undelegates together.

### Withdraw

```typescript
createStealthWithdrawInstruction(
  burner: PublicKey,
  stealthPda: PublicKey,
  destination: PublicKey,
  amount: bigint,
): TransactionInstruction
```

Base layer only, and only on an undelegated PDA. Signed by the burner recorded as owner — in practice always the main burner.

→ [Reference](../program/instructions/withdraw.md)

## Account parsing

```typescript
const state = parseStealthAccount(new Uint8Array(accountInfo.data));
```

```typescript
interface StealthAccountData {
  owner: PublicKey;
  salt: Uint8Array;         // reserved, always zero
  depositedAmount: bigint;
  depositTimestamp: bigint;
  delegated: boolean;
  bump: number;
}
```

Returns `null` if the data is shorter than 96 bytes or the discriminator does not match — so a non-shredr account passed in by mistake is rejected rather than misread.

{% hint style="info" %}
Use `depositedAmount`, not the account's raw lamports. The difference is the rent-exemption the relayer paid, which is not withdrawable.
{% endhint %}

## Errors

```typescript
const message = getShredrErrorMessage(6004);
// "The stealth account is already delegated."

getShredrErrorMessage(1);  // null — not a shredr error
```

Returns `null` for codes outside 6000–6011, which lets callers distinguish shredr errors from System Program or delegation-program errors.

`isShredrProgramError` is re-exported from the generated client.

→ [Errors](../program/errors.md)

## Kit ↔ web3.js adapters

Internal, but worth understanding if you touch this file:

```typescript
toAddress(pubkey)   // web3.js PublicKey → kit Address
toSigner(pubkey)    // → createNoopSigner — only the address matters,
                    //   real signing happens downstream
toTransactionInstruction(kitInstruction)  // → web3.js TransactionInstruction
```

`toSigner` uses a **noop signer** deliberately: the generated builders need something to mark an account as a signer, but the actual signatures come from web3.js keypairs and Kora later. Roles are decoded with kit's `isSignerRole` / `isWritableRole` when converting account metas.

## Regenerating

```bash
npm run generate:client
```

Runs `scripts/generate-client.mjs`, which reads `shredr-program/idl/shredr_program.json` via Codama and rewrites `src/generated/`.

{% hint style="danger" %}
Never hand-edit `src/generated/`. Change the program → regenerate the IDL → regenerate the client. `tests/ShredrProgram.test.ts` pins the wire format (20 tests covering discriminators, PDA seeds, account metas, data layout, and error codes), so drift fails locally instead of on devnet.
{% endhint %}

## Next

* [Instructions](../program/instructions/README.md) — the on-chain side
* [KoraRelayer](kora-relayer.md) — getting these instructions signed and sent

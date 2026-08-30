/**
 * Generates the SHREDR program client under `src/generated/` with Codama.
 *
 * Source of truth is the Shank IDL emitted by the program
 * (`shredr-program/idl/shredr_program.json`). Shank only describes the
 * instructions, so everything the IDL cannot express — account state, PDA
 * seeds, program errors, and the `UndelegationCallback` discriminator — is
 * declared here and must stay in sync with the Rust sources referenced in the
 * comments below.
 *
 * Run with: `npm run generate:client`
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { rootNodeFromAnchor } from "@codama/nodes-from-anchor";
import { renderVisitor } from "@codama/renderers-js";
import {
  accountNode,
  accountValueNode,
  booleanTypeNode,
  bottomUpTransformerVisitor,
  bytesTypeNode,
  bytesValueNode,
  constantPdaSeedNodeFromString,
  createFromRoot,
  errorNode,
  fieldDiscriminatorNode,
  fixedSizeTypeNode,
  numberTypeNode,
  numberValueNode,
  pdaLinkNode,
  pdaNode,
  pdaSeedValueNode,
  pdaValueNode,
  programIdValueNode,
  publicKeyTypeNode,
  publicKeyValueNode,
  structFieldTypeNode,
  structTypeNode,
  updateInstructionsVisitor,
  variablePdaSeedNode,
} from "codama";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const idlPath = join(rootDir, "shredr-program/idl/shredr_program.json");
const outputDir = join(rootDir, "src/generated");

// ============ EXTERNAL PROGRAM IDS ============
// Mirrors `src/lib/constants.ts` and `shredr-program/src/constants.rs`.

const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";
/** Base-layer delegation program — owns delegated accounts, derives the
 *  delegation record/metadata PDAs. */
const MAGIC_BLOCK_PROGRAM_ID = "DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh";
/** Rollup-side program handling ScheduleCommit — the CPI target of
 *  CommitStealth / CommitAndUndelegateStealth. */
const MAGIC_PROGRAM_ID = "Magic11111111111111111111111111111111111111";
const MAGIC_CONTEXT = "MagicContext1111111111111111111111111111111";
const PERMISSION_PROGRAM_ID = "ACLseoPoyC3cBqoUtkbjZ4aDrkurZW86v19pXz2XQnp1";

// ============ PDAs ============
// Seeds mirror `shredr-program/src/constants.rs` (stealth account) and the
// MagicBlock `ephemeral-rollups-sdk` conventions (delegation accounts).

const pdas = [
  pdaNode({
    docs: [
      "Stealth PDA owned by a one-time burner: `[\"shredr_stealth_address\", burner]`.",
    ],
    name: "stealthAccount",
    seeds: [
      constantPdaSeedNodeFromString("utf8", "shredr_stealth_address"),
      variablePdaSeedNode("burner", publicKeyTypeNode(), [
        "The one-time burner keypair that owns the stealth account.",
      ]),
    ],
  }),
  pdaNode({
    docs: ["MagicBlock delegation buffer, owned by the delegated account's program."],
    name: "delegationBuffer",
    seeds: [
      constantPdaSeedNodeFromString("utf8", "buffer"),
      variablePdaSeedNode("stealthAccount", publicKeyTypeNode(), [
        "The stealth PDA being delegated.",
      ]),
    ],
  }),
  pdaNode({
    docs: ["MagicBlock delegation record."],
    name: "delegationRecord",
    programId: MAGIC_BLOCK_PROGRAM_ID,
    seeds: [
      constantPdaSeedNodeFromString("utf8", "delegation"),
      variablePdaSeedNode("stealthAccount", publicKeyTypeNode(), [
        "The stealth PDA being delegated.",
      ]),
    ],
  }),
  pdaNode({
    docs: ["MagicBlock delegation metadata."],
    name: "delegationMetadata",
    programId: MAGIC_BLOCK_PROGRAM_ID,
    seeds: [
      constantPdaSeedNodeFromString("utf8", "delegation-metadata"),
      variablePdaSeedNode("stealthAccount", publicKeyTypeNode(), [
        "The stealth PDA being delegated.",
      ]),
    ],
  }),
  pdaNode({
    docs: ["ACL permission account granting the burner access inside the rollup."],
    name: "permission",
    programId: PERMISSION_PROGRAM_ID,
    seeds: [
      constantPdaSeedNodeFromString("utf8", "permission:"),
      variablePdaSeedNode("stealthAccount", publicKeyTypeNode(), [
        "The stealth PDA the permission is created for.",
      ]),
    ],
  }),
];

// ============ ACCOUNTS ============
// Mirrors `StealthAccount` in `shredr-program/src/state.rs`. The struct is
// `#[repr(C)]` with 8-byte alignment, so it carries 6 bytes of trailing
// padding, one byte of which is now `role`: 8 (discriminator) + 88 = 96 bytes.

const accounts = [
  accountNode({
    data: structTypeNode([
      structFieldTypeNode({
        defaultValue: bytesValueNode("base16", "5348524544525341"), // "SHREDRSA"
        defaultValueStrategy: "omitted",
        docs: ["Fixed 8-byte discriminator, ASCII `SHREDRSA`."],
        name: "discriminator",
        type: fixedSizeTypeNode(bytesTypeNode(), 8),
      }),
      structFieldTypeNode({
        docs: ["The burner pubkey that owns this stealth account."],
        name: "owner",
        type: publicKeyTypeNode(),
      }),
      structFieldTypeNode({
        docs: [
          "Opaque 32-byte receipt commitment, written by the client and never",
          "read by the program. Occupies the former `salt` slot, so the layout,",
          "size and rent are unchanged. Every account carries one — a field only",
          "some clients populate would itself identify those clients.",
        ],
        name: "receiptCommitment",
        type: fixedSizeTypeNode(bytesTypeNode(), 32),
      }),
      structFieldTypeNode({
        docs: ["Lamports deposited, excluding the rent-exempt minimum."],
        name: "depositedAmount",
        type: numberTypeNode("u64"),
      }),
      structFieldTypeNode({
        docs: ["Unix timestamp of the initial deposit."],
        name: "depositTimestamp",
        type: numberTypeNode("i64"),
      }),
      structFieldTypeNode({
        docs: ["Whether the account is currently delegated to a MagicBlock validator."],
        name: "delegated",
        type: booleanTypeNode(),
      }),
      structFieldTypeNode({
        docs: ["PDA bump seed."],
        name: "bump",
        type: numberTypeNode("u8"),
      }),
      structFieldTypeNode({
        docs: [
          "Which leg of a cycle this PDA is: 0 unset, 1 deposit, 2 exit.",
          "Carved out of the trailing padding, so the account is still 96 bytes",
          "and accounts written before this field read back as unset.",
          "A recovery hint only — the program never authorizes on it.",
        ],
        name: "role",
        type: numberTypeNode("u8"),
      }),
      structFieldTypeNode({
        docs: ["`#[repr(C)]` trailing padding."],
        name: "padding",
        type: fixedSizeTypeNode(bytesTypeNode(), 5),
      }),
    ]),
    discriminators: [fieldDiscriminatorNode("discriminator")],
    docs: ["State stored inside every stealth PDA."],
    name: "stealthAccount",
  }),
];

// ============ ERRORS ============
// Mirrors `ShredrError` in `shredr-program/src/errors.rs`.

const errors = [
  ["invalidStealthPda", 6000, "The stealth account PDA does not match the expected derivation."],
  ["invalidProgramOwner", 6001, "The account is not owned by the SHREDR program."],
  ["accountDataTooSmall", 6002, "The account data is too small to contain a StealthAccount."],
  ["invalidDiscriminator", 6003, "The account discriminator does not match the expected value."],
  ["alreadyDelegated", 6004, "The stealth account is already delegated."],
  ["notDelegated", 6005, "The stealth account is not delegated when it should be."],
  ["invalidDestinationOwner", 6006, "The destination account is not owned by the SHREDR program."],
  ["missingSigner", 6007, "Signer is required but was not provided."],
  ["clockUnavailable", 6008, "Clock sysvar is unavailable."],
  ["balanceInvariantViolation", 6009, "Deposited amount would desync from actual lamports."],
  ["accountAlreadyInitialized", 6010, "Attempted to initialize an account that already exists."],
  ["selfTransferNotAllowed", 6011, "Source and destination stealth accounts are the same account."],
  ["invalidBufferAccount", 6012, "The undelegation buffer is not the delegation program's buffer for this account."],
  ["accountNotEmpty", 6013, "The stealth account still holds a deposit and cannot be closed."],
  ["rentUnavailable", 6014, "Rent sysvar is unavailable."],
].map(([name, code, message]) => errorNode({ code, message, name }));

// ============ BUILD ============

const idl = JSON.parse(readFileSync(idlPath, "utf8"));
const codama = createFromRoot(rootNodeFromAnchor(idl));

// Shank cannot express state, PDAs or errors, so they are attached here.
codama.update(
  bottomUpTransformerVisitor([
    {
      select: "[programNode]",
      transform: (node) => ({ ...node, accounts, errors, pdas }),
    },
  ]),
);

const stealthAccountFromBurner = (burnerAccount) =>
  pdaValueNode(pdaLinkNode("stealthAccount"), [
    pdaSeedValueNode("burner", accountValueNode(burnerAccount)),
  ]);

const delegationPdaFromStealthAccount = (pda) =>
  pdaValueNode(pdaLinkNode(pda), [
    pdaSeedValueNode("stealthAccount", accountValueNode("stealthAccount")),
  ]);

codama.update(
  updateInstructionsVisitor({
    commitAndUndelegateStealth: {
      accounts: {
        magicContext: { defaultValue: publicKeyValueNode(MAGIC_CONTEXT, "magicContext") },
        magicProgram: {
          defaultValue: publicKeyValueNode(MAGIC_PROGRAM_ID, "magicProgram"),
        },
      },
    },
    commitStealth: {
      accounts: {
        magicContext: { defaultValue: publicKeyValueNode(MAGIC_CONTEXT, "magicContext") },
        magicProgram: {
          defaultValue: publicKeyValueNode(MAGIC_PROGRAM_ID, "magicProgram"),
        },
      },
    },
    initializeAndDelegate: {
      accounts: {
        delegationBuffer: { defaultValue: delegationPdaFromStealthAccount("delegationBuffer") },
        delegationMetadata: { defaultValue: delegationPdaFromStealthAccount("delegationMetadata") },
        delegationRecord: { defaultValue: delegationPdaFromStealthAccount("delegationRecord") },
        ownerProgram: { defaultValue: programIdValueNode() },
        permissionAccount: { defaultValue: delegationPdaFromStealthAccount("permission") },
        stealthAccount: { defaultValue: stealthAccountFromBurner("burner") },
        systemProgram: {
          defaultValue: publicKeyValueNode(SYSTEM_PROGRAM_ID, "systemProgram"),
        },
      },
    },
    privateTransfer: {
      accounts: {
        sourcePda: { defaultValue: stealthAccountFromBurner("sourceBurner") },
      },
    },
    undelegationCallback: {
      // Shank numbers enum variants sequentially (5), but `lib.rs` dispatches
      // the callback on 0xFF.
      arguments: { discriminator: { defaultValue: numberValueNode(0xff) } },
      accounts: {
        systemProgram: {
          defaultValue: publicKeyValueNode(SYSTEM_PROGRAM_ID, "systemProgram"),
        },
      },
    },
    withdraw: {
      accounts: {
        stealthAccount: { defaultValue: stealthAccountFromBurner("burner") },
      },
    },
  }),
);

codama.accept(
  renderVisitor(outputDir, {
    deleteFolderBeforeRendering: true,
    // Render straight into `src/generated` rather than as a nested package,
    // and keep every import on `@solana/kit` so the app needs a single
    // Solana dependency for the generated code.
    generatedFolder: ".",
    kitImportStrategy: "rootOnly",
    syncPackageJson: false,
  }),
);

console.log(`Generated SHREDR client in ${outputDir}`);

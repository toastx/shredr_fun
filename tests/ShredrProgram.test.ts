/**
 * Unit tests for the web3.js facade over the Codama-generated client.
 *
 * These pin the wire format against what `shredr-program` actually parses:
 * instruction discriminators and data layout (`helpers::parse_amount` and each
 * `TryFrom`), account order and signer/writable flags, PDA seeds, and the
 * `StealthAccount` byte layout.
 */

import './setup';
import { expect } from 'chai';
import { Keypair, SystemProgram } from '@solana/web3.js';
import { address } from '@solana/kit';

import {
    SHREDR_PROGRAM_ID,
    STEALTH_ACCOUNT_LEN,
    STEALTH_ROLE,
    StealthInstruction,
    MAGIC_PROGRAM_ID,
    MAGIC_BLOCK_PROGRAM_ID,
    MAGIC_CONTEXT,
    PERMISSION_PROGRAM_ID,
    deriveStealthPDA,
    deriveDelegationPDAs,
    createInitializeAndDelegateInstruction,
    createPrivateTransferInstruction,
    createCommitStealthInstruction,
    createCommitAndUndelegateStealthInstruction,
    createStealthWithdrawInstruction,
    createCloseStealthAccountInstruction,
    parseStealthAccount,
    getShredrErrorMessage,
} from '../src/lib/ShredrProgram';
import {
    findStealthAccountPda,
    getStealthAccountEncoder,
} from '../src/generated';

// ============ FIXTURES ============

const relayer = Keypair.generate().publicKey;
const burner = Keypair.generate().publicKey;
const destination = Keypair.generate().publicKey;

/** Program ID declared in `shredr-program/src/lib.rs`. */
const DECLARED_PROGRAM_ID = 'H9pUQeNA2RwBHRwx52V8nqWpCAKReSA3gGUuRFHbEjG6';

describe('ShredrProgram', () => {
    describe('constants', () => {
        it('matches the program ID declared on-chain', () => {
            expect(SHREDR_PROGRAM_ID.toBase58()).to.equal(DECLARED_PROGRAM_ID);
        });

        it('uses the discriminators lib.rs dispatches on', () => {
            expect(StealthInstruction.InitializeAndDelegate).to.equal(0);
            expect(StealthInstruction.PrivateTransfer).to.equal(1);
            expect(StealthInstruction.CommitStealth).to.equal(2);
            expect(StealthInstruction.CommitAndUndelegateStealth).to.equal(3);
            expect(StealthInstruction.Withdraw).to.equal(4);
            expect(StealthInstruction.UndelegationCallback).to.equal(0xff);
        });
    });

    describe('deriveStealthPDA', () => {
        it('derives from the burner alone, with no salt', async () => {
            const [pda] = deriveStealthPDA(burner);
            const [generated] = await findStealthAccountPda({
                burner: address(burner.toBase58()),
            });

            expect(pda.toBase58()).to.equal(generated);
        });

        it('gives every burner a distinct PDA', () => {
            const [a] = deriveStealthPDA(burner);
            const [b] = deriveStealthPDA(Keypair.generate().publicKey);
            expect(a.toBase58()).to.not.equal(b.toBase58());
        });
    });

    describe('createInitializeAndDelegateInstruction', () => {
        const depositAmount = 2_500_000_000n;
        const ix = createInitializeAndDelegateInstruction(
            relayer,
            burner,
            depositAmount,
        );

        it('encodes [discriminator, deposit_amount, role] and nothing else', () => {
            expect(ix.data).to.have.lengthOf(10);
            expect(ix.data[0]).to.equal(StealthInstruction.InitializeAndDelegate);
            expect(ix.data.readBigUInt64LE(1)).to.equal(depositAmount);
            // Role defaults from the amount: funded is a deposit PDA.
            expect(ix.data[9]).to.equal(STEALTH_ROLE.deposit);
        });

        it('defaults an empty init to the exit role', () => {
            const exitIx = createInitializeAndDelegateInstruction(relayer, burner, 0n);
            expect(exitIx.data[9]).to.equal(STEALTH_ROLE.exit);
        });

        it('takes an explicit role over the amount-derived default', () => {
            const explicit = createInitializeAndDelegateInstruction(
                relayer,
                burner,
                depositAmount,
                STEALTH_ROLE.exit,
            );
            expect(explicit.data[9]).to.equal(STEALTH_ROLE.exit);
        });

        it('passes the nine accounts the program expects, in order', () => {
            const [stealthPda] = deriveStealthPDA(burner);
            const delegation = deriveDelegationPDAs(stealthPda);

            expect(ix.keys.slice(0, 9).map((k) => k.pubkey.toBase58())).to.deep.equal([
                relayer.toBase58(),
                burner.toBase58(),
                SHREDR_PROGRAM_ID.toBase58(),
                stealthPda.toBase58(),
                delegation.permissionAccount.toBase58(),
                delegation.delegationBuffer.toBase58(),
                delegation.delegationRecord.toBase58(),
                delegation.delegationMetadata.toBase58(),
                SystemProgram.programId.toBase58(),
            ]);
        });

        it('appends the CPI target programs so the runtime can dispatch to them', () => {
            expect(ix.keys).to.have.lengthOf(11);
            expect(ix.keys.slice(9).map((k) => k.pubkey.toBase58())).to.deep.equal([
                PERMISSION_PROGRAM_ID.toBase58(),
                MAGIC_BLOCK_PROGRAM_ID.toBase58(),
            ]);
            for (const meta of ix.keys.slice(9)) {
                expect(meta).to.include({ isSigner: false, isWritable: false });
            }
        });

        it('marks the relayer and burner as writable signers', () => {
            const [relayerMeta, burnerMeta] = ix.keys;
            expect(relayerMeta).to.include({ isSigner: true, isWritable: true });
            expect(burnerMeta).to.include({ isSigner: true, isWritable: true });
        });

        it('keeps the owner program and system program read-only', () => {
            expect(ix.keys[2]).to.include({ isSigner: false, isWritable: false });
            expect(ix.keys[8]).to.include({ isSigner: false, isWritable: false });
        });
    });

    describe('createPrivateTransferInstruction', () => {
        const amount = 1_000_000n;
        const [sourcePda] = deriveStealthPDA(burner);
        const [destinationPda] = deriveStealthPDA(destination);
        const ix = createPrivateTransferInstruction(
            burner,
            sourcePda,
            destinationPda,
            amount,
        );

        it('encodes [discriminator, amount]', () => {
            expect(ix.data).to.have.lengthOf(9);
            expect(ix.data[0]).to.equal(StealthInstruction.PrivateTransfer);
            expect(ix.data.readBigUInt64LE(1)).to.equal(amount);
        });

        it('is authorized by the source burner, not the source PDA', () => {
            expect(ix.keys).to.have.lengthOf(3);
            expect(ix.keys[0].pubkey.toBase58()).to.equal(burner.toBase58());
            expect(ix.keys[0]).to.include({ isSigner: true, isWritable: false });
            expect(ix.keys[1].pubkey.toBase58()).to.equal(sourcePda.toBase58());
            expect(ix.keys[1]).to.include({ isSigner: false, isWritable: true });
            expect(ix.keys[2].pubkey.toBase58()).to.equal(destinationPda.toBase58());
            expect(ix.keys[2]).to.include({ isSigner: false, isWritable: true });
        });
    });

    describe('commit instructions', () => {
        const [stealthPda] = deriveStealthPDA(burner);

        it('builds CommitStealth with the MagicBlock accounts', () => {
            const ix = createCommitStealthInstruction(relayer, stealthPda);

            expect(ix.data).to.have.lengthOf(1);
            expect(ix.data[0]).to.equal(StealthInstruction.CommitStealth);
            expect(ix.keys.map((k) => k.pubkey.toBase58())).to.deep.equal([
                relayer.toBase58(),
                stealthPda.toBase58(),
                MAGIC_PROGRAM_ID.toBase58(),
                MAGIC_CONTEXT.toBase58(),
            ]);
            expect(ix.keys[2].isWritable).to.equal(false);
            expect(ix.keys[3].isWritable).to.equal(true);
        });

        it('builds CommitAndUndelegateStealth with the same accounts', () => {
            const ix = createCommitAndUndelegateStealthInstruction(
                relayer,
                stealthPda,
            );

            expect(ix.data).to.have.lengthOf(1);
            expect(ix.data[0]).to.equal(
                StealthInstruction.CommitAndUndelegateStealth,
            );
            expect(ix.keys).to.have.lengthOf(4);
            expect(ix.keys[0]).to.include({ isSigner: true, isWritable: true });
        });
    });

    describe('createStealthWithdrawInstruction', () => {
        const amount = 750_000_000n;
        const [stealthPda] = deriveStealthPDA(burner);
        const ix = createStealthWithdrawInstruction(
            burner,
            stealthPda,
            destination,
            amount,
        );

        it('encodes [discriminator, amount]', () => {
            expect(ix.data).to.have.lengthOf(9);
            expect(ix.data[0]).to.equal(StealthInstruction.Withdraw);
            expect(ix.data.readBigUInt64LE(1)).to.equal(amount);
        });

        it('is signed by the burner and writes to PDA and destination', () => {
            expect(ix.keys.map((k) => k.pubkey.toBase58())).to.deep.equal([
                burner.toBase58(),
                stealthPda.toBase58(),
                destination.toBase58(),
            ]);
            expect(ix.keys[0]).to.include({ isSigner: true, isWritable: true });
            expect(ix.keys[1]).to.include({ isSigner: false, isWritable: true });
            expect(ix.keys[2]).to.include({ isSigner: false, isWritable: true });
        });
    });

    describe('createCloseStealthAccountInstruction', () => {
        const rentPayee = Keypair.generate().publicKey;
        const [stealthPda] = deriveStealthPDA(burner);
        const ix = createCloseStealthAccountInstruction(burner, stealthPda, rentPayee);

        it('encodes the discriminator and no arguments', () => {
            expect(ix.data).to.have.lengthOf(1);
            expect(ix.data[0]).to.equal(StealthInstruction.CloseStealthAccount);
        });

        it('is signed by the burner and writes to the PDA and payee', () => {
            expect(ix.keys.map((k) => k.pubkey.toBase58())).to.deep.equal([
                burner.toBase58(),
                stealthPda.toBase58(),
                rentPayee.toBase58(),
            ]);
            expect(ix.keys[0].isSigner).to.equal(true);
            // The burner only proves ownership; it is not debited.
            expect(ix.keys[0].isWritable).to.equal(false);
            expect(ix.keys[1].isWritable).to.equal(true);
            expect(ix.keys[2].isWritable).to.equal(true);
        });
    });

    describe('parseStealthAccount', () => {
        const encoded = getStealthAccountEncoder().encode({
            owner: address(burner.toBase58()),
            salt: new Uint8Array(32),
            depositedAmount: 4_200_000_000n,
            depositTimestamp: 1_753_000_000n,
            delegated: true,
            bump: 254,
            padding: new Uint8Array(6),
        });

        it('matches the on-chain account size', () => {
            // 8-byte discriminator + StealthAccount (88 bytes with padding)
            expect(encoded).to.have.lengthOf(STEALTH_ACCOUNT_LEN);
        });

        it('decodes the fields at the offsets the program writes', () => {
            const state = parseStealthAccount(new Uint8Array(encoded));

            expect(state).to.not.equal(null);
            expect(state!.owner.toBase58()).to.equal(burner.toBase58());
            expect(state!.depositedAmount).to.equal(4_200_000_000n);
            expect(state!.depositTimestamp).to.equal(1_753_000_000n);
            expect(state!.delegated).to.equal(true);
            expect(state!.bump).to.equal(254);
        });

        it('rejects accounts owned by another program', () => {
            const foreign = new Uint8Array(encoded);
            foreign[0] ^= 0xff; // break the "SHREDRSA" discriminator

            expect(parseStealthAccount(foreign)).to.equal(null);
        });

        it('rejects data that is too short to hold the state', () => {
            expect(parseStealthAccount(new Uint8Array(64))).to.equal(null);
        });
    });

    describe('getShredrErrorMessage', () => {
        it('resolves SHREDR custom error codes', () => {
            expect(getShredrErrorMessage(6004)).to.match(/already delegated/i);
            expect(getShredrErrorMessage(6011)).to.match(/same account/i);
        });

        it('returns null for codes the program does not define', () => {
            expect(getShredrErrorMessage(1)).to.equal(null);
            expect(getShredrErrorMessage(6012)).to.equal(null);
        });
    });
});

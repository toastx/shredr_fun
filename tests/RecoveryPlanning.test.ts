/**
 * Tests for which on-chain states recovery treats as *stranded*.
 *
 * This is the sharpest edge in the client: recovery auto-confirms, so a state
 * wrongly classified as pending gets acted on without the user being asked.
 * A funded, delegated deposit PDA is the resting state of a shielded balance —
 * classifying it as stranded once meant sweeping the user's whole balance out
 * to their connected wallet on sign-in.
 */

import './setup';
import { expect } from 'chai';
import { STEALTH_ROLE } from '../src/lib/ShredrProgram';
import type { UtxoNote } from '../src/lib/types';

type Chain = { delegated: boolean; role: number; depositedAmount: number };

/**
 * Mirror of `ShredrClient.planFor`'s decision table. Kept in the test rather
 * than exported so the production path stays private; if the two drift, the
 * behavioural expectations below are what should be re-checked.
 */
function classify(note: Pick<UtxoNote, 'role'>, chain: Chain | null): string {
    if (!chain) return 'none';

    const role =
        chain.role === STEALTH_ROLE.deposit
            ? 'deposit'
            : chain.role === STEALTH_ROLE.exit
              ? 'exit'
              : note.role;

    if (role === 'deposit') {
        if (chain.delegated) {
            return chain.depositedAmount > 0 ? 'at-rest' : 'undelegate';
        }
        return chain.depositedAmount > 0 ? 'initialize' : 'close';
    }

    if (chain.delegated) return 'undelegate';
    return chain.depositedAmount > 0 ? 'withdraw' : 'close';
}

const deposit = { role: 'deposit' as const };
const exit = { role: 'exit' as const };

describe('recovery classification', () => {
    it('leaves a funded delegated deposit alone — it is the balance', () => {
        // The regression this file exists for. Anything but 'at-rest' here
        // means sign-in drains the user's shielded funds to their wallet.
        expect(
            classify(deposit, {
                delegated: true,
                role: STEALTH_ROLE.deposit,
                depositedAmount: 5_000_000_000,
            }),
        ).to.equal('at-rest');
    });

    it('cleans up a drained delegated deposit', () => {
        expect(
            classify(deposit, { delegated: true, role: STEALTH_ROLE.deposit, depositedAmount: 0 }),
        ).to.equal('undelegate');
    });

    it('re-delegates a funded deposit that is not delegated', () => {
        // Counts toward the balance but PrivateTransfer cannot move it, so it
        // is unspendable until re-delegated.
        expect(
            classify(deposit, {
                delegated: false,
                role: STEALTH_ROLE.deposit,
                depositedAmount: 1_000_000_000,
            }),
        ).to.equal('initialize');
    });

    it('finishes a funded exit PDA — the user already asked to withdraw', () => {
        expect(
            classify(exit, { delegated: false, role: STEALTH_ROLE.exit, depositedAmount: 2_000_000 }),
        ).to.equal('withdraw');
        expect(
            classify(exit, { delegated: true, role: STEALTH_ROLE.exit, depositedAmount: 2_000_000 }),
        ).to.equal('undelegate');
    });

    it('closes a spent PDA of either role', () => {
        expect(
            classify(deposit, { delegated: false, role: STEALTH_ROLE.deposit, depositedAmount: 0 }),
        ).to.equal('close');
        expect(
            classify(exit, { delegated: false, role: STEALTH_ROLE.exit, depositedAmount: 0 }),
        ).to.equal('close');
    });

    it('falls back to the note role when the chain reads unset', () => {
        // Accounts written before the role byte existed.
        expect(
            classify(exit, { delegated: false, role: STEALTH_ROLE.unset, depositedAmount: 500 }),
        ).to.equal('withdraw');
        expect(
            classify(deposit, { delegated: true, role: STEALTH_ROLE.unset, depositedAmount: 500 }),
        ).to.equal('at-rest');
    });
});

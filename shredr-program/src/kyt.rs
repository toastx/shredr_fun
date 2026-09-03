//! KYT (know-your-transaction) gating for base-layer deposits.
//!
//! A deposit only enters the pool if an off-chain compliance relayer has
//! screened the depositing wallet and signed an **attestation** saying so. The
//! program does not talk to the compliance API — it cannot — it checks that a
//! signature from a known authority covers a message bound to *this* deposit.
//!
//! ## Why the ed25519 precompile
//!
//! The program never verifies a signature itself. The client puts a
//! `Ed25519SigVerify` instruction in the same transaction; the runtime rejects
//! the whole transaction if that signature is bad, *before* any program runs.
//! What is left for this module is the part the precompile does not do: confirm
//! the precompile instruction is actually there, that it is self-contained, that
//! it checked the *KYT authority's* key, and that the message it covers is bound
//! to this burner and this amount.
//!
//! Skipping any one of those turns the gate off. In particular a precompile
//! instruction may point its offsets at *another* instruction in the
//! transaction, so an attacker could have it verify a signature over bytes we
//! never see. [`attested_message`] requires all three instruction indices to be
//! `u16::MAX` ("this instruction"), which is what makes reading the message out
//! of the same data blob sound.
//!
//! ## Attestation message, 90 bytes
//!
//! ```text
//! [ 0.. 8]  magic          b"SHREDRKY"
//! [ 8]      version        1
//! [ 9]      verdict        1 = allow, anything else = screened and refused
//! [10..42]  depositor      the L1 wallet the relayer screened
//! [42..74]  subject        binds the attestation to one deposit
//! [74..82]  max_amount     u64 LE, lamports ceiling for this attestation
//! [82..90]  expiry_unix    i64 LE, unix seconds, inclusive
//! ```
//!
//! `subject` is whatever uniquely identifies the deposit being cleared: the
//! burner for a stealth PDA, the note commitment for a pool deposit. Either way
//! it is one-time, so an attestation cannot be lifted onto another deposit.
//!
//! `depositor` is checked only when the depositing wallet is actually an account
//! in the transaction. On the stealth path it is not — funds arrive from a
//! one-time burner, which is the point — so there is nothing to compare against
//! and the relayer's signature is the only binding. Pool deposits are the other
//! case: the wallet signs the transfer itself, so the check is available and is
//! made. Without it, an attestation issued for a clean wallet could be presented
//! by a dirty one that happened to learn the commitment.
//!
//! ## Replay ceiling
//!
//! An attestation is bound to one burner, and burners are one-time, so it cannot
//! be moved to another deposit. It *can* be reused for a top-up of the same PDA
//! until it expires, capped at `max_amount` each time.
//!
// ponytail: replay window is bounded by expiry + max_amount, not by a nonce.
// If per-deposit single use is needed, add a used-attestation PDA keyed by the
// message hash and close it on undelegate.

use crate::constants::KYT_ATTESTATION_AUTHORITY;
use crate::errors::ShredrError;
use pinocchio::account::Ref;
use pinocchio::error::ProgramError;
use pinocchio::sysvars::instructions::Instructions;
use pinocchio::{AccountView, Address};

/// `Ed25519SigVerify111111111111111111111111111`, the native signature
/// verification precompile.
pub const ED25519_PROGRAM_ID: Address =
    Address::from_str_const("Ed25519SigVerify111111111111111111111111111");

/// Leading bytes of every attestation message, so a signature made for some
/// other purpose by the same key cannot be replayed as one.
pub const ATTESTATION_MAGIC: [u8; 8] = *b"SHREDRKY";

/// Bumped when the layout below changes. Old versions are rejected, not guessed.
pub const ATTESTATION_VERSION: u8 = 1;

/// The only verdict byte that lets a deposit through.
pub const VERDICT_ALLOW: u8 = 1;

/// Total attestation message length. Fixed, so the precompile's declared message
/// size is a check rather than a parameter.
pub const ATTESTATION_LEN: usize = 90;

const OFF_VERSION: usize = 8;
const OFF_VERDICT: usize = 9;
const OFF_DEPOSITOR: usize = 10;
const OFF_SUBJECT: usize = 42;
const OFF_MAX_AMOUNT: usize = 74;
const OFF_EXPIRY: usize = 82;

// ── Ed25519 precompile instruction data layout ──
//
// [0]     number of signatures
// [1]     padding
// [2..16] one `Ed25519SignatureOffsets`: seven u16 LE fields
// [16..]  the signature/pubkey/message bytes those offsets point into

const OFFSETS_START: usize = 2;
const OFFSETS_LEN: usize = 14;
const ED25519_HEADER_LEN: usize = OFFSETS_START + OFFSETS_LEN;
const PUBKEY_LEN: usize = 32;
const SIGNATURE_LEN: usize = 64;

/// Instruction-index sentinel meaning "the instruction carrying these offsets".
const INDEX_CURRENT: u16 = u16::MAX;

/// A parsed, structurally valid attestation message. Being one of these says
/// nothing about *whose* signature covered it — see [`attested_message`].
pub struct Attestation<'a> {
    raw: &'a [u8],
}

impl<'a> Attestation<'a> {
    /// Check the envelope: length, magic, version. The verdict, binding and
    /// expiry are the caller's to check, because their errors are distinct.
    pub fn parse(message: &'a [u8]) -> Result<Self, ProgramError> {
        if message.len() != ATTESTATION_LEN {
            return Err(ShredrError::KytAttestationMalformed.into());
        }
        if message[..ATTESTATION_MAGIC.len()] != ATTESTATION_MAGIC {
            return Err(ShredrError::KytAttestationMalformed.into());
        }
        if message[OFF_VERSION] != ATTESTATION_VERSION {
            return Err(ShredrError::KytAttestationMalformed.into());
        }
        Ok(Self { raw: message })
    }

    /// `1` when the relayer cleared the depositor.
    pub fn verdict(&self) -> u8 {
        self.raw[OFF_VERDICT]
    }

    /// The screened L1 wallet. Opaque to the program; kept for auditors.
    pub fn depositor(&self) -> &'a [u8] {
        &self.raw[OFF_DEPOSITOR..OFF_DEPOSITOR + PUBKEY_LEN]
    }

    /// What this attestation is bound to: a burner, or a note commitment.
    pub fn subject(&self) -> &'a [u8] {
        &self.raw[OFF_SUBJECT..OFF_SUBJECT + PUBKEY_LEN]
    }

    /// Lamport ceiling the relayer cleared.
    pub fn max_amount(&self) -> u64 {
        u64::from_le_bytes(
            self.raw[OFF_MAX_AMOUNT..OFF_MAX_AMOUNT + 8]
                .try_into()
                .unwrap(),
        )
    }

    /// Last unix second the attestation is good for, inclusive.
    pub fn expiry_unix(&self) -> i64 {
        i64::from_le_bytes(self.raw[OFF_EXPIRY..OFF_EXPIRY + 8].try_into().unwrap())
    }
}

/// Pull the message out of an `Ed25519SigVerify` instruction's data, but only if
/// that instruction verified `authority`'s signature over bytes held in its own
/// data blob.
///
/// Rejects anything that would make the returned slice unrelated to what the
/// precompile actually checked: more than one signature (only the first is read,
/// so the rest would ride along unexamined), offsets pointing at another
/// instruction, a message that is not [`ATTESTATION_LEN`], or offsets running
/// past the end of the blob.
pub fn attested_message<'a>(
    ix_data: &'a [u8],
    authority: &[u8; PUBKEY_LEN],
) -> Result<&'a [u8], ProgramError> {
    if ix_data.len() < ED25519_HEADER_LEN {
        return Err(ShredrError::KytAttestationMalformed.into());
    }

    // Exactly one. A blob with several signatures would need every one of them
    // checked to mean anything, and a deposit has no use for more.
    if ix_data[0] != 1 {
        return Err(ShredrError::KytAttestationMalformed.into());
    }

    let field = |index: usize| -> u16 {
        let at = OFFSETS_START + index * 2;
        u16::from_le_bytes([ix_data[at], ix_data[at + 1]])
    };

    let signature_offset = field(0) as usize;
    let signature_ix_index = field(1);
    let pubkey_offset = field(2) as usize;
    let pubkey_ix_index = field(3);
    let message_offset = field(4) as usize;
    let message_size = field(5) as usize;
    let message_ix_index = field(6);

    // The precompile is allowed to read its inputs from any instruction in the
    // transaction. If it did, the bytes below would not be the bytes it checked.
    if signature_ix_index != INDEX_CURRENT
        || pubkey_ix_index != INDEX_CURRENT
        || message_ix_index != INDEX_CURRENT
    {
        return Err(ShredrError::KytAttestationMalformed.into());
    }

    if message_size != ATTESTATION_LEN {
        return Err(ShredrError::KytAttestationMalformed.into());
    }

    // Offsets are attacker-controlled u16s: overflow-check the ends, then bound
    // them, before any slicing.
    let ends = [
        pubkey_offset.checked_add(PUBKEY_LEN),
        signature_offset.checked_add(SIGNATURE_LEN),
        message_offset.checked_add(message_size),
    ];

    if ends
        .iter()
        .any(|end| end.is_none_or(|value| value > ix_data.len()))
    {
        return Err(ShredrError::KytAttestationMalformed.into());
    }

    let pubkey_end = pubkey_offset + PUBKEY_LEN;
    let message_end = message_offset + message_size;

    if &ix_data[pubkey_offset..pubkey_end] != authority.as_slice() {
        return Err(ShredrError::KytUnknownAuthority.into());
    }

    Ok(&ix_data[message_offset..message_end])
}

/// Require a valid, unexpired KYT attestation for this deposit somewhere in the
/// transaction.
///
/// Scans rather than reading a fixed slot: a transaction may batch several
/// deposits, each with its own attestation, and the binding to `burner` is what
/// makes position irrelevant. The first instruction that satisfies every check
/// wins; if none does, the most specific failure seen is returned so the relayer
/// gets a usable reason instead of a flat "missing".
pub fn verify_deposit_attestation(
    instructions_sysvar: &AccountView,
    subject: &[u8; PUBKEY_LEN],
    expected_depositor: Option<&[u8; PUBKEY_LEN]>,
    deposit_amount: u64,
    now_unix: i64,
) -> Result<(), ProgramError> {
    let authority = *KYT_ATTESTATION_AUTHORITY.as_array();

    // The all-zero sentinel means the build never had an authority configured.
    // Failing closed here beats accepting a signature nobody can produce, and it
    // is the difference between "deposits are refused" and a gate that looks
    // present but is not.
    if authority == [0u8; PUBKEY_LEN] {
        return Err(ShredrError::KytAuthorityUnset.into());
    }

    let introspection: Instructions<Ref<[u8]>> = Instructions::try_from(instructions_sysvar)?;

    let mut reason: Option<ProgramError> = None;

    for index in 0..introspection.num_instructions() {
        let instruction = introspection.load_instruction_at(index)?;

        if instruction.get_program_id() != &ED25519_PROGRAM_ID {
            continue;
        }

        match attested_message(instruction.get_instruction_data(), &authority).and_then(
            |message| {
                check_attestation(
                    message,
                    subject,
                    expected_depositor,
                    deposit_amount,
                    now_unix,
                )
            },
        ) {
            Ok(()) => return Ok(()),
            Err(err) => reason = Some(err),
        }
    }

    Err(reason.unwrap_or_else(|| ShredrError::KytAttestationMissing.into()))
}

/// Everything an attested message has to say for this deposit to be cleared.
///
/// Split out from [`verify_deposit_attestation`] and taking plain bytes, so the
/// policy — binding, ceiling, expiry, verdict — is exercisable without an
/// `AccountView` or a compiled-in authority.
pub fn check_attestation(
    message: &[u8],
    subject: &[u8; PUBKEY_LEN],
    expected_depositor: Option<&[u8; PUBKEY_LEN]>,
    deposit_amount: u64,
    now_unix: i64,
) -> Result<(), ProgramError> {
    let attestation = Attestation::parse(message)?;

    if attestation.verdict() != VERDICT_ALLOW {
        return Err(ShredrError::KytScreeningRejected.into());
    }

    if attestation.subject() != subject.as_slice() {
        return Err(ShredrError::KytAttestationBurnerMismatch.into());
    }

    if let Some(depositor) = expected_depositor {
        if attestation.depositor() != depositor.as_slice() {
            return Err(ShredrError::KytAttestationDepositorMismatch.into());
        }
    }

    if deposit_amount > attestation.max_amount() {
        return Err(ShredrError::KytAttestationAmountExceeded.into());
    }

    if now_unix > attestation.expiry_unix() {
        return Err(ShredrError::KytAttestationExpired.into());
    }

    Ok(())
}

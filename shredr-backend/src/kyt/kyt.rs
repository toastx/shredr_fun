//! KYT screening — attestation signing.
//!
//! The compliance relayer's whole job: screen a depositing wallet, sign a
//! 90-byte statement about it, hand the statement back. It never sees a
//! transaction, never holds funds, and cannot broadcast. That keeps its blast
//! radius at "can clear deposits it should not have" rather than "can move
//! money" — which is why this is a separate key and a separate service from
//! Kora, even though both are "the relayer" in casual conversation.
//!
//! The provider call is a stub. Everything around it — the message layout, the
//! binding, the signing, the expiry — is real, because that is the part the
//! on-chain program parses byte by byte.
//!
//! See `docs/concepts/kyt-gating.md`.

use base64::Engine;
use ed25519_dalek::{Signer, SigningKey};
use serde::{Deserialize, Serialize};

use crate::error::AppError;

// ── Attestation message layout, mirrored from `shredr-program/src/kyt.rs` ──
//
// [ 0.. 8]  magic       b"SHREDRKY"
// [ 8]      version     1
// [ 9]      verdict     1 = allow
// [10..42]  depositor
// [42..74]  burner
// [74..82]  max_amount  u64 LE
// [82..90]  expiry_unix i64 LE

const ATTESTATION_MAGIC: &[u8; 8] = b"SHREDRKY";
const ATTESTATION_VERSION: u8 = 1;
const ATTESTATION_LEN: usize = 90;

pub const VERDICT_REFUSE: u8 = 0;
pub const VERDICT_ALLOW: u8 = 1;

/// How long an attestation is good for. This is the replay window: the program
/// binds an attestation to one burner but will honour it again for a top-up of
/// the same PDA until it expires, so the TTL is the dial that bounds that.
/// Minutes, not days.
const DEFAULT_TTL_SECS: i64 = 300;

#[derive(Clone)]
pub struct KytState {
    /// `None` when `KYT_AUTHORITY_KEY` is unset. The endpoint then refuses every
    /// request rather than starting up without the ability to sign — same
    /// posture as the program, which refuses every deposit when its authority
    /// is unset.
    signing_key: Option<SigningKey>,
    ttl_secs: i64,
    /// Base58 pubkeys the stub provider refuses, so the refusal path is
    /// exercisable end to end without a provider account.
    denylist: Vec<String>,
}

impl KytState {
    /// Read configuration from the environment. Never panics: a missing key
    /// degrades to a 503 per request, which is visible in a way a failed boot
    /// three services deep is not.
    pub fn from_env() -> Self {
        let signing_key = std::env::var("KYT_AUTHORITY_KEY")
            .ok()
            .and_then(|encoded| match parse_signing_key(&encoded) {
                Ok(key) => Some(key),
                Err(err) => {
                    tracing::error!("KYT_AUTHORITY_KEY is unusable: {err}");
                    None
                }
            });

        match &signing_key {
            Some(key) => tracing::info!(
                "KYT authority: {} — this must match SHREDR_KYT_AUTHORITY in the deployed program",
                bs58::encode(key.verifying_key().to_bytes()).into_string()
            ),
            None => tracing::warn!("KYT_AUTHORITY_KEY unset — screening will refuse every request"),
        }

        Self {
            signing_key,
            ttl_secs: std::env::var("KYT_ATTESTATION_TTL_SECS")
                .ok()
                .and_then(|value| value.parse().ok())
                .unwrap_or(DEFAULT_TTL_SECS),
            denylist: std::env::var("KYT_DENYLIST")
                .unwrap_or_default()
                .split(',')
                .map(|entry| entry.trim().to_string())
                .filter(|entry| !entry.is_empty())
                .collect(),
        }
    }

    /// Screen a depositor and sign the result.
    ///
    /// A refusal is signed too, and returned as a normal response. "We screened
    /// you and said no" is a different fact from "the relayer is down", and the
    /// client needs to tell them apart — one is final, the other is worth
    /// retrying.
    pub fn screen(&self, request: &ScreenRequest) -> Result<ScreenResponse, AppError> {
        let key = self.signing_key.as_ref().ok_or_else(|| {
            AppError::KytUnavailable("KYT authority key is not configured".to_string())
        })?;

        let depositor = decode_pubkey(&request.depositor, "depositor")?;
        let burner = decode_pubkey(&request.burner, "burner")?;
        let max_amount: u64 = request
            .max_amount
            .parse()
            .map_err(|_| AppError::Internal("maxAmount is not a u64".to_string()))?;

        let (verdict, reason) = self.provider_verdict(&request.depositor);
        let expires_at = chrono::Utc::now().timestamp() + self.ttl_secs;

        // Bound before signed. An attestation that said only "this wallet is
        // clean" would be a bearer token good for every deposit that wallet
        // ever makes, so the burner and the ceiling go into the message.
        let message = build_message(verdict, &depositor, &burner, max_amount, expires_at);
        let signature = key.sign(&message).to_bytes();

        Ok(ScreenResponse {
            verdict,
            authority: bs58::encode(key.verifying_key().to_bytes()).into_string(),
            message: base64::engine::general_purpose::STANDARD.encode(message),
            signature: base64::engine::general_purpose::STANDARD.encode(signature),
            expires_at: expires_at as u64,
            reason,
        })
    }

    /// Stand-in for the compliance provider.
    ///
    // TODO: replace with the real provider call once an endpoint exists. The
    // shape it has to return is `(verdict, reason)` — everything else in this
    // file is already the production path.
    //
    /// Clears everything except `KYT_DENYLIST`, which exists so the refusal path
    /// can be exercised without a provider account.
    fn provider_verdict(&self, depositor: &str) -> (u8, Option<String>) {
        if self.denylist.iter().any(|entry| entry == depositor) {
            return (
                VERDICT_REFUSE,
                Some("Depositor is on the screening denylist".to_string()),
            );
        }
        (VERDICT_ALLOW, None)
    }
}

fn build_message(
    verdict: u8,
    depositor: &[u8; 32],
    burner: &[u8; 32],
    max_amount: u64,
    expiry_unix: i64,
) -> Vec<u8> {
    let mut message = Vec::with_capacity(ATTESTATION_LEN);
    message.extend_from_slice(ATTESTATION_MAGIC);
    message.push(ATTESTATION_VERSION);
    message.push(verdict);
    message.extend_from_slice(depositor);
    message.extend_from_slice(burner);
    message.extend_from_slice(&max_amount.to_le_bytes());
    message.extend_from_slice(&expiry_unix.to_le_bytes());
    debug_assert_eq!(message.len(), ATTESTATION_LEN);
    message
}

/// Accepts a base58 32-byte seed or a 64-byte `seed || pubkey` keypair, which is
/// what `solana-keygen` and the wallet exports hand out.
fn parse_signing_key(encoded: &str) -> Result<SigningKey, String> {
    let bytes = bs58::decode(encoded.trim())
        .into_vec()
        .map_err(|err| format!("not base58: {err}"))?;

    let seed: [u8; 32] = match bytes.len() {
        32 | 64 => bytes[..32].try_into().expect("length checked"),
        other => return Err(format!("expected 32 or 64 bytes, got {other}")),
    };

    Ok(SigningKey::from_bytes(&seed))
}

fn decode_pubkey(encoded: &str, field: &str) -> Result<[u8; 32], AppError> {
    bs58::decode(encoded)
        .into_vec()
        .ok()
        .and_then(|bytes| <[u8; 32]>::try_from(bytes).ok())
        .ok_or_else(|| AppError::Internal(format!("{field} is not a base58 pubkey")))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreenRequest {
    pub depositor: String,
    pub burner: String,
    /// A string, because JSON numbers cannot carry a u64 without loss.
    pub max_amount: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreenResponse {
    pub verdict: u8,
    pub authority: String,
    pub message: String,
    pub signature: String,
    pub expires_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state() -> KytState {
        KytState {
            signing_key: Some(SigningKey::from_bytes(&[7u8; 32])),
            ttl_secs: 300,
            denylist: vec!["11111111111111111111111111111111".to_string()],
        }
    }

    fn request(depositor: &str) -> ScreenRequest {
        ScreenRequest {
            depositor: depositor.to_string(),
            burner: bs58::encode([3u8; 32]).into_string(),
            max_amount: "5000000000".to_string(),
        }
    }

    /// The program reads these offsets by hand and refuses anything that does
    /// not line up, so the layout is pinned here rather than assumed.
    #[test]
    fn message_is_bound_to_the_burner_and_the_ceiling() {
        let response = state()
            .screen(&request(&bs58::encode([9u8; 32]).into_string()))
            .expect("screening");

        let message = base64::engine::general_purpose::STANDARD
            .decode(&response.message)
            .expect("base64");

        assert_eq!(message.len(), ATTESTATION_LEN);
        assert_eq!(&message[..8], ATTESTATION_MAGIC);
        assert_eq!(message[8], ATTESTATION_VERSION);
        assert_eq!(message[9], VERDICT_ALLOW);
        assert_eq!(&message[10..42], &[9u8; 32]);
        assert_eq!(&message[42..74], &[3u8; 32]);
        assert_eq!(
            u64::from_le_bytes(message[74..82].try_into().unwrap()),
            5_000_000_000
        );
        assert!(i64::from_le_bytes(message[82..90].try_into().unwrap()) > 0);

        let signature = base64::engine::general_purpose::STANDARD
            .decode(&response.signature)
            .expect("base64");
        assert_eq!(signature.len(), 64);
    }

    /// A refusal is signed and returned, not raised as an error: the client has
    /// to be able to tell "screened and refused" from "relayer unreachable".
    #[test]
    fn a_refusal_is_signed_like_any_other_answer() {
        let response = state()
            .screen(&request("11111111111111111111111111111111"))
            .expect("a refusal is still a response");

        assert_eq!(response.verdict, VERDICT_REFUSE);
        assert!(response.reason.is_some());

        let message = base64::engine::general_purpose::STANDARD
            .decode(&response.message)
            .expect("base64");
        assert_eq!(message[9], VERDICT_REFUSE);
    }

    #[test]
    fn refuses_to_sign_without_an_authority_key() {
        let unconfigured = KytState {
            signing_key: None,
            ttl_secs: 300,
            denylist: vec![],
        };

        assert!(matches!(
            unconfigured.screen(&request(&bs58::encode([9u8; 32]).into_string())),
            Err(AppError::KytUnavailable(_))
        ));
    }

    #[test]
    fn accepts_both_seed_and_keypair_encodings() {
        let seed = [11u8; 32];
        let from_seed = parse_signing_key(&bs58::encode(seed).into_string()).expect("seed");

        let mut keypair = seed.to_vec();
        keypair.extend_from_slice(&from_seed.verifying_key().to_bytes());
        let from_keypair =
            parse_signing_key(&bs58::encode(&keypair).into_string()).expect("keypair");

        assert_eq!(
            from_seed.verifying_key().to_bytes(),
            from_keypair.verifying_key().to_bytes()
        );
        assert!(parse_signing_key("not base58!").is_err());
        assert!(parse_signing_key(&bs58::encode([1u8; 16]).into_string()).is_err());
    }
}

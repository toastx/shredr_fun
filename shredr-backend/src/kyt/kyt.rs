//! KYT screening — attestation signing.
//!
//! The compliance relayer's whole job: screen a depositing wallet, sign a
//! 90-byte statement about it, hand the statement back. It never sees a
//! transaction, never holds funds, and cannot broadcast. That keeps its blast
//! radius at "can clear deposits it should not have" rather than "can move
//! money" — which is why this is a separate key and a separate service from
//! Kora, even though both are "the relayer" in casual conversation.
//!
//! The verdict comes from GoPlus's address-screening API — see `goplus.rs`,
//! which holds the provider call and the policy that reduces its flags to the
//! one bit signed here. This file owns
//! everything downstream of that bit: the message layout, the binding, the
//! signing, the expiry — the part the on-chain program parses byte by byte.
//!
//! See `docs/concepts/kyt-gating.md`.

use base64::Engine;
use ed25519_dalek::{Signer, SigningKey};
use serde::{Deserialize, Serialize};

use super::funders::FunderResolver;
use super::goplus::GoPlusClient;
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
    /// Base58 pubkeys refused ahead of the provider, so an operator can hard-block
    /// an address without waiting on a vendor to agree.
    denylist: Vec<String>,
    /// `None` only when the HTTP client could not be built. GoPlus needs no
    /// credentials, so screening cannot be switched off by leaving a variable
    /// unset — and a request that cannot be screened reports unavailable rather
    /// than allowing, because an unscreened deposit must not be able to produce
    /// an attestation that looks exactly like a screened one.
    screening: Option<GoPlusClient>,
    /// `None` when `KYT_RPC_URL` is unset. Without it there is no way to learn
    /// who funded a burner, and taking the client's word for it is exactly what
    /// this exists to avoid — so every request reports unavailable.
    funders: Option<FunderResolver>,
}

impl KytState {
    /// Read configuration from the environment. Never panics: a missing key
    /// degrades to a 503 per request, which is visible in a way a failed boot
    /// three services deep is not.
    pub fn from_env() -> Self {
        let signing_key = std::env::var("KYT_AUTHORITY_KEY").ok().and_then(|encoded| {
            match parse_signing_key(&encoded) {
                Ok(key) => Some(key),
                Err(err) => {
                    tracing::error!("KYT_AUTHORITY_KEY is unusable: {err}");
                    None
                }
            }
        });

        match &signing_key {
            Some(key) => tracing::info!(
                "KYT authority: {} — this must match SHREDR_KYT_AUTHORITY in the deployed program",
                bs58::encode(key.verifying_key().to_bytes()).into_string()
            ),
            None => tracing::warn!("KYT_AUTHORITY_KEY unset — screening will refuse every request"),
        }

        let screening = GoPlusClient::from_env();
        if screening.is_none() {
            tracing::warn!(
                "the GoPlus client could not be built — screening will report unavailable for every request"
            );
        }

        let funders = FunderResolver::from_env();
        if funders.is_none() {
            tracing::warn!(
                "KYT_RPC_URL unset — funder resolution will report unavailable for every request"
            );
        }

        Self {
            signing_key,
            screening,
            funders,
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
    pub async fn screen(&self, request: &ScreenRequest) -> Result<ScreenResponse, AppError> {
        // Validated first: a malformed burner MUST NOT cost an RPC round trip.
        let validated = self.validate(request)?;

        // Read off the chain, never off the request: the caller is the party
        // with a reason to name a cleaner address than the one that paid.
        let funders = self
            .funders
            .as_ref()
            .ok_or_else(|| {
                AppError::KytUnavailable("Funder resolution is not configured".to_string())
            })?
            .resolve(&request.burner)
            .await?;

        let primary = funders.first().ok_or_else(|| {
            AppError::KytUnavailable("Could not identify who funded the burner".to_string())
        })?;
        let depositor = decode_pubkey(primary, "funder")?;

        let (verdict, reason) = self.provider_verdict(&funders).await?;

        Ok(self.sign(&validated, depositor, funders, verdict, reason))
    }

    fn validate<'a>(&'a self, request: &ScreenRequest) -> Result<Validated<'a>, AppError> {
        Ok(Validated {
            key: self.signing_key.as_ref().ok_or_else(|| {
                AppError::KytUnavailable("KYT authority key is not configured".to_string())
            })?,
            burner: decode_pubkey(&request.burner, "burner")?,
            max_amount: request
                .max_amount
                .parse()
                .map_err(|_| AppError::Internal("maxAmount is not a u64".to_string()))?,
        })
    }

    fn sign(
        &self,
        validated: &Validated<'_>,
        depositor: [u8; 32],
        funders: Vec<String>,
        verdict: u8,
        reason: Option<String>,
    ) -> ScreenResponse {
        let key = validated.key;
        let expires_at = chrono::Utc::now().timestamp() + self.ttl_secs;

        // Bound before signed: an unbound attestation would be a bearer token
        // good for every deposit that wallet ever makes.
        let message = build_message(
            verdict,
            &depositor,
            &validated.burner,
            validated.max_amount,
            expires_at,
        );
        let signature = key.sign(&message).to_bytes();

        ScreenResponse {
            verdict,
            authority: bs58::encode(key.verifying_key().to_bytes()).into_string(),
            message: base64::engine::general_purpose::STANDARD.encode(message),
            signature: base64::engine::general_purpose::STANDARD.encode(signature),
            expires_at: expires_at as u64,
            funders,
            reason,
        }
    }

    /// Ask the screening provider, with `KYT_DENYLIST` as a local override.
    ///
    /// The denylist short-circuits the network call: a provider outage MUST NOT
    /// lift an operator's block.
    async fn provider_verdict(&self, funders: &[String]) -> Result<(u8, Option<String>), AppError> {
        if funders.iter().any(|funder| self.denylist.contains(funder)) {
            return Ok((
                VERDICT_REFUSE,
                Some("A funder is on the screening denylist".to_string()),
            ));
        }

        let screening = self.screening.as_ref().ok_or_else(|| {
            AppError::KytUnavailable("Screening provider is not configured".to_string())
        })?;

        // One tainted source taints the deposit, so stop at the first refusal.
        for funder in funders {
            let (verdict, reason) = screening.screen(funder).await?;
            if verdict == VERDICT_REFUSE {
                return Ok((verdict, reason));
            }
        }

        Ok((VERDICT_ALLOW, None))
    }
}

/// A request that has cleared local validation.
struct Validated<'a> {
    key: &'a SigningKey,
    burner: [u8; 32],
    max_amount: u64,
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
    /// The funders the relayer resolved from chain, most-funding first, with
    /// `funders[0]` the address bound into `message`.
    ///
    /// Returned so the client can compare them against its own read. That
    /// comparison is a desync signal, not a security control — a client an
    /// attacker has modified can simply skip it. What actually holds is that
    /// these are the addresses the relayer screened and signed over.
    pub funders: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    const DENYLISTED: &str = "11111111111111111111111111111111";

    fn state() -> KytState {
        KytState {
            signing_key: Some(SigningKey::from_bytes(&[7u8; 32])),
            ttl_secs: 300,
            denylist: vec![DENYLISTED.to_string()],
            screening: None,
            funders: None,
        }
    }

    /// The request carries only the burner now — who paid is the relayer's to
    /// find out, not the client's to assert.
    fn request() -> ScreenRequest {
        ScreenRequest {
            burner: bs58::encode([3u8; 32]).into_string(),
            max_amount: "5000000000".to_string(),
        }
    }

    /// An address that is neither denylisted nor known to any provider.
    fn unlisted() -> String {
        bs58::encode([9u8; 32]).into_string()
    }

    /// The program reads these offsets by hand and refuses anything that does
    /// not line up, so the layout is pinned here rather than assumed.
    #[test]
    fn message_is_bound_to_the_burner_and_the_ceiling() {
        let state = state();
        let request = request();
        let validated = state.validate(&request).expect("a well-formed request");
        let response = state.sign(&validated, [9u8; 32], vec![unlisted()], VERDICT_ALLOW, None);

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

        // Returned so the client can compare against its own read of the chain.
        assert_eq!(response.funders, vec![unlisted()]);
    }

    /// A refusal is signed and returned, not raised as an error: the client has
    /// to be able to tell "screened and refused" from "relayer unreachable".
    #[tokio::test]
    async fn a_refusal_is_signed_like_any_other_answer() {
        let state = state();
        let (verdict, reason) = state
            .provider_verdict(&[DENYLISTED.to_string()])
            .await
            .expect("the denylist is answered locally");

        assert_eq!(verdict, VERDICT_REFUSE);
        assert!(reason.is_some());

        let request = request();
        let validated = state.validate(&request).expect("a well-formed request");
        let response = state.sign(
            &validated,
            [9u8; 32],
            vec![DENYLISTED.to_string()],
            verdict,
            reason,
        );

        let message = base64::engine::general_purpose::STANDARD
            .decode(&response.message)
            .expect("base64");
        assert_eq!(message[9], VERDICT_REFUSE);
        assert!(response.reason.is_some());
    }

    /// The whole point of screening a list: one tainted source taints the
    /// deposit, even when it is not the source bound into the attestation.
    #[tokio::test]
    async fn a_denylisted_funder_refuses_even_when_it_is_not_the_primary() {
        let (verdict, _) = state()
            .provider_verdict(&[unlisted(), DENYLISTED.to_string()])
            .await
            .expect("the denylist is answered locally");

        assert_eq!(verdict, VERDICT_REFUSE);
    }

    /// With no provider configured, an address nobody has vouched for is not
    /// waved through. A missing integration must fail loudly, not open the gate.
    #[tokio::test]
    async fn an_unconfigured_provider_is_unavailable_not_an_allow() {
        assert!(matches!(
            state().provider_verdict(&[unlisted()]).await,
            Err(AppError::KytUnavailable(_))
        ));
    }

    /// The property that moving resolution server-side buys: with no way to find
    /// out who funded the burner there is nothing to screen, and nothing the
    /// client could have said would substitute for it.
    #[tokio::test]
    async fn an_unconfigured_resolver_is_unavailable_not_an_allow() {
        assert!(matches!(
            state().screen(&request()).await,
            Err(AppError::KytUnavailable(_))
        ));
    }

    #[tokio::test]
    async fn refuses_to_sign_without_an_authority_key() {
        let unconfigured = KytState {
            signing_key: None,
            ttl_secs: 300,
            denylist: vec![],
            screening: None,
            funders: None,
        };

        assert!(matches!(
            unconfigured.screen(&request()).await,
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

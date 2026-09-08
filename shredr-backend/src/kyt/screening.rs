//! Solana Developer Platform address screening.
//!
//! The provider half of KYT: ask SDP whether a depositing wallet is clean, and
//! reduce its answer to the one bit `kyt.rs` signs.
//!
//! ## Why there is a policy in here at all
//!
//! `POST /v1/compliance/address-screenings` returns no verdict. It returns a row
//! per configured provider — `{ provider, status, riskScore, riskLevel, ... }` —
//! and leaves the decision to the caller. Of those fields only `status` is a
//! usable enum: the spec calls `riskLevel` a "provider-specific risk level
//! label" (free text, differs per provider) and gives `riskScore` no documented
//! scale or direction, only an example of `7` alongside `"High risk"`. So the
//! threshold below is a calibrated guess, not a documented constant, and it is
//! an env var for that reason.
//!
//! ## What leaves the process
//!
//! The depositor address, and nothing else. Never the burner — the pair is the
//! correlation the whole design exists to prevent, and handing it to a third
//! party would give away in one request what the on-chain scheme spends a stealth
//! PDA to hide. Errors are logged with provider names and error codes only, never
//! with the address that was screened.

use serde::{Deserialize, Serialize};
use std::time::Duration;

use super::kyt::{VERDICT_ALLOW, VERDICT_REFUSE};
use crate::error::AppError;

const DEFAULT_BASE_URL: &str = "https://api.solana.com";
const DEFAULT_NETWORK: &str = "solana";

/// One of `transfer_destination`, `wallet_address_addition`, `unknown`.
///
/// None of the three is a clean fit: we screen a wallet *sending* into the pool,
/// and `transfer_destination` describes one receiving. It is the value SDP's own
/// example uses and the closest to "counterparty we are about to accept", so it
/// is the default — overridable once SDP says which they'd rather see.
const DEFAULT_INTENT: &str = "transfer_destination";

/// A provider that has not answered in this long is treated as not answering.
/// A deposit flow blocked on a hung compliance vendor is an outage either way;
/// this at least makes it a fast one.
const DEFAULT_TIMEOUT_SECS: u64 = 10;

/// Score at or above which a provider is taken to have flagged the address.
/// Anchored to the spec's own example — `riskScore: 7` shown with
/// `riskLevel: "High risk"` — which is the only calibration point published.
const DEFAULT_RISK_THRESHOLD: f64 = 7.0;

/// How many providers must flag before a deposit is refused.
///
/// Set to 2 deliberately: one noisy vendor should not be able to refuse a
/// depositor by itself. The cost is that a quorum of 2 is unreachable when fewer
/// than 2 providers answer, which is handled as unavailability rather than as
/// consent — see [`evaluate`].
const DEFAULT_QUORUM: usize = 2;

/// Provider `status` values, per the OpenAPI enum: `ok | unavailable | error`.
/// Only `ok` is a result; the other two are a provider declining to answer.
const STATUS_OK: &str = "ok";

#[derive(Serialize)]
struct ScreeningRequest<'a> {
    address: &'a str,
    network: &'a str,
    intent: &'a str,
}

#[derive(Deserialize)]
struct ScreeningEnvelope {
    data: ScreeningData,
}

#[derive(Deserialize)]
struct ScreeningData {
    screening: Screening,
}

#[derive(Deserialize)]
struct Screening {
    providers: Vec<ProviderResult>,
}

/// One provider's answer. `riskScore` is required by the schema but nullable, and
/// `riskLevel`/`message` are optional entirely, so everything past `status` is an
/// `Option` here.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderResult {
    pub provider: String,
    pub status: String,
    pub risk_score: Option<f64>,
    #[serde(default)]
    pub risk_level: Option<String>,
}

#[derive(Deserialize)]
struct ErrorEnvelope {
    error: ErrorPayload,
}

#[derive(Deserialize)]
struct ErrorPayload {
    code: String,
    message: String,
}

#[derive(Clone)]
pub struct ScreeningClient {
    http: reqwest::Client,
    endpoint: String,
    api_key: String,
    network: String,
    intent: String,
    risk_threshold: f64,
    /// Case-insensitive `riskLevel` labels that count as a flag on their own.
    /// Empty by default: the labels are provider-specific free text, so guessing
    /// them would be a silent no-op at best. Populate once you have seen what
    /// your configured providers actually return.
    deny_labels: Vec<String>,
    quorum: usize,
}

impl ScreeningClient {
    /// `None` when `SDP_API_KEY` is unset, which the caller turns into a 503.
    ///
    /// The key is a secret (`sk_test_…`/`sk_live_…`) and is read here, in the
    /// backend, on purpose. It must never reach a `VITE_*` var — Vite inlines
    /// those into the browser bundle, which would publish it.
    pub fn from_env() -> Option<Self> {
        let api_key = std::env::var("SDP_API_KEY")
            .ok()
            .map(|key| key.trim().to_string())
            .filter(|key| !key.is_empty())?;

        let base_url = env_string("SDP_BASE_URL").unwrap_or_else(|| DEFAULT_BASE_URL.to_string());
        let timeout_secs = env_parse("SDP_TIMEOUT_SECS").unwrap_or(DEFAULT_TIMEOUT_SECS);

        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(timeout_secs))
            .build()
            .map_err(|err| tracing::error!("could not build the SDP HTTP client: {err}"))
            .ok()?;

        let quorum = env_parse("SDP_FLAG_QUORUM").unwrap_or(DEFAULT_QUORUM).max(1);
        let risk_threshold = env_parse("SDP_RISK_THRESHOLD").unwrap_or(DEFAULT_RISK_THRESHOLD);

        tracing::info!(
            "SDP screening enabled: {} providers must report riskScore >= {} to refuse",
            quorum,
            risk_threshold
        );

        Some(Self {
            http,
            endpoint: format!(
                "{}/v1/compliance/address-screenings",
                base_url.trim_end_matches('/')
            ),
            api_key,
            network: env_string("SDP_NETWORK").unwrap_or_else(|| DEFAULT_NETWORK.to_string()),
            intent: env_string("SDP_SCREENING_INTENT")
                .unwrap_or_else(|| DEFAULT_INTENT.to_string()),
            risk_threshold,
            deny_labels: env_string("SDP_RISK_LEVEL_DENY")
                .unwrap_or_default()
                .split(',')
                .map(|label| label.trim().to_lowercase())
                .filter(|label| !label.is_empty())
                .collect(),
            quorum,
        })
    }

    /// Screen `address` and reduce the provider rows to `(verdict, reason)`.
    ///
    /// Every failure path returns [`AppError::KytUnavailable`], never an allow: a
    /// screening we could not complete is not a screening that passed.
    pub async fn screen(&self, address: &str) -> Result<(u8, Option<String>), AppError> {
        let response = self
            .http
            .post(&self.endpoint)
            .bearer_auth(&self.api_key)
            .json(&ScreeningRequest {
                address,
                network: &self.network,
                intent: &self.intent,
            })
            .send()
            .await
            .map_err(|err| {
                // `err` carries the URL but not the body, so this cannot leak the
                // address. Kept deliberately terse for the same reason.
                tracing::error!("SDP screening request failed: {err}");
                AppError::KytUnavailable("Screening provider is unreachable".to_string())
            })?;

        let status = response.status();
        let body = response.bytes().await.map_err(|err| {
            tracing::error!("could not read the SDP screening response: {err}");
            AppError::KytUnavailable("Screening provider returned an unreadable response".to_string())
        })?;

        if !status.is_success() {
            return Err(self.classify_error(status, &body));
        }

        let envelope: ScreeningEnvelope = serde_json::from_slice(&body).map_err(|err| {
            tracing::error!("could not parse the SDP screening response: {err}");
            AppError::KytUnavailable("Screening provider returned an unrecognised response".to_string())
        })?;

        evaluate(
            &envelope.data.screening.providers,
            self.risk_threshold,
            self.quorum,
            &self.deny_labels,
        )
    }

    /// A bad key and a rate limit are both 4xx but mean very different things to
    /// whoever is on call, so they are logged apart. Both still surface to the
    /// depositor as "unavailable, try again" — an operator error is not a reason
    /// to tell someone they failed screening.
    fn classify_error(&self, status: reqwest::StatusCode, body: &[u8]) -> AppError {
        let code = serde_json::from_slice::<ErrorEnvelope>(body)
            .map(|envelope| {
                let ErrorPayload { code, message } = envelope.error;
                tracing::error!("SDP screening rejected the request: {code} — {message}");
                code
            })
            .unwrap_or_else(|_| {
                tracing::error!("SDP screening returned HTTP {status} with an unparseable body");
                status.as_str().to_string()
            });

        match code.as_str() {
            "INVALID_API_KEY" | "EXPIRED_API_KEY" | "REVOKED_API_KEY" | "UNAUTHORIZED"
            | "INSUFFICIENT_PERMISSIONS" | "FORBIDDEN" => AppError::KytUnavailable(
                "Screening provider rejected the relayer's credentials".to_string(),
            ),
            "PROVIDER_NOT_CONFIGURED" | "PROVIDER_UNAVAILABLE" => {
                AppError::KytUnavailable("No screening provider is configured".to_string())
            }
            "RATE_LIMITED" => {
                AppError::KytUnavailable("Screening provider is rate limiting".to_string())
            }
            _ => AppError::KytUnavailable("Screening provider returned an error".to_string()),
        }
    }
}

/// Reduce provider rows to a verdict.
///
/// Two rules, in order:
///
/// 1. Fewer than `quorum` providers answered `ok` → [`AppError::KytUnavailable`].
///    A quorum that cannot be reached is not a quorum that acquitted: with one
///    provider answering and a quorum of 2, "refuse" is arithmetically impossible,
///    so treating a short roll call as an allow would silently disable the gate.
///    503 is retryable and loud; an allow would be neither.
/// 2. `quorum` or more of those answers flagged the address → refuse.
///
/// A provider flags when its score clears `threshold`, or when its `riskLevel`
/// label is in `deny_labels`. A null score with no matching label is not a flag —
/// it still counts toward the roll call, because the provider did answer.
pub fn evaluate(
    providers: &[ProviderResult],
    threshold: f64,
    quorum: usize,
    deny_labels: &[String],
) -> Result<(u8, Option<String>), AppError> {
    let answered: Vec<&ProviderResult> = providers
        .iter()
        .filter(|result| result.status == STATUS_OK)
        .collect();

    if answered.len() < quorum {
        tracing::error!(
            "SDP screening reached only {} of the {} providers required for a verdict",
            answered.len(),
            quorum
        );
        return Err(AppError::KytUnavailable(
            "Too few screening providers responded to reach a verdict".to_string(),
        ));
    }

    let flagged: Vec<&str> = answered
        .iter()
        .filter(|result| flags(result, threshold, deny_labels))
        .map(|result| result.provider.as_str())
        .collect();

    if flagged.len() >= quorum {
        // Provider names are safe to return; the depositor address and the
        // providers' own `message` text are not, and are left out.
        return Ok((
            VERDICT_REFUSE,
            Some(format!(
                "Flagged by {} of {} screening providers ({})",
                flagged.len(),
                answered.len(),
                flagged.join(", ")
            )),
        ));
    }

    Ok((VERDICT_ALLOW, None))
}

fn flags(result: &ProviderResult, threshold: f64, deny_labels: &[String]) -> bool {
    if result.risk_score.is_some_and(|score| score >= threshold) {
        return true;
    }

    result.risk_level.as_ref().is_some_and(|label| {
        let label = label.trim().to_lowercase();
        deny_labels.contains(&label)
    })
}

fn env_string(key: &str) -> Option<String> {
    std::env::var(key)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn env_parse<T: std::str::FromStr>(key: &str) -> Option<T> {
    env_string(key).and_then(|value| value.parse().ok())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn result(provider: &str, status: &str, score: Option<f64>) -> ProviderResult {
        ProviderResult {
            provider: provider.to_string(),
            status: status.to_string(),
            risk_score: score,
            risk_level: None,
        }
    }

    fn labelled(provider: &str, label: &str) -> ProviderResult {
        ProviderResult {
            provider: provider.to_string(),
            status: STATUS_OK.to_string(),
            risk_score: None,
            risk_level: Some(label.to_string()),
        }
    }

    #[test]
    fn one_flag_is_not_enough_to_refuse() {
        let (verdict, reason) = evaluate(
            &[
                result("range", "ok", Some(9.0)),
                result("elliptic", "ok", Some(1.0)),
                result("trm", "ok", Some(0.0)),
            ],
            7.0,
            2,
            &[],
        )
        .expect("three providers answered");

        assert_eq!(verdict, VERDICT_ALLOW);
        assert!(reason.is_none());
    }

    #[test]
    fn two_flags_refuse_and_name_the_providers() {
        let (verdict, reason) = evaluate(
            &[
                result("range", "ok", Some(9.0)),
                result("elliptic", "ok", Some(7.0)),
                result("trm", "ok", Some(1.0)),
            ],
            7.0,
            2,
            &[],
        )
        .expect("three providers answered");

        assert_eq!(verdict, VERDICT_REFUSE);
        let reason = reason.expect("a refusal explains itself");
        assert!(reason.contains("range"), "{reason}");
        assert!(reason.contains("elliptic"), "{reason}");
        // The score that triggered it is the provider's business, not the
        // depositor's counterparty's.
        assert!(!reason.contains("9"), "{reason}");
    }

    /// The case the quorum choice creates: one provider flags, nobody else is
    /// there to second it. Allowing would silently disable the gate.
    #[test]
    fn an_unreachable_quorum_is_unavailable_not_consent() {
        let outcome = evaluate(
            &[
                result("range", "ok", Some(10.0)),
                result("elliptic", "unavailable", None),
                result("trm", "error", None),
            ],
            7.0,
            2,
            &[],
        );

        assert!(matches!(outcome, Err(AppError::KytUnavailable(_))));
    }

    #[test]
    fn no_providers_at_all_is_unavailable() {
        assert!(matches!(
            evaluate(&[], 7.0, 2, &[]),
            Err(AppError::KytUnavailable(_))
        ));
    }

    /// `status` is the only enum the response guarantees, so a non-`ok` row is
    /// never read for its score — even when it carries one.
    #[test]
    fn scores_on_non_ok_rows_are_ignored() {
        let (verdict, _) = evaluate(
            &[
                result("range", "ok", Some(1.0)),
                result("elliptic", "ok", Some(1.0)),
                result("trm", "error", Some(10.0)),
                result("chainalysis", "unavailable", Some(10.0)),
            ],
            7.0,
            2,
            &[],
        )
        .expect("two providers answered");

        assert_eq!(verdict, VERDICT_ALLOW);
    }

    /// A null score is not an acquittal and not a flag: the provider answered, so
    /// it counts toward the roll call, but it contributes no signal.
    #[test]
    fn a_null_score_answers_the_roll_call_without_flagging() {
        let (verdict, _) = evaluate(
            &[
                result("range", "ok", None),
                result("elliptic", "ok", None),
                result("trm", "ok", Some(9.0)),
            ],
            7.0,
            2,
            &[],
        )
        .expect("three providers answered");

        assert_eq!(verdict, VERDICT_ALLOW);
    }

    #[test]
    fn deny_labels_flag_providers_that_return_no_score() {
        let deny = vec!["high risk".to_string(), "severe".to_string()];

        let (verdict, _) = evaluate(
            &[labelled("range", "High Risk"), labelled("elliptic", "Severe")],
            7.0,
            2,
            &deny,
        )
        .expect("two providers answered");
        assert_eq!(verdict, VERDICT_REFUSE);

        // Unconfigured labels are inert rather than guessed at.
        let (verdict, _) = evaluate(
            &[labelled("range", "High Risk"), labelled("elliptic", "Severe")],
            7.0,
            2,
            &[],
        )
        .expect("two providers answered");
        assert_eq!(verdict, VERDICT_ALLOW);
    }

    #[test]
    fn a_quorum_of_one_refuses_on_a_single_flag() {
        let (verdict, _) = evaluate(&[result("range", "ok", Some(8.0))], 7.0, 1, &[])
            .expect("one provider answered");

        assert_eq!(verdict, VERDICT_REFUSE);
    }

    /// Field names come straight off the wire, so they are pinned against a
    /// literal response rather than against our own serialiser.
    #[test]
    fn parses_the_documented_response_shape() {
        let body = br#"{
          "data": { "screening": {
            "address": "8dHEsGLpCZHZbXnFVvqWq4kMfM2pVDuNrXvVJVhQWRGZ",
            "network": "solana",
            "intent": "transfer_destination",
            "checkedAt": "2025-01-01T00:00:00.000Z",
            "providers": [
              { "provider": "range", "status": "ok", "riskScore": 7,
                "riskLevel": "High risk", "evaluatedAt": "2025-01-01T00:00:00.000Z" },
              { "provider": "elliptic", "status": "unavailable", "riskScore": null,
                "evaluatedAt": "2025-01-01T00:00:00.000Z" }
            ]
          } },
          "meta": { "requestId": "req_example", "timestamp": "2025-01-01T00:00:00.000Z" }
        }"#;

        let envelope: ScreeningEnvelope = serde_json::from_slice(body).expect("documented shape");
        let providers = envelope.data.screening.providers;

        assert_eq!(providers.len(), 2);
        assert_eq!(providers[0].provider, "range");
        assert_eq!(providers[0].risk_score, Some(7.0));
        assert_eq!(providers[0].risk_level.as_deref(), Some("High risk"));
        // Nullable score and absent riskLevel both have to survive parsing.
        assert_eq!(providers[1].risk_score, None);
        assert_eq!(providers[1].risk_level, None);
    }

    #[test]
    fn parses_the_documented_error_shape() {
        let body = br#"{
          "error": { "code": "PROVIDER_NOT_CONFIGURED", "message": "No provider configured." },
          "meta": { "requestId": "req_example" }
        }"#;

        let envelope: ErrorEnvelope = serde_json::from_slice(body).expect("documented shape");
        assert_eq!(envelope.error.code, "PROVIDER_NOT_CONFIGURED");
    }
}

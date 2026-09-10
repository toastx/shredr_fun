//! GoPlus address screening.
//!
//! The provider half of KYT: ask GoPlus whether a depositing wallet is known-bad,
//! and reduce its answer to the one bit `kyt.rs` signs.
//!
//! ```text
//! GET https://api.gopluslabs.io/api/v1/address_security/{address}?chain_id=501
//! ```
//!
//! `501` is Solana's SLIP-44 coin type, and is what the API wants — `chain_id=solana`
//! returns `{"code":5000,"message":"system error"}`. The endpoint is public: it
//! takes no credentials and works without an `Authorization` header. Sending an
//! app key as a bearer token actively breaks it with `4012 signature
//! verification failure`, because app keys are not access tokens.
//!
//! ## Why not the other endpoint
//!
//! `/api/v1/address/scan/{chain_id}` looks like the richer sibling and is not
//! usable here: with a correctly minted token it answers `2018 ChainID not
//! supported` for 501. That is a capability limit, not a credential problem.
//!
//! ## Why not SDP
//!
//! The Solana Developer Platform screening API was the previous provider. It
//! screens only against providers configured on the org, there is no API to
//! configure them, and its `riskScore` has no documented scale — the threshold
//! was a guess anchored to one example in the spec. It never returned a verdict
//! in this repo. GoPlus answers today, for free, with named boolean flags whose
//! meaning is legible, so the policy below is a list of flag names rather than a
//! number nobody can calibrate.
//!
//! ## What leaves the process
//!
//! The depositor address, and nothing else. Never the burner — the pair is the
//! correlation the whole design exists to prevent. Errors are logged with GoPlus
//! response codes only, never with the address that was screened.

use serde::Deserialize;
use std::collections::HashMap;
use std::time::Duration;

use super::kyt::{VERDICT_ALLOW, VERDICT_REFUSE};
use crate::error::AppError;

const DEFAULT_BASE_URL: &str = "https://api.gopluslabs.io";

/// Solana's SLIP-44 coin type. Not the string `solana`, which the API rejects.
const DEFAULT_CHAIN_ID: &str = "501";

const DEFAULT_TIMEOUT_SECS: u64 = 10;

/// `code` on a successful response. Everything else is an error, including
/// `4029` (rate limited) and `2018` (chain unsupported).
const CODE_OK: i64 = 1;

/// Flags that refuse a deposit.
///
/// Every one of these is a statement about where the money has been, which is
/// the only question a deposit gate is asking. The fields left out —
/// `fake_token`, `fake_standard_interface`, `gas_abuse`, `reinit`,
/// `contract_address` — describe the shape of a *contract*, not the conduct of a
/// depositor, and on Solana `contract_address` comes back `-1` (unknown) anyway.
///
/// `number_of_malicious_contracts_created` is a count rather than a boolean; the
/// `> 0` test below covers both without special-casing.
const DEFAULT_DENY_FLAGS: &[&str] = &[
    "sanctioned",
    "money_laundering",
    "financial_crime",
    "darkweb_transactions",
    "blacklist_doubt",
    "mixer",
    "cybercrime",
    "stealing_attack",
    "blackmail_activities",
    "phishing_activities",
    "malicious_mining_activities",
    "honeypot_related_address",
    "fake_kyc",
    "number_of_malicious_contracts_created",
];

/// Every field GoPlus returns is a stringified number, so the whole result is
/// read as a string map rather than a struct. New flags then arrive without a
/// deploy, and `deny_flags` decides which of them matter.
#[derive(Deserialize)]
struct GoPlusEnvelope {
    code: i64,
    #[serde(default)]
    message: Option<String>,
    #[serde(default)]
    result: Option<HashMap<String, String>>,
}

#[derive(Clone)]
pub struct GoPlusClient {
    http: reqwest::Client,
    base_url: String,
    chain_id: String,
    deny_flags: Vec<String>,
}

impl GoPlusClient {
    /// `None` only when the HTTP client cannot be built.
    ///
    /// There is no API key to be missing: the endpoint is public, so screening is
    /// always on rather than something an unset variable can silently disable.
    pub fn from_env() -> Option<Self> {
        let timeout_secs = env_parse("GOPLUS_TIMEOUT_SECS").unwrap_or(DEFAULT_TIMEOUT_SECS);

        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(timeout_secs))
            .build()
            .map_err(|err| tracing::error!("could not build the GoPlus HTTP client: {err}"))
            .ok()?;

        let deny_flags: Vec<String> = env_string("GOPLUS_DENY_FLAGS")
            .map(|value| {
                value
                    .split(',')
                    .map(|flag| flag.trim().to_lowercase())
                    .filter(|flag| !flag.is_empty())
                    .collect()
            })
            .unwrap_or_else(|| DEFAULT_DENY_FLAGS.iter().map(|f| f.to_string()).collect());

        tracing::info!(
            "GoPlus screening enabled: {} flags refuse a deposit",
            deny_flags.len()
        );

        Some(Self {
            http,
            base_url: env_string("GOPLUS_BASE_URL")
                .unwrap_or_else(|| DEFAULT_BASE_URL.to_string())
                .trim_end_matches('/')
                .to_string(),
            chain_id: env_string("GOPLUS_CHAIN_ID").unwrap_or_else(|| DEFAULT_CHAIN_ID.to_string()),
            deny_flags,
        })
    }

    /// Screen `address` and reduce the flags to `(verdict, reason)`.
    ///
    /// Every failure path returns [`AppError::KytUnavailable`], never an allow: a
    /// screening we could not complete is not a screening that passed. That
    /// includes rate limiting, which is the one a busy relayer will actually hit.
    pub async fn screen(&self, address: &str) -> Result<(u8, Option<String>), AppError> {
        let url = format!(
            "{}/api/v1/address_security/{}?chain_id={}",
            self.base_url, address, self.chain_id
        );

        let response = self.http.get(&url).send().await.map_err(|err| {
            // `err` can carry the URL, which carries the address, so only the
            // status is logged.
            tracing::error!(
                "GoPlus screening request failed: {}",
                err.status()
                    .map(|status| status.to_string())
                    .unwrap_or_else(|| "no response".to_string())
            );
            AppError::KytUnavailable("Screening provider is unreachable".to_string())
        })?;

        // GoPlus answers 200 for business errors too, so the envelope decides.
        let envelope: GoPlusEnvelope = response.json().await.map_err(|err| {
            tracing::error!("could not parse the GoPlus response: {err}");
            AppError::KytUnavailable(
                "Screening provider returned an unrecognised response".to_string(),
            )
        })?;

        if envelope.code != CODE_OK {
            return Err(classify_error(envelope.code, envelope.message.as_deref()));
        }

        let flags = envelope.result.ok_or_else(|| {
            tracing::error!("GoPlus returned code 1 with no result body");
            AppError::KytUnavailable("Screening provider returned no result".to_string())
        })?;

        Ok(evaluate(&flags, &self.deny_flags))
    }
}

/// Reduce GoPlus's flag map to a verdict.
///
/// A flag counts when it parses to a number greater than zero. Absent flags and
/// unparseable ones do not count: GoPlus adds fields over time, and a value this
/// code cannot read is not evidence of anything.
///
/// An all-clear map is an allow even when `data_source` is empty. Empty is the
/// normal case for an address no provider has ever recorded — which is most of
/// them — so treating it as "unknown, refuse" would refuse nearly everyone.
pub fn evaluate(flags: &HashMap<String, String>, deny_flags: &[String]) -> (u8, Option<String>) {
    let mut tripped: Vec<&str> = deny_flags
        .iter()
        .filter(|flag| {
            flags
                .get(*flag)
                .and_then(|value| value.trim().parse::<f64>().ok())
                .is_some_and(|value| value > 0.0)
        })
        .map(String::as_str)
        .collect();

    if tripped.is_empty() {
        return (VERDICT_ALLOW, None);
    }

    // Sorted so the same address always produces the same reason string.
    tripped.sort_unstable();

    (
        VERDICT_REFUSE,
        Some(format!(
            "Screening provider flagged this address: {}",
            tripped.join(", ")
        )),
    )
}

/// Documented GoPlus codes, kept apart because they mean different things to
/// whoever is on call. All of them still surface to the depositor as
/// "unavailable, try again" — an operator problem is not a reason to tell
/// somebody they failed screening.
fn classify_error(code: i64, message: Option<&str>) -> AppError {
    tracing::error!(
        "GoPlus screening returned code {code}: {}",
        message.unwrap_or("no message")
    );

    match code {
        4029 => AppError::KytUnavailable("Screening provider is rate limiting".to_string()),
        4010 | 4012 => {
            AppError::KytUnavailable("Screening provider rejected our credentials".to_string())
        }
        2018 => AppError::KytUnavailable(
            "Screening provider does not support this chain".to_string(),
        ),
        _ => AppError::KytUnavailable("Screening provider returned an error".to_string()),
    }
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

    fn deny() -> Vec<String> {
        DEFAULT_DENY_FLAGS.iter().map(|f| f.to_string()).collect()
    }

    /// A real response, captured from the live endpoint for a clean Solana
    /// address. Pinned verbatim so a change in the wire format shows up here
    /// rather than as a deposit that mysteriously stops screening.
    const CLEAN_RESPONSE: &str = r#"{
      "code": 1,
      "message": "ok",
      "result": {
        "cybercrime": "0", "money_laundering": "0",
        "number_of_malicious_contracts_created": "0", "gas_abuse": "0",
        "financial_crime": "0", "darkweb_transactions": "0", "reinit": "0",
        "phishing_activities": "0", "contract_address": "-1", "fake_kyc": "0",
        "blacklist_doubt": "0", "fake_standard_interface": "0", "data_source": "",
        "stealing_attack": "0", "blackmail_activities": "0", "sanctioned": "0",
        "malicious_mining_activities": "0", "mixer": "0", "fake_token": "0",
        "honeypot_related_address": "0"
      }
    }"#;

    #[test]
    fn parses_a_real_clean_response_and_allows_it() {
        let envelope: GoPlusEnvelope = serde_json::from_str(CLEAN_RESPONSE).expect("live shape");
        assert_eq!(envelope.code, CODE_OK);

        let (verdict, reason) = evaluate(&envelope.result.expect("result"), &deny());
        assert_eq!(verdict, VERDICT_ALLOW);
        assert!(reason.is_none());
    }

    /// `contract_address: "-1"` is Solana's "unknown", and it is not in the deny
    /// list — but the `> 0` test has to reject it regardless, because a negative
    /// number must never read as a set flag.
    #[test]
    fn a_negative_value_is_not_a_flag() {
        let flags = HashMap::from([("contract_address".to_string(), "-1".to_string())]);
        let (verdict, _) = evaluate(&flags, &["contract_address".to_string()]);
        assert_eq!(verdict, VERDICT_ALLOW);
    }

    #[test]
    fn a_sanctioned_address_is_refused_and_the_reason_names_the_flag() {
        let flags = HashMap::from([
            ("sanctioned".to_string(), "1".to_string()),
            ("mixer".to_string(), "0".to_string()),
        ]);

        let (verdict, reason) = evaluate(&flags, &deny());
        assert_eq!(verdict, VERDICT_REFUSE);

        let reason = reason.expect("a refusal explains itself");
        assert!(reason.contains("sanctioned"), "{reason}");
        assert!(!reason.contains("mixer"), "{reason}");
    }

    /// A count rather than a boolean, so the same `> 0` rule has to cover it.
    #[test]
    fn a_count_flag_trips_above_zero() {
        let zero = HashMap::from([(
            "number_of_malicious_contracts_created".to_string(),
            "0".to_string(),
        )]);
        assert_eq!(evaluate(&zero, &deny()).0, VERDICT_ALLOW);

        let some = HashMap::from([(
            "number_of_malicious_contracts_created".to_string(),
            "3".to_string(),
        )]);
        assert_eq!(evaluate(&some, &deny()).0, VERDICT_REFUSE);
    }

    /// Several flags are reported together and in a stable order, so the same
    /// address does not produce a different reason on each retry.
    #[test]
    fn multiple_flags_are_reported_in_a_stable_order() {
        let flags = HashMap::from([
            ("mixer".to_string(), "1".to_string()),
            ("sanctioned".to_string(), "1".to_string()),
            ("cybercrime".to_string(), "1".to_string()),
        ]);

        let first = evaluate(&flags, &deny()).1.expect("reason");
        let second = evaluate(&flags, &deny()).1.expect("reason");
        assert_eq!(first, second);
        assert!(first.contains("cybercrime, mixer, sanctioned"), "{first}");
    }

    /// Fields this code does not know about are not evidence. GoPlus adds them
    /// over time, and an unreadable value must not become a silent refusal.
    #[test]
    fn unknown_and_unparseable_values_are_ignored() {
        let flags = HashMap::from([
            ("some_future_flag".to_string(), "1".to_string()),
            ("sanctioned".to_string(), "".to_string()),
            ("mixer".to_string(), "not a number".to_string()),
        ]);

        assert_eq!(evaluate(&flags, &deny()).0, VERDICT_ALLOW);
    }

    /// Empty `data_source` is the normal case for an unremarkable address, so it
    /// must not be read as "no data, refuse".
    #[test]
    fn an_empty_data_source_still_allows() {
        let flags = HashMap::from([
            ("data_source".to_string(), String::new()),
            ("sanctioned".to_string(), "0".to_string()),
        ]);

        assert_eq!(evaluate(&flags, &deny()).0, VERDICT_ALLOW);
    }

    /// Business errors arrive with HTTP 200, so the envelope code is the only
    /// thing that separates them from a verdict. Each is retryable.
    #[test]
    fn documented_error_codes_are_unavailable_not_refusals() {
        for code in [4029, 4012, 4010, 2018, 5000] {
            let envelope: GoPlusEnvelope =
                serde_json::from_str(&format!(r#"{{"code":{code},"message":"x","result":null}}"#))
                    .expect("error shape");
            assert_ne!(envelope.code, CODE_OK);
            assert!(matches!(
                classify_error(envelope.code, envelope.message.as_deref()),
                AppError::KytUnavailable(_)
            ));
        }
    }
}

//! GoPlus address screening.
//!
//! `GET /api/v1/address_security/{address}?chain_id=501`
//!
//! `chain_id` MUST be `501`; the string `solana` returns code 5000. Credentials
//! are optional and raise rate limits only. An app key sent as a bearer token
//! is rejected with 4012 — it is not an access token.
//!
//! The burner MUST NOT be sent, and errors MUST NOT log the address.

use serde::Deserialize;
use sha1::{Digest, Sha1};
use std::collections::HashMap;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::sync::RwLock;

use super::kyt::{VERDICT_ALLOW, VERDICT_REFUSE};
use crate::error::AppError;

const DEFAULT_BASE_URL: &str = "https://api.gopluslabs.io";
const DEFAULT_CHAIN_ID: &str = "501";
const DEFAULT_TIMEOUT_SECS: u64 = 10;

const CODE_OK: i64 = 1;

/// Refresh this far ahead of expiry so a screening in flight cannot race it.
const REFRESH_MARGIN: Duration = Duration::from_secs(300);

/// Used when a token response omits `expires_in`.
const FALLBACK_TOKEN_TTL: Duration = Duration::from_secs(3600);

/// Flags that refuse a deposit. Excludes contract-shape fields
/// (`fake_token`, `gas_abuse`, `reinit`, `fake_standard_interface`,
/// `contract_address`), which describe a contract rather than a depositor.
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

/// Read as a string map: every GoPlus field is a stringified number, and new
/// ones then arrive without a deploy.
#[derive(Deserialize)]
struct GoPlusEnvelope {
    code: i64,
    #[serde(default)]
    message: Option<String>,
    #[serde(default)]
    result: Option<HashMap<String, String>>,
}

#[derive(Deserialize)]
struct TokenEnvelope {
    code: i64,
    #[serde(default)]
    message: Option<String>,
    #[serde(default)]
    result: Option<TokenResult>,
}

#[derive(Deserialize)]
struct TokenResult {
    /// Already prefixed with `Bearer `.
    access_token: String,
    #[serde(default)]
    expires_in: Option<u64>,
}

struct Credentials {
    app_key: String,
    app_secret: String,
}

struct CachedToken {
    header: String,
    expires_at: Instant,
}

#[derive(Clone)]
pub struct GoPlusClient {
    http: reqwest::Client,
    base_url: String,
    chain_id: String,
    deny_flags: Vec<String>,
    credentials: Option<std::sync::Arc<Credentials>>,
    token: std::sync::Arc<RwLock<Option<CachedToken>>>,
}

impl GoPlusClient {
    /// `None` only when the HTTP client cannot be built. No key can be left unset
    /// to silently disable screening.
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

        let credentials = match (
            env_string("GOPLUS_APP_KEY"),
            env_string("GOPLUS_APP_SECRET"),
        ) {
            (Some(app_key), Some(app_secret)) => Some(std::sync::Arc::new(Credentials {
                app_key,
                app_secret,
            })),
            (Some(_), None) | (None, Some(_)) => {
                tracing::warn!(
                    "GOPLUS_APP_KEY and GOPLUS_APP_SECRET must be set together — \
                     screening will run unauthenticated"
                );
                None
            }
            (None, None) => None,
        };

        tracing::info!(
            "GoPlus screening enabled: {} deny flags, {}",
            deny_flags.len(),
            if credentials.is_some() {
                "authenticated"
            } else {
                "unauthenticated (lower rate limits)"
            }
        );

        Some(Self {
            http,
            base_url: env_string("GOPLUS_BASE_URL")
                .unwrap_or_else(|| DEFAULT_BASE_URL.to_string())
                .trim_end_matches('/')
                .to_string(),
            chain_id: env_string("GOPLUS_CHAIN_ID").unwrap_or_else(|| DEFAULT_CHAIN_ID.to_string()),
            deny_flags,
            credentials,
            token: std::sync::Arc::new(RwLock::new(None)),
        })
    }

    /// Screen `address` and reduce the flags to `(verdict, reason)`.
    ///
    /// Every failure MUST return [`AppError::KytUnavailable`], never an allow.
    pub async fn screen(&self, address: &str) -> Result<(u8, Option<String>), AppError> {
        let url = format!(
            "{}/api/v1/address_security/{}?chain_id={}",
            self.base_url, address, self.chain_id
        );

        let mut request = self.http.get(&url);
        if let Some(header) = self.access_token().await {
            request = request.header("Authorization", header);
        }

        let response = request.send().await.map_err(|err| {
            // The URL carries the address, so only the status is logged.
            tracing::error!(
                "GoPlus screening request failed: {}",
                err.status()
                    .map(|status| status.to_string())
                    .unwrap_or_else(|| "no response".to_string())
            );
            AppError::KytUnavailable("Screening provider is unreachable".to_string())
        })?;

        // Business errors arrive with HTTP 200, so the envelope decides.
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

    /// Cached `Authorization` value, minted on demand.
    ///
    /// `None` means screen unauthenticated: a token outage MUST NOT become a
    /// deposit outage. `sign` is `sha1(app_key + unix_seconds + app_secret)`;
    /// the returned `access_token` already carries its `Bearer ` prefix.
    async fn access_token(&self) -> Option<String> {
        let credentials = self.credentials.as_ref()?;

        if let Some(cached) = self.token.read().await.as_ref() {
            if cached.expires_at > Instant::now() {
                return Some(cached.header.clone());
            }
        }

        let mut slot = self.token.write().await;
        // Another task may have minted one while this waited on the lock.
        if let Some(cached) = slot.as_ref() {
            if cached.expires_at > Instant::now() {
                return Some(cached.header.clone());
            }
        }

        let time = SystemTime::now().duration_since(UNIX_EPOCH).ok()?.as_secs();
        let sign = hex(&Sha1::digest(
            format!("{}{}{}", credentials.app_key, time, credentials.app_secret).as_bytes(),
        ));

        let response = self
            .http
            .post(format!("{}/api/v1/token", self.base_url))
            .json(&serde_json::json!({
                "app_key": credentials.app_key,
                "time": time,
                "sign": sign,
            }))
            .send()
            .await
            .map_err(|err| tracing::warn!("GoPlus token request failed: {err}"))
            .ok()?;

        let envelope: TokenEnvelope = response
            .json()
            .await
            .map_err(|err| tracing::warn!("could not parse the GoPlus token response: {err}"))
            .ok()?;

        if envelope.code != CODE_OK {
            tracing::warn!(
                "GoPlus token request returned code {}: {}",
                envelope.code,
                envelope.message.as_deref().unwrap_or("no message")
            );
            return None;
        }

        let result = envelope.result?;
        let ttl = result
            .expires_in
            .map(Duration::from_secs)
            .unwrap_or(FALLBACK_TOKEN_TTL);

        *slot = Some(CachedToken {
            header: result.access_token.clone(),
            expires_at: Instant::now() + ttl.saturating_sub(REFRESH_MARGIN),
        });

        Some(result.access_token)
    }
}

/// Reduce GoPlus's flag map to a verdict.
///
/// A flag counts when it parses above zero, covering counts and booleans alike.
/// Absent and unparseable values MUST NOT count.
///
/// An empty `data_source` still allows: it is the normal case for an address no
/// provider has recorded.
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

    // Stable order, so one address yields one reason string.
    tripped.sort_unstable();

    (
        VERDICT_REFUSE,
        Some(format!(
            "Screening provider flagged this address: {}",
            tripped.join(", ")
        )),
    )
}

/// Separated for operators. All surface as "unavailable": an operator problem
/// MUST NOT be reported to the depositor as a screening failure.
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
        2018 => {
            AppError::KytUnavailable("Screening provider does not support this chain".to_string())
        }
        _ => AppError::KytUnavailable("Screening provider returned an error".to_string()),
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
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

    /// Captured live, so a wire-format change fails here.
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

    /// Solana reports `-1` for unknown; it MUST NOT read as a set flag.
    #[test]
    fn a_negative_value_is_not_a_flag() {
        let flags = HashMap::from([("contract_address".to_string(), "-1".to_string())]);
        assert_eq!(
            evaluate(&flags, &["contract_address".to_string()]).0,
            VERDICT_ALLOW
        );
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

    /// A count, not a boolean.
    #[test]
    fn a_count_flag_trips_above_zero() {
        let key = "number_of_malicious_contracts_created".to_string();
        assert_eq!(
            evaluate(&HashMap::from([(key.clone(), "0".to_string())]), &deny()).0,
            VERDICT_ALLOW
        );
        assert_eq!(
            evaluate(&HashMap::from([(key, "3".to_string())]), &deny()).0,
            VERDICT_REFUSE
        );
    }

    #[test]
    fn multiple_flags_are_reported_in_a_stable_order() {
        let flags = HashMap::from([
            ("mixer".to_string(), "1".to_string()),
            ("sanctioned".to_string(), "1".to_string()),
            ("cybercrime".to_string(), "1".to_string()),
        ]);

        let first = evaluate(&flags, &deny()).1.expect("reason");
        assert_eq!(first, evaluate(&flags, &deny()).1.expect("reason"));
        assert!(first.contains("cybercrime, mixer, sanctioned"), "{first}");
    }

    #[test]
    fn unknown_and_unparseable_values_are_ignored() {
        let flags = HashMap::from([
            ("some_future_flag".to_string(), "1".to_string()),
            ("sanctioned".to_string(), String::new()),
            ("mixer".to_string(), "not a number".to_string()),
        ]);

        assert_eq!(evaluate(&flags, &deny()).0, VERDICT_ALLOW);
    }

    #[test]
    fn an_empty_data_source_still_allows() {
        let flags = HashMap::from([
            ("data_source".to_string(), String::new()),
            ("sanctioned".to_string(), "0".to_string()),
        ]);

        assert_eq!(evaluate(&flags, &deny()).0, VERDICT_ALLOW);
    }

    #[test]
    fn documented_error_codes_are_unavailable_not_refusals() {
        for code in [4029, 4012, 4010, 2018, 5000] {
            assert!(matches!(
                classify_error(code, Some("x")),
                AppError::KytUnavailable(_)
            ));
        }
    }

    /// A wrong digest or field order fails as an opaque 4010.
    #[test]
    fn sign_is_sha1_of_key_time_secret() {
        assert_eq!(
            hex(&Sha1::digest(b"abc")),
            "a9993e364706816aba3e25717850c26c9cd0d89d"
        );
        assert_eq!(
            hex(&Sha1::digest(
                format!("{}{}{}", "key", 1_700_000_000u64, "secret").as_bytes()
            )),
            hex(&Sha1::digest(b"key1700000000secret"))
        );
    }

    #[test]
    fn parses_the_token_response_shape() {
        let envelope: TokenEnvelope = serde_json::from_str(
            r#"{"code":1,"message":"ok","result":{"access_token":"Bearer eyJ.a.b","expires_in":7200}}"#,
        )
        .expect("token shape");

        let result = envelope.result.expect("result");
        assert!(result.access_token.starts_with("Bearer "));
        assert_eq!(result.expires_in, Some(7200));
    }
}

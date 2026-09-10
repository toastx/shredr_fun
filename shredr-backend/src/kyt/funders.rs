//! Who funded a burner, read from the chain.
//!
//! Resolved here rather than taken from the request: the client asking to be
//! screened is the party with a reason to name a cleaner address than the one
//! that actually paid. The request carries only the burner, whose funding
//! history is chain record.
//!
//! Sees one hop — funds moving exchange to personal wallet to burner surface the
//! personal wallet, and the screening provider traces upstream from there.

use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::time::Duration;

use crate::error::AppError;

const DEFAULT_TIMEOUT_SECS: u64 = 10;

/// Signatures to walk back from the burner. A one-time burner has one funding
/// transfer and a handful of transactions at most; this is a bound on pathology,
/// not a paging window.
const DEFAULT_SIGNATURE_LIMIT: usize = 20;

#[derive(Clone)]
pub struct FunderResolver {
    http: reqwest::Client,
    rpc_url: String,
    signature_limit: usize,
}

#[derive(Deserialize)]
struct RpcResponse {
    #[serde(default)]
    result: Option<Value>,
    #[serde(default)]
    error: Option<RpcError>,
}

#[derive(Deserialize)]
struct RpcError {
    code: i64,
    message: String,
}

impl FunderResolver {
    /// `None` when `KYT_RPC_URL` is unset, which the caller turns into a 503.
    ///
    /// Its own URL rather than the Helius client in `main.rs`, which is pinned to
    /// mainnet-beta: resolving a devnet deposit against mainnet finds no funding
    /// transfer and would refuse every deposit on the wrong cluster.
    pub fn from_env() -> Option<Self> {
        let rpc_url = std::env::var("KYT_RPC_URL")
            .ok()
            .map(|url| url.trim().to_string())
            .filter(|url| !url.is_empty())?;

        let timeout_secs = std::env::var("KYT_RPC_TIMEOUT_SECS")
            .ok()
            .and_then(|value| value.parse().ok())
            .unwrap_or(DEFAULT_TIMEOUT_SECS);

        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(timeout_secs))
            .build()
            .map_err(|err| tracing::error!("could not build the KYT RPC client: {err}"))
            .ok()?;

        Some(Self {
            http,
            rpc_url,
            signature_limit: std::env::var("KYT_RPC_SIGNATURE_LIMIT")
                .ok()
                .and_then(|value| value.parse().ok())
                .unwrap_or(DEFAULT_SIGNATURE_LIMIT),
        })
    }

    /// Resolve everything that funded `burner`, most-funding first.
    ///
    /// Errors are [`AppError::KytUnavailable`] rather than refusals throughout.
    /// Not being able to work out who paid is a transient state — most often a
    /// funding transfer that has not confirmed yet — and the client should retry
    /// rather than tell someone they failed screening.
    pub async fn resolve(&self, burner: &str) -> Result<Vec<String>, AppError> {
        let signatures = self.signatures_for(burner).await?;

        if signatures.is_empty() {
            return Err(AppError::KytUnavailable(
                "Burner has no on-chain history — its funding transfer may not have confirmed yet"
                    .to_string(),
            ));
        }

        // Summed per source: the largest funder is the one bound into the
        // attestation, so several small transfers must not outrank one big one.
        let mut contributed: HashMap<String, u128> = HashMap::new();
        for signature in signatures {
            let Some(transaction) = self.transaction(&signature).await? else {
                continue;
            };
            collect_transfers(&transaction, burner, &mut contributed);
        }

        if contributed.is_empty() {
            return Err(AppError::KytUnavailable(
                "Could not identify who funded the burner from its transaction history".to_string(),
            ));
        }

        let mut funders: Vec<(String, u128)> = contributed.into_iter().collect();
        // Ties broken by address, so a retry binds the same funder.
        funders.sort_by(|(a_addr, a_sum), (b_addr, b_sum)| {
            b_sum.cmp(a_sum).then_with(|| a_addr.cmp(b_addr))
        });

        Ok(funders.into_iter().map(|(address, _)| address).collect())
    }

    async fn signatures_for(&self, burner: &str) -> Result<Vec<String>, AppError> {
        let result = self
            .call(
                "getSignaturesForAddress",
                json!([burner, { "limit": self.signature_limit }]),
            )
            .await?;

        Ok(result
            .as_array()
            .map(|entries| {
                entries
                    .iter()
                    .filter_map(|entry| entry.get("signature")?.as_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default())
    }

    async fn transaction(&self, signature: &str) -> Result<Option<Value>, AppError> {
        let result = self
            .call(
                "getTransaction",
                json!([
                    signature,
                    { "encoding": "jsonParsed", "maxSupportedTransactionVersion": 0 }
                ]),
            )
            .await?;

        // A dropped or pruned transaction is null rather than an error.
        Ok(if result.is_null() { None } else { Some(result) })
    }

    /// One JSON-RPC round trip. Errors are logged without the burner or any
    /// signature — a line pairing a depositor with a burner is the correlation
    /// this whole design exists to prevent.
    async fn call(&self, method: &str, params: Value) -> Result<Value, AppError> {
        let response = self
            .http
            .post(&self.rpc_url)
            .json(&json!({ "jsonrpc": "2.0", "id": 1, "method": method, "params": params }))
            .send()
            .await
            .map_err(|err| {
                tracing::error!("KYT RPC {method} failed: {err}");
                AppError::KytUnavailable("Could not reach the RPC node".to_string())
            })?;

        if !response.status().is_success() {
            tracing::error!("KYT RPC {method} returned HTTP {}", response.status());
            return Err(AppError::KytUnavailable(
                "RPC node returned an error".to_string(),
            ));
        }

        let body: RpcResponse = response.json().await.map_err(|err| {
            tracing::error!("could not parse the KYT RPC {method} response: {err}");
            AppError::KytUnavailable("RPC node returned an unreadable response".to_string())
        })?;

        if let Some(RpcError { code, message }) = body.error {
            tracing::error!("KYT RPC {method} returned error {code}: {message}");
            return Err(AppError::KytUnavailable(
                "RPC node rejected the request".to_string(),
            ));
        }

        body.result.ok_or_else(|| {
            tracing::error!("KYT RPC {method} returned neither a result nor an error");
            AppError::KytUnavailable("RPC node returned an empty response".to_string())
        })
    }
}

/// Add every System-program transfer into `burner` from one transaction.
///
/// Inner instructions are walked alongside the outer ones: a transfer made by
/// CPI moves exactly as much value as a top-level one, and a funder that routed
/// through a program would otherwise be invisible here.
fn collect_transfers(transaction: &Value, burner: &str, contributed: &mut HashMap<String, u128>) {
    // A failed transaction moved nothing, so it says nothing about provenance.
    if !transaction
        .pointer("/meta/err")
        .map(Value::is_null)
        .unwrap_or(true)
    {
        return;
    }

    let outer = transaction
        .pointer("/transaction/message/instructions")
        .and_then(Value::as_array);

    let inner = transaction
        .pointer("/meta/innerInstructions")
        .and_then(Value::as_array);

    let mut instructions: Vec<&Value> = outer.map(|list| list.iter().collect()).unwrap_or_default();
    if let Some(groups) = inner {
        for group in groups {
            if let Some(list) = group.get("instructions").and_then(Value::as_array) {
                instructions.extend(list.iter());
            }
        }
    }

    for instruction in instructions {
        let Some(parsed) = instruction.get("parsed") else {
            continue;
        };

        match parsed.get("type").and_then(Value::as_str) {
            Some("transfer") | Some("transferWithSeed") => {}
            _ => continue,
        }

        let Some(info) = parsed.get("info") else {
            continue;
        };

        if info.get("destination").and_then(Value::as_str) != Some(burner) {
            continue;
        }

        let Some(source) = info.get("source").and_then(Value::as_str) else {
            continue;
        };

        // A burner paying itself is not funding.
        if source == burner {
            continue;
        }

        let lamports = info.get("lamports").and_then(Value::as_u64).unwrap_or(0);
        *contributed.entry(source.to_string()).or_insert(0) += u128::from(lamports);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const BURNER: &str = "BurnerAddress11111111111111111111111111111";
    const ALICE: &str = "Alice1111111111111111111111111111111111111";
    const BOB: &str = "Bob111111111111111111111111111111111111111";

    fn transfer(source: &str, destination: &str, lamports: u64) -> Value {
        json!({
            "program": "system",
            "parsed": {
                "type": "transfer",
                "info": { "source": source, "destination": destination, "lamports": lamports }
            }
        })
    }

    fn transaction(instructions: Vec<Value>, err: Value) -> Value {
        json!({
            "meta": { "err": err, "innerInstructions": [] },
            "transaction": { "message": { "instructions": instructions } }
        })
    }

    fn collect(transactions: Vec<Value>) -> Vec<(String, u128)> {
        let mut contributed = HashMap::new();
        for tx in &transactions {
            collect_transfers(tx, BURNER, &mut contributed);
        }
        let mut funders: Vec<(String, u128)> = contributed.into_iter().collect();
        funders.sort_by(|(a_addr, a), (b_addr, b)| b.cmp(a).then_with(|| a_addr.cmp(b_addr)));
        funders
    }

    #[test]
    fn reads_the_funder_out_of_a_transfer() {
        let funders = collect(vec![transaction(
            vec![transfer(ALICE, BURNER, 5_000_000)],
            Value::Null,
        )]);

        assert_eq!(funders, vec![(ALICE.to_string(), 5_000_000)]);
    }

    /// `funders[0]` is what gets bound into the attestation, so the ordering is
    /// part of the contract rather than a convenience.
    #[test]
    fn sums_per_source_and_orders_by_total() {
        let funders = collect(vec![
            transaction(vec![transfer(ALICE, BURNER, 1_000)], Value::Null),
            transaction(vec![transfer(BOB, BURNER, 9_000)], Value::Null),
            // Alice paying twice is one funder with a total, which is what puts
            // her back in front of Bob.
            transaction(vec![transfer(ALICE, BURNER, 50_000)], Value::Null),
        ]);

        assert_eq!(
            funders,
            vec![(ALICE.to_string(), 51_000), (BOB.to_string(), 9_000)]
        );
    }

    #[test]
    fn ignores_failed_transactions() {
        let funders = collect(vec![transaction(
            vec![transfer(ALICE, BURNER, 5_000_000)],
            json!({ "InstructionError": [0, "Custom"] }),
        )]);

        assert!(funders.is_empty());
    }

    #[test]
    fn ignores_transfers_aimed_elsewhere_and_at_the_burner_itself() {
        let funders = collect(vec![transaction(
            vec![
                transfer(BOB, ALICE, 9_000),
                transfer(BURNER, ALICE, 9_000),
                transfer(ALICE, BURNER, 1_000),
            ],
            Value::Null,
        )]);

        assert_eq!(funders, vec![(ALICE.to_string(), 1_000)]);
    }

    /// A funder that routed through a program moves exactly as much value as one
    /// that did not, so CPI transfers count.
    #[test]
    fn counts_transfers_made_by_cpi() {
        let funders = collect(vec![json!({
            "meta": {
                "err": null,
                "innerInstructions": [
                    { "index": 0, "instructions": [transfer(BOB, BURNER, 7_000)] }
                ]
            },
            "transaction": { "message": { "instructions": [] } }
        })]);

        assert_eq!(funders, vec![(BOB.to_string(), 7_000)]);
    }

    /// Two funders of equal size must not swap places between retries — the
    /// bound address has to be stable for the same burner.
    #[test]
    fn breaks_ties_deterministically() {
        let first = collect(vec![transaction(
            vec![transfer(BOB, BURNER, 1_000), transfer(ALICE, BURNER, 1_000)],
            Value::Null,
        )]);
        let second = collect(vec![transaction(
            vec![transfer(ALICE, BURNER, 1_000), transfer(BOB, BURNER, 1_000)],
            Value::Null,
        )]);

        assert_eq!(first, second);
        assert_eq!(first[0].0, ALICE.to_string());
    }
}

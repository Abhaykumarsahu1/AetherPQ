//! scanner-core: pure exposure-detection and risk-scoring logic.

use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct WalletFacts {
    pub nonce: u64,
    pub balance_eth: f64,
    pub days_since_first_exposure: Option<u64>,
    pub recent_tx_count: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ExposureStatus {
    Safe,
    Exposed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RiskReport {
    pub status: ExposureStatus,
    pub balance_eth: f64,
    pub risk_score: f64,
    pub risk_percent: f64,
    pub pct_balance: f64,
    pub pct_age: f64,
    pub pct_activity: f64,
    pub recommendation: String,
}

pub struct RiskWeights {
    pub balance: f64,
    pub exposure_age: f64,
    pub activity: f64,
}

impl Default for RiskWeights {
    fn default() -> Self {
        Self {
            balance: 0.5,
            exposure_age: 0.3,
            activity: 0.2,
        }
    }
}

fn normalize(value: f64, soft_cap: f64) -> f64 {
    let ratio = value / soft_cap;
    (10.0 * (ratio / (1.0 + ratio))).clamp(0.0, 10.0)
}

pub fn assess(facts: WalletFacts, weights: &RiskWeights) -> RiskReport {
    let status = if facts.nonce > 0 {
        ExposureStatus::Exposed
    } else {
        ExposureStatus::Safe
    };

    if status == ExposureStatus::Safe {
        return RiskReport {
            status,
            balance_eth: facts.balance_eth,
            risk_score: 0.0,
            risk_percent: 0.0,
            pct_balance: 0.0,
            pct_age: 0.0,
            pct_activity: 0.0,
            recommendation: "No outgoing transactions detected. Public key not yet exposed on-chain.".to_string(),
        };
    }

    let balance_component = normalize(facts.balance_eth, 5.0);
    let age_component = normalize(facts.days_since_first_exposure.unwrap_or(0) as f64, 365.0);
    let activity_component = normalize(facts.recent_tx_count as f64, 20.0);

    let w_balance = weights.balance * balance_component;
    let w_age = weights.exposure_age * age_component;
    let w_activity = weights.activity * activity_component;

    let risk_score = w_balance + w_age + w_activity;

    let recommendation = if risk_score >= 6.0 {
        "High risk: migrate to a hybrid-protected smart wallet as soon as practical."
    } else if risk_score >= 3.0 {
        "Moderate risk: consider migrating, especially if balance grows."
    } else {
        "Low risk for now, but the exposure is permanent. Migration recommended when convenient."
    };

    RiskReport {
        status,
        balance_eth: facts.balance_eth,
        risk_score: (risk_score * 10.0).round() / 10.0,
        risk_percent: (risk_score / 10.0) * 100.0,
        pct_balance: (w_balance / 10.0) * 100.0,
        pct_age: (w_age / 10.0) * 100.0,
        pct_activity: (w_activity / 10.0) * 100.0,
        recommendation: recommendation.to_string(),
    }
}

/// WebAssembly entry point. Accepts a JavaScript object and returns a serialized RiskReport.
#[wasm_bindgen]
pub fn assess_wallet(input: JsValue) -> Result<JsValue, JsValue> {
    let facts: WalletFacts = serde_wasm_bindgen::from_value(input)
        .map_err(|e| JsValue::from_str(&format!("Deserialization error: {}", e)))?;
        
    let report = assess(facts, &RiskWeights::default());
    
    serde_wasm_bindgen::to_value(&report)
        .map_err(|e| JsValue::from_str(&format!("Serialization error: {}", e)))
}
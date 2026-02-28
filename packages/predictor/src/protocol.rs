use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Deserialize)]
pub struct JsonRpcRequest {
    pub jsonrpc: String,
    pub id: Value,
    pub method: String,
    #[serde(default)]
    pub params: Value,
}

#[derive(Debug, Serialize)]
pub struct JsonRpcResponse<T>
where
    T: Serialize,
{
    pub jsonrpc: &'static str,
    pub id: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<T>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<JsonRpcError>,
}

#[derive(Debug, Serialize)]
pub struct JsonRpcError {
    pub code: i32,
    pub message: String,
}

impl<T> JsonRpcResponse<T>
where
    T: Serialize,
{
    pub fn success(id: Value, result: T) -> Self {
        Self {
            jsonrpc: "2.0",
            id,
            result: Some(result),
            error: None,
        }
    }

    pub fn failure(id: Value, code: i32, message: impl Into<String>) -> Self {
        Self {
            jsonrpc: "2.0",
            id,
            result: None,
            error: Some(JsonRpcError {
                code,
                message: message.into(),
            }),
        }
    }
}

#[derive(Debug, Deserialize)]
pub struct ScoreParams {
    pub context_embedding: Vec<f64>,
    pub candidate_ids: Vec<String>,
    #[serde(default)]
    pub candidate_embeddings: Vec<Vec<f64>>,
    #[serde(default)]
    pub candidate_texts: Vec<Option<String>>,
    #[serde(default)]
    pub candidate_features: Vec<Vec<f64>>,
    #[serde(default)]
    pub project_slot: usize,
}

#[derive(Debug, Serialize)]
pub struct ScoredMemory {
    pub id: String,
    pub score: f64,
}

#[derive(Debug, Serialize)]
pub struct ScoreResult {
    pub scores: Vec<ScoredMemory>,
}

#[derive(Debug, Deserialize)]
pub struct TrainParams {
    pub context_embedding: Vec<f64>,
    pub candidate_embeddings: Vec<Vec<f64>>,
    #[serde(default)]
    pub candidate_features: Vec<Vec<f64>>,
    pub labels: Vec<f64>,
    #[serde(default)]
    pub project_slot: usize,
    #[serde(default = "default_temperature")]
    pub temperature: f64,
}

const fn default_temperature() -> f64 {
    0.5
}

#[derive(Debug, Serialize)]
pub struct TrainResult {
    pub loss: f64,
    pub step: u64,
}

#[derive(Debug, Serialize)]
pub struct StatusResult {
    pub trained: bool,
    pub training_pairs: usize,
    pub model_version: u64,
    pub last_trained: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct TrainFromDbParams {
    pub db_path: String,
    pub checkpoint_path: Option<String>,
    pub limit: usize,
    pub epochs: usize,
    #[serde(default = "default_temperature")]
    pub temperature: f64,
    #[serde(default = "default_min_confidence")]
    pub min_confidence: f64,
}

fn default_min_confidence() -> f64 {
    0.6
}

#[derive(Debug, Serialize)]
pub struct TrainFromDbResult {
    pub loss: f64,
    pub step: u64,
    pub samples_used: usize,
    pub samples_skipped: usize,
    pub duration_ms: u64,
    pub canary_score_variance: f64,
    pub canary_topk_stability: f64,
    pub checkpoint_saved: bool,
}

#[derive(Debug, Deserialize)]
pub struct SaveCheckpointParams {
    pub path: String,
    #[serde(default)]
    pub flags: u32,
}

#[derive(Debug, Serialize)]
pub struct SaveCheckpointResult {
    pub saved: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_score_params_with_optional_features() {
        let payload = serde_json::json!({
            "context_embedding": [0.1, 0.2],
            "candidate_ids": ["m1"],
            "candidate_embeddings": [[0.3, 0.4]]
        });
        let parsed: ScoreParams = serde_json::from_value(payload).expect("parse");
        assert!(parsed.candidate_features.is_empty());
        assert!(parsed.candidate_texts.is_empty());
        assert_eq!(parsed.project_slot, 0);
    }
}

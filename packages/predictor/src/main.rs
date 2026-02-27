use std::io::{self, BufRead, Write};

use predictor::{
    autograd::{Rng, Tape},
    data::TrainingSample,
    model::{CandidateInput, CrossAttentionScorer, ScorerConfig},
    protocol::{
        JsonRpcRequest, JsonRpcResponse, ScoreParams, ScoreResult, ScoredMemory, StatusResult,
        TrainParams, TrainResult,
    },
    training::{train_batch, Adam},
};

struct PredictorService {
    tape: Tape,
    model: CrossAttentionScorer,
    optimizer: Adam,
    model_version: u64,
    train_steps: u64,
    training_pairs: usize,
    last_trained: Option<String>,
}

impl PredictorService {
    fn new() -> Self {
        let mut tape = Tape::new();
        let mut rng = Rng::new(0x51_9e7);
        let model = CrossAttentionScorer::new(&mut tape, &mut rng, ScorerConfig::default());
        let optimizer = Adam::new(&tape, 1e-3);
        Self {
            tape,
            model,
            optimizer,
            model_version: 1,
            train_steps: 0,
            training_pairs: 0,
            last_trained: None,
        }
    }

    fn status(&self) -> StatusResult {
        StatusResult {
            trained: self.train_steps > 0,
            training_pairs: self.training_pairs,
            model_version: self.model_version,
            last_trained: self.last_trained.clone(),
        }
    }

    fn score(&mut self, params: ScoreParams) -> Result<ScoreResult, String> {
        let ScoreParams {
            context_embedding,
            candidate_ids,
            candidate_embeddings,
            candidate_texts,
            candidate_features,
            project_slot,
        } = params;

        if !candidate_embeddings.is_empty() && candidate_ids.len() != candidate_embeddings.len() {
            return Err("candidate_ids and candidate_embeddings length mismatch".to_string());
        }
        if !candidate_texts.is_empty() && candidate_ids.len() != candidate_texts.len() {
            return Err("candidate_ids and candidate_texts length mismatch".to_string());
        }

        let cfg = self.model.config();
        let embeddings = if candidate_embeddings.is_empty() {
            vec![Vec::new(); candidate_ids.len()]
        } else {
            candidate_embeddings
        };
        let texts = if candidate_texts.is_empty() {
            vec![None; candidate_ids.len()]
        } else {
            candidate_texts
        };

        let features = if candidate_features.is_empty() {
            vec![vec![0.0; cfg.extra_features]; candidate_ids.len()]
        } else if candidate_features.len() == candidate_ids.len() {
            candidate_features
        } else {
            return Err("candidate_ids and candidate_features length mismatch".to_string());
        };
        if features.iter().any(|f| f.len() != cfg.extra_features) {
            return Err("candidate_features row has invalid dimension".to_string());
        }

        let candidates = candidate_ids
            .iter()
            .zip(embeddings.iter())
            .zip(texts.iter())
            .zip(features.iter())
            .map(|(((id, embedding), text), feature)| CandidateInput {
                id,
                embedding: if embedding.len() == cfg.native_dim {
                    Some(embedding.as_slice())
                } else {
                    None
                },
                text: text.as_deref(),
                features: feature,
            })
            .collect::<Vec<_>>();

        let scored = self.model.score(
            &mut self.tape,
            &context_embedding,
            &candidates,
            project_slot,
        )?;

        Ok(ScoreResult {
            scores: scored
                .into_iter()
                .map(|entry| ScoredMemory {
                    id: entry.id,
                    score: entry.score,
                })
                .collect(),
        })
    }

    fn train(&mut self, params: TrainParams) -> Result<TrainResult, String> {
        let TrainParams {
            context_embedding,
            candidate_embeddings,
            candidate_features,
            labels,
            project_slot,
            temperature,
        } = params;

        if candidate_embeddings.len() != labels.len() {
            return Err("candidate_embeddings and labels length mismatch".to_string());
        }
        if !temperature.is_finite() || temperature <= 0.0 {
            return Err("temperature must be > 0".to_string());
        }

        let label_count = labels.len();
        let sample = TrainingSample {
            session_id: "rpc-train".to_string(),
            query_embedding: context_embedding,
            candidate_embeddings,
            candidate_features,
            project_slot,
            labels,
        };
        let stats = train_batch(
            &mut self.tape,
            &self.model,
            &[sample],
            &mut self.optimizer,
            temperature,
        )
        .map_err(|err| format!("train error: {err:?}"))?;

        self.train_steps += stats.steps;
        self.training_pairs += label_count;
        if stats.steps > 0 {
            self.model_version += 1;
            self.last_trained = Some(chrono_like_now());
        }

        Ok(TrainResult {
            loss: stats.loss,
            step: self.train_steps,
        })
    }
}

fn main() {
    let mut service = PredictorService::new();
    let stdin = io::stdin();
    let mut stdout = io::stdout();

    for line in stdin.lock().lines() {
        let raw = match line {
            Ok(raw) => raw,
            Err(err) => {
                let fallback = JsonRpcResponse::<serde_json::Value>::failure(
                    serde_json::Value::Null,
                    -32603,
                    format!("stdin read error: {err}"),
                );
                write_response(&mut stdout, &fallback);
                continue;
            }
        };

        if raw.trim().is_empty() {
            continue;
        }

        let req = match serde_json::from_str::<JsonRpcRequest>(&raw) {
            Ok(req) => req,
            Err(err) => {
                let response = JsonRpcResponse::<serde_json::Value>::failure(
                    serde_json::Value::Null,
                    -32700,
                    format!("invalid JSON: {err}"),
                );
                write_response(&mut stdout, &response);
                continue;
            }
        };

        if req.jsonrpc != "2.0" {
            let response = JsonRpcResponse::<serde_json::Value>::failure(
                req.id,
                -32600,
                "jsonrpc must be '2.0'",
            );
            write_response(&mut stdout, &response);
            continue;
        }

        match req.method.as_str() {
            "status" => {
                let response = JsonRpcResponse::success(req.id, service.status());
                write_response(&mut stdout, &response);
            }
            "score" => {
                let params = serde_json::from_value::<ScoreParams>(req.params);
                match params {
                    Ok(params) => match service.score(params) {
                        Ok(result) => {
                            let response = JsonRpcResponse::success(req.id, result);
                            write_response(&mut stdout, &response);
                        }
                        Err(message) => {
                            let response = JsonRpcResponse::<serde_json::Value>::failure(
                                req.id, -32000, message,
                            );
                            write_response(&mut stdout, &response);
                        }
                    },
                    Err(err) => {
                        let response = JsonRpcResponse::<serde_json::Value>::failure(
                            req.id,
                            -32602,
                            format!("invalid params: {err}"),
                        );
                        write_response(&mut stdout, &response);
                    }
                }
            }
            "train" => {
                let params = serde_json::from_value::<TrainParams>(req.params);
                match params {
                    Ok(params) => match service.train(params) {
                        Ok(result) => {
                            let response = JsonRpcResponse::success(req.id, result);
                            write_response(&mut stdout, &response);
                        }
                        Err(message) => {
                            let response = JsonRpcResponse::<serde_json::Value>::failure(
                                req.id, -32000, message,
                            );
                            write_response(&mut stdout, &response);
                        }
                    },
                    Err(err) => {
                        let response = JsonRpcResponse::<serde_json::Value>::failure(
                            req.id,
                            -32602,
                            format!("invalid params: {err}"),
                        );
                        write_response(&mut stdout, &response);
                    }
                }
            }
            _ => {
                let response = JsonRpcResponse::<serde_json::Value>::failure(
                    req.id,
                    -32601,
                    "method not found",
                );
                write_response(&mut stdout, &response);
            }
        }
    }
}

fn write_response<T: serde::Serialize>(stdout: &mut io::Stdout, response: &JsonRpcResponse<T>) {
    match serde_json::to_string(response) {
        Ok(json) => {
            let _ = writeln!(stdout, "{json}");
            let _ = stdout.flush();
        }
        Err(err) => {
            let fallback = format!(
                "{{\"jsonrpc\":\"2.0\",\"id\":null,\"error\":{{\"code\":-32603,\"message\":\"response serialization error: {err}\"}}}}"
            );
            let _ = writeln!(stdout, "{fallback}");
            let _ = stdout.flush();
        }
    }
}

fn chrono_like_now() -> String {
    // Keep dependencies minimal in phase 1. We only need a sortable timestamp.
    // RFC3339 formatting can be upgraded in phase 2 when training metadata lands.
    format!(
        "{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0)
    )
}

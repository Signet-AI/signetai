use std::io::{self, BufRead, Write};

use predictor::{
    autograd::{Rng, Tape},
    checkpoint,
    data::{self, DataConfig, TrainingSample},
    model::{CandidateInput, CrossAttentionScorer, ScorerConfig},
    protocol::{
        JsonRpcRequest, JsonRpcResponse, SaveCheckpointParams, SaveCheckpointResult, ScoreParams,
        ScoreResult, ScoredMemory, StatusResult, TrainFromDbParams, TrainFromDbResult, TrainParams,
        TrainResult,
    },
    training::{self, train_batch, train_epochs, Adam},
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
            candidate_texts: vec![],
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
            self.last_trained = Some(format_timestamp());
        }

        Ok(TrainResult {
            loss: stats.loss,
            step: self.train_steps,
        })
    }

    fn train_from_db(&mut self, params: TrainFromDbParams) -> Result<TrainFromDbResult, String> {
        if !params.temperature.is_finite() || params.temperature <= 0.0 {
            return Err("temperature must be > 0".to_string());
        }

        let start = std::time::Instant::now();

        let db_path = std::path::Path::new(&params.db_path);
        let config = DataConfig {
            min_scorer_confidence: params.min_confidence,
            loss_temperature: params.temperature,
            native_dim: self.model.config().native_dim,
        };

        let load_result = data::load_training_samples(db_path, params.limit, &config)
            .map_err(|e| format!("data load error: {e:?}"))?;

        if load_result.samples.is_empty() {
            return Ok(TrainFromDbResult {
                loss: 0.0,
                step: self.train_steps,
                samples_used: 0,
                samples_skipped: load_result.sessions_skipped,
                duration_ms: start.elapsed().as_millis() as u64,
                canary_score_variance: 0.0,
                canary_topk_stability: 1.0,
                checkpoint_saved: false,
            });
        }

        // Split into canary and training sets
        let total = load_result.samples.len();
        let (canary_samples, train_samples) = if total <= 10 {
            (load_result.samples.clone(), load_result.samples)
        } else {
            let (canary, rest) = load_result.samples.split_at(10);
            (canary.to_vec(), rest.to_vec())
        };

        // Record pre-training top-5
        let pre_top5 = training::record_top5(&mut self.tape, &self.model, &canary_samples);

        // Train
        let stats = train_epochs(
            &mut self.tape,
            &self.model,
            &train_samples,
            &mut self.optimizer,
            params.epochs,
            params.temperature,
        )
        .map_err(|e| format!("training error: {e:?}"))?;

        // Evaluate canary
        let canary =
            training::evaluate_canary(&mut self.tape, &self.model, &canary_samples, &pre_top5);

        // Validate results
        let valid =
            stats.loss.is_finite() && canary.score_variance > 0.0 && canary.topk_stability >= 0.6;

        // Auto-save checkpoint if valid
        let checkpoint_saved = if valid {
            if let Some(ref ckpt_path) = params.checkpoint_path {
                let path = std::path::Path::new(ckpt_path);
                match checkpoint::save(path, &self.model, &self.tape, 0) {
                    Ok(()) => true,
                    Err(e) => {
                        eprintln!("[predictor] checkpoint save failed: {e:?}");
                        false
                    }
                }
            } else {
                false
            }
        } else {
            false
        };

        // Update service state
        let trained_count = train_samples.len();
        self.train_steps += stats.steps;
        self.training_pairs += trained_count;
        if stats.steps > 0 {
            self.model_version += 1;
            self.last_trained = Some(format_timestamp());
        }

        Ok(TrainFromDbResult {
            loss: stats.loss,
            step: self.train_steps,
            samples_used: trained_count,
            samples_skipped: load_result.sessions_skipped,
            duration_ms: start.elapsed().as_millis() as u64,
            canary_score_variance: canary.score_variance,
            canary_topk_stability: canary.topk_stability,
            checkpoint_saved,
        })
    }

    fn save_checkpoint(
        &self,
        params: SaveCheckpointParams,
    ) -> Result<SaveCheckpointResult, String> {
        let path = std::path::Path::new(&params.path);
        checkpoint::save(path, &self.model, &self.tape, params.flags)
            .map_err(|e| format!("checkpoint save error: {e:?}"))?;
        Ok(SaveCheckpointResult { saved: true })
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let checkpoint_path = find_arg(&args, "--checkpoint");

    let mut service = PredictorService::new();

    if let Some(ref path) = checkpoint_path {
        let p = std::path::Path::new(path);
        if p.exists() {
            match checkpoint::load(p) {
                Ok(loaded) => {
                    match checkpoint::apply_checkpoint(&loaded, &service.model, &mut service.tape) {
                        Ok(()) => {
                            service.model_version = loaded.version as u64;
                            eprintln!("[predictor] loaded checkpoint v{}", loaded.version);
                        }
                        Err(e) => eprintln!("[predictor] checkpoint apply failed: {e:?}"),
                    }
                }
                Err(e) => eprintln!("[predictor] checkpoint load failed: {e:?}"),
            }
        }
    }

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
                handle_rpc(&mut stdout, req.id, req.params, |p| service.score(p));
            }
            "train" => {
                handle_rpc(&mut stdout, req.id, req.params, |p| service.train(p));
            }
            "train_from_db" => {
                handle_rpc(&mut stdout, req.id, req.params, |p| {
                    service.train_from_db(p)
                });
            }
            "save_checkpoint" => {
                handle_rpc(&mut stdout, req.id, req.params, |p| {
                    service.save_checkpoint(p)
                });
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

fn handle_rpc<P, R, F>(
    stdout: &mut io::Stdout,
    id: serde_json::Value,
    params: serde_json::Value,
    handler: F,
) where
    P: serde::de::DeserializeOwned,
    R: serde::Serialize,
    F: FnOnce(P) -> Result<R, String>,
{
    match serde_json::from_value::<P>(params) {
        Ok(parsed) => match handler(parsed) {
            Ok(result) => {
                let response = JsonRpcResponse::success(id, result);
                write_response(stdout, &response);
            }
            Err(message) => {
                let response = JsonRpcResponse::<serde_json::Value>::failure(id, -32000, message);
                write_response(stdout, &response);
            }
        },
        Err(err) => {
            let response = JsonRpcResponse::<serde_json::Value>::failure(
                id,
                -32602,
                format!("invalid params: {err}"),
            );
            write_response(stdout, &response);
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

fn find_arg(args: &[String], flag: &str) -> Option<String> {
    args.iter()
        .position(|a| a == flag)
        .and_then(|i| args.get(i + 1).cloned())
}

fn format_timestamp() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let days = (secs / 86400) as i64;
    let time_of_day = secs % 86400;
    let hours = time_of_day / 3600;
    let minutes = (time_of_day % 3600) / 60;
    let seconds = time_of_day % 60;
    let (year, month, day) = civil_from_days(days);
    format!("{year:04}-{month:02}-{day:02}T{hours:02}:{minutes:02}:{seconds:02}Z")
}

fn civil_from_days(days: i64) -> (i32, u32, u32) {
    let z = days + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = (z - era * 146097) as u32;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    (y as i32, m, d)
}

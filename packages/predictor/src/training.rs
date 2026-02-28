use crate::{
    autograd::Tape,
    data::TrainingSample,
    model::{CandidateInput, CrossAttentionScorer},
};

#[derive(Debug, Clone)]
pub struct TrainingStats {
    pub loss: f64,
    pub steps: u64,
    pub samples: usize,
}

#[derive(Debug)]
pub enum TrainingError {
    InvalidSample(String),
    Model(String),
}

#[derive(Debug)]
pub struct Adam {
    lr: f64,
    beta1: f64,
    beta2: f64,
    eps: f64,
    t: u64,
    m: Vec<Vec<f64>>,
    v: Vec<Vec<f64>>,
}

impl Adam {
    pub fn new(tape: &Tape, lr: f64) -> Self {
        let m = tape
            .params()
            .iter()
            .map(|p| vec![0.0; p.data.len()])
            .collect();
        let v = tape
            .params()
            .iter()
            .map(|p| vec![0.0; p.data.len()])
            .collect();
        Self {
            lr,
            beta1: 0.9,
            beta2: 0.999,
            eps: 1e-8,
            t: 0,
            m,
            v,
        }
    }

    pub fn step(&mut self, tape: &mut Tape) {
        self.t += 1;
        let t = self.t as f64;
        for (param_idx, param) in tape.params_mut().iter_mut().enumerate() {
            for i in 0..param.data.len() {
                let grad = param.grad[i];
                self.m[param_idx][i] =
                    self.beta1 * self.m[param_idx][i] + (1.0 - self.beta1) * grad;
                self.v[param_idx][i] =
                    self.beta2 * self.v[param_idx][i] + (1.0 - self.beta2) * grad * grad;

                let m_hat = self.m[param_idx][i] / (1.0 - self.beta1.powf(t));
                let v_hat = self.v[param_idx][i] / (1.0 - self.beta2.powf(t));
                param.data[i] -= self.lr * m_hat / (v_hat.sqrt() + self.eps);
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Candidate construction helper
// ---------------------------------------------------------------------------

fn build_candidates_for_sample<'a>(
    sample: &'a TrainingSample,
    native_dim: usize,
    feature_storage: &'a [Vec<f64>],
) -> Vec<CandidateInput<'a>> {
    let has_texts = !sample.candidate_texts.is_empty();

    sample
        .candidate_embeddings
        .iter()
        .enumerate()
        .zip(feature_storage.iter())
        .map(|((i, embedding), features)| {
            let text = if has_texts {
                sample.candidate_texts[i].as_deref()
            } else {
                None
            };
            CandidateInput {
                id: "",
                embedding: if embedding.len() == native_dim {
                    Some(embedding.as_slice())
                } else {
                    None
                },
                text,
                features,
            }
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Training
// ---------------------------------------------------------------------------

pub fn train_batch(
    tape: &mut Tape,
    model: &CrossAttentionScorer,
    batch: &[TrainingSample],
    optimizer: &mut Adam,
    temperature: f64,
) -> Result<TrainingStats, TrainingError> {
    let mut total_loss = 0.0;
    let mut steps = 0;

    for sample in batch {
        if sample.candidate_embeddings.len() != sample.labels.len() {
            return Err(TrainingError::InvalidSample(format!(
                "sample {} has {} candidates but {} labels",
                sample.session_id,
                sample.candidate_embeddings.len(),
                sample.labels.len()
            )));
        }
        if sample.candidate_embeddings.is_empty() {
            continue;
        }

        let cfg = model.config();
        if sample.query_embedding.len() != cfg.native_dim {
            return Err(TrainingError::InvalidSample(format!(
                "sample {} query dim mismatch",
                sample.session_id
            )));
        }
        if !sample.candidate_features.is_empty()
            && sample.candidate_features.len() != sample.candidate_embeddings.len()
        {
            return Err(TrainingError::InvalidSample(format!(
                "sample {} has {} candidate embeddings but {} feature rows",
                sample.session_id,
                sample.candidate_embeddings.len(),
                sample.candidate_features.len()
            )));
        }

        let feature_storage = if sample.candidate_features.is_empty() {
            vec![vec![0.0; cfg.extra_features]; sample.candidate_embeddings.len()]
        } else {
            sample.candidate_features.clone()
        };

        if feature_storage
            .iter()
            .any(|features| features.len() != cfg.extra_features)
        {
            return Err(TrainingError::InvalidSample(format!(
                "sample {} contains invalid feature dimension",
                sample.session_id
            )));
        }

        let candidates = build_candidates_for_sample(sample, cfg.native_dim, &feature_storage);

        tape.reset();
        let logits = model
            .forward_logits(
                tape,
                &sample.query_embedding,
                &candidates,
                sample.project_slot,
            )
            .map_err(TrainingError::Model)?;
        let targets = tape.constant(sample.labels.clone());
        let loss = tape.listwise_loss(logits, targets, temperature);
        let loss_value = tape.scalar(loss);
        if !loss_value.is_finite() {
            continue;
        }

        tape.backward(loss);
        optimizer.step(tape);
        total_loss += loss_value;
        steps += 1;
    }

    let avg_loss = if steps == 0 {
        0.0
    } else {
        total_loss / steps as f64
    };

    Ok(TrainingStats {
        loss: avg_loss,
        steps,
        samples: batch.len(),
    })
}

// ---------------------------------------------------------------------------
// Multi-epoch training
// ---------------------------------------------------------------------------

pub fn train_epochs(
    tape: &mut Tape,
    model: &CrossAttentionScorer,
    samples: &[TrainingSample],
    optimizer: &mut Adam,
    epochs: usize,
    temperature: f64,
) -> Result<TrainingStats, TrainingError> {
    let mut total_loss = 0.0;
    let mut total_steps = 0u64;
    for _epoch in 0..epochs {
        let stats = train_batch(tape, model, samples, optimizer, temperature)?;
        total_loss = stats.loss; // last epoch's loss (intentional)
        total_steps += stats.steps;
        if stats.loss < 1e-6 && stats.steps > 0 {
            break;
        }
    }
    Ok(TrainingStats {
        loss: total_loss,
        steps: total_steps,
        samples: samples.len(),
    })
}

// ---------------------------------------------------------------------------
// Canary evaluation
// ---------------------------------------------------------------------------

pub struct CanaryMetrics {
    pub score_variance: f64,
    pub topk_stability: f64,
}

pub fn record_top5(
    tape: &mut Tape,
    model: &CrossAttentionScorer,
    samples: &[TrainingSample],
) -> Vec<Vec<usize>> {
    let cfg = model.config();
    let mut result = Vec::with_capacity(samples.len());

    for sample in samples {
        if sample.candidate_embeddings.is_empty() || sample.query_embedding.len() != cfg.native_dim
        {
            result.push(Vec::new());
            continue;
        }

        let feature_storage = if sample.candidate_features.is_empty() {
            vec![vec![0.0; cfg.extra_features]; sample.candidate_embeddings.len()]
        } else {
            sample.candidate_features.clone()
        };

        let candidates = build_candidates_for_sample(sample, cfg.native_dim, &feature_storage);

        tape.reset();
        match model.forward_logits(
            tape,
            &sample.query_embedding,
            &candidates,
            sample.project_slot,
        ) {
            Ok(logits) => {
                let probs_act = tape.softmax(logits);
                let scores = tape.value(probs_act).to_vec();
                let mut indices: Vec<usize> = (0..scores.len()).collect();
                indices.sort_by(|a, b| {
                    scores[*b]
                        .partial_cmp(&scores[*a])
                        .unwrap_or(std::cmp::Ordering::Equal)
                });
                indices.truncate(5);
                result.push(indices);
            }
            Err(_) => {
                result.push(Vec::new());
            }
        }
    }

    result
}

pub fn evaluate_canary(
    tape: &mut Tape,
    model: &CrossAttentionScorer,
    canary_samples: &[TrainingSample],
    pre_training_top5: &[Vec<usize>],
) -> CanaryMetrics {
    let cfg = model.config();
    let mut all_scores: Vec<f64> = Vec::new();
    let mut stability_sum = 0.0;
    let mut stability_count = 0usize;

    for (idx, sample) in canary_samples.iter().enumerate() {
        if sample.candidate_embeddings.is_empty() || sample.query_embedding.len() != cfg.native_dim
        {
            continue;
        }

        let feature_storage = if sample.candidate_features.is_empty() {
            vec![vec![0.0; cfg.extra_features]; sample.candidate_embeddings.len()]
        } else {
            sample.candidate_features.clone()
        };

        let candidates = build_candidates_for_sample(sample, cfg.native_dim, &feature_storage);

        tape.reset();
        if let Ok(logits) = model.forward_logits(
            tape,
            &sample.query_embedding,
            &candidates,
            sample.project_slot,
        ) {
            let probs_act = tape.softmax(logits);
            let scores = tape.value(probs_act).to_vec();
            all_scores.extend_from_slice(&scores);

            // Post-training top 5
            let mut post_indices: Vec<usize> = (0..scores.len()).collect();
            post_indices.sort_by(|a, b| {
                scores[*b]
                    .partial_cmp(&scores[*a])
                    .unwrap_or(std::cmp::Ordering::Equal)
            });
            post_indices.truncate(5);

            // Overlap with pre-training top 5
            if let Some(pre) = pre_training_top5.get(idx) {
                if !pre.is_empty() {
                    let overlap = post_indices.iter().filter(|i| pre.contains(i)).count();
                    let k = 5.min(sample.candidate_embeddings.len());
                    if k > 0 {
                        stability_sum += overlap as f64 / k as f64;
                        stability_count += 1;
                    }
                }
            }
        }
    }

    let score_variance = if all_scores.len() < 2 {
        0.0
    } else {
        let mean = all_scores.iter().sum::<f64>() / all_scores.len() as f64;
        all_scores.iter().map(|s| (s - mean).powi(2)).sum::<f64>() / all_scores.len() as f64
    };

    let topk_stability = if stability_count == 0 {
        1.0
    } else {
        stability_sum / stability_count as f64
    };

    CanaryMetrics {
        score_variance,
        topk_stability,
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use crate::{
        autograd::{Rng, Tape},
        data::TrainingSample,
        model::{CrossAttentionScorer, ScorerConfig},
    };

    use super::{train_batch, train_epochs, Adam};

    fn make_sample(native_dim: usize, extra_features: usize) -> TrainingSample {
        TrainingSample {
            session_id: "session-1".to_string(),
            query_embedding: vec![0.1; native_dim],
            candidate_embeddings: vec![vec![0.2; native_dim], vec![0.5; native_dim]],
            candidate_texts: vec![],
            candidate_features: vec![vec![0.0; extra_features], vec![1.0; extra_features]],
            project_slot: 1,
            labels: vec![1.0, 0.0],
        }
    }

    #[test]
    fn train_batch_runs_and_updates_parameters() {
        let mut tape = Tape::new();
        let mut rng = Rng::new(19);
        let cfg = ScorerConfig {
            native_dim: 4,
            internal_dim: 4,
            value_dim: 2,
            extra_features: 2,
            hash_buckets: 64,
            project_slots: 4,
        };
        let model = CrossAttentionScorer::new(&mut tape, &mut rng, cfg);
        let mut optimizer = Adam::new(&tape, 1e-2);
        let before = tape.params()[0].data[0];

        let sample = TrainingSample {
            session_id: "session-1".to_string(),
            query_embedding: vec![0.1, 0.2, 0.3, 0.4],
            candidate_embeddings: vec![vec![0.2, 0.1, 0.3, 0.2], vec![0.5, 0.4, 0.2, 0.1]],
            candidate_texts: vec![],
            candidate_features: vec![vec![0.0, 1.0], vec![1.0, 0.0]],
            project_slot: 1,
            labels: vec![1.0, 0.0],
        };

        let stats = train_batch(&mut tape, &model, &[sample], &mut optimizer, 0.5).expect("train");
        let after = tape.params()[0].data[0];

        assert_eq!(stats.steps, 1);
        assert!(stats.loss.is_finite());
        assert_ne!(before, after);
    }

    #[test]
    fn train_epochs_reduces_loss() {
        let mut tape = Tape::new();
        let mut rng = Rng::new(42);
        let cfg = ScorerConfig {
            native_dim: 4,
            internal_dim: 4,
            value_dim: 2,
            extra_features: 3,
            hash_buckets: 64,
            project_slots: 4,
        };
        let model = CrossAttentionScorer::new(&mut tape, &mut rng, cfg);
        let mut optimizer = Adam::new(&tape, 1e-2);

        let sample = make_sample(4, 3);

        // Get initial loss
        let stats_1 =
            train_batch(&mut tape, &model, &[sample.clone()], &mut optimizer, 0.5).expect("train");
        let initial_loss = stats_1.loss;

        // Train for multiple epochs
        let stats = train_epochs(&mut tape, &model, &[sample], &mut optimizer, 20, 0.5)
            .expect("train_epochs");

        assert!(stats.steps > 1, "should have taken multiple steps");
        assert!(
            stats.loss <= initial_loss + 1e-6,
            "final loss {} should be <= initial loss {} (or very close)",
            stats.loss,
            initial_loss,
        );
    }
}

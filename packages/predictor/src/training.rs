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

        let candidates = sample
            .candidate_embeddings
            .iter()
            .zip(feature_storage.iter())
            .map(|(embedding, features)| CandidateInput {
                id: "",
                embedding: Some(embedding.as_slice()),
                text: None,
                features,
            })
            .collect::<Vec<_>>();

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

#[cfg(test)]
mod tests {
    use crate::{
        autograd::{Rng, Tape},
        data::TrainingSample,
        model::{CrossAttentionScorer, ScorerConfig},
    };

    use super::{train_batch, Adam};

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
}

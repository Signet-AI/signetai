use serde::{Deserialize, Serialize};

use crate::{
    autograd::{Act, Param, Rng, Tape},
    tokenizer::HashTrickTokenizer,
};

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct ScorerConfig {
    pub native_dim: usize,
    pub internal_dim: usize,
    pub value_dim: usize,
    pub extra_features: usize,
    pub hash_buckets: usize,
    pub project_slots: usize,
}

impl Default for ScorerConfig {
    fn default() -> Self {
        Self {
            native_dim: 768,
            internal_dim: 64,
            value_dim: 32,
            extra_features: 12,
            hash_buckets: 16_384,
            project_slots: 32,
        }
    }
}

#[derive(Debug, Clone)]
pub struct CandidateInput<'a> {
    pub id: &'a str,
    pub embedding: Option<&'a [f64]>,
    pub text: Option<&'a str>,
    pub features: &'a [f64],
}

#[derive(Debug, Clone, Serialize)]
pub struct ScoredCandidate {
    pub id: String,
    pub score: f64,
    pub logit: f64,
}

#[derive(Debug, Clone)]
pub struct CrossAttentionScorer {
    config: ScorerConfig,
    down_proj: usize,
    q_proj: usize,
    k_proj: usize,
    v_proj: usize,
    gate_proj: usize,
    hash_embeddings: usize,
    project_embeddings: usize,
    tokenizer: HashTrickTokenizer,
}

impl CrossAttentionScorer {
    pub fn new(tape: &mut Tape, rng: &mut Rng, config: ScorerConfig) -> Self {
        let d_std = (1.0 / config.native_dim as f64).sqrt();
        let h_std = (1.0 / config.internal_dim as f64).sqrt();

        let down_proj = tape.add_param(Param::matrix(
            rng,
            config.internal_dim,
            config.native_dim,
            d_std,
        ));
        let q_proj = tape.add_param(Param::matrix(
            rng,
            config.internal_dim,
            config.internal_dim,
            h_std,
        ));
        let k_proj = tape.add_param(Param::matrix(
            rng,
            config.internal_dim,
            config.internal_dim,
            h_std,
        ));
        let v_proj = tape.add_param(Param::matrix(
            rng,
            config.value_dim,
            config.internal_dim,
            h_std,
        ));
        let hash_embeddings = tape.add_param(Param::matrix(
            rng,
            config.hash_buckets,
            config.internal_dim,
            h_std,
        ));
        let project_embeddings = tape.add_param(Param::matrix(
            rng,
            config.project_slots,
            config.internal_dim,
            h_std,
        ));
        let gate_width = config.value_dim + config.extra_features + config.internal_dim + 1;
        let gate_proj = tape.add_param(Param::matrix(rng, 1, gate_width, h_std));

        Self {
            config,
            down_proj,
            q_proj,
            k_proj,
            v_proj,
            gate_proj,
            hash_embeddings,
            project_embeddings,
            tokenizer: HashTrickTokenizer::new(config.hash_buckets),
        }
    }

    pub fn config(&self) -> ScorerConfig {
        self.config
    }

    pub fn param_indices(&self) -> [usize; 7] {
        [
            self.down_proj,
            self.q_proj,
            self.k_proj,
            self.v_proj,
            self.gate_proj,
            self.hash_embeddings,
            self.project_embeddings,
        ]
    }

    fn encode_candidate(
        &self,
        tape: &mut Tape,
        candidate: &CandidateInput<'_>,
    ) -> Result<Act, String> {
        if let Some(embedding) = candidate.embedding {
            if embedding.len() == self.config.native_dim {
                let embedding_act = tape.constant(embedding.to_vec());
                let down = tape.matvec(self.down_proj, embedding_act);
                return Ok(tape.layer_norm(down));
            }
        }

        if let Some(text) = candidate.text {
            let token_ids = self.tokenizer.token_indices(text);
            if token_ids.is_empty() {
                return Ok(tape.constant(vec![0.0; self.config.internal_dim]));
            }
            let token_embeds = token_ids
                .into_iter()
                .map(|idx| tape.embed_row(self.hash_embeddings, idx))
                .collect::<Vec<_>>();
            let pooled = tape.mean_pool(&token_embeds);
            return Ok(tape.layer_norm(pooled));
        }

        Err(format!(
            "candidate {} must provide either native embedding or text",
            candidate.id
        ))
    }

    pub fn forward_logits(
        &self,
        tape: &mut Tape,
        query_embedding: &[f64],
        candidates: &[CandidateInput<'_>],
        project_slot: usize,
    ) -> Result<Act, String> {
        if query_embedding.len() != self.config.native_dim {
            return Err(format!(
                "query embedding dim mismatch: expected {}, got {}",
                self.config.native_dim,
                query_embedding.len()
            ));
        }

        if candidates.is_empty() {
            return Err("cannot score empty candidate set".to_string());
        }

        let query = tape.constant(query_embedding.to_vec());
        let query_down = tape.matvec(self.down_proj, query);
        let query_norm = tape.layer_norm(query_down);
        let q = tape.matvec(self.q_proj, query_norm);

        let slot = project_slot % self.config.project_slots;
        let project_embedding = tape.embed_row(self.project_embeddings, slot);

        let mut logits = Vec::with_capacity(candidates.len());

        for candidate in candidates {
            if candidate.features.len() != self.config.extra_features {
                return Err(format!(
                    "candidate {} feature dim mismatch: expected {}, got {}",
                    candidate.id,
                    self.config.extra_features,
                    candidate.features.len()
                ));
            }

            let encoded = self.encode_candidate(tape, candidate)?;
            let k = tape.matvec(self.k_proj, encoded);
            let v = tape.matvec(self.v_proj, encoded);

            let similarity = tape.dot(q, k);
            let scaled_similarity =
                tape.scale(similarity, 1.0 / (self.config.internal_dim as f64).sqrt());

            let feature_act = tape.constant(candidate.features.to_vec());
            let bias = tape.constant(vec![1.0]);
            let gate_input = tape.feature_concat(&[v, feature_act, project_embedding, bias]);
            let gate_logit = tape.matvec(self.gate_proj, gate_input);

            logits.push(tape.vec_add(scaled_similarity, gate_logit));
        }

        Ok(tape.feature_concat(&logits))
    }

    pub fn score(
        &self,
        tape: &mut Tape,
        query_embedding: &[f64],
        candidates: &[CandidateInput<'_>],
        project_slot: usize,
    ) -> Result<Vec<ScoredCandidate>, String> {
        tape.reset();

        let logits = self.forward_logits(tape, query_embedding, candidates, project_slot)?;
        let probs = tape.softmax(logits);

        let prob_values = tape.value(probs).to_vec();
        let logit_values = tape.value(logits).to_vec();

        let mut scored = candidates
            .iter()
            .enumerate()
            .map(|(idx, c)| ScoredCandidate {
                id: c.id.to_string(),
                score: prob_values[idx],
                logit: logit_values[idx],
            })
            .collect::<Vec<_>>();

        scored.sort_by(|a, b| {
            b.score
                .partial_cmp(&a.score)
                .unwrap_or(std::cmp::Ordering::Equal)
        });

        Ok(scored)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::autograd::{Rng, Tape};

    #[test]
    fn score_returns_distribution_over_candidates() {
        let mut tape = Tape::new();
        let mut rng = Rng::new(42);
        let cfg = ScorerConfig {
            native_dim: 8,
            internal_dim: 4,
            value_dim: 2,
            extra_features: 3,
            hash_buckets: 128,
            project_slots: 4,
        };
        let scorer = CrossAttentionScorer::new(&mut tape, &mut rng, cfg);

        let query = vec![0.1; 8];
        let c1_embedding = vec![0.2; 8];
        let c2_embedding = vec![0.4; 8];
        let c1_features = vec![0.0, 1.0, 0.5];
        let c2_features = vec![0.2, 0.4, 0.8];

        let candidates = vec![
            CandidateInput {
                id: "m1",
                embedding: Some(&c1_embedding),
                text: None,
                features: &c1_features,
            },
            CandidateInput {
                id: "m2",
                embedding: Some(&c2_embedding),
                text: None,
                features: &c2_features,
            },
        ];

        let scores = scorer
            .score(&mut tape, &query, &candidates, 1)
            .expect("score");
        assert_eq!(scores.len(), 2);

        let total: f64 = scores.iter().map(|s| s.score).sum();
        assert!(
            (total - 1.0).abs() < 1e-8,
            "probability mass should sum to 1"
        );
        assert!(scores[0].score >= scores[1].score);
    }

    #[test]
    fn score_supports_text_only_candidate_path() {
        let mut tape = Tape::new();
        let mut rng = Rng::new(7);
        let cfg = ScorerConfig {
            native_dim: 8,
            internal_dim: 4,
            value_dim: 2,
            extra_features: 3,
            hash_buckets: 64,
            project_slots: 4,
        };
        let scorer = CrossAttentionScorer::new(&mut tape, &mut rng, cfg);
        let query = vec![0.2; 8];
        let features = vec![0.0, 0.0, 1.0];

        let candidates = vec![CandidateInput {
            id: "txt",
            embedding: None,
            text: Some("dark mode preference terminal ui"),
            features: &features,
        }];

        let scores = scorer
            .score(&mut tape, &query, &candidates, 0)
            .expect("score");
        assert_eq!(scores.len(), 1);
        assert!((scores[0].score - 1.0).abs() < 1e-8);
    }
}

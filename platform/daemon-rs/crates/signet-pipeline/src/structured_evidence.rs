//! Structured evidence ranking parity for daemon recall shaping.
//!
//! Rust port of `platform/daemon/src/pipeline/structured-evidence.ts`. The
//! module combines lexical, semantic, hint, traversal, and structured path
//! evidence into a bounded ranking score, caps unanchored traversal-only hits,
//! and reorders selected candidates to cover more query facets.

use std::collections::{HashMap, HashSet};

use crate::stop_words::FTS_STOP;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct EvidenceChannels {
    pub lexical: f64,
    pub semantic: f64,
    pub hint: f64,
    pub traversal: f64,
    pub structured: f64,
}

impl Default for EvidenceChannels {
    fn default() -> Self {
        Self {
            lexical: 0.0,
            semantic: 0.0,
            hint: 0.0,
            traversal: 0.0,
            structured: 0.0,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct EvidenceCandidateInput {
    pub id: String,
    pub source: Option<String>,
    pub lexical: Option<f64>,
    pub semantic: Option<f64>,
    pub hint: Option<f64>,
    pub traversal: Option<f64>,
    pub structured: Option<f64>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct EvidenceCandidate {
    pub id: String,
    pub score: f64,
    pub source: String,
    pub evidence: EvidenceChannels,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct StructuredEvidenceOptions {
    pub min_score: f64,
    pub traversal_anchor_threshold: f64,
    pub traversal_unanchored_cap: f64,
    pub weights: EvidenceChannels,
}

impl Default for StructuredEvidenceOptions {
    fn default() -> Self {
        Self {
            min_score: 0.0,
            traversal_anchor_threshold: 0.35,
            traversal_unanchored_cap: 0.35,
            weights: EvidenceChannels {
                lexical: 0.25,
                semantic: 0.3,
                hint: 0.3,
                traversal: 0.15,
                structured: 0.15,
            },
        }
    }
}

fn clamp01(value: Option<f64>) -> f64 {
    let Some(value) = value else {
        return 0.0;
    };
    if !value.is_finite() {
        return 0.0;
    }
    value.clamp(0.0, 1.0)
}

fn tokenize(text: &str) -> HashSet<String> {
    let normalized = text
        .to_lowercase()
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch.is_whitespace() {
                ch
            } else {
                ' '
            }
        })
        .collect::<String>();

    normalized
        .split_whitespace()
        .filter(|token| token.len() >= 2 && !FTS_STOP.contains(*token))
        .map(str::to_string)
        .collect()
}

fn weighted_score(channels: EvidenceChannels, weights: EvidenceChannels) -> f64 {
    channels.lexical * weights.lexical
        + channels.semantic * weights.semantic
        + channels.hint * weights.hint
        + channels.traversal * weights.traversal
        + channels.structured * weights.structured
}

fn has_traversal_anchor(channels: EvidenceChannels, threshold: f64) -> bool {
    channels.lexical > 0.0
        || channels.hint > 0.0
        || channels.semantic >= threshold
        || channels.structured >= threshold
}

fn source_for(input: &EvidenceCandidateInput, channels: EvidenceChannels) -> String {
    if channels.traversal > 0.0
        && (channels.lexical > 0.0
            || channels.semantic > 0.0
            || channels.hint > 0.0
            || channels.structured > 0.0)
    {
        return "sec".to_string();
    }
    if channels.structured > 0.0
        && (channels.lexical > 0.0 || channels.semantic > 0.0 || channels.hint > 0.0)
    {
        return "sec".to_string();
    }
    if channels.structured > 0.0 && channels.traversal == 0.0 {
        return "structured".to_string();
    }
    if channels.hint > 0.0 && channels.lexical == 0.0 && channels.semantic == 0.0 {
        return "hint".to_string();
    }
    input.source.clone().unwrap_or_else(|| "sec".to_string())
}

pub fn shape_structured_evidence(inputs: &[EvidenceCandidateInput]) -> Vec<EvidenceCandidate> {
    shape_structured_evidence_with_options(inputs, StructuredEvidenceOptions::default())
}

pub fn shape_structured_evidence_with_options(
    inputs: &[EvidenceCandidateInput],
    cfg: StructuredEvidenceOptions,
) -> Vec<EvidenceCandidate> {
    let has_secondary_evidence = inputs.iter().any(|input| {
        clamp01(input.hint) > 0.0
            || clamp01(input.traversal) > 0.0
            || clamp01(input.structured) > 0.0
    });

    let mut shaped = inputs
        .iter()
        .enumerate()
        .filter_map(|(index, input)| {
            let evidence = EvidenceChannels {
                lexical: clamp01(input.lexical),
                semantic: clamp01(input.semantic),
                hint: clamp01(input.hint),
                traversal: clamp01(input.traversal),
                structured: clamp01(input.structured),
            };

            let lexical_floor = if evidence.lexical > 0.0 {
                if has_secondary_evidence {
                    0.4 + evidence.lexical * 0.02
                } else {
                    evidence.lexical
                }
            } else {
                0.0
            };
            let mut score = weighted_score(evidence, cfg.weights)
                .max(lexical_floor)
                .max(evidence.hint);
            if evidence.structured >= 0.25 {
                score += (evidence.structured - 0.25) * 0.8;
            }
            if evidence.structured >= 0.2 {
                // Structured path scores are already query-normalized evidence
                // over entity/aspect/group/claim/content tokens. Let that
                // channel introduce and rank candidates on its own instead of
                // reducing it to a small additive boost behind generic vector
                // similarity.
                score = score.max(evidence.structured);
            }
            if evidence.traversal > 0.0
                && !has_traversal_anchor(evidence, cfg.traversal_anchor_threshold)
            {
                score = score.min(cfg.traversal_unanchored_cap);
            }
            score = score.clamp(0.0, 1.0);
            if score < cfg.min_score {
                return None;
            }

            Some((
                index,
                EvidenceCandidate {
                    id: input.id.clone(),
                    score,
                    source: source_for(input, evidence),
                    evidence,
                },
            ))
        })
        .collect::<Vec<_>>();

    shaped.sort_by(|(left_index, left), (right_index, right)| {
        right
            .score
            .total_cmp(&left.score)
            .then_with(|| left_index.cmp(right_index))
    });
    shaped.into_iter().map(|(_, candidate)| candidate).collect()
}

pub fn shape_by_facet_coverage(
    query: &str,
    candidates: &[EvidenceCandidate],
    content_by_id: &HashMap<String, String>,
    limit: usize,
) -> Vec<EvidenceCandidate> {
    if limit == 0 || candidates.len() <= 1 {
        return candidates.to_vec();
    }

    let query_facets = tokenize(query);
    if query_facets.len() <= 1 {
        return candidates.to_vec();
    }

    let mut remaining = candidates.to_vec();
    let mut selected = Vec::new();
    let mut covered = HashSet::new();

    while !remaining.is_empty() && selected.len() < limit {
        let mut best_index = 0usize;
        let mut best_score = f64::NEG_INFINITY;

        for (index, candidate) in remaining.iter().enumerate() {
            let empty = String::new();
            let content = tokenize(content_by_id.get(&candidate.id).unwrap_or(&empty));
            let mut new_facets = 0usize;
            let mut repeated_facets = 0usize;
            for facet in &query_facets {
                if !content.contains(facet) {
                    continue;
                }
                if covered.contains(facet) {
                    repeated_facets += 1;
                } else {
                    new_facets += 1;
                }
            }
            let coverage_score =
                candidate.score + new_facets as f64 * 0.08 - repeated_facets as f64 * 0.02;
            if coverage_score > best_score {
                best_score = coverage_score;
                best_index = index;
            }
        }

        let picked = remaining.remove(best_index);
        selected.push(picked.clone());
        let empty = String::new();
        let content = tokenize(content_by_id.get(&picked.id).unwrap_or(&empty));
        for facet in &query_facets {
            if content.contains(facet) {
                covered.insert(facet.clone());
            }
        }
    }

    selected.extend(remaining);
    selected
}

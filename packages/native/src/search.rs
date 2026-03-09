use napi_derive::napi;

#[napi(object)]
pub struct ScoredId {
    pub id: String,
    pub score: f64,
    pub source: String, // "vector" | "keyword" | "hybrid"
}

/// Alpha-weighted blending of vector + keyword search results.
/// Returns merged, filtered, and sorted scored IDs.
#[napi]
pub fn merge_hybrid_scores(
    vector_ids: Vec<String>,
    vector_scores: Vec<f64>,
    keyword_ids: Vec<String>,
    keyword_scores: Vec<f64>,
    alpha: f64,
    min_score: f64,
) -> Vec<ScoredId> {
    use std::collections::HashMap;

    let mut vector_map: HashMap<&str, f64> = HashMap::with_capacity(vector_ids.len());
    for (id, &score) in vector_ids.iter().zip(vector_scores.iter()) {
        vector_map.insert(id.as_str(), score);
    }

    let mut keyword_map: HashMap<&str, f64> = HashMap::with_capacity(keyword_ids.len());
    for (id, &score) in keyword_ids.iter().zip(keyword_scores.iter()) {
        keyword_map.insert(id.as_str(), score);
    }

    // Collect all unique IDs
    let mut all_ids: Vec<&str> = Vec::with_capacity(vector_ids.len() + keyword_ids.len());
    for id in &vector_ids {
        all_ids.push(id.as_str());
    }
    for id in &keyword_ids {
        if !vector_map.contains_key(id.as_str()) {
            all_ids.push(id.as_str());
        }
    }

    let mut results: Vec<ScoredId> = Vec::with_capacity(all_ids.len());

    for id in all_ids {
        let vs = vector_map.get(id).copied().unwrap_or(0.0);
        let ks = keyword_map.get(id).copied().unwrap_or(0.0);

        let (score, source) = if vs > 0.0 && ks > 0.0 {
            (alpha * vs + (1.0 - alpha) * ks, "hybrid")
        } else if vs > 0.0 {
            (vs, "vector")
        } else {
            (ks, "keyword")
        };

        if score >= min_score {
            results.push(ScoredId {
                id: id.to_string(),
                score,
                source: source.to_string(),
            });
        }
    }

    results.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
    results
}

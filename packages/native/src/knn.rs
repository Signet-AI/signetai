use napi_derive::napi;

/// Min-max normalise axes to [-scale/2, scale/2].
/// Replaces 3 separate JS array iterations with a single native call.
#[napi(object)]
pub struct NormalisedAxes {
    pub xs: Vec<f64>,
    pub ys: Vec<f64>,
    pub zs: Option<Vec<f64>>,
}

fn normalise_one(values: &[f64], scale: f64) -> Vec<f64> {
    if values.is_empty() {
        return Vec::new();
    }
    let mut min = f64::INFINITY;
    let mut max = f64::NEG_INFINITY;
    for &v in values {
        if v < min { min = v; }
        if v > max { max = v; }
    }
    let range = if (max - min).abs() < f64::EPSILON { 1.0 } else { max - min };
    values.iter().map(|&v| ((v - min) / range - 0.5) * scale).collect()
}

#[napi]
pub fn normalise_axes(xs: Vec<f64>, ys: Vec<f64>, zs: Option<Vec<f64>>, scale: f64) -> NormalisedAxes {
    NormalisedAxes {
        xs: normalise_one(&xs, scale),
        ys: normalise_one(&ys, scale),
        zs: zs.map(|z| normalise_one(&z, scale)),
    }
}

/// Build KNN edges from 2D/3D projected coordinates.
/// Uses exact O(n^2) below `exact_threshold`, approximate axis-sorted
/// window above it. Returns deduplicated [source, target] pairs.
#[napi]
pub fn build_knn_edges(coords: Vec<Vec<f64>>, k: u32, exact_threshold: u32) -> Vec<Vec<u32>> {
    let n = coords.len();
    if n < 2 {
        return Vec::new();
    }
    if n as u32 <= exact_threshold {
        build_exact(n, &coords, k as usize)
    } else {
        build_approximate(n, &coords, k as usize)
    }
}

fn squared_dist(a: &[f64], b: &[f64]) -> f64 {
    let mut d = 0.0;
    let len = a.len().min(b.len());
    for i in 0..len {
        let diff = a[i] - b[i];
        d += diff * diff;
    }
    d
}

fn build_exact(n: usize, coords: &[Vec<f64>], k: usize) -> Vec<Vec<u32>> {
    let mut edge_set = std::collections::HashSet::new();
    let mut result: Vec<Vec<u32>> = Vec::new();

    for i in 0..n {
        let mut dists: Vec<(usize, f64)> = Vec::with_capacity(n - 1);
        for j in 0..n {
            if i == j { continue; }
            dists.push((j, squared_dist(&coords[i], &coords[j])));
        }
        dists.sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal));
        let take = k.min(dists.len());
        for idx in 0..take {
            let a = i.min(dists[idx].0) as u32;
            let b = i.max(dists[idx].0) as u32;
            let key = ((a as u64) << 32) | (b as u64);
            if edge_set.insert(key) {
                result.push(vec![a, b]);
            }
        }
    }
    result
}

fn build_approximate(n: usize, coords: &[Vec<f64>], k: usize) -> Vec<Vec<u32>> {
    let window_size = 4usize.max(k * 6); // Math.max(4, k * KNN_APPROX_WINDOW_MULTIPLIER)
    let mut edge_set = std::collections::HashSet::new();
    let mut result: Vec<Vec<u32>> = Vec::new();

    let mut by_x: Vec<usize> = (0..n).collect();
    by_x.sort_by(|&a, &b| coords[a][0].partial_cmp(&coords[b][0]).unwrap_or(std::cmp::Ordering::Equal));

    let mut by_y: Vec<usize> = (0..n).collect();
    by_y.sort_by(|&a, &b| coords[a][1].partial_cmp(&coords[b][1]).unwrap_or(std::cmp::Ordering::Equal));

    // Collect candidate neighbors from both axis orderings
    let mut candidates: Vec<Vec<usize>> = (0..n).map(|_| Vec::new()).collect();

    let collect = |ordering: &[usize], candidates: &mut Vec<Vec<usize>>| {
        for (idx, &source) in ordering.iter().enumerate() {
            for offset in 1..=window_size {
                if idx >= offset {
                    candidates[source].push(ordering[idx - offset]);
                }
                if idx + offset < ordering.len() {
                    candidates[source].push(ordering[idx + offset]);
                }
            }
        }
    };

    collect(&by_x, &mut candidates);
    collect(&by_y, &mut candidates);

    // For each node, find k nearest from candidates
    for source in 0..n {
        // Deduplicate candidates
        candidates[source].sort_unstable();
        candidates[source].dedup();

        let mut nearest: Vec<(usize, f64)> = Vec::with_capacity(k + 1);
        for &cand in &candidates[source] {
            if cand == source { continue; }
            let d = squared_dist(&coords[source], &coords[cand]);
            // Insert into sorted nearest list
            let pos = nearest.iter().position(|&(_, nd)| d < nd).unwrap_or(nearest.len());
            if pos < k {
                nearest.insert(pos, (cand, d));
                if nearest.len() > k { nearest.pop(); }
            }
        }

        for &(neighbor, _) in &nearest {
            let a = source.min(neighbor) as u32;
            let b = source.max(neighbor) as u32;
            let key = ((a as u64) << 32) | (b as u64);
            if edge_set.insert(key) {
                result.push(vec![a, b]);
            }
        }
    }

    result
}

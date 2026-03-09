use napi::bindgen_prelude::*;
use napi_derive::napi;

/// Cosine similarity between two f32 slices.
/// Truncates to the shorter length if mismatched.
/// Returns f64 for JS number precision.
#[napi]
pub fn cosine_similarity(a: &[f32], b: &[f32]) -> f64 {
    let len = a.len().min(b.len());
    let mut dot: f64 = 0.0;
    let mut norm_a: f64 = 0.0;
    let mut norm_b: f64 = 0.0;

    for i in 0..len {
        let ai = a[i] as f64;
        let bi = b[i] as f64;
        dot += ai * bi;
        norm_a += ai * ai;
        norm_b += bi * bi;
    }

    let denom = norm_a.sqrt() * norm_b.sqrt();
    if denom > 0.0 {
        dot / denom
    } else {
        0.0
    }
}

/// Squared Euclidean distance between two f64 slices.
/// Truncates to the shorter length if mismatched.
#[napi]
pub fn squared_distance(a: &[f64], b: &[f64]) -> f64 {
    let len = a.len().min(b.len());
    let mut distance: f64 = 0.0;
    for i in 0..len {
        let diff = a[i] - b[i];
        distance += diff * diff;
    }
    distance
}

/// Serialize a vector of f64 numbers to a Buffer via Float32Array.
#[napi]
pub fn vector_to_blob(vec: Vec<f64>) -> Buffer {
    let bytes: Vec<u8> = vec.iter()
        .flat_map(|&v| (v as f32).to_le_bytes())
        .collect();
    Buffer::from(bytes)
}

/// Cosine similarity of one query vector against N concatenated vectors.
/// `matrix` is a flat buffer of N*dim f32 values (little-endian).
/// Returns N similarity scores in one call, eliminating per-item FFI overhead.
#[napi]
pub fn batch_cosine_similarity(query: &[f32], matrix: Buffer, dim: u32) -> napi::Result<Vec<f64>> {
    let bytes: &[u8] = &matrix;
    let dim = dim as usize;
    if dim == 0 {
        return Err(napi::Error::from_reason("dim must be > 0"));
    }
    if bytes.len() % 4 != 0 {
        return Err(napi::Error::from_reason(format!(
            "matrix buffer length {} is not a multiple of 4",
            bytes.len()
        )));
    }
    let total_floats = bytes.len() / 4;
    if total_floats % dim != 0 {
        return Err(napi::Error::from_reason(format!(
            "total floats {} is not a multiple of dim {}",
            total_floats, dim
        )));
    }
    let n = total_floats / dim;
    let q_len = query.len().min(dim);

    // Pre-compute query norm
    let mut query_norm: f64 = 0.0;
    for i in 0..q_len {
        let qi = query[i] as f64;
        query_norm += qi * qi;
    }
    let query_norm = query_norm.sqrt();

    let mut results = Vec::with_capacity(n);
    for row in 0..n {
        let base = row * dim * 4;
        let mut dot: f64 = 0.0;
        let mut norm_b: f64 = 0.0;

        // Truncate to shared length (matches scalar cosine_similarity behavior)
        for i in 0..q_len {
            let offset = base + i * 4;
            let bi = f32::from_le_bytes([
                bytes[offset],
                bytes[offset + 1],
                bytes[offset + 2],
                bytes[offset + 3],
            ]) as f64;
            let qi = query[i] as f64;
            dot += qi * bi;
            norm_b += bi * bi;
        }

        let denom = query_norm * norm_b.sqrt();
        results.push(if denom > 0.0 { dot / denom } else { 0.0 });
    }

    Ok(results)
}

/// Deserialize a Buffer (Float32Array bytes) to a Vec<f32>.
/// Returns an error if the buffer length is not a multiple of 4.
#[napi]
pub fn blob_to_vector(buf: Buffer) -> napi::Result<Vec<f32>> {
    let bytes: &[u8] = &buf;
    if bytes.len() % 4 != 0 {
        return Err(napi::Error::from_reason(format!(
            "blob length {} is not a multiple of 4",
            bytes.len()
        )));
    }
    let count = bytes.len() / 4;
    let mut result = Vec::with_capacity(count);
    for i in 0..count {
        let offset = i * 4;
        let value = f32::from_le_bytes([
            bytes[offset],
            bytes[offset + 1],
            bytes[offset + 2],
            bytes[offset + 3],
        ]);
        result.push(value);
    }
    Ok(result)
}

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

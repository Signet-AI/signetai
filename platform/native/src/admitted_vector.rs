use napi::bindgen_prelude::*;
use napi_derive::napi;
use std::cmp::Ordering;
use std::collections::BinaryHeap;
use std::time::{Duration, Instant};

#[napi(object)]
pub struct AdmittedVectorChunk {
    pub vectors: Buffer,
    pub rowids: Buffer,
    pub validity: Buffer,
    pub eligibility: Buffer,
    pub identities: Option<Buffer>,
}

#[napi(object)]
pub struct AdmittedVectorHit {
    pub rowid: String,
    pub distance: f64,
}

#[napi(object)]
pub struct AdmittedVectorResult {
    pub rows: Vec<AdmittedVectorHit>,
    pub scanned_rows: u32,
    pub eligible_rows: u32,
    pub heap_peak: u32,
}

#[derive(PartialEq)]
struct Candidate {
    rowid: i64,
    identity: i64,
    distance: f32,
}
impl Eq for Candidate {}
impl PartialOrd for Candidate {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}
impl Ord for Candidate {
    fn cmp(&self, other: &Self) -> Ordering {
        self.distance
            .total_cmp(&other.distance)
            .then(self.rowid.cmp(&other.rowid))
    }
}

#[napi]
pub fn scan_admitted_vectors(
    query: Float32Array,
    chunks: Vec<AdmittedVectorChunk>,
    limit: u32,
) -> Result<AdmittedVectorResult> {
    let dimensions = query.len();
    if dimensions == 0 || dimensions > 65536 || limit == 0 || limit > 4096 || chunks.len() > 16384 {
        return Err(Error::from_reason("invalid admitted scan bounds"));
    }
    let mut total_bytes = 0usize;
    let mut total_rows = 0usize;
    for chunk in &chunks {
        let rows = chunk.rowids.len() / 8;
        total_bytes = total_bytes.saturating_add(chunk.vectors.len());
        total_rows = total_rows.saturating_add(rows);
        if chunk.rowids.len() % 8 != 0
            || chunk.vectors.len() != rows * dimensions * 4
            || chunk.validity.len() != rows.div_ceil(8)
            || chunk.eligibility.len() != rows.div_ceil(8)
            || chunk
                .identities
                .as_ref()
                .is_some_and(|ids| ids.len() != rows * 4)
        {
            return Err(Error::from_reason("invalid admitted chunk"));
        }
    }
    if total_bytes > 256 * 1024 * 1024 || total_rows > 1048576 {
        return Err(Error::from_reason("admitted scan budget exceeded"));
    }
    let mut query_magnitude = 0f32;
    for value in query.iter() {
        if !value.is_finite() {
            return Err(Error::from_reason("invalid admitted query"));
        }
        query_magnitude += value * value;
    }
    let mut heap: BinaryHeap<Candidate> = BinaryHeap::with_capacity(limit as usize);
    let mut scanned_rows = 0u32;
    let mut eligible_rows = 0u32;
    let deadline = Instant::now() + Duration::from_secs(2);
    for chunk in chunks {
        if Instant::now() >= deadline {
            return Err(Error::from_reason("admitted scan deadline"));
        }
        for row in 0..chunk.rowids.len() / 8 {
            if row & 127 == 0 && Instant::now() >= deadline {
                return Err(Error::from_reason("admitted scan deadline"));
            }
            let mask = 1u8 << (row & 7);
            if chunk.validity[row >> 3] & mask == 0 {
                continue;
            }
            scanned_rows += 1;
            if chunk.eligibility[row >> 3] & mask == 0 {
                continue;
            }
            eligible_rows += 1;
            let mut dot = 0f32;
            let mut magnitude = 0f32;
            for (dimension, q) in query.iter().enumerate() {
                let offset = (row * dimensions + dimension) * 4;
                let value = f32::from_le_bytes([
                    chunk.vectors[offset],
                    chunk.vectors[offset + 1],
                    chunk.vectors[offset + 2],
                    chunk.vectors[offset + 3],
                ]);
                dot += q * value;
                magnitude += value * value;
            }
            let denominator = (query_magnitude as f64).sqrt() * (magnitude as f64).sqrt();
            let distance = (1f64 - dot as f64 / denominator) as f32;
            if !distance.is_finite() {
                continue;
            }
            let offset = row * 8;
            let rowid = i64::from_le_bytes([
                chunk.rowids[offset],
                chunk.rowids[offset + 1],
                chunk.rowids[offset + 2],
                chunk.rowids[offset + 3],
                chunk.rowids[offset + 4],
                chunk.rowids[offset + 5],
                chunk.rowids[offset + 6],
                chunk.rowids[offset + 7],
            ]);
            let identity = match &chunk.identities {
                Some(ids) => {
                    let start = row * 4;
                    u32::from_le_bytes([ids[start], ids[start + 1], ids[start + 2], ids[start + 3]])
                        as i64
                }
                None => rowid,
            };
            let candidate = Candidate {
                rowid,
                identity,
                distance,
            };
            if let Some(existing) = heap.iter().find(|hit| hit.identity == identity) {
                if candidate >= *existing {
                    continue;
                }
                heap.retain(|hit| hit.identity != identity);
            }
            if heap.len() < limit as usize {
                heap.push(candidate);
            } else if heap.peek().is_some_and(|worst| candidate < *worst) {
                heap.pop();
                heap.push(candidate);
            }
        }
    }
    let heap_peak = heap.len() as u32;
    let rows = heap
        .into_sorted_vec()
        .into_iter()
        .map(|hit| AdmittedVectorHit {
            rowid: hit.rowid.to_string(),
            distance: hit.distance as f64,
        })
        .collect();
    Ok(AdmittedVectorResult {
        rows,
        scanned_rows,
        eligible_rows,
        heap_peak,
    })
}

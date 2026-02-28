#[derive(Debug, Clone)]
pub struct HashTrickTokenizer {
    buckets: usize,
}

impl HashTrickTokenizer {
    pub fn new(buckets: usize) -> Self {
        assert!(buckets > 0, "buckets must be > 0");
        Self { buckets }
    }

    pub fn buckets(&self) -> usize {
        self.buckets
    }

    pub fn token_indices(&self, text: &str) -> Vec<usize> {
        split_tokens(text)
            .into_iter()
            .map(|token| fnv1a_hash(token.as_bytes()) as usize % self.buckets)
            .collect()
    }

    pub fn encode_mean(&self, text: &str, embedding_table: &[f64], dim: usize) -> Vec<f64> {
        assert_eq!(
            embedding_table.len(),
            self.buckets * dim,
            "embedding table size mismatch"
        );

        let tokens = self.token_indices(text);
        if tokens.is_empty() {
            return vec![0.0; dim];
        }

        let mut out = vec![0.0; dim];
        for bucket in &tokens {
            let start = bucket * dim;
            for i in 0..dim {
                out[i] += embedding_table[start + i];
            }
        }

        let inv = 1.0 / tokens.len() as f64;
        for v in &mut out {
            *v *= inv;
        }

        out
    }
}

fn split_tokens(text: &str) -> Vec<&str> {
    text.split(|ch: char| !(ch.is_ascii_alphanumeric() || ch == '_' || ch == '-'))
        .filter(|token| !token.is_empty())
        .collect()
}

pub fn fnv1a_hash(bytes: &[u8]) -> u64 {
    const FNV_OFFSET: u64 = 0xcbf29ce484222325;
    const FNV_PRIME: u64 = 0x100000001b3;

    let mut hash = FNV_OFFSET;
    for byte in bytes {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(FNV_PRIME);
    }
    hash
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_indices_are_stable() {
        let tokenizer = HashTrickTokenizer::new(256);
        let a = tokenizer.token_indices("foo bar baz");
        let b = tokenizer.token_indices("foo bar baz");
        assert_eq!(a, b);
        assert!(a.iter().all(|idx| *idx < 256));
    }

    #[test]
    fn encode_mean_returns_zero_for_empty_text() {
        let tokenizer = HashTrickTokenizer::new(64);
        let table = vec![1.0; 64 * 8];
        let out = tokenizer.encode_mean("", &table, 8);
        assert_eq!(out, vec![0.0; 8]);
    }
}

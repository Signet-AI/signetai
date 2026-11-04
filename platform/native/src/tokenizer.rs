use napi::bindgen_prelude::*;
use napi_derive::napi;
use std::collections::{HashMap, VecDeque};
use std::sync::Mutex;
use tokenizers::{Encoding, Tokenizer, TruncationDirection, TruncationParams, TruncationStrategy};

const DEFAULT_DOCUMENT_CACHE_LIMIT: usize = 4096;

#[napi(object)]
pub struct EncodedPairBatch {
    pub input_ids: Vec<u32>,
    pub attention_mask: Vec<u32>,
    pub token_type_ids: Vec<u32>,
    pub batch_size: u32,
    pub sequence_length: u32,
    pub cached_documents: u32,
}

struct DocumentCache {
    limit: usize,
    entries: HashMap<String, Encoding>,
    order: VecDeque<String>,
}

impl DocumentCache {
    fn get(&self, text: &str) -> Option<Encoding> {
        self.entries.get(text).cloned()
    }

    fn insert(&mut self, text: String, encoding: Encoding) {
        if self.limit == 0 || self.entries.contains_key(&text) {
            return;
        }
        while self.entries.len() >= self.limit {
            match self.order.pop_front() {
                Some(oldest) => {
                    self.entries.remove(&oldest);
                }
                None => break,
            }
        }
        self.order.push_back(text.clone());
        self.entries.insert(text, encoding);
    }
}

#[napi]
pub struct PairTokenizer {
    tokenizer: Tokenizer,
    pad_id: u32,
    pad_type_id: u32,
    documents: Mutex<DocumentCache>,
}

fn tokenizer_error(error: impl std::fmt::Display) -> Error {
    Error::new(Status::GenericFailure, format!("tokenizer: {error}"))
}

#[napi]
impl PairTokenizer {
    #[napi(constructor)]
    pub fn new(tokenizer_path: String, max_length: u32, cache_limit: Option<u32>) -> Result<Self> {
        let mut tokenizer = Tokenizer::from_file(&tokenizer_path).map_err(tokenizer_error)?;
        let (pad_id, pad_type_id) = tokenizer
            .get_padding()
            .map(|padding| (padding.pad_id, padding.pad_type_id))
            .unwrap_or((0, 0));
        tokenizer
            .with_truncation(Some(TruncationParams {
                direction: TruncationDirection::Right,
                max_length: max_length as usize,
                strategy: TruncationStrategy::LongestFirst,
                stride: 0,
            }))
            .map_err(tokenizer_error)?;
        tokenizer.with_padding(None);
        Ok(Self {
            tokenizer,
            pad_id,
            pad_type_id,
            documents: Mutex::new(DocumentCache {
                limit: cache_limit
                    .map(|limit| limit as usize)
                    .unwrap_or(DEFAULT_DOCUMENT_CACHE_LIMIT),
                entries: HashMap::new(),
                order: VecDeque::new(),
            }),
        })
    }

    #[napi]
    pub fn encode_pairs(&self, query: String, documents: Vec<String>) -> Result<EncodedPairBatch> {
        let query_encoding = self
            .tokenizer
            .encode(query.as_str(), false)
            .map_err(tokenizer_error)?;
        let mut cached_documents = 0u32;
        let mut pairs = Vec::with_capacity(documents.len());
        for document in documents {
            let cached = self
                .documents
                .lock()
                .map_err(|_| tokenizer_error("document cache poisoned"))?
                .get(&document);
            let document_encoding = match cached {
                Some(encoding) => {
                    cached_documents += 1;
                    encoding
                }
                None => {
                    let encoding = self
                        .tokenizer
                        .encode(document.as_str(), false)
                        .map_err(tokenizer_error)?;
                    self.documents
                        .lock()
                        .map_err(|_| tokenizer_error("document cache poisoned"))?
                        .insert(document, encoding.clone());
                    encoding
                }
            };
            pairs.push(
                self.tokenizer
                    .post_process(query_encoding.clone(), Some(document_encoding), true)
                    .map_err(tokenizer_error)?,
            );
        }
        let sequence_length = pairs.iter().map(|pair| pair.len()).max().unwrap_or(0);
        let total = pairs.len() * sequence_length;
        let mut input_ids = Vec::with_capacity(total);
        let mut attention_mask = Vec::with_capacity(total);
        let mut token_type_ids = Vec::with_capacity(total);
        for pair in &pairs {
            let padding = sequence_length - pair.len();
            input_ids.extend_from_slice(pair.get_ids());
            input_ids.extend(std::iter::repeat(self.pad_id).take(padding));
            attention_mask.extend_from_slice(pair.get_attention_mask());
            attention_mask.extend(std::iter::repeat(0).take(padding));
            token_type_ids.extend_from_slice(pair.get_type_ids());
            token_type_ids.extend(std::iter::repeat(self.pad_type_id).take(padding));
        }
        Ok(EncodedPairBatch {
            input_ids,
            attention_mask,
            token_type_ids,
            batch_size: pairs.len() as u32,
            sequence_length: sequence_length as u32,
            cached_documents,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::{DocumentCache, PairTokenizer};
    use std::collections::{HashMap, VecDeque};
    use tokenizers::Encoding;

    fn fixture_tokenizer() -> std::path::PathBuf {
        let json = r#"{
  "version": "1.0",
  "truncation": null,
  "padding": {"strategy": "BatchLongest", "direction": "Right", "pad_to_multiple_of": null, "pad_id": 3, "pad_type_id": 0, "pad_token": "[PAD]"},
  "added_tokens": [
    {"id": 0, "content": "[UNK]", "single_word": false, "lstrip": false, "rstrip": false, "normalized": false, "special": true},
    {"id": 1, "content": "[CLS]", "single_word": false, "lstrip": false, "rstrip": false, "normalized": false, "special": true},
    {"id": 2, "content": "[SEP]", "single_word": false, "lstrip": false, "rstrip": false, "normalized": false, "special": true},
    {"id": 3, "content": "[PAD]", "single_word": false, "lstrip": false, "rstrip": false, "normalized": false, "special": true}
  ],
  "normalizer": null,
  "pre_tokenizer": {"type": "WhitespaceSplit"},
  "post_processor": {
    "type": "TemplateProcessing",
    "single": [{"SpecialToken": {"id": "[CLS]", "type_id": 0}}, {"Sequence": {"id": "A", "type_id": 0}}, {"SpecialToken": {"id": "[SEP]", "type_id": 0}}],
    "pair": [{"SpecialToken": {"id": "[CLS]", "type_id": 0}}, {"Sequence": {"id": "A", "type_id": 0}}, {"SpecialToken": {"id": "[SEP]", "type_id": 0}}, {"Sequence": {"id": "B", "type_id": 1}}, {"SpecialToken": {"id": "[SEP]", "type_id": 1}}],
    "special_tokens": {
      "[CLS]": {"id": "[CLS]", "ids": [1], "tokens": ["[CLS]"]},
      "[SEP]": {"id": "[SEP]", "ids": [2], "tokens": ["[SEP]"]}
    }
  },
  "decoder": null,
  "model": {"type": "Unigram", "unk_id": 0, "vocab": [["[UNK]", 0.0], ["[CLS]", 0.0], ["[SEP]", 0.0], ["[PAD]", 0.0], ["alpha", -1.0], ["beta", -1.0], ["gamma", -1.0]], "byte_fallback": false}
}"#;
        static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let path = std::env::temp_dir().join(format!(
            "signet-pair-tokenizer-{}-{n}.json",
            std::process::id()
        ));
        std::fs::write(&path, json).unwrap();
        path
    }

    #[test]
    fn encodes_query_document_pairs_with_template_and_padding() {
        let path = fixture_tokenizer();
        let tokenizer = PairTokenizer::new(path.to_string_lossy().to_string(), 512, None).unwrap();
        let batch = tokenizer
            .encode_pairs(
                "alpha".to_string(),
                vec!["beta gamma".to_string(), "gamma".to_string()],
            )
            .unwrap();
        assert_eq!(batch.batch_size, 2);
        assert_eq!(batch.sequence_length, 6);
        assert_eq!(batch.input_ids, vec![1, 4, 2, 5, 6, 2, 1, 4, 2, 6, 2, 3]);
        assert_eq!(
            batch.attention_mask,
            vec![1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0]
        );
        assert_eq!(
            batch.token_type_ids,
            vec![0, 0, 0, 1, 1, 1, 0, 0, 0, 1, 1, 0]
        );
        assert_eq!(batch.cached_documents, 0);
    }

    #[test]
    fn reuses_cached_document_encodings_across_queries() {
        let path = fixture_tokenizer();
        let tokenizer = PairTokenizer::new(path.to_string_lossy().to_string(), 512, None).unwrap();
        tokenizer
            .encode_pairs("alpha".to_string(), vec!["beta".to_string()])
            .unwrap();
        let second = tokenizer
            .encode_pairs(
                "gamma".to_string(),
                vec!["beta".to_string(), "alpha".to_string()],
            )
            .unwrap();
        assert_eq!(second.cached_documents, 1);
        assert_eq!(second.input_ids, vec![1, 6, 2, 5, 2, 1, 6, 2, 4, 2]);
    }

    #[test]
    fn truncates_the_longest_side_and_keeps_the_separators() {
        let path = fixture_tokenizer();
        let tokenizer = PairTokenizer::new(path.to_string_lossy().to_string(), 8, None).unwrap();
        let batch = tokenizer
            .encode_pairs(
                "alpha".to_string(),
                vec!["beta beta beta beta beta beta".to_string()],
            )
            .unwrap();
        assert_eq!(batch.input_ids, vec![1, 4, 2, 5, 5, 5, 5, 2]);
        let long_query = tokenizer
            .encode_pairs(
                "alpha alpha alpha alpha alpha alpha".to_string(),
                vec!["beta".to_string()],
            )
            .unwrap();
        assert_eq!(long_query.input_ids, vec![1, 4, 4, 4, 4, 2, 5, 2]);
    }

    #[test]
    fn caches_documents_truncated_to_the_model_limit() {
        let path = fixture_tokenizer();
        let tokenizer = PairTokenizer::new(path.to_string_lossy().to_string(), 8, None).unwrap();
        let document = "beta beta beta beta beta beta beta beta beta beta".to_string();
        let first = tokenizer
            .encode_pairs("alpha".to_string(), vec![document.clone()])
            .unwrap();
        let cached = tokenizer.documents.lock().unwrap().get(&document).unwrap();
        assert_eq!(cached.len(), 8);
        assert!(cached.get_overflowing().is_empty());
        let second = tokenizer
            .encode_pairs("alpha".to_string(), vec![document])
            .unwrap();
        assert_eq!(second.cached_documents, 1);
        assert_eq!(second.input_ids, first.input_ids);
        assert_eq!(first.input_ids, vec![1, 4, 2, 5, 5, 5, 5, 2]);
    }

    #[test]
    fn document_cache_evicts_oldest_entry_at_the_limit() {
        let mut cache = DocumentCache {
            limit: 2,
            entries: HashMap::new(),
            order: VecDeque::new(),
        };
        cache.insert("a".to_string(), Encoding::default());
        cache.insert("b".to_string(), Encoding::default());
        cache.insert("c".to_string(), Encoding::default());
        assert!(cache.get("a").is_none());
        assert!(cache.get("b").is_some());
        assert!(cache.get("c").is_some());
        assert_eq!(cache.entries.len(), 2);
    }

    #[test]
    fn document_cache_with_zero_limit_stores_nothing() {
        let mut cache = DocumentCache {
            limit: 0,
            entries: HashMap::new(),
            order: VecDeque::new(),
        };
        cache.insert("a".to_string(), Encoding::default());
        assert!(cache.get("a").is_none());
    }
}

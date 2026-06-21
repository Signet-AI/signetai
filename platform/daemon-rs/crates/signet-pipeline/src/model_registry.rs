//! Static pipeline model registry.
//!
//! Rust parity for `platform/daemon/src/pipeline/model-registry.ts`, backed by
//! the checked-in catalog from `platform/core/src/llm-model-catalog.ts`.

use std::collections::BTreeMap;

use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ModelTier {
    Low,
    Mid,
    High,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PipelineModelPreset {
    pub value: &'static str,
    pub label: &'static str,
    pub tier: ModelTier,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ModelRegistryEntry {
    pub id: String,
    pub provider: String,
    pub label: String,
    pub tier: ModelTier,
    pub deprecated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RegistryStatus {
    pub initialized: bool,
    pub last_refresh_at: u64,
    pub model_counts: BTreeMap<String, usize>,
}

const EMPTY: &[PipelineModelPreset] = &[];
const ACPX: &[PipelineModelPreset] = &[
    PipelineModelPreset {
        value: "haiku",
        label: "Claude Code · haiku",
        tier: ModelTier::Low,
    },
    PipelineModelPreset {
        value: "gpt-5.4-mini",
        label: "Codex CLI · gpt-5.4-mini",
        tier: ModelTier::Low,
    },
    PipelineModelPreset {
        value: "google/gemini-2.5-flash",
        label: "OpenCode · google/gemini-2.5-flash",
        tier: ModelTier::Low,
    },
];
const LLAMA_CPP: &[PipelineModelPreset] = &[
    PipelineModelPreset {
        value: "qwen3:4b",
        label: "qwen3:4b",
        tier: ModelTier::Low,
    },
    PipelineModelPreset {
        value: "qwen3:8b",
        label: "qwen3:8b",
        tier: ModelTier::Low,
    },
];
const OLLAMA: &[PipelineModelPreset] = &[
    PipelineModelPreset {
        value: "qwen3:4b",
        label: "qwen3:4b",
        tier: ModelTier::Low,
    },
    PipelineModelPreset {
        value: "llama3",
        label: "llama3",
        tier: ModelTier::Low,
    },
];
const CLAUDE_CODE: &[PipelineModelPreset] = &[
    PipelineModelPreset {
        value: "haiku",
        label: "Haiku",
        tier: ModelTier::Low,
    },
    PipelineModelPreset {
        value: "sonnet",
        label: "Sonnet",
        tier: ModelTier::Mid,
    },
    PipelineModelPreset {
        value: "opus",
        label: "Opus",
        tier: ModelTier::High,
    },
];
const CODEX: &[PipelineModelPreset] = &[
    PipelineModelPreset {
        value: "gpt-5.4-mini",
        label: "gpt-5.4-mini",
        tier: ModelTier::Low,
    },
    PipelineModelPreset {
        value: "gpt-5.4",
        label: "gpt-5.4",
        tier: ModelTier::Mid,
    },
    PipelineModelPreset {
        value: "gpt-5.5",
        label: "gpt-5.5",
        tier: ModelTier::High,
    },
    PipelineModelPreset {
        value: "gpt-5.3-codex",
        label: "gpt-5.3-codex",
        tier: ModelTier::Mid,
    },
    PipelineModelPreset {
        value: "gpt-5.3-codex-spark",
        label: "gpt-5.3-codex-spark",
        tier: ModelTier::Low,
    },
    PipelineModelPreset {
        value: "gpt-5.2",
        label: "gpt-5.2",
        tier: ModelTier::Mid,
    },
];
const OPENCODE: &[PipelineModelPreset] = &[
    PipelineModelPreset {
        value: "google/gemini-2.5-flash",
        label: "google/gemini-2.5-flash",
        tier: ModelTier::Low,
    },
    PipelineModelPreset {
        value: "openai/gpt-5.4-mini",
        label: "openai/gpt-5.4-mini",
        tier: ModelTier::Low,
    },
    PipelineModelPreset {
        value: "openai/gpt-5.4",
        label: "openai/gpt-5.4",
        tier: ModelTier::Mid,
    },
];
const ANTHROPIC: &[PipelineModelPreset] = &[
    PipelineModelPreset {
        value: "claude-3-5-haiku-20241022",
        label: "Claude 3.5 Haiku",
        tier: ModelTier::Low,
    },
    PipelineModelPreset {
        value: "claude-sonnet-4-20250514",
        label: "Claude Sonnet 4",
        tier: ModelTier::Mid,
    },
];
const OPENROUTER: &[PipelineModelPreset] = &[
    PipelineModelPreset {
        value: "openai/gpt-4o-mini",
        label: "openai/gpt-4o-mini",
        tier: ModelTier::Low,
    },
    PipelineModelPreset {
        value: "openai/gpt-5.4-mini",
        label: "openai/gpt-5.4-mini",
        tier: ModelTier::Low,
    },
    PipelineModelPreset {
        value: "anthropic/claude-3.5-haiku",
        label: "anthropic/claude-3.5-haiku",
        tier: ModelTier::Low,
    },
    PipelineModelPreset {
        value: "google/gemini-2.5-flash",
        label: "google/gemini-2.5-flash",
        tier: ModelTier::Low,
    },
];
const OPENAI_COMPATIBLE: &[PipelineModelPreset] = &[
    PipelineModelPreset {
        value: "gpt-4o-mini",
        label: "gpt-4o-mini",
        tier: ModelTier::Low,
    },
    PipelineModelPreset {
        value: "gpt-4.1-mini",
        label: "gpt-4.1-mini",
        tier: ModelTier::Low,
    },
    PipelineModelPreset {
        value: "local-model",
        label: "local-model",
        tier: ModelTier::Low,
    },
];

/// Provider order mirrors TS `PIPELINE_MODEL_CATALOG` insertion order.
pub const PIPELINE_MODEL_CATALOG: &[(&str, &[PipelineModelPreset])] = &[
    ("none", EMPTY),
    ("command", EMPTY),
    ("acpx", ACPX),
    ("llama-cpp", LLAMA_CPP),
    ("ollama", OLLAMA),
    ("claude-code", CLAUDE_CODE),
    ("codex", CODEX),
    ("opencode", OPENCODE),
    ("anthropic", ANTHROPIC),
    ("openrouter", OPENROUTER),
    ("openai-compatible", OPENAI_COMPATIBLE),
];

fn to_entry(provider: &str, preset: PipelineModelPreset) -> ModelRegistryEntry {
    ModelRegistryEntry {
        id: preset.value.to_string(),
        provider: provider.to_string(),
        label: preset.label.to_string(),
        tier: preset.tier,
        deprecated: false,
    }
}

pub fn catalog_entries(provider: &str) -> Vec<ModelRegistryEntry> {
    PIPELINE_MODEL_CATALOG
        .iter()
        .find(|(name, _)| *name == provider)
        .map(|(_, presets)| {
            presets
                .iter()
                .copied()
                .map(|preset| to_entry(provider, preset))
                .collect()
        })
        .unwrap_or_default()
}

pub fn all_catalog_entries() -> Vec<ModelRegistryEntry> {
    PIPELINE_MODEL_CATALOG
        .iter()
        .flat_map(|(provider, presets)| {
            presets
                .iter()
                .copied()
                .map(move |preset| to_entry(provider, preset))
        })
        .collect()
}

pub fn mark_deprecated_versions(entries: &[ModelRegistryEntry]) -> Vec<ModelRegistryEntry> {
    entries.to_vec()
}

pub fn init_model_registry() {}

pub async fn refresh_registry() {}

pub fn get_available_models(
    provider: Option<&str>,
    include_deprecated: bool,
) -> Vec<ModelRegistryEntry> {
    let models = provider
        .map(catalog_entries)
        .unwrap_or_else(all_catalog_entries);
    if include_deprecated {
        models
    } else {
        models
            .into_iter()
            .filter(|model| !model.deprecated)
            .collect()
    }
}

pub fn get_models_by_provider() -> BTreeMap<String, Vec<ModelRegistryEntry>> {
    let mut result = BTreeMap::new();
    for (provider, _) in PIPELINE_MODEL_CATALOG {
        let entries: Vec<_> = catalog_entries(provider)
            .into_iter()
            .filter(|model| !model.deprecated)
            .collect();
        if !entries.is_empty() {
            result.insert((*provider).to_string(), entries);
        }
    }
    result
}

pub fn get_registry_status() -> RegistryStatus {
    let model_counts = get_models_by_provider()
        .into_iter()
        .map(|(provider, models)| (provider, models.len()))
        .collect();
    RegistryStatus {
        initialized: true,
        last_refresh_at: 0,
        model_counts,
    }
}

pub fn stop_model_registry() {}

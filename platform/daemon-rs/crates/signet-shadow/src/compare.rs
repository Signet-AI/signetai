//! Parity comparison engine.
//!
//! Loads parity rules from JSON and compares primary vs shadow responses,
//! emitting typed divergences.

use serde::Deserialize;
use std::collections::{BTreeMap, BTreeSet, HashMap};

use crate::ForwardResponse;
use crate::divergence::{Divergence, Severity};
use crate::snapshot::{InternalSnapshot, TableSpec, is_secret_like};

// ---------------------------------------------------------------------------
// Rule types (deserialized from contracts/parity-rules.json)
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct RulesFile {
    rules: RulesBlock,
    error_comparison: Option<ErrorComparison>,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct RulesBlock {
    default: DefaultRule,
    endpoints: HashMap<String, EndpointRule>,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct DefaultRule {
    compare_mode: Option<String>,
    compare_body: Option<bool>,
    ignore_fields: Vec<String>,
    timestamp_precision: Option<String>,
    array_ordering: Option<String>,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct EndpointRule {
    deterministic: Vec<String>,
    ignore_fields: Vec<String>,
    compare_mode: Option<String>,
    compare_body: Option<bool>,
    timestamp_precision: Option<String>,
    tolerance: Option<HashMap<String, f64>>,
    array_ordering: Option<String>,
    internal_state: Option<InternalStateRule>,
    #[allow(dead_code)]
    note: Option<String>,
}

#[derive(Debug, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
struct InternalStateRule {
    tables: BTreeMap<String, InternalTableRule>,
}

#[derive(Debug, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
struct InternalTableRule {
    key: Option<Vec<String>>,
    columns: Option<Vec<String>>,
    ignore_columns: Option<Vec<String>>,
    tolerance: Option<HashMap<String, f64>>,
    redactions: Option<Vec<String>>,
    timestamp_precision: Option<String>,
    array_ordering: Option<String>,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ErrorComparison {
    must_match: Vec<String>,
    compare_body: Option<bool>,
    #[allow(dead_code)]
    ignore_fields: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CompareMode {
    Json,
    Text,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ArrayOrdering {
    Ordered,
    Unordered,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TimestampPrecision {
    Millisecond,
    Second,
    Ignore,
}

struct EffectiveRules<'a> {
    endpoint_rule: Option<&'a EndpointRule>,
    ignore_fields: Vec<&'a str>,
    tolerance: Option<&'a HashMap<String, f64>>,
    compare_mode: CompareMode,
    compare_body: bool,
    timestamp_precision: Option<TimestampPrecision>,
    array_ordering: ArrayOrdering,
}

// ---------------------------------------------------------------------------
// ParityRules
// ---------------------------------------------------------------------------

#[derive(Default)]
pub struct ParityRules {
    rules: Option<RulesFile>,
}

impl ParityRules {
    pub fn load(path: &std::path::Path) -> Result<Self, anyhow::Error> {
        let content = std::fs::read_to_string(path)?;
        let rules: RulesFile = serde_json::from_str(&content)?;
        Ok(Self { rules: Some(rules) })
    }

    /// Compare primary and shadow responses, returning divergences.
    pub fn compare(
        &self,
        endpoint: &str,
        primary: &ForwardResponse,
        shadow: &ForwardResponse,
    ) -> Vec<Divergence> {
        let mut divergences = Vec::new();
        let rules = self.effective_rules(endpoint);

        // Status code comparison — always critical
        if primary.status != shadow.status {
            // Check error comparison rules
            let is_critical = self
                .rules
                .as_ref()
                .and_then(|r| r.error_comparison.as_ref())
                .map(|ec| ec.must_match.contains(&"statusCode".to_string()))
                .unwrap_or(true);

            divergences.push(Divergence {
                severity: if is_critical {
                    Severity::Critical
                } else {
                    Severity::Expected
                },
                field: "statusCode".into(),
                message: format!(
                    "status code mismatch: primary={}, shadow={}",
                    primary.status, shadow.status
                ),
                primary_value: Some(primary.status.to_string()),
                shadow_value: Some(shadow.status.to_string()),
                category: None,
                table: None,
                key: None,
                primary_json: None,
                shadow_json: None,
            });
        }

        if !rules.compare_body {
            return divergences;
        }

        match rules.compare_mode {
            CompareMode::Json => {
                // JSON body comparison
                if let (Some(pj), Some(sj)) = (&primary.body_json, &shadow.body_json) {
                    self.compare_json(&rules, pj, sj, "", &mut divergences);
                }
            }
            CompareMode::Text => self.compare_text(&rules, primary, shadow, &mut divergences),
        }

        divergences
    }

    pub fn internal_table_specs(
        &self,
        endpoint: &str,
        selector: &InternalStateSelector,
    ) -> Vec<TableSpec> {
        let mut specs = route_table_specs(endpoint);
        let rule_key = normalize_endpoint(endpoint);
        if let Some(internal) = self
            .rules
            .as_ref()
            .and_then(|rules| rules.rules.endpoints.get(&rule_key))
            .and_then(|rule| rule.internal_state.as_ref())
        {
            for (table, rule) in &internal.tables {
                upsert_table_spec(&mut specs, table, rule);
            }
        }

        specs
            .into_iter()
            .filter(|spec| selector.includes(&spec.name))
            .collect()
    }

    pub fn compare_internal(
        &self,
        endpoint: &str,
        primary: &InternalSnapshot,
        shadow: &InternalSnapshot,
    ) -> Vec<Divergence> {
        let mut divergences = Vec::new();
        let specs = self.internal_table_specs(endpoint, &InternalStateSelector::All);
        for spec in specs {
            let table_rule = self.internal_table_rule(endpoint, &spec.name);
            let effective = internal_effective_rule(&spec, table_rule.as_ref());
            compare_internal_table(&effective, primary, shadow, &mut divergences);
        }
        divergences
    }

    fn internal_table_rule(&self, endpoint: &str, table: &str) -> Option<InternalTableRule> {
        let rule_key = normalize_endpoint(endpoint);
        self.rules
            .as_ref()
            .and_then(|rules| rules.rules.endpoints.get(&rule_key))
            .and_then(|rule| rule.internal_state.as_ref())
            .and_then(|internal| internal.tables.get(table))
            .cloned()
    }

    fn effective_rules(&self, endpoint: &str) -> EffectiveRules<'_> {
        // Normalize endpoint for rule lookup (strip path params)
        let rule_key = normalize_endpoint(endpoint);
        let rules_file = self.rules.as_ref();
        let endpoint_rule = rules_file.and_then(|r| r.rules.endpoints.get(&rule_key));
        let default_rule = rules_file.map(|r| &r.rules.default);

        let ignore_fields: Vec<&str> = match (endpoint_rule, default_rule) {
            (Some(er), _) => er.ignore_fields.iter().map(|s| s.as_str()).collect(),
            (None, Some(default)) => default.ignore_fields.iter().map(|s| s.as_str()).collect(),
            (None, None) => vec!["updatedAt", "createdAt"],
        };

        let compare_mode = endpoint_rule
            .and_then(|r| r.compare_mode.as_deref())
            .or_else(|| default_rule.and_then(|r| r.compare_mode.as_deref()))
            .and_then(parse_compare_mode)
            .unwrap_or(CompareMode::Json);

        let compare_body = endpoint_rule
            .and_then(|r| r.compare_body)
            .or_else(|| default_rule.and_then(|r| r.compare_body))
            .or_else(|| {
                rules_file
                    .and_then(|r| r.error_comparison.as_ref())
                    .and_then(|ec| ec.compare_body)
            })
            .unwrap_or(true);

        let timestamp_precision = endpoint_rule
            .and_then(|r| r.timestamp_precision.as_deref())
            .or_else(|| default_rule.and_then(|r| r.timestamp_precision.as_deref()))
            .and_then(parse_timestamp_precision);

        let array_ordering = endpoint_rule
            .and_then(|r| r.array_ordering.as_deref())
            .or_else(|| default_rule.and_then(|r| r.array_ordering.as_deref()))
            .and_then(parse_array_ordering)
            .unwrap_or(ArrayOrdering::Ordered);

        EffectiveRules {
            endpoint_rule,
            ignore_fields,
            tolerance: endpoint_rule.and_then(|r| r.tolerance.as_ref()),
            compare_mode,
            compare_body,
            timestamp_precision,
            array_ordering,
        }
    }

    fn compare_text(
        &self,
        rules: &EffectiveRules<'_>,
        primary: &ForwardResponse,
        shadow: &ForwardResponse,
        divergences: &mut Vec<Divergence>,
    ) {
        let primary_body = String::from_utf8_lossy(&primary.body_bytes);
        let shadow_body = String::from_utf8_lossy(&shadow.body_bytes);
        if primary_body != shadow_body {
            divergences.push(Divergence {
                severity: field_severity(rules.endpoint_rule, "body"),
                field: "body".into(),
                message: "text body mismatch".into(),
                primary_value: Some(redact_text_body(&primary_body)),
                shadow_value: Some(redact_text_body(&shadow_body)),
                category: None,
                table: None,
                key: None,
                primary_json: None,
                shadow_json: None,
            });
        }
    }

    fn compare_json(
        &self,
        rules: &EffectiveRules<'_>,
        primary: &serde_json::Value,
        shadow: &serde_json::Value,
        path: &str,
        divergences: &mut Vec<Divergence>,
    ) {
        // Check if this path is in the ignore list
        if should_ignore(path, &rules.ignore_fields) {
            return;
        }

        match (primary, shadow) {
            (serde_json::Value::Object(pm), serde_json::Value::Object(sm)) => {
                // Check all keys in primary
                for (key, pval) in pm {
                    let field_path = if path.is_empty() {
                        key.clone()
                    } else {
                        format!("{path}.{key}")
                    };

                    if should_ignore(&field_path, &rules.ignore_fields) {
                        continue;
                    }

                    match sm.get(key) {
                        Some(sval) => {
                            self.compare_json(rules, pval, sval, &field_path, divergences);
                        }
                        None => {
                            let severity = field_severity(rules.endpoint_rule, &field_path);
                            let primary_value = redact_response_value(pval, &field_path);
                            divergences.push(Divergence {
                                severity,
                                field: log_safe_field(&field_path),
                                message: "field missing in shadow response".into(),
                                primary_value: Some(primary_value),
                                shadow_value: None,
                                category: None,
                                table: None,
                                key: None,
                                primary_json: None,
                                shadow_json: None,
                            });
                        }
                    }
                }

                // Check for extra keys in shadow
                for key in sm.keys() {
                    if !pm.contains_key(key) {
                        let field_path = if path.is_empty() {
                            key.clone()
                        } else {
                            format!("{path}.{key}")
                        };

                        if should_ignore(&field_path, &rules.ignore_fields) {
                            continue;
                        }

                        let shadow_value = redact_response_value(&sm[key], &field_path);
                        divergences.push(Divergence {
                            severity: Severity::Expected,
                            field: log_safe_field(&field_path),
                            message: "extra field in shadow response".into(),
                            primary_value: None,
                            shadow_value: Some(shadow_value),
                            category: None,
                            table: None,
                            key: None,
                            primary_json: None,
                            shadow_json: None,
                        });
                    }
                }
            }
            (serde_json::Value::Array(pa), serde_json::Value::Array(sa)) => {
                if matches!(rules.array_ordering, ArrayOrdering::Unordered) {
                    self.compare_unordered_array(rules, pa, sa, path, divergences);
                } else {
                    self.compare_ordered_array(rules, pa, sa, path, divergences);
                }
            }
            _ => self.compare_leaf(rules, primary, shadow, path, divergences),
        }
    }

    fn compare_ordered_array(
        &self,
        rules: &EffectiveRules<'_>,
        primary: &[serde_json::Value],
        shadow: &[serde_json::Value],
        path: &str,
        divergences: &mut Vec<Divergence>,
    ) {
        if primary.len() != shadow.len() {
            let severity = field_severity(rules.endpoint_rule, path);
            divergences.push(Divergence {
                severity,
                field: log_safe_field(&format_array_length_path(path)),
                message: format!(
                    "array length mismatch: primary={}, shadow={}",
                    primary.len(),
                    shadow.len()
                ),
                primary_value: Some(primary.len().to_string()),
                shadow_value: Some(shadow.len().to_string()),
                category: None,
                table: None,
                key: None,
                primary_json: None,
                shadow_json: None,
            });
        }

        // Compare element by element up to min length
        let min_len = primary.len().min(shadow.len());
        for i in 0..min_len {
            let elem_path = format_array_element_path(path, &i.to_string());
            self.compare_json(rules, &primary[i], &shadow[i], &elem_path, divergences);
        }
    }

    fn compare_unordered_array(
        &self,
        rules: &EffectiveRules<'_>,
        primary: &[serde_json::Value],
        shadow: &[serde_json::Value],
        path: &str,
        divergences: &mut Vec<Divergence>,
    ) {
        let primary_canonical = canonical_array(primary, rules, path);
        let shadow_canonical = canonical_array(shadow, rules, path);
        if primary_canonical == shadow_canonical {
            return;
        }

        if primary.len() != shadow.len() {
            let severity = field_severity(rules.endpoint_rule, path);
            divergences.push(Divergence {
                severity,
                field: log_safe_field(&format_array_length_path(path)),
                message: format!(
                    "array length mismatch: primary={}, shadow={}",
                    primary.len(),
                    shadow.len()
                ),
                primary_value: Some(primary.len().to_string()),
                shadow_value: Some(shadow.len().to_string()),
                category: None,
                table: None,
                key: None,
                primary_json: None,
                shadow_json: None,
            });
        }

        let mut primary_items = sorted_canonical_indexes(primary, rules, path);
        let shadow_items = sorted_canonical_indexes(shadow, rules, path);
        let mut matched_shadow = vec![false; shadow.len()];
        let match_path = format_array_element_path(path, "*");

        for (_, primary_index) in primary_items.drain(..) {
            let mut matched_index = None;
            for (_, shadow_index) in &shadow_items {
                if matched_shadow[*shadow_index] {
                    continue;
                }

                let mut trial = Vec::new();
                self.compare_json(
                    rules,
                    &primary[primary_index],
                    &shadow[*shadow_index],
                    &match_path,
                    &mut trial,
                );
                if trial.is_empty() {
                    matched_index = Some(*shadow_index);
                    break;
                }
            }

            if let Some(index) = matched_index {
                matched_shadow[index] = true;
            } else {
                divergences.push(Divergence {
                    severity: field_severity(rules.endpoint_rule, path),
                    field: log_safe_field(&match_path),
                    message: "array element missing in shadow response".into(),
                    primary_value: Some(redact_response_tree(&primary[primary_index], &match_path)),
                    shadow_value: None,
                    category: None,
                    table: None,
                    key: None,
                    primary_json: None,
                    shadow_json: None,
                });
            }
        }

        for (_, shadow_index) in shadow_items {
            if !matched_shadow[shadow_index] {
                divergences.push(Divergence {
                    severity: Severity::Expected,
                    field: log_safe_field(&match_path),
                    message: "extra array element in shadow response".into(),
                    primary_value: None,
                    shadow_value: Some(redact_response_tree(&shadow[shadow_index], &match_path)),
                    category: None,
                    table: None,
                    key: None,
                    primary_json: None,
                    shadow_json: None,
                });
            }
        }
    }

    fn compare_leaf(
        &self,
        rules: &EffectiveRules<'_>,
        primary: &serde_json::Value,
        shadow: &serde_json::Value,
        path: &str,
        divergences: &mut Vec<Divergence>,
    ) {
        if numeric_values_equal(primary, shadow, tolerance_for_path(rules.tolerance, path)) {
            return;
        }

        if timestamp_values_equal(primary, shadow, rules.timestamp_precision) {
            return;
        }

        if primary != shadow {
            let severity = field_severity(rules.endpoint_rule, path);
            divergences.push(Divergence {
                severity,
                field: log_safe_field(path),
                message: "value mismatch".into(),
                primary_value: Some(redact_response_value(primary, path)),
                shadow_value: Some(redact_response_value(shadow, path)),
                category: None,
                table: None,
                key: None,
                primary_json: None,
                shadow_json: None,
            });
        }
    }
}

// ---------------------------------------------------------------------------
// Internal-state helpers
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InternalStateSelector {
    All,
    Tables(BTreeSet<String>),
}

impl InternalStateSelector {
    pub fn from_value(value: &str) -> Option<Self> {
        let value = value.trim();
        if value.is_empty()
            || matches!(
                value.to_ascii_lowercase().as_str(),
                "0" | "false" | "off" | "none"
            )
        {
            return None;
        }
        if matches!(
            value.to_ascii_lowercase().as_str(),
            "1" | "true" | "on" | "all"
        ) {
            return Some(Self::All);
        }
        let mut tables = BTreeSet::new();
        for raw in value.split(',') {
            match raw.trim().to_ascii_lowercase().as_str() {
                "memories" | "memory" => {
                    tables.insert("memories".to_string());
                }
                "history" | "memory_history" => {
                    tables.insert("memory_history".to_string());
                }
                "ontology" | "knowledge" | "entities" => {
                    tables.insert("entities".to_string());
                }
                "" => {}
                other => {
                    tables.insert(other.to_string());
                }
            }
        }
        if tables.is_empty() {
            None
        } else {
            Some(Self::Tables(tables))
        }
    }

    fn includes(&self, table: &str) -> bool {
        match self {
            Self::All => true,
            Self::Tables(tables) => tables.contains(table),
        }
    }
}

#[derive(Debug, Clone)]
struct EffectiveInternalTableRule {
    table: String,
    key_columns: Vec<String>,
    ignore_columns: Vec<String>,
    tolerance: Option<HashMap<String, f64>>,
    redactions: Vec<String>,
    timestamp_precision: Option<TimestampPrecision>,
    array_ordering: ArrayOrdering,
}

fn route_table_specs(endpoint: &str) -> Vec<TableSpec> {
    let normalized = normalize_endpoint(endpoint);
    let mut specs = Vec::new();
    if is_memory_endpoint(&normalized) {
        specs.push(memories_spec());
        specs.push(memory_history_spec());
        specs.push(entities_spec());
    } else if is_ontology_endpoint(&normalized) {
        specs.push(entities_spec());
    }
    specs
}

fn is_memory_endpoint(endpoint: &str) -> bool {
    endpoint.contains(" /api/memory")
        || endpoint.contains(" /memory/")
        || endpoint.contains(" /api/hook/remember")
        || endpoint.contains(" /api/hooks/remember")
        || endpoint.contains(" /api/hooks/session")
}

fn is_ontology_endpoint(endpoint: &str) -> bool {
    endpoint.contains(" /api/knowledge")
        || endpoint.contains(" /api/ontology")
        || endpoint.contains(" /api/graphiq")
}

fn memories_spec() -> TableSpec {
    TableSpec::new(
        "memories",
        vec![
            "content_hash",
            "agent_id",
            "visibility",
            "scope",
            "idempotency_key",
            "source_id",
        ],
        vec![
            "id",
            "content",
            "content_hash",
            "normalized_content",
            "agent_id",
            "visibility",
            "scope",
            "source_type",
            "source_id",
            "source_path",
            "runtime_path",
            "idempotency_key",
            "is_deleted",
            "version",
        ],
        vec!["created_at", "updated_at", "deleted_at", "last_accessed"],
    )
}

fn memory_history_spec() -> TableSpec {
    TableSpec::new(
        "memory_history",
        vec![
            "memory_content_hash",
            "memory_agent_id",
            "memory_visibility",
            "memory_scope",
            "memory_idempotency_key",
            "memory_source_id",
            "event",
            "reason",
        ],
        vec![
            "id",
            "memory_id",
            "event",
            "old_content",
            "new_content",
            "changed_by",
            "reason",
            "metadata",
            "actor_type",
            "session_id",
            "request_id",
        ],
        vec!["created_at"],
    )
}

fn entities_spec() -> TableSpec {
    TableSpec::new(
        "entities",
        vec!["id"],
        vec![
            "id",
            "name",
            "canonical_name",
            "entity_type",
            "description",
            "agent_id",
            "status",
            "mentions",
            "pinned",
        ],
        vec!["created_at", "updated_at", "pinned_at", "embedding"],
    )
}

fn upsert_table_spec(specs: &mut Vec<TableSpec>, table: &str, rule: &InternalTableRule) {
    let mut spec = specs
        .iter()
        .position(|spec| spec.name == table)
        .map(|index| specs.remove(index))
        .unwrap_or_else(|| TableSpec {
            name: table.to_string(),
            key_columns: rule.key.clone().unwrap_or_else(|| vec!["id".to_string()]),
            columns: rule.columns.clone().unwrap_or_default(),
            ignore_columns: rule.ignore_columns.clone().unwrap_or_default(),
        });

    if let Some(key) = &rule.key {
        spec.key_columns = key.clone();
    }
    if let Some(columns) = &rule.columns {
        spec.columns = columns.clone();
    }
    if let Some(ignore_columns) = &rule.ignore_columns {
        spec.ignore_columns = ignore_columns.clone();
    }
    specs.push(spec);
}

fn internal_effective_rule(
    spec: &TableSpec,
    rule: Option<&InternalTableRule>,
) -> EffectiveInternalTableRule {
    EffectiveInternalTableRule {
        table: spec.name.clone(),
        key_columns: rule
            .and_then(|rule| rule.key.clone())
            .unwrap_or_else(|| spec.key_columns.clone()),
        ignore_columns: rule
            .and_then(|rule| rule.ignore_columns.clone())
            .unwrap_or_else(|| spec.ignore_columns.clone()),
        tolerance: rule.and_then(|rule| rule.tolerance.clone()),
        redactions: rule
            .and_then(|rule| rule.redactions.clone())
            .unwrap_or_default(),
        timestamp_precision: rule
            .and_then(|rule| rule.timestamp_precision.as_deref())
            .and_then(parse_timestamp_precision),
        array_ordering: rule
            .and_then(|rule| rule.array_ordering.as_deref())
            .and_then(parse_array_ordering)
            .unwrap_or(ArrayOrdering::Unordered),
    }
}

fn compare_internal_table(
    rules: &EffectiveInternalTableRule,
    primary: &InternalSnapshot,
    shadow: &InternalSnapshot,
    divergences: &mut Vec<Divergence>,
) {
    let empty = Vec::new();
    let primary_rows = primary.tables.get(&rules.table).unwrap_or(&empty);
    let shadow_rows = shadow.tables.get(&rules.table).unwrap_or(&empty);
    let primary_memory_ids = memory_identities(primary);
    let shadow_memory_ids = memory_identities(shadow);
    let primary_by_key = rows_by_key(primary_rows, rules, &primary_memory_ids);
    let shadow_by_key = rows_by_key(shadow_rows, rules, &shadow_memory_ids);

    for (key, primary_rows_for_key) in &primary_by_key {
        match shadow_by_key.get(key) {
            Some(shadow_rows_for_key) => {
                // #6 REVIEW FIX: detect duplicate-key count mismatches.
                // If one daemon wrote N rows with the same key and the other wrote M,
                // emit a count-mismatch divergence instead of silently overwriting.
                if primary_rows_for_key.len() != shadow_rows_for_key.len() {
                    divergences.push(Divergence::internal(
                        Severity::Critical,
                        &rules.table,
                        key,
                        format!("internal.{}", rules.table),
                        format!(
                            "duplicate row count mismatch: primary={}, shadow={}",
                            primary_rows_for_key.len(),
                            shadow_rows_for_key.len()
                        ),
                        Some(serde_json::json!({"primary_count": primary_rows_for_key.len()})),
                        Some(serde_json::json!({"shadow_count": shadow_rows_for_key.len()})),
                    ));
                }
                // #6 REVIEW FIX: compare ALL rows for duplicate keys, not just first.
                // [A,B] vs [A,C] must be detected. Compare each pair; if counts
                // are equal, compare element-by-element.
                if primary_rows_for_key.len() == shadow_rows_for_key.len() {
                    for (p_row, s_row) in
                        primary_rows_for_key.iter().zip(shadow_rows_for_key.iter())
                    {
                        compare_internal_row(rules, key, p_row, s_row, divergences);
                    }
                }
            }
            None => divergences.push(Divergence::internal(
                Severity::Critical,
                &rules.table,
                key,
                format!("internal.{}", rules.table),
                "row missing in shadow internal state",
                Some(redact_internal_row(
                    primary_rows_for_key
                        .first()
                        .unwrap_or(&serde_json::Value::Null),
                    rules,
                )),
                None,
            )),
        }
    }

    for (key, shadow_rows_for_key) in &shadow_by_key {
        if !primary_by_key.contains_key(key) {
            divergences.push(Divergence::internal(
                Severity::Critical,
                &rules.table,
                key,
                format!("internal.{}", rules.table),
                "extra row in shadow internal state",
                None,
                Some(redact_internal_row(
                    shadow_rows_for_key
                        .first()
                        .unwrap_or(&serde_json::Value::Null),
                    rules,
                )),
            ));
        }
    }
}

fn rows_by_key(
    rows: &[serde_json::Value],
    rules: &EffectiveInternalTableRule,
    memory_identities: &BTreeMap<String, String>,
) -> BTreeMap<String, Vec<serde_json::Value>> {
    let mut out: BTreeMap<String, Vec<serde_json::Value>> = BTreeMap::new();
    for (index, row) in rows.iter().enumerate() {
        let key =
            row_key(row, rules, memory_identities).unwrap_or_else(|| format!("$index:{index}"));
        out.entry(key).or_default().push(row.clone());
    }
    out
}

fn row_key(
    row: &serde_json::Value,
    rules: &EffectiveInternalTableRule,
    memory_identities: &BTreeMap<String, String>,
) -> Option<String> {
    if rules.table == "memories" {
        return deterministic_memory_key(row, &rules.key_columns);
    }
    if rules.table == "memory_history" {
        return deterministic_memory_history_key(row, rules, memory_identities);
    }

    let object = row.as_object()?;
    let mut parts = Vec::new();
    for column in &rules.key_columns {
        let value = object.get(column)?;
        let safe_value = redact_internal_value(column, value, rules);
        parts.push(format!("{column}={}", stable_json_string(&safe_value)));
    }
    Some(parts.join("|"))
}

fn memory_identities(snapshot: &InternalSnapshot) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    let Some(rows) = snapshot.tables.get("memories") else {
        return out;
    };
    for row in rows {
        let Some(object) = row.as_object() else {
            continue;
        };
        let Some(id) = object.get("id").and_then(serde_json::Value::as_str) else {
            continue;
        };
        if let Some(identity) = deterministic_memory_key(row, &memory_identity_columns()) {
            out.insert(id.to_string(), identity);
        }
    }
    out
}

fn deterministic_memory_key(row: &serde_json::Value, columns: &[String]) -> Option<String> {
    let object = row.as_object()?;
    let mut parts = Vec::new();
    for column in columns {
        let Some(value) = object.get(column) else {
            if is_optional_memory_identity_column(column) {
                continue;
            }
            return None;
        };
        if value.is_null() && is_optional_memory_identity_column(column) {
            continue;
        }
        let safe_value = redact_internal_value(column, value, &memory_identity_redaction_rule());
        parts.push(format!("{column}={}", stable_json_string(&safe_value)));
    }
    if parts.is_empty() {
        None
    } else {
        Some(parts.join("|"))
    }
}

fn deterministic_memory_history_key(
    row: &serde_json::Value,
    rules: &EffectiveInternalTableRule,
    memory_identities: &BTreeMap<String, String>,
) -> Option<String> {
    let object = row.as_object()?;
    let mut parts = Vec::new();
    for column in &rules.key_columns {
        if let Some(parent_column) = column.strip_prefix("memory_") {
            let Some(memory_identity) =
                memory_identity_part(object, parent_column, memory_identities)
            else {
                if is_optional_memory_identity_column(parent_column) {
                    continue;
                }
                return None;
            };
            if memory_identity.is_empty() && is_optional_memory_identity_column(parent_column) {
                continue;
            }
            parts.push(format!("{column}={memory_identity}"));
            continue;
        }

        let Some(value) = object.get(column) else {
            return None;
        };
        let safe_value = redact_internal_value(column, value, rules);
        parts.push(format!("{column}={}", stable_json_string(&safe_value)));
    }
    if parts.is_empty() {
        None
    } else {
        Some(parts.join("|"))
    }
}

fn memory_identity_part(
    history: &serde_json::Map<String, serde_json::Value>,
    parent_column: &str,
    memory_identities: &BTreeMap<String, String>,
) -> Option<String> {
    let memory_id = history.get("memory_id")?.as_str()?;
    let identity = memory_identities.get(memory_id)?;
    identity
        .split('|')
        .find_map(|part| part.strip_prefix(&format!("{parent_column}=")))
        .map(str::to_string)
}

fn memory_identity_columns() -> Vec<String> {
    [
        "content_hash",
        "agent_id",
        "visibility",
        "scope",
        "idempotency_key",
        "source_id",
    ]
    .into_iter()
    .map(str::to_string)
    .collect()
}

fn is_optional_memory_identity_column(column: &str) -> bool {
    matches!(column, "idempotency_key" | "source_id")
}

fn compare_internal_row(
    rules: &EffectiveInternalTableRule,
    key: &str,
    primary: &serde_json::Value,
    shadow: &serde_json::Value,
    divergences: &mut Vec<Divergence>,
) {
    let Some(primary_obj) = primary.as_object() else {
        return;
    };
    let Some(shadow_obj) = shadow.as_object() else {
        divergences.push(Divergence::internal(
            Severity::Critical,
            &rules.table,
            key,
            format!("internal.{}", rules.table),
            "row shape mismatch",
            Some(redact_internal_row(primary, rules)),
            Some(redact_internal_row(shadow, rules)),
        ));
        return;
    };

    for (column, primary_value) in primary_obj {
        if should_ignore_internal_column(column, rules) {
            continue;
        }
        let field = format!("internal.{}.{}", rules.table, column);
        match shadow_obj.get(column) {
            Some(shadow_value) => compare_internal_value(
                rules,
                key,
                &field,
                column,
                primary_value,
                shadow_value,
                divergences,
            ),
            None => divergences.push(Divergence::internal(
                Severity::Critical,
                &rules.table,
                key,
                field,
                "column missing in shadow internal state",
                Some(redact_internal_value(column, primary_value, rules)),
                None,
            )),
        }
    }

    for (column, shadow_value) in shadow_obj {
        if primary_obj.contains_key(column) || should_ignore_internal_column(column, rules) {
            continue;
        }
        divergences.push(Divergence::internal(
            Severity::Critical,
            &rules.table,
            key,
            format!("internal.{}.{}", rules.table, column),
            "extra column in shadow internal state",
            None,
            Some(redact_internal_value(column, shadow_value, rules)),
        ));
    }
}

fn compare_internal_value(
    rules: &EffectiveInternalTableRule,
    key: &str,
    field: &str,
    column: &str,
    primary: &serde_json::Value,
    shadow: &serde_json::Value,
    divergences: &mut Vec<Divergence>,
) {
    let primary = redact_internal_value(column, primary, rules);
    let shadow = redact_internal_value(column, shadow, rules);
    if numeric_values_equal(
        &primary,
        &shadow,
        tolerance_for_path(rules.tolerance.as_ref(), field),
    ) {
        return;
    }
    if timestamp_values_equal(&primary, &shadow, rules.timestamp_precision) {
        return;
    }

    match (&primary, &shadow) {
        (serde_json::Value::Array(primary_items), serde_json::Value::Array(shadow_items))
            if matches!(rules.array_ordering, ArrayOrdering::Unordered) =>
        {
            let mut primary_sorted = primary_items
                .iter()
                .map(stable_json_string)
                .collect::<Vec<_>>();
            let mut shadow_sorted = shadow_items
                .iter()
                .map(stable_json_string)
                .collect::<Vec<_>>();
            primary_sorted.sort();
            shadow_sorted.sort();
            if primary_sorted == shadow_sorted {
                return;
            }
        }
        _ => {}
    }

    if primary != shadow {
        divergences.push(Divergence::internal(
            Severity::Critical,
            &rules.table,
            key,
            field.to_string(),
            "internal value mismatch",
            Some(primary),
            Some(shadow),
        ));
    }
}

fn should_ignore_internal_column(column: &str, rules: &EffectiveInternalTableRule) -> bool {
    rules.ignore_columns.iter().any(|ignored| ignored == column)
        || is_generated_internal_id_column(&rules.table, column)
}

fn is_generated_internal_id_column(table: &str, column: &str) -> bool {
    matches!(
        (table, column),
        ("memories", "id") | ("memory_history", "id" | "memory_id")
    )
}

fn redact_internal_row(
    row: &serde_json::Value,
    rules: &EffectiveInternalTableRule,
) -> serde_json::Value {
    let Some(object) = row.as_object() else {
        return redact_internal_value("row", row, rules);
    };
    let mut redacted = serde_json::Map::new();
    for (column, value) in object {
        redacted.insert(column.clone(), redact_internal_value(column, value, rules));
    }
    serde_json::Value::Object(redacted)
}

fn redact_internal_value(
    column: &str,
    value: &serde_json::Value,
    rules: &EffectiveInternalTableRule,
) -> serde_json::Value {
    if rules.redactions.iter().any(|pattern| pattern == column) {
        return serde_json::Value::String("[REDACTED]".into());
    }
    redact_json_for_log(
        value,
        column,
        is_secret_like(column),
        CompositeRedaction::PreserveStructure,
    )
}

fn memory_identity_redaction_rule() -> EffectiveInternalTableRule {
    EffectiveInternalTableRule {
        table: "memories".to_string(),
        key_columns: memory_identity_columns(),
        ignore_columns: Vec::new(),
        tolerance: None,
        redactions: Vec::new(),
        timestamp_precision: None,
        array_ordering: ArrayOrdering::Unordered,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CompositeRedaction {
    Fingerprint,
    PreserveStructure,
}

/// Format a JSON path for the divergence `field` with sensitive segments
/// fingerprinted. Prevents secrets embedded as object keys (e.g.
/// {"credentials":{"sk-live-...":true}}) from leaking via the field path.
/// Array indices pass through; sensitive/non-allowlisted field names become
/// [REDACTED sha64=...].
fn log_safe_field(path: &str) -> String {
    let mut out = String::new();
    let mut first = true;
    for raw_segment in path.split('.') {
        if !first {
            out.push('.');
        }
        first = false;
        let (name, rest) = match raw_segment.find('[') {
            Some(idx) => (&raw_segment[..idx], &raw_segment[idx..]),
            None => (raw_segment, ""),
        };
        if name.is_empty() {
            out.push_str(raw_segment);
            continue;
        }
        if is_sensitive_field_name(name) || !is_log_safe_scalar_path(name) {
            let fp = redacted_fingerprint(&serde_json::Value::String(name.to_string()));
            out.push_str(&fp.to_string());
        } else {
            out.push_str(name);
        }
        // Defensive: only preserve generated array suffixes ([12], [*]). The
        // path builder only ever emits numeric indices, but if a future change
        // ever introduces a non-numeric bracket suffix (e.g. a bracketed object
        // key), fingerprint it rather than leak it verbatim.
        if !rest.is_empty() && !bracket_suffix_is_safe(rest) {
            let fp = redacted_fingerprint(&serde_json::Value::String(rest.to_string()));
            out.push_str(&fp.to_string());
        } else {
            out.push_str(rest);
        }
    }
    out
}

/// True when a bracket suffix consists solely of safe array-index segments
/// like `[3]`, `[*]`, or `[0][1]` — never arbitrary (secret-bearing) text.
fn bracket_suffix_is_safe(suffix: &str) -> bool {
    // Each segment MUST be a closed [..] with inner '*' or ASCII digits.
    // Rejects malformed suffixes (e.g. `id[123` unclosed) and secret-shaped
    // object keys that happen to contain '['.
    let mut rest = suffix;
    loop {
        let Some(after_open) = rest.strip_prefix('[') else {
            return rest.is_empty();
        };
        let Some(close_idx) = after_open.find(']') else {
            return false;
        };
        let inner = &after_open[..close_idx];
        if !(inner == "*" || (!inner.is_empty() && inner.chars().all(|c| c.is_ascii_digit()))) {
            return false;
        }
        rest = &after_open[close_idx + 1..];
    }
}

fn redact_response_value(value: &serde_json::Value, path: &str) -> String {
    truncate_str(
        &redact_json_for_log(value, path, false, CompositeRedaction::Fingerprint).to_string(),
    )
}

fn redact_response_tree(value: &serde_json::Value, path: &str) -> String {
    truncate_str(
        &redact_json_for_log(value, path, false, CompositeRedaction::Fingerprint).to_string(),
    )
}

/// Redact a text body if it looks like JSON; otherwise fingerprint the whole
/// opaque body. Text bodies are freeform by contract, so even parseable JSON is
/// redacted under the sensitive `body` parent instead of trusting field names.
fn redact_text_body(body: &str) -> String {
    if let Ok(value) = serde_json::from_str::<serde_json::Value>(body) {
        return redact_response_tree(&value, "body");
    }
    redacted_fingerprint(&serde_json::Value::String(body.to_string())).to_string()
}

fn redact_json_for_log(
    value: &serde_json::Value,
    path: &str,
    inherited_sensitive: bool,
    composite_redaction: CompositeRedaction,
) -> serde_json::Value {
    let path_sensitive = inherited_sensitive || path_has_sensitive_segment(path);
    match value {
        serde_json::Value::Null => value.clone(),
        serde_json::Value::Bool(_) | serde_json::Value::Number(_) => {
            // A numeric/bool value under a sensitive path (e.g. {"token":123456})
            // must still be fingerprinted, not logged verbatim.
            if path_sensitive {
                redacted_fingerprint(value)
            } else {
                value.clone()
            }
        }
        serde_json::Value::String(text) => {
            if path_sensitive || !is_log_safe_scalar_path(path) || !is_log_safe_string(path, text) {
                redacted_fingerprint(value)
            } else {
                value.clone()
            }
        }
        serde_json::Value::Object(map) => {
            if should_fingerprint_composite(path, path_sensitive, composite_redaction) {
                return redacted_fingerprint(value);
            }
            let deny_descendants = deny_composite_descendants(path, path_sensitive);
            let mut out = serde_json::Map::with_capacity(map.len());
            for (key, child) in map {
                let child_path = join_path(path, key);
                let child_sensitive = deny_descendants || is_sensitive_field_name(key);
                out.insert(
                    key.clone(),
                    redact_json_for_log(child, &child_path, child_sensitive, composite_redaction),
                );
            }
            serde_json::Value::Object(out)
        }
        serde_json::Value::Array(items) => {
            if should_fingerprint_composite(path, path_sensitive, composite_redaction) {
                return redacted_fingerprint(value);
            }
            let deny_descendants = deny_composite_descendants(path, path_sensitive);
            serde_json::Value::Array(
                items
                    .iter()
                    .map(|item| {
                        redact_json_for_log(item, path, deny_descendants, composite_redaction)
                    })
                    .collect(),
            )
        }
    }
}

fn should_fingerprint_composite(
    path: &str,
    path_sensitive: bool,
    composite_redaction: CompositeRedaction,
) -> bool {
    path_sensitive
        || matches!(composite_redaction, CompositeRedaction::Fingerprint) && !path.is_empty()
}

fn deny_composite_descendants(path: &str, path_sensitive: bool) -> bool {
    path_sensitive || !path.is_empty() && !is_log_safe_scalar_path(path)
}

fn join_path(parent: &str, child: &str) -> String {
    if parent.is_empty() {
        child.to_string()
    } else {
        format!("{parent}.{child}")
    }
}

fn is_log_safe_scalar_path(path: &str) -> bool {
    path_leaf_field(path)
        .as_deref()
        .map(is_log_safe_scalar_field)
        .unwrap_or(false)
}

fn is_log_safe_scalar_field(field: &str) -> bool {
    matches!(
        normalize_field_name(field).as_str(),
        "id" | "memoryid"
            | "sessionid"
            | "requestid"
            | "sourceid"
            | "idempotencykey"
            | "status"
            | "state"
            | "version"
            | "isdeleted"
            | "deletedat"
            | "agentid"
            | "visibility"
            | "scope"
            | "sourcetype"
            | "runtimepath"
            | "event"
            | "createdat"
            | "updatedat"
            | "lastaccessed"
            | "contenthash"
            | "dimensions"
            | "count"
            | "total"
            | "limit"
            | "offset"
            | "method"
            | "path"
            | "route"
            | "statuscode"
            | "ok"
            | "toolcount"
            | "resourcecount"
            | "entitytype"
            | "actortype"
            | "changedby"
            | "confidence"
            | "score"
            // Daemon diagnostic fields (safe structural/runtime metadata, never
            // memory content or secrets — needed so the divergence log is
            // readable for /health, /api/status, /api/config comparisons).
            | "uptime"
            | "pid"
            | "port"
            | "host"
            | "bindhost"
            | "bind"
            | "agentsdir"
            | "agentsdirpath"
            | "db"
            | "memorydb"
            | "shuttingdown"
            | "updateavailable"
            | "pendingrestart"
            | "startedat"
            | "networkmode"
            | "activesessions"
            | "bypassedsessions"
            | "agentcreatedat"
            | "extractionrunning"
            | "extractionstalled"
            | "extractionpending"
            | "extractionbackoffms"
            | "heapused"
            | "rss"
            | "sockets"
            | "inotify"
            | "pipes"
            | "other"
            | "total"
            | "memorymd"
            | "feature"
            | "features"
            | "name"
            | "type"
            | "key"
            | "enabled"
            | "disabled"
            | "mode"
            | "provider"
            | "model"
            | "pending"
            | "queued"
            | "completed"
            | "failed"
            | "dead"
            | "processing"
            | "leased"
            | "attempts"
            | "maxattempts"
            | "leaseexpiresat"
            | "priority"
            | "tag"
            | "tags"
            | "category"
            | "categories"
            | "source"
            | "target"
            | "action"
            | "verb"
            | "reason"
            | "sha"
            | "size"
            | "duration"
            | "latency"
            | "timestamp"
            | "url"
            | "uri"
            | "harness"
            | "exists"
            | "present"
            | "missing"
            | "found"
            | "healthy"
            | "ready"
            | "available"
            | "installed"
            | "uninstalled"
            | "verified"
            | "permissions"
            | "role"
            | "roles"
            | "permission"
    )
}

fn is_log_safe_string(path: &str, value: &str) -> bool {
    const MAX_SAFE_STRING_BYTES: usize = 128;
    let Some(field) = path_leaf_field(path) else {
        return false;
    };
    if is_sensitive_field_name(&field)
        || value.is_empty()
        || value.len() > MAX_SAFE_STRING_BYTES
        || value.contains(['\n', '\r'])
    {
        return false;
    }
    normalize_field_name(&field) == "contenthash" || !looks_secret_like_value(value)
}

fn looks_secret_like_value(value: &str) -> bool {
    let normalized = value.to_ascii_lowercase();
    [
        "secret",
        "password",
        "token",
        "bearer ",
        "apikey",
        "api_key",
        "private key",
        "credential",
        "sk-",
        "planted",
    ]
    .iter()
    .any(|needle| normalized.contains(needle))
}

fn path_has_sensitive_segment(path: &str) -> bool {
    path_field_names(path)
        .iter()
        .any(|field| is_sensitive_field_name(field))
}

fn path_leaf_field(path: &str) -> Option<String> {
    path_field_names(path).pop()
}

fn path_field_names(path: &str) -> Vec<String> {
    path.split('.')
        .filter_map(|segment| {
            let field = segment
                .split_once('[')
                .map(|(head, _)| head)
                .unwrap_or(segment);
            if field.is_empty() {
                None
            } else {
                Some(field.to_string())
            }
        })
        .collect()
}

fn is_sensitive_field_name(field: &str) -> bool {
    let normalized = normalize_field_name(field);
    if normalized.is_empty() {
        return false;
    }
    const SENSITIVE_SUBSTRINGS: &[&str] = &[
        "apikey",
        "token",
        "secret",
        "password",
        "clientsecret",
        "accesstoken",
        "refreshtoken",
        "authtoken",
        "credential",
        "authorization",
        "cookie",
        "privatekey",
    ];
    if SENSITIVE_SUBSTRINGS
        .iter()
        .any(|needle| normalized.contains(needle))
    {
        return true;
    }
    matches!(
        normalized.as_str(),
        "content"
            | "normalizedcontent"
            | "oldcontent"
            | "newcontent"
            | "sourceraw"
            | "rawcontent"
            | "chunktext"
            | "transcript"
            | "prompt"
            | "completion"
            | "response"
            | "body"
            | "text"
            | "reason"
            | "metadata"
            | "description"
            | "summary"
            | "summaryprompt"
            | "note"
            | "value"
            | "inject"
            | "injection"
            | "injections"
            | "recentcontext"
            | "systemprompt"
            | "hiddenprompt"
            | "memories"
            | "memory"
            | "recall"
            | "context"
    ) || (normalized.ends_with("content") && normalized != "contenthash")
        || normalized.ends_with("raw")
        || normalized.ends_with("prompt")
}

fn normalize_field_name(field: &str) -> String {
    field
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

fn redacted_fingerprint(value: &serde_json::Value) -> serde_json::Value {
    if value.is_null() {
        return serde_json::Value::Null;
    }
    let canonical = stable_json_string(value);
    serde_json::Value::String(format!(
        "[REDACTED sha64={:016x} bytes={}]",
        stable_hash64(&canonical),
        canonical.len()
    ))
}

fn stable_hash64(value: &str) -> u64 {
    const FNV_OFFSET: u64 = 0xcbf29ce484222325;
    const FNV_PRIME: u64 = 0x100000001b3;
    let mut hash = FNV_OFFSET;
    for byte in value.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(FNV_PRIME);
    }
    hash
}

fn stable_json_string(value: &serde_json::Value) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| String::new())
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Normalize "GET /api/memory/abc123" → "GET /api/memory/:id"
fn normalize_endpoint(endpoint: &str) -> String {
    let parts: Vec<&str> = endpoint.splitn(2, ' ').collect();
    if parts.len() != 2 {
        return endpoint.to_string();
    }

    let method = parts[0];
    let path = parts[1];

    // Replace UUID-like segments and numeric IDs with :id
    let normalized: Vec<&str> = path
        .split('/')
        .map(|seg| {
            if (seg.len() == 36 && seg.contains('-'))
                || (!seg.is_empty() && seg.chars().all(|c| c.is_ascii_digit()))
            {
                ":id"
            } else {
                seg
            }
        })
        .collect();

    format!("{method} {}", normalized.join("/"))
}

fn parse_compare_mode(value: &str) -> Option<CompareMode> {
    match value.to_ascii_lowercase().as_str() {
        "json" => Some(CompareMode::Json),
        "text" => Some(CompareMode::Text),
        _ => None,
    }
}

fn parse_array_ordering(value: &str) -> Option<ArrayOrdering> {
    match value.to_ascii_lowercase().as_str() {
        "ordered" => Some(ArrayOrdering::Ordered),
        "unordered" => Some(ArrayOrdering::Unordered),
        _ => None,
    }
}

fn parse_timestamp_precision(value: &str) -> Option<TimestampPrecision> {
    match value.to_ascii_lowercase().as_str() {
        "ms" | "millisecond" | "milliseconds" => Some(TimestampPrecision::Millisecond),
        "s" | "sec" | "second" | "seconds" => Some(TimestampPrecision::Second),
        "ignore" => Some(TimestampPrecision::Ignore),
        _ => None,
    }
}

fn should_ignore(path: &str, ignore_fields: &[&str]) -> bool {
    for pattern in ignore_fields {
        if path == *pattern {
            return true;
        }
        // Handle wildcard patterns like "memories.*.createdAt"
        if pattern.contains('*') {
            let re = pattern.replace(".*.", ".\\d+.").replace('*', "[^.]+");
            if let Ok(regex) = regex_lite::Regex::new(&format!("^{re}$"))
                && regex.is_match(path)
            {
                return true;
            }
            // Also check simple suffix match for "memories.*.field" → "memories[0].field"
            let suffix = pattern.rsplit_once('.').map(|(_, s)| s).unwrap_or(pattern);
            if path.ends_with(suffix) && pattern.contains('*') {
                return true;
            }
        }
    }
    false
}

fn field_severity(rule: Option<&EndpointRule>, path: &str) -> Severity {
    match rule {
        Some(r) => {
            // If the field matches a deterministic pattern, it's critical
            for det in &r.deterministic {
                if path == det || det.contains('*') && path_matches_pattern(path, det) {
                    return Severity::Critical;
                }
            }
            // If it's in ignore list, it's expected
            for ign in &r.ignore_fields {
                if path == ign || ign.contains('*') && path_matches_pattern(path, ign) {
                    return Severity::Expected;
                }
            }
            // Endpoint rules intentionally list deterministic fields that
            // block cutover. Other observed differences are still logged, but
            // are expected until the rule declares them deterministic.
            Severity::Expected
        }
        None => Severity::Critical,
    }
}

fn path_matches_pattern(path: &str, pattern: &str) -> bool {
    let suffix = pattern.rsplit_once('.').map(|(_, s)| s).unwrap_or(pattern);
    path.ends_with(suffix)
}

fn tolerance_for_path<'a>(tolerances: Option<&'a HashMap<String, f64>>, path: &str) -> Option<f64> {
    tolerances.and_then(|map| {
        map.iter().find_map(|(pattern, tolerance)| {
            let matches = path == pattern
                || path.ends_with(&format!(".{pattern}"))
                || path_matches_pattern(path, pattern);
            if matches {
                Some(tolerance.max(0.0))
            } else {
                None
            }
        })
    })
}

fn numeric_values_equal(
    primary: &serde_json::Value,
    shadow: &serde_json::Value,
    tolerance: Option<f64>,
) -> bool {
    let Some(tolerance) = tolerance else {
        return false;
    };
    let (Some(primary), Some(shadow)) = (primary.as_f64(), shadow.as_f64()) else {
        return false;
    };
    (primary - shadow).abs() <= tolerance
}

fn timestamp_values_equal(
    primary: &serde_json::Value,
    shadow: &serde_json::Value,
    precision: Option<TimestampPrecision>,
) -> bool {
    let Some(precision) = precision else {
        return false;
    };
    let (Some(primary), Some(shadow)) = (primary.as_str(), shadow.as_str()) else {
        return false;
    };

    match precision {
        TimestampPrecision::Ignore => is_iso_timestamp(primary) && is_iso_timestamp(shadow),
        TimestampPrecision::Millisecond => {
            let (Some(primary), Some(shadow)) =
                (parse_iso_timestamp(primary), parse_iso_timestamp(shadow))
            else {
                return false;
            };
            rounded_timestamp_millis(&primary) == rounded_timestamp_millis(&shadow)
        }
        TimestampPrecision::Second => {
            let (Some(primary), Some(shadow)) =
                (parse_iso_timestamp(primary), parse_iso_timestamp(shadow))
            else {
                return false;
            };
            rounded_timestamp_seconds(&primary) == rounded_timestamp_seconds(&shadow)
        }
    }
}

fn is_iso_timestamp(value: &str) -> bool {
    parse_iso_timestamp(value).is_some()
}

fn parse_iso_timestamp(value: &str) -> Option<chrono::DateTime<chrono::FixedOffset>> {
    chrono::DateTime::parse_from_rfc3339(value).ok()
}

fn rounded_timestamp_millis(timestamp: &chrono::DateTime<chrono::FixedOffset>) -> i128 {
    timestamp.timestamp() as i128 * 1_000
        + (timestamp.timestamp_subsec_nanos() as i128 + 500_000) / 1_000_000
}

fn rounded_timestamp_seconds(timestamp: &chrono::DateTime<chrono::FixedOffset>) -> i128 {
    timestamp.timestamp() as i128 + i128::from(timestamp.timestamp_subsec_nanos() >= 500_000_000)
}

fn canonical_array(
    values: &[serde_json::Value],
    rules: &EffectiveRules<'_>,
    path: &str,
) -> Vec<String> {
    let mut canonical: Vec<String> = values
        .iter()
        .map(|value| canonical_json_string(value, rules, &format_array_element_path(path, "*")))
        .collect();
    canonical.sort();
    canonical
}

fn sorted_canonical_indexes(
    values: &[serde_json::Value],
    rules: &EffectiveRules<'_>,
    path: &str,
) -> Vec<(String, usize)> {
    let mut indexes: Vec<(String, usize)> = values
        .iter()
        .enumerate()
        .map(|(index, value)| {
            (
                canonical_json_string(value, rules, &format_array_element_path(path, "*")),
                index,
            )
        })
        .collect();
    indexes.sort_by(|left, right| left.0.cmp(&right.0).then(left.1.cmp(&right.1)));
    indexes
}

fn canonical_json_string(
    value: &serde_json::Value,
    rules: &EffectiveRules<'_>,
    path: &str,
) -> String {
    serde_json::to_string(&canonical_json(value, rules, path)).unwrap_or_else(|_| String::new())
}

fn canonical_json(
    value: &serde_json::Value,
    rules: &EffectiveRules<'_>,
    path: &str,
) -> serde_json::Value {
    if should_ignore(path, &rules.ignore_fields) {
        return serde_json::Value::String("<ignored>".into());
    }

    match value {
        serde_json::Value::Object(map) => {
            let mut sorted = BTreeMap::new();
            for (key, child) in map {
                let field_path = if path.is_empty() {
                    key.clone()
                } else {
                    format!("{path}.{key}")
                };
                if should_ignore(&field_path, &rules.ignore_fields) {
                    continue;
                }
                sorted.insert(key.clone(), canonical_json(child, rules, &field_path));
            }

            let mut object = serde_json::Map::new();
            for (key, child) in sorted {
                object.insert(key, child);
            }
            serde_json::Value::Object(object)
        }
        serde_json::Value::Array(items) => {
            let child_path = format_array_element_path(path, "*");
            let mut canonical_items: Vec<serde_json::Value> = items
                .iter()
                .map(|item| canonical_json(item, rules, &child_path))
                .collect();
            if matches!(rules.array_ordering, ArrayOrdering::Unordered) {
                canonical_items.sort_by_key(|item| {
                    serde_json::to_string(item).unwrap_or_else(|_| String::new())
                });
            }
            serde_json::Value::Array(canonical_items)
        }
        serde_json::Value::String(value) => {
            canonical_timestamp_value(value, rules.timestamp_precision)
                .unwrap_or_else(|| serde_json::Value::String(value.clone()))
        }
        _ => value.clone(),
    }
}

fn canonical_timestamp_value(
    value: &str,
    precision: Option<TimestampPrecision>,
) -> Option<serde_json::Value> {
    match precision? {
        TimestampPrecision::Ignore => {
            if is_iso_timestamp(value) {
                Some(serde_json::Value::String("<timestamp>".into()))
            } else {
                None
            }
        }
        TimestampPrecision::Millisecond => parse_iso_timestamp(value).map(|timestamp| {
            serde_json::Value::String(format!(
                "<timestamp-ms:{}>",
                rounded_timestamp_millis(&timestamp)
            ))
        }),
        TimestampPrecision::Second => parse_iso_timestamp(value).map(|timestamp| {
            serde_json::Value::String(format!(
                "<timestamp-s:{}>",
                rounded_timestamp_seconds(&timestamp)
            ))
        }),
    }
}

fn format_array_length_path(path: &str) -> String {
    if path.is_empty() {
        "length".into()
    } else {
        format!("{path}.length")
    }
}

fn format_array_element_path(path: &str, index: &str) -> String {
    if path.is_empty() {
        format!("[{index}]")
    } else {
        format!("{path}[{index}]")
    }
}

fn truncate_str(value: &str) -> String {
    const LIMIT: usize = 200;
    if value.len() <= LIMIT {
        return value.to_string();
    }

    let mut end = 0;
    for (index, _) in value.char_indices() {
        if index > LIMIT {
            break;
        }
        end = index;
    }
    format!("{}...", &value[..end])
}

#[cfg(test)]
mod tests {
    use super::*;

    fn default_rule() -> DefaultRule {
        DefaultRule {
            compare_mode: Some("json".to_string()),
            compare_body: None,
            ignore_fields: vec!["updatedAt".to_string(), "createdAt".to_string()],
            timestamp_precision: None,
            array_ordering: Some("ordered".to_string()),
        }
    }

    fn endpoint_rule() -> EndpointRule {
        EndpointRule {
            deterministic: vec![],
            ignore_fields: vec![],
            compare_mode: None,
            compare_body: None,
            timestamp_precision: None,
            tolerance: None,
            array_ordering: None,
            internal_state: None,
            note: None,
        }
    }

    fn rules_with_endpoint(endpoint: &str, endpoint_rule: EndpointRule) -> ParityRules {
        let mut endpoints = HashMap::new();
        endpoints.insert(endpoint.to_string(), endpoint_rule);
        ParityRules {
            rules: Some(RulesFile {
                rules: RulesBlock {
                    default: default_rule(),
                    endpoints,
                },
                error_comparison: Some(ErrorComparison {
                    must_match: vec!["statusCode".to_string()],
                    compare_body: Some(true),
                    ignore_fields: vec![],
                }),
            }),
        }
    }

    fn response_json(status: u16, json: serde_json::Value) -> ForwardResponse {
        ForwardResponse {
            status,
            body_bytes: bytes::Bytes::from(json.to_string()),
            body_json: Some(json),
            content_type: Some("application/json".to_string()),
        }
    }

    fn response_text(status: u16, body: &str) -> ForwardResponse {
        ForwardResponse {
            status,
            body_bytes: bytes::Bytes::from(body.to_string()),
            body_json: serde_json::from_str(body).ok(),
            content_type: Some("text/plain".to_string()),
        }
    }

    #[test]
    fn normalize_uuid_path() {
        let n = normalize_endpoint("GET /api/memory/550e8400-e29b-41d4-a716-446655440000");
        assert_eq!(n, "GET /api/memory/:id");
    }

    #[test]
    fn normalize_nested_path() {
        let n = normalize_endpoint("GET /api/memory/550e8400-e29b-41d4-a716-446655440000/history");
        assert_eq!(n, "GET /api/memory/:id/history");
    }

    #[test]
    fn normalize_no_params() {
        let n = normalize_endpoint("GET /api/memories");
        assert_eq!(n, "GET /api/memories");
    }

    #[test]
    fn ignore_field_exact() {
        assert!(should_ignore("createdAt", &["createdAt"]));
        assert!(!should_ignore("updatedAt", &["createdAt"]));
    }

    #[test]
    fn ignore_field_wildcard() {
        assert!(should_ignore(
            "memories.0.createdAt",
            &["memories.*.createdAt"]
        ));
    }

    #[test]
    fn status_mismatch_is_critical() {
        let rules = ParityRules::default();
        let primary = ForwardResponse {
            status: 200,
            body_bytes: bytes::Bytes::new(),
            body_json: None,
            content_type: None,
        };
        let shadow = ForwardResponse {
            status: 500,
            body_bytes: bytes::Bytes::new(),
            body_json: None,
            content_type: None,
        };
        let divs = rules.compare("GET /health", &primary, &shadow);
        assert_eq!(divs.len(), 1);
        assert!(matches!(divs[0].severity, Severity::Critical));
    }

    #[test]
    fn ruled_endpoint_only_marks_deterministic_fields_critical() {
        let rule = EndpointRule {
            deterministic: vec!["status".to_string()],
            ignore_fields: vec!["version".to_string()],
            compare_mode: None,
            compare_body: None,
            timestamp_precision: None,
            tolerance: None,
            array_ordering: None,
            internal_state: None,
            note: None,
        };

        assert!(matches!(
            field_severity(Some(&rule), "status"),
            Severity::Critical
        ));
        assert!(matches!(
            field_severity(Some(&rule), "version"),
            Severity::Expected
        ));
        assert!(matches!(
            field_severity(Some(&rule), "runtimeOnlyField"),
            Severity::Expected
        ));
        assert!(matches!(
            field_severity(None, "runtimeOnlyField"),
            Severity::Critical
        ));
    }

    #[test]
    fn identical_responses_no_divergence() {
        let rules = ParityRules::default();
        let json = serde_json::json!({"status": "ok", "count": 42});
        let primary = response_json(200, json.clone());
        let shadow = response_json(200, json);
        let divs = rules.compare("GET /health", &primary, &shadow);
        assert!(divs.is_empty());
    }

    #[test]
    fn unordered_array_equality_ignores_order() {
        let mut rule = endpoint_rule();
        rule.array_ordering = Some("unordered".to_string());
        let rules = rules_with_endpoint("POST /api/memory/recall", rule);
        let primary = response_json(
            200,
            serde_json::json!({
                "results": [
                    {"id": "a", "content": "alpha"},
                    {"id": "b", "content": "beta"}
                ]
            }),
        );
        let shadow = response_json(
            200,
            serde_json::json!({
                "results": [
                    {"content": "beta", "id": "b"},
                    {"content": "alpha", "id": "a"}
                ]
            }),
        );

        let divs = rules.compare("POST /api/memory/recall", &primary, &shadow);
        assert!(divs.is_empty(), "unexpected divergences: {divs:?}");
    }

    #[test]
    fn tolerance_bands_float_values() {
        let mut tolerance = HashMap::new();
        tolerance.insert("score".to_string(), 0.05);
        let mut rule = endpoint_rule();
        rule.tolerance = Some(tolerance);
        let rules = rules_with_endpoint("GET /api/diagnostics", rule);

        let primary = response_json(200, serde_json::json!({"score": 0.80}));
        let shadow = response_json(200, serde_json::json!({"score": 0.83}));
        assert!(
            rules
                .compare("GET /api/diagnostics", &primary, &shadow)
                .is_empty()
        );

        let shadow = response_json(200, serde_json::json!({"score": 0.91}));
        let divs = rules.compare("GET /api/diagnostics", &primary, &shadow);
        assert_eq!(divs.len(), 1);
        assert_eq!(divs[0].field, "score");
    }

    #[test]
    fn timestamp_precision_rounds_to_millisecond() {
        let mut rule = endpoint_rule();
        rule.timestamp_precision = Some("ms".to_string());
        let rules = rules_with_endpoint("GET /api/events", rule);
        let primary = response_json(
            200,
            serde_json::json!({"timestamp": "2026-01-01T00:00:00.123400Z"}),
        );
        let shadow = response_json(
            200,
            serde_json::json!({"timestamp": "2026-01-01T00:00:00.123499Z"}),
        );

        let divs = rules.compare("GET /api/events", &primary, &shadow);
        assert!(divs.is_empty(), "unexpected divergences: {divs:?}");
    }

    #[test]
    fn timestamp_precision_rounds_to_second() {
        let mut rule = endpoint_rule();
        rule.timestamp_precision = Some("s".to_string());
        let rules = rules_with_endpoint("GET /api/events", rule);
        let primary = response_json(
            200,
            serde_json::json!({"timestamp": "2026-01-01T00:00:00.100Z"}),
        );
        let shadow = response_json(
            200,
            serde_json::json!({"timestamp": "2026-01-01T00:00:00.400Z"}),
        );

        let divs = rules.compare("GET /api/events", &primary, &shadow);
        assert!(divs.is_empty(), "unexpected divergences: {divs:?}");
    }

    #[test]
    fn timestamp_precision_ignore_skips_iso_timestamps() {
        let mut rule = endpoint_rule();
        rule.timestamp_precision = Some("ignore".to_string());
        let rules = rules_with_endpoint("GET /api/events", rule);
        let primary = response_json(
            200,
            serde_json::json!({"timestamp": "2026-01-01T00:00:00.000Z"}),
        );
        let shadow = response_json(
            200,
            serde_json::json!({"timestamp": "2030-12-31T23:59:59.999Z"}),
        );

        let divs = rules.compare("GET /api/events", &primary, &shadow);
        assert!(divs.is_empty(), "unexpected divergences: {divs:?}");
    }

    #[test]
    fn timestamp_precision_ignore_requires_both_sides_iso() {
        // Regression: "ignore" must only suppress a timestamp when BOTH sides
        // parse as ISO. Otherwise a real divergence like "ready" vs an ISO
        // timestamp would be hidden.
        let mut rule = endpoint_rule();
        rule.timestamp_precision = Some("ignore".to_string());
        let rules = rules_with_endpoint("GET /api/events", rule);
        let primary = response_json(200, serde_json::json!({"state": "ready"}));
        let shadow = response_json(
            200,
            serde_json::json!({"state": "2026-01-01T00:00:00.000Z"}),
        );

        let divs = rules.compare("GET /api/events", &primary, &shadow);
        assert_eq!(
            divs.len(),
            1,
            "expected a divergence when only one side is ISO: {divs:?}"
        );
        assert_eq!(divs[0].field, "state");
    }

    #[test]
    fn compare_mode_text_compares_raw_body_strings() {
        let mut rule = endpoint_rule();
        rule.compare_mode = Some("text".to_string());
        let rules = rules_with_endpoint("GET /plain", rule);
        let primary = response_text(200, "{\"ok\":true}");
        let shadow = response_text(200, "{\"ok\":true }\n");

        let divs = rules.compare("GET /plain", &primary, &shadow);
        assert_eq!(divs.len(), 1);
        assert_eq!(divs[0].field, "body");
    }

    #[test]
    fn compare_body_false_skips_body_comparison() {
        let mut rule = endpoint_rule();
        rule.compare_body = Some(false);
        let rules = rules_with_endpoint("GET /status-only", rule);
        let primary = response_json(200, serde_json::json!({"status": "primary"}));
        let shadow = response_json(200, serde_json::json!({"status": "shadow"}));

        let divs = rules.compare("GET /status-only", &primary, &shadow);
        assert!(divs.is_empty(), "unexpected divergences: {divs:?}");
    }

    #[test]
    fn compare_internal_matches_by_key_with_redaction_tolerance_and_unordered_arrays() {
        let mut tolerance = HashMap::new();
        tolerance.insert("confidence".to_string(), 0.05);
        let mut rule = endpoint_rule();
        rule.internal_state = Some(InternalStateRule {
            tables: BTreeMap::from([(
                "memories".to_string(),
                InternalTableRule {
                    key: Some(vec!["id".to_string()]),
                    columns: Some(vec![
                        "id".to_string(),
                        "agent_id".to_string(),
                        "confidence".to_string(),
                        "tags".to_string(),
                        "apiKey".to_string(),
                        "updated_at".to_string(),
                    ]),
                    ignore_columns: Some(vec!["updated_at".to_string()]),
                    tolerance: Some(tolerance),
                    redactions: Some(vec!["apiKey".to_string()]),
                    timestamp_precision: Some("second".to_string()),
                    array_ordering: Some("unordered".to_string()),
                },
            )]),
        });
        let rules = rules_with_endpoint("POST /api/memory/remember", rule);
        let primary = internal_snapshot(vec![
            serde_json::json!({"id":"m2","agent_id":"agent-a","confidence":0.7,"tags":["b","a"],"apiKey":"primary","updated_at":"2026-01-01T00:00:00Z"}),
            serde_json::json!({"id":"m1","agent_id":"agent-a","confidence":0.8,"tags":["x","y"],"apiKey":"primary","updated_at":"2026-01-01T00:00:00Z"}),
        ]);
        let shadow = internal_snapshot(vec![
            serde_json::json!({"id":"m1","agent_id":"agent-a","confidence":0.83,"tags":["y","x"],"apiKey":"shadow","updated_at":"2030-01-01T00:00:00Z"}),
            serde_json::json!({"id":"m2","agent_id":"agent-a","confidence":0.69,"tags":["a","b"],"apiKey":"shadow","updated_at":"2030-01-01T00:00:00Z"}),
        ]);

        let divs = rules.compare_internal("POST /api/memory/remember", &primary, &shadow);
        assert!(divs.is_empty(), "unexpected divergences: {divs:?}");
    }

    #[test]
    fn compare_internal_reports_keyed_value_mismatch() {
        let rules = ParityRules::default();
        let primary = internal_snapshot(vec![memory_row("m1", "hash-a", "agent-a", "secret A")]);
        let shadow = internal_snapshot(vec![memory_row("m2", "hash-a", "agent-b", "secret A")]);

        let divs = rules.compare_internal("POST /api/memory/remember", &primary, &shadow);
        assert_eq!(divs.len(), 2);
        assert_eq!(divs[0].category.as_deref(), Some("internalState"));
        assert_eq!(divs[0].table.as_deref(), Some("memories"));
        assert!(divs[0].key.as_deref().unwrap().contains("hash-a"));
    }

    #[test]
    fn internal_memory_rows_redact_freeform_values_for_missing_extra_and_mismatch() {
        let rules = ParityRules::default();
        let fake_secret = "token-password-should-never-leak";
        let primary = internal_snapshot(vec![memory_row(
            "primary-id",
            "hash-secret",
            "agent-a",
            fake_secret,
        )]);
        let shadow = internal_snapshot(Vec::new());
        let missing = rules.compare_internal("POST /api/memory/remember", &primary, &shadow);
        assert_divergences_redacted(&missing, &[fake_secret]);
        assert!(serialized_divergences(&missing).contains("hash-secret"));

        let extra = rules.compare_internal("POST /api/memory/remember", &shadow, &primary);
        assert_divergences_redacted(&extra, &[fake_secret]);
        assert!(serialized_divergences(&extra).contains("hash-secret"));

        let primary = internal_snapshot(vec![memory_row(
            "primary-id",
            "hash-same",
            "agent-a",
            fake_secret,
        )]);
        let shadow = internal_snapshot(vec![memory_row(
            "shadow-id",
            "hash-same",
            "agent-a",
            "different-password-should-not-leak",
        )]);
        let mismatch = rules.compare_internal("POST /api/memory/remember", &primary, &shadow);
        assert!(!mismatch.is_empty(), "expected redacted content mismatch");
        assert_divergences_redacted(
            &mismatch,
            &[fake_secret, "different-password-should-not-leak"],
        );
        assert!(serialized_divergences(&mismatch).contains("[REDACTED sha64="));
    }

    #[test]
    fn response_body_divergences_redact_sensitive_and_freeform_fields() {
        // Regression: response-level (HTTP body) divergences used truncate_json
        // verbatim, leaking plaintext memory content + secrets to the jsonl log.
        let rules = ParityRules::default();
        let secret = "token-password-should-never-leak-resp";
        let primary = response_json(
            200,
            serde_json::json!({
                "content": secret,
                "normalizedContent": secret,
                "apiKey": "sk-live-12345",
                "token": "bearer-secret-value",
                "memories": [{ "content": secret, "id": "m1" }],
                "safe": "this-is-fine",
            }),
        );
        let shadow = response_json(
            200,
            serde_json::json!({
                "content": "different",
                "normalizedContent": "different",
                "apiKey": "sk-other",
                "token": "bearer-other",
                "memories": [{ "content": "different", "id": "m1" }],
                "safe": "this-is-fine",
            }),
        );
        let divs = rules.compare("POST /api/memory/remember", &primary, &shadow);
        assert!(
            !divs.is_empty(),
            "expected divergences on the mismatched fields"
        );
        // None of the sensitive/plaintext values may appear in the log.
        assert_divergences_redacted(
            &divs,
            &[secret, "sk-live-12345", "bearer-secret-value", "different"],
        );
        // Sensitive fields should be fingerprinted, not truncated plaintext.
        assert!(serialized_divergences(&divs).contains("[REDACTED sha64="));
    }

    #[test]
    fn unordered_array_and_text_body_divergences_redact_nested_content() {
        // Regression: unordered-array whole-element + text-body paths only saw
        // the parent path, so nested content/secrets leaked.
        let secret = "nested-array-secret-never-leak";
        let mut rule = endpoint_rule();
        rule.array_ordering = Some("unordered".to_string());
        let rules = rules_with_endpoint("POST /api/memory/recall", rule);
        let primary = response_json(
            200,
            serde_json::json!({ "results": [{ "id": "r1", "content": secret }] }),
        );
        let shadow = response_json(200, serde_json::json!({ "results": [] }));
        let divs = rules.compare("POST /api/memory/recall", &primary, &shadow);
        assert!(!divs.is_empty());
        assert_divergences_redacted(&divs, &[secret]);

        // Text body (compareMode text) with embedded secret.
        let mut text_rule = endpoint_rule();
        text_rule.compare_mode = Some("text".to_string());
        let text_rules = rules_with_endpoint("POST /api/memory/raw", text_rule);
        let primary_text = response_text(200, &format!("{{\"content\":\"{secret}\"}}"));
        let shadow_text = response_text(200, "{\"content\":\"other\"}");
        let divs = text_rules.compare("POST /api/memory/raw", &primary_text, &shadow_text);
        assert!(!divs.is_empty());
        assert_divergences_redacted(&divs, &[secret, "other"]);
    }

    #[test]
    fn object_field_at_non_sensitive_parent_redacts_nested_content() {
        // Regression: redact_response_value only fingerprinted when the PARENT
        // path was sensitive. A non-sensitive parent like `memory` holding a
        // sensitive child `content` leaked via truncate_json of the whole object.
        let rules = ParityRules::default();
        let secret = "nested-object-secret-never-leak";
        let primary = response_json(
            200,
            serde_json::json!({ "memory": { "content": secret, "id": "m1" } }),
        );
        let shadow = response_json(200, serde_json::json!({}));
        let divs = rules.compare("POST /api/memory/remember", &primary, &shadow);
        assert!(!divs.is_empty());
        assert_divergences_redacted(&divs, &[secret]);
        assert!(serialized_divergences(&divs).contains("[REDACTED sha64="));
    }

    #[test]
    fn numeric_and_bool_values_under_sensitive_paths_are_redacted() {
        // Regression: Null|Bool|Number were returned verbatim regardless of
        // path sensitivity, so {"token":123456} leaked the numeric token.
        let rules = ParityRules::default();
        let numeric_secret = "1234567890123456";
        let primary = response_json(
            200,
            serde_json::json!({ "token": numeric_secret.parse::<i64>().unwrap() }),
        );
        let shadow = response_json(200, serde_json::json!({ "token": 0 }));
        let divs = rules.compare("POST /api/auth/token", &primary, &shadow);
        assert!(!divs.is_empty());
        // The numeric secret must NOT appear in the serialized divergence log.
        assert_divergences_redacted(&divs, &[numeric_secret]);
    }

    #[test]
    fn secret_embedded_as_object_key_is_redacted_from_field_path() {
        // Regression: secrets as JSON object keys leaked via Divergence.field.
        let rules = ParityRules::default();
        let key_secret = "sk-live-key-as-object-name-12345";
        let primary = response_json(
            200,
            serde_json::json!({ "credentials": { key_secret: true } }),
        );
        let shadow = response_json(200, serde_json::json!({ "credentials": {} }));
        let divs = rules.compare("POST /api/auth/token", &primary, &shadow);
        assert!(!divs.is_empty());
        assert_divergences_redacted(&divs, &[key_secret]);
    }

    #[test]
    fn secret_as_object_key_with_array_value_redacted_from_length_field() {
        // Regression: array-length divergence used format_array_length_path raw,
        // leaking a secret embedded as the key of an array-valued field.
        let rules = ParityRules::default();
        let key_secret = "sk-array-key-secret-67890";
        let primary = response_json(
            200,
            serde_json::json!({ "credentials": { key_secret: [1, 2] } }),
        );
        let shadow = response_json(
            200,
            serde_json::json!({ "credentials": { key_secret: [1] } }),
        );
        let divs = rules.compare("POST /api/auth/token", &primary, &shadow);
        assert!(!divs.is_empty());
        assert_divergences_redacted(&divs, &[key_secret]);
    }

    #[test]
    fn log_safe_field_redacts_non_numeric_bracket_suffixes() {
        // Defensive: if a path ever contains a non-numeric bracket suffix
        // (e.g. a bracketed object key like id[sk-live-secret]), fingerprint it
        // rather than leak it. Numeric indices ([12], [*], [0][1]) on allowlisted
        // field names pass through.
        assert!(log_safe_field("id[0]").contains("id[0]"));
        assert!(log_safe_field("id[3]").contains("[3]"));
        assert!(log_safe_field("id[*]").contains("id[*]"));
        let leaked = log_safe_field("id[sk-live-secret]");
        assert!(!leaked.contains("sk-live-secret"));
        assert!(leaked.contains("[REDACTED sha64="));
        let leaked = log_safe_field("id[vault-key-xyz]");
        assert!(!leaked.contains("vault-key-xyz"));
        // Malformed suffix (unclosed bracket) -> fingerprint, not verbatim.
        let leaked = log_safe_field("id[1234567890123456");
        assert!(!leaked.contains("1234567890123456"));
        assert!(leaked.contains("[REDACTED sha64="));
    }

    #[test]
    fn array_index_paths_and_hook_context_fields_are_redacted() {
        let rules = ParityRules::default();
        let content_secret = "array-content-secret-never-leak";
        let hook_secret = "hook-context-secret-never-leak";
        let primary = response_json(
            200,
            serde_json::json!({
                "content": [content_secret],
                "inject": { "id": "safe-looking-id", "payload": hook_secret },
                "recentContext": hook_secret,
                "summaryPrompt": hook_secret,
                "injections": [{ "id": "injection-id", "systemPrompt": hook_secret }],
                "hiddenPrompt": hook_secret,
                "recall": { "id": "recall-id", "context": hook_secret }
            }),
        );
        let shadow = response_json(
            200,
            serde_json::json!({
                "content": ["shadow-content"],
                "inject": { "id": "different-id", "payload": "shadow-hook" },
                "recentContext": "shadow-hook",
                "summaryPrompt": "shadow-hook",
                "injections": [{ "id": "different-id", "systemPrompt": "shadow-hook" }],
                "hiddenPrompt": "shadow-hook",
                "recall": { "id": "different-id", "context": "shadow-hook" }
            }),
        );

        let divs = rules.compare("POST /api/hooks/session", &primary, &shadow);
        assert!(!divs.is_empty());
        assert_divergences_redacted(
            &divs,
            &[
                content_secret,
                hook_secret,
                "safe-looking-id",
                "injection-id",
                "recall-id",
                "shadow-content",
                "shadow-hook",
            ],
        );
        assert!(serialized_divergences(&divs).contains("[REDACTED sha64="));
    }

    #[test]
    fn deterministic_memory_key_redacts_sensitive_key_columns() {
        let mut rule = endpoint_rule();
        rule.internal_state = Some(InternalStateRule {
            tables: BTreeMap::from([(
                "memories".to_string(),
                InternalTableRule {
                    key: Some(vec!["content".to_string(), "agent_id".to_string()]),
                    columns: None,
                    ignore_columns: None,
                    tolerance: None,
                    redactions: None,
                    timestamp_precision: None,
                    array_ordering: None,
                },
            )]),
        });
        let rules = rules_with_endpoint("POST /api/memory/remember", rule);
        let primary_secret = "primary-key-column-secret-never-leak";
        let shadow_secret = "shadow-key-column-secret-never-leak";
        let primary = internal_snapshot(vec![memory_row(
            "primary-id",
            "hash-primary-key-redaction",
            "agent-a",
            primary_secret,
        )]);
        let shadow = internal_snapshot(vec![memory_row(
            "shadow-id",
            "hash-shadow-key-redaction",
            "agent-a",
            shadow_secret,
        )]);

        let divs = rules.compare_internal("POST /api/memory/remember", &primary, &shadow);
        assert!(!divs.is_empty());
        let serialized = serialized_divergences(&divs);
        assert_divergences_redacted(&divs, &[primary_secret, shadow_secret]);
        assert!(serialized.contains("[REDACTED sha64="));
    }

    #[test]
    fn property_planted_secrets_do_not_leak_from_random_response_shapes() {
        let rules = ParityRules::default();
        let mut rng = TestRng::new(0x5eed_f00d_dead_beef);
        for case in 0..160 {
            let primary_secret = format!("PLANTED_SECRET_PRIMARY_{case}_do_not_log");
            let shadow_secret = format!("PLANTED_SECRET_SHADOW_{case}_do_not_log");
            let primary_json = random_json_with_secret(&mut rng, 0, &primary_secret);
            let shadow_json = replace_secret_string(&primary_json, &primary_secret, &shadow_secret);
            let primary = response_json(200, primary_json.clone());
            let shadow = response_json(200, shadow_json);

            let mut divs = rules.compare("POST /api/hooks/session", &primary, &shadow);
            divs.extend(rules.compare(
                "POST /api/hooks/session",
                &primary,
                &response_json(200, serde_json::json!({})),
            ));

            assert!(!divs.is_empty(), "case {case} produced no divergences");
            assert_divergences_redacted(&divs, &[&primary_secret, &shadow_secret]);
            assert!(
                serialized_divergences(&divs).contains("[REDACTED sha64="),
                "case {case} did not fingerprint redacted values"
            );
        }
    }

    #[test]
    fn internal_history_and_entity_freeform_fields_are_redacted() {
        // Regression: reason/metadata/description were not in the freeform set.
        let rules = ParityRules::default();
        let secret = "secret-in-history-reason";
        let meta_secret = "secret-in-metadata";
        let desc_secret = "secret-in-entity-description";
        let primary = internal_snapshot_tables(BTreeMap::from([
            (
                "memory_history".to_string(),
                vec![serde_json::json!({
                    "id": "h1",
                    "memory_id": "m1",
                    "event": "created",
                    "reason": secret,
                    "metadata": meta_secret,
                    "content_hash": "hash-m1",
                    "agent_id": "agent-a",
                    "visibility": "global",
                    "scope": "workspace",
                })],
            ),
            (
                "entities".to_string(),
                vec![serde_json::json!({
                    "id": "e1",
                    "name": "Entity",
                    "description": desc_secret,
                    "agent_id": "agent-a",
                })],
            ),
        ]));
        let shadow = InternalSnapshot {
            tables: BTreeMap::new(),
        };
        let divs = rules.compare_internal("POST /api/memory/remember", &primary, &shadow);
        assert!(!divs.is_empty());
        assert_divergences_redacted(&divs, &[secret, meta_secret, desc_secret]);
        assert!(serialized_divergences(&divs).contains("[REDACTED sha64="));
    }

    #[test]
    fn equivalent_memory_uuids_match_by_deterministic_identity() {
        let rules = ParityRules::default();
        let primary_memory_id = "550e8400-e29b-41d4-a716-446655440000";
        let shadow_memory_id = "550e8400-e29b-41d4-a716-446655440999";
        let primary = internal_snapshot_tables(BTreeMap::from([
            (
                "memories".to_string(),
                vec![memory_row(
                    primary_memory_id,
                    "hash-equivalent",
                    "agent-a",
                    "same redacted content",
                )],
            ),
            (
                "memory_history".to_string(),
                vec![serde_json::json!({
                    "id": "history-primary",
                    "memory_id": primary_memory_id,
                    "event": "created",
                    "new_content": "same redacted content",
                    "changed_by": "user",
                    "reason": "remember",
                    "metadata": {"source": "test"},
                })],
            ),
        ]));
        let shadow = internal_snapshot_tables(BTreeMap::from([
            (
                "memories".to_string(),
                vec![memory_row(
                    shadow_memory_id,
                    "hash-equivalent",
                    "agent-a",
                    "same redacted content",
                )],
            ),
            (
                "memory_history".to_string(),
                vec![serde_json::json!({
                    "id": "history-shadow",
                    "memory_id": shadow_memory_id,
                    "event": "created",
                    "new_content": "same redacted content",
                    "changed_by": "user",
                    "reason": "remember",
                    "metadata": {"source": "test"},
                })],
            ),
        ]));

        let divs = rules.compare_internal("POST /api/memory/remember", &primary, &shadow);
        assert!(divs.is_empty(), "unexpected divergences: {divs:?}");
    }

    #[test]
    fn real_memory_content_difference_is_detected_without_plaintext() {
        let rules = ParityRules::default();
        let primary_secret = "primary password plaintext";
        let shadow_secret = "shadow token plaintext";
        let primary = internal_snapshot(vec![memory_row(
            "primary-id",
            "hash-primary",
            "agent-a",
            primary_secret,
        )]);
        let shadow = internal_snapshot(vec![memory_row(
            "shadow-id",
            "hash-shadow",
            "agent-a",
            shadow_secret,
        )]);

        let divs = rules.compare_internal("POST /api/memory/remember", &primary, &shadow);
        assert!(
            !divs.is_empty(),
            "expected content-hash keyed row divergence"
        );
        let serialized = serialized_divergences(&divs);
        assert!(
            !serialized.contains(primary_secret),
            "primary content leaked: {serialized}"
        );
        assert!(
            !serialized.contains(shadow_secret),
            "shadow content leaked: {serialized}"
        );
        assert!(serialized.contains("hash-primary") || serialized.contains("hash-shadow"));
    }

    struct TestRng {
        state: u64,
    }

    impl TestRng {
        fn new(seed: u64) -> Self {
            Self { state: seed }
        }

        fn next(&mut self) -> u64 {
            self.state = self
                .state
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            self.state
        }

        fn usize(&mut self, upper: usize) -> usize {
            (self.next() as usize) % upper
        }
    }

    fn random_json_with_secret(rng: &mut TestRng, depth: usize, secret: &str) -> serde_json::Value {
        if depth >= 5 {
            return serde_json::Value::String(secret.to_string());
        }

        match rng.usize(5) {
            0 => serde_json::Value::String(secret.to_string()),
            1 => serde_json::json!([random_json_with_secret(rng, depth + 1, secret)]),
            2 => serde_json::json!([
                { "id": format!("case-{depth}"), "status": "ok" },
                random_json_with_secret(rng, depth + 1, secret),
                { "count": depth }
            ]),
            _ => {
                let key = random_secret_parent_key(rng);
                let mut object = serde_json::Map::new();
                object.insert(
                    key.to_string(),
                    random_json_with_secret(rng, depth + 1, secret),
                );
                let sibling_key = random_safe_key(rng);
                if sibling_key != key {
                    object.insert(
                        sibling_key.to_string(),
                        serde_json::Value::String(format!("diagnostic-{depth}")),
                    );
                }
                object.insert("count".to_string(), serde_json::json!(depth));
                object.insert("ok".to_string(), serde_json::json!(true));
                serde_json::Value::Object(object)
            }
        }
    }

    fn random_secret_parent_key(rng: &mut TestRng) -> &'static str {
        const KEYS: &[&str] = &[
            "content",
            "memory",
            "memories",
            "inject",
            "recentContext",
            "summaryPrompt",
            "injections",
            "systemPrompt",
            "hiddenPrompt",
            "recall",
            "context",
            "prompt",
            "notes",
            "payload",
            "details",
            "items",
            "id",
            "status",
            "path",
        ];
        KEYS[rng.usize(KEYS.len())]
    }

    fn random_safe_key(rng: &mut TestRng) -> &'static str {
        const KEYS: &[&str] = &["id", "status", "version", "agent_id", "visibility", "scope"];
        KEYS[rng.usize(KEYS.len())]
    }

    fn replace_secret_string(value: &serde_json::Value, from: &str, to: &str) -> serde_json::Value {
        match value {
            serde_json::Value::String(text) if text == from => {
                serde_json::Value::String(to.to_string())
            }
            serde_json::Value::Array(items) => serde_json::Value::Array(
                items
                    .iter()
                    .map(|item| replace_secret_string(item, from, to))
                    .collect(),
            ),
            serde_json::Value::Object(map) => serde_json::Value::Object(
                map.iter()
                    .map(|(key, child)| (key.clone(), replace_secret_string(child, from, to)))
                    .collect(),
            ),
            other => other.clone(),
        }
    }

    fn memory_row(
        id: &str,
        content_hash: &str,
        agent_id: &str,
        content: &str,
    ) -> serde_json::Value {
        serde_json::json!({
            "id": id,
            "content": content,
            "content_hash": content_hash,
            "normalized_content": content,
            "agent_id": agent_id,
            "visibility": "global",
            "scope": "workspace",
            "source_type": "manual",
            "source_id": null,
            "source_path": null,
            "runtime_path": "plugin",
            "idempotency_key": null,
            "is_deleted": 0,
            "version": 1,
        })
    }

    fn assert_divergences_redacted(divergences: &[Divergence], forbidden: &[&str]) {
        let serialized = serialized_divergences(divergences);
        for value in forbidden {
            assert!(
                !serialized.contains(value),
                "plaintext leaked: {value} in {serialized}"
            );
        }
    }

    fn serialized_divergences(divergences: &[Divergence]) -> String {
        serde_json::to_string(divergences).unwrap()
    }

    fn internal_snapshot(rows: Vec<serde_json::Value>) -> InternalSnapshot {
        internal_snapshot_tables(BTreeMap::from([("memories".to_string(), rows)]))
    }

    fn internal_snapshot_tables(
        tables: BTreeMap<String, Vec<serde_json::Value>>,
    ) -> InternalSnapshot {
        InternalSnapshot { tables }
    }
}

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
                                field: field_path,
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
                            field: field_path,
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
                field: format_array_length_path(path),
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
                field: format_array_length_path(path),
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
                    field: match_path.clone(),
                    message: "array element missing in shadow response".into(),
                    primary_value: Some(redact_response_tree(&primary[primary_index])),
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
                    field: match_path.clone(),
                    message: "extra array element in shadow response".into(),
                    primary_value: None,
                    shadow_value: Some(redact_response_tree(&shadow[shadow_index])),
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
                field: path.to_string(),
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

    for (key, primary_row) in &primary_by_key {
        match shadow_by_key.get(key) {
            Some(shadow_row) => {
                compare_internal_row(rules, key, primary_row, shadow_row, divergences)
            }
            None => divergences.push(Divergence::internal(
                Severity::Critical,
                &rules.table,
                key,
                format!("internal.{}", rules.table),
                "row missing in shadow internal state",
                Some(redact_internal_row(primary_row, rules)),
                None,
            )),
        }
    }

    for (key, shadow_row) in &shadow_by_key {
        if !primary_by_key.contains_key(key) {
            divergences.push(Divergence::internal(
                Severity::Critical,
                &rules.table,
                key,
                format!("internal.{}", rules.table),
                "extra row in shadow internal state",
                None,
                Some(redact_internal_row(shadow_row, rules)),
            ));
        }
    }
}

fn rows_by_key(
    rows: &[serde_json::Value],
    rules: &EffectiveInternalTableRule,
    memory_identities: &BTreeMap<String, String>,
) -> BTreeMap<String, serde_json::Value> {
    let mut out = BTreeMap::new();
    for (index, row) in rows.iter().enumerate() {
        out.insert(
            row_key(row, rules, memory_identities).unwrap_or_else(|| format!("$index:{index}")),
            row.clone(),
        );
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
        parts.push(format!("{column}={}", stable_json_string(value)));
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
    if is_secret_like(column) || rules.redactions.iter().any(|pattern| pattern == column) {
        return serde_json::Value::String("[REDACTED]".into());
    }
    if is_freeform_internal_column(column) && !value.is_null() {
        return redacted_fingerprint(value);
    }
    match value {
        serde_json::Value::Object(map) => {
            let mut object = serde_json::Map::new();
            for (key, child) in map {
                object.insert(key.clone(), redact_internal_value(key, child, rules));
            }
            serde_json::Value::Object(object)
        }
        serde_json::Value::Array(items) => serde_json::Value::Array(
            items
                .iter()
                .map(|item| redact_internal_value(column, item, rules))
                .collect(),
        ),
        other => other.clone(),
    }
}

fn is_freeform_internal_column(column: &str) -> bool {
    let normalized: String = column
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect();
    if normalized.contains("hash") {
        return false;
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
            | "note"
            | "value"
    ) || normalized.ends_with("content")
        || normalized.ends_with("raw")
}

/// Sensitive leaf-field detector for RESPONSE-level (HTTP body) divergences.
/// Mirrors the internal freeform set plus auth-style field names. Returns true
/// when the leaf at `path` (e.g. ".content", ".apiKey", ".memories[0].content")
/// must never be serialized in plaintext to the divergence log.
fn is_sensitive_response_path(path: &str) -> bool {
    let leaf = path.rsplit(['.', '[', ']']).next().unwrap_or("");
    let normalized: String = leaf
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect();
    if normalized.is_empty() {
        return false;
    }
    // Explicit secret/auth field names.
    const SECRET_FIELDS: &[&str] = &[
        "apikey",
        "token",
        "secret",
        "password",
        "clientsecret",
        "accesstoken",
        "refreshtoken",
        "authtoken",
        "credentials",
        "authorization",
        "cookie",
        "privatekey",
    ];
    if SECRET_FIELDS.iter().any(|f| normalized.contains(f)) {
        return true;
    }
    // Reuse the internal freeform detector for content-like fields.
    is_freeform_internal_column(leaf)
}

/// Redact a response-level leaf value if its path is sensitive; otherwise
/// truncate normally. Ensures plaintext memory content / secrets never reach
/// shadow-divergences.jsonl from response-body comparisons.
fn redact_response_value(value: &serde_json::Value, path: &str) -> String {
    if is_sensitive_response_path(path) {
        return redacted_fingerprint(value).to_string();
    }
    truncate_json(value)
}

/// Recursively redact any sensitive descendant of an object/array, then
/// stringify. Used when a divergence stringifies a WHOLE element (unordered
/// array missing/extra) or a whole text body, where the parent path alone
/// (e.g. "results", "body") doesn't expose the sensitive leaf names. Walks
/// the tree and replaces any sensitive-keyed leaf with its fingerprint.
fn redact_response_tree(value: &serde_json::Value) -> String {
    truncate_str(&redact_response_tree_value(value).to_string())
}

fn redact_response_tree_value(value: &serde_json::Value) -> serde_json::Value {
    match value {
        serde_json::Value::Object(map) => {
            let mut out = serde_json::Map::with_capacity(map.len());
            for (key, val) in map {
                if is_sensitive_response_path(key) {
                    out.insert(key.clone(), redacted_fingerprint(val));
                } else {
                    out.insert(key.clone(), redact_response_tree_value(val));
                }
            }
            serde_json::Value::Object(out)
        }
        serde_json::Value::Array(items) => {
            serde_json::Value::Array(items.iter().map(redact_response_tree_value).collect())
        }
        other => other.clone(),
    }
}

/// Redact a text body if it looks like JSON (parses -> recursive redact);
/// otherwise fingerprint the whole thing (non-JSON text bodies are treated
/// as opaque/freeform so plaintext memory content / secrets never leak).
fn redact_text_body(body: &str) -> String {
    if let Ok(value) = serde_json::from_str::<serde_json::Value>(body) {
        return redact_response_tree(&value);
    }
    // Non-JSON text body: fingerprint the whole thing (never log raw).
    redacted_fingerprint(&serde_json::Value::String(body.to_string())).to_string()
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

fn truncate_json(val: &serde_json::Value) -> String {
    truncate_str(&val.to_string())
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

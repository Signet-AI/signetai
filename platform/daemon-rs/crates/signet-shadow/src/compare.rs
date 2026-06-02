//! Parity comparison engine.
//!
//! Loads parity rules from JSON and compares primary vs shadow responses,
//! emitting typed divergences.

use serde::Deserialize;
use std::collections::HashMap;

use crate::ForwardResponse;
use crate::divergence::{Divergence, Severity};

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
    #[allow(dead_code)]
    compare_mode: Option<String>,
    ignore_fields: Vec<String>,
    #[allow(dead_code)]
    timestamp_precision: Option<String>,
    #[allow(dead_code)]
    array_ordering: Option<String>,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct EndpointRule {
    deterministic: Vec<String>,
    ignore_fields: Vec<String>,
    #[allow(dead_code)]
    tolerance: Option<HashMap<String, f64>>,
    #[allow(dead_code)]
    array_ordering: Option<String>,
    #[allow(dead_code)]
    note: Option<String>,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ErrorComparison {
    must_match: Vec<String>,
    #[allow(dead_code)]
    compare_body: Option<bool>,
    #[allow(dead_code)]
    ignore_fields: Vec<String>,
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
            });
        }

        // JSON body comparison
        if let (Some(pj), Some(sj)) = (&primary.body_json, &shadow.body_json) {
            self.compare_json(endpoint, pj, sj, "", &mut divergences);
        }

        divergences
    }

    fn compare_json(
        &self,
        endpoint: &str,
        primary: &serde_json::Value,
        shadow: &serde_json::Value,
        path: &str,
        divergences: &mut Vec<Divergence>,
    ) {
        // Normalize endpoint for rule lookup (strip path params)
        let rule_key = normalize_endpoint(endpoint);
        let endpoint_rule = self
            .rules
            .as_ref()
            .and_then(|r| r.rules.endpoints.get(&rule_key));

        let ignore_fields: Vec<&str> = match (endpoint_rule, self.rules.as_ref()) {
            (Some(er), _) => er.ignore_fields.iter().map(|s| s.as_str()).collect(),
            (None, Some(rf)) => rf
                .rules
                .default
                .ignore_fields
                .iter()
                .map(|s| s.as_str())
                .collect(),
            _ => vec![],
        };

        // Check if this path is in the ignore list
        if should_ignore(path, &ignore_fields) {
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

                    if should_ignore(&field_path, &ignore_fields) {
                        continue;
                    }

                    match sm.get(key) {
                        Some(sval) => {
                            self.compare_json(endpoint, pval, sval, &field_path, divergences);
                        }
                        None => {
                            let severity = field_severity(endpoint_rule, &field_path);
                            divergences.push(Divergence {
                                severity,
                                field: field_path,
                                message: "field missing in shadow response".into(),
                                primary_value: Some(truncate_json(pval)),
                                shadow_value: None,
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

                        if should_ignore(&field_path, &ignore_fields) {
                            continue;
                        }

                        divergences.push(Divergence {
                            severity: Severity::Expected,
                            field: field_path,
                            message: "extra field in shadow response".into(),
                            primary_value: None,
                            shadow_value: Some(truncate_json(&sm[key])),
                        });
                    }
                }
            }
            (serde_json::Value::Array(pa), serde_json::Value::Array(sa)) => {
                if pa.len() != sa.len() {
                    let severity = field_severity(endpoint_rule, path);
                    divergences.push(Divergence {
                        severity,
                        field: format!("{path}.length"),
                        message: format!(
                            "array length mismatch: primary={}, shadow={}",
                            pa.len(),
                            sa.len()
                        ),
                        primary_value: Some(pa.len().to_string()),
                        shadow_value: Some(sa.len().to_string()),
                    });
                }

                // Compare element by element up to min length
                let min_len = pa.len().min(sa.len());
                for i in 0..min_len {
                    let elem_path = format!("{path}[{i}]");
                    self.compare_json(endpoint, &pa[i], &sa[i], &elem_path, divergences);
                }
            }
            _ => {
                if primary != shadow {
                    let severity = field_severity(endpoint_rule, path);
                    divergences.push(Divergence {
                        severity,
                        field: path.to_string(),
                        message: "value mismatch".into(),
                        primary_value: Some(truncate_json(primary)),
                        shadow_value: Some(truncate_json(shadow)),
                    });
                }
            }
        }
    }
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

fn truncate_json(val: &serde_json::Value) -> String {
    let s = val.to_string();
    if s.len() > 200 {
        format!("{}...", &s[..200])
    } else {
        s
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
            tolerance: None,
            array_ordering: None,
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
        let primary = ForwardResponse {
            status: 200,
            body_bytes: bytes::Bytes::new(),
            body_json: Some(json.clone()),
            content_type: None,
        };
        let shadow = ForwardResponse {
            status: 200,
            body_bytes: bytes::Bytes::new(),
            body_json: Some(json),
            content_type: None,
        };
        let divs = rules.compare("GET /health", &primary, &shadow);
        assert!(divs.is_empty());
    }
}

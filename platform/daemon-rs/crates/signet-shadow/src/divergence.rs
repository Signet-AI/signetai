//! Divergence logging and types.

use std::io::Write;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    Critical,
    Expected,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Divergence {
    pub severity: Severity,
    pub field: String,
    pub message: String,
    pub primary_value: Option<String>,
    pub shadow_value: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub table: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub primary_json: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shadow_json: Option<serde_json::Value>,
}

impl Divergence {
    pub fn internal(
        severity: Severity,
        table: impl Into<String>,
        key: impl Into<String>,
        field: impl Into<String>,
        message: impl Into<String>,
        primary_json: Option<serde_json::Value>,
        shadow_json: Option<serde_json::Value>,
    ) -> Self {
        let table = table.into();
        let key = key.into();
        Self {
            severity,
            field: field.into(),
            message: message.into(),
            primary_value: primary_json.as_ref().map(ToString::to_string),
            shadow_value: shadow_json.as_ref().map(ToString::to_string),
            category: Some("internalState".into()),
            table: Some(table),
            key: Some(key),
            primary_json,
            shadow_json,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DivergenceEntry {
    pub timestamp: String,
    pub endpoint: String,
    pub primary_status: u16,
    pub shadow_status: u16,
    pub primary_latency_ms: u64,
    pub shadow_latency_ms: u64,
    pub divergences: Vec<Divergence>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub internal_compared: bool,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub snapshot_errors: Vec<String>,
}

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

pub struct DivergenceLogger {
    file: Mutex<std::fs::File>,
}

impl DivergenceLogger {
    pub fn new(path: &std::path::Path) -> Result<Self, anyhow::Error> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)?;
        Ok(Self {
            file: Mutex::new(file),
        })
    }

    pub fn log(&self, entry: &DivergenceEntry) -> Result<(), anyhow::Error> {
        let line = serde_json::to_string(entry)?;
        let mut file = self.file.lock().map_err(|e| anyhow::anyhow!("{e}"))?;
        writeln!(file, "{line}")?;
        file.flush()?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serialize_entry() {
        let entry = DivergenceEntry {
            timestamp: "2026-03-14T00:00:00Z".into(),
            endpoint: "GET /health".into(),
            primary_status: 200,
            shadow_status: 500,
            primary_latency_ms: 5,
            shadow_latency_ms: 10,
            divergences: vec![Divergence {
                severity: Severity::Critical,
                field: "statusCode".into(),
                message: "status mismatch".into(),
                primary_value: Some("200".into()),
                shadow_value: Some("500".into()),
                category: None,
                table: None,
                key: None,
                primary_json: None,
                shadow_json: None,
            }],
            request_id: None,
            internal_compared: false,
            snapshot_errors: Vec::new(),
        };
        let json = serde_json::to_string(&entry).unwrap();
        assert!(json.contains("\"critical\""));
        assert!(json.contains("statusCode"));
    }

    #[test]
    fn logger_writes_jsonl() {
        let dir = std::env::temp_dir().join("signet-shadow-test");
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("test-divergences.jsonl");
        let _ = std::fs::remove_file(&path);

        let logger = DivergenceLogger::new(&path).unwrap();
        let entry = DivergenceEntry {
            timestamp: "2026-03-14T00:00:00Z".into(),
            endpoint: "GET /health".into(),
            primary_status: 200,
            shadow_status: 200,
            primary_latency_ms: 5,
            shadow_latency_ms: 10,
            divergences: vec![],
            request_id: None,
            internal_compared: false,
            snapshot_errors: Vec::new(),
        };

        logger.log(&entry).unwrap();
        logger.log(&entry).unwrap();

        let content = std::fs::read_to_string(&path).unwrap();
        assert_eq!(content.lines().count(), 2);

        let _ = std::fs::remove_file(&path);
    }
}

use regex::{Regex, RegexBuilder};
use rusqlite::{params, Connection, OptionalExtension};
use unicode_normalization::UnicodeNormalization;

use crate::CoreError;

pub const MEMORY_CONTENT_SAFETY_POLICY_VERSION: &str = "memory-content-safety-v1";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum MemoryContentSafetySourceKind {
    Memory,
    Artifact,
    Transcript,
    Summary,
    SourceChunk,
}

impl MemoryContentSafetySourceKind {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Memory => "memory",
            Self::Artifact => "artifact",
            Self::Transcript => "transcript",
            Self::Summary => "summary",
            Self::SourceChunk => "source_chunk",
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MemoryContentSafetyRow {
    pub agent_id: String,
    pub source_kind: MemoryContentSafetySourceKind,
    pub source_id: String,
    pub status: String,
    pub context_eligible: i64,
    pub reasons_json: String,
    pub policy_version: String,
    pub scanned_at: String,
}

pub fn memory_content_safety_table_exists(db: &Connection) -> Result<bool, CoreError> {
    Ok(db
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1",
            ["memory_content_safety"],
            |_| Ok(()),
        )
        .optional()?
        .is_some())
}

pub fn read_memory_content_safety(
    db: &Connection,
    agent_id: &str,
    source_kind: MemoryContentSafetySourceKind,
    source_id: &str,
) -> Result<Option<MemoryContentSafetyRow>, CoreError> {
    if !memory_content_safety_table_exists(db)? {
        return Ok(None);
    }
    let agent_id = agent_id.trim();
    let agent_id = if agent_id.is_empty() {
        "default"
    } else {
        agent_id
    };
    Ok(db.query_row(
        "SELECT agent_id, source_kind, source_id, status, context_eligible, reasons_json, policy_version, scanned_at FROM memory_content_safety WHERE agent_id = ?1 AND source_kind = ?2 AND source_id = ?3",
        params![agent_id, source_kind.as_str(), source_id],
        |row| Ok(MemoryContentSafetyRow {
            agent_id: row.get(0)?, source_kind, source_id: row.get(2)?, status: row.get(3)?,
            context_eligible: row.get(4)?, reasons_json: row.get(5)?, policy_version: row.get(6)?, scanned_at: row.get(7)?,
        }),
    ).optional()?)
}

pub fn is_memory_content_context_eligible(
    db: &Connection,
    agent_id: &str,
    source_kind: MemoryContentSafetySourceKind,
    source_id: &str,
    content: &str,
) -> Result<bool, CoreError> {
    if !scan_memory_content(content).context_eligible {
        return Ok(false);
    }
    Ok(
        read_memory_content_safety(db, agent_id, source_kind, source_id)?
            .is_none_or(|row| row.status == "clean" && row.context_eligible == 1),
    )
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum MemoryContentSafetyStatus {
    Clean,
    Tainted,
    Blocked,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum MemoryContentSafetyReason {
    PromptInjection,
    Exfiltration,
    CredentialHarvesting,
    MaliciousShell,
    ToolDirective,
    InvisibleUnicode,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MemoryContentSafetyAssessment {
    pub status: MemoryContentSafetyStatus,
    pub context_eligible: bool,
    pub reasons: Vec<MemoryContentSafetyReason>,
    pub policy_version: &'static str,
}
fn re(pattern: &str) -> Regex {
    RegexBuilder::new(pattern)
        .case_insensitive(true)
        .multi_line(pattern.contains("(?m)"))
        .build()
        .expect("valid policy regex")
}
fn utf16_windows(content: &str, start: usize, end: usize) -> (String, String) {
    let units: Vec<u16> = content.encode_utf16().collect();
    let start_units = content[..start].encode_utf16().count();
    let end_units = content[..end].encode_utf16().count();
    let before_start = start_units.saturating_sub(120);
    let after_end = (end_units + 160).min(units.len());
    (
        String::from_utf16_lossy(&units[before_start..start_units]),
        String::from_utf16_lossy(&units[end_units..after_end]),
    )
}
fn defensive(content: &str, start: usize, end: usize) -> bool {
    let (before, after) = utf16_windows(content, start, end);
    let strong = r"\b(?:security\s+(?:guidance|discussion|analysis)|threat\s+model|defensive)\b";
    let reporting = r"\b(?:example|illustrat\w*|sample|quote|quoted|detector|scanner|classif\w*)\b";
    let reporting_before = r"\b(?:example|illustrat\w*|sample|quote|quoted|detector|scanner|classif\w*)\b[\s\S]{0,80}\b(?:say\w*|read\w*|show\w*|flag\w*|detect\w*|describ\w*|demonstrat\w*|contain\w*|match\w*|pattern)\b";
    let reporting_after = r"\b(?:detector|scanner|classif\w*|flag\w*|pattern|dangerous|unsafe|malicious|hostile|should|would|must|never|do not|don't|avoid|quoted)\b";
    let negated = r"\b(?:never|do not|don't|should not|must not|cannot|can't|avoid|prevent|detect|mitigat\w*)\b[\s\S]{0,80}$";
    re(strong).is_match(&content[start..end])
        || re(negated).is_match(&before)
        || re(strong).is_match(&before)
        || re(strong).is_match(&after)
        || re(reporting_before).is_match(&before)
        || (re(reporting).is_match(&before) && re(reporting_after).is_match(&after))
}
fn actionable(content: &str, pattern: &str) -> bool {
    re(pattern)
        .find_iter(content)
        .any(|m| !defensive(content, m.start(), m.end()))
}
fn any_action(content: &str, patterns: &[&str]) -> bool {
    patterns.iter().any(|p| actionable(content, p))
}

fn dangerous_shell(content: &str) -> bool {
    let pattern = r"\b(?:curl|wget)\b[^\n]{0,240}\|\s*(?:ba|z|fi)?sh\b|\brm\s+-rf\s+(?:/|~|\.ssh)[^\n]{0,240}|\b(?:cat|head|tail)\s+~/?\.ssh/(?:id_[a-z]+|authorized_keys)\b|\b(?:printenv|env)\b[^\n]{0,120}\b(?:curl|wget|send|upload|post)\b";
    re(pattern).find_iter(content).any(|m| {
        if defensive(content, m.start(), m.end()) { return false; }
        let after_end = content.char_indices().map(|(i, _)| i).find(|i| *i >= m.end() + 160).unwrap_or(content.len());
        let after = &content[m.end()..after_end];
        !re(r"\b(?:security\s+(?:guidance|discussion|analysis)|threat\s+model|defensive)\b").is_match(after)
            && !re(r"\b(?:detector|scanner|classif\w*|flag\w*|pattern|dangerous|unsafe|malicious|hostile|should|would|must|never|do not|don't|avoid|quoted)\b").is_match(after)
    })
}
pub fn scan_memory_content(content: &str) -> MemoryContentSafetyAssessment {
    let invisible = Regex::new(r"(?:\u{034f}|[\u{00ad}\u{061c}\u{070f}\u{180e}\u{200b}\u{200c}\u{200e}\u{200f}\u{202a}-\u{202e}\u{2060}\u{2066}-\u{2069}\u{206a}-\u{206f}\u{feff}]|[\u{e0000}-\u{e007f}])").unwrap();
    let normalized: String = content.nfkc().collect();
    let prompt = [
        r"\b(?:ignore|disregard|override|forget|bypass)\b[\s\S]{0,100}\b(?:previous|prior|above|earlier|system|developer|assistant|safety|security)?\s*(?:instructions?|rules?|prompt|message)\b",
        r"\b(?:new|following|these)\s+(?:(?:system|developer|assistant|hidden)\s+)?instructions?\b",
        r"(?:^|\n)\s*(?:system|developer|instruction|prompt)\s*:",
        r"<\s*(?:system|developer|assistant|instruction|prompt)\b[^>]*>",
        r"\b(?:you are now|act as|roleplay as|pretend to be)\b[\s\S]{0,80}\b(?:system|admin|developer|unrestricted|jailbreak|different agent)\b",
    ];
    let tool = [
        r"<\s*(?:tool[_-]?call|function[_-]?call|invoke|tool)\b",
        r"\b(?:assistant|system)\s+to\s*=\s*[a-z0-9_.-]+",
        r"\b(?:call|invoke|use|run|execute)\s+(?:the\s+)?[a-z0-9_.-]+\s+tool\b",
    ];
    let secret = r"(?:\b(?:system\s+prompt|hidden\s+instructions?|secret(?:s)?|credential(?:s)?|password(?:s)?|api\s*keys?|tokens?|private\s+keys?|environment\s+variables?)\b|\.env\b|~/(?:\.ssh)/\S+|/etc/(?:shadow|passwd)\b)";
    let exfil = [r"\b(?:reveal|show|print|send|upload|exfiltrat\w*|dump|forward|leak|transmit|export)\b[\s\S]{0,120}".to_owned()+secret, secret.to_owned()+r"[\s\S]{0,120}\b(?:reveal|show|print|send|upload|exfiltrat\w*|dump|forward|leak|transmit|export)\b"];
    let creds = [
        r"\b(?:enter|paste|provide|share|send|give|submit|type|hand over)\b[\s\S]{0,80}\b(?:password|api\s*key|token|secret|credential|private\s+key)\b",
    ];
    let mut reasons = Vec::new();
    if invisible.is_match(content) {
        reasons.push(MemoryContentSafetyReason::InvisibleUnicode);
    }
    if any_action(&normalized, &prompt) {
        reasons.push(MemoryContentSafetyReason::PromptInjection);
    }
    if any_action(&normalized, &tool) {
        reasons.push(MemoryContentSafetyReason::ToolDirective);
    }
    if any_action(&normalized, &[&exfil[0], &exfil[1]]) {
        reasons.push(MemoryContentSafetyReason::Exfiltration);
    }
    if any_action(&normalized, &creds) {
        reasons.push(MemoryContentSafetyReason::CredentialHarvesting);
    }
    if dangerous_shell(&normalized) {
        reasons.push(MemoryContentSafetyReason::MaliciousShell);
    }
    // Preserve TypeScript's declared reason order.
    reasons.sort_by_key(|r| match r {
        MemoryContentSafetyReason::PromptInjection => 0,
        MemoryContentSafetyReason::Exfiltration => 1,
        MemoryContentSafetyReason::CredentialHarvesting => 2,
        MemoryContentSafetyReason::MaliciousShell => 3,
        MemoryContentSafetyReason::ToolDirective => 4,
        MemoryContentSafetyReason::InvisibleUnicode => 5,
    });
    let status = if reasons.is_empty() {
        MemoryContentSafetyStatus::Clean
    } else if reasons == [MemoryContentSafetyReason::InvisibleUnicode] {
        MemoryContentSafetyStatus::Tainted
    } else {
        MemoryContentSafetyStatus::Blocked
    };
    MemoryContentSafetyAssessment {
        context_eligible: status == MemoryContentSafetyStatus::Clean,
        status,
        reasons,
        policy_version: MEMORY_CONTENT_SAFETY_POLICY_VERSION,
    }
}

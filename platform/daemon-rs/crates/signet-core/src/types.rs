use std::collections::HashMap;

use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// Enum constants (as const + union in TS, now proper enums)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum MemoryType {
    #[default]
    Fact,
    Preference,
    Decision,
    Rationale,
    DailyLog,
    Episodic,
    Procedural,
    Semantic,
    System,
}

impl MemoryType {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Fact => "fact",
            Self::Preference => "preference",
            Self::Decision => "decision",
            Self::Rationale => "rationale",
            Self::DailyLog => "daily-log",
            Self::Episodic => "episodic",
            Self::Procedural => "procedural",
            Self::Semantic => "semantic",
            Self::System => "system",
        }
    }

    pub fn from_str_lossy(s: &str) -> Self {
        match s {
            "fact" => Self::Fact,
            "preference" => Self::Preference,
            "decision" => Self::Decision,
            "rationale" => Self::Rationale,
            "daily-log" => Self::DailyLog,
            "episodic" => Self::Episodic,
            "procedural" => Self::Procedural,
            "semantic" => Self::Semantic,
            "system" => Self::System,
            _ => Self::Fact,
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExtractionStatus {
    #[default]
    None,
    Pending,
    Completed,
    Failed,
}

impl ExtractionStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::None => "none",
            Self::Pending => "pending",
            Self::Completed => "completed",
            Self::Failed => "failed",
        }
    }

    pub fn from_str_lossy(s: &str) -> Self {
        match s {
            "pending" => Self::Pending,
            "completed" => Self::Completed,
            "failed" => Self::Failed,
            _ => Self::None,
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum JobStatus {
    #[default]
    Pending,
    Leased,
    Completed,
    Failed,
    Dead,
}

impl JobStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Leased => "leased",
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Dead => "dead",
        }
    }

    pub fn from_str_lossy(s: &str) -> Self {
        match s {
            "leased" => Self::Leased,
            "completed" => Self::Completed,
            "failed" => Self::Failed,
            "dead" => Self::Dead,
            _ => Self::Pending,
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HistoryEvent {
    Created,
    Updated,
    Deleted,
    Recovered,
    Merged,
    #[default]
    None,
    Split,
}

impl HistoryEvent {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Created => "created",
            Self::Updated => "updated",
            Self::Deleted => "deleted",
            Self::Recovered => "recovered",
            Self::Merged => "merged",
            Self::None => "none",
            Self::Split => "split",
        }
    }

    pub fn from_str_lossy(s: &str) -> Self {
        match s {
            "created" => Self::Created,
            "updated" => Self::Updated,
            "deleted" => Self::Deleted,
            "recovered" => Self::Recovered,
            "merged" => Self::Merged,
            "split" => Self::Split,
            _ => Self::None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DecisionAction {
    Add,
    Update,
    Delete,
    None,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EntityType {
    Person,
    Project,
    System,
    Tool,
    Concept,
    Skill,
    Task,
    #[default]
    Unknown,
}

impl EntityType {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Person => "person",
            Self::Project => "project",
            Self::System => "system",
            Self::Tool => "tool",
            Self::Concept => "concept",
            Self::Skill => "skill",
            Self::Task => "task",
            Self::Unknown => "unknown",
        }
    }

    pub fn from_str_lossy(s: &str) -> Self {
        match s {
            "person" => Self::Person,
            "project" => Self::Project,
            "system" => Self::System,
            "tool" => Self::Tool,
            "concept" => Self::Concept,
            "skill" => Self::Skill,
            "task" => Self::Task,
            _ => Self::Unknown,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AttributeKind {
    Attribute,
    Constraint,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AttributeStatus {
    Active,
    Superseded,
    Deleted,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DependencyType {
    Uses,
    Requires,
    OwnedBy,
    Owns,
    Blocks,
    Informs,
    Maintains,
    Implements,
    Built,
    DependsOn,
    RelatedTo,
    LearnedFrom,
    Teaches,
    Knows,
    Assumes,
    SupportsClaim,
    AuthoredBy,
    LinksTo,
    Contains,
    ContainsNote,
    Contradicts,
    Supersedes,
    PartOf,
    ProducedArtifact,
    Precedes,
    Follows,
    Triggers,
    MayExecute,
    RequiresApprovalFrom,
    Impacts,
    Produces,
    Consumes,
}

impl DependencyType {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Uses => "uses",
            Self::Requires => "requires",
            Self::OwnedBy => "owned_by",
            Self::Owns => "owns",
            Self::Blocks => "blocks",
            Self::Informs => "informs",
            Self::Maintains => "maintains",
            Self::Implements => "implements",
            Self::Built => "built",
            Self::DependsOn => "depends_on",
            Self::RelatedTo => "related_to",
            Self::LearnedFrom => "learned_from",
            Self::Teaches => "teaches",
            Self::Knows => "knows",
            Self::Assumes => "assumes",
            Self::SupportsClaim => "supports_claim",
            Self::AuthoredBy => "authored_by",
            Self::LinksTo => "links_to",
            Self::Contains => "contains",
            Self::ContainsNote => "contains_note",
            Self::Contradicts => "contradicts",
            Self::Supersedes => "supersedes",
            Self::PartOf => "part_of",
            Self::ProducedArtifact => "produced_artifact",
            Self::Precedes => "precedes",
            Self::Follows => "follows",
            Self::Triggers => "triggers",
            Self::MayExecute => "may_execute",
            Self::RequiresApprovalFrom => "requires_approval_from",
            Self::Impacts => "impacts",
            Self::Produces => "produces",
            Self::Consumes => "consumes",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskStatus {
    Open,
    InProgress,
    Blocked,
    Done,
    Cancelled,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TaskHarness {
    ClaudeCode,
    Opencode,
    Codex,
}

impl TaskHarness {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::ClaudeCode => "claude-code",
            Self::Opencode => "opencode",
            Self::Codex => "codex",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskRunStatus {
    Pending,
    Running,
    Completed,
    Failed,
}

// ---------------------------------------------------------------------------
// Core domain structs
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Memory {
    pub id: String,
    #[serde(rename = "type")]
    pub memory_type: MemoryType,
    pub category: Option<String>,
    pub content: String,
    pub confidence: f64,
    pub source_id: Option<String>,
    pub source_type: Option<String>,
    pub tags: Vec<String>,
    pub created_at: String,
    pub updated_at: String,
    pub updated_by: String,
    pub vector_clock: HashMap<String, u64>,
    pub version: i64,
    pub manual_override: bool,
    pub content_hash: Option<String>,
    pub normalized_content: Option<String>,
    pub is_deleted: bool,
    pub deleted_at: Option<String>,
    pub pinned: bool,
    pub importance: f64,
    pub extraction_status: ExtractionStatus,
    pub embedding_model: Option<String>,
    pub extraction_model: Option<String>,
    pub update_count: i64,
    pub access_count: i64,
    pub last_accessed: Option<String>,
    pub who: Option<String>,
    pub why: Option<String>,
    pub project: Option<String>,
    pub session_id: Option<String>,
    pub idempotency_key: Option<String>,
    pub runtime_path: Option<String>,
    pub source_path: Option<String>,
    pub source_section: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Conversation {
    pub id: String,
    pub session_id: String,
    pub harness: String,
    pub started_at: String,
    pub ended_at: Option<String>,
    pub summary: Option<String>,
    pub topics: Vec<String>,
    pub decisions: Vec<String>,
    pub created_at: String,
    pub updated_at: String,
    pub updated_by: String,
    pub vector_clock: HashMap<String, u64>,
    pub version: i64,
    pub manual_override: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Embedding {
    pub id: String,
    pub content_hash: String,
    pub vector: Vec<f32>,
    pub dimensions: usize,
    pub source_type: String,
    pub source_id: String,
    pub chunk_text: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryHistory {
    pub id: String,
    pub memory_id: String,
    pub event: HistoryEvent,
    pub old_content: Option<String>,
    pub new_content: Option<String>,
    pub changed_by: String,
    pub reason: Option<String>,
    pub metadata: Option<String>,
    pub created_at: String,
    pub actor_type: Option<String>,
    pub session_id: Option<String>,
    pub request_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryJob {
    pub id: String,
    pub memory_id: Option<String>,
    pub job_type: String,
    pub status: JobStatus,
    pub payload: Option<String>,
    pub result: Option<String>,
    pub attempts: i64,
    pub max_attempts: i64,
    pub leased_at: Option<String>,
    pub completed_at: Option<String>,
    pub failed_at: Option<String>,
    pub error: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub document_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Entity {
    pub id: String,
    pub name: String,
    pub canonical_name: Option<String>,
    pub entity_type: String,
    pub agent_id: String,
    pub description: Option<String>,
    pub mentions: i64,
    pub pinned: bool,
    pub pinned_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Relation {
    pub id: String,
    pub source_entity_id: String,
    pub target_entity_id: String,
    pub relation_type: String,
    pub strength: f64,
    pub mentions: i64,
    pub confidence: f64,
    pub metadata: Option<String>,
    pub created_at: String,
    pub updated_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryEntityMention {
    pub memory_id: String,
    pub entity_id: String,
    pub mention_text: Option<String>,
    pub confidence: Option<f64>,
    pub created_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EntityAspect {
    pub id: String,
    pub entity_id: String,
    pub agent_id: String,
    pub name: String,
    pub canonical_name: String,
    pub weight: f64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EntityAttribute {
    pub id: String,
    pub aspect_id: Option<String>,
    pub agent_id: String,
    pub memory_id: Option<String>,
    pub kind: String,
    pub content: String,
    pub normalized_content: String,
    pub confidence: f64,
    pub importance: f64,
    pub status: String,
    pub superseded_by: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EntityDependency {
    pub id: String,
    pub source_entity_id: String,
    pub target_entity_id: String,
    pub agent_id: String,
    pub aspect_id: Option<String>,
    pub dependency_type: String,
    pub strength: f64,
    pub reason: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskMeta {
    pub entity_id: String,
    pub agent_id: String,
    pub status: String,
    pub expires_at: Option<String>,
    pub retention_until: Option<String>,
    pub completed_at: Option<String>,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduledTask {
    pub id: String,
    pub name: String,
    pub prompt: String,
    pub cron_expression: String,
    pub harness: String,
    pub working_directory: Option<String>,
    pub enabled: bool,
    pub last_run_at: Option<String>,
    pub next_run_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub skill_name: Option<String>,
    pub skill_mode: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskRun {
    pub id: String,
    pub task_id: String,
    pub status: String,
    pub started_at: String,
    pub completed_at: Option<String>,
    pub exit_code: Option<i32>,
    pub stdout: Option<String>,
    pub stderr: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionCheckpoint {
    pub id: String,
    pub session_key: String,
    pub harness: String,
    pub project: Option<String>,
    pub project_normalized: Option<String>,
    pub trigger: String,
    pub digest: String,
    pub prompt_count: i64,
    pub memory_queries: Option<String>,
    pub recent_remembers: Option<String>,
    pub created_at: String,
    pub focal_entity_ids: Option<String>,
    pub focal_entity_names: Option<String>,
    pub active_aspect_ids: Option<String>,
    pub surfaced_constraint_count: Option<i64>,
    pub traversal_memory_count: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionMemory {
    pub id: String,
    pub session_key: String,
    pub memory_id: String,
    pub source: String,
    pub effective_score: Option<f64>,
    pub predictor_score: Option<f64>,
    pub final_score: f64,
    pub rank: i64,
    pub was_injected: bool,
    pub relevance_score: Option<f64>,
    pub fts_hit_count: i64,
    pub agent_preference: Option<String>,
    pub created_at: String,
    pub entity_slot: Option<i64>,
    pub aspect_slot: Option<i64>,
    pub is_constraint: bool,
    pub structural_density: Option<i64>,
    pub predictor_rank: Option<i64>,
    pub agent_relevance_score: Option<f64>,
    pub agent_feedback_count: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionScore {
    pub id: String,
    pub session_key: String,
    pub project: Option<String>,
    pub harness: Option<String>,
    pub score: f64,
    pub memories_recalled: Option<i64>,
    pub memories_used: Option<i64>,
    pub novel_context_count: Option<i64>,
    pub reasoning: Option<String>,
    pub created_at: String,
    pub confidence: Option<f64>,
    pub continuity_reasoning: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSummary {
    pub id: String,
    pub project: Option<String>,
    pub depth: i64,
    pub kind: String,
    pub content: String,
    pub token_count: Option<i64>,
    pub earliest_at: String,
    pub latest_at: String,
    pub session_key: Option<String>,
    pub harness: Option<String>,
    pub agent_id: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Document {
    pub id: String,
    pub source_url: Option<String>,
    pub source_type: String,
    pub content_type: Option<String>,
    pub content_hash: Option<String>,
    pub title: Option<String>,
    pub raw_content: Option<String>,
    pub status: String,
    pub error: Option<String>,
    pub connector_id: Option<String>,
    pub chunk_count: i64,
    pub memory_count: i64,
    pub metadata_json: Option<String>,
    pub agent_id: String,
    pub project: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub completed_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Connector {
    pub id: String,
    pub provider: String,
    pub display_name: Option<String>,
    pub config_json: String,
    pub cursor_json: Option<String>,
    pub status: String,
    pub last_sync_at: Option<String>,
    pub last_error: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SummaryJob {
    pub id: String,
    pub session_key: Option<String>,
    pub harness: String,
    pub project: Option<String>,
    pub transcript: String,
    pub status: String,
    pub result: Option<String>,
    pub attempts: i64,
    pub max_attempts: i64,
    pub created_at: String,
    pub completed_at: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PredictorComparison {
    pub id: String,
    pub session_key: String,
    pub agent_id: String,
    pub predictor_ndcg: f64,
    pub baseline_ndcg: f64,
    pub predictor_won: bool,
    pub margin: f64,
    pub alpha: f64,
    pub ema_updated: bool,
    pub focal_entity_id: Option<String>,
    pub focal_entity_name: Option<String>,
    pub project: Option<String>,
    pub candidate_count: i64,
    pub traversal_count: i64,
    pub constraint_count: i64,
    pub created_at: String,
    pub scorer_confidence: f64,
    pub success_rate: f64,
    pub predictor_top_ids: String,
    pub baseline_top_ids: String,
    pub relevance_scores: String,
    pub fts_overlap_score: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TelemetryEvent {
    pub id: String,
    pub event: String,
    pub timestamp: String,
    pub properties: String,
    pub sent_to_posthog: bool,
    pub created_at: String,
}

// -- Extraction pipeline contracts --

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractedFact {
    pub content: String,
    #[serde(rename = "type")]
    pub fact_type: MemoryType,
    pub confidence: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractedEntity {
    pub source: String,
    pub source_type: Option<String>,
    pub relationship: String,
    pub target: String,
    pub target_type: Option<String>,
    pub confidence: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractionResult {
    pub facts: Vec<ExtractedFact>,
    pub entities: Vec<ExtractedEntity>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DecisionProposal {
    pub action: DecisionAction,
    pub target_memory_id: Option<String>,
    pub confidence: f64,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DecisionResult {
    pub proposals: Vec<DecisionProposal>,
    pub warnings: Vec<String>,
}

// -- Search result types --

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub memory: Memory,
    pub score: f64,
    pub source: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecallResult {
    pub memories: Vec<SearchResult>,
    pub total: usize,
    pub query: String,
}

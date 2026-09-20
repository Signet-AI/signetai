pub(crate) mod auth;
pub(crate) mod changelog;
pub(crate) mod diagnostics;
pub(crate) mod git_sync;
pub(crate) mod hooks;
pub(crate) mod inference;
pub(crate) mod integrations;
pub(crate) mod jobs;
pub(crate) mod knowledge;
pub(crate) mod knowledge_graph;
pub(crate) mod mcp;
pub(crate) mod memory_advanced;
pub(crate) mod ontology;
pub(crate) mod pipeline;
pub(crate) mod plugins;
pub(crate) mod queue_diagnostics;
pub(crate) mod repair;
pub(crate) mod secrets;
pub(crate) mod session_hook_boundary;
pub(crate) mod sessions;
pub(crate) mod skills;
pub(crate) mod source_lifecycle;
pub(crate) mod telemetry;
pub(crate) mod transcripts;
pub(crate) mod update;

use crate::AppState;
use axum::Router;

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .merge(integrations::routes())
        .merge(git_sync::router())
        .merge(changelog::router())
        .merge(diagnostics::router())
        .merge(auth::router())
        .merge(secrets::router())
        .merge(skills::router())
        .merge(inference::router())
        .merge(jobs::router())
        .merge(knowledge::router())
        .merge(knowledge_graph::router())
        .merge(mcp::router())
        .merge(ontology::router())
        .merge(hooks::router())
        .merge(sessions::router())
        .merge(session_hook_boundary::router())
        .merge(memory_advanced::router())
        .merge(pipeline::router())
        .merge(queue_diagnostics::router())
        .merge(repair::router())
        .merge(source_lifecycle::router())
        .merge(telemetry::router())
        .merge(transcripts::router())
        .merge(update::router())
}

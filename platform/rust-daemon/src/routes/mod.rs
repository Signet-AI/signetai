pub(crate) mod auth;
pub(crate) mod hooks;
pub(crate) mod inference;
pub(crate) mod integrations;
pub(crate) mod jobs;
pub(crate) mod knowledge;
pub(crate) mod knowledge_graph;
pub(crate) mod mcp;
pub(crate) mod ontology;
pub(crate) mod pipeline;
pub(crate) mod sessions;
pub(crate) mod memory_advanced;
pub(crate) mod transcripts;

use crate::AppState;
use axum::Router;

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .merge(integrations::routes())
        .merge(auth::router())
        .merge(inference::router())
        .merge(jobs::router())
        .merge(knowledge::router())
        .merge(knowledge_graph::router())
        .merge(mcp::router())
        .merge(ontology::router())
        .merge(hooks::router())
        .merge(sessions::router())
        .merge(memory_advanced::router())
        .merge(pipeline::router())
        .merge(transcripts::router())
}

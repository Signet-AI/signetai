pub(crate) mod hooks;
pub(crate) mod inference;
pub(crate) mod integrations;
pub(crate) mod jobs;
pub(crate) mod knowledge;
pub(crate) mod mcp;
pub(crate) mod ontology;
pub(crate) mod pipeline;
pub(crate) mod sessions;

use crate::AppState;
use axum::Router;

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .merge(integrations::routes())
        .merge(inference::router())
        .merge(jobs::router())
        .merge(knowledge::router())
        .merge(mcp::router())
        .merge(ontology::router())
        .merge(hooks::router())
        .merge(sessions::router())
        .merge(pipeline::router())
}

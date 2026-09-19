pub(crate) mod integrations;
pub(crate) mod jobs;
pub(crate) mod knowledge;
pub(crate) mod ontology;

use crate::AppState;
use axum::Router;

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .merge(integrations::routes())
        .merge(jobs::router())
        .merge(ontology::router())
        .merge(knowledge::router())
}

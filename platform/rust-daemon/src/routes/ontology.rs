use crate::routes::auth;
use crate::{agent, execute, source_workspace, AgentQuery, ApiError, AppState};
use axum::{
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};
use signet_core_native::Operation;

#[cfg(test)]
mod auth_contract_tests {
    use super::{parse_claim_kind, parse_claim_limit, proposal_auth_error};

    #[test]
    fn unauthenticated_proposal_access_is_forbidden() {
        let error = proposal_auth_error();
        assert_eq!(error.status, axum::http::StatusCode::FORBIDDEN);
    }

    #[test]
    fn claim_trace_kind_and_limits_match_typescript_fallbacks() {
        assert_eq!(parse_claim_kind(Some("other")), Err("kind is invalid"));
        assert_eq!(
            parse_claim_kind(Some(" attribute ")),
            Err("kind is invalid")
        );
        assert_eq!(parse_claim_limit(Some("-2"), 20, 1, 50).ok(), Some(1));
        assert_eq!(
            parse_claim_limit(Some("999999999999999999999"), 20, 1, 50).ok(),
            Some(50)
        );
        assert_eq!(parse_claim_limit(Some("nope"), 20, 1, 50).ok(), Some(20));
        assert_eq!(parse_claim_limit(Some(" 12abc"), 20, 1, 50).ok(), Some(12));
        assert_eq!(parse_claim_limit(None, 0, 1, 1_000_000).ok(), Some(0));
        assert_eq!(parse_claim_limit(Some("0"), 0, 1, 1_000_000).ok(), Some(1));
        assert_eq!(
            parse_claim_limit(Some("1000001"), 0, 1, 1_000_000).ok(),
            Some(1_000_000)
        );
    }
}

fn proposal_auth_error() -> ApiError {
    ApiError {
        status: StatusCode::FORBIDDEN,
        code: "forbidden",
        message: "ontology proposal permission required".into(),
    }
}

async fn require_ontology_auth(
    state: &AppState,
    headers: &HeaderMap,
    query: &OntologyQuery,
    permission: &str,
) -> Result<(), ApiError> {
    let claims = auth::gate(state, headers)
        .await
        .map_err(|_| proposal_auth_error())?;
    let scope = json!({
        "agent": agent(headers, Some(&query.agent), None)?,
        "workspace": source_workspace(headers, query.workspace_id.as_deref())?,
    });
    if auth::authority_allows(&claims, "agent", &scope, &[permission.to_owned()]) {
        Ok(())
    } else {
        Err(proposal_auth_error())
    }
}

async fn require_proposal_auth(
    state: &AppState,
    headers: &HeaderMap,
    query: &OntologyQuery,
    permission: &str,
) -> Result<(), ApiError> {
    require_ontology_auth(state, headers, query, permission).await
}

#[derive(Debug, Deserialize, Default)]
pub(crate) struct OntologyQuery {
    #[serde(flatten)]
    pub agent: AgentQuery,
    pub workspace_id: Option<String>,
    pub limit: Option<usize>,
    pub cursor: Option<String>,
}

#[derive(Debug, Deserialize, Default)]
struct ClaimTraceQuery {
    #[serde(flatten)]
    agent: AgentQuery,
    entity: Option<String>,
    aspect: Option<String>,
    group: Option<String>,
    claim: Option<String>,
    kind: Option<String>,
    version_limit: Option<String>,
    premise_limit: Option<String>,
    reverse_limit: Option<String>,
    max_depth: Option<String>,
    session_key: Option<String>,
}

#[derive(Debug, Deserialize, Default)]
struct ClaimVersionsQuery {
    #[serde(flatten)]
    agent: AgentQuery,
    entity: Option<String>,
    aspect: Option<String>,
    group: Option<String>,
    claim: Option<String>,
    kind: Option<String>,
}

#[derive(Debug, Deserialize, Default)]
struct ClaimVersionQuery {
    #[serde(flatten)]
    agent: AgentQuery,
    entity: Option<String>,
    aspect: Option<String>,
    group: Option<String>,
    claim: Option<String>,
    version: Option<String>,
    kind: Option<String>,
}

fn parse_claim_kind(value: Option<&str>) -> Result<Option<String>, &'static str> {
    match value {
        None | Some("") => Ok(None),
        Some("attribute") | Some("constraint") => Ok(value.map(str::to_owned)),
        Some(_) => Err("kind is invalid"),
    }
}

fn parse_claim_limit(
    value: Option<&str>,
    fallback: usize,
    min: usize,
    max: usize,
) -> Result<usize, ApiError> {
    let parsed = value.and_then(|raw| {
        let raw = raw.trim_start();
        let (negative, digits) = match raw.as_bytes().first() {
            Some(b'-') => (true, &raw[1..]),
            Some(b'+') => (false, &raw[1..]),
            _ => (false, raw),
        };
        let digit_count = digits.bytes().take_while(u8::is_ascii_digit).count();
        if digit_count == 0 {
            return None;
        }
        let number = &digits[..digit_count];
        let signed = if negative {
            format!("-{number}")
        } else {
            number.to_owned()
        };
        let number = signed.parse::<f64>().ok()?;
        number.is_finite().then_some(number)
    });
    Ok(parsed.map_or(fallback, |number| {
        number.clamp(min as f64, max as f64) as usize
    }))
}

struct ClaimTraceError(ApiError);

impl From<ApiError> for ClaimTraceError {
    fn from(error: ApiError) -> Self {
        Self(error)
    }
}

impl IntoResponse for ClaimTraceError {
    fn into_response(self) -> Response {
        (self.0.status, Json(json!({"error": self.0.message}))).into_response()
    }
}

fn validated_kind(kind: &str) -> Result<String, ApiError> {
    let value = kind.trim();
    (!value.is_empty() && value.len() <= 64)
        .then(|| value.to_owned())
        .ok_or_else(|| ApiError::bad_request("ontology kind is required"))
}

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route("/api/ontology/{kind}", get(list).post(upsert))
        .route("/api/ontology/{kind}/{id}", get(get_one).delete(remove))
        .route(
            "/api/ontology/proposals",
            get(list_proposals).post(create_proposal),
        )
        .route(
            "/api/ontology/proposals/{id}",
            get(get_proposal).delete(delete_proposal),
        )
        .route("/api/ontology/claims", get(list_claims).post(create_claim))
        .route(
            "/api/ontology/claims/{id}",
            get(get_claim).delete(delete_claim),
        )
        .route(
            "/api/ontology/constraints",
            get(list_constraints).post(create_constraint),
        )
        .route(
            "/api/ontology/constraints/{id}",
            get(get_constraint).delete(delete_constraint),
        )
        .route(
            "/api/ontology/assertions",
            get(list_assertions).post(create_assertion),
        )
        .route(
            "/api/ontology/assertions/{id}",
            get(get_assertion).delete(delete_assertion),
        )
        .route(
            "/api/ontology/proposals/{id}/apply",
            axum::routing::post(unsupported_write),
        )
        .route(
            "/api/ontology/proposals/{id}/reject",
            axum::routing::post(unsupported_write),
        )
        .route("/api/ontology/proposals/conflicts", get(list_conflicts))
        .route(
            "/api/ontology/proposals/repair/duplicates",
            axum::routing::post(unsupported_write),
        )
        .route(
            "/api/ontology/proposals/repair/merge-plan",
            axum::routing::post(unsupported_write),
        )
        .route(
            "/api/ontology/proposals/{id}/evidence",
            get(unsupported_read),
        )
        .route("/api/ontology/claims/evidence", get(unsupported_read))
        .route("/api/ontology/claims/versions", get(list_claim_versions))
        .route("/api/ontology/claims/version", get(get_claim_version))
        .route("/api/ontology/claims/explain", get(explain_claim))
        .route(
            "/api/ontology/extract",
            axum::routing::post(unsupported_write),
        )
        .route(
            "/api/ontology/consolidate",
            axum::routing::post(unsupported_write),
        )
        .route("/api/ontology/contradictions", get(unsupported_read))
        .route("/api/claims", get(list_claims).post(create_claim))
        .route(
            "/api/constraints",
            get(list_constraints).post(create_constraint),
        )
}

async fn unsupported_read(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<OntologyQuery>,
) -> Result<Json<Value>, ApiError> {
    require_ontology_auth(&state, &headers, &q, "recall").await?;
    Err(ApiError::not_implemented(
        "ontology operation is unsupported by the fresh Rust boundary",
    ))
}

async fn unsupported_write(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<OntologyQuery>,
) -> Result<Json<Value>, ApiError> {
    require_ontology_auth(&state, &headers, &q, "modify").await?;
    Err(ApiError::not_implemented(
        "ontology operation is unsupported by the fresh Rust boundary",
    ))
}

async fn list_claim_versions(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(mut q): Query<ClaimVersionsQuery>,
) -> Result<Json<Value>, ClaimTraceError> {
    let auth_query = OntologyQuery {
        agent: std::mem::take(&mut q.agent),
        workspace_id: None,
        limit: None,
        cursor: None,
    };
    require_ontology_auth(&state, &headers, &auth_query, "recall").await?;
    let required = |value: &Option<String>, name: &str| {
        value
            .as_deref()
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .map(str::to_owned)
            .ok_or_else(|| ApiError::bad_request(format!("{name} is required")))
    };
    let entity = required(&q.entity, "entity")?;
    let aspect = required(&q.aspect, "aspect")?;
    let group = required(&q.group, "group")?;
    let claim = required(&q.claim, "claim")?;
    let kind = parse_claim_kind(q.kind.as_deref()).map_err(ApiError::bad_request)?;
    let request = signet_core_native::OntologyClaimVersionsRequest {
        agent_id: agent(&headers, Some(&auth_query.agent), None)?,
        entity,
        aspect,
        group_key: group,
        claim_key: claim,
        kind,
    };
    Ok(
        execute(&state, Operation::OntologyClaimVersions { request })
            .await
            .map(Json)?,
    )
}

async fn get_claim_version(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(mut q): Query<ClaimVersionQuery>,
) -> Result<Json<Value>, ClaimTraceError> {
    let auth_query = OntologyQuery {
        agent: std::mem::take(&mut q.agent),
        workspace_id: None,
        limit: None,
        cursor: None,
    };
    require_ontology_auth(&state, &headers, &auth_query, "recall").await?;
    let required = |value: &Option<String>, name: &str| {
        value
            .as_deref()
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .map(str::to_owned)
            .ok_or_else(|| ApiError::bad_request(format!("{name} is required")))
    };
    let entity = required(&q.entity, "entity")?;
    let aspect = required(&q.aspect, "aspect")?;
    let group = required(&q.group, "group")?;
    let claim = required(&q.claim, "claim")?;
    let version = parse_claim_limit(q.version.as_deref(), 0, 1, 1_000_000)?;
    if version == 0 {
        return Err(ApiError::bad_request("version is required").into());
    }
    let kind = parse_claim_kind(q.kind.as_deref()).map_err(ApiError::bad_request)?;
    let request = signet_core_native::OntologyClaimVersionRequest {
        agent_id: agent(&headers, Some(&auth_query.agent), None)?,
        entity,
        aspect,
        group_key: group,
        claim_key: claim,
        kind,
        version: version as i64,
    };
    let item = execute(&state, Operation::OntologyClaimVersion { request }).await?;
    if item.is_null() {
        return Err(ApiError::not_found("Claim version not found").into());
    }
    Ok(Json(item))
}

async fn explain_claim(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<ClaimTraceQuery>,
) -> Result<Json<Value>, ClaimTraceError> {
    let required = |value: &Option<String>, name: &str| {
        value
            .as_deref()
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .map(str::to_owned)
            .ok_or_else(|| ApiError::bad_request(format!("{name} is required")))
    };
    let entity = required(&q.entity, "entity")?;
    let aspect = required(&q.aspect, "aspect")?;
    let group = required(&q.group, "group")?;
    let claim = required(&q.claim, "claim")?;
    let kind = parse_claim_kind(q.kind.as_deref()).map_err(ApiError::bad_request)?;
    let query_session = q
        .session_key
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty());
    let header_session = headers
        .get("x-signet-session-key")
        .and_then(|v| v.to_str().ok())
        .map(str::trim)
        .filter(|v| !v.is_empty());
    if query_session.is_some() && header_session.is_some() && query_session != header_session {
        return Err(
            ApiError::bad_request("session_key conflicts with x-signet-session-key").into(),
        );
    }
    let session_key = query_session.or(header_session).map(str::to_owned);
    let auth_claims = auth::gate(&state, &headers)
        .await
        .map_err(|_| proposal_auth_error())?;
    let auth_query = OntologyQuery {
        agent: q.agent,
        workspace_id: None,
        limit: None,
        cursor: None,
    };
    require_ontology_auth(&state, &headers, &auth_query, "recall").await?;
    if let Some(session_key) = session_key.as_deref() {
        execute(
            &state,
            Operation::SessionValidate {
                agent_id: agent(&headers, Some(&auth_query.agent), None)?,
                key: session_key.to_owned(),
            },
        )
        .await?;
    }
    let project = if auth_claims.get("role").and_then(Value::as_str) == Some("admin") {
        None
    } else {
        auth_claims
            .get("scope")
            .and_then(|v| v.get("project"))
            .and_then(Value::as_str)
            .map(str::to_owned)
    };
    let request = signet_core_native::OntologyClaimTraceRequest {
        agent_id: agent(&headers, Some(&auth_query.agent), None)?,
        entity,
        aspect,
        group_key: group,
        claim_key: claim,
        kind,
        version_limit: Some(parse_claim_limit(q.version_limit.as_deref(), 20, 1, 50)?),
        premise_limit: Some(parse_claim_limit(q.premise_limit.as_deref(), 50, 1, 100)?),
        reverse_limit: Some(parse_claim_limit(q.reverse_limit.as_deref(), 50, 1, 100)?),
        max_depth: Some(parse_claim_limit(q.max_depth.as_deref(), 3, 0, 3)?),
        session_key,
        project,
    };
    Ok(execute(&state, Operation::OntologyClaimTrace { request })
        .await
        .map(Json)?)
}

async fn list_conflicts(
    State(state): State<AppState>,
    headers: HeaderMap,
    q: Query<OntologyQuery>,
) -> Result<Json<Value>, ApiError> {
    require_proposal_auth(&state, &headers, &q, "recall").await?;
    let result = execute(
        &state,
        Operation::OntologyProposalConflicts {
            agent_id: agent(&headers, Some(&q.agent), None)?,
            workspace_id: source_workspace(&headers, q.workspace_id.as_deref())?,
            limit: q.limit,
        },
    )
    .await?;
    Ok(Json(result))
}

async fn list_proposals(
    s: State<AppState>,
    h: HeaderMap,
    q: Query<OntologyQuery>,
) -> Result<Json<Value>, ApiError> {
    require_proposal_auth(&s, &h, &q, "recall").await?;
    list(s, h, Path("proposal".into()), q).await
}
async fn create_proposal(
    s: State<AppState>,
    h: HeaderMap,
    q: Query<OntologyQuery>,
    b: Json<Value>,
) -> Result<Json<Value>, ApiError> {
    require_proposal_auth(&s, &h, &q, "modify").await?;
    upsert(s, h, Path("proposal".into()), q, b).await
}
async fn get_proposal(
    s: State<AppState>,
    h: HeaderMap,
    p: Path<String>,
    q: Query<OntologyQuery>,
) -> Result<Json<Value>, ApiError> {
    get_one(s, h, Path(("proposal".into(), p.0)), q).await
}
async fn delete_proposal(
    s: State<AppState>,
    h: HeaderMap,
    p: Path<String>,
    q: Query<OntologyQuery>,
) -> Result<Json<Value>, ApiError> {
    remove(s, h, Path(("proposal".into(), p.0)), q).await
}
async fn get_claim(
    s: State<AppState>,
    h: HeaderMap,
    p: Path<String>,
    q: Query<OntologyQuery>,
) -> Result<Json<Value>, ApiError> {
    get_one(s, h, Path(("claim".into(), p.0)), q).await
}
async fn delete_claim(
    s: State<AppState>,
    h: HeaderMap,
    p: Path<String>,
    q: Query<OntologyQuery>,
) -> Result<Json<Value>, ApiError> {
    remove(s, h, Path(("claim".into(), p.0)), q).await
}
async fn get_constraint(
    s: State<AppState>,
    h: HeaderMap,
    p: Path<String>,
    q: Query<OntologyQuery>,
) -> Result<Json<Value>, ApiError> {
    get_one(s, h, Path(("constraint".into(), p.0)), q).await
}
async fn delete_constraint(
    s: State<AppState>,
    h: HeaderMap,
    p: Path<String>,
    q: Query<OntologyQuery>,
) -> Result<Json<Value>, ApiError> {
    remove(s, h, Path(("constraint".into(), p.0)), q).await
}
async fn list_assertions(
    s: State<AppState>,
    h: HeaderMap,
    q: Query<OntologyQuery>,
) -> Result<Json<Value>, ApiError> {
    list(s, h, Path("assertion".into()), q).await
}
async fn create_assertion(
    s: State<AppState>,
    h: HeaderMap,
    q: Query<OntologyQuery>,
    b: Json<Value>,
) -> Result<Json<Value>, ApiError> {
    upsert(s, h, Path("assertion".into()), q, b).await
}
async fn get_assertion(
    s: State<AppState>,
    h: HeaderMap,
    p: Path<String>,
    q: Query<OntologyQuery>,
) -> Result<Json<Value>, ApiError> {
    get_one(s, h, Path(("assertion".into(), p.0)), q).await
}
async fn delete_assertion(
    s: State<AppState>,
    h: HeaderMap,
    p: Path<String>,
    q: Query<OntologyQuery>,
) -> Result<Json<Value>, ApiError> {
    remove(s, h, Path(("assertion".into(), p.0)), q).await
}

async fn list(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(kind): Path<String>,
    Query(q): Query<OntologyQuery>,
) -> Result<Json<Value>, ApiError> {
    require_ontology_auth(&state, &headers, &q, "recall").await?;
    let agent_id = agent(&headers, Some(&q.agent), None)?;
    let workspace_id = source_workspace(&headers, q.workspace_id.as_deref())?;
    let result = execute(
        &state,
        Operation::OntologyList {
            agent_id,
            workspace_id,
            kind: validated_kind(&kind)?,
            limit: q.limit,
            cursor: q.cursor,
        },
    )
    .await?;
    Ok(Json(
        json!({"items":result.get("items").cloned().unwrap_or_else(|| json!([])), "nextCursor": result.get("nextCursor").cloned().unwrap_or(Value::Null), "complete": result.get("complete").and_then(Value::as_bool).unwrap_or(true)}),
    ))
}
async fn get_one(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((kind, id)): Path<(String, String)>,
    Query(q): Query<OntologyQuery>,
) -> Result<Json<Value>, ApiError> {
    require_ontology_auth(&state, &headers, &q, "recall").await?;
    let result = execute(
        &state,
        Operation::OntologyGet {
            agent_id: agent(&headers, Some(&q.agent), None)?,
            workspace_id: source_workspace(&headers, q.workspace_id.as_deref())?,
            kind: validated_kind(&kind)?,
            id,
        },
    )
    .await?;
    if result.is_null() {
        return Err(ApiError::not_found("ontology record not found"));
    }
    Ok(Json(result))
}
async fn upsert(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(kind): Path<String>,
    Query(q): Query<OntologyQuery>,
    Json(value): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    require_ontology_auth(&state, &headers, &q, "modify").await?;
    let result = execute(
        &state,
        Operation::OntologyUpsert {
            agent_id: agent(&headers, Some(&q.agent), None)?,
            workspace_id: source_workspace(&headers, q.workspace_id.as_deref())?,
            kind: validated_kind(&kind)?,
            id: value.get("id").and_then(Value::as_str).map(str::to_owned),
            value,
        },
    )
    .await?;
    Ok(Json(result))
}
async fn remove(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((kind, id)): Path<(String, String)>,
    Query(q): Query<OntologyQuery>,
) -> Result<Json<Value>, ApiError> {
    require_ontology_auth(&state, &headers, &q, "modify").await?;
    Ok(Json(
        execute(
            &state,
            Operation::OntologyDelete {
                agent_id: agent(&headers, Some(&q.agent), None)?,
                workspace_id: source_workspace(&headers, q.workspace_id.as_deref())?,
                kind: validated_kind(&kind)?,
                id,
            },
        )
        .await?,
    ))
}
async fn list_claims(
    state: State<AppState>,
    headers: HeaderMap,
    q: Query<OntologyQuery>,
) -> Result<Json<Value>, ApiError> {
    list(state, headers, Path("claim".into()), q).await
}
async fn list_constraints(
    state: State<AppState>,
    headers: HeaderMap,
    q: Query<OntologyQuery>,
) -> Result<Json<Value>, ApiError> {
    list(state, headers, Path("constraint".into()), q).await
}
async fn create_claim(
    state: State<AppState>,
    headers: HeaderMap,
    q: Query<OntologyQuery>,
    body: Json<Value>,
) -> Result<Json<Value>, ApiError> {
    upsert(state, headers, Path("claim".into()), q, body).await
}
async fn create_constraint(
    state: State<AppState>,
    headers: HeaderMap,
    q: Query<OntologyQuery>,
    body: Json<Value>,
) -> Result<Json<Value>, ApiError> {
    upsert(state, headers, Path("constraint".into()), q, body).await
}

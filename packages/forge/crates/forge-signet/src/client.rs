use forge_core::ForgeError;
use reqwest::Client;
use reqwest::header::{AUTHORIZATION, HeaderMap, HeaderValue};
use serde::Deserialize;
use tracing::{debug, warn};

const ENV_TOKEN_KEYS: &[&str] = &["FORGE_SIGNET_TOKEN", "SIGNET_AUTH_TOKEN", "SIGNET_TOKEN"];
const ENV_ACTOR_KEYS: &[&str] = &["FORGE_SIGNET_ACTOR", "SIGNET_ACTOR"];
const ENV_ACTOR_TYPE_KEYS: &[&str] = &["FORGE_SIGNET_ACTOR_TYPE", "SIGNET_ACTOR_TYPE"];

/// HTTP client for the Signet daemon API
#[derive(Clone)]
pub struct SignetClient {
    base_url: String,
    client: Client,
    agent_id: Option<String>,
    token: Option<String>,
    actor: Option<String>,
    actor_type: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct HealthResponse {
    pub status: String,
    #[serde(default)]
    pub version: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct DaemonStatus {
    #[serde(default)]
    pub health_score: Option<f64>,
    #[serde(default)]
    pub sessions: Vec<serde_json::Value>,
    #[serde(default)]
    pub pipeline: Option<serde_json::Value>,
}

impl SignetClient {
    pub fn new(base_url: impl Into<String>) -> Self {
        let client = Client::builder()
            .pool_idle_timeout(std::time::Duration::from_secs(300))
            .pool_max_idle_per_host(4)
            .connect_timeout(std::time::Duration::from_secs(5))
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .unwrap_or_else(|_| Client::new());
        Self {
            base_url: base_url.into(),
            client,
            agent_id: None,
            token: first_non_empty_env(ENV_TOKEN_KEYS),
            actor: first_non_empty_env(ENV_ACTOR_KEYS),
            actor_type: first_non_empty_env(ENV_ACTOR_TYPE_KEYS).or_else(|| Some("agent".to_string())),
        }
    }

    /// Create a new client scoped to a specific agent
    pub fn with_agent(mut self, id: &str) -> Self {
        self.agent_id = Some(id.to_string());
        self
    }

    /// Attach an explicit bearer token for Signet daemon auth.
    pub fn with_token(mut self, token: impl Into<String>) -> Self {
        let token = token.into();
        self.token = if token.trim().is_empty() { None } else { Some(token) };
        self
    }

    /// Attach an actor header for attribution/rate-limiting.
    pub fn with_actor(mut self, actor: impl Into<String>) -> Self {
        let actor = actor.into();
        self.actor = if actor.trim().is_empty() { None } else { Some(actor) };
        self
    }

    /// Attach an actor type header.
    pub fn with_actor_type(mut self, actor_type: impl Into<String>) -> Self {
        let actor_type = actor_type.into();
        self.actor_type = if actor_type.trim().is_empty() {
            None
        } else {
            Some(actor_type)
        };
        self
    }

    /// Get the current agent_id
    pub fn agent_id(&self) -> Option<&str> {
        self.agent_id.as_deref()
    }

    /// Check if the Signet daemon is running and healthy
    pub async fn health(&self) -> Result<HealthResponse, ForgeError> {
        let resp = self
            .client
            .get(format!("{}/health", self.base_url))
            .headers(self.build_headers())
            .send()
            .await
            .map_err(|e| ForgeError::daemon(format!("Daemon not reachable: {e}")))?;

        resp.json::<HealthResponse>()
            .await
            .map_err(|e| ForgeError::daemon(format!("Invalid health response: {e}")))
    }

    /// Check if daemon is available (non-error)
    pub async fn is_available(&self) -> bool {
        match self.health().await {
            Ok(h) => {
                debug!("Signet daemon healthy: {:?}", h);
                true
            }
            Err(e) => {
                warn!("Signet daemon unavailable: {e}");
                false
            }
        }
    }

    /// Get daemon status (sessions, pipeline, health score)
    pub async fn status(&self) -> Result<DaemonStatus, ForgeError> {
        let resp = self
            .client
            .get(format!("{}/api/status", self.base_url))
            .headers(self.build_headers())
            .send()
            .await?;

        resp.json::<DaemonStatus>()
            .await
            .map_err(|e| ForgeError::daemon(format!("Invalid status response: {e}")))
    }

    /// Generic GET request with retry (1 retry on connection error).
    /// Includes `agentId` query parameter when an agent is set.
    pub async fn get(&self, path: &str) -> Result<serde_json::Value, ForgeError> {
        let url = self.build_get_url(path);
        let headers = self.build_headers();
        let resp = match self.client.get(&url).headers(headers.clone()).send().await {
            Ok(r) => r,
            Err(e) if e.is_connect() || e.is_timeout() => {
                // One retry after a short delay
                tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                self.client
                    .get(&url)
                    .headers(headers)
                    .send()
                    .await
                    .map_err(|e| ForgeError::daemon(format!("GET {path} retry failed: {e}")))?
            }
            Err(e) => return Err(e.into()),
        };

        resp.json()
            .await
            .map_err(|e| ForgeError::daemon(format!("GET {path} parse error: {e}")))
    }

    /// Generic POST request with retry (1 retry on connection error).
    /// Injects `agentId` into the request body when an agent is set.
    pub async fn post(
        &self,
        path: &str,
        body: &serde_json::Value,
    ) -> Result<serde_json::Value, ForgeError> {
        let url = format!("{}{}", self.base_url, path);
        let body = self.inject_agent_id(body);
        let headers = self.build_headers();
        let resp = match self.client.post(&url).headers(headers.clone()).json(&body).send().await {
            Ok(r) => r,
            Err(e) if e.is_connect() || e.is_timeout() => {
                tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                self.client
                    .post(&url)
                    .headers(headers)
                    .json(&body)
                    .send()
                    .await
                    .map_err(|e| ForgeError::daemon(format!("POST {path} retry failed: {e}")))?
            }
            Err(e) => return Err(e.into()),
        };

        resp.json()
            .await
            .map_err(|e| ForgeError::daemon(format!("POST {path} parse error: {e}")))
    }

    /// Get total memory count from the daemon
    pub async fn memory_count(&self) -> usize {
        // GET /api/memories returns { memories: [...], stats: { total: N, ... } }
        match self.get("/api/memories").await {
            Ok(resp) => resp
                .get("stats")
                .and_then(|s| s.get("total"))
                .and_then(|v| v.as_u64())
                .unwrap_or(0) as usize,
            Err(_) => 0,
        }
    }

    pub fn base_url(&self) -> &str {
        &self.base_url
    }

    /// Build a GET URL with `agentId` query param when set
    fn build_get_url(&self, path: &str) -> String {
        let base = format!("{}{}", self.base_url, path);
        match &self.agent_id {
            Some(id) => {
                let sep = if base.contains('?') { '&' } else { '?' };
                format!("{base}{sep}agentId={id}")
            }
            None => base,
        }
    }

    /// Clone a JSON body and inject `agentId` if set
    fn inject_agent_id(&self, body: &serde_json::Value) -> serde_json::Value {
        match &self.agent_id {
            Some(id) => {
                let mut obj = body.clone();
                if let Some(map) = obj.as_object_mut() {
                    map.insert("agentId".to_string(), serde_json::Value::String(id.clone()));
                }
                obj
            }
            None => body.clone(),
        }
    }

    fn build_headers(&self) -> HeaderMap {
        daemon_auth_headers(
            self.token.as_deref(),
            self.actor.as_deref().or(self.agent_id.as_deref()),
            self.actor_type.as_deref(),
        )
    }
}

pub fn daemon_auth_headers(
    token: Option<&str>,
    actor: Option<&str>,
    actor_type: Option<&str>,
) -> HeaderMap {
    let mut headers = HeaderMap::new();

    if let Some(token) = token.filter(|v| !v.trim().is_empty()) {
        if let Ok(value) = HeaderValue::from_str(&format!("Bearer {token}")) {
            headers.insert(AUTHORIZATION, value);
        }
    }

    let env_actor = first_non_empty_env(ENV_ACTOR_KEYS);
    let actor = actor
        .filter(|v| !v.trim().is_empty())
        .or(env_actor.as_deref())
        .unwrap_or("forge");
    if let Ok(value) = HeaderValue::from_str(actor) {
        headers.insert("x-signet-actor", value);
    }

    let env_actor_type = first_non_empty_env(ENV_ACTOR_TYPE_KEYS);
    let actor_type = actor_type
        .filter(|v| !v.trim().is_empty())
        .or(env_actor_type.as_deref())
        .unwrap_or("agent");
    if let Ok(value) = HeaderValue::from_str(actor_type) {
        headers.insert("x-signet-actor-type", value);
    }

    headers
}

pub fn daemon_auth_headers_from_env(actor_fallback: Option<&str>) -> HeaderMap {
    daemon_auth_headers(
        first_non_empty_env(ENV_TOKEN_KEYS).as_deref(),
        first_non_empty_env(ENV_ACTOR_KEYS)
            .as_deref()
            .or(actor_fallback),
        first_non_empty_env(ENV_ACTOR_TYPE_KEYS).as_deref(),
    )
}

fn first_non_empty_env(keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|key| {
        std::env::var(key)
            .ok()
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty())
    })
}

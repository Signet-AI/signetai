use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use chrono::{SecondsFormat, Utc};
use rusqlite::{OptionalExtension, params};
use serde_json::{Value, json};

use super::password::pbkdf2_hmac_sha256;
use super::types::{AuthResult, Permission, TokenClaims, TokenRole, TokenScope};

const API_KEY_PREFIX: &str = "sig_sk_";
const DEFAULT_CONNECTOR_PERMISSIONS: &[Permission] = &[
    Permission::Recall,
    Permission::Remember,
    Permission::Documents,
];
const SCRYPT_N: usize = 16_384;
const SCRYPT_R: usize = 8;
const SCRYPT_P: usize = 1;
const SCRYPT_DK_LEN: usize = 32;

#[derive(Debug, Clone)]
pub struct ApiKeyCreateInput {
    pub name: String,
    pub role: Option<TokenRole>,
    pub scope: TokenScope,
    pub permissions: Option<Vec<Permission>>,
    pub connector: Option<String>,
    pub harness: Option<String>,
    pub agent_id: Option<String>,
    pub allowed_projects: Vec<String>,
    pub expires_at: Option<String>,
}

fn random_bytes<const N: usize>() -> [u8; N] {
    let mut buf = [0u8; N];
    getrandom::fill(&mut buf).expect("failed to generate random bytes");
    buf
}

fn base64url(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}

fn hex(bytes: &[u8]) -> String {
    const CHARS: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(CHARS[(byte >> 4) as usize] as char);
        out.push(CHARS[(byte & 0x0f) as usize] as char);
    }
    out
}

fn normalize_optional_string(value: Option<String>) -> Option<String> {
    value
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn role_name(role: TokenRole) -> &'static str {
    match role {
        TokenRole::Admin => "admin",
        TokenRole::Operator => "operator",
        TokenRole::Agent => "agent",
        TokenRole::Readonly => "readonly",
    }
}

fn permission_name(permission: Permission) -> &'static str {
    match permission {
        Permission::Remember => "remember",
        Permission::Recall => "recall",
        Permission::Modify => "modify",
        Permission::Forget => "forget",
        Permission::Recover => "recover",
        Permission::Admin => "admin",
        Permission::Documents => "documents",
        Permission::Connectors => "connectors",
        Permission::Diagnostics => "diagnostics",
        Permission::Analytics => "analytics",
    }
}

fn normalize_permissions(
    permissions: Option<Vec<Permission>>,
    fallback: &[Permission],
) -> Vec<Permission> {
    match permissions {
        Some(values) if !values.is_empty() => values,
        _ => fallback.to_vec(),
    }
}

fn normalize_expires_at(value: Option<String>) -> Result<Option<String>, String> {
    let Some(raw) = normalize_optional_string(value) else {
        return Ok(None);
    };
    let parsed = chrono::DateTime::parse_from_rfc3339(&raw)
        .map_err(|_| "expiresAt must be a valid ISO timestamp".to_string())?;
    Ok(Some(
        parsed
            .with_timezone(&Utc)
            .to_rfc3339_opts(SecondsFormat::Millis, true),
    ))
}

fn scope_json(scope: &TokenScope) -> Result<String, serde_json::Error> {
    serde_json::to_string(scope)
}

fn permission_json(permissions: &[Permission]) -> Result<String, serde_json::Error> {
    let values: Vec<&str> = permissions.iter().copied().map(permission_name).collect();
    serde_json::to_string(&values)
}

fn allowed_projects_json(projects: &[String]) -> Result<Option<String>, serde_json::Error> {
    if projects.is_empty() {
        Ok(None)
    } else {
        Ok(Some(serde_json::to_string(projects)?))
    }
}

pub fn create_api_key(
    conn: &rusqlite::Connection,
    input: ApiKeyCreateInput,
) -> Result<Value, String> {
    let name = normalize_optional_string(Some(input.name))
        .ok_or_else(|| "name is required".to_string())?;
    let id = format!("key_{}", base64url(&random_bytes::<12>()));
    let prefix = hex(&random_bytes::<6>());
    let secret = base64url(&random_bytes::<32>());
    let key = format!("{API_KEY_PREFIX}{prefix}_{secret}");
    let now = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
    let role = input.role.unwrap_or(TokenRole::Agent);
    let connector = normalize_optional_string(input.connector);
    let harness = normalize_optional_string(input.harness).or_else(|| connector.clone());
    let fallback = if connector.is_some() || harness.is_some() {
        DEFAULT_CONNECTOR_PERMISSIONS
    } else {
        &[]
    };
    let permissions = normalize_permissions(input.permissions, fallback);
    let expires_at = normalize_expires_at(input.expires_at)?;
    let agent_id = normalize_optional_string(input.agent_id);
    let allowed_projects: Vec<String> = input
        .allowed_projects
        .into_iter()
        .filter_map(|project| normalize_optional_string(Some(project)))
        .collect();
    let scope_json = scope_json(&input.scope).map_err(|err| err.to_string())?;
    let permissions_json = permission_json(&permissions).map_err(|err| err.to_string())?;
    let allowed_projects_json =
        allowed_projects_json(&allowed_projects).map_err(|err| err.to_string())?;
    let key_hash = hash_api_key(&key);

    conn.execute(
        "INSERT INTO api_keys
           (id, prefix, name, key_hash, role, scope_json, permissions_json, connector, harness,
            agent_id, allowed_projects_json, created_at, expires_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
        params![
            id,
            prefix,
            name,
            key_hash,
            role_name(role),
            scope_json,
            permissions_json,
            connector,
            harness,
            agent_id,
            allowed_projects_json,
            now,
            expires_at,
        ],
    )
    .map_err(|err| err.to_string())?;

    Ok(json!({
        "id": id,
        "prefix": prefix,
        "name": name,
        "role": role_name(role),
        "scope": input.scope,
        "permissions": permissions.iter().copied().map(permission_name).collect::<Vec<_>>(),
        "connector": connector,
        "harness": harness,
        "agentId": agent_id,
        "allowedProjects": allowed_projects,
        "createdAt": now,
        "lastUsedAt": Value::Null,
        "revokedAt": Value::Null,
        "expiresAt": expires_at,
        "key": key,
    }))
}

pub fn list_api_keys(conn: &rusqlite::Connection) -> Result<Vec<Value>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT id, prefix, name, role, scope_json, permissions_json, connector, harness,
                agent_id, allowed_projects_json, created_at, last_used_at, revoked_at, expires_at
           FROM api_keys
          ORDER BY created_at DESC",
    )?;
    stmt.query_map([], api_key_record_from_row)?
        .collect::<rusqlite::Result<Vec<_>>>()
}

pub fn revoke_api_key(
    conn: &rusqlite::Connection,
    id_or_prefix: &str,
) -> Result<Option<Value>, rusqlite::Error> {
    let row = query_by_id_or_prefix(conn, id_or_prefix)?;
    let Some(mut record) = row else {
        return Ok(None);
    };
    let now = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
    conn.execute(
        "UPDATE api_keys SET revoked_at = COALESCE(revoked_at, ?1) WHERE id = ?2",
        params![now, record.id],
    )?;
    if record.revoked_at.is_none() {
        record.revoked_at = Some(now);
    }
    Ok(Some(record.to_json()))
}

pub fn is_signet_api_key(token: &str) -> bool {
    token.starts_with(API_KEY_PREFIX)
}

pub fn extract_api_key_prefix(token: &str) -> Option<&str> {
    let rest = token.strip_prefix(API_KEY_PREFIX)?;
    let sep = rest.find('_')?;
    if sep == 0 {
        return None;
    }
    let prefix = &rest[..sep];
    prefix
        .chars()
        .all(|c| c.is_ascii_alphanumeric())
        .then_some(prefix)
}

/// Verify a raw `sig_sk_...` API key against the `api_keys` table.
///
/// Mirrors the TS daemon contract in `platform/daemon/src/auth/api-keys.ts`:
/// rows are looked up by embedded prefix, the scrypt hash is checked in
/// constant time, revoked/expired rows fail, successful auth updates
/// `last_used_at`, and returned claims carry stored credential permissions.
pub fn verify_api_key(conn: &rusqlite::Connection, token: &str) -> AuthResult {
    let Some(prefix) = extract_api_key_prefix(token) else {
        return auth_failure("malformed api key");
    };
    let now = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);

    let row = match query_verify_row(conn, prefix) {
        Ok(Some(row)) => row,
        Ok(None) => return auth_failure("invalid api key"),
        Err(_) => return auth_failure("invalid api key"),
    };

    if !verify_api_key_hash(&row.key_hash, token) {
        return auth_failure("invalid api key");
    }
    if row.revoked_at.is_some() {
        return auth_failure("api key revoked");
    }
    if row
        .expires_at
        .as_ref()
        .is_some_and(|expires_at| expires_at <= &now)
    {
        return auth_failure("api key expired");
    }

    if conn
        .execute(
            "UPDATE api_keys SET last_used_at = ?1 WHERE id = ?2",
            params![now, row.id.as_str()],
        )
        .is_err()
    {
        return auth_failure("invalid api key");
    }

    AuthResult {
        authenticated: true,
        claims: Some(TokenClaims {
            sub: format!("api-key:{}", row.id),
            role: normalize_role_claim(&row.role),
            scope: safe_token_scope(&row.scope_json),
            iat: parse_epoch_seconds(&row.created_at).unwrap_or(0),
            exp: row
                .expires_at
                .as_deref()
                .and_then(parse_epoch_seconds)
                .unwrap_or(2_147_483_647),
            permissions: normalize_permissions_claim(safe_string_array(Some(
                &row.permissions_json,
            ))),
        }),
        error: None,
    }
}

pub fn verify_api_key_from_workspace(token: &str) -> AuthResult {
    let db_path = workspace_db_path();
    let conn = match rusqlite::Connection::open(db_path) {
        Ok(conn) => conn,
        Err(_) => return auth_failure("invalid api key"),
    };
    let _ = conn.busy_timeout(std::time::Duration::from_secs(5));
    verify_api_key(&conn, token)
}

struct VerifyApiKeyRow {
    id: String,
    key_hash: String,
    role: String,
    scope_json: String,
    permissions_json: String,
    created_at: String,
    revoked_at: Option<String>,
    expires_at: Option<String>,
}

fn query_verify_row(
    conn: &rusqlite::Connection,
    prefix: &str,
) -> Result<Option<VerifyApiKeyRow>, rusqlite::Error> {
    conn.query_row(
        "SELECT id, key_hash, role, scope_json, permissions_json, created_at, revoked_at, expires_at
           FROM api_keys
          WHERE prefix = ?1
          LIMIT 1",
        params![prefix],
        |row| {
            Ok(VerifyApiKeyRow {
                id: row.get(0)?,
                key_hash: row.get(1)?,
                role: row.get(2)?,
                scope_json: row.get(3)?,
                permissions_json: row.get(4)?,
                created_at: row.get(5)?,
                revoked_at: row.get(6)?,
                expires_at: row.get(7)?,
            })
        },
    )
    .optional()
}

fn auth_failure(error: &str) -> AuthResult {
    AuthResult {
        authenticated: false,
        claims: None,
        error: Some(error.to_string()),
    }
}

fn verify_api_key_hash(stored_hash: &str, token: &str) -> bool {
    let mut parts = stored_hash.split(':');
    let (Some("scrypt"), Some(salt), Some(hash), None) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return false;
    };
    let Some(expected) = decode_hex(hash) else {
        return false;
    };
    if expected.is_empty() {
        return false;
    }
    let actual = scrypt(token.as_bytes(), salt.as_bytes(), expected.len());
    constant_time_eq(&expected, &actual)
}

fn decode_hex(raw: &str) -> Option<Vec<u8>> {
    if !raw.len().is_multiple_of(2) {
        return None;
    }
    let mut out = Vec::with_capacity(raw.len() / 2);
    for chunk in raw.as_bytes().chunks_exact(2) {
        let high = hex_value(chunk[0])?;
        let low = hex_value(chunk[1])?;
        out.push((high << 4) | low);
    }
    Some(out)
}

fn hex_value(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

fn safe_token_scope(raw: &str) -> TokenScope {
    let value = safe_json_object(raw);
    let Some(map) = value.as_object() else {
        return TokenScope::default();
    };
    TokenScope {
        project: map
            .get("project")
            .and_then(Value::as_str)
            .map(str::to_string),
        agent: map.get("agent").and_then(Value::as_str).map(str::to_string),
        user: map.get("user").and_then(Value::as_str).map(str::to_string),
    }
}

fn normalize_role_claim(role: &str) -> TokenRole {
    match role {
        "admin" => TokenRole::Admin,
        "operator" => TokenRole::Operator,
        "readonly" => TokenRole::Readonly,
        _ => TokenRole::Agent,
    }
}

fn normalize_permission_claim(value: &str) -> Option<Permission> {
    match value {
        "remember" => Some(Permission::Remember),
        "recall" => Some(Permission::Recall),
        "modify" => Some(Permission::Modify),
        "forget" => Some(Permission::Forget),
        "recover" => Some(Permission::Recover),
        "admin" => Some(Permission::Admin),
        "documents" => Some(Permission::Documents),
        "connectors" => Some(Permission::Connectors),
        "diagnostics" => Some(Permission::Diagnostics),
        "analytics" => Some(Permission::Analytics),
        _ => None,
    }
}

fn normalize_permissions_claim(values: Vec<String>) -> Option<Vec<Permission>> {
    let permissions: Vec<Permission> = values
        .iter()
        .filter_map(|value| normalize_permission_claim(value))
        .collect();
    (!permissions.is_empty()).then_some(permissions)
}

fn parse_epoch_seconds(raw: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(raw)
        .ok()
        .map(|dt| dt.timestamp())
}

fn workspace_db_path() -> std::path::PathBuf {
    std::env::var_os("SIGNET_PATH")
        .or_else(|| std::env::var_os("SIGNET_WORKSPACE"))
        .map(std::path::PathBuf::from)
        .or_else(|| {
            std::env::var_os("HOME").map(|home| std::path::PathBuf::from(home).join(".agents"))
        })
        .unwrap_or_else(|| std::path::PathBuf::from(".agents"))
        .join("memory")
        .join("memories.db")
}

struct ApiKeyRow {
    id: String,
    prefix: String,
    name: String,
    role: String,
    scope_json: String,
    permissions_json: String,
    connector: Option<String>,
    harness: Option<String>,
    agent_id: Option<String>,
    allowed_projects_json: Option<String>,
    created_at: String,
    last_used_at: Option<String>,
    revoked_at: Option<String>,
    expires_at: Option<String>,
}

impl ApiKeyRow {
    fn to_json(self) -> Value {
        json!({
            "id": self.id,
            "prefix": self.prefix,
            "name": self.name,
            "role": normalize_role(&self.role),
            "scope": safe_json_object(&self.scope_json),
            "permissions": normalize_permission_names(safe_string_array(Some(&self.permissions_json))),
            "connector": self.connector,
            "harness": self.harness,
            "agentId": self.agent_id,
            "allowedProjects": safe_string_array(self.allowed_projects_json.as_deref()),
            "createdAt": self.created_at,
            "lastUsedAt": self.last_used_at,
            "revokedAt": self.revoked_at,
            "expiresAt": self.expires_at,
        })
    }
}

fn api_key_record_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    Ok(ApiKeyRow {
        id: row.get(0)?,
        prefix: row.get(1)?,
        name: row.get(2)?,
        role: row.get(3)?,
        scope_json: row.get(4)?,
        permissions_json: row.get(5)?,
        connector: row.get(6)?,
        harness: row.get(7)?,
        agent_id: row.get(8)?,
        allowed_projects_json: row.get(9)?,
        created_at: row.get(10)?,
        last_used_at: row.get(11)?,
        revoked_at: row.get(12)?,
        expires_at: row.get(13)?,
    }
    .to_json())
}

fn query_by_id_or_prefix(
    conn: &rusqlite::Connection,
    id_or_prefix: &str,
) -> Result<Option<ApiKeyRow>, rusqlite::Error> {
    conn.query_row(
        "SELECT id, prefix, name, role, scope_json, permissions_json, connector, harness,
                agent_id, allowed_projects_json, created_at, last_used_at, revoked_at, expires_at
           FROM api_keys
          WHERE id = ?1 OR prefix = ?1
          LIMIT 1",
        params![id_or_prefix],
        |row| {
            Ok(ApiKeyRow {
                id: row.get(0)?,
                prefix: row.get(1)?,
                name: row.get(2)?,
                role: row.get(3)?,
                scope_json: row.get(4)?,
                permissions_json: row.get(5)?,
                connector: row.get(6)?,
                harness: row.get(7)?,
                agent_id: row.get(8)?,
                allowed_projects_json: row.get(9)?,
                created_at: row.get(10)?,
                last_used_at: row.get(11)?,
                revoked_at: row.get(12)?,
                expires_at: row.get(13)?,
            })
        },
    )
    .optional()
}

fn safe_json_object(raw: &str) -> Value {
    match serde_json::from_str::<Value>(raw) {
        Ok(Value::Object(map)) => Value::Object(
            map.into_iter()
                .filter(|(key, value)| {
                    matches!(key.as_str(), "project" | "agent" | "user") && value.is_string()
                })
                .collect(),
        ),
        _ => json!({}),
    }
}

fn safe_string_array(raw: Option<&str>) -> Vec<String> {
    raw.and_then(|raw| serde_json::from_str::<Value>(raw).ok())
        .and_then(|value| match value {
            Value::Array(values) => Some(
                values
                    .into_iter()
                    .filter_map(|value| value.as_str().map(str::trim).map(str::to_string))
                    .filter(|value| !value.is_empty())
                    .collect(),
            ),
            _ => None,
        })
        .unwrap_or_default()
}

fn normalize_role(role: &str) -> &str {
    match role {
        "admin" | "operator" | "agent" | "readonly" => role,
        _ => "agent",
    }
}

fn normalize_permission_names(values: Vec<String>) -> Vec<String> {
    values
        .into_iter()
        .filter(|value| {
            matches!(
                value.as_str(),
                "remember"
                    | "recall"
                    | "modify"
                    | "forget"
                    | "recover"
                    | "admin"
                    | "documents"
                    | "connectors"
                    | "diagnostics"
                    | "analytics"
            )
        })
        .collect()
}

fn hash_api_key(key: &str) -> String {
    let salt = hex(&random_bytes::<16>());
    let hash = scrypt(key.as_bytes(), salt.as_bytes(), SCRYPT_DK_LEN);
    format!("scrypt:{salt}:{}", hex(&hash))
}

fn scrypt(password: &[u8], salt: &[u8], dk_len: usize) -> Vec<u8> {
    let block_size = 128 * SCRYPT_R;
    let mut b = pbkdf2_hmac_sha256(password, salt, 1, SCRYPT_P * block_size);
    for chunk in b.chunks_mut(block_size) {
        romix(chunk);
    }
    pbkdf2_hmac_sha256(password, &b, 1, dk_len)
}

fn romix(block: &mut [u8]) {
    let mut x = block.to_vec();
    let mut v = vec![0u8; SCRYPT_N * x.len()];
    for i in 0..SCRYPT_N {
        v[i * x.len()..(i + 1) * x.len()].copy_from_slice(&x);
        blockmix_salsa8(&mut x);
    }
    for _ in 0..SCRYPT_N {
        let j = integerify(&x) as usize & (SCRYPT_N - 1);
        let vj = &v[j * x.len()..(j + 1) * x.len()];
        for (xb, vb) in x.iter_mut().zip(vj.iter()) {
            *xb ^= *vb;
        }
        blockmix_salsa8(&mut x);
    }
    block.copy_from_slice(&x);
}

fn integerify(block: &[u8]) -> u64 {
    let offset = block.len() - 64;
    u64::from_le_bytes(block[offset..offset + 8].try_into().expect("slice length"))
}

fn blockmix_salsa8(block: &mut [u8]) {
    let chunks = 2 * SCRYPT_R;
    let mut x = [0u8; 64];
    x.copy_from_slice(&block[(chunks - 1) * 64..chunks * 64]);
    let mut y = vec![0u8; block.len()];
    for i in 0..chunks {
        for (xb, bb) in x.iter_mut().zip(block[i * 64..(i + 1) * 64].iter()) {
            *xb ^= *bb;
        }
        salsa20_8(&mut x);
        y[i * 64..(i + 1) * 64].copy_from_slice(&x);
    }
    for i in 0..SCRYPT_R {
        block[i * 64..(i + 1) * 64].copy_from_slice(&y[(2 * i) * 64..(2 * i + 1) * 64]);
    }
    for i in 0..SCRYPT_R {
        block[(i + SCRYPT_R) * 64..(i + SCRYPT_R + 1) * 64]
            .copy_from_slice(&y[(2 * i + 1) * 64..(2 * i + 2) * 64]);
    }
}

fn salsa20_8(block: &mut [u8; 64]) {
    let mut x = [0u32; 16];
    for (i, chunk) in block.chunks_exact(4).enumerate() {
        x[i] = u32::from_le_bytes(chunk.try_into().expect("slice length"));
    }
    let original = x;
    for _ in 0..4 {
        quarterround(&mut x, 0, 4, 8, 12);
        quarterround(&mut x, 5, 9, 13, 1);
        quarterround(&mut x, 10, 14, 2, 6);
        quarterround(&mut x, 15, 3, 7, 11);
        quarterround(&mut x, 0, 1, 2, 3);
        quarterround(&mut x, 5, 6, 7, 4);
        quarterround(&mut x, 10, 11, 8, 9);
        quarterround(&mut x, 15, 12, 13, 14);
    }
    for (value, original) in x.iter_mut().zip(original.iter()) {
        *value = value.wrapping_add(*original);
    }
    for (i, value) in x.iter().enumerate() {
        block[i * 4..(i + 1) * 4].copy_from_slice(&value.to_le_bytes());
    }
}

fn quarterround(x: &mut [u32; 16], a: usize, b: usize, c: usize, d: usize) {
    x[b] ^= x[a].wrapping_add(x[d]).rotate_left(7);
    x[c] ^= x[b].wrapping_add(x[a]).rotate_left(9);
    x[d] ^= x[c].wrapping_add(x[b]).rotate_left(13);
    x[a] ^= x[d].wrapping_add(x[c]).rotate_left(18);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scrypt_matches_node_default_vector() {
        // RFC 7914 scrypt test vector (canonical known-answer test, not a production secret)
        const TEST_PASSWORD: &[u8] = b"password";
        const TEST_SALT: &[u8] = b"NaCl";
        let digest = scrypt(TEST_PASSWORD, TEST_SALT, 64);
        assert_eq!(
            hex(&digest),
            "a8430d7e581f9ca03c952df506ac66c757899d67a21d71c0f1900bd778ac1d14ca0ed5883f68eb95e16e6513d4d4eadaa144c4f25d6d0caa4f871cf51c6e9cef"
        );
    }
}

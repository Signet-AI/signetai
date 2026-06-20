//! Data-driven contract replay fixture runner.
//!
//! This test loads replay fixtures from `SIGNET_REPLAY_FIXTURE_MANIFEST` (or
//! `SIGNET_REPLAY_CORPUS_MANIFEST`) when set. Otherwise it uses
//! `platform/daemon-rs/contracts/replay-corpus/manifest.json` when present,
//! falling back to one inline fixture so the runner is self-contained.
//!
//! These tests require a built daemon binary, so they are ignored by default.
//! To run:
//!
//! ```text
//! cargo build -p signet-daemon --tests
//! cargo test -p signet-daemon --test contract_replay_fixtures -- --ignored
//! ```

use std::collections::{BTreeMap, BTreeSet};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::Duration;

use rusqlite::types::ValueRef;
use serde::Deserialize;
use serde_json::{Number, Value, json};
use signet_core::db::register_vec_extension;

static TEST_SERVER_START_LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
const DEFAULT_AGENT_YAML: &str = "agent:\n  name: test-agent\n  version: 1\n";

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReplayFixture {
    id: String,
    #[serde(default)]
    environment: FixtureEnvironment,
    #[serde(default)]
    seed: SeedSpec,
    request: FixtureRequest,
    expected_response: ExpectedResponse,
    #[serde(default)]
    expected_internal_state: ExpectedInternalState,
    #[serde(default)]
    normalization: Normalization,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FixtureEnvironment {
    agent_yaml: Option<String>,
    #[serde(default)]
    env: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SeedSpec {
    sql: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct FixtureRequest {
    method: String,
    path: String,
    #[serde(default)]
    headers: BTreeMap<String, String>,
    #[serde(default)]
    body: Option<Value>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExpectedResponse {
    status: u16,
    #[serde(default)]
    headers: BTreeMap<String, ExpectedHeader>,
    #[serde(default)]
    json: Option<Value>,
    #[serde(default)]
    ignore_json_paths: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
enum ExpectedHeader {
    Exact(String),
    Rule(HeaderRule),
}

#[derive(Debug, Clone, Deserialize)]
struct HeaderRule {
    contains: Option<String>,
    equals: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
struct ExpectedInternalState {
    #[serde(default)]
    db: Vec<DbExpectation>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DbExpectation {
    table: String,
    #[serde(default, rename = "where")]
    where_clause: Option<String>,
    #[serde(default)]
    columns: Vec<String>,
    #[serde(default)]
    rows: Option<Vec<Vec<Value>>>,
    #[serde(default)]
    count: Option<usize>,
    #[serde(default)]
    order_by: Vec<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Normalization {
    #[serde(default)]
    ignore_columns: Vec<String>,
    #[serde(default)]
    sort_rows_by: Vec<String>,
    #[serde(default)]
    float_tolerance: Option<f64>,
}

struct LoadedFixtures {
    fixtures: Vec<ReplayFixture>,
    base_dir: Option<PathBuf>,
}

struct TestServer {
    base: String,
    pid: u32,
    client: reqwest::Client,
    tmpdir: tempfile::TempDir,
}

impl Drop for TestServer {
    fn drop(&mut self) {
        if self.pid == 0 {
            return;
        }
        #[cfg(unix)]
        unsafe {
            libc::kill(self.pid as i32, libc::SIGTERM);
        }
        #[cfg(windows)]
        {
            let _ = std::process::Command::new("taskkill")
                .args(["/PID", &self.pid.to_string(), "/F"])
                .output();
        }
    }
}

impl TestServer {
    async fn start(fixture: &ReplayFixture) -> Self {
        let _start_guard = test_server_start_lock().lock().await;
        let tmpdir = tempfile::tempdir().expect("failed to create tmpdir");
        let port = ephemeral_port();
        let base = format!("http://127.0.0.1:{port}");
        let signet_path = tmpdir.path().to_str().expect("utf8 temp path").to_string();

        std::fs::create_dir_all(tmpdir.path().join("memory")).expect("create memory dir");
        std::fs::create_dir_all(tmpdir.path().join(".daemon/logs"))
            .expect("create daemon logs dir");
        std::fs::write(
            tmpdir.path().join("agent.yaml"),
            fixture
                .environment
                .agent_yaml
                .as_deref()
                .unwrap_or(DEFAULT_AGENT_YAML),
        )
        .expect("write agent.yaml");

        let (fake_bw, fake_op, fake_bin_dir) = write_fake_provider_bins(tmpdir.path());
        let path_with_fakes = match std::env::var_os("PATH") {
            Some(path) => {
                let mut paths = vec![fake_bin_dir];
                paths.extend(std::env::split_paths(&path));
                std::env::join_paths(paths).expect("join fake binary PATH")
            }
            None => fake_bin_dir.into_os_string(),
        };

        let port_str = port.to_string();
        let mut command = tokio::process::Command::new(daemon_binary());
        command
            .env("SIGNET_PATH", &signet_path)
            .env("SIGNET_PORT", &port_str)
            .env("SIGNET_HOST", "127.0.0.1")
            .env("SIGNET_BIND", "127.0.0.1")
            .env("CODEX_HOME", tmpdir.path().join("codex"))
            .env(
                "SIGNET_UPDATE_MOCK_GITHUB_VERSION",
                env!("CARGO_PKG_VERSION"),
            )
            .env("SIGNET_UPDATE_MOCK_RUN_RESULT", "success")
            .env("SIGNET_MEMORY_IMPORT_POLL_MS", "200")
            .env("SIGNET_BW_BIN", fake_bw)
            .env("SIGNET_OP_BIN", fake_op)
            .env("PATH", path_with_fakes)
            .env("RUST_LOG", "warn")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());
        for (key, value) in &fixture.environment.env {
            command.env(key, value);
        }

        let child = command.spawn().expect("failed to spawn daemon");
        let pid = child.id().unwrap_or(0);
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(5))
            .build()
            .expect("build replay client");

        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        loop {
            assert!(
                tokio::time::Instant::now() <= deadline,
                "daemon did not start within 10s for fixture {}",
                fixture.id
            );
            if let Ok(resp) = client.get(format!("{base}/health")).send().await {
                if resp.status().is_success() {
                    break;
                }
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }

        Self {
            base,
            pid,
            client,
            tmpdir,
        }
    }

    fn db_path(&self) -> PathBuf {
        self.tmpdir.path().join("memory/memories.db")
    }
}

#[tokio::test]
#[ignore = "requires built daemon binary"]
async fn replay_data_driven_fixtures() {
    let loaded = load_fixtures();
    assert!(
        !loaded.fixtures.is_empty(),
        "fixture manifest loaded no replay cases"
    );

    for fixture in &loaded.fixtures {
        run_fixture(fixture, loaded.base_dir.as_deref()).await;
    }
}

async fn run_fixture(fixture: &ReplayFixture, base_dir: Option<&Path>) {
    let server = TestServer::start(fixture).await;
    apply_seed_sql(fixture, base_dir, &server.db_path());

    let response = send_fixture_request(fixture, &server).await;
    let status = response.status().as_u16();
    let headers = response.headers().clone();
    let body = response
        .text()
        .await
        .unwrap_or_else(|err| panic!("fixture {} failed reading response body: {err}", fixture.id));

    assert_eq!(
        fixture.expected_response.status, status,
        "fixture {} response status mismatch; body: {body}",
        fixture.id
    );
    assert_response_headers(fixture, &headers);
    assert_response_json(fixture, &body);
    assert_db_state(fixture, &server.db_path());
}

async fn send_fixture_request(fixture: &ReplayFixture, server: &TestServer) -> reqwest::Response {
    let method = fixture
        .request
        .method
        .parse::<reqwest::Method>()
        .unwrap_or_else(|err| panic!("fixture {} invalid HTTP method: {err}", fixture.id));
    let mut request = server
        .client
        .request(method, format!("{}{}", server.base, fixture.request.path));
    for (key, value) in &fixture.request.headers {
        request = request.header(key, value);
    }
    if let Some(body) = &fixture.request.body {
        request = match body {
            Value::Null => request,
            Value::String(text) => request.body(text.clone()),
            _ => request.json(body),
        };
    }
    request
        .send()
        .await
        .unwrap_or_else(|err| panic!("fixture {} request failed: {err}", fixture.id))
}

fn assert_response_headers(fixture: &ReplayFixture, headers: &reqwest::header::HeaderMap) {
    for (name, expected) in &fixture.expected_response.headers {
        let actual = headers
            .get(name)
            .unwrap_or_else(|| panic!("fixture {} missing response header {name}", fixture.id))
            .to_str()
            .unwrap_or_else(|err| panic!("fixture {} invalid header {name}: {err}", fixture.id));
        match expected {
            ExpectedHeader::Exact(value) => assert_eq!(
                value, actual,
                "fixture {} response header {name} mismatch",
                fixture.id
            ),
            ExpectedHeader::Rule(rule) => {
                if let Some(value) = &rule.equals {
                    assert_eq!(
                        value, actual,
                        "fixture {} response header {name} equals mismatch",
                        fixture.id
                    );
                }
                if let Some(value) = &rule.contains {
                    assert!(
                        actual.contains(value),
                        "fixture {} response header {name} expected to contain {value:?}, actual {actual:?}",
                        fixture.id
                    );
                }
            }
        }
    }
}

fn assert_response_json(fixture: &ReplayFixture, body: &str) {
    let Some(expected_json) = &fixture.expected_response.json else {
        return;
    };
    let mut expected = expected_json.clone();
    let mut actual: Value = serde_json::from_str(body).unwrap_or_else(|err| {
        panic!(
            "fixture {} expected JSON response but body did not parse: {err}; body: {body}",
            fixture.id
        )
    });
    for ignore_path in &fixture.expected_response.ignore_json_paths {
        remove_json_path(&mut expected, ignore_path);
        remove_json_path(&mut actual, ignore_path);
    }
    assert_json_subset(
        &expected,
        &actual,
        "$",
        fixture.normalization.float_tolerance.unwrap_or(0.0),
        &fixture.id,
    );
}

fn assert_json_subset(
    expected: &Value,
    actual: &Value,
    path: &str,
    tolerance: f64,
    fixture_id: &str,
) {
    match (expected, actual) {
        (Value::Object(expected_map), Value::Object(actual_map)) => {
            for (key, expected_value) in expected_map {
                let child_path = format!("{path}.{key}");
                let actual_value = actual_map.get(key).unwrap_or_else(|| {
                    panic!("fixture {fixture_id} missing JSON field {child_path}; actual: {actual}")
                });
                assert_json_subset(
                    expected_value,
                    actual_value,
                    &child_path,
                    tolerance,
                    fixture_id,
                );
            }
        }
        (Value::Array(expected_items), Value::Array(actual_items)) => {
            assert!(
                actual_items.len() >= expected_items.len(),
                "fixture {fixture_id} JSON array {path} shorter than expected; expected at least {}, actual {}; actual: {actual}",
                expected_items.len(),
                actual_items.len()
            );
            for (index, expected_item) in expected_items.iter().enumerate() {
                assert_json_subset(
                    expected_item,
                    &actual_items[index],
                    &format!("{path}[{index}]"),
                    tolerance,
                    fixture_id,
                );
            }
        }
        _ => assert!(
            json_values_equal(expected, actual, tolerance),
            "fixture {fixture_id} JSON mismatch at {path}; expected {expected}, actual {actual}"
        ),
    }
}

fn assert_db_state(fixture: &ReplayFixture, db_path: &Path) {
    if fixture.expected_internal_state.db.is_empty() {
        return;
    }
    let conn = open_replay_db(db_path);
    let ignored_columns = fixture
        .normalization
        .ignore_columns
        .iter()
        .map(|column| column.to_ascii_lowercase())
        .collect::<BTreeSet<_>>();

    for expectation in &fixture.expected_internal_state.db {
        assert_valid_identifier(&expectation.table, "table", &fixture.id);
        if let Some(expected_count) = expectation.count {
            let actual_count = query_count(&conn, expectation, &fixture.id);
            assert_eq!(
                expected_count, actual_count,
                "fixture {} DB count mismatch for table {} where {:?}",
                fixture.id, expectation.table, expectation.where_clause
            );
        }
        if expectation.rows.is_some() {
            assert_db_rows(&conn, fixture, expectation, &ignored_columns);
        }
    }
}

fn assert_db_rows(
    conn: &rusqlite::Connection,
    fixture: &ReplayFixture,
    expectation: &DbExpectation,
    ignored_columns: &BTreeSet<String>,
) {
    assert!(
        !expectation.columns.is_empty(),
        "fixture {} DB row expectation for table {} must include columns",
        fixture.id,
        expectation.table
    );

    let kept_indices = expectation
        .columns
        .iter()
        .enumerate()
        .filter_map(|(index, column)| {
            assert_valid_identifier(column, "column", &fixture.id);
            (!ignored_columns.contains(&column.to_ascii_lowercase())).then_some(index)
        })
        .collect::<Vec<_>>();
    let selected_columns = kept_indices
        .iter()
        .map(|index| expectation.columns[*index].clone())
        .collect::<Vec<_>>();
    assert!(
        !selected_columns.is_empty(),
        "fixture {} DB row expectation for table {} only selected ignored columns",
        fixture.id,
        expectation.table
    );

    let mut expected_rows = expectation
        .rows
        .as_ref()
        .expect("rows already checked")
        .iter()
        .map(|row| {
            assert_eq!(
                expectation.columns.len(),
                row.len(),
                "fixture {} expected row width mismatch for table {}",
                fixture.id,
                expectation.table
            );
            kept_indices
                .iter()
                .map(|index| row[*index].clone())
                .collect::<Vec<_>>()
        })
        .collect::<Vec<_>>();
    let mut actual_rows = query_rows(conn, expectation, &selected_columns, fixture);

    let sort_indices = sort_indices(&selected_columns, fixture, expectation);
    if !sort_indices.is_empty() {
        sort_rows(&mut expected_rows, &sort_indices);
        sort_rows(&mut actual_rows, &sort_indices);
    }

    assert_eq!(
        expected_rows.len(),
        actual_rows.len(),
        "fixture {} DB row count mismatch for table {}; expected {expected_rows:?}, actual {actual_rows:?}",
        fixture.id,
        expectation.table
    );
    let tolerance = fixture.normalization.float_tolerance.unwrap_or(0.0);
    for (row_index, (expected_row, actual_row)) in
        expected_rows.iter().zip(actual_rows.iter()).enumerate()
    {
        assert_eq!(
            expected_row.len(),
            actual_row.len(),
            "fixture {} DB row width mismatch for table {} row {}",
            fixture.id,
            expectation.table,
            row_index
        );
        for (column_index, (expected_value, actual_value)) in
            expected_row.iter().zip(actual_row.iter()).enumerate()
        {
            assert!(
                json_values_equal(expected_value, actual_value, tolerance),
                "fixture {} DB mismatch for table {} row {} column {}; expected {expected_value}, actual {actual_value}; expected rows {expected_rows:?}, actual rows {actual_rows:?}",
                fixture.id,
                expectation.table,
                row_index,
                selected_columns[column_index]
            );
        }
    }
}

fn query_count(
    conn: &rusqlite::Connection,
    expectation: &DbExpectation,
    fixture_id: &str,
) -> usize {
    let sql = format!(
        "SELECT COUNT(*) FROM {}{}",
        quote_identifier(&expectation.table),
        where_sql(expectation)
    );
    conn.query_row(&sql, [], |row| row.get::<_, i64>(0))
        .unwrap_or_else(|err| panic!("fixture {fixture_id} failed DB count query {sql}: {err}"))
        .try_into()
        .unwrap_or_else(|err| panic!("fixture {fixture_id} negative DB count from {sql}: {err}"))
}

fn query_rows(
    conn: &rusqlite::Connection,
    expectation: &DbExpectation,
    columns: &[String],
    fixture: &ReplayFixture,
) -> Vec<Vec<Value>> {
    let column_sql = columns
        .iter()
        .map(|column| quote_identifier(column))
        .collect::<Vec<_>>()
        .join(", ");
    let sql = format!(
        "SELECT {column_sql} FROM {}{}{}",
        quote_identifier(&expectation.table),
        where_sql(expectation),
        order_sql(expectation, &fixture.normalization.sort_rows_by)
    );
    let mut statement = conn
        .prepare(&sql)
        .unwrap_or_else(|err| panic!("fixture {} failed DB row query {sql}: {err}", fixture.id));
    let rows = statement
        .query_map([], |row| {
            let mut values = Vec::with_capacity(columns.len());
            for index in 0..columns.len() {
                values.push(sql_value_to_json(row.get_ref(index)?));
            }
            Ok(values)
        })
        .unwrap_or_else(|err| panic!("fixture {} failed reading DB rows {sql}: {err}", fixture.id));

    rows.map(|row| {
        row.unwrap_or_else(|err| {
            panic!(
                "fixture {} failed converting DB row {sql}: {err}",
                fixture.id
            )
        })
    })
    .collect()
}

fn sort_indices(
    columns: &[String],
    fixture: &ReplayFixture,
    expectation: &DbExpectation,
) -> Vec<usize> {
    fixture
        .normalization
        .sort_rows_by
        .iter()
        .chain(expectation.order_by.iter())
        .filter_map(|column| columns.iter().position(|selected| selected == column))
        .collect()
}

fn sort_rows(rows: &mut [Vec<Value>], indices: &[usize]) {
    rows.sort_by(|left, right| {
        for index in indices {
            let ordering = value_sort_key(&left[*index]).cmp(&value_sort_key(&right[*index]));
            if !ordering.is_eq() {
                return ordering;
            }
        }
        std::cmp::Ordering::Equal
    });
}

fn value_sort_key(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::Bool(value) => value.to_string(),
        Value::Number(value) => value.to_string(),
        Value::String(value) => value.clone(),
        Value::Array(_) | Value::Object(_) => value.to_string(),
    }
}

fn sql_value_to_json(value: ValueRef<'_>) -> Value {
    match value {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(value) => Value::Number(Number::from(value)),
        ValueRef::Real(value) => Number::from_f64(value).map_or(Value::Null, Value::Number),
        ValueRef::Text(value) => Value::String(String::from_utf8_lossy(value).to_string()),
        ValueRef::Blob(value) => Value::Array(
            value
                .iter()
                .map(|byte| Value::Number(Number::from(*byte)))
                .collect(),
        ),
    }
}

fn json_values_equal(expected: &Value, actual: &Value, tolerance: f64) -> bool {
    match (expected, actual) {
        (Value::Number(left), Value::Number(right)) => numbers_equal(left, right, tolerance),
        _ => expected == actual,
    }
}

fn numbers_equal(expected: &Number, actual: &Number, tolerance: f64) -> bool {
    if expected == actual {
        return true;
    }
    let Some(expected) = expected.as_f64() else {
        return false;
    };
    let Some(actual) = actual.as_f64() else {
        return false;
    };
    (expected - actual).abs() <= tolerance
}

fn where_sql(expectation: &DbExpectation) -> String {
    expectation
        .where_clause
        .as_ref()
        .filter(|clause| !clause.trim().is_empty())
        .map(|clause| format!(" WHERE {clause}"))
        .unwrap_or_default()
}

fn order_sql(expectation: &DbExpectation, fixture_sort: &[String]) -> String {
    let order_columns = if expectation.order_by.is_empty() {
        fixture_sort
    } else {
        &expectation.order_by
    };
    if order_columns.is_empty() {
        return String::new();
    }
    for column in order_columns {
        assert_valid_identifier(column, "orderBy column", "fixture");
    }
    format!(
        " ORDER BY {}",
        order_columns
            .iter()
            .map(|column| quote_identifier(column))
            .collect::<Vec<_>>()
            .join(", ")
    )
}

fn quote_identifier(identifier: &str) -> String {
    format!("\"{}\"", identifier.replace('"', "\"\""))
}

fn assert_valid_identifier(identifier: &str, kind: &str, fixture_id: &str) {
    assert!(
        !identifier.is_empty()
            && identifier
                .chars()
                .all(|character| character == '_' || character.is_ascii_alphanumeric()),
        "fixture {fixture_id} invalid {kind} identifier {identifier:?}"
    );
}

fn apply_seed_sql(fixture: &ReplayFixture, base_dir: Option<&Path>, db_path: &Path) {
    let Some(seed_sql) = &fixture.seed.sql else {
        return;
    };
    let sql = read_seed_sql(seed_sql, base_dir)
        .unwrap_or_else(|err| panic!("fixture {} failed reading seed.sql: {err}", fixture.id));
    if sql.trim().is_empty() {
        return;
    }
    let conn = open_replay_db(db_path);
    conn.execute_batch(&sql)
        .unwrap_or_else(|err| panic!("fixture {} failed applying seed.sql: {err}", fixture.id));
}

fn read_seed_sql(seed_sql: &str, base_dir: Option<&Path>) -> std::io::Result<String> {
    let candidate = Path::new(seed_sql);
    if candidate.exists() {
        return std::fs::read_to_string(candidate);
    }
    if let Some(base_dir) = base_dir {
        let path = base_dir.join(seed_sql);
        if path.exists() {
            return std::fs::read_to_string(path);
        }
    }
    Ok(seed_sql.to_string())
}

fn open_replay_db(db_path: &Path) -> rusqlite::Connection {
    register_vec_extension();
    let conn = rusqlite::Connection::open(db_path).expect("open replay db");
    conn.busy_timeout(Duration::from_secs(5))
        .expect("set replay db busy timeout");
    conn
}

fn load_fixtures() -> LoadedFixtures {
    if let Some(path) = configured_manifest_path() {
        return load_manifest(&path);
    }
    let default_path = default_manifest_path();
    if default_path.exists() {
        return load_manifest(&default_path);
    }
    LoadedFixtures {
        fixtures: vec![inline_fixture()],
        base_dir: None,
    }
}

fn configured_manifest_path() -> Option<PathBuf> {
    std::env::var_os("SIGNET_REPLAY_FIXTURE_MANIFEST")
        .or_else(|| std::env::var_os("SIGNET_REPLAY_CORPUS_MANIFEST"))
        .map(PathBuf::from)
}

fn default_manifest_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../contracts/replay-corpus/manifest.json")
}

fn load_manifest(path: &Path) -> LoadedFixtures {
    let text = std::fs::read_to_string(path)
        .unwrap_or_else(|err| panic!("failed reading fixture manifest {}: {err}", path.display()));
    let value: Value = serde_json::from_str(&text)
        .unwrap_or_else(|err| panic!("failed parsing fixture manifest {}: {err}", path.display()));
    let base_dir = path.parent().map(Path::to_path_buf);
    let fixtures = fixture_values_from_manifest(&value, base_dir.as_deref())
        .into_iter()
        .map(|case_value| {
            serde_json::from_value(case_value).unwrap_or_else(|err| {
                panic!(
                    "failed parsing fixture case from manifest {}: {err}",
                    path.display()
                )
            })
        })
        .collect();
    LoadedFixtures { fixtures, base_dir }
}

fn fixture_values_from_manifest(value: &Value, base_dir: Option<&Path>) -> Vec<Value> {
    if let Some(items) = value.as_array() {
        return items
            .iter()
            .map(|item| fixture_value_from_manifest_item(item, base_dir))
            .collect();
    }
    let Some(object) = value.as_object() else {
        panic!("fixture manifest must be an object or array");
    };
    for key in ["fixtures", "cases"] {
        if let Some(items) = object.get(key).and_then(Value::as_array) {
            return items
                .iter()
                .map(|item| fixture_value_from_manifest_item(item, base_dir))
                .collect();
        }
    }
    vec![value.clone()]
}

fn fixture_value_from_manifest_item(item: &Value, base_dir: Option<&Path>) -> Value {
    if let Some(path) = item.as_str() {
        return read_fixture_case(path, base_dir);
    }
    if let Some(object) = item.as_object() {
        for key in ["path", "file"] {
            if let Some(path) = object.get(key).and_then(Value::as_str) {
                return read_fixture_case(path, base_dir);
            }
        }
    }
    item.clone()
}

fn read_fixture_case(path: &str, base_dir: Option<&Path>) -> Value {
    let path = base_dir.map_or_else(|| PathBuf::from(path), |base_dir| base_dir.join(path));
    let text = std::fs::read_to_string(&path)
        .unwrap_or_else(|err| panic!("failed reading fixture case {}: {err}", path.display()));
    serde_json::from_str(&text)
        .unwrap_or_else(|err| panic!("failed parsing fixture case {}: {err}", path.display()))
}

fn inline_fixture() -> ReplayFixture {
    ReplayFixture {
        id: "inline-health-db-snapshot".to_string(),
        environment: FixtureEnvironment::default(),
        seed: SeedSpec {
            sql: Some(
                r#"
                INSERT OR REPLACE INTO agents
                    (id, name, read_policy, policy_group, created_at, updated_at)
                VALUES
                    ('default', 'default', 'isolated', NULL,
                     '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
                INSERT INTO memories
                    (id, type, content, content_hash, confidence, importance, tags,
                     who, project, created_at, updated_at, updated_by, is_deleted,
                     pinned, version, agent_id, visibility, scope)
                VALUES
                    ('mem-inline-replay', 'fact',
                     'Inline replay fixture proves DB snapshot assertions.',
                     'inline-replay-hash', 1.0, 0.7, 'rust,parity',
                     'contract-replay', 'signet', '2026-01-01T00:00:00Z',
                     '2026-01-01T00:00:00Z', 'contract-replay', 0, 0, 1,
                     'default', 'global', NULL);
                "#
                .to_string(),
            ),
        },
        request: FixtureRequest {
            method: "GET".to_string(),
            path: "/health".to_string(),
            headers: BTreeMap::new(),
            body: None,
        },
        expected_response: ExpectedResponse {
            status: 200,
            headers: BTreeMap::from([(
                "content-type".to_string(),
                ExpectedHeader::Rule(HeaderRule {
                    contains: Some("application/json".to_string()),
                    equals: None,
                }),
            )]),
            json: Some(json!({ "status": "healthy" })),
            ignore_json_paths: vec!["$.version".to_string()],
        },
        expected_internal_state: ExpectedInternalState {
            db: vec![DbExpectation {
                table: "memories".to_string(),
                where_clause: Some("id = 'mem-inline-replay'".to_string()),
                columns: vec![
                    "id".to_string(),
                    "agent_id".to_string(),
                    "visibility".to_string(),
                    "scope".to_string(),
                    "is_deleted".to_string(),
                ],
                rows: Some(vec![vec![
                    json!("mem-inline-replay"),
                    json!("default"),
                    json!("global"),
                    Value::Null,
                    json!(0),
                ]]),
                count: Some(1),
                order_by: vec!["id".to_string()],
            }],
        },
        normalization: Normalization {
            ignore_columns: vec!["created_at".to_string(), "updated_at".to_string()],
            sort_rows_by: vec!["id".to_string()],
            float_tolerance: Some(0.000001),
        },
    }
}

#[derive(Debug)]
enum JsonPathToken {
    Key(String),
    Index(usize),
    Wildcard,
}

fn remove_json_path(value: &mut Value, path: &str) {
    let tokens = parse_json_path(path)
        .unwrap_or_else(|err| panic!("invalid ignoreJsonPaths entry {path:?}: {err}"));
    remove_json_path_tokens(value, &tokens);
}

fn remove_json_path_tokens(value: &mut Value, tokens: &[JsonPathToken]) {
    let Some((first, rest)) = tokens.split_first() else {
        *value = Value::Null;
        return;
    };
    match (first, value) {
        (JsonPathToken::Key(key), Value::Object(object)) if rest.is_empty() => {
            object.remove(key);
        }
        (JsonPathToken::Key(key), Value::Object(object)) => {
            if let Some(child) = object.get_mut(key) {
                remove_json_path_tokens(child, rest);
            }
        }
        (JsonPathToken::Index(index), Value::Array(items)) => {
            if let Some(child) = items.get_mut(*index) {
                remove_json_path_tokens(child, rest);
            }
        }
        (JsonPathToken::Wildcard, Value::Array(items)) => {
            for child in items {
                remove_json_path_tokens(child, rest);
            }
        }
        _ => {}
    }
}

fn parse_json_path(path: &str) -> Result<Vec<JsonPathToken>, String> {
    let mut chars = path.chars().peekable();
    if chars.next() != Some('$') {
        return Err("path must start with $".to_string());
    }
    let mut tokens = Vec::new();
    while let Some(character) = chars.next() {
        match character {
            '.' => {
                let mut key = String::new();
                while let Some(next) = chars.peek() {
                    if *next == '.' || *next == '[' {
                        break;
                    }
                    key.push(*next);
                    chars.next();
                }
                if key.is_empty() {
                    return Err("empty object key".to_string());
                }
                tokens.push(JsonPathToken::Key(key));
            }
            '[' => {
                let mut segment = String::new();
                loop {
                    let Some(next) = chars.next() else {
                        return Err("unterminated array segment".to_string());
                    };
                    if next == ']' {
                        break;
                    }
                    segment.push(next);
                }
                if segment == "*" {
                    tokens.push(JsonPathToken::Wildcard);
                } else {
                    let index = segment
                        .parse::<usize>()
                        .map_err(|err| format!("invalid array index {segment:?}: {err}"))?;
                    tokens.push(JsonPathToken::Index(index));
                }
            }
            _ => return Err(format!("unexpected character {character:?}")),
        }
    }
    Ok(tokens)
}

fn ephemeral_port() -> u16 {
    TcpListener::bind("127.0.0.1:0")
        .expect("bind ephemeral port")
        .local_addr()
        .expect("read ephemeral port")
        .port()
}

fn test_server_start_lock() -> &'static tokio::sync::Mutex<()> {
    TEST_SERVER_START_LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
}

fn write_fake_provider_bins(root: &Path) -> (PathBuf, PathBuf, PathBuf) {
    let bin_dir = root.join("fake-bin");
    std::fs::create_dir_all(&bin_dir).expect("create fake provider bin dir");
    let bw = bin_dir.join(if cfg!(windows) { "bw.cmd" } else { "bw" });
    let op = bin_dir.join(if cfg!(windows) { "op.cmd" } else { "op" });
    let signet = bin_dir.join(if cfg!(windows) {
        "signet.cmd"
    } else {
        "signet"
    });

    write_fake_executable(
        &bw,
        r#"#!/bin/sh
set -eu
case "${1-} ${2-}" in
  "status ") printf '{"status":"unlocked"}' ;;
  "list folders") printf '[]' ;;
  "list items") printf '[]' ;;
  *) echo "unsupported fake bw command: $*" >&2; exit 2 ;;
esac
"#,
    );
    write_fake_executable(
        &op,
        r#"#!/bin/sh
set -eu
case "${1-} ${2-} ${3-} ${4-}" in
  "vault list --format json") printf '[]' ;;
  "item list --vault ") printf '[]' ;;
  *) echo "unsupported fake op command: $*" >&2; exit 2 ;;
esac
"#,
    );
    write_fake_executable(
        &signet,
        r#"#!/bin/sh
set -eu
echo "fake signet $*"
"#,
    );
    (bw, op, bin_dir)
}

fn write_fake_executable(path: &Path, content: &str) {
    std::fs::write(path, content)
        .unwrap_or_else(|err| panic!("failed writing fake executable {}: {err}", path.display()));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755))
            .unwrap_or_else(|err| panic!("failed chmod fake executable {}: {err}", path.display()));
    }
}

fn daemon_binary() -> String {
    if let Ok(path) = std::env::var("CARGO_BIN_EXE_signet-daemon") {
        if Path::new(&path).exists() {
            return path;
        }
    }
    if let Ok(target_dir) = std::env::var("CARGO_TARGET_DIR") {
        let path = PathBuf::from(target_dir).join("debug/signet-daemon");
        if path.exists() {
            return path.to_string_lossy().to_string();
        }
    }
    for candidate in ["target/debug/signet-daemon", "target/release/signet-daemon"] {
        let path = Path::new(candidate);
        if path.exists() {
            return path.to_string_lossy().to_string();
        }
    }
    if let Ok(manifest_dir) = std::env::var("CARGO_MANIFEST_DIR") {
        let path = PathBuf::from(manifest_dir).join("../../target/debug/signet-daemon");
        if path.exists() {
            return path.to_string_lossy().to_string();
        }
    }
    "signet-daemon".to_string()
}

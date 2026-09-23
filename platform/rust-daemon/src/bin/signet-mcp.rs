use reqwest::header::{HeaderMap, HeaderName, HeaderValue, AUTHORIZATION, CONTENT_TYPE};
use serde_json::{json, Value};
use std::{env, io::Write, time::Duration};
use tokio::io::{AsyncBufReadExt, BufReader};

const MAX_LINE: usize = 256 * 1024;
const MAX_RESPONSE: usize = 1024 * 1024;

fn bridge_url() -> String {
    env::var("SIGNET_DAEMON_URL")
        .or_else(|_| env::var("SIGNET_MCP_BRIDGE_URL"))
        .and_then(|value| {
            if value.trim().is_empty() {
                Err(env::VarError::NotPresent)
            } else {
                Ok(value)
            }
        })
        .unwrap_or_else(|_| {
            let host = env::var("SIGNET_HOST").unwrap_or_else(|_| "127.0.0.1".into());
            let port = env::var("SIGNET_PORT").unwrap_or_else(|_| "3850".into());
            format!("http://{host}:{port}")
        })
}

fn error(id: Option<Value>, code: i64, message: impl Into<String>) -> Value {
    json!({"jsonrpc":"2.0", "id":id, "error":{"code":code,"message":message.into()}})
}

fn headers() -> Result<HeaderMap, String> {
    let mut out = HeaderMap::new();
    out.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    for (env_name, header_name) in [
        ("SIGNET_DREAMING_AGENT_ID", "x-signet-agent-id"),
        ("SIGNET_WORKSPACE", "x-signet-workspace"),
        ("SIGNET_HARNESS", "x-signet-harness"),
        ("SIGNET_CHANNEL", "x-signet-channel"),
    ] {
        if let Ok(value) = env::var(env_name).or_else(|_| {
            (env_name == "SIGNET_DREAMING_AGENT_ID")
                .then(|| env::var("SIGNET_AGENT_ID"))
                .unwrap_or(Err(env::VarError::NotPresent))
        }) {
            if !value.trim().is_empty() {
                out.insert(
                    HeaderName::from_static(header_name),
                    HeaderValue::from_str(&value).map_err(|_| format!("invalid {env_name}"))?,
                );
            }
        }
    }
    if let Ok(value) = env::var("SIGNET_API_KEY").or_else(|_| env::var("SIGNET_TOKEN")) {
        if !value.trim().is_empty() {
            out.insert(
                AUTHORIZATION,
                HeaderValue::from_str(&format!("Bearer {value}"))
                    .map_err(|_| "invalid auth token".to_owned())?,
            );
        }
    }
    Ok(out)
}

async fn forward(client: &reqwest::Client, request: &Value) -> Value {
    let id = request.get("id").cloned();
    let Ok(headers) = headers() else {
        return error(id, -32001, "invalid transport header");
    };
    let response = client
        .post(format!("{}/api/mcp", bridge_url().trim_end_matches('/')))
        .headers(headers)
        .json(request)
        .send()
        .await;
    let response = match response {
        Ok(value) => value,
        Err(_) => return error(id, -32002, "MCP bridge unavailable or timed out"),
    };
    if response
        .content_length()
        .is_some_and(|n| n as usize > MAX_RESPONSE)
    {
        return error(id, -32003, "MCP bridge response too large");
    }
    let bytes = match response.bytes().await {
        Ok(value) if value.len() <= MAX_RESPONSE => value,
        _ => return error(id, -32003, "MCP bridge response too large or invalid"),
    };
    serde_json::from_slice(&bytes)
        .unwrap_or_else(|_| error(id, -32004, "MCP bridge returned invalid JSON-RPC"))
}

#[tokio::main]
async fn main() {
    let client = match reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
    {
        Ok(value) => value,
        Err(error) => {
            eprintln!("signet-mcp: failed to initialize transport: {error}");
            std::process::exit(1);
        }
    };
    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    let stdout = std::io::stdout();
    let mut stdout = stdout.lock();
    while let Ok(Some(line)) = lines.next_line().await {
        let reply = if line.len() > MAX_LINE {
            error(None, -32600, "request exceeds 256 KiB")
        } else {
            match serde_json::from_str::<Value>(&line) {
                Ok(request)
                    if request.get("jsonrpc").and_then(Value::as_str) == Some("2.0")
                        && request.get("method").and_then(Value::as_str).is_some() =>
                {
                    forward(&client, &request).await
                }
                Ok(request) => error(request.get("id").cloned(), -32600, "Invalid Request"),
                Err(_) => error(None, -32700, "Parse error"),
            }
        };
        let encoded = match serde_json::to_vec(&reply) {
            Ok(value) if value.len() <= MAX_RESPONSE => value,
            _ => {
                eprintln!("signet-mcp: response exceeded limit");
                break;
            }
        };
        if stdout
            .write_all(&encoded)
            .and_then(|_| stdout.write_all(b"\n"))
            .and_then(|_| stdout.flush())
            .is_err()
        {
            break;
        }
    }
}

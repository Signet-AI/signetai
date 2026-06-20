//! Token creation and verification using HMAC-SHA256.
//!
//! Token format: `{base64url(payload)}.{base64url(hmac)}`.
//! Compatible with the TS daemon's custom token format.

use std::fs;
use std::path::Path;

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use hmac::{Hmac, Mac};
use sha2::Sha256;

use super::types::{AuthResult, TokenClaims, TokenRole, TokenScope};

type HmacSha256 = Hmac<Sha256>;

// ---------------------------------------------------------------------------
// Secret management
// ---------------------------------------------------------------------------

pub fn generate_secret() -> Vec<u8> {
    use std::time::{SystemTime, UNIX_EPOCH};
    // Use getrandom for cryptographic randomness
    let mut buf = [0u8; 32];
    getrandom::fill(&mut buf).expect("failed to generate random bytes");
    // Mix in timestamp for extra entropy (belt-and-suspenders)
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .subsec_nanos();
    buf[0] ^= (nanos & 0xFF) as u8;
    buf.to_vec()
}

pub fn load_or_create_secret(path: &Path) -> std::io::Result<Vec<u8>> {
    if path.exists() {
        return fs::read(path);
    }

    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }

    let secret = generate_secret();

    // Write with restricted permissions
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        let mut opts = fs::OpenOptions::new();
        opts.write(true).create_new(true).mode(0o600);
        use std::io::Write;
        let mut f = opts.open(path)?;
        f.write_all(&secret)?;
    }
    #[cfg(not(unix))]
    {
        fs::write(path, &secret)?;
    }

    Ok(secret)
}

// ---------------------------------------------------------------------------
// Signing
// ---------------------------------------------------------------------------

fn sign(secret: &[u8], payload: &str) -> Vec<u8> {
    let mut mac = HmacSha256::new_from_slice(secret).expect("HMAC accepts any key length");
    mac.update(payload.as_bytes());
    mac.finalize().into_bytes().to_vec()
}

// ---------------------------------------------------------------------------
// Token creation
// ---------------------------------------------------------------------------

pub fn create_token(
    secret: &[u8],
    sub: &str,
    scope: TokenScope,
    role: TokenRole,
    ttl_seconds: i64,
) -> String {
    let now = chrono::Utc::now().timestamp();
    let claims = TokenClaims {
        sub: sub.to_string(),
        scope,
        role,
        iat: now,
        exp: now + ttl_seconds,
        permissions: None,
    };
    let payload = serde_json::to_string(&claims).expect("claims are always serializable");
    let payload_b64 = URL_SAFE_NO_PAD.encode(payload.as_bytes());
    let signature = sign(secret, &payload_b64);
    let sig_b64 = URL_SAFE_NO_PAD.encode(&signature);
    format!("{payload_b64}.{sig_b64}")
}

// ---------------------------------------------------------------------------
// Token verification
// ---------------------------------------------------------------------------

pub fn verify_token(secret: &[u8], token: &str) -> AuthResult {
    let Some(dot) = token.find('.') else {
        return AuthResult {
            authenticated: false,
            claims: None,
            error: Some("malformed token".into()),
        };
    };

    if dot == token.len() - 1 {
        return AuthResult {
            authenticated: false,
            claims: None,
            error: Some("malformed token".into()),
        };
    }

    let payload_b64 = &token[..dot];
    let sig_b64 = &token[dot + 1..];

    let expected = sign(secret, payload_b64);
    let actual = match URL_SAFE_NO_PAD.decode(sig_b64) {
        Ok(v) => v,
        Err(_) => {
            return AuthResult {
                authenticated: false,
                claims: None,
                error: Some("invalid signature encoding".into()),
            };
        }
    };

    // Constant-time comparison
    if expected.len() != actual.len() || !constant_time_eq(&expected, &actual) {
        return AuthResult {
            authenticated: false,
            claims: None,
            error: Some("invalid signature".into()),
        };
    }

    let payload_bytes = match URL_SAFE_NO_PAD.decode(payload_b64) {
        Ok(v) => v,
        Err(_) => {
            return AuthResult {
                authenticated: false,
                claims: None,
                error: Some("malformed payload".into()),
            };
        }
    };

    let claims: TokenClaims = match serde_json::from_slice(&payload_bytes) {
        Ok(c) => c,
        Err(_) => {
            return AuthResult {
                authenticated: false,
                claims: None,
                error: Some("malformed payload".into()),
            };
        }
    };

    let now = chrono::Utc::now().timestamp();
    if now >= claims.exp {
        return AuthResult {
            authenticated: false,
            claims: None,
            error: Some("token expired".into()),
        };
    }

    AuthResult {
        authenticated: true,
        claims: Some(claims),
        error: None,
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip() {
        let secret = generate_secret();
        let token = create_token(
            &secret,
            "test-user",
            TokenScope::default(),
            TokenRole::Admin,
            3600,
        );
        let result = verify_token(&secret, &token);
        assert!(result.authenticated);
        let claims = result.claims.unwrap();
        assert_eq!(claims.sub, "test-user");
        assert!(matches!(claims.role, TokenRole::Admin));
    }

    #[test]
    fn expired_token() {
        let secret = generate_secret();
        let token = create_token(
            &secret,
            "test",
            TokenScope::default(),
            TokenRole::Agent,
            -1, // Already expired
        );
        let result = verify_token(&secret, &token);
        assert!(!result.authenticated);
        assert_eq!(result.error.as_deref(), Some("token expired"));
    }

    #[test]
    fn wrong_secret() {
        let secret1 = generate_secret();
        let secret2 = generate_secret();
        let token = create_token(
            &secret1,
            "test",
            TokenScope::default(),
            TokenRole::Agent,
            3600,
        );
        let result = verify_token(&secret2, &token);
        assert!(!result.authenticated);
        assert_eq!(result.error.as_deref(), Some("invalid signature"));
    }

    #[test]
    fn malformed_token() {
        let secret = generate_secret();
        assert!(!verify_token(&secret, "no-dot-here").authenticated);
        assert!(!verify_token(&secret, "trailing.").authenticated);
        assert!(!verify_token(&secret, "").authenticated);
    }
}

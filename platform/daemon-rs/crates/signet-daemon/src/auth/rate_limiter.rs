//! In-memory sliding window rate limiter for destructive operations.
//! Resets on daemon restart — acceptable for v1.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use super::types::RateLimitCheck;

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct RateLimitRule {
    pub window_ms: u64,
    pub max: u64,
}

pub fn default_limits() -> HashMap<String, RateLimitRule> {
    let mut m = HashMap::new();
    m.insert(
        "forget".into(),
        RateLimitRule {
            window_ms: 60_000,
            max: 30,
        },
    );
    m.insert(
        "modify".into(),
        RateLimitRule {
            window_ms: 60_000,
            max: 60,
        },
    );
    m.insert(
        "batchForget".into(),
        RateLimitRule {
            window_ms: 60_000,
            max: 5,
        },
    );
    m.insert(
        "forceDelete".into(),
        RateLimitRule {
            window_ms: 60_000,
            max: 3,
        },
    );
    m.insert(
        "admin".into(),
        RateLimitRule {
            window_ms: 60_000,
            max: 10,
        },
    );
    // LLM-enabled recall (useExtractionModel: true) — separate bucket so
    // operators can tune the cost-sensitive path independently of plain recall.
    m.insert(
        "recallLlm".into(),
        RateLimitRule {
            window_ms: 60_000,
            max: 60,
        },
    );
    m
}

// ---------------------------------------------------------------------------
// Limiter
// ---------------------------------------------------------------------------

struct WindowEntry {
    count: u64,
    window_start: u64,
}

#[derive(Clone)]
pub struct RateLimiter {
    window_ms: u64,
    max: u64,
    windows: Arc<Mutex<HashMap<String, WindowEntry>>>,
}

impl RateLimiter {
    pub fn new(window_ms: u64, max: u64) -> Self {
        Self {
            window_ms,
            max,
            windows: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    fn now_ms() -> u64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64
    }

    pub fn check(&self, key: &str) -> RateLimitCheck {
        let now = Self::now_ms();
        let windows = self.windows.lock().unwrap();
        let entry = windows.get(key);

        match entry {
            None => RateLimitCheck {
                allowed: true,
                remaining: self.max,
                reset_at: now + self.window_ms,
            },
            Some(e) if now - e.window_start >= self.window_ms => RateLimitCheck {
                allowed: true,
                remaining: self.max,
                reset_at: now + self.window_ms,
            },
            Some(e) => {
                let remaining = self.max.saturating_sub(e.count);
                RateLimitCheck {
                    allowed: remaining > 0,
                    remaining,
                    reset_at: e.window_start + self.window_ms,
                }
            }
        }
    }

    pub fn record(&self, key: &str) {
        let now = Self::now_ms();
        let mut windows = self.windows.lock().unwrap();
        let entry = windows.get_mut(key);

        match entry {
            None => {
                windows.insert(
                    key.to_string(),
                    WindowEntry {
                        count: 1,
                        window_start: now,
                    },
                );
            }
            Some(e) if now - e.window_start >= self.window_ms => {
                e.count = 1;
                e.window_start = now;
            }
            Some(e) => {
                e.count += 1;
            }
        }
    }

    pub fn check_and_record(&self, key: &str) -> RateLimitCheck {
        let result = self.check(key);
        if result.allowed {
            self.record(key);
        }
        result
    }
}

// ---------------------------------------------------------------------------
// Multi-operation limiter
// ---------------------------------------------------------------------------

#[derive(Clone)]
pub struct AuthRateLimiter {
    limiters: HashMap<String, RateLimiter>,
}

impl AuthRateLimiter {
    pub fn from_rules(rules: &HashMap<String, RateLimitRule>) -> Self {
        let limiters = rules
            .iter()
            .map(|(k, r)| (k.clone(), RateLimiter::new(r.window_ms, r.max)))
            .collect();
        Self { limiters }
    }

    pub fn check(&self, operation: &str, actor: &str) -> RateLimitCheck {
        let Some(limiter) = self.limiters.get(operation) else {
            // No rule = no limit
            return RateLimitCheck {
                allowed: true,
                remaining: u64::MAX,
                reset_at: 0,
            };
        };
        let key = format!("{actor}:{operation}");
        limiter.check(&key)
    }

    pub fn record(&self, operation: &str, actor: &str) {
        if let Some(limiter) = self.limiters.get(operation) {
            let key = format!("{actor}:{operation}");
            limiter.record(&key);
        }
    }

    pub fn check_and_record(&self, operation: &str, actor: &str) -> RateLimitCheck {
        let Some(limiter) = self.limiters.get(operation) else {
            return RateLimitCheck {
                allowed: true,
                remaining: u64::MAX,
                reset_at: 0,
            };
        };
        let key = format!("{actor}:{operation}");
        limiter.check_and_record(&key)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn basic_rate_limit() {
        let limiter = RateLimiter::new(60_000, 3);
        for _ in 0..3 {
            let check = limiter.check_and_record("user:op");
            assert!(check.allowed);
        }
        let check = limiter.check("user:op");
        assert!(!check.allowed);
        assert_eq!(check.remaining, 0);
    }

    #[test]
    fn multi_op_limiter() {
        let mut rules = HashMap::new();
        rules.insert(
            "forget".into(),
            RateLimitRule {
                window_ms: 60_000,
                max: 2,
            },
        );

        let limiter = AuthRateLimiter::from_rules(&rules);

        assert!(limiter.check_and_record("forget", "alice").allowed);
        assert!(limiter.check_and_record("forget", "alice").allowed);
        assert!(!limiter.check_and_record("forget", "alice").allowed);

        // Different actor is independent
        assert!(limiter.check("forget", "bob").allowed);

        // Unknown operation is unlimited
        assert!(limiter.check("unknown", "alice").allowed);
    }
}

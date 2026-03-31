use forge_core::{ErrorCategory, ForgeError};
use std::time::Duration;
use tracing::{info, warn};

/// Retry configuration for provider calls
pub struct RetryPolicy {
    /// Max retries for transient errors (5xx, timeouts)
    pub transient_retries: usize,
    /// Max retries for rate limit errors (429)
    pub rate_limit_retries: usize,
    /// Max retries for context overflow (compact + retry)
    pub overflow_retries: usize,
    /// Base delay for transient backoff (doubles each retry)
    pub transient_base: Duration,
    /// Base delay for rate limit backoff (doubles each retry)
    pub rate_limit_base: Duration,
}

impl Default for RetryPolicy {
    fn default() -> Self {
        Self {
            transient_retries: 3,
            rate_limit_retries: 3,
            overflow_retries: 1,
            transient_base: Duration::from_secs(2),
            rate_limit_base: Duration::from_secs(5),
        }
    }
}

/// Tracks retry state across attempts for a single provider call
pub struct RetryState {
    policy: RetryPolicy,
    transient_count: usize,
    rate_limit_count: usize,
    overflow_count: usize,
}

/// What the caller should do after a failed provider call
pub enum RetryDecision {
    /// Wait the given duration, then retry the call
    Retry(Duration),
    /// Compact context, then retry the call
    CompactAndRetry,
    /// Do not retry — propagate the error
    Fail,
}

impl RetryState {
    pub fn new() -> Self {
        Self::with_policy(RetryPolicy::default())
    }

    pub fn with_policy(policy: RetryPolicy) -> Self {
        Self {
            policy,
            transient_count: 0,
            rate_limit_count: 0,
            overflow_count: 0,
        }
    }

    /// Decide whether to retry a failed provider call.
    /// Returns the appropriate action based on error category and retry counts.
    pub fn decide(&mut self, err: &ForgeError) -> RetryDecision {
        let category = err.category();

        match category {
            ErrorCategory::Transient => {
                self.transient_count += 1;
                if self.transient_count > self.policy.transient_retries {
                    warn!(
                        "Transient error after {} retries, giving up: {err}",
                        self.policy.transient_retries
                    );
                    return RetryDecision::Fail;
                }
                let delay = self.policy.transient_base * 2u32.saturating_pow(
                    (self.transient_count - 1).min(5) as u32,
                );
                info!(
                    "Transient error (attempt {}/{}), retrying in {:?}: {err}",
                    self.transient_count, self.policy.transient_retries, delay
                );
                RetryDecision::Retry(delay)
            }
            ErrorCategory::RateLimit => {
                self.rate_limit_count += 1;
                if self.rate_limit_count > self.policy.rate_limit_retries {
                    warn!(
                        "Rate limit after {} retries, giving up: {err}",
                        self.policy.rate_limit_retries
                    );
                    return RetryDecision::Fail;
                }
                let delay = self.policy.rate_limit_base * 2u32.saturating_pow(
                    (self.rate_limit_count - 1).min(5) as u32,
                );
                info!(
                    "Rate limited (attempt {}/{}), retrying in {:?}",
                    self.rate_limit_count, self.policy.rate_limit_retries, delay
                );
                RetryDecision::Retry(delay)
            }
            ErrorCategory::ContextOverflow => {
                self.overflow_count += 1;
                if self.overflow_count > self.policy.overflow_retries {
                    warn!("Context overflow after compaction, giving up");
                    return RetryDecision::Fail;
                }
                info!("Context overflow — compacting and retrying");
                RetryDecision::CompactAndRetry
            }
            ErrorCategory::Client | ErrorCategory::Fatal => {
                RetryDecision::Fail
            }
        }
    }
}

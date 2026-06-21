//! Source indexing progress state ported from `platform/daemon/src/source-index-progress.ts`.

use chrono::{SecondsFormat, Utc};
use std::collections::{HashMap, HashSet};
use std::sync::{Mutex, OnceLock};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SourceIndexJobStatus {
    Queued,
    Running,
    Complete,
    Error,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SourceIndexJob {
    pub id: String,
    pub source_id: String,
    pub status: SourceIndexJobStatus,
    pub queued_at: String,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
    pub scanned: Option<u64>,
    pub total: Option<u64>,
    pub indexed: Option<u64>,
    pub current_path: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SourceIndexProgressEvent {
    pub scanned: u64,
    pub total: u64,
    pub indexed: u64,
    pub current_path: String,
}

#[derive(Debug, Default)]
struct SourceIndexProgressState {
    jobs: HashMap<String, SourceIndexJob>,
    in_flight: HashSet<String>,
    canceled_jobs: HashSet<String>,
}

static SOURCE_INDEX_PROGRESS: OnceLock<Mutex<SourceIndexProgressState>> = OnceLock::new();

fn state() -> &'static Mutex<SourceIndexProgressState> {
    SOURCE_INDEX_PROGRESS.get_or_init(|| Mutex::new(SourceIndexProgressState::default()))
}

pub fn get_source_index_job(source_id: &str) -> Option<SourceIndexJob> {
    state()
        .lock()
        .expect("source index progress lock poisoned")
        .jobs
        .get(source_id)
        .cloned()
}

pub fn begin_source_index_job(source_id: impl Into<String>) -> SourceIndexJob {
    begin_source_index_job_with_prefix(source_id, "source-index")
}

pub fn begin_source_index_job_with_prefix(
    source_id: impl Into<String>,
    prefix: impl AsRef<str>,
) -> SourceIndexJob {
    let source_id = source_id.into();
    let mut guard = state().lock().expect("source index progress lock poisoned");
    if let Some(existing) = guard.jobs.get(&source_id) {
        if matches!(
            existing.status,
            SourceIndexJobStatus::Queued | SourceIndexJobStatus::Running
        ) {
            return existing.clone();
        }
    }

    let job = SourceIndexJob {
        id: format!(
            "{}:{}:{}",
            prefix.as_ref(),
            source_id,
            Utc::now().timestamp_millis()
        ),
        source_id: source_id.clone(),
        status: SourceIndexJobStatus::Queued,
        queued_at: iso_now(),
        started_at: None,
        finished_at: None,
        scanned: None,
        total: None,
        indexed: None,
        current_path: None,
        error: None,
    };
    guard.jobs.insert(source_id, job.clone());
    job
}

pub fn mark_source_index_job_running(source_id: &str, job_id: &str) -> Option<SourceIndexJob> {
    let mut guard = state().lock().expect("source index progress lock poisoned");
    let current = guard.jobs.get(source_id)?;
    if current.id != job_id
        || !matches!(
            current.status,
            SourceIndexJobStatus::Queued | SourceIndexJobStatus::Running
        )
    {
        return None;
    }

    let mut running = current.clone();
    running.status = SourceIndexJobStatus::Running;
    if running.started_at.is_none() {
        running.started_at = Some(iso_now());
    }
    guard.jobs.insert(source_id.to_owned(), running.clone());
    Some(running)
}

pub fn update_source_index_job_progress(
    source_id: &str,
    job_id: &str,
    event: SourceIndexProgressEvent,
) {
    let mut guard = state().lock().expect("source index progress lock poisoned");
    let Some(current) = guard.jobs.get(source_id) else {
        return;
    };
    if current.id != job_id
        || matches!(
            current.status,
            SourceIndexJobStatus::Complete | SourceIndexJobStatus::Error
        )
    {
        return;
    }

    let mut running = current.clone();
    running.status = SourceIndexJobStatus::Running;
    if running.started_at.is_none() {
        running.started_at = Some(iso_now());
    }
    running.scanned = Some(event.scanned);
    running.total = Some(event.total);
    running.indexed = Some(event.indexed);
    running.current_path = Some(event.current_path);
    guard.jobs.insert(source_id.to_owned(), running);
}

pub fn complete_source_index_job(source_id: &str, job_id: &str, indexed: u64) {
    let mut guard = state().lock().expect("source index progress lock poisoned");
    let Some(current) = guard.jobs.get(source_id) else {
        return;
    };
    if current.id != job_id {
        return;
    }

    let mut complete = current.clone();
    complete.status = SourceIndexJobStatus::Complete;
    complete.finished_at = Some(iso_now());
    complete.indexed = Some(indexed);
    guard.jobs.insert(source_id.to_owned(), complete);
}

pub fn complete_source_index_job_from_progress(source_id: &str, job_id: &str) {
    let indexed = get_source_index_job(source_id)
        .and_then(|job| job.indexed)
        .unwrap_or(0);
    complete_source_index_job(source_id, job_id, indexed);
}

pub fn fail_source_index_job(source_id: &str, job_id: &str, error: impl ToString) {
    let mut guard = state().lock().expect("source index progress lock poisoned");
    let Some(current) = guard.jobs.get(source_id) else {
        return;
    };
    if current.id != job_id {
        return;
    }

    let mut failed = current.clone();
    failed.status = SourceIndexJobStatus::Error;
    failed.finished_at = Some(iso_now());
    failed.error = Some(error.to_string());
    guard.jobs.insert(source_id.to_owned(), failed);
}

pub fn is_current_source_index_job(source_id: &str, job_id: &str) -> bool {
    get_source_index_job(source_id).is_some_and(|job| job.id == job_id)
}

pub fn is_source_index_in_flight(source_id: &str) -> bool {
    state()
        .lock()
        .expect("source index progress lock poisoned")
        .in_flight
        .contains(source_id)
}

pub fn mark_source_index_in_flight(source_id: impl Into<String>) {
    state()
        .lock()
        .expect("source index progress lock poisoned")
        .in_flight
        .insert(source_id.into());
}

pub fn clear_source_index_in_flight(source_id: &str) {
    state()
        .lock()
        .expect("source index progress lock poisoned")
        .in_flight
        .remove(source_id);
}

pub fn cancel_source_index_job(source_id: &str) {
    let mut guard = state().lock().expect("source index progress lock poisoned");
    if let Some(job) = guard.jobs.get(source_id) {
        if matches!(
            job.status,
            SourceIndexJobStatus::Queued | SourceIndexJobStatus::Running
        ) {
            let job_id = job.id.clone();
            guard.canceled_jobs.insert(job_id);
        }
    }
    guard.jobs.remove(source_id);
}

pub fn consume_canceled_source_index_job(job_id: &str) -> bool {
    state()
        .lock()
        .expect("source index progress lock poisoned")
        .canceled_jobs
        .remove(job_id)
}

pub fn clear_source_index_progress_for_tests() {
    let mut guard = state().lock().expect("source index progress lock poisoned");
    guard.jobs.clear();
    guard.in_flight.clear();
    guard.canceled_jobs.clear();
}

fn iso_now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

#[cfg(test)]
mod tests {
    use super::*;

    static TEST_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

    fn test_lock() -> std::sync::MutexGuard<'static, ()> {
        TEST_LOCK
            .get_or_init(|| Mutex::new(()))
            .lock()
            .expect("source index progress test lock poisoned")
    }

    #[test]
    fn duplicate_delayed_runner_does_not_reopen_completed_job() {
        let _guard = test_lock();
        // Covers platform/daemon/src/source-index-progress.test.ts:10-19.
        clear_source_index_progress_for_tests();
        let job = begin_source_index_job("source-1");
        assert_eq!(
            mark_source_index_job_running("source-1", &job.id).map(|job| job.status),
            Some(SourceIndexJobStatus::Running)
        );
        complete_source_index_job("source-1", &job.id, 3);

        assert!(mark_source_index_job_running("source-1", &job.id).is_none());
        assert_eq!(
            get_source_index_job("source-1").map(|job| job.status),
            Some(SourceIndexJobStatus::Complete)
        );
        clear_source_index_progress_for_tests();
    }

    #[test]
    fn tracks_progress_cancelation_and_in_flight_state_like_ts_module() {
        let _guard = test_lock();
        clear_source_index_progress_for_tests();
        let job = begin_source_index_job_with_prefix("source-2", "test-prefix");
        assert!(job.id.starts_with("test-prefix:source-2:"));
        update_source_index_job_progress(
            "source-2",
            &job.id,
            SourceIndexProgressEvent {
                scanned: 2,
                total: 5,
                indexed: 1,
                current_path: "docs/one.md".to_owned(),
            },
        );
        let running = get_source_index_job("source-2").expect("job exists");
        assert_eq!(running.status, SourceIndexJobStatus::Running);
        assert_eq!(running.scanned, Some(2));
        assert_eq!(running.indexed, Some(1));
        complete_source_index_job_from_progress("source-2", &job.id);
        assert_eq!(
            get_source_index_job("source-2").and_then(|job| job.indexed),
            Some(1)
        );

        mark_source_index_in_flight("source-2");
        assert!(is_source_index_in_flight("source-2"));
        clear_source_index_in_flight("source-2");
        assert!(!is_source_index_in_flight("source-2"));

        let job = begin_source_index_job("source-3");
        cancel_source_index_job("source-3");
        assert!(consume_canceled_source_index_job(&job.id));
        assert!(!consume_canceled_source_index_job(&job.id));
        clear_source_index_progress_for_tests();
    }
}

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use signet_pipeline::single_flight::SingleFlightRunner;
use tokio::sync::{Notify, oneshot};

fn push_phase(phases: &Arc<Mutex<Vec<String>>>, phase: impl Into<String>) {
    phases.lock().expect("phase lock").push(phase.into());
}

// Port of platform/daemon/src/single-flight-runner.test.ts:5-33 and source
// behavior in platform/daemon/src/single-flight-runner.ts:21-47.
#[tokio::test]
async fn replays_one_follow_up_pass_when_rerun_requested_during_execution() {
    let phases = Arc::new(Mutex::new(Vec::new()));
    let runs = Arc::new(AtomicUsize::new(0));
    let started = Arc::new(Notify::new());
    let (release_tx, release_rx) = oneshot::channel::<()>();
    let release_rx = Arc::new(Mutex::new(Some(release_rx)));

    let runner = SingleFlightRunner::<String>::new({
        let phases = Arc::clone(&phases);
        let runs = Arc::clone(&runs);
        let started = Arc::clone(&started);
        let release_rx = Arc::clone(&release_rx);
        move || {
            let phases = Arc::clone(&phases);
            let runs = Arc::clone(&runs);
            let started = Arc::clone(&started);
            let receiver = release_rx.lock().expect("release lock").take();
            async move {
                let run = runs.fetch_add(1, Ordering::SeqCst) + 1;
                push_phase(&phases, format!("run-{run}-start"));
                if run == 1 {
                    started.notify_one();
                    receiver
                        .expect("first release receiver")
                        .await
                        .map_err(|error| error.to_string())?;
                }
                push_phase(&phases, format!("run-{run}-end"));
                Ok(())
            }
        }
    });

    let first_runner = runner.clone();
    let first = tokio::spawn(async move { first_runner.execute().await });
    started.notified().await;
    assert!(runner.running());

    runner.request_rerun();
    runner.execute().await;

    release_tx.send(()).expect("release first run");
    first.await.expect("first execute task");

    assert_eq!(runs.load(Ordering::SeqCst), 2);
    assert_eq!(
        phases.lock().expect("phase lock").as_slice(),
        ["run-1-start", "run-1-end", "run-2-start", "run-2-end"]
    );
    assert!(!runner.running());
}

// Port of platform/daemon/src/single-flight-runner.test.ts:35-57.
#[tokio::test]
async fn collapses_repeated_rerun_requests_into_one_extra_pass() {
    let runs = Arc::new(AtomicUsize::new(0));
    let started = Arc::new(Notify::new());
    let (release_tx, release_rx) = oneshot::channel::<()>();
    let release_rx = Arc::new(Mutex::new(Some(release_rx)));

    let runner = SingleFlightRunner::<String>::new({
        let runs = Arc::clone(&runs);
        let started = Arc::clone(&started);
        let release_rx = Arc::clone(&release_rx);
        move || {
            let runs = Arc::clone(&runs);
            let started = Arc::clone(&started);
            let receiver = release_rx.lock().expect("release lock").take();
            async move {
                let run = runs.fetch_add(1, Ordering::SeqCst) + 1;
                if run == 1 {
                    started.notify_one();
                    receiver
                        .expect("first release receiver")
                        .await
                        .map_err(|error| error.to_string())?;
                }
                Ok(())
            }
        }
    });

    let first_runner = runner.clone();
    let first = tokio::spawn(async move { first_runner.execute().await });
    started.notified().await;
    runner.request_rerun();
    runner.request_rerun();
    runner.request_rerun();

    release_tx.send(()).expect("release first run");
    first.await.expect("first execute task");

    assert_eq!(runs.load(Ordering::SeqCst), 2);
}

// Port of platform/daemon/src/single-flight-runner.test.ts:59-94 and the
// transient-failure loop in platform/daemon/src/single-flight-runner.ts:31-39.
#[tokio::test]
async fn replays_queued_rerun_after_transient_failure() {
    let phases = Arc::new(Mutex::new(Vec::new()));
    let runs = Arc::new(AtomicUsize::new(0));
    let started = Arc::new(Notify::new());
    let (release_tx, release_rx) = oneshot::channel::<()>();
    let release_rx = Arc::new(Mutex::new(Some(release_rx)));
    let seen_errors = Arc::new(Mutex::new(Vec::new()));

    let runner = SingleFlightRunner::with_error_handler(
        {
            let phases = Arc::clone(&phases);
            let runs = Arc::clone(&runs);
            let started = Arc::clone(&started);
            let release_rx = Arc::clone(&release_rx);
            move || {
                let phases = Arc::clone(&phases);
                let runs = Arc::clone(&runs);
                let started = Arc::clone(&started);
                let receiver = release_rx.lock().expect("release lock").take();
                async move {
                    let run = runs.fetch_add(1, Ordering::SeqCst) + 1;
                    push_phase(&phases, format!("run-{run}-start"));
                    if run == 1 {
                        started.notify_one();
                        receiver
                            .expect("first release receiver")
                            .await
                            .map_err(|error| error.to_string())?;
                        push_phase(&phases, "run-1-throw");
                        return Err("transient sync failure".to_string());
                    }
                    push_phase(&phases, format!("run-{run}-end"));
                    Ok(())
                }
            }
        },
        {
            let seen_errors = Arc::clone(&seen_errors);
            move |error: &String| {
                seen_errors.lock().expect("error lock").push(error.clone());
            }
        },
    );

    let first_runner = runner.clone();
    let first = tokio::spawn(async move { first_runner.execute().await });
    started.notified().await;
    assert!(runner.running());

    runner.request_rerun();
    release_tx.send(()).expect("release first run");
    first.await.expect("first execute task");

    assert_eq!(runs.load(Ordering::SeqCst), 2);
    assert_eq!(
        phases.lock().expect("phase lock").as_slice(),
        ["run-1-start", "run-1-throw", "run-2-start", "run-2-end"]
    );
    assert_eq!(
        seen_errors.lock().expect("error lock").as_slice(),
        ["transient sync failure"]
    );
    assert!(!runner.running());
}

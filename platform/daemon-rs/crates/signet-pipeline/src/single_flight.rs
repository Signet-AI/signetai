//! Single-flight async runner parity for the TS daemon.
//!
//! Port of `platform/daemon/src/single-flight-runner.ts`: duplicate concurrent
//! `execute` calls do not start duplicate work; they request one queued rerun.

use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};

type BoxRunFuture<E> = Pin<Box<dyn Future<Output = Result<(), E>> + Send + 'static>>;

type RunOnce<E> = dyn Fn() -> BoxRunFuture<E> + Send + Sync + 'static;
type ErrorHandler<E> = dyn Fn(&E) + Send + Sync + 'static;

#[derive(Debug, Default)]
struct State {
    running: bool,
    rerun_requested: bool,
}

pub struct SingleFlightRunner<E> {
    state: Arc<Mutex<State>>,
    run_once: Arc<RunOnce<E>>,
    on_error: Option<Arc<ErrorHandler<E>>>,
}

impl<E> Clone for SingleFlightRunner<E> {
    fn clone(&self) -> Self {
        Self {
            state: Arc::clone(&self.state),
            run_once: Arc::clone(&self.run_once),
            on_error: self.on_error.as_ref().map(Arc::clone),
        }
    }
}

impl<E: Send + Sync + 'static> SingleFlightRunner<E> {
    pub fn new<R, Fut>(run_once: R) -> Self
    where
        R: Fn() -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<(), E>> + Send + 'static,
    {
        Self::with_optional_error_handler(run_once, None::<fn(&E)>)
    }

    pub fn with_error_handler<R, Fut, H>(run_once: R, on_error: H) -> Self
    where
        R: Fn() -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<(), E>> + Send + 'static,
        H: Fn(&E) + Send + Sync + 'static,
    {
        Self::with_optional_error_handler(run_once, Some(on_error))
    }

    pub fn running(&self) -> bool {
        self.state
            .lock()
            .expect("single-flight state poisoned")
            .running
    }

    pub fn request_rerun(&self) {
        self.state
            .lock()
            .expect("single-flight state poisoned")
            .rerun_requested = true;
    }

    pub async fn execute(&self) {
        {
            let mut state = self.state.lock().expect("single-flight state poisoned");
            if state.running {
                state.rerun_requested = true;
                return;
            }
            state.running = true;
        }

        loop {
            {
                let mut state = self.state.lock().expect("single-flight state poisoned");
                state.rerun_requested = false;
            }

            if let Err(error) = (self.run_once)().await {
                if let Some(on_error) = &self.on_error {
                    on_error(&error);
                }
                if self.finish_if_idle() {
                    break;
                }
                continue;
            }

            if self.finish_if_idle() {
                break;
            }
        }
    }

    fn with_optional_error_handler<R, Fut, H>(run_once: R, on_error: Option<H>) -> Self
    where
        R: Fn() -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<(), E>> + Send + 'static,
        H: Fn(&E) + Send + Sync + 'static,
    {
        Self {
            state: Arc::new(Mutex::new(State::default())),
            run_once: Arc::new(move || Box::pin(run_once())),
            on_error: on_error.map(|handler| Arc::new(handler) as Arc<ErrorHandler<E>>),
        }
    }

    fn finish_if_idle(&self) -> bool {
        let mut state = self.state.lock().expect("single-flight state poisoned");
        if state.rerun_requested {
            false
        } else {
            state.running = false;
            true
        }
    }
}

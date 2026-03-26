pub mod client;
pub mod config;
pub mod hooks;
pub mod memory;
pub mod recall_cache;
pub mod secrets;
pub mod skills;
pub mod watcher;

pub use client::{daemon_auth_headers, daemon_auth_headers_from_env, SignetClient};
pub use secrets::{DiscoveredProvider, KeySource};
pub use skills::Skill;
pub use watcher::{ConfigEvent, ConfigWatcher};

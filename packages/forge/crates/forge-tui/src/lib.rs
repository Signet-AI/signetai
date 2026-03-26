pub mod app;
pub mod chrome;
pub mod input;
pub mod keybinds;
pub mod mcp_config;
pub mod settings;
pub mod theme;
pub mod views;
#[cfg(feature = "voice")]
pub mod voice;
#[cfg(not(feature = "voice"))]
pub mod voice {
    // Stubs when voice feature is disabled
    pub struct Recorder;
    impl Recorder {
        pub fn new() -> Result<Self, String> { Err("Voice feature not enabled".into()) }
        pub fn start(&mut self) -> Result<(), String> { Err("Voice feature not enabled".into()) }
        pub fn stop(&mut self) -> Vec<f32> { Vec::new() }
        pub fn sample_rate(&self) -> u32 { 16000 }
        pub fn channels(&self) -> u16 { 1 }
        pub fn current_samples(&self) -> Vec<f32> { Vec::new() }
    }
    pub async fn ensure_model() -> Result<std::path::PathBuf, String> {
        Err("Voice feature not enabled — rebuild with: cargo install --path crates/forge-cli".into())
    }
    pub fn transcribe(_: &std::path::Path, _: &[f32], _: u32, _: u16) -> Result<String, String> {
        Err("Voice feature not enabled".into())
    }
}
pub mod widgets;

pub use app::App;
pub use mcp_config::McpConfig;
pub use theme::Theme;

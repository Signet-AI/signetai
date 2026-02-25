pub trait DaemonManager {
    fn start(&self) -> Result<(), Box<dyn std::error::Error>>;
    fn stop(&self) -> Result<(), Box<dyn std::error::Error>>;
    #[allow(dead_code)]
    fn is_running(&self) -> bool;
}

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "macos")]
pub mod autostart;
#[cfg(target_os = "windows")]
mod windows;

pub fn create_manager() -> Box<dyn DaemonManager> {
    #[cfg(target_os = "linux")]
    { Box::new(linux::LinuxManager) }

    #[cfg(target_os = "macos")]
    { Box::new(macos::MacosManager) }

    #[cfg(target_os = "windows")]
    { Box::new(windows::WindowsManager) }
}

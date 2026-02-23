use super::DaemonManager;

pub struct WindowsManager;

impl DaemonManager for WindowsManager {
    fn start(&self) -> Result<(), Box<dyn std::error::Error>> {
        Err("Windows support not yet implemented".into())
    }

    fn stop(&self) -> Result<(), Box<dyn std::error::Error>> {
        Err("Windows support not yet implemented".into())
    }

    fn is_running(&self) -> bool {
        false
    }
}

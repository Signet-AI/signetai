use super::DaemonManager;

pub struct MacosManager;

impl DaemonManager for MacosManager {
    fn start(&self) -> Result<(), Box<dyn std::error::Error>> {
        Err("macOS support not yet implemented".into())
    }

    fn stop(&self) -> Result<(), Box<dyn std::error::Error>> {
        Err("macOS support not yet implemented".into())
    }

    fn is_running(&self) -> bool {
        false
    }
}

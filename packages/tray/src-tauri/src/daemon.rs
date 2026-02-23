use crate::platform;

pub fn start() -> Result<(), Box<dyn std::error::Error>> {
    let manager = platform::create_manager();
    manager.start()
}

pub fn stop() -> Result<(), Box<dyn std::error::Error>> {
    let manager = platform::create_manager();
    manager.stop()
}

pub fn read_pid() -> Result<Option<u32>, Box<dyn std::error::Error>> {
    let pid_path = dirs::home_dir()
        .ok_or("no home dir")?
        .join(".agents/.daemon/pid");

    if !pid_path.exists() {
        return Ok(None);
    }

    let content = std::fs::read_to_string(&pid_path)?;
    let pid: u32 = content.trim().parse()?;

    // Verify process is actually alive (cross-platform)
    let alive = process_alive(pid);
    if !alive {
        let _ = std::fs::remove_file(&pid_path);
        return Ok(None);
    }

    Ok(Some(pid))
}

/// Check if a process is alive. Uses kill(pid, 0) which works on
/// both Linux and macOS (unlike /proc which is Linux-only).
fn process_alive(pid: u32) -> bool {
    unsafe { libc::kill(pid as i32, 0) == 0 }
}

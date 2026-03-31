use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex as StdMutex};

/// Voice backend used for transcription.
#[derive(Clone, Debug)]
pub enum VoiceBackend {
    /// Local Parakeet command invocation.
    Parakeet { command: Vec<String> },
    /// Local whisper.cpp model via whisper-rs.
    Whisper { model_path: PathBuf },
}

impl VoiceBackend {
    pub fn display_name(&self) -> &'static str {
        match self {
            Self::Parakeet { .. } => "Parakeet",
            Self::Whisper { .. } => "Whisper",
        }
    }
}

/// Model storage location
fn model_dir() -> PathBuf {
    dirs::config_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("forge")
        .join("models")
}

fn model_path() -> PathBuf {
    model_dir().join("ggml-base.en.bin")
}

fn command_exists(bin: &str) -> bool {
    if bin.contains(std::path::MAIN_SEPARATOR) {
        return Path::new(bin).exists();
    }

    let Some(paths) = std::env::var_os("PATH") else {
        return false;
    };
    std::env::split_paths(&paths).any(|dir| {
        let candidate = dir.join(bin);
        if candidate.exists() {
            return true;
        }
        #[cfg(windows)]
        {
            let candidate_exe = dir.join(format!("{bin}.exe"));
            candidate_exe.exists()
        }
        #[cfg(not(windows))]
        {
            false
        }
    })
}

fn parse_shell_words(input: &str) -> Vec<String> {
    input
        .split_whitespace()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(ToOwned::to_owned)
        .collect()
}

fn resolve_parakeet_command() -> Option<Vec<String>> {
    if let Ok(raw) = std::env::var("FORGE_PARAKEET_COMMAND") {
        let mut cmd = parse_shell_words(raw.trim());
        if cmd.is_empty() {
            return None;
        }
        if !cmd.iter().any(|arg| arg == "{input}") {
            cmd.push("{input}".to_string());
        }
        return Some(cmd);
    }

    let candidates: &[&[&str]] = &[
        &["parakeet-mlx", "{input}"],
        &["parakeet", "{input}"],
    ];

    for candidate in candidates {
        if let Some((first, _rest)) = candidate.split_first() {
            if command_exists(first) {
                return Some(candidate.iter().map(|s| (*s).to_string()).collect());
            }
        }
    }

    None
}

fn preferred_backend() -> String {
    std::env::var("FORGE_VOICE_BACKEND")
        .map(|v| v.trim().to_ascii_lowercase())
        .ok()
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| "parakeet".to_string())
}

/// Prepare a transcription backend.
///
/// Default behavior prefers Parakeet CLI if present, then falls back to Whisper.
pub async fn ensure_model() -> Result<VoiceBackend, String> {
    let prefer = preferred_backend();

    if prefer != "whisper" {
        if let Some(command) = resolve_parakeet_command() {
            return Ok(VoiceBackend::Parakeet { command });
        }
    }

    // Whisper fallback
    let dir = model_dir();
    std::fs::create_dir_all(&dir).map_err(|e| format!("Create dir: {e}"))?;

    let model_path = model_path();
    if !model_path.exists() {
        // Download from Hugging Face
        let url = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin";
        let resp = reqwest::get(url).await.map_err(|e| format!("Download: {e}"))?;
        if !resp.status().is_success() {
            return Err(format!("Download failed: HTTP {}", resp.status()));
        }
        let bytes = resp.bytes().await.map_err(|e| format!("Read: {e}"))?;
        std::fs::write(&model_path, &bytes).map_err(|e| format!("Write: {e}"))?;
    }

    Ok(VoiceBackend::Whisper { model_path })
}

/// Audio recorder using cpal
pub struct Recorder {
    samples: Arc<StdMutex<Vec<f32>>>,
    stream: Option<cpal::Stream>,
    sample_rate: u32,
    channels: u16,
}

impl Recorder {
    pub fn new() -> Result<Self, String> {
        let host = cpal::default_host();
        let device = host
            .default_input_device()
            .ok_or_else(|| "No audio input device found".to_string())?;
        let config = device
            .default_input_config()
            .map_err(|e| format!("Input config: {e}"))?;

        Ok(Self {
            samples: Arc::new(StdMutex::new(Vec::new())),
            stream: None,
            sample_rate: config.sample_rate().0,
            channels: config.channels(),
        })
    }

    pub fn start(&mut self) -> Result<(), String> {
        let host = cpal::default_host();
        let device = host
            .default_input_device()
            .ok_or_else(|| "No microphone found".to_string())?;
        let config = device
            .default_input_config()
            .map_err(|e| format!("Input config: {e}"))?;

        self.sample_rate = config.sample_rate().0;
        self.channels = config.channels();
        self.samples
            .lock()
            .map_err(|_| "Audio lock poisoned".to_string())?
            .clear();
        let samples = Arc::clone(&self.samples);

        let stream = device
            .build_input_stream(
                &config.into(),
                move |data: &[f32], _: &cpal::InputCallbackInfo| {
                    if let Ok(mut guard) = samples.lock() {
                        guard.extend_from_slice(data);
                    }
                },
                |err| tracing::warn!("Audio capture error: {err}"),
                None,
            )
            .map_err(|e| format!("Build stream: {e}"))?;

        stream.play().map_err(|e| format!("Play stream: {e}"))?;
        self.stream = Some(stream);
        Ok(())
    }

    pub fn stop(&mut self) -> Vec<f32> {
        self.stream = None; // Drop stops the stream
        self.samples
            .lock()
            .map(|v| v.clone())
            .unwrap_or_default()
    }

    pub fn sample_rate(&self) -> u32 {
        self.sample_rate
    }

    pub fn channels(&self) -> u16 {
        self.channels
    }

    /// Get current samples for interim transcription (non-destructive)
    pub fn current_samples(&self) -> Vec<f32> {
        self.samples
            .lock()
            .map(|v| v.clone())
            .unwrap_or_default()
    }
}

/// Convert interleaved multi-channel audio to mono by averaging channels
fn to_mono(samples: &[f32], channels: u16) -> Vec<f32> {
    if channels <= 1 {
        return samples.to_vec();
    }
    let ch = channels as usize;
    samples
        .chunks_exact(ch)
        .map(|frame| frame.iter().sum::<f32>() / ch as f32)
        .collect()
}

/// Simple linear resampling
fn resample(samples: &[f32], from_rate: u32, to_rate: u32) -> Vec<f32> {
    if from_rate == to_rate {
        return samples.to_vec();
    }
    let ratio = to_rate as f64 / from_rate as f64;
    let new_len = (samples.len() as f64 * ratio) as usize;
    let mut out = Vec::with_capacity(new_len);
    for i in 0..new_len {
        let src = i as f64 / ratio;
        let idx = src as usize;
        let frac = src - idx as f64;
        let s = if idx + 1 < samples.len() {
            samples[idx] * (1.0 - frac as f32) + samples[idx + 1] * frac as f32
        } else if idx < samples.len() {
            samples[idx]
        } else {
            0.0
        };
        out.push(s);
    }
    out
}

/// Prepare raw audio: convert to mono and resample to 16kHz
pub fn prepare_audio(samples: &[f32], sample_rate: u32, channels: u16) -> Vec<f32> {
    let mono = to_mono(samples, channels);
    resample(&mono, sample_rate, 16000)
}

fn write_wav(path: &Path, samples: &[f32], sample_rate: u32) -> Result<(), String> {
    let mut out = Vec::with_capacity(44 + samples.len() * 2);
    let bytes_per_sample = 2u16;
    let channels = 1u16;
    let byte_rate = sample_rate * channels as u32 * bytes_per_sample as u32;
    let block_align = channels * bytes_per_sample;
    let data_len = (samples.len() * bytes_per_sample as usize) as u32;

    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + data_len).to_le_bytes());
    out.extend_from_slice(b"WAVE");
    out.extend_from_slice(b"fmt ");
    out.extend_from_slice(&16u32.to_le_bytes()); // PCM header size
    out.extend_from_slice(&1u16.to_le_bytes()); // PCM
    out.extend_from_slice(&channels.to_le_bytes());
    out.extend_from_slice(&sample_rate.to_le_bytes());
    out.extend_from_slice(&byte_rate.to_le_bytes());
    out.extend_from_slice(&block_align.to_le_bytes());
    out.extend_from_slice(&16u16.to_le_bytes()); // bits/sample
    out.extend_from_slice(b"data");
    out.extend_from_slice(&data_len.to_le_bytes());

    for &sample in samples {
        let clamped = sample.clamp(-1.0, 1.0);
        let v = (clamped * i16::MAX as f32) as i16;
        out.extend_from_slice(&v.to_le_bytes());
    }

    std::fs::write(path, out).map_err(|e| format!("Write WAV: {e}"))
}

fn run_parakeet(command_template: &[String], audio: &[f32]) -> Result<String, String> {
    if command_template.is_empty() {
        return Err("Parakeet command is empty".to_string());
    }

    let temp_path = std::env::temp_dir().join(format!(
        "forge-parakeet-{}.wav",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|e| format!("Clock: {e}"))?
            .as_millis()
    ));
    write_wav(&temp_path, audio, 16_000)?;

    let mut args = Vec::with_capacity(command_template.len());
    for token in command_template {
        if token == "{input}" {
            args.push(temp_path.to_string_lossy().to_string());
        } else {
            args.push(token.clone());
        }
    }

    let (program, rest) = args
        .split_first()
        .ok_or_else(|| "Invalid parakeet command".to_string())?;

    let output = Command::new(OsStr::new(program))
        .args(rest)
        .output()
        .map_err(|e| format!("Run parakeet: {e}"))?;

    let _ = std::fs::remove_file(&temp_path);

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let reason = if !stderr.is_empty() {
            stderr
        } else if !stdout.is_empty() {
            stdout
        } else {
            format!("exit status {}", output.status)
        };
        return Err(format!("Parakeet transcription failed: {reason}"));
    }

    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if stdout.is_empty() {
        return Err("Parakeet returned empty output".to_string());
    }

    // Keep the most meaningful final line if command emits logs.
    let text = stdout
        .lines()
        .rev()
        .find(|line| !line.trim().is_empty())
        .unwrap_or("")
        .trim()
        .to_string();

    Ok(text)
}

fn transcribe_whisper(
    model_path: &Path,
    audio: &[f32],
) -> Result<String, String> {
    use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

    // Suppress ALL whisper.cpp output (stdout + stderr) during the entire
    // transcription. GGML/Metal init, state creation, and inference all dump
    // verbose logs that flood the TUI.
    #[cfg(unix)]
    let (stdout_guard, stderr_guard) = {
        use std::os::unix::io::AsRawFd;
        let old_out = unsafe { libc::dup(1) };
        let old_err = unsafe { libc::dup(2) };
        if let Ok(devnull) = std::fs::File::open("/dev/null") {
            let fd = devnull.as_raw_fd();
            unsafe {
                libc::dup2(fd, 1);
                libc::dup2(fd, 2);
            }
        }
        (old_out, old_err)
    };

    let result = (|| -> Result<(WhisperContext, _), String> {
        let ctx = WhisperContext::new_with_params(
            model_path.to_str().unwrap_or(""),
            WhisperContextParameters::default(),
        )
        .map_err(|e| format!("Load model: {e}"))?;

        let state = ctx
            .create_state()
            .map_err(|e| format!("Create state: {e}"))?;

        Ok((ctx, state))
    })();

    let (_ctx, mut state) = match result {
        Ok(v) => v,
        Err(e) => {
            #[cfg(unix)]
            unsafe {
                libc::dup2(stdout_guard, 1);
                libc::close(stdout_guard);
                libc::dup2(stderr_guard, 2);
                libc::close(stderr_guard);
            }
            return Err(e);
        }
    };

    let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
    params.set_language(Some("en"));
    params.set_print_special(false);
    params.set_print_progress(false);
    params.set_print_realtime(false);
    params.set_print_timestamps(false);
    params.set_single_segment(false);
    params.set_no_context(true);
    params.set_n_threads(4);

    state
        .full(params, audio)
        .map_err(|e| format!("Transcribe: {e}"))?;

    let mut text = String::new();
    let n = state
        .full_n_segments()
        .map_err(|e| format!("Segments: {e}"))?;
    for i in 0..n {
        if let Ok(seg) = state.full_get_segment_text(i) {
            text.push_str(&seg);
        }
    }

    drop(state);
    drop(_ctx);

    #[cfg(unix)]
    unsafe {
        libc::dup2(stdout_guard, 1);
        libc::close(stdout_guard);
        libc::dup2(stderr_guard, 2);
        libc::close(stderr_guard);
    }

    Ok(text.trim().to_string())
}

/// Transcribe PCM audio using the selected backend.
pub fn transcribe(
    backend: &VoiceBackend,
    samples: &[f32],
    sample_rate: u32,
    channels: u16,
) -> Result<String, String> {
    let audio = prepare_audio(samples, sample_rate, channels);

    if audio.is_empty() {
        return Ok(String::new());
    }

    match backend {
        VoiceBackend::Parakeet { command } => run_parakeet(command, &audio),
        VoiceBackend::Whisper { model_path } => transcribe_whisper(model_path, &audio),
    }
}

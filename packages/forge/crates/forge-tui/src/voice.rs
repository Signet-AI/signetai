use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use std::path::PathBuf;
use std::sync::{Arc, Mutex as StdMutex};

/// Model storage location
fn model_dir() -> PathBuf {
    dirs::config_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("forge")
        .join("models")
}

/// Download whisper model if not present. Returns path to model file.
pub async fn ensure_model() -> Result<PathBuf, String> {
    let dir = model_dir();
    std::fs::create_dir_all(&dir).map_err(|e| format!("Create dir: {e}"))?;

    let model_path = dir.join("ggml-base.en.bin");
    if model_path.exists() {
        return Ok(model_path);
    }

    // Download from Hugging Face
    let url = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin";
    let resp = reqwest::get(url).await.map_err(|e| format!("Download: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("Download failed: HTTP {}", resp.status()));
    }
    let bytes = resp.bytes().await.map_err(|e| format!("Read: {e}"))?;
    std::fs::write(&model_path, &bytes).map_err(|e| format!("Write: {e}"))?;

    Ok(model_path)
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
        self.samples.lock().unwrap().clear();
        let samples = Arc::clone(&self.samples);

        let stream = device
            .build_input_stream(
                &config.into(),
                move |data: &[f32], _: &cpal::InputCallbackInfo| {
                    samples.lock().unwrap().extend_from_slice(data);
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
        let samples = self.samples.lock().unwrap().clone();
        samples
    }

    pub fn sample_rate(&self) -> u32 {
        self.sample_rate
    }

    pub fn channels(&self) -> u16 {
        self.channels
    }

    /// Get current samples for interim transcription (non-destructive)
    pub fn current_samples(&self) -> Vec<f32> {
        self.samples.lock().unwrap().clone()
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

/// Prepare raw audio for whisper: convert to mono and resample to 16kHz
pub fn prepare_audio(samples: &[f32], sample_rate: u32, channels: u16) -> Vec<f32> {
    let mono = to_mono(samples, channels);
    resample(&mono, sample_rate, 16000)
}

/// Transcribe PCM audio using whisper-rs (fully local)
pub fn transcribe(
    model_path: &std::path::Path,
    samples: &[f32],
    sample_rate: u32,
    channels: u16,
) -> Result<String, String> {
    use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

    let audio = prepare_audio(samples, sample_rate, channels);

    if audio.is_empty() {
        return Ok(String::new());
    }

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
            // Restore before returning error
            #[cfg(unix)]
            unsafe {
                libc::dup2(stdout_guard, 1); libc::close(stdout_guard);
                libc::dup2(stderr_guard, 2); libc::close(stderr_guard);
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
    // Speed optimizations for real-time
    params.set_n_threads(4);

    state
        .full(params, &audio)
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

    // Drop whisper state and context BEFORE restoring stdout/stderr.
    // Metal cleanup (ggml_metal_free) logs on drop, so keep fd suppressed.
    drop(state);
    drop(_ctx);

    // NOW restore stdout + stderr
    #[cfg(unix)]
    unsafe {
        libc::dup2(stdout_guard, 1); libc::close(stdout_guard);
        libc::dup2(stderr_guard, 2); libc::close(stderr_guard);
    }

    Ok(text.trim().to_string())
}

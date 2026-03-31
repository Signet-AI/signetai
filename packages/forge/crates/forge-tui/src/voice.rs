use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use std::path::Path;
use std::sync::{Arc, Mutex as StdMutex};

/// Voice backend used for transcription.
#[derive(Clone, Debug)]
pub enum VoiceBackend {
    /// Local TranscriptionSuite server (OpenAI-compatible endpoint).
    TranscriptionSuite {
        base_url: String,
        bearer_token: Option<String>,
    },
}

impl VoiceBackend {
    pub fn display_name(&self) -> &'static str {
        match self {
            Self::TranscriptionSuite { .. } => "TranscriptionSuite",
        }
    }
}

/// Prepare a transcription backend.
///
/// Default behavior targets a local TranscriptionSuite server.
pub async fn ensure_model() -> Result<VoiceBackend, String> {
    let base_url = std::env::var("FORGE_TRANSCRIPTIONSUITE_URL")
        .ok()
        .map(|s| s.trim().trim_end_matches('/').to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "http://127.0.0.1:9786".to_string());
    let bearer_token = std::env::var("FORGE_TRANSCRIPTIONSUITE_TOKEN")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    Ok(VoiceBackend::TranscriptionSuite {
        base_url,
        bearer_token,
    })
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

fn transcribe_transcriptionsuite(
    base_url: &str,
    bearer_token: Option<&str>,
    audio: &[f32],
) -> Result<String, String> {
    let temp_path = std::env::temp_dir().join(format!(
        "forge-transcribe-{}.wav",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|e| format!("Clock: {e}"))?
            .as_millis()
    ));
    write_wav(&temp_path, audio, 16_000)?;

    let bytes = std::fs::read(&temp_path).map_err(|e| format!("Read temp WAV: {e}"))?;
    let _ = std::fs::remove_file(&temp_path);

    let endpoint = format!("{}/v1/audio/transcriptions", base_url.trim_end_matches('/'));
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|e| format!("Build runtime: {e}"))?;

    rt.block_on(async move {
        let client = reqwest::Client::new();
        let part = reqwest::multipart::Part::bytes(bytes)
            .file_name("dictation.wav")
            .mime_str("audio/wav")
            .map_err(|e| format!("MIME: {e}"))?;
        let form = reqwest::multipart::Form::new()
            .part("file", part)
            .text("model", "transcriptionsuite-1")
            .text("response_format", "text");

        let mut req = client.post(endpoint).multipart(form);
        if let Some(token) = bearer_token {
            req = req.bearer_auth(token);
        }

        let resp = req.send().await.map_err(|e| format!("Send request: {e}"))?;
        let status = resp.status();
        let body = resp.text().await.map_err(|e| format!("Read response: {e}"))?;

        if !status.is_success() {
            let snippet = body.chars().take(220).collect::<String>();
            return Err(format!("TranscriptionSuite HTTP {status}: {snippet}"));
        }

        Ok(body.trim().to_string())
    })
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
        VoiceBackend::TranscriptionSuite {
            base_url,
            bearer_token,
        } => transcribe_transcriptionsuite(base_url, bearer_token.as_deref(), &audio),
    }
}

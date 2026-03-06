'use strict';
/**
 * src/inbox-watcher/handlers/audio.js
 *
 * Handles audio files: .mp3, .wav, .m4a, .flac, .ogg, .aac
 * Also handles video files: .mp4, .mov, .webm, .avi
 *   (via ffmpeg audio extraction → Whisper transcription)
 *
 * Exports:
 *   handleAudio(filePath, config) → Promise<{ text, tags }>
 *   handleVideo(filePath, config) → Promise<{ text, tags }>
 */

const fs            = require('fs');
const path          = require('path');
const os            = require('os');
const { spawnSync } = require('child_process');

const MAX_TRANSCRIPT_CHARS = 8000;

// ── Audio handler ─────────────────────────────────────────────────────────────

/**
 * Transcribe an audio file using the Whisper CLI.
 *
 * @param {string} filePath - Absolute path to the audio file
 * @param {object} config   - App config
 * @returns {Promise<{text: string, tags: string[]}>}
 */
async function handleAudio(filePath, config) {
  const model  = config.inbox?.audio?.model || 'base';
  const tmpDir = os.tmpdir();
  const fileName = path.basename(filePath);

  // whisper outputs <basename>.txt in the specified output directory
  const baseName   = path.basename(filePath, path.extname(filePath));
  const outputPath = path.join(tmpDir, `${baseName}.txt`);

  // Remove any stale output file from a previous run
  try {
    if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
  } catch { /* ignore */ }

  const result = spawnSync(
    'whisper',
    [
      filePath,
      '--model',         model,
      '--output_format', 'txt',
      '--output_dir',    tmpDir,
      '--verbose',       'False',
    ],
    {
      timeout:   300_000, // 5 minutes — generous for long recordings
      encoding:  'utf8',
      env:       { ...process.env },
      maxBuffer: 10 * 1024 * 1024,
    },
  );

  if (result.error) {
    throw new Error(`whisper spawn error: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const stderr = (result.stderr || result.stdout || '').trim();
    throw new Error(`Whisper transcription failed (exit ${result.status}): ${stderr}`);
  }

  // Read the output text file
  if (!fs.existsSync(outputPath)) {
    throw new Error(`Whisper output not found at: ${outputPath}`);
  }

  let transcript;
  try {
    transcript = fs.readFileSync(outputPath, 'utf8').trim();
  } catch (err) {
    throw new Error(`Cannot read Whisper output: ${err.message}`);
  } finally {
    // Clean up temp file regardless
    try { fs.unlinkSync(outputPath); } catch { /* ignore */ }
  }

  if (!transcript || transcript.length === 0) {
    throw new Error('Whisper produced an empty transcript');
  }

  const text = `[Audio transcription: ${fileName}]\n\n${transcript.substring(0, MAX_TRANSCRIPT_CHARS)}`;

  return {
    text,
    tags: ['inbox', 'audio', 'transcription'],
  };
}

// ── Video handler ─────────────────────────────────────────────────────────────

/**
 * Extract audio from a video file (ffmpeg) and then transcribe with Whisper.
 *
 * @param {string} filePath - Absolute path to the video file
 * @param {object} config   - App config
 * @returns {Promise<{text: string, tags: string[]}>}
 */
async function handleVideo(filePath, config) {
  const fileName  = path.basename(filePath);
  const tmpAudio  = path.join(os.tmpdir(), `signet-video-audio-${Date.now()}.mp3`);

  // ── Step 1: extract audio track via ffmpeg ─────────────────────────────────
  const extract = spawnSync(
    'ffmpeg',
    [
      '-i',      filePath,
      '-vn',                  // strip video stream
      '-acodec', 'mp3',
      '-ar',     '16000',     // 16 kHz — optimal sample rate for Whisper
      '-ac',     '1',         // mono — reduces file size; Whisper is fine with it
      tmpAudio,
      '-y',                   // overwrite output without prompting
    ],
    {
      timeout:  120_000, // 2 minutes
      encoding: 'utf8',
      env:      { ...process.env },
    },
  );

  if (extract.error) {
    throw new Error(`ffmpeg spawn error: ${extract.error.message}`);
  }
  if (extract.status !== 0) {
    const stderr = (extract.stderr || '').trim();
    throw new Error(`ffmpeg audio extraction failed (exit ${extract.status}): ${stderr}`);
  }

  if (!fs.existsSync(tmpAudio)) {
    throw new Error(`ffmpeg did not produce output file: ${tmpAudio}`);
  }

  // ── Step 2: transcribe extracted audio ────────────────────────────────────
  try {
    const result = await handleAudio(tmpAudio, config);

    // Override tags and prefix to reflect video source
    return {
      text: result.text.replace(
        /^\[Audio transcription: .*?\]/,
        `[Video transcription: ${fileName}]`,
      ),
      tags: ['inbox', 'video', 'transcription'],
    };
  } finally {
    // Always clean up the temp audio file
    try { fs.unlinkSync(tmpAudio); } catch { /* ignore */ }
  }
}

module.exports = { handleAudio, handleVideo };

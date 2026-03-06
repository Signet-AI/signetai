# signet-insight-engine

A companion service for [Signet](https://github.com/signetai/signet) that adds:

1. **InsightSynthesizer** — periodic knowledge synthesis from the entity graph
2. **File Inbox Watcher** — drop any file in `~/inbox`, it becomes a memory
3. **Insights Dashboard** — visualize insights, entity graph, and ingestion history

Inspired by Google's [Always-On Memory Agent](https://github.com/GoogleCloudPlatform/generative-ai/tree/main/gemini/agents/always-on-memory-agent).
Built as a PR contribution to [signetai](https://github.com/signetai/signetai).

---

## How It Works

### InsightSynthesizer

Every 6 hours, the synthesizer reads Signet's entity graph (entities + relations tables)
and finds clusters of memories that share high-mention entities. For each cluster,
it asks Claude Haiku one question: *"what cross-cutting pattern exists here that isn't
obvious from any single memory?"*

The result is stored in a new `insights` table and linked back to source memories.
This is the "sleep consolidation" pattern — not just storing memories, but actively
synthesizing understanding from them.

### File Inbox Watcher

Drop any supported file in `~/inbox/` (configurable). The watcher detects it within
5 seconds and routes it to the appropriate handler:

| File type | Handler |
|---|---|
| `.txt`, `.md`, `.json`, `.csv`, `.log`, `.yaml` | Direct text ingestion |
| `.pdf` | PDF text extraction → chunked ingestion |
| `.png`, `.jpg`, `.webp`, `.gif` | Claude Haiku vision description |
| `.mp3`, `.wav`, `.m4a`, `.flac` | Whisper transcription |
| `.mp4`, `.mov`, `.webm` | ffmpeg audio extract → Whisper |

All ingestion history is tracked in Signet's existing `ingestion_jobs` table.

### Insights Dashboard

Served at `http://localhost:3851`:

- **Insights tab** — card feed of generated insights with drill-down to source memories
- **Graph tab** — D3.js force-directed visualization of the entity/relation graph (12K+ entities)
- **Inbox tab** — ingestion history, watcher status, manual file trigger

---

## Prerequisites

- [Signet](https://github.com/signetai/signetai) v0.38+ installed and daemon running (`signet status`)
- Node.js 18+
- `claude` CLI in PATH (for synthesis and image description)
- `whisper` CLI in PATH (for audio transcription — `pip install openai-whisper`)
- `ffmpeg` in PATH (for video audio extraction — optional)
- `pdftotext` in PATH (for PDFs — `brew install poppler` on macOS)

---

## Installation

```bash
cd ~/.clawdbot/workspace/signet-insight-engine
npm install

# Run DB migrations (safe — only adds new tables/column, never modifies existing data)
npm run migrate

# Start the companion service
npm start
# → Dashboard at http://localhost:3851
```

---

## Configuration

Add to `~/.agents/agent.yaml` or create `~/.agents/insights-config.yaml`:

```yaml
insights:
  enabled: true
  scheduleExpression: "0 */6 * * *"   # every 6 hours
  minMemoriesPerCluster: 3
  maxMemoriesPerBatch: 10
  maxClustersPerRun: 5
  model: haiku
  topEntityCount: 30
  reprocessAfterDays: 7

inbox:
  enabled: false                        # opt-in — set to true to activate
  watchPath: "~/inbox"
  audio:
    enabled: true
    model: base                         # whisper model: tiny|base|small|medium|large
  image:
    enabled: true
  video:
    enabled: false                      # large files — disabled by default
  maxFileSizeMb: 50
```

---

## Run as a Background Service (macOS launchd)

```bash
# Install launchd service
cp launchd/com.signet.insights.plist ~/Library/LaunchAgents/
# Edit the plist to update paths if needed
launchctl load ~/Library/LaunchAgents/com.signet.insights.plist
launchctl start com.signet.insights
```

---

## Safety Boundaries

This service is designed to be completely safe to run alongside the Signet daemon:

- **Reads** from: `entities`, `relations`, `memory_entity_mentions`, `memories` (SELECT only)
- **Writes** to: `insights` (new), `insight_sources` (new), `memories.insight_processed_at` (new nullable column only), `ingestion_jobs` (new rows only)
- **Never modifies**: memory content, embeddings, entity/relation data, conversations, or any other existing Signet table data
- **WAL mode** is already set by Signet — concurrent reads are safe
- `busy_timeout = 5000` ensures this service waits for Signet's write locks rather than crashing

---

## PR Notes

See `pr-guide/INTEGRATION.md` for detailed instructions on integrating this
companion service's features directly into the Signet daemon.

---

## License

MIT — same as Signet.

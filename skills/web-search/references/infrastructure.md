# Web Search Infrastructure

## Component Locations

| Component | Binary/Path | Version |
|-----------|-------------|---------|
| SearXNG | Docker container `searxng` | latest (2026.3.18) |
| Lightpanda | `~/.local/bin/lightpanda` | v0.2.6 (x86_64-linux) |
| Agent-Browser | `/usr/bin/agent-browser` | 0.21.1 |
| web-search CLI | `~/.local/bin/web-search` | 1.0 |

## SearXNG

- **URL:** http://localhost:8888
- **Container name:** `searxng`
- **Container runtime:** OrbStack (Docker-compatible, macOS)
- **Config:** `~/.agents/searxng/config/settings.yml`
- **Data:** `~/.agents/searxng/data/`
- **Image:** `docker.io/searxng/searxng:latest`
- **Port mapping:** 8888 (host) → 8080 (container)

### Start/Stop/Restart

```bash
# Check status
docker ps | grep searxng

# Start (if stopped)
docker start searxng

# Stop
docker stop searxng

# Restart
docker restart searxng

# Full recreate (if needed)
docker rm -f searxng
docker run -d \
  --name searxng \
  -p 8888:8080 \
  -v "$HOME/.agents/searxng/config:/etc/searxng/" \
  -v "$HOME/.agents/searxng/data:/var/cache/searxng/" \
  docker.io/searxng/searxng:latest
```

### API Reference

Base URL: `http://localhost:8888`

**Search endpoint:** `GET /search`

| Parameter | Type | Description |
|-----------|------|-------------|
| `q` | string | Search query (URL-encoded) |
| `format` | string | `json` or `html` |
| `categories` | string | Comma-separated: `general`, `news`, `images`, `files`, `science`, `it`, `music`, `videos` |
| `pageno` | int | Page number (default: 1) |
| `language` | string | Language code (e.g., `en`) |
| `time_range` | string | `day`, `week`, `month`, `year` |
| `engines` | string | Comma-separated engine names to use |

**Response JSON structure:**
```json
{
  "results": [
    {
      "title": "Page Title",
      "url": "https://example.com",
      "content": "Snippet/description text",
      "engines": ["google", "duckduckgo"],
      "score": 5.2
    }
  ],
  "number_of_results": 12345,
  "query": "search terms"
}
```

## Lightpanda

- **Binary:** `~/.local/bin/lightpanda`
- **Source:** https://github.com/lightpanda-io/browser
- **Release:** v0.2.6 (x86_64-linux)
- **Capabilities:** HTML/Markdown/Semantic tree dump, iframe support, MCP server, CDP support, multi-thread
- **Note:** Zig TLS stack doesn't use system CA bundle. Use `--insecure_disable_tls_host_verification` for HTTPS fetches (already patched into web-search CLI).

### Commands

```bash
# Fetch and dump
lightpanda fetch --dump <format> [options] <URL>
# Formats: html, markdown, semantic_tree, semantic_tree_text

# Serve as CDP endpoint (for Puppeteer/Playwright connection)
lightpanda serve --host 127.0.0.1 --port 9222

# MCP server mode
lightpanda mcp
```

### Fetch Options

| Flag | Description |
|------|-------------|
| `--dump <format>` | Output format: `html`, `markdown`, `semantic_tree`, `semantic_tree_text` |
| `--strip_mode <modes>` | Comma-separated: `js`, `css`, `ui`, `full` |
| `--with_base` | Add `<base>` tag to dump |
| `--with_frames` | Include iframe contents |
| `--insecure_disable_tls_host_verification` | Disable TLS host verification |
| `--obey_robots` | Respect robots.txt |

## Agent-Browser

- **Binary:** `/usr/bin/agent-browser`
- **Version:** 0.21.1
- **Engine:** Playwright (Chromium)
- **Docs:** `~/.agents/skills/agent-browser/SKILL.md` (full reference)

### Key Commands

```bash
agent-browser open <url>              # Navigate
agent-browser snapshot -i             # List interactive elements
agent-browser click @e1               # Click element
agent-browser fill @e1 "text"         # Fill input
agent-browser get text body           # Get page text
agent-browser screenshot              # Take screenshot
agent-browser screenshot --annotate   # Screenshot with element labels
agent-browser wait --load networkidle # Wait for page load
agent-browser state save <file>       # Save auth/session state
agent-browser state load <file>       # Restore auth/session state
agent-browser close                   # Close browser
```

### Session Management

```bash
agent-browser --session <name> open <url>  # Named session (parallel use)
agent-browser session list                  # List active sessions
```

## OrbStack (Container Runtime)

- **App:** `/Applications/OrbStack.app`
- **Version:** 2.0.5
- **CLI:** `orbctl`
- **Docker context:** `orbstack`
- **Note:** Rosetta 2 was installed during setup for x86 container support

### Start/Stop

```bash
orbctl start        # Start OrbStack VM
orbctl stop         # Stop OrbStack VM
orbctl status       # Check status
open -a OrbStack    # Open GUI (sometimes needed for first start)
```

## Troubleshooting

### SearXNG not responding
1. Check if OrbStack is running: `orbctl status`
2. If stopped: `orbctl start` or `open -a OrbStack`
3. Check container: `docker ps | grep searxng`
4. Start container: `docker start searxng`
5. If container missing, recreate (see above)

### Lightpanda returns empty/error
- Page may require JavaScript → fall back to Agent-Browser
- TLS issues → try `--insecure_disable_tls_host_verification` (use sparingly)
- Timeout → page may be too large or slow

### Agent-Browser hanging
- `agent-browser close` to kill current session
- Check for orphan sessions: `agent-browser session list`
- If daemon stuck: `pkill -f agent-browser`

---
name: web-search
description: "Search the web and scrape pages using the local tool stack: SearXNG (meta-search), Lightpanda (fast headless fetch), and Agent-Browser (full browser automation). This is your DEFAULT web skill — use it whenever you need to look something up, research a topic, fetch a webpage, extract content from a URL, check current information, find documentation, do competitive research, or answer any question that benefits from live web data. Triggers on any form of: search for, look up, google, find out, research, what's the latest on, fetch this page, scrape this site, check this URL, pull info from, web search, or any task where current web information would improve your answer. Even if the user doesn't explicitly ask you to search — if answering well requires current info you don't have, use this skill. NOT for interactive browser automation like form filling or clicking (use [[agent-browser]] or [[browser-use]])."
metadata:
  last_verified: 2026-03-21
---

# Web Search & Scrape

You have three tools for web access. Use them in combination based on what the task needs.

## The Stack

### SearXNG — Search Engine
Local meta-search aggregating 25+ engines (Google, Bing, DuckDuckGo, Brave, etc). No tracking, no rate limits, JSON API.

```bash
# Basic search
curl -s "http://localhost:8888/search?q=QUERY&format=json" | python3 -c "
import json, sys
data = json.load(sys.stdin)
for r in data.get('results', [])[:10]:
    print(r.get('title', ''))
    print(r.get('url', ''))
    print(r.get('content', '')[:200])
    print()
"
```

**Category search** — append `&categories=` with: `general`, `news`, `images`, `files`, `science`, `it`, `music`, `videos`

```bash
# News search
curl -s "http://localhost:8888/search?q=QUERY&format=json&categories=news"

# Multiple categories
curl -s "http://localhost:8888/search?q=QUERY&format=json&categories=science,it"
```

**Pagination** — append `&pageno=2` (or 3, 4, etc) for more results.

### Lightpanda — Fast Headless Fetch
Built in Zig. 10x faster than Chrome, tiny memory footprint. Use this as the default for fetching page content.

```bash
# Fetch as markdown (best for reading/summarizing)
lightpanda fetch --dump markdown https://example.com

# Fetch as HTML (when you need structure)
lightpanda fetch --dump html https://example.com

# Semantic tree (useful for understanding page layout)
lightpanda fetch --dump semantic_tree https://example.com

# Strip unnecessary elements
lightpanda fetch --dump markdown --strip_mode js,css https://example.com

# Include iframe content
lightpanda fetch --dump markdown --with_frames https://example.com
```

### Agent-Browser — Full Browser Automation
Playwright-based. Use when Lightpanda can't handle the page (JS-heavy SPAs, login-required pages, dynamic content, form interactions).

```bash
# Open and snapshot
agent-browser open https://example.com
agent-browser wait --load networkidle
agent-browser snapshot -i

# Get text content
agent-browser get text body

# Interact with elements
agent-browser fill @e1 "search query"
agent-browser click @e2

# Screenshot for visual inspection
agent-browser screenshot --annotate

# Always close when done
agent-browser close
```

## Decision Guide

**Need to find something?** → SearXNG first. Always.

**Need page content?** → Lightpanda. It's fast, it returns clean markdown, and it handles 90% of pages.

**Lightpanda returns garbage or empty content?** → The page probably needs JavaScript to render. Switch to Agent-Browser.

**Need to log in, fill forms, click through flows?** → Agent-Browser. Save auth state for reuse:
```bash
agent-browser state save auth.json
# Later:
agent-browser state load auth.json
```

## The `web-search` CLI

There's also a unified CLI at `~/.agents/tools/web-search` (also available as `web-search` on PATH) that chains these together:

```bash
# Search only
web-search "hospice compliance CMS 2026"

# Search + scrape top results
web-search "hospice compliance CMS 2026" --scrape -n 3

# Fetch a single URL
web-search --fetch https://example.com

# Use Agent-Browser for JS-heavy pages
web-search --fetch https://spa-app.com --browser

# News search + scrape
web-search "CMS hospice updates" --categories news --scrape
```

## Common Patterns

### Research a topic
```bash
# 1. Search
curl -s "http://localhost:8888/search?q=topic+here&format=json" > /tmp/results.json

# 2. Review results, pick the best URLs

# 3. Fetch the good ones
lightpanda fetch --dump markdown https://good-result.com
```

### Get current/breaking info
```bash
# News category + recent results
curl -s "http://localhost:8888/search?q=topic&format=json&categories=news"
```

### Deep scrape multiple pages
```bash
# Search, extract URLs, fetch each
curl -s "http://localhost:8888/search?q=topic&format=json" | \
  python3 -c "import json,sys; [print(r['url']) for r in json.load(sys.stdin)['results'][:5]]" | \
  while read url; do
    echo "=== $url ==="
    lightpanda fetch --dump markdown "$url" 2>/dev/null
  done
```

### Handle a stubborn JS-heavy page
```bash
# Lightpanda returned nothing useful? Switch to agent-browser
agent-browser open https://stubborn-spa.com
agent-browser wait --load networkidle
agent-browser get text body > /tmp/page-content.txt
agent-browser close
```

## Important Notes

- SearXNG runs at `http://localhost:8888`. If it's down, check: `docker ps | grep searxng` and restart with `docker start searxng`
- Lightpanda is at `/opt/homebrew/bin/lightpanda`
- Agent-Browser is at `/opt/homebrew/bin/agent-browser` (v0.21.1)
- The `web-search` CLI is at `~/.agents/tools/web-search` and symlinked to `/opt/homebrew/bin/web-search`
- When SearXNG returns results, the `content` field has a snippet — often enough to answer simple factual questions without fetching the full page
- For URL encoding in curl, use python: `python3 -c "import urllib.parse; print(urllib.parse.quote('my query'))"`

## Bundled Resources

This skill includes everything needed to rebuild or troubleshoot the stack:

- **`scripts/web-search`** — The unified CLI script (also installed at `~/.agents/tools/web-search`)
- **`references/infrastructure.md`** — Full infrastructure docs: binary locations, SearXNG API reference, container management, OrbStack setup, troubleshooting guide. Read this if something breaks or you need to reconfigure.
- **`references/searxng-settings.yml`** — SearXNG config (engines, formats, API settings). Edit and copy to `~/.agents/searxng/config/settings.yml` then `docker restart searxng` to apply changes.

## Related Skills
- [[agent-browser]] — full browser automation for JS-heavy pages and form interaction
- [[human-browser]] — stealth browsing with residential proxies for bot-protected sites
- [[seo]] — SEO audits and optimization that complement web research

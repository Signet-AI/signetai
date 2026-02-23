#!/usr/bin/env python3
"""
Generate harness-specific config files from identity files

Source of truth: ~/.agents/ (AGENTS.md, SOUL.md, IDENTITY.md, USER.md, MEMORY.md)
Generates:
  - ~/.claude/CLAUDE.md (Claude Code)
  - ~/.config/opencode/AGENTS.md (OpenCode)

Run manually or via systemd timer after identity file changes.
"""

import sys
from pathlib import Path
from datetime import datetime

AGENTS_DIR = Path.home() / ".agents"
AGENTS_MD = AGENTS_DIR / "AGENTS.md"

# Additional identity files to compose (in order)
IDENTITY_FILES = ["SOUL.md", "IDENTITY.md", "USER.md", "MEMORY.md"]

TARGETS = {
    "claude-code": Path.home() / ".claude/CLAUDE.md",
    "opencode": Path.home() / ".config/opencode/AGENTS.md",
}

HEADER = """# Auto-generated from ~/.agents/ identity files
# Source: {source}
# Generated: {timestamp}
# DO NOT EDIT - changes will be overwritten
# Edit the source files in ~/.agents/ instead

"""


def read_identity_extras() -> str:
    """Read and compose additional identity files with section headers."""
    parts = []
    for name in IDENTITY_FILES:
        path = AGENTS_DIR / name
        if not path.exists():
            continue
        content = path.read_text().strip()
        if not content:
            continue
        header = name.replace(".md", "")
        parts.append(f"\n## {header}\n\n{content}")
    return "\n".join(parts)


def generate_config(source_content: str, extras: str, harness: str) -> str:
    """Generate harness-specific config from identity file content."""

    header = HEADER.format(
        source=AGENTS_DIR,
        timestamp=datetime.now().isoformat()
    )

    return header + source_content + extras


def main():
    if not AGENTS_MD.exists():
        print(f"ERROR: Source file not found: {AGENTS_MD}")
        sys.exit(1)

    source_content = AGENTS_MD.read_text()
    extras = read_identity_extras()

    print(f"Source: {AGENTS_DIR}")
    print(f"AGENTS.md: {len(source_content)} chars")
    print(f"Identity extras: {len(extras)} chars")
    print()

    for harness, target_path in TARGETS.items():
        # Ensure parent directory exists
        target_path.parent.mkdir(parents=True, exist_ok=True)

        # Remove symlink if it exists
        if target_path.is_symlink():
            target_path.unlink()
            print(f"  Removed symlink: {target_path}")

        # Generate config
        config_content = generate_config(source_content, extras, harness)

        # Check if content changed
        if target_path.exists():
            existing_content = target_path.read_text()
            if existing_content == config_content:
                print(f"  {harness}: unchanged")
                continue

        # Write new config
        target_path.write_text(config_content)
        print(f"  {harness}: generated → {target_path}")

    print()
    print("Done.")


if __name__ == "__main__":
    main()

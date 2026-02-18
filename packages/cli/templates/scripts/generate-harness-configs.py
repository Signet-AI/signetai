#!/usr/bin/env python3
"""
Generate harness-specific config files from AGENTS.md

Source of truth: ~/.agents/AGENTS.md
Generates:
  - ~/.claude/CLAUDE.md (Claude Code)
  - ~/.config/opencode/AGENTS.md (OpenCode)

Run manually or via systemd timer after AGENTS.md changes.
"""

import sys
from pathlib import Path
from datetime import datetime

AGENTS_MD = Path.home() / ".agents/AGENTS.md"

TARGETS = {
    "claude-code": Path.home() / ".claude/CLAUDE.md",
    "opencode": Path.home() / ".config/opencode/AGENTS.md",
}

HEADER = """# Auto-generated from ~/.agents/AGENTS.md
# Source: {source}
# Generated: {timestamp}
# DO NOT EDIT - changes will be overwritten
# Edit ~/.agents/AGENTS.md instead

"""


def generate_config(source_content: str, harness: str) -> str:
    """Generate harness-specific config from AGENTS.md content."""
    
    header = HEADER.format(
        source=AGENTS_MD,
        timestamp=datetime.now().isoformat()
    )
    
    # For now, configs are identical - but this allows harness-specific
    # transformations in the future (e.g., removing sections, adding
    # harness-specific instructions)
    
    if harness == "claude-code":
        # Claude Code uses CLAUDE.md
        return header + source_content
    
    elif harness == "opencode":
        # OpenCode uses AGENTS.md
        return header + source_content
    
    else:
        return header + source_content


def main():
    if not AGENTS_MD.exists():
        print(f"ERROR: Source file not found: {AGENTS_MD}")
        sys.exit(1)
    
    source_content = AGENTS_MD.read_text()
    source_hash = hash(source_content)
    
    print(f"Source: {AGENTS_MD}")
    print(f"Content length: {len(source_content)} chars")
    print()
    
    for harness, target_path in TARGETS.items():
        # Ensure parent directory exists
        target_path.parent.mkdir(parents=True, exist_ok=True)
        
        # Remove symlink if it exists
        if target_path.is_symlink():
            target_path.unlink()
            print(f"  Removed symlink: {target_path}")
        
        # Generate config
        config_content = generate_config(source_content, harness)
        
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

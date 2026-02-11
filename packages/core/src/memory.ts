export function parseMemory(markdown: string): Record<string, any> {
  // TODO: Parse memory markdown into structured data
  return { raw: markdown };
}

export function generateMemory(): string {
  return `# Memory

## User Profile

*No user profile configured yet.*

## Key Facts

*No facts stored yet.*

## Ongoing Context

*No ongoing context.*

<!-- MANUAL:START -->
<!-- Add your own notes here - they will be preserved -->
<!-- MANUAL:END -->
`;
}

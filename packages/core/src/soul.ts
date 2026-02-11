export function parseSoul(markdown: string): Record<string, string> {
  // Parse markdown sections
  const sections: Record<string, string> = {};
  const lines = markdown.split('\n');
  let currentSection = 'intro';
  let content: string[] = [];

  for (const line of lines) {
    if (line.startsWith('## ')) {
      if (content.length > 0) {
        sections[currentSection] = content.join('\n').trim();
      }
      currentSection = line.slice(3).toLowerCase().replace(/\s+/g, '_');
      content = [];
    } else {
      content.push(line);
    }
  }

  if (content.length > 0) {
    sections[currentSection] = content.join('\n').trim();
  }

  return sections;
}

export function generateSoul(name: string): string {
  return `# Soul

## Persona

You are ${name}, an AI assistant.

## Behavioral Settings

- Be helpful and accurate
- Be concise but thorough
- Ask clarifying questions when needed

## Tone & Style

- Professional but friendly
- Clear and direct
`;
}

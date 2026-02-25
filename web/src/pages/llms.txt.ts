import { getCollection } from 'astro:content';
import type { APIContext } from 'astro';

export const prerender = true;

export async function GET(context: APIContext) {
  const site = context.site?.toString().replace(/\/$/, '') ?? 'https://www.signetai.sh';
  const docs = await getCollection('docs');

  const lines: string[] = [
    '# SignetAI',
    '',
    '> Signet is local-first agent infrastructure. Portable memory, encrypted secrets, and identity that lives on your machine — not locked inside someone else\'s API.',
    '',
    `Full documentation: ${site}/llms-full.txt`,
    '',
    '## Pages',
    '',
    `- [Home](${site}/)`,
    '',
    '## Documentation',
    '',
  ];

  const sorted = [...docs]
    .filter((doc) => doc.data.title)
    .sort((a, b) => (a.data.order ?? 999) - (b.data.order ?? 999));

  for (const doc of sorted) {
    const slug = doc.id.replace(/\.md$/, '').toLowerCase();
    const desc = doc.data.description ? `: ${doc.data.description}` : '';
    lines.push(`- [${doc.data.title}](${site}/docs/${slug}/)${desc}`);
  }

  return new Response(lines.join('\n'), {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
    },
  });
}

import { getCollection, render } from 'astro:content';
import type { APIContext } from 'astro';

export const prerender = true;

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export async function GET(context: APIContext) {
  const site = context.site?.toString().replace(/\/$/, '') ?? 'https://www.signetai.sh';
  const docs = await getCollection('docs');

  const sorted = [...docs]
    .filter((doc) => doc.data.title)
    .sort((a, b) => (a.data.order ?? 999) - (b.data.order ?? 999));

  const sections: string[] = [
    '# SignetAI — Full Documentation',
    '',
    '> Signet is local-first agent infrastructure. Portable memory, encrypted secrets, and identity that lives on your machine — not locked inside someone else\'s API.',
    '',
    `Source: ${site}`,
    '',
    '---',
    '',
  ];

  for (const doc of sorted) {
    const slug = doc.id.replace(/\.md$/, '').toLowerCase();

    // Render the markdown to HTML, then strip to plain text
    const { Content } = await render(doc);

    // Use the raw body if available, otherwise note it
    if (doc.body) {
      sections.push(`## ${doc.data.title}`);
      sections.push(`URL: ${site}/docs/${slug}/`);
      sections.push('');
      sections.push(doc.body);
      sections.push('');
      sections.push('---');
      sections.push('');
    }
  }

  return new Response(sections.join('\n'), {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
    },
  });
}

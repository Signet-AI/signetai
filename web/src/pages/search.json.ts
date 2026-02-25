import { getCollection } from 'astro:content';
import type { APIContext } from 'astro';

export const prerender = true;

export async function GET(_context: APIContext) {
  const docs = await getCollection('docs');

  const index = docs
    .filter((doc) => doc.data.title)
    .map((doc) => {
      const slug = doc.id.replace(/\.md$/, '').toLowerCase();
      // Extract first ~300 chars of body as excerpt
      const excerpt = doc.body
        ? doc.body
            .replace(/^---[\s\S]*?---/, '')
            .replace(/^#+\s+.*/gm, '')
            .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
            .replace(/[*_`~]/g, '')
            .trim()
            .slice(0, 300)
        : '';

      return {
        title: doc.data.title,
        description: doc.data.description ?? '',
        section: doc.data.section ?? '',
        slug,
        url: `/docs/${slug}/`,
        excerpt,
      };
    });

  return new Response(JSON.stringify(index), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
    },
  });
}

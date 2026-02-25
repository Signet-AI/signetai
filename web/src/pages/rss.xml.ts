import rss from '@astrojs/rss';
import { getCollection } from 'astro:content';
import type { APIContext } from 'astro';

export const prerender = true;

export async function GET(context: APIContext) {
  const docs = await getCollection('docs');

  const items = docs
    .filter((doc) => doc.data.title && doc.id !== 'readme')
    .map((doc) => {
      const slug = doc.id.replace(/\.md$/, '').toLowerCase();
      return {
        title: doc.data.title,
        description: doc.data.description ?? `Signet documentation: ${doc.data.title}`,
        link: `/docs/${slug}/`,
        pubDate: new Date(),
      };
    });

  return rss({
    title: 'SignetAI Documentation',
    description:
      'Signet is local-first agent infrastructure. Portable memory, encrypted secrets, and identity that lives on your machine.',
    site: context.site?.toString() ?? 'https://www.signetai.sh',
    items,
    customData: '<language>en-us</language>',
  });
}

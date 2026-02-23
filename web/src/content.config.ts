import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

const docs = defineCollection({
  loader: glob({ pattern: ['**/*.md', '!wip/**'], base: '../docs' }),
  schema: z.object({
    title: z.string(),
    description: z.string().optional(),
    order: z.number().optional(),
    section: z.string().optional(),
  }),
});

export const collections = { docs };

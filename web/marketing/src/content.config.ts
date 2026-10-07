import { defineCollection, z } from "astro:content";
import { glob } from "astro/loaders";

const testimonials = defineCollection({
	loader: glob({ pattern: "**/*.mdx", base: "./src/content/testimonials" }),
	schema: z.object({
		author: z.string(),
		role: z.string().optional(),
	}),
});
const blog = defineCollection({
	loader: glob({
		pattern: import.meta.env.DEV ? "**/*.mdx" : ["**/*.mdx", "!drafts/**"],
		base: "./src/content/blog",
	}),
	schema: ({ image }) =>
		z.object({
			title: z.string(),
			description: z.string(),
			date: z.coerce.date(),
			author: z.string().default("Nicholai"),
			category: z.enum(["announcement", "engineering", "essay", "guide"]),
			coverLabel: z.string().optional(),
			banner: z.string().optional(),
			tags: z.array(z.string()).default([]),
			image: image().optional(),
			imageAlt: z.string().default(""),
			imageCover: z.boolean().default(false),
			draft: z.boolean().default(false),
		}),
});

export const collections = { testimonials, blog };

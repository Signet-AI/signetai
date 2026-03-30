import { defineCollection, z } from "astro:content";
import { glob } from "astro/loaders";

const docs = defineCollection({
	loader: glob({ pattern: ["**/*.md", "!wip/**"], base: "../docs" }),
	schema: z.object({
		title: z.string(),
		description: z.string().optional(),
		order: z.number().optional(),
		section: z.string().optional(),
		question: z.string().optional(),
		informs: z.array(z.string()).optional(),
		informed_by: z.array(z.string()).optional(),
		success_criteria: z.array(z.string()).optional(),
		scope_boundary: z.string().optional(),
		status: z.string().optional(),
	}),
});

const testimonials = defineCollection({
	loader: glob({ pattern: "**/*.mdx", base: "./src/content/testimonials" }),
	schema: z.object({
		author: z.string(),
		role: z.string().optional(),
	}),
});

const blog = defineCollection({
	loader: glob({ pattern: "**/*.mdx", base: "./src/content/blog" }),
	schema: z.object({
		title: z.string(),
		description: z.string(),
		date: z.coerce.date(),
		author: z.string().default("Nicholai"),
		tags: z.array(z.string()).default([]),
		image: z.string().optional(),
		draft: z.boolean().default(false),
	}),
});

export const collections = { docs, testimonials, blog };

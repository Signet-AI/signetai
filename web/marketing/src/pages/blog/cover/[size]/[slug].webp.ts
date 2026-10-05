import type { APIRoute, GetStaticPaths } from "astro";
import { COVER_SIZES, type CoverSize, coverStyle, getPosts, type Post } from "../../../../lib/blog";
import { renderArt } from "../../../../lib/cover-field";

export const getStaticPaths: GetStaticPaths = async () => {
	const posts = await getPosts();
	return posts.flatMap((post) =>
		(Object.keys(COVER_SIZES) as CoverSize[]).map((size) => ({
			params: { size, slug: post.id },
			props: { post, size, style: coverStyle(post, posts) },
		})),
	);
};

export const GET: APIRoute<{ post: Post; size: CoverSize; style: ReturnType<typeof coverStyle> }> = async ({
	props,
}) => {
	const [width, height] = COVER_SIZES[props.size];
	const overPage = props.size === "wide";
	const tone = overPage && props.style.tone === "paper" ? "night" : props.style.tone;
	const art = await renderArt(props.post.id, props.style.motif, tone, width, height, overPage);
	return new Response(new Uint8Array(art), { headers: { "Content-Type": "image/webp" } });
};

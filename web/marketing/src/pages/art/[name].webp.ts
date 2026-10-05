import type { APIRoute, GetStaticPaths } from "astro";
import { ART, type ArtName } from "../../lib/art";

export const getStaticPaths: GetStaticPaths = () =>
	(Object.keys(ART) as ArtName[]).map((name) => ({ params: { name }, props: { name } }));

export const GET: APIRoute<{ name: ArtName }> = async ({ props }) =>
	new Response(new Uint8Array(await ART[props.name].render()), { headers: { "Content-Type": "image/webp" } });

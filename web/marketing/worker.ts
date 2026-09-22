export default {
	async fetch(request: Request, env: { ASSETS: { fetch: (r: Request) => Promise<Response> } }): Promise<Response> {
		const url = new URL(request.url);
		const isDemo = url.pathname === "/demo" || url.pathname.startsWith("/demo/");
		if (!isDemo) return env.ASSETS.fetch(request);
		const assetUrl = new URL(url);
		const rest = url.pathname === "/demo" ? "/" : url.pathname.slice("/demo".length);
		assetUrl.pathname = `/dashboard${rest}`;
		const res = await env.ASSETS.fetch(new Request(assetUrl, request));
		const headers = new Headers(res.headers);
		headers.set("X-Frame-Options", "SAMEORIGIN");
		headers.set(
			"Content-Security-Policy",
			"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'self'",
		);
		return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
	},
};

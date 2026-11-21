import { createAdaptorServer } from "@hono/node-server";

type AdaptorServerOptions = Parameters<typeof createAdaptorServer>[0];

export type SignetHttpServerOptions = AdaptorServerOptions;

export function createSignetHttpServer(opts: SignetHttpServerOptions): ReturnType<typeof createAdaptorServer> {
	const options: AdaptorServerOptions = {
		...opts,
		overrideGlobalObjects: false,
	};
	return createAdaptorServer(options);
}

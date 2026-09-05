import { registerBunOAuthFlows } from "@earendil-works/pi-ai/bun-oauth";

/**
 * pi-ai keeps Node-only OAuth flows behind opaque dynamic imports. A compiled
 * Bun binary cannot resolve those imports from its bundle root, so the
 * daemon registers the embedded implementations
 * through this shared boundary before starting any login.
 */
export function registerSignetOAuthFlows(): void {
	registerBunOAuthFlows();
}

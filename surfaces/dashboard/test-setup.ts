// bun test cannot resolve SvelteKit virtual modules ($app/*). Mock the ones
// imported by source files under test so unit tests run under plain bun.
import { mock } from "bun:test";

mock.module("$app/environment", () => ({
	browser: false,
	building: false,
	dev: false,
	version: "test",
}));

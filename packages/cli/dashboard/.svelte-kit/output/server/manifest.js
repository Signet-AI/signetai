export const manifest = (() => {
function __memo(fn) {
	let value;
	return () => value ??= (value = fn());
}

return {
	appDir: "_app",
	appPath: "_app",
	assets: new Set(["robots.txt"]),
	mimeTypes: {".txt":"text/plain"},
	_: {
		client: {start:"_app/immutable/entry/start.C9cSSWs1.js",app:"_app/immutable/entry/app.Dx0C1Bsc.js",imports:["_app/immutable/entry/start.C9cSSWs1.js","_app/immutable/chunks/DCnRS0gU.js","_app/immutable/chunks/DOXm6QVJ.js","_app/immutable/chunks/DCYFn9U1.js","_app/immutable/entry/app.Dx0C1Bsc.js","_app/immutable/chunks/DOXm6QVJ.js","_app/immutable/chunks/QHD0JZ7V.js","_app/immutable/chunks/CejlkohN.js","_app/immutable/chunks/DCYFn9U1.js","_app/immutable/chunks/CLc--whT.js","_app/immutable/chunks/DLxKCE5P.js"],stylesheets:[],fonts:[],uses_env_dynamic_public:false},
		nodes: [
			__memo(() => import('./nodes/0.js')),
			__memo(() => import('./nodes/1.js')),
			__memo(() => import('./nodes/2.js'))
		],
		remotes: {
			
		},
		routes: [
			{
				id: "/",
				pattern: /^\/$/,
				params: [],
				page: { layouts: [0,], errors: [1,], leaf: 2 },
				endpoint: null
			},
			{
				id: "/api/config",
				pattern: /^\/api\/config\/?$/,
				params: [],
				page: null,
				endpoint: __memo(() => import('./entries/endpoints/api/config/_server.ts.js'))
			},
			{
				id: "/api/embeddings",
				pattern: /^\/api\/embeddings\/?$/,
				params: [],
				page: null,
				endpoint: __memo(() => import('./entries/endpoints/api/embeddings/_server.ts.js'))
			},
			{
				id: "/harnesses/regenerate",
				pattern: /^\/harnesses\/regenerate\/?$/,
				params: [],
				page: null,
				endpoint: __memo(() => import('./entries/endpoints/harnesses/regenerate/_server.ts.js'))
			},
			{
				id: "/memory/search",
				pattern: /^\/memory\/search\/?$/,
				params: [],
				page: null,
				endpoint: __memo(() => import('./entries/endpoints/memory/search/_server.ts.js'))
			}
		],
		prerendered_routes: new Set([]),
		matchers: async () => {
			
			return {  };
		},
		server_assets: {}
	}
}
})();

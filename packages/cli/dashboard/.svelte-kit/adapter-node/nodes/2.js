import * as server from '../entries/pages/_page.server.ts.js';

export const index = 2;
let component_cache;
export const component = async () => component_cache ??= (await import('../entries/pages/_page.svelte.js')).default;
export { server };
export const server_id = "src/routes/+page.server.ts";
export const imports = ["_app/immutable/nodes/2.SGc1XGmR.js","_app/immutable/chunks/CejlkohN.js","_app/immutable/chunks/DOXm6QVJ.js","_app/immutable/chunks/QHD0JZ7V.js","_app/immutable/chunks/CLc--whT.js","_app/immutable/chunks/DLxKCE5P.js"];
export const stylesheets = ["_app/immutable/assets/2.DVKnOaiD.css"];
export const fonts = [];

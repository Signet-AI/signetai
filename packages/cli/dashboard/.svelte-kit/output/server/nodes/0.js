

export const index = 0;
let component_cache;
export const component = async () => component_cache ??= (await import('../entries/pages/_layout.svelte.js')).default;
export const imports = ["_app/immutable/nodes/0.BQzzhc8h.js","_app/immutable/chunks/CejlkohN.js","_app/immutable/chunks/DOXm6QVJ.js","_app/immutable/chunks/DLxKCE5P.js"];
export const stylesheets = ["_app/immutable/assets/0.C5yXFBOt.css"];
export const fonts = [];

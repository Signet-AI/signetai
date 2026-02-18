
// this file is generated — do not edit it


declare module "svelte/elements" {
	export interface HTMLAttributes<T> {
		'data-sveltekit-keepfocus'?: true | '' | 'off' | undefined | null;
		'data-sveltekit-noscroll'?: true | '' | 'off' | undefined | null;
		'data-sveltekit-preload-code'?:
			| true
			| ''
			| 'eager'
			| 'viewport'
			| 'hover'
			| 'tap'
			| 'off'
			| undefined
			| null;
		'data-sveltekit-preload-data'?: true | '' | 'hover' | 'tap' | 'off' | undefined | null;
		'data-sveltekit-reload'?: true | '' | 'off' | undefined | null;
		'data-sveltekit-replacestate'?: true | '' | 'off' | undefined | null;
	}
}

export {};


declare module "$app/types" {
	export interface AppTypes {
		RouteId(): "/" | "/api" | "/api/config" | "/api/embeddings" | "/harnesses" | "/harnesses/regenerate" | "/memory" | "/memory/search" | "/memory/similar";
		RouteParams(): {
			
		};
		LayoutParams(): {
			"/": Record<string, never>;
			"/api": Record<string, never>;
			"/api/config": Record<string, never>;
			"/api/embeddings": Record<string, never>;
			"/harnesses": Record<string, never>;
			"/harnesses/regenerate": Record<string, never>;
			"/memory": Record<string, never>;
			"/memory/search": Record<string, never>;
			"/memory/similar": Record<string, never>
		};
		Pathname(): "/" | "/api/config" | "/api/embeddings" | "/harnesses/regenerate" | "/memory/search" | "/memory/similar";
		ResolvedPathname(): `${"" | `/${string}`}${ReturnType<AppTypes['Pathname']>}`;
		Asset(): "/robots.txt" | string & {};
	}
}
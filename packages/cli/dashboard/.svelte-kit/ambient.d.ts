
// this file is generated — do not edit it


/// <reference types="@sveltejs/kit" />

/**
 * Environment variables [loaded by Vite](https://vitejs.dev/guide/env-and-mode.html#env-files) from `.env` files and `process.env`. Like [`$env/dynamic/private`](https://svelte.dev/docs/kit/$env-dynamic-private), this module cannot be imported into client-side code. This module only includes variables that _do not_ begin with [`config.kit.env.publicPrefix`](https://svelte.dev/docs/kit/configuration#env) _and do_ start with [`config.kit.env.privatePrefix`](https://svelte.dev/docs/kit/configuration#env) (if configured).
 * 
 * _Unlike_ [`$env/dynamic/private`](https://svelte.dev/docs/kit/$env-dynamic-private), the values exported from this module are statically injected into your bundle at build time, enabling optimisations like dead code elimination.
 * 
 * ```ts
 * import { API_KEY } from '$env/static/private';
 * ```
 * 
 * Note that all environment variables referenced in your code should be declared (for example in an `.env` file), even if they don't have a value until the app is deployed:
 * 
 * ```
 * MY_FEATURE_FLAG=""
 * ```
 * 
 * You can override `.env` values from the command line like so:
 * 
 * ```sh
 * MY_FEATURE_FLAG="enabled" npm run dev
 * ```
 */
declare module '$env/static/private' {
	export const SHELL: string;
	export const npm_command: string;
	export const COREPACK_ENABLE_AUTO_PIN: string;
	export const COLORTERM: string;
	export const GCC_RANLIB: string;
	export const HYPRLAND_CMD: string;
	export const HISTCONTROL: string;
	export const TERM_PROGRAM_VERSION: string;
	export const WLR_NO_HARDWARE_CURSORS: string;
	export const CONDA_EXE: string;
	export const _CE_M: string;
	export const XDG_BACKEND: string;
	export const TMUX: string;
	export const build_alias: string;
	export const CMAKE_ARGS: string;
	export const HISTSIZE: string;
	export const OPENCODE_DISABLE_CLAUDE_CODE: string;
	export const NODE: string;
	export const LESS_TERMCAP_se: string;
	export const GPROF: string;
	export const LESS_TERMCAP_so: string;
	export const CONDA_TOOLCHAIN_BUILD: string;
	export const XDG_DATA_HOME: string;
	export const STRINGS: string;
	export const CPP: string;
	export const HISTTIMEFORMAT: string;
	export const XDG_CONFIG_HOME: string;
	export const TMUX_PLUGIN_MANAGER_PATH: string;
	export const npm_config_local_prefix: string;
	export const KITTY_PID: string;
	export const HL_INITIAL_WORKSPACE_TOKEN: string;
	export const XCURSOR_SIZE: string;
	export const XML_CATALOG_FILES: string;
	export const EDITOR: string;
	export const XDG_SEAT: string;
	export const PWD: string;
	export const GSETTINGS_SCHEMA_DIR: string;
	export const LOGNAME: string;
	export const QT_QPA_PLATFORMTHEME: string;
	export const XDG_SESSION_TYPE: string;
	export const CONDA_PREFIX: string;
	export const MAMBA_ROOT_PREFIX: string;
	export const GSETTINGS_SCHEMA_DIR_CONDA_BACKUP: string;
	export const CXX: string;
	export const CXXFLAGS: string;
	export const _: string;
	export const KITTY_PUBLIC_KEY: string;
	export const NoDefaultCurrentDirectoryInExePath: string;
	export const CONDA_TOOLCHAIN_HOST: string;
	export const DEBUG_CXXFLAGS: string;
	export const CLAUDECODE: string;
	export const MOTD_SHOWN: string;
	export const LDFLAGS: string;
	export const HOME: string;
	export const LANG: string;
	export const MESON_ARGS: string;
	export const _JAVA_AWT_WM_NONREPARENTING: string;
	export const LS_COLORS: string;
	export const DEBUG_CFLAGS: string;
	export const NVCC_PREPEND_FLAGS: string;
	export const XDG_CURRENT_DESKTOP: string;
	export const LDFLAGS_LD: string;
	export const npm_package_version: string;
	export const STARSHIP_SHELL: string;
	export const WAYLAND_DISPLAY: string;
	export const CXX_FOR_BUILD: string;
	export const KITTY_WINDOW_ID: string;
	export const ELFEDIT: string;
	export const CONDA_PROMPT_MODIFIER: string;
	export const CMAKE_PREFIX_PATH: string;
	export const CPPFLAGS: string;
	export const CLICOLOR: string;
	export const LD: string;
	export const CPP_FOR_BUILD: string;
	export const READELF: string;
	export const STARSHIP_SESSION_KEY: string;
	export const GXX: string;
	export const XDG_CACHE_HOME: string;
	export const npm_lifecycle_script: string;
	export const GCC_AR: string;
	export const _CONDA_EXE: string;
	export const _CONDA_ROOT: string;
	export const XDG_SESSION_CLASS: string;
	export const ADDR2LINE: string;
	export const MAMBA_EXE: string;
	export const TERMINFO: string;
	export const TERM: string;
	export const npm_package_name: string;
	export const LESS_TERMCAP_mb: string;
	export const LESS_TERMCAP_me: string;
	export const LESS_TERMCAP_md: string;
	export const _CE_CONDA: string;
	export const SIZE: string;
	export const GCC_NM: string;
	export const HOST: string;
	export const CC_FOR_BUILD: string;
	export const CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: string;
	export const USER: string;
	export const TMUX_PANE: string;
	export const CUDA_PATH: string;
	export const CONDA_SHLVL: string;
	export const AR: string;
	export const AS: string;
	export const HYPRLAND_INSTANCE_SIGNATURE: string;
	export const LINUXTOOLBOXDIR: string;
	export const VISUAL: string;
	export const DEBUG_CPPFLAGS: string;
	export const host_alias: string;
	export const DISPLAY: string;
	export const npm_lifecycle_event: string;
	export const SHLVL: string;
	export const LESS_TERMCAP_ue: string;
	export const MOZ_ENABLE_WAYLAND: string;
	export const NM: string;
	export const LESS_TERMCAP_us: string;
	export const GCC: string;
	export const GIT_EDITOR: string;
	export const XDG_VTNR: string;
	export const XDG_SESSION_ID: string;
	export const npm_config_user_agent: string;
	export const OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE: string;
	export const XDG_STATE_HOME: string;
	export const npm_execpath: string;
	export const CONDA_PYTHON_EXE: string;
	export const XDG_RUNTIME_DIR: string;
	export const CONDA_DEFAULT_ENV: string;
	export const CLAUDE_CODE_ENTRYPOINT: string;
	export const OBJCOPY: string;
	export const NVCC_CCBIN: string;
	export const DEBUGINFOD_URLS: string;
	export const npm_package_json: string;
	export const BUN_INSTALL: string;
	export const HYPRCURSOR_THEME: string;
	export const STRIP: string;
	export const NVCC_PREPEND_FLAGS_BACKUP: string;
	export const XCURSOR_THEME: string;
	export const OBJDUMP: string;
	export const PATH: string;
	export const CC: string;
	export const HISTFILESIZE: string;
	export const CFLAGS: string;
	export const CXXFILT: string;
	export const DBUS_SESSION_BUS_ADDRESS: string;
	export const BUILD: string;
	export const MAIL: string;
	export const CONDA_BUILD_CROSS_COMPILATION: string;
	export const OPENROUTER_API_KEY: string;
	export const KITTY_INSTALLATION_DIR: string;
	export const npm_node_execpath: string;
	export const RANLIB: string;
	export const CONDA_BUILD_SYSROOT: string;
	export const OLDPWD: string;
	export const HYPRCURSOR_SIZE: string;
	export const TERM_PROGRAM: string;
	export const NODE_ENV: string;
}

/**
 * Similar to [`$env/static/private`](https://svelte.dev/docs/kit/$env-static-private), except that it only includes environment variables that begin with [`config.kit.env.publicPrefix`](https://svelte.dev/docs/kit/configuration#env) (which defaults to `PUBLIC_`), and can therefore safely be exposed to client-side code.
 * 
 * Values are replaced statically at build time.
 * 
 * ```ts
 * import { PUBLIC_BASE_URL } from '$env/static/public';
 * ```
 */
declare module '$env/static/public' {
	
}

/**
 * This module provides access to runtime environment variables, as defined by the platform you're running on. For example if you're using [`adapter-node`](https://github.com/sveltejs/kit/tree/main/packages/adapter-node) (or running [`vite preview`](https://svelte.dev/docs/kit/cli)), this is equivalent to `process.env`. This module only includes variables that _do not_ begin with [`config.kit.env.publicPrefix`](https://svelte.dev/docs/kit/configuration#env) _and do_ start with [`config.kit.env.privatePrefix`](https://svelte.dev/docs/kit/configuration#env) (if configured).
 * 
 * This module cannot be imported into client-side code.
 * 
 * ```ts
 * import { env } from '$env/dynamic/private';
 * console.log(env.DEPLOYMENT_SPECIFIC_VARIABLE);
 * ```
 * 
 * > [!NOTE] In `dev`, `$env/dynamic` always includes environment variables from `.env`. In `prod`, this behavior will depend on your adapter.
 */
declare module '$env/dynamic/private' {
	export const env: {
		SHELL: string;
		npm_command: string;
		COREPACK_ENABLE_AUTO_PIN: string;
		COLORTERM: string;
		GCC_RANLIB: string;
		HYPRLAND_CMD: string;
		HISTCONTROL: string;
		TERM_PROGRAM_VERSION: string;
		WLR_NO_HARDWARE_CURSORS: string;
		CONDA_EXE: string;
		_CE_M: string;
		XDG_BACKEND: string;
		TMUX: string;
		build_alias: string;
		CMAKE_ARGS: string;
		HISTSIZE: string;
		OPENCODE_DISABLE_CLAUDE_CODE: string;
		NODE: string;
		LESS_TERMCAP_se: string;
		GPROF: string;
		LESS_TERMCAP_so: string;
		CONDA_TOOLCHAIN_BUILD: string;
		XDG_DATA_HOME: string;
		STRINGS: string;
		CPP: string;
		HISTTIMEFORMAT: string;
		XDG_CONFIG_HOME: string;
		TMUX_PLUGIN_MANAGER_PATH: string;
		npm_config_local_prefix: string;
		KITTY_PID: string;
		HL_INITIAL_WORKSPACE_TOKEN: string;
		XCURSOR_SIZE: string;
		XML_CATALOG_FILES: string;
		EDITOR: string;
		XDG_SEAT: string;
		PWD: string;
		GSETTINGS_SCHEMA_DIR: string;
		LOGNAME: string;
		QT_QPA_PLATFORMTHEME: string;
		XDG_SESSION_TYPE: string;
		CONDA_PREFIX: string;
		MAMBA_ROOT_PREFIX: string;
		GSETTINGS_SCHEMA_DIR_CONDA_BACKUP: string;
		CXX: string;
		CXXFLAGS: string;
		_: string;
		KITTY_PUBLIC_KEY: string;
		NoDefaultCurrentDirectoryInExePath: string;
		CONDA_TOOLCHAIN_HOST: string;
		DEBUG_CXXFLAGS: string;
		CLAUDECODE: string;
		MOTD_SHOWN: string;
		LDFLAGS: string;
		HOME: string;
		LANG: string;
		MESON_ARGS: string;
		_JAVA_AWT_WM_NONREPARENTING: string;
		LS_COLORS: string;
		DEBUG_CFLAGS: string;
		NVCC_PREPEND_FLAGS: string;
		XDG_CURRENT_DESKTOP: string;
		LDFLAGS_LD: string;
		npm_package_version: string;
		STARSHIP_SHELL: string;
		WAYLAND_DISPLAY: string;
		CXX_FOR_BUILD: string;
		KITTY_WINDOW_ID: string;
		ELFEDIT: string;
		CONDA_PROMPT_MODIFIER: string;
		CMAKE_PREFIX_PATH: string;
		CPPFLAGS: string;
		CLICOLOR: string;
		LD: string;
		CPP_FOR_BUILD: string;
		READELF: string;
		STARSHIP_SESSION_KEY: string;
		GXX: string;
		XDG_CACHE_HOME: string;
		npm_lifecycle_script: string;
		GCC_AR: string;
		_CONDA_EXE: string;
		_CONDA_ROOT: string;
		XDG_SESSION_CLASS: string;
		ADDR2LINE: string;
		MAMBA_EXE: string;
		TERMINFO: string;
		TERM: string;
		npm_package_name: string;
		LESS_TERMCAP_mb: string;
		LESS_TERMCAP_me: string;
		LESS_TERMCAP_md: string;
		_CE_CONDA: string;
		SIZE: string;
		GCC_NM: string;
		HOST: string;
		CC_FOR_BUILD: string;
		CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: string;
		USER: string;
		TMUX_PANE: string;
		CUDA_PATH: string;
		CONDA_SHLVL: string;
		AR: string;
		AS: string;
		HYPRLAND_INSTANCE_SIGNATURE: string;
		LINUXTOOLBOXDIR: string;
		VISUAL: string;
		DEBUG_CPPFLAGS: string;
		host_alias: string;
		DISPLAY: string;
		npm_lifecycle_event: string;
		SHLVL: string;
		LESS_TERMCAP_ue: string;
		MOZ_ENABLE_WAYLAND: string;
		NM: string;
		LESS_TERMCAP_us: string;
		GCC: string;
		GIT_EDITOR: string;
		XDG_VTNR: string;
		XDG_SESSION_ID: string;
		npm_config_user_agent: string;
		OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE: string;
		XDG_STATE_HOME: string;
		npm_execpath: string;
		CONDA_PYTHON_EXE: string;
		XDG_RUNTIME_DIR: string;
		CONDA_DEFAULT_ENV: string;
		CLAUDE_CODE_ENTRYPOINT: string;
		OBJCOPY: string;
		NVCC_CCBIN: string;
		DEBUGINFOD_URLS: string;
		npm_package_json: string;
		BUN_INSTALL: string;
		HYPRCURSOR_THEME: string;
		STRIP: string;
		NVCC_PREPEND_FLAGS_BACKUP: string;
		XCURSOR_THEME: string;
		OBJDUMP: string;
		PATH: string;
		CC: string;
		HISTFILESIZE: string;
		CFLAGS: string;
		CXXFILT: string;
		DBUS_SESSION_BUS_ADDRESS: string;
		BUILD: string;
		MAIL: string;
		CONDA_BUILD_CROSS_COMPILATION: string;
		OPENROUTER_API_KEY: string;
		KITTY_INSTALLATION_DIR: string;
		npm_node_execpath: string;
		RANLIB: string;
		CONDA_BUILD_SYSROOT: string;
		OLDPWD: string;
		HYPRCURSOR_SIZE: string;
		TERM_PROGRAM: string;
		NODE_ENV: string;
		[key: `PUBLIC_${string}`]: undefined;
		[key: `${string}`]: string | undefined;
	}
}

/**
 * Similar to [`$env/dynamic/private`](https://svelte.dev/docs/kit/$env-dynamic-private), but only includes variables that begin with [`config.kit.env.publicPrefix`](https://svelte.dev/docs/kit/configuration#env) (which defaults to `PUBLIC_`), and can therefore safely be exposed to client-side code.
 * 
 * Note that public dynamic environment variables must all be sent from the server to the client, causing larger network requests — when possible, use `$env/static/public` instead.
 * 
 * ```ts
 * import { env } from '$env/dynamic/public';
 * console.log(env.PUBLIC_DEPLOYMENT_SPECIFIC_VARIABLE);
 * ```
 */
declare module '$env/dynamic/public' {
	export const env: {
		[key: `PUBLIC_${string}`]: string | undefined;
	}
}

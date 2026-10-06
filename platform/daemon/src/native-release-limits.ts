// Size limits the native updater accepts. The release manifest check imports
// these so a release the updater would reject cannot be published.
export const NATIVE_MANIFEST_MAX_BYTES = 1024 * 1024;
export const NATIVE_BINARY_MAX_BYTES = 512 * 1024 * 1024;
export const NATIVE_CONNECTORS_MAX_BYTES = 64 * 1024 * 1024;
export const NATIVE_DAEMON_JS_MAX_BYTES = 128 * 1024 * 1024;

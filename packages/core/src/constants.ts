import { homedir } from "os";
import { join } from "path";

export const DEFAULT_BASE_PATH = join(homedir(), ".agents");
export const SCHEMA_VERSION = 3;
export const SPEC_VERSION = "1.0";
export const SCHEMA_ID = "signet/v1";

export const DEFAULT_EMBEDDING_DIMENSIONS = 768;
export const DEFAULT_HYBRID_ALPHA = 0.7;
export const DEFAULT_REPLAY_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

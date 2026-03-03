/**
 * Bundled transformers runtime entry.
 *
 * Why this exists:
 * - `native-embedding.ts` uses lazy dynamic loading.
 * - Importing this local module gives the bundler a stable entry for
 *   transformers and keeps our loader logic decoupled from package shape.
 */

export { env, pipeline } from "@huggingface/transformers";

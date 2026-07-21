/**
 * Edge-normalizer barrel (#913). Importing this module registers the zero-dep
 * normalizers (markdown, html, json; plain is registered in envelope.ts) into
 * the envelope registry as a side effect. Any caller that wants
 * `normalizeSource` to dispatch to the rich formats must import this barrel (or
 * the ingest barrel that re-exports it) before normalizing.
 *
 * Keeping the registrations behind a barrel avoids a circular import between
 * envelope.ts (which owns the registry + the plain normalizer) and the format
 * modules (which import the registry from envelope). Leaf modules import from
 * envelope; this barrel imports the leaves — one direction, no cycle.
 */

import "./markdown";
import "./html";
import "./json";

export { markdownNormalizer } from "./markdown";
export { htmlNormalizer } from "./html";
export { jsonNormalizer } from "./json";

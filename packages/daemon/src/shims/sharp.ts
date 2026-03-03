// Shim for sharp — we only use text embeddings, not image processing.
// @huggingface/transformers has a top-level `import sharp from 'sharp'`
// that crashes in bundled installs. This shim provides a falsy default
// so the `else if (sharp)` branch in transformers is skipped.
export default undefined;

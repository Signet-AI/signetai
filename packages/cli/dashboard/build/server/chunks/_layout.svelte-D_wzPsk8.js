function _layout($$renderer, $$props) {
  let { children } = $$props;
  children($$renderer);
  $$renderer.push(`<!---->`);
}

export { _layout as default };
//# sourceMappingURL=_layout.svelte-D_wzPsk8.js.map

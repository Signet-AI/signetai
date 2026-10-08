# Signet Documentation Design Constraints

Use these rules when you add, change, or refactor a page. Show the smallest complete version of the information.

Remove an element when spacing, order, plain text, or standard HTML can do the same work.

## Content

- State what Signet is in one sentence.
- Use short, factual statements. Put one idea in each paragraph or list item.
- Prefer a list to a group of feature sections.
- Use direct verbs such as "is," "uses," "writes," and "builds."
- Keep evidence close to its claim. Do not repeat a claim in the introduction, list, and footer.
- Keep navigation explicit. The sidebar is configured in `astro.config.mjs`.
- Describe current Signet behavior. Mark planned, legacy, compatibility, and vision material clearly.
- Do not invent a more polished product, feature set, or content system than the docs actually provide.

## Visual Language

- Use near-black text and backgrounds with warm off-white text and backgrounds in the light theme, or the dark-mode equivalent.
- Use IBM Plex Sans for body text. Use IBM Plex Mono for headings, navigation, code, field names, and diagrams. Use the Signet logo and wordmark as the main brand elements.
- Use whitespace and standard HTML elements to separate ideas.
- Do not add cards, panels, badges, decorative rules, gradients, shadows, or ornamental backgrounds unless they show real structure or state.
- Use thin borders and compact controls where the existing Starlight layout needs them.
- Use the Signet blue accent for selection and active navigation. Do not introduce unrelated colors.
- Use monochrome syntax highlighting. Keep code readable in both themes.
- Set code blocks in the primary typeface, one step smaller than prose.
- Mark inline code with a faint background and thin border. Do not add hue or heavy rounding.
- Keep article heading sizes distinct from bold body text.
- Use an opaque navigation header. Do not add backdrop blur or translucent navigation treatment without changing the site design deliberately.

## Layout

- Use the Starlight frame for the wordmark, content, sidebar, right-hand outline, and pagination.
- Keep the normal documentation content inside the existing `50rem` content width.
- Keep the sidebar inside the existing `21.5rem` width.
- Keep the site-chrome frame stable across routes so that navigation does not move.
- Preserve the existing wide reading layout. Do not replace it with a centered landing-page column.
- Do not use absolute viewport coordinates for page structure.
- Do not add a horizontal offset to an element that uses the full available width.
- Let code blocks and tables use more width only when their content needs it.
- Put overflow for wide code and tables in their containers, not on the page.

## Responsive Behavior

- Keep the reading measure usable at every viewport width.
- Keep the sidebar, header, search control, tables, and code blocks usable on narrow screens.
- Do not use a compressed desktop layout for tablet widths.
- Do not stack menus or allow horizontal page overflow.
- Use the responsive behavior provided by Starlight before adding custom breakpoint rules.
- Test closed and open navigation at `390px`, `768px`, `1025px`, and `1440px`.
- Also test immediately below and above each layout breakpoint when changing layout CSS.

## Motion And Interaction

- Use motion only to explain a layout or state change. Keep it fast, linear, and mechanical.
- Do not add fades, scaling, bounce, blur, or decorative easing to documentation content.
- Exception: a page may open with one interactive `HairlineFigure` from `@lucasmarkes/hairline`. Its rest pose must read as a still illustration, and it must honor `prefers-reduced-motion`.
- Remove nonessential transitions for `prefers-reduced-motion`.
- Support pointer and keyboard input. Keep keyboard focus visible.
- Keep native browser behavior unless custom behavior gives clear value.
- Do not add unnecessary controls, icons, or instructions.

## Implementation

- Build shared page primitives from these rules. Do not copy landing-page CSS into individual routes.
- Keep shared article styles in `src/styles/custom.css`.
- Use design tokens only for repeated width, spacing, type, color, and motion values.
- Keep the token set small. Each token must represent a design decision, not an isolated value.
- Use semantic HTML before a custom component.
- Keep layout rules in CSS. Do not duplicate breakpoint rules in scripts.
- Use content data only when pages share a real structure.
- Remove old styles when a shared rule replaces them.
- Do not keep compatibility styles without a current consumer.
- Preserve accessible names, focus order, contrast, and reduced-motion behavior during visual changes.
- Do not rewrite the rendered DOM with scripts. `HairlineFigure` draws only inside its own mount element.

## Documentation Pages

Documentation can be dense, but it must use the same restrained design language.

- Keep navigation, search, code, tables, callouts, and hierarchy when they help the user complete a task.
- Prefer one content flow to a dashboard layout. Use borders only to show structure or state.
- Use callouts only for information that needs special attention.
- Do not force reference material into a short-list format.
- Let prose follow the existing documentation reading measure inside the wider Starlight column.
- Put overflow for wide code and tables in their containers, not on the page.
- Use the text color and the existing blue active indicator to mark the current navigation item.
- Show the `On this page` outline beside the frame when Starlight provides space for it.
- Preserve Starlight's responsive navigation and outline behavior instead of replacing it with custom disclosure systems.
- End each page with previous and next links when the page belongs to a navigable section.
- Draw request flows with `SequenceDiagram`. It renders static SVG at build time and inherits the typeface and both themes. For other structure, prefer monospace box-drawing diagrams in code blocks to images.
- Show product UI with `Screenshot`, captured in both themes from a throwaway daemon.
- Document request, response, and parameter fields with `Fields`, not wide tables. Keep tables for short, uniform rows such as error codes.
- Keep generated pages generated. If a page says it is generated from a root document, edit the root document and run the existing sync script.

## Exceptions

Accessibility, comprehension, and task completion take priority over visual minimalism.

Add an element if its removal makes content unclear, hides state, harms navigation, or blocks access. Use the least visual treatment that solves the problem.

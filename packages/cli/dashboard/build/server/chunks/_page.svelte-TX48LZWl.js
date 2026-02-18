import { a5 as head, c as escape_html, a6 as ensure_array_like, a7 as attr_class, a8 as attr, a9 as attr_style } from './index-CPDeKruo.js';
import 'umap-js';

function _page($$renderer, $$props) {
  $$renderer.component(($$renderer2) => {
    let { data } = $$props;
    let activeTab = "config";
    let selectedFile = "";
    let editorContent = "";
    let saving = false;
    function ext(name) {
      return name.split(".").pop() ?? "";
    }
    function fmtSize(bytes) {
      if (bytes < 1024) return `${bytes} B`;
      return `${(bytes / 1024).toFixed(1)} KB`;
    }
    let memoryQuery = "";
    let displayMemories = data.memories ?? [];
    function formatDate(dateStr) {
      try {
        const date = new Date(dateStr);
        return date.toLocaleString("en-US", {
          month: "short",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit"
        });
      } catch {
        return dateStr;
      }
    }
    head("1uha8ag", $$renderer2, ($$renderer3) => {
      $$renderer3.title(($$renderer4) => {
        $$renderer4.push(`<title>Signet Dashboard</title>`);
      });
    });
    $$renderer2.push(`<div class="dashboard svelte-1uha8ag"><header class="header svelte-1uha8ag"><div class="header-left svelte-1uha8ag"><svg class="logo-icon svelte-1uha8ag" width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M8 1L14.5 8L8 15L1.5 8Z" stroke="currentColor" stroke-width="1.1"></path><circle cx="8" cy="8" r="1.8" fill="currentColor"></circle></svg> <span class="logo-text svelte-1uha8ag">signet</span></div> <button class="theme-btn svelte-1uha8ag" aria-label="Toggle theme">`);
    {
      $$renderer2.push("<!--[-->");
      $$renderer2.push(`<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"><circle cx="8" cy="8" r="3.5"></circle><line x1="8" y1="1" x2="8" y2="3"></line><line x1="8" y1="13" x2="8" y2="15"></line><line x1="1" y1="8" x2="3" y2="8"></line><line x1="13" y1="8" x2="15" y2="8"></line><line x1="3.05" y1="3.05" x2="4.46" y2="4.46"></line><line x1="11.54" y1="11.54" x2="12.95" y2="12.95"></line><line x1="3.05" y1="12.95" x2="4.46" y2="11.54"></line><line x1="11.54" y1="4.46" x2="12.95" y2="3.05"></line></svg>`);
    }
    $$renderer2.push(`<!--]--></button></header> <div class="body svelte-1uha8ag"><aside class="left-sidebar svelte-1uha8ag"><div class="sidebar-group-title svelte-1uha8ag">Agent</div> <div class="sidebar-label svelte-1uha8ag">Identity</div> <div class="info-list svelte-1uha8ag"><div class="info-item svelte-1uha8ag"><span class="info-label svelte-1uha8ag">name</span> <span class="info-value svelte-1uha8ag">${escape_html(data.identity?.name ?? "Unknown")}</span></div> <div class="info-item svelte-1uha8ag"><span class="info-label svelte-1uha8ag">creature</span> <span class="info-value svelte-1uha8ag">${escape_html(data.identity?.creature ?? "—")}</span></div> <div class="info-item svelte-1uha8ag"><span class="info-label svelte-1uha8ag">memories</span> <span class="info-value accent svelte-1uha8ag">${escape_html(data.memoryStats?.total ?? 0)}</span></div></div> <div class="sidebar-label svelte-1uha8ag">Harnesses</div> <div class="info-list svelte-1uha8ag"><!--[-->`);
    const each_array = ensure_array_like(data.harnesses ?? []);
    for (let $$index = 0, $$length = each_array.length; $$index < $$length; $$index++) {
      let harness = each_array[$$index];
      $$renderer2.push(`<div class="info-item svelte-1uha8ag">`);
      if (harness.exists) {
        $$renderer2.push("<!--[-->");
        $$renderer2.push(`<svg class="status-icon good svelte-1uha8ag" width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 7.5 5.5 10 11 4"></polyline></svg>`);
      } else {
        $$renderer2.push("<!--[!-->");
        $$renderer2.push(`<svg class="status-icon faded svelte-1uha8ag" width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="7" cy="7" r="5"></circle></svg>`);
      }
      $$renderer2.push(`<!--]--> <span class="info-value svelte-1uha8ag">${escape_html(harness.name)}</span></div>`);
    }
    $$renderer2.push(`<!--]--></div> <div class="sidebar-label svelte-1uha8ag">Config Files</div> <div class="file-list svelte-1uha8ag"><!--[-->`);
    const each_array_1 = ensure_array_like(data.configFiles ?? []);
    for (let $$index_1 = 0, $$length = each_array_1.length; $$index_1 < $$length; $$index_1++) {
      let file = each_array_1[$$index_1];
      const active = selectedFile === file.name;
      $$renderer2.push(`<button${attr_class("file-item svelte-1uha8ag", void 0, { "active": active })}><svg class="file-icon svelte-1uha8ag" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2">`);
      if (ext(file.name) === "yaml" || ext(file.name) === "yml") {
        $$renderer2.push("<!--[-->");
        $$renderer2.push(`<rect x="2" y="1" width="12" height="14" rx="1.5"></rect><line x1="5" y1="5" x2="11" y2="5"></line><line x1="5" y1="8" x2="9" y2="8"></line><line x1="5" y1="11" x2="11" y2="11"></line>`);
      } else {
        $$renderer2.push("<!--[!-->");
        $$renderer2.push(`<path d="M3 1.5h7l3 3v10a1 1 0 01-1 1H3a1 1 0 01-1-1v-13a1 1 0 011-1z"></path><path d="M10 1.5v3h3"></path>`);
      }
      $$renderer2.push(`<!--]--></svg> <span class="file-name svelte-1uha8ag">${escape_html(file.name)}</span> <span class="file-size svelte-1uha8ag">${escape_html(fmtSize(file.size))}</span></button>`);
    }
    $$renderer2.push(`<!--]--></div></aside> <div class="center-panel svelte-1uha8ag"><div class="tab-bar svelte-1uha8ag"><button${attr_class("tab svelte-1uha8ag", void 0, { "active": activeTab === "config" })}><svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2"><path d="M3 1.5h7l3 3v10a1 1 0 01-1 1H3a1 1 0 01-1-1v-13a1 1 0 011-1z"></path><path d="M10 1.5v3h3"></path></svg> <span>Config</span></button> <button${attr_class("tab svelte-1uha8ag", void 0, { "active": activeTab === "embeddings" })}><svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2"><circle cx="4" cy="5" r="1.5"></circle><circle cx="11" cy="4" r="1.5"></circle><circle cx="7" cy="10" r="1.5"></circle><circle cx="13" cy="11" r="1.5"></circle><line x1="5.2" y1="5.8" x2="5.8" y2="9" opacity="0.4"></line><line x1="8.5" y1="10" x2="11.5" y2="11" opacity="0.4"></line><line x1="9.5" y1="4.5" x2="8.2" y2="8.8" opacity="0.4"></line></svg> <span>Embeddings</span></button> <div class="tab-spacer svelte-1uha8ag"></div> `);
    {
      $$renderer2.push("<!--[-->");
      $$renderer2.push(`<div class="tab-title svelte-1uha8ag">${escape_html(selectedFile)}</div> <div class="tab-actions svelte-1uha8ag">`);
      {
        $$renderer2.push("<!--[!-->");
      }
      $$renderer2.push(`<!--]--> <button${attr("disabled", saving, true)} class="action-btn svelte-1uha8ag">${escape_html("Save")}</button></div>`);
    }
    $$renderer2.push(`<!--]--></div> <div class="panel-content svelte-1uha8ag"${attr_style("", {
      visibility: "visible",
      position: "relative",
      inset: "auto"
    })}><textarea class="editor-textarea svelte-1uha8ag" spellcheck="false" placeholder="Empty file...">`);
    const $$body = escape_html(editorContent);
    if ($$body) {
      $$renderer2.push(`${$$body}`);
    }
    $$renderer2.push(`</textarea></div> <div class="panel-content svelte-1uha8ag"${attr_style("", {
      visibility: "hidden",
      position: "absolute",
      inset: "0"
    })}><div class="canvas-area svelte-1uha8ag">`);
    {
      $$renderer2.push("<!--[3-->");
      $$renderer2.push(`<div class="loading-overlay svelte-1uha8ag"><p>Switch to this tab to load the graph</p></div>`);
    }
    $$renderer2.push(`<!--]--> <canvas class="graph-canvas svelte-1uha8ag" style="cursor: grab;"></canvas></div></div> <div class="status-bar svelte-1uha8ag">`);
    {
      $$renderer2.push("<!--[-->");
      $$renderer2.push(`<span>${escape_html(ext(selectedFile).toUpperCase())} · UTF-8</span> <span class="status-right svelte-1uha8ag"><kbd class="svelte-1uha8ag">Ctrl+S</kbd> save</span>`);
    }
    $$renderer2.push(`<!--]--></div></div> <aside class="right-sidebar svelte-1uha8ag"><div class="sidebar-group-title svelte-1uha8ag"><span>Memories</span> <span class="memory-count svelte-1uha8ag">${escape_html(data.memoryStats?.total ?? 0)}</span></div> <div class="memory-search-box svelte-1uha8ag"><input type="text"${attr("value", memoryQuery)} placeholder="Search memories..." class="memory-search-input svelte-1uha8ag"/> `);
    {
      $$renderer2.push("<!--[!-->");
    }
    $$renderer2.push(`<!--]--></div> `);
    {
      $$renderer2.push("<!--[!-->");
    }
    $$renderer2.push(`<!--]--> <div class="memory-list svelte-1uha8ag">`);
    const each_array_2 = ensure_array_like(displayMemories);
    if (each_array_2.length !== 0) {
      $$renderer2.push("<!--[-->");
      for (let $$index_2 = 0, $$length = each_array_2.length; $$index_2 < $$length; $$index_2++) {
        let memory = each_array_2[$$index_2];
        $$renderer2.push(`<div class="memory-card svelte-1uha8ag"><p class="memory-text svelte-1uha8ag">${escape_html(memory.content)}</p> <div class="memory-meta svelte-1uha8ag"><span class="memory-who svelte-1uha8ag">${escape_html(memory.who)}</span> `);
        if (memory.importance && memory.importance >= 0.9) {
          $$renderer2.push("<!--[-->");
          $$renderer2.push(`<span class="memory-badge svelte-1uha8ag">critical</span>`);
        } else {
          $$renderer2.push("<!--[!-->");
        }
        $$renderer2.push(`<!--]--> <span class="memory-date svelte-1uha8ag">${escape_html(formatDate(memory.created_at))}</span></div></div>`);
      }
    } else {
      $$renderer2.push("<!--[!-->");
      $$renderer2.push(`<div class="empty-state svelte-1uha8ag">${escape_html("No memories yet")}</div>`);
    }
    $$renderer2.push(`<!--]--></div></aside></div></div>`);
  });
}

export { _page as default };
//# sourceMappingURL=_page.svelte-TX48LZWl.js.map

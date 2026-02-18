<script lang="ts">
  import { tick } from 'svelte';
  import { browser } from '$app/environment';
  import { UMAP } from 'umap-js';
  import {
    forceSimulation,
    forceLink,
    forceManyBody,
    forceCenter,
    forceCollide
  } from 'd3-force';

  let { data } = $props();

  // --- Theme ---
  let theme = $state<'dark' | 'light'>('dark');

  if (browser) {
    const stored = document.documentElement.dataset.theme;
    theme = (stored === 'light' || stored === 'dark') ? stored : 'dark';
  }

  function toggleTheme() {
    theme = theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('signet-theme', theme);
  }

  // --- Tabs ---
  let activeTab = $state<'config' | 'embeddings'>('config');

  // --- Config editor ---
  let selectedFile = $state('');
  let editorContent = $state('');
  let saving = $state(false);
  let saved = $state(false);

  $effect(() => {
    if (!selectedFile && data.configFiles?.length) {
      selectedFile = data.configFiles[0].name;
    }
  });

  $effect(() => {
    const file = data.configFiles?.find(
      (f: any) => f.name === selectedFile
    );
    editorContent = file?.content ?? '';
    saved = false;
  });

  function selectFile(name: string) {
    selectedFile = name;
    activeTab = 'config';
  }

  function ext(name: string): string {
    return name.split('.').pop() ?? '';
  }

  function fmtSize(bytes: number): string {
    if (bytes < 1024) return `${bytes}B`;
    return `${(bytes / 1024).toFixed(1)}KB`;
  }

  async function saveFile() {
    saving = true;
    saved = false;
    try {
      const res = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          file: selectedFile,
          content: editorContent,
        }),
      });
      if (res.ok) {
        saved = true;
        setTimeout(() => (saved = false), 2000);
      }
    } finally {
      saving = false;
    }
  }

  function handleKeydown(e: KeyboardEvent) {
    if ((e.metaKey || e.ctrlKey) && e.key === 's') {
      e.preventDefault();
      saveFile();
    }
  }

  // --- Embeddings graph ---
  let canvas = $state<HTMLCanvasElement | null>(null);
  let graphSelected = $state<any>(null);
  let graphHovered = $state<any>(null);
  let graphStatus = $state('');
  let graphError = $state('');
  let embeddings = $state<any[]>([]);
  let graphInitialized = $state(false);

  const sourceColors: Record<string, string> = {
    'claude-code': '#5eada4',
    'clawdbot': '#a78bfa',
    'openclaw': '#4ade80',
    'opencode': '#60a5fa',
    'manual': '#f472b6',
    'unknown': '#737373',
  };

  interface GraphNode {
    index?: number;
    x: number;
    y: number;
    vx?: number;
    vy?: number;
    fx?: number | null;
    fy?: number | null;
    radius: number;
    color: string;
    data: any;
  }

  interface GraphEdge {
    source: GraphNode | number;
    target: GraphNode | number;
  }

  let camX = 0, camY = 0, camZoom = 1;
  let isPanning = false, isDragging = false;
  let dragNode: GraphNode | null = null;
  let panStartX = 0, panStartY = 0;
  let panCamStartX = 0, panCamStartY = 0;

  let nodes = $state<GraphNode[]>([]);
  let edges = $state<GraphEdge[]>([]);
  let simulation: any = null;
  let animFrame = 0;
  let glowPhase = 0;

  function hexToRgb(hex: string): [number, number, number] {
    const v = parseInt(hex.slice(1), 16);
    return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
  }

  function buildKnnEdges(
    projected: number[][], k: number
  ): [number, number][] {
    const edgeSet = new Set<string>();
    const result: [number, number][] = [];
    for (let i = 0; i < projected.length; i++) {
      const dists: { j: number; d: number }[] = [];
      for (let j = 0; j < projected.length; j++) {
        if (i === j) continue;
        const dx = projected[i][0] - projected[j][0];
        const dy = projected[i][1] - projected[j][1];
        dists.push({ j, d: dx * dx + dy * dy });
      }
      dists.sort((a, b) => a.d - b.d);
      for (let n = 0; n < Math.min(k, dists.length); n++) {
        const a = Math.min(i, dists[n].j);
        const b = Math.max(i, dists[n].j);
        const key = `${a}-${b}`;
        if (!edgeSet.has(key)) {
          edgeSet.add(key);
          result.push([a, b]);
        }
      }
    }
    return result;
  }

  function screenToWorld(sx: number, sy: number): [number, number] {
    const rect = canvas!.getBoundingClientRect();
    const cx = rect.width / 2;
    const cy = rect.height / 2;
    return [
      (sx - rect.left - cx) / camZoom + camX,
      (sy - rect.top - cy) / camZoom + camY,
    ];
  }

  function findNodeAt(wx: number, wy: number): GraphNode | null {
    for (let i = nodes.length - 1; i >= 0; i--) {
      const n = nodes[i];
      const dx = n.x - wx, dy = n.y - wy;
      const hitR = n.radius + 4;
      if (dx * dx + dy * dy <= hitR * hitR) return n;
    }
    return null;
  }

  function draw(ctx: CanvasRenderingContext2D) {
    const w = canvas!.width, h = canvas!.height;
    ctx.clearRect(0, 0, w, h);
    ctx.save();
    ctx.translate(w / 2, h / 2);
    ctx.scale(camZoom, camZoom);
    ctx.translate(-camX, -camY);

    for (const edge of edges) {
      const s = edge.source as GraphNode;
      const t = edge.target as GraphNode;
      const [sr, sg, sb] = hexToRgb(s.color);
      const [tr, tg, tb] = hexToRgb(t.color);
      ctx.beginPath();
      ctx.moveTo(s.x, s.y);
      ctx.lineTo(t.x, t.y);
      ctx.strokeStyle = `rgba(${(sr+tr)>>1},${(sg+tg)>>1},${(sb+tb)>>1},0.08)`;
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    glowPhase += 0.015;
    const pulse = 0.6 + 0.4 * Math.sin(glowPhase);

    for (const node of nodes) {
      const [r, g, b] = hexToRgb(node.color);
      const glowR = node.radius * (2.5 + 0.5 * pulse);
      const grad = ctx.createRadialGradient(
        node.x, node.y, node.radius * 0.5,
        node.x, node.y, glowR
      );
      grad.addColorStop(0, `rgba(${r},${g},${b},${0.2 * pulse})`);
      grad.addColorStop(1, `rgba(${r},${g},${b},0)`);
      ctx.beginPath();
      ctx.arc(node.x, node.y, glowR, 0, Math.PI * 2);
      ctx.fillStyle = grad;
      ctx.fill();

      ctx.beginPath();
      ctx.arc(node.x, node.y, node.radius, 0, Math.PI * 2);
      ctx.fillStyle = node.color;
      ctx.fill();

      if (graphSelected && node.data === graphSelected) {
        ctx.beginPath();
        ctx.arc(node.x, node.y, node.radius + 3, 0, Math.PI * 2);
        ctx.strokeStyle = '#5eada4';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
    }

    if (graphHovered) {
      const node = nodes.find(n => n.data === graphHovered);
      if (node) {
        const text = (graphHovered.text || '').slice(0, 60)
          + (graphHovered.text?.length > 60 ? '...' : '');
        ctx.font = `${10 / camZoom}px var(--font-mono)`;
        const metrics = ctx.measureText(text);
        const pad = 4 / camZoom;
        const bx = node.x - metrics.width / 2 - pad;
        const by = node.y - node.radius - 18 / camZoom;
        ctx.fillStyle = 'rgba(15, 15, 15, 0.9)';
        ctx.beginPath();
        ctx.roundRect(
          bx, by - 10 / camZoom,
          metrics.width + pad * 2, 14 / camZoom,
          3 / camZoom
        );
        ctx.fill();
        ctx.fillStyle = '#d4d4d4';
        ctx.textAlign = 'center';
        ctx.fillText(text, node.x, by);
        ctx.textAlign = 'start';
      }
    }

    ctx.restore();

    // Minimal legend
    const legendSources = Object.entries(sourceColors).filter(
      ([k]) => k !== 'unknown'
    );
    const lx = 12;
    let ly = h - 12 - legendSources.length * 16;
    ctx.font = '10px var(--font-mono)';
    for (const [name, color] of legendSources) {
      ctx.beginPath();
      ctx.arc(lx + 3, ly, 3, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.4)';
      ctx.fillText(name, lx + 12, ly + 3);
      ly += 16;
    }

    animFrame = requestAnimationFrame(() => draw(ctx));
  }

  function setupInteractions() {
    if (!canvas) return;

    canvas.addEventListener('pointerdown', (e) => {
      const [wx, wy] = screenToWorld(e.clientX, e.clientY);
      const node = findNodeAt(wx, wy);
      if (node) {
        isDragging = true;
        dragNode = node;
        node.fx = node.x;
        node.fy = node.y;
        simulation?.alphaTarget(0.3).restart();
      } else {
        isPanning = true;
        panStartX = e.clientX;
        panStartY = e.clientY;
        panCamStartX = camX;
        panCamStartY = camY;
      }
    });

    canvas.addEventListener('pointermove', (e) => {
      if (isDragging && dragNode) {
        const [wx, wy] = screenToWorld(e.clientX, e.clientY);
        dragNode.fx = wx;
        dragNode.fy = wy;
        return;
      }
      if (isPanning) {
        camX = panCamStartX - (e.clientX - panStartX) / camZoom;
        camY = panCamStartY - (e.clientY - panStartY) / camZoom;
        return;
      }
      const [wx, wy] = screenToWorld(e.clientX, e.clientY);
      const node = findNodeAt(wx, wy);
      graphHovered = node?.data || null;
      canvas!.style.cursor = node ? 'pointer' : 'grab';
    });

    const pointerUp = () => {
      if (isDragging && dragNode) {
        dragNode.fx = null;
        dragNode.fy = null;
        simulation?.alphaTarget(0);
        dragNode = null;
        isDragging = false;
        return;
      }
      isPanning = false;
    };

    canvas.addEventListener('pointerup', pointerUp);
    canvas.addEventListener('pointerleave', pointerUp);

    canvas.addEventListener('click', (e) => {
      if (isDragging) return;
      const [wx, wy] = screenToWorld(e.clientX, e.clientY);
      const node = findNodeAt(wx, wy);
      graphSelected = node?.data || null;
    });

    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const factor = e.deltaY > 0 ? 0.9 : 1.1;
      const newZoom = Math.max(0.1, Math.min(5, camZoom * factor));
      const rect = canvas!.getBoundingClientRect();
      const cx = rect.width / 2, cy = rect.height / 2;
      const mx = e.clientX - rect.left - cx;
      const my = e.clientY - rect.top - cy;
      const wx = mx / camZoom + camX;
      const wy = my / camZoom + camY;
      camZoom = newZoom;
      camX = wx - mx / camZoom;
      camY = wy - my / camZoom;
    }, { passive: false });
  }

  function resizeCanvas() {
    if (!canvas) return;
    const rect = canvas.parentElement!.getBoundingClientRect();
    canvas.width = rect.width;
    canvas.height = rect.height;
  }

  async function initGraph() {
    if (graphInitialized) return;
    graphInitialized = true;
    graphStatus = 'Loading embeddings...';

    try {
      const res = await fetch('/api/embeddings?vectors=true');
      const result = await res.json();

      if (result.error) {
        graphError = result.error;
        graphStatus = '';
        return;
      }

      embeddings = result.embeddings || [];
      if (embeddings.length === 0 || !embeddings[0].vector) {
        graphStatus = '';
        if (embeddings.length > 0) graphError = 'No vector data available';
        return;
      }

      graphStatus = `Computing UMAP (${embeddings.length})...`;
      await new Promise(r => setTimeout(r, 50));

      const vectors = embeddings.map((e: any) => e.vector);
      const umap = new UMAP({
        nComponents: 2,
        nNeighbors: Math.min(15, Math.max(2, vectors.length - 1)),
        minDist: 0.1,
        spread: 1.0,
      });

      let projected: number[][];
      try {
        projected = umap.fit(vectors);
      } catch (umapErr: any) {
        graphError = `UMAP failed: ${umapErr.message}`;
        graphStatus = '';
        return;
      }

      graphStatus = 'Building graph...';
      await new Promise(r => setTimeout(r, 50));

      let minX = Infinity, maxX = -Infinity;
      let minY = Infinity, maxY = -Infinity;
      for (const p of projected) {
        if (p[0] < minX) minX = p[0];
        if (p[0] > maxX) maxX = p[0];
        if (p[1] < minY) minY = p[1];
        if (p[1] > maxY) maxY = p[1];
      }
      const rangeX = maxX - minX || 1;
      const rangeY = maxY - minY || 1;
      const scale = 400;

      nodes = embeddings.map((emb: any, i: number) => ({
        x: ((projected[i][0] - minX) / rangeX - 0.5) * scale,
        y: ((projected[i][1] - minY) / rangeY - 0.5) * scale,
        radius: 3 + (emb.importance || 0.5) * 5,
        color: sourceColors[emb.who] || sourceColors.unknown,
        data: emb,
      }));

      edges = buildKnnEdges(projected, 4).map(([a, b]) => ({
        source: a,
        target: b,
      }));

      simulation = forceSimulation(nodes as any)
        .force('link', forceLink(edges).distance(60).strength(0.3))
        .force('charge', forceManyBody().strength(-80))
        .force('center', forceCenter(0, 0))
        .force(
          'collide',
          forceCollide().radius((d: any) => d.radius + 2)
        )
        .alphaDecay(0.02)
        .on('tick', () => {});

      graphStatus = '';
      await tick();

      resizeCanvas();
      window.addEventListener('resize', resizeCanvas);
      setupInteractions();

      const ctx = canvas!.getContext('2d')!;
      draw(ctx);
    } catch (e: any) {
      graphError = e.message || 'Failed to load embeddings';
      graphStatus = '';
    }
  }

  $effect(() => {
    if (activeTab === 'embeddings' && canvas && !graphInitialized) {
      initGraph();
    }
  });

  $effect(() => {
    if (activeTab === 'embeddings' && canvas && graphInitialized) {
      tick().then(() => resizeCanvas());
    }
  });

  // --- Memory sidebar ---
  let memoryQuery = $state('');
  let memoryResults = $state<any[]>([]);
  let memorySearched = $state(false);
  let searchingMemory = $state(false);

  // Filter panel state
  let filtersOpen = $state(false);
  let filterType = $state('');
  let filterTags = $state('');
  let filterWho = $state('');
  let filterPinned = $state(false);
  let filterImportanceMin = $state('');
  let filterSince = $state('');
  let whoOptions = $state<string[]>([]);

  // Similar-results state
  let similarSourceId = $state<string | null>(null);
  let similarSource = $state<any>(null);
  let similarResults = $state<any[]>([]);
  let loadingSimilar = $state(false);

  let hasActiveFilters = $derived(
    !!(filterType || filterTags || filterWho || filterPinned
       || filterImportanceMin || filterSince)
  );

  let displayMemories = $derived(
    similarSourceId ? similarResults
    : memorySearched || hasActiveFilters ? memoryResults
    : (data.memories ?? [])
  );

  function filterSearchParams(): string {
    const p = new URLSearchParams();
    if (memoryQuery.trim()) p.set('q', memoryQuery.trim());
    if (filterType) p.set('type', filterType);
    if (filterTags) p.set('tags', filterTags);
    if (filterWho) p.set('who', filterWho);
    if (filterPinned) p.set('pinned', '1');
    if (filterImportanceMin) p.set('importance_min', filterImportanceMin);
    if (filterSince) p.set('since', filterSince);
    return p.toString();
  }

  async function searchMemories() {
    const hasQuery = memoryQuery.trim();
    if (!hasQuery && !hasActiveFilters) {
      memoryResults = [];
      memorySearched = false;
      similarSourceId = null;
      return;
    }
    similarSourceId = null;
    searchingMemory = true;
    try {
      const res = await fetch(`/memory/search?${filterSearchParams()}`);
      const data = await res.json();
      memoryResults = data.results ?? [];
      memorySearched = true;
    } finally {
      searchingMemory = false;
    }
  }

  async function findSimilar(id: string, sourceMemory: any) {
    similarSourceId = id;
    similarSource = sourceMemory;
    loadingSimilar = true;
    similarResults = [];
    try {
      const p = new URLSearchParams({ id, k: '10' });
      if (filterType) p.set('type', filterType);
      const res = await fetch(`/memory/similar?${p.toString()}`);
      const data = await res.json();
      similarResults = data.results ?? [];
    } finally {
      loadingSimilar = false;
    }
  }

  function clearAll() {
    memoryQuery = '';
    memoryResults = [];
    memorySearched = false;
    filterType = '';
    filterTags = '';
    filterWho = '';
    filterPinned = false;
    filterImportanceMin = '';
    filterSince = '';
    similarSourceId = null;
    similarSource = null;
    similarResults = [];
  }

  // Trigger search whenever filters change (without needing Enter)
  $effect(() => {
    // Track all filter values to react to changes
    const _ = filterType, __ = filterTags, ___ = filterWho,
      ____ = filterPinned, _____ = filterImportanceMin, ______ = filterSince;
    if (hasActiveFilters || memorySearched) {
      searchMemories();
    }
  });

  $effect(() => {
    // Load who options once on mount
    fetch('/memory/search?distinct=who')
      .then(r => r.json())
      .then(d => { whoOptions = d.values ?? []; })
      .catch(() => {});
  });

  function formatDate(dateStr: string): string {
    try {
      const date = new Date(dateStr);
      return date.toLocaleString('en-US', {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      });
    } catch {
      return dateStr;
    }
  }
</script>

<svelte:head>
  <title>Signet</title>
</svelte:head>

<svelte:window onkeydown={handleKeydown} />

<div class="app">
  <!-- Header - minimal -->
  <header class="header">
    <div class="brand">
      <svg class="brand-icon" width="14" height="14" viewBox="0 0 14 14" fill="none">
        <circle cx="7" cy="7" r="6" stroke="currentColor" stroke-width="1.2"/>
        <circle cx="7" cy="7" r="2" fill="currentColor"/>
      </svg>
      <span class="brand-name">signet</span>
    </div>
    
    <button class="btn-icon" onclick={toggleTheme} aria-label="Toggle theme">
      {#if theme === 'dark'}
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.2">
          <circle cx="7" cy="7" r="3"/>
          <path d="M7 1v1.5M7 11.5V13M1 7h1.5M11.5 7H13M3.05 3.05l1.06 1.06M9.9 9.9l1.06 1.06M3.05 10.95l1.06-1.06M9.9 4.1l1.06-1.06"/>
        </svg>
      {:else}
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.2">
          <path d="M12 7.5a5 5 0 11-6.5-6.5 5 5 0 006.5 6.5z"/>
        </svg>
      {/if}
    </button>
  </header>

  <div class="main">
    <!-- Left Sidebar -->
    <aside class="sidebar sidebar-left">
      <section class="section">
        <div class="section-header">
          <span class="section-title">Agent</span>
          <span class="seal-indicator"></span>
        </div>
        
        <div class="field">
          <span class="field-label">Name</span>
          <span class="field-value">{data.identity?.name ?? 'Unknown'}</span>
        </div>
        
        <div class="field">
          <span class="field-label">Creature</span>
          <span class="field-value">{data.identity?.creature ?? '—'}</span>
        </div>
        
        <div class="field">
          <span class="field-label">Memories</span>
          <span class="field-value field-value-accent">{data.memoryStats?.total ?? 0}</span>
        </div>
      </section>

      <div class="divider"></div>

      <section class="section">
        <div class="section-header">
          <span class="section-title">Harnesses</span>
        </div>
        
        {#each data.harnesses ?? [] as harness}
          <div class="field">
            <div class="seal-status" class:seal-status-active={harness.exists}></div>
            <span class="field-value">{harness.name}</span>
          </div>
        {/each}
      </section>

      <div class="divider"></div>

      <section class="section section-grow">
        <div class="section-header">
          <span class="section-title">Files</span>
        </div>
        
        <div class="file-list">
          {#each data.configFiles ?? [] as file}
            {@const active = selectedFile === file.name}
            <button
              class="file-item"
              class:file-item-active={active}
              onclick={() => selectFile(file.name)}
            >
              <span class="file-name">{file.name}</span>
              <span class="file-meta">{fmtSize(file.size)}</span>
            </button>
          {/each}
        </div>
      </section>
    </aside>

    <!-- Center Panel -->
    <main class="center">
      <!-- Tabs -->
      <div class="tabs">
        <div class="tab-group">
          <button
            class="tab"
            class:tab-active={activeTab === 'config'}
            onclick={() => activeTab = 'config'}
          >
            Config
          </button>
          <button
            class="tab"
            class:tab-active={activeTab === 'embeddings'}
            onclick={() => activeTab = 'embeddings'}
          >
            Embeddings
          </button>
        </div>
        
        <div class="tab-info">
          {#if activeTab === 'config'}
            <span class="filename">{selectedFile}</span>
            {#if saved}
              <span class="status-text">Saved</span>
            {/if}
            <button class="btn-primary" onclick={saveFile} disabled={saving}>
              {saving ? 'Saving...' : 'Save'}
            </button>
          {:else}
            <span class="status-text">{embeddings.length} embeddings</span>
          {/if}
        </div>
      </div>

      <!-- Content -->
      <div class="content">
        {#if activeTab === 'config'}
          <textarea
            class="editor"
            bind:value={editorContent}
            spellcheck="false"
            placeholder="Empty file..."
          ></textarea>
        {:else}
          <div class="canvas-container">
            {#if graphStatus}
              <div class="overlay">
                <p>{graphStatus}</p>
              </div>
            {:else if graphError}
              <div class="overlay">
                <p class="text-error">{graphError}</p>
              </div>
            {:else if graphInitialized && embeddings.length === 0}
              <div class="overlay">
                <p>No embeddings found</p>
              </div>
            {:else if !graphInitialized}
              <div class="overlay">
                <p>Loading...</p>
              </div>
            {/if}
            <canvas bind:this={canvas} class="canvas"></canvas>
          </div>
        {/if}
      </div>

      <!-- Status Bar -->
      <div class="statusbar">
        {#if activeTab === 'config'}
          <span>{ext(selectedFile).toUpperCase()}</span>
          <span class="statusbar-right">
            <kbd>Cmd+S</kbd> to save
          </span>
        {:else}
          <span>{nodes.length} nodes · {edges.length} edges</span>
          <span class="statusbar-right">UMAP</span>
        {/if}
      </div>
    </main>

    <!-- Right Sidebar -->
    <aside class="sidebar sidebar-right">
      <section class="section">
        <div class="section-header">
          <span class="section-title">Memories</span>
          <span class="badge">{data.memoryStats?.total ?? 0}</span>
        </div>

        <!-- Search row -->
        <div class="search-row">
          <input
            type="text"
            class="search-input"
            bind:value={memoryQuery}
            onkeydown={(e) => e.key === 'Enter' && searchMemories()}
            placeholder="Search..."
          />
          <button
            class="btn-icon"
            class:filter-active={hasActiveFilters}
            onclick={() => filtersOpen = !filtersOpen}
            title="Filters"
          >
            <!-- funnel icon -->
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.3">
              <path d="M1 2h10L7 6.5V10.5L5 9.5V6.5L1 2z"/>
            </svg>
          </button>
          {#if memorySearched || hasActiveFilters || similarSourceId}
            <button class="btn-text" onclick={clearAll}>Clear</button>
          {/if}
        </div>

        <!-- Filter panel -->
        {#if filtersOpen}
          <div class="filter-panel">
            <!-- Type pills -->
            <div class="filter-row">
              {#each ['fact','decision','preference','issue','learning'] as t}
                <button
                  class="pill"
                  class:pill-active={filterType === t}
                  onclick={() => filterType = filterType === t ? '' : t}
                >{t}</button>
              {/each}
            </div>
            <!-- Who select -->
            <select class="filter-select" bind:value={filterWho}>
              <option value="">any source</option>
              {#each whoOptions as w}<option>{w}</option>{/each}
            </select>
            <!-- Tags -->
            <input
              class="filter-input"
              placeholder="tags (comma-sep)..."
              bind:value={filterTags}
            />
            <!-- Importance + Since -->
            <div class="filter-row">
              <span class="filter-label">imp ≥</span>
              <input
                type="number" class="filter-num"
                min="0" max="1" step="0.1"
                bind:value={filterImportanceMin}
              />
              <span class="filter-label">since</span>
              <input type="date" class="filter-date" bind:value={filterSince} />
            </div>
            <!-- Pinned toggle -->
            <button
              class="pill"
              class:pill-active={filterPinned}
              onclick={() => filterPinned = !filterPinned}
            >pinned only</button>
          </div>
        {/if}

        {#if similarSourceId && similarSource}
          <div class="similar-header">
            <span>∿ similar to: {(similarSource.content ?? '').slice(0, 40)}{(similarSource.content ?? '').length > 40 ? '…' : ''}</span>
            <button class="btn-text" onclick={() => { similarSourceId = null; similarResults = []; }}>✕</button>
          </div>
        {:else if memorySearched || hasActiveFilters}
          <div class="search-results">
            {searchingMemory ? 'Searching…' : `${memoryResults.length} results`}
          </div>
        {/if}
      </section>

      <div class="memory-scroll">
        {#if loadingSimilar}
          <div class="empty">Finding similar…</div>
        {:else}
        {#each displayMemories as memory}
          <div class="memory-item">
            <p class="memory-content">{memory.content}</p>
            <div class="memory-footer">
              <span class="memory-source">{memory.who}</span>
              {#if memory.type}
                <span class="memory-type">{memory.type}</span>
              {/if}
              {#if memory.importance && memory.importance >= 0.9}
                <span class="memory-critical">critical</span>
              {/if}
              {#if memory.pinned}
                <span class="memory-pinned">📌</span>
              {/if}
              <span class="memory-time">{formatDate(memory.created_at)}</span>
              <button
                class="btn-similar"
                onclick={() => findSimilar(memory.id, memory)}
                title="Find similar"
              >∿</button>
            </div>
          </div>
        {:else}
          <div class="empty">
            {similarSourceId ? 'No similar memories' : memorySearched || hasActiveFilters ? 'No results' : 'No memories'}
          </div>
        {/each}
        {/if}
      </div>
    </aside>
  </div>
</div>

<style>
  /* === Layout === */
  
  .app {
    display: flex;
    flex-direction: column;
    height: 100vh;
    background: var(--bg-canvas);
    color: var(--text-primary);
    overflow: hidden;
  }

  .main {
    display: flex;
    flex: 1;
    min-height: 0;
    overflow: hidden;
  }

  /* === Header === */
  
  .header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    height: 44px;
    padding: 0 var(--space-4);
    border-bottom: 1px solid var(--border-standard);
    flex-shrink: 0;
  }

  .brand {
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }

  .brand-icon {
    color: var(--accent-seal);
  }

  .brand-name {
    font-size: 13px;
    font-weight: 500;
    letter-spacing: -0.01em;
  }

  .btn-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    color: var(--text-tertiary);
    background: transparent;
    border: none;
    border-radius: var(--radius-sm);
    cursor: pointer;
  }

  .btn-icon:hover {
    color: var(--text-secondary);
    background: var(--bg-elevated);
  }

  /* === Sidebars === */
  
  .sidebar {
    display: flex;
    flex-direction: column;
    background: var(--bg-surface);
    overflow: hidden;
  }

  .sidebar-left {
    width: 200px;
    border-right: 1px solid var(--border-standard);
  }

  .sidebar-right {
    width: 280px;
    border-left: 1px solid var(--border-standard);
  }

  .section {
    padding: var(--space-3) var(--space-3);
  }

  .section-grow {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-height: 0;
    padding-bottom: var(--space-4);
  }

  .section-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: var(--space-3);
  }

  .section-title {
    font-size: 11px;
    font-weight: 500;
    color: var(--text-tertiary);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .divider {
    height: 1px;
    background: var(--border-subtle);
    margin: 0 var(--space-3);
  }

  /* === Seal Indicator === */
  
  .seal-indicator {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--accent-seal);
    box-shadow: 0 0 0 2px var(--accent-seal-ring);
  }

  .seal-status {
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: var(--text-muted);
    flex-shrink: 0;
  }

  .seal-status-active {
    background: var(--success);
    box-shadow: 0 0 0 1.5px rgba(74, 222, 128, 0.2);
  }

  /* === Fields === */
  
  .field {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-1) 0;
    font-size: 12px;
  }

  .field-label {
    color: var(--text-tertiary);
    font-family: var(--font-mono);
    font-size: 10px;
    min-width: 60px;
  }

  .field-value {
    color: var(--text-secondary);
    font-family: var(--font-mono);
  }

  .field-value-accent {
    color: var(--accent-seal);
  }

  /* === File List === */
  
  .file-list {
    display: flex;
    flex-direction: column;
    gap: 1px;
    overflow-y: auto;
  }

  .file-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: var(--space-2) var(--space-2);
    font-size: 12px;
    color: var(--text-secondary);
    background: transparent;
    border: none;
    border-radius: var(--radius-sm);
    cursor: pointer;
    text-align: left;
  }

  .file-item:hover {
    background: var(--bg-elevated);
    color: var(--text-primary);
  }

  .file-item-active {
    background: var(--accent-seal-dim);
    color: var(--accent-seal);
  }

  .file-name {
    font-family: var(--font-mono);
    font-size: 11px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .file-meta {
    font-family: var(--font-mono);
    font-size: 10px;
    color: var(--text-tertiary);
    flex-shrink: 0;
  }

  /* === Center Panel === */
  
  .center {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-width: 0;
    background: var(--bg-canvas);
  }

  /* === Tabs === */
  
  .tabs {
    display: flex;
    align-items: center;
    justify-content: space-between;
    height: 40px;
    padding: 0 var(--space-3);
    border-bottom: 1px solid var(--border-standard);
    flex-shrink: 0;
  }

  .tab-group {
    display: flex;
    gap: var(--space-1);
  }

  .tab {
    padding: var(--space-1) var(--space-3);
    font-size: 12px;
    font-weight: 450;
    color: var(--text-tertiary);
    background: transparent;
    border: none;
    border-radius: var(--radius-sm);
    cursor: pointer;
  }

  .tab:hover {
    color: var(--text-secondary);
    background: var(--bg-elevated);
  }

  .tab-active {
    color: var(--text-primary);
    background: var(--bg-elevated);
  }

  .tab-info {
    display: flex;
    align-items: center;
    gap: var(--space-3);
  }

  .filename {
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--text-tertiary);
  }

  .status-text {
    font-size: 11px;
    color: var(--text-tertiary);
  }

  /* === Buttons === */
  
  .btn-primary {
    padding: var(--space-1) var(--space-3);
    font-size: 11px;
    font-weight: 500;
    color: var(--bg-canvas);
    background: var(--text-primary);
    border: none;
    border-radius: var(--radius-sm);
    cursor: pointer;
  }

  .btn-primary:hover {
    background: var(--text-secondary);
  }

  .btn-primary:disabled {
    opacity: 0.4;
    cursor: default;
  }

  .btn-text {
    font-size: 11px;
    color: var(--accent-seal);
    background: transparent;
    border: none;
    cursor: pointer;
    padding: 0;
  }

  .btn-text:hover {
    text-decoration: underline;
  }

  /* === Content === */
  
  .content {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-height: 0;
    position: relative;
  }

  /* === Editor === */
  
  .editor {
    flex: 1;
    width: 100%;
    padding: var(--space-5);
    font-family: var(--font-mono);
    font-size: 13px;
    line-height: 1.7;
    color: var(--text-primary);
    background: transparent;
    border: none;
    resize: none;
    outline: none;
    tab-size: 2;
  }

  .editor::placeholder {
    color: var(--text-tertiary);
    font-style: italic;
  }

  /* === Canvas === */
  
  .canvas-container {
    flex: 1;
    position: relative;
    overflow: hidden;
  }

  .canvas {
    width: 100%;
    height: 100%;
    cursor: grab;
  }

  .overlay {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--bg-canvas);
    z-index: 10;
  }

  .overlay p {
    font-size: 13px;
    color: var(--text-secondary);
  }

  /* === Status Bar === */
  
  .statusbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    height: 26px;
    padding: 0 var(--space-3);
    border-top: 1px solid var(--border-subtle);
    font-size: 10px;
    font-family: var(--font-mono);
    color: var(--text-tertiary);
    flex-shrink: 0;
  }

  .statusbar-right {
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }

  .statusbar kbd {
    padding: 1px 4px;
    font-size: 9px;
    color: var(--text-tertiary);
    background: var(--bg-elevated);
    border-radius: 2px;
  }

  /* === Right Sidebar === */
  
  .badge {
    font-family: var(--font-mono);
    font-size: 10px;
    color: var(--accent-seal);
    padding: 1px 5px;
    background: var(--accent-seal-dim);
    border-radius: 10px;
  }

  .search-row {
    display: flex;
    align-items: center;
    gap: var(--space-1);
  }

  .search-input {
    flex: 1;
    padding: var(--space-2) var(--space-3);
    font-size: 12px;
    font-family: var(--font-mono);
    color: var(--text-primary);
    background: var(--bg-elevated);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
    outline: none;
  }

  .search-input:focus {
    border-color: var(--border-accent);
  }

  .search-input::placeholder {
    color: var(--text-tertiary);
  }

  .search-results {
    font-size: 11px;
    color: var(--text-tertiary);
    margin-top: var(--space-2);
  }

  .memory-scroll {
    flex: 1;
    overflow-y: auto;
    padding: 0 var(--space-3) var(--space-4);
  }

  .memory-item {
    padding: var(--space-3) 0;
    border-bottom: 1px solid var(--border-subtle);
  }

  .memory-item:last-child {
    border-bottom: none;
  }

  .memory-content {
    font-size: 12px;
    line-height: 1.6;
    color: var(--text-secondary);
    display: -webkit-box;
    -webkit-line-clamp: 3;
    -webkit-box-orient: vertical;
    overflow: hidden;
    margin: 0 0 var(--space-2) 0;
  }

  .memory-footer {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    font-size: 10px;
  }

  .memory-source {
    font-family: var(--font-mono);
    color: var(--accent-seal);
  }

  .memory-critical {
    color: var(--warning);
    font-weight: 500;
    text-transform: uppercase;
    letter-spacing: 0.02em;
  }

  .memory-time {
    color: var(--text-tertiary);
    font-family: var(--font-mono);
  }

  .memory-type {
    font-family: var(--font-mono);
    font-size: 9px;
    color: var(--text-tertiary);
    border: 1px solid var(--border-subtle);
    border-radius: 3px;
    padding: 0 3px;
  }

  .memory-pinned {
    font-size: 9px;
  }

  .empty {
    padding: var(--space-8) var(--space-4);
    text-align: center;
    font-size: 13px;
    color: var(--text-tertiary);
  }

  /* === Filter Panel === */

  .filter-panel {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding: var(--space-2) 0;
    border-top: 1px solid var(--border-subtle);
  }

  .filter-row {
    display: flex;
    gap: var(--space-1);
    align-items: center;
    flex-wrap: wrap;
  }

  .pill {
    font-size: 10px;
    padding: 2px 6px;
    border-radius: 9999px;
    border: 1px solid var(--border-standard);
    background: none;
    color: var(--text-secondary);
    cursor: pointer;
    white-space: nowrap;
  }

  .pill:hover {
    border-color: var(--accent-seal);
    color: var(--accent-seal);
  }

  .pill-active {
    border-color: var(--accent-seal);
    color: var(--accent-seal);
    background: var(--accent-seal-dim);
  }

  .filter-select,
  .filter-input {
    font-size: 11px;
    font-family: var(--font-mono);
    background: var(--bg-elevated);
    border: 1px solid var(--border-standard);
    color: var(--text-primary);
    border-radius: 4px;
    padding: 3px 6px;
    width: 100%;
    outline: none;
  }

  .filter-num {
    font-size: 11px;
    font-family: var(--font-mono);
    background: var(--bg-elevated);
    border: 1px solid var(--border-standard);
    color: var(--text-primary);
    border-radius: 4px;
    padding: 3px 4px;
    width: 48px;
    outline: none;
  }

  .filter-date {
    font-size: 11px;
    font-family: var(--font-mono);
    background: var(--bg-elevated);
    border: 1px solid var(--border-standard);
    color: var(--text-primary);
    border-radius: 4px;
    padding: 3px 4px;
    flex: 1;
    outline: none;
  }

  .filter-label {
    font-size: 10px;
    color: var(--text-tertiary);
    white-space: nowrap;
    font-family: var(--font-mono);
  }

  .filter-active {
    color: var(--accent-seal) !important;
  }

  /* === Similar button === */

  .btn-similar {
    opacity: 0;
    font-size: 13px;
    color: var(--text-tertiary);
    background: none;
    border: none;
    cursor: pointer;
    margin-left: auto;
    padding: 0 2px;
    line-height: 1;
    transition: opacity 0.1s, color 0.1s;
  }

  .memory-item:hover .btn-similar {
    opacity: 1;
  }

  .btn-similar:hover {
    color: var(--accent-seal);
  }

  .similar-header {
    font-size: 11px;
    color: var(--text-secondary);
    padding: var(--space-2) 0 0;
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: var(--space-2);
    font-family: var(--font-mono);
    line-height: 1.4;
  }

  /* === Utilities === */

  .text-error {
    color: var(--error);
  }

  /* === Responsive === */
  
  @media (max-width: 1024px) {
    .sidebar-right { display: none; }
  }

  @media (max-width: 768px) {
    .sidebar-left { display: none; }
  }
</style>

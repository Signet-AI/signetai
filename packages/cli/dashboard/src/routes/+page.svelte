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
  import {
    saveConfigFile,
    getEmbeddings,
    searchMemories,
    getSimilarMemories,
    getDistinctWho,
    regenerateHarnesses as apiRegenerateHarnesses,
    getSecrets,
    putSecret,
    deleteSecret,
    getSkills,
    searchSkills,
    installSkill,
    uninstallSkill,
    type Skill
  } from '$lib/api';

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
  let activeTab = $state<'config' | 'embeddings' | 'logs' | 'secrets' | 'skills'>('config');

  // --- Secrets ---
  let secrets = $state<string[]>([]);
  let secretsLoading = $state(false);
  let newSecretName = $state('');
  let newSecretValue = $state('');
  let secretAdding = $state(false);
  let secretDeleting = $state<string | null>(null);

  async function fetchSecrets() {
    secretsLoading = true;
    secrets = await getSecrets();
    secretsLoading = false;
  }

  async function addSecret() {
    if (!newSecretName.trim() || !newSecretValue.trim()) return;
    secretAdding = true;
    const ok = await putSecret(newSecretName.trim(), newSecretValue);
    if (ok) {
      newSecretName = '';
      newSecretValue = '';
      await fetchSecrets();
    }
    secretAdding = false;
  }

  async function removeSecret(name: string) {
    secretDeleting = name;
    const ok = await deleteSecret(name);
    if (ok) {
      await fetchSecrets();
    }
    secretDeleting = null;
  }

  // --- Skills ---
  let skills = $state<Skill[]>([]);
  let skillsLoading = $state(false);
  let skillSearchQuery = $state('');
  let skillSearchResults = $state<Array<{ name: string; description: string; installed: boolean }>>([]);
  let skillSearching = $state(false);
  let skillInstalling = $state<string | null>(null);
  let skillUninstalling = $state<string | null>(null);
  let selectedSkill = $state<Skill | null>(null);

  async function fetchSkills() {
    skillsLoading = true;
    skills = await getSkills();
    skillsLoading = false;
  }

  async function doSkillSearch() {
    if (!skillSearchQuery.trim()) {
      skillSearchResults = [];
      return;
    }
    skillSearching = true;
    skillSearchResults = await searchSkills(skillSearchQuery.trim());
    skillSearching = false;
  }

  async function doInstallSkill(name: string) {
    skillInstalling = name;
    const result = await installSkill(name);
    if (result.success) {
      await fetchSkills();
      skillSearchResults = skillSearchResults.map(s => 
        s.name === name ? { ...s, installed: true } : s
      );
    }
    skillInstalling = null;
  }

  async function doUninstallSkill(name: string) {
    skillUninstalling = name;
    const result = await uninstallSkill(name);
    if (result.success) {
      await fetchSkills();
      skillSearchResults = skillSearchResults.map(s => 
        s.name === name ? { ...s, installed: false } : s
      );
      if (selectedSkill?.name === name) {
        selectedSkill = null;
      }
    }
    skillUninstalling = null;
  }

  // --- Logs viewer ---
  interface LogEntry {
    timestamp: string;
    level: 'debug' | 'info' | 'warn' | 'error';
    category: string;
    message: string;
    data?: Record<string, unknown>;
    duration?: number;
    error?: { name: string; message: string };
  }

  let logs = $state<LogEntry[]>([]);
  let logsLoading = $state(false);
  let logsError = $state('');
  let logsStreaming = $state(false);
  let logEventSource: EventSource | null = null;
  let logLevelFilter = $state<string>('');
  let logCategoryFilter = $state<string>('');
  let logAutoScroll = $state(true);
  let logContainer: HTMLDivElement | null = null;

  const logCategories = ['daemon', 'api', 'memory', 'sync', 'git', 'watcher', 'embedding', 'harness', 'system'];
  const logLevels = ['debug', 'info', 'warn', 'error'];

  async function fetchLogs() {
    logsLoading = true;
    logsError = '';
    try {
      const params = new URLSearchParams({ limit: '200' });
      if (logLevelFilter) params.set('level', logLevelFilter);
      if (logCategoryFilter) params.set('category', logCategoryFilter);
      
      const res = await fetch(`/api/logs?${params}`);
      const data = await res.json();
      logs = data.logs || [];
    } catch (e) {
      logsError = 'Failed to fetch logs';
    } finally {
      logsLoading = false;
    }
  }

  function startLogStream() {
    if (logEventSource) {
      logEventSource.close();
    }
    
    logsStreaming = true;
    logEventSource = new EventSource('/api/logs/stream');
    
    logEventSource.onmessage = (event) => {
      try {
        const entry = JSON.parse(event.data);
        if (entry.type === 'connected') return;
        
        // Apply filters
        if (logLevelFilter && entry.level !== logLevelFilter) return;
        if (logCategoryFilter && entry.category !== logCategoryFilter) return;
        
        logs = [...logs.slice(-499), entry]; // Keep last 500
        
        // Auto-scroll
        if (logAutoScroll && logContainer) {
          setTimeout(() => {
            logContainer?.scrollTo({ top: logContainer.scrollHeight, behavior: 'smooth' });
          }, 50);
        }
      } catch {
        // Ignore parse errors
      }
    };
    
    logEventSource.onerror = () => {
      logsStreaming = false;
      logEventSource?.close();
      logEventSource = null;
    };
  }

  function stopLogStream() {
    logsStreaming = false;
    logEventSource?.close();
    logEventSource = null;
  }

  function toggleLogStream() {
    if (logsStreaming) {
      stopLogStream();
    } else {
      startLogStream();
    }
  }

  function clearLogs() {
    logs = [];
  }

  function formatLogTime(timestamp: string): string {
    return timestamp.split('T')[1]?.slice(0, 8) || '';
  }

  // Fetch logs when tab becomes active
  $effect(() => {
    if (activeTab === 'logs' && logs.length === 0) {
      fetchLogs();
    }
  });

  // Fetch secrets when tab becomes active
  $effect(() => {
    if (activeTab === 'secrets' && secrets.length === 0) {
      fetchSecrets();
    }
  });

  // Fetch skills when tab becomes active
  $effect(() => {
    if (activeTab === 'skills' && skills.length === 0) {
      fetchSkills();
    }
  });

  // Cleanup on unmount
  $effect(() => {
    return () => {
      if (logEventSource) {
        logEventSource.close();
      }
      cancelAnimationFrame(animFrame);
      if (graph3d) {
        graph3d._destructor?.();
        graph3d = null;
      }
    };
  });

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
      const success = await saveConfigFile(selectedFile, editorContent);
      if (success) {
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

  // 3D graph state
  let graphMode: '2d' | '3d' = $state('2d');
  let graph3d: any = null;
  let graph3dContainer = $state<HTMLDivElement | null>(null);

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
        let d = 0;
        for (let c = 0; c < projected[i].length; c++) {
          const diff = projected[i][c] - projected[j][c];
          d += diff * diff;
        }
        dists.push({ j, d });
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
    ctx.fillStyle = '#050505';
    ctx.fillRect(0, 0, w, h);
    ctx.save();
    ctx.translate(w / 2, h / 2);
    ctx.scale(camZoom, camZoom);
    ctx.translate(-camX, -camY);

    for (const edge of edges) {
      const s = edge.source as GraphNode;
      const t = edge.target as GraphNode;
      ctx.beginPath();
      ctx.moveTo(s.x, s.y);
      ctx.lineTo(t.x, t.y);
      ctx.strokeStyle = 'rgba(180, 180, 180, 0.45)';
      ctx.lineWidth = 0.8 / camZoom;
      ctx.stroke();
    }

    for (const node of nodes) {
      ctx.beginPath();
      ctx.arc(node.x, node.y, node.radius, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(210, 210, 210, 0.85)';
      ctx.fill();

      if (graphSelected && node.data === graphSelected) {
        ctx.beginPath();
        ctx.arc(node.x, node.y, node.radius + 3, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
        ctx.lineWidth = 1.5 / camZoom;
        ctx.stroke();
      }
    }

    if (graphHovered) {
      const node = nodes.find(n => n.data === graphHovered);
      if (node) {
        const raw = graphHovered.text || graphHovered.content || '';
        const text = raw.slice(0, 48) + (raw.length > 48 ? '...' : '');
        const fs = 9 / camZoom;
        ctx.font = `${fs}px var(--font-mono)`;
        ctx.fillStyle = 'rgba(220, 220, 220, 0.9)';
        ctx.textAlign = 'left';
        ctx.fillText(text, node.x + node.radius + 5 / camZoom, node.y + fs * 0.35);
        ctx.textAlign = 'start';
      }
    }

    if (graphSelected) {
      const selNode = nodes.find(n => n.data === graphSelected);
      if (selNode && selNode.data !== graphHovered) {
        const raw = (selNode.data.text || selNode.data.content || '').trim().toUpperCase();
        if (raw) {
          const fs = 10 / camZoom;
          ctx.font = `${fs}px var(--font-mono)`;

          // Word-wrap into lines
          const maxW = 200 / camZoom;
          const words = raw.split(' ');
          const lines: string[] = [];
          let cur = '';
          for (const w of words) {
            const test = cur ? cur + ' ' + w : w;
            if (cur && ctx.measureText(test).width > maxW) {
              lines.push(cur);
              cur = w;
            } else {
              cur = test;
            }
          }
          if (cur) lines.push(cur);
          const dl = lines.slice(0, 8);

          const lineH = fs * 1.8;
          const padX = 10 / camZoom;
          const padY = 8 / camZoom;
          const boxW = Math.max(...dl.map(l => ctx.measureText(l).width)) + padX * 2;
          const boxH = dl.length * lineH + padY * 2;

          // Callout bracket positioned to the left of the node
          const barLen = 16 / camZoom;
          const edgeGap = 50 / camZoom;
          const bracketRX = selNode.x - edgeGap;
          const bracketLX = bracketRX - barLen;
          const bx = bracketLX - 4 / camZoom - boxW;
          const by = selNode.y - boxH * 0.35;

          ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
          ctx.lineWidth = 1.5 / camZoom;
          ctx.lineCap = 'square';

          // Diagonal connector: node → top-right corner of bracket
          ctx.beginPath();
          ctx.moveTo(selNode.x, selNode.y);
          ctx.lineTo(bracketRX, by);
          ctx.stroke();

          // ] bracket shape
          ctx.beginPath();
          ctx.moveTo(bracketLX, by);
          ctx.lineTo(bracketRX, by);
          ctx.lineTo(bracketRX, by + boxH);
          ctx.lineTo(bracketLX, by + boxH);
          ctx.stroke();

          ctx.lineCap = 'butt';

          // Black background for text block
          ctx.fillStyle = '#050505';
          ctx.fillRect(bx, by, boxW, boxH);

          // First line: inverted (white bg, dark text)
          ctx.fillStyle = 'rgba(255, 255, 255, 0.95)';
          ctx.fillRect(bx, by + padY, boxW, lineH);
          ctx.fillStyle = '#050505';
          ctx.textAlign = 'center';
          ctx.fillText(dl[0], bx + boxW / 2, by + padY + lineH * 0.75);

          // Remaining lines: white text on black
          ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
          for (let i = 1; i < dl.length; i++) {
            ctx.fillText(dl[i], bx + boxW / 2, by + padY + lineH * (i + 0.75));
          }
          ctx.textAlign = 'start';
        }
      }
    }

    ctx.restore();

    // Minimal legend — monochrome
    const legendSources = ['claude-code', 'clawdbot', 'openclaw', 'opencode', 'manual'];
    const lx = 12;
    let ly = h - 12 - legendSources.length * 16;
    ctx.font = '10px var(--font-mono)';
    for (const name of legendSources) {
      ctx.beginPath();
      ctx.arc(lx + 3, ly, 3, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(200, 200, 200, 0.5)';
      ctx.fill();
      ctx.fillStyle = 'rgba(200, 200, 200, 0.35)';
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
      const result = await getEmbeddings(true);

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
        radius: 2.5 + (emb.importance || 0.5) * 2.5,
        color: 'rgba(210, 210, 210, 0.85)',
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

  async function init3DGraph(projected3d: number[][]) {
    if (!graph3dContainer) return;

    if (graph3d) {
      graph3d._destructor?.();
      graph3d = null;
    }

    const { default: ForceGraph3D } = await import('3d-force-graph');

    const nodeData = embeddings.map((e: any, i: number) => ({
      id: e.id,
      content: e.content,
      who: e.who,
      importance: e.importance ?? 0.5,
      x: projected3d[i][0] * 50,
      y: projected3d[i][1] * 50,
      z: projected3d[i][2] * 50,
      color: sourceColors[e.who] ?? sourceColors['unknown'],
      val: 1 + (e.importance ?? 0.5) * 3,
    }));

    const edgePairs = buildKnnEdges(projected3d, 4);
    const linkData = edgePairs.map(([a, b]) => ({
      source: nodeData[a].id,
      target: nodeData[b].id,
    }));

    const rect = graph3dContainer.getBoundingClientRect();
    graph3d = new ForceGraph3D(graph3dContainer)
      .width(rect.width || graph3dContainer.offsetWidth)
      .height(rect.height || graph3dContainer.offsetHeight)
      .graphData({ nodes: nodeData, links: linkData })
      .nodeLabel((n: any) => n.content?.slice(0, 80) ?? '')
      .nodeColor(() => '#d4d4d4')
      .nodeVal((n: any) => 0.6 + (n.importance ?? 0.5) * 1.5)
      .linkColor(() => 'rgba(160,160,160,0.5)')
      .linkWidth(0.5)
      .backgroundColor('#050505')
      .onNodeClick((n: any) => { graphSelected = n; });
  }

  async function switchGraphMode(mode: '2d' | '3d') {
    if (graphMode === mode) return;
    graphMode = mode;

    if (mode === '3d') {
      cancelAnimationFrame(animFrame);

      if (!graphInitialized || embeddings.length === 0) return;

      graphStatus = 'Computing 3D layout...';
      await new Promise(r => setTimeout(r, 50));

      const vectors = embeddings.map((e: any) => e.vector);
      const umap3d = new UMAP({
        nComponents: 3,
        nNeighbors: Math.min(15, Math.max(2, vectors.length - 1)),
        minDist: 0.1,
        spread: 1.0,
      });

      let projected3d: number[][];
      try {
        projected3d = umap3d.fit(vectors);
      } catch (e: any) {
        graphError = `3D UMAP failed: ${e.message}`;
        graphStatus = '';
        graphMode = '2d';
        const ctx = canvas?.getContext('2d');
        if (ctx) draw(ctx);
        return;
      }

      graphStatus = '';
      await tick();
      await init3DGraph(projected3d);
    } else {
      if (graph3d) {
        graph3d._destructor?.();
        graph3d = null;
      }
      await tick();
      const ctx = canvas?.getContext('2d');
      if (ctx) {
        cancelAnimationFrame(animFrame);
        draw(ctx);
      }
    }
  }

  $effect(() => {
    if (activeTab === 'embeddings' && canvas && !graphInitialized) {
      initGraph();
    }
  });

  $effect(() => {
    // Restart 2D loop when canvas is (re)mounted and data is ready
    if (activeTab === 'embeddings' && canvas && graphInitialized && graphMode === '2d' && nodes.length > 0) {
      tick().then(() => {
        resizeCanvas();
        cancelAnimationFrame(animFrame);
        const ctx = canvas?.getContext('2d');
        if (ctx) draw(ctx);
      });
    }
  });

  // Clean up when leaving the embeddings tab
  $effect(() => {
    if (activeTab !== 'embeddings') {
      cancelAnimationFrame(animFrame);
      if (graph3d) {
        graph3d._destructor?.();
        graph3d = null;
      }
      graphMode = '2d';
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

  async function doSearch() {
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
      const results = await searchMemories(memoryQuery.trim(), {
        type: filterType || undefined,
        tags: filterTags || undefined,
        who: filterWho || undefined,
        pinned: filterPinned || undefined,
        importance_min: filterImportanceMin ? parseFloat(filterImportanceMin) : undefined,
        since: filterSince || undefined,
      });
      memoryResults = results;
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
      const results = await getSimilarMemories(id, 10, filterType || undefined);
      similarResults = results;
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
      doSearch();
    }
  });

  $effect(() => {
    // Load who options once on mount
    getDistinctWho()
      .then(values => { whoOptions = values; })
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
          <button
            class="tab"
            class:tab-active={activeTab === 'logs'}
            onclick={() => activeTab = 'logs'}
          >
            Logs
          </button>
          <button
            class="tab"
            class:tab-active={activeTab === 'secrets'}
            onclick={() => activeTab = 'secrets'}
          >
            Secrets
          </button>
          <button
            class="tab"
            class:tab-active={activeTab === 'skills'}
            onclick={() => activeTab = 'skills'}
          >
            Skills
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
          {:else if activeTab === 'embeddings'}
            <span class="status-text">{embeddings.length} embeddings</span>
            {#if graphInitialized && embeddings.length > 0}
              <div class="mode-toggle">
                <button
                  class="mode-btn"
                  class:mode-btn-active={graphMode === '2d'}
                  onclick={() => switchGraphMode('2d')}
                >2D</button>
                <button
                  class="mode-btn"
                  class:mode-btn-active={graphMode === '3d'}
                  onclick={() => switchGraphMode('3d')}
                >3D</button>
              </div>
            {/if}
          {:else if activeTab === 'logs'}
            <span class="status-text">{logs.length} entries</span>
            <button 
              class="btn-icon" 
              class:streaming={logsStreaming}
              onclick={toggleLogStream}
              title={logsStreaming ? 'Stop streaming' : 'Start streaming'}
            >
              {#if logsStreaming}
                <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor">
                  <rect x="3" y="3" width="8" height="8" rx="1"/>
                </svg>
              {:else}
                <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor">
                  <path d="M4 3l7 4-7 4V3z"/>
                </svg>
              {/if}
            </button>
            <button class="btn-icon" onclick={fetchLogs} title="Refresh">
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5">
                <path d="M2 7a5 5 0 019-3M12 7a5 5 0 01-9 3"/>
                <path d="M2 4v3h3M12 10v-3h-3"/>
              </svg>
            </button>
            <button class="btn-icon" onclick={clearLogs} title="Clear">
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5">
                <path d="M3 3l8 8M11 3l-8 8"/>
              </svg>
            </button>
          {:else if activeTab === 'secrets'}
            <span class="status-text">{secrets.length} secrets</span>
            <button class="btn-icon" onclick={fetchSecrets} title="Refresh">
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5">
                <path d="M2 7a5 5 0 019-3M12 7a5 5 0 01-9 3"/>
                <path d="M2 4v3h3M12 10v-3h-3"/>
              </svg>
            </button>
          {:else if activeTab === 'skills'}
            <span class="status-text">{skills.length} installed</span>
            <button class="btn-icon" onclick={fetchSkills} title="Refresh">
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5">
                <path d="M2 7a5 5 0 019-3M12 7a5 5 0 01-9 3"/>
                <path d="M2 4v3h3M12 10v-3h-3"/>
              </svg>
            </button>
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
        {:else if activeTab === 'embeddings'}
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
            <div class="graph-corners" aria-hidden="true">
              <span class="corner corner-tl"></span>
              <span class="corner corner-tr"></span>
              <span class="corner corner-bl"></span>
              <span class="corner corner-br"></span>
            </div>
            <canvas
              bind:this={canvas}
              class="canvas"
              style:display={graphMode === '2d' ? 'block' : 'none'}
            ></canvas>
            <div
              bind:this={graph3dContainer}
              class="graph3d-container"
              style:display={graphMode === '3d' ? 'block' : 'none'}
            ></div>
          </div>
        {:else if activeTab === 'logs'}
          <div class="logs-container">
            <!-- Log filters -->
            <div class="logs-filters">
              <select class="filter-select" bind:value={logLevelFilter} onchange={fetchLogs}>
                <option value="">All levels</option>
                {#each logLevels as level}
                  <option value={level}>{level}</option>
                {/each}
              </select>
              <select class="filter-select" bind:value={logCategoryFilter} onchange={fetchLogs}>
                <option value="">All categories</option>
                {#each logCategories as cat}
                  <option value={cat}>{cat}</option>
                {/each}
              </select>
              <label class="checkbox-label">
                <input type="checkbox" bind:checked={logAutoScroll} />
                Auto-scroll
              </label>
              {#if logsStreaming}
                <span class="streaming-indicator">● Live</span>
              {/if}
            </div>
            
            <!-- Log entries -->
            <div class="logs-scroll" bind:this={logContainer}>
              {#if logsLoading}
                <div class="logs-empty">Loading logs...</div>
              {:else if logsError}
                <div class="logs-empty text-error">{logsError}</div>
              {:else if logs.length === 0}
                <div class="logs-empty">No logs found</div>
              {:else}
                {#each logs as log}
                  <div class="log-entry log-{log.level}">
                    <span class="log-time">{formatLogTime(log.timestamp)}</span>
                    <span class="log-level">{log.level.toUpperCase()}</span>
                    <span class="log-category">[{log.category}]</span>
                    <span class="log-message">{log.message}</span>
                    {#if log.duration !== undefined}
                      <span class="log-duration">({log.duration}ms)</span>
                    {/if}
                    {#if log.data && Object.keys(log.data).length > 0}
                      <span class="log-data">{JSON.stringify(log.data)}</span>
                    {/if}
                    {#if log.error}
                      <div class="log-error">{log.error.name}: {log.error.message}</div>
                    {/if}
                  </div>
                {/each}
              {/if}
            </div>
          </div>
        {:else if activeTab === 'secrets'}
          <div class="secrets-container">
            <!-- Add new secret -->
            <div class="secrets-add">
              <input
                type="text"
                class="secrets-input"
                bind:value={newSecretName}
                placeholder="Secret name (e.g. OPENAI_API_KEY)"
              />
              <input
                type="password"
                class="secrets-input"
                bind:value={newSecretValue}
                placeholder="Secret value"
              />
              <button
                class="btn-primary"
                onclick={addSecret}
                disabled={secretAdding || !newSecretName.trim() || !newSecretValue.trim()}
              >
                {secretAdding ? 'Adding...' : 'Add'}
              </button>
            </div>
            
            <!-- Secrets list -->
            <div class="secrets-list">
              {#if secretsLoading}
                <div class="secrets-empty">Loading secrets...</div>
              {:else if secrets.length === 0}
                <div class="secrets-empty">No secrets stored. Add one above.</div>
              {:else}
                {#each secrets as name}
                  <div class="secret-item">
                    <span class="secret-name">{name}</span>
                    <span class="secret-value">••••••••</span>
                    <button
                      class="btn-danger-small"
                      onclick={() => removeSecret(name)}
                      disabled={secretDeleting === name}
                    >
                      {secretDeleting === name ? '...' : 'Delete'}
                    </button>
                  </div>
                {/each}
              {/if}
            </div>
          </div>
        {:else if activeTab === 'skills'}
          <div class="skills-container">
            <!-- Search skills.sh -->
            <div class="skills-search">
              <input
                type="text"
                class="skills-search-input"
                bind:value={skillSearchQuery}
                onkeydown={(e) => e.key === 'Enter' && doSkillSearch()}
                placeholder="Search skills.sh..."
              />
              <button
                class="btn-primary"
                onclick={doSkillSearch}
                disabled={skillSearching || !skillSearchQuery.trim()}
              >
                {skillSearching ? 'Searching...' : 'Search'}
              </button>
            </div>
            
            <!-- Search results -->
            {#if skillSearchResults.length > 0}
              <div class="skills-section">
                <div class="skills-section-title">Search Results</div>
                <div class="skills-list">
                  {#each skillSearchResults as result}
                    <div class="skill-item">
                      <div class="skill-info">
                        <span class="skill-name">{result.name}</span>
                        {#if result.installed}
                          <span class="skill-badge installed">Installed</span>
                        {/if}
                      </div>
                      <div class="skill-description">{result.description}</div>
                      <div class="skill-actions">
                        {#if result.installed}
                          <button
                            class="btn-danger-small"
                            onclick={() => doUninstallSkill(result.name)}
                            disabled={skillUninstalling === result.name}
                          >
                            {skillUninstalling === result.name ? '...' : 'Uninstall'}
                          </button>
                        {:else}
                          <button
                            class="btn-primary-small"
                            onclick={() => doInstallSkill(result.name)}
                            disabled={skillInstalling === result.name}
                          >
                            {skillInstalling === result.name ? '...' : 'Install'}
                          </button>
                        {/if}
                      </div>
                    </div>
                  {/each}
                </div>
              </div>
            {/if}
            
            <!-- Installed skills -->
            <div class="skills-section">
              <div class="skills-section-title">Installed ({skills.length})</div>
              <div class="skills-list">
                {#if skillsLoading}
                  <div class="skills-empty">Loading skills...</div>
                {:else if skills.length === 0}
                  <div class="skills-empty">No skills installed. Search above to find skills.</div>
                {:else}
                  {#each skills as skill}
                    <div class="skill-item" class:skill-selected={selectedSkill?.name === skill.name}>
                      <div class="skill-info">
                        <span class="skill-name">{skill.name}</span>
                        {#if skill.builtin}
                          <span class="skill-badge builtin">Built-in</span>
                        {/if}
                        {#if skill.user_invocable}
                          <span class="skill-badge invocable">/{skill.name}</span>
                        {/if}
                      </div>
                      <div class="skill-description">{skill.description}</div>
                      <div class="skill-actions">
                        {#if !skill.builtin}
                          <button
                            class="btn-danger-small"
                            onclick={() => doUninstallSkill(skill.name)}
                            disabled={skillUninstalling === skill.name}
                          >
                            {skillUninstalling === skill.name ? '...' : 'Uninstall'}
                          </button>
                        {/if}
                      </div>
                    </div>
                  {/each}
                {/if}
              </div>
            </div>
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
        {:else if activeTab === 'embeddings'}
          <span>{nodes.length} nodes · {edges.length} edges</span>
          <span class="statusbar-right">UMAP · {graphMode.toUpperCase()}</span>
        {:else if activeTab === 'logs'}
          <span>{logs.length} entries</span>
          <span class="statusbar-right">
            {#if logsStreaming}
              <span class="streaming-badge">LIVE</span>
            {:else}
              Press play to stream
            {/if}
          </span>
        {:else if activeTab === 'secrets'}
          <span>{secrets.length} secrets</span>
          <span class="statusbar-right">Encrypted with libsodium</span>
        {:else if activeTab === 'skills'}
          <span>{skills.length} installed</span>
          <span class="statusbar-right">skills.sh</span>
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
            onkeydown={(e) => e.key === 'Enter' && doSearch()}
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
    background: #050505;
  }

  .graph-corners {
    position: absolute;
    inset: 0;
    pointer-events: none;
    z-index: 5;
  }

  .corner {
    position: absolute;
    width: 14px;
    height: 14px;
    border-color: rgba(255, 255, 255, 0.22);
    border-style: solid;
  }

  .corner-tl { top: 10px;    left: 10px;  border-width: 1px 0 0 1px; }
  .corner-tr { top: 10px;    right: 10px; border-width: 1px 1px 0 0; }
  .corner-bl { bottom: 10px; left: 10px;  border-width: 0 0 1px 1px; }
  .corner-br { bottom: 10px; right: 10px; border-width: 0 1px 1px 0; }

  .canvas {
    width: 100%;
    height: 100%;
    cursor: grab;
  }

  .graph3d-container {
    position: absolute;
    inset: 0;
  }

  /* === 2D/3D Mode Toggle === */

  .mode-toggle {
    display: flex;
    border: 1px solid var(--border-standard);
    border-radius: var(--radius-sm);
    overflow: hidden;
  }

  .mode-btn {
    padding: 2px 8px;
    font-size: 10px;
    font-weight: 500;
    font-family: var(--font-mono);
    color: var(--text-tertiary);
    background: transparent;
    border: none;
    cursor: pointer;
    letter-spacing: 0.04em;
  }

  .mode-btn:hover {
    color: var(--text-secondary);
    background: var(--bg-elevated);
  }

  .mode-btn-active {
    color: var(--accent-seal);
    background: var(--accent-seal-dim);
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

  /* === Logs === */
  
  .logs-container {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-height: 0;
  }

  .logs-filters {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-3);
    border-bottom: 1px solid var(--border-subtle);
    flex-shrink: 0;
  }

  .logs-filters .filter-select {
    font-size: 11px;
    padding: 4px 8px;
    min-width: 100px;
  }

  .checkbox-label {
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: 11px;
    color: var(--text-secondary);
    cursor: pointer;
  }

  .checkbox-label input {
    margin: 0;
  }

  .streaming-indicator {
    color: var(--success);
    font-size: 11px;
    font-weight: 500;
    animation: pulse 2s infinite;
  }

  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.5; }
  }

  .streaming-badge {
    background: var(--success);
    color: var(--bg-canvas);
    font-size: 9px;
    font-weight: 600;
    padding: 2px 6px;
    border-radius: 3px;
    animation: pulse 2s infinite;
  }

  .logs-scroll {
    flex: 1;
    overflow-y: auto;
    padding: var(--space-2);
    font-family: var(--font-mono);
    font-size: 11px;
    line-height: 1.6;
  }

  .logs-empty {
    padding: var(--space-8);
    text-align: center;
    color: var(--text-tertiary);
    font-family: var(--font-sans);
    font-size: 13px;
  }

  .log-entry {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: var(--space-1);
    padding: 2px 0;
    border-bottom: 1px solid var(--border-subtle);
  }

  .log-entry:last-child {
    border-bottom: none;
  }

  .log-time {
    color: var(--text-tertiary);
    flex-shrink: 0;
  }

  .log-level {
    font-weight: 600;
    flex-shrink: 0;
    min-width: 40px;
  }

  .log-debug .log-level { color: var(--text-tertiary); }
  .log-info .log-level { color: var(--accent-seal); }
  .log-warn .log-level { color: var(--warning); }
  .log-error .log-level { color: var(--error); }

  .log-category {
    color: var(--text-secondary);
    flex-shrink: 0;
  }

  .log-message {
    color: var(--text-primary);
  }

  .log-duration {
    color: var(--text-tertiary);
  }

  .log-data {
    color: var(--text-tertiary);
    font-size: 10px;
    max-width: 300px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .log-error {
    width: 100%;
    color: var(--error);
    padding-left: 60px;
    font-size: 10px;
  }

  .btn-icon.streaming {
    color: var(--success);
  }

  /* === Secrets === */

  .secrets-container {
    height: 100%;
    display: flex;
    flex-direction: column;
    padding: 16px;
    gap: 16px;
    overflow: hidden;
  }

  .secrets-add {
    display: flex;
    gap: 8px;
    flex-shrink: 0;
  }

  .secrets-input {
    flex: 1;
    padding: 8px 12px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--bg-secondary);
    color: var(--text-primary);
    font-size: 13px;
  }

  .secrets-input:focus {
    outline: none;
    border-color: var(--accent-seal);
  }

  .secrets-list {
    flex: 1;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .secrets-empty {
    padding: 32px;
    text-align: center;
    color: var(--text-tertiary);
  }

  .secret-item {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px 16px;
    background: var(--bg-secondary);
    border-radius: 8px;
    border: 1px solid var(--border);
  }

  .secret-name {
    flex: 1;
    font-family: var(--mono);
    font-size: 13px;
    color: var(--text-primary);
  }

  .secret-value {
    color: var(--text-tertiary);
    font-family: var(--mono);
    font-size: 12px;
  }

  .btn-danger-small {
    padding: 4px 10px;
    font-size: 11px;
    background: transparent;
    border: 1px solid var(--error);
    color: var(--error);
    border-radius: 4px;
    cursor: pointer;
  }

  .btn-danger-small:hover:not(:disabled) {
    background: var(--error);
    color: white;
  }

  .btn-danger-small:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  /* === Skills === */

  .skills-container {
    height: 100%;
    display: flex;
    flex-direction: column;
    padding: 16px;
    gap: 16px;
    overflow: hidden;
  }

  .skills-search {
    display: flex;
    gap: 8px;
    flex-shrink: 0;
  }

  .skills-search-input {
    flex: 1;
    padding: 8px 12px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--bg-secondary);
    color: var(--text-primary);
    font-size: 13px;
  }

  .skills-search-input:focus {
    outline: none;
    border-color: var(--accent-seal);
  }

  .skills-section {
    display: flex;
    flex-direction: column;
    gap: 8px;
    flex: 1;
    min-height: 0;
  }

  .skills-section-title {
    font-size: 12px;
    font-weight: 500;
    color: var(--text-secondary);
    text-transform: uppercase;
    letter-spacing: 0.5px;
    flex-shrink: 0;
  }

  .skills-list {
    flex: 1;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .skills-empty {
    padding: 32px;
    text-align: center;
    color: var(--text-tertiary);
  }

  .skill-item {
    padding: 12px 16px;
    background: var(--bg-secondary);
    border-radius: 8px;
    border: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .skill-item.skill-selected {
    border-color: var(--accent-seal);
  }

  .skill-info {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .skill-name {
    font-family: var(--mono);
    font-size: 13px;
    font-weight: 500;
    color: var(--text-primary);
  }

  .skill-badge {
    font-size: 10px;
    padding: 2px 6px;
    border-radius: 4px;
    text-transform: uppercase;
  }

  .skill-badge.installed {
    background: var(--success);
    color: white;
  }

  .skill-badge.builtin {
    background: var(--accent-seal);
    color: white;
  }

  .skill-badge.invocable {
    background: var(--bg-tertiary);
    color: var(--text-secondary);
    font-family: var(--mono);
    text-transform: none;
  }

  .skill-description {
    font-size: 12px;
    color: var(--text-secondary);
    line-height: 1.4;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  .skill-actions {
    display: flex;
    gap: 8px;
    margin-top: 4px;
  }

  .btn-primary-small {
    padding: 4px 10px;
    font-size: 11px;
    background: var(--accent-seal);
    border: none;
    color: white;
    border-radius: 4px;
    cursor: pointer;
  }

  .btn-primary-small:hover:not(:disabled) {
    opacity: 0.9;
  }

  .btn-primary-small:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  /* === Responsive === */
  
  @media (max-width: 1024px) {
    .sidebar-right { display: none; }
  }

  @media (max-width: 768px) {
    .sidebar-left { display: none; }
  }
</style>

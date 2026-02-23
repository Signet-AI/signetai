// Rich daemon state for Phase 1

export interface RecentMemory {
  id: string;
  content: string;
  created_at: string;
  who: string;
  importance: number;
}

export type DaemonState =
  | { readonly kind: "unknown" }
  | {
      readonly kind: "running";
      readonly version: string;
      readonly pid: number;
      readonly uptime: number;
      // Diagnostics
      readonly healthScore: number | null;
      readonly healthStatus: string | null;
      // Memory stats
      readonly memoryCount: number | null;
      readonly memoriesWithEmbeddings: number | null;
      readonly criticalMemories: number | null;
      readonly memoriesToday: number | null;
      // Embedding info
      readonly embeddingProvider: string | null;
      readonly embeddingModel: string | null;
      readonly embeddingAvailable: boolean | null;
      // Queue
      readonly queueDepth: number | null;
      // Recent memories
      readonly recentMemories: RecentMemory[];
      // Ingestion rate (memories/hour)
      readonly ingestionRate: number | null;
      // Perception
      readonly perceptionActive: boolean | null;
      readonly perceptionChannels: string[] | null;
      readonly perceptionCapturesToday: number | null;
      readonly perceptionSkillsCount: number | null;
    }
  | { readonly kind: "stopped" }
  | { readonly kind: "error"; readonly message: string };

// --- Multi-endpoint polling data ---

interface HealthData {
  version: string;
  pid: number;
  uptime: number;
}

interface MemoriesData {
  memories: RecentMemory[];
  stats: {
    total: number;
    withEmbeddings: number;
    critical: number;
  };
  memoriesToday: number;
}

interface DiagnosticsData {
  healthScore: number;
  healthStatus: string;
  queueDepth: number;
}

interface EmbeddingsData {
  provider: string;
  model: string;
  available: boolean;
}

// Accumulated state from all endpoints
let healthData: HealthData | null = null;
let memoriesData: MemoriesData | null = null;
let diagnosticsData: DiagnosticsData | null = null;
let embeddingsData: EmbeddingsData | null = null;

// Perception data
interface PerceptionData {
  running: boolean;
  channels: string[];
  capturesToday: number;
  skillsCount: number;
}

let perceptionData: PerceptionData | null = null;

// For ingestion rate tracking
let lastMemoryCount: number | null = null;
let lastMemoryCountTime: number | null = null;
let currentIngestionRate: number | null = null;

function countMemoriesToday(memories: any[]): number {
  const todayMidnight = new Date();
  todayMidnight.setHours(0, 0, 0, 0);
  const midnightTs = todayMidnight.getTime();

  let count = 0;
  for (const m of memories) {
    if (m.created_at) {
      const ts = new Date(m.created_at).getTime();
      if (ts >= midnightTs) count++;
    }
  }
  return count;
}

export async function fetchHealth(baseUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/health`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return false;
    const data = await res.json();
    healthData = {
      version: data.version,
      pid: data.pid,
      uptime: data.uptime,
    };
    return true;
  } catch {
    healthData = null;
    return false;
  }
}

export async function fetchMemories(baseUrl: string): Promise<void> {
  try {
    const res = await fetch(`${baseUrl}/api/memories?limit=10`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return;
    const data = await res.json();

    const totalCount = data.stats?.total ?? 0;
    const now = Date.now();

    // Calculate ingestion rate
    if (lastMemoryCount !== null && lastMemoryCountTime !== null) {
      const deltaCount = totalCount - lastMemoryCount;
      const deltaHours = (now - lastMemoryCountTime) / (1000 * 60 * 60);
      if (deltaHours > 0 && deltaCount >= 0) {
        // Exponential moving average
        const instantRate = deltaCount / deltaHours;
        if (currentIngestionRate === null) {
          currentIngestionRate = instantRate;
        } else {
          currentIngestionRate = 0.3 * instantRate + 0.7 * currentIngestionRate;
        }
      }
    }
    lastMemoryCount = totalCount;
    lastMemoryCountTime = now;

    const memories: RecentMemory[] = (data.memories ?? []).map((m: any) => ({
      id: m.id ?? "",
      content: m.content ?? "",
      created_at: m.created_at ?? "",
      who: m.who ?? "unknown",
      importance: m.importance ?? 0,
    }));

    // Use all memories from response to estimate today count  
    // (the API only returns limit=10, but stats.total is accurate)
    // For memoriesToday we count from returned set - this is approximate
    const memoriesToday = countMemoriesToday(memories);

    memoriesData = {
      memories,
      stats: {
        total: data.stats?.total ?? 0,
        withEmbeddings: data.stats?.withEmbeddings ?? 0,
        critical: data.stats?.critical ?? 0,
      },
      memoriesToday,
    };
  } catch {
    // Keep stale data
  }
}

export async function fetchDiagnostics(baseUrl: string): Promise<void> {
  try {
    const res = await fetch(`${baseUrl}/api/diagnostics`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return;
    const data = await res.json();

    diagnosticsData = {
      healthScore: data.composite?.score ?? 0,
      healthStatus: data.composite?.status ?? "unknown",
      queueDepth: data.queue?.depth ?? 0,
    };
  } catch {
    // Keep stale data
  }
}

export async function fetchEmbeddings(baseUrl: string): Promise<void> {
  try {
    const res = await fetch(`${baseUrl}/api/embeddings/status`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return;
    const data = await res.json();

    embeddingsData = {
      provider: data.provider ?? "unknown",
      model: data.model ?? "unknown",
      available: data.available ?? false,
    };
  } catch {
    // Keep stale data
  }
}

export async function fetchPerception(baseUrl: string): Promise<void> {
  try {
    const res = await fetch(`${baseUrl}/api/perception/status`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      perceptionData = null;
      return;
    }
    const data = await res.json();

    const adapters = data.adapters || {};
    const channels: string[] = [];
    let totalCaptures = 0;

    for (const [key, info] of Object.entries(adapters) as [string, any][]) {
      if (info.enabled) channels.push(key);
      totalCaptures += info.captureCount || 0;
    }

    perceptionData = {
      running: data.running === true,
      channels,
      capturesToday: totalCaptures,
      skillsCount: data.skillsCount || 0,
    };
  } catch {
    // Perception endpoints may not exist yet — that's fine
    perceptionData = null;
  }
}

export function buildCurrentState(): DaemonState {
  if (!healthData) {
    return { kind: "stopped" };
  }

  // Calculate embedding coverage
  const total = memoriesData?.stats.total ?? 0;
  const withEmbeddings = memoriesData?.stats.withEmbeddings ?? 0;

  return {
    kind: "running",
    version: healthData.version,
    pid: healthData.pid,
    uptime: healthData.uptime,
    healthScore: diagnosticsData?.healthScore ?? null,
    healthStatus: diagnosticsData?.healthStatus ?? null,
    memoryCount: memoriesData?.stats.total ?? null,
    memoriesWithEmbeddings: memoriesData?.stats.withEmbeddings ?? null,
    criticalMemories: memoriesData?.stats.critical ?? null,
    memoriesToday: memoriesData?.memoriesToday ?? null,
    embeddingProvider: embeddingsData?.provider ?? null,
    embeddingModel: embeddingsData?.model ?? null,
    embeddingAvailable: embeddingsData?.available ?? null,
    queueDepth: diagnosticsData?.queueDepth ?? null,
    recentMemories: memoriesData?.memories ?? [],
    ingestionRate: currentIngestionRate,
    perceptionActive: perceptionData?.running ?? null,
    perceptionChannels: perceptionData?.channels ?? null,
    perceptionCapturesToday: perceptionData?.capturesToday ?? null,
    perceptionSkillsCount: perceptionData?.skillsCount ?? null,
  };
}

export function resetState(): void {
  healthData = null;
  memoriesData = null;
  diagnosticsData = null;
  embeddingsData = null;
  perceptionData = null;
}

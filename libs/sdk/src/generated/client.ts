/** AUTO-GENERATED — DO NOT EDIT. Source: scripts/routes.json native HTTP contract. */
export class GeneratedClient {
  constructor(private readonly transport: {
    readonly get: <T>(path: string, query?: Record<string, unknown>) => Promise<T>;
    readonly post: <T>(path: string, body?: unknown) => Promise<T>;
    readonly put: <T>(path: string, body?: unknown) => Promise<T>;
    readonly patch: <T>(path: string, body?: unknown) => Promise<T>;
    readonly del: <T>(path: string, query?: Record<string, unknown>) => Promise<T>;
  }) {}

  async getHealthLive(query?: Record<string, unknown>): Promise<unknown> {
    return this.transport.get<unknown>(`/health/live`, query);
  }

  async getHealthReady(query?: Record<string, unknown>): Promise<unknown> {
    return this.transport.get<unknown>(`/health/ready`, query);
  }

  async getHealth(query?: Record<string, unknown>): Promise<unknown> {
    return this.transport.get<unknown>(`/health`, query);
  }

  async getApiStatus(query?: Record<string, unknown>): Promise<unknown> {
    return this.transport.get<unknown>(`/api/status`, query);
  }

  async getApiPipelineStatus(query?: Record<string, unknown>): Promise<unknown> {
    return this.transport.get<unknown>(`/api/pipeline/status`, query);
  }

  async getApiSources(query?: Record<string, unknown>): Promise<unknown> {
    return this.transport.get<unknown>(`/api/sources`, query);
  }

  async postApiImportDocuments(opts?: Record<string, unknown>): Promise<unknown> {
    return this.transport.post<unknown>(`/api/import/documents`, opts);
  }

  async postApiSourcesDocuments(opts?: Record<string, unknown>): Promise<unknown> {
    return this.transport.post<unknown>(`/api/sources/documents`, opts);
  }

  async getApiAuthWhoami(query?: Record<string, unknown>): Promise<unknown> {
    return this.transport.get<unknown>(`/api/auth/whoami`, query);
  }

  async postApiMemoryRemember(opts?: Record<string, unknown>): Promise<unknown> {
    return this.transport.post<unknown>(`/api/memory/remember`, opts);
  }

  async postApiMemorySave(opts?: Record<string, unknown>): Promise<unknown> {
    return this.transport.post<unknown>(`/api/memory/save`, opts);
  }

  async postApiMemoryRecall(opts?: Record<string, unknown>): Promise<unknown> {
    return this.transport.post<unknown>(`/api/memory/recall`, opts);
  }

  async getApiMemorySearch(query?: Record<string, unknown>): Promise<unknown> {
    return this.transport.get<unknown>(`/api/memory/search`, query);
  }

  async getMemorySearch(query?: Record<string, unknown>): Promise<unknown> {
    return this.transport.get<unknown>(`/memory/search`, query);
  }

  async getApiMemories(query?: Record<string, unknown>): Promise<unknown> {
    return this.transport.get<unknown>(`/api/memories`, query);
  }

  async getApiMemoryByIdHistory(id: string, query?: Record<string, unknown>): Promise<unknown> {
    return this.transport.get<unknown>(`/api/memory/${id}/history`, query);
  }

  async postApiMemoryByIdRecover(id: string, opts?: Record<string, unknown>): Promise<unknown> {
    return this.transport.post<unknown>(`/api/memory/${id}/recover`, opts);
  }

  async getApiFeatures(query?: Record<string, unknown>): Promise<unknown> {
    return this.transport.get<unknown>(`/api/features`, query);
  }

  async getApiConfig(query?: Record<string, unknown>): Promise<unknown> {
    return this.transport.get<unknown>(`/api/config`, query);
  }

  async getApiConnectors(query?: Record<string, unknown>): Promise<unknown> {
    return this.transport.get<unknown>(`/api/connectors`, query);
  }

  async getApiIntegrations(query?: Record<string, unknown>): Promise<unknown> {
    return this.transport.get<unknown>(`/api/integrations`, query);
  }

  async getHealthIntegrations(query?: Record<string, unknown>): Promise<unknown> {
    return this.transport.get<unknown>(`/health/integrations`, query);
  }

  async postApiJobs(opts?: Record<string, unknown>): Promise<unknown> {
    return this.transport.post<unknown>(`/api/jobs`, opts);
  }

  async getApiOntologyByKind(kind: string, query?: Record<string, unknown>): Promise<unknown> {
    return this.transport.get<unknown>(`/api/ontology/${kind}`, query);
  }

  async getApiOntologyByKindById(kind: string, id: string, query?: Record<string, unknown>): Promise<unknown> {
    return this.transport.get<unknown>(`/api/ontology/${kind}/${id}`, query);
  }

  async getApiClaims(query?: Record<string, unknown>): Promise<unknown> {
    return this.transport.get<unknown>(`/api/claims`, query);
  }
}

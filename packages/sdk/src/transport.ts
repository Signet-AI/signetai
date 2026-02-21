import {
  SignetApiError,
  SignetNetworkError,
  SignetTimeoutError,
} from "./errors.js";

export interface TransportConfig {
  readonly baseUrl: string;
  readonly timeoutMs: number;
  readonly retries: number;
  readonly retryDelayMs: number;
  readonly headers?: Readonly<Record<string, string>>;
}

const DEFAULT_CONFIG: TransportConfig = {
  baseUrl: "http://localhost:3850",
  timeoutMs: 10_000,
  retries: 2,
  retryDelayMs: 500,
};

const IDEMPOTENT_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

interface RequestOptions {
  readonly body?: unknown;
  readonly query?: Record<string, string | number | boolean | undefined>;
  readonly signal?: AbortSignal;
}

export class SignetTransport {
  private readonly config: TransportConfig;

  constructor(config?: Partial<TransportConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  async request<T>(
    method: string,
    path: string,
    opts?: RequestOptions,
  ): Promise<T> {
    const url = this.buildUrl(path, opts?.query);
    const headers: Record<string, string> = {
      ...this.config.headers,
    };

    if (opts?.body !== undefined) {
      headers["Content-Type"] = "application/json";
    }

    const canRetry = IDEMPOTENT_METHODS.has(method.toUpperCase());
    const maxAttempts = canRetry ? this.config.retries + 1 : 1;

    let lastError: Error | undefined;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (attempt > 0) {
        await sleep(this.config.retryDelayMs * attempt);
      }

      try {
        const response = await fetch(url, {
          method,
          headers,
          body: opts?.body !== undefined
            ? JSON.stringify(opts.body)
            : undefined,
          signal: opts?.signal ?? AbortSignal.timeout(this.config.timeoutMs),
        });

        if (!response.ok) {
          let body: unknown;
          try {
            body = await response.json();
          } catch {
            body = await response.text().catch(() => null);
          }
          throw new SignetApiError(response.status, body);
        }

        return (await response.json()) as T;
      } catch (error) {
        if (error instanceof SignetApiError) {
          // API errors are not retryable
          throw error;
        }

        if (error instanceof DOMException && error.name === "TimeoutError") {
          lastError = new SignetTimeoutError(this.config.timeoutMs);
        } else if (error instanceof Error) {
          lastError = new SignetNetworkError(error.message, error);
        } else {
          lastError = new SignetNetworkError(
            "Unknown network error",
            new Error(String(error)),
          );
        }
      }
    }

    throw lastError;
  }

  async get<T>(
    path: string,
    query?: Record<string, string | number | boolean | undefined>,
  ): Promise<T> {
    return this.request<T>("GET", path, { query });
  }

  async post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>("POST", path, { body });
  }

  async patch<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>("PATCH", path, { body });
  }

  async del<T>(
    path: string,
    query?: Record<string, string | number | boolean | undefined>,
  ): Promise<T> {
    return this.request<T>("DELETE", path, { query });
  }

  private buildUrl(
    path: string,
    query?: Record<string, string | number | boolean | undefined>,
  ): string {
    const base = this.config.baseUrl.replace(/\/+$/, "");
    const url = new URL(`${base}${path}`);

    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined) {
          url.searchParams.set(key, String(value));
        }
      }
    }

    return url.toString();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

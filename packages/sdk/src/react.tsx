/**
 * React bindings for @signet/sdk.
 * Uses the HTTP client (SignetClient), not direct DB access.
 */

import React, {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { SignetClient, type SignetClientConfig } from "./index.js";
import type { MemoryRecord, RecallResult } from "./types.js";

// --- Context ---

interface SignetContextValue {
  client: SignetClient;
  connected: boolean;
  error: Error | null;
}

const SignetContext = createContext<SignetContextValue | null>(null);

// --- Provider ---

interface SignetProviderProps {
  client?: SignetClient;
  config?: SignetClientConfig;
  children: ReactNode;
}

export function SignetProvider({
  client: externalClient,
  config,
  children,
}: SignetProviderProps) {
  const client = useMemo(
    () => externalClient ?? new SignetClient(config),
    [externalClient, config],
  );

  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    const controller = new AbortController();

    client
      .health()
      .then(() => {
        if (!controller.signal.aborted) setConnected(true);
      })
      .catch((err: unknown) => {
        if (!controller.signal.aborted) setError(err as Error);
      });

    return () => controller.abort();
  }, [client]);

  return (
    <SignetContext.Provider value={{ client, connected, error }}>
      {children}
    </SignetContext.Provider>
  );
}

// --- Hooks ---

export function useSignet(): SignetContextValue {
  const context = useContext(SignetContext);
  if (!context) {
    throw new Error("useSignet must be used within a SignetProvider");
  }
  return context;
}

interface AsyncState<T> {
  data: T | null;
  loading: boolean;
  error: Error | null;
}

export function useMemorySearch(
  query: string | null,
  opts?: { readonly limit?: number; readonly type?: string },
): AsyncState<readonly RecallResult[]> {
  const { client } = useSignet();
  const [state, setState] = useState<AsyncState<readonly RecallResult[]>>({
    data: null,
    loading: false,
    error: null,
  });

  useEffect(() => {
    if (!query) {
      setState({ data: null, loading: false, error: null });
      return;
    }

    const controller = new AbortController();
    setState((prev) => ({ ...prev, loading: true, error: null }));

    client
      .recall(query, opts)
      .then((response) => {
        if (!controller.signal.aborted) {
          setState({ data: response.results, loading: false, error: null });
        }
      })
      .catch((err: unknown) => {
        if (!controller.signal.aborted) {
          setState({ data: null, loading: false, error: err as Error });
        }
      });

    return () => controller.abort();
  }, [client, query, opts?.limit, opts?.type]);

  return state;
}

export function useMemory(
  id: string | null,
): AsyncState<MemoryRecord> {
  const { client } = useSignet();
  const [state, setState] = useState<AsyncState<MemoryRecord>>({
    data: null,
    loading: false,
    error: null,
  });

  useEffect(() => {
    if (!id) {
      setState({ data: null, loading: false, error: null });
      return;
    }

    const controller = new AbortController();
    setState((prev) => ({ ...prev, loading: true, error: null }));

    client
      .getMemory(id)
      .then((memory) => {
        if (!controller.signal.aborted) {
          setState({ data: memory, loading: false, error: null });
        }
      })
      .catch((err: unknown) => {
        if (!controller.signal.aborted) {
          setState({ data: null, loading: false, error: err as Error });
        }
      });

    return () => controller.abort();
  }, [client, id]);

  return state;
}

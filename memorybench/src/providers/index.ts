import type { Provider, ProviderName } from "../types/provider"
import type { ConcurrencyConfig } from "../types/concurrency"
import { SupermemoryProvider } from "./supermemory"
import { Mem0Provider } from "./mem0"
import { ZepProvider } from "./zep"
import { FilesystemProvider } from "./filesystem"
import { RAGProvider } from "./rag"
import { SignetProvider, SignetSupermemoryParityProvider } from "./signet"

const providers: Record<ProviderName, new () => Provider> = {
  supermemory: SupermemoryProvider,
  mem0: Mem0Provider,
  zep: ZepProvider,
  filesystem: FilesystemProvider,
  rag: RAGProvider,
  signet: SignetProvider,
  "signet-supermemory-parity": SignetSupermemoryParityProvider,
}

export function createProvider(name: ProviderName): Provider {
  const ProviderClass = providers[name]
  if (!ProviderClass) {
    throw new Error(`Unknown provider: ${name}. Available: ${Object.keys(providers).join(", ")}`)
  }
  return new ProviderClass()
}

export function getAvailableProviders(): ProviderName[] {
  return Object.keys(providers) as ProviderName[]
}

export function getProviderInfo(name: ProviderName): {
  name: string
  displayName: string
  concurrency: ConcurrencyConfig | null
} {
  const provider = createProvider(name)
  return {
    name,
    displayName: name.charAt(0).toUpperCase() + name.slice(1),
    concurrency: provider.concurrency || null,
  }
}

export {
  SupermemoryProvider,
  Mem0Provider,
  ZepProvider,
  FilesystemProvider,
  RAGProvider,
  SignetProvider,
  SignetSupermemoryParityProvider,
}

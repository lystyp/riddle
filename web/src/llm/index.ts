// Wiring: pick the concrete provider for a parsed oracle.env config —
// the one file that knows every vendor. Adding a vendor is a new
// provider file plus one case here; nothing above LlmProvider changes.

import { AnthropicProvider } from "./anthropic";
import { OpenAiProvider } from "./openai";
import type { LlmProvider, ProviderConfig, ProviderKind } from "./provider";

export type {
  ChatRequest,
  ChatTurn,
  LlmProvider,
  ProviderConfig,
  ProviderKind,
} from "./provider";

export function createProvider(kind: ProviderKind, cfg: ProviderConfig): LlmProvider {
  switch (kind) {
    case "openai":
      return new OpenAiProvider(cfg);
    case "anthropic":
      return new AnthropicProvider(cfg);
  }
}

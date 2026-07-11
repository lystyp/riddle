// The seam between the oracle's conversation semantics and any one
// vendor's wire format. A provider owns transport — endpoint, auth,
// message-shape assembly, and turning the vendor's stream into plain
// text fragments. Everything above (session memory, prompts, the reply
// DSL) lives in oracle.ts and never sees a wire format.

/** Which vendor an oracle.env selects; each has its own RIDDLE_<KIND>_* vars. */
export type ProviderKind = "openai" | "anthropic";

/** One finished text-only turn riding along as conversation history. */
export interface ChatTurn {
  userText: string;
  assistantRaw: string;
}

/**
 * A provider-neutral chat request: pure semantics, no wire format.
 * History is text-only; the page snapshot rides on the current turn only,
 * so the payload does not grow with the session.
 */
export interface ChatRequest {
  system: string;
  turns: ChatTurn[];
  userText: string;
  /** PNG data URL of the page snapshot, attached to the current turn. */
  imageDataUrl: string;
  maxTokens: number;
  /** Reasoning-effort hint; values are vendor-specific, null = vendor default. */
  effort: string | null;
}

export interface LlmProvider {
  /**
   * Stream the reply as raw text fragments; resolves when the reply ends.
   * Throws on transport errors, HTTP errors, and vendor-side refusals.
   */
  stream(req: ChatRequest, onText: (fragment: string) => void): Promise<void>;
  /** One-shot completion: the whole reply as a single string. */
  complete(req: ChatRequest): Promise<string>;
}

/** What a provider needs from oracle.env to reach its endpoint. */
export interface ProviderConfig {
  key: string;
  base: string;
  model: string;
}

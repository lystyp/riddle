// Anthropic Messages API provider (Claude). Every divergence from the
// OpenAI-compatible shape is absorbed here: system is a top-level field,
// the snapshot becomes a base64 source block (no data-URI prefix), the
// SSE stream is typed events (text deltas are the page text; thinking
// deltas are not), and the reasoning-effort hint rides in output_config.
//
// Fable 5 specifics: thinking is always on (any explicit `thinking`
// field is a 400, so none is ever sent), and safety classifiers can
// decline a request — Fable/Mythos requests therefore carry a
// server-side fallback to Opus 4.8, and a refusal that survives the
// whole chain surfaces as an error instead of a silent empty reply.
// Direct browser calls need the dangerous-direct-browser-access header,
// or CORS blocks them.

import type { ChatRequest, LlmProvider, ProviderConfig } from "./provider";
import { sseData } from "./sse";

/** Where a declined Fable/Mythos request is re-served, same call. */
const FALLBACK_MODEL = "claude-opus-4-8";
const FALLBACK_BETA = "server-side-fallback-2026-06-01";
const API_VERSION = "2023-06-01";
const REFUSED = "refused by the model's safety classifiers";

/**
 * Assemble the request body: history as plain text pairs, the current
 * turn with the snapshot as a base64 image block.
 */
export function anthropicBody(
  req: ChatRequest,
  model: string,
  stream: boolean,
): Record<string, unknown> {
  const messages: unknown[] = [];
  for (const t of req.turns) {
    messages.push({ role: "user", content: t.userText });
    messages.push({ role: "assistant", content: t.assistantRaw });
  }
  messages.push({
    role: "user",
    content: [
      { type: "text", text: req.userText },
      { type: "image", source: imageSource(req.imageDataUrl) },
    ],
  });
  const body: Record<string, unknown> = {
    model,
    stream,
    max_tokens: req.maxTokens,
    system: req.system,
    messages,
  };
  if (req.effort !== null) body.output_config = { effort: req.effort };
  // Only Fable/Mythos list Opus 4.8 among their allowed fallbacks; on
  // other models the parameter itself is rejected.
  if (model.startsWith("claude-fable") || model.startsWith("claude-mythos")) {
    body.fallbacks = [{ model: FALLBACK_MODEL }];
  }
  return body;
}

function imageSource(dataUrl: string): {
  type: "base64";
  media_type: string;
  data: string;
} {
  const m = /^data:([^;,]+);base64,(.*)$/s.exec(dataUrl);
  if (!m) throw new Error("snapshot is not a base64 data URL");
  return { type: "base64", media_type: m[1], data: m[2] };
}

/** What one SSE payload means to us; null = an event we don't act on. */
export type StreamEvent =
  | { kind: "text"; text: string }
  | { kind: "stop"; reason: string }
  | { kind: "error"; message: string }
  | { kind: "end" };

export function readStreamEvent(data: string): StreamEvent | null {
  try {
    const ev = JSON.parse(data);
    switch (ev?.type) {
      case "content_block_delta":
        return ev.delta?.type === "text_delta" && typeof ev.delta.text === "string"
          ? { kind: "text", text: ev.delta.text }
          : null; // thinking / input_json deltas — not page text
      case "message_delta": {
        const reason: unknown = ev.delta?.stop_reason;
        return typeof reason === "string" ? { kind: "stop", reason } : null;
      }
      case "message_stop":
        return { kind: "end" };
      case "error":
        return { kind: "error", message: String(ev.error?.message ?? "unknown") };
      default:
        return null;
    }
  } catch {
    return null;
  }
}

export class AnthropicProvider implements LlmProvider {
  constructor(private readonly cfg: ProviderConfig) {}

  async stream(req: ChatRequest, onText: (fragment: string) => void): Promise<void> {
    const resp = await this.send(req, true);
    let stopReason: string | null = null;
    stream: for await (const data of sseData(resp.body!)) {
      const ev = readStreamEvent(data);
      if (ev === null) continue;
      switch (ev.kind) {
        case "text":
          if (ev.text) onText(ev.text);
          break;
        case "stop":
          stopReason = ev.reason;
          break;
        case "error":
          throw new Error(`stream error: ${ev.message}`);
        case "end":
          break stream;
      }
    }
    if (stopReason === "refusal") throw new Error(REFUSED);
  }

  async complete(req: ChatRequest): Promise<string> {
    const resp = await this.send(req, false);
    const body: any = await resp.json();
    if (body?.stop_reason === "refusal") throw new Error(REFUSED);
    const blocks: unknown[] = Array.isArray(body?.content) ? body.content : [];
    return blocks
      .filter((b: any) => b?.type === "text" && typeof b.text === "string")
      .map((b: any) => b.text)
      .join("");
  }

  private async send(req: ChatRequest, stream: boolean): Promise<Response> {
    const resp = await fetch(`${this.cfg.base}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.cfg.key,
        "anthropic-version": API_VERSION,
        // Browser fetches are refused by CORS unless explicitly
        // acknowledged; the key lives client-side by design here (same
        // trust model as the OpenAI path).
        "anthropic-dangerous-direct-browser-access": "true",
        "anthropic-beta": FALLBACK_BETA,
      },
      body: JSON.stringify(anthropicBody(req, this.cfg.model, stream)),
    });
    if (!resp.ok) {
      const detail = await resp.text();
      throw new Error(`http ${resp.status}: ${detail.trim().slice(0, 200)}`);
    }
    return resp;
  }
}

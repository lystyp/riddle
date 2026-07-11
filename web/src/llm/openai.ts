// OpenAI-compatible /chat/completions provider — the transport half of
// the original oracle.ts, ported from boox-spike's Oracle.kt: system
// rides as messages[0], the snapshot as an image_url data URI, SSE
// deltas in choices[0].delta.content, and the max_tokens →
// max_completion_tokens retry for endpoints that insist on the newer
// field name. The mock server (mock-oracle.mjs) speaks this shape.

import type { ChatRequest, LlmProvider, ProviderConfig } from "./provider";
import { sseData } from "./sse";

type Message = { role: string; content: unknown };

/**
 * Assemble the wire messages: system, then the kept turns as plain text,
 * then the current turn with the snapshot.
 */
export function messagesJson(req: ChatRequest): Message[] {
  const msgs: Message[] = [{ role: "system", content: req.system }];
  for (const t of req.turns) {
    msgs.push({ role: "user", content: t.userText });
    msgs.push({ role: "assistant", content: t.assistantRaw });
  }
  msgs.push({
    role: "user",
    content: [
      { type: "text", text: req.userText },
      { type: "image_url", image_url: { url: req.imageDataUrl } },
    ],
  });
  return msgs;
}

/** choices[0].delta.content out of one SSE data object. */
export function sseDeltaContent(data: string): string | null {
  try {
    const content: unknown = JSON.parse(data)?.choices?.[0]?.delta?.content;
    return typeof content === "string" ? content : "";
  } catch {
    return null;
  }
}

export class OpenAiProvider implements LlmProvider {
  constructor(private readonly cfg: ProviderConfig) {}

  async stream(req: ChatRequest, onText: (fragment: string) => void): Promise<void> {
    const resp = await this.send(req, true);
    for await (const data of sseData(resp.body!)) {
      if (data === "[DONE]") break;
      const frag = sseDeltaContent(data);
      if (frag) onText(frag);
    }
  }

  async complete(req: ChatRequest): Promise<string> {
    const resp = await this.send(req, false);
    const body: unknown = await resp.json();
    const content: unknown = (body as any)?.choices?.[0]?.message?.content;
    return typeof content === "string" ? content : "";
  }

  /**
   * POST with `max_tokens`; some endpoints 400 and demand
   * `max_completion_tokens` instead — retry once under that name.
   */
  private async send(req: ChatRequest, stream: boolean): Promise<Response> {
    let resp = await this.post(req, "max_tokens", stream);
    if (resp.status === 400) {
      const detail = await resp.text();
      if (!detail.includes("max_completion_tokens")) {
        throw new Error(`http 400: ${detail.trim().slice(0, 200)}`);
      }
      console.info("oracle: endpoint wants max_completion_tokens; retrying");
      resp = await this.post(req, "max_completion_tokens", stream);
    }
    if (!resp.ok) {
      const detail = await resp.text();
      throw new Error(`http ${resp.status}: ${detail.trim().slice(0, 200)}`);
    }
    return resp;
  }

  private post(req: ChatRequest, capField: string, stream: boolean): Promise<Response> {
    const body: Record<string, unknown> = {
      model: this.cfg.model,
      stream,
      [capField]: req.maxTokens,
      messages: messagesJson(req),
    };
    if (req.effort !== null) body.reasoning_effort = req.effort;
    return fetch(`${this.cfg.base}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.cfg.key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  }
}

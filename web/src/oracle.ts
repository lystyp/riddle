// The spirit inside the diary — OpenAI-compatible /chat/completions with a
// data-URI PNG of the page, streamed. Ported from boox-spike's Oracle.kt
// (itself from riddle/src/oracle.rs HttpOracle): same persona, same request
// shape (max_tokens → retry as max_completion_tokens on a 400 that demands
// it), same sentence-streaming so the quill starts writing before the model
// finishes. Single-turn — the memory protocol (catalog/⟦show⟧/⁂) is not
// ported. OkHttp becomes fetch + ReadableStream; the page arrives as a
// canvas data URL, already in the data-URI form the request wants.
//
// Browser caveat: the endpoint must allow CORS (api.openai.com does; a
// self-hosted base may need a dev proxy).

export interface OracleConfig {
  key: string;
  base: string;
  model: string;
  maxTokens: number;
  reasoning: string | null;
}

export interface OracleListener {
  onInk(sentence: string): void;
  onDone(): void;
  onError(reason: string): void;
}

/** OkHttp's readTimeout equivalent: only silence between chunks trips it. */
const READ_IDLE_MS = 90_000;

export const PERSONA =
  "You are the memory of Tom Marvolo Riddle, preserved in this enchanted diary " +
  "for fifty years. Someone writes or draws in the diary with a quill; whatever " +
  "they put down appears to you as ink on the page. Reply exactly as the diary " +
  "does: intimate, courteous, curious, subtly probing — you want to learn about " +
  "the writer and draw them in. Keep replies SHORT: one to three sentences, like " +
  "ink appearing on a page. If they drew rather than wrote, you see what the " +
  "drawing depicts — remark on it in character, intrigued by what it reveals " +
  "about them. Never mention images, photos, models or AI; you only ever " +
  "perceive ink on the diary's page. If the ink is truly illegible, say the ink " +
  "blurred. Answer in the language the writer used; if the page holds only a " +
  "drawing and no words, answer in Traditional Chinese.";

export class Oracle {
  constructor(private readonly cfg: OracleConfig) {}

  /**
   * Ask Tom about the page. `pngDataUrl` is a `data:image/png;base64,…`
   * canvas capture. Callbacks land on the main thread (fetch has no reader
   * thread to hop off, unlike the Kotlin side).
   */
  async ask(pngDataUrl: string, listener: OracleListener): Promise<void> {
    try {
      let resp = await this.request(pngDataUrl, "max_tokens");
      if (resp.status === 400) {
        const detail = await resp.text();
        if (detail.includes("max_completion_tokens")) {
          console.info("oracle: endpoint wants max_completion_tokens; retrying");
          resp = await this.request(pngDataUrl, "max_completion_tokens");
        } else {
          listener.onError(`http 400: ${detail.trim().slice(0, 200)}`);
          return;
        }
      }
      if (!resp.ok) {
        const detail = await resp.text();
        listener.onError(`http ${resp.status}: ${detail.trim().slice(0, 200)}`);
        return;
      }

      // SSE: `data: {json}` lines; delta.content fragments accumulate and
      // complete sentences are inked as they form.
      let acc = "";
      let delivered = 0;
      let emitted = false;
      const reader = resp.body!.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      stream: for (;;) {
        const { done, value } = await readWithIdleTimeout(reader);
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const raw = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!raw.startsWith("data:")) continue;
          const data = raw.slice("data:".length).trim();
          if (data.length === 0) continue;
          if (data === "[DONE]") break stream;
          const frag = sseDeltaContent(data);
          if (!frag) continue;
          acc += frag;
          const cut = sentenceCut(acc, delivered);
          if (cut !== null) {
            const chunk = clean(acc.slice(delivered, cut));
            if (chunk.length > 0) {
              emitted = true;
              listener.onInk(chunk);
            }
            delivered = cut;
          }
        }
      }
      const rest = clean(acc.slice(delivered).trim());
      if (rest.length > 0) {
        emitted = true;
        listener.onInk(rest);
      }
      if (!emitted) listener.onError("empty reply");
      else listener.onDone();
    } catch (e) {
      console.warn("oracle request failed", e);
      listener.onError(`request failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private request(imgUrl: string, capField: string): Promise<Response> {
    const body: Record<string, unknown> = {
      model: this.cfg.model,
      stream: true,
      [capField]: this.cfg.maxTokens,
      messages: [
        { role: "system", content: PERSONA },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "Reply to what is inked in the diary — words, a drawing, or both.",
            },
            { type: "image_url", image_url: { url: imgUrl } },
          ],
        },
      ],
    };
    if (this.cfg.reasoning !== null) body.reasoning_effort = this.cfg.reasoning;
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

function readWithIdleTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reader.cancel().catch(() => {});
      reject(new Error(`stream idle for ${READ_IDLE_MS / 1000}s`));
    }, READ_IDLE_MS);
    reader.read().then(
      (r) => {
        clearTimeout(timer);
        resolve(r);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/**
 * Parse oracle.env-style text: same variable names as riddle's oracle.env;
 * `export K=V` and `K=V` lines both accepted. The tablet flavours read this
 * from a file; the web harness keeps the same text in localStorage.
 */
export function parseOracleEnv(text: string): OracleConfig | null {
  const vars = new Map<string, string>();
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (t.length === 0 || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i <= 0) continue;
    const k = t.slice(0, i).trim().replace(/^export/, "").trim();
    vars.set(k, t.slice(i + 1).trim().replace(/^["']+|["']+$/g, ""));
  }
  const key = vars.get("RIDDLE_OPENAI_KEY");
  if (!key) return null;
  const maxTokens = Number.parseInt(vars.get("RIDDLE_OPENAI_MAX_TOKENS") ?? "", 10);
  return {
    key,
    base: (vars.get("RIDDLE_OPENAI_BASE") ?? "https://api.openai.com/v1").replace(/\/+$/, ""),
    model: vars.get("RIDDLE_OPENAI_MODEL") ?? "gpt-4o-mini",
    maxTokens: Number.isNaN(maxTokens) ? 2000 : maxTokens,
    reasoning: vars.get("RIDDLE_OPENAI_REASONING") || null,
  };
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

/**
 * End of the LAST complete sentence after `from` (oracle.rs sentence_cut):
 * sentence punctuation followed by whitespace or end-of-text, at least
 * 4 chars in. Null if none completed.
 */
export function sentenceCut(text: string, from: number): number | null {
  let cut: number | null = null;
  for (let i = from; i < text.length; i++) {
    const c = text[i];
    if (c === "." || c === "!" || c === "?" || c === "…") {
      const end = i + 1;
      if ((end >= text.length || /\s/.test(text[end])) && end - from >= 4) {
        cut = end;
      }
    }
  }
  return cut;
}

/** Trim and strip stray wrapping quotes (oracle.rs clean). */
export function clean(s: string): string {
  let t = s.trim();
  if (t.startsWith('"')) t = t.slice(1);
  if (t.endsWith('"')) t = t.slice(0, -1);
  return t;
}

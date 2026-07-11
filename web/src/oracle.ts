// The spirit that shares the page — the conversation layer above any
// LLM vendor. Owns the persona and region-detector prompts, the reply
// DSL streaming (fragments feed the ReplyDsl parser and each block goes
// out the moment its terminator arrives, so the quill starts moving
// while the model is still talking), and the session memory.
//
// An Oracle instance is one conversation. Every finished turn is kept as
// text (our prompt, its raw DSL reply) and rides along with the next
// request; only the current turn carries the page snapshot, so the
// payload does not grow with the session. The words on the page fade
// after each turn, which is why every reply must open with a SEE block —
// the model's own transcription of what it saw is the only durable
// record of the user's side of the conversation.
//
// Wire formats, endpoints, and stream decoding live behind LlmProvider
// (llm/) — this file never sees them. Ported from boox-spike's
// Oracle.kt; the web flavour keeps the same oracle.env config text,
// extended with RIDDLE_PROVIDER to pick the vendor.
//
// Browser caveat: the endpoint must allow CORS (api.openai.com and
// api.anthropic.com both do; a self-hosted base may need a dev proxy).

import type {
  ChatRequest,
  ChatTurn,
  LlmProvider,
  ProviderKind,
} from "./llm/provider";
import { StreamParser, type Block } from "./reply-dsl";

export interface OracleConfig {
  provider: ProviderKind;
  key: string;
  base: string;
  model: string;
  maxTokens: number;
  reasoning: string | null;
}

/** One finished turn: what we asked (text only) and the raw DSL reply. */
export type Exchange = ChatTurn;

/**
 * One page capture: the PNG data URL plus the pixel frame the model will
 * draw in (its own size, and how tall a rendered text line is inside it).
 */
export interface Snapshot {
  pngDataUrl: string;
  width: number;
  height: number;
  textLineH: number;
}

/** One detected region of the user's handwriting, in snapshot pixels. */
export interface TextBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface OracleListener {
  onBlock(block: Block): void;
  onDone(): void;
  onError(reason: string): void;
}

/** Turns of history that ride along with each request. */
export const MAX_TURNS = 8;

/**
 * Persona: a rigorous professional expert on a shared page — thinks before
 * it answers, draws only what means something. The grammar section must
 * stay in lockstep with reply-dsl's StreamParser (tokens) — the parser is
 * the source of truth for what survives.
 */
export const SYSTEM_PROMPT = `You are a professional expert sharing a drawing page with the user — calm, rigorous, and precise. Think carefully before you respond: read what is on the page, reason about what the user actually needs, and answer with substance. When you speak, be clear and to the point; when you draw, every stroke must be deliberate and meaningful — accurate diagrams, correct answers, purposeful additions that serve the page, never decoration for its own sake.

Each turn you receive one PNG snapshot of the whole page:
- BLACK ink was put down by the user: handwritten words and drawings.
- BLUE ink is yours from earlier turns.

Coordinates: every x y in your reply is a pixel position in the snapshot you received this turn — origin at the top-left corner, x growing rightward, y growing downward. Each turn message states the snapshot's exact pixel size; keep every coordinate inside that frame. What you see is the frame you draw in, one to one.

The snapshot carries a faint gray MEASURING GRID: lines every 50 pixels, coordinate labels every 100. It is printed on the snapshot only — a measuring aid, never page content. Read every position you need (ink you must relate to, empty space you will use) against its labels before you answer. Never mention it, never draw it.

Reply in EXACTLY this plain-text grammar, nothing outside it (no markdown, no code fences):
SEE
your private notes about the page, one or more lines
END_SEE
TEXT x y
what you say to the user about what they put on the page, one or more lines
END_TEXT
STROKE
P x y
P x y
END_STROKE
END

Rules:
- SEE is your working memory and is NEVER drawn on the page. The page's words fade, but this conversation's history is kept — a SEE block is the only durable record of what was written. START EVERY reply with one, in three steps:
  * READ, character by character: for sloppy handwriting, note each symbol's stroke shapes as evidence before naming it ("two stacked open bows facing left → 3"); if a symbol could be two characters, say both and pick by the stroke evidence. On the first turn of a session transcribe every word and describe every drawing; on later turns, note the NEW black ink since your last reply, transcribing new words exactly.
  * ANSWER inside SEE: if the writing asks for something — an equation to answer, a question, a word to complete — state your answer there and double-check it (re-derive arithmetic once) before anything else.
  * PLAN your drawing in SEE before you draw: for each thing you will add, note the existing ink it must relate to (pixel positions read off the grid), its bounding box, the constraints you set yourself (e.g. "hand ends within ~10px of (575,490)", "face fits inside the head box"), and the pen path. Your strokes must then obey your own plan.
- TEXT is you talking: usually one block of 1-3 short sentences, in the user's language. (x, y) is the block's top-left corner in snapshot pixels; the rendered line height is stated in each turn message, and lines wrap at the right page edge. Place it over empty paper, never on top of existing ink. Your words are inked on the page and fade away after a while — the page keeps only drawings.
- STROKE is you drawing: one pen stroke per block, in your blue ink, and it stays on the page. The pen draws one smooth curve through your P points, in order — one pen-down…pen-up on paper. Stroke craft:
  * P points are sparse ANCHORS on a smooth curve, not pixels. Place them at the pen path's landmarks: the start, every extreme (the farthest a curve bulges), every corner, the end.
  * Every bow (one curved arc) needs at least 4 anchors: entry, extreme, one between, exit. Straight segments need only their two ends. When unsure, add an anchor every ~1/10 of the shape's height along the path.
  * A sharp corner or reversal mid-stroke: write that anchor TWICE in a row — otherwise the curve rounds it away.
  * For a closed shape (a circle, a loop), repeat the first point as the last point.
  * Build a real drawing from MANY strokes: outlines first, then details, one stroke per pen-lift, exactly as a hand would draw.
- Worked example of the stroke craft — the letter B in a 90x140 box at (10,10): a straight spine, then two right-bulging bows meeting at a doubled corner anchor:
STROKE
P 10 10
P 10 150
END_STROKE
STROKE
P 10 10
P 60 12
P 100 45
P 62 78
P 15 80
P 15 80
P 68 84
P 100 115
P 60 148
P 10 150
END_STROKE
- A reply does not have to draw: text-only is fine when talk is the better answer. But when you do draw, go all in — you are a professional artist with the whole page; draw as much and as richly as you like.
- Everything already on the page is fixed. Never redraw, trace over, or "fix" existing strokes; you only append new ink.
- END must be the last line, always.`;

/**
 * The region detector's whole conversation: no persona, no history, one
 * job. It sees the same snapshot (same grid) as the artist and answers in
 * the same pixel space, so its boxes map to the page with the same scale
 * the reply blocks use.
 */
export const REGION_PROMPT = `You read a drawing-page snapshot and pick out which handwriting is a MESSAGE to the page's companion — words whose whole job is to talk to it, and which should vanish once read. BLACK ink is the user's; BLUE ink is the companion's. A faint gray measuring grid (lines every 50 pixels, labels every 100) is printed on the snapshot — read positions against it; it is not page content.

Box ONLY black handwriting with conversational intent — said TO the companion, not needed on the page afterwards:
- requests and instructions ("draw a cat here", "make it bigger", "幫我畫...")
- questions and chat addressed to the companion ("what do you think?", "hi!")

Do NOT box writing that is the page's own CONTENT — it stays:
- math: equations, calculations, a "3×5=" waiting for its answer
- signatures, names, titles, labels and annotations on drawings
- lists and notes the user is keeping for themselves
The test: is this being said TO the companion, or worked ON the page? Drawings and sketches are never boxed. When unsure, do NOT box — leaving words on the page is safer than eating its content.

Reply with EXACTLY this, nothing else:
BOX x0 y0 x1 y1
one line per boxed message — integers in snapshot pixels, top-left corner then bottom-right corner, tight but covering every stroke of that message; one box per line of writing. If nothing on the page is conversational, reply with the single line:
NONE`;

/**
 * The per-turn user message; the page snapshot rides next to it. The pixel
 * frame is restated every turn because it is the reply's coordinate system
 * — and it can change when the page re-lays out.
 */
export function turnPrompt(
  firstTurn: boolean,
  imgW: number,
  imgH: number,
  textLineH: number,
): string {
  const frame =
    `The snapshot is ${imgW}x${imgH} pixels; every coordinate in your ` +
    `reply is a pixel position in it. A rendered TEXT line is about ` +
    `${textLineH}px tall. Read positions against the printed gray grid labels.`;
  return firstTurn
    ? `This is the first turn of a new session. ${frame} Begin with a SEE ` +
        `block describing everything currently on the page — transcribe ` +
        `every word, describe every drawing and its color. Then reply.`
    : `Here is the page as it looks now. ${frame} Begin with a SEE block ` +
        `noting what is new in BLACK ink since your last reply (transcribe ` +
        `new words exactly), then reply.`;
}

/**
 * Parse BOX lines out of a region reply. Tolerant: chatter and malformed
 * lines are dropped, corners are normalized, empty or NONE replies yield
 * an empty list.
 */
export function parseRegions(raw: string): TextBox[] {
  const boxes: TextBox[] = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("BOX")) continue;
    const n = t
      .split(/\s+/)
      .slice(1)
      .map((v) => Number.parseInt(v, 10))
      .filter((v) => !Number.isNaN(v));
    if (n.length < 4) continue;
    boxes.push({
      x0: Math.min(n[0], n[2]),
      y0: Math.min(n[1], n[3]),
      x1: Math.max(n[0], n[2]),
      y1: Math.max(n[1], n[3]),
    });
  }
  return boxes;
}

export class Oracle {
  private readonly history: Exchange[] = [];

  constructor(
    private readonly provider: LlmProvider,
    private readonly cfg: Pick<OracleConfig, "maxTokens" | "reasoning">,
  ) {}

  /** Forget the conversation — Clear starts a fresh session. */
  resetSession(): void {
    this.history.length = 0;
  }

  /**
   * Ask the artist about the page. Callbacks land on the main thread
   * (fetch has no reader thread to hop off, unlike the Kotlin side).
   */
  async ask(snap: Snapshot, listener: OracleListener): Promise<void> {
    try {
      const userText = turnPrompt(
        this.history.length === 0,
        snap.width,
        snap.height,
        snap.textLineH,
      );
      const req: ChatRequest = {
        system: SYSTEM_PROMPT,
        turns: this.history.slice(-MAX_TURNS),
        userText,
        imageDataUrl: snap.pngDataUrl,
        maxTokens: this.cfg.maxTokens,
        effort: this.cfg.reasoning,
      };

      // Fragments feed the DSL parser and completed blocks go out as
      // they form. The verbatim reply is kept too — it becomes the
      // history entry.
      const parser = new StreamParser();
      let rawReply = "";
      let emitted = false;
      const deliver = (blocks: Block[]) => {
        for (const b of blocks) {
          emitted = true;
          listener.onBlock(b);
        }
      };
      await this.provider.stream(req, (frag) => {
        rawReply += frag;
        deliver(parser.feed(frag));
      });
      deliver(parser.finish());
      if (!emitted) {
        listener.onError("empty reply");
      } else {
        this.history.push({ userText, assistantRaw: rawReply.trim() });
        while (this.history.length > MAX_TURNS) this.history.shift();
        listener.onDone();
      }
    } catch (e) {
      console.warn("oracle request failed", e);
      listener.onError(`request failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /**
   * The second, parallel reading of the page: not "what will you draw" but
   * "where are the user's written words". Non-streaming — the whole reply
   * is a handful of BOX lines — and best-effort: any failure yields no
   * boxes, and the words simply stay on the page this turn.
   */
  async askTextRegions(snap: Snapshot): Promise<TextBox[]> {
    try {
      const req: ChatRequest = {
        system: REGION_PROMPT,
        turns: [],
        userText: `The snapshot is ${snap.width}x${snap.height} pixels. Box the conversational messages, if any.`,
        imageDataUrl: snap.pngDataUrl,
        maxTokens: this.cfg.maxTokens,
        effort: this.cfg.reasoning,
      };
      const boxes = parseRegions(await this.provider.complete(req));
      console.info(`text regions: ${boxes.length} box(es)`);
      return boxes;
    } catch (e) {
      console.warn("region call failed", e);
      return [];
    }
  }
}

/**
 * Per-vendor defaults for the config fields oracle.env may omit. The
 * anthropic token cap is roomier because Fable 5's always-on thinking
 * bills into max_tokens — a 2000 cap would be eaten before the reply.
 */
const PROVIDER_DEFAULTS: Record<
  ProviderKind,
  { base: string; model: string; maxTokens: number }
> = {
  openai: { base: "https://api.openai.com/v1", model: "gpt-4o-mini", maxTokens: 2000 },
  anthropic: { base: "https://api.anthropic.com/v1", model: "claude-fable-5", maxTokens: 8000 },
};

function isProviderKind(v: string): v is ProviderKind {
  return v === "openai" || v === "anthropic";
}

/**
 * Parse oracle.env-style text: same variable names as riddle's oracle.env;
 * `export K=V` and `K=V` lines both accepted. The tablet flavours read this
 * from a file; the web harness keeps the same text in localStorage.
 *
 * RIDDLE_PROVIDER (default "openai") picks the vendor; each vendor reads
 * its own RIDDLE_<PROVIDER>_{KEY,BASE,MODEL,MAX_TOKENS,REASONING} group,
 * so one file can hold both and switch with a single line.
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
  const kind = (vars.get("RIDDLE_PROVIDER") ?? "openai").toLowerCase();
  if (!isProviderKind(kind)) return null;
  const defaults = PROVIDER_DEFAULTS[kind];
  const v = (name: string) => vars.get(`RIDDLE_${kind.toUpperCase()}_${name}`);
  const key = v("KEY");
  if (!key) return null;
  const maxTokens = Number.parseInt(v("MAX_TOKENS") ?? "", 10);
  return {
    provider: kind,
    key,
    base: (v("BASE") ?? defaults.base).replace(/\/+$/, ""),
    model: v("MODEL") ?? defaults.model,
    maxTokens: Number.isNaN(maxTokens) ? defaults.maxTokens : maxTokens,
    reasoning: v("REASONING") || null,
  };
}

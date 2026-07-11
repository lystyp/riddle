// The oracle's reply DSL — the plain-text grammar the model answers with,
// and the geometry that turns it into pen strokes on the page. Ported
// line-for-line from boox-spike's ReplyDsl.kt; pure functions — no DOM, no
// fetch — verified by the same property tests (test/reply-dsl.test.ts).
//
// Coordinates are honest: every x y in a reply is a pixel position in the
// exact PNG snapshot the model received that turn (origin top-left, y down;
// the size rides along in each turn prompt). The frame it draws in is the
// frame it looked at — no mental re-projection, which is where vision
// models lose precision. A reply is a sequence of blocks:
//
//   SEE               the model's private notes — its memory of the page,
//   ...lines...       never drawn; page words fade, so this is how past
//   END_SEE           turns stay recoverable from the conversation history
//   TEXT x y          what it says, placed at the block's top-left
//   ...lines...
//   END_TEXT
//   STROKE            one pen stroke: sparse anchor points; a smooth curve
//   P x y             is drawn through them (densify), so a handful of
//   END_STROKE        corners and landmarks is enough
//   END               last line of the reply
//
// StreamParser consumes SSE fragments and emits each block the moment its
// terminator arrives, so the quill starts moving while the model is still
// talking. The parser never clamps coordinates — it does not know the
// snapshot size; mapToCanvas clamps while scaling snapshot pixels up to
// page pixels.

import type { Pt } from "./script";

// Silent backstops — never quoted to the model (it draws freely); they
// only stop a runaway reply from queueing minutes of animation.
export const MAX_STROKES = 64;
export const MAX_POINTS = 2000;

/** A point in the snapshot's pixel space — what the model saw and meant. */
export interface ImgPt {
  x: number;
  y: number;
}

/** The model's private notes about the page — memory, never drawn. */
export interface SeeBlock {
  kind: "see";
  text: string;
}

/** A spoken reply block: `text` written with its top-left at (x, y). */
export interface TextBlock {
  kind: "text";
  x: number;
  y: number;
  text: string;
}

/** One drawn stroke through anchor `points`, in the oracle's own ink. */
export interface StrokeBlock {
  kind: "stroke";
  points: ImgPt[];
}

export type Block = SeeBlock | TextBlock | StrokeBlock;

const WS = /\s+/;

/**
 * Incremental line parser over the streamed reply. Feed it raw content
 * fragments as they arrive; it returns blocks as they complete. Unknown
 * lines outside blocks (model chatter, code fences) are dropped, and a
 * block header met inside another block closes that block first — models
 * forget terminators more often than they invent new grammar.
 */
export class StreamParser {
  private buf = "";
  private done = false;

  // Non-null exactly while inside the corresponding block.
  private textPos: ImgPt | null = null;
  private textLines: string[] = [];
  private strokePts: ImgPt[] | null = null;
  private seeLines: string[] | null = null;

  private strokesEmitted = 0;
  private pointBudget = MAX_POINTS;

  feed(fragment: string): Block[] {
    if (this.done) return [];
    const out: Block[] = [];
    this.buf += fragment;
    while (!this.done) {
      const nl = this.buf.indexOf("\n");
      if (nl < 0) break;
      const line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      this.processLine(line, out);
    }
    return out;
  }

  /** The stream is over: parse the last partial line, flush open blocks. */
  finish(): Block[] {
    if (this.done) return [];
    const out: Block[] = [];
    if (this.buf.length > 0) {
      this.processLine(this.buf, out);
      this.buf = "";
    }
    this.endText(out);
    this.endStroke(out);
    this.endSee(out);
    this.done = true;
    return out;
  }

  private processLine(raw: string, out: Block[]): void {
    const t = raw.trim();
    if (this.textPos !== null) {
      if (t === "END_TEXT") {
        this.endText(out);
        return;
      }
      if (isBlockHeader(t)) {
        this.endText(out); // missing terminator
      } else {
        this.textLines.push(raw.trimEnd());
        return;
      }
    }
    if (this.strokePts !== null) {
      if (t === "END_STROKE") {
        this.endStroke(out);
        return;
      }
      if (isBlockHeader(t)) {
        this.endStroke(out); // missing terminator
      } else {
        this.addPoint(t);
        return;
      }
    }
    if (this.seeLines !== null) {
      if (t === "END_SEE") {
        this.endSee(out);
        return;
      }
      if (isBlockHeader(t)) {
        this.endSee(out); // missing terminator
      } else {
        this.seeLines.push(raw.trimEnd());
        return;
      }
    }
    if (t === "END") this.done = true;
    else if (t === "STROKE") this.strokePts = [];
    else if (t === "SEE") this.seeLines = [];
    else if (t.startsWith("TEXT")) this.beginText(t);
    // Anything else at top level is model chatter — tolerated.
  }

  private beginText(t: string): void {
    const tok = t.split(WS);
    if (tok.length < 3) return; // TEXT without a position cannot be placed
    const x = Number.parseFloat(tok[1]);
    const y = Number.parseFloat(tok[2]);
    if (Number.isNaN(x) || Number.isNaN(y)) return;
    this.textPos = { x, y };
    this.textLines = [];
  }

  private endText(out: Block[]): void {
    const pos = this.textPos;
    if (pos === null) return;
    this.textPos = null;
    const text = this.textLines.join("\n").trim();
    this.textLines = [];
    if (text.length > 0) out.push({ kind: "text", x: pos.x, y: pos.y, text });
  }

  private addPoint(t: string): void {
    const pts = this.strokePts;
    if (pts === null) return;
    const tok = t.split(WS);
    if (tok.length < 3 || tok[0] !== "P") return;
    const x = Number.parseFloat(tok[1]);
    const y = Number.parseFloat(tok[2]);
    if (Number.isNaN(x) || Number.isNaN(y)) return;
    if (this.pointBudget <= 0) return;
    this.pointBudget--;
    pts.push({ x, y });
  }

  private endSee(out: Block[]): void {
    const lines = this.seeLines;
    if (lines === null) return;
    this.seeLines = null;
    const text = lines.join("\n").trim();
    if (text.length > 0) out.push({ kind: "see", text });
  }

  private endStroke(out: Block[]): void {
    const pts = this.strokePts;
    if (pts === null) return;
    this.strokePts = null;
    if (pts.length >= 2 && this.strokesEmitted < MAX_STROKES) {
      this.strokesEmitted++;
      out.push({ kind: "stroke", points: pts });
    }
  }
}

function isBlockHeader(t: string): boolean {
  return t === "END" || t === "STROKE" || t === "SEE" || t.startsWith("TEXT ");
}

/**
 * Snapshot pixels → page pixels. The snapshot is the page downscaled by
 * one integer factor, so this is a near-uniform upscale; out-of-frame
 * coordinates (the model drew off the edge) clamp to the page bounds.
 */
export function mapToCanvas(
  points: ImgPt[],
  imgW: number,
  imgH: number,
  pageW: number,
  pageH: number,
): Pt[] {
  const sx = pageW / Math.max(1, imgW);
  const sy = pageH / Math.max(1, imgH);
  const clamp = (v: number, hi: number) => Math.min(Math.max(v, 0), hi);
  return points.map((p) => ({
    x: clamp(Math.round(p.x * sx), pageW - 1),
    y: clamp(Math.round(p.y * sy), pageH - 1),
  }));
}

/**
 * Turn sparse anchor points into a hand-paced dense path: a centripetal
 * Catmull-Rom spline through every anchor (interpolating, and the
 * centripetal knots are the standard no-cusp/no-overshoot choice),
 * resampled to ≤ spacingPx between points so it feeds the same
 * point-by-point quill animation as traced text. Without this a raw DSL
 * stroke is a few instant ruler lines. `wobblePx` adds a bounded
 * perpendicular random walk (deterministic per seed) for the last bit of
 * hand feel; anchors and endpoints stay put so strokes keep meeting where
 * the model intended. 32-bit integer semantics (wrapping multiply,
 * unsigned shift) come from Math.imul / >>> so the LCG replays exactly
 * like the Kotlin side.
 */
export function densify(
  points: Pt[],
  spacingPx: number,
  wobblePx = 0,
  seed = 1,
): Pt[] {
  if (points.length < 2) return points;
  const spacing = Math.max(1, spacingPx);
  const out: Pt[] = [points[0]];
  let rng = seed | 0;
  // LCG in [-1, 1] — Math.random-free so tests replay exactly.
  const nextRand = (): number => {
    rng = (Math.imul(rng, 1664525) + 1013904223) | 0;
    return (((rng >>> 16) % 2001) - 1000) / 1000;
  };
  let wob = 0;
  const n = points.length;
  for (let i = 1; i < n; i++) {
    // Segment p1→p2 with its neighbors as spline context; endpoints
    // duplicate their neighbor (knot() keeps the maths finite).
    const p0 = points[Math.max(0, i - 2)];
    const p1 = points[i - 1];
    const p2 = points[i];
    const p3 = points[Math.min(n - 1, i + 1)];
    const dx = p2.x - p1.x;
    const dy = p2.y - p1.y;
    const chord = Math.hypot(dx, dy);
    if (chord < 1e-3) continue;
    const steps = Math.max(1, Math.ceil(chord / spacing));
    const t0 = 0;
    const t1 = t0 + knot(p0, p1);
    const t2 = t1 + knot(p1, p2);
    const t3 = t2 + knot(p2, p3);
    // Wobble bends perpendicular to the chord — the spline supplies the
    // real curvature, this only roughens the line.
    const nx = -dy / chord;
    const ny = dx / chord;
    for (let s = 1; s <= steps; s++) {
      const t = t1 + ((t2 - t1) * s) / steps;
      let x: number;
      let y: number;
      if (s === steps) {
        // Land exactly on the anchor, no float drift.
        x = p2.x;
        y = p2.y;
      } else {
        // Barry–Goldman pyramid for the centripetal spline.
        const a1x = lerp(p0.x, p1.x, t - t0, t1 - t0);
        const a1y = lerp(p0.y, p1.y, t - t0, t1 - t0);
        const a2x = lerp(p1.x, p2.x, t - t1, t2 - t1);
        const a2y = lerp(p1.y, p2.y, t - t1, t2 - t1);
        const a3x = lerp(p2.x, p3.x, t - t2, t3 - t2);
        const a3y = lerp(p2.y, p3.y, t - t2, t3 - t2);
        const b1x = lerp(a1x, a2x, t - t0, t2 - t0);
        const b1y = lerp(a1y, a2y, t - t0, t2 - t0);
        const b2x = lerp(a2x, a3x, t - t1, t3 - t1);
        const b2y = lerp(a2y, a3y, t - t1, t3 - t1);
        x = lerp(b1x, b2x, t - t1, t2 - t1);
        y = lerp(b1y, b2y, t - t1, t2 - t1);
      }
      const last = i === n - 1 && s === steps;
      wob =
        wobblePx > 0 && !last
          ? clampWob(wob + nextRand() * 0.6 * wobblePx, wobblePx)
          : 0;
      out.push({
        x: Math.round(x + nx * wob),
        y: Math.round(y + ny * wob),
      });
    }
  }
  return out;
}

/** Centripetal knot interval: √distance, floored so duplicated endpoint
 *  context never divides by zero. */
function knot(a: Pt, b: Pt): number {
  return Math.max(Math.sqrt(Math.hypot(b.x - a.x, b.y - a.y)), 1e-3);
}

function lerp(a: number, b: number, num: number, den: number): number {
  return a + ((b - a) * num) / den;
}

function clampWob(v: number, bound: number): number {
  return Math.min(Math.max(v, -bound), bound);
}

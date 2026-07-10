// The page. Ported from boox-spike's TomView.kt: the same
// Replying → Lingering → FadingReply states with the same constants
// (main.rs): 14ms tick / 26 points per tick, nib radius 2, REPLY_PX 96,
// line height ×1.25, ±3px per-line wobble (same LCG), linger 4s + 2ms·points
// (cap 20s, tap to skip), dissolve 10 stages × 80ms. All lengths scale by
// (canvas width / 1620) so proportions match the Paper Pro reference device.
//
// What the browser translation changes:
// - android.graphics.Canvas/Bitmap → one CanvasRenderingContext2D; the
//   canvas IS the page bitmap (getImageData/putImageData for the dissolve).
// - MotionEvent → Pointer Events; the batched history drain becomes
//   getCoalescedEvents (which INCLUDES the current sample — no double ink).
// - Epd partial/full refresh and the RAW pen path have no web counterpart:
//   the browser composites every draw, so the dirty-rect bookkeeping that
//   fed EpdController is gone. The two-finger chrome-restore gesture went
//   with it — the chrome never hides here.

import { dissolvesAt, thin, trace, type Pt } from "./script";
import type { Oracle } from "./oracle";

// ---- constants from riddle main.rs / ink.rs ----
const REPLY_PX_REF = 96;
const MARGIN_X_REF = 120;
const LINE_H_FACTOR = 1.25;
const NIB_R_REF = 2;
const DISSOLVE_STAGES = 10;
const DISSOLVE_TICK_MS = 80;
const IDLE_COMMIT_MS = 2800;

// Tom's hand: Caveat (flowing but legible, Latin-only) with LXGW WenKai TC
// (handwritten 楷體) catching CJK replies — the same TTFs boox-spike bundles
// (loaded via style.css straight from its assets).
const FONT_STACK = '"Caveat", "LXGW WenKai TC"';

type Phase = "IDLE" | "DRINKING" | "THINKING" | "WRITING" | "LINGERING" | "DISSOLVING";

/** The slice of android.graphics.Rect the port leans on (point-union etc.). */
class Rect {
  constructor(
    public left: number,
    public top: number,
    public right: number,
    public bottom: number,
  ) {}

  get width(): number {
    return this.right - this.left;
  }

  get height(): number {
    return this.bottom - this.top;
  }

  get isEmpty(): boolean {
    return this.left >= this.right || this.top >= this.bottom;
  }

  copy(): Rect {
    return new Rect(this.left, this.top, this.right, this.bottom);
  }

  /** Expand to include point (x, y). */
  union(x: number, y: number): void {
    this.left = Math.min(this.left, x);
    this.top = Math.min(this.top, y);
    this.right = Math.max(this.right, x);
    this.bottom = Math.max(this.bottom, y);
  }

  inset(dx: number, dy: number): void {
    this.left += dx;
    this.top += dy;
    this.right -= dx;
    this.bottom -= dy;
  }

  /** Clip to the given bounds; false (rect untouched) if nothing remains. */
  intersect(l: number, t: number, r: number, b: number): boolean {
    const nl = Math.max(this.left, l);
    const nt = Math.max(this.top, t);
    const nr = Math.min(this.right, r);
    const nb = Math.min(this.bottom, b);
    if (nl >= nr || nt >= nb) return false;
    this.left = nl;
    this.top = nt;
    this.right = nr;
    this.bottom = nb;
    return true;
  }
}

type Runnable = () => void;

/**
 * android.os.Handler's post/postDelayed/removeCallbacks, on setTimeout.
 * One pending slot per runnable — TomView never queues the same one twice.
 */
class Scheduler {
  private readonly ids = new Map<Runnable, number>();

  post(r: Runnable): void {
    this.postDelayed(r, 0);
  }

  postDelayed(r: Runnable, ms: number): void {
    this.removeCallbacks(r);
    this.ids.set(
      r,
      window.setTimeout(() => {
        this.ids.delete(r);
        r();
      }, ms),
    );
  }

  removeCallbacks(r: Runnable): void {
    const id = this.ids.get(r);
    if (id !== undefined) {
      clearTimeout(id);
      this.ids.delete(r);
    }
  }

  /** Handler.removeCallbacksAndMessages(null). */
  removeAll(): void {
    for (const id of this.ids.values()) clearTimeout(id);
    this.ids.clear();
  }
}

export class TomView {
  /** Pace, settable like the Android field. riddle's own pace is 14ms/26pts. */
  tickMs = 14;
  pointsPerTickRef = 26;

  onStatus: ((s: string) => void) | null = null;

  /** The spirit in the diary; null until the oracle env is configured. */
  oracle: Oracle | null = null;

  private readonly ctx: CanvasRenderingContext2D;
  private readonly scratch = document.createElement("canvas");
  private readonly ui = new Scheduler();

  private phase: Phase = "IDLE";

  // ---- write plan (plan_reply / WritePlan) ----
  private strokes: Pt[][] = [];
  private strokeI = 0;
  private pointI = 0;
  private region: Rect | null = null;
  private nextY = -1;
  private jitterSeed = 0x1234;

  // ---- metrics ----
  private writeStartMs = 0;
  private ticks = 0;
  private lateTicks = 0;
  private dissolveStage = 0;

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext("2d", { willReadFrequently: true })!;
    new ResizeObserver(() => this.onSizeChanged()).observe(canvas);
    this.onSizeChanged();
    canvas.addEventListener("pointerdown", (e) => this.pointerDown(e));
    canvas.addEventListener("pointermove", (e) => this.pointerMove(e));
    canvas.addEventListener("pointerup", (e) => this.pointerUp(e));
    canvas.addEventListener("pointercancel", (e) => this.pointerUp(e));
  }

  private get width(): number {
    return this.canvas.width;
  }

  private get height(): number {
    return this.canvas.height;
  }

  private get sc(): number {
    return this.width / 1620;
  }

  private onSizeChanged(): void {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(this.canvas.clientWidth * dpr);
    const h = Math.round(this.canvas.clientHeight * dpr);
    if (w <= 0 || h <= 0 || (w === this.canvas.width && h === this.canvas.height)) return;
    this.ui.removeAll();
    this.phase = "IDLE";
    this.resetPlan();
    // Resizing wipes the canvas, like the Bitmap recreate on the Android side.
    this.canvas.width = w;
    this.canvas.height = h;
    this.clearToWhite();
  }

  // ---- user ink (TomView.onTouchEvent, via Pointer Events) ----

  private inking = false;
  private lastX = 0;
  private lastY = 0;
  private strokePts = 0;
  private pMin = 1;
  private pMax = 0;
  private strokeTool = "?";

  /** Map client coordinates to page (canvas pixel) coordinates. */
  private toPage(e: { clientX: number; clientY: number }): { x: number; y: number } {
    const r = this.canvas.getBoundingClientRect();
    return {
      x: ((e.clientX - r.left) / r.width) * this.width,
      y: ((e.clientY - r.top) / r.height) * this.height,
    };
  }

  private pointerDown(e: PointerEvent): void {
    if (!e.isPrimary) return;
    if (this.phase === "LINGERING") {
      this.ui.removeCallbacks(this.startDissolve);
      this.ui.post(this.startDissolve);
      return;
    }
    if (this.phase !== "IDLE") return;
    this.ui.removeCallbacks(this.commitCheck);
    this.canvas.setPointerCapture(e.pointerId);
    this.inking = true;
    this.strokePts = 0;
    this.pMin = 1;
    this.pMax = 0;
    this.strokeTool = e.pointerType || "?";
    const { x, y } = this.toPage(e);
    this.lastX = x;
    this.lastY = y;
    this.inkSegment(x, y, e.pressure, true);
  }

  private pointerMove(e: PointerEvent): void {
    if (!this.inking || !e.isPrimary) return;
    // Drain the coalesced batch: tablets sample far above the event delivery
    // rate. Every sample is inked, like the MotionEvent history drain.
    const batch = e.getCoalescedEvents?.() ?? [];
    const samples = batch.length > 0 ? batch : [e];
    for (const ev of samples) {
      const { x, y } = this.toPage(ev);
      this.inkSegment(x, y, ev.pressure, false);
    }
  }

  private pointerUp(e: PointerEvent): void {
    if (!e.isPrimary || !this.inking) return;
    this.inking = false;
    this.status(
      `${this.strokeTool} stroke: ${this.strokePts} pts, ` +
        `pressure ${this.pMin.toFixed(2)}–${this.pMax.toFixed(2)}`,
    );
    this.scheduleCommit();
  }

  /** One ink segment; nib radius follows pressure like riddle's brush. */
  private inkSegment(x: number, y: number, pressure: number, first: boolean): void {
    const p = Math.min(1, Math.max(0, pressure));
    this.pMin = Math.min(this.pMin, p);
    this.pMax = Math.max(this.pMax, p);
    // riddle main.rs:345 — r = 2 + pressure*3/MAX: a full-bodied base nib
    // with a gentle 2x swell at full pressure. The proven hand-feel.
    const r = (2 + 3 * p) * this.sc;
    const ctx = this.ctx;
    ctx.strokeStyle = "#000";
    ctx.fillStyle = "#000";
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.lineWidth = 2 * r + 1;
    if (first) {
      ctx.beginPath();
      ctx.arc(x, y, r + 0.5, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.beginPath();
      ctx.moveTo(this.lastX, this.lastY);
      ctx.lineTo(x, y);
      ctx.stroke();
    }
    const margin = Math.trunc(r + 4 * this.sc);
    // inkSegment only ever draws the writer's ink — track it for commit.
    this.hasUserInk = true;
    const u =
      this.userInkRegion ??
      new Rect(Math.trunc(x), Math.trunc(y), Math.trunc(x), Math.trunc(y));
    this.userInkRegion = u;
    u.union(Math.trunc(x) - margin, Math.trunc(y) - margin);
    u.union(Math.trunc(x) + margin, Math.trunc(y) + margin);
    this.lastX = x;
    this.lastY = y;
    this.strokePts++;
  }

  // ---- the oracle turn: idle commit → drink → think → streamed reply ----
  // Mirrors main.rs: IDLE_COMMIT 2.8s after pen-up, dissolve the writer's
  // ink while the request flies, buffer sentences until the page is clean,
  // then ink them with the existing write animation; the ticker hovers
  // while the stream is still open (rx.is_some()).

  private userInkRegion: Rect | null = null;
  private hasUserInk = false;
  private oracleActive = false;
  private turnWrote = false;
  private readonly pendingSentences: string[] = [];
  private drinkStage = 0;
  private drinkRegion: Rect | null = null;

  private readonly commitCheck = (): void => {
    if (this.phase === "IDLE" && this.hasUserInk) this.commitPage();
  };

  private scheduleCommit(): void {
    this.ui.postDelayed(this.commitCheck, IDLE_COMMIT_MS);
  }

  private commitPage(): void {
    const o = this.oracle;
    if (o === null) {
      this.status("oracle 未設定 — 按 Oracle… 貼上 oracle.env; ink stays");
      return;
    }
    const region = this.userInkRegion;
    if (region === null) return;
    const png = this.capturePagePng(region);
    if (png === null) return;
    this.oracleActive = true;
    this.turnWrote = false;
    this.pendingSentences.length = 0;
    this.phase = "DRINKING";
    this.drinkRegion = region.copy();
    this.drinkStage = 0;
    this.status("the diary drinks your ink…");
    this.ui.post(this.drinkTicker);
    // Callbacks land on the main thread already — no Handler hop needed.
    void o.ask(png, {
      onInk: (sentence) => this.onOracleInk(sentence),
      onDone: () => this.onOracleDone(),
      onError: (reason) => this.onOracleError(reason),
    });
  }

  /** ink.rs to_png: crop to the ink bbox + 20px, downscale ≥2x to ≤800px. */
  private capturePagePng(region: Rect): string | null {
    const r = region.copy();
    r.inset(-20, -20);
    if (!r.intersect(0, 0, this.width, this.height) || r.isEmpty) return null;
    const f = Math.max(2, Math.ceil(Math.max(r.width, r.height) / 800));
    const crop = document.createElement("canvas");
    crop.width = Math.max(1, Math.floor(r.width / f));
    crop.height = Math.max(1, Math.floor(r.height / f));
    const cctx = crop.getContext("2d")!;
    cctx.drawImage(
      this.canvas,
      r.left,
      r.top,
      r.width,
      r.height,
      0,
      0,
      crop.width,
      crop.height,
    );
    return crop.toDataURL("image/png");
  }

  private readonly drinkTicker = (): void => {
    if (this.phase !== "DRINKING") return;
    const reg = this.drinkRegion;
    if (reg === null) {
      this.finishDrink();
      return;
    }
    this.dissolveRegionPass(reg, this.drinkStage);
    this.drinkStage++;
    if (this.drinkStage >= DISSOLVE_STAGES) this.finishDrink();
    else this.ui.postDelayed(this.drinkTicker, DISSOLVE_TICK_MS);
  };

  private finishDrink(): void {
    this.drinkRegion = null;
    this.userInkRegion = null;
    this.hasUserInk = false;
    this.phase = "THINKING";
    if (this.pendingSentences.length === 0) this.status("the diary is thinking…");
    while (this.pendingSentences.length > 0) {
      this.turnWrote = true;
      this.write(this.pendingSentences.shift()!);
    }
    if (!this.oracleActive && !this.turnWrote) this.writeExcuse("empty reply");
  }

  private onOracleInk(sentence: string): void {
    if (!this.oracleActive) return;
    if (this.phase === "DRINKING") {
      this.pendingSentences.push(sentence);
    } else {
      this.turnWrote = true;
      this.write(sentence);
    }
  }

  private onOracleDone(): void {
    this.oracleActive = false;
    if (this.phase === "THINKING" && !this.turnWrote) this.writeExcuse("empty reply");
  }

  private onOracleError(reason: string): void {
    console.warn(`oracle error: ${reason}`);
    this.oracleActive = false;
    if (this.phase === "DRINKING") {
      this.pendingSentences.push(this.excuseFor(reason));
      this.turnWrote = true; // the excuse counts as the reply
    } else {
      this.writeExcuse(reason);
    }
  }

  private writeExcuse(reason: string): void {
    this.turnWrote = true;
    this.write(this.excuseFor(reason));
  }

  /** Simplified from main.rs oracle_excuse: stay in character, keep the clue. */
  private excuseFor(reason: string): string {
    return `The ink blurs and will not settle… (${reason.slice(0, 80)})`;
  }

  /**
   * Ink `text` onto the page. While writing it appends like a streamed
   * oracle chunk (append_reply); while idle it continues below the previous
   * reply, clearing first when the page would overflow.
   */
  write(text: string): void {
    if (this.phase === "LINGERING" || this.phase === "DISSOLVING") {
      this.ui.removeAll();
      this.resetPlan();
      this.clearToWhite();
      this.phase = "IDLE";
    }
    const lineH = Math.trunc(REPLY_PX_REF * this.sc * LINE_H_FACTOR);
    if (this.nextY >= 0 && this.nextY + 2 * lineH > this.height) {
      this.resetPlan();
      this.clearToWhite();
    }
    this.planReply(text);
    if (this.phase !== "WRITING") {
      this.phase = "WRITING";
      this.writeStartMs = performance.now();
      this.ticks = 0;
      this.lateTicks = 0;
      this.ui.post(this.ticker);
    }
    this.status(`writing… pace=${this.tickMs}ms×${this.budget()}`);
  }

  clearPage(): void {
    this.ui.removeAll();
    this.phase = "IDLE";
    this.resetPlan();
    this.clearToWhite();
    this.status(`cleared — pace=${this.tickMs}ms×${this.budget()}`);
  }

  // ---- plan_reply, same layout math ----

  private planReply(text: string): void {
    const px = REPLY_PX_REF * this.sc;
    const font = `${px}px ${FONT_STACK}`;
    const maxW = this.width - 2 * MARGIN_X_REF * this.sc;
    const lines = this.wrap(font, text, maxW);
    const lineH = Math.trunc(px * LINE_H_FACTOR);
    const totalH = lineH * lines.length;
    let y =
      this.nextY >= 0
        ? this.nextY
        : Math.max(Math.trunc((this.height - totalH) / 3), Math.trunc(60 * this.sc));
    for (const lineText of lines) {
      const m = this.rasterize(font, px, lineText);
      thin(m.mask, m.w, m.h);
      const lineStrokes = trace(m.mask, m.w, m.h);
      const x0 = Math.trunc((this.width - m.w) / 2);
      const wobble = this.jitter();
      for (const s of lineStrokes) {
        const mapped = s.map((p) => ({ x: x0 + p.x, y: y + p.y + wobble }));
        for (const p of mapped) this.growRegion(p.x, p.y, Math.round(5 * this.sc));
        this.strokes.push(mapped);
      }
      y += lineH;
    }
    this.nextY = y;
  }

  /** The same LCG as main.rs — ±3px per-line wobble. */
  private jitter(): number {
    this.jitterSeed = (Math.imul(this.jitterSeed, 1664525) + 1013904223) | 0;
    return ((this.jitterSeed >>> 16) % 7) - 3;
  }

  /** ctx.fillText replaces Canvas.drawText: same TTFs, alpha > 127 becomes ink. */
  private rasterize(
    font: string,
    px: number,
    text: string,
  ): { mask: Uint8Array; w: number; h: number } {
    const sctx = this.scratch.getContext("2d", { willReadFrequently: true })!;
    sctx.font = font;
    const metrics = sctx.measureText(text);
    const ascent = metrics.fontBoundingBoxAscent || px * 0.8;
    const descent = metrics.fontBoundingBoxDescent || px * 0.25;
    const w = Math.max(1, Math.ceil(metrics.width) + 4);
    const h = Math.max(1, Math.ceil(ascent + descent) + 4);
    this.scratch.width = w;
    this.scratch.height = h;
    sctx.font = font; // the resize reset the context state
    sctx.fillStyle = "#000";
    sctx.fillText(text, 0, ascent);
    const data = sctx.getImageData(0, 0, w, h).data;
    const mask = new Uint8Array(w * h);
    for (let i = 0; i < mask.length; i++) mask[i] = data[i * 4 + 3] > 127 ? 1 : 0;
    return { mask, w, h };
  }

  /**
   * Wrap to fit maxPx, character by character. Breaks at the last space for
   * spaced scripts (English word-wrap); for runs with no spaces (CJK) it
   * breaks at the character boundary — otherwise a Chinese reply is one
   * unbreakable "word" that overflows the page off both edges.
   */
  private wrap(font: string, text: string, maxPx: number): string[] {
    const sctx = this.scratch.getContext("2d", { willReadFrequently: true })!;
    sctx.font = font;
    const lines: string[] = [];
    for (const para of text.split("\n")) {
      let cur = "";
      for (const ch of para) {
        if (cur.length === 0 && ch === " ") continue; // no leading space
        if (sctx.measureText(cur + ch).width <= maxPx || cur.length === 0) {
          cur += ch;
        } else {
          const lastSpace = cur.lastIndexOf(" ");
          if (lastSpace > 0) {
            lines.push(cur.slice(0, lastSpace));
            cur = cur.slice(lastSpace + 1);
          } else {
            lines.push(cur);
            cur = "";
          }
          if (ch !== " ") cur += ch;
        }
      }
      if (cur.length > 0) lines.push(cur);
    }
    return lines;
  }

  // ---- Replying tick (main.rs State::Replying) ----

  private budget(): number {
    return Math.max(1, Math.round(this.pointsPerTickRef * this.sc));
  }

  private readonly ticker = (): void => {
    if (this.phase !== "WRITING") return;
    const ctx = this.ctx;
    const t0 = performance.now();
    let budget = this.budget();
    const r = NIB_R_REF * this.sc;
    ctx.strokeStyle = "#000";
    ctx.fillStyle = "#000";
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.lineWidth = 2 * r + 1;
    while (budget > 0 && this.strokeI < this.strokes.length) {
      const st = this.strokes[this.strokeI];
      if (this.pointI >= st.length) {
        this.strokeI++;
        this.pointI = 0;
        continue;
      }
      const p = st[this.pointI];
      if (this.pointI > 0) {
        const q = st[this.pointI - 1];
        ctx.beginPath();
        ctx.moveTo(q.x, q.y);
        ctx.lineTo(p.x, p.y);
        ctx.stroke();
      } else {
        ctx.beginPath();
        ctx.arc(p.x, p.y, r + 0.5, 0, Math.PI * 2);
        ctx.fill();
      }
      this.pointI++;
      budget--;
    }
    this.ticks++;
    if (performance.now() - t0 > this.tickMs) this.lateTicks++;
    if (this.strokeI >= this.strokes.length) {
      if (this.oracleActive) {
        // The stream is still open: the quill hovers, awaiting ink
        // (main.rs: Replying with rx Some).
        this.ui.postDelayed(this.ticker, this.tickMs);
        return;
      }
      this.phase = "LINGERING";
      const pts = this.strokes.reduce((n, s) => n + s.length, 0);
      const elapsed = Math.round(performance.now() - this.writeStartMs);
      const linger = Math.min(4000 + 2 * pts, 20_000);
      this.status(
        `wrote ${pts} pts / ${this.strokes.length} strokes in ${elapsed}ms ` +
          `(${this.ticks} ticks, ${this.lateTicks} late) — ` +
          `fades in ${Math.trunc(linger / 1000)}s, tap page to skip`,
      );
      this.ui.postDelayed(this.startDissolve, linger);
    } else {
      this.ui.postDelayed(this.ticker, this.tickMs);
    }
  };

  // ---- FadingReply (main.rs) + dissolve_pass (ink.rs) ----

  private readonly startDissolve = (): void => {
    if (this.phase === "LINGERING") {
      this.phase = "DISSOLVING";
      this.dissolveStage = 0;
      this.ui.post(this.dissolveTicker);
    }
  };

  private readonly dissolveTicker = (): void => {
    if (this.phase !== "DISSOLVING") return;
    const reg = this.region;
    if (reg === null) {
      this.finishFade();
      return;
    }
    this.dissolveRegionPass(reg, this.dissolveStage);
    this.dissolveStage++;
    if (this.dissolveStage >= DISSOLVE_STAGES) this.finishFade();
    else this.ui.postDelayed(this.dissolveTicker, DISSOLVE_TICK_MS);
  };

  /** One dissolve_pass (ink.rs): erase this stage's hashed pixels in `regIn`. */
  private dissolveRegionPass(regIn: Rect, stage: number): void {
    const r = regIn.copy();
    if (!r.intersect(0, 0, this.width, this.height) || r.isEmpty) return;
    const wpx = r.width;
    const hpx = r.height;
    const img = this.ctx.getImageData(r.left, r.top, wpx, hpx);
    const px = img.data;
    for (let yy = 0; yy < hpx; yy++) {
      for (let xx = 0; xx < wpx; xx++) {
        const i = (yy * wpx + xx) * 4;
        const luma = Math.trunc((px[i] + px[i + 1] + px[i + 2]) / 3);
        if (luma < 250 && dissolvesAt(r.left + xx, r.top + yy, stage, DISSOLVE_STAGES)) {
          px[i] = 255;
          px[i + 1] = 255;
          px[i + 2] = 255;
          px[i + 3] = 255;
        }
      }
    }
    this.ctx.putImageData(img, r.left, r.top);
  }

  private finishFade(): void {
    this.phase = "IDLE";
    this.resetPlan();
    this.clearToWhite();
    this.status(`page clean — pace=${this.tickMs}ms×${this.budget()}`);
  }

  // ---- helpers ----

  private clearToWhite(): void {
    this.ctx.fillStyle = "#fff";
    this.ctx.fillRect(0, 0, this.width, this.height);
  }

  private resetPlan(): void {
    this.strokes = [];
    this.strokeI = 0;
    this.pointI = 0;
    this.region = null;
    this.nextY = -1;
    this.userInkRegion = null;
    this.hasUserInk = false;
  }

  private growRegion(x: number, y: number, margin: number): void {
    const r = this.region ?? new Rect(x, y, x, y);
    this.region = r;
    r.union(x - margin, y - margin);
    r.union(x + margin, y + margin);
  }

  private status(s: string): void {
    this.onStatus?.(s);
  }
}

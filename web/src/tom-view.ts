// The page. Ported from boox-spike's TomView.kt — a lasting ink layer,
// plus a disposable overlay for the oracle's spoken words:
//
// - DRAWINGS stay. The user's ink and the oracle's blue strokes live on the
//   ink layer and accumulate across turns; nothing drawn ever fades.
// - The USER'S WORDS pass. A second, parallel oracle call reads the same
//   snapshot and answers which writing is conversational
//   (oracle.askTextRegions); those boxes dissolve — black ink only.
// - The ORACLE'S WORDS pass too. Its TEXT replies ink onto their own
//   overlay and self-dismiss 3.5s after writing ends — an overlay, because
//   erasing an upper stroke from a shared bitmap would leave holes where it
//   crossed the ink below.
//
// No layer switch, no gesture to learn: write, draw, lift the pen, and the
// idle commit (2.8s) sends the page — to the artist (streamed reply blocks)
// and to the region detector at once. The snapshot carries a faint
// measuring grid (never the page): vision models misplace absolute
// positions on blank paper by ~7% of the frame; a printed ruler in the
// reply's own coordinate space cut that ~3x in bench runs.
//
// What the browser translation changes (vs the Kotlin original):
// - android.graphics.Canvas/Bitmap → offscreen <canvas> layers composited
//   onto the display canvas; repaint(rect) replaces Epd.partial.
// - MotionEvent → Pointer Events; the batched history drain becomes
//   getCoalescedEvents (which INCLUDES the current sample — no double ink).
// - No RawPen / EpdController: the browser has no raw stylus path and no
//   waveform control. The two-finger chrome-restore gesture went with it.

import {
  densify,
  mapToCanvas,
  type Block,
  type StrokeBlock,
  type TextBlock,
} from "./reply-dsl";
import { dissolvesAt, thin, trace, type Pt } from "./script";
import type { Oracle, Snapshot, TextBox } from "./oracle";

// ---- constants from riddle main.rs / ink.rs ----
const REPLY_PX_REF = 96;
const MARGIN_X_REF = 120;
const LINE_H_FACTOR = 1.25;
const NIB_R_REF = 2;
// The oracle's DRAWING nib: 2 + 3·0.5 — the user's pressure nib at typical
// mid pressure, so its sketches weigh the same as the hand's.
const DRAW_NIB_R_REF = 3.5;
const DISSOLVE_STAGES = 10;
const DISSOLVE_TICK_MS = 80;
const IDLE_COMMIT_MS = 2800;
// The spoken words dismiss themselves after a fixed beat; drawings are on
// the lasting layer and never fade.
const LINGER_MS = 3500;
// Grid pitch on the snapshot, in snapshot pixels; labels every 2nd line.
const GRID_STEP_PX = 50;

// The oracle's ink — a color the user's black never is, quoted to the model
// in SYSTEM_PROMPT so it can tell its own strokes apart. rgb(30, 90, 200).
const AI_INK = "#1e5ac8";

// Tom's hand: Caveat (flowing but legible, Latin-only) with LXGW WenKai TC
// (handwritten 楷體) catching CJK replies — the same TTFs boox-spike bundles
// (loaded via style.css straight from its assets).
const FONT_STACK = '"Caveat", "LXGW WenKai TC"';

type Phase = "IDLE" | "THINKING" | "WRITING" | "LINGERING" | "DISSOLVING";

/** Which ink a dissolve pass may erase, told apart by color. */
type InkKind = "user-black" | "oracle-blue";

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

// textInk: a traced glyph (fine quill nib, overlay, fades with the linger)
// vs a drawing stroke (heavy nib, ink layer, stays on the page).
interface Planned {
  pts: Pt[];
  textInk: boolean;
}

export class TomView {
  /** Pace, settable like the Android field. riddle's own pace is 14ms/26pts. */
  tickMs = 14;
  pointsPerTickRef = 26;

  onStatus: ((s: string) => void) | null = null;

  /** The spirit on the page; null until the oracle env is configured. */
  oracle: Oracle | null = null;

  private readonly ctx: CanvasRenderingContext2D;
  private readonly scratch = document.createElement("canvas");
  private readonly ui = new Scheduler();

  // The ink layer: the user's ink and the oracle's DRAWINGS. What fades
  // here is decided by color (user black) and region (detector boxes).
  private penLayer: HTMLCanvasElement | null = null;
  private penCtx: CanvasRenderingContext2D | null = null;

  // The oracle's SPOKEN words only — an overlay so removing them reveals
  // whatever they covered.
  private textLayer: HTMLCanvasElement | null = null;
  private textCtx: CanvasRenderingContext2D | null = null;

  private phase: Phase = "IDLE";

  // ---- write plan (plan_reply / WritePlan) ----
  private strokes: Planned[] = [];
  private strokeI = 0;
  private pointI = 0;
  private fadeRegion: Rect | null = null;
  private nextY = -1;
  private jitterSeed = 0x1234;

  // ---- metrics ----
  private writeStartMs = 0;
  private ticks = 0;
  private lateTicks = 0;
  private dissolveStage = 0;

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext("2d")!;
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
    // Resizes are rare but disruptive: removeAll cancels whatever the turn
    // had queued. Log every one — an unexplained dead turn should be
    // traceable to this line.
    console.info(`onSizeChanged ${this.canvas.width}x${this.canvas.height} → ${w}x${h} (phase=${this.phase})`);
    this.ui.removeAll();
    this.canvas.width = w;
    this.canvas.height = h;
    // The layers survive a re-layout: ink stays anchored top-left, and the
    // bitmaps only ever grow, so ink below the fold reappears when the view
    // grows back. Only Clear may empty them.
    this.penLayer = this.remapLayer(this.penLayer, w, h);
    this.penCtx = this.penLayer.getContext("2d", { willReadFrequently: true })!;
    this.textLayer = this.remapLayer(this.textLayer, w, h);
    this.textCtx = this.textLayer.getContext("2d", { willReadFrequently: true })!;
    this.repaint();
    // Planned coordinates are page-space and the page keeps its top-left
    // anchor, so the turn resumes exactly where the resize cut it: just
    // re-arm the callback the phase was waiting on.
    switch (this.phase) {
      case "IDLE":
        if (this.hasUserInk) this.scheduleCommit();
        break;
      case "THINKING":
        if (this.drinkStage >= 0) this.ui.post(this.drinkTicker);
        break;
      case "WRITING":
        this.ui.post(this.ticker);
        break;
      case "LINGERING":
        this.ui.postDelayed(this.startDissolve, 2000);
        break;
      case "DISSOLVING":
        this.ui.post(this.dissolveTicker);
        break;
    }
  }

  /**
   * Grow-only: the new layer is at least as large as both the view and the
   * old layer, so a shrink crops nothing — the hidden band returns when the
   * view grows back. Reused as-is when already big enough.
   */
  private remapLayer(old: HTMLCanvasElement | null, w: number, h: number): HTMLCanvasElement {
    const tw = Math.max(w, old?.width ?? 0);
    const th = Math.max(h, old?.height ?? 0);
    if (old && old.width === tw && old.height === th) return old;
    const next = document.createElement("canvas");
    next.width = tw;
    next.height = th;
    if (old) next.getContext("2d")!.drawImage(old, 0, 0);
    return next;
  }

  /** White paper, the lasting ink, the fleeting spoken words on top —
   *  composited for the given page rect (the web's Epd.partial). */
  private repaint(l = 0, t = 0, r = this.width, b = this.height): void {
    const rl = Math.max(0, Math.floor(l));
    const rt = Math.max(0, Math.floor(t));
    const rr = Math.min(this.width, Math.ceil(r));
    const rb = Math.min(this.height, Math.ceil(b));
    if (rl >= rr || rt >= rb) return;
    const w = rr - rl;
    const h = rb - rt;
    this.ctx.fillStyle = "#fff";
    this.ctx.fillRect(rl, rt, w, h);
    if (this.penLayer) this.ctx.drawImage(this.penLayer, rl, rt, w, h, rl, rt, w, h);
    if (this.textLayer) this.ctx.drawImage(this.textLayer, rl, rt, w, h, rl, rt, w, h);
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
    this.flushInk();
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
    this.flushInk();
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

  private inkDirty: Rect | null = null;

  /** One ink segment; nib radius follows pressure like riddle's brush. */
  private inkSegment(x: number, y: number, pressure: number, first: boolean): void {
    const pg = this.penCtx;
    if (!pg) return;
    const p = Math.min(1, Math.max(0, pressure));
    this.pMin = Math.min(this.pMin, p);
    this.pMax = Math.max(this.pMax, p);
    // riddle main.rs:345 — r = 2 + pressure*3/MAX: a full-bodied base nib
    // with a gentle 2x swell at full pressure. The proven hand-feel.
    const r = (2 + 3 * p) * this.sc;
    pg.strokeStyle = "#000";
    pg.fillStyle = "#000";
    pg.lineCap = "round";
    pg.lineJoin = "round";
    pg.lineWidth = 2 * r + 1;
    if (first) {
      pg.beginPath();
      pg.arc(x, y, r + 0.5, 0, Math.PI * 2);
      pg.fill();
    } else {
      pg.beginPath();
      pg.moveTo(this.lastX, this.lastY);
      pg.lineTo(x, y);
      pg.stroke();
    }
    const margin = Math.trunc(r + 4 * this.sc);
    const d =
      this.inkDirty ??
      new Rect(Math.trunc(x), Math.trunc(y), Math.trunc(x), Math.trunc(y));
    this.inkDirty = d;
    d.union(Math.trunc(Math.min(this.lastX, x)) - margin, Math.trunc(Math.min(this.lastY, y)) - margin);
    d.union(Math.trunc(Math.max(this.lastX, x)) + margin, Math.trunc(Math.max(this.lastY, y)) + margin);
    // inkSegment only ever draws the writer's ink — the commit gates on it.
    this.hasUserInk = true;
    this.lastX = x;
    this.lastY = y;
    this.strokePts++;
  }

  /** One repaint per pointer-event batch. */
  private flushInk(): void {
    const d = this.inkDirty;
    if (!d) return;
    this.inkDirty = null;
    this.repaint(d.left, d.top, d.right, d.bottom);
  }

  // ---- the oracle turn: idle commit → two parallel calls → reply ----
  // IDLE_COMMIT 2.8s after pen-up (main.rs). The snapshot goes to the
  // artist (streamed reply blocks) and to the region detector at once; the
  // user's words fade when the detector's boxes arrive, drawings stay.

  private hasUserInk = false;
  private oracleActive = false;
  private turnWrote = false;

  // The pixel frame of the last snapshot — the coordinate system every
  // reply block is expressed in (see reply-dsl).
  private snapW = 1;
  private snapH = 1;

  // ≥0 while the word-fade is dissolving the detector's boxes (page-space
  // rects of the user's writing). Independent of the phase machine: the
  // boxes can arrive while the reply is already inking.
  private drinkStage = -1;
  private drinkBoxes: Rect[] = [];

  private readonly drinkTicker = (): void => {
    if (this.drinkStage < 0) return;
    if (this.drinkBoxes.length === 0) {
      this.finishDrink();
      return;
    }
    for (const b of this.drinkBoxes) {
      this.dissolveRegionPass(this.penLayer, b, this.drinkStage, "user-black");
    }
    this.drinkStage++;
    if (this.drinkStage >= DISSOLVE_STAGES) this.finishDrink();
    else this.ui.postDelayed(this.drinkTicker, DISSOLVE_TICK_MS);
  };

  /** End the word-fade — naturally, or in one gulp when new ink is due. */
  private finishDrink(): void {
    if (this.drinkStage < 0) return;
    this.ui.removeCallbacks(this.drinkTicker);
    // The staged passes leave nothing by the last stage; this is the
    // one-gulp path for a reply that outran the animation.
    for (const b of this.drinkBoxes) {
      this.dissolveRegionPass(this.penLayer, b, DISSOLVE_STAGES - 1, "user-black");
    }
    this.drinkBoxes = [];
    this.drinkStage = -1;
  }

  /**
   * The region detector answered: its snapshot-pixel boxes become
   * page-space rects and the user's words fade out of the page — black ink
   * only, so the oracle's blue and any overlap survive. Drawings were never
   * boxed, so they stay. No boxes = nothing was writing.
   */
  private onTextRegions(boxes: TextBox[]): void {
    if (boxes.length === 0) return;
    const sx = this.width / Math.max(1, this.snapW);
    const sy = this.height / Math.max(1, this.snapH);
    const pad = Math.round(6 * this.sc);
    this.drinkBoxes = boxes.map(
      (b) =>
        new Rect(
          Math.trunc(b.x0 * sx) - pad,
          Math.trunc(b.y0 * sy) - pad,
          Math.trunc(b.x1 * sx) + pad,
          Math.trunc(b.y1 * sy) + pad,
        ),
    );
    console.info(
      `word-fade: ${this.drinkBoxes.length} region(s), snapshot→page ×${sx.toFixed(2)}/${sy.toFixed(2)}`,
    );
    this.drinkStage = 0;
    this.ui.post(this.drinkTicker);
  }

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
    const snap = this.capturePage();
    if (snap === null) return;
    this.oracleActive = true;
    this.turnWrote = false;
    this.phase = "THINKING";
    this.hasUserInk = false;
    this.status("the page is thinking…");
    // The word-fade rides the second, parallel call: the detector reads the
    // same snapshot and answers where the writing is; those boxes dissolve
    // when it comes back (onTextRegions). Best-effort — if it fails, the
    // words simply stay this turn.
    void o.askTextRegions(snap).then((boxes) => this.onTextRegions(boxes));
    void o.ask(snap, {
      onBlock: (block) => this.onOracleBlock(block),
      onDone: () => this.onOracleDone(),
      onError: (reason) => this.onOracleError(reason),
    });
  }

  /**
   * The measuring grid the oracle reads positions from — printed on the
   * snapshot ONLY, never the page. Drawn under the ink so page content
   * wins.
   */
  private drawMeasuringGrid(c: CanvasRenderingContext2D, w: number, h: number): void {
    c.strokeStyle = "#bbbbbb";
    c.lineWidth = 1;
    c.fillStyle = "#888888";
    c.font = "13px sans-serif";
    for (let x = GRID_STEP_PX; x < w; x += GRID_STEP_PX) {
      c.beginPath();
      c.moveTo(x, 0);
      c.lineTo(x, h);
      c.stroke();
      if (x % (2 * GRID_STEP_PX) === 0) {
        c.fillText(String(x), x + 3, 14);
        c.fillText(String(x), x + 3, h - 4);
      }
    }
    for (let y = GRID_STEP_PX; y < h; y += GRID_STEP_PX) {
      c.beginPath();
      c.moveTo(0, y);
      c.lineTo(w, y);
      c.stroke();
      if (y % (2 * GRID_STEP_PX) === 0) {
        c.fillText(String(y), 3, y - 3);
        c.fillText(String(y), w - 34, y - 3);
      }
    }
  }

  /**
   * The whole page, both layers over white, downscaled to ≤800px on the
   * long side. Full-page (not cropped to the ink) because the reply's
   * coordinates live in this exact frame — a crop would shear the mapping
   * between what the model sees and where it draws. The measuring grid is
   * printed under the ink (see drawMeasuringGrid).
   */
  private capturePage(): Snapshot | null {
    const pen = this.penLayer;
    if (!pen || this.width <= 0 || this.height <= 0) return null;
    const f = Math.max(2, Math.ceil(Math.max(this.width, this.height) / 800));
    const w = Math.max(1, Math.floor(this.width / f));
    const h = Math.max(1, Math.floor(this.height / f));
    const snap = document.createElement("canvas");
    snap.width = w;
    snap.height = h;
    const c = snap.getContext("2d")!;
    c.fillStyle = "#fff";
    c.fillRect(0, 0, w, h);
    this.drawMeasuringGrid(c, w, h);
    c.drawImage(pen, 0, 0, this.width, this.height, 0, 0, w, h);
    // Spoken words still on the page at commit are part of what it sees.
    if (this.textLayer) {
      c.drawImage(this.textLayer, 0, 0, this.width, this.height, 0, 0, w, h);
    }
    const pngDataUrl = snap.toDataURL("image/png");
    // The reply's coordinate system is this frame — planText/planStroke
    // scale block coordinates from it back up to the page.
    this.snapW = w;
    this.snapH = h;
    console.info(`sent page ${w}x${h} (${pngDataUrl.length}B as data URL)`);
    return {
      pngDataUrl,
      width: w,
      height: h,
      textLineH: Math.round((REPLY_PX_REF * this.sc * LINE_H_FACTOR) / f),
    };
  }

  private onOracleBlock(block: Block): void {
    // Snapshot-space paper trail: what the model SAID, before any mapping —
    // pair with the planText/planStroke px lines to split blame between the
    // model's coordinates and our rendering.
    console.info(`oracle block: ${describe(block)}`);
    if (!this.oracleActive) return;
    // SEE is memory, not ink — it must not count as a visible reply, or a
    // notes-only turn would leave the page stuck thinking forever.
    if (block.kind === "see") return;
    this.turnWrote = true;
    this.ink(block);
  }

  private onOracleDone(): void {
    this.oracleActive = false;
    if (this.phase === "THINKING" && !this.turnWrote) this.writeExcuse("empty reply");
  }

  private onOracleError(reason: string): void {
    console.warn(`oracle error: ${reason}`);
    this.oracleActive = false;
    this.writeExcuse(reason);
  }

  private writeExcuse(reason: string): void {
    this.turnWrote = true;
    this.write(excuseFor(reason));
  }

  // ---- planning the oracle's ink ----

  /** Plan one streamed reply block and make sure the quill is moving. */
  private ink(block: TextBlock | StrokeBlock): void {
    this.prepareForNewInk();
    if (block.kind === "text") this.planText(block);
    else this.planStroke(block);
    this.startWriting();
  }

  /**
   * Ink `text` onto the page with no snapshot position (excuses, the Write
   * button): the legacy centered flow — below the previous reply, erasing
   * the previous reply's words first when the page would overflow.
   */
  write(text: string): void {
    this.prepareForNewInk();
    const lineH = Math.trunc(REPLY_PX_REF * this.sc * LINE_H_FACTOR);
    if (this.nextY >= 0 && this.nextY + 2 * lineH > this.height) {
      this.eraseReplyText();
      this.resetPlan();
    }
    this.planReply(text);
    this.startWriting();
    this.status(`writing… pace=${this.tickMs}ms×${this.budget()}`);
  }

  /** A reply block arriving after the linger clears the stage first. */
  private prepareForNewInk(): void {
    // A word-fade mid-flight? Swallow it in one gulp — the reply must never
    // ink over words that are mid-dissolve.
    this.finishDrink();
    if (this.phase === "LINGERING" || this.phase === "DISSOLVING") {
      this.ui.removeAll();
      this.eraseReplyText();
      this.resetPlan();
      this.phase = "IDLE";
    }
  }

  private startWriting(): void {
    if (this.phase !== "WRITING") {
      this.phase = "WRITING";
      this.writeStartMs = performance.now();
      this.ticks = 0;
      this.lateTicks = 0;
      this.ui.post(this.ticker);
    }
  }

  /** One-gulp erase of the reply's spoken words — the whole overlay goes,
   *  revealing untouched ink beneath. */
  private eraseReplyText(): void {
    const t = this.textLayer;
    if (t) this.textCtx?.clearRect(0, 0, t.width, t.height);
    this.repaint();
  }

  /** Clear ends the whole session: the page AND the oracle's memory. */
  clearPage(): void {
    this.ui.removeAll();
    this.phase = "IDLE";
    // Drop anything still streaming in — it belongs to the dead session.
    this.oracleActive = false;
    this.resetPlan();
    const p = this.penLayer;
    if (p) this.penCtx?.clearRect(0, 0, p.width, p.height);
    const t = this.textLayer;
    if (t) this.textCtx?.clearRect(0, 0, t.width, t.height);
    this.oracle?.resetSession();
    this.repaint();
    this.status(`cleared — 新 session，pace=${this.tickMs}ms×${this.budget()}`);
  }

  // ---- plan_reply, same layout math ----

  /** Legacy flow layout: centered lines from nextY (excuses / Write button). */
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
      this.planTextLine(font, lineText, null, y);
      y += lineH;
    }
    this.nextY = y;
  }

  /** A TEXT block: left-aligned at its snapshot position, wrapping to the margin. */
  private planText(block: TextBlock): void {
    const px = REPLY_PX_REF * this.sc;
    const font = `${px}px ${FONT_STACK}`;
    const lineH = Math.trunc(px * LINE_H_FACTOR);
    // Snapshot pixels → page pixels, clamped so the block keeps at least a
    // quarter page to wrap into and never starts below the last line.
    const x0 = Math.trunc(
      Math.min(
        Math.max((block.x * this.width) / Math.max(1, this.snapW), 0),
        Math.max(0, this.width * 0.75),
      ),
    );
    const maxW = this.width - x0 - MARGIN_X_REF * this.sc;
    const lines = this.wrap(font, block.text, maxW);
    let y = Math.trunc((block.y * this.height) / Math.max(1, this.snapH));
    y = Math.min(Math.max(y, 0), Math.max(0, this.height - lineH * lines.length));
    console.info(`text → px x0=${x0} y=${y}, ${lines.length} line(s) (page ${this.width}x${this.height})`);
    for (const lineText of lines) {
      this.planTextLine(font, lineText, x0, y);
      y += lineH;
    }
  }

  /** Rasterize → thin → trace one line into fading quill strokes. */
  private planTextLine(font: string, lineText: string, xLeft: number | null, y: number): void {
    const px = REPLY_PX_REF * this.sc;
    const m = this.rasterize(font, px, lineText);
    thin(m.mask, m.w, m.h);
    const lineStrokes = trace(m.mask, m.w, m.h);
    const x0 = xLeft ?? Math.trunc((this.width - m.w) / 2);
    const wobble = this.jitter();
    for (const s of lineStrokes) {
      const mapped = s.map((p) => ({ x: x0 + p.x, y: y + p.y + wobble }));
      for (const p of mapped) this.growFadeRegion(p.x, p.y, Math.round(5 * this.sc));
      this.strokes.push({ pts: mapped, textInk: true });
    }
  }

  /** A STROKE block: snapshot anchors → page pixels → smooth dense curve. */
  private planStroke(block: StrokeBlock): void {
    this.jitter(); // advance the shared LCG so each stroke wobbles differently
    const mapped = mapToCanvas(block.points, this.snapW, this.snapH, this.width, this.height);
    const dense = densify(
      mapped,
      Math.max(1, Math.round(2 * this.sc)),
      1.5 * this.sc,
      this.jitterSeed,
    );
    const xs = mapped.map((p) => p.x);
    const ys = mapped.map((p) => p.y);
    console.info(
      `stroke → px(${Math.min(...xs)},${Math.min(...ys)})..(${Math.max(...xs)},${Math.max(...ys)}), ` +
        `${dense.length} dense pts (page ${this.width}x${this.height})`,
    );
    // No growFadeRegion: drawing strokes survive the fade by design.
    this.strokes.push({ pts: dense, textInk: false });
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
    const t0 = performance.now();
    let budget = this.budget();
    const margin = Math.max(4, Math.round(4 * this.sc));
    let dirty: Rect | null = null;
    const grow = (x: number, y: number) => {
      const d = dirty ?? new Rect(x, y, x, y);
      dirty = d;
      d.union(x - margin, y - margin);
      d.union(x + margin, y + margin);
    };
    while (budget > 0 && this.strokeI < this.strokes.length) {
      const st = this.strokes[this.strokeI];
      // Spoken words go to the disposable overlay; drawings to the lasting
      // ink layer.
      const pg = st.textInk ? this.textCtx : this.penCtx;
      if (!pg || this.pointI >= st.pts.length) {
        this.strokeI++;
        this.pointI = 0;
        continue;
      }
      // Drawing strokes carry the hand's weight; text stays a fine quill so
      // the script keeps its traced-glyph look.
      const r = (st.textInk ? NIB_R_REF : DRAW_NIB_R_REF) * this.sc;
      pg.strokeStyle = AI_INK;
      pg.fillStyle = AI_INK;
      pg.lineCap = "round";
      pg.lineJoin = "round";
      pg.lineWidth = 2 * r + 1;
      const p = st.pts[this.pointI];
      if (this.pointI > 0) {
        const q = st.pts[this.pointI - 1];
        pg.beginPath();
        pg.moveTo(q.x, q.y);
        pg.lineTo(p.x, p.y);
        pg.stroke();
        grow(q.x, q.y);
      } else {
        pg.beginPath();
        pg.arc(p.x, p.y, r + 0.5, 0, Math.PI * 2);
        pg.fill();
      }
      grow(p.x, p.y);
      this.pointI++;
      budget--;
    }
    if (dirty !== null) {
      const d: Rect = dirty;
      this.repaint(d.left, d.top, d.right, d.bottom);
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
      const pts = this.strokes.reduce((n, s) => n + s.pts.length, 0);
      const elapsed = Math.round(performance.now() - this.writeStartMs);
      this.status(
        `wrote ${pts} pts / ${this.strokes.length} strokes in ${elapsed}ms ` +
          `(${this.ticks} ticks, ${this.lateTicks} late) — words fade in 3.5s, tap to skip`,
      );
      this.ui.postDelayed(this.startDissolve, LINGER_MS);
    } else {
      this.ui.postDelayed(this.ticker, this.tickMs);
    }
  };

  // ---- FadingReply (main.rs) + dissolve_pass (ink.rs) ----
  // Words dissolve, drawings never do: the word-fade eats the writer's
  // black ink inside the detector's boxes, the reply-fade eats the blue
  // quill text inside the fade region. Color tells them apart.

  private readonly startDissolve = (): void => {
    if (this.phase === "LINGERING") {
      this.phase = "DISSOLVING";
      this.dissolveStage = 0;
      this.ui.post(this.dissolveTicker);
    }
  };

  private readonly dissolveTicker = (): void => {
    if (this.phase !== "DISSOLVING") return;
    const reg = this.fadeRegion;
    if (reg === null) {
      this.finishFade();
      return;
    }
    this.dissolveRegionPass(this.textLayer, reg, this.dissolveStage, "oracle-blue");
    this.dissolveStage++;
    if (this.dissolveStage >= DISSOLVE_STAGES) this.finishFade();
    else this.ui.postDelayed(this.dissolveTicker, DISSOLVE_TICK_MS);
  };

  /** One dissolve_pass (ink.rs): erase this stage's hashed pixels of the
   *  given ink color in `regIn` — the other color's ink is untouchable. */
  private dissolveRegionPass(
    layer: HTMLCanvasElement | null,
    regIn: Rect,
    stage: number,
    kind: InkKind,
  ): void {
    if (!layer) return;
    const lctx = layer.getContext("2d", { willReadFrequently: true })!;
    const r = regIn.copy();
    if (!r.intersect(0, 0, this.width, this.height) || r.isEmpty) return;
    const wpx = r.width;
    const hpx = r.height;
    const img = lctx.getImageData(r.left, r.top, wpx, hpx);
    const px = img.data;
    for (let yy = 0; yy < hpx; yy++) {
      for (let xx = 0; xx < wpx; xx++) {
        const i = (yy * wpx + xx) * 4;
        // The layer is transparent where there is no ink, so presence is
        // alpha, not luma. The user writes near-black; the oracle's ink is
        // blue-heavy — the blue channel tells them apart.
        const isKind = kind === "user-black" ? px[i + 2] < 128 : px[i + 2] >= 128;
        if (
          px[i + 3] !== 0 &&
          isKind &&
          dissolvesAt(r.left + xx, r.top + yy, stage, DISSOLVE_STAGES)
        ) {
          px[i + 3] = 0;
        }
      }
    }
    lctx.putImageData(img, r.left, r.top);
    this.repaint(r.left, r.top, r.right, r.bottom);
  }

  private finishFade(): void {
    this.phase = "IDLE";
    this.eraseReplyText();
    this.resetPlan();
    this.status(`page clean — pace=${this.tickMs}ms×${this.budget()}`);
  }

  // ---- helpers ----

  private resetPlan(): void {
    this.strokes = [];
    this.strokeI = 0;
    this.pointI = 0;
    this.fadeRegion = null;
    this.nextY = -1;
    this.hasUserInk = false;
    this.drinkStage = -1; // a still-queued drinkTicker no-ops once negative
    this.drinkBoxes = [];
  }

  private growFadeRegion(x: number, y: number, margin: number): void {
    const r = this.fadeRegion ?? new Rect(x, y, x, y);
    this.fadeRegion = r;
    r.union(x - margin, y - margin);
    r.union(x + margin, y + margin);
  }

  private status(s: string): void {
    this.onStatus?.(s);
  }
}

/** Stay in character, keep the clue. */
function excuseFor(reason: string): string {
  return `The ink blurs and will not settle… (${reason.slice(0, 80)})`;
}

/** Snapshot-space digest of one reply block, for the console paper trail. */
function describe(block: Block): string {
  switch (block.kind) {
    case "text":
      return `TEXT(${block.x}, ${block.y}) "${clip(block.text)}"`;
    case "see":
      return `SEE "${clip(block.text)}"`;
    case "stroke": {
      const xs = block.points.map((p) => p.x);
      const ys = block.points.map((p) => p.y);
      return (
        `STROKE ${block.points.length}pts ` +
        `snap(${Math.min(...xs)},${Math.min(...ys)})→(${Math.max(...xs)},${Math.max(...ys)})`
      );
    }
  }
}

function clip(s: string): string {
  const t = s.replace(/\n/g, "⏎");
  return t.length > 80 ? t.slice(0, 80) + "…" : t;
}

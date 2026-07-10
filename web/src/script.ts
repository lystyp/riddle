// Tom Riddle's hand, ported line-for-line from boox-spike's Script.kt
// (itself a port of riddle/src/script.rs thin/trace + ink.rs px_hash).
// Pure functions — no DOM, no canvas — so the port is verified by the same
// property tests as the Kotlin side (test/script.test.ts).
//
// Masks are Uint8Array (0/1) where Kotlin used BooleanArray; 32-bit integer
// semantics (wrapping multiply, unsigned shift) come from Math.imul / >>>.

export interface Pt {
  x: number;
  y: number;
}

/** Zhang-Suen thinning: reduce the mask to 1px-wide skeleton lines. */
export function thin(mask: Uint8Array, w: number, h: number): void {
  const idx = (x: number, y: number) => y * w + x;
  for (;;) {
    let changed = false;
    for (let phase = 0; phase <= 1; phase++) {
      const toClear: number[] = [];
      for (let y = 1; y < h - 1; y++) {
        for (let x = 1; x < w - 1; x++) {
          if (!mask[idx(x, y)]) continue;
          const p = [
            mask[idx(x, y - 1)], // p2 N
            mask[idx(x + 1, y - 1)], // p3 NE
            mask[idx(x + 1, y)], // p4 E
            mask[idx(x + 1, y + 1)], // p5 SE
            mask[idx(x, y + 1)], // p6 S
            mask[idx(x - 1, y + 1)], // p7 SW
            mask[idx(x - 1, y)], // p8 W
            mask[idx(x - 1, y - 1)], // p9 NW
          ];
          let b = 0;
          for (const v of p) if (v) b++;
          if (b < 2 || b > 6) continue;
          let a = 0;
          for (let i = 0; i < 8; i++) {
            if (!p[i] && p[(i + 1) % 8]) a++;
          }
          if (a !== 1) continue;
          let c1: boolean;
          let c2: boolean;
          if (phase === 0) {
            c1 = !(p[0] && p[2] && p[4]);
            c2 = !(p[2] && p[4] && p[6]);
          } else {
            c1 = !(p[0] && p[2] && p[6]);
            c2 = !(p[0] && p[4] && p[6]);
          }
          if (c1 && c2) toClear.push(idx(x, y));
        }
      }
      if (toClear.length > 0) {
        changed = true;
        for (const i of toClear) mask[i] = 0;
      }
    }
    if (!changed) break;
  }
}

/**
 * Trace the skeleton into polyline strokes, ordered left-to-right so the
 * animation writes like a hand.
 */
export function trace(mask: Uint8Array, w: number, h: number): Pt[][] {
  const at = (x: number, y: number): boolean =>
    x >= 0 && y >= 0 && x < w && y < h && mask[y * w + x] !== 0;

  const neighbors = (x: number, y: number): Pt[] => {
    const out: Pt[] = [];
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if ((dx !== 0 || dy !== 0) && at(x + dx, y + dy)) out.push({ x: x + dx, y: y + dy });
      }
    }
    return out;
  };

  const visited = new Uint8Array(w * h);

  // Endpoints first (degree 1), then any remaining pixels (loops).
  const starts: Pt[] = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (at(x, y) && neighbors(x, y).length === 1) starts.push({ x, y });
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (at(x, y)) starts.push({ x, y });
    }
  }

  const strokes: Pt[][] = [];
  for (const s of starts) {
    if (visited[s.y * w + s.x]) continue;
    const path: Pt[] = [s];
    visited[s.y * w + s.x] = 1;
    let cx = s.x;
    let cy = s.y;
    for (;;) {
      const next = neighbors(cx, cy).find((n) => !visited[n.y * w + n.x]);
      if (!next) break;
      visited[next.y * w + next.x] = 1;
      path.push(next);
      cx = next.x;
      cy = next.y;
    }
    if (path.length >= 3) strokes.push(path);
  }
  // No Math.min(...points): long strokes overflow the spread-arg limit.
  const minX = (s: Pt[]): number => {
    let m = s[0].x;
    for (const p of s) if (p.x < m) m = p.x;
    return m;
  };
  strokes.sort((a, b) => minX(a) - minX(b));
  return strokes;
}

/** Deterministic per-pixel hash for the dissolve pattern (u32 semantics). */
export function pxHash(x: number, y: number): number {
  let h = Math.imul(x, 0x9e3779b1) ^ Math.imul(y, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  return h ^ (h >>> 16);
}

/** True if pixel (x, y) dissolves at `stage` of `stages` (ink.rs dissolve_pass). */
export function dissolvesAt(x: number, y: number, stage: number, stages: number): boolean {
  return (pxHash(x, y) >>> 0) % stages <= stage;
}

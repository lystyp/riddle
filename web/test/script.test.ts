/**
 * Unit test — script.ts (thin / trace / dissolvesAt)
 *
 * Scope:  純函式，無外部依賴（不碰 DOM / canvas）
 * Mocks:  無
 * SUT:    thin(mask, w, h)、trace(mask, w, h)、dissolvesAt(x, y, stage, stages)
 *
 * 目的：驗證 TS port 與 Kotlin/Rust 版相同的性質（對照 boox-spike ScriptTest）—
 * 細線化收斂、筆劃 8-鄰接連續且覆蓋骨架、環形無端點也追得出來、溶解單調完備。
 */

/**
 * 測試情境一覽：
 *
 * 1. 粗橫條細線化 → 像素數大幅縮減但骨架存活
 * 2. 細線化後追蹤 → 每點都在骨架上、相鄰點 8-鄰接、覆蓋大部分骨架
 * 3. 圓環（無端點）→ loop-start fallback 仍追出夠長的筆劃
 * 4. 溶解 → 每個像素一旦溶解就維持溶解，最後一階段全部溶完
 */
import { describe, expect, it } from "vitest";

import { dissolvesAt, thin, trace } from "../src/script";

/** A 5px-thick horizontal bar, like a very boring glyph. */
function bar(w = 60, h = 15): Uint8Array {
  const mask = new Uint8Array(w * h);
  for (let y = 5; y <= 9; y++) for (let x = 5; x <= 54; x++) mask[y * w + x] = 1;
  return mask;
}

function count(mask: Uint8Array): number {
  let n = 0;
  for (const v of mask) if (v) n++;
  return n;
}

describe("script (unit)", () => {
  it("thinning slims the bar but the skeleton survives", () => {
    // Given: 一條 5px 粗的橫條
    const [w, h] = [60, 15];
    const mask = bar(w, h);
    const before = count(mask);

    // When: 細線化
    thin(mask, w, h);

    // Then:
    // 斷言：像素數縮到原本 1/3 以下（真的有變細）
    const after = count(mask);
    expect(after * 3).toBeLessThan(before);
    // 斷言：骨架沒有被削到消失
    expect(after).toBeGreaterThanOrEqual(40);
  });

  it("trace produces continuous strokes covering the skeleton", () => {
    // Given: 細線化後的橫條骨架
    const [w, h] = [60, 15];
    const mask = bar(w, h);
    thin(mask, w, h);
    const skeleton = mask.slice();

    // When: 追蹤成筆劃
    const strokes = trace(mask, w, h);

    // Then:
    // 斷言：至少追出一條筆劃
    expect(strokes.length).toBeGreaterThan(0);

    let covered = 0;
    for (const s of strokes) {
      // 斷言：每個追蹤點都落在骨架像素上（筆不會畫到空白處）
      for (const p of s) expect(skeleton[p.y * w + p.x]).toBeTruthy();
      // 斷言：相鄰兩點是 8-鄰接（筆尖不跳格）
      for (let i = 1; i < s.length; i++) {
        const d = Math.max(Math.abs(s[i].x - s[i - 1].x), Math.abs(s[i].y - s[i - 1].y));
        expect(d).toBe(1);
      }
      covered += s.length;
    }
    // 斷言：筆劃覆蓋至少七成骨架（動畫不會漏寫大段字）
    expect(covered * 10).toBeGreaterThanOrEqual(count(skeleton) * 7);
  });

  it("trace handles loops (a ring has no endpoints)", () => {
    // Given: 一個圓環 — 沒有 degree-1 端點，走 loop-start fallback
    const [w, h] = [41, 41];
    const mask = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const d = Math.sqrt((x - 20) * (x - 20) + (y - 20) * (y - 20));
        if (d >= 9 && d <= 13) mask[y * w + x] = 1;
      }
    }
    thin(mask, w, h);

    // When: 追蹤
    const strokes = trace(mask, w, h);

    // Then:
    // 斷言：環有被追出來，而且路徑夠長（不是碎成小段丟掉）
    expect(strokes.length).toBeGreaterThan(0);
    expect(strokes.reduce((n, s) => n + s.length, 0)).toBeGreaterThanOrEqual(40);
  });

  it("dissolve is monotonic and completes by the last stage", () => {
    // Given: 10 階段溶解，掃一塊 40×40 的像素
    const stages = 10;

    for (let y = 0; y < 40; y++) {
      for (let x = 0; x < 40; x++) {
        // When: 依序走過每個 stage
        let dissolvedAt = -1;
        for (let s = 0; s < stages; s++) {
          const d = dissolvesAt(x, y, s, stages);
          if (d && dissolvedAt < 0) dissolvedAt = s;
          // Then:
          // 斷言：一旦溶解就維持溶解（墨水不會回來）
          if (dissolvedAt >= 0 && dissolvedAt <= s) expect(d).toBe(true);
        }
        // 斷言：最後一階段每個像素都溶完（頁面收得乾淨）
        expect(dissolvedAt).toBeGreaterThanOrEqual(0);
      }
    }
  });
});

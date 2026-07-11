/**
 * Unit test — reply-dsl.ts (StreamParser / mapToCanvas / densify)
 *
 * Scope:  純函式與 parser 狀態機，無 DOM、無 fetch
 * Mocks:  無
 * SUT:    StreamParser、mapToCanvas、densify
 *
 * 目的：ReplyDsl.kt → reply-dsl.ts 的 port-fidelity — 串流下逐 block 解析、
 * 對雜訊的容錯、安全上限，以及快照像素 → 頁面像素的幾何轉換與
 * Catmull-Rom 手繪平滑（對照 boox-spike ReplyDslTest）。
 */

/**
 * 測試情境一覽：
 *
 *  1. 完整回覆一次餵入 → TEXT 與 STROKE block 依序解析
 *  2. terminator 一到就發出該 block（串流手感的關鍵）
 *  3. 任意切碎餵入 → 結果與整包餵入相同
 *  4. block 外的模型碎念（prose、code fence）被忽略
 *  5. 漏寫 terminator：新 block header 隱式關閉前一個 block
 *  6. 串流中斷：finish() 沖出未終結的 block
 *  7. 壞掉的 P 行被跳過；不足兩點的 stroke 被丟棄
 *  8. parser 不夾限座標 — 原樣保留（夾限在 mapToCanvas，那裡才知道邊界）
 *  9. 上限：最多 MAX_STROKES 筆、MAX_POINTS 個點
 * 10. SEE block（模型的私人筆記，不落墨）照樣逐 block 解析
 * 11. SEE 漏終結符時被下一個 header 隱式關閉
 * 12. mapToCanvas：依快照→頁面比例縮放並夾在頁面邊界內
 * 13. densify：取樣間距 ≤ spacing、端點保留、直線輸入不彎曲
 * 14. densify：wobble 有界且同 seed 可重現
 * 15. densify：退化輸入（0 或 1 點）原樣返回
 * 16. densify：轉角處以平滑曲線通過 — 錨點保留、路徑偏離折線但有界
 */
import { describe, expect, it } from "vitest";

import {
  MAX_POINTS,
  MAX_STROKES,
  StreamParser,
  densify,
  mapToCanvas,
  type Block,
  type StrokeBlock,
  type TextBlock,
} from "../src/reply-dsl";
import type { Pt } from "../src/script";

const fullReply =
  "TEXT 20 10\n" +
  "Nice cat!\n" +
  "I drew it a friend.\n" +
  "END_TEXT\n" +
  "STROKE\n" +
  "P 50 50\n" +
  "P 60 55\n" +
  "P 70 50\n" +
  "END_STROKE\n" +
  "STROKE\n" +
  "P 10 90\n" +
  "P 20 80\n" +
  "END_STROKE\n" +
  "END\n";

function parseAll(text: string): Block[] {
  const p = new StreamParser();
  return [...p.feed(text), ...p.finish()];
}

describe("reply-dsl StreamParser (unit)", () => {
  it("emits TEXT and STROKE blocks from a complete reply", () => {
    // When: 整包回覆一次餵入
    const blocks = parseAll(fullReply);

    // Then: 三個 block 依出現順序解析
    expect(blocks).toHaveLength(3);

    // 斷言：TEXT block 帶座標，多行內容以 \n 保留
    expect(blocks[0]).toEqual({
      kind: "text",
      x: 20,
      y: 10,
      text: "Nice cat!\nI drew it a friend.",
    });

    // 斷言：兩筆 STROKE 各自帶齊 P 點
    const s1 = blocks[1] as StrokeBlock;
    expect(s1.points).toHaveLength(3);
    expect(s1.points[1]).toEqual({ x: 60, y: 55 });
    expect((blocks[2] as StrokeBlock).points).toHaveLength(2);
  });

  it("emits each block as soon as its terminator arrives", () => {
    const p = new StreamParser();

    // When/Then: TEXT 內容到齊但還沒 END_TEXT → 不發出
    expect(p.feed("TEXT 5 5\nhello\n")).toHaveLength(0);

    // When/Then: END_TEXT 一到 → 立刻發出 TEXT block（不等整包）
    const afterText = p.feed("END_TEXT\n");
    expect(afterText).toHaveLength(1);
    expect((afterText[0] as TextBlock).text).toBe("hello");

    // When/Then: STROKE 的點到齊但還沒 END_STROKE → 不發出
    expect(p.feed("STROKE\nP 1 2\nP 3 4\n")).toHaveLength(0);

    // When/Then: END_STROKE 一到 → 立刻發出 STROKE block
    const afterStroke = p.feed("END_STROKE\n");
    expect(afterStroke).toHaveLength(1);
    expect((afterStroke[0] as StrokeBlock).points).toHaveLength(2);
  });

  it("survives arbitrary fragmentation", () => {
    // Given: 同一包回覆，切成一個字元一個 fragment
    const p = new StreamParser();

    // When: 逐字元餵入
    const blocks: Block[] = [];
    for (const ch of fullReply) blocks.push(...p.feed(ch));
    blocks.push(...p.finish());

    // Then: 解析結果與整包餵入完全相同
    expect(blocks).toEqual(parseAll(fullReply));
  });

  it("ignores chatter outside blocks", () => {
    // Given: 模型不乖 — block 外夾了 prose 與 code fence
    const noisy =
      "Sure! Here is my reply:\n" +
      "```\n" +
      "TEXT 1 2\n" +
      "yo\n" +
      "END_TEXT\n" +
      "```\n" +
      "END\n";

    // When
    const blocks = parseAll(noisy);

    // Then: 只有合法的 TEXT block 活下來，碎念全數忽略
    expect(blocks).toHaveLength(1);
    expect((blocks[0] as TextBlock).text).toBe("yo");
  });

  it("closes a block missing its terminator at the next header", () => {
    // Given: 模型忘了 END_TEXT / END_STROKE，直接開下一個 block
    const sloppy = "TEXT 3 4\nhi\nSTROKE\nP 1 1\nP 2 2\nEND\n";

    // When
    const blocks = parseAll(sloppy);

    // Then: TEXT 被 STROKE header 隱式關閉，STROKE 被 END 隱式關閉
    expect(blocks).toHaveLength(2);
    expect((blocks[0] as TextBlock).text).toBe("hi");
    expect((blocks[1] as StrokeBlock).points).toHaveLength(2);
  });

  it("finish() flushes an unterminated block", () => {
    // Given: 串流在 stroke 中途斷掉（連最後的換行都沒有）
    const p = new StreamParser();
    expect(p.feed("STROKE\nP 5 5\nP 9 9")).toHaveLength(0);

    // When: 上游宣告串流結束
    const flushed = p.finish();

    // Then: 已累積兩點的 stroke 仍被沖出，不因斷線而遺失
    expect(flushed).toEqual([
      { kind: "stroke", points: [{ x: 5, y: 5 }, { x: 9, y: 9 }] },
    ]);
  });

  it("skips malformed points and drops tiny strokes", () => {
    // Given: 壞掉的 P 行（缺數字、非數字）與只剩一點的 stroke
    const bad = "STROKE\nP a b\nP 1\nP 1 1\nEND_STROKE\nEND\n";

    // When / Then: 有效點只剩一個 → 整筆丟棄（一點畫不成線）
    expect(parseAll(bad)).toHaveLength(0);
  });

  it("passes coordinates through unclamped", () => {
    // Given: 模型畫出界 — parser 不知道快照多大，夾限是 mapToCanvas 的事
    const out =
      "TEXT 900 -2\nedge\nEND_TEXT\n" +
      "STROKE\nP -5 1300\nP 50 50\nEND_STROKE\nEND\n";

    // When
    const blocks = parseAll(out);

    // Then: 座標原樣保留，交給知道邊界的下游夾限
    expect(blocks[0]).toMatchObject({ kind: "text", x: 900, y: -2 });
    expect((blocks[1] as StrokeBlock).points[0]).toEqual({ x: -5, y: 1300 });
  });

  it("enforces the stroke and point caps", () => {
    // Given: 遠超上限的回覆 — MAX_STROKES+5 筆、每筆 50 點
    let sb = "";
    for (let s = 0; s < MAX_STROKES + 5; s++) {
      sb += "STROKE\n";
      for (let i = 0; i < 50; i++) sb += `P ${i % 100} ${i % 100}\n`;
      sb += "END_STROKE\n";
    }
    sb += "END\n";

    // When
    const strokes = parseAll(sb).filter(
      (b): b is StrokeBlock => b.kind === "stroke",
    );

    // Then: 筆數不超過 MAX_STROKES
    expect(strokes.length).toBeLessThanOrEqual(MAX_STROKES);

    // 斷言：總點數不超過 MAX_POINTS（超過預算的點被丟棄）
    const total = strokes.reduce((n, s) => n + s.points.length, 0);
    expect(total).toBeLessThanOrEqual(MAX_POINTS);
  });

  it("emits SEE blocks alongside visible ones", () => {
    // Given: 回覆以 SEE（記憶用，不落墨）開頭，接著才是可見的 TEXT
    const reply =
      "SEE\n" +
      "A black cat sketch, top-left.\n" +
      "New words: hello there.\n" +
      "END_SEE\n" +
      "TEXT 5 5\nhi\nEND_TEXT\nEND\n";

    // When
    const blocks = parseAll(reply);

    // Then: SEE 與 TEXT 依序各成一個 block，SEE 的多行內容保留
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toEqual({
      kind: "see",
      text: "A black cat sketch, top-left.\nNew words: hello there.",
    });
    expect((blocks[1] as TextBlock).text).toBe("hi");
  });

  it("closes SEE missing its terminator at the next header", () => {
    // Given: 模型忘了 END_SEE，直接開 TEXT
    const sloppy = "SEE\nnotes about the page\nTEXT 1 2\nyo\nEND_TEXT\nEND\n";

    // When
    const blocks = parseAll(sloppy);

    // Then: SEE 被 TEXT header 隱式關閉，兩個 block 都活下來
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toEqual({ kind: "see", text: "notes about the page" });
    expect((blocks[1] as TextBlock).text).toBe("yo");
  });
});

describe("reply-dsl geometry (unit)", () => {
  it("mapToCanvas scales snapshot pixels to the page and clamps", () => {
    // Given: 模型看到 500×725 的快照，頁面實際是 1000×1450（2× 下取樣）
    const pts = [
      { x: 0, y: 0 },
      { x: 250, y: 362.5 },
      { x: 600, y: -10 }, // 出界的座標
    ];

    // When
    const mapped = mapToCanvas(pts, 500, 725, 1000, 1450);

    // Then: 快照像素依比例放大回頁面像素
    expect(mapped[0]).toEqual({ x: 0, y: 0 });
    expect(mapped[1]).toEqual({ x: 500, y: 725 });

    // 斷言：出界座標夾在頁面邊界內（最後一個合法像素）
    expect(mapped[2]).toEqual({ x: 999, y: 0 });
  });

  it("densify keeps spacing and endpoints without wobble", () => {
    // Given: 一條 100px 的水平線段
    const line: Pt[] = [{ x: 0, y: 0 }, { x: 100, y: 0 }];

    // When: 以 2px 間距重取樣、無 wobble
    const dense = densify(line, 2);

    // Then: 端點保留
    expect(dense[0].x).toBe(0);
    expect(dense[dense.length - 1].x).toBe(100);

    // 斷言：相鄰點距 ≤ spacing（+1 容納整數捨入），且無 wobble 時完全共線
    for (let i = 1; i < dense.length; i++) {
      const d = Math.hypot(dense[i].x - dense[i - 1].x, dense[i].y - dense[i - 1].y);
      expect(d).toBeLessThanOrEqual(3);
      expect(dense[i].y).toBe(0);
    }
  });

  it("densify wobble is bounded and deterministic", () => {
    // Given: 同一條線、同一個 seed，跑兩次
    const line: Pt[] = [{ x: 0, y: 0 }, { x: 200, y: 0 }];
    const a = densify(line, 2, 2, 7);
    const b = densify(line, 2, 2, 7);

    // Then: 同 seed 完全重現（動畫重播不會抖出不同的線）
    expect(a).toEqual(b);

    // 斷言：wobble 偏移有界 — 水平線的 y 偏移不超過 wobble+捨入
    for (const p of a) expect(Math.abs(p.y)).toBeLessThanOrEqual(3);

    // 斷言：端點不受 wobble 影響（筆畫要接得回原本的位置）
    expect(a[0].y).toBe(0);
    expect(a[a.length - 1].y).toBe(0);
  });

  it("densify returns degenerate input unchanged", () => {
    // When / Then: 0 點與 1 點輸入原樣返回，不當掉
    expect(densify([], 2)).toEqual([]);
    expect(densify([{ x: 3, y: 4 }], 2)).toEqual([{ x: 3, y: 4 }]);
  });

  it("densify smooths corners into curves through the anchors", () => {
    // Given: 一個直角 L 形 — 模型只給三個錨點
    const anchors: Pt[] = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }];

    // When: 無 wobble 重取樣（只看曲線本身）
    const dense = densify(anchors, 2);

    // 到 L 形折線（兩段線段）的最短距離
    const distToPolyline = (p: Pt): number => {
      const dSeg1 =
        p.x >= 0 && p.x <= 100 ? Math.abs(p.y) : Math.hypot(p.x - 100, p.y);
      const dSeg2 =
        p.y >= 0 && p.y <= 100 ? Math.abs(p.x - 100) : Math.hypot(p.x - 100, p.y - 100);
      return Math.min(dSeg1, dSeg2);
    };

    // Then: 三個錨點都被曲線通過（±1px 捨入）— 模型指哪裡就畫到哪裡
    for (const a of anchors) {
      const hit = dense.some((p) => Math.hypot(p.x - a.x, p.y - a.y) <= 1.5);
      expect(hit, `anchor (${a.x},${a.y}) missed`).toBe(true);
    }

    // 斷言：路徑在轉角附近確實彎了 — 有樣本離折線 > 2px（不再是死直的尺規線）
    const maxDev = Math.max(...dense.map(distToPolyline));
    expect(maxDev).toBeGreaterThan(2);

    // 斷言：彎曲有界 — centripetal 參數化不暴衝（不會畫出離譜的迴圈）
    expect(maxDev).toBeLessThan(30);

    // 斷言：取樣仍然夠密，餵得進逐點動畫
    for (let i = 1; i < dense.length; i++) {
      const d = Math.hypot(dense[i].x - dense[i - 1].x, dense[i].y - dense[i - 1].y);
      expect(d).toBeLessThanOrEqual(6);
    }
  });
});

/**
 * Unit test — oracle.ts（傳輸層的純函式部分）
 *
 * Scope:  純函式，無外部依賴（不碰 fetch / DOM）
 * Mocks:  無
 * SUT:    sseDeltaContent、messagesJson、turnPrompt、parseRegions、parseOracleEnv
 *
 * 目的：Oracle.kt → oracle.ts 的 port-fidelity — SSE delta 解析、session
 * 記憶的請求組裝（歷史純文字、只有當回合帶圖、超限剪裁）、區域偵測回覆
 * 的容錯解析（對照 boox-spike OracleTest / OracleRegionsTest），外加 env
 * 解析（Kotlin 版綁在 Android Context 上沒測，TS 版是純函式所以補上）。
 * 回覆文法本身的解析屬於 reply-dsl（見 reply-dsl.test.ts）。
 */

/**
 * 測試情境一覽：
 *
 * 1. SSE delta 內容抽取（含缺 content 的 delta）
 * 2. messages 組裝：system 開頭、歷史依序 user/assistant 成對、結尾當回合帶圖
 * 3. 歷史超過 MAX_TURNS 時只留最後 MAX_TURNS 輪
 * 4. 首輪 prompt 要求完整描述（SEE），後續輪要求記錄新增墨水；兩者都報快照框
 * 5. parseRegions：BOX 行解析、亂序角點正規化、雜訊行與 NONE 忽略
 * 6. parseOracleEnv 解析 K=V / export K=V / 引號 / 預設值；沒 key 回 null
 */
import { describe, expect, it } from "vitest";

import {
  MAX_TURNS,
  messagesJson,
  parseOracleEnv,
  parseRegions,
  sseDeltaContent,
  turnPrompt,
  type Exchange,
} from "../src/oracle";

describe("oracle transport helpers (unit)", () => {
  it("sseDeltaContent extracts the delta fragment", () => {
    // 斷言：從一筆 SSE data 物件取出 choices[0].delta.content
    const data = '{"choices":[{"delta":{"content":"Hi the"},"index":0}]}';
    expect(sseDeltaContent(data)).toBe("Hi the");
    // 斷言：delta 沒有 content 時回空（跳過但不視為壞行）
    expect(sseDeltaContent('{"choices":[{"delta":{},"index":0}]}') ?? "").toBe("");
  });

  it("messagesJson puts system, then history, then the current image turn", () => {
    // Given: 兩輪已完成的對話
    const history: Exchange[] = [
      { userText: "turn one prompt", assistantRaw: "SEE\na page\nEND_SEE\nEND" },
      { userText: "turn two prompt", assistantRaw: "TEXT 5 5\nhi\nEND_TEXT\nEND" },
    ];

    // When
    const msgs = messagesJson(history, "current prompt", "data:image/png;base64,AAAA");

    // Then: 順序是 system、歷史 user/assistant 成對、最後是當回合
    expect(msgs).toHaveLength(6);
    expect(msgs[0].role).toBe("system");
    expect(msgs[1]).toEqual({ role: "user", content: "turn one prompt" });
    expect(msgs[2]).toEqual({
      role: "assistant",
      content: "SEE\na page\nEND_SEE\nEND",
    });
    expect(msgs[4].role).toBe("assistant");

    // 斷言：歷史是純文字，只有當回合這則帶圖（避免 payload 隨回合線性膨脹）
    const current = msgs[5] as {
      role: string;
      content: Array<Record<string, unknown>>;
    };
    expect(current.role).toBe("user");
    expect(current.content[0]).toMatchObject({ text: "current prompt" });
    expect(current.content[1]).toMatchObject({
      image_url: { url: "data:image/png;base64,AAAA" },
    });
  });

  it("messagesJson trims history to the last MAX_TURNS", () => {
    // Given: 遠超上限的歷史（MAX_TURNS + 4 輪）
    const history: Exchange[] = Array.from({ length: MAX_TURNS + 4 }, (_, i) => ({
      userText: `prompt ${i + 1}`,
      assistantRaw: `reply ${i + 1}`,
    }));

    // When
    const msgs = messagesJson(history, "now", "data:,x");

    // Then: 只剩 system + MAX_TURNS 輪 + 當回合
    expect(msgs).toHaveLength(1 + 2 * MAX_TURNS + 1);

    // 斷言：留下的是「最後」MAX_TURNS 輪 — 最舊的那幾輪被剪掉
    expect(msgs[1]).toMatchObject({ content: "prompt 5" });
  });

  it("turnPrompt asks a full description only on the first turn", () => {
    // When
    const first = turnPrompt(true, 632, 725, 47);
    const later = turnPrompt(false, 632, 725, 47);

    // Then: 兩者都要求 SEE 開頭；首輪要求完整描述、後續只記新增
    expect(first).toContain("SEE");
    expect(later).toContain("SEE");
    expect(first).toContain("everything");
    expect(later).toContain("new");

    // 斷言：兩者都誠實報出快照的像素座標框與 TEXT 行高（模型畫圖與
    // 排字的依據）
    expect(first).toContain("632x725");
    expect(later).toContain("632x725");
    expect(first).toContain("47");
  });
});

describe("oracle parseRegions (unit)", () => {
  it("parses BOX lines and normalizes corners", () => {
    // Given: 兩個框，其中一個角點順序顛倒，夾雜雜訊行
    const raw = [
      "Sure, here are the boxes:",
      "BOX 40 50 200 90",
      "BOX 310 120 250 100",
      "END",
    ].join("\n");

    // When
    const boxes = parseRegions(raw);

    // Then: 兩個框都被解析；顛倒的角點被正規化成 左上/右下
    expect(boxes).toEqual([
      { x0: 40, y0: 50, x1: 200, y1: 90 },
      { x0: 250, y0: 100, x1: 310, y1: 120 },
    ]);
  });

  it("yields nothing for NONE and malformed lines", () => {
    // When / Then: NONE、缺數字、非 BOX 行 → 空清單
    expect(parseRegions("NONE")).toEqual([]);
    expect(parseRegions("BOX 1 2 3")).toEqual([]);
    expect(parseRegions("hello\nworld")).toEqual([]);
  });
});

describe("oracle env parsing (unit)", () => {
  it("parses env lines and applies defaults", () => {
    // Given: 混合 export、引號、註解的 env 內容，只給 key 和 model
    const cfg = parseOracleEnv(
      [
        "# my settings",
        'export RIDDLE_OPENAI_KEY="sk-test"',
        "RIDDLE_OPENAI_MODEL=gpt-4o",
        "",
      ].join("\n"),
    );

    // Then:
    // 斷言：export 前綴與引號被剝掉、沒給的欄位吃預設值
    expect(cfg).toMatchObject({
      key: "sk-test",
      base: "https://api.openai.com/v1",
      model: "gpt-4o",
      maxTokens: 2000,
      reasoning: null,
    });
  });

  it("returns null without a key", () => {
    // 斷言：沒有 RIDDLE_OPENAI_KEY 就視為未設定
    expect(parseOracleEnv("RIDDLE_OPENAI_MODEL=gpt-4o")).toBeNull();
    expect(parseOracleEnv("")).toBeNull();
  });
});

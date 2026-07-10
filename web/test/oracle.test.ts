/**
 * Unit test — oracle.ts (sentenceCut / clean / sseDeltaContent / parseOracleEnv)
 *
 * Scope:  純函式，無外部依賴（不碰 fetch / DOM）
 * Mocks:  無
 * SUT:    sentenceCut(text, from)、clean(s)、sseDeltaContent(data)、parseOracleEnv(text)
 *
 * 目的：oracle.rs → Oracle.kt → oracle.ts 的 port-fidelity — 句子切割、引號清理、
 * SSE delta 解析行為與上游一致（對照 boox-spike OracleTest），外加 env 解析
 * （Kotlin 版綁在 Android Context 上沒測，TS 版是純函式所以補上）。
 */

/**
 * 測試情境一覽：
 *
 * 1. sentenceCut 找到「最後一個完整句子」的結尾
 * 2. sentenceCut 要求標點後面接空白或結尾（3.14 不是句點）
 * 3. sentenceCut 有最短長度門檻（4 字元）
 * 4. sentenceCut 能從 offset 續切
 * 5. clean 剝掉包住整句的引號
 * 6. sseDeltaContent 取出 delta.content 片段
 * 7. parseOracleEnv 解析 K=V / export K=V / 引號 / 預設值；沒 key 回 null
 */
import { describe, expect, it } from "vitest";

import { clean, parseOracleEnv, sentenceCut, sseDeltaContent } from "../src/oracle";

describe("oracle (unit)", () => {
  it("sentenceCut finds the last complete sentence", () => {
    // Given: 兩個完整句子加一段未完的尾巴
    const t = "Hello there. How curious! And then";

    // Then:
    // 斷言：切在 "curious!"（後面有空白）之後，不是第一個句點
    expect(sentenceCut(t, 0)).toBe("Hello there. How curious!".length);
  });

  it("sentenceCut needs whitespace or end-of-text after punctuation", () => {
    // 斷言：小數點（3.14）不算句尾
    expect(sentenceCut("version 3.14 is", 0)).toBeNull();
    // 斷言：句點在字串結尾算句尾
    expect(sentenceCut("A riddle.", 0)).toBe(9);
  });

  it("sentenceCut respects the 4-char minimum", () => {
    // 斷言：只有 3 字元的句子不值得單獨送出
    expect(sentenceCut("Ah.", 0)).toBeNull();
    // 斷言：剛好 4 字元就切
    expect(sentenceCut("Ahh.", 0)).toBe(4);
  });

  it("sentenceCut resumes from an offset", () => {
    // Given: 三個完整句子
    const t = "One. Two. Three.";

    // Then:
    // 斷言：從 0 起算，最後一個完整句子涵蓋整段
    expect(sentenceCut(t, 0)).toBe(t.length);
    // 斷言：已全部送完之後（from = 結尾）沒有東西可切
    expect(sentenceCut(t, t.length)).toBeNull();
  });

  it("clean strips wrapping quotes", () => {
    // 斷言：頭尾空白與包住整句的引號被剝掉
    expect(clean('  "hello"  ')).toBe("hello");
    // 斷言：沒引號的原樣保留
    expect(clean("no quotes")).toBe("no quotes");
  });

  it("sseDeltaContent extracts the delta fragment", () => {
    // 斷言：從一筆 SSE data 物件取出 choices[0].delta.content
    const data = '{"choices":[{"delta":{"content":"Hi the"},"index":0}]}';
    expect(sseDeltaContent(data)).toBe("Hi the");
    // 斷言：delta 沒有 content 時回空（不當成片段送出）
    expect(sseDeltaContent('{"choices":[{"delta":{},"index":0}]}') ?? "").toBe("");
  });

  it("parseOracleEnv parses env lines and applies defaults", () => {
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

  it("parseOracleEnv returns null without a key", () => {
    // 斷言：沒有 RIDDLE_OPENAI_KEY 就視為未設定
    expect(parseOracleEnv("RIDDLE_OPENAI_MODEL=gpt-4o")).toBeNull();
    expect(parseOracleEnv("")).toBeNull();
  });
});

/**
 * Unit test — oracle.ts（對話層：session 記憶、prompt、config 解析）
 *
 * Scope:  Oracle（LlmProvider 以 stub 取代）+ 純函式，不碰 fetch / DOM
 * Mocks:  LlmProvider（手寫 stub：錄下請求、回放回覆）
 * SUT:    Oracle.ask、Oracle.askTextRegions、turnPrompt、parseRegions、
 *         parseOracleEnv
 *
 * 目的：Oracle.kt → oracle.ts 的 port-fidelity，抽出 provider 之後改驗
 * 「對話語意」這一層 — 請求組裝（system 選對、歷史純文字、超限剪裁、
 * 只有當回合帶圖）、串流回覆餵 DSL、session 記憶的累積與失敗時不記帳，
 * 外加 oracle.env 的 provider 分組解析。wire format 的正確性歸 llm-*
 * 測試；回覆文法本身歸 reply-dsl（見 reply-dsl.test.ts）。
 */

/**
 * 測試情境一覽：
 *
 * 1. ask：串流片段餵 DSL、blocks 送達、onDone、下一輪帶上這輪的問答
 * 2. ask：首輪 prompt 要求完整描述、次輪要求記錄新增墨水；都報快照框
 * 3. ask：歷史超過 MAX_TURNS 時請求只帶最後 MAX_TURNS 輪
 * 4. ask：解析不出任何 block → "empty reply"、這輪不進歷史
 * 5. ask：provider 丟錯 → onError("request failed: …")
 * 6. askTextRegions：complete 回覆走 parseRegions；失敗回空、不丟出
 * 7. parseRegions：BOX 行解析、亂序角點正規化、雜訊行與 NONE 忽略
 * 8. parseOracleEnv：openai 預設分組、anthropic 分組與預設值、
 *    RIDDLE_PROVIDER 開關、沒 key / 不認得的 provider 回 null
 */
import { describe, expect, it } from "vitest";

import type { ChatRequest, LlmProvider } from "../src/llm/provider";
import {
  MAX_TURNS,
  Oracle,
  REGION_PROMPT,
  SYSTEM_PROMPT,
  parseOracleEnv,
  parseRegions,
  turnPrompt,
  type OracleListener,
  type Snapshot,
} from "../src/oracle";
import type { Block } from "../src/reply-dsl";

/** 錄下每個請求、照設定回放回覆（或丟錯）的 provider 替身。 */
class StubProvider implements LlmProvider {
  streamRequests: ChatRequest[] = [];
  completeRequests: ChatRequest[] = [];
  reply = "SEE\nink on the page\nEND_SEE\nTEXT 5 5\nhi\nEND_TEXT\nEND";
  completeReply = "NONE";
  failWith: Error | null = null;

  async stream(req: ChatRequest, onText: (f: string) => void): Promise<void> {
    this.streamRequests.push(req);
    if (this.failWith) throw this.failWith;
    for (const line of this.reply.split("\n")) onText(`${line}\n`);
  }

  async complete(req: ChatRequest): Promise<string> {
    this.completeRequests.push(req);
    if (this.failWith) throw this.failWith;
    return this.completeReply;
  }
}

function recordingListener() {
  const seen = { blocks: [] as Block[], done: false, errors: [] as string[] };
  const listener: OracleListener = {
    onBlock: (b) => seen.blocks.push(b),
    onDone: () => {
      seen.done = true;
    },
    onError: (r) => seen.errors.push(r),
  };
  return { listener, seen };
}

const SNAP: Snapshot = {
  pngDataUrl: "data:image/png;base64,AAAA",
  width: 632,
  height: 725,
  textLineH: 47,
};

const CFG = { maxTokens: 2000, reasoning: "low" };

describe("Oracle.ask (unit, provider stubbed)", () => {
  it("streams blocks to the listener and remembers the turn", async () => {
    // Given
    const stub = new StubProvider();
    const oracle = new Oracle(stub, CFG);
    const { listener, seen } = recordingListener();

    // When: 連問兩輪
    await oracle.ask(SNAP, listener);
    await oracle.ask(SNAP, listener);

    // Then:
    // 斷言：blocks 送達、正常收尾、沒有錯誤
    expect(seen.blocks.length).toBeGreaterThan(0);
    expect(seen.done).toBe(true);
    expect(seen.errors).toEqual([]);

    // 斷言：請求帶對語意欄位 — persona system、當回合的快照、config 的
    // token 上限與 effort（wire format 歸 provider，這裡只看語意）
    expect(stub.streamRequests[0]).toMatchObject({
      system: SYSTEM_PROMPT,
      imageDataUrl: SNAP.pngDataUrl,
      maxTokens: 2000,
      effort: "low",
    });

    // 斷言：首輪不帶歷史；次輪帶上首輪的問句與剪過空白的原文回覆
    expect(stub.streamRequests[0].turns).toEqual([]);
    expect(stub.streamRequests[1].turns).toEqual([
      { userText: stub.streamRequests[0].userText, assistantRaw: stub.reply },
    ]);

    // 斷言：首輪 prompt 要求完整描述、次輪要求記錄新增墨水；都報快照框
    expect(stub.streamRequests[0].userText).toContain("everything");
    expect(stub.streamRequests[1].userText).toContain("new");
    for (const req of stub.streamRequests) expect(req.userText).toContain("632x725");
  });

  it("carries at most MAX_TURNS turns of history", async () => {
    // Given
    const stub = new StubProvider();
    const oracle = new Oracle(stub, CFG);
    const { listener } = recordingListener();

    // When: 問到超過上限
    for (let i = 0; i < MAX_TURNS + 3; i++) await oracle.ask(SNAP, listener);

    // Then: 最後一輪的請求只帶 MAX_TURNS 輪歷史
    const last = stub.streamRequests[stub.streamRequests.length - 1];
    expect(last.turns).toHaveLength(MAX_TURNS);
  });

  it("reports an empty reply and keeps it out of history", async () => {
    // Given: 回覆全是文法外的雜訊，解析不出任何 block
    const stub = new StubProvider();
    stub.reply = "I cannot draw today.\nSorry.";
    const oracle = new Oracle(stub, CFG);
    const { listener, seen } = recordingListener();

    // When: 問一輪失敗後，換正常回覆再問一輪
    await oracle.ask(SNAP, listener);
    stub.reply = "SEE\nok\nEND_SEE\nEND";
    await oracle.ask(SNAP, listener);

    // Then:
    // 斷言：雜訊輪回報 empty reply、不算完成
    expect(seen.errors).toEqual(["empty reply"]);

    // 斷言：失敗的一輪不進歷史 — 下一輪請求不帶任何 turns，而且仍視為
    // 首輪（要求完整描述）
    expect(stub.streamRequests[1].turns).toEqual([]);
    expect(stub.streamRequests[1].userText).toContain("everything");
  });

  it("surfaces provider failures through onError", async () => {
    // Given: provider 丟出傳輸層錯誤（HTTP、refusal、斷線都走這條）
    const stub = new StubProvider();
    stub.failWith = new Error("http 401: invalid x-api-key");
    const oracle = new Oracle(stub, CFG);
    const { listener, seen } = recordingListener();

    // When
    await oracle.ask(SNAP, listener);

    // Then
    expect(seen.errors).toEqual(["request failed: http 401: invalid x-api-key"]);
    expect(seen.done).toBe(false);
  });
});

describe("Oracle.askTextRegions (unit, provider stubbed)", () => {
  it("parses BOX lines from a one-shot completion", async () => {
    // Given
    const stub = new StubProvider();
    stub.completeReply = "BOX 40 50 200 90";
    const oracle = new Oracle(stub, CFG);

    // When
    const boxes = await oracle.askTextRegions(SNAP);

    // Then:
    // 斷言：走偵測器自己的 system、不帶對話歷史
    expect(stub.completeRequests[0]).toMatchObject({ system: REGION_PROMPT, turns: [] });
    expect(stub.completeRequests[0].userText).toContain("632x725");

    // 斷言：BOX 行被解析成快照像素框
    expect(boxes).toEqual([{ x0: 40, y0: 50, x1: 200, y1: 90 }]);
  });

  it("yields no boxes when the call fails", async () => {
    // Given: 偵測是 best-effort — 失敗就當這回合沒有可吃的字
    const stub = new StubProvider();
    stub.failWith = new Error("http 500: boom");
    const oracle = new Oracle(stub, CFG);

    // When / Then
    expect(await oracle.askTextRegions(SNAP)).toEqual([]);
  });
});

describe("oracle turnPrompt (unit)", () => {
  it("asks a full description only on the first turn", () => {
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
  it("parses the openai group by default and applies its defaults", () => {
    // Given: 沒寫 RIDDLE_PROVIDER 的既有格式（tablet 的舊檔照吃），
    // 混合 export、引號、註解，只給 key 和 model
    const cfg = parseOracleEnv(
      [
        "# my settings",
        'export RIDDLE_OPENAI_KEY="sk-test"',
        "RIDDLE_OPENAI_MODEL=gpt-4o",
        "",
      ].join("\n"),
    );

    // Then:
    // 斷言：export 前綴與引號被剝掉、沒給的欄位吃 openai 預設值
    expect(cfg).toMatchObject({
      provider: "openai",
      key: "sk-test",
      base: "https://api.openai.com/v1",
      model: "gpt-4o",
      maxTokens: 2000,
      reasoning: null,
    });
  });

  it("switches to the anthropic group and applies its defaults", () => {
    // Given: 選 anthropic、只給 key — 其餘吃該家的預設
    const cfg = parseOracleEnv(
      ["RIDDLE_PROVIDER=anthropic", "RIDDLE_ANTHROPIC_KEY=sk-ant-test"].join("\n"),
    );

    // Then:
    // 斷言：讀的是 RIDDLE_ANTHROPIC_* 分組；預設 model 是 Fable 5、
    // token 上限放寬到 8000（thinking 永遠開、會吃進 max_tokens）
    expect(cfg).toMatchObject({
      provider: "anthropic",
      key: "sk-ant-test",
      base: "https://api.anthropic.com/v1",
      model: "claude-fable-5",
      maxTokens: 8000,
      reasoning: null,
    });
  });

  it("reads only the selected provider's group", () => {
    // Given: 同一份檔放兩家設定（切 provider 只改一行的使用方式）
    const cfg = parseOracleEnv(
      [
        "RIDDLE_PROVIDER=anthropic",
        "RIDDLE_OPENAI_KEY=sk-openai",
        "RIDDLE_OPENAI_MODEL=gpt-5.5",
        "RIDDLE_ANTHROPIC_KEY=sk-ant",
        "RIDDLE_ANTHROPIC_MODEL=claude-fable-5",
        "RIDDLE_ANTHROPIC_REASONING=low",
      ].join("\n"),
    );

    // Then: 只有 anthropic 分組被讀進來
    expect(cfg).toMatchObject({
      provider: "anthropic",
      key: "sk-ant",
      model: "claude-fable-5",
      reasoning: "low",
    });
  });

  it.each([
    ["選中的分組沒 key", "RIDDLE_PROVIDER=anthropic\nRIDDLE_OPENAI_KEY=sk-openai"],
    ["預設分組沒 key", "RIDDLE_OPENAI_MODEL=gpt-4o"],
    ["不認得的 provider", "RIDDLE_PROVIDER=gemini\nRIDDLE_OPENAI_KEY=sk-test"],
    ["空字串", ""],
  ])("%s時視為未設定，回 null", (_name, text) => {
    expect(parseOracleEnv(text)).toBeNull();
  });
});

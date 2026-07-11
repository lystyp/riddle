/**
 * Unit test — llm/anthropic.ts（Anthropic Messages API provider）
 *
 * Scope:  純函式（anthropicBody、readStreamEvent）+ AnthropicProvider 的
 *         transport 邏輯（fetch 以 stub 取代，不碰網路）
 * Mocks:  global fetch（vi.stubGlobal）
 * SUT:    anthropicBody、readStreamEvent、AnthropicProvider.stream / .complete
 *
 * 目的：驗證跟 OpenAI 形狀不同的每一處都轉對 — system 提升為 top-level、
 * 快照剝掉 data-URI 前綴變 base64 block、SSE 是型別化事件（text_delta
 * 才是頁面文字、thinking 要略過）、Fable 5 帶 Opus 4.8 fallback、
 * refusal 浮上來當錯誤而不是無聲空白。
 */

/**
 * 測試情境一覽：
 *
 * 1. body 組裝：system top-level、歷史成對、當回合圖轉 base64 block、
 *    不帶 thinking 欄位（Fable 5 永遠開、送了會 400）
 * 2. body 組裝：effort 對應 output_config.effort；Fable/Mythos 才帶
 *    Opus 4.8 fallbacks，其他 model 不帶
 * 3. SSE 事件解讀：text_delta / thinking_delta / stop_reason /
 *    message_stop / error / 壞 JSON 各歸各位
 * 4. stream：文字片段依序送達、thinking 略過、headers 帶齊瀏覽器直連
 *    與 fallback beta
 * 5. stream / complete：stop_reason refusal → 丟錯
 * 6. complete：串起所有 text block
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AnthropicProvider,
  anthropicBody,
  readStreamEvent,
} from "../src/llm/anthropic";
import type { ChatRequest } from "../src/llm/provider";

function chatRequest(over: Partial<ChatRequest> = {}): ChatRequest {
  return {
    system: "sys prompt",
    turns: [],
    userText: "current prompt",
    imageDataUrl: "data:image/png;base64,AAAA",
    maxTokens: 8000,
    effort: null,
    ...over,
  };
}

/** 把每個 payload 包成一行 `data:` 的 SSE Response。 */
function sseResponse(...payloads: string[]): Response {
  return new Response(payloads.map((p) => `data: ${p}\n\n`).join(""), {
    status: 200,
  });
}

/** 記錄每次 fetch 的 URL / headers / body，依序回放準備好的 Response。 */
function stubFetch(...responses: Response[]) {
  const calls: {
    url: string;
    headers: Record<string, string>;
    body: Record<string, unknown>;
  }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({
        url: String(url),
        headers: init.headers as Record<string, string>,
        body: JSON.parse(String(init.body)),
      });
      return responses.shift() ?? new Response("no response queued", { status: 500 });
    }),
  );
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("anthropicBody (unit)", () => {
  it("hoists system, keeps history as text, converts the snapshot to a base64 block", () => {
    // Given: 一輪歷史 + 當回合帶 PNG data URL
    const req = chatRequest({
      turns: [{ userText: "turn one", assistantRaw: "SEE\nink\nEND_SEE\nEND" }],
    });

    // When
    const body = anthropicBody(req, "claude-fable-5", true);

    // Then:
    // 斷言：system 是 top-level 欄位，不在 messages 裡
    expect(body.system).toBe("sys prompt");

    // 斷言：歷史成對、當回合的圖剝掉 data-URI 前綴、media_type 對上
    expect(body.messages).toEqual([
      { role: "user", content: "turn one" },
      { role: "assistant", content: "SEE\nink\nEND_SEE\nEND" },
      {
        role: "user",
        content: [
          { type: "text", text: "current prompt" },
          {
            type: "image",
            source: { type: "base64", media_type: "image/png", data: "AAAA" },
          },
        ],
      },
    ]);

    // 斷言：不帶 thinking 欄位（Fable 5 永遠開、任何顯式設定都會 400）
    expect(body).not.toHaveProperty("thinking");
    expect(body).toMatchObject({ model: "claude-fable-5", stream: true, max_tokens: 8000 });
  });

  it("maps effort into output_config and gates fallbacks to Fable/Mythos", () => {
    // When: 同一個請求打在 Fable 與 Opus 兩種 model 上
    const fable = anthropicBody(chatRequest({ effort: "low" }), "claude-fable-5", false);
    const opus = anthropicBody(chatRequest(), "claude-opus-4-8", false);

    // Then:
    // 斷言：effort 走 output_config.effort；沒給就整個欄位不帶
    expect(fable.output_config).toEqual({ effort: "low" });
    expect(opus).not.toHaveProperty("output_config");

    // 斷言：只有 Fable/Mythos 帶 Opus 4.8 fallback（Opus 自己 fallback
    // 自己會被 API 打回票）
    expect(fable.fallbacks).toEqual([{ model: "claude-opus-4-8" }]);
    expect(opus).not.toHaveProperty("fallbacks");
  });

  it("rejects a snapshot that is not a base64 data URL", () => {
    // When / Then: 非 data URL 的圖直接丟錯（提早死在組裝，不送壞請求）
    expect(() =>
      anthropicBody(chatRequest({ imageDataUrl: "https://x/y.png" }), "claude-fable-5", false),
    ).toThrow("data URL");
  });
});

describe("anthropic readStreamEvent (unit)", () => {
  it.each([
    [
      "text_delta 取出文字",
      '{"type":"content_block_delta","delta":{"type":"text_delta","text":"SEE\\n"}}',
      { kind: "text", text: "SEE\n" },
    ],
    [
      "thinking_delta 不是頁面文字",
      '{"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"hmm"}}',
      null,
    ],
    [
      "message_delta 帶出 stop_reason",
      '{"type":"message_delta","delta":{"stop_reason":"refusal"}}',
      { kind: "stop", reason: "refusal" },
    ],
    ["message_stop 收尾", '{"type":"message_stop"}', { kind: "end" }],
    [
      "error 事件帶訊息",
      '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
      { kind: "error", message: "Overloaded" },
    ],
    ["壞 JSON 忽略", "not json", null],
    ["不相干事件忽略", '{"type":"content_block_start","content_block":{"type":"text"}}', null],
  ])("%s", (_name, data, expected) => {
    expect(readStreamEvent(data)).toEqual(expected);
  });
});

describe("AnthropicProvider (unit, fetch stubbed)", () => {
  const cfg = { key: "sk-ant-test", base: "https://api.anthropic.com/v1", model: "claude-fable-5" };

  it("streams text deltas in order, skipping thinking events", async () => {
    // Given: thinking 與文字交錯的事件流
    const calls = stubFetch(
      sseResponse(
        '{"type":"message_start","message":{}}',
        '{"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"..."}}',
        '{"type":"content_block_delta","delta":{"type":"text_delta","text":"SEE\\n"}}',
        '{"type":"content_block_delta","delta":{"type":"text_delta","text":"a page"}}',
        '{"type":"message_delta","delta":{"stop_reason":"end_turn"}}',
        '{"type":"message_stop"}',
      ),
    );
    const provider = new AnthropicProvider(cfg);
    const got: string[] = [];

    // When
    await provider.stream(chatRequest(), (f) => got.push(f));

    // Then:
    // 斷言：只有 text_delta 送達，順序不變
    expect(got).toEqual(["SEE\n", "a page"]);

    // 斷言：打在 {base}/messages，headers 帶 key / version / 瀏覽器直連
    // 確認 / fallback beta（這是要發出去的 wire 契約，整包 pin 住）
    expect(calls[0].url).toBe("https://api.anthropic.com/v1/messages");
    expect(calls[0].headers).toEqual({
      "Content-Type": "application/json",
      "x-api-key": "sk-ant-test",
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
      "anthropic-beta": "server-side-fallback-2026-06-01",
    });
  });

  it("throws when the stream ends with a refusal", async () => {
    // Given: 安全分類器整鏈拒絕（fallback 也沒接住）的事件流
    stubFetch(
      sseResponse(
        '{"type":"message_delta","delta":{"stop_reason":"refusal"}}',
        '{"type":"message_stop"}',
      ),
    );
    const provider = new AnthropicProvider(cfg);

    // When / Then: 浮上來當錯誤，不是無聲的空回覆
    await expect(provider.stream(chatRequest(), () => {})).rejects.toThrow("refused");
  });

  it("surfaces mid-stream error events", async () => {
    // Given: 串流中途吐 error 事件
    stubFetch(
      sseResponse('{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}'),
    );
    const provider = new AnthropicProvider(cfg);

    // When / Then
    await expect(provider.stream(chatRequest(), () => {})).rejects.toThrow("Overloaded");
  });

  it("complete joins the text blocks and throws on refusal", async () => {
    // Given: 先一發正常回覆，再一發 refusal
    stubFetch(
      new Response(
        JSON.stringify({
          content: [
            { type: "text", text: "BOX 1 2 3 4\n" },
            { type: "text", text: "NONE" },
          ],
          stop_reason: "end_turn",
        }),
        { status: 200 },
      ),
      new Response(JSON.stringify({ content: [], stop_reason: "refusal" }), { status: 200 }),
    );
    const provider = new AnthropicProvider(cfg);

    // When / Then: text block 串起來
    expect(await provider.complete(chatRequest())).toBe("BOX 1 2 3 4\nNONE");

    // When / Then: refusal 丟錯
    await expect(provider.complete(chatRequest())).rejects.toThrow("refused");
  });

  it("throws with status and detail on an HTTP error", async () => {
    // Given: 401（例如 key 打錯）
    stubFetch(new Response('{"error":{"message":"invalid x-api-key"}}', { status: 401 }));
    const provider = new AnthropicProvider(cfg);

    // When / Then
    await expect(provider.stream(chatRequest(), () => {})).rejects.toThrow("http 401");
  });
});

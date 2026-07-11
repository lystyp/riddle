/**
 * Unit test — llm/openai.ts（OpenAI 相容 provider）
 *
 * Scope:  純函式（messagesJson、sseDeltaContent）+ OpenAiProvider 的
 *         transport 邏輯（fetch 以 stub 取代，不碰網路）
 * Mocks:  global fetch（vi.stubGlobal）
 * SUT:    messagesJson、sseDeltaContent、OpenAiProvider.stream / .complete
 *
 * 目的：oracle.ts 抽出 provider 後的 port-fidelity — messages 組裝
 * （system 開頭、歷史純文字、當回合帶圖）、SSE delta 解析、以及
 * max_tokens → max_completion_tokens 的 400 retry 舞步都要跟抽出前
 * 一模一樣（e2e-smoke 的 mock server 仍走這條路）。
 */

/**
 * 測試情境一覽：
 *
 * 1. messages 組裝：system 開頭、歷史依序 user/assistant 成對、結尾當回合帶圖
 * 2. SSE delta 內容抽取（含缺 content 的 delta）
 * 3. stream：SSE 片段依序送達、[DONE] 收尾、effort 對應 reasoning_effort
 * 4. stream：400 要求 max_completion_tokens 時換欄位名重試
 * 5. stream：其他 400 直接丟錯，不重試
 * 6. complete：非串流回覆取 choices[0].message.content
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  OpenAiProvider,
  messagesJson,
  sseDeltaContent,
} from "../src/llm/openai";
import type { ChatRequest } from "../src/llm/provider";

function chatRequest(over: Partial<ChatRequest> = {}): ChatRequest {
  return {
    system: "sys prompt",
    turns: [],
    userText: "current prompt",
    imageDataUrl: "data:image/png;base64,AAAA",
    maxTokens: 2000,
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

/** 記錄每次 fetch 的 URL 與 body，依序回放準備好的 Response。 */
function stubFetch(...responses: Response[]) {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init.body)) });
      return responses.shift() ?? new Response("no response queued", { status: 500 });
    }),
  );
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("openai messagesJson (unit)", () => {
  it("puts system, then history, then the current image turn", () => {
    // Given: 兩輪已完成的對話
    const req = chatRequest({
      turns: [
        { userText: "turn one prompt", assistantRaw: "SEE\na page\nEND_SEE\nEND" },
        { userText: "turn two prompt", assistantRaw: "TEXT 5 5\nhi\nEND_TEXT\nEND" },
      ],
    });

    // When
    const msgs = messagesJson(req);

    // Then: 順序是 system、歷史 user/assistant 成對、最後是當回合
    expect(msgs).toHaveLength(6);
    expect(msgs[0]).toEqual({ role: "system", content: "sys prompt" });
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
});

describe("openai sseDeltaContent (unit)", () => {
  it("extracts the delta fragment", () => {
    // 斷言：從一筆 SSE data 物件取出 choices[0].delta.content
    const data = '{"choices":[{"delta":{"content":"Hi the"},"index":0}]}';
    expect(sseDeltaContent(data)).toBe("Hi the");
    // 斷言：delta 沒有 content 時回空（跳過但不視為壞行）
    expect(sseDeltaContent('{"choices":[{"delta":{},"index":0}]}') ?? "").toBe("");
  });
});

describe("OpenAiProvider (unit, fetch stubbed)", () => {
  const cfg = { key: "sk-test", base: "https://api.openai.com/v1", model: "gpt-5.5" };

  it("streams delta fragments in order and stops at [DONE]", async () => {
    // Given: 兩個 delta 片段後接 [DONE] 的 SSE 回覆
    const calls = stubFetch(
      sseResponse(
        '{"choices":[{"delta":{"content":"SEE\\n"},"index":0}]}',
        '{"choices":[{"delta":{"content":"a page"},"index":0}]}',
        "[DONE]",
        '{"choices":[{"delta":{"content":"after done — must not arrive"},"index":0}]}',
      ),
    );
    const provider = new OpenAiProvider(cfg);
    const got: string[] = [];

    // When
    await provider.stream(chatRequest({ effort: "low" }), (f) => got.push(f));

    // Then:
    // 斷言：片段依序送達、[DONE] 之後的資料不再送
    expect(got).toEqual(["SEE\n", "a page"]);

    // 斷言：請求打在 {base}/chat/completions、body 帶 model / stream /
    // max_tokens / messages，effort 走 reasoning_effort 欄位
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.openai.com/v1/chat/completions");
    expect(calls[0].body).toMatchObject({
      model: "gpt-5.5",
      stream: true,
      max_tokens: 2000,
      reasoning_effort: "low",
    });
  });

  it("retries with max_completion_tokens when a 400 demands it", async () => {
    // Given: 第一發 400 指名要 max_completion_tokens，第二發成功
    const calls = stubFetch(
      new Response('{"error":"use max_completion_tokens instead"}', { status: 400 }),
      sseResponse('{"choices":[{"delta":{"content":"ok"},"index":0}]}', "[DONE]"),
    );
    const provider = new OpenAiProvider(cfg);
    const got: string[] = [];

    // When
    await provider.stream(chatRequest(), (f) => got.push(f));

    // Then:
    // 斷言：重試那發把 token 上限換了欄位名，數值不變
    expect(calls).toHaveLength(2);
    expect(calls[0].body).toMatchObject({ max_tokens: 2000 });
    expect(calls[1].body).toMatchObject({ max_completion_tokens: 2000 });
    expect(calls[1].body).not.toHaveProperty("max_tokens");

    // 斷言：重試後的串流照常送達
    expect(got).toEqual(["ok"]);
  });

  it("throws on a 400 that is not about the cap field", async () => {
    // Given: 一般的 400（跟欄位名無關）
    stubFetch(new Response("model not found", { status: 400 }));
    const provider = new OpenAiProvider(cfg);

    // When / Then: 直接丟錯、不重試
    await expect(provider.stream(chatRequest(), () => {})).rejects.toThrow(
      "http 400",
    );
  });

  it("complete returns the whole message content", async () => {
    // Given: 非串流的 JSON 回覆
    stubFetch(
      new Response(
        JSON.stringify({ choices: [{ message: { content: "BOX 1 2 3 4" } }] }),
        { status: 200 },
      ),
    );
    const provider = new OpenAiProvider(cfg);

    // When
    const text = await provider.complete(chatRequest());

    // Then: 取 choices[0].message.content 全文
    expect(text).toBe("BOX 1 2 3 4");
  });
});

package com.riddle.booxspike

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Unit test — Oracle（傳輸層的純函式部分）
 *
 * Scope:  SSE data 行的 JSON 抽取，無網路、無 Android 依賴
 * Mocks:  無
 * SUT:    Oracle.sseDeltaContent
 *
 * 目的：驗證 chat-completions 串流片段的解析 — 回覆文法本身的解析
 *       屬於 ReplyDsl（見 ReplyDslTest）。
 */
class OracleTest {

    @Test
    fun sseDeltaContentExtractsFragment() {
        // Given: 一行標準的 delta 內容與一行沒有 content 的 delta
        val data = """{"choices":[{"delta":{"content":"Hi the"},"index":0}]}"""

        // When / Then: content 原樣取出；缺 content 時回空字串（跳過但不視為壞行）
        assertEquals("Hi the", Oracle.sseDeltaContent(data))
        assertEquals(
            "",
            Oracle.sseDeltaContent("""{"choices":[{"delta":{},"index":0}]}""").orEmpty()
        )
    }
}

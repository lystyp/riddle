package com.riddle.booxspike

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Unit test — Oracle（傳輸層的純函式部分）
 *
 * Scope:  SSE data 行的 JSON 抽取、多輪 messages 組裝，無網路、無 Android 依賴
 * Mocks:  無
 * SUT:    Oracle.sseDeltaContent / messagesJson / turnPrompt
 *
 * 目的：驗證串流片段解析與 session 記憶的請求組裝 — 歷史以純文字往返、
 *       只有當回合帶圖、超過上限的舊回合被剪掉。回覆文法本身的解析屬於
 *       ReplyDsl（見 ReplyDslTest）。
 */

/**
 * 測試情境一覽：
 *
 * 1. SSE delta 內容抽取（含缺 content 的 delta）
 * 2. messages 組裝：system 開頭、歷史依序 user/assistant 成對、結尾當回合帶圖
 * 3. 歷史超過 MAX_TURNS 時只留最後 MAX_TURNS 輪
 * 4. 首輪 prompt 要求完整描述（SEE），後續輪要求記錄新增墨水
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

    @Test
    fun messagesJsonPutsSystemThenHistoryThenCurrentImageTurn() {
        // Given: 兩輪已完成的對話
        val history = listOf(
            Oracle.Exchange("turn one prompt", "SEE\na page\nEND_SEE\nEND"),
            Oracle.Exchange("turn two prompt", "TEXT 5 5\nhi\nEND_TEXT\nEND"),
        )

        // When
        val msgs = Oracle.messagesJson(history, "current prompt", "AAAA")

        // Then: 順序是 system、歷史 user/assistant 成對、最後是當回合
        assertEquals(6, msgs.length())
        assertEquals("system", msgs.getJSONObject(0).getString("role"))
        assertEquals("user", msgs.getJSONObject(1).getString("role"))
        assertEquals("turn one prompt", msgs.getJSONObject(1).getString("content"))
        assertEquals("assistant", msgs.getJSONObject(2).getString("role"))
        assertEquals("SEE\na page\nEND_SEE\nEND", msgs.getJSONObject(2).getString("content"))
        assertEquals("assistant", msgs.getJSONObject(4).getString("role"))

        // 斷言：歷史是純文字，只有當回合這則帶圖（避免 payload 隨回合線性膨脹）
        val current = msgs.getJSONObject(5)
        assertEquals("user", current.getString("role"))
        val parts = current.getJSONArray("content")
        assertEquals("current prompt", parts.getJSONObject(0).getString("text"))
        assertEquals(
            "data:image/png;base64,AAAA",
            parts.getJSONObject(1).getJSONObject("image_url").getString("url"),
        )
    }

    @Test
    fun messagesJsonTrimsHistoryToLastMaxTurns() {
        // Given: 遠超上限的歷史（MAX_TURNS + 4 輪）
        val history = (1..Oracle.MAX_TURNS + 4).map {
            Oracle.Exchange("prompt $it", "reply $it")
        }

        // When
        val msgs = Oracle.messagesJson(history, "now", "AAAA")

        // Then: 只剩 system + MAX_TURNS 輪 + 當回合
        assertEquals(1 + 2 * Oracle.MAX_TURNS + 1, msgs.length())

        // 斷言：留下的是「最後」MAX_TURNS 輪 — 最舊的那幾輪被剪掉
        assertEquals("prompt 5", msgs.getJSONObject(1).getString("content"))
    }

    @Test
    fun turnPromptAsksFullDescriptionOnlyOnTheFirstTurn() {
        // When
        val first = Oracle.turnPrompt(firstTurn = true, imgW = 632, imgH = 725, textLineH = 47)
        val later = Oracle.turnPrompt(firstTurn = false, imgW = 632, imgH = 725, textLineH = 47)

        // Then: 兩者都要求 SEE 開頭；首輪要求完整描述、後續只記新增
        assertTrue(first.contains("SEE"))
        assertTrue(later.contains("SEE"))
        assertTrue(first.contains("everything"))
        assertTrue(later.contains("new"))

        // 斷言：兩者都誠實報出快照的像素座標框（模型畫圖的依據）；
        // drawing-only 模式下不再提 TEXT 行高
        assertTrue(first.contains("632x725"))
        assertTrue(later.contains("632x725"))
        assertTrue(!first.contains("TEXT line"))
    }
}

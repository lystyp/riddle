package com.riddle.booxspike

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.abs
import kotlin.math.hypot

/**
 * Unit test — ReplyDsl
 *
 * Scope:  純 JVM 函式與 parser 狀態機，無 Android 依賴
 * Mocks:  無
 * SUT:    ReplyDsl.StreamParser / mapToCanvas / densify
 *
 * 目的：驗證 oracle 回覆的 DSL 文法 — 串流下逐 block 解析、對雜訊的容錯、
 *       座標夾限與安全上限，以及 grid → 畫布座標的幾何轉換。
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
 *  8. 座標夾限在 0..100
 *  9. 上限：最多 MAX_STROKES 筆、MAX_POINTS 個點
 * 10. SEE block（模型的私人筆記，不落墨）照樣逐 block 解析
 * 11. SEE 漏終結符時被下一個 header 隱式關閉
 * 12. mapToCanvas：等比放大並夾在畫布邊界內
 * 13. densify：取樣間距 ≤ spacing、端點保留、無 wobble 時共線
 * 14. densify：wobble 有界且同 seed 可重現
 * 15. densify：退化輸入（0 或 1 點）原樣返回
 */
class ReplyDslTest {

    private val fullReply =
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
            "END\n"

    private fun parseAll(text: String): List<ReplyDsl.Block> {
        val p = ReplyDsl.StreamParser()
        return p.feed(text) + p.finish()
    }

    @Test
    fun parserEmitsTextAndStrokesFromACompleteReply() {
        // When: 整包回覆一次餵入
        val blocks = parseAll(fullReply)

        // Then: 三個 block 依出現順序解析
        assertEquals(3, blocks.size)

        // 斷言：TEXT block 帶座標，多行內容以 \n 保留
        val text = blocks[0] as ReplyDsl.Text
        assertEquals(20f, text.x, 1e-4f)
        assertEquals(10f, text.y, 1e-4f)
        assertEquals("Nice cat!\nI drew it a friend.", text.text)

        // 斷言：兩筆 STROKE 各自帶齊 P 點
        val s1 = blocks[1] as ReplyDsl.Stroke
        assertEquals(3, s1.points.size)
        assertEquals(ReplyDsl.GridPt(60f, 55f), s1.points[1])
        val s2 = blocks[2] as ReplyDsl.Stroke
        assertEquals(2, s2.points.size)
    }

    @Test
    fun parserEmitsEachBlockAsSoonAsItsTerminatorArrives() {
        val p = ReplyDsl.StreamParser()

        // When/Then: TEXT 內容到齊但還沒 END_TEXT → 不發出
        assertTrue(p.feed("TEXT 5 5\nhello\n").isEmpty())

        // When/Then: END_TEXT 一到 → 立刻發出 TEXT block（不等整包）
        val afterText = p.feed("END_TEXT\n")
        assertEquals(1, afterText.size)
        assertEquals("hello", (afterText[0] as ReplyDsl.Text).text)

        // When/Then: STROKE 的點到齊但還沒 END_STROKE → 不發出
        assertTrue(p.feed("STROKE\nP 1 2\nP 3 4\n").isEmpty())

        // When/Then: END_STROKE 一到 → 立刻發出 STROKE block
        val afterStroke = p.feed("END_STROKE\n")
        assertEquals(1, afterStroke.size)
        assertEquals(2, (afterStroke[0] as ReplyDsl.Stroke).points.size)
    }

    @Test
    fun parserSurvivesArbitraryFragmentation() {
        // Given: 同一包回覆，切成一個字元一個 fragment
        val p = ReplyDsl.StreamParser()

        // When: 逐字元餵入
        val blocks = ArrayList<ReplyDsl.Block>()
        for (ch in fullReply) blocks += p.feed(ch.toString())
        blocks += p.finish()

        // Then: 解析結果與整包餵入完全相同
        assertEquals(parseAll(fullReply), blocks)
    }

    @Test
    fun parserIgnoresChatterOutsideBlocks() {
        // Given: 模型不乖 — block 外夾了 prose 與 code fence
        val noisy =
            "Sure! Here is my reply:\n" +
                "```\n" +
                "TEXT 1 2\n" +
                "yo\n" +
                "END_TEXT\n" +
                "```\n" +
                "END\n"

        // When
        val blocks = parseAll(noisy)

        // Then: 只有合法的 TEXT block 活下來，碎念全數忽略
        assertEquals(1, blocks.size)
        assertEquals("yo", (blocks[0] as ReplyDsl.Text).text)
    }

    @Test
    fun missingTerminatorIsClosedByTheNextBlockHeader() {
        // Given: 模型忘了 END_TEXT / END_STROKE，直接開下一個 block
        val sloppy =
            "TEXT 3 4\n" +
                "hi\n" +
                "STROKE\n" +
                "P 1 1\n" +
                "P 2 2\n" +
                "END\n"

        // When
        val blocks = parseAll(sloppy)

        // Then: TEXT 被 STROKE header 隱式關閉，STROKE 被 END 隱式關閉
        assertEquals(2, blocks.size)
        assertEquals("hi", (blocks[0] as ReplyDsl.Text).text)
        assertEquals(2, (blocks[1] as ReplyDsl.Stroke).points.size)
    }

    @Test
    fun finishFlushesAnUnterminatedBlock() {
        // Given: 串流在 stroke 中途斷掉（連最後的換行都沒有）
        val p = ReplyDsl.StreamParser()
        assertTrue(p.feed("STROKE\nP 5 5\nP 9 9").isEmpty())

        // When: 上游宣告串流結束
        val flushed = p.finish()

        // Then: 已累積兩點的 stroke 仍被沖出，不因斷線而遺失
        assertEquals(1, flushed.size)
        assertEquals(
            listOf(ReplyDsl.GridPt(5f, 5f), ReplyDsl.GridPt(9f, 9f)),
            (flushed[0] as ReplyDsl.Stroke).points,
        )
    }

    @Test
    fun malformedPointsAreSkippedAndTinyStrokesDropped() {
        // Given: 壞掉的 P 行（缺數字、非數字）與只剩一點的 stroke
        val bad =
            "STROKE\n" +
                "P a b\n" +
                "P 1\n" +
                "P 1 1\n" +
                "END_STROKE\n" +
                "END\n"

        // When / Then: 有效點只剩一個 → 整筆丟棄（一點畫不成線）
        assertTrue(parseAll(bad).isEmpty())
    }

    @Test
    fun coordinatesAreClampedToTheGrid() {
        // Given: 模型畫出界
        val out =
            "TEXT 150 -2\n" +
                "edge\n" +
                "END_TEXT\n" +
                "STROKE\n" +
                "P -5 130\n" +
                "P 50 50\n" +
                "END_STROKE\n" +
                "END\n"

        // When
        val blocks = parseAll(out)

        // Then: 所有座標夾回 0..100
        val text = blocks[0] as ReplyDsl.Text
        assertEquals(100f, text.x, 1e-4f)
        assertEquals(0f, text.y, 1e-4f)
        assertEquals(ReplyDsl.GridPt(0f, 100f), (blocks[1] as ReplyDsl.Stroke).points[0])
    }

    @Test
    fun parserEnforcesStrokeAndPointCaps() {
        // Given: 遠超上限的回覆 — MAX_STROKES+5 筆、每筆 50 點
        val sb = StringBuilder()
        repeat(ReplyDsl.MAX_STROKES + 5) {
            sb.append("STROKE\n")
            repeat(50) { i -> sb.append("P ${i % 100} ${i % 100}\n") }
            sb.append("END_STROKE\n")
        }
        sb.append("END\n")

        // When
        val blocks = parseAll(sb.toString())
        val strokes = blocks.filterIsInstance<ReplyDsl.Stroke>()

        // Then: 筆數不超過 MAX_STROKES
        assertTrue("strokes=${strokes.size}", strokes.size <= ReplyDsl.MAX_STROKES)

        // 斷言：總點數不超過 MAX_POINTS（超過預算的點被丟棄）
        assertTrue(strokes.sumOf { it.points.size } <= ReplyDsl.MAX_POINTS)
    }

    @Test
    fun parserEmitsSeeBlocksAlongsideVisibleOnes() {
        // Given: 回覆以 SEE（記憶用，不落墨）開頭，接著才是可見的 TEXT
        val reply =
            "SEE\n" +
                "A black cat sketch, top-left.\n" +
                "New words: hello there.\n" +
                "END_SEE\n" +
                "TEXT 5 5\n" +
                "hi\n" +
                "END_TEXT\n" +
                "END\n"

        // When
        val blocks = parseAll(reply)

        // Then: SEE 與 TEXT 依序各成一個 block，SEE 的多行內容保留
        assertEquals(2, blocks.size)
        assertEquals(
            "A black cat sketch, top-left.\nNew words: hello there.",
            (blocks[0] as ReplyDsl.See).text,
        )
        assertEquals("hi", (blocks[1] as ReplyDsl.Text).text)
    }

    @Test
    fun seeWithoutTerminatorIsClosedByTheNextHeader() {
        // Given: 模型忘了 END_SEE，直接開 TEXT
        val sloppy =
            "SEE\n" +
                "notes about the page\n" +
                "TEXT 1 2\n" +
                "yo\n" +
                "END_TEXT\n" +
                "END\n"

        // When
        val blocks = parseAll(sloppy)

        // Then: SEE 被 TEXT header 隱式關閉，兩個 block 都活下來
        assertEquals(2, blocks.size)
        assertEquals("notes about the page", (blocks[0] as ReplyDsl.See).text)
        assertEquals("yo", (blocks[1] as ReplyDsl.Text).text)
    }

    @Test
    fun mapToCanvasScalesAndClampsToPageBounds() {
        // Given: 1000×2000 的畫布（直式，兩軸縮放不同）
        val pts = listOf(
            ReplyDsl.GridPt(0f, 0f),
            ReplyDsl.GridPt(50f, 25f),
            ReplyDsl.GridPt(100f, 100f),
        )

        // When
        val mapped = ReplyDsl.mapToCanvas(pts, 1000, 2000)

        // Then: 依各軸比例放大；grid 100 落在最後一個合法像素（w-1, h-1）
        assertEquals(0, mapped[0].x); assertEquals(0, mapped[0].y)
        assertEquals(500, mapped[1].x); assertEquals(500, mapped[1].y)
        assertEquals(999, mapped[2].x); assertEquals(1999, mapped[2].y)
    }

    @Test
    fun densifyKeepsSpacingAndEndpointsWithoutWobble() {
        // Given: 一條 100px 的水平線段
        val line = listOf(Script.Pt(0, 0), Script.Pt(100, 0))

        // When: 以 2px 間距重取樣、無 wobble
        val dense = ReplyDsl.densify(line, spacingPx = 2)

        // Then: 端點保留
        assertEquals(0, dense.first().x)
        assertEquals(100, dense.last().x)

        // 斷言：相鄰點距 ≤ spacing（+1 容納整數捨入），且無 wobble 時完全共線
        for (i in 1 until dense.size) {
            val d = hypot(
                (dense[i].x - dense[i - 1].x).toDouble(),
                (dense[i].y - dense[i - 1].y).toDouble(),
            )
            assertTrue("gap $d at $i", d <= 3.0)
            assertEquals(0, dense[i].y)
        }
    }

    @Test
    fun densifyWobbleIsBoundedAndDeterministic() {
        // Given: 同一條線、同一個 seed，跑兩次
        val line = listOf(Script.Pt(0, 0), Script.Pt(200, 0))
        val a = ReplyDsl.densify(line, spacingPx = 2, wobblePx = 2f, seed = 7)
        val b = ReplyDsl.densify(line, spacingPx = 2, wobblePx = 2f, seed = 7)

        // Then: 同 seed 完全重現（動畫重播不會抖出不同的線）
        assertEquals(a.size, b.size)
        for (i in a.indices) {
            assertEquals(a[i].x, b[i].x)
            assertEquals(a[i].y, b[i].y)
        }

        // 斷言：wobble 偏移有界 — 水平線的 y 偏移不超過 wobble+捨入
        for (p in a) assertTrue("wobble ${p.y}", abs(p.y) <= 3)

        // 斷言：端點不受 wobble 影響（筆畫要接得回原本的位置）
        assertEquals(0, a.first().y)
        assertEquals(0, a.last().y)
    }

    @Test
    fun densifyReturnsDegenerateInputUnchanged() {
        // When / Then: 0 點與 1 點輸入原樣返回，不當掉
        assertTrue(ReplyDsl.densify(emptyList(), 2).isEmpty())
        val single = ReplyDsl.densify(listOf(Script.Pt(3, 4)), 2)
        assertEquals(1, single.size)
        assertEquals(3, single[0].x)
    }
}

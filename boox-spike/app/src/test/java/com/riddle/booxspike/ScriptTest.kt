package com.riddle.booxspike

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.sqrt

/**
 * Verifies the Kotlin port of riddle/src/script.rs against the same
 * properties its Rust test asserts (thinning slims, tracing covers), plus
 * stroke continuity and dissolve coverage. Pure JVM — no Android runtime.
 */
class ScriptTest {

    private fun bar(w: Int = 60, h: Int = 15): BooleanArray {
        // A 5px-thick horizontal bar, like a very boring glyph.
        val mask = BooleanArray(w * h)
        for (y in 5..9) for (x in 5..54) mask[y * w + x] = true
        return mask
    }

    @Test
    fun thinningSlimsTheBar() {
        val (w, h) = 60 to 15
        val mask = bar(w, h)
        val before = mask.count { it }
        Script.thin(mask, w, h)
        val after = mask.count { it }
        assertTrue("thinning should slim: $before -> $after", after * 3 < before)
        assertTrue("skeleton should survive", after >= 40)
    }

    @Test
    fun traceProducesContinuousStrokesCoveringTheSkeleton() {
        val (w, h) = 60 to 15
        val mask = bar(w, h)
        Script.thin(mask, w, h)
        val skeleton = mask.copyOf()
        val strokes = Script.trace(mask, w, h)
        assertTrue("expected strokes", strokes.isNotEmpty())

        var covered = 0
        for (s in strokes) {
            for (p in s) {
                assertTrue("traced point must be a skeleton pixel", skeleton[p.y * w + p.x])
            }
            // Consecutive points are 8-neighbors: the pen never jumps.
            for (i in 1 until s.size) {
                val d = max(abs(s[i].x - s[i - 1].x), abs(s[i].y - s[i - 1].y))
                assertEquals("stroke must be continuous", 1, d)
            }
            covered += s.size
        }
        val skeletonCount = skeleton.count { it }
        assertTrue(
            "strokes should cover most of the skeleton ($covered of $skeletonCount)",
            covered * 10 >= skeletonCount * 7
        )
    }

    @Test
    fun traceHandlesLoops() {
        // A ring: no endpoints, exercises the loop-start fallback.
        val (w, h) = 41 to 41
        val mask = BooleanArray(w * h)
        for (y in 0 until h) for (x in 0 until w) {
            val d = sqrt(((x - 20) * (x - 20) + (y - 20) * (y - 20)).toDouble())
            if (d in 9.0..13.0) mask[y * w + x] = true
        }
        Script.thin(mask, w, h)
        val strokes = Script.trace(mask, w, h)
        assertTrue("ring should trace to at least one stroke", strokes.isNotEmpty())
        assertTrue("ring path should be long", strokes.sumOf { it.size } >= 40)
    }

    @Test
    fun dissolveIsMonotonicAndCompletes() {
        val stages = 10
        for (y in 0 until 40) {
            for (x in 0 until 40) {
                var dissolvedAt = -1
                for (s in 0 until stages) {
                    val d = Script.dissolvesAt(x, y, s, stages)
                    if (d && dissolvedAt < 0) dissolvedAt = s
                    if (dissolvedAt in 0..s) {
                        assertTrue("once dissolved, stays dissolved", d)
                    }
                }
                assertTrue("every pixel dissolves by the last stage", dissolvedAt >= 0)
            }
        }
    }
}

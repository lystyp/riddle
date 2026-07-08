package com.riddle.booxspike

/**
 * Tom Riddle's hand, ported line-for-line from riddle/src/script.rs (thin,
 * trace) and ink.rs (pxHash). Pure JVM — no Android types — so the port can
 * be verified with a plain unit test.
 *
 * Rasterization is NOT here: the Rust side rasterizes with ab_glyph, the
 * Android side rasterizes the same TTF with Canvas.drawText (see TomView).
 * Everything downstream of the boolean mask is this file, unchanged.
 */
object Script {

    class Pt(val x: Int, val y: Int)

    /** Zhang-Suen thinning: reduce the mask to 1px-wide skeleton lines. */
    fun thin(mask: BooleanArray, w: Int, h: Int) {
        fun idx(x: Int, y: Int) = y * w + x
        while (true) {
            var changed = false
            for (phase in 0..1) {
                val toClear = ArrayList<Int>()
                for (y in 1 until h - 1) {
                    for (x in 1 until w - 1) {
                        if (!mask[idx(x, y)]) continue
                        val p = booleanArrayOf(
                            mask[idx(x, y - 1)],     // p2 N
                            mask[idx(x + 1, y - 1)], // p3 NE
                            mask[idx(x + 1, y)],     // p4 E
                            mask[idx(x + 1, y + 1)], // p5 SE
                            mask[idx(x, y + 1)],     // p6 S
                            mask[idx(x - 1, y + 1)], // p7 SW
                            mask[idx(x - 1, y)],     // p8 W
                            mask[idx(x - 1, y - 1)], // p9 NW
                        )
                        val b = p.count { it }
                        if (b < 2 || b > 6) continue
                        var a = 0
                        for (i in 0 until 8) {
                            if (!p[i] && p[(i + 1) % 8]) a++
                        }
                        if (a != 1) continue
                        val c1: Boolean
                        val c2: Boolean
                        if (phase == 0) {
                            c1 = !(p[0] && p[2] && p[4])
                            c2 = !(p[2] && p[4] && p[6])
                        } else {
                            c1 = !(p[0] && p[2] && p[6])
                            c2 = !(p[0] && p[4] && p[6])
                        }
                        if (c1 && c2) toClear.add(idx(x, y))
                    }
                }
                if (toClear.isNotEmpty()) {
                    changed = true
                    for (i in toClear) mask[i] = false
                }
            }
            if (!changed) break
        }
    }

    /**
     * Trace the skeleton into polyline strokes, ordered left-to-right so the
     * animation writes like a hand.
     */
    fun trace(mask: BooleanArray, w: Int, h: Int): List<List<Pt>> {
        fun at(x: Int, y: Int): Boolean =
            x >= 0 && y >= 0 && x < w && y < h && mask[y * w + x]

        fun neighbors(x: Int, y: Int): List<Pt> {
            val out = ArrayList<Pt>(8)
            for (dy in -1..1) {
                for (dx in -1..1) {
                    if ((dx != 0 || dy != 0) && at(x + dx, y + dy)) out.add(Pt(x + dx, y + dy))
                }
            }
            return out
        }

        val visited = BooleanArray(w * h)

        // Endpoints first (degree 1), then any remaining pixels (loops).
        val starts = ArrayList<Pt>()
        for (y in 0 until h) {
            for (x in 0 until w) {
                if (at(x, y) && neighbors(x, y).size == 1) starts.add(Pt(x, y))
            }
        }
        for (y in 0 until h) {
            for (x in 0 until w) {
                if (at(x, y)) starts.add(Pt(x, y))
            }
        }

        val strokes = ArrayList<List<Pt>>()
        for (s in starts) {
            if (visited[s.y * w + s.x]) continue
            val path = ArrayList<Pt>()
            path.add(s)
            visited[s.y * w + s.x] = true
            var cx = s.x
            var cy = s.y
            while (true) {
                val next = neighbors(cx, cy).firstOrNull { !visited[it.y * w + it.x] } ?: break
                visited[next.y * w + next.x] = true
                path.add(next)
                cx = next.x
                cy = next.y
            }
            if (path.size >= 3) strokes.add(path)
        }
        strokes.sortBy { st -> st.minOf { it.x } }
        return strokes
    }

    /** Deterministic per-pixel hash for the dissolve pattern (u32 semantics). */
    fun pxHash(x: Int, y: Int): Int {
        var h = (x * 0x9E3779B1.toInt()) xor (y * 0x85EBCA6B.toInt())
        h = h xor (h ushr 13)
        h *= 0xC2B2AE35.toInt()
        return h xor (h ushr 16)
    }

    /** True if pixel (x, y) dissolves at `stage` of `stages` (ink.rs dissolve_pass). */
    fun dissolvesAt(x: Int, y: Int, stage: Int, stages: Int): Boolean =
        (pxHash(x, y).toLong() and 0xFFFFFFFFL) % stages <= stage
}

package com.riddle.booxspike

import kotlin.math.ceil
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt
import kotlin.math.sqrt

/**
 * The oracle's reply DSL — the plain-text grammar the model answers with,
 * and the geometry that turns it into pen strokes on the page.
 *
 * Coordinates are honest: every x y in a reply is a pixel position in the
 * exact PNG snapshot the model received that turn (origin top-left, y down;
 * the size rides along in each turn prompt). The frame it draws in is the
 * frame it looked at — no mental re-projection, which is where vision
 * models lose precision. A reply is a sequence of blocks:
 *
 *   SEE               the model's private notes — its memory of the page,
 *   ...lines...       never drawn; page words fade, so this is how past
 *   END_SEE           turns stay recoverable from the conversation history
 *   TEXT x y          what it says, placed at the block's top-left
 *   ...lines...
 *   END_TEXT
 *   STROKE            one pen stroke: sparse anchor points; a smooth curve
 *   P x y             is drawn through them (densify), so a handful of
 *   END_STROKE        corners and landmarks is enough
 *   END               last line of the reply
 *
 * StreamParser consumes SSE fragments and emits each block the moment its
 * terminator arrives, so the quill starts moving while the model is still
 * talking (the DSL cousin of oracle.rs sentence_cut). The parser never
 * clamps coordinates — it does not know the snapshot size; mapToCanvas
 * clamps while scaling snapshot pixels up to page pixels. Pure JVM — no
 * Android types — so grammar and geometry are covered by plain unit tests.
 */
object ReplyDsl {

    // Silent backstops — never quoted to the model (it draws freely); they
    // only stop a runaway reply from queueing minutes of animation.
    const val MAX_STROKES = 64
    const val MAX_POINTS = 2000

    /** A point in the snapshot's pixel space — what the model saw and meant. */
    data class ImgPt(val x: Float, val y: Float)

    sealed interface Block

    /** A spoken reply block: `text` written with its top-left at (x, y). */
    data class Text(val x: Float, val y: Float, val text: String) : Block

    /** One drawn stroke through anchor `points`, in the oracle's own ink. */
    data class Stroke(val points: List<ImgPt>) : Block

    /** The model's private notes about the page — memory, never drawn. */
    data class See(val text: String) : Block

    /**
     * Incremental line parser over the streamed reply. Feed it raw content
     * fragments as they arrive; it returns blocks as they complete. Unknown
     * lines outside blocks (model chatter, code fences) are dropped, and a
     * block header met inside another block closes that block first — models
     * forget terminators more often than they invent new grammar.
     */
    class StreamParser {

        private val buf = StringBuilder()
        private var done = false

        // Non-null exactly while inside the corresponding block.
        private var textPos: ImgPt? = null
        private val textLines = ArrayList<String>()
        private var strokePts: ArrayList<ImgPt>? = null
        private var seeLines: ArrayList<String>? = null

        private var strokesEmitted = 0
        private var pointBudget = MAX_POINTS

        fun feed(fragment: String): List<Block> {
            if (done) return emptyList()
            val out = ArrayList<Block>()
            buf.append(fragment)
            while (!done) {
                val nl = buf.indexOf("\n")
                if (nl < 0) break
                val line = buf.substring(0, nl)
                buf.delete(0, nl + 1)
                processLine(line, out)
            }
            return out
        }

        /** The stream is over: parse the last partial line, flush open blocks. */
        fun finish(): List<Block> {
            if (done) return emptyList()
            val out = ArrayList<Block>()
            if (buf.isNotEmpty()) {
                processLine(buf.toString(), out)
                buf.setLength(0)
            }
            endText(out)
            endStroke(out)
            endSee(out)
            done = true
            return out
        }

        private fun processLine(raw: String, out: ArrayList<Block>) {
            val t = raw.trim()
            if (textPos != null) {
                when {
                    t == "END_TEXT" -> { endText(out); return }
                    isBlockHeader(t) -> endText(out) // missing terminator
                    else -> { textLines.add(raw.trimEnd()); return }
                }
            }
            if (strokePts != null) {
                when {
                    t == "END_STROKE" -> { endStroke(out); return }
                    isBlockHeader(t) -> endStroke(out) // missing terminator
                    else -> { addPoint(t); return }
                }
            }
            seeLines?.let { lines ->
                when {
                    t == "END_SEE" -> { endSee(out); return }
                    isBlockHeader(t) -> endSee(out) // missing terminator
                    else -> { lines.add(raw.trimEnd()); return }
                }
            }
            when {
                t == "END" -> done = true
                t == "STROKE" -> strokePts = ArrayList()
                t == "SEE" -> seeLines = ArrayList()
                t.startsWith("TEXT") -> beginText(t)
                // Anything else at top level is model chatter — tolerated.
            }
        }

        private fun isBlockHeader(t: String): Boolean =
            t == "END" || t == "STROKE" || t == "SEE" || t.startsWith("TEXT ")

        private fun beginText(t: String) {
            val tok = t.split(WS)
            if (tok.size < 3) return // TEXT without a position cannot be placed
            val x = tok[1].toFloatOrNull() ?: return
            val y = tok[2].toFloatOrNull() ?: return
            textPos = ImgPt(x, y)
            textLines.clear()
        }

        private fun endText(out: ArrayList<Block>) {
            val pos = textPos ?: return
            textPos = null
            val text = textLines.joinToString("\n").trim()
            textLines.clear()
            if (text.isNotEmpty()) out.add(Text(pos.x, pos.y, text))
        }

        private fun addPoint(t: String) {
            val pts = strokePts ?: return
            val tok = t.split(WS)
            if (tok.size < 3 || tok[0] != "P") return
            val x = tok[1].toFloatOrNull() ?: return
            val y = tok[2].toFloatOrNull() ?: return
            if (pointBudget <= 0) return
            pointBudget--
            pts.add(ImgPt(x, y))
        }

        private fun endSee(out: ArrayList<Block>) {
            val lines = seeLines ?: return
            seeLines = null
            val text = lines.joinToString("\n").trim()
            if (text.isNotEmpty()) out.add(See(text))
        }

        private fun endStroke(out: ArrayList<Block>) {
            val pts = strokePts ?: return
            strokePts = null
            if (pts.size >= 2 && strokesEmitted < MAX_STROKES) {
                strokesEmitted++
                out.add(Stroke(pts))
            }
        }
    }

    private val WS = Regex("\\s+")

    /**
     * Snapshot pixels → page pixels. The snapshot is the page downscaled by
     * one integer factor, so this is a near-uniform upscale; out-of-frame
     * coordinates (the model drew off the edge) clamp to the page bounds.
     */
    fun mapToCanvas(
        points: List<ImgPt>,
        imgW: Int,
        imgH: Int,
        pageW: Int,
        pageH: Int,
    ): List<Script.Pt> {
        val sx = pageW.toFloat() / max(1, imgW)
        val sy = pageH.toFloat() / max(1, imgH)
        return points.map {
            Script.Pt(
                (it.x * sx).roundToInt().coerceIn(0, pageW - 1),
                (it.y * sy).roundToInt().coerceIn(0, pageH - 1),
            )
        }
    }

    /**
     * Turn sparse anchor points into a hand-paced dense path: a centripetal
     * Catmull-Rom spline through every anchor (interpolating, and the
     * centripetal knots are the standard no-cusp/no-overshoot choice),
     * resampled to ≤ spacingPx between points so it feeds the same
     * point-by-point quill animation as traced text. Without this a raw DSL
     * stroke is a few instant ruler lines. `wobblePx` adds a bounded
     * perpendicular random walk (deterministic per seed) for the last bit of
     * hand feel; anchors and endpoints stay put so strokes keep meeting
     * where the model intended.
     */
    fun densify(
        points: List<Script.Pt>,
        spacingPx: Int,
        wobblePx: Float = 0f,
        seed: Int = 1,
    ): List<Script.Pt> {
        if (points.size < 2) return points
        val spacing = max(1, spacingPx)
        val out = ArrayList<Script.Pt>()
        out.add(points.first())
        var rng = seed
        // LCG in [-1, 1] — java.util.Random-free so tests replay exactly.
        fun nextRand(): Float {
            rng = rng * 1664525 + 1013904223
            return ((rng ushr 16) % 2001 - 1000) / 1000f
        }
        var wob = 0f
        val n = points.size
        for (i in 1 until n) {
            // Segment p1→p2 with its neighbors as spline context; endpoints
            // duplicate their neighbor (knot() keeps the maths finite).
            val p0 = points[max(0, i - 2)]
            val p1 = points[i - 1]
            val p2 = points[i]
            val p3 = points[min(n - 1, i + 1)]
            val dx = (p2.x - p1.x).toFloat()
            val dy = (p2.y - p1.y).toFloat()
            val chord = sqrt(dx * dx + dy * dy)
            if (chord < 1e-3f) continue
            val steps = max(1, ceil(chord / spacing).toInt())
            val t0 = 0f
            val t1 = t0 + knot(p0, p1)
            val t2 = t1 + knot(p1, p2)
            val t3 = t2 + knot(p2, p3)
            // Wobble bends perpendicular to the chord — the spline supplies
            // the real curvature, this only roughens the line.
            val nx = -dy / chord
            val ny = dx / chord
            for (s in 1..steps) {
                val t = t1 + (t2 - t1) * s / steps
                val x: Float
                val y: Float
                if (s == steps) {
                    // Land exactly on the anchor, no float drift.
                    x = p2.x.toFloat()
                    y = p2.y.toFloat()
                } else {
                    // Barry–Goldman pyramid for the centripetal spline.
                    val a1x = lerp(p0.x.toFloat(), p1.x.toFloat(), t - t0, t1 - t0)
                    val a1y = lerp(p0.y.toFloat(), p1.y.toFloat(), t - t0, t1 - t0)
                    val a2x = lerp(p1.x.toFloat(), p2.x.toFloat(), t - t1, t2 - t1)
                    val a2y = lerp(p1.y.toFloat(), p2.y.toFloat(), t - t1, t2 - t1)
                    val a3x = lerp(p2.x.toFloat(), p3.x.toFloat(), t - t2, t3 - t2)
                    val a3y = lerp(p2.y.toFloat(), p3.y.toFloat(), t - t2, t3 - t2)
                    val b1x = lerp(a1x, a2x, t - t0, t2 - t0)
                    val b1y = lerp(a1y, a2y, t - t0, t2 - t0)
                    val b2x = lerp(a2x, a3x, t - t1, t3 - t1)
                    val b2y = lerp(a2y, a3y, t - t1, t3 - t1)
                    x = lerp(b1x, b2x, t - t1, t2 - t1)
                    y = lerp(b1y, b2y, t - t1, t2 - t1)
                }
                val last = i == n - 1 && s == steps
                wob = if (wobblePx > 0f && !last) {
                    (wob + nextRand() * 0.6f * wobblePx).coerceIn(-wobblePx, wobblePx)
                } else {
                    0f
                }
                out.add(
                    Script.Pt(
                        (x + nx * wob).roundToInt(),
                        (y + ny * wob).roundToInt(),
                    )
                )
            }
        }
        return out
    }

    /** Centripetal knot interval: √distance, floored so duplicated endpoint
     *  context never divides by zero. */
    private fun knot(a: Script.Pt, b: Script.Pt): Float {
        val dx = (b.x - a.x).toFloat()
        val dy = (b.y - a.y).toFloat()
        return max(sqrt(sqrt(dx * dx + dy * dy)), 1e-3f)
    }

    private fun lerp(a: Float, b: Float, num: Float, den: Float): Float =
        a + (b - a) * (num / den)
}

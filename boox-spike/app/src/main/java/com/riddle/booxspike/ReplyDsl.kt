package com.riddle.booxspike

import kotlin.math.ceil
import kotlin.math.max
import kotlin.math.roundToInt
import kotlin.math.sqrt

/**
 * The oracle's reply DSL — the plain-text grammar the model answers with,
 * and the geometry that turns it into pen strokes on the page.
 *
 * The model never sees device pixels: it reads and draws on a 100×100 grid
 * stretched over the whole page (origin top-left, y down), so its replies
 * stay short no matter how large the panel is. A reply is a sequence of
 * blocks:
 *
 *   SEE               the model's private notes — its memory of the page,
 *   ...lines...       never drawn; page words fade, so this is how past
 *   END_SEE           turns stay recoverable from the conversation history
 *   TEXT x y          what it says, placed at the block's top-left
 *   ...lines...
 *   END_TEXT
 *   STROKE            one pen stroke as a grid polyline
 *   P x y
 *   END_STROKE
 *   END               last line of the reply
 *
 * StreamParser consumes SSE fragments and emits each block the moment its
 * terminator arrives, so the quill starts moving while the model is still
 * talking (the DSL cousin of oracle.rs sentence_cut). Pure JVM — no Android
 * types — so grammar and geometry are covered by plain unit tests.
 */
object ReplyDsl {

    /** Both axes of the model's coordinate space run 0..GRID over the page. */
    const val GRID = 100f

    // Safety caps quoted to the model in Oracle's system prompt and enforced
    // here, so a runaway reply cannot queue minutes of animation.
    const val MAX_STROKES = 20
    const val MAX_POINTS = 600

    data class GridPt(val x: Float, val y: Float)

    sealed interface Block

    /** A spoken reply block: `text` written with its top-left at grid (x, y). */
    data class Text(val x: Float, val y: Float, val text: String) : Block

    /** One drawn stroke through `points`, in the oracle's own ink. */
    data class Stroke(val points: List<GridPt>) : Block

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
        private var textPos: GridPt? = null
        private val textLines = ArrayList<String>()
        private var strokePts: ArrayList<GridPt>? = null
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
            textPos = GridPt(clamp(x), clamp(y))
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
            pts.add(GridPt(clamp(x), clamp(y)))
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

        private fun clamp(v: Float) = v.coerceIn(0f, GRID)
    }

    private val WS = Regex("\\s+")

    /** Grid → page pixels, each axis scaled to its own span (the grid is
     *  square, the page usually is not), clamped inside the bitmap. */
    fun mapToCanvas(points: List<GridPt>, width: Int, height: Int): List<Script.Pt> =
        points.map {
            Script.Pt(
                (it.x / GRID * width).roundToInt().coerceIn(0, width - 1),
                (it.y / GRID * height).roundToInt().coerceIn(0, height - 1),
            )
        }

    /**
     * Resample a sparse polyline to ≤ spacingPx between points so it feeds
     * the same point-by-point quill animation as traced text — a raw DSL
     * stroke has only a handful of corners and would otherwise appear as a
     * few instant ruler lines. `wobblePx` adds a bounded perpendicular
     * random walk (deterministic per seed) so long segments read as a hand,
     * not a straightedge; both endpoints stay put so strokes keep meeting
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
        for (i in 1 until points.size) {
            val a = points[i - 1]
            val b = points[i]
            val dx = (b.x - a.x).toFloat()
            val dy = (b.y - a.y).toFloat()
            val len = sqrt(dx * dx + dy * dy)
            if (len < 1e-3f) continue
            val steps = max(1, ceil(len / spacing).toInt())
            val nx = -dy / len
            val ny = dx / len
            for (s in 1..steps) {
                val t = s.toFloat() / steps
                val last = i == points.size - 1 && s == steps
                wob = if (wobblePx > 0f && !last) {
                    (wob + nextRand() * 0.6f * wobblePx).coerceIn(-wobblePx, wobblePx)
                } else {
                    0f
                }
                out.add(
                    Script.Pt(
                        (a.x + dx * t + nx * wob).roundToInt(),
                        (a.y + dy * t + ny * wob).roundToInt(),
                    )
                )
            }
        }
        return out
    }
}

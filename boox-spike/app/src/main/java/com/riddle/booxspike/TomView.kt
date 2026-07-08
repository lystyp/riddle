package com.riddle.booxspike

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Rect
import android.graphics.Typeface
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.view.MotionEvent
import android.view.View
import java.nio.ByteBuffer
import kotlin.math.ceil
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/**
 * The page. Mirrors riddle's Replying → Lingering → FadingReply states with
 * the same constants (main.rs): 14ms tick / 26 points per tick, nib radius 2,
 * REPLY_PX 96, line height ×1.25, ±3px per-line wobble (same LCG), linger
 * 4s + 2ms·points (cap 20s, tap to skip), dissolve 10 stages × 80ms, full
 * GC refresh at the end. All lengths scale by (view width / 1620) so
 * proportions match the Paper Pro reference device.
 */
class TomView(context: Context) : View(context) {

    // ---- constants from riddle main.rs / ink.rs ----
    private val replyPxRef = 96f
    private val marginXRef = 120f
    private val lineHFactor = 1.25f
    private val nibRRef = 2f
    private val dissolveStages = 10
    private val dissolveTickMs = 80L

    /** Pace preset, settable from the UI. riddle's own pace is 14ms/26pts. */
    var tickMs = 14L
    var pointsPerTickRef = 26

    var refreshMode = RefreshMode.DU

    var onStatus: ((String) -> Unit)? = null

    /** Two-finger tap on the page — restore the hidden chrome. */
    var onChromeRestore: (() -> Unit)? = null

    /** Set when the RAW pen path is toggled on; paused while the page animates. */
    var rawPen: RawPen? = null

    /** The spirit in the diary; null until oracle.env is configured. */
    var oracle: Oracle? = null

    private val ui = Handler(Looper.getMainLooper())
    private var bmp: Bitmap? = null
    private var page: Canvas? = null
    // Tom's hand: Caveat (flowing but legible, Latin-only). Assets also carry
    // LXGWWenKaiTC (handwritten 楷體 with Traditional Chinese), DancingScript,
    // and PatrickHand — swap the filename here.
    private val face: Typeface = Typeface.createFromAsset(context.assets, "Caveat.ttf")
    private val inkPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.BLACK
        style = Paint.Style.STROKE
        strokeCap = Paint.Cap.ROUND
        strokeJoin = Paint.Join.ROUND
    }

    private val sc: Float get() = width / 1620f

    private enum class Phase { IDLE, DRINKING, THINKING, WRITING, LINGERING, DISSOLVING }

    private var phase = Phase.IDLE

    // ---- write plan (plan_reply / WritePlan) ----
    private val strokes = ArrayList<List<Script.Pt>>()
    private var strokeI = 0
    private var pointI = 0
    private var region: Rect? = null
    private var nextY = -1
    private var jitterSeed = 0x1234

    // ---- metrics ----
    private var writeStartMs = 0L
    private var ticks = 0
    private var lateTicks = 0
    private var dissolveStage = 0

    init {
        setBackgroundColor(Color.WHITE)
    }

    override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
        super.onSizeChanged(w, h, oldw, oldh)
        if (w <= 0 || h <= 0) return
        ui.removeCallbacksAndMessages(null)
        phase = Phase.IDLE
        resetPlan()
        bmp?.recycle()
        bmp = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888).also {
            it.eraseColor(Color.WHITE)
            page = Canvas(it)
        }
    }

    override fun onDraw(canvas: Canvas) {
        bmp?.let { canvas.drawBitmap(it, 0f, 0f, null) }
    }

    // ---- user ink (pen.rs → ink.rs pen_point, via MotionEvent) ----

    private var inking = false
    private var lastX = 0f
    private var lastY = 0f
    private var strokePts = 0
    private var pMin = 1f
    private var pMax = 0f
    private var strokeTool = "?"

    @SuppressLint("ClickableViewAccessibility")
    override fun onTouchEvent(event: MotionEvent): Boolean {
        when (event.actionMasked) {
            MotionEvent.ACTION_POINTER_DOWN -> {
                // A second finger landed: chrome-restore gesture, not ink.
                if (event.pointerCount >= 2) {
                    inking = false
                    onChromeRestore?.invoke()
                    return true
                }
            }
            MotionEvent.ACTION_DOWN -> {
                if (phase == Phase.LINGERING) {
                    ui.removeCallbacks(startDissolve)
                    ui.post(startDissolve)
                    return true
                }
                if (phase != Phase.IDLE) return true
                // RAW mode: TouchHelper owns the stylus; don't double-ink
                // anything that still reaches the view.
                if (rawPen?.engaged == true &&
                    event.getToolType(0) == MotionEvent.TOOL_TYPE_STYLUS
                ) return true
                ui.removeCallbacks(commitCheck)
                inking = true
                strokePts = 0
                pMin = 1f
                pMax = 0f
                strokeTool = when (event.getToolType(0)) {
                    MotionEvent.TOOL_TYPE_STYLUS -> "stylus"
                    MotionEvent.TOOL_TYPE_FINGER -> "finger"
                    else -> "tool${event.getToolType(0)}"
                }
                lastX = event.x
                lastY = event.y
                inkSegment(event.x, event.y, event.pressure, first = true)
                flushInk()
            }
            MotionEvent.ACTION_MOVE -> {
                if (!inking) return true
                // Drain the batched history: the pen samples at ~442Hz, far
                // above the frame-rate MotionEvent delivery. Draw every
                // sample, refresh once per batch (riddle's per-frame model).
                for (h in 0 until event.historySize) {
                    inkSegment(
                        event.getHistoricalX(h),
                        event.getHistoricalY(h),
                        event.getHistoricalPressure(h),
                        first = false,
                    )
                }
                inkSegment(event.x, event.y, event.pressure, first = false)
                flushInk()
            }
            MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                if (inking) {
                    inking = false
                    status(
                        "$strokeTool stroke: $strokePts pts, pressure %.2f–%.2f — mode=${refreshMode.label}"
                            .format(pMin, pMax)
                    )
                    scheduleCommit()
                }
            }
        }
        return true
    }

    private var inkDirtyL = Int.MAX_VALUE
    private var inkDirtyT = Int.MAX_VALUE
    private var inkDirtyR = Int.MIN_VALUE
    private var inkDirtyB = Int.MIN_VALUE

    /** One ink segment; nib radius follows pressure like riddle's brush. */
    private fun inkSegment(x: Float, y: Float, pressure: Float, first: Boolean) {
        val pg = page ?: return
        val p = pressure.coerceIn(0f, 1f)
        pMin = min(pMin, p)
        pMax = max(pMax, p)
        // riddle main.rs:345 — r = 2 + pressure*3/MAX: a full-bodied base
        // nib with a gentle 2x swell at full pressure. The proven hand-feel.
        val r = (2f + 3f * p) * sc
        inkPaint.strokeWidth = 2 * r + 1
        if (first) {
            pg.drawPoint(x, y, inkPaint)
        } else {
            pg.drawLine(lastX, lastY, x, y, inkPaint)
        }
        val margin = (r + 4 * sc).toInt()
        inkDirtyL = min(inkDirtyL, min(lastX, x).toInt() - margin)
        inkDirtyT = min(inkDirtyT, min(lastY, y).toInt() - margin)
        inkDirtyR = max(inkDirtyR, max(lastX, x).toInt() + margin)
        inkDirtyB = max(inkDirtyB, max(lastY, y).toInt() + margin)
        // inkSegment only ever draws the writer's ink — track it for commit.
        hasUserInk = true
        val u = userInkRegion ?: Rect(x.toInt(), y.toInt(), x.toInt(), y.toInt())
            .also { userInkRegion = it }
        u.union(x.toInt() - margin, y.toInt() - margin)
        u.union(x.toInt() + margin, y.toInt() + margin)
        lastX = x
        lastY = y
        strokePts++
    }

    // ---- hybrid raw-mode live rendering ----
    // Move-callback points stream in from the SDK thread; the UI thread
    // drains them every 33ms and inks pressure-width segments while the
    // hardware preview supplies the instant fixed-width feedback on top.

    private val liveQueue = java.util.concurrent.ConcurrentLinkedQueue<FloatArray>()
    private var liveFirst = true
    private var strokeWide: Rect? = null

    fun beginRawLiveStroke() {
        ui.removeCallbacks(commitCheck)
        liveQueue.clear()
        liveFirst = true
        strokeWide = null
        strokePts = 0
        pMin = 1f
        pMax = 0f
    }

    /**
     * Called from the SDK reader thread. Buffer ONLY — any drawing or EPD
     * call while the pen is down competes with the firmware's direct-draw
     * preview and visibly lags it. Everything is inked in one pass at
     * pen-up (finishRawLiveStroke).
     */
    fun queueRawLivePoint(x: Float, y: Float, pressure: Float) {
        if (phase != Phase.IDLE) return
        liveQueue.add(floatArrayOf(x, y, pressure))
    }

    private val liveDrain = Runnable {
        var item = liveQueue.poll() ?: return@Runnable
        while (true) {
            // TouchPoint pressure may arrive raw (0..4096) or normalized.
            val pr = if (item[2] > 1.5f) item[2] / 4096f else item[2]
            inkSegment(item[0], item[1], pr, liveFirst)
            liveFirst = false
            item = liveQueue.poll() ?: break
        }
        flushInk()
    }

    fun finishRawLiveStroke() {
        liveDrain.run()
        // The refresh suppression holds for as long as raw drawing is
        // enabled — the EinkDraw handoff: drop raw for a beat so the
        // hardware preview vanishes and the real pressure-width ink lands
        // in one refresh, then re-arm for the next stroke.
        val raw = rawPen
        if (raw?.engaged == true) raw.setPaused(true)
        strokeWide?.let { Epd.partial(this, it.left, it.top, it.right, it.bottom, refreshMode) }
        strokeWide = null
        if (raw?.engaged == true) ui.postDelayed({ raw.setPaused(false) }, 80)
        if (strokePts > 0) {
            status("raw hybrid stroke: $strokePts pts, pressure %.2f–%.2f".format(pMin, pMax))
            scheduleCommit()
        }
    }

    // ---- the oracle turn: idle commit → drink → think → streamed reply ----
    // Mirrors main.rs: IDLE_COMMIT 2.8s after pen-up, dissolve the writer's
    // ink while the request flies, buffer sentences until the page is clean,
    // then ink them with the existing write animation; the ticker hovers
    // while the stream is still open (rx.is_some()).

    private var userInkRegion: Rect? = null
    private var hasUserInk = false
    private var oracleActive = false
    private var turnWrote = false
    private val pendingSentences = ArrayDeque<String>()
    private var drinkStage = 0
    private var drinkRegion: Rect? = null

    private val commitCheck = Runnable {
        if (phase == Phase.IDLE && hasUserInk) commitPage()
    }

    private fun scheduleCommit() {
        ui.removeCallbacks(commitCheck)
        ui.postDelayed(commitCheck, 2800) // IDLE_COMMIT
    }

    private fun commitPage() {
        val o = oracle
        if (o == null) {
            status("oracle 未設定 — push oracle.env（見 README）; ink stays")
            return
        }
        val region = userInkRegion ?: return
        val png = capturePagePng(region) ?: return
        rawPen?.setPaused(true)
        oracleActive = true
        turnWrote = false
        pendingSentences.clear()
        phase = Phase.DRINKING
        drinkRegion = Rect(region)
        drinkStage = 0
        status("the diary drinks your ink…")
        ui.post(drinkTicker)
        o.ask(png, object : Oracle.Listener {
            override fun onInk(sentence: String) {
                post { onOracleInk(sentence) }
            }

            override fun onDone() {
                post { onOracleDone() }
            }

            override fun onError(reason: String) {
                post { onOracleError(reason) }
            }
        })
    }

    /** ink.rs to_png: crop to the ink bbox + 20px, downscale ≥2x to ≤800px. */
    private fun capturePagePng(region: Rect): ByteArray? {
        val b = bmp ?: return null
        val r = Rect(region)
        r.inset(-20, -20)
        if (!r.intersect(0, 0, width, height) || r.isEmpty) return null
        val f = max(2, (max(r.width(), r.height()) + 799) / 800)
        val crop = Bitmap.createBitmap(b, r.left, r.top, r.width(), r.height())
        val scaled = Bitmap.createScaledBitmap(
            crop, max(1, r.width() / f), max(1, r.height() / f), true
        )
        val out = java.io.ByteArrayOutputStream()
        scaled.compress(Bitmap.CompressFormat.PNG, 100, out)
        if (scaled !== crop) scaled.recycle()
        crop.recycle()
        return out.toByteArray()
    }

    private val drinkTicker = object : Runnable {
        override fun run() {
            if (phase != Phase.DRINKING) return
            val reg = drinkRegion ?: run { finishDrink(); return }
            dissolveRegionPass(reg, drinkStage)
            drinkStage++
            if (drinkStage >= dissolveStages) finishDrink() else ui.postDelayed(this, dissolveTickMs)
        }
    }

    private fun finishDrink() {
        drinkRegion = null
        userInkRegion = null
        hasUserInk = false
        phase = Phase.THINKING
        if (pendingSentences.isEmpty()) status("the diary is thinking…")
        while (pendingSentences.isNotEmpty()) {
            turnWrote = true
            write(pendingSentences.removeFirst())
        }
        if (!oracleActive && !turnWrote) {
            writeExcuse("empty reply")
        }
    }

    private fun onOracleInk(sentence: String) {
        if (!oracleActive) return
        if (phase == Phase.DRINKING) {
            pendingSentences.add(sentence)
        } else {
            turnWrote = true
            write(sentence)
        }
    }

    private fun onOracleDone() {
        oracleActive = false
        if (phase == Phase.THINKING && !turnWrote) writeExcuse("empty reply")
    }

    private fun onOracleError(reason: String) {
        android.util.Log.w("riddle-spike", "oracle error: $reason")
        oracleActive = false
        if (phase == Phase.DRINKING) {
            pendingSentences.add(excuseFor(reason))
            turnWrote = true // the excuse counts as the reply
        } else {
            writeExcuse(reason)
        }
    }

    private fun writeExcuse(reason: String) {
        turnWrote = true
        write(excuseFor(reason))
    }

    /** Simplified from main.rs oracle_excuse: stay in character, keep the clue. */
    private fun excuseFor(reason: String): String =
        "The ink blurs and will not settle… (${reason.take(80)})"

    /** One refresh per MotionEvent batch. */
    private fun flushInk() {
        if (inkDirtyR < inkDirtyL) return
        // Raw mode swallows these partials until pen-up: keep the whole-stroke
        // union so finishRawLiveStroke can refresh it in one shot.
        val w = strokeWide ?: Rect(inkDirtyL, inkDirtyT, inkDirtyR, inkDirtyB).also { strokeWide = it }
        w.union(inkDirtyL, inkDirtyT)
        w.union(inkDirtyR, inkDirtyB)
        Epd.partial(this, inkDirtyL, inkDirtyT, inkDirtyR, inkDirtyB, refreshMode)
        inkDirtyL = Int.MAX_VALUE
        inkDirtyT = Int.MAX_VALUE
        inkDirtyR = Int.MIN_VALUE
        inkDirtyB = Int.MIN_VALUE
    }

    /**
     * Ink `text` onto the page. Pressed while writing, it appends like a
     * streamed oracle chunk (append_reply); pressed while idle it continues
     * below the previous reply, clearing first when the page would overflow.
     */
    fun write(text: String) {
        val pg = page ?: return
        if (phase == Phase.LINGERING || phase == Phase.DISSOLVING) {
            ui.removeCallbacksAndMessages(null)
            resetPlan()
            pg.drawColor(Color.WHITE)
            Epd.fullRefresh(this)
            phase = Phase.IDLE
        }
        val lineH = (replyPxRef * sc * lineHFactor).toInt()
        if (nextY >= 0 && nextY + 2 * lineH > height) {
            resetPlan()
            pg.drawColor(Color.WHITE)
            Epd.fullRefresh(this)
        }
        planReply(text)
        if (phase != Phase.WRITING) {
            rawPen?.setPaused(true)
            phase = Phase.WRITING
            writeStartMs = SystemClock.uptimeMillis()
            ticks = 0
            lateTicks = 0
            ui.post(ticker)
        }
        status("writing… mode=${refreshMode.label} pace=${tickMs}ms×${budget()}")
    }

    fun clearPage() {
        ui.removeCallbacksAndMessages(null)
        phase = Phase.IDLE
        resetPlan()
        page?.drawColor(Color.WHITE)
        Epd.fullRefresh(this)
        rawPen?.setPaused(false)
        status("cleared — mode=${refreshMode.label} pace=${tickMs}ms×${budget()}")
    }

    // ---- plan_reply, same layout math ----

    private fun planReply(text: String) {
        val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            typeface = face
            textSize = replyPxRef * sc
        }
        val maxW = width - 2 * marginXRef * sc
        val lines = wrap(paint, text, maxW)
        val lineH = (replyPxRef * sc * lineHFactor).toInt()
        val totalH = lineH * lines.size
        var y = if (nextY >= 0) nextY else max((height - totalH) / 3, (60 * sc).toInt())
        for (lineText in lines) {
            val m = rasterize(paint, lineText)
            Script.thin(m.mask, m.w, m.h)
            val lineStrokes = Script.trace(m.mask, m.w, m.h)
            val x0 = (width - m.w) / 2
            val wobble = jitter()
            for (s in lineStrokes) {
                val mapped = s.map { Script.Pt(x0 + it.x, y + it.y + wobble) }
                for (p in mapped) growRegion(p.x, p.y, (5 * sc).roundToInt())
                strokes.add(mapped)
            }
            y += lineH
        }
        nextY = y
    }

    private fun jitter(): Int {
        jitterSeed = jitterSeed * 1664525 + 1013904223
        return (jitterSeed ushr 16) % 7 - 3
    }

    private class Mask(val mask: BooleanArray, val w: Int, val h: Int)

    /** Canvas.drawText replaces ab_glyph: same TTF, alpha > 127 becomes ink. */
    private fun rasterize(paint: Paint, text: String): Mask {
        val fm = paint.fontMetrics
        val w = max(1, ceil(paint.measureText(text)).toInt() + 4)
        val h = max(1, ceil(fm.descent - fm.ascent).toInt() + 4)
        val b = Bitmap.createBitmap(w, h, Bitmap.Config.ALPHA_8)
        Canvas(b).drawText(text, 0f, -fm.ascent, paint)
        val stride = b.rowBytes
        val buf = ByteBuffer.allocate(stride * h)
        b.copyPixelsToBuffer(buf)
        b.recycle()
        val arr = buf.array()
        val mask = BooleanArray(w * h)
        for (y in 0 until h) {
            for (x in 0 until w) {
                mask[y * w + x] = (arr[y * stride + x].toInt() and 0xFF) > 127
            }
        }
        return Mask(mask, w, h)
    }

    /**
     * Wrap to fit maxPx, character by character. Breaks at the last space for
     * spaced scripts (English word-wrap); for runs with no spaces (CJK) it
     * breaks at the character boundary — otherwise a Chinese reply is one
     * unbreakable "word" that overflows the page off both edges.
     */
    private fun wrap(paint: Paint, text: String, maxPx: Float): List<String> {
        val lines = ArrayList<String>()
        for (para in text.split('\n')) {
            val cur = StringBuilder()
            for (ch in para) {
                if (cur.isEmpty() && ch == ' ') continue // no leading space
                if (paint.measureText(cur.toString() + ch) <= maxPx || cur.isEmpty()) {
                    cur.append(ch)
                } else {
                    val lastSpace = cur.lastIndexOf(" ")
                    if (lastSpace > 0) {
                        lines.add(cur.substring(0, lastSpace))
                        val tail = cur.substring(lastSpace + 1)
                        cur.setLength(0)
                        cur.append(tail)
                    } else {
                        lines.add(cur.toString())
                        cur.setLength(0)
                    }
                    if (ch != ' ') cur.append(ch)
                }
            }
            if (cur.isNotEmpty()) lines.add(cur.toString())
        }
        return lines
    }

    // ---- Replying tick (main.rs State::Replying) ----

    private fun budget() = max(1, (pointsPerTickRef * sc).roundToInt())

    private val ticker = object : Runnable {
        override fun run() {
            if (phase != Phase.WRITING) return
            val pg = page ?: return
            val t0 = SystemClock.uptimeMillis()
            var budget = budget()
            val margin = max(4, (4 * sc).roundToInt())
            var dl = Int.MAX_VALUE
            var dt = Int.MAX_VALUE
            var dr = Int.MIN_VALUE
            var db = Int.MIN_VALUE
            fun dirty(x: Int, y: Int) {
                dl = min(dl, x - margin); dt = min(dt, y - margin)
                dr = max(dr, x + margin); db = max(db, y + margin)
            }
            val r = nibRRef * sc
            inkPaint.strokeWidth = 2 * r + 1
            while (budget > 0 && strokeI < strokes.size) {
                val st = strokes[strokeI]
                if (pointI >= st.size) {
                    strokeI++
                    pointI = 0
                    continue
                }
                val p = st[pointI]
                if (pointI > 0) {
                    val q = st[pointI - 1]
                    pg.drawLine(q.x.toFloat(), q.y.toFloat(), p.x.toFloat(), p.y.toFloat(), inkPaint)
                    dirty(q.x, q.y)
                } else {
                    pg.drawPoint(p.x.toFloat(), p.y.toFloat(), inkPaint)
                }
                dirty(p.x, p.y)
                pointI++
                budget--
            }
            if (dr >= dl) Epd.partial(this@TomView, dl, dt, dr, db, refreshMode)
            ticks++
            if (SystemClock.uptimeMillis() - t0 > tickMs) lateTicks++
            if (strokeI >= strokes.size) {
                if (oracleActive) {
                    // The stream is still open: the quill hovers, awaiting ink
                    // (main.rs: Replying with rx Some).
                    ui.postDelayed(this, tickMs)
                    return
                }
                phase = Phase.LINGERING
                val pts = strokes.sumOf { it.size }
                val elapsed = SystemClock.uptimeMillis() - writeStartMs
                val linger = min(4000L + 2L * pts, 20_000L)
                status(
                    "wrote $pts pts / ${strokes.size} strokes in ${elapsed}ms " +
                        "(${ticks} ticks, $lateTicks late) — fades in ${linger / 1000}s, tap page to skip"
                )
                ui.postDelayed(startDissolve, linger)
            } else {
                ui.postDelayed(this, tickMs)
            }
        }
    }

    // ---- FadingReply (main.rs) + dissolve_pass (ink.rs) ----

    private val startDissolve = Runnable {
        if (phase == Phase.LINGERING) {
            phase = Phase.DISSOLVING
            dissolveStage = 0
            ui.post(dissolveTicker)
        }
    }

    private val dissolveTicker = object : Runnable {
        override fun run() {
            if (phase != Phase.DISSOLVING) return
            val reg = region ?: run { finishFade(); return }
            dissolveRegionPass(reg, dissolveStage)
            dissolveStage++
            if (dissolveStage >= dissolveStages) finishFade() else ui.postDelayed(this, dissolveTickMs)
        }
    }

    /** One dissolve_pass (ink.rs): erase this stage's hashed pixels in `regIn`. */
    private fun dissolveRegionPass(regIn: Rect, stage: Int) {
        val b = bmp ?: return
        val r = Rect(regIn)
        if (!r.intersect(0, 0, width, height) || r.isEmpty) return
        val wpx = r.width()
        val hpx = r.height()
        val px = IntArray(wpx * hpx)
        b.getPixels(px, 0, wpx, r.left, r.top, wpx, hpx)
        for (yy in 0 until hpx) {
            for (xx in 0 until wpx) {
                val c = px[yy * wpx + xx]
                val luma = (Color.red(c) + Color.green(c) + Color.blue(c)) / 3
                if (luma < 250 && Script.dissolvesAt(r.left + xx, r.top + yy, stage, dissolveStages)) {
                    px[yy * wpx + xx] = Color.WHITE
                }
            }
        }
        b.setPixels(px, 0, wpx, r.left, r.top, wpx, hpx)
        Epd.partial(this, r.left, r.top, r.right, r.bottom, refreshMode)
    }

    private fun finishFade() {
        phase = Phase.IDLE
        resetPlan()
        page?.drawColor(Color.WHITE)
        Epd.fullRefresh(this)
        rawPen?.setPaused(false)
        status("page clean — mode=${refreshMode.label} pace=${tickMs}ms×${budget()}")
    }

    // ---- helpers ----

    private fun resetPlan() {
        strokes.clear()
        strokeI = 0
        pointI = 0
        region = null
        nextY = -1
        userInkRegion = null
        hasUserInk = false
    }

    private fun growRegion(x: Int, y: Int, margin: Int) {
        val r = region ?: Rect(x, y, x, y).also { region = it }
        r.union(x - margin, y - margin)
        r.union(x + margin, y + margin)
    }

    private fun status(s: String) {
        onStatus?.invoke(s)
    }
}

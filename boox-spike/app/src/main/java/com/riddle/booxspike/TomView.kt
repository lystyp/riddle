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
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/**
 * The page, as two stacked layers of ink:
 *
 * - PEN layer — the shared canvas. The user's drawings and the oracle's blue
 *   strokes accumulate here across turns; nothing on it ever fades.
 * - TEXT layer — the conversation. The user's written words live here until
 *   the page drinks them at commit; the oracle's spoken reply is written here
 *   and dissolves after the linger.
 *
 * The pen starts each turn on the PEN layer; a quick double-tap of the pen
 * toggles which layer new ink lands on. Everything else mirrors riddle's
 * Replying → Lingering → FadingReply states with the same constants
 * (main.rs): 14ms tick / 26 points per tick, nib radius 2, REPLY_PX 96, line
 * height ×1.25, ±3px per-line wobble (same LCG), linger 4s + 2ms·points
 * (cap 20s, tap to skip), dissolve 10 stages × 80ms, full GC refresh at the
 * end. All lengths scale by (view width / 1620) so proportions match the
 * Paper Pro reference device.
 */
class TomView(context: Context) : View(context) {

    // ---- constants from riddle main.rs / ink.rs ----
    private val replyPxRef = 96f
    private val marginXRef = 120f
    private val lineHFactor = 1.25f
    private val nibRRef = 2f
    private val dissolveStages = 10
    private val dissolveTickMs = 80L

    // ---- pen-tap gesture tuning ----
    private val tapMaxMs = 220L      // press longer than this and it's a dot, not a tap
    private val doubleTapMs = 350L   // max gap between tap-up and the second tap-up
    private val tapSlopPx: Float get() = 12f * sc
    private val doubleTapSlopPx: Float get() = 80f * sc

    /** Pace preset, settable from the UI. riddle's own pace is 14ms/26pts. */
    var tickMs = 14L
    var pointsPerTickRef = 26

    var refreshMode = RefreshMode.DU

    var onStatus: ((String) -> Unit)? = null

    /** Two-finger tap on the page — restore the hidden chrome. */
    var onChromeRestore: (() -> Unit)? = null

    /** Set when the RAW pen path is toggled on; paused while the page animates. */
    var rawPen: RawPen? = null

    /** The spirit on the page; null until oracle.env is configured. */
    var oracle: Oracle? = null

    private val ui = Handler(Looper.getMainLooper())

    enum class Layer { PEN, TEXT }

    private var penBmp: Bitmap? = null
    private var penPage: Canvas? = null
    private var textBmp: Bitmap? = null
    private var textPage: Canvas? = null
    private var activeLayer = Layer.PEN

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

    // The oracle's ink — a color the user's black never is, quoted to the
    // model in Oracle.SYSTEM_PROMPT so it can tell its own strokes apart.
    private val aiPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.rgb(30, 90, 200)
        style = Paint.Style.STROKE
        strokeCap = Paint.Cap.ROUND
        strokeJoin = Paint.Join.ROUND
    }

    private val sc: Float get() = width / 1620f

    private enum class Phase { IDLE, DRINKING, THINKING, WRITING, LINGERING, DISSOLVING }

    private var phase = Phase.IDLE

    // ---- write plan (plan_reply / WritePlan) ----
    private class Planned(val pts: List<Script.Pt>, val layer: Layer)

    private val strokes = ArrayList<Planned>()
    private var strokeI = 0
    private var pointI = 0
    private var fadeRegion: Rect? = null
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
        activeLayer = Layer.PEN
        penBmp?.recycle()
        penBmp = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888).also {
            it.eraseColor(Color.TRANSPARENT)
            penPage = Canvas(it)
        }
        textBmp?.recycle()
        textBmp = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888).also {
            it.eraseColor(Color.TRANSPARENT)
            textPage = Canvas(it)
        }
    }

    override fun onDraw(canvas: Canvas) {
        // White paper, the lasting pen layer, the fleeting text layer on top.
        penBmp?.let { canvas.drawBitmap(it, 0f, 0f, null) }
        textBmp?.let { canvas.drawBitmap(it, 0f, 0f, null) }
    }

    private fun pageFor(layer: Layer): Canvas? =
        if (layer == Layer.PEN) penPage else textPage

    // ---- user ink (pen.rs → ink.rs pen_point, via MotionEvent) ----

    private var inking = false
    private var lastX = 0f
    private var lastY = 0f
    private var strokePts = 0
    private var pMin = 1f
    private var pMax = 0f
    private var strokeTool = "?"

    // A fresh pen-down is held back as a tap candidate until it moves or
    // lingers: a quick tap must leave no ink (it may be half of a
    // layer-toggle double-tap), so the dot is only committed after
    // doubleTapMs passes with no second tap.
    private var tapCandidate = false
    private var downX = 0f
    private var downY = 0f
    private var downMs = 0L
    private val tapSamples = ArrayList<FloatArray>() // x, y, pressure
    private var pendingTap: FloatArray? = null
    private var pendingTapSamples: List<FloatArray> = emptyList()
    private var pendingTapUpMs = 0L
    private val pendingTapCommit = Runnable { commitPendingTap() }

    @SuppressLint("ClickableViewAccessibility")
    override fun onTouchEvent(event: MotionEvent): Boolean {
        when (event.actionMasked) {
            MotionEvent.ACTION_POINTER_DOWN -> {
                // A second finger landed: chrome-restore gesture, not ink.
                if (event.pointerCount >= 2) {
                    inking = false
                    tapCandidate = false
                    tapSamples.clear()
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
                ui.removeCallbacks(pendingTapCommit)
                inking = true
                strokePts = 0
                pMin = 1f
                pMax = 0f
                strokeTool = when (event.getToolType(0)) {
                    MotionEvent.TOOL_TYPE_STYLUS -> "stylus"
                    MotionEvent.TOOL_TYPE_FINGER -> "finger"
                    else -> "tool${event.getToolType(0)}"
                }
                downX = event.x
                downY = event.y
                downMs = SystemClock.uptimeMillis()
                tapCandidate = true
                tapSamples.clear()
                tapSamples.add(floatArrayOf(event.x, event.y, event.pressure))
            }
            MotionEvent.ACTION_MOVE -> {
                if (!inking) return true
                if (tapCandidate) {
                    for (h in 0 until event.historySize) {
                        tapSamples.add(
                            floatArrayOf(
                                event.getHistoricalX(h),
                                event.getHistoricalY(h),
                                event.getHistoricalPressure(h),
                            )
                        )
                    }
                    tapSamples.add(floatArrayOf(event.x, event.y, event.pressure))
                    if (hypot(event.x - downX, event.y - downY) > tapSlopPx ||
                        SystemClock.uptimeMillis() - downMs > tapMaxMs
                    ) {
                        spillTapAsStroke()
                    }
                    return true
                }
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
                    if (tapCandidate) {
                        tapCandidate = false
                        if (SystemClock.uptimeMillis() - downMs <= tapMaxMs) {
                            onPenTap(downX, downY)
                        } else {
                            // A long, motionless press: a deliberate dot.
                            replayAsInk(tapSamples)
                            tapSamples.clear()
                            scheduleCommit()
                        }
                        return true
                    }
                    status(
                        ("$strokeTool stroke: $strokePts pts, pressure %.2f–%.2f — " +
                            "層=${layerLabel()} mode=${refreshMode.label}")
                            .format(pMin, pMax)
                    )
                    scheduleCommit()
                }
            }
        }
        return true
    }

    /** The tap candidate moved or lingered — it is ordinary ink after all. */
    private fun spillTapAsStroke() {
        tapCandidate = false
        // If a lone dot was still waiting on the double-tap window, the
        // writer has moved on to real writing: that dot was real ink too.
        if (pendingTap != null) commitPendingTap()
        replayAsInk(tapSamples)
        tapSamples.clear()
    }

    /** Buffered pen samples become ink on the active layer, in one pass. */
    private fun replayAsInk(samples: List<FloatArray>) {
        var first = true
        for (s in samples) {
            if (first) {
                lastX = s[0]
                lastY = s[1]
            }
            inkSegment(s[0], s[1], s[2], first)
            first = false
        }
        flushInk()
    }

    private fun onPenTap(x: Float, y: Float) {
        val now = SystemClock.uptimeMillis()
        val prev = pendingTap
        if (prev != null && now - pendingTapUpMs <= doubleTapMs &&
            hypot(x - prev[0], y - prev[1]) <= doubleTapSlopPx
        ) {
            // Second tap in time and in place: toggle, both dots vanish.
            pendingTap = null
            pendingTapSamples = emptyList()
            toggleLayer()
            // The raw path's firmware preview may have left ghost dots.
            refreshAround(prev[0], prev[1])
            refreshAround(x, y)
            if (hasUserInk) scheduleCommit()
            return
        }
        // A lone tap far from the previous one: that previous dot was ink.
        if (prev != null) commitPendingTap()
        pendingTap = floatArrayOf(x, y)
        pendingTapSamples = ArrayList(tapSamples)
        pendingTapUpMs = now
        ui.postDelayed(pendingTapCommit, doubleTapMs)
    }

    /** No second tap arrived — the held-back dot becomes real ink. */
    private fun commitPendingTap() {
        if (pendingTap == null) return
        pendingTap = null
        ui.removeCallbacks(pendingTapCommit)
        replayAsInk(pendingTapSamples)
        pendingTapSamples = emptyList()
        scheduleCommit()
    }

    private fun toggleLayer() {
        activeLayer = if (activeLayer == Layer.PEN) Layer.TEXT else Layer.PEN
        status(
            if (activeLayer == Layer.TEXT) "圖層：文字 — 這層的字會被頁面喝掉"
            else "圖層：畫筆 — 這層的墨水留在紙上"
        )
    }

    private fun layerLabel() = if (activeLayer == Layer.PEN) "畫筆" else "文字"

    private fun refreshAround(x: Float, y: Float) {
        val r = (30 * sc).toInt()
        Epd.partial(this, x.toInt() - r, y.toInt() - r, x.toInt() + r, y.toInt() + r, refreshMode)
    }

    private var inkDirtyL = Int.MAX_VALUE
    private var inkDirtyT = Int.MAX_VALUE
    private var inkDirtyR = Int.MIN_VALUE
    private var inkDirtyB = Int.MIN_VALUE

    /** One ink segment; nib radius follows pressure like riddle's brush. */
    private fun inkSegment(x: Float, y: Float, pressure: Float, first: Boolean) {
        val pg = pageFor(activeLayer) ?: return
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
        // inkSegment only ever draws the writer's ink — track it for commit;
        // only the TEXT layer's share is drunk when the page commits.
        hasUserInk = true
        if (activeLayer == Layer.TEXT) {
            val u = userTextRegion ?: Rect(x.toInt(), y.toInt(), x.toInt(), y.toInt())
                .also { userTextRegion = it }
            u.union(x.toInt() - margin, y.toInt() - margin)
            u.union(x.toInt() + margin, y.toInt() + margin)
        }
        lastX = x
        lastY = y
        strokePts++
    }

    // ---- hybrid raw-mode live rendering ----
    // Move-callback points stream in from the SDK thread and are buffered
    // only; everything is inked in one pass at pen-up while the hardware
    // preview supplies the instant fixed-width feedback on top.

    private val liveQueue = java.util.concurrent.ConcurrentLinkedQueue<FloatArray>()
    private var strokeWide: Rect? = null
    private var rawBeginMs = 0L

    fun beginRawLiveStroke() {
        ui.removeCallbacks(commitCheck)
        ui.removeCallbacks(pendingTapCommit)
        liveQueue.clear()
        rawBeginMs = SystemClock.uptimeMillis()
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

    fun finishRawLiveStroke() {
        val samples = ArrayList<FloatArray>()
        while (true) samples.add(liveQueue.poll() ?: break)
        // TouchPoint pressure may arrive raw (0..4096) or normalized.
        for (s in samples) if (s[2] > 1.5f) s[2] = s[2] / 4096f
        if (samples.isEmpty()) return
        // The same tap-vs-ink split as the soft path, judged at pen-up
        // (raw points only surface here, so the decision cannot be earlier).
        val duration = SystemClock.uptimeMillis() - rawBeginMs
        val first = samples.first()
        val moved = samples.maxOf { hypot(it[0] - first[0], it[1] - first[1]) }
        if (duration <= tapMaxMs && moved <= tapSlopPx) {
            tapSamples.clear()
            tapSamples.addAll(samples)
            onPenTap(first[0], first[1])
            return
        }
        replayAsInk(samples)
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
            status("raw hybrid stroke: $strokePts pts, pressure %.2f–%.2f — 層=${layerLabel()}".format(pMin, pMax))
            scheduleCommit()
        }
    }

    // ---- the oracle turn: idle commit → drink → think → streamed reply ----
    // Mirrors main.rs: IDLE_COMMIT 2.8s after pen-up, dissolve the writer's
    // TEXT-layer ink while the request flies, buffer reply blocks until the
    // drink finishes, then ink them with the write animation; the ticker
    // hovers while the stream is still open (rx.is_some()).

    private var userTextRegion: Rect? = null
    private var hasUserInk = false
    private var oracleActive = false
    private var turnWrote = false
    private val pendingBlocks = ArrayDeque<ReplyDsl.Block>()
    private var pendingExcuse: String? = null
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
        val png = capturePagePng() ?: return
        rawPen?.setPaused(true)
        oracleActive = true
        turnWrote = false
        pendingBlocks.clear()
        pendingExcuse = null
        phase = Phase.DRINKING
        // Only the words are drunk; the PEN layer is the shared canvas.
        drinkRegion = userTextRegion?.let { Rect(it) }
        drinkStage = 0
        status("the page drinks your words…")
        ui.post(drinkTicker)
        o.ask(png, object : Oracle.Listener {
            override fun onBlock(block: ReplyDsl.Block) {
                post { onOracleBlock(block) }
            }

            override fun onDone() {
                post { onOracleDone() }
            }

            override fun onError(reason: String) {
                post { onOracleError(reason) }
            }
        })
    }

    /**
     * The whole page, both layers over white, downscaled to ≤800px on the
     * long side. Full-page (not cropped to the ink) because the model's
     * 100×100 reply grid spans the full page — a crop would shear the
     * mapping between what it sees and where it draws.
     */
    private fun capturePagePng(): ByteArray? {
        val pen = penBmp ?: return null
        val text = textBmp ?: return null
        if (width <= 0 || height <= 0) return null
        val f = max(2, (max(width, height) + 799) / 800)
        val w = max(1, width / f)
        val h = max(1, height / f)
        val snap = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
        val c = Canvas(snap)
        c.drawColor(Color.WHITE)
        val filter = Paint(Paint.FILTER_BITMAP_FLAG)
        val src = Rect(0, 0, width, height)
        val dst = Rect(0, 0, w, h)
        c.drawBitmap(pen, src, dst, filter)
        c.drawBitmap(text, src, dst, filter)
        val out = java.io.ByteArrayOutputStream()
        snap.compress(Bitmap.CompressFormat.PNG, 100, out)
        snap.recycle()
        return out.toByteArray()
    }

    private val drinkTicker = object : Runnable {
        override fun run() {
            if (phase != Phase.DRINKING) return
            val reg = drinkRegion ?: run { finishDrink(); return }
            dissolveRegionPass(textBmp, reg, drinkStage)
            drinkStage++
            if (drinkStage >= dissolveStages) finishDrink() else ui.postDelayed(this, dissolveTickMs)
        }
    }

    private fun finishDrink() {
        drinkRegion = null
        userTextRegion = null
        hasUserInk = false
        phase = Phase.THINKING
        if (pendingBlocks.isEmpty() && pendingExcuse == null) status("the page is thinking…")
        while (pendingBlocks.isNotEmpty()) {
            turnWrote = true
            ink(pendingBlocks.removeFirst())
        }
        pendingExcuse?.let {
            pendingExcuse = null
            turnWrote = true
            write(it)
        }
        if (!oracleActive && !turnWrote) {
            writeExcuse("empty reply")
        }
    }

    private fun onOracleBlock(block: ReplyDsl.Block) {
        if (!oracleActive) return
        if (phase == Phase.DRINKING) {
            pendingBlocks.add(block)
        } else {
            turnWrote = true
            ink(block)
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
            pendingExcuse = excuseFor(reason)
            turnWrote = true // the excuse counts as the reply
        } else {
            writeExcuse(reason)
        }
    }

    private fun writeExcuse(reason: String) {
        turnWrote = true
        write(excuseFor(reason))
    }

    /** Stay on the page, keep the clue. */
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

    // ---- planning the oracle's ink ----

    /** Plan one streamed reply block and make sure the quill is moving. */
    private fun ink(block: ReplyDsl.Block) {
        prepareForNewInk()
        when (block) {
            is ReplyDsl.Text -> planText(block)
            is ReplyDsl.Stroke -> planStroke(block)
        }
        startWriting()
    }

    /**
     * Ink `text` onto the page with no grid position (excuses, the Write
     * button): the legacy centered flow — below the previous reply, clearing
     * the text layer first when the page would overflow.
     */
    fun write(text: String) {
        prepareForNewInk()
        val lineH = (replyPxRef * sc * lineHFactor).toInt()
        if (nextY >= 0 && nextY + 2 * lineH > height) {
            resetPlan()
            clearTextLayer()
        }
        planReply(text)
        startWriting()
        status("writing… mode=${refreshMode.label} pace=${tickMs}ms×${budget()}")
    }

    /** A reply block arriving after the linger clears the stage first. */
    private fun prepareForNewInk() {
        if (phase == Phase.LINGERING || phase == Phase.DISSOLVING) {
            ui.removeCallbacksAndMessages(null)
            resetPlan()
            clearTextLayer()
            phase = Phase.IDLE
        }
    }

    private fun startWriting() {
        if (phase != Phase.WRITING) {
            rawPen?.setPaused(true)
            phase = Phase.WRITING
            writeStartMs = SystemClock.uptimeMillis()
            ticks = 0
            lateTicks = 0
            ui.post(ticker)
        }
    }

    private fun clearTextLayer() {
        textBmp?.eraseColor(Color.TRANSPARENT)
        Epd.fullRefresh(this)
    }

    fun clearPage() {
        ui.removeCallbacksAndMessages(null)
        phase = Phase.IDLE
        resetPlan()
        activeLayer = Layer.PEN
        penBmp?.eraseColor(Color.TRANSPARENT)
        textBmp?.eraseColor(Color.TRANSPARENT)
        Epd.fullRefresh(this)
        rawPen?.setPaused(false)
        status("cleared — mode=${refreshMode.label} pace=${tickMs}ms×${budget()}")
    }

    // ---- plan_reply, same layout math ----

    private fun replyPaint() = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        typeface = face
        textSize = replyPxRef * sc
    }

    /** Legacy flow layout: centered lines from nextY (excuses / Write button). */
    private fun planReply(text: String) {
        val paint = replyPaint()
        val maxW = width - 2 * marginXRef * sc
        val lines = wrap(paint, text, maxW)
        val lineH = (replyPxRef * sc * lineHFactor).toInt()
        val totalH = lineH * lines.size
        var y = if (nextY >= 0) nextY else max((height - totalH) / 3, (60 * sc).toInt())
        for (lineText in lines) {
            planTextLine(paint, lineText, null, y)
            y += lineH
        }
        nextY = y
    }

    /** A TEXT block: left-aligned at its grid position, wrapping to the margin. */
    private fun planText(block: ReplyDsl.Text) {
        val paint = replyPaint()
        val lineH = (replyPxRef * sc * lineHFactor).toInt()
        // Clamp so the block keeps at least a quarter page to wrap into and
        // never starts below the last full line.
        val x0 = (block.x / ReplyDsl.GRID * width)
            .coerceIn(0f, max(0f, width * 0.75f))
            .toInt()
        val maxW = width - x0 - marginXRef * sc
        val lines = wrap(paint, block.text, maxW)
        var y = (block.y / ReplyDsl.GRID * height).toInt()
            .coerceIn(0, max(0, height - lineH * lines.size))
        for (lineText in lines) {
            planTextLine(paint, lineText, x0, y)
            y += lineH
        }
    }

    /** Rasterize → thin → trace one line into TEXT-layer quill strokes. */
    private fun planTextLine(paint: Paint, lineText: String, xLeft: Int?, y: Int) {
        val m = rasterize(paint, lineText)
        Script.thin(m.mask, m.w, m.h)
        val lineStrokes = Script.trace(m.mask, m.w, m.h)
        val x0 = xLeft ?: (width - m.w) / 2
        val wobble = jitter()
        for (s in lineStrokes) {
            val mapped = s.map { Script.Pt(x0 + it.x, y + it.y + wobble) }
            for (p in mapped) growFadeRegion(p.x, p.y, (5 * sc).roundToInt())
            strokes.add(Planned(mapped, Layer.TEXT))
        }
    }

    /** A STROKE block: grid polyline → page pixels → hand-paced dense path. */
    private fun planStroke(block: ReplyDsl.Stroke) {
        jitter() // advance the shared LCG so each stroke wobbles differently
        val dense = ReplyDsl.densify(
            ReplyDsl.mapToCanvas(block.points, width, height),
            spacingPx = max(1, (2 * sc).roundToInt()),
            wobblePx = 1.5f * sc,
            seed = jitterSeed,
        )
        // No growFadeRegion: PEN-layer ink survives the fade by design.
        strokes.add(Planned(dense, Layer.PEN))
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
            aiPaint.strokeWidth = 2 * r + 1
            while (budget > 0 && strokeI < strokes.size) {
                val st = strokes[strokeI]
                val pg = pageFor(st.layer)
                if (pg == null || pointI >= st.pts.size) {
                    strokeI++
                    pointI = 0
                    continue
                }
                val p = st.pts[pointI]
                if (pointI > 0) {
                    val q = st.pts[pointI - 1]
                    pg.drawLine(q.x.toFloat(), q.y.toFloat(), p.x.toFloat(), p.y.toFloat(), aiPaint)
                    dirty(q.x, q.y)
                } else {
                    pg.drawPoint(p.x.toFloat(), p.y.toFloat(), aiPaint)
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
                val pts = strokes.sumOf { it.pts.size }
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
    // Only the TEXT layer ever dissolves: the drink eats the writer's words,
    // the fade eats the reply. PEN-layer ink is never touched.

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
            val reg = fadeRegion ?: run { finishFade(); return }
            dissolveRegionPass(textBmp, reg, dissolveStage)
            dissolveStage++
            if (dissolveStage >= dissolveStages) finishFade() else ui.postDelayed(this, dissolveTickMs)
        }
    }

    /** One dissolve_pass (ink.rs): erase this stage's hashed pixels in `regIn`. */
    private fun dissolveRegionPass(bmp: Bitmap?, regIn: Rect, stage: Int) {
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
                // Layer bitmaps are transparent where there is no ink, so
                // presence is alpha, not luma.
                if (Color.alpha(c) != 0 &&
                    Script.dissolvesAt(r.left + xx, r.top + yy, stage, dissolveStages)
                ) {
                    px[yy * wpx + xx] = Color.TRANSPARENT
                }
            }
        }
        b.setPixels(px, 0, wpx, r.left, r.top, wpx, hpx)
        Epd.partial(this, r.left, r.top, r.right, r.bottom, refreshMode)
    }

    private fun finishFade() {
        phase = Phase.IDLE
        resetPlan()
        clearTextLayer()
        rawPen?.setPaused(false)
        // A new turn begins on the PEN layer, whatever the last one used.
        activeLayer = Layer.PEN
        status("page clean — mode=${refreshMode.label} pace=${tickMs}ms×${budget()}")
    }

    // ---- helpers ----

    private fun resetPlan() {
        strokes.clear()
        strokeI = 0
        pointI = 0
        fadeRegion = null
        nextY = -1
        userTextRegion = null
        hasUserInk = false
    }

    private fun growFadeRegion(x: Int, y: Int, margin: Int) {
        val r = fadeRegion ?: Rect(x, y, x, y).also { fadeRegion = it }
        r.union(x - margin, y - margin)
        r.union(x + margin, y + margin)
    }

    private fun status(s: String) {
        onStatus?.invoke(s)
    }
}

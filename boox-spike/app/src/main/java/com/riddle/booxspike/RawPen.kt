package com.riddle.booxspike

import android.graphics.Rect
import android.util.Log
import com.onyx.android.sdk.data.note.TouchPoint
import com.onyx.android.sdk.pen.RawInputCallback
import com.onyx.android.sdk.pen.TouchHelper
import com.onyx.android.sdk.pen.data.TouchPointList

/**
 * Rung 3 of the latency ladder: Onyx TouchHelper raw drawing — the firmware
 * draws the live stroke at the driver level, we bake the points into the
 * page on pen-up. The built-in Notes app proves this device can render
 * pressure-modulated width live; these variants sweep the public-SDK knobs
 * hunting for that pipeline:
 *  A — brush flag set BEFORE openRawDrawing
 *  B — created with FEATURE_ALL_TOUCH_RENDER
 *  C — created with FEATURE_SF_TOUCH_RENDER
 */
class RawPen(private val view: TomView) {

    enum class Variant(val label: String) {
        A_BRUSH_FIRST("RAW·A"),
        B_FEATURE_ALL("RAW·B"),
        C_FEATURE_SF("RAW·C");
    }

    private var helper: TouchHelper? = null
    var engaged = false
        private set

    private val callback = object : RawInputCallback() {
        // Hybrid rendering: the firmware preview gives instant (fixed-width)
        // feedback while the move stream inks pressure-width in software a
        // beat behind — converged by pen-up, so nothing "appears" afterwards.
        override fun onBeginRawDrawing(b: Boolean, p: TouchPoint) {
            view.post { view.beginRawLiveStroke() }
        }

        override fun onEndRawDrawing(b: Boolean, p: TouchPoint) {
            view.post { view.finishRawLiveStroke() }
        }

        override fun onRawDrawingTouchPointMoveReceived(p: TouchPoint) {
            // SDK thread — TomView queues thread-safely.
            view.queueRawLivePoint(p.x, p.y, p.pressure)
        }

        override fun onRawDrawingTouchPointListReceived(list: TouchPointList) {
            val pts = list.points ?: return
            if (pts.isEmpty()) return
            Log.i("riddle-spike", "raw stroke complete: ${pts.size} pts")
        }

        override fun onBeginRawErasing(b: Boolean, p: TouchPoint) {}
        override fun onEndRawErasing(b: Boolean, p: TouchPoint) {}
        override fun onRawErasingTouchPointMoveReceived(p: TouchPoint) {}
        override fun onRawErasingTouchPointListReceived(list: TouchPointList) {}
    }

    /** (Re)build the TouchHelper for `variant` and engage raw drawing. */
    fun engage(variant: Variant): Boolean {
        off()
        helper = null
        return runCatching {
            val h = when (variant) {
                Variant.A_BRUSH_FIRST ->
                    TouchHelper.create(view, callback)
                Variant.B_FEATURE_ALL ->
                    TouchHelper.create(view, TouchHelper.FEATURE_ALL_TOUCH_RENDER, callback)
                Variant.C_FEATURE_SF ->
                    TouchHelper.create(view, TouchHelper.FEATURE_SF_TOUCH_RENDER, callback)
            }
            helper = h
            val limit = Rect()
            view.getLocalVisibleRect(limit)
            h.setStrokeWidth(6f)
                .setStrokeStyle(TouchHelper.STROKE_STYLE_NEO_BRUSH)
            h.setBrushRawDrawingEnabled(true)
            h.setLimitRect(limit, arrayListOf())
                .openRawDrawing()
            h.setRawDrawingEnabled(true)
            h.setRawDrawingRenderEnabled(true)
            // Our hybrid ink is already in the bitmap by pen-up; the SDK's
            // own pen-up refresh sequence is what "slowly reveals" it.
            // Disable it — TomView fires one decisive refresh instead.
            h.setPenUpRefreshEnabled(false)
            engaged = true
            Log.i("riddle-spike", "TouchHelper engaged: ${variant.label}")
            true
        }.onFailure {
            Log.w("riddle-spike", "TouchHelper engage(${variant.label}) failed", it)
            engaged = false
        }.getOrDefault(false)
    }

    fun off() {
        runCatching {
            helper?.setRawDrawingEnabled(false)
            helper?.closeRawDrawing()
        }.onFailure { Log.w("riddle-spike", "TouchHelper off failed", it) }
        engaged = false
    }

    /**
     * Raw mode suppresses normal refreshes inside the limit rect, so the
     * page pauses it while Tom writes or the ink dissolves.
     */
    fun setPaused(paused: Boolean) {
        if (!engaged) return
        runCatching { helper?.setRawDrawingEnabled(!paused) }
            .onFailure { Log.w("riddle-spike", "TouchHelper pause failed", it) }
    }
}

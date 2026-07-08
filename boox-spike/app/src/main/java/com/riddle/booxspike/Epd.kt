package com.riddle.booxspike

import android.util.Log
import android.view.View
import com.onyx.android.sdk.api.device.epd.EpdController
import com.onyx.android.sdk.api.device.epd.UpdateMode

/**
 * Refresh strategies under test, cycled from the Mode button.
 * PLAIN issues no Onyx calls at all — the baseline (and what a non-Boox
 * device shows). The rest pick the e-ink waveform for each partial update.
 */
enum class RefreshMode(val label: String, val update: UpdateMode?) {
    DU("DU", UpdateMode.DU),
    ANIM_MONO("ANIM", UpdateMode.ANIMATION_MONO),
    GU("GU", UpdateMode.GU),
    REGAL("REGAL", UpdateMode.REGAL),
    PLAIN("PLAIN", null);

    fun next(): RefreshMode = entries[(ordinal + 1) % entries.size]
}

/**
 * Thin runtime-guarded wrapper over EpdController: every call falls back to
 * a plain View.invalidate() so the spike still runs on a non-Boox device
 * (just without waveform control).
 */
object Epd {
    private const val TAG = "riddle-spike"

    var lastError: String? = null
        private set

    fun partial(view: View, l: Int, t: Int, r: Int, b: Int, mode: RefreshMode) {
        val m = mode.update
        if (m == null) {
            view.invalidate()
            return
        }
        runCatching { EpdController.invalidate(view, l, t, r, b, m) }
            .onFailure { e ->
                lastError = e.toString()
                Log.w(TAG, "EpdController.invalidate failed, plain invalidate", e)
                view.invalidate()
            }
    }

    fun fullRefresh(view: View) {
        runCatching { EpdController.invalidate(view, UpdateMode.GC) }
            .onFailure { e ->
                lastError = e.toString()
                Log.w(TAG, "GC refresh failed, plain invalidate", e)
                view.invalidate()
            }
    }
}

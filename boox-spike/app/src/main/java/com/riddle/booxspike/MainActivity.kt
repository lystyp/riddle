package com.riddle.booxspike

import android.app.Activity
import android.graphics.Color
import android.os.Build
import android.os.Bundle
import android.view.WindowManager
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import org.lsposed.hiddenapibypass.HiddenApiBypass

/**
 * Spike harness: does Tom's stroke-by-stroke reply animation survive Boox
 * partial refresh? Cycle Mode (waveform) × Pace (tick coarseness), press
 * Write, judge with your eyes. Numbers land in the status line and logcat.
 */
class MainActivity : Activity() {

    private val texts = listOf(
        "Hello. I am Tom Riddle. How curious that you should find my diary.",
        "I have been waiting for someone new to write to me. Tell me your secrets.",
        "The Chamber of Secrets has been opened. Do you know what sleeps within?",
    )
    private var textI = 0

    // (tick ms, points per tick at reference scale). First entry is riddle's own pace;
    // the others deliver the same ink rate with coarser, less frequent updates.
    private val paces = listOf(14L to 26, 33L to 62, 66L to 124)
    private var paceI = 0
    private var penVariantI = 0

    private var chromeHidden = false
    private var restoreChrome: (() -> Unit)? = null

    // The back gesture / nav-ball back is the dependable way out of
    // full-screen (a two-finger tap can be swallowed by system gestures or
    // a touch-disabled panel): it restores the chrome instead of quitting.
    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        if (chromeHidden) {
            restoreChrome?.invoke()
        } else {
            @Suppress("DEPRECATION")
            super.onBackPressed()
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (Build.VERSION.SDK_INT >= 28) {
            runCatching { HiddenApiBypass.addHiddenApiExemptions("") }
        }
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        val tom = TomView(this)
        val cfg = Oracle.loadConfig(this)
        if (cfg != null) tom.oracle = Oracle(cfg)
        val status = TextView(this).apply {
            textSize = 12f
            setTextColor(Color.BLACK)
            setBackgroundColor(Color.WHITE)
            setPadding(16, 4, 16, 4)
            // Pinned to two lines: a status re-wrapping between one and two
            // lines resizes TomView, and a resize cancels every scheduled
            // callback on the page (commit countdown, drink animation).
            minLines = 2
            maxLines = 2
            ellipsize = android.text.TextUtils.TruncateAt.END
            text = if (cfg != null) {
                "oracle ready (${cfg.model}) — 直接寫、直接畫，停筆等回應；字會淡去、畫會留下"
            } else {
                "oracle 未設定：adb push oracle.env " +
                    "${getExternalFilesDir(null)?.absolutePath}/oracle.env"
            }
        }
        tom.onStatus = { s -> runOnUiThread { status.text = s } }

        fun btn(label: String, onClick: (Button) -> Unit) = Button(this).apply {
            text = label
            textSize = 12f
            isAllCaps = false
            setOnClickListener { onClick(this) }
        }

        val row = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            setBackgroundColor(Color.WHITE)
        }

        // Full-screen: hide all chrome (ours + system bars); a two-finger tap
        // on the page brings it back (cousin of riddle's 5-finger exit tap).
        fun setChrome(hidden: Boolean) {
            chromeHidden = hidden
            android.util.Log.i("riddle-spike", "setChrome hidden=$hidden")
            row.visibility = if (hidden) android.view.View.GONE else android.view.View.VISIBLE
            status.visibility = if (hidden) android.view.View.GONE else android.view.View.VISIBLE
            window.insetsController?.let { ctl ->
                if (hidden) {
                    ctl.systemBarsBehavior =
                        android.view.WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
                    ctl.hide(android.view.WindowInsets.Type.systemBars())
                } else {
                    ctl.show(android.view.WindowInsets.Type.systemBars())
                }
            }
            // The page grew/shrank: RAW mode's hardware limit rect is stale —
            // re-engage after the new layout settles.
            if (penVariantI > 0) {
                tom.post { tom.rawPen?.engage(RawPen.Variant.entries[penVariantI - 1]) }
            }
        }
        tom.onChromeRestore = { runOnUiThread { setChrome(false) } }
        restoreChrome = { setChrome(false) }

        row.apply {
            addView(btn("Write") {
                tom.write(texts[textI % texts.size])
                textI++
            }, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
            addView(btn("Mode: ${tom.refreshMode.label}") { b ->
                tom.refreshMode = tom.refreshMode.next()
                b.text = "Mode: ${tom.refreshMode.label}"
            }, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
            addView(btn("Pace: ${paces[paceI].first}ms") { b ->
                paceI = (paceI + 1) % paces.size
                tom.tickMs = paces[paceI].first
                tom.pointsPerTickRef = paces[paceI].second
                b.text = "Pace: ${paces[paceI].first}ms"
            }, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
            addView(btn("Pen: SOFT") { b ->
                val raw = tom.rawPen ?: RawPen(tom).also { tom.rawPen = it }
                // Cycle SOFT → RAW·A → RAW·B → RAW·C → SOFT.
                penVariantI = (penVariantI + 1) % 4
                if (penVariantI == 0) {
                    raw.off()
                    b.text = "Pen: SOFT"
                    status.text = "raw drawing off — soft path"
                } else {
                    val v = RawPen.Variant.entries[penVariantI - 1]
                    if (raw.engage(v)) {
                        b.text = "Pen: ${v.label}"
                        status.text = "${v.label} ON — write with the pen"
                    } else {
                        penVariantI = 0
                        b.text = "Pen: SOFT"
                        status.text = "${v.label} 啟動失敗（看 logcat）— soft path"
                    }
                }
            }, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
            addView(btn("Clear") { tom.clearPage() },
                LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
            addView(btn("Hide") { setChrome(true) },
                LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
        }

        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(Color.WHITE)
            addView(row, LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT))
            // Fixed pixel height, not WRAP_CONTENT: even at minLines=2 the
            // measured height differs ~2px between CJK and Latin messages,
            // and that 2px re-layout of TomView lands ~40ms after every
            // commit — killing the drink animation it just started.
            addView(status, LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                (48 * resources.displayMetrics.density).toInt()))
            addView(tom, LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f))
        }

        setContentView(root)
    }
}

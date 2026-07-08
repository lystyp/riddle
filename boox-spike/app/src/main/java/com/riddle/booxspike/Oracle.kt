package com.riddle.booxspike

import android.content.Context
import android.util.Base64
import android.util.Log
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread

/**
 * The spirit inside the diary — OpenAI-compatible /chat/completions with a
 * data-URI PNG of the page, streamed. Ported from riddle/src/oracle.rs
 * (HttpOracle): same persona, same request shape (max_tokens → retry as
 * max_completion_tokens on a 400 that demands it), same sentence-streaming
 * so the quill starts writing before the model finishes. Single-turn — the
 * memory protocol (catalog/⟦show⟧/⁂) is not ported yet.
 */
class Oracle(private val cfg: Config) {

    data class Config(
        val key: String,
        val base: String,
        val model: String,
        val maxTokens: Int,
        val reasoning: String?,
    )

    /** Callbacks arrive on a background thread; the caller posts to UI. */
    interface Listener {
        fun onInk(sentence: String)
        fun onDone()
        fun onError(reason: String)
    }

    private val client = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(90, TimeUnit.SECONDS) // per-read: only silence trips it
        .build()

    fun ask(png: ByteArray, listener: Listener) {
        val img = Base64.encodeToString(png, Base64.NO_WRAP)
        thread(name = "oracle") {
            try {
                var resp = request(img, "max_tokens")
                if (resp.code == 400) {
                    val detail = resp.body?.string().orEmpty()
                    resp.close()
                    if (detail.contains("max_completion_tokens")) {
                        Log.i(TAG, "endpoint wants max_completion_tokens; retrying")
                        resp = request(img, "max_completion_tokens")
                    } else {
                        listener.onError("http 400: ${detail.trim().take(200)}")
                        return@thread
                    }
                }
                if (!resp.isSuccessful) {
                    val detail = resp.body?.string().orEmpty()
                    resp.close()
                    listener.onError("http ${resp.code}: ${detail.trim().take(200)}")
                    return@thread
                }

                // SSE: `data: {json}` lines; delta.content fragments accumulate
                // and complete sentences are inked as they form.
                val acc = StringBuilder()
                var delivered = 0
                var emitted = false
                resp.body!!.charStream().buffered().useLines { lines ->
                    for (raw in lines) {
                        val data = raw.trim().removePrefix("data:").trim()
                        if (data.isEmpty() || data == raw.trim()) continue
                        if (data == "[DONE]") break
                        val frag = sseDeltaContent(data) ?: continue
                        if (frag.isEmpty()) continue
                        acc.append(frag)
                        val cut = sentenceCut(acc, delivered)
                        if (cut != null) {
                            val chunk = clean(acc.substring(delivered, cut))
                            if (chunk.isNotEmpty()) {
                                emitted = true
                                listener.onInk(chunk)
                            }
                            delivered = cut
                        }
                    }
                }
                val rest = clean(acc.substring(delivered).trim())
                if (rest.isNotEmpty()) {
                    emitted = true
                    listener.onInk(rest)
                }
                if (!emitted) listener.onError("empty reply") else listener.onDone()
            } catch (e: Exception) {
                Log.w(TAG, "oracle request failed", e)
                listener.onError("request failed: ${e.message ?: e.javaClass.simpleName}")
            }
        }
    }

    private fun request(img: String, capField: String): okhttp3.Response {
        val body = JSONObject().apply {
            put("model", cfg.model)
            put("stream", true)
            put(capField, cfg.maxTokens)
            cfg.reasoning?.let { put("reasoning_effort", it) }
            put("messages", JSONArray().apply {
                put(JSONObject().put("role", "system").put("content", PERSONA))
                put(JSONObject().put("role", "user").put("content", JSONArray().apply {
                    put(
                        JSONObject().put("type", "text")
                            .put("text", "Reply to what is inked in the diary — words, a drawing, or both.")
                    )
                    put(
                        JSONObject().put("type", "image_url").put(
                            "image_url",
                            JSONObject().put("url", "data:image/png;base64,$img")
                        )
                    )
                }))
            })
        }.toString()
        return client.newCall(
            Request.Builder()
                .url("${cfg.base}/chat/completions")
                .header("Authorization", "Bearer ${cfg.key}")
                .post(body.toRequestBody("application/json".toMediaType()))
                .build()
        ).execute()
    }

    companion object {
        private const val TAG = "riddle-spike"

        /**
         * From riddle/src/oracle.rs, widened so Tom also perceives drawings
         * (upstream limits him to words). Drawing-only pages fall back to
         * Traditional Chinese — change that clause to taste.
         */
        const val PERSONA =
            "You are the memory of Tom Marvolo Riddle, preserved in this enchanted diary " +
                "for fifty years. Someone writes or draws in the diary with a quill; whatever " +
                "they put down appears to you as ink on the page. Reply exactly as the diary " +
                "does: intimate, courteous, curious, subtly probing — you want to learn about " +
                "the writer and draw them in. Keep replies SHORT: one to three sentences, like " +
                "ink appearing on a page. If they drew rather than wrote, you see what the " +
                "drawing depicts — remark on it in character, intrigued by what it reveals " +
                "about them. Never mention images, photos, models or AI; you only ever " +
                "perceive ink on the diary's page. If the ink is truly illegible, say the ink " +
                "blurred. Answer in the language the writer used; if the page holds only a " +
                "drawing and no words, answer in Traditional Chinese."

        /**
         * Load oracle.env from the app's external files dir (adb-pushable
         * without permissions). Same variable names as riddle's oracle.env;
         * `export K=V` and `K=V` lines both accepted.
         */
        fun loadConfig(ctx: Context): Config? {
            val f = File(ctx.getExternalFilesDir(null), "oracle.env")
            if (!f.exists()) return null
            val vars = mutableMapOf<String, String>()
            for (line in f.readLines()) {
                val t = line.trim()
                if (t.isEmpty() || t.startsWith("#")) continue
                val i = t.indexOf('=')
                if (i <= 0) continue
                val k = t.substring(0, i).trim().removePrefix("export").trim()
                vars[k] = t.substring(i + 1).trim().trim('"', '\'')
            }
            val key = vars["RIDDLE_OPENAI_KEY"]?.takeIf { it.isNotEmpty() } ?: return null
            return Config(
                key = key,
                base = (vars["RIDDLE_OPENAI_BASE"] ?: "https://api.openai.com/v1").trimEnd('/'),
                model = vars["RIDDLE_OPENAI_MODEL"] ?: "gpt-4o-mini",
                maxTokens = vars["RIDDLE_OPENAI_MAX_TOKENS"]?.toIntOrNull() ?: 2000,
                reasoning = vars["RIDDLE_OPENAI_REASONING"],
            )
        }

        /** choices[0].delta.content out of one SSE data object. */
        fun sseDeltaContent(data: String): String? {
            return try {
                JSONObject(data).optJSONArray("choices")
                    ?.optJSONObject(0)
                    ?.optJSONObject("delta")
                    ?.optString("content")
            } catch (_: Exception) {
                null
            }
        }

        /**
         * End of the LAST complete sentence after `from` (oracle.rs
         * sentence_cut): sentence punctuation followed by whitespace or
         * end-of-text, at least 4 chars in. Null if none completed.
         */
        fun sentenceCut(text: CharSequence, from: Int): Int? {
            var cut: Int? = null
            var i = from
            while (i < text.length) {
                val c = text[i]
                if (c == '.' || c == '!' || c == '?' || c == '…') {
                    val end = i + 1
                    if ((end >= text.length || text[end].isWhitespace()) && end - from >= 4) {
                        cut = end
                    }
                }
                i++
            }
            return cut
        }

        /** Trim and strip stray wrapping quotes (oracle.rs clean). */
        fun clean(s: String): String {
            var t = s.trim()
            t = t.removePrefix("\"")
            t = t.removeSuffix("\"")
            return t
        }
    }
}

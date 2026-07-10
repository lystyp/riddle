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
 * The spirit that shares the page — OpenAI-compatible /chat/completions with
 * a data-URI PNG of the page, streamed. Transport is unchanged from the
 * Tom-Riddle era (max_tokens → retry as max_completion_tokens on a 400 that
 * demands it); what changed is the reply: instead of free prose cut into
 * sentences, the model answers in the ReplyDsl grammar, and each block is
 * delivered the moment its terminator streams in, so the quill starts moving
 * before the model finishes.
 *
 * An Oracle instance is one conversation. Every finished turn is kept as
 * text (our prompt, its raw DSL reply) and rides along with the next
 * request; only the current turn carries the page snapshot, so the payload
 * does not grow with the session. The words on the page fade after each
 * turn, which is why every reply must open with a SEE block — the model's
 * own transcription of what it saw is the only durable record of the user's
 * side of the conversation.
 */
class Oracle(private val cfg: Config) {

    data class Config(
        val key: String,
        val base: String,
        val model: String,
        val maxTokens: Int,
        val reasoning: String?,
    )

    /** One finished turn: what we asked (text only) and the raw DSL reply. */
    data class Exchange(val userText: String, val assistantRaw: String)

    /**
     * One page capture: the PNG plus the pixel frame the model will draw in
     * (its own size, and how tall a rendered text line is inside it).
     */
    class Snapshot(val png: ByteArray, val width: Int, val height: Int, val textLineH: Int)

    private val history = ArrayList<Exchange>()

    /** Forget the conversation — Clear starts a fresh session. */
    fun resetSession() {
        synchronized(history) { history.clear() }
    }

    /** Callbacks arrive on a background thread; the caller posts to UI. */
    interface Listener {
        fun onBlock(block: ReplyDsl.Block)
        fun onDone()
        fun onError(reason: String)
    }

    private val client = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(90, TimeUnit.SECONDS) // per-read: only silence trips it
        .build()

    fun ask(snap: Snapshot, listener: Listener) {
        val img = Base64.encodeToString(snap.png, Base64.NO_WRAP)
        thread(name = "oracle") {
            try {
                val userText: String
                val hist: List<Exchange>
                synchronized(history) {
                    userText = turnPrompt(
                        firstTurn = history.isEmpty(),
                        imgW = snap.width,
                        imgH = snap.height,
                        textLineH = snap.textLineH,
                    )
                    hist = ArrayList(history)
                }
                var resp = request(hist, userText, img, "max_tokens")
                if (resp.code == 400) {
                    val detail = resp.body?.string().orEmpty()
                    resp.close()
                    if (detail.contains("max_completion_tokens")) {
                        Log.i(TAG, "endpoint wants max_completion_tokens; retrying")
                        resp = request(hist, userText, img, "max_completion_tokens")
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

                // SSE: `data: {json}` lines; delta.content fragments feed the
                // DSL parser and completed blocks go out as they form. The
                // verbatim reply is kept too — it becomes the history entry.
                val parser = ReplyDsl.StreamParser()
                val rawReply = StringBuilder()
                var emitted = false
                fun deliver(blocks: List<ReplyDsl.Block>) {
                    for (b in blocks) {
                        emitted = true
                        listener.onBlock(b)
                    }
                }
                resp.body!!.charStream().buffered().useLines { lines ->
                    for (raw in lines) {
                        val data = raw.trim().removePrefix("data:").trim()
                        if (data.isEmpty() || data == raw.trim()) continue
                        if (data == "[DONE]") break
                        val frag = sseDeltaContent(data) ?: continue
                        if (frag.isEmpty()) continue
                        rawReply.append(frag)
                        deliver(parser.feed(frag))
                    }
                }
                deliver(parser.finish())
                if (!emitted) {
                    listener.onError("empty reply")
                } else {
                    synchronized(history) {
                        history.add(Exchange(userText, rawReply.toString().trim()))
                        while (history.size > MAX_TURNS) history.removeAt(0)
                    }
                    listener.onDone()
                }
            } catch (e: Exception) {
                Log.w(TAG, "oracle request failed", e)
                listener.onError("request failed: ${e.message ?: e.javaClass.simpleName}")
            }
        }
    }

    private fun request(
        hist: List<Exchange>,
        userText: String,
        img: String,
        capField: String,
    ): okhttp3.Response {
        val body = JSONObject().apply {
            put("model", cfg.model)
            put("stream", true)
            put(capField, cfg.maxTokens)
            cfg.reasoning?.let { put("reasoning_effort", it) }
            put("messages", messagesJson(hist, userText, img))
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

        /** Turns of history that ride along with each request. */
        const val MAX_TURNS = 8

        /**
         * No persona, just temperament: a lively companion on a shared page.
         * The grammar section must stay in lockstep with ReplyDsl.StreamParser
         * (tokens, caps) — the parser is the source of truth for what survives.
         */
        val SYSTEM_PROMPT =
            """
            You are a lively, playful companion sharing a drawing page with the user — quick-witted, warm, a little cheeky. React to whatever shows up on the page.

            Each turn you receive one PNG snapshot of the whole page:
            - BLACK ink was put down by the user: handwritten words and drawings.
            - BLUE ink is yours from earlier turns. Only drawings persist on the page; written words always fade away once read (theirs and yours), so never re-answer old text.

            Coordinates: every x y in your reply is a pixel position in the snapshot you received this turn — origin at the top-left corner, x growing rightward, y growing downward. Each turn message states the snapshot's exact pixel size; keep every coordinate inside that frame. What you see is the frame you draw in, one to one.

            Reply in EXACTLY this plain-text grammar, nothing outside it (no markdown, no code fences):
            SEE
            your private notes about the page, one or more lines
            END_SEE
            TEXT x y
            what you say, one or more lines
            END_TEXT
            STROKE
            P x y
            P x y
            END_STROKE
            END

            Rules:
            - SEE is your working memory and is NEVER drawn on the page. The page's words fade, but this conversation's history is kept — a SEE block is the only durable record of what was written. START EVERY reply with one: on the first turn of a session, describe everything on the page completely (transcribe every word, describe every drawing); on later turns, briefly note the NEW black ink since your last reply, transcribing any new words exactly.
            - TEXT is you talking: usually one block of 1-3 short sentences, in the user's language. (x, y) is the block's top-left corner in snapshot pixels; the rendered line height is stated in each turn message, and lines wrap at the right page edge. Place it over empty paper, never on top of existing ink.
            - STROKE is you drawing: one pen stroke per block, drawn in your blue ink, and it stays on the page. Give 3-12 anchor points per stroke — endpoints, corners, curve landmarks — and a smooth hand-drawn curve is drawn through them; do NOT trace every pixel. Draw whenever it adds something — decorate, answer visually, riff on their sketch. Any number of strokes, including none.
            - Everything already on the page is fixed. Never redraw, trace over, or "fix" existing strokes; you only append new ink.
            - At most ${ReplyDsl.MAX_STROKES} STROKE blocks and ${ReplyDsl.MAX_POINTS} P lines per reply.
            - END must be the last line, always.
            """.trimIndent()

        /**
         * The per-turn user message; the page snapshot rides next to it.
         * The pixel frame is restated every turn because it is the reply's
         * coordinate system — and it can change when the page re-lays out.
         */
        fun turnPrompt(firstTurn: Boolean, imgW: Int, imgH: Int, textLineH: Int): String {
            val frame = "The snapshot is ${imgW}x$imgH pixels; every coordinate " +
                "in your reply is a pixel position in it. A rendered TEXT line " +
                "is about ${textLineH}px tall."
            return if (firstTurn) {
                "This is the first turn of a new session. $frame Begin with a " +
                    "SEE block describing everything currently on the page — " +
                    "transcribe every word, describe every drawing and its " +
                    "color. Then reply."
            } else {
                "Here is the page as it looks now. $frame Begin with a brief " +
                    "SEE block noting what is new in BLACK ink since your last " +
                    "reply (transcribe new words exactly), then reply."
            }
        }

        /**
         * Assemble the messages array: system, then the kept turns as plain
         * text (our prompt / its raw DSL reply), then the current turn with
         * the snapshot. Only the current turn carries an image — the past
         * pages' content survives via the SEE notes inside the raw replies.
         */
        fun messagesJson(hist: List<Exchange>, userText: String, imgB64: String): JSONArray =
            JSONArray().apply {
                put(JSONObject().put("role", "system").put("content", SYSTEM_PROMPT))
                for (e in hist.takeLast(MAX_TURNS)) {
                    put(JSONObject().put("role", "user").put("content", e.userText))
                    put(JSONObject().put("role", "assistant").put("content", e.assistantRaw))
                }
                put(JSONObject().put("role", "user").put("content", JSONArray().apply {
                    put(JSONObject().put("type", "text").put("text", userText))
                    put(
                        JSONObject().put("type", "image_url").put(
                            "image_url",
                            JSONObject().put("url", "data:image/png;base64,$imgB64")
                        )
                    )
                }))
            }

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
    }
}

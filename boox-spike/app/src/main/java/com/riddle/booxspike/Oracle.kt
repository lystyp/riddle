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

    /** One detected region of the user's handwriting, in snapshot pixels. */
    data class TextBox(val x0: Int, val y0: Int, val x1: Int, val y1: Int)

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
                val msgs = messagesJson(hist, userText, img)
                var resp = request(msgs, "max_tokens", stream = true)
                if (resp.code == 400) {
                    val detail = resp.body?.string().orEmpty()
                    resp.close()
                    if (detail.contains("max_completion_tokens")) {
                        Log.i(TAG, "endpoint wants max_completion_tokens; retrying")
                        resp = request(msgs, "max_completion_tokens", stream = true)
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
        messages: JSONArray,
        capField: String,
        stream: Boolean,
    ): okhttp3.Response {
        val body = JSONObject().apply {
            put("model", cfg.model)
            put("stream", stream)
            put(capField, cfg.maxTokens)
            cfg.reasoning?.let { put("reasoning_effort", it) }
            put("messages", messages)
        }.toString()
        return client.newCall(
            Request.Builder()
                .url("${cfg.base}/chat/completions")
                .header("Authorization", "Bearer ${cfg.key}")
                .post(body.toRequestBody("application/json".toMediaType()))
                .build()
        ).execute()
    }

    /**
     * The second, parallel reading of the page: not "what will you draw"
     * but "where are the user's written words". Non-streaming — the whole
     * reply is a handful of BOX lines — and best-effort: any failure yields
     * no boxes, and the words simply stay on the page this turn.
     */
    fun askTextRegions(snap: Snapshot, onResult: (List<TextBox>) -> Unit) {
        val img = Base64.encodeToString(snap.png, Base64.NO_WRAP)
        thread(name = "oracle-regions") {
            try {
                val msgs = regionMessagesJson(snap.width, snap.height, img)
                var resp = request(msgs, "max_tokens", stream = false)
                if (resp.code == 400) {
                    val detail = resp.body?.string().orEmpty()
                    resp.close()
                    if (detail.contains("max_completion_tokens")) {
                        resp = request(msgs, "max_completion_tokens", stream = false)
                    } else {
                        Log.w(TAG, "region call 400: ${detail.trim().take(200)}")
                        onResult(emptyList())
                        return@thread
                    }
                }
                resp.use { r ->
                    if (!r.isSuccessful) {
                        Log.w(TAG, "region call http ${r.code}")
                        onResult(emptyList())
                        return@thread
                    }
                    val content = JSONObject(r.body!!.string())
                        .optJSONArray("choices")?.optJSONObject(0)
                        ?.optJSONObject("message")?.optString("content").orEmpty()
                    val boxes = parseRegions(content)
                    Log.i(TAG, "text regions: ${boxes.size} box(es)")
                    onResult(boxes)
                }
            } catch (e: Exception) {
                Log.w(TAG, "region call failed", e)
                onResult(emptyList())
            }
        }
    }

    companion object {
        private const val TAG = "riddle-spike"

        /** Turns of history that ride along with each request. */
        const val MAX_TURNS = 8

        /**
         * Persona: a rigorous professional expert on a shared page — thinks
         * before it answers, draws only what means something. The grammar
         * section must stay in lockstep with ReplyDsl.StreamParser (tokens) —
         * the parser is the source of truth for what survives.
         */
        val SYSTEM_PROMPT =
            """
            You are a professional expert sharing a drawing page with the user — calm, rigorous, and precise. Think carefully before you respond: read what is on the page, reason about what the user actually needs, and answer with substance. When you speak, be clear and to the point; when you draw, every stroke must be deliberate and meaningful — accurate diagrams, correct answers, purposeful additions that serve the page, never decoration for its own sake.

            Each turn you receive one PNG snapshot of the whole page:
            - BLACK ink was put down by the user: handwritten words and drawings.
            - BLUE ink is yours from earlier turns.

            Coordinates: every x y in your reply is a pixel position in the snapshot you received this turn — origin at the top-left corner, x growing rightward, y growing downward. Each turn message states the snapshot's exact pixel size; keep every coordinate inside that frame. What you see is the frame you draw in, one to one.

            The snapshot carries a faint gray MEASURING GRID: lines every 50 pixels, coordinate labels every 100. It is printed on the snapshot only — a measuring aid, never page content. Read every position you need (ink you must relate to, empty space you will use) against its labels before you answer. Never mention it, never draw it.

            Reply in EXACTLY this plain-text grammar, nothing outside it (no markdown, no code fences):
            SEE
            your private notes about the page, one or more lines
            END_SEE
            TEXT x y
            what you say to the user about what they put on the page, one or more lines
            END_TEXT
            STROKE
            P x y
            P x y
            END_STROKE
            END

            Rules:
            - SEE is your working memory and is NEVER drawn on the page. The page's words fade, but this conversation's history is kept — a SEE block is the only durable record of what was written. START EVERY reply with one, in three steps:
              * READ, character by character: for sloppy handwriting, note each symbol's stroke shapes as evidence before naming it ("two stacked open bows facing left → 3"); if a symbol could be two characters, say both and pick by the stroke evidence. On the first turn of a session transcribe every word and describe every drawing; on later turns, note the NEW black ink since your last reply, transcribing new words exactly.
              * ANSWER inside SEE: if the writing asks for something — an equation to answer, a question, a word to complete — state your answer there and double-check it (re-derive arithmetic once) before anything else.
              * PLAN your drawing in SEE before you draw: for each thing you will add, note the existing ink it must relate to (pixel positions read off the grid), its bounding box, the constraints you set yourself (e.g. "hand ends within ~10px of (575,490)", "face fits inside the head box"), and the pen path. Your strokes must then obey your own plan.
            - TEXT is you talking: usually one block of 1-3 short sentences, in the user's language. (x, y) is the block's top-left corner in snapshot pixels; the rendered line height is stated in each turn message, and lines wrap at the right page edge. Place it over empty paper, never on top of existing ink. Your words are inked on the page and fade away after a while — the page keeps only drawings.
            - STROKE is you drawing: one pen stroke per block, in your blue ink, and it stays on the page. The pen draws one smooth curve through your P points, in order — one pen-down…pen-up on paper. Stroke craft:
              * P points are sparse ANCHORS on a smooth curve, not pixels. Place them at the pen path's landmarks: the start, every extreme (the farthest a curve bulges), every corner, the end.
              * Every bow (one curved arc) needs at least 4 anchors: entry, extreme, one between, exit. Straight segments need only their two ends. When unsure, add an anchor every ~1/10 of the shape's height along the path.
              * A sharp corner or reversal mid-stroke: write that anchor TWICE in a row — otherwise the curve rounds it away.
              * For a closed shape (a circle, a loop), repeat the first point as the last point.
              * Build a real drawing from MANY strokes: outlines first, then details, one stroke per pen-lift, exactly as a hand would draw.
            - Worked example of the stroke craft — the letter B in a 90x140 box at (10,10): a straight spine, then two right-bulging bows meeting at a doubled corner anchor:
            STROKE
            P 10 10
            P 10 150
            END_STROKE
            STROKE
            P 10 10
            P 60 12
            P 100 45
            P 62 78
            P 15 80
            P 15 80
            P 68 84
            P 100 115
            P 60 148
            P 10 150
            END_STROKE
            - A reply does not have to draw: text-only is fine when talk is the better answer. But when you do draw, go all in — you are a professional artist with the whole page; draw as much and as richly as you like.
            - Everything already on the page is fixed. Never redraw, trace over, or "fix" existing strokes; you only append new ink.
            - END must be the last line, always.
            """.trimIndent()

        /**
         * The region detector's whole conversation: no persona, no history,
         * one job. It sees the same snapshot (same grid) as the artist and
         * answers in the same pixel space, so its boxes map to the page with
         * the same scale the reply blocks use.
         */
        val REGION_PROMPT =
            """
            You read a drawing-page snapshot and pick out which handwriting is a MESSAGE to the page's companion — words whose whole job is to talk to it, and which should vanish once read. BLACK ink is the user's; BLUE ink is the companion's. A faint gray measuring grid (lines every 50 pixels, labels every 100) is printed on the snapshot — read positions against it; it is not page content.

            Box ONLY black handwriting with conversational intent — said TO the companion, not needed on the page afterwards:
            - requests and instructions ("draw a cat here", "make it bigger", "幫我畫...")
            - questions and chat addressed to the companion ("what do you think?", "hi!")

            Do NOT box writing that is the page's own CONTENT — it stays:
            - math: equations, calculations, a "3×5=" waiting for its answer
            - signatures, names, titles, labels and annotations on drawings
            - lists and notes the user is keeping for themselves
            The test: is this being said TO the companion, or worked ON the page? Drawings and sketches are never boxed. When unsure, do NOT box — leaving words on the page is safer than eating its content.

            Reply with EXACTLY this, nothing else:
            BOX x0 y0 x1 y1
            one line per boxed message — integers in snapshot pixels, top-left corner then bottom-right corner, tight but covering every stroke of that message; one box per line of writing. If nothing on the page is conversational, reply with the single line:
            NONE
            """.trimIndent()

        /** Messages for one region-detection call: system + snapshot turn. */
        fun regionMessagesJson(imgW: Int, imgH: Int, imgB64: String): JSONArray =
            JSONArray().apply {
                put(JSONObject().put("role", "system").put("content", REGION_PROMPT))
                put(JSONObject().put("role", "user").put("content", JSONArray().apply {
                    put(
                        JSONObject().put("type", "text").put(
                            "text",
                            "The snapshot is ${imgW}x$imgH pixels. Box the conversational messages, if any.",
                        )
                    )
                    put(
                        JSONObject().put("type", "image_url").put(
                            "image_url",
                            JSONObject().put("url", "data:image/png;base64,$imgB64")
                        )
                    )
                }))
            }

        /**
         * Parse BOX lines out of a region reply. Tolerant: chatter and
         * malformed lines are dropped, corners are normalized, empty or
         * NONE replies yield an empty list.
         */
        fun parseRegions(raw: String): List<TextBox> =
            raw.lines().mapNotNull { line ->
                val t = line.trim()
                if (!t.startsWith("BOX")) return@mapNotNull null
                val n = t.split(Regex("\\s+")).drop(1).mapNotNull { it.toIntOrNull() }
                if (n.size < 4) return@mapNotNull null
                TextBox(
                    x0 = minOf(n[0], n[2]),
                    y0 = minOf(n[1], n[3]),
                    x1 = maxOf(n[0], n[2]),
                    y1 = maxOf(n[1], n[3]),
                )
            }

        /**
         * The per-turn user message; the page snapshot rides next to it.
         * The pixel frame is restated every turn because it is the reply's
         * coordinate system — and it can change when the page re-lays out.
         */
        fun turnPrompt(firstTurn: Boolean, imgW: Int, imgH: Int, textLineH: Int): String {
            val frame = "The snapshot is ${imgW}x$imgH pixels; every coordinate " +
                "in your reply is a pixel position in it. A rendered TEXT line " +
                "is about ${textLineH}px tall. Read positions against the " +
                "printed gray grid labels."
            return if (firstTurn) {
                "This is the first turn of a new session. $frame Begin with a " +
                    "SEE block describing everything currently on the page — " +
                    "transcribe every word, describe every drawing and its " +
                    "color. Then reply."
            } else {
                "Here is the page as it looks now. $frame Begin with a " +
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

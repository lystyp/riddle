package com.riddle.booxspike

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** Port-fidelity tests for oracle.rs sentence_cut / clean. */
class OracleTest {

    @Test
    fun sentenceCutFindsLastCompleteSentence() {
        val t = "Hello there. How curious! And then"
        // Last complete sentence ends after "curious!" (followed by space).
        assertEquals("Hello there. How curious!".length, Oracle.sentenceCut(t, 0))
    }

    @Test
    fun sentenceCutNeedsWhitespaceOrEndAfterPunctuation() {
        assertNull(Oracle.sentenceCut("version 3.14 is", 0))
        assertEquals(9, Oracle.sentenceCut("A riddle.", 0))
    }

    @Test
    fun sentenceCutRespectsMinimumLength() {
        assertNull(Oracle.sentenceCut("Ah.", 0)) // end=3 < 4: not worth a delivery
        assertEquals(4, Oracle.sentenceCut("Ahh.", 0))
    }

    @Test
    fun sentenceCutResumesFromOffset() {
        val t = "One. Two. Three."
        val first = Oracle.sentenceCut(t, 0)!!
        assertEquals(t.length, first) // last complete sentence from 0 is the whole text
        assertNull(Oracle.sentenceCut(t, t.length))
    }

    @Test
    fun cleanStripsWrappingQuotes() {
        assertEquals("hello", Oracle.clean("  \"hello\"  "))
        assertEquals("no quotes", Oracle.clean("no quotes"))
    }

    @Test
    fun sseDeltaContentExtractsFragment() {
        val data = """{"choices":[{"delta":{"content":"Hi the"},"index":0}]}"""
        assertEquals("Hi the", Oracle.sseDeltaContent(data))
        assertEquals(
            "",
            Oracle.sseDeltaContent("""{"choices":[{"delta":{},"index":0}]}""").orEmpty()
        )
    }
}

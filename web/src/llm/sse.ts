// SSE plumbing shared by providers: split a response body into `data:`
// payload strings, with OkHttp-style read-idle timeout (only silence
// between chunks trips it — a long reply that keeps streaming never
// does). What each payload means is the provider's business.

/** OkHttp's readTimeout equivalent: only silence between chunks trips it. */
export const READ_IDLE_MS = 90_000;

/**
 * Yield each non-empty `data:` payload of an SSE body. Ends when the
 * stream closes; a consumer that `break`s early (e.g. on its vendor's
 * terminator payload) cancels the underlying stream.
 */
export async function* sseData(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<string, void, void> {
  const reader = body.getReader();
  try {
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await readWithIdleTimeout(reader);
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const raw = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!raw.startsWith("data:")) continue;
        const data = raw.slice("data:".length).trim();
        if (data.length > 0) yield data;
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}

function readWithIdleTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reader.cancel().catch(() => {});
      reject(new Error(`stream idle for ${READ_IDLE_MS / 1000}s`));
    }, READ_IDLE_MS);
    reader.read().then(
      (r) => {
        clearTimeout(timer);
        resolve(r);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

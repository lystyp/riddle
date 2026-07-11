// Offline stand-in for an OpenAI-compatible /chat/completions endpoint,
// speaking the current two-call protocol:
// - the ARTIST call (stream: true) gets a canned ReplyDsl reply streamed
//   as SSE, line by line, so block-by-block delivery is exercised;
// - the REGION-DETECTOR call (stream: false) gets a plain JSON completion
//   with BOX lines (default NONE — a mouse squiggle is a drawing).
// The whole draw → think → write-back → fade loop runs without an API key
// or network.
//
//   node mock-oracle.mjs          # http://localhost:8797/v1
//
// Point the app at it from the Oracle… dialog:
//   RIDDLE_OPENAI_KEY=mock
//   RIDDLE_OPENAI_BASE=http://localhost:8797/v1

import http from "node:http";

const PORT = Number(process.env.PORT ?? 8797);
const REPLY =
  process.env.MOCK_REPLY ??
  [
    "SEE",
    "A fresh squiggle of black ink across the middle of the page.",
    "END_SEE",
    "TEXT 40 40",
    "How curious. Your quill trembles, yet your secrets stay dry. Tell me more.",
    "END_TEXT",
    "STROKE",
    "P 120 300",
    "P 160 260",
    "P 160 260",
    "P 220 310",
    "P 280 270",
    "END_STROKE",
    "END",
  ].join("\n");
const BOXES = process.env.MOCK_BOXES ?? "NONE";

const server = http.createServer((req, res) => {
  // The browser preflights the Authorization header — answer CORS properly.
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "authorization, content-type");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }
  if (!req.url?.endsWith("/chat/completions")) {
    res.writeHead(404);
    res.end();
    return;
  }
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    let stream = false;
    try {
      stream = JSON.parse(body).stream === true;
    } catch {
      // malformed body — treat as non-stream
    }
    const hasImage = body.includes("data:image/png;base64,");
    console.log(
      `${stream ? "artist" : "detector"} ask — png attached: ${hasImage}, body ${body.length} bytes`,
    );
    if (!stream) {
      // The region detector: one plain completion of BOX/NONE lines.
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: BOXES } }] }));
      return;
    }
    // The artist: the DSL reply as SSE, one line per event so the client
    // parser sees terminators arrive one at a time.
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const lines = REPLY.split("\n");
    let i = 0;
    const timer = setInterval(() => {
      if (i < lines.length) {
        const frag = lines[i++] + "\n";
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: frag } }] })}\n\n`);
      } else {
        clearInterval(timer);
        res.write("data: [DONE]\n\n");
        res.end();
      }
    }, 40);
  });
});

server.listen(PORT, () => {
  console.log(`mock oracle on http://localhost:${PORT}/v1`);
});

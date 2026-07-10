// Offline stand-in for an OpenAI-compatible /chat/completions endpoint:
// streams a canned Tom reply as SSE, word by word, so the whole
// draw → drink → write-back loop runs without an API key or network.
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
  "How curious. Your quill trembles, yet your secrets stay dry. Tell me more.";

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
    const hasImage = body.includes("data:image/png;base64,");
    console.log(`ask received — png attached: ${hasImage}, body ${body.length} bytes`);
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const words = REPLY.split(" ");
    let i = 0;
    const timer = setInterval(() => {
      if (i < words.length) {
        const frag = (i > 0 ? " " : "") + words[i++];
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

// End-to-end smoke: drive the real page in headless Chrome against the
// mock oracle — draw a stroke, wait out the 2.8s idle commit, and watch
// the status line walk think → write → linger → fade → clean.
// Proves the whole loop without a tablet, an APK install, or an API key.
//
//   node e2e-smoke.mjs            # needs Google Chrome installed
//
// Exits 0 on success; prints the failing stage otherwise.

import { spawn } from "node:child_process";
import { chromium } from "playwright-core";

const VITE_PORT = 5199;
const MOCK_PORT = 8797;
const children = [];

function run(cmd, args, env = {}) {
  const child = spawn(cmd, args, {
    cwd: new URL(".", import.meta.url).pathname,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  return child;
}

async function waitForHttp(url, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await fetch(url, { method: "HEAD" });
      return;
    } catch {
      if (Date.now() > deadline) throw new Error(`timeout waiting for ${url}`);
      await new Promise((r) => setTimeout(r, 200));
    }
  }
}

const waitStatus = (page, needle, timeout) =>
  page.waitForFunction(
    (n) => document.querySelector("#status").textContent.includes(n),
    needle,
    { timeout },
  );

let browser;
try {
  run("node", ["mock-oracle.mjs"], { PORT: String(MOCK_PORT) });
  run("npx", ["vite", "--port", String(VITE_PORT), "--strictPort"]);
  await waitForHttp(`http://localhost:${MOCK_PORT}/v1/chat/completions`);
  await waitForHttp(`http://localhost:${VITE_PORT}/`);

  browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  // The page treats /oracle.env as the source of truth, so override the
  // config through that same channel — return the mock's OpenAI config
  // instead of the developer's real public/oracle.env.
  await page.route("**/oracle.env", (route) =>
    route.fulfill({
      contentType: "text/plain",
      body: [
        "RIDDLE_OPENAI_KEY=mock",
        `RIDDLE_OPENAI_BASE=http://localhost:${MOCK_PORT}/v1`,
        "RIDDLE_OPENAI_MODEL=mock-model",
      ].join("\n"),
    }),
  );
  await page.goto(`http://localhost:${VITE_PORT}/`);

  console.log("stage: fonts + oracle config");
  await waitStatus(page, "oracle ready", 30000);

  console.log("stage: draw a stroke");
  const box = await page.locator("#page").boundingBox();
  await page.mouse.move(box.x + 100, box.y + 150);
  await page.mouse.down();
  for (let i = 1; i <= 40; i++) {
    await page.mouse.move(box.x + 100 + i * 10, box.y + 150 + Math.sin(i / 4) * 40);
  }
  await page.mouse.up();
  await waitStatus(page, "stroke:", 3000);

  console.log("stage: idle commit → the page thinks");
  await waitStatus(page, "thinking", 6000);

  console.log("stage: the oracle writes back");
  await waitStatus(page, "wrote ", 120000);

  const inkPixels = await page.evaluate(() => {
    const c = document.querySelector("#page");
    const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] < 128) n++;
    return n;
  });
  if (inkPixels < 500) throw new Error(`expected a page of ink, found ${inkPixels} dark px`);
  console.log(`stage: reply inked (${inkPixels} dark px)`);
  await page.screenshot({ path: process.env.SMOKE_SHOT ?? "/tmp/riddle-web-smoke.png" });

  console.log("stage: tap to skip the linger → dissolve → clean");
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await waitStatus(page, "page clean", 30000);

  console.log("smoke OK");
} finally {
  await browser?.close();
  for (const c of children) c.kill();
}

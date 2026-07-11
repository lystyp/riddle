import "./style.css";
import { createProvider } from "./llm";
import { Oracle, parseOracleEnv } from "./oracle";
import { TomView } from "./tom-view";

// The dev-harness chrome, mirroring boox-spike's MainActivity: a Write
// button cycling canned texts (exercise the animation without an oracle
// call), Clear, and the oracle settings. Mode/Pace/Pen are gone — they
// exist to probe e-ink waveforms, and a browser has none.

const texts = [
  "Hello. I am Tom Riddle. How curious that you should find my diary.",
  "I have been waiting for someone new to write to me. Tell me your secrets.",
  "The Chamber of Secrets has been opened. Do you know what sleeps within?",
];
let textI = 0;

// Same oracle.env text the tablet flavours use, kept in localStorage.
const ENV_STORAGE_KEY = "riddle-web.oracle.env";

/**
 * The env file is the source of truth: web/public/oracle.env (gitignored,
 * served at /oracle.env in dev) is fetched on every load and, when usable,
 * becomes the active config — no page interaction needed, and a stale
 * dialog-saved config never shadows it. localStorage backs the Oracle…
 * dialog and is the fallback only when no file is served (e.g. a production
 * build, where oracle.env isn't deployed). A dialog edit lasts the session;
 * the file wins again on the next reload.
 */
async function loadEnvFromFile(): Promise<void> {
  try {
    const resp = await fetch("/oracle.env");
    if (!resp.ok) return;
    const text = await resp.text();
    if (parseOracleEnv(text) === null) return; // placeholder or HTML 404 page
    localStorage.setItem(ENV_STORAGE_KEY, text);
    console.info("oracle config loaded from /oracle.env");
  } catch {
    // no file — fall back to whatever the dialog saved in localStorage
  }
}

const canvas = document.querySelector<HTMLCanvasElement>("#page")!;
const status = document.querySelector<HTMLSpanElement>("#status")!;
const dialog = document.querySelector<HTMLDialogElement>("#oracle-dialog")!;
const envInput = document.querySelector<HTMLTextAreaElement>("#oracle-env")!;

const tom = new TomView(canvas);
tom.onStatus = (s) => {
  status.textContent = s;
};

function applyOracleConfig() {
  const cfg = parseOracleEnv(localStorage.getItem(ENV_STORAGE_KEY) ?? "");
  tom.oracle = cfg ? new Oracle(createProvider(cfg.provider, cfg), cfg) : null;
  status.textContent = cfg
    ? `oracle ready (${cfg.model}) — 直接寫、直接畫，停筆等回應；字會淡去、畫會留下`
    : "oracle 未設定 — 按 Oracle… 貼上 oracle.env 內容";
}

document.querySelector("#write")!.addEventListener("click", () => {
  tom.write(texts[textI % texts.length]);
  textI++;
});

document.querySelector("#clear")!.addEventListener("click", () => {
  tom.clearPage();
});

document.querySelector("#oracle")!.addEventListener("click", () => {
  envInput.value = localStorage.getItem(ENV_STORAGE_KEY) ?? "";
  dialog.showModal();
});

dialog.addEventListener("close", () => {
  if (dialog.returnValue !== "save") return;
  localStorage.setItem(ENV_STORAGE_KEY, envInput.value);
  applyOracleConfig();
});

// Rasterization needs the real TTFs, not the fallback the canvas would
// silently substitute — block the oracle wiring (not the pen) on them.
const boot = async () => {
  await loadEnvFromFile();
  applyOracleConfig();
};
Promise.all([
  document.fonts.load("96px Caveat", "Tom"),
  document.fonts.load('96px "LXGW WenKai TC"', "謎"),
]).then(boot, () => {
  status.textContent = "字型載入失敗 — 回寫會用系統字型";
  void boot();
});

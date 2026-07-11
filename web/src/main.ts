import "./style.css";
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
  tom.oracle = cfg ? new Oracle(cfg) : null;
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
Promise.all([
  document.fonts.load("96px Caveat", "Tom"),
  document.fonts.load('96px "LXGW WenKai TC"', "謎"),
]).then(applyOracleConfig, () => {
  status.textContent = "字型載入失敗 — 回寫會用系統字型";
  applyOracleConfig();
});

# riddle web — 瀏覽器分頁裡的日記（開發迭代用）

boox-spike 的網頁 port：同一套「寫／畫 → 快照（含量測格線）並行送兩路 LLM →
DSL 回覆逐 block 寫回 → 字淡去、畫留下」迴圈，跑在 `<canvas>` 上。改 code
存檔即生效（vite HMR / F5），不用重裝 APK。

頁面是「墨水層 + 回話 overlay」：使用者的字與畫、oracle 的藍色筆畫都在墨水層
累積；偵測 LLM 框出「說給同伴聽的話」後只溶框內黑墨（`3×5=` 這種頁面內容
不會被吃）；oracle 的 TEXT 回話寫在專屬 overlay，寫完 3.5s 自動溶解。
STROKE 是稀疏錨點，經 centripetal Catmull-Rom 過點 spline densify 成手寫
節奏（尖點錨點加倍才不會被抹圓 — V7 筆法）。

這不是產品的 web 版，是開發 harness——測得到跟測不到的東西要分清楚：

| 測得到（平常改的大多在這） | 測不到（還是得上機） |
|---|---|
| oracle round-trip、prompt、逐 block 串流、區域偵測 | e-ink 刷新（Mode / Pace / 殘影 / 波形） |
| CJK 換行、layout 數學、thin/trace、spline densify | RawPen（Onyx TouchHelper 硬體路徑） |
| 格線快照、濾色溶解視覺、狀態機轉換 | EpdController 行為、真實筆延遲 |

## 跑起來

```sh
npm install
npm run dev        # http://localhost:5173
```

按 **Oracle…** 貼上 oracle.env 的內容（同 riddle / boox 的變數名，存在
localStorage）。瀏覽器直連 API，base 端點要允許 CORS——api.openai.com 可以；
自架端點接不通就得開個 proxy。

沒有 key 也能跑整條迴圈：

```sh
npm run mock       # 假 oracle：SSE 逐字回一句 Tom 的話（port 8797）
```

然後在 **Oracle…** 貼：

```
RIDDLE_OPENAI_KEY=mock
RIDDLE_OPENAI_BASE=http://localhost:8797/v1
```

## 操作

| 做什麼 | 結果 |
|------|------|
| 用滑鼠 / 手寫筆在頁面上寫、畫 | 上墨到墨水層（筆有壓力就吃壓力，滑鼠固定 0.5） |
| 停筆 2.8s | 快照並行送兩路：回覆 LLM 逐 block 寫回；偵測 LLM 框出對話字句，框內黑墨淡去 |
| **Write** | 不經 oracle 直接寫一段預設文字（循環三段，測動畫用） |
| 停留階段點頁面 | 跳過等待，回話直接溶解（畫不受影響） |
| **Clear** | 清頁 + 清 oracle 的對話記憶（新 session） |

## 測試

```sh
npm test           # vitest：ScriptTest / OracleTest 的性質測試 port
npm run smoke      # headless Chrome 全迴圈 E2E（畫→喝→回寫→溶解；需要 Google Chrome）
```

## 與 boox-spike 本尊的已知差異

- 沒有 `Epd` / `RawPen`——瀏覽器每次繪圖自己合成畫面，餵 EpdController 的
  dirty-rect 簿記整段消失；Mode / Pace / Pen / Hide 按鈕（e-ink 波形實驗的
  介面）也跟著不存在。
- 字型單一來源：`@font-face` 直接引用 `../boox-spike/app/src/main/assets`
  的同一份 TTF（vite `fs.allow`），不複製 15MB 的字型檔。CJK 回覆在這裡
  fallback 到 LXGW WenKai TC；Boox 上是系統字型。
- `getCoalescedEvents` 對應 `MotionEvent` 的 historical batch——注意它**含**
  當前樣本，不像 Android 要另外補畫一筆。
- oracle 設定存 localStorage（web 沒有 adb push 這回事），格式沿用 oracle.env。

## 檔案對照

| 這裡 | boox-spike | riddle 本尊 |
|------|-----------|-------------|
| `src/script.ts` | `Script.kt` | `script.rs`（thin/trace）+ `ink.rs`（pxHash） |
| `src/reply-dsl.ts` | `ReplyDsl.kt` | —（DSL parser + Catmull-Rom densify） |
| `src/oracle.ts` | `Oracle.kt` | `oracle.rs`（HttpOracle；外加 session 記憶與區域偵測） |
| `src/tom-view.ts` | `TomView.kt` | `main.rs` 的 plan_reply / Replying / Lingering / FadingReply |
| `src/main.ts` | `MainActivity.kt` | — |
| `test/script.test.ts` | `ScriptTest.kt` | — |
| `test/reply-dsl.test.ts` | `ReplyDslTest.kt` | — |
| `test/oracle.test.ts` | `OracleTest.kt` | — |
| `mock-oracle.mjs` / `e2e-smoke.mjs` | — | —（離線假端點：串流 DSL 回覆 + 偵測 BOX（`MOCK_BOXES` 可覆寫）；全迴圈煙霧測試） |

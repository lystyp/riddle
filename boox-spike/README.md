# riddle boox-spike — 回寫動畫可行性驗證

一個最小 Android app，回答 riddle 移植 Boox 的唯一生死題：
**Tom 逐筆回寫的手寫動畫，在 Boox 的 partial refresh 下夠不夠流暢？**

這不是移植版 riddle——沒有筆輸入、沒有 oracle、沒有記憶。只有動畫引擎，
但那條管線是真的：`script.rs` 的 Zhang-Suen 細線化 + stroke tracing 逐行移植成
Kotlin（`Script.kt`），用同一個 DancingScript.ttf，動畫常數照抄 `main.rs`
（14ms tick / 26 點、筆徑 2、96px 行高 ×1.25、±3px 行抖動、寫完停 4s+2ms/點、
10 段 × 80ms 溶解、結尾 GC 全刷）。你在 Boox 上看到的就是 Tom 真正的筆跡。

## 安裝

```sh
# USB 接上 Boox（開啟 USB 偵錯：設定 → 關於 → 連點 build number → 開發者選項）
~/Library/Android/sdk/platform-tools/adb install app/build/outputs/apk/debug/app-debug.apk
```

或把 `app-debug.apk` 丟進裝置儲存空間，用 Boox 檔案管理員點開安裝
（需允許未知來源）。

> 測試前：長按 app icon → E-ink 設定（不同機種名稱不同），把該 app 的
> 刷新模式設成「一般 / HD」，關掉系統級的極速模式——讓 app 自己控制刷新，
> 否則系統設定會蓋過 EpdController 的指定。

## 操作

| 按鈕 | 作用 |
|------|------|
| **Write** | 逐筆寫出一段 Tom 的話（循環三段預設文字；寫完等待後自動溶解） |
| **Mode** | 循環刷新波形：`DU` → `ANIM` → `GU` → `REGAL` → `PLAIN`（無 Onyx 呼叫的基準線） |
| **Pace** | 循環節奏：`14ms×26`（riddle 原生）→ `33ms×62` → `66ms×124`（同樣墨水速率、較粗批次） |
| **Clear** | 清頁 + GC 全刷 |
| 點頁面 | 停留階段直接跳到溶解 |

狀態列會顯示每次寫入的統計（點數 / 耗時 / late tick 數）；詳細 log 在
`adb logcat -s riddle-spike`（EpdController 呼叫失敗會記在這裡）。

## 怎麼判讀

依序測 **Mode × Pace**（先 DU×14ms，再 DU×33ms、ANIM×14ms……），看四件事：

1. **墨水流動感** — 筆跡是連續長出來的，還是一塊一塊蹦出來？
2. **視覺延遲** — 墨水落後「筆尖」多遠？（riddle 在 rM 上幾乎是零）
3. **殘影** — 溶解後、GC 全刷前，頁面髒不髒？累積幾輪後可接受嗎？
4. **溶解效果** — 「日記喝墨水」的漸散感還在不在？

**通過**：某個組合看起來「像手在寫字」→ 移植可行，照該組合定 Boox 版的
顯示參數。
**死刑**：所有組合都是塊狀蹦字或延遲 >300ms → Boox 的 view-invalidate 路徑
撐不起這個 app 的靈魂，得改研究 TouchHelper 級的底層路徑或放棄。

`PLAIN` 模式同時是非 Boox 裝置的 fallback（EpdController 呼叫全部 runtime
守護），所以這顆 APK 裝在任何 Android 平板上都能跑，只是沒有波形控制。

## 與 riddle 本尊的已知差異

- 光柵化用 `Canvas.drawText`（同字型、alpha>127 門檻）取代 ab_glyph 的
  coverage>0.5——字形位元圖可能差幾個像素，細線化後肉眼無異。
- 所有長度按 `螢幕寬/1620` 縮放（rM Paper Pro 基準），每 tick 點數同步縮放，
  維持相同的「每秒字數」。
- 單元測試（`ScriptTest`）驗證了移植的 thin/trace 與 Rust 版相同的性質：
  細線化收斂、筆劃連續（8-鄰接）、覆蓋骨架、溶解單調完備。

## 檔案對照

| 這裡 | riddle 本尊 |
|------|-------------|
| `Script.kt` | `riddle/src/script.rs`（thin/trace）+ `ink.rs`（pxHash） |
| `TomView.kt` | `main.rs` 的 `plan_reply` / `State::Replying` / `Lingering` / `FadingReply` |
| `Epd.kt` | `quill/`（角色相當：把像素送進 e-ink 引擎） |

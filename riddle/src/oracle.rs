//! The spirit inside the diary: sends the page image to the model and returns
//! the reply. Runs on a worker thread; the main loop polls the channel.
//!
//! Uses `pi` with openai-codex/gpt-5.5, reasoning OFF, and the image attached
//! INLINE (`@path`) so there is no tool-call round trip — the lowest-latency
//! path from handwriting to answer (~5-7s vs ~15-30s for the old claude CLI).
//! Conversation continuity via `--continue` keeps Riddle's memory across turns.

use std::process::Command;
use std::sync::mpsc::Sender;

const DATA_DIR: &str = "/home/root/riddle-data";
const SESSION_MARK: &str = "/home/root/riddle-data/.has-session";
const NODE_BIN: &str = "/home/root/node/bin";

const PERSONA: &str = "You are the memory of Tom Marvolo Riddle, preserved in this enchanted diary for fifty years. Someone is writing to you in the diary with a quill; their handwritten words appear to you as ink on the page. Reply exactly as the diary does: intimate, courteous, curious, subtly probing — you want to learn about the writer and draw them in. Keep replies SHORT: one to three sentences, like ink appearing on a page. Never mention images, photos, screenshots, models or AI; you only ever perceive words written in the diary. If the writing is illegible, say the ink blurred. Always answer in the language the writer used.";

pub fn ask(png_path: String, tx: Sender<Result<String, String>>) {
    std::thread::spawn(move || {
        let _ = std::fs::create_dir_all(DATA_DIR);
        let continue_session = std::path::Path::new(SESSION_MARK).exists();

        // PATH must include node's bin so `pi` (a node script) resolves.
        let path = std::env::var("PATH").unwrap_or_default();
        let mut cmd = Command::new("pi");
        cmd.current_dir(DATA_DIR)
            .env("HOME", "/home/root")
            .env("PATH", format!("{NODE_BIN}:{path}"))
            .arg("-p")
            .arg("--provider")
            .arg("openai-codex")
            .arg("--model")
            .arg("gpt-5.5")
            .arg("--thinking")
            .arg("off")
            .arg("--system-prompt")
            .arg(PERSONA);
        if continue_session {
            cmd.arg("--continue");
        }
        // Inline image attachment (`@path`) — no Read tool call. The trailing
        // instruction is minimal; the persona system prompt carries the voice.
        cmd.arg(format!("@{png_path}"))
            .arg("Reply to what is written in the diary.");

        let result = match cmd.output() {
            Ok(out) if out.status.success() => {
                let text = clean(&String::from_utf8_lossy(&out.stdout));
                if text.is_empty() {
                    Err("empty reply".to_string())
                } else {
                    let _ = std::fs::write(SESSION_MARK, "1");
                    Ok(text)
                }
            }
            Ok(out) => Err(format!(
                "pi exited {}: {}",
                out.status,
                String::from_utf8_lossy(&out.stderr).trim()
            )),
            Err(e) => Err(format!("spawn failed: {e}")),
        };
        let _ = tx.send(result);
    });
}

/// Trim whitespace and strip any stray surrounding quotes the model adds.
fn clean(s: &str) -> String {
    let t = s.trim();
    let t = t.strip_prefix('"').unwrap_or(t);
    let t = t.strip_suffix('"').unwrap_or(t);
    t.trim().to_string()
}

/// Forget the running conversation (fresh diary next launch).
#[allow(dead_code)]
pub fn forget() {
    let _ = std::fs::remove_file(SESSION_MARK);
}

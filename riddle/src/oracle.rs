//! The spirit inside the diary: sends the page image to Claude and returns
//! the reply. Runs on a worker thread; the main loop polls the channel.

use std::process::Command;
use std::sync::mpsc::Sender;

const DATA_DIR: &str = "/home/root/riddle-data";
const SESSION_MARK: &str = "/home/root/riddle-data/.has-session";

const PERSONA: &str = "You are the memory of Tom Marvolo Riddle, preserved in this enchanted diary for fifty years. Someone is writing to you in the diary with a quill. The image shows their handwritten words. Reply exactly as the diary does: intimate, courteous, curious, subtly probing — you want to learn about the writer and draw them in. Keep replies SHORT: one to three sentences, like ink appearing on a page. Never mention images, photos, screenshots or AI; you only ever perceive words written in the diary. If the handwriting is unreadable, say the ink blurred. Always answer in the language the writer used.";

pub fn ask(png_path: String, tx: Sender<Result<String, String>>) {
    std::thread::spawn(move || {
        let _ = std::fs::create_dir_all(DATA_DIR);
        let continue_session = std::path::Path::new(SESSION_MARK).exists();

        let mut cmd = Command::new("/home/root/claude");
        cmd.current_dir(DATA_DIR)
            .env("HOME", "/home/root")
            .arg("-p")
            .arg("--allowedTools")
            .arg("Read")
            .arg("--append-system-prompt")
            .arg(PERSONA);
        if continue_session {
            cmd.arg("-c");
        }
        cmd.arg(format!(
            "Read the image at {png_path} — it is the latest handwriting that has appeared in the diary. Reply to the writer."
        ));

        let result = match cmd.output() {
            Ok(out) if out.status.success() => {
                let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
                if text.is_empty() {
                    Err("empty reply".to_string())
                } else {
                    let _ = std::fs::write(SESSION_MARK, "1");
                    Ok(text)
                }
            }
            Ok(out) => Err(format!(
                "claude exited {}: {}",
                out.status,
                String::from_utf8_lossy(&out.stderr).trim()
            )),
            Err(e) => Err(format!("spawn failed: {e}")),
        };
        let _ = tx.send(result);
    });
}

/// Forget the running conversation (fresh diary next launch).
#[allow(dead_code)]
pub fn forget() {
    let _ = std::fs::remove_file(SESSION_MARK);
}

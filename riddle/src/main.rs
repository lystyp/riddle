//! riddle — the diary of Tom Riddle, for the reMarkable Paper Pro.
//!
//! Write on the page with the pen. After a pause the diary drinks your ink,
//! and an answer writes itself onto the page in a flowing hand, then fades.

mod fb;
mod ink;
mod oracle;
mod qtfb;
mod script;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::Arc;
use std::time::{Duration, Instant};

use ab_glyph::FontRef;

use fb::{BBox, SCREEN_H, SCREEN_W};

const FONT_TTF: &[u8] = include_bytes!("../fonts/DancingScript.ttf");
const PNG_PATH: &str = "/tmp/riddle-page.png";

const IDLE_COMMIT: Duration = Duration::from_millis(2800);
const REPLY_PX: f32 = 96.0;
const MARGIN_X: i32 = 120;

enum State {
    /// Blank page; pen writes ink. Instant holds the last pen activity.
    Listening { last_pen: Option<Instant> },
    /// Ink dissolve animation, then send to the oracle.
    Drinking { stage: u32, next: Instant, region: BBox },
    /// Waiting for the oracle; pulse a small blot.
    Thinking { rx: mpsc::Receiver<Result<String, String>>, pulse: Instant, blot_on: bool },
    /// Writing the reply stroke by stroke.
    Replying { plan: WritePlan, next: Instant },
    /// Reply on page; wait, then dissolve it.
    Lingering { until: Instant, region: BBox },
    FadingReply { stage: u32, next: Instant, region: BBox },
}

/// Precomputed reply strokes in screen coordinates.
struct WritePlan {
    /// Each stroke is a polyline of screen points.
    strokes: Vec<Vec<(i32, i32)>>,
    stroke_i: usize,
    point_i: usize,
    region: BBox,
}

fn main() {
    if let Err(e) = run() {
        eprintln!("riddle: fatal: {e}");
        std::process::exit(1);
    }
}

fn run() -> std::io::Result<()> {
    let key: i32 = std::env::var("QTFB_KEY")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or_else(|| {
            eprintln!("riddle: QTFB_KEY not set (launch via AppLoad)");
            std::process::exit(2);
        });

    let font = FontRef::try_from_slice(FONT_TTF).map_err(std::io::Error::other)?;

    let mut client = qtfb::QtfbClient::connect(key, qtfb::FBFMT_RMPP_RGB565, SCREEN_W, SCREEN_H, 2)?;
    // FAST waveform: pen ink needs the low-latency path (1s server stall, once).
    let _ = client.set_refresh_mode(qtfb::REFRESH_MODE_FAST);

    let sigterm = Arc::new(AtomicBool::new(false));
    signal_hook::flag::register(signal_hook::consts::SIGTERM, Arc::clone(&sigterm))?;
    signal_hook::flag::register(signal_hook::consts::SIGINT, Arc::clone(&sigterm))?;

    // Blank page.
    fb::fill_rect(client.framebuffer(), 0, 0, SCREEN_W, SCREEN_H, fb::WHITE);
    client.update_all()?;

    let mut user_ink = ink::Ink::new();
    let mut state = State::Listening { last_pen: None };
    let mut pen_down = false;

    eprintln!("riddle: the diary is open (key {key})");

    loop {
        if sigterm.load(Ordering::Relaxed) {
            break;
        }

        // ---- input ----
        let events = match client.drain_events() {
            Ok(v) => v,
            Err(_) => break, // window closed
        };
        for ev in events {
            match ev.input_type {
                qtfb::INPUT_PEN_PRESS | qtfb::INPUT_PEN_UPDATE => {
                    // The pen only writes while the diary listens.
                    if let State::Listening { ref mut last_pen } = state {
                        pen_down = true;
                        let fbuf = client.framebuffer();
                        if let Some((x, y, w, h)) = user_ink.pen_point(fbuf, ev.x, ev.y, ev.d) {
                            let _ = client.update_partial(x, y, w, h);
                        }
                        *last_pen = Some(Instant::now());
                    } else if let State::Lingering { ref region, .. } = state {
                        // Writing again interrupts the linger: swallow the
                        // reply quickly so the page is theirs.
                        let region = *region;
                        state = State::FadingReply { stage: 0, next: Instant::now(), region };
                    }
                }
                qtfb::INPUT_PEN_RELEASE => {
                    if pen_down {
                        pen_down = false;
                        user_ink.pen_up();
                        if let State::Listening { ref mut last_pen } = state {
                            *last_pen = Some(Instant::now());
                        }
                    }
                }
                _ => {} // touch ignored: the diary knows a hand from a quill
            }
        }

        // ---- state machine ----
        state = match state {
            State::Listening { last_pen } => {
                match last_pen {
                    Some(t)
                        if !pen_down
                            && t.elapsed() >= IDLE_COMMIT
                            && !user_ink.is_empty() =>
                    {
                        // Snapshot the page for the oracle BEFORE dissolving.
                        if let Err(e) = user_ink.to_png(client.framebuffer(), PNG_PATH) {
                            eprintln!("riddle: rasterize failed: {e}");
                        }
                        let region = user_ink.bbox;
                        State::Drinking { stage: 0, next: Instant::now(), region }
                    }
                    _ => State::Listening { last_pen },
                }
            }

            State::Drinking { stage, next, region } => {
                const STAGES: u32 = 7;
                if Instant::now() >= next {
                    let fbuf = client.framebuffer();
                    ink::dissolve_pass(fbuf, region, stage, STAGES);
                    let (x, y, w, h) = region.rect();
                    let _ = client.update_partial(x, y, w, h);
                    if stage + 1 >= STAGES {
                        user_ink.clear();
                        let (tx, rx) = mpsc::channel();
                        oracle::ask(PNG_PATH.to_string(), tx);
                        State::Thinking { rx, pulse: Instant::now(), blot_on: false }
                    } else {
                        State::Drinking { stage: stage + 1, next: Instant::now() + Duration::from_millis(160), region }
                    }
                } else {
                    State::Drinking { stage, next, region }
                }
            }

            State::Thinking { rx, pulse, blot_on } => {
                match rx.try_recv() {
                    Ok(result) => {
                        // Clear the blot.
                        let fbuf = client.framebuffer();
                        fb::fill_rect(fbuf, SCREEN_W / 2 - 14, SCREEN_H / 2 - 14, 28, 28, fb::WHITE);
                        let _ = client.update_partial(SCREEN_W as i32 / 2 - 14, SCREEN_H as i32 / 2 - 14, 28, 28);
                        let text = match result {
                            Ok(t) => t,
                            Err(e) => {
                                eprintln!("riddle: oracle failed: {e}");
                                "…".to_string()
                            }
                        };
                        let plan = plan_reply(&font, &text);
                        State::Replying { plan, next: Instant::now() }
                    }
                    Err(mpsc::TryRecvError::Empty) => {
                        // Pulse a small ink blot mid-page: the diary breathing.
                        if pulse.elapsed() >= Duration::from_millis(600) {
                            let fbuf = client.framebuffer();
                            let (cx, cy) = (SCREEN_W as i32 / 2, SCREEN_H as i32 / 2);
                            if blot_on {
                                fb::fill_rect(fbuf, cx as usize - 14, cy as usize - 14, 28, 28, fb::WHITE);
                            } else {
                                fb::stamp(fbuf, cx, cy, 9, fb::BLACK);
                            }
                            let _ = client.update_partial(cx - 14, cy - 14, 28, 28);
                            State::Thinking { rx, pulse: Instant::now(), blot_on: !blot_on }
                        } else {
                            State::Thinking { rx, pulse, blot_on }
                        }
                    }
                    Err(mpsc::TryRecvError::Disconnected) => {
                        State::Listening { last_pen: None }
                    }
                }
            }

            State::Replying { mut plan, next } => {
                if Instant::now() >= next {
                    // Draw a burst of skeleton points (the hand moves quickly).
                    let fbuf = client.framebuffer();
                    let mut dirty = BBox::empty();
                    let mut budget = 26; // points per frame
                    while budget > 0 && plan.stroke_i < plan.strokes.len() {
                        let stroke = &plan.strokes[plan.stroke_i];
                        if plan.point_i >= stroke.len() {
                            plan.stroke_i += 1;
                            plan.point_i = 0;
                            continue;
                        }
                        let (x, y) = stroke[plan.point_i];
                        if plan.point_i > 0 {
                            let (px, py) = stroke[plan.point_i - 1];
                            fb::brush_line(fbuf, px, py, x, y, 2, fb::BLACK);
                        } else {
                            fb::stamp(fbuf, x, y, 2, fb::BLACK);
                        }
                        dirty.add(x, y, 4);
                        plan.point_i += 1;
                        budget -= 1;
                    }
                    if !dirty.is_empty() {
                        let (x, y, w, h) = dirty.rect();
                        let _ = client.update_partial(x, y, w, h);
                    }
                    if plan.stroke_i >= plan.strokes.len() {
                        // Done writing: linger proportional to length.
                        let chars: usize = plan.strokes.iter().map(|s| s.len()).sum();
                        let linger = Duration::from_millis(4000 + (chars as u64) * 2);
                        let region = plan.region;
                        State::Lingering { until: Instant::now() + linger.min(Duration::from_secs(20)), region }
                    } else {
                        State::Replying { plan, next: Instant::now() + Duration::from_millis(14) }
                    }
                } else {
                    State::Replying { plan, next }
                }
            }

            State::Lingering { until, region } => {
                if Instant::now() >= until {
                    State::FadingReply { stage: 0, next: Instant::now(), region }
                } else {
                    State::Lingering { until, region }
                }
            }

            State::FadingReply { stage, next, region } => {
                const STAGES: u32 = 5;
                if Instant::now() >= next {
                    let fbuf = client.framebuffer();
                    ink::dissolve_pass(fbuf, region, stage, STAGES);
                    let (x, y, w, h) = region.rect();
                    let _ = client.update_partial(x, y, w, h);
                    if stage + 1 >= STAGES {
                        // Clean the ghosts once the page is blank again.
                        let _ = client.request_full_refresh();
                        State::Listening { last_pen: None }
                    } else {
                        State::FadingReply { stage: stage + 1, next: Instant::now() + Duration::from_millis(140), region }
                    }
                } else {
                    State::FadingReply { stage, next, region }
                }
            }
        };

        std::thread::sleep(Duration::from_millis(4));
    }

    eprintln!("riddle: the diary closes");
    client.terminate();
    Ok(())
}

/// Lay out the reply text and produce screen-space strokes.
fn plan_reply(font: &FontRef, text: &str) -> WritePlan {
    let max_w = (SCREEN_W as i32 - 2 * MARGIN_X) as f32;
    let lines = script::wrap(font, text, REPLY_PX, max_w);
    let line_h = (REPLY_PX * 1.25) as i32;
    let total_h = line_h * lines.len() as i32;
    // Centered block, upper-middle of the page like the film.
    let mut y = ((SCREEN_H as i32 - total_h) / 3).max(60);
    let mut strokes = Vec::new();
    let mut region = BBox::empty();
    let mut seed = 0x1234u32;
    let mut jitter = move || {
        seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
        ((seed >> 16) % 7) as i32 - 3
    };

    for line_text in &lines {
        let mut raster = script::rasterize_line(font, line_text, REPLY_PX);
        script::thin(&mut raster);
        let line_strokes = script::trace(&raster);
        let x0 = (SCREEN_W as i32 - raster.width as i32) / 2;
        let wobble = jitter();
        for s in line_strokes {
            let mapped: Vec<(i32, i32)> = s
                .iter()
                .map(|&(sx, sy)| (x0 + sx, y + sy + wobble))
                .collect();
            for &(x, yy) in &mapped {
                region.add(x, yy, 5);
            }
            strokes.push(mapped);
        }
        y += line_h;
    }

    WritePlan { strokes, stroke_i: 0, point_i: 0, region }
}

//! User ink: capture pen strokes, render them, dissolve them, rasterize them
//! for the oracle.

use crate::fb::{self, BBox, SCREEN_H, SCREEN_W};

pub struct Ink {
    /// Finished strokes as point lists (x, y, radius).
    strokes: Vec<Vec<(i32, i32, i32)>>,
    current: Vec<(i32, i32, i32)>,
    pub bbox: BBox,
}

impl Ink {
    pub fn new() -> Self {
        Self { strokes: Vec::new(), current: Vec::new(), bbox: BBox::empty() }
    }

    pub fn is_empty(&self) -> bool {
        self.strokes.is_empty() && self.current.is_empty()
    }

    pub fn clear(&mut self) {
        self.strokes.clear();
        self.current.clear();
        self.bbox = BBox::empty();
    }

    /// Pen touched down or moved while down. `pressure` is qtfb's 0..100.
    /// Returns the dirty rect of what was drawn.
    pub fn pen_point(&mut self, fb_buf: &mut [u8], x: i32, y: i32, pressure: i32) -> Option<(i32, i32, i32, i32)> {
        let r = 2 + (pressure.clamp(0, 100)) / 45; // 2..4 px quill width
        let mut dirty = BBox::empty();
        if let Some(&(px, py, pr)) = self.current.last() {
            fb::brush_line(fb_buf, px, py, x, y, r.min(pr + 1), fb::BLACK);
            dirty.add(px, py, pr + 2);
        } else {
            fb::stamp(fb_buf, x, y, r, fb::BLACK);
        }
        dirty.add(x, y, r + 2);
        self.current.push((x, y, r));
        self.bbox.add(x, y, r + 2);
        Some(dirty.rect())
    }

    pub fn pen_up(&mut self) {
        if !self.current.is_empty() {
            self.strokes.push(std::mem::take(&mut self.current));
        }
    }

    /// Rasterize the ink region to a grayscale PNG for the oracle.
    /// Downscales 2x to keep the image small.
    pub fn to_png(&self, fb_buf: &[u8], path: &str) -> std::io::Result<()> {
        if self.bbox.is_empty() {
            return Err(std::io::Error::other("no ink"));
        }
        let (bx, by, bw, bh) = self.bbox.rect();
        // Pad the crop a little for context.
        let x0 = (bx - 20).max(0) as usize;
        let y0 = (by - 20).max(0) as usize;
        let x1 = ((bx + bw + 20) as usize).min(SCREEN_W);
        let y1 = ((by + bh + 20) as usize).min(SCREEN_H);
        let (w, h) = ((x1 - x0) / 2, (y1 - y0) / 2);

        let mut gray = vec![0u8; w * h];
        for oy in 0..h {
            for ox in 0..w {
                // 2x2 box average, extracting luminance from RGB565's green.
                let mut acc = 0u32;
                for sy in 0..2 {
                    for sx in 0..2 {
                        let px = fb::get_px(fb_buf, (x0 + ox * 2 + sx) as i32, (y0 + oy * 2 + sy) as i32);
                        acc += (((px >> 5) & 0x3f) as u32) * 255 / 63;
                    }
                }
                gray[oy * w + ox] = (acc / 4) as u8;
            }
        }

        let file = std::fs::File::create(path)?;
        let mut enc = png::Encoder::new(std::io::BufWriter::new(file), w as u32, h as u32);
        enc.set_color(png::ColorType::Grayscale);
        enc.set_depth(png::BitDepth::Eight);
        let mut writer = enc.write_header().map_err(std::io::Error::other)?;
        writer
            .write_image_data(&gray)
            .map_err(std::io::Error::other)?;
        Ok(())
    }
}

/// Deterministic per-pixel hash for the dissolve pattern.
#[inline]
fn px_hash(x: i32, y: i32) -> u32 {
    let mut h = (x as u32).wrapping_mul(0x9E3779B1) ^ (y as u32).wrapping_mul(0x85EBCA6B);
    h ^= h >> 13;
    h = h.wrapping_mul(0xC2B2AE35);
    h ^ (h >> 16)
}

/// One pass of the "diary drinks the ink" effect: erase the pixels whose hash
/// falls in this stage. After `stages` passes the region is clean white.
pub fn dissolve_pass(fb_buf: &mut [u8], region: BBox, stage: u32, stages: u32) {
    if region.is_empty() {
        return;
    }
    for y in region.y0..=region.y1 {
        for x in region.x0..=region.x1 {
            if fb::get_px(fb_buf, x, y) != fb::WHITE && px_hash(x, y) % stages <= stage {
                fb::put_px(fb_buf, x, y, fb::WHITE);
            }
        }
    }
}

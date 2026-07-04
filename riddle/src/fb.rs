//! RGB565 framebuffer drawing helpers for the diary page.

pub const SCREEN_W: usize = 1620;
pub const SCREEN_H: usize = 2160;

pub const WHITE: u16 = 0xFFFF;
pub const BLACK: u16 = 0x0000;

#[inline]
pub fn put_px(fb: &mut [u8], x: i32, y: i32, c: u16) {
    if x < 0 || y < 0 || x >= SCREEN_W as i32 || y >= SCREEN_H as i32 {
        return;
    }
    let i = (y as usize * SCREEN_W + x as usize) * 2;
    fb[i] = (c & 0xff) as u8;
    fb[i + 1] = (c >> 8) as u8;
}

#[inline]
pub fn get_px(fb: &[u8], x: i32, y: i32) -> u16 {
    if x < 0 || y < 0 || x >= SCREEN_W as i32 || y >= SCREEN_H as i32 {
        return WHITE;
    }
    let i = (y as usize * SCREEN_W + x as usize) * 2;
    (fb[i] as u16) | ((fb[i + 1] as u16) << 8)
}

pub fn fill_rect(fb: &mut [u8], x: usize, y: usize, w: usize, h: usize, c: u16) {
    let lo = (c & 0xff) as u8;
    let hi = (c >> 8) as u8;
    for row in y..(y + h).min(SCREEN_H) {
        let start = (row * SCREEN_W + x.min(SCREEN_W)) * 2;
        let end = (row * SCREEN_W + (x + w).min(SCREEN_W)) * 2;
        for px in fb[start..end].chunks_exact_mut(2) {
            px[0] = lo;
            px[1] = hi;
        }
    }
}

/// Stamp a filled disc — the quill brush.
pub fn stamp(fb: &mut [u8], cx: i32, cy: i32, r: i32, c: u16) {
    for dy in -r..=r {
        for dx in -r..=r {
            if dx * dx + dy * dy <= r * r {
                put_px(fb, cx + dx, cy + dy, c);
            }
        }
    }
}

/// Draw a stroke segment by stamping discs along the line.
pub fn brush_line(fb: &mut [u8], x0: i32, y0: i32, x1: i32, y1: i32, r: i32, c: u16) {
    let dx = (x1 - x0).abs();
    let dy = (y1 - y0).abs();
    let steps = dx.max(dy).max(1);
    for i in 0..=steps {
        let x = x0 + (x1 - x0) * i / steps;
        let y = y0 + (y1 - y0) * i / steps;
        stamp(fb, x, y, r, c);
    }
}

/// Grow-only pixel bounding box, used to build update/dissolve regions.
#[derive(Clone, Copy, Debug)]
pub struct BBox {
    pub x0: i32,
    pub y0: i32,
    pub x1: i32,
    pub y1: i32,
}

impl BBox {
    pub fn empty() -> Self {
        Self { x0: i32::MAX, y0: i32::MAX, x1: i32::MIN, y1: i32::MIN }
    }
    pub fn is_empty(&self) -> bool {
        self.x0 > self.x1
    }
    pub fn add(&mut self, x: i32, y: i32, margin: i32) {
        self.x0 = self.x0.min(x - margin).max(0);
        self.y0 = self.y0.min(y - margin).max(0);
        self.x1 = self.x1.max(x + margin).min(SCREEN_W as i32 - 1);
        self.y1 = self.y1.max(y + margin).min(SCREEN_H as i32 - 1);
    }
    pub fn rect(&self) -> (i32, i32, i32, i32) {
        (self.x0, self.y0, self.x1 - self.x0 + 1, self.y1 - self.y0 + 1)
    }
}

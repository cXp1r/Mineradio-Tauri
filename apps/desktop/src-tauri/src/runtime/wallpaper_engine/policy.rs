//! Wallpaper Engine 纯策略。

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PhysicalRect {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

impl PhysicalRect {
    pub fn validated(self) -> Option<Self> {
        ((64..=7_680).contains(&self.width)
            && (64..=4_320).contains(&self.height)
            && (-32_000..=32_000).contains(&self.x)
            && (-32_000..=32_000).contains(&self.y))
        .then_some(self)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum WallpaperFullDesktopMode {
    #[default]
    Disabled,
    Passive,
    Interactive,
}

pub fn rects_aligned(left: PhysicalRect, right: PhysicalRect, tolerance: i32) -> bool {
    let tolerance = tolerance.max(0) as i64;
    let left_right = i64::from(left.x) + i64::from(left.width);
    let right_right = i64::from(right.x) + i64::from(right.width);
    let left_bottom = i64::from(left.y) + i64::from(left.height);
    let right_bottom = i64::from(right.y) + i64::from(right.height);
    (i64::from(left.x) - i64::from(right.x)).abs() <= tolerance
        && (i64::from(left.y) - i64::from(right.y)).abs() <= tolerance
        && (left_right - right_right).abs() <= tolerance
        && (left_bottom - right_bottom).abs() <= tolerance
}

#[cfg(test)]
mod tests {
    use super::{rects_aligned, PhysicalRect};

    #[test]
    fn geometry_accepts_two_pixel_tolerance_but_not_three() {
        let host = PhysicalRect {
            x: -1_920,
            y: 0,
            width: 1_920,
            height: 1_080,
        };
        let within = PhysicalRect { x: -1_918, ..host };
        let outside = PhysicalRect { x: -1_917, ..host };
        assert!(rects_aligned(host, within, 2));
        assert!(!rects_aligned(host, outside, 2));
    }
}

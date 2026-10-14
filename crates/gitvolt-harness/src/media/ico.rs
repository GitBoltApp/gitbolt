//! Windows icons: each image stored as a PNG (what every decoder since Vista reads).

use super::canvas::Canvas;

pub fn ico(images: &[Canvas]) -> Vec<u8> {
    let pngs: Vec<Vec<u8>> = images.iter().map(Canvas::to_png).collect();
    let mut out = vec![0, 0, 1, 0];
    out.extend_from_slice(&(images.len() as u16).to_le_bytes());
    let mut offset = 6 + 16 * images.len() as u32;
    for (c, png) in images.iter().zip(&pngs) {
        assert!(c.w <= 256 && c.h <= 256, "ICO entries are at most 256 px");
        out.extend_from_slice(&[(c.w % 256) as u8, (c.h % 256) as u8, 0, 0]);
        out.extend_from_slice(&1u16.to_le_bytes());
        out.extend_from_slice(&32u16.to_le_bytes());
        out.extend_from_slice(&(png.len() as u32).to_le_bytes());
        out.extend_from_slice(&offset.to_le_bytes());
        offset += png.len() as u32;
    }
    for png in pngs {
        out.extend_from_slice(&png);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::media::palette::GOLD;

    #[test]
    fn ico_holds_each_size() {
        let sizes = [16u32, 32, 48];
        let images: Vec<Canvas> = sizes.iter().map(|&s| { let mut c = Canvas::new(s, s); c.fill_circle(s as f32 / 2.0, s as f32 / 2.0, s as f32 / 3.0, GOLD[3]); c }).collect();
        let ico = ico(&images);
        assert_eq!(&ico[..6], &[0, 0, 1, 0, 3, 0]);
        for (i, s) in sizes.iter().enumerate() {
            assert_eq!(ico[6 + 16 * i] as u32, *s);
        }
        if let Some((format, w, _, _)) = crate::media::check::pillow(&ico, "ico") {
            assert_eq!((format.as_str(), w), ("ICO", 48));
        }
    }

    #[test]
    fn a_256_px_entry_is_stored_as_zero() {
        let ico = ico(&[Canvas::new(256, 256)]);
        assert_eq!((ico[6], ico[7]), (0, 0));
    }
}

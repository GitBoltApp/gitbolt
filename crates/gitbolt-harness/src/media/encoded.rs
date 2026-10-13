//! The four media files ffmpeg encoded once from our own frames and samples
//! (`scripts/gen-fixture-media.sh`).

pub const TRAILER_V1: &[u8] = include_bytes!("../fixture_data/trailer-v1.webm");
pub const TRAILER_V2: &[u8] = include_bytes!("../fixture_data/trailer-v2.webm");
pub const MENU_LOOP: &[u8] = include_bytes!("../fixture_data/menu-loop.ogg");
pub const DOCKING_CHIME: &[u8] = include_bytes!("../fixture_data/docking-chime.opus");

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn files_are_what_their_names_say_and_small() {
        for (name, bytes, magic, limit) in [
            ("trailer v1", TRAILER_V1, &[0x1A, 0x45, 0xDF, 0xA3][..], 200_000),
            ("trailer v2", TRAILER_V2, &[0x1A, 0x45, 0xDF, 0xA3][..], 200_000),
            ("menu loop", MENU_LOOP, &b"OggS"[..], 120_000),
            ("chime", DOCKING_CHIME, &b"OggS"[..], 20_000),
        ] {
            assert!(bytes.starts_with(magic), "{name}");
            assert!(bytes.len() < limit, "{name}: {} bytes", bytes.len());
        }
        assert!(MENU_LOOP.windows(7).any(|w| w == b"\x01vorbis"));
        assert!(DOCKING_CHIME.windows(8).any(|w| w == b"OpusHead"));
        assert_ne!(TRAILER_V1, TRAILER_V2);
    }
}

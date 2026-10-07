//! Random hex strings for ids and the askpass token, read from the OS CSPRNG.

pub fn random_hex(bytes: usize) -> String {
    let mut buf = vec![0u8; bytes];
    crate::platform::random::fill(&mut buf);
    buf.iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
mod tests {
    #[test]
    fn hex_of_requested_length_and_varies() {
        let a = super::random_hex(16);
        assert_eq!(a.len(), 32);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(a, super::random_hex(16));
    }
}

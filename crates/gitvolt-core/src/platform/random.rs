//! The OS's CSPRNG: `/dev/urandom` on Unix, `BCryptGenRandom` (the system-preferred RNG) on
//! Windows.

/// Fills `buf` with random bytes. Panics if the OS has none to give (it always has).
pub fn fill(buf: &mut [u8]) {
    imp::fill(buf);
}

#[cfg(unix)]
mod imp {
    use std::io::Read;

    pub fn fill(buf: &mut [u8]) {
        std::fs::File::open("/dev/urandom").and_then(|mut f| f.read_exact(buf)).expect("read /dev/urandom");
    }
}

#[cfg(windows)]
mod imp {
    use windows_sys::Win32::Security::Cryptography::{BCryptGenRandom, BCRYPT_USE_SYSTEM_PREFERRED_RNG};

    pub fn fill(buf: &mut [u8]) {
        for chunk in buf.chunks_mut(u32::MAX as usize) {
            // SAFETY: the pointer and length describe `chunk`; no algorithm handle with this flag.
            let status = unsafe { BCryptGenRandom(std::ptr::null_mut(), chunk.as_mut_ptr(), chunk.len() as u32, BCRYPT_USE_SYSTEM_PREFERRED_RNG) };
            assert!(status >= 0, "BCryptGenRandom failed: {status:#x}");
        }
    }
}

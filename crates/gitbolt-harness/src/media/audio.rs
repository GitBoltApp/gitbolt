//! Orbital's sound: oscillators, noise, envelopes and a one-pole filter, written as 16-bit mono
//! WAV at 22,050 Hz.

use super::rng::Rng;
use std::f32::consts::TAU;

pub const RATE: u32 = 22_050;

fn len(secs: f32) -> usize {
    (secs * RATE as f32).round() as usize
}

pub fn wav(samples: &[f32]) -> Vec<u8> {
    let data_len = (samples.len() * 2) as u32;
    let mut out = Vec::with_capacity(44 + data_len as usize);
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + data_len).to_le_bytes());
    out.extend_from_slice(b"WAVEfmt ");
    out.extend_from_slice(&16u32.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&RATE.to_le_bytes());
    out.extend_from_slice(&(RATE * 2).to_le_bytes());
    out.extend_from_slice(&2u16.to_le_bytes());
    out.extend_from_slice(&16u16.to_le_bytes());
    out.extend_from_slice(b"data");
    out.extend_from_slice(&data_len.to_le_bytes());
    for s in samples {
        out.extend_from_slice(&((s.clamp(-1.0, 1.0) * 32_767.0) as i16).to_le_bytes());
    }
    out
}

/// One pole: y += a·(x − y).
struct LowPass {
    a: f32,
    y: f32,
}

impl LowPass {
    fn new(cutoff: f32) -> LowPass {
        let mut f = LowPass { a: 0.0, y: 0.0 };
        f.set(cutoff);
        f
    }
    fn set(&mut self, cutoff: f32) {
        self.a = 1.0 - (-TAU * cutoff / RATE as f32).exp();
    }
    fn run(&mut self, x: f32) -> f32 {
        self.y += self.a * (x - self.y);
        self.y
    }
}

fn frac(p: f32) -> f32 {
    p - p.floor()
}
fn saw(p: f32) -> f32 {
    2.0 * frac(p) - 1.0
}
fn square(p: f32, duty: f32) -> f32 {
    if frac(p) < duty { 1.0 } else { -1.0 }
}
fn tri(p: f32) -> f32 {
    4.0 * (frac(p) - 0.5).abs() - 1.0
}
fn midi(note: i32) -> f32 {
    440.0 * 2f32.powf((note - 69) as f32 / 12.0)
}

fn normalise(mut s: Vec<f32>, peak: f32) -> Vec<f32> {
    let m = s.iter().fold(0f32, |m, v| m.max(v.abs()));
    if m > 0.0 {
        for v in &mut s {
            *v *= peak / m;
        }
    }
    s
}

/// Linear ramps over the first and last `fade_in` / `fade_out` seconds, so a one-shot never starts
/// or ends on a step (which would be heard as a click).
fn edges(mut s: Vec<f32>, fade_in: f32, fade_out: f32) -> Vec<f32> {
    let (a, b, n) = (len(fade_in), len(fade_out), s.len());
    for (i, v) in s.iter_mut().enumerate().take(a) {
        *v *= i as f32 / a as f32;
    }
    for i in 0..b.min(n) {
        s[n - 1 - i] *= i as f32 / b as f32;
    }
    s
}

pub fn engine_hum(version: u16) -> Vec<f32> {
    let n = len(2.0);
    let fade = len(0.1);
    let mut rng = Rng::named(u64::from(version), "engine-noise");
    let mut tone_lp = LowPass::new(if version >= 2 { 300.0 } else { 220.0 });
    let mut rumble = LowPass::new(90.0);
    // One 2 s pass to settle the filters, then n + fade samples: the extra tail crossfades into
    // the start, so the last sample runs on into the first.
    let mut s = Vec::with_capacity(n + fade);
    for i in 0..(2 * n + fade) {
        let t = i as f32 / RATE as f32;
        let mut x = 0.5 * saw(55.0 * t) + 0.5 * saw(55.5 * t);
        if version >= 2 {
            x += 0.25 * square(27.5 * t, 0.5);
        }
        let lfo = 0.8 + 0.2 * (TAU * if version >= 2 { 2.0 } else { 4.0 } * t).sin();
        let y = tone_lp.run(x) * lfo + rumble.run(rng.range_f(-1.0, 1.0)) * 1.0;
        if i >= n {
            s.push(y);
        }
    }
    let mut out = s[..n].to_vec();
    for k in 0..fade {
        let w = k as f32 / fade as f32;
        out[k] = s[n + k] * (1.0 - w) + s[k] * w;
    }
    normalise(out, 0.7)
}

pub fn laser(version: u16) -> Vec<f32> {
    let n = len(0.35);
    let (f0, f1) = if version >= 2 { (1800.0f32, 220.0f32) } else { (1400.0, 280.0) };
    let mut rng = Rng::named(u64::from(version), "laser");
    let (mut phase, mut sub) = (0.0f32, 0.0f32);
    let mut out = Vec::with_capacity(n);
    for i in 0..n {
        let p = i as f32 / n as f32;
        let f = f0 * (f1 / f0).powf(p);
        phase += f / RATE as f32;
        sub += f * 0.5 / RATE as f32;
        let env = (i as f32 / len(0.005) as f32).min(1.0) * (-p * 5.0).exp();
        let mut x = square(phase, 0.3);
        if version >= 2 {
            x = 0.7 * x + 0.3 * square(sub, 0.5);
            if i < len(0.03) {
                x += rng.range_f(-0.8, 0.8);
            }
        }
        out.push(x * env);
    }
    normalise(edges(out, 0.0, 0.02), 0.8)
}

pub fn docking_chime(version: u16) -> Vec<f32> {
    let n = len(1.4);
    let notes: &[f32] = if version >= 2 { &[1046.5, 1318.5, 1568.0, 2093.0] } else { &[1046.5, 1318.5, 1568.0] };
    const PARTIALS: [(f32, f32, f32); 4] = [(1.0, 1.0, 3.0), (2.76, 0.5, 5.0), (5.4, 0.25, 8.0), (8.93, 0.12, 12.0)];
    let mut out = vec![0.0f32; n];
    for (k, &f) in notes.iter().enumerate() {
        let start = len(0.16 * k as f32);
        for (i, v) in out.iter_mut().enumerate().skip(start) {
            let t = (i - start) as f32 / RATE as f32;
            let attack = (t / 0.004).min(1.0);
            *v += PARTIALS.iter().map(|&(ratio, amp, decay)| amp * (-decay * t).exp() * (TAU * f * ratio * t).sin()).sum::<f32>() * attack;
        }
    }
    normalise(edges(out, 0.0, 0.05), 0.8)
}

pub fn explosion() -> Vec<f32> {
    let n = len(1.2);
    let mut rng = Rng::named(0, "explosion");
    let mut lp = LowPass::new(3000.0);
    let mut thump_phase = 0.0f32;
    let out: Vec<f32> = (0..n)
        .map(|i| {
            let t = i as f32 / RATE as f32;
            lp.set(3000.0 * (150.0f32 / 3000.0).powf(t / 1.2));
            let noise = lp.run(rng.range_f(-1.0, 1.0)) * (-3.5 * t).exp();
            thump_phase += (70.0 - 35.0 * (t / 0.4).min(1.0)) / RATE as f32;
            let thump = (TAU * thump_phase).sin() * (1.0 - t / 0.4).max(0.0);
            noise * 2.0 + thump * 0.8
        })
        .collect();
    normalise(edges(out, 0.004, 0.05), 0.85)
}

pub fn ui_click() -> Vec<f32> {
    let mut rng = Rng::named(0, "click");
    let out: Vec<f32> = (0..len(0.04))
        .map(|i| {
            let t = i as f32 / RATE as f32;
            let tick = if t < 0.002 { rng.range_f(-0.1, 0.1) } else { 0.0 };
            (TAU * 2000.0 * t).sin() * (-150.0 * t).exp() + tick
        })
        .collect();
    normalise(edges(out, 0.0, 0.005), 0.6)
}

pub fn cargo_clank() -> Vec<f32> {
    let mut rng = Rng::named(0, "clank");
    let mut thud = LowPass::new(200.0);
    let out: Vec<f32> = (0..len(0.5))
        .map(|i| {
            let t = i as f32 / RATE as f32;
            let ring: f32 = [(320.0, 9.0), (870.0, 14.0), (1450.0, 20.0)].iter().map(|&(f, d)| (TAU * f * t).sin() * (-d * t).exp()).sum();
            let body = if t < 0.05 { thud.run(rng.range_f(-1.0, 1.0)) * 4.0 } else { thud.run(0.0) };
            ring * 0.5 + body
        })
        .collect();
    normalise(edges(out, 0.003, 0.03), 0.8)
}

pub fn menu_music() -> Vec<f32> {
    // Am, F, C, G; two bars each at 120 BPM: 8th-note arpeggio on a 25% pulse, triangle bass on
    // the beat. 32 beats = 16 s.
    const CHORDS: [[i32; 4]; 4] = [[57, 60, 64, 69], [53, 57, 60, 65], [48, 52, 55, 60], [55, 59, 62, 67]];
    let n = len(16.0);
    let mut out = vec![0.0f32; n];
    // 0.25 s is 5512.5 samples: place each step by the exact boundary so 64 of them fill the loop.
    let bound = |step: usize| step * n / 64;
    for step in 0..64 {
        let chord = CHORDS[(step / 16) % 4];
        let lead = midi(chord[step % 4] + 12);
        let start = bound(step);
        let eighth = bound(step + 1) - start;
        for i in 0..eighth {
            let t = i as f32 / RATE as f32;
            let env = (t / 0.005).min(1.0) * (0.4 + 0.6 * (-t * 9.0).exp()) * if i > eighth - len(0.02) { 0.0 } else { 1.0 };
            out[start + i] += 0.35 * square(lead * t, 0.25) * env;
        }
        if step % 2 == 0 {
            let bass = midi(chord[0] - 12);
            for i in 0..(bound(step + 2) - start).min(n - start) {
                let t = i as f32 / RATE as f32;
                out[start + i] += 0.5 * tri(bass * t + 0.25) * (t / 0.005).min(1.0) * (1.0 - t / 0.5).max(0.2);
            }
        }
    }
    normalise(edges(out, 0.003, 0.03), 0.8)
}


#[cfg(test)]
mod tests {
    use super::*;

    fn secs(s: &[f32]) -> f32 {
        s.len() as f32 / RATE as f32
    }
    fn peak(s: &[f32]) -> f32 {
        s.iter().fold(0.0, |m, v| m.max(v.abs()))
    }

    #[test]
    fn wav_header_is_pcm_mono_16_bit() {
        let w = wav(&[0.0, 0.5, -1.5]);
        assert_eq!(&w[..4], b"RIFF");
        assert_eq!(&w[8..16], b"WAVEfmt ");
        assert_eq!(u16::from_le_bytes([w[20], w[21]]), 1, "PCM");
        assert_eq!(u16::from_le_bytes([w[22], w[23]]), 1, "mono");
        assert_eq!(u32::from_le_bytes(w[24..28].try_into().unwrap()), RATE);
        assert_eq!(u16::from_le_bytes([w[34], w[35]]), 16);
        assert_eq!(u32::from_le_bytes(w[40..44].try_into().unwrap()), 6);
        assert_eq!(i16::from_le_bytes([w[48], w[49]]), -32767, "clamped");
    }

    #[test]
    fn effects_have_their_lengths_and_levels() {
        for (name, s, len) in [
            ("engine 1", engine_hum(1), 2.0),
            ("engine 2", engine_hum(2), 2.0),
            ("laser 1", laser(1), 0.35),
            ("laser 2", laser(2), 0.35),
            ("chime 1", docking_chime(1), 1.4),
            ("chime 2", docking_chime(2), 1.4),
            ("explosion", explosion(), 1.2),
            ("click", ui_click(), 0.04),
            ("clank", cargo_clank(), 0.5),
            ("music", menu_music(), 16.0),
        ] {
            assert!((secs(&s) - len).abs() < 0.01, "{name}: {} s", secs(&s));
            assert!(peak(&s) <= 1.0 && peak(&s) > 0.5, "{name}: peak {}", peak(&s));
        }
    }

    #[test]
    fn the_engine_loops_without_a_click() {
        let s = engine_hum(1);
        assert!((s[0] - s[s.len() - 1]).abs() < 0.08, "{} vs {}", s[0], s[s.len() - 1]);
    }

    #[test]
    fn versions_differ_and_builds_repeat() {
        assert_ne!(laser(1), laser(2));
        assert_ne!(docking_chime(1), docking_chime(2));
        assert_eq!(engine_hum(2), engine_hum(2));
        assert!(wav(&engine_hum(2)).len() < 120_000);
    }

    #[test]
    fn one_shots_start_and_end_near_silence() {
        for (name, s) in [
            ("laser 1", laser(1)),
            ("laser 2", laser(2)),
            ("chime 1", docking_chime(1)),
            ("chime 2", docking_chime(2)),
            ("explosion", explosion()),
            ("clank", cargo_clank()),
            ("music", menu_music()),
        ] {
            assert!(s[0].abs() < 0.02, "{name}: starts at {}", s[0]);
            assert!(s[s.len() - 1].abs() < 0.02, "{name}: ends at {}", s[s.len() - 1]);
        }
    }

    #[test]
    fn the_wav_does_not_clip() {
        for s in [engine_hum(2), laser(2), docking_chime(2), explosion(), cargo_clank(), menu_music()] {
            assert!(peak(&s) <= 0.9, "peak {}", peak(&s));
            let w = wav(&s);
            assert!(w[44..].chunks(2).all(|b| i16::from_le_bytes([b[0], b[1]]).abs() < 32_000));
        }
    }

    /// An independent decoder's view of the WAVs: Python's `wave` module. Skips without python3.
    #[test]
    fn python_wave_decodes_every_effect() {
        let dir = tempfile::tempdir().unwrap();
        let script = "import sys, wave\nw = wave.open(sys.argv[1])\nprint(w.getnchannels(), w.getsampwidth(), w.getframerate(), w.getnframes())";
        for (name, s) in [("hum", engine_hum(1)), ("laser", laser(2)), ("chime", docking_chime(2)), ("boom", explosion()), ("click", ui_click()), ("clank", cargo_clank()), ("music", menu_music())] {
            let path = dir.path().join(format!("{name}.wav"));
            std::fs::write(&path, wav(&s)).unwrap();
            let Ok(out) = std::process::Command::new("python3").arg("-I").arg("-c").arg(script).arg(&path).output() else { return };
            assert!(out.status.success(), "{name}: {}", String::from_utf8_lossy(&out.stderr));
            assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), format!("1 2 {RATE} {}", s.len()), "{name}");
        }
    }
}

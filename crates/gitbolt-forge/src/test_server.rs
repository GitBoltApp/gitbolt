//! Tests only: a raw HTTP/1.1 server answering each request from a closure, recording each
//! request's head (request line + headers, lowercased names). One thread per connection, as the
//! Gravatar tests' server.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

pub(crate) struct Canned {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl Canned {
    pub fn json(status: u16, body: &str) -> Self {
        Self { status, headers: vec![("Content-Type".into(), "application/json".into())], body: body.as_bytes().to_vec() }
    }

    pub fn header(mut self, k: &str, v: &str) -> Self {
        self.headers.push((k.into(), v.into()));
        self
    }
}

pub(crate) struct TestServer {
    pub base: String,
    pub heads: Arc<Mutex<Vec<String>>>,
    pub hits: Arc<AtomicUsize>,
}

impl TestServer {
    /// `answer(n, head)`: the n-th request (from 0) and its head.
    pub fn start(answer: impl Fn(usize, &str) -> Canned + Send + Sync + 'static) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let (heads, hits) = (Arc::new(Mutex::new(Vec::new())), Arc::new(AtomicUsize::new(0)));
        let answer = Arc::new(answer);
        let (h2, n2) = (heads.clone(), hits.clone());
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let (heads, hits, answer) = (h2.clone(), n2.clone(), answer.clone());
                std::thread::spawn(move || {
                    let mut stream = stream.unwrap();
                    let mut reader = BufReader::new(stream.try_clone().unwrap());
                    let mut head = String::new();
                    let mut length = 0usize;
                    loop {
                        let mut line = String::new();
                        if reader.read_line(&mut line).unwrap_or(0) == 0 || line == "\r\n" {
                            break;
                        }
                        let lower = line.to_ascii_lowercase();
                        if let Some(v) = lower.strip_prefix("content-length:") {
                            length = v.trim().parse().unwrap_or(0);
                        }
                        head.push_str(&lower);
                    }
                    let mut body = vec![0; length];
                    let _ = reader.read_exact(&mut body);
                    let n = hits.fetch_add(1, Ordering::SeqCst);
                    heads.lock().unwrap().push(head.clone());
                    let c = answer(n, &head);
                    let mut out = format!("HTTP/1.1 {} X\r\nContent-Length: {}\r\nConnection: close\r\n", c.status, c.body.len());
                    for (k, v) in &c.headers {
                        out.push_str(&format!("{k}: {v}\r\n"));
                    }
                    out.push_str("\r\n");
                    let mut bytes = out.into_bytes();
                    bytes.extend_from_slice(&c.body);
                    let _ = stream.write_all(&bytes);
                });
            }
        });
        Self { base, heads, hits }
    }

    pub fn hits(&self) -> usize {
        self.hits.load(Ordering::SeqCst)
    }
}

/// A base URL nothing listens on.
pub(crate) fn closed_base() -> String {
    let port = TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
    format!("http://127.0.0.1:{port}")
}

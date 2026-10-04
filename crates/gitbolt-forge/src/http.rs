//! One HTTP client per forge account (spec #4 §3.1):
//! - bearer auth from the token store;
//! - an ETag cache keyed by URL (`If-None-Match`; a 304 answers from it);
//! - the forges' `Poll-Interval` / `X-Poll-Interval` hints;
//! - rate limits (GitHub `x-ratelimit-*`, GitLab `RateLimit-*`, 429 and `Retry-After`): once
//!   limited, every request fails fast with `RateLimited` until the time the forge gave;
//! - timeouts (10 s to connect, 20 s in all) and `User-Agent: GitBolt/<version>`;
//! - an unreachable API (no connection could be made: DNS, refused, connect timeout, TLS
//!   handshake): its requests fail fast with the same `Network` error for
//!   `NETWORK_COOLDOWN_SECS`, until one gets an answer. A slow API (a read timeout, an answer
//!   cut short) fails only that request.
//!
//! Blocking ureq on the blocking pool, as `gravatar.rs`. The token only leaves in the
//! `Authorization` header: never in a URL, a log line or an error. Redirects never carry it
//! (ureq's `RedirectAuthHeaders::Never`, the default).

use crate::gravatar::USER_AGENT;
use crate::time::{retry_after_secs, unix_now};
use gitbolt_core::error::{ErrorDetail, GbError, GbErrorKind};
use gitbolt_core::forge::RateLimitState;
use gitbolt_core::redact::{redact, Secret};
use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};
use std::time::Duration;

pub const ETAG_ENTRIES: usize = 256;
pub const MAX_BODY: u64 = 8 * 1024 * 1024;
pub const MAX_CACHED_BODY: usize = 1024 * 1024;
pub const MAX_IMAGE: u64 = 1024 * 1024;
/// Requests in flight per account.
pub const PARALLEL: usize = 4;
/// A rate limit that gives no time waits this long.
pub const DEFAULT_LIMIT_WAIT_SECS: i64 = 60;
/// No limit makes GitBolt wait longer than this, whatever the forge says.
pub const MAX_LIMIT_WAIT_SECS: i64 = 3600;
/// The ETag cache's body budget per account.
pub const ETAG_BYTES: usize = 32 * 1024 * 1024;
/// After a request to the API's origin can't reach it, its requests fail fast for this long: an
/// unreachable forge mustn't hold every avatar for the connect timeout.
pub const NETWORK_COOLDOWN_SECS: i64 = 60;

pub type SecsClock = Arc<dyn Fn() -> i64 + Send + Sync>;
#[cfg(test)]
type LinkRewrite = Arc<dyn Fn(&str) -> String + Send + Sync>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Method {
    Get,
    Post,
    Put,
    Patch,
    Delete,
}

impl Method {
    fn as_str(self) -> &'static str {
        match self {
            Self::Get => "GET",
            Self::Post => "POST",
            Self::Put => "PUT",
            Self::Patch => "PATCH",
            Self::Delete => "DELETE",
        }
    }
}

pub struct ClientConfig {
    /// The forge host as the user knows it: messages name it.
    pub host: String,
    pub api_base: String,
    pub token: Option<Secret>,
    /// Sent on every request (GitHub's `Accept` and API version).
    pub headers: Vec<(&'static str, &'static str)>,
    pub timeout: Duration,
}

#[derive(Debug, Clone)]
pub struct HttpResponse {
    pub status: u16,
    pub body: Arc<Vec<u8>>,
    /// A 304: `body` is the cached copy.
    pub not_modified: bool,
    pub poll_interval_secs: Option<u32>,
    /// The `Link: <…>; rel="next"` URL, only on the account's own API origin.
    pub next_page: Option<String>,
    /// GitHub classic tokens' `X-OAuth-Scopes`.
    pub oauth_scopes: Option<String>,
}

impl HttpResponse {
    pub fn json<T: serde::de::DeserializeOwned>(&self, host: &str) -> Result<T, GbError> {
        serde_json::from_slice(&self.body).map_err(|e| GbError::other(format!("{host} sent something GitBolt couldn't read: {e}")))
    }
}

/// What one response said about the rate limit.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct RateHeaders {
    pub remaining: Option<u32>,
    pub reset_at: Option<i64>,
    pub retry_after_secs: Option<i64>,
}

/// `get` reads one lowercase header name.
pub fn rate_headers(get: impl Fn(&str) -> Option<String>, now: i64) -> RateHeaders {
    let num = |names: [&str; 2]| names.iter().find_map(|n| get(n)).and_then(|v| v.trim().parse::<i64>().ok());
    RateHeaders {
        remaining: num(["x-ratelimit-remaining", "ratelimit-remaining"]).map(|n| n.max(0) as u32),
        reset_at: num(["x-ratelimit-reset", "ratelimit-reset"]),
        retry_after_secs: get("retry-after").and_then(|v| retry_after_secs(&v, now)),
    }
}

/// Until when a response means "rate limited": a 429 always; a 403 only with the limit spent
/// (GitHub's primary limit) or a `Retry-After` (its secondary limits).
pub fn limited_until(status: u16, h: &RateHeaders, now: i64) -> Option<i64> {
    let limited = status == 429 || (status == 403 && (h.remaining == Some(0) || h.retry_after_secs.is_some()));
    if !limited {
        return None;
    }
    let wait = h.retry_after_secs.map(|s| s.clamp(1, MAX_LIMIT_WAIT_SECS)).or(h.reset_at.filter(|r| *r > now).map(|r| r.saturating_sub(now).min(MAX_LIMIT_WAIT_SECS))).unwrap_or(DEFAULT_LIMIT_WAIT_SECS);
    Some(now.saturating_add(wait))
}

pub fn rate_limited_error(host: &str, until: i64, now: i64) -> GbError {
    let mins = (until.saturating_sub(now).clamp(1, MAX_LIMIT_WAIT_SECS) + 59) / 60;
    GbError::new(GbErrorKind::RateLimited, format!("{host} rate limit reached: try again in {mins} min")).with_detail(ErrorDetail::RateLimited { until })
}

pub fn parse_next_link(link: &str) -> Option<String> {
    link.split(',').find_map(|part| {
        let (url, params) = part.split_once(';')?;
        let next = params.split(';').any(|p| p.trim().replace(' ', "") == "rel=\"next\"");
        next.then(|| url.trim().trim_start_matches('<').trim_end_matches('>').to_string())
    })
}

/// Percent-encodes a path segment or a query value: RFC 3986's unreserved characters stay.
pub fn encode_component(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

fn origin(u: &str) -> Option<(String, String)> {
    let (scheme, rest) = u.split_once("://")?;
    let authority = rest.split(['/', '?', '#']).next()?;
    if authority.is_empty() || authority.contains('@') {
        return None;
    }
    Some((scheme.to_ascii_lowercase(), authority.to_ascii_lowercase()))
}

/// Same scheme, host and port; a URL with userinfo is never the same origin.
pub fn same_origin(a: &str, b: &str) -> bool {
    origin(a).is_some() && origin(a) == origin(b)
}

/// `url` is `base` or below it (`base/…`, `base?…`) on the same origin. `<x>/github-avatars`
/// isn't under `<x>/github`.
pub fn under(url: &str, base: &str) -> bool {
    let base = base.trim_end_matches('/');
    same_origin(url, base) && (url == base || url.starts_with(&format!("{base}/")) || url.starts_with(&format!("{base}?")))
}

/// The forge's own words from an error body (`error_description`, `message`, `error`),
/// redacted and cut to 200 characters.
pub fn body_message(body: &[u8]) -> Option<String> {
    let v: serde_json::Value = serde_json::from_slice(body).ok()?;
    let said = ["error_description", "message", "error"].iter().find_map(|k| match &v[*k] {
        serde_json::Value::String(s) if !s.trim().is_empty() => Some(s.trim().to_string()),
        // --- 4C T1: GitLab's validation messages come as a list of strings ---
        serde_json::Value::Array(a) if a.iter().all(|x| x.is_string()) => {
            let parts: Vec<&str> = a.iter().filter_map(|x| x.as_str()).map(str::trim).filter(|x| !x.is_empty()).collect();
            if parts.is_empty() { None } else { Some(parts.join("; ")) }
        }
        // --- end 4C T1 ---
        serde_json::Value::Null => None,
        other if !other.is_string() => Some(other.to_string()),
        _ => None,
    })?;
    // --- 4C T1: GitHub's "Validation Failed" says what failed in `errors[].message` ---
    let detail: Vec<&str> = v["errors"].as_array().map(|a| a.iter().filter_map(|e| e["message"].as_str()).collect()).unwrap_or_default();
    let said = if detail.is_empty() { said } else { format!("{said}: {}", detail.join("; ")) };
    // --- end 4C T1 ---
    Some(redact(&said).chars().take(200).collect())
}

/// A 403 (the token works but isn't allowed this), as opposed to a 401 (the token is rejected).
/// Core's, so the hub tells them apart too.
pub use gitbolt_core::forge::{is_forbidden, FORBIDDEN_MARK as REFUSED};

pub fn status_error(host: &str, status: u16, body: &[u8]) -> GbError {
    let said = body_message(body);
    match status {
        401 => GbError::new(GbErrorKind::AuthFailed, format!("{host} rejected the token: add the account again in Settings › Accounts")),
        403 => GbError::new(GbErrorKind::AuthFailed, format!("{host}{REFUSED}{}", said.unwrap_or_else(|| "the token isn't allowed to do this".into()))),
        404 => GbError::new(GbErrorKind::NotFound, format!("Not found on {host}")),
        409 | 422 => GbError::new(GbErrorKind::InvalidInput, format!("{host}: {}", said.unwrap_or_else(|| format!("HTTP {status}")))),
        _ => GbError::other(format!("{host} answered HTTP {status}{}", said.map(|m| format!(": {m}")).unwrap_or_default())),
    }
}

#[derive(Debug)]
struct Cached {
    etag: String,
    body: Arc<Vec<u8>>,
    poll_interval_secs: Option<u32>,
    next_page: Option<String>,
    oauth_scopes: Option<String>,
}

/// The newest `ETAG_ENTRIES` bodies by URL; the oldest is dropped first.
#[derive(Default)]
struct EtagCache {
    map: HashMap<String, Arc<Cached>>,
    order: VecDeque<String>,
    bytes: usize,
}

impl EtagCache {
    fn put(&mut self, url: String, c: Cached) {
        if let Some(old) = self.map.remove(&url) {
            self.bytes -= old.body.len();
            self.order.retain(|u| *u != url);
        }
        self.bytes += c.body.len();
        self.map.insert(url.clone(), Arc::new(c));
        self.order.push_back(url);
        while self.order.len() > ETAG_ENTRIES || self.bytes > ETAG_BYTES {
            let Some(old) = self.order.pop_front() else { break };
            if let Some(c) = self.map.remove(&old) {
                self.bytes -= c.body.len();
            }
        }
    }
}

struct Raw {
    status: u16,
    body: Vec<u8>,
    /// Lowercase names.
    headers: HashMap<String, String>,
}

struct Inner {
    cfg: ClientConfig,
    agent: ureq::Agent,
    etags: Mutex<EtagCache>,
    rate: Mutex<RateLimitState>,
    /// Until when the API's origin is taken as unreachable, and the error that said so.
    down: Mutex<Option<(i64, String)>>,
    permits: Arc<tokio::sync::Semaphore>,
    clock: SecsClock,
    #[cfg(test)]
    link_rewrite: Option<LinkRewrite>,
}

#[derive(Clone)]
pub struct HttpClient {
    inner: Arc<Inner>,
}

impl HttpClient {
    pub fn new(cfg: ClientConfig) -> Self {
        Self::with_clock(cfg, Arc::new(unix_now))
    }

    pub fn with_clock(cfg: ClientConfig, clock: SecsClock) -> Self {
        let agent: ureq::Agent = ureq::Agent::config_builder()
            .timeout_global(Some(cfg.timeout))
            .timeout_connect(Some(Duration::from_secs(10)))
            .timeout_resolve(Some(Duration::from_secs(5)))
            .http_status_as_error(false)
            .max_redirects(0)
            .max_redirects_will_error(false)
            .user_agent(USER_AGENT)
            .build()
            .into();
        Self {
            inner: Arc::new(Inner {
                cfg,
                agent,
                etags: Mutex::default(),
                rate: Mutex::default(),
                down: Mutex::default(),
                permits: Arc::new(tokio::sync::Semaphore::new(PARALLEL)),
                clock,
                #[cfg(test)]
                link_rewrite: None,
            }),
        }
    }

    #[cfg(test)]
    fn with_link_rewrite(self, f: impl Fn(&str) -> String + Send + Sync + 'static) -> Self {
        let inner = Arc::try_unwrap(self.inner).ok().expect("a fresh client");
        Self { inner: Arc::new(Inner { link_rewrite: Some(Arc::new(f)), ..inner }) }
    }

    pub fn host(&self) -> &str {
        &self.inner.cfg.host
    }

    /// `path` (starting with `/`) under the API base, or a full URL (a next page). Anything else
    /// comes back unchanged, and `send` refuses it: a request never leaves the API base.
    pub fn url(&self, path: &str) -> String {
        if path.starts_with('/') && !path.starts_with("//") { format!("{}{path}", self.inner.cfg.api_base) } else { path.to_string() }
    }

    pub fn rate_limit(&self) -> RateLimitState {
        self.inner.rate.lock().expect("rate state poisoned").clone()
    }

    /// A conditional GET: a 304 answers from the ETag cache (`not_modified`).
    pub async fn get(&self, path: &str) -> Result<HttpResponse, GbError> {
        self.request(Method::Get, path, None).await
    }

    /// A write: never cached, never conditional.
    pub async fn send_json(&self, method: Method, path: &str, body: &serde_json::Value) -> Result<HttpResponse, GbError> {
        self.request(method, path, Some(body.to_string().into_bytes())).await
    }

    /// Every page of a list, following `Link: rel="next"` on the API's own origin, at most `max_pages`.
    pub async fn get_pages(&self, path: &str, max_pages: usize) -> Result<Vec<serde_json::Value>, GbError> {
        let mut out = Vec::new();
        let mut next = Some(path.to_string());
        for _ in 0..max_pages {
            let Some(p) = next.take() else { break };
            let r = self.get(&p).await?;
            let page: Vec<serde_json::Value> = r.json(self.host())?;
            out.extend(page);
            next = r.next_page;
        }
        Ok(out)
    }

    /// An image (`Ok(None)` for a 404), with the token only when `url` is under `own_origin` (a
    /// forge's web base) or the API base. Not ETag-cached: the avatar disk cache keeps what it needs.
    /// One redirect is followed, never from https to http; the token only goes where it's scoped.
    pub async fn get_image(&self, url: &str, own_origin: &str) -> Result<Option<(String, Vec<u8>)>, GbError> {
        let api = self.inner.cfg.api_base.clone();
        let mut target = url.to_string();
        let mut may_auth = true;
        for hop in 0..2 {
            let auth = may_auth && (under(&target, own_origin) || under(&target, &api));
            may_auth = auth;
            let raw = self.once(Method::Get, &target, None, None, auth, MAX_IMAGE).await?;
            if auth && under(&target, &api) {
                self.observe(&raw)?;
            }
            if is_redirect(raw.status) && hop == 0 {
                let next = self.redirect_target(&target, &raw)?;
                if target.starts_with("https://") && !next.starts_with("https://") {
                    return Err(GbError::other(format!("{} redirected an image to plain http; GitBolt didn't follow it", self.host())));
                }
                target = next;
                continue;
            }
            return match raw.status {
                200 => Ok(Some((raw.headers.get("content-type").cloned().unwrap_or_default(), raw.body))),
                404 => Ok(None),
                s => Err(status_error(self.host(), s, &raw.body)),
            };
        }
        Err(GbError::other(format!("{} redirected an image too many times", self.host())))
    }

    fn redirect_target(&self, from: &str, raw: &Raw) -> Result<String, GbError> {
        let loc = raw.headers.get("location").ok_or_else(|| GbError::other(format!("{} redirected the request without saying where", self.host())))?;
        if loc.starts_with("http://") || loc.starts_with("https://") {
            return Ok(loc.clone());
        }
        let (scheme, rest) = from.split_once("://").ok_or_else(|| GbError::other("bad redirect"))?;
        let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
        if loc.starts_with('/') && !loc.starts_with("//") { Ok(format!("{scheme}://{authority}{loc}")) } else { Err(GbError::other(format!("{} sent a redirect GitBolt couldn't follow", self.host()))) }
    }

    async fn request(&self, method: Method, path: &str, body: Option<Vec<u8>>) -> Result<HttpResponse, GbError> {
        let url = self.url(path);
        let snapshot = if method == Method::Get { self.inner.etags.lock().expect("etags poisoned").map.get(&url).cloned() } else { None };
        let etag = snapshot.as_ref().map(|c| c.etag.clone());
        let mut raw = self.send(method, &url, body.clone(), etag).await?;
        // A 304 with no copy to answer from (nothing was cached): ask again, unconditionally, once.
        if raw.status == 304 && snapshot.is_none() {
            raw = self.send(method, &url, body, None).await?;
        }
        self.finish(method, url, raw, snapshot)
    }

    /// An API request: refused unless under the API base, then redirects handled by hand.
    async fn send(&self, method: Method, url: &str, body: Option<Vec<u8>>, etag: Option<String>) -> Result<Raw, GbError> {
        if !under(url, &self.inner.cfg.api_base) {
            return Err(GbError::other(format!("GitBolt refused to send {}'s token to an address outside its API", self.host())));
        }
        let raw = self.once(method, url, body, etag, true, MAX_BODY).await?;
        if !is_redirect(raw.status) {
            return Ok(raw);
        }
        if method != Method::Get {
            return Err(GbError::other(format!("{} redirected the request; nothing was changed", self.host())));
        }
        let target = self.redirect_target(url, &raw)?;
        if !under(&target, &self.inner.cfg.api_base) {
            return Err(GbError::other(format!("{} redirected the request somewhere else; GitBolt didn't follow it", self.host())));
        }
        let again = self.once(Method::Get, &target, None, None, true, MAX_BODY).await?;
        if is_redirect(again.status) {
            return Err(GbError::other(format!("{} redirected the request too many times", self.host())));
        }
        Ok(again)
    }

    /// One request, no redirects: fails fast while limited (checked again once a permit is held),
    /// and keeps the permit until the blocking call is done.
    async fn once(&self, method: Method, url: &str, body: Option<Vec<u8>>, etag: Option<String>, auth: bool, limit: u64) -> Result<Raw, GbError> {
        // Only the API's own origin: an avatar host that's down says nothing about the forge.
        let api = same_origin(url, &self.inner.cfg.api_base);
        self.gate(api)?;
        let permit = self.inner.permits.clone().acquire_owned().await.map_err(|e| GbError::other(e.to_string()))?;
        self.gate(api)?;
        let (inner, target) = (self.inner.clone(), url.to_string());
        let result = tokio::task::spawn_blocking(move || {
            let _permit = permit;
            inner.send_blocking(method, &target, body, etag, auth, limit)
        })
        .await
        .map_err(|e| GbError::other(format!("request task failed: {e}")))?;
        if api {
            let mut down = self.inner.down.lock().expect("network state poisoned");
            match &result {
                Ok(_) => *down = None,
                // Only a connection that couldn't be made: a slow but live API (a read timeout,
                // an answer cut short) fails that request and leaves the gate open.
                Err(f) if f.unreachable => *down = Some(((self.inner.clock)().saturating_add(NETWORK_COOLDOWN_SECS), f.error.message.clone())),
                Err(_) => {}
            }
        }
        result.map_err(|f| f.error)
    }

    /// Fails fast while rate limited, and (`api`) while the API's origin is unreachable.
    fn gate(&self, api: bool) -> Result<(), GbError> {
        let now = (self.inner.clock)();
        if let Some(until) = self.inner.rate.lock().expect("rate state poisoned").limited_until.filter(|u| *u > now) {
            return Err(rate_limited_error(self.host(), until, now));
        }
        if api && let Some((_, message)) = self.inner.down.lock().expect("network state poisoned").as_ref().filter(|(until, _)| *until > now) {
            return Err(GbError::new(GbErrorKind::Network, message.clone()));
        }
        Ok(())
    }

    /// Records what a response said about the rate limit; `Err` if it limits us.
    fn observe(&self, raw: &Raw) -> Result<RateHeaders, GbError> {
        let now = (self.inner.clock)();
        let rh = rate_headers(|n| raw.headers.get(n).cloned(), now);
        let mut r = self.inner.rate.lock().expect("rate state poisoned");
        r.remaining = rh.remaining.or(r.remaining);
        r.reset_at = rh.reset_at.or(r.reset_at);
        match limited_until(raw.status, &rh, now) {
            Some(until) => {
                r.limited_until = Some(until);
                Err(rate_limited_error(self.host(), until, now))
            }
            None => {
                // A request that started before a 429 may still come back 200: only a limit
                // that's over is cleared.
                r.limited_until = r.limited_until.filter(|u| *u > now);
                Ok(rh)
            }
        }
    }

    fn finish(&self, method: Method, url: String, raw: Raw, snapshot: Option<Arc<Cached>>) -> Result<HttpResponse, GbError> {
        let host = self.host();
        let get = |n: &str| raw.headers.get(n).cloned();
        self.observe(&raw)?;
        let poll_interval_secs = get("poll-interval").or_else(|| get("x-poll-interval")).and_then(|v| v.trim().parse().ok());
        #[cfg(test)]
        let link = get("link").map(|l| self.inner.link_rewrite.as_ref().map(|f| f(&l)).unwrap_or(l));
        #[cfg(not(test))]
        let link = get("link");
        let next_page = link.and_then(|l| parse_next_link(&l)).filter(|n| under(n, &self.inner.cfg.api_base));
        let oauth_scopes = get("x-oauth-scopes");
        if raw.status == 304 && method == Method::Get {
            let c = snapshot.ok_or_else(|| GbError::other(format!("{host} answered 304 for a request GitBolt has no copy of")))?;
            {
                let mut etags = self.inner.etags.lock().expect("etags poisoned");
                if let Some(pos) = etags.order.iter().position(|u| *u == url) {
                    let u = etags.order.remove(pos).expect("position is valid");
                    etags.order.push_back(u);
                }
            }
            return Ok(HttpResponse { status: 200, body: c.body.clone(), not_modified: true, poll_interval_secs: poll_interval_secs.or(c.poll_interval_secs), next_page: c.next_page.clone(), oauth_scopes: oauth_scopes.or_else(|| c.oauth_scopes.clone()) });
        }
        if !(200..300).contains(&raw.status) {
            return Err(status_error(host, raw.status, &raw.body));
        }
        let body = Arc::new(raw.body);
        if method == Method::Get
            && body.len() <= MAX_CACHED_BODY
            && let Some(etag) = get("etag")
        {
            self.inner.etags.lock().expect("etags poisoned").put(url, Cached { etag, body: body.clone(), poll_interval_secs, next_page: next_page.clone(), oauth_scopes: oauth_scopes.clone() });
        }
        tracing::debug!(target: "gitbolt_forge::http", host, method = method.as_str(), status = raw.status, "forge request");
        Ok(HttpResponse { status: raw.status, body, not_modified: false, poll_interval_secs, next_page, oauth_scopes })
    }
}

fn is_redirect(status: u16) -> bool {
    matches!(status, 301 | 302 | 303 | 307 | 308)
}

/// A request that failed, and whether no connection could be made at all.
struct Failed {
    error: GbError,
    unreachable: bool,
}

impl From<GbError> for Box<Failed> {
    fn from(error: GbError) -> Self {
        Box::new(Failed { error, unreachable: false })
    }
}

/// Whether `e` failed before a connection was made: the name didn't resolve, the connection was
/// refused or timed out, or the TLS handshake failed (rustls's handshake errors come back as
/// `InvalidData` I/O errors). A timeout or reset once connected is a slow API, not a down one.
fn connect_failed(e: &ureq::Error) -> bool {
    use std::io::ErrorKind as K;
    match e {
        ureq::Error::HostNotFound | ureq::Error::ConnectionFailed | ureq::Error::Tls(_) => true,
        ureq::Error::Timeout(t) => matches!(t, ureq::Timeout::Resolve | ureq::Timeout::Connect),
        ureq::Error::Io(io) => matches!(io.kind(), K::ConnectionRefused | K::HostUnreachable | K::NetworkUnreachable | K::AddrNotAvailable | K::InvalidData),
        _ => false,
    }
}

impl Inner {
    fn send_blocking(&self, method: Method, url: &str, body: Option<Vec<u8>>, if_none_match: Option<String>, auth: bool, limit: u64) -> Result<Raw, Box<Failed>> {
        let host = &self.cfg.host;
        let mut b = ureq::http::Request::builder().method(method.as_str()).uri(url);
        if auth && let Some(t) = &self.cfg.token {
            b = b.header("Authorization", format!("Bearer {}", t.expose()));
        }
        for (k, v) in &self.cfg.headers {
            b = b.header(*k, *v);
        }
        if let Some(e) = &if_none_match {
            b = b.header("If-None-Match", e.as_str());
        }
        let bad = |e: ureq::http::Error| GbError::other(format!("couldn't build a request to {host}: {e}"));
        let unreachable = |e: ureq::Error| Box::new(Failed { unreachable: connect_failed(&e), error: GbError::new(GbErrorKind::Network, format!("Couldn't reach {host}: {}", redact(&e.to_string()))) });
        let mut resp = match body {
            Some(bytes) => self.agent.run(b.header("Content-Type", "application/json").body(bytes).map_err(bad)?).map_err(unreachable)?,
            None => self.agent.run(b.body(()).map_err(bad)?).map_err(unreachable)?,
        };
        let status = resp.status().as_u16();
        let headers = resp.headers().iter().filter_map(|(k, v)| Some((k.as_str().to_ascii_lowercase(), v.to_str().ok()?.to_string()))).collect();
        let body = resp.body_mut().with_config().limit(limit).read_to_vec().map_err(|e| GbError::new(GbErrorKind::Network, format!("Couldn't reach {host}: the answer was cut short ({})", redact(&e.to_string()))))?;
        Ok(Raw { status, body, headers })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_server::{closed_base, Canned, TestServer};

    const TOKEN: &str = "glpat-FAKE-test-token";
    const NOW: i64 = 1_791_115_200;

    fn client(base: &str) -> HttpClient {
        HttpClient::with_clock(
            ClientConfig { host: "gitlab.example.com".into(), api_base: format!("{base}/api/v4"), token: Some(Secret::new(TOKEN)), headers: vec![("Accept", "application/json")], timeout: Duration::from_secs(5) },
            Arc::new(|| NOW),
        )
    }

    #[tokio::test]
    async fn sends_bearer_auth_and_the_user_agent_and_never_puts_the_token_in_errors() {
        let s = TestServer::start(|_, _| Canned::json(401, r#"{"message":"401 Unauthorized"}"#));
        let e = client(&s.base).get("/user").await.unwrap_err();
        assert_eq!(e.kind, GbErrorKind::AuthFailed);
        assert_eq!(e.message, "gitlab.example.com rejected the token: add the account again in Settings › Accounts");
        let head = s.heads.lock().unwrap()[0].clone();
        assert!(head.starts_with("get /api/v4/user http/1.1"), "{head}");
        assert!(head.contains(&format!("authorization: bearer {}", TOKEN.to_ascii_lowercase())), "{head}");
        assert!(head.contains(&format!("user-agent: {}", crate::gravatar::USER_AGENT.to_ascii_lowercase())), "{head}");
        assert!(!format!("{e:?}").contains(TOKEN));
    }

    #[tokio::test]
    async fn an_etag_hit_returns_the_cached_body_as_not_modified() {
        let s = TestServer::start(|n, head| {
            if n == 0 { Canned::json(200, r#"{"a":1}"#).header("ETag", "\"v1\"").header("Poll-Interval", "30") }
            else { assert!(head.contains("if-none-match: \"v1\""), "{head}"); Canned::json(304, "") }
        });
        let c = client(&s.base);
        let first = c.get("/projects/1").await.unwrap();
        assert!(!first.not_modified);
        assert_eq!(first.poll_interval_secs, Some(30));
        let second = c.get("/projects/1").await.unwrap();
        assert!(second.not_modified);
        assert_eq!(second.body.as_slice(), br#"{"a":1}"#);
        assert_eq!(second.json::<serde_json::Value>("h").unwrap()["a"], 1);
        assert_eq!(s.hits(), 2);
    }

    #[tokio::test]
    async fn a_429_limits_until_retry_after_and_fails_fast_without_a_request() {
        let s = TestServer::start(|_, _| Canned::json(429, r#"{"message":"Too Many Requests"}"#).header("Retry-After", "120"));
        let c = client(&s.base);
        let e = c.get("/user").await.unwrap_err();
        assert_eq!(e.kind, GbErrorKind::RateLimited);
        assert_eq!(e.message, "gitlab.example.com rate limit reached: try again in 2 min");
        assert_eq!(e.detail, Some(ErrorDetail::RateLimited { until: NOW + 120 }));
        let again = c.get("/projects/1").await.unwrap_err();
        assert_eq!(again.kind, GbErrorKind::RateLimited);
        assert_eq!(s.hits(), 1, "no request while limited");
        assert_eq!(c.rate_limit().limited_until, Some(NOW + 120));
    }

    #[tokio::test]
    async fn a_success_that_started_before_a_429_keeps_the_limit() {
        let s = TestServer::start(|_, _| Canned::json(200, "{}"));
        let c = client(&s.base);
        c.inner.rate.lock().unwrap().limited_until = Some(NOW + 120);
        let raw = Raw { status: 200, body: vec![], headers: HashMap::new() };
        c.observe(&raw).unwrap();
        assert_eq!(c.rate_limit().limited_until, Some(NOW + 120), "not over yet");
        c.inner.rate.lock().unwrap().limited_until = Some(NOW - 1);
        c.observe(&raw).unwrap();
        assert_eq!(c.rate_limit().limited_until, None, "an expired limit is cleared");
    }

    #[test]
    fn github_primary_and_secondary_limits_are_403s_that_say_so() {
        let spent = RateHeaders { remaining: Some(0), reset_at: Some(NOW + 600), retry_after_secs: None };
        assert_eq!(limited_until(403, &spent, NOW), Some(NOW + 600));
        let secondary = RateHeaders { remaining: Some(4000), reset_at: None, retry_after_secs: Some(60) };
        assert_eq!(limited_until(403, &secondary, NOW), Some(NOW + 60));
        assert_eq!(limited_until(403, &RateHeaders { remaining: Some(10), ..Default::default() }, NOW), None, "a plain 403 is a permission problem");
        assert_eq!(limited_until(429, &RateHeaders::default(), NOW), Some(NOW + DEFAULT_LIMIT_WAIT_SECS));
        let h = rate_headers(|n| match n { "ratelimit-remaining" => Some("7".into()), "ratelimit-reset" => Some((NOW + 30).to_string()), _ => None }, NOW);
        assert_eq!(h, RateHeaders { remaining: Some(7), reset_at: Some(NOW + 30), retry_after_secs: None });
    }

    #[tokio::test]
    async fn get_pages_follows_same_origin_next_links_up_to_the_cap() {
        let s = TestServer::start(move |n, _| match n {
            0 => Canned::json(200, "[1,2]").header("Link", "<BASE/api/v4/forks?page=2>; rel=\"next\""),
            1 => Canned::json(200, "[3]").header("Link", "<https://evil.example/api/v4/forks?page=3>; rel=\"next\""),
            _ => Canned::json(200, "[99]"),
        });
        // The canned Link header names the server by placeholder; the client resolves it below.
        let base = s.base.clone();
        let fixed = client(&s.base).with_link_rewrite(move |l: &str| l.replace("BASE", &base));
        let all = fixed.get_pages("/forks", 5).await.unwrap();
        assert_eq!(all, vec![serde_json::json!(1), serde_json::json!(2), serde_json::json!(3)], "the cross-origin next link isn't followed");
        assert_eq!(s.hits(), 2);
    }

    #[tokio::test]
    async fn an_unreachable_host_is_a_network_error() {
        let e = client(&closed_base()).get("/user").await.unwrap_err();
        assert_eq!(e.kind, GbErrorKind::Network);
        assert!(e.message.starts_with("Couldn't reach gitlab.example.com: "), "{}", e.message);
    }

    #[tokio::test]
    async fn an_unreachable_api_fails_fast_for_a_minute_then_is_tried_again() {
        let base = closed_base();
        let now = Arc::new(std::sync::atomic::AtomicI64::new(NOW));
        let clock = now.clone();
        let c = HttpClient::with_clock(
            ClientConfig { host: "gitlab.example.com".into(), api_base: format!("{base}/api/v4"), token: Some(Secret::new(TOKEN)), headers: vec![], timeout: Duration::from_secs(5) },
            Arc::new(move || clock.load(std::sync::atomic::Ordering::SeqCst)),
        );
        let first = c.get("/user").await.unwrap_err();
        assert_eq!(first.kind, GbErrorKind::Network);
        // The port answers now, but the gate is closed: nothing is sent.
        let s = TestServer::start_at(base.trim_start_matches("http://"), |_, _| Canned::json(200, "{}"));
        let started = std::time::Instant::now();
        for _ in 0..3 {
            let again = c.get("/projects/1").await.unwrap_err();
            assert_eq!((again.kind, again.message.as_str()), (GbErrorKind::Network, first.message.as_str()));
        }
        assert!(started.elapsed() < Duration::from_secs(1));
        assert_eq!(s.hits(), 0, "no request while the forge is taken as down");
        now.store(NOW + NETWORK_COOLDOWN_SECS + 1, std::sync::atomic::Ordering::SeqCst);
        c.get("/user").await.unwrap();
        assert_eq!(s.hits(), 1);
        now.store(NOW, std::sync::atomic::Ordering::SeqCst);
        c.get("/user").await.unwrap();
        assert_eq!(s.hits(), 2, "a success opened the gate");
    }

    #[tokio::test]
    async fn a_slow_api_fails_the_request_but_leaves_the_gate_open() {
        use std::io::{BufRead, BufReader, Write};
        // A live API: the first connection stalls past the client's timeout, the second's answer
        // is cut short, the third answers.
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let hits = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let h2 = hits.clone();
        std::thread::spawn(move || {
            for (n, stream) in listener.incoming().enumerate() {
                let mut stream = stream.unwrap();
                h2.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                std::thread::spawn(move || {
                    let mut reader = BufReader::new(stream.try_clone().unwrap());
                    let mut line = String::new();
                    while reader.read_line(&mut line).unwrap_or(0) > 0 && line != "\r\n" {
                        line.clear();
                    }
                    match n {
                        0 => std::thread::sleep(Duration::from_millis(1500)),
                        1 => drop(stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\nConnection: close\r\n\r\n{\"id\"")),
                        _ => drop(stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}")),
                    }
                });
            }
        });
        let c = HttpClient::with_clock(
            ClientConfig { host: "gitlab.example.com".into(), api_base: format!("{base}/api/v4"), token: Some(Secret::new(TOKEN)), headers: vec![], timeout: Duration::from_millis(300) },
            Arc::new(|| NOW),
        );
        let stalled = c.get("/user").await.unwrap_err();
        assert_eq!(stalled.kind, GbErrorKind::Network);
        let cut = c.get("/user").await.unwrap_err();
        assert_eq!(cut.kind, GbErrorKind::Network);
        assert!(cut.message.contains("the answer was cut short"), "{}", cut.message);
        c.get("/user").await.unwrap();
        assert_eq!(hits.load(std::sync::atomic::Ordering::SeqCst), 3, "every request was sent: the gate stayed open");
    }

    #[tokio::test]
    async fn get_image_sends_the_token_only_under_its_own_bases() {
        let s = TestServer::start(|_, _| Canned { status: 200, headers: vec![("Content-Type".into(), "image/png".into())], body: b"\x89PNGx".to_vec() });
        let c = client(&s.base);
        let web = format!("{}/web", s.base);
        let (ct, bytes) = c.get_image(&format!("{web}/uploads/a.png"), &web).await.unwrap().unwrap();
        assert_eq!((ct.as_str(), bytes.as_slice()), ("image/png", b"\x89PNGx".as_slice()));
        c.get_image(&format!("{}/web-avatars/a.png", s.base), &web).await.unwrap();
        let heads = s.heads.lock().unwrap().clone();
        assert!(heads[0].contains("authorization: bearer"), "under the web base");
        assert!(!heads[1].contains("authorization"), "same host, another base: no token");
        let other = TestServer::start(|_, _| Canned { status: 200, headers: vec![("Content-Type".into(), "image/png".into())], body: b"\x89PNGy".to_vec() });
        c.get_image(&format!("{}/a.png", other.base), &web).await.unwrap();
        assert!(!other.heads.lock().unwrap()[0].contains("authorization"), "another origin never gets the token");
        assert!(under("https://h/api/v4/x", "https://h/api/v4") && !under("https://h/api/v40", "https://h/api/v4"));
    }

    #[tokio::test]
    async fn requests_never_leave_the_api_base() {
        let other = TestServer::start(|_, _| Canned::json(200, "{}"));
        let s = TestServer::start(|_, _| Canned::json(200, r#"{"ok":true}"#));
        let c = client(&s.base);
        assert!(c.get(&format!("{}/x", other.base)).await.is_err());
        assert!(c.get("@evil.example/x").await.is_err());
        assert!(c.get(".evil.example/x").await.is_err());
        assert!(c.get("//evil.example/x").await.is_err());
        assert_eq!(other.hits(), 0);
        assert_eq!(s.hits(), 0);
        assert!(c.get("/user").await.is_ok());
        assert_eq!(s.hits(), 1);
    }

    #[tokio::test]
    async fn retry_after_is_clamped_end_to_end() {
        let s = TestServer::start(|n, _| match n {
            0 => Canned::json(429, "{}").header("Retry-After", "99999999999999999999999"),
            _ => Canned::json(429, "{}").header("Retry-After", "Sun, 06 Nov 2044 08:49:37 GMT"),
        });
        let c = client(&s.base);
        let e = c.get("/a").await.unwrap_err();
        assert_eq!(e.detail, Some(ErrorDetail::RateLimited { until: NOW + 3600 }));
        let c2 = client(&s.base);
        let e = c2.get("/a").await.unwrap_err();
        assert_eq!(e.detail, Some(ErrorDetail::RateLimited { until: NOW + 3600 }));
    }

    #[tokio::test]
    async fn a_same_api_redirect_keeps_auth_and_others_are_refused() {
        let s = TestServer::start(|_, head| {
            if head.starts_with("get /api/v4/old ") { Canned::json(302, "").header("Location", "/api/v4/new") }
            else if head.starts_with("get /api/v4/away ") { Canned::json(302, "").header("Location", "http://127.0.0.1:1/x") }
            else { assert!(head.contains("authorization: bearer"), "{head}"); Canned::json(200, r#"{"n":1}"#) }
        });
        let c = client(&s.base);
        assert_eq!(c.get("/old").await.unwrap().json::<serde_json::Value>("h").unwrap()["n"], 1);
        let e = c.get("/away").await.unwrap_err();
        assert!(e.message.contains("redirected"), "{}", e.message);
    }

    #[tokio::test]
    async fn a_write_never_follows_a_redirect() {
        let s = TestServer::start(|_, _| Canned::json(307, "").header("Location", "/api/v4/else"));
        let c = client(&s.base);
        let e = c.send_json(Method::Post, "/x", &serde_json::json!({})).await.unwrap_err();
        assert_eq!(e.message, "gitlab.example.com redirected the request; nothing was changed");
        assert_eq!(s.hits(), 1);
    }

    #[tokio::test]
    async fn an_image_redirect_from_a_third_party_never_gains_the_token() {
        let s = TestServer::start(|_, _| Canned { status: 200, headers: vec![("Content-Type".into(), "image/png".into())], body: b"\x89PNGz".to_vec() });
        let target = format!("{}/api/v4/a.png", s.base);
        let other = TestServer::start(move |_, _| Canned::json(302, "").header("Location", &target));
        let c = client(&s.base);
        let got = c.get_image(&format!("{}/a.png", other.base), &format!("{}/web", s.base)).await.unwrap();
        assert!(got.is_some());
        assert!(!s.heads.lock().unwrap()[0].contains("authorization"));
    }

    #[tokio::test]
    async fn a_304_without_a_copy_asks_again_unconditionally_once() {
        let s = TestServer::start(|n, head| {
            if n == 0 { Canned::json(304, "") } else { assert!(!head.contains("if-none-match"), "{head}"); Canned::json(200, r#"{"a":2}"#) }
        });
        let r = client(&s.base).get("/x").await.unwrap();
        assert!(!r.not_modified);
        assert_eq!(r.json::<serde_json::Value>("h").unwrap()["a"], 2);
        assert_eq!(s.hits(), 2);
    }

    #[test]
    fn the_etag_cache_is_lru_and_byte_bounded() {
        let mk = |n: usize| Cached { etag: "e".into(), body: Arc::new(vec![0; n]), poll_interval_secs: None, next_page: None, oauth_scopes: None };
        let mut c = EtagCache::default();
        c.put("a".into(), mk(1));
        c.put("b".into(), mk(1));
        c.put("a".into(), mk(1));
        assert_eq!(c.order, ["b", "a"]);
        c.put("big1".into(), mk(MAX_CACHED_BODY));
        for i in 0..40 {
            c.put(format!("k{i}"), mk(MAX_CACHED_BODY));
        }
        assert!(c.bytes <= ETAG_BYTES);
        assert!(!c.map.contains_key("a"));
    }

    #[test]
    fn pure_helpers() {
        assert_eq!(parse_next_link(r#"<https://h/api?page=2>; rel="next", <https://h/api?page=9>; rel="last""#).as_deref(), Some("https://h/api?page=2"));
        assert_eq!(parse_next_link(r#"<https://h/api?page=1>; rel="prev""#), None);
        assert_eq!(encode_component("group/sub project@x"), "group%2Fsub%20project%40x");
        assert_eq!(encode_component("a-b_c.d~e"), "a-b_c.d~e");
        assert!(same_origin("https://GitLab.example.com/x", "https://gitlab.example.com"));
        assert!(!same_origin("https://gitlab.example.com:8443/x", "https://gitlab.example.com"));
        assert!(!same_origin("https://u@gitlab.example.com/x", "https://gitlab.example.com"));
        assert_eq!(body_message(format!(r#"{{"message":"token glpat-{} is bad"}}"#, "a".repeat(21)).as_bytes()).as_deref(), Some("token *** is bad"));
        assert_eq!(body_message(br#"{"error":"insufficient_scope","error_description":"needs api"}"#).as_deref(), Some("needs api"));
        assert_eq!(status_error("h", 404, b"").kind, GbErrorKind::NotFound);
        assert_eq!(status_error("h", 422, br#"{"message":"Branch exists"}"#).message, "h: Branch exists");
        assert_eq!(status_error("h", 403, br#"{"message":"insufficient_scope"}"#).message, "h refused: insufficient_scope");
        assert_eq!(status_error("h", 502, b"").message, "h answered HTTP 502");
    }
    // --- 4C T1 ---
    #[test]
    fn body_messages_join_gitlab_lists_and_githubs_validation_errors() {
        assert_eq!(
            body_message(br#"{"message": ["Another open merge request already exists for this source branch: !1"]}"#).as_deref(),
            Some("Another open merge request already exists for this source branch: !1")
        );
        assert_eq!(
            body_message(br#"{"message": "Validation Failed", "errors": [{"resource": "PullRequest", "code": "custom", "message": "A pull request already exists for octo-org:feature."}]}"#).as_deref(),
            Some("Validation Failed: A pull request already exists for octo-org:feature.")
        );
        assert_eq!(body_message(br#"{"message": "Validation Failed", "errors": [{"resource": "PullRequest", "field": "head", "code": "missing_field"}]}"#).as_deref(), Some("Validation Failed"));
        assert_eq!(body_message(br#"{"message": ["", " "]}"#), None);
        assert_eq!(status_error("gitlab.example.com", 409, br#"{"message": ["a", "b"]}"#).message, "gitlab.example.com: a; b");
    }
    // --- end 4C T1 ---
}

//! A fake GitLab and GitHub for tests (spec #4 §7): the REST subset GitBolt's providers use,
//! answered from a seed, with ETags (a 304 on a match), each forge's rate-limit headers, one-shot
//! scripted answers (429s, 500s, poll intervals), and a log of requests that records whether a
//! valid token came, never the token. It runs on its own ephemeral port, so harnesses in several
//! worktrees never collide. 4B–4D add their routes as match arms in `gitlab::route` and
//! `github::route`, and their seed fields with `#[serde(default)]`.

pub mod github;
// --- 4C T2 ---
pub mod create;
// --- end 4C T2 ---
// --- 4B T4 ---
pub mod github_pulls;
// --- end 4B T4 ---
pub mod gitlab;
// --- 4B T2 ---
pub mod gitlab_mrs;
// --- end 4B T2 ---

use axum::body::Bytes;
use axum::extract::State;
use axum::http::{HeaderMap, Method, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::Router;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::hash::{Hash, Hasher};
use std::sync::{Arc, Mutex};

pub const GITLAB_HOST: &str = "gitlab.example.com";
pub const GITHUB_HOST: &str = "github.com";
pub const GITLAB_TOKEN: &str = "glpat-FAKE-e2e-ada";
pub const GITLAB_READONLY_TOKEN: &str = "glpat-FAKE-e2e-readonly";
pub const GITHUB_TOKEN: &str = "ghp_FAKE-e2e-octocat";
pub const GITHUB_FINE_TOKEN: &str = "github_pat_FAKE-e2e-fine-grained";
pub const GITHUB_READONLY_TOKEN: &str = "ghp_FAKE-e2e-readonly";
pub const FAKE_PNG: &[u8] = b"\x89PNG\r\n\x1a\nfake";
// --- 5A T3 ---
/// The secret of the default seed's GitLab upload, `group/project/<it>/shot.png`.
pub const UPLOAD_SECRET: &str = "0123456789abcdef0123456789abcdef";
// --- end 5A T3 ---

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct FakeUser {
    pub id: u64,
    pub username: String,
    pub name: String,
    pub email: Option<String>,
    pub avatar_url: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct FakeToken {
    pub token: String,
    pub user: FakeUser,
    pub scopes: Vec<String>,
    /// GitHub: a fine-grained token (no `X-OAuth-Scopes`).
    pub fine_grained: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct FakeProject {
    pub id: u64,
    pub path: String,
    pub default_branch: Option<String>,
    /// Defaults to `<base>/gitlab/<path>.git` (GitLab) or `<base>/github-web/<path>.git`.
    pub http_url: Option<String>,
    pub ssh_url: Option<String>,
    pub fork_of: Option<String>,
    /// RFC 3339.
    pub updated_at: String,
    pub archived: bool,
    /// Merged over the project's JSON (`squash_option`, `allow_rebase_merge`, …).
    pub settings: Value,
}

// --- 4C T2 ---
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct FakeLabel {
    pub name: String,
    /// As each forge spells it: GitLab `#d9534f`, GitHub `d73a4a`.
    pub color: String,
    pub description: Option<String>,
}
// --- end 4C T2 ---

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct GitLabSeed {
    pub version: String,
    pub tokens: Vec<FakeToken>,
    pub projects: Vec<FakeProject>,
    /// Lowercase email → the `avatar_url` `/avatar` answers.
    pub avatars: BTreeMap<String, String>,
    // --- 4B: merge request seed fields go here ---
    // --- 4B T2 ---
    /// Merge requests of the seed's projects (`gitlab_mrs.rs`).
    pub merge_requests: Vec<gitlab_mrs::FakeMergeRequest>,
    /// Users who appear in merge requests without a token of their own.
    pub users: Vec<FakeUser>,
    // --- end 4B T2 ---
    // --- 4C T2 ---
    /// `/members/all`: who can review or be assigned.
    pub members: Vec<FakeUser>,
    pub labels: Vec<FakeLabel>,
    /// Project path → file path → text, served at every ref (templates).
    pub files: BTreeMap<String, BTreeMap<String, String>>,
    /// Merge requests created through the API, as GitLab answered them.
    pub created: Vec<Value>,
    // --- end 4C T2 ---
    // --- 5A T3 ---
    /// Project uploads, "<project path>/<secret>/<file>" (served as a PNG through the API).
    pub uploads: Vec<String>,
    // --- end 5A T3 ---
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct GitHubSeed {
    pub tokens: Vec<FakeToken>,
    pub repos: Vec<FakeProject>,
    // --- 4B: pull request seed fields go here ---
      // --- 4B T4 ---
      /// Pull requests of the seed's repositories (`github_pulls.rs`).
      pub pulls: Vec<github_pulls::FakePull>,
      /// Users who appear in pull requests without a token of their own.
      pub users: Vec<FakeUser>,
      // --- end 4B T4 ---
      // --- 4C T2 ---
      /// `/assignees`: who can be assigned or asked to review.
      pub assignees: Vec<FakeUser>,
      pub labels: Vec<FakeLabel>,
      pub files: BTreeMap<String, BTreeMap<String, String>>,
      /// Pull requests created through the API, with their reviewers, assignees and labels.
      pub created: Vec<Value>,
      // --- end 4C T2 ---
    // --- GitHub commit-author avatars ---
    /// Lowercase commit-author email → the account GitHub linked it to (`None`: commits with no
    /// linked account). `/commits?author=` answers one commit for a listed email, none otherwise.
    pub commit_authors: BTreeMap<String, Option<FakeUser>>,
    // --- end GitHub commit-author avatars ---
    // --- 5A T3 ---
    /// The one valid signature of the fake's signed image URLs (any other is expired: 403).
    pub image_jwt: String,
    // --- end 5A T3 ---
  }

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ForgeSeed {
    pub gitlab: GitLabSeed,
    pub github: GitHubSeed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Scripted {
    pub forge: String,
    pub method: String,
    pub path: String,
    pub status: u16,
    #[serde(default)]
    pub headers: Vec<(String, String)>,
    #[serde(default)]
    pub body: Value,
    pub times: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordedRequest {
    pub forge: String,
    pub method: String,
    pub path: String,
    pub query: String,
    /// A valid token came (its value is never recorded).
    pub authorized: bool,
    pub if_none_match: Option<String>,
    pub user_agent: Option<String>,
    /// The status answered (a 304: the ETag matched).
    #[serde(default)]
    pub status: u16,
}

pub struct ForgeState {
    pub seed: ForgeSeed,
    pub scripts: Vec<Scripted>,
    pub requests: Vec<RecordedRequest>,
    /// Requests served since the last reset (the rate-limit headers count down from it).
    pub served: u64,
    /// Each request waits this long before it's answered (a slow forge: the in-flight peak shows).
    pub delay_ms: u64,
    /// Requests being answered now, and the most there were at once since the last reset.
    pub in_flight: usize,
    pub peak_in_flight: usize,
    /// GitLab answers without ETags (never a 304), as some versions and proxies do.
    pub gitlab_etags_off: bool,
    /// The rate-limit headers' remaining count and reset (unix seconds), instead of the defaults.
    pub rate: Option<(u64, i64)>,
}

impl ForgeState {
    /// `(remaining, reset)` for the rate-limit headers, out of `limit`.
    pub fn rate_headers(&self, limit: u64) -> (String, String) {
        let (remaining, reset) = self.rate.unwrap_or((limit.saturating_sub(self.served), 4_102_444_800));
        (remaining.to_string(), reset.to_string())
    }
}

/// One request as the routes see it. `segments` are percent-decoded, so GitLab's
/// `projects/group%2Fproject` arrives as one `group/project` segment.
pub struct FakeRequest<'a> {
    pub method: &'a str,
    /// After the forge prefix, without the query.
    pub path: &'a str,
    pub segments: Vec<String>,
    pub query: BTreeMap<String, String>,
    pub token: Option<FakeToken>,
    pub body: &'a [u8],
    pub base: &'a str,
    // --- 5A T3 ---
    pub accept: Option<String>,
    // --- end 5A T3 ---
}

pub struct Reply {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
    pub content_type: &'static str,
}

impl Reply {
    pub fn json(v: Value) -> Self {
        Self { status: 200, headers: Vec::new(), body: v.to_string().into_bytes(), content_type: "application/json" }
    }

    pub fn status(status: u16, v: Value) -> Self {
        Self { status, ..Self::json(v) }
    }

    pub fn png() -> Self {
        Self { status: 200, headers: Vec::new(), body: FAKE_PNG.to_vec(), content_type: "image/png" }
    }

    pub fn header(mut self, k: &str, v: &str) -> Self {
        self.headers.push((k.to_string(), v.to_string()));
        self
    }

    /// `items` paged by the request's `per_page` (default 20) and `page` (default 1), with a
    /// `Link: <url?per_page=N&page=P+1>; rel="next"` while more remain. `url` is absolute, without a query.
    pub fn page(items: Vec<Value>, r: &FakeRequest, url: &str) -> Self {
        let per = r.query.get("per_page").and_then(|v| v.parse::<usize>().ok()).filter(|n| *n > 0).unwrap_or(20);
        let page = r.query.get("page").and_then(|v| v.parse::<usize>().ok()).filter(|n| *n > 0).unwrap_or(1);
        let start = (page - 1).saturating_mul(per);
        let slice: Vec<Value> = items.iter().skip(start).take(per).cloned().collect();
        let reply = Self::json(Value::Array(slice));
        if start.saturating_add(per) < items.len() { reply.header("Link", &format!("<{url}?per_page={per}&page={}>; rel=\"next\"", page.saturating_add(1))) } else { reply }
    }

    /// A 200 JSON answer gets an ETag; a request that sent the same one gets a 304.
    fn with_etag(self, if_none_match: Option<&str>) -> Self {
        if self.status != 200 || self.content_type != "application/json" {
            return self;
        }
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        self.body.hash(&mut hasher);
        let tag = format!("W/\"{:016x}\"", hasher.finish());
        let weak = |t: &str| t.trim().trim_start_matches("W/").to_string();
        let ours = weak(&tag);
        if if_none_match.is_some_and(|h| h.trim() == "*" || h.split(',').any(|t| weak(t) == ours)) {
            return Self { status: 304, body: Vec::new(), ..self }.header("ETag", &tag);
        }
        self.header("ETag", &tag)
    }
}

impl IntoResponse for Reply {
    fn into_response(self) -> Response {
        let mut b = Response::builder().status(self.status);
        if self.status != 304 {
            b = b.header("content-type", self.content_type);
        }
        for (k, v) in &self.headers {
            b = b.header(k.as_str(), v.as_str());
        }
        b.body(axum::body::Body::from(self.body)).unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
    }
}

/// Percent-decoding: `%` and two hex digits is a byte; anything else stays as it is (a path
/// keeps `+`; `parse_query` turns it into a space first).
fn decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%'
            && let Some(b) = s.get(i + 1..i + 3).and_then(|h| u8::from_str_radix(h, 16).ok())
        {
            out.push(b);
            i += 3;
            continue;
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// The log keeps no secrets: token-like query parameters become `***`.
fn redact_query(q: &str) -> String {
    q.split('&')
        .map(|p| match p.split_once('=') {
            Some((k, _)) if matches!(decode(k).as_str(), "private_token" | "access_token" | "token") => format!("{k}=***"),
            _ => p.to_string(),
        })
        .collect::<Vec<_>>()
        .join("&")
}

fn parse_query(q: &str) -> BTreeMap<String, String> {
    q.split('&').filter(|p| !p.is_empty()).map(|p| p.split_once('=').unwrap_or((p, ""))).map(|(k, v)| (decode(&k.replace('+', " ")), decode(&v.replace('+', " ")))).collect()
}

/// Days-old RFC 3339 times for the seed.
fn at(day: &str) -> String {
    format!("{day}T10:00:00Z")
}

pub fn default_seed(base: &str) -> ForgeSeed {
    let ada = FakeUser { id: 7, username: "ada".into(), name: "Ada Lovelace".into(), email: Some("ada@example.com".into()), avatar_url: Some(format!("{base}/gitlab/uploads/ada.png")) };
    let grace = FakeUser { id: 8, username: "grace".into(), name: "Grace Hopper".into(), email: Some("grace@example.com".into()), avatar_url: None };
    let octocat = FakeUser { id: 583231, username: "octocat".into(), name: "The Octocat".into(), email: Some("octocat@github.example".into()), avatar_url: Some(format!("{base}/github-avatars/u/583231")) };
    let project = |id, path: &str, fork_of: Option<&str>, day: &str| FakeProject { id, path: path.into(), default_branch: Some("main".into()), fork_of: fork_of.map(str::to_string), updated_at: at(day), settings: Value::Null, ..Default::default() };
    ForgeSeed {
        gitlab: GitLabSeed {
            version: "18.9.1-ee".into(),
            tokens: vec![
                FakeToken { token: GITLAB_TOKEN.into(), user: ada, scopes: vec!["api".into(), "read_user".into()], fine_grained: false },
                FakeToken { token: GITLAB_READONLY_TOKEN.into(), user: grace, scopes: vec!["read_api".into()], fine_grained: false },
            ],
            projects: vec![
                project(42, "group/project", None, "2026-10-04"),
                project(77, "alice/project", Some("group/project"), "2026-10-03"),
                project(78, "ada/project", Some("group/project"), "2026-09-01"),
            ],
            avatars: BTreeMap::from([("ada@example.com".to_string(), format!("{base}/gitlab/uploads/ada.png")), ("grace@example.com".to_string(), "https://secure.gravatar.com/avatar/0123".to_string())]),
            // --- 4B T2 ---
            merge_requests: gitlab_mrs::default_mrs(),
            users: gitlab_mrs::default_users(),
            // --- end 4B T2 ---
            // --- 4C T2 ---
            members: create::seed_gitlab_members(base),
            labels: create::seed_gitlab_labels(),
            files: BTreeMap::new(),
            created: Vec::new(),
            // --- end 4C T2 ---
            // --- 5A T3 ---
            uploads: vec![format!("group/project/{UPLOAD_SECRET}/shot.png")],
            // --- end 5A T3 ---
        },
        github: GitHubSeed {
            tokens: vec![
                FakeToken { token: GITHUB_TOKEN.into(), user: octocat.clone(), scopes: vec!["repo".into(), "read:user".into()], fine_grained: false },
                FakeToken { token: GITHUB_FINE_TOKEN.into(), user: octocat.clone(), scopes: vec![], fine_grained: true },
                FakeToken { token: GITHUB_READONLY_TOKEN.into(), user: octocat, scopes: vec!["read:user".into()], fine_grained: false },
            ],
            repos: vec![project(501, "octo-org/widget", None, "2026-10-04"), project(502, "octocat/widget", Some("octo-org/widget"), "2026-10-02")],
              // --- 4B T4 ---
              pulls: github_pulls::default_pulls(),
              users: github_pulls::default_users(),
              // --- end 4B T4 ---
              // --- 4C T2 ---
              assignees: create::seed_github_assignees(base),
              labels: create::seed_github_labels(),
              files: BTreeMap::new(),
              created: Vec::new(),
              // --- end 4C T2 ---
            // --- GitHub commit-author avatars ---
            commit_authors: github::seed_commit_authors(base),
            // --- end GitHub commit-author avatars ---
            // --- 5A T3 ---
            image_jwt: "jwt-1".into(),
            // --- end 5A T3 ---
          },
    }
}

#[derive(Clone)]
struct Shared {
    state: Arc<Mutex<ForgeState>>,
    base: String,
}

pub struct FakeForge {
    base: String,
    state: Arc<Mutex<ForgeState>>,
    /// Grows with every seed, script and reset: providers' fresh answers end with it.
    changes: Arc<std::sync::atomic::AtomicU64>,
}

impl FakeForge {
    pub async fn start() -> Arc<Self> {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.expect("bind the fake forge");
        let base = format!("http://{}", listener.local_addr().expect("the fake forge's address"));
        let state = Arc::new(Mutex::new(ForgeState { seed: default_seed(&base), scripts: Vec::new(), requests: Vec::new(), served: 0, delay_ms: 0, in_flight: 0, peak_in_flight: 0, gitlab_etags_off: false, rate: None }));
        let app = Router::new().fallback(handle).with_state(Shared { state: state.clone(), base: base.clone() });
        tokio::spawn(async move {
            if let Err(e) = axum::serve(listener, app).await {
                tracing::error!("fake forge stopped: {e}");
            }
        });
        Arc::new(Self { base, state, changes: Arc::default() })
    }

    pub fn base_url(&self) -> &str {
        &self.base
    }
    pub fn gitlab_web(&self) -> String {
        format!("{}/gitlab", self.base)
    }
    pub fn gitlab_api(&self) -> String {
        format!("{}/gitlab/api/v4", self.base)
    }
    pub fn github_api(&self) -> String {
        format!("{}/github", self.base)
    }
    pub fn github_web(&self) -> String {
        format!("{}/github-web", self.base)
    }
    pub fn github_avatars(&self) -> String {
        format!("{}/github-avatars", self.base)
    }
    // --- 5A T3 ---
    /// GitHub's signed `private-user-images` stand-in.
    pub fn github_images(&self) -> String {
        format!("{}/github-images", self.base)
    }
    // --- end 5A T3 ---

    fn lock(&self) -> std::sync::MutexGuard<'_, ForgeState> {
        self.state.lock().expect("fake forge poisoned")
    }

    pub fn seed(&self, seed: ForgeSeed) {
        self.lock().seed = seed;
        self.changed();
    }

    /// Time passes (a test's polls are a minute apart): answers kept fresh for `FRESH_SECS`
    /// aren't any more, as after a real wait.
    pub fn advance(&self) {
        self.changed();
    }

    fn changed(&self) {
        self.changes.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    }

    /// For `Forge::with_change_counter`: grows whenever a test changes the fake.
    pub fn change_counter(&self) -> Arc<dyn Fn() -> u64 + Send + Sync> {
        let c = self.changes.clone();
        Arc::new(move || c.load(std::sync::atomic::Ordering::SeqCst))
    }

    pub fn current_seed(&self) -> ForgeSeed {
        self.lock().seed.clone()
    }

    /// The default seed, no scripts, an empty log.
    pub fn reset(&self) {
        let mut st = self.lock();
        st.seed = default_seed(&self.base);
        st.scripts.clear();
        st.requests.clear();
        st.served = 0;
        st.delay_ms = 0;
        st.peak_in_flight = st.in_flight;
        st.gitlab_etags_off = false;
        st.rate = None;
        drop(st);
        self.changed();
    }

    pub fn script(&self, s: Scripted) {
        self.lock().scripts.push(s);
        self.changed();
    }

    pub fn requests(&self) -> Vec<RecordedRequest> {
        self.lock().requests.clone()
    }

    /// Empties the request log (and the in-flight peak), keeping the seed and scripts.
    pub fn clear_requests(&self) {
        let mut st = self.lock();
        st.requests.clear();
        st.peak_in_flight = st.in_flight;
    }

    /// Every answer's rate-limit headers say `remaining` until `reset` (unix seconds).
    pub fn set_rate(&self, remaining: u64, reset: i64) {
        self.lock().rate = Some((remaining, reset));
    }

    /// GitLab's answers come without ETags (`false`) or with them.
    pub fn set_gitlab_etags(&self, on: bool) {
        self.lock().gitlab_etags_off = !on;
    }

    /// Every request waits `ms` before it's answered.
    pub fn set_delay_ms(&self, ms: u64) {
        self.lock().delay_ms = ms;
    }

    /// The most requests answered at once since the last reset or `clear_requests`.
    pub fn peak_in_flight(&self) -> usize {
        self.lock().peak_in_flight
    }
}

/// Counts a request in flight until dropped.
struct InFlight(Arc<Mutex<ForgeState>>);

impl InFlight {
    fn start(state: &Arc<Mutex<ForgeState>>) -> (Self, u64) {
        let mut st = state.lock().expect("fake forge poisoned");
        st.in_flight += 1;
        st.peak_in_flight = st.peak_in_flight.max(st.in_flight);
        (Self(state.clone()), st.delay_ms)
    }
}

impl Drop for InFlight {
    fn drop(&mut self) {
        if let Ok(mut st) = self.0.lock() {
            st.in_flight = st.in_flight.saturating_sub(1);
        }
    }
}

async fn handle(State(s): State<Shared>, method: Method, uri: Uri, headers: HeaderMap, body: Bytes) -> Response {
    let path = uri.path().to_string();
    let query = uri.query().unwrap_or("").to_string();
    let (forge, rest) = if let Some(r) = path.strip_prefix("/gitlab") {
        ("gitlab", r)
    } else if let Some(r) = path.strip_prefix("/github-avatars") {
        ("github-avatars", r)
    } else if let Some(r) = path.strip_prefix("/github-images") {
        // --- 5A T3 ---
        ("github-images", r)
    } else if let Some(r) = path.strip_prefix("/github") {
        ("github", r)
    } else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let header = |n: &str| headers.get(n).and_then(|v| v.to_str().ok()).map(str::to_string);
    let (_in_flight, delay) = InFlight::start(&s.state);
    if delay > 0 {
        tokio::time::sleep(std::time::Duration::from_millis(delay)).await;
    }
    let bearer = header("authorization").and_then(|a| a.strip_prefix("Bearer ").map(str::to_string));
    let mut st = s.state.lock().expect("fake forge poisoned");
    let tokens = if forge == "gitlab" { &st.seed.gitlab.tokens } else { &st.seed.github.tokens };
    let token = bearer.as_deref().and_then(|b| tokens.iter().find(|t| t.token == b)).cloned();
    st.requests.push(RecordedRequest { forge: forge.into(), method: method.to_string(), path: rest.to_string(), query: redact_query(&query), authorized: token.is_some(), if_none_match: header("if-none-match"), user_agent: header("user-agent"), status: 0 });
    let logged = st.requests.len() - 1;
    st.served += 1;
    if let Some(i) = st.scripts.iter().position(|x| x.forge == forge && x.method.eq_ignore_ascii_case(method.as_str()) && x.path == rest && x.times > 0) {
        let x = &mut st.scripts[i];
        x.times -= 1;
        let mut reply = Reply::status(x.status, x.body.clone());
        for (k, v) in &x.headers {
            reply = reply.header(k, v);
        }
        st.requests[logged].status = reply.status;
        return reply.into_response();
    }
    let req = FakeRequest { method: method.as_str(), path: rest, segments: rest.split('/').filter(|p| !p.is_empty()).map(decode).collect(), query: parse_query(&query), token, body: &body, base: &s.base, accept: header("accept") };
    let reply = match forge {
        "gitlab" => gitlab::route(&mut st, &req),
        "github" => github::route(&mut st, &req),
        // --- 5A T3 ---
        "github-images" => github_pulls::image(&st, &req),
        _ => github::avatar(&req),
    };
    let reply = if forge == "gitlab" && st.gitlab_etags_off { reply } else { reply.with_etag(header("if-none-match").as_deref()) };
    st.requests[logged].status = reply.status;
    drop(st);
    reply.into_response()
}

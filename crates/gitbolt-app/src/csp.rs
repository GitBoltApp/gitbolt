//! Workers run under the app's Content Security Policy too. Tauri sends the policy only with the
//! HTML page, and a dedicated worker takes its policy from its own script's response, so a worker
//! (Monaco's, the Markdown parser's) would otherwise run with none, `eval` allowed. Every other
//! response of the app's asset protocol gets the configured policy (tauri.conf.json's, plus the
//! script hashes the build adds to it). On anything but a worker script the header does nothing.

use std::borrow::Cow;
use tauri::http::{header::CONTENT_SECURITY_POLICY, HeaderValue, Response};
use tauri::utils::config::Config;

/// The policy the page gets (`app.security.csp`; a dev build's `devCsp` first, as Tauri does),
/// as a header value. None: the app has no policy.
pub(crate) fn policy(config: &Config) -> Option<HeaderValue> {
    let security = &config.app.security;
    let csp = if tauri::is_dev() { security.dev_csp.as_ref().or(security.csp.as_ref()) } else { security.csp.as_ref() };
    HeaderValue::from_str(&csp?.to_string()).ok()
}

/// Gives `response` the policy unless it has one: an HTML page keeps Tauri's, which adds the
/// page's inline script hashes.
pub(crate) fn add_policy(policy: &HeaderValue, response: &mut Response<Cow<'static, [u8]>>) {
    response.headers_mut().entry(CONTENT_SECURITY_POLICY).or_insert_with(|| policy.clone());
}

#[cfg(test)]
mod tests {
    use super::*;
    use tauri::http::header::CONTENT_TYPE;

    fn app_policy() -> HeaderValue {
        let config: Config = serde_json::from_str(include_str!("../tauri.conf.json")).expect("tauri.conf.json parses");
        policy(&config).expect("tauri.conf.json has a policy")
    }

    fn response(content_type: &str, csp: Option<&str>) -> Response<Cow<'static, [u8]>> {
        let mut builder = Response::builder().header(CONTENT_TYPE, content_type);
        if let Some(csp) = csp {
            builder = builder.header(CONTENT_SECURITY_POLICY, csp);
        }
        builder.body(Cow::Borrowed(&b""[..])).unwrap()
    }

    /// A worker script is served with tauri.conf.json's policy: no `eval`, and only the app's own
    /// connections, as in the page.
    #[test]
    fn a_worker_script_is_served_with_the_app_policy() {
        let policy = app_policy();
        let mut worker = response("text/javascript", None);
        add_policy(&policy, &mut worker);
        let sent = worker.headers().get(CONTENT_SECURITY_POLICY).expect("a worker script carries the policy").to_str().unwrap();
        assert_eq!(sent, policy.to_str().unwrap());
        let directive = |name: &str| sent.split(';').map(str::trim).find(|d| d.split_whitespace().next() == Some(name)).unwrap_or_else(|| panic!("{name} in {sent}"));
        assert_eq!(directive("script-src"), "script-src 'self' 'wasm-unsafe-eval'");
        assert_eq!(directive("connect-src"), "connect-src 'self' ipc: http://ipc.localhost");
        assert_eq!(directive("default-src"), "default-src 'self'");
    }

    /// The page keeps the policy Tauri sent with it (the config's, plus its inline script hashes).
    #[test]
    fn the_page_keeps_tauris_policy() {
        let page_csp = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval' 'sha256-abc='";
        let mut page = response("text/html", Some(page_csp));
        add_policy(&app_policy(), &mut page);
        assert_eq!(page.headers().get_all(CONTENT_SECURITY_POLICY).iter().collect::<Vec<_>>(), [page_csp]);
    }
}

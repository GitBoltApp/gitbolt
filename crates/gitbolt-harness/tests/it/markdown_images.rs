//! Markdown images and GitHub's `body_html` against the fake forge (spec #5 §4.2, §7).

use gitbolt_core::forge::*;
use gitbolt_core::redact::Secret;
use gitbolt_forge::connector::{Forge, ForgeConfig};
use gitbolt_forge::endpoints::HostEndpoints;
use gitbolt_forge::github::GitHubProvider;
use gitbolt_forge::gitlab::GitLabProvider;
use gitbolt_harness::fake_forge::*;
use std::collections::HashMap;

const UUID: &str = "1b2c3d4e-0000-4000-8000-00000000abcd";

fn github(f: &FakeForge) -> GitHubProvider {
    GitHubProvider::new(GITHUB_HOST, &HostEndpoints { api: f.github_api(), web: f.github_web(), avatars: Some(f.github_avatars()) }, Secret::new(GITHUB_TOKEN), None)
        .with_image_bases(vec![f.github_web(), f.github_images(), f.github_avatars()])
}

fn gitlab(f: &FakeForge) -> GitLabProvider {
    GitLabProvider::new(GITLAB_HOST, &HostEndpoints { api: f.gitlab_api(), web: f.gitlab_web(), avatars: None }, Secret::new(GITLAB_TOKEN), None)
}

fn signed(f: &FakeForge, jwt: &str) -> String {
    format!("{}/583231/400001-{UUID}.png?jwt={jwt}", f.github_images())
}

#[tokio::test(flavor = "multi_thread")]
async fn github_bodies_and_comments_carry_signed_attachment_urls() {
    let f = FakeForge::start().await;
    let att = format!("{}/user-attachments/assets/{UUID}", f.github_web());
    let mut seed = f.current_seed();
    let pr = seed.github.pulls.iter_mut().find(|p| p.number == 3).unwrap();
    pr.body = format!("Before:\n\n![shot]({att})");
    pr.comments[0].body = format!("Same here ![again]({att})");
    f.seed(seed);
    let p = github(&f);
    let w = p.project("octo-org/widget").await.unwrap().value;
    let d = p.mr_detail(&w, 3).await.unwrap().value;
    assert_eq!(d.description, format!("Before:\n\n![shot]({att})"), "the Markdown is kept as written");
    let html = d.body_html.expect("the full media type's body_html");
    assert!(html.contains(&signed(&f, "jwt-1")), "{html}");
    let threads = p.discussions(&w, 3).await.unwrap().value;
    let issue = threads.iter().find(|t| t.id == "issue-41").unwrap();
    assert!(issue.notes[0].body_html.as_deref().unwrap().contains(&signed(&f, "jwt-1")));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_signed_image_loads_until_its_signature_runs_out() {
    let f = FakeForge::start().await;
    let p = github(&f);
    let w = p.project("octo-org/widget").await.unwrap().value;
    let url = signed(&f, "jwt-1");
    let got = p.image(&w, &url).expect("a GitHub image host").await.unwrap();
    assert!(matches!(got, ForgeImage::Found { ref mime, .. } if mime == "image/png"), "{got:?}");
    let mut seed = f.current_seed();
    seed.github.image_jwt = "jwt-2".into();
    f.seed(seed);
    assert_eq!(p.image(&w, &url).unwrap().await.unwrap(), ForgeImage::Expired);
    assert!(p.image(&w, "https://example.org/a.png").is_none(), "not a GitHub host: the UI asks first");
    let images: Vec<_> = f.requests().into_iter().filter(|r| r.forge == "github-images").collect();
    assert_eq!(images.len(), 2);
    assert!(images.iter().all(|r| !r.authorized), "an image host never gets the token");
}

#[tokio::test(flavor = "multi_thread")]
async fn gitlab_uploads_are_read_through_the_api_with_the_token() {
    let f = FakeForge::start().await;
    let p = gitlab(&f);
    let proj = p.project("group/project").await.unwrap().value;
    let url = format!("{}/group/project/uploads/{UPLOAD_SECRET}/shot.png", f.gitlab_web());
    assert!(matches!(p.image(&proj, &url).unwrap().await.unwrap(), ForgeImage::Found { .. }));
    let log = f.requests();
    let hit = log.iter().find(|r| r.path == format!("/api/v4/projects/42/uploads/{UPLOAD_SECRET}/shot.png")).expect("through the API");
    assert!(hit.authorized);
    let gone = format!("{}/group/project/uploads/{UPLOAD_SECRET}/gone.png", f.gitlab_web());
    assert_eq!(p.image(&proj, &gone).unwrap().await.unwrap(), ForgeImage::Missing { reason: "404".into() });
    assert!(p.image(&proj, "https://cdn.example.org/a.png").is_none());
}

#[tokio::test(flavor = "multi_thread")]
async fn gitlab_video_uploads_come_through_the_api_as_videos_by_their_bytes() {
    let f = FakeForge::start().await;
    let p = gitlab(&f);
    let proj = p.project("group/project").await.unwrap().value;
    let web = |file: &str| format!("{}/group/project/uploads/{UPLOAD_SECRET}/{file}", f.gitlab_web());
    let mime = |got: ForgeImage| match got {
        ForgeImage::Found { mime, .. } => mime,
        other => panic!("{other:?}"),
    };
    assert_eq!(mime(p.video(&proj, &web("clip.webm")).unwrap().await.unwrap()), "video/webm");
    assert_eq!(mime(p.video(&proj, &web("screen.mp4")).unwrap().await.unwrap()), "video/mp4");
    assert_eq!(p.video(&proj, &web("shot.png")).unwrap().await.unwrap(), ForgeImage::Missing { reason: "not a video GitBolt plays (application/octet-stream)".into() });
    assert_eq!(p.image(&proj, &web("clip.webm")).unwrap().await.unwrap(), ForgeImage::Missing { reason: "not an image GitBolt shows (application/octet-stream)".into() }, "an image is never a video");
    assert!(p.video(&proj, "https://cdn.example.org/a.webm").is_none());
    assert!(f.requests().iter().filter(|r| r.path.contains("/uploads/")).all(|r| r.authorized && r.path.starts_with("/api/v4/")));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_gitlab_upload_the_api_refuses_says_why() {
    let f = FakeForge::start().await;
    let api_path = format!("/api/v4/projects/42/uploads/{UPLOAD_SECRET}/shot.png");
    f.script(Scripted { forge: "gitlab".into(), method: "GET".into(), path: api_path, status: 403, headers: vec![], body: serde_json::json!({ "message": "403 Forbidden" }), times: 1 });
    let p = gitlab(&f);
    let proj = p.project("group/project").await.unwrap().value;
    let url = format!("{}/group/project/uploads/{UPLOAD_SECRET}/shot.png", f.gitlab_web());
    assert_eq!(p.image(&proj, &url).unwrap().await.unwrap(), ForgeImage::Missing { reason: "no access (403)".into() }, "GitLab signs nothing: not `Expired`");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_gitlab_without_the_uploads_api_serves_them_from_their_web_address() {
    let f = FakeForge::start().await;
    let mut seed = f.current_seed();
    seed.gitlab.no_uploads_api = true;
    f.seed(seed);
    let p = gitlab(&f);
    let proj = p.project("group/project").await.unwrap().value;
    let url = format!("{}/group/project/uploads/{UPLOAD_SECRET}/shot.png", f.gitlab_web());
    assert!(matches!(p.image(&proj, &url).unwrap().await.unwrap(), ForgeImage::Found { ref mime, .. } if mime == "image/png"));
    let asked: Vec<String> = f.requests().into_iter().filter(|r| r.path.contains("/uploads/")).map(|r| r.path).collect();
    assert_eq!(asked, [format!("/api/v4/projects/42/uploads/{UPLOAD_SECRET}/shot.png"), format!("/group/project/uploads/{UPLOAD_SECRET}/shot.png")]);
    let gone = format!("{}/group/project/uploads/{UPLOAD_SECRET}/gone.png", f.gitlab_web());
    assert_eq!(p.image(&proj, &gone).unwrap().await.unwrap(), ForgeImage::Missing { reason: "404".into() });
    // A private project's uploads want a session cookie: the web address sends to the sign-in page.
    let mut seed = f.current_seed();
    seed.gitlab.private_uploads = true;
    f.seed(seed);
    assert_eq!(p.image(&proj, &url).unwrap().await.unwrap(), ForgeImage::Missing { reason: "needs sign-in".into() });
    assert!(f.requests().iter().all(|r| !r.path.contains("sign_in")), "the sign-in page isn't fetched");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_clicked_image_loads_without_a_token_and_only_the_harness_allows_http() {
    let f = FakeForge::start().await;
    let harness = Forge::new(ForgeConfig { overrides: HashMap::new(), only_overrides: true, avatar_dir: None });
    assert!(matches!(harness.public_image(&format!("{}/u/1", f.github_avatars())).await.unwrap(), ForgeImage::Found { .. }));
    assert!(f.requests().iter().all(|r| !r.authorized));
    let app = Forge::new(ForgeConfig { overrides: HashMap::new(), only_overrides: false, avatar_dir: None });
    assert_eq!(app.public_image(&format!("{}/u/1", f.github_avatars())).await.unwrap_err().message, "GitBolt loads images over https only");
}

// --- 5A T3: a redirect off the image hosts is "ask", not an error (T2's carry-over) ---
#[tokio::test(flavor = "multi_thread")]
async fn an_image_redirected_off_githubs_hosts_asks_first_without_following() {
    let f = FakeForge::start().await;
    // `.invalid` never resolves: had GitBolt followed the redirect, it couldn't reach anything.
    f.script(Scripted {
        forge: "github-images".into(),
        method: "GET".into(),
        path: "/583231/moved.png".into(),
        status: 302,
        headers: vec![("Location".into(), "http://images.invalid/a.png".into())],
        body: serde_json::Value::Null,
        times: 1,
    });
    let p = github(&f);
    let w = p.project("octo-org/widget").await.unwrap().value;
    let url = format!("{}/583231/moved.png?jwt=jwt-1", f.github_images());
    assert_eq!(p.image(&w, &url).unwrap().await.unwrap(), ForgeImage::Ask { host: "images.invalid".into() });
    let images: Vec<_> = f.requests().into_iter().filter(|r| r.forge == "github-images").collect();
    assert_eq!(images.len(), 1, "asked once, the redirect not followed");
}

#[tokio::test(flavor = "multi_thread")]
async fn the_harness_connector_serves_githubs_markdown_images_from_the_fake() {
    let f = FakeForge::start().await;
    let overrides = HashMap::from([(GITHUB_HOST.to_string(), HostEndpoints { api: f.github_api(), web: f.github_web(), avatars: Some(f.github_avatars()) })]);
    let forge = Forge::new(ForgeConfig { overrides, only_overrides: true, avatar_dir: None }).with_image_bases(GITHUB_HOST, vec![f.github_web(), f.github_images(), f.github_avatars()]);
    let p = forge.connect(ForgeKind::GitHub, GITHUB_HOST, Secret::new(GITHUB_TOKEN)).unwrap();
    let w = p.project("octo-org/widget").await.unwrap().value;
    assert!(matches!(p.image(&w, &signed(&f, "jwt-1")).unwrap().await.unwrap(), ForgeImage::Found { .. }));
    assert!(p.image(&w, "https://private-user-images.githubusercontent.com/1/a.png").is_none(), "the real hosts are replaced: no test reaches them");
}
// --- end 5A T3 ---

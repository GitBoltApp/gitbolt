//! A commit message's summary and body, as the core's commit parser splits them.

/// `message` (decoded) with CRLF normalized to LF and trailing whitespace trimmed; its summary
/// (the first line of the first paragraph, trimmed) and its body (everything after the first
/// blank line, trimmed). Returns (message, summary, body).
pub fn split_message(message: &str) -> (String, String, String) {
    let mut message = message.replace("\r\n", "\n");
    message.truncate(message.trim_end().len());
    let first_line = |s: &str| s.lines().next().unwrap_or("").trim().to_string();
    let (summary, body) = match message.split_once("\n\n") {
        Some((s, b)) => (first_line(s), b.trim().to_string()),
        None => (first_line(&message), String::new()),
    };
    (message, summary, body)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_line_endings_and_trailing_space() {
        assert_eq!(split_message("Title\r\n\r\nBody line\r\n  \n"), ("Title\n\nBody line".to_string(), "Title".to_string(), "Body line".to_string()));
    }

    #[test]
    fn no_blank_line_means_no_body() {
        assert_eq!(split_message("One\ntwo"), ("One\ntwo".to_string(), "One".to_string(), String::new()));
        assert_eq!(split_message(""), (String::new(), String::new(), String::new()));
    }
}

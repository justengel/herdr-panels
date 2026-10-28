//! Which addresses may leave the desk and open in a browser.

use url::Url;

/// An `http` or `https` address with a host, in canonical form.
/// `file`, `javascript`, and other schemes are refused.
pub fn external_http_url(raw: &str) -> Result<String, &'static str> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Err("link is empty");
    }
    if raw.len() > 4096 || raw.chars().any(|ch| ch.is_control()) {
        return Err("link is too long");
    }
    let url = Url::parse(raw).map_err(|_| "only http and https links can be opened")?;
    if url.scheme() != "http" && url.scheme() != "https" {
        return Err("only http and https links can be opened");
    }
    if url.host_str().is_none() {
        return Err("only http and https links can be opened");
    }
    Ok(url.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn http_and_https_addresses_can_be_opened() {
        assert_eq!(
            external_http_url("https://example.com"),
            Ok("https://example.com/".into())
        );
        assert_eq!(
            external_http_url("  http://127.0.0.1:8080/app?q=1#top "),
            Ok("http://127.0.0.1:8080/app?q=1#top".into())
        );
        assert_eq!(
            external_http_url("HTTPS://Example.COM/docs"),
            Ok("https://example.com/docs".into())
        );
        assert!(external_http_url("https://user:pass@example.com/pr/1").is_ok());
    }

    #[test]
    fn other_schemes_and_broken_addresses_are_refused() {
        for raw in [
            "javascript:alert(1)",
            "file:///tmp/x",
            "file:///C:/Windows/win.ini",
            "herdr://panel",
            "data:text/html,hi",
            "about:blank",
            "ftp://example.com",
            "http://",
            "",
            "   ",
            "not a url",
            "example.com",
        ] {
            assert!(
                external_http_url(raw).is_err(),
                "{raw} should be refused"
            );
        }
        let long = format!("https://example.com/{}", "a".repeat(5000));
        assert_eq!(external_http_url(&long), Err("link is too long"));
        assert_eq!(
            external_http_url("https://exa\nmple.com/"),
            Err("link is too long")
        );
        assert_eq!(external_http_url("   "), Err("link is empty"));
    }
}

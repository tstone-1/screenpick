//! One-line error-to-message helper, shared by every module that surfaces a
//! failure to the webview as a `Result<_, String>`.
//!
//! It lives here rather than in `capture` so that needing it does not mean
//! depending on the capture stack: `documents` imported it from `capture` while
//! `capture` imported the trust gate back, which is the intra-crate cycle the
//! `capture_trust` / `capture_trust_roots` split exists to remove.

pub(crate) fn error_message(error: impl std::fmt::Display) -> String {
    error.to_string()
}

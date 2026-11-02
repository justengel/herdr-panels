//! A screenshot of one browser webview, taken by WebKitGTK.
//!
//! The page is not part of the desk DOM. html2canvas paints the empty hole, so the desktop
//! window has to snapshot this webview and hand the PNG back. This is the Linux path. Windows
//! prints the webview window instead. Do not remove it: a normal panel and a tab both need it.

use base64::Engine;
use gtk::cairo::{Context, Format, ImageSurface, Surface};
use gtk::gio::Cancellable;
use serde::Deserialize;
use tauri::webview::Webview;
use webkit2gtk::{SnapshotOptions, SnapshotRegion, WebViewExt};

#[derive(Deserialize, Clone, Copy)]
pub struct Request {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    /// Width of the webview in CSS pixels, used to find the snapshot's scale.
    pub vw: f64,
}

const PREFIX: &str = "hwp-snap:";

/// A page asked for a crop by setting its title to `hwp-snap:` plus the rectangle.
/// The answer goes back through `eval`. Drawing the element's HTML misses pictures
/// such as the Google logo, so this snapshot is what the screenshot uses.
pub fn request(view: &Webview, title: &str) {
    let Some(raw) = title.strip_prefix(PREFIX) else {
        return;
    };
    let Ok(request) = serde_json::from_str::<Request>(raw) else {
        return;
    };
    let reply = view.clone();
    capture(view, request, move |outcome| {
        let script = match outcome {
            Ok(png) => format!("window.__hwpSnapshotDone&&window.__hwpSnapshotDone(true,\"{png}\")"),
            Err(err) => format!(
                "window.__hwpSnapshotDone&&window.__hwpSnapshotDone(false,{})",
                serde_json::to_string(&err).unwrap_or_else(|_| "\"snapshot failed\"".into())
            ),
        };
        let _ = reply.eval(script);
    });
}

/// Snapshot `view` and hand the cropped base64 PNG, or the reason it failed, to `done`.
pub fn capture(view: &Webview, request: Request, done: impl FnOnce(Result<String, String>) + Send + 'static) {
    let _ = view.with_webview(move |platform| {
        platform.inner().snapshot(
            SnapshotRegion::Visible,
            SnapshotOptions::NONE,
            None::<&Cancellable>,
            move |result| done(result.map_err(|err| err.to_string()).and_then(|surface| crop(surface, &request))),
        );
    });
}

fn crop(surface: Surface, request: &Request) -> Result<String, String> {
    let image = ImageSurface::try_from(surface).map_err(|_| "the snapshot was not an image".to_string())?;
    let scale = f64::from(image.width()) / request.vw.max(1.0);
    let width = (request.w * scale).round().max(1.0) as i32;
    let height = (request.h * scale).round().max(1.0) as i32;
    let out = ImageSurface::create(Format::ARgb32, width, height).map_err(|err| err.to_string())?;
    {
        let ctx = Context::new(&out).map_err(|err| err.to_string())?;
        ctx.set_source_surface(&image, -(request.x * scale).round(), -(request.y * scale).round())
            .map_err(|err| err.to_string())?;
        ctx.paint().map_err(|err| err.to_string())?;
    }
    let mut png = Vec::new();
    out.write_to_png(&mut png).map_err(|err| err.to_string())?;
    Ok(base64::engine::general_purpose::STANDARD.encode(png))
}

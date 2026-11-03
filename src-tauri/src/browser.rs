use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use herdr_panels::external_link::external_http_url;
use tauri::webview::{NewWindowResponse, PageLoadEvent, Webview};
use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, State};
use tauri_plugin_opener::OpenerExt;
use url::Url;

const FRAME_SELECT: &str = include_str!("../../assets/frame-select.js");

pub const VIEWER: &str = "http://127.0.0.1:4737";

struct Slot {
    url: String,
    view: Webview,
    generation: u64,
    shown: bool,
    /// The native window has holes cut for a menu. Cleared when the menu closes.
    clipped: bool,
    /// Site lock reads this. Adopting the page into a tab updates it, because the
    /// navigation callback was created with the previous panel and cannot be replaced.
    panel_id: Arc<Mutex<String>>,
    /// The newest place. An older one still in flight must not put the old size back.
    seq: u64,
}

/// `0` is an unsequenced place and always applies. A smaller number is stale.
fn place_is_current(applied: u64, next: u64) -> bool {
    next == 0 || next >= applied
}

#[derive(Clone, Copy, serde::Deserialize)]
struct CssBox {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

pub struct BrowserHost {
    slots: Mutex<HashMap<String, Slot>>,
    selecting: AtomicBool,
    /// Scale of the desk window. Panel content uses `panel_zoom` instead.
    zoom: Mutex<f64>,
    panel_zoom: Mutex<HashMap<String, f64>>,
}

pub fn host() -> BrowserHost {
    BrowserHost {
        slots: Mutex::new(HashMap::new()),
        selecting: AtomicBool::new(false),
        zoom: Mutex::new(1.0),
        panel_zoom: Mutex::new(HashMap::new()),
    }
}

fn browser_page_zoom(scale: f64) -> String {
    let scale = if scale.is_finite() && scale > 0.0 {
        scale
    } else {
        1.0
    };
    format!("document.documentElement.style.zoom={scale}")
}

fn panel_content_zoom(host: &BrowserHost, label: &str) -> f64 {
    host.panel_zoom
        .lock()
        .ok()
        .and_then(|zoom| zoom.get(label).copied())
        .filter(|scale| scale.is_finite() && *scale > 0.0)
        .unwrap_or(1.0)
}

fn current_zoom(host: &BrowserHost) -> f64 {
    host.zoom.lock().map(|zoom| *zoom).unwrap_or(1.0)
}

/// Child webviews are placed in window pixels. The page reports CSS pixels, which match only at scale 1.
pub fn scale_bounds(x: f64, y: f64, width: f64, height: f64, zoom: f64) -> (f64, f64, f64, f64) {
    if !zoom.is_finite() || zoom <= 0.0 {
        return (x, y, width, height);
    }
    (x * zoom, y * zoom, width * zoom, height * zoom)
}

/// Menu rectangles in the child window's own pixels. The window keeps its full size.
fn menu_holes(page: CssBox, client_width: i32, client_height: i32, cuts: &[CssBox]) -> Vec<(i32, i32, i32, i32)> {
    if client_width < 2 || client_height < 2 || page.width < 2.0 || page.height < 2.0 {
        return Vec::new();
    }
    let scale_x = client_width as f64 / page.width;
    let scale_y = client_height as f64 / page.height;
    let mut holes = Vec::new();
    for cut in cuts {
        if ![cut.x, cut.y, cut.width, cut.height].into_iter().all(f64::is_finite) {
            continue;
        }
        if cut.width < 1.0 || cut.height < 1.0 {
            continue;
        }
        let left_css = cut.x.max(page.x);
        let top_css = cut.y.max(page.y);
        let right_css = (cut.x + cut.width).min(page.x + page.width);
        let bottom_css = (cut.y + cut.height).min(page.y + page.height);
        if right_css <= left_css || bottom_css <= top_css {
            continue;
        }
        let left = window_px((left_css - page.x) * scale_x, client_width, false);
        let top = window_px((top_css - page.y) * scale_y, client_height, false);
        let right = window_px((right_css - page.x) * scale_x, client_width, true);
        let bottom = window_px((bottom_css - page.y) * scale_y, client_height, true);
        if right - left >= 1 && bottom - top >= 1 {
            holes.push((left, top, right - left, bottom - top));
        }
    }
    holes
}

fn window_px(value: f64, limit: i32, ceil: bool) -> i32 {
    if !value.is_finite() || limit < 1 {
        return 0;
    }
    let rounded = if ceil { value.ceil() } else { value.floor() };
    rounded.clamp(0.0, limit as f64) as i32
}

fn select_boot() -> String {
    let mut script = String::from(FRAME_SELECT);
    // Pictures in the page (the Google logo) are not text. The select script asks this
    // process for a snapshot of the webview. See `answer_snap`.
    script.push_str("\nwindow.__hwpNativeSnap=true;\nwindow.__hwpInstallSelect({draw:true,send:function(){}});\n");
    script
}

fn select_on() -> String {
    let mut script = select_boot();
    script.push_str("window.__hwpSetSelect(true);\n");
    script
}

/// A browser page cannot call the viewer. It posts the PNG here, and this process opens the picker.
/// Copy, HTML, and Screenshot post `hwpLeave` on the same bridge. The page title is only a fallback:
/// a screenshot replaces that title before WebKit delivers it, so the desk never saw Select turn off.
#[cfg(target_os = "linux")]
fn arm_png_save(webkit: webkit2gtk::WebView, reply: Webview) {
    use webkit2gtk::{UserContentManagerExt, WebViewExt};
    let Some(manager) = webkit.user_content_manager() else {
        return;
    };
    if manager.register_script_message_handler("hwpSave") {
        let reply = reply.clone();
        manager.connect_script_message_received(Some("hwpSave"), move |_, result| {
            let Some(value) = result.js_value() else {
                return;
            };
            let text = value.to_string();
            let reply = reply.clone();
            std::thread::spawn(move || {
                let _ = reply.eval(png_save_reply(&text));
            });
        });
    }
    if manager.register_script_message_handler("hwpLeave") {
        let app = reply.app_handle().clone();
        manager.connect_script_message_received(Some("hwpLeave"), move |_, _| {
            schedule_end_browser_select(&app);
        });
    }
}

/// A page in a native browser webview owns its own wheel and keys, so the desk never sees Ctrl+wheel
/// or Ctrl+plus over it. Windows watches the mouse and keyboard from outside. Linux has no such hook,
/// so the page reports those chords on the `hwpZoom` bridge and `arm_zoom` forwards them to the desk.
#[cfg(target_os = "linux")]
const ZOOM_BOOT: &str = r#"(function(){
if(window.__hwpZoomBound)return;
window.__hwpZoomBound=true;
var post=function(message){try{window.webkit.messageHandlers.hwpZoom.postMessage(message);}catch(e){}};
var acc=0;
window.addEventListener('wheel',function(e){
if(!(e.ctrlKey||e.metaKey))return;
e.preventDefault();e.stopPropagation();
acc+=e.deltaY;
if(Math.abs(acc)<40)return;
post(acc<0?'wheel:1':'wheel:-1');
acc=0;
},{capture:true,passive:false});
window.addEventListener('keydown',function(e){
if(!(e.ctrlKey||e.metaKey)||e.altKey)return;
var chord=null;
if(e.key==='='||e.key==='+')chord='in';
else if(e.key==='-'||e.key==='_')chord='out';
else if(e.key==='0')chord='reset';
if(!chord)return;
e.preventDefault();e.stopPropagation();
post(chord);
},true);
})();"#;

/// Turn a zoom message from a browser page into the desk event that Windows sends for the same input.
#[cfg(target_os = "linux")]
fn zoom_script(label: &str, message: &str) -> Option<String> {
    let label_json = serde_json::to_string(label).ok()?;
    let steps = match message {
        "wheel:1" | "in" => 1,
        "wheel:-1" | "out" => -1,
        "reset" => {
            let panel = serde_json::to_string(panel_id_from_browser(label)?).ok()?;
            return Some(format!(
                "window.dispatchEvent(new CustomEvent('herdr-zoom-set',{{detail:{{panelId:{panel},scale:1}}}}))"
            ));
        }
        _ => return None,
    };
    Some(format!(
        "window.dispatchEvent(new CustomEvent('herdr-zoom-step',{{detail:{{label:{label_json},steps:{steps}}}}}))"
    ))
}

#[cfg(target_os = "linux")]
fn arm_zoom(webkit: webkit2gtk::WebView, app: AppHandle, label: String) {
    use webkit2gtk::{UserContentManagerExt, WebViewExt};
    let Some(manager) = webkit.user_content_manager() else {
        return;
    };
    if !manager.register_script_message_handler("hwpZoom") {
        return;
    }
    manager.connect_script_message_received(Some("hwpZoom"), move |_, result| {
        let Some(value) = result.js_value() else {
            return;
        };
        let Some(script) = zoom_script(&label, &value.to_string()) else {
            return;
        };
        if let Some(desk) = app.get_webview("main") {
            let _ = desk.eval(&script);
        }
    });
}

#[cfg(target_os = "linux")]
fn png_save_reply(raw: &str) -> String {
    let outcome = decode_png_save(raw).and_then(|(bytes, name)| herdr_panels::server::save_png_dialog(bytes, &name));
    match outcome {
        Ok(Some(path)) => format!(
            "window.__hwpSaveDone&&window.__hwpSaveDone(true,{});",
            serde_json::to_string(&path.display().to_string()).unwrap_or_else(|_| "\"\"".to_string())
        ),
        Ok(None) => "window.__hwpSaveDone&&window.__hwpSaveDone(true,null);".to_string(),
        Err(err) => format!(
            "window.__hwpSaveDone&&window.__hwpSaveDone(false,{});",
            serde_json::to_string(&err).unwrap_or_else(|_| "\"Could not save the screenshot\"".to_string())
        ),
    }
}

#[cfg(target_os = "linux")]
fn decode_png_save(raw: &str) -> Result<(Vec<u8>, String), String> {
    use base64::Engine;
    const MAX: usize = 32 * 1024 * 1024;
    #[derive(serde::Deserialize)]
    struct Message {
        #[serde(default)]
        name: String,
        data: String,
    }
    let message: Message = serde_json::from_str(raw).map_err(|_| "the screenshot could not be read".to_string())?;
    if message.data.len() > MAX * 4 / 3 + 8 {
        return Err("the screenshot is too large".into());
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(message.data.trim())
        .map_err(|_| "the screenshot could not be read".to_string())?;
    if bytes.len() > MAX {
        return Err("the screenshot is too large".into());
    }
    Ok((bytes, message.name))
}

pub fn browser_target(label: &str, url: &str) -> Result<Url, String> {
    if !valid_browser_label(label) {
        return Err("browser label is invalid".into());
    }
    let parsed = Url::parse(url).map_err(|_| format!("browser url is invalid: {url}"))?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err("browser url must be http or https".into());
    }
    if parsed.host_str().is_none() {
        return Err("browser url needs a host".into());
    }
    Ok(parsed)
}

fn finite_box(x: f64, y: f64, width: f64, height: f64) -> Result<(), String> {
    if [x, y, width, height].into_iter().all(f64::is_finite) {
        Ok(())
    } else {
        Err("browser bounds are invalid".into())
    }
}

fn place_view(view: &Webview, x: f64, y: f64, width: f64, height: f64, shown: &mut bool, visible: bool) -> Result<(), String> {
    if !visible || width < 2.0 || height < 2.0 {
        if *shown {
            view.hide().map_err(|err| err.to_string())?;
            *shown = false;
        }
        #[cfg(target_os = "linux")]
        crate::linux_overlay::set_shown(view, false);
        return Ok(());
    }
    view.set_position(LogicalPosition::new(x, y))
        .map_err(|err| err.to_string())?;
    view.set_size(LogicalSize::new(width, height))
        .map_err(|err| err.to_string())?;
    #[cfg(target_os = "linux")]
    crate::linux_overlay::place(view, x, y, width, height);
    if !*shown {
        view.show().map_err(|err| err.to_string())?;
        *shown = true;
    }
    #[cfg(target_os = "linux")]
    crate::linux_overlay::set_shown(view, true);
    // A webview created while the desk is reflowing (a drop onto a tab) stays blank
    // until the parent is told it moved. Do this on every place, not only the first.
    wake_browser(view);
    Ok(())
}

/// The native page does not repaint when its parent layout changes unless we ask.
fn wake_browser(view: &Webview) {
    #[cfg(windows)]
    let _ = view.with_webview(|platform| unsafe {
        let _ = platform.controller().NotifyParentWindowPositionChanged();
    });
    #[cfg(not(windows))]
    let _ = view;
}

async fn snapshot_webview(view: &Webview, width: f64, height: f64) -> Result<String, String> {
    #[cfg(windows)]
    {
        let _ = (width, height);
        return snapshot_windows(view);
    }
    #[cfg(target_os = "linux")]
    {
        return snapshot_linux(view, width, height).await;
    }
    #[cfg(not(any(windows, target_os = "linux")))]
    {
        let _ = (view, width, height);
        Err("this window cannot snapshot a browser".into())
    }
}

#[cfg(windows)]
fn snapshot_windows(view: &Webview) -> Result<String, String> {
    let hwnd = browser_hwnd_of(view)?;
    // The caller is a command thread, so the UI thread can answer the paint.
    unsafe { webview_png(hwnd, None) }
}

#[derive(serde::Deserialize, Clone, Copy)]
struct SnapRequest {
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    /// Viewport width in CSS pixels. The printed window is in physical pixels.
    vw: f64,
}

/// Copy, HTML, and Screenshot in a browser panel ask for this.
/// The page restores its own title on the next turn. The save dialog stays up.
///
/// Run this on a later turn of the main loop. The page posts it from inside WebKit,
/// and telling the desk page to run script from that callback never arrives.
fn schedule_end_browser_select(app: &AppHandle) {
    let later = app.clone();
    if app
        .run_on_main_thread(move || end_browser_select(&later))
        .is_err()
    {
        end_browser_select(app);
    }
}

fn end_browser_select(app: &AppHandle) {
    let Some(host) = app.try_state::<BrowserHost>() else {
        return;
    };
    host.selecting.store(false, Ordering::Relaxed);
    let script = "if (window.__hwpRestoreTitle) window.__hwpRestoreTitle(); if (window.__hwpSetSelect) window.__hwpSetSelect(false);";
    if let Ok(guard) = host.slots.lock() {
        for slot in guard.values() {
            let _ = slot.view.eval(script);
        }
    }
    if let Some(main) = app.get_webview("main") {
        let _ = main.eval("window.dispatchEvent(new Event('hwp-select-off'))");
    }
}

/// A page asked for its own pixels by setting the title to `hwp-snap:` plus the selection.
///
/// The Google logo is a picture. Drawing the element's HTML keeps the page background and
/// drops the picture. This returns a crop of the webview. Windows prints that window.
/// Linux asks WebKit for the same crop. Do not remove it: a normal panel and a tab both
/// screenshot as the empty panel without it.
///
/// The Windows print must not run on the UI thread. `PrintWindow` waits for the page to
/// paint, and WebView2 paints on that same thread. Waiting there froze the window until
/// Windows closed it.
fn answer_snap(view: &Webview, title: &str) {
    #[cfg(windows)]
    windows_answer_snap(view, title);
    #[cfg(target_os = "linux")]
    crate::linux_snapshot::request(view, title);
    #[cfg(not(any(windows, target_os = "linux")))]
    let _ = (view, title);
}

#[cfg(windows)]
fn windows_answer_snap(view: &Webview, title: &str) {
    let Some(raw) = title.strip_prefix("hwp-snap:") else {
        return;
    };
    let Ok(request) = serde_json::from_str::<SnapRequest>(raw) else {
        return;
    };
    let view = view.clone();
    std::thread::spawn(move || {
        let outcome = browser_hwnd_of(&view).and_then(|hwnd| unsafe { webview_png(hwnd, Some(request)) });
        let _ = view.eval(&snap_reply(outcome));
    });
}

#[cfg(windows)]
fn browser_hwnd_of(view: &Webview) -> Result<windows::Win32::Foundation::HWND, String> {
    use windows::Win32::Foundation::HWND;
    let (tx, rx) = std::sync::mpsc::channel();
    view.with_webview(move |platform| {
        let _ = tx.send(read_browser_hwnd(&platform).map(|hwnd| hwnd.0 as isize));
    })
    .map_err(|err| err.to_string())?;
    let raw = rx
        .recv_timeout(Duration::from_secs(2))
        .map_err(|_| "the snapshot timed out".to_string())??;
    Ok(HWND(raw as *mut std::ffi::c_void))
}

#[cfg(windows)]
fn read_browser_hwnd(platform: &tauri::webview::PlatformWebview) -> Result<windows::Win32::Foundation::HWND, String> {
    use windows::Win32::Foundation::HWND;
    let mut hwnd = HWND(std::ptr::null_mut());
    unsafe { platform.controller().ParentWindow(&mut hwnd) }.map_err(|err| err.to_string())?;
    if hwnd.0.is_null() {
        return Err("the browser window is missing".into());
    }
    // The WRY container clips its children, so printing it is the empty panel.
    Ok(largest_child(hwnd))
}

#[cfg(windows)]
fn snap_reply(outcome: Result<String, String>) -> String {
    match outcome {
        Ok(png) => format!("window.__hwpSnapshotDone&&window.__hwpSnapshotDone(true,\"{png}\")"),
        Err(err) => format!(
            "window.__hwpSnapshotDone&&window.__hwpSnapshotDone(false,{})",
            serde_json::to_string(&err).unwrap_or_else(|_| "\"snapshot failed\"".into())
        ),
    }
}

#[cfg(windows)]
unsafe fn webview_png(hwnd: windows::Win32::Foundation::HWND, crop: Option<SnapRequest>) -> Result<String, String> {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::Graphics::Gdi::{
        CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC, GetDIBits,
        ReleaseDC, SelectObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, HDC, HGDIOBJ,
    };
    use windows::Win32::UI::WindowsAndMessaging::GetClientRect;

    // windows 0.62 does not bind PrintWindow. PW_RENDERFULLCONTENT is 0x2. Without that flag
    // WebView2 prints a black window, and the screenshot is the empty panel behind the page.
    // Call this off the UI thread. See `windows_answer_snap`.
    #[link(name = "user32")]
    extern "system" {
        fn PrintWindow(hwnd: HWND, hdc_blt: HDC, flags: u32) -> i32;
    }

    let mut rect = windows::Win32::Foundation::RECT::default();
    if GetClientRect(hwnd, &mut rect).is_err() {
        return Err("the browser window has no size".into());
    }
    let width = rect.right.max(1);
    let height = rect.bottom.max(1);
    let screen = GetDC(Some(hwnd));
    if screen.is_invalid() {
        return Err("the browser window has no drawing context".into());
    }
    let memory = CreateCompatibleDC(Some(screen));
    let bitmap = CreateCompatibleBitmap(screen, width, height);
    let previous = SelectObject(memory, HGDIOBJ(bitmap.0));
    let printed = PrintWindow(hwnd, memory, 0x0000_0002);
    let mut info = BITMAPINFO {
        bmiHeader: BITMAPINFOHEADER {
            biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: width,
            biHeight: -height,
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB.0,
            biSizeImage: 0,
            biXPelsPerMeter: 0,
            biYPelsPerMeter: 0,
            biClrUsed: 0,
            biClrImportant: 0,
        },
        bmiColors: [windows::Win32::Graphics::Gdi::RGBQUAD::default()],
    };
    let mut pixels = vec![0u8; (width as usize) * (height as usize) * 4];
    let rows = GetDIBits(
        memory,
        bitmap,
        0,
        height as u32,
        Some(pixels.as_mut_ptr().cast()),
        &mut info,
        DIB_RGB_COLORS,
    );
    SelectObject(memory, previous);
    let _ = DeleteObject(HGDIOBJ(bitmap.0));
    let _ = DeleteDC(memory);
    let _ = ReleaseDC(Some(hwnd), screen);
    if printed == 0 || rows == 0 {
        return Err("the browser window could not be read".into());
    }
    for chunk in pixels.chunks_exact_mut(4) {
        chunk.swap(0, 2);
        chunk[3] = 255;
    }
    let (pixels, width, height) = match crop {
        Some(request) => crop_rgba(&pixels, width, height, request)?,
        None => (pixels, width as u32, height as u32),
    };
    let mut png = Vec::new();
    let mut encoder = png::Encoder::new(&mut png, width, height);
    encoder.set_color(png::ColorType::Rgba);
    encoder.set_depth(png::BitDepth::Eight);
    let mut writer = encoder.write_header().map_err(|err| err.to_string())?;
    writer.write_image_data(&pixels).map_err(|err| err.to_string())?;
    drop(writer);
    Ok(base64_encode(&png))
}

#[cfg(windows)]
fn client_area(hwnd: windows::Win32::Foundation::HWND) -> i32 {
    use windows::Win32::UI::WindowsAndMessaging::GetClientRect;
    let mut rect = windows::Win32::Foundation::RECT::default();
    if unsafe { GetClientRect(hwnd, &mut rect) }.is_err() {
        return 0;
    }
    rect.right.saturating_mul(rect.bottom).max(0)
}

/// The WebView2 window inside the WRY container. Printing the container is empty.
#[cfg(windows)]
fn largest_child(root: windows::Win32::Foundation::HWND) -> windows::Win32::Foundation::HWND {
    use windows::Win32::UI::WindowsAndMessaging::{GetWindow, GW_CHILD, GW_HWNDNEXT};
    let mut best = root;
    let mut best_area = client_area(root);
    let mut pending = vec![root];
    let mut seen = 0;
    while let Some(parent) = pending.pop() {
        let mut next = unsafe { GetWindow(parent, GW_CHILD) }.ok();
        while let Some(hwnd) = next {
            seen += 1;
            if seen > 64 || hwnd.is_invalid() {
                break;
            }
            let area = client_area(hwnd);
            if area > best_area {
                best_area = area;
                best = hwnd;
            }
            pending.push(hwnd);
            next = unsafe { GetWindow(hwnd, GW_HWNDNEXT) }.ok();
        }
    }
    best
}

#[cfg(windows)]
fn crop_rgba(pixels: &[u8], width: i32, height: i32, request: SnapRequest) -> Result<(Vec<u8>, u32, u32), String> {
    if width < 1 || height < 1 {
        return Err("the browser window has no size".into());
    }
    let scale = f64::from(width) / request.vw.max(1.0);
    if !scale.is_finite() || scale <= 0.0 {
        return Err("the snapshot scale is invalid".into());
    }
    let x = (request.x * scale).round().clamp(0.0, f64::from(width - 1)) as i32;
    let y = (request.y * scale).round().clamp(0.0, f64::from(height - 1)) as i32;
    let w = ((request.w * scale).round().max(1.0) as i32).min(width - x);
    let h = ((request.h * scale).round().max(1.0) as i32).min(height - y);
    if w < 1 || h < 1 {
        return Err("the snapshot crop is empty".into());
    }
    let mut out = Vec::with_capacity((w as usize) * (h as usize) * 4);
    for row in y..(y + h) {
        let start = ((row as usize) * (width as usize) + (x as usize)) * 4;
        let end = start + (w as usize) * 4;
        out.extend_from_slice(&pixels[start..end]);
    }
    Ok((out, w as u32, h as u32))
}

/// A snapshot of the desk page, cropped to a rectangle, as a base64 PNG. Linux only.
/// A browser panel uses `snapshot_browser` instead. This command is the main page.
#[tauri::command]
async fn snapshot_view(webview: Webview, x: f64, y: f64, width: f64, height: f64, viewport: f64) -> Result<String, String> {
    desk_page(&webview)?;
    finite_box(x, y, width, height)?;
    if width < 1.0 || height < 1.0 {
        return Err("the snapshot crop is empty".into());
    }
    #[cfg(target_os = "linux")]
    {
        let (send, receive) = tokio::sync::oneshot::channel();
        let request = crate::linux_snapshot::Request {
            x,
            y,
            w: width,
            h: height,
            vw: viewport,
        };
        crate::linux_snapshot::capture(&webview, request, move |outcome| {
            let _ = send.send(outcome);
        });
        return match tokio::time::timeout(Duration::from_secs(8), receive).await {
            Ok(Ok(outcome)) => outcome,
            Ok(Err(_)) => Err("the snapshot was cancelled".into()),
            Err(_) => Err("the snapshot timed out".into()),
        };
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = viewport;
        Err("this window cannot take a snapshot".into())
    }
}

#[cfg(target_os = "linux")]
async fn snapshot_linux(view: &Webview, width: f64, height: f64) -> Result<String, String> {
    let (send, receive) = tokio::sync::oneshot::channel();
    let request = crate::linux_snapshot::Request {
        x: 0.0,
        y: 0.0,
        w: width,
        h: height,
        vw: width,
    };
    crate::linux_snapshot::capture(view, request, move |outcome| {
        let _ = send.send(outcome);
    });
    match tokio::time::timeout(Duration::from_secs(8), receive).await {
        Ok(Ok(outcome)) => outcome,
        Ok(Err(_)) => Err("the snapshot was cancelled".into()),
        Err(_) => Err("the snapshot timed out".into()),
    }
}

#[cfg(windows)]
fn base64_encode(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    let mut index = 0;
    while index + 3 <= bytes.len() {
        let value = ((bytes[index] as u32) << 16) | ((bytes[index + 1] as u32) << 8) | bytes[index + 2] as u32;
        out.push(TABLE[((value >> 18) & 63) as usize] as char);
        out.push(TABLE[((value >> 12) & 63) as usize] as char);
        out.push(TABLE[((value >> 6) & 63) as usize] as char);
        out.push(TABLE[(value & 63) as usize] as char);
        index += 3;
    }
    let rest = bytes.len() - index;
    if rest == 1 {
        let value = (bytes[index] as u32) << 16;
        out.push(TABLE[((value >> 18) & 63) as usize] as char);
        out.push(TABLE[((value >> 12) & 63) as usize] as char);
        out.push('=');
        out.push('=');
    } else if rest == 2 {
        let value = ((bytes[index] as u32) << 16) | ((bytes[index + 1] as u32) << 8);
        out.push(TABLE[((value >> 18) & 63) as usize] as char);
        out.push(TABLE[((value >> 12) & 63) as usize] as char);
        out.push(TABLE[((value >> 6) & 63) as usize] as char);
        out.push('=');
    }
    out
}

/// Cut menu rectangles out of the native browser window. Resizing the window would reflow the site.
fn sync_menu_clip(view: &Webview, page: CssBox, cuts: Vec<CssBox>, clipped: &mut bool) {
    let punch = cuts.iter().any(|cut| cut.width >= 1.0 && cut.height >= 1.0);
    if !punch && !*clipped {
        return;
    }
    *clipped = punch;
    let _ = view.with_webview(move |platform| {
        clip_platform_webview(&platform, page, &cuts);
    });
}

fn clip_platform_webview(platform: &tauri::webview::PlatformWebview, page: CssBox, cuts: &[CssBox]) {
    #[cfg(windows)]
    unsafe {
        use windows::Win32::Foundation::{HWND, RECT};
        use windows::Win32::Graphics::Gdi::{
            CombineRgn, CreateRectRgn, DeleteObject, SetWindowRgn, HGDIOBJ, RGN_DIFF,
        };
        use windows::Win32::UI::WindowsAndMessaging::GetClientRect;

        let mut hwnd = HWND(std::ptr::null_mut());
        if platform.controller().ParentWindow(&mut hwnd).is_err() || hwnd.0.is_null() {
            return;
        }
        let mut client = RECT::default();
        if GetClientRect(hwnd, &mut client).is_err() {
            return;
        }
        let holes = menu_holes(page, client.right, client.bottom, cuts);
        if holes.is_empty() {
            let _ = SetWindowRgn(hwnd, None, true);
            return;
        }
        let full = CreateRectRgn(0, 0, client.right, client.bottom);
        if full.0.is_null() {
            return;
        }
        for (x, y, width, height) in &holes {
            let piece = CreateRectRgn(*x, *y, x + width, y + height);
            if piece.0.is_null() {
                continue;
            }
            CombineRgn(Some(full), Some(full), Some(piece), RGN_DIFF);
            let _ = DeleteObject(HGDIOBJ(piece.0));
        }
        if SetWindowRgn(hwnd, Some(full), true) == 0 {
            let _ = DeleteObject(HGDIOBJ(full.0));
        }
    }
    #[cfg(not(windows))]
    let _ = (platform, page, cuts);
}

#[tauri::command]
async fn place_browser(
    app: AppHandle,
    host: State<'_, BrowserHost>,
    label: String,
    url: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    visible: bool,
    generation: u64,
    locked: bool,
    space: String,
    cuts: Vec<CssBox>,
    reload: bool,
    seq: Option<u64>,
) -> Result<(), String> {
    let _ = (locked, space);
    let seq = seq.unwrap_or(0);
    let parsed = browser_target(&label, &url)?;
    finite_box(x, y, width, height)?;
    let page = CssBox { x, y, width, height };
    let zoom = current_zoom(&host);
    let content_zoom = panel_content_zoom(&host, &label);
    let (x, y, width, height) = scale_bounds(x, y, width, height, zoom);
    let target = parsed.as_str().to_string();
    let mut guard = host.slots.lock().map_err(|_| "browser host is locked".to_string())?;
    if let Some(slot) = guard.get_mut(&label) {
        if generation < slot.generation || !place_is_current(slot.seq, seq) {
            return Ok(());
        }
        slot.generation = generation;
        if seq > 0 {
            slot.seq = seq;
        }
        // A reload, or a page that never landed, has to navigate again. Moving the
        // window is not enough: the address-bar reload used to leave a blank webview.
        if slot.url != target || reload {
            slot.view.navigate(parsed).map_err(|err| err.to_string())?;
            slot.url = target;
        }
        place_view(
            &slot.view,
            x,
            y,
            width,
            height,
            &mut slot.shown,
            visible,
        )?;
        let mut clipped = slot.clipped;
        sync_menu_clip(&slot.view, page, cuts, &mut clipped);
        slot.clipped = clipped;
        return Ok(());
    }
    if !visible || width < 2.0 || height < 2.0 {
        return Ok(());
    }
    let window = app
        .get_window("main")
        .ok_or_else(|| "the desktop window is not open".to_string())?;
    let boot = select_boot();
    #[cfg(target_os = "linux")]
    let boot = format!("{boot}\n{ZOOM_BOOT}");
    let opener = app.clone();
    let panel_id = Arc::new(Mutex::new(
        panel_id_from_browser(&label).unwrap_or("").to_string(),
    ));
    let navigation_panel = Arc::clone(&panel_id);
    let builder = tauri::webview::WebviewBuilder::new(&label, tauri::WebviewUrl::External(parsed.clone()))
        .initialization_script(boot)
        .on_navigation(move |url| {
            let id = navigation_panel
                .lock()
                .map(|id| id.clone())
                .unwrap_or_default();
            browser_panel_link(url.as_str()) == LinkNavigation::Stay
                && navigation_permitted(&id, url.as_str())
        })
        .on_new_window(move |url, _features| {
            respond_to_new_window(&opener, &url);
            NewWindowResponse::Deny
        })
        .on_document_title_changed({
            let select_app = app.clone();
            move |view, title| {
                if title == "hwp-select:off" {
                    // Windows has no page message. Linux sends `hwpLeave` and also sets this
                    // title only when that message is missing. Either way, leave the signal
                    // before handling a snapshot title that replaces it.
                    schedule_end_browser_select(&select_app);
                    return;
                }
                answer_snap(&view, &title);
            }
        })
        .on_page_load(|webview, payload| {
            if payload.event() != PageLoadEvent::Finished {
                return;
            }
            let host = webview.state::<BrowserHost>();
            let scale = panel_content_zoom(&host, webview.label());
            if let Err(err) = webview.eval(browser_page_zoom(scale)) {
                eprintln!("browser zoom: {err}");
            }
            if !host.selecting.load(Ordering::Relaxed) {
                return;
            }
            let _ = webview.eval(select_on());
        });
    let view = window
        .add_child(
            builder,
            LogicalPosition::new(x, y),
            LogicalSize::new(width, height),
        )
        .map_err(|err| err.to_string())?;
    #[cfg(target_os = "linux")]
    crate::linux_overlay::adopt(&view, x, y, width, height);
    #[cfg(target_os = "linux")]
    {
        let reply = view.clone();
        let zoom_app = app.clone();
        let zoom_label = label.clone();
        if let Err(err) = view.with_webview(move |platform| {
            arm_zoom(platform.inner(), zoom_app, zoom_label);
            arm_png_save(platform.inner(), reply);
        }) {
            eprintln!("screenshot save: {err}");
        }
    }
    if let Err(err) = view.eval(browser_page_zoom(content_zoom)) {
        eprintln!("browser zoom: {err}");
    }
    let mut clipped = false;
    sync_menu_clip(&view, page, cuts, &mut clipped);
    #[cfg(windows)]
    {
        use windows::Win32::Foundation::HWND;
        let remembered = label.clone();
        let _ = view.with_webview(move |platform| unsafe {
            let mut parent = HWND(std::ptr::null_mut());
            if platform.controller().ParentWindow(&mut parent).is_ok() && !parent.0.is_null() {
                browser_wheel::remember_browser(parent.0 as isize, remembered);
            }
        });
    }
    guard.insert(
        label,
        Slot {
            url: target,
            view,
            generation,
            shown: true,
            clipped,
            panel_id,
            seq,
        },
    );
    Ok(())
}

#[tauri::command]
async fn set_display_zoom(app: AppHandle, host: State<'_, BrowserHost>, scale: f64) -> Result<(), String> {
    if !scale.is_finite() {
        return Err("zoom is invalid".into());
    }
    let scale = scale.clamp(0.25, 5.0);
    {
        let mut zoom = host.zoom.lock().map_err(|_| "browser host is locked".to_string())?;
        *zoom = scale;
    }
    #[cfg(windows)]
    browser_wheel::set_zoom(scale);
    let webview = app
        .get_webview("main")
        .ok_or_else(|| "the desktop window is not open".to_string())?;
    webview.set_zoom(scale).map_err(|err| err.to_string())?;
    Ok(())
}

#[tauri::command]
async fn set_browser_zoom(host: State<'_, BrowserHost>, label: String, scale: f64) -> Result<(), String> {
    if !scale.is_finite() || scale <= 0.0 {
        return Err("zoom is invalid".into());
    }
    let scale = scale.clamp(0.25, 3.0);
    {
        let mut zoom = host.panel_zoom.lock().map_err(|_| "browser host is locked".to_string())?;
        zoom.insert(label.clone(), scale);
    }
    let guard = host.slots.lock().map_err(|_| "browser host is locked".to_string())?;
    if let Some(slot) = guard.get(&label) {
        slot.view
            .eval(browser_page_zoom(scale))
            .map_err(|err| err.to_string())?;
    }
    Ok(())
}

/// Move a live browser webview onto a new label.
///
/// Dropping a browser panel onto a tab used to close `browser-{panel}` and open
/// `browser-{panel}:{tab}`. The new webview came up blank, and the address-bar reload
/// only moved that blank view. Keeping the same webview keeps the page.
#[tauri::command]
async fn adopt_browser(
    host: State<'_, BrowserHost>,
    from: String,
    to: String,
    generation: u64,
) -> Result<(), String> {
    if !valid_browser_label(&from) || !valid_browser_label(&to) {
        return Err("browser label is invalid".into());
    }
    let mut guard = host.slots.lock().map_err(|_| "browser host is locked".to_string())?;
    if from == to {
        if let Some(slot) = guard.get_mut(&from) {
            if generation >= slot.generation {
                slot.generation = generation;
            }
        }
        return Ok(());
    }
    let Some(mut slot) = guard.remove(&from) else {
        return Ok(());
    };
    if generation >= slot.generation {
        slot.generation = generation;
    }
    if let Some(next) = panel_id_from_browser(&to) {
        if let Ok(mut id) = slot.panel_id.lock() {
            *id = next.to_string();
        }
    }
    if let Some(existing) = guard.remove(&to) {
        let _ = existing.view.close();
    }
    #[cfg(windows)]
    browser_wheel::rename_browser(&from, &to);
    guard.insert(to, slot);
    Ok(())
}

/// Pixels of one browser webview, as a base64 PNG.
///
/// html2canvas paints the empty hole behind this webview, so a screenshot of Google is
/// the panel background unless the desktop window returns the webview's own image.
/// Windows prints that window. Linux snapshots it through WebKit. Do not drop this:
/// a normal panel and a tab both depend on it.
#[tauri::command]
async fn snapshot_browser(
    host: State<'_, BrowserHost>,
    label: String,
    width: f64,
    height: f64,
) -> Result<String, String> {
    if !valid_browser_label(&label) {
        return Err("browser label is invalid".into());
    }
    finite_box(0.0, 0.0, width, height)?;
    if width < 2.0 || height < 2.0 {
        return Err("browser snapshot is empty".into());
    }
    let view = {
        let guard = host.slots.lock().map_err(|_| "browser host is locked".to_string())?;
        guard
            .get(&label)
            .ok_or_else(|| "that browser panel is not open".to_string())?
            .view
            .clone()
    };
    snapshot_webview(&view, width, height).await
}

#[tauri::command]
async fn close_browser(host: State<'_, BrowserHost>, label: String, generation: u64) -> Result<(), String> {
    let mut guard = host.slots.lock().map_err(|_| "browser host is locked".to_string())?;
    let Some(slot) = guard.get(&label) else {
        return Ok(());
    };
    if slot.generation != generation {
        return Ok(());
    }
    let slot = guard.remove(&label).expect("slot was present");
    #[cfg(windows)]
    browser_wheel::forget_browser_label(&label);
    slot.view.close().map_err(|err| err.to_string())
}

#[tauri::command]
fn open_external(app: AppHandle, url: String) -> Result<String, String> {
    open_in_browser(&app, &url)
}

#[tauri::command]
fn set_frame_focus(focused: bool) {
    #[cfg(windows)]
    browser_wheel::set_frame_focus(focused);
    #[cfg(not(windows))]
    let _ = focused;
}

#[tauri::command]
fn set_desk_prefix(ctrl: bool, alt: bool, shift: bool, meta: bool, key: String) -> Result<(), String> {
    if key.is_empty() || key.len() > 16 || !key.chars().all(|ch| ch.is_ascii_graphic()) {
        return Err("prefix key is invalid".into());
    }
    #[cfg(windows)]
    browser_wheel::set_prefix(PrefixChord {
        ctrl,
        alt,
        shift,
        meta,
        key,
    });
    #[cfg(not(windows))]
    let _ = (ctrl, alt, shift, meta, key);
    Ok(())
}

/// Run one host-built script in a child webview. The page cannot call this.
#[tauri::command]
async fn eval_browser(host: State<'_, BrowserHost>, label: String, script: String) -> Result<(), String> {
    if !valid_browser_label(&label) {
        return Err("browser label is invalid".into());
    }
    let script = script.trim();
    if script.len() > 200_000
        || !(script.starts_with("window.__hwpDrive(")
            || script == "history.back()"
            || script == "history.forward()"
            || script == "location.reload()")
    {
        return Err("that browser script is not allowed".into());
    }
    let guard = host.slots.lock().map_err(|_| "browser host is locked".to_string())?;
    let slot = guard
        .get(&label)
        .ok_or_else(|| "that browser panel is not open".to_string())?;
    slot.view.eval(script).map_err(|err| err.to_string())
}

#[tauri::command]
async fn set_browser_select(host: State<'_, BrowserHost>, enabled: bool) -> Result<(), String> {
    host.selecting.store(enabled, Ordering::Relaxed);
    let script = if enabled {
        select_on()
    } else {
        "if (window.__hwpSetSelect) window.__hwpSetSelect(false);".to_string()
    };
    let guard = host.slots.lock().map_err(|_| "browser host is locked".to_string())?;
    for slot in guard.values() {
        let _ = slot.view.eval(script.clone());
    }
    Ok(())
}

/// Where a navigation or a new window should go.
#[derive(Debug, PartialEq, Eq)]
enum LinkNavigation {
    Stay,
    External,
    Refuse,
}

fn viewer_ports() -> Vec<u16> {
    let mut ports = vec![4737];
    let configured = std::env::var("HERDR_PANELS_URL")
        .ok()
        .and_then(|raw| Url::parse(raw.trim()).ok())
        .and_then(|url| url.port());
    if let Some(port) = configured {
        if !ports.contains(&port) {
            ports.push(port);
        }
    }
    ports
}

fn is_viewer(url: &Url, ports: &[u16]) -> bool {
    if url.scheme() != "http" {
        return false;
    }
    let host = url.host_str().unwrap_or("");
    if !matches!(host, "127.0.0.1" | "localhost" | "::1") {
        return false;
    }
    ports.contains(&url.port().unwrap_or(80))
}

fn is_document_about(url: &Url) -> bool {
    url.scheme() == "about" && matches!(url.path(), "blank" | "srcdoc")
}

fn main_window_link(raw: &str, ports: &[u16]) -> LinkNavigation {
    let Ok(url) = Url::parse(raw) else {
        return LinkNavigation::Refuse;
    };
    if is_viewer(&url, ports) || is_document_about(&url) {
        return LinkNavigation::Stay;
    }
    if external_http_url(raw).is_ok() {
        LinkNavigation::External
    } else {
        LinkNavigation::Refuse
    }
}

static NAV_WARNED: AtomicBool = AtomicBool::new(false);

/// Ask the viewer whether this panel may open the URL. A failed check leaves the page alone.
fn navigation_permitted(panel_id: &str, url: &str) -> bool {
    if external_http_url(url).is_err() {
        return false;
    }
    if let Some(config) = viewer_config_dir() {
        if herdr_panels::panel_lock::authoritative(&config) {
            return herdr_panels::site_lock::navigation_allowed_anywhere(&config, panel_id, url);
        }
    }
    match navigation_answer(panel_id, url) {
        Some(allow) => allow,
        None => {
            if NAV_WARNED
                .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
                .is_ok()
            {
                eprintln!("browser site check is unavailable; panel navigation is not filtered");
            }
            true
        }
    }
}

fn viewer_config_dir() -> Option<std::path::PathBuf> {
    std::env::var_os("HERDR_PANELS_CONFIG")
        .map(std::path::PathBuf::from)
        .filter(|path| !path.as_os_str().is_empty())
        .or_else(|| herdr_panels::paths::app_config_dir().ok())
}

fn navigation_answer(panel_id: &str, url: &str) -> Option<bool> {
    let base = std::env::var("HERDR_PANELS_URL").unwrap_or_else(|_| VIEWER.to_string());
    let base = base.trim().trim_end_matches('/').to_string();
    let config = viewer_config_dir()?;
    let token = herdr_panels::auth::session_token(&config).ok()?;
    let panel = url::form_urlencoded::byte_serialize(panel_id.as_bytes()).collect::<String>();
    let address = url::form_urlencoded::byte_serialize(url.as_bytes()).collect::<String>();
    let path = format!("/api/browser-navigation?panelId={panel}&url={address}");
    let parsed = url::Url::parse(&base).ok()?;
    let host = parsed.host_str()?.to_string();
    let port = parsed.port_or_known_default()?;
    let mut stream = TcpStream::connect((host.as_str(), port)).ok()?;
    stream.set_read_timeout(Some(Duration::from_millis(400))).ok()?;
    stream.set_write_timeout(Some(Duration::from_millis(400))).ok()?;
    let request = format!(
        "GET {path} HTTP/1.1\r\nHost: {host}:{port}\r\nAuthorization: Bearer {token}\r\nConnection: close\r\n\r\n"
    );
    stream.write_all(request.as_bytes()).ok()?;
    let mut buf = Vec::new();
    let mut chunk = [0u8; 1024];
    loop {
        match stream.read(&mut chunk) {
            Ok(0) => break,
            Ok(read) => {
                buf.extend_from_slice(&chunk[..read]);
                if buf.len() > 8_192 {
                    break;
                }
            }
            Err(_) => break,
        }
    }
    let text = String::from_utf8_lossy(&buf);
    let body = text.split("\r\n\r\n").nth(1).unwrap_or("");
    if body.contains("\"allow\":true") || body.contains("\"allow\": true") {
        Some(true)
    } else if body.contains("\"allow\":false") || body.contains("\"allow\": false") {
        Some(false)
    } else {
        None
    }
}

fn browser_panel_link(raw: &str) -> LinkNavigation {
    if external_http_url(raw).is_ok() {
        LinkNavigation::Stay
    } else {
        LinkNavigation::Refuse
    }
}

fn new_window_link(raw: &str) -> LinkNavigation {
    if external_http_url(raw).is_ok() {
        LinkNavigation::External
    } else {
        LinkNavigation::Refuse
    }
}

fn open_in_browser(app: &AppHandle, raw: &str) -> Result<String, String> {
    let target = external_http_url(raw)?;
    app.opener()
        .open_url(&target, None::<&str>)
        .map_err(|err| err.to_string())?;
    Ok(target)
}

fn respond_to_new_window(app: &AppHandle, url: &Url) {
    match new_window_link(url.as_str()) {
        LinkNavigation::External => {
            if let Err(err) = open_in_browser(app, url.as_str()) {
                eprintln!("could not open {url}: {err}");
            }
        }
        LinkNavigation::Refuse if url.scheme() != "about" => {
            eprintln!("refused to open {url}");
        }
        _ => {}
    }
}

fn allow_main_navigation(app: &AppHandle, url: &Url) -> bool {
    match main_window_link(url.as_str(), &viewer_ports()) {
        LinkNavigation::Stay => true,
        LinkNavigation::External => {
            if let Err(err) = open_in_browser(app, url.as_str()) {
                eprintln!("could not open {url}: {err}");
            }
            false
        }
        LinkNavigation::Refuse => {
            if url.scheme() != "about" {
                eprintln!("refused to open {url}");
            }
            false
        }
    }
}

fn desk_page(webview: &Webview) -> Result<(), String> {
    if webview.label() == "main" {
        Ok(())
    } else {
        Err(herdr_panels::desk_gate::ENABLE_REFUSED.to_string())
    }
}

/// The main page asks the viewer to turn Agent control on. A browser panel cannot.
#[tauri::command]
async fn set_cli_access(webview: Webview) -> Result<(), String> {
    desk_page(&webview)?;
    herdr_panels::desk_gate::enable_from_desk().await
}

/// Approve or cancel an unlock. Yes is refused unless this window holds the desk grant.
#[tauri::command]
async fn answer_panel_unlock(webview: Webview, id: String, yes: bool) -> Result<(), String> {
    if webview.label() != "main" {
        return Err(herdr_panels::desk_gate::UNLOCK_REFUSED.to_string());
    }
    herdr_panels::desk_gate::answer_unlock(&id, yes).await
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(host())
        .invoke_handler(tauri::generate_handler![
            place_browser,
            adopt_browser,
            snapshot_browser,
            snapshot_view,
            close_browser,
            eval_browser,
            set_browser_select,
            set_display_zoom,
            set_browser_zoom,
            cursor_place,
            set_desk_prefix,
            set_frame_focus,
            open_external,
            set_cli_access,
            answer_panel_unlock
        ])
        .setup(|app| {
            let Some(config) = app
                .config()
                .app
                .windows
                .iter()
                .find(|window| window.label == "main")
                .cloned()
            else {
                return Err("the desktop window is not configured".into());
            };
            let handle = app.handle().clone();
            let navigate = handle.clone();
            let window = tauri::WebviewWindowBuilder::from_config(app.handle(), &config)?
                .on_new_window(move |url, _features| {
                    respond_to_new_window(&handle, &url);
                    NewWindowResponse::Deny
                })
                .on_navigation(move |url| allow_main_navigation(&navigate, url))
                .build()?;
            if let Ok(raw) = std::env::var("HERDR_PANELS_URL") {
                let raw = raw.trim().trim_end_matches('/').to_string();
                if !raw.is_empty() && raw != VIEWER {
                    if let Ok(target) = format!("{raw}/").parse() {
                        let _ = window.navigate(target);
                    }
                }
            }
            #[cfg(windows)]
            browser_wheel::install(app.handle().clone());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running the desktop shell");
}

/// Where the pointer is, for zoom keys when no panel is selected.
#[derive(Debug, PartialEq, serde::Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum CursorPlace {
    Away,
    Page,
    Browser { label: String },
}

/// The pointer counts only while it is over this window and this window is in front.
pub fn cursor_place_for(over_desk: bool, desk_front: bool, browser_label: Option<String>) -> CursorPlace {
    if !over_desk || !desk_front {
        return CursorPlace::Away;
    }
    match browser_label {
        Some(label) => CursorPlace::Browser { label },
        None => CursorPlace::Page,
    }
}

#[tauri::command]
fn cursor_place() -> CursorPlace {
    #[cfg(windows)]
    {
        browser_wheel::cursor_place()
    }
    #[cfg(not(windows))]
    {
        CursorPlace::Page
    }
}

/// Ctrl or Cmd with plus, minus, or 0. Alt is left for the page.
pub fn zoom_chord_vk(vk: u16, ctrl: bool, alt: bool, meta: bool) -> Option<&'static str> {
    if alt || !(ctrl || meta) {
        return None;
    }
    match vk {
        0xBB | 0x6B => Some("in"),
        0xBD | 0x6D => Some("out"),
        0x30 | 0x60 => Some("reset"),
        _ => None,
    }
}

/// One mouse notch is 120. Positive Win32 delta rolls the wheel away from the user and zooms in.
/// A wheel that is not Ctrl, or is not over a browser panel, leaves the pending remainder untouched.
pub fn zoom_wheel_steps(pending: i32, delta: i32, ctrl: bool, over_browser: bool) -> (i32, i32) {
    if !ctrl || !over_browser || delta == 0 {
        return (pending, 0);
    }
    let delta = delta.clamp(-12_000, 12_000);
    let mut total = pending.saturating_add(delta);
    let mut steps = 0i32;
    while total >= 120 {
        total -= 120;
        steps += 1;
    }
    while total <= -120 {
        total += 120;
        steps -= 1;
    }
    (total, steps)
}

#[derive(Clone)]
pub struct PrefixChord {
    pub ctrl: bool,
    pub alt: bool,
    pub shift: bool,
    pub meta: bool,
    pub key: String,
}

pub struct KeySnap {
    pub key: String,
    pub code: String,
    pub ctrl: bool,
    pub alt: bool,
    pub shift: bool,
    pub meta: bool,
    pub repeat: bool,
    pub up: bool,
}

/// A tab page is `browser-{panel}:{tab}`. The label keeps the tab, and the panel id does not.
fn valid_browser_label(label: &str) -> bool {
    let Some(id) = label.strip_prefix("browser-") else {
        return false;
    };
    if id.is_empty() || id.len() > 49 || id.starts_with(':') || id.ends_with(':') {
        return false;
    }
    let mut colon = false;
    id.chars().all(|ch| {
        if ch == ':' {
            if colon {
                return false;
            }
            colon = true;
            return true;
        }
        ch.is_ascii_alphanumeric() || ch == '-' || ch == '_'
    })
}

pub fn panel_id_from_browser(label: &str) -> Option<&str> {
    let id = label.strip_prefix("browser-")?;
    if !valid_browser_label(label) {
        return None;
    }
    id.split(':').next().filter(|part| !part.is_empty())
}

pub fn key_from_vk(vk: u16) -> (String, String) {
    if (0x30..=0x39).contains(&vk) {
        let digit = char::from(b'0' + (vk - 0x30) as u8);
        return (digit.to_string(), format!("Digit{digit}"));
    }
    if (0x41..=0x5A).contains(&vk) {
        let letter = char::from(b'a' + (vk - 0x41) as u8);
        let code = format!("Key{}", char::from(b'A' + (vk - 0x41) as u8));
        return (letter.to_string(), code);
    }
    if (0x70..=0x7B).contains(&vk) {
        let name = format!("F{}", vk - 0x70 + 1);
        return (name.clone(), name);
    }
    let (key, code) = match vk {
        0x08 => ("Backspace", "Backspace"),
        0x09 => ("Tab", "Tab"),
        0x0D => ("Enter", "Enter"),
        0x1B => ("Escape", "Escape"),
        0x20 => (" ", "Space"),
        0x21 => ("PageUp", "PageUp"),
        0x22 => ("PageDown", "PageDown"),
        0x23 => ("End", "End"),
        0x24 => ("Home", "Home"),
        0x25 => ("ArrowLeft", "ArrowLeft"),
        0x26 => ("ArrowUp", "ArrowUp"),
        0x27 => ("ArrowRight", "ArrowRight"),
        0x28 => ("ArrowDown", "ArrowDown"),
        0x2E => ("Delete", "Delete"),
        0x10 => ("Shift", "ShiftLeft"),
        0x11 => ("Control", "ControlLeft"),
        0x12 => ("Alt", "AltLeft"),
        0x5B | 0x5C => ("Meta", "MetaLeft"),
        0xBC => (",", "Comma"),
        0xBD => ("-", "Minus"),
        0xBE => (".", "Period"),
        0xBF => ("/", "Slash"),
        _ => ("", ""),
    };
    (key.to_string(), code.to_string())
}

fn prefix_hit(chord: &PrefixChord, snap: &KeySnap) -> bool {
    if chord.ctrl != snap.ctrl || chord.alt != snap.alt || chord.meta != snap.meta {
        return false;
    }
    let named = snap.key.to_ascii_lowercase();
    let pressed = match named.as_str() {
        "arrowleft" => "left",
        "arrowright" => "right",
        "arrowup" => "up",
        "arrowdown" => "down",
        "escape" => "esc",
        " " => "space",
        other => other,
    };
    if pressed != chord.key && !(chord.key == "?" && pressed == "/") {
        return false;
    }
    if chord.shift {
        return snap.shift;
    }
    if chord.key.len() == 1 {
        let ch = chord.key.chars().next().unwrap_or(' ');
        if (ch.is_ascii_alphabetic() || ch.is_ascii_digit()) && snap.shift {
            return false;
        }
    }
    true
}

/// Window pixels under the cursor, turned into CSS pixels for `elementFromPoint`.
pub fn css_from_client(x: i32, y: i32, dpi: u32, zoom: f64) -> Option<(f64, f64)> {
    let dpi = if dpi == 0 { 96 } else { dpi };
    let zoom = if zoom.is_finite() && zoom > 0.0 { zoom } else { 1.0 };
    let css_x = x as f64 * 96.0 / f64::from(dpi) / zoom;
    let css_y = y as f64 * 96.0 / f64::from(dpi) / zoom;
    if css_x.is_finite() && css_y.is_finite() {
        Some((css_x, css_y))
    } else {
        None
    }
}

/// Where a key should go while the desk window is in front.
/// A plugin frame and a browser panel do not deliver keys to the page, so the desk takes the prefix.
/// The terminal and the rest of the page already handle it themselves.
#[derive(Debug, PartialEq, Eq)]
pub enum KeyRoute {
    Leave,
    Take { panel: Option<String> },
}

pub fn route_desk_key(
    browser_panel: Option<&str>,
    frame_focused: bool,
    armed: bool,
    chord: &PrefixChord,
    snap: &KeySnap,
) -> (bool, KeyRoute) {
    if browser_panel.is_none() && !frame_focused {
        return (armed, KeyRoute::Leave);
    }
    let (armed, relay) = child_key_action(armed, chord, snap);
    if !relay {
        return (armed, KeyRoute::Leave);
    }
    (armed, KeyRoute::Take { panel: browser_panel.map(str::to_string) })
}

fn is_modifier_key(key: &str) -> bool {
    matches!(key, "Control" | "Shift" | "Alt" | "Meta")
}

/// Keep a key only while one of our own windows has the keyboard and a child is using it.
/// Any other key is left alone. This is not a system-wide hook.
pub fn capture_prefix(
    pointer_over_desk: bool,
    desk_front: bool,
    frame_focused: bool,
    panel: Option<&str>,
    armed: bool,
    chord: &PrefixChord,
    snap: &KeySnap,
) -> (bool, KeyRoute) {
    let typing = !snap.up && !is_modifier_key(&snap.key);
    if !pointer_over_desk || !desk_front || (panel.is_none() && !frame_focused) {
        let armed = if typing { false } else { armed };
        return (armed, KeyRoute::Leave);
    }
    route_desk_key(panel, frame_focused, armed, chord, snap)
}

/// `(armed afterwards, forward this key to the desk)`.
pub fn child_key_action(armed: bool, chord: &PrefixChord, snap: &KeySnap) -> (bool, bool) {
    if snap.up || matches!(snap.key.as_str(), "Control" | "Shift" | "Alt" | "Meta") {
        return (armed, false);
    }
    if !armed {
        if snap.repeat || !prefix_hit(chord, snap) {
            return (false, false);
        }
        return (true, true);
    }
    if prefix_hit(chord, snap) {
        return (true, false);
    }
    (false, true)
}

#[cfg(windows)]
mod browser_wheel {
    use std::io::Write;
    use std::sync::atomic::{AtomicBool, AtomicIsize, Ordering};
    use std::sync::{Mutex, OnceLock};
    use std::time::Duration;

    use tauri::{AppHandle, Manager};
    use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, POINT, WPARAM};
    use windows::Win32::Graphics::Gdi::ScreenToClient;
    use windows::Win32::UI::HiDpi::GetDpiForWindow;
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        GetAsyncKeyState, GetFocus, VK_CONTROL, VK_LWIN, VK_MENU, VK_RWIN, VK_SHIFT,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        CallNextHookEx, GetAncestor, GetCursorPos, GetForegroundWindow, GetParent, GetWindowThreadProcessId,
        SetWindowsHookExW, WindowFromPoint, GA_ROOT, HHOOK, MOUSEHOOKSTRUCT, MOUSEHOOKSTRUCTEX, WH_KEYBOARD, WH_MOUSE,
        WM_LBUTTONDOWN, WM_MOUSEWHEEL, WM_RBUTTONDOWN,
    };

    use super::{
        capture_prefix, css_from_client, key_from_vk, panel_id_from_browser, zoom_chord_vk, zoom_wheel_steps, KeyRoute,
        KeySnap, PrefixChord,
    };

    static APP: Mutex<Option<AppHandle>> = Mutex::new(None);
    static DESK: AtomicIsize = AtomicIsize::new(0);
    static PENDING: Mutex<i32> = Mutex::new(0);
    static ZOOM: Mutex<f64> = Mutex::new(1.0);
    static FRAME_FOCUS: AtomicBool = AtomicBool::new(false);
    static BROWSERS: Mutex<Vec<(isize, String)>> = Mutex::new(Vec::new());
    static HELD: Mutex<Option<u16>> = Mutex::new(None);
    static WORK: OnceLock<std::sync::mpsc::SyncSender<HookWork>> = OnceLock::new();

    enum HookWork {
        Eval(String),
        Zoom { label: String, steps: i32 },
        Click(POINT),
    }
    static PREFIX: Mutex<(bool, PrefixChord)> = Mutex::new((
        false,
        PrefixChord {
            ctrl: true,
            alt: false,
            shift: false,
            meta: false,
            key: String::new(),
        },
    ));

    pub fn install(app: AppHandle) {
        std::thread::spawn(move || {
            for _ in 0..50 {
                if remember_desk(&app) {
                    break;
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            if DESK.load(Ordering::Relaxed) == 0 {
                note("desktop input hook skipped: no window");
                return;
            }
            if let Ok(mut slot) = APP.lock() {
                *slot = Some(app.clone());
            }
            let (tx, rx) = std::sync::mpsc::sync_channel(32);
            let _ = WORK.set(tx);
            std::thread::spawn(move || {
                while let Ok(work) = rx.recv() {
                    match work {
                        HookWork::Eval(script) => relay_eval(script),
                        HookWork::Zoom { label, steps } => emit(&label, steps),
                        HookWork::Click(pt) => {
                            if let Some(script) = focus_script(pt) {
                                relay_eval(script);
                            }
                        }
                    }
                }
            });
            let _ = app.run_on_main_thread(install_window_hooks);
        });
    }

    /// Hooks for this window's thread only. A system-wide hook would run ahead of Synergy.
    fn install_window_hooks() {
        let desk = DESK.load(Ordering::Relaxed);
        if desk == 0 {
            return;
        }
        let thread = unsafe { GetWindowThreadProcessId(HWND(desk as *mut std::ffi::c_void), None) };
        if thread == 0 {
            return;
        }
        unsafe {
            match SetWindowsHookExW(WH_MOUSE, Some(mouse_hook), None, thread) {
                Ok(hook) => {
                    let _ = hook;
                }
                Err(err) => note(&format!("desktop mouse hook failed: {err}")),
            }
            match SetWindowsHookExW(WH_KEYBOARD, Some(key_hook), None, thread) {
                Ok(hook) => {
                    let _ = hook;
                }
                Err(err) => note(&format!("desktop key hook failed: {err}")),
            }
        }
    }

    fn remember_desk(app: &AppHandle) -> bool {
        let (tx, rx) = std::sync::mpsc::channel();
        let posted = app.clone();
        if app
            .clone()
            .run_on_main_thread(move || {
                let hwnd = posted.get_window("main").and_then(|window| window.hwnd().ok());
                let _ = tx.send(hwnd.map(|hwnd| hwnd.0 as isize));
            })
            .is_err()
        {
            return false;
        }
        match rx.recv_timeout(Duration::from_secs(2)) {
            Ok(Some(hwnd)) if hwnd != 0 => {
                DESK.store(hwnd, Ordering::Relaxed);
                true
            }
            _ => false,
        }
    }

    fn enqueue(work: HookWork) -> bool {
        WORK.get().is_some_and(|tx| tx.try_send(work).is_ok())
    }

    pub fn cursor_place() -> super::CursorPlace {
        let mut point = POINT { x: 0, y: 0 };
        if unsafe { GetCursorPos(&mut point) }.is_err() {
            return super::CursorPlace::Away;
        }
        let hwnd = unsafe { WindowFromPoint(point) };
        let over_desk = hwnd_in_desk(hwnd);
        let desk = DESK.load(Ordering::Relaxed);
        let front = unsafe { GetForegroundWindow() };
        let desk_front = desk != 0
            && !front.0.is_null()
            && unsafe { GetAncestor(front, GA_ROOT) }.0 as isize == desk;
        let label = if over_desk { browser_label_at(hwnd) } else { None };
        super::cursor_place_for(over_desk, desk_front, label)
    }

    fn hwnd_in_desk(hwnd: HWND) -> bool {
        if hwnd.0.is_null() {
            return false;
        }
        let desk = DESK.load(Ordering::Relaxed);
        desk != 0 && unsafe { GetAncestor(hwnd, GA_ROOT) }.0 as isize == desk
    }

    unsafe extern "system" fn mouse_hook(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        if code == 0 {
            let info = unsafe { &*(lparam.0 as *const MOUSEHOOKSTRUCT) };
            if hwnd_in_desk(info.hwnd) {
                if wparam.0 == WM_LBUTTONDOWN as usize || wparam.0 == WM_RBUTTONDOWN as usize {
                    let _ = enqueue(HookWork::Click(info.pt));
                }
                if wparam.0 == WM_MOUSEWHEEL as usize {
                    let wheel = unsafe { &*(lparam.0 as *const MOUSEHOOKSTRUCTEX) };
                    let delta = (wheel.mouseData >> 16) as i16 as i32;
                    let ctrl = unsafe { GetAsyncKeyState(VK_CONTROL.0 as i32) } < 0;
                    if let Some(label) = browser_label_at(info.hwnd) {
                        if let Ok(mut pending) = PENDING.try_lock() {
                            let saved = *pending;
                            let (next, steps) = zoom_wheel_steps(*pending, delta, ctrl, true);
                            *pending = next;
                            drop(pending);
                            if ctrl && (steps == 0 || enqueue(HookWork::Zoom { label, steps })) {
                                return LRESULT(1);
                            }
                            if let Ok(mut pending) = PENDING.try_lock() {
                                *pending = saved;
                            }
                        }
                    }
                }
            }
        }
        unsafe { CallNextHookEx(None::<HHOOK>, code, wparam, lparam) }
    }

    fn browser_label_at(hwnd: HWND) -> Option<String> {
        if hwnd.0.is_null() {
            return None;
        }
        let desk = DESK.load(Ordering::Relaxed);
        let browsers = BROWSERS.lock().unwrap_or_else(|err| err.into_inner());
        let mut current = hwnd.0 as isize;
        for _ in 0..24 {
            if current == 0 || current == desk {
                return None;
            }
            if let Some((_, label)) = browsers.iter().find(|(known, _)| *known == current) {
                return Some(label.clone());
            }
            current = unsafe { GetParent(HWND(current as *mut _)) }
                .map(|parent| parent.0 as isize)
                .unwrap_or(0);
        }
        None
    }

    fn emit(label: &str, steps: i32) {
        let Ok(guard) = APP.lock() else {
            return;
        };
        let Some(app) = guard.clone() else {
            return;
        };
        drop(guard);
        let label = serde_json::to_string(label).unwrap_or_else(|_| "\"\"".into());
        let script = format!(
            "window.dispatchEvent(new CustomEvent('herdr-zoom-step',{{detail:{{label:{label},steps:{steps}}}}}))"
        );
        let _ = app.clone().run_on_main_thread(move || {
            if let Some(webview) = app.get_webview("main") {
                let _ = webview.eval(&script);
                note(&format!("desktop zoom {steps}"));
            }
        });
    }

    pub fn remember_browser(hwnd: isize, label: String) {
        if hwnd == 0 {
            return;
        }
        let mut browsers = BROWSERS.lock().unwrap_or_else(|err| err.into_inner());
        browsers.retain(|(known, name)| *known != hwnd && name != &label);
        browsers.push((hwnd, label));
    }

    pub fn forget_browser_label(label: &str) {
        let mut browsers = BROWSERS.lock().unwrap_or_else(|err| err.into_inner());
        browsers.retain(|(_, known)| known != label);
    }

    pub fn rename_browser(from: &str, to: &str) {
        let mut browsers = BROWSERS.lock().unwrap_or_else(|err| err.into_inner());
        for (_, name) in browsers.iter_mut() {
            if name == from {
                *name = to.to_string();
            }
        }
    }

    pub fn set_zoom(scale: f64) {
        if let Ok(mut zoom) = ZOOM.lock() {
            *zoom = scale;
        }
    }

    pub fn set_frame_focus(focused: bool) {
        FRAME_FOCUS.store(focused, Ordering::Relaxed);
    }

    /// A click on a child webview or a plugin frame never reaches the page. Hit-test the page instead.
    fn focus_script(pt: POINT) -> Option<String> {
        let desk = DESK.load(Ordering::Relaxed);
        if desk == 0 {
            return None;
        }
        let hwnd = unsafe { WindowFromPoint(pt) };
        if hwnd.0.is_null() || hwnd.0 as isize == desk {
            return None;
        }
        if unsafe { GetAncestor(hwnd, GA_ROOT) }.0 as isize != desk {
            return None;
        }
        let mut local = pt;
        if !unsafe { ScreenToClient(HWND(desk as *mut std::ffi::c_void), &mut local) }.as_bool() {
            return None;
        }
        let dpi = unsafe { GetDpiForWindow(HWND(desk as *mut std::ffi::c_void)) };
        let zoom = ZOOM.lock().ok().map(|zoom| *zoom).unwrap_or(1.0);
        let (x, y) = css_from_client(local.x, local.y, dpi, zoom)?;
        Some(format!("window.__hwpFocusAt&&window.__hwpFocusAt({x:.1},{y:.1})"))
    }

    pub fn set_prefix(chord: PrefixChord) {
        let mut prefix = PREFIX.lock().unwrap_or_else(|err| err.into_inner());
        *prefix = (false, chord);
    }

    fn focused_browser_panel() -> Option<String> {
        let focus = unsafe { GetFocus() };
        if !hwnd_in_desk(focus) {
            return None;
        }
        let desk = DESK.load(Ordering::Relaxed);
        let browsers = BROWSERS.lock().unwrap_or_else(|err| err.into_inner());
        let mut current = focus.0 as isize;
        for _ in 0..24 {
            if current == 0 || current == desk {
                return None;
            }
            if let Some((_, label)) = browsers.iter().find(|(hwnd, _)| *hwnd == current) {
                return panel_id_from_browser(label).map(str::to_string);
            }
            current = unsafe { GetParent(HWND(current as *mut _)) }
                .map(|hwnd| hwnd.0 as isize)
                .unwrap_or(0);
        }
        None
    }

    /// True when this window keeps the key. Other programs never reach this hook.
    fn take_child_key(vk: u16, up: bool) -> bool {
        let (key, code) = key_from_vk(vk);
        let Ok(mut held) = HELD.try_lock() else {
            return false;
        };
        let repeat = !up && *held == Some(vk);
        if up {
            if *held == Some(vk) {
                *held = None;
            }
        } else {
            *held = Some(vk);
        }
        drop(held);
        let snap = KeySnap {
            key,
            code,
            ctrl: unsafe { GetAsyncKeyState(VK_CONTROL.0 as i32) } < 0,
            alt: unsafe { GetAsyncKeyState(VK_MENU.0 as i32) } < 0,
            shift: unsafe { GetAsyncKeyState(VK_SHIFT.0 as i32) } < 0,
            meta: unsafe { GetAsyncKeyState(VK_LWIN.0 as i32) } < 0
                || unsafe { GetAsyncKeyState(VK_RWIN.0 as i32) } < 0,
            repeat,
            up,
        };
        let Ok(mut prefix) = PREFIX.try_lock() else {
            return false;
        };
        if prefix.1.key.is_empty() {
            prefix.1.key = "b".into();
            prefix.1.ctrl = true;
        }
        let panel = focused_browser_panel();
        let ours = hwnd_in_desk(unsafe { GetFocus() });
        let (armed, route) = capture_prefix(
            ours,
            ours,
            FRAME_FOCUS.load(Ordering::Relaxed),
            panel.as_deref(),
            prefix.0,
            &prefix.1,
            &snap,
        );
        let KeyRoute::Take { panel } = route else {
            prefix.0 = armed;
            return false;
        };
        let script = match panel {
            Some(panel) => relay_script(&panel, &snap),
            None => relay_key_script(&snap),
        };
        if !enqueue(HookWork::Eval(script)) {
            return false;
        }
        prefix.0 = armed;
        true
    }

    fn relay_key_script(snap: &KeySnap) -> String {
        let key = serde_json::to_string(&snap.key).unwrap_or_else(|_| "\"\"".into());
        let code = serde_json::to_string(&snap.code).unwrap_or_else(|_| "\"\"".into());
        format!(
            "window.__hwpRelayKey&&window.__hwpRelayKey({{key:{key},code:{code},ctrlKey:{},altKey:{},shiftKey:{},metaKey:{},repeat:{}}})",
            snap.ctrl, snap.alt, snap.shift, snap.meta, snap.repeat
        )
    }

    fn relay_script(panel_id: &str, snap: &KeySnap) -> String {
        let id = serde_json::to_string(panel_id).unwrap_or_else(|_| "\"\"".into());
        let key = serde_json::to_string(&snap.key).unwrap_or_else(|_| "\"\"".into());
        let code = serde_json::to_string(&snap.code).unwrap_or_else(|_| "\"\"".into());
        format!(
            "window.__hwpFocusPanel&&window.__hwpFocusPanel({id});window.__hwpRelayKey&&window.__hwpRelayKey({{key:{key},code:{code},ctrlKey:{},altKey:{},shiftKey:{},metaKey:{},repeat:{}}})",
            snap.ctrl, snap.alt, snap.shift, snap.meta, snap.repeat
        )
    }

    fn relay_eval(script: String) {
        let Some(app) = APP.lock().ok().and_then(|guard| guard.clone()) else {
            return;
        };
        let _ = app.clone().run_on_main_thread(move || {
            if let Some(webview) = app.get_webview("main") {
                let _ = webview.eval(&script);
            }
        });
    }

    unsafe extern "system" fn key_hook(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        if code == 0 && hwnd_in_desk(unsafe { GetFocus() }) {
            let up = (lparam.0 as u32) & 0x8000_0000 != 0;
            // The main page handles its own zoom keys. A browser panel and a plugin frame do not deliver them.
            // A plugin frame reports its own zoom keys. Only a browser window does not.
            let child = focused_browser_panel().is_some();
            if !up && child {
                let ctrl = unsafe { GetAsyncKeyState(VK_CONTROL.0 as i32) } < 0;
                let alt = unsafe { GetAsyncKeyState(VK_MENU.0 as i32) } < 0;
                let meta = unsafe { GetAsyncKeyState(VK_LWIN.0 as i32) } < 0
                    || unsafe { GetAsyncKeyState(VK_RWIN.0 as i32) } < 0;
                if let Some(chord) = zoom_chord_vk(wparam.0 as u16, ctrl, alt, meta) {
                    let detail = serde_json::to_string(chord).unwrap_or_else(|_| "\"\"".into());
                    let script =
                        format!("window.dispatchEvent(new CustomEvent('herdr-zoom-chord',{{detail:{detail}}}))");
                    if enqueue(HookWork::Eval(script)) {
                        return LRESULT(1);
                    }
                }
            }
            if take_child_key(wparam.0 as u16, up) {
                return LRESULT(1);
            }
        }
        unsafe { CallNextHookEx(None::<HHOOK>, code, wparam, lparam) }
    }

    fn note(message: &str) {
        let mut err = std::io::stderr().lock();
        let _ = writeln!(err, "{message}");
        let _ = err.flush();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_menu_cuts_a_hole_and_leaves_the_page_size_alone() {
        let page = CssBox {
            x: 100.0,
            y: 80.0,
            width: 600.0,
            height: 400.0,
        };
        let outside = CssBox {
            x: 800.0,
            y: 80.0,
            width: 180.0,
            height: 240.0,
        };
        assert!(menu_holes(page, 600, 400, &[outside]).is_empty());
        let menu = CssBox {
            x: 500.0,
            y: 80.0,
            width: 200.0,
            height: 240.0,
        };
        assert_eq!(menu_holes(page, 600, 400, &[menu]), vec![(400, 0, 200, 240)]);
        assert_eq!(menu_holes(page, 900, 600, &[menu]), vec![(600, 0, 300, 360)]);
    }

    #[test]
    fn an_older_place_does_not_replace_a_newer_one() {
        assert!(place_is_current(0, 1));
        assert!(place_is_current(4, 4));
        assert!(place_is_current(4, 5));
        assert!(!place_is_current(5, 4));
        assert!(place_is_current(5, 0));
    }

    #[test]
    fn browser_panels_are_placed_in_window_pixels() {
        assert_eq!(scale_bounds(10.0, 20.0, 100.0, 50.0, 1.0), (10.0, 20.0, 100.0, 50.0));
        assert_eq!(scale_bounds(10.0, 20.0, 100.0, 50.0, 1.5), (15.0, 30.0, 150.0, 75.0));
        assert_eq!(scale_bounds(10.0, 20.0, 100.0, 50.0, 0.0), (10.0, 20.0, 100.0, 50.0));
    }

    #[test]
    fn an_http_page_can_be_a_browser_panel() {
        let url = browser_target("browser-panel-5", "https://example.com/docs").unwrap();
        assert_eq!(url.scheme(), "https");
        assert!(browser_target("browser-notes", "http://127.0.0.1:8080/app").is_ok());
        assert!(browser_target("browser-panel-3:tab-2", "https://www.google.com/").is_ok());
        assert!(browser_target("browser-panel-3:tab-2:extra", "https://example.com").is_err());
    }

    #[test]
    fn scripts_files_and_foreign_labels_stay_out() {
        assert!(browser_target("browser-panel-5", "javascript:alert(1)").is_err());
        assert!(browser_target("browser-panel-5", "file:///tmp/x").is_err());
        assert!(browser_target("main", "https://example.com").is_err());
        assert!(browser_target("browser-../x", "https://example.com").is_err());
    }

    #[test]
    fn a_browser_panel_forwards_the_prefix_and_the_next_key() {
        let chord = PrefixChord {
            ctrl: true,
            alt: false,
            shift: false,
            meta: false,
            key: "b".into(),
        };
        let prefix = KeySnap {
            key: "b".into(),
            code: "KeyB".into(),
            ctrl: true,
            alt: false,
            shift: false,
            meta: false,
            repeat: false,
            up: false,
        };
        assert_eq!(child_key_action(false, &chord, &prefix), (true, true));
        let held = KeySnap {
            key: "b".into(),
            code: "KeyB".into(),
            ctrl: true,
            alt: false,
            shift: false,
            meta: false,
            repeat: true,
            up: false,
        };
        assert_eq!(child_key_action(true, &chord, &held), (true, false));
        let letter = KeySnap {
            key: "z".into(),
            code: "KeyZ".into(),
            ctrl: false,
            alt: false,
            shift: false,
            meta: false,
            repeat: false,
            up: false,
        };
        assert_eq!(child_key_action(false, &chord, &letter), (false, false));
        assert_eq!(child_key_action(true, &chord, &letter), (false, true));
        assert_eq!(
            route_desk_key(None, true, false, &chord, &prefix),
            (true, KeyRoute::Take { panel: None })
        );
        assert_eq!(route_desk_key(None, false, false, &chord, &prefix).1, KeyRoute::Leave);
        assert_eq!(route_desk_key(None, true, false, &chord, &letter).1, KeyRoute::Leave);
        assert_eq!(
            route_desk_key(Some("panel-1"), false, false, &chord, &prefix),
            (true, KeyRoute::Take { panel: Some("panel-1".into()) })
        );
        let outside = capture_prefix(false, true, true, None, false, &chord, &prefix);
        assert_eq!(outside.1, KeyRoute::Leave);
        let away = capture_prefix(true, false, true, Some("panel-1"), true, &chord, &letter);
        assert_eq!(away, (false, KeyRoute::Leave));
        assert_eq!(
            capture_prefix(true, true, true, None, false, &chord, &prefix).1,
            KeyRoute::Take { panel: None }
        );
        assert_eq!(
            capture_prefix(true, true, true, None, true, &chord, &letter).1,
            KeyRoute::Take { panel: None }
        );
        let held_ctrl = KeySnap {
            key: "Control".into(),
            code: "ControlLeft".into(),
            ctrl: true,
            alt: false,
            shift: false,
            meta: false,
            repeat: false,
            up: false,
        };
        assert_eq!(capture_prefix(false, true, true, None, true, &chord, &held_ctrl).0, true);
        assert_eq!(key_from_vk(0x42), ("b".into(), "KeyB".into()));
        assert_eq!(key_from_vk(0xBC), (",".into(), "Comma".into()));
        assert_eq!(css_from_client(200, 100, 96, 1.0), Some((200.0, 100.0)));
        assert_eq!(css_from_client(200, 100, 192, 1.0), Some((100.0, 50.0)));
        assert_eq!(css_from_client(200, 100, 96, 2.0), Some((100.0, 50.0)));
        assert_eq!(panel_id_from_browser("browser-panel-1"), Some("panel-1"));
        assert_eq!(panel_id_from_browser("browser-panel-1:tab-2"), Some("panel-1"));
        assert_eq!(panel_id_from_browser("browser-panel-1:tab-2:nope"), None);
        assert_eq!(panel_id_from_browser("main"), None);
    }

    #[test]
    fn the_desktop_window_opens_http_links_outside_and_keeps_its_own_page() {
        let ports = [4737];
        assert_eq!(
            main_window_link("http://127.0.0.1:4737/", &ports),
            LinkNavigation::Stay
        );
        assert_eq!(
            main_window_link("http://localhost:4737/plugins/checkin-report", &ports),
            LinkNavigation::Stay
        );
        assert_eq!(main_window_link("about:blank", &ports), LinkNavigation::Stay);
        assert_eq!(main_window_link("about:srcdoc", &ports), LinkNavigation::Stay);
        assert_eq!(
            main_window_link("https://example.com/docs", &ports),
            LinkNavigation::External
        );
        assert_eq!(
            main_window_link("http://127.0.0.1:8080/app", &ports),
            LinkNavigation::External
        );
        assert_eq!(
            main_window_link("file:///tmp/x", &ports),
            LinkNavigation::Refuse
        );
        assert_eq!(
            main_window_link("javascript:alert(1)", &ports),
            LinkNavigation::Refuse
        );
        assert_eq!(
            main_window_link("herdr://panel", &ports),
            LinkNavigation::Refuse
        );
        assert_eq!(
            browser_panel_link("https://example.com/docs"),
            LinkNavigation::Stay
        );
        assert_eq!(browser_panel_link("file:///tmp/x"), LinkNavigation::Refuse);
        assert_eq!(
            browser_panel_link("javascript:alert(1)"),
            LinkNavigation::Refuse
        );
        assert_eq!(
            new_window_link("https://example.com/pr/1"),
            LinkNavigation::External
        );
        assert_eq!(new_window_link("http://example.com"), LinkNavigation::External);
        assert_eq!(new_window_link("about:blank"), LinkNavigation::Refuse);
        assert_eq!(new_window_link("file:///tmp/x"), LinkNavigation::Refuse);
        assert_eq!(new_window_link("javascript:alert(1)"), LinkNavigation::Refuse);
        assert_eq!(new_window_link("herdr://panel"), LinkNavigation::Refuse);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn a_page_zoom_message_becomes_the_desk_zoom_event() {
        let step = zoom_script("browser-panel-3", "wheel:-1").unwrap();
        assert!(step.contains("herdr-zoom-step") && step.contains("\"browser-panel-3\"") && step.contains("steps:-1"));
        let reset = zoom_script("browser-panel-3", "reset").unwrap();
        assert!(reset.contains("herdr-zoom-set") && reset.contains("\"panel-3\"") && reset.contains("scale:1"));
        assert!(zoom_script("browser-panel-3", "sideways").is_none());
    }

    #[test]
    fn ctrl_wheel_over_a_browser_panel_steps_that_panel() {
        assert_eq!(zoom_wheel_steps(0, 120, true, true), (0, 1));
        assert_eq!(zoom_wheel_steps(0, -240, true, true), (0, -2));
        assert_eq!(zoom_wheel_steps(40, 80, true, true), (0, 1));
        assert_eq!(zoom_wheel_steps(40, 120, false, true), (40, 0));
        assert_eq!(zoom_wheel_steps(40, 120, true, false), (40, 0));
        assert_eq!(zoom_wheel_steps(0, 0, true, true), (0, 0));
        assert_eq!(zoom_chord_vk(0xBB, true, false, false), Some("in"));
        assert_eq!(zoom_chord_vk(0xBD, true, false, false), Some("out"));
        assert_eq!(zoom_chord_vk(0x30, true, false, false), Some("reset"));
        assert_eq!(zoom_chord_vk(0x30, true, true, false), None);
        assert_eq!(zoom_chord_vk(0x41, true, false, false), None);
    }

    #[test]
    fn zoom_keys_use_the_pointer_only_while_this_window_is_in_front() {
        assert_eq!(cursor_place_for(false, true, None), CursorPlace::Away);
        assert_eq!(
            cursor_place_for(true, false, Some("browser-notes".into())),
            CursorPlace::Away
        );
        assert_eq!(cursor_place_for(true, true, None), CursorPlace::Page);
        assert_eq!(
            cursor_place_for(true, true, Some("browser-notes".into())),
            CursorPlace::Browser {
                label: "browser-notes".into()
            }
        );
    }
}

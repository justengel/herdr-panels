use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

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

fn select_boot() -> String {
    let mut script = String::from(FRAME_SELECT);
    script.push_str("\nwindow.__hwpInstallSelect({draw:true,send:function(){}});\n");
    script
}

fn select_on() -> String {
    let mut script = select_boot();
    script.push_str("window.__hwpSetSelect(true);\n");
    script
}

pub fn browser_target(label: &str, url: &str) -> Result<Url, String> {
    if !label.starts_with("browser-")
        || label.len() > "browser-".len() + 49
        || !label
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_')
    {
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
        return Ok(());
    }
    view.set_position(LogicalPosition::new(x, y))
        .map_err(|err| err.to_string())?;
    view.set_size(LogicalSize::new(width, height))
        .map_err(|err| err.to_string())?;
    if !*shown {
        view.show().map_err(|err| err.to_string())?;
        *shown = true;
    }
    Ok(())
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
) -> Result<(), String> {
    let parsed = browser_target(&label, &url)?;
    finite_box(x, y, width, height)?;
    let zoom = current_zoom(&host);
    let content_zoom = panel_content_zoom(&host, &label);
    let (x, y, width, height) = scale_bounds(x, y, width, height, zoom);
    let target = parsed.as_str().to_string();
    let mut guard = host.slots.lock().map_err(|_| "browser host is locked".to_string())?;
    if let Some(slot) = guard.get_mut(&label) {
        if generation < slot.generation {
            return Ok(());
        }
        slot.generation = generation;
        if slot.url != target {
            slot.view.navigate(parsed).map_err(|err| err.to_string())?;
            slot.url = target;
        }
        place_view(&slot.view, x, y, width, height, &mut slot.shown, visible)?;
        return Ok(());
    }
    if !visible || width < 2.0 || height < 2.0 {
        return Ok(());
    }
    let window = app
        .get_window("main")
        .ok_or_else(|| "the desktop window is not open".to_string())?;
    let boot = select_boot();
    let opener = app.clone();
    let view = window
        .add_child(
            tauri::webview::WebviewBuilder::new(&label, tauri::WebviewUrl::External(parsed))
                .initialization_script(boot)
                .on_navigation(|url| browser_panel_link(url.as_str()) == LinkNavigation::Stay)
                .on_new_window(move |url, _features| {
                    respond_to_new_window(&opener, &url);
                    NewWindowResponse::Deny
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
                }),
            LogicalPosition::new(x, y),
            LogicalSize::new(width, height),
        )
        .map_err(|err| err.to_string())?;
    if let Err(err) = view.eval(browser_page_zoom(content_zoom)) {
        eprintln!("browser zoom: {err}");
    }
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

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(host())
        .invoke_handler(tauri::generate_handler![
            place_browser,
            close_browser,
            set_browser_select,
            set_display_zoom,
            set_browser_zoom,
            cursor_place,
            set_desk_prefix,
            set_frame_focus,
            open_external
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

pub fn panel_id_from_browser(label: &str) -> Option<&str> {
    let id = label.strip_prefix("browser-")?;
    if id.is_empty() || !id.chars().all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_') {
        return None;
    }
    Some(id)
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

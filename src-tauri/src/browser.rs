use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use tauri::webview::{PageLoadEvent, Webview};
use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, State};
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
    zoom: Mutex<f64>,
}

pub fn host() -> BrowserHost {
    BrowserHost {
        slots: Mutex::new(HashMap::new()),
        selecting: AtomicBool::new(false),
        zoom: Mutex::new(1.0),
    }
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
    let (x, y, width, height) = scale_bounds(x, y, width, height, zoom);
    eprintln!(
        "browser {label} at {x:.0},{y:.0} {width:.0}x{height:.0} visible={visible}"
    );
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
    let view = window
        .add_child(
            tauri::webview::WebviewBuilder::new(&label, tauri::WebviewUrl::External(parsed))
                .initialization_script(boot)
                .on_page_load(|webview, payload| {
                    if payload.event() != PageLoadEvent::Finished {
                        return;
                    }
                    let host = webview.state::<BrowserHost>();
                    if !host.selecting.load(Ordering::Relaxed) {
                        return;
                    }
                    let _ = webview.eval(select_on());
                }),
            LogicalPosition::new(x, y),
            LogicalSize::new(width, height),
        )
        .map_err(|err| err.to_string())?;
    let _ = view.set_zoom(zoom);
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
    let guard = host.slots.lock().map_err(|_| "browser host is locked".to_string())?;
    for slot in guard.values() {
        let _ = slot.view.set_zoom(scale);
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

pub fn run() {
    tauri::Builder::default()
        .manage(host())
        .invoke_handler(tauri::generate_handler![
            place_browser,
            close_browser,
            set_browser_select,
            set_display_zoom,
            set_desk_prefix,
            set_frame_focus
        ])
        .setup(|app| {
            if let Ok(raw) = std::env::var("HERDR_PANELS_URL") {
                let raw = raw.trim().trim_end_matches('/').to_string();
                if !raw.is_empty() && raw != VIEWER {
                    if let Some(window) = app.get_webview_window("main") {
                        if let Ok(target) = format!("{raw}/").parse() {
                            let _ = window.navigate(target);
                        }
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

/// One mouse notch is 120. Positive Win32 delta rolls the wheel away from the user and zooms in.
/// A wheel that is not Ctrl, or is outside the desk, leaves the pending remainder untouched.
pub fn zoom_wheel_steps(pending: i32, delta: i32, ctrl: bool, over_desk: bool) -> (i32, i32) {
    if !ctrl || !over_desk || delta == 0 {
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
    use std::sync::Mutex;
    use std::time::Duration;

    use tauri::{AppHandle, Manager};
    use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, POINT, WPARAM};
    use windows::Win32::Graphics::Gdi::ScreenToClient;
    use windows::Win32::UI::HiDpi::GetDpiForWindow;
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        GetAsyncKeyState, VK_CONTROL, VK_LWIN, VK_MENU, VK_RWIN, VK_SHIFT,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        CallNextHookEx, DispatchMessageW, GetAncestor, GetForegroundWindow, GetGUIThreadInfo, GetMessageW,
        GetParent, GetWindowThreadProcessId, SetWindowsHookExW, TranslateMessage, WindowFromPoint, GA_ROOT,
        GUITHREADINFO, HHOOK, KBDLLHOOKSTRUCT, MSG, MSLLHOOKSTRUCT, WH_KEYBOARD_LL, WH_MOUSE_LL, WM_LBUTTONDOWN,
        WM_MOUSEWHEEL, WM_RBUTTONDOWN,
    };

    use super::{
        css_from_client, key_from_vk, panel_id_from_browser, route_desk_key, zoom_wheel_steps, KeyRoute, KeySnap,
        PrefixChord,
    };

    static APP: Mutex<Option<AppHandle>> = Mutex::new(None);
    static DESK: AtomicIsize = AtomicIsize::new(0);
    static PENDING: Mutex<i32> = Mutex::new(0);
    static ZOOM: Mutex<f64> = Mutex::new(1.0);
    static FRAME_FOCUS: AtomicBool = AtomicBool::new(false);
    static BROWSERS: Mutex<Vec<(isize, String)>> = Mutex::new(Vec::new());
    static HELD: Mutex<Option<u16>> = Mutex::new(None);
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
                note("desktop zoom hook skipped: no window");
                return;
            }
            if let Ok(mut slot) = APP.lock() {
                *slot = Some(app);
            }
            unsafe {
                match SetWindowsHookExW(WH_MOUSE_LL, Some(mouse_hook), None, 0) {
                    Ok(hook) => {
                        let _ = hook;
                        note("desktop zoom hook installed");
                    }
                    Err(err) => note(&format!("desktop zoom hook failed: {err}")),
                }
                match SetWindowsHookExW(WH_KEYBOARD_LL, Some(key_hook), None, 0) {
                    Ok(hook) => {
                        let _ = hook;
                        note("desktop prefix hook installed");
                    }
                    Err(err) => note(&format!("desktop prefix hook failed: {err}")),
                }
                let claim = APP.lock().ok().and_then(|guard| guard.clone());
                if let Some(claim) = claim {
                    std::thread::spawn(move || loop {
                        mark_captured(&claim);
                        std::thread::sleep(Duration::from_secs(2));
                    });
                }
                loop {
                    let mut msg = MSG::default();
                    let status = GetMessageW(&mut msg, None, 0, 0);
                    if status.0 <= 0 {
                        break;
                    }
                    let _ = TranslateMessage(&msg);
                    DispatchMessageW(&msg);
                }
                note("desktop zoom hook pump ended");
            }
        });
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

    fn mark_captured(app: &AppHandle) {
        let app = app.clone();
        let _ = app.clone().run_on_main_thread(move || {
            if let Some(webview) = app.get_webview("main") {
                let _ = webview.eval("window.__herdrZoomCaptured = true");
            }
        });
    }

    unsafe extern "system" fn mouse_hook(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        if code == 0 && (wparam.0 == WM_LBUTTONDOWN as usize || wparam.0 == WM_RBUTTONDOWN as usize) {
            let info = unsafe { &*(lparam.0 as *const MSLLHOOKSTRUCT) };
            if let Some(script) = focus_script(info.pt) {
                relay_eval(script);
            }
        }
        if code == 0 && wparam.0 == WM_MOUSEWHEEL as usize {
            let info = unsafe { &*(lparam.0 as *const MSLLHOOKSTRUCT) };
            let delta = (info.mouseData >> 16) as i16 as i32;
            let ctrl = unsafe { GetAsyncKeyState(VK_CONTROL.0 as i32) } < 0;
            let over = point_over_desk(info.pt);
            let mut pending = PENDING.lock().unwrap_or_else(|err| err.into_inner());
            let (next, steps) = zoom_wheel_steps(*pending, delta, ctrl, over);
            *pending = next;
            drop(pending);
            if ctrl && over {
                if steps != 0 {
                    emit(steps);
                }
                return LRESULT(1);
            }
        }
        unsafe { CallNextHookEx(None::<HHOOK>, code, wparam, lparam) }
    }

    fn point_over_desk(pt: POINT) -> bool {
        let desk = DESK.load(Ordering::Relaxed);
        if desk == 0 {
            return false;
        }
        let hwnd = unsafe { WindowFromPoint(pt) };
        if hwnd.0.is_null() {
            return false;
        }
        let root = unsafe { GetAncestor(hwnd, GA_ROOT) };
        root.0 as isize == desk
    }

    fn emit(steps: i32) {
        let Ok(guard) = APP.lock() else {
            return;
        };
        let Some(app) = guard.clone() else {
            return;
        };
        drop(guard);
        let script = format!(
            "window.__herdrZoomCaptured = true; window.dispatchEvent(new CustomEvent('herdr-zoom-step',{{detail:{steps}}}))"
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

    fn browser_panel(focus_root: isize) -> Option<String> {
        let fg = unsafe { GetForegroundWindow() };
        if fg.0.is_null() || unsafe { GetAncestor(fg, GA_ROOT) }.0 as isize != focus_root {
            return None;
        }
        let mut info: GUITHREADINFO = unsafe { std::mem::zeroed() };
        info.cbSize = std::mem::size_of::<GUITHREADINFO>() as u32;
        let thread = unsafe { GetWindowThreadProcessId(fg, None) };
        if unsafe { GetGUIThreadInfo(thread, &mut info) }.is_err() {
            return None;
        }
        let browsers = BROWSERS.lock().unwrap_or_else(|err| err.into_inner());
        let mut current = info.hwndFocus.0 as isize;
        for _ in 0..24 {
            if current == 0 || current == focus_root {
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

    fn desk_is_foreground() -> bool {
        let desk = DESK.load(Ordering::Relaxed);
        if desk == 0 {
            return false;
        }
        let fg = unsafe { GetForegroundWindow() };
        !fg.0.is_null() && unsafe { GetAncestor(fg, GA_ROOT) }.0 as isize == desk
    }

    fn take_child_key(vk: u16, up: bool) -> Option<String> {
        let (key, code) = key_from_vk(vk);
        let mut held = HELD.lock().unwrap_or_else(|err| err.into_inner());
        let repeat = !up && *held == Some(vk);
        if up {
            if *held == Some(vk) {
                *held = None;
            }
        } else {
            *held = Some(vk);
        }
        drop(held);
        if !desk_is_foreground() {
            return None;
        }
        let panel = browser_panel(DESK.load(Ordering::Relaxed));
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
        let mut prefix = PREFIX.lock().unwrap_or_else(|err| err.into_inner());
        if prefix.1.key.is_empty() {
            prefix.1.key = "b".into();
            prefix.1.ctrl = true;
        }
        let frame = FRAME_FOCUS.load(Ordering::Relaxed);
        if panel.is_none() && !frame {
            if !up && !matches!(snap.key.as_str(), "Control" | "Shift" | "Alt" | "Meta") {
                prefix.0 = false;
            }
            return None;
        }
        let (armed, route) = route_desk_key(panel.as_deref(), frame, prefix.0, &prefix.1, &snap);
        prefix.0 = armed;
        drop(prefix);
        let KeyRoute::Take { panel } = route else {
            return None;
        };
        Some(match panel {
            Some(panel) => relay_script(&panel, &snap),
            None => relay_key_script(&snap),
        })
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
        if code == 0 {
            let info = unsafe { &*(lparam.0 as *const KBDLLHOOKSTRUCT) };
            let up = info.flags.0 & 0x80 != 0;
            if let Some(script) = take_child_key(info.vkCode as u16, up) {
                relay_eval(script);
                return LRESULT(1);
            }
        }
        let _ = wparam;
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
        assert_eq!(key_from_vk(0x42), ("b".into(), "KeyB".into()));
        assert_eq!(key_from_vk(0xBC), (",".into(), "Comma".into()));
        assert_eq!(css_from_client(200, 100, 96, 1.0), Some((200.0, 100.0)));
        assert_eq!(css_from_client(200, 100, 192, 1.0), Some((100.0, 50.0)));
        assert_eq!(css_from_client(200, 100, 96, 2.0), Some((100.0, 50.0)));
        assert_eq!(panel_id_from_browser("browser-panel-1"), Some("panel-1"));
        assert_eq!(panel_id_from_browser("main"), None);
    }

    #[test]
    fn ctrl_wheel_over_a_browser_panel_steps_the_shared_zoom() {
        assert_eq!(zoom_wheel_steps(0, 120, true, true), (0, 1));
        assert_eq!(zoom_wheel_steps(0, -240, true, true), (0, -2));
        assert_eq!(zoom_wheel_steps(40, 80, true, true), (0, 1));
        assert_eq!(zoom_wheel_steps(40, 120, false, true), (40, 0));
        assert_eq!(zoom_wheel_steps(40, 120, true, false), (40, 0));
        assert_eq!(zoom_wheel_steps(0, 0, true, true), (0, 0));
    }
}

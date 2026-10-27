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
    slot.view.close().map_err(|err| err.to_string())
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
            set_display_zoom
        ])
        .setup(|app| {
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

#[cfg(windows)]
mod browser_wheel {
    use std::io::Write;
    use std::sync::atomic::{AtomicIsize, Ordering};
    use std::sync::Mutex;
    use std::time::Duration;

    use tauri::{AppHandle, Manager};
    use windows::Win32::Foundation::{LPARAM, LRESULT, POINT, WPARAM};
    use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_CONTROL};
    use windows::Win32::UI::WindowsAndMessaging::{
        CallNextHookEx, DispatchMessageW, GetAncestor, GetMessageW, SetWindowsHookExW, TranslateMessage,
        WindowFromPoint, GA_ROOT, HHOOK, MSG, MSLLHOOKSTRUCT, WH_MOUSE_LL, WM_MOUSEWHEEL,
    };

    use super::zoom_wheel_steps;

    static APP: Mutex<Option<AppHandle>> = Mutex::new(None);
    static DESK: AtomicIsize = AtomicIsize::new(0);
    static PENDING: Mutex<i32> = Mutex::new(0);

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
                let hook = match SetWindowsHookExW(WH_MOUSE_LL, Some(mouse_hook), None, 0) {
                    Ok(hook) => hook,
                    Err(err) => {
                        note(&format!("desktop zoom hook failed: {err}"));
                        return;
                    }
                };
                let _ = hook;
                note("desktop zoom hook installed");
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
    fn ctrl_wheel_over_a_browser_panel_steps_the_shared_zoom() {
        assert_eq!(zoom_wheel_steps(0, 120, true, true), (0, 1));
        assert_eq!(zoom_wheel_steps(0, -240, true, true), (0, -2));
        assert_eq!(zoom_wheel_steps(40, 80, true, true), (0, 1));
        assert_eq!(zoom_wheel_steps(40, 120, false, true), (40, 0));
        assert_eq!(zoom_wheel_steps(40, 120, true, false), (40, 0));
        assert_eq!(zoom_wheel_steps(0, 0, true, true), (0, 0));
    }
}

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
}

pub fn host() -> BrowserHost {
    BrowserHost {
        slots: Mutex::new(HashMap::new()),
        selecting: AtomicBool::new(false),
    }
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
            set_browser_select
        ])
        .run(tauri::generate_context!())
        .expect("error while running the desktop shell");
}

#[cfg(test)]
mod tests {
    use super::*;

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
}

//! Linux places a child webview in the window's vertical box, so it is stacked under the page and
//! ignores the panel's rectangle. This moves each child into a `GtkFixed` laid over the page, where
//! its position and size are honored.

use gtk::prelude::*;
use tauri::webview::Webview;

fn is_page(widget: &gtk::Widget) -> bool {
    widget.type_().name() == "WebKitWebView"
}

fn overlay_in(vbox: &gtk::Box, child: &gtk::Widget) -> Option<gtk::Fixed> {
    let existing = vbox
        .children()
        .into_iter()
        .find_map(|widget| widget.downcast::<gtk::Overlay>().ok());
    let overlay = match existing {
        Some(overlay) => overlay,
        None => {
            let page = vbox
                .children()
                .into_iter()
                .find(|widget| widget != child && is_page(widget))?;
            let overlay = gtk::Overlay::new();
            vbox.remove(&page);
            overlay.add(&page);
            let fixed = gtk::Fixed::new();
            overlay.add_overlay(&fixed);
            overlay.set_overlay_pass_through(&fixed, true);
            vbox.pack_start(&overlay, true, true, 0);
            vbox.reorder_child(&overlay, 0);
            overlay.show_all();
            overlay
        }
    };
    overlay
        .children()
        .into_iter()
        .find_map(|widget| widget.downcast::<gtk::Fixed>().ok())
}

fn set_box(child: &gtk::Widget, fixed: &gtk::Fixed, x: f64, y: f64, width: f64, height: f64) {
    child.set_size_request(width.round() as i32, height.round() as i32);
    fixed.move_(child, x.round() as i32, y.round() as i32);
}

/// Move a freshly added child out of the window's box and into the overlay.
pub fn adopt(view: &Webview, x: f64, y: f64, width: f64, height: f64) {
    let _ = view.with_webview(move |platform| {
        let child = platform.inner().upcast::<gtk::Widget>();
        let Some(parent) = child.parent() else { return };
        let Ok(vbox) = parent.downcast::<gtk::Box>() else { return };
        let Some(fixed) = overlay_in(&vbox, &child) else {
            eprintln!("browser overlay: the page webview was not found");
            return;
        };
        vbox.remove(&child);
        fixed.put(&child, x.round() as i32, y.round() as i32);
        set_box(&child, &fixed, x, y, width, height);
        child.show();
    });
}

/// Move and resize a child that is already in the overlay.
pub fn place(view: &Webview, x: f64, y: f64, width: f64, height: f64) {
    let _ = view.with_webview(move |platform| {
        let child = platform.inner().upcast::<gtk::Widget>();
        if let Some(fixed) = child.parent().and_then(|parent| parent.downcast::<gtk::Fixed>().ok()) {
            set_box(&child, &fixed, x, y, width, height);
        }
    });
}

/// Show or hide the child itself. After `adopt`, the window's own hide leaves the widget painted.
pub fn set_shown(view: &Webview, shown: bool) {
    let _ = view.with_webview(move |platform| {
        let child = platform.inner().upcast::<gtk::Widget>();
        if shown {
            child.show();
        } else {
            child.hide();
        }
    });
}

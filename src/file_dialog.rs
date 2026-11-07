//! System file dialogs.
//!
//! On Windows an unowned dialog is not kept above the desk. The desktop window
//! is maximized, so the picker opens underneath it and a click on Browse looks
//! like nothing happened. The dialog is owned by the window the person is
//! using, which keeps it above that window. Linux and macOS already present
//! their own dialogs in front.

/// Show `dialog` and return whatever `present` returns.
pub fn show<T>(dialog: rfd::FileDialog, present: impl FnOnce(rfd::FileDialog) -> T) -> T {
    present(owned(dialog))
}

fn owned(dialog: rfd::FileDialog) -> rfd::FileDialog {
    #[cfg(windows)]
    {
        if let Some(owner) = foreground_owner() {
            return dialog.set_parent(&owner);
        }
    }
    dialog
}

/// A null foreground window is not an owner. Passing it through would leave
/// the dialog unowned, which is the Windows bug.
#[cfg(any(windows, test))]
pub(crate) fn owner_hwnd(raw: isize) -> Option<std::num::NonZeroIsize> {
    std::num::NonZeroIsize::new(raw)
}

#[cfg(windows)]
struct WinOwner {
    window: raw_window_handle::Win32WindowHandle,
}

#[cfg(windows)]
impl raw_window_handle::HasWindowHandle for WinOwner {
    fn window_handle(
        &self,
    ) -> Result<raw_window_handle::WindowHandle<'_>, raw_window_handle::HandleError> {
        // The foreground window is alive for this call. `rfd` copies the HWND
        // and does not keep this borrow.
        Ok(unsafe {
            raw_window_handle::WindowHandle::borrow_raw(raw_window_handle::RawWindowHandle::Win32(
                self.window,
            ))
        })
    }
}

#[cfg(windows)]
impl raw_window_handle::HasDisplayHandle for WinOwner {
    fn display_handle(
        &self,
    ) -> Result<raw_window_handle::DisplayHandle<'_>, raw_window_handle::HandleError> {
        Ok(raw_window_handle::DisplayHandle::windows())
    }
}

#[cfg(windows)]
fn foreground_owner() -> Option<WinOwner> {
    let hwnd = unsafe { GetForegroundWindow() };
    let hwnd = owner_hwnd(hwnd as isize)?;
    Some(WinOwner {
        window: raw_window_handle::Win32WindowHandle::new(hwnd),
    })
}

#[cfg(windows)]
#[link(name = "user32")]
extern "system" {
    fn GetForegroundWindow() -> *mut core::ffi::c_void;
}

#[cfg(test)]
mod tests {
    use super::owner_hwnd;

    #[test]
    fn a_null_foreground_window_is_not_used_as_the_dialog_owner() {
        assert!(owner_hwnd(0).is_none());
        assert_eq!(owner_hwnd(0x1000).map(|value| value.get()), Some(0x1000));
    }
}

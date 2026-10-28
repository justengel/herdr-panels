//! Keep a console-subsystem child from opening its own window.

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;
#[cfg(windows)]
const CREATE_NEW_PROCESS_GROUP: u32 = 0x00000200;

#[cfg(windows)]
pub fn quiet(command: &mut std::process::Command) {
    use std::os::windows::process::CommandExt;
    command.creation_flags(CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP);
}

#[cfg(windows)]
pub fn quiet_async(command: &mut tokio::process::Command) {
    command.creation_flags(CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP);
}

#[cfg(not(windows))]
pub fn quiet<T>(_: &mut T) {}

#[cfg(not(windows))]
pub fn quiet_async<T>(_: &mut T) {}

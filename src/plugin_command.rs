//! Run one allowlisted program for a plugin. No shell, and only inside a
//! directory the desk already has open.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;

const ARG_LIMIT: usize = 40;
const ARG_BYTES: usize = 4096;
const STDOUT_CAP: usize = 2_000_000;
const STDERR_CAP: usize = 64_000;
const TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CommandOutput {
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
    pub truncated: bool,
    pub cwd: String,
}

pub fn valid_command_name(name: &str) -> bool {
    let mut chars = name.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    if !first.is_ascii_alphanumeric() {
        return false;
    }
    name.len() <= 64
        && name
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' || ch == '.')
}

pub fn validate_invocation(allowed: &[String], name: &str, args: &[String]) -> Result<(), String> {
    if !valid_command_name(name) {
        return Err("command name is not allowed".into());
    }
    if !allowed.iter().any(|have| have == name) {
        return Err(format!("this plugin cannot run {name}"));
    }
    if args.len() > ARG_LIMIT {
        return Err("too many arguments".into());
    }
    if args
        .iter()
        .any(|arg| arg.contains('\0') || arg.len() > ARG_BYTES)
    {
        return Err("an argument is too long".into());
    }
    Ok(())
}

/// `requested` must be an open project, or a directory inside one.
pub fn cwd_allowed(requested: &Path, roots: &[PathBuf]) -> Result<PathBuf, String> {
    if !requested.is_absolute() {
        return Err("directory must be absolute".into());
    }
    let requested = requested
        .canonicalize()
        .map_err(|_| "directory was not found".to_string())?;
    if !requested.is_dir() {
        return Err("directory was not found".into());
    }
    for root in roots {
        let Ok(root) = root.canonicalize() else {
            continue;
        };
        if requested.starts_with(&root) {
            return Ok(requested);
        }
    }
    Err("directory is not an open project".into())
}

pub fn execute(name: &str, args: &[String], cwd: &Path) -> Result<CommandOutput, String> {
    execute_with_path(
        name,
        args,
        cwd,
        &std::env::var_os("PATH").unwrap_or_default(),
    )
}

fn execute_with_path(
    name: &str,
    args: &[String],
    cwd: &Path,
    path_var: &std::ffi::OsStr,
) -> Result<CommandOutput, String> {
    let program = find_on_path(name, path_var)?;
    let truncated = Arc::new(AtomicBool::new(false));
    let mut command = Command::new(&program);
    command
        .args(args)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    crate::quiet_process::quiet(&mut command);
    let mut child = command
        .spawn()
        .map_err(|err| format!("could not run {name}: {err}"))?;
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let out_flag = Arc::clone(&truncated);
    let err_flag = Arc::clone(&truncated);
    let out_thread = thread::spawn(move || read_capped(stdout, STDOUT_CAP, &out_flag));
    let err_thread = thread::spawn(move || read_capped(stderr, STDERR_CAP, &err_flag));
    let started = Instant::now();
    let status = loop {
        if truncated.load(Ordering::Relaxed) {
            let _ = child.kill();
            let _ = child.wait();
            break None;
        }
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) if started.elapsed() > TIMEOUT => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("{name} timed out"));
            }
            Ok(None) => thread::sleep(Duration::from_millis(30)),
            Err(err) => return Err(err.to_string()),
        }
    };
    let out = out_thread.join().unwrap_or_default();
    let err = err_thread.join().unwrap_or_default();
    Ok(CommandOutput {
        code: status.and_then(|status| status.code()).unwrap_or(1),
        stdout: String::from_utf8_lossy(&out.0).into_owned(),
        stderr: String::from_utf8_lossy(&err.0).into_owned(),
        truncated: truncated.load(Ordering::Relaxed),
        cwd: cwd.display().to_string(),
    })
}

fn read_capped(pipe: Option<impl Read>, cap: usize, flag: &AtomicBool) -> (Vec<u8>, bool) {
    let Some(mut pipe) = pipe else {
        return (Vec::new(), false);
    };
    let mut data = Vec::new();
    let mut chunk = [0_u8; 8192];
    loop {
        if data.len() >= cap {
            flag.store(true, Ordering::Relaxed);
            return (data, true);
        }
        match pipe.read(&mut chunk) {
            Ok(0) => return (data, false),
            Ok(n) => {
                let room = cap - data.len();
                if n > room {
                    data.extend_from_slice(&chunk[..room]);
                    flag.store(true, Ordering::Relaxed);
                    return (data, true);
                }
                data.extend_from_slice(&chunk[..n]);
            }
            Err(_) => return (data, false),
        }
    }
}

pub fn find_on_path(name: &str, path_var: &std::ffi::OsStr) -> Result<PathBuf, String> {
    if !valid_command_name(name) {
        return Err("command name is not allowed".into());
    }
    for dir in std::env::split_paths(path_var) {
        for candidate in candidates(&dir, name) {
            if candidate.is_file() {
                return Ok(candidate);
            }
        }
    }
    Err(format!("{name} is not on PATH"))
}

fn candidates(dir: &Path, name: &str) -> Vec<PathBuf> {
    let mut out = vec![dir.join(name)];
    #[cfg(windows)]
    for ext in [".exe", ".cmd", ".bat"] {
        if !name.to_ascii_lowercase().ends_with(ext) {
            out.push(dir.join(format!("{name}{ext}")));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn scratch(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "hwp-cmd-{name}-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn a_command_name_is_a_program_not_a_path() {
        assert!(valid_command_name("ai-diff"));
        assert!(!valid_command_name(""));
        assert!(!valid_command_name("ai-diff/../../cmd"));
        assert!(!valid_command_name(r"C:\Windows\system32\cmd.exe"));
        assert!(!valid_command_name("../ai-diff"));
        let err = validate_invocation(&["ai-diff".into()], "git", &[]).unwrap_err();
        assert!(err.contains("cannot run git"), "{err}");
        assert!(validate_invocation(&["ai-diff".into()], "ai-diff", &["review".into()]).is_ok());
    }

    #[test]
    fn the_directory_has_to_be_an_open_project() {
        let root = scratch("cwd");
        let project = root.join("project");
        let nested = project.join("nested");
        let elsewhere = root.join("elsewhere");
        fs::create_dir_all(&nested).unwrap();
        fs::create_dir_all(&elsewhere).unwrap();
        let roots = vec![project.clone()];
        assert_eq!(cwd_allowed(&project, &roots).unwrap(), project.canonicalize().unwrap());
        assert_eq!(cwd_allowed(&nested, &roots).unwrap(), nested.canonicalize().unwrap());
        let outside = cwd_allowed(&elsewhere, &roots).unwrap_err();
        assert!(outside.contains("open project"), "{outside}");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn an_allowlisted_program_runs_from_path_and_not_from_a_path_prefix() {
        let root = scratch("run");
        let bin = root.join("bin");
        let work = root.join("work");
        fs::create_dir_all(&bin).unwrap();
        fs::create_dir_all(&work).unwrap();
        #[cfg(windows)]
        fs::write(bin.join("hwp-echo.cmd"), "@echo off\r\n").unwrap();
        #[cfg(not(windows))]
        {
            let program = bin.join("hwp-echo");
            fs::write(&program, "#!/bin/sh\n").unwrap();
            use std::os::unix::fs::PermissionsExt;
            let mut perms = fs::metadata(&program).unwrap().permissions();
            perms.set_mode(0o755);
            fs::set_permissions(&program, perms).unwrap();
        }
        let found = find_on_path("hwp-echo", bin.as_os_str()).unwrap();
        assert_eq!(found.file_stem().unwrap(), "hwp-echo");
        #[cfg(windows)]
        let output = execute(
            "cmd",
            &["/c".into(), "echo hello-from-plugin".into()],
            &work,
        )
        .unwrap();
        #[cfg(not(windows))]
        let output = execute("echo", &["hello-from-plugin".into()], &work).unwrap();
        assert_eq!(output.code, 0, "{output:?}");
        assert!(output.stdout.contains("hello-from-plugin"), "{output:?}");
        assert!(!output.truncated);
        let _ = fs::remove_dir_all(&root);
    }
}

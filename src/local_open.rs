//! Open a folder in the system file browser or an external terminal.
//! Commands take an existing path as an argument. Nothing is passed through a shell string.

use std::path::{Path, PathBuf};
use std::process::Command;

use anyhow::{anyhow, bail};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Launch {
    pub program: String,
    pub args: Vec<String>,
    pub cwd: Option<PathBuf>,
}

/// Spawn the file browser or an external terminal for an existing path.
pub fn open(action: &str, requested: &Path) -> anyhow::Result<()> {
    let launches = plans(action, requested)?;
    let mut last = String::from("no program");
    for launch in launches {
        let mut command = Command::new(&launch.program);
        command.args(&launch.args);
        if let Some(cwd) = &launch.cwd {
            command.current_dir(cwd);
        }
        match command.spawn() {
            Ok(mut child) => {
                let _ = child.try_wait();
                return Ok(());
            }
            Err(err) => last = err.to_string(),
        }
    }
    let what = if action == "terminal" {
        "terminal"
    } else {
        "folder"
    };
    Err(anyhow!("could not open that {what}: {last}"))
}

/// Programs to try, in order. A file's terminal uses the parent folder.
pub fn plans(action: &str, requested: &Path) -> anyhow::Result<Vec<Launch>> {
    if requested.as_os_str().is_empty() {
        bail!("path is empty");
    }
    let canonical = requested
        .canonicalize()
        .map_err(|_| anyhow!("that path was not found"))?;
    let path = PathBuf::from(crate::files::plain_path(&canonical));
    match action {
        "browser" => Ok(browser_plans(&path)),
        "terminal" => {
            let dir = if path.is_dir() {
                path
            } else {
                path.parent()
                    .filter(|dir| dir.is_dir())
                    .map(Path::to_path_buf)
                    .ok_or_else(|| anyhow!("that folder was not found"))?
            };
            Ok(terminal_plans(&dir))
        }
        _ => bail!("unknown open action"),
    }
}

#[cfg(windows)]
fn browser_plans(path: &Path) -> Vec<Launch> {
    let text = path.display().to_string();
    if path.is_dir() {
        vec![Launch {
            program: "explorer".into(),
            args: vec![text],
            cwd: None,
        }]
    } else {
        vec![Launch {
            program: "explorer".into(),
            args: vec![format!("/select,{text}")],
            cwd: None,
        }]
    }
}

#[cfg(windows)]
fn terminal_plans(dir: &Path) -> Vec<Launch> {
    let text = dir.display().to_string();
    let escaped = text.replace('\'', "''");
    vec![
        Launch {
            program: "wt".into(),
            args: vec!["-d".into(), text],
            cwd: None,
        },
        Launch {
            program: "powershell".into(),
            args: vec![
                "-NoExit".into(),
                "-Command".into(),
                format!("Set-Location -LiteralPath '{escaped}'"),
            ],
            cwd: None,
        },
    ]
}

#[cfg(target_os = "macos")]
fn browser_plans(path: &Path) -> Vec<Launch> {
    let text = path.display().to_string();
    if path.is_file() {
        vec![Launch {
            program: "open".into(),
            args: vec!["-R".into(), text],
            cwd: None,
        }]
    } else {
        vec![Launch {
            program: "open".into(),
            args: vec![text],
            cwd: None,
        }]
    }
}

#[cfg(target_os = "macos")]
fn terminal_plans(dir: &Path) -> Vec<Launch> {
    vec![Launch {
        program: "open".into(),
        args: vec!["-a".into(), "Terminal".into(), dir.display().to_string()],
        cwd: None,
    }]
}

#[cfg(all(unix, not(target_os = "macos")))]
fn browser_plans(path: &Path) -> Vec<Launch> {
    linux_browser_plans(&path.display().to_string(), path.is_dir())
}

#[cfg(all(unix, not(target_os = "macos")))]
fn terminal_plans(dir: &Path) -> Vec<Launch> {
    linux_terminal_plans(&dir.display().to_string())
}

/// Linux file manager and terminal commands. Paths stay `/`-separated.
/// A file is shown with the freedesktop file manager when that service exists,
/// and otherwise the folder that contains it is opened.
pub fn linux_browser_plans(path: &str, is_dir: bool) -> Vec<Launch> {
    if is_dir {
        return vec![Launch {
            program: "xdg-open".into(),
            args: vec![path.to_string()],
            cwd: None,
        }];
    }
    let mut plans = Vec::new();
    if let Some(uri) = posix_file_uri(path) {
        plans.push(Launch {
            program: "dbus-send".into(),
            args: vec![
                "--session".into(),
                "--dest=org.freedesktop.FileManager1".into(),
                "--type=method_call".into(),
                "/org/freedesktop/FileManager1".into(),
                "org.freedesktop.FileManager1.ShowItems".into(),
                format!("array:string:{uri}"),
                "string:".into(),
            ],
            cwd: None,
        });
    }
    plans.push(Launch {
        program: "xdg-open".into(),
        args: vec![posix_parent(path)],
        cwd: None,
    });
    plans
}

pub fn linux_terminal_plans(dir: &str) -> Vec<Launch> {
    let text = dir.to_string();
    vec![
        Launch {
            program: "x-terminal-emulator".into(),
            args: vec![],
            cwd: Some(PathBuf::from(&text)),
        },
        Launch {
            program: "gnome-terminal".into(),
            args: vec![format!("--working-directory={text}")],
            cwd: None,
        },
        Launch {
            program: "konsole".into(),
            args: vec!["--workdir".into(), text],
            cwd: None,
        },
    ]
}

fn posix_parent(path: &str) -> String {
    let trimmed = path.trim_end_matches('/');
    match trimmed.rfind('/') {
        Some(0) => "/".into(),
        Some(index) => trimmed[..index].to_string(),
        None => trimmed.to_string(),
    }
}

fn posix_file_uri(path: &str) -> Option<String> {
    let trimmed = path.trim();
    if !trimmed.starts_with('/') {
        return None;
    }
    let mut uri = String::from("file://");
    for part in trimmed.split('/').filter(|part| !part.is_empty()) {
        uri.push('/');
        for byte in part.bytes() {
            if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~') {
                uri.push(byte as char);
            } else {
                uri.push_str(&format!("%{byte:02X}"));
            }
        }
    }
    Some(uri)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn plans_a_file_browser_and_an_external_terminal() {
        let root = std::env::temp_dir().join(format!("hwp-local-open-{}", std::process::id()));
        let file = root.join("note.txt");
        fs::create_dir_all(&root).unwrap();
        fs::write(&file, "hi").unwrap();

        let browser = plans("browser", &file).unwrap();
        let terminal = plans("terminal", &file).unwrap();
        let folder = plans("browser", &root).unwrap();
        assert!(!browser.is_empty());
        assert!(!terminal.is_empty());
        assert!(!folder.is_empty());
        assert!(plans("sideways", &file).is_err());
        assert!(plans("browser", Path::new("")).is_err());
        assert!(plans("terminal", &root.join("missing.txt")).is_err());

        #[cfg(windows)]
        {
            assert_eq!(browser[0].program, "explorer");
            assert!(browser[0].args[0].starts_with("/select,"));
            assert!(browser[0].args[0].ends_with("note.txt"));
            assert!(!folder[0].args[0].contains("/select,"));
            assert_eq!(terminal[0].program, "wt");
            assert_eq!(terminal[0].args[0], "-d");
            assert!(terminal[0].args[1].contains("hwp-local-open-"));
            assert_eq!(terminal[1].program, "powershell");
        }

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn linux_plans_keep_native_slashes_and_select_a_file() {
        let folder = linux_browser_plans("/home/me/My Files", true);
        assert_eq!(folder[0].program, "xdg-open");
        assert_eq!(folder[0].args, vec!["/home/me/My Files".to_string()]);
        assert!(!folder[0].args[0].contains('\\'));

        let file = linux_browser_plans("/home/me/My Files/note.txt", false);
        assert_eq!(file[0].program, "dbus-send");
        assert!(file[0]
            .args
            .iter()
            .any(|arg| arg.contains("file:///home/me/My%20Files/note.txt")));
        assert_eq!(file[1].program, "xdg-open");
        assert_eq!(file[1].args, vec!["/home/me/My Files".to_string()]);

        let named = linux_terminal_plans("/home/me/foo\\bar");
        assert_eq!(named[2].args[1], "/home/me/foo\\bar");

        let term = linux_terminal_plans("/home/me/My Files");
        assert_eq!(
            term[0].cwd.as_deref(),
            Some(std::path::Path::new("/home/me/My Files"))
        );
        assert_eq!(term[1].args[0], "--working-directory=/home/me/My Files");
        assert_eq!(term[2].args[1], "/home/me/My Files");
        assert!(term
            .iter()
            .all(|launch| launch.args.iter().all(|arg| !arg.contains('\\'))));
    }
}

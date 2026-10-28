use std::path::{Path, PathBuf};

use anyhow::Context;

pub const ICON_NAME: &str = "herdr-panels";
/// WM_CLASS instance of the desktop window. GTK leaves this as the program name
/// unless the GTK application id is enabled, and that id allows only one window.
pub const STARTUP_WM_CLASS: &str = "herdr-panels-desktop";

const ICON_48: &[u8] = include_bytes!("../assets/launcher/48.png");
const ICON_128: &[u8] = include_bytes!("../assets/launcher/128.png");
const ICON_256: &[u8] = include_bytes!("../assets/launcher/256.png");
const ICON_SVG: &str = include_str!("../assets/launcher/herdr-panels.svg");

pub struct InstalledLauncher {
    pub desktop_file: PathBuf,
    pub icons: Vec<PathBuf>,
}

pub fn execute() -> anyhow::Result<()> {
    let exe = std::env::current_exe().context("finding this program")?;
    let exe = exe.canonicalize().unwrap_or(exe);
    let home = data_home()?;
    let installed = install_launcher(&home, &exe)?;
    println!("installed {}", installed.desktop_file.display());
    for icon in &installed.icons {
        println!("installed {}", icon.display());
    }
    refresh_desktop_database(installed.desktop_file.parent().unwrap_or(&home));
    Ok(())
}

pub fn data_home() -> anyhow::Result<PathBuf> {
    if let Some(value) = std::env::var_os("XDG_DATA_HOME") {
        if !value.is_empty() {
            return Ok(PathBuf::from(value));
        }
    }
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .context("home directory is not set")?;
    Ok(home.join(".local").join("share"))
}

pub fn desktop_entry(exe: &Path) -> String {
    format!(
        "[Desktop Entry]\n\
         Type=Application\n\
         Name=Herdr Panels\n\
         Comment=Desk for a running Herdr session\n\
         Exec={exec}\n\
         Icon={ICON_NAME}\n\
         Terminal=false\n\
         Categories=Development;\n\
         StartupNotify=true\n\
         StartupWMClass={STARTUP_WM_CLASS}\n",
        exec = desktop_exec(exe),
    )
}

pub fn install_launcher(data_home: &Path, exe: &Path) -> anyhow::Result<InstalledLauncher> {
    let applications = data_home.join("applications");
    std::fs::create_dir_all(&applications)
        .with_context(|| format!("creating {}", applications.display()))?;
    let desktop_file = applications.join("herdr-panels.desktop");
    std::fs::write(&desktop_file, desktop_entry(exe))
        .with_context(|| format!("writing {}", desktop_file.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&desktop_file, std::fs::Permissions::from_mode(0o644));
    }

    let mut icons = Vec::new();
    for (size, bytes) in [
        ("48x48", ICON_48),
        ("128x128", ICON_128),
        ("256x256", ICON_256),
    ] {
        let path = data_home
            .join("icons")
            .join("hicolor")
            .join(size)
            .join("apps")
            .join("herdr-panels.png");
        write_file(&path, bytes)?;
        icons.push(path);
    }
    let svg = data_home
        .join("icons")
        .join("hicolor")
        .join("scalable")
        .join("apps")
        .join("herdr-panels.svg");
    write_file(&svg, ICON_SVG.as_bytes())?;
    icons.push(svg);
    Ok(InstalledLauncher {
        desktop_file,
        icons,
    })
}

fn desktop_exec(exe: &Path) -> String {
    let raw = exe.display().to_string();
    let text = raw.strip_prefix(r"\\?\").unwrap_or(&raw).to_string();
    if text.contains(' ') || text.contains('\t') || text.contains('"') {
        format!("\"{}\"", text.replace('"', "\\\""))
    } else {
        text
    }
}

fn write_file(path: &Path, bytes: &[u8]) -> anyhow::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("creating {}", parent.display()))?;
    }
    std::fs::write(path, bytes).with_context(|| format!("writing {}", path.display()))
}

fn refresh_desktop_database(applications: &Path) {
    match std::process::Command::new("update-desktop-database")
        .arg(applications)
        .status()
    {
        Ok(status) if status.success() => {}
        Ok(status) => eprintln!("update-desktop-database exited with {status}"),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            eprintln!("installed the desktop entry; update-desktop-database is not on PATH");
        }
        Err(err) => eprintln!("update-desktop-database: {err}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_desktop_entry_names_the_icon_and_the_window_class() {
        let exe = std::env::temp_dir().join("herdr-panels");
        let entry = desktop_entry(&exe);
        let exec = entry
            .lines()
            .find(|line| line.starts_with("Exec="))
            .unwrap();
        assert_eq!(exec, format!("Exec={}", exe.display()));
        assert!(!exec.contains("herdr-panels-desktop"), "{exec}");
        assert!(entry.lines().any(|line| line == "Icon=herdr-panels"));
        assert!(entry
            .lines()
            .any(|line| line == "StartupWMClass=herdr-panels-desktop"));
        assert!(entry.lines().any(|line| line == "StartupNotify=true"));
        assert!(entry.lines().any(|line| line == "Categories=Development;"));
        let spaced = desktop_entry(
            &std::env::temp_dir()
                .join("My Programs")
                .join("herdr-panels"),
        );
        let spaced_exec = spaced
            .lines()
            .find(|line| line.starts_with("Exec="))
            .unwrap();
        assert!(spaced_exec.starts_with("Exec=\""), "{spaced_exec}");
        assert!(spaced_exec.ends_with('"'), "{spaced_exec}");
        let verbatim = desktop_entry(std::path::Path::new(r"\\?\C:\Users\engel\herdr-panels.exe"));
        let verbatim_exec = verbatim
            .lines()
            .find(|line| line.starts_with("Exec="))
            .unwrap();
        assert!(!verbatim_exec.contains('?'), "{verbatim_exec}");
        assert!(
            verbatim_exec.contains("herdr-panels.exe"),
            "{verbatim_exec}"
        );
    }

    #[test]
    fn install_writes_hicolor_icons_and_not_an_icon_path() {
        let root = std::env::temp_dir().join(format!("hwp-launcher-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let exe = std::path::PathBuf::from("/home/engel/.local/bin/herdr-panels");
        let installed = install_launcher(&root, &exe).unwrap();
        let entry = std::fs::read_to_string(&installed.desktop_file).unwrap();
        assert!(entry.contains("Icon=herdr-panels\n"), "{entry}");
        assert!(!entry.contains("Icon=/"), "{entry}");
        assert!(
            entry.contains("StartupWMClass=herdr-panels-desktop"),
            "{entry}"
        );
        for (size, width) in [("48x48", 48u32), ("128x128", 128), ("256x256", 256)] {
            let path = root
                .join("icons")
                .join("hicolor")
                .join(size)
                .join("apps")
                .join("herdr-panels.png");
            let bytes = std::fs::read(&path).unwrap();
            assert_eq!(&bytes[..8], b"\x89PNG\r\n\x1a\n");
            let actual = u32::from_be_bytes(bytes[16..20].try_into().unwrap());
            assert_eq!(actual, width, "{path:?}");
        }
        let svg = std::fs::read_to_string(
            root.join("icons")
                .join("hicolor")
                .join("scalable")
                .join("apps")
                .join("herdr-panels.svg"),
        )
        .unwrap();
        assert!(svg.contains("<svg"), "{svg}");
        let _ = std::fs::remove_dir_all(&root);
    }
}

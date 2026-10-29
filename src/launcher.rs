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
    #[cfg(windows)]
    {
        return execute_windows(&exe);
    }
    #[cfg(target_os = "macos")]
    {
        return execute_macos(&exe);
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        execute_linux(&exe)
    }
}

#[cfg(not(any(windows, target_os = "macos")))]
fn execute_linux(exe: &Path) -> anyhow::Result<()> {
    let home = data_home()?;
    let installed = install_launcher(&home, &exe)?;
    println!("installed {}", installed.desktop_file.display());
    for icon in &installed.icons {
        println!("installed {}", icon.display());
    }
    refresh_desktop_database(installed.desktop_file.parent().unwrap_or(&home));
    Ok(())
}

#[cfg(windows)]
fn execute_windows(exe: &Path) -> anyhow::Result<()> {
    let appdata = std::env::var_os("APPDATA").context("APPDATA is not set")?;
    let appdata = PathBuf::from(appdata);
    let support = appdata.join("herdr-panels").join("launcher");
    let programs = appdata
        .join("Microsoft")
        .join("Windows")
        .join("Start Menu")
        .join("Programs");
    let installed = install_windows_support(&support, exe)?;
    let shortcut = install_windows_shortcut(
        &programs,
        &installed.script,
        &installed.icon,
        exe.parent().unwrap_or(exe),
    )?;
    println!("installed {}", shortcut.display());
    println!("installed {}", installed.script.display());
    println!("installed {}", installed.icon.display());
    Ok(())
}

#[cfg(target_os = "macos")]
fn execute_macos(exe: &Path) -> anyhow::Result<()> {
    let home = std::env::var_os("HOME").context("HOME is not set")?;
    let app = install_macos_app(&PathBuf::from(home).join("Applications"), exe)?;
    println!("installed {}", app.display());
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

#[cfg(any(windows, test))]
fn windows_launch_script(exe: &Path) -> String {
    let exe_text = plain_path(exe);
    let dir = windows_directory(&exe_text);
    let run_arg = format!("\"{exe_text}\"");
    format!(
        "Set shell = CreateObject(\"WScript.Shell\")\n\
         shell.CurrentDirectory = {dir}\n\
         shell.Run {run}, 0, False\n",
        dir = vbs_string(&dir),
        run = vbs_string(&run_arg),
    )
}

#[cfg(any(windows, test))]
fn vbs_string(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\"\""))
}

/// Directory of a Windows path string. The launch script is checked on every
/// platform, so this splits on `\` and `/` instead of the host path rules.
#[cfg(any(windows, test))]
fn windows_directory(path: &str) -> String {
    let trimmed = path.trim_end_matches(['\\', '/']);
    match trimmed.rfind(['\\', '/']) {
        Some(index) if index > 0 => trimmed[..index].to_string(),
        _ => String::new(),
    }
}

#[cfg(any(windows, test))]
fn windows_icon() -> Vec<u8> {
    png_ico(&[ICON_48, ICON_128, ICON_256])
}

#[cfg(any(windows, test))]
fn png_ico(pngs: &[&[u8]]) -> Vec<u8> {
    let mut file = Vec::new();
    file.extend_from_slice(&0u16.to_le_bytes());
    file.extend_from_slice(&1u16.to_le_bytes());
    file.extend_from_slice(&(pngs.len() as u16).to_le_bytes());
    let mut offset = 6 + 16 * pngs.len();
    let mut images = Vec::new();
    for png in pngs {
        let side = png_side(png);
        let stored = if side >= 256 { 0 } else { side as u8 };
        file.push(stored);
        file.push(stored);
        file.push(0);
        file.push(0);
        file.extend_from_slice(&1u16.to_le_bytes());
        file.extend_from_slice(&32u16.to_le_bytes());
        file.extend_from_slice(&(png.len() as u32).to_le_bytes());
        file.extend_from_slice(&(offset as u32).to_le_bytes());
        offset += png.len();
        images.extend_from_slice(png);
    }
    file.extend(images);
    file
}

#[cfg(any(windows, test))]
fn png_side(png: &[u8]) -> u32 {
    u32::from_be_bytes(png[16..20].try_into().unwrap())
}

#[cfg(any(windows, test))]
struct WindowsSupport {
    script: PathBuf,
    icon: PathBuf,
}

#[cfg(any(windows, test))]
fn install_windows_support(dir: &Path, exe: &Path) -> anyhow::Result<WindowsSupport> {
    let script = dir.join("herdr-panels.vbs");
    let icon = dir.join("herdr-panels.ico");
    write_file(&script, windows_launch_script(exe).as_bytes())?;
    write_file(&icon, &windows_icon())?;
    Ok(WindowsSupport { script, icon })
}

#[cfg(windows)]
fn install_windows_shortcut(
    programs: &Path,
    script: &Path,
    icon: &Path,
    workdir: &Path,
) -> anyhow::Result<PathBuf> {
    std::fs::create_dir_all(programs)
        .with_context(|| format!("creating {}", programs.display()))?;
    let shortcut = programs.join("Herdr Panels.lnk");
    let arguments = format!("//B //Nologo \"{}\"", plain_path(script));
    let icon_location = format!("{},0", plain_path(icon));
    let command = format!(
        "$s = (New-Object -ComObject WScript.Shell).CreateShortcut({lnk}); \
         $s.TargetPath = {target}; \
         $s.Arguments = {args}; \
         $s.WorkingDirectory = {work}; \
         $s.IconLocation = {icon}; \
         $s.Description = {desc}; \
         $s.WindowStyle = 1; \
         $s.Save()",
        lnk = ps_literal(&plain_path(&shortcut)),
        target = ps_literal(&plain_path(&wscript_path())),
        args = ps_literal(&arguments),
        work = ps_literal(&plain_path(workdir)),
        icon = ps_literal(&icon_location),
        desc = ps_literal("Desk for a running Herdr session"),
    );
    let output = std::process::Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-Command", &command])
        .output()
        .context("starting PowerShell to write the Start menu shortcut")?;
    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr);
        anyhow::bail!("could not write {}: {err}", shortcut.display());
    }
    Ok(shortcut)
}

#[cfg(windows)]
fn wscript_path() -> PathBuf {
    let root = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".to_string());
    PathBuf::from(root).join("System32").join("wscript.exe")
}

#[cfg(windows)]
fn ps_literal(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

#[cfg(any(target_os = "macos", test))]
fn macos_launch_script(exe: &Path) -> String {
    format!("#!/bin/sh\nexec {}\n", shell_single(&plain_path(exe)))
}

#[cfg(any(target_os = "macos", test))]
fn shell_single(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

#[cfg(any(target_os = "macos", test))]
fn macos_info_plist() -> String {
    let version = env!("CARGO_PKG_VERSION");
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n\
         <!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n\
         <plist version=\"1.0\">\n\
         <dict>\n\
         \t<key>CFBundleName</key>\n\
         \t<string>Herdr Panels</string>\n\
         \t<key>CFBundleDisplayName</key>\n\
         \t<string>Herdr Panels</string>\n\
         \t<key>CFBundleIdentifier</key>\n\
         \t<string>dev.herdr.panels</string>\n\
         \t<key>CFBundleVersion</key>\n\
         \t<string>{version}</string>\n\
         \t<key>CFBundleShortVersionString</key>\n\
         \t<string>{version}</string>\n\
         \t<key>CFBundlePackageType</key>\n\
         \t<string>APPL</string>\n\
         \t<key>CFBundleExecutable</key>\n\
         \t<string>herdr-panels</string>\n\
         \t<key>CFBundleIconFile</key>\n\
         \t<string>herdr-panels</string>\n\
         \t<key>LSMinimumSystemVersion</key>\n\
         \t<string>11.0</string>\n\
         \t<key>LSUIElement</key>\n\
         \t<true/>\n\
         \t<key>NSHighResolutionCapable</key>\n\
         \t<true/>\n\
         </dict>\n\
         </plist>\n"
    )
}

#[cfg(any(target_os = "macos", test))]
fn macos_icon() -> Vec<u8> {
    let mut chunks = Vec::new();
    for (kind, png) in [(b"ic07", ICON_128), (b"ic08", ICON_256)] {
        chunks.extend_from_slice(kind);
        let len = (8 + png.len()) as u32;
        chunks.extend_from_slice(&len.to_be_bytes());
        chunks.extend_from_slice(png);
    }
    let mut file = b"icns".to_vec();
    let total = (8 + chunks.len()) as u32;
    file.extend_from_slice(&total.to_be_bytes());
    file.extend(chunks);
    file
}

#[cfg(any(target_os = "macos", test))]
fn install_macos_app(applications: &Path, exe: &Path) -> anyhow::Result<PathBuf> {
    let app = applications.join("Herdr Panels.app");
    let contents = app.join("Contents");
    let macos = contents.join("MacOS");
    let script = macos.join("herdr-panels");
    write_file(&script, macos_launch_script(exe).as_bytes())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755));
    }
    write_file(&contents.join("Info.plist"), macos_info_plist().as_bytes())?;
    write_file(
        &contents.join("Resources").join("herdr-panels.icns"),
        &macos_icon(),
    )?;
    Ok(app)
}

fn plain_path(path: &Path) -> String {
    let raw = path.display().to_string();
    raw.strip_prefix(r"\\?\").unwrap_or(&raw).to_string()
}

fn desktop_exec(exe: &Path) -> String {
    let text = plain_path(exe);
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

#[cfg(not(any(windows, target_os = "macos")))]
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

    #[test]
    fn a_windows_launch_script_hides_the_console_and_starts_the_viewer() {
        let script =
            windows_launch_script(Path::new(r"C:\Users\engel\.cargo\bin\herdr-panels.exe"));
        assert!(
            script.contains(r#"CurrentDirectory = "C:\Users\engel\.cargo\bin""#),
            "{script}"
        );
        assert!(
            script.contains(r#"Run """C:\Users\engel\.cargo\bin\herdr-panels.exe""", 0, False"#),
            "{script}"
        );
        assert!(!script.contains("herdr-panels-desktop"), "{script}");
        let spaced = windows_launch_script(Path::new(r"C:\Program Files\herdr-panels.exe"));
        assert!(
            spaced.contains(r#"Run """C:\Program Files\herdr-panels.exe""", 0, False"#),
            "{spaced}"
        );
        let verbatim = windows_launch_script(Path::new(r"\\?\C:\Users\engel\herdr-panels.exe"));
        assert!(!verbatim.contains('?'), "{verbatim}");
        assert!(verbatim.contains("herdr-panels.exe"), "{verbatim}");
    }

    #[test]
    fn a_windows_icon_holds_the_pngs() {
        let ico = windows_icon();
        assert!(ico.len() >= 6, "{}", ico.len());
        assert_eq!(
            u16::from_le_bytes(ico[2..4].try_into().unwrap()),
            1,
            "icon type"
        );
        let count = u16::from_le_bytes(ico[4..6].try_into().unwrap());
        assert_eq!(count, 3);
        for (index, side) in [(0usize, 48u8), (1, 128), (2, 0)] {
            let entry = 6 + index * 16;
            assert_eq!(ico[entry], side, "width {index}");
            assert_eq!(ico[entry + 1], side, "height {index}");
            let offset =
                u32::from_le_bytes(ico[entry + 12..entry + 16].try_into().unwrap()) as usize;
            assert_eq!(
                &ico[offset..offset + 8],
                b"\x89PNG\r\n\x1a\n",
                "image {index}"
            );
        }
    }

    #[test]
    fn windows_support_files_name_the_viewer() {
        let root = std::env::temp_dir().join(format!("hwp-win-launch-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let exe = Path::new(r"C:\Users\engel\.cargo\bin\herdr-panels.exe");
        let installed = install_windows_support(&root, exe).unwrap();
        let script = std::fs::read_to_string(&installed.script).unwrap_or_default();
        assert!(
            script.contains(r#"Run """C:\Users\engel\.cargo\bin\herdr-panels.exe""", 0, False"#),
            "{script}"
        );
        let icon = std::fs::read(&installed.icon).unwrap_or_default();
        assert!(icon.len() >= 6, "{}", icon.len());
        assert_eq!(u16::from_le_bytes(icon[2..4].try_into().unwrap()), 1);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[cfg(windows)]
    #[test]
    fn a_windows_shortcut_points_at_the_hidden_viewer_launch() {
        let root = std::env::temp_dir().join(format!("hwp-win-shortcut-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let support = root.join("support");
        let programs = root.join("Programs");
        let exe = Path::new(r"C:\Users\engel\.cargo\bin\herdr-panels.exe");
        let installed = install_windows_support(&support, exe).unwrap();
        let shortcut = install_windows_shortcut(
            &programs,
            &installed.script,
            &installed.icon,
            exe.parent().unwrap(),
        );
        assert!(shortcut.is_ok(), "{shortcut:?}");
        let shortcut = shortcut.unwrap();
        assert!(
            shortcut.ends_with("Herdr Panels.lnk"),
            "{}",
            shortcut.display()
        );
        let output = std::process::Command::new("powershell.exe")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                &format!(
                    "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $s = (New-Object -ComObject WScript.Shell).CreateShortcut('{}'); Write-Output $s.TargetPath; Write-Output $s.Arguments; Write-Output $s.IconLocation; Write-Output $s.Description",
                    shortcut.display().to_string().replace('\'', "''")
                ),
            ])
            .output()
            .unwrap();
        let text = String::from_utf8_lossy(&output.stdout);
        assert!(
            output.status.success(),
            "{text}{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let mut lines = text.lines();
        let target = lines.next().unwrap_or("");
        let arguments = lines.next().unwrap_or("");
        let icon = lines.next().unwrap_or("");
        let description = lines.next().unwrap_or("");
        assert!(target.ends_with("wscript.exe"), "{target}");
        assert!(arguments.contains("//B"), "{arguments}");
        assert!(arguments.contains("herdr-panels.vbs"), "{arguments}");
        assert!(!arguments.contains("herdr-panels-desktop"), "{arguments}");
        assert!(icon.contains("herdr-panels.ico"), "{icon}");
        assert_eq!(description, "Desk for a running Herdr session");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_mac_app_starts_the_viewer_without_its_own_dock_icon() {
        let script = macos_launch_script(Path::new("/Users/engel/.cargo/bin/herdr-panels"));
        assert!(script.starts_with("#!/bin/sh\n"), "{script}");
        assert!(
            script.contains("exec '/Users/engel/.cargo/bin/herdr-panels'\n"),
            "{script}"
        );
        assert!(!script.contains("herdr-panels-desktop"), "{script}");
        let spaced = macos_launch_script(Path::new("/Users/engel/My Programs/herdr-panels"));
        assert!(
            spaced.contains("exec '/Users/engel/My Programs/herdr-panels'\n"),
            "{spaced}"
        );
        let plist = macos_info_plist();
        assert!(plist.contains("<key>CFBundleDisplayName</key>"), "{plist}");
        assert!(plist.contains("<string>Herdr Panels</string>"), "{plist}");
        assert!(
            plist.contains("<key>CFBundleExecutable</key>\n\t<string>herdr-panels</string>"),
            "{plist}"
        );
        assert!(
            plist.contains("<key>CFBundleIconFile</key>\n\t<string>herdr-panels</string>"),
            "{plist}"
        );
        assert!(
            plist.contains("<key>LSUIElement</key>\n\t<true/>"),
            "{plist}"
        );
        assert!(!plist.contains("herdr-panels-desktop"), "{plist}");
        let icns = macos_icon();
        assert!(icns.len() >= 8, "{}", icns.len());
        assert_eq!(&icns[..4], b"icns");
        let length = u32::from_be_bytes(icns[4..8].try_into().unwrap()) as usize;
        assert_eq!(length, icns.len());
        assert!(icns.windows(4).any(|chunk| chunk == *b"ic07"), "128 png");
        assert!(icns.windows(4).any(|chunk| chunk == *b"ic08"), "256 png");

        let root = std::env::temp_dir().join(format!("hwp-mac-launch-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let exe = Path::new("/Users/engel/.cargo/bin/herdr-panels");
        let app = install_macos_app(&root, exe).unwrap();
        let plist =
            std::fs::read_to_string(app.join("Contents").join("Info.plist")).unwrap_or_default();
        assert!(plist.contains("<string>Herdr Panels</string>"), "{plist}");
        let script =
            std::fs::read_to_string(app.join("Contents").join("MacOS").join("herdr-panels"))
                .unwrap_or_default();
        assert!(
            script.contains("exec '/Users/engel/.cargo/bin/herdr-panels'\n"),
            "{script}"
        );
        let icns = std::fs::read(
            app.join("Contents")
                .join("Resources")
                .join("herdr-panels.icns"),
        )
        .unwrap_or_default();
        assert_eq!(&icns[..4], b"icns");
        let _ = std::fs::remove_dir_all(&root);
    }
}

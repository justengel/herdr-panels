fn main() {
    stamp_build();
    println!("cargo::rustc-check-cfg=cfg(embedded_dist)");
    println!("cargo:rerun-if-changed=examples");
    println!("cargo:rerun-if-changed=web/dist");
    let page = std::path::Path::new("web/dist/index.html");
    if page.is_file() {
        println!("cargo:rustc-cfg=embedded_dist");
    } else if std::env::var("PROFILE").ok().as_deref() == Some("release") {
        panic!("web/dist is missing. From web/, run npm install and npm run build before cargo build --release");
    } else {
        println!("cargo:warning=web/dist is missing, so this binary will not include the page");
    }
}

/// A stable identity for this source. Debug and release of the same tree match.
/// A desktop built after the viewer changed does not.
fn stamp_build() {
    let mut files = Vec::new();
    collect(std::path::Path::new("src"), &mut files);
    files.push(std::path::PathBuf::from("Cargo.toml"));
    files.sort();
    let mut hash: u64 = 0xcbf29ce484222325;
    for path in &files {
        println!("cargo:rerun-if-changed={}", path.display());
        let bytes = std::fs::read(path).unwrap_or_else(|err| {
            panic!(
                "could not read {} for the build identity: {err}",
                path.display()
            );
        });
        hash = fnv(hash, path.to_string_lossy().as_bytes());
        hash = fnv(hash, &bytes);
    }
    println!("cargo:rustc-env=HERDR_PANELS_BUILD={hash:016x}");
}

fn collect(dir: &std::path::Path, files: &mut Vec<std::path::PathBuf>) {
    let entries = std::fs::read_dir(dir).unwrap_or_else(|err| {
        panic!(
            "could not read {} for the build identity: {err}",
            dir.display()
        );
    });
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect(&path, files);
        } else if path.extension().and_then(|ext| ext.to_str()) == Some("rs") {
            files.push(path);
        }
    }
}

fn fnv(mut hash: u64, bytes: &[u8]) -> u64 {
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

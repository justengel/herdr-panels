fn main() {
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

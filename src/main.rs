#[tokio::main]
async fn main() {
    if let Err(err) = herdr_web_panels::cli::execute().await {
        eprintln!("error: {err:#}");
        std::process::exit(1);
    }
}

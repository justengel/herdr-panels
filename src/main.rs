#[tokio::main]
async fn main() {
    if let Err(err) = herdr_panels::cli::execute().await {
        eprintln!("error: {err:#}");
        std::process::exit(1);
    }
}

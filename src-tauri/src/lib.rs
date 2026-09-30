mod beads;

use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};

use tauri::{AppHandle, WebviewWindow, WebviewWindowBuilder};

/// Numbers the windows opened after the first one, whose label is `main`.
static NEXT_WINDOW: AtomicUsize = AtomicUsize::new(1);

/// How far down and right a new window sits from the one that opened it.
const CASCADE: f64 = 28.0;

/// Runs bd on a blocking thread so a slow database never stalls the async runtime.
async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn open_workspace(path: PathBuf) -> Result<beads::Workspace, String> {
    blocking(move || beads::open_workspace(&path)).await
}

#[tauri::command]
async fn load_board(path: PathBuf) -> Result<beads::Board, String> {
    blocking(move || beads::load_board(&path)).await
}

#[tauri::command]
async fn load_issue(path: PathBuf, id: String) -> Result<serde_json::Value, String> {
    blocking(move || beads::load_issue(&path, &id)).await
}

#[tauri::command]
fn change_marker(beads_dir: PathBuf) -> Option<u64> {
    beads::change_marker(&beads_dir)
}

/// Opens another board window from the `tauri.conf.json` window, cascaded from the caller.
/// Async because building a window in a synchronous command deadlocks on Windows.
#[tauri::command]
async fn new_window(app: AppHandle, window: WebviewWindow) -> Result<(), String> {
    let mut config = app
        .config()
        .app
        .windows
        .first()
        .cloned()
        .ok_or("tauri.conf.json defines no window")?;
    config.label = format!("board-{}", NEXT_WINDOW.fetch_add(1, Ordering::Relaxed));
    // Without a position, macOS centers the window exactly over a centered first window.
    let scale = window.scale_factor().map_err(|e| e.to_string())?;
    let origin = window
        .outer_position()
        .map_err(|e| e.to_string())?
        .to_logical::<f64>(scale);
    config.x = Some(origin.x + CASCADE);
    config.y = Some(origin.y + CASCADE);
    WebviewWindowBuilder::from_config(&app, &config)
        .and_then(|builder| builder.build())
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            open_workspace,
            load_board,
            load_issue,
            change_marker,
            new_window
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

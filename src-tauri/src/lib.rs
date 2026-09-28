mod beads;

use std::path::PathBuf;

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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            open_workspace,
            load_board,
            load_issue,
            change_marker
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

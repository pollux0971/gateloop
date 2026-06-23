use std::process::{Child, Command};
use std::sync::Mutex;
use tauri::Manager; // brings `manage` / `try_state` into scope

/// Holds the spawned @gateloop/api child so we can kill it when the app exits.
struct ApiSidecar(Mutex<Option<Child>>);

/// Spawn @gateloop/api (port 8787) via bun, from the repo tree.
///
/// The API reads the live gateloop/ tree (configs / packages / skills / fixtures), so it
/// runs from the repo rather than a self-contained binary. The repo path + bun binary are
/// baked at build time (GATELOOP_REPO / BUN_BIN), with sensible fallbacks; if the API is
/// already listening on 8787 the child simply fails to bind and exits (harmless).
fn spawn_api() -> Option<Child> {
    let repo = option_env!("GATELOOP_REPO").unwrap_or("/data/python/codeharness_workspace/gateloop");
    let bun = option_env!("BUN_BIN").unwrap_or("bun");
    let entry = format!("{repo}/apps/api/src/index.ts");
    match Command::new(bun).arg(entry).current_dir(repo).spawn() {
        Ok(child) => {
            eprintln!("[gateloop] spawned @gateloop/api sidecar (bun, pid {})", child.id());
            Some(child)
        }
        Err(e) => {
            eprintln!("[gateloop] could not spawn api sidecar ({e}); start it manually: pnpm --filter @gateloop/api dev");
            None
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            // Auto-start the API backend so double-launching the app "just works".
            app.manage(ApiSidecar(Mutex::new(spawn_api())));
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            if let tauri::RunEvent::Exit = event {
                if let Some(state) = app_handle.try_state::<ApiSidecar>() {
                    if let Ok(mut guard) = state.0.lock() {
                        if let Some(mut child) = guard.take() {
                            let _ = child.kill();
                        }
                    }
                }
            }
        });
}

use crate::{updater, AppState};
use tauri_plugin_updater::UpdaterExt;

#[tauri::command]
pub async fn get_updater_status(
    state: tauri::State<'_, AppState>,
) -> Result<updater::UpdaterStatus, String> {
    Ok(updater::unavailable_status(
        &state.config.app_version,
        state.config.updater_public_key_configured,
    ))
}

#[tauri::command]
pub async fn check_for_update(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<updater::UpdaterStatus, String> {
    let (current_version, has_public_key) = {
        let config = &state.config;
        (
            config.app_version.clone(),
            config.updater_public_key_configured,
        )
    };

    match app.updater() {
        Ok(updater_client) => match updater_client.check().await {
            Ok(Some(update)) => Ok(updater::update_to_status(&update, has_public_key)),
            Ok(None) => Ok(updater::unavailable_status(
                &current_version,
                has_public_key,
            )),
            Err(e) => Ok(updater::check_error_status(
                &current_version,
                "UPDATER_CHECK_FAILED",
                &e.to_string(),
                has_public_key,
            )),
        },
        Err(e) => Ok(updater::check_error_status(
            &current_version,
            "UPDATER_NOT_CONFIGURED",
            &e.to_string(),
            has_public_key,
        )),
    }
}

#[tauri::command]
pub async fn install_update(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<updater::UpdaterStatus, String> {
    let (current_version, has_public_key) = {
        let config = &state.config;
        (
            config.app_version.clone(),
            config.updater_public_key_configured,
        )
    };

    if !has_public_key {
        return Ok(updater::check_error_status(
            &current_version,
            "UPDATER_SIGNATURE_KEY_MISSING",
            "Tauri updater public key is not configured",
            has_public_key,
        ));
    }

    match app.updater() {
        Ok(updater_client) => match updater_client.check().await {
            Ok(Some(update)) => {
                let status = updater::update_to_status(&update, has_public_key);
                match update.download_and_install(|_, _| {}, || {}).await {
                    Ok(()) => Ok(status),
                    Err(e) => Ok(updater::check_error_status(
                        &current_version,
                        "UPDATER_INSTALL_FAILED",
                        &e.to_string(),
                        has_public_key,
                    )),
                }
            }
            Ok(None) => Ok(updater::unavailable_status(
                &current_version,
                has_public_key,
            )),
            Err(e) => Ok(updater::check_error_status(
                &current_version,
                "UPDATER_CHECK_FAILED",
                &e.to_string(),
                has_public_key,
            )),
        },
        Err(e) => Ok(updater::check_error_status(
            &current_version,
            "UPDATER_NOT_CONFIGURED",
            &e.to_string(),
            has_public_key,
        )),
    }
}

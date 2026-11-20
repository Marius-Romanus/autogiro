//! Actualizaciones automáticas: al abrir la app mira si en GitHub hay una versión más nueva
//! (latest.json de la última release, firmado con la clave de `TAURI_SIGNING_PRIVATE_KEY`,
//! ver .github/workflows/release.yml). Si la hay, lo pregunta; si se acepta, descarga el
//! instalador, lo ejecuta con barra de progreso y vuelve a abrir el juego ya actualizado.

use std::time::Duration;

use tauri::AppHandle;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_updater::UpdaterExt;

type Error = Box<dyn std::error::Error + Send + Sync>;

/// Lanza la comprobación en segundo plano (no en las compilaciones de desarrollo).
pub fn check_in_background(app: AppHandle) {
    if cfg!(debug_assertions) || std::env::var_os("AUTOGIRO_NO_UPDATE").is_some() {
        return;
    }
    tauri::async_runtime::spawn(async move {
        // que el juego arranque primero; sin conexión, simplemente no pasa nada
        tokio::time::sleep(Duration::from_secs(4)).await;
        if let Err(e) = check(&app).await {
            log(&format!("no se pudo comprobar si hay versión nueva: {e}"));
        }
    });
}

async fn check(app: &AppHandle) -> Result<(), Error> {
    let Some(update) = app.updater()?.check().await? else { return Ok(()) };
    let es = spanish();
    let mut notes = update.body.clone().unwrap_or_default().trim().to_string();
    if notes.chars().count() > 700 {
        notes = notes.chars().take(700).collect::<String>() + "…";
    }
    let current = &update.current_version;
    let new = &update.version;
    let (title, text, ok, later) = if es {
        (
            "Hay una versión nueva de Autogiro".to_string(),
            format!(
                "Tienes la {current} y ya está la {new}.\n\n{notes}\n\n¿Actualizar ahora? Se descarga, se instala sola y el juego se vuelve a abrir."
            ),
            "Actualizar ahora",
            "Más tarde",
        )
    } else {
        (
            "A new version of Autogiro is available".to_string(),
            format!(
                "You have {current} and {new} is out.\n\n{notes}\n\nUpdate now? It downloads, installs itself and the game opens again."
            ),
            "Update now",
            "Later",
        )
    };

    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .message(text.replace("\n\n\n\n", "\n\n"))
        .title(title)
        .kind(MessageDialogKind::Info)
        .buttons(MessageDialogButtons::OkCancelCustom(ok.into(), later.into()))
        .show(move |yes| {
            let _ = tx.send(yes);
        });
    if !rx.await.unwrap_or(false) {
        return Ok(());
    }

    // en Windows esto ejecuta el instalador (modo pasivo: solo barra de progreso) y cierra la app;
    // el instalador la vuelve a abrir al terminar
    if let Err(e) = update.download_and_install(|_, _| {}, || {}).await {
        let msg = if es {
            format!("No se pudo actualizar: {e}\n\nPuedes descargar la versión nueva desde GitHub.")
        } else {
            format!("The update failed: {e}\n\nYou can download the new version from GitHub.")
        };
        app.dialog().message(msg).title("Autogiro").kind(MessageDialogKind::Error).show(|_| {});
    }
    Ok(())
}

/// Mismo criterio que el juego (src/i18n.ts): español, catalán, gallego o euskera → español.
fn spanish() -> bool {
    let lang = sys_locale::get_locale().unwrap_or_default().to_lowercase();
    ["es", "ca", "gl", "eu"].iter().any(|p| lang == *p || lang.starts_with(&format!("{p}-")))
}

fn log(msg: &str) {
    use std::io::Write;
    let _ = writeln!(std::io::stderr(), "[actualizar] {msg}");
}

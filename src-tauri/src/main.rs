// App de escritorio de Autogiro (Tauri 2, Windows y Linux).
//
// Arranca dentro un servidor local que hace lo mismo que `npm run server` (el juego
// compilado de dist/ + las salas multijugador en /mp, ver server.rs y rooms.rs) y abre
// http://localhost:<puerto>/ en una ventana WebView2 (el motor de Edge) en Windows o
// WebKitGTK en Linux. Así el juego funciona igual que en el navegador y el que lo instala
// ya tiene servidor de partidas para sus amigos (misma wifi o túnel), sin instalar Node.
//
//   npm run app:build   → en Windows src-tauri/target/release/bundle/nsis/Autogiro_<versión>_x64-setup.exe;
//                         en Linux bundle/appimage, bundle/deb y bundle/rpm (tauri.linux.conf.json)
//   npm run release     → nueva versión publicada en GitHub (tools/release.mjs + .github/workflows/release.yml)

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod catastro;
mod rooms;
mod tejados;
mod server;
mod updates;

use std::path::PathBuf;

use tauri::webview::NewWindowResponse;
use tauri::{App, Manager, Url, WebviewUrl, WebviewWindowBuilder};

/// Puertos que prueba, en orden. Lo guardado por el juego (idioma, clave de Google, ajustes,
/// nombre de piloto) va en el localStorage de http://localhost:<puerto>, así que conviene que
/// casi siempre salga el mismo: uno poco habitual y solo se pasa al siguiente si está ocupado.
const PORTS: [u16; 8] = [47800, 47801, 47802, 47803, 47804, 47805, 47806, 47807];

/// Chromium (WebView2): sin las ventanas y comprobaciones de Edge que no pintan nada aquí
/// (lo que wry pone por defecto), con la gráfica dedicada en portátiles con dos GPU y con
/// sonido aunque aún no se haya pulsado nada.
const BROWSER_ARGS: &str = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection \
    --force_high_performance_gpu --autoplay-policy=no-user-gesture-required";

/// Se inyecta en la página del juego: F11 o Alt+Intro ponen/quitan la pantalla completa
/// de la ventana (la capacidad `game` solo le deja hacer eso) y el clic derecho no saca el
/// menú del navegador salvo en los campos de texto.
const PAGE_JS: &str = r#"
(() => {
  if (window.top !== window) return
  const invoke = (cmd, args) => window.__TAURI_INTERNALS__.invoke(cmd, args)
  let busy = false
  const toggle = async () => {
    if (busy) return
    busy = true
    try {
      const full = await invoke('plugin:window|is_fullscreen', { label: 'main' })
      await invoke('plugin:window|set_fullscreen', { label: 'main', value: !full })
    } catch (e) {
      console.warn('[app] pantalla completa:', e)
    }
    busy = false
  }
  addEventListener('keydown', (e) => {
    if (e.key === 'F11' || (e.key === 'Enter' && e.altKey)) {
      e.preventDefault()
      e.stopImmediatePropagation()
      if (!e.repeat) void toggle()
    }
  }, true)
  addEventListener('contextmenu', (e) => {
    if (!(e.target instanceof Element && e.target.closest('input, textarea, [contenteditable]'))) e.preventDefault()
  })
})()
"#;

fn main() {
    #[cfg(target_os = "linux")]
    linux::before_start();
    tauri::Builder::default()
        // una sola copia abierta: la segunda trae al frente la primera
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            // versión nueva en GitHub → lo pregunta (updates.rs); también si el juego no arranca
            updates::check_in_background(app.handle().clone());
            let dist = find_dist(app);
            if !dist.join("index.html").is_file() {
                return error_window(app, &format!("No encuentro el juego en {}", dist.display()));
            }
            match server::bind(&PORTS) {
                Ok((listener, port)) => {
                    tauri::async_runtime::spawn(server::serve(listener, dist, rooms::Rooms::default()));
                    game_window(app, port)
                }
                Err(e) => error_window(
                    app,
                    &format!("No hay ningún puerto libre entre {} y {}: {e}", PORTS[0], PORTS[PORTS.len() - 1]),
                ),
            }
        })
        .run(tauri::generate_context!())
        .expect("error al arrancar Autogiro");
}

/// Carpeta con el juego compilado: la de recursos de la instalación; al desarrollar,
/// `AUTOGIRO_DIST` o el dist/ del proyecto.
fn find_dist(app: &App) -> PathBuf {
    if let Some(p) = std::env::var_os("AUTOGIRO_DIST") {
        return PathBuf::from(p);
    }
    let installed = app.path().resource_dir().map(|d| d.join("dist")).unwrap_or_default();
    if cfg!(debug_assertions) && !installed.join("index.html").is_file() {
        return PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join("dist");
    }
    installed
}

fn game_window(app: &App, port: u16) -> Result<(), Box<dyn std::error::Error>> {
    let info = serde_json::json!({
        "version": app.package_info().version.to_string(),
        "port": port,
        "lan": server::lan_ip(),
        "os": std::env::consts::OS,
    });
    let init = format!("window.__AUTOGIRO_APP__ = Object.freeze({info});\n{PAGE_JS}");

    let mut args = BROWSER_ARGS.to_string();
    // para depurar la app instalada desde fuera (Chrome DevTools Protocol)
    if let Ok(p) = std::env::var("AUTOGIRO_DEVTOOLS_PORT") {
        args.push_str(&format!(" --remote-debugging-port={p}"));
    }

    let is_game = move |u: &Url| {
        u.scheme() == "http" && u.host_str() == Some("localhost") && u.port() == Some(port)
            || matches!(u.scheme(), "about" | "data" | "blob")
    };

    let window = WebviewWindowBuilder::new(app, "main", WebviewUrl::External(format!("http://localhost:{port}/").parse()?))
        .title("Autogiro")
        .inner_size(1600.0, 900.0)
        .min_inner_size(960.0, 600.0)
        .center()
        .maximized(true)
        .additional_browser_args(&args)
        .initialization_script(init)
        // los enlaces de fuera (blog, Ko-fi, ayuda) se abren en el navegador del sistema
        .on_navigation(move |u| is_game(u) || open_outside(u))
        .on_new_window(move |u, _| {
            if !is_game(&u) {
                open_outside(&u);
            }
            NewWindowResponse::Deny
        })
        .build()?;
    #[cfg(target_os = "linux")]
    linux::tune_webview(&window);
    #[cfg(not(target_os = "linux"))]
    let _ = window;
    Ok(())
}

/// Linux (WebKitGTK): lo que en Windows hacen los argumentos de Chromium de `BROWSER_ARGS`.
#[cfg(target_os = "linux")]
mod linux {
    use webkit2gtk::{HardwareAccelerationPolicy, SettingsExt, WebViewExt};

    /// Antes de crear ninguna ventana. Con el driver propietario de NVIDIA el renderizado
    /// por DMA-BUF de WebKitGTK deja a menudo la ventana en blanco o en negro; se desactiva
    /// salvo que el usuario ya haya puesto la variable él mismo.
    pub fn before_start() {
        if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none()
            && std::path::Path::new("/proc/driver/nvidia/version").exists()
        {
            // todavía no hay más hilos: nadie más lee el entorno a la vez
            std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
        }
    }

    /// Siempre con la gráfica (sin el modo «solo cuando haga falta», que en un juego 3D
    /// solo añade cambios de modo) y con sonido aunque aún no se haya pulsado nada.
    /// `AUTOGIRO_CONSOLE=1` saca la consola del juego por la terminal, para depurar.
    pub fn tune_webview(window: &tauri::WebviewWindow) {
        let console = std::env::var_os("AUTOGIRO_CONSOLE").is_some();
        let _ = window.with_webview(move |w| {
            let Some(settings) = w.inner().settings() else { return };
            settings.set_hardware_acceleration_policy(HardwareAccelerationPolicy::Always);
            settings.set_media_playback_requires_user_gesture(false);
            if console {
                settings.set_enable_write_console_messages_to_stdout(true);
            }
        });
    }
}

/// Abre http(s)/mailto en el navegador o programa del sistema. Siempre devuelve false
/// (la ventana del juego no navega).
fn open_outside(u: &Url) -> bool {
    if matches!(u.scheme(), "http" | "https" | "mailto") {
        let _ = open::that_detached(u.as_str());
    }
    false
}

/// Ventana con un mensaje de error (ui/index.html) cuando el juego no puede arrancar.
fn error_window(app: &App, msg: &str) -> Result<(), Box<dyn std::error::Error>> {
    let init = format!("window.__AUTOGIRO_ERROR__ = {};", serde_json::to_string(msg)?);
    WebviewWindowBuilder::new(app, "error", WebviewUrl::App("index.html".into()))
        .title("Autogiro")
        .inner_size(640.0, 360.0)
        .center()
        .initialization_script(init)
        .build()?;
    Ok(())
}

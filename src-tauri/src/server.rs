//! Servidor HTTP local de la app: hace lo mismo que `server/index.ts` (sirve el juego
//! compilado, las salas multijugador en /mp y los intermediarios del Catastro (/catastro/…) y de los tejados del mundo (/tejados/…),
//! todo en el mismo puerto), sin Node.

use std::io;
use std::net::{Ipv4Addr, SocketAddr, TcpListener};
use std::path::PathBuf;
use std::sync::Arc;

use axum::extract::ws::WebSocketUpgrade;
use axum::extract::State;
use axum::http::{header, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use percent_encoding::percent_decode_str;

use crate::rooms::{handle_socket, Rooms, MAX_PAYLOAD};

#[derive(Clone)]
struct AppState {
    root: Arc<PathBuf>,
    rooms: Rooms,
}

/// Abre el primer puerto libre de la lista en todas las interfaces (para que entren amigos
/// de la misma red o un túnel). Escucha desde ya: la ventana puede cargar aunque el bucle
/// de `serve` aún no haya arrancado.
pub fn bind(ports: &[u16]) -> io::Result<(TcpListener, u16)> {
    let mut last = io::Error::new(io::ErrorKind::AddrInUse, "sin puertos");
    for &port in ports {
        match TcpListener::bind(SocketAddr::from((Ipv4Addr::UNSPECIFIED, port))) {
            Ok(l) => {
                l.set_nonblocking(true)?;
                return Ok((l, port));
            }
            Err(e) => last = e,
        }
    }
    Err(last)
}

pub async fn serve(listener: TcpListener, root: PathBuf, rooms: Rooms) {
    let listener = match tokio::net::TcpListener::from_std(listener) {
        Ok(l) => l,
        Err(e) => return log(&format!("no se pudo escuchar: {e}")),
    };
    let state = AppState { root: Arc::new(root), rooms };
    let app = Router::new()
        .route("/mp", get(mp))
        // edificios del Catastro (sus zips no se pueden pedir desde la página): ver catastro.rs
        .route("/catastro/{*path}", get(crate::catastro::proxy))
        // tejados de OSM del mundo (adjunto de GitHub sin CORS, por rangos): ver tejados.rs
        .route("/tejados/{file}", get(crate::tejados::proxy))
        .fallback(static_file)
        .with_state(state);
    if let Err(e) = axum::serve(listener, app).await {
        log(&format!("servidor detenido: {e}"));
    }
}

async fn mp(State(s): State<AppState>, ws: WebSocketUpgrade) -> Response {
    ws.max_message_size(MAX_PAYLOAD)
        .max_frame_size(MAX_PAYLOAD)
        .on_upgrade(move |socket| handle_socket(s.rooms, socket))
}

async fn static_file(State(s): State<AppState>, uri: Uri) -> Response {
    let Ok(path) = percent_decode_str(uri.path()).decode_utf8() else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    let root = s.root.as_path();
    let mut file = root.to_path_buf();
    let mut in_assets = false;
    for (i, seg) in path.split('/').filter(|x| !x.is_empty() && *x != ".").enumerate() {
        if seg == ".." || seg.contains(['\\', ':', '\0']) {
            return StatusCode::FORBIDDEN.into_response();
        }
        in_assets |= i == 0 && seg == "assets";
        file.push(seg);
    }
    // lo que no existe es una ruta de la página: index.html (como server/index.ts)
    if !tokio::fs::metadata(&file).await.is_ok_and(|m| m.is_file()) {
        file = root.join("index.html");
        in_assets = false;
    }
    let ext = file.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    let mime = match ext.as_str() {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json",
        "wasm" => "application/wasm",
        "glb" => "model/gltf-binary",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "ico" => "image/x-icon",
        _ => "application/octet-stream",
    };
    let cache = if in_assets { "public, max-age=31536000, immutable" } else { "no-cache" };
    match tokio::fs::read(&file).await {
        Ok(bytes) => ([(header::CONTENT_TYPE, mime), (header::CACHE_CONTROL, cache)], bytes).into_response(),
        Err(_) => StatusCode::NOT_FOUND.into_response(),
    }
}

/// IP de este ordenador en la red local (la de la interfaz que sale a Internet), si la hay.
pub fn lan_ip() -> Option<String> {
    let sock = std::net::UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0)).ok()?;
    sock.connect((Ipv4Addr::new(192, 0, 2, 1), 9)).ok()?; // no envía nada
    match sock.local_addr().ok()?.ip() {
        std::net::IpAddr::V4(ip) if !ip.is_loopback() && !ip.is_unspecified() => Some(ip.to_string()),
        _ => None,
    }
}

fn log(msg: &str) {
    use std::io::Write;
    let _ = writeln!(io::stderr(), "[servidor] {msg}");
}

#[cfg(test)]
mod tests {
    use super::*;

    /// El servidor de la app sin abrir ninguna ventana, para pasarle la batería de Node:
    ///     cargo test -- --ignored --nocapture salas_para_mp_test      (en src-tauri; ~2 min)
    ///     MP_URL=ws://127.0.0.1:47899/mp npm run mp-test              (en otra terminal)
    /// Solo en 127.0.0.1 (no pide paso al cortafuegos). Puerto y duración: MP_TEST_PORT, MP_TEST_SECS.
    #[tokio::test(flavor = "multi_thread")]
    #[ignore]
    async fn salas_para_mp_test() {
        let port: u16 = std::env::var("MP_TEST_PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(47899);
        let secs: u64 = std::env::var("MP_TEST_SECS").ok().and_then(|p| p.parse().ok()).unwrap_or(120);
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, port)).expect("puerto ocupado");
        listener.set_nonblocking(true).expect("no bloqueante");
        let task = tokio::spawn(serve(listener, std::env::temp_dir(), Rooms::default()));
        log(&format!("salas en ws://127.0.0.1:{port}/mp durante {secs} s"));
        tokio::time::sleep(std::time::Duration::from_secs(secs)).await;
        task.abort();
    }
}

//! /tejados/<fichero> → adjunto de la versión «datos-tejados» de GitHub, por rangos.
//!
//! Los tejados de OpenStreetMap de todo el mundo (src/world/worldRoofs.ts) son un fichero de
//! ~150 MB del que el juego pide solo trozos (el índice y la zona por donde vuela). GitHub sirve
//! los adjuntos con rangos pero sin cabeceras CORS, así que la página no los puede pedir
//! directamente: este servidor hace de intermediario. Es lo mismo que `server/tejados.ts`:
//! mantener iguales.

use std::sync::OnceLock;

use axum::body::Body;
use axum::extract::Path;
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};

const UPSTREAM: &str = "https://github.com/Marius-Romanus/autogiro/releases/download/datos-tejados/";
/// un solo rango, de 32 MB como mucho (el índice o una zona; nunca el fichero entero)
const MAX: u64 = 32 << 20;

fn client() -> Option<&'static reqwest::Client> {
    static C: OnceLock<Option<reqwest::Client>> = OnceLock::new();
    C.get_or_init(|| {
        // TLS con el mismo proveedor que el actualizador (ring); si ya hay uno instalado, ese vale
        let _ = rustls::crypto::ring::default_provider().install_default();
        reqwest::Client::builder().user_agent("Autogiro (simulador de vuelo)").build().ok()
    })
    .as_ref()
}

/// «tejados-mundo-AAAAMMDD.bin» (como FILE en server/tejados.ts)
fn allowed(file: &str) -> bool {
    file.strip_prefix("tejados-mundo-")
        .and_then(|r| r.strip_suffix(".bin"))
        .is_some_and(|d| d.len() == 8 && d.bytes().all(|b| b.is_ascii_digit()))
}

/// «bytes=a-b» con a ≤ b y menos de MAX bytes (como RANGE en server/tejados.ts)
fn range(v: &str) -> Option<(u64, u64)> {
    let (a, b) = v.strip_prefix("bytes=")?.split_once('-')?;
    let digits = |s: &str| !s.is_empty() && s.len() <= 12 && s.bytes().all(|c| c.is_ascii_digit());
    if !digits(a) || !digits(b) {
        return None;
    }
    let (a, b): (u64, u64) = (a.parse().ok()?, b.parse().ok()?);
    (b >= a && b - a < MAX).then_some((a, b))
}

pub async fn proxy(Path(file): Path<String>, headers: HeaderMap) -> Response {
    if !allowed(&file) {
        return StatusCode::NOT_FOUND.into_response();
    }
    let Some((a, b)) = headers.get(header::RANGE).and_then(|v| v.to_str().ok()).and_then(range) else {
        return StatusCode::RANGE_NOT_SATISFIABLE.into_response();
    };
    let Some(client) = client() else {
        return (StatusCode::BAD_GATEWAY, "Tejados: sin cliente HTTP").into_response();
    };
    let up = match client.get(format!("{UPSTREAM}{file}")).header(reqwest::header::RANGE, format!("bytes={a}-{b}")).send().await {
        Ok(r) => r,
        Err(e) => return (StatusCode::BAD_GATEWAY, format!("Tejados: {e}")).into_response(),
    };
    let status = StatusCode::from_u16(up.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
    let mut res = Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "application/octet-stream")
        // el nombre lleva la fecha de los datos: no cambia nunca
        .header(header::CACHE_CONTROL, "public, max-age=604800, immutable");
    if let Some(cr) = up.headers().get(reqwest::header::CONTENT_RANGE).and_then(|v| v.to_str().ok()) {
        res = res.header(header::CONTENT_RANGE, cr.to_string());
    }
    if let Some(n) = up.content_length() {
        res = res.header(header::CONTENT_LENGTH, n);
    }
    res.body(Body::from_stream(up.bytes_stream())).unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}

#[cfg(test)]
mod tests {
    use super::{allowed, range};

    #[test]
    fn rutas_y_rangos() {
        assert!(allowed("tejados-mundo-20261118.bin"));
        assert!(!allowed("tejados-mundo-2026111.bin"));
        assert!(!allowed("../tejados-mundo-20261118.bin"));
        assert!(!allowed("latest.json"));
        assert_eq!(range("bytes=0-262143"), Some((0, 262143)));
        assert_eq!(range("bytes=10-5"), None);
        assert_eq!(range("bytes=0-"), None);
        assert_eq!(range("bytes=0-99999999999"), None);
        assert_eq!(range("bytes=1-2,4-5"), None);
    }

    /// Con red: `cargo test -- --ignored tejados`
    #[tokio::test]
    #[ignore]
    async fn descarga_real() {
        use axum::extract::Path;
        use axum::http::{header, HeaderMap, HeaderValue};
        let mut h = HeaderMap::new();
        h.insert(header::RANGE, HeaderValue::from_static("bytes=0-262143"));
        let res = super::proxy(Path("tejados-mundo-20261118.bin".to_string()), h).await;
        assert_eq!(res.status(), 206);
        let body = axum::body::to_bytes(res.into_body(), 1 << 20).await.unwrap();
        assert!(body.len() == 262144 && &body[..4] == b"ROW1", "{} bytes", body.len());
        let res = super::proxy(Path("tejados-mundo-20261118.bin".to_string()), HeaderMap::new()).await;
        assert_eq!(res.status(), 416);
    }
}

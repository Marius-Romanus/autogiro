//! /catastro/<ruta> → https://www.catastro.hacienda.gob.es/INSPIRE/<ruta>
//!
//! Los índices y los zips de edificios del Catastro (INSPIRE, por municipios) no llevan
//! cabeceras CORS, así que la página no los puede pedir directamente: este servidor hace de
//! intermediario solo para esas rutas. Es lo mismo que `server/catastro.ts`: mantener iguales.

use std::sync::OnceLock;

use axum::body::Body;
use axum::http::{header, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use percent_encoding::{percent_decode_str, utf8_percent_encode, NON_ALPHANUMERIC};

const UPSTREAM: &str = "https://www.catastro.hacienda.gob.es/INSPIRE/";

fn client() -> Option<&'static reqwest::Client> {
    static C: OnceLock<Option<reqwest::Client>> = OnceLock::new();
    C.get_or_init(|| {
        // TLS con el mismo proveedor que el actualizador (ring); si ya hay uno instalado, ese vale
        let _ = rustls::crypto::ring::default_provider().install_default();
        reqwest::Client::builder().user_agent("Autogiro (simulador de vuelo)").build().ok()
    })
    .as_ref()
}

/// Índice nacional, índice de una gerencia y zip de un municipio (como ALLOWED en server/catastro.ts).
fn allowed(path: &str) -> bool {
    let p: Vec<&str> = path.split('/').collect();
    let digits = |s: &str, n: usize| s.len() == n && s.bytes().all(|b| b.is_ascii_digit());
    match p.as_slice() {
        ["buildings", "ES.SDGC.BU.atom.xml"] => true,
        ["buildings", office, file] => {
            digits(office, 2) && file.strip_prefix("ES.SDGC.bu.atom_").and_then(|r| r.strip_suffix(".xml")).is_some_and(|c| digits(c, 2))
        }
        ["Buildings", office, muni, file] => {
            digits(office, 2)
                && muni.len() <= 90
                && muni.get(..5).is_some_and(|c| digits(c, 5))
                && muni.as_bytes().get(5) == Some(&b'-')
                && !muni.contains(['\\', '\0'])
                && *muni != ".."
                && file.strip_prefix("A.ES.SDGC.BU.").and_then(|r| r.strip_suffix(".zip")).is_some_and(|c| digits(c, 5))
        }
        _ => false,
    }
}

pub async fn proxy(uri: Uri) -> Response {
    let Some(rest) = uri.path().strip_prefix("/catastro/") else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let Ok(path) = percent_decode_str(rest).decode_utf8() else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    if !allowed(&path) {
        return StatusCode::NOT_FOUND.into_response();
    }
    let target = format!(
        "{UPSTREAM}{}",
        path.split('/').map(|s| utf8_percent_encode(s, NON_ALPHANUMERIC).to_string()).collect::<Vec<_>>().join("/")
    );
    let Some(client) = client() else {
        return (StatusCode::BAD_GATEWAY, "Catastro: sin cliente HTTP").into_response();
    };
    let up = match client.get(&target).send().await {
        Ok(r) => r,
        Err(e) => return (StatusCode::BAD_GATEWAY, format!("Catastro: {e}")).into_response(),
    };
    let status = StatusCode::from_u16(up.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
    let ctype = up
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("application/octet-stream")
        .to_string();
    // sin la función gzip de reqwest el cuerpo llega tal cual: si viniera comprimido, se dice
    // (y la longitud es la de esos bytes, que son los que se reenvían)
    let encoding = up.headers().get(reqwest::header::CONTENT_ENCODING).and_then(|v| v.to_str().ok()).map(str::to_string);
    let len = up.content_length();
    let mut res = Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, ctype)
        .header(header::CACHE_CONTROL, "no-store");
    if let Some(enc) = encoding {
        res = res.header(header::CONTENT_ENCODING, enc);
    }
    if let Some(n) = len {
        res = res.header(header::CONTENT_LENGTH, n);
    }
    res.body(Body::from_stream(up.bytes_stream())).unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}

#[cfg(test)]
mod tests {
    use super::allowed;

    #[test]
    fn rutas() {
        assert!(allowed("buildings/ES.SDGC.BU.atom.xml"));
        assert!(allowed("buildings/28/ES.SDGC.bu.atom_28.xml"));
        assert!(allowed("Buildings/28/28089-MORALEJA DE ENMEDIO/A.ES.SDGC.BU.28089.zip"));
        assert!(allowed("Buildings/04/04018-ARMUÑA DEL ALMANZORA/A.ES.SDGC.BU.04018.zip"));
        assert!(!allowed("Buildings/28/../A.ES.SDGC.BU.28089.zip"));
        assert!(!allowed("buildings/28/../../etc"));
        assert!(!allowed("parcels/ES.SDGC.CP.atom.xml"));
        assert!(!allowed("Buildings/28/28089-X/otra.zip"));
    }

    /// Con red: `cargo test -- --ignored catastro`
    #[tokio::test]
    #[ignore]
    async fn descarga_real() {
        use axum::http::Uri;
        let res = super::proxy(Uri::from_static("/catastro/Buildings/28/28089-MORALEJA%20DE%20ENMEDIO/A.ES.SDGC.BU.28089.zip")).await;
        assert_eq!(res.status(), 200);
        let body = axum::body::to_bytes(res.into_body(), 50 << 20).await.unwrap();
        assert!(body.len() > 500_000 && &body[..2] == b"PK", "zip de {} bytes", body.len());
        // el índice nacional entero (682 KB, termina en </feed>)
        let res = super::proxy(Uri::from_static("/catastro/buildings/ES.SDGC.BU.atom.xml")).await;
        assert_eq!(res.status(), 200);
        assert!(res.headers().get(axum::http::header::CONTENT_ENCODING).is_none());
        let body = axum::body::to_bytes(res.into_body(), 10 << 20).await.unwrap();
        assert!(body.len() > 500_000 && String::from_utf8_lossy(&body).trim_end().ends_with("</feed>"), "índice de {} bytes", body.len());
        let res = super::proxy(Uri::from_static("/catastro/etc/passwd")).await;
        assert_eq!(res.status(), 404);
    }
}

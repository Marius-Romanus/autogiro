//! Servidor de salas del multijugador para la app de escritorio.
//!
//! Es una traducción a Rust de `server/rooms.ts` (mismo protocolo: `src/net/protocol.ts`),
//! para que la app no tenga que llevar Node dentro. Si cambias el protocolo o las reglas de
//! las salas en un lado, cámbialo también en el otro. Para probar este servidor con la misma
//! batería que el de Node: arranca la app y lanza
//!     MP_URL=ws://127.0.0.1:47800/mp npm run mp-test
//!
//! No simula nada: cada cliente es dueño de su autogiro y el servidor solo reparte los
//! mensajes dentro de la sala (estado, chat, condiciones del anfitrión).

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use axum::extract::ws::{Message, Utf8Bytes, WebSocket};
use serde_json::{json, Map, Value};
use tokio::sync::mpsc::{unbounded_channel, UnboundedSender};

const CODE_ALPHABET: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LENGTH: usize = 4;
const MAX_PLAYERS: usize = 8;
const NAME_MAX: usize = 20;
const CHAT_MAX: usize = 200;
const MAX_ROOMS: usize = 2000;
/// mensajes/s sostenidos por cliente (estado a 15 Hz + chat)
const RATE: f64 = 40.0;
const BURST: f64 = 80.0;
/// tamaño máximo de un mensaje (como `maxPayload` en rooms.ts)
pub const MAX_PAYLOAD: usize = 4096;
/// conexiones muertas (portátil suspendido, red caída…)
const HEARTBEAT: Duration = Duration::from_secs(15);

struct Client {
    tx: UnboundedSender<Message>,
    name: String,
    aircraft: String,
    passenger: bool,
    slot: u32,
    room: Option<String>,
}

struct Room {
    /// ids por orden de llegada: si el anfitrión se va, pasa al primero
    members: Vec<u64>,
    host_id: u64,
    cond: Option<Value>,
    cond_at: Instant,
}

#[derive(Default)]
struct State {
    rooms: HashMap<String, Room>,
    clients: HashMap<u64, Client>,
    next_id: u64,
}

/// Estado compartido de todas las salas.
#[derive(Clone, Default)]
pub struct Rooms(Arc<Mutex<State>>);

impl Rooms {
    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.0.lock().unwrap_or_else(|e| e.into_inner())
    }
}

/// Atiende una conexión WebSocket de /mp hasta que se cierra.
pub async fn handle_socket(rooms: Rooms, mut socket: WebSocket) {
    let (tx, mut rx) = unbounded_channel::<Message>();
    let id = {
        let mut s = rooms.lock();
        s.next_id += 1;
        let id = s.next_id;
        s.clients.insert(
            id,
            Client { tx, name: "Piloto".into(), aircraft: "generic".into(), passenger: false, slot: 0, room: None },
        );
        id
    };

    let mut alive = true;
    // límite de ritmo: cubo de fichas
    let mut tokens = BURST;
    let mut last_refill = Instant::now();
    let mut beat = tokio::time::interval_at(tokio::time::Instant::now() + HEARTBEAT, HEARTBEAT);

    loop {
        tokio::select! {
            msg = socket.recv() => match msg {
                Some(Ok(Message::Text(text))) => {
                    let now = Instant::now();
                    tokens = (tokens + now.duration_since(last_refill).as_secs_f64() * RATE).min(BURST);
                    last_refill = now;
                    if tokens < 1.0 {
                        continue;
                    }
                    tokens -= 1.0;
                    rooms.lock().handle(id, text.as_str());
                }
                Some(Ok(Message::Pong(_))) => alive = true,
                Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
                Some(Ok(_)) => {} // binario o ping (el pong lo contesta la librería)
            },
            Some(out) = rx.recv() => {
                if socket.send(out).await.is_err() {
                    break;
                }
            }
            _ = beat.tick() => {
                if !alive {
                    break;
                }
                alive = false;
                if socket.send(Message::Ping(Default::default())).await.is_err() {
                    break;
                }
            }
        }
    }

    let mut s = rooms.lock();
    s.leave(id);
    s.clients.remove(&id);
}

impl State {
    fn send(&self, id: u64, data: &Utf8Bytes) {
        if let Some(c) = self.clients.get(&id) {
            let _ = c.tx.send(Message::Text(data.clone()));
        }
    }

    fn send_msg(&self, id: u64, m: &Value) {
        self.send(id, &Utf8Bytes::from(m.to_string()));
    }

    fn broadcast(&self, code: &str, m: &Value, except: Option<u64>) {
        let Some(room) = self.rooms.get(code) else { return };
        let data = Utf8Bytes::from(m.to_string());
        for &id in &room.members {
            if Some(id) != except {
                self.send(id, &data);
            }
        }
    }

    fn error(&self, id: u64, code: &str, msg: String) {
        self.send_msg(id, &json!({ "t": "error", "code": code, "msg": msg }));
    }

    fn info(&self, id: u64) -> Value {
        match self.clients.get(&id) {
            Some(c) => json!({ "id": id, "name": c.name, "aircraft": c.aircraft, "passenger": c.passenger, "slot": c.slot }),
            None => Value::Null,
        }
    }

    fn new_code(&self) -> String {
        loop {
            let code: String = (0..CODE_LENGTH)
                .map(|_| CODE_ALPHABET[fastrand::usize(..CODE_ALPHABET.len())] as char)
                .collect();
            if !self.rooms.contains_key(&code) {
                return code;
            }
        }
    }

    fn enter(&mut self, id: u64, code: &str) {
        let Some(room) = self.rooms.get(code) else { return };
        let used: Vec<u32> = room.members.iter().filter_map(|m| self.clients.get(m)).map(|c| c.slot).collect();
        let mut slot = 0;
        while used.contains(&slot) {
            slot += 1;
        }
        if let Some(c) = self.clients.get_mut(&id) {
            c.slot = slot;
            c.room = Some(code.to_string());
        }
        let room = self.rooms.get_mut(code).expect("sala");
        room.members.push(id);

        let room = &self.rooms[code];
        let peers: Vec<Value> = room.members.iter().filter(|&&p| p != id).map(|&p| self.info(p)).collect();
        let age = if room.cond.is_some() { room.cond_at.elapsed().as_millis() as u64 } else { 0 };
        let welcome = json!({
            "t": "welcome",
            "code": code,
            "id": id,
            "hostId": room.host_id,
            "slot": slot,
            "peers": peers,
            "c": room.cond.clone().unwrap_or(Value::Null),
            "age": age,
        });
        self.send_msg(id, &welcome);
        self.broadcast(code, &json!({ "t": "join", "peer": self.info(id) }), Some(id));
    }

    fn leave(&mut self, id: u64) {
        let Some(code) = self.clients.get_mut(&id).and_then(|c| c.room.take()) else { return };
        let Some(room) = self.rooms.get_mut(&code) else { return };
        room.members.retain(|&m| m != id);
        if room.members.is_empty() {
            self.rooms.remove(&code);
            log(&format!("sala {code} cerrada"));
            return;
        }
        let host_left = room.host_id == id;
        if host_left {
            // el anfitrión pasa al que lleva más tiempo dentro
            room.host_id = room.members[0];
        }
        let new_host = room.host_id;
        self.broadcast(&code, &json!({ "t": "leave", "id": id }), None);
        if host_left {
            self.broadcast(&code, &json!({ "t": "host", "id": new_host }), None);
        }
    }

    fn profile(&mut self, id: u64, m: &Map<String, Value>) {
        if let Some(c) = self.clients.get_mut(&id) {
            c.name = clean_name(m.get("name"));
            let aircraft = clean_text(m.get("aircraft"), 32);
            c.aircraft = if aircraft.is_empty() { "generic".into() } else { aircraft };
            c.passenger = truthy(m.get("passenger"));
        }
    }

    fn handle(&mut self, id: u64, text: &str) {
        let Ok(Value::Object(mut m)) = serde_json::from_str::<Value>(text) else { return };
        let Some(t) = m.get("t").and_then(Value::as_str).map(str::to_owned) else { return };
        let room = self.clients.get(&id).and_then(|c| c.room.clone());

        match t.as_str() {
            // estado de vuelo: se reenvía tal cual con el id del emisor
            "s" => {
                let Some(code) = room else { return };
                m.insert("id".into(), id.into());
                self.broadcast(&code, &Value::Object(m), Some(id));
            }
            "create" => {
                self.leave(id);
                if self.rooms.len() >= MAX_ROOMS {
                    self.error(id, "full", "El servidor está lleno, inténtalo más tarde".into());
                    return;
                }
                self.profile(id, &m);
                let code = self.new_code();
                self.rooms.insert(
                    code.clone(),
                    Room { members: Vec::new(), host_id: id, cond: None, cond_at: Instant::now() },
                );
                log(&format!("sala {code} creada por {}", self.clients[&id].name));
                self.enter(id, &code);
            }
            "join" => {
                let code = normalize_code(&js_string(m.get("code")));
                if !is_valid_code(&code) {
                    self.error(id, "badcode", format!("El código tiene {CODE_LENGTH} letras o números"));
                    return;
                }
                let Some(r) = self.rooms.get(&code) else {
                    self.error(id, "noroom", format!("No hay ninguna sala {code}"));
                    return;
                };
                if room.as_deref() == Some(code.as_str()) {
                    return;
                }
                if r.members.len() >= MAX_PLAYERS {
                    self.error(id, "full", format!("La sala {code} está llena ({MAX_PLAYERS} pilotos)"));
                    return;
                }
                self.leave(id);
                self.profile(id, &m);
                log(&format!("{} entra en {code}", self.clients[&id].name));
                self.enter(id, &code);
            }
            "leave" => self.leave(id),
            "profile" => {
                self.profile(id, &m);
                if let Some(code) = room {
                    let c = &self.clients[&id];
                    let msg = json!({ "t": "profile", "id": id, "name": c.name, "aircraft": c.aircraft, "passenger": c.passenger });
                    self.broadcast(&code, &msg, Some(id));
                }
            }
            "cond" => {
                let Some(code) = room else { return };
                if self.rooms.get(&code).map(|r| r.host_id) != Some(id) {
                    return;
                }
                let Some(Value::Object(c)) = m.get("c") else { return };
                let Some(cond) = sanitize_conditions(c) else { return };
                if let Some(r) = self.rooms.get_mut(&code) {
                    r.cond = Some(cond.clone());
                    r.cond_at = Instant::now();
                }
                self.broadcast(&code, &json!({ "t": "cond", "c": cond }), Some(id));
            }
            "chat" => {
                let text = clean_text(m.get("text"), CHAT_MAX);
                let Some(code) = room else { return };
                if text.is_empty() {
                    return;
                }
                self.broadcast(&code, &json!({ "t": "chat", "id": id, "text": text }), None);
            }
            "ev" => {
                let Some(code) = room else { return };
                if m.get("k").and_then(Value::as_str) != Some("crash") {
                    return;
                }
                let msg = json!({ "t": "ev", "id": id, "k": "crash", "text": clean_text(m.get("text"), 120) });
                self.broadcast(&code, &msg, Some(id));
            }
            _ => {}
        }
    }
}

fn log(msg: &str) {
    use std::io::Write;
    let _ = writeln!(std::io::stderr(), "[salas] {msg}");
}

// ---------------------------------------------------------------------------
// Limpieza de lo que mandan los clientes (igual que protocol.ts / rooms.ts)
// ---------------------------------------------------------------------------

/// `String(v ?? '')` de JavaScript.
fn js_string(v: Option<&Value>) -> String {
    match v {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(s)) => s.clone(),
        Some(Value::Bool(b)) => b.to_string(),
        Some(Value::Number(n)) => match n.as_f64() {
            Some(f) if f.fract() == 0.0 && f.abs() < 1e21 => format!("{}", f as i128),
            _ => n.to_string(),
        },
        Some(Value::Array(a)) => a.iter().map(|x| js_string(Some(x))).collect::<Vec<_>>().join(","),
        Some(Value::Object(_)) => "[object Object]".into(),
    }
}

/// `Boolean(v)` de JavaScript.
fn truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

/// Espacios que quita `String.prototype.trim`.
fn is_js_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{0B}' | '\u{0C}' | '\r' | ' ' | '\u{A0}' | '\u{1680}' | '\u{2000}'..='\u{200A}'
            | '\u{2028}' | '\u{2029}' | '\u{202F}' | '\u{205F}' | '\u{3000}' | '\u{FEFF}'
    )
}

/// `s.slice(0, max)` contando unidades UTF-16, como JavaScript (sin partir un par sustituto).
fn slice_utf16(s: &str, max: usize) -> String {
    let mut n = 0;
    let mut out = String::new();
    for ch in s.chars() {
        n += ch.len_utf16();
        if n > max {
            break;
        }
        out.push(ch);
    }
    out
}

fn is_control(c: char) -> bool {
    c <= '\u{1F}' || c == '\u{7F}'
}

fn clean_name(raw: Option<&Value>) -> String {
    let s: String = js_string(raw).chars().filter(|&c| !is_control(c) && c != '<' && c != '>').collect();
    let s = slice_utf16(s.trim_matches(is_js_space), NAME_MAX);
    if s.is_empty() { "Piloto".into() } else { s }
}

fn clean_text(raw: Option<&Value>, max: usize) -> String {
    let s: String = js_string(raw).chars().map(|c| if is_control(c) { ' ' } else { c }).collect();
    slice_utf16(s.trim_matches(is_js_space), max)
}

/// Mayúsculas, sin espacios ni guiones.
fn normalize_code(raw: &str) -> String {
    raw.to_uppercase()
        .chars()
        .filter(|c| c.is_ascii_uppercase() || c.is_ascii_digit())
        .take(CODE_LENGTH)
        .collect()
}

fn is_valid_code(code: &str) -> bool {
    code.len() == CODE_LENGTH && code.bytes().all(|b| CODE_ALPHABET.contains(&b))
}

/// `Number(v)` de JavaScript (lo justo para lo que mandan los clientes).
fn js_number(v: Option<&Value>) -> f64 {
    match v {
        None => f64::NAN,
        Some(Value::Null) => 0.0,
        Some(Value::Bool(b)) => f64::from(u8::from(*b)),
        Some(Value::Number(n)) => n.as_f64().unwrap_or(f64::NAN),
        Some(Value::Object(_)) => f64::NAN,
        Some(other) => {
            let s = js_string(Some(other));
            let s = s.trim_matches(is_js_space);
            if s.is_empty() {
                0.0
            } else if s.chars().any(|c| c.is_ascii_alphabetic() && c != 'e' && c != 'E') {
                f64::NAN // "inf", "nan", hexadecimales…: nada que un cliente mande
            } else {
                s.parse().unwrap_or(f64::NAN)
            }
        }
    }
}

fn num(v: Option<&Value>, min: f64, max: f64, def: f64) -> f64 {
    let n = js_number(v);
    if n.is_finite() { n.clamp(min, max) } else { def }
}

/// Número JSON como lo escribiría `JSON.stringify` (enteros sin «.0»).
fn json_num(f: f64) -> Value {
    if f.fract() == 0.0 && f.abs() < 9.007_199_254_740_992e15 {
        Value::from(f as i64)
    } else {
        Value::from(f)
    }
}

fn now_ms() -> f64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as f64).unwrap_or(0.0)
}

fn sanitize_conditions(c: &Map<String, Value>) -> Option<Value> {
    let location_id = clean_text(c.get("locationId"), 32);
    if location_id.is_empty() {
        return None;
    }
    let clouds = clean_text(c.get("clouds"), 16);
    Some(json!({
        "locationId": location_id,
        "customLat": json_num(num(c.get("customLat"), -90.0, 90.0, 40.0)),
        "customLon": json_num(num(c.get("customLon"), -180.0, 180.0, -4.0)),
        "customHeading": json_num(num(c.get("customHeading"), 0.0, 360.0, 0.0)),
        "customName": clean_text(c.get("customName"), 64),
        "hour": json_num(num(c.get("hour"), 0.0, 24.0, 12.0)),
        "dayOfYear": json_num(num(c.get("dayOfYear"), 1.0, 366.0, 140.0)),
        "windFrom": json_num(num(c.get("windFrom"), 0.0, 360.0, 0.0)),
        "windSpeed": json_num(num(c.get("windSpeed"), 0.0, 60.0, 0.0)),
        "turbulence": json_num(num(c.get("turbulence"), 0.0, 1.0, 0.0)),
        "clouds": if clouds.is_empty() { "clear".to_string() } else { clouds },
        "simTime": json_num(num(c.get("simTime"), 0.0, 4e12, now_ms())),
        "collisions": c.get("collisions") != Some(&Value::Bool(false)),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn limpieza_como_en_js() {
        assert_eq!(clean_name(Some(&json!("<b>Bea</b>"))), "bBea/b");
        assert_eq!(clean_name(Some(&json!("   "))), "Piloto");
        assert_eq!(clean_name(None), "Piloto");
        assert_eq!(clean_text(Some(&json!(" a\nb ")), 200), "a b");
        assert_eq!(clean_text(Some(&json!(12)), 200), "12");
        assert_eq!(normalize_code("k7-qx"), "K7QX");
        assert!(is_valid_code("K7QX"));
        assert!(!is_valid_code("K7Q0"));
        assert_eq!(num(Some(&json!("12")), 0.0, 24.0, 5.0), 12.0);
        assert_eq!(num(Some(&json!(99)), 0.0, 24.0, 5.0), 24.0);
        assert_eq!(num(None, 0.0, 24.0, 5.0), 5.0);
        assert_eq!(num(Some(&Value::Null), 1.0, 366.0, 140.0), 1.0);
        assert_eq!(json_num(1.7e12).to_string(), "1700000000000");
        assert!(truthy(Some(&json!("x"))) && !truthy(Some(&json!(0))));
        assert_eq!(slice_utf16("😀😀", 3), "😀");
    }
}

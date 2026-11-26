//! Servidor de salas del multijugador para la app de escritorio.
//!
//! Es una traducción a Rust de `server/rooms.ts` (mismo protocolo: `src/net/protocol.ts`),
//! para que la app no tenga que llevar Node dentro. Si cambias el protocolo o las reglas de
//! las salas en un lado, cámbialo también en el otro. Para probar este servidor con la misma
//! batería que el de Node: arranca la app y lanza
//!     MP_URL=ws://127.0.0.1:47800/mp npm run mp-test
//!
//! No simula nada: cada cliente es dueño de su autogiro y el servidor solo reparte los
//! mensajes dentro de la sala (estado, chat, condiciones del anfitrión y la voz de la radio,
//! en mensajes binarios: ver `src/net/protocol.ts`).

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use axum::body::Bytes;
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

// Radio de voz (igual que en protocol.ts): bits del campo `radio`, primer byte de los mensajes
// binarios, tamaño del cuerpo y límite de ritmo por cliente (paquetes y bytes por segundo).
const RADIO_ON: u8 = 1;
const BIN_VOICE: u8 = 1;
const VOICE_MIN: usize = 4;
const VOICE_MAX: usize = 1024;
const VOICE_RATE: f64 = 30.0;
const VOICE_BURST: f64 = 60.0;
const VOICE_BYTES: f64 = 12000.0;
const VOICE_BYTES_BURST: f64 = 24000.0;

struct Client {
    tx: UnboundedSender<Message>,
    name: String,
    aircraft: String,
    passenger: bool,
    /// con flotadores (otro modelo 3D del mismo aparato)
    floats: bool,
    /// radio de voz: bits RADIO_ON / RADIO_OPUS del perfil
    radio: u8,
    slot: u32,
    room: Option<String>,
}

/// Cubos de fichas de la voz de un cliente: paquetes y bytes.
struct VoiceBucket {
    tokens: f64,
    bytes: f64,
    last: Instant,
}

impl VoiceBucket {
    fn new() -> Self {
        VoiceBucket { tokens: VOICE_BURST, bytes: VOICE_BYTES_BURST, last: Instant::now() }
    }

    /// ¿Cabe un paquete de `len` bytes? (y lo descuenta)
    fn take(&mut self, len: usize) -> bool {
        let now = Instant::now();
        let dt = now.duration_since(self.last).as_secs_f64();
        self.last = now;
        self.tokens = (self.tokens + dt * VOICE_RATE).min(VOICE_BURST);
        self.bytes = (self.bytes + dt * VOICE_BYTES).min(VOICE_BYTES_BURST);
        if self.tokens < 1.0 || self.bytes < len as f64 {
            return false;
        }
        self.tokens -= 1.0;
        self.bytes -= len as f64;
        true
    }
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
            Client { tx, name: "Piloto".into(), aircraft: "generic".into(), passenger: false, floats: false, radio: 0, slot: 0, room: None },
        );
        id
    };

    let mut alive = true;
    // límite de ritmo: cubo de fichas (y otros para la voz)
    let mut tokens = BURST;
    let mut last_refill = Instant::now();
    let mut voice = VoiceBucket::new();
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
                // voz de la radio: el cubo se gasta solo con paquetes que se reenviarían
                Some(Ok(Message::Binary(data))) => {
                    let s = rooms.lock();
                    if s.voice_ok(id, &data) && voice.take(data.len()) {
                        s.voice(id, &data);
                    }
                }
                Some(Ok(Message::Pong(_))) => alive = true,
                Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
                Some(Ok(_)) => {} // ping (el pong lo contesta la librería)
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
            Some(c) => json!({ "id": id, "name": c.name, "aircraft": c.aircraft, "passenger": c.passenger, "floats": c.floats, "radio": c.radio, "slot": c.slot }),
            None => Value::Null,
        }
    }

    /// ¿Se reenviaría este mensaje binario? Voz de alguien con la radio encendida, dentro de una
    /// sala y de tamaño válido (el cuerpo no se mira).
    fn voice_ok(&self, id: u64, data: &[u8]) -> bool {
        let Some(c) = self.clients.get(&id) else { return false };
        c.room.is_some()
            && c.radio & RADIO_ON != 0
            && data.len() >= 1 + VOICE_MIN
            && data.len() <= 1 + VOICE_MAX
            && data[0] == BIN_VOICE
    }

    /// Voz: a los demás de la sala con la radio encendida, con el id del emisor delante.
    fn voice(&self, id: u64, data: &[u8]) {
        let Some(code) = self.clients.get(&id).and_then(|c| c.room.as_deref()) else { return };
        let Some(room) = self.rooms.get(code) else { return };
        let mut out = Vec::with_capacity(data.len() + 4);
        out.push(BIN_VOICE);
        out.extend_from_slice(&(id as u32).to_be_bytes());
        out.extend_from_slice(&data[1..]);
        let out = Bytes::from(out);
        for &m in &room.members {
            if m == id {
                continue;
            }
            if let Some(c) = self.clients.get(&m) {
                if c.radio & RADIO_ON != 0 {
                    let _ = c.tx.send(Message::Binary(out.clone()));
                }
            }
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
            c.floats = truthy(m.get("floats"));
            c.radio = radio_flags(m.get("radio"));
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
                    let msg = json!({ "t": "profile", "id": id, "name": c.name, "aircraft": c.aircraft, "passenger": c.passenger, "floats": c.floats, "radio": c.radio });
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

/// Campo `radio` del perfil (`radioFlags` de protocol.ts): un entero 0…3; lo demás, 0.
fn radio_flags(v: Option<&Value>) -> u8 {
    match v.and_then(Value::as_f64) {
        Some(f) if f.fract() == 0.0 && (0.0..=3.0).contains(&f) => f as u8,
        _ => 0,
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
        // viento del terreno y térmicas (anfitriones anteriores no lo mandan: viento uniforme); igual en server/rooms.ts
        "terrainWind": c.get("terrainWind") == Some(&Value::Bool(true)),
        "clouds": if clouds.is_empty() { "clear".to_string() } else { clouds },
        // aire del día (anfitriones anteriores no lo mandan: atmósfera estándar); igual en server/rooms.ts
        "isa": c.get("isa") != Some(&Value::Bool(false)),
        "oatC": json_num(num(c.get("oatC"), -60.0, 60.0, 15.0)),
        "qnh": json_num(num(c.get("qnh"), 850.0, 1100.0, 1013.25)),
        "dewPointC": json_num(num(c.get("dewPointC"), -80.0, 40.0, 5.0)),
        "visibility": json_num(num(c.get("visibility"), 0.0, 100000.0, 30000.0)),
        "precip": json_num(num(c.get("precip"), 0.0, 500.0, 0.0)),
        "weatherCode": json_num(num(c.get("weatherCode"), -1.0, 99.0, -1.0)),
        "windGustKt": json_num(num(c.get("windGustKt"), 0.0, 150.0, 0.0)),
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

    /// Cliente de prueba sin red: su id y lo que le llega.
    fn bot(s: &mut State) -> (u64, tokio::sync::mpsc::UnboundedReceiver<Message>) {
        let (tx, rx) = unbounded_channel();
        s.next_id += 1;
        let id = s.next_id;
        s.clients.insert(
            id,
            Client { tx, name: "Piloto".into(), aircraft: "generic".into(), passenger: false, floats: false, radio: 0, slot: 0, room: None },
        );
        (id, rx)
    }

    fn binaries(rx: &mut tokio::sync::mpsc::UnboundedReceiver<Message>) -> Vec<Bytes> {
        let mut out = Vec::new();
        while let Ok(m) = rx.try_recv() {
            if let Message::Binary(b) = m {
                out.push(b);
            }
        }
        out
    }

    #[test]
    fn radio_como_en_js() {
        assert_eq!(radio_flags(Some(&json!(3))), 3);
        assert_eq!(radio_flags(Some(&json!(1.0))), 1);
        assert_eq!(radio_flags(Some(&json!(7))), 0);
        assert_eq!(radio_flags(Some(&json!(-1))), 0);
        assert_eq!(radio_flags(Some(&json!(1.5))), 0);
        assert_eq!(radio_flags(Some(&json!("1"))), 0);
        assert_eq!(radio_flags(Some(&json!(true))), 0);
        assert_eq!(radio_flags(None), 0);
    }

    #[test]
    fn voz_solo_a_la_sala_con_radio() {
        let mut s = State::default();
        let (a, mut ra) = bot(&mut s);
        s.handle(a, r#"{"t":"create","name":"Ana","radio":3}"#);
        let code = s.clients[&a].room.clone().expect("sala");
        let (b, mut rb) = bot(&mut s);
        s.handle(b, &format!(r#"{{"t":"join","code":"{code}","name":"Bea","radio":1}}"#));
        let (c, mut rc) = bot(&mut s);
        s.handle(c, &format!(r#"{{"t":"join","code":"{code}","name":"Cris"}}"#));
        let (d, mut rd) = bot(&mut s);
        s.handle(d, r#"{"t":"create","name":"Dani","radio":1}"#);
        assert_eq!(s.info(a)["radio"], json!(3));
        assert_eq!(s.info(c)["radio"], json!(0));
        for rx in [&mut ra, &mut rb, &mut rc, &mut rd] {
            while rx.try_recv().is_ok() {}
        }

        let pkt = [BIN_VOICE, 0, 1, 0, 7, 0xAA, 0xBB];
        assert!(s.voice_ok(a, &pkt));
        s.voice(a, &pkt);
        let got = binaries(&mut rb);
        assert_eq!(got.len(), 1);
        let id = (a as u32).to_be_bytes();
        assert_eq!(&got[0][..], &[BIN_VOICE, id[0], id[1], id[2], id[3], 0, 1, 0, 7, 0xAA, 0xBB]);
        // ni al emisor, ni a quien no tiene la radio, ni a otra sala
        assert!(binaries(&mut ra).is_empty());
        assert!(binaries(&mut rc).is_empty());
        assert!(binaries(&mut rd).is_empty());
        // sin radio no se emite; tamaños y tipo fuera de lo válido
        assert!(!s.voice_ok(c, &pkt));
        assert!(!s.voice_ok(a, &[BIN_VOICE, 0, 1, 0]));
        assert!(s.voice_ok(a, &vec![BIN_VOICE; 1 + VOICE_MAX]));
        assert!(!s.voice_ok(a, &vec![BIN_VOICE; 2 + VOICE_MAX]));
        assert!(!s.voice_ok(a, &[2, 0, 1, 0, 7]));
        // fuera de sala tampoco
        s.handle(a, r#"{"t":"leave"}"#);
        assert!(!s.voice_ok(a, &pkt));
    }

    #[test]
    fn cubo_de_la_voz() {
        let mut v = VoiceBucket::new();
        let n = (0..150).filter(|_| v.take(325)).count();
        assert_eq!(n, VOICE_BURST as usize);
        // por bytes: 24 000 de ráfaga dan para 23 paquetes de 1 025
        let mut v = VoiceBucket::new();
        let n = (0..150).filter(|_| v.take(1025)).count();
        assert_eq!(n, (VOICE_BYTES_BURST / 1025.0) as usize);
    }

    #[test]
    fn aire_del_dia_como_en_js() {
        // sin aire del día (anfitriones anteriores): atmósfera estándar
        let old = sanitize_conditions(json!({ "locationId": "lemt26" }).as_object().unwrap()).unwrap();
        assert_eq!(old["isa"], json!(true));
        assert_eq!(old["oatC"], json!(15));
        assert_eq!(old["qnh"], json!(1013.25));
        // ni viento del terreno: viento uniforme
        assert_eq!(old["terrainWind"], json!(false));
        let tw = sanitize_conditions(json!({ "locationId": "lemt26", "terrainWind": true }).as_object().unwrap()).unwrap();
        assert_eq!(tw["terrainWind"], json!(true));
        let c = sanitize_conditions(
            json!({ "locationId": "lemt26", "isa": false, "oatC": 38, "qnh": 1009.4, "dewPointC": 9, "visibility": 999999, "precip": 1.5, "weatherCode": 61, "windGustKt": 18 })
                .as_object()
                .unwrap(),
        )
        .unwrap();
        assert_eq!(c["isa"], json!(false));
        assert_eq!(c["oatC"], json!(38));
        assert_eq!(c["qnh"], json!(1009.4));
        assert_eq!(c["dewPointC"], json!(9));
        assert_eq!(c["visibility"], json!(100000));
        assert_eq!(c["precip"], json!(1.5));
        assert_eq!(c["weatherCode"], json!(61));
        assert_eq!(c["windGustKt"], json!(18));
    }
}

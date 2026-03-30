#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

use rusqlite::Connection;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tauri::{command, State, Window};
use tauri::api::process::{Command, CommandEvent, CommandChild};
use chrono::Utc;

struct DbState {
    db: Arc<Mutex<Connection>>,
    server_child: Arc<Mutex<Option<CommandChild>>>,
    client_child: Arc<Mutex<Option<CommandChild>>>,
}

#[derive(serde::Deserialize)]
pub struct ClientOptions {
    ip: String,
    port: u16,
    protocol: String,
    duration: Option<u32>,
    size: Option<String>,
    infinite: bool,
    parallel: u32,
    interval: Option<u32>,
}

#[command]
async fn stop_test(state: State<'_, DbState>, mode: String) -> Result<(), String> {
    if mode == "server" {
        let mut child_opt = state.server_child.lock().unwrap();
        if let Some(child) = child_opt.take() {
            let _ = child.kill();
        }
    } else if mode == "client" {
        let mut child_opt = state.client_child.lock().unwrap();
        if let Some(child) = child_opt.take() {
            let _ = child.kill();
        }
    }
    Ok(())
}

#[command]
async fn start_server(window: Window, state: State<'_, DbState>, port: u16) -> Result<(), String> {
    let (mut rx, mut child) = Command::new_sidecar("iperf3")
        .expect("failed to create `iperf3` binary command")
        .args(["-s", "-p", &port.to_string(), "-1", "--forceflush"])
        .spawn()
        .map_err(|e| format!("Failed to spawn iperf3 sidecar: {}", e))?;

    {
        let mut sc = state.server_child.lock().unwrap();
        if let Some(old) = sc.take() {
            let _ = old.kill();
        }
        *sc = Some(child);
    }

    let mut full_output = String::new();
    let db_arc = state.db.clone();

    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            if let CommandEvent::Stdout(line) = event {
                window.emit("iperf-log", Some(line.clone())).unwrap_or(());
                full_output.push_str(&line);
                full_output.push('\n');
            } else if let CommandEvent::Stderr(line) = event {
                window.emit("iperf-error", Some(line.clone())).unwrap_or(());
                full_output.push_str(&line);
                full_output.push('\n');
            }
        }

        // Store in DB when done
        let conn = db_arc.lock().unwrap();
        let timestamp = Utc::now().to_rfc3339();
        let _ = conn.execute(
            "INSERT INTO tests (timestamp, mode, ip, results) VALUES (?1, ?2, ?3, ?4)",
            (&timestamp, "Server", "N/A", &full_output),
        );
        window.emit("iperf-done", Some("Server test completed.")).unwrap_or(());
    });

    Ok(())
}

#[command]
async fn start_client(window: Window, state: State<'_, DbState>, options: ClientOptions) -> Result<(), String> {
    let mut args = vec![
        "-c".to_string(), options.ip.clone(), 
        "-p".to_string(), options.port.to_string(), 
        "--forceflush".to_string()
    ];
    
    if options.protocol == "udp" {
        args.push("-u".to_string());
    }

    if options.infinite {
        args.push("-t".to_string());
        args.push("0".to_string());
    } else if let Some(size) = &options.size {
        if !size.trim().is_empty() {
            args.push("-n".to_string());
            args.push(size.clone());
        }
    } else if let Some(duration) = options.duration {
        args.push("-t".to_string());
        args.push(duration.to_string());
    }

    if options.parallel > 1 {
        args.push("-P".to_string());
        args.push(options.parallel.to_string());
    }

    if let Some(interval) = options.interval {
        args.push("-i".to_string());
        args.push(interval.to_string());
    }

    let (mut rx, mut child) = Command::new_sidecar("iperf3")
        .expect("failed to create `iperf3` binary command")
        .args(args)
        .spawn()
        .map_err(|e| format!("Failed to spawn iperf3 sidecar: {}", e))?;

    {
        let mut cc = state.client_child.lock().unwrap();
        if let Some(old) = cc.take() {
            let _ = old.kill();
        }
        *cc = Some(child);
    }

    let mut full_output = String::new();
    let db_arc = state.db.clone();
    let target_ip = options.ip;

    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            if let CommandEvent::Stdout(line) = event {
                window.emit("iperf-log", Some(line.clone())).unwrap_or(());
                full_output.push_str(&line);
                full_output.push('\n');
            } else if let CommandEvent::Stderr(line) = event {
                window.emit("iperf-error", Some(line.clone())).unwrap_or(());
                full_output.push_str(&line);
                full_output.push('\n');
            }
        }

        // Store in DB
        let conn = db_arc.lock().unwrap();
        let timestamp = Utc::now().to_rfc3339();
        let _ = conn.execute(
            "INSERT INTO tests (timestamp, mode, ip, results) VALUES (?1, ?2, ?3, ?4)",
            (&timestamp, "Client", &target_ip, &full_output),
        );
        window.emit("iperf-done", Some("Client test completed.")).unwrap_or(());
    });

    Ok(())
}

#[derive(serde::Serialize)]
struct Session {
    id: i64,
    timestamp: String,
    mode: String,
    ip: String,
    results: String,
}

#[command]
fn get_history(state: State<'_, DbState>) -> Result<Vec<Session>, String> {
    let conn = state.db.lock().unwrap();
    let mut stmt = conn.prepare("SELECT id, timestamp, mode, ip, results FROM tests ORDER BY id DESC")
        .map_err(|e| e.to_string())?;

    let history_iter = stmt.query_map([], |row| {
        Ok(Session {
            id: row.get(0)?,
            timestamp: row.get(1)?,
            mode: row.get(2)?,
            ip: row.get(3)?,
            results: row.get(4)?,
        })
    }).map_err(|e| e.to_string())?;

    let mut history = Vec::new();
    for entry in history_iter {
        history.push(entry.map_err(|e| e.to_string())?);
    }

    Ok(history)
}

#[command]
fn delete_session(state: State<'_, DbState>, id: i64) -> Result<(), String> {
    let conn = state.db.lock().unwrap();
    conn.execute("DELETE FROM tests WHERE id = ?1", [id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[command]
fn save_setting(state: State<'_, DbState>, key: String, value: String) -> Result<(), String> {
    let conn = state.db.lock().unwrap();
    let _ = conn.execute(
        "INSERT OR REPLACE INTO settings (key, value) VALUES (?1, ?2)",
        (&key, &value),
    ).map_err(|e| e.to_string())?;
    Ok(())
}

#[command]
fn get_all_settings(state: State<'_, DbState>) -> Result<HashMap<String, String>, String> {
    let conn = state.db.lock().unwrap();
    let mut stmt = conn.prepare("SELECT key, value FROM settings")
        .map_err(|e| e.to_string())?;
        
    let settings_iter = stmt.query_map([], |row| {
        let key: String = row.get(0)?;
        let value: String = row.get(1)?;
        Ok((key, value))
    }).map_err(|e| e.to_string())?;
    
    let mut settings = HashMap::new();
    for entry in settings_iter {
        let (k, v) = entry.map_err(|e| e.to_string())?;
        settings.insert(k, v);
    }
    
    Ok(settings)
}

fn main() {
    let db = Connection::open("../tests.db").expect("failed to open database");

    db.execute(
        "CREATE TABLE IF NOT EXISTS tests (
            id INTEGER PRIMARY KEY,
            timestamp TEXT NOT NULL,
            mode TEXT NOT NULL,
            ip TEXT,
            results TEXT NOT NULL
        )",
        [],
    )
    .expect("failed to create table");

    db.execute(
        "CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        )",
        [],
    ).expect("failed to create settings table");

    let db_state = DbState {
        db: Arc::new(Mutex::new(db)),
        server_child: Arc::new(Mutex::new(None)),
        client_child: Arc::new(Mutex::new(None)),
    };

    tauri::Builder::default()
        .manage(db_state)
        .invoke_handler(tauri::generate_handler![start_server, start_client, stop_test, get_history, delete_session, save_setting, get_all_settings])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

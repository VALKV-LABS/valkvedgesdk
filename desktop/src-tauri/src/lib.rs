//! ValkvEdgeKV Desktop: browse a database and its contents, and create and
//! delete databases.
//!
//! The window is the interface; everything that touches the network or the
//! API key happens here.

mod client;

use client::{ApiError, ApiResult, Client, Connection, Database, EntryPage, Replica};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{Manager, State};

/// The name the API key is kept under in the system's credential store.
const KEYRING_SERVICE: &str = "com.valkv.edgekv.desktop";

/// Where the service is. The API key is not here: it is in the credential store.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
struct Settings {
    api_url: String,
    control_url: String,
}

/// What the window is told about the connection. Never the key itself.
#[derive(Debug, Clone, Serialize)]
struct ConnectionInfo {
    api_url: String,
    control_url: String,
    connected: bool,
    /// The first characters of the key, to tell which one is in use.
    key_hint: Option<String>,
}

struct AppState {
    settings_path: PathBuf,
    /// Lets a second copy keep its own connection: `EDGEKV_DESKTOP_PROFILE`.
    profile: String,
    client: Mutex<Option<Client>>,
    settings: Mutex<Settings>,
    key_hint: Mutex<Option<String>>,
}

impl AppState {
    fn client(&self) -> ApiResult<Client> {
        self.client
            .lock()
            .expect("client lock")
            .clone()
            .ok_or_else(|| ApiError::local("NOT_CONNECTED", "connect to the service first"))
    }

    fn keyring(&self) -> ApiResult<keyring::Entry> {
        keyring::Entry::new(KEYRING_SERVICE, &self.profile).map_err(|e| {
            ApiError::local(
                "CREDENTIAL_STORE",
                format!("the system credential store is not available: {e}"),
            )
        })
    }

    fn info(&self) -> ConnectionInfo {
        let settings = self.settings.lock().expect("settings lock").clone();
        ConnectionInfo {
            api_url: settings.api_url,
            control_url: settings.control_url,
            connected: self.client.lock().expect("client lock").is_some(),
            key_hint: self.key_hint.lock().expect("hint lock").clone(),
        }
    }

    /// Makes `connection` the one in use.
    fn adopt(&self, connection: Connection) -> ApiResult<()> {
        let client = Client::new(connection.clone())?;
        *self.settings.lock().expect("settings lock") = Settings {
            api_url: connection.api_url,
            control_url: connection.control_url,
        };
        *self.key_hint.lock().expect("hint lock") = Some(key_hint(&connection.api_key));
        *self.client.lock().expect("client lock") = Some(client);
        Ok(())
    }
}

/// Enough of a key to recognise it, and no more.
fn key_hint(key: &str) -> String {
    let shown: String = key.chars().take(10).collect();
    format!("{shown}…")
}

fn read_settings(path: &PathBuf) -> Settings {
    std::fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

/// The connection as it was last saved. If a key is stored, the app is ready
/// to use without asking again.
#[tauri::command]
fn connection(state: State<'_, AppState>) -> ConnectionInfo {
    state.info()
}

/// Checks the connection works, then saves it: the addresses in the app's
/// settings file and the key in the system credential store.
#[tauri::command]
async fn connect(
    state: State<'_, AppState>,
    api_url: String,
    control_url: String,
    api_key: Option<String>,
) -> ApiResult<ConnectionInfo> {
    let api_key = match api_key
        .map(|key| key.trim().to_string())
        .filter(|key| !key.is_empty())
    {
        Some(key) => key,
        // Changing an address only: keep the key already stored.
        None => state
            .keyring()?
            .get_password()
            .map_err(|_| ApiError::local("BAD_REQUEST", "enter an API key"))?,
    };
    let connection = Connection {
        api_url: api_url.trim().trim_end_matches('/').to_string(),
        control_url: control_url.trim().trim_end_matches('/').to_string(),
        api_key,
    };
    // A key that cannot manage databases is still a working key: the app can
    // browse a database by name. Anything else wrong is reported.
    match Client::new(connection.clone())?.regions().await {
        Ok(_) => {}
        Err(error) if error.code == "FORBIDDEN" => {}
        Err(error) => return Err(error),
    }
    state
        .keyring()?
        .set_password(&connection.api_key)
        .map_err(|e| {
            ApiError::local(
                "CREDENTIAL_STORE",
                format!("the key could not be saved: {e}"),
            )
        })?;
    let settings = Settings {
        api_url: connection.api_url.clone(),
        control_url: connection.control_url.clone(),
    };
    if let Some(dir) = state.settings_path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    std::fs::write(
        &state.settings_path,
        serde_json::to_vec_pretty(&settings).expect("settings serialize"),
    )
    .map_err(|e| ApiError::local("SETTINGS", format!("the settings could not be saved: {e}")))?;
    state.adopt(connection)?;
    Ok(state.info())
}

/// Forgets the key. The addresses are kept, to make connecting again quicker.
#[tauri::command]
fn disconnect(state: State<'_, AppState>) -> ApiResult<ConnectionInfo> {
    if let Ok(entry) = state.keyring() {
        let _ = entry.delete_credential();
    }
    *state.client.lock().expect("client lock") = None;
    *state.key_hint.lock().expect("hint lock") = None;
    Ok(state.info())
}

#[tauri::command]
async fn list_regions(state: State<'_, AppState>) -> ApiResult<Vec<String>> {
    state.client()?.regions().await
}

#[tauri::command]
async fn list_databases(state: State<'_, AppState>) -> ApiResult<Vec<Database>> {
    state.client()?.databases().await
}

#[derive(Serialize)]
struct DatabaseDetails {
    database: Database,
    replicas: Vec<Replica>,
    /// Where the database's history ends, or `None` if the data API would not
    /// say (a database created seconds ago, for instance).
    lsn: Option<u64>,
}

#[tauri::command]
async fn database_details(state: State<'_, AppState>, id: String) -> ApiResult<DatabaseDetails> {
    let client = state.client()?;
    let database = client.database(&id).await?;
    let replicas = client.replicas(&id).await?;
    let lsn = client.head(&database.name).await.ok();
    Ok(DatabaseDetails {
        database,
        replicas,
        lsn,
    })
}

#[tauri::command]
async fn create_database(
    state: State<'_, AppState>,
    name: String,
    region: String,
) -> ApiResult<Database> {
    state.client()?.create_database(name.trim(), &region).await
}

#[tauri::command]
async fn delete_database(state: State<'_, AppState>, id: String) -> ApiResult<()> {
    state.client()?.delete_database(&id).await
}

/// Whether a database can be reached by name with this key. For keys that
/// cannot list databases.
#[tauri::command]
async fn probe_database(state: State<'_, AppState>, name: String) -> ApiResult<u64> {
    state.client()?.head(name.trim()).await
}

#[tauri::command]
async fn scan(
    state: State<'_, AppState>,
    database: String,
    prefix: String,
    page_token: Option<String>,
    page_size: Option<u32>,
) -> ApiResult<EntryPage> {
    state
        .client()?
        .scan(
            &database,
            &prefix,
            page_token.as_deref(),
            page_size.unwrap_or(100),
        )
        .await
}

#[tauri::command]
async fn put_entry(
    state: State<'_, AppState>,
    database: String,
    key: String,
    value: String,
) -> ApiResult<u64> {
    state.client()?.put(&database, &key, &value).await
}

#[tauri::command]
async fn delete_entry(state: State<'_, AppState>, database: String, key: String) -> ApiResult<u64> {
    state.client()?.delete(&database, &key).await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let profile = std::env::var("EDGEKV_DESKTOP_PROFILE")
                .ok()
                .filter(|name| {
                    !name.is_empty() && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
                })
                .unwrap_or_else(|| "default".to_string());
            let dir = app.path().app_config_dir()?;
            let state = AppState {
                settings_path: dir.join(format!("connection-{profile}.json")),
                profile,
                client: Mutex::new(None),
                settings: Mutex::new(Settings::default()),
                key_hint: Mutex::new(None),
            };
            // Pick up where the last run left off, if it left a key.
            let saved = read_settings(&state.settings_path);
            *state.settings.lock().expect("settings lock") = saved.clone();
            if let Ok(key) = state.keyring().and_then(|entry| {
                entry
                    .get_password()
                    .map_err(|e| ApiError::local("CREDENTIAL_STORE", e.to_string()))
            }) {
                let _ = state.adopt(Connection {
                    api_url: saved.api_url,
                    control_url: saved.control_url,
                    api_key: key,
                });
            }
            app.manage(state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            connection,
            connect,
            disconnect,
            list_regions,
            list_databases,
            database_details,
            create_database,
            delete_database,
            probe_database,
            scan,
            put_entry,
            delete_entry,
        ])
        .run(tauri::generate_context!())
        .expect("error while running the application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_key_hint_shows_the_start_of_the_key_and_never_all_of_it() {
        let hint = key_hint("ekv_abcdefghijklmnopqrstuvwxyz");
        assert_eq!(hint, "ekv_abcdef…");
        assert!(!hint.contains("ghij"));
        assert_eq!(key_hint("ekv_x"), "ekv_x…");
    }

    #[test]
    fn missing_or_damaged_settings_start_empty() {
        let dir = std::env::temp_dir().join(format!("edgekv-desktop-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("connection.json");
        assert_eq!(read_settings(&path), Settings::default());
        std::fs::write(&path, b"not json").unwrap();
        assert_eq!(read_settings(&path), Settings::default());
        std::fs::write(
            &path,
            br#"{"api_url":"https://a","control_url":"https://c"}"#,
        )
        .unwrap();
        assert_eq!(
            read_settings(&path),
            Settings {
                api_url: "https://a".into(),
                control_url: "https://c".into()
            }
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }
}

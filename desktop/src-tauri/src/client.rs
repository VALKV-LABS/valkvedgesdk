//! The HTTP side of the app: the data API and the management API.
//!
//! Requests are made here, in the native half, rather than from the window:
//! the API key never enters the web view, and there is no cross-origin
//! question to answer.

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::time::Duration;

/// A failure, in the shape the window shows it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ApiError {
    /// A stable code from the service, or `NETWORK`, `TIMEOUT`, `NOT_CONNECTED`
    /// or `BAD_REQUEST` from the app itself.
    pub code: String,
    pub message: String,
    /// The HTTP status, or 0 when no answer arrived.
    pub status: u16,
}

impl ApiError {
    pub fn local(code: &str, message: impl Into<String>) -> Self {
        ApiError {
            code: code.to_string(),
            message: message.into(),
            status: 0,
        }
    }
}

pub type ApiResult<T> = Result<T, ApiError>;

/// Where the service is and how to sign requests.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Connection {
    pub api_url: String,
    pub control_url: String,
    pub api_key: String,
}

/// A database, as the window lists it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Database {
    pub id: String,
    pub name: String,
    pub region: String,
    pub status: String,
    pub status_reason: Option<String>,
    pub created_at: String,
    /// Present when one database is read.
    pub stored_bytes: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Replica {
    pub id: String,
    pub last_seen_at: String,
    pub lsn: Option<u64>,
    pub pushed_seq: Option<u64>,
    pub lag: Option<u64>,
    pub connected: bool,
}

/// One key and its value. Both travel base64-encoded so that bytes that are
/// not text reach the window intact.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Entry {
    pub key: String,
    pub value: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct EntryPage {
    pub items: Vec<Entry>,
    pub next_page_token: Option<String>,
}

/// What a failed response means. `body` is what the service sent.
pub fn error_from_response(status: u16, header_code: Option<&str>, body: &[u8]) -> ApiError {
    let parsed: Option<Value> = serde_json::from_slice(body).ok();
    let field = |name: &str| {
        parsed
            .as_ref()
            .and_then(|value| value["error"][name].as_str())
            .map(str::to_string)
    };
    let code = field("code")
        .or_else(|| header_code.map(str::to_string))
        .filter(|code| !code.is_empty())
        .unwrap_or_else(|| "SERVICE_ERROR".to_string());
    let message = field("message").unwrap_or_else(|| format!("the service answered {status}"));
    ApiError {
        code,
        message,
        status,
    }
}

/// A key or a database name as one URL path segment.
pub fn path_segment(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for byte in text.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char)
            }
            other => out.push_str(&format!("%{other:02X}")),
        }
    }
    out
}

fn database_from(raw: &Value) -> ApiResult<Database> {
    let text = |value: &Value| value.as_str().map(str::to_string);
    let malformed = || {
        ApiError::local(
            "SERVICE_ERROR",
            "the service sent a database it could not be read from",
        )
    };
    Ok(Database {
        id: text(&raw["id"]).ok_or_else(malformed)?,
        name: text(&raw["spec"]["name"]).ok_or_else(malformed)?,
        region: text(&raw["region"]).unwrap_or_default(),
        status: text(&raw["status"]).unwrap_or_default(),
        status_reason: text(&raw["status_reason"]),
        created_at: text(&raw["created_at"]).unwrap_or_default(),
        stored_bytes: raw["usage"]["stored_bytes"].as_u64(),
    })
}

/// Talks to the service for one connection.
#[derive(Debug, Clone)]
pub struct Client {
    http: reqwest::Client,
    connection: Connection,
}

impl Client {
    pub fn new(connection: Connection) -> ApiResult<Self> {
        if !connection.api_key.starts_with("ekv_") {
            return Err(ApiError::local(
                "BAD_REQUEST",
                "the API key should start with ekv_",
            ));
        }
        for (name, url) in [
            ("data API address", &connection.api_url),
            ("management address", &connection.control_url),
        ] {
            if !(url.starts_with("https://") || url.starts_with("http://")) {
                return Err(ApiError::local(
                    "BAD_REQUEST",
                    format!("the {name} should start with https://"),
                ));
            }
        }
        let http = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(5))
            .timeout(Duration::from_secs(20))
            .build()
            .map_err(|e| ApiError::local("NETWORK", e.to_string()))?;
        Ok(Client { http, connection })
    }

    fn data(&self, database: &str, rest: &str) -> String {
        format!(
            "{}/v1/db/{}{rest}",
            self.connection.api_url.trim_end_matches('/'),
            path_segment(database)
        )
    }

    fn control(&self, path: &str) -> String {
        format!(
            "{}{path}",
            self.connection.control_url.trim_end_matches('/')
        )
    }

    async fn send(&self, request: reqwest::RequestBuilder) -> ApiResult<Value> {
        let response = request
            .bearer_auth(&self.connection.api_key)
            .send()
            .await
            .map_err(|e| {
                if e.is_timeout() {
                    ApiError::local(
                        "TIMEOUT",
                        "no answer in time; a write may or may not have been stored",
                    )
                } else {
                    ApiError::local("NETWORK", format!("could not reach the service: {e}"))
                }
            })?;
        let status = response.status();
        let header_code = response
            .headers()
            .get("x-edgekv-error")
            .and_then(|value| value.to_str().ok())
            .map(str::to_string);
        let body = response
            .bytes()
            .await
            .map_err(|e| ApiError::local("NETWORK", format!("the answer was cut short: {e}")))?;
        if !status.is_success() {
            return Err(error_from_response(
                status.as_u16(),
                header_code.as_deref(),
                &body,
            ));
        }
        if body.is_empty() {
            return Ok(Value::Null);
        }
        serde_json::from_slice(&body).map_err(|_| {
            ApiError::local(
                "SERVICE_ERROR",
                "the service sent an answer that is not JSON",
            )
        })
    }

    // ------------------------------------------------------------ management

    pub async fn regions(&self) -> ApiResult<Vec<String>> {
        let reply = self
            .send(self.http.get(self.control("/v1/regions")))
            .await?;
        Ok(reply["items"]
            .as_array()
            .map(|items| {
                items
                    .iter()
                    .filter_map(|item| item["region"].as_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default())
    }

    /// Every database in the account, following the pages.
    pub async fn databases(&self) -> ApiResult<Vec<Database>> {
        let mut all = Vec::new();
        let mut token: Option<String> = None;
        loop {
            let mut request = self
                .http
                .get(self.control("/v1/databases"))
                .query(&[("limit", "200")]);
            if let Some(token) = &token {
                request = request.query(&[("page_token", token)]);
            }
            let reply = self.send(request).await?;
            for raw in reply["items"].as_array().into_iter().flatten() {
                all.push(database_from(raw)?);
            }
            token = reply["next_page_token"].as_str().map(str::to_string);
            if token.is_none() {
                return Ok(all);
            }
        }
    }

    pub async fn database(&self, id: &str) -> ApiResult<Database> {
        let url = self.control(&format!("/v1/databases/{}", path_segment(id)));
        database_from(&self.send(self.http.get(url)).await?)
    }

    pub async fn create_database(&self, name: &str, region: &str) -> ApiResult<Database> {
        let request = self
            .http
            .post(self.control("/v1/databases"))
            .json(&json!({ "name": name, "region": region }));
        database_from(&self.send(request).await?)
    }

    pub async fn delete_database(&self, id: &str) -> ApiResult<()> {
        let url = self.control(&format!("/v1/databases/{}", path_segment(id)));
        self.send(self.http.delete(url)).await.map(|_| ())
    }

    /// The replicas most recently seen syncing a database.
    pub async fn replicas(&self, id: &str) -> ApiResult<Vec<Replica>> {
        let url = self.control(&format!("/v1/databases/{}/replicas", path_segment(id)));
        let reply = self
            .send(self.http.get(url).query(&[("limit", "200")]))
            .await?;
        serde_json::from_value(reply["items"].clone()).map_err(|_| {
            ApiError::local(
                "SERVICE_ERROR",
                "the service sent replicas that could not be read",
            )
        })
    }

    // ------------------------------------------------------------------ data

    /// One page of entries in key order.
    pub async fn scan(
        &self,
        database: &str,
        prefix: &str,
        page_token: Option<&str>,
        page_size: u32,
    ) -> ApiResult<EntryPage> {
        let mut request = self
            .http
            .get(self.data(database, "/kv"))
            .query(&[("limit", page_size.clamp(1, 200).to_string())]);
        if !prefix.is_empty() {
            request = request.query(&[("prefix", prefix)]);
        }
        if let Some(token) = page_token {
            request = request.query(&[("page_token", token)]);
        }
        let reply = self.send(request).await?;
        let items = reply["items"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|item| {
                Some(Entry {
                    key: item["key"].as_str()?.to_string(),
                    value: item["value"].as_str()?.to_string(),
                })
            })
            .collect();
        Ok(EntryPage {
            items,
            next_page_token: reply["next_page_token"].as_str().map(str::to_string),
        })
    }

    /// Stores a value. Key and value are base64, so any bytes can be written.
    pub async fn put(&self, database: &str, key_b64: &str, value_b64: &str) -> ApiResult<u64> {
        self.commit(
            database,
            json!([{ "op": "put", "key": key_b64, "value": value_b64 }]),
        )
        .await
    }

    pub async fn delete(&self, database: &str, key_b64: &str) -> ApiResult<u64> {
        self.commit(database, json!([{ "op": "delete", "key": key_b64 }]))
            .await
    }

    async fn commit(&self, database: &str, ops: Value) -> ApiResult<u64> {
        for op in ops.as_array().into_iter().flatten() {
            let key = op["key"].as_str().unwrap_or_default();
            if B64
                .decode(key)
                .map(|bytes| bytes.is_empty())
                .unwrap_or(true)
            {
                return Err(ApiError::local("BAD_REQUEST", "a key must not be empty"));
            }
        }
        let request = self
            .http
            .post(self.data(database, "/commit"))
            .json(&json!({ "ops": ops }));
        let reply = self.send(request).await?;
        reply["lsn"].as_u64().ok_or_else(|| {
            ApiError::local(
                "SERVICE_ERROR",
                "the service did not say where the write landed",
            )
        })
    }

    /// Where the database's history ends. Also the cheapest way to find out
    /// whether a database can be reached with this key.
    pub async fn head(&self, database: &str) -> ApiResult<u64> {
        let reply = self
            .send(self.http.get(self.data(database, "/head")))
            .await?;
        Ok(reply["lsn"].as_u64().unwrap_or(0))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_failed_answer_keeps_the_services_code_and_message() {
        let body =
            br#"{"error":{"code":"PLAN_LIMIT_EXCEEDED","message":"this plan allows 3 databases"}}"#;
        assert_eq!(
            error_from_response(403, None, body),
            ApiError {
                code: "PLAN_LIMIT_EXCEEDED".into(),
                message: "this plan allows 3 databases".into(),
                status: 403
            }
        );
    }

    #[test]
    fn an_answer_with_no_readable_body_falls_back_to_the_header_then_to_a_general_code() {
        let from_header = error_from_response(503, Some("UNAVAILABLE"), b"");
        assert_eq!(
            (from_header.code.as_str(), from_header.status),
            ("UNAVAILABLE", 503)
        );
        assert_eq!(from_header.message, "the service answered 503");
        let html = error_from_response(502, None, b"<html>bad gateway</html>");
        assert_eq!(html.code, "SERVICE_ERROR");
    }

    #[test]
    fn names_and_ids_are_escaped_as_path_segments() {
        assert_eq!(path_segment("orders"), "orders");
        assert_eq!(path_segment("a b/c?d"), "a%20b%2Fc%3Fd");
        assert_eq!(path_segment("naïve"), "na%C3%AFve");
    }

    #[test]
    fn a_database_is_read_from_the_services_shape() {
        let raw = json!({
            "id": "d1", "region": "us-west-2", "status": "active", "status_reason": null,
            "created_at": "2026-10-12T00:00:00Z", "spec": { "name": "orders" },
            "usage": { "stored_bytes": 1234 }
        });
        let database = database_from(&raw).unwrap();
        assert_eq!(
            (database.name.as_str(), database.stored_bytes),
            ("orders", Some(1234))
        );
        assert!(database_from(&json!({ "id": "d1" })).is_err());
    }

    #[test]
    fn a_connection_that_cannot_work_is_refused_before_any_request() {
        let connection = |key: &str, url: &str| Connection {
            api_url: url.into(),
            control_url: "https://cp.example.com".into(),
            api_key: key.into(),
        };
        assert!(Client::new(connection("ekv_k", "https://api.example.com")).is_ok());
        assert_eq!(
            Client::new(connection("not-a-key", "https://api.example.com"))
                .unwrap_err()
                .code,
            "BAD_REQUEST"
        );
        assert_eq!(
            Client::new(connection("ekv_k", "api.example.com"))
                .unwrap_err()
                .code,
            "BAD_REQUEST"
        );
    }

    #[tokio::test]
    async fn an_empty_key_is_refused_without_a_request() {
        let client = Client::new(Connection {
            // Nothing listens here: reaching it would be a different error.
            api_url: "http://127.0.0.1:1".into(),
            control_url: "http://127.0.0.1:1".into(),
            api_key: "ekv_k".into(),
        })
        .unwrap();
        assert_eq!(
            client.put("orders", "", "dg==").await.unwrap_err().code,
            "BAD_REQUEST"
        );
        assert_eq!(
            client.put("orders", "aw==", "dg==").await.unwrap_err().code,
            "NETWORK"
        );
    }
}

/// Against a running service. Not run by default:
///
/// ```sh
/// EDGEKV_URL=… EDGEKV_CONTROL_URL=… EDGEKV_API_KEY=ekv_… \
///   cargo test --lib integration -- --ignored --nocapture
/// ```
#[cfg(test)]
mod integration {
    use super::*;

    fn client() -> Client {
        let env = |name: &str| std::env::var(name).unwrap_or_else(|_| panic!("{name} is required"));
        Client::new(Connection {
            api_url: env("EDGEKV_URL"),
            control_url: env("EDGEKV_CONTROL_URL"),
            api_key: env("EDGEKV_API_KEY"),
        })
        .unwrap()
    }

    #[tokio::test]
    #[ignore = "needs a running service"]
    async fn a_database_is_created_filled_browsed_and_deleted() {
        let client = client();
        let regions = client.regions().await.unwrap();
        assert!(!regions.is_empty());
        let name = format!(
            "desktop-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_millis()
        );
        let created = client.create_database(&name, &regions[0]).await.unwrap();
        assert_eq!(
            (created.name.as_str(), created.status.as_str()),
            (name.as_str(), "active")
        );
        assert!(client
            .databases()
            .await
            .unwrap()
            .iter()
            .any(|d| d.id == created.id));
        assert_eq!(
            client
                .create_database(&name, &regions[0])
                .await
                .unwrap_err()
                .code,
            "NAME_CONFLICT"
        );

        // Usable on the data API a moment after it is created.
        let mut ready = false;
        for _ in 0..60 {
            match client.head(&name).await {
                Ok(_) => {
                    ready = true;
                    break;
                }
                Err(e) if e.code == "NOT_FOUND" => {
                    tokio::time::sleep(Duration::from_millis(500)).await
                }
                Err(e) => panic!("{e:?}"),
            }
        }
        assert!(ready, "the new database never became usable");

        let b64 = |text: &str| B64.encode(text);
        for i in 0..5 {
            client
                .put(
                    &name,
                    &b64(&format!("item/{i}")),
                    &b64(&format!("value {i}")),
                )
                .await
                .unwrap();
        }
        // A key that is not text.
        client
            .put(&name, &B64.encode([0xff, 0x00]), &b64("binary"))
            .await
            .unwrap();

        let first = client.scan(&name, "item/", None, 3).await.unwrap();
        assert_eq!(first.items.len(), 3);
        assert_eq!(first.items[0].key, b64("item/0"));
        assert_eq!(first.items[0].value, b64("value 0"));
        let second = client
            .scan(&name, "item/", first.next_page_token.as_deref(), 3)
            .await
            .unwrap();
        assert_eq!(second.items.len(), 2);
        assert_eq!(second.next_page_token, None);
        assert_eq!(
            client.scan(&name, "", None, 200).await.unwrap().items.len(),
            6
        );

        client.delete(&name, &b64("item/0")).await.unwrap();
        assert_eq!(
            client
                .scan(&name, "item/", None, 200)
                .await
                .unwrap()
                .items
                .len(),
            4
        );
        assert!(client.head(&name).await.unwrap() >= 7);

        let details = client.database(&created.id).await.unwrap();
        assert!(details.stored_bytes.is_some());
        assert!(client.replicas(&created.id).await.unwrap().is_empty());

        client.delete_database(&created.id).await.unwrap();
        assert_eq!(
            client
                .database("00000000-0000-4000-8000-000000000000")
                .await
                .unwrap_err()
                .code,
            "NOT_FOUND"
        );
    }
}

//! Node.js bindings to the valkvedge library.
//!
//! This is the native half of the local mode of `@valkvlabs/edgekv`. It is
//! deliberately thin: bytes in, bytes out. Text, JSON, async iteration and the
//! error class live in the TypeScript package (`typescript/src/local.ts`).
//!
//! Every error is raised with the message `[CODE] explanation`, where `CODE`
//! is the library's stable code; the TypeScript side turns that into an
//! `EdgeKVError`.

use napi::bindgen_prelude::{Buffer, Function, Promise};
use napi::threadsafe_function::ThreadsafeFunction;
use napi::Status;
use napi_derive::napi;
use std::ops::Bound;
use std::sync::Arc;
use valkvedge::{Durability, ValkvEdge, ValkvEdgeError, Version, WatchEvent, WriteOutcome};

/// The application's token source, callable from any thread. Weak, so it
/// never keeps the Node.js process alive on its own.
type TokenFn = ThreadsafeFunction<String, Promise<String>, String, Status, false, true>;

/// Largest page `scan` returns.
const MAX_PAGE: u32 = 1000;

fn fail(e: ValkvEdgeError) -> napi::Error {
    napi::Error::from_reason(format!("[{}] {e}", e.code()))
}

fn invalid(message: impl std::fmt::Display) -> napi::Error {
    napi::Error::from_reason(format!("[INVALID_ARGUMENT] {message}"))
}

fn durability(value: Option<&str>) -> napi::Result<Option<Durability>> {
    match value {
        None => Ok(None),
        Some("sync") => Ok(Some(Durability::Sync)),
        Some("buffered") => Ok(Some(Durability::Buffered)),
        Some(other) => Err(invalid(format!(
            "durability must be 'sync' or 'buffered', not {other:?}"
        ))),
    }
}

/// How to open a directory of databases.
#[napi(object)]
pub struct OpenOptions {
    /// The directory the local copies live in. Created if missing.
    pub path: String,
    /// A hosted service to follow. Without it the databases are local only.
    pub url: Option<String>,
    /// The API key for `url`.
    pub api_key: Option<String>,
    /// Most databases kept open at once.
    pub max_open_databases: Option<u32>,
}

/// How to open one database.
#[napi(object)]
pub struct DatabaseOptions {
    /// `'sync'` (the default) or `'buffered'`: used by writes that name none.
    pub durability: Option<String>,
    /// 32 bytes. Values are sealed with it before they are stored anywhere.
    pub encryption_key: Option<Buffer>,
}

/// One write in a batch.
#[napi(object)]
pub struct NativeOp {
    /// True for a delete, false for a put.
    pub delete: bool,
    pub key: Buffer,
    /// The value of a put. Ignored for a delete.
    pub value: Option<Buffer>,
}

/// A requirement on one key for a conditional commit.
#[napi(object)]
pub struct NativeCondition {
    pub key: Buffer,
    /// The version the key's value must be at; `null`: it must have no value.
    pub version: Option<String>,
}

/// What a write returned.
#[napi(object)]
pub struct NativeCommit {
    /// The frame's position in the log, when the write reached it.
    pub lsn: Option<i64>,
    /// The outbox sequence number, for a buffered write.
    pub outbox_seq: Option<i64>,
    /// The version each write gave its key, in order.
    pub versions: Vec<String>,
}

/// A value and its version.
#[napi(object)]
pub struct NativeVersioned {
    pub value: Buffer,
    pub version: String,
}

/// One change reported by a watch.
#[napi(object)]
pub struct NativeWatchEvent {
    /// True when any key may have changed: read again what you show.
    pub reset: bool,
    /// The key that changed, unless `reset`.
    pub key: Option<Buffer>,
    /// Its value now; absent when it has none.
    pub value: Option<Buffer>,
}

#[napi(object)]
pub struct NativeEntry {
    pub key: Buffer,
    pub value: Buffer,
}

/// Bounds for `scan`. With `prefix`, `start` and `end` must be unset.
#[napi(object)]
pub struct ScanBounds {
    pub prefix: Option<Buffer>,
    /// First key, included.
    pub start: Option<Buffer>,
    /// Last key, excluded.
    pub end: Option<Buffer>,
    /// Resume after this key, excluded: the last key of the previous page.
    pub after: Option<Buffer>,
    pub limit: Option<u32>,
}

#[napi(object)]
pub struct NativeStatus {
    pub applied_lsn: i64,
    pub generation: i64,
    pub outbox_entries: i64,
    pub outbox_bytes: i64,
    pub disk_bytes: i64,
}

/// A buffered write that did not take effect.
#[napi(object)]
pub struct NativeEvent {
    pub outbox_seq: i64,
    pub key: Buffer,
    /// `SUPERSEDED`, `CLOCK_SKEW` or `STALE_WRITE`.
    pub outcome: String,
}

/// A directory of local databases, optionally following a hosted service.
#[napi]
pub struct NativeKv {
    kv: ValkvEdge,
}

/// Opens a directory of databases.
///
/// Async so the library starts its background task (pushing buffered writes,
/// pulling changes) on the runtime the bindings own.
#[napi]
pub async fn open_kv(options: OpenOptions) -> napi::Result<NativeKv> {
    let mut builder = ValkvEdge::builder(options.path);
    if let Some(n) = options.max_open_databases {
        builder = builder.max_open_databases(n as usize);
    }
    match (options.url, options.api_key) {
        (Some(url), Some(api_key)) => builder = builder.remote(url, api_key),
        (None, None) => {}
        _ => return Err(invalid("url and apiKey go together")),
    }
    Ok(NativeKv {
        kv: builder.build().map_err(fail)?,
    })
}

/// Opens a directory of databases that follow a hosted service with access
/// tokens instead of an API key. `tokens` is called with a database name and
/// returns a promise of a token for it; it is called again shortly before a
/// token expires and whenever the service refuses one.
///
/// Not async: the token function has to be wrapped on the JavaScript thread.
#[napi]
pub fn open_kv_with_tokens(
    options: OpenOptions,
    tokens: Function<String, Promise<String>>,
) -> napi::Result<NativeKv> {
    let Some(url) = options.url else {
        return Err(invalid("url is required with tokens"));
    };
    if options.api_key.is_some() {
        return Err(invalid("give apiKey or tokens, not both"));
    }
    let source: Arc<TokenFn> = Arc::new(
        tokens
            .build_threadsafe_function::<String>()
            .callee_handled::<false>()
            .weak::<true>()
            .build()?,
    );
    let mut builder = ValkvEdge::builder(options.path);
    if let Some(n) = options.max_open_databases {
        builder = builder.max_open_databases(n as usize);
    }
    builder = builder.remote_with_tokens(url, move |database: String| {
        let source = source.clone();
        async move {
            let unavailable = |e: napi::Error| {
                ValkvEdgeError::Unavailable(format!("the token source failed: {e}"))
            };
            let promise = source
                .call_async_catch(database)
                .await
                .map_err(unavailable)?;
            promise.await.map_err(unavailable)
        }
    });
    // The background task starts on the runtime the bindings own.
    let kv = napi::bindgen_prelude::within_runtime_if_available(|| builder.build());
    Ok(NativeKv {
        kv: kv.map_err(fail)?,
    })
}

#[napi]
impl NativeKv {
    /// Opens `name`, or `namespace/name`.
    #[napi]
    pub async fn database(
        &self,
        name: String,
        options: Option<DatabaseOptions>,
    ) -> napi::Result<NativeDb> {
        let (mode, key) = match options {
            None => (None, None),
            Some(o) => {
                let key = match o.encryption_key {
                    None => None,
                    Some(k) => Some(<[u8; 32]>::try_from(&k[..]).map_err(|_| {
                        invalid(format!("encryptionKey must be 32 bytes, not {}", k.len()))
                    })?),
                };
                (durability(o.durability.as_deref())?, key)
            }
        };
        let mut builder = match name.split_once('/') {
            Some((namespace, name)) => self.kv.namespace(namespace).database(name),
            None => self.kv.database(&name),
        };
        if let Some(d) = mode {
            builder = builder.durability(d);
        }
        if let Some(k) = key {
            builder = builder.encryption_key(k);
        }
        Ok(NativeDb {
            db: builder.open().await.map_err(fail)?,
        })
    }

    /// Releases leases and closes idle databases. Call before exiting.
    #[napi]
    pub async fn close(&self) -> napi::Result<()> {
        self.kv.close().await.map_err(fail)
    }
}

/// One database.
#[napi]
pub struct NativeDb {
    db: valkvedge::Database,
}

#[napi]
impl NativeDb {
    #[napi(getter)]
    pub fn name(&self) -> String {
        self.db.name().to_string()
    }

    /// Reads a key from the local copy. Never touches the network.
    #[napi]
    pub fn get(&self, key: Buffer) -> napi::Result<Option<Buffer>> {
        Ok(self.db.get(&key).map_err(fail)?.map(Buffer::from))
    }

    /// Reads a key and the version of its value from the local copy.
    #[napi]
    pub fn get_versioned(&self, key: Buffer) -> napi::Result<Option<NativeVersioned>> {
        Ok(self
            .db
            .get_versioned(&key)
            .map_err(fail)?
            .map(|(value, version)| NativeVersioned {
                value: value.into(),
                version: version.to_string(),
            }))
    }

    /// Reports changes under `prefix` as they reach the local copy.
    #[napi]
    pub fn watch(&self, prefix: Buffer) -> napi::Result<NativeWatch> {
        let watch = self.db.watch(&prefix).map_err(fail)?;
        let (closed, _) = tokio::sync::watch::channel(false);
        Ok(NativeWatch {
            watch: Arc::new(tokio::sync::Mutex::new(Some(watch))),
            closed,
        })
    }

    /// One page of keys in order, from the local copy.
    #[napi]
    pub fn scan(&self, bounds: ScanBounds) -> napi::Result<Vec<NativeEntry>> {
        let limit = bounds.limit.unwrap_or(MAX_PAGE).clamp(1, MAX_PAGE) as usize;
        let (mut lower, upper) = match bounds.prefix {
            Some(prefix) => {
                if bounds.start.is_some() || bounds.end.is_some() {
                    return Err(invalid("give either prefix or start and end, not both"));
                }
                let upper = successor(&prefix).map_or(Bound::Unbounded, Bound::Excluded);
                (Bound::Included(prefix.to_vec()), upper)
            }
            None => (
                bounds
                    .start
                    .map_or(Bound::Unbounded, |k| Bound::Included(k.to_vec())),
                bounds
                    .end
                    .map_or(Bound::Unbounded, |k| Bound::Excluded(k.to_vec())),
            ),
        };
        if let Some(after) = bounds.after {
            let past = match &lower {
                Bound::Included(k) | Bound::Excluded(k) => after[..] >= k[..],
                Bound::Unbounded => true,
            };
            if past {
                lower = Bound::Excluded(after.to_vec());
            }
        }
        let mut page = Vec::new();
        for item in self.db.range((lower, upper)).map_err(fail)?.take(limit) {
            let (key, value) = item.map_err(fail)?;
            page.push(NativeEntry {
                key: key.into(),
                value: value.into(),
            });
        }
        Ok(page)
    }

    /// Applies every operation, or none of them; with `conditions`, only if
    /// each holds.
    #[napi]
    pub async fn commit(
        &self,
        ops: Vec<NativeOp>,
        mode: Option<String>,
        conditions: Option<Vec<NativeCondition>>,
    ) -> napi::Result<NativeCommit> {
        let mode = durability(mode.as_deref())?;
        let mut batch = self.db.batch();
        for op in &ops {
            if op.delete {
                batch.delete(&op.key);
            } else {
                let value = op.value.as_deref().unwrap_or_default();
                batch.put(&op.key, value);
            }
        }
        for condition in conditions.iter().flatten() {
            match &condition.version {
                None => batch.if_absent(&condition.key),
                Some(text) => {
                    let version: Version = text
                        .parse()
                        .map_err(|_| invalid(format!("{text:?} is not a version")))?;
                    batch.if_version(&condition.key, &version)
                }
            };
        }
        let commit = match mode {
            Some(d) => batch.commit_with(d).await,
            None => batch.commit().await,
        }
        .map_err(fail)?;
        Ok(NativeCommit {
            lsn: commit.lsn.map(|l| l as i64),
            outbox_seq: commit.outbox_seq.map(|s| s as i64),
            versions: commit.versions.iter().map(Version::to_string).collect(),
        })
    }

    /// Pushes buffered writes and pulls what is new. Returns the local LSN.
    #[napi]
    pub async fn sync(&self) -> napi::Result<i64> {
        self.db.sync().await.map(|l| l as i64).map_err(fail)
    }

    /// Pushes buffered writes now. Returns the number of batches settled.
    #[napi]
    pub async fn flush(&self) -> napi::Result<i64> {
        self.db.flush().await.map(|n| n as i64).map_err(fail)
    }

    #[napi]
    pub fn status(&self) -> napi::Result<NativeStatus> {
        let s = self.db.status().map_err(fail)?;
        Ok(NativeStatus {
            applied_lsn: s.applied_lsn as i64,
            generation: s.generation as i64,
            outbox_entries: s.outbox_entries as i64,
            outbox_bytes: s.outbox_bytes as i64,
            disk_bytes: s.disk_bytes as i64,
        })
    }

    /// Returns and clears the buffered writes that did not take effect.
    #[napi]
    pub fn take_events(&self) -> Vec<NativeEvent> {
        self.db
            .take_events()
            .into_iter()
            .map(|e| NativeEvent {
                outbox_seq: e.outbox_seq as i64,
                key: e.key.into(),
                outcome: match e.outcome {
                    WriteOutcome::Superseded => "SUPERSEDED".into(),
                    WriteOutcome::Rejected(reason) => {
                        ValkvEdgeError::Rejected(reason).code().into()
                    }
                },
            })
            .collect()
    }
}

/// A subscription to changes under a prefix. Keeps its database open until
/// closed.
#[napi]
pub struct NativeWatch {
    // `None` once closed.
    watch: Arc<tokio::sync::Mutex<Option<valkvedge::Watch>>>,
    closed: tokio::sync::watch::Sender<bool>,
}

#[napi]
impl NativeWatch {
    /// The next change, or `null` once the watch is closed.
    #[napi]
    pub async fn next(&self) -> napi::Result<Option<NativeWatchEvent>> {
        let mut closing = self.closed.subscribe();
        if *closing.borrow() {
            return Ok(None);
        }
        let mut slot = self.watch.lock().await;
        let Some(watch) = slot.as_mut() else {
            return Ok(None);
        };
        let event = tokio::select! {
            event = watch.next() => event.map_err(fail)?,
            _ = closing.wait_for(|closed| *closed) => {
                *slot = None;
                return Ok(None);
            }
        };
        Ok(Some(match event {
            WatchEvent::Reset => NativeWatchEvent {
                reset: true,
                key: None,
                value: None,
            },
            WatchEvent::Changed { key, value } => NativeWatchEvent {
                reset: false,
                key: Some(key.into()),
                value: value.map(Buffer::from),
            },
        }))
    }

    /// Stops the watch. A pending `next` returns `null`.
    #[napi]
    pub fn close(&self) {
        self.closed.send_replace(true);
        // If nothing is waiting, release the database now; otherwise the
        // waiting `next` does on its way out.
        if let Ok(mut slot) = self.watch.try_lock() {
            *slot = None;
        }
    }
}

/// The smallest key greater than every key starting with `prefix`, or `None`
/// when there is none (the prefix is empty or all 0xff).
fn successor(prefix: &[u8]) -> Option<Vec<u8>> {
    let mut next = prefix.to_vec();
    while let Some(last) = next.pop() {
        if last < 0xff {
            next.push(last + 1);
            return Some(next);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::successor;

    #[test]
    fn successor_of_a_prefix() {
        assert_eq!(successor(b"ab"), Some(b"ac".to_vec()));
        assert_eq!(successor(b"a\xff"), Some(b"b".to_vec()));
        assert_eq!(successor(b"\xff\xff"), None);
        assert_eq!(successor(b""), None);
    }
}

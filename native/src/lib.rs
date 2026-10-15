//! Node.js bindings to the valkvedge library.
//!
//! This is the native half of the local mode of `@valkv/edgekv`. It is
//! deliberately thin: bytes in, bytes out. Text, JSON, async iteration and the
//! error class live in the TypeScript package (`typescript/src/local.ts`).
//!
//! Every error is raised with the message `[CODE] explanation`, where `CODE`
//! is the library's stable code; the TypeScript side turns that into an
//! `EdgeKVError`.

use napi::bindgen_prelude::Buffer;
use napi_derive::napi;
use std::ops::Bound;
use valkvedge::{Durability, ValkvEdge, ValkvEdgeError, WriteOutcome};

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

/// What a write returned.
#[napi(object)]
pub struct NativeCommit {
    /// The frame's position in the log, when the write reached it.
    pub lsn: Option<i64>,
    /// The outbox sequence number, for a buffered write.
    pub outbox_seq: Option<i64>,
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

    /// Applies every operation, or none of them.
    #[napi]
    pub async fn commit(
        &self,
        ops: Vec<NativeOp>,
        mode: Option<String>,
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
        let commit = match mode {
            Some(d) => batch.commit_with(d).await,
            None => batch.commit().await,
        }
        .map_err(fail)?;
        Ok(NativeCommit {
            lsn: commit.lsn.map(|l| l as i64),
            outbox_seq: commit.outbox_seq.map(|s| s as i64),
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

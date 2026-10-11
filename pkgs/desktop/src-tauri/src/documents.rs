//! Keeps the app's own documents in an SQLite file under the app data
//! directory, outside the WebView storage that the WebView may evict.
//!
//! Documents and thumbnails cross IPC as raw bytes in an envelope: a
//! little-endian u32 header length, a JSON header, then the bytes that the
//! header's `BlobRef`s point into.

use serde::{Deserialize, Serialize};
use sqlx::sqlite::{SqliteConnectOptions, SqlitePool, SqliteRow};
use sqlx::Row;
use std::borrow::Cow;
use std::collections::HashMap;
use std::path::Path;
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::State;

pub struct DocumentsDb {
    pool: SqlitePool,
}

#[derive(Serialize, Deserialize, Clone, Copy)]
struct BlobRef {
    offset: usize,
    length: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MetaOut {
    id: String,
    name: String,
    created_at: i64,
    updated_at: i64,
    thumbnail: Option<BlobRef>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DataOut {
    id: String,
    created_at: i64,
    document: BlobRef,
    thumbnail: Option<BlobRef>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RevisionOut {
    id: String,
    document_id: String,
    created_at: i64,
    document: BlobRef,
    thumbnail: Option<BlobRef>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateIn {
    meta: CreateMetaIn,
    data: CreateDataIn,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateMetaIn {
    id: String,
    name: String,
    created_at: i64,
    updated_at: i64,
    thumbnail: Option<BlobRef>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateDataIn {
    document: BlobRef,
    thumbnail: Option<BlobRef>,
    created_at: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpsertIn {
    id: String,
    name: String,
    now: i64,
    document: BlobRef,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SaveIn {
    id: String,
    now: i64,
    document: BlobRef,
    thumbnail: Option<BlobRef>,
    replace_meta_thumbnail: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AddRevisionIn {
    id: String,
    document_id: String,
    created_at: i64,
    document: BlobRef,
    thumbnail: Option<BlobRef>,
    keep_count: i64,
}

pub async fn open(app_data_dir: &Path) -> Result<DocumentsDb, String> {
    std::fs::create_dir_all(app_data_dir).map_err(|error| error.to_string())?;
    let options = SqliteConnectOptions::new()
        .filename(app_data_dir.join("documents.sqlite"))
        .create_if_missing(true);
    let pool = SqlitePool::connect_with(options)
        .await
        .map_err(|error| error.to_string())?;

    for statement in [
        "CREATE TABLE IF NOT EXISTS documentMeta (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL, thumbnail BLOB)",
        "CREATE INDEX IF NOT EXISTS documentMetaUpdatedAtIdx ON documentMeta(updatedAt DESC)",
        "CREATE TABLE IF NOT EXISTS documentData (id TEXT PRIMARY KEY NOT NULL, document BLOB NOT NULL, thumbnail BLOB, createdAt INTEGER NOT NULL)",
        "CREATE TABLE IF NOT EXISTS documentRevisions (id TEXT PRIMARY KEY NOT NULL, documentId TEXT NOT NULL, document BLOB NOT NULL, thumbnail BLOB, createdAt INTEGER NOT NULL)",
        "CREATE INDEX IF NOT EXISTS documentRevisionsDocumentIdx ON documentRevisions(documentId, createdAt)",
    ] {
        sqlx::query(statement)
            .execute(&pool)
            .await
            .map_err(|error| error.to_string())?;
    }

    Ok(DocumentsDb { pool })
}

#[tauri::command]
pub async fn documents_list_metas(db: State<'_, DocumentsDb>) -> Result<Response, String> {
    let rows = sqlx::query(
        "SELECT id, name, createdAt, updatedAt, thumbnail FROM documentMeta ORDER BY updatedAt DESC",
    )
    .fetch_all(&db.pool)
    .await
    .map_err(|error| error.to_string())?;

    let mut envelope = EnvelopeWriter::default();
    let metas = rows
        .iter()
        .map(|row| meta_out(row, &mut envelope))
        .collect::<Result<Vec<_>, _>>()?;
    envelope.finish(&metas)
}

#[tauri::command]
pub async fn documents_get_meta(
    db: State<'_, DocumentsDb>,
    id: String,
) -> Result<Response, String> {
    let row = sqlx::query(
        "SELECT id, name, createdAt, updatedAt, thumbnail FROM documentMeta WHERE id = ?",
    )
    .bind(id)
    .fetch_optional(&db.pool)
    .await
    .map_err(|error| error.to_string())?;

    let mut envelope = EnvelopeWriter::default();
    let meta = row.map(|row| meta_out(&row, &mut envelope)).transpose()?;
    envelope.finish(&meta)
}

#[tauri::command]
pub async fn documents_load(db: State<'_, DocumentsDb>, id: String) -> Result<Response, String> {
    let row =
        sqlx::query("SELECT id, document, thumbnail, createdAt FROM documentData WHERE id = ?")
            .bind(id)
            .fetch_optional(&db.pool)
            .await
            .map_err(|error| error.to_string())?;

    let mut envelope = EnvelopeWriter::default();
    let data = row
        .map(|row| -> Result<DataOut, String> {
            Ok(DataOut {
                id: get(&row, "id")?,
                created_at: get(&row, "createdAt")?,
                document: envelope.attach(get(&row, "document")?),
                thumbnail: envelope.attach_optional(get(&row, "thumbnail")?),
            })
        })
        .transpose()?;
    envelope.finish(&data)
}

/// Lists a document's revisions, newest first.
#[tauri::command]
pub async fn documents_list_revisions(
    db: State<'_, DocumentsDb>,
    document_id: String,
) -> Result<Response, String> {
    let rows = sqlx::query(
        "SELECT id, documentId, document, thumbnail, createdAt FROM documentRevisions WHERE documentId = ? ORDER BY createdAt DESC",
    )
    .bind(document_id)
    .fetch_all(&db.pool)
    .await
    .map_err(|error| error.to_string())?;

    let mut envelope = EnvelopeWriter::default();
    let revisions = rows
        .iter()
        .map(|row| -> Result<RevisionOut, String> {
            Ok(RevisionOut {
                id: get(row, "id")?,
                document_id: get(row, "documentId")?,
                created_at: get(row, "createdAt")?,
                document: envelope.attach(get(row, "document")?),
                thumbnail: envelope.attach_optional(get(row, "thumbnail")?),
            })
        })
        .collect::<Result<Vec<_>, _>>()?;
    envelope.finish(&revisions)
}

#[tauri::command]
pub async fn documents_count_revisions(
    db: State<'_, DocumentsDb>,
) -> Result<HashMap<String, i64>, String> {
    let rows = sqlx::query(
        "SELECT documentId, COUNT(*) AS count FROM documentRevisions GROUP BY documentId",
    )
    .fetch_all(&db.pool)
    .await
    .map_err(|error| error.to_string())?;

    rows.iter()
        .map(|row| Ok((get(row, "documentId")?, get(row, "count")?)))
        .collect()
}

#[tauri::command]
pub async fn documents_create(
    db: State<'_, DocumentsDb>,
    request: Request<'_>,
) -> Result<(), String> {
    let body = request_bytes(&request)?;
    let (input, blobs) = read_envelope::<CreateIn>(&body)?;
    let mut tx = db.pool.begin().await.map_err(|error| error.to_string())?;

    sqlx::query(
        "INSERT INTO documentMeta (id, name, createdAt, updatedAt, thumbnail) VALUES (?, ?, ?, ?, ?)",
    )
    .bind(&input.meta.id)
    .bind(&input.meta.name)
    .bind(input.meta.created_at)
    .bind(input.meta.updated_at)
    .bind(blob_optional(blobs, input.meta.thumbnail)?)
    .execute(&mut *tx)
    .await
    .map_err(|error| error.to_string())?;

    sqlx::query(
        "INSERT INTO documentData (id, document, thumbnail, createdAt) VALUES (?, ?, ?, ?)",
    )
    .bind(&input.meta.id)
    .bind(blob(blobs, input.data.document)?)
    .bind(blob_optional(blobs, input.data.thumbnail)?)
    .bind(input.data.created_at)
    .execute(&mut *tx)
    .await
    .map_err(|error| error.to_string())?;

    tx.commit().await.map_err(|error| error.to_string())
}

/// Stores a document under its own id. An existing record keeps its name,
/// creation time and list thumbnail and only takes the new content.
#[tauri::command]
pub async fn documents_upsert(
    db: State<'_, DocumentsDb>,
    request: Request<'_>,
) -> Result<(), String> {
    let body = request_bytes(&request)?;
    let (input, blobs) = read_envelope::<UpsertIn>(&body)?;
    let mut tx = db.pool.begin().await.map_err(|error| error.to_string())?;

    sqlx::query(
        "INSERT INTO documentMeta (id, name, createdAt, updatedAt, thumbnail) VALUES (?, ?, ?, ?, NULL) ON CONFLICT(id) DO UPDATE SET updatedAt = excluded.updatedAt",
    )
    .bind(&input.id)
    .bind(&input.name)
    .bind(input.now)
    .bind(input.now)
    .execute(&mut *tx)
    .await
    .map_err(|error| error.to_string())?;

    sqlx::query(
        "INSERT OR REPLACE INTO documentData (id, document, thumbnail, createdAt) VALUES (?, ?, NULL, ?)",
    )
    .bind(&input.id)
    .bind(blob(blobs, input.document)?)
    .bind(input.now)
    .execute(&mut *tx)
    .await
    .map_err(|error| error.to_string())?;

    tx.commit().await.map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn documents_save(
    db: State<'_, DocumentsDb>,
    request: Request<'_>,
) -> Result<(), String> {
    let body = request_bytes(&request)?;
    let (input, blobs) = read_envelope::<SaveIn>(&body)?;
    let thumbnail = blob_optional(blobs, input.thumbnail)?;
    let mut tx = db.pool.begin().await.map_err(|error| error.to_string())?;

    if input.replace_meta_thumbnail {
        sqlx::query("UPDATE documentMeta SET updatedAt = ?, thumbnail = ? WHERE id = ?")
            .bind(input.now)
            .bind(thumbnail)
            .bind(&input.id)
            .execute(&mut *tx)
            .await
    } else {
        sqlx::query("UPDATE documentMeta SET updatedAt = ? WHERE id = ?")
            .bind(input.now)
            .bind(&input.id)
            .execute(&mut *tx)
            .await
    }
    .map_err(|error| error.to_string())?;

    sqlx::query(
        "INSERT OR REPLACE INTO documentData (id, document, thumbnail, createdAt) VALUES (?, ?, ?, ?)",
    )
    .bind(&input.id)
    .bind(blob(blobs, input.document)?)
    .bind(thumbnail)
    .bind(input.now)
    .execute(&mut *tx)
    .await
    .map_err(|error| error.to_string())?;

    tx.commit().await.map_err(|error| error.to_string())
}

/// Records a revision, makes it the document's current content and drops all
/// but the newest `keep_count` revisions of that document.
#[tauri::command]
pub async fn documents_add_revision(
    db: State<'_, DocumentsDb>,
    request: Request<'_>,
) -> Result<(), String> {
    let body = request_bytes(&request)?;
    let (input, blobs) = read_envelope::<AddRevisionIn>(&body)?;
    let document = blob(blobs, input.document)?;
    let thumbnail = blob_optional(blobs, input.thumbnail)?;
    let mut tx = db.pool.begin().await.map_err(|error| error.to_string())?;

    sqlx::query(
        "INSERT INTO documentRevisions (id, documentId, document, thumbnail, createdAt) VALUES (?, ?, ?, ?, ?)",
    )
    .bind(&input.id)
    .bind(&input.document_id)
    .bind(document)
    .bind(thumbnail)
    .bind(input.created_at)
    .execute(&mut *tx)
    .await
    .map_err(|error| error.to_string())?;

    sqlx::query(
        "INSERT OR REPLACE INTO documentData (id, document, thumbnail, createdAt) VALUES (?, ?, ?, ?)",
    )
    .bind(&input.document_id)
    .bind(document)
    .bind(thumbnail)
    .bind(input.created_at)
    .execute(&mut *tx)
    .await
    .map_err(|error| error.to_string())?;

    sqlx::query("UPDATE documentMeta SET updatedAt = ?, thumbnail = ? WHERE id = ?")
        .bind(input.created_at)
        .bind(thumbnail)
        .bind(&input.document_id)
        .execute(&mut *tx)
        .await
        .map_err(|error| error.to_string())?;

    sqlx::query(
        "DELETE FROM documentRevisions WHERE documentId = ?1 AND id NOT IN (SELECT id FROM documentRevisions WHERE documentId = ?1 ORDER BY createdAt DESC LIMIT ?2)",
    )
    .bind(&input.document_id)
    .bind(input.keep_count)
    .execute(&mut *tx)
    .await
    .map_err(|error| error.to_string())?;

    tx.commit().await.map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn documents_delete(db: State<'_, DocumentsDb>, id: String) -> Result<(), String> {
    let mut tx = db.pool.begin().await.map_err(|error| error.to_string())?;
    for statement in [
        "DELETE FROM documentMeta WHERE id = ?",
        "DELETE FROM documentData WHERE id = ?",
        "DELETE FROM documentRevisions WHERE documentId = ?",
    ] {
        sqlx::query(statement)
            .bind(&id)
            .execute(&mut *tx)
            .await
            .map_err(|error| error.to_string())?;
    }
    tx.commit().await.map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn documents_rename(
    db: State<'_, DocumentsDb>,
    id: String,
    name: String,
) -> Result<(), String> {
    sqlx::query("UPDATE documentMeta SET name = ? WHERE id = ?")
        .bind(name)
        .bind(id)
        .execute(&db.pool)
        .await
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[derive(Default)]
struct EnvelopeWriter {
    blobs: Vec<u8>,
}

impl EnvelopeWriter {
    fn attach(&mut self, bytes: Vec<u8>) -> BlobRef {
        let blob_ref = BlobRef {
            offset: self.blobs.len(),
            length: bytes.len(),
        };
        self.blobs.extend(bytes);
        blob_ref
    }

    fn attach_optional(&mut self, bytes: Option<Vec<u8>>) -> Option<BlobRef> {
        bytes.map(|bytes| self.attach(bytes))
    }

    fn finish<T: Serialize>(self, header: &T) -> Result<Response, String> {
        let header = serde_json::to_vec(header).map_err(|error| error.to_string())?;
        let header_length = u32::try_from(header.len()).map_err(|error| error.to_string())?;
        let mut bytes = Vec::with_capacity(4 + header.len() + self.blobs.len());
        bytes.extend(header_length.to_le_bytes());
        bytes.extend(header);
        bytes.extend(self.blobs);
        Ok(Response::new(bytes))
    }
}

fn request_bytes<'a>(request: &'a Request<'_>) -> Result<Cow<'a, [u8]>, String> {
    match request.body() {
        InvokeBody::Raw(bytes) => Ok(Cow::Borrowed(bytes)),
        // The postMessage IPC, which Tauri falls back to when the webview
        // blocks the custom protocol, sends the bytes as a JSON number array.
        InvokeBody::Json(value) => Vec::<u8>::deserialize(value)
            .map(Cow::Owned)
            .map_err(|error| error.to_string()),
    }
}

fn read_envelope<T: for<'de> Deserialize<'de>>(bytes: &[u8]) -> Result<(T, &[u8]), String> {
    let (length, rest) = bytes
        .split_first_chunk::<4>()
        .ok_or_else(|| "Envelope is shorter than its header length".to_owned())?;
    let header_length = u32::from_le_bytes(*length) as usize;
    if rest.len() < header_length {
        return Err("Envelope is shorter than its header".to_owned());
    }
    let (header, blobs) = rest.split_at(header_length);
    let header = serde_json::from_slice(header).map_err(|error| error.to_string())?;
    Ok((header, blobs))
}

fn blob(blobs: &[u8], blob_ref: BlobRef) -> Result<&[u8], String> {
    blob_ref
        .offset
        .checked_add(blob_ref.length)
        .and_then(|end| blobs.get(blob_ref.offset..end))
        .ok_or_else(|| "Blob reference is outside the envelope".to_owned())
}

fn blob_optional(blobs: &[u8], blob_ref: Option<BlobRef>) -> Result<Option<&[u8]>, String> {
    blob_ref.map(|blob_ref| blob(blobs, blob_ref)).transpose()
}

fn meta_out(row: &SqliteRow, envelope: &mut EnvelopeWriter) -> Result<MetaOut, String> {
    Ok(MetaOut {
        id: get(row, "id")?,
        name: get(row, "name")?,
        created_at: get(row, "createdAt")?,
        updated_at: get(row, "updatedAt")?,
        thumbnail: envelope.attach_optional(get(row, "thumbnail")?),
    })
}

fn get<'r, T: sqlx::Decode<'r, sqlx::Sqlite> + sqlx::Type<sqlx::Sqlite>>(
    row: &'r SqliteRow,
    column: &str,
) -> Result<T, String> {
    row.try_get(column).map_err(|error| error.to_string())
}

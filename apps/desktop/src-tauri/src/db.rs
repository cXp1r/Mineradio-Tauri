//! SQLite本地存储模块
//! 提供数据库初始化、模式迁移和基本读/写

use rusqlite::{Connection, OptionalExtension};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

/// 解析数据库路径
fn resolve_db_path(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join("mineradio.db")
}

fn open_connection(db_path: &Path) -> rusqlite::Result<Connection> {
    let conn = Connection::open(db_path)?;
    conn.busy_timeout(Duration::from_secs(5))?;
    Ok(conn)
}

fn run_migrations(conn: &Connection) -> rusqlite::Result<()> {
    // 确保 _migrations 表本身存在
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS _migrations (
            version INTEGER PRIMARY KEY,
            name    TEXT NOT NULL,
            applied_at TEXT NOT NULL DEFAULT (datetime('now'))
        );",
    )?;

    // 查出已执行过的最大 version
    let latest: i64 = conn.query_row(
        "SELECT COALESCE(MAX(version), 0) FROM _migrations",
        [],
        |row| row.get(0),
    )?;

    // 从 latest+1 开始,逐个执行未应用的迁移
    apply_migration(conn, 1, "create_kv_store", latest < 1)?;
    apply_migration(conn, 2, "create_listen_history", latest < 2)?;

    Ok(())
}

fn apply_migration(
    conn: &Connection,
    version: i64,
    name: &str,
    should_apply: bool,
) -> rusqlite::Result<()> {
    if !should_apply {
        return Ok(());
    }
    let sql = match version {
        1 => MIGRATION_V1_SQL,
        2 => MIGRATION_V2_SQL,
        _ => {
            return Err(rusqlite::Error::ToSqlConversionFailure(
                format!("unknown migration version: {version}").into(),
            ))
        }
    };
    let tx = conn.unchecked_transaction()?;
    let claimed = tx.execute(
        "INSERT OR IGNORE INTO _migrations (version, name) VALUES (?1, ?2)",
        rusqlite::params![version, name],
    )?;
    if claimed == 0 {
        tx.commit()?;
        return Ok(());
    }
    tx.execute_batch(sql)?;
    tx.commit()?;
    Ok(())
}

const MIGRATION_V1_SQL: &str = r#"
    CREATE TABLE IF NOT EXISTS kv_store (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
"#;

const MIGRATION_V2_SQL: &str = r#"
    CREATE TABLE IF NOT EXISTS listen_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        song_key TEXT NOT NULL,
        name TEXT NOT NULL,
        artist TEXT NOT NULL,
        cover TEXT,
        source TEXT,
        played_at TEXT NOT NULL DEFAULT (datetime('now')),
        listen_ms INTEGER NOT NULL DEFAULT 0,
        completed INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_listen_history_song ON listen_history(song_key);
    CREATE INDEX IF NOT EXISTS idx_listen_history_played ON listen_history(played_at);
"#;

fn get_kv(conn: &Connection, key: &str) -> rusqlite::Result<Option<String>> {
    conn.query_row("SELECT value FROM kv_store WHERE key = ?1", [key], |row| {
        row.get(0)
    })
    .optional()
}

/// 写入 kv_store;当前生产路径暂无通用 KV command,保留给后续设置迁移复用。
#[allow(dead_code)]
fn set_kv(conn: &Connection, key: &str, value: &str) -> rusqlite::Result<()> {
    let tx = conn.unchecked_transaction()?;
    tx.execute(
        "INSERT INTO kv_store (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now');",
        [key, value],
    )?;
    tx.commit()?;
    Ok(())
}

/// 记录一次收听历史到 listen_history 表。
///
/// 当前未被任何 Tauri command 引用,保留 pub 是为后续"听歌统计上报"
/// 留出入口,本次 issue 不接入前端。`#[allow]` 抑制 dead_code 警告。
// 这些参数逐一映射 listen_history 数据库列，显式签名便于核对写入顺序。
#[allow(dead_code, clippy::too_many_arguments)]
pub fn add_listen_history(
    conn: &Connection,
    song_key: &str,
    name: &str,
    artist: &str,
    cover: Option<&str>,
    source: Option<&str>,
    listen_ms: i64,
    completed: bool,
) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO listen_history
            (song_key, name, artist, cover, source, listen_ms, completed)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        rusqlite::params![
            song_key,
            name,
            artist,
            cover,
            source,
            listen_ms,
            completed as i64
        ],
    )?;
    Ok(())
}

fn current_migration_version(conn: &Connection) -> rusqlite::Result<i64> {
    conn.query_row(
        "SELECT COALESCE(MAX(version), 0) FROM _migrations",
        [],
        |row| row.get(0),
    )
}

fn get_startup_count(conn: &Connection) -> rusqlite::Result<i64> {
    match get_kv(conn, "startup_count")? {
        Some(value) => value
            .parse::<i64>()
            .map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e))),
        None => Ok(0),
    }
}

fn increment_startup_count(conn: &Connection) -> rusqlite::Result<i64> {
    conn.query_row(
        "INSERT INTO kv_store (key, value) VALUES ('startup_count', '1')
         ON CONFLICT(key) DO UPDATE SET
             value = CAST(CAST(kv_store.value AS INTEGER) + 1 AS TEXT),
             updated_at = datetime('now')
         RETURNING CAST(value AS INTEGER)",
        [],
        |row| row.get(0),
    )
}

/// 数据库运行时状态:把连接和它在磁盘上的路径打包在一起。
///
/// 把 path 也放在这里,调用方(Tauri AppState、诊断命令)就能直接报告
/// 当前数据库位置,不用再重新算一次
pub struct DbRuntimeState {
    pub conn: Connection,
    pub path: PathBuf,
}

/// 为 Tauri 运行时初始化本地 SQLite 数据库
///
/// 步骤:
/// 1. 确保 `app_data_dir` 目录存在
/// 2. 算出数据库文件路径
/// 3. 打开连接(不存在则自动创建)
/// 4. 执行所有未应用的迁移
/// 5. 递增启动计数 `startup_count`
///
/// 返回连接和它的磁盘路径
pub fn initialize(app_data_dir: &Path) -> rusqlite::Result<DbRuntimeState> {
    fs::create_dir_all(app_data_dir)
        .map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))?;
    let path = resolve_db_path(app_data_dir);
    let conn = open_connection(&path)?;
    run_migrations(&conn)?;
    increment_startup_count(&conn)?;
    Ok(DbRuntimeState { conn, path })
}

/// 数据库诊断快照,供 Tauri command 返回给前端。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseStatus {
    /// 数据库文件的绝对路径,前端可用于"数据存放在哪"展示。
    pub path: String,
    /// 来自 _migrations 表的 MAX(version);0 表示从未跑过迁移。
    pub migration_version: i64,
    /// 自增的启动计数器,只用于诊断,不应作为业务判断依据。
    pub startup_count: i64,
}

/// 读取数据库的诊断信息。
///
/// 是 `get_database_status` command 的纯函数核心,方便单测。
pub fn build_database_status(conn: &Connection, path: &Path) -> rusqlite::Result<DatabaseStatus> {
    Ok(DatabaseStatus {
        path: path.to_string_lossy().to_string(),
        migration_version: current_migration_version(conn)?,
        startup_count: get_startup_count(conn)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fresh_db() -> Connection {
        Connection::open_in_memory().unwrap()
    }

    #[test]
    fn test_resolve_db_path() {
        let app_data_dir = Path::new("/path/to/app/data");
        let expected_path = Path::new("/path/to/app/data/mineradio.db");
        assert_eq!(resolve_db_path(app_data_dir), expected_path);
    }

    #[test]
    fn test_open_connection() {
        let db_path = Path::new(":memory:"); // 使用内存数据库进行测试
        let conn_result: Result<Connection, rusqlite::Error> = open_connection(db_path);
        assert!(conn_result.is_ok());
    }

    #[test]
    fn migrations_creates_tables() {
        let conn = fresh_db();
        // 在全新内存数据库上执行全部迁移，验证不会报错
        assert!(run_migrations(&conn).is_ok());
        let result = conn.execute_batch("SELECT COUNT(*) FROM _migrations");
        assert!(result.is_ok());
    }

    #[test]
    fn test_migrations_is_idempotent() {
        let conn = fresh_db();
        assert!(run_migrations(&conn).is_ok());
        // 再次运行迁移，确保不会出错
        let result = run_migrations(&conn);
        assert!(result.is_ok());
    }

    #[test]
    fn apply_migration_skips_when_version_is_already_recorded() {
        let conn = fresh_db();
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS _migrations (
                version INTEGER PRIMARY KEY,
                name    TEXT NOT NULL,
                applied_at TEXT NOT NULL DEFAULT (datetime('now'))
            );
            INSERT INTO _migrations (version, name) VALUES (2, 'create_listen_history');",
        )
        .unwrap();

        apply_migration(&conn, 2, "create_listen_history", true).unwrap();

        let table_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'listen_history'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(table_count, 0);
    }

    #[test]
    fn test_get_kv_missing_key_returns_none() {
        let conn = fresh_db();
        run_migrations(&conn).unwrap();
        let result = get_kv(&conn, "nope");
        assert_eq!(result.unwrap(), None);
    }

    #[test]
    fn test_set_and_get_kv() {
        let conn = fresh_db();
        run_migrations(&conn).unwrap();
        set_kv(&conn, "test_key", "hello").unwrap();
        let result = get_kv(&conn, "test_key");
        assert_eq!(result.unwrap(), Some("hello".to_string()));
    }

    #[test]
    // 测试 set_kv 是否会覆盖已有的键值
    fn test_set_kv_overwrites() {
        let conn = fresh_db();
        run_migrations(&conn).unwrap();
        set_kv(&conn, "test_key", "hello").unwrap();
        set_kv(&conn, "test_key", "world").unwrap();
        let result = get_kv(&conn, "test_key");
        assert_eq!(result.unwrap(), Some("world".to_string()));
    }

    #[test]
    fn test_v2_migration_creates_listen_history() {
        let conn = fresh_db();
        assert!(run_migrations(&conn).is_ok());
        // 检查 listen_history 表是否存在
        let result = conn.execute_batch("SELECT COUNT(*) FROM listen_history");
        assert!(result.is_ok());
    }

    #[test]
    fn test_add_listen_history_inserts_row() {
        let conn = fresh_db();
        run_migrations(&conn).unwrap();

        add_listen_history(
            &conn,
            "id:123",
            "歌名",
            "歌手",
            Some("https://example.com/cover.jpg"), // cover 有值
            Some("netease"),                       // source 有值
            30000,                                 // 听了 30 秒
            false,                                 // 没听完
        )
        .unwrap();

        // 查询:listen_history 表里应该有 1 行
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM listen_history", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 1);
    }

    #[test]
    fn test_get_startup_count_returns_zero_when_empty() {
        let conn: Connection = fresh_db();
        run_migrations(&conn).unwrap();
        let count = get_startup_count(&conn).unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn test_increment_startup_count_increments() {
        let conn = fresh_db();
        run_migrations(&conn).unwrap();

        // 调一次: 0 → 1
        let after_first = increment_startup_count(&conn).unwrap();
        assert_eq!(after_first, 1);

        // 再调一次: 1 → 2 (这才是"递增"的关键)
        let after_second = increment_startup_count(&conn).unwrap();
        assert_eq!(after_second, 2);
    }

    #[test]
    fn increment_startup_count_handles_parallel_connections() {
        use std::sync::{Arc, Barrier};
        use std::thread;

        let temp_dir = std::env::temp_dir();
        let db_path = temp_dir.join(format!(
            "mineradio-test-count-{}-{}.db",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let _ = std::fs::remove_file(&db_path);

        let setup_conn = open_connection(&db_path).unwrap();
        run_migrations(&setup_conn).unwrap();
        drop(setup_conn);

        let workers = 8;
        let iterations = 8;
        let barrier = Arc::new(Barrier::new(workers));
        let mut handles = Vec::new();
        for _ in 0..workers {
            let path = db_path.clone();
            let start = Arc::clone(&barrier);
            handles.push(thread::spawn(move || {
                let conn = open_connection(&path).unwrap();
                start.wait();
                for _ in 0..iterations {
                    increment_startup_count(&conn).unwrap();
                }
            }));
        }

        for handle in handles {
            handle.join().unwrap();
        }

        let conn = open_connection(&db_path).unwrap();
        let count = get_startup_count(&conn).unwrap();
        let _ = std::fs::remove_file(&db_path);
        assert_eq!(count, (workers * iterations) as i64);
    }

    #[test]
    fn test_current_migration_version_returns_max() {
        // 先跑迁移,让 _migrations 表存在
        let conn = fresh_db();
        run_migrations(&conn).unwrap();

        // 跑过迁移: 应该返回最大 version
        let v = current_migration_version(&conn).unwrap();
        assert!(v >= 1);
    }

    #[test]
    fn initialize_creates_db_and_increments_count() {
        let temp_dir = std::env::temp_dir().join("mineradio-test-init-1");
        let _ = std::fs::remove_dir_all(&temp_dir);

        let state = initialize(&temp_dir).expect("initialize ok");

        assert!(state.path.exists());

        let count = get_startup_count(&state.conn).expect("read count");
        assert_eq!(count, 1);
    }

    #[test]
    fn initialize_twice_increments_count() {
        let temp_dir = std::env::temp_dir().join("mineradio-test-init-2");
        let _ = std::fs::remove_dir_all(&temp_dir);

        let _ = initialize(&temp_dir).unwrap();
        let state = initialize(&temp_dir).unwrap();

        let count = get_startup_count(&state.conn).expect("read count");
        assert_eq!(count, 2);
    }

    #[test]
    fn build_database_status_reports_path_version_and_count() {
        let conn = fresh_db();
        run_migrations(&conn).unwrap();
        let path = std::env::temp_dir().join("mineradio-test-status.db");

        let status = build_database_status(&conn, &path).expect("build status");

        assert_eq!(status.path, path.to_string_lossy().to_string());
        assert!(status.migration_version >= 1);
        assert_eq!(status.startup_count, 0);
    }
}

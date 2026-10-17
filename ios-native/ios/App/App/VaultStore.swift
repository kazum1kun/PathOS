import Foundation
import SQLite3

private let sqliteTransient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

/// Called only on the bridge's serial storage queue. SQLite owns transaction
/// atomicity; asset directories are immutable and written before their rows commit.
final class VaultStore {
    private let suppliedRoot: URL?
    private var root: URL!
    private var assets: URL!
    private var database: OpaquePointer?
    private var token: String?
    private var stores = Set<String>()
    private var writable = false
    private var created = Set<String>()
    private var obsolete = Set<String>()
    private let allowedStores: Set<String> = ["games", "versions", "saves", "profiles"]

    init(rootURL: URL? = nil) { suppliedRoot = rootURL }
    deinit { sqlite3_close(database) }

    func handle(_ request: [String: Any]) throws -> Any {
        let operation = request["operation"] as? String ?? ""
        if operation == "open" {
            try open()
            if token != nil { try rollback() }
            try removeOrphans()
            return ["migrated": !(try rows("SELECT value FROM metadata WHERE key = 'indexeddb-migrated'")).isEmpty]
        }
        guard database != nil else { throw failure("Native storage is not open.") }
        if operation == "info" { return try storageInfo() }
        if operation == "begin" {
            guard token == nil, let names = request["stores"] as? [String], !names.isEmpty,
                  Set(names).isSubset(of: allowedStores),
                  let mode = request["mode"] as? String, ["readonly", "readwrite"].contains(mode) else {
                throw failure("The library is busy or the transaction is invalid. Try again.")
            }
            try execute(mode == "readwrite" ? "BEGIN IMMEDIATE" : "BEGIN")
            let nextToken = UUID().uuidString
            token = nextToken; stores = Set(names); writable = mode == "readwrite"
            return ["token": nextToken]
        }
        guard let suppliedToken = request["token"] as? String, suppliedToken == token else {
            throw failure("This library transaction has expired. Reopen PathOS.")
        }
        if operation == "commit" {
            try execute("COMMIT")
            let garbage = obsolete
            resetTransaction()
            for directory in garbage { try? FileManager.default.removeItem(at: assets.appendingPathComponent(directory)) }
            return NSNull()
        }
        if operation == "rollback" { try rollback(); return NSNull() }
        if operation == "markMigrated" {
            guard writable, stores == allowedStores else { throw failure("Migration requires a full library transaction.") }
            try execute("INSERT OR REPLACE INTO metadata(key, value) VALUES ('indexeddb-migrated', '1')")
            return NSNull()
        }
        guard let store = request["store"] as? String, stores.contains(store) else { throw failure("Invalid library store.") }
        switch operation {
        case "get":
            guard let key = request["key"] as? String else { throw failure("Missing record ID.") }
            let found = try rows("SELECT body, asset_directory FROM records WHERE store = ? AND key = ?", [store, key])
            if let row = found.first { return try decode(row, store: store) }
            return NSNull()
        case "getAll", "getAllKeys":
            var sql = operation == "getAllKeys" ? "SELECT key FROM records WHERE store = ?" : "SELECT body, asset_directory FROM records WHERE store = ?"
            var values = [store]
            if let index = request["index"] as? String {
                let column: String
                if index == "gameId", ["versions", "saves"].contains(store) { column = "game_id" }
                else if index == "versionId", store == "saves" { column = "version_id" }
                else { throw failure("Invalid library index.") }
                if let key = request["key"] as? String { sql += " AND \(column) = ?"; values.append(key) }
            }
            let found = try rows(sql + " ORDER BY key", values)
            if operation == "getAllKeys" { return found.compactMap { $0["key"] } }
            return try found.map { try decode($0, store: store) }
        case "put":
            guard writable, let record = request["record"] as? [String: Any],
                  let key = record["id"] as? String, !key.isEmpty else { throw failure("Invalid library record.") }
            try put(record, store: store, key: key)
            return NSNull()
        case "delete":
            guard writable, let key = request["key"] as? String else { throw failure("Invalid library deletion.") }
            try retireAssets(store: store, key: key)
            try execute("DELETE FROM records WHERE store = ? AND key = ?", [store, key])
            return NSNull()
        default: throw failure("Unknown native storage operation.")
        }
    }

    private func open() throws {
        if database != nil { return }
        let manager = FileManager.default
        root = try suppliedRoot ?? manager.url(for: .applicationSupportDirectory, in: .userDomainMask,
                                               appropriateFor: nil, create: true).appendingPathComponent("PathOS", isDirectory: true)
        assets = root.appendingPathComponent("Assets", isDirectory: true)
        try manager.createDirectory(at: assets, withIntermediateDirectories: true)
        #if os(iOS)
        try manager.setAttributes([.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: root.path)
        try manager.setAttributes([.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: assets.path)
        #endif
        // User-imported games cannot be fetched again by PathOS. Include them and
        // saves in normal device backup; this is not an iCloud sync service.
        var backupRoot = root!
        var backupValues = URLResourceValues(); backupValues.isExcludedFromBackup = false
        try backupRoot.setResourceValues(backupValues)
        let file = root.appendingPathComponent("library.sqlite")
        guard sqlite3_open_v2(file.path, &database, SQLITE_OPEN_CREATE | SQLITE_OPEN_READWRITE | SQLITE_OPEN_FULLMUTEX, nil) == SQLITE_OK else {
            let error = databaseError(); sqlite3_close(database); database = nil; throw error
        }
        do {
            sqlite3_busy_timeout(database, 5000)
            let version = Int(try rows("PRAGMA user_version").first?["user_version"] ?? "0") ?? 0
            guard version <= 1 else { throw failure("This library needs a newer version of PathOS.") }
            try execute("PRAGMA journal_mode = WAL")
            try execute("PRAGMA synchronous = FULL")
            try execute("CREATE TABLE IF NOT EXISTS records (store TEXT NOT NULL, key TEXT NOT NULL, game_id TEXT, version_id TEXT, body TEXT NOT NULL, asset_directory TEXT NOT NULL DEFAULT '', PRIMARY KEY (store, key))")
            try execute("CREATE INDEX IF NOT EXISTS records_game ON records(store, game_id)")
            try execute("CREATE INDEX IF NOT EXISTS records_version ON records(store, version_id)")
            try execute("CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
            try execute("PRAGMA user_version = 1")
        } catch { sqlite3_close(database); database = nil; throw error }
    }

    private func put(_ record: [String: Any], store: String, key: String) throws {
        var body = record
        var directory = ""
        if store == "versions" {
            guard var files = record["files"] as? [[String: Any]], !files.isEmpty else { throw failure("A game version has no files.") }
            directory = UUID().uuidString
            let folder = assets.appendingPathComponent(directory, isDirectory: true)
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            created.insert(directory)
            for index in files.indices {
                guard let base64 = files[index]["data"] as? String, let data = Data(base64Encoded: base64) else { throw failure("Invalid game file data.") }
                let filename = String(index)
                let url = folder.appendingPathComponent(filename)
                #if os(iOS)
                try data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
                #else
                try data.write(to: url, options: .atomic)
                #endif
                let handle = try FileHandle(forWritingTo: url)
                do { try handle.synchronize(); try handle.close() }
                catch { try? handle.close(); throw error }
                files[index].removeValue(forKey: "data")
                files[index]["asset"] = filename
            }
            body["files"] = files
        }
        let json = try JSONSerialization.data(withJSONObject: body, options: [.sortedKeys, .fragmentsAllowed])
        guard let text = String(data: json, encoding: .utf8) else { throw failure("Invalid library text.") }
        try retireAssets(store: store, key: key)
        try execute("INSERT OR REPLACE INTO records(store, key, game_id, version_id, body, asset_directory) VALUES (?, ?, ?, ?, ?, ?)",
                    [store, key, record["gameId"] as? String ?? "", record["versionId"] as? String ?? "", text, directory])
    }

    private func decode(_ row: [String: String], store: String) throws -> [String: Any] {
        guard let text = row["body"], let data = text.data(using: .utf8),
              var record = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw failure("A library record is damaged. Restore a backup.") }
        if store == "versions" {
            guard let directory = row["asset_directory"], UUID(uuidString: directory) != nil,
                  var files = record["files"] as? [[String: Any]] else { throw failure("A game file list is damaged.") }
            for index in files.indices {
                guard files[index]["asset"] as? String == String(index) else { throw failure("Invalid game asset reference.") }
                let url = assets.appendingPathComponent(directory).appendingPathComponent(String(index))
                files[index]["data"] = try Data(contentsOf: url).base64EncodedString()
                files[index].removeValue(forKey: "asset")
            }
            record["files"] = files
        }
        return record
    }

    private func retireAssets(store: String, key: String) throws {
        for row in try rows("SELECT asset_directory FROM records WHERE store = ? AND key = ?", [store, key]) {
            if let directory = row["asset_directory"], UUID(uuidString: directory) != nil { obsolete.insert(directory) }
        }
    }

    private func rollback() throws {
        // Disk-full errors may have already rolled SQLite back automatically.
        if sqlite3_get_autocommit(database) == 0 { try execute("ROLLBACK") }
        let garbage = created
        resetTransaction()
        for directory in garbage { try? FileManager.default.removeItem(at: assets.appendingPathComponent(directory)) }
    }

    private func resetTransaction() {
        token = nil; stores.removeAll(); writable = false; created.removeAll(); obsolete.removeAll()
    }

    private func removeOrphans() throws {
        let referenced = Set(try rows("SELECT asset_directory FROM records WHERE asset_directory != ''").compactMap { $0["asset_directory"] })
        for url in try FileManager.default.contentsOfDirectory(at: assets, includingPropertiesForKeys: nil) {
            if UUID(uuidString: url.lastPathComponent) != nil, !referenced.contains(url.lastPathComponent) { try? FileManager.default.removeItem(at: url) }
        }
    }

    private func storageInfo() throws -> [String: Any] {
        var usage: Int64 = 0
        if let files = FileManager.default.enumerator(at: root, includingPropertiesForKeys: [.fileSizeKey, .isRegularFileKey]) {
            for case let url as URL in files {
                let values = try url.resourceValues(forKeys: [.fileSizeKey, .isRegularFileKey])
                if values.isRegularFile == true { usage += Int64(values.fileSize ?? 0) }
            }
        }
        let values = try root.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey])
        return ["usage": usage, "available": values.volumeAvailableCapacityForImportantUsage ?? 0]
    }

    private func statement(_ sql: String, _ values: [String]) throws -> OpaquePointer {
        var prepared: OpaquePointer?
        guard sqlite3_prepare_v2(database, sql, -1, &prepared, nil) == SQLITE_OK, let result = prepared else { throw databaseError() }
        for (offset, value) in values.enumerated() {
            let code = value.withCString { sqlite3_bind_text(result, Int32(offset + 1), $0, Int32(value.utf8.count), sqliteTransient) }
            if code != SQLITE_OK { sqlite3_finalize(result); throw databaseError() }
        }
        return result
    }

    private func execute(_ sql: String, _ values: [String] = []) throws {
        let prepared = try statement(sql, values); defer { sqlite3_finalize(prepared) }
        var code = sqlite3_step(prepared)
        while code == SQLITE_ROW { code = sqlite3_step(prepared) }
        guard code == SQLITE_DONE else { throw databaseError() }
    }

    private func rows(_ sql: String, _ values: [String] = []) throws -> [[String: String]] {
        let prepared = try statement(sql, values); defer { sqlite3_finalize(prepared) }
        var result = [[String: String]]()
        var code = sqlite3_step(prepared)
        while code == SQLITE_ROW {
            var row = [String: String]()
            for index in 0..<sqlite3_column_count(prepared) {
                if let text = sqlite3_column_text(prepared, index) { row[String(cString: sqlite3_column_name(prepared, index))] = String(decoding: UnsafeBufferPointer(start: text, count: Int(sqlite3_column_bytes(prepared, index))), as: UTF8.self) }
            }
            result.append(row); code = sqlite3_step(prepared)
        }
        guard code == SQLITE_DONE else { throw databaseError() }
        return result
    }

    private func databaseError() -> NSError {
        if sqlite3_errcode(database) == SQLITE_FULL { return failure("Device storage is full. Free some space and try again.") }
        return failure(database.map { String(cString: sqlite3_errmsg($0)) } ?? "Native storage could not be opened.")
    }

    private func failure(_ message: String) -> NSError { NSError(domain: "PathOS.Storage", code: 1, userInfo: [NSLocalizedDescriptionKey: message]) }
}

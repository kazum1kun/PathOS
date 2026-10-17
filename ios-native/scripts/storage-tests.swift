import Foundation

/// Compile alongside the actual VaultStore on macOS; no WebView or mock SQL.
@main struct StorageTests {
    static func require(_ condition: @autoclosure () -> Bool, _ message: String) throws {
        if !condition() { throw NSError(domain: "PathOS.StorageTests", code: 1, userInfo: [NSLocalizedDescriptionKey: message]) }
    }

    static func rejects(_ action: () throws -> Void) throws {
        do { try action() } catch { return }
        try require(false, "Expected the native operation to fail")
    }

    static func begin(_ store: VaultStore, _ mode: String = "readwrite") throws -> String {
        let result = try store.handle(["operation": "begin", "mode": mode, "stores": ["games", "versions", "saves", "profiles"]]) as! [String: String]
        return result["token"]!
    }

    @discardableResult static func call(_ store: VaultStore, _ token: String, _ operation: String, _ fields: [String: Any] = [:]) throws -> Any {
        var request = fields; request["operation"] = operation; request["token"] = token
        return try store.handle(request)
    }

    static func main() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("PathOS-StorageTests-" + UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        var store: VaultStore? = VaultStore(rootURL: root)
        let status = try store!.handle(["operation": "open"]) as! [String: Bool]
        try require(status["migrated"] == false, "New library must need migration")
        let bytes = Data([0, 255, 128, 1])
        let version: [String: Any] = ["id": "v", "gameId": "g", "files": [["path": "../untrusted-name", "data": bytes.base64EncodedString(), "mime": "application/octet-stream"]]]
        var token = try begin(store!)
        try call(store!, token, "put", ["store": "games", "record": ["id": "g", "title": "Story"]])
        try call(store!, token, "put", ["store": "versions", "record": version])
        try call(store!, token, "markMigrated")
        try call(store!, token, "commit")
        let assetRoot = root.appendingPathComponent("Assets")
        let folders = try FileManager.default.contentsOfDirectory(at: assetRoot, includingPropertiesForKeys: nil)
        try require(folders.count == 1, "One immutable asset directory must be stored")
        let asset = folders[0].appendingPathComponent("0")
        let diskBytes = try Data(contentsOf: asset)
        try require(diskBytes == bytes, "Game bytes must live in native files")
        store = nil
        store = VaultStore(rootURL: root)
        let reopened = try store!.handle(["operation": "open"]) as! [String: Bool]
        try require(reopened["migrated"] == true, "Migration marker must survive a reopen")
        token = try begin(store!, "readonly")
        let restored = try call(store!, token, "get", ["store": "versions", "key": "v"]) as! [String: Any]
        let restoredFiles = restored["files"] as! [[String: Any]]
        try require(restoredFiles[0]["data"] as? String == bytes.base64EncodedString(), "Read must round-trip binary assets")
        try rejects { try call(store!, token, "delete", ["store": "games", "key": "g"]) }
        try rejects { try call(store!, "stale-token", "get", ["store": "games", "key": "g"]) }
        try call(store!, token, "commit")

        // A failed asset write rolls back record changes and removes partial files.
        token = try begin(store!)
        try call(store!, token, "put", ["store": "games", "record": ["id": "g", "title": "Must roll back"]])
        var broken = version
        broken["files"] = [["data": bytes.base64EncodedString()], ["data": "invalid base64!"]]
        try rejects { try call(store!, token, "put", ["store": "versions", "record": broken]) }
        try call(store!, token, "rollback")
        let afterFailure = try FileManager.default.contentsOfDirectory(at: assetRoot, includingPropertiesForKeys: nil)
        try require(afterFailure.count == 1, "Rollback must remove partially written asset directories")
        token = try begin(store!)
        let game = try call(store!, token, "get", ["store": "games", "key": "g"]) as! [String: Any]
        try require(game["title"] as? String == "Story", "Record writes must roll back together")
        try call(store!, token, "delete", ["store": "versions", "key": "v"])
        try call(store!, token, "rollback")
        try require(FileManager.default.fileExists(atPath: asset.path), "Rolled-back deletion must retain assets")

        // Simulate process termination during an uncommitted import. SQLite
        // rolls back on close; the next open removes the orphaned native files.
        token = try begin(store!)
        var other = version; other["id"] = "uncommitted"
        try call(store!, token, "put", ["store": "versions", "record": other])
        store = nil
        store = VaultStore(rootURL: root)
        _ = try store!.handle(["operation": "open"])
        let recovered = try FileManager.default.contentsOfDirectory(at: assetRoot, includingPropertiesForKeys: nil)
        try require(recovered.count == 1, "Startup must clean abandoned assets without deleting committed files")

        // Ownership queries must work without reading large or unavailable assets.
        try FileManager.default.removeItem(at: asset)
        token = try begin(store!)
        let keys = try call(store!, token, "getAllKeys", ["store": "versions", "index": "gameId", "key": "g"]) as! [String]
        try require(keys == ["v"], "Key-only queries must not read assets or return uncommitted records")
        try call(store!, token, "put", ["store": "saves", "record": ["id": "s", "gameId": "g", "versionId": "v"]])
        try call(store!, token, "commit")
        token = try begin(store!)
        try call(store!, token, "delete", ["store": "versions", "key": "v"])
        try call(store!, token, "commit")
        try require(!FileManager.default.fileExists(atPath: folders[0].path), "Committed deletion must clean up its assets")
        store = nil
        print("Native SQLite/filesystem tests passed: reopen, migration marker, binary assets, rollback, crash recovery, key-only queries, deletion and transaction guards.")
    }
}

import Capacitor
import Foundation
import UIKit
import WebKit

/// The library UI owns the native bridge. Imported game frames never receive native privileges.
final class VaultBridgeViewController: CAPBridgeViewController {
    private var guardedCapacitorHandler: TrustedFrameHandler?
    private var exportHandler: VaultExportHandler?
    private var storageHandler: VaultStorageHandler?
    private var guardedUIDelegate: TrustedUIDelegate?
    private var backgroundSaveTask: UIBackgroundTaskIdentifier = .invalid
    private var exportInProgress = false
    private let exportDirectory = FileManager.default.temporaryDirectory
        .appendingPathComponent("PathOS-Exports", isDirectory: true)

    override func capacitorDidLoad() {
        super.capacitorDidLoad()
        guard let webView = webView, let capacitorBridge = bridge as? CapacitorBridge else { return }
        let controller = webView.configuration.userContentController

        // Capacitor's native transport is normally present in every WKWebView frame.
        // Gate it too, so an imported APK cannot call Http or other native plugins directly.
        let guarded = TrustedFrameHandler(target: capacitorBridge.webViewDelegationHandler)
        guardedCapacitorHandler = guarded
        controller.removeScriptMessageHandler(forName: "bridge")
        controller.add(guarded, name: "bridge")

        // The default delegate also implements a synchronous prompt transport.
        // Keep every native UI path behind the same trusted-frame boundary.
        let uiDelegate = TrustedUIDelegate(target: capacitorBridge.webViewDelegationHandler)
        guardedUIDelegate = uiDelegate
        webView.uiDelegate = uiDelegate

        let exporter = VaultExportHandler(controller: self)
        exportHandler = exporter
        controller.add(exporter, name: "pathosExport")
        let storage = VaultStorageHandler(controller: self)
        storageHandler = storage
        controller.add(storage, name: "pathosStorage")
        controller.addUserScript(WKUserScript(
            source: Self.exportScript,
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        ))

        // These are disposable share-sheet files; durable saves live in Application Support.
        try? FileManager.default.removeItem(at: exportDirectory)
        NotificationCenter.default.addObserver(self, selector: #selector(didEnterBackground),
                                               name: UIApplication.didEnterBackgroundNotification, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(willEnterForeground),
                                               name: UIApplication.willEnterForegroundNotification, object: nil)
    }

    deinit {
        if backgroundSaveTask != .invalid { UIApplication.shared.endBackgroundTask(backgroundSaveTask) }
        NotificationCenter.default.removeObserver(self)
    }

    @objc private func didEnterBackground() {
        finishBackgroundSave()
        backgroundSaveTask = UIApplication.shared.beginBackgroundTask(withName: "Save PathOS library") { [weak self] in
            self?.finishBackgroundSave()
        }
        webView?.evaluateJavaScript("document.dispatchEvent(new Event('vault-native-pause'))", completionHandler: nil)
    }

    fileprivate func finishBackgroundSave() {
        if backgroundSaveTask != .invalid {
            UIApplication.shared.endBackgroundTask(backgroundSaveTask)
            backgroundSaveTask = .invalid
        }
    }

    @objc private func willEnterForeground() {
        webView?.evaluateJavaScript("document.dispatchEvent(new Event('vault-native-resume'))", completionHandler: nil)
    }

    fileprivate func exportFile(_ payload: [String: Any]) {
        guard let requestID = payload["id"] as? String,
              requestID.range(of: "^[A-Za-z0-9_-]{1,80}$", options: .regularExpression) != nil else { return }
        guard !exportInProgress else {
            reply(requestID, error: "Finish the current export before starting another.")
            return
        }
        guard let text = payload["data"] as? String else {
            reply(requestID, error: "The export data is missing.")
            return
        }
        let encoding = payload["encoding"] as? String ?? "utf8"
        let decoded = encoding == "base64" ? Data(base64Encoded: text) : encoding == "utf8" ? text.data(using: .utf8) : nil
        guard let data = decoded, data.count <= 256 * 1024 * 1024 else {
            reply(requestID, error: "The export must contain valid data of at most 256 MB.")
            return
        }
        guard view.window != nil, presentedViewController == nil else {
            reply(requestID, error: "Close the current sheet and try exporting again.")
            return
        }

        let suppliedName = (payload["name"] as? String ?? "pathos-backup.zip") as NSString
        var filename = suppliedName.lastPathComponent
            .components(separatedBy: CharacterSet(charactersIn: "/\\:\u{0}"))
            .joined(separator: "_")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if filename.isEmpty || filename == "." || filename == ".." { filename = "pathos-backup.zip" }
        if filename.utf8.count > 180 { filename = "pathos-backup.zip" }

        let directory = exportDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        let url = directory.appendingPathComponent(filename, isDirectory: false)
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            try data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        } catch {
            try? FileManager.default.removeItem(at: directory)
            reply(requestID, error: error.localizedDescription)
            return
        }

        exportInProgress = true
        let activity = UIActivityViewController(activityItems: [url], applicationActivities: nil)
        if let popover = activity.popoverPresentationController {
            popover.sourceView = view
            popover.sourceRect = CGRect(x: view.bounds.midX, y: view.bounds.maxY - 12, width: 1, height: 1)
            popover.permittedArrowDirections = []
        }
        activity.completionWithItemsHandler = { [weak self] _, completed, _, error in
            DispatchQueue.main.async {
                try? FileManager.default.removeItem(at: directory)
                guard let self = self else { return }
                self.exportInProgress = false
                if let error = error {
                    self.reply(requestID, error: error.localizedDescription)
                } else {
                    self.reply(requestID, result: ["shared": completed, "cancelled": !completed])
                }
            }
        }
        present(activity, animated: true)
    }

    fileprivate func reply(_ id: String, result: Any = [String: Any](), error: String? = nil) {
        var response: [String: Any] = ["id": id, "ok": error == nil, "result": result]
        if let error = error { response["error"] = error }
        guard let bytes = try? JSONSerialization.data(withJSONObject: response),
              let json = String(data: bytes, encoding: .utf8) else { return }
        webView?.evaluateJavaScript("window.VaultNative?.__settle(\(json))", completionHandler: nil)
    }

    private static let exportScript = #"""
    (() => {
      if (window !== window.top || location.protocol !== 'capacitor:' || location.hostname !== 'localhost' || location.port !== '') return;
      const pending = new Map();
      let counter = 0;
      const api = {
        platform: 'ios',
        storage(request) {
          const id = `storage_${Date.now()}_${++counter}`;
          return new Promise((resolve, reject) => {
            pending.set(id, {resolve, reject});
            try { window.webkit.messageHandlers.pathosStorage.postMessage(JSON.parse(JSON.stringify({...request, id}))); }
            catch (error) { pending.delete(id); reject(error); }
          });
        },
        exportFile({name, data, mime = 'application/json', encoding = 'utf8'}) {
          if (typeof name !== 'string' || typeof data !== 'string') {
            return Promise.reject(new TypeError('Export requires a filename and text data.'));
          }
          if (!['utf8', 'base64'].includes(encoding)) return Promise.reject(new TypeError('Unsupported export encoding.'));
          const id = `export_${Date.now()}_${++counter}`;
          return new Promise((resolve, reject) => {
            pending.set(id, {resolve, reject});
            try {
              window.webkit.messageHandlers.pathosExport.postMessage({id, name, data, mime, encoding});
            } catch (error) {
              pending.delete(id);
              reject(error);
            }
          });
        },
        __settle(response) {
          const call = pending.get(response.id);
          if (!call) return;
          pending.delete(response.id);
          if (response.ok) call.resolve(response.result);
          else call.reject(new Error(response.error || 'Native request failed.'));
        }
      };
      Object.defineProperty(window, 'VaultNative', {value: Object.freeze(api), writable: false, configurable: false});
    })();
    """#
}

/// WKScriptMessageHandler does not inherit a web iframe's sandbox restrictions.
/// Check the frame and exact bundled origin before forwarding any native request.
private func isTrustedLibraryFrame(_ message: WKScriptMessage) -> Bool {
    return isTrustedLibraryFrameInfo(message.frameInfo)
}

private func isTrustedLibraryFrameInfo(_ frame: WKFrameInfo) -> Bool {
    guard frame.isMainFrame,
          let url = frame.request.url,
          url.scheme == "capacitor", url.host == "localhost", url.port == nil else { return false }
    return true
}

private final class TrustedFrameHandler: NSObject, WKScriptMessageHandler {
    private weak var target: WKScriptMessageHandler?

    init(target: WKScriptMessageHandler) {
        self.target = target
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard isTrustedLibraryFrame(message) else { return }
        target?.userContentController(userContentController, didReceive: message)
    }
}

private final class VaultExportHandler: NSObject, WKScriptMessageHandler {
    private weak var controller: VaultBridgeViewController?

    init(controller: VaultBridgeViewController) {
        self.controller = controller
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard isTrustedLibraryFrame(message),
              message.webView === controller?.webView,
              let payload = message.body as? [String: Any] else { return }
        controller?.exportFile(payload)
    }
}

private final class VaultStorageHandler: NSObject, WKScriptMessageHandler {
    private weak var controller: VaultBridgeViewController?
    private let queue = DispatchQueue(label: "com.swsoftworks.pathos.storage", qos: .userInitiated)
    private let store = VaultStore()

    init(controller: VaultBridgeViewController) { self.controller = controller }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard isTrustedLibraryFrame(message), message.webView === controller?.webView,
              let payload = message.body as? [String: Any], let id = payload["id"] as? String,
              id.range(of: "^[A-Za-z0-9_-]{1,80}$", options: .regularExpression) != nil else { return }
        if payload["operation"] as? String == "backgroundSaveFinished" {
            controller?.finishBackgroundSave()
            controller?.reply(id)
            return
        }
        queue.async { [self] in
            do {
                let result = try store.handle(payload)
                DispatchQueue.main.async { [weak self] in self?.controller?.reply(id, result: result) }
            } catch {
                let message = error.localizedDescription
                DispatchQueue.main.async { [weak self] in self?.controller?.reply(id, error: message) }
            }
        }
    }
}


/// Native dialog/cookie transports and new-window requests must not bypass the
/// script-message checks. The shared UI does not need camera, microphone or motion.
private final class TrustedUIDelegate: NSObject, WKUIDelegate {
    private weak var target: WebViewDelegationHandler?

    init(target: WebViewDelegationHandler) {
        self.target = target
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        guard isTrustedLibraryFrameInfo(frame), let target = target else { completionHandler(); return }
        target.webView(webView, runJavaScriptAlertPanelWithMessage: message,
                       initiatedByFrame: frame, completionHandler: completionHandler)
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        guard isTrustedLibraryFrameInfo(frame), let target = target else { completionHandler(false); return }
        target.webView(webView, runJavaScriptConfirmPanelWithMessage: message,
                       initiatedByFrame: frame, completionHandler: completionHandler)
    }

    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String,
                 defaultText: String?, initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping (String?) -> Void) {
        guard isTrustedLibraryFrameInfo(frame), let target = target else { completionHandler(nil); return }
        target.webView(webView, runJavaScriptTextInputPanelWithPrompt: prompt, defaultText: defaultText,
                       initiatedByFrame: frame, completionHandler: completionHandler)
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        // Popups are not part of the library UI. In-frame game links cannot open native apps.
        return nil
    }

    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin,
                 initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType,
                 decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        decisionHandler(.deny)
    }

    func webView(_ webView: WKWebView, requestDeviceOrientationAndMotionPermissionFor origin: WKSecurityOrigin,
                 initiatedByFrame frame: WKFrameInfo, decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        decisionHandler(.deny)
    }
}

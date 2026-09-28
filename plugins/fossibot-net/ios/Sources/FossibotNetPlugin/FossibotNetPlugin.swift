import Capacitor
import Foundation

/// Native networking for the Fossibot app: a TCP server for the station's offline mode,
/// a WebSocket client with auth headers for the cloud, and Keychain storage.
@objc(FossibotNetPlugin)
public class FossibotNetPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "FossibotNetPlugin"
    public let jsName = "FossibotNet"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "startServer", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stopServer", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "send", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getNetworkInfo", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "wsConnect", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "wsSend", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "wsClose", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "keychainSet", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "keychainGet", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "keychainRemove", returnType: CAPPluginReturnPromise),
    ]

    private lazy var server = TcpServer(callbacks: .init(
        onState: { [weak self] state, error in
            var data: [String: Any] = ["state": state]
            if let error { data["error"] = error }
            self?.notifyListeners("serverState", data: data)
        },
        onConnected: { [weak self] id, remote in
            self?.notifyListeners("clientConnected", data: ["sessionId": id, "remote": remote])
        },
        onData: { [weak self] id, data in
            self?.notifyListeners("clientData", data: ["sessionId": id, "hex": Hex.encode(data)])
        },
        onDisconnected: { [weak self] id, error in
            var data: [String: Any] = ["sessionId": id]
            if let error { data["error"] = error }
            self?.notifyListeners("clientDisconnected", data: data)
        }
    ))

    private lazy var socket = CloudSocket(callbacks: .init(
        onOpen: { [weak self] in self?.notifyListeners("wsOpen", data: [:]) },
        onMessage: { [weak self] text in self?.notifyListeners("wsMessage", data: ["text": text]) },
        onClose: { [weak self] code, reason in
            var data: [String: Any] = ["code": code]
            if let reason { data["reason"] = reason }
            self?.notifyListeners("wsClose", data: data)
        }
    ))

    // MARK: TCP server

    @objc func startServer(_ call: CAPPluginCall) {
        let port = call.getInt("port") ?? 8058
        do {
            try server.start(port: UInt16(port))
            call.resolve()
        } catch {
            call.reject("Не вдалося відкрити порт \(port): \(error.localizedDescription)")
        }
    }

    @objc func stopServer(_ call: CAPPluginCall) {
        server.stop()
        call.resolve()
    }

    @objc func send(_ call: CAPPluginCall) {
        guard let hex = call.getString("hex"), let data = Hex.decode(hex) else {
            return call.reject("Некоректний HEX")
        }
        server.send(data, to: call.getString("sessionId")) { error in
            if let error { call.reject(error) } else { call.resolve() }
        }
    }

    @objc func getNetworkInfo(_ call: CAPPluginCall) {
        let interfaces: JSArray = NetInfo.ipv4Addresses().map { iface -> JSValue in
            ["name": iface.name, "address": iface.address] as JSObject
        }
        call.resolve(["interfaces": interfaces])
    }

    // MARK: WebSocket

    @objc func wsConnect(_ call: CAPPluginCall) {
        guard let urlString = call.getString("url"), let url = URL(string: urlString) else {
            return call.reject("Некоректний URL")
        }
        var headers: [String: String] = [:]
        for (k, v) in call.getObject("headers") ?? [:] {
            if let s = v as? String { headers[k] = s }
        }
        socket.connect(url: url, headers: headers)
        call.resolve()
    }

    @objc func wsSend(_ call: CAPPluginCall) {
        socket.send(call.getString("text") ?? "") { error in
            if let error { call.reject(error) } else { call.resolve() }
        }
    }

    @objc func wsClose(_ call: CAPPluginCall) {
        socket.close()
        call.resolve()
    }

    // MARK: Keychain

    @objc func keychainSet(_ call: CAPPluginCall) {
        guard let key = call.getString("key"), let value = call.getString("value") else {
            return call.reject("key і value обов'язкові")
        }
        if Keychain.set(key, value) { call.resolve() } else { call.reject("Keychain: запис не вдався") }
    }

    @objc func keychainGet(_ call: CAPPluginCall) {
        guard let key = call.getString("key") else { return call.reject("key обов'язковий") }
        if let value = Keychain.get(key) {
            call.resolve(["value": value])
        } else {
            call.resolve([:])
        }
    }

    @objc func keychainRemove(_ call: CAPPluginCall) {
        guard let key = call.getString("key") else { return call.reject("key обов'язковий") }
        Keychain.remove(key)
        call.resolve()
    }
}

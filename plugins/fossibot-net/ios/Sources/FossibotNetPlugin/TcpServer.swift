import Foundation
import Network

/// Minimal TCP server. The station connects to the phone as a client (like the original
/// app's ts-tcp-tool plugin listening on :8058).
final class TcpServer {
    struct Callbacks {
        var onState: (_ state: String, _ error: String?) -> Void = { _, _ in }
        var onConnected: (_ sessionId: String, _ remote: String) -> Void = { _, _ in }
        var onData: (_ sessionId: String, _ data: Data) -> Void = { _, _ in }
        var onDisconnected: (_ sessionId: String, _ error: String?) -> Void = { _, _ in }
    }

    private let queue = DispatchQueue(label: "fossibot.tcpserver")
    private var listener: NWListener?
    private var sessions: [String: NWConnection] = [:]
    private let callbacks: Callbacks

    init(callbacks: Callbacks) {
        self.callbacks = callbacks
    }

    var isRunning: Bool { queue.sync { listener != nil } }

    func start(port: UInt16) throws {
        try queue.sync { try startLocked(port: port) }
    }

    func stop() {
        queue.sync { stopLocked() }
    }

    // All state below is only touched on `queue`.

    private func startLocked(port: UInt16) throws {
        stopLocked()
        let tcp = NWProtocolTCP.Options()
        tcp.enableKeepalive = true
        tcp.keepaliveIdle = 10
        tcp.noDelay = true
        let params = NWParameters(tls: nil, tcp: tcp)
        params.allowLocalEndpointReuse = true
        params.includePeerToPeer = false

        guard let nwPort = NWEndpoint.Port(rawValue: port) else {
            throw NSError(domain: "TcpServer", code: 1, userInfo: [NSLocalizedDescriptionKey: "Bad port \(port)"])
        }
        let listener = try NWListener(using: params, on: nwPort)
        listener.stateUpdateHandler = { [weak self] state in
            guard let self else { return }
            switch state {
            case .ready: self.callbacks.onState("listening", nil)
            case .failed(let err):
                self.callbacks.onState("failed", err.debugDescription)
                self.stopLocked()
            case .waiting(let err): self.callbacks.onState("waiting", err.debugDescription)
            case .cancelled: self.callbacks.onState("stopped", nil)
            default: break
            }
        }
        listener.newConnectionHandler = { [weak self] conn in self?.accept(conn) }
        self.listener = listener
        listener.start(queue: queue)
    }

    private func stopLocked() {
        for (_, conn) in sessions { conn.cancel() }
        sessions.removeAll()
        listener?.cancel()
        listener = nil
    }

    /// Sends to one session, or to every connected session when `sessionId` is nil.
    func send(_ data: Data, to sessionId: String?, completion: @escaping (String?) -> Void) {
        queue.async {
            let targets = sessionId.flatMap { self.sessions[$0] }.map { [$0] } ?? Array(self.sessions.values)
            if targets.isEmpty { return completion("No connected station") }
            let group = DispatchGroup()
            var firstError: String?
            for conn in targets {
                group.enter()
                conn.send(content: data, completion: .contentProcessed { err in
                    if let err, firstError == nil { firstError = err.debugDescription }
                    group.leave()
                })
            }
            group.notify(queue: self.queue) { completion(firstError) }
        }
    }

    var sessionIds: [String] { queue.sync { Array(sessions.keys) } }

    private func accept(_ conn: NWConnection) {
        let id = UUID().uuidString
        sessions[id] = conn
        conn.stateUpdateHandler = { [weak self] state in
            guard let self else { return }
            switch state {
            case .ready:
                self.callbacks.onConnected(id, "\(conn.endpoint)")
                self.receive(conn, id: id)
            case .failed(let err):
                self.drop(id, error: err.debugDescription)
            case .cancelled:
                self.drop(id, error: nil)
            default: break
            }
        }
        conn.start(queue: queue)
    }

    private func receive(_ conn: NWConnection, id: String) {
        conn.receive(minimumIncompleteLength: 1, maximumLength: 64 * 1024) { [weak self] data, _, isComplete, error in
            guard let self else { return }
            if let data, !data.isEmpty { self.callbacks.onData(id, data) }
            if let error {
                conn.cancel()
                self.drop(id, error: error.debugDescription)
            } else if isComplete {
                conn.cancel()
                self.drop(id, error: nil)
            } else {
                self.receive(conn, id: id)
            }
        }
    }

    private func drop(_ id: String, error: String?) {
        guard sessions.removeValue(forKey: id) != nil else { return }
        callbacks.onDisconnected(id, error)
    }
}

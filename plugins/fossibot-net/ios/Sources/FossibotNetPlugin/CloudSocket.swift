import Foundation

/// WebSocket client with custom request headers. WKWebView's WebSocket cannot send headers,
/// but the Fossibot server authenticates the socket with `Authorization` and `snCode` headers.
final class CloudSocket: NSObject, URLSessionWebSocketDelegate {
    struct Callbacks {
        var onOpen: () -> Void = {}
        var onMessage: (_ text: String) -> Void = { _ in }
        var onClose: (_ code: Int, _ reason: String?) -> Void = { _, _ in }
    }

    private var session: URLSession?
    private var task: URLSessionWebSocketTask?
    private let callbacks: Callbacks
    private var closed = false

    init(callbacks: Callbacks) {
        self.callbacks = callbacks
    }

    func connect(url: URL, headers: [String: String]) {
        close()
        closed = false
        var request = URLRequest(url: url)
        request.timeoutInterval = 15
        for (k, v) in headers { request.setValue(v, forHTTPHeaderField: k) }
        let session = URLSession(configuration: .default, delegate: self, delegateQueue: nil)
        let task = session.webSocketTask(with: request)
        self.session = session
        self.task = task
        task.resume()
        receive(task)
    }

    func send(_ text: String, completion: @escaping (String?) -> Void) {
        guard let task else { return completion("Socket is not connected") }
        task.send(.string(text)) { err in completion(err?.localizedDescription) }
    }

    func close() {
        task?.cancel(with: .normalClosure, reason: nil)
        session?.invalidateAndCancel()
        task = nil
        session = nil
    }

    private func receive(_ task: URLSessionWebSocketTask) {
        task.receive { [weak self] result in
            guard let self, task === self.task else { return }
            switch result {
            case .success(.string(let text)):
                self.callbacks.onMessage(text)
            case .success(.data(let data)):
                self.callbacks.onMessage(String(decoding: data, as: UTF8.self))
            case .success:
                break
            case .failure(let err):
                self.finish(code: -1, reason: err.localizedDescription)
                return
            }
            self.receive(task)
        }
    }

    private func finish(code: Int, reason: String?) {
        guard !closed else { return }
        closed = true
        task = nil
        session?.finishTasksAndInvalidate()
        session = nil
        callbacks.onClose(code, reason)
    }

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?) {
        guard webSocketTask === task else { return }
        callbacks.onOpen()
    }

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask,
                    didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        guard webSocketTask === task else { return }
        finish(code: closeCode.rawValue, reason: reason.map { String(decoding: $0, as: UTF8.self) })
    }
}

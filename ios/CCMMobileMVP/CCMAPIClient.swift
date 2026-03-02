import Foundation

enum CCMAPIClientError: LocalizedError {
    case invalidBaseURL
    case invalidResponse
    case invalidRequestBody
    case chatRuntimeError(String)
    case terminalSessionMissing
    case httpError(Int, String)

    var errorDescription: String? {
        switch self {
        case .invalidBaseURL:
            return "Server URL is invalid."
        case .invalidResponse:
            return "Server response is invalid."
        case .invalidRequestBody:
            return "Request body is invalid."
        case let .chatRuntimeError(message):
            return message.isEmpty ? "Task chat failed." : message
        case .terminalSessionMissing:
            return "Task terminal session is not available."
        case let .httpError(code, body):
            if body.isEmpty {
                return "Server returned HTTP \(code)."
            }
            return "Server returned HTTP \(code): \(body)"
        }
    }
}

struct CCMAPIClient {
    private let baseURL: URL
    private let accessToken: String?
    private let decoder: JSONDecoder

    init(serverURL: String, accessToken: String?) throws {
        let normalized = serverURL.trimmingCharacters(in: .whitespacesAndNewlines)
            .trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        guard let url = URL(string: normalized), let scheme = url.scheme, (scheme == "http" || scheme == "https") else {
            throw CCMAPIClientError.invalidBaseURL
        }

        self.baseURL = url
        let token = accessToken?.trimmingCharacters(in: .whitespacesAndNewlines)
        self.accessToken = token?.isEmpty == true ? nil : token

        let jsonDecoder = JSONDecoder()
        jsonDecoder.keyDecodingStrategy = .convertFromSnakeCase
        self.decoder = jsonDecoder
    }

    func fetchProjects() async throws -> [CCMProject] {
        let data = try await request(path: "/api/projects")
        return try decoder.decode([CCMProject].self, from: data)
    }

    func fetchTasks(projectId: String?) async throws -> [CCMTask] {
        var queryItems: [URLQueryItem] = []
        if let projectId, !projectId.isEmpty {
            queryItems.append(URLQueryItem(name: "projectId", value: projectId))
        }
        let data = try await request(path: "/api/tasks", queryItems: queryItems)
        return try decoder.decode([CCMTask].self, from: data)
    }

    func fetchAdapters() async throws -> [CCMAdapter] {
        let data = try await request(path: "/api/adapters")
        return try decoder.decode([CCMAdapter].self, from: data)
    }

    func createTask(title: String, projectId: String, branch: String = "main") async throws -> CCMTask {
        let data = try await request(
            path: "/api/tasks",
            method: "POST",
            jsonBody: [
                "title": title,
                "projectId": projectId,
                "branch": branch
            ]
        )
        return try decoder.decode(CCMTask.self, from: data)
    }

    func startTask(task: CCMTask, project: CCMProject?, mode: String) async throws -> CCMStartTaskResponse {
        let branch = task.branch?.isEmpty == false ? task.branch ?? "main" : "main"
        let worktreePath = task.worktreePath?.isEmpty == false ? task.worktreePath : project?.repoPath

        var body: [String: Any] = [
            "branch": branch,
            "mode": mode
        ]
        if let worktreePath, !worktreePath.isEmpty {
            body["worktreePath"] = worktreePath
        }
        if let model = task.model, !model.isEmpty {
            body["model"] = model
        }

        let data = try await request(
            path: "/api/tasks/\(task.id)/start",
            method: "POST",
            jsonBody: body
        )
        return try decoder.decode(CCMStartTaskResponse.self, from: data)
    }

    func deleteTask(taskID: String) async throws {
        _ = try await request(path: "/api/tasks/\(taskID)", method: "DELETE")
    }

    func ensureTaskTerminalSession(taskID: String) async throws -> CCMEnsureTaskTerminalResponse {
        let data = try await request(path: "/api/tasks/\(taskID)/terminal/session", method: "POST")
        return try decoder.decode(CCMEnsureTaskTerminalResponse.self, from: data)
    }

    func terminalEmbedURL(sessionName: String, includeAccessTokenInQuery: Bool = true) throws -> URL {
        let safeSession = sessionName.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? sessionName
        guard var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false) else {
            throw CCMAPIClientError.invalidBaseURL
        }
        components.path = "/api/terminal/\(safeSession)/embed"
        if includeAccessTokenInQuery, let accessToken, !accessToken.isEmpty {
            components.queryItems = [URLQueryItem(name: "access_token", value: accessToken)]
        }
        guard let url = components.url else {
            throw CCMAPIClientError.invalidBaseURL
        }
        return url
    }

    func streamTerminal(sessionName: String, replay: Bool = false) async throws -> URLSession.AsyncBytes {
        let safeSession = sessionName.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? sessionName
        var request = try buildRequest(
            path: "/api/terminal/\(safeSession)/stream",
            queryItems: [URLQueryItem(name: "replay", value: replay ? "1" : "0")]
        )
        request.timeoutInterval = 1800
        let (bytes, response) = try await URLSession.shared.bytes(for: request)
        guard let httpResponse = response as? HTTPURLResponse else {
            throw CCMAPIClientError.invalidResponse
        }
        guard (200 ..< 300).contains(httpResponse.statusCode) else {
            var body = ""
            for try await line in bytes.lines {
                body += line
                if body.count > 2000 { break }
            }
            throw CCMAPIClientError.httpError(httpResponse.statusCode, body)
        }
        return bytes
    }

    func sendTerminalInput(sessionName: String, data: String) async throws {
        let safeSession = sessionName.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? sessionName
        _ = try await request(
            path: "/api/terminal/\(safeSession)/input",
            method: "POST",
            jsonBody: ["data": data]
        )
    }

    func resizeTerminal(sessionName: String, cols: Int, rows: Int) async throws {
        let safeSession = sessionName.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? sessionName
        _ = try await request(
            path: "/api/terminal/\(safeSession)/resize",
            method: "POST",
            jsonBody: ["cols": cols, "rows": rows]
        )
    }

    func fetchTaskChatHistory(taskID: String) async throws -> [CCMChatMessage] {
        let data = try await request(path: "/api/tasks/\(taskID)/chat/history")
        let payload = try decoder.decode(CCMTaskChatHistoryResponse.self, from: data)
        return payload.messages
    }

    func sendTaskChat(taskID: String, message: String) async throws -> String {
        let trimmed = message.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return "" }

        var request = try buildRequest(
            path: "/api/tasks/\(taskID)/chat",
            method: "POST",
            jsonBody: ["message": trimmed]
        )
        request.timeoutInterval = 300

        let (bytes, response) = try await URLSession.shared.bytes(for: request)
        guard let httpResponse = response as? HTTPURLResponse else {
            throw CCMAPIClientError.invalidResponse
        }

        guard (200 ..< 300).contains(httpResponse.statusCode) else {
            var body = ""
            for try await line in bytes.lines {
                body += line
                if body.count > 2000 { break }
            }
            throw CCMAPIClientError.httpError(httpResponse.statusCode, body)
        }

        struct StreamEvent: Decodable {
            let text: String?
            let done: Bool?
            let error: Bool?
        }

        var chunks: [String] = []
        for try await line in bytes.lines {
            guard line.hasPrefix("data: ") else { continue }
            let payload = String(line.dropFirst(6))
            guard let payloadData = payload.data(using: .utf8) else { continue }
            guard let event = try? decoder.decode(StreamEvent.self, from: payloadData) else { continue }

            if let text = event.text, !text.isEmpty {
                chunks.append(text)
            }
            if event.error == true {
                throw CCMAPIClientError.chatRuntimeError(chunks.joined())
            }
            if event.done == true {
                break
            }
        }
        return chunks.joined()
    }

    private func request(
        path: String,
        method: String = "GET",
        queryItems: [URLQueryItem] = [],
        jsonBody: [String: Any]? = nil
    ) async throws -> Data {
        var request = try buildRequest(path: path, method: method, queryItems: queryItems, jsonBody: jsonBody)
        request.timeoutInterval = 20
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse else {
            throw CCMAPIClientError.invalidResponse
        }

        guard (200 ..< 300).contains(httpResponse.statusCode) else {
            let body = String(data: data, encoding: .utf8) ?? ""
            throw CCMAPIClientError.httpError(httpResponse.statusCode, body)
        }
        return data
    }

    private func buildRequest(
        path: String,
        method: String = "GET",
        queryItems: [URLQueryItem] = [],
        jsonBody: [String: Any]? = nil
    ) throws -> URLRequest {
        guard var components = URLComponents(url: baseURL.appendingPathComponent(path), resolvingAgainstBaseURL: false) else {
            throw CCMAPIClientError.invalidBaseURL
        }
        if !queryItems.isEmpty {
            components.queryItems = queryItems
        }
        guard let url = components.url else {
            throw CCMAPIClientError.invalidBaseURL
        }

        var request = URLRequest(url: url)
        request.httpMethod = method
        if let accessToken {
            request.setValue("Bearer \(accessToken)", forHTTPHeaderField: "Authorization")
        }
        if let jsonBody {
            guard JSONSerialization.isValidJSONObject(jsonBody) else {
                throw CCMAPIClientError.invalidRequestBody
            }
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONSerialization.data(withJSONObject: jsonBody)
        }
        return request
    }
}

import Foundation

enum CCMAPIClientError: LocalizedError {
    case invalidBaseURL
    case invalidResponse
    case httpError(Int, String)

    var errorDescription: String? {
        switch self {
        case .invalidBaseURL:
            return "Server URL is invalid."
        case .invalidResponse:
            return "Server response is invalid."
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

    private func request(path: String, queryItems: [URLQueryItem] = []) async throws -> Data {
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
        request.timeoutInterval = 20
        if let accessToken {
            request.setValue("Bearer \(accessToken)", forHTTPHeaderField: "Authorization")
        }

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
}

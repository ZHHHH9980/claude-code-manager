import Foundation

struct CCMProject: Codable, Identifiable, Hashable {
    let id: String
    let name: String
    let repoPath: String?
    let githubRepo: String?
    let sshHost: String?
    let createdAt: String?
}

struct CCMTask: Codable, Identifiable, Hashable {
    let id: String
    let title: String
    let status: String
    let projectId: String?
    let ptySession: String?
    let branch: String?
    let worktreePath: String?
    let model: String?
    let mode: String?
    let createdAt: String?
    let updatedAt: String?
}

struct CCMAdapterModel: Codable, Hashable {
    let id: String
    let label: String
}

struct CCMAdapter: Codable, Identifiable, Hashable {
    let name: String
    let label: String?
    let color: String?
    let models: [CCMAdapterModel]?
    let defaultModel: String?
    let supportsChatMode: Bool?

    var id: String { name }
    var displayLabel: String { label ?? name.capitalized }
    var availableModels: [CCMAdapterModel] { models ?? [] }
}

struct CCMStartTaskResponse: Codable, Hashable {
    let sessionName: String?
    let ptyOk: Bool?
    let mode: String?
    let model: String?
    let error: String?
}

struct CCMEnsureTaskTerminalResponse: Codable, Hashable {
    let sessionName: String?
    let ready: Bool?
    let mode: String?
    let error: String?
}

struct CCMTerminalStreamEvent: Codable, Hashable {
    let type: String?
    let sessionName: String?
    let chunk: String?
    let replay: Bool?
    let message: String?
}

struct CCMTerminalReadResponse: Codable, Hashable {
    let from: Int
    let next: Int
    let chunk: String
}

struct CCMTerminalStateResponse: Codable, Hashable {
    let sessionName: String
    let exists: Bool
    let state: String
    let code: String
    let attachedClients: Int
    let bufferBytes: Int
    let taskId: String?
    let taskStatus: String?
    let runningTaskId: String?
    let recoverable: Bool
}

struct CCMWebTerminalDestination: Identifiable, Hashable {
    let id: String
    let title: String
    let url: URL
}

struct CCMChatMessage: Codable, Hashable, Identifiable {
    let role: String
    let text: String
    let createdAt: String?

    var id: String {
        let prefix = String(text.prefix(24))
        return "\(createdAt ?? "na")-\(role)-\(prefix)-\(text.count)"
    }
}

struct CCMTaskChatHistoryResponse: Codable, Hashable {
    let messages: [CCMChatMessage]
}

struct CCMRuntimeConfigResponse: Codable, Hashable {
    let sessionManagerEnabled: Bool?
    let terminalSocketURL: String?
    let chatManagerEnabled: Bool?
    let chatBaseURL: String?

    enum CodingKeys: String, CodingKey {
        case sessionManagerEnabled
        case terminalSocketURL = "terminalSocketUrl"
        case chatManagerEnabled
        case chatBaseURL = "chatBaseUrl"
    }
}

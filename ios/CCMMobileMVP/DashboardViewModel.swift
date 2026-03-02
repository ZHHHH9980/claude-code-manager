import Foundation

enum CCMStatusKind {
    case neutral
    case success
    case warning
    case error
}

@MainActor
final class DashboardViewModel: ObservableObject {
    @Published var serverURL: String
    @Published var accessToken: String
    @Published var projects: [CCMProject] = []
    @Published var tasks: [CCMTask] = []
    @Published var adapters: [CCMAdapter] = []
    @Published var selectedProjectID: String
    @Published var statusText: String = "Ready"
    @Published var statusKind: CCMStatusKind = .neutral
    @Published var isLoading = false
    @Published var isPerformingTaskAction = false
    @Published var activeSessionName: String = ""
    @Published var activeChatTask: CCMTask?
    @Published var chatMessages: [CCMChatMessage] = []
    @Published var chatInput: String = ""
    @Published var isChatLoading = false
    @Published var isChatSending = false
    @Published var activeNativeTerminalTask: CCMTask?
    @Published var activeWebTerminal: CCMWebTerminalDestination?
    @Published var activeTerminalSessionName: String = ""
    @Published var terminalOutput: String = ""
    @Published var terminalInput: String = ""
    @Published var isTerminalConnecting = false
    @Published var isTerminalSending = false

    private let keychain = KeychainStore.shared
    private let defaults = UserDefaults.standard
    private let serverURLKey = "ccm_server_url"
    private let accessTokenKey = "ccm_access_token"
    private let selectedProjectIDKey = "ccm_selected_project_id"
    private var didBootstrap = false
    private var terminalStreamTask: Task<Void, Never>?
    private var terminalConnectWatchdogTask: Task<Void, Never>?

    private static let fallbackAdapters: [CCMAdapter] = [
        CCMAdapter(
            name: "claude",
            label: "Claude Code",
            color: "#d97757",
            models: [CCMAdapterModel(id: "claude-sonnet-4-5", label: "Sonnet 4.5")],
            defaultModel: "claude-sonnet-4-5",
            supportsChatMode: true
        ),
        CCMAdapter(
            name: "codex",
            label: "Codex",
            color: "#10a37f",
            models: [CCMAdapterModel(id: "gpt-5.3-codex", label: "GPT-5.3-Codex")],
            defaultModel: "gpt-5.3-codex",
            supportsChatMode: false
        )
    ]

    init() {
        serverURL = defaults.string(forKey: serverURLKey) ?? "http://127.0.0.1:3000"
        accessToken = keychain.string(for: accessTokenKey) ?? ""
        selectedProjectID = defaults.string(forKey: selectedProjectIDKey) ?? ""
        adapters = Self.fallbackAdapters
    }

    deinit {
        terminalStreamTask?.cancel()
        terminalConnectWatchdogTask?.cancel()
    }

    var selectedProject: CCMProject? {
        projects.first(where: { $0.id == selectedProjectID })
    }

    var hasServerConfig: Bool {
        !serverURL.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    func bootstrapIfNeeded() async {
        guard !didBootstrap else { return }
        didBootstrap = true
        await refresh()
    }

    func saveConfiguration() async {
        let trimmedServerURL = serverURL.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedAccessToken = accessToken.trimmingCharacters(in: .whitespacesAndNewlines)

        defaults.set(trimmedServerURL, forKey: serverURLKey)
        serverURL = trimmedServerURL

        if trimmedAccessToken.isEmpty {
            _ = keychain.remove(account: accessTokenKey)
        } else {
            _ = keychain.set(trimmedAccessToken, for: accessTokenKey)
        }
        accessToken = trimmedAccessToken

        setStatus("Saved local configuration.", kind: .success)
        await refresh()
    }

    func selectProject(_ projectID: String) async {
        guard selectedProjectID != projectID else { return }
        selectedProjectID = projectID
        defaults.set(projectID, forKey: selectedProjectIDKey)
        await refreshTasksForCurrentSelection()
    }

    func refresh() async {
        let normalizedURL = serverURL.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalizedURL.isEmpty else {
            setStatus("Please enter Server URL first.", kind: .warning)
            return
        }

        isLoading = true
        defer { isLoading = false }

        do {
            let client = try makeClient()
            async let projectRequest = client.fetchProjects()
            async let adapterRequest = client.fetchAdapters()

            let loadedProjects = try await projectRequest
            projects = loadedProjects

            let loadedAdapters = (try? await adapterRequest) ?? []
            adapters = loadedAdapters.isEmpty ? Self.fallbackAdapters : loadedAdapters

            normalizeSelectedProject()
            try await refreshTasks(using: client)
            setStatus("Synced \(projects.count) projects and \(tasks.count) tasks.", kind: .success)
        } catch {
            setStatus(error.localizedDescription, kind: .error)
        }
    }

    func refreshTasksForCurrentSelection() async {
        do {
            let client = try makeClient()
            try await refreshTasks(using: client)
            setStatus("Loaded \(tasks.count) tasks.", kind: .success)
        } catch {
            setStatus(error.localizedDescription, kind: .error)
        }
    }

    func createTask(title: String) async {
        let trimmedTitle = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedTitle.isEmpty else {
            setStatus("Task title cannot be empty.", kind: .warning)
            return
        }
        guard let project = selectedProject else {
            setStatus("Please select a project before creating a task.", kind: .warning)
            return
        }

        isPerformingTaskAction = true
        defer { isPerformingTaskAction = false }

        do {
            let client = try makeClient()
            _ = try await client.createTask(title: trimmedTitle, projectId: project.id)
            try await refreshTasks(using: client)
            setStatus("Created task: \(trimmedTitle)", kind: .success)
        } catch {
            setStatus(error.localizedDescription, kind: .error)
        }
    }

    func startTask(_ task: CCMTask, mode: String) async {
        guard !mode.isEmpty else {
            setStatus("Please choose an adapter mode.", kind: .warning)
            return
        }

        isPerformingTaskAction = true
        defer { isPerformingTaskAction = false }

        do {
            let client = try makeClient()
            let response = try await client.startTask(task: task, project: selectedProject, mode: mode)
            if response.ptyOk == false {
                let reason = response.error?.isEmpty == false ? response.error! : "unknown error"
                setStatus("Failed to start task: \(reason)", kind: .error)
                try await refreshTasks(using: client)
                return
            }
            if let sessionName = response.sessionName, !sessionName.isEmpty {
                activeSessionName = sessionName
            }
            try await refreshTasks(using: client)
            setStatus("Started task \"\(task.title)\" with \(mode.uppercased()).", kind: .success)
        } catch {
            setStatus(error.localizedDescription, kind: .error)
        }
    }

    func deleteTask(_ task: CCMTask) async {
        isPerformingTaskAction = true
        defer { isPerformingTaskAction = false }

        do {
            let client = try makeClient()
            try await client.deleteTask(taskID: task.id)
            try await refreshTasks(using: client)
            setStatus("Deleted task \"\(task.title)\".", kind: .success)
        } catch {
            setStatus(error.localizedDescription, kind: .error)
        }
    }

    func openNativeTerminal(_ task: CCMTask) async {
        do {
            let client = try makeClient()
            let response = try await client.ensureTaskTerminalSession(taskID: task.id)
            guard let sessionName = response.sessionName, !sessionName.isEmpty else {
                throw CCMAPIClientError.terminalSessionMissing
            }

            activeNativeTerminalTask = task
            activeTerminalSessionName = sessionName
            terminalOutput = ""
            terminalInput = ""
            beginTerminalStream(sessionName: sessionName)
            setStatus("Connected native terminal for \(task.title).", kind: .success)
        } catch {
            setStatus(error.localizedDescription, kind: .error)
        }
    }

    func closeNativeTerminal() {
        terminalStreamTask?.cancel()
        terminalStreamTask = nil
        terminalConnectWatchdogTask?.cancel()
        terminalConnectWatchdogTask = nil
        activeNativeTerminalTask = nil
        activeTerminalSessionName = ""
        terminalInput = ""
        isTerminalConnecting = false
        isTerminalSending = false
    }

    func sendTerminalInput() async {
        guard !activeTerminalSessionName.isEmpty else { return }
        let command = terminalInput.trimmingCharacters(in: .newlines)
        guard !command.isEmpty else { return }

        terminalInput = ""
        isTerminalSending = true
        defer { isTerminalSending = false }

        do {
            let client = try makeClient()
            try await client.sendTerminalInput(sessionName: activeTerminalSessionName, data: command + "\n")
        } catch {
            appendTerminalOutput("\n[input error] \(error.localizedDescription)\n")
            setStatus(error.localizedDescription, kind: .error)
        }
    }

    func openWebTerminal(_ task: CCMTask) async {
        do {
            let client = try makeClient()
            let response = try await client.ensureTaskTerminalSession(taskID: task.id)
            guard let sessionName = response.sessionName, !sessionName.isEmpty else {
                throw CCMAPIClientError.terminalSessionMissing
            }
            let url = try client.terminalEmbedURL(sessionName: sessionName, includeAccessTokenInQuery: true)
            activeWebTerminal = CCMWebTerminalDestination(id: "\(task.id)-\(sessionName)", title: task.title, url: url)
            setStatus("Opened web terminal for \(task.title).", kind: .success)
        } catch {
            setStatus(error.localizedDescription, kind: .error)
        }
    }

    func closeWebTerminal() {
        activeWebTerminal = nil
    }

    func openTaskChat(_ task: CCMTask) async {
        activeChatTask = task
        await loadChatHistory()
    }

    func closeTaskChat() {
        activeChatTask = nil
        chatMessages = []
        chatInput = ""
        isChatLoading = false
        isChatSending = false
    }

    func loadChatHistory() async {
        guard let task = activeChatTask else { return }

        isChatLoading = true
        defer { isChatLoading = false }

        do {
            let client = try makeClient()
            chatMessages = try await client.fetchTaskChatHistory(taskID: task.id)
            if chatMessages.isEmpty {
                chatMessages = [introMessage(for: task)]
            }
        } catch {
            setStatus(error.localizedDescription, kind: .error)
        }
    }

    func sendChatMessage() async {
        guard let task = activeChatTask else { return }
        let trimmed = chatInput.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }

        chatInput = ""
        chatMessages.append(CCMChatMessage(role: "user", text: trimmed, createdAt: nil))

        // /model 等命令属于 CLI 终端能力；移动端当前是 chat API，不支持命令补全。
        if trimmed.hasPrefix("/") {
            let tip = "Slash commands are terminal-only in current mobile chat mode. Use Web/Xcode terminal session for commands like /model."
            chatMessages.append(CCMChatMessage(role: "assistant", text: tip, createdAt: nil))
            setStatus("Slash command is not supported in chat mode.", kind: .warning)
            return
        }

        isChatSending = true
        defer { isChatSending = false }

        do {
            let client = try makeClient()
            let assistantText = try await client.sendTaskChat(taskID: task.id, message: trimmed)
            if !assistantText.isEmpty {
                chatMessages.append(CCMChatMessage(role: "assistant", text: assistantText, createdAt: nil))
            }
            if let refreshedTask = tasks.first(where: { $0.id == task.id }) {
                activeChatTask = refreshedTask
            }
        } catch {
            setStatus(error.localizedDescription, kind: .error)
        }
    }

    private func introMessage(for task: CCMTask) -> CCMChatMessage {
        let modeText = task.mode?.isEmpty == false ? task.mode!.uppercased() : "TASK"
        let modelText = task.model?.isEmpty == false ? task.model! : "default model"
        let text = "Connected to \(modeText) task assistant. Model: \(modelText). This is chat mode (not raw CLI terminal), so slash command completion is unavailable."
        return CCMChatMessage(role: "assistant", text: text, createdAt: nil)
    }

    private func beginTerminalStream(sessionName: String) {
        terminalStreamTask?.cancel()
        terminalConnectWatchdogTask?.cancel()
        isTerminalConnecting = true
        appendTerminalOutput("Connecting to session \(sessionName)...\n")

        terminalConnectWatchdogTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 8_000_000_000)
            await MainActor.run {
                guard let self else { return }
                guard self.activeTerminalSessionName == sessionName, self.isTerminalConnecting else { return }
                self.isTerminalConnecting = false
                self.appendTerminalOutput("[waiting] stream handshake is slow. You can still try sending a command.\n")
            }
        }

        terminalStreamTask = Task { [weak self] in
            await self?.consumeTerminalStream(sessionName: sessionName)
        }
    }

    private func consumeTerminalStream(sessionName: String) async {
        do {
            let client = try makeClient()
            let bytes = try await client.streamTerminal(sessionName: sessionName, replay: false)
            terminalConnectWatchdogTask?.cancel()
            terminalConnectWatchdogTask = nil
            isTerminalConnecting = false

            var payloadLines: [String] = []
            for try await line in bytes.lines {
                if Task.isCancelled { break }
                if line.hasPrefix("data: ") {
                    payloadLines.append(String(line.dropFirst(6)))
                    continue
                }
                if !line.isEmpty { continue }
                if payloadLines.isEmpty { continue }
                let payload = payloadLines.joined(separator: "\n")
                payloadLines.removeAll(keepingCapacity: true)
                handleTerminalEventPayload(payload)
            }
        } catch is CancellationError {
            // Sheet closed; do not report as error.
        } catch {
            terminalConnectWatchdogTask?.cancel()
            terminalConnectWatchdogTask = nil
            isTerminalConnecting = false
            appendTerminalOutput("\n[stream error] \(error.localizedDescription)\n")
            setStatus(error.localizedDescription, kind: .error)
        }
    }

    private func handleTerminalEventPayload(_ payload: String) {
        guard let data = payload.data(using: .utf8),
              let event = try? JSONDecoder().decode(CCMTerminalStreamEvent.self, from: data) else {
            return
        }

        switch event.type {
        case "output":
            if let chunk = event.chunk {
                appendTerminalOutput(sanitizeTerminalText(chunk))
            }
        case "ready":
            appendTerminalOutput("[connected]\n")
        case "done":
            appendTerminalOutput("\n[session ended]\n")
        case "error":
            appendTerminalOutput("\n[error] \(event.message ?? "unknown")\n")
        default:
            break
        }
    }

    private func appendTerminalOutput(_ text: String) {
        guard !text.isEmpty else { return }
        terminalOutput += text
        if terminalOutput.count > 200_000 {
            terminalOutput = String(terminalOutput.suffix(150_000))
        }
    }

    private func sanitizeTerminalText(_ text: String) -> String {
        var sanitized = text
        let patterns = [
            #"\u{001B}\[[0-9;?]*[ -/]*[@-~]"#,
            #"\u{001B}\][^\u{0007}]*(\u{0007}|\u{001B}\\)"#
        ]
        for pattern in patterns {
            sanitized = sanitized.replacingOccurrences(
                of: pattern,
                with: "",
                options: .regularExpression
            )
        }
        sanitized.removeAll { character in
            if character == "\n" || character == "\r" || character == "\t" { return false }
            return character.isASCII && character.unicodeScalars.allSatisfy { $0.value < 0x20 || $0.value == 0x7F }
        }
        return sanitized
    }

    private func makeClient() throws -> CCMAPIClient {
        try CCMAPIClient(serverURL: serverURL, accessToken: accessToken)
    }

    private func refreshTasks(using client: CCMAPIClient) async throws {
        let effectiveProjectID = selectedProjectID.isEmpty ? nil : selectedProjectID
        tasks = try await client.fetchTasks(projectId: effectiveProjectID)
    }

    private func normalizeSelectedProject() {
        if projects.isEmpty {
            selectedProjectID = ""
            defaults.set("", forKey: selectedProjectIDKey)
            return
        }

        if !selectedProjectID.isEmpty, projects.contains(where: { $0.id == selectedProjectID }) {
            return
        }

        selectedProjectID = projects[0].id
        defaults.set(selectedProjectID, forKey: selectedProjectIDKey)
    }

    private func setStatus(_ text: String, kind: CCMStatusKind) {
        statusText = text
        statusKind = kind
    }
}

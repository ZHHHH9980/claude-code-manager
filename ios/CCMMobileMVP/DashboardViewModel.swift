import Foundation

@MainActor
final class DashboardViewModel: ObservableObject {
    @Published var serverURL: String
    @Published var accessToken: String
    @Published var projects: [CCMProject] = []
    @Published var tasks: [CCMTask] = []
    @Published var selectedProjectID: String = ""
    @Published var statusText: String = ""
    @Published var isLoading = false

    private let keychain = KeychainStore.shared
    private let defaults = UserDefaults.standard
    private let serverURLKey = "ccm_server_url"
    private let accessTokenKey = "ccm_access_token"
    private var didBootstrap = false

    init() {
        serverURL = defaults.string(forKey: serverURLKey) ?? "http://127.0.0.1:3000"
        accessToken = keychain.string(for: accessTokenKey) ?? ""
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

        statusText = "Saved local configuration."
        await refresh()
    }

    func refresh() async {
        let normalizedURL = serverURL.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalizedURL.isEmpty else {
            statusText = "Please enter Server URL first."
            return
        }

        isLoading = true
        defer { isLoading = false }

        do {
            let client = try CCMAPIClient(serverURL: normalizedURL, accessToken: accessToken)
            let loadedProjects = try await client.fetchProjects()

            let effectiveProjectID: String?
            if selectedProjectID.isEmpty {
                effectiveProjectID = nil
            } else {
                effectiveProjectID = selectedProjectID
            }

            let loadedTasks = try await client.fetchTasks(projectId: effectiveProjectID)

            projects = loadedProjects
            tasks = loadedTasks
            statusText = "Synced \(projects.count) projects and \(tasks.count) tasks."
        } catch {
            statusText = error.localizedDescription
        }
    }

    func reloadTasksForSelection() async {
        await refresh()
    }
}

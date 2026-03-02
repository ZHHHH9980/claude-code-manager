import SwiftUI

struct ContentView: View {
    @ObservedObject var viewModel: DashboardViewModel

    var body: some View {
        NavigationStack {
            Form {
                connectionSection
                projectFilterSection
                dataSection
                statusSection
            }
            .navigationTitle("CCM Mobile MVP")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        Task {
                            await viewModel.refresh()
                        }
                    } label: {
                        if viewModel.isLoading {
                            ProgressView()
                        } else {
                            Text("Refresh")
                        }
                    }
                    .disabled(viewModel.isLoading)
                }
            }
            .task {
                await viewModel.bootstrapIfNeeded()
            }
        }
    }

    private var connectionSection: some View {
        Section("Connection") {
            TextField("Server URL (e.g. http://192.168.1.20:3000)", text: $viewModel.serverURL)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()

            SecureField("CCM ACCESS_TOKEN", text: $viewModel.accessToken)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()

            Button("Save & Sync") {
                Task {
                    await viewModel.saveConfiguration()
                }
            }
            .disabled(viewModel.isLoading)
        }
    }

    private var projectFilterSection: some View {
        Section("Project Filter") {
            Picker("Project", selection: $viewModel.selectedProjectID) {
                Text("All Projects").tag("")
                ForEach(viewModel.projects, id: \.id) { project in
                    Text(project.name).tag(project.id)
                }
            }
            .onChange(of: viewModel.selectedProjectID) { _, _ in
                Task {
                    await viewModel.reloadTasksForSelection()
                }
            }
        }
    }

    private var dataSection: some View {
        Section("Dashboard") {
            LabeledContent("Projects", value: "\(viewModel.projects.count)")
            LabeledContent("Tasks", value: "\(viewModel.tasks.count)")

            if !viewModel.tasks.isEmpty {
                ForEach(viewModel.tasks.prefix(10), id: \.id) { task in
                    VStack(alignment: .leading, spacing: 4) {
                        Text(task.title)
                            .font(.headline)
                        Text("Status: \(task.status)")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    .padding(.vertical, 2)
                }
            }
        }
    }

    private var statusSection: some View {
        Section("Status") {
            Text(viewModel.statusText.isEmpty ? "Ready" : viewModel.statusText)
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
    }
}

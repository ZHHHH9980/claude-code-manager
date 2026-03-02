import SwiftUI
import WebKit

private enum CCMMobilePane: String, CaseIterable, Identifiable {
    case projects = "Projects"
    case tasks = "Tasks"
    case settings = "Settings"

    var id: String { rawValue }
}

private enum CCMTaskFilter: String, CaseIterable, Identifiable {
    case all = "All"
    case pending = "Pending"
    case running = "Running"
    case done = "Done"

    var id: String { rawValue }
}

struct ContentView: View {
    @ObservedObject var viewModel: DashboardViewModel

    @State private var selectedPane: CCMMobilePane = .tasks
    @State private var selectedFilter: CCMTaskFilter = .all
    @State private var showCreateTaskSheet = false
    @State private var newTaskTitle = ""
    @State private var pendingDeleteTask: CCMTask?
    @State private var revealToken = false

    private var filteredTasks: [CCMTask] {
        switch selectedFilter {
        case .all:
            return viewModel.tasks
        case .pending:
            return viewModel.tasks.filter { $0.status == "pending" }
        case .running:
            return viewModel.tasks.filter { $0.status == "in_progress" }
        case .done:
            return viewModel.tasks.filter { $0.status == "done" }
        }
    }

    var body: some View {
        ZStack {
            LinearGradient(
                colors: [CCMColors.bgStart, CCMColors.bgEnd],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            )
            .ignoresSafeArea()

            ScrollView {
                VStack(spacing: 14) {
                    headerCard
                    statsRow
                    panePicker
                    contentPanel
                    statusCard
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 12)
                .padding(.bottom, 26)
            }
        }
        .task {
            await viewModel.bootstrapIfNeeded()
        }
        .sheet(isPresented: $showCreateTaskSheet) {
            NavigationStack {
                Form {
                    Section("Task") {
                        TextField("Task title", text: $newTaskTitle)
                    }
                    Section {
                        Button("Create") {
                            let title = newTaskTitle
                            newTaskTitle = ""
                            showCreateTaskSheet = false
                            Task {
                                await viewModel.createTask(title: title)
                            }
                        }
                        .disabled(newTaskTitle.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    }
                }
                .navigationTitle("New Task")
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Cancel") {
                            showCreateTaskSheet = false
                            newTaskTitle = ""
                        }
                    }
                }
            }
        }
        .sheet(item: $viewModel.activeChatTask) { task in
            taskChatSheet(task: task)
        }
        .sheet(item: $viewModel.activeNativeTerminalTask, onDismiss: {
            viewModel.closeNativeTerminal()
        }) { task in
            nativeTerminalSheet(task: task)
        }
        .sheet(item: $viewModel.activeWebTerminal, onDismiss: {
            viewModel.closeWebTerminal()
        }) { destination in
            webTerminalSheet(destination: destination)
        }
        .alert("Delete Task", isPresented: Binding(
            get: { pendingDeleteTask != nil },
            set: { isPresented in
                if !isPresented {
                    pendingDeleteTask = nil
                }
            }
        )) {
            Button("Delete", role: .destructive) {
                guard let task = pendingDeleteTask else { return }
                pendingDeleteTask = nil
                Task {
                    await viewModel.deleteTask(task)
                }
            }
            Button("Cancel", role: .cancel) {
                pendingDeleteTask = nil
            }
        } message: {
            Text("This will stop runtime and remove task history for \(pendingDeleteTask?.title ?? "this task").")
        }
    }

    private var headerCard: some View {
        HStack(alignment: .top, spacing: 12) {
            VStack(alignment: .leading, spacing: 6) {
                Text("CCM Cockpit")
                    .font(.system(size: 26, weight: .bold, design: .rounded))
                    .foregroundStyle(CCMColors.textPrimary)
                Text("Mobile operator panel for projects, tasks and live runtime status")
                    .font(.system(size: 13, weight: .medium, design: .rounded))
                    .foregroundStyle(CCMColors.textSecondary)
                if !viewModel.activeSessionName.isEmpty {
                    Label("Active: \(viewModel.activeSessionName)", systemImage: "terminal")
                        .font(.system(size: 11, weight: .semibold, design: .rounded))
                        .foregroundStyle(CCMColors.accentTeal)
                        .lineLimit(1)
                }
            }

            Spacer(minLength: 0)

            Button {
                Task {
                    await viewModel.refresh()
                }
            } label: {
                if viewModel.isLoading {
                    ProgressView()
                        .progressViewStyle(.circular)
                        .tint(.white)
                        .frame(width: 18, height: 18)
                        .padding(.horizontal, 4)
                } else {
                    Label("Sync", systemImage: "arrow.clockwise")
                        .font(.system(size: 13, weight: .bold, design: .rounded))
                }
            }
            .buttonStyle(.borderedProminent)
            .buttonBorderShape(.capsule)
            .tint(CCMColors.accentOrange)
            .disabled(viewModel.isLoading)
        }
        .padding(14)
        .background(CCMColors.surface.opacity(0.92), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .stroke(CCMColors.border.opacity(0.85), lineWidth: 1)
        )
        .shadow(color: CCMColors.shadow, radius: 12, x: 0, y: 8)
    }

    private var statsRow: some View {
        HStack(spacing: 10) {
            statCard(title: "Projects", value: "\(viewModel.projects.count)", accent: CCMColors.accentTeal)
            statCard(title: "Tasks", value: "\(viewModel.tasks.count)", accent: CCMColors.accentOrange)
            statCard(title: "Running", value: "\(viewModel.tasks.filter { $0.status == "in_progress" }.count)", accent: CCMColors.ok)
        }
    }

    private var panePicker: some View {
        Picker("Pane", selection: $selectedPane) {
            ForEach(CCMMobilePane.allCases) { pane in
                Text(pane.rawValue).tag(pane)
            }
        }
        .pickerStyle(.segmented)
    }

    @ViewBuilder
    private var contentPanel: some View {
        VStack(spacing: 12) {
            switch selectedPane {
            case .projects:
                projectsPane
            case .tasks:
                tasksPane
            case .settings:
                settingsPane
            }
        }
        .padding(12)
        .background(CCMColors.surfaceSoft.opacity(0.94), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .stroke(CCMColors.border.opacity(0.75), lineWidth: 1)
        )
    }

    private var projectsPane: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Projects")
                .font(.system(size: 14, weight: .bold, design: .rounded))
                .foregroundStyle(CCMColors.textSecondary)

            if viewModel.projects.isEmpty {
                emptyCard(message: "No projects returned from server. Check URL/token in Settings.")
            } else {
                ForEach(viewModel.projects) { project in
                    Button {
                        Task {
                            await viewModel.selectProject(project.id)
                            selectedPane = .tasks
                        }
                    } label: {
                        HStack(spacing: 10) {
                            Circle()
                                .fill(viewModel.selectedProjectID == project.id ? CCMColors.accentTeal : CCMColors.border)
                                .frame(width: 8, height: 8)
                            VStack(alignment: .leading, spacing: 4) {
                                Text(project.name)
                                    .font(.system(size: 15, weight: .bold, design: .rounded))
                                    .foregroundStyle(CCMColors.textPrimary)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                Text(project.repoPath?.isEmpty == false ? project.repoPath! : "No repo path")
                                    .font(.system(size: 12, weight: .medium, design: .rounded))
                                    .foregroundStyle(CCMColors.textSecondary)
                                    .lineLimit(1)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                            }
                            Image(systemName: "chevron.right")
                                .font(.system(size: 11, weight: .bold))
                                .foregroundStyle(CCMColors.textMuted)
                        }
                        .padding(12)
                        .background(
                            viewModel.selectedProjectID == project.id
                                ? CCMColors.accentTeal.opacity(0.16)
                                : CCMColors.surface,
                            in: RoundedRectangle(cornerRadius: 14, style: .continuous)
                        )
                        .overlay(
                            RoundedRectangle(cornerRadius: 14, style: .continuous)
                                .stroke(viewModel.selectedProjectID == project.id ? CCMColors.accentTeal : CCMColors.border, lineWidth: 1)
                        )
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }

    private var tasksPane: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Task Board")
                        .font(.system(size: 14, weight: .bold, design: .rounded))
                        .foregroundStyle(CCMColors.textSecondary)
                    Text(viewModel.selectedProject?.name ?? "No project selected")
                        .font(.system(size: 12, weight: .medium, design: .rounded))
                        .foregroundStyle(CCMColors.textMuted)
                        .lineLimit(1)
                }
                Spacer()
                Button {
                    showCreateTaskSheet = true
                } label: {
                    Label("New", systemImage: "plus")
                }
                .buttonStyle(.borderedProminent)
                .buttonBorderShape(.capsule)
                .tint(CCMColors.accentOrange)
                .disabled(viewModel.selectedProject == nil)
            }

            filterRow

            if filteredTasks.isEmpty {
                emptyCard(message: "No tasks in this filter.")
            } else {
                LazyVStack(spacing: 10) {
                    ForEach(filteredTasks) { task in
                        taskCard(task)
                    }
                }
            }
        }
    }

    private var filterRow: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(CCMTaskFilter.allCases) { filter in
                    let selected = selectedFilter == filter
                    Button(filter.rawValue) {
                        selectedFilter = filter
                    }
                    .font(.system(size: 12, weight: .bold, design: .rounded))
                    .padding(.horizontal, 10)
                    .padding(.vertical, 7)
                    .background(
                        selected ? CCMColors.accentOrange : CCMColors.surface,
                        in: Capsule(style: .continuous)
                    )
                    .foregroundStyle(selected ? Color.white : CCMColors.textSecondary)
                    .overlay(
                        Capsule(style: .continuous)
                            .stroke(selected ? CCMColors.accentOrange : CCMColors.border, lineWidth: 1)
                    )
                }
            }
        }
    }

    private func taskCard(_ task: CCMTask) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top, spacing: 10) {
                statusPill(task.status)
                Text(task.title)
                    .font(.system(size: 15, weight: .bold, design: .rounded))
                    .foregroundStyle(CCMColors.textPrimary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                Button(role: .destructive) {
                    pendingDeleteTask = task
                } label: {
                    Image(systemName: "trash")
                        .font(.system(size: 13, weight: .bold))
                }
                .buttonStyle(.plain)
                .foregroundStyle(CCMColors.danger)
                .disabled(viewModel.isPerformingTaskAction)
            }

            HStack(spacing: 10) {
                tagChip(task.branch?.isEmpty == false ? task.branch! : "main", color: CCMColors.textMuted)
                tagChip(task.mode?.uppercased() ?? "-", color: CCMColors.accentTeal)
                if task.status == "in_progress" {
                    tagChip("Live", color: CCMColors.ok)
                }
            }

            if task.status == "pending" {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(viewModel.adapters) { adapter in
                            Button(adapter.displayLabel) {
                                Task {
                                    await viewModel.startTask(task, mode: adapter.name)
                                }
                            }
                            .font(.system(size: 12, weight: .bold, design: .rounded))
                            .padding(.horizontal, 10)
                            .padding(.vertical, 8)
                            .background(CCMColors.fromHex(adapter.color) ?? CCMColors.accentTeal, in: Capsule(style: .continuous))
                            .foregroundStyle(.white)
                            .disabled(viewModel.isPerformingTaskAction)
                        }
                    }
                }
            } else if task.status == "in_progress" {
                HStack(spacing: 8) {
                    Button {
                        Task {
                            await viewModel.openNativeTerminal(task)
                        }
                    } label: {
                        Label("Terminal (Native)", systemImage: "terminal")
                            .font(.system(size: 12, weight: .bold, design: .rounded))
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .buttonBorderShape(.capsule)
                    .tint(CCMColors.accentTeal)
                    .disabled(viewModel.isTerminalConnecting || viewModel.isTerminalSending)

                    Button {
                        Task {
                            await viewModel.openWebTerminal(task)
                        }
                    } label: {
                        Label("Terminal (Web)", systemImage: "globe")
                            .font(.system(size: 12, weight: .bold, design: .rounded))
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.bordered)
                    .buttonBorderShape(.capsule)
                    .tint(CCMColors.accentOrange)
                }
            }
        }
        .padding(12)
        .background(CCMColors.surface, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .stroke(CCMColors.border, lineWidth: 1)
        )
    }

    private var settingsPane: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Connection")
                .font(.system(size: 14, weight: .bold, design: .rounded))
                .foregroundStyle(CCMColors.textSecondary)

            VStack(alignment: .leading, spacing: 6) {
                Text("Server URL")
                    .font(.system(size: 12, weight: .semibold, design: .rounded))
                    .foregroundStyle(CCMColors.textMuted)
                TextField("http://43.138.129.193:3000", text: $viewModel.serverURL)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .font(.system(size: 14, weight: .medium, design: .rounded))
                    .padding(10)
                    .background(CCMColors.surface, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                    .overlay(
                        RoundedRectangle(cornerRadius: 12, style: .continuous)
                            .stroke(CCMColors.border, lineWidth: 1)
                    )
            }

            VStack(alignment: .leading, spacing: 6) {
                HStack {
                    Text("CCM ACCESS_TOKEN")
                        .font(.system(size: 12, weight: .semibold, design: .rounded))
                        .foregroundStyle(CCMColors.textMuted)
                    Spacer()
                    Button(revealToken ? "Hide" : "Show") {
                        revealToken.toggle()
                    }
                    .font(.system(size: 11, weight: .bold, design: .rounded))
                    .foregroundStyle(CCMColors.accentTeal)
                }

                Group {
                    if revealToken {
                        TextField("Optional", text: $viewModel.accessToken)
                    } else {
                        SecureField("Optional", text: $viewModel.accessToken)
                    }
                }
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .font(.system(size: 14, weight: .medium, design: .rounded))
                .padding(10)
                .background(CCMColors.surface, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .stroke(CCMColors.border, lineWidth: 1)
                )
            }

            HStack(spacing: 10) {
                Button {
                    Task {
                        await viewModel.saveConfiguration()
                    }
                } label: {
                    Label("Save & Sync", systemImage: "arrow.triangle.2.circlepath")
                        .font(.system(size: 13, weight: .bold, design: .rounded))
                }
                .buttonStyle(.borderedProminent)
                .buttonBorderShape(.capsule)
                .tint(CCMColors.accentOrange)
                .disabled(viewModel.isLoading)

                Button("Use Remote") {
                    viewModel.serverURL = "http://43.138.129.193:3000"
                }
                .buttonStyle(.bordered)
                .buttonBorderShape(.capsule)
                .tint(CCMColors.accentTeal)
            }

            Text("Token is stored in iOS Keychain. Leave blank if server auth is disabled.")
                .font(.system(size: 11, weight: .medium, design: .rounded))
                .foregroundStyle(CCMColors.textMuted)
        }
    }

    private var statusCard: some View {
        HStack(spacing: 8) {
            Circle()
                .fill(statusColor)
                .frame(width: 8, height: 8)
            Text(viewModel.statusText)
                .font(.system(size: 12, weight: .semibold, design: .rounded))
                .foregroundStyle(CCMColors.textSecondary)
                .lineLimit(2)
            Spacer()
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .background(CCMColors.surface.opacity(0.9), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .stroke(CCMColors.border.opacity(0.8), lineWidth: 1)
        )
    }

    private var statusColor: Color {
        switch viewModel.statusKind {
        case .neutral:
            return CCMColors.textMuted
        case .success:
            return CCMColors.ok
        case .warning:
            return CCMColors.warn
        case .error:
            return CCMColors.danger
        }
    }

    private func statusPill(_ status: String) -> some View {
        let normalized = status.lowercased()
        let color: Color
        let label: String

        switch normalized {
        case "pending":
            color = CCMColors.warn
            label = "PENDING"
        case "in_progress":
            color = CCMColors.accentTeal
            label = "RUNNING"
        case "done":
            color = CCMColors.ok
            label = "DONE"
        case "failed":
            color = CCMColors.danger
            label = "FAILED"
        default:
            color = CCMColors.textMuted
            label = normalized.uppercased()
        }

        return Text(label)
            .font(.system(size: 10, weight: .black, design: .rounded))
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(color.opacity(0.16), in: Capsule(style: .continuous))
            .overlay(
                Capsule(style: .continuous)
                    .stroke(color.opacity(0.8), lineWidth: 1)
            )
            .foregroundStyle(color)
    }

    private func tagChip(_ text: String, color: Color) -> some View {
        Text(text)
            .font(.system(size: 11, weight: .bold, design: .rounded))
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(CCMColors.surfaceSoft, in: Capsule(style: .continuous))
            .overlay(
                Capsule(style: .continuous)
                    .stroke(CCMColors.border, lineWidth: 1)
            )
            .foregroundStyle(color)
    }

    private func statCard(title: String, value: String, accent: Color) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title)
                .font(.system(size: 11, weight: .bold, design: .rounded))
                .foregroundStyle(CCMColors.textMuted)
            Text(value)
                .font(.system(size: 22, weight: .black, design: .rounded))
                .foregroundStyle(CCMColors.textPrimary)
            Rectangle()
                .fill(accent)
                .frame(height: 3)
                .clipShape(Capsule(style: .continuous))
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(10)
        .background(CCMColors.surface.opacity(0.9), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .stroke(CCMColors.border.opacity(0.85), lineWidth: 1)
        )
    }

    private func emptyCard(message: String) -> some View {
        Text(message)
            .font(.system(size: 13, weight: .medium, design: .rounded))
            .foregroundStyle(CCMColors.textSecondary)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(12)
            .background(CCMColors.surface, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .stroke(CCMColors.border, lineWidth: 1)
            )
    }

    private func nativeTerminalSheet(task: CCMTask) -> some View {
        NavigationStack {
            VStack(spacing: 0) {
                if viewModel.isTerminalConnecting {
                    HStack(spacing: 8) {
                        ProgressView()
                        Text("Connecting terminal...")
                            .font(.system(size: 12, weight: .medium, design: .rounded))
                            .foregroundStyle(CCMColors.textMuted)
                        Spacer()
                    }
                    .padding(10)
                }

                ScrollViewReader { proxy in
                    ScrollView {
                        Text(viewModel.terminalOutput.isEmpty ? "Terminal is ready. Run a command to start." : viewModel.terminalOutput)
                            .font(.system(size: 12, weight: .regular, design: .monospaced))
                            .foregroundStyle(CCMColors.textPrimary)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(12)
                            .id("terminal-bottom")
                    }
                    .background(CCMColors.surface)
                    .onChange(of: viewModel.terminalOutput.count) { _ in
                        withAnimation(.easeOut(duration: 0.12)) {
                            proxy.scrollTo("terminal-bottom", anchor: .bottom)
                        }
                    }
                }

                Divider()

                HStack(spacing: 8) {
                    TextField("Type command, e.g. /model", text: $viewModel.terminalInput)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .font(.system(size: 13, weight: .medium, design: .monospaced))
                        .padding(10)
                        .background(CCMColors.surface, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                        .overlay(
                            RoundedRectangle(cornerRadius: 12, style: .continuous)
                                .stroke(CCMColors.border, lineWidth: 1)
                        )
                        .onSubmit {
                            Task {
                                await viewModel.sendTerminalInput()
                            }
                        }

                    Button {
                        Task {
                            await viewModel.sendTerminalInput()
                        }
                    } label: {
                        if viewModel.isTerminalSending {
                            ProgressView()
                                .progressViewStyle(.circular)
                                .tint(.white)
                                .frame(width: 20, height: 20)
                        } else {
                            Label("Send", systemImage: "paperplane.fill")
                                .font(.system(size: 12, weight: .bold, design: .rounded))
                        }
                    }
                    .buttonStyle(.borderedProminent)
                    .buttonBorderShape(.capsule)
                    .tint(CCMColors.accentOrange)
                    .disabled(viewModel.terminalInput.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || viewModel.isTerminalSending)
                }
                .padding(10)
                .background(CCMColors.surfaceSoft)
            }
            .navigationTitle(task.title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarLeading) {
                    Button("Close") {
                        viewModel.closeNativeTerminal()
                    }
                }
            }
        }
    }

    private func webTerminalSheet(destination: CCMWebTerminalDestination) -> some View {
        NavigationStack {
            CCMEmbeddedTerminalWebView(url: destination.url)
                .ignoresSafeArea(edges: .bottom)
                .navigationTitle("\(destination.title) · Web")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .navigationBarLeading) {
                        Button("Close") {
                            viewModel.closeWebTerminal()
                        }
                    }
                }
        }
    }

    private func taskChatSheet(task: CCMTask) -> some View {
        NavigationStack {
            VStack(spacing: 0) {
                if viewModel.isChatLoading {
                    HStack {
                        ProgressView()
                        Text("Loading chat history...")
                            .font(.system(size: 12, weight: .medium, design: .rounded))
                            .foregroundStyle(CCMColors.textMuted)
                        Spacer()
                    }
                    .padding(12)
                }

                ScrollViewReader { proxy in
                    ScrollView {
                        LazyVStack(spacing: 8) {
                            ForEach(Array(viewModel.chatMessages.enumerated()), id: \.offset) { index, message in
                                chatBubble(message)
                                    .id(index)
                            }
                            if viewModel.chatMessages.isEmpty && !viewModel.isChatLoading {
                                emptyCard(message: "No chat history yet. Send the first message to this running task.")
                            }
                        }
                        .padding(12)
                    }
                    .onChange(of: viewModel.chatMessages.count) { _ in
                        guard !viewModel.chatMessages.isEmpty else { return }
                        withAnimation(.easeOut(duration: 0.2)) {
                            proxy.scrollTo(viewModel.chatMessages.count - 1, anchor: .bottom)
                        }
                    }
                }

                Divider()

                HStack(spacing: 8) {
                    TextField("Ask this task...", text: $viewModel.chatInput, axis: .vertical)
                        .lineLimit(1 ... 4)
                        .textInputAutocapitalization(.sentences)
                        .autocorrectionDisabled()
                        .padding(10)
                        .background(CCMColors.surface, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                        .overlay(
                            RoundedRectangle(cornerRadius: 12, style: .continuous)
                                .stroke(CCMColors.border, lineWidth: 1)
                        )

                    Button {
                        Task {
                            await viewModel.sendChatMessage()
                        }
                    } label: {
                        if viewModel.isChatSending {
                            ProgressView()
                                .progressViewStyle(.circular)
                                .tint(.white)
                                .frame(width: 20, height: 20)
                        } else {
                            Image(systemName: "arrow.up.circle.fill")
                                .font(.system(size: 22, weight: .bold))
                        }
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(
                        viewModel.chatInput.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                            ? CCMColors.textMuted
                            : CCMColors.accentOrange
                    )
                    .disabled(viewModel.isChatSending || viewModel.chatInput.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 10)
                .background(CCMColors.surfaceSoft)
            }
            .navigationTitle(task.title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarLeading) {
                    Button("Close") {
                        viewModel.closeTaskChat()
                    }
                }
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button {
                        Task {
                            await viewModel.loadChatHistory()
                        }
                    } label: {
                        Image(systemName: "arrow.clockwise")
                    }
                    .disabled(viewModel.isChatLoading || viewModel.isChatSending)
                }
            }
            .task {
                if viewModel.chatMessages.isEmpty {
                    await viewModel.loadChatHistory()
                }
            }
        }
    }

    private func chatBubble(_ message: CCMChatMessage) -> some View {
        let isUser = message.role == "user"

        return HStack {
            if isUser { Spacer(minLength: 30) }
            VStack(alignment: .leading, spacing: 4) {
                Text(isUser ? "You" : "Task Assistant")
                    .font(.system(size: 10, weight: .bold, design: .rounded))
                    .foregroundStyle(isUser ? Color.white.opacity(0.9) : CCMColors.textMuted)
                Text(message.text)
                    .font(.system(size: 13, weight: .medium, design: .rounded))
                    .foregroundStyle(isUser ? Color.white : CCMColors.textPrimary)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(10)
            .background(
                isUser ? CCMColors.accentTeal : CCMColors.surface,
                in: RoundedRectangle(cornerRadius: 12, style: .continuous)
            )
            .overlay(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .stroke(isUser ? CCMColors.accentTeal : CCMColors.border, lineWidth: 1)
            )
            .frame(maxWidth: 320, alignment: isUser ? .trailing : .leading)
            if !isUser { Spacer(minLength: 30) }
        }
    }
}

private struct CCMEmbeddedTerminalWebView: UIViewRepresentable {
    let url: URL

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.defaultWebpagePreferences.allowsContentJavaScript = true
        let webView = WKWebView(frame: .zero, configuration: config)
        webView.scrollView.keyboardDismissMode = .interactive
        webView.scrollView.contentInsetAdjustmentBehavior = .always
        webView.backgroundColor = UIColor.clear
        webView.isOpaque = false
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        if webView.url != url {
            webView.load(URLRequest(url: url))
        }
    }
}

private enum CCMColors {
    static let bgStart = Color(red: 0.97, green: 0.94, blue: 0.89)
    static let bgEnd = Color(red: 0.94, green: 0.90, blue: 0.84)
    static let surface = Color.white.opacity(0.92)
    static let surfaceSoft = Color(red: 0.98, green: 0.96, blue: 0.93)
    static let border = Color(red: 0.84, green: 0.80, blue: 0.74)
    static let textPrimary = Color(red: 0.18, green: 0.15, blue: 0.12)
    static let textSecondary = Color(red: 0.35, green: 0.30, blue: 0.25)
    static let textMuted = Color(red: 0.49, green: 0.44, blue: 0.38)
    static let accentOrange = Color(red: 0.82, green: 0.41, blue: 0.24)
    static let accentTeal = Color(red: 0.18, green: 0.56, blue: 0.51)
    static let ok = Color(red: 0.23, green: 0.55, blue: 0.38)
    static let warn = Color(red: 0.79, green: 0.56, blue: 0.20)
    static let danger = Color(red: 0.74, green: 0.29, blue: 0.29)
    static let shadow = Color.black.opacity(0.08)

    static func fromHex(_ hex: String?) -> Color? {
        guard let hex else { return nil }
        var clean = hex.trimmingCharacters(in: .whitespacesAndNewlines)
        if clean.hasPrefix("#") {
            clean.removeFirst()
        }
        guard clean.count == 6, let value = Int(clean, radix: 16) else {
            return nil
        }
        let red = Double((value >> 16) & 0xFF) / 255.0
        let green = Double((value >> 8) & 0xFF) / 255.0
        let blue = Double(value & 0xFF) / 255.0
        return Color(red: red, green: green, blue: blue)
    }
}

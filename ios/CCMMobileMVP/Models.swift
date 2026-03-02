import Foundation

struct CCMProject: Codable, Identifiable, Hashable {
    let id: String
    let name: String
    let repoPath: String?
    let sshHost: String?
    let createdAt: String?
}

struct CCMTask: Codable, Identifiable, Hashable {
    let id: String
    let title: String
    let status: String
    let projectId: String?
    let branch: String?
    let worktreePath: String?
    let model: String?
    let mode: String?
    let createdAt: String?
    let updatedAt: String?
}

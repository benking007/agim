import SwiftUI

struct PairingView: View {
    @Environment(AppSession.self) private var session
    @State private var pastePayload = ""
    @State private var host = ""
    @State private var token = ""

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text("Agim")
                        .font(.largeTitle.bold())
                    Text("把 Agent Portal（`/m/chat`）装进 macOS 窗口，随时打开。配对方式与 iOS 相同。")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }

                Section("粘贴配对链接") {
                    TextField("https://host/m/login?t=agim_… 或 agim://pair?…", text: $pastePayload, axis: .vertical)
                        .lineLimit(2...4)
                        .textFieldStyle(.roundedBorder)
                        .font(.system(.body, design: .monospaced))
                    Button("用粘贴内容连接") {
                        session.pair(pasted: pastePayload)
                    }
                    .disabled(pastePayload.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    .keyboardShortcut(.defaultAction)
                }

                Section("手动配对") {
                    TextField("主机 https://agent.example.com", text: $host)
                        .textFieldStyle(.roundedBorder)
                    SecureField("Token agim_…", text: $token)
                        .textFieldStyle(.roundedBorder)
                    Button("连接") {
                        session.pair(host: host, token: token)
                    }
                    .disabled(host.trimmingCharacters(in: .whitespaces).isEmpty
                        || token.trimmingCharacters(in: .whitespaces).isEmpty)
                }

                if let err = session.pairingError {
                    Section {
                        Text(err)
                            .foregroundStyle(.red)
                            .font(.footnote)
                            .textSelection(.enabled)
                    }
                }

                Section {
                    Text("链接来自 Web 控制台：Settings → Mobile（同一套 QR / 登录 URL）。Token 保存在本机 Keychain。菜单栏可「重新加载」或「退出配对」。")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .formStyle(.grouped)
            .padding(20)
            .frame(maxWidth: 520)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .navigationTitle("配对 Agim")
        }
    }
}

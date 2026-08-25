import SwiftUI

struct PairingView: View {
    @Environment(AppSession.self) private var session
    @State private var pastePayload = ""
    @State private var host = ""

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text("Agim")
                        .font(.largeTitle.bold())
                    Text("把 Agent Portal（`/m/chat`）装进 macOS 窗口。先填写主机地址；未登录时会打开账号登录页。")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }

                Section("粘贴主机地址") {
                    TextField("https://agent.example.com", text: $pastePayload, axis: .vertical)
                        .lineLimit(2...4)
                        .textFieldStyle(.roundedBorder)
                        .font(.system(.body, design: .monospaced))
                    Button("用粘贴内容连接") {
                        session.pair(pasted: pastePayload)
                    }
                    .disabled(pastePayload.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    .keyboardShortcut(.defaultAction)
                }

                Section("手动填写") {
                    TextField("主机 https://agent.example.com", text: $host)
                        .textFieldStyle(.roundedBorder)
                    Button("连接") {
                        session.pair(host: host)
                    }
                    .disabled(host.trimmingCharacters(in: .whitespaces).isEmpty)
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
                    Text("只保存主机地址。登录用网页的用户名/密码，会话 cookie（`agim_session`）留在本机 WebView。菜单栏可「重新加载」或「退出配对」。")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .formStyle(.grouped)
            .padding(20)
            .frame(maxWidth: 520)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .navigationTitle("连接 Agim")
        }
    }
}

import SwiftUI

struct PairingView: View {
    @Environment(AppSession.self) private var session
    @State private var host = ""
    @State private var showScanner = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text("Agim")
                        .font(.largeTitle.bold())
                    Text("填写主机地址进入 Agent Portal。没有会话时会打开登录页，用账号密码登录。")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
                .listRowBackground(Color.clear)

                Section("扫描主机地址") {
                    Button {
                        showScanner = true
                    } label: {
                        Label("扫描 https:// 链接", systemImage: "qrcode.viewfinder")
                    }
                }

                Section("手动填写") {
                    TextField("主机 https://agent.example.com", text: $host)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.URL)
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
                    }
                }

                Section {
                    Text("只保存主机地址。登录会话（`agim_session` cookie）留在本机 WebView，与浏览器相同。")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            .navigationTitle("连接")
            .sheet(isPresented: $showScanner) {
                QRScannerView { code in
                    showScanner = false
                    if let parsed = PairingParser.parse(code) {
                        session.pair(parsed)
                    } else {
                        session.pairingError = "无法识别主机地址，请扫描 https:// 链接"
                    }
                } onCancel: {
                    showScanner = false
                }
            }
        }
    }
}

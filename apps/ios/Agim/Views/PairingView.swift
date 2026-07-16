import SwiftUI

struct PairingView: View {
    @Environment(AppSession.self) private var session
    @State private var host = ""
    @State private var token = ""
    @State private var showScanner = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text("Agim")
                        .font(.largeTitle.bold())
                    Text("扫描后台 Mobile 二维码，或粘贴主机与 Token。")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
                .listRowBackground(Color.clear)

                Section("扫码") {
                    Button {
                        showScanner = true
                    } label: {
                        Label("扫描配对二维码", systemImage: "qrcode.viewfinder")
                    }
                }

                Section("手动配对") {
                    TextField("主机 https://agent.example.com", text: $host)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.URL)
                    SecureField("Token agim_…", text: $token)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
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
                    }
                }

                Section {
                    Text("二维码来自 Web 控制台：Settings → Mobile。Token 保存在本机 Keychain。")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            .navigationTitle("配对")
            .sheet(isPresented: $showScanner) {
                QRScannerView { code in
                    showScanner = false
                    if let parsed = PairingParser.parse(code) {
                        session.pair(parsed)
                    } else {
                        session.pairingError = "二维码无法识别，请确认来自 Agim Mobile 配对页"
                    }
                } onCancel: {
                    showScanner = false
                }
            }
        }
    }
}

import SwiftUI

struct RootView: View {
    @Environment(AppSession.self) private var session

    var body: some View {
        Group {
            if let creds = session.credentials {
                WebShellView(credentials: creds)
            } else {
                PairingView()
            }
        }
    }
}

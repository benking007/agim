import SwiftUI

struct RootView: View {
    @Environment(AppSession.self) private var session

    var body: some View {
        Group {
            if session.isPaired {
                ChatView()
            } else {
                PairingView()
            }
        }
    }
}

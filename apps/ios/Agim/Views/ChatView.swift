import SwiftUI

struct ChatView: View {
    @Environment(AppSession.self) private var session
    @State private var draft = ""
    @State private var showMenu = false
    @FocusState private var focused: Bool

    private var store: ChatStore { session.chat }

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            messageList
            if let err = store.error {
                errorBanner(err)
            }
            ApprovalDockView(
                approvals: store.pendingApprovals,
                onDecide: { id, choice in store.approvalAction(messageId: id, choice: choice) }
            )
            AskDockView(
                asks: store.pendingAsks,
                onSubmit: { id, data in store.choiceAction(messageId: id, data: data) }
            )
            if let act = store.activeActivity, act.status == .running {
                runningRail(act)
            }
            ComposerView(
                text: $draft,
                focused: $focused,
                busy: store.isBusy,
                disabled: store.status != .open,
                onSend: {
                    let t = draft
                    draft = ""
                    store.send(t)
                }
            )
        }
        .background(Color(.systemBackground))
        .confirmationDialog("菜单", isPresented: $showMenu, titleVisibility: .visible) {
            Button("新会话") { store.newConversation() }
            Button("退出登录", role: .destructive) { session.logout() }
            Button("取消", role: .cancel) {}
        }
    }

    private var header: some View {
        HStack(spacing: 12) {
            VStack(spacing: 2) {
                Text(store.agent.isEmpty ? "Agim" : displayAgent(store.agent))
                    .font(.headline)
                    .lineLimit(1)
                HStack(spacing: 6) {
                    Circle()
                        .fill(statusColor)
                        .frame(width: 7, height: 7)
                    Text(statusLabel)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            }
            .frame(maxWidth: .infinity)

            Menu {
                ForEach(store.agents, id: \.self) { name in
                    Button {
                        store.switchAgent(name)
                    } label: {
                        if name == store.agent {
                            Label(displayAgent(name), systemImage: "checkmark")
                        } else {
                            Text(displayAgent(name))
                        }
                    }
                }
            } label: {
                Image(systemName: "cpu")
                    .frame(width: 36, height: 36)
            }
            .disabled(store.agents.isEmpty)

            Button {
                showMenu = true
            } label: {
                Image(systemName: "ellipsis")
                    .frame(width: 36, height: 36)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .background(.bar)
    }

    private var messageList: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 12) {
                    if store.messages.isEmpty {
                        emptyState
                    }
                    ForEach(store.messages) { msg in
                        MessageBubbleView(message: msg)
                            .id(msg.id)
                    }
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 16)
            }
            .onChange(of: store.messages.last?.content) { _, _ in
                if let id = store.messages.last?.id {
                    withAnimation { proxy.scrollTo(id, anchor: .bottom) }
                }
            }
            .onChange(of: store.messages.count) { _, _ in
                if let id = store.messages.last?.id {
                    proxy.scrollTo(id, anchor: .bottom)
                }
            }
        }
    }

    private var emptyState: some View {
        VStack(spacing: 8) {
            Text("开始对话")
                .font(.title3.weight(.semibold))
            Text(store.hostLabel)
                .font(.caption)
                .foregroundStyle(.secondary)
            Text("输入消息，或从菜单切换 Agent / 新会话。")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
        .padding(.top, 80)
    }

    private func runningRail(_ act: ChatActivity) -> some View {
        HStack {
            ProgressView()
                .controlSize(.small)
            Text("处理中")
                .font(.caption.weight(.medium))
            Spacer()
            Text("\(displayAgent(store.agent)) · \(formatDuration(act))")
                .font(.caption2)
                .foregroundStyle(.secondary)
                .lineLimit(1)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
        .background(Color.accentColor.opacity(0.08))
    }

    private func errorBanner(_ text: String) -> some View {
        HStack {
            Text(text)
                .font(.footnote)
                .foregroundStyle(.red)
            Spacer()
            Button("关闭") { store.clearError() }
                .font(.footnote)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
        .background(Color.red.opacity(0.08))
    }

    private var statusColor: Color {
        switch store.status {
        case .open: return .green
        case .connecting: return .orange
        case .closed, .error: return .gray
        }
    }

    private var statusLabel: String {
        if store.activeRunId != nil { return "处理中" }
        switch store.status {
        case .open: return "已连接"
        case .connecting: return "连接中"
        case .closed: return "已断开"
        case .error: return "出错"
        }
    }

    private func displayAgent(_ raw: String) -> String {
        raw.replacingOccurrences(of: "-", with: " ").capitalized
    }

    private func formatDuration(_ act: ChatActivity) -> String {
        let ms = act.durationMs ?? max(0, Date().timeIntervalSince(act.startedAt) * 1000)
        if ms < 1000 { return "\(Int(ms))ms" }
        return String(format: "%.1fs", ms / 1000)
    }
}

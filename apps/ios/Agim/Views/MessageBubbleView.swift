import SwiftUI

struct MessageBubbleView: View {
    let message: ChatMessage

    var body: some View {
        HStack {
            if message.role == .user { Spacer(minLength: 48) }
            VStack(alignment: message.role == .user ? .trailing : .leading, spacing: 6) {
                if message.role == .assistant, let agent = message.agent, !agent.isEmpty {
                    Text(agent)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
                if let activity = message.activity {
                    ActivityBlockView(activity: activity)
                }
                if !message.content.isEmpty || message.role == .user {
                    contentBody
                } else if message.role == .assistant {
                    Text("…")
                        .font(.body)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 10)
                        .background(Color(.secondarySystemBackground))
                        .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
                }
            }
            if message.role == .assistant { Spacer(minLength: 48) }
        }
        .contextMenu {
            if !message.content.isEmpty {
                Button {
                    UIPasteboard.general.string = message.content
                } label: {
                    Label("复制", systemImage: "doc.on.doc")
                }
            }
        }
    }

    @ViewBuilder
    private var contentBody: some View {
        let text = message.content.isEmpty && message.role == .assistant ? "…" : message.content
        Group {
            if message.role == .assistant {
                Text(markdownAttributed(text))
                    .font(.body)
                    .textSelection(.enabled)
            } else {
                Text(text)
                    .font(.body)
                    .textSelection(.enabled)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .background(bubbleColor)
        .foregroundStyle(message.role == .user ? Color.white : Color.primary)
        .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
    }

    private var bubbleColor: Color {
        message.role == .user
            ? Color.accentColor
            : Color(.secondarySystemBackground)
    }

    private func markdownAttributed(_ raw: String) -> AttributedString {
        if let attr = try? AttributedString(
            markdown: raw,
            options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        ) {
            return attr
        }
        return AttributedString(raw)
    }
}

struct ActivityBlockView: View {
    let activity: ChatActivity
    @State private var expanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Button {
                expanded.toggle()
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: statusIcon)
                        .foregroundStyle(statusColor)
                    Text(statusTitle)
                        .font(.caption.weight(.medium))
                    if let ms = activity.durationMs {
                        Text(ms < 1000 ? "\(Int(ms))ms" : String(format: "%.1fs", ms / 1000))
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                    Spacer(minLength: 0)
                    Image(systemName: expanded ? "chevron.up" : "chevron.down")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            }
            .buttonStyle(.plain)

            if expanded {
                ForEach(activity.steps) { step in
                    HStack(alignment: .top, spacing: 6) {
                        Text(step.status == "running" ? "●" : "○")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(step.label)
                                .font(.caption)
                            if let preview = step.preview, !preview.isEmpty {
                                Text(preview)
                                    .font(.caption2)
                                    .foregroundStyle(.secondary)
                                    .lineLimit(3)
                            }
                        }
                    }
                }
            }
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(.tertiarySystemBackground))
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
    }

    private var statusIcon: String {
        switch activity.status {
        case .running: return "arrow.triangle.2.circlepath"
        case .success: return "checkmark.circle.fill"
        case .error: return "xmark.circle.fill"
        }
    }

    private var statusColor: Color {
        switch activity.status {
        case .running: return .accentColor
        case .success: return .green
        case .error: return .red
        }
    }

    private var statusTitle: String {
        switch activity.status {
        case .running: return "处理中"
        case .success: return "已完成"
        case .error: return "失败"
        }
    }
}

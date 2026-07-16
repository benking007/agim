import SwiftUI

struct ApprovalDockView: View {
    let approvals: [PendingApproval]
    var onDecide: (_ messageId: String, _ choice: String) -> Void

    var body: some View {
        if !approvals.isEmpty {
            VStack(alignment: .leading, spacing: 10) {
                ForEach(approvals) { item in
                    VStack(alignment: .leading, spacing: 8) {
                        Text("需要批准")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.orange)
                        Text(item.prompt.toolName)
                            .font(.subheadline.weight(.semibold))
                        Text(item.prompt.inputJson)
                            .font(.caption2.monospaced())
                            .foregroundStyle(.secondary)
                            .lineLimit(6)
                        HStack(spacing: 8) {
                            Button("允许") { onDecide(item.messageId, "y") }
                                .buttonStyle(.borderedProminent)
                            if item.prompt.mode != "explicit" {
                                Button("始终允许") { onDecide(item.messageId, "a") }
                                    .buttonStyle(.bordered)
                            }
                            Button("拒绝", role: .destructive) { onDecide(item.messageId, "n") }
                                .buttonStyle(.bordered)
                        }
                        .font(.subheadline)
                    }
                    .padding(12)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color.orange.opacity(0.08))
                    .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
        }
    }
}

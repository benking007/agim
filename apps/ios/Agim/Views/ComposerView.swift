import SwiftUI

struct ComposerView: View {
    @Binding var text: String
    var focused: FocusState<Bool>.Binding
    var busy: Bool
    var disabled: Bool
    var onSend: () -> Void

    var body: some View {
        HStack(alignment: .bottom, spacing: 10) {
            TextField("输入消息…", text: $text, axis: .vertical)
                .font(.body)
                .lineLimit(1...6)
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
                .background(Color(.secondarySystemBackground))
                .clipShape(RoundedRectangle(cornerRadius: 22, style: .continuous))
                .focused(focused)
                .disabled(disabled)
                .submitLabel(.send)
                .onSubmit {
                    if canSend { onSend() }
                }

            Button(action: onSend) {
                Group {
                    if busy && text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                        ProgressView()
                    } else {
                        Image(systemName: "arrow.up")
                            .font(.body.weight(.semibold))
                            .foregroundStyle(.white)
                    }
                }
                .frame(width: 44, height: 44)
                .background(canSend ? Color.accentColor : Color.gray.opacity(0.4))
                .clipShape(Circle())
            }
            .disabled(!canSend)
            .accessibilityLabel("发送")
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(.bar)
    }

    private var canSend: Bool {
        // Hard-disable only when the socket/session is not ready.
        // In-flight replies are gated inside ChatStore.send.
        !disabled && !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
}

import SwiftUI

struct AskDockView: View {
    let asks: [PendingAsk]
    var onSubmit: (_ messageId: String, _ data: String) -> Void
    @State private var customText: [String: String] = [:]
    @State private var multiSelected: [String: Set<Int>] = [:]

    var body: some View {
        if !asks.isEmpty {
            VStack(alignment: .leading, spacing: 10) {
                ForEach(asks) { item in
                    askCard(item)
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
        }
    }

    @ViewBuilder
    private func askCard(_ item: PendingAsk) -> some View {
        let meta = item.prompt.meta
        VStack(alignment: .leading, spacing: 8) {
            if let title = item.prompt.title, !title.isEmpty {
                Text(title)
                    .font(.subheadline.weight(.semibold))
            }
            Text(item.prompt.body)
                .font(.subheadline)

            if meta?.selectionMode == "multi" {
                multiSection(item)
            } else {
                ForEach(Array(item.prompt.choices.enumerated()), id: \.offset) { _, choice in
                    Button(choice.label) {
                        onSubmit(item.messageId, choice.data)
                    }
                    .buttonStyle(.bordered)
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
            }

            if meta?.allowCustomInput == true {
                HStack {
                    TextField(meta?.customInputLabel ?? "自定义…", text: bindingCustom(item.messageId))
                        .textFieldStyle(.roundedBorder)
                        .font(.body)
                    Button("提交") {
                        submitCustom(item)
                    }
                    .disabled((customText[item.messageId] ?? "").trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.blue.opacity(0.08))
        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
    }

    @ViewBuilder
    private func multiSection(_ item: PendingAsk) -> some View {
        let meta = item.prompt.meta
        ForEach(Array(item.prompt.choices.enumerated()), id: \.offset) { idx, choice in
            Toggle(isOn: bindingMulti(item.messageId, index: idx)) {
                Text(choice.label)
                    .font(.subheadline)
            }
        }
        Button("提交所选") {
            submitMulti(item)
        }
        .buttonStyle(.borderedProminent)
        .disabled(!multiValid(item))
        if let meta {
            Text("选择 \(meta.minSelections)–\(meta.maxSelections) 项")
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
    }

    private func bindingCustom(_ id: String) -> Binding<String> {
        Binding(
            get: { customText[id] ?? "" },
            set: { customText[id] = $0 }
        )
    }

    private func bindingMulti(_ id: String, index: Int) -> Binding<Bool> {
        Binding(
            get: { multiSelected[id, default: []].contains(index) },
            set: { on in
                var set = multiSelected[id, default: []]
                if on { set.insert(index) } else { set.remove(index) }
                multiSelected[id] = set
            }
        )
    }

    private func multiValid(_ item: PendingAsk) -> Bool {
        guard let meta = item.prompt.meta else { return false }
        let n = multiSelected[item.messageId, default: []].count
        return n >= meta.minSelections && n <= meta.maxSelections
    }

    private func submitMulti(_ item: PendingAsk) {
        guard let meta = item.prompt.meta else { return }
        let idxs = multiSelected[item.messageId, default: []].sorted().map { String($0 + 1) }.joined(separator: ",")
        let data = "ask:\(meta.reqId):multi:\(idxs)"
        onSubmit(item.messageId, data)
    }

    private func submitCustom(_ item: PendingAsk) {
        guard let meta = item.prompt.meta else { return }
        let raw = (customText[item.messageId] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !raw.isEmpty else { return }
        let encoded = Data(raw.utf8).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
        let data = "ask:\(meta.reqId):custom:\(encoded)"
        onSubmit(item.messageId, data)
    }
}

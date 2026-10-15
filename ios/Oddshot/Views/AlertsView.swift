import SwiftUI

struct AlertsView: View {
    @Environment(AppModel.self) private var model
    @State private var editing: Subscription?
    @State private var simulating = false

    var body: some View {
        NavigationStack {
            List {
                Section {
                    personaGrid
                        .listRowInsets(EdgeInsets())
                        .listRowBackground(Color.clear)
                } header: {
                    SectionLabel(text: "Quick start", symbol: "person.crop.rectangle.stack.fill")
                }

                Section {
                    subscriptionRows
                } header: {
                    SectionLabel(text: "Your alerts", symbol: "bell.badge.fill")
                } footer: {
                    Text("Alerts are stored on your Oddshot server. Matching spikes trigger a notification on this phone while the app is running, and any webhook you configure (ntfy, Discord, Slack).")
                        .font(.caption)
                        .foregroundStyle(Theme.faint)
                }

                Section {
                    Button {
                        simulating = true
                        Task { await model.simulateSpike(); simulating = false }
                    } label: {
                        HStack {
                            Label("Simulate spike", systemImage: "wand.and.stars")
                                .font(.headline)
                            Spacer()
                            if simulating { ProgressView().tint(Theme.accent) }
                        }
                    }
                    .tint(Theme.accent)
                    .listRowBackground(Theme.panel)
                } footer: {
                    Text("Injects a synthetic DEMO spike through the full pipeline — matching, webhooks, and the live feed.")
                        .font(.caption)
                        .foregroundStyle(Theme.faint)
                }
            }
            .listStyle(.insetGrouped)
            .oddshotScreen()
            .navigationTitle("Alerts")
            .toolbar {
                ToolbarItem(placement: .topBarLeading) { RoleMenu(compact: true) }
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        ForEach(Persona.allCases) { p in
                            Button { editing = p.preset } label: { Label(p.label, systemImage: p.symbol) }
                        }
                    } label: {
                        Image(systemName: "plus.circle.fill").font(.title3).foregroundStyle(Theme.accent)
                    }
                    .accessibilityLabel("New alert")
                }
            }
            .refreshable { await model.loadSubscriptions() }
            .task { await model.loadSubscriptions() }
            .sheet(item: $editing) { sub in
                SubscriptionEditor(original: sub)
            }
        }
    }

    private var personaGrid: some View {
        LazyVGrid(columns: [GridItem(.flexible(), spacing: 10), GridItem(.flexible(), spacing: 10)], spacing: 10) {
            ForEach(Persona.allCases.filter { $0 != .general }) { p in
                Button { editing = p.preset } label: {
                    VStack(alignment: .leading, spacing: 6) {
                        Image(systemName: p.symbol)
                            .font(.system(size: 18, weight: .bold))
                            .foregroundStyle(Theme.accent)
                        Text(p.label).font(.system(size: 15, weight: .bold)).foregroundStyle(.white)
                        Text(p.blurb).font(.system(size: 11)).foregroundStyle(Theme.dim)
                            .multilineTextAlignment(.leading)
                            .lineLimit(2, reservesSpace: true)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .panel(padding: 12)
                }
                .buttonStyle(.plain)
            }
        }
    }

    @ViewBuilder private var subscriptionRows: some View {
        switch model.subsState {
        case .loading where model.subscriptions.isEmpty, .idle:
            HStack { Spacer(); ProgressView().tint(Theme.accent); Spacer() }
                .listRowBackground(Theme.panel)
        case .failed(let msg) where model.subscriptions.isEmpty:
            StateMessage(symbol: "bell.slash.fill", title: "Couldn’t load alerts", message: msg, actionTitle: "Retry") {
                Task { await model.loadSubscriptions() }
            }
            .listRowBackground(Theme.panel)
        default:
            if model.subscriptions.isEmpty {
                StateMessage(symbol: "bell.and.waves.left.and.right", title: "No alerts yet",
                             message: "Pick a persona above or tap + to build your own.")
                    .listRowBackground(Theme.panel)
            }
            ForEach(model.subscriptions) { sub in
                Button { editing = sub } label: { SubscriptionRow(sub: sub) }
                    .listRowBackground(Theme.panel)
                    .listRowSeparatorTint(Theme.stroke)
                    .swipeActions {
                        Button(role: .destructive) { Task { await model.delete(sub) } } label: {
                            Label("Delete", systemImage: "trash")
                        }
                    }
            }
        }
    }
}

struct SubscriptionRow: View {
    let sub: Subscription
    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: sub.match.marketIds.isEmpty ? sub.persona.symbol : "eye.fill")
                .font(.system(size: 15, weight: .bold))
                .foregroundStyle(Theme.accent)
                .frame(width: 34, height: 34)
                .background(Theme.accent.opacity(0.12), in: RoundedRectangle(cornerRadius: 9, style: .continuous))
            VStack(alignment: .leading, spacing: 3) {
                Text(sub.name).font(.system(size: 15, weight: .semibold)).foregroundStyle(.white).lineLimit(1)
                Text(sub.summary).font(.system(size: 12)).foregroundStyle(Theme.dim).lineLimit(2)
            }
            Spacer()
            if let w = sub.webhook, !w.url.isEmpty {
                Badge(text: w.type.label.uppercased(), color: Theme.info)
            }
            Image(systemName: "chevron.right").font(.system(size: 12, weight: .bold)).foregroundStyle(Theme.faint)
        }
        .padding(.vertical, 2)
    }
}

// MARK: - Editor

struct SubscriptionEditor: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let original: Subscription
    @State private var sub: Subscription
    @State private var keywords: String
    @State private var webhookOn: Bool
    @State private var webhook: Webhook
    @State private var saving = false
    @State private var error: String?
    @State private var testResult: String?

    init(original: Subscription) {
        self.original = original
        _sub = State(initialValue: original)
        _keywords = State(initialValue: original.match.keywords.joined(separator: ", "))
        _webhookOn = State(initialValue: original.webhook.map { !$0.url.isEmpty } ?? false)
        _webhook = State(initialValue: original.webhook ?? Webhook(type: .ntfy, url: ""))
    }

    private var isNew: Bool { original.id.isEmpty }

    var body: some View {
        NavigationStack {
            Form {
                Section("Name") {
                    TextField("e.g. Lakers game shooters", text: $sub.name)
                    Picker("Persona", selection: $sub.persona) {
                        ForEach(Persona.allCases) { Label($0.label, systemImage: $0.symbol).tag($0) }
                    }
                    .onChange(of: sub.persona) { _, p in
                        guard isNew else { return }
                        let preset = p.preset
                        sub.match.categories = preset.match.categories
                        sub.minDelta = preset.minDelta
                        sub.liveOnly = preset.liveOnly
                        if sub.name.isEmpty || Persona.allCases.map(\.preset.name).contains(sub.name) { sub.name = preset.name }
                    }
                }

                Section {
                    FlowChips(all: MarketCategory.known, selected: Set(sub.match.categories)) { cat in
                        if let i = sub.match.categories.firstIndex(of: cat.raw) { sub.match.categories.remove(at: i) }
                        else { sub.match.categories.append(cat.raw) }
                    }
                    .padding(.vertical, 4)
                } header: {
                    Text("Categories")
                } footer: {
                    Text(sub.match.categories.isEmpty ? "None selected = any category." : "")
                }

                Section {
                    TextField("lakers, fed, taylor swift", text: $keywords)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    if !sub.match.marketIds.isEmpty {
                        ForEach(sub.match.marketIds, id: \.self) { id in
                            Label(id, systemImage: "eye").font(Theme.mono(12)).foregroundStyle(Theme.dim)
                        }
                    }
                } header: {
                    Text("Keywords")
                } footer: {
                    Text("Comma-separated. Matches market titles and tags, case-insensitive.")
                }

                Section("Sensitivity") {
                    VStack(alignment: .leading) {
                        HStack {
                            Text("Minimum move")
                            Spacer()
                            Text("\(Int((sub.minDelta * 100).rounded())) pts")
                                .font(Theme.mono(15, .bold))
                                .foregroundStyle(Theme.accent)
                                .contentTransition(.numericText(value: sub.minDelta))
                                .animation(.snappy, value: sub.minDelta)
                        }
                        Slider(value: $sub.minDelta, in: 0.01...0.30, step: 0.01)
                            .tint(Theme.accent)
                    }
                    Picker("Minimum severity", selection: $sub.minSeverity) {
                        ForEach(Severity.allCases) { Text($0.label).tag($0) }
                    }
                    .pickerStyle(.segmented)
                    Toggle("Live events only", isOn: $sub.liveOnly).tint(Theme.accent)
                }

                Section {
                    Toggle("Send to webhook", isOn: $webhookOn.animation()).tint(Theme.accent)
                    if webhookOn {
                        Picker("Type", selection: $webhook.type) {
                            ForEach(Webhook.Kind.allCases) { Text($0.label).tag($0) }
                        }
                        TextField(webhook.type == .ntfy ? "https://ntfy.sh/your-secret-topic" : "https://…", text: $webhook.url)
                            .keyboardType(.URL)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                        if !isNew {
                            Button("Send test alert") { Task { await sendTest() } }
                            if let testResult { Text(testResult).font(.footnote).foregroundStyle(Theme.dim) }
                        }
                    }
                } header: {
                    Text("Phone push when the app is closed")
                } footer: {
                    Text("Install the free ntfy app, subscribe to a hard-to-guess topic, and paste https://ntfy.sh/<topic> here with type ntfy.sh.")
                }

                if let error {
                    Section { Text(error).foregroundStyle(Theme.down) }
                }

                if !isNew {
                    Section {
                        Button("Delete alert", role: .destructive) {
                            Task { await model.delete(original); dismiss() }
                        }
                    }
                }
            }
            .scrollContentBackground(.hidden)
            .background(Theme.bg)
            .navigationTitle(isNew ? "New alert" : "Edit alert")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    if saving { ProgressView() } else {
                        Button("Save") { Task { await save() } }.bold()
                            .disabled(sub.name.trimmingCharacters(in: .whitespaces).isEmpty)
                    }
                }
            }
        }
        .presentationDragIndicator(.visible)
        .tint(Theme.accent)
    }

    private func composed() -> Subscription {
        var s = sub
        s.name = s.name.trimmingCharacters(in: .whitespaces)
        s.match.keywords = keywords.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces).lowercased() }.filter { !$0.isEmpty }
        s.webhook = webhookOn && !webhook.url.trimmingCharacters(in: .whitespaces).isEmpty ? webhook : nil
        return s
    }

    private func save() async {
        saving = true; error = nil
        defer { saving = false }
        do {
            try await model.save(composed())
            dismiss()
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func sendTest() async {
        guard let api = model.api else { return }
        testResult = "Sending…"
        do {
            try await model.save(composed()) // make sure the server has the latest URL
            let r = try await api.test(subscriptionId: original.id)
            testResult = r.ok ? "Delivered ✓" : "Failed: \(r.error ?? "unknown error")"
        } catch {
            testResult = "Failed: \(error.localizedDescription)"
        }
    }
}

struct FlowChips: View {
    let all: [MarketCategory]
    let selected: Set<String>
    let toggle: (MarketCategory) -> Void

    var body: some View {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 104), spacing: 8)], spacing: 8) {
            ForEach(all) { c in
                let on = selected.contains(c.raw)
                Button { toggle(c) } label: {
                    Label(c.label, systemImage: c.symbol)
                        .font(.system(size: 12, weight: .bold))
                        .lineLimit(1)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 8)
                        .foregroundStyle(on ? Color.black : Color.white.opacity(0.8))
                        .background(on ? Theme.accent : Theme.panelHi, in: Capsule())
                }
                .buttonStyle(.plain)
            }
        }
    }
}

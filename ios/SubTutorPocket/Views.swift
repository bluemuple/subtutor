// SubTutor Pocket – 화면: 작품별 대사 목록(탭 = 받아서 재생, Saved 아이콘, 🎙 녹음, 같이 듣기),
// 상단 바(앱 아이콘 · ⬇ 전체 다운로드 · 자막/뜻 가림 · 반복 토글(길게 = 재생 속도) · 설정), 검색 · 정렬 · 태그,
// 대사별 속도 사다리 · 메모 펼치기 · 발음 확인, 하단 연속 듣기 막대, 설정(동기화)
import SwiftUI
import UIKit

// 손끝 진동: 재생·사다리·메모·녹음·같이 듣기·반복·알아요
enum Haptic {
    static func tap() { UIImpactFeedbackGenerator(style: .light).impactOccurred() }
    static func press() { UIImpactFeedbackGenerator(style: .medium).impactOccurred() }
    static func success() { UINotificationFeedbackGenerator().notificationOccurred(.success) }
}

func rateText(_ r: Double) -> String { abs(r - 1) < 0.001 ? "1" : String(format: "%g", r) }

// 펼치기: 내용의 실제 높이를 재 두고 0 ↔ 그 높이로 바꿔, 위는 그대로 두고 아래로 커튼처럼 펼치고 위로 접는다
// (목록 행 안에서 if 로 넣고 빼면 행 높이가 바뀌는 동안 내용이 가운데 기준으로 움직여 위·아래 줄과 겹쳐 보인다)
private struct HeightKey: PreferenceKey {
    static var defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = max(value, nextValue()) }
}
struct Reveal<Content: View>: View {
    let open: Bool
    @ViewBuilder let content: Content
    @State private var height: CGFloat = 0
    var body: some View {
        content
            .fixedSize(horizontal: false, vertical: true)
            .background(GeometryReader { g in Color.clear.preference(key: HeightKey.self, value: g.size.height) })
            .onPreferenceChange(HeightKey.self) { height = $0 }
            .frame(height: open ? height : 0, alignment: .top)
            .clipped()
            .opacity(open ? 1 : 0)
            .accessibilityHidden(!open)
    }
}

// 작품으로 거르기: 한 작품의 모든 회차, 또는 한 회차 (Work.id = 제목 + \u{1} + 회차)
enum WorkFilter: Equatable {
    case title(String)
    case work(String)
    func matches(_ it: Item) -> Bool {
        switch self {
        case .title(let t): return it.title == t
        case .work(let id): return it.title + "\u{1}" + it.episode == id
        }
    }
}

extension View {
    // 아이폰에서도 시트가 아니라 말풍선(드롭다운)으로 띄운다
    @ViewBuilder func popoverOnPhone() -> some View {
        if #available(iOS 16.4, *) { self.presentationCompactAdaptation(.popover) } else { self }
    }
}

// 작품 고르기 드롭다운: 맨 위 "전체 작품", 그 아래 작품명(최근 저장 순). 회차가 여럿인 작품은 누르면 그 아래로
// "이 작품 전체"와 시즌·회차가 펼쳐지고, 다시 누르면 접힌다. 회차가 하나뿐인 작품은 누르면 바로 고른다
struct WorkPicker: View {
    @EnvironmentObject var store: Store
    @Binding var selection: WorkFilter?
    let items: [Item]          // 지금 보이는 대사들 (학습 중 또는 ✓ 알아요)
    let done: () -> Void
    @State private var expanded: Set<String> = []

    private struct TitleGroup: Identifiable {
        let id: String          // 작품명
        let works: [Work]       // 회차들 (시즌·회차 순)
        var count: Int { works.reduce(0) { $0 + $1.items.count } }
    }
    private var groups: [TitleGroup] {
        var byTitle: [String: [Work]] = [:]
        for w in Store.group(items) { byTitle[w.title, default: []].append(w) }
        return byTitle.map { t, ws in TitleGroup(id: t, works: ws.sorted { $0.episode.localizedStandardCompare($1.episode) == .orderedAscending }) }
            .sorted { ($0.works.map(Store.latest).max() ?? 0) > ($1.works.map(Store.latest).max() ?? 0) }
    }

    var body: some View {
        let gs = groups
        let rows = 1 + gs.count + gs.filter { expanded.contains($0.id) }.reduce(0) { $0 + 1 + $1.works.count }
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                row("전체 작품", count: items.count, on: selection == nil, indent: false) { pick(nil) }
                ForEach(gs) { g in
                    Divider()
                    if g.works.count == 1, let w = g.works.first {
                        row(g.id + (w.episode.isEmpty ? "" : " · " + w.episode), count: g.count, on: selection == .work(w.id) || selection == .title(g.id), indent: false) { pick(.work(w.id)) }
                    } else {
                        Button { withAnimation(.easeInOut(duration: 0.2)) { toggle(g.id) } } label: {
                            HStack(spacing: 8) {
                                Image(systemName: "checkmark").font(.caption.bold()).foregroundStyle(Color.accentColor)
                                    .opacity(selection == .title(g.id) || g.works.contains { selection == .work($0.id) } ? 1 : 0)   // 접혀 있어도 이 안을 골랐으면 표시
                                Text(g.id).lineLimit(1)
                                Text("\(g.works.count)회차").font(.caption).foregroundStyle(.secondary)
                                Spacer()
                                Text("\(g.count)").font(.caption).foregroundStyle(.secondary).monospacedDigit()
                                Image(systemName: "chevron.right").font(.caption.bold()).foregroundStyle(.secondary)
                                    .rotationEffect(.degrees(expanded.contains(g.id) ? 90 : 0))
                            }
                            .padding(.horizontal, 14).padding(.vertical, 11)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityHint(expanded.contains(g.id) ? "회차 접기" : "회차 펼치기")
                        if expanded.contains(g.id) {
                            row("이 작품 전체", count: g.count, on: selection == .title(g.id), indent: true) { pick(.title(g.id)) }
                            ForEach(g.works) { w in
                                row(w.episode.isEmpty ? "(회차 없음)" : w.episode, count: w.items.count, on: selection == .work(w.id), indent: true) { pick(.work(w.id)) }
                            }
                        }
                    }
                }
            }
        }
        .frame(width: 300, height: min(460, CGFloat(rows) * 43 + 8))
        .onAppear {   // 지금 고른 회차가 들어 있는 작품은 펼쳐 둔다
            if case .work(let id)? = selection, let t = id.components(separatedBy: "\u{1}").first { expanded.insert(t) }
            if case .title(let t)? = selection { expanded.insert(t) }
        }
    }

    private func row(_ title: String, count: Int, on: Bool, indent: Bool, _ action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 8) {
                Image(systemName: "checkmark").font(.caption.bold()).foregroundStyle(Color.accentColor).opacity(on ? 1 : 0)
                Text(title).lineLimit(1)
                Spacer()
                Text("\(count)").font(.caption).foregroundStyle(.secondary).monospacedDigit()
            }
            .padding(.leading, indent ? 30 : 14).padding(.trailing, 14).padding(.vertical, 11)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
    private func toggle(_ t: String) { if expanded.contains(t) { expanded.remove(t) } else { expanded.insert(t) } }
    private func pick(_ f: WorkFilter?) { selection = f; done() }
}

// 화면에 띄우는 시트는 하나로 (같은 화면에 .sheet 를 둘 달면 서로 막아 안 열리는 일이 있다)
enum ActiveSheet: Identifiable {
    case settings
    case tags(Item)
    var id: String {
        switch self {
        case .settings: return "settings"
        case .tags(let item): return "tags:" + item.id
        }
    }
}

struct RootView: View {
    @EnvironmentObject var store: Store
    @EnvironmentObject var player: Player
    @State private var sheet: ActiveSheet?
    @State private var query = ""
    @State private var tagFilter: String?      // nil = 전체
    @State private var workFilter: WorkFilter? // nil = 전체 작품
    @State private var showKnown = false       // ✓ 알아요 칩: 알아요로 옮긴 대사만 (평소에는 숨김)
    @State private var showWorkPicker = false

    var body: some View {
        NavigationStack {
            Group {
                if store.items.isEmpty { emptyView } else { listView }
            }
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Image("Logo").resizable().frame(width: 30, height: 30)
                        .clipShape(RoundedRectangle(cornerRadius: 7, style: .continuous))
                        .accessibilityLabel("자막 튜터")
                }
                ToolbarItemGroup(placement: .topBarTrailing) {
                    downloadAllButton
                    Button { store.veilText.toggle() } label: { Image(systemName: store.veilText ? "eye.slash" : "eye") }
                    Button { store.veilKo.toggle() } label: { Text("뜻").strikethrough(store.veilKo) }
                    repeatButton
                    Button { sheet = .settings } label: { Image(systemName: "gearshape") }
                }
            }
            .searchable(text: $query, prompt: "대사·뜻·메모·태그 검색")
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .safeAreaInset(edge: .top) { if store.dlActive { downloadBar } }
            .safeAreaInset(edge: .bottom) { if player.continuous { ContinuousBar() } }
        }
        .sheet(item: $sheet) { s in   // 검색이 붙은 안쪽 화면이 아니라 바깥에 단다 (안쪽에 달면 안 열린다)
            switch s {
            case .settings: SettingsView()
            case .tags(let item): TagSheet(item: item)
            }
        }
    }

    // 반복 토글: 누르면 켬/끔 (켜 두면 대사를 누를 때 끝없이 반복), 길게 누르면 재생 속도 0.5~2배
    private var repeatButton: some View {
        Menu {
            Section("재생 속도") {
                ForEach(Store.rates, id: \.self) { r in
                    Button { player.setRate(r) } label: {
                        if abs(store.rate - r) < 0.001 { Label(rateText(r) + "×", systemImage: "checkmark") } else { Text(rateText(r) + "×") }
                    }
                }
            }
        } label: {
            Image(systemName: store.repeatMode ? "repeat.circle.fill" : "repeat")
                .overlay(alignment: .bottomTrailing) {
                    if abs(store.rate - 1) > 0.001 {
                        Text(rateText(store.rate)).font(.system(size: 8, weight: .bold)).foregroundStyle(.white)
                            .padding(.horizontal, 2).background(Capsule().fill(Color.orange)).offset(x: 10, y: 3)
                    }
                }
        } primaryAction: {
            Haptic.tap()
            store.repeatMode.toggle()
        }
        .simultaneousGesture(LongPressGesture(minimumDuration: 0.4).onEnded { _ in Haptic.press(); playLog.info("repeat long press") })   // 속도 메뉴가 열릴 때 진동
        .accessibilityLabel(store.repeatMode ? "반복 켜짐 (길게 눌러 재생 속도)" : "반복 꺼짐 (길게 눌러 재생 속도)")
    }

    // ⬇ 전체 다운로드: 아직 안 받은 모든 대사의 원래(스트리밍) 오디오를 한꺼번에 저장한다
    private var downloadAllButton: some View {
        let pending = store.pendingAudio(store.items).count
        return Button {
            Task { await store.downloadBatch(store.items) }
        } label: {
            Image(systemName: pending == 0 ? "checkmark.icloud" : "icloud.and.arrow.down")
                .overlay(alignment: .topTrailing) {
                    if pending > 0 {
                        Text("\(pending)").font(.system(size: 9, weight: .bold)).foregroundStyle(.white)
                            .padding(.horizontal, 3).background(Capsule().fill(.red)).offset(x: 8, y: -6)
                    }
                }
        }
        .disabled(pending == 0 || store.dlActive)
        .accessibilityLabel("전체 다운로드")
    }

    private var downloadBar: some View {
        HStack(spacing: 10) {
            ProgressView(value: Double(store.dlDone + store.dlFailed), total: Double(max(1, store.dlTotal)))
            Text("⬇ \(store.dlDone + store.dlFailed)/\(store.dlTotal)").font(.caption).monospacedDigit()
            Button("멈춤") { store.cancelDownloads() }.font(.caption)
        }
        .padding(.horizontal, 14).padding(.vertical, 6)
        .background(.ultraThinMaterial)
    }

    private var emptyView: some View {
        VStack(spacing: 14) {
            Image("Logo").resizable().frame(width: 72, height: 72)
                .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
            Text("아직 받아 온 대사가 없습니다").font(.headline)
            Text("맥의 SubTutor 웹 › 설정 › 아이폰 동기화에서 회원가입한 뒤,\n여기 설정에서 같은 이메일·비밀번호로 로그인하면 자동으로 받아 옵니다.")
                .multilineTextAlignment(.center).font(.subheadline).foregroundStyle(.secondary)
            Button("설정 열기") { sheet = .settings }.buttonStyle(.borderedProminent)
        }
        .padding()
    }

    private var listView: some View {
        let sections = displayedSections()
        return List {
            Section { filterBar }
            if sections.isEmpty {
                Text(!query.isEmpty ? "찾는 대사가 없습니다" : (showKnown ? "알아요로 옮긴 대사가 없습니다 — 대사를 오른쪽으로 밀면 옮겨집니다" : "고른 작품·태그에 맞는 대사가 없습니다")).foregroundStyle(.secondary)
            }
            ForEach(sections) { work in
                Section {
                    ForEach(work.items) { item in
                        ItemRow(item: item, showWork: work.id == "all")
                            .swipeActions(edge: .trailing) {
                                Button { sheet = .tags(item) } label: { Label("태그", systemImage: "tag") }.tint(.indigo)
                            }
                            .swipeActions(edge: .leading, allowsFullSwipe: true) {
                                if item.box == "known" {
                                    Button { Haptic.tap(); withAnimation { store.setBox(item, "learning") } } label: { Label("다시 학습", systemImage: "arrow.uturn.backward") }.tint(.orange)
                                } else {
                                    Button { Haptic.success(); withAnimation { store.setBox(item, "known") } } label: { Label("알아요", systemImage: "checkmark.circle") }.tint(.green)
                                }
                            }
                    }
                } header: { WorkHeader(work: work) }
            }
        }
        .listStyle(.plain)
    }

    // 목록 위: 정렬 · 태그로 거르기
    private var filterBar: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                Menu {
                    Picker("정렬", selection: $store.sortMode) {
                        ForEach(Store.sortModes, id: \.0) { m in Text(m.1).tag(m.0) }
                    }
                } label: {
                    Label(Store.sortModes.first { $0.0 == store.sortMode }?.1 ?? "정렬", systemImage: "arrow.up.arrow.down")
                        .font(.caption).padding(.horizontal, 10).padding(.vertical, 5)
                        .background(Capsule().fill(Color.secondary.opacity(0.15)))
                }
                Button { showWorkPicker = true } label: {
                    Label(workLabel, systemImage: "film").lineLimit(1).frame(maxWidth: 190)
                        .font(.caption).padding(.horizontal, 10).padding(.vertical, 5)
                        .foregroundStyle(workFilter == nil ? Color.primary : Color.white)
                        .background(Capsule().fill(workFilter == nil ? Color.secondary.opacity(0.15) : Color.indigo))
                }
                .buttonStyle(.borderless)
                .popover(isPresented: $showWorkPicker, arrowEdge: .top) {
                    WorkPicker(selection: $workFilter, items: pool) { showWorkPicker = false }
                        .environmentObject(store)
                        .popoverOnPhone()
                }
                chip("전체 \(learning.count)", on: !showKnown && tagFilter == nil) { showKnown = false; tagFilter = nil }
                chip("✓ 알아요 \(store.knownCount)", on: showKnown, tint: .green) { showKnown.toggle(); tagFilter = nil; workFilter = nil }
                ForEach(learningTags, id: \.self) { t in
                    chip("#\(t) \(learning.filter { $0.tags.contains(t) }.count)", on: !showKnown && tagFilter == t) { showKnown = false; tagFilter = (tagFilter == t ? nil : t) }
                }
                if store.allTags.isEmpty {
                    Text("왼쪽으로 밀면 태그 · 오른쪽으로 밀면 알아요").font(.caption2).foregroundStyle(.secondary)
                }
            }
            .padding(.vertical, 2)
        }
        .listRowSeparator(.hidden)
    }
    private var workLabel: String {
        switch workFilter {
        case nil: return "전체 작품"
        case .title(let t)?: return t
        case .work(let id)?:
            let parts = id.components(separatedBy: "\u{1}")
            return parts[0] + (parts.count > 1 && !parts[1].isEmpty ? " · " + parts[1] : "")
        }
    }
    // 학습 중(알아요가 아닌) 대사, 지금 보이는 묶음, 학습 중 대사의 태그(많이 쓴 순)
    private var learning: [Item] { store.items.filter { $0.box != "known" } }
    private var pool: [Item] { showKnown ? store.items.filter { $0.box == "known" } : learning }
    private var learningTags: [String] {
        var count: [String: Int] = [:]
        for it in learning { for t in it.tags { count[t, default: 0] += 1 } }
        return count.keys.sorted { (count[$0]!, $1) > (count[$1]!, $0) }
    }
    private func chip(_ title: String, on: Bool, tint: Color = .indigo, _ action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title).font(.caption).padding(.horizontal, 10).padding(.vertical, 5)
                .foregroundStyle(on ? Color.white : Color.primary)
                .background(Capsule().fill(on ? tint : Color.secondary.opacity(0.15)))
        }
        .buttonStyle(.borderless)
    }

    // 검색어·태그로 거르고, 고른 정렬대로 (전체 정렬이면 작품을 나누지 않는다)
    private func displayedSections() -> [Work] {
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let list = pool.filter { it in
            if !showKnown, let t = tagFilter, !it.tags.contains(t) { return false }
            if let w = workFilter, !w.matches(it) { return false }
            if q.isEmpty { return true }
            return [it.text, it.translation, it.comment, it.title, it.episode, it.tags.joined(separator: " ")]
                .contains { $0.lowercased().contains(q) }
        }
        switch store.sortMode {
        case "allNew", "allOld":
            let asc = store.sortMode == "allOld"
            let sorted = list.sorted { asc ? $0.savedAt < $1.savedAt : $0.savedAt > $1.savedAt }
            return sorted.isEmpty ? [] : [Work(id: "all", title: "전체 \(sorted.count)개", episode: "", platform: "", items: sorted)]
        case "workOld":
            return Store.group(list).sorted { Store.latest($0) < Store.latest($1) }
        case "title":
            return Store.group(list).sorted { ($0.title + " " + $0.episode).localizedStandardCompare($1.title + " " + $1.episode) == .orderedAscending }
        default:
            return Store.group(list).sorted { Store.latest($0) > Store.latest($1) }
        }
    }
}

// 작품 머리글: 제목 · ⬇ 작품별 다운로드 · 연속 듣기 (전체 정렬이면 보이는 목록 전체)
struct WorkHeader: View {
    @EnvironmentObject var store: Store
    @EnvironmentObject var player: Player
    let work: Work

    var body: some View {
        let pending = store.pendingAudio(work.items).count
        HStack(spacing: 10) {
            Text(work.title + (work.episode.isEmpty ? "" : " · " + work.episode)).lineLimit(1)
            Spacer()
            if pending > 0 {
                Button {
                    Task { await store.downloadBatch(work.items) }
                } label: { Label("⬇ \(pending)", systemImage: "arrow.down.circle").font(.caption).labelStyle(.titleOnly) }
                    .buttonStyle(.borderless)
                    .disabled(store.dlActive)
                    .accessibilityLabel("이 작품 오디오 다운로드")
            }
            Button {
                player.startContinuous(work.items)
            } label: { Label("연속 듣기", systemImage: "play.circle").font(.caption) }
                .buttonStyle(.borderless)
                .disabled(!work.items.contains { store.hasLocalAudio($0) })
        }
    }
}

// 대사 한 줄: 탭 = 재생(저장 안 돼 있으면 받아서 재생·저장) · 계단 = 속도 사다리 · Saved · 태그 · 메모 · 🎙 녹음 · 발음 확인 · 같이 듣기
struct ItemRow: View {
    @EnvironmentObject var store: Store
    @EnvironmentObject var player: Player
    @EnvironmentObject var recorder: Recorder
    let item: Item
    var showWork = false
    @State private var revealText = false
    @State private var revealKo = false
    @State private var showMemo = false      // 메모 칸 높이 (애니메이션 없이 바로)
    @State private var memoShown = false     // 메모 글자 (서서히)
    @State private var showCheck = false
    @State private var checkShown = false

    private var saved: Bool { store.hasLocalAudio(item) }
    private var busy: Bool { store.busyIds.contains(item.id) }
    private var isCurrent: Bool { player.nowId == item.id }
    private var memo: String { item.comment.trimmingCharacters(in: .whitespacesAndNewlines) }

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(alignment: .top, spacing: 8) {
                VStack(spacing: 9) {
                    playIcon
                    ladderButton
                }
                .frame(width: 34)
                VStack(alignment: .leading, spacing: 3) {
                    if showWork {
                        Text(item.title + (item.episode.isEmpty ? "" : " · " + item.episode)).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                    }
                    if store.veilText && !revealText {
                        Text("자막 가림 — 길게 눌러 보기").font(.subheadline).foregroundStyle(.secondary).italic()
                    } else {
                        Text(item.text.replacingOccurrences(of: "\n", with: " ")).font(.body.weight(.medium))
                    }
                    if !item.translation.isEmpty {
                        if store.veilKo && !revealKo {
                            Text("뜻 가림").font(.caption2).foregroundStyle(.tertiary).italic()
                                .onTapGesture { revealKo = true }
                        } else {
                            Text(item.translation).font(.subheadline).foregroundStyle(.orange)
                        }
                    }
                    if !item.tags.isEmpty {
                        Text(item.tags.map { "#" + $0 }.joined(separator: " ")).font(.caption2).foregroundStyle(.indigo).lineLimit(1)
                    }
                    HStack(spacing: 7) {
                        Text(item.timeText).font(.caption2).foregroundStyle(.tertiary)
                        savedBadge
                        if item.missed { Text("Q").font(.caption2.bold()).foregroundStyle(.red) }
                        if !memo.isEmpty {
                            Button { toggleBox(open: $showMemo, shown: $memoShown) } label: {
                                Image(systemName: "note.text").foregroundStyle(showMemo ? Color.yellow : Color.secondary)
                            }
                            .buttonStyle(.borderless)
                            .accessibilityLabel(showMemo ? "메모 닫기" : "메모 보기")
                        }
                        recControls
                    }
                    if !memo.isEmpty {
                        Reveal(open: showMemo) {
                            Text(memo).font(.subheadline)
                                .padding(8).frame(maxWidth: .infinity, alignment: .leading)
                                .background(RoundedRectangle(cornerRadius: 8).fill(Color.yellow.opacity(0.14)))
                                .opacity(memoShown ? 1 : 0)
                        }
                    }
                    if let last = recorder.takes(item).last, let r = recorder.result(for: last) {
                        Reveal(open: showCheck) {
                            VStack(alignment: .leading, spacing: 2) {
                                Text("들린 문장: " + r.heard).font(.caption)
                                if !r.missed.isEmpty { Text("놓친 단어: " + r.missed.joined(separator: ", ")).font(.caption).foregroundStyle(.red) }
                            }
                            .padding(8).frame(maxWidth: .infinity, alignment: .leading)
                            .background(RoundedRectangle(cornerRadius: 8).fill(Color.secondary.opacity(0.12)))
                            .opacity(checkShown ? 1 : 0)
                        }
                    }
                }
            }
            .contentShape(Rectangle())
            .onTapGesture { tapPlay() }
            .onLongPressGesture { revealText = true; revealKo = true }
        }
        .padding(.vertical, 2)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)   // 행 높이가 바뀌는 동안 내용은 위에 붙어 있게
        .clipped()                                                                     // 바뀌는 동안 위·아래 줄로 넘쳐 그리지 않게
        .listRowBackground(isCurrent ? Color.accentColor.opacity(0.12) : nil)
    }

    // 펼치기·접기: 칸 높이는 애니메이션 없이 바로 바꾼다 — 목록 행은 높이가 애니메이션되는 동안 내용을 가운데 기준으로 다시 맞춰
    // 글자가 내려갔다 올라오기 때문. 대신 내용만 서서히 나타나고(펼칠 때) 서서히 사라진 뒤 접힌다(접을 때)
    private func toggleBox(open: Binding<Bool>, shown: Binding<Bool>) {
        Haptic.tap()
        var still = Transaction()
        still.disablesAnimations = true
        if open.wrappedValue {
            withAnimation(.easeIn(duration: 0.12)) { shown.wrappedValue = false }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.13) { withTransaction(still) { open.wrappedValue = false } }
        } else {
            withTransaction(still) { open.wrappedValue = true }
            DispatchQueue.main.async { withAnimation(.easeOut(duration: 0.2)) { shown.wrappedValue = true } }
        }
    }

    // 눌렀을 때: 저장돼 있으면 바로 재생, 아니면 받아 저장한 뒤 재생 (다음부터는 저장된 오디오). 반복 토글이 켜져 있으면 끝없이
    private func tapPlay() {
        Haptic.tap()
        if saved { player.toggleItem(item); return }
        guard item.hasAudio, !busy else { return }
        Task {
            if await store.downloadAudio(item) { player.playItem(item) }
        }
    }

    @ViewBuilder private var playIcon: some View {
        if busy {
            ProgressView().controlSize(.small).frame(width: 22, height: 22)
        } else if saved {
            Image(systemName: isCurrent && player.isPlaying && player.ladderId == nil ? "pause.circle.fill" : "play.circle.fill")
                .font(.title3).foregroundStyle(Color.accentColor)
        } else if item.hasAudio {
            Image(systemName: "icloud.and.arrow.down").font(.title3).foregroundStyle(.secondary)  // 누르면 받아서 재생
        } else {
            Image(systemName: "speaker.slash.circle").font(.title3).foregroundStyle(Color.secondary.opacity(0.4))
        }
    }

    // 속도 사다리: 이 대사를 설정한 배속 단계대로 한 번씩 (재생 중에는 지금 단계 배속이 보인다)
    @ViewBuilder private var ladderButton: some View {
        if item.hasAudio {
            Button {
                Haptic.tap()
                if saved { player.playLadder(item) }
                else { Task { if await store.downloadAudio(item) { player.playLadder(item) } } }
            } label: {
                if player.ladderId == item.id, let r = player.ladderRate {
                    Text(rateText(r) + "×").font(.system(size: 9, weight: .bold)).monospacedDigit()
                        .lineLimit(1).fixedSize()
                        .foregroundStyle(.white).padding(.horizontal, 3).padding(.vertical, 2)
                        .background(Capsule().fill(Color.orange))
                } else {
                    Image(systemName: "stairs").font(.system(size: 15)).foregroundStyle(Color.orange)
                }
            }
            .buttonStyle(.borderless)
            .accessibilityLabel("속도 사다리 " + store.ladderRates.map { rateText($0) }.joined(separator: " → "))
        }
    }

    @ViewBuilder private var savedBadge: some View {
        if saved {
            Label("Saved", systemImage: "arrow.down.circle.fill")
                .font(.caption2.bold()).foregroundStyle(.green)
                .labelStyle(.titleAndIcon)
                .accessibilityLabel("오디오 저장됨")
        } else if item.hasAudio {
            Text("누르면 저장").font(.caption2).foregroundStyle(.tertiary)
        } else {
            Text("소리 없음").font(.caption2).foregroundStyle(.tertiary)
        }
    }

    private var recControls: some View {
        HStack(spacing: 7) {
            Button {
                Haptic.press()
                Task { await recorder.toggle(item) }
            } label: {
                Image(systemName: recorder.recordingFor == item.id ? "stop.circle.fill" : "mic.fill")
                    .foregroundStyle(recorder.recordingFor == item.id ? .red : .secondary)
            }
            .buttonStyle(.borderless)
            let takes = recorder.takes(item)
            ForEach(Array(takes.enumerated()), id: \.element) { k, url in
                Button {
                    player.playRecording(url, for: item)
                } label: {
                    Text("\(k + 1)").font(.caption2.bold())
                        .frame(width: 20, height: 20)
                        .background(Circle().fill(player.playingRec == url ? Color.accentColor : Color.secondary.opacity(0.18)))
                        .foregroundStyle(player.playingRec == url ? .white : .secondary)
                }
                .buttonStyle(.borderless)
                .contextMenu { Button(role: .destructive) { recorder.remove(item, url: url) } label: { Label("이 녹음 지우기", systemImage: "trash") } }
            }
            if let last = takes.last {
                if recorder.checking.contains(last) {
                    ProgressView().controlSize(.mini)
                } else if let r = recorder.result(for: last) {
                    Button { toggleBox(open: $showCheck, shown: $checkShown) } label: {
                        Text("\(r.score)%").font(.caption2.bold()).foregroundStyle(.white)
                            .padding(.horizontal, 5).padding(.vertical, 2)
                            .background(Capsule().fill(r.score >= 80 ? Color.green : (r.score >= 50 ? Color.orange : Color.red)))
                    }
                    .buttonStyle(.borderless)
                    .accessibilityLabel("발음 확인 \(r.score)퍼센트")
                }
            }
            if saved, let last = takes.last {
                Button { Haptic.tap(); player.playTogether(item, recording: last) } label: { Image(systemName: "speaker.wave.2.circle") }
                    .buttonStyle(.borderless)
            }
        }
        .font(.caption)
    }
}

// 태그 달기: 쓰던 태그를 고르거나 새로 만든다. 바꾸면 서버로 올라가 웹과 함께 쓴다
struct TagSheet: View {
    @EnvironmentObject var store: Store
    @Environment(\.dismiss) private var dismiss
    let item: Item
    @State private var tags: [String] = []
    @State private var newTag = ""

    var body: some View {
        NavigationStack {
            Form {
                Section { Text(item.text.replacingOccurrences(of: "\n", with: " ")).font(.subheadline) }
                Section("태그") {
                    ForEach(allNames, id: \.self) { t in
                        Button { toggle(t) } label: {
                            HStack {
                                Text("#" + t).foregroundStyle(.primary)
                                Spacer()
                                if tags.contains(t) { Image(systemName: "checkmark").foregroundStyle(Color.accentColor) }
                            }
                        }
                    }
                    HStack {
                        TextField("새 태그", text: $newTag).onSubmit(addNew)
                        Button("추가", action: addNew).disabled(newTag.trimmingCharacters(in: .whitespaces).isEmpty)
                    }
                }
                Section {
                    Text("태그는 맥의 SubTutor 웹과 함께 씁니다 — 여기서 바꾸면 바로 서버에 올라가고(인터넷이 없으면 다음 동기화 때), 웹은 다음 동기화 때 받아 갑니다.")
                        .font(.footnote).foregroundStyle(.secondary)
                }
            }
            .navigationTitle("태그")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("취소") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) { Button("완료") { store.setTags(item, tags); dismiss() } }
            }
            .onAppear { tags = store.items.first(where: { $0.id == item.id })?.tags ?? item.tags }
        }
    }
    private var allNames: [String] {
        var names = store.allTags
        for t in tags where !names.contains(t) { names.append(t) }
        return names
    }
    private func toggle(_ t: String) {
        if let i = tags.firstIndex(of: t) { tags.remove(at: i) } else { tags.append(t) }
    }
    private func addNew() {
        let t = newTag.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty else { return }
        if !tags.contains(t) { tags.append(t) }
        newTag = ""
    }
}

// 하단 연속 듣기 막대: 지금 대사 · 재생/일시정지 · 이전/다음 · 배속 · 닫기 (따라 말할 시간이면 안내)
struct ContinuousBar: View {
    @EnvironmentObject var store: Store
    @EnvironmentObject var player: Player

    var body: some View {
        VStack(spacing: 6) {
            if player.waiting && store.shadowRatio > 0 {
                Text("🗣 따라 말해 보세요").font(.footnote.bold()).foregroundStyle(.orange)
            } else if let it = player.currentItem {
                Text(it.text.replacingOccurrences(of: "\n", with: " "))
                    .font(.footnote).lineLimit(1)
            }
            HStack(spacing: 18) {
                Button { player.prev() } label: { Image(systemName: "backward.end.fill") }
                Button { player.toggle() } label: { Image(systemName: player.isPlaying ? "pause.fill" : "play.fill").font(.title3) }
                Button { player.next() } label: { Image(systemName: "forward.end.fill") }
                Menu {
                    ForEach(Store.rates, id: \.self) { r in
                        Button(rateText(r) + "×" + (abs(store.rate - r) < 0.001 ? " ✓" : "")) { player.setRate(r) }
                    }
                } label: { Text(rateText(store.rate) + "×").font(.callout.bold()) }
                Text("\(player.queueIndex + 1)/\(player.queue.count)").font(.caption2).foregroundStyle(.secondary)
                Spacer()
                Button { player.stop() } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(.secondary) }
            }
        }
        .padding(.horizontal, 14).padding(.vertical, 8)
        .background(.ultraThinMaterial)
    }
}

struct SettingsView: View {
    @EnvironmentObject var store: Store
    @EnvironmentObject var player: Player
    @Environment(\.dismiss) private var dismiss
    @State private var password = ""

    var body: some View {
        NavigationStack {
            Form {
                Section("Supabase 동기화 (맥의 SubTutor 웹에서 올린 것을 받는다)") {
                    // 기본 접속 정보(SupaDefaults)가 채워져 있으면 이메일·비밀번호만 보이고, URL·키는 "고급"에 접힌다
                    if SupaDefaults.url.isEmpty || SupaDefaults.key.isEmpty {
                        TextField("프로젝트 URL (https://xxxx.supabase.co)", text: $store.supaUrl)
                            .textInputAutocapitalization(.never).keyboardType(.URL).autocorrectionDisabled()
                        TextField("anon public 키", text: $store.supaKey)
                            .textInputAutocapitalization(.never).autocorrectionDisabled()
                    } else {
                        DisclosureGroup("고급 — 다른 Supabase 서버 쓰기") {
                            TextField("프로젝트 URL (https://xxxx.supabase.co)", text: $store.supaUrl)
                                .textInputAutocapitalization(.never).keyboardType(.URL).autocorrectionDisabled()
                            TextField("anon public 키", text: $store.supaKey)
                                .textInputAutocapitalization(.never).autocorrectionDisabled()
                        }
                    }
                    TextField("이메일", text: $store.email)
                        .textInputAutocapitalization(.never).keyboardType(.emailAddress).autocorrectionDisabled()
                    SecureField("비밀번호 (기기에 저장하지 않음)", text: $password)
                    HStack {
                        Button(store.signedIn ? "다시 로그인" : "로그인") {
                            Task { await store.signIn(password: password); password = "" }
                        }
                        .disabled(store.supaUrl.isEmpty || store.supaKey.isEmpty || store.email.isEmpty || password.isEmpty)
                        Spacer()
                        Button("동기화 (목록 받기)") { Task { await store.sync() } }
                            .buttonStyle(.borderedProminent)
                            .disabled(!store.signedIn || store.syncing)
                    }
                    if !store.syncStatus.isEmpty { Text(store.syncStatus).font(.footnote).foregroundStyle(.secondary) }
                    if let t = store.lastSyncAt { Text("마지막 동기화: \(t.formatted(date: .abbreviated, time: .shortened))").font(.footnote).foregroundStyle(.secondary) }
                    Text("한 번 로그인하면 유지되고, 앱을 켤 때마다 자동으로 동기화합니다 (10분에 한 번).").font(.footnote).foregroundStyle(.secondary)
                    if store.signedIn { Button("로그아웃", role: .destructive) { store.signOut() } }
                }
                Section("오디오 내려받기") {
                    Text("목록 동기화는 글만 받아 가볍습니다. 원래(스트리밍) 오디오는 ① 목록 위 ⬇(전체 다운로드) ② 작품 머리글의 ⬇(작품별) ③ 대사를 누르면 그 자리에서 받아 저장 — 다음부터는 저장된 오디오(초록 Saved)가 재생돼 인터넷 없이도 들립니다.")
                        .font(.footnote).foregroundStyle(.secondary)
                    LabeledContent("안 받은 오디오", value: "\(store.pendingAudio(store.items).count)개")
                }
                Section {
                    ForEach(Array(store.ladderRates.enumerated()), id: \.offset) { i, r in
                        Stepper(value: Binding(
                            get: { i < store.ladderRates.count ? store.ladderRates[i] : r },
                            set: { v in if i < store.ladderRates.count { store.ladderRates[i] = (v * 100).rounded() / 100 } }
                        ), in: 0.5...2.0, step: 0.05) {
                            Text("\(i + 1)단계   \(rateText(r))×").monospacedDigit()
                        }
                    }
                    .onDelete { idx in if store.ladderRates.count - idx.count >= 1 { store.ladderRates.remove(atOffsets: idx) } }
                    if store.ladderRates.count < 6 {
                        Button("+ 단계 추가") { store.ladderRates.append(min(2.0, (((store.ladderRates.last ?? 0.9) + 0.1) * 100).rounded() / 100)) }
                    }
                } header: {
                    Text("속도 사다리 (대사 왼쪽 계단 아이콘)")
                } footer: {
                    Text("계단 아이콘을 누르면 " + store.ladderRates.map { rateText($0) + "×" }.joined(separator: " → ") + " 순서로 한 번씩 들려줍니다 (음높이는 그대로). 느린 배속으로 소리를 나눠 듣고 실제 속도로 올라가며 귀를 맞춥니다. 왼쪽으로 밀면 그 단계를 지웁니다.")
                }
                Section {
                    Stepper("한 대사를 \(store.lineRepeats)번씩", value: $store.lineRepeats, in: 1...3)
                    Picker("대사 사이 쉼", selection: $store.gapMs) {
                        Text("없음").tag(0); Text("0.4초").tag(400); Text("0.8초").tag(800); Text("1초").tag(1000)
                    }
                    Picker("따라 말할 시간", selection: $store.shadowRatio) {
                        Text("끔").tag(0.0); Text("대사 길이 ×1").tag(1.0); Text("×1.5").tag(1.5); Text("×2").tag(2.0)
                    }
                    Toggle("끝나면 처음부터 반복", isOn: $store.loopAll)
                } header: {
                    Text("연속 듣기 (이동 중)")
                } footer: {
                    Text("화면을 꺼도 이어서 재생되고, 잠금 화면·이어폰 버튼으로 멈춤/다음을 할 수 있습니다. 저장된(Saved) 대사만 이어 듣습니다. \"따라 말할 시간\"을 켜면 대사마다 그 길이만큼 쉬어 주니, 걸으면서 들은 문장을 바로 소리 내어 따라 하세요(쉐도잉).")
                }
                Section {
                    Toggle("녹음하면 발음 확인 (음성 인식)", isOn: $store.speechCheck)
                } header: {
                    Text("말하기 연습")
                } footer: {
                    Text("🎙 로 녹음을 마치면 iOS 음성 인식이 내 발음을 영어로 받아 적어 원래 대사와 비교합니다 — 녹음 옆 숫자(%)를 누르면 들린 문장과 놓친 단어가 보입니다. 가능하면 기기 안에서(인터넷 없이) 인식합니다.\n한→영 말하기: 위 눈 아이콘으로 영어 자막을 가리고 \"뜻\"을 켜 두면, 한국어 뜻만 보고 영어로 말해 본 뒤 길게 눌러 확인할 수 있습니다.")
                }
                Section("표시") {
                    Toggle("자막 가리기 (길게 눌러 보기)", isOn: $store.veilText)
                    Toggle("뜻 가리기 (눌러서 보기)", isOn: $store.veilKo)
                }
                Section("저장소") {
                    LabeledContent("대사", value: "\(store.items.count)개 (소리 저장 \(store.audioCount)개)")
                    LabeledContent("용량", value: ByteCountFormatter.string(fromByteCount: store.storageBytes, countStyle: .file))
                    Button("받아 온 것 모두 지우기", role: .destructive) { player.stop(); store.wipe() }
                }
                Section("처음 설정하는 법") {
                    Text("""
                    1. supabase.com 에서 무료 프로젝트를 만든다.
                    2. SQL Editor 에 저장소의 supabase/schema.sql 을 붙여 넣어 실행한다.
                    3. Authentication › Sign In / Up 에서 "Confirm email" 을 끈다 (혼자 쓰면 가입 뒤 "Allow new users to sign up" 도 끈다).
                    4. 프로젝트 URL·anon 키를 코드 기본값(웹 docs/app.js 의 SUPA_DEFAULT_URL/KEY, 앱 Supa.swift 의 SupaDefaults)에 넣으면 어디서든 이메일·비밀번호만 입력하면 된다 (안 넣으면 위 입력칸에 직접).
                    5. 맥의 SubTutor 웹 › 설정 › 아이폰 동기화에서 회원가입 — 그 뒤로는 웹이 접속할 때·15분마다 자동으로 올린다.
                    6. 이 앱에 같은 이메일·비밀번호로 로그인 — 그 뒤로는 앱을 켤 때마다 자동으로 받는다.
                    """).font(.footnote).foregroundStyle(.secondary)
                }
            }
            .navigationTitle("설정")
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("닫기") { dismiss() } } }
        }
    }
}

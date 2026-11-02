// SubTutor Pocket – 입트기 화면: 프롬프트 목록(펼치면 자유 말하기 / 줄여 말하기 + 힌트 + 녹음 기록),
// 여러 줄 붙여넣기 추가, 편집(고치기·지우기), 🎲 아무거나, 녹음 화면(자유 = 올라가는 시계 + 파형,
// 줄여 = 포모도로식 원형 다운 타이머 — 넘치면 같은 방향으로 주황 띠 + "+N초")
import SwiftUI

struct SpeakView: View {
    @EnvironmentObject var store: Store
    @EnvironmentObject var speak: SpeakStore
    @Environment(\.dismiss) private var dismiss
    @State private var openId: String?
    @State private var editMode = false
    @State private var importOpen = false
    @State private var importText = ""
    @State private var importKind = "short"
    @State private var hintOpen: Set<String> = []
    @State private var memoOpen: Set<String> = []
    @State private var heardOpen: Set<String> = []
    @State private var recTarget: RecTarget?
    @State private var showInfo = false

    struct RecTarget: Identifiable, Hashable {
        let prompt: SPrompt
        let mode: String
        var id: String { prompt.id + ":" + mode }
        func hash(into hasher: inout Hasher) { hasher.combine(id) }
        static func == (l: RecTarget, r: RecTarget) -> Bool { l.id == r.id }
    }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Text(speak.stats()).font(.footnote).foregroundStyle(.secondary).listRowSeparator(.hidden)
                    if !speak.syncMsg.isEmpty || !store.signedIn {
                        Text(store.signedIn ? speak.syncMsg : "⚙ 설정에서 로그인하면 웹과 동기화됩니다 (오디오 제외)")
                            .font(.caption2).foregroundStyle(.tertiary).listRowSeparator(.hidden)
                    }
                    if importOpen { importBox }
                }
                ForEach(SpeakStore.groups, id: \.0) { key, title in
                    let list = groupPrompts(key)
                    if !list.isEmpty {
                        Section(title + " · \(list.count)") {
                            ForEach(list) { p in promptRow(p) }
                        }
                    }
                }
            }
            .listStyle(.plain)
            .navigationTitle("입트기")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) { Button("닫기") { dismiss() } }
                ToolbarItemGroup(placement: .topBarTrailing) {
                    Button { Haptic.tap(); pickRandom() } label: { Image(systemName: "die.face.5") }
                        .accessibilityLabel("아무 프롬프트나 열기")
                    Button { Haptic.tap(); withAnimation { importOpen.toggle() } } label: { Image(systemName: "plus") }
                        .accessibilityLabel("프롬프트 추가")
                    Button { Haptic.tap(); editMode.toggle() } label: { Image(systemName: editMode ? "checkmark" : "pencil") }
                        .accessibilityLabel(editMode ? "편집 끝" : "프롬프트 편집")
                    Button { showInfo = true } label: { Image(systemName: "info.circle") }
                }
            }
            .fullScreenCover(item: $recTarget) { t in   // iOS 16: navigationDestination(item:) 이 없다
                SpeakRecordView(prompt: t.prompt, mode: t.mode)
            }
            .alert("입트기 — 말하기 유창성 연습", isPresented: $showInfo) {
                Button("닫기", role: .cancel) {}
            } message: {
                Text("프롬프트를 눌러 바로 녹음하며 말하기를 연습합니다. 자유 말하기는 시간 제한 없이, \"줄여 말하기\"는 같은 대답을 점점 짧은 시간(설정에서 변경) 안에 다시 말합니다 — 같은 내용을 점점 짧게 되풀이하는 4/3/2 활동은 말 속도를 높이고 막힘을 줄이는 것으로 확인돼 있습니다 (Nation 1989; Boers 2014; de Jong & Perfetti 2011). 녹음을 마치면 음성 인식이 받아 적어 말 속도(wpm)를 재고, 별점·메모로 스스로 평가를 남깁니다. 오디오 파일은 폰에만 두고 프롬프트·기록만 웹과 동기화합니다.")
            }
            .task {
                if store.signedIn { await speak.sync(url: store.supaUrl, key: store.supaKey) }
            }
        }
    }

    private func groupPrompts(_ key: String) -> [SPrompt] {
        speak.visiblePrompts().filter { key == "mine" ? $0.cat == "mine" : $0.kind + ":" + $0.cat == key }
    }
    private func pickRandom() {
        let pool = speak.visiblePrompts()
        guard !pool.isEmpty else { return }
        let recent = SpeakStore.now() - 3 * 86_400_000
        let fresh = pool.filter { p in !speak.takesOf(p.id).contains { $0.at > recent } }
        guard let pick = (fresh.isEmpty ? pool : fresh).randomElement() else { return }
        importOpen = false
        editMode = false
        openId = pick.id
    }

    private var importBox: some View {
        VStack(alignment: .leading, spacing: 8) {
            TextEditor(text: $importText)
                .frame(minHeight: 84)
                .font(.subheadline)
                .autocorrectionDisabled()
                .textInputAutocapitalization(.sentences)
                .overlay(alignment: .topLeading) {
                    if importText.isEmpty {
                        Text("한 줄에 하나씩 — 여러 줄을 붙여 넣으면 줄마다 프롬프트가 됩니다")
                            .font(.subheadline).foregroundStyle(.tertiary)
                            .padding(.top, 8).padding(.leading, 5)
                            .allowsHitTesting(false)
                    }
                }
                .padding(4)
                .background(RoundedRectangle(cornerRadius: 8).fill(Color.secondary.opacity(0.08)))
            HStack {
                Picker("종류", selection: $importKind) {
                    Text("짧게 답하기").tag("short")
                    Text("길게 말하기").tag("long")
                }
                .pickerStyle(.segmented)
                Button("추가") {
                    let n = speak.addPrompts(importText, kind: importKind)
                    if n > 0 { Haptic.success(); importText = ""; importOpen = false }
                }
                .buttonStyle(.borderedProminent)
                .disabled(importText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
        .listRowSeparator(.hidden)
    }

    @ViewBuilder private func promptRow(_ p: SPrompt) -> some View {
        if editMode {
            VStack(alignment: .leading, spacing: 6) {
                TextField("프롬프트 (영어 문장)", text: Binding(
                    get: { p.text }, set: { speak.updatePrompt(p.id, text: $0) }), axis: .vertical)
                    .font(.subheadline.weight(.semibold))
                TextField("힌트 — 쓰면 좋은 표현·단어", text: Binding(
                    get: { p.hint }, set: { speak.updatePrompt(p.id, hint: $0) }), axis: .vertical)
                    .font(.caption)
                Button(role: .destructive) { Haptic.press(); withAnimation { speak.deletePrompt(p.id) } } label: {
                    Label("이 프롬프트 지우기", systemImage: "trash")
                }
                .font(.caption)
            }
            .padding(.vertical, 2)
        } else {
            let takes = speak.takesOf(p.id)
            let open = openId == p.id
            VStack(alignment: .leading, spacing: 8) {
                HStack(alignment: .firstTextBaseline) {
                    Text(p.text).font(.subheadline.weight(.semibold))
                    Spacer()
                    if let last = takes.first {
                        Text("\(takes.count)회 · " + when(last.at)).font(.caption2).foregroundStyle(.tertiary)
                    }
                }
                .contentShape(Rectangle())
                .onTapGesture {
                    Haptic.tap()
                    var still = Transaction(); still.disablesAnimations = true
                    withTransaction(still) { openId = open ? nil : p.id }
                }
                if open {
                    HStack(spacing: 8) {
                        Button { Haptic.press(); recTarget = RecTarget(prompt: p, mode: "free") } label: {
                            Label("자유 말하기", systemImage: "mic.fill").frame(maxWidth: .infinity).padding(.vertical, 9)
                        }
                        .buttonStyle(.borderedProminent)
                        Button { Haptic.press(); recTarget = RecTarget(prompt: p, mode: "step") } label: {
                            VStack(spacing: 1) {
                                Label("줄여 말하기", systemImage: "timer")
                                Text(speak.stages.map { SpeakStore.clock($0) }.joined(separator: "→")).font(.caption2)
                            }
                            .frame(maxWidth: .infinity).padding(.vertical, 4)
                        }
                        .buttonStyle(.bordered)
                    }
                    .buttonStyle(.borderless)   // 행 전체 탭과 겹치지 않게
                    Button {
                        Haptic.tap()
                        if hintOpen.contains(p.id) { hintOpen.remove(p.id) } else { hintOpen.insert(p.id) }
                    } label: {
                        Label(hintOpen.contains(p.id) ? "힌트 감추기" : "힌트 보이기", systemImage: "lightbulb")
                            .font(.caption)
                    }
                    .buttonStyle(.borderless)
                    if hintOpen.contains(p.id) {
                        Text(p.hint.isEmpty ? "힌트가 없습니다 — ✎ 편집에서 적어 둘 수 있어요." : p.hint)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .padding(8)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(RoundedRectangle(cornerRadius: 8).fill(Color.yellow.opacity(0.1)))
                    }
                    ForEach(takes) { t in takeRow(t) }
                }
            }
            .padding(.vertical, 2)
        }
    }

    private func when(_ ms: Double) -> String {
        let d = Date(timeIntervalSince1970: ms / 1000)
        let f = DateFormatter()
        f.dateFormat = "M.d HH:mm"
        return f.string(from: d)
    }

    @ViewBuilder private func takeRow(_ t: STake) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 7) {
                Text(when(t.at)).font(.caption2).foregroundStyle(.secondary)
                Text((t.mode == "step" ? "줄여 \(SpeakStore.clock(t.targetS))" : "자유") + " · " + SpeakStore.clock(t.durMs / 1000))
                    .font(.caption2)
                    .padding(.horizontal, 5).padding(.vertical, 1)
                    .background(RoundedRectangle(cornerRadius: 5).fill(Color.secondary.opacity(0.14)))
                if t.mode == "step", t.targetS > 0 {
                    let r = SpeakStore.overUnder(targetS: t.targetS, actualS: t.durMs / 1000)
                    Text(r.text).font(.caption2).foregroundStyle(r.diff > 0 ? .orange : r.diff < 0 ? .indigo : .secondary)
                }
                if let w = SpeakStore.wpm(t.heard, durMs: t.durMs) {
                    Text("\(w) wpm").font(.caption2).foregroundStyle(.green)
                }
                Spacer(minLength: 0)
            }
            HStack(spacing: 10) {
                if speak.hasAudio(t.id) {
                    Button { Haptic.tap(); speak.play(t) } label: {
                        Image(systemName: speak.playingTake == t.id ? "stop.circle.fill" : "play.circle")
                    }
                } else {
                    Text("소리는 녹음한 기기에").font(.caption2).foregroundStyle(.tertiary)
                }
                Button { Haptic.tap(); toggle(&heardOpen, t.id) } label: {
                    Image(systemName: "text.quote").foregroundStyle(t.heard.isEmpty ? Color.secondary : Color.yellow)
                }
                .accessibilityLabel("받아 적은 문장")
                Button { Haptic.tap(); toggle(&memoOpen, t.id) } label: {
                    Image(systemName: "note.text").foregroundStyle(t.memo.isEmpty ? Color.secondary : Color.yellow)
                }
                .accessibilityLabel("메모")
                HStack(spacing: 0) {
                    ForEach(1...5, id: \.self) { i in
                        Button { Haptic.tap(); speak.setRating(t.id, i) } label: {
                            Image(systemName: "star.fill")
                                .font(.caption)
                                .foregroundStyle(t.rating >= i ? Color.yellow : Color.secondary.opacity(0.35))
                        }
                    }
                }
                .accessibilityLabel("별점 \(t.rating)점")
                Spacer()
                Button(role: .destructive) { Haptic.press(); withAnimation { speak.deleteTake(t.id) } } label: {
                    Image(systemName: "trash").foregroundStyle(.secondary)
                }
            }
            .buttonStyle(.borderless)
            if memoOpen.contains(t.id) {
                TextField("메모 — 막힌 데, 다음에 쓸 표현…", text: Binding(
                    get: { t.memo }, set: { speak.setMemo(t.id, $0) }), axis: .vertical)
                    .font(.caption)
                    .padding(6)
                    .background(RoundedRectangle(cornerRadius: 7).fill(Color.secondary.opacity(0.1)))
            }
            if heardOpen.contains(t.id) {
                Text(t.heard.isEmpty ? "이 녹음은 받아 적지 못했습니다 (음성 인식이 꺼져 있었거나 실패)" : "들린 문장: " + t.heard)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .padding(6)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(RoundedRectangle(cornerRadius: 7).fill(Color.secondary.opacity(0.1)))
            }
        }
        .padding(.leading, 2)
    }
    private func toggle(_ set: inout Set<String>, _ id: String) {
        if set.contains(id) { set.remove(id) } else { set.insert(id) }
    }
}

// ── 녹음 화면 ──
struct SpeakRecordView: View {
    @EnvironmentObject var store: Store
    @EnvironmentObject var speak: SpeakStore
    @Environment(\.dismiss) private var dismiss
    let prompt: SPrompt
    let mode: String            // free | step
    @StateObject private var rec = SpeakRecorder()
    @State private var stage = 0
    @State private var takeId = ""
    @State private var result: (text: String, durS: Double)?   // 줄여 말하기 단계 결과
    @State private var failed = false

    private var stages: [Int] { speak.stages }
    private var target: Int { stages.indices.contains(stage) ? stages[stage] : 60 }

    var body: some View {
        VStack(spacing: 18) {
            Text(prompt.text)
                .font(.title3.weight(.bold))
                .multilineTextAlignment(.center)
                .padding(.horizontal)
            if mode == "step" {
                Text("줄여 말하기 \(stage + 1)/\(stages.count) 단계 — 목표 \(SpeakStore.clock(target))")
                    .font(.footnote).foregroundStyle(.secondary)
            } else {
                Text("자유 말하기 — 시간 제한 없음").font(.footnote).foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
            if failed {
                Text("마이크를 허용해야 녹음할 수 있습니다 (설정 › 자막 튜터 › 마이크)")
                    .multilineTextAlignment(.center).foregroundStyle(.secondary).padding()
            } else if let r = result {
                VStack(spacing: 10) {
                    Text("\(stage + 1)단계 끝 — \(r.text)").font(.title3.bold())
                    Text("목표 \(SpeakStore.clock(target)) · 말함 \(SpeakStore.clock(r.durS))").foregroundStyle(.secondary)
                    if stage < stages.count - 1 {
                        Button { Haptic.press(); nextStage() } label: {
                            Text("다음 단계 (\(SpeakStore.clock(stages[stage + 1])))").frame(maxWidth: .infinity).padding(.vertical, 8)
                        }
                        .buttonStyle(.borderedProminent)
                        Button("여기서 끝") { dismiss() }
                    } else {
                        Button { dismiss() } label: {
                            Text("끝내기").frame(maxWidth: .infinity).padding(.vertical, 8)
                        }
                        .buttonStyle(.borderedProminent)
                    }
                }
                .padding(.horizontal, 30)
            } else if mode == "free" {
                Text(SpeakStore.clock(rec.elapsed))
                    .font(.system(size: 56, weight: .heavy, design: .rounded).monospacedDigit())
                    .foregroundStyle(Color.accentColor)
                wave
            } else {
                stepRing
            }
            Spacer(minLength: 0)
            if result == nil && !failed {
                HStack(spacing: 22) {
                    Button { Haptic.tap(); rec.pauseToggle() } label: {
                        Image(systemName: rec.paused ? "play.fill" : "pause.fill")
                            .font(.title2)
                            .frame(width: 62, height: 62)
                            .background(Circle().strokeBorder(Color.secondary.opacity(0.4), lineWidth: 2))
                    }
                    .accessibilityLabel(rec.paused ? "다시 이어서" : "잠깐 멈춤")
                    Button { Haptic.press(); finishStage() } label: {
                        Image(systemName: "stop.fill")
                            .font(.title2)
                            .foregroundStyle(.white)
                            .frame(width: 62, height: 62)
                            .background(Circle().fill(Color.accentColor))
                    }
                    .accessibilityLabel("마치기")
                }
                Button("✕ 버리고 나가기") { rec.stop(discard: true); dismiss() }
                    .font(.caption).foregroundStyle(.tertiary)
            }
        }
        .padding(.vertical, 16)
        .navigationBarBackButtonHidden(rec.running)
        .interactiveDismissDisabled(rec.running)
        .task { await begin() }
        .onDisappear { if rec.running { rec.stop(discard: true) } }
    }

    private var wave: some View {
        HStack(alignment: .center, spacing: 3) {
            ForEach(Array(rec.meters.enumerated()), id: \.offset) { _, v in
                RoundedRectangle(cornerRadius: 2)
                    .fill(Color.accentColor.opacity(0.85))
                    .frame(width: 4, height: max(3, v * 56))
            }
        }
        .frame(maxWidth: .infinity, minHeight: 64)
        .padding(.horizontal, 20)
        .animation(.linear(duration: 0.1), value: rec.meters)
    }

    // 포모도로식 원: 남은 시간이 줄며 보라 띠가 차고, 넘치면 같은 방향으로 주황 띠가 덧칠해지며 +N초
    private var stepRing: some View {
        let t = rec.elapsed
        let tg = Double(target)
        let overFrac = t > tg ? min(1, (t - tg) / tg) : 0
        return ZStack {
            Circle().stroke(Color.secondary.opacity(0.25), lineWidth: 11)
            Circle().trim(from: 0, to: min(1, t / tg))
                .stroke(Color.accentColor, style: StrokeStyle(lineWidth: 11, lineCap: .round))
                .rotationEffect(.degrees(-90))
            Circle().trim(from: 0, to: overFrac)
                .stroke(Color.orange, style: StrokeStyle(lineWidth: 11, lineCap: .round))
                .rotationEffect(.degrees(-90))
            VStack(spacing: 0) {
                Text(t <= tg ? SpeakStore.clock(Int((tg - t).rounded(.up))) : "+\(max(1, Int((t - tg).rounded(.up))))")
                    .font(.system(size: 46, weight: .heavy, design: .rounded).monospacedDigit())
                    .foregroundStyle(t <= tg ? Color.accentColor : Color.orange)
                if rec.paused { Text("멈춤").font(.caption).foregroundStyle(.secondary) }
            }
        }
        .frame(width: 230, height: 230)
    }

    private func begin() async {
        takeId = SpeakStore.newTakeId()
        let ok = await rec.start(url: SpeakStore.audioURL(takeId))
        if !ok { failed = true }
    }
    private func nextStage() {
        stage += 1
        result = nil
        Task { await begin() }
    }
    private func finishStage() {
        guard let (url, ms) = rec.stop() else { return }
        if ms < 700 {   // 너무 짧으면 버린다
            try? FileManager.default.removeItem(at: url)
            if mode == "free" { dismiss() } else { result = ("너무 짧아 저장 안 함", 0) }
            return
        }
        let id = takeId
        let take = speak.addTake(id: id, pid: prompt.id, mode: mode, targetS: mode == "step" ? target : 0, durMs: ms)
        if store.speechCheck {   // 받아 적기 (가능하면 기기 안에서) → 말 속도
            Task.detached {
                let heard = await SpeechCheck.recognize(url, timeout: max(30, ms / 1000 * 2))
                if let heard, !heard.isEmpty { await SpeakStore.shared.setHeard(id, heard) }
            }
        }
        if mode == "free" {
            Haptic.success()
            dismiss()
        } else {
            Haptic.success()
            result = (SpeakStore.overUnder(targetS: target, actualS: take.durMs / 1000).text, take.durMs / 1000)
        }
    }
}

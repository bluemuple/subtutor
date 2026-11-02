// SubTutor Pocket – 화면: 작품별 대사 목록(탭 = 받아서 재생, Saved 아이콘, 🎙 녹음, 같이 듣기),
// ⬇ 전체/작품별 오디오 다운로드, 하단 연속 듣기 막대, 설정(동기화)
import SwiftUI

struct RootView: View {
    @EnvironmentObject var store: Store
    @EnvironmentObject var player: Player
    @State private var showSettings = false

    var body: some View {
        NavigationStack {
            Group {
                if store.items.isEmpty { emptyView } else { listView }
            }
            .navigationTitle("자막 튜터")
            .toolbar {
                ToolbarItemGroup(placement: .topBarTrailing) {
                    downloadAllButton
                    Button { store.veilText.toggle() } label: { Image(systemName: store.veilText ? "eye.slash" : "eye") }
                    Button { store.veilKo.toggle() } label: { Text("뜻").strikethrough(store.veilKo) }
                    Button { showSettings = true } label: { Image(systemName: "gearshape") }
                }
            }
            .safeAreaInset(edge: .top) { if store.dlActive { downloadBar } }
            .safeAreaInset(edge: .bottom) { if player.continuous { ContinuousBar() } }
            .sheet(isPresented: $showSettings) { SettingsView() }
        }
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
            Image(systemName: "icloud.and.arrow.down").font(.system(size: 44)).foregroundStyle(.secondary)
            Text("아직 받아 온 대사가 없습니다").font(.headline)
            Text("맥의 SubTutor 웹 › 설정 › 아이폰 동기화에서 올린 뒤,\n여기 설정에서 같은 계정으로 로그인하고 동기화를 누르세요.")
                .multilineTextAlignment(.center).font(.subheadline).foregroundStyle(.secondary)
            Button("설정 열기") { showSettings = true }.buttonStyle(.borderedProminent)
        }
        .padding()
    }

    private var listView: some View {
        List {
            ForEach(store.works) { work in
                Section {
                    ForEach(work.items) { item in ItemRow(item: item) }
                } header: { WorkHeader(work: work) }
            }
        }
        .listStyle(.plain)
    }
}

// 작품 머리글: 제목 · ⬇ 작품별 다운로드 · 연속 듣기
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

// 대사 한 줄: 탭 = 재생(저장 안 돼 있으면 받아서 재생·저장) · Saved 아이콘 · 자막/뜻 가림 · 🎙 녹음 · 1·2·3 · 같이 듣기
struct ItemRow: View {
    @EnvironmentObject var store: Store
    @EnvironmentObject var player: Player
    @EnvironmentObject var recorder: Recorder
    let item: Item
    @State private var revealText = false
    @State private var revealKo = false

    private var saved: Bool { store.hasLocalAudio(item) }
    private var busy: Bool { store.busyIds.contains(item.id) }
    private var isCurrent: Bool { player.nowId == item.id }

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                playIcon
                VStack(alignment: .leading, spacing: 3) {
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
                    HStack(spacing: 8) {
                        Text(item.timeText).font(.caption2).foregroundStyle(.tertiary)
                        savedBadge
                        if item.missed { Text("Q").font(.caption2.bold()).foregroundStyle(.red) }
                        recControls
                    }
                }
            }
            .contentShape(Rectangle())
            .onTapGesture { tapPlay() }
            .onLongPressGesture { revealText = true; revealKo = true }
        }
        .padding(.vertical, 2)
        .listRowBackground(isCurrent ? Color.accentColor.opacity(0.12) : nil)
    }

    // 눌렀을 때: 저장돼 있으면 바로 재생, 아니면 받아 저장한 뒤 재생 (다음부터는 저장된 오디오)
    private func tapPlay() {
        if saved { player.toggleItem(item); return }
        guard item.hasAudio, !busy else { return }
        Task {
            if await store.downloadAudio(item) { player.playItem(item) }
        }
    }

    @ViewBuilder private var playIcon: some View {
        if busy {
            ProgressView().controlSize(.small).frame(width: 22)
        } else if saved {
            Image(systemName: isCurrent && player.isPlaying ? "pause.circle.fill" : "play.circle.fill")
                .font(.title3).foregroundStyle(Color.accentColor)
        } else if item.hasAudio {
            Image(systemName: "icloud.and.arrow.down").font(.title3).foregroundStyle(.secondary)  // 누르면 받아서 재생
        } else {
            Image(systemName: "speaker.slash.circle").font(.title3).foregroundStyle(Color.secondary.opacity(0.4))
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
            if saved, let last = takes.last {
                Button { player.playTogether(item, recording: last) } label: { Image(systemName: "speaker.wave.2.circle") }
                    .buttonStyle(.borderless)
            }
        }
        .font(.caption)
    }
}

// 하단 연속 듣기 막대: 지금 대사 · 재생/일시정지 · 이전/다음 · 배속 · 닫기
struct ContinuousBar: View {
    @EnvironmentObject var store: Store
    @EnvironmentObject var player: Player

    var body: some View {
        VStack(spacing: 6) {
            if let it = player.currentItem {
                Text(it.text.replacingOccurrences(of: "\n", with: " "))
                    .font(.footnote).lineLimit(1)
            }
            HStack(spacing: 18) {
                Button { player.prev() } label: { Image(systemName: "backward.end.fill") }
                Button { player.toggle() } label: { Image(systemName: player.isPlaying ? "pause.fill" : "play.fill").font(.title3) }
                Button { player.next() } label: { Image(systemName: "forward.end.fill") }
                Menu {
                    ForEach(Store.rates, id: \.self) { r in
                        Button((r == 1 ? "1" : String(format: "%g", r)) + "×" + (abs(store.rate - r) < 0.01 ? " ✓" : "")) { player.setRate(r) }
                    }
                } label: { Text(String(format: "%g×", store.rate)).font(.callout.bold()) }
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
                Section("연속 듣기 (이동 중)") {
                    Stepper("한 대사를 \(store.lineRepeats)번씩", value: $store.lineRepeats, in: 1...3)
                    Picker("대사 사이 쉼", selection: $store.gapMs) {
                        Text("없음").tag(0); Text("0.4초").tag(400); Text("0.8초").tag(800); Text("1초").tag(1000)
                    }
                    Toggle("끝나면 처음부터 반복", isOn: $store.loopAll)
                    Text("화면을 꺼도 이어서 재생되고, 잠금 화면·이어폰 버튼으로 멈춤/다음을 할 수 있습니다. 저장된(Saved) 대사만 이어 듣습니다.")
                        .font(.footnote).foregroundStyle(.secondary)
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

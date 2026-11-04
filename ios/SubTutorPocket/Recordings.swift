// SubTutor Pocket – 영상 오디오 (맥 익스텐션 "⏺ MP3" 로 뽑아 웹이 Supabase 로 올린 통째 에피소드 MP3)
// 표 없이 Storage 목록(rec/)만 읽는다 — 파일 이름에 id·길이·제목(base64url)이 들어 있다.
// 저장한 자막 목록의 작품 머리와 설정 › 영상 오디오에서: 내려받기(진행률) → 재생(⏪⏩ 건너뛰기·배속) → 지우기(폰/서버).
import Foundation
import SwiftUI
import AVFoundation

struct RecFile: Identifiable, Equatable, Codable {
    var name: String          // 서버 파일 이름 (rec/ 다음, 예: r123abc.4f2.SGVsbG8.mp3)
    var id: String            // r<base36 ms>
    var title: String
    var at: Double            // 녹음한 때 (ms)
    var durMs: Double
    var bytes: Int

    // r<at36>.<dur36>.<base64url 제목>.mp3 — 웹 recStoreName 과 같은 규칙
    static func parse(name: String, size: Int) -> RecFile? {
        let parts = name.split(separator: ".", omittingEmptySubsequences: false).map(String.init)
        guard parts.count == 4, parts[3] == "mp3", parts[0].hasPrefix("r"),
              let at = Int(parts[0].dropFirst(), radix: 36),
              let dur = Int(parts[1], radix: 36) else { return nil }
        var b64 = parts[2].replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        while b64.count % 4 != 0 { b64 += "=" }
        let title = Data(base64Encoded: b64).flatMap { String(data: $0, encoding: .utf8) } ?? ""
        return RecFile(name: name, id: parts[0], title: title.isEmpty ? "영상 오디오" : title,
                       at: Double(at), durMs: Double(dur), bytes: size)
    }
}

@MainActor
final class RecStore: ObservableObject {
    static let shared = RecStore()
    @Published var files: [RecFile] = []
    @Published var msg = ""
    @Published var loading = false
    @Published var progress: [String: Double] = [:]     // name → 내려받는 중 0~1
    @Published var playingName: String?
    @Published var paused = false
    @Published var playPos: Double = 0                  // 초
    @Published var playDur: Double = 0
    @Published var loopA: Double?                       // 구간 반복: 시작 (버튼 1번)
    @Published var loopB: Double?                       //            끝 (버튼 2번 — 그 뒤로 반복, 3번째에 해제)
    @Published var skipS: Int = max(1, UserDefaults.standard.object(forKey: "recSkip") as? Int ?? 3) {
        didSet { UserDefaults.standard.set(skipS, forKey: "recSkip") }
    }
    @Published var rate: Double = {
        let v = UserDefaults.standard.double(forKey: "recRate")
        return v > 0 ? min(2, max(0.5, v)) : 1
    }() {
        didSet { UserDefaults.standard.set(rate, forKey: "recRate"); player?.rate = Float(rate) }
    }
    private var player: AVAudioPlayer?
    private var watch: Timer?
    private var fetchedAt: Double = 0

    // 목록은 폰에 저장해 둔다 — 앱을 다시 켜도(오프라인이어도) 다음 동기화 전에 플레이어가 바로 보이게
    static var listURL: URL { Store.docs.appendingPathComponent("recordings.json") }
    init() {
        if let d = try? Data(contentsOf: RecStore.listURL), let saved = try? JSONDecoder().decode([RecFile].self, from: d) {
            files = saved
        }
    }
    private func persistList() {
        if let d = try? JSONEncoder().encode(files) { try? d.write(to: RecStore.listURL, options: .atomic) }
    }

    static var dir: URL { Store.docs.appendingPathComponent("recordings", isDirectory: true) }
    static func localURL(_ name: String) -> URL { dir.appendingPathComponent(name) }
    func hasLocal(_ f: RecFile) -> Bool { FileManager.default.fileExists(atPath: RecStore.localURL(f.name).path) }
    func localBytes() -> Int {
        let fm = FileManager.default
        guard let names = try? fm.contentsOfDirectory(atPath: RecStore.dir.path) else { return 0 }
        return names.reduce(0) { $0 + (((try? fm.attributesOfItem(atPath: RecStore.dir.appendingPathComponent($1).path))?[.size] as? NSNumber)?.intValue ?? 0) }
    }
    // 저장한 자막 작품 머리와 맞추기: 녹음 제목 = "작품제목 에피소드"
    func match(title: String, episode: String) -> RecFile? {
        let full = title + (episode.isEmpty ? "" : " " + episode)
        return files.filter { $0.title == full }.sorted { $0.at > $1.at }.first
    }

    func refresh(url: String, key: String, force: Bool = true) async {
        if !force, SpeakStore.now() - fetchedAt < 60_000 { return }
        loading = true
        defer { loading = false }
        do {
            let rows = try await Supa.shared.listStorage(url: url, key: key, prefix: "rec/")
            let fresh = rows.compactMap { row -> RecFile? in
                guard let name = row["name"] as? String, !(row["id"] is NSNull), row["id"] != nil else { return nil }
                let size = (((row["metadata"] as? [String: Any])?["size"]) as? NSNumber)?.intValue ?? 0
                return RecFile.parse(name: name, size: size)
            }
            // 서버에서 지워졌어도 폰에 받아 둔 파일은 목록에 남긴다 (계속 들을 수 있게)
            let keep = files.filter { f in !fresh.contains { $0.name == f.name } && hasLocal(f) }
            files = (fresh + keep).sorted { $0.at > $1.at }
            persistList()
            fetchedAt = SpeakStore.now()
            msg = ""
        } catch {
            msg = Supa.describe(error)
        }
    }

    // ── 내려받기 (진행률) ──
    func download(_ f: RecFile, url: String, key: String, thenPlay: Bool = false) {
        guard progress[f.name] == nil else { return }
        progress[f.name] = 0
        Task {
            do {
                try await Supa.shared.downloadStorage(url: url, key: key, path: "rec/" + f.name, to: RecStore.localURL(f.name)) { [weak self] p in
                    Task { @MainActor in self?.progress[f.name] = p }
                }
                progress[f.name] = nil
                Haptic.success()
                if thenPlay { play(f) }
            } catch {
                progress[f.name] = nil
                try? FileManager.default.removeItem(at: RecStore.localURL(f.name))
                msg = "내려받기 실패: " + Supa.describe(error)
            }
        }
    }

    // ── 재생 (배속·건너뛰기 — 폰에 받은 파일만) ──
    func toggle(_ f: RecFile, url: String, key: String) {
        if playingName == f.name, let p = player {
            if p.isPlaying { p.pause(); paused = true } else { p.rate = Float(rate); p.play(); paused = false }
            return
        }
        if hasLocal(f) { play(f) } else { download(f, url: url, key: key, thenPlay: true) }
    }
    func play(_ f: RecFile) {
        stop()
        guard let p = try? AVAudioPlayer(contentsOf: RecStore.localURL(f.name)) else { msg = "파일을 열지 못했습니다"; return }
        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .spokenAudio)
        try? AVAudioSession.sharedInstance().setActive(true)
        p.enableRate = true
        p.rate = Float(rate)
        player = p
        playingName = f.name
        paused = false
        loopA = nil
        loopB = nil
        playDur = p.duration
        playPos = 0
        p.play()
        watch = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] _ in
            Task { @MainActor in
                guard let self, let p = self.player else { return }
                if let a = self.loopA, let b = self.loopB, p.currentTime >= b {   // 구간 반복: 끝에 닿으면 시작으로
                    p.currentTime = a
                    if !p.isPlaying { p.rate = Float(self.rate); p.play(); self.paused = false }
                }
                self.playPos = p.currentTime
                if !p.isPlaying, !self.paused, p.currentTime >= p.duration - 0.3 {
                    if let a = self.loopA, self.loopB != nil { p.currentTime = a; p.rate = Float(self.rate); p.play() }   // 구간 끝이 파일 끝이어도 반복
                    else { self.stop() }
                }
            }
        }
    }
    // 구간 반복 버튼: 1번 = 시작 지정 → 2번 = 끝 지정(그 뒤로 반복) → 3번 = 해제
    func loopTap() {
        guard player != nil else { return }
        Haptic.tap()
        if loopA == nil {
            loopA = playPos
            loopB = nil
        } else if loopB == nil {
            var a = loopA ?? 0, b = playPos
            if b < a { swap(&a, &b) }           // 되감은 채 눌렀으면 앞뒤를 바꾼다
            if b - a < 0.5 { b = a + 0.5 }      // 너무 좁으면 최소 0.5초
            loopA = a
            loopB = b
            if let p = player { p.currentTime = a; playPos = a; if !p.isPlaying { p.rate = Float(rate); p.play(); paused = false } }
        } else {
            loopA = nil
            loopB = nil
        }
    }

    func stop() {
        player?.stop()
        player = nil
        playingName = nil
        paused = false
        playPos = 0
        loopA = nil
        loopB = nil
        watch?.invalidate()
        watch = nil
    }
    func seek(to s: Double) {
        guard let p = player else { return }
        p.currentTime = max(0, min(p.duration - 0.2, s))
        playPos = p.currentTime
    }
    func skip(_ d: Int) {
        guard let p = player else { return }
        Haptic.tap()
        seek(to: p.currentTime + Double(d))
        if !p.isPlaying, !paused { p.play() }
    }

    // ── 지우기 ──
    func removeLocal(_ f: RecFile) {
        if playingName == f.name { stop() }
        try? FileManager.default.removeItem(at: RecStore.localURL(f.name))
        objectWillChange.send()
    }
    func removeServer(_ f: RecFile, url: String, key: String) async {
        do {
            try await Supa.shared.deleteStorage(url: url, key: key, path: "rec/" + f.name)
            if !hasLocal(f) { files.removeAll { $0.name == f.name } }   // 폰에 받은 파일은 남으므로 목록에도 남긴다
            persistList()
            msg = ""
        } catch { msg = "서버에서 지우지 못했습니다: " + Supa.describe(error) }
    }

    static func fmtMB(_ b: Int) -> String {
        let mb = Double(b) / 1_048_576
        return (mb >= 100 ? String(Int(mb.rounded())) : String(format: "%.1f", mb)) + "MB"
    }
    static func when(_ ms: Double) -> String {
        let f = DateFormatter()
        f.dateFormat = "M.d HH:mm"
        return f.string(from: Date(timeIntervalSince1970: ms / 1000))
    }
}

// 작품 묶음 맨 위(그리고 설정 › 영상 오디오)에 놓는 플레이어 한 줄: ⬇/▶ · ⏪⏩ · 자리 슬라이더 · 배속 −/＋
struct EpiPlayerRow: View {
    @EnvironmentObject var store: Store
    @EnvironmentObject var recs: RecStore
    let f: RecFile
    @State private var dragging = false
    @State private var dragPos: Double = 0

    private var mine: Bool { recs.playingName == f.name }

    var body: some View {
        VStack(spacing: 5) {
            HStack(spacing: 12) {
                Image(systemName: "headphones").font(.caption).foregroundStyle(.secondary)
                if let p = recs.progress[f.name] {
                    ProgressView(value: p).frame(width: 56)
                    Text("\(Int(p * 100))%").font(.caption2.monospacedDigit()).foregroundStyle(.secondary)
                } else {
                    Button {
                        Haptic.tap()
                        recs.toggle(f, url: store.supaUrl, key: store.supaKey)
                    } label: {
                        Image(systemName: mine && !recs.paused ? "pause.circle.fill" : (recs.hasLocal(f) ? "play.circle.fill" : "icloud.and.arrow.down"))
                            .font(.title3)
                    }
                    .buttonStyle(.borderless)
                    .accessibilityLabel(recs.hasLocal(f) ? "에피소드 오디오 재생" : "에피소드 오디오 내려받기")
                }
                Button { recs.skip(-recs.skipS) } label: { Image(systemName: "gobackward") }
                    .buttonStyle(.borderless).disabled(!mine)
                    .accessibilityLabel("\(recs.skipS)초 뒤로")
                Button { recs.skip(recs.skipS) } label: { Image(systemName: "goforward") }
                    .buttonStyle(.borderless).disabled(!mine)
                    .accessibilityLabel("\(recs.skipS)초 앞으로")
                Button { recs.loopTap() } label: {   // 한 버튼으로: 시작 → 끝(반복) → 해제
                    Image(systemName: mine && recs.loopB != nil ? "repeat.circle.fill" : (mine && recs.loopA != nil ? "a.circle.fill" : "repeat"))
                }
                .buttonStyle(.borderless).disabled(!mine)
                .foregroundStyle(mine && recs.loopB != nil ? Color.accentColor : (mine && recs.loopA != nil ? Color.orange : Color.secondary))
                .accessibilityLabel(mine && recs.loopB != nil ? "구간 반복 해제" : (mine && recs.loopA != nil ? "구간 끝 지정" : "구간 시작 지정"))
                Text((mine ? SpeakStore.clock(dragging ? dragPos : recs.playPos) : "0:00") + " / " + SpeakStore.clock(mine && recs.playDur > 0 ? recs.playDur : f.durMs / 1000))
                    .font(.caption2.monospacedDigit()).foregroundStyle(.secondary)
                if mine, let a = recs.loopA {   // 좁은 폰에서도 구간 끝이 잘리지 않게 짧게 + 자동 축소
                    Text(recs.loopB != nil ? "\(SpeakStore.clock(a))–\(SpeakStore.clock(recs.loopB ?? a))" : "A \(SpeakStore.clock(a))")
                        .font(.caption2.monospacedDigit())
                        .foregroundStyle(recs.loopB != nil ? Color.accentColor : Color.orange)
                        .lineLimit(1)
                        .minimumScaleFactor(0.7)
                        .fixedSize(horizontal: true, vertical: false)
                }
                Spacer(minLength: 0)
                // 배속: 더 늦게 · 더 빠르게 (0.5~2.0, 음높이는 그대로)
                Button { Haptic.tap(); recs.rate = max(0.5, (recs.rate * 10 - 1).rounded() / 10) } label: { Image(systemName: "minus") }
                    .buttonStyle(.borderless)
                    .accessibilityLabel("더 늦게 듣기")
                Text(String(format: "%.1f×", recs.rate)).font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                Button { Haptic.tap(); recs.rate = min(2, (recs.rate * 10 + 1).rounded() / 10) } label: { Image(systemName: "plus") }
                    .buttonStyle(.borderless)
                    .accessibilityLabel("더 빠르게 듣기")
            }
            .font(.subheadline)
            if mine {
                Slider(value: Binding(get: { dragging ? dragPos : recs.playPos }, set: { dragPos = $0 }),
                       in: 0...max(1, recs.playDur > 0 ? recs.playDur : f.durMs / 1000)) { editing in
                    if editing { dragging = true } else { recs.seek(to: dragPos); dragging = false }
                }
            }
        }
        .padding(.vertical, 2)
    }
}

// 설정 › 영상 오디오: 서버의 전체 목록 — 내려받기·재생·지우기(폰/서버)
struct RecordingsView: View {
    @EnvironmentObject var store: Store
    @EnvironmentObject var recs: RecStore
    @State private var serverDelete: RecFile?

    var body: some View {
        List {
            Section {
                if !recs.msg.isEmpty { Text(recs.msg).font(.caption).foregroundStyle(.secondary) }
                if recs.loading && recs.files.isEmpty { ProgressView() }
                if recs.files.isEmpty && !recs.loading {
                    Text("서버에 영상 오디오가 없습니다 — 맥 플레이어 패널의 \"⏺ MP3\" 로 뽑고, 웹 설정 › 아이폰 동기화 › 서버 소리 관리에서 올리면 여기 보입니다")
                        .font(.caption).foregroundStyle(.secondary)
                }
            } footer: {
                if !recs.files.isEmpty {
                    Text("폰에 받은 파일 \(RecStore.fmtMB(recs.localBytes())) · 줄을 왼쪽으로 밀면 지울 수 있어요 (서버에서 지워도 폰에 받은 파일은 남습니다)")
                }
            }
            ForEach(recs.files) { f in
                Section {
                    VStack(alignment: .leading, spacing: 6) {
                        HStack {
                            Text(f.title).font(.subheadline.weight(.semibold)).lineLimit(2)
                            Spacer()
                            Text(RecStore.when(f.at) + " · " + RecStore.fmtMB(f.bytes)).font(.caption2).foregroundStyle(.tertiary)
                        }
                        EpiPlayerRow(f: f)
                        if !recs.hasLocal(f) && recs.progress[f.name] == nil {
                            Text("아직 폰에 없음 — ⬇ 를 누르면 받아서 바로 재생").font(.caption2).foregroundStyle(.tertiary)
                        }
                    }
                    .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                        Button(role: .destructive) { serverDelete = f } label: { Label("서버에서 지우기", systemImage: "icloud.slash") }
                        if recs.hasLocal(f) {
                            Button { Haptic.press(); recs.removeLocal(f) } label: { Label("폰에서 지우기", systemImage: "iphone.slash") }.tint(.orange)
                        }
                    }
                }
            }
        }
        .listStyle(.insetGrouped)
        .navigationTitle("영상 오디오")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await recs.refresh(url: store.supaUrl, key: store.supaKey) }
        .task { if store.signedIn { await recs.refresh(url: store.supaUrl, key: store.supaKey, force: false) } }
        .confirmationDialog("서버에서 지울까요?", isPresented: Binding(get: { serverDelete != nil }, set: { if !$0 { serverDelete = nil } }), titleVisibility: .visible) {
            Button("서버에서 지우기 (웹에서 다시 올릴 수 있음)", role: .destructive) {
                if let f = serverDelete { Task { await recs.removeServer(f, url: store.supaUrl, key: store.supaKey) } }
                serverDelete = nil
            }
            Button("취소", role: .cancel) { serverDelete = nil }
        } message: {
            Text("폰과 맥에 받아 둔 파일은 남습니다. 웹 설정 › 서버 소리 관리에서 \"다시 올리기 허용\"을 누르면 다시 올라갑니다.")
        }
    }
}

// 작품 묶음(Work)에 맞는 통째 오디오가 서버 목록에 있으면 그 묶음 맨 위에 플레이어를 놓는다
struct WorkEpiRow: View {
    @EnvironmentObject var recs: RecStore
    let work: Work

    @ViewBuilder var body: some View {
        if work.id != "all", let f = recs.match(title: work.title, episode: work.episode) {
            EpiPlayerRow(f: f)
        }
    }
}

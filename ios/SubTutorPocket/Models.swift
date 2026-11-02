// SubTutor Pocket – 데이터: 저장한 자막(Item) + 로컬 보관(Store)
// 확장 프로그램이 Supabase 에 올린 items 를 내려받아 Documents/items.json 과 Documents/audio/*.mp3 로 둔다.
// 그 뒤로는 인터넷 없이 목록·재생·녹음이 모두 된다.
import Foundation

struct Item: Codable, Identifiable, Hashable {
    var id: String                 // 확장 프로그램 항목 id: <platform>:<videoId>:<자막 시작 ms>
    var title: String
    var episode: String
    var platform: String
    var text: String
    var translation: String
    var startMs: Int64
    var endMs: Int64
    var savedAt: Int64
    var box: String
    var comment: String
    var missed: Bool
    var missReason: String
    var hasAudio: Bool             // 서버에 MP3 가 있는가
    var audioMs: Int64

    enum CodingKeys: String, CodingKey {
        case id, title, episode, platform, text, translation
        case startMs = "start_ms", endMs = "end_ms", savedAt = "saved_at"
        case box, comment, missed
        case missReason = "miss_reason", hasAudio = "has_audio", audioMs = "audio_ms"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        title = (try? c.decode(String.self, forKey: .title)) ?? ""
        episode = (try? c.decode(String.self, forKey: .episode)) ?? ""
        platform = (try? c.decode(String.self, forKey: .platform)) ?? ""
        text = (try? c.decode(String.self, forKey: .text)) ?? ""
        translation = (try? c.decode(String.self, forKey: .translation)) ?? ""
        startMs = (try? c.decode(Int64.self, forKey: .startMs)) ?? 0
        endMs = (try? c.decode(Int64.self, forKey: .endMs)) ?? 0
        savedAt = (try? c.decode(Int64.self, forKey: .savedAt)) ?? 0
        box = (try? c.decode(String.self, forKey: .box)) ?? "learning"
        comment = (try? c.decode(String.self, forKey: .comment)) ?? ""
        missed = (try? c.decode(Bool.self, forKey: .missed)) ?? false
        missReason = (try? c.decode(String.self, forKey: .missReason)) ?? ""
        hasAudio = (try? c.decode(Bool.self, forKey: .hasAudio)) ?? false
        audioMs = (try? c.decode(Int64.self, forKey: .audioMs)) ?? 0
    }

    // 서버 storage 파일 이름 (웹 업로드 쪽과 같은 규칙이어야 한다)
    var audioFileName: String { Item.safeName(id) + ".mp3" }
    static func safeName(_ s: String) -> String {
        return String(s.map { ch in (ch.isLetter && ch.isASCII) || ch.isNumber || ch == "." || ch == "_" || ch == "-" ? ch : "_" })
    }
    var timeText: String {
        let s = max(0, startMs) / 1000
        return String(format: "%d:%02d", s / 60, s % 60)
    }
}

struct Work: Identifiable {
    let id: String                 // 제목 + 에피소드
    let title: String
    let episode: String
    let platform: String
    var items: [Item]
}

@MainActor
final class Store: ObservableObject {
    @Published var items: [Item] = []
    @Published var syncStatus: String = ""
    @Published var syncing = false
    @Published var lastSyncAt: Date? = UserDefaults.standard.object(forKey: "lastSyncAt") as? Date

    // Supabase 설정 (anon 키는 공개용 키라 기기에 저장해도 된다)
    @Published var supaUrl: String = { let v = UserDefaults.standard.string(forKey: "supaUrl") ?? ""; return v.isEmpty ? SupaDefaults.url : v }()
    @Published var supaKey: String = { let v = UserDefaults.standard.string(forKey: "supaKey") ?? ""; return v.isEmpty ? SupaDefaults.key : v }()
    @Published var email: String = UserDefaults.standard.string(forKey: "email") ?? ""
    @Published var signedIn: Bool = UserDefaults.standard.string(forKey: "refreshToken") != nil

    // 표시·재생 취향
    @Published var veilText: Bool { didSet { UserDefaults.standard.set(veilText, forKey: "veilText") } }
    @Published var veilKo: Bool { didSet { UserDefaults.standard.set(veilKo, forKey: "veilKo") } }
    @Published var rate: Double { didSet { UserDefaults.standard.set(rate, forKey: "rate") } }
    @Published var lineRepeats: Int { didSet { UserDefaults.standard.set(lineRepeats, forKey: "lineRepeats") } }   // 연속 듣기에서 한 대사를 몇 번씩
    @Published var gapMs: Int { didSet { UserDefaults.standard.set(gapMs, forKey: "gapMs") } }                     // 대사 사이 쉼
    @Published var loopAll: Bool { didSet { UserDefaults.standard.set(loopAll, forKey: "loopAll") } }              // 끝나면 처음부터

    static let rates: [Double] = [0.7, 0.8, 0.9, 1.0, 1.15, 1.25, 1.5]

    init() {
        let d = UserDefaults.standard
        veilText = d.object(forKey: "veilText") as? Bool ?? false
        veilKo = d.object(forKey: "veilKo") as? Bool ?? true
        rate = d.object(forKey: "rate") as? Double ?? 1.0
        lineRepeats = d.object(forKey: "lineRepeats") as? Int ?? 1
        gapMs = d.object(forKey: "gapMs") as? Int ?? 400
        loopAll = d.object(forKey: "loopAll") as? Bool ?? true
        load()
    }

    func saveSettings() {
        let d = UserDefaults.standard
        d.set(supaUrl.trimmingCharacters(in: .whitespacesAndNewlines), forKey: "supaUrl")
        d.set(supaKey.trimmingCharacters(in: .whitespacesAndNewlines), forKey: "supaKey")
        d.set(email.trimmingCharacters(in: .whitespacesAndNewlines), forKey: "email")
    }

    // ── 파일 위치 ──
    static var docs: URL { FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0] }
    static var audioDir: URL { docs.appendingPathComponent("audio", isDirectory: true) }
    static var recDir: URL { docs.appendingPathComponent("rec", isDirectory: true) }
    var itemsFile: URL { Store.docs.appendingPathComponent("items.json") }

    func audioURL(_ item: Item) -> URL { Store.audioDir.appendingPathComponent(item.audioFileName) }
    func hasLocalAudio(_ item: Item) -> Bool { FileManager.default.fileExists(atPath: audioURL(item).path) }

    func load() {
        guard let data = try? Data(contentsOf: itemsFile),
              let list = try? JSONDecoder().decode([Item].self, from: data) else { return }
        items = list
    }
    func persist() {
        if let data = try? JSONEncoder().encode(items) { try? data.write(to: itemsFile, options: .atomic) }
    }

    // 작품(제목·에피소드)별로 묶고, 작품은 최근 저장이 위, 안에서는 영상 시간순 (웹의 기본 정렬과 같다)
    var works: [Work] {
        var map: [String: Work] = [:]
        for it in items {
            let key = it.title + "\u{1}" + it.episode
            if map[key] == nil { map[key] = Work(id: key, title: it.title, episode: it.episode, platform: it.platform, items: []) }
            map[key]!.items.append(it)
        }
        var list = Array(map.values)
        for i in list.indices { list[i].items.sort { $0.startMs < $1.startMs } }
        list.sort { ($0.items.map(\.savedAt).max() ?? 0) > ($1.items.map(\.savedAt).max() ?? 0) }
        return list
    }

    var audioCount: Int { items.filter { hasLocalAudio($0) }.count }
    var storageBytes: Int64 {
        let fm = FileManager.default
        var total: Int64 = 0
        for dir in [Store.audioDir, Store.recDir] {
            guard let e = fm.enumerator(at: dir, includingPropertiesForKeys: [.fileSizeKey]) else { continue }
            for case let url as URL in e { total += Int64((try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0) }
        }
        return total
    }

    func wipe() {
        items = []
        persist()
        try? FileManager.default.removeItem(at: Store.audioDir)
        try? FileManager.default.removeItem(at: Store.recDir)
        lastSyncAt = nil
        UserDefaults.standard.removeObject(forKey: "lastSyncAt")
    }

    // ── 동기화: 로그인 → items 내려받기 → 없는 MP3 내려받기 ──
    func signIn(password: String) async {
        saveSettings()
        syncStatus = "로그인 중…"
        do {
            _ = try await Supa.shared.signIn(url: supaUrl, key: supaKey, email: email, password: password)
            signedIn = true
            syncStatus = "로그인됨 — 동기화 중…"
            await sync()   // 로그인하면 바로 목록을 받는다 (유저는 이메일·비밀번호만 넣으면 끝)
        } catch {
            signedIn = false
            syncStatus = "로그인 실패: \(Supa.describe(error))"
        }
    }

    // 앱을 켜면(활성화되면) 자동 동기화 — 10분에 한 번만. 목록만 받으니 요청 한 개, Supabase 무료 한도에 부담이 없다
    func autoSyncIfDue() async {
        guard signedIn, !syncing, !supaUrl.isEmpty, !supaKey.isEmpty else { return }
        if let last = lastSyncAt, Date().timeIntervalSince(last) < 600 { return }
        await sync()
    }

    // 목록만 받는다 (가볍게). 소리(MP3)는 목록의 다운로드 버튼(전체·작품별)이나 대사를 눌렀을 때 받아 저장한다
    func sync() async {
        guard !syncing else { return }
        syncing = true
        defer { syncing = false }
        saveSettings()
        do {
            syncStatus = "대사 목록 받는 중…"
            let fetched = try await Supa.shared.fetchItems(url: supaUrl, key: supaKey)
            items = fetched.sorted { $0.savedAt > $1.savedAt }
            persist()
            lastSyncAt = Date()
            UserDefaults.standard.set(lastSyncAt, forKey: "lastSyncAt")
            let need = items.filter { $0.hasAudio && !hasLocalAudio($0) }.count
            syncStatus = "목록 동기화 끝 — 대사 \(items.count)개" + (need > 0 ? " · 안 받은 소리 \(need)개 (⬇ 전체/작품별 다운로드)" : "")
        } catch {
            syncStatus = "동기화 실패: \(Supa.describe(error))"
        }
    }

    // ── 오디오 내려받기: 전체 ⬇ · 작품별 ⬇ · 개별(대사를 누르면 받아서 재생, 다음부터는 저장된 것) ──
    @Published var dlActive = false
    @Published var dlDone = 0
    @Published var dlFailed = 0
    @Published var dlTotal = 0
    @Published var busyIds: Set<String> = []     // 지금 받는 중인 대사 (줄에 스피너)
    private var dlCancel = false

    func pendingAudio(_ list: [Item]) -> [Item] { list.filter { $0.hasAudio && !hasLocalAudio($0) } }

    @discardableResult
    func downloadAudio(_ item: Item) async -> Bool {
        guard item.hasAudio, !hasLocalAudio(item) else { return hasLocalAudio(item) }
        busyIds.insert(item.id)
        defer { busyIds.remove(item.id) }
        do {
            try? FileManager.default.createDirectory(at: Store.audioDir, withIntermediateDirectories: true)
            let data = try await Supa.shared.downloadAudio(url: supaUrl, key: supaKey, fileName: item.audioFileName)
            try data.write(to: audioURL(item), options: .atomic)
            objectWillChange.send()   // Saved 아이콘 갱신
            return true
        } catch {
            syncStatus = "소리 받기 실패: \(Supa.describe(error))"
            return false
        }
    }

    // 전체/작품별 일괄 다운로드
    func downloadBatch(_ list: [Item]) async {
        guard !dlActive else { return }
        let need = pendingAudio(list)
        guard !need.isEmpty else { return }
        dlActive = true
        dlCancel = false
        dlTotal = need.count
        dlDone = 0
        dlFailed = 0
        for it in need {
            if dlCancel { break }
            if await downloadAudio(it) { dlDone += 1 } else { dlFailed += 1 }
        }
        dlActive = false
        syncStatus = dlCancel ? "다운로드 멈춤 — 받음 \(dlDone)개" : "다운로드 끝 — 받음 \(dlDone)개" + (dlFailed > 0 ? ", 실패 \(dlFailed)개" : "")
    }
    func cancelDownloads() { dlCancel = true }

    func signOut() {
        Supa.shared.signOut()
        signedIn = false
        syncStatus = "로그아웃했습니다 (받아 둔 대사·소리는 그대로)"
    }
}

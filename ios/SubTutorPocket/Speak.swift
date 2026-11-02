// SubTutor Pocket – 입트기(말하기 유창성 연습) 데이터: 프롬프트·녹음 기록 + Supabase 동기화 + 말하기 전용 녹음기
// 오디오(m4a)는 폰에만 둔다(Documents/speak/) — 프롬프트와 기록(길이·날짜·별점·메모·받아 적기)만 동기화한다.
// 기본 프롬프트 48개는 앱에 내장(speakPrompts.json, 웹과 같은 id) — 서버에는 고치거나 지우거나 새로 만든 것만 올라간다.
import Foundation
import AVFoundation
import UIKit
import os

struct SPrompt: Codable, Identifiable, Equatable {
    var id: String
    var text: String
    var kind: String          // short(짧게 답하기) | long(길게 말하기)
    var cat: String           // boss·student·parent·daily·opinion·class·meeting·etc·mine
    var hint: String
    var deleted: Bool
    var editedAt: Double      // ms — 서버 updated_at 과 비교해 나중에 바꾼 쪽이 이긴다
    var dirty: Bool?          // 아직 안 올린 변경
}

struct STake: Codable, Identifiable, Equatable {
    var id: String
    var pid: String           // 프롬프트 id
    var at: Double            // 녹음한 때 (ms)
    var durMs: Double         // 말한 길이 (쉼 제외)
    var mode: String          // free | step
    var targetS: Int          // 줄여 말하기 목표 초 (자유는 0)
    var rating: Int           // 별점 0~5
    var memo: String
    var heard: String         // 음성 인식으로 받아 적은 문장
    var deleted: Bool
    var editedAt: Double
    var dirty: Bool?
}

@MainActor
final class SpeakStore: ObservableObject {
    static let shared = SpeakStore()
    @Published var prompts: [SPrompt] = []
    @Published var takes: [STake] = []
    @Published var stages: [Int] = [75, 60, 45]    // 줄여 말하기 단계 (초) — 설정에서 바꾼다
    @Published var syncMsg = ""
    @Published var playingTake: String?
    private var lastSync: Double = 0
    private var seeded = false
    private var player: AVAudioPlayer?
    private var playerWatch: Timer?

    static let groups: [(String, String)] = [
        ("mine", "내 프롬프트"),
        ("short:boss", "짧게 답하기 · 교장·동료의 말"), ("short:student", "짧게 답하기 · 학생과 주고받기"),
        ("short:parent", "짧게 답하기 · 학부모"), ("short:etc", "짧게 답하기 · 그 외"),
        ("long:daily", "길게 말하기 · 일상 이야기"), ("long:opinion", "길게 말하기 · 내 생각"),
        ("long:class", "길게 말하기 · 수업에서"), ("long:meeting", "길게 말하기 · 회의에서"), ("long:etc", "길게 말하기 · 그 외"),
    ]

    private struct FileBox: Codable { var prompts: [SPrompt]; var takes: [STake]; var stages: [Int]; var lastSync: Double; var seeded: Bool }
    static var file: URL { Store.docs.appendingPathComponent("speak.json") }
    static var audioDir: URL { Store.docs.appendingPathComponent("speak", isDirectory: true) }
    static func audioURL(_ takeId: String) -> URL { audioDir.appendingPathComponent(takeId + ".m4a") }

    init() {
        if let d = try? Data(contentsOf: SpeakStore.file), let box = try? JSONDecoder().decode(FileBox.self, from: d) {
            prompts = box.prompts
            takes = box.takes
            if !box.stages.isEmpty { stages = box.stages }
            lastSync = box.lastSync
            seeded = box.seeded
        }
        seedBuiltins()
    }

    // 내장 프롬프트 채우기 — 처음 한 번 + 새 버전에서 늘어난 것 (지운 것은 deleted 가 남아 되살아나지 않는다)
    private struct Seed: Codable { var id: String; var kind: String; var cat: String; var text: String; var hint: String }
    private func seedBuiltins() {
        guard let u = Bundle.main.url(forResource: "speakPrompts", withExtension: "json"),
              let d = try? Data(contentsOf: u),
              let seeds = try? JSONDecoder().decode([Seed].self, from: d) else { return }
        var added = false
        for s in seeds where !prompts.contains(where: { $0.id == s.id }) {
            prompts.append(SPrompt(id: s.id, text: s.text, kind: s.kind, cat: s.cat, hint: s.hint, deleted: false, editedAt: 0, dirty: nil))
            added = true
        }
        if added || !seeded { seeded = true; persist() }
    }

    func persist() {
        let box = FileBox(prompts: prompts, takes: takes, stages: stages, lastSync: lastSync, seeded: seeded)
        if let d = try? JSONEncoder().encode(box) { try? d.write(to: SpeakStore.file, options: .atomic) }
    }

    // ── 프롬프트 ──
    static let now = { Date().timeIntervalSince1970 * 1000 }
    func takesOf(_ pid: String) -> [STake] { takes.filter { $0.pid == pid && !$0.deleted }.sorted { $0.at > $1.at } }
    func visiblePrompts() -> [SPrompt] { prompts.filter { !$0.deleted } }

    // 여러 줄 붙여넣기 → 1줄 1프롬프트 (번호·글머리표 떼고, 빈 줄·중복 버림) — 웹 fluency.js 와 같은 규칙
    static func parseLines(_ text: String) -> [String] {
        var seen = Set<String>()
        var out: [String] = []
        for raw in text.components(separatedBy: .newlines) {
            var t = raw.trimmingCharacters(in: .whitespaces)
            t = t.replacingOccurrences(of: #"^(?:[-*•▪·–—]|\d+[.)]|\(\d+\))\s*"#, with: "", options: .regularExpression)
            t = t.trimmingCharacters(in: .whitespaces)
            if t.isEmpty || seen.contains(t.lowercased()) { continue }
            seen.insert(t.lowercased())
            out.append(t)
        }
        return out
    }

    @discardableResult
    func addPrompts(_ text: String, kind: String) -> Int {
        let lines = SpeakStore.parseLines(text)
        let base = SpeakStore.now()
        for (i, t) in lines.enumerated() {
            let id = "u" + String(Int(base) + i, radix: 36) + String(Int.random(in: 1000...9999))
            prompts.append(SPrompt(id: id, text: t, kind: kind, cat: "mine", hint: "", deleted: false, editedAt: base, dirty: true))
        }
        if !lines.isEmpty { persist(); pushSoon() }
        return lines.count
    }
    func updatePrompt(_ id: String, text: String? = nil, hint: String? = nil) {
        guard let i = prompts.firstIndex(where: { $0.id == id }) else { return }
        if let text { prompts[i].text = text }
        if let hint { prompts[i].hint = hint }
        prompts[i].editedAt = SpeakStore.now()
        prompts[i].dirty = true
        persist()
    }
    func deletePrompt(_ id: String) {
        guard let i = prompts.firstIndex(where: { $0.id == id }) else { return }
        prompts[i].deleted = true
        prompts[i].editedAt = SpeakStore.now()
        prompts[i].dirty = true
        persist()
        pushSoon()
    }

    // ── 녹음 기록 ──
    static func newTakeId() -> String { "t" + String(Int(now()), radix: 36) + String(Int.random(in: 1000...9999)) }

    @discardableResult
    func addTake(id: String, pid: String, mode: String, targetS: Int, durMs: Double) -> STake {
        let t = STake(id: id, pid: pid, at: SpeakStore.now(), durMs: durMs, mode: mode, targetS: targetS,
                      rating: 0, memo: "", heard: "", deleted: false, editedAt: SpeakStore.now(), dirty: true)
        takes.append(t)
        persist()
        pushSoon()
        return t
    }
    private func mark(_ id: String, _ change: (inout STake) -> Void) {
        guard let i = takes.firstIndex(where: { $0.id == id }) else { return }
        change(&takes[i])
        takes[i].editedAt = SpeakStore.now()
        takes[i].dirty = true
        persist()
    }
    func setRating(_ id: String, _ r: Int) { mark(id) { $0.rating = $0.rating == r ? 0 : r }; pushSoon() }
    func setMemo(_ id: String, _ m: String) { mark(id) { $0.memo = m } }
    func setHeard(_ id: String, _ h: String) { mark(id) { $0.heard = h }; pushSoon() }
    func deleteTake(_ id: String) {
        mark(id) { $0.deleted = true }
        try? FileManager.default.removeItem(at: SpeakStore.audioURL(id))
        pushSoon()
    }
    func hasAudio(_ id: String) -> Bool { FileManager.default.fileExists(atPath: SpeakStore.audioURL(id).path) }

    func stats() -> String {
        let cal = Calendar.current
        let day0 = cal.startOfDay(for: Date()).timeIntervalSince1970 * 1000
        let week0 = SpeakStore.now() - 7 * 86_400_000
        let live = takes.filter { !$0.deleted }
        let today = live.filter { $0.at >= day0 }
        let week = live.filter { $0.at >= week0 }
        let secs = { (a: [STake]) in Int((a.reduce(0) { $0 + $1.durMs } / 1000).rounded()) }
        return "오늘 \(today.count)회 · \(SpeakStore.clock(secs(today))) — 이번 주 \(week.count)회 · \(SpeakStore.clock(secs(week)))"
    }
    static func clock(_ s: Int) -> String { "\(max(0, s) / 60):" + String(format: "%02d", max(0, s) % 60) }
    static func clock(_ s: Double) -> String { clock(Int(s.rounded())) }
    // 줄여 말하기 결과: +N초 초과 / N초 부족 / 딱 맞춤 (웹 fluency.js 와 같은 규칙)
    static func overUnder(targetS: Int, actualS: Double) -> (diff: Int, text: String) {
        let d = Int(actualS.rounded()) - targetS
        if d > 0 { return (d, "\(d)초 초과") }
        if d < 0 { return (d, "\(-d)초 부족") }
        return (0, "딱 맞춤")
    }
    static func wpm(_ heard: String, durMs: Double) -> Int? {
        let words = heard.split(whereSeparator: { $0.isWhitespace }).count
        guard words > 0, durMs >= 1000 else { return nil }
        return Int((Double(words) / (durMs / 60000)).rounded())
    }

    // ── 재생 (폰에 있는 녹음만) ──
    func play(_ take: STake) {
        if playingTake == take.id { stopPlay(); return }
        stopPlay()
        let u = SpeakStore.audioURL(take.id)
        guard let p = try? AVAudioPlayer(contentsOf: u) else { return }
        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .spokenAudio)
        try? AVAudioSession.sharedInstance().setActive(true)
        player = p
        playingTake = take.id
        p.play()
        playerWatch = Timer.scheduledTimer(withTimeInterval: 0.2, repeats: true) { [weak self] _ in
            Task { @MainActor in
                guard let self, let p = self.player else { return }
                if !p.isPlaying { self.stopPlay() }
            }
        }
    }
    func stopPlay() {
        player?.stop()
        player = nil
        playingTake = nil
        playerWatch?.invalidate()
        playerWatch = nil
    }

    // ── 동기화: 바뀐 것(dirty)만 올리고, lastSync 뒤에 바뀐 것을 받아 와 나중에 바꾼 쪽이 이긴다 ──
    private var syncing = false
    private var pushTask: Task<Void, Never>?
    // 폰에서 바꾸면 잠시 뒤 조용히 올린다 (로그인돼 있을 때만) — 실패해도 다음 동기화 때 dirty 로 다시 올라간다
    func pushSoon() {
        pushTask?.cancel()
        pushTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 2_000_000_000)
            guard let self, !Task.isCancelled else { return }
            let s = Store.sharedForSpeak
            guard let s, s.signedIn else { return }
            await self.sync(url: s.supaUrl, key: s.supaKey)
        }
    }

    private static func iso(_ ms: Double) -> String {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f.string(from: Date(timeIntervalSince1970: max(0, ms) / 1000))   // 0(처음)은 1970 — "지금"으로 만들면 첫 받아 오기가 전부 빠진다
    }

    func sync(url: String, key: String) async {
        guard !syncing, !url.isEmpty, !key.isEmpty else { return }
        syncing = true
        defer { syncing = false }
        do {
            let pRows: [[String: Any]] = prompts.filter { $0.dirty == true }.map {
                ["id": $0.id, "text": $0.text, "kind": $0.kind, "cat": $0.cat, "hint": $0.hint,
                 "deleted": $0.deleted, "updated_at": SpeakStore.iso($0.editedAt > 0 ? $0.editedAt : SpeakStore.now())]
            }
            let tRows: [[String: Any]] = takes.filter { $0.dirty == true }.map {
                ["id": $0.id, "prompt_id": $0.pid, "at": Int($0.at), "dur_ms": Int($0.durMs), "mode": $0.mode,
                 "target_s": $0.targetS, "rating": $0.rating, "memo": $0.memo, "heard": $0.heard,
                 "deleted": $0.deleted, "updated_at": SpeakStore.iso($0.editedAt > 0 ? $0.editedAt : SpeakStore.now())]
            }
            try await Supa.shared.upsertRows(url: url, key: key, table: "speak_prompts", rows: pRows)
            try await Supa.shared.upsertRows(url: url, key: key, table: "speak_takes", rows: tRows)
            for i in prompts.indices { prompts[i].dirty = nil }
            for i in takes.indices { takes[i].dirty = nil }
            let since = SpeakStore.iso(max(0, lastSync - 2000))
            let iso = ISO8601DateFormatter()
            iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            let parse = { (s: Any?) -> Double in
                guard let s = s as? String else { return 0 }
                return (iso.date(from: s) ?? ISO8601DateFormatter().date(from: s))?.timeIntervalSince1970 ?? 0
            }
            for row in try await Supa.shared.fetchRows(url: url, key: key, table: "speak_prompts", sinceISO: since) {
                guard let id = row["id"] as? String else { continue }
                let at = parse(row["updated_at"]) * 1000
                if let i = prompts.firstIndex(where: { $0.id == id }) {
                    if at <= prompts[i].editedAt { continue }
                    prompts[i].text = row["text"] as? String ?? ""
                    prompts[i].kind = row["kind"] as? String ?? "short"
                    prompts[i].cat = row["cat"] as? String ?? "mine"
                    prompts[i].hint = row["hint"] as? String ?? ""
                    prompts[i].deleted = row["deleted"] as? Bool ?? false
                    prompts[i].editedAt = at
                    prompts[i].dirty = nil
                } else {
                    prompts.append(SPrompt(id: id, text: row["text"] as? String ?? "", kind: row["kind"] as? String ?? "short",
                                           cat: row["cat"] as? String ?? "mine", hint: row["hint"] as? String ?? "",
                                           deleted: row["deleted"] as? Bool ?? false, editedAt: at, dirty: nil))
                }
            }
            for row in try await Supa.shared.fetchRows(url: url, key: key, table: "speak_takes", sinceISO: since) {
                guard let id = row["id"] as? String else { continue }
                let at = parse(row["updated_at"]) * 1000
                let make = { (old: STake?) -> STake in
                    STake(id: id, pid: row["prompt_id"] as? String ?? "",
                          at: (row["at"] as? NSNumber)?.doubleValue ?? old?.at ?? 0,
                          durMs: (row["dur_ms"] as? NSNumber)?.doubleValue ?? 0,
                          mode: row["mode"] as? String ?? "free", targetS: (row["target_s"] as? NSNumber)?.intValue ?? 0,
                          rating: (row["rating"] as? NSNumber)?.intValue ?? 0, memo: row["memo"] as? String ?? "",
                          heard: row["heard"] as? String ?? "", deleted: row["deleted"] as? Bool ?? false,
                          editedAt: at, dirty: nil)
                }
                if let i = takes.firstIndex(where: { $0.id == id }) {
                    if at <= takes[i].editedAt { continue }
                    takes[i] = make(takes[i])
                } else {
                    takes.append(make(nil))
                }
            }
            lastSync = SpeakStore.now()
            syncMsg = "동기화 끝 (오디오는 녹음한 기기에만)"
            persist()
        } catch {
            let m = Supa.describe(error)
            syncMsg = m.contains("42P01") || m.lowercased().contains("could not find the table") || m.lowercased().contains("does not exist")
                ? "서버에 입트기 표가 없습니다 — supabase/schema.sql 의 \"입트기\" 블록을 실행하세요"
                : "동기화 실패: \(m)"
        }
    }
}

extension Store {
    // SpeakStore 의 지연 올리기가 로그인 정보를 읽을 수 있게 — App 이 만든 Store 하나를 기억해 둔다
    static weak var sharedForSpeak: Store?
}

// ── 말하기 전용 녹음기: 멈춤·재개(쉰 시간은 길이에서 뺀다) + 파형 미터 ──
@MainActor
final class SpeakRecorder: ObservableObject {
    @Published var running = false
    @Published var paused = false
    @Published var elapsed: Double = 0          // 말한 시간 (초, 쉼 제외 — AVAudioRecorder.currentTime)
    @Published var meters: [CGFloat] = []       // 파형 막대 (0~1, 최근 40개)
    private var rec: AVAudioRecorder?
    private var timer: Timer?
    private(set) var url: URL?

    func start(url: URL) async -> Bool {
        let granted = await withCheckedContinuation { (c: CheckedContinuation<Bool, Never>) in
            AVAudioSession.sharedInstance().requestRecordPermission { ok in c.resume(returning: ok) }
        }
        guard granted else { return false }
        let s = AVAudioSession.sharedInstance()
        try? s.setCategory(.playAndRecord, mode: .spokenAudio, options: [.defaultToSpeaker, .allowBluetooth])
        try? s.setActive(true)
        try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        let settings: [String: Any] = [
            AVFormatIDKey: kAudioFormatMPEG4AAC,
            AVSampleRateKey: 32000,
            AVNumberOfChannelsKey: 1,
            AVEncoderBitRateKey: 48000,
        ]
        guard let r = try? AVAudioRecorder(url: url, settings: settings) else { return false }
        self.url = url
        rec = r
        r.isMeteringEnabled = true
        r.record()
        running = true
        paused = false
        elapsed = 0
        meters = []
        UIApplication.shared.isIdleTimerDisabled = true   // 말하는 동안 화면이 꺼지지 않게
        timer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.tick() }
        }
        return true
    }
    private func tick() {
        guard let r = rec else { return }
        elapsed = r.currentTime
        guard !paused else { return }
        r.updateMeters()
        let db = r.averagePower(forChannel: 0)            // -160…0
        let level = CGFloat(max(0, min(1, (db + 50) / 50)))
        meters.append(level)
        if meters.count > 40 { meters.removeFirst(meters.count - 40) }
    }
    func pauseToggle() {
        guard let r = rec else { return }
        if paused { r.record(); paused = false } else { r.pause(); paused = true }
    }
    // 끝: (파일, 말한 ms). discard 면 파일을 지우고 nil
    @discardableResult
    func stop(discard: Bool = false) -> (URL, Double)? {
        timer?.invalidate()
        timer = nil
        let ms = (rec?.currentTime ?? elapsed) * 1000
        rec?.stop()
        rec = nil
        running = false
        paused = false
        UIApplication.shared.isIdleTimerDisabled = false
        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .spokenAudio)
        guard let u = url else { return nil }
        url = nil
        if discard { try? FileManager.default.removeItem(at: u); return nil }
        return (u, ms)
    }
}

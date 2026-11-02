// SubTutor Pocket – 발음 확인: 내 녹음을 iOS 음성 인식(가능하면 기기 안에서, 인터넷 없이)으로 받아 적어 원문과 단어 단위로 비교한다.
// 인식이 안 되는 환경(권한 거부·미지원·오프라인 서버 인식)에서는 조용히 넘어간다 — 녹음은 그대로.
// 근거: 말하기는 원어민이 알아듣는 정도(intelligibility)로 점검하는 것이 유용하다 (Derwing & Munro 2005, TESOL Quarterly 39(3)).
import Foundation
import Speech

struct SpeechResult: Codable, Equatable {
    var score: Int          // 원문 단어 중 인식된 비율 (%)
    var heard: String       // 인식된 문장
    var missed: [String]    // 원문에서 인식되지 않은 단어
    // 녹음 파일 옆에 <같은 이름>.json 으로 둔다
    static func file(for url: URL) -> URL { url.deletingPathExtension().appendingPathExtension("json") }
    static func load(for url: URL) -> SpeechResult? {
        guard let d = try? Data(contentsOf: file(for: url)) else { return nil }
        return try? JSONDecoder().decode(SpeechResult.self, from: d)
    }
    func save(for url: URL) {
        if let d = try? JSONEncoder().encode(self) { try? d.write(to: SpeechResult.file(for: url), options: .atomic) }
    }
    static func remove(for url: URL) { try? FileManager.default.removeItem(at: file(for: url)) }
}

enum SpeechCheck {
    static func authorize() async -> Bool {
        switch SFSpeechRecognizer.authorizationStatus() {
        case .authorized: return true
        case .denied, .restricted: return false
        default:
            return await withCheckedContinuation { (c: CheckedContinuation<Bool, Never>) in
                SFSpeechRecognizer.requestAuthorization { c.resume(returning: $0 == .authorized) }
            }
        }
    }

    static func check(url: URL, reference: String) async -> SpeechResult? {
        guard await authorize() else { return nil }
        guard let heard = await recognize(url, timeout: 20), !heard.isEmpty else { return nil }
        let (score, missed) = compare(reference: reference, heard: heard)
        return SpeechResult(score: score, heard: heard, missed: missed)
    }

    // 결과 콜백이 여러 번 와도 한 번만 이어 가게
    private final class Once<T> {
        private var done = false
        private let lock = NSLock()
        private let cont: CheckedContinuation<T, Never>
        init(_ c: CheckedContinuation<T, Never>) { cont = c }
        func resume(_ v: T) {
            lock.lock(); defer { lock.unlock() }
            if done { return }
            done = true
            cont.resume(returning: v)
        }
    }

    static func recognize(_ url: URL, timeout: Double = 20) async -> String? {
        // 뉴질랜드 영어 인식기가 있으면 그것을, 없으면 미국 영어
        let nz = SFSpeechRecognizer(locale: Locale(identifier: "en-NZ"))
        let rec = (nz?.isAvailable == true ? nz : nil) ?? SFSpeechRecognizer(locale: Locale(identifier: "en-US"))
        guard let rec, rec.isAvailable else { return nil }
        let req = SFSpeechURLRecognitionRequest(url: url)
        req.shouldReportPartialResults = false
        if rec.supportsOnDeviceRecognition { req.requiresOnDeviceRecognition = true }
        return await withCheckedContinuation { (c: CheckedContinuation<String?, Never>) in
            let once = Once(c)
            let task = rec.recognitionTask(with: req) { result, error in
                if let result, result.isFinal { once.resume(result.bestTranscription.formattedString) }
                else if error != nil { once.resume(nil) }
            }
            DispatchQueue.global().asyncAfter(deadline: .now() + timeout) { _ = rec; task.cancel(); once.resume(nil) }   // 제한 시간 넘으면 포기
        }
    }

    // 비교용 단어: 소리 설명([laughs], (MUSIC), LAUGHS:)·화자 줄표·문장부호를 빼고 소문자로
    static func words(_ s: String) -> [String] {
        var t = s.replacingOccurrences(of: "’", with: "'")
        t = t.replacingOccurrences(of: "\\[[^\\]]*\\]|\\([^)]*\\)", with: " ", options: .regularExpression)
        t = t.replacingOccurrences(of: "\\b[A-Z][A-Z ]+:", with: " ", options: .regularExpression)
        t = t.lowercased().replacingOccurrences(of: "[^a-z0-9' ]+", with: " ", options: .regularExpression)
        return t.split(separator: " ").map { $0.trimmingCharacters(in: CharacterSet(charactersIn: "'")) }.filter { !$0.isEmpty }
    }

    // 원문 단어 중 순서대로 인식된 비율(최장 공통 부분열)과 인식되지 않은 원문 단어
    static func compare(reference: String, heard: String) -> (Int, [String]) {
        let a = words(reference), b = words(heard)
        guard !a.isEmpty else { return (0, []) }
        var dp = Array(repeating: Array(repeating: 0, count: b.count + 1), count: a.count + 1)
        for i in stride(from: a.count - 1, through: 0, by: -1) {
            for j in stride(from: b.count - 1, through: 0, by: -1) {
                dp[i][j] = a[i] == b[j] ? dp[i + 1][j + 1] + 1 : max(dp[i + 1][j], dp[i][j + 1])
            }
        }
        var i = 0, j = 0
        var missed: [String] = []
        while i < a.count {
            if j < b.count && a[i] == b[j] { i += 1; j += 1 }
            else if j < b.count && dp[i][j + 1] >= dp[i + 1][j] { j += 1 }
            else { missed.append(a[i]); i += 1 }
        }
        return (Int((Double(dp[0][0]) / Double(a.count) * 100).rounded()), missed)
    }
}

// SubTutor Pocket – 내 목소리 녹음: 대사마다 3개까지(웹과 같은 규칙), 4번째를 녹음하면 가장 오래된 것이 지워진다.
// 파일은 Documents/rec/<대사 파일 이름>/<시각>.m4a — 폰 안에만 있고 서버로 올라가지 않는다.
import Foundation
import AVFoundation

@MainActor
final class Recorder: NSObject, ObservableObject, AVAudioRecorderDelegate {
    static let maxTakes = 3
    @Published var recordingFor: String?      // 녹음 중인 대사 id
    @Published var startedAt: Date?
    @Published var lists: [String: [URL]] = [:]  // 대사 id → 녹음 파일들(오래된 것부터)
    private var recorder: AVAudioRecorder?

    private func dir(_ item: Item) -> URL { Store.recDir.appendingPathComponent(Item.safeName(item.id), isDirectory: true) }

    func takes(_ item: Item) -> [URL] {
        if let l = lists[item.id] { return l }
        let d = dir(item)
        let files = ((try? FileManager.default.contentsOfDirectory(at: d, includingPropertiesForKeys: nil)) ?? [])
            .filter { $0.pathExtension == "m4a" }
            .sorted { $0.lastPathComponent < $1.lastPathComponent }
        lists[item.id] = files
        return files
    }

    func toggle(_ item: Item) async {
        if recordingFor == item.id { stop(item); return }
        if recordingFor != nil { recorder?.stop(); recorder = nil; recordingFor = nil }
        // 마이크 허용 (처음 한 번 묻는다)
        let granted = await withCheckedContinuation { (c: CheckedContinuation<Bool, Never>) in
            AVAudioSession.sharedInstance().requestRecordPermission { ok in c.resume(returning: ok) }
        }
        guard granted else { return }
        let s = AVAudioSession.sharedInstance()
        try? s.setCategory(.playAndRecord, mode: .spokenAudio, options: [.defaultToSpeaker, .allowBluetooth])
        try? s.setActive(true)
        let d = dir(item)
        try? FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        let f = DateFormatter()
        f.dateFormat = "yyyyMMdd-HHmmss"
        let url = d.appendingPathComponent(f.string(from: Date()) + ".m4a")
        let settings: [String: Any] = [
            AVFormatIDKey: kAudioFormatMPEG4AAC,
            AVSampleRateKey: 32000,
            AVNumberOfChannelsKey: 1,
            AVEncoderBitRateKey: 48000,
        ]
        guard let r = try? AVAudioRecorder(url: url, settings: settings) else { return }
        recorder = r
        r.record()
        recordingFor = item.id
        startedAt = Date()
    }

    func stop(_ item: Item) {
        guard recordingFor == item.id else { return }
        recorder?.stop()
        recorder = nil
        recordingFor = nil
        startedAt = nil
        // 3개 넘으면 가장 오래된 것부터 지운다
        var files = takesFresh(item)
        while files.count > Recorder.maxTakes {
            try? FileManager.default.removeItem(at: files.removeFirst())
        }
        lists[item.id] = files
        // 재생 세션으로 되돌린다 (스피커 녹음 모드에서 나와야 다음 재생 소리가 제대로 난다)
        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .spokenAudio)
    }

    private func takesFresh(_ item: Item) -> [URL] {
        lists[item.id] = nil
        return takes(item)
    }

    func remove(_ item: Item, url: URL) {
        try? FileManager.default.removeItem(at: url)
        lists[item.id] = nil
        _ = takes(item)
    }
}

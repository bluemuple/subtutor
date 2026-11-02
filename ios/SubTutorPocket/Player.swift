// SubTutor Pocket – 재생: 한 대사 재생(반복 토글이면 끝없이), 속도 사다리(한 대사를 단계별 배속으로),
// 연속 듣기(이동 중, 대사 사이에 따라 말할 시간), 배속(음높이 유지), 잠금 화면 제어
// 화면을 꺼도 이어지도록 AVAudioSession .playback + UIBackgroundModes audio 를 쓰고,
// 잠금 화면·이어폰 버튼은 MPRemoteCommandCenter 로 받는다. 대사 사이 쉼 동안에는 소리 없는 오디오를 틀어 둔다 —
// 소리가 멈춘 동안에는 iOS 가 앱을 재울 수 있어, 그대로 두면 따라 말할 시간처럼 긴 쉼 뒤에 다음 대사로 못 넘어간다.
import Foundation
import AVFoundation
import MediaPlayer
import os

let playLog = Logger(subsystem: "com.bluemuple.subtutor.pocket", category: "player")   // 재생 흐름 기록 (Console 앱에서 볼 수 있다)

@MainActor
final class Player: NSObject, ObservableObject, AVAudioPlayerDelegate {
    weak var store: Store?
    @Published var nowId: String?          // 지금 재생 중(또는 일시정지)인 대사
    @Published var isPlaying = false
    @Published var continuous = false      // 연속 듣기 모드
    @Published var queue: [Item] = []
    @Published var queueIndex = 0
    @Published var playingRec: URL?        // 내 녹음 재생 중이면 그 파일
    @Published var ladderId: String?       // 속도 사다리로 재생 중인 대사
    @Published var ladderRate: Double?     // 그 사다리의 지금 단계 배속
    @Published var waiting = false         // 대사 사이 쉼(따라 말할 시간) 중

    private var player: AVAudioPlayer?
    private var recPlayer: AVAudioPlayer?
    private var silence: AVAudioPlayer?
    private var lineRepeatLeft = 1
    private var afterOriginal: (() -> Void)?   // 같이 듣기: 원음 뒤에 할 일
    private var ladderRates: [Double] = []
    private var ladderIndex = 0
    private var gen = 0                        // 쉼 뒤에 예약한 재생을 무르는 번호 (다른 조작이 있으면 올린다)

    override init() {
        super.init()
        let center = MPRemoteCommandCenter.shared()
        center.playCommand.addTarget { [weak self] _ in Task { @MainActor in self?.resume() }; return .success }
        center.pauseCommand.addTarget { [weak self] _ in Task { @MainActor in self?.pause() }; return .success }
        center.togglePlayPauseCommand.addTarget { [weak self] _ in Task { @MainActor in self?.toggle() }; return .success }
        center.nextTrackCommand.addTarget { [weak self] _ in Task { @MainActor in self?.next() }; return .success }
        center.previousTrackCommand.addTarget { [weak self] _ in Task { @MainActor in self?.prev() }; return .success }
    }

    private func activateSession() {
        let s = AVAudioSession.sharedInstance()
        try? s.setCategory(.playback, mode: .spokenAudio)
        try? s.setActive(true)
    }

    private func load(_ item: Item) -> AVAudioPlayer? {
        guard let store, store.hasLocalAudio(item) else { return nil }
        guard let p = try? AVAudioPlayer(contentsOf: store.audioURL(item)) else { return nil }
        p.enableRate = true   // 배속을 바꿔도 음높이는 그대로 (AVAudioPlayer 가 길이만 바꾼다)
        p.delegate = self
        return p
    }

    // ── 쉼: 소리 없는 1초짜리 WAV 를 반복해 앱이 잠들지 않게 하고, 정한 시간 뒤에 다음 일을 한다 ──
    private lazy var silenceData: Data = {
        let sr = 8000, n = 8000
        var d = Data()
        func u32(_ v: Int) { var x = UInt32(v).littleEndian; withUnsafeBytes(of: &x) { d.append(contentsOf: $0) } }
        func u16(_ v: Int) { var x = UInt16(v).littleEndian; withUnsafeBytes(of: &x) { d.append(contentsOf: $0) } }
        d.append(contentsOf: Array("RIFF".utf8)); u32(36 + n * 2); d.append(contentsOf: Array("WAVE".utf8))
        d.append(contentsOf: Array("fmt ".utf8)); u32(16); u16(1); u16(1); u32(sr); u32(sr * 2); u16(2); u16(16)
        d.append(contentsOf: Array("data".utf8)); u32(n * 2); d.append(Data(count: n * 2))
        return d
    }()
    private func holdSilence() {
        if silence == nil, let s = try? AVAudioPlayer(data: silenceData) { s.numberOfLoops = -1; s.volume = 0; silence = s }
        if silence?.isPlaying != true { silence?.play() }
    }
    private func releaseSilence() { silence?.stop(); waiting = false }
    private func pauseThen(_ seconds: Double, _ action: @escaping () -> Void) {
        let g = gen
        holdSilence()
        waiting = true
        DispatchQueue.main.asyncAfter(deadline: .now() + max(0.05, seconds)) { [weak self] in
            guard let self, self.gen == g else { return }
            self.waiting = false
            action()
        }
    }

    // ── 한 대사 ──
    func playItem(_ item: Item) {
        gen += 1
        stopRec()
        afterOriginal = nil
        continuous = false
        endLadder()
        start(item, repeats: 1)
    }

    func toggleItem(_ item: Item) {
        if nowId == item.id { toggle() } else { playItem(item) }
    }

    private func start(_ item: Item, repeats: Int, rate: Double? = nil) {
        guard let p = load(item) else { nowId = nil; isPlaying = false; releaseSilence(); return }
        activateSession()
        releaseSilence()
        player?.stop()
        player = p
        nowId = item.id
        lineRepeatLeft = max(1, repeats)
        p.rate = Float(rate ?? store?.rate ?? 1)
        playLog.info("start \(item.id, privacy: .public) rate=\(p.rate)")
        p.play()
        isPlaying = true
        updateNowPlaying(item)
    }

    // ── 속도 사다리: 한 대사를 설정한 배속 단계대로 한 번씩 (예: 0.5 → 0.7 → 0.9 → 1). 한 번 더 누르면 멈춤 ──
    func playLadder(_ item: Item) {
        if ladderId == item.id { stop(); return }
        let rates = (store?.ladderRates ?? [1]).filter { $0 > 0 }
        guard !rates.isEmpty else { return }
        gen += 1
        stopRec()
        afterOriginal = nil
        continuous = false
        ladderRates = rates
        ladderIndex = 0
        ladderId = item.id
        ladderRate = rates[0]
        start(item, repeats: 1, rate: rates[0])
    }
    private func endLadder() { ladderId = nil; ladderRate = nil; ladderRates = [] }

    func toggle() { isPlaying ? pause() : resume() }
    func pause() {
        gen += 1   // 쉼 뒤에 예약해 둔 다음 재생을 무른다
        player?.pause(); recPlayer?.pause(); releaseSilence()
        isPlaying = false
        updateRate(0)
    }
    func resume() {
        activateSession()
        if let r = recPlayer { r.play(); isPlaying = true; updateRate(1); return }
        guard let p = player else { if continuous { playCurrent() }; return }
        p.play()
        isPlaying = true
        updateRate(p.rate)
    }
    func stop() {
        gen += 1
        player?.stop(); player = nil
        stopRec()
        releaseSilence()
        endLadder()
        nowId = nil
        isPlaying = false
        continuous = false
        MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
    }

    func setRate(_ r: Double) {
        store?.rate = r
        if ladderId == nil { player?.rate = Float(r) }   // 사다리 중에는 단계 배속을 그대로 둔다
        if isPlaying { updateRate(player?.rate ?? Float(r)) }
    }

    // ── 연속 듣기 (이동 중): 작품(또는 보이는 목록)의 소리 있는 대사를 차례로, 대사마다 N번씩 ──
    func startContinuous(_ items: [Item], from: Item? = nil) {
        guard let store else { return }
        let playable = items.filter { store.hasLocalAudio($0) }
        guard !playable.isEmpty else { return }
        gen += 1
        stopRec()
        afterOriginal = nil
        endLadder()
        queue = playable
        queueIndex = from.flatMap { f in playable.firstIndex(where: { $0.id == f.id }) } ?? 0
        continuous = true
        playCurrent()
    }
    private func playCurrent() {
        guard continuous, queue.indices.contains(queueIndex) else { stop(); return }
        start(queue[queueIndex], repeats: store?.lineRepeats ?? 1)
    }
    func next() {
        guard continuous else { return }
        gen += 1
        queueIndex += 1
        if queueIndex >= queue.count {
            if store?.loopAll == true { queueIndex = 0 } else { stop(); return }
        }
        playCurrent()
    }
    func prev() {
        guard continuous else { return }
        gen += 1
        queueIndex = max(0, queueIndex - 1)
        playCurrent()
    }
    var currentItem: Item? {
        if continuous, queue.indices.contains(queueIndex) { return queue[queueIndex] }
        guard let id = nowId else { return nil }
        return store?.items.first(where: { $0.id == id })
    }

    // ── 같이 듣기: 원음 → 내 최근 녹음 ──
    func playTogether(_ item: Item, recording: URL) {
        gen += 1
        continuous = false
        endLadder()
        stopRec()
        afterOriginal = { [weak self] in self?.playRecording(recording, for: item) }
        start(item, repeats: 1)
    }
    func playRecording(_ url: URL, for item: Item?) {
        activateSession()
        releaseSilence()
        player?.stop(); player = nil
        guard let p = try? AVAudioPlayer(contentsOf: url) else { return }
        recPlayer = p
        p.delegate = self
        playingRec = url
        if let item { nowId = item.id }
        p.play()
        isPlaying = true
    }
    private func stopRec() {
        recPlayer?.stop(); recPlayer = nil
        playingRec = nil
    }

    // 따라 말할 시간: 방금 들은 대사의 실제 길이 × 배율 (0.6~15초)
    private func shadowGap(_ p: AVAudioPlayer) -> Double {
        let ratio = store?.shadowRatio ?? 0
        guard ratio > 0 else { return 0 }
        let real = p.duration / Double(max(0.1, p.rate))
        return min(15, max(0.6, real * ratio))
    }

    // ── 끝났을 때: 같이 듣기 → 속도 사다리 다음 단계 → 같은 대사 N번 → (연속이면) 쉬고 다음 대사 / (반복 토글이면) 다시 ──
    nonisolated func audioPlayerDidFinishPlaying(_ p: AVAudioPlayer, successfully flag: Bool) {
        Task { @MainActor in self.finished(p) }
    }
    private func finished(_ p: AVAudioPlayer) {
        if p === recPlayer { stopRec(); if !continuous { isPlaying = false; nowId = nil }; return }
        guard p === player else { return }
        if let then = afterOriginal { afterOriginal = nil; then(); return }
        if let lid = ladderId, lid == nowId, let item = currentItem {
            ladderIndex += 1
            if ladderIndex < ladderRates.count {
                let r = ladderRates[ladderIndex]
                pauseThen(0.5) { [weak self] in self?.ladderRate = r; self?.start(item, repeats: 1, rate: r) }
            } else {
                endLadder()
                isPlaying = false
            }
            return
        }
        let shadow = continuous ? shadowGap(p) : 0
        if lineRepeatLeft > 1 {
            lineRepeatLeft -= 1
            if shadow > 0 {
                pauseThen(shadow) { [weak self] in self?.replay() }
            } else {
                p.currentTime = 0
                p.play()
            }
            return
        }
        if continuous {
            let gap = shadow > 0 ? shadow : Double(store?.gapMs ?? 400) / 1000
            pauseThen(gap) { [weak self] in
                guard let self, self.continuous else { return }
                self.queueIndex += 1
                if self.queueIndex >= self.queue.count {
                    if self.store?.loopAll == true { self.queueIndex = 0 } else { self.stop(); return }
                }
                self.playCurrent()
            }
        } else if store?.repeatMode == true {
            pauseThen(0.4) { [weak self] in self?.replay() }   // 반복 토글: 같은 대사를 끝없이
        } else {
            isPlaying = false
        }
    }
    private func replay() {
        guard let p = player else { return }
        playLog.info("replay rate=\(p.rate)")
        releaseSilence()
        p.currentTime = 0
        p.play()
        isPlaying = true
    }

    // ── 잠금 화면 표시 ──
    private func updateNowPlaying(_ item: Item) {
        var info: [String: Any] = [
            MPMediaItemPropertyTitle: item.text.replacingOccurrences(of: "\n", with: " "),
            MPMediaItemPropertyArtist: item.title + (item.episode.isEmpty ? "" : " · " + item.episode),
            MPMediaItemPropertyAlbumTitle: "자막 튜터",
        ]
        if let d = player?.duration { info[MPMediaItemPropertyPlaybackDuration] = d }
        info[MPNowPlayingInfoPropertyPlaybackRate] = Double(player?.rate ?? 1)
        MPNowPlayingInfoCenter.default().nowPlayingInfo = info
    }
    private func updateRate(_ r: Float) {
        var info = MPNowPlayingInfoCenter.default().nowPlayingInfo ?? [:]
        info[MPNowPlayingInfoPropertyPlaybackRate] = r
        if let t = player?.currentTime { info[MPNowPlayingInfoPropertyElapsedPlaybackTime] = t }
        MPNowPlayingInfoCenter.default().nowPlayingInfo = info
    }
}

// SubTutor Pocket – 재생: 한 대사 재생·반복, 연속 듣기(이동 중), 배속(음높이 유지), 잠금 화면 제어
// 화면을 꺼도 이어지도록 AVAudioSession .playback + UIBackgroundModes audio 를 쓰고,
// 잠금 화면·이어폰 버튼은 MPRemoteCommandCenter 로 받는다. 대사 사이 쉼은 짧게(기본 0.4초) 둔다 —
// 소리가 멈춘 동안 앱이 잠들 수 있어, 쉼이 길면 다음 대사로 못 넘어갈 수 있다.
import Foundation
import AVFoundation
import MediaPlayer

@MainActor
final class Player: NSObject, ObservableObject, AVAudioPlayerDelegate {
    weak var store: Store?
    @Published var nowId: String?          // 지금 재생 중(또는 일시정지)인 대사
    @Published var isPlaying = false
    @Published var continuous = false      // 연속 듣기 모드
    @Published var queue: [Item] = []
    @Published var queueIndex = 0
    @Published var playingRec: URL?        // 내 녹음 재생 중이면 그 파일

    private var player: AVAudioPlayer?
    private var recPlayer: AVAudioPlayer?
    private var lineRepeatLeft = 1
    private var afterOriginal: (() -> Void)?   // 같이 듣기: 원음 뒤에 할 일
    private var gen = 0

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

    // ── 한 대사 ──
    func playItem(_ item: Item) {
        gen += 1
        stopRec()
        afterOriginal = nil
        continuous = false
        start(item, repeats: 1)
    }

    func toggleItem(_ item: Item) {
        if nowId == item.id { toggle() } else { playItem(item) }
    }

    private func start(_ item: Item, repeats: Int) {
        guard let p = load(item) else { nowId = nil; isPlaying = false; return }
        activateSession()
        player?.stop()
        player = p
        nowId = item.id
        lineRepeatLeft = max(1, repeats)
        p.rate = Float(store?.rate ?? 1)
        p.play()
        isPlaying = true
        updateNowPlaying(item)
    }

    func toggle() { isPlaying ? pause() : resume() }
    func pause() { player?.pause(); recPlayer?.pause(); isPlaying = false; updateRate(0) }
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
        nowId = nil
        isPlaying = false
        continuous = false
        MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
    }

    func setRate(_ r: Double) {
        store?.rate = r
        player?.rate = Float(r)
        if isPlaying { updateRate(Float(r)) }
    }

    // ── 연속 듣기 (이동 중): 작품(또는 전체)의 소리 있는 대사를 차례로, 대사마다 N번씩 ──
    func startContinuous(_ items: [Item], from: Item? = nil) {
        guard let store else { return }
        let playable = items.filter { store.hasLocalAudio($0) }
        guard !playable.isEmpty else { return }
        gen += 1
        stopRec()
        afterOriginal = nil
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
        stopRec()
        afterOriginal = { [weak self] in self?.playRecording(recording, for: item) }
        start(item, repeats: 1)
    }
    func playRecording(_ url: URL, for item: Item?) {
        activateSession()
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

    // ── 끝났을 때: 같은 대사 반복 → 같이 듣기 → (연속이면) 쉬고 다음 대사 ──
    nonisolated func audioPlayerDidFinishPlaying(_ p: AVAudioPlayer, successfully flag: Bool) {
        Task { @MainActor in self.finished(p) }
    }
    private func finished(_ p: AVAudioPlayer) {
        if p === recPlayer { stopRec(); if !continuous { isPlaying = false; nowId = nil }; return }
        guard p === player else { return }
        if let after = afterOriginal { afterOriginal = nil; after(); return }
        if lineRepeatLeft > 1 {
            lineRepeatLeft -= 1
            p.currentTime = 0
            p.play()
            return
        }
        if continuous {
            let g = gen
            let gap = Double(store?.gapMs ?? 400) / 1000
            // 쉼이 끝나면 다음 대사로. (소리가 멈춘 사이라 쉼은 짧게 — 설정에서 0~1초)
            DispatchQueue.main.asyncAfter(deadline: .now() + max(0.05, gap)) { [weak self] in
                guard let self, self.gen == g, self.continuous else { return }
                self.queueIndex += 1
                if self.queueIndex >= self.queue.count {
                    if self.store?.loopAll == true { self.queueIndex = 0 } else { self.stop(); return }
                }
                self.playCurrent()
            }
        } else {
            isPlaying = false
        }
    }

    // ── 잠금 화면 표시 ──
    private func updateNowPlaying(_ item: Item) {
        var info: [String: Any] = [
            MPMediaItemPropertyTitle: item.text.replacingOccurrences(of: "\n", with: " "),
            MPMediaItemPropertyArtist: item.title + (item.episode.isEmpty ? "" : " · " + item.episode),
            MPMediaItemPropertyAlbumTitle: "자막 튜터",
        ]
        if let d = player?.duration { info[MPMediaItemPropertyPlaybackDuration] = d }
        info[MPNowPlayingInfoPropertyPlaybackRate] = store?.rate ?? 1
        MPNowPlayingInfoCenter.default().nowPlayingInfo = info
    }
    private func updateRate(_ r: Float) {
        var info = MPNowPlayingInfoCenter.default().nowPlayingInfo ?? [:]
        info[MPNowPlayingInfoPropertyPlaybackRate] = r
        if let t = player?.currentTime { info[MPNowPlayingInfoPropertyElapsedPlaybackTime] = t }
        MPNowPlayingInfoCenter.default().nowPlayingInfo = info
    }
}

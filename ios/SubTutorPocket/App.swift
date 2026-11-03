// SubTutor Pocket – 자막 튜터 아이폰 앱
// 맥의 SubTutor 확장 프로그램이 Supabase 에 올린 대사·MP3 를 받아, 인터넷 없이도
// 이동하며 듣고(화면 꺼도 이어짐), 대사를 눌러 재생하고, 따라 말한 목소리를 녹음해 비교한다.
import SwiftUI

@main
struct SubTutorPocketApp: App {
    @StateObject private var store: Store
    @StateObject private var player: Player
    @StateObject private var recorder: Recorder
    @Environment(\.scenePhase) private var scenePhase

    init() {
        let s = Store()
        let p = Player()
        p.store = s
        let r = Recorder()
        r.store = s
        _store = StateObject(wrappedValue: s)
        _player = StateObject(wrappedValue: p)
        _recorder = StateObject(wrappedValue: r)
        Store.sharedForSpeak = s                      // 입트기 지연 올리기가 로그인 정보를 읽는다
        try? FileManager.default.createDirectory(at: Store.audioDir, withIntermediateDirectories: true)
        try? FileManager.default.createDirectory(at: Store.recDir, withIntermediateDirectories: true)
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(store)
                .environmentObject(player)
                .environmentObject(recorder)
                .environmentObject(SpeakStore.shared)
                .environmentObject(RecStore.shared)
                .task { await store.autoSyncIfDue() }                 // 켜면 자동 동기화 (10분에 한 번)
                .onChange(of: scenePhase) { ph in                     // 백그라운드에서 돌아와도
                    if ph == .active { Task { await store.autoSyncIfDue() } }
                }
        }
    }
}

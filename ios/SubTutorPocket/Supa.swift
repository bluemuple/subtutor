// SubTutor Pocket – 아주 작은 Supabase 클라이언트 (외부 라이브러리 없이 URLSession 만)
// 이메일·비밀번호 로그인(GoTrue) → items 읽기(PostgREST) → MP3 내려받기(Storage).
// refresh token 만 기기에 남기고, access token 은 메모리에서 쓰다 만료되면 갱신한다.
import Foundation

// 기본 접속 정보: 본인 Supabase 프로젝트(저장소의 supabase/schema.sql)를 만들면 여기에 넣는다.
// 그러면 앱에서는 이메일·비밀번호만 입력하면 된다. anon 키는 공개용 키 — 데이터는 RLS 로 본인 것만 열린다.
enum SupaDefaults {
    static let url = "https://fovhngfqueolqhemymqa.supabase.co"
    static let key = "sb_publishable_vfA8_n_-kbOoBuTSKahwwg_G-0cPMfN"   // publishable 키 (공개용)
}

enum SupaError: LocalizedError {
    // Supabase 의 흔한 영어 오류를 한글로
    static func korean(_ code: Int, _ body: String) -> String {
        var msg = body
        if let d = body.data(using: .utf8), let o = try? JSONSerialization.jsonObject(with: d) as? [String: Any] {
            msg = (o["error_description"] ?? o["msg"] ?? o["message"] ?? o["error"]).map { "\($0)" } ?? body
        }
        let m = msg.lowercased()
        if m.contains("invalid login credentials") { return "이메일 또는 비밀번호가 틀렸습니다" }
        if m.contains("email not confirmed") { return "이메일 확인이 켜진 설정입니다 — Supabase 에서 Confirm email 을 끄세요" }
        if m.contains("refresh token") { return "로그인이 풀렸습니다 — 다시 로그인하세요" }
        if m.contains("rate limit") { return "요청이 너무 잦습니다 — 잠시 뒤에 다시 해 보세요" }
        if m.contains("object not found") || m.contains("not_found") { return "서버에 소리 파일이 없습니다 — 맥 웹에서 \"아이폰으로 올리기 (전체)\"를 누르세요" }
        return "HTTP \(code) \(msg.prefix(140))"
    }
    case badConfig
    case http(Int, String)
    case notSignedIn
    var errorDescription: String? {
        switch self {
        case .badConfig: return "Supabase 주소와 anon 키를 먼저 넣으세요"
        case .notSignedIn: return "로그인이 필요합니다"
        case .http(let code, let body): return SupaError.korean(code, body)
        }
    }
}

final class Supa {
    static let shared = Supa()
    private var accessToken: String?
    private var refreshToken: String? = UserDefaults.standard.string(forKey: "refreshToken")
    private var userId: String? = UserDefaults.standard.string(forKey: "supaUserId")

    static func describe(_ error: Error) -> String {
        if let u = error as? URLError { return u.code == .notConnectedToInternet ? "인터넷에 연결돼 있지 않습니다" : "서버에 닿지 못했습니다 (\(u.code.rawValue))" }
        return (error as? LocalizedError)?.errorDescription ?? String(describing: error)
    }

    private func base(_ url: String) throws -> URL {
        let t = url.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let u = URL(string: t), t.hasPrefix("http") else { throw SupaError.badConfig }
        return u
    }

    private func request(_ url: URL, key: String, method: String = "GET", token: String? = nil, json: [String: Any]? = nil, extra: [String: String] = [:]) async throws -> (Data, HTTPURLResponse) {
        var req = URLRequest(url: url)
        req.httpMethod = method
        req.setValue(key, forHTTPHeaderField: "apikey")
        // 로그인한 뒤에만 사용자 토큰을 보낸다 — 새 publishable 키(sb_publishable_…)는 JWT 가 아니라 Bearer 로 보내면 안 된다
        if let token { req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        for (k, v) in extra { req.setValue(v, forHTTPHeaderField: k) }
        if let json {
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try JSONSerialization.data(withJSONObject: json)
        }
        let (data, resp) = try await URLSession.shared.data(for: req)
        let http = resp as! HTTPURLResponse
        if http.statusCode >= 300 { throw SupaError.http(http.statusCode, String(data: data, encoding: .utf8) ?? "") }
        return (data, http)
    }

    private func storeSession(_ obj: [String: Any]) {
        accessToken = obj["access_token"] as? String
        refreshToken = obj["refresh_token"] as? String
        if let user = obj["user"] as? [String: Any], let id = user["id"] as? String { userId = id }
        UserDefaults.standard.set(refreshToken, forKey: "refreshToken")
        UserDefaults.standard.set(userId, forKey: "supaUserId")
    }

    @discardableResult
    func signIn(url: String, key: String, email: String, password: String) async throws -> String {
        let u = try base(url).appendingPathComponent("auth/v1/token")
        var comp = URLComponents(url: u, resolvingAgainstBaseURL: false)!
        comp.queryItems = [URLQueryItem(name: "grant_type", value: "password")]
        let (data, _) = try await request(comp.url!, key: key, method: "POST", json: ["email": email, "password": password])
        guard let obj = try JSONSerialization.jsonObject(with: data) as? [String: Any], obj["access_token"] != nil else {
            throw SupaError.http(200, "응답에 토큰이 없습니다")
        }
        storeSession(obj)
        return accessToken ?? ""
    }

    private func refresh(url: String, key: String) async throws -> String {
        guard let rt = refreshToken else { throw SupaError.notSignedIn }
        let u = try base(url).appendingPathComponent("auth/v1/token")
        var comp = URLComponents(url: u, resolvingAgainstBaseURL: false)!
        comp.queryItems = [URLQueryItem(name: "grant_type", value: "refresh_token")]
        let (data, _) = try await request(comp.url!, key: key, method: "POST", json: ["refresh_token": rt])
        guard let obj = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw SupaError.notSignedIn }
        storeSession(obj)
        guard let t = accessToken else { throw SupaError.notSignedIn }
        return t
    }

    private func token(url: String, key: String) async throws -> String {
        if let t = accessToken { return t }
        return try await refresh(url: url, key: key)
    }

    // 만료(401)면 한 번 갱신해 다시
    private func authed(_ make: (String) -> URL, url: String, key: String, extra: [String: String] = [:]) async throws -> Data {
        var t = try await token(url: url, key: key)
        do {
            return try await request(make(t), key: key, token: t, extra: extra).0
        } catch SupaError.http(401, _) {
            accessToken = nil
            t = try await refresh(url: url, key: key)
            return try await request(make(t), key: key, token: t, extra: extra).0
        }
    }

    func fetchItems(url: String, key: String) async throws -> [Item] {
        let u = try base(url)
        let data = try await authed({ _ in
            var c = URLComponents(url: u.appendingPathComponent("rest/v1/items"), resolvingAgainstBaseURL: false)!
            c.queryItems = [URLQueryItem(name: "select", value: "*"), URLQueryItem(name: "order", value: "saved_at.desc"), URLQueryItem(name: "limit", value: "5000")]
            return c.url!
        }, url: url, key: key)
        return try JSONDecoder().decode([Item].self, from: data)
    }

    func downloadAudio(url: String, key: String, fileName: String) async throws -> Data {
        guard let uid = userId else { throw SupaError.notSignedIn }
        let u = try base(url)
        return try await authed({ _ in
            u.appendingPathComponent("storage/v1/object/audio/\(uid)/\(fileName)")
        }, url: url, key: key)
    }

    // 폰에서 바꾼 태그·알아요(box)를 서버에 쓴다. updated_at 을 지금으로 찍어 두면 웹이 다음 동기화 때 바뀐 것으로 알고 받아 간다
    func patchItem(url: String, key: String, id: String, fields: [String: Any]) async throws {
        let u = try base(url)
        var c = URLComponents(url: u.appendingPathComponent("rest/v1/items"), resolvingAgainstBaseURL: false)!
        c.queryItems = [URLQueryItem(name: "id", value: "eq.\(id)")]
        let iso = ISO8601DateFormatter()
        iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        var body = fields
        body["updated_at"] = iso.string(from: Date())
        var t = try await token(url: url, key: key)
        do {
            _ = try await request(c.url!, key: key, method: "PATCH", token: t, json: body, extra: ["Prefer": "return=minimal"])
        } catch SupaError.http(401, _) {
            accessToken = nil
            t = try await refresh(url: url, key: key)
            _ = try await request(c.url!, key: key, method: "PATCH", token: t, json: body, extra: ["Prefer": "return=minimal"])
        }
    }

    func signOut() {
        accessToken = nil
        refreshToken = nil
        userId = nil
        UserDefaults.standard.removeObject(forKey: "refreshToken")
        UserDefaults.standard.removeObject(forKey: "supaUserId")
    }
}

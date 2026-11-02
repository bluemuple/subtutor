-- SubTutor 아이폰 동기화용 Supabase 스키마
-- 쓰는 법: supabase.com 에서 새 프로젝트를 만들고 → SQL Editor 에 이 파일 전체를 붙여 넣어 실행 → Authentication › Providers › Email 에서
-- "Confirm email" 을 끈다(또는 Authentication › Users 에서 사용자를 직접 추가). 그 뒤 프로젝트 URL(https://xxxx.supabase.co)과
-- anon public 키를 코드 기본값(웹 docs/app.js 의 SUPA_DEFAULT_URL/KEY, 앱 ios/SubTutorPocket/Supa.swift 의 SupaDefaults)에
-- 넣으면 웹·앱 모두 이메일·비밀번호만 입력하면 된다 (안 넣으면 각 설정 화면에 URL·키 입력칸이 보인다).
-- 혼자 쓸 거라면 본인 계정을 만든 뒤 Authentication › Sign In / Up 의 "Allow new users to sign up" 을 꺼 두면,
-- 공개 저장소에 anon 키가 있어도 남이 이 프로젝트에 가입해 쓸 수 없다 (어차피 남의 데이터는 RLS 로 못 본다).
-- 데이터는 모두 RLS 로 본인(auth.uid()) 것만 읽고 쓸 수 있다. anon 키는 공개용 키라 저장소에 있어도 된다.

-- 저장한 자막 (확장 프로그램의 items 를 그대로 올린다)
create table if not exists public.items (
  user_id uuid not null default auth.uid(),
  id text not null,                       -- 확장 프로그램의 항목 id: <platform>:<videoId>:<자막 시작 ms>
  title text not null default '',
  episode text not null default '',
  platform text not null default '',
  text text not null,
  translation text not null default '',
  start_ms bigint not null default 0,     -- 영상 시간 (재생 구간)
  end_ms bigint not null default 0,
  saved_at bigint not null default 0,     -- 저장한 때 (ms)
  box text not null default 'learning',   -- learning | known
  comment text not null default '',
  tags jsonb not null default '[]',
  missed boolean not null default false,  -- Q 못 알아들음
  miss_reason text not null default '',
  has_audio boolean not null default false, -- storage 의 audio/<user_id>/<id 안전화>.mp3 존재 여부
  audio_ms bigint not null default 0,
  updated_at timestamptz not null default now(),
  primary key (user_id, id)
);
alter table public.items enable row level security;
drop policy if exists "own items" on public.items;
create policy "own items" on public.items
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- 단어장 (플레이어 단어 목록에서 ☆ 로 저장한 단어)
create table if not exists public.words (
  user_id uuid not null default auth.uid(),
  word text not null,
  meaning text not null default '',
  sentence text not null default '',
  sentence_ko text not null default '',
  review jsonb not null default '{}',
  saved_at bigint not null default 0,
  updated_at timestamptz not null default now(),
  primary key (user_id, word)
);
alter table public.words enable row level security;
drop policy if exists "own words" on public.words;
create policy "own words" on public.words
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- 대사 오디오(MP3) 보관함: audio/<user_id>/<파일 이름>.mp3
insert into storage.buckets (id, name, public)
  values ('audio', 'audio', false)
  on conflict (id) do nothing;
drop policy if exists "own audio select" on storage.objects;
create policy "own audio select" on storage.objects
  for select using (bucket_id = 'audio' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists "own audio insert" on storage.objects;
create policy "own audio insert" on storage.objects
  for insert with check (bucket_id = 'audio' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists "own audio update" on storage.objects;
create policy "own audio update" on storage.objects
  for update using (bucket_id = 'audio' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'audio' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists "own audio delete" on storage.objects;
create policy "own audio delete" on storage.objects
  for delete using (bucket_id = 'audio' and (storage.foldername(name))[1] = auth.uid()::text);

-- ── 입트기(말하기 유창성 연습) ──────────────────────────────────────────────
-- 이미 프로젝트를 만든 뒤라면 이 아래 블록만 SQL Editor 에 붙여 넣어 실행하면 된다.
-- 녹음 오디오는 올리지 않는다(용량) — 프롬프트와 녹음 기록(길이·날짜·별점·메모·받아 적기)만 동기화한다.

-- 말하기 프롬프트 (기본 48개는 앱·웹에 내장 — 서버에는 고치거나 지우거나 새로 만든 것만 올라온다)
create table if not exists public.speak_prompts (
  user_id uuid not null default auth.uid(),
  id text not null,                        -- 내장 b01…b48, 직접 만든 것은 u<시각><난수>
  text text not null default '',
  kind text not null default 'short',      -- short(짧게 답하기) | long(길게 말하기)
  cat text not null default 'mine',        -- boss·student·parent·daily·opinion·class·meeting·etc·mine
  hint text not null default '',           -- 힌트(쓰면 좋은 표현)
  deleted boolean not null default false,  -- 지움 표식 (기기끼리 지움도 퍼지게)
  updated_at timestamptz not null default now(),
  primary key (user_id, id)
);
alter table public.speak_prompts enable row level security;
drop policy if exists "own speak_prompts" on public.speak_prompts;
create policy "own speak_prompts" on public.speak_prompts
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- 말하기 녹음 기록 (소리 파일 없이 정보만)
create table if not exists public.speak_takes (
  user_id uuid not null default auth.uid(),
  id text not null,                        -- t<시각><난수>
  prompt_id text not null default '',
  at bigint not null default 0,            -- 녹음한 때 (ms)
  dur_ms bigint not null default 0,        -- 말한 길이 (멈춘 시간 제외)
  mode text not null default 'free',       -- free(자유 말하기) | step(줄여 말하기)
  target_s bigint not null default 0,      -- 줄여 말하기 목표 초 (자유는 0)
  rating bigint not null default 0,        -- 별점 0~5
  memo text not null default '',
  heard text not null default '',          -- 음성 인식으로 받아 적은 문장 (그 기기에서 인식됐을 때만)
  deleted boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (user_id, id)
);
alter table public.speak_takes enable row level security;
drop policy if exists "own speak_takes" on public.speak_takes;
create policy "own speak_takes" on public.speak_takes
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

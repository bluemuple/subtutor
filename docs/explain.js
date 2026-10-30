/*
 * SubTutor – 기능별 설명과 학문적 근거 (확장 프로그램 · 웹사이트 공용)
 * 화면에는 설명을 늘어놓지 않고, 제목 옆 ⓘ 를 누르면 이 내용을 보여 준다.
 * 각 항목: { title, what(한 줄), why(근거), refs[] }
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.SubTutorExplain = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const E = {
    koMode: {
      title: '한국어 표시 방식',
      what: '영상 위 한국어 번역을 항상 보일지, T 키를 누르는 동안만 보일지, 같은 줄을 3번 반복한 뒤에 보일지 정합니다. 패널의 한국어는 흐리게 두고 마우스를 올리면 보입니다.',
      why: '같은 언어(영어) 자막은 낯선 억양의 소리와 단어를 잇는 데 도움이 되지만, 모국어 자막은 소리를 듣는 대신 뜻을 읽게 만들어 억양 적응을 방해합니다. 네덜란드인에게 호주 영어 드라마를 보여 준 실험에서 영어 자막 집단은 그 억양 화자의 새 문장을 더 잘 받아 적었고, 네덜란드어 자막 집단은 오히려 못 받아 적었습니다. 뜻은 소리를 먼저 해독한 뒤 확인용으로만 보는 것이 좋습니다.',
      refs: ['Mitterer, H., & McQueen, J. M. (2009). Foreign subtitles help but native-language subtitles harm foreign speech perception. PLoS ONE, 4(11), e7785.', 'Birulés-Muntané, J., & Soto-Faraco, S. (2016). Watching subtitled films can help learning foreign languages. PLoS ONE, 11(6), e0158409.', 'Jensen, E. D., & Vinther, T. (2003). Exact repetition as input enhancement in second language acquisition. Language Learning, 53(3), 373–428.'],
    },
    secondPass: {
      title: '2회차 모드',
      what: '같은 에피소드를 두 번째 볼 때 켭니다. 1회차에 Q 로 표시한 "못 알아들은 줄"만 한국어를 바로 보여 주고 패널에서 강조합니다.',
      why: '자막 영상의 학습 효과는 두 번째 시청에서 커집니다. 첫 시청은 소리에 집중하고, 두 번째는 못 알아들은 부분만 자막으로 확인하는 순서가 이해와 어휘 기억 모두에 유리합니다.',
      refs: ['Vanderplank, R. (2016). Captioned Media in Foreign Language Learning and Teaching. Palgrave Macmillan.', 'Winke, P., Gass, S., & Sydorenko, T. (2010). The effects of captioning videos used for foreign language listening activities. Language Learning & Technology, 14(1), 65–86.'],
    },
    missed: {
      title: '못 알아들음 표시 (Q)',
      what: '지금 보이는 자막을 Q 로 "못 알아들음"으로 표시합니다. 자동으로 별표 저장되고 "못 알아들음" 태그가 붙어, 웹에서 그 줄만 모아 복습하고 2회차 모드에서 강조됩니다. 이 표시 수와 본 줄 수로 에피소드별 이해율을 계산합니다.',
      why: '자기 이해도를 스스로 점검하고 어려웠던 부분을 골라 다시 듣는 메타인지 전략은 듣기 발달의 핵심 요소이며, 어휘 크기와 함께 L2 듣기 이해를 가장 잘 설명하는 변수입니다.',
      refs: ['Vandergrift, L., & Goh, C. C. M. (2012). Teaching and Learning Second Language Listening: Metacognition in Action. Routledge.', 'Wang, Y., & Treffers-Daller, J. (2017). Explaining listening comprehension among L2 learners of English: The contribution of general language proficiency, vocabulary knowledge and metacognitive awareness. System, 65, 139–150.'],
    },
    cloze: {
      title: '빈칸 자막',
      what: '영상 위 자막에서 단어 한두 개를 ____ 로 가립니다. "기능어"는 to, of, them, have 같은 약하게 발음되는 단어를 우선 가리고, "무작위"는 아무 단어나 가립니다. V 키로 그 줄을 공개합니다.',
      why: '핵심어만 보여 주는 자막도 전체 자막만큼 이해를 돕고 소리에 더 집중하게 합니다. 중급 학습자의 듣기 실패는 대부분 약형·연음·탈락 때문에 단어 경계를 못 찾는 데서 오므로, 짧은 받아쓰기와 빈칸 채우기 같은 상향식 활동이 효과적입니다.',
      refs: ['Montero Perez, M., Peters, E., Clarebout, G., & Desmet, P. (2014). Effects of captioning on video comprehension and incidental vocabulary learning. Language Learning & Technology, 18(1), 118–141.', 'Field, J. (2003). Promoting perception: Lexical segmentation in L2 listening. ELT Journal, 57(4), 325–334.', 'Siegel, J., & Siegel, A. (2015). Getting to the bottom of L2 listening instruction: Making a case for bottom-up activities. Studies in Second Language Learning and Teaching, 5(4), 637–662.'],
    },
    soundsLike: {
      title: '소리 나는 대로',
      what: '자막 아래에 실제 빠른 말에서 들리는 모양을 작게 보여 줍니다: going to→gonna, did you→didja, them→\'em, water→wadder, an‿apple(연음).',
      why: '자연스러운 말은 사전의 발음이 아니라 압축되고 이어진 소리로 들립니다. 이 변형 규칙을 눈으로 확인하면서 들으면 소리와 단어를 잇는 해독이 빨라집니다. 뉴질랜드·호주 영어도 모음 사이 t 가 약해지는 등 같은 현상이 있습니다.',
      refs: ['Cauldwell, R. (2013). Phonology for Listening: Teaching the Stream of Speech. Speech in Action.', 'Field, J. (2008). Listening in the Language Classroom. Cambridge University Press.', 'Hay, J., Maclagan, M., & Gordon, E. (2008). New Zealand English. Edinburgh University Press.'],
    },
    kiwiNotes: {
      title: '키위·마오리·학교 용어 주석',
      what: '뉴질랜드 구어(sweet as, yeah nah, eh), 학교에서 매일 쓰는 마오리어(kia ora, whānau, tamariki, kaiako), 학교 용어(roll, duty, mat time, PB4L, WALT)가 자막에 나오면 밑줄을 긋고 뜻을 보여 줍니다.',
      why: '뉴질랜드 영어는 모음 체계가 다르고(fish→"fush"), 문장 끝 "eh"와 마오리어 차용이 많아 일반 영어 교재로는 익히기 어렵습니다. 교실 담화는 정해진 표현이 반복되므로, 이 표현들을 미리 알면 알아듣는 비율이 빠르게 오릅니다.',
      refs: ['Hay, J., Maclagan, M., & Gordon, E. (2008). New Zealand English. Edinburgh University Press.', 'Macalister, J. (2006). The Maori presence in the New Zealand English lexicon, 1850–2000. English World-Wide, 27(1), 1–24.', 'Walsh, S. (2006). Investigating Classroom Discourse. Routledge.'],
    },
    vocabProfile: {
      title: '어휘 프로파일 · 말 속도',
      what: '자막을 불러오면 이 에피소드의 말 속도(분당 단어 수), 자주 쓰는 3천 단어 밖 비율, 95%를 알아듣는 데 필요한 단어 수를 상태줄에 보여 줍니다. 패널 ⚙ 의 "어휘" 에서 3천 밖 단어 목록을 보고 복사해 미리 익힐 수 있고, 같은 작품을 이어 보면 "이전 N편에서도 나옴"이 표시됩니다.',
      why: 'TV 를 95% 알아들으려면 약 3천 단어족이 필요하고, 듣기는 읽기보다 낮은 95% 커버리지로도 이해가 됩니다. 어휘 크기는 듣기 이해의 가장 큰 예측 변수이며, 같은 시리즈를 이어 보면 어휘가 반복되어 부담이 크게 줄어듭니다.',
      refs: ['Webb, S., & Rodgers, M. P. H. (2009). Vocabulary demands of television programs. Language Learning, 59(2), 335–366.', 'van Zeeland, H., & Schmitt, N. (2013). Lexical coverage in L1 and L2 listening comprehension. Applied Linguistics, 34(4), 457–479.', 'Nation, I. S. P. (2006). How large a vocabulary is needed for reading and listening? Canadian Modern Language Review, 63(1), 59–82.', 'Rodgers, M. P. H., & Webb, S. (2011). Narrow viewing: The vocabulary in related television programs. TESOL Quarterly, 45(4), 689–717.'],
    },
    loopLadder: {
      title: '반복 속도 사다리',
      what: 'S 로 한 줄을 반복할 때 0.8 → 0.9 → 1.0 → 1.15배로 자동으로 올립니다. 반복을 끄면 원래 속도로 돌아옵니다. 웹의 "사다리" 버튼도 같은 순서로 네 번 들려줍니다.',
      why: '낯선 억양은 약간 느린 속도에서 이해가 올라가고, 사람은 빨라진 말에 몇 문장 만에 적응합니다. 같은 구간을 정확히 반복하되 속도를 올려 가면, 실제 아이들의 속도가 상대적으로 느리게 들립니다.',
      refs: ['Griffiths, R. (1992). Speech rate and listening comprehension: Further evidence of the relationship. TESOL Quarterly, 26(2), 385–390.', 'Matsuura, H., Chiba, R., Mahoney, S., & Rilling, S. (2014). Accent and speech rate effects in English as a lingua franca. System, 46, 143–150.', 'Dupoux, E., & Green, K. (1997). Perceptual adjustment to highly compressed speech. Journal of Experimental Psychology: Human Perception and Performance, 23(3), 914–927.', 'Jensen, E. D., & Vinther, T. (2003). Exact repetition as input enhancement in second language acquisition. Language Learning, 53(3), 373–428.'],
    },
    rateKeys: { title: '재생 속도 키', what: '[ 느리게, ] 빠르게(0.1씩, 0.5~2배), \\ 1배. 반복·이동 뒤에도 속도가 유지됩니다.', why: '위 "반복 속도 사다리"와 같은 근거입니다. 처음에는 0.8~0.9배로 소리를 분해해 듣고, 익숙해지면 1배 이상으로 올립니다.', refs: ['Griffiths, R. (1992). Speech rate and listening comprehension. TESOL Quarterly, 26(2), 385–390.'] },
    loop: { title: '현재 자막 무한 반복 (S)', what: '지금 자막 구간을 계속 반복합니다. A/D 로 다른 줄로 옮기면 그 줄을 반복합니다.', why: '같은 영상 구간을 정확히 반복하는 것만으로 이해와 음운 해독이 좋아집니다.', refs: ['Jensen, E. D., & Vinther, T. (2003). Exact repetition as input enhancement in second language acquisition. Language Learning, 53(3), 373–428.'] },
    autoPause: { title: '자동 일시정지 (AP, P)', what: '자막이 끝날 때마다 멈춥니다. F 로 다시 듣고, 재생을 누르면 이어집니다.', why: '문장 단위로 멈춰 들은 것을 되짚는 것은 듣기 지도에서 권장하는 "의도적 듣기" 방식입니다.', refs: ['Field, J. (2008). Listening in the Language Classroom. Cambridge University Press.'] },
    shadowing: { title: '쉐도잉 (W)', what: '자막이 끝나면 설정한 시간(1~7초)만큼 멈춰 따라 말할 틈을 주고 자동으로 이어 갑니다.', why: '들은 직후 바로 따라 말하는 쉐도잉은 특히 중·하위 학습자의 소리 해독(상향식 듣기)을 개선합니다.', refs: ['Hamada, Y. (2016). Shadowing: Who benefits and how? Language Teaching Research, 20(1), 35–52.', 'Kadota, S. (2019). Shadowing as a Practice in Second Language Acquisition. Routledge.'] },
    save: { title: '별표 저장 (E · Enter · Alt+E)', what: '지금 화면에 보이는 자막을 저장합니다. 웹의 목록·퀴즈·쉐도잉에 쓰입니다. "별표 저장 시 오디오"를 켜 두면 대사 소리도 함께 보관합니다. Alt+E(크롬 명령, chrome://extensions/shortcuts 에서 변경)나 영상 우클릭 → "SubTutor: 지금 자막 저장"으로 저장하면 넷플릭스·프라임·디즈니+의 오디오 녹음 허용도 함께 됩니다(탭마다 한 번). 저장·녹음 알림은 영상 오른쪽 위 작은 아이콘으로만 표시됩니다.', why: '못 알아들은 문장을 모아 나중에 인출(떠올리기) 연습을 하는 것이 단순 반복 시청보다 기억에 남습니다.', refs: ['Karpicke, J. D., & Roediger, H. L. (2008). The critical importance of retrieval for learning. Science, 319(5865), 966–968.'] },
    translation: { title: '한국어 번역 출처', what: '플랫폼의 한국어 자막을 영어 줄에 맞춰 붙이고, 없으면 기계 번역으로 채웁니다.', why: '뜻은 소리 해독 뒤 확인용으로만 보는 것이 좋습니다("한국어 표시 방식" 참고).', refs: ['Mitterer, H., & McQueen, J. M. (2009). PLoS ONE, 4(11), e7785.'] },
    hideNative: { title: '플랫폼 기본 자막 숨기기', what: '플랫폼이 그리는 자막을 숨기고 SubTutor 자막만 보입니다. 끄면 겹쳐 보입니다.', why: '', refs: [] },
    overlay: { title: '영상 위 자막 표시', what: '영어 줄과 한국어 줄을 영상 아래쪽에 겹쳐 보여 줍니다.', why: '', refs: [] },
    fontScale: { title: '자막 크기', what: '영상 위 자막의 글자 크기입니다. 영상 너비에 비례합니다.', why: '', refs: [] },
    leadTail: { title: '재생 시작·끝 여유', what: '대사를 재생할 때 자막 시작보다 조금 앞에서 시작하고 끝보다 조금 뒤에서 멈춥니다. 잘리면 늘리세요.', why: '', refs: [] },
    offset: { title: '자막 시간 보정', what: '플랫폼 자막과 대조해 자막이 소리보다 빠르거나 늦는 만큼을 자동으로 찾습니다(프라임은 보통 −6초 근처). 직접 바꿀 수도 있습니다.', why: '', refs: [] },
    audioStore: { title: '별표 저장 시 오디오', what: '저장할 때 대사를 한 번 다시 재생하며 소리를 녹음합니다. "웹 재생용으로 보관"은 확장 프로그램 안에 작은 MP3 를 두고, "PC 에 MP3 파일로 저장"은 지정 폴더(기본 다운로드/SubTutor)에 파일을 쓰면서 같은 MP3 를 웹 재생용으로도 보관합니다. 어느 쪽이든 웹에서 ▶ 를 누르면 플레이어 탭 없이 바로 재생됩니다. 넷플릭스·프라임·디즈니+의 탭 오디오 녹음은 크롬 규칙상 그 탭에서 확장 프로그램을 한 번 호출해야 허용됩니다: Alt+E 단축키, 영상 우클릭 → "SubTutor: 지금 자막 저장", 또는 툴바 아이콘 중 하나(탭마다 한 번). 허용되면 기다리던 녹음이 바로 시작됩니다.', why: '소리만 듣고 받아쓰기·쉐도잉을 하려면 대사 소리가 플레이어 없이도 있어야 합니다.', refs: ['Nation, I. S. P., & Newton, J. (2009). Teaching ESL/EFL Listening and Speaking. Routledge.'] },
    folder: { title: '저장 폴더', what: 'MP3 를 어느 폴더에 둘지 고릅니다(기본: 다운로드/SubTutor). 크롬은 브라우저를 다시 시작하면 폴더 권한을 다시 묻는데, "다시 묻지 않게 고정" 뒤 크롬 창에서 "매번 허용"을 고르면 그 뒤로는 묻지 않습니다.', why: '', refs: [] },
    enabled: { title: 'ST 켜기/끄기', what: '컨트롤 바의 ST 버튼(또는 팝업)으로 이 사이트에서 SubTutor 를 켜고 끕니다.', why: '', refs: [] },
    panel: { title: '자막 패널 (`)', what: '오른쪽 자막 목록을 열고 닫습니다. 줄을 누르면 그 위치로 이동하고, ☆ 로 저장합니다.', why: '', refs: [] },
    // ── 웹
    srs: { title: '간격 반복 복습', what: '퀴즈에서 "알고 있어"를 고르면 다음 복습이 1일 → 3일 → 7일 → 14일 → 30일 뒤로 늘어나고, "잊어버렸어"는 다음 날 다시 나옵니다. 30일 간격까지 통과한 카드는 "알고 있는 표현"으로 옮겨집니다. 끄면 예전처럼 "알고 있어"가 바로 옮깁니다.', why: '복습을 몰아서 하는 것보다 간격을 두고 나누는 편이 장기 기억에 훨씬 유리하고, 간격을 점점 늘리는 방식이 어휘 학습에서 효과적입니다. 또한 다시 보는 것보다 떠올리는 것(인출)이 기억을 만듭니다.', refs: ['Cepeda, N. J., Pashler, H., Vul, E., Wixted, J. T., & Rohrer, D. (2006). Distributed practice in verbal recall tasks: A review and quantitative synthesis. Psychological Bulletin, 132(3), 354–380.', 'Nakata, T. (2015). Effects of expanding and equal spacing on second language vocabulary learning. Studies in Second Language Acquisition, 37(4), 677–711.', 'Karpicke, J. D., & Roediger, H. L. (2008). The critical importance of retrieval for learning. Science, 319(5865), 966–968.'] },
    dictation: { title: '받아쓰기 퀴즈', what: '소리만 듣고 영어로 받아쓴 뒤 단어 단위로 맞춤·놓침을 확인합니다. 뜻은 정답 확인 뒤에 보입니다.', why: '받아쓰기는 약형·연음 때문에 놓치는 단어를 드러내는 대표적인 상향식 듣기 활동입니다. 새 단어를 익힐 때 소리(형태)에 먼저 집중하고 뜻은 나중에 붙이는 순서가 형태 기억에 유리합니다.', refs: ['Siegel, J., & Siegel, A. (2015). Getting to the bottom of L2 listening instruction. Studies in Second Language Learning and Teaching, 5(4), 637–662.', 'Nation, I. S. P., & Newton, J. (2009). Teaching ESL/EFL Listening and Speaking. Routledge.', 'Barcroft, J. (2015). Lexical Input Processing and Vocabulary Learning. John Benjamins.'] },
    weakWords: { title: '약점 단어', what: '받아쓰기에서 놓친 단어를 누적해 자주 놓치는 순서로 보여 줍니다. 기능어(of, them, have…)가 많다면 약형·연음 듣기가 과제입니다.', why: '어떤 단어를 체계적으로 놓치는지 아는 것이 듣기 훈련의 출발점입니다.', refs: ['Field, J. (2008). Listening in the Language Classroom. Cambridge University Press.'] },
    dashboard: { title: '진행 상황', what: '근무 시작일까지 남은 날, 에피소드별 1회차 이해율(못 알아들음 표시 ÷ 본 줄 수)·말 속도·어휘 난도, 주별 저장·복습 수를 보여 줍니다.', why: '체감("5%만 들린다")을 숫자로 바꿔야 공부 방향을 조정할 수 있습니다. 자기 점검은 메타인지 듣기 지도의 핵심입니다.', refs: ['Vandergrift, L., & Goh, C. C. M. (2012). Teaching and Learning Second Language Listening. Routledge.'] },
    recommend: { title: '추천 콘텐츠', what: '뉴질랜드·호주 억양과 학교 말이 많은 프로그램·채널 목록입니다. 같은 시리즈를 이어 보고, 화자를 여러 명으로 바꿔 가며 듣는 순서를 권합니다.', why: '같은 화자·주제를 몰아 듣는 "좁은 듣기"는 어휘가 반복돼 이해가 빨리 오르고, 억양 적응은 몇 분 노출로도 시작되지만 화자가 다양해야 새로운 사람에게도 통합니다.', refs: ['Krashen, S. (1996). The case for narrow listening. System, 24(1), 97–100.', 'Rodgers, M. P. H., & Webb, S. (2011). Narrow viewing. TESOL Quarterly, 45(4), 689–717.', 'Bradlow, A. R., & Bent, T. (2008). Perceptual adaptation to non-native speech. Cognition, 106(2), 707–729.', 'Thomson, R. I. (2018). High variability [pronunciation] training (HVPT). Journal of Second Language Pronunciation, 4(2), 208–231.'] },
    shadowSession: { title: '쉐도잉 세션', what: '저장한 대사를 한 줄씩 ① 듣기 → ② 속으로 따라 하기 → ③ 글 보며 따라 하기 → ④ 억양 따라 하며 녹음 → 원음과 내 녹음 비교 순서로 진행합니다.', why: '쉐도잉은 이 단계 순서(듣기→머블링→텍스트 동반→프로소디→내용)로 할 때 효과가 크고, 특히 소리 해독이 약한 학습자에게 유리합니다. 녹음을 원음과 비교하면 자기 발화의 차이를 알아차리게 됩니다.', refs: ['Hamada, Y. (2016). Shadowing: Who benefits and how? Language Teaching Research, 20(1), 35–52.', 'Kadota, S. (2019). Shadowing as a Practice in Second Language Acquisition. Routledge.'] },
    ladder: { title: '속도 사다리 재생', what: '이 대사를 0.8 → 0.9 → 1.0 → 1.15배로 이어서 네 번 들려줍니다.', why: '"반복 속도 사다리"와 같은 근거입니다.', refs: ['Dupoux, E., & Green, K. (1997). Perceptual adjustment to highly compressed speech. JEP: HPP, 23(3), 914–927.', 'Matsuura, H., et al. (2014). Accent and speech rate effects in English as a lingua franca. System, 46, 143–150.'] },
    trim: { title: '오디오 구간 조정', what: '손잡이·←→(10ms)·±ms 버튼으로 재생 구간을 ms 단위로 맞춥니다. 보관 오디오가 있으면 파형이 보이고 그 안에서 자릅니다.', why: '', refs: [] },
    repeat: { title: '반복 재생', what: '켜 두면 ▶ 로 재생한 대사를 계속 반복합니다. 다른 대사를 누르면 그 대사로 바뀌고 ◼ 로 멈춥니다.', why: '같은 구간의 정확한 반복은 음운 해독을 돕습니다.', refs: ['Jensen, E. D., & Vinther, T. (2003). Language Learning, 53(3), 373–428.'] },
    veil: { title: '자막·뜻 감추기', what: '목록은 기본으로 자막과 뜻을 감춥니다. 소리를 먼저 듣고 눌러서 확인하세요. 항목별로도 열 수 있습니다.', why: '보기 전에 떠올리는 인출 연습이 기억을 만들고, 뜻보다 소리에 먼저 집중하는 것이 형태 기억에 유리합니다.', refs: ['Karpicke, J. D., & Roediger, H. L. (2008). Science, 319(5865), 966–968.', 'Barcroft, J. (2015). Lexical Input Processing and Vocabulary Learning. John Benjamins.'] },
    tags: { title: '태그', what: '대사에 태그를 붙여 모아 봅니다. 한 번 만든 이름은 저장되어 다른 대사에서 고를 수 있고, 맨 위 태그를 누르면 그 대사만 보입니다. Q 로 표시한 줄에는 "못 알아들음" 태그가 자동으로 붙습니다.', why: '', refs: [] },
    sort: { title: '정렬', what: '작품별/전체 × 최신 위/아래, 영상 시간순, 작품 이름순 중 고릅니다.', why: '', refs: [] },
    recording: { title: '녹음 · 같이 듣기', what: '🎙 로 내 목소리를 녹음합니다(대사당 3개, 4번째는 가장 오래된 것 삭제). 번호를 누르면 재생, "같이 듣기"는 원음 뒤에 최근 녹음을 이어 들려줍니다.', why: '자기 발화를 원음과 비교하는 것은 쉐도잉의 마지막 단계로, 억양·리듬 차이를 알아차리게 합니다.', refs: ['Kadota, S. (2019). Shadowing as a Practice in Second Language Acquisition. Routledge.'] },
    comment: { title: '코멘트', what: '뜻, 메모, 예문을 적습니다. 자동 저장됩니다.', why: '', refs: [] },
    audioBadge: { title: '오디오 형식 배지', what: '♪ MP3 는 확장 프로그램에 보관된 오디오, ⬇ MP3 는 PC 에 저장된 파일(웹 재생용 복사본도 함께)입니다. 복사본이 없는 예전 파일 항목(주황 배지)은 ▶ 를 누르면 지정 폴더에서 읽어 오고, 다운로드 폴더처럼 확장 프로그램이 읽을 수 없는 곳이면 배지를 누르거나 설정의 "MP3 폴더에서 불러오기"로 한 번 가져옵니다.', why: '', refs: [] },
    mp3Import: { title: 'MP3 폴더에서 불러오기', what: 'PC 파일(⬇ MP3)만 있고 웹 재생용 복사본이 없는 예전 대사를 위한 기능입니다. MP3 가 들어 있는 폴더(다운로드 폴더 안의 SubTutor 폴더나 지정 폴더 — 크롬은 다운로드 폴더 자체는 고를 수 없습니다)를 한 번 고르면 파일 이름이 같은 대사에 복사본을 넣고, 그 뒤로는 플레이어 탭 없이 바로 재생됩니다. 새로 저장하는 대사는 자동으로 복사본이 생기므로 보통 한 번만 쓰면 됩니다.', why: '', refs: [] },
    edit: { title: '편집 모드', what: '"편집"을 누르면 대사마다 선택 상자가 생깁니다(카드를 눌러도 선택). 고른 대사를 "선택 삭제"로 한꺼번에 지우거나, 드롭다운에서 작품·에피소드 전체를 지울 수 있습니다. 삭제하면 보관 오디오, PC 에 저장한 MP3 파일, 내 녹음도 함께 지워지고 되돌릴 수 없습니다. "완료"(또는 Esc)로 나옵니다.', why: '', refs: [] },
    storedAudio: { title: '보관 오디오로 바로 재생', what: '보관된 오디오(또는 PC 파일의 복사본)가 있으면 웹에서 바로 재생하고, 없으면 플레이어 탭을 원격으로 재생합니다. 삭제하면 보관 오디오와 PC 의 MP3 파일도 함께 지워집니다.', why: '', refs: [] },
    twoPass: { title: '두 번 보기', what: '1회차: 한국어 숨김(T 로만 잠깐) 상태로 보며 못 알아들은 줄을 Q 로 표시 → 2회차: "2회차 모드"를 켜고 표시한 줄만 한국어로 확인 → 웹에서 그 줄들로 받아쓰기·쉐도잉.', why: '자막 효과는 2회차에 커지고, 첫 시청을 소리에 집중하면 억양 적응이 빨라집니다.', refs: ['Winke, P., Gass, S., & Sydorenko, T. (2010). Language Learning & Technology, 14(1), 65–86.', 'Mitterer, H., & McQueen, J. M. (2009). PLoS ONE, 4(11), e7785.'] },
    keys: { title: '단축키', what: 'A 이전 · S 반복 · D 다음 · F 다시 듣기 · E/Enter 별표 저장 · Alt+E 저장+녹음 허용(크롬 명령, 변경 가능) · Q 못 알아들음 · T 한국어 잠깐 보기 · V 빈칸 공개 · P 자동 일시정지 · W 쉐도잉 · [ ] \\ 속도 · ` 패널. 퀴즈: Space 듣기 · Enter 확인 · Z 잊어버렸어 · C 알고 있어 · R 녹음.', why: '', refs: [] },
  };
  function get(key) { return E[key] || null; }
  function keys() { return Object.keys(E); }
  return { get, keys, all: E };
});

# vrm-avatar-activity

디스코드 채널에서 동작하는 **AI 아바타 프레임워크**.
Activity(iframe) 안에서 VRM 아바타와 페르소나가 부여된 LLM이 함께 돈다.

## 특징

- **VRM 아바타** — three.js + @pixiv/three-vrm 렌더.
  표정(감정 블렌드)·포즈·립싱크(음량 기반 비셈) 3채널, Mixamo 모션 리타게팅
- **감정 레이어** — LLM이 문장 앞에 `[happy:0.7 relaxed:0.3]` 블렌드 마커를 붙이면
  2축 무드(valence/arousal)에 EMA 누적. 표정은 인접 앵커 보간, 운율(속도)에도 반영.
  감쇠는 사분면별(슬픔은 오래, 이완은 금방), 방치하면 Big Five 기질점으로 회귀
- **장기기억** — 스코프(DM/서버 공개/비공개) 단위 마크다운 기억 + 롤링 요약 + 망각 곡선.
  유저별 프로필·호감도, `/forget` 삭제. 저장 전 4겹 방어(민감정보·저장형 인젝션)와
  보존기간 자동 파기(로그 일 단위·프로필 월 단위) 내장
- **감정 TTS** — AivisSpeech(Style-Bert-VITS2)의 감정 스타일 음성.
  단, 엔진이 **일본어 전용**이라 이중 언어로 푼다: 응답은 한국어 자막, 음성은 문장별
  일본어 번역. 문장 단위 스트리밍으로 첫 소리 지연 최소화. GPU 불필요(CPU)

## 구조

```
Discord 클라이언트
  └─ Activity iframe (activity/ — Vite + three.js + VRM)
       ├─ /ws  ─→ bot:8080  WebSocket 허브 (자막·표정·오디오·스냅샷)
       └─ /api ─→ bot:8081  OAuth 토큰 교환 · Discord 웹훅 이벤트
bot/ (discord.js)
  ├─ LLM: Workers AI 또는 외부 OpenAI 호환 API (스트리밍)
  ├─ TTS: aivis 서비스 (AivisSpeech Engine, 컨테이너)
  └─ 기억: data/memory/<scope>/ 마크다운 + 세션 JSON
```

이렇게 생긴 이유 몇 가지:
- Activity 프록시는 매핑 안 된 도메인을 막는다 → `/ws`·`/api`를 같은 오리진으로
  프록시해 출입구를 하나로 유지한다
- Discord 내장 TTS·음성 수신은 사용 불가(합성이 수신자 클라이언트에서 일어나
  오디오·타이밍을 못 얻는다) → TTS를 직접 돌리고 오디오를 iframe에 보내 로컬 재생한다
- 기억의 원칙은 스코프 격리 — 정보는 공개→비공개 **단방향**으로만 흐르고,
  압축·프로필 추출은 응답 경로 밖에서 돈다

## 실행

Activity 실행 경로는 하나다: 관리자가 채널에서 **`/launcher`**를 실행하면
**🎮 실행 버튼** 메시지가 게시·고정된다. 이 버튼이 유일한 진입점이다.

- 버튼 클릭 → 봇이 **길드 멤버십·채널 열람권**을 검증하고 Activity를 연다
- 다른 경로(App Launcher 등)로 실행하면 봇이 가로채 버튼으로 안내한다
- 접속(hello) 시에도 3단 검증: Origin(discordsays) → 서버측 토큰 검증
  (`/oauth2/@me`로 **우리 앱이 발급한** 토큰인지 대조) → 멤버십·열람권.
  미통과 시 정보 0바이트로 종료

## 설정·구성 파일

| 파일 | 역할 |
|---|---|
| `.env` | 자격증명·모드·접근통제·기억 등 전부 (아래 레퍼런스) |
| `persona.md` | **캐릭터 카드** — frontmatter(`big_five`) + 산문 시스템 프롬프트(멀티라인 자유). 이 파일이 곧 캐릭터다 |
| `activity/public/models/sample.vrm` | 아바타 모델. 교체 후 URL에 `?admin`을 붙여 카메라·포즈 리프레이밍 |
| `activity/public/models/anim/*.fbx` | Mixamo 모션(idle/speaking/thinking). **직접 다운로드**해 배치 — 재배포 금지 에셋이라 저장소엔 없음 (규칙은 그 폴더의 README.txt) |

목소리는 AivisSpeech 음성 모델 교체 + `.env`의 `AIVIS_STYLE_*` 감정 스타일 매핑으로 바꾼다.

## .env 레퍼런스

★ = 비밀값. 비워도 되는 값은 기본값으로 동작한다. 모드는 변수로 갈린다:

| 모드 | 조건 |
|---|---|
| **디스코드 봇** (Activity) | `DISCORD_TOKEN` 채움 |
| **web** (브라우저 단독) | `DISCORD_TOKEN` 비움 — 디스코드 미접속, discordsays 오리진 자동 비활성. LAN·`EXTRA_ORIGINS`로만 접속 |
| LLM: **Workers AI** | `CF_ACCOUNT_ID`+`CF_API_TOKEN` |
| LLM: **외부 OpenAI 호환 API** | `LLM_API_URL`(+`LLM_MODEL`) — CF보다 우선 |
| LLM: **스텁** | 둘 다 비움 — 아바타·TTS 개발은 가능 |

### Discord — 봇 모드 (전부 비우면 web 모드)

넷은 서로 다른 값이다. 특히 **Public Key와 Client Secret을 혼동하지 말 것.**

| 변수 | 설명 |
|---|---|
| `DISCORD_CLIENT_ID` | Application ID (포털 General Information). 비밀 아님 |
| `DISCORD_PUBLIC_KEY` | Public Key — 웹훅 이벤트 서명 검증용 |
| `DISCORD_CLIENT_SECRET` ★ | OAuth 인가 코드→토큰 교환용 |
| `DISCORD_TOKEN` ★ | 봇 게이트웨이 접속·API 인증 |
| `DEV_GUILD_ID` | 있으면 슬래시 커맨드를 이 서버에만 즉시 등록(개발용). 없으면 전역 등록(반영 지연) |

### LLM 공급자 A — Cloudflare Workers AI

| 변수 | 설명 |
|---|---|
| `CF_ACCOUNT_ID` / `CF_API_TOKEN` ★ | 계정 ID + Workers AI Read·Edit 권한 토큰 |
| `CF_MODEL` | 대화 모델 ID. Workers AI는 모델 폐기가 잦아 env로 관리 |
| `CF_BILINGUAL_MODEL` | 이중 언어 번역 모델 |
| `CF_GATEWAY` | (선택) AI Gateway 이름 — 넣으면 게이트웨이 경유(캐시·속도제한·로그) |
| `CF_GATEWAY_TOKEN` ★ | 인증형 게이트웨이일 때만 |
| `CF_TRANSLATE_CACHE_TTL` | 번역 요청 캐시 TTL(초). 반복 문장 적중용, 기본 1일 |

### LLM 공급자 B — 외부 OpenAI 호환 API (채우면 A보다 우선)

OpenAI · OpenRouter · Groq · 로컬 ollama/vLLM 등 `/chat/completions`를 말하는 어디든.

| 변수 | 설명 |
|---|---|
| `LLM_API_URL` | 베이스 URL. OpenAI `https://api.openai.com/v1` · ollama `http://host.docker.internal:11434/v1` |
| `LLM_API_KEY` ★ | 키 없는 로컬 서버면 비워둠 |
| `LLM_MODEL` | B 모드 필수. 예: `gpt-4o-mini` |
| `LLM_BILINGUAL_MODEL` | 번역 모델 (비우면 `LLM_MODEL`과 동일) |

### LLM 공통 · 감정

| 변수 | 설명 |
|---|---|
| `LLM_MAX_TOKENS` | 응답 상한. 한국어는 토큰 밀도가 높아 넉넉히 (기본 512) |
| `EMOTION_REASON` | 감정 마커에 이유 구절 `[happy:0.8\|칭찬받아서]` 지시 (화면엔 안 나감). 0=끔 |

### TTS · 이중 언어

| 변수 | 설명 |
|---|---|
| `LLM_BILINGUAL` | 1이면 한국어로 생성 후 문장별 일본어 번역 → 감정 음성 + 한국어 자막 |
| `AIVIS_URL` | AivisSpeech 엔진 주소 (compose 기본값 그대로면 됨) |
| `AIVIS_STYLE_*` | 음성 모델 교체 시 감정별 스타일 ID 재정의: `NEUTRAL` `HAPPY` `SAD` `ANGRY` `SURPRISED` `RELAXED` |

### 문장 스트리밍

| 변수 | 설명 |
|---|---|
| `SENTENCE_STREAM` | 문장 단위로 잘라 합성·재생(첫 소리 빠름). 0이면 응답 전체를 한 번에(자연스럽고 느림) |

### 접근 통제

Activity iframe 오리진(`https://<CLIENT_ID>.discordsays.com`)은 봇 모드에서 자동 허용된다.

| 변수 | 설명 |
|---|---|
| `EXTRA_ORIGINS` | 추가 허용 오리진(쉼표). web 모드의 공개 도메인은 여기에 |
| `ALLOW_LAN` | 내부망(사설 IP) 접속 허용 — 테스트용. 외부 노출 호스트면 0 |
| `LAN_USER_ID` / `LAN_USER_NAME` | 내부망 접속자에게 부여할 테스트 신원 (없으면 내부망도 거절) |
| `ALLOWED_GUILDS` / `ALLOWED_USERS` | 허용목록(쉼표 구분 ID). **비면 전체 허용(개발 기본)** — 배포 시 채울 것 |

### 비용 가드

| 변수 | 설명 |
|---|---|
| `PROMPT_COOLDOWN_MS` | 같은 사용자 입력 최소 간격 |
| `QUEUE_MAX` | 채널당 대기 입력 상한 |
| `MAX_ACTIVE_RESPONSES` | 전역 동시 응답(LLM+TTS) 수 |

### 기억 · 개인정보

| 변수 | 설명 |
|---|---|
| `MEMORY_CONTEXT_USERS` | 프롬프트에 넣을 최근 발화자 수 |
| `MEMGUARD_JUDGE` | 기억 저장 전 민감정보·인젝션 LLM 판정. 0=기계 필터만 |
| `LOG_RETENTION_DAYS` | 원문 로그 자동 파기(일). 0=끔 |
| `PROFILE_RETENTION_MONTHS` | 유저 프로필 자동 만료(최종 대화 후 개월). 0=끔 |

## 빠른 시작

요구사항: Docker (+ compose v2). 디스코드 봇 모드면 Discord 애플리케이션.

```sh
git clone <this-repo> && cd vrm-avatar-activity

# 1. 샘플 VRM 모델 (pixiv 공식 샘플, VRM 1.0 라이선스 — CREDITS.md)
sh scripts/fetch-sample-model.sh

# 2. 설정 + 캐릭터
cp .env.example .env               # 자격증명·모드 — 위 「.env 레퍼런스」 참고
cp persona.md.example persona.md   # 캐릭터: 성격 산문 + big_five

# 3. 실행
docker compose up -d
```

Discord 개발자 포털 (봇 모드):
1. 앱 생성 → **Activities 활성화**
2. Bot 토큰·Client ID/Secret·Public Key → `.env`
3. **URL Mappings**: 루트(`/`) → Activity를 서빙할 도메인 (아래 노출 방법)
4. 봇을 서버에 초대 → 채널에서 **`/launcher`** → 고정된 **🎮 버튼**으로 실행

**Activity 노출**: iframe은 HTTPS 공개 도메인이 필요하다. 개발은 `cloudflared` 터널이나
리버스 프록시(Caddy 등)로 `activity`(5173)을 노출하면 된다.
**web 모드**: 같은 화면을 브라우저에서 직접 연다(`http://<호스트>:5173`) —
디스코드 없이 아바타·대화·TTS를 개발·시연할 수 있다.

## 테스트

```sh
docker compose run --rm --no-deps bot node --test
```

## 라이선스

- 코드: [MIT](LICENSE)
- 기본 VRM 모델: © 2022 pixiv Inc., [VRM 1.0 Public License](https://vrm.dev/licenses/1.0/) — [CREDITS.md](CREDITS.md)

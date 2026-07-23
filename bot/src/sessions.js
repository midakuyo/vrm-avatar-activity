import {
  respondStream, summarize, updateUserOps, reflect, updateSelf, thinkAloud, rethinkMd,
  translateToJa, BILINGUAL,
} from './llm.js';
import { toUnits } from './sentences.js';
import { takeEmotion } from './emotions.js';
import { synthesize } from './tts.js';
import { toSpeakable, stripEmoji } from './speakable.js';
import {
  resolveScopes, loadSession, saveSession,
  loadContext, loadReadOnlyTalk, loadUserMd, saveUserMd,
  loadScopeMd, saveScopeMd,
  clearUser, clearScope, clearSession,
  appendLog, purgeLog, clearLog, stripUserFromLog, touchUser,
  loadRelation, bumpAffinity, loadSelfMd, saveSelfMd, canWriteSelf,
} from './memory.js';
import { parseItems, buildBody, listForPrompt, applyOps, fadingItems } from './memdoc.js';
import { machineCheck, checkCandidate } from './memguard.js';
import { createMood } from './mood.js';
import { checkCooldown, QUEUE_MAX, acquireResponseSlot, releaseResponseSlot } from './limits.js';

// 두 가지를 분리해서 들고 있다.
//
//   store   — 스코프 단위. 기억이다. 대화 원문·요약·무드·화자.
//             같은 서버의 공개 채널들은 하나의 store를 공유한다. 아바타는 하나이므로
//             채널을 옮겼다고 방금 한 이야기를 잊으면 안 된다.
//   channel — 채널 단위. 표시 상태다. 큐·상태기계·자막·채팅 오버레이.
//             Activity 인스턴스가 채널마다 따로 뜨므로 이건 채널을 따라간다.
//
// 스코프 3종(DM / 서버-공개 / 서버-비공개)과 읽기·쓰기 범위는 memory.js 참고.

const HISTORY_MAX = 40;
// 원문이 이 개수를 넘으면 idle 후 오래된 절반을 요약에 합친다.
const COMPACT_AT = Number(process.env.MEMORY_COMPACT_AT ?? 24);
// 프롬프트에 장기기억을 실을 유저 수 상한.
// 비공개 채널은 읽기 스코프가 둘이라 실제 문서 수는 최대 2배가 된다.
const CONTEXT_USERS = Number(process.env.MEMORY_CONTEXT_USERS ?? 4);
// 스냅샷으로 보낼 최근 채팅. 클라이언트 오버레이가 15초 뒤 지우므로 창도 그만큼만.
const RECENT_MAX = 20;
const RECENT_WINDOW_MS = 15_000;
// md 크기 상한 (⑦, Letta). 초과 시 압축 훅 끝에서 rethink 재작성.
// 근거: 주입 유저 4명 기준 최악 프롬프트 ~6k 토큰 (docs/memory-emotion-plan.md).
const SCOPE_MD_LIMIT = Number(process.env.SCOPE_MD_LIMIT ?? 2000);
const USER_MD_LIMIT = Number(process.env.USER_MD_LIMIT ?? 1000);
const SELF_MD_LIMIT = Number(process.env.SELF_MD_LIMIT ?? 1200);
// 응답당 호감 반영률 (⑭). 무드 valence(−1~1)에 곱한다 — 작게, 누적으로만 움직이게.
const AFFINITY_RATE = Number(process.env.RELATION_AFFINITY_RATE ?? 0.02);

// ---- 생각 풍선 / 프로액티브 (⑬) ----
// 기본 꺼짐 — 빈도·톤이 페르소나에 크게 의존하므로 캐릭터 확정 후 dev에서 켜서 조정.
const PROACTIVE = process.env.PROACTIVE === '1';
const PROACTIVE_IDLE_MIN = Number(process.env.PROACTIVE_IDLE_MIN ?? 4); // 유휴 이만큼 지나면 후보
const PROACTIVE_MAX_PER_HOUR = Number(process.env.PROACTIVE_MAX_PER_HOUR ?? 4);
const PROACTIVE_STREAK = Number(process.env.PROACTIVE_STREAK ?? 2); // 무반응 연속 상한
const PROACTIVE_TICK_MS = 30_000;

// 대화 내용이 담기는 콘솔 로그의 게이트. 운영에서는 0으로 꺼서
// docker 로그에 발화 원문이 남지 않게 한다 (docs/data-inventory.md 2장).
const VERBOSE = process.env.LOG_VERBOSE !== '0';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createSessions(bus) {
  const stores = new Map(); // scope.write -> 기억
  const channels = new Map(); // channelId -> 표시 상태

  function getStore(scopes) {
    const key = scopes.write;
    let st = stores.get(key);
    if (!st) {
      st = {
        scopes,
        history: [], summary: '', mood: createMood(),
        speakers: [], names: new Map(),
        compacting: false,
        // /forget 세대 카운터. forget이 올리면, 그 전에 시작된 압축은
        // 체크포인트에서 스스로 중단한다 — 지운 데이터를 되살리지 않기 위해.
        gen: 0,
        loaded: scopes.ephemeral
          ? Promise.resolve()
          : loadSession(key)
          .then((saved) => {
            if (!saved) return;
            st.history = saved.recent ?? [];
            st.summary = saved.summary ?? '';
            st.mood.restore(saved.mood);
            console.log(
              `[memory] 복원: ${key} (원문 ${st.history.length}개, 요약 ${st.summary.length}자)`,
            );
          })
          .catch((err) => console.error('[memory] 복원 실패:', err.message)),
      };
      stores.set(key, st);
    }
    return st;
  }

  function getChannel(channelId) {
    let ch = channels.get(channelId);
    if (!ch) {
      ch = {
        store: null, queue: [], busy: false,
        state: 'idle', recent: [], speech: null, emotion: 'neutral',
        // 프로액티브(⑬) 추적: 마지막 활동, 무반응 연속 풍선 수, 최근 1시간 발화 시각들
        lastActivityAt: Date.now(), thoughtStreak: 0, thoughtTimes: [],
      };
      channels.set(channelId, ch);
    }
    return ch;
  }

  const persist = (st) => {
    if (st.scopes.ephemeral) return; // 판정 실패한 스코프는 디스크에 남기지 않는다
    // /forget all 뒤에 끝난 응답이 삭제된 스코프를 재생성하지 않도록 —
    // 이 st가 여전히 현역일 때만 쓴다. (리뷰에서 재현된 부활 버그의 차단선)
    if (stores.get(st.scopes.write) !== st) return;
    saveSession(st.scopes.write, {
      summary: st.summary,
      recent: st.history,
      mood: st.mood.state,
    }).catch((err) => console.error('[memory] 저장 실패:', err.message));
  };

  // 상태 전이는 항상 여기를 거친다. 브로드캐스트와 스냅샷용 기록이 어긋나지 않도록.
  const setState = (channelId, ch, state) => {
    ch.state = state;
    if (state !== 'speaking') ch.speech = null;
    // 말이 끝나면 무드가 한 걸음 식는다 — 표정이 즉시 무표정이 되지 않고 여운이 남는다.
    if (state === 'idle' && ch.store) ch.store.mood.decay();
    bus.toChannel(channelId, {
      type: 'state',
      state,
      expression: ch.store?.mood.expression ?? [{ name: 'neutral', weight: 0 }],
    });
  };

  // 상한 초과 md를 rethink로 재작성한 뒤 항목 단위로 2겹 재검증한다 (⑦).
  // rethink는 자유 재작성이라 지시성 문장을 합성할 수 있는데, 그 산출물을 검사하는
  // 유일한 관문이므로 여기서 항목마다 checkCandidate를 돌린다 (리뷰: 기계 필터만이던 곳).
  // 반환: 정제된 body, 또는 상한 이하면 원본 그대로. gen이 바뀌면 null(중단 신호).
  async function packWithinLimit(st, gen, kind, body, limit, mode = 'default') {
    if (body.length <= limit) return body;
    const before = parseItems(body);
    // ⑩ 흐릿한 항목을 rethink에 우선 축약 힌트로 넘긴다 (R = e^(−t/S) 낮은 순).
    const fading = fadingItems(before);
    // 변경 안 된 항목의 망각곡선 메타를 복원하기 위해 text→{day,s} 맵을 남긴다 —
    // rethink LLM이 <!-- --> 주석을 흘리면 parseItems가 day=null·S1로 읽어 전 항목이
    // 오늘 날짜로 리셋된다(강도 손실). 텍스트가 그대로인 항목만 메타를 되살린다.
    const origMeta = new Map();
    for (const sec of before.sections) for (const it of sec.items) origMeta.set(it.text, { day: it.day, s: it.s });

    const packed = await rethinkMd(kind, body, limit, fading).catch(() => null);
    if (st.gen !== gen) return null;
    if (!packed) return body; // 재작성 실패 — 원본 유지(상한 초과인 채로)

    const doc = parseItems(packed);
    const clean = { title: doc.title, sections: [] };
    for (const sec of doc.sections) {
      if (machineCheck(sec.name)) continue;
      const items = [];
      for (const item of sec.items) {
        if (await checkCandidate(item.text.slice(0, 200), mode)) continue;
        if (item.day == null) {
          const o = origMeta.get(item.text); // 안 바뀐 항목이면 메타 복원
          if (o) { item.day = o.day; item.s = o.s; }
        }
        items.push(item);
      }
      if (st.gen !== gen) return null;
      if (items.length) clean.sections.push({ name: sec.name, items });
    }
    return buildBody(clean);
  }

  // 압축되는 구간에 등장한 사람들의 장기기억 문서를 갱신한다 (⑥ diff ops).
  // 통재작성이 아니라 항목 단위 연산만 받으므로 언급 없는 항목은 바이트 그대로다.
  // gen: 시작 시점의 st.gen — 도중에 /forget이 오면 남은 갱신을 중단한다.
  async function updateUsers(st, turns, gen) {
    if (st.scopes.ephemeral) return; // 임시 스코프는 디스크에 유저 문서를 만들지 않는다
    const uids = [...new Set(turns.map((t) => t.uid).filter(Boolean))].slice(0, CONTEXT_USERS);
    for (const uid of uids) {
      if (st.gen !== gen) return; // /forget me가 지운 문서를 되살리지 않는다
      try {
        const name = st.names.get(uid) ?? '유저';
        const doc = parseItems(await loadUserMd(st.scopes.write, uid), name);
        const ops = await updateUserOps(name, listForPrompt(doc), turns);
        if (st.gen !== gen) return; // LLM 호출(수 초) 동안 forget이 왔을 수 있다
        if (!ops?.length) continue;

        // 후보 텍스트 검증 (2겹): 기계 필터는 동기, LLM 판정은 여기서 미리 비동기로.
        // applyOps의 validate 훅은 동기여야 하므로 판정 결과를 맵으로 넘긴다.
        const verdicts = new Map();
        for (const op of ops) {
          const kind = String(op.op ?? '').toUpperCase();
          if ((kind === 'ADD' || kind === 'UPDATE') && op.text) {
            verdicts.set(op, await checkCandidate(String(op.text).slice(0, 200)));
          }
        }
        if (st.gen !== gen) return;

        const { doc: next, applied, dropped } = applyOps(doc, ops, {
          // 판정은 위에서 op 단위로 미리 받아뒀다 — 여기서는 참조로 조회만.
          validate: (text, op) => verdicts.get(op) ?? machineCheck(text),
        });

        // 적용된 연산(ADD/UPDATE/DELETE/TOUCH)이 있으면 저장한다. TOUCH도 이제
        // 강도 S를 올리므로(⑩) 실변경이다. dropped-only(전부 기각)만 무저장 —
        // parse→build를 돌리면 레거시 비항목 줄이 소실되므로 아무것도 안 바뀔 땐 건드리지 않는다.
        const realChanges = applied.length;

        const at = new Date().toISOString();
        if (realChanges) {
          const body = await packWithinLimit(st, gen, '사용자 프로필', buildBody(next), USER_MD_LIMIT);
          if (body === null) return; // gen 변경 — 중단
          await saveUserMd(st.scopes.write, uid, body);
          // 감사 추적 (4겹): /forget me·보존기간과 함께 죽도록 log.jsonl에 role:'audit'로.
          // TOUCH는 인젝션과 무관한 강도 갱신이라 감사에서 뺀다(매 사이클 로그 비대 방지).
          const auditable = applied.filter((x) => x.op !== 'TOUCH');
          if (auditable.length) {
            await appendLog(st.scopes.write,
              auditable.map((x) => ({ role: 'audit', uid, at, content: JSON.stringify(x) })),
            ).catch(() => {});
          }
          console.log(`[memory] 유저 문서 갱신: ${uid} (실변경 ${realChanges}건, ${body.length}자)`);
        }
        // 기각(인젝션 시도 등)은 저장과 무관하게 항상 기록한다 — 콘솔 warn은
        // LOG_RETENTION_DAYS=0에서 log.jsonl이 비어도 남는 폴백이다.
        if (dropped.length) {
          await appendLog(st.scopes.write,
            dropped.map((x) => ({ role: 'audit', uid, at, content: JSON.stringify({ dropped: x.why }) })),
          ).catch(() => {});
          console.warn(`[memory] 기억 후보 ${dropped.length}건 기각(${uid}): ${dropped.map((d) => d.why).join(',')}`);
        }
      } catch (err) {
        console.error('[memory] 유저 문서 갱신 실패:', err.message);
      }
    }
  }

  // Reflection (⑤) — 압축되는 대화에서 통찰을 뽑아 scope.md에 쌓는다.
  // scope.md는 프롬프트에 통째로 주입되므로 이후 대화에 자동 반영된다.
  async function reflectScope(st, turns, gen) {
    if (st.scopes.ephemeral) return;
    try {
      const insights = await reflect(turns);
      if (st.gen !== gen || !insights.length) return;

      // 통찰도 저장되는 텍스트다 — 같은 검증을 통과해야 한다 (지시문·민감정보).
      const kept = [];
      for (const line of insights) {
        const verdict = await checkCandidate(line.slice(0, 200));
        if (!verdict) kept.push(line.slice(0, 160));
      }
      if (st.gen !== gen || !kept.length) return;

      // 항목 기반으로 다뤄 통찰을 '## 깨달은 것' 섹션 아래에 정확히 얹는다
      // (문자열 append는 다른 섹션이 뒤에 있으면 파일 끝에 붙는다).
      const HEADER = '깨달은 것';
      const doc = parseItems(await loadScopeMd(st.scopes.write));
      let sec = doc.sections.find((s) => s.name === HEADER);
      if (!sec) {
        sec = { name: HEADER, items: [] };
        doc.sections.push(sec);
      }
      for (const line of kept) sec.items.push({ id: 0, text: line });

      // ⑦ scope.md 상한 — rethink가 통찰들을 병합·상위화한다
      // (Generative Agents의 "통찰의 통찰"을 재귀 없이 얻는 지점).
      const md = await packWithinLimit(st, gen, '스코프 기억', buildBody(doc), SCOPE_MD_LIMIT);
      if (md === null) return; // gen 변경 — 중단
      await saveScopeMd(st.scopes.write, md);
      console.log(`[memory] 통찰 ${kept.length}건 → scope.md (${md.length}자)`);
    } catch (err) {
      console.error('[memory] Reflection 실패:', err.message);
    }
  }

  // 캐릭터 자기 기억 갱신 (⑫) — 공개 스코프 압축에서만. self.md는 전역이라
  // DM·비공개의 자기 결정이 새면 격리가 깨진다 → canWriteSelf로 공개만 통과.
  async function reflectSelf(st, turns, gen) {
    if (st.scopes.ephemeral || !canWriteSelf(st.scopes.write)) return;
    try {
      const facts = await updateSelf(turns);
      if (st.gen !== gen || !facts.length) return;

      // 자기 기억은 격리 검사까지 받는다(mode 'self') — 특정 제3자·서버·맥락이
      // 섞이면(격리) 전역 self.md를 통해 무관한 스코프에 노출된다. + 인젝션·민감정보.
      const kept = [];
      for (const line of facts) {
        if (!(await checkCandidate(line.slice(0, 200), 'self'))) kept.push(line.slice(0, 140));
      }
      if (st.gen !== gen || !kept.length) return;

      const HEADER = '나에 대해';
      const doc = parseItems(await loadSelfMd());
      let sec = doc.sections.find((s) => s.name === HEADER);
      if (!sec) {
        sec = { name: HEADER, items: [] };
        doc.sections.push(sec);
      }
      for (const line of kept) sec.items.push({ id: 0, text: line });

      // 자기 기억 상한 — 항목 재검증 포함(packWithinLimit, self 모드로 격리 검사도).
      const md = await packWithinLimit(st, gen, '캐릭터 자기소개', buildBody(doc), SELF_MD_LIMIT, 'self');
      if (md === null) return;
      await saveSelfMd(md);
      console.log(`[memory] 자기 기억 ${kept.length}건 → self.md (${md.length}자)`);
    } catch (err) {
      console.error('[memory] 자기 기억 갱신 실패:', err.message);
    }
  }

  // 오래된 절반을 요약에 합친다. 응답 경로 밖(큐가 빈 뒤)에서만 부른다.
  async function compact(st) {
    if (st.compacting || st.history.length <= COMPACT_AT) return;
    st.compacting = true;
    const gen = st.gen; // 이 시점 기준. /forget이 올리면 아래 체크포인트에서 중단.
    try {
      const cut = Math.floor(st.history.length / 2);
      const old = st.history.slice(0, cut);
      const merged = await summarize(st.summary, old).catch((err) => {
        console.error('[memory] 요약 실패:', err.message);
        return null;
      });

      // 요약(LLM, 수 초) 동안 /forget이 실행됐거나 스토어가 교체됐으면
      // 여기서 쓰는 어떤 것도 "지웠다"고 답한 데이터의 부활이 된다 — 전부 버린다.
      if (st.gen !== gen || stores.get(st.scopes.write) !== st) return;

      if (merged) {
        // 캡처 이후 새 턴이 뒤에 붙었어도 앞 cut개 제거는 안전하다.
        st.history = st.history.slice(cut);
        st.summary = merged;
        console.log(`[memory] 압축: 원문 ${cut}개 → 요약 (${merged.length}자)`);
        // 퇴출되는 원문을 보존기간 한정 로그에 남긴다 (①). 실패해도 압축은 유효하다.
        // 임시 스코프는 디스크에 아무것도 남기지 않는다는 원칙 그대로.
        if (!st.scopes.ephemeral) {
          await appendLog(st.scopes.write, old).catch((err) =>
            console.error('[memory] 로그 기록 실패:', err.message),
          );
        }
        await updateUsers(st, old, gen);
        await reflectScope(st, old, gen);
        await reflectSelf(st, old, gen);
      } else if (st.history.length > HISTORY_MAX) {
        // 요약 불가(스텁/실패) 폴백: 무한 성장만 막되, 버리는 원문은 로그에 남긴다.
        const evicted = st.history.splice(0, st.history.length - HISTORY_MAX);
        if (!st.scopes.ephemeral) await appendLog(st.scopes.write, evicted).catch(() => {});
      }
      // 압축 주기에 얹어 이 스코프의 만료 로그도 정리한다 (전 스코프는 기동 시 일괄).
      if (!st.scopes.ephemeral) await purgeLog(st.scopes.write).catch(() => {});
      persist(st);
    } finally {
      st.compacting = false;
    }
  }

  async function speakStreaming(channelId, ch, st, author, text, reply) {
    const spoken = [];
    let speaking = false;
    const gen = st.gen; // 응답 중 /forget이 오면 아래 관계 갱신을 스킵하는 기준
    // 클라이언트는 받은 순서대로 이어 재생한다. 합성은 재생보다 빠르므로
    // 오디오가 실제로 끝나는 시각을 여기서 누적해 idle 시점을 잡는다.
    let audioEndsAt = 0;

    // 최근 대화에 등장한 사람들의 장기기억을 상한 안에서 붙인다.
    const uids = [...new Set(st.speakers.slice(-10).reverse())].slice(0, CONTEXT_USERS);
    // 현재 발화자의 uid — 관계 단어(⑭)·호감 갱신에 쓴다.
    const speakerUid = st.speakers[st.speakers.length - 1] ?? null;
    // 임시(ephemeral) 스코프는 디스크 기억을 읽지 않는다 — 스코프 문자열이
    // 비정상(mem-*)이라 경로순회로 타 스코프를 가리킬 수 있으므로 읽기 자체를 건너뛴다.
    // (memory.js scopeFile 형식 가드가 최종 방어선이지만, 여기서 명시적으로 차단한다.)
    const eph = st.scopes.ephemeral;
    const [ctx, publicTalk, self, relation] = await Promise.all([
      eph ? { guide: '', memory: '' } : loadContext(st.scopes.read, uids).catch(() => ({ guide: '', memory: '' })),
      // 비공개 채널이면 공개 쪽의 진행 중인 대화도 읽는다 (쓰기는 하지 않는다)
      eph ? '' : loadReadOnlyTalk(st.scopes.read, st.scopes.write).catch(() => ''),
      loadSelfMd().catch(() => ''), // ⑫ 캐릭터 자기 기억 (전역, 스코프 무관)
      speakerUid && !eph ? loadRelation(st.scopes.write, speakerUid).catch(() => null) : null, // ⑭
    ]);
    // guide(신뢰)와 memory(데이터)는 신뢰 등급이 달라 프롬프트에서 분리 주입한다.
    // 진행 중인 공개 대화는 자동 생성물이므로 memory 쪽.
    const memory = [ctx.memory, publicTalk].filter(Boolean).join('\n\n');

    // 응답은 항상 한국어로 생성한다(안정적). 자막 = 한국어.
    const units = toUnits(
      respondStream(
        {
          history: st.history, summary: st.summary, guide: ctx.guide, memory,
          self: self.trim(),
          // moodWord: 무드→LLM 폐루프 (③). relation: 이 사람과의 관계(⑭). 둘 다
          // 없으면 주입 안 됨(옅은 무드 null, 무색 관계 null).
          moodWord: st.mood.promptWord,
          relation: relation ? `${author}은(는) 너에게 ${relation}야.` : null,
        },
        { author, text },
      ),
      { emotion: ch.emotion },
    );

    // --- 파이프라인: 번역을 앞질러 동시에 시작하고, TTS·전송은 순서대로 소비 ---
    // 번역(원격 llama, I/O)은 문장마다 편차가 크다(최대 8초 관측). 직렬로 두면 느린
    // 문장 하나가 뒤 문장 전부를 막는다. 그래서 스트림에서 유닛을 받는 즉시 번역을
    // 시작(여러 문장 동시)하고, TTS(로컬 CPU, 직렬)·전송은 순서대로 처리한다 —
    // 번역 지연이 앞 문장의 TTS·재생 뒤로 숨어 문장 간 공백이 준다.
    const prepared = []; // 준비된 유닛 큐 (순서 보존)
    let streamDone = false;
    let produceErr = null;
    let wake = null;
    const signal = () => { const w = wake; wake = null; w?.(); };

    // 프로듀서: 유닛을 순서대로 꺼내 무드 누적 + 번역 시작(동시). 무드는 여기서 순서 보장.
    const produce = (async () => {
      try {
        for await (const unit of units) {
          const subtitle = stripEmoji(unit.subtitle);
          if (!subtitle) continue;
          st.mood.pushBlend(unit.blend);
          const korean = toSpeakable(subtitle);
          const jaPromise = BILINGUAL && korean
            ? translateToJa(korean).then((ja) => ja, () => null) // 실패→null(자막만)
            : null;
          prepared.push({
            unit, subtitle, korean, jaPromise,
            emotion: unit.emotion, reason: unit.reason,
            expression: st.mood.expression,
            voice: { ...st.mood.voice, emotion: unit.emotion },
          });
          signal();
        }
      } catch (err) {
        produceErr = err;
      } finally {
        streamDone = true;
        signal();
      }
    })();

    // 컨슈머: 도착 순서대로 번역 완료를 기다려 TTS·전송.
    for (;;) {
      if (!prepared.length) {
        if (streamDone) break;
        await new Promise((r) => { wake = r; });
        continue;
      }
      const item = prepared.shift();
      const { unit, subtitle, korean, jaPromise, emotion, reason, expression, voice } = item;

      // 자막은 한국어. 이중 언어면 TTS에 넘길 것만 일본어(미리 시작한 번역)를 기다린다.
      let ttsText = korean;
      if (jaPromise) {
        const ja = await jaPromise;
        if (ja) ttsText = ja;
        else {
          // 번역 불가 — 한국어를 일본어 엔진에 넣으면 뭉개진 소리라 자막만.
          console.warn(
            '[session] 번역 불가 — 자막만:',
            VERBOSE ? JSON.stringify(korean.slice(0, 40)) : `${korean.length}자`,
          );
          ttsText = '';
        }
      }
      // 번역이 이모지·마크다운을 새로 만들 수 있으므로 TTS 직전에 한 번 더 정제한다.
      ttsText = toSpeakable(ttsText ?? '');

      let speech = null;
      if (ttsText) {
        try {
          // 스타일(감정 톤)은 이 문장의 라벨이, 운율(속도·피치·억양)은 누적 무드가 정한다.
          speech = await synthesize(ttsText, voice);
        } catch (err) {
          console.error(
            '[session] TTS 실패:', err.message,
            '| 입력:', VERBOSE ? JSON.stringify(ttsText.slice(0, 60)) : `${ttsText.length}자`,
          );
        }
      } else if (subtitle.trim()) {
        console.warn(
          '[session] TTS 스킵(정제 후 빈 문장):',
          VERBOSE ? JSON.stringify(subtitle.slice(0, 60)) : `${subtitle.length}자`,
        );
      }

      if (!speaking) {
        setState(channelId, ch, 'speaking');
        speaking = true;
      }

      const durationMs = speech?.durationMs ?? subtitle.length * 80;
      const audioInfo = speech ? Math.round(speech.audio.length / 1024) + 'KB/' + durationMs + 'ms' : 'null';
      console.log(
        VERBOSE
          ? `[speak] "${subtitle.slice(0, 24)}" tts=${JSON.stringify((ttsText ?? '').slice(0, 24))} audio=${audioInfo}` +
            (reason ? ` [${emotion}|${reason.slice(0, 20)}]` : '')
          : `[speak] ${subtitle.length}자 tts=${(ttsText ?? '').length}자 audio=${audioInfo}`,
      );
      ch.emotion = emotion;
      ch.speech = subtitle;
      bus.toChannel(channelId, {
        type: 'speak',
        text: subtitle, // 화면에 뜨는 것은 자막
        emotion,
        expression,
        audio: speech ? speech.audio.toString('base64') : null,
        mime: speech?.mime,
        durationMs,
      });

      audioEndsAt = Math.max(Date.now(), audioEndsAt) + durationMs;
      spoken.push(subtitle); // 채널 답장·기억에는 자막(한국어)을 남긴다
    }

    await produce; // 프로듀서 종료 보장
    if (produceErr) throw produceErr; // 스트림 오류는 상위(drain)가 폴백 처리

    const answer = spoken.join(' ');

    // 관계 갱신 (⑭) — 이 대화가 남긴 무드 valence를 발화자 호감에 소량 반영한다.
    // 좋은 대화(밝은 응답)는 천천히 친밀도를 올린다. 계수가 작아 조작이 안 된다.
    // gen·현역 가드: 응답 중 /forget이 왔으면 users/md를 되살리지 않는다(스코프 부활 방지).
    if (speakerUid && !st.scopes.ephemeral && st.gen === gen && stores.get(st.scopes.write) === st) {
      const delta = st.mood.vector.v * AFFINITY_RATE;
      bumpAffinity(st.scopes.write, speakerUid, Number(delta.toFixed(4))).catch(() => {});
    }

    // 채널 답장은 전체 문장이 확정되는 즉시 보낸다(재생 종료를 기다리지 않는다).
    if (answer) {
      try {
        await reply?.(answer);
      } catch (err) {
        console.error('[session] 채널 답장 실패:', err.message);
      }
    }

    await sleep(Math.max(0, audioEndsAt - Date.now()));
    return answer;
  }

  async function drain(channelId, ch) {
    ch.busy = true;
    const st = ch.store;
    await st.loaded; // 저장된 기억 복원이 끝난 뒤에 응답한다
    while (ch.queue.length) {
      const { author, text, reply, uid } = ch.queue.shift();

      setState(channelId, ch, 'thinking');

      let answer = '';
      // 전역 동시성 제한 — TTS가 CPU를 독식하므로 응답 파이프라인 수를 묶는다.
      await acquireResponseSlot();
      try {
        answer = await speakStreaming(channelId, ch, st, author, text, reply);
      } catch (err) {
        console.error('[session] 응답 실패:', err.message);
        answer = '음… 지금은 대답하기 어려워.';
        try {
          await reply?.(answer);
        } catch {
          // 답장 실패는 이미 로깅됨
        }
      } finally {
        releaseResponseSlot();
      }

      const at = new Date().toISOString(); // 원문 로그(①)의 보존기간 판정 기준
      st.history.push(
        { role: 'user', author, uid, content: text, at },
        { role: 'assistant', content: answer, at },
      );
      persist(st);

      setState(channelId, ch, 'idle');
    }
    ch.busy = false;
    // 압축은 응답 경로 밖에서. 도중에 새 입력이 오면 drain이 우선 돈다.
    compact(st);
  }

  // 생각 풍선 발화 (⑬) — 음성 없이 화면 풍선으로만. 히스토리에 '(생각)'으로 남겨
  // "뭐 생각해?"에 이어지게 한다. 감정 마커는 무드·표정에 반영한다.
  async function speakThought(channelId, ch) {
    const st = ch.store;
    if (!st) return;
    const gen = st.gen; // /forget이 오면 (생각) 저장을 스킵 (스코프 부활 방지)
    ch.busy = true;
    try {
      const uids = [...new Set(st.speakers.slice(-10).reverse())].slice(0, CONTEXT_USERS);
      const [ctx, self] = await Promise.all([
        loadContext(st.scopes.read, uids).catch(() => ({ guide: '', memory: '' })),
        loadSelfMd().catch(() => ''),
      ]);
      const raw = await thinkAloud({
        summary: st.summary, guide: ctx.guide, memory: ctx.memory,
        self: self.trim(), moodWord: st.mood.promptWord,
      });
      if (!raw) return;
      // 생각 생성 중(수 초) 사용자가 말을 걸었으면 그 발화가 우선이다 — 생각은 버린다.
      if (ch.queue.length || st.gen !== gen || stores.get(st.scopes.write) !== st) return;

      const parsed = takeEmotion(raw, ch.emotion);
      const { emotion, intensity, blend } = parsed;
      const text = stripEmoji(parsed.text);
      if (!text) return;
      ch.emotion = emotion;
      st.mood.pushBlend(blend ?? [{ label: emotion, intensity }]);

      bus.toChannel(channelId, {
        type: 'speak',
        mode: 'thought', // 클라이언트는 음성 없이 풍선으로 렌더
        text,
        emotion,
        expression: st.mood.expression,
        audio: null,
      });
      // 히스토리에 남겨 후속 대화가 이 생각을 이어받게 한다.
      st.history.push({ role: 'assistant', content: `(생각) ${text}`, at: new Date().toISOString() });
      persist(st);

      const now = Date.now();
      ch.thoughtStreak += 1;
      ch.thoughtTimes.push(now);
      ch.lastActivityAt = now;
      console.log(`[thought] ${channelId}: ${VERBOSE ? text.slice(0, 40) : text.length + '자'}`);
    } catch (err) {
      console.error('[session] 생각 풍선 실패:', err.message);
    } finally {
      ch.busy = false;
      // 생각 중에 큐가 쌓였으면 이어서 처리한다 — speakThought는 drain 루프 밖이라
      // 이게 없으면 그 발화가 다음 submit까지 방치된다.
      if (ch.queue.length && !ch.busy) drain(channelId, ch);
    }
  }

  // 프로액티브 스케줄러 (⑬) — 30초마다 채널을 훑어 3중 게이트를 통과한 곳에서 발화.
  let proactiveTimer = null;
  if (PROACTIVE) {
    proactiveTimer = setInterval(() => {
      const now = Date.now();
      // 지터: 유휴 임계에 ±25%를 섞어 기계적 주기감을 없앤다 (틱마다 채널별로 다르게).
      for (const [channelId, ch] of channels) {
        if (ch.busy || !ch.store || ch.store.scopes.ephemeral) continue;
        if (bus.countChannel(channelId) === 0) continue; // 아무도 안 봄
        if (ch.thoughtStreak >= PROACTIVE_STREAK) continue; // 무반응 — 사람 발화까지 침묵
        ch.thoughtTimes = ch.thoughtTimes.filter((t) => now - t < 3_600_000);
        if (ch.thoughtTimes.length >= PROACTIVE_MAX_PER_HOUR) continue; // 시간당 상한
        const idleMs = now - ch.lastActivityAt;
        const threshold = PROACTIVE_IDLE_MIN * 60_000 * (0.75 + (channelId.charCodeAt(channelId.length - 1) % 10) / 20);
        if (idleMs < threshold) continue;
        speakThought(channelId, ch);
      }
    }, PROACTIVE_TICK_MS);
    proactiveTimer.unref?.();
    console.log(`[session] 프로액티브 켜짐 (유휴 ${PROACTIVE_IDLE_MIN}분, 시간당 ${PROACTIVE_MAX_PER_HOUR})`);
  }

  return {
    // ctx: { channelId, guildId, isPublic } — 스코프 판정은 호출부(index.js)가 한다.
    // reply: 채널에 텍스트로 답할 방법 (없으면 Activity 안에서만 말한다)
    // 반환: { ok } | { ok:false, reason } — 비용 가드에 걸리면 거부한다.
    submit(ctx, author, text, reply, uid = null) {
      const channelId = ctx.channelId;
      const ch = getChannel(channelId);

      // 연타 방지 — 같은 사용자의 입력 간격을 강제한다.
      const cd = checkCooldown(uid);
      if (!cd.ok) {
        return { ok: false, reason: 'cooldown', waitMs: cd.waitMs };
      }
      // 채널 큐 상한 — 응답 중에 밀려드는 입력을 흘려버린다.
      if (ch.queue.length >= QUEUE_MAX) {
        return { ok: false, reason: 'busy' };
      }

      if (!ch.store) {
        // 스코프 판정 실패(ID가 스노우플레이크가 아님)면 **메모리로만** 돈다.
        // 디스크에 쓰면 data/memory에 정체불명 디렉터리가 쌓인다.
        const resolved = resolveScopes(ctx);
        const scopes = resolved ?? {
          write: `mem-${channelId}`,
          read: [`mem-${channelId}`],
          ephemeral: true,
        };
        ch.store = getStore(scopes);
      }
      const st = ch.store;

      if (uid) {
        st.speakers.push(uid);
        if (st.speakers.length > 40) st.speakers.shift();
        st.names.set(uid, author);
        // 만료 시계(lastSeen)와 관계 레이어(⑭)의 재료. 응답을 막지 않는다.
        if (!st.scopes.ephemeral) {
          touchUser(st.scopes.write, uid).catch((err) =>
            console.error('[memory] 유저 메타 갱신 실패:', err.message),
          );
        }
      }

      // 사람이 말을 걸었다 — 프로액티브 유휴 시계·무반응 연속을 리셋한다 (⑬).
      ch.lastActivityAt = Date.now();
      ch.thoughtStreak = 0;

      bus.toChannel(channelId, { type: 'chat', author, text });
      ch.recent.push({ author, text, at: Date.now() });
      if (ch.recent.length > RECENT_MAX) ch.recent.shift();
      ch.queue.push({ author, text, reply, uid });
      if (!ch.busy) drain(channelId, ch);
      return { ok: true };
    },

    // /forget — 언제나 현재 write 스코프에만 작용한다.
    // 비공개 채널에서 불러도 공개 기억은 건드리지 않는다(읽기만 했을 뿐 쓴 적이 없다).
    async forget(ctx, uid, scopeOpt = 'me') {
      const scopes = resolveScopes(ctx);
      if (!scopes) return '여기서는 기억을 관리할 수 없어.';

      // 진행 중인 응답·압축이 있을 수 있다 — 먼저 세대를 올려 그쪽의 이후 쓰기를
      // 무효화한 다음 디스크를 지운다. 순서가 반대면 지운 것이 되살아난다.
      const st = stores.get(scopes.write);
      if (st) st.gen += 1;

      if (scopeOpt === 'all') {
        stores.delete(scopes.write); // persist의 현역 검사가 이후 재생성을 막는다
        for (const [id, ch] of channels) {
          if (ch.store?.scopes.write === scopes.write) channels.delete(id);
        }
        await clearScope(scopes.write);
        return '이 자리에서 기억하던 걸 전부 잊었어.';
      }
      if (scopeOpt === 'here') {
        if (st) {
          st.history = [];
          st.summary = '';
          st.mood = createMood(); // data-inventory: 무드도 here 삭제 범위다
        }
        await clearSession(scopes.write);
        await clearLog(scopes.write); // 대화를 잊는 약속에는 원문 로그도 포함된다
        return '지금까지 하던 대화는 잊었어. 너에 대한 기억은 남아 있어.';
      }
      const removed = await clearUser(scopes.write, uid);
      await stripUserFromLog(scopes.write, uid).catch(() => {}); // 로그의 본인 발화 줄도 제거
      return removed ? '너에 대해 기억하던 걸 지웠어.' : '너에 대해 기억하던 게 없었어.';
    },

    // 대화 도중에 합류한 iframe이 빈 화면을 보지 않도록 현재 상태를 넘겨준다.
    // 진행 중인 발화의 오디오는 보내지 않는다 — 중간부터 재생할 수 없으므로 자막만.
    snapshot(channelId) {
      const ch = channels.get(channelId);
      if (!ch) {
        return {
          type: 'snapshot', state: 'idle', recent: [], speech: null,
          emotion: 'neutral', expression: [{ name: 'neutral', weight: 0 }],
        };
      }
      const now = Date.now();
      return {
        type: 'snapshot',
        state: ch.state,
        speech: ch.speech,
        emotion: ch.emotion,
        expression: ch.store?.mood.expression ?? [{ name: 'neutral', weight: 0 }],
        recent: ch.recent
          .filter((r) => now - r.at < RECENT_WINDOW_MS)
          .map((r) => ({ author: r.author, text: r.text, ageMs: now - r.at })),
      };
    },
  };
}

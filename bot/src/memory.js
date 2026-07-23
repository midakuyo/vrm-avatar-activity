// 기억 저장소 (docs/emotion-and-memory.md 2장).
//
// 스코프 3종:
//   DM          → d-<channelId>                (원천 격리)
//   서버 공개    → g-<guildId>/public           (공개 채널들이 공유)
//   서버 비공개  → g-<guildId>/p-<channelId>    (채널마다 하나, 공개를 읽기만 한다)
//
// 저장 함수는 write 스코프 하나만 받는다 — 여러 스코프에 동시에 쓰는 코드를
// 애초에 만들 수 없게 하기 위해서다.

import { mkdir, readFile, writeFile, rename, rm, appendFile, readdir } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

const DATA_DIR = process.env.DATA_DIR ?? '/app/data/memory';

// ---- 보존기간 (docs/privacy-plan.md 4장) ----
// 원문 로그는 N일 뒤 자동 파기, 유저 md는 최종 대화 후 N개월 뒤 파기.
// 파일 경계 = 보존기간 경계: session.json(스코프 수명) / log.jsonl(일 단위) / users/*.md(월 단위)
// env 오타(NaN)가 "0(끔)"으로 해석되면 안 된다 — 끔은 로그 삭제를 뜻하므로,
// 파싱 불가면 기본값으로 되돌린다. 명시적 0만 끔이다.
const envNum = (name, fallback) => {
  const n = Number(process.env[name] ?? fallback);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};
const LOG_RETENTION_DAYS = envNum('LOG_RETENTION_DAYS', 180);
const PROFILE_RETENTION_MONTHS = envNum('PROFILE_RETENTION_MONTHS', 12);

// 외부에서 온 값이 파일 경로가 되므로 스노우플레이크(숫자)만 통과시킨다.
const ID = /^\d+$/;

// 스코프 문자열이 파일 경로가 되는 모든 지점의 최종 방어선.
// resolveScopes가 내는 정상 형식만 허용한다 — 'mem-x/../d-victim' 같은 경로순회로
// DATA_DIR 밖·타 스코프를 가리키는 것을 원천 차단한다 (심층 방어).
// 정상 형식: d-<snowflake> / g-<snowflake>/public / g-<snowflake>/p-<snowflake>
const VALID_SCOPE = /^(d-\d+|g-\d+\/public|g-\d+\/p-\d+)$/;
const isValidScope = (scope) => typeof scope === 'string' && VALID_SCOPE.test(scope);

// 스코프 하위 파일 경로를 만들되, 스코프가 정상 형식이 아니면 예외를 던진다.
// path.join은 '..'을 정규화만 할 뿐 탈출을 막지 못하므로 형식 검증이 유일한 방어다.
function scopeFile(scope, ...parts) {
  if (!isValidScope(scope)) throw new Error(`잘못된 스코프: ${String(scope).slice(0, 40)}`);
  return path.join(DATA_DIR, scope, ...parts);
}

export function resolveScopes({ guildId, channelId, isPublic }) {
  if (!ID.test(channelId ?? '')) return null;

  if (!guildId) {
    const scope = `d-${channelId}`;
    return { write: scope, read: [scope] };
  }
  if (!ID.test(guildId)) return null;

  if (isPublic) {
    const scope = `g-${guildId}/public`;
    return { write: scope, read: [scope] };
  }
  const scope = `g-${guildId}/p-${channelId}`;
  return { write: scope, read: [`g-${guildId}/public`, scope] };
}

// 쓰는 도중 재시작해도 파일이 깨지지 않도록 임시 파일 → rename.
async function atomicWrite(file, data) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(tmp, data);
  await rename(tmp, file);
}

// 같은 파일에 대한 읽기-수정-쓰기를 직렬화한다.
// touchUser(메타 +1)와 saveUserMd(LLM 본문 저장)가 겹치면 한쪽이 유실되고,
// 로그는 append와 rewrite(만료 정리·forget)가 겹치면 줄이 사라질 수 있다.
const fileLocks = new Map();
function withLock(key, fn) {
  const prev = fileLocks.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  // 체인에 저장하는 것은 절대 reject되지 않는 꼬리다 — 호출자가 run의 실패를
  // 처리하더라도 맵에 남은 사본이 unhandled rejection을 내지 않게.
  let tail;
  tail = run.then(
    () => {
      if (fileLocks.get(key) === tail) fileLocks.delete(key);
    },
    () => {
      if (fileLocks.get(key) === tail) fileLocks.delete(key);
    },
  );
  fileLocks.set(key, tail);
  return run;
}

// 세션(단기 원문 + 요약 + 무드)도 스코프 단위다.
// 같은 서버의 공개 채널들은 하나의 대화를 이어간다 — 아바타는 하나이므로
// 채널을 옮겼다고 방금 한 이야기를 잊으면 안 된다.
const sessionPath = (scope) => scopeFile(scope, 'session.json');

export async function loadSession(scope) {
  try {
    return JSON.parse(await readFile(sessionPath(scope), 'utf8'));
  } catch {
    return null; // 없거나 깨진 파일은 빈 세션으로 시작
  }
}

export async function saveSession(scope, obj) {
  await atomicWrite(sessionPath(scope), JSON.stringify(obj, null, 2));
}

// ---- 장기기억 마크다운 ----
// 저장은 write 스코프 하나만 받는다(다중 기록 불가). 조회는 read 배열을 순회한다.

const userPath = (scope, uid) => scopeFile(scope, 'users', `${uid}.md`);
const scopePath = (scope) => scopeFile(scope, 'scope.md');

async function readText(file) {
  try {
    return await readFile(file, 'utf8');
  } catch {
    return '';
  }
}

// ---- 유저 md frontmatter ----
// 관계·만료 메타(affinity/interactions/lastSeen)는 백엔드 소유다.
// LLM에는 본문만 보여주고(loadUserMd), LLM이 쓴 본문은 메타를 보존한 채 저장한다(saveUserMd).
// 유저별 데이터를 파일 하나에 모아 /forget me·만료가 한 번에 끝나게 한다 (⑭ 선반영).

const FRONTMATTER = /^---\n([\s\S]*?)\n---\n?/;

export function splitUserMd(raw) {
  const m = raw.match(FRONTMATTER);
  if (!m) return { meta: {}, body: raw };
  const meta = {};
  for (const line of m[1].split('\n')) {
    const i = line.indexOf(':');
    if (i <= 0) continue;
    const key = line.slice(0, i).trim();
    const val = line.slice(i + 1).trim();
    // 숫자 필드는 숫자로. 날짜(lastSeen)는 Number()에 NaN이라 문자열로 남는다.
    meta[key] = val !== '' && !Number.isNaN(Number(val)) ? Number(val) : val;
  }
  return { meta, body: raw.slice(m[0].length) };
}

export function joinUserMd(meta, body) {
  const entries = Object.entries(meta);
  if (!entries.length) return body;
  return `---\n${entries.map(([k, v]) => `${k}: ${v}`).join('\n')}\n---\n${body}`;
}

const loadUserRaw = (scope, uid) =>
  ID.test(uid ?? '') ? readText(userPath(scope, uid)) : Promise.resolve('');

// 프롬프트·LLM 갱신용 본문. 메타는 노출하지 않는다.
export const loadUserMd = (scope, uid) =>
  loadUserRaw(scope, uid).then((raw) => splitUserMd(raw).body);

export const loadUserMeta = (scope, uid) =>
  loadUserRaw(scope, uid).then((raw) => splitUserMd(raw).meta);

// body는 LLM이 만든 본문. 기존 메타를 보존해 합친다.
export async function saveUserMd(scope, uid, body) {
  if (!ID.test(uid ?? '')) return;
  await withLock(userPath(scope, uid), async () => {
    const { meta } = splitUserMd(await loadUserRaw(scope, uid));
    // frontmatter를 항상 남긴다 — 메타 없이 저장하면 '---'로 시작하는 LLM 본문이
    // 다음 로드에서 frontmatter로 오인되어 통째로 사라질 수 있다.
    const safe = Object.keys(meta).length ? meta : { affinity: 0, interactions: 0 };
    await atomicWrite(userPath(scope, uid), joinUserMd(safe, body));
  });
}

const today = () => new Date().toISOString().slice(0, 10);

// ---- 관계 레이어 (⑭) ----
// 유저별 태도를 2축으로 읽는다: 호감(affinity, 저장) × 친숙함(interactions에서 파생).
// 저장 필드는 frontmatter 3개 그대로 — 친숙함은 계산이라 따로 저장하지 않는다.
const FAMILIAR_N = Number(process.env.RELATION_FAMILIAR_N ?? 15); // 이만큼 대화하면 '친숙'
const AFFINITY_FLOOR = Number(process.env.RELATION_AFFINITY_FLOOR ?? -0.3); // 적대 불가(방송인 컨셉)

// 사분면 단어. 중립+새 얼굴이면 null — 갓 만난 무색 관계까지 주입하지 않는다.
export function relationWord(meta) {
  const affinity = Number(meta?.affinity) || 0;
  const familiar = (Number(meta?.interactions) || 0) >= FAMILIAR_N;
  if (affinity >= 0.1) return familiar ? '오래 봐서 편한 단골' : '반갑고 호감 가는 사이';
  if (affinity <= -0.1) return familiar ? '자주 티격태격하는 사이' : '아직 서먹하고 조심스러운 사이';
  return familiar ? '자주 보는 사이' : null;
}

export const loadRelation = (scope, uid) =>
  loadUserMeta(scope, uid).then(relationWord);

// 대화 valence를 호감에 소량 EMA로 반영한다. 계수가 작고 하한이 있어(방송인)
// 조작(칭찬 연타로 단골 승격)이 안 된다. 쿨다운(3초)이 스팸도 막는다.
export async function bumpAffinity(scope, uid, delta) {
  if (!ID.test(uid ?? '') || !Number.isFinite(delta) || delta === 0) return;
  await withLock(userPath(scope, uid), async () => {
    const { meta, body } = splitUserMd(await loadUserRaw(scope, uid));
    const cur = Number(meta.affinity) || 0;
    const next = Math.min(1, Math.max(AFFINITY_FLOOR, cur + delta));
    meta.affinity = Number(next.toFixed(3));
    meta.interactions ??= 0;
    meta.lastSeen ??= today();
    await atomicWrite(userPath(scope, uid), joinUserMd(meta, body));
  });
}

// 발화할 때마다 호출 — 만료 기준(lastSeen)과 관계 레이어(⑭)의 재료를 쌓는다.
// affinity는 C단계까지 0으로 눕혀만 둔다.
export async function touchUser(scope, uid) {
  if (!ID.test(uid ?? '')) return;
  await withLock(userPath(scope, uid), async () => {
    const { meta, body } = splitUserMd(await loadUserRaw(scope, uid));
    meta.affinity ??= 0;
    meta.interactions = (Number(meta.interactions) || 0) + 1;
    meta.lastSeen = today();
    await atomicWrite(userPath(scope, uid), joinUserMd(meta, body));
  });
}

// async로 둔다 — scopeFile의 동기 throw(잘못된 스코프)를 Promise 거부로 바꿔
// 호출부의 await/.catch가 일관되게 잡게 한다(동기 throw는 .catch로 안 잡힌다).
export const loadScopeMd = async (scope) => readText(scopePath(scope));
export const saveScopeMd = async (scope, md) => atomicWrite(scopePath(scope), md);

// 관리자 소유 안내 지식 (docs/persona-plan.md 1장 — "이 서버의 봇들" 같은 것).
// scope.md와 분리하는 이유: scope.md는 Reflection이 append하고 상한 초과 시
// rethink가 재작성하는 캐릭터의 자동 기억이라, 사람이 써넣은 안내가 축약·소실될
// 수 있다. guide.md에는 어떤 자동 쓰기도 없다 — 사람만 편집한다.
// (/forget all은 스코프 디렉터리째 지우므로 guide.md도 죽는다 — 관리 권한자의 선택)
const guidePath = (scope) => scopeFile(scope, 'guide.md');
export const loadGuideMd = async (scope) => readText(guidePath(scope));

// ---- 캐릭터 자기 기억 (⑫, Mem0 agent 분리) ----
// 전역 1개 — 캐릭터는 하나다. 스코프 밖에 둔다.
//   쓰기: 공개 스코프(g-*/public)의 압축에서만. DM·비공개의 자기 결정은 새어나오면
//         안 되므로(격리 원칙 확장) 그 스코프의 scope.md에만 남는다.
//   읽기: 전 스코프 (프롬프트에 항상 주입).
// 개인 데이터가 없어야 하는 파일이다(자기 서술만) → /forget·만료 비대상.
// 강제는 2겹: 쓰기 스코프 제한(canWriteSelf, 공개만) + self 모드 검증(제3자·서버·
// 맥락 언급 차단, memguard checkCandidate mode:'self'). 검증은 소프트(LLM 판정)라
// 완벽하지 않으므로, 유출 파급이 큰 전역 파일임을 감안해 사람 검토도 권장.
const selfPath = () => path.join(DATA_DIR, 'self.md');
export const loadSelfMd = () => readText(selfPath());
export const saveSelfMd = (md) => withLock(selfPath(), () => atomicWrite(selfPath(), md));

// 공개 스코프만 self.md에 쓸 수 있다. g-<guild>/public 형태인지 검사.
export const canWriteSelf = (scope) => /^g-\d+\/public$/.test(scope ?? '');

export async function clearUser(scope, uid) {
  if (!ID.test(uid ?? '')) return false;
  try {
    // touchUser/saveUserMd의 읽기-수정-쓰기와 겹치지 않게 같은 락을 통과시킨다.
    await withLock(userPath(scope, uid), () => rm(userPath(scope, uid)));
    return true;
  } catch {
    return false;
  }
}

// 전 스코프에서 한 유저의 프로필·관계 데이터를 파기한다.
// 트리거: APPLICATION_DEAUTHORIZED 웹훅 (유저가 앱 접근권한 철회 — webhook-events.js).
// 개보법의 "동의 철회 시 지체 없는 파기"에 해당. 프로필·호감도는 users/<uid>.md
// 한 파일에 있고, log.jsonl은 보존기간(일 단위)으로 따로 자동 만료된다.
// 반환: 실제로 지운 파일 수.
export async function purgeUserEverywhere(uid) {
  if (!ID.test(uid ?? '')) return 0;

  // 스코프 열거는 디스크가 진실이다 — 세션 캐시에 없는 오래된 스코프도 지워야 한다.
  const scopes = [];
  let top = [];
  try {
    top = await readdir(DATA_DIR, { withFileTypes: true });
  } catch {
    return 0; // 데이터 디렉터리 자체가 없음 — 지울 것도 없다
  }
  for (const e of top) {
    if (!e.isDirectory()) continue;
    if (/^d-\d+$/.test(e.name)) scopes.push(e.name);
    else if (/^g-\d+$/.test(e.name)) {
      let subs = [];
      try {
        subs = await readdir(path.join(DATA_DIR, e.name), { withFileTypes: true });
      } catch {
        continue;
      }
      for (const s of subs) {
        if (s.isDirectory() && /^(public|p-\d+)$/.test(s.name)) scopes.push(`${e.name}/${s.name}`);
      }
    }
  }

  let removed = 0;
  for (const scope of scopes) {
    if (await clearUser(scope, uid)) removed++;
  }
  return removed;
}

export async function clearScope(scope) {
  try {
    if (!isValidScope(scope)) return false;
    await rm(path.join(DATA_DIR, scope), { recursive: true });
    return true;
  } catch {
    return false;
  }
}

export async function clearSession(scope) {
  try {
    await rm(sessionPath(scope));
    return true;
  } catch {
    return false;
  }
}

// ---- 원문 로그 (docs/memory-emotion-plan.md ①) ----
// 압축으로 세션에서 퇴출되는 턴의 원문 아카이브. 읽기 경로에는 쓰지 않는다.
// DM 포함 전 스코프 동일 취급, LOG_RETENTION_DAYS 지나면 자동 파기 (0이면 기능 꺼짐).

const logFile = (scope) => scopeFile(scope, 'log.jsonl');

export async function appendLog(scope, turns) {
  if (!LOG_RETENTION_DAYS || !turns.length) return;
  const lines = turns
    .map((t) =>
      JSON.stringify({
        // 옛 세션 파일의 턴에는 at이 없다 — 로그 시점으로 근사한다.
        t: t.at ?? new Date().toISOString(),
        role: t.role,
        uid: t.uid ?? null,
        author: t.author ?? null,
        content: t.content,
      }),
    )
    .join('\n');
  await withLock(logFile(scope), async () => {
    await mkdir(path.dirname(logFile(scope)), { recursive: true });
    await appendFile(logFile(scope), lines + '\n');
  });
}

async function rewriteLog(scope, keep) {
  await withLock(logFile(scope), async () => {
    const raw = await readText(logFile(scope));
    if (!raw) return;
    const kept = raw
      .split('\n')
      .filter(Boolean)
      .filter((line) => {
        try {
          return keep(JSON.parse(line));
        } catch {
          return false; // 깨진 줄은 복구할 수 없으니 버린다
        }
      });
    if (!kept.length) {
      await rm(logFile(scope)).catch(() => {});
      return;
    }
    await atomicWrite(logFile(scope), kept.join('\n') + '\n');
  });
}

// 보존기간 지난 줄 제거. 기능이 꺼져 있으면(0) 남아 있던 로그도 지운다.
export async function purgeLog(scope) {
  if (!LOG_RETENTION_DAYS) {
    await rm(logFile(scope)).catch(() => {});
    return;
  }
  const cutoff = Date.now() - LOG_RETENTION_DAYS * 86_400_000;
  await rewriteLog(scope, (entry) => Date.parse(entry.t) >= cutoff);
}

// /forget me — 로그에서 그 사람의 발화 줄만 제거한다 (아바타 응답 줄은 유지).
export const stripUserFromLog = (scope, uid) =>
  ID.test(uid ?? '') ? rewriteLog(scope, (entry) => entry.uid !== uid) : Promise.resolve();

// /forget here — 대화를 잊는 약속에는 원문 로그도 포함된다.
// append가 진행 중일 수 있으므로 같은 락을 통과시킨다 (삭제 직후 부활 방지).
export const clearLog = (scope) =>
  withLock(logFile(scope), () => rm(logFile(scope))).catch(() => {});

// ---- 보존기간 일괄 정리 ----
// 기동 시 + 하루 한 번: 전 스코프의 로그 만료분과, 오래 안 본 유저 md를 파기한다.
// (개보법 제21조 — 자동 만료형 보존. docs/privacy-plan.md)

async function listScopes() {
  const scopes = [];
  let top = [];
  try {
    top = await readdir(DATA_DIR, { withFileTypes: true });
  } catch {
    return scopes;
  }
  for (const entry of top) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('d-')) {
      scopes.push(entry.name);
    } else if (entry.name.startsWith('g-')) {
      const subs = await readdir(path.join(DATA_DIR, entry.name), { withFileTypes: true }).catch(() => []);
      for (const sub of subs) {
        if (sub.isDirectory()) scopes.push(path.join(entry.name, sub.name));
      }
    }
  }
  return scopes;
}

async function expireProfiles(scope) {
  if (!PROFILE_RETENTION_MONTHS) return 0;
  const dir = path.join(DATA_DIR, scope, 'users');
  const files = await readdir(dir).catch(() => []);
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - PROFILE_RETENTION_MONTHS);
  cutoff.setHours(0, 0, 0, 0); // lastSeen은 날짜뿐이라 시각까지 비교하면 하루 이르게 지운다
  let removed = 0;
  for (const file of files) {
    if (!file.endsWith('.md')) continue;
    const filePath = path.join(dir, file);
    const { meta } = splitUserMd(await readText(filePath));
    if (!meta.lastSeen) {
      // frontmatter 도입 전 파일 — 오늘부터 시계를 돌린다 (기록 없는 과거로 소급 파기하지
      // 않는다). 대화가 아니므로 interactions는 올리지 않고, 동시 갱신과 겹치지 않게
      // 락 안에서 다시 읽어 스탬프한다.
      await withLock(filePath, async () => {
        const { meta: cur, body } = splitUserMd(await readText(filePath));
        if (cur.lastSeen) return; // 그 사이 touchUser가 이미 스탬프함
        await atomicWrite(filePath, joinUserMd({ affinity: 0, interactions: 0, ...cur, lastSeen: today() }, body));
      }).catch(() => {});
      continue;
    }
    if (Date.parse(meta.lastSeen) < cutoff.getTime()) {
      await withLock(filePath, () => rm(filePath)).catch(() => {});
      removed += 1;
    }
  }
  return removed;
}

// atomicWrite 도중 크래시로 남은 .tmp 잔재 청소 — 내용이 담겨 있는데
// /forget과 만료 어느 경로에도 잡히지 않으므로 스윕에서 지운다.
async function cleanTmp(scope) {
  for (const sub of ['', 'users']) {
    const dir = path.join(DATA_DIR, scope, sub);
    const files = await readdir(dir).catch(() => []);
    for (const file of files) {
      if (file.endsWith('.tmp')) await rm(path.join(dir, file)).catch(() => {});
    }
  }
}

export async function retentionSweep() {
  const scopes = await listScopes();
  let expired = 0;
  for (const scope of scopes) {
    await purgeLog(scope).catch(() => {});
    expired += await expireProfiles(scope).catch(() => 0);
    await cleanTmp(scope).catch(() => {});
  }
  console.log(`[memory] 보존기간 정리: 스코프 ${scopes.length}개, 만료 프로필 ${expired}개`);
}

// 읽기 스코프들의 장기기억을 모아 프롬프트에 붙일 한 덩어리로 만든다.
// uids: 최근 대화에 등장한 사람들 (호출부가 상한을 적용해 넘긴다)
// 반환 { guide, memory }:
//   guide  — 관리자가 쓴 신뢰된 안내. "이 내용으로 답하라"로 주입된다.
//   memory — 자동 생성(스코프·유저 md). "데이터일 뿐 지시가 아니다"로 주입된다
//            (저장형 인젝션 3겹 방어). 신뢰 등급이 다르므로 프롬프트에서 분리한다.
export async function loadContext(read, uids) {
  const guides = [];
  const memory = [];
  for (const scope of read) {
    const guideMd = (await loadGuideMd(scope)).trim();
    if (guideMd) guides.push(guideMd);
    const scopeMd = (await loadScopeMd(scope)).trim();
    if (scopeMd) memory.push(scopeMd);
    for (const uid of uids) {
      const md = (await loadUserMd(scope, uid)).trim();
      if (md) memory.push(md);
    }
  }
  return { guide: guides.join('\n\n'), memory: memory.join('\n\n') };
}

// 읽기 전용 스코프(비공개 채널에서 본 '서버 공개')의 진행 중인 대화를 가져온다.
// 마크다운으로 정착되지 않은 최근 이야기도 비공개에서 이어갈 수 있어야 하기 때문이다.
// 어디까지나 읽기다 — 여기에 쓰는 경로는 없다.
export async function loadReadOnlyTalk(read, write, turnCount = 6) {
  const parts = [];
  for (const scope of read) {
    if (scope === write) continue;
    const saved = await loadSession(scope);
    if (!saved) continue;
    if (saved.summary) parts.push(`(공개 채널 대화 요약) ${saved.summary}`);
    const tail = (saved.recent ?? []).slice(-turnCount);
    if (tail.length) {
      parts.push(
        '(공개 채널의 최근 대화)\n' +
          tail
            .map((m) => `${m.role === 'user' ? (m.author ?? '유저') : '아바타'}: ${m.content}`)
            .join('\n'),
      );
    }
  }
  return parts.join('\n\n');
}

// 접근 통제: 누가 어디서 말할 수 있는가.
//
// 두 종류의 접속을 구분한다.
//
//   내부망 — 같은 미니PC/LAN. 개발·테스트용. 인증 없이 허용한다.
//            Caddy를 거쳐 들어온 외부 요청은 X-Forwarded-For에 공인 IP가 실리므로
//            내부망으로 위장할 수 없다.
//   외부망 — Discord Activity iframe. 다음을 **모두** 통과해야 연결이 유지된다.
//            1) Origin이 https://<appId>.discordsays.com
//            2) access_token을 Discord에 물어 신원 확인 (위조 불가)
//            3) 허용목록에 있는 사용자
//            하나라도 실패하면 스냅샷·브로드캐스트를 일절 주지 않고 즉시 끊는다.

import { isIP } from 'node:net';

const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
// 디스코드 봇 모드 여부 = DISCORD_TOKEN 존재. web 모드(토큰 없음)에서는 Activity
// iframe 오리진(discordsays.com)을 아예 허용 목록에 넣지 않는다 — 남는 출입구는
// LAN과 EXTRA_ORIGINS뿐이다.

const ALLOWED_ORIGINS = new Set(
  [
    process.env.DISCORD_TOKEN && CLIENT_ID && `https://${CLIENT_ID}.discordsays.com`,
    ...(process.env.EXTRA_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  ].filter(Boolean),
);

const list = (name) =>
  new Set((process.env[name] ?? '').split(',').map((s) => s.trim()).filter(Boolean));
const ALLOWED_GUILDS = list('ALLOWED_GUILDS');
const ALLOWED_USERS = list('ALLOWED_USERS');

// 내부망 접속을 허용할지. 테스트 전용이므로 운영에서도 켜둘 만하지만,
// 봇을 외부에 노출된 호스트로 옮기면 꺼야 한다.
const ALLOW_LAN = process.env.ALLOW_LAN !== '0';

// 내부망에서 접속한 사람에게 부여할 신원. 테스트 세션이 실제 사용자와
// 섞이지 않도록 별도 uid를 쓴다.
const LAN_USER_ID = (process.env.LAN_USER_ID ?? '').trim();
const LAN_USER_NAME = (process.env.LAN_USER_NAME ?? '테스터').trim();

const lanUser =
  ALLOW_LAN && /^\d+$/.test(LAN_USER_ID)
    ? { id: LAN_USER_ID, name: LAN_USER_NAME.slice(0, 32), lan: true }
    : null;

// ---- 내부망 판정 ----

function toV4(ip) {
  if (!ip) return null;
  // ::ffff:192.168.0.5 형태를 벗겨낸다
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  return m ? m[1] : ip;
}

export function isPrivateAddress(rawIp) {
  const ip = toV4(rawIp);
  if (!ip) return false;
  if (ip === '::1' || ip === '127.0.0.1') return true;
  if (isIP(ip) === 6) return /^(fc|fd|fe80)/i.test(ip); // ULA·링크로컬
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => Number.isNaN(n))) return false;
  if (p[0] === 10 || p[0] === 127) return true;
  if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
  if (p[0] === 192 && p[1] === 168) return true;
  return false;
}

// 요청이 내부망에서 왔는가.
//
// **첫 항목을 믿으면 안 된다.** X-Forwarded-For는 클라이언트가 임의로 보낼 수 있고,
// 프록시는 거기에 덧붙일 뿐이다. 외부 공격자가 `XFF: 192.168.0.50`을 보내면
// Caddy를 거친 뒤 "192.168.0.50, <공인IP>, <caddy IP>"가 되어 첫 항목은 사설이다.
//
// 대신 **모든 항목이 사설이어야** 내부망으로 인정한다. 공격자는 앞에 가짜를
// 끼워 넣을 수는 있어도, 프록시가 덧붙인 자기 공인 IP를 지울 수는 없다.
export function isLanRequest(req) {
  if (!ALLOW_LAN) return false;
  if (!isPrivateAddress(req.socket?.remoteAddress)) return false;

  const xff = req.headers['x-forwarded-for'];
  if (!xff) return true; // 프록시를 거치지 않은 직접 연결

  const hops = String(xff)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return hops.every(isPrivateAddress);
}

export function checkOrigin(origin) {
  return ALLOWED_ORIGINS.has(origin);
}

// iframe이 신고한 uid를 믿지 않고 토큰으로 직접 확인한다.
// /users/@me 대신 /oauth2/@me를 쓴다 — 후자는 토큰을 발급한 application.id를 함께
// 준다. 이걸 우리 CLIENT_ID와 대조해 **우리 앱이 발급한 토큰만** 통과시킨다.
// (그냥 /users/@me면 공격자가 자기 OAuth 앱으로 발급한 임의 토큰도 소유자를 반환해
//  통과한다 — 보안감사 confirmed #1의 전제. application 검증으로 이 우회를 끊는다.)
export async function verifyUser(accessToken) {
  if (!accessToken || typeof accessToken !== 'string') return null;
  try {
    const res = await fetch('https://discord.com/api/v10/oauth2/@me', {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const info = await res.json();
    // 우리 앱이 발급한 토큰인가. CLIENT_ID 미설정(개발)이면 이 검증은 건너뛴다.
    if (CLIENT_ID && info.application?.id !== CLIENT_ID) return null;
    const u = info.user;
    if (!u || !/^\d+$/.test(u.id ?? '')) return null;
    return { id: u.id, name: String(u.global_name || u.username || '시청자').slice(0, 32) };
  } catch {
    return null;
  }
}

// 허용목록 정책:
//   - 두 목록이 모두 비어 있으면 전체 허용 (개발 초기용. 배포 전에 채울 것)
//   - ALLOWED_USERS의 사용자는 어디서든(DM 포함) 사용 가능
//   - ALLOWED_GUILDS의 서버에서는 그 멤버 누구나 사용 가능
//   - 그 외는 거부 — DM Activity에 초대받은 제3자도 여기서 걸린다
export function isAllowed({ guildId, userId }) {
  if (!ALLOWED_GUILDS.size && !ALLOWED_USERS.size) return true;
  if (userId && ALLOWED_USERS.has(userId)) return true;
  if (guildId && ALLOWED_GUILDS.has(guildId)) return true;
  return false;
}

export const lanIdentity = () => lanUser;

export const config = {
  origins: [...ALLOWED_ORIGINS],
  allowLan: ALLOW_LAN,
  lanUser: lanUser?.id ?? null,
  guilds: ALLOWED_GUILDS.size,
  users: ALLOWED_USERS.size,
};

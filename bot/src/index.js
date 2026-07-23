import { Client, GatewayIntentBits, Events, PermissionFlagsBits, EntryPointCommandHandlerType } from 'discord.js';
import { createBus } from './bus.js';
import { createSessions } from './sessions.js';
import { createOAuthServer } from './oauth.js';
import { isAllowed } from './identity.js';
import { retentionSweep } from './memory.js';

const token = process.env.DISCORD_TOKEN;
const BUS_PORT = Number(process.env.BUS_PORT ?? 8080);
const OAUTH_PORT = Number(process.env.OAUTH_PORT ?? 8081);

createOAuthServer(OAUTH_PORT);

// 보존기간 정리 (개보법 제21조 자동 만료 — docs/privacy-plan.md 4장).
// 기동 직후 한 번 + 하루 한 번: 만료된 원문 로그 줄과 오래 안 본 유저 md를 파기한다.
retentionSweep().catch((err) => console.error('[memory] 보존기간 정리 실패:', err.message));
setInterval(
  () => retentionSweep().catch((err) => console.error('[memory] 보존기간 정리 실패:', err.message)),
  24 * 60 * 60 * 1000,
).unref();

let client = null;

// 공개/비공개 판정: @everyone이 그 채널을 볼 수 있는가 (설계 2.4).
// 판정 불가(미로그인·fetch 실패)면 비공개 취급 — 격리가 과해지는 쪽이 안전하다.
const publicCache = new Map(); // channelId -> boolean

function isChannelPublic(channel) {
  if (!channel?.guild) return false;
  const cached = publicCache.get(channel.id);
  if (cached !== undefined) return cached;
  const result =
    channel.permissionsFor(channel.guild.roles.everyone)?.has(PermissionFlagsBits.ViewChannel) ??
    false;
  publicCache.set(channel.id, result);
  return result;
}

// iframe 경로: channelId/guildId만 있으므로 채널을 조회해 판정한다.
// publicHint는 개발용 우회 연결에서만 전달된다(bus.js 참고).
//
// userId가 주어지면(hello 시점 접근 통제) 3단 검증을 한다 (docs/access-policy.md):
//   1) 길드 멤버십 — 봇 REST GET member. 비멤버(404)면 거부.
//   2) 채널 열람 권한 — permissionsFor(member).ViewChannel(음성이면 Connect도).
//      "같은 길드지만 그 비공개 채널을 못 보는 멤버"를 차단한다.
//   3) DM(guildId 없음)은 게이팅 수단이 없으므로 거부한다.
// verified=true는 세 관문을 다 통과했다는 뜻 — bus가 이걸로 입장을 허용한다.
// userId 없이 부르면(onPrompt: 이미 통과한 유저의 스코프 판정) 채널·guildId만 도출한다.
async function resolveCtx(channelId, guildId, publicHint, userId) {
  if (publicHint !== undefined) {
    // LAN 개발 경로 — 망 위치로 통제되므로 Discord 검증을 타지 않는다.
    return { channelId, guildId: guildId ?? null, isPublic: publicHint, verified: false };
  }
  const deny = { channelId, guildId: null, isPublic: false, verified: false };
  if (!client?.isReady() || !channelId) return deny;

  let channel;
  try {
    channel = await client.channels.fetch(channelId);
  } catch {
    return deny; // 봇이 접근할 수 없는 채널
  }
  const gid = channel?.guildId ?? null;
  if (!gid) return deny; // DM/그룹DM — 길드 컨텍스트 없음 → 차단 (정책)
  const isPublic = isChannelPublic(channel);

  // userId 없으면 여기까지 (스코프 판정용). 접근 통제는 hello 시점에만 한다.
  if (!userId) return { channelId, guildId: gid, isPublic, verified: false };

  let member;
  try {
    member = await channel.guild.members.fetch(userId); // 단건 REST — intent 불필요, 비멤버는 throw
  } catch {
    return { channelId, guildId: gid, isPublic, verified: false }; // 비멤버
  }
  const perms = channel.permissionsFor(member);
  if (!perms?.has(PermissionFlagsBits.ViewChannel)) {
    return { channelId, guildId: gid, isPublic, verified: false }; // 채널 열람권 없음(비공개 차단)
  }
  if (channel.isVoiceBased?.() && !perms.has(PermissionFlagsBits.Connect)) {
    return { channelId, guildId: gid, isPublic, verified: false }; // 음성 입장권 없음
  }
  return { channelId, guildId: gid, isPublic, verified: true };
}

const bus = createBus(BUS_PORT, {
  // iframe 입력창 경로. bus가 토큰으로 신원을 확인한 뒤에만 여기까지 온다.
  onPrompt: async (channelId, guildId, text, user, publicHint) => {
    const ctx = await resolveCtx(channelId ?? 'standalone', guildId, publicHint);
    // bus가 이미 허용목록을 통과시킨 사용자만 여기 온다. 비용 가드만 추가로 본다.
    const result = sessions.submit(ctx, user.name, text, null, user.id);
    return result; // bus가 클라이언트에 거부 사유를 알린다
  },
  // 대화 도중 합류한 iframe에게 현재 상태를 넘겨준다.
  onHello: (channelId) => sessions.snapshot(channelId ?? 'standalone'),
  // 외부 사용자 hello 시 접근 통제(멤버십·채널 열람권·DM 차단)를 서버가 직접 수행한다.
  resolveContext: (channelId, guildId, userId) => resolveCtx(channelId, guildId, undefined, userId),
});
const sessions = createSessions(bus);

if (!token) {
  console.log('[bot] web 모드 — 디스코드 미접속. 오리진은 LAN·EXTRA_ORIGINS만 활성.');
} else {
  // 슬래시 커맨드만 쓰므로 privileged intent가 필요 없다.
  client = new Client({ intents: [GatewayIntentBits.Guilds] });

  const commands = [
    {
      name: 'say',
      description: '아바타에게 말을 겁니다',
      options: [
        { type: 3, name: 'text', description: '할 말', required: true, max_length: 500 },
      ],
    },
    {
      name: 'forget',
      description: '아바타의 기억을 지웁니다',
      options: [
        {
          type: 3,
          name: 'scope',
          description: '무엇을 지울지 (기본: 나에 대한 기억)',
          required: false,
          choices: [
            { name: '나에 대한 기억', value: 'me' },
            { name: '지금 하던 대화만', value: 'here' },
            { name: '이 자리의 기억 전부', value: 'all' },
          ],
        },
      ],
    },
    {
      name: 'launcher',
      description: '이 채널에 마루 실행 버튼을 고정합니다 (관리자용)',
      // 서버 관리 권한자만 런처를 게시할 수 있다.
      default_member_permissions: String(PermissionFlagsBits.ManageGuild),
    },
  ];

  // 고정 런처의 버튼 custom_id. 클릭 시 이 id로 인터랙션이 온다.
  const LAUNCH_BTN = 'marou-launch';

  const ENTRY_POINT = 4; // PRIMARY_ENTRY_POINT — Activities를 켜면 Portal이 자동 생성한다

  client.once(Events.ClientReady, async (c) => {
    console.log(`[bot] 로그인 완료: ${c.user.tag}`);
    // DEV_GUILD_ID가 있으면 그 서버에만 등록(즉시 반영), 없으면 전역(전파 지연 있음)
    const devGuild = process.env.DEV_GUILD_ID;
    try {
      // 일괄 등록은 빠진 커맨드를 지운다. Entry Point 커맨드를 지우는 건
      // Discord가 거부하므로(50240) 기존 것을 그대로 실어 보낸다.
      const existing = await c.application.commands.fetch({ guildId: devGuild || undefined });
      const keep = existing.filter((cmd) => cmd.type === ENTRY_POINT).map((cmd) => cmd.toJSON());
      await c.application.commands.set([...keep, ...commands], devGuild || undefined);
      console.log(
        `[bot] /say 등록 완료 (${devGuild ? `guild ${devGuild}` : '전역'})` +
          (keep.length ? `, Entry Point ${keep.length}개 보존` : ''),
      );

      // Entry Point 커맨드 handler를 APP_HANDLER로 바꾼다 — 자동 "실행" 커맨드·VC 피커·
      // App Launcher로 실행하면 봇이 인터랙션을 받아 고정 런처 버튼으로 유도한다(a안).
      // 벌크(set)는 50240 위험이라 handler만 개별 PATCH로 바꾼다.
      for (const cmd of existing.filter((c2) => c2.type === ENTRY_POINT).values()) {
        if (cmd.handler === EntryPointCommandHandlerType.AppHandler) continue;
        try {
          await c.application.commands.edit(
            cmd.id,
            { handler: EntryPointCommandHandlerType.AppHandler },
            devGuild || undefined,
          );
          console.log(`[bot] Entry Point handler → APP_HANDLER (${cmd.id})`);
        } catch (err) {
          console.error('[bot] Entry Point handler 변경 실패:', err.message);
        }
      }
    } catch (err) {
      console.error('[bot] 커맨드 등록 실패:', err.message);
    }
  });

  // 채널 권한이 바뀌면 공개/비공개 판정을 다시 한다
  client.on(Events.ChannelUpdate, (_old, channel) => publicCache.delete(channel.id));

  // 고정 런처 버튼 클릭 — 허용된 사용자에게만 Activity를 연다(봇이 매개).
  // 여기서 걸러진 사람은 빈 셸조차 안 열린다(WS 인증이 최종선이지만, UX상 여기서 먼저).
  async function handleLaunchButton(interaction) {
    // interaction.guildId·member는 Discord가 서명한 신뢰값이다(iframe 신고값 아님).
    if (!interaction.guildId) {
      await interaction.reply({ content: '서버 채널에서만 실행할 수 있어.', ephemeral: true });
      return;
    }
    if (!isAllowed({ guildId: interaction.guildId, userId: interaction.user.id })) {
      await interaction.reply({ content: '아직 여기서는 나를 쓸 수 없어. (허용된 서버·사용자만)', ephemeral: true });
      return;
    }
    // 채널 열람권 확인 — 비공개 채널을 못 보는 멤버가 런처로 우회 실행하는 걸 막는다.
    const perms = interaction.channel?.permissionsFor(interaction.member);
    if (!perms?.has(PermissionFlagsBits.ViewChannel)) {
      await interaction.reply({ content: '이 채널에서는 실행할 수 없어.', ephemeral: true });
      return;
    }
    try {
      await interaction.launchActivity(); // LAUNCH_ACTIVITY (콜백 12)
    } catch (err) {
      console.error('[launcher] 실행 실패:', err.message);
      // 이미 응답했을 수 있으니 조용히 넘어간다.
    }
  }

  client.on(Events.InteractionCreate, async (interaction) => {
    if (interaction.isButton() && interaction.customId === LAUNCH_BTN) {
      return handleLaunchButton(interaction);
    }
    // Entry Point("실행" 커맨드·VC 피커·App Launcher)로 실행 시도 — 봇이 가로채
    // 고정 런처 버튼으로 유도한다(a안: 버튼이 유일 실행 경로). Activity는 열지 않는다.
    if (interaction.isPrimaryEntryPointCommand?.()) {
      await interaction.reply({
        content: '여기서 바로는 못 열어. 채널에 고정된 **🎮 마루 실행** 버튼을 눌러줘! (없으면 관리자에게 /launcher 요청)',
        ephemeral: true,
      }).catch(() => {});
      return;
    }
    if (!interaction.isChatInputCommand()) return;

    const author = interaction.user.displayName ?? interaction.user.username;
    const ctx = {
      channelId: interaction.channelId,
      guildId: interaction.guildId,
      isPublic: isChannelPublic(interaction.channel),
    };

    // 런처 게시 — 관리자(default_member_permissions=ManageGuild)만. 이 채널에 실행
    // 버튼을 올리고 고정한다. allowlist 게이트 앞에 둔다(관리 작업이라 별개).
    if (interaction.commandName === 'launcher') {
      const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = await import('discord.js');
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(LAUNCH_BTN).setLabel('🎮 마루 실행').setStyle(ButtonStyle.Primary),
      );
      try {
        const msg = await interaction.channel.send({
          content: '아래 버튼을 눌러 마루를 실행해요.',
          components: [row],
        });
        await msg.pin().catch(() => {}); // 고정 권한 없으면 게시만 하고 넘어간다
        await interaction.reply({ content: '런처를 게시했어요.', ephemeral: true });
      } catch (err) {
        console.error('[launcher] 게시 실패:', err.message);
        await interaction.reply({ content: '런처 게시에 실패했어. (메시지 전송 권한 확인)', ephemeral: true }).catch(() => {});
      }
      return;
    }

    // 허용목록 — /say, /forget 모두 여기서 걸린다.
    // 봇 초대 링크만 있으면 아무 서버·DM에서 LLM/TTS를 태울 수 있던 구멍을 막는다.
    // DM Activity에 초대받은 제3자도 자기 uid가 목록에 없으면 여기서 거부된다.
    if (!isAllowed({ guildId: interaction.guildId, userId: interaction.user.id })) {
      await interaction.reply({
        content: '아직 여기서는 나를 쓸 수 없어. (허용된 서버·사용자만 이용할 수 있어요)',
        ephemeral: true,
      });
      return;
    }

    if (interaction.commandName === 'say') {
      const text = interaction.options.getString('text', true);
      // LLM이 느려질 수 있으니 미리 defer. 응답은 큐 순서대로 editReply로 나간다.
      await interaction.deferReply();
      const result = sessions.submit(
        ctx, author, text,
        (answer) => interaction.editReply(answer),
        interaction.user.id,
      );
      // 비용 가드에 걸리면 큐에 안 들어갔으므로 여기서 응답을 마무리한다.
      if (!result.ok) {
        const msg =
          result.reason === 'cooldown'
            ? `조금만 천천히… (${Math.ceil(result.waitMs / 1000)}초 뒤에 다시)`
            : '지금 대답할 게 밀려 있어. 잠깐 뒤에 다시 말 걸어줘.';
        await interaction.editReply(msg);
      }
      return;
    }

    if (interaction.commandName === 'forget') {
      const scope = interaction.options.getString('scope') ?? 'me';
      // 자리 전체를 지우는 건 파급이 크므로 서버 관리 권한을 요구한다.
      if (scope === 'all' && interaction.guildId) {
        const canManage = interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild);
        if (!canManage) {
          await interaction.reply({
            content: '이 자리의 기억을 전부 지우려면 서버 관리 권한이 필요해.',
            ephemeral: true,
          });
          return;
        }
      }
      await interaction.deferReply({ ephemeral: scope === 'me' });
      const msg = await sessions.forget(ctx, interaction.user.id, scope);
      await interaction.editReply(msg);
    }
  });

  try {
    await client.login(token);
  } catch (err) {
    console.error('[bot] 로그인 실패:', err.message);
    console.error('[bot] 버스는 계속 동작합니다.');
    client = null;
  }
}

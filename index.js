// index.js
require('dotenv').config();
const {
  Client, GatewayIntentBits, Partials, REST, Routes,
  SlashCommandBuilder, PermissionFlagsBits, PermissionsBitField,
  AttachmentBuilder, Events
} = require('discord.js');
const Database = require('better-sqlite3');

// ====== CLIENTE
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildVoiceStates,
  ],
  partials: [Partials.GuildMember],
});

// ====== DB
const db = new Database('presencia.db');
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  channel_id TEXT,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  source TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id, guild_id, started_at);

CREATE TABLE IF NOT EXISTS schedules (
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  work_start_min INTEGER NOT NULL,
  work_end_min INTEGER NOT NULL,
  PRIMARY KEY (guild_id, user_id)
);

CREATE TABLE IF NOT EXISTS breaks (
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  break_start_min INTEGER NOT NULL,
  break_end_min INTEGER NOT NULL,
  PRIMARY KEY (guild_id, user_id)
);

CREATE TABLE IF NOT EXISTS viewers (
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  PRIMARY KEY (guild_id, user_id)
);
`);

const q = {
  startSession: db.prepare(`
    INSERT INTO sessions (guild_id, user_id, channel_id, started_at, source)
    VALUES (@guild_id,@user_id,@channel_id,@started_at,@source)
  `),
  endOpenSessions: db.prepare(`
    UPDATE sessions SET ended_at=@ended_at
    WHERE guild_id=@guild_id AND user_id=@user_id AND ended_at IS NULL
  `),
  getOpenSessions: db.prepare(`
    SELECT * FROM sessions
    WHERE guild_id=@guild_id AND user_id=@user_id AND ended_at IS NULL
    ORDER BY started_at ASC
  `),
  endSpecificSession: db.prepare(`
    UPDATE sessions SET ended_at=@ended_at
    WHERE id=@id AND ended_at IS NULL
  `),
  listSessionsInRange: db.prepare(`
    SELECT * FROM sessions
    WHERE guild_id=@guild_id
      AND started_at < @to
      AND (ended_at IS NULL OR ended_at > @from)
      AND (@user_id IS NULL OR user_id=@user_id)
    ORDER BY user_id, started_at
  `),
  upsertSchedule: db.prepare(`
    INSERT INTO schedules (guild_id,user_id,work_start_min,work_end_min)
    VALUES (@guild_id,@user_id,@work_start_min,@work_end_min)
    ON CONFLICT(guild_id,user_id) DO UPDATE SET
      work_start_min=excluded.work_start_min,
      work_end_min=excluded.work_end_min
  `),
  getSchedule: db.prepare(`SELECT * FROM schedules WHERE guild_id=@guild_id AND user_id=@user_id`),
  upsertBreak: db.prepare(`
    INSERT INTO breaks (guild_id,user_id,break_start_min,break_end_min)
    VALUES (@guild_id,@user_id,@break_start_min,@break_end_min)
    ON CONFLICT(guild_id,user_id) DO UPDATE SET
      break_start_min=excluded.break_start_min,
      break_end_min=excluded.break_end_min
  `),
  getBreak: db.prepare(`SELECT * FROM breaks WHERE guild_id=@guild_id AND user_id=@user_id`),
  addViewer: db.prepare(`INSERT OR IGNORE INTO viewers (guild_id,user_id) VALUES (@guild_id,@user_id)`),
  removeViewer: db.prepare(`DELETE FROM viewers WHERE guild_id=@guild_id AND user_id=@user_id`),
  listViewers: db.prepare(`SELECT user_id FROM viewers WHERE guild_id=@guild_id`),
  isViewer: db.prepare(`SELECT 1 FROM viewers WHERE guild_id=@guild_id AND user_id=@user_id`),
};

// ====== UTILS
const MS = 1000, MIN = 60 * MS, H = 60 * MIN;

function dayStart(ms) { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); }
function overlap(a1, a2, b1, b2) { return Math.max(0, Math.min(a2, b2) - Math.max(a1, b1)); }
function fmtHMS(ms) {
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return `${h.toString().padStart(2,'0')}:${m.toString().padStart(2,'0')}:${s.toString().padStart(2,'0')}`;
}
function toMinutes(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm || '');
  if (!m) return null;
  const h = +m[1], mi = +m[2];
  if (h < 0 || h > 23 || mi < 0 || mi > 59) return null;
  return h * 60 + mi;
}
function minutesToHHMM(minTotal) {
  const h = Math.floor(minTotal / 60), m = minTotal % 60;
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
}
function isAdmin(member) {
  try {
    if (!member?.permissions) return false;
    const p = member.permissions instanceof PermissionsBitField
      ? member.permissions
      : new PermissionsBitField(member.permissions);
    return p.has(PermissionFlagsBits.Administrator) || p.has(PermissionFlagsBits.ManageGuild);
  } catch { return false; }
}
function isAllowedViewer(gid, uid) { return !!q.isViewer.get({ guild_id: gid, user_id: uid }); }

// -------- Zona horaria consistente (LOCAL configurable)
const TIMEZONE = process.env.TIMEZONE || 'America/Lima';
const LOCALE = process.env.LOCALE || 'es-PE';

function fmtLocal(ms) {
  return new Intl.DateTimeFormat(LOCALE, {
    timeZone: TIMEZONE,
    dateStyle: 'short',
    timeStyle: 'medium',
    hour12: false
  }).format(new Date(ms));
}
function fmtLocalDate(ms) {
  return new Intl.DateTimeFormat(LOCALE, {
    timeZone: TIMEZONE,
    day: '2-digit', month: '2-digit', year: 'numeric'
  }).format(new Date(ms));
}
function fmtLocalTime(ms) {
  return new Intl.DateTimeFormat(LOCALE, {
    timeZone: TIMEZONE,
    hour: '2-digit', minute: '2-digit'
  }).format(new Date(ms));
}

// Fechas: soporta -7d/-12h/-30m, ISO, y DD/MM/YYYY
function parseDateOrRel(input, asEnd = false, fallback = null) {
  if (!input) return fallback;
  const rel = input.match(/^-(\d+)([dhm])$/i);
  if (rel) {
    const n = +rel[1], u = rel[2].toLowerCase(), now = Date.now();
    if (u === 'd') return now - n * 24 * H;
    if (u === 'h') return now - n * H;
    if (u === 'm') return now - n * MIN;
  }
  const dmy = input.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (dmy) {
    const d = new Date(+dmy[3], +dmy[2] - 1, +dmy[1], 0, 0, 0, 0);
    return asEnd ? (d.getTime() + 24 * H) : d.getTime();
  }
  const t = Date.parse(input);
  if (!Number.isNaN(t)) return t;
  return fallback;
}

// Devuelve segmentos facturables por día aplicando horario/break
function billableByDay(userId, guildId, segStart, segEnd) {
  const out = [];
  const sch = q.getSchedule.get({ guild_id: guildId, user_id: userId });
  const br = q.getBreak.get({ guild_id: guildId, user_id: userId });
  const workStart = sch ? sch.work_start_min : 0;
  const workEnd   = sch ? sch.work_end_min   : 24 * 60;
  const hasSchedule = !!sch, hasBreak = !!br;

  let cursor = segStart;
  while (cursor < segEnd) {
    const dStart = dayStart(cursor), dEnd = dStart + 24 * H;
    const s = Math.max(cursor, dStart);
    const e = Math.min(segEnd, dEnd);

    const ws = dStart + workStart * MIN, we = dStart + workEnd * MIN;
    let bill = hasSchedule ? overlap(s, e, ws, we) : (e - s);

    if (hasBreak && bill > 0) {
      const bs = dStart + br.break_start_min * MIN, be = dStart + br.break_end_min * MIN;
      bill -= overlap(s, e, bs, be);
      if (bill < 0) bill = 0;
    }
    if (bill > 0) out.push({ day: dStart, start: s, end: e, ms: bill });
    cursor = e;
  }
  return out;
}

// Agregación pura (sin texto) por usuario/canal/día
function aggregatePure(guildId, from, to, userIdOrNull) {
  let rows = [];
  try {
    rows = q.listSessionsInRange.all({ guild_id: guildId, from, to, user_id: userIdOrNull });
  } catch (e) { console.error('SQLite listSessionsInRange:', e); rows = []; }

  const perUser = new Map(); // uid -> { total, perChannel:Map, perDay:Map, perDayChannel:Map, intervals:[] }
  for (const r of rows) {
    const startedAt = Number(r.started_at);
    const endedAt = r.ended_at == null ? null : Number(r.ended_at);
    if (!Number.isFinite(startedAt)) continue;

    const segStart = Math.max(startedAt, from);
    const segEnd = Math.min(endedAt ?? Date.now(), to);
    if (segEnd <= segStart) continue;

    const uid = String(r.user_id);
    const chid = r.channel_id ? String(r.channel_id) : 'manual';

    const byDay = billableByDay(uid, guildId, segStart, segEnd);
    if (!byDay.length) continue;

    if (!perUser.has(uid)) perUser.set(uid, {
      total: 0, perChannel: new Map(), perDay: new Map(), perDayChannel: new Map(), intervals: []
    });
    const u = perUser.get(uid);

    for (const d of byDay) {
      u.total += d.ms;
      u.perChannel.set(chid, (u.perChannel.get(chid) || 0) + d.ms);
      u.perDay.set(d.day, (u.perDay.get(d.day) || 0) + d.ms);
      const key = `${d.day}|${chid}`;
      u.perDayChannel.set(key, (u.perDayChannel.get(key) || 0) + d.ms);
      u.intervals.push({ day: d.day, channel_id: chid, start: d.start, end: d.end, ms: d.ms });
    }
  }
  return perUser;
}

// Resolver nombres visibles y rol más alto
async function resolveMembersInfo(guildId, userIds) {
  const res = new Map();
  const g = client.guilds.cache.get(guildId);
  for (const uid of userIds) {
    let name = `Usuario ${uid}`, topRole = '—';
    try {
      const m = g ? await g.members.fetch(uid) : null;
      name = m?.displayName || m?.user?.username || name;
      topRole = m?.roles?.highest?.name || topRole;
    } catch {}
    res.set(uid, { name, topRole });
  }
  return res;
}

// ====== SLASH COMMANDS
const commands = [
  new SlashCommandBuilder()
    .setName('entrada')
    .setDescription('Inicia tu registro manual de presencia (usuario opcional).')
    .addUserOption(o => o.setName('usuario').setDescription('Usuario (solo admins para terceros)')),

  new SlashCommandBuilder()
    .setName('salida')
    .setDescription('Cierra sesiones abiertas (usuario opcional).')
    .addUserOption(o => o.setName('usuario').setDescription('Usuario (solo admins para terceros)')),

  new SlashCommandBuilder()
    .setName('reporte')
    .setDescription('Reporte por usuario o general; texto + Excel opcional.')
    .addUserOption(o => o.setName('usuario').setDescription('Usuario específico (opcional)'))
    .addStringOption(o => o.setName('fecha')
      .setDescription('Rango rápido')
      .addChoices(
        { name: 'Hoy', value: 'hoy' },
        { name: 'Ayer', value: 'ayer' },
        { name: 'Últimos 7 días', value: 'semana' },
      ))
    .addStringOption(o => o.setName('desde').setDescription('Inicio (DD/MM/YYYY, ISO o relativo -7d, -12h, -30m)'))
    .addStringOption(o => o.setName('hasta').setDescription('Fin (DD/MM/YYYY, ISO o relativo)'))
    .addBooleanOption(o => o.setName('excel').setDescription('Adjuntar Excel (solo Admin/Viewer)')),

  new SlashCommandBuilder()
    .setName('config_horario')
    .setDescription('Configura horario laboral individual (HH:MM 24h).')
    .addStringOption(o => o.setName('inicio').setDescription('Hora inicio, ej: 09:00').setRequired(true))
    .addStringOption(o => o.setName('fin').setDescription('Hora fin, ej: 18:00').setRequired(true))
    .addUserOption(o => o.setName('usuario').setDescription('Usuario (si no pones, te aplica a ti)')),

  new SlashCommandBuilder()
    .setName('config_break')
    .setDescription('Configura break de almuerzo individual (inicio + duración).')
    .addStringOption(o => o.setName('inicio').setDescription('Hora inicio (HH:MM), ej: 13:00').setRequired(true))
    .addIntegerOption(o => o.setName('duracion_min').setDescription('Duración en minutos, ej: 60').setRequired(true))
    .addUserOption(o => o.setName('usuario').setDescription('Usuario (si no pones, te aplica a ti)')),

  new SlashCommandBuilder()
    .setName('admin_viewer')
    .setDescription('Admins: gestionar quién puede ver reportes generales o de terceros.')
    .addSubcommand(sc => sc.setName('add').setDescription('Autorizar viewer')
      .addUserOption(o => o.setName('usuario').setDescription('Usuario a autorizar').setRequired(true)))
    .addSubcommand(sc => sc.setName('remove').setDescription('Quitar autorización')
      .addUserOption(o => o.setName('usuario').setDescription('Usuario a quitar').setRequired(true)))
    .addSubcommand(sc => sc.setName('list').setDescription('Listar viewers autorizados')),
].map(c => c.toJSON());

// ====== REGISTRO DE COMANDOS
client.once(Events.ClientReady, async () => {
  console.log(`Conectado como ${client.user.tag}`);
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  try {
    await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: [] }); // limpia globales
    if (!process.env.GUILD_ID) return console.error('Falta GUILD_ID en .env');
    await rest.put(
      Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
      { body: commands }
    );
    console.log('Comandos registrados (GUILD).');
  } catch (e) {
    console.error('Error registrando comandos:', e);
  }
});

// ====== VOICE (auto sesiones)
client.on(Events.VoiceStateUpdate, (oldS, newS) => {
  const guildId = newS.guild.id;
  const userId = newS.id;
  const now = Date.now();
  const oldCh = oldS.channelId;
  const newCh = newS.channelId;

  if (!oldCh && newCh) {
    q.startSession.run({ guild_id: guildId, user_id: userId, channel_id: newCh, started_at: now, source: 'auto' });
    return;
  }
  if (oldCh && newCh && oldCh !== newCh) {
    const open = q.getOpenSessions.all({ guild_id: guildId, user_id: userId });
    const last = [...open].reverse().find(s => s.channel_id === oldCh);
    if (last) q.endSpecificSession.run({ id: last.id, ended_at: now });
    q.startSession.run({ guild_id: guildId, user_id: userId, channel_id: newCh, started_at: now, source: 'auto' });
    return;
  }
  if (oldCh && !newCh) {
    q.endOpenSessions.run({ guild_id: guildId, user_id: userId, ended_at: now });
  }
});

// ====== INTERACCIONES
client.on(Events.InteractionCreate, async (ix) => {
  if (!ix.isChatInputCommand()) return;
  if (!ix.inGuild()) { await ix.reply({ ephemeral: true, content: '❌ Este bot funciona dentro de un servidor.' }); return; }

  const name = ix.commandName;
  const safeReply = async (content) => {
    try { (ix.deferred || ix.replied) ? await ix.followUp({ ephemeral: true, content }) : await ix.reply({ ephemeral: true, content }); }
    catch (e) { console.error('Fallo al responder:', e); }
  };

  try {
    // ---- ENTRADA (usuario opcional)
    if (name === 'entrada') {
      const target = ix.options.getUser('usuario') || ix.user;
      if (target.id !== ix.user.id && !isAdmin(ix.member)) {
        await ix.reply({ ephemeral: true, content: '❌ Solo admins pueden registrar la entrada de otra persona.' });
        return;
      }
      let voiceChannelId = null;
      try { const m = await ix.guild.members.fetch(target.id).catch(() => null); voiceChannelId = m?.voice?.channelId ?? null; } catch {}
      q.startSession.run({ guild_id: ix.guildId, user_id: target.id, channel_id: voiceChannelId, started_at: Date.now(), source: 'manual' });
      await ix.reply({ ephemeral: true, content: `✅ Entrada registrada para ${target}.` });
      return;
    }

    // ---- SALIDA (usuario opcional)
    if (name === 'salida') {
      const target = ix.options.getUser('usuario') || ix.user;
      if (target.id !== ix.user.id && !isAdmin(ix.member)) {
        await ix.reply({ ephemeral: true, content: '❌ Solo admins pueden cerrar sesiones de otra persona.' });
        return;
      }
      const res = q.endOpenSessions.run({ guild_id: ix.guildId, user_id: target.id, ended_at: Date.now() });
      const n = res.changes || 0;
      await ix.reply({ ephemeral: true, content: n ? `✅ Salida registrada para ${target} (${n} sesión/es cerrada/s).` : `ℹ️ ${target} no tenía sesiones abiertas.` });
      return;
    }

    // ---- REPORTE
    if (name === 'reporte') {
      await ix.deferReply({ ephemeral: false });

      const userOpt = ix.options.getUser('usuario');
      const fecha = ix.options.getString('fecha');
      const now = Date.now();

      // Rango
      let from = parseDateOrRel(ix.options.getString('desde'), false, null);
      let to   = parseDateOrRel(ix.options.getString('hasta'), true,  null);
      if (!from && !to && fecha) {
        const d0 = dayStart(now);
        if (fecha === 'hoy')   { from = d0;           to = d0 + 24 * H; }
        if (fecha === 'ayer')  { from = d0 - 24 * H;  to = d0; }
        if (fecha === 'semana'){ from = now - 7*24*H; to = now; }
      }
      if (!from) from = now - 24 * H;
      if (!to)   to   = now;
      if (to <= from) { await ix.editReply({ content: '❌ Rango inválido: `hasta` debe ser mayor que `desde`.' }); return; }

      const callerId = ix.user.id;
      const canAdmin  = isAdmin(ix.member);
      const canViewer = canAdmin || isAllowedViewer(ix.guildId, callerId);

      // Si pide otro usuario o general sin permiso → limitar a su propio id
      let userIdOrNull = userOpt?.id ?? null;
      if ((!userOpt) === true && !canViewer) {
        userIdOrNull = callerId;
      } else if (userOpt && userOpt.id !== callerId && !canViewer) {
        userIdOrNull = callerId;
      }

      const perUser = aggregatePure(ix.guildId, from, to, userIdOrNull);
      const uids = [...perUser.keys()];
      const infoMap = await resolveMembersInfo(ix.guildId, uids);

      // texto
      const lines = [];
      for (const [uid, data] of perUser) {
        const info = infoMap.get(uid) || { name: `Usuario ${uid}`, topRole: '—' };
        lines.push(`**${info.name}** (rol: *${info.topRole}*) — Total: \`${fmtHMS(data.total)}\``);

        const sch = q.getSchedule.get({ guild_id: ix.guildId, user_id: uid });
        const brk = q.getBreak.get({ guild_id: ix.guildId, user_id: uid });
        const horario = sch ? `${minutesToHHMM(sch.work_start_min)}–${minutesToHHMM(sch.work_end_min)}` : 'No configurado';
        const brtxt  = brk ? `${minutesToHHMM(brk.break_start_min)}–${minutesToHHMM(brk.break_end_min)}` : '—';
        lines.push(`Horario: **${horario}** | Break: **${brtxt}**`);

        for (const [chid, ms] of data.perChannel) {
          const label = chid === 'manual' ? 'Manual (/entrada-/salida)' : (ix.guild.channels.cache.get(chid)?.name || `Canal ${chid}`);
          lines.push(`• ${label}: \`${fmtHMS(ms)}\``);
        }

        const byDay = [...data.perDay.entries()].sort((a,b)=>a[0]-b[0]);
        if (byDay.length) {
          lines.push('\n*Por día:*');
          for (const [dStart, ms] of byDay) {
            const ivs = data.intervals.filter(iv => iv.day === dStart);
            const sh = ivs.map(iv => {
              const label = iv.channel_id === 'manual' ? 'Manual' : (ix.guild.channels.cache.get(iv.channel_id)?.name || `Canal ${iv.channel_id}`);
              return `  · ${fmtLocalTime(iv.start)}–${fmtLocalTime(iv.end)} (${label})`;
            }).join('\n');
            lines.push(`• ${fmtLocalDate(dStart)}: \`${fmtHMS(ms)}\`${ivs.length ? `\n${sh}` : ''}`);
          }
        }
        lines.push('');
      }

      const rangoCab = (from && to && dayStart(from) + 24 * H === to)
        ? fmtLocalDate(from)
        : `${fmtLocal(from)} → ${fmtLocal(to)}`;

      const header = `**Reporte de presencia**\nPeriodo: ${rangoCab}\n\n`;
      const contentText = (perUser.size ? header + lines.join('\n') : header + 'Sin datos en el periodo seleccionado.');

      // Excel: solo Admin/Viewer
      let wantExcel = ix.options.getBoolean('excel') ?? false;
      if (!canViewer) wantExcel = false;

      if (!wantExcel) {
        await ix.editReply({ content: contentText });
      } else {
        // ----- Construir Excel (CSV con ; y BOM UTF-8, encabezados en español)
        const csv = [];
        csv.push([
          'fecha', 'nombre', 'rol', 'horario_inicio', 'horario_fin',
          'break_inicio', 'break_fin', 'canal_id', 'canal_nombre',
          'hh:mm:ss', 'intervalo_inicio', 'intervalo_fin', 'desde', 'hasta'
        ]);

        for (const [uid, data] of perUser) {
          const info = infoMap.get(uid) || { name: `Usuario ${uid}`, topRole: '—' };
          const sch = q.getSchedule.get({ guild_id: ix.guildId, user_id: uid });
          const br  = q.getBreak.get({ guild_id: ix.guildId, user_id: uid });
          const schedStart = sch ? minutesToHHMM(sch.work_start_min) : '';
          const schedEnd   = sch ? minutesToHHMM(sch.work_end_min)   : '';
          const breakStart = br ? minutesToHHMM(br.break_start_min)  : '';
          const breakEnd   = br ? minutesToHHMM(br.break_end_min)    : '';

          // Totales por día
          for (const [dStart, ms] of [...data.perDay.entries()].sort((a,b)=>a[0]-b[0])) {
            csv.push([
              fmtLocalDate(dStart),
              info.name, info.topRole, schedStart, schedEnd, breakStart, breakEnd,
              '', '', fmtHMS(ms), '', '',
              fmtLocal(from), fmtLocal(to)
            ]);
          }
          // Intervalos
          for (const iv of data.intervals) {
            const cname = iv.channel_id === 'manual'
              ? 'Manual'
              : (ix.guild.channels.cache.get(iv.channel_id)?.name || `Canal ${iv.channel_id}`);
            csv.push([
              fmtLocalDate(iv.day),
              info.name, info.topRole, schedStart, schedEnd, breakStart, breakEnd,
              iv.channel_id, cname, fmtHMS(iv.ms),
              fmtLocal(iv.start), fmtLocal(iv.end),
              fmtLocal(from), fmtLocal(to)
            ]);
          }
        }

        const SEP = ';';
        const toCSV = rows =>
          rows.map(r => r.map(v => {
            const s = String(v ?? '');
            const needQuotes = s.includes('"') || s.includes('\n') || s.includes(SEP);
            const esc = s.replace(/"/g,'""');
            return needQuotes ? `"${esc}"` : esc;
          }).join(SEP)).join('\n');

        const BOM = Buffer.from('\uFEFF','utf8');
        const buf = Buffer.concat([BOM, Buffer.from(toCSV(csv),'utf8')]);

        const file = new AttachmentBuilder(buf, {
          name: `reporte_${fmtLocalDate(from).replaceAll('/','-')}.csv`
        });
        await ix.editReply({ content: contentText, files: [file] });
      }
      return;
    }

    // ---- Configuración
    if (name === 'config_horario') {
      const target = ix.options.getUser('usuario') || ix.user;
      if (target.id !== ix.user.id && !isAdmin(ix.member)) {
        await ix.reply({ ephemeral: true, content: '❌ Solo un admin puede configurar el horario de otro usuario.' });
        return;
      }
      const inicio = toMinutes(ix.options.getString('inicio'));
      const fin = toMinutes(ix.options.getString('fin'));
      if (inicio === null || fin === null) return ix.reply({ ephemeral: true, content: '❌ Formato inválido. Usa HH:MM 24h.' });
      if (fin <= inicio) return ix.reply({ ephemeral: true, content: '❌ El fin debe ser mayor que el inicio.' });
      q.upsertSchedule.run({ guild_id: ix.guildId, user_id: target.id, work_start_min: inicio, work_end_min: fin });
      await ix.reply({ ephemeral: true, content: `✅ Horario guardado para ${target}: ${minutesToHHMM(inicio)}–${minutesToHHMM(fin)}.` });
      return;
    }

    if (name === 'config_break') {
      const target = ix.options.getUser('usuario') || ix.user;
      if (target.id !== ix.user.id && !isAdmin(ix.member)) {
        await ix.reply({ ephemeral: true, content: '❌ Solo un admin puede configurar el break de otro usuario.' });
        return;
      }
      const inicioStr = ix.options.getString('inicio');
      const dur = ix.options.getInteger('duracion_min');
      const inicio = toMinutes(inicioStr);
      if (inicio === null || !dur || dur <= 0) return ix.reply({ ephemeral: true, content: '❌ Usa HH:MM y duración en minutos (>0).' });
      const finMin = inicio + dur;
      if (finMin > 24 * 60) return ix.reply({ ephemeral: true, content: '❌ El break no puede exceder el día.' });
      q.upsertBreak.run({ guild_id: ix.guildId, user_id: target.id, break_start_min: inicio, break_end_min: finMin });
      await ix.reply({ ephemeral: true, content: `✅ Break guardado para ${target}: inicia ${inicioStr}, duración ${dur} min.` });
      return;
    }

    if (name === 'admin_viewer') {
      if (!isAdmin(ix.member)) return ix.reply({ ephemeral: true, content: '❌ Solo admins.' });
      const sub = ix.options.getSubcommand();
      if (sub === 'add') {
        const u = ix.options.getUser('usuario');
        q.addViewer.run({ guild_id: ix.guildId, user_id: u.id });
        await ix.reply({ ephemeral: true, content: `✅ ${u} ahora puede ver reportes generales o de terceros.` });
        return;
      }
      if (sub === 'remove') {
        const u = ix.options.getUser('usuario');
        q.removeViewer.run({ guild_id: ix.guildId, user_id: u.id });
        await ix.reply({ ephemeral: true, content: `✅ ${u} ya no tiene acceso ampliado a reportes.` });
        return;
      }
      if (sub === 'list') {
        const rows = q.listViewers.all({ guild_id: ix.guildId });
        const names = rows.length
          ? await Promise.all(rows.map(async r => {
              const m = await ix.guild.members.fetch(r.user_id).catch(()=>null);
              return m?.displayName || `Usuario ${r.user_id}`;
            }))
          : [];
        await ix.reply({ ephemeral: true, content: rows.length ? `Viewers autorizados: ${names.join(', ')}` : 'No hay viewers autorizados.' });
        return;
      }
    }

    await safeReply('❓ Comando no reconocido.');
  } catch (err) {
    console.error(`Error en /${name}:`, err);
    await safeReply('❌ Ocurrió un error al procesar el comando.');
  }
});

// Logs
process.on('unhandledRejection', (r) => console.error('unhandledRejection:', r));
process.on('uncaughtException', (e) => console.error('uncaughtException:', e));

client.login(process.env.DISCORD_TOKEN);

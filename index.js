require("dotenv").config()
const {
  default: makeWASocket,
  useMultiFileAuthState,
  downloadContentFromMessage,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  Browsers,
  normalizeMessageContent,
  getContentType,
  isLidUser,
  isPnUser,
  jidNormalizedUser,
  proto
} = require("baileys")

const qrcode = require("qrcode-terminal")
const pino = require("pino")
const { Boom } = require("@hapi/boom")
const fs = require("fs")
const os = require("os")
const path = require("path")
const { DatabaseSync } = require("node:sqlite")

// ================= CONFIG (ENV DEFAULTS + LIVE SQLITE OVERRIDES) =================
const normalizePhone = (val = "") => String(val).split("@")[0].replace(/\D/g, "")

const ENV_DEFAULTS = {
  owner: normalizePhone(process.env.OWNER || "6285187809003"),
  target: normalizePhone(process.env.TARGET_NUMBER || "62895369909944"),
  target_lid: (process.env.TARGET_LID || "").trim(),
  retention_days: String(Math.max(1, parseInt(process.env.DB_RETENTION_DAYS || "7", 10) || 7)),
  gemini_key: (process.env.GEMINI_API_KEY || "").trim(),
  gemini_model: (process.env.GEMINI_MODEL || "gemini-4-hydrogen").trim(),
  anti_delete: "on",
  anti_edit: "on",
  auto_capture: "on",
  auto_status: "on",
  auto_vault: "on",
  image_log: "on",
  panic_mode: "off",
  panic_snapshot: ""
}

const ANNIV_DATE_ENV = (process.env.ANNIV_DATE || "").trim()
const MAX_AI_INLINE_BYTES = 18 * 1024 * 1024

const MEMORIES_DIR = path.join(__dirname, "memories")
const DOWNLOADS_DIR = path.join(__dirname, "downloads")
const FAVORITE_EMOJIS = new Set(["❤️", "❤", "😍", "🥰", "⭐", "🌟", "📌", "💖", "💕", "💗"])

const logger = pino({ level: "silent" })
let activeSock = null

// ================= DATABASE SETUP (node:sqlite) =================
const dbDir = path.join(__dirname, "auth")
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true })

const dbPath = path.join(dbDir, "database.db")
const db = new DatabaseSync(dbPath)

db.exec(`
  PRAGMA journal_mode = WAL;

  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    jid TEXT,
    message TEXT,
    timestamp INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);

  CREATE TABLE IF NOT EXISTS reply_metrics (
    msg_id TEXT PRIMARY KEY,
    sender TEXT NOT NULL,
    sent_at INTEGER NOT NULL,
    delivered_at INTEGER,
    read_at INTEGER,
    replied_at INTEGER,
    replied_msg_id TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_reply_metrics_sent ON reply_metrics(sent_at);

  CREATE TABLE IF NOT EXISTS vault_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    msg_id TEXT UNIQUE,
    source TEXT NOT NULL,
    media_type TEXT NOT NULL,
    file_path TEXT NOT NULL,
    month_key TEXT NOT NULL,
    caption TEXT,
    is_favorite INTEGER DEFAULT 0,
    timestamp INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_vault_month ON vault_items(month_key);

  CREATE TABLE IF NOT EXISTS couple_messages (
    msg_id TEXT PRIMARY KEY,
    sender TEXT NOT NULL,
    msg_type TEXT NOT NULL,
    word_count INTEGER DEFAULT 0,
    char_count INTEGER DEFAULT 0,
    text_content TEXT,
    hour INTEGER NOT NULL,
    day_key TEXT NOT NULL,
    timestamp INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_couple_messages_ts ON couple_messages(timestamp);

  CREATE TABLE IF NOT EXISTS important_dates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    date_str TEXT NOT NULL,
    is_anniv INTEGER DEFAULT 0,
    last_notified TEXT
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
`)

// Prepared Statements
const stmtSaveMsg = db.prepare(`INSERT OR REPLACE INTO messages (id, jid, message, timestamp) VALUES (?, ?, ?, ?)`)
const stmtGetMsg = db.prepare(`SELECT message FROM messages WHERE id = ?`)
const stmtDeleteOldMsg = db.prepare(`DELETE FROM messages WHERE timestamp < ?`)
const stmtCountMsg = db.prepare(`SELECT COUNT(*) AS total FROM messages`)

const stmtInsertMetric = db.prepare(`INSERT OR IGNORE INTO reply_metrics (msg_id, sender, sent_at) VALUES (?, ?, ?)`)
const stmtGetMetric = db.prepare(`SELECT * FROM reply_metrics WHERE msg_id = ?`)
const stmtUpdateDelivered = db.prepare(`UPDATE reply_metrics SET delivered_at = ? WHERE msg_id = ? AND delivered_at IS NULL`)
const stmtUpdateRead = db.prepare(`UPDATE reply_metrics SET read_at = ? WHERE msg_id = ? AND read_at IS NULL`)
const stmtLatestUnreplied = db.prepare(
  `SELECT msg_id, sent_at FROM reply_metrics WHERE sender = ? AND replied_at IS NULL AND sent_at >= ? AND sent_at <= ? ORDER BY sent_at DESC LIMIT 1`
)
const stmtMarkReplied = db.prepare(`UPDATE reply_metrics SET replied_at = ?, replied_msg_id = ? WHERE msg_id = ?`)
const stmtCloseBurstBefore = db.prepare(
  `UPDATE reply_metrics SET replied_at = -1 WHERE sender = ? AND replied_at IS NULL AND sent_at < ? AND msg_id != ?`
)
const stmtGetMetricsSince = db.prepare(`SELECT * FROM reply_metrics WHERE sent_at >= ?`)
const stmtGetAllMetrics = db.prepare(`SELECT * FROM reply_metrics`)

const stmtInsertVault = db.prepare(
  `INSERT OR IGNORE INTO vault_items (msg_id, source, media_type, file_path, month_key, caption, is_favorite, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
)
const stmtGetVaultByMsg = db.prepare(`SELECT * FROM vault_items WHERE msg_id = ?`)
const stmtSetVaultFavorite = db.prepare(`UPDATE vault_items SET is_favorite = 1 WHERE msg_id = ?`)
const stmtVaultSummaryByMonth = db.prepare(
  `SELECT month_key, media_type, COUNT(*) AS cnt FROM vault_items GROUP BY month_key, media_type ORDER BY month_key DESC`
)
const stmtVaultTotals = db.prepare(
  `SELECT COUNT(*) AS total, SUM(CASE WHEN is_favorite = 1 THEN 1 ELSE 0 END) AS favs FROM vault_items`
)
const stmtVaultAllPaths = db.prepare(`SELECT file_path FROM vault_items`)
const stmtVaultRandom = db.prepare(`SELECT * FROM vault_items ORDER BY RANDOM() LIMIT 1`)
const stmtVaultRandomFav = db.prepare(`SELECT * FROM vault_items WHERE is_favorite = 1 ORDER BY RANDOM() LIMIT 1`)

const stmtInsertCoupleMsg = db.prepare(
  `INSERT OR IGNORE INTO couple_messages (msg_id, sender, msg_type, word_count, char_count, text_content, hour, day_key, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
)
const stmtCoupleMsgsSince = db.prepare(`SELECT * FROM couple_messages WHERE timestamp >= ? ORDER BY timestamp ASC`)
const stmtCoupleMsgsAll = db.prepare(`SELECT * FROM couple_messages ORDER BY timestamp ASC`)

const stmtGetDates = db.prepare(`SELECT * FROM important_dates ORDER BY is_anniv DESC, date_str ASC`)
const stmtGetAnniv = db.prepare(`SELECT * FROM important_dates WHERE is_anniv = 1 LIMIT 1`)
const stmtGetDateByName = db.prepare(`SELECT * FROM important_dates WHERE LOWER(name) = LOWER(?) LIMIT 1`)
const stmtInsertDate = db.prepare(`INSERT INTO important_dates (name, date_str, is_anniv) VALUES (?, ?, ?)`)
const stmtUpdateAnniv = db.prepare(`UPDATE important_dates SET name = ?, date_str = ?, last_notified = NULL WHERE is_anniv = 1`)
const stmtUpdateDateById = db.prepare(`UPDATE important_dates SET name = ?, date_str = ?, last_notified = NULL WHERE id = ?`)
const stmtDeleteDate = db.prepare(`DELETE FROM important_dates WHERE id = ?`)
const stmtMarkDateNotified = db.prepare(`UPDATE important_dates SET last_notified = ? WHERE id = ?`)

const stmtGetAllSettings = db.prepare(`SELECT key, value FROM settings`)
const stmtSetSetting = db.prepare(`INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)`)
const stmtDeleteSetting = db.prepare(`DELETE FROM settings WHERE key = ?`)
const stmtClearAllSettings = db.prepare(`DELETE FROM settings`)

// Live Config State (SQLite settings > .env defaults)
const cfg = { ...ENV_DEFAULTS }
for (const row of stmtGetAllSettings.all()) {
  if (Object.prototype.hasOwnProperty.call(ENV_DEFAULTS, row.key)) {
    cfg[row.key] = row.value
  }
}

const getCfg = (key) => cfg[key] ?? ENV_DEFAULTS[key] ?? ""
const isEnabled = (key) => getCfg(key) !== "off"
const setCfg = (key, value) => {
  const valStr = String(value)
  cfg[key] = valStr
  stmtSetSetting.run(key, valStr, Date.now())
}
const resetCfg = (key) => {
  if (key === "all") {
    stmtClearAllSettings.run()
    Object.assign(cfg, ENV_DEFAULTS)
    return
  }
  if (Object.prototype.hasOwnProperty.call(ENV_DEFAULTS, key)) {
    stmtDeleteSetting.run(key)
    cfg[key] = ENV_DEFAULTS[key]
  }
}

const getOwnerNumber = () => normalizePhone(getCfg("owner"))
const getOwnerJid = () => `${getOwnerNumber()}@s.whatsapp.net`
const getTargetNumber = () => normalizePhone(getCfg("target"))
const getTargetPn = () => (getTargetNumber() ? `${getTargetNumber()}@s.whatsapp.net` : "")
const getTargetLid = () => getCfg("target_lid").trim()
const getRetentionDays = () => Math.max(1, parseInt(getCfg("retention_days") || "7", 10) || 7)
const getGeminiKey = () => getCfg("gemini_key").trim()
const getGeminiModel = () => getCfg("gemini_model").trim() || "gemini-4-hydrogen"

function maskSecret(str) {
  if (!str) return "(belum diisi)"
  if (str.length <= 8) return "****"
  return `${str.slice(0, 4)}****${str.slice(-4)}`
}

function upsertNamedImportantDate({ name, dateStr, isAnniv = 0 }) {
  if (isAnniv) {
    if (stmtGetAnniv.get()) {
      stmtUpdateAnniv.run(name, dateStr)
    } else {
      stmtInsertDate.run(name, dateStr, 1)
    }
    return
  }
  const existing = stmtGetDateByName.get(name)
  if (existing) {
    stmtUpdateDateById.run(name, dateStr, existing.id)
  } else {
    stmtInsertDate.run(name, dateStr, 0)
  }
}

// Seed ANNIV_DATE dari .env jika belum ada di DB
if (/^\d{4}-\d{2}-\d{2}$/.test(ANNIV_DATE_ENV) && !stmtGetAnniv.get()) {
  stmtInsertDate.run("Anniversary Kita", ANNIV_DATE_ENV, 1)
}

// ================= DB HELPERS & AUTO-CLEANUP =================
const saveMsg = (id, jid, message) => {
  try {
    stmtSaveMsg.run(id, jid, JSON.stringify(message), Date.now())
  } catch (err) {
    console.error("DB save error:", err.message)
  }
}

const getMsg = (id) => {
  try {
    const row = stmtGetMsg.get(id)
    return row ? JSON.parse(row.message) : null
  } catch {
    return null
  }
}

function cleanupDatabase() {
  try {
    const retentionDays = getRetentionDays()
    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000
    const result = stmtDeleteOldMsg.run(cutoff)
    if (result.changes > 0) {
      db.exec("VACUUM")
      console.log(`🧹 DB CLEANUP: ${result.changes} cache pesan lama dihapus (> ${retentionDays} hari)`)
    }
  } catch (err) {
    console.error("DB cleanup error:", err.message)
  }
}

cleanupDatabase()
setInterval(cleanupDatabase, 6 * 60 * 60 * 1000)

// Dedup pesan yang dikirim bot sendiri & dedup Anti-Edit
const botSentIds = new Set()
function trackBotSent(sent) {
  const id = sent?.key?.id
  if (!id) return
  botSentIds.add(id)
  if (botSentIds.size > 500) {
    const first = botSentIds.values().next().value
    botSentIds.delete(first)
  }
}

async function sendToOwner(sock, content) {
  const sent = await sock.sendMessage(getOwnerJid(), content)
  trackBotSent(sent)
  return sent
}

async function sendToChat(sock, jid, content, options) {
  const sent = await sock.sendMessage(jid, content, options)
  trackBotSent(sent)
  return sent
}

const processedEdits = new Map()
function markEditProcessed(key) {
  if (processedEdits.has(key)) return false
  processedEdits.set(key, Date.now())
  if (processedEdits.size > 500) {
    const firstKey = processedEdits.keys().next().value
    processedEdits.delete(firstKey)
  }
  return true
}

// ================= UTILS =================
function extractTextFromMessage(rawMsg) {
  const m = normalizeMessageContent(rawMsg)
  if (!m) return ""
  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    m.documentMessage?.caption ||
    ""
  )
}

function isViewOnceMessage(rawMsg) {
  if (!rawMsg) return false
  if (rawMsg.viewOnceMessage || rawMsg.viewOnceMessageV2 || rawMsg.viewOnceMessageV2Extension) return true
  const m = normalizeMessageContent(rawMsg)
  return Boolean(m?.imageMessage?.viewOnce || m?.videoMessage?.viewOnce || m?.audioMessage?.viewOnce)
}

function extractMediaFromMessage(rawMsg) {
  const m = normalizeMessageContent(rawMsg)
  if (!m) return null
  if (m.imageMessage) {
    return {
      kind: "image",
      msg: m.imageMessage,
      ext: "jpg",
      mime: (m.imageMessage.mimetype || "image/jpeg").split(";")[0].trim()
    }
  }
  if (m.videoMessage) {
    return {
      kind: "video",
      msg: m.videoMessage,
      ext: "mp4",
      mime: (m.videoMessage.mimetype || "video/mp4").split(";")[0].trim()
    }
  }
  if (m.audioMessage) {
    return {
      kind: "audio",
      msg: m.audioMessage,
      ext: "ogg",
      mime: (m.audioMessage.mimetype || "audio/ogg").split(";")[0].trim(),
      ptt: Boolean(m.audioMessage.ptt)
    }
  }
  if (m.documentMessage) {
    const ext = path.extname(m.documentMessage.fileName || "").replace(".", "") || "bin"
    return {
      kind: "document",
      msg: m.documentMessage,
      ext,
      mime: (m.documentMessage.mimetype || "application/pdf").split(";")[0].trim(),
      fileName: m.documentMessage.fileName || `file.${ext}`
    }
  }
  return null
}

function detectMsgCategory(rawMsg) {
  const m = normalizeMessageContent(rawMsg)
  if (!m) return "other"
  if (m.imageMessage) return "image"
  if (m.videoMessage) return "video"
  if (m.audioMessage) return "audio"
  if (m.stickerMessage) return "sticker"
  if (m.conversation || m.extendedTextMessage) return "text"
  return "other"
}

function getContextInfo(message) {
  const normalized = normalizeMessageContent(message) || message
  if (!normalized) return null
  const type = getContentType(normalized)
  return type ? normalized[type]?.contextInfo || null : null
}

async function downloadStreamToBuffer(mediaMsg, mediaType) {
  const stream = await downloadContentFromMessage(mediaMsg, mediaType)
  const chunks = []
  for await (const chunk of stream) {
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

async function sendMediaToOwner(sock, media, buffer, caption) {
  if (media.kind === "audio") {
    await sendToOwner(sock, { text: caption })
    await sendToOwner(sock, { audio: buffer, mimetype: media.mime, ptt: media.ptt })
    return
  }
  await sendToOwner(sock, { [media.kind]: buffer, caption })
}

function getLocalDateParts(date = new Date()) {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, "0")
  const d = String(date.getDate()).padStart(2, "0")
  return { y, m, d, dayKey: `${y}-${m}-${d}`, monthKey: `${y}-${m}`, hour: date.getHours() }
}

function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "-"
  const totalSec = Math.round(ms / 1000)
  if (totalSec < 60) return `${totalSec} detik`
  const totalMin = Math.floor(totalSec / 60)
  const remSec = totalSec % 60
  if (totalMin < 60) return remSec > 0 ? `${totalMin}m ${remSec}d` : `${totalMin} menit`
  const hours = Math.floor(totalMin / 60)
  const remMin = totalMin % 60
  return remMin > 0 ? `${hours}j ${remMin}m` : `${hours} jam`
}

async function resolveJidInfo(sock, primaryJid, altJid) {
  if (!primaryJid) return { raw: "-", pn: null, number: null, lid: null }

  const raw = jidNormalizedUser(primaryJid)
  const alt = altJid ? jidNormalizedUser(altJid) : null

  let pn = isPnUser(raw) ? raw : (alt && isPnUser(alt) ? alt : null)
  let lid = isLidUser(raw) ? raw : (alt && isLidUser(alt) ? alt : null)

  const lidStore = sock.signalRepository?.lidMapping
  if (lidStore) {
    try {
      if (!pn && lid) {
        const mappedPn = await lidStore.getPNForLID(lid)
        if (mappedPn) pn = jidNormalizedUser(mappedPn)
      }
      if (!lid && pn) {
        const mappedLid = await lidStore.getLIDForPN(pn)
        if (mappedLid) lid = jidNormalizedUser(mappedLid)
      }
    } catch {
      // Abaikan jika mapping LID/PN belum tersedia di cache
    }
  }

  return {
    raw,
    pn,
    number: pn ? pn.split("@")[0] : null,
    lid
  }
}

function isTargetEntity(info) {
  if (!info) return false
  const targetNum = getTargetNumber()
  const targetLid = getTargetLid()
  if (targetNum && info.number === targetNum) {
    if (info.lid && !targetLid) setCfg("target_lid", info.lid)
    return true
  }
  if (targetLid && (info.lid === targetLid || info.raw === targetLid)) {
    return true
  }
  return false
}

function isOwnerEntity(info) {
  const ownerNum = getOwnerNumber()
  return Boolean(info && ownerNum && info.number === ownerNum)
}

function isQuotedFromMe(sock, contextInfo) {
  if (!contextInfo?.participant) return false
  const quotedSender = jidNormalizedUser(contextInfo.participant)
  const myPn = sock.user?.id ? jidNormalizedUser(sock.user.id) : ""
  const myLid = sock.user?.lid ? jidNormalizedUser(sock.user.lid) : ""
  return quotedSender === myPn || (myLid && quotedSender === myLid)
}

// ================= 1. REPLY SPEED & READ-TO-REPLY =================
const MAX_TURN_WINDOW_MS = 24 * 60 * 60 * 1000

function recordReplyMetricTurn(msgId, senderRole, now = Date.now()) {
  try {
    stmtInsertMetric.run(msgId, senderRole, now)
    const opposite = senderRole === "me" ? "target" : "me"
    const latestOpp = stmtLatestUnreplied.get(opposite, now - MAX_TURN_WINDOW_MS, now)
    if (latestOpp) {
      stmtMarkReplied.run(now, msgId, latestOpp.msg_id)
      stmtCloseBurstBefore.run(opposite, now, latestOpp.msg_id)
    }
  } catch (err) {
    console.error("Metric turn error:", err.message)
  }
}

function recordReceiptStatus(msgId, status, tsSeconds) {
  if (!msgId) return
  try {
    const existing = stmtGetMetric.get(msgId)
    if (!existing) return
    const tsMs = tsSeconds && tsSeconds > 1_000_000_000 ? tsSeconds * 1000 : Date.now()
    if (status === proto.WebMessageInfo.Status.DELIVERY_ACK) {
      stmtUpdateDelivered.run(Math.max(tsMs, existing.sent_at), msgId)
    } else if (
      status === proto.WebMessageInfo.Status.READ ||
      status === proto.WebMessageInfo.Status.PLAYED
    ) {
      stmtUpdateRead.run(Math.max(tsMs, existing.sent_at), msgId)
    }
  } catch (err) {
    console.error("Receipt metric error:", err.message)
  }
}

function computeSpeedSummary(rows) {
  const sentToRead = []
  const readToReply = []
  const targetReply = []
  const myReply = []
  let readNotReplied = 0

  for (const r of rows) {
    if (r.sender === "me") {
      if (r.read_at && r.read_at >= r.sent_at) {
        sentToRead.push(r.read_at - r.sent_at)
      }
      if (r.replied_at && r.replied_at > 0 && r.replied_at >= r.sent_at) {
        targetReply.push(r.replied_at - r.sent_at)
        if (r.read_at && r.replied_at >= r.read_at) {
          readToReply.push(r.replied_at - r.read_at)
        }
      } else if (r.read_at && r.replied_at === null) {
        readNotReplied++
      }
    } else if (r.sender === "target") {
      if (r.replied_at && r.replied_at > 0 && r.replied_at >= r.sent_at) {
        myReply.push(r.replied_at - r.sent_at)
      }
    }
  }

  const avg = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null)
  const min = (arr) => (arr.length ? Math.min(...arr) : null)
  const max = (arr) => (arr.length ? Math.max(...arr) : null)

  return {
    sentToReadAvg: avg(sentToRead),
    readToReplyAvg: avg(readToReply),
    targetReplyAvg: avg(targetReply),
    targetFastest: min(targetReply),
    targetSlowest: max(targetReply),
    targetSamples: targetReply.length,
    readNotReplied,
    myReplyAvg: avg(myReply),
    myFastest: min(myReply),
    mySlowest: max(myReply),
    mySamples: myReply.length
  }
}

function buildSpeedReport(daysArg) {
  const isAll = daysArg === "all"
  const days = isAll ? null : Math.max(1, parseInt(daysArg || "7", 10) || 7)
  const rows = isAll
    ? stmtGetAllMetrics.all()
    : stmtGetMetricsSince.all(Date.now() - days * 24 * 60 * 60 * 1000)

  if (!rows.length) {
    return `⚡ *STATISTIK KECEPATAN BALAS*\n\nBelum ada data chat target yang tercatat. Mulai chat dulu ya!`
  }

  const s = computeSpeedSummary(rows)
  const label = isAll ? "Semua Waktu" : `${days} Hari Terakhir`

  return (
    `⚡ *STATISTIK KECEPATAN BALAS (${label})*\n\n` +
    `💌 *Pasangan (${getTargetNumber()})*\n` +
    `• Terkirim → Dibaca: *${formatDuration(s.sentToReadAvg)}*\n` +
    `• Dibaca → Dibalas (Read-to-Reply): *${formatDuration(s.readToReplyAvg)}*\n` +
    `• Rata-rata Total Balas: *${formatDuration(s.targetReplyAvg)}* (${s.targetSamples} sesi)\n` +
    `• Tercepat / Terlama: ${formatDuration(s.targetFastest)} / ${formatDuration(s.targetSlowest)}\n` +
    `• Dibaca tapi belum dibalas: *${s.readNotReplied}* chat\n\n` +
    `🙋 *Kamu (Owner)*\n` +
    `• Rata-rata Kecepatan Balas: *${formatDuration(s.myReplyAvg)}* (${s.mySamples} sesi)\n` +
    `• Tercepat / Terlama: ${formatDuration(s.myFastest)} / ${formatDuration(s.mySlowest)}\n\n` +
    `_Tips: ketik \`//speed all\` atau \`//speed 30\` untuk ubah rentang waktu._`
  )
}

// ================= 2. MEMORY VAULT OTOMATIS =================
function saveToMemoryVault({ msgId, source, media, buffer, caption = "", isFavorite = 0 }) {
  try {
    const { monthKey } = getLocalDateParts()
    const monthDir = path.join(MEMORIES_DIR, monthKey)
    if (!fs.existsSync(monthDir)) fs.mkdirSync(monthDir, { recursive: true })

    const filename = `${source}_${Date.now()}.${media.ext}`
    const filePath = path.join(monthDir, filename)
    fs.writeFileSync(filePath, buffer)

    stmtInsertVault.run(
      msgId || `${source}_${Date.now()}`,
      source,
      media.kind,
      filePath,
      monthKey,
      caption || "",
      isFavorite ? 1 : 0,
      Date.now()
    )
    return filePath
  } catch (err) {
    console.error("Vault save error:", err.message)
    return null
  }
}

function buildVaultSummary() {
  const totals = stmtVaultTotals.get() || { total: 0, favs: 0 }
  if (!totals.total) {
    return `🗂️ *MEMORY VAULT*\n\nBelum ada kenangan tersimpan di \`memories/\`. Media (foto/video/VN/status) dari chat target otomatis masuk ke sini!`
  }

  let totalBytes = 0
  for (const row of stmtVaultAllPaths.all()) {
    try {
      if (fs.existsSync(row.file_path)) totalBytes += fs.statSync(row.file_path).size
    } catch {}
  }

  const byMonth = new Map()
  for (const r of stmtVaultSummaryByMonth.all()) {
    if (!byMonth.has(r.month_key)) byMonth.set(r.month_key, { image: 0, video: 0, audio: 0 })
    byMonth.get(r.month_key)[r.media_type] = r.cnt
  }

  let monthLines = ""
  for (const [mKey, counts] of Array.from(byMonth.entries()).slice(0, 6)) {
    monthLines += `• \`memories/${mKey}\` → 🖼️ ${counts.image} | 🎬 ${counts.video} | 🎙️ ${counts.audio}\n`
  }

  return (
    `🗂️ *MEMORY VAULT KENANGAN*\n\n` +
    `• Total Arsip: *${totals.total}* media\n` +
    `• Ditandai Favorit (❤️/⭐): *${totals.favs || 0}*\n` +
    `• Ukuran Folder: *${(totalBytes / 1024 / 1024).toFixed(2)} MB*\n\n` +
    `📅 *Per Bulan:*\n${monthLines}\n` +
    `_Ketik \`//vault random\` untuk throwback acak, atau \`//vault fav\` untuk kenangan favorit!_`
  )
}

// ================= 3. COUPLE WRAPPED (SQLITE) =================
const STOPWORDS = new Set([
  "yang", "yg", "dan", "di", "ke", "dari", "ini", "itu", "aku", "kamu", "km", "ak", "gue", "gw", "lu",
  "gak", "ga", "gk", "nggak", "ngga", "enggak", "tidak", "tdk", "ya", "iya", "yaa", "yah", "aja", "saja",
  "deh", "dong", "nih", "tuh", "kok", "sih", "kan", "loh", "lah", "nya", "ada", "jadi", "kalo", "kalau",
  "kl", "udah", "udh", "dah", "belum", "blm", "lagi", "lg", "mau", "bisa", "bs", "sama", "sm", "buat",
  "untuk", "utk", "juga", "jg", "tapi", "tp", "biar", "pas", "apa", "gimana", "gmn", "kenapa", "knp",
  "kita", "dia", "mereka", "nya", "banget", "bgt", "bukan", "gitu", "gt", "kek", "kayak", "kya", "sama"
])

function recordCoupleMessage(msgId, senderRole, rawMsg, body, now = Date.now()) {
  try {
    const msgType = detectMsgCategory(rawMsg)
    const cleanText = (body || "").trim()
    const words = cleanText ? cleanText.split(/\s+/).filter(Boolean).length : 0
    const { hour, dayKey } = getLocalDateParts(new Date(now))
    stmtInsertCoupleMsg.run(msgId, senderRole, msgType, words, cleanText.length, cleanText, hour, dayKey, now)
  } catch (err) {
    console.error("Couple msg log error:", err.message)
  }
}

function buildCoupleWrapped(daysArg) {
  const isAll = daysArg === "all"
  const days = isAll ? null : Math.max(1, parseInt(daysArg || "30", 10) || 30)
  const rows = isAll
    ? stmtCoupleMsgsAll.all()
    : stmtCoupleMsgsSince.all(Date.now() - days * 24 * 60 * 60 * 1000)

  if (!rows.length) {
    return `💝 *COUPLE WRAPPED*\n\nBelum ada data chat target yang tercatat. Mulai chat dulu nanti statistiknya otomatis terisi!`
  }

  const label = isAll ? "Sepanjang Waktu" : `${days} Hari Terakhir`
  const counts = { me: 0, target: 0 }
  const words = { me: 0, target: 0 }
  const media = {
    me: { image: 0, video: 0, audio: 0, sticker: 0 },
    target: { image: 0, video: 0, audio: 0, sticker: 0 }
  }
  const hourBuckets = new Array(24).fill(0)
  const dayCounts = new Map()
  const wordFreq = new Map()

  const sweetMatchers = [
    { label: "Sayang/Cinta", regex: /\b(sayang|syg|ayg|ayang|beb|babe|cinta|love|lov|luv)\b/gi, me: 0, target: 0 },
    { label: "Kangen/Rindu", regex: /\b(kangen|kgn|rindu|miss)\b/gi, me: 0, target: 0 },
    { label: "Ketawa (Wkwk/Haha)", regex: /\b(wkwk\w*|haha\w*|hehe\w*|hihi\w*|xixi\w*)\b/gi, me: 0, target: 0 },
    { label: "Minta Maaf", regex: /\b(maaf|maap|sorry|sory)\b/gi, me: 0, target: 0 }
  ]

  let longest = { sender: "-", len: 0, snippet: "" }

  for (const r of rows) {
    const who = r.sender === "me" ? "me" : "target"
    counts[who]++
    words[who] += r.word_count || 0
    if (media[who][r.msg_type] !== undefined) media[who][r.msg_type]++
    if (r.hour >= 0 && r.hour <= 23) hourBuckets[r.hour]++
    dayCounts.set(r.day_key, (dayCounts.get(r.day_key) || 0) + 1)

    if (r.text_content) {
      if (r.text_content.length > longest.len) {
        longest = {
          sender: who === "me" ? "Kamu" : "Pasangan",
          len: r.text_content.length,
          snippet: r.text_content.slice(0, 55).replace(/\n/g, " ")
        }
      }
      for (const sm of sweetMatchers) {
        const m = r.text_content.match(sm.regex)
        if (m) sm[who] += m.length
      }
      const tokens = r.text_content
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .split(/\s+/)
      for (const t of tokens) {
        if (t.length >= 3 && !STOPWORDS.has(t)) {
          wordFreq.set(t, (wordFreq.get(t) || 0) + 1)
        }
      }
    }
  }

  const total = counts.me + counts.target
  const pctMe = ((counts.me / total) * 100).toFixed(1)
  const pctTarget = ((counts.target / total) * 100).toFixed(1)
  const moreTalkative = counts.me > counts.target ? "Kamu 🏆" : counts.target > counts.me ? "Pasangan 🏆" : "Seimbang 🤝"

  let peakHour = 0
  for (let h = 1; h < 24; h++) {
    if (hourBuckets[h] > hourBuckets[peakHour]) peakHour = h
  }
  const timeVibe =
    peakHour >= 22 || peakHour <= 3
      ? "Tim Begadang 🌙"
      : peakHour <= 10
        ? "Tim Pagi ☀️"
        : peakHour <= 16
          ? "Tim Siang 🌤️"
          : "Tim Sore/Malam 🌆"

  let topDay = ["-", 0]
  for (const entry of dayCounts.entries()) {
    if (entry[1] > topDay[1]) topDay = entry
  }

  // Hitung streak hari berturut-turut
  const sortedDays = Array.from(dayCounts.keys()).sort()
  let maxStreak = 0
  let curStreak = 0
  let prevTime = null
  for (const dk of sortedDays) {
    const t = new Date(`${dk}T00:00:00`).getTime()
    if (prevTime !== null && Math.round((t - prevTime) / 86400000) === 1) {
      curStreak++
    } else {
      curStreak = 1
    }
    if (curStreak > maxStreak) maxStreak = curStreak
    prevTime = t
  }

  const topWords = Array.from(wordFreq.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([w, c], i) => `${i + 1}. "${w}" (${c}x)`)
    .join("\n")

  const sweetLines = sweetMatchers
    .map((sm) => `• ${sm.label}: Kamu *${sm.me}x* | Dia *${sm.target}x*`)
    .join("\n")

  return (
    `💝 *COUPLE WRAPPED (${label})* 💝\n\n` +
    `💬 *Total Chat:* ${total} pesan\n` +
    `• Kamu: *${counts.me}* (${pctMe}% • ${words.me} kata)\n` +
    `• Pasangan: *${counts.target}* (${pctTarget}% • ${words.target} kata)\n` +
    `• Paling Bawel: *${moreTalkative}*\n\n` +
    `📸 *Media & VN (Kamu vs Dia):*\n` +
    `• Foto: ${media.me.image} vs ${media.target.image} | Video: ${media.me.video} vs ${media.target.video}\n` +
    `• Voice Note: ${media.me.audio} vs ${media.target.audio} | Stiker: ${media.me.sticker} vs ${media.target.sticker}\n\n` +
    `⏰ *Pola Chat:*\n` +
    `• Jam Paling Aktif: *${String(peakHour).padStart(2, "0")}:00–${String((peakHour + 1) % 24).padStart(2, "0")}:00* (${timeVibe})\n` +
    `• Hari Paling Ramai: *${topDay[0]}* (${topDay[1]} chat)\n` +
    `• Rekor Streak Chat: *${maxStreak} hari* berturut-turut 🔥\n` +
    `• Rekor Curhat Terpanjang: *${longest.sender}* (${longest.len} huruf)\n` +
    (longest.snippet ? `  _"${longest.snippet}${longest.len > 55 ? "..." : ""}"_\n` : "") +
    `\n🥰 *Skor Kata Manis:*\n${sweetLines}\n\n` +
    `🗣️ *Top 5 Kata Favorit:*\n${topWords || "(belum cukup kata)"}\n\n` +
    `_Ketik \`//wrapped 7\` atau \`//wrapped all\` untuk periode lain._`
  )
}

// ================= 4. COUNTDOWN ANNIVERSARY & TANGGAL PENTING =================
function calcDateInfo(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number)
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const origin = new Date(y, m - 1, d)

  const daysTogether = Math.floor((today - origin) / 86400000)

  const makeOcc = (year) => {
    // Handle 29 Feb di tahun non-kabisat -> 28 Feb
    const lastDay = new Date(year, m, 0).getDate()
    return new Date(year, m - 1, Math.min(d, lastDay))
  }

  let next = makeOcc(today.getFullYear())
  if (next < today) next = makeOcc(today.getFullYear() + 1)
  const daysUntil = Math.round((next - today) / 86400000)
  const nextMilestone = next.getFullYear() - y

  return { daysTogether, daysUntil, nextMilestone, origin }
}

function formatTogetherDuration(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number)
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const origin = new Date(y, m - 1, d)
  if (origin > today) return `Belum dimulai (${Math.round((origin - today) / 86400000)} hari lagi)`

  let years = today.getFullYear() - origin.getFullYear()
  let months = today.getMonth() - origin.getMonth()
  let days = today.getDate() - origin.getDate()
  if (days < 0) {
    months--
    const prevMonthLastDay = new Date(today.getFullYear(), today.getMonth(), 0).getDate()
    days += prevMonthLastDay
  }
  if (months < 0) {
    years--
    months += 12
  }
  const totalDays = Math.floor((today - origin) / 86400000)
  const parts = []
  if (years > 0) parts.push(`${years} tahun`)
  if (months > 0) parts.push(`${months} bulan`)
  parts.push(`${days} hari`)
  return `${parts.join(", ")} (Total *${totalDays} hari* 💕)`
}

function buildAnnivReport() {
  const rows = stmtGetDates.all()
  if (!rows.length) {
    return (
      `🎉 *ANNIVERSARY & TANGGAL PENTING*\n\n` +
      `Belum ada tanggal tersimpan.\n` +
      `• Set tanggal jadian: \`//anniv set 2025-02-14 Anniversary Kita\`\n` +
      `• Tambah tanggal penting: \`//anniv add 2005-08-17 | Ultah Dia\``
    )
  }

  let text = `🎉 *ANNIVERSARY & TANGGAL PENTING* 🎉\n\n`
  rows.forEach((row, idx) => {
    const info = calcDateInfo(row.date_str)
    const countdown = info.daysUntil === 0 ? "🎂 *HARI INI!* 🎉" : `*${info.daysUntil} hari lagi*`
    if (row.is_anniv) {
      text +=
        `💍 *${idx + 1}. ${row.name}* (${row.date_str})\n` +
        `   • Sudah bersama: ${formatTogetherDuration(row.date_str)}\n` +
        `   • Menuju Anniv ke-${Math.max(1, info.nextMilestone)}: ${countdown}\n\n`
    } else {
      text += `📌 *${idx + 1}. ${row.name}* (${row.date_str}) → ${countdown}\n`
    }
  })

  text +=
    `\n_Pengingat otomatis dikirim ke Owner pada H-7, H-3, H-1, dan Hari H._\n` +
    `_Kelola: \`//anniv set YYYY-MM-DD [Nama]\` | \`//anniv add YYYY-MM-DD | Nama\` | \`//anniv del [nomor]\`_`
  return text
}

async function checkImportantDateReminders(sock) {
  if (!sock) return
  try {
    const { dayKey } = getLocalDateParts()
    const notifyDays = new Set([7, 3, 1, 0])
    const rows = stmtGetDates.all()

    for (const row of rows) {
      const info = calcDateInfo(row.date_str)
      if (!notifyDays.has(info.daysUntil)) continue
      const tag = `${dayKey}:H-${info.daysUntil}`
      if (row.last_notified === tag) continue

      const headline =
        info.daysUntil === 0
          ? `🎉 *HARI H! ${row.name.toUpperCase()}!* 🎉`
          : `⏰ *PENGINGAT H-${info.daysUntil}: ${row.name}*`
      const extra = row.is_anniv ? `\n💍 Sudah bersama: ${formatTogetherDuration(row.date_str)}` : ""

      await sendToOwner(sock, {
        text: `${headline}\n📅 Tanggal: ${row.date_str}${extra}\n\n_Jangan sampai lupa ya!_ 💝`
      })
      stmtMarkDateNotified.run(tag, row.id)
    }
  } catch (err) {
    console.error("Date reminder error:", err.message)
  }
}

setInterval(() => checkImportantDateReminders(activeSock), 60 * 60 * 1000)

// ================= 5. GEMINI MULTIMODAL & PENERJEMAH KODE/MOOD VN =================
async function callGemini({ prompt, media = null, buffer = null }) {
  const apiKey = getGeminiKey()
  const model = getGeminiModel()
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY belum diisi. Set langsung via `//set gemini_key API_KEY_KAMU` di chat Owner.")
  }

  const input = [{ type: "text", text: prompt }]
  if (media && buffer) {
    if (buffer.length > MAX_AI_INLINE_BYTES) {
      throw new Error("Ukuran file terlalu besar (maksimal 18 MB untuk AI inline).")
    }
    input.push({
      type: media.kind,
      data: buffer.toString("base64"),
      mime_type: media.mime
    })
  }

  const res = await fetch("https://generativelanguage.googleapis.com/v1/interactions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey
    },
    body: JSON.stringify({
      model,
      store: false,
      system_instruction:
        "Kamu adalah asisten pribadi WhatsApp yang cerdas, peka secara emosional, ringkas, ramah, dan menjawab dalam bahasa Indonesia santai kecuali diminta lain.",
      input
    })
  })

  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error(data?.error?.message || `Gemini API HTTP ${res.status}`)
  }

  const outputText = (data.steps || [])
    .filter((step) => step.type === "model_output")
    .flatMap((step) => step.content || [])
    .filter((part) => part.type === "text" && part.text)
    .map((part) => part.text)
    .join("")
    .trim()

  return outputText || "(AI tidak mengembalikan teks)"
}

// ================= LIVE CONFIG VIA WHATSAPP (//config & //set) =================
const TOGGLE_KEYS = new Set(["anti_delete", "anti_edit", "auto_capture", "auto_status", "auto_vault", "image_log"])

function parseToggleValue(val = "") {
  const v = val.trim().toLowerCase()
  if (["on", "1", "true", "aktif", "nyala", "yes", "ya"].includes(v)) return "on"
  if (["off", "0", "false", "mati", "nonaktif", "no", "tidak"].includes(v)) return "off"
  return null
}

function triggerPanic(wipeCache = false) {
  if (getCfg("panic_mode") !== "on") {
    const snapshot = {}
    for (const key of TOGGLE_KEYS) {
      snapshot[key] = getCfg(key)
    }
    setCfg("panic_snapshot", JSON.stringify(snapshot))
  }

  for (const key of TOGGLE_KEYS) {
    setCfg(key, "off")
  }
  setCfg("panic_mode", "on")

  let wipedCount = 0
  if (wipeCache) {
    try {
      const res = db.prepare(`DELETE FROM messages`).run()
      wipedCount = res.changes || 0
      db.exec("VACUUM")
    } catch (err) {
      console.error("Panic wipe error:", err.message)
    }
  }

  return (
    `🛑 *PANIC / STEALTH MODE AKTIF*\n\n` +
    `• Semua fitur otomatis (*Anti-Delete, Anti-Edit, Auto-Capture, Auto-Status, Auto-Vault, Image Log*) telah *DIMATIKAN*.\n` +
    (wipeCache
      ? `• Cache pesan DB dibersihkan (*${wipedCount}* pesan dihapus + VACUUM).\n`
      : `• Cache pesan DB tetap aman (pakai \`//panic wipe\` jika mau sekalian bersihkan cache).\n`) +
    `\nKetik \`//resume\` kapan saja untuk menyalakan semuanya kembali.`
  )
}

function triggerResume() {
  let restored = null
  try {
    const raw = getCfg("panic_snapshot")
    if (raw) restored = JSON.parse(raw)
  } catch {
    restored = null
  }

  for (const key of TOGGLE_KEYS) {
    const targetVal = restored && (restored[key] === "on" || restored[key] === "off") ? restored[key] : "on"
    setCfg(key, targetVal)
  }
  setCfg("panic_mode", "off")
  setCfg("panic_snapshot", "")

  const onOff = (k) => (isEnabled(k) ? "✅ ON" : "⛔ OFF")
  return (
    `✅ *BOT KEMBALI NORMAL (RESUME)*\n\n` +
    `• \`anti_delete\` : ${onOff("anti_delete")}\n` +
    `• \`anti_edit\` : ${onOff("anti_edit")}\n` +
    `• \`auto_capture\` : ${onOff("auto_capture")}\n` +
    `• \`auto_status\` : ${onOff("auto_status")}\n` +
    `• \`auto_vault\` : ${onOff("auto_vault")}\n` +
    `• \`image_log\` : ${onOff("image_log")}`
  )
}

function buildConfigReport() {
  const anniv = stmtGetAnniv.get()
  const ultah = stmtGetDateByName.get("Ultah Pasangan")
  const ultahOwner = stmtGetDateByName.get("Ultah Kamu")
  const onOff = (k) => (isEnabled(k) ? "✅ ON" : "⛔ OFF")
  const panicBanner = getCfg("panic_mode") === "on" ? `🛑 *PANIC MODE SEDANG AKTIF!* (Ketik \`//resume\` untuk normal)\n\n` : ""

  return (
    `⚙️ *KONFIGURASI BOT (LIVE)* ⚙️\n` +
    `_(Tersimpan permanen di SQLite, langsung aktif tanpa restart)_\n\n` +
    panicBanner +
    `👤 *Akun & Target*\n` +
    `• \`owner\` : *${getOwnerNumber()}*\n` +
    `• \`target\` : *${getTargetNumber()}*\n` +
    `• \`target_lid\` : \`${getTargetLid() || "(auto-detect)"}\`\n\n` +
    `📅 *Tanggal Spesial*\n` +
    `• \`anniv\` : ${anniv ? `*${anniv.date_str}* (${anniv.name})` : "(belum diset)"}\n` +
    `• \`ultah\` : ${ultah ? `*${ultah.date_str}* (${ultah.name})` : "(belum diset)"}\n` +
    `• \`ultah_owner\` : ${ultahOwner ? `*${ultahOwner.date_str}*` : "(belum diset)"}\n\n` +
    `🤖 *AI & Database*\n` +
    `• \`gemini_key\` : \`${maskSecret(getGeminiKey())}\`\n` +
    `• \`gemini_model\` : \`${getGeminiModel()}\`\n` +
    `• \`retention_days\` : *${getRetentionDays()} hari*\n\n` +
    `🛡️ *Saklar Fitur Otomatis*\n` +
    `• \`anti_delete\` : ${onOff("anti_delete")}\n` +
    `• \`anti_edit\` : ${onOff("anti_edit")}\n` +
    `• \`auto_capture\` : ${onOff("auto_capture")}\n` +
    `• \`auto_status\` : ${onOff("auto_status")}\n` +
    `• \`auto_vault\` : ${onOff("auto_vault")}\n` +
    `• \`image_log\` : ${onOff("image_log")}\n\n` +
    `📝 *Cara Ubah Cepat di Chat Owner:*\n` +
    `• \`//set target 62812xxxx\`\n` +
    `• \`//set owner 62851xxxx\`\n` +
    `• \`//set target_lid 12345@lid\` (atau \`clear\`)\n` +
    `• \`//set anniv 2025-02-14\`\n` +
    `• \`//ultah 2005-08-17\` | \`//set ultah_owner 2005-05-10\`\n` +
    `• \`//set gemini_key AIza...\` (atau \`clear\`)\n` +
    `• \`//set retention_days 14\`\n` +
    `• \`//set auto_status off\` (ON/OFF saklar apa saja)\n` +
    `• \`//panic\` / \`//panic wipe\` / \`//resume\`\n` +
    `• \`//config reset <key|all>\``
  )
}

async function handleConfigSet(sock, keyRaw, valueRaw) {
  const key = (keyRaw || "").trim().toLowerCase()
  const val = (valueRaw || "").trim()

  if (!key || !val) {
    return `❌ Format: \`//set <key> <nilai>\`\nContoh: \`//set target 62895xxxx\` atau \`//set ultah 2005-08-17\`\nKetik \`//config\` untuk lihat semua key.`
  }

  if (key === "owner") {
    const phone = normalizePhone(val)
    if (phone.length < 8) return `❌ Nomor owner tidak valid. Contoh: \`//set owner 6285187809003\``
    setCfg("owner", phone)
    return `✅ *OWNER* diubah ke *${phone}*!\n_(Semua hasil bot mulai sekarang dikirim ke nomor ini.)_`
  }

  if (key === "target") {
    const phone = normalizePhone(val)
    if (phone.length < 8) return `❌ Nomor target tidak valid. Contoh: \`//set target 62895369909944\``
    setCfg("target", phone)
    setCfg("target_lid", "")
    let lidNote = "(akan terdeteksi otomatis saat chat masuk)"
    if (sock?.signalRepository?.lidMapping) {
      try {
        const lid = await sock.signalRepository.lidMapping.getLIDForPN(`${phone}@s.whatsapp.net`)
        if (lid) {
          const normLid = jidNormalizedUser(lid)
          setCfg("target_lid", normLid)
          lidNote = `\`${normLid}\``
        }
      } catch {}
    }
    return `✅ *TARGET* diubah ke *${phone}*!\n• LID: ${lidNote}`
  }

  if (key === "target_lid") {
    if (["clear", "none", "hapus", "-"].includes(val.toLowerCase())) {
      setCfg("target_lid", "")
      return `✅ *TARGET_LID* dikosongkan (kembali auto-detect dari nomor target).`
    }
    const lid = val.includes("@lid") ? jidNormalizedUser(val) : `${val.replace(/\D/g, "")}@lid`
    setCfg("target_lid", lid)
    return `✅ *TARGET_LID* diubah ke \`${lid}\`!`
  }

  if (key === "gemini_key") {
    if (["clear", "none", "hapus", "off"].includes(val.toLowerCase())) {
      setCfg("gemini_key", "")
      return `✅ *GEMINI_API_KEY* dihapus (fitur AI dimatikan).`
    }
    setCfg("gemini_key", val)
    return `✅ *GEMINI_API_KEY* diperbarui (\`${maskSecret(val)}\`)!\nAI langsung aktif dengan model \`${getGeminiModel()}\`.`
  }

  if (key === "gemini_model") {
    setCfg("gemini_model", val)
    return `✅ *GEMINI_MODEL* diubah ke \`${val}\`!`
  }

  if (key === "retention_days") {
    const days = parseInt(val, 10)
    if (!Number.isFinite(days) || days < 1 || days > 365) {
      return `❌ \`retention_days\` harus angka antara 1 sampai 365.`
    }
    setCfg("retention_days", String(days))
    cleanupDatabase()
    return `✅ *Auto-Cleanup DB* diubah menjadi *${days} hari*!`
  }

  if (key === "anniv") {
    const [dateStr, ...nameParts] = val.split(/\s+/)
    const name = nameParts.join(" ").trim() || "Anniversary Kita"
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr || "") || Number.isNaN(new Date(`${dateStr}T00:00:00`).getTime())) {
      return `❌ Format tanggal salah. Contoh: \`//set anniv 2025-02-14 Anniversary Kita\``
    }
    upsertNamedImportantDate({ name, dateStr, isAnniv: 1 })
    return `✅ *Anniversary* diset ke *${dateStr}* (${name})!\n\n${buildAnnivReport()}`
  }

  if (key === "ultah" || key === "ultah_owner") {
    const [dateStr, ...nameParts] = val.split(/\s+/)
    const defaultName = key === "ultah" ? "Ultah Pasangan" : "Ultah Kamu"
    const name = nameParts.join(" ").trim() || defaultName
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr || "") || Number.isNaN(new Date(`${dateStr}T00:00:00`).getTime())) {
      return `❌ Format tanggal salah. Contoh: \`//set ${key} 2005-08-17\``
    }
    upsertNamedImportantDate({ name, dateStr, isAnniv: 0 })
    return `✅ *${name}* diset ke *${dateStr}*!\n_(Auto-reminder aktif di H-7, H-3, H-1, & Hari H.)_`
  }

  if (TOGGLE_KEYS.has(key)) {
    const parsed = parseToggleValue(val)
    if (!parsed) return `❌ Nilai harus \`on\` atau \`off\`. Contoh: \`//set ${key} off\``
    setCfg(key, parsed)
    return `✅ Fitur \`${key}\` sekarang *${parsed === "on" ? "ON ✅" : "OFF ⛔"}*.`
  }

  return `❌ Key \`${key}\` tidak dikenal. Ketik \`//config\` untuk melihat daftar key yang tersedia.`
}

// ================= ANTI-EDIT HANDLER (KHUSUS TARGET) =================
async function handleAntiEdit(sock, key, editedRawMessage) {
  if (!isEnabled("anti_edit")) return
  const originalId = key?.id
  const chatJid = key?.remoteJid
  if (!originalId || !chatJid || chatJid === "status@broadcast" || chatJid.endsWith("@g.us")) return

  const chatInfo = await resolveJidInfo(sock, chatJid, key.remoteJidAlt)
  if (!isTargetEntity(chatInfo)) return

  const newText = extractTextFromMessage(editedRawMessage)
  if (!newText) return
  if (!markEditProcessed(`${originalId}:${newText}`)) return

  const old = getMsg(originalId)
  const oldText = old ? extractTextFromMessage(old) : ""
  if (!oldText || oldText === newText) {
    saveMsg(originalId, chatJid, editedRawMessage)
    return
  }

  await sendToOwner(sock, {
    text:
      `✏️ *ANTI-EDIT (TARGET)*\n` +
      `Nomor: ${chatInfo.number || getTargetNumber()}${chatInfo.lid ? ` (${chatInfo.lid})` : ""}\n\n` +
      `*Sebelum:*\n${oldText}\n\n` +
      `*Sesudah:*\n${newText}`
  })

  saveMsg(originalId, chatJid, editedRawMessage)
}

// ================= PANEL HTTP PORT (status saja, tanpa Express) =================
// Panel mewajibkan app listen di 0.0.0.0:PORT agar terbaca dari luar.
const PANEL_PORT = Number(process.env.PORT || process.env.SERVER_PORT || 3000)
require("http")
  .createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" })
    res.end("Bot WA berjalan")
  })
  .listen(PANEL_PORT, "0.0.0.0", () => console.log(`🌐 HTTP READY ON PORT ${PANEL_PORT}`))

// ================= BOT ENGINE =================
async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState("./auth")
  const { version } = await fetchLatestBaileysVersion()

  const sock = makeWASocket({
    version,
    logger,
    printQRInTerminal: false,
    browser: Browsers.ubuntu("Chrome"),
    auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
    getMessage: async (key) => getMsg(key.id),
    markOnlineOnConnect: false,
    syncFullHistory: false
  })

  activeSock = sock
  sock.ev.on("creds.update", saveCreds)

  // Pantau update mapping LID <-> Nomor WA otomatis (Baileys v7)
  sock.ev.on("lid-mapping.update", (mapping) => {
    if (mapping?.pn && mapping?.lid && normalizePhone(mapping.pn) === getTargetNumber()) {
      const lid = jidNormalizedUser(mapping.lid)
      setCfg("target_lid", lid)
      console.log(`🔗 TARGET LID TERDETEKSI OTOMATIS: ${lid} (${getTargetNumber()})`)
    }
  })

  // Login pakai kode pairing (tanpa QR). Isi PAIRING_NUMBER di .env, contoh 6285187809003
  const PAIRING_NUMBER = (process.env.PAIRING_NUMBER || "").replace(/\D/g, "")
  if (PAIRING_NUMBER && !sock.authState.creds.registered) {
    setTimeout(async () => {
      try {
        const code = await sock.requestPairingCode(PAIRING_NUMBER)
        console.log(`🔑 KODE PAIRING WHATSAPP: ${code?.match(/.{1,4}/g)?.join("-") || code}`)
      } catch (err) {
        console.log("❌ GAGAL MEMINTA KODE PAIRING:", err?.message || err)
      }
    }, 3000)
  }

  sock.ev.on("connection.update", async (up) => {
    if (up.qr && !PAIRING_NUMBER) qrcode.generate(up.qr, { small: true })
    if (up.connection === "open") {
      if (!getTargetLid() && getTargetPn() && sock.signalRepository?.lidMapping) {
        try {
          const lid = await sock.signalRepository.lidMapping.getLIDForPN(getTargetPn())
          if (lid) setCfg("target_lid", jidNormalizedUser(lid))
        } catch {}
      }
      console.log(
        `✅ BOT CONNECTED | OWNER: ${getOwnerNumber()} | TARGET: ${getTargetNumber()}${getTargetLid() ? ` (${getTargetLid()})` : ""} | AI: ${getGeminiKey() ? getGeminiModel() : "OFF"}`
      )
      setTimeout(() => checkImportantDateReminders(sock), 5000)
    }
    if (up.connection === "close") {
      const statusCode = up.lastDisconnect?.error instanceof Boom ? up.lastDisconnect.error.output.statusCode : 0
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut

      console.log(`🔌 CONNECTION CLOSED: ${up.lastDisconnect?.error?.message || "Unknown reason"}. Reconnecting: ${shouldReconnect}`)

      if (shouldReconnect) {
        setTimeout(startBot, 3000)
      } else {
        console.log("🚨 LOGGED OUT. Clearing session and exiting...")
        try {
          db.close()
        } catch {}
        if (fs.existsSync("./auth")) {
          fs.rmSync("./auth", { recursive: true, force: true })
        }
        process.exit(0)
      }
    }
  })

  // ================= EVENT: messages.update (ANTI-EDIT & READ RECEIPT DM) =================
  sock.ev.on("messages.update", async (updates) => {
    for (const item of updates) {
      try {
        // 1) Read / Delivery receipt untuk DM (Baileys v7 mengirim status lewat messages.update)
        if (typeof item?.update?.status === "number" && item?.key?.id) {
          recordReceiptStatus(item.key.id, item.update.status, item.update.messageTimestamp)
        }
        // 2) Anti-Edit khusus chat Target
        const edited = item?.update?.message?.editedMessage?.message
        if (edited) {
          await handleAntiEdit(sock, item.key, edited)
        }
      } catch (err) {
        console.error("messages.update error:", err.message)
      }
    }
  })

  // ================= EVENT: message-receipt.update =================
  sock.ev.on("message-receipt.update", (receipts) => {
    for (const item of receipts) {
      const msgId = item?.key?.id
      const rc = item?.receipt
      if (!msgId || !rc) continue
      if (rc.readTimestamp) {
        recordReceiptStatus(msgId, proto.WebMessageInfo.Status.READ, rc.readTimestamp)
      } else if (rc.receiptTimestamp) {
        recordReceiptStatus(msgId, proto.WebMessageInfo.Status.DELIVERY_ACK, rc.receiptTimestamp)
      }
    }
  })

  // ================= EVENT: messages.reaction (FAVORIT MEMORY VAULT) =================
  sock.ev.on("messages.reaction", async (reactions) => {
    for (const item of reactions) {
      try {
        const emoji = item?.reaction?.text
        const targetMsgId = item?.key?.id
        const chatJid = item?.key?.remoteJid
        if (!emoji || !targetMsgId || !chatJid || !FAVORITE_EMOJIS.has(emoji)) continue

        const chatInfo = await resolveJidInfo(sock, chatJid, item?.key?.remoteJidAlt)
        if (!isTargetEntity(chatInfo)) continue

        const reactFromOwner = Boolean(item?.reaction?.key?.fromMe)
        if (!reactFromOwner) continue

        const vaulted = stmtGetVaultByMsg.get(targetMsgId)
        if (vaulted && !vaulted.is_favorite) {
          stmtSetVaultFavorite.run(targetMsgId)
          await sendToOwner(sock, {
            text: `⭐ *MEMORY VAULT FAVORIT*\nKenangan (${vaulted.media_type}) dari \`memories/${vaulted.month_key}\` ditandai favorit karena reaksi ${emoji}!`
          })
        }
      } catch (err) {
        console.error("Reaction vault error:", err.message)
      }
    }
  })

  // ================= MAIN MESSAGE HANDLER =================
  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return
    for (const msg of messages) {
      if (!msg.message) continue

      const id = msg.key.id
      if (id && botSentIds.has(id)) continue

      const jid = msg.key.remoteJid
      if (!jid) continue

      // ================= AUTO-CAPTURE STATUS WA TARGET (+ MEMORY VAULT) =================
      if (jid === "status@broadcast") {
        if (!isEnabled("auto_status")) continue
        try {
          const statusSender = await resolveJidInfo(sock, msg.key.participant, msg.key.participantAlt)
          if (isTargetEntity(statusSender)) {
            const statusMedia = extractMediaFromMessage(msg.message)
            const statusCaption = extractTextFromMessage(msg.message)
            const header =
              `📲 *STATUS WA TARGET*\n` +
              `Nomor: ${statusSender.number || getTargetNumber()}\n` +
              `LID: ${statusSender.lid || "-"}` +
              (statusCaption ? `\n\nCaption:\n${statusCaption}` : "")

            if (statusMedia && ["image", "video", "audio"].includes(statusMedia.kind)) {
              const buffer = await downloadStreamToBuffer(statusMedia.msg, statusMedia.kind)
              const vaultPath = isEnabled("auto_vault")
                ? saveToMemoryVault({
                    msgId: id,
                    source: "status",
                    media: statusMedia,
                    buffer,
                    caption: statusCaption
                  })
                : null
              await sendMediaToOwner(sock, statusMedia, buffer, `${header}${vaultPath ? `\nVault: ${vaultPath}` : ""}`)
            } else if (statusCaption) {
              await sendToOwner(sock, { text: header })
            }
          }
        } catch (err) {
          console.error("Status capture error:", err.message)
        }
        continue
      }

      const isGroup = jid.endsWith("@g.us")
      const senderRaw = msg.key.participant || jid
      const senderAlt = isGroup ? msg.key.participantAlt : msg.key.remoteJidAlt

      const normalizedMsg = normalizeMessageContent(msg.message) || msg.message
      const protocolMsg = normalizedMsg?.protocolMessage || msg.message.protocolMessage

      try {
        const chatInfo = await resolveJidInfo(sock, jid, msg.key.remoteJidAlt)
        const senderInfo = isGroup ? await resolveJidInfo(sock, senderRaw, senderAlt) : chatInfo
        const isOwnerOrSelf = Boolean(msg.key.fromMe) || isOwnerEntity(senderInfo)
        const isTargetChat = !isGroup && isTargetEntity(chatInfo)
        const isOwnerChat = !isGroup && isOwnerEntity(chatInfo)

        const body = extractTextFromMessage(msg.message)
        const trimmedBody = body.trim()
        const cmd = trimmedBody.toLowerCase()
        const isDoubleSlashCmd = cmd.startsWith("//")

        const contextInfo = getContextInfo(msg.message)
        const quoted = contextInfo?.quotedMessage || null
        const quotedMedia = extractMediaFromMessage(quoted)
        const directMedia = extractMediaFromMessage(msg.message)

        // ================= LOG CONSOLE SETIAP OWNER REPLY IMAGE (DI CHAT SIAPA PUN - HANYA CONSOLE) =================
        if (isEnabled("image_log") && isOwnerOrSelf && quotedMedia?.kind === "image") {
          const quotedSenderInfo = contextInfo?.participant
            ? await resolveJidInfo(sock, contextInfo.participant, null)
            : chatInfo

          console.log("\n================= 📸 REPLY IMAGE LOG =================")
          console.log(`Waktu        : ${new Date().toLocaleString("id-ID")}`)
          console.log(`Tipe Chat    : ${isGroup ? "Grup" : "Private Chat"}`)
          console.log(`Chat JID     : ${chatInfo.raw}`)
          console.log(`Chat Nomor   : ${chatInfo.number || "-"}`)
          console.log(`Chat LID     : ${chatInfo.lid || "-"}`)
          if (isGroup) {
            console.log(`Pengirim Foto: ${quotedSenderInfo.raw}`)
            console.log(`Nomor Foto   : ${quotedSenderInfo.number || "-"}`)
            console.log(`LID Foto     : ${quotedSenderInfo.lid || "-"}`)
          }
          console.log(`View-Once    : ${isViewOnceMessage(quoted) ? "Ya" : "Tidak"}`)
          console.log(`Pesan Reply  : ${body || "(tanpa teks)"}`)
          console.log("======================================================\n")
        }

        // ================= FILTER KETAT: DI LUAR CHAT TARGET & OWNER CHAT -> STOP =================
        if (!isTargetChat && !isOwnerChat) continue

        // ================= FITUR OTOMATIS KHUSUS CHAT TARGET =================
        if (isTargetChat) {
          // 1) Simpan pesan ke SQLite untuk Anti-Delete & Anti-Edit (skip protocolMessage & command //)
          if (!protocolMsg && !isDoubleSlashCmd) {
            saveMsg(id, jid, msg.message)

            // 2) Rekam statistik Kecepatan Balas & Couple Wrapped
            const senderRole = msg.key.fromMe ? "me" : "target"
            const now = Date.now()
            recordReplyMetricTurn(id, senderRole, now)
            recordCoupleMessage(id, senderRole, msg.message, body, now)

            // 3) Auto Memory Vault (simpan diam-diam foto/video/VN dari chat target ke memories/YYYY-MM/)
            if (isEnabled("auto_vault") && directMedia && ["image", "video", "audio"].includes(directMedia.kind)) {
              downloadStreamToBuffer(directMedia.msg, directMedia.kind)
                .then((buf) => {
                  const source = isViewOnceMessage(msg.message) ? "viewonce" : "chat"
                  saveToMemoryVault({
                    msgId: id,
                    source,
                    media: directMedia,
                    buffer: buf,
                    caption: body
                  })
                })
                .catch((err) => console.error("Auto-vault error:", err.message))
            }
          }

          // 4) ANTI-DELETE (Khusus Chat Target -> Kirim ke Owner)
          if (isEnabled("anti_delete") && protocolMsg?.type === proto.Message.ProtocolMessage.Type.REVOKE) {
            const old = getMsg(protocolMsg.key.id)
            if (old) {
              await sendToOwner(sock, {
                text: `🚨 *ANTI-DELETE (TARGET)*\nNomor: ${chatInfo.number || getTargetNumber()}${chatInfo.lid ? ` (${chatInfo.lid})` : ""}`
              })
              await sendToOwner(sock, { forward: { key: protocolMsg.key, message: old } })
            }
            continue
          }

          // 5) ANTI-EDIT FALLBACK VIA UPSERT (Khusus Chat Target -> Kirim ke Owner)
          if (isEnabled("anti_edit") && protocolMsg?.type === proto.Message.ProtocolMessage.Type.MESSAGE_EDIT && protocolMsg.editedMessage) {
            await handleAntiEdit(sock, { ...msg.key, id: protocolMsg.key?.id }, protocolMsg.editedMessage)
            continue
          }
        }

        // ================= SEMUA COMMAND (//) HANYA UNTUK OWNER =================
        if (isDoubleSlashCmd) {
          if (!isOwnerOrSelf) continue

          // ---------- //config, //cfg, //set, //ultah (LIVE CONFIG VIA WA) ----------
          if (cmd === "//config" || cmd === "//cfg" || cmd.startsWith("//config ") || cmd.startsWith("//cfg ")) {
            const args = trimmedBody.replace(/^\/\/(config|cfg)\s*/i, "").trim()
            if (!args) {
              await sendToOwner(sock, { text: buildConfigReport() })
            } else if (args.toLowerCase().startsWith("set ")) {
              const rest = args.slice(4).trim()
              const spaceIdx = rest.indexOf(" ")
              const key = spaceIdx === -1 ? rest : rest.slice(0, spaceIdx)
              const val = spaceIdx === -1 ? "" : rest.slice(spaceIdx + 1)
              const resMsg = await handleConfigSet(sock, key, val)
              await sendToOwner(sock, { text: resMsg })
            } else if (args.toLowerCase().startsWith("reset ")) {
              const key = args.slice(6).trim().toLowerCase()
              if (key === "all" || Object.prototype.hasOwnProperty.call(ENV_DEFAULTS, key)) {
                resetCfg(key)
                await sendToOwner(sock, { text: `♻️ Config \`${key}\` dikembalikan ke nilai default \`.env\`.` })
              } else {
                await sendToOwner(sock, { text: `❌ Key \`${key}\` tidak dikenal. Gunakan \`//config reset all\` atau nama key di \`//config\`.` })
              }
            } else {
              await sendToOwner(sock, { text: buildConfigReport() })
            }
            continue
          }

          if (cmd === "//set" || cmd.startsWith("//set ")) {
            const rest = trimmedBody.slice(5).trim()
            const spaceIdx = rest.indexOf(" ")
            const key = spaceIdx === -1 ? rest : rest.slice(0, spaceIdx)
            const val = spaceIdx === -1 ? "" : rest.slice(spaceIdx + 1)
            const resMsg = await handleConfigSet(sock, key, val)
            await sendToOwner(sock, { text: resMsg })
            continue
          }

          if (cmd === "//ultah" || cmd.startsWith("//ultah ")) {
            const rest = trimmedBody.slice(7).trim()
            if (!rest) {
              await sendToOwner(sock, {
                text: `🎂 *SET ULTAH*\n• Ultah Pasangan: \`//ultah 2005-08-17\`\n• Ultah Kamu: \`//set ultah_owner 2005-05-10\`\n\n${buildAnnivReport()}`
              })
            } else {
              const resMsg = await handleConfigSet(sock, "ultah", rest)
              await sendToOwner(sock, { text: resMsg })
            }
            continue
          }

          // ---------- //panic & //resume (STEALTH SEKETIKA) ----------
          if (cmd === "//panic" || cmd.startsWith("//panic ")) {
            const sub = trimmedBody.split(/\s+/)[1]?.toLowerCase()
            const wipeCache = sub === "wipe" || sub === "clear" || sub === "hapus"
            await sendToOwner(sock, { text: triggerPanic(wipeCache) })
            continue
          }

          if (cmd === "//resume") {
            await sendToOwner(sock, { text: triggerResume() })
            continue
          }

          // ---------- //menu & //help ----------
          if (cmd === "//menu" || cmd === "//help") {
            const panicNote = getCfg("panic_mode") === "on" ? `🛑 *STATUS: PANIC MODE AKTIF* (ketik \`//resume\`)\n\n` : ""
            const menuText =
`🤖 *PANDUAN BOT WHATSAPP PRIBADI* 🤖
━━━━━━━━━━━━━━━━━━━━
🔒 *Aturan:* Semua perintah pakai \`//\`, khusus Owner, hanya aktif untuk Target, dan hasilnya selalu dikirim privat ke Owner.
${panicNote}
🚨 *1. DARURAT / STEALTH*
• \`//panic\` → Matikan semua fitur otomatis seketika.
• \`//panic wipe\` → Matikan fitur + bersihkan cache pesan DB.
• \`//resume\` → Nyalakan kembali semua fitur otomatis.

⚙️ *2. PENGATURAN LIVE (TANPA EDIT KODE)*
• \`//config\` → Lihat semua setting & saklar ON/OFF.
• \`//set target 628xxxx\` → Ganti nomor target.
• \`//set owner 628xxxx\` → Ganti nomor owner.
• \`//ultah 2005-08-17\` → Set ultah pasangan.
• \`//set anniv 2025-02-14\` → Set tanggal jadian.
• \`//set gemini_key AIza...\` → Pasang API key Gemini.
• \`//set anti_delete off\` → ON/OFF saklar fitur tertentu.

💑 *3. FITUR PASANGAN & STATISTIK*
• \`//speed\` → Rata-rata kecepatan balas & *Read-to-Reply* (7 hari / \`//speed all\`).
• \`//wrapped\` → *Couple Wrapped* ala Spotify (30 hari / \`//wrapped all\`).
• \`//vault\` → Info arsip kenangan \`memories/YYYY-MM/\`.
• \`//vault random\` / \`//vault fav\` → Kirim kenangan acak / favorit (reaksi ❤️/⭐ = favorit).
• \`//anniv\` → Cek hari bersama & countdown ultah/anniv.
• \`//anniv add 2026-12-25 | Nama\` → Tambah tanggal penting.
• \`//anniv del 1\` → Hapus tanggal penting no. 1.

🤖 *4. AI MULTIMODAL & PENERJEMAH KODE*
• \`//vn\` → Reply VN → transkrip + deteksi mood/nada + saran balasan.
• \`//kode\` → Reply chat/VN/screenshot → terjemahkan "kode" pasangan + 3 opsi balasan.
• \`//ocr\` → Reply foto → salin semua teks di gambar.
• \`//ai [tanya]\` → Tanya AI (bisa reply teks, foto, VN, video, PDF).

📥 *5. MEDIA & FITUR WA MODERN*
• \`//dl\` → Reply foto/video/VN (termasuk *view-once*) → simpan & kirim ke Owner.
• \`//vo\` → Reply/kirim media → kirim ulang sebagai *View-Once*.
• \`//pin 24h\` / \`//unpin\` → Reply pesan utk pin (\`24h\`/\`7d\`/\`30d\`) atau unpin.
• \`//poll Tanya | Opsi 1 | Opsi 2\` → Buat polling (tambah \`--multi\` utk pilih banyak).
• \`//event Nama | 2026-11-25 19:00 | Catatan\` → Buat jadwal Event WA.
• \`//stats\` → Cek RAM, uptime, DB, & status bot.

🛡️ *6. BERJALAN OTOMATIS (KHUSUS TARGET)*
• Anti-Delete & Anti-Edit pesan
• Auto-Capture reply foto/video/VN (*view-once*)
• Auto-Capture Status WA Target
• Auto Memory Vault (\`memories/YYYY-MM/\`)
• Reminder Ultah & Anniv (H-7, H-3, H-1, Hari H)
━━━━━━━━━━━━━━━━━━━━
_Tip: Jalankan \`//config\`, \`//wrapped\`, \`//speed\`, atau \`//set\` di chat dirimu sendiri (Message Yourself) biar tetap privat!_`
            await sendToOwner(sock, { text: menuText })
            continue
          }

          // ---------- //stats ----------
          if (cmd === "//stats") {
            const free = (os.freemem() / 1024 / 1024).toFixed(0)
            const total = (os.totalmem() / 1024 / 1024).toFixed(0)
            const totalMsg = stmtCountMsg.get()?.total || 0
            const vaultTotals = stmtVaultTotals.get() || { total: 0, favs: 0 }
            const dbSizeKb = fs.existsSync(dbPath) ? (fs.statSync(dbPath).size / 1024).toFixed(1) : "0.0"

            await sendToOwner(sock, {
              text:
                `📊 *BOT STATS*\n` +
                `• Mode: ${getCfg("panic_mode") === "on" ? "🛑 PANIC / STEALTH" : "✅ NORMAL"}\n` +
                `• Node.js: ${process.version}\n` +
                `• RAM: ${total - free}/${total} MB\n` +
                `• Uptime Server: ${(os.uptime() / 3600).toFixed(1)} Jam\n` +
                `• Uptime Bot: ${(process.uptime() / 60).toFixed(1)} Menit\n` +
                `• Owner: ${getOwnerNumber()}\n` +
                `• Target: ${getTargetNumber()}${getTargetLid() ? ` (${getTargetLid()})` : ""}\n` +
                `• SQLite (\`node:sqlite\`): ${totalMsg} cache pesan (${dbSizeKb} KB)\n` +
                `• Auto-Cleanup Cache: > ${getRetentionDays()} hari\n` +
                `• Memory Vault: ${vaultTotals.total} arsip (${vaultTotals.favs || 0} favorit)\n` +
                `• AI Model: ${getGeminiKey() ? getGeminiModel() : "Belum aktif"}`
            })
            continue
          }

          // ---------- //speed ----------
          if (cmd === "//speed" || cmd.startsWith("//speed ")) {
            const arg = trimmedBody.split(/\s+/)[1]?.toLowerCase()
            await sendToOwner(sock, { text: buildSpeedReport(arg) })
            continue
          }

          // ---------- //wrapped ----------
          if (cmd === "//wrapped" || cmd.startsWith("//wrapped ")) {
            const arg = trimmedBody.split(/\s+/)[1]?.toLowerCase()
            await sendToOwner(sock, { text: buildCoupleWrapped(arg) })
            continue
          }

          // ---------- //vault ----------
          if (cmd === "//vault" || cmd.startsWith("//vault ")) {
            const sub = trimmedBody.split(/\s+/)[1]?.toLowerCase()
            if (sub === "random" || sub === "fav") {
              const item = sub === "fav" ? stmtVaultRandomFav.get() : stmtVaultRandom.get()
              if (!item || !fs.existsSync(item.file_path)) {
                await sendToOwner(sock, {
                  text: sub === "fav" ? `🗂️ Belum ada kenangan favorit. Reaksi ❤️/⭐ ke media target dulu!` : `🗂️ Memory Vault masih kosong.`
                })
                continue
              }
              const buf = fs.readFileSync(item.file_path)
              const dateLabel = new Date(item.timestamp).toLocaleString("id-ID")
              const cap =
                `🗂️ *THROWBACK MEMORY VAULT${item.is_favorite ? " ⭐" : ""}*\n` +
                `Tanggal: ${dateLabel}\n` +
                `Sumber: ${item.source} (\`memories/${item.month_key}\`)` +
                (item.caption ? `\nCaption: ${item.caption}` : "")
              const mimeMap = { image: "image/jpeg", video: "video/mp4", audio: "audio/ogg" }
              await sendMediaToOwner(
                sock,
                { kind: item.media_type, mime: mimeMap[item.media_type] || "application/octet-stream", ptt: item.media_type === "audio" },
                buf,
                cap
              )
            } else {
              await sendToOwner(sock, { text: buildVaultSummary() })
            }
            continue
          }

          // ---------- //anniv ----------
          if (cmd === "//anniv" || cmd.startsWith("//anniv ")) {
            const args = trimmedBody.slice(7).trim()
            if (!args) {
              await sendToOwner(sock, { text: buildAnnivReport() })
            } else if (args.toLowerCase().startsWith("set ")) {
              const rest = args.slice(4).trim()
              const [dateStr, ...nameParts] = rest.split(/\s+/)
              const name = nameParts.join(" ").trim() || "Anniversary Kita"
              if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr || "") || Number.isNaN(new Date(`${dateStr}T00:00:00`).getTime())) {
                await sendToOwner(sock, { text: `❌ Format salah. Contoh: \`//anniv set 2025-02-14 Anniversary Kita\`` })
              } else {
                if (stmtGetAnniv.get()) {
                  stmtUpdateAnniv.run(name, dateStr)
                } else {
                  stmtInsertDate.run(name, dateStr, 1)
                }
                await sendToOwner(sock, { text: `✅ Tanggal jadian disimpan!\n\n${buildAnnivReport()}` })
              }
            } else if (args.toLowerCase().startsWith("add ")) {
              const [dateStr, name] = args.slice(4).split("|").map((s) => s.trim())
              if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr || "") || !name) {
                await sendToOwner(sock, { text: `❌ Format salah. Contoh: \`//anniv add 2005-08-17 | Ultah Dia\`` })
              } else {
                stmtInsertDate.run(name, dateStr, 0)
                await sendToOwner(sock, { text: `✅ Tanggal penting *${name}* (${dateStr}) ditambahkan!` })
              }
            } else if (args.toLowerCase().startsWith("del ")) {
              const idx = parseInt(args.slice(4).trim(), 10)
              const rows = stmtGetDates.all()
              if (!idx || !rows[idx - 1]) {
                await sendToOwner(sock, { text: `❌ Nomor tidak ditemukan. Cek urutan dengan \`//anniv\`.` })
              } else {
                stmtDeleteDate.run(rows[idx - 1].id)
                await sendToOwner(sock, { text: `🗑️ Tanggal *${rows[idx - 1].name}* berhasil dihapus.` })
              }
            } else {
              await sendToOwner(sock, { text: buildAnnivReport() })
            }
            continue
          }

          // ---------- //dl atau //download ----------
          if (cmd === "//dl" || cmd === "//download") {
            if (quotedMedia && ["image", "video", "audio"].includes(quotedMedia.kind)) {
              if (!fs.existsSync(DOWNLOADS_DIR)) fs.mkdirSync(DOWNLOADS_DIR, { recursive: true })
              const buffer = await downloadStreamToBuffer(quotedMedia.msg, quotedMedia.kind)
              const filepath = path.join(DOWNLOADS_DIR, `${Date.now()}.${quotedMedia.ext}`)
              fs.writeFileSync(filepath, buffer)

              const caption =
                `📥 *DOWNLOADED ${quotedMedia.kind.toUpperCase()}*${isViewOnceMessage(quoted) ? " (VIEW-ONCE)" : ""}\n` +
                `Source: ${chatInfo.number || chatInfo.lid || getTargetNumber()}\n` +
                `Saved to: ${filepath}`
              await sendMediaToOwner(sock, quotedMedia, buffer, caption)
            } else {
              await sendToOwner(sock, { text: `❌ Reply foto, video, atau voice note dengan \`//dl\` untuk mendownload.` })
            }
            continue
          }

          // ---------- //vn atau //transcribe (TRANSKRIP + MOOD + KODE + SARAN BALASAN) ----------
          if (cmd === "//vn" || cmd === "//transcribe") {
            if (quotedMedia?.kind !== "audio") {
              await sendToOwner(sock, { text: `❌ Reply Voice Note / audio dengan \`//vn\` untuk transkrip & analisis mood.` })
              continue
            }
            try {
              const buffer = await downloadStreamToBuffer(quotedMedia.msg, "audio")
              const reply = await callGemini({
                prompt:
                  "Analisis Voice Note dari pasangan ini dalam bahasa Indonesia dengan format rapi berikut:\n" +
                  "1. *Transkrip*: tulis isi ucapannya secara akurat.\n" +
                  "2. *Ringkasan*: maksimal 3 poin singkat.\n" +
                  "3. *Mood & Nada Suara*: tebak suasana hatinya (senang, capek, manja, ngambek, cemas, bercanda, dll.) + alasan singkat dari intonasi & kata-katanya.\n" +
                  "4. *Terjemahan Kode / Makna Tersirat*: apa yang sebenarnya dia rasakan atau harapkan.\n" +
                  "5. *2 Saran Balasan*: berikan 2 contoh balasan singkat yang hangat dan natural.",
                media: quotedMedia,
                buffer
              })
              await sendToOwner(sock, { text: `🎙️ *ANALISIS & MOOD VOICE NOTE*\n\n${reply}` })
            } catch (err) {
              await sendToOwner(sock, { text: `❌ Transkrip/Mood VN Error: ${err.message}` })
            }
            continue
          }

          // ---------- //kode (PENERJEMAH KODE PASANGAN) ----------
          if (cmd === "//kode" || cmd.startsWith("//kode ")) {
            const extraContext = trimmedBody.slice(6).trim()
            const targetMedia = quotedMedia || directMedia
            const quotedText = quoted ? extractTextFromMessage(quoted) : ""

            if (!quotedText && !targetMedia && !extraContext) {
              await sendToOwner(sock, {
                text: `❌ Reply chat teks/VN/screenshot dari pasangan lalu ketik \`//kode\` (atau \`//kode dia bilang terserah\`).`
              })
              continue
            }

            try {
              let buffer = null
              if (targetMedia) {
                buffer = await downloadStreamToBuffer(targetMedia.msg, targetMedia.kind)
              }
              const prompt =
                "Kamu adalah ahli membaca 'kode' dan psikologi komunikasi pasangan. Analisis pesan/media ini dengan format rapi:\n" +
                "1. *Status Mood & Level* (contoh: Aman 🟢 / Butuh Perhatian 🟡 / Siaga Ngambek 🔴)\n" +
                "2. *Terjemahan Kode Sebenarnya*: arti tersirat di balik kalimat/nada ini.\n" +
                "3. *Yang Sebaiknya Jangan Dilakukan*: 1 hal yang harus dihindari.\n" +
                "4. *3 Opsi Balasan Terbaik*: (a) Manis/Romantis, (b) Tenang/Dewasa, (c) Bercanda Ringan.\n\n" +
                (quotedText ? `Pesan pasangan: "${quotedText}"\n` : "") +
                (extraContext ? `Konteks tambahan: ${extraContext}` : "")

              const reply = await callGemini({ prompt, media: targetMedia, buffer })
              await sendToOwner(sock, { text: `🕵️ *PENERJEMAH KODE PASANGAN*\n\n${reply}` })
            } catch (err) {
              await sendToOwner(sock, { text: `❌ Penerjemah Kode Error: ${err.message}` })
            }
            continue
          }

          // ---------- //ocr ----------
          if (cmd === "//ocr") {
            const targetImg = quotedMedia?.kind === "image" ? quotedMedia : (directMedia?.kind === "image" ? directMedia : null)
            if (!targetImg) {
              await sendToOwner(sock, { text: `❌ Reply foto (atau kirim foto dengan caption \`//ocr\`) untuk ekstrak teks.` })
              continue
            }
            try {
              const buffer = await downloadStreamToBuffer(targetImg.msg, "image")
              const reply = await callGemini({
                prompt: "Ekstrak dan salin seluruh teks yang ada di dalam gambar ini secara persis dan rapi tanpa tambahan komentar.",
                media: targetImg,
                buffer
              })
              await sendToOwner(sock, { text: `📝 *HASIL OCR*\n\n${reply}` })
            } catch (err) {
              await sendToOwner(sock, { text: `❌ OCR Error: ${err.message}` })
            }
            continue
          }

          // ---------- //ai ----------
          if (cmd === "//ai" || cmd.startsWith("//ai ")) {
            const userPrompt = trimmedBody.slice(4).trim()
            const targetMedia = quotedMedia || directMedia
            const quotedText = quoted ? extractTextFromMessage(quoted) : ""

            if (!userPrompt && !targetMedia && !quotedText) {
              await sendToOwner(sock, { text: `❌ Contoh: \`//ai ide kado ultah\` atau reply foto/VN/PDF dengan \`//ai ringkas ini\`` })
              continue
            }
            try {
              let buffer = null
              if (targetMedia) {
                buffer = await downloadStreamToBuffer(targetMedia.msg, targetMedia.kind)
              }
              const finalPrompt =
                (userPrompt || "Jelaskan atau ringkas isi konten ini secara jelas dan padat.") +
                (quotedText && !targetMedia ? `\n\nTeks referensi:\n${quotedText}` : "")

              const reply = await callGemini({ prompt: finalPrompt, media: targetMedia, buffer })
              await sendToOwner(sock, { text: `🤖 *AI (${getGeminiModel()})*\n\n${reply}` })
            } catch (err) {
              await sendToOwner(sock, { text: `❌ AI Error: ${err.message}` })
            }
            continue
          }

          // ---------- //pin & //unpin ----------
          if (cmd === "//pin" || cmd.startsWith("//pin ") || cmd === "//unpin") {
            if (!contextInfo?.stanzaId) {
              await sendToOwner(sock, { text: `❌ Reply pesan yang ingin di-${cmd === "//unpin" ? "unpin" : "pin"}.` })
              continue
            }
            const pinKey = {
              id: contextInfo.stanzaId,
              remoteJid: jid,
              fromMe: isQuotedFromMe(sock, contextInfo)
            }
            if (cmd === "//unpin") {
              await sendToChat(sock, jid, { pin: pinKey, type: proto.PinInChat.Type.UNPIN_FOR_ALL })
            } else {
              const durArg = trimmedBody.split(/\s+/)[1]?.toLowerCase()
              const durationMap = { "24h": 86400, "7d": 604800, "30d": 2592000 }
              await sendToChat(sock, jid, { pin: pinKey, type: proto.PinInChat.Type.PIN_FOR_ALL, time: durationMap[durArg] || 86400 })
            }
            continue
          }

          // ---------- //poll ----------
          if (cmd.startsWith("//poll ")) {
            let rawArgs = trimmedBody.slice(7).trim()
            let selectableCount = 1
            if (rawArgs.toLowerCase().startsWith("--multi ")) {
              selectableCount = 0
              rawArgs = rawArgs.slice(8).trim()
            }
            const parts = rawArgs.split("|").map((s) => s.trim()).filter(Boolean)
            if (parts.length < 3 || parts.length > 13) {
              await sendToOwner(sock, {
                text: `❌ Format: \`//poll Pertanyaan | Opsi 1 | Opsi 2\` (min 2 opsi, maks 12). Tambah \`--multi\` untuk pilihan ganda.`
              })
              continue
            }
            await sendToChat(sock, jid, {
              poll: { name: parts[0], values: parts.slice(1), selectableCount }
            })
            continue
          }

          // ---------- //event ----------
          if (cmd.startsWith("//event ")) {
            const parts = trimmedBody.slice(8).split("|").map((s) => s.trim())
            const name = parts[0]
            const dateStr = parts[1]
            const description = parts[2] || ""

            if (!name || !dateStr) {
              await sendToOwner(sock, {
                text: `❌ Format: \`//event Nama Acara | YYYY-MM-DD HH:mm | Deskripsi (opsional)\``
              })
              continue
            }
            const startDate = new Date(dateStr.replace(" ", "T"))
            if (Number.isNaN(startDate.getTime())) {
              await sendToOwner(sock, { text: `❌ Format tanggal salah. Gunakan \`YYYY-MM-DD HH:mm\`.` })
              continue
            }
            await sendToChat(sock, jid, { event: { name, description, startDate } })
            continue
          }

          // ---------- //vo (VIEW-ONCE SENDER) ----------
          if (cmd === "//vo") {
            const targetMedia =
              quotedMedia && ["image", "video", "audio"].includes(quotedMedia.kind)
                ? quotedMedia
                : (directMedia && ["image", "video", "audio"].includes(directMedia.kind) ? directMedia : null)

            if (!targetMedia) {
              await sendToOwner(sock, { text: `❌ Reply foto/video/VN (atau kirim dengan caption \`//vo\`) untuk kirim sebagai View-Once.` })
              continue
            }
            const buffer = await downloadStreamToBuffer(targetMedia.msg, targetMedia.kind)
            if (targetMedia.kind === "audio") {
              await sendToChat(sock, jid, { audio: buffer, mimetype: targetMedia.mime, ptt: true, viewOnce: true })
            } else {
              await sendToChat(sock, jid, { [targetMedia.kind]: buffer, viewOnce: true })
            }
            continue
          }

          continue
        }

        // ================= AUTO-CAPTURE MEDIA REPLY (KHUSUS OWNER KE TARGET -> KIRIM KE OWNER) =================
        if (isEnabled("auto_capture") && isTargetChat && isOwnerOrSelf && quotedMedia && ["image", "video", "audio"].includes(quotedMedia.kind)) {
          const buffer = await downloadStreamToBuffer(quotedMedia.msg, quotedMedia.kind)
          const isVO = isViewOnceMessage(quoted)
          const vaultPath = isEnabled("auto_vault")
            ? saveToMemoryVault({
                msgId: contextInfo?.stanzaId || `reply_${Date.now()}`,
                source: isVO ? "viewonce" : "reply",
                media: quotedMedia,
                buffer,
                caption: extractTextFromMessage(quoted)
              })
            : null
          const caption =
            `👀 *AUTO-CAPTURE TARGET (${quotedMedia.kind.toUpperCase()}${isVO ? " • VIEW-ONCE" : ""})*\n` +
            `Nomor: ${chatInfo.number || getTargetNumber()}\n` +
            `LID: ${chatInfo.lid || "-"}\n` +
            `Vault: ${vaultPath || "-"}`
          await sendMediaToOwner(sock, quotedMedia, buffer, caption)
        }
      } catch (e) {
        console.error("Error:", e.message)
      }
    }
  })
}

startBot().catch((err) => {
  console.error("🔥 FATAL ERROR STARTING BOT:", err)
  process.exit(1)
})

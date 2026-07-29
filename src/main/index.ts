import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { DatabaseSync } from 'node:sqlite'
import { EventEmitter } from 'node:events'
import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { copyFile, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import * as XLSX from 'xlsx'

type Status = 'idle' | 'connecting' | 'capturing' | 'reconnecting' | 'stopped' | 'error'
type Danmu = { id: number; sessionId: string; messageId: string; userId: string; username: string; sentAtMs: number; receivedAtMs: number; content: string }
type Session = { id: string; roomUrl: string; roomId: string | null; startedAt: number; stoppedAt: number | null; status: Status; messageCount: number; reconnectCount: number }
type Settings = { maskIds: boolean; newestFirst: boolean; blockedWords: string[]; storeRawFrames: boolean; headlessChrome: boolean }

const DEFAULT_SETTINGS: Settings = { maskIds: true, newestFirst: true, blockedWords: [], storeRawFrames: true, headlessChrome: true }
const CDP_PORT = 9223
const dataDir = () => join(app.getPath('userData'), 'data')
const dbPath = () => join(dataDir(), 'danmu.sqlite')

function readVarint(buffer: Buffer, start: number): { value: bigint; position: number } {
  let value = 0n; let shift = 0n; let position = start
  while (position < buffer.length) { const byte = buffer[position++]; value |= BigInt(byte & 127) << shift; if (!(byte & 128)) return { value, position }; shift += 7n }
  throw new Error('截断的 Protobuf 字段')
}
type ProtoField = { field: number; wire: number; value?: bigint; bytes?: Buffer }
function fields(buffer: Buffer): ProtoField[] {
  const output: ProtoField[] = []; let pos = 0
  while (pos < buffer.length) {
    const key = readVarint(buffer, pos); pos = key.position; const field = Number(key.value >> 3n); const wire = Number(key.value & 7n)
    if (wire === 0) { const value = readVarint(buffer, pos); output.push({ field, wire, value: value.value }); pos = value.position }
    else if (wire === 2) { const length = readVarint(buffer, pos); pos = length.position; const end = pos + Number(length.value); if (end > buffer.length) throw new Error('截断的字节字段'); output.push({ field, wire, bytes: buffer.subarray(pos, end) }); pos = end }
    else throw new Error(`暂不支持的 Protobuf wire type: ${wire}`)
  }
  return output
}
const bytesAt = (items: ProtoField[], field: number) => items.find((item) => item.field === field)?.bytes
const valueAt = (items: ProtoField[], field: number) => items.find((item) => item.field === field)?.value

function decodeDanmu(frameBytes: Buffer): Omit<Danmu, 'id' | 'sessionId' | 'receivedAtMs'>[] {
  try {
    const frame = fields(frameBytes); const payload = bytesAt(frame, 8); if (!payload) return []
    const header = frame.filter((item) => item.field === 5 && item.bytes).map((item) => fields(item.bytes!)).find((item) => bytesAt(item, 1)?.toString() === 'compress_type')
    const raw = bytesAt(header ?? [], 2)?.toString() === 'gzip' ? gunzipSync(payload) : payload
    const response = fields(raw); const result: Omit<Danmu, 'id' | 'sessionId' | 'receivedAtMs'>[] = []
    for (const item of response) {
      if (item.field !== 1 || !item.bytes) continue
      const wrapper = fields(item.bytes); if (bytesAt(wrapper, 1)?.toString() !== 'WebcastChatMessage') continue
      const chatBytes = bytesAt(wrapper, 2); const messageId = valueAt(wrapper, 3); if (!chatBytes || messageId === undefined) continue
      const chat = fields(chatBytes); const user = fields(bytesAt(chat, 2) ?? Buffer.alloc(0)); const username = bytesAt(user, 3)?.toString().trim(); const content = bytesAt(chat, 3)?.toString().trim()
      if (!username || !content) continue
      // field 1 can be the public placeholder ("111111") on some live rooms;
      // field 73 carries the stable, opaque account identifier exposed by the event.
      const sent = valueAt(chat, 15); const rawUserId = bytesAt(user, 73)?.toString() || valueAt(user, 1)?.toString() || ''
      result.push({ messageId: messageId.toString(), userId: rawUserId, username, content, sentAtMs: sent ? Number(sent) * 1000 : Date.now() })
    }
    return result
  } catch { return [] }
}

class Store {
  db: DatabaseSync
  constructor(file: string) {
    this.db = new DatabaseSync(file)
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS capture_sessions (id TEXT PRIMARY KEY, room_url TEXT NOT NULL, room_id TEXT, started_at INTEGER NOT NULL, stopped_at INTEGER, status TEXT NOT NULL, message_count INTEGER NOT NULL DEFAULT 0, reconnect_count INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS danmu_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, message_id TEXT NOT NULL, user_id TEXT NOT NULL, username TEXT NOT NULL, sent_at_ms INTEGER NOT NULL, received_at_ms INTEGER NOT NULL, content TEXT NOT NULL, raw_frame_id INTEGER, UNIQUE(session_id,message_id));
      CREATE INDEX IF NOT EXISTS idx_danmu_session_time ON danmu_messages(session_id, sent_at_ms DESC);
      CREATE TABLE IF NOT EXISTS raw_ws_frames (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, received_at_ms INTEGER NOT NULL, sha256 TEXT NOT NULL, payload BLOB NOT NULL, UNIQUE(session_id,sha256));
      CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);`)
  }
  settings(): Settings { const row = this.db.prepare(`SELECT value FROM app_settings WHERE key='settings'`).get() as { value?: string } | undefined; return row?.value ? { ...DEFAULT_SETTINGS, ...JSON.parse(row.value) } : DEFAULT_SETTINGS }
  saveSettings(settings: Settings) { this.db.prepare(`INSERT INTO app_settings(key,value) VALUES('settings',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(JSON.stringify(settings)); return settings }
  createSession(roomUrl: string): Session { const now = Date.now(); const id = randomUUID(); const roomId = roomUrl.match(/live\.douyin\.com\/(\d+)/)?.[1] ?? null; this.db.prepare(`INSERT INTO capture_sessions VALUES(?,?,?,?,NULL,'connecting',0,0)`).run(id, roomUrl, roomId, now); return { id, roomUrl, roomId, startedAt: now, stoppedAt: null, status: 'connecting', messageCount: 0, reconnectCount: 0 } }
  setSession(id: string, status: Status, reconnectCount?: number) { this.db.prepare(`UPDATE capture_sessions SET status=?, reconnect_count=COALESCE(?,reconnect_count), stopped_at=CASE WHEN ? IN ('stopped','error') THEN ? ELSE stopped_at END WHERE id=?`).run(status, reconnectCount ?? null, status, Date.now(), id) }
  addFrame(sessionId: string, frame: Buffer, saveRaw: boolean) { if (!saveRaw) return null; const hash = createHash('sha256').update(frame).digest('hex'); const result = this.db.prepare(`INSERT OR IGNORE INTO raw_ws_frames(session_id,received_at_ms,sha256,payload) VALUES(?,?,?,?)`).run(sessionId, Date.now(), hash, frame); return Number(result.lastInsertRowid) || null }
  addMessages(sessionId: string, messages: ReturnType<typeof decodeDanmu>, rawFrameId: number | null): Danmu[] {
    const saved: Danmu[] = []; const insert = this.db.prepare(`INSERT OR IGNORE INTO danmu_messages(session_id,message_id,user_id,username,sent_at_ms,received_at_ms,content,raw_frame_id) VALUES(?,?,?,?,?,?,?,?)`)
    const now = Date.now(); for (const message of messages) { const result = insert.run(sessionId, message.messageId, message.userId, message.username, message.sentAtMs, now, message.content, rawFrameId); if (result.changes) saved.push({ id: Number(result.lastInsertRowid), sessionId, receivedAtMs: now, ...message }) }
    if (saved.length) this.db.prepare(`UPDATE capture_sessions SET message_count=message_count+? WHERE id=?`).run(saved.length, sessionId)
    return saved
  }
  session(id: string): Session | null { const row = this.db.prepare(`SELECT id,room_url roomUrl,room_id roomId,started_at startedAt,stopped_at stoppedAt,status,message_count messageCount,reconnect_count reconnectCount FROM capture_sessions WHERE id=?`).get(id) as Session | undefined; return row ?? null }
  sessions(): Session[] { return this.db.prepare(`SELECT id,room_url roomUrl,room_id roomId,started_at startedAt,stopped_at stoppedAt,status,message_count messageCount,reconnect_count reconnectCount FROM capture_sessions ORDER BY started_at DESC`).all() as Session[] }
  messages(sessionId: string, query = '', from?: number, to?: number): Danmu[] { const clauses = ['session_id=?']; const values: (string | number)[] = [sessionId]; if (query) { clauses.push(`(content LIKE ? OR username LIKE ? OR user_id LIKE ?)`); values.push(`%${query}%`, `%${query}%`, `%${query}%`) } if (from) { clauses.push('sent_at_ms>=?'); values.push(from) } if (to) { clauses.push('sent_at_ms<=?'); values.push(to) } return this.db.prepare(`SELECT id,session_id sessionId,message_id messageId,user_id userId,username,sent_at_ms sentAtMs,received_at_ms receivedAtMs,content FROM danmu_messages WHERE ${clauses.join(' AND ')} ORDER BY sent_at_ms DESC LIMIT 10000`).all(...values) as Danmu[] }
  checkpoint() { this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)') }
}

class Collector extends EventEmitter {
  private active: { session: Session; stopped: boolean; socket?: WebSocket; retry: number } | null = null
  constructor(private store: Store) { super() }
  async start(roomUrl: string) {
    if (this.active) throw new Error('已有抓取任务正在运行')
    if (!/^https:\/\/live\.douyin\.com\/\d+/.test(roomUrl)) throw new Error('请输入有效的抖音直播间链接')
    const session = this.store.createSession(roomUrl); this.active = { session, stopped: false, retry: 0 }; this.emit('status', this.store.session(session.id)); void this.loop(); return session
  }
  async stop() { if (!this.active) return null; this.active.stopped = true; this.active.socket?.close(); this.store.setSession(this.active.session.id, 'stopped'); const result = this.store.session(this.active.session.id); this.active = null; this.emit('status', result); return result }
  private async ensureChrome(roomUrl: string) {
    const debugUrl = `http://127.0.0.1:${CDP_PORT}`
    try { if ((await fetch(`${debugUrl}/json/version`)).ok) return } catch { /* start a dedicated profile */ }
    const profile = join(app.getPath('userData'), 'chrome-profile'); await mkdir(profile, { recursive: true })
    const chromeArgs = ['--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', roomUrl]
    if (this.store.settings().headlessChrome) {
      const executable = process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : 'google-chrome'
      spawn(executable, ['--headless=new', '--disable-gpu', ...chromeArgs], { detached: true, stdio: 'ignore' }).unref()
    } else {
      spawn('open', ['-na', 'Google Chrome', '--args', ...chromeArgs], { detached: true, stdio: 'ignore' }).unref()
    }
    for (let i = 0; i < 20; i += 1) { await new Promise((resolve) => setTimeout(resolve, 500)); try { if ((await fetch(`${debugUrl}/json/version`)).ok) return } catch { /* retry */ } }
    throw new Error('无法启动调试 Chrome，请确认 Google Chrome 已安装')
  }
  private async target(roomUrl: string): Promise<{ webSocketDebuggerUrl: string }> {
    const debugUrl = `http://127.0.0.1:${CDP_PORT}`
    const tabs = await (await fetch(`${debugUrl}/json/list`)).json() as Array<{ type: string; url: string; webSocketDebuggerUrl?: string }>
    let tab = tabs.find((item) => item.type === 'page' && item.url.includes('live.douyin.com'))
    if (!tab) { await fetch(`${debugUrl}/json/new?${encodeURIComponent(roomUrl)}`, { method: 'PUT' }); await new Promise((resolve) => setTimeout(resolve, 1000)); return this.target(roomUrl) }
    if (!tab.webSocketDebuggerUrl) throw new Error('直播页面调试接口不可用'); return { webSocketDebuggerUrl: tab.webSocketDebuggerUrl }
  }
  private async loop() {
    while (this.active && !this.active.stopped) {
      try { await this.ensureChrome(this.active.session.roomUrl); const target = await this.target(this.active.session.roomUrl); this.store.setSession(this.active.session.id, 'capturing', this.active.retry); this.emit('status', this.store.session(this.active.session.id)); await this.attach(target.webSocketDebuggerUrl) }
      catch (error) { if (!this.active) return; this.active.retry += 1; this.store.setSession(this.active.session.id, 'reconnecting', this.active.retry); this.emit('error', error instanceof Error ? error.message : String(error)); this.emit('status', this.store.session(this.active.session.id)) }
      const active = this.active
      if (active && !active.stopped) await new Promise((resolve) => setTimeout(resolve, Math.min(1000 * 2 ** active.retry, 30000)))
    }
  }
  private attach(url: string) { return new Promise<void>((resolve) => {
    if (!this.active) return resolve(); const socket = new WebSocket(url); this.active.socket = socket; let nextId = 1
    socket.addEventListener('open', () => socket.send(JSON.stringify({ id: nextId++, method: 'Network.enable' })))
    socket.addEventListener('message', ({ data }) => { const payload = JSON.parse(String(data)); if (payload.method !== 'Network.webSocketFrameReceived' || !this.active) return; const frame = payload.params.response; if (frame.opcode !== 2) return; const bytes = Buffer.from(frame.payloadData, 'base64'); const rawFrameId = this.store.addFrame(this.active.session.id, bytes, this.store.settings().storeRawFrames); const saved = this.store.addMessages(this.active.session.id, decodeDanmu(bytes), rawFrameId); for (const item of saved) this.emit('danmu', item) })
    socket.addEventListener('close', () => resolve()); socket.addEventListener('error', () => resolve())
  }) }
}

let window: BrowserWindow | null = null; let store: Store; let collector: Collector
function createWindow() { window = new BrowserWindow({ width: 1380, height: 900, minWidth: 1080, minHeight: 700, webPreferences: { preload: join(__dirname, '../preload/index.mjs'), contextIsolation: true, sandbox: false } }); if (process.env.ELECTRON_RENDERER_URL) window.loadURL(process.env.ELECTRON_RENDERER_URL); else window.loadFile(join(__dirname, '../renderer/index.html')) }

app.whenReady().then(async () => {
  await mkdir(dataDir(), { recursive: true }); store = new Store(dbPath()); collector = new Collector(store); createWindow()
  collector.on('danmu', (item) => window?.webContents.send('danmu:new', item)); collector.on('status', (item) => window?.webContents.send('capture:status', item)); collector.on('error', (item) => window?.webContents.send('capture:error', item))
  ipcMain.handle('app:bootstrap', () => ({ settings: store.settings(), sessions: store.sessions(), active: null, dbPath: dbPath() }))
  ipcMain.handle('capture:start', (_event, url: string) => collector.start(url)); ipcMain.handle('capture:stop', () => collector.stop()); ipcMain.handle('sessions:list', () => store.sessions()); ipcMain.handle('messages:list', (_event, args) => store.messages(args.sessionId, args.query, args.from, args.to)); ipcMain.handle('settings:save', (_event, value: Settings) => store.saveSettings(value)); ipcMain.handle('path:openData', () => shell.openPath(dataDir()))
  ipcMain.handle('export:csv', async (_event, sessionId: string) => exportRows(sessionId, 'csv')); ipcMain.handle('export:xlsx', async (_event, sessionId: string) => exportRows(sessionId, 'xlsx')); ipcMain.handle('export:sqlite', async () => { const pick = await dialog.showSaveDialog({ defaultPath: 'danmu.sqlite' }); if (pick.canceled || !pick.filePath) return null; store.checkpoint(); await copyFile(dbPath(), pick.filePath); return pick.filePath }); ipcMain.handle('wordcloud:create', (_event, args) => wordCloud(args.sessionId, args.minFrequency ?? 2)); ipcMain.handle('wordcloud:export', async (_event, args) => exportWordCloud(args.sessionId, args.minFrequency ?? 2))
})

async function exportRows(sessionId: string, type: 'csv' | 'xlsx') { const rows = store.messages(sessionId).map((item) => ({ 弹幕时间: new Date(item.sentAtMs).toLocaleString('zh-CN', { hour12: false }), 用户名: item.username, 用户ID: item.userId, 弹幕内容: item.content, 消息ID: item.messageId })); const pick = await dialog.showSaveDialog({ defaultPath: `弹幕-${Date.now()}.${type}` }); if (pick.canceled || !pick.filePath) return null; if (type === 'csv') { const escape = (value: unknown) => `"${String(value ?? '').replaceAll('"', '""')}"`; const headers = ['弹幕时间', '用户名', '用户ID', '弹幕内容', '消息ID']; await writeFile(pick.filePath, `\ufeff${headers.join(',')}\n${rows.map((row) => headers.map((key) => escape(row[key as keyof typeof row])).join(',')).join('\n')}`) } else { const sheet = XLSX.utils.json_to_sheet(rows); const book = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(book, sheet, '弹幕'); XLSX.writeFile(book, pick.filePath) } return pick.filePath }

function wordCloud(sessionId: string, minFrequency: number) { const stop = new Set(['我们','你们','这个','那个','就是','真的','可以','不要','一个','今天','主播','直播间','哈哈','哈哈哈','一下','怎么','什么','他们','还有','已经','没有']); const counts = new Map<string, number>(); for (const item of store.messages(sessionId)) { const chunks = item.content.replace(/https?:\/\/\S+/g, '').match(/[\u4e00-\u9fff]{2,}/g) ?? []; for (const chunk of chunks) for (let i = 0; i < chunk.length - 1; i += 1) { const word = chunk.slice(i, i + 2); if (!stop.has(word)) counts.set(word, (counts.get(word) ?? 0) + 1) } } const words = [...counts.entries()].filter(([, count]) => count >= minFrequency).sort((a, b) => b[1] - a[1]).slice(0, 50).map(([word, count]) => ({ word, count })); const max = Math.max(...words.map((item) => item.count), 1); return { words: words.map((item, index) => ({ ...item, size: Math.round(14 + (item.count / max) * 46), rotate: index % 4 === 0 ? -8 : index % 5 === 0 ? 8 : 0 })) } }
async function exportWordCloud(sessionId: string, minFrequency: number) { const data = wordCloud(sessionId, minFrequency); const pick = await dialog.showSaveDialog({ defaultPath: `弹幕关键词云-${Date.now()}.html` }); if (pick.canceled || !pick.filePath) return null; const cloud = data.words.map((item) => `<span title="${item.word}：${item.count} 次" style="font-size:${item.size}px;transform:rotate(${item.rotate}deg)">${item.word}</span>`).join(''); const list = data.words.map((item) => `<tr><td>${item.word}</td><td>${item.count}</td></tr>`).join(''); await writeFile(pick.filePath, `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>弹幕关键词云</title><style>body{font-family:-apple-system,"Noto Sans SC",sans-serif;margin:40px;background:#f8fbff;color:#123}.cloud{display:flex;flex-wrap:wrap;gap:18px;align-items:center;justify-content:center;min-height:360px;padding:30px;border:1px solid #d7e8ff;border-radius:18px}.cloud span{color:#1677ff;display:inline-block;line-height:1.15}table{border-collapse:collapse;margin:auto;min-width:360px}th,td{padding:9px 14px;border-bottom:1px solid #dce8f7;text-align:left}</style><h1>弹幕关键词云</h1><div class="cloud">${cloud}</div><h2>词频 Top 50</h2><table><tr><th>词语</th><th>频次</th></tr>${list}</table></html>`); return pick.filePath }

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })

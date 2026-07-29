import { useEffect, useMemo, useState } from 'react'

type Status = 'idle' | 'connecting' | 'capturing' | 'reconnecting' | 'stopped' | 'error'
type Danmu = { id: number; sessionId: string; messageId: string; userId: string; username: string; sentAtMs: number; receivedAtMs: number; content: string }
type Session = { id: string; roomUrl: string; startedAt: number; stoppedAt: number | null; status: Status; messageCount: number; reconnectCount: number }
type Settings = { maskIds: boolean; newestFirst: boolean; blockedWords: string[]; storeRawFrames: boolean; headlessChrome: boolean }
type CloudWord = { word: string; count: number; size: number; rotate: number }
type PositionedCloudWord = CloudWord & { left: number; top: number; opacity: number }
const statusLabel: Record<Status, string> = { idle: '未开始', connecting: '连接中', capturing: '抓取中', reconnecting: '重连中', stopped: '已停止', error: '异常' }
const mask = (value: string) => value.length < 9 ? value : `${value.slice(0, 4)}…${value.slice(-4)}`
const time = (value: number) => new Date(value).toLocaleTimeString('zh-CN', { hour12: false })

// Wordle-style spiral placement: larger terms claim the visual centre first,
// then smaller terms fill the available space without becoming a tag list.
function layoutCloud(words: CloudWord[]): PositionedCloudWord[] {
  const width = 820; const height = 420; const placed: Array<{ x: number; y: number; w: number; h: number }> = []
  const canvas = document.createElement('canvas'); const context = canvas.getContext('2d')
  return words.slice(0, 38).map((item, index) => {
    const size = Math.max(16, Math.min(68, item.size + (index < 3 ? 8 : 0)))
    context?.save(); if (context) context.font = `700 ${size}px "Noto Sans SC", sans-serif`; const measured = context?.measureText(item.word).width ?? item.word.length * size; context?.restore()
    const box = { w: measured + 18, h: size * 1.22 + 12 }; let x = width / 2; let y = height / 2; let accepted = false
    for (let step = 0; step < 1400; step += 1) {
      const angle = index * 2.39996 + step * 0.19; const radius = index === 0 ? step * 0.8 : 20 + step * 1.35
      x = width / 2 + Math.cos(angle) * radius; y = height / 2 + Math.sin(angle) * radius * 0.62
      const inside = x - box.w / 2 > 12 && x + box.w / 2 < width - 12 && y - box.h / 2 > 12 && y + box.h / 2 < height - 12
      const overlaps = placed.some((other) => Math.abs(x - other.x) < (box.w + other.w) / 2 + 5 && Math.abs(y - other.y) < (box.h + other.h) / 2 + 5)
      if (inside && !overlaps) { accepted = true; break }
    }
    if (!accepted) { x = 74 + (index % 7) * 112; y = 54 + Math.floor(index / 7) * 66 }
    placed.push({ x, y, ...box })
    return { ...item, size, left: Number((x / width * 100).toFixed(2)), top: Number((y / height * 100).toFixed(2)), opacity: Math.max(0.55, 1 - index * 0.012) }
  })
}

export default function App() {
  const [url, setUrl] = useState('https://live.douyin.com/')
  const [sessions, setSessions] = useState<Session[]>([]); const [session, setSession] = useState<Session | null>(null); const [rows, setRows] = useState<Danmu[]>([])
  const [settings, setSettings] = useState<Settings>({ maskIds: true, newestFirst: true, blockedWords: [], storeRawFrames: true, headlessChrome: true }); const [query, setQuery] = useState(''); const [paused, setPaused] = useState(false); const [notice, setNotice] = useState('准备就绪'); const [cloud, setCloud] = useState<CloudWord[]>([]); const [showSettings, setShowSettings] = useState(false)
  const active = session?.status === 'capturing' || session?.status === 'connecting' || session?.status === 'reconnecting'
  const refreshSessions = async () => { const list = await window.danmu.sessions(); setSessions(list); return list }
  const load = async (item: Session, value = query) => { const data = await window.danmu.messages({ sessionId: item.id, query: value }); setRows(data); setSession(item) }
  useEffect(() => { window.danmu.bootstrap().then((data: any) => { setSettings(data.settings); setSessions(data.sessions); if (data.sessions[0]) load(data.sessions[0], '') }); const offDanmu = window.danmu.onDanmu((item: Danmu) => { if (!paused) setRows((old) => [item, ...old].slice(0, 10000)); setSession((old) => old ? { ...old, messageCount: old.messageCount + 1 } : old) }); const offStatus = window.danmu.onStatus((item: Session) => { setSession(item); refreshSessions(); setNotice(`任务状态：${statusLabel[item.status]}`) }); const offError = window.danmu.onError((message: string) => setNotice(`采集提示：${message}`)); return () => { offDanmu(); offStatus(); offError() } }, [paused])
  useEffect(() => { if (!session) return; const timer = setTimeout(() => load(session, query), 250); return () => clearTimeout(timer) }, [query])
  const visible = useMemo(() => rows.filter((row) => !settings.blockedWords.some((word) => word && row.content.includes(word))), [rows, settings.blockedWords])
  const cloudLayout = useMemo(() => layoutCloud(cloud), [cloud])
  const start = async () => { try { const item = await window.danmu.start(url.trim()); setSession(item); setRows([]); setNotice('正在启动隔离 Chrome 并连接直播间…'); refreshSessions() } catch (error) { setNotice(error instanceof Error ? error.message : String(error)) } }
  const stop = async () => { const item = await window.danmu.stop(); if (item) { setSession(item); refreshSessions(); setNotice('已停止，数据已持续保存在本地 SQLite。') } }
  const exports = async (kind: 'csv' | 'xlsx' | 'sqlite') => { if (!session) return; const path = kind === 'csv' ? await window.danmu.exportCsv(session.id) : kind === 'xlsx' ? await window.danmu.exportXlsx(session.id) : await window.danmu.exportSqlite(); if (path) setNotice(`已导出：${path}`) }
  const createCloud = async () => { if (!session) return; const data = await window.danmu.wordCloud({ sessionId: session.id, minFrequency: 2 }); setCloud(data.words); setNotice(`已生成 ${data.words.length} 个关键词的词云`) }
  const exportCloud = async () => { if (!session) return; const path = await window.danmu.exportWordCloud({ sessionId: session.id, minFrequency: 2 }); if (path) setNotice(`关键词云 HTML 已导出：${path}`) }
  const saveSettings = async (next: Settings) => { setSettings(next); await window.danmu.saveSettings(next) }
  return <main>
    <header><div><p className="eyebrow">LOCAL · PRIVATE · REALTIME</p><h1>直播弹幕采集器</h1></div><button className="ghost" onClick={() => setShowSettings(!showSettings)}>设置</button></header>
    <section className="control card"><label>直播间链接<input value={url} disabled={active} onChange={(e) => setUrl(e.target.value)} placeholder="https://live.douyin.com/..." /></label><div className="actions"><button className="primary" disabled={active} onClick={start}>开始抓取</button><button className="danger" disabled={!active} onClick={stop}>停止抓取</button></div><div className={`status ${session?.status ?? 'idle'}`}><i />{statusLabel[session?.status ?? 'idle']}<span>{session ? `已采集 ${session.messageCount.toLocaleString()} 条` : '等待创建任务'}</span></div></section>
    {showSettings && <section className="settings card"><label><input type="checkbox" checked={settings.headlessChrome} onChange={(e) => saveSettings({ ...settings, headlessChrome: e.target.checked })} /> 静默抓取（后台 Chrome）</label><label><input type="checkbox" checked={settings.maskIds} onChange={(e) => saveSettings({ ...settings, maskIds: e.target.checked })} /> 默认脱敏用户 ID</label><label><input type="checkbox" checked={settings.storeRawFrames} onChange={(e) => saveSettings({ ...settings, storeRawFrames: e.target.checked })} /> 保留原始 WebSocket 帧</label><label>屏蔽词（逗号分隔）<input value={settings.blockedWords.join(',')} onChange={(e) => saveSettings({ ...settings, blockedWords: e.target.value.split(',').map((x) => x.trim()).filter(Boolean) })} /></label></section>}
    <section className="metrics"><article><span>任务时长</span><b>{session ? Math.max(0, Math.floor(((session.stoppedAt ?? Date.now()) - session.startedAt) / 60000)) : 0} 分钟</b></article><article><span>重连次数</span><b>{session?.reconnectCount ?? 0}</b></article><article><span>可见弹幕</span><b>{visible.length.toLocaleString()}</b></article><article><span>本地存储</span><b>SQLite / WAL</b></article></section>
    <section className="toolbar card"><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索用户名、ID 或弹幕内容" /><button onClick={() => setPaused(!paused)}>{paused ? '继续滚动' : '暂停滚动'}</button><select onChange={(e) => { const key = e.target.value; if (key === 'all') load(session!, ''); else { const n = Number(key) * 60000; window.danmu.messages({ sessionId: session!.id, from: Date.now() - n }).then(setRows) } }} disabled={!session}><option value="all">全程</option><option value="10">最近 10 分钟</option><option value="30">最近 30 分钟</option><option value="60">最近 1 小时</option></select></section>
    <section className="table card"><div className="head row"><span>时间</span><span>用户 ID</span><span>用户名</span><span>弹幕内容</span></div><div className="scroll">{visible.map((row) => <div className="row" key={`${row.id}-${row.messageId}`} onDoubleClick={() => navigator.clipboard.writeText(`${row.username}：${row.content}`)}><span>{time(row.sentAtMs)}</span><span className="id">{settings.maskIds ? mask(row.userId) : row.userId}</span><span>{row.username}</span><strong>{row.content}</strong></div>)}{!visible.length && <p className="empty">{session ? '暂无符合条件的弹幕' : '输入直播间链接后开始抓取'}</p>}</div></section>
    <section className="bottom"><div className="notice">{notice}</div><div className="exports"><button disabled={!session} onClick={() => exports('csv')}>导出 CSV</button><button disabled={!session} onClick={() => exports('xlsx')}>导出 Excel</button><button onClick={() => exports('sqlite')}>导出 SQLite</button><button disabled={!session} onClick={createCloud}>关键词云</button><button onClick={() => window.danmu.openData()}>打开数据目录</button></div></section>
    {cloud.length > 0 && <section className="cloud card"><div className="cloudmeta"><p className="cloud-kicker">LIVE LANGUAGE MAP</p><h2>弹幕关键词云</h2><p>高频词位于视觉核心，低频词向外延展。所有文字使用蓝色系呈现。</p><div className="cloud-stats"><span><b>{cloud.length}</b> 个关键词</span><span><b>{cloud[0]?.count ?? 0}</b> 最高频次</span></div><button onClick={exportCloud}>导出 HTML 词云</button></div><div className="cloudstage"><div className="cloudglow glow-one" /><div className="cloudglow glow-two" /><div className="cloudwords">{cloudLayout.map((item, index) => <span className={index < 3 ? 'cloudword featured' : 'cloudword'} key={item.word} title={`${item.word}：${item.count} 次`} style={{ left: `${item.left}%`, top: `${item.top}%`, fontSize: item.size, opacity: item.opacity, transform: `translate(-50%, -50%) rotate(${item.rotate}deg)` }}>{item.word}</span>)}</div><div className="cloudlegend"><i /><span>频率越高，字号越大</span></div></div><ol className="cloudrank">{cloud.slice(0, 10).map((item, index) => <li key={item.word}><em>{String(index + 1).padStart(2, '0')}</em><span>{item.word}</span><b>{item.count}</b></li>)}</ol></section>}
    <section className="history card"><h2>历史任务</h2><div>{sessions.map((item) => <button className={item.id === session?.id ? 'selected' : ''} key={item.id} onClick={() => load(item, '')}><span>{new Date(item.startedAt).toLocaleString('zh-CN', { hour12: false })}</span><b>{item.messageCount} 条</b><small>{statusLabel[item.status]}</small></button>)}</div></section>
  </main>
}

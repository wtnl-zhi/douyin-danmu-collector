import { contextBridge, ipcRenderer } from 'electron'

const api = {
  bootstrap: () => ipcRenderer.invoke('app:bootstrap'),
  start: (url: string) => ipcRenderer.invoke('capture:start', url),
  stop: () => ipcRenderer.invoke('capture:stop'),
  openLogin: (url: string) => ipcRenderer.invoke('capture:openLogin', url),
  sessions: () => ipcRenderer.invoke('sessions:list'),
  messages: (args: { sessionId: string; query?: string; from?: number; to?: number }) => ipcRenderer.invoke('messages:list', args),
  saveSettings: (settings: unknown) => ipcRenderer.invoke('settings:save', settings),
  openData: () => ipcRenderer.invoke('path:openData'),
  exportCsv: (sessionId: string) => ipcRenderer.invoke('export:csv', sessionId),
  exportXlsx: (sessionId: string) => ipcRenderer.invoke('export:xlsx', sessionId),
  exportSqlite: () => ipcRenderer.invoke('export:sqlite'),
  wordCloud: (args: { sessionId: string; minFrequency?: number }) => ipcRenderer.invoke('wordcloud:create', args),
  exportWordCloud: (args: { sessionId: string; minFrequency?: number }) => ipcRenderer.invoke('wordcloud:export', args),
  onDanmu: (callback: (item: unknown) => void) => { const listener = (_: unknown, item: unknown) => callback(item); ipcRenderer.on('danmu:new', listener); return () => ipcRenderer.removeListener('danmu:new', listener) },
  onStatus: (callback: (item: unknown) => void) => { const listener = (_: unknown, item: unknown) => callback(item); ipcRenderer.on('capture:status', listener); return () => ipcRenderer.removeListener('capture:status', listener) },
  onError: (callback: (item: string) => void) => { const listener = (_: unknown, item: string) => callback(item); ipcRenderer.on('capture:error', listener); return () => ipcRenderer.removeListener('capture:error', listener) }
}
contextBridge.exposeInMainWorld('danmu', api)

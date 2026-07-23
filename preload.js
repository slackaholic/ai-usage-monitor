const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // Window controls
  toggleAlwaysOnTop: () => ipcRenderer.send('toggle-always-on-top'),
  minimizeWindow: () => ipcRenderer.send('minimize-window'),
  closeWindow: () => ipcRenderer.send('close-window'),
  getAlwaysOnTop: () => ipcRenderer.invoke('get-always-on-top'),
  onAlwaysOnTopChanged: (cb) =>
    ipcRenderer.on('always-on-top-changed', (_, v) => cb(v)),

  // Claude Code local data
  readClaudeCodeUsage: () => ipcRenderer.invoke('read-claude-code-usage'),
  readCodexUsage: () => ipcRenderer.invoke('read-codex-usage'),

  // Codex page scraper
  fetchCodexUsage: () => ipcRenderer.invoke('fetch-codex-usage'),
  showCodexWindow: () => ipcRenderer.invoke('show-codex-window'),

  // Claude web scrapers (desktop session + VS Code session)
  fetchClaudeWebUsage:   () => ipcRenderer.invoke('fetch-claude-web-usage'),
  showClaudeWebWindow:   () => ipcRenderer.invoke('show-claude-web-window'),
  fetchClaudeWebUsage2:  () => ipcRenderer.invoke('fetch-claude-web-usage-2'),
  showClaudeWebWindow2:  () => ipcRenderer.invoke('show-claude-web-window-2'),
  resetClaudeSession:    (key) => ipcRenderer.invoke('reset-claude-session', key),
  borrowClaudeDesktopSession: () => ipcRenderer.invoke('borrow-claude-desktop-session'),

  // Open URL in system browser
  openExternal: (url) => ipcRenderer.send('open-external', url),

  // Analytics window
  openAnalytics: (account) => ipcRenderer.send('open-analytics', account),
  onSwitchAnalyticsTab: (cb) => ipcRenderer.on('switch-analytics-tab', (_, account) => cb(account)),

  // Settings window
  openSettings: () => ipcRenderer.send('open-settings'),
  onSettingsChanged: (cb) => ipcRenderer.on('settings-changed', () => cb()),

  // Usage history log
  appendUsageLog: (entry) => ipcRenderer.send('append-usage-log', entry),
  readUsageLog: (account, limit) => ipcRenderer.invoke('read-usage-log', account, limit),
  getBudgetInfo: () => ipcRenderer.invoke('get-budget-info'),

  // Claude Code API usage (reads ~/.claude/.credentials.json directly)
  fetchClaudeCodeApiUsage: () => ipcRenderer.invoke('fetch-claude-code-api-usage'),
  fetchClaudeCodeEmail: () => ipcRenderer.invoke('fetch-claude-code-email'),

  // Resize window to fit content
  resizeToFit: (h) => ipcRenderer.send('resize-to-fit', h),

  // Settings / opacity
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (patch) => ipcRenderer.send('save-settings', patch),
  setOpacity: (val) => ipcRenderer.send('set-opacity', val),
});

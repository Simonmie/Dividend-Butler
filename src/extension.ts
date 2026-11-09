import * as vscode from 'vscode';
import { promises as fs, watch } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { Application } from './application';
import { Store } from './storage';
import { display } from './money';

export async function activate(context: vscode.ExtensionContext) {
  await fs.mkdir(context.globalStorageUri.fsPath, { recursive: true, mode: 0o700 });
  const output = vscode.window.createOutputChannel('红利管家');
  const app = new Application(new Store(context.globalStorageUri.fsPath));
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
  status.command = 'dividendButler.open'; status.name = '红利管家';
  let panel: vscode.WebviewPanel | undefined;
  let ready = false;
  let disposed = false;
  const report = (error: unknown) => {
    const message = error instanceof Error ? error.message : '操作失败';
    output.appendLine(`[${new Date().toISOString()}] ${message}`);
    void vscode.window.showWarningMessage(`红利管家：${message}`);
  };
  const notify = () => {
    if (disposed) return;
    try {
      const view = app.view();
      const custom = view.state.settings.custom;
      const stale = view.estimates.some(e => e.stale) || view.projections.some(p => p.warnings.length);
      status.text = view.storageError ? '$(warning) 红利 账本待恢复' : custom !== null ? `$(symbol-numeric) 红利 ¥${display(custom)}`
        : view.total === null ? '$(graph) 红利 暂无估算'
        : `$(graph) 红利 ¥${display(view.total)}${view.coverage < view.state.funds.length ? ' · 部分' : ''}${stale ? ' · 缓存/待补算' : ''}`;
      status.tooltip = custom !== null ? '自定义展示值，不影响账本。点击打开红利管家。'
        : `各 ETF 下一次预计分红合计，日期可能不同，包含计划再投资。\n覆盖 ${view.coverage}/${view.state.funds.length} 只基金；估算不保证实际到账。\n${view.estimates.map(e => `${e.code} ${e.date ?? '--'} ¥${display(e.amount)}：${e.basis}`).join('\n')}`;
      status.show();
      if (panel) void panel.webview.postMessage({ type: 'view', view });
    } catch (error) { report(error); }
  };
  app.onChange = notify;
  async function exportBackup() {
    const uri = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(`dividend-butler-${new Date().toISOString().slice(0, 10)}.json`),
      filters: { '红利管家备份': ['json'] }, saveLabel: '导出含财务信息的备份' });
    if (!uri) return;
    await app.reload();
    await vscode.workspace.fs.writeFile(uri, Buffer.from(JSON.stringify(app.view().state, null, 2)));
    void vscode.window.showInformationMessage('红利管家备份已导出，请妥善保管财务信息。');
  }
  async function importBackup() {
    const uris = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { '红利管家备份': ['json'] } });
    if (!uris?.[0]) return;
    const confirm = await vscode.window.showWarningMessage('恢复将替换当前账本，当前有效版本会保留为本地备份。确认继续？', { modal: true }, '恢复');
    if (confirm !== '恢复') return;
    const bytes = await vscode.workspace.fs.readFile(uris[0]);
    if (bytes.length > 12_000_000) throw new Error('备份过大，请检查文件');
    await app.import(JSON.parse(Buffer.from(bytes).toString('utf8')));
    void vscode.window.showInformationMessage('备份恢复成功，在线查询默认关闭。');
  }
  const open = () => {
    if (panel) { panel.reveal(vscode.ViewColumn.Active); return; }
    panel = vscode.window.createWebviewPanel('dividendButler', '红利管家 · Beta', vscode.ViewColumn.Active, {
      enableScripts: true, retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist')]
    });
    const nonce = randomBytes(24).toString('hex');
    const script = panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'dist', 'panel.js'));
    const css = panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'dist', 'panel.css'));
    panel.webview.html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
      <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${panel.webview.cspSource}; style-src ${panel.webview.cspSource}; script-src 'nonce-${nonce}';">
      <link rel="stylesheet" href="${css}"><title>红利管家</title></head><body><div id="app"></div><script nonce="${nonce}" src="${script}"></script></body></html>`;
    panel.webview.onDidReceiveMessage(async (input: unknown) => {
      try {
        if (input === null || typeof input !== 'object' || JSON.stringify(input).length > 10000) throw new Error('面板消息无效');
        const message = input as { type?: string; payload?: unknown; revision?: number };
        if (message.type === 'ready') { ready = true; notify(); return; }
        if (message.type === 'refresh') {
          if (!app.view().state.settings.online) throw new Error('请先在设置中同意开启公开数据查询');
          await app.refresh(true);
        } else if (message.type === 'export') await exportBackup();
        else if (message.type === 'import') await importBackup();
        else {
          if (message.type === 'settings' && (message.payload as { online?: boolean })?.online) {
            const choice = await vscode.window.showInformationMessage(
              '开启后仅向腾讯行情和天天基金发送基金代码等查询参数，不上传份额或本金。公开数据可能延迟或失效，不承诺使用授权或收益。', { modal: true }, '同意并开启');
            if (choice !== '同意并开启') return;
          }
          if (['deleteFund', 'deleteTrade', 'unconfirmDividend'].includes(message.type ?? '')) {
            const choice = await vscode.window.showWarningMessage('此操作会删除相应记录并重算账本，请确认已导出备份。', { modal: true }, '继续');
            if (choice !== '继续') return;
          }
          await app.execute(message.type ?? '', message.payload, message.revision ?? -1);
          if (app.view().state.settings.online && ['addFund', 'settings'].includes(message.type ?? '')) await app.refresh();
        }
        void panel?.webview.postMessage({ type: 'success' });
      } catch (error) {
        report(error); await app.reload().catch(() => {});
        void panel?.webview.postMessage({ type: 'error', message: error instanceof Error ? error.message : '操作失败' });
      } finally { void panel?.webview.postMessage({ type: 'settled' }); }
    }, undefined, context.subscriptions);
    panel.onDidDispose(() => { panel = undefined; ready = false; }, undefined, context.subscriptions);
    notify();
  };
  context.subscriptions.push(
    output, status,
    vscode.commands.registerCommand('dividendButler.open', open),
    vscode.commands.registerCommand('dividendButler.refresh', () => app.refresh(true).catch(report)),
    vscode.commands.registerCommand('dividendButler.export', () => exportBackup().catch(report)),
    vscode.commands.registerCommand('dividendButler.import', () => importBackup().catch(report))
  );
  await app.initialize();
  notify();
  let debounce: NodeJS.Timeout | undefined;
  const watcher = watch(context.globalStorageUri.fsPath, (_event, filename) => {
    if (filename === 'ledger.json') {
      clearTimeout(debounce);
      debounce = setTimeout(() => { void app.reload().catch(report); }, 150);
    }
  });
  const timer = setInterval(() => { void app.refresh().catch(report); }, 30 * 60 * 1000);
  context.subscriptions.push({ dispose: () => { disposed = true; clearInterval(timer); clearTimeout(debounce); watcher.close(); panel?.dispose(); } });
  void app.refresh().catch(report);
  return { app, open, statusText: () => status.text, panelOpen: () => Boolean(panel), panelReady: () => ready };
}

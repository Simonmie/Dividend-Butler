import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import { Application, DEFAULT_FEE } from '../src/application';
import { addDays, today } from '../src/calendar';

export async function run(): Promise<void> {
  const extension = vscode.extensions.getExtension<{ app: Application; statusText(): string; panelOpen(): boolean; panelReady(): boolean }>('local-dividend-butler.dividend-butler');
  assert.ok(extension, '扩展已加载');
  const api = await extension.activate();
  assert.ok(api.statusText().includes('暂无估算'), '无持仓时状态栏为暂无估算');
  await vscode.commands.executeCommand('dividendButler.open');
  assert.equal(api.panelOpen(), true, '面板打开');
  await vscode.commands.executeCommand('dividendButler.open');
  assert.equal(api.panelOpen(), true, '重复点击复用面板');
  const deadline = Date.now() + 15000;
  while (!api.panelReady() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(api.panelReady(), true, '实际 Webview 脚本加载并与宿主握手');
  await api.app.execute('addFund', { code: '510880', shares: 1000, cost: '3000', baseline: today(), fee: DEFAULT_FEE, mode: 'cash' }, api.app.view().state.revision);
  await api.app.execute('addPlan', { code: '510880', amount: '1000', start: addDays(today(), 1), cycle: 'monthly', day: 10, interval: 5, fee: DEFAULT_FEE }, api.app.view().state.revision);
  await api.app.execute('settings', { custom: '888.88' }, api.app.view().state.revision);
  assert.ok(api.statusText().includes('888.88'), '自定义状态栏金额更新');
  await api.app.reload();
  assert.equal(api.app.view().state.funds.length, 1, '持仓落盘后恢复');
  assert.equal(api.app.view().state.plans.length, 1, '计划落盘后恢复');
  assert.equal(api.app.view().state.settings.online, false, '默认不发送在线请求');
  await api.app.execute('settings', { custom: '' }, api.app.view().state.revision);
  assert.ok(api.statusText().includes('暂无估算'), '自定义值可恢复自动估算');
  console.log('PASS：扩展激活、状态栏、Webview 脚本握手、面板复用、持仓与计划保存、自定义金额及恢复。');
}

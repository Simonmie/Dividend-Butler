import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { money, decimal, display, commission, purchase } from '../src/money';
import { addDays, isTrading, nextTrading, validDate } from '../src/calendar';
import { project, schedule, makeView } from '../src/engine';
import { emptyState, type State, type Fund, type Fee, type Plan } from '../src/model';
import { validateState } from '../src/validation';
import { parseBars, parseDividends, requestText } from '../src/providers';
import { Store } from '../src/storage';
import { Application } from '../src/application';

const fee: Fee = { kind: 'rate', value: '0.0003', minimum: '5' };
const fund: Fund = { code: '510880', name: '红利ETF华泰柏瑞', initialShares: 1000, initialCost: '3000',
  baseline: '2026-01-05', modes: [{ from: '2026-01-05', mode: 'cash' }], fee };
function account(): State {
  const state = emptyState();
  state.funds = [structuredClone(fund)];
  state.data['510880'] = { bars: [
    { date: '2026-01-06', close: '3', volume: 1000 }, { date: '2026-01-07', close: '3', volume: 1000 },
    { date: '2026-01-08', close: '3', volume: 1000 }, { date: '2026-01-09', close: '3', volume: 1000 },
    { date: '2026-01-12', close: '3', volume: 1000 }, { date: '2026-01-13', close: '3', volume: 1000 }
  ], dividends: [], splits: [] };
  return state;
}
function plan(start = '2026-01-06'): Plan {
  return { id: 'plan-1', code: '510880', amount: '1000', start, cycle: 'weekly', day: 2, interval: 5, fee };
}
test('定点金额无浮点误差', () => {
  assert.equal(money('0.1') + money('0.2'), money('0.3'));
  assert.equal(decimal(money('10.123456')), '10.123456');
  assert.equal(display('1.005'), '1.01');
  assert.equal(display(null), '--');
});
test('金额拒绝负数、指数和超长小数', () => {
  for (const value of ['-1', '1e3', 'Infinity', '1.0000001', '']) assert.throws(() => money(value));
});
test('含最低费用求最大整手，不超预算', () => {
  const p = purchase(money('1000'), '3', fee);
  assert.equal(p.shares, 300); assert.equal(p.cost, money('900')); assert.equal(p.fee, money('5'));
  assert.equal(purchase(money('300'), '3', fee).shares, 0);
});
test('固定费用与比例费率舍入正确', () => {
  assert.equal(commission(money('10000'), fee), money('5'));
  assert.equal(commission(money('50000'), fee), money('15'));
  assert.equal(commission(0n, { kind: 'fixed', value: '5', minimum: '0' }), 0n);
});
test('日期合法性和春节顺延', () => {
  assert.equal(validDate('2026-02-30'), false); assert.equal(validDate('2026-02-28'), true);
  assert.equal(isTrading('2026-02-16'), false); assert.equal(nextTrading('2026-02-16'), '2026-02-24');
  assert.equal(isTrading('2026-02-14'), false); assert.throws(() => isTrading('2027-01-04'));
  assert.equal(addDays('2026-01-31', 1), '2026-02-01');
});
test('月末缺失日期取月末后顺延', () => {
  const p = { ...plan('2026-02-01'), cycle: 'monthly' as const, day: 31 };
  assert.deepEqual(schedule(p, '2026-03-03'), [{ original: '2026-02-28', date: '2026-03-02' }]);
});
test('每 N 个交易日跳过假期', () => {
  const p = { ...plan('2026-02-13'), cycle: 'trading' as const, interval: 2 };
  assert.deepEqual(schedule(p, '2026-02-26').map(d => d.date), ['2026-02-13', '2026-02-25']);
});
test('定投余款结转，重放不重复记账', () => {
  const s = account(); s.plans.push(plan());
  const p = project(s, s.funds[0], '2026-01-13');
  assert.equal(p.shares, 1600); assert.equal(p.planCash, '190.000000'); assert.equal(p.invested, '5000.000000');
  assert.deepEqual(project(s, s.funds[0], '2026-01-13'), p);
});
test('不足一手不收手续费，预算仍保留', () => {
  const s = account(); s.plans.push({ ...plan(), amount: '100' });
  const p = project(s, s.funds[0], '2026-01-06');
  assert.equal(p.shares, 1000); assert.equal(p.planCash, '100.000000');
  assert.equal(p.rows.find(r => r.id.startsWith('sip:'))!.fee, '0.000000');
});
test('缺行情暂停补算，不猜成交', () => {
  const s = account(); s.plans.push(plan()); s.data['510880'].bars = [];
  const p = project(s, s.funds[0], '2026-01-13');
  assert.equal(p.shares, 1000); assert.equal(p.rows.filter(r => r.kind === 'budget').length, 1);
  assert.ok(p.warnings.some(w => w.includes('缺少最终日线')));
  assert.equal(p.snapshots['2026-01-13'], undefined);
});
test('停牌日顺延至有成交量的交易日', () => {
  const s = account(); s.plans.push(plan()); s.data['510880'].bars[0].volume = 0;
  const p = project(s, s.funds[0], '2026-01-07');
  assert.equal(p.rows.find(r => r.id.startsWith('sip:'))!.date, '2026-01-07');
});
test('交易修正重算余款及份额', () => {
  const s = account(); s.plans.push(plan());
  s.overrides.push({ id: 'sip:plan-1:2026-01-06', shares: 200, price: '3', fee: '5', note: '实际成交' });
  const p = project(s, s.funds[0], '2026-01-13');
  assert.equal(p.shares, 1600); assert.equal(p.planCash, '190.000000');
  assert.equal(p.rows.find(r => r.id.startsWith('sip:'))!.simulated, false);
});
test('超预算修正与超持仓卖出被拒绝', () => {
  const s = account(); s.plans.push(plan());
  s.overrides.push({ id: 'sip:plan-1:2026-01-06', shares: 400, price: '3', fee: '5', note: '' });
  assert.throws(() => project(s, s.funds[0], '2026-01-06'), /超出/);
  s.overrides = []; s.trades.push({ id: 'manual-1', code: '510880', date: '2026-01-06', side: 'sell', shares: 2000, price: '3', fee: '5', note: '' });
  assert.throws(() => project(s, s.funds[0], '2026-01-06'), /超过持仓/);
});
test('分红使用登记日份额而非派息日当前份额', () => {
  const s = account();
  s.trades.push({ id: 'sell-1', code: '510880', date: '2026-01-08', side: 'sell', shares: 500, price: '3', fee: '5', note: '' });
  s.data['510880'].dividends.push({ id: 'event-1', record: '2026-01-06', ex: '2026-01-07', pay: '2026-01-09', perShare: '0.1', source: '用户手动录入', confirmed: true });
  const p = project(s, s.funds[0], '2026-01-09');
  assert.equal(p.shares, 500); assert.equal(p.rows.find(r => r.kind === 'dividend')!.amount, '100.000000');
  assert.equal(p.cash, '1595.000000');
});
test('未经确认的历史分红不增加现金', () => {
  const s = account();
  s.data['510880'].dividends.push({ id: 'event-1', record: '2026-01-06', ex: '2026-01-07', pay: '2026-01-09', perShare: '0.1', source: '用户手动录入', confirmed: false });
  assert.equal(project(s, s.funds[0], '2026-01-09').cash, '0.000000');
});
test('登记日在初始快照以前时不虚构分红', () => {
  const s = account();
  s.data['510880'].dividends.push({ id: 'event-1', record: '2026-01-02', ex: '2026-01-05', pay: '2026-01-09', perShare: '0.1', source: '用户手动录入', confirmed: true });
  const p = project(s, s.funds[0], '2026-01-09');
  assert.equal(p.cash, '0.000000'); assert.ok(p.warnings.some(w => w.includes('权益份额未知')));
});
test('再投资下一交易日买入，不计额外本金', () => {
  const s = account(); s.funds[0].modes[0].mode = 'reinvest';
  s.data['510880'].dividends.push({ id: 'event-1', record: '2026-01-06', ex: '2026-01-07', pay: '2026-01-09', perShare: '1', source: '用户手动录入', confirmed: true });
  const p = project(s, s.funds[0], '2026-01-12');
  assert.equal(p.shares, 1300); assert.equal(p.reinvestCash, '95.000000');
  assert.equal(p.invested, '3000.000000'); assert.equal(p.rows.find(r => r.kind === 'reinvest')!.date, '2026-01-12');
});
test('更改未来分红方式不重写已确认事件', () => {
  const s = account(); s.funds[0].modes.push({ from: '2026-01-10', mode: 'reinvest' });
  s.data['510880'].dividends.push({ id: 'event-1', record: '2026-01-06', ex: '2026-01-07', pay: '2026-01-09', perShare: '1', source: '用户手动录入', confirmed: true, mode: 'cash' });
  const p = project(s, s.funds[0], '2026-01-12');
  assert.equal(p.cash, '1000.000000'); assert.equal(p.reinvestCash, '0.000000');
});
test('份额折算暂停账本', () => {
  const s = account(); s.data['510880'].splits.push('2026-01-07');
  assert.ok(project(s, s.funds[0], '2026-01-09').warnings.some(w => w.includes('份额折算')));
});
test('未来公告用登记日快照，已知零估算可显示', () => {
  const s = account(); s.funds[0].initialShares = 0;
  s.data['510880'].dividends.push({ id: 'event-1', record: '2026-01-06', ex: '2026-01-07', pay: '2026-01-09', perShare: '1', source: '用户手动录入', confirmed: false });
  const v = makeView(s, '2026-01-07', '2026-01-07');
  assert.equal(v.total, '0.000000'); assert.equal(v.coverage, 1);
});
test('历史预测与已过期预测不会触发到账', () => {
  const s = account();
  for (const year of ['2023', '2024', '2025']) s.data['510880'].dividends.push({
    id: `event-${year}`, record: `${year}-01-06`, ex: `${year}-01-07`, pay: `${year}-01-09`, perShare: '0.1', source: '公开数据', confirmed: false
  });
  const future = makeView(s, '2026-01-08', '2026-01-08');
  assert.equal(future.total, '100.000000'); assert.equal(future.projections[0].cash, '0.000000');
  const expired = makeView(s, '2026-01-10', '2026-01-10');
  assert.equal(expired.total, null); assert.ok(expired.estimates[0].stale);
});
test('备份结构、关联和重复 ID 校验', () => {
  const s = account(); validateState(s);
  assert.throws(() => validateState({ ...s, schemaVersion: 2 }));
  assert.throws(() => validateState({ ...s, funds: [fund, fund] }), /重复/);
  assert.throws(() => validateState({ ...s, settings: { custom: '-1', online: true } }));
});
test('公开分红按每10份换算，保留派息日', () => {
  const html = '<title>基金510880</title><table><tr><th>年份</th><th>权益登记日</th><th>除息日</th><th>每10份分红</th><th>分红发放日</th></tr><tr><td>2026年</td><td>2026-01-20</td><td>2026-01-21</td><td>每10份派现金1.4300元</td><td>2026-01-26</td></tr></table>';
  const result = parseDividends(html, '510880');
  assert.equal(result.dividends[0].perShare, '0.143000'); assert.equal(result.dividends[0].confirmed, false);
  assert.throws(() => parseDividends('<title>基金510880</title>拒绝访问', '510880'));
});
test('日线拒绝复权字段及代码错误', () => {
  assert.equal(parseBars(JSON.stringify({ code: 0, data: { sh510880: { day: [['2026-01-06', '3', '3.1', '4', '2', '1000']] } } }), '510880')[0].close, '3.1');
  assert.throws(() => parseBars(JSON.stringify({ code: 0, data: { sh510880: { qfqday: [] } } }), '510880'));
});
test('数据请求拒绝非白名单网址和 HTTP', async () => {
  await assert.rejects(requestText('http://fundf10.eastmoney.com/foo'));
  await assert.rejects(requestText('https://example.com'));
});
test('多窗口写锁保留所有修订，旧版本不能覆盖', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dividend-store-'));
  try {
    const a = new Store(directory), b = new Store(directory);
    await a.transaction(state => { Object.assign(state, account()); });
    await Promise.all([
      a.transaction(state => { state.settings.custom = '100'; }),
      b.transaction(state => { state.settings.online = true; })
    ]);
    const state = await a.read();
    assert.equal(state.revision, 3); assert.equal(state.settings.custom, '100'); assert.equal(state.settings.online, true);
    await assert.rejects(a.transaction(state => { state.settings.custom = '200'; }, 1), /其他窗口/);
    assert.equal((await a.read()).settings.custom, '100');
    assert.equal(JSON.parse(await readFile(join(directory, 'ledger.backup.json'), 'utf8')).revision, 2);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('导入恢复关闭在线查询且不破坏有效备份', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dividend-store-'));
  try {
    const store = new Store(directory);
    await store.transaction(state => { state.settings.custom = '50'; });
    const imported = account(); imported.settings.online = true;
    await store.restore(imported);
    assert.equal((await store.read()).settings.online, false);
    assert.equal(JSON.parse(await readFile(join(directory, 'ledger.backup.json'), 'utf8')).settings.custom, '50');
    await assert.rejects(store.restore({ schemaVersion: 999 }));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('损坏账本不会静默变成空账户', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dividend-store-'));
  try {
    await writeFile(join(directory, 'ledger.json'), 'not-json');
    await assert.rejects(new Store(directory).read(), /账本无法读取/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('显式恢复损坏账本，保留原始字节', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dividend-store-'));
  try {
    await writeFile(join(directory, 'ledger.json'), 'broken-original');
    const app = new Application(new Store(directory)); await app.initialize();
    assert.ok(app.view().storageError);
    await app.import(account());
    assert.equal(app.view().storageError, undefined); assert.equal(app.view().state.funds.length, 1);
    const corrupt = (await readdir(directory)).find(name => name.startsWith('ledger.corrupt-'))!;
    assert.equal(await readFile(join(directory, corrupt), 'utf8'), 'broken-original');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('无日线时可通过实际成交修正解除阻塞', () => {
  const s = account(); s.plans.push(plan()); s.data['510880'].bars = [];
  const pending = project(s, s.funds[0], '2026-01-06');
  assert.equal(pending.rows.find(r => r.id.startsWith('sip:'))!.price, '0');
  s.overrides.push({ id: 'sip:plan-1:2026-01-06', shares: 300, price: '3', fee: '5', note: '成交单' });
  const resolved = project(s, s.funds[0], '2026-01-06');
  assert.equal(resolved.shares, 1300); assert.equal(resolved.warnings.length, 0);
});
test('同一天顺延多期预算不会合并 ID', () => {
  const s = account(); s.funds[0].baseline = '2026-02-12';
  s.funds[0].modes[0].from = '2026-02-12';
  s.plans.push({ ...plan('2026-02-13'), day: 1 });
  s.data['510880'].bars = [{ date: '2026-02-24', close: '3', volume: 1000 }];
  const p = project(s, s.funds[0], '2026-02-24');
  const buys = p.rows.filter(row => row.id.startsWith('sip:'));
  assert.equal(buys.length, 2); assert.equal(new Set(buys.map(row => row.id)).size, 2);
  assert.equal(p.invested, '5000.000000');
});
test('分红事件重复即使 ID 不同也拒绝导入', () => {
  const s = account();
  const div = { id: 'event-1', record: '2026-01-06', ex: '2026-01-07', pay: '2026-01-09', perShare: '0.1', source: '用户手动录入', confirmed: false };
  s.data['510880'].dividends.push(div, { ...div, id: 'event-2' });
  assert.throws(() => validateState(s), /分红事件重复/);
});
test('失败的持仓修正不落盘', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dividend-store-'));
  try {
    const s = account(); s.trades.push({ id: 'sell-1', code: '510880', date: '2026-01-06', side: 'sell', shares: 500, price: '3', fee: '5', note: '' });
    const store = new Store(directory); await store.transaction(state => { Object.assign(state, s); });
    const app = new Application(store); await app.initialize();
    await assert.rejects(app.execute('updateInitial', { code: '510880', shares: 100, cost: '300' }, 1), /超过持仓/);
    assert.equal((await store.read()).funds[0].initialShares, 1000);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

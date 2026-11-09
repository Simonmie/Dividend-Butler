import { randomUUID } from 'node:crypto';
import { addDays, finalizedThrough, today } from './calendar';
import { makeView, modeAt } from './engine';
import { CANDIDATES, emptyState, type Fee, type Fund, type Plan, type Trade, type Override, type Dividend, type State, type View } from './model';
import { getBars, getDividends } from './providers';
import { Store } from './storage';
import { ensure, validateState } from './validation';

const message = (error: unknown) => error instanceof Error ? error.message : '未知数据错误';
export class Application {
  private state!: State;
  private storageError?: string;
  busy = false;
  onChange: () => void = () => {};
  constructor(readonly store: Store) {}
  async initialize(): Promise<void> {
    try { this.state = await this.store.read(); }
    catch (error) { this.state = emptyState(); this.storageError = message(error); }
  }
  view(): View { return { ...makeView(this.state, today(), finalizedThrough(), this.busy), storageError: this.storageError }; }
  async reload(): Promise<void> {
    const state = await this.store.read();
    if (!this.state || state.revision >= this.state.revision) { this.state = state; this.storageError = undefined; this.onChange(); }
  }
  async execute(type: string, payload: unknown, revision: number): Promise<void> {
    ensure(Number.isSafeInteger(revision) && revision >= 0, '请求版本无效');
    ensure(payload !== null && typeof payload === 'object' && !Array.isArray(payload), '请求数据无效');
    const p = payload as Record<string, unknown>;
    this.state = await this.store.transaction(state => {
      const date = today();
      switch (type) {
        case 'addFund': {
          const candidate = CANDIDATES.find(f => f.code === p.code);
          ensure(candidate, '请选择首批支持的 ETF');
          ensure(!state.funds.some(f => f.code === p.code), '该基金已存在');
          const fund = { ...candidate, initialShares: p.shares, initialCost: p.cost, baseline: p.baseline, fee: p.fee,
            modes: [{ from: p.baseline, mode: p.mode }] } as Fund;
          ensure(typeof p.baseline === 'string' && p.baseline <= date, '初始持仓截至日期不能在未来');
          state.funds.push(fund);
          state.data[candidate.code] = { bars: [], dividends: [], splits: [] };
          break;
        }
        case 'updateInitial': {
          const fund = state.funds.find(f => f.code === p.code);
          ensure(fund, '基金不存在');
          fund.initialShares = p.shares as number;
          fund.initialCost = p.cost as string;
          break;
        }
        case 'deleteFund': {
          ensure(state.funds.some(f => f.code === p.code), '基金不存在');
          const planIds = state.plans.filter(plan => plan.code === p.code).map(plan => plan.id);
          state.funds = state.funds.filter(f => f.code !== p.code);
          state.plans = state.plans.filter(plan => plan.code !== p.code);
          state.trades = state.trades.filter(trade => trade.code !== p.code);
          state.overrides = state.overrides.filter(item => !planIds.some(id => item.id.startsWith(`sip:${id}:`)) && !item.id.startsWith(`reinvest:${p.code}:`));
          delete state.data[String(p.code)];
          break;
        }
        case 'setMode': {
          const fund = state.funds.find(f => f.code === p.code);
          ensure(fund && (p.mode === 'cash' || p.mode === 'reinvest'), '分红方式或基金无效');
          const from = addDays(date, 1);
          fund.modes = fund.modes.filter(m => m.from < from);
          fund.modes.push({ from, mode: p.mode });
          break;
        }
        case 'addPlan': {
          const plan = { id: randomUUID(), code: p.code, amount: p.amount, cycle: p.cycle,
            day: p.day, interval: p.interval, start: p.start, end: p.end || undefined, fee: p.fee } as Plan;
          state.plans.push(plan);
          break;
        }
        case 'stopPlan': {
          const plan = state.plans.find(item => item.id === p.id);
          ensure(plan, '计划不存在');
          if (plan.start > date) state.plans = state.plans.filter(item => item.id !== p.id);
          else if (!plan.end || plan.end > date) plan.end = date;
          break;
        }
        case 'addTrade': {
          const trade = { id: randomUUID(), code: p.code, date: p.date, side: p.side,
            shares: p.shares, price: p.price, fee: p.fee, note: p.note || '' } as Trade;
          ensure(typeof trade.date === 'string' && trade.date <= finalizedThrough(), '只能记录已结束的交易日；北京时间 16:00 后可补录当日交易');
          state.trades.push(trade);
          break;
        }
        case 'deleteTrade':
          ensure(state.trades.some(t => t.id === p.id), '仅可删除手动交易');
          state.trades = state.trades.filter(t => t.id !== p.id);
          break;
        case 'override': {
          const rows = makeView(state, date, finalizedThrough()).projections.flatMap(f => f.rows);
          ensure(rows.some(row => row.id === p.id && (row.id.startsWith('sip:') || row.id.startsWith('reinvest:'))), '该记录不支持成交修正');
          const override = { id: p.id, shares: p.shares, price: p.price, fee: p.fee, note: p.note || '' } as Override;
          state.overrides = state.overrides.filter(item => item.id !== p.id);
          state.overrides.push(override);
          break;
        }
        case 'clearOverride':
          state.overrides = state.overrides.filter(item => item.id !== p.id);
          break;
        case 'addDividend': {
          const fund = state.funds.find(f => f.code === p.code);
          ensure(fund, '基金不存在');
          const div = { id: `manual:${randomUUID()}`, record: p.record, ex: p.ex, pay: p.pay,
            perShare: p.perShare, source: '用户手动录入', confirmed: false } as Dividend;
          const data = state.data[fund.code];
          ensure(!data.dividends.some(d => d.record === div.record && d.pay === div.pay), '同一登记日与派息日的分红已存在，请核对已有记录');
          data.dividends.push(div);
          data.dividends.sort((a, b) => a.pay.localeCompare(b.pay));
          break;
        }
        case 'confirmDividend': {
          const fund = state.funds.find(f => f.code === p.code);
          const div = state.data[String(p.code)]?.dividends.find(d => d.id === p.id);
          ensure(fund && div, '分红记录不存在');
          ensure(div.pay <= finalizedThrough() && div.record >= fund.baseline, '只能确认已到派息日且初始持仓快照之后的分红');
          const projection = makeView(state, date, finalizedThrough()).projections.find(f => f.code === p.code)!;
          ensure(projection.snapshots[div.record] !== undefined, '该登记日持仓未完成补算，不能确认分红');
          div.confirmed = true; div.mode = modeAt(fund, div.pay);
          if (p.amount !== undefined && p.amount !== '') div.amount = String(p.amount);
          else delete div.amount;
          break;
        }
        case 'unconfirmDividend': {
          const div = state.data[String(p.code)]?.dividends.find(d => d.id === p.id);
          ensure(div, '分红记录不存在'); div.confirmed = false; delete div.amount; delete div.mode;
          break;
        }
        case 'settings':
          if (p.custom !== undefined) state.settings.custom = p.custom === '' ? null : p.custom as string;
          if (p.online !== undefined) { ensure(typeof p.online === 'boolean', '网络开关无效'); state.settings.online = p.online; }
          break;
        default: throw new Error('未知操作');
      }
      validateState(state);
      const view = makeView(state, date, finalizedThrough());
      if (type === 'addTrade') {
        ensure(view.projections.find(f => f.code === p.code)?.snapshots[String(p.date)] !== undefined,
          '该交易日之前存在未完成补算，请先补齐行情再记录实际交易');
      }
    }, revision);
    this.onChange();
  }
  async refresh(force = false): Promise<void> {
    await this.reload();
    if (!this.state.settings.online || this.busy) return;
    this.busy = true; this.onChange();
    try {
      for (const fund of [...this.state.funds]) {
        const old = this.state.data[fund.code];
        if (!force && old.fetched && old.dividendFetched
          && Date.now() - Date.parse(old.fetched) < 30 * 60 * 1000
          && Date.now() - Date.parse(old.dividendFetched) < 24 * 60 * 60 * 1000) continue;
        const fetchBars = force || !old.fetched || Date.now() - Date.parse(old.fetched) >= 30 * 60 * 1000;
        const fetchDivs = force || !old.dividendFetched || Date.now() - Date.parse(old.dividendFetched) >= 24 * 60 * 60 * 1000;
        const [bars, dividends] = await Promise.all([
          fetchBars ? getBars(fund.code).then(value => ({ value }), error => ({ error: message(error) })) : undefined,
          fetchDivs ? getDividends(fund.code).then(value => ({ value }), error => ({ error: message(error) })) : undefined
        ]);
        this.state = await this.store.transaction(state => {
          const data = state.data[fund.code];
          if (!data || !state.settings.online) return;
          if (bars && 'value' in bars) {
            const previous = new Map(data.bars.map(b => [b.date, b]));
            for (const bar of bars.value.filter(b => b.date <= finalizedThrough())) if (!previous.has(bar.date)) previous.set(bar.date, bar);
            data.bars = [...previous.values()].sort((a, b) => a.date.localeCompare(b.date));
            data.fetched = new Date().toISOString(); delete data.error;
          } else if (bars) data.error = bars.error;
          if (dividends && 'value' in dividends) {
            const previous = new Map(data.dividends.map(d => [d.id, d]));
            data.dividends = dividends.value.dividends.map(div => {
              const match = previous.get(div.id) ?? [...previous.values()].find(d => d.record === div.record && d.pay === div.pay);
              return match && (match.confirmed || match.source === '用户手动录入') ? match : div;
            });
            for (const div of previous.values()) {
              if ((div.confirmed || div.source === '用户手动录入') && !data.dividends.some(d => d.record === div.record && d.pay === div.pay)) data.dividends.push(div);
            }
            data.dividends.sort((a, b) => a.pay.localeCompare(b.pay));
            data.splits = dividends.value.splits;
            data.dividendFetched = new Date().toISOString(); delete data.dividendError;
          } else if (dividends) data.dividendError = dividends.error;
          makeView(state, today(), finalizedThrough());
        });
        this.onChange();
      }
    } finally { this.busy = false; this.onChange(); }
  }
  async import(input: unknown): Promise<void> {
    validateState(input); makeView(input, today(), finalizedThrough());
    this.state = await this.store.restore(input); this.storageError = undefined; this.onChange();
  }
}
export const DEFAULT_FEE: Fee = { kind: 'rate', value: '0.0003', minimum: '5' };

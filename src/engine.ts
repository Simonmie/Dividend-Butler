import { addDays, dayRange, isTrading, nextTrading } from './calendar';
import { cents, decimal, money, purchase } from './money';
import type { Estimate, Fund, Mode, Plan, Projection, Row, State, View } from './model';

export function modeAt(fund: Fund, date: string): Mode {
  return [...fund.modes].reverse().find(item => item.from <= date)?.mode ?? 'cash';
}
export function schedule(plan: Plan, through: string): { original: string; date: string }[] {
  const end = plan.end && plan.end < through ? plan.end : through;
  const result: { original: string; date: string }[] = [];
  let tradingIndex = 0;
  for (const date of dayRange(plan.start, end)) {
    let due = false;
    if (plan.cycle === 'weekly') due = new Date(date).getUTCDay() === plan.day % 7;
    if (plan.cycle === 'monthly') {
      const [year, month, day] = date.split('-').map(Number);
      const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
      due = day === Math.min(plan.day, last);
    }
    if (plan.cycle === 'trading' && isTrading(date)) { due = tradingIndex % plan.interval === 0; tradingIndex++; }
    if (due) {
      let actual: string;
      try { actual = nextTrading(date); } catch { continue; }
      if (actual <= through) result.push({ original: date, date: actual });
    }
  }
  return result;
}
export function project(state: State, fund: Fund, requestedThrough: string): Projection {
  const through = requestedThrough > '2026-12-31' ? '2026-12-31' : requestedThrough;
  const data = state.data[fund.code];
  const rows: Row[] = [], warnings: string[] = [];
  const snapshots: Record<string, number> = { [fund.baseline]: fund.initialShares };
  let shares = fund.initialShares, invested = money(fund.initialCost), cash = 0n, reinvestCash = 0n;
  const balances = new Map<string, bigint>();
  const pendingPlans: { plan: Plan; original: string; date: string }[] = [];
  const pendingReinvest: { id: string; date: string }[] = [];
  const bars = new Map(data?.bars.map(bar => [bar.date, bar]) ?? []);
  const overrides = new Map(state.overrides.map(item => [item.id, item]));
  rows.push({ id: `initial:${fund.code}`, date: fund.baseline, code: fund.code, kind: 'initial',
    shares, price: '0', amount: fund.initialCost, fee: '0', note: '初始持仓截至日收盘后快照', simulated: false });
  const dues = state.plans.filter(p => p.code === fund.code).flatMap(plan => schedule(plan, through).map(d => ({ ...d, plan })));
  const push = (row: Omit<Row, 'code'>) => rows.push({ ...row, code: fund.code });
  if (requestedThrough > through) warnings.push('2027 年及以后交易日历未核验，暂停跨年补算');
  if (data?.error) warnings.push(`行情刷新失败，使用缓存：${data.error}`);
  if (data?.dividendError) warnings.push(`分红刷新失败，使用缓存：${data.dividendError}`);
  for (const date of dayRange(addDays(fund.baseline, 1), through)) {
    if (data?.splits.includes(date)) { warnings.push(`${date} 存在份额折算，请校正初始持仓后继续`); break; }
    const dailyTrades = state.trades.filter(t => t.code === fund.code && t.date === date);
    if (dailyTrades.length && !isTrading(date)) throw new Error(`${date} 为非交易日，不能记录场内买卖`);
    for (const trade of dailyTrades) {
      const gross = cents(money(trade.price) * BigInt(trade.shares));
      const fee = cents(money(trade.fee));
      if (trade.side === 'buy') { shares += trade.shares; invested += gross + fee; }
      else {
        if (trade.shares > shares) throw new Error(`${fund.code} ${date} 卖出份额超过持仓，请先核对初始持仓和历史交易`);
        if (fee > gross) throw new Error('卖出手续费超过成交金额');
        shares -= trade.shares; cash += gross - fee;
      }
      push({ id: trade.id, date, kind: trade.side, shares: trade.shares, price: trade.price,
        amount: decimal(gross), fee: decimal(fee), note: trade.note || '手动实际交易；买入作为额外投入', simulated: false });
    }
    for (const due of dues.filter(d => d.date === date)) {
      const balance = (balances.get(due.plan.id) ?? 0n) + cents(money(due.plan.amount));
      balances.set(due.plan.id, balance); invested += cents(money(due.plan.amount));
      pendingPlans.push(due);
      push({ id: `budget:${due.plan.id}:${due.original}`, date, kind: 'budget', shares: 0,
        price: '0', amount: due.plan.amount, fee: '0', note: `定投预算；原定 ${due.original}`, simulated: true });
    }
    const activePlans = pendingPlans.filter(p => p.date <= date);
    const activeReinvest = pendingReinvest.filter(p => p.date <= date);
    if ((activePlans.length || activeReinvest.length) && isTrading(date)) {
      const bar = bars.get(date);
      const allCorrected = activePlans.every(p => overrides.has(`sip:${p.plan.id}:${p.original}`))
        && activeReinvest.every(p => overrides.has(p.id));
      if (!bar && !allCorrected) {
        for (const pending of activePlans) push({
          id: `sip:${pending.plan.id}:${pending.original}`, date, kind: 'buy', shares: 0, price: '0',
          amount: '0', fee: '0', note: '待补算，尚未成交；可填写实际成交解除阻塞', simulated: true
        });
        for (const pending of activeReinvest) push({
          id: pending.id, date, kind: 'reinvest', shares: 0, price: '0', amount: '0', fee: '0',
          note: '待补算，尚未再投资；可填写实际成交解除阻塞', simulated: true
        });
        warnings.push(`${date} 缺少最终日线，账本暂停在此日；${activePlans.length + activeReinvest.length} 笔待补算`);
        break;
      }
      if (!bar || bar.volume > 0 || allCorrected) {
        for (const pending of activePlans) {
          const id = `sip:${pending.plan.id}:${pending.original}`;
          const override = overrides.get(id);
          const balance = balances.get(pending.plan.id) ?? 0n;
          const price = override?.price ?? bar!.close;
          const trade = override
            ? { shares: override.shares, cost: cents(money(price) * BigInt(override.shares)), fee: cents(money(override.fee)) }
            : purchase(balance, price, pending.plan.fee);
          if (trade.cost + trade.fee > balance) throw new Error(`${date} 修正后的定投成交超出该计划预算与余款`);
          balances.set(pending.plan.id, balance - trade.cost - trade.fee); shares += trade.shares;
          push({ id, date, kind: 'buy', shares: trade.shares, price, amount: decimal(trade.cost), fee: decimal(trade.fee),
            note: override ? `实际成交修正：${override.note}` : trade.shares ? `定投模拟；原定 ${pending.original}` : '预算不足一手，保留余款',
            simulated: !override });
          pendingPlans.splice(pendingPlans.indexOf(pending), 1);
        }
        for (const pending of activeReinvest) {
          const override = overrides.get(pending.id);
          const price = override?.price ?? bar!.close;
          const trade = override
            ? { shares: override.shares, cost: cents(money(price) * BigInt(override.shares)), fee: cents(money(override.fee)) }
            : purchase(reinvestCash, price, fund.fee);
          if (trade.cost + trade.fee > reinvestCash) throw new Error('再投资修正超出分红与再投资余款');
          reinvestCash -= trade.cost + trade.fee; shares += trade.shares;
          push({ id: pending.id, date, kind: 'reinvest', shares: trade.shares, price,
            amount: decimal(trade.cost), fee: decimal(trade.fee),
            note: override ? `实际再投资修正：${override.note}` : '分红到账后再投资模拟，未向券商下单', simulated: !override });
          pendingReinvest.splice(pendingReinvest.indexOf(pending), 1);
        }
      }
    }
    snapshots[date] = shares;
    for (const div of data?.dividends.filter(d => d.pay === date && d.confirmed) ?? []) {
      const eligible = snapshots[div.record];
      if (eligible === undefined) { warnings.push(`${div.record} 权益份额未知，该次分红未入账`); continue; }
      const amount = div.amount !== undefined ? cents(money(div.amount)) : cents(BigInt(eligible) * money(div.perShare));
      const mode = div.mode ?? modeAt(fund, date);
      if (mode === 'cash') cash += amount;
      else {
        reinvestCash += amount;
        try { pendingReinvest.push({ id: `reinvest:${fund.code}:${div.id}`, date: nextTrading(addDays(date, 1)) }); }
        catch { warnings.push(`${date} 再投资等待下一年度交易日历`); }
      }
      push({ id: `div:${fund.code}:${div.id}`, date, kind: 'dividend', shares: eligible, price: div.perShare,
        amount: decimal(amount), fee: '0', note: mode === 'cash' ? '已确认披露记录，按权益份额模拟现金留存' : '已确认披露记录，计划再投资',
        simulated: div.amount === undefined });
    }
  }
  const latest = data?.bars.filter(b => b.date <= requestedThrough).at(-1);
  return { code: fund.code, shares, invested: decimal(invested), value: latest ? decimal(BigInt(shares) * money(latest.close)) : null,
    cash: decimal(cash), planCash: decimal([...balances.values()].reduce((a, b) => a + b, 0n)),
    reinvestCash: decimal(reinvestCash), rows, snapshots, warnings };
}
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}
export function estimate(state: State, fund: Fund, projection: Projection, date: string): Estimate {
  const data = state.data[fund.code];
  const aged = data?.dividendFetched ? Date.parse(date) - Date.parse(data.dividendFetched) > 36 * 3600000 : false;
  const result: Estimate = { code: fund.code, date: null, amount: null, mode: modeAt(fund, date),
    basis: '历史分红不足，暂无估算', samples: 0, stale: Boolean(aged || data?.dividendError || projection.warnings.length) };
  const announced = data?.dividends.filter(d => d.pay > date).sort((a, b) => a.pay.localeCompare(b.pay))[0];
  if (announced) {
    const source = announced.source === '用户手动录入' ? '用户录入分红计划' : '公开分红表披露';
    const eligible = announced.record < fund.baseline ? undefined :
      announced.record <= date ? projection.snapshots[announced.record] : projection.shares;
    return { ...result, date: announced.pay, mode: modeAt(fund, announced.pay),
      amount: eligible === undefined ? null : decimal(cents(BigInt(eligible) * money(announced.perShare))),
      basis: eligible === undefined ? '已披露日期，历史权益份额未知' : announced.record > date
        ? `${source}；按现有份额估算，登记日前变动会影响金额` : `${source}；按登记日份额估算`, samples: 1 };
  }
  const historical = (data?.dividends ?? []).filter(d => d.pay <= date && d.pay >= addDays(date, -3 * 366))
    .sort((a, b) => a.pay.localeCompare(b.pay));
  if (historical.length < 3) return { ...result, samples: historical.length };
  const gaps = historical.slice(1).map((d, i) => (Date.parse(d.pay) - Date.parse(historical[i].pay)) / 86400000);
  const gap = median(gaps);
  if (gap < 15 || Math.max(...gaps) - Math.min(...gaps) > Math.max(25, gap * 0.3)) {
    return { ...result, samples: historical.length, basis: '历史分红间隔不稳定，不强行预测' };
  }
  const last = historical.at(-1)!;
  const predicted = addDays(last.pay, Math.round(gap));
  if (predicted <= date) return { ...result, date: predicted, stale: true, samples: historical.length, basis: '上次历史预测日期已过，等待新公告' };
  const amounts = historical.map(d => money(d.perShare)).sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
  const middle = Math.floor(amounts.length / 2);
  const perShare = amounts.length % 2 ? amounts[middle] : (amounts[middle - 1] + amounts[middle] + 1n) / 2n;
  return { ...result, date: predicted, amount: decimal(cents(perShare * BigInt(projection.shares))),
    mode: modeAt(fund, predicted), samples: historical.length,
    basis: `历史间隔与每份分红中位数（${historical.length} 次样本）；日期可能前后偏差，非交易日未经未来日历调整` };
}
export function makeView(state: State, date: string, through: string, busy = false): View {
  const projections = state.funds.map(f => project(state, f, through));
  const estimates = state.funds.map((f, i) => estimate(state, f, projections[i], date));
  const available = estimates.filter(e => e.amount !== null);
  return { state, projections, estimates, today: date, busy, coverage: available.length,
    total: available.length ? decimal(available.reduce((sum, e) => sum + money(e.amount!), 0n)) : null };
}

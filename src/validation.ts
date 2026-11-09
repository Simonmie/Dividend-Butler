import { validDate } from './calendar';
import { money } from './money';
import { CANDIDATES, type Fee, type State } from './model';

export function ensure(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function object(value: unknown): asserts value is Record<string, unknown> {
  ensure(value !== null && typeof value === 'object' && !Array.isArray(value), '无效的数据对象');
}
function text(value: unknown, max = 200): asserts value is string {
  ensure(typeof value === 'string' && value.length <= max, '文本为空或过长');
}
function amount(value: unknown): asserts value is string { text(value, 24); money(value); }
function integer(value: unknown, min: number, max: number): asserts value is number {
  ensure(typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max, '数值超出有效范围');
}
function date(value: unknown): asserts value is string { text(value, 10); ensure(validDate(value), '日期无效'); }
function code(value: unknown): asserts value is string {
  text(value, 6); ensure(CANDIDATES.some(f => f.code === value), 'Beta 当前支持 510880、515180、159905');
}
function id(value: unknown): asserts value is string {
  text(value, 120); ensure(/^[a-zA-Z0-9:_-]{1,120}$/.test(value), '记录 ID 无效');
}
function list(value: unknown, max: number): asserts value is unknown[] {
  ensure(Array.isArray(value) && value.length <= max, '列表无效或超过上限');
}
export function validateFee(value: unknown): asserts value is Fee {
  object(value); ensure(value.kind === 'fixed' || value.kind === 'rate', '手续费模式无效');
  amount(value.value); amount(value.minimum);
  ensure(value.kind !== 'rate' || money(value.value) <= 1_000_000n, '费率应填小数比例，例如万三为 0.0003');
}
export function validateState(value: unknown): asserts value is State {
  object(value); ensure(value.schemaVersion === 1, '不支持该备份版本');
  integer(value.revision, 0, Number.MAX_SAFE_INTEGER); text(value.saved, 40);
  list(value.funds, 3); list(value.plans, 100); list(value.trades, 10000); list(value.overrides, 10000);
  const fundCodes = new Set<string>(), ids = new Set<string>();
  for (const fund of value.funds) {
    object(fund); code(fund.code); text(fund.name, 60); integer(fund.initialShares, 0, 1_000_000_000);
    amount(fund.initialCost); date(fund.baseline); validateFee(fund.fee);
    ensure(fund.baseline.startsWith('2026-'), '初始持仓截至日期须在 2026 年');
    ensure(!fundCodes.has(fund.code), '基金代码重复'); fundCodes.add(fund.code);
    list(fund.modes, 1000); ensure(fund.modes.length > 0, '分红方式不能为空');
    let previous = '';
    for (const mode of fund.modes) {
      object(mode); date(mode.from); ensure(mode.mode === 'cash' || mode.mode === 'reinvest', '分红方式无效');
      ensure(mode.from > previous, '分红方式生效日期必须递增'); previous = mode.from;
    }
    ensure((fund.modes[0] as { from: string }).from <= fund.baseline, '初始分红方式生效时间晚于持仓起点');
  }
  for (const plan of value.plans) {
    object(plan); id(plan.id); code(plan.code); amount(plan.amount); date(plan.start); validateFee(plan.fee);
    ensure(!ids.has(plan.id), '计划 ID 重复'); ids.add(plan.id);
    ensure(fundCodes.has(plan.code), '计划引用不存在的基金');
    const fund = value.funds.find(f => (f as { code: string }).code === plan.code) as { baseline: string };
    ensure(plan.start > fund.baseline && plan.start.startsWith('2026-'), '定投起点须晚于初始持仓截至日期，且在 2026 年');
    if (plan.end !== undefined) { date(plan.end); ensure(plan.end >= plan.start, '结束日期早于开始日期'); }
    ensure(['weekly', 'monthly', 'trading'].includes(String(plan.cycle)), '周期无效');
    integer(plan.day, 1, plan.cycle === 'weekly' ? 7 : 31); integer(plan.interval, 1, 250);
    ensure(money(plan.amount) > 0n, '定投金额须大于零');
  }
  for (const trade of value.trades) {
    object(trade); id(trade.id); code(trade.code); date(trade.date); integer(trade.shares, 1, 1_000_000_000);
    amount(trade.price); amount(trade.fee); text(trade.note);
    ensure(money(trade.price) > 0n && ['buy', 'sell'].includes(String(trade.side)), '买卖或价格无效');
    ensure(fundCodes.has(trade.code), '交易引用不存在的基金');
    const fund = value.funds.find(f => (f as { code: string }).code === trade.code) as { baseline: string };
    ensure(trade.date > fund.baseline && trade.date.startsWith('2026-'), '交易日期须晚于初始持仓截至日期，且在 2026 年');
    ensure(!ids.has(trade.id), '交易 ID 重复'); ids.add(trade.id);
  }
  const overrideIds = new Set<string>();
  for (const override of value.overrides) {
    object(override); id(override.id); integer(override.shares, 0, 1_000_000_000);
    amount(override.price); amount(override.fee); text(override.note);
    ensure(money(override.price) > 0n, '成交价格须大于零');
    ensure(override.shares > 0 || money(override.fee) === 0n, '零成交不应填写手续费');
    ensure(!overrideIds.has(override.id), '成交修正 ID 重复'); overrideIds.add(override.id);
  }
  object(value.data);
  for (const [key, data] of Object.entries(value.data)) {
    code(key); ensure(fundCodes.has(key), '行情引用不存在的基金'); object(data);
    list(data.bars, 2000); list(data.dividends, 1000); list(data.splits, 100);
    const dates = new Set<string>();
    for (const bar of data.bars) {
      object(bar); date(bar.date); amount(bar.close);
      ensure(money(bar.close) > 0n && typeof bar.volume === 'number' && Number.isFinite(bar.volume) && bar.volume >= 0, '行情无效');
      ensure(!dates.has(bar.date), '日线日期重复'); dates.add(bar.date);
    }
    const divIds = new Set<string>(), events = new Set<string>();
    for (const div of data.dividends) {
      object(div); id(div.id); date(div.record); date(div.ex); date(div.pay); amount(div.perShare);
      text(div.source, 300); ensure(typeof div.confirmed === 'boolean', '分红确认状态无效');
      ensure(div.record <= div.ex && div.ex <= div.pay, '分红日期顺序异常');
      ensure(!divIds.has(div.id), '分红 ID 重复'); divIds.add(div.id);
      const eventKey = `${div.record}:${div.pay}`;
      ensure(!events.has(eventKey), '同一次分红事件重复'); events.add(eventKey);
      if (div.amount !== undefined) amount(div.amount);
      if (div.mode !== undefined) ensure(div.mode === 'cash' || div.mode === 'reinvest', '分红方式无效');
    }
    for (const split of data.splits) date(split);
    for (const field of ['error', 'dividendError']) if (data[field] !== undefined) text(data[field], 1000);
    for (const field of ['fetched', 'dividendFetched']) if (data[field] !== undefined) text(data[field], 40);
  }
  object(value.settings); ensure(typeof value.settings.online === 'boolean', '网络开关无效');
  if (value.settings.custom !== null) amount(value.settings.custom);
}

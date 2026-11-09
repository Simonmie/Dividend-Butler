import type { Fee } from './model';

const SCALE = 1_000_000n;
export function money(value: string): bigint {
  if (!/^\d{1,12}(?:\.\d{1,6})?$/.test(value)) throw new Error('金额应为非负数字，最多 6 位小数、12 位整数');
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole) * SCALE + BigInt(fraction.padEnd(6, '0'));
}
export function decimal(value: bigint): string {
  const sign = value < 0n ? '-' : '';
  const abs = value < 0n ? -value : value;
  return sign + (abs / SCALE).toString() + '.' + (abs % SCALE).toString().padStart(6, '0');
}
export function cents(value: bigint): bigint {
  if (value < 0n) return -cents(-value);
  return ((value + 5_000n) / 10_000n) * 10_000n;
}
export function display(value: string | null | undefined): string {
  if (value == null) return '--';
  const negative = value.startsWith('-');
  const rounded = cents(money(negative ? value.slice(1) : value));
  return `${negative ? '-' : ''}${rounded / SCALE}.${((rounded % SCALE) / 10_000n).toString().padStart(2, '0')}`;
}
export function commission(amount: bigint, fee: Fee): bigint {
  if (amount === 0n) return 0n;
  if (fee.kind === 'fixed') return cents(money(fee.value));
  const proportional = cents((amount * money(fee.value) + SCALE / 2n) / SCALE);
  const minimum = cents(money(fee.minimum));
  return proportional > minimum ? proportional : minimum;
}
export function purchase(budget: bigint, price: string, fee: Fee): { shares: number; cost: bigint; fee: bigint } {
  const p = money(price);
  if (p <= 0n) throw new Error('成交价格必须大于零');
  let low = 0n, high = budget / (p * 100n);
  // Binary search includes rounded commission, so a minimum charge cannot overspend the budget.
  while (low < high) {
    const mid = (low + high + 1n) / 2n;
    const gross = mid * 100n * p;
    if (cents(gross) + commission(gross, fee) <= budget) low = mid;
    else high = mid - 1n;
  }
  const gross = low * 100n * p;
  const shares = Number(low * 100n);
  if (!Number.isSafeInteger(shares)) throw new Error('份额超过可处理范围');
  return { shares, cost: cents(gross), fee: commission(gross, fee) };
}

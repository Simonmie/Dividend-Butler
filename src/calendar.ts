// Shanghai Stock Exchange 2026 closure schedule, checked on 2026-11-09.
export const CALENDAR_SOURCE = 'https://www.sse.com.cn/disclosure/dealinstruc/closed/';
const holidays = [
  ['2026-01-01', '2026-01-03'], ['2026-02-15', '2026-02-23'],
  ['2026-04-04', '2026-04-06'], ['2026-05-01', '2026-05-05'],
  ['2026-06-19', '2026-06-21'], ['2026-09-25', '2026-09-27'],
  ['2026-10-01', '2026-10-07']
];
export function validDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString().slice(0, 10) === value;
}
export function addDays(date: string, count: number): string {
  return new Date(Date.parse(date) + count * 86400000).toISOString().slice(0, 10);
}
export function today(): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date());
  const get = (type: string) => parts.find(p => p.type === type)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}
export function finalizedThrough(): string {
  const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Shanghai', hour: '2-digit', hour12: false }).format(new Date()));
  return hour >= 16 ? today() : addDays(today(), -1);
}
export function isTrading(date: string): boolean {
  if (!date.startsWith('2026-')) throw new Error('Beta 暂只内置已核验的 2026 年交易日历，跨年需更新日历');
  const weekday = new Date(date).getUTCDay();
  return weekday !== 0 && weekday !== 6 && !holidays.some(([a, b]) => date >= a && date <= b);
}
export function nextTrading(date: string): string {
  let result = date;
  for (let i = 0; i < 20; i++, result = addDays(result, 1)) if (isTrading(result)) return result;
  throw new Error('没有找到可核验的下一交易日');
}
export function dayRange(start: string, end: string): string[] {
  const days: string[] = [];
  for (let d = start; d <= end; d = addDays(d, 1)) {
    if (days.length >= 1100) throw new Error('日期范围过长');
    days.push(d);
  }
  return days;
}

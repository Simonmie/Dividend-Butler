import { get } from 'node:https';
import { load } from 'cheerio';
import { validDate } from './calendar';
import { decimal, money } from './money';
import type { Bar, Dividend } from './model';

const ALLOWED = new Set(['web.ifzq.gtimg.cn', 'fundf10.eastmoney.com']);
export function requestText(address: string, redirects = 0): Promise<string> {
  const url = new URL(address);
  if (url.protocol !== 'https:' || !ALLOWED.has(url.hostname) || redirects > 3) return Promise.reject(new Error('不允许访问该数据地址'));
  return new Promise((resolve, reject) => {
    const request = get(url, { headers: { 'User-Agent': 'DividendButler/0.1 (local personal portfolio)', 'Accept-Encoding': 'identity' } }, response => {
      if (response.statusCode && [301, 302, 303, 307, 308].includes(response.statusCode)) {
        response.resume();
        if (!response.headers.location) { reject(new Error('数据源重定向缺少地址')); return; }
        requestText(new URL(response.headers.location, url).href, redirects + 1).then(resolve, reject); return;
      }
      if (response.statusCode !== 200) { response.resume(); reject(new Error(`数据源返回 HTTP ${response.statusCode}`)); return; }
      let size = 0;
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > 8_000_000) request.destroy(new Error('数据响应过大'));
        else chunks.push(chunk);
      });
      response.on('error', reject);
      response.on('end', () => {
        try {
          const bytes = Buffer.concat(chunks);
          const meta = bytes.subarray(0, 2000).toString('ascii');
          const charset = /charset=["']?\s*([\w-]+)/i.exec(String(response.headers['content-type']) + meta)?.[1] ?? 'utf-8';
          resolve(new TextDecoder(/gb2312|gbk|gb18030/i.test(charset) ? 'gb18030' : 'utf-8').decode(bytes));
        } catch (error) { reject(error); }
      });
    });
    request.setTimeout(15000, () => request.destroy(new Error('数据源超时，请稍后刷新')));
    const timer = setTimeout(() => request.destroy(new Error('数据源总请求超时')), 20000);
    request.on('close', () => clearTimeout(timer));
    request.on('error', reject);
  });
}
export function parseBars(raw: string, code: string): Bar[] {
  const input = JSON.parse(raw);
  const market = code.startsWith('5') ? 'sh' : 'sz';
  if (input.code !== 0 || !Array.isArray(input.data?.[market + code]?.day)) throw new Error('行情格式已变化，或该 ETF 无不复权日线');
  const bars: Bar[] = input.data[market + code].day.map((row: unknown) => {
    if (!Array.isArray(row) || row.length < 6 || !validDate(String(row[0]))) throw new Error('日线日期格式错误');
    const close = String(row[2]); money(close);
    if (money(close) <= 0n || !Number.isFinite(Number(row[5])) || Number(row[5]) < 0) throw new Error('日线价格或成交量无效');
    return { date: String(row[0]), close, volume: Number(row[5]) };
  });
  if (!bars.length) throw new Error('行情没有返回日线记录');
  if (new Set(bars.map(bar => bar.date)).size !== bars.length) throw new Error('日线出现重复日期');
  return bars.sort((a, b) => a.date.localeCompare(b.date));
}
export function parseDividends(html: string, code: string): { dividends: Dividend[]; splits: string[] } {
  const $ = load(html);
  const source = `https://fundf10.eastmoney.com/fhsp_${code}.html`;
  if (!$('title').text().includes(code)) throw new Error('分红页面基金代码不匹配');
  const dividends: Dividend[] = [], splits: string[] = [];
  let found = false;
  $('table').each((_index, table) => {
    const header = $(table).find('tr').first().text().replace(/\s+/g, '');
    if (header.includes('权益登记日') && header.includes('分红发放日') && header.includes('每10份分红')) {
      found = true;
      $(table).find('tr').slice(1).each((_i, row) => {
        const cells = $(row).find('td').map((_j, cell) => $(cell).text().trim()).get();
        if (cells.length < 5) {
          if (/暂无|没有/.test(cells.join(''))) return;
          throw new Error('分红表格列数发生变化');
        }
        const [, record, ex, amount, pay] = cells;
        const match = /每\s*10\s*份.*?(\d+(?:\.\d+)?)\s*元/.exec(amount);
        if (!validDate(record) || !validDate(ex) || !validDate(pay) || !match || record > ex || ex > pay) throw new Error('分红金额或日期不完整，请手动核对披露');
        dividends.push({ id: `${code}:${record}:${pay}`, record, ex, pay,
          perShare: decimal(money(match[1]) / 10n), source, confirmed: false });
      });
    }
    if (header.includes('拆分折算日')) {
      $(table).find('tr').slice(1).each((_i, row) => {
        const cells = $(row).find('td').map((_j, cell) => $(cell).text().trim()).get();
        if (cells.length >= 3 && validDate(cells[1])) splits.push(cells[1]);
      });
    }
  });
  if (!found) throw new Error('没有识别到分红详情表，不能将解析失败视为无分红');
  if (new Set(dividends.map(d => d.id)).size !== dividends.length) throw new Error('分红数据出现重复事件');
  return { dividends: dividends.sort((a, b) => a.pay.localeCompare(b.pay)), splits };
}
export async function getBars(code: string): Promise<Bar[]> {
  const symbol = (code.startsWith('5') ? 'sh' : 'sz') + code;
  return parseBars(await requestText(`https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${symbol},day,,,640,`), code);
}
export async function getDividends(code: string): Promise<{ dividends: Dividend[]; splits: string[] }> {
  return parseDividends(await requestText(`https://fundf10.eastmoney.com/fhsp_${code}.html`), code);
}

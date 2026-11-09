export type Mode = 'cash' | 'reinvest';
export interface Fee { kind: 'fixed' | 'rate'; value: string; minimum: string }
export interface Fund {
  code: string; name: string; initialShares: number; initialCost: string; baseline: string;
  modes: { from: string; mode: Mode }[]; fee: Fee;
}
export interface Plan {
  id: string; code: string; amount: string; start: string; end?: string;
  cycle: 'weekly' | 'monthly' | 'trading'; day: number; interval: number; fee: Fee;
}
export interface Trade {
  id: string; code: string; date: string; side: 'buy' | 'sell';
  shares: number; price: string; fee: string; note: string;
}
export interface Override {
  id: string; shares: number; price: string; fee: string; note: string;
}
export interface Bar { date: string; close: string; volume: number }
export interface Dividend {
  id: string; record: string; ex: string; pay: string; perShare: string;
  source: string; confirmed: boolean; amount?: string; mode?: Mode;
}
export interface FundData {
  bars: Bar[]; dividends: Dividend[]; fetched?: string; error?: string;
  dividendFetched?: string; dividendError?: string; splits: string[];
}
export interface State {
  schemaVersion: 1; revision: number; saved: string;
  funds: Fund[]; plans: Plan[]; trades: Trade[]; overrides: Override[];
  data: Record<string, FundData>;
  settings: { custom: string | null; online: boolean };
}
export interface Row {
  id: string; date: string; code: string; kind: 'initial' | 'budget' | 'buy' | 'sell' | 'dividend' | 'reinvest';
  shares: number; price: string; amount: string; fee: string; note: string; simulated: boolean;
}
export interface Projection {
  code: string; shares: number; invested: string; value: string | null;
  cash: string; planCash: string; reinvestCash: string; rows: Row[];
  snapshots: Record<string, number>; warnings: string[];
}
export interface Estimate {
  code: string; date: string | null; amount: string | null; mode: Mode;
  basis: string; samples: number; stale: boolean;
}
export interface View {
  state: State; projections: Projection[]; estimates: Estimate[];
  total: string | null; coverage: number; today: string; busy: boolean;
  storageError?: string;
}
export const CANDIDATES = [
  { code: '510880', name: '红利ETF华泰柏瑞' },
  { code: '515180', name: '红利ETF易方达' },
  { code: '159905', name: '深红利ETF工银' }
];
export function emptyState(): State {
  return {
    schemaVersion: 1, revision: 0, saved: new Date().toISOString(),
    funds: [], plans: [], trades: [], overrides: [], data: {},
    settings: { custom: null, online: false }
  };
}

import { createApp, h, ref, reactive, type VNodeChild } from 'vue';
import { CANDIDATES, type View, type Row, type Fund } from '../src/model';
import { display, money, decimal } from '../src/money';
import { addDays, today } from '../src/calendar';
import './style.css';

declare function acquireVsCodeApi(): { postMessage(message: unknown): void };
const vscode = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : null;
const view = ref<View | null>(null);
const waiting = ref(false);
const notice = ref('');
const failed = ref(false);
async function send(type: string, payload: unknown = {}) {
  if (waiting.value && type !== 'ready') return;
  waiting.value = type !== 'ready'; notice.value = '';
  const message = { type, payload, revision: view.value?.state.revision ?? 0 };
  if (vscode) { vscode.postMessage(message); return; }
  try {
    const response = await fetch('/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(message) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error);
    view.value = result; failed.value = false; if (type !== 'ready') notice.value = '已完成';
  } catch (error) { failed.value = true; notice.value = error instanceof Error ? error.message : '操作失败'; }
  finally { waiting.value = false; }
}
window.addEventListener('message', event => {
  if (!vscode) return;
  if (event.data?.type === 'view') view.value = event.data.view;
  if (event.data?.type === 'error') { failed.value = true; notice.value = event.data.message; }
  if (event.data?.type === 'success') { failed.value = false; notice.value = '已保存'; }
  if (event.data?.type === 'settled') waiting.value = false;
});
const tab = ref('overview');
const tabs = [['overview', '概览'], ['holdings', '持仓'], ['plans', '定投计划'], ['transactions', '交易流水'], ['dividends', '分红日历'], ['settings', '设置']];
const date = today();
const fundDraft = reactive({ code: '510880', shares: '0', cost: '0', baseline: date, mode: 'cash', kind: 'rate', value: '0.0003', minimum: '5' });
const planDraft = reactive({ code: '510880', amount: '1000', start: addDays(date, 1), end: '', cycle: 'monthly', day: '10', interval: '5', kind: 'rate', value: '0.0003', minimum: '5' });
const tradeDraft = reactive({ code: '510880', date: addDays(date, -1), side: 'buy', shares: '100', price: '', fee: '5', note: '' });
const dividendDraft = reactive({ code: '510880', record: '', ex: '', pay: '', perShare: '' });
const custom = ref('');
const filter = ref('');
const editing = ref<Row | null>(null);
const editDraft = reactive({ shares: '', price: '', fee: '', note: '' });
const confirming = ref<{ code: string; id: string } | null>(null);
const actualDividend = ref('');
const initialEditing = ref<Fund | null>(null);
const initialDraft = reactive({ shares: '', cost: '' });
const rowNames: Record<Row['kind'], string> = { initial: '初始持仓', budget: '预算入账', buy: '买入', sell: '卖出', dividend: '分红', reinvest: '再投资' };

function button(label: string, action: () => void, cls = 'secondary') {
  return h('button', { class: cls, type: 'button', disabled: waiting.value || view.value?.busy, onClick: action }, label);
}
function field(label: string, value: string, change: (value: string) => void, props: Record<string, unknown> = {}) {
  return h('label', { class: 'field' }, [h('span', label), h('input', { value, required: true, ...props,
    onInput: (event: Event) => change((event.target as HTMLInputElement).value) })]);
}
function select(label: string, value: string, change: (value: string) => void, choices: [string, string][]) {
  return h('label', { class: 'field' }, [h('span', label), h('select', { value, required: true,
    onChange: (event: Event) => change((event.target as HTMLSelectElement).value) },
  choices.map(([key, name]) => h('option', { value: key }, name)))]);
}
function badge(label: string, kind = '') { return h('span', { class: `badge ${kind}` }, label); }
function card(title: string, children: VNodeChild[], subtitle?: string) {
  return h('section', { class: 'card' }, [h('div', { class: 'section-heading' }, [h('h2', title), subtitle ? h('p', subtitle) : null]), ...children]);
}
function form(fields: VNodeChild[], submit: () => void, label: string) {
  return h('form', { onSubmit: (event: Event) => { event.preventDefault(); submit(); } },
    [h('div', { class: 'form-grid' }, fields), h('button', { class: 'primary', type: 'submit', disabled: waiting.value }, label)]);
}
function feeFields(draft: typeof fundDraft | typeof planDraft): VNodeChild[] {
  return [
    select('手续费模式', draft.kind, v => draft.kind = v, [['rate', '费率 + 最低收费'], ['fixed', '每笔固定费用']]),
    field(draft.kind === 'rate' ? '费率（万三填 0.0003）' : '固定费用（元）', draft.value, v => draft.value = v, { type: 'number', min: '0', step: '0.000001' }),
    draft.kind === 'rate' ? field('最低收费（元）', draft.minimum, v => draft.minimum = v, { type: 'number', min: '0', step: '0.01' }) : null
  ];
}
function fee(draft: typeof fundDraft | typeof planDraft) { return { kind: draft.kind, value: draft.value, minimum: draft.minimum }; }
function fundOptions(): [string, string][] { return (view.value?.state.funds ?? []).map(f => [f.code, `${f.name} · ${f.code}`]); }
function name(code: string) { return view.value?.state.funds.find(f => f.code === code)?.name ?? code; }
function empty(label: string) { return h('div', { class: 'empty' }, [h('h3', label), h('p', '添加持仓与定投计划后，这里会展示你的记录。')]); }
function sum(values: (string | null)[]): string | null {
  const available = values.filter((v): v is string => v !== null);
  return available.length ? decimal(available.reduce((a, v) => a + money(v), 0n)) : null;
}
function metric(label: string, value: string | null, caption: string, highlight = false) {
  return h('article', { class: `metric ${highlight ? 'highlight' : ''}` }, [h('span', label), h('strong', `¥ ${display(value)}`), h('small', caption)]);
}
function overview(v: View): VNodeChild[] {
  const cashEstimates = v.estimates.filter(e => e.mode === 'cash').map(e => e.amount);
  const reinvestEstimates = v.estimates.filter(e => e.mode === 'reinvest').map(e => e.amount);
  return [
    h('div', { class: 'metrics' }, [
      metric('预计下次分红总额', v.total, `覆盖 ${v.coverage}/${v.state.funds.length} 只 ETF · 日期可能不同`, true),
      metric('预计现金留存', sum(cashEstimates), '只合计现金分红方式的可用预测'),
      metric('预计计划再投资', sum(reinvestEstimates), '现金到账后模拟再次买入'),
      metric('持仓估算市值', sum(v.projections.map(p => p.value)), `当前已记录 ${v.state.funds.length} 只 ETF · 不含余款`)
    ]),
    card('接下来的分红', [
      v.estimates.length ? h('div', { class: 'forecast-list' }, v.estimates.map(e => h('article', { class: 'forecast' }, [
        h('div', [h('strong', name(e.code)), h('p', { class: 'muted' }, `${e.code} · ${e.date ? `预计 ${e.date}` : '日期未知'}`)]),
        h('div', [h('strong', { class: 'amount' }, `¥ ${display(e.amount)}`), badge(e.mode === 'cash' ? '现金留存' : '计划再投资')]),
        h('p', { class: 'forecast-basis' }, e.basis), e.stale ? badge('缓存 / 待核对', 'warning') : null
      ]))) : empty('还没有持仓'),
      button('管理持仓', () => tab.value = 'holdings')
    ], '历史预测不是收益承诺；不将预测金额记为已到账。'),
    card('账本状态', [
      h('div', { class: 'summary-grid' }, [
        metric('累计投入及初始成本', sum(v.projections.map(p => p.invested)), '包括定投预算与余款，不是当前持仓成本'),
        metric('定投待用余款', sum(v.projections.map(p => p.planCash)), '按计划独立结转，整手不足时保留'),
        metric('现金留存余额', sum(v.projections.map(p => p.cash)), '已确认分红与手动卖出的现金'),
        metric('再投资余款', sum(v.projections.map(p => p.reinvestCash)), '同 ETF 后续再投资可继续使用')
      ]),
      ...v.projections.flatMap(p => p.warnings.map(w => h('p', { class: 'warning-box' }, `${p.code}：${w}`))),
      h('p', { class: 'muted' }, '未接券商。自动生成的是模拟成交，实际成交可在交易流水中修正。')
    ])
  ];
}
function holdingRow(fund: Fund, v: View) {
  const p = v.projections.find(p => p.code === fund.code)!;
  const data = v.state.data[fund.code];
  return h('article', { class: 'holding' }, [
    h('div', { class: 'holding-title' }, [h('div', [h('h3', fund.name), h('p', { class: 'muted' }, `${fund.code} · 初始截至 ${fund.baseline}`)]), badge(`${p.shares.toLocaleString()} 份`)]),
    h('div', { class: 'summary-grid compact' }, [
      metric('估算市值', p.value, data.bars.at(-1) ? `不复权收盘价 · ${data.bars.at(-1)!.date}` : '行情尚未查询'),
      metric('累计投入', p.invested, '含预算余款，不是实时成本')
    ]),
    select('未来分红方式（修改明日起生效）', fund.modes.at(-1)!.mode,
      mode => void send('setMode', { code: fund.code, mode }), [['cash', '现金留存'], ['reinvest', '分红后模拟再投资']]),
    h('p', { class: 'muted' }, `再投资费用：${fund.fee.kind === 'fixed' ? `${fund.fee.value} 元/笔` : `费率 ${fund.fee.value}，最低 ${fund.fee.minimum} 元`}；初始费用规则在 Beta 中保持不变。`),
    button('修正初始份额与成本', () => {
      initialEditing.value = fund; initialDraft.shares = String(fund.initialShares); initialDraft.cost = fund.initialCost;
    }),
    button('删除持仓及其记录', () => void send('deleteFund', { code: fund.code }), 'danger')
  ]);
}
function holdings(v: View): VNodeChild[] {
  const available = CANDIDATES.filter(f => !v.state.funds.some(item => item.code === f.code));
  if (!available.some(f => f.code === fundDraft.code) && available.length) fundDraft.code = available[0].code;
  return [
    card('我的 ETF', [v.state.funds.length ? h('div', { class: 'holding-grid' }, v.state.funds.map(f => holdingRow(f, v))) : empty('开始记录第一只 ETF')]),
    available.length ? card('添加初始持仓', [
      form([
        select('基金', fundDraft.code, x => fundDraft.code = x, available.map(f => [f.code, `${f.name} · ${f.code}`])),
        field('截至日期（当日收盘后份额）', fundDraft.baseline, x => fundDraft.baseline = x, { type: 'date', min: '2026-01-01', max: v.today }),
        field('当前持有份额', fundDraft.shares, x => fundDraft.shares = x, { type: 'number', min: '0', step: '1', max: '1000000000' }),
        field('总投入成本（元）', fundDraft.cost, x => fundDraft.cost = x, { type: 'number', min: '0', step: '0.01' }),
        select('分红方式', fundDraft.mode, x => fundDraft.mode = x, [['cash', '现金留存'], ['reinvest', '模拟再投资']]),
        ...feeFields(fundDraft)
      ], () => void send('addFund', { code: fundDraft.code, baseline: fundDraft.baseline, shares: Number(fundDraft.shares), cost: fundDraft.cost, fee: fee(fundDraft), mode: fundDraft.mode }), '添加持仓'),
      h('p', { class: 'muted' }, '从截至日期之后开始记录交易，不回溯此前定投。首批只开放上述 3 只 A 股红利 ETF，不代表投资推荐。')
    ]) : null
  ];
}
function plans(v: View): VNodeChild[] {
  if (!v.state.funds.length) return [empty('请先添加 ETF 持仓')];
  if (!v.state.funds.some(f => f.code === planDraft.code)) planDraft.code = v.state.funds[0].code;
  const fund = v.state.funds.find(f => f.code === planDraft.code)!;
  return [
    card('定投计划', [
      v.state.plans.length ? h('div', { class: 'plan-list' }, v.state.plans.map(p => h('article', { class: 'plan-item' }, [
        h('div', [h('strong', `${name(p.code)} · ¥${display(p.amount)}`),
          h('p', { class: 'muted' }, `${p.cycle === 'weekly' ? `每周${['', '一', '二', '三', '四', '五', '六', '日'][p.day]}` : p.cycle === 'monthly' ? `每月 ${p.day} 日` : `每 ${p.interval} 个交易日`} · ${p.start} 起${p.end ? ` · 截至 ${p.end}` : ''}`),
          h('p', { class: 'muted' }, '金额含手续费；非交易日顺延；同一计划余款结转。')]),
        badge(p.end && p.end <= v.today ? '已结束' : '启用中', p.end && p.end <= v.today ? '' : 'positive'),
        !p.end || p.end > v.today ? button('停止未来定投', () => void send('stopPlan', { id: p.id })) : null
      ]))) : empty('还没有定投计划')
    ], '修改或恢复计划时创建新计划，旧计划只停止未来周期，保留历史。'),
    card('新建定投计划', [
      form([
        select('基金', planDraft.code, x => planDraft.code = x, fundOptions()),
        field('每期预算（含手续费，元）', planDraft.amount, x => planDraft.amount = x, { type: 'number', min: '0.01', step: '0.01' }),
        field('开始日期', planDraft.start, x => planDraft.start = x, { type: 'date', min: addDays(fund.baseline, 1), max: '2026-12-31' }),
        field('结束日期（选填）', planDraft.end, x => planDraft.end = x, { type: 'date', min: planDraft.start, max: '2026-12-31', required: false }),
        select('周期', planDraft.cycle, x => { planDraft.cycle = x; planDraft.day = x === 'weekly' ? '1' : '10'; }, [['monthly', '每月'], ['weekly', '每周'], ['trading', '每 N 个交易日']]),
        planDraft.cycle === 'trading' ? field('交易日间隔 N', planDraft.interval, x => planDraft.interval = x, { type: 'number', min: '1', max: '250' })
          : field(planDraft.cycle === 'weekly' ? '星期（1=周一，7=周日）' : '每月日期（月底不存在则取月末）', planDraft.day, x => planDraft.day = x, { type: 'number', min: '1', max: planDraft.cycle === 'weekly' ? '7' : '31', step: '1' }),
        ...feeFields(planDraft)
      ], () => void send('addPlan', { ...planDraft, day: Number(planDraft.day), interval: Number(planDraft.interval), fee: fee(planDraft) }), '保存定投计划'),
      h('p', { class: 'muted' }, '按已结束交易日的收盘价自动模拟买入；不下单。停牌顺延，接口缺数暂停补算。')
    ])
  ];
}
function edit(row: Row) {
  editing.value = row; editDraft.shares = String(row.shares); editDraft.price = row.price; editDraft.fee = row.fee; editDraft.note = '';
}
function transactions(v: View): VNodeChild[] {
  if (!v.state.funds.length) return [empty('请先添加 ETF 持仓')];
  if (!v.state.funds.some(f => f.code === tradeDraft.code)) tradeDraft.code = v.state.funds[0].code;
  const rows = v.projections.flatMap(p => p.rows).filter(r => !filter.value || r.code === filter.value).sort((a, b) => b.date.localeCompare(a.date));
  return [
    card('交易流水', [
      select('按基金筛选', filter.value, x => filter.value = x, [['', '全部基金'], ...fundOptions()]),
      rows.length ? h('div', { class: 'table-wrap' }, [h('table', [
        h('thead', [h('tr', ['日期 / 基金', '事件', '份额', '价格 / 每份分红', '金额', '费用', '依据 / 操作'].map(s => h('th', s)))]),
        h('tbody', rows.map(row => h('tr', { key: row.id }, [
          h('td', [h('strong', row.date), h('small', row.code)]),
          h('td', [rowNames[row.kind], badge(row.simulated ? '模拟' : '手动 / 确认', row.simulated ? '' : 'positive')]),
          h('td', row.shares.toLocaleString()), h('td', row.price === '0' ? '--' : row.price),
          h('td', `¥${display(row.amount)}`), h('td', `¥${display(row.fee)}`),
          h('td', [h('small', row.note),
            row.id.startsWith('sip:') || row.id.startsWith('reinvest:') ? button('修正成交', () => edit(row)) : null,
            v.state.overrides.some(o => o.id === row.id) ? button('恢复模拟', () => void send('clearOverride', { id: row.id })) : null,
            v.state.trades.some(t => t.id === row.id) ? button('删除', () => void send('deleteTrade', { id: row.id }), 'danger') : null])
        ])))
      ])]) : empty('暂无流水')
    ]),
    card('补录定投之外的实际买卖', [
      form([
        select('基金', tradeDraft.code, x => tradeDraft.code = x, fundOptions()),
        select('交易方向', tradeDraft.side, x => tradeDraft.side = x, [['buy', '额外投入买入'], ['sell', '卖出']]),
        field('成交日期', tradeDraft.date, x => tradeDraft.date = x, { type: 'date', min: '2026-01-01', max: v.today }),
        field('实际份额', tradeDraft.shares, x => tradeDraft.shares = x, { type: 'number', min: '1', step: '1' }),
        field('实际成交价（元）', tradeDraft.price, x => tradeDraft.price = x, { type: 'number', min: '0.000001', step: '0.000001' }),
        field('实际手续费（元）', tradeDraft.fee, x => tradeDraft.fee = x, { type: 'number', min: '0', step: '0.01' }),
        field('备注（选填）', tradeDraft.note, x => tradeDraft.note = x, { required: false, maxlength: '200' })
      ], () => void send('addTrade', { ...tradeDraft, shares: Number(tradeDraft.shares) }), '保存实际交易')
    ])
  ];
}
function dividends(v: View): VNodeChild[] {
  if (!v.state.funds.length) return [empty('请先添加 ETF 持仓')];
  if (!v.state.funds.some(f => f.code === dividendDraft.code)) dividendDraft.code = v.state.funds[0].code;
  const records = v.state.funds.flatMap(f => v.state.data[f.code].dividends.map(div => ({ ...div, code: f.code, baseline: f.baseline }))).sort((a, b) => b.pay.localeCompare(a.pay));
  return [
    card('分红披露与到账记录', [
      h('p', { class: 'warning-box' }, '公开分红表不等于已核验实施公告或券商到账。请核对后确认；未确认事件不会增加现金或触发再投资。确认后可填实际到账金额。'),
      records.length ? h('div', { class: 'table-wrap' }, [h('table', [
        h('thead', [h('tr', ['基金', '登记 / 除息', '发放日', '每份分红', '状态', '操作'].map(s => h('th', s)))]),
        h('tbody', records.map(div => h('tr', { key: div.id }, [
          h('td', [name(div.code), h('small', div.code)]), h('td', [div.record, h('small', div.ex)]),
          h('td', div.pay), h('td', `¥${div.perShare}`),
          h('td', badge(div.confirmed ? '已确认' : div.pay <= div.baseline ? '初始快照之前' : '未确认')),
          h('td', [
            div.pay <= v.today && div.record > div.baseline && !div.confirmed
              ? button('核对并确认到账', () => { confirming.value = { code: div.code, id: div.id }; actualDividend.value = ''; }) : null,
            div.confirmed ? button('撤销确认', () => void send('unconfirmDividend', { code: div.code, id: div.id })) : null,
            h('small', div.source === '用户手动录入' ? div.source : '来源：天天基金公开分红表')
          ])
        ])))
      ])]) : empty('尚未查询到历史分红')
    ]),
    card('手动补录分红披露', [
      form([
        select('基金', dividendDraft.code, x => dividendDraft.code = x, fundOptions()),
        field('权益登记日', dividendDraft.record, x => dividendDraft.record = x, { type: 'date' }),
        field('除息日', dividendDraft.ex, x => dividendDraft.ex = x, { type: 'date' }),
        field('分红发放日', dividendDraft.pay, x => dividendDraft.pay = x, { type: 'date' }),
        field('每份分红（元，不是每 10 份）', dividendDraft.perShare, x => dividendDraft.perShare = x, { type: 'number', min: '0', step: '0.000001' })
      ], () => void send('addDividend', { ...dividendDraft }), '保存分红披露')
    ])
  ];
}
function settings(v: View): VNodeChild[] {
  return [
    card('状态栏数值', [
      badge(v.state.settings.custom === null ? '自动估算' : `自定义 ¥${display(v.state.settings.custom)}`),
      form([field('自定义数值（元）', custom.value, x => custom.value = x, { type: 'number', min: '0', step: '0.01', placeholder: '例如 888.00' })],
        () => void send('settings', { custom: custom.value }), '使用自定义值'),
      button('恢复自动分红估算', () => void send('settings', { custom: '' }))
    ], '自定义值只影响展示，持续生效，不修改投资或分红记录。'),
    card('公开数据查询', [
      badge(v.state.settings.online ? '已开启' : '已关闭', v.state.settings.online ? 'positive' : ''),
      h('p', '行情：腾讯不复权日线；分红：天天基金公开分红表。只查询基金代码，不上传份额或本金。'),
      button(v.state.settings.online ? '关闭在线查询' : '同意并开启查询', () => void send('settings', { online: !v.state.settings.online }), 'primary'),
      h('p', { class: 'muted' }, '默认关闭，避免未经同意发送请求。打开后每 30 分钟检查行情缓存，分红缓存每日更新；可手动刷新。'),
      ...v.state.funds.map(f => h('p', { class: 'muted' }, `${f.code} · 行情 ${v.state.data[f.code].fetched ?? '未查询'} · 分红 ${v.state.data[f.code].dividendFetched ?? '未查询'}`))
    ]),
    card('本地数据与备份', [
      h('p', '账本保存在编辑器的扩展全局存储目录，不写入你的代码项目、不上传、不自动同步。VS Code 与 TRAE 数据独立，可通过备份迁移。'),
      h('div', { class: 'actions' }, [button('导出 JSON 备份', () => void send('export')), button('恢复 JSON 备份', () => void send('import'))]),
      h('p', { class: 'muted' }, `账本版本 ${v.state.schemaVersion} · 修订 ${v.state.revision} · 保存 ${v.state.saved}`),
      h('p', { class: 'warning-box' }, '备份包含明文财务信息。Beta 只支持 2026 年交易日历及首批 3 只 ETF；实际到账确认与交易修正仍需人工核对。不提供自动交易或收益保证。')
    ])
  ];
}
function dialog(): VNodeChild {
  if (initialEditing.value) return h('div', { class: 'modal-backdrop' }, [
    h('section', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': '修正初始持仓' }, [
      h('h2', '修正初始持仓'), h('p', `保持截至日期 ${initialEditing.value.baseline} 不变；会重算此后的交易与分红，请先备份。`),
      form([
        field('初始份额', initialDraft.shares, x => initialDraft.shares = x, { type: 'number', min: '0', step: '1' }),
        field('初始总投入成本（元）', initialDraft.cost, x => initialDraft.cost = x, { type: 'number', min: '0', step: '0.01' })
      ], () => { void send('updateInitial', { code: initialEditing.value!.code, shares: Number(initialDraft.shares), cost: initialDraft.cost }); initialEditing.value = null; }, '保存并重算'),
      button('取消', () => initialEditing.value = null)
    ])
  ]);
  if (editing.value) return h('div', { class: 'modal-backdrop' }, [
    h('section', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': '修正实际成交' }, [
      h('h2', '修正实际成交'), h('p', `${editing.value.code} · ${editing.value.date}；保存后重算余款与后续权益。`),
      form([
        field('实际份额（未成交填 0）', editDraft.shares, x => editDraft.shares = x, { type: 'number', min: '0', step: '1' }),
        field('实际成交价', editDraft.price, x => editDraft.price = x, { type: 'number', min: '0.000001', step: '0.000001' }),
        field('实际手续费', editDraft.fee, x => editDraft.fee = x, { type: 'number', min: '0', step: '0.01' }),
        field('备注', editDraft.note, x => editDraft.note = x, { required: false, maxlength: '200' })
      ], () => { void send('override', { ...editDraft, id: editing.value!.id, shares: Number(editDraft.shares) }); editing.value = null; }, '保存修正'),
      button('取消', () => editing.value = null)
    ])
  ]);
  if (confirming.value) return h('div', { class: 'modal-backdrop' }, [
    h('section', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': '确认分红' }, [
      h('h2', '确认分红记录'), h('p', '请先核对实施公告、登记日持仓和实际到账。留空金额会按登记日份额模拟，不代表确认券商余额。'),
      form([field('实际到账金额（选填，元）', actualDividend.value, x => actualDividend.value = x, { type: 'number', min: '0', step: '0.01', required: false })],
        () => { void send('confirmDividend', { ...confirming.value, amount: actualDividend.value }); confirming.value = null; }, '确认并记账'),
      button('取消', () => confirming.value = null)
    ])
  ]);
  return null;
}
createApp({
  setup() {
    void send('ready');
    return () => {
      const v = view.value;
      if (!v) return h('main', { class: 'loading' }, [h('h1', '红利管家'), h('p', notice.value || '正在读取本地账本…')]);
      return h('div', { class: 'shell' }, [
        h('header', { class: 'header' }, [
          h('div', { class: 'brand' }, [h('span', { class: 'brand-mark' }, '利'), h('div', [h('h1', '红利管家'), h('p', '让每一笔定投与分红都有记录')]), badge('BETA 0.1')]),
          h('div', { class: 'header-actions' }, [badge(v.state.settings.online ? '公开数据已开启' : '本地模式'), button(v.busy ? '正在查询…' : '刷新数据', () => void send('refresh'))])
        ]),
        h('nav', { class: 'tabs', 'aria-label': '管理面板导航' }, tabs.map(([key, label]) =>
          h('button', { type: 'button', class: tab.value === key ? 'active' : '', 'aria-current': tab.value === key ? 'page' : undefined,
            onClick: () => { tab.value = key; window.scrollTo(0, 0); } }, label))),
        notice.value ? h('p', { class: failed.value ? 'notice error' : 'notice', role: 'status' }, notice.value) : null,
        v.storageError ? h('div', { class: 'warning-box', role: 'alert' }, [
          h('p', v.storageError), h('p', '当前显示的是恢复界面，不是空账户；原账本未被覆盖。'),
          button('恢复有效 JSON 备份', () => void send('import'))
        ]) : null,
        !v.state.settings.online ? h('div', { class: 'offline-banner' }, [
          h('span', '当前为本地模式。可先填写计划，开启公开数据后补算历史交易。'), button('前往数据设置', () => tab.value = 'settings')
        ]) : null,
        h('main', { class: 'content' }, tab.value === 'overview' ? overview(v) : tab.value === 'holdings' ? holdings(v)
          : tab.value === 'plans' ? plans(v) : tab.value === 'transactions' ? transactions(v) : tab.value === 'dividends' ? dividends(v) : settings(v)),
        h('footer', '仅用于本地记录与估算 · 模拟成交不等于实际成交 · 分红不等于新增收益'),
        dialog()
      ]);
    };
  }
}).mount('#app');

import type { UnitCost } from './portfolioCost';
import type { HistoryProgress } from './rebalanceHistory';

export interface HoldingQuote {
    symbol: string;
    name: string;
    currentPrice?: number;
    weight?: string;
}

export type CostPanelState =
    | { kind: 'loading'; progress?: HistoryProgress }
    | { kind: 'ready'; costs: ReadonlyMap<string, UnitCost> }
    | { kind: 'failed' };

export const panelId = 'xueqiu-portfolio-cost-panel';
const returnFormat = new Intl.NumberFormat(undefined, {
    style: 'percent',
    signDisplay: 'always',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
});

const columns = [
    ['name', '成分'],
    ['weight', '持仓占比'],
    ['cost', '成本'],
    ['change', '浮动盈亏'],
] as const;
const nameOrder = new Intl.Collator('zh-CN');

interface CostTableRow {
    element: HTMLTableRowElement;
    name: string;
    weight?: number;
    cost?: number;
    change?: number;
}

function createSortHeader(body: HTMLTableSectionElement, readRows: () => readonly CostTableRow[]) {
    const head = document.createElement('thead');
    const heading = document.createElement('tr');
    let sort: { key: typeof columns[number][0]; header: HTMLTableCellElement; ascending: boolean } | undefined;

    function renderRows(): void {
        const rows = [...readRows()];
        if (sort) {
            const { key, ascending } = sort;
            const direction = ascending ? 1 : -1;
            rows.sort((left, right) => {
                if (key === 'name') return direction * nameOrder.compare(left.name, right.name);
                const a = left[key];
                const b = right[key];
                if (a === undefined) return b === undefined ? 0 : 1;
                if (b === undefined) return -1;
                return direction * (a - b);
            });
        }
        body.replaceChildren(...rows.map(row => row.element));
    }

    for (const [key, label] of columns) {
        const header = document.createElement('th');
        header.scope = 'col';
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = label;
        const icon = document.createElement('span');
        icon.className = 'sort-icon';
        icon.setAttribute('aria-hidden', 'true');
        button.append(icon);

        button.addEventListener('click', () => {
            const ascending = sort?.header === header ? !sort.ascending : key === 'name';
            sort?.header.removeAttribute('aria-sort');
            sort = { key, header, ascending };
            header.setAttribute('aria-sort', ascending ? 'ascending' : 'descending');
            renderRows();
        });

        header.append(button);
        heading.append(header);
    }

    head.append(heading);
    return { head, renderRows };
}

export function createCostPanel() {
    const host = document.createElement('div');
    host.id = panelId;
    const shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = panelStyles;

    const panel = document.createElement('details');
    panel.open = true;
    const summary = document.createElement('summary');
    summary.textContent = '持仓成本';

    const content = document.createElement('div');
    content.className = 'panel-content';
    const scroll = document.createElement('div');
    scroll.className = 'scroll';
    const table = document.createElement('table');
    table.setAttribute('aria-label', '组合持仓占比、成本和浮动盈亏');
    const body = document.createElement('tbody');
    let rows: CostTableRow[] = [];
    const { head, renderRows } = createSortHeader(body, () => rows);
    table.append(head, body);
    scroll.append(table);
    const overlay = document.createElement('div');
    overlay.className = 'loading';
    const loadingLabel = document.createElement('span');
    loadingLabel.setAttribute('role', 'status');
    const progressBar = document.createElement('progress');
    progressBar.setAttribute('aria-label', '调仓历史读取进度');
    overlay.append(loadingLabel, progressBar);
    const loadError = document.createElement('p');
    loadError.className = 'load-error';
    loadError.setAttribute('role', 'status');
    loadError.textContent = '调仓历史加载失败，刷新页面可重试。';
    content.append(scroll, overlay, loadError);
    panel.append(summary, content);
    shadow.append(style, panel);

    let visiblePositions: readonly HoldingQuote[] = [];
    let state: CostPanelState = { kind: 'loading' };
    const renderHoldings = () => {
        if (!panel.open) return;
        const loading = state.kind === 'loading';
        table.setAttribute('aria-busy', String(loading));
        scroll.inert = loading;
        overlay.hidden = !loading;
        loadError.hidden = state.kind !== 'failed';
        if (state.kind === 'loading') {
            if (state.progress) {
                const { loadedPages, totalPages } = state.progress;
                loadingLabel.textContent = `正在读取调仓历史 ${loadedPages} / ${totalPages} 页`;
                progressBar.max = totalPages;
                progressBar.value = loadedPages;
            } else {
                loadingLabel.textContent = '正在读取调仓历史';
                progressBar.removeAttribute('value');
            }
        }
        rows = visiblePositions.map(position => createCostRow(position, state));
        renderRows();
    };
    panel.addEventListener('toggle', renderHoldings);

    return (positions: readonly HoldingQuote[], nextState: CostPanelState): void => {
        visiblePositions = positions;
        state = nextState;
        if (!positions.length) {
            host.remove();
        } else if (!host.isConnected && !document.getElementById(panelId)) {
            document.body.append(host);
        }
        renderHoldings();
    };
}

function createCostRow(
    { name, symbol, currentPrice, weight }: HoldingQuote,
    state: CostPanelState,
): CostTableRow {
    const cost = state.kind === 'ready' ? state.costs.get(symbol) : undefined;
    const change = cost && currentPrice !== undefined ? currentPrice / cost.price - 1 : undefined;
    const stockCell = document.createElement('th');
    stockCell.scope = 'row';
    stockCell.textContent = name;
    stockCell.title = symbol;

    const weightCell = document.createElement('td');
    weightCell.textContent = weight || '—';
    const costCell = document.createElement('td');
    costCell.textContent = state.kind === 'loading' ? '加载中' : '成本不可用';
    if (cost) {
        const price = cost.price < 0.01 ? cost.price.toPrecision(2) : cost.price.toFixed(2);
        costCell.textContent = (cost.estimated ? '~' : '') + price;
    }
    const returnCell = document.createElement('td');
    const displayedChange = change !== undefined && Math.abs(change) < 0.00005 ? 0 : change;
    returnCell.textContent = displayedChange === undefined ? '—' : returnFormat.format(displayedChange);
    if (displayedChange !== undefined && displayedChange !== 0) {
        returnCell.className = displayedChange > 0 ? 'gain' : 'loss';
    }
    const row = document.createElement('tr');
    row.append(stockCell, weightCell, costCell, returnCell);

    const weightNumber = weight?.match(/^(\d+(?:\.\d+)?)\s*%$/)?.[1];
    return {
        element: row,
        name,
        weight: weightNumber === undefined ? undefined : Number(weightNumber),
        cost: cost?.price,
        change,
    };
}

const panelStyles = `
    :host {
        all: initial;
        position: fixed;
        z-index: 2147483647;
        inset: auto 16px 16px auto;
        max-width: calc(100vw - 32px);
        font: 13px/1.4 system-ui, sans-serif;
        color: var(--text);
        --text: #172033;
        --surface: #fff;
        --sheet: #f6f8fa;
        --border: #dce2e9;
        --muted: #546174;
        --gain: #ad2635;
        --loss: #08764b;
    }

    details {
        margin-left: auto;
        width: max-content;
        max-width: 100%;
        overflow: hidden;
        background: var(--surface);
        border: 1px solid var(--border);
        border-radius: 12px;
        box-shadow: 0 8px 24px #10182829;
    }

    details[open] { width: 430px; }
    summary {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 16px;
        padding: 10px 14px;
        color: inherit;
        font-weight: 650;
        cursor: pointer;
        list-style: none;
    }
    summary::-webkit-details-marker { display: none; }
    summary::after { content: '+'; color: var(--muted); }
    details[open] summary::after { content: '−'; }
    summary:focus-visible { outline: 2px solid currentColor; outline-offset: -3px; }

    .panel-content { position: relative; }
    .panel-content:has(.loading:not([hidden])) { min-height: 112px; }
    .loading:not([hidden]) {
        position: absolute;
        inset: 0;
        display: grid;
        align-content: center;
        justify-items: center;
        gap: 10px;
        text-align: center;
        background: color-mix(in srgb, var(--surface) 92%, transparent);
    }
    progress { width: min(68%, 220px); height: 8px; accent-color: var(--text); }
    .load-error { margin: 0; padding: 8px 12px; color: var(--muted); border-top: 1px solid var(--border); }
    .scroll { max-height: min(55vh, 420px); overflow: auto; }
    table { width: 100%; border-spacing: 0; font-variant-numeric: tabular-nums; }
    th, td { padding: 7px 12px; border-top: 1px solid var(--border); }
    th { text-align: left; }
    thead th {
        position: sticky;
        top: 0;
        font-size: 12px;
        font-weight: 600;
        color: var(--muted);
        background: var(--sheet);
    }
    thead button {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        padding: 0;
        border: 0;
        background: none;
        color: inherit;
        font: inherit;
        cursor: pointer;
    }
    thead button:hover, [aria-sort] button { color: var(--text); }
    thead button:focus-visible { outline: 2px solid currentColor; outline-offset: 2px; }
    .sort-icon { width: 1em; text-align: center; }
    .sort-icon::before { content: '↕'; }
    [aria-sort="ascending"] .sort-icon::before { content: '↑'; }
    [aria-sort="descending"] .sort-icon::before { content: '↓'; }
    tbody th { font-weight: 500; }
    td, thead th:not(:first-child) { text-align: right; white-space: nowrap; }
    .gain { color: var(--gain); }
    .loss { color: var(--loss); }

    @media (max-width: 400px) {
        th, td { padding-inline: 8px; }
        thead button { gap: 2px; }
    }

    @media (prefers-color-scheme: dark) {
        :host {
            --text: #edf1f5;
            --surface: #1d2632;
            --sheet: #263240;
            --border: #3a4756;
            --muted: #bac6d3;
            --gain: #ffa4ac;
            --loss: #7ee0ac;
        }
    }
`;

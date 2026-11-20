import { createCostPanel, panelId, type CostPanelState, type HoldingQuote } from './costPanel';
import { loadHoldingCosts } from './rebalanceHistory';
import { normalizeStockSymbol } from './stockSymbol';

const holdingSelector = 'span.stock-name';
const quotePricePattern = /^(?:(?:HK|US)?\$|[¥￥])?((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?)(?=[\s(（+−-]|港元|美元|元|$)/;
const quotePriceSuffix = /^\s*(?:港元|美元|元)?(?:\s*(?:[(（][^）)]*[)）]|[+−-]\d+(?:\.\d+)?[%％]?))*\s*$/;

function matchQuotePrice(text: string): RegExpMatchArray | null {
    const match = text.match(quotePricePattern);
    return match && quotePriceSuffix.test(text.slice(match[0].length)) ? match : null;
}

function readCurrentPrice(quote: string | undefined, symbol: string): number | undefined {
    if (!quote) return undefined;
    let match = matchQuotePrice(quote);
    const suffix = quote.slice(match?.[0].length ?? 0).trim();
    const ambiguousTicker = match !== null && /^\d+$/.test(match[0]) &&
        (/^0\d{4}$/.test(match[0]) || /^\d{5}$/.test(symbol));
    const hasPriceNotation = match !== null && (!ambiguousTicker || /^(?:港元|美元|元)/.test(suffix));
    if (!hasPriceNotation) {
        const ticker = quote.match(/^\S+/)?.[0];
        if (!ticker || normalizeStockSymbol(ticker) !== symbol) return undefined;
        match = matchQuotePrice(quote.slice(ticker.length).trim());
    }
    if (!match) return undefined;
    const amount = Number(match[1].replace(/,/g, ''));
    return Number.isFinite(amount) && amount > 0 ? amount : undefined;
}

function readQuoteTicker(quote: string | undefined): string | undefined {
    const match = quote?.match(/^([A-Z_][A-Z\d_]*(?:[.-][A-Z\d_]+)*|0\d{4})\s+([\s\S]+)$/i);
    if (!match) return undefined;
    const remaining = match[2];
    return matchQuotePrice(remaining) || /^(?:--|—)$/.test(remaining) ? match[1] : undefined;
}

function getCurrentPositions(): HoldingQuote[] {
    const positions: HoldingQuote[] = [];
    for (const element of Array.from(document.querySelectorAll<HTMLElement>(holdingSelector))) {
        const stock = element.closest('.stock');
        const name = element.querySelector('div .name')?.textContent?.trim();
        const quote = element.querySelector('div .price')?.textContent?.trim();
        const rawSymbol = stock?.getAttribute('href')?.match(/^(?:https:\/\/(?:www\.)?xueqiu\.com)?\/S\/([^/?#]+)/)?.[1] ||
            element.getAttribute('data-symbol') || stock?.getAttribute('data-symbol') ||
            readQuoteTicker(quote);
        if (!name || !rawSymbol) continue;

        const symbol = normalizeStockSymbol(rawSymbol);
        const currentPrice = readCurrentPrice(quote, symbol);
        const weight = stock?.querySelector('.stock-weight')?.textContent?.trim();
        positions.push({ symbol, currentPrice, name, weight });
    }
    return positions;
}

function affectsHoldings({ target, addedNodes, removedNodes, attributeName, oldValue }: MutationRecord): boolean {
    if (Array.from(removedNodes).some(node => node instanceof Element && node.id === panelId)) return true;
    const element = target instanceof Element ? target : target.parentElement;
    if (element?.closest('.stock, ' + holdingSelector)) return true;
    if (attributeName === 'class' && oldValue?.split(/\s+/).some(name => name === 'stock' || name === 'stock-name')) {
        return true;
    }
    return [...Array.from(addedNodes), ...Array.from(removedNodes)].some(node =>
        node instanceof Element && (node.matches(holdingSelector) || node.querySelector(holdingSelector) !== null)
    );
}

async function displayHoldingCosts(cubeSymbol: string): Promise<void> {
    let state: CostPanelState = { kind: 'loading' };
    const updatePanel = createCostPanel();
    let lastPositions: string | undefined;
    const syncPositions = (force = false) => {
        const positions = getCurrentPositions();
        const snapshot = JSON.stringify(positions);
        if (!force && snapshot === lastPositions && (!positions.length || document.getElementById(panelId))) return;
        lastPositions = snapshot;
        updatePanel(positions, state);
    };
    new MutationObserver(mutations => {
        if (mutations.some(affectsHoldings)) syncPositions();
    }).observe(document.body, {
        childList: true,
        characterData: true,
        subtree: true,
        attributeFilter: ['href', 'data-symbol', 'class'],
        attributeOldValue: true,
    });
    syncPositions();

    try {
        const costs = await loadHoldingCosts(cubeSymbol, progress => {
            state = { kind: 'loading', progress };
            syncPositions(true);
        });
        state = { kind: 'ready', costs };
    } catch (error) {
        console.error('无法读取组合调仓历史', error);
        state = { kind: 'failed' };
    }
    syncPositions(true);
}

const cubeSymbol = window.location.href.match(/^https:\/\/(?:www\.)?xueqiu\.com\/P\/(ZH\d+)/)?.[1];
if (cubeSymbol) {
    // The manifest injects at document_idle, when the DOM is available.
    void displayHoldingCosts(cubeSymbol);
}

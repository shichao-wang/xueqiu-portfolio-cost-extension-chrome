function showTooltips(content: string) {
    const element = document.createElement('div');
    element.textContent = `Hello from your Chrome extension! ${content}`;
    element.style.position = 'fixed';
    element.style.bottom = '10px';
    element.style.right = '10px';
    element.style.backgroundColor = 'white';
    element.style.border = '1px solid black';
    element.style.padding = '10px';
    element.style.zIndex = '1000';

    document.body.appendChild(element);
}

export interface Rebalancing {
    id: number;
    rebalancing_id: number;
    stock_id: number;
    stock_name: string;
    stock_symbol: string;
    volume: number;
    price: number;
    net_value: number;
    weight: number;
    target_weight: number;
    prev_weight: number;
    prev_target_weight: number;
    prev_weight_adjusted: number;
    prev_volume: number;
    prev_price: number;
    prev_net_value: number;
    proactive: boolean;
    created_at: number;
    updated_at: number;
    target_volume: number;
    prev_target_volume: number;
}

// 工具函数：判断买卖
function getAction(rebalancing: Rebalancing): "buy" | "sell" {
    return rebalancing.prev_weight_adjusted > rebalancing.target_weight ? "sell" : "buy";
}

async function fetchRebalanceHistory(zhNumber: string, count: number = 20): Promise<Rebalancing[]> {
    let histories: Rebalancing[] = [];

    let page = 0;
    while (true) {
        page += 1;
        const response = await fetch(`https://xueqiu.com/cubes/rebalancing/history.json?cube_symbol=${zhNumber}&count=${count}&page=${page}`);
        const result = await response.json();
        if (result.page != page) {
            throw new Error(`Expected page ${page}, but got ${result.page}`);
        }
        if (result.maxPage == 0 || result.page == result.maxPage) {
            break; // No more pages to fetch
        }
        for (const item of result.list) {
            histories = histories.concat(item.rebalancing_histories as Rebalancing[]);
        }
    }
    return histories;
}

export interface Position {
    symbol: string;
    name: string;
    currentPrice: number;
    element: HTMLElement;
}

function getCurrentPositions(): Position[] {
    const positions = document.querySelectorAll('span.stock-name');
    return Array.from(positions).map(item => {
        const name = (item.querySelector('div .name') as HTMLElement | null)?.textContent || '';
        const priceDiv = item.querySelector('div .price') as HTMLElement | null;

        let symbol = '';
        let currentPrice = 0;
        if (priceDiv && priceDiv.textContent) {
            const match = priceDiv.textContent.match(/^(\d+)\s+(\d+\.\d+)/);
            symbol = match?.[1] || '';
            currentPrice = parseFloat(match?.[2] || '0');
        }
        return {
            symbol,
            name,
            currentPrice,
            element: item as HTMLElement
        } as Position;
    }).filter(item => item.symbol && item.name);
}

function computeSymbolCost(histories: Rebalancing[], symbol: string): number {
    let totalCost = 0;
    let currentVolumn = 0;
    histories.reverse().forEach(item => {
        if (getAction(item) === "buy") {
            totalCost += item.price * item.volume;
            currentVolumn += item.volume;
        } else {
            totalCost -= item.price * item.volume;
            currentVolumn -= item.volume;
        }
    })
    console.log('Symbol', symbol, 'Total cost:', totalCost, 'Current volume:', currentVolumn);
    return totalCost / currentVolumn;
}

const match = window.location.href.match(/^https:\/\/xueqiu\.com\/P\/(ZH\d+)/);
console.log('Content script loaded');

if (match) {
    console.log('Matched URL:', window.location.href);
    const zhNumber = match[1];
    showTooltips(zhNumber);

    if ((window as any).__xueqiu_plugin_loaded__) {
        // 已经执行过，直接返回
        // @ts-ignore
        return;
    }
    // @ts-ignore
    (window as any).__xueqiu_plugin_loaded__ = true;

    window.onload = async () => {
        console.log('Window loaded');
        let rebalance_histories = await fetchRebalanceHistory(zhNumber)
            .catch(error => {
                console.error('分页请求失败:', error);
                return [] as Rebalancing[];
            });
        const positions = getCurrentPositions();
        positions.forEach(position => {
            const symbolHistory = rebalance_histories
                .filter(item => item.stock_symbol === position.symbol)
                .sort((a, b) => b.updated_at - a.updated_at);
            console.log('Symbol history for', position.symbol, symbolHistory);
            const symbolCost = computeSymbolCost(symbolHistory, position.symbol);
            const positionFloating = ((position.currentPrice - symbolCost) * 100 / symbolCost)
                .toLocaleString(undefined, { signDisplay: 'always', maximumFractionDigits: 2, minimumFractionDigits: 2 });
            position.element.querySelector('div .name')!.textContent += ` ${symbolCost.toFixed(2)}(${positionFloating}%)`;
            // position.element.textContent += ` (成本: ${symbolCost.toFixed(2)})`;
            if (symbolCost > position.currentPrice) {
                position.element.style.color = 'green';
            } else {
                position.element.style.color = 'red';
            }
        });
    }

}

export const historyPageAction = 'getRebalanceHistoryPage';
const historyPageSize = 50;
const historyRequestIntervalMs = 5000;

export function waitBetweenHistoryRequests(): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, historyRequestIntervalMs));
}

export async function fetchHistoryPage(
    cubeSymbol: string,
    page: number,
    credentials: RequestCredentials = 'same-origin',
): Promise<unknown> {
    const url = new URL('https://www.xueqiu.com/cubes/rebalancing/history.json');
    url.searchParams.set('cube_symbol', cubeSymbol);
    url.searchParams.set('count', String(historyPageSize));
    url.searchParams.set('page', String(page));
    let response = await fetch(url.href, { credentials });
    if (response.status === 502 || response.status === 503 || response.status === 504) {
        await waitBetweenHistoryRequests();
        response = await fetch(url.href, { credentials });
    }
    if (!response.ok) throw new Error(`调仓历史第 ${page} 页请求失败（HTTP ${response.status}）`);
    const contentType = response.headers.get('content-type');
    if (contentType && !contentType.toLowerCase().includes('json')) {
        throw new Error(`调仓历史第 ${page} 页返回 ${contentType}，无法继续读取`);
    }
    return response.json();
}

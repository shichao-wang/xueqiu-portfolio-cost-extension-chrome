export const historyPageAction = 'getRebalanceHistoryPage';

export async function fetchHistoryPage(
    cubeSymbol: string,
    page: number,
    credentials: RequestCredentials = 'same-origin',
): Promise<unknown> {
    const url = new URL('https://www.xueqiu.com/cubes/rebalancing/history.json');
    url.searchParams.set('cube_symbol', cubeSymbol);
    url.searchParams.set('count', '20');
    url.searchParams.set('page', String(page));
    let response = await fetch(url.href, { credentials });
    if (response.status === 502 || response.status === 503 || response.status === 504) {
        response = await fetch(url.href, { credentials });
    }
    if (!response.ok) throw new Error(`调仓历史请求失败（HTTP ${response.status}）`);
    return response.json();
}

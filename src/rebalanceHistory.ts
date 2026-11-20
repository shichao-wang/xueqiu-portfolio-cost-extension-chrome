import { calculateHoldingCosts, quantitiesMatch, HoldingChange, UnitCost } from './portfolioCost';
import { fetchHistoryPage, historyPageAction, waitBetweenHistoryRequests } from './historyPage';
import { normalizeStockSymbol } from './stockSymbol';

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonNegativeNumber(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function pageNumber(value: unknown): number | undefined {
    const number = nonNegativeNumber(typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value);
    return number !== undefined && Number.isSafeInteger(number) ? number : undefined;
}

function parseHoldingChange(
    detail: Record<string, unknown>,
    rebalance: Record<string, unknown>,
): HoldingChange | { kind: 'unorderable'; symbol: string; id?: number; updatedAt?: number } {
    if (typeof detail.stock_symbol !== 'string' || !detail.stock_symbol) {
        throw new Error('调仓历史缺少证券代码');
    }

    const symbol = normalizeStockSymbol(detail.stock_symbol);
    const id = nonNegativeNumber(detail.id);
    const executedAt = nonNegativeNumber(detail.created_at);
    const requestedAt = nonNegativeNumber(rebalance.created_at);
    const detailUpdatedAt = nonNegativeNumber(detail.updated_at);
    const rebalanceUpdatedAt = nonNegativeNumber(rebalance.updated_at);
    const validUpperBounds = [detailUpdatedAt, rebalanceUpdatedAt].filter(
        (time): time is number => time !== undefined && (requestedAt === undefined || time >= requestedAt)
    );
    const latestPossibleExecution = validUpperBounds.length ? Math.min(...validUpperBounds) : undefined;
    const timestamp = executedAt ?? latestPossibleExecution;
    if (timestamp === undefined ||
        (executedAt !== undefined && (
            (requestedAt !== undefined && executedAt < requestedAt) ||
            (detailUpdatedAt !== undefined && executedAt > detailUpdatedAt)
        ))) {
        return { kind: 'unorderable', symbol, id, updatedAt: detailUpdatedAt };
    }
    const earliestTimestamp = executedAt === undefined && requestedAt !== undefined && requestedAt < timestamp
        ? requestedAt : undefined;
    const identity = {
        id,
        symbol,
        timestamp,
        updatedAt: detailUpdatedAt,
        earliestTimestamp,
        executionTimeConfirmed: executedAt !== undefined || requestedAt === latestPossibleExecution,
    };
    if (id === undefined) return { ...identity, kind: 'unavailable' };
    const system = rebalance.category === 'sys_rebalancing';
    const quantityBefore = detail.prev_volume === null && !system ? 0 : nonNegativeNumber(detail.prev_volume);
    const quantityAfter = nonNegativeNumber(detail.volume);
    if (rebalance.status !== 'success' || quantityAfter === undefined) {
        return { ...identity, kind: 'unavailable' };
    }
    if (quantityAfter === 0) return { ...identity, kind: 'closed' };

    if (system && quantityBefore !== 0 && (quantityBefore === undefined || !quantitiesMatch(quantityBefore, quantityAfter))) {
        // The history does not identify the cause. Estimate using the existing invested cost.
        const openingPrice = detail.prev_volume === null ? nonNegativeNumber(detail.price) : undefined;
        const predecessorId = nonNegativeNumber(rebalance.prev_bebalancing_id) || undefined;
        return { ...identity, kind: 'systemAdjustment', quantityBefore, quantityAfter, openingPrice, predecessorId };
    }
    if (quantityBefore === undefined) return { ...identity, kind: 'unavailable' };

    const snapshot = { ...identity, quantityBefore, quantityAfter };
    if (quantitiesMatch(quantityBefore, quantityAfter)) return { ...snapshot, kind: 'unchanged' };

    if (!system && rebalance.category !== 'user_rebalancing') return { ...identity, kind: 'unavailable' };
    if (quantityAfter < quantityBefore) return { ...snapshot, kind: 'sell' };

    const price = nonNegativeNumber(detail.price);
    if (!price) return { ...identity, kind: 'unavailable' };
    return { ...snapshot, kind: 'buy', price, estimated: system, priorQuantityMissing: detail.prev_volume === null };
}

async function readHistoryPage(cubeSymbol: string, page: number): Promise<unknown> {
    if (window.location.hostname === 'www.xueqiu.com') return fetchHistoryPage(cubeSymbol, page);

    // The apex API redirects to www. The extension worker can send credentials across origins.
    const response: unknown = await chrome.runtime.sendMessage({ action: historyPageAction, page });
    if (!isObject(response) || !('data' in response)) {
        throw new Error(isObject(response) && typeof response.error === 'string' ? response.error : '无法读取调仓历史');
    }
    return response.data;
}

export async function loadHoldingCosts(cubeSymbol: string): Promise<Map<string, UnitCost>> {
    const changes: HoldingChange[] = [];
    const undatedChanges: { symbol: string; id?: number; revision: number; signature?: string }[] = [];
    const datedSignatures = new Map<string, number>();
    const datedRevisions = new Map<number, number>();
    const rebalanceIds = new Set<number>();
    let expectedPages: number | undefined;
    let expectedRecords: number | undefined;
    let recordCount = 0;
    for (let page = 1; ; page++) {
        if (page > 1) await waitBetweenHistoryRequests();
        const result = await readHistoryPage(cubeSymbol, page);
        if (!isObject(result) || !Array.isArray(result.list) || pageNumber(result.page) !== page) {
            throw new Error(`无效的调仓历史分页（第 ${page} 页）`);
        }
        const maxPage = pageNumber(result.maxPage);
        if (maxPage === undefined ||
            (maxPage === 0 ? page !== 1 || result.list.length !== 0 : maxPage < page)) {
            throw new Error(`无效的调仓历史页数（第 ${page} 页）`);
        }
        if (result.list.length === 0 && (page > 1 || page < maxPage)) {
            throw new Error(`调仓历史分页为空（第 ${page} 页）`);
        }
        const totalCount = pageNumber(result.totalCount);
        if (page === 1) {
            expectedPages = maxPage;
            expectedRecords = totalCount;
        } else if (maxPage !== expectedPages || totalCount !== expectedRecords) {
            throw new Error('读取期间调仓历史发生变化');
        }

        recordCount += result.list.length;
        for (const rebalance of result.list) {
            if (!isObject(rebalance)) throw new Error('无效的调仓记录');
            const id = nonNegativeNumber(rebalance.id);
            if (id !== undefined) {
                if (rebalanceIds.has(id)) throw new Error('调仓分页包含重复记录');
                rebalanceIds.add(id);
            }
            switch (rebalance.status) {
                case 'pending':
                case 'failed':
                case 'canceled':
                case 'cancelled':
                    continue;
            }
            if (!Array.isArray(rebalance.rebalancing_histories)) {
                throw new Error('调仓记录缺少持仓变化明细');
            }
            for (const detail of rebalance.rebalancing_histories) {
                if (!isObject(detail)) throw new Error('无效的持仓变化明细');
                const change = parseHoldingChange(detail, rebalance);
                const signature = change.id === undefined ? undefined : JSON.stringify({
                    id: change.id,
                    symbol: change.symbol,
                    status: rebalance.status,
                    category: rebalance.category,
                    before: detail.prev_volume,
                    after: detail.volume,
                    price: detail.price,
                    predecessorId: rebalance.prev_bebalancing_id,
                });
                const revision = change.updatedAt ?? -Infinity;
                if (change.kind === 'unorderable') {
                    undatedChanges.push({ symbol: change.symbol, id: change.id, revision, signature });
                } else {
                    changes.push(change);
                    if (change.id !== undefined && signature !== undefined) {
                        datedSignatures.set(signature, Math.max(revision, datedSignatures.get(signature) ?? -Infinity));
                        datedRevisions.set(change.id, Math.max(revision, datedRevisions.get(change.id) ?? -Infinity));
                    }
                }
            }
        }
        if (page >= maxPage) {
            if (expectedRecords !== undefined && recordCount !== expectedRecords) {
                throw new Error('调仓历史记录数量不完整');
            }
            const costs = calculateHoldingCosts(changes);
            const disputedIds = new Set<number>();
            for (const { id, revision, signature, symbol } of undatedChanges) {
                const matchingRevision = signature === undefined ? undefined : datedSignatures.get(signature);
                const latestRevision = id === undefined ? undefined : datedRevisions.get(id);
                if (id === undefined || matchingRevision === undefined || revision > matchingRevision ||
                    matchingRevision !== latestRevision) {
                    costs.delete(symbol);
                    if (id !== undefined && latestRevision !== undefined && revision >= latestRevision) {
                        disputedIds.add(id);
                    }
                }
            }
            for (const { id, symbol } of changes) {
                if (id !== undefined && disputedIds.has(id)) costs.delete(symbol);
            }
            return costs;
        }
    }
}

export type RebalanceRow = Record<string, unknown>;

export interface CachedHistory {
    loadId: string;
    fullyVerifiedAt: number;
    observedAt: number;
    finishedAt: number;
    rows: RebalanceRow[];
}

export const saveHistoryAction = 'saveVerifiedRebalanceHistory';
export const checkHistoryAction = 'checkVerifiedRebalanceHistory';
const cachePrefix = 'rebalance-history-v2:';
const fullVerificationMaxAgeMs = 30 * 24 * 60 * 60 * 1000;
let pendingWrites = Promise.resolve();

function cacheKey(cubeSymbol: string): string {
    return cachePrefix + cubeSymbol;
}

function storage(): chrome.storage.StorageArea | undefined {
    return chrome.extension?.inIncognitoContext ? undefined : chrome.storage?.local;
}

export function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function cacheableId(row: RebalanceRow): row is RebalanceRow & { id: number } {
    return typeof row.id === 'number' && Number.isSafeInteger(row.id) && row.id > 0;
}

function isCachedRow(row: unknown): row is RebalanceRow & { id: number } {
    return isObject(row) && cacheableId(row) && (row.status !== 'success' ||
        (Array.isArray(row.rebalancing_histories) && row.rebalancing_histories.every(detail =>
            isObject(detail) && typeof detail.stock_symbol === 'string' && detail.stock_symbol.length > 0
        )));
}

const parentContextFields = ['status', 'category', 'created_at', 'updated_at', 'prev_bebalancing_id'];
const parentFields = ['id', ...parentContextFields];
const detailFields = ['id', 'stock_symbol', 'created_at', 'updated_at', 'prev_volume', 'volume', 'price'];

function selectFields(row: RebalanceRow, fields: readonly string[]): RebalanceRow | undefined {
    const selected: RebalanceRow = {};
    for (const field of fields) {
        const value = row[field];
        if (value === undefined) continue;
        if (value !== null && typeof value !== 'string' && typeof value !== 'boolean' &&
            (typeof value !== 'number' || !Number.isFinite(value))) return undefined;
        selected[field] = value;
    }
    return selected;
}

function cacheRow(row: RebalanceRow): RebalanceRow | undefined {
    const selected = selectFields(row, parentFields);
    if (!selected) return undefined;
    if (Array.isArray(row.rebalancing_histories)) {
        const details: RebalanceRow[] = [];
        for (const detail of row.rebalancing_histories) {
            const selectedDetail = isObject(detail) ? selectFields(detail, detailFields) : undefined;
            if (!selectedDetail) return undefined;
            details.push(selectedDetail);
        }
        selected.rebalancing_histories = details;
    }
    return selected;
}

type CacheEntry = CachedHistory | { invalidatedAt: number; refreshId?: string };

function parseCacheEntry(stored: unknown): CacheEntry | undefined {
    if (typeof stored !== 'string') return undefined;
    try {
        const history: unknown = JSON.parse(stored);
        if (!isObject(history)) return undefined;
        if (typeof history.invalidatedAt === 'number' && Number.isFinite(history.invalidatedAt)) {
            const refreshId = typeof history.refreshId === 'string' ? history.refreshId : undefined;
            return { invalidatedAt: history.invalidatedAt, refreshId };
        }
        if (typeof history.loadId !== 'string' || !history.loadId || typeof history.fullyVerifiedAt !== 'number' ||
            !Number.isFinite(history.fullyVerifiedAt) || typeof history.observedAt !== 'number' ||
            !Number.isFinite(history.observedAt) || history.observedAt < history.fullyVerifiedAt ||
            typeof history.finishedAt !== 'number' || !Number.isFinite(history.finishedAt) ||
            history.finishedAt < history.observedAt ||
            !Array.isArray(history.rows) || !history.rows.every(isCachedRow)) return undefined;
        if (new Set(history.rows.map(row => row.id)).size !== history.rows.length) return undefined;
        return {
            loadId: history.loadId,
            fullyVerifiedAt: history.fullyVerifiedAt, observedAt: history.observedAt,
            finishedAt: history.finishedAt, rows: history.rows,
        };
    } catch {
        return undefined;
    }
}

export async function readCachedHistory(cubeSymbol: string, now: number): Promise<CachedHistory | undefined> {
    const area = storage();
    if (!area) return undefined;
    const key = cacheKey(cubeSymbol);
    try {
        const history = parseCacheEntry((await area.get(key))[key]);
        if (history && 'rows' in history && history.rows.length && history.finishedAt <= now &&
            now - history.fullyVerifiedAt < fullVerificationMaxAgeMs) return history;
    } catch {
        // Fetch the full history when extension storage is unavailable.
    }
}

export async function isCurrentCachedHistory(cubeSymbol: string, previous: CachedHistory): Promise<boolean> {
    try {
        const current = await chrome.runtime.sendMessage({ action: checkHistoryAction, cubeSymbol, loadId: previous.loadId });
        const now = Date.now();
        return current === true && previous.finishedAt <= now &&
            now - previous.fullyVerifiedAt < fullVerificationMaxAgeMs;
    } catch {
        return false;
    }
}

export function checkVerifiedHistory(cubeSymbol: string, loadId: unknown): Promise<boolean> {
    const validation = pendingWrites.then(async () => {
        const key = cacheKey(cubeSymbol);
        const stored: unknown = (await chrome.storage?.local.get(key))?.[key];
        const history = parseCacheEntry(stored);
        return !!history && 'rows' in history && history.loadId === loadId;
    }).catch(() => false);
    pendingWrites = validation.then(() => {});
    return validation;
}

export async function saveCachedHistory(
    cubeSymbol: string, history: CachedHistory, completeCountVerified = true,
): Promise<void> {
    if (!storage()) return;
    const projected = history.rows.map(cacheRow);
    if (!completeCountVerified || !history.rows.every(cacheableId) || projected.some(row => row === undefined)) {
        await invalidateCachedHistory(cubeSymbol, history.loadId);
        return;
    }
    await sendCacheEntry(cubeSymbol, { ...history, rows: projected });
}

export function invalidateCachedHistory(cubeSymbol: string, refreshId: string): Promise<void> {
    if (!storage()) return Promise.resolve();
    return sendCacheEntry(cubeSymbol, { invalidatedAt: Date.now(), refreshId });
}

async function sendCacheEntry(cubeSymbol: string, entry: object): Promise<void> {
    try {
        await chrome.runtime.sendMessage({
            action: saveHistoryAction, cubeSymbol, history: JSON.stringify(entry),
        });
    } catch {
        // The verified history is still usable if storage is unavailable or full.
    }
}

export function storeVerifiedHistory(cubeSymbol: string, payload: unknown): Promise<void> {
    const history = parseCacheEntry(payload);
    if (!history) return Promise.resolve();
    const key = cacheKey(cubeSymbol);
    pendingWrites = pendingWrites.then(async () => {
        const area = chrome.storage?.local;
        if (!area) return;
        const current = parseCacheEntry((await area.get(key))[key]);
        let next: CacheEntry = history;
        if ('invalidatedAt' in history) {
            if (!history.refreshId || (current &&
                ('rows' in current ? current.fullyVerifiedAt : current.invalidatedAt) > history.invalidatedAt)) return;
            if (current && 'invalidatedAt' in current && current.refreshId !== history.refreshId) {
                next = { invalidatedAt: history.invalidatedAt };
            }
        } else if (current && 'invalidatedAt' in current) {
            const matchingFullRefresh = history.loadId === current.refreshId &&
                history.fullyVerifiedAt === history.observedAt && history.finishedAt >= current.invalidatedAt;
            if (history.fullyVerifiedAt <= current.invalidatedAt && !matchingFullRefresh) return;
        } else if (current && 'rows' in current) {
            if (history.finishedAt < current.observedAt) return;
            const overlaps = history.observedAt <= current.finishedAt;
            if (overlaps && JSON.stringify(history.rows) !== JSON.stringify(current.rows)) {
                // Different scans of overlapping periods cannot establish which older trades are current.
                next = { invalidatedAt: Math.max(history.finishedAt, current.finishedAt) };
            } else if (current.fullyVerifiedAt > history.fullyVerifiedAt ||
                (current.fullyVerifiedAt === history.fullyVerifiedAt && current.finishedAt >= history.finishedAt)) return;
        }

        const value = { [key]: JSON.stringify(next) };
        try {
            await area.set(value);
        } catch {
            const all = await area.get(null);
            const expired = Object.keys(all).filter(candidate => {
                if (candidate === key || !candidate.startsWith(cachePrefix)) return false;
                const entry = parseCacheEntry(all[candidate]);
                const checkedAt = entry && ('fullyVerifiedAt' in entry ? entry.fullyVerifiedAt : entry.invalidatedAt);
                const now = 'finishedAt' in history ? history.finishedAt : history.invalidatedAt;
                return checkedAt === undefined || now - checkedAt >= fullVerificationMaxAgeMs;
            });
            if (!expired.length) return;
            await area.remove(expired);
            await area.set(value);
        }
    }).catch(() => { /* Storage failure does not affect the current calculation. */ });
    return pendingWrites;
}

export function findCachedTail(
    fetched: RebalanceRow[], cached: RebalanceRow[], newCount: number, fetchedIds: ReadonlySet<number>,
): RebalanceRow[] | undefined {
    if (newCount < 0 || !fetched.every(cacheableId)) return undefined;
    const overlap = fetched.slice(newCount);
    if (!overlap.length || overlap.length > cached.length || !overlap.every((row, index) =>
        JSON.stringify(cacheRow(row)) === JSON.stringify(cached[index])
    )) return undefined;

    const tail = cached.slice(overlap.length);
    if (tail.some(row => !cacheableId(row) || fetchedIds.has(row.id) ||
        !['success', 'failed', 'canceled', 'cancelled'].some(status => status === row.status))) return undefined;
    if (newCount && hasConflictingDetails(fetched.slice(0, newCount), tail)) return undefined;
    return tail;
}

function* detailVersions(rows: RebalanceRow[]): IterableIterator<[number, string]> {
    for (const row of rows) {
        if (!Array.isArray(row.rebalancing_histories)) continue;
        for (const detail of row.rebalancing_histories) {
            if (!isObject(detail) || typeof detail.id !== 'number') continue;
            yield [detail.id, JSON.stringify([
                selectFields(row, parentContextFields), selectFields(detail, detailFields),
            ])];
        }
    }
}

function hasConflictingDetails(recent: RebalanceRow[], tail: RebalanceRow[]): boolean {
    const recentVersions = new Map<number, Set<string>>();
    for (const [id, version] of detailVersions(recent)) {
        const versions = recentVersions.get(id);
        if (versions) versions.add(version);
        else recentVersions.set(id, new Set([version]));
    }
    for (const [id, version] of detailVersions(tail)) {
        const versions = recentVersions.get(id);
        if (versions && (versions.size !== 1 || !versions.has(version))) return true;
    }
    return false;
}

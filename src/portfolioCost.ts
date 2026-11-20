interface RebalanceIdentity {
    id?: number;
    symbol: string;
    timestamp: number;
    updatedAt?: number;
    earliestTimestamp?: number;
    executionTimeConfirmed?: boolean;
}

export type HoldingChange = RebalanceIdentity & (
    { kind: 'unavailable' } |
    { kind: 'closed' } |
    { kind: 'systemAdjustment'; quantityBefore?: number; quantityAfter: number; openingPrice?: number; predecessorId?: number } |
    ({ quantityBefore: number; quantityAfter: number } & (
        { kind: 'buy'; price: number; estimated: boolean; priorQuantityMissing: boolean } |
        { kind: 'sell' | 'unchanged' }
    ))
);

interface HoldingCost {
    quantity: number;
    totalCost: number;
    estimated: boolean;
    lastSystemAdjustment?: { predecessorId: number; quantityBefore: number };
}

export interface UnitCost {
    price: number;
    estimated: boolean;
}

export function quantitiesMatch(left: number, right: number): boolean {
    return Math.abs(left - right) <= 4 * Number.EPSILON * Math.max(left, right);
}

function changeSignature({ timestamp, updatedAt, earliestTimestamp, executionTimeConfirmed, ...change }: HoldingChange): string {
    return JSON.stringify(change);
}

function mergeExecutionTimes(change: HoldingChange, copies: readonly HoldingChange[]): HoldingChange | undefined {
    const earliest = (change: HoldingChange) =>
        change.executionTimeConfirmed ? change.timestamp : change.earliestTimestamp ?? -Infinity;
    const lower = Math.max(...copies.map(earliest));
    const upper = Math.min(...copies.map(copy => copy.timestamp));
    if (lower > upper) return undefined;

    return {
        ...change,
        timestamp: upper,
        earliestTimestamp: Number.isFinite(lower) && lower < upper ? lower : undefined,
        executionTimeConfirmed: lower === upper,
    };
}

function latestChanges(changes: readonly HoldingChange[]): HoldingChange[] {
    const byId = new Map<number, HoldingChange[]>();
    const resolved: HoldingChange[] = [];
    for (const change of changes) {
        if (change.id === undefined) {
            resolved.push(change);
            continue;
        }
        const copies = byId.get(change.id);
        if (copies) copies.push(change);
        else byId.set(change.id, [change]);
    }

    const revision = (change: HoldingChange) => change.updatedAt ?? -Infinity;
    for (const copies of byId.values()) {
        if (copies.length === 1) {
            resolved.push(copies[0]);
            continue;
        }
        const newest = Math.max(...copies.map(revision));
        const latest = copies.filter(copy => revision(copy) === newest);
        const signature = changeSignature(latest[0]);
        const current = latest.every(copy => changeSignature(copy) === signature)
            ? mergeExecutionTimes(latest[0], latest) : undefined;
        if (current) {
            const matching = copies.filter(copy => changeSignature(copy) === signature);
            resolved.push(mergeExecutionTimes(current, matching) ?? current);
        } else {
            const timestamp = Math.max(...latest.map(copy => copy.timestamp));
            for (const symbol of new Set(latest.map(copy => copy.symbol))) {
                resolved.push({
                    id: latest[0].id,
                    symbol,
                    timestamp,
                    updatedAt: latest[0].updatedAt,
                    earliestTimestamp: timestamp,
                    kind: 'unavailable',
                });
            }
        }
    }
    return resolved;
}

type OrderedHoldingChange = HoldingChange & { orderEstimated?: boolean };

function executionStartsAt(change: HoldingChange): number {
    return change.executionTimeConfirmed ? change.timestamp : change.earliestTimestamp ?? -Infinity;
}

function orderHoldingChanges(changes: HoldingChange[]): OrderedHoldingChange[] {
    const confirmedTimes = changes.filter(change => change.executionTimeConfirmed).map(change => change.timestamp);
    const pending: OrderedHoldingChange[] = changes.map(change => {
        if (change.executionTimeConfirmed || change.kind === 'unavailable' ||
            !confirmedTimes.some(time => time >= (change.earliestTimestamp ?? -Infinity) && time <= change.timestamp)) {
            return { ...change };
        }
        return { ...change, kind: 'unavailable' as const, earliestTimestamp: change.timestamp };
    }).sort((a, b) =>
        (a.executionTimeConfirmed ? a.timestamp : a.updatedAt ?? a.timestamp) -
        (b.executionTimeConfirmed ? b.timestamp : b.updatedAt ?? b.timestamp) ||
        Number(a.kind === 'unavailable') - Number(b.kind === 'unavailable') ||
        (a.id ?? Number.MAX_SAFE_INTEGER) - (b.id ?? Number.MAX_SAFE_INTEGER)
    );
    const orderSensitive = pending.filter(change => change.kind !== 'unavailable' && change.kind !== 'unchanged');
    orderSensitive.sort((a, b) => executionStartsAt(a) - executionStartsAt(b) || a.timestamp - b.timestamp);
    let latestEnd: OrderedHoldingChange | undefined;
    for (const change of orderSensitive) {
        if (latestEnd && executionStartsAt(change) <= latestEnd.timestamp) {
            latestEnd.orderEstimated = true;
            change.orderEstimated = true;
        }
        if (!latestEnd || change.timestamp > latestEnd.timestamp) latestEnd = change;
    }
    let earliestEnd = Infinity;
    let readyInOrder = true;
    for (let index = pending.length - 1; index >= 0; index--) {
        earliestEnd = Math.min(earliestEnd, pending[index].timestamp);
        if (executionStartsAt(pending[index]) > earliestEnd) readyInOrder = false;
    }
    if (readyInOrder) return pending;

    const ordered: OrderedHoldingChange[] = [];
    const byEnd = [...pending].sort((a, b) => a.timestamp - b.timestamp);
    const remaining = new Set(pending);
    let endIndex = 0;
    let firstPending = 0;
    while (remaining.size) {
        // A change is ready when no remaining event must have executed before its window opened.
        while (!remaining.has(byEnd[endIndex])) endIndex++;
        while (!remaining.has(pending[firstPending])) firstPending++;
        for (let index = firstPending; index < pending.length; index++) {
            const change = pending[index];
            if (!remaining.has(change) || executionStartsAt(change) > byEnd[endIndex].timestamp) continue;
            ordered.push(change);
            remaining.delete(change);
            break;
        }
    }
    return ordered;
}

export function calculateHoldingCosts(changes: readonly HoldingChange[]): Map<string, UnitCost> {
    const bySymbol = new Map<string, HoldingChange[]>();
    for (const change of latestChanges(changes)) {
        const symbolChanges = bySymbol.get(change.symbol);
        if (symbolChanges) symbolChanges.push(change);
        else bySymbol.set(change.symbol, [change]);
    }
    const ordered: OrderedHoldingChange[] = [];
    for (const changes of bySymbol.values()) {
        ordered.push(...orderHoldingChanges(changes));
    }
    const holdings = new Map<string, HoldingCost | null>();
    const disputedUntil = new Map<string, number>();

    for (const change of ordered) {
        const { symbol } = change;
        const lastDispute = disputedUntil.get(symbol) ?? -Infinity;
        if (change.kind === 'unavailable') {
            disputedUntil.set(symbol, Math.max(lastDispute, change.timestamp));
            holdings.set(symbol, null);
            continue;
        }
        if (lastDispute !== -Infinity && executionStartsAt(change) <= lastDispute) continue;
        if (change.kind === 'closed') {
            holdings.delete(symbol);
            continue;
        }

        const holding = holdings.get(symbol);
        if (change.kind === 'systemAdjustment') {
            const { quantityBefore, quantityAfter, openingPrice, predecessorId } = change;
            if (holding) {
                const previous = holding.lastSystemAdjustment;
                const duplicate = quantityBefore !== undefined && predecessorId !== undefined &&
                    previous?.predecessorId === predecessorId && quantitiesMatch(previous.quantityBefore, quantityBefore) &&
                    quantitiesMatch(holding.quantity, quantityAfter);
                if (quantityBefore !== undefined && !quantitiesMatch(holding.quantity, quantityBefore) && !duplicate) {
                    holdings.set(symbol, null);
                } else {
                    holdings.set(symbol, {
                        quantity: quantityAfter,
                        totalCost: holding.totalCost,
                        estimated: true,
                        lastSystemAdjustment: quantityBefore !== undefined && predecessorId !== undefined
                            ? { quantityBefore, predecessorId } : undefined,
                    });
                }
            } else if (!holdings.has(symbol) && openingPrice) {
                holdings.set(symbol, { quantity: quantityAfter, totalCost: quantityAfter * openingPrice, estimated: true });
            } else {
                holdings.set(symbol, null);
            }
            continue;
        }

        const { quantityBefore, quantityAfter } = change;
        if (change.kind === 'buy' && change.priorQuantityMissing && holdings.has(symbol)) {
            holdings.set(symbol, null);
            continue;
        }
        const basis = quantityBefore === 0 ? { totalCost: 0, estimated: false } : holding;
        if (!basis || (quantityBefore !== 0 && holding && !quantitiesMatch(holding.quantity, quantityBefore))) {
            holdings.set(symbol, null);
            continue;
        }

        let { totalCost, estimated } = basis;
        if (change.kind === 'buy') {
            totalCost += (quantityAfter - quantityBefore) * change.price;
            estimated ||= change.estimated;
        } else if (change.kind === 'sell') {
            totalCost *= quantityAfter / quantityBefore;
        }
        estimated ||= change.orderEstimated === true;

        holdings.set(symbol, {
            quantity: quantityAfter,
            totalCost,
            estimated,
            lastSystemAdjustment: change.kind === 'unchanged' ? holding?.lastSystemAdjustment : undefined,
        });
    }

    const costs = new Map<string, UnitCost>();
    for (const [symbol, holding] of holdings) {
        if (!holding) continue;
        const { quantity, totalCost, estimated } = holding;
        const price = totalCost / quantity;
        if (Number.isFinite(price) && price > 0) costs.set(symbol, { price, estimated });
    }
    return costs;
}

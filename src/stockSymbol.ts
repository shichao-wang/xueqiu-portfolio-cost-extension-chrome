export function normalizeStockSymbol(symbol: string): string {
    const normalized = symbol.trim().toUpperCase();
    const hongKongCode = normalized.match(/^(?:HK)?(\d{1,5})$/)?.[1];
    return hongKongCode ? ('00000' + hongKongCode).slice(-5) : normalized;
}

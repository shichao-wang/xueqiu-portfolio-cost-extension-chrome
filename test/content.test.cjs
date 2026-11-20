const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');
const { runInNewContext } = require('node:vm');

const bundle = readFileSync(join(__dirname, '../dist/content.js'), 'utf8');
const background = readFileSync(join(__dirname, '../dist/background.js'), 'utf8');
const manifest = JSON.parse(readFileSync(join(__dirname, '../dist/manifest.json'), 'utf8'));

function rebalance(id, before, after, price, overrides = {}) {
    return {
        status: 'success',
        category: 'user_rebalancing',
        rebalancing_histories: [{
            id,
            stock_symbol: 'SH600000',
            created_at: id,
            updated_at: id,
            prev_weight_adjusted: before,
            target_weight: after,
            prev_volume: before,
            volume: after,
            price,
            net_value: after * price,
        }],
        ...overrides,
    };
}

function element(tagName) {
    const attributes = new Map();
    return {
        tagName,
        children: [],
        append(...children) {
            for (const child of children) child.parent = this;
            this.children.push(...children);
        },
        get isConnected() { return this.tagName === 'body' || this.parent?.isConnected === true; },
        remove() {
            if (!this.parent) return;
            this.parent.children = this.parent.children.filter(child => child !== this);
            this.parent = undefined;
        },
        replaceChildren(...children) { this.children = children; },
        setAttribute(name, value) { attributes.set(name, value); },
        getAttribute(name) { return attributes.get(name) ?? null; },
        removeAttribute(name) { attributes.delete(name); },
        addEventListener(event, callback) { this['on' + event] = callback; },
        click() { this.onclick?.(); },
        closest() { return null; },
        attachShadow() { return this.shadowRoot = element('shadow'); },
    };
}

async function renderPanel(pages, {
    quote = 'SH600000 20.00',
    weight = '19.68%',
    stockHref,
    stockSymbol,
    holdings = [{ stock: 'Test stock', quote, weight, stockHref, stockSymbol }],
    renderHoldingsLate = false,
    stringPageNumbers = false,
    expectLoading = false,
    expectedRequests = pages.map((_, index) => index + 1),
    expectedError,
    pageTotals,
    transientFailurePage,
    htmlResponsePage,
    readyState = 'loading',
    href = 'https://xueqiu.com/P/ZH123',
} = {}) {
    const positions = holdings.map(({ stock, quote, weight, stockHref, stockSymbol, stockAncestor = true, hidden = false }) => {
        const name = { textContent: stock };
        const price = quote === null ? null : { textContent: quote };
        const weightNode = { textContent: weight };
        const link = {
            href: stockHref,
            querySelector: inner => inner === '.stock-weight' ? weightNode : null,
            getAttribute(attribute) { return attribute === 'href' ? this.href : null; },
        };
        return {
            hidden,
            getAttribute: attribute => attribute === 'data-symbol' ? stockSymbol : null,
            querySelector: selector => ({ 'div .name': name, 'div .price': price })[selector] ?? null,
            closest(selector) {
                const selectors = selector.split(', ');
                if (selectors.includes('span.stock-name') && !this.hidden) return this;
                return selectors.includes('.stock') && stockAncestor ? link : null;
            },
            matches(selector) { return !this.hidden && selector === 'span.stock-name'; },
            style: {},
        };
    });
    let pagePositions = renderHoldingsLate ? [] : positions;
    let notifyMutation;
    let observedAttributes;
    const body = element('body');
    const window = {
        location: new URL(href),
    };
    const requestedPages = [];
    const errors = [];
    let waitedSinceRequest = 0;
    const setTestTimeout = (callback, delay) => {
        queueMicrotask(() => {
            waitedSinceRequest += delay;
            callback();
        });
    };
    const fetchPage = async (url, { credentials }) => {
        const request = new URL(url);
        assert.equal(request.origin, 'https://www.xueqiu.com');
        assert.equal(request.pathname, '/cubes/rebalancing/history.json');
        assert.equal(request.searchParams.get('count'), '50');
        assert.equal(request.searchParams.get('cube_symbol'), window.location.pathname.split('/')[2]);
        assert.equal(credentials, window.location.hostname === 'www.xueqiu.com' ? 'same-origin' : 'include');
        const page = Number(request.searchParams.get('page'));
        if (expectLoading && page === 1) {
            const panel = body.children[0]?.shadowRoot.children.find(child => child.tagName === 'details');
            const table = panel?.children[1].children[0];
            assert.equal(table?.getAttribute('aria-busy'), 'true');
            assert.equal(table.children[1].children[0].children[2].textContent, '加载中');
        }
        assert.equal(waitedSinceRequest, requestedPages.length ? 4000 : 0);
        waitedSinceRequest = 0;
        requestedPages.push(page);
        if (page === transientFailurePage && requestedPages.indexOf(page) === requestedPages.length - 1) {
            return { ok: false, status: 503 };
        }
        if (page === htmlResponsePage) {
            return new Response('<html></html>', { headers: { 'Content-Type': 'text/html' } });
        }
        const list = pages[page - 1];
        if (!list) return { ok: false, status: 503 };
        return { ok: true, headers: new Headers({ 'Content-Type': 'application/json' }), json: async () => ({
            list,
            page: stringPageNumbers ? String(page) : page,
            maxPage: stringPageNumbers ? String(pages.length) : pages.length,
            totalCount: pageTotals?.[page - 1],
        }) };
    };
    const listeners = [];
    const sender = { url: href, id: 'test-extension' };
    runInNewContext(background, {
        chrome: {
            runtime: {
                id: sender.id,
                onInstalled: { addListener() {} },
                onMessage: { addListener: callback => listeners.push(callback) },
            },
            tabs: { onUpdated: { addListener() {} } },
        },
        URL,
        setTimeout: setTestTimeout,
        fetch: fetchPage,
    });
    runInNewContext(bundle, {
        window,
        URL,
        setTimeout: setTestTimeout,
        Element: Object,
        MutationObserver: class {
            constructor(callback) { notifyMutation = callback; }
            observe(target, options) {
                assert.equal(target, body);
                observedAttributes = options.attributeFilter;
            }
        },
        chrome: {
            runtime: {
                sendMessage: message => new Promise(resolve => {
                    for (const listener of listeners) {
                        if (listener(message, sender, resolve) === true) return;
                    }
                    resolve(undefined);
                }),
            },
        },
        document: {
            readyState,
            createElement: element,
            getElementById: id => body.children.find(child => child.id === id),
            body,
            querySelectorAll: selector => pagePositions.filter(position => position.matches(selector)),
        },
        console: { log() {}, error(...args) { errors.push(args.join(' ')); } },
        fetch: fetchPage,
    });
    if (expectLoading) assert.equal(requestedPages.length, 1);
    await new Promise(setImmediate);
    if (renderHoldingsLate) {
        assert.equal(body.children.length, 0);
        pagePositions = positions;
        notifyMutation([{ target: body, addedNodes: positions, removedNodes: [] }]);
    }
    assert.deepEqual(requestedPages, expectedRequests);
    if (expectedError) assert.match(errors.join('\n'), expectedError);
    for (const [i, position] of positions.entries()) {
        assert.equal(position.querySelector('div .name').textContent, holdings[i].stock);
        assert.equal(position.querySelector('div .price')?.textContent ?? null, holdings[i].quote);
        assert.equal(
            position.closest('.stock')?.querySelector('.stock-weight')?.textContent,
            holdings[i].stockAncestor === false ? undefined : holdings[i].weight,
        );
        assert.deepEqual(position.style, {});
    }
    assert.equal(body.children.length, 1);
    const panel = body.children[0].shadowRoot.children.find(child => child.tagName === 'details');
    assert.equal(panel.open, true);
    assert.equal(panel.children[0].tagName, 'summary');
    assert.equal(panel.children[0].textContent, '持仓成本');
    const table = panel.children[1].children[0];
    const [head, rows] = table.children;
    return {
        headers: head.children[0].children,
        rows,
        panel,
        updateQuote(index, newQuote) {
            positions[index].querySelector('div .price').textContent = newQuote;
            notifyMutation([{ target: positions[index], addedNodes: [], removedNodes: [] }]);
        },
        updateLink(index, href) {
            const position = positions[index];
            position.closest('.stock').href = href;
            if (observedAttributes?.includes('href')) {
                notifyMutation([{ target: position, addedNodes: [], removedNodes: [] }]);
            }
        },
        revealHolding(index) {
            const position = positions[index];
            position.hidden = false;
            if (observedAttributes?.includes('class')) {
                notifyMutation([{ target: position, attributeName: 'class', addedNodes: [], removedNodes: [] }]);
            }
        },
        detachPanel() {
            const host = body.children[0];
            host.remove();
            notifyMutation([{ target: body, addedNodes: [], removedNodes: [host] }]);
            return body.children[0] === host;
        },
    };
}

async function displayCost(pages, options) {
    const { rows } = await renderPanel(pages, options);
    const [stock, proportion, cost, change] = rows.children[0].children;
    return { stock: stock.textContent, weight: proportion.textContent, cost: cost.textContent, change: change.textContent };
}

test('sorts all four columns, reverses direction and keeps missing numbers last', async () => {
    const holdings = [
        { stock: 'Zulu', quote: 'ZZZ 2.00', weight: '9.00%' },
        { stock: 'Alpha', quote: 'AAA 12.30', weight: '12.00%' },
        { stock: 'Mike', quote: 'MMM 8.00', weight: '3.00%' },
        { stock: 'Beta', quote: 'BBB --', weight: '' },
    ];
    const records = [
        rebalance(1, 0, 100, 1),
        rebalance(2, 0, 100, 12),
        rebalance(3, 0, 100, 2, { category: 'sys_rebalancing' }),
    ];
    records.forEach((record, i) => {
        record.rebalancing_histories[0].stock_symbol = holdings[i].quote.split(' ')[0];
    });
    const { headers, rows } = await renderPanel([records], { holdings });
    const names = () => rows.children.map(row => row.children[0].textContent);

    assert.deepEqual(names(), ['Zulu', 'Alpha', 'Mike', 'Beta']);
    for (const [column, firstDirection, firstOrder, secondOrder] of [
        [0, 'ascending', ['Alpha', 'Beta', 'Mike', 'Zulu'], ['Zulu', 'Mike', 'Beta', 'Alpha']],
        [1, 'descending', ['Alpha', 'Zulu', 'Mike', 'Beta'], ['Mike', 'Zulu', 'Alpha', 'Beta']],
        [2, 'descending', ['Alpha', 'Mike', 'Zulu', 'Beta'], ['Zulu', 'Mike', 'Alpha', 'Beta']],
        [3, 'descending', ['Mike', 'Zulu', 'Alpha', 'Beta'], ['Alpha', 'Zulu', 'Mike', 'Beta']],
    ]) {
        const header = headers[column];
        const button = header.children[0];
        button.click();
        assert.deepEqual(names(), firstOrder);
        assert.equal(header.getAttribute('aria-sort'), firstDirection);
        assert.equal(headers.filter(cell => cell.getAttribute('aria-sort')).length, 1);
        button.click();
        assert.deepEqual(names(), secondOrder);
    }
});

test('renders late holdings and updates returns while retaining the current sort and collapse state', async () => {
    const holdings = [
        { stock: 'First', quote: 'SH600000 10.00元', weight: '9.00%' },
        { stock: 'Second', quote: 'SH600001 15.00元', weight: '12.00%' },
    ];
    const second = rebalance(2, 0, 100, 10);
    second.rebalancing_histories[0].stock_symbol = 'SH600001';
    const { headers, rows, panel, updateQuote } = await renderPanel(
        [[rebalance(1, 0, 100, 10), second]],
        { holdings, renderHoldingsLate: true },
    );
    const returnHeader = headers[3];
    returnHeader.children[0].click();
    assert.equal(rows.children[0].children[0].textContent, 'Second');
    panel.open = false;

    updateQuote(0, 'SH600000 20.00元');
    assert.equal(rows.children[0].children[0].textContent, 'Second');
    assert.equal(panel.open, false);
    panel.open = true;
    panel.ontoggle();
    assert.equal(rows.children[0].children[0].textContent, 'First');
    assert.equal(rows.children[0].children[3].textContent, costLabel('10.00', 100).change);
    assert.equal(returnHeader.getAttribute('aria-sort'), 'descending');
});

test('includes holdings when the page supplies their stock link through an attribute update', async () => {
    const second = rebalance(2, 0, 100, 10);
    second.rebalancing_histories[0].stock_symbol = 'SH600001';
    const { rows, updateLink } = await renderPanel([[rebalance(1, 0, 100, 10), second]], {
        holdings: [
            { stock: 'First', quote: 'SH600000 20.00', weight: '9%' },
            { stock: 'Second', quote: null, weight: '3%' },
        ],
    });
    assert.equal(rows.children.length, 1);
    updateLink(1, '/S/SH600001');
    assert.deepEqual(rows.children.map(row => row.children[0].textContent), ['First', 'Second']);
});

test('includes a holding once its page element gains the holding class', async () => {
    const second = rebalance(2, 0, 100, 10);
    second.rebalancing_histories[0].stock_symbol = 'SH600001';
    const { rows, revealHolding } = await renderPanel([[rebalance(1, 0, 100, 10), second]], {
        holdings: [
            { stock: 'First', quote: 'SH600000 20.00' },
            { stock: 'Second', quote: 'SH600001 20.00', hidden: true },
        ],
    });
    assert.equal(rows.children.length, 1);
    revealHolding(1);
    assert.deepEqual(rows.children.map(row => row.children[0].textContent), ['First', 'Second']);
});

test('shows the loading panel before history resolves and updates a holding without a stock ancestor', async () => {
    const { rows, updateQuote } = await renderPanel([[rebalance(1, 0, 100, 10)]], {
        holdings: [{ stock: 'First', quote: 'SH600000 20.00', stockAncestor: false }],
        expectLoading: true,
    });
    updateQuote(0, 'SH600000 25.00');
    assert.equal(rows.children[0].children[3].textContent, costLabel('10.00', 150).change);
});

test('reattaches the float when the page removes it without changing the holdings', async () => {
    const { panel, detachPanel } = await renderPanel([[rebalance(1, 0, 100, 10)]]);
    panel.open = false;
    assert.equal(detachPanel(), true);
    assert.equal(panel.open, false);
});

for (const host of ['xueqiu.com', 'www.xueqiu.com']) {
    test(`shows the cost and return for a Xueqiu quote on ${host}`, async () => {
        const opening = rebalance(1, null, 100, 3.6);
        opening.rebalancing_histories[0].stock_symbol = '00506';

        assert.deepEqual(await displayCost([[opening]], {
            href: `https://${host}/P/ZH3436434`,
            quote: '00506 3.96(-0.75%)',
            stockHref: '/S/00506',
        }), costLabel('3.60', 10));
        assert.ok(manifest.content_scripts.some(script =>
            script.js.includes('content.js') && script.matches.includes(`https://${host}/P/ZH*`)
        ));
        if (host === 'xueqiu.com') assert.ok(manifest.host_permissions.includes('https://www.xueqiu.com/*'));
    });
}

function costLabel(cost, percentage) {
    const formatted = new Intl.NumberFormat(undefined, {
        style: 'percent',
        signDisplay: 'always',
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
    }).format(percentage / 100);
    return { stock: 'Test stock', weight: '19.68%', cost, change: formatted };
}

test('replays all pages and weights an addition by its trade quantity', async () => {
    const current = rebalance(2, 100, 150, 20);
    const opening = rebalance(1, null, 100, 10);
    assert.deepEqual(await displayCost([[current], [current, opening]]), costLabel('13.33', 50));
});

test('uses the latest version of a repeated history detail', async () => {
    const original = rebalance(10, 0, 100, 10, { id: 1 });
    const corrected = rebalance(10, 0, 100, 20, { id: 2 });
    corrected.rebalancing_histories[0].updated_at += 1;
    assert.deepEqual(await displayCost([[corrected], [original]]), costLabel('20.00', 0));
});

test('prefers a known detail revision to a copy with only a parent update time', async () => {
    const corrected = rebalance(10, 0, 100, 20, { id: 1 });
    corrected.rebalancing_histories[0].updated_at = 20;
    const old = rebalance(10, 0, 100, 10, { id: 2, updated_at: 30 });
    delete old.rebalancing_histories[0].updated_at;
    assert.deepEqual(await displayCost([[corrected], [old]]), costLabel('20.00', 0));
});

test('keeps a corrected opening before trades that occurred after it', async () => {
    const opening = rebalance(10, 0, 100, 20);
    opening.rebalancing_histories[0].created_at = 10;
    opening.rebalancing_histories[0].updated_at = 12;
    const laterBuy = rebalance(11, 100, 150, 30);
    assert.deepEqual(await displayCost([[opening, laterBuy]], { quote: 'SH600000 35.00' }), costLabel('23.33', 50));
});

test('invalidates conflicting execution times regardless of page order', async () => {
    const firstVersion = rebalance(1, 100, 150, 10);
    const secondVersion = rebalance(1, 100, 150, 10);
    firstVersion.rebalancing_histories[0].created_at = 10;
    secondVersion.rebalancing_histories[0].created_at = 30;
    firstVersion.rebalancing_histories[0].updated_at = 40;
    secondVersion.rebalancing_histories[0].updated_at = 40;
    const opening = rebalance(2, 0, 100, 20);
    opening.rebalancing_histories[0].created_at = 20;
    opening.rebalancing_histories[0].updated_at = 20;
    for (const versions of [[firstVersion, secondVersion], [secondVersion, firstVersion]]) {
        assert.equal((await displayCost([[...versions, opening]])).cost, '成本不可用');
    }
});

test('uses the exact execution time from an otherwise matching detail revision', async () => {
    const exact = rebalance(1, 0, 100, 10, { created_at: 10 });
    exact.rebalancing_histories[0].created_at = 10;
    exact.rebalancing_histories[0].updated_at = 30;
    const bounded = rebalance(1, 0, 100, 10, { created_at: 10 });
    delete bounded.rebalancing_histories[0].created_at;
    bounded.rebalancing_histories[0].updated_at = 30;
    const laterBuy = rebalance(2, 100, 150, 20);
    laterBuy.rebalancing_histories[0].created_at = 20;
    laterBuy.rebalancing_histories[0].updated_at = 20;
    assert.deepEqual(await displayCost([[bounded, exact, laterBuy]]), costLabel('13.33', 50));
    bounded.rebalancing_histories[0].updated_at = 40;
    assert.deepEqual(await displayCost([[exact, laterBuy, bounded]]), costLabel('13.33', 50));
});

test('handles three conflicting detail copies consistently regardless of response order', async () => {
    const early = rebalance(1, 0, 100, 10);
    early.rebalancing_histories[0].created_at = 10;
    early.rebalancing_histories[0].updated_at = 30;
    const late = rebalance(1, 0, 100, 10);
    late.rebalancing_histories[0].created_at = 30;
    late.rebalancing_histories[0].updated_at = 30;
    const bounded = rebalance(1, 0, 100, 10, { created_at: 5 });
    delete bounded.rebalancing_histories[0].created_at;
    bounded.rebalancing_histories[0].updated_at = 40;
    const addition = rebalance(20, 100, 150, 20);
    for (const copies of [[early, late, bounded], [early, bounded, late], [late, bounded, early]]) {
        assert.equal((await displayCost([[...copies, addition]])).cost, '成本不可用');
    }
});

test('uses detail revision order for an entirely legacy history', async () => {
    const opening = rebalance(10, 0, 100, 10, { created_at: 1, updated_at: 10 });
    delete opening.rebalancing_histories[0].created_at;
    for (const parent of [{ created_at: 5, updated_at: 20 }, { updated_at: 5 }, { created_at: 10, updated_at: 5 }]) {
        const addition = rebalance(20, 100, 150, 20, parent);
        delete addition.rebalancing_histories[0].created_at;
        assert.deepEqual(await displayCost([[addition, opening]]), costLabel('~13.33', 50));
    }
});

test('keeps proven execution order for legacy details with disjoint windows', async () => {
    const opening = rebalance(100, 0, 100, 10, { created_at: 1, updated_at: 10 });
    const addition = rebalance(30, 100, 150, 20, { created_at: 20, updated_at: 30 });
    for (const record of [opening, addition]) delete record.rebalancing_histories[0].created_at;
    assert.deepEqual(await displayCost([[addition, opening]]), costLabel('13.33', 50));
});

test('uses a disputed detail revision time to invalidate a legacy holding', async () => {
    const opening = rebalance(80, 0, 100, 10, { updated_at: 30 });
    const first = rebalance(100, 100, 150, 20, { updated_at: 10 });
    const alternate = rebalance(100, 100, 150, 30, { updated_at: 20 });
    for (const record of [opening, first, alternate]) delete record.rebalancing_histories[0].created_at;
    assert.equal((await displayCost([[first, alternate, opening]])).cost, '成本不可用');
});

test('keeps a disputed legacy purchase after an opening with an earlier execution window', async () => {
    const opening = rebalance(1, 0, 100, 10, { created_at: 10, updated_at: 20 });
    opening.rebalancing_histories[0].updated_at = 100;
    const first = rebalance(2, 100, 150, 20, { created_at: 40, updated_at: 50 });
    const alternate = rebalance(2, 100, 150, 30, { created_at: 40, updated_at: 60 });
    for (const record of [first, alternate]) record.rebalancing_histories[0].updated_at = 70;
    for (const record of [opening, first, alternate]) delete record.rebalancing_histories[0].created_at;
    assert.equal((await displayCost([[first, alternate, opening]])).cost, '成本不可用');
});

test('does not reset a disputed cost from an opening with an overlapping execution window', async () => {
    const opening = rebalance(40, 0, 100, 10, { created_at: 10 });
    delete opening.rebalancing_histories[0].created_at;
    const first = rebalance(20, 100, 150, 20);
    const alternate = rebalance(20, 100, 150, 30);
    first.rebalancing_histories[0].updated_at = 30;
    Object.assign(alternate.rebalancing_histories[0], { created_at: 25, updated_at: 30 });
    assert.equal((await displayCost([[opening, first, alternate]])).cost, '成本不可用');
});

test('uses legacy revision order for overlapping trades after an exact opening', async () => {
    const opening = rebalance(10, 0, 100, 10);
    const purchase = rebalance(40, 100, 150, 20, { created_at: 20, updated_at: 40 });
    const sale = rebalance(50, 150, 120, 20, { created_at: 30, updated_at: 50 });
    for (const record of [purchase, sale]) delete record.rebalancing_histories[0].created_at;
    assert.deepEqual(await displayCost([[sale, opening, purchase]]), costLabel('~13.33', 50));
});

test('marks costs as estimated when round trips could have executed in another order', async () => {
    const opening = rebalance(1, 0, 100, 10);
    const roundTrips = [
        rebalance(10, 100, 200, 20, { created_at: 2 }),
        rebalance(11, 200, 100, 20, { created_at: 2 }),
        rebalance(12, 100, 200, 30, { created_at: 2 }),
        rebalance(13, 200, 100, 30, { created_at: 2 }),
    ];
    for (const timestamp of [undefined, 5]) {
        for (const record of roundTrips) record.rebalancing_histories[0].created_at = timestamp;
        const result = await displayCost([[...roundTrips, opening]], { quote: 'SH600000 22.50' });
        assert.deepEqual(result, costLabel('~22.50', 0));
    }
});

test('reports unavailable cost when a missing execution time leaves trade order ambiguous', async () => {
    for (const updated_at of [undefined, 30]) {
        const opening = rebalance(10, 0, 100, 10, { created_at: 10, updated_at });
        delete opening.rebalancing_histories[0].created_at;
        opening.rebalancing_histories[0].updated_at = 30;
        const laterBuy = rebalance(20, 100, 150, 20);
        assert.equal((await displayCost([[opening, laterBuy]])).cost, '成本不可用');
    }
});

test('does not sort an ambiguous execution interval before an exact trade at its upper bound', async () => {
    const bounded = rebalance(1, null, 200, 5, { category: 'sys_rebalancing', created_at: 10 });
    delete bounded.rebalancing_histories[0].created_at;
    bounded.rebalancing_histories[0].updated_at = 30;
    const exact = rebalance(2, 0, 100, 10);
    exact.rebalancing_histories[0].created_at = 30;
    exact.rebalancing_histories[0].updated_at = 30;
    assert.equal((await displayCost([[bounded, exact]])).cost, '成本不可用');
});

test('uses a known execution time when parent request and update times are equal', async () => {
    const opening = rebalance(1, 0, 100, 10);
    const addition = rebalance(2, 100, 150, 20, { created_at: 2, updated_at: 2 });
    delete addition.rebalancing_histories[0].created_at;
    assert.deepEqual(await displayCost([[addition, opening]]), costLabel('13.33', 50));
});

test('does not use a request-only timestamp to order a system event', async () => {
    const request = rebalance(1, null, 200, 5, { category: 'sys_rebalancing', created_at: 1 });
    delete request.rebalancing_histories[0].created_at;
    delete request.rebalancing_histories[0].updated_at;
    const opening = rebalance(2, 0, 100, 10);
    assert.equal((await displayCost([[request, opening]])).cost, '成本不可用');
});

test('does not move a detail after its own last update when the parent is revised', async () => {
    const opening = rebalance(10, 0, 100, 10, { updated_at: 30 });
    delete opening.rebalancing_histories[0].created_at;
    const laterBuy = rebalance(20, 100, 150, 20);
    assert.deepEqual(await displayCost([[opening, laterBuy]]), costLabel('13.33', 50));
});

test('does not reset an existing holding when a user rebalance omits the prior quantity', async () => {
    const later = rebalance(2, null, 150, 20);
    assert.equal((await displayCost([[later, rebalance(1, null, 100, 10)]])).cost, '成本不可用');
});

test('reads string page numbers and tolerates fractional quantity rounding', async () => {
    const current = rebalance(2, 0.30000000000000004, 0.4, 20);
    const opening = rebalance(1, null, 0.3, 10);
    assert.deepEqual(await displayCost([[current], [opening]], { stringPageNumbers: true }), costLabel('12.50', 60));
});

test('a reduction keeps the unit cost and an unfilled rebalance has no effect', async () => {
    const records = [
        rebalance(3, 70, 160, 50, { status: 'pending' }),
        rebalance(2, 100, 70, 30),
        rebalance(1, null, 100, 10),
    ];
    assert.deepEqual(await displayCost([records]), costLabel('10.00', 100));
});

test('starts a new cost basis after a full sale', async () => {
    const records = [
        rebalance(3, 0, 40, 20),
        rebalance(2, 100, 0, 15),
        rebalance(1, 0, 100, 10),
    ];
    assert.deepEqual(await displayCost([records]), costLabel('20.00', 0));
});

test('retains the cost basis when a system rebalance leaves quantity unchanged', async () => {
    const records = [
        rebalance(2, 100, 100, 30, { category: 'sys_rebalancing' }),
        rebalance(1, null, 100, 10),
    ];
    assert.deepEqual(await displayCost([records]), costLabel('10.00', 100));
});

test('keeps the basis through a system split and subsequent purchase', async () => {
    const records = [
        rebalance(3, 200, 220, 15),
        rebalance(2, 100, 200, 10, { category: 'sys_rebalancing' }),
        rebalance(1, null, 100, 10),
    ];
    assert.deepEqual(await displayCost([records]), costLabel('~5.91', 238.46));
});

test('uses the reported quantity through repeated dividend reinvestment snapshots', async () => {
    // The quantities and reinvestment price come from the SZ003011 system rebalance on 2025-09-24.
    const system = { category: 'sys_rebalancing', prev_bebalancing_id: 204423804 };
    const records = [
        rebalance(4, 0.0079268, 0.00804594, 19.96, system),
        rebalance(3, 0.00804594, 0.00804594, 19.96),
        rebalance(2, 0.0079268, 0.00804594, 19.96, system),
        rebalance(1, null, 0.0079268, 20.5),
    ];
    assert.deepEqual(await displayCost([records]), costLabel('~20.20', -0.97));
});

test('keeps total cost when the system reduces the quantity of an open holding', async () => {
    const records = [
        rebalance(2, 100, 50, 25, { category: 'sys_rebalancing' }),
        rebalance(1, null, 100, 10),
    ];
    assert.deepEqual(await displayCost([records]), costLabel('~20.00', 0));
});

test('estimates a new position opened by the system from its recorded price', async () => {
    const opening = rebalance(1, null, 100, 10, { category: 'sys_rebalancing' });
    assert.deepEqual(await displayCost([[opening]]), costLabel('~10.00', 100));
});

test('retains the established basis when a system snapshot omits the prior quantity as null', async () => {
    const records = [
        rebalance(2, null, 200, 7, { category: 'sys_rebalancing' }),
        rebalance(1, 0, 100, 10),
    ];
    assert.deepEqual(await displayCost([records]), costLabel('~5.00', 300));
});

test('does not substitute a system quote for an existing holding with a lost cost basis', async () => {
    const records = [
        rebalance(3, null, 150, 30, { category: 'sys_rebalancing' }),
        rebalance(2, 120, 150, 20),
        rebalance(1, 0, 100, 10),
    ];
    assert.equal((await displayCost([records])).cost, '成本不可用');
});

test('starts a new calculated basis after clearing a position with an estimate', async () => {
    const records = [
        rebalance(4, 0, 40, 20),
        rebalance(3, 200, 0, 15),
        rebalance(2, 100, 200, 10, { category: 'sys_rebalancing' }),
        rebalance(1, 0, 100, 10),
    ];
    assert.deepEqual(await displayCost([records]), costLabel('20.00', 0));
});

test('reports unavailable cost for a gap in the current holding history', async () => {
    const records = [rebalance(2, 120, 150, 20), rebalance(1, 0, 100, 10)];
    assert.deepEqual(await displayCost([records]), {
        stock: 'Test stock', weight: '19.68%', cost: '成本不可用', change: '—',
    });
});

test('reports a history gap when a system adjustment starts from an unexplained holding', async () => {
    const records = [
        rebalance(2, 150, 300, 8, { category: 'sys_rebalancing' }),
        rebalance(1, 0, 100, 10),
    ];
    assert.equal((await displayCost([records])).cost, '成本不可用');
});

test('does not treat a matching system end quantity as proof that the adjustment was a duplicate', async () => {
    const records = [
        rebalance(2, 50, 100, 5, { category: 'sys_rebalancing' }),
        rebalance(1, 0, 100, 10),
    ];
    assert.equal((await displayCost([records])).cost, '成本不可用');
});

test('requires a shared predecessor to recognize a repeated system adjustment', async () => {
    const records = [
        rebalance(3, 100, 200, 6, { category: 'sys_rebalancing', prev_bebalancing_id: 102 }),
        rebalance(2, 100, 200, 5, { category: 'sys_rebalancing', prev_bebalancing_id: 101 }),
        rebalance(1, 0, 100, 10),
    ];
    assert.equal((await displayCost([records])).cost, '成本不可用');
});

test('keeps known costs when another security has an unorderable record', async () => {
    const invalid = rebalance(2, null, 20, 4);
    const detail = invalid.rebalancing_histories[0];
    detail.stock_symbol = 'SH600001';
    delete detail.id;
    delete detail.created_at;
    delete detail.updated_at;
    const { rows } = await renderPanel([[invalid, rebalance(1, 0, 100, 10)]], {
        holdings: [
            { stock: 'First', quote: 'SH600000 20.00', weight: '9%' },
            { stock: 'Second', quote: 'SH600001 4.00', weight: '3%' },
        ],
    });
    assert.deepEqual(rows.children.map(row => row.children[2].textContent), ['10.00', '成本不可用']);
});

test('uses a dated record when another page repeats the detail without a timestamp', async () => {
    const opening = rebalance(1, 0, 100, 10);
    const undatedCopy = rebalance(1, 0, 100, 10);
    delete undatedCopy.rebalancing_histories[0].created_at;
    delete undatedCopy.rebalancing_histories[0].updated_at;
    assert.deepEqual(await displayCost([[opening], [undatedCopy]]), costLabel('10.00', 100));
    undatedCopy.rebalancing_histories[0].price = 20;
    assert.equal((await displayCost([[opening], [undatedCopy]])).cost, '成本不可用');
});

test('does not ignore a newer malformed revision that matches a superseded trade', async () => {
    const original = rebalance(1, 0, 100, 10);
    const correction = rebalance(1, 0, 100, 20);
    correction.rebalancing_histories[0].updated_at = 20;
    const malformed = rebalance(1, 0, 100, 10);
    Object.assign(malformed.rebalancing_histories[0], { created_at: 40, updated_at: 30 });
    assert.equal((await displayCost([[original, correction, malformed]])).cost, '成本不可用');
    malformed.rebalancing_histories[0].stock_symbol = 'SH600001';
    assert.equal((await displayCost([[original, correction, malformed]])).cost, '成本不可用');
});

test('does not treat a share count as a ticker-prefixed quote', async () => {
    const opening = rebalance(1, 0, 100, 10);
    const result = await displayCost([[opening]], { quote: 'SH600000 20 股', stockHref: '/S/SH600000' });
    assert.equal(result.cost, '10.00');
    assert.equal(result.change, '—');
});

test('restores a known cost after an unidentified older record, a full sale and a new purchase', async () => {
    const invalid = rebalance(1, 0, 100, 10);
    delete invalid.rebalancing_histories[0].id;
    const records = [rebalance(3, 0, 50, 20), rebalance(2, 100, 0, 15), invalid];
    assert.deepEqual(await displayCost([records]), costLabel('20.00', 0));
});

test('uses an absolute holding link to display cost and weight when the quote is absent', async () => {
    const opening = rebalance(1, 0, 100, 10);
    assert.deepEqual(await displayCost([[opening]], {
        quote: null, stockHref: 'https://www.xueqiu.com/S/SH600000',
    }), {
        stock: 'Test stock', weight: '19.68%', cost: '10.00', change: '—',
    });
});

test('reads price-only quote text when the holding link supplies the symbol', async () => {
    const opening = rebalance(1, 0, 100, 10);
    for (const quote of ['20.00元', '20', '20.00 +0.50 +2.56%']) {
        assert.deepEqual(await displayCost([[opening]], {
            quote, stockHref: '/S/SH600000',
        }), costLabel('10.00', 100));
    }
});

test('does not identify an unlinked holding from a price-only quote', async () => {
    const other = rebalance(2, 0, 100, 10);
    other.rebalancing_histories[0].stock_symbol = '00020';
    for (const quote of ['20 港元', '20 2.56 %']) {
        const { rows } = await renderPanel([[rebalance(1, 0, 100, 10), other]], {
            holdings: [
                { stock: 'First', quote: 'SH600000 10.00' },
                { stock: 'Unidentified', quote },
            ],
        });
        assert.deepEqual(rows.children.map(row => row.children[0].textContent), ['First']);
    }
});

test('does not use a percentage token as a current price', async () => {
    const opening = rebalance(1, 0, 100, 10);
    opening.rebalancing_histories[0].stock_symbol = '00020';
    assert.deepEqual(await displayCost([[opening]], {
        quote: '20 2.56 %', stockHref: '/S/00020',
    }), { stock: 'Test stock', weight: '19.68%', cost: '10.00', change: '—' });
    assert.deepEqual(await displayCost([[opening]], {
        quote: '00020 2.56 ％', stockHref: '/S/00020',
    }), { stock: 'Test stock', weight: '19.68%', cost: '10.00', change: '—' });
});

test('identifies an unlinked holding whose ticker contains an underscore', async () => {
    const opening = rebalance(1, 0, 100, 400);
    opening.rebalancing_histories[0].stock_symbol = 'BRK_B';
    assert.deepEqual(await displayCost([[opening]], { quote: 'BRK_B 481.00' }), costLabel('400.00', 20.25));
});

test('withholds cost when an update-only system event could precede a known execution', async () => {
    const uncertain = rebalance(3, null, 200, 7, { category: 'sys_rebalancing' });
    delete uncertain.rebalancing_histories[0].created_at;
    const exact = rebalance(2, null, 125, 7, { category: 'sys_rebalancing' });
    assert.equal((await displayCost([[uncertain, exact, rebalance(1, 0, 100, 10)]])).cost, '成本不可用');
});

test('withholds cost for a system detail that claims an execution after its last update', async () => {
    const system = rebalance(3, null, 200, 8, { category: 'sys_rebalancing' });
    system.rebalancing_histories[0].updated_at = 1;
    const records = [system, rebalance(2, 100, 150, 20), rebalance(1, 0, 100, 10)];
    assert.equal((await displayCost([records])).cost, '成本不可用');
});

test('matches Hong Kong ticker aliases across the holding link, quote, and trade history', async () => {
    const opening = rebalance(1, 0, 100, 60);
    opening.rebalancing_histories[0].stock_symbol = 'HK00005';
    assert.deepEqual(await displayCost([[opening]], {
        quote: '5 72.45(-0.10%)', stockHref: '/S/00005',
    }), costLabel('60.00', 20.75));
});

test('can identify a Hong Kong holding by its own data-symbol attribute', async () => {
    const opening = rebalance(1, 0, 100, 3.6);
    opening.rebalancing_histories[0].stock_symbol = '00506';
    assert.deepEqual(await displayCost([[opening]], {
        stockSymbol: '00506', quote: '00506 3.96(-0.75%)',
    }), costLabel('3.60', 10));
});

test('can identify a Hong Kong holding from a padded ticker and an actual price', async () => {
    const opening = rebalance(1, 0, 100, 3.6);
    opening.rebalancing_histories[0].stock_symbol = '00506';
    assert.deepEqual(await displayCost([[opening]], { quote: '00506 3.96(-0.75%)' }), costLabel('3.60', 10));
});

test('uses the current stock link ahead of a stale data-symbol attribute', async () => {
    const opening = rebalance(1, null, 100, 10);
    const other = rebalance(2, null, 100, 20);
    other.rebalancing_histories[0].stock_symbol = 'SH600001';
    assert.deepEqual(await displayCost([[other, opening]], {
        stockHref: '/S/SH600001', stockSymbol: 'SH600000', quote: 'SH600001 25.00',
    }), costLabel('20.00', 25));
});

test('does not use a stale price after the holding link changes to another stock', async () => {
    const opening = rebalance(1, 0, 100, 10);
    assert.deepEqual(await displayCost([[opening]], {
        quote: 'SH600009 20.00', stockHref: '/S/SH600000',
    }), { stock: 'Test stock', weight: '19.68%', cost: '10.00', change: '—' });
});

test('does not interpret a bare Hong Kong ticker as a price', async () => {
    const opening = rebalance(1, 0, 100, 60);
    opening.rebalancing_histories[0].stock_symbol = '00006';
    assert.deepEqual(await displayCost([[opening]], {
        quote: '00005', stockHref: '/S/00006',
    }), { stock: 'Test stock', weight: '19.68%', cost: '60.00', change: '—' });
    assert.deepEqual(await displayCost([[rebalance(1, 0, 100, 10)]], {
        quote: '00506', stockHref: '/S/SH600000',
    }), { stock: 'Test stock', weight: '19.68%', cost: '10.00', change: '—' });
    assert.deepEqual(await displayCost([[opening]], {
        quote: '5(-0.10%)', stockHref: '/S/00006',
    }), { stock: 'Test stock', weight: '19.68%', cost: '60.00', change: '—' });
});

test('reads a price with a currency suffix even when it equals the Hong Kong ticker shorthand', async () => {
    const opening = rebalance(1, 0, 100, 10);
    opening.rebalancing_histories[0].stock_symbol = '00020';
    assert.deepEqual(await displayCost([[opening]], {
        quote: '20 港元', stockHref: '/S/00020',
    }), costLabel('10.00', 100));
});

test('leaves a bare whole number ambiguous in a Hong Kong holding', async () => {
    const opening = rebalance(1, 0, 100, 50);
    opening.rebalancing_histories[0].stock_symbol = '00005';
    assert.deepEqual(await displayCost([[opening]], {
        quote: '100', stockHref: '/S/00005',
    }), { stock: 'Test stock', weight: '19.68%', cost: '50.00', change: '—' });
});

test('reads quotes with full-width punctuation or separate daily price changes', async () => {
    const opening = rebalance(1, 0, 100, 10);
    for (const quote of ['SH600000 20.00（+2.56%）', 'SH600000 20.00 +0.50 +2.56%', 'SH600000 20.00\n(+2.56%)']) {
        assert.deepEqual(await displayCost([[opening]], { quote }), costLabel('10.00', 100));
    }
});

test('displays a positive cost below one cent with enough precision to avoid rounding it to zero', async () => {
    const opening = rebalance(1, 0, 100, 0.004);
    assert.deepEqual(await displayCost([[opening]], { quote: 'SH600000 0.005' }), costLabel('0.0040', 25));
});

test('shows a flat return without a loss color when the computed cost rounds slightly above the quote', async () => {
    const opening = rebalance(1, 0, 3, 0.10);
    const { rows } = await renderPanel([[opening]], { quote: 'SH600000 0.10' });
    const result = rows.children[0].children[3];
    assert.equal(result.textContent, costLabel('0.10', 0).change);
    assert.equal(result.className, undefined);
});

test('does not show a partial cost when a later history page fails', async () => {
    assert.deepEqual(await displayCost([[rebalance(1, null, 100, 10)], null], {
        expectedRequests: [1, 2, 2],
    }), {
        stock: 'Test stock',
        weight: '19.68%',
        cost: '成本不可用',
        change: '—',
    });
});

test('loads the oldest opening across 1,131 records at 50 records per page', async () => {
    const records = Array.from({ length: 1131 }, (_, index) => ({ id: 1131 - index, status: 'failed' }));
    records[0] = { ...rebalance(1131, 100, 150, 20), id: 1131 };
    records[1130] = { ...rebalance(1, 0, 100, 10), id: 1 };
    const pages = [];
    for (let index = 0; index < records.length; index += 50) pages.push(records.slice(index, index + 50));
    assert.deepEqual(await displayCost(pages, { pageTotals: pages.map(() => 1131) }), costLabel('13.33', 50));
});

test('stops replay when the server returns HTML instead of history with HTTP 200', async () => {
    const opening = rebalance(1, 0, 100, 10);
    const result = await displayCost([[opening], [rebalance(2, 100, 150, 20)], [opening]], {
        htmlResponsePage: 2,
        expectedRequests: [1, 2],
        expectedError: /第 2 页返回 text\/html/,
    });
    assert.equal(result.cost, '成本不可用');
    assert.equal(result.change, '—');
});

test('recovers from one transient history page failure', async () => {
    const recent = rebalance(2, 100, 150, 20);
    const opening = rebalance(1, 0, 100, 10);
    assert.deepEqual(await displayCost([[recent], [opening]], {
        transientFailurePage: 2,
        expectedRequests: [1, 2, 2],
    }), costLabel('13.33', 50));
});

test('rejects a missing intermediate history page', async () => {
    const recent = rebalance(2, 100, 150, 20);
    const opening = rebalance(1, 0, 100, 10);
    const { rows } = await renderPanel([[recent], [], [opening]], { expectedRequests: [1, 2] });
    assert.equal(rows.children[0].children[2].textContent, '成本不可用');
});

test('rejects a history that changes record counts between pages', async () => {
    const recent = rebalance(2, 100, 150, 20);
    const opening = rebalance(1, 0, 100, 10);
    assert.equal((await displayCost([[recent], [opening]], { pageTotals: [3, 2] })).cost, '成本不可用');
});

test('displays the cost without a return when the quote is missing on an already loaded page', async () => {
    const opening = rebalance(1, null, 10, 12.5);
    opening.rebalancing_histories[0].stock_symbol = 'BRK.B';
    assert.deepEqual(await displayCost([[opening]], {
        quote: 'BRK.B --',
        weight: '',
        readyState: 'complete',
    }), { stock: 'Test stock', weight: '—', cost: '12.50', change: '—' });
});

import { fetchHistoryPage, historyPageAction } from './historyPage';

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request?.action !== historyPageAction || sender.id !== chrome.runtime.id) return;

    const cubeSymbol = sender.url?.match(/^https:\/\/xueqiu\.com\/P\/(ZH\d+)(?:[/?#]|$)/)?.[1];
    const page: unknown = request.page;
    if (!cubeSymbol || typeof page !== 'number' || !Number.isSafeInteger(page) || page < 1) return;

    void fetchHistoryPage(cubeSymbol, page, 'include').then(
        data => sendResponse({ data }),
        error => sendResponse({ error: String(error) }),
    );
    return true;
});

chrome.runtime.onInstalled.addListener(() => {
    console.log('Chrome extension installed');
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'getData') {
        // Handle the request and send a response
        sendResponse({ data: 'Sample data' });
    }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.status === 'complete' && tab.url) {
        console.log(`Tab updated: ${tab.url}`);
    }
});

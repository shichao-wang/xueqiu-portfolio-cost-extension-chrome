// background.ts

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
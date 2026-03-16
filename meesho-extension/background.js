// Open side panel when extension icon is clicked
chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ windowId: tab.windowId });
});

// Enable side panel on all Meesho pages
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

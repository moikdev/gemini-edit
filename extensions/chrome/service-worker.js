'use strict';

// Network polling belongs to the visible side panel, not a transient MV3 worker.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);

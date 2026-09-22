// The one place the app version lives (bump it on every deploy). Classic
// script so both the page (<script>) and the service worker (importScripts)
// can read it; the SW's cache name and the in-app "update available" check
// both key off it.
self.ONDA_VERSION = 'v30';

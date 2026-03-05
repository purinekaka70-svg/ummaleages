const CACHE_NAME = "umma-cache-v3";
const CORE_ASSETS = [
  "./",
  "index.html",
  "register.html",
  "admin.html",
  "club.html",
  "efootball.html",
  "styte.css",
  "admin.css",
  "club.css",
  "efootball.css",
  "script.js",
  "admin.js",
  "club.js",
  "efootball.js",
  "firebase-bridge.js",
  "umma-logo.svg",
  "favicon.svg",
  "manifest.webmanifest",
  "pwa-install.js"
];

self.addEventListener("install", (event)=>{
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache)=> cache.addAll(CORE_ASSETS)).then(()=> self.skipWaiting())
  );
});

self.addEventListener("activate", (event)=>{
  event.waitUntil(
    caches.keys().then((keys)=> Promise.all(keys.filter((k)=> k !== CACHE_NAME).map((k)=> caches.delete(k))))
      .then(()=> self.clients.claim())
  );
});

self.addEventListener("fetch", (event)=>{
  if(event.request.method !== "GET") return;
  const requestUrl = new URL(event.request.url);

  // Never intercept Firebase/Auth SDK or API traffic.
  // Let the browser do direct network for these endpoints.
  if(requestUrl.hostname.includes("googleapis.com") || requestUrl.hostname.includes("gstatic.com")){
    return;
  }

  const isNavigation = event.request.mode === "navigate";
  if(isNavigation){
    event.respondWith(
      fetch(event.request)
        .then((response)=>{
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache)=> cache.put(event.request, clone)).catch(()=>{});
          return response;
        })
        .catch(()=> caches.match(event.request).then((hit)=> hit || caches.match("index.html")))
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cached)=>{
      if(cached){
        fetch(event.request)
          .then((response)=> caches.open(CACHE_NAME).then((cache)=> cache.put(event.request, response.clone())))
          .catch(()=>{});
        return cached;
      }
      return fetch(event.request).then((response)=>{
        const clone = response.clone();
        caches.open(CACHE_NAME).then((cache)=> cache.put(event.request, clone)).catch(()=>{});
        return response;
      });
    })
  );
});

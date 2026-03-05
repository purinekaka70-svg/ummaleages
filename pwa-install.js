(function(){
  const INSTALL_BTN_ID = "ummaInstallAppBtn";
  const LOADER_ID = "ummaGlobalLoader";
  const LOADER_TEXT_ID = "ummaLoaderText";
  const OFFLINE_ID = "ummaOfflineNotice";
  const INSTALL_BUTTON_ENABLED = false;
  const LOADER_MAX_VISIBLE_MS = 3500;
  let deferredPrompt = null;
  let pendingCount = 0;
  let loaderAutoResetTimer = null;

  function createInstallButton(){
    if(document.getElementById(INSTALL_BTN_ID)) return null;
    const btn = document.createElement("button");
    btn.id = INSTALL_BTN_ID;
    btn.type = "button";
    btn.textContent = "Install App";
    btn.style.position = "fixed";
    btn.style.right = "16px";
    btn.style.bottom = "16px";
    btn.style.zIndex = "9999";
    btn.style.border = "none";
    btn.style.borderRadius = "999px";
    btn.style.padding = "10px 14px";
    btn.style.fontWeight = "700";
    btn.style.cursor = "pointer";
    btn.style.background = "#f5c542";
    btn.style.color = "#2b0b4a";
    btn.style.boxShadow = "0 10px 24px rgba(0,0,0,0.2)";
    btn.style.display = "inline-block";
    document.body.appendChild(btn);
    return btn;
  }

  function createLoader(){
    if(document.getElementById(LOADER_ID)) return;
    const wrap = document.createElement("div");
    wrap.id = LOADER_ID;
    wrap.style.position = "fixed";
    wrap.style.inset = "0";
    wrap.style.zIndex = "9998";
    wrap.style.display = "none";
    wrap.style.alignItems = "center";
    wrap.style.justifyContent = "center";
    wrap.style.background = "rgba(10,10,18,0.24)";
    wrap.innerHTML = `
      <div style="display:flex;align-items:center;gap:10px;background:#fff;border-radius:12px;padding:12px 16px;box-shadow:0 12px 28px rgba(0,0,0,0.18);">
        <span style="width:18px;height:18px;border:3px solid #d9c98a;border-top-color:#2b0b4a;border-radius:50%;display:inline-block;animation:ummaSpin .8s linear infinite;"></span>
        <span id="${LOADER_TEXT_ID}" style="font-weight:600;color:#2b0b4a;">Loading...</span>
      </div>
    `;
    const style = document.createElement("style");
    style.textContent = "@keyframes ummaSpin{to{transform:rotate(360deg)}}";
    document.head.appendChild(style);
    document.body.appendChild(wrap);
  }

  function createOfflineNotice(){
    if(document.getElementById(OFFLINE_ID)) return;
    const bar = document.createElement("div");
    bar.id = OFFLINE_ID;
    bar.textContent = "Internet unstable. Retrying...";
    bar.style.position = "fixed";
    bar.style.left = "50%";
    bar.style.top = "12px";
    bar.style.transform = "translateX(-50%)";
    bar.style.zIndex = "9999";
    bar.style.padding = "8px 12px";
    bar.style.borderRadius = "999px";
    bar.style.background = "#7a1d1d";
    bar.style.color = "#fff";
    bar.style.fontWeight = "700";
    bar.style.fontSize = "12px";
    bar.style.display = navigator.onLine ? "none" : "block";
    document.body.appendChild(bar);
    window.addEventListener("offline", ()=>{ bar.style.display = "block"; });
    window.addEventListener("online", ()=>{ bar.style.display = "none"; });
  }

  function setLoaderVisible(visible, message = "Loading..."){
    const wrap = document.getElementById(LOADER_ID);
    const text = document.getElementById(LOADER_TEXT_ID);
    if(!wrap) return;
    if(text) text.textContent = message;
    wrap.style.display = visible ? "flex" : "none";
  }

  function showInstallButton(){
    if(!INSTALL_BUTTON_ENABLED) return;
    const btn = document.getElementById(INSTALL_BTN_ID) || createInstallButton();
    if(!btn) return;
    btn.style.display = "inline-block";
    btn.onclick = async ()=>{
      if(deferredPrompt){
        deferredPrompt.prompt();
        try{
          await deferredPrompt.userChoice;
        } catch {}
        deferredPrompt = null;
        btn.style.display = "none";
        return;
      }
      alert("Install prompt is not available yet on this browser. Use browser menu: 'Install app' or 'Add to Home screen'.");
    };
  }

  function registerServiceWorker(){
    if(!("serviceWorker" in navigator)) return;
    window.addEventListener("load", ()=>{
      navigator.serviceWorker.register("sw.js")
        .then((reg)=> reg.update().catch(()=>{}))
        .catch(()=>{});
      let reloaded = false;
      navigator.serviceWorker.addEventListener("controllerchange", ()=>{
        if(reloaded) return;
        reloaded = true;
        window.location.reload();
      });
    });
  }

  function initInstallFlow(){
    if(INSTALL_BUTTON_ENABLED){
      createInstallButton();
    }
    createLoader();
    createOfflineNotice();
    window.addEventListener("beforeinstallprompt", (event)=>{
      if(!INSTALL_BUTTON_ENABLED) return;
      event.preventDefault();
      deferredPrompt = event;
      showInstallButton();
    });
    window.addEventListener("appinstalled", ()=>{
      const btn = document.getElementById(INSTALL_BTN_ID);
      if(btn) btn.style.display = "none";
      deferredPrompt = null;
    });
  }

  function clearLoaderAutoReset(){
    if(loaderAutoResetTimer){
      clearTimeout(loaderAutoResetTimer);
      loaderAutoResetTimer = null;
    }
  }

  function scheduleLoaderAutoReset(){
    clearLoaderAutoReset();
    loaderAutoResetTimer = setTimeout(()=>{
      pendingCount = 0;
      setLoaderVisible(false);
      loaderAutoResetTimer = null;
    }, LOADER_MAX_VISIBLE_MS);
  }

  window.ummaLoading = {
    start(message = "Loading..."){
      pendingCount += 1;
      setLoaderVisible(true, message);
      scheduleLoaderAutoReset();
    },
    end(){
      pendingCount = Math.max(0, pendingCount - 1);
      if(pendingCount === 0){
        clearLoaderAutoReset();
        setLoaderVisible(false);
      }
    },
    reset(){
      pendingCount = 0;
      clearLoaderAutoReset();
      setLoaderVisible(false);
    }
  };

  registerServiceWorker();
  initInstallFlow();
})();

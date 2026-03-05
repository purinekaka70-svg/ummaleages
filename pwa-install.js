(function(){
  const INSTALL_BTN_ID = "ummaInstallAppBtn";
  let deferredPrompt = null;

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
    btn.style.display = "none";
    document.body.appendChild(btn);
    return btn;
  }

  function showInstallButton(){
    const btn = document.getElementById(INSTALL_BTN_ID) || createInstallButton();
    if(!btn) return;
    btn.style.display = "inline-block";
    btn.onclick = async ()=>{
      if(!deferredPrompt) return;
      deferredPrompt.prompt();
      try{
        await deferredPrompt.userChoice;
      } catch {}
      deferredPrompt = null;
      btn.style.display = "none";
    };
  }

  function registerServiceWorker(){
    if(!("serviceWorker" in navigator)) return;
    window.addEventListener("load", ()=>{
      navigator.serviceWorker.register("sw.js").catch(()=>{});
    });
  }

  function initInstallFlow(){
    createInstallButton();
    window.addEventListener("beforeinstallprompt", (event)=>{
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

  registerServiceWorker();
  initInstallFlow();
})();

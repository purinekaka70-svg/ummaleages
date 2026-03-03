// Firestore helpers for direct lookups/writes
import { doc, getDoc, setDoc, deleteDoc, getDocs, collection, query, where } from "https://www.gstatic.com/firebasejs/12.10.0/firebase-firestore.js";

document.addEventListener('DOMContentLoaded', ()=>{ initClubPortal(); });

window.ummaAuth.onAuthStateChanged(async (user) => {
    if (!user) {
        clearCurrentClub();
        window.location.href = 'register.html#login';
        return;
    }

    const db = firebase.firestore(); // make sure Firestore is initialized

    // 1️ Check if this user is an admin
    const adminDoc = await db.collection("admins").doc(user.uid).get();

    if (adminDoc.exists) {
        //  Admin logged in
        sessionStorage.setItem('adminAuth', 'true');
        hydrateAdminView(); // show admin portal
        return; //  stop club logic
    }

    // 2️ Normal club logic
    initClubPortal();
});
// -------------------- LOCAL STORAGE CLUB --------------------
function getCurrentClub(){
    try{
        return localStorage.getItem('umma.currentClub') || '';
    } catch { return ''; }
}

function clearCurrentClub(){
    try{ localStorage.removeItem('umma.currentClub'); } catch {}
}

// -------------------- INIT CLUB PORTAL --------------------
async function initClubPortal(){
    clearLegacyLocalTeamData();

    if(window.ummaAuth && typeof window.ummaAuth.onAuthStateChanged === 'function'){
        await new Promise((res)=>{
            const unsubscribe = window.ummaAuth.onAuthStateChanged((u)=>{
                unsubscribe();
                res();
            });
            setTimeout(res, 2000);
        });
    }

    const user = window.ummaAuth?.getAuthUser?.();
    if(!user){
        clearCurrentClub();
        document.getElementById('clubAuthNotice').style.display = 'block';
        return;
    }

    await hydrateRemoteStore();

    const clubName = getCurrentClub();
    if(!clubName){
        document.getElementById('clubAuthNotice').style.display = 'block';
        return;
    }

    document.getElementById('clubPortalApp').style.display = 'block';
    bindClubEvents();
    await renderClubPortal();
    startRemoteSubscription();
}

// -------------------- MEMORY STORE --------------------
function clearLegacyLocalTeamData(){
    const keys = ['teams', 'accounts', 'players'];
    keys.forEach((key)=>{
        delete clubMemoryStore[key];
        try{
            localStorage.removeItem(DB_KEY_PREFIX + key);
            localStorage.removeItem(key);
        } catch {}
    });
}

async function hydrateRemoteStore(){
    if(!window.ummaRemoteStore?.loadState) return;
    try{
        const remote = await window.ummaRemoteStore.loadState();
        Object.keys(remote || {}).forEach((key)=>{
            const value = String(remote[key]);
            clubMemoryStore[key] = value;
            if(isNonPersistentKey(key)){
                try{ localStorage.removeItem(DB_KEY_PREFIX + key); } catch {}
            } else {
                try{ localStorage.setItem(DB_KEY_PREFIX + key, value); } catch {}
            }
        });
    } catch {}
}

function applyRemoteState(remote){
    Object.keys(remote || {}).forEach((key)=>{
        const value = String(remote[key]);
        clubMemoryStore[key] = value;
        if(isNonPersistentKey(key)){
            try{ localStorage.removeItem(DB_KEY_PREFIX + key); } catch {}
        } else {
            try{ localStorage.setItem(DB_KEY_PREFIX + key, value); } catch {}
        }
    });
}

function startRemoteSubscription(){
    if(!window.ummaRemoteStore?.subscribeState) return;
    window.ummaRemoteStore.subscribeState((remote)=>{
        applyRemoteState(remote);
        renderClubPortal();
    });
}

// -------------------- EVENTS --------------------
function bindClubEvents(){
    const logoutBtn = document.getElementById('clubLogoutBtn');
    const saveInfoBtn = document.getElementById('saveClubInfoBtn');
    const addPlayerBtn = document.getElementById('addPlayerBtn');
    const saveSotwBtn = document.getElementById('saveSotwBtn');
    const postMatchSquadBtn = document.getElementById('postMatchSquadBtn');
    const playersBody = document.getElementById('clubPlayersBody');
    const leagueViewSelect = document.getElementById('clubLeagueViewSelect');
    const menuBtn = document.getElementById('clubHamburgerBtn');
    const menuPanel = document.getElementById('clubMenuPanel');
    const menuLinks = document.querySelectorAll('.menu-link[data-target]');

    if(logoutBtn) logoutBtn.addEventListener('click', ()=>{
        clearCurrentClub();
        window.location.href = 'register.html#login';
    });
    if(saveInfoBtn) saveInfoBtn.addEventListener('click', saveClubInfo);
    if(addPlayerBtn) addPlayerBtn.addEventListener('click', addPlayer);
    if(saveSotwBtn) saveSotwBtn.addEventListener('click', saveSquadOfWeek);
    if(postMatchSquadBtn) postMatchSquadBtn.addEventListener('click', postMatchSquad);
    if(leagueViewSelect) leagueViewSelect.addEventListener('change', async ()=>{
        await renderSquadFixtureSelect();
        await renderSotwHistory();
        await renderClubFixtures();
        await renderClubStandings();
    });
    if(menuBtn && menuPanel){
        menuBtn.addEventListener('click', ()=> menuPanel.classList.toggle('open'));
    }
    menuLinks.forEach((btn)=>{
        btn.addEventListener('click', ()=>{
            openClubSection(btn.dataset.target);
            if(menuPanel) menuPanel.classList.remove('open');
        });
    });
    if(playersBody){
        playersBody.addEventListener('click', (e)=>{
            const btn = e.target.closest('button[data-action="remove-player"]');
            if(!btn) return;
            const playerName = btn.dataset.player;
            if(!playerName) return;
            removePlayer(playerName);
        });
    }
}

// -------------------- RENDER CLUB --------------------
async function renderClubPortal(){
    const user = window.ummaAuth.getAuthUser();
    if(!user){
        clearCurrentClub();
        window.location.href = 'register.html#login';
        return;
    }

    try{
        async function resolveTeamDoc(){
            const byOwner = await getDocs(query(collection(window.ummaFire.db,'teams'), where('ownerUid','==',user.uid)));
            if(!byOwner.empty) return byOwner.docs[0];
            const direct = await getDoc(doc(window.ummaFire.db,'teams',user.uid));
            if(direct.exists()) return direct;
            return null;
        }

        let snap = await resolveTeamDoc();
        if(!snap || !snap.exists()){
            alert('Club profile not found');
            window.location.href = 'register.html';
            return;
        }

        const team = snap.data();
        localStorage.setItem('umma.currentClub', team.teamName);

        setText('clubNameHeading', team.teamName);
        setText('clubLeague', team.league || '-');
        setText('clubStatus', team.status || '-');
        setText('clubPayment', getPaymentLabel(team));
        setText('clubCoach', team.coachName || '-');
        setText('clubPhone', team.phone || '-');

        const coachInput = document.getElementById('clubCoachInput');
        const phoneInput = document.getElementById('clubPhoneInput');
        if(coachInput) coachInput.value = team.coachName || '';
        if(phoneInput) phoneInput.value = team.phone || '';

        await renderLeagueViewSelect(team);
        await renderPlayers();
        await renderSquadFixtureSelect();
        await renderSquadPlayerChecks();
        await renderClubFixtures();
        await renderClubStandings();
        await renderSotwHistory();

    } catch(error){
        console.error(error);
        alert('Error loading club');
    }
}

// -------------------- UTILITIES --------------------
function setText(id, v){ const el = document.getElementById(id); if(el) el.textContent = String(v ?? ''); }
function collapseSpaces(v){ return String(v || '').replace(/\s+/g, ' ').trim(); }
function escapeHTML(v){ 
    return String(v || '')
        .replaceAll('&','&amp;')
        .replaceAll('<','&lt;')
        .replaceAll('>','&gt;')
        .replaceAll('"','&quot;')
        .replaceAll("'","&#39;"); 
}
function escapeAttr(v){ return escapeHTML(v); }
function getPaymentLabel(team){
    const status = String(team?.status || '');
    const paymentStatus = String(team?.paymentStatus || '').trim();
    const feePaid = Number(team?.feePaid || 0);
    if(paymentStatus) return paymentStatus;
    if(feePaid <= 0) return 'Free';
    if(status === 'Active') return 'Paid';
    if(status === 'Pending Payment') return 'Pending';
    return '-';
}
function getCurrentWeekLabel(){
    const now = new Date();
    const onejan = new Date(now.getFullYear(), 0, 1);
    const week = Math.ceil((((now - onejan) / 86400000) + onejan.getDay() + 1) / 7);
    return `Week ${week}`;
}

// -------------------- ADD/REMOVE PLAYER --------------------
async function renderPlayers(){
    const clubName = getCurrentClub();
    const body = document.getElementById('clubPlayersBody');
    if(!body) return;
    let players = await fetchCollection('players');
    players = players.filter(p=> p.team === clubName).sort((a,b)=> a.name.localeCompare(b.name));
    body.innerHTML = '';
    players.forEach((p)=>{
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td>${escapeHTML(p.name)}</td>
            <td><button class="btn btn-primary" data-action="remove-player" data-player="${escapeAttr(p.name)}">Remove</button></td>
        `;
        body.appendChild(tr);
    });
}

async function addPlayer(){
    const clubName = getCurrentClub();
    const input = document.getElementById('newPlayerInput');
    const name = collapseSpaces(input?.value || '');
    if(!name){ alert('Enter player name'); return; }

    const players = await fetchCollection('players');
    const existing = players.find(p=> p.name.toLowerCase() === name.toLowerCase());
    if(existing){
        if(existing.team !== clubName){ alert(`Player belongs to another team (${existing.team})`); return; }
        alert('Player already exists in your team');
        return;
    }

    try{
        const id = `${slug(clubName)}__${slug(name)}`;
        await setDoc(doc(window.ummaFire.db, 'players', id), { name, team: clubName });
        input.value = '';
        await renderPlayers();
        await renderSquadPlayerChecks();
    } catch(err){
        console.error('addPlayer firestore error', err);
        alert('Failed to add player');
    }
}

async function removePlayer(playerName){
    const clubName = getCurrentClub();
    try{
        const id = `${slug(clubName)}__${slug(playerName)}`;
        await deleteDoc(doc(window.ummaFire.db, 'players', id));
        await renderPlayers();
        await renderSquadPlayerChecks();
    } catch(err){
        console.error('removePlayer firestore error', err);
        alert('Failed to remove player');
    }
}

// -------------------- FETCH COLLECTION --------------------
async function fetchCollection(name){
    if(!window.ummaFire || !window.ummaFire.db) return [];
    try{
        const snap = await getDocs(collection(window.ummaFire.db, name));
        return snap.docs.map(d=>d.data());
    } catch(e){
        console.error('fetchCollection', name, e);
        return [];
    }
}
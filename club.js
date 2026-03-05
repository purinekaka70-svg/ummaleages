// Firestore helpers for direct lookups/writes
import { doc, getDoc, setDoc, deleteDoc, getDocs, collection, query, where } from "https://www.gstatic.com/firebasejs/12.10.0/firebase-firestore.js";

document.addEventListener('DOMContentLoaded', ()=>{ initClubPortal(); });
const clubMemoryStore = (window.opener && window.opener.__UMMA_DB__)
    || window.__UMMA_DB__
    || (window.__UMMA_DB__ = {});
const DB_KEY_PREFIX = 'umma.db.';
const NON_PERSISTENT_KEYS = new Set([]);
let currentSquadFixtureId = '';

function isNonPersistentKey(key){
    return NON_PERSISTENT_KEYS.has(String(key || ''));
}

function slug(value){
    return String(value || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'item';
}

function loadingStart(message){
    ensureLoadingApi().start(message);
}

function loadingEnd(){
    ensureLoadingApi().end();
}

function ensureLoadingApi(){
    if(window.ummaLoading) return window.ummaLoading;
    if(window.__ummaFallbackLoading) return window.__ummaFallbackLoading;
    const LOADER_ID = 'ummaFallbackLoader';
    const TEXT_ID = 'ummaFallbackLoaderText';
    let pending = 0;
    const ensureDom = ()=>{
        if(document.getElementById(LOADER_ID)) return;
        const wrap = document.createElement('div');
        wrap.id = LOADER_ID;
        wrap.style.position = 'fixed';
        wrap.style.inset = '0';
        wrap.style.zIndex = '9998';
        wrap.style.display = 'none';
        wrap.style.alignItems = 'center';
        wrap.style.justifyContent = 'center';
        wrap.style.background = 'rgba(10,10,18,0.24)';
        wrap.innerHTML = `<div style="display:flex;align-items:center;gap:10px;background:#fff;border-radius:12px;padding:12px 16px;box-shadow:0 12px 28px rgba(0,0,0,0.18);"><span style="width:18px;height:18px;border:3px solid #d9c98a;border-top-color:#2b0b4a;border-radius:50%;display:inline-block;animation:ummaSpinFallback .8s linear infinite;"></span><span id="${TEXT_ID}" style="font-weight:600;color:#2b0b4a;">Loading...</span></div>`;
        if(!document.getElementById('ummaFallbackLoaderStyle')){
            const style = document.createElement('style');
            style.id = 'ummaFallbackLoaderStyle';
            style.textContent = '@keyframes ummaSpinFallback{to{transform:rotate(360deg)}}';
            document.head.appendChild(style);
        }
        document.body.appendChild(wrap);
    };
    const api = {
        start(message = 'Loading...'){
            pending += 1;
            ensureDom();
            const wrap = document.getElementById(LOADER_ID);
            const text = document.getElementById(TEXT_ID);
            if(text) text.textContent = message;
            if(wrap) wrap.style.display = 'flex';
        },
        end(){
            pending = Math.max(0, pending - 1);
            if(pending !== 0) return;
            const wrap = document.getElementById(LOADER_ID);
            if(wrap) wrap.style.display = 'none';
        }
    };
    window.__ummaFallbackLoading = api;
    return api;
}

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
    loadingStart('Loading club portal...');
    try{
        clearLegacyLocalTeamData();

        if(window.ummaAuth && typeof window.ummaAuth.onAuthStateChanged === 'function'){
            await new Promise((res)=>{
                const timeoutId = setTimeout(res, 300);
                const unsubscribe = window.ummaAuth.onAuthStateChanged((u)=>{
                    clearTimeout(timeoutId);
                    unsubscribe();
                    res();
                });
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
    } finally {
        loadingEnd();
    }
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
        window.location.href = 'index.html#login';
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
        window.location.href = 'index.html#login';
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
            window.location.href = 'index.html#register';
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
    loadingStart(`Fetching ${name}...`);
    try{
        const snap = await getDocs(collection(window.ummaFire.db, name));
        return snap.docs.map(d=>d.data());
    } catch(e){
        console.error('fetchCollection', name, e);
        return [];
    } finally {
        loadingEnd();
    }
}

function getSelectedLeague(){
    const sel = document.getElementById('clubLeagueViewSelect');
    return String(sel?.value || '').trim();
}

function openClubSection(sectionId){
    const id = String(sectionId || '').trim();
    const panels = document.querySelectorAll('.club-panel');
    const links = document.querySelectorAll('.menu-link[data-target]');
    panels.forEach((panel)=>{
        panel.style.display = panel.id === id ? 'block' : 'none';
    });
    links.forEach((link)=>{
        if(link.dataset.target === id){
            link.classList.add('active');
        } else {
            link.classList.remove('active');
        }
    });
}

async function resolveCurrentTeamDoc(){
    const user = window.ummaAuth?.getAuthUser?.();
    if(!user || !window.ummaFire?.db) return null;
    const byOwner = await getDocs(query(collection(window.ummaFire.db, 'teams'), where('ownerUid', '==', user.uid)));
    if(!byOwner.empty) return byOwner.docs[0];
    const direct = await getDoc(doc(window.ummaFire.db, 'teams', user.uid));
    if(direct.exists()) return direct;
    return null;
}

async function renderLeagueViewSelect(team = null){
    const select = document.getElementById('clubLeagueViewSelect');
    if(!select) return;
    const leagueSet = new Set();
    const teams = await fetchCollection('teams');
    teams.forEach((row)=>{
        const league = String(row?.league || '').trim();
        if(league) leagueSet.add(league);
    });
    const ownLeague = String(team?.league || '').trim();
    if(ownLeague) leagueSet.add(ownLeague);
    const leagues = [...leagueSet].sort((a,b)=> a.localeCompare(b));
    const previous = String(select.value || '');
    select.innerHTML = '';
    leagues.forEach((league)=>{
        select.appendChild(new Option(league, league));
    });
    if(previous && leagues.includes(previous)){
        select.value = previous;
    } else if(ownLeague && leagues.includes(ownLeague)){
        select.value = ownLeague;
    } else if(leagues.length){
        select.value = leagues[0];
    }
}

async function renderClubFixtures(){
    const body = document.getElementById('clubFixturesBody');
    if(!body) return;
    const clubName = getCurrentClub();
    const selectedLeague = getSelectedLeague();
    let fixtures = await fetchCollection('fixtures');
    fixtures = fixtures.filter((f)=> f.home === clubName || f.away === clubName);
    if(selectedLeague) fixtures = fixtures.filter((f)=> String(f.league || '') === selectedLeague);
    fixtures.sort((a,b)=> String(a.date || '').localeCompare(String(b.date || '')));
    body.innerHTML = '';
    if(fixtures.length === 0){
        body.innerHTML = '<tr><td colspan="4" class="muted">No fixtures found.</td></tr>';
        return;
    }
    fixtures.forEach((f)=>{
        const tr = document.createElement('tr');
        tr.innerHTML = `<td>${escapeHTML(f.league || '-')}</td><td>${escapeHTML(f.home || '-')} vs ${escapeHTML(f.away || '-')}</td><td>${escapeHTML(f.date || '-')}</td><td>${escapeHTML(f.status || 'Scheduled')}</td>`;
        body.appendChild(tr);
    });
}

async function renderClubStandings(){
    const body = document.getElementById('clubStandingsBody');
    if(!body) return;
    const selectedLeague = getSelectedLeague();
    let standings = await fetchCollection('standings');
    if(selectedLeague) standings = standings.filter((row)=> String(row.league || '') === selectedLeague);
    standings.sort((a,b)=> Number(b.pts || 0) - Number(a.pts || 0) || Number(b.gd || 0) - Number(a.gd || 0));
    body.innerHTML = '';
    if(standings.length === 0){
        body.innerHTML = '<tr><td colspan="8" class="muted">No standings available.</td></tr>';
        return;
    }
    standings.forEach((row, idx)=>{
        const tr = document.createElement('tr');
        tr.innerHTML = `<td>${idx + 1}</td><td>${escapeHTML(row.team || '-')}</td><td>${Number(row.p || 0)}</td><td>${Number(row.w || 0)}</td><td>${Number(row.d || 0)}</td><td>${Number(row.l || 0)}</td><td>${Number(row.gd || 0)}</td><td>${Number(row.pts || 0)}</td>`;
        body.appendChild(tr);
    });
}

async function renderSquadFixtureSelect(){
    const clubName = getCurrentClub();
    const selectedLeague = getSelectedLeague();
    const host = document.getElementById('squadCurrentFixtureText');
    let fixtures = await fetchCollection('fixtures');
    fixtures = fixtures.filter((f)=> f.home === clubName || f.away === clubName);
    if(selectedLeague) fixtures = fixtures.filter((f)=> String(f.league || '') === selectedLeague);
    fixtures.sort((a,b)=> String(a.date || '').localeCompare(String(b.date || '')));
    const nextFixture = fixtures.find((f)=> String(f.status || '').toLowerCase() !== 'played') || fixtures[0] || null;
    if(!nextFixture){
        currentSquadFixtureId = '';
        if(host) host.textContent = 'No fixture selected';
        return;
    }
    currentSquadFixtureId = String(nextFixture.id || '');
    if(host) host.textContent = `${nextFixture.home} vs ${nextFixture.away} (${nextFixture.date || '-'})`;
}

async function renderSquadPlayerChecks(){
    const host = document.getElementById('squadRoleChecks');
    const startersCountEl = document.getElementById('squadStarterCount');
    const subsCountEl = document.getElementById('squadSubsCount');
    if(!host) return;
    const clubName = getCurrentClub();
    let players = await fetchCollection('players');
    players = players.filter((row)=> String(row.team || '') === clubName).sort((a,b)=> String(a.name || '').localeCompare(String(b.name || '')));
    host.innerHTML = '';
    if(players.length === 0){
        host.innerHTML = '<div class="muted">No players added yet.</div>';
        if(startersCountEl) startersCountEl.textContent = 'Starters selected: 0';
        if(subsCountEl) subsCountEl.textContent = 'Subs selected: 0';
        return;
    }
    players.forEach((player)=>{
        const row = document.createElement('div');
        row.className = 'player-check';
        row.innerHTML = `
            <div style="font-weight:700;margin-bottom:6px">${escapeHTML(player.name || '')}</div>
            <label><input type="checkbox" data-role="starter" data-player="${escapeAttr(player.name || '')}"> Starter</label>
            <label style="margin-left:10px"><input type="checkbox" data-role="sub" data-player="${escapeAttr(player.name || '')}"> Sub</label>
        `;
        host.appendChild(row);
    });
    const updateCounts = ()=>{
        const starters = host.querySelectorAll('input[data-role="starter"]:checked').length;
        const subs = host.querySelectorAll('input[data-role="sub"]:checked').length;
        if(startersCountEl) startersCountEl.textContent = `Starters selected: ${starters}`;
        if(subsCountEl) subsCountEl.textContent = `Subs selected: ${subs}`;
    };
    host.querySelectorAll('input[type="checkbox"]').forEach((box)=> box.addEventListener('change', updateCounts));
    updateCounts();
}

async function saveClubInfo(){
    const snap = await resolveCurrentTeamDoc();
    if(!snap){
        alert('Club profile not found.');
        return;
    }
    const existing = snap.data() || {};
    const coachName = collapseSpaces(document.getElementById('clubCoachInput')?.value || existing.coachName || '');
    const phone = collapseSpaces(document.getElementById('clubPhoneInput')?.value || existing.phone || '');
    try{
        await setDoc(doc(window.ummaFire.db, 'teams', String(existing.id || snap.id)), {
            coachName,
            phone,
            updatedAtMs: Date.now()
        }, { merge: true });
        await renderClubPortal();
        alert('Club profile updated.');
    } catch {
        alert('Failed to save club info.');
    }
}

function readSelectedSquad(){
    const host = document.getElementById('squadRoleChecks');
    if(!host) return { starters: [], subs: [] };
    const starters = [...host.querySelectorAll('input[data-role="starter"]:checked')].map((el)=> String(el.dataset.player || '').trim()).filter(Boolean);
    const subs = [...host.querySelectorAll('input[data-role="sub"]:checked')].map((el)=> String(el.dataset.player || '').trim()).filter(Boolean);
    return { starters, subs };
}

async function saveSquadOfWeek(){
    const snap = await resolveCurrentTeamDoc();
    if(!snap){
        alert('Club profile not found.');
        return;
    }
    const squad = readSelectedSquad();
    if(squad.starters.length === 0 && squad.subs.length === 0){
        alert('Select at least one player.');
        return;
    }
    const existing = snap.data() || {};
    const history = Array.isArray(existing.sotwHistory) ? existing.sotwHistory : [];
    const entry = {
        week: getCurrentWeekLabel(),
        fixture: document.getElementById('squadCurrentFixtureText')?.textContent || '-',
        starters: squad.starters,
        subs: squad.subs,
        updatedAtMs: Date.now()
    };
    try{
        await setDoc(doc(window.ummaFire.db, 'teams', String(existing.id || snap.id)), {
            sotw: entry,
            sotwHistory: [...history, entry].slice(-20),
            updatedAtMs: Date.now()
        }, { merge: true });
        await renderSotwHistory();
        alert('Squad of the week saved.');
    } catch {
        alert('Failed to save squad of the week.');
    }
}

async function postMatchSquad(){
    if(!currentSquadFixtureId){
        alert('No fixture selected.');
        return;
    }
    const clubName = getCurrentClub();
    const squad = readSelectedSquad();
    if(squad.starters.length === 0 && squad.subs.length === 0){
        alert('Select players before posting squad.');
        return;
    }
    try{
        const fixtureRef = doc(window.ummaFire.db, 'fixtures', currentSquadFixtureId);
        const fixtureSnap = await getDoc(fixtureRef);
        const fixtureData = fixtureSnap.exists() ? fixtureSnap.data() : {};
        const squads = fixtureData?.squads && typeof fixtureData.squads === 'object' ? fixtureData.squads : {};
        squads[clubName] = {
            starters: squad.starters,
            subs: squad.subs,
            postedAtMs: Date.now()
        };
        await setDoc(fixtureRef, { squads, updatedAtMs: Date.now() }, { merge: true });
        alert('Match squad posted.');
    } catch {
        alert('Failed to post match squad.');
    }
}

async function renderSotwHistory(){
    const body = document.getElementById('sotwHistoryBody');
    if(!body) return;
    const snap = await resolveCurrentTeamDoc();
    const team = snap?.data?.() || {};
    const history = Array.isArray(team.sotwHistory) ? team.sotwHistory : [];
    body.innerHTML = '';
    if(history.length === 0){
        body.innerHTML = '<tr><td colspan="3" class="muted">No saved squad history yet.</td></tr>';
        return;
    }
    history.slice().reverse().forEach((entry)=>{
        const players = [...(entry.starters || []).map((name)=> `${name} (S)`), ...(entry.subs || []).map((name)=> `${name} (Sub)`)].join(', ');
        const tr = document.createElement('tr');
        tr.innerHTML = `<td>${escapeHTML(entry.week || '-')}</td><td>${escapeHTML(entry.fixture || '-')}</td><td>${escapeHTML(players || '-')}</td>`;
        body.appendChild(tr);
    });
}


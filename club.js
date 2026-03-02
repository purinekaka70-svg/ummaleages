// Firestore helpers for direct lookups/writes
import { doc, getDoc, setDoc, deleteDoc, getDocs, collection, query, where } from "https://www.gstatic.com/firebasejs/12.10.0/firebase-firestore.js";

document.addEventListener('DOMContentLoaded', ()=>{ initClubPortal(); });

// force remote only for club page if desired
const FORCE_REMOTE_ONLY = true;

// keep club session in sync with auth state
if(window.ummaAuth && typeof window.ummaAuth.onAuthStateChanged === 'function'){
    window.ummaAuth.onAuthStateChanged((user)=>{
        if(!user){
            // signed out or not authenticated any more
            clearCurrentClub();
            window.location.href = 'register.html#login';
        }
    });
}

const clubMemoryStore = (window.opener && window.opener.__UMMA_DB__)
    || window.__UMMA_DB__
    || (window.__UMMA_DB__ = {});
const DB_KEY_PREFIX = 'umma.db.';
const NON_PERSISTENT_KEYS = new Set([]);

function isNonPersistentKey(key){
    return NON_PERSISTENT_KEYS.has(String(key || ''));
}

// generic fetch helper for a top-level collection
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

// slug helper (same as firebase-bridge)
function slug(value){
    return String(value || "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "") || "item";
}

async function initClubPortal(){
    clearLegacyLocalTeamData();
    // wait until auth is ready (some browsers fire before user object is hydrated)
    if(window.ummaAuth && typeof window.ummaAuth.onAuthStateChanged === 'function'){
        await new Promise((res)=>{
            const unsubscribe = window.ummaAuth.onAuthStateChanged((u)=>{
                unsubscribe();
                res();
            });
            // fallback in case event never fires
            setTimeout(res, 2000);
        });
    }

    // Fetch latest teams snapshot if needed (not strictly required now)
    try{ await fetchCollection('teams'); } catch {};

    await hydrateRemoteStore();

    // ensure user is signed in now
    const user = window.ummaAuth?.getAuthUser?.();
    if(!user){
        clearCurrentClub();
        document.getElementById('clubAuthNotice').style.display = 'block';
        return;
    }

    const clubName = getCurrentClub();
    if(!clubName){
        document.getElementById('clubAuthNotice').style.display = 'block';
        return;
    }
    sessionStorage.setItem('currentClub', clubName);
    document.getElementById('clubPortalApp').style.display = 'block';
    bindClubEvents();
    await renderClubPortal();
    startRemoteSubscription();
}

function clearLegacyLocalTeamData(){
    const keys = ['teams', 'accounts', 'players'];
    keys.forEach((key)=>{
        delete clubMemoryStore[key];
        try{
            localStorage.removeItem(DB_KEY_PREFIX + key);
            localStorage.removeItem(key);
        } catch {
            // Ignore storage errors.
        }
    });
}

function getCurrentClub(){
    const fromSession = sessionStorage.getItem('currentClub');
    if(fromSession) return fromSession;
    try{
        return localStorage.getItem('umma.currentClub') || '';
    } catch {
        return '';
    }
}

function clearCurrentClub(){
    sessionStorage.removeItem('currentClub');
    try{
        localStorage.removeItem('umma.currentClub');
    } catch {
        // Ignore storage errors.
    }
}

async function hydrateRemoteStore(){
    if(!window.ummaRemoteStore?.loadState) return;
    try{
        const remote = await window.ummaRemoteStore.loadState();
        Object.keys(remote || {}).forEach((key)=>{
            const value = String(remote[key]);
            clubMemoryStore[key] = value;
            if(isNonPersistentKey(key)){
                try{
                    localStorage.removeItem(DB_KEY_PREFIX + key);
                } catch {
                    // Ignore storage errors.
                }
            } else {
                try{
                    localStorage.setItem(DB_KEY_PREFIX + key, value);
                } catch {
                    // Ignore storage errors.
                }
            }
        });
    } catch {
        // Keep local mode if remote load fails.
    }
}

function applyRemoteState(remote){
    Object.keys(remote || {}).forEach((key)=>{
        const value = String(remote[key]);
        clubMemoryStore[key] = value;
        if(isNonPersistentKey(key)){
            try{
                localStorage.removeItem(DB_KEY_PREFIX + key);
            } catch {
                // Ignore storage errors.
            }
        } else {
            try{
                localStorage.setItem(DB_KEY_PREFIX + key, value);
            } catch {
                // Ignore storage errors.
            }
        }
    });
}

function startRemoteSubscription(){
    if(!window.ummaRemoteStore?.subscribeState) return;
    window.ummaRemoteStore.subscribeState((remote)=>{
        applyRemoteState(remote);
        const clubName = sessionStorage.getItem('currentClub');
        if(clubName){
            renderClubPortal();
        }
    });
}

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

async function renderClubPortal(){
    if(!window.ummaAuth) return;

    const user = window.ummaAuth.getAuthUser();
    if(!user){
        clearCurrentClub();
        window.location.href = 'register.html#login';
        return;
    }

    try{
        // helper to resolve team document for this user
        async function resolveTeamDoc(){
            // first try ownerUid query
            const byOwner = await getDocs(query(collection(window.ummaFire.db,'teams'), where('ownerUid','==',user.uid)));
            if(!byOwner.empty) return byOwner.docs[0];
            // direct document path
            const direct = await getDoc(doc(window.ummaFire.db,'teams',user.uid));
            if(direct.exists()) return direct;
            // slug fallback
            const stored = sessionStorage.getItem('currentClub') || '';
            const legacyKey = slug(stored);
            if(legacyKey){
                const legacySnap = await getDoc(doc(window.ummaFire.db,'teams',legacyKey));
                if(legacySnap.exists()){
                    const legacyTeam = legacySnap.data();
                    await setDoc(doc(window.ummaFire.db,'teams',user.uid), legacyTeam, { merge:true });
                    try{ await deleteDoc(doc(window.ummaFire.db,'teams',legacyKey)); } catch{}
                    return await getDoc(doc(window.ummaFire.db,'teams',user.uid));
                }
            }
            // by teamName
            const name = sessionStorage.getItem('currentClub') || '';
            if(name){
                const q = query(collection(window.ummaFire.db,'teams'), where('teamName','==',name));
                const qSnap = await getDocs(q);
                if(!qSnap.empty) return qSnap.docs[0];
            }
            // by user email
            const userSnap = await getDoc(doc(window.ummaFire.db,'users',user.uid));
            if(userSnap.exists()){
                const email = userSnap.data().email || '';
                if(email){
                    const q2 = query(collection(window.ummaFire.db,'teams'), where('email','==',email));
                    const qSnap2 = await getDocs(q2);
                    if(!qSnap2.empty) return qSnap2.docs[0];
                }
            }
            return null;
        }

        let snap = await resolveTeamDoc();

        if(!snap || !snap.exists()){
            alert('Club profile not found');
            window.location.href = 'register.html';
            return;
        }

        const team = snap.data();

        // store club name for other functions
        sessionStorage.setItem('currentClub', team.teamName);

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

async function saveClubInfo(){
    const user = window.ummaAuth.getAuthUser();
    if(!user) return;

    const coach = document.getElementById('clubCoachInput').value.trim();
    const phone = document.getElementById('clubPhoneInput').value.trim();

    try{
        await setDoc(
            doc(window.ummaFire.db, 'teams', user.uid),
            {
                coachName: coach,
                phone: phone
            },
            { merge: true }
        );

        alert('Club info updated');
        await renderClubPortal();

    } catch(error){
        console.error(error);
        alert('Failed to update club info');
    }
}

async function renderPlayers(){
    const clubName = sessionStorage.getItem('currentClub');
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
    const clubName = sessionStorage.getItem('currentClub');
    const input = document.getElementById('newPlayerInput');
    const name = collapseSpaces(input?.value || '');
    if(!name){
        alert('Enter player name');
        return;
    }
    const players = await fetchCollection('players');
    const existing = players.find(p=> p.name.toLowerCase() === name.toLowerCase());
    if(existing){
        if(existing.team !== clubName){
            alert(`Player already belongs to another team (${existing.team})`);
            return;
        }
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
    const clubName = sessionStorage.getItem('currentClub');
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

async function renderSquadFixtureSelect(){
    const clubName = sessionStorage.getItem('currentClub');
    const leagueFilter = getSelectedLeagueFilter();
    const sel = document.getElementById('squadFixtureSelect');
    if(!sel) return;
    let fixtures = await fetchCollection('fixtures');
    fixtures = fixtures
        .filter(f=> f.home === clubName || f.away === clubName)
        .filter(f=> leagueFilter === '__all__' || f.league === leagueFilter)
        .sort((a,b)=> String(a.date).localeCompare(String(b.date)));
    sel.innerHTML = '';
    if(fixtures.length === 0){
        const emptyLabel = leagueFilter === '__all__'
            ? 'No fixtures available'
            : `No fixtures in ${leagueFilter}`;
        sel.appendChild(new Option(emptyLabel, ''));
        return;
    }
    fixtures.forEach((f)=>{
        const label = `${f.league}: ${f.home} vs ${f.away} (${f.date})`;
        sel.appendChild(new Option(label, String(f.id)));
    });
}

async function renderSquadPlayerChecks(){
    const clubName = sessionStorage.getItem('currentClub');
    const holder = document.getElementById('squadPlayerChecks');
    if(!holder) return;
    let players = await fetchCollection('players');
    players = players.filter(p=> p.team === clubName).sort((a,b)=> a.name.localeCompare(b.name));
    holder.innerHTML = '';
    if(players.length === 0){
        holder.innerHTML = '<div class="muted">Add players first to post squad.</div>';
        updateStarterCount();
        return;
    }
    players.forEach((p)=>{
        const div = document.createElement('label');
        div.className = 'player-check';
        div.innerHTML = `<input type="checkbox" name="sotwPlayer" value="${escapeAttr(p.name)}"> <strong>${escapeHTML(p.name)}</strong> <span class="muted">(Starter)</span>`;
        const check = div.querySelector('input[name="sotwPlayer"]');
        if(check){
            check.addEventListener('change', updateStarterCount);
        }
        holder.appendChild(div);
    });
    updateStarterCount();
}

async function renderClubFixtures(){
    const clubName = sessionStorage.getItem('currentClub');
    const leagueFilter = getSelectedLeagueFilter();
    const body = document.getElementById('clubFixturesBody');
    if(!body) return;
    let fixtures = await fetchCollection('fixtures');
    fixtures = fixtures
        .filter((f)=> f.home === clubName || f.away === clubName)
        .filter((f)=> leagueFilter === '__all__' || f.league === leagueFilter)
        .sort((a,b)=> String(a.date).localeCompare(String(b.date)));
    body.innerHTML = '';
    if(fixtures.length === 0){
        const tr = document.createElement('tr');
        tr.innerHTML = '<td colspan="4" class="muted">No fixtures found for this league filter.</td>';
        body.appendChild(tr);
        return;
    }
    fixtures.forEach((f)=>{
        const opponent = f.home === clubName ? f.away : f.home;
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td>${escapeHTML(f.league || '-')}</td>
            <td>${escapeHTML(clubName)} vs ${escapeHTML(opponent || '-')}</td>
            <td>${escapeHTML(f.date || '-')}</td>
            <td>${escapeHTML(f.status || 'Scheduled')}</td>
        `;
        body.appendChild(tr);
    });
}

async function renderClubStandings(){
    const leagueFilter = getSelectedLeagueFilter();
    const body = document.getElementById('clubStandingsBody');
    if(!body) return;
    let standings = await fetchCollection('standings');
    standings = standings
        .filter((s)=> leagueFilter === '__all__' || s.league === leagueFilter)
        .sort((a,b)=> (Number(b.pts) - Number(a.pts)) || (Number(b.gd) - Number(a.gd)));
    body.innerHTML = '';
    if(standings.length === 0){
        const tr = document.createElement('tr');
        tr.innerHTML = '<td colspan="8" class="muted">No standings available for selected league.</td>';
        body.appendChild(tr);
        return;
    }
    standings.forEach((row, idx)=>{
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td>${idx + 1}</td>
            <td>${escapeHTML(row.team || '-')}</td>
            <td>${Number(row.p || 0)}</td>
            <td>${Number(row.w || 0)}</td>
            <td>${Number(row.d || 0)}</td>
            <td>${Number(row.l || 0)}</td>
            <td>${Number(row.gd || 0)}</td>
            <td>${Number(row.pts || 0)}</td>
        `;
        body.appendChild(tr);
    });
}

function openClubSection(sectionId){
    const sections = document.querySelectorAll('.club-panel');
    sections.forEach((section)=>{
        section.style.display = section.id === sectionId ? 'block' : 'none';
    });
    const menuLinks = document.querySelectorAll('.menu-link[data-target]');
    menuLinks.forEach((link)=>{
        link.classList.toggle('active', link.dataset.target === sectionId);
    });
}

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

async function saveSquadOfWeek(){
    const clubName = sessionStorage.getItem('currentClub');
    const fixtureId = Number(document.getElementById('squadFixtureSelect').value);
    const weekLabelRaw = document.getElementById('squadWeekLabel').value.trim();
    const weekLabel = weekLabelRaw || getCurrentWeekLabel();
    if(!fixtureId){
        alert('Select a fixture');
        return;
    }
    const selected = getCheckedPlayers();
    const subs = parseSubsInput();
    if(selected.length === 0){
        alert('Select at least one player');
        return;
    }
    const fixtures = await fetchCollection('fixtures');
    const fixture = fixtures.find(f=> Number(f.id) === fixtureId);
    if(!fixture){
        alert('Fixture not found');
        return;
    }
    // upsert record in firestore collection
    try{
        const id = `${clubName}__${weekLabel}`;
        const record = {
            team: clubName,
            weekLabel,
            fixtureId,
            fixtureLeague: fixture.league || '',
            fixtureLabel: `${fixture.league}: ${fixture.home} vs ${fixture.away} (${fixture.date})`,
            players: selected,
            substitutes: subs,
            createdAt: new Date().toISOString()
        };
        await setDoc(doc(window.ummaFire.db, 'squadOfWeek', id), record, { merge: true });
        await renderSotwHistory();
        alert('Squad of the week saved');
    } catch(err){
        console.error('saveSquadOfWeek error', err);
        alert('Failed to save squad');
    }
}

async function postMatchSquad(){
    const clubName = sessionStorage.getItem('currentClub');
    const fixtureId = Number(document.getElementById('squadFixtureSelect').value);
    if(!fixtureId){
        alert('Select a fixture');
        return;
    }
    const starters = getCheckedPlayers();
    const subs = parseSubsInput();
    if(starters.length === 0){
        alert('Select at least one starter');
        return;
    }
    try{
        const fixtures = await fetchCollection('fixtures');
        const target = fixtures.find(f=> Number(f.id) === fixtureId);
        if(!target){
            alert('Fixture not found');
            return;
        }
        const ref = doc(window.ummaFire.db, 'fixtures', String(fixtureId));
        const squads = target.squads || {};
        squads[clubName] = {starters, subs};
        await setDoc(ref, { squads }, { merge: true });
        alert('Match squad posted');
    } catch(err){
        console.error('postMatchSquad error', err);
        alert('Failed to post squad');
    }
}

async function renderSotwHistory(){
    const clubName = sessionStorage.getItem('currentClub');
    const leagueFilter = getSelectedLeagueFilter();
    const body = document.getElementById('sotwHistoryBody');
    if(!body) return;
    let rows = await fetchCollection('squadOfWeek');
    rows = rows
        .filter(s=> s.team === clubName)
        .filter(s=> leagueFilter === '__all__' || getSotwLeague(s) === leagueFilter)
        .sort((a,b)=> String(b.createdAt).localeCompare(String(a.createdAt)));
    body.innerHTML = '';
    if(rows.length === 0){
        const tr = document.createElement('tr');
        tr.innerHTML = '<td colspan="3" class="muted">No saved squad history for the selected league.</td>';
        body.appendChild(tr);
        return;
    }
    rows.forEach((r)=>{
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td>${escapeHTML(r.weekLabel)}</td>
            <td>${escapeHTML(r.fixtureLabel || '-')}</td>
            <td>
              <strong>Starters:</strong> ${escapeHTML((r.players || []).join(', ') || '-')}<br>
              <strong>Subs:</strong> ${escapeHTML((r.substitutes || []).join(', ') || '-')}
            </td>
        `;
        body.appendChild(tr);
    });
}

async function renderLeagueViewSelect(team){
    const clubName = sessionStorage.getItem('currentClub');
    const sel = document.getElementById('clubLeagueViewSelect');
    if(!sel) return;

    const previous = sel.value || '__all__';
    const options = new Set();
    if(team?.league) options.add(team.league);

    const fixtures = await fetchCollection('fixtures');
    fixtures
        .filter(f=> f.home === clubName || f.away === clubName)
        .forEach((f)=>{
            if(f.league) options.add(f.league);
        });

    const sota = await fetchCollection('squadOfWeek');
    sota
        .filter(s=> s.team === clubName)
        .forEach((s)=>{
            const sotwLeague = getSotwLeague(s);
            if(sotwLeague) options.add(sotwLeague);
        });

    sel.innerHTML = '';
    sel.appendChild(new Option('All Leagues', '__all__'));
    Array.from(options)
        .sort((a,b)=> String(a).localeCompare(String(b)))
        .forEach((league)=> sel.appendChild(new Option(league, league)));

    if(Array.from(sel.options).some((o)=> o.value === previous)){
        sel.value = previous;
    } else {
        sel.value = '__all__';
    }
}

function getSelectedLeagueFilter(){
    const sel = document.getElementById('clubLeagueViewSelect');
    return sel?.value || '__all__';
}

function getSotwLeague(record){
    if(record?.fixtureLeague) return record.fixtureLeague;
    const label = String(record?.fixtureLabel || '');
    const idx = label.indexOf(':');
    return idx > 0 ? label.slice(0, idx).trim() : '';
}

function getCheckedPlayers(){
    return Array.from(document.querySelectorAll('input[name="sotwPlayer"]:checked')).map(i=> i.value);
}

function updateStarterCount(){
    const count = getCheckedPlayers().length;
    setText('squadStarterCount', `Starters selected: ${count}`);
}

function parseSubsInput(){
    const raw = document.getElementById('squadSubsInput')?.value || '';
    const names = raw
        .split(',')
        .map(s=> collapseSpaces(s))
        .filter(Boolean);
    const unique = [];
    names.forEach((n)=>{
        if(!unique.some(x=> x.toLowerCase() === n.toLowerCase())){
            unique.push(n);
        }
    });
    return unique;
}

function getCurrentWeekLabel(){
    const now = new Date();
    const onejan = new Date(now.getFullYear(), 0, 1);
    const week = Math.ceil((((now - onejan) / 86400000) + onejan.getDay() + 1) / 7);
    return `Week ${week}`;
}

function setText(id, v){
    const el = document.getElementById(id);
    if(el) el.textContent = String(v ?? '');
}

function collapseSpaces(v){
    return String(v || '').replace(/\s+/g, ' ').trim();
}

function escapeHTML(v){
    return String(v)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}

function escapeAttr(v){
    return escapeHTML(v);
} 
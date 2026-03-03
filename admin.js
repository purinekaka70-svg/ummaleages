import { collection, getDocs, doc, setDoc } from "https://www.gstatic.com/firebasejs/12.10.0/firebase-firestore.js";

document.addEventListener('DOMContentLoaded', ()=>{ initAdmin(); });
const adminMemoryStore = (window.opener && window.opener.__UMMA_DB__)
    || window.__UMMA_DB__
    || (window.__UMMA_DB__ = {});
const DB_KEY_PREFIX = 'umma.db.';
const NON_PERSISTENT_KEYS = new Set([]);
let adminRefreshTimer = null;
const adminWindowFocusRefresh = ()=>{ renderAllAdminData(true); };
let adminRenderInFlight = false;
let adminRenderQueued = false;
let adminRenderForceQueued = false;
const ADMIN_DEFAULT_LEAGUES = [
    {
        id:'umma-premier',
        name:'Umma Premier League',
        desc:'Semester format: round-robin league played over semester weeks, and table ranking decides the winner.'
    },
    {
        id:'umma-champ',
        name:'Umma Champions League',
        desc:'Semester format: league fixtures through semester weeks with top clubs progressing to semester-end playoffs.'
    },
    {
        id:'umma-carabao',
        name:'Umma Carabao Cup',
        desc:'Semester knockout cup. Single-elimination matches are scheduled week by week until the cup final.'
    },
    {
        id:'umma-kajiado',
        name:'Umma Kajiado Cup',
        desc:'Semester regional cup with structured rounds and final ranking/playoff.'
    },
    {
        id:'friendly-league',
        name:'Friendly League',
        desc:'Free opening matches league for preparation fixtures.'
    }
];

function isNonPersistentKey(key){
    return NON_PERSISTENT_KEYS.has(String(key || ''));
}

function readPersistentValue(key){
    if(isNonPersistentKey(key)) return null;
    try{
        return localStorage.getItem(DB_KEY_PREFIX + key);
    } catch {
        return null;
    }
}

function writePersistentValue(key, value){
    if(isNonPersistentKey(key)) return;
    try{
        localStorage.setItem(DB_KEY_PREFIX + key, String(value));
    } catch {
        // Ignore storage errors.
    }
}

function removePersistentValue(key){
    try{
        localStorage.removeItem(DB_KEY_PREFIX + key);
    } catch {
        // Ignore storage errors.
    }
}

function syncMemoryStoreToPersistent(){
    Object.keys(adminMemoryStore).forEach((k)=>{
        writePersistentValue(k, adminMemoryStore[k]);
    });
}

function appUrl(path){
    if(window.ummaNav?.buildAppUrl){
        return window.ummaNav.buildAppUrl(path);
    }
    return new URL(String(path || 'index.html'), window.location.href).toString();
}

async function initAdmin(){
    clearLegacyLocalTeamData();
    syncMemoryStoreToPersistent();
    await hydrateRemoteStore();
    await ensureAdminAuthSeed();
    ensureAdminSeed();
    ensureSemesterCalendarSeed();
    await ensureDefaultLeaguesInFirebase();
    bindAdminMenu();
    bindAdminAuth();
    bindAdminActions();
    hydrateAdminView();
    startRemoteSubscription();
}

function clearLegacyLocalTeamData(){
    const keys = ['teams', 'accounts', 'players'];
    keys.forEach((key)=>{
        delete adminMemoryStore[key];
        try{
            localStorage.removeItem(DB_KEY_PREFIX + key);
            localStorage.removeItem(key);
        } catch {
            // Ignore storage errors.
        }
    });
}

async function ensureAdminAuthSeed(){
    if(!window.ummaAuth?.registerAuthUser || !window.ummaAuth?.logoutAuthUser) return;
    const markerKey = `${DB_KEY_PREFIX}adminAuthSeeded`;
    try{
        if(localStorage.getItem(markerKey) === 'true') return;
    } catch {
        // Ignore storage read errors.
    }
    try{
        await window.ummaAuth.registerAuthUser('admin@umma.local', 'adminpass');
        await window.ummaAuth.logoutAuthUser();
    } catch (err){
        const code = String(err?.code || '');
        if(!code.includes('email-already-in-use')){
            return;
        }
    }
    try{
        localStorage.setItem(markerKey, 'true');
    } catch {
        // Ignore storage write errors.
    }
}

async function hydrateRemoteStore(){
    if(!window.ummaRemoteStore?.loadState) return;
    try{
        const remote = await window.ummaRemoteStore.loadState();
        Object.keys(remote || {}).forEach((key)=>{
            const value = String(remote[key]);
            adminMemoryStore[key] = value;
            if(isNonPersistentKey(key)){
                removePersistentValue(key);
            } else {
                writePersistentValue(key, value);
            }
        });
    } catch {
        // Keep local mode if remote load fails.
    }
}

function applyRemoteState(remote){
    Object.keys(remote || {}).forEach((key)=>{
        const value = String(remote[key]);
        adminMemoryStore[key] = value;
        if(isNonPersistentKey(key)){
            removePersistentValue(key);
        } else {
            writePersistentValue(key, value);
        }
    });
}

async function ensureDefaultLeaguesInFirebase(){
    if(!window.ummaFire?.db) return;
    try{
        await Promise.all(ADMIN_DEFAULT_LEAGUES.map((league)=>
            setDoc(doc(window.ummaFire.db, 'leagues', league.id), {
                id: league.id,
                name: league.name,
                desc: league.desc,
                updatedAtMs: Date.now()
            }, { merge: true })
        ));
    } catch {
        // ignore seed errors
    }
}

async function fetchCollectionFromDb(name){
    if(!window.ummaFire?.db) return [];
    try{
        const snap = await getDocs(collection(window.ummaFire.db, name));
        return snap.docs.map((d)=> ({ ...d.data(), id: d.id }));
    } catch {
        return [];
    }
}

function setMemoryJson(key, value){
    const str = JSON.stringify(value || []);
    adminMemoryStore[key] = str;
    if(isNonPersistentKey(key)){
        removePersistentValue(key);
    } else {
        writePersistentValue(key, str);
    }
}

function normalizeTeamRow(team){
    return {
        ...team,
        teamName: team.teamName || team.name || '',
        league: team.league || '',
        status: team.status || 'Pending Payment',
        coachName: team.coachName || '',
        phone: team.phone || '',
        feePaid: Number(team.feePaid || 0),
        paymentStatus: team.paymentStatus || ''
    };
}

function normalizeFixtureRow(fixture){
    return {
        ...fixture,
        id: fixture.id || '',
        league: fixture.league || '',
        home: fixture.home || '',
        away: fixture.away || '',
        date: fixture.date || '',
        squads: fixture.squads && typeof fixture.squads === 'object' ? fixture.squads : {},
        status: fixture.status || 'Scheduled'
    };
}

function normalizeAccountRow(user){
    return {
        team: user.team || user.teamName || '',
        email: user.email || '',
        role: user.role || 'club'
    };
}

function normalizeLeagueRow(league){
    const fallback = ADMIN_DEFAULT_LEAGUES.find((l)=> l.id === league?.id || l.name === league?.name);
    const id = String(league?.id || fallback?.id || '').trim();
    const name = String(league?.name || fallback?.name || id).trim();
    const desc = String(league?.desc || fallback?.desc || 'Semester competition league').trim();
    return { id: id || slugify(name), name, desc };
}

function getMergedLeagues(){
    const map = new Map();
    ADMIN_DEFAULT_LEAGUES.forEach((league)=>{
        const row = normalizeLeagueRow(league);
        if(row.name) map.set(row.id || row.name, row);
    });
    getJSON('leagues', []).forEach((league)=>{
        const row = normalizeLeagueRow(league);
        if(row.name) map.set(row.id || row.name, row);
    });
    return [...map.values()].sort((a,b)=> String(a.name).localeCompare(String(b.name)));
}

async function hydrateAdminCollectionsFromFirestore(){
    const [leagues, teams, fixtures, standings, players, users] = await Promise.all([
        fetchCollectionFromDb('leagues'),
        fetchCollectionFromDb('teams'),
        fetchCollectionFromDb('fixtures'),
        fetchCollectionFromDb('standings'),
        fetchCollectionFromDb('players'),
        fetchCollectionFromDb('users')
    ]);

    const normalizedLeagues = leagues.map(normalizeLeagueRow).filter((l)=> l.name);
    if(normalizedLeagues.length) setMemoryJson('leagues', normalizedLeagues);
    setMemoryJson('teams', teams.map(normalizeTeamRow));
    setMemoryJson('fixtures', fixtures.map(normalizeFixtureRow));
    setMemoryJson('standings', standings);
    setMemoryJson('players', players);
    setMemoryJson('accounts', users.map(normalizeAccountRow));
}

async function syncAdminFromFirebase(forceReload = false){
    try{
        if(window.ummaRemoteStore){
            const loader = forceReload && window.ummaRemoteStore.reloadState
                ? window.ummaRemoteStore.reloadState
                : window.ummaRemoteStore.loadState;
            const remote = await loader();
            applyRemoteState(remote || {});
        }
        await hydrateAdminCollectionsFromFirestore();
    } catch {
        // Keep currently loaded memory state if refresh fails.
    }
}

function startAdminLiveRefresh(){
    stopAdminLiveRefresh();
    adminRefreshTimer = setInterval(()=>{
        if(document.visibilityState === 'hidden') return;
        adminWindowFocusRefresh();
    }, 7000);
    window.addEventListener('focus', adminWindowFocusRefresh);
}

function stopAdminLiveRefresh(){
    if(adminRefreshTimer){
        clearInterval(adminRefreshTimer);
        adminRefreshTimer = null;
    }
    window.removeEventListener('focus', adminWindowFocusRefresh);
}

function startRemoteSubscription(){
    if(!window.ummaRemoteStore?.subscribeState) return;
    window.ummaRemoteStore.subscribeState((remote)=>{
        applyRemoteState(remote);
        if(sessionStorage.getItem('adminAuth') === 'true'){
            renderAllAdminData();
        }
    });
}

function bindAdminMenu(){
    const hamburgerBtn = document.getElementById('hamburgerBtn');
    const menuPanel = document.getElementById('adminMenuPanel');
    const menuLinks = document.querySelectorAll('.menu-link[data-target]');
    if(hamburgerBtn && menuPanel){
        hamburgerBtn.addEventListener('click', ()=>{
            menuPanel.classList.toggle('open');
        });
    }
    menuLinks.forEach((btn)=>{
        btn.addEventListener('click', ()=>{
            openAdminSection(btn.dataset.target);
            if(menuPanel) menuPanel.classList.remove('open');
        });
    });
}

function bindAdminAuth(){
    const loginBtn = document.getElementById('adminLoginBtn');
    const logoutBtn = document.getElementById('adminLogoutBtn');
    if(loginBtn) loginBtn.addEventListener('click', adminLogin);
    if(logoutBtn) logoutBtn.addEventListener('click', adminLogout);
}

function bindAdminActions(){
    const refreshBtn = document.getElementById('refreshAdminBtn');
    const openSiteBtn = document.getElementById('openSiteBtn');
    const addLeagueBtn = document.getElementById('addLeagueBtn');
    const addFixtureBtn = document.getElementById('addFixtureBtn');
    const saveSemesterBtn = document.getElementById('saveSemesterBtn');
    const autoPlanFixturesBtn = document.getElementById('autoPlanFixturesBtn');
    const planLeagueFixturesBtn = document.getElementById('planLeagueFixturesBtn');
    const fixtureLeagueInput = document.getElementById('fixtureLeagueInput');
    const fixtureDateInput = document.getElementById('fixtureDateInput');
    const planLeagueInput = document.getElementById('planLeagueInput');
    const saveResultBtn = document.getElementById('saveResultBtn');
    const saveHalfTimeBtn = document.getElementById('saveHalfTimeBtn');
    const homeGoalBtn = document.getElementById('homeGoalBtn');
    const awayGoalBtn = document.getElementById('awayGoalBtn');
    const undoGoalBtn = document.getElementById('undoGoalBtn');
    const refreshResultsBtn = document.getElementById('refreshResultsBtn');
    const resultFixtureInput = document.getElementById('resultFixtureInput');
    const carryQualifiedBtn = document.getElementById('carryQualifiedBtn');
    const finishPremierBtn = document.getElementById('finishPremierBtn');
    const teamsBody = document.getElementById('adminTeamsBody');
    const allTeamsBody = document.getElementById('adminAllTeamsBody');
    const leaguesBody = document.getElementById('adminLeaguesBody');
    const fixturesBody = document.getElementById('adminFixturesBody');
    const teamLeagueFilter = document.getElementById('adminTeamLeagueFilter');

    function runButtonAction(btn, action){
        if(!btn) return Promise.resolve(action());
        if(btn.disabled || btn.dataset.busy === 'true') return Promise.resolve();
        btn.dataset.busy = 'true';
        const previousText = btn.textContent;
        btn.disabled = true;
        return Promise.resolve()
            .then(()=> action())
            .finally(()=>{
                btn.disabled = false;
                btn.dataset.busy = 'false';
                if(typeof previousText === 'string') btn.textContent = previousText;
            });
    }

    if(refreshBtn) refreshBtn.addEventListener('click', ()=> runButtonAction(refreshBtn, ()=> renderAllAdminData(true)));
    if(openSiteBtn) openSiteBtn.addEventListener('click', ()=> window.open(appUrl('index.html'), '_blank'));
    if(addLeagueBtn) addLeagueBtn.addEventListener('click', ()=> runButtonAction(addLeagueBtn, addLeague));
    if(addFixtureBtn) addFixtureBtn.addEventListener('click', ()=> runButtonAction(addFixtureBtn, addFixture));
    if(saveSemesterBtn) saveSemesterBtn.addEventListener('click', ()=> runButtonAction(saveSemesterBtn, saveSemesterCalendar));
    if(autoPlanFixturesBtn) autoPlanFixturesBtn.addEventListener('click', ()=> runButtonAction(autoPlanFixturesBtn, autoPlanSemesterFixtures));
    if(planLeagueFixturesBtn) planLeagueFixturesBtn.addEventListener('click', ()=> runButtonAction(planLeagueFixturesBtn, planSelectedLeagueFixtures));
    if(fixtureLeagueInput) fixtureLeagueInput.addEventListener('change', ()=>{
        renderFixtureTeamSuggestions();
        renderPlannerHints();
    });
    if(fixtureDateInput) fixtureDateInput.addEventListener('change', updateManualDayPreview);
    if(planLeagueInput) planLeagueInput.addEventListener('change', renderPlannerHints);
    if(resultFixtureInput) resultFixtureInput.addEventListener('change', renderResultFixtureContext);
    if(saveResultBtn) saveResultBtn.addEventListener('click', ()=> runButtonAction(saveResultBtn, saveFixtureResult));
    if(saveHalfTimeBtn) saveHalfTimeBtn.addEventListener('click', ()=> runButtonAction(saveHalfTimeBtn, saveHalfTimeResult));
    if(homeGoalBtn) homeGoalBtn.addEventListener('click', ()=> runButtonAction(homeGoalBtn, ()=> addGoalEvent('home')));
    if(awayGoalBtn) awayGoalBtn.addEventListener('click', ()=> runButtonAction(awayGoalBtn, ()=> addGoalEvent('away')));
    if(undoGoalBtn) undoGoalBtn.addEventListener('click', ()=> runButtonAction(undoGoalBtn, undoLastGoalEvent));
    if(refreshResultsBtn) refreshResultsBtn.addEventListener('click', ()=>{
        populateResultFixtureInputs();
        renderResultFixtureContext();
    });
    if(carryQualifiedBtn) carryQualifiedBtn.addEventListener('click', ()=> runButtonAction(carryQualifiedBtn, carryQualifiedTeamsToChampions));
    if(finishPremierBtn) finishPremierBtn.addEventListener('click', ()=> runButtonAction(finishPremierBtn, finishPremierLeague));
    if(teamLeagueFilter) teamLeagueFilter.addEventListener('change', ()=>{
        renderTeamTable();
        renderAllTeamsManagementTable();
    });

    if(teamsBody){
        teamsBody.addEventListener('click', (e)=>{
            const btn = e.target.closest('button[data-action]');
            if(!btn) return;
            const teamName = btn.dataset.team;
            const action = btn.dataset.action;
            if(!teamName || !action) return;

            if(action === 'run-team-action'){
                const statusSelect = document.getElementById(`team-status-${slugify(teamName)}`);
                if(!statusSelect) return;
                runButtonAction(btn, ()=> updateTeamStatus(teamName, statusSelect.value));
            }
            if(action === 'mark-paid'){
                runButtonAction(btn, ()=> markTeamPaid(teamName));
            }
            if(action === 'delete'){
                runButtonAction(btn, ()=> deleteTeam(teamName));
            }
        });
    }

    if(allTeamsBody){
        allTeamsBody.addEventListener('click', (e)=>{
            const btn = e.target.closest('button[data-action]');
            if(!btn) return;
            const teamName = btn.dataset.team;
            const action = btn.dataset.action;
            if(!teamName || !action) return;

            if(action === 'all-mark-paid'){
                runButtonAction(btn, ()=> markTeamPaid(teamName));
                return;
            }
            if(action === 'all-activate'){
                runButtonAction(btn, ()=> updateTeamStatus(teamName, 'Active'));
                return;
            }
            if(action === 'all-pending'){
                runButtonAction(btn, ()=> updateTeamStatus(teamName, 'Pending Payment'));
                return;
            }
            if(action === 'all-withdraw'){
                runButtonAction(btn, ()=> updateTeamStatus(teamName, 'Withdrawn'));
                return;
            }
            if(action === 'all-delete'){
                runButtonAction(btn, ()=> deleteTeam(teamName));
            }
        });
    }

    if(leaguesBody){
        leaguesBody.addEventListener('click', (e)=>{
            const btn = e.target.closest('button[data-action]');
            if(!btn) return;
            const leagueName = btn.dataset.league;
            if(!leagueName) return;
            if(btn.dataset.action === 'delete-league'){
                runButtonAction(btn, ()=> deleteLeague(leagueName));
                return;
            }
            if(btn.dataset.action === 'plan-league'){
                runButtonAction(btn, ()=> planLeagueByName(leagueName));
            }
        });
    }

    if(fixturesBody){
        fixturesBody.addEventListener('click', (e)=>{
            const btn = e.target.closest('button[data-action]');
            if(!btn) return;
            const fixtureId = Number(btn.dataset.fixtureId);
            if(!fixtureId) return;
            const action = btn.dataset.action;
            if(action === 'delete-fixture'){
                runButtonAction(btn, ()=> deleteFixture(fixtureId));
                return;
            }
            if(action === 'approve-fixture'){
                runButtonAction(btn, ()=> updateFixtureStatus(fixtureId, 'Approved'));
                return;
            }
            if(action === 'abandon-fixture'){
                runButtonAction(btn, ()=> updateFixtureStatus(fixtureId, 'Abandoned'));
            }
        });
    }
}

function hydrateAdminView(){
    const authed = sessionStorage.getItem('adminAuth') === 'true';
    const hamburgerBtn = document.getElementById('hamburgerBtn');
    const menuPanel = document.getElementById('adminMenuPanel');
    document.getElementById('adminLoginCard').style.display = authed ? 'none' : 'block';
    document.getElementById('adminApp').style.display = authed ? 'block' : 'none';
    if(hamburgerBtn) hamburgerBtn.style.display = authed ? 'inline-block' : 'none';
    if(menuPanel){
        menuPanel.style.display = authed ? '' : 'none';
        if(!authed) menuPanel.classList.remove('open');
    }
    if(authed){
        startAdminLiveRefresh();
        renderAllAdminData();
        openAdminSection('dashboardSection');
    } else {
        stopAdminLiveRefresh();
    }
}

function openAdminSection(sectionId){
    const sectionIds = ['dashboardSection', 'leaguesSection', 'fixturesSection', 'resultsSection', 'teamsSection'];
    sectionIds.forEach((id)=>{
        const section = document.getElementById(id);
        if(section){
            section.style.display = id === sectionId ? 'block' : 'none';
        }
    });

    const menuLinks = document.querySelectorAll('.menu-link[data-target]');
    menuLinks.forEach((link)=>{
        link.classList.toggle('active', link.dataset.target === sectionId);
    });
}

function ensureAdminSeed(){
    const accounts = getJSON('accounts', []);
    const hasAdmin = accounts.some(a=> a.role === 'admin');
    if(!hasAdmin){
        accounts.push({team:'admin', email:'admin@umma.local', role:'admin'});
        setJSON('accounts', accounts);
        return;
    }
    let changed = false;
    accounts.forEach((a)=>{
        if(a.role === 'admin' && !a.email){
            a.email = 'admin@umma.local';
            changed = true;
        }
    });
    if(changed){
        setJSON('accounts', accounts);
    }
}

function ensureSemesterCalendarSeed(){
    const cal = getJSON('semesterCalendar', null);
    if(cal && cal.start && cal.end) return;
    setJSON('semesterCalendar', {
        start: '2026-02-02',
        end: '2026-05-29',
        kickoff: '15:00',
        dayOfWeek: 'saturday',
        mode: 'weekly'
    });
}

function renderSemesterCalendarInputs(){
    const cal = getJSON('semesterCalendar', {start:'', end:'', kickoff:'15:00', dayOfWeek:'saturday', mode:'weekly'});
    const startEl = document.getElementById('semesterStartInput');
    const endEl = document.getElementById('semesterEndInput');
    const dayEl = document.getElementById('semesterDayInput');
    const kickoffEl = document.getElementById('semesterKickoffInput');
    const modeEl = document.getElementById('scheduleModeInput');
    if(startEl) startEl.value = cal.start || '';
    if(endEl) endEl.value = cal.end || '';
    if(dayEl) dayEl.value = cal.dayOfWeek || 'saturday';
    if(kickoffEl) kickoffEl.value = cal.kickoff || '15:00';
    if(modeEl) modeEl.value = cal.mode || 'weekly';
}

function saveSemesterCalendar(){
    const start = document.getElementById('semesterStartInput')?.value;
    const end = document.getElementById('semesterEndInput')?.value;
    const dayOfWeek = document.getElementById('semesterDayInput')?.value || 'saturday';
    const kickoff = document.getElementById('semesterKickoffInput')?.value || '15:00';
    const mode = document.getElementById('scheduleModeInput')?.value || 'weekly';
    if(!start || !end){
        alert('Select semester start and end dates');
        return;
    }
    if(start > end){
        alert('Semester end must be after semester start');
        return;
    }
    setJSON('semesterCalendar', {start, end, dayOfWeek, kickoff, mode});
    alert('Semester calendar saved');
}

    async function adminLogin() {
    const email = document.getElementById('adminEmail').value.trim().toLowerCase();
    const pass = document.getElementById('adminPass').value;

    if (!email || !pass) {
        alert('Enter admin email and password');
        return;
    }

    if (!window.ummaAuth?.loginAuthUser) {
        alert('Authentication service is not ready. Reload and try again.');
        return;
    }

    try {
        // Login using Firebase Auth
        await window.ummaAuth.loginAuthUser(email, pass);

        // Only allow the specific admin account
        if (email !== 'admin@umma.local') {
            await window.ummaAuth.logoutAuthUser();
            alert('Invalid admin credentials');
            return;
        }

        // Successful admin login
        sessionStorage.setItem('adminAuth', 'true');
        hydrateAdminView();
    } catch (err) {
        console.error(err);
        alert('Invalid admin email or password');
    }
}
async function adminLogout(){
    sessionStorage.removeItem('adminAuth');
    if(window.ummaAuth?.logoutAuthUser){
        try{
            await window.ummaAuth.logoutAuthUser();
        } catch {
            // Ignore sign-out errors.
        }
    }
    hydrateAdminView();
}

async function renderAllAdminData(forceReload = false){
    if(adminRenderInFlight){
        adminRenderQueued = true;
        adminRenderForceQueued = adminRenderForceQueued || Boolean(forceReload);
        return;
    }
    adminRenderInFlight = true;
    try{
        await syncAdminFromFirebase(forceReload);
        renderStats();
        renderLeagueTable();
        populateTeamLeagueFilter();
        renderTeamsByLeagueDirectory();
        renderAllTeamsManagementTable();
        renderTeamTable();
        renderFixtureTable();
        populateFixtureInputs();
        renderSemesterCalendarInputs();
        renderPlannerHints();
        populateResultFixtureInputs();
        renderResultFixtureContext();
        renderPremierOutcomePreview();
        updateManualDayPreview();
    } finally {
        adminRenderInFlight = false;
        if(adminRenderQueued){
            const nextForce = adminRenderForceQueued;
            adminRenderQueued = false;
            adminRenderForceQueued = false;
            renderAllAdminData(nextForce);
        }
    }
}

function renderAllTeamsManagementTable(){
    const body = document.getElementById('adminAllTeamsBody');
    if(!body) return;
    const leagueFilter = document.getElementById('adminTeamLeagueFilter')?.value || '';
    const teams = getJSON('teams', [])
        .filter((t)=> leagueFilter && (leagueFilter === '__all__' || t.league === leagueFilter))
        .sort((a,b)=> String(a.league || '').localeCompare(String(b.league || '')) || String(a.teamName || '').localeCompare(String(b.teamName || '')));
    body.innerHTML = '';
    if(!leagueFilter){
        const tr = document.createElement('tr');
        tr.innerHTML = '<td colspan="5" class="muted">Select a league to view registered teams.</td>';
        body.appendChild(tr);
        return;
    }
    if(teams.length === 0){
        const tr = document.createElement('tr');
        tr.innerHTML = '<td colspan="5" class="muted">No registered teams found in selected league.</td>';
        body.appendChild(tr);
        return;
    }
    teams.forEach((t)=>{
        const paymentLabel = getTeamPaymentLabel(t);
        const showMarkPaid = Number(t.feePaid || 0) > 0 && paymentLabel !== 'Paid' && paymentLabel !== 'Free';
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td>${escapeHTML(t.teamName || '-')}</td>
            <td>${escapeHTML(t.league || '-')}</td>
            <td>${escapeHTML(paymentLabel)}</td>
            <td>${escapeHTML(t.status || 'Pending Payment')}</td>
            <td>
                ${showMarkPaid ? `<button class="btn" data-action="all-mark-paid" data-team="${escapeAttr(t.teamName)}">Mark Paid</button>` : ''}
                <button class="btn btn-primary" data-action="all-activate" data-team="${escapeAttr(t.teamName)}">Activate</button>
                <button class="btn" data-action="all-pending" data-team="${escapeAttr(t.teamName)}">Pending</button>
                <button class="btn btn-outline" data-action="all-withdraw" data-team="${escapeAttr(t.teamName)}">Withdraw</button>
                <button class="btn btn-outline danger" data-action="all-delete" data-team="${escapeAttr(t.teamName)}">Delete</button>
            </td>
        `;
        body.appendChild(tr);
    });
}

function renderTeamsByLeagueDirectory(){
    const host = document.getElementById('adminTeamsByLeague');
    if(!host) return;
    const teams = getJSON('teams', []);
    const clubAccounts = getJSON('accounts', []).filter((a)=> a.role === 'club');
    const leagues = getJSON('leagues', []).map((l)=> l.name);
    const grouped = {};

    leagues.forEach((name)=>{ grouped[name] = []; });
    teams.forEach((t)=>{
        const leagueName = t.league || 'Unassigned';
        if(!grouped[leagueName]) grouped[leagueName] = [];
        grouped[leagueName].push(t);
    });

    const entries = Object.entries(grouped)
        .filter(([, list])=> list.length > 0)
        .sort((a,b)=> String(a[0]).localeCompare(String(b[0])));

    if(entries.length === 0){
        host.className = 'muted';
        host.textContent = `No teams registered yet. Club accounts found: ${clubAccounts.length}.`;
        return;
    }

    host.className = '';
    const mismatchNote = clubAccounts.length !== teams.length
        ? `<div class="muted" style="margin-bottom:8px">Note: Club accounts (${clubAccounts.length}) and teams (${teams.length}) are not equal.</div>`
        : '';
    host.innerHTML = mismatchNote + entries.map(([leagueName, list])=>{
        const names = list
            .map((t)=> `${escapeHTML(t.teamName)} (${escapeHTML(t.status || 'Pending Payment')})`)
            .join(', ');
        return `<div style="margin-bottom:6px"><button class="btn btn-outline" data-action="filter-league" data-league="${escapeAttr(leagueName)}">${escapeHTML(leagueName)} (${list.length})</button>: ${names}</div>`;
    }).join('');
    host.querySelectorAll('button[data-action="filter-league"]').forEach((btn)=>{
        btn.addEventListener('click', ()=>{
            const league = btn.dataset.league || '';
            setTeamLeagueFilter(league);
        });
    });
}

function renderStats(){
    const leagues = getMergedLeagues();
    const teams = getJSON('teams', []);
    const fixtures = getJSON('fixtures', []);
    const players = getJSON('players', []);
    const accounts = getJSON('accounts', []).filter(a=> a.role === 'club');
    setText('statLeagues', leagues.length);
    setText('statTeams', teams.length);
    setText('statFixtures', fixtures.length);
    setText('statPlayers', players.length);
    setText('statAccounts', accounts.length);
}

function renderLeagueTable(){
    const body = document.getElementById('adminLeaguesBody');
    if(!body) return;
    const leagues = getMergedLeagues();
    body.innerHTML = '';
    leagues.forEach((l)=>{
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td>${escapeHTML(l.name)}</td>
            <td>${escapeHTML(l.desc || '-')}</td>
            <td>
                <div class="action-row">
                    <button class="btn" data-action="plan-league" data-league="${escapeAttr(l.name)}">Plan Fixtures</button>
                    <button class="btn btn-outline danger" data-action="delete-league" data-league="${escapeAttr(l.name)}">Delete</button>
                </div>
            </td>
        `;
        body.appendChild(tr);
    });
}

function populateTeamLeagueFilter(){
    const sel = document.getElementById('adminTeamLeagueFilter');
    if(!sel) return;
    const leagueSet = new Set(getMergedLeagues().map((l)=> l.name).filter(Boolean));
    getJSON('teams', []).forEach((t)=>{
        const leagueName = String(t?.league || '').trim();
        if(leagueName) leagueSet.add(leagueName);
    });
    const leagues = [...leagueSet].sort((a,b)=> String(a).localeCompare(String(b)));
    const previous = sel.value || '';
    sel.innerHTML = '';
    sel.appendChild(new Option('Select league', ''));
    sel.appendChild(new Option('All Leagues', '__all__'));
    leagues.forEach((league)=> sel.appendChild(new Option(league, league)));
    if(leagues.includes(previous) || previous === '__all__' || previous === ''){
        sel.value = previous;
    } else {
        sel.value = '';
    }
}

function setTeamLeagueFilter(league){
    const sel = document.getElementById('adminTeamLeagueFilter');
    if(!sel) return;
    const value = String(league || '');
    if([...sel.options].some((o)=> o.value === value)){
        sel.value = value;
    } else {
        sel.value = '';
    }
    renderTeamTable();
    renderAllTeamsManagementTable();
}

function renderTeamTable(){
    const body = document.getElementById('adminTeamsBody');
    if(!body) return;
    const leagueFilter = document.getElementById('adminTeamLeagueFilter')?.value || '';
    const teams = getJSON('teams', [])
        .filter((t)=> leagueFilter && (leagueFilter === '__all__' || t.league === leagueFilter));
    body.innerHTML = '';
    if(!leagueFilter){
        const tr = document.createElement('tr');
        tr.innerHTML = '<td colspan="9" class="muted">Select a league to view registered teams.</td>';
        body.appendChild(tr);
        return;
    }
    if(teams.length === 0){
        const tr = document.createElement('tr');
        tr.innerHTML = '<td colspan="9" class="muted">No teams found for selected league.</td>';
        body.appendChild(tr);
        return;
    }
    teams.forEach((t)=>{
        const id = slugify(t.teamName);
        const statusId = `team-status-${id}`;
        const paymentLabel = getTeamPaymentLabel(t);
        const showMarkPaid = Number(t.feePaid || 0) > 0 && paymentLabel !== 'Paid' && paymentLabel !== 'Free';
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td>${escapeHTML(t.teamName)}</td>
            <td>${escapeHTML(t.league || '-')}</td>
            <td>${escapeHTML(t.semester || '-')}</td>
            <td>${escapeHTML(t.mpesaRef || '-')}</td>
            <td>${escapeHTML(t.coachName || '-')}</td>
            <td>${escapeHTML(t.phone || '-')}</td>
            <td>${escapeHTML(paymentLabel)}</td>
            <td>
                <select id="${statusId}">
                    ${statusOptions(t.status || 'Pending Payment')}
                </select>
            </td>
            <td>
                <button class="btn btn-primary" data-action="run-team-action" data-team="${escapeAttr(t.teamName)}">Save</button>
                ${showMarkPaid ? `<button class="btn" data-action="mark-paid" data-team="${escapeAttr(t.teamName)}">Mark Paid</button>` : ''}
                <button class="btn btn-outline danger" data-action="delete" data-team="${escapeAttr(t.teamName)}">Delete</button>
            </td>
        `;
        body.appendChild(tr);
    });
}

function renderFixtureTable(){
    const body = document.getElementById('adminFixturesBody');
    if(!body) return;
    const fixtures = getJSON('fixtures', []).sort((a,b)=> String(a.date).localeCompare(String(b.date)));
    body.innerHTML = '';
    fixtures.forEach((f)=>{
        const status = f.status || 'Scheduled';
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td>${escapeHTML(f.league)}</td>
            <td>${escapeHTML(f.home)} vs ${escapeHTML(f.away)}</td>
            <td>${escapeHTML(f.date)}</td>
            <td>${escapeHTML(status)}</td>
            <td>
                <button class="btn btn-primary" data-action="approve-fixture" data-fixture-id="${f.id}">Approve</button>
                <button class="btn btn-outline" data-action="abandon-fixture" data-fixture-id="${f.id}">Abandon</button>
                <button class="btn btn-outline danger" data-action="delete-fixture" data-fixture-id="${f.id}">Delete</button>
            </td>
        `;
        body.appendChild(tr);
    });
}

function populateFixtureInputs(){
    const leagues = getMergedLeagues();
    const leagueSel = document.getElementById('fixtureLeagueInput');
    const planLeagueSel = document.getElementById('planLeagueInput');
    const currentFixtureLeague = leagueSel?.value || '';
    const currentPlanLeague = planLeagueSel?.value || '';
    if(leagueSel){
        leagueSel.innerHTML = '';
        leagues.forEach((l)=> leagueSel.appendChild(new Option(l.name, l.name)));
        if(currentFixtureLeague && leagues.some(l=> l.name === currentFixtureLeague)){
            leagueSel.value = currentFixtureLeague;
        }
    }
    if(planLeagueSel){
        planLeagueSel.innerHTML = '';
        leagues.forEach((l)=> planLeagueSel.appendChild(new Option(l.name, l.name)));
        if(currentPlanLeague && leagues.some(l=> l.name === currentPlanLeague)){
            planLeagueSel.value = currentPlanLeague;
        }
    }
    renderFixtureTeamSuggestions();
}

function renderFixtureTeamSuggestions(){
    const league = document.getElementById('fixtureLeagueInput')?.value;
    const list = document.getElementById('fixtureTeamList');
    const leagueTeams = getLeagueTeamObjects(league);
    if(!list) return;
    list.innerHTML = '';
    leagueTeams.forEach((t)=> list.appendChild(new Option(t.teamName, t.teamName)));
}

function renderPlannerHints(){
    const planLeague = document.getElementById('planLeagueInput')?.value;
    const fixtureLeague = document.getElementById('fixtureLeagueInput')?.value;
    const planHint = document.getElementById('planLeagueHint');
    const manualHint = document.getElementById('manualFixtureHint');

    if(planHint && planLeague){
        const names = getLeagueTeamNames(planLeague);
        const cal = getJSON('semesterCalendar', {dayOfWeek:'saturday', kickoff:'15:00', mode:'weekly'});
        planHint.textContent = names.length >= 2
            ? `Planning ${planLeague}: ${names.length} registered teams will be used (${names.join(', ')}). Day: ${cal.dayOfWeek}, Time: ${cal.kickoff}, Mode: ${cal.mode}.`
            : `Planning ${planLeague}: need at least 2 registered teams (current: ${names.length}).`;
    }

    if(manualHint && fixtureLeague){
        const names = getLeagueTeamNames(fixtureLeague);
        manualHint.textContent = names.length > 0
            ? `Manual fixture teams for ${fixtureLeague}: ${names.join(', ')}`
            : `No registered teams in ${fixtureLeague} yet.`;
    }
}

function updateManualDayPreview(){
    const dateYmd = document.getElementById('fixtureDateInput')?.value;
    const dayPreview = document.getElementById('fixtureDayPreview');
    if(!dayPreview) return;
    if(!dateYmd){
        dayPreview.value = '';
        return;
    }
    const d = toDate(dateYmd);
    if(!d){
        dayPreview.value = '';
        return;
    }
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    dayPreview.value = days[d.getDay()];
}

async function addLeague(){
    const rawName = document.getElementById('leagueNameInput').value.trim();
    const descInput = document.getElementById('leagueDescInput').value.trim();
    const name = collapseSpaces(rawName);
    if(!name){
        alert('Enter league name');
        return;
    }
    if(name.length < 4){
        alert('League name is too short');
        return;
    }
    const leagues = getJSON('leagues', []);
    if(leagues.some(l=> collapseSpaces(l.name).toLowerCase() === name.toLowerCase())){
        alert('League already exists');
        return;
    }
    const desc = collapseSpaces(descInput) || 'Semester format: fixtures are scheduled week-by-week through the semester.';
    const id = slugify(name);
    if(window.ummaFire?.db){
        try{
            await setDoc(doc(window.ummaFire.db, 'leagues', id), {
                id,
                name,
                desc,
                updatedAtMs: Date.now()
            }, { merge: true });
        } catch {
            alert('Failed to save league to Firebase');
            return;
        }
    } else {
        leagues.push({id, name, desc});
        setJSON('leagues', leagues);
    }
    document.getElementById('leagueNameInput').value = '';
    document.getElementById('leagueDescInput').value = '';
    await renderAllAdminData(true);
}

function addFixture(){
    const league = document.getElementById('fixtureLeagueInput').value;
    const home = collapseSpaces(document.getElementById('fixtureHomeInput').value);
    const away = collapseSpaces(document.getElementById('fixtureAwayInput').value);
    const dateYmd = document.getElementById('fixtureDateInput').value;
    const timeHm = document.getElementById('fixtureTimeInput').value || '15:00';
    if(!league || !home || !away || !dateYmd || !timeHm){
        alert('Fill all fixture fields');
        return;
    }
    if(home === away){
        alert('Home and away teams must differ');
        return;
    }
    const cal = getJSON('semesterCalendar', null);
    if(cal?.start && cal?.end){
        if(dateYmd < cal.start || dateYmd > cal.end){
            alert(`Fixture date must be inside semester (${cal.start} to ${cal.end})`);
            return;
        }
    }

    const leagueTeams = getLeagueTeamObjects(league);
    const homeTeam = leagueTeams.find(t=> t.teamName.toLowerCase() === home.toLowerCase());
    const awayTeam = leagueTeams.find(t=> t.teamName.toLowerCase() === away.toLowerCase());
    if(!homeTeam || !awayTeam){
        alert('Selected teams are invalid for this league');
        return;
    }
    const homeName = homeTeam.teamName;
    const awayName = awayTeam.teamName;

    const date = `${dateYmd} ${timeHm}`;
    const fixtures = getJSON('fixtures', []);
    const dup = fixtures.some((f)=>{
        const sameLeague = f.league === league;
        const samePair = (f.home === homeName && f.away === awayName) || (f.home === awayName && f.away === homeName);
        const sameDate = String(f.date) === date;
        return sameLeague && samePair && sameDate;
    });
    if(dup){
        alert('This fixture already exists');
        return;
    }
    fixtures.push({id: Date.now() + Math.floor(Math.random() * 1000), league, home: homeName, away: awayName, date, squads:{}, status:'Scheduled'});
    setJSON('fixtures', fixtures);
    document.getElementById('fixtureHomeInput').value = '';
    document.getElementById('fixtureAwayInput').value = '';
    document.getElementById('fixtureDateInput').value = '';
    document.getElementById('fixtureTimeInput').value = '15:00';
    updateManualDayPreview();
    renderAllAdminData();
}

function autoPlanSemesterFixtures(){
    const cal = getJSON('semesterCalendar', null);
    if(!cal || !cal.start || !cal.end){
        alert('Save semester calendar first');
        return;
    }
    const leagues = getJSON('leagues', []);
    const teams = getJSON('teams', []);
    if(leagues.length === 0 || teams.length === 0){
        alert('Add leagues and teams first');
        return;
    }

    const replace = confirm('This will replace all current fixtures with semester-planned fixtures. Continue?');
    if(!replace) return;

    const planned = planFixturesForLeagues(leagues.map(l=> l.name), cal, teams);

    setJSON('fixtures', planned);
    renderAllAdminData();
    alert(`Fixtures planned successfully: ${planned.length}`);
}

function planLeagueByName(leagueName){
    const planLeagueSel = document.getElementById('planLeagueInput');
    if(planLeagueSel) planLeagueSel.value = leagueName;
    planSelectedLeagueFixtures();
}

function planSelectedLeagueFixtures(){
    const leagueName = document.getElementById('planLeagueInput')?.value;
    if(!leagueName){
        alert('Select a league to plan');
        return;
    }
    const cal = getJSON('semesterCalendar', null);
    if(!cal || !cal.start || !cal.end){
        alert('Save semester calendar first');
        return;
    }
    const teams = getJSON('teams', []);
    const leagueTeams = getLeagueTeamNames(leagueName);
    if(leagueTeams.length < 2){
        alert(`Cannot plan ${leagueName}: need at least 2 registered teams in that league.`);
        return;
    }
    const allFixtures = getJSON('fixtures', []);
    const keepFixtures = allFixtures.filter(f=> f.league !== leagueName);
    const plannedLeague = planFixturesForLeagues([leagueName], cal, teams);
    setJSON('fixtures', [...keepFixtures, ...plannedLeague]);
    renderAllAdminData();
    alert(`Planned ${plannedLeague.length} fixtures for ${leagueName}`);
}

function planFixturesForLeagues(leagueNames, cal, teams){
    let fixtureId = Date.now();
    const planned = [];
    leagueNames.forEach((leagueName, leagueIndex)=>{
        const leagueTeams = teams
            .filter(t=> t.league === leagueName && (t.status || 'Pending Payment') !== 'Withdrawn')
            .map(t=> t.teamName)
            .sort((a,b)=> a.localeCompare(b));
        if(leagueTeams.length < 2) return;

        const pairs = buildPairs(leagueTeams);
        const dates = generateSemesterSlots(
            cal.start,
            cal.end,
            pairs.length,
            leagueIndex,
            cal.mode || 'weekly',
            cal.dayOfWeek || 'saturday'
        );
        pairs.forEach((pair, idx)=>{
            const dateObj = dates[idx];
            if(!dateObj) return;
            planned.push({
                id: fixtureId++,
                league: leagueName,
                home: pair.home,
                away: pair.away,
                date: `${formatYmd(dateObj)} ${cal.kickoff || '15:00'}`,
                squads: {},
                status: 'Scheduled'
            });
        });
    });
    return planned;
}

function populateResultFixtureInputs(){
    const fixtureSel = document.getElementById('resultFixtureInput');
    const hint = document.getElementById('resultHint');
    if(!fixtureSel) return;
    const fixtures = getJSON('fixtures', [])
        .sort((a,b)=> String(a.date).localeCompare(String(b.date)));
    const prev = fixtureSel.value;
    fixtureSel.innerHTML = '';
    fixtures.forEach((f)=>{
        const status = f.status || 'Scheduled';
        fixtureSel.appendChild(new Option(`${f.league}: ${f.home} vs ${f.away} (${f.date}) [${status}]`, String(f.id)));
    });
    if(prev && fixtures.some(f=> String(f.id) === String(prev))){
        fixtureSel.value = prev;
    }
    if(hint){
        hint.textContent = fixtures.length
            ? 'Select a fixture, add live goal events, save first half or full time, and standings will auto-update.'
            : 'No fixtures available yet.';
    }
}

function renderResultFixtureContext(){
    const fixtureId = Number(document.getElementById('resultFixtureInput')?.value);
    const fixtures = getJSON('fixtures', []);
    const fixture = fixtures.find(f=> Number(f.id) === fixtureId);
    const teamsLabel = document.getElementById('resultTeamsLabel');
    const currentScoreInput = document.getElementById('currentScoreInput');
    const currentStatusInput = document.getElementById('currentStatusInput');
    const hint = document.getElementById('resultHint');
    if(!fixture){
        if(teamsLabel) teamsLabel.textContent = '';
        if(currentScoreInput) currentScoreInput.value = '';
        if(currentStatusInput) currentStatusInput.value = '';
        if(hint) hint.textContent = 'No fixture selected.';
        renderGoalEvents([]);
        return;
    }
    if(teamsLabel) teamsLabel.textContent = `${fixture.league}: ${fixture.home} vs ${fixture.away}`;
    const current = extractScore(fixture.result);
    const outcome = getOutcomeFromScore(fixture, current);
    if(currentScoreInput) currentScoreInput.value = `${fixture.home} ${current.homeGoals} - ${current.awayGoals} ${fixture.away}`;
    if(currentStatusInput) currentStatusInput.value = fixture.status || 'Scheduled';
    if(hint){
        const status = fixture.status || 'Scheduled';
        const firstHalf = extractFirstHalfScore(fixture.result);
        hint.textContent = `Status: ${status}. Live score: ${fixture.home} ${current.homeGoals} - ${current.awayGoals} ${fixture.away}. Outcome: ${outcome}. First half: ${firstHalf.homeGoals}-${firstHalf.awayGoals}.`;
    }
    renderGoalEvents(Array.isArray(fixture.result?.events) ? fixture.result.events : []);
}

function saveHalfTimeResult(){
    const fixtureId = Number(document.getElementById('resultFixtureInput')?.value);
    if(!fixtureId){
        alert('Select a fixture');
        return;
    }
    const fixtures = getJSON('fixtures', []);
    const idx = fixtures.findIndex(f=> Number(f.id) === fixtureId);
    if(idx === -1){
        alert('Fixture not found');
        return;
    }
    const fixture = fixtures[idx];
    const previous = fixtures[idx].result || {};
    const current = extractScore(previous);
    const events = Array.isArray(previous.events) ? previous.events : [];
    fixtures[idx].result = {
        ...previous,
        firstHalf: {homeGoals: current.homeGoals, awayGoals: current.awayGoals},
        fullTime: {homeGoals: current.homeGoals, awayGoals: current.awayGoals},
        events
    };
    fixtures[idx].status = 'Half Time';
    setJSON('fixtures', fixtures);
    recomputeStandingsForLeague(fixture.league);
    renderAllAdminData();
    alert('First-half result saved');
}

function saveFixtureResult(){
    const fixtureId = Number(document.getElementById('resultFixtureInput')?.value);
    if(!fixtureId){
        alert('Select a fixture');
        return;
    }

    const fixtures = getJSON('fixtures', []);
    const idx = fixtures.findIndex(f=> Number(f.id) === fixtureId);
    if(idx === -1){
        alert('Fixture not found');
        return;
    }
    const fixture = fixtures[idx];
    const previous = fixtures[idx].result || {};
    const current = extractScore(previous);
    const homeGoals = Number(current.homeGoals);
    const awayGoals = Number(current.awayGoals);
    const outcome = getOutcomeFromScore(fixture, {homeGoals, awayGoals});
    fixtures[idx].result = {
        ...previous,
        firstHalf: previous.firstHalf || {homeGoals: 0, awayGoals: 0},
        fullTime: {homeGoals, awayGoals},
        events: Array.isArray(previous.events) ? previous.events : [],
        outcome
    };
    fixtures[idx].status = 'Played';
    setJSON('fixtures', fixtures);

    recomputeStandingsForLeague(fixture.league);
    renderAllAdminData();
    alert(`Full-time result saved. Outcome: ${outcome}`);
}

function addGoalEvent(side){
    const fixtureId = Number(document.getElementById('resultFixtureInput')?.value);
    const minuteInput = Number(document.getElementById('goalMinuteInput')?.value);
    const scorerInput = collapseSpaces(document.getElementById('goalScorerInput')?.value || '');
    if(!fixtureId){
        alert('Select a fixture first');
        return;
    }
    const fixtures = getJSON('fixtures', []);
    const idx = fixtures.findIndex(f=> Number(f.id) === fixtureId);
    if(idx === -1){
        alert('Fixture not found');
        return;
    }
    const fixture = fixtures[idx];
    if(side !== 'home' && side !== 'away'){
        alert('Choose Home Goal or Away Goal');
        return;
    }
    const team = side === 'home' ? fixture.home : fixture.away;
    const minute = Number.isFinite(minuteInput) && minuteInput >= 1 && minuteInput <= 130
        ? minuteInput
        : inferNextMinute(fixtures[idx].result);
    const scorer = scorerInput || 'Unknown';
    const previous = fixtures[idx].result || {};
    const events = Array.isArray(previous.events) ? [...previous.events] : [];
    events.push({
        minute,
        team,
        scorer,
        half: minute <= 45 ? 'First Half' : 'Second Half'
    });
    events.sort((a,b)=> Number(a.minute) - Number(b.minute));

    const scoreFromEvents = getScoreFromEvents(events, fixture.home, fixture.away);
    const outcome = getOutcomeFromScore(fixture, scoreFromEvents);
    fixtures[idx].result = {
        ...previous,
        events,
        fullTime: {homeGoals: scoreFromEvents.homeGoals, awayGoals: scoreFromEvents.awayGoals},
        firstHalf: {
            homeGoals: events.filter(e=> e.minute <= 45 && e.team === fixture.home).length,
            awayGoals: events.filter(e=> e.minute <= 45 && e.team === fixture.away).length
        },
        outcome
    };
    fixtures[idx].status = 'In Progress';
    setJSON('fixtures', fixtures);
    recomputeStandingsForLeague(fixture.league);
    renderAllAdminData();
    document.getElementById('goalScorerInput').value = '';
    document.getElementById('goalMinuteInput').value = '';
}

function undoLastGoalEvent(){
    const fixtureId = Number(document.getElementById('resultFixtureInput')?.value);
    if(!fixtureId){
        alert('Select a fixture first');
        return;
    }
    const fixtures = getJSON('fixtures', []);
    const idx = fixtures.findIndex(f=> Number(f.id) === fixtureId);
    if(idx === -1){
        alert('Fixture not found');
        return;
    }
    const fixture = fixtures[idx];
    const previous = fixture.result || {};
    const events = Array.isArray(previous.events) ? [...previous.events] : [];
    if(events.length === 0){
        alert('No goals to undo');
        return;
    }
    events.pop();
    const scoreFromEvents = getScoreFromEvents(events, fixture.home, fixture.away);
    const outcome = getOutcomeFromScore(fixture, scoreFromEvents);
    fixtures[idx].result = {
        ...previous,
        events,
        fullTime: {homeGoals: scoreFromEvents.homeGoals, awayGoals: scoreFromEvents.awayGoals},
        firstHalf: {
            homeGoals: events.filter(e=> e.minute <= 45 && e.team === fixture.home).length,
            awayGoals: events.filter(e=> e.minute <= 45 && e.team === fixture.away).length
        },
        outcome
    };
    if(events.length){
        fixtures[idx].status = 'In Progress';
    } else {
        fixtures[idx].status = 'Scheduled';
        delete fixtures[idx].result;
    }
    setJSON('fixtures', fixtures);
    recomputeStandingsForLeague(fixture.league);
    renderAllAdminData();
}

function inferNextMinute(result){
    const events = Array.isArray(result?.events) ? result.events : [];
    if(events.length === 0) return 1;
    const maxMinute = events.reduce((m, e)=> Math.max(m, Number(e.minute) || 0), 0);
    return Math.min(130, Math.max(1, maxMinute + 1));
}

function renderGoalEvents(events){
    const body = document.getElementById('goalEventsBody');
    if(!body) return;
    body.innerHTML = '';
    events.forEach((e)=>{
        const tr = document.createElement('tr');
        tr.innerHTML = `<td>${escapeHTML(String(e.minute))}</td><td>${escapeHTML(e.team || '-')}</td><td>${escapeHTML(e.scorer || '-')}</td><td>${escapeHTML(e.half || '-')}</td>`;
        body.appendChild(tr);
    });
}

function getScoreFromEvents(events, homeTeam, awayTeam){
    let homeGoals = 0;
    let awayGoals = 0;
    events.forEach((e)=>{
        if(e.team === homeTeam) homeGoals += 1;
        if(e.team === awayTeam) awayGoals += 1;
    });
    return {homeGoals, awayGoals};
}

function getOutcomeFromScore(fixture, score){
    const homeGoals = Number(score?.homeGoals ?? 0);
    const awayGoals = Number(score?.awayGoals ?? 0);
    if(homeGoals > awayGoals) return `${fixture.home} Win`;
    if(awayGoals > homeGoals) return `${fixture.away} Win`;
    return 'Draw';
}

function extractScore(result){
    if(!result) return {homeGoals: 0, awayGoals: 0};
    if(result.fullTime && Number.isFinite(Number(result.fullTime.homeGoals)) && Number.isFinite(Number(result.fullTime.awayGoals))){
        return {homeGoals: Number(result.fullTime.homeGoals), awayGoals: Number(result.fullTime.awayGoals)};
    }
    if(Number.isFinite(Number(result.homeGoals)) && Number.isFinite(Number(result.awayGoals))){
        return {homeGoals: Number(result.homeGoals), awayGoals: Number(result.awayGoals)};
    }
    return {homeGoals: 0, awayGoals: 0};
}

function extractFirstHalfScore(result){
    if(!result) return {homeGoals: 0, awayGoals: 0};
    if(result.firstHalf && Number.isFinite(Number(result.firstHalf.homeGoals)) && Number.isFinite(Number(result.firstHalf.awayGoals))){
        return {homeGoals: Number(result.firstHalf.homeGoals), awayGoals: Number(result.firstHalf.awayGoals)};
    }
    return {homeGoals: 0, awayGoals: 0};
}

function carryQualifiedTeamsToChampions(quiet = false){
    const sourceLeague = 'Umma Premier League';
    const targetLeague = 'Umma Champions League';
    const standings = getPremierStandingsSorted();
    if(standings.length === 0){
        if(!quiet) alert(`No standings found for ${sourceLeague}`);
        return;
    }
    const qualified = standings.slice(0, 6).map((s)=> s.team).filter(Boolean);
    if(qualified.length === 0){
        if(!quiet) alert('No qualified teams found');
        return;
    }

    const teams = getJSON('teams', []);
    const currentSemester = getCurrentSemesterLabel();
    let added = 0;
    qualified.forEach((teamName)=>{
        const existingInTarget = teams.find((t)=> t.teamName === teamName && t.league === targetLeague);
        if(existingInTarget) return;
        const sourceTeam = teams.find((t)=> t.teamName === teamName && t.league === sourceLeague);
        teams.push({
            teamName,
            coachName: sourceTeam?.coachName || '',
            phone: sourceTeam?.phone || '',
            league: targetLeague,
            status: 'Pending Payment',
            semester: currentSemester,
            mpesaRef: '',
            qualifiedFrom: sourceLeague
        });
        added += 1;
    });

    if(added === 0){
        if(!quiet) alert('All top 6 teams are already in Umma Champions League.');
        return;
    }
    setJSON('teams', teams);
    renderAllAdminData();
    if(!quiet){
        alert(`Qualified teams carried forward to ${targetLeague}: ${added} added (semester: ${currentSemester}).`);
    }
}

function getCurrentSemesterLabel(){
    const cal = getJSON('semesterCalendar', null);
    if(!cal?.start || !cal?.end) return 'Current Semester';
    return `${cal.start} to ${cal.end}`;
}

function getPremierStandingsSorted(){
    return getJSON('standings', [])
        .filter((s)=> s.league === 'Umma Premier League')
        .sort((a,b)=> Number(b.pts) - Number(a.pts) || Number(b.gd) - Number(a.gd));
}

function getRelegatedCount(size){
    if(size >= 10) return 3;
    if(size >= 8) return 2;
    if(size >= 6) return 1;
    return 0;
}

function renderPremierOutcomePreview(){
    const topSixEl = document.getElementById('premierTopSixPreview');
    const relegatedEl = document.getElementById('premierRelegatedPreview');
    if(!topSixEl || !relegatedEl) return;
    const standings = getPremierStandingsSorted();
    if(standings.length === 0){
        topSixEl.textContent = '-';
        relegatedEl.textContent = '-';
        return;
    }
    const topSix = standings.slice(0, 6).map((s)=> s.team);
    const relegatedCount = getRelegatedCount(standings.length);
    const relegated = relegatedCount > 0 ? standings.slice(-relegatedCount).map((s)=> s.team) : [];
    topSixEl.textContent = topSix.length ? topSix.join(', ') : '-';
    relegatedEl.textContent = relegated.length ? relegated.join(', ') : '-';
}

function finishPremierLeague(){
    const standings = getPremierStandingsSorted();
    if(standings.length === 0){
        alert('No Premier League standings found. Enter results first.');
        return;
    }
    const topSix = standings.slice(0, 6).map((s)=> s.team);
    const relegatedCount = getRelegatedCount(standings.length);
    const relegated = relegatedCount > 0 ? standings.slice(-relegatedCount).map((s)=> s.team) : [];

    carryQualifiedTeamsToChampions(true);

    const teams = getJSON('teams', []);
    teams.forEach((t)=>{
        if(t.league === 'Umma Premier League' && relegated.includes(t.teamName)){
            t.status = 'Relegated';
            t.relegatedFrom = 'Umma Premier League';
        }
    });
    setJSON('teams', teams);
    renderAllAdminData();
    alert(`Premier League finished. Qualified: ${topSix.join(', ')}. Relegated: ${relegated.length ? relegated.join(', ') : 'None'}.`);
}

function recomputeStandingsForLeague(leagueName){
    const teams = getJSON('teams', [])
        .filter(t=> t.league === leagueName && (t.status || 'Pending Payment') !== 'Withdrawn')
        .map(t=> t.teamName);
    const table = {};
    teams.forEach((team)=>{
        table[team] = {league: leagueName, team, p:0, w:0, d:0, l:0, gd:0, pts:0};
    });

    const fixtures = getJSON('fixtures', [])
        .filter(f=> f.league === leagueName && f.result && (f.status === 'In Progress' || f.status === 'Half Time' || f.status === 'Played'))
        .filter(f=>{
            const score = extractScore(f.result);
            return Number.isFinite(score.homeGoals) && Number.isFinite(score.awayGoals);
        });

    fixtures.forEach((f)=>{
        const score = extractScore(f.result);
        const hg = Number(score.homeGoals);
        const ag = Number(score.awayGoals);
        if(!table[f.home]) table[f.home] = {league: leagueName, team:f.home, p:0, w:0, d:0, l:0, gd:0, pts:0};
        if(!table[f.away]) table[f.away] = {league: leagueName, team:f.away, p:0, w:0, d:0, l:0, gd:0, pts:0};

        table[f.home].p += 1;
        table[f.away].p += 1;
        table[f.home].gd += (hg - ag);
        table[f.away].gd += (ag - hg);

        if(hg > ag){
            table[f.home].w += 1; table[f.home].pts += 3;
            table[f.away].l += 1;
        } else if(ag > hg){
            table[f.away].w += 1; table[f.away].pts += 3;
            table[f.home].l += 1;
        } else {
            table[f.home].d += 1; table[f.home].pts += 1;
            table[f.away].d += 1; table[f.away].pts += 1;
        }
    });

    const standings = getJSON('standings', []);
    const withoutLeague = standings.filter(s=> s.league !== leagueName);
    const rebuilt = Object.values(table);
    setJSON('standings', [...withoutLeague, ...rebuilt]);
}


function getLeagueTeamObjects(leagueName){
    return getJSON('teams', [])
        .filter(t=> t.league === leagueName && (t.status || 'Pending Payment') !== 'Withdrawn')
        .sort((a,b)=> tName(a).localeCompare(tName(b)));
}

function getLeagueTeamNames(leagueName){
    return getLeagueTeamObjects(leagueName).map(t=> t.teamName);
}

function tName(t){
    return String(t?.teamName || '');
}

function buildPairs(teamNames){
    const pairs = [];
    for(let i = 0; i < teamNames.length; i++){
        for(let j = i + 1; j < teamNames.length; j++){
            pairs.push({home: teamNames[i], away: teamNames[j]});
        }
    }
    return pairs;
}

function generateSemesterSlots(startYmd, endYmd, needed, leagueOffsetDays, mode, dayOfWeek){
    const slots = [];
    const start = toDate(startYmd);
    const end = toDate(endYmd);
    if(!start || !end || needed <= 0) return slots;

    const shiftedStart = new Date(start);
    shiftedStart.setDate(shiftedStart.getDate() + (leagueOffsetDays % 5));
    const modeValue = (mode || 'weekly').toLowerCase();
    const preferredDay = weekdayToIndex(dayOfWeek);
    const intervalDays = modeValue === 'hybrid' ? 4 : 7;

    let cursor = nextWeekdayOnOrAfter(shiftedStart, preferredDay);
    while(slots.length < needed && cursor <= end){
        const day = cursor.getDay(); // 0 Sun, 6 Sat
        const weekend = day === 0 || day === 6;
        const pick =
            modeValue === 'weekend' ? weekend :
            modeValue === 'hybrid' ? (weekend || day === 3) :
            true;

        if(pick){
            slots.push(new Date(cursor));
        }
        cursor.setDate(cursor.getDate() + intervalDays);
    }

    while(slots.length < needed){
        const fallback = slots.length > 0 ? new Date(slots[slots.length - 1]) : new Date(end);
        fallback.setDate(fallback.getDate() + 1);
        if(fallback > end){
            const clamp = new Date(end);
            clamp.setDate(end.getDate() - ((needed - 1 - slots.length) % 2));
            slots.push(clamp);
        } else {
            slots.push(fallback);
        }
    }
    return slots;
}

function weekdayToIndex(dayName){
    const map = {
        sunday: 0,
        monday: 1,
        tuesday: 2,
        wednesday: 3,
        thursday: 4,
        friday: 5,
        saturday: 6
    };
    return map[String(dayName || '').toLowerCase()] ?? 6;
}

function nextWeekdayOnOrAfter(date, targetDay){
    const d = new Date(date);
    const current = d.getDay();
    const delta = (targetDay - current + 7) % 7;
    d.setDate(d.getDate() + delta);
    return d;
}

function toDate(ymd){
    if(!ymd) return null;
    const parts = ymd.split('-').map(Number);
    if(parts.length !== 3) return null;
    return new Date(parts[0], parts[1] - 1, parts[2], 0, 0, 0, 0);
}

function formatYmd(date){
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

function updateTeamStatus(teamName, status){
    const teams = getJSON('teams', []);
    const idx = teams.findIndex(t=> t.teamName === teamName);
    if(idx === -1){
        alert('Team not found');
        return;
    }
    teams[idx].status = status;
    if(status === 'Pending Payment'){
        teams[idx].paymentStatus = Number(teams[idx].feePaid || 0) <= 0 ? 'Free' : 'Pending';
    } else if(status === 'Active'){
        if(Number(teams[idx].feePaid || 0) <= 0){
            teams[idx].paymentStatus = 'Free';
        } else if((teams[idx].paymentStatus || '').toLowerCase() !== 'paid'){
            teams[idx].paymentStatus = 'Paid';
        }
    }
    setJSON('teams', teams);
    renderAllAdminData();
}

function markTeamPaid(teamName){
    const teams = getJSON('teams', []);
    const idx = teams.findIndex((t)=> t.teamName === teamName);
    if(idx === -1){
        alert('Team not found');
        return;
    }
    teams[idx].status = 'Active';
    teams[idx].paymentStatus = Number(teams[idx].feePaid || 0) <= 0 ? 'Free' : 'Paid';
    teams[idx].paidAt = new Date().toISOString();
    setJSON('teams', teams);
    renderAllAdminData();
}

function deleteTeam(teamName){
    const ok = confirm(`Delete "${teamName}" and related records?`);
    if(!ok) return;

    const teams = getJSON('teams', []).filter(t=> t.teamName !== teamName);
    const standings = getJSON('standings', []).filter(s=> s.team !== teamName);
    const fixtures = getJSON('fixtures', []).filter(f=> f.home !== teamName && f.away !== teamName);
    const players = getJSON('players', []).filter(p=> p.team !== teamName);
    const accounts = getJSON('accounts', []).filter(a=> a.team !== teamName);

    setJSON('teams', teams);
    setJSON('standings', standings);
    setJSON('fixtures', fixtures);
    setJSON('players', players);
    setJSON('accounts', accounts);

    if(sessionStorage.getItem('currentClub') === teamName){
        sessionStorage.removeItem('currentClub');
    }
    renderAllAdminData();
}

function deleteLeague(leagueName){
    const ok = confirm(`Delete league "${leagueName}" and all related teams/fixtures/standings?`);
    if(!ok) return;

    const teamsToRemove = getJSON('teams', []).filter(t=> t.league === leagueName).map(t=> t.teamName);
    const removeTeamSet = new Set(teamsToRemove);

    const leagues = getJSON('leagues', []).filter(l=> l.name !== leagueName);
    const teams = getJSON('teams', []).filter(t=> t.league !== leagueName);
    const standings = getJSON('standings', []).filter(s=> s.league !== leagueName && !removeTeamSet.has(s.team));
    const fixtures = getJSON('fixtures', []).filter(f=> f.league !== leagueName && !removeTeamSet.has(f.home) && !removeTeamSet.has(f.away));
    const players = getJSON('players', []).filter(p=> !removeTeamSet.has(p.team));
    const accounts = getJSON('accounts', []).filter(a=> !removeTeamSet.has(a.team));

    setJSON('leagues', leagues);
    setJSON('teams', teams);
    setJSON('standings', standings);
    setJSON('fixtures', fixtures);
    setJSON('players', players);
    setJSON('accounts', accounts);

    renderAllAdminData();
}

function deleteFixture(fixtureId){
    const fixtures = getJSON('fixtures', []).filter(f=> Number(f.id) !== Number(fixtureId));
    setJSON('fixtures', fixtures);
    renderAllAdminData();
}

function updateFixtureStatus(fixtureId, status){
    const fixtures = getJSON('fixtures', []);
    const idx = fixtures.findIndex(f=> Number(f.id) === Number(fixtureId));
    if(idx === -1){
        alert('Fixture not found');
        return;
    }
    if(status === 'Approved'){
        const fixture = fixtures[idx];
        const homeSquad = fixture?.squads?.[fixture.home];
        const awaySquad = fixture?.squads?.[fixture.away];
        const homeReady = squadHasPlayers(homeSquad);
        const awayReady = squadHasPlayers(awaySquad);
        if(!homeReady || !awayReady){
            alert('Cannot approve: both teams must post squads first.');
            return;
        }
    }
    fixtures[idx].status = status;
    setJSON('fixtures', fixtures);
    renderAllAdminData();
}

function squadHasPlayers(raw){
    if(Array.isArray(raw)) return raw.length > 0;
    if(raw && typeof raw === 'object' && Array.isArray(raw.starters)) return raw.starters.length > 0;
    return false;
}

function statusOptions(selected){
    const options = ['Pending Payment', 'Active', 'Withdrawn', 'Relegated'];
    return options.map((s)=> `<option ${s === selected ? 'selected' : ''}>${s}</option>`).join('');
}

function getTeamPaymentLabel(team){
    const explicit = String(team?.paymentStatus || '').trim();
    if(explicit) return explicit;
    const feePaid = Number(team?.feePaid || 0);
    const status = String(team?.status || '');
    if(feePaid <= 0) return 'Free';
    if(status === 'Active') return 'Paid';
    if(status === 'Pending Payment') return 'Pending';
    return '-';
}

function getJSON(key, fallback){
    try{
        const fromMemory = adminMemoryStore[key];
        if(fromMemory != null){
            return JSON.parse(fromMemory) ?? fallback;
        }
        const fromPersistent = readPersistentValue(key);
        if(fromPersistent != null){
            adminMemoryStore[key] = fromPersistent;
            return JSON.parse(fromPersistent) ?? fallback;
        }
        return fallback;
    } catch {
        return fallback;
    }
}

function setJSON(key, value){
    const serialized = JSON.stringify(value);
    adminMemoryStore[key] = serialized;
    if(window.ummaRemoteStore?.saveKey){
        window.ummaRemoteStore.saveKey(key, serialized);
    }
    if(isNonPersistentKey(key)){
        removePersistentValue(key);
    } else {
        writePersistentValue(key, serialized);
    }
}

function setText(id, value){
    const el = document.getElementById(id);
    if(el) el.textContent = String(value);
}

function slugify(v){
    return String(v || '').toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

function collapseSpaces(v){
    return String(v || '').replace(/\s+/g, ' ').trim();
}

function splitCSV(v){
    return String(v || '')
        .split(',')
        .map(s=> collapseSpaces(s))
        .filter(Boolean);
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

import { doc, setDoc, getDoc, query, where, collection, getDocs, deleteDoc } from "https://www.gstatic.com/firebasejs/12.10.0/firebase-firestore.js";

document.addEventListener('DOMContentLoaded', ()=>{ init(); });
let showAllLeaguesFixtures = false;
// if true skip all localStorage persistence and rely solely on Firebase (remote store)
const FORCE_REMOTE_ONLY = true;

// when in remote-only mode, clear any existing local storage to avoid confusion
if(FORCE_REMOTE_ONLY){
    try{ localStorage.clear(); } catch {}
}

const appMemoryStore = (window.opener && window.opener.__UMMA_DB__)
    || window.__UMMA_DB__
    || (window.__UMMA_DB__ = {});
const DB_KEY_PREFIX = 'umma.db.';
const NON_PERSISTENT_KEYS = new Set([]);
const COLLECTION_CACHE_TTL_MS = 2500;
const collectionCache = new Map();
const collectionInFlight = new Map();

function isNonPersistentKey(key){
    return NON_PERSISTENT_KEYS.has(String(key || ''));
}

// utility copied from firebase-bridge: simple slug generator for IDs
function slug(value){
    return String(value || "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "") || "item";
}

function clearCollectionCache(name = ''){
    const target = String(name || '').trim();
    if(!target){
        collectionCache.clear();
        return;
    }
    collectionCache.delete(target);
}

// Firestore collection fetch helper with short-lived cache and in-flight dedupe.
async function fetchCollection(name, options = {}){
    const key = String(name || '').trim();
    if(!key) return [];
    if(!window.ummaFire || !window.ummaFire.db) return [];
    const force = Boolean(options.force);
    const now = Date.now();
    if(!force){
        const cached = collectionCache.get(key);
        if(cached && (now - cached.at) < COLLECTION_CACHE_TTL_MS){
            return cached.rows;
        }
        const inFlight = collectionInFlight.get(key);
        if(inFlight) return inFlight;
    }
    const task = (async ()=>{
        try{
            const snap = await getDocs(collection(window.ummaFire.db, key));
            const rows = snap.docs.map((d)=> d.data());
            collectionCache.set(key, { at: Date.now(), rows });
            return rows;
        } catch(err){
            console.error('fetchCollection', key, err);
            return [];
        } finally {
            collectionInFlight.delete(key);
        }
    })();
    collectionInFlight.set(key, task);
    try{
        return await task;
    } catch {
        return [];
    }
}

function readPersistentValue(key){
    if(FORCE_REMOTE_ONLY) return null;                 // never read from local
    if(isNonPersistentKey(key)) return null;
    try{
        return localStorage.getItem(DB_KEY_PREFIX + key);
    } catch {
        return null;
    }
}

function writePersistentValue(key, value){
    if(FORCE_REMOTE_ONLY) return;                      // skip writes
    if(isNonPersistentKey(key)) return;
    try{
        localStorage.setItem(DB_KEY_PREFIX + key, String(value));
    } catch {
        // Ignore storage errors.
    }
}

function removePersistentValue(key){
    if(FORCE_REMOTE_ONLY) return;
    try{
        localStorage.removeItem(DB_KEY_PREFIX + key);
    } catch {
        // Ignore storage errors.
    }
}

function syncMemoryStoreToPersistent(){
    Object.keys(appMemoryStore).forEach((k)=>{
        writePersistentValue(k, appMemoryStore[k]);
    });
}

function storageGet(key){
    if(Object.prototype.hasOwnProperty.call(appMemoryStore, key)){
        return appMemoryStore[key];
    }
    const persistent = readPersistentValue(key);
    if(persistent !== null){
        appMemoryStore[key] = persistent;
        return persistent;
    }
    return null;
}

function storageSet(key, value){
    const str = String(value);
    appMemoryStore[key] = str;
    if(window.ummaRemoteStore?.saveKey){
        window.ummaRemoteStore.saveKey(key, str);
    }
    if(isNonPersistentKey(key)){
        removePersistentValue(key);
    } else {
        writePersistentValue(key, str);
    }
}


function getDefaultPassword(teamName){
    return teamName.toLowerCase().replace(/\s+/g,'') + '123';
}

function slugifyEmailPart(value){
    return String(value || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '.')
        .replace(/^\.+|\.+$/g, '') || 'team';
}

function getDefaultTeamEmail(teamName){
    return `${slugifyEmailPart(teamName)}@teams.umma.local`;
}

function getDefaultAdminEmail(){
    return 'admin@umma.local';
}

function isValidEmail(email){
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || '').trim());
}

// Hardcoded leagues - single source of truth
const HARDCODED_LEAGUES = [
    {
        id:'umma-premier',
        name:'Umma Premier League',
        desc:'Semester format: round-robin league played over semester weeks, and table ranking decides the winner.',
        format: 'European-style league format: clubs play each other in scheduled round-robin matches.',
        scoring: 'Points system: Win = 3, Draw = 1, Loss = 0. Table rank decides champion.',
        qualification: 'Qualification rule: the top 6 teams in Umma Premier League qualify directly to Umma Champions League.',
        semester: 'Played fully within one semester in weekly match rounds.',
        fixtures: 'Fixtures are released by matchweek and dated across the semester calendar.'
    },
    {
        id:'umma-champ',
        name:'Umma Champions League',
        desc:'Semester format: league fixtures through semester weeks with top clubs progressing to semester-end playoffs.',
        format: 'European-style two-phase competition: league/group phase then knockout/playoff phase.',
        scoring: 'Entry includes the top 6 teams from Umma Premier League, then competition proceeds to knockout rounds.',
        semester: 'All rounds are completed within the same semester timeline.',
        fixtures: 'Fixture dates progress from phase one matchdays to knockout dates.'
    },
    {
        id:'umma-carabao',
        name:'Umma Carabao Cup',
        desc:'Semester knockout cup. Single-elimination matches are scheduled week by week until the cup final.',
        format: 'Cup format: direct knockout, one match per round (win-or-go-home).',
        scoring: 'Winners advance each round until the final.',
        semester: 'Rounds are spaced through the semester and end with a final week.',
        fixtures: 'Cup ties are shown by round with scheduled date and time.'
    },
    {
        id:'umma-kajiado',
        name:'Umma Kajiado Cup',
        desc:'Semester regional cup. Teams play scheduled fixtures during the semester and finish with ranking/playoff rounds.',
        format: 'Regional semester cup with structured rounds and final ranking/playoff.',
        scoring: 'Teams qualify from early rounds into deciding matches.',
        semester: 'Competition starts and ends within semester sports weeks.',
        fixtures: 'Fixtures are posted round-by-round as semester weeks progress.'
    },
    {
        id:'friendly-league',
        name:'Friendly League',
        desc:'Free opening matches league. Teams can register and play opening matches without M-Pesa reference.',
        format: 'Friendly opening matches format for teams preparing before formal competition rounds.',
        scoring: 'Results can be tracked, but participation is focused on match readiness.',
        semester: 'Scheduled in semester opening weeks.',
        fixtures: 'Opening fixtures are posted like regular matches.',
        registration: 'Registration is free and does not require M-Pesa reference.'
    }
];

async function init(){
    clearLegacyLocalTeamData();
    syncMemoryStoreToPersistent();
    await Promise.all([hydrateRemoteStore(), ensureAdminAuthSeed()]);
    bindUI();
    await Promise.all([ensureSampleData(), ensureMissingAccountsAndTeams()]);
    await syncStandingsFromPlayedFixtures();
    await Promise.all([renderLeagueSelect(), populateRegisterLeagueSelect()]);
    updateRegistrationPaymentUI();
    await Promise.all([renderStandings(), renderFixtures(), renderRegisteredTeams()]);
    bindAuthUI();
    openLoginModalFromHash();
    await Promise.all([bindAdminUI(), renderHomeHighlights()]);
    bindSquadUI();
    updateHeroLeagueHeading();
    openTabFromHash();
    initRegistrationMetaFields();
    startRemoteSubscription();
}

function clearLegacyLocalTeamData(){
    const keys = ['teams', 'accounts', 'players'];
    keys.forEach((key)=>{
        delete appMemoryStore[key];
        try{
            localStorage.removeItem(DB_KEY_PREFIX + key);
            localStorage.removeItem(key);
        } catch {
            // Ignore storage errors.
        }
    });
}

function openLoginModalFromHash(){
    const hash = String(window.location.hash || '').toLowerCase();
    if(hash !== '#login') return;
    const loginModal = document.getElementById('loginModal');
    if(loginModal) loginModal.style.display = 'flex';
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
        await window.ummaAuth.registerAuthUser(getDefaultAdminEmail(), 'adminpass');
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
            appMemoryStore[key] = value;
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
async function syncStandingsFromPlayedFixtures(){
    const leagues = HARDCODED_LEAGUES;
    const teams = await fetchCollection('teams');
    const fixtures = await fetchCollection('fixtures');
    const rebuilt = [];

    leagues.forEach((league)=>{
        const leagueName = league.name;
        const map = {};
        teams
            .filter(t=> t.league === leagueName && (t.status || 'Pending Payment') !== 'Withdrawn')
            .forEach((t)=>{
                map[t.teamName] = {league: leagueName, team: t.teamName, p:0, w:0, d:0, l:0, gd:0, pts:0};
            });

        fixtures
            .filter(f=> f.league === leagueName && f.result && (f.status === 'In Progress' || f.status === 'Half Time' || f.status === 'Played'))
            .forEach((f)=>{
                const score = extractFixtureScore(f.result);
                if(!Number.isFinite(score.homeGoals) || !Number.isFinite(score.awayGoals)) return;
                const hg = Number(score.homeGoals);
                const ag = Number(score.awayGoals);
                if(!map[f.home]) map[f.home] = {league: leagueName, team: f.home, p:0, w:0, d:0, l:0, gd:0, pts:0};
                if(!map[f.away]) map[f.away] = {league: leagueName, team: f.away, p:0, w:0, d:0, l:0, gd:0, pts:0};

                map[f.home].p += 1;
                map[f.away].p += 1;
                map[f.home].gd += (hg - ag);
                map[f.away].gd += (ag - hg);

                if(hg > ag){
                    map[f.home].w += 1; map[f.home].pts += 3;
                    map[f.away].l += 1;
                } else if(ag > hg){
                    map[f.away].w += 1; map[f.away].pts += 3;
                    map[f.home].l += 1;
                } else {
                    map[f.home].d += 1; map[f.home].pts += 1;
                    map[f.away].d += 1; map[f.away].pts += 1;
                }
            });

        rebuilt.push(...Object.values(map));
    });

    // Write standings to Firestore (replace all)
    if(window.ummaFire && window.ummaFire.db){
        try{
            // Delete old standings and write new ones
            const existing = await getDocs(collection(window.ummaFire.db, 'standings'));
            existing.docs.forEach(d=> deleteDoc(d.ref).catch(err=> console.error('delete standing error', err)));
            rebuilt.forEach((s)=>{
                const id = slug(`${s.league}--${s.team}`);
                setDoc(doc(window.ummaFire.db, 'standings', id), s, {merge:true}).catch(err=> console.error('standings write error', err));
            });
        } catch(err){
            console.error('syncStandingsFromPlayedFixtures firestore write error', err);
        }
    }
}

function openTabFromHash(){
    const hash = (window.location.hash || '').toLowerCase();
    if(hash === '#register'){
        openRegisterPane();
        return;
    }
    if(hash === '#fixtures'){
        openTab('fixtures');
        return;
    }
    if(hash === '#leagueinfo'){
        openTab('leagueInfo');
        return;
    }
    openTab('fixtures');
    showAllLeaguesFixtures = true;
    renderFixtures({allLeagues:true});
}

function updateHeroLeagueHeading(){
    const heading = document.getElementById('heroLeagueHeading');
    const leagueSelect = document.getElementById('leagueSelect');
    if(!heading || !leagueSelect) return;
    heading.textContent = leagueSelect.value || 'Umma University Leagues';
}

function bindUI(){
    const registerBtn = document.getElementById('registerBtn');
    const openRegister = document.getElementById('openRegister');
    const heroRegister = document.getElementById('heroRegister');
    const navRegister = document.querySelector('.main-nav a[href="#register"]');
    const standingsLinks = document.querySelectorAll('a[href="#standings"]');
    const fixturesLink = document.querySelector('.main-nav a[href="#fixtures"]');
    const leagueInfoLink = document.querySelector('.main-nav a[href="#leagueInfo"]');
    const homeLink = document.querySelector('.main-nav a[href="#home"]');
    const registerLeagueSelect = document.getElementById('league');
    if(registerBtn) registerBtn.addEventListener('click', registerTeam);
    if(openRegister) openRegister.addEventListener('click', openRegisterInNewTab);
    if(heroRegister) heroRegister.addEventListener('click', openRegisterInNewTab);
    if(navRegister) {
        navRegister.addEventListener('click', (e)=>{
            e.preventDefault();
            openRegisterInNewTab();
        });
    }
    standingsLinks.forEach((link)=>{
        link.addEventListener('click', (e)=>{
            e.preventDefault();
            showAllLeaguesFixtures = false;
            openTab('standings');
            renderStandings();
        });
    });
    if(fixturesLink){
        fixturesLink.addEventListener('click', (e)=>{
            e.preventDefault();
            showAllLeaguesFixtures = false;
            openTab('fixtures');
            renderFixtures();
        });
    }
    if(leagueInfoLink){
        leagueInfoLink.addEventListener('click', (e)=>{
            e.preventDefault();
            openTab('leagueInfo');
        });
    }
    if(homeLink){
        homeLink.addEventListener('click', (e)=>{
            e.preventDefault();
            openTab('fixtures');
            showAllLeaguesFixtures = true;
            renderFixtures({allLeagues:true});
            setHeaderNavActive('');
            const homeSection = document.getElementById('home');
            if(homeSection) homeSection.scrollIntoView({behavior:'smooth', block:'start'});
        });
    }
    if(registerLeagueSelect) registerLeagueSelect.addEventListener('change', updateRegistrationPaymentUI);
    const closeReg = document.getElementById('closeRegisterPane');
    if(closeReg) closeReg.addEventListener('click', ()=>{
        document.getElementById('register').style.display='none';
        openTab('standings');
    });
}

function openTab(tabId){
    const panels = document.querySelectorAll('.tab-panel');
    const registerPane = document.getElementById('register');
    panels.forEach((panel)=>{
        panel.classList.toggle('active', panel.id === tabId);
    });
    if(registerPane){
        registerPane.style.display = tabId === 'register' ? 'block' : 'none';
    }
    setHeaderNavActive(tabId);
}

function setHeaderNavActive(tabId){
    const map = {
        standings: '.main-nav a[href="#standings"]',
        fixtures: '.main-nav a[href="#fixtures"]',
        leagueInfo: '.main-nav a[href="#leagueInfo"]',
        register: '.main-nav a[href="#register"]'
    };
    Object.values(map).forEach((selector)=>{
        const link = document.querySelector(selector);
        if(link) link.classList.remove('active-link');
    });
    const activeSelector = map[tabId];
    if(activeSelector){
        const activeLink = document.querySelector(activeSelector);
        if(activeLink) activeLink.classList.add('active-link');
    }
}

function openRegisterPane(){
    const registerPane = document.getElementById('register');
    if(!registerPane) return;
    openTab('register');
    registerPane.style.display='block';
    initRegistrationMetaFields();
    registerPane.scrollIntoView({behavior:'smooth', block:'start'});
}

function initRegistrationMetaFields(){
    const semesterInput = document.getElementById('semesterLabel');
    if(!semesterInput || semesterInput.value) return;
    // Fetch semester calendar from Firestore asynchronously
    if(window.ummaFire && window.ummaFire.db){
        getDocs(query(collection(window.ummaFire.db, 'semesterCalendar')))
            .then(snap=>{
                if(snap.docs.length > 0){
                    const cal = snap.docs[0].data();
                    if(cal?.start && cal?.end){
                        semesterInput.value = `${cal.start} to ${cal.end}`;
                    }
                }
            })
            .catch(err=> console.error('semester calendar fetch failed', err));
    }
}

function openRegisterInNewTab(){
    const targetUrl = new URL(window.location.href);
    targetUrl.hash = 'register';
    const newTab = window.open(targetUrl.toString(), '_blank');
    if(!newTab){
        // Fallback when popups are blocked
        openRegisterPane();
    }
}


// Login modal and club management bindings
function bindAuthUI(){
    const loginBtn = document.getElementById('loginBtn');
    const loginModal = document.getElementById('loginModal');
    const closeLogin = document.getElementById('closeLogin');
    const loginSubmit = document.getElementById('loginSubmit');
    const createAccountBtn = document.getElementById('createAccountBtn');
    const logoutBtn = document.getElementById('logoutBtn');
    const editClubBtn = document.getElementById('editClubBtn');
    const openClubPortalBtn = document.getElementById('openClubPortalBtn');
    const saveClubBtn = document.getElementById('saveClubBtn');

    if(loginBtn) loginBtn.addEventListener('click', ()=>{
        loginModal.style.display = 'flex';
    });
    if(closeLogin) closeLogin.addEventListener('click', ()=> loginModal.style.display = 'none');
    if(loginSubmit) loginSubmit.addEventListener('click', async ()=> await loginClub());
    if(createAccountBtn) createAccountBtn.addEventListener('click', createAccount);
    if(logoutBtn) logoutBtn.addEventListener('click', async ()=> await logoutClub());
    if(editClubBtn) editClubBtn.addEventListener('click', ()=>{
        document.getElementById('editClubForm').style.display = 'block';
        document.getElementById('editCoach').value = document.getElementById('dashCoach').textContent;
        document.getElementById('editPhone').value = document.getElementById('dashPhone').textContent;
    });
    if(openClubPortalBtn) openClubPortalBtn.addEventListener('click', openClubPortal);
    if(saveClubBtn) saveClubBtn.addEventListener('click', async ()=> await saveClubEdits());
}

async function ensureSampleData(){
    if(!window.ummaFire || !window.ummaFire.db) return;
    
    try{
        // Ensure required leagues exist in Firestore (only write once)
        const existingLeagues = await fetchCollection('leagues');
        if(existingLeagues.length === 0){
            // Firestore is empty, write all hardcoded leagues
            HARDCODED_LEAGUES.forEach((reqLeague)=>{
                setDoc(doc(window.ummaFire.db, 'leagues', reqLeague.id), reqLeague, {merge: true}).catch(err=> console.error('league write error', err));
            });
        }
    } catch(err){
        console.error('ensureSampleData leagues error', err);
    }
}
async function ensureMissingAccountsAndTeams(){
    if(!window.ummaFire || !window.ummaFire.db) return;
    try{
        const teams = await fetchCollection('teams');
        const accounts = await fetchCollection('users');
        let changed = false;
        const hasAdmin = accounts.some((a)=> String(a.role || '') === 'admin');
        const adminEmail = getDefaultAdminEmail();
        if(!hasAdmin){
            await setDoc(doc(window.ummaFire.db, 'users', slug(adminEmail)), 
                {team:'admin', email:adminEmail, role:'admin', updatedAtMs: Date.now()}, {merge:true});
            changed = true;
        }
        // Ensure every team has an account by email
        teams.forEach((t)=>{
            const teamEmail = getDefaultTeamEmail(t.teamName || '');
            const hasAccount = accounts.some(a=> a.email?.toLowerCase() === teamEmail.toLowerCase());
            if(!hasAccount && t.teamName){
                setDoc(doc(window.ummaFire.db, 'users', slug(t.teamName)), 
                    {team: t.teamName, email: teamEmail, role: 'club', updatedAtMs: Date.now()}, {merge:true})
                    .catch(err=> console.error('team account write error', err));
            }
        });
    } catch(err){
        console.error('ensureMissingAccountsAndTeams error', err);
    }
}

async function renderStandings(){
    const body = document.getElementById('standingsBody');
    const selected = document.getElementById('leagueSelect').value;
    if(!selected){
        body.innerHTML = '<tr><td colspan="8" class="muted">Choose a league to view standings.</td></tr>';
        return;
    }
    let standings = await fetchCollection('standings');
    standings = standings.filter(s=> !selected || s.league === selected);
    standings = standings.sort((a,b)=> b.pts - a.pts || b.gd - a.gd);
    body.innerHTML = '';
    standings.forEach((row,i)=>{
        const tr = document.createElement('tr');
        tr.innerHTML = `<td>${i+1}</td><td>${row.team}</td><td>${row.p}</td><td>${row.w}</td><td>${row.d}</td><td>${row.l}</td><td>${row.gd}</td><td>${row.pts}</td>`;
        body.appendChild(tr);
    });
}

async function renderFixtures(options = {}){
    const list = document.getElementById('fixturesList');
    let fixtures = await fetchCollection('fixtures');
    let calendar = null;
    try{
        const calData = await getDocs(query(collection(window.ummaFire.db, 'semesterCalendar')));
        if(calData.docs.length > 0) calendar = calData.docs[0].data();
    } catch {}
    const selected = document.getElementById('leagueSelect').value;
    const allLeagues = Boolean(options.allLeagues || showAllLeaguesFixtures);
    list.innerHTML = '';
    if(!allLeagues && !selected){
        list.innerHTML = '<li class="muted">Choose a league to view fixtures and stats.</li>';
        return;
    }
    fixtures
        .filter((f)=>{
            if(!allLeagues && f.league !== selected) return false;
            if(calendar?.start && calendar?.end){
                const ymd = String(f.date || '').split(' ')[0];
                if(ymd && (ymd < calendar.start || ymd > calendar.end)) return false;
            }
            return true;
        })
        .sort((a,b)=> String(a.date).localeCompare(String(b.date)))
        .forEach(f=>{
        const li = document.createElement('li');
        const hasSquadsPosted = Boolean(f.squads && (f.squads[f.home] || f.squads[f.away]));
        const showPublicSquad = isFixtureSquadVisible(f);
        const squadsInfo = hasSquadsPosted
            ? (showPublicSquad
                ? '<span style="margin-left:10px;color:var(--muted)">Squads posted</span>'
                : '<span style="margin-left:10px;color:var(--muted)">Squads available 2h before kickoff</span>')
            : '';
        const status = f.status ? `<span style="margin-left:8px;color:var(--muted)">[${f.status}]</span>` : '';
        const score = extractFixtureScore(f.result);
        const hasScore = Number.isFinite(score.homeGoals) && Number.isFinite(score.awayGoals);
        const scoreText = hasScore ? `<span style="margin-left:8px;font-weight:700">${score.homeGoals}-${score.awayGoals}</span>` : '';
        const outcomeText = hasScore ? `<span style="margin-left:8px;color:var(--muted)">(${getOutcomeFromScore(f, score)})</span>` : '';
        const leagueTag = allLeagues ? `<div class="time"><strong>${f.league}</strong></div>` : '';
        const publicSquad = showPublicSquad ? renderFixturePublicSquad(f) : '';
        li.innerHTML = `${leagueTag}<strong>${f.home}</strong> vs <strong>${f.away}</strong>${scoreText}${outcomeText}${status}<div class="time">${f.date}</div>${squadsInfo}${publicSquad}`;
        // Add post squad buttons if logged in as a team
        const club = sessionStorage.getItem('currentClub');
        if(club && (club === f.home || club === f.away)){
            const btn = document.createElement('button');
            btn.textContent = 'Post Squad';
            btn.className = 'btn';
            btn.style.marginLeft = '10px';
            btn.addEventListener('click', ()=> openSquadModal(f.id, club));
            li.appendChild(btn);
        }
        list.appendChild(li);
    });
    renderHomeHighlights();
}

function extractFixtureScore(result){
    if(!result) return {homeGoals: NaN, awayGoals: NaN};
    if(result.fullTime && Number.isFinite(Number(result.fullTime.homeGoals)) && Number.isFinite(Number(result.fullTime.awayGoals))){
        return {homeGoals: Number(result.fullTime.homeGoals), awayGoals: Number(result.fullTime.awayGoals)};
    }
    if(Number.isFinite(Number(result.homeGoals)) && Number.isFinite(Number(result.awayGoals))){
        return {homeGoals: Number(result.homeGoals), awayGoals: Number(result.awayGoals)};
    }
    return {homeGoals: NaN, awayGoals: NaN};
}

const SQUAD_VISIBLE_BEFORE_MATCH_MS = 2 * 60 * 60 * 1000;

function getOutcomeFromScore(fixture, score){
    const homeGoals = Number(score?.homeGoals);
    const awayGoals = Number(score?.awayGoals);
    if(homeGoals > awayGoals) return `${fixture.home} Win`;
    if(awayGoals > homeGoals) return `${fixture.away} Win`;
    return 'Draw';
}

function normalizeFixtureTeamSquad(raw){
    if(Array.isArray(raw)){
        return {starters: raw, subs: []};
    }
    if(raw && typeof raw === 'object'){
        const starters = Array.isArray(raw.starters) ? raw.starters : [];
        const subs = Array.isArray(raw.subs) ? raw.subs : [];
        return {starters, subs};
    }
    return {starters: [], subs: []};
}

function parseFixtureDateMs(rawDate){
    const v = String(rawDate || '').trim();
    if(!v) return NaN;
    const normalized = v.replace(' ', 'T');
    const parsed = Date.parse(normalized);
    return Number.isFinite(parsed) ? parsed : NaN;
}

function isFixtureLiveOrFinished(status){
    const s = String(status || '').trim().toLowerCase();
    if(!s) return false;
    return s === 'in progress' || s === 'half time' || s === 'played' || s === 'full time' || s === 'finished';
}

function isFixtureSquadVisible(fixture){
    if(!fixture) return false;
    if(isFixtureLiveOrFinished(fixture.status)) return true;
    const kickoffMs = parseFixtureDateMs(fixture.date);
    if(!Number.isFinite(kickoffMs)) return true;
    return Date.now() >= (kickoffMs - SQUAD_VISIBLE_BEFORE_MATCH_MS);
}

function renderTeamSquadBlock(teamName, squad){
    if(!squad.starters.length && !squad.subs.length) return '';
    const starters = squad.starters.length ? squad.starters.join(', ') : '-';
    const subs = squad.subs.length ? squad.subs.join(', ') : '-';
    return `<div class="time" style="margin-top:6px"><strong>${teamName}</strong> - Starters: ${starters} | Subs: ${subs}</div>`;
}

function renderFixturePublicSquad(fixture){
    if(!fixture?.squads) return '';
    const homeSquad = normalizeFixtureTeamSquad(fixture.squads[fixture.home]);
    const awaySquad = normalizeFixtureTeamSquad(fixture.squads[fixture.away]);
    const homeBlock = renderTeamSquadBlock(fixture.home, homeSquad);
    const awayBlock = renderTeamSquadBlock(fixture.away, awaySquad);
    if(!homeBlock && !awayBlock) return '';
    return `<div style="margin-top:6px;padding:8px;border:1px solid #ece8f7;border-radius:6px;background:#faf9ff">${homeBlock}${awayBlock}</div>`;
}

async function renderLeagueSelect(){
    const sel = document.getElementById('leagueSelect');
    const leagues = HARDCODED_LEAGUES;
    const previous = sel.value;
    sel.innerHTML = '';
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = 'Choose league';
    placeholder.selected = true;
    placeholder.disabled = false;
    sel.appendChild(placeholder);
    leagues.forEach(l=>{ const o = document.createElement('option'); o.value = l.name; o.textContent = l.name; sel.appendChild(o); });
    if(previous && leagues.some(l=> l.name === previous)) sel.value = previous;
    sel.onchange = ()=>{
        showAllLeaguesFixtures = false;
        document.getElementById('leagueTitle').textContent = sel.value || 'Choose a League';
        updateHeroLeagueHeading();
        renderStandings();
        renderFixtures();
        renderLeagueInfo();
        renderHomeHighlights();
    };
    // populate initial
    document.getElementById('leagueTitle').textContent = sel.value || 'Choose a League';
    updateHeroLeagueHeading();
    renderLeagueInfo();
    renderHomeHighlights();
}

async function populateRegisterLeagueSelect(){
    const sel = document.getElementById('league');
    if(!sel) return;
    const leagues = HARDCODED_LEAGUES;
    sel.innerHTML = '';
    const opt = document.createElement('option'); opt.value = ''; opt.textContent = 'Select League'; sel.appendChild(opt);
    leagues.forEach(l=> sel.appendChild(new Option(l.name, l.name)));
    updateRegistrationPaymentUI();
}

function requiresMpesaRefForLeague(leagueName){
    // Friendly League doesn't require M-Pesa reference
    const name = String(leagueName || '').toLowerCase();
    return !name.includes('friendly');
}

function updateRegistrationPaymentUI(){
    const league = document.getElementById('league')?.value || '';
    const feeNote = document.getElementById('registerFeeNote');
    const mpesaInput = document.getElementById('mpesaRef');
    const requiresMpesa = requiresMpesaRefForLeague(league);

    if(feeNote){
        feeNote.textContent = requiresMpesa
            ? 'Registration Fee: Ksh 500 (M-Pesa reference required)'
            : 'Registration Fee: Free for Friendly League opening matches (M-Pesa reference not required)';
    }
    if(mpesaInput){
        mpesaInput.disabled = !requiresMpesa;
        mpesaInput.placeholder = requiresMpesa
            ? 'M-Pesa Reference (required for paid leagues)'
            : 'No M-Pesa reference required for Friendly League';
        if(!requiresMpesa){
            mpesaInput.value = '';
        }
    }
}

function applyRemoteState(remote){
    clearCollectionCache();
    Object.keys(remote || {}).forEach((key)=>{
        const value = String(remote[key]);
        appMemoryStore[key] = value;
        if(isNonPersistentKey(key)){
            removePersistentValue(key);
        } else {
            writePersistentValue(key, value);
        }
    });
}

function startRemoteSubscription(){
    if(!window.ummaRemoteStore?.subscribeState) return;
    window.ummaRemoteStore.subscribeState((remote)=>{
        applyRemoteState(remote);
        renderLeagueSelect();
        populateRegisterLeagueSelect();
        updateRegistrationPaymentUI();
        renderStandings();
        renderFixtures();
        renderRegisteredTeams();
        renderLeagueInfo();
        renderHomeHighlights();
    });
}

async function renderLeagueInfo(){
    const sel = document.getElementById('leagueSelect');
    const desc = document.getElementById('leagueDesc');
    const leagues = HARDCODED_LEAGUES;
    const l = leagues.find(x=> x.name === sel.value);
    if(l){
        // Build info from Firestore data
        const info = [
            `<strong>${l.name}</strong>`,
            l.format || '',
            l.scoring || '',
            l.qualification || '',
            l.registration || '',
            l.semester || '',
            l.fixtures || '',
            '<strong>Site view:</strong> Home = all-league fixtures, Fixtures/Standings = selected league.'
        ].filter(x=> x).join('<br>');
        desc.innerHTML = info;
    } else {
        desc.innerHTML = [
            '<strong>Select a league first.</strong>',
            'Standings and Fixtures tabs follow the selected league.',
            'Home shows a combined fixture list across all leagues.'
        ].join('<br>');
    }
}

function getLeagueInfoTemplate(leagueName, baseDesc){
    const templates = {
        'Umma Premier League': {
            format: 'European-style league format: clubs play each other in scheduled round-robin matches.',
            scoring: 'Points system: Win = 3, Draw = 1, Loss = 0. Table rank decides champion.',
            qualification: 'Qualification rule: the top 6 teams in Umma Premier League qualify directly to Umma Champions League.',
            semester: 'Played fully within one semester in weekly match rounds.',
            fixtures: 'Fixtures are released by matchweek and dated across the semester calendar.'
        },
        'Umma Champions League': {
            format: 'European-style two-phase competition: league/group phase then knockout/playoff phase.',
            scoring: 'Entry includes the top 6 teams from Umma Premier League, then competition proceeds to knockout rounds.',
            semester: 'All rounds are completed within the same semester timeline.',
            fixtures: 'Fixture dates progress from phase one matchdays to knockout dates.'
        },
        'Umma Carabao Cup': {
            format: 'Cup format: direct knockout, one match per round (win-or-go-home).',
            scoring: 'Winners advance each round until the final.',
            semester: 'Rounds are spaced through the semester and end with a final week.',
            fixtures: 'Cup ties are shown by round with scheduled date and time.'
        },
        'Umma Kajiado Cup': {
            format: 'Regional semester cup with structured rounds and final ranking/playoff.',
            scoring: 'Teams qualify from early rounds into deciding matches.',
            semester: 'Competition starts and ends within semester sports weeks.',
            fixtures: 'Fixtures are posted round-by-round as semester weeks progress.'
        },
        'Friendly League': {
            format: 'Friendly opening matches format for teams preparing before formal competition rounds.',
            scoring: 'Results can be tracked, but participation is focused on match readiness.',
            semester: 'Scheduled in semester opening weeks.',
            fixtures: 'Opening fixtures are posted like regular matches.',
            registration: 'Registration is free and does not require M-Pesa reference.'
        }
    };

    const t = templates[leagueName];
    if(!t){
        return [
            `<strong>${leagueName}</strong>`,
            baseDesc || 'Semester competition format.',
            'Fixtures and standings update according to the selected league.'
        ].join('<br>');
    }

    return [
        `<strong>${leagueName}</strong>`,
        t.format,
        t.scoring,
        t.qualification || '',
        t.registration || '',
        t.semester,
        t.fixtures,
        '<strong>Site view:</strong> Home = all-league fixtures, Fixtures/Standings = selected league.'
    ].join('<br>');
}

async function renderHomeHighlights(){
    const leagues = HARDCODED_LEAGUES;
    const teams = await fetchCollection('teams');
    const fixtures = await fetchCollection('fixtures');
    let calendar = null;
    try{
        const calData = await getDocs(query(collection(window.ummaFire.db, 'semesterCalendar')));
        if(calData.docs.length > 0) calendar = calData.docs[0].data();
    } catch {}
    const selectedLeague = document.getElementById('leagueSelect')?.value || '';

    const visibleFixtures = fixtures.filter((f)=>{
        if(selectedLeague && f.league !== selectedLeague) return false;
        if(calendar?.start && calendar?.end){
            const ymd = String(f.date || '').split(' ')[0];
            if(ymd && (ymd < calendar.start || ymd > calendar.end)) return false;
        }
        return true;
    });
    const sortedFixtures = [...visibleFixtures].sort((a,b)=> String(a.date).localeCompare(String(b.date)));
    const leagueCountEl = document.getElementById('homeLeagueCount');
    const teamCountEl = document.getElementById('homeTeamCount');
    const fixtureCountEl = document.getElementById('homeFixtureCount');
    const nextFixturesEl = document.getElementById('homeNextFixtures');

    if(leagueCountEl) leagueCountEl.textContent = String(leagues.length);
    if(teamCountEl) teamCountEl.textContent = String(teams.length);
    if(fixtureCountEl) fixtureCountEl.textContent = String(visibleFixtures.length);
    if(nextFixturesEl){
        const track = nextFixturesEl.querySelector('.marquee-track');
        if(!track) return;
        const topFixtures = sortedFixtures.slice(0, 4);
        track.innerHTML = '';
        if(topFixtures.length === 0){
            track.innerHTML = '<span class="marquee-item">No fixture scheduled yet</span><span class="marquee-item">No fixture scheduled yet</span>';
        } else {
            const items = topFixtures.map((f)=> `${f.league}: ${f.home} vs ${f.away} (${f.date})`);
            const sequence = [...items, ...items];
            sequence.forEach((text)=>{
                const span = document.createElement('span');
                span.className = 'marquee-item';
                span.textContent = text;
                track.appendChild(span);
            });
            track.style.animation = 'none';
            void track.offsetHeight;
            track.style.animation = '';
        }
    }
}

async function renderRegisteredTeams(){
    const table = document.getElementById('teamTable');
    let teams = await fetchCollection('teams');
    if(table){
        table.innerHTML = '';
        teams.forEach(t=>{
            const tr = document.createElement('tr');
            tr.innerHTML = `<td>${t.teamName}</td><td>${t.league}</td><td>${t.status}</td>`;
            table.appendChild(tr);
        });
    }
    await renderClubDashboard();
    await populateAdminTeamSelects();
}

/* Authentication & Club management */
async function getAccounts(){
    let users = [];
    try{
        users = await fetchCollection('users');
    } catch {
        users = [];
    }
    // ensure format compatibility
    return users.map(u=>({
        team: u.team || '',
        email: u.email || '',
        role: u.role || 'team'
    }));
}

async function saveAccounts(a){
    if(window.ummaFire && window.ummaFire.db){
        try{
            const { db } = window.ummaFire;
            for(const acc of a){
                const id = acc.uid || slug(acc.email || acc.team || 'user');
                await setDoc(doc(db, 'users', id), {
                    email: acc.email || '',
                    role: acc.role || 'team',
                    team: acc.team || '',
                    teamId: slug(acc.team || ''),
                    updatedAtMs: Date.now()
                }, { merge: true });
            }
        } catch(err){
            console.error('saveAccounts firestore error', err);
        }
    }
    // still update memory if needed
    storageSet('accounts', JSON.stringify(a));
}

function createAccount(){
    const team = document.getElementById('loginTeam').value.trim();
    const email = document.getElementById('loginEmail')?.value.trim() || '';
    document.getElementById('loginModal').style.display = 'none';
    openRegisterPane();
    const teamInput = document.getElementById('teamName');
    const emailInput = document.getElementById('accountEmail');
    if(teamInput && team){
        teamInput.value = team;
        teamInput.focus();
    }
    if(emailInput && email){
        emailInput.value = email;
    }
    alert('Register your team using Team Name, Email and Password.');
}

function setCurrentClub(teamName){
    const name = String(teamName || '').trim();
    if(!name) return;
    sessionStorage.setItem('currentClub', name);
    try{
        localStorage.setItem('umma.currentClub', name);
    } catch {
        // Ignore storage errors.
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

async function loginClub(){
    const team = document.getElementById('loginTeam').value.trim();
    const email = document.getElementById('loginEmail')?.value.trim().toLowerCase() || '';
    const pass = document.getElementById('loginPassword').value;
    if(!email || !pass){
        alert('Enter email and password');
        return;
    }
    if(!window.ummaAuth?.loginAuthUser){
        alert('Authentication service is not ready. Reload and try again.');
        return;
    }
    try{
        await window.ummaAuth.loginAuthUser(email, pass);
    } catch {
        alert('Invalid email or password');
        return;
    }
    const openAdmin = ()=>{
        document.getElementById('loginModal').style.display = 'none';
        sessionStorage.setItem('adminAuth', 'true');
        const adminTab = window.open('admin.html', '_blank');
        if(!adminTab){
            window.location.href = 'admin.html';
        }
    };

    let userTeam = '';
    let resolvedRole = '';
    if(window.ummaFire && window.ummaFire.db){
        try{
            const currentUser = window.ummaAuth.getAuthUser();
            const userId = currentUser ? currentUser.uid : '';
            if(userId){
                const userSnap = await getDoc(doc(window.ummaFire.db, 'users', userId));
                if(userSnap.exists()){
                    const userData = userSnap.data() || {};
                    resolvedRole = String(userData.role || '').toLowerCase();
                    userTeam = String(userData.team || '');
                }
            }
            if(!resolvedRole || !userTeam){
                const matches = await getDocs(query(collection(window.ummaFire.db, 'users'), where('email', '==', email)));
                const docs = matches.docs.map((d)=> d.data() || {});
                const adminDoc = docs.find((d)=> String(d.role || '').toLowerCase() === 'admin');
                if(adminDoc){
                    resolvedRole = 'admin';
                } else {
                    const clubDocs = docs.filter((d)=> String(d.role || '').toLowerCase() === 'club' && String(d.team || '').trim());
                    if(team){
                        const exact = clubDocs.find((d)=> String(d.team || '').toLowerCase() === team.toLowerCase());
                        if(exact){
                            userTeam = String(exact.team || '');
                            resolvedRole = 'club';
                        }
                    } else if(clubDocs.length === 1){
                        userTeam = String(clubDocs[0].team || '');
                        resolvedRole = 'club';
                    }
                }
            }
        } catch(err){
            console.error('login resolution failed', err);
        }
    }

    if(resolvedRole === 'admin'){
        openAdmin();
        return;
    }

    if(!userTeam){
        await window.ummaAuth.logoutAuthUser();
        alert('No club account found for this email. Register first or enter the correct team name.');
        return;
    }

    setCurrentClub(userTeam);
    document.getElementById('loginModal').style.display = 'none';
    window.location.href = 'club.html';
}

async function logoutClub(){
    clearCurrentClub();
    if(window.ummaAuth?.logoutAuthUser){
        try{
            await window.ummaAuth.logoutAuthUser();
        } catch {
            // Ignore sign-out errors.
        }
    }
    renderClubDashboard();
    renderFixtures();
}

function openClubPortal(){
    const club = sessionStorage.getItem('currentClub');
    if(!club){
        alert('Login as a club first');
        return;
    }
    const clubTab = window.open('club.html', '_blank');
    if(!clubTab){
        window.location.href = 'club.html';
    }
}

async function renderClubDashboard(){
    const club = sessionStorage.getItem('currentClub');
    const dash = document.getElementById('clubDashboard');
    if(!dash) return;
    if(!club){ dash.style.display='none'; return; }
    const teams = await fetchCollection('teams');
    const t = teams.find(x=> x.teamName === club);
    if(!t){ dash.style.display='none'; return; }
    dash.style.display='block';
    document.getElementById('dashTeamName').textContent = t.teamName;
    document.getElementById('dashCoach').textContent = t.coachName || '-';
    document.getElementById('dashPhone').textContent = t.phone || '-';
    document.getElementById('dashStatus').textContent = t.status || '-';
    await renderClubPlayers(t.teamName);
    await renderClubFixtures(t.teamName);
}

/* Players management */
async function getPlayers(){
    try{
        return await fetchCollection('players');
    } catch {
        return [];
    }
}
async function savePlayers(p){
    if(!window.ummaFire || !window.ummaFire.db) return;
    try{
        const existing = await getDocs(collection(window.ummaFire.db, 'players'));
        existing.docs.forEach(d=> deleteDoc(d.ref).catch(e=> console.error('delete player error', e)));
        p.forEach(player=>{
            const id = slug(`${player.team}--${player.name}`);
            setDoc(doc(window.ummaFire.db, 'players', id), player, {merge:true}).catch(e=> console.error('save player error', e));
        });
    } catch(err){
        console.error('savePlayers error', err);
    }
}

async function addPlayerToTeam(team, playerName){
    const players = await getPlayers();
    if(players.find(p=> p.name.toLowerCase() === playerName.toLowerCase())){
        const existing = players.find(p=> p.name.toLowerCase() === playerName.toLowerCase());
        if(existing.team !== team) return {ok:false, msg:'Player already registered for another team: ' + existing.team};
        return {ok:false, msg:'Player already in your team'};
    }
    players.push({name:playerName, team});
    await savePlayers(players);
    return {ok:true};
}

async function renderClubPlayers(team){
    let html = '<h4>Players</h4>';
    html += '<div style="display:flex;gap:8px;margin-bottom:8px"><input id="newPlayerName" placeholder="Player full name"><button id="addPlayerBtn" class="btn">Add</button></div>';
    const players = (await getPlayers()).filter(p=> p.team === team);
    html += '<ul>' + players.map(p=> `<li>${p.name}</li>`).join('') + '</ul>';
    document.getElementById('clubDashboard').querySelector('#playersContainer') ? document.getElementById('clubDashboard').querySelector('#playersContainer').innerHTML = html : document.getElementById('clubDashboard').insertAdjacentHTML('beforeend', '<div id="playersContainer">'+html+'</div>');
    const btn = document.getElementById('addPlayerBtn');
    if(btn) btn.addEventListener('click', async ()=>{
        const name = document.getElementById('newPlayerName').value.trim();
        if(!name) return alert('Enter player name');
        const res = await addPlayerToTeam(team, name);
        if(!res.ok) return alert(res.msg);
        await renderClubPlayers(team);
    });
}

async function renderClubFixtures(team){
    const fixtures = await fetchCollection('fixtures');
    const my = fixtures.filter(f=> f.home === team || f.away === team);
    let container = document.getElementById('clubFixtures');
    if(!container){ document.getElementById('clubDashboard').insertAdjacentHTML('beforeend', '<div id="clubFixtures" style="margin-top:12px"><h4>Your Fixtures</h4></div>'); container = document.getElementById('clubFixtures'); }
    container.innerHTML = '<h4>Your Fixtures</h4>' + my.map(f=> `<div style="padding:6px;border-bottom:1px solid #f0f0f0"><strong>${f.home}</strong> vs <strong>${f.away}</strong> <div class="time">${f.date}</div></div>`).join('');
}

/* Squad modal */
function bindSquadUI(){
    const close = document.getElementById('closeSquad');
    const cancel = document.getElementById('cancelSquadBtn');
    const save = document.getElementById('saveSquadBtn');
    if(close) close.addEventListener('click', ()=> document.getElementById('squadModal').style.display = 'none');
    if(cancel) cancel.addEventListener('click', ()=> document.getElementById('squadModal').style.display = 'none');
    if(save) save.addEventListener('click', saveSquad);
}

let currentSquadContext = null; // {fixtureId, team}

function openSquadModal(fixtureId, team){
    const fixtures = JSON.parse(storageGet('fixtures')) || [];
    const f = fixtures.find(x=> x.id === fixtureId);
    if(!f) return alert('Fixture not found');
    currentSquadContext = {fixtureId, team};
    document.getElementById('squadFixtureInfo').textContent = `${f.home} vs ${f.away} - ${f.date}`;
    const players = getPlayers().filter(p=> p.team === team);
    const list = players.map(p=> `<div><label><input type="checkbox" name="squadPlayer" value="${p.name}"> ${p.name}</label></div>`).join('') || '<div class="muted">No players. Add players first.</div>';
    document.getElementById('squadPlayersList').innerHTML = list;
    document.getElementById('squadModal').style.display = 'flex';
}

function saveSquad(){
    if(!currentSquadContext) return;
    const {fixtureId, team} = currentSquadContext;
    const checked = Array.from(document.querySelectorAll('input[name="squadPlayer"]:checked')).map(i=> i.value);
    if(checked.length === 0) return alert('Select at least one player');
    const fixtures = JSON.parse(storageGet('fixtures')) || [];
    const idx = fixtures.findIndex(f=> f.id === fixtureId);
    if(idx === -1) return alert('Fixture missing');
    fixtures[idx].squads = fixtures[idx].squads || {};
    fixtures[idx].squads[team] = {starters: checked, subs: []};
    storageSet('fixtures', JSON.stringify(fixtures));
    document.getElementById('squadModal').style.display = 'none';
    renderFixtures();
    alert('Squad saved');
}

/* Admin panel */
async function bindAdminUI(){
    const close = document.getElementById('closeAdmin');
    const createLeagueBtn = document.getElementById('createLeagueBtn');
    const createFixtureBtn = document.getElementById('createFixtureBtn');
    const adminTeamsLeagueFilter = document.getElementById('adminTeamsLeagueFilter');
    if(close) close.addEventListener('click', ()=> document.getElementById('adminPanel').style.display = 'none');
    if(createLeagueBtn) createLeagueBtn.addEventListener('click', createLeague);
    if(createFixtureBtn) createFixtureBtn.addEventListener('click', async ()=> await createFixture());
    if(adminTeamsLeagueFilter) adminTeamsLeagueFilter.addEventListener('change', renderAdminTeams);
    bindAdminTeamsActions();
    await populateAdminTeamSelects();
}

function bindAdminTeamsActions(){
    const body = document.getElementById('adminTeamsBody');
    if(!body) return;
    body.addEventListener('click', (e)=>{
        const btn = e.target.closest('button[data-action]');
        if(!btn) return;
        const action = btn.dataset.action;
        const teamName = btn.dataset.team;
        if(!teamName) return;

        if(action === 'activate'){
            updateTeamStatus(teamName, 'Active');
        } else if(action === 'pending'){
            updateTeamStatus(teamName, 'Pending Payment');
        } else if(action === 'withdraw'){
            updateTeamStatus(teamName, 'Withdrawn');
        } else if(action === 'delete'){
            deleteTeam(teamName);
        }
    });
}

function updateTeamStatus(teamName, status){
    const teams = JSON.parse(storageGet('teams')) || [];
    const idx = teams.findIndex(t=> t.teamName === teamName);
    if(idx === -1){ alert('Team not found'); return; }
    teams[idx].status = status;
    storageSet('teams', JSON.stringify(teams));
    renderRegisteredTeams();
    renderHomeHighlights();
    renderAdminSummary();
}

function deleteTeam(teamName){
    const ok = confirm(`Delete team "${teamName}"? This will remove standings, fixtures involving the team, players and account.`);
    if(!ok) return;

    let teams = JSON.parse(storageGet('teams')) || [];
    teams = teams.filter(t=> t.teamName !== teamName);
    storageSet('teams', JSON.stringify(teams));

    let standings = JSON.parse(storageGet('standings')) || [];
    standings = standings.filter(s=> s.team !== teamName);
    storageSet('standings', JSON.stringify(standings));

    let fixtures = JSON.parse(storageGet('fixtures')) || [];
    fixtures = fixtures.filter(f=> f.home !== teamName && f.away !== teamName);
    storageSet('fixtures', JSON.stringify(fixtures));

    let players = JSON.parse(storageGet('players')) || [];
    players = players.filter(p=> p.team !== teamName);
    storageSet('players', JSON.stringify(players));

    let accounts = getAccounts();
    accounts = accounts.filter(a=> a.team !== teamName);
    saveAccounts(accounts);

    if(sessionStorage.getItem('currentClub') === teamName){
        sessionStorage.removeItem('currentClub');
    }

    renderRegisteredTeams();
    renderFixtures();
    renderStandings();
    renderHomeHighlights();
    renderAdminTeams();
    renderAdminSummary();
    populateAdminTeamSelects();
}

function createLeague(){
    const name = document.getElementById('newLeagueName').value.trim();
    if(!name) return alert('Enter league name');
    const leagues = JSON.parse(storageGet('leagues')) || [];
    if(leagues.find(l=> l.name.toLowerCase() === name.toLowerCase())) return alert('League exists');
    leagues.push({id: name.toLowerCase().replace(/\s+/g,'-'), name, desc: 'Semester format: fixtures are scheduled week-by-week throughout the semester.'});
    storageSet('leagues', JSON.stringify(leagues));
    renderLeagueSelect();
    populateRegisterLeagueSelect();
    populateAdminTeamSelects();
    renderAdminSummary();
    alert('League created');
}

async function populateAdminTeamSelects(){
    const teams = await fetchCollection('teams');
    const leagues = HARDCODED_LEAGUES;
    const fl = document.getElementById('fixtureLeague');
    const fh = document.getElementById('fixtureHome');
    const fa = document.getElementById('fixtureAway');
    if(fl){ fl.innerHTML = ''; leagues.forEach(l=> fl.appendChild(new Option(l.name,l.name))); }
    if(fh){ fh.innerHTML = ''; teams.forEach(t=> fh.appendChild(new Option(t.teamName,t.teamName))); }
    if(fa){ fa.innerHTML = ''; teams.forEach(t=> fa.appendChild(new Option(t.teamName,t.teamName))); }
}

async function createFixture(){
    const league = document.getElementById('fixtureLeague').value;
    const home = document.getElementById('fixtureHome').value;
    const away = document.getElementById('fixtureAway').value;
    const date = document.getElementById('fixtureDate').value.trim();
    if(!league || !home || !away || !date) return alert('Fill all fields');
    if(home === away) return alert('Home and away must differ');
    const fixtures = await fetchCollection('fixtures');
    const id = slug(`${league}--${home}--${away}--${Date.now()}`);
    if(!window.ummaFire || !window.ummaFire.db) return alert('Database error');
    try{
        await setDoc(doc(window.ummaFire.db, 'fixtures', id), {id, league, home, away, date, squads: {}, updatedAtMs: Date.now()}, {merge: true});
        await renderFixtures();
        await renderHomeHighlights();
        await renderAdminSummary();
        alert('Fixture created');
    } catch(err){
        console.error('createFixture error', err);
        alert('Error creating fixture: ' + err.message);
    }
}

function removeLeagueData(leagueName){
    let leagues = JSON.parse(storageGet('leagues')) || [];
    leagues = leagues.filter(l=> l.name !== leagueName);
    storageSet('leagues', JSON.stringify(leagues));

    let teams = JSON.parse(storageGet('teams')) || [];
    teams = teams.filter(t=> t.league !== leagueName);
    storageSet('teams', JSON.stringify(teams));

    let standings = JSON.parse(storageGet('standings')) || [];
    standings = standings.filter(s=> s.league !== leagueName);
    storageSet('standings', JSON.stringify(standings));

    let fixtures = JSON.parse(storageGet('fixtures')) || [];
    fixtures = fixtures.filter(f=> f.league !== leagueName);
    storageSet('fixtures', JSON.stringify(fixtures));
}

function formatFixtureDate(dateObj){
    const y = dateObj.getFullYear();
    const m = String(dateObj.getMonth() + 1).padStart(2, '0');
    const d = String(dateObj.getDate()).padStart(2, '0');
    const h = String(dateObj.getHours()).padStart(2, '0');
    const min = String(dateObj.getMinutes()).padStart(2, '0');
    return `${y}-${m}-${d} ${h}:${min}`;
}

function getSemesterStartForLeague(leagueName){
    const leagues = JSON.parse(storageGet('leagues')) || [];
    const index = Math.max(0, leagues.findIndex(l=> l.name === leagueName));
    const start = new Date(2026, 1, 3, 15, 0, 0, 0);
    start.setDate(start.getDate() + (index * 2));
    return start;
}

function autoPlanFixturesForLeague(leagueName){
    const teams = (JSON.parse(storageGet('teams')) || [])
        .filter(t=> t.league === leagueName)
        .map(t=> t.teamName)
        .sort((a,b)=> a.localeCompare(b));
    if(teams.length < 2) return;

    const fixtures = JSON.parse(storageGet('fixtures')) || [];
    const leagueFixtures = fixtures.filter(f=> f.league === leagueName);
    const existingPairs = new Set(leagueFixtures.map(f=> [f.home, f.away].sort().join('::')));

    let created = 0;
    let sequence = leagueFixtures.length;
    const semesterStart = getSemesterStartForLeague(leagueName);

    for(let i = 0; i < teams.length; i++){
        for(let j = i + 1; j < teams.length; j++){
            const home = teams[i];
            const away = teams[j];
            const pair = [home, away].sort().join('::');
            if(existingPairs.has(pair)) continue;

            const date = new Date(semesterStart);
            date.setDate(date.getDate() + (sequence * 7));
            fixtures.push({
                id: Date.now() + sequence + created,
                league: leagueName,
                home,
                away,
                date: formatFixtureDate(date),
                squads:{}
            });
            existingPairs.add(pair);
            created++;
            sequence++;
        }
    }

    if(created > 0){
        storageSet('fixtures', JSON.stringify(fixtures));
        renderHomeHighlights();
    }
}

function renderAdminSummary(){
    const summary = document.getElementById('adminSummary');
    if(!summary) return;
    const leagues = JSON.parse(storageGet('leagues')) || [];
    const teams = JSON.parse(storageGet('teams')) || [];
    const fixtures = JSON.parse(storageGet('fixtures')) || [];
    const players = getPlayers();
    summary.innerHTML = `<div>Leagues: ${leagues.length}</div><div>Teams: ${teams.length}</div><div>Fixtures: ${fixtures.length}</div><div>Players: ${players.length}</div>`;
    populateAdminTeamsLeagueFilter();
    renderAdminTeams();
}

function populateAdminTeamsLeagueFilter(){
    const sel = document.getElementById('adminTeamsLeagueFilter');
    if(!sel) return;
    const leagues = (JSON.parse(storageGet('leagues')) || [])
        .map((l)=> l.name)
        .filter(Boolean)
        .sort((a,b)=> String(a).localeCompare(String(b)));
    const previous = sel.value || '';
    sel.innerHTML = '';
    sel.appendChild(new Option('Select league', ''));
    leagues.forEach((league)=> sel.appendChild(new Option(league, league)));
    if(previous && leagues.includes(previous)){
        sel.value = previous;
    }
}

function renderAdminTeams(){
    const body = document.getElementById('adminTeamsBody');
    if(!body) return;
    const selectedLeague = document.getElementById('adminTeamsLeagueFilter')?.value || '';
    const teams = (JSON.parse(storageGet('teams')) || [])
        .filter((t)=> selectedLeague && t.league === selectedLeague);
    body.innerHTML = '';
    if(!selectedLeague){
        const tr = document.createElement('tr');
        tr.innerHTML = '<td colspan="4" class="muted">Select a league to view registered teams.</td>';
        body.appendChild(tr);
        return;
    }
    if(teams.length === 0){
        const tr = document.createElement('tr');
        tr.innerHTML = `<td colspan="4" class="muted">No teams registered in ${selectedLeague}.</td>`;
        body.appendChild(tr);
        return;
    }
    teams.forEach((t)=>{
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td>${t.teamName}</td>
            <td>${t.league}</td>
            <td>${t.status || 'Pending Payment'}</td>
            <td>
                <button class="btn btn-primary" data-action="activate" data-team="${t.teamName}" style="margin-right:6px">Activate</button>
                <button class="btn" data-action="pending" data-team="${t.teamName}" style="margin-right:6px">Pending</button>
                <button class="btn btn-outline" data-action="withdraw" data-team="${t.teamName}" style="margin-right:6px;color:#6b6b6b;border-color:#ddd">Withdraw</button>
                <button class="btn btn-outline" data-action="delete" data-team="${t.teamName}" style="color:#b00020;border-color:#efc7ce">Delete</button>
            </td>
        `;
        body.appendChild(tr);
    });
}

function saveClubEdits(){
    const club = sessionStorage.getItem('currentClub');
    if(!club) return alert('Not logged in');
    const coach = document.getElementById('editCoach').value.trim();
    const phone = document.getElementById('editPhone').value.trim();
    const status = document.getElementById('editStatus').value;
    const teams = JSON.parse(storageGet('teams')) || [];
    const idx = teams.findIndex(t=> t.teamName === club);
    if(idx === -1) return alert('Team not found');
    if(coach) teams[idx].coachName = coach;
    if(phone) teams[idx].phone = phone;
    teams[idx].status = status;
    storageSet('teams', JSON.stringify(teams));
    document.getElementById('editClubForm').style.display = 'none';
    renderRegisteredTeams();
    alert('Team information updated');
}

// Updated auth/registration flow: teams create email + password at registration.
async function registerTeam(){
    const teamName = document.getElementById('teamName').value.trim();
    const coachName = document.getElementById('coachName').value.trim();
    const phone = document.getElementById('phone').value.trim();
    const mpesaRef = document.getElementById('mpesaRef')?.value.trim() || '';
    const email = document.getElementById('accountEmail')?.value.trim().toLowerCase();
    const password = document.getElementById('accountPassword')?.value || '';
    const passwordConfirm = document.getElementById('accountPasswordConfirm')?.value || '';
    const league = document.getElementById('league').value;
    const requiresMpesa = requiresMpesaRefForLeague(league);

    if(!teamName || !coachName || !phone || !email || !password || !passwordConfirm || !league || (requiresMpesa && !mpesaRef)){
        alert('Please fill all fields');
        return;
    }
    if(!isValidEmail(email)){
        alert('Enter a valid email address');
        return;
    }
    if(requiresMpesa && mpesaRef.length < 6){
        alert('Enter a valid M-Pesa reference');
        return;
    }
    if(password.length < 4){
        alert('Password must be at least 4 characters');
        return;
    }
    if(password !== passwordConfirm){
        alert('Passwords do not match');
        return;
    }

    // Check if team already exists by fetching teams from Firestore
    const teams = await fetchCollection('teams');
    if(teams.find((t)=> t.teamName.toLowerCase() === teamName.toLowerCase())){
        alert('Team name already registered');
        return;
    }

    const accounts = await getAccounts();
    if(accounts.find((a)=> String(a.email || '').toLowerCase() === email.toLowerCase())){
        alert('Email already taken');
        return;
    }
    if(accounts.find((a)=> String(a.team || '').toLowerCase() === teamName.toLowerCase())){
        alert('This team already has an account');
        return;
    }
    if(!window.ummaAuth?.registerAuthUser){
        alert('Authentication service is not ready. Reload and try again.');
        return;
    }
    try{
        await window.ummaAuth.registerAuthUser(email, password);
    } catch (err){
        const code = String(err?.code || '');
        if(code.includes('email-already-in-use')){
            alert('Email already used in authentication');
        } else if(code.includes('weak-password')){
            alert('Password is too weak for authentication');
        } else {
            alert('Could not create authentication account. Try again.');
        }
        return;
    }

    // Write directly to Firestore - this is the source of truth
    if(window.ummaFire && window.ummaFire.db){
        try{
            const { db } = window.ummaFire;
            const currentUser = window.ummaAuth.getAuthUser();
            const userId = currentUser ? currentUser.uid : slug(email);
            
            // Write team data
            await setDoc(doc(db, 'teams', userId), {
                id: userId,
                ownerUid: userId,
                teamName,
                coachName,
                phone,
                league,
                mpesaRef: requiresMpesa ? mpesaRef : '',
                feePaid: requiresMpesa ? 500 : 0,
                paymentStatus: requiresMpesa ? 'Pending' : 'Free',
                status: requiresMpesa ? 'Pending Payment' : 'Active',
                updatedAtMs: Date.now()
            }, { merge: true });
            
            // Write user account data
            await setDoc(doc(db, 'users', userId), {
                id: userId,
                email,
                role: 'club',
                team: teamName,
                teamId: userId,
                updatedAtMs: Date.now()
            }, { merge: true });
            
            console.log('Team registered in Firestore:', userId, teamName);
        } catch(err){
            console.error('Firestore registration write failed', err);
            alert('Error saving to database. Please try again.');
            return;
        }
    } else {
        alert('Database not initialized. Please reload and try again.');
        return;
    }

    // Update local accounts list for UI feedback
    accounts.push({team: teamName, email, role:'club'});
    await saveAccounts(accounts);
    
    setCurrentClub(teamName);

    if(window.ummaRemoteStore?.flushNow){
        try{
            await window.ummaRemoteStore.flushNow();
        } catch {
            // Ignore remote flush errors
        }
    }
    
    clearForm();
    alert('Team registered successfully! Redirecting to club portal.');
    setTimeout(()=> window.location.href = 'club.html', 500);
}


function clearForm(){
    document.getElementById('teamName').value = '';
    document.getElementById('coachName').value = '';
    document.getElementById('phone').value = '';
    const mpesa = document.getElementById('mpesaRef');
    const email = document.getElementById('accountEmail');
    const pass = document.getElementById('accountPassword');
    const confirmPass = document.getElementById('accountPasswordConfirm');
    if(mpesa) mpesa.value = '';
    if(email) email.value = '';
    if(pass) pass.value = '';
    if(confirmPass) confirmPass.value = '';
    document.getElementById('league').value = '';
    updateRegistrationPaymentUI();
}

// Expose registerTeam for compatibility (if any inline handlers exist)
window.registerTeam = registerTeam;



import { doc, getDoc, setDoc, deleteDoc, getDocs, collection, query, where } from "https://www.gstatic.com/firebasejs/12.10.0/firebase-firestore.js";

document.addEventListener("DOMContentLoaded", ()=>{ initClubPortal(); });

let currentUser = null;
let currentTeam = null;
let currentLeagueView = "";
let portalLockedForPayment = true;
const WEEKLY_MAINTENANCE_TILL = "7312380";
const WEEKLY_MAINTENANCE_AMOUNT = 200;
const CLUB_CACHE_TTL_MS = 5000;
const clubCache = {
    fixtures: { team: "", data: [], expiresAt: 0, inFlight: null },
    players: { team: "", data: [], expiresAt: 0, inFlight: null }
};

function invalidateClubCache(type){
    if(!type){
        clubCache.fixtures = { team: "", data: [], expiresAt: 0, inFlight: null };
        clubCache.players = { team: "", data: [], expiresAt: 0, inFlight: null };
        return;
    }
    clubCache[type] = { team: "", data: [], expiresAt: 0, inFlight: null };
}

async function getTeamFixtures(teamName, options = {}){
    const team = String(teamName || "");
    const force = Boolean(options.force);
    const now = Date.now();
    const cache = clubCache.fixtures;
    if(!force && cache.team === team && cache.expiresAt > now){
        return cache.data;
    }
    if(!force && cache.team === team && cache.inFlight){
        return cache.inFlight;
    }
    const loadPromise = (async ()=>{
        const [homeSnap, awaySnap] = await Promise.all([
            getDocs(query(collection(window.ummaFire.db, "fixtures"), where("home", "==", team))),
            getDocs(query(collection(window.ummaFire.db, "fixtures"), where("away", "==", team)))
        ]);
        const data = [...homeSnap.docs, ...awaySnap.docs].map((d)=> ({ id: d.id, ...d.data() }));
        clubCache.fixtures = { team, data, expiresAt: Date.now() + CLUB_CACHE_TTL_MS, inFlight: null };
        return data;
    })();
    clubCache.fixtures = { team, data: [], expiresAt: 0, inFlight: loadPromise };
    return loadPromise;
}

async function getTeamPlayers(teamName, options = {}){
    const team = String(teamName || "");
    const force = Boolean(options.force);
    const now = Date.now();
    const cache = clubCache.players;
    if(!force && cache.team === team && cache.expiresAt > now){
        return cache.data;
    }
    if(!force && cache.team === team && cache.inFlight){
        return cache.inFlight;
    }
    const loadPromise = (async ()=>{
        const snap = await getDocs(query(collection(window.ummaFire.db, "players"), where("team", "==", team)));
        const data = snap.docs.map((d)=> ({ id: d.id, ...d.data() }));
        clubCache.players = { team, data, expiresAt: Date.now() + CLUB_CACHE_TTL_MS, inFlight: null };
        return data;
    })();
    clubCache.players = { team, data: [], expiresAt: 0, inFlight: loadPromise };
    return loadPromise;
}

function appUrl(path){
    if(window.ummaNav?.buildAppUrl){
        return window.ummaNav.buildAppUrl(path);
    }
    return new URL(String(path || "index.html"), window.location.href).toString();
}

function slug(value){
    return String(value || "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "") || "item";
}

function setText(id, value){
    const el = document.getElementById(id);
    if(el) el.textContent = String(value ?? "");
}

function getCurrentClub(){
    try{
        return localStorage.getItem("umma.currentClub") || "";
    } catch {
        return "";
    }
}

function setCurrentClub(teamName){
    try{
        localStorage.setItem("umma.currentClub", String(teamName || ""));
    } catch {}
}

function clearCurrentClub(){
    try{
        localStorage.removeItem("umma.currentClub");
    } catch {}
}

function openClubSection(sectionId){
    const sections = document.querySelectorAll(".club-panel");
    const links = document.querySelectorAll(".menu-link[data-target]");
    const paymentBanner = document.getElementById("clubPaymentBanner");
    sections.forEach((section)=>{
        section.style.display = section.id === sectionId ? "block" : "none";
    });
    if(paymentBanner){
        paymentBanner.style.display = sectionId === "clubProfileSection" ? "block" : "none";
    }
    links.forEach((btn)=>{
        btn.classList.toggle("active", btn.dataset.target === sectionId);
    });
}

function collapseSpaces(v){
    return String(v || "").replace(/\s+/g, " ").trim();
}

function getPaymentLabel(team){
    const status = String(team?.status || "");
    const paymentStatus = String(team?.paymentStatus || "").trim();
    const feePaid = Number(team?.feePaid || 0);
    if(paymentStatus) return paymentStatus;
    if(feePaid <= 0) return "Free";
    if(status === "Active") return "Paid";
    if(status === "Pending Payment") return "Pending";
    return "-";
}

function getCurrentWeekLabel(){
    const now = new Date();
    const onejan = new Date(now.getFullYear(), 0, 1);
    const week = Math.ceil((((now - onejan) / 86400000) + onejan.getDay() + 1) / 7);
    return `Week ${week}`;
}

function getCurrentWeekKey(){
    const now = new Date();
    const onejan = new Date(now.getFullYear(), 0, 1);
    const week = Math.ceil((((now - onejan) / 86400000) + onejan.getDay() + 1) / 7);
    return `${now.getFullYear()}-W${String(week).padStart(2, "0")}`;
}

function isWeeklyPaymentValid(team){
    const payment = team?.maintenancePayment || {};
    const weekKey = getCurrentWeekKey();
    const ref = collapseSpaces(payment.mpesaRef || "");
    return Boolean(ref) && payment.weekKey === weekKey;
}

function applyPortalLockState(){
    const lockText = portalLockedForPayment
        ? `Pay KES ${WEEKLY_MAINTENANCE_AMOUNT} to Till ${WEEKLY_MAINTENANCE_TILL}. Enter M-Pesa ref to unlock.`
        : `M-Pesa ref received. Portal unlocked.`;
    setText("clubPortalLockNotice", lockText);
    const links = document.querySelectorAll(".menu-link[data-target]");
    links.forEach((btn)=>{
        const isProfile = btn.dataset.target === "clubProfileSection";
        btn.title = portalLockedForPayment && !isProfile
            ? "Complete weekly payment to unlock this section."
            : "";
    });
}

function renderWeeklyPaymentStatus(team){
    const payment = team?.maintenancePayment || {};
    const statusEl = document.getElementById("weeklyPaymentStatus");
    const input = document.getElementById("weeklyMpesaRefInput");
    if(!statusEl) return;

    if(isWeeklyPaymentValid(team)){
        const submitted = payment.submittedAtMs ? new Date(payment.submittedAtMs).toLocaleString() : "recently";
        statusEl.textContent = `Paid for ${payment.weekLabel || getCurrentWeekLabel()}. Ref: ${payment.mpesaRef} (${submitted}).`;
        if(input) input.value = "";
        return;
    }
    statusEl.textContent = `${getCurrentWeekLabel()}: pay and enter your M-Pesa ref.`;
}

function ensurePortalUnlocked(){
    if(!portalLockedForPayment) return true;
    alert(`Pay KES ${WEEKLY_MAINTENANCE_AMOUNT} to Till ${WEEKLY_MAINTENANCE_TILL}, then enter M-Pesa ref first.`);
    return false;
}

async function initClubPortal(){
    bindClubEvents();
    if(!window.ummaAuth?.onAuthStateChanged){
        setText("clubAuthNotice", "Authentication service unavailable.");
        return;
    }
    window.ummaAuth.onAuthStateChanged(async (user)=>{
        currentUser = user || null;
        if(!currentUser){
            clearCurrentClub();
            document.getElementById("clubPortalApp").style.display = "none";
            document.getElementById("clubAuthNotice").style.display = "block";
            return;
        }
        await renderClubPortal();
    });
}

function bindClubEvents(){
    const logoutBtn = document.getElementById("clubLogoutBtn");
    const saveInfoBtn = document.getElementById("saveClubInfoBtn");
    const addPlayerBtn = document.getElementById("addPlayerBtn");
    const saveSotwBtn = document.getElementById("saveSotwBtn");
    const postMatchSquadBtn = document.getElementById("postMatchSquadBtn");
    const playersBody = document.getElementById("clubPlayersBody");
    const leagueViewSelect = document.getElementById("clubLeagueViewSelect");
    const menuBtn = document.getElementById("clubHamburgerBtn");
    const menuPanel = document.getElementById("clubMenuPanel");
    const menuLinks = document.querySelectorAll(".menu-link[data-target]");
    const submitWeeklyPaymentBtn = document.getElementById("submitWeeklyPaymentBtn");

    if(logoutBtn){
        logoutBtn.addEventListener("click", async ()=>{
            clearCurrentClub();
            try{ await window.ummaAuth.logoutAuthUser?.(); } catch {}
            window.location.href = appUrl("index.html#login");
        });
    }
    if(saveInfoBtn) saveInfoBtn.addEventListener("click", saveClubInfo);
    if(addPlayerBtn) addPlayerBtn.addEventListener("click", addPlayer);
    if(saveSotwBtn) saveSotwBtn.addEventListener("click", saveSquadOfWeek);
    if(postMatchSquadBtn) postMatchSquadBtn.addEventListener("click", postMatchSquad);
    if(submitWeeklyPaymentBtn) submitWeeklyPaymentBtn.addEventListener("click", submitWeeklyPayment);
    if(leagueViewSelect){
        leagueViewSelect.addEventListener("change", async ()=>{
            currentLeagueView = leagueViewSelect.value || "";
            await renderSquadFixtureSelect();
            await renderClubFixtures();
            await renderClubStandings();
            await renderSotwHistory();
        });
    }
    if(menuBtn && menuPanel){
        const closeMenu = ()=>{
            menuPanel.classList.remove("open");
            menuBtn.setAttribute("aria-expanded", "false");
        };
        closeMenu();
        menuBtn.addEventListener("click", ()=>{
            const opened = menuPanel.classList.toggle("open");
            menuBtn.setAttribute("aria-expanded", opened ? "true" : "false");
        });
        document.addEventListener("click", (event)=>{
            if(!menuPanel.classList.contains("open")) return;
            if(menuPanel.contains(event.target) || menuBtn.contains(event.target)) return;
            closeMenu();
        });
    }
    menuLinks.forEach((btn)=>{
        btn.addEventListener("click", ()=>{
            openClubSection(btn.dataset.target);
            if(menuPanel && menuBtn){
                menuPanel.classList.remove("open");
                menuBtn.setAttribute("aria-expanded", "false");
            }
        });
    });
    if(playersBody){
        playersBody.addEventListener("click", (e)=>{
            const btn = e.target.closest('button[data-action="remove-player"]');
            if(!btn) return;
            const playerName = btn.dataset.player;
            if(playerName) removePlayer(playerName);
        });
    }
}

async function findTeamForUser(uid){
    const byOwner = await getDocs(query(collection(window.ummaFire.db, "teams"), where("ownerUid", "==", uid)));
    if(!byOwner.empty) return byOwner.docs[0];
    const byDocId = await getDoc(doc(window.ummaFire.db, "teams", uid));
    if(byDocId.exists()) return byDocId;
    return null;
}

async function renderClubPortal(){
    if(!window.ummaFire?.db){
        alert("Database is not ready. Reload and try again.");
        return;
    }
    if(!currentUser){
        window.location.href = appUrl("index.html#login");
        return;
    }

    try{
        const teamDoc = await findTeamForUser(currentUser.uid);
        if(!teamDoc){
            alert("Club profile not found.");
            window.location.href = appUrl("index.html#register");
            return;
        }
        currentTeam = { id: teamDoc.id, ...teamDoc.data() };
        currentLeagueView = currentTeam.league || "";
        setCurrentClub(currentTeam.teamName || currentTeam.name || "");
        portalLockedForPayment = !isWeeklyPaymentValid(currentTeam);

        document.getElementById("clubAuthNotice").style.display = "none";
        document.getElementById("clubPortalApp").style.display = "block";
        setText("clubTillNumberTop", WEEKLY_MAINTENANCE_TILL);
        setText("clubPaymentNoticeText", `Pay KES ${WEEKLY_MAINTENANCE_AMOUNT} to Till ${WEEKLY_MAINTENANCE_TILL}. Enter your M-Pesa ref below.`);
        applyPortalLockState();
        renderWeeklyPaymentStatus(currentTeam);
        openClubSection("clubProfileSection");

        setText("clubNameHeading", currentTeam.teamName || currentTeam.name || "Club");
        setText("clubLeague", currentTeam.league || "-");
        setText("clubStatus", currentTeam.status || "-");
        setText("clubPayment", getPaymentLabel(currentTeam));
        setText("clubCoach", currentTeam.coachName || "-");
        setText("clubPhone", currentTeam.phone || "-");

        const coachInput = document.getElementById("clubCoachInput");
        const phoneInput = document.getElementById("clubPhoneInput");
        if(coachInput) coachInput.value = currentTeam.coachName || "";
        if(phoneInput) phoneInput.value = currentTeam.phone || "";

        await renderLeagueViewSelect(currentTeam);
        await Promise.all([
            renderPlayers(),
            renderSquadFixtureSelect(),
            renderSquadPlayerChecks(),
            renderClubFixtures(),
            renderClubStandings(),
            renderSotwHistory()
        ]);
    } catch(err){
        console.error("renderClubPortal error", err);
        alert("Error loading club portal.");
    }
}

async function renderLeagueViewSelect(team){
    const select = document.getElementById("clubLeagueViewSelect");
    if(!select) return;

    const options = new Set();
    if(team?.league) options.add(team.league);
    const teamName = team.teamName || team.name || "";

    const [fixtures, leaguesSnap] = await Promise.all([
        getTeamFixtures(teamName),
        getDocs(collection(window.ummaFire.db, "leagues"))
    ]);

    fixtures.forEach((f)=>{
        const league = collapseSpaces(f.league || "");
        if(league) options.add(league);
    });

    leaguesSnap.docs.forEach((d)=>{
        const leagueName = collapseSpaces(d.data()?.name || "");
        if(leagueName) options.add(leagueName);
    });

    const leagues = [...options].sort((a,b)=> String(a).localeCompare(String(b)));
    select.innerHTML = "";
    if(leagues.length === 0){
        select.appendChild(new Option("No leagues found", ""));
        currentLeagueView = "";
        return;
    }
    leagues.forEach((league)=> select.appendChild(new Option(league, league)));
    if(!currentLeagueView && leagues.length) currentLeagueView = leagues[0];
    select.value = leagues.includes(currentLeagueView) ? currentLeagueView : leagues[0];
    currentLeagueView = select.value || "";
}

async function saveClubInfo(){
    if(!ensurePortalUnlocked()) return;
    if(!currentTeam?.id) return;
    const coach = collapseSpaces(document.getElementById("clubCoachInput")?.value || "");
    const phone = collapseSpaces(document.getElementById("clubPhoneInput")?.value || "");
    try{
        await setDoc(doc(window.ummaFire.db, "teams", currentTeam.id), {
            coachName: coach,
            phone,
            updatedAtMs: Date.now()
        }, { merge: true });
        currentTeam.coachName = coach;
        currentTeam.phone = phone;
        setText("clubCoach", coach || "-");
        setText("clubPhone", phone || "-");
        alert("Club info saved.");
    } catch(err){
        console.error("saveClubInfo error", err);
        alert("Failed to save club info.");
    }
}

async function renderPlayers(){
    const clubName = getCurrentClub();
    const body = document.getElementById("clubPlayersBody");
    if(!clubName || !body) return;
    const players = (await getTeamPlayers(clubName)).sort((a,b)=> String(a.name).localeCompare(String(b.name)));
    body.innerHTML = "";
    players.forEach((p)=>{
        const tr = document.createElement("tr");
        tr.innerHTML = `<td>${String(p.name || "")}</td><td>${String(p.position || "-")}</td><td><button class="btn btn-primary" data-action="remove-player" data-player="${String(p.name || "")}">Remove</button></td>`;
        body.appendChild(tr);
    });
}

async function addPlayer(){
    if(!ensurePortalUnlocked()) return;
    const clubName = getCurrentClub();
    const input = document.getElementById("newPlayerInput");
    const positionInput = document.getElementById("newPlayerPosition");
    const playerName = collapseSpaces(input?.value || "");
    const position = collapseSpaces(positionInput?.value || "");
    if(!clubName || !playerName) return alert("Enter player name.");
    if(!position) return alert("Select player position.");

    const id = `${slug(clubName)}__${slug(playerName)}`;
    try{
        await setDoc(doc(window.ummaFire.db, "players", id), {
            id,
            name: playerName,
            position,
            team: clubName,
            ownerUid: currentUser?.uid || null,
            updatedAtMs: Date.now()
        }, { merge: true });
        invalidateClubCache("players");
        if(input) input.value = "";
        if(positionInput) positionInput.value = "";
        await renderPlayers();
        await renderSquadPlayerChecks();
    } catch(err){
        console.error("addPlayer error", err);
        alert("Failed to add player.");
    }
}

async function removePlayer(playerName){
    if(!ensurePortalUnlocked()) return;
    const clubName = getCurrentClub();
    if(!clubName) return;
    const id = `${slug(clubName)}__${slug(playerName)}`;
    try{
        await deleteDoc(doc(window.ummaFire.db, "players", id));
        invalidateClubCache("players");
        await renderPlayers();
        await renderSquadPlayerChecks();
    } catch(err){
        console.error("removePlayer error", err);
        alert("Failed to remove player.");
    }
}

async function renderSquadFixtureSelect(){
    const select = document.getElementById("squadFixtureSelect");
    if(!select) return;
    const clubName = getCurrentClub();
    if(!clubName) return;

    const fixtures = (await getTeamFixtures(clubName))
        .filter((f)=> !currentLeagueView || f.league === currentLeagueView)
        .sort((a,b)=> String(a.date || "").localeCompare(String(b.date || "")));

    select.innerHTML = "";
    select.appendChild(new Option("Select fixture", ""));
    fixtures.forEach((f)=>{
        const label = `${f.home} vs ${f.away} (${f.date || "No date"})`;
        select.appendChild(new Option(label, f.id));
    });
}

async function renderSquadPlayerChecks(){
    const host = document.getElementById("squadPlayerChecks");
    if(!host) return;
    const clubName = getCurrentClub();
    if(!clubName) return;

    const players = (await getTeamPlayers(clubName))
        .filter((p)=> p.name)
        .sort((a,b)=> String(a.name).localeCompare(String(b.name)));
    host.innerHTML = "";
    players.forEach((player)=>{
        const name = String(player.name);
        const position = collapseSpaces(player.position || "");
        const row = document.createElement("label");
        row.style.display = "block";
        row.innerHTML = `<input type="checkbox" data-role="starter" value="${name}"> ${name}${position ? ` (${position})` : ""}`;
        host.appendChild(row);
    });
    const countEl = document.getElementById("squadStarterCount");
    if(countEl) countEl.textContent = "Starters selected: 0";
    host.onchange = ()=>{
        const checked = host.querySelectorAll('input[data-role="starter"]:checked').length;
        if(countEl) countEl.textContent = `Starters selected: ${checked}`;
    };
}

function getSelectedStarters(){
    return [...document.querySelectorAll('#squadPlayerChecks input[data-role="starter"]:checked')]
        .map((el)=> el.value)
        .filter(Boolean);
}

function parseSubs(value){
    return String(value || "")
        .split(",")
        .map((v)=> collapseSpaces(v))
        .filter(Boolean);
}

function getSelectedFixtureId(){
    return document.getElementById("squadFixtureSelect")?.value || "";
}

async function saveSquadOfWeek(){
    if(!ensurePortalUnlocked()) return;
    const fixtureId = getSelectedFixtureId();
    const starters = getSelectedStarters();
    const subs = parseSubs(document.getElementById("squadSubsInput")?.value || "");
    const weekLabel = collapseSpaces(document.getElementById("squadWeekLabel")?.value || getCurrentWeekLabel());
    const clubName = getCurrentClub();

    if(!fixtureId) return alert("Select a fixture.");
    if(starters.length === 0) return alert("Select at least one starter.");

    try{
        const fixtureRef = doc(window.ummaFire.db, "fixtures", fixtureId);
        const fixtureSnap = await getDoc(fixtureRef);
        if(!fixtureSnap.exists()) return alert("Fixture not found.");
        const fixture = fixtureSnap.data();
        const nextSquads = { ...(fixture.squads || {}) };
        nextSquads[clubName] = { starters, subs, weekLabel, updatedAtMs: Date.now() };
        await setDoc(fixtureRef, { squads: nextSquads, updatedAtMs: Date.now() }, { merge: true });
        invalidateClubCache("fixtures");
        alert("Squad of the week saved.");
        await renderSotwHistory();
    } catch(err){
        console.error("saveSquadOfWeek error", err);
        alert("Failed to save squad.");
    }
}

async function postMatchSquad(){
    if(!ensurePortalUnlocked()) return;
    await saveSquadOfWeek();
    await renderClubFixtures();
}

async function submitWeeklyPayment(){
    if(!currentTeam?.id) return;
    const input = document.getElementById("weeklyMpesaRefInput");
    const mpesaRef = collapseSpaces(input?.value || "");
    if(!mpesaRef) return alert("Enter M-Pesa reference.");

    const weekKey = getCurrentWeekKey();
    const payment = {
        weekKey,
        weekLabel: getCurrentWeekLabel(),
        amount: WEEKLY_MAINTENANCE_AMOUNT,
        tillNumber: WEEKLY_MAINTENANCE_TILL,
        mpesaRef,
        submittedAtMs: Date.now(),
        verificationStatus: "Pending Verification"
    };
    try{
        const existingHistory = Array.isArray(currentTeam.maintenancePaymentHistory)
            ? currentTeam.maintenancePaymentHistory
            : [];
        const filteredHistory = existingHistory.filter((row)=> String(row?.weekKey || "") !== weekKey);
        const maintenancePaymentHistory = [payment, ...filteredHistory]
            .sort((a,b)=> Number(b?.submittedAtMs || 0) - Number(a?.submittedAtMs || 0))
            .slice(0, 20);
        await setDoc(doc(window.ummaFire.db, "teams", currentTeam.id), {
            maintenancePayment: payment,
            maintenancePaymentHistory,
            paymentStatus: "Pending Verification",
            updatedAtMs: Date.now()
        }, { merge: true });
        currentTeam.maintenancePayment = payment;
        currentTeam.maintenancePaymentHistory = maintenancePaymentHistory;
        currentTeam.paymentStatus = "Pending Verification";
        portalLockedForPayment = false;
        setText("clubPayment", getPaymentLabel(currentTeam));
        applyPortalLockState();
        renderWeeklyPaymentStatus(currentTeam);
        alert("Weekly payment reference submitted. Portal unlocked.");
    } catch(err){
        console.error("submitWeeklyPayment error", err);
        alert("Failed to submit payment reference.");
    }
}

async function renderClubFixtures(){
    const body = document.getElementById("clubFixturesBody");
    if(!body) return;
    const clubName = getCurrentClub();
    if(!clubName) return;

    const fixtures = (await getTeamFixtures(clubName))
        .filter((f)=> !currentLeagueView || f.league === currentLeagueView)
        .sort((a,b)=> String(a.date || "").localeCompare(String(b.date || "")));

    body.innerHTML = "";
    fixtures.forEach((f)=>{
        const tr = document.createElement("tr");
        tr.innerHTML = `<td>${String(f.league || "-")}</td><td>${String(f.home || "-")} vs ${String(f.away || "-")}</td><td>${String(f.date || "-")}</td><td>${String(f.status || "Scheduled")}</td>`;
        body.appendChild(tr);
    });
}

async function renderClubStandings(){
    const body = document.getElementById("clubStandingsBody");
    if(!body) return;
    if(!currentLeagueView){
        body.innerHTML = '<tr><td colspan="8" class="muted">Select a league to view standings.</td></tr>';
        return;
    }

    const snap = await getDocs(query(collection(window.ummaFire.db, "standings"), where("league", "==", currentLeagueView)));
    const rows = snap.docs.map((d)=> d.data())
        .sort((a,b)=> Number(b.pts || 0) - Number(a.pts || 0) || Number(b.gd || 0) - Number(a.gd || 0));
    body.innerHTML = "";
    rows.forEach((row, idx)=>{
        const tr = document.createElement("tr");
        tr.innerHTML = `<td>${idx + 1}</td><td>${String(row.team || "-")}</td><td>${Number(row.p || 0)}</td><td>${Number(row.w || 0)}</td><td>${Number(row.d || 0)}</td><td>${Number(row.l || 0)}</td><td>${Number(row.gd || 0)}</td><td>${Number(row.pts || 0)}</td>`;
        body.appendChild(tr);
    });
}

async function renderSotwHistory(){
    const body = document.getElementById("sotwHistoryBody");
    if(!body) return;
    const clubName = getCurrentClub();
    if(!clubName) return;

    const fixtures = await getTeamFixtures(clubName);
    const records = fixtures
        .filter((f)=> !currentLeagueView || f.league === currentLeagueView)
        .map((f)=>{
            const squad = f.squads?.[clubName];
            if(!squad) return null;
            const starters = Array.isArray(squad.starters) ? squad.starters : [];
            const subs = Array.isArray(squad.subs) ? squad.subs : [];
            return {
                week: squad.weekLabel || getCurrentWeekLabel(),
                fixture: `${f.home} vs ${f.away}`,
                players: `${starters.join(", ")}${subs.length ? ` | Subs: ${subs.join(", ")}` : ""}`
            };
        })
        .filter(Boolean);

    body.innerHTML = "";
    if(records.length === 0){
        body.innerHTML = '<tr><td colspan="3" class="muted">No saved squad history yet.</td></tr>';
        return;
    }
    records.forEach((r)=>{
        const tr = document.createElement("tr");
        tr.innerHTML = `<td>${String(r.week)}</td><td>${String(r.fixture)}</td><td>${String(r.players)}</td>`;
        body.appendChild(tr);
    });
}

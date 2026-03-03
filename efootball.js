import { doc, setDoc, getDoc, getDocs, collection, query, where } from "https://www.gstatic.com/firebasejs/12.10.0/firebase-firestore.js";

const EF_LEAGUES = [
    { id: "ef-umma-premier", name: "Umma Premier League", fee: 200 },
    { id: "ef-umma-champions", name: "Umma Champions League", fee: 200 },
    { id: "ef-umma-carabao", name: "Umma Carabao Cup", fee: 200 },
    { id: "ef-umma-kajiado", name: "Umma Kajiado Cup", fee: 200 },
    { id: "ef-friendly-league", name: "Friendly League", fee: 0 }
];
const EF_PAYMENT_TILL = "7312380";

document.addEventListener("DOMContentLoaded", ()=>{ initEfootball(); });

let currentUser = null;
let currentPlayer = null;
let currentLeague = "";
let currentMenuTarget = "efFixturesSection";
const EF_COLLECTIONS = {
    leagues: "efootball_leagues",
    fixtures: "efootball_fixtures",
    users: "efootball_users",
    players: "efootball_players",
    results: "efootball_results",
    standings: "efootball_standings"
};

function slug(value){
    return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "item";
}

function scoreText(result){
    if(!result || !Number.isFinite(Number(result.homeGoals)) || !Number.isFinite(Number(result.awayGoals))) return "-";
    return `${Number(result.homeGoals)} - ${Number(result.awayGoals)}`;
}

function getLeagueByName(name){
    return EF_LEAGUES.find((l)=> l.name === name) || null;
}

async function initEfootball(){
    bindUi();
    applyLeagueOptions(EF_LEAGUES);
    await ensureLeagues();
    await renderLeagueSelects();
    const initialTarget = getAuthPanelFromHash();
    if(initialTarget === "login-modal"){
        openLoginModal();
    } else {
        setAuthPanelVisible(initialTarget);
    }

    if(window.ummaAuth?.onAuthStateChanged){
        window.ummaAuth.onAuthStateChanged(async (user)=>{
            currentUser = user || null;
            if(!currentUser){
                currentPlayer = null;
                document.getElementById("efLogoutBtn").style.display = "none";
                document.getElementById("efOpenRegisterBtn").style.display = "inline-block";
                document.getElementById("efOpenLoginBtn").style.display = "inline-block";
                document.getElementById("efAccountCard").style.display = "none";
                document.getElementById("efMyMatchesCard").style.display = "none";
                closeLoginModal();
                setAuthPanelVisible("");
                await renderFixtures();
                await renderResults();
                await renderStandings();
                applyMenuView(currentMenuTarget);
                return;
            }
            await resolveCurrentPlayer();
            if(!currentPlayer){
                document.getElementById("efLogoutBtn").style.display = "inline-block";
                document.getElementById("efOpenRegisterBtn").style.display = "inline-block";
                document.getElementById("efOpenLoginBtn").style.display = "inline-block";
                document.getElementById("efAccountCard").style.display = "none";
                document.getElementById("efMyMatchesCard").style.display = "none";
                closeLoginModal();
                setAuthPanelVisible("efRegisterCard");
                await renderFixtures();
                await renderResults();
                await renderStandings();
                applyMenuView(currentMenuTarget);
                return;
            }
            document.getElementById("efLogoutBtn").style.display = "inline-block";
            document.getElementById("efOpenRegisterBtn").style.display = "none";
            document.getElementById("efOpenLoginBtn").style.display = "none";
            document.getElementById("efAccountCard").style.display = "none";
            document.getElementById("efMyMatchesCard").style.display = "block";
            closeLoginModal();
            setAuthPanelVisible("");
            await renderAccount();
            await renderFixtures();
            await renderResults();
            await renderStandings();
            await renderMyMatches();
            applyMenuView(currentMenuTarget);
        });
    }
}

function getAuthPanelFromHash(){
    const hash = String(window.location.hash || "").toLowerCase();
    if(hash === "#login" || hash === "#eflogin") return "login-modal";
    if(hash === "#register" || hash === "#efregister") return "efRegisterCard";
    return "";
}

function applyLeagueOptions(leagues){
    const regSelect = document.getElementById("efLeagueSelect");
    const viewSelect = document.getElementById("efLeagueView");
    const fixturesSelect = document.getElementById("efFixturesLeagueView");
    const resultsSelect = document.getElementById("efResultsLeagueView");
    const safeLeagues = Array.isArray(leagues) ? leagues : [];

    if(regSelect){
        const previous = regSelect.value || "";
        regSelect.innerHTML = "";
        regSelect.appendChild(new Option("Select League", ""));
        safeLeagues.forEach((league)=>{
            regSelect.appendChild(new Option(`${league.name} (Ksh ${Number(league.fee ?? 200)})`, league.name));
        });
        if(previous && safeLeagues.some((league)=> league.name === previous)){
            regSelect.value = previous;
        }
    }

    if(viewSelect){
        const previous = viewSelect.value || "";
        viewSelect.innerHTML = "";
        safeLeagues.forEach((league)=> viewSelect.appendChild(new Option(league.name, league.name)));
        if(previous && safeLeagues.some((league)=> league.name === previous)){
            viewSelect.value = previous;
            currentLeague = previous;
        } else if(safeLeagues.length){
            viewSelect.value = safeLeagues[0].name;
            currentLeague = safeLeagues[0].name;
        }
    }
    if(fixturesSelect){
        const previous = fixturesSelect.value || "";
        fixturesSelect.innerHTML = "";
        safeLeagues.forEach((league)=> fixturesSelect.appendChild(new Option(league.name, league.name)));
        if(previous && safeLeagues.some((league)=> league.name === previous)){
            fixturesSelect.value = previous;
        } else if(currentLeague && safeLeagues.some((league)=> league.name === currentLeague)){
            fixturesSelect.value = currentLeague;
        } else if(safeLeagues.length){
            fixturesSelect.value = safeLeagues[0].name;
        }
    }
    if(resultsSelect){
        const previous = resultsSelect.value || "";
        resultsSelect.innerHTML = "";
        safeLeagues.forEach((league)=> resultsSelect.appendChild(new Option(league.name, league.name)));
        if(previous && safeLeagues.some((league)=> league.name === previous)){
            resultsSelect.value = previous;
        } else if(currentLeague && safeLeagues.some((league)=> league.name === currentLeague)){
            resultsSelect.value = currentLeague;
        } else if(safeLeagues.length){
            resultsSelect.value = safeLeagues[0].name;
        }
    }
}

function syncLeagueSelectors(league){
    const value = String(league || "");
    const ids = ["efLeagueView", "efFixturesLeagueView", "efResultsLeagueView"];
    ids.forEach((id)=>{
        const sel = document.getElementById(id);
        if(!sel) return;
        if([...sel.options].some((opt)=> opt.value === value)){
            sel.value = value;
        }
    });
}

function bindUi(){
    const menuBtn = document.getElementById("efMenuBtn");
    const menuPanel = document.getElementById("efMenuPanel");
    const menuLoginBtn = document.getElementById("efMenuLoginBtn");
    const openLoginBtn = document.getElementById("efOpenLoginBtn");
    const openRegisterBtn = document.getElementById("efOpenRegisterBtn");
    const closeLoginBtn = document.getElementById("efCloseLogin");
    document.getElementById("efRegisterBtn")?.addEventListener("click", registerPlayer);
    document.getElementById("efLoginBtn")?.addEventListener("click", loginPlayer);
    if(openLoginBtn){
        openLoginBtn.addEventListener("click", ()=> openLoginModal());
    }
    if(menuLoginBtn){
        menuLoginBtn.addEventListener("click", ()=>{
            openLoginModal();
            if(menuPanel) menuPanel.classList.remove("open");
        });
    }
    if(openRegisterBtn){
        openRegisterBtn.addEventListener("click", ()=>{
            closeLoginModal();
            setAuthPanelVisible("efRegisterCard");
        });
    }
    if(closeLoginBtn){
        closeLoginBtn.addEventListener("click", closeLoginModal);
    }
    document.getElementById("efLoginModal")?.addEventListener("click", (event)=>{
        if(event.target?.id === "efLoginModal"){
            closeLoginModal();
        }
    });
    if(menuBtn && menuPanel){
        menuBtn.addEventListener("click", ()=> menuPanel.classList.toggle("open"));
    }
    document.querySelectorAll(".menu-link[data-target]").forEach((btn)=>{
        btn.addEventListener("click", ()=>{
            const target = btn.dataset.target || "";
            closeLoginModal();
            applyMenuView(target);
            if(menuPanel) menuPanel.classList.remove("open");
        });
    });
    document.getElementById("efLogoutBtn")?.addEventListener("click", async ()=>{
        try{ await window.ummaAuth.logoutAuthUser(); } catch {}
    });
    async function onLeagueChange(value){
        currentLeague = String(value || "");
        syncLeagueSelectors(currentLeague);
        await renderFixtures();
        await renderResults();
        await renderStandings();
        await renderMyMatches();
    }
    document.getElementById("efLeagueView")?.addEventListener("change", async (e)=> onLeagueChange(e.target.value || ""));
    document.getElementById("efFixturesLeagueView")?.addEventListener("change", async (e)=> onLeagueChange(e.target.value || ""));
    document.getElementById("efResultsLeagueView")?.addEventListener("change", async (e)=> onLeagueChange(e.target.value || ""));
    document.getElementById("efLeagueSelect")?.addEventListener("change", updateEfootballRegistrationPaymentUI);
    applyMenuView(currentMenuTarget);
}

function openLoginModal(){
    const modal = document.getElementById("efLoginModal");
    if(modal) modal.style.display = "flex";
}

function closeLoginModal(){
    const modal = document.getElementById("efLoginModal");
    if(modal) modal.style.display = "none";
}

function setAuthPanelVisible(target){
    const safeTarget = target === "efRegisterCard" ? target : "";
    if(safeTarget){
        const card = document.getElementById(safeTarget);
        if(!card) return;
        applyMenuView(safeTarget);
        card.scrollIntoView({ behavior: "smooth", block: "start" });
    } else if(currentMenuTarget === "efRegisterCard"){
        applyMenuView("efFixturesSection");
    }
}

function scrollToSection(id){
    const section = document.getElementById(id);
    if(section){
        section.scrollIntoView({ behavior: "smooth", block: "start" });
    }
}

function applyMenuView(target){
    currentMenuTarget = target || "efFixturesSection";
    const registerCard = document.getElementById("efRegisterCard");
    const leagueCard = document.getElementById("efLeagueCard");
    const fixturesSection = document.getElementById("efFixturesSection");
    const resultsSection = document.getElementById("efResultsSection");
    const standingsSection = document.getElementById("efStandingsSection");
    const myMatchesCard = document.getElementById("efMyMatchesCard");

    const showRegister = currentMenuTarget === "efRegisterCard";
    const showFixtures = currentMenuTarget === "efFixturesSection";
    const showResults = currentMenuTarget === "efResultsSection";
    const showStandings = currentMenuTarget === "efStandingsSection";

    if(registerCard) registerCard.style.display = showRegister ? "block" : "none";
    if(leagueCard) leagueCard.style.display = showRegister ? "none" : "block";
    if(fixturesSection) fixturesSection.style.display = showFixtures ? "block" : "none";
    if(resultsSection) resultsSection.style.display = showResults ? "block" : "none";
    if(standingsSection) standingsSection.style.display = showStandings ? "block" : "none";
    if(myMatchesCard) myMatchesCard.style.display = (showFixtures && currentPlayer) ? "block" : "none";
}

async function ensureLeagues(){
    if(!window.ummaFire?.db) return;
    await Promise.all(EF_LEAGUES.map((league)=> setDoc(doc(window.ummaFire.db, EF_COLLECTIONS.leagues, league.id), {
        id: league.id,
        name: league.name,
        fee: league.fee,
        updatedAtMs: Date.now()
    }, { merge: true })));
}

async function renderLeagueSelects(){
    const leagues = await fetchLeagues();
    applyLeagueOptions(leagues);
    updateEfootballRegistrationPaymentUI();
}

function updateEfootballRegistrationPaymentUI(){
    const league = String(document.getElementById("efLeagueSelect")?.value || "").trim();
    const feeNote = document.getElementById("efRegisterFeeNote");
    const mpesaInput = document.getElementById("efMpesaRef");
    const fee = Number(getLeagueByName(league)?.fee || 0);
    const requiresMpesa = fee > 0;
    if(feeNote){
        feeNote.textContent = requiresMpesa
            ? `Player registration fee: Ksh ${fee} per league. Pay via M-Pesa till ${EF_PAYMENT_TILL}, then enter reference below.`
            : `Player registration fee: Free for Friendly League. M-Pesa till ${EF_PAYMENT_TILL} is not required for this league.`;
    }
    if(mpesaInput){
        mpesaInput.disabled = !requiresMpesa;
        mpesaInput.placeholder = requiresMpesa
            ? `M-Pesa Reference (after paying till ${EF_PAYMENT_TILL})`
            : "No M-Pesa reference required for Friendly League";
        if(!requiresMpesa){
            mpesaInput.value = "";
        }
    }
}

async function fetchLeagues(){
    const merged = new Map();
    EF_LEAGUES.forEach((league)=> merged.set(String(league.name).toLowerCase(), {
        id: league.id,
        name: league.name,
        fee: Number(league.fee ?? 200)
    }));

    if(!window.ummaFire?.db){
        return [...merged.values()].sort((a,b)=> String(a.name).localeCompare(String(b.name)));
    }

    try{
        const snap = await getDocs(collection(window.ummaFire.db, EF_COLLECTIONS.leagues));
        const rows = snap.docs.map((d)=> d.data()).filter((league)=> league?.name);
        const allowed = new Set(EF_LEAGUES.map((league)=> String(league.name).toLowerCase()));
        rows.forEach((league)=>{
            const key = String(league.name).toLowerCase();
            if(!allowed.has(key)) return;
            merged.set(key, {
                ...league,
                fee: Number(league.fee ?? 200)
            });
        });
    } catch {
        // Keep hardcoded leagues even if Firestore read fails.
    }

    // Force exactly the 5 hardcoded leagues in stable order.
    return EF_LEAGUES.map((league)=>{
        const fromMerged = merged.get(String(league.name).toLowerCase()) || {};
        return {
            id: fromMerged.id || league.id,
            name: league.name,
            fee: Number(league.fee || 0)
        };
    });
}

async function registerPlayer(){
    const playerName = String(document.getElementById("efPlayerName")?.value || "").trim();
    const phone = String(document.getElementById("efPhone")?.value || "").trim();
    const mpesaRef = String(document.getElementById("efMpesaRef")?.value || "").trim();
    const email = String(document.getElementById("efEmail")?.value || "").trim().toLowerCase();
    const password = String(document.getElementById("efPassword")?.value || "");
    const league = String(document.getElementById("efLeagueSelect")?.value || "").trim();
    const fee = Number(getLeagueByName(league)?.fee || 0);
    if(!playerName || !phone || !email || !password || !league){
        alert("Fill all registration fields.");
        return;
    }
    if(fee > 0 && !mpesaRef){
        alert("M-Pesa reference is required for paid leagues.");
        return;
    }
    if(!window.ummaAuth?.registerAuthUser){
        alert("Auth is not ready.");
        return;
    }
    try{
        await window.ummaAuth.registerAuthUser(email, password);
    } catch(err){
        const code = String(err?.code || "");
        if(code.includes("email-already-in-use")){
            alert("Email already in use.");
        } else {
            alert("Could not create account.");
        }
        return;
    }

    const user = window.ummaAuth.getAuthUser();
    if(!user){
        alert("Auth user missing after register.");
        return;
    }
    const playerId = user.uid;
    await setDoc(doc(window.ummaFire.db, EF_COLLECTIONS.players, playerId), {
        id: playerId,
        uid: playerId,
        playerName,
        phone,
        league,
        mpesaRef: fee > 0 ? mpesaRef : "",
        feePaid: fee,
        paymentStatus: fee > 0 ? "Paid" : "Free",
        status: "Active",
        email,
        updatedAtMs: Date.now()
    }, { merge: true });
    await setDoc(doc(window.ummaFire.db, EF_COLLECTIONS.users, playerId), {
        id: playerId,
        uid: playerId,
        email,
        playerName,
        phone,
        league,
        role: "player",
        status: "Active",
        updatedAtMs: Date.now()
    }, { merge: true });

    await ensurePlayerStandingsRow(playerName, league);
    await createFixturesForNewPlayer(playerName, league);
    alert("Registered successfully. You are now logged in.");
    await resolveCurrentPlayer();
    await renderAccount();
    await renderFixtures();
    await renderResults();
    await renderStandings();
    await renderMyMatches();
}

async function loginPlayer(){
    const email = String(document.getElementById("efLoginEmail")?.value || "").trim().toLowerCase();
    const password = String(document.getElementById("efLoginPassword")?.value || "");
    if(!email || !password){
        alert("Enter email and password.");
        return;
    }
    try{
        await window.ummaAuth.loginAuthUser(email, password);
    } catch {
        alert("Invalid login credentials.");
    }
}

async function resolveCurrentPlayer(){
    if(!currentUser) return null;
    const byUid = await getDoc(doc(window.ummaFire.db, EF_COLLECTIONS.players, currentUser.uid));
    if(byUid.exists()){
        currentPlayer = byUid.data();
        if(currentPlayer?.league){
            currentLeague = currentPlayer.league;
            syncLeagueSelectors(currentLeague);
        }
        return currentPlayer;
    }
    currentPlayer = null;
    return null;
}

async function renderAccount(){
    if(!currentPlayer){
        document.getElementById("efAccountCard").style.display = "none";
        return;
    }
    const info = document.getElementById("efAccountInfo");
    if(info){
        info.innerHTML = `
            <div><strong>Player:</strong> ${currentPlayer.playerName}</div>
            <div><strong>League:</strong> ${currentPlayer.league}</div>
            <div><strong>Payment:</strong> ${currentPlayer.paymentStatus || "-"}</div>
            <div><strong>Status:</strong> ${currentPlayer.status || "-"}</div>
        `;
    }
}

async function ensurePlayerStandingsRow(playerName, league){
    const id = `${slug(league)}__${slug(playerName)}`;
    await setDoc(doc(window.ummaFire.db, EF_COLLECTIONS.standings, id), {
        id,
        league,
        player: playerName,
        p: 0,
        w: 0,
        d: 0,
        l: 0,
        gd: 0,
        pts: 0,
        updatedAtMs: Date.now()
    }, { merge: true });
}

async function createFixturesForNewPlayer(playerName, league){
    const snap = await getDocs(query(collection(window.ummaFire.db, EF_COLLECTIONS.players), where("league", "==", league)));
    const players = snap.docs.map((d)=> d.data()).filter((p)=> p.playerName && p.playerName !== playerName);
    for(const p of players){
        const home = p.playerName;
        const away = playerName;
        const date = new Date(Date.now() + (Math.floor(Math.random() * 12) + 1) * 86400000);
        const dateText = `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,"0")}-${String(date.getDate()).padStart(2,"0")} 20:00`;
        const fixtureId = `${slug(league)}__${slug(home)}__${slug(away)}`;
        await setDoc(doc(window.ummaFire.db, EF_COLLECTIONS.fixtures, fixtureId), {
            id: fixtureId,
            league,
            home,
            away,
            date: dateText,
            status: "Scheduled",
            updatedAtMs: Date.now()
        }, { merge: true });
    }
}

function normalizeLeagueKey(value){
    return String(value || "").trim().toLowerCase();
}

async function fetchFixturesByLeague(league){
    if(!window.ummaFire?.db) return [];
    const selectedKey = normalizeLeagueKey(league);
    try{
        if(selectedKey){
            const snap = await getDocs(query(collection(window.ummaFire.db, EF_COLLECTIONS.fixtures), where("league", "==", league)));
            const exactRows = snap.docs.map((d)=> d.data());
            if(exactRows.length > 0){
                return exactRows.sort((a,b)=> String(a.date || "").localeCompare(String(b.date || "")));
            }
        }

        // Fallback: fetch all fixtures, then filter client-side (handles older mixed league text/casing).
        const allSnap = await getDocs(collection(window.ummaFire.db, EF_COLLECTIONS.fixtures));
        const rows = allSnap.docs.map((d)=> d.data());
        const filtered = selectedKey
            ? rows.filter((row)=> normalizeLeagueKey(row?.league) === selectedKey)
            : rows;
        return filtered.sort((a,b)=> String(a.date || "").localeCompare(String(b.date || "")));
    } catch {
        return [];
    }
}

async function renderFixtures(){
    const host = document.getElementById("efFixturesList");
    if(!host) return;
    const fixtures = await fetchFixturesByLeague(currentLeague);
    host.innerHTML = "";
    if(fixtures.length === 0){
        const leagueLabel = currentLeague ? currentLeague : "all leagues";
        host.innerHTML = `<li class="muted">No fixtures in ${leagueLabel} yet.</li>`;
        return;
    }
    fixtures.forEach((f)=>{
        const li = document.createElement("li");
        li.innerHTML = `<strong>${f.league || currentLeague}</strong> - ${f.home} vs ${f.away}`;
        host.appendChild(li);
    });
}

async function renderResults(){
    const host = document.getElementById("efResultsList");
    if(!host || !currentLeague) return;
    const fixtures = await fetchFixturesByLeague(currentLeague);
    const played = fixtures.filter((fixture)=>{
        const homeGoals = Number(fixture?.result?.homeGoals);
        const awayGoals = Number(fixture?.result?.awayGoals);
        return Number.isFinite(homeGoals) && Number.isFinite(awayGoals);
    });
    host.innerHTML = "";
    if(played.length === 0){
        host.innerHTML = `<li class="muted">No results in ${currentLeague} yet.</li>`;
        return;
    }
    played.forEach((fixture)=>{
        const li = document.createElement("li");
        li.innerHTML = `<strong>${fixture.league || currentLeague}</strong> - ${fixture.home} ${scoreText(fixture.result)} ${fixture.away}`;
        host.appendChild(li);
    });
}

async function renderMyMatches(){
    const body = document.getElementById("efMyMatchesBody");
    if(!body || !currentPlayer || !currentLeague) return;
    const fixtures = await fetchFixturesByLeague(currentLeague);
    const mine = fixtures.filter((f)=> f.home === currentPlayer.playerName || f.away === currentPlayer.playerName);
    body.innerHTML = "";
    if(mine.length === 0){
        body.innerHTML = '<tr><td colspan="3" class="muted">No personal fixtures yet.</td></tr>';
        return;
    }
    mine.forEach((f)=>{
        const tr = document.createElement("tr");
        tr.innerHTML = `
            <td>${f.home} vs ${f.away}</td>
            <td><input data-role="home-goals" data-id="${f.id}" type="number" min="0" placeholder="Home"> -
                <input data-role="away-goals" data-id="${f.id}" type="number" min="0" placeholder="Away"></td>
            <td><button class="btn btn-primary" data-action="submit-result" data-id="${f.id}">Submit</button></td>
        `;
        body.appendChild(tr);
    });
    body.querySelectorAll('button[data-action="submit-result"]').forEach((btn)=>{
        btn.addEventListener("click", async ()=>{
            const id = btn.dataset.id;
            const homeEl = body.querySelector(`input[data-role="home-goals"][data-id="${id}"]`);
            const awayEl = body.querySelector(`input[data-role="away-goals"][data-id="${id}"]`);
            const homeGoals = Number(homeEl?.value);
            const awayGoals = Number(awayEl?.value);
            if(!Number.isFinite(homeGoals) || !Number.isFinite(awayGoals) || homeGoals < 0 || awayGoals < 0){
                alert("Enter valid score values.");
                return;
            }
            await submitFixtureResult(id, homeGoals, awayGoals);
            await renderFixtures();
            await renderResults();
            await renderMyMatches();
            await renderStandings();
        });
    });
}

async function submitFixtureResult(fixtureId, homeGoals, awayGoals){
    const ref = doc(window.ummaFire.db, EF_COLLECTIONS.fixtures, fixtureId);
    const snap = await getDoc(ref);
    if(!snap.exists()){
        alert("Fixture not found.");
        return;
    }
    const fixture = snap.data();
    await setDoc(ref, {
        result: { homeGoals, awayGoals },
        status: "Played",
        updatedAtMs: Date.now()
    }, { merge: true });
    const resultId = `${fixtureId}__${slug(currentUser?.uid || "guest")}`;
    await setDoc(doc(window.ummaFire.db, EF_COLLECTIONS.results, resultId), {
        id: resultId,
        fixtureId,
        league: fixture.league,
        home: fixture.home,
        away: fixture.away,
        homeGoals,
        awayGoals,
        submittedBy: currentUser?.uid || null,
        submittedAt: new Date().toISOString(),
        updatedAtMs: Date.now()
    }, { merge: true });
    await recomputeStandings(fixture.league);
}

async function recomputeStandings(league){
    const playersSnap = await getDocs(query(collection(window.ummaFire.db, EF_COLLECTIONS.players), where("league", "==", league)));
    const playerNames = playersSnap.docs.map((d)=> d.data()?.playerName).filter(Boolean);
    const table = {};
    playerNames.forEach((name)=> table[name] = { league, player: name, p:0, w:0, d:0, l:0, gd:0, pts:0 });

    const fixtures = await fetchFixturesByLeague(league);
    fixtures.forEach((f)=>{
        if(!f?.result) return;
        const hg = Number(f.result.homeGoals);
        const ag = Number(f.result.awayGoals);
        if(!Number.isFinite(hg) || !Number.isFinite(ag)) return;
        if(!table[f.home]) table[f.home] = { league, player: f.home, p:0, w:0, d:0, l:0, gd:0, pts:0 };
        if(!table[f.away]) table[f.away] = { league, player: f.away, p:0, w:0, d:0, l:0, gd:0, pts:0 };
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

    await Promise.all(Object.values(table).map(async (row)=>{
        const id = `${slug(league)}__${slug(row.player)}`;
        await setDoc(doc(window.ummaFire.db, EF_COLLECTIONS.standings, id), {
            id,
            league: row.league,
            player: row.player,
            p: row.p,
            w: row.w,
            d: row.d,
            l: row.l,
            gd: row.gd,
            pts: row.pts,
            updatedAtMs: Date.now()
        }, { merge: true });
    }));
}

async function renderStandings(){
    const body = document.getElementById("efStandingsBody");
    if(!body || !currentLeague) return;
    const snap = await getDocs(query(collection(window.ummaFire.db, EF_COLLECTIONS.standings), where("league", "==", currentLeague)));
    const rows = snap.docs.map((d)=> d.data()).sort((a,b)=> Number(b.pts || 0) - Number(a.pts || 0) || Number(b.gd || 0) - Number(a.gd || 0));
    body.innerHTML = "";
    if(rows.length === 0){
        body.innerHTML = `<tr><td colspan="8" class="muted">No standings yet for ${currentLeague}.</td></tr>`;
        return;
    }
    rows.forEach((r, idx)=>{
        const tr = document.createElement("tr");
        tr.innerHTML = `<td>${idx+1}</td><td>${r.player || "-"}</td><td>${Number(r.p || 0)}</td><td>${Number(r.w || 0)}</td><td>${Number(r.d || 0)}</td><td>${Number(r.l || 0)}</td><td>${Number(r.gd || 0)}</td><td>${Number(r.pts || 0)}</td>`;
        body.appendChild(tr);
    });
}

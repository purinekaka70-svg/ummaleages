import { doc, setDoc, getDoc, getDocs, collection, query, where } from "https://www.gstatic.com/firebasejs/12.10.0/firebase-firestore.js";

const EF_LEAGUES = [
    { id: "ef-premier", name: "E-Football Premier League", fee: 200 },
    { id: "ef-champions", name: "E-Football Champions League", fee: 200 },
    { id: "ef-cup", name: "E-Football Cup", fee: 200 }
];

document.addEventListener("DOMContentLoaded", ()=>{ initEfootball(); });

let currentUser = null;
let currentPlayer = null;
let currentLeague = "";
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
    await ensureLeagues();
    await renderLeagueSelects();

    if(window.ummaAuth?.onAuthStateChanged){
        window.ummaAuth.onAuthStateChanged(async (user)=>{
            currentUser = user || null;
            if(!currentUser){
                currentPlayer = null;
                document.getElementById("efLogoutBtn").style.display = "none";
                document.getElementById("efAccountCard").style.display = "none";
                document.getElementById("efMyMatchesCard").style.display = "none";
                await renderFixtures();
                await renderStandings();
                return;
            }
            await resolveCurrentPlayer();
            document.getElementById("efLogoutBtn").style.display = "inline-block";
            document.getElementById("efAccountCard").style.display = "block";
            document.getElementById("efMyMatchesCard").style.display = "block";
            await renderAccount();
            await renderFixtures();
            await renderStandings();
            await renderMyMatches();
        });
    }
}

function bindUi(){
    document.getElementById("efRegisterBtn")?.addEventListener("click", registerPlayer);
    document.getElementById("efLoginBtn")?.addEventListener("click", loginPlayer);
    document.getElementById("efLogoutBtn")?.addEventListener("click", async ()=>{
        try{ await window.ummaAuth.logoutAuthUser(); } catch {}
    });
    document.getElementById("efLeagueView")?.addEventListener("change", async (e)=>{
        currentLeague = e.target.value || "";
        await renderFixtures();
        await renderStandings();
        await renderMyMatches();
    });
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
    const regSelect = document.getElementById("efLeagueSelect");
    const viewSelect = document.getElementById("efLeagueView");
    if(regSelect){
        regSelect.innerHTML = "";
        regSelect.appendChild(new Option("Select League (Ksh 200)", ""));
        leagues.forEach((l)=> regSelect.appendChild(new Option(`${l.name} (Ksh ${l.fee})`, l.name)));
    }
    if(viewSelect){
        const previous = viewSelect.value || "";
        viewSelect.innerHTML = "";
        leagues.forEach((l)=> viewSelect.appendChild(new Option(l.name, l.name)));
        if(previous && leagues.some((l)=> l.name === previous)){
            viewSelect.value = previous;
            currentLeague = previous;
        } else if(leagues.length){
            viewSelect.value = leagues[0].name;
            currentLeague = leagues[0].name;
        }
    }
}

async function fetchLeagues(){
    const snap = await getDocs(collection(window.ummaFire.db, EF_COLLECTIONS.leagues));
    const rows = snap.docs.map((d)=> d.data()).filter((l)=> l?.name);
    const merged = new Map();
    EF_LEAGUES.forEach((l)=> merged.set(l.name.toLowerCase(), l));
    rows.forEach((l)=> merged.set(String(l.name).toLowerCase(), { ...l, fee: Number(l.fee || 200) }));
    return [...merged.values()].sort((a,b)=> String(a.name).localeCompare(String(b.name)));
}

async function registerPlayer(){
    const playerName = String(document.getElementById("efPlayerName")?.value || "").trim();
    const phone = String(document.getElementById("efPhone")?.value || "").trim();
    const mpesaRef = String(document.getElementById("efMpesaRef")?.value || "").trim();
    const email = String(document.getElementById("efEmail")?.value || "").trim().toLowerCase();
    const password = String(document.getElementById("efPassword")?.value || "");
    const league = String(document.getElementById("efLeagueSelect")?.value || "").trim();
    if(!playerName || !phone || !mpesaRef || !email || !password || !league){
        alert("Fill all registration fields.");
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
    const fee = Number(getLeagueByName(league)?.fee || 200);
    await setDoc(doc(window.ummaFire.db, EF_COLLECTIONS.players, playerId), {
        id: playerId,
        uid: playerId,
        playerName,
        phone,
        league,
        mpesaRef,
        feePaid: fee,
        paymentStatus: "Paid",
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
    await renderStandings();
    await renderMyMatches();
}

async function loginPlayer(){
    const email = String(document.getElementById("efEmail")?.value || "").trim().toLowerCase();
    const password = String(document.getElementById("efPassword")?.value || "");
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
            const select = document.getElementById("efLeagueView");
            if(select && [...select.options].some((o)=> o.value === currentLeague)){
                select.value = currentLeague;
            }
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

async function fetchFixturesByLeague(league){
    const snap = await getDocs(query(collection(window.ummaFire.db, EF_COLLECTIONS.fixtures), where("league", "==", league)));
    return snap.docs.map((d)=> d.data()).sort((a,b)=> String(a.date || "").localeCompare(String(b.date || "")));
}

async function renderFixtures(){
    const body = document.getElementById("efFixturesBody");
    if(!body || !currentLeague) return;
    const fixtures = await fetchFixturesByLeague(currentLeague);
    body.innerHTML = "";
    if(fixtures.length === 0){
        body.innerHTML = `<tr><td colspan="4" class="muted">No fixtures in ${currentLeague} yet.</td></tr>`;
        return;
    }
    fixtures.forEach((f)=>{
        const tr = document.createElement("tr");
        tr.innerHTML = `<td>${f.league}</td><td>${f.home} vs ${f.away}</td><td>${f.status || "Scheduled"}</td><td>${scoreText(f.result)}</td>`;
        body.appendChild(tr);
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

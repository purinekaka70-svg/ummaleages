import { initializeApp, getApps, getApp } from "https://www.gstatic.com/firebasejs/12.10.0/firebase-app.js";
import { getAnalytics } from "https://www.gstatic.com/firebasejs/12.10.0/firebase-analytics.js";
import { getFirestore, doc, getDoc, setDoc, deleteField, onSnapshot, collection } from "https://www.gstatic.com/firebasejs/12.10.0/firebase-firestore.js";
import { getAuth, createUserWithEmailAndPassword, signInWithEmailAndPassword, signOut, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.10.0/firebase-auth.js";

const firebaseConfig = {
  apiKey: "AIzaSyAbyGOIlJa17LrF34kFe4GPER4tOMCwxLQ",
  authDomain: "ummaleague-5eb5a.firebaseapp.com",
  projectId: "ummaleague-5eb5a",
  storageBucket: "ummaleague-5eb5a.firebasestorage.app",
  messagingSenderId: "172077770370",
  appId: "1:172077770370:web:4fe8e4e384f9e823daf69b",
  measurementId: "G-5R5R2W23JN"
};

const app = getApps().length ? getApp() : initializeApp(firebaseConfig);
try {
    getAnalytics(app);
} catch {
    // Analytics can fail in local/file contexts; keep app running.
}

const db = getFirestore(app);
const auth = getAuth(app);
// expose for pages that need direct Firestore access
window.ummaFire = { db, auth };
const stateRef = doc(db, "umma_league", "state");
let cache = null;
let pending = {};
let timer = null;
let mirrorTimer = null;
let mirrorInFlight = false;
let mirrorQueued = false;
const subscribers = new Set();

async function loadState(){
    if(cache) return {...cache};
    const snap = await getDoc(stateRef);
    const data = snap.exists() ? (snap.data()?.data || {}) : {};
    cache = {...data};
    scheduleMirrorCollections();
    return {...cache};
}

function scheduleFlush(){
    if(timer) clearTimeout(timer);
    timer = setTimeout(flushNow, 400);
}

async function flushNow(){
    if(!pending || Object.keys(pending).length === 0) return;
    const payload = pending;
    pending = {};
    const patch = {};
    Object.keys(payload).forEach((k)=>{
        const v = payload[k];
        patch[`data.${k}`] = v === null ? deleteField() : v;
    });
    patch.updatedAtMs = Date.now();
    try{
        await setDoc(stateRef, patch, {merge: true});
    } catch(err){
        console.error('flushNow failed', err);
        throw err;
    }
    scheduleMirrorCollections();
}

function saveKey(key, value){
    if(!cache) cache = {};
    cache[key] = value;
    pending[key] = value;
    scheduleFlush();
}

function deleteKey(key){
    if(!cache) cache = {};
    delete cache[key];
    pending[key] = null;
    scheduleFlush();
}

function notifySubscribers(){
    const payload = {...(cache || {})};
    subscribers.forEach((fn)=>{
        try{
            fn(payload);
        } catch {
            // Ignore subscriber errors.
        }
    });
}

function toArray(raw){
    if(Array.isArray(raw)) return raw;
    if(typeof raw !== "string") return [];
    try{
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

function toObject(raw){
    if(raw && typeof raw === "object") return raw;
    if(typeof raw !== "string") return {};
    try{
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
        return {};
    }
}

function slug(value){
    return String(value || "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "") || "item";
}

function scheduleMirrorCollections(){
    if(mirrorTimer) clearTimeout(mirrorTimer);
    mirrorTimer = setTimeout(()=>{ mirrorCollectionsFromState(); }, 600);
}

async function mirrorCollectionsFromState(){
    if(mirrorInFlight){
        mirrorQueued = true;
        return;
    }
    mirrorInFlight = true;
    try{
        const state = cache || {};
        const teams = toArray(state.teams);
        const leagues = toArray(state.leagues);
        const fixtures = toArray(state.fixtures);
        const standings = toArray(state.standings);
        const players = toArray(state.players);
        const accounts = toArray(state.accounts);

        // Leagues
        await Promise.all(leagues.map((league)=>{
            const leagueId = String(league?.id || slug(league?.name));
            return setDoc(doc(db, "leagues", leagueId), {
                id: leagueId,
                name: league?.name || "",
                desc: league?.desc || "",
                updatedAtMs: Date.now()
            }, {merge: true});
        }));

        // Teams
        await Promise.all(teams.map((team)=>{
            const teamId = slug(team?.teamName);
            const leagueId = slug(team?.league);
            return setDoc(doc(db, "teams", teamId), {
                id: teamId,
                name: team?.teamName || "",
                leagueId,
                league: team?.league || "",
                ownerUid: team?.ownerUid || null,
                coachName: team?.coachName || "",
                phone: team?.phone || "",
                status: team?.status || "Pending Payment",
                paymentStatus: team?.paymentStatus || "",
                mpesaRef: team?.mpesaRef || "",
                feePaid: Number(team?.feePaid || 0),
                updatedAtMs: Date.now()
            }, {merge: true});
        }));

        // Fixtures + squads
        await Promise.all(fixtures.map(async (fixture)=>{
            const fixtureId = String(fixture?.id || `${slug(fixture?.league)}-${slug(fixture?.home)}-${slug(fixture?.away)}-${slug(fixture?.date)}`);
            await setDoc(doc(db, "fixtures", fixtureId), {
                id: fixtureId,
                leagueId: slug(fixture?.league),
                league: fixture?.league || "",
                homeTeamId: slug(fixture?.home),
                awayTeamId: slug(fixture?.away),
                home: fixture?.home || "",
                away: fixture?.away || "",
                date: fixture?.date || "",
                status: fixture?.status || "Scheduled",
                result: fixture?.result || null,
                updatedAtMs: Date.now()
            }, {merge: true});

            const squads = fixture?.squads && typeof fixture.squads === "object" ? fixture.squads : {};
            const squadEntries = Object.entries(squads);
            await Promise.all(squadEntries.map(([teamName, squadRaw])=>{
                const teamId = slug(teamName);
                const squadObj = Array.isArray(squadRaw)
                    ? {starters: squadRaw, subs: []}
                    : (squadRaw && typeof squadRaw === "object" ? squadRaw : {starters: [], subs: []});
                return setDoc(doc(db, "squads", fixtureId, "teams", teamId), {
                    teamId,
                    teamName,
                    starters: Array.isArray(squadObj.starters) ? squadObj.starters : [],
                    subs: Array.isArray(squadObj.subs) ? squadObj.subs : [],
                    updatedAtMs: Date.now()
                }, {merge: true});
            }));
        }));

        // Standings (subcollection by league)
        await Promise.all(standings.map((row)=>{
            const leagueId = slug(row?.league);
            const teamId = slug(row?.team);
            return setDoc(doc(db, "standings", leagueId, "rows", teamId), {
                leagueId,
                league: row?.league || "",
                teamId,
                team: row?.team || "",
                p: Number(row?.p || 0),
                w: Number(row?.w || 0),
                d: Number(row?.d || 0),
                l: Number(row?.l || 0),
                gd: Number(row?.gd || 0),
                pts: Number(row?.pts || 0),
                updatedAtMs: Date.now()
            }, {merge: true});
        }));

        // Players
        await Promise.all(players.map((player)=>{
            const playerId = `${slug(player?.team)}__${slug(player?.name)}`;
            return setDoc(doc(db, "players", playerId), {
                id: playerId,
                name: player?.name || "",
                team: player?.team || "",
                teamId: slug(player?.team),
                ownerUid: player?.ownerUid || null,
                updatedAtMs: Date.now()
            }, {merge: true});
        }));

        // Payments (derived from teams)
        await Promise.all(teams.map((team)=>{
            const teamId = slug(team?.teamName);
            return setDoc(doc(db, "payments", teamId), {
                id: teamId,
                teamId,
                team: team?.teamName || "",
                amount: Number(team?.feePaid || 0),
                status: team?.paymentStatus || (Number(team?.feePaid || 0) <= 0 ? "Free" : "Pending"),
                ref: team?.mpesaRef || "",
                paidAt: team?.paidAt || null,
                updatedAtMs: Date.now()
            }, {merge: true});
        }));

        // Users (state-derived profile index; Auth users remain in Firebase Auth)
        await Promise.all(accounts.map((acc)=>{
            const userId = acc?.email ? slug(acc.email) : slug(acc?.team || "user");
            return setDoc(doc(db, "users", userId), {
                id: userId,
                email: String(acc?.email || ""),
                role: String(acc?.role || "team"),
                team: String(acc?.team || ""),
                teamId: slug(acc?.team || ""),
                source: "state-sync",
                updatedAtMs: Date.now()
            }, {merge: true});
        }));
    } catch (err) {
        // log mirror errors so we can see permission/network issues
        console.error('mirrorCollectionsFromState failed', err);
        // Keep app functional even if mirror sync fails.
    } finally {
        mirrorInFlight = false;
        if(mirrorQueued){
            mirrorQueued = false;
            scheduleMirrorCollections();
        }
    }
}

function subscribeState(listener){
    if(typeof listener !== "function") return ()=>{};
    subscribers.add(listener);
    if(cache){
        try{
            listener({...cache});
        } catch {
            // Ignore listener errors.
        }
    }
    return ()=> subscribers.delete(listener);
}

onSnapshot(stateRef, (snap)=>{
    const data = snap.exists() ? (snap.data()?.data || {}) : {};
    cache = {...data};
    scheduleMirrorCollections();
    notifySubscribers();
});

window.ummaRemoteStore = {
    loadState,
    saveKey,
    deleteKey,
    flushNow,
    subscribeState
};

async function registerAuthUser(email, password){
    return createUserWithEmailAndPassword(auth, String(email || '').trim(), String(password || ''));
}

async function loginAuthUser(email, password){
    return signInWithEmailAndPassword(auth, String(email || '').trim(), String(password || ''));
}

async function logoutAuthUser(){
    return signOut(auth);
}

function getAuthUser(){
    return auth.currentUser || null;
}

window.ummaAuth = {
    registerAuthUser,
    loginAuthUser,
    logoutAuthUser,
    getAuthUser,
    onAuthStateChanged: (cb)=> onAuthStateChanged(auth, cb)
};

window.dispatchEvent(new CustomEvent("umma:bridge-ready"));

// ---------------- Firebase Imports ----------------
import { initializeApp, getApps, getApp } from "https://www.gstatic.com/firebasejs/12.10.0/firebase-app.js";
import { getAnalytics } from "https://www.gstatic.com/firebasejs/12.10.0/firebase-analytics.js";
import { getFirestore, doc, getDoc, setDoc, deleteField, onSnapshot } from "https://www.gstatic.com/firebasejs/12.10.0/firebase-firestore.js";
import { getAuth, createUserWithEmailAndPassword, signInWithEmailAndPassword, signOut, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.10.0/firebase-auth.js";

// ---------------- Firebase Config ----------------
const firebaseConfig = {
  apiKey: "AIzaSyAbyGOIlJa17LrF34kFe4GPER4tOMCwxLQ",
  authDomain: "ummaleague-5eb5a.firebaseapp.com",
  projectId: "ummaleague-5eb5a",
  storageBucket: "ummaleague-5eb5a.appspot.com",
  messagingSenderId: "172077770370",
  appId: "1:172077770370:web:4fe8e4e384f9e823daf69b",
  measurementId: "G-5R5R2W23JN"
};

const app = getApps().length ? getApp() : initializeApp(firebaseConfig);
try { getAnalytics(app); } catch {}
const db = getFirestore(app);
const auth = getAuth(app);

function buildAppUrl(path = "index.html"){
  const clean = String(path || "index.html").replace(/^\.?\//, "");
  return new URL(clean, window.location.href).toString();
}

// ---------------- State Handling ----------------
const stateRef = doc(db, "umma_league", "state");
let cache = null;
let pending = {};
let timer = null;
let mirrorTimer = null;
let mirrorInFlight = false;
let mirrorQueued = false;
const subscribers = new Set();

// Helper: Ensure a value is always an array
function toArray(raw){
  if(!raw) return [];
  if(Array.isArray(raw)) return raw;
  if(typeof raw === "string"){
    try{ return JSON.parse(raw) || []; } catch { return []; }
  }
  return [];
}

// Helper: Slugify for Firestore IDs
function slug(value){
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-+|-+$/g,"") || "item";
}

// Load state from Firestore
async function loadState(){
  if(cache) return {...cache};
  const snap = await getDoc(stateRef);
  const data = snap.exists() ? (snap.data()?.data || {}) : {};
  cache = {...data};
  scheduleMirrorCollections();
  return {...cache};
}

async function reloadState(){
  cache = null;
  return loadState();
}

// Save/update key in state
function saveKey(key, value){
  if(!cache) cache = {};
  cache[key] = value;
  pending[key] = value;
  scheduleFlush();
  scheduleMirrorCollections();
}

// Delete key from state
function deleteKey(key){
  if(!cache) cache = {};
  delete cache[key];
  pending[key] = null;
  scheduleFlush();
  scheduleMirrorCollections();
}

// Schedule flush to Firestore
function scheduleFlush(){
  if(timer) clearTimeout(timer);
  timer = setTimeout(flushNow, 400);
}

// Flush pending changes to Firestore
async function flushNow(){
  if(!pending || Object.keys(pending).length === 0) return;
  const payload = {...pending};
  pending = {};
  const patch = {};
  Object.keys(payload).forEach(k=>{
    patch[`data.${k}`] = payload[k] === null ? deleteField() : payload[k];
  });
  patch.updatedAtMs = Date.now();
  await setDoc(stateRef, patch, {merge:true});
  scheduleMirrorCollections();
  notifySubscribers();
}

// Notify subscribers of state changes
function notifySubscribers(){
  const payload = {...(cache || {})};
  subscribers.forEach(fn=>{
    try{ fn(payload); } catch(e){ console.error(e); }
  });
}

// Subscribe to state changes
function subscribeState(listener){
  if(typeof listener !== "function") return ()=>{};
  subscribers.add(listener);
  if(cache) listener({...cache});
  return ()=> subscribers.delete(listener);
}

// ---------------- Mirror Collections ----------------
function scheduleMirrorCollections(){
  if(mirrorTimer) clearTimeout(mirrorTimer);
  mirrorTimer = setTimeout(mirrorCollectionsFromState, 600);
}

async function mirrorCollectionsFromState(){
  if(mirrorInFlight){ mirrorQueued = true; return; }
  mirrorInFlight = true;

  try{
    const state = cache || {};
    const teams = toArray(state.teams);
    const leagues = toArray(state.leagues);
    const fixtures = toArray(state.fixtures);
    const standings = toArray(state.standings);
    const players = toArray(state.players);
    const accounts = toArray(state.accounts);

    // --- Leagues ---
    await Promise.all(leagues.map(l=>{
      const leagueId = slug(l.name);
      return setDoc(doc(db,"leagues",leagueId),{
        id: leagueId,
        name: l.name||"",
        desc: l.desc||"",
        updatedAtMs: Date.now()
      },{merge:true});
    }));

    // --- Teams ---
    await Promise.all(teams.map(t=>{
      // Prefer auth UID-based IDs to avoid duplicate team docs.
      const teamId = String(t.ownerUid || t.id || slug(t.teamName));
      const leagueId = slug(t.league);
      return setDoc(doc(db,"teams",teamId),{
        id: teamId,
        name: t.teamName||"",
        leagueId,
        league: t.league||"",
        ownerUid: t.ownerUid||null,
        coachName: t.coachName||"",
        phone: t.phone||"",
        status: t.status||"Pending Payment",
        paymentStatus: t.paymentStatus||"",
        mpesaRef: t.mpesaRef||"",
        feePaid: Number(t.feePaid||0),
        updatedAtMs: Date.now()
      },{merge:true});
    }));

    // --- Players ---
    await Promise.all(players.map(p=>{
      const playerId = `${slug(p.team)}__${slug(p.name)}`;
      return setDoc(doc(db,"players",playerId),{
        id: playerId,
        name: p.name||"",
        team: p.team||"",
        teamId: slug(p.team),
        ownerUid: p.ownerUid||null,
        updatedAtMs: Date.now()
      },{merge:true});
    }));

    // --- Accounts/Users ---
    await Promise.all(accounts.map(a=>{
      // Prefer stable UID/id when available; fall back to email/team slug.
      const userId = String(a.uid || a.id || a.ownerUid || slug(a.email||a.team||"user"));
      return setDoc(doc(db,"users",userId),{
        id: userId,
        uid: String(a.uid || a.id || ""),
        email: String(a.email||""),
        role: String(a.role||"team"),
        team: String(a.team||""),
        teamId: slug(a.team||""),
        source: "state-sync",
        updatedAtMs: Date.now()
      },{merge:true});
    }));

  } catch(err){
    console.error("Mirror error:",err);
  } finally {
    mirrorInFlight=false;
    if(mirrorQueued){
      mirrorQueued=false;
      scheduleMirrorCollections();
    }
  }
}

// ---------------- Firestore Real-time ----------------
onSnapshot(stateRef, snap=>{
  cache = snap.exists() ? snap.data()?.data || {} : {};
  scheduleMirrorCollections();
  notifySubscribers();
});

// ---------------- Auth Helpers ----------------
async function registerAuthUser(email,password){
  return createUserWithEmailAndPassword(auth,String(email).trim(),String(password));
}

async function loginAuthUser(email,password){
  return signInWithEmailAndPassword(auth,String(email).trim(),String(password));
}

async function logoutAuthUser(){
  return signOut(auth);
}

function getAuthUser(){ return auth.currentUser || null; }

// ---------------- Expose API ----------------
window.ummaRemoteStore = {
  loadState,
  reloadState,
  saveKey,
  deleteKey,
  flushNow,
  subscribeState
};

window.ummaFire = { app, db, auth };

window.ummaAuth = {
  registerAuthUser,
  loginAuthUser,
  logoutAuthUser,
  getAuthUser,
  onAuthStateChanged: cb=> onAuthStateChanged(auth,cb)
};

window.ummaNav = {
  buildAppUrl,
  goTo: (path)=>{ window.location.href = buildAppUrl(path); }
};

window.dispatchEvent(new CustomEvent("umma:bridge-ready"));

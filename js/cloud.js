/* =====================================================================
   CLOUD SYNC (Firebase). Put your project's config in firebaseConfig
   below, then deploy (see README "Cloud sync"). Safe to commit: these
   values identify the project and are not secrets. Access is enforced by
   Firebase Auth + firestore.rules (each user can only touch ledgers/{uid}).
   Talks to the app only through window.CloudBridge (see js/app.js).
   ===================================================================== */
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged,
         setPersistence, browserLocalPersistence } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";
import { getFirestore, doc, getDoc, setDoc, onSnapshot } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

// ============ PASTE YOUR FIREBASE CONFIG HERE ============
const firebaseConfig = {
  apiKey: "AIzaSyCufGxkKs9Lj-p_2KUSt25tlNSk5No2LeQ",
  authDomain: "investmenttracker-b544e.firebaseapp.com",
  projectId: "investmenttracker-b544e",
  storageBucket: "investmenttracker-b544e.firebasestorage.app",
  messagingSenderId: "550008652473",
  appId: "1:550008652473:web:0cecd578732c5fabcc5168"
};
// ========================================================

const bridge = window.CloudBridge;
const setStatus = (t) => bridge && bridge.setStatus(t);
const configured = !!bridge && !String(firebaseConfig.apiKey).startsWith("PASTE_");
window.Cloud = Object.assign(window.Cloud || {}, { configured, signedIn: false, email: null, status: "" });

function start() {
  const app = initializeApp(firebaseConfig);
  const auth = getAuth(app);
  const db = getFirestore(app);
  const provider = new GoogleAuthProvider();
  let ref = null, unsub = null, pushTimer = null, applying = false, lastPushedAt = 0;

  // Apply a remote doc without echoing it back to the cloud.
  function applyRemote(remote) {
    applying = true;
    try { bridge.applyRemote(remote); } finally { applying = false; }
  }

  function pushNow() {
    if (!ref) return;
    const payload = bridge.getPayload();
    lastPushedAt = payload.updatedAt;
    setDoc(ref, payload)
      .then(() => setStatus("synced"))
      .catch((e) => { console.warn("Cloud push failed:", e && e.code); setStatus("sync error"); });
  }

  window.Cloud.signIn = async () => {
    try { await setPersistence(auth, browserLocalPersistence); await signInWithPopup(auth, provider); }
    catch (e) { setStatus("sign-in failed"); alert("Sign-in failed: " + (e.code || e.message)); }
  };
  window.Cloud.signOut = async () => {
    try { await signOut(auth); } catch (e) { console.warn("Sign-out failed:", e && e.code); }
  };
  // called by save() on every synced-data change
  window.Cloud.onLocalSave = () => {
    if (applying || !ref) return;
    setStatus("saving…");
    clearTimeout(pushTimer); pushTimer = setTimeout(pushNow, 800);
  };
  // manual overrides for resolving two devices that drifted apart
  window.Cloud.forcePush = () => {
    if (!ref) { alert("Sign in first."); return; }
    bridge.bumpUpdatedAt();   // make this device unambiguously newest
    setStatus("uploading…"); pushNow();
  };
  window.Cloud.forcePull = async () => {
    if (!ref) { alert("Sign in first."); return; }
    setStatus("loading…");
    try {
      const snap = await getDoc(ref);
      if (snap.exists()) { applyRemote(snap.data()); setStatus("loaded from cloud"); }
      else setStatus("cloud is empty");
    } catch (e) { setStatus("sync error"); }
  };

  function subscribe() {
    if (unsub) unsub();
    unsub = onSnapshot(ref, (snap) => {
      if (!snap.exists()) return;
      if (snap.metadata.hasPendingWrites) return;                         // our own just-written change
      const remote = snap.data();
      if (remote.updatedAt && remote.updatedAt === lastPushedAt) return;  // echo of our write
      applyRemote(remote);
      setStatus("synced");
    }, () => setStatus("sync error"));
  }

  onAuthStateChanged(auth, async (user) => {
    if (!user) {
      window.Cloud.signedIn = false; window.Cloud.email = null;
      if (unsub) { unsub(); unsub = null; }
      ref = null;
      setStatus("");
      return;
    }
    window.Cloud.signedIn = true; window.Cloud.email = user.email || user.displayName || "account";
    ref = doc(db, "ledgers", user.uid);
    setStatus("connecting…");
    try {
      const snap = await getDoc(ref);
      const remote = snap.exists() ? snap.data() : null;
      const remoteHasData = !!remote && Array.isArray(remote.transactions) && remote.transactions.length > 0;
      const localHasData = bridge.getLocalTxnCount() > 0;
      const remoteT = (remote && remote.updatedAt) || 0;
      // Newest wins: load the cloud if it's newer (or local is empty);
      // otherwise upload this device's data over the older cloud copy.
      if (remoteHasData && (!localHasData || remoteT > bridge.getLocalUpdatedAt())) {
        applyRemote(remote);
        setStatus("loaded newer cloud data");
      } else if (localHasData) {
        pushNow();
      } else if (remoteHasData) {
        applyRemote(remote);
      }
    } catch (e) { setStatus("sync error"); }
    subscribe();
    setStatus("synced");
  });
}

if (configured) {
  try { start(); }
  catch (e) {
    window.Cloud.configured = false;
    console.error("Cloud sync init failed:", e);
  }
}
setStatus(window.Cloud.status);

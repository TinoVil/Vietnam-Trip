/* ============================================================================
   Vietnam 2026 · sync layer
   ----------------------------------------------------------------------------
   Shared   : trips/vietnam2026                 — the plan (meta/items/days)
   Personal : trips/vietnam2026/members/{uid}   — todos, bingo, journal
              (the travel checklist is just the "pre" to-dos — one list)

   Design rules this file must never break:

   1. SYNC IS AN ENHANCEMENT, NEVER A DEPENDENCY. If Firebase fails to load
      (offline first-run, blocked, misconfigured), the app must keep working
      exactly as it does today from localStorage. Everything here is wrapped
      so a failure degrades to "local only" instead of a blank screen.
   2. PERSONAL DOCS HAVE EXACTLY ONE WRITER (their owner), so they can't
      conflict. The shared plan can have two, so it's last-write-wins on
      savedAt.
   3. Never merge one person's personal data into another's.
============================================================================ */

const SDK = "https://www.gstatic.com/firebasejs/10.13.2";
const TRIP_ID = "vietnam2026";

const firebaseConfig = {
  apiKey: "AIzaSyBVXAbW74B8yD4trgmhWzdBR8toZOri5Lo",
  authDomain: "vietnamtrip26-73b1a.firebaseapp.com",
  projectId: "vietnamtrip26-73b1a",
  storageBucket: "vietnamtrip26-73b1a.firebasestorage.app",
  messagingSenderId: "270631792097",
  appId: "1:270631792097:web:d518b35e6a37a62e4bb6a0"
};

const BUILDER_LS_KEY = "vietnam_itinerary_builder_v2";
const PERSONAL_KEYS = ["todos", "bingo", "journal"];

const listeners = new Set();
/* `available` rides on the state itself. Readers must never have to reach back
   into window.VNSync at render time — that's a race, since the SDK finishes
   loading between emits. */
const state = { status: "connecting", user: null, error: null, available: false };

function emit() {
  state.detail = statusText();
  state.available = api.available;
  listeners.forEach(fn => { try { fn(state); } catch (e) {} });
  /* This module is deferred, so the pages' inline scripts run BEFORE it and
     can't subscribe directly. Broadcast instead — they just listen. */
  window.dispatchEvent(new CustomEvent("vnsync", { detail: state }));
}
function statusText() {
  if (state.status === "signed-in") return state.user?.displayName || state.user?.email || "Signed in";
  if (state.status === "offline") return "Offline — saved on this device";
  if (state.status === "error") return state.error || "Sync unavailable";
  if (state.status === "signed-out") return "Not syncing";
  return "Connecting…";
}

/* The app/builder read this. Defined immediately so callers never hit undefined
   even if the SDK never loads. */
const api = {
  onChange(fn) { listeners.add(fn); try { fn(state); } catch (e) {} return () => listeners.delete(fn); },
  get state() { return state; },
  signIn: async () => { throw new Error("Sync not ready"); },
  signOut: async () => {},
  pushPersonal() {},
  pushPlan() {},
  available: false
};
window.VNSync = api;
emit();   /* tell the pages we exist, now that they've finished loading */

(async function boot() {
  let fb;
  try {
    const [app, auth, store] = await Promise.all([
      import(`${SDK}/firebase-app.js`),
      import(`${SDK}/firebase-auth.js`),
      import(`${SDK}/firebase-firestore.js`)
    ]);
    fb = { ...app, ...auth, ...store };
  } catch (e) {
    /* offline on first load, or the CDN is unreachable — stay local-only */
    state.status = "offline";
    emit();
    return;
  }

  let db, authObj;
  try {
    const app = fb.initializeApp(firebaseConfig);
    /* persistentLocalCache = Firestore keeps a local copy and replays writes
       when the connection returns. This is what makes it usable in Vietnam
       with patchy signal. */
    db = fb.initializeFirestore(app, {
      localCache: fb.persistentLocalCache({ tabManager: fb.persistentMultipleTabManager() })
    });
    authObj = fb.getAuth(app);
  } catch (e) {
    state.status = "error";
    state.error = "Sync init failed";
    emit();
    return;
  }

  api.available = true;

  api.signIn = async () => {
    const provider = new fb.GoogleAuthProvider();
    provider.setCustomParameters({ prompt: "select_account" });
    try {
      await fb.signInWithPopup(authObj, provider);
    } catch (e) {
      /* Standalone PWAs (especially iOS) can block the popup — fall back. */
      if (["auth/popup-blocked", "auth/popup-closed-by-user", "auth/cancelled-popup-request",
           "auth/operation-not-supported-in-this-environment"].includes(e.code)) {
        return fb.signInWithRedirect(authObj, provider);
      }
      if (e.code === "auth/unauthorized-domain") {
        state.status = "error";
        state.error = "Add this domain in Firebase → Authentication → Settings → Authorized domains";
        emit();
        return;
      }
      throw e;
    }
  };
  api.signOut = () => fb.signOut(authObj);

  try { await fb.getRedirectResult(authObj); } catch (e) {}

  let unsubTrip = null, unsubMine = null;
  let applyingRemote = false;   /* guard: don't echo a remote change back up */

  fb.onAuthStateChanged(authObj, async user => {
    if (unsubTrip) { unsubTrip(); unsubTrip = null; }
    if (unsubMine) { unsubMine(); unsubMine = null; }
    state.user = user ? { uid: user.uid, email: user.email, displayName: user.displayName, photoURL: user.photoURL } : null;

    if (!user) { state.status = "signed-out"; emit(); return; }
    state.status = "signed-in";
    emit();

    /* hand the app this person's private namespace */
    window.VNApp?.setScope?.(user.uid);

    const tripRef = fb.doc(db, "trips", TRIP_ID);
    const mineRef = fb.doc(db, "trips", TRIP_ID, "members", user.uid);

    /* ---- shared plan ---- */
    unsubTrip = fb.onSnapshot(tripRef, snap => {
      const remote = snap.data()?.plan;
      if (!remote || !remote.days?.length) return;
      let local = null;
      try { local = JSON.parse(localStorage.getItem(BUILDER_LS_KEY) || "null"); } catch (e) {}
      if (local && (local.savedAt || 0) > (remote.savedAt || 0)) return;   /* ours is newer */
      applyingRemote = true;
      localStorage.setItem(BUILDER_LS_KEY, JSON.stringify(remote));
      applyingRemote = false;
      window.VNApp?.reloadPlan?.();
      window.VNBuilder?.applyRemotePlan?.(remote);
    }, err => { state.status = "error"; state.error = err.code || "Plan sync failed"; emit(); });

    /* ---- personal doc: single writer, so no merge logic needed ---- */
    unsubMine = fb.onSnapshot(mineRef, snap => {
      const d = snap.data();
      if (!d) { api.pushPersonal(); return; }        /* first sign-in: seed from device */
      if (snap.metadata.hasPendingWrites) return;    /* our own echo */
      applyingRemote = true;
      PERSONAL_KEYS.forEach(k => {
        if (d[k] === undefined) return;
        window.VNApp?.store?.set?.(k, d[k]);
      });
      applyingRemote = false;
      window.VNApp?.loadPersonal?.();
      window.VNApp?.render?.();
    }, err => { state.status = "error"; state.error = err.code || "Sync failed"; emit(); });

    /* ---- writers ---- */
    let tPersonal = null, tPlan = null;
    api.pushPersonal = () => {
      if (applyingRemote || !state.user) return;
      clearTimeout(tPersonal);
      tPersonal = setTimeout(async () => {
        const p = window.VNApp?.personal;
        if (!p) return;
        try {
          await fb.setDoc(mineRef, {
            ...p,
            email: state.user.email,
            displayName: state.user.displayName || "",
            updatedAt: Date.now()
          }, { merge: true });
        } catch (e) { state.status = "error"; state.error = e.code || "Save failed"; emit(); }
      }, 700);
    };
    api.pushPlan = plan => {
      if (applyingRemote || !state.user) return;
      clearTimeout(tPlan);
      tPlan = setTimeout(async () => {
        try {
          await fb.setDoc(tripRef, { plan, planUpdatedBy: state.user.email, updatedAt: Date.now() }, { merge: true });
        } catch (e) { state.status = "error"; state.error = e.code || "Plan save failed"; emit(); }
      }, 700);
    };

    /* push whatever this device already has, then let listeners take over */
    api.pushPersonal();
    try {
      const local = JSON.parse(localStorage.getItem(BUILDER_LS_KEY) || "null");
      if (local?.days?.length) {
        const snap = await fb.getDoc(tripRef);
        const remote = snap.data()?.plan;
        if (!remote || (local.savedAt || 0) > (remote.savedAt || 0)) api.pushPlan(local);
      }
    } catch (e) {}
  });
})();

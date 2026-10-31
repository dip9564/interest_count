import { initializeApp } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-app.js";
import { getAuth, createUserWithEmailAndPassword, signInWithEmailAndPassword, signOut, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-auth.js";
import { getFirestore, collection, doc, getDocs, onSnapshot, writeBatch, setDoc, deleteDoc } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js";
import { firebaseConfig, isFirebaseConfigured } from "./firebase-config.js";

const status = document.getElementById("authStatus");
const setStatus = message => { status.textContent = message; };

if (!isFirebaseConfigured) {
  setStatus("Firebase is not configured yet. Follow the setup steps in README.md.");
} else {
  try {
    const app = initializeApp(firebaseConfig);
    const auth = getAuth(app);
    const db = getFirestore(app);
    let unsubscribeInvestments = null;
    let unsubscribeFinance = null;
    let unsubscribeSpends = null;
    let unsubscribeBalanceHistory = null;
    let currentUser = null;
    let currentBalances = { bank: 0, cash: 0, invested: 0 };
    let currentSpends = [];

    const investmentsRef = () => collection(db, "users", currentUser.uid, "investments");
    const financeRef = () => doc(db, "users", currentUser.uid, "finance", "summary");
    const spendsRef = () => collection(db, "users", currentUser.uid, "spends");
    const balanceHistoryRef = () => collection(db, "users", currentUser.uid, "balanceHistory");
    window.cloud = {
      async saveBalances(balances, historyEntry = null) {
        if (!currentUser) throw new Error("Please sign in first.");
        const batch = writeBatch(db);
        batch.set(financeRef(), balances);
        if (historyEntry) {
          const { id, ...data } = historyEntry;
          batch.set(doc(db, "users", currentUser.uid, "balanceHistory", String(id)), data);
        }
        await batch.commit();
      },
      async addSpend(spend) {
        if (!currentUser) throw new Error("Please sign in first.");
        const { id, ...data } = spend;
        await setDoc(doc(db, "users", currentUser.uid, "spends", String(id)), data);
      },
      async deleteSpend(id) {
        if (!currentUser) throw new Error("Please sign in first.");
        await deleteDoc(doc(db, "users", currentUser.uid, "spends", String(id)));
      },
      async deleteBalanceHistory(id) {
        if (!currentUser) throw new Error("Please sign in first.");
        await deleteDoc(doc(db, "users", currentUser.uid, "balanceHistory", String(id)));
      },
      async replaceBalanceHistory(items) {
        if (!currentUser) throw new Error("Please sign in first.");
        if (items.length > 450) throw new Error("A maximum of 450 balance changes can be imported at once.");
        const existing = await getDocs(balanceHistoryRef());
        if (existing.size + items.length > 500) throw new Error("This import exceeds Firestore's 500-operation batch limit.");
        const batch = writeBatch(db);
        existing.forEach(snapshot => batch.delete(snapshot.ref));
        items.forEach(item => {
          const { id, ...data } = item;
          batch.set(doc(db, "users", currentUser.uid, "balanceHistory", String(id)), data);
        });
        if (existing.size + items.length) await batch.commit();
      },
      async replaceSpends(items) {
        if (!currentUser) throw new Error("Please sign in first.");
        if (items.length > 450) throw new Error("A maximum of 450 planned spends can be imported at once.");
        const existing = await getDocs(spendsRef());
        if (existing.size + items.length > 500) throw new Error("This import exceeds Firestore's 500-operation batch limit.");
        const batch = writeBatch(db);
        existing.forEach(snapshot => batch.delete(snapshot.ref));
        items.forEach(item => {
          const { id, ...data } = item;
          batch.set(doc(db, "users", currentUser.uid, "spends", String(id)), data);
        });
        if (existing.size + items.length) await batch.commit();
      },
      async replaceAll(items) {
        if (!currentUser) throw new Error("Please sign in first.");
        if (items.length > 450) throw new Error("A maximum of 450 investments can be saved at once.");
        const existing = await getDocs(investmentsRef());
        const batch = writeBatch(db);
        const nextIds = new Set(items.map(item => String(item.id)));
        let operations = 0;
        existing.forEach(snapshot => {
          if (!nextIds.has(snapshot.id)) { batch.delete(snapshot.ref); operations += 1; }
        });
        existing.forEach(snapshot => {
          const item = items.find(candidate => String(candidate.id) === snapshot.id);
          if (item) {
            const { id, ...data } = item;
            const saved = snapshot.data();
            const unchanged = Object.keys(saved).length === Object.keys(data).length && Object.keys(data).every(key => saved[key] === data[key]);
            if (!unchanged) {
              batch.set(snapshot.ref, data);
              operations += 1;
            }
          }
        });
        items.forEach(item => {
          const { id, ...data } = item;
          if (!existing.docs.some(snapshot => snapshot.id === String(id))) {
            batch.set(doc(db, "users", currentUser.uid, "investments", String(id)), data);
            operations += 1;
          }
        });
        if (operations > 500) throw new Error("This update exceeds Firestore's 500-operation batch limit.");
        if (operations === 0) return;
        await batch.commit();
      }
    };

    document.getElementById("authForm").addEventListener("submit", async event => {
      event.preventDefault();
      try {
        await signInWithEmailAndPassword(auth, document.getElementById("authEmail").value.trim(), document.getElementById("authPassword").value);
      } catch (error) { setStatus(error.message); }
    });
    document.getElementById("signUpButton").addEventListener("click", async () => {
      const form = document.getElementById("authForm");
      if (!form.reportValidity()) return;
      try {
        await createUserWithEmailAndPassword(auth, document.getElementById("authEmail").value.trim(), document.getElementById("authPassword").value);
      } catch (error) { setStatus(error.message); }
    });
    document.getElementById("signOutButton").addEventListener("click", () => signOut(auth));

    onAuthStateChanged(auth, user => {
      currentUser = user;
      if (unsubscribeInvestments) { unsubscribeInvestments(); unsubscribeInvestments = null; }
      if (unsubscribeFinance) { unsubscribeFinance(); unsubscribeFinance = null; }
      if (unsubscribeSpends) { unsubscribeSpends(); unsubscribeSpends = null; }
      if (unsubscribeBalanceHistory) { unsubscribeBalanceHistory(); unsubscribeBalanceHistory = null; }
      document.body.classList.toggle("signed-out", !user);
      document.getElementById("authPanel").classList.toggle("hidden", !!user);
      document.getElementById("accountEmail").textContent = user?.email || "";
      if (!user) {
        window.setCloudInvestments([]);
        currentBalances = { bank: 0, cash: 0, invested: 0 };
        currentSpends = [];
        window.setFinanceData(currentBalances, currentSpends);
        window.setBalanceHistory([]);
        setStatus("Sign in to load your cloud-saved investments.");
        return;
      }
      setStatus("Connected. Loading your investments…");
      unsubscribeFinance = onSnapshot(financeRef(), snapshot => {
        currentBalances = snapshot.exists() ? snapshot.data() : { bank: 0, cash: 0, invested: 0 };
        window.setFinanceData(currentBalances, currentSpends);
      }, error => setStatus(`Could not load balances: ${error.message}`));
      unsubscribeSpends = onSnapshot(spendsRef(), snapshot => {
        currentSpends = snapshot.docs.map(item => ({ id: item.id, ...item.data() }));
        window.setFinanceData(currentBalances, currentSpends);
      }, error => setStatus(`Could not load planned spends: ${error.message}`));
      unsubscribeBalanceHistory = onSnapshot(balanceHistoryRef(), snapshot => {
        window.setBalanceHistory(snapshot.docs.map(item => ({ id: item.id, ...item.data() })));
      }, error => {
        window.setBalanceHistoryError?.(error.message);
        setStatus(`Could not load balance history: ${error.message}`);
      });
      unsubscribeInvestments = onSnapshot(investmentsRef(), async snapshot => {
        const records = snapshot.docs.map(item => ({ id: item.id, ...item.data() }));
        window.setCloudInvestments(records);
        setStatus("Your investments are synced to Firebase.");
        if (records.length === 0 && !sessionStorage.getItem("yield-legacy-migration-checked")) {
          sessionStorage.setItem("yield-legacy-migration-checked", "yes");
          try {
            const legacy = JSON.parse(localStorage.getItem("yield-investments-v1") || "[]");
            if (Array.isArray(legacy) && legacy.length && confirm(`Found ${legacy.length} investments saved in this browser. Copy them to your Firebase account?`)) {
              await window.cloud.replaceAll(legacy);
              localStorage.removeItem("yield-investments-v1");
              setStatus("Your previous browser-saved investments were copied to Firebase.");
            }
          } catch (error) { setStatus(`Could not migrate browser-saved data: ${error.message}`); }
        }
      }, error => setStatus(`Could not load cloud data: ${error.message}`));
    });
  } catch (error) {
    setStatus(`Firebase setup error: ${error.message}`);
  }
}

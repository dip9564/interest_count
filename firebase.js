import { initializeApp } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-app.js";
import { getAuth, createUserWithEmailAndPassword, signInWithEmailAndPassword, signOut, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-auth.js";
import { getFirestore, collection, doc, getDocs, onSnapshot, writeBatch, setDoc, deleteDoc, runTransaction } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js";
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
    let unsubscribeExpectedMoney = null;
    let currentUser = null;
    let currentBalances = { bank: 0, cash: 0, invested: 0 };
    let currentSpends = [];
    let currentExpectedMoney = [];

    const investmentsRef = () => collection(db, "users", currentUser.uid, "investments");
    const financeRef = () => doc(db, "users", currentUser.uid, "finance", "summary");
    const spendsRef = () => collection(db, "users", currentUser.uid, "spends");
    const balanceHistoryRef = () => collection(db, "users", currentUser.uid, "balanceHistory");
    const expectedMoneyRef = () => collection(db, "users", currentUser.uid, "expectedMoney");
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
        const repeatDays = Number(spend.repeatDays) || 0;
        if (repeatDays && (!Number.isInteger(repeatDays) || repeatDays < 1 || repeatDays > 3650 || !/^\d{4}-\d{2}-\d{2}$/.test(spend.dueDate || ""))) throw new Error("Recurring spends need a valid interval and expected use date.");
        const { id, ...data } = spend;
        await setDoc(doc(db, "users", currentUser.uid, "spends", String(id)), data);
      },
      async updateSpend(spend) {
        if (!currentUser) throw new Error("Please sign in first.");
        const repeatDays = Number(spend.repeatDays) || 0;
        if (!spend.name?.trim() || !Number.isFinite(Number(spend.amount)) || Number(spend.amount) <= 0) throw new Error("Enter a name and a valid amount.");
        if (repeatDays && (!Number.isInteger(repeatDays) || repeatDays < 1 || repeatDays > 3650 || !/^\d{4}-\d{2}-\d{2}$/.test(spend.dueDate || ""))) throw new Error("Recurring spends need a valid interval and expected use date.");
        const { id, ...data } = spend;
        await setDoc(doc(db, "users", currentUser.uid, "spends", String(id)), data);
      },
      async deleteSpend(id) {
        if (!currentUser) throw new Error("Please sign in first.");
        await deleteDoc(doc(db, "users", currentUser.uid, "spends", String(id)));
      },
      async transferBalances(direction, amount, investedTotal) {
        if (!currentUser) throw new Error("Please sign in first.");
        if (direction !== "bank-to-cash" && direction !== "cash-to-bank") throw new Error("Choose a valid transfer direction.");
        amount = Number(amount);
        if (!Number.isFinite(amount) || amount <= 0) throw new Error("Enter a valid transfer amount.");
        const historyId = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const historyDoc = doc(db, "users", currentUser.uid, "balanceHistory", historyId);
        const changedAt = new Date().toISOString();
        return runTransaction(db, async transaction => {
          const financeSnapshot = await transaction.get(financeRef());
          const saved = financeSnapshot.exists() ? financeSnapshot.data() : {};
          const previous = { bank: Number(saved.bank) || 0, cash: Number(saved.cash) || 0, invested: Number(investedTotal) || 0, roundUpDays: Number(saved.roundUpDays) || 15 };
          const source = direction === "bank-to-cash" ? "bank" : "cash";
          const destination = source === "bank" ? "cash" : "bank";
          if (previous[source] < amount) throw new Error(`Not enough money in ${source === "bank" ? "your bank account" : "available cash"}.`);
          const next = { ...previous, [source]: Number((previous[source] - amount).toFixed(2)), [destination]: Number((previous[destination] + amount).toFixed(2)) };
          const total = previous.bank + previous.cash + previous.invested;
          const usable = previous.bank + previous.cash;
          const historyEntry = {
            changedAt, previousTotal: total, totalChange: 0, newTotal: total,
            previousBank: previous.bank, newBank: next.bank, previousCash: previous.cash, newCash: next.cash,
            previousUsable: usable, usableChange: 0, newUsable: usable,
            previousInvested: previous.invested, investedChange: 0, newInvested: previous.invested,
            note: `Money transfer: ${source === "bank" ? "Bank account → Available cash" : "Available cash → Bank account"} (${amount})`
          };
          transaction.set(financeRef(), next);
          transaction.set(historyDoc, historyEntry);
          return { balances: next, historyEntry: { id: historyId, ...historyEntry }, amount, direction };
        });
      },
      async addFundedInvestment(item, source, investedTotal) {
        if (!currentUser) throw new Error("Please sign in first.");
        if (source !== "bank" && source !== "cash") throw new Error("Choose a bank account or available cash.");
        const investmentDoc = doc(db, "users", currentUser.uid, "investments", String(item.id));
        const historyId = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const historyDoc = doc(db, "users", currentUser.uid, "balanceHistory", historyId);
        const changedAt = new Date().toISOString();
        return runTransaction(db, async transaction => {
          const investmentSnapshot = await transaction.get(investmentDoc);
          const financeSnapshot = await transaction.get(financeRef());
          if (investmentSnapshot.exists()) throw new Error("This investment was already saved.");
          const amount = Number(item.amount);
          if (!Number.isFinite(amount) || amount <= 0) throw new Error("Enter a valid investment amount.");
          const saved = financeSnapshot.exists() ? financeSnapshot.data() : {};
          const previous = { bank: Number(saved.bank) || 0, cash: Number(saved.cash) || 0, invested: Number(investedTotal) || 0, roundUpDays: Number(saved.roundUpDays) || 15 };
          if (previous[source] < amount) throw new Error(`Not enough money in ${source === "bank" ? "your bank account" : "available cash"}. Choose Other source or edit your balance.`);
          const newInvested = previous.invested + amount;
          const next = { ...previous, [source]: Number((previous[source] - amount).toFixed(2)), invested: newInvested };
          const previousTotal = previous.bank + previous.cash + previous.invested;
          const newTotal = next.bank + next.cash + next.invested;
          const previousUsable = previous.bank + previous.cash;
          const newUsable = next.bank + next.cash;
          const historyEntry = {
            changedAt, previousTotal, totalChange: newTotal - previousTotal, newTotal,
            previousBank: previous.bank, newBank: next.bank, previousCash: previous.cash, newCash: next.cash,
            previousUsable, usableChange: newUsable - previousUsable, newUsable,
            previousInvested: previous.invested, investedChange: amount, newInvested,
            note: `New investment funded from ${source === "bank" ? "bank account" : "available cash"}: ${String(item.name || "Investment")}`
          };
          const { id, ...investmentData } = item;
          transaction.set(investmentDoc, investmentData);
          transaction.set(financeRef(), next);
          transaction.set(historyDoc, historyEntry);
          return { balances: next, historyEntry: { id: historyId, ...historyEntry }, investment: { ...item }, source, amount };
        });
      },
      async saveExpectedMoney(item) {
        if (!currentUser) throw new Error("Please sign in first.");
        const { id, ...data } = item;
        await setDoc(doc(db, "users", currentUser.uid, "expectedMoney", String(id)), data);
      },
      async deleteExpectedMoney(id) {
        if (!currentUser) throw new Error("Please sign in first.");
        await deleteDoc(doc(db, "users", currentUser.uid, "expectedMoney", String(id)));
      },
      async receiveExpectedMoney(id, source, investedTotal) {
        if (!currentUser) throw new Error("Please sign in first.");
        if (source !== "bank" && source !== "cash") throw new Error("Choose a bank account or available cash.");
        const expectedDoc = doc(db, "users", currentUser.uid, "expectedMoney", String(id));
        const historyId = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const historyDoc = doc(db, "users", currentUser.uid, "balanceHistory", historyId);
        const changedAt = new Date().toISOString();
        return runTransaction(db, async transaction => {
          const expectedSnapshot = await transaction.get(expectedDoc);
          const financeSnapshot = await transaction.get(financeRef());
          if (!expectedSnapshot.exists()) throw new Error("This expected payment was already removed or received.");
          const payment = expectedSnapshot.data();
          const amount = Number(payment.amount);
          if (!Number.isFinite(amount) || amount <= 0) throw new Error("This expected payment has an invalid amount.");
          const saved = financeSnapshot.exists() ? financeSnapshot.data() : {};
          const previous = { bank: Number(saved.bank) || 0, cash: Number(saved.cash) || 0, invested: Number(investedTotal) || 0, roundUpDays: Number(saved.roundUpDays) || 15 };
          const next = { ...previous, [source]: Number((previous[source] + amount).toFixed(2)) };
          const previousTotal = previous.bank + previous.cash + previous.invested;
          const newTotal = next.bank + next.cash + next.invested;
          const previousUsable = previous.bank + previous.cash;
          const newUsable = next.bank + next.cash;
          const historyEntry = {
            changedAt, previousTotal, totalChange: newTotal - previousTotal, newTotal,
            previousBank: previous.bank, newBank: next.bank, previousCash: previous.cash, newCash: next.cash,
            previousUsable, usableChange: newUsable - previousUsable, newUsable,
            previousInvested: previous.invested, investedChange: 0, newInvested: next.invested,
            note: `Received expected money: ${String(payment.name || "Payment")}`
          };
          transaction.set(financeRef(), next);
          transaction.delete(expectedDoc);
          transaction.set(historyDoc, historyEntry);
          return { balances: next, historyEntry: { id: historyId, ...historyEntry }, name: payment.name || "Payment", amount, source };
        });
      },
      async payPlannedSpend(id, source, investedTotal) {
        if (!currentUser) throw new Error("Please sign in first.");
        if (source !== "bank" && source !== "cash") throw new Error("Choose a bank account or available cash.");
        const spendDoc = doc(db, "users", currentUser.uid, "spends", String(id));
        const historyId = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const historyDoc = doc(db, "users", currentUser.uid, "balanceHistory", historyId);
        const changedAt = new Date().toISOString();
        return runTransaction(db, async transaction => {
          const spendSnapshot = await transaction.get(spendDoc);
          const financeSnapshot = await transaction.get(financeRef());
          if (!spendSnapshot.exists()) throw new Error("This planned spend was already removed or paid.");
          const spend = spendSnapshot.data();
          const amount = Number(spend.amount);
          if (!Number.isFinite(amount) || amount <= 0) throw new Error("This planned spend has an invalid amount.");
          const saved = financeSnapshot.exists() ? financeSnapshot.data() : {};
          const previous = {
            bank: Number(saved.bank) || 0,
            cash: Number(saved.cash) || 0,
            invested: Number(investedTotal) || 0,
            roundUpDays: Number(saved.roundUpDays) || 15
          };
          if (previous[source] < amount) throw new Error(`Not enough money in ${source === "bank" ? "your bank account" : "available cash"}.`);
          const next = { ...previous, [source]: Number((previous[source] - amount).toFixed(2)) };
          const previousTotal = previous.bank + previous.cash + previous.invested;
          const newTotal = next.bank + next.cash + next.invested;
          const previousUsable = previous.bank + previous.cash;
          const newUsable = next.bank + next.cash;
          const historyEntry = {
            changedAt,
            previousTotal,
            totalChange: newTotal - previousTotal,
            newTotal,
            previousBank: previous.bank,
            newBank: next.bank,
            previousCash: previous.cash,
            newCash: next.cash,
            previousUsable,
            usableChange: newUsable - previousUsable,
            newUsable,
            previousInvested: previous.invested,
            investedChange: 0,
            newInvested: next.invested,
            note: `Paid planned spend: ${String(spend.name || "Expense")}`
          };
          transaction.set(financeRef(), next);
          const repeatDays = Number(spend.repeatDays) || 0;
          let nextDueDate = "";
          if (Number.isInteger(repeatDays) && repeatDays > 0) {
            if (!/^\d{4}-\d{2}-\d{2}$/.test(spend.dueDate || "")) throw new Error("This recurring spend needs a valid expected use date.");
            const [year, month, day] = spend.dueDate.split("-").map(Number);
            const scheduled = new Date(Date.UTC(year, month - 1, day));
            const today = new Date();
            const todayUtc = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
            do { scheduled.setUTCDate(scheduled.getUTCDate() + repeatDays); } while (scheduled.getTime() <= todayUtc);
            nextDueDate = scheduled.toISOString().slice(0, 10);
            transaction.update(spendDoc, { dueDate: nextDueDate });
          } else {
            transaction.delete(spendDoc);
          }
          transaction.set(historyDoc, historyEntry);
          return { balances: next, historyEntry: { id: historyId, ...historyEntry }, spendName: spend.name || "Expense", amount, recurring: repeatDays > 0, nextDueDate, repeatDays };
        });
      },
      async completeInvestment(id, payoutAmount, source, completedDate, investedTotal) {
        if (!currentUser) throw new Error("Please sign in first.");
        if (source !== "bank" && source !== "cash") throw new Error("Choose a bank account or available cash.");
        const investmentDoc = doc(db, "users", currentUser.uid, "investments", String(id));
        const historyId = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const historyDoc = doc(db, "users", currentUser.uid, "balanceHistory", historyId);
        const changedAt = new Date().toISOString();
        return runTransaction(db, async transaction => {
          const investmentSnapshot = await transaction.get(investmentDoc);
          const financeSnapshot = await transaction.get(financeRef());
          if (!investmentSnapshot.exists()) throw new Error("This investment no longer exists.");
          const investment = investmentSnapshot.data();
          if (investment.completed_at) throw new Error("This investment is already complete.");
          const payout = Number(payoutAmount);
          if (!Number.isFinite(payout) || payout < 0) throw new Error("Enter a valid payout amount.");
          const saved = financeSnapshot.exists() ? financeSnapshot.data() : {};
          const previous = {
            bank: Number(saved.bank) || 0,
            cash: Number(saved.cash) || 0,
            invested: Number(investedTotal) || 0,
            roundUpDays: Number(saved.roundUpDays) || 15
          };
          const newInvested = Math.max(0, previous.invested - (Number(investment.amount) || 0));
          const next = { ...previous, [source]: Number((previous[source] + payout).toFixed(2)), invested: newInvested };
          const principal = Number(investment.amount) || 0;
          const previousTotal = previous.bank + previous.cash + previous.invested;
          const newTotal = next.bank + next.cash + next.invested;
          const previousUsable = previous.bank + previous.cash;
          const newUsable = next.bank + next.cash;
          const historyEntry = {
            changedAt,
            previousTotal,
            totalChange: newTotal - previousTotal,
            newTotal,
            previousBank: previous.bank,
            newBank: next.bank,
            previousCash: previous.cash,
            newCash: next.cash,
            previousUsable,
            usableChange: newUsable - previousUsable,
            newUsable,
            previousInvested: previous.invested,
            investedChange: newInvested - previous.invested,
            newInvested,
            note: `Completed investment: ${String(investment.name || "Investment")}`
          };
          const completedAt = /^\d{4}-\d{2}-\d{2}$/.test(completedDate || "") ? completedDate : changedAt.slice(0, 10);
          transaction.update(investmentDoc, { completed_at: completedAt, received_amount: payout });
          transaction.set(financeRef(), next);
          transaction.set(historyDoc, historyEntry);
          return {
            balances: next,
            historyEntry: { id: historyId, ...historyEntry },
            investment: { id: String(id), ...investment, completed_at: completedAt, received_amount: payout },
            payout,
            principal,
            source
          };
        });
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
      async replaceExpectedMoney(items) {
        if (!currentUser) throw new Error("Please sign in first.");
        if (items.length > 450) throw new Error("A maximum of 450 expected payments can be imported at once.");
        const existing = await getDocs(expectedMoneyRef());
        if (existing.size + items.length > 500) throw new Error("This import exceeds Firestore's 500-operation batch limit.");
        const batch = writeBatch(db);
        existing.forEach(snapshot => batch.delete(snapshot.ref));
        items.forEach(item => {
          const { id, ...data } = item;
          batch.set(doc(db, "users", currentUser.uid, "expectedMoney", String(id)), data);
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
      if (unsubscribeExpectedMoney) { unsubscribeExpectedMoney(); unsubscribeExpectedMoney = null; }
      document.body.classList.toggle("signed-out", !user);
      document.getElementById("authPanel").classList.toggle("hidden", !!user);
      document.getElementById("accountEmail").textContent = user?.email || "";
      if (!user) {
        window.setCloudInvestments([]);
        currentBalances = { bank: 0, cash: 0, invested: 0 };
        currentSpends = [];
        currentExpectedMoney = [];
        window.setFinanceData(currentBalances, currentSpends);
        window.setExpectedMoney([]);
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
      unsubscribeExpectedMoney = onSnapshot(expectedMoneyRef(), snapshot => {
        currentExpectedMoney = snapshot.docs.map(item => ({ id: item.id, ...item.data() }));
        window.setExpectedMoney(currentExpectedMoney);
      }, error => window.setExpectedMoneyError?.(error.message));
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

# Yield — Interest Tracker

Static Vercel app backed by Firebase Authentication and Cloud Firestore. Investments, money balances, and planned expenses belong to the signed-in account and sync between browsers and devices. JSON backup and restore for investments, balances, planned spends, and balance-change history remain available from the left panel.

## Set up Firebase (Spark)

1. Create a project in the [Firebase Console](https://console.firebase.google.com/) and keep it on the **Spark** plan.
2. In **Build → Authentication → Get started → Sign-in method**, enable **Email/Password**.
3. In **Build → Firestore Database**, create a database. Choose a location close to you; the database location cannot be changed later.
4. In **Project settings → General → Your apps**, register a Web app and copy its Firebase configuration.
5. Put the values Firebase shows you in `firebase-config.js`.
6. In Firestore **Rules**, paste the contents of `firestore.rules` and publish them. The rules restrict each signed-in user to their own investment, balance, planned-spend, and balance-history documents.
7. In Authentication **Settings → Authorized domains**, add your Vercel domain if it is not already listed.
8. Push this folder to GitHub and import it in Vercel as an **Other** static project. No build command or output folder is needed.

Firebase web configuration is not a server secret. The security boundary is the published Firestore rules. Never put a Firebase Admin/service account key in this static app.

## Data and free tier

Investment records are saved at `users/{userId}/investments/{investmentId}`. Money balances are saved at `users/{userId}/finance/summary`, planned spends at `users/{userId}/spends/{spendId}`, and balance-change history at `users/{userId}/balanceHistory/{changeId}`. Firestore rules allow access only when the signed-in account ID matches `{userId}`. After adding these features, republish the updated rules from `firestore.rules` in Firebase Console → Firestore → Rules. Keep the Firebase project on Spark to use the no-cost quotas; if a Spark quota is exceeded, the affected service may be unavailable until its quota resets or the project is upgraded. Free quotas and terms can change, so check Firebase pricing from time to time.

The app also offers **Export backup** and **Import**. Store exported JSON somewhere safe. Import replaces the signed-in account's current cloud records, balances, and planned spends when those fields are present in the backup. If the old browser-local version's records are still in this browser, the app offers to copy them to Firebase the first time you sign in with an empty cloud account.

## Run locally

Serve this folder over HTTP (ES modules do not work when opened as a `file://` page), for example:

```sh
python3 -m http.server 8000
```

Then open `http://localhost:8000` after configuring Firebase and adding `localhost` to Authentication's authorized domains.

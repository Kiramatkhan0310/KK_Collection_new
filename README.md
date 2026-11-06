# KK Collection

KK Collection is a responsive cosmetics storefront built with React, TypeScript, Vite, Firebase Authentication, and Cloud Firestore. The project now follows a Firebase Spark-friendly setup that avoids Cloud Functions and Firebase Storage so it stays compatible with the free Spark plan.

The storefront uses live Firestore products when Firebase is configured. Without Firebase, it displays a clearly labeled preview catalogue so the design can still be explored. Preview imagery is publicly hosted and should be replaced with store-owned assets before launch.

## What is in the project

- **Storefront:** responsive editorial storefront, live Firestore catalogue (or labeled preview products), search, category and price filters, sorting, product details, wishlist, and a cart persisted in the browser.
- **Frontend presentation:** collection story and newsletter sections, expanded multi-column footer, and a light/dark theme toggle whose preference is saved in the browser.
- **Customer accounts:** email/password registration and login, password reset, persistent sign-in, and optional Google sign-in.
- **COD checkout:** a signed-in customer can save a strictly shaped COD order request in Firestore. Requests are unverified until an administrator checks the current price, availability, and delivery details. The browser does not securely validate prices or stock, and stock is not reserved or decremented.
- **Admin portal:** `/admin` has a separate sign-in screen and checks the Firebase ID token's `admin: true` custom claim before loading admin data. Product CRUD and order updates are performed directly with Firestore security rules instead of Cloud Functions.
- **Newsletter demo:** submitted email addresses are stored in the visitor's browser only. They are not sent to KK or saved to a shared mailing list.
- **Security:** Firestore rules keep user data scoped and admin writes claim-gated. Order request creation is limited by owner, allowed fields, types, and bounds; it does not provide trusted commerce validation.

The Firebase project, authentication providers, admin claim, sample data, and hosting deployment are **not configured by this repository**. Complete the setup below before using live backend features.

## Technology

- React + TypeScript + Vite
- Tailwind CSS 4 and Lucide React
- Firebase Web SDK: Authentication and Firestore
- Firebase Hosting
- Firebase Spark-compatible architecture without Cloud Functions and without Firebase Storage

## Run locally

Install Node.js 22 or newer and npm. From this folder, run:

```powershell
npm install
npm run dev
```

The storefront will show preview products so you can explore the frontend. Firebase-backed features require a Firebase web app configuration.

## Firebase setup

### 1. Create a Firebase project

1. Create a project in the [Firebase Console](https://console.firebase.google.com/).
2. Add a **Web app** to the project and copy its web configuration.
3. In **Authentication → Sign-in method**, enable **Email/Password**. Enable **Google** only if you configure its support email and authorized domains.
4. Create a Cloud Firestore database. Choose the location carefully; changing it later is not a simple migration.
5. Do not enable Cloud Functions or Firebase Storage for this Spark-compatible build. The project keeps the free-tier architecture simple and avoids billing requirements.

### 2. Add the web configuration

Copy `.env.example` to `.env.local` and replace each value with the matching Firebase web-app setting:

```powershell
Copy-Item .env.example .env.local
```

Vite reads `.env.local` when the development server starts. Stop and restart `npm run dev` after changing it.

The `VITE_` values are public client configuration, **not secrets**. Do not put an Admin SDK service-account key, private key, or password in a Vite environment variable or in the browser.

### 3. Deploy the security rules

Install the Firebase CLI and authenticate:

```powershell
npm install --global firebase-tools
firebase login
firebase use --add
```

Choose the project you created, then deploy only the Firestore rules:

```powershell
firebase deploy --only firestore:rules
```

Firestore data is organized as follows:

| Collection/path | Purpose | Client access |
|---|---|---|
| `users/{uid}` | Customer profile | The customer reads their profile; profile creation is restricted to their own UID |
| `products/{productId}` | Published catalogue, prices, and current stock | Public reads for published products; writes are admin-only |
| `categories/{categoryId}` | Optional category metadata | Public reads for active categories |
| `orders/{orderId}` | Unverified request snapshot, delivery details, COD and fulfillment state | Customer reads their own requests and may create a pending COD request; admin reads all and may make constrained status updates |
| `wishlists/{uid}/items/{productId}` | Customer wishlist | The owner reads and changes their own items |
| `reviews/{reviewId}` | Customer feedback awaiting moderation | Public reads of published reviews; users may submit their own pending review |

Newsletter signups are local to the browser and are not written to Firestore. `products/{productId}.stock` is displayed by the storefront, but a customer order request does not reserve or decrement stock.

### 5. Assign the first admin claim locally

Admin access is **not** created by a frontend toggle or Firestore document.

1. Create the administrator as a normal user in Firebase Authentication.
2. Copy that user's Firebase **UID** from Authentication → Users.
3. On your trusted local machine, install the Functions folder's existing Admin SDK dependencies and authenticate your own Google account with Application Default Credentials:

```powershell
npm --prefix functions ci
gcloud auth application-default login
$env:FIREBASE_PROJECT_ID = "your-project-id"
npm --prefix functions run set-admin -- "the-auth-user-uid"
```

The Google account must have permission to manage Firebase Authentication users in that project. The local script at `functions/scripts/set-admin.mjs` verifies the UID exists and merges `admin: true` into its custom claims. It only changes the claim; it does not deploy Functions. The user must sign out and sign in again to refresh their ID token.

Do not create a service-account key for this setup or place credentials in the repository, frontend, any `VITE_` variable, or GitHub. Application Default Credentials are stored in your local developer environment, not this project. Never add a client-side admin-promotion feature.

### 6. Optional demo catalogue

Use a local admin-only script or a separate demo Firestore seed process to add sample products. Keep the data clearly marked as demo content, replace product images and descriptions before a real launch, and never expose this operation over an unauthenticated web endpoint.

### 7. Deploy Firebase Hosting

Build the frontend and deploy Hosting:

```powershell
npm run build
firebase deploy --only hosting
```

The Firebase CLI prints the Hosting URL after a successful deployment. This workspace has not been deployed; there is no verified public URL yet.

## Continuous integration

The GitHub Actions workflow runs frontend build and lint checks only. It does not access Firebase credentials or deploy Hosting, Firestore rules, Cloud Functions, or Storage.

## Verification

Run the local checks:

```powershell
npm run build
npm run lint
```

Firebase integration tests require your Firebase project (or configured Firebase emulators). Before presenting the project, complete the manual test checklist in [PROJECT-DOCUMENTATION.md](./PROJECT-DOCUMENTATION.md). Do not mark an integration test as passed until you have observed it against your own project.

## Project documentation

- [Project overview, HCI mapping, architecture, workflows, and test checklist](./PROJECT-DOCUMENTATION.md)
- [12-slide university presentation outline](./PRESENTATION-OUTLINE.md)

## Important launch checks

- Add your real product data and use stable product image URLs that are hosted publicly or in your asset pipeline.
- Configure and verify authorized authentication domains, password reset email settings, and (if used) Google sign-in.
- Assign the admin claim using the trusted procedure above.
- Deploy the Firestore rules before opening the site to customers.
- Test that customer order requests have the expected fields, remain pending COD requests, and cannot modify another customer's data or privileged fields. Manually verify requests before fulfillment; the application does not validate prices/stock authoritatively or reserve/restock inventory.
- Review shipping fees, currency, customer data retention, privacy notice, contact details, and local legal requirements.
- Do not use the sample catalogue as real inventory or advertise this project as deployed until you have verified it.

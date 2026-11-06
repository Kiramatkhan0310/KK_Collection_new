# KK Collection — HCI Project Documentation

## Project overview

KK Collection is a responsive cosmetics e-commerce application designed to make browsing and ordering beauty products understandable for first-time customers. The storefront uses a luxury editorial presentation with an image-led hero, collection tiles, and a product catalogue. It combines a Firebase-backed catalogue, customer accounts, a cash-on-delivery order flow, and a separate administrator portal.

**Current implementation status:** When Firebase is not configured, the frontend shows a labeled preview catalogue of 60 sample products. Firebase project configuration, live credentials, custom admin assignment, end-to-end Firebase tests, and Hosting deployment remain operator setup tasks. Checkout saves a strictly shaped but unverified COD order request; it does not securely verify price or stock, and does not reserve or decrement stock.

## Problem statement

Customers shopping for cosmetics online need to discover products, compare prices, understand availability, and submit a request without confusing navigation or unclear feedback. Store administrators need a protected way to maintain product data and manually review requests. This Spark-compatible client cannot securely validate commerce details or reserve stock; requests require manual verification before fulfillment.

## Objectives

1. Create an attractive, responsive beauty storefront with clear catalogue navigation.
2. Support customer registration, sign-in, password reset, and persistent sessions.
3. Make the shopping bag survive a browser refresh.
4. Submit a pending COD order request to Firestore.
5. Restrict customer-created requests by owner, allowed fields, types, and bounded sizes.
6. Provide claim-gated admin tools for product, order, and customer operations.
7. Apply accessible interaction and feedback patterns suitable for a first-time customer.

## Target users

- **Customer:** browses beauty products, searches and filters the catalogue, saves wishlist items, and checks out with COD.
- **Store administrator:** manages product records and stock values, manually reviews order requests, and views customer records.
- **University evaluator:** explores the customer journey, admin authorization boundary, HCI decisions, and Firebase architecture.

## Functional requirements

| ID | Requirement | Implementation |
|---|---|---|
| FR-01 | Show a responsive customer storefront | `src/App.tsx`, `src/App.css` |
| FR-02 | Read published products from Firestore | Firestore live snapshot in `src/App.tsx` |
| FR-03 | Search, filter by category/price, and sort products | Storefront catalogue controls |
| FR-04 | Show product details and availability | Product details dialog and stock labels |
| FR-05 | Add, remove, and change cart quantities | Storefront cart; browser local storage persistence |
| FR-06 | Register, sign in/out, reset a password | Firebase Authentication |
| FR-07 | Save wishlist items | Customer-owned `wishlists/{uid}/items` documents |
| FR-08 | Submit a pending COD order request | Direct Firestore write constrained by `firestore.rules` |
| FR-09 | Keep price and stock verification honest | Request values are unverified; no reservation or stock adjustment is performed |
| FR-10 | Manage products and order status as an admin | Custom-claim-gated admin UI and Firestore rules |
| FR-11 | Avoid claiming inventory operations | Stock movements and inventory restoration are not implemented |
| FR-12 | Demonstrate newsletter input | Address is stored in this browser only, not sent to a shared list |

Some optional store capabilities (Google sign-in, Firebase Hosting CI, and sample data) require configuration and are not enabled automatically.

## Non-functional requirements

- **Security:** Customers cannot read another customer's orders, create orders for another UID, or write privileged order fields.
- **Reliability:** A successful Firestore write is described only as a submitted request; failed writes preserve the cart.
- **Usability:** Product prices, stock, loading state, errors, empty states, and COD payment are explicit.
- **Accessibility:** Semantic sections, form labels, keyboard-visible focus, button names, status announcements, and reduced-motion support are included.
- **Responsiveness:** Store and admin layouts adapt to mobile, tablet, and desktop widths.
- **Maintainability:** UI, Firebase initialization, product types, rules, functions, and setup instructions are kept in focused files.
- **Privacy:** Admin access is claim-protected; customer order and profile reads are limited by UID. A production launch still needs a reviewed privacy notice and retention policy.

## HCI principles implemented

| HCI principle | Example |
|---|---|
| Visibility of system status | Loading indicators, stock labels, cart count, order confirmation, sign-in and subscription feedback |
| Match between system and real world | Familiar product categories, PKR prices, delivery address, and explicit Cash on Delivery wording |
| User control and freedom | Dismissible dialogs, editable quantities, removable cart items, and a clear route back to the storefront |
| Error prevention | Required fields, bounded order request fields, confirmation before product deletion/cancellation, and clear disclosure that price and stock are not verified |
| Recognition rather than recall | Visible categories, filters, product images, prices, order summaries, and status labels |
| Consistency and standards | Repeated typography, buttons, forms, navigation patterns, and status-pill styling |
| Aesthetic and minimalist design | Restrained color palette, generous spacing, and clear content hierarchy |
| Help users recover from errors | Specific form and checkout feedback; failed orders do not clear the cart |
| Accessibility | Keyboard focus indicators, semantic labels, status roles, reduced-motion handling, and responsive controls |

## System architecture

```text
React + TypeScript storefront/admin
  ├─ Firebase Authentication (customer identity + ID token custom claims)
  ├─ Cloud Firestore (catalogue, users, order requests, wishlists)
  └─ Static/external product image URLs
Firebase Hosting serves the Vite production build

Trusted local maintenance only:
  └─ Firebase Admin SDK script sets an administrator custom claim
```

### Trust boundaries

- Order rules require the authenticated UID to own the request, COD payment, initial pending states, exact top-level and nested field allowlists, basic types, and size bounds.
- Customers can still supply fabricated item names, prices, and totals within those bounds. Rules do not compare items with current products, calculate totals, verify stock, or reserve/decrement inventory.
- Customer order reads are scoped to the owner UID. Admin order updates can affect only status, payment status, and update time, and must follow allowed transitions.
- The admin UI and Firestore rules require the verified ID token custom claim `admin === true`. A trusted local Admin SDK script assigns this claim; no client-side promotion is provided.
- No Cloud Functions or Firebase Storage are used by the current runtime.

## Firebase data model

| Collection/path | Example fields | Purpose |
|---|---|---|
| `users/{uid}` | `email`, `displayName`, `createdAt` | Customer profile |
| `products/{productId}` | `name`, `category`, `price`, `compareAtPrice`, `stock`, `soldCount`, `published`, `imageUrl`, `imagePath` | Product and current stock source |
| `categories/{categoryId}` | `name`, `active`, `sortOrder` | Optional category metadata |
| `orders/{orderId}` | `orderNumber`, `userId`, `customer`, `items`, `subtotal`, `deliveryFee`, `total`, `status`, `paymentMethod`, `paymentStatus`, `createdAt`, `updatedAt` | Unverified request; customer-owned reads and constrained admin status changes |
| `wishlists/{uid}/items/{productId}` | `productId`, `createdAt` | Customer-owned saved products |
| `reviews/{reviewId}` | `userId`, `productId`, `rating`, `text`, `status` | Moderated product reviews |
| `inventory/{movementId}` | No current runtime writes | Denied to clients; no stock movement tracking is claimed |

The product's `stock` field is displayed as catalogue information. An order request does not reserve, decrement, or restore stock.

## Main workflows

### Customer order

1. Customer searches or filters the published Firestore catalogue.
2. Product details show the current description, price, and available stock.
3. Cart quantities are bounded by current stock and saved locally.
4. Customer signs in and enters delivery information.
5. Client writes a COD request containing the displayed product and delivery details.
6. Firestore rules verify the authenticated owner, allowed fields, basic types, bounds, and initial pending state. They do not verify product prices, stock, or the arithmetic in the request.
7. Confirmation says the request is unverified and requires manual review; no stock is reserved or decremented.

### Administrator

1. Administrator opens `/admin` and signs in with Firebase Authentication.
2. The app forces an ID token refresh and checks the `admin` custom claim.
3. Admin dashboard data is loaded only after that check; Firestore rules independently enforce the same claim.
4. Product changes and permitted order status updates use direct Firestore writes.
5. Product images use static or external image URLs; Firebase Storage is not used.
6. Order status changes cannot edit owner, items, delivery details, or totals. Cancellation does not restore stock.
7. The local Admin SDK script sets the admin claim; it is not a deployed service.

## Testing and verification

### Automated checks

| Check | Result |
|---|---|
| Frontend TypeScript + Vite production build | Passed on 2026-11-03 with `npm run build` |
| Oxlint | Completed on 2026-11-03 with one existing React purity warning at `src/App.tsx:442` |
| Firestore rules emulator test | Not run; Firebase CLI and Java are not installed in the current environment |

### Firebase manual/integration test checklist

These checks require a configured Firebase project or Firebase emulators. Do not mark an item passed until it has been run.

- [ ] Register an email/password customer; verify a user profile document is created.
- [ ] Sign in, refresh, sign out, and verify password reset email delivery.
- [ ] If Google is enabled, verify Google sign-in and profile creation.
- [ ] Read published products from Firestore; verify unpublished products are not visible to customers.
- [ ] Add/edit/delete a product as admin using a public/static image URL.
- [ ] Verify non-admin users cannot enter `/admin` or read/write admin-only Firestore data.
- [ ] Refresh the page and verify the cart persists; verify wishlist changes belong to the signed-in UID.
- [ ] Submit incomplete checkout information and verify the form blocks submission.
- [ ] Place a COD request; verify its owner, exact field allowlists, and pending status in Firestore.
- [ ] Attempt to create a request for another UID, add an admin-only field, or change initial status/payment status; verify rules deny it.
- [ ] Verify request prices/totals are treated as untrusted and that no stock is reserved, decremented, or restored.
- [ ] Attempt invalid admin status transitions and edits to immutable order fields; verify rules deny them.
- [ ] Mark a delivered COD order paid; verify paid-revenue totals update.
- [ ] Query another customer's order and attempt customer writes to products, admin status fields, and unmatched paths; verify rules deny access.
- [ ] Test mobile viewport, keyboard navigation, loading/error states, and a temporarily unavailable Firebase service.

No Firebase project credentials are available in the workspace. The Firebase integration checklist, Firestore rules emulator test, and public deployment are **not claimed as verified**.

## Screenshots checklist

Capture your own screenshots after setup; do not use placeholder screenshots as test evidence.

1. Storefront desktop hero and navigation.
2. Product search, category/price filter, and sorted results.
3. Product details and stock state.
4. Cart after refresh.
5. COD request submission with an unverified status disclosure.
6. Submitted request confirmation with a real order number.
7. Admin portal rejected for a normal account.
8. Admin dashboard showing metrics labeled as limited query samples.
9. Admin product editor using a static or public image URL.
10. Admin order progression and cancellation without automatic stock restoration.
11. Mobile storefront and mobile admin navigation.
12. Firebase Console showing the order request and rule-controlled fields, with private customer information obscured.

## Deployment and configuration checklist

Follow [README.md](./README.md) to create the Firebase project, configure `.env.local`, deploy Firestore rules when ready, assign an admin claim locally, build, and optionally deploy Hosting.

Before sharing the public URL:

- Replace all sample catalogue content and images.
- Add the Firebase Hosting domain to Authentication's authorized domains.
- Verify public Firestore reads expose only published product data.
- Never place service-account credentials in frontend configuration, `VITE_` variables, or GitHub.
- Review regional data location, privacy, customer-data retention, delivery fees, and legal notices. This Spark project does not use billing-enabled Cloud Functions or Storage.
- Confirm HTTPS Hosting and repeat customer/admin tests on the deployed domain.

## Future enhancements

- Trusted price and stock validation if a permitted backend becomes available; browser-side validation alone is not authoritative.
- Product variants with variant-specific pricing and stock.
- Admin category management, refund workflows, and richer sales reports.
- Review submission UI and moderation tools.
- Newsletter unsubscribe and consent/retention management.
- Automated Firebase Emulator Suite tests and browser-based accessibility checks.
- Multi-image product galleries, localization, and regional delivery rules.

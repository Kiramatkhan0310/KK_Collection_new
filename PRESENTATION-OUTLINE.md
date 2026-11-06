# KK Collection — 12-Slide Presentation Outline

Use the outline as a speaking guide. Insert screenshots and test evidence captured from your configured project; do not present unrun checks as results.

## 1. Title
- KK Collection: a thoughtful cosmetics e-commerce experience
- Student name, course, semester, instructor, date
- Add a real deployed URL only after verifying Firebase Hosting

## 2. Problem and opportunity
- Beauty products can be difficult to compare online
- Unclear stock, fees, or checkout status can reduce user confidence
- Administrators also need reliable catalogue and order workflows

## 3. Project objectives and target users
- Customer: discover products and submit a clearly labeled COD request
- Administrator: manage catalogue, stock, and fulfillment securely
- Evaluator: assess usability, accessibility, and backend trust boundaries

## 4. User research and design assumptions
- Identify first-time shoppers and mobile-first browsing needs
- Explain assumptions used for category labels, PKR pricing, and COD
- Add actual interview/survey findings only if you collected them

## 5. Information architecture and customer journey
- Home → catalogue → product details → cart → sign in → delivery → order confirmation
- Admin journey: claim-verified sign in → dashboard → products/orders
- Include a flow diagram or annotated screenshots

## 6. Visual design and responsive interface
- Warm ivory, muted rose, charcoal, and restrained gold
- Editorial typography, product imagery, whitespace, clear navigation
- Show desktop and mobile layouts

## 7. HCI principles and accessibility
- Visibility of system status, error prevention, user control, recognition
- Keyboard focus, labeled inputs, helpful feedback, reduced motion
- Show examples of empty, loading, stock, error, and confirmation states

## 8. Technology and system architecture
- React, TypeScript, Vite, Tailwind CSS, Lucide React
- Firebase Auth, Firestore, Hosting; static/external image URLs
- Explain that Spark-compatible browser writes cannot securely validate prices or stock

## 9. Firebase data model and security
- Users, products, order requests, wishlists, and reviews
- Firestore rules restrict order fields and owner access; unmatched paths are denied
- Admin claim assigned by a trusted local Admin SDK script; no client promotion or credentials in GitHub

## 10. Demonstration
- Search/filter and product detail
- Add to cart and refresh to show persistence
- Submit a COD request; explain it is unverified and needs manual review
- Show the Firestore request; no stock is reserved or decremented
- Demonstrate a regular user's rejection from `/admin`

## 11. Testing and results
- List the exact build, lint, and integration tests you ran
- Show screenshots or emulator/console evidence
- State setup blockers and unverified items honestly

## 12. Conclusion and future work
- What HCI and Firebase skills the project demonstrates
- Current limitations and lessons learned
- Trusted price/stock validation if an allowed backend becomes available, plus reviews and accessibility testing

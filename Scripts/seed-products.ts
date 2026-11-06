import { applicationDefault, initializeApp } from 'firebase-admin/app'
import { FieldValue, getFirestore } from 'firebase-admin/firestore'
import { demoProducts } from '../src/lib/demoProducts'

const projectId = process.env.FIREBASE_PROJECT_ID || 'kk-collection-new'

initializeApp({
  credential: applicationDefault(),
  projectId,
})

const db = getFirestore()

async function seedProducts() {
  console.log(`Firebase project: ${projectId}`)
  console.log(`Products to seed: ${demoProducts.length}`)

  // Prevent accidental overwriting of existing catalogue documents.
  const existingProducts = await Promise.all(
    demoProducts.map((product) =>
      db.collection('products').doc(product.id).get(),
    ),
  )

  const existingIds = existingProducts
    .filter((document) => document.exists)
    .map((document) => document.id)

  if (existingIds.length > 0) {
    throw new Error(
      `Seed stopped. These product IDs already exist: ${existingIds.join(', ')}`,
    )
  }

  const batch = db.batch()

  for (const product of demoProducts) {
    const productRef = db.collection('products').doc(product.id)

    batch.create(productRef, {
      ...product,
      createdAt: FieldValue.serverTimestamp(),
    })
  }

  await batch.commit()

  console.log(`Successfully created ${demoProducts.length} products.`)
}

seedProducts().catch((error) => {
  console.error('Product seeding failed:', error)
  process.exitCode = 1
})
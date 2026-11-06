import { applicationDefault, initializeApp } from 'firebase-admin/app'
import { getFirestore, FieldValue } from 'firebase-admin/firestore'

const allowDemoSeed = process.env.ALLOW_DEMO_SEED === 'true'
const projectId = process.env.FIREBASE_PROJECT_ID

if (!allowDemoSeed || !projectId) {
  console.error(
    'Refusing to seed data. Set ALLOW_DEMO_SEED=true and FIREBASE_PROJECT_ID to the intended demo project.',
  )
  process.exitCode = 1
} else {
  const demoProducts = [
    {
      name: 'Cloud Nine Daily Moisturizer',
      brand: 'KK Essentials',
      category: 'Skincare',
      description: 'A lightweight everyday moisturizer for a soft, comfortable finish.',
      price: 2450,
      compareAtPrice: 2800,
      stock: 18,
      imageUrl:
        'https://images.unsplash.com/photo-1608248543803-ba4f8c70ae0b?auto=format&fit=crop&w=900&q=85',
      imageAlt: 'Skincare cream in a clean beauty still life',
      imagePath: 'products/demo-moisturizer/demo.webp',
      badge: 'Everyday favourite',
      featured: true,
      published: true,
    },
    {
      name: 'Petal Soft Lip Tint',
      brand: 'KK Essentials',
      category: 'Makeup',
      description: 'A buildable rose-toned lip tint for a soft wash of colour.',
      price: 1650,
      compareAtPrice: 1650,
      stock: 24,
      imageUrl:
        'https://images.unsplash.com/photo-1586495777744-4413f21062fa?auto=format&fit=crop&w=900&q=85',
      imageAlt: 'Rose lipstick and cosmetics on a neutral background',
      imagePath: 'products/demo-lip-tint/demo.webp',
      badge: 'New',
      featured: true,
      published: true,
    },
    {
      name: 'Soft Focus Face Palette',
      brand: 'KK Essentials',
      category: 'Makeup',
      description: 'A versatile face palette for a softly defined everyday look.',
      price: 3200,
      compareAtPrice: 3600,
      stock: 12,
      imageUrl:
        'https://images.unsplash.com/photo-1596462502278-27bfdc403348?auto=format&fit=crop&w=900&q=85',
      imageAlt: 'Neutral-toned makeup products arranged together',
      imagePath: 'products/demo-palette/demo.webp',
      badge: '',
      featured: false,
      published: true,
    },
    {
      name: 'Rosewater Glow Serum',
      brand: 'KK Essentials',
      category: 'Skincare',
      description: 'A lightweight hydrating serum to add a fresh, dewy finish.',
      price: 2850,
      compareAtPrice: 2850,
      stock: 4,
      imageUrl:
        'https://images.unsplash.com/photo-1601049541289-9b1b7bbbfe19?auto=format&fit=crop&w=900&q=85',
      imageAlt: 'Glass skincare serum bottle with a dropper',
      imagePath: 'products/demo-serum/demo.webp',
      badge: 'Almost gone',
      featured: true,
      published: true,
    },
  ]

  try {
    initializeApp({
      credential: applicationDefault(),
      projectId,
    })
    const db = getFirestore()
    const batch = db.batch()
    demoProducts.forEach((product) => {
      const ref = db.collection('products').doc(`demo-${product.imagePath.split('/')[1]}`)
      batch.set(
        ref,
        {
          ...product,
          soldCount: 0,
          createdAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      )
    })
    await batch.commit()
    console.log(`Seeded ${demoProducts.length} demo products into ${projectId}.`)
    console.log('These are sample records. Replace or remove them before a real store launch.')
  } catch (error) {
    console.error('Demo seed failed.')
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}

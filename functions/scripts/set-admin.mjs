import { applicationDefault, initializeApp } from 'firebase-admin/app'
import { getAuth } from 'firebase-admin/auth'

const uid = process.argv[2]
if (!uid) {
  console.error('Usage: npm run set-admin -- <firebase-auth-uid>')
  process.exitCode = 1
} else {
  try {
    initializeApp({
      credential: applicationDefault(),
      ...(process.env.FIREBASE_PROJECT_ID
        ? { projectId: process.env.FIREBASE_PROJECT_ID }
        : {}),
    })
    const auth = getAuth()
    const user = await auth.getUser(uid)
    await auth.setCustomUserClaims(uid, {
      ...user.customClaims,
      admin: true,
    })
    console.log(`Administrator claim set for ${user.email ?? uid}.`)
    console.log('The user must sign out and sign in again to refresh their ID token.')
  } catch (error) {
    console.error('Unable to assign the administrator claim.')
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { initializeApp } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { randomBytes } = require("crypto");
const {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse
} = require("@simplewebauthn/server");

initializeApp();

function publicError(error) {
  if (error instanceof HttpsError) return error;
  const code = error && error.code;
  const message = error && error.message ? String(error.message) : "Password reset failed.";

  if (code === "auth/user-not-found") {
    return new HttpsError("not-found", "This Firestore user does not have a matching Firebase Auth account.");
  }
  if (code === "auth/invalid-password") {
    return new HttpsError("invalid-argument", "Temporary password is not accepted by Firebase Auth.");
  }
  if (code === "auth/insufficient-permission" || code === "permission-denied") {
    return new HttpsError("permission-denied", "The reset function does not have permission to update Auth users.");
  }

  console.error("adminResetPassword failed", { code, message, stack: error && error.stack });
  return new HttpsError("internal", `Password reset failed: ${message}`);
}

async function assertAdmin(uid) {
  const snap = await getFirestore().collection("users").doc(uid).get();
  if (!snap.exists || snap.data().role !== "admin") {
    throw new HttpsError("permission-denied", "Only Wafrah admins can reset passwords.");
  }
  return snap.data();
}

exports.adminResetPassword = onCall({ region: "us-central1" }, async (request) => {
  try {
    const callerUid = request.auth && request.auth.uid;
    if (!callerUid) {
      throw new HttpsError("unauthenticated", "Sign in as an admin first.");
    }

    await assertAdmin(callerUid);

    const uid = String((request.data && request.data.uid) || "").trim();
    const newPassword = String((request.data && request.data.newPassword) || "");
    if (!uid) {
      throw new HttpsError("invalid-argument", "Choose a user to reset.");
    }
    if (newPassword.length < 6 || newPassword.length > 128) {
      throw new HttpsError("invalid-argument", "Temporary password must be 6 to 128 characters.");
    }

    const db = getFirestore();
    const targetRef = db.collection("users").doc(uid);
    const targetSnap = await targetRef.get();
    if (!targetSnap.exists) {
      throw new HttpsError("not-found", "User profile was not found.");
    }

    await getAuth().updateUser(uid, { password: newPassword });
    await targetRef.set({
      forcePasswordChange: true,
      passwordResetRequested: true,
      passwordResetBy: callerUid,
      passwordResetAt: FieldValue.serverTimestamp()
    }, { merge: true });

    const target = targetSnap.data() || {};
    return { ok: true, username: target.username || uid };
  } catch (error) {
    throw publicError(error);
  }
});

function webAuthnContext(request) {
  const origin = String(request.rawRequest.headers.origin || "").trim();
  let url;
  try { url = new URL(origin); } catch (_) {
    throw new HttpsError("failed-precondition", "Biometric login requires a secure website origin.");
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !local) {
    throw new HttpsError("failed-precondition", "Biometric login requires HTTPS.");
  }
  return { origin: url.origin, rpID: url.hostname };
}

function challengeId() {
  return randomBytes(24).toString("base64url");
}

async function saveChallenge(data) {
  const id = challengeId();
  await getFirestore().collection("passkeyChallenges").doc(id).set({
    ...data,
    createdAt: Date.now(),
    expiresAt: Date.now() + 5 * 60 * 1000
  });
  return id;
}

async function takeChallenge(id, purpose) {
  const ref = getFirestore().collection("passkeyChallenges").doc(String(id || ""));
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError("failed-precondition", "The biometric request expired. Try again.");
  const data = snap.data();
  await ref.delete();
  if (data.purpose !== purpose || Number(data.expiresAt) < Date.now()) {
    throw new HttpsError("failed-precondition", "The biometric request expired. Try again.");
  }
  return data;
}

async function findLoginUser(login) {
  const value = String(login || "").trim().toLowerCase();
  if (!value) throw new HttpsError("invalid-argument", "Enter your username or email first.");
  if (value.includes("@")) {
    try { return await getAuth().getUserByEmail(value); } catch (_) {}
  }
  const username = value.replace(/[^a-z0-9._-]/g, "");
  const snap = await getFirestore().collection("users").where("username", "==", username).limit(1).get();
  if (snap.empty) throw new HttpsError("not-found", "No biometric login is registered for this account.");
  return getAuth().getUser(snap.docs[0].id);
}

exports.beginPasskeyRegistration = onCall({ region: "us-central1" }, async (request) => {
  const uid = request.auth && request.auth.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Sign in with your password before enabling biometrics.");
  const { origin, rpID } = webAuthnContext(request);
  const authUser = await getAuth().getUser(uid);
  const profileSnap = await getFirestore().collection("users").doc(uid).get();
  const profile = profileSnap.data() || {};
  const passkeysSnap = await getFirestore().collection("users").doc(uid).collection("passkeys").get();
  const options = await generateRegistrationOptions({
    rpName: "Wafrah 2.0",
    rpID,
    userID: Buffer.from(uid, "utf8"),
    userName: profile.username || authUser.email || uid,
    userDisplayName: profile.name || profile.username || "Wafrah Investor",
    attestationType: "none",
    authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
    excludeCredentials: passkeysSnap.docs.map(doc => ({
      id: doc.id,
      transports: doc.data().transports || []
    }))
  });
  const id = await saveChallenge({ purpose: "register", uid, challenge: options.challenge, origin, rpID });
  return { challengeId: id, options };
});

exports.finishPasskeyRegistration = onCall({ region: "us-central1" }, async (request) => {
  const uid = request.auth && request.auth.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Sign in again before enabling biometrics.");
  const saved = await takeChallenge(request.data && request.data.challengeId, "register");
  if (saved.uid !== uid) throw new HttpsError("permission-denied", "This biometric request belongs to another account.");
  const response = request.data && request.data.response;
  const result = await verifyRegistrationResponse({
    response,
    expectedChallenge: saved.challenge,
    expectedOrigin: saved.origin,
    expectedRPID: saved.rpID,
    requireUserVerification: true
  });
  if (!result.verified || !result.registrationInfo) throw new HttpsError("permission-denied", "Biometric registration could not be verified.");
  const credential = result.registrationInfo.credential;
  await getFirestore().collection("users").doc(uid).collection("passkeys").doc(credential.id).set({
    publicKey: Buffer.from(credential.publicKey).toString("base64"),
    counter: credential.counter,
    transports: (response && response.response && response.response.transports) || [],
    deviceType: result.registrationInfo.credentialDeviceType || "unknown",
    backedUp: result.registrationInfo.credentialBackedUp === true,
    createdAt: FieldValue.serverTimestamp(),
    lastUsedAt: null
  });
  const count = (await getFirestore().collection("users").doc(uid).collection("passkeys").get()).size;
  await getFirestore().collection("users").doc(uid).set({ passkeyCount: count, passkeyEnabledAt: FieldValue.serverTimestamp() }, { merge: true });
  return { ok: true, passkeyCount: count };
});

exports.beginPasskeyLogin = onCall({ region: "us-central1" }, async (request) => {
  const { origin, rpID } = webAuthnContext(request);
  const authUser = await findLoginUser(request.data && request.data.login);
  const passkeysSnap = await getFirestore().collection("users").doc(authUser.uid).collection("passkeys").get();
  if (passkeysSnap.empty) throw new HttpsError("failed-precondition", "Enable biometric login from Settings after signing in with your password.");
  const options = await generateAuthenticationOptions({
    rpID,
    userVerification: "required",
    allowCredentials: passkeysSnap.docs.map(doc => ({ id: doc.id, transports: doc.data().transports || [] }))
  });
  const id = await saveChallenge({ purpose: "login", uid: authUser.uid, challenge: options.challenge, origin, rpID });
  return { challengeId: id, options };
});

exports.finishPasskeyLogin = onCall({ region: "us-central1" }, async (request) => {
  const saved = await takeChallenge(request.data && request.data.challengeId, "login");
  const response = request.data && request.data.response;
  const credentialId = String(response && response.id || "");
  const ref = getFirestore().collection("users").doc(saved.uid).collection("passkeys").doc(credentialId);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError("permission-denied", "This biometric credential is not registered.");
  const stored = snap.data();
  const result = await verifyAuthenticationResponse({
    response,
    expectedChallenge: saved.challenge,
    expectedOrigin: saved.origin,
    expectedRPID: saved.rpID,
    credential: {
      id: credentialId,
      publicKey: Buffer.from(stored.publicKey, "base64"),
      counter: Number(stored.counter) || 0,
      transports: stored.transports || []
    },
    requireUserVerification: true
  });
  if (!result.verified) throw new HttpsError("permission-denied", "Biometric verification failed.");
  await ref.set({ counter: result.authenticationInfo.newCounter, lastUsedAt: FieldValue.serverTimestamp() }, { merge: true });
  return { token: await getAuth().createCustomToken(saved.uid) };
});

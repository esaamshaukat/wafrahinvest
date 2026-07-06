const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { initializeApp } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");

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
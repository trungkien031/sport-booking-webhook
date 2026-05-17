require("dotenv").config();
const express = require("express");
const admin = require("firebase-admin");

// ─── Firebase Admin ───────────────────────────────────────────────────────────
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

const app = express();
app.use(express.json());

// ─── Health check ─────────────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({ status: "ok", service: "sport-booking-webhook" });
});

// ─── SePay Webhook ────────────────────────────────────────────────────────────
// SePay POST về đây mỗi khi có giao dịch vào tài khoản ngân hàng của vendor
app.post("/webhook/sepay", async (req, res) => {
  try {
    // 1. Xác thực token
    const authHeader = req.headers["authorization"] ?? "";
    const expectedToken = process.env.SEPAY_WEBHOOK_TOKEN ?? "";
    if (expectedToken && authHeader !== `Apikey ${expectedToken}`) {
      console.warn("Unauthorized webhook request");
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }

    const payload = req.body;
    console.log("SePay webhook received:", JSON.stringify(payload));

    // 2. Chỉ xử lý giao dịch đến (tiền vào)
    if (payload.transferType !== "in") {
      return res.status(200).json({ success: true, message: "Skipped outbound" });
    }

    // 3. Tìm mã SPORTZ-XXXXXXXX trong nội dung chuyển khoản
    const content = (payload.content ?? "").toUpperCase();
    const match = content.match(/SPORTZ-([A-Z0-9]{8})/);

    if (!match) {
      console.log("No SPORTZ code found in:", content);
      return res.status(200).json({ success: true, message: "No booking code" });
    }

    const shortCode = match[1]; // VD: "AB12CD34"
    console.log("Found booking code:", shortCode);

    // 4. Tìm các booking chờ thanh toán có bookingId khớp shortCode
    const bookingsSnap = await db
      .collection("bookings")
      .where("paymentStatus", "in", ["unpaid", "awaiting_confirmation"])
      .get();

    const matchedDocs = bookingsSnap.docs.filter((doc) => {
      const cleanId = doc.id.replace(/-/g, "").toUpperCase();
      return cleanId.startsWith(shortCode);
    });

    if (matchedDocs.length === 0) {
      console.warn("No booking matched shortCode:", shortCode);
      return res.status(200).json({ success: true, message: "Booking not found" });
    }

    // 5. Tính tổng deposit cần cọc, so với số tiền nhận được
    const firstData = matchedDocs[0].data();
    const userId = firstData.userId ?? "";
    const vendorId = firstData.vendorId ?? "";
    const facilityName = firstData.facilityName ?? "";
    const courtName = firstData.courtName ?? "";

    const totalDeposit = matchedDocs.reduce(
      (sum, doc) => sum + (doc.data().depositAmount ?? 0),
      0
    );

    // Cho phép lệch ±5% (làm tròn, phí chuyển khoản...)
    const amountMatches =
      Math.abs(payload.transferAmount - totalDeposit) <= totalDeposit * 0.05;

    const newPaymentStatus = amountMatches
      ? "deposit_confirmed"
      : "awaiting_confirmation";
    const newBookingStatus = amountMatches ? "confirmed" : "pending";

    // 6. Cập nhật tất cả bookings cùng session
    const batch = db.batch();
    for (const doc of matchedDocs) {
      batch.update(doc.ref, {
        paymentStatus: newPaymentStatus,
        status: newBookingStatus,
        sePayTransactionId: payload.id,
        sePayTransactionDate: payload.transactionDate,
        paidAmount: payload.transferAmount,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }
    await batch.commit();

    // 7. Gửi in-app notification
    const timeSlot = firstData.timeSlot ?? {};
    const timeStr = timeSlot.start
      ? `${timeSlot.start}–${timeSlot.end}`
      : "";

    if (amountMatches) {
      // Notify user: tự động xác nhận
      await pushNotification({
        db,
        userId,
        title: "Đặt sân thành công! 🎉",
        body: `${facilityName} – ${courtName} (${timeStr}) đã được xác nhận tự động. Hẹn gặp bạn trên sân!`,
        type: "bookingConfirmed",
        bookingId: matchedDocs[0].id,
      });

      // Notify vendor: nhận tiền cọc
      await pushNotification({
        db,
        userId: vendorId,
        title: "Nhận được tiền cọc 💰",
        body: `${facilityName} – ${courtName} (${timeStr}) vừa nhận ${fmtVND(payload.transferAmount)} tiền cọc. Đặt sân đã tự động xác nhận.`,
        type: "paymentReceived",
        bookingId: matchedDocs[0].id,
      });
    } else {
      // Số tiền không khớp → cảnh báo vendor kiểm tra
      await pushNotification({
        db,
        userId: vendorId,
        title: "Khách vừa chuyển khoản ⚠️",
        body: `Nhận ${fmtVND(payload.transferAmount)} (cần ${fmtVND(totalDeposit)}). Số tiền chưa khớp — vui lòng kiểm tra thủ công.`,
        type: "paymentReceived",
        bookingId: matchedDocs[0].id,
      });
    }

    console.log(
      `Processed: shortCode=${shortCode}, status=${newPaymentStatus}, bookings=${matchedDocs.length}`
    );

    return res.status(200).json({
      success: true,
      status: newPaymentStatus,
      bookingsUpdated: matchedDocs.length,
    });
  } catch (err) {
    console.error("Webhook error:", err);
    return res.status(500).json({ success: false, message: String(err) });
  }
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function pushNotification({ db, userId, title, body, type, bookingId }) {
  if (!userId) return;
  const ref = db.collection("notifications").doc();
  await ref.set({
    id: ref.id,
    userId,
    title,
    body,
    type,
    bookingId: bookingId ?? null,
    isRead: false,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
}

function fmtVND(amount) {
  return new Intl.NumberFormat("vi-VN", {
    style: "currency",
    currency: "VND",
  }).format(amount);
}

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Webhook server running on port ${PORT}`);
});

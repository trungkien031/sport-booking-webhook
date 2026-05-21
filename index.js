require("dotenv").config();
const express = require("express");
const admin = require("firebase-admin");

// ─── Firebase Admin ───────────────────────────────────────────────────────────
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();
const app = express();

app.use(express.json({ limit: "10mb" }));

// ─── Health Check ─────────────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({ 
    status: "ok", 
    service: "sport-booking-sepay-webhook",
    timestamp: new Date().toISOString()
  });
});

// ─── SePay Webhook ────────────────────────────────────────────────────────────
app.post("/webhook/sepay", async (req, res) => {
  try {
    // 1. Xác thực token
    const authHeader = req.headers["authorization"] ?? "";
    const expectedToken = process.env.SEPAY_WEBHOOK_TOKEN ?? "";

    if (expectedToken && authHeader !== `Apikey ${expectedToken}`) {
      console.warn("❌ Unauthorized webhook attempt");
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }

    const payload = req.body;
    console.log("📥 SePay Webhook received:", JSON.stringify(payload, null, 2));

    // Chỉ xử lý giao dịch tiền vào
    if (payload.transferType !== "in") {
      return res.status(200).json({ success: true, message: "Skipped outbound" });
    }

    // 2. Trích xuất mã SPORTZ-XXXXXXXX hoặc SPORTZXXXXXXXX
    // Một số ngân hàng (MBBank/Momo) tự bỏ dấu gạch ngang khi chuyển tiếp
    // nên cần match cả 2 dạng: SPORTZ-ABCD1234 và SPORTZABCD1234
    const content = (payload.content ?? "").toUpperCase().replace(/\s+/g, "");
    const match = content.match(/SPORTZ-?([A-Z0-9]{8})/);

    if (!match) {
      console.log("⚠️ No SPORTZ code found in content:", content);
      return res.status(200).json({ success: true, message: "No booking code" });
    }

    const shortCode = match[1];
    // Luôn normalize về dạng có dash vì Flutter lưu Firestore là SPORTZ-XXXXXXXX
    const paymentReference = `SPORTZ-${shortCode}`;

    console.log(`🔍 Found payment reference: ${paymentReference}`);

    // 3. Query tối ưu theo paymentReference
    const bookingsSnap = await db
      .collection("bookings")
      .where("paymentReference", "==", paymentReference)
      .where("paymentStatus", "in", ["unpaid", "awaiting_confirmation"])
      .get();

    if (bookingsSnap.empty) {
      console.warn(`❌ No matching bookings for: ${paymentReference}`);
      return res.status(200).json({ success: true, message: "Booking not found" });
    }

    const matchedDocs = bookingsSnap.docs;
    console.log(`✅ Found ${matchedDocs.length} booking(s) for ${paymentReference}`);

    // 4. Tính tổng deposit
    const totalDeposit = matchedDocs.reduce((sum, doc) => {
      return sum + (doc.data().depositAmount || 0);
    }, 0);

    // Cho phép lệch ±5%
    const amountMatches = Math.abs(payload.transferAmount - totalDeposit) <= totalDeposit * 0.05;

    const newPaymentStatus = amountMatches ? "deposit_confirmed" : "awaiting_confirmation";
    const newBookingStatus = amountMatches ? "confirmed" : "pending";

    // 5. Batch update bookings
    const batch = db.batch();
    for (const doc of matchedDocs) {
      batch.update(doc.ref, {
        paymentStatus: newPaymentStatus,
        status: newBookingStatus,
        sePayTransactionId: payload.id || null,
        sePayTransactionDate: payload.transactionDate || null,
        paidAmount: payload.transferAmount,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }
    await batch.commit();

    // 6. Xóa slot_locks nếu thanh toán thành công
    if (amountMatches) {
      const lockBatch = db.batch();
      for (const doc of matchedDocs) {
        const data = doc.data();
        const hour = parseInt((data.timeSlot?.start || "").split(":")[0], 10);

        if (data.courtId && data.dateKey && !isNaN(hour)) {
          const lockId = `${data.courtId}_${data.dateKey}_${hour}`;
          const lockRef = db.collection("slot_locks").doc(lockId);
          lockBatch.delete(lockRef);
        }
      }
      await lockBatch.commit().catch(err => 
        console.error("⚠️ Failed to delete some slot_locks:", err)
      );
    }

    // 7. Gửi Notification
    const firstData = matchedDocs[0].data();
    const timeSlot = firstData.timeSlot || {};
    const timeStr = timeSlot.start ? `${timeSlot.start}–${timeSlot.end}` : "";

    if (amountMatches) {
      await pushNotification({
        db,
        userId: firstData.userId,
        title: "Đặt sân thành công! 🎉",
        body: `${firstData.facilityName} – ${firstData.courtName} (${timeStr}) đã được xác nhận.`,
        type: "booking_confirmed",
        bookingId: matchedDocs[0].id,
      });

      await pushNotification({
        db,
        userId: firstData.vendorId,
        title: "Nhận tiền cọc thành công 💰",
        body: `${firstData.facilityName} – ${firstData.courtName} (${timeStr}) | ${fmtVND(payload.transferAmount)}`,
        type: "payment_received",
        bookingId: matchedDocs[0].id,
      });
    } else {
      await pushNotification({
        db,
        userId: firstData.vendorId,
        title: "Khách chuyển khoản - Cần kiểm tra ⚠️",
        body: `Nhận ${fmtVND(payload.transferAmount)} (yêu cầu ${fmtVND(totalDeposit)}) - ${firstData.facilityName}`,
        type: "payment_received",
        bookingId: matchedDocs[0].id,
      });
    }

    console.log(`✅ Webhook processed successfully: ${paymentReference} → ${newPaymentStatus}`);

    return res.status(200).json({
      success: true,
      paymentReference,
      status: newPaymentStatus,
      bookingsUpdated: matchedDocs.length
    });

  } catch (err) {
    console.error("🚨 Webhook Error:", err);
    return res.status(200).json({ 
      success: false, 
      message: "Internal server error" 
    });
  }
});

// ─── Helpers ─────────────────────────────────────────────────────────────────
async function pushNotification({ db, userId, title, body, type, bookingId }) {
  if (!userId) return;
  const ref = db.collection("notifications").doc();
  await ref.set({
    notifId: ref.id,
    userId,
    title,
    body,
    type,
    bookingId: bookingId || null,
    isRead: false,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
}

function fmtVND(amount) {
  return new Intl.NumberFormat("vi-VN").format(Math.round(amount)) + "đ";
}

// ─── Auto Cleanup Expired Locks ───────────────────────────────────────────────
// Chạy mỗi 60 giây ngay trong process này — không cần Cloud Function.
// Tìm tất cả slot_locks đã hết hạn → xóa lock + expire booking tương ứng
// → slot tự mở lại cho người dùng khác, không cần client làm gì thêm.

async function cleanupExpiredLocks() {
  try {
    const now = admin.firestore.Timestamp.now();

    // Lấy tất cả lock đã quá hạn và chưa bị xóa
    const expiredSnap = await db
      .collection("slot_locks")
      .where("expiresAt", "<=", now)
      .where("status", "==", "locked")
      .get();

    if (expiredSnap.empty) return;

    console.log(`🧹 Cleanup: found ${expiredSnap.size} expired lock(s)`);

    for (const lockDoc of expiredSnap.docs) {
      const lockData = lockDoc.data();
      const bookingId = lockData.bookingId;

      try {
        const batch = db.batch();

        // 1. Xóa lock → slot mở ngay lập tức trên BookingScreen realtime
        batch.delete(lockDoc.ref);

        // 2. Expire booking nếu vẫn chưa thanh toán
        if (bookingId) {
          const bookingRef = db.collection("bookings").doc(bookingId);
          const bookingSnap = await bookingRef.get();

          if (bookingSnap.exists) {
            const bookingData = bookingSnap.data();
            const payStatus = bookingData.paymentStatus;

            // Chỉ expire nếu booking chưa được confirm hoặc đang chờ
            if (payStatus === "unpaid" || payStatus === "awaiting_confirmation") {
              batch.update(bookingRef, {
                status: "expired",
                paymentStatus: "expired",
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
              });

              console.log(`  ↳ Expired booking ${bookingId} (was: ${payStatus})`);
            }
          }
        }

        await batch.commit();
        console.log(`  ↳ Deleted lock ${lockDoc.id}`);

      } catch (err) {
        console.error(`  ↳ Failed to cleanup lock ${lockDoc.id}:`, err.message);
      }
    }
  } catch (err) {
    console.error("🚨 cleanupExpiredLocks error:", err.message);
  }
}

// Chạy ngay khi server khởi động (dọn lock còn sót từ lần trước)
cleanupExpiredLocks();

// Sau đó chạy mỗi 60 giây liên tục
setInterval(cleanupExpiredLocks, 60 * 1000);

// ─── Start Server ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 SePay Webhook Server running on port ${PORT}`);
  console.log(`🧹 Auto-cleanup expired locks every 60s`);
});

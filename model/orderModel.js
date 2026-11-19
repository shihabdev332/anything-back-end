import mongoose from "mongoose";

const orderSchema = new mongoose.Schema({
  // userId কে সরাসরি User মডেলের সাথে কানেক্ট করা ভালো
  userId: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'user', 
    required: true 
  },
  products: [
    {
      // ✅ এখানে String এর বদলে ObjectId এবং ref ব্যবহার করতে হবে
      productId: { 
        type: mongoose.Schema.Types.ObjectId, 
        ref: 'product', // আপনার প্রোডাক্ট মডেলের নাম যা mongoose.model("product", ...) এ দিয়েছেন
        required: true
      },
      sellerId: { type: mongoose.Schema.Types.ObjectId, ref: 'user', index: true },
      unitPrice: { type: Number, default: 0, min: 0 },
      sellerStatus: { type: String, default: "Order Placed" },
      deliveryManId: { type: mongoose.Schema.Types.ObjectId, ref: "user", default: null, index: true },
      deliveryStatus: { type: String, enum: ["Assigned", "Picked Up", "Out for Delivery", "Delivered"], default: null },
      deliveryUpdatedAt: { type: Date, default: null },
      deliveredAt: { type: Date, default: null },
      stockReserved: { type: Boolean, default: false },
      quantity: { 
        type: Number, 
        default: 1, 
        required: true,
        min: 1,
        validate: Number.isSafeInteger,
      },
    },
  ],
  deliveryConfirmations: {
    type: [{
      sellerId: { type: mongoose.Schema.Types.ObjectId, ref: "user", required: true },
      codeHash: { type: String, default: undefined },
      codeEncrypted: { type: String, default: undefined },
      failedAttempts: { type: Number, default: 0 },
      lockedUntil: { type: Date, default: null },
    }],
    default: [],
    select: false,
  },
  totalAmount: { type: Number, required: true, min: 0 },
  address: { type: Object, required: true }, // address অবজেক্ট আকারে রাখা ভালো (city, phone, etc.)
  paymentMethod: { type: String, default: "Cash on Delivery" },
  status: { type: String, default: "Pending" },
}, { timestamps: true, optimisticConcurrency: true });

orderSchema.index({ createdAt: -1, status: 1 });
orderSchema.index({ "products.deliveryManId": 1, createdAt: -1 });

// Model exports
const orderModel = mongoose.models.order || mongoose.model("order", orderSchema);
export default orderModel;

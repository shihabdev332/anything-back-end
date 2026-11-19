import mongoose from "mongoose";

const aiRateLimitSchema = new mongoose.Schema(
  {
    _id: { type: String, required: true },
    count: { type: Number, required: true, default: 0 },
    expiresAt: { type: Date, required: true, index: { expires: 0 } },
  },
  { versionKey: false, collection: "ai_rate_limits" },
);

const aiRateLimitModel =
  mongoose.models.aiRateLimit || mongoose.model("aiRateLimit", aiRateLimitSchema);

export default aiRateLimitModel;

import dotenv from "dotenv";
dotenv.config();

import express from "express";
import cors from "cors";
import mongoose from "mongoose";

// Configurations
import dbConnect from "./config/mongodb.js";
import connectCloudinary, { getCloudinaryReadiness } from "./config/cloudinary.js";

// Routes
import userRouter from "./routes/userRouters.js";
import productRoute from "./routes/productsRoute.js";
import orderRoute from "./routes/adminOrder.js";
import locationRouter from "./routes/locationRoute.js";
import aiRouter from "./routes/aiRoute.js"; // ✅ Re-added AI Router
import ownerRouter from "./routes/ownerRoutes.js";
import deliveryRouter from "./routes/deliveryRoutes.js";

const app = express();
if (process.env.VERCEL) app.set("trust proxy", 1);

const getDatabaseReadiness = async () => {
  if (mongoose.connection.readyState !== 1 || !mongoose.connection.db) {
    const status = mongoose.connection.readyState === 2 ? "connecting" : "disconnected";
    return { ready: false, status };
  }

  try {
    await mongoose.connection.db.command({ ping: 1 }, { maxTimeMS: 2000 });
    return { ready: true, status: "connected" };
  } catch {
    return { ready: false, status: "unavailable" };
  }
};

const healthCheck = async (req, res) => {
  const [database, cloudinary] = await Promise.all([
    getDatabaseReadiness(),
    getCloudinaryReadiness(),
  ]);
  const ready = database.ready && cloudinary.ready;

  return res.status(ready ? 200 : 503).json({
    success: ready,
    status: ready ? "ok" : "not_ready",
    dependencies: {
      database: database.status,
      cloudinary: cloudinary.status,
    },
  });
};

// Middlewares
// Reflect the requesting origin so credentialed browser requests do not receive
// the invalid combination of Access-Control-Allow-Origin: * and credentials.
app.use(cors({
  origin: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: true,
}));

// Body Parsers with increased limits
// AI chat has a small request budget because both its message and history are capped.
app.use("/api/ai", express.json({ limit: "24kb" }));
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

// Readiness checks report dependency state instead of always claiming success.
app.get("/", healthCheck);
app.get("/health", healthCheck);

// Primary API Endpoints
app.use("/api/user", userRouter);
app.use("/api/product", productRoute);
app.use("/api/order", orderRoute);
app.use("/api/owner", ownerRouter);
app.use("/api/delivery", deliveryRouter);
app.use("/api/location", locationRouter);
app.use("/api/ai", aiRouter); // ✅ Re-added AI endpoint

// Standard 404 Handler
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: "API endpoint not found",
  });
});

// Global Error Handling Middleware
app.use((err, req, res, next) => {
  console.error("❌ Global Error Stack:", err.stack);
  const statusCode = err.statusCode || 500;
  res.status(statusCode).json({
    success: false,
    message: err.message || "Internal Server Error",
  });
});

const startServer = async () => {
  const dependencies = await Promise.allSettled([
    dbConnect(),
    connectCloudinary(),
  ]);

  for (const dependency of dependencies) {
    if (dependency.status === "rejected") {
      console.error("Service dependency failed to initialize:", dependency.reason.message);
    }
  }

  const port = process.env.PORT || 8000;
  await new Promise((resolve, reject) => {
    const server = app.listen(port, () => {
      console.log(`🚀 Server listening on port: ${port}`);
      resolve();
    });
    server.once("error", reject);
  });
};

startServer().catch((error) => {
  console.error("Server failed to start:", error.message);
  process.exitCode = 1;
});

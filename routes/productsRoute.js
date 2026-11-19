import express from "express";
import {
  addProduct,
  removeProduct,
  listProducts,
  listTopSellingProducts,
  listTopRatedProducts,
  listSellerProducts,
  getSellerStore,
  singleProduct,
  searchProducts,
  updateProduct,
} from "../controller/productController.js";
import { generatePremiumProductData } from "../controller/adminAiController.js"; // Importing the Premium AI Controller
import upload from "../middleware/multer.js";
import sellerAuth from "../middleware/sellerAuth.js";

const productRoute = express.Router();

// ✅ Route for AI Data Generation (Admin Only)

productRoute.post("/ai-generate", sellerAuth, generatePremiumProductData);

// ✅ Route for Adding Product
productRoute.post(
  "/add",
  sellerAuth,
  upload.fields([
    { name: "image1", maxCount: 1 },
    { name: "image2", maxCount: 1 },
    { name: "image3", maxCount: 1 },
    { name: "image4", maxCount: 1 }, // Added extra slot for high-end electronics
  ]),
  addProduct
);

// Update product details and optionally replace its images.
productRoute.post(
  "/update/:id",
  sellerAuth,
  upload.fields([
    { name: "image1", maxCount: 1 },
    { name: "image2", maxCount: 1 },
    { name: "image3", maxCount: 1 },
    { name: "image4", maxCount: 1 },
  ]),
  updateProduct
);

// ✅ Other Product Management Routes
productRoute.post("/remove", sellerAuth, removeProduct);
productRoute.get("/list", listProducts);
productRoute.get("/top-selling", listTopSellingProducts);
productRoute.get("/top-rated", listTopRatedProducts);
productRoute.get("/mine", sellerAuth, listSellerProducts);
productRoute.get("/store/:sellerId", getSellerStore);
productRoute.get("/single/:id", singleProduct);
productRoute.get("/search", searchProducts);

export default productRoute;

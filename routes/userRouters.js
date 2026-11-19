import express from "express";
import {
  adminLogin,
  removeUser,
  userLogin,
  userRegister,
  updateUser,
  getUser,
  getCurrentUser,
  updateSellerStoreProfile,
} from "../controller/userController.js";
import ownerAuth from "../middleware/ownerAuth.js";
import { verifyToken } from "../middleware/verifyToken.js";
import sellerAuth from "../middleware/sellerAuth.js";
import upload from "../middleware/multer.js";

const userRouters = express.Router();


userRouters.post("/register", userRegister);
userRouters.post("/login", userLogin);
userRouters.get("/me", verifyToken, getCurrentUser);
userRouters.put("/seller/store-profile", sellerAuth, upload.fields([
  { name: "logo", maxCount: 1 },
  { name: "banner", maxCount: 1 },
]), updateSellerStoreProfile);
userRouters.post("/seller", adminLogin);
userRouters.post("/remove", ownerAuth, removeUser);
userRouters.put("/update/:_id", ownerAuth, updateUser);
userRouters.get("/users", ownerAuth, getUser)

export default userRouters;

import { v2 as cloudinary } from "cloudinary";
import mongoose from "mongoose";
import productModel from "../model/productModel.js";
import userModel from "../model/userModel.js";
import orderModel from "../model/orderModel.js";

const claimLegacyProductsForSingleSeller = async (sellerId) => {
  const sellerCount = await userModel.countDocuments({
    isAdmin: true,
    isOwner: { $ne: true },
    isDeliveryMan: { $ne: true },
  });
  if (sellerCount === 1) {
    await productModel.updateMany(
      { $or: [{ sellerId: { $exists: false } }, { sellerId: null }] },
      { $set: { sellerId } }
    );
  }
};

const editableProductFields = new Set([
  "_type",
  "name",
  "description",
  "brand",
  "category",
  "videoUrl",
  "price",
  "discountedPercentage",
  "stock",
  "specifications",
  "colors",
  "modelNumber",
  "warranty",
  "isAvailable",
  "isFeatured",
  "offer",
  "badge",
  "tags",
]);

// English Comment: Helper function to parse AI or Frontend data
const smartParse = (data) => {
  if (!data) return undefined;
  try {
    return typeof data === "string" ? JSON.parse(data) : data;
  } catch (error) {
    return typeof data === "string" ? data.split(",").map((s) => s.trim()) : data;
  }
};

// ✅ Add Product Controller
const addProduct = async (req, res) => {
  try {
    const { _type, name, category, price, discountedPercentage, brand, badge, isAvailable, offer, description, tags, stock, modelNumber, warranty, specifications, colors, isFeatured } = req.body;
    const stockCount = Number(stock);
    if (!Number.isSafeInteger(stockCount) || stockCount < 0) {
      return res.status(400).json({ success: false, message: "Quantity must be a whole number of zero or more." });
    }

    const image1 = req.files?.image1?.[0];
    const image2 = req.files?.image2?.[0];
    const image3 = req.files?.image3?.[0];
    const image4 = req.files?.image4?.[0];

    const imagesArray = [image1, image2, image3, image4].filter((item) => item !== undefined);

    let imagesUrl = await Promise.all(
      imagesArray.map(async (item) => {
        let result = await cloudinary.uploader.upload(item.path, { resource_type: "image" });
        return result.secure_url;
      })
    );

    const productData = {
      sellerId: req.user.id,
      _type: _type || "electronics",
      name: name.trim(),
      description: description.trim(),
      category: category || "",
      brand: brand || "",
      price: Number(price),
      discountedPercentage: Number(discountedPercentage) || 0,
      stock: stockCount,
      modelNumber: modelNumber || "",
      warranty: warranty || "",
      specifications: smartParse(specifications) || {},
      colors: smartParse(colors) || [],
      tags: smartParse(tags) || [],
      images: imagesUrl,
      badge: badge || "",
      isAvailable: (isAvailable === "true" || isAvailable === true) && stockCount > 0,
      offer: offer === "true" || offer === true,
      isFeatured: isFeatured === "true" || isFeatured === true,
    };

    const product = new productModel(productData);
    await product.save();
    res.json({ success: true, message: `${name} added successfully` });
  } catch (error) {
    res.json({ success: false, message: error.message });
  }
};

// ✅ Update Product Controller (NEW FEATURE)
// English Comment: Updates product details and uploads new images if provided
const updateProduct = async (req, res) => {
  try {
    const { id } = req.params;
    // Accept only product fields sellers may edit. This blocks protected
    // fields and Mongo update operators such as `$set.sellerId` in the body.
    const updateData = Object.fromEntries(
      Object.entries(req.body || {}).filter(([field]) => editableProductFields.has(field))
    );

    if (updateData.stock !== undefined) {
      const stockCount = Number(updateData.stock);
      if (!Number.isSafeInteger(stockCount) || stockCount < 0) {
        return res.status(400).json({ success: false, message: "Quantity must be a whole number of zero or more." });
      }
      updateData.stock = stockCount;
      if (stockCount === 0) updateData.isAvailable = false;
      else if (updateData.isAvailable === undefined) updateData.isAvailable = true;
    }
    if (updateData.isAvailable !== undefined) {
      updateData.isAvailable = updateData.isAvailable === true || updateData.isAvailable === "true";
      if (updateData.stock === 0) updateData.isAvailable = false;
    }

    // Parse complex fields
    if (updateData.specifications) updateData.specifications = smartParse(updateData.specifications);
    if (updateData.tags) updateData.tags = smartParse(updateData.tags);
    if (updateData.colors) updateData.colors = smartParse(updateData.colors);

    // Handle Image Updates
    const image1 = req.files?.image1?.[0];
    const image2 = req.files?.image2?.[0];
    const image3 = req.files?.image3?.[0];
    const image4 = req.files?.image4?.[0];

    const newImages = [image1, image2, image3, image4].filter(item => item !== undefined);
    
    if (newImages.length > 0) {
      let uploadedImages = await Promise.all(
        newImages.map(async (item) => {
          let result = await cloudinary.uploader.upload(item.path, { resource_type: "image" });
          return result.secure_url;
        })
      );
      // English Comment: If new images are uploaded, update the images array
      updateData.images = uploadedImages;
    }

    await claimLegacyProductsForSingleSeller(req.user.id);
    const updatedProduct = await productModel.findOneAndUpdate(
      { _id: id, sellerId: req.user.id },
      updateData,
      { new: true, runValidators: true }
    );

    if (!updatedProduct) return res.json({ success: false, message: "Product not found" });

    res.json({ success: true, message: "Product updated successfully", updatedProduct });
  } catch (error) {
    res.json({ success: false, message: error.message });
  }
};

// ✅ Get Single Product Controller (FIXED)
// English Comment: Using req.params.id to match the dynamic route /single/:id
const singleProduct = async (req, res) => {
  try {
    const { id } = req.params; 
    const product = await productModel.findById(id).populate("sellerId", "name avatar storeName storeLogo");
    if (!product) {
      return res.json({ success: false, message: "Product not found" });
    }
    res.json({ success: true, product });
  } catch (error) {
    res.json({ success: false, message: error.message });
  }
};

const getSellerStore = async (req, res) => {
  try {
    const { sellerId } = req.params;
    if (!mongoose.isValidObjectId(sellerId)) {
      return res.status(400).json({ success: false, message: "Invalid seller ID" });
    }

    const seller = await userModel.findOne({ _id: sellerId, isAdmin: true, isOwner: { $ne: true }, isDeliveryMan: { $ne: true } }).select("name avatar storeName storeDescription storeLogo storeBanner");
    if (!seller) {
      return res.status(404).json({ success: false, message: "Seller not found" });
    }

    const products = await productModel.find({ sellerId }).sort({ createdAt: -1 });
    res.json({ success: true, seller, products });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// ✅ List All Products Controller
const listProducts = async (req, res) => {
  try {
    const products = await productModel.find({}).sort({ createdAt: -1 });
    res.json({ success: true, product: products });
  } catch (error) {
    res.json({ success: false, message: error.message });
  }
};

const listTopSellingProducts = async (_req, res) => {
  try {
    const topSales = await orderModel.aggregate([
      { $match: { status: { $ne: "Cancelled" } } },
      { $unwind: "$products" },
      { $match: { "products.sellerStatus": { $ne: "Cancelled" } } },
      { $group: { _id: "$products.productId", unitsSold: { $sum: { $ifNull: ["$products.quantity", 1] } } } },
      { $sort: { unitsSold: -1 } },
      { $limit: 8 },
    ]);
    const products = await productModel.find({
      _id: { $in: topSales.map(({ _id }) => _id) },
      isAvailable: true,
      stock: { $gt: 0 },
    });
    const rank = new Map(topSales.map(({ _id, unitsSold }) => [String(_id), unitsSold]));
    products.sort((a, b) => rank.get(String(b._id)) - rank.get(String(a._id)));
    res.json({ success: true, product: products });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

const listTopRatedProducts = async (_req, res) => {
  try {
    const products = await productModel.find({
      isAvailable: true,
      stock: { $gt: 0 },
    }).sort({ rating: -1, numReviews: -1 }).limit(8);
    res.json({ success: true, product: products });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

const listSellerProducts = async (req, res) => {
  try {
    await claimLegacyProductsForSingleSeller(req.user.id);
    const products = await productModel.find({ sellerId: req.user.id }).sort({ createdAt: -1 });
    res.json({ success: true, product: products });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// ✅ Remove Product Controller
const removeProduct = async (req, res) => {
  try {
    const { _id } = req.body;
    await claimLegacyProductsForSingleSeller(req.user.id);
    const result = await productModel.deleteOne({ _id, sellerId: req.user.id });
    if (!result.deletedCount) {
      return res.status(404).json({ success: false, message: "Product not found in your inventory" });
    }
    res.json({ success: true, message: "Product removed successfully" });
  } catch (error) {
    res.json({ success: false, message: error.message });
  }
};

// ✅ Search Products Controller
const searchProducts = async (req, res) => {
  try {
    const { query } = req.query;
    const filter = query ? {
      $or: [
        { name: { $regex: query, $options: "i" } },
        { brand: { $regex: query, $options: "i" } }
      ]
    } : {};
    const products = await productModel.find(filter).limit(50);
    res.json({ success: true, product: products });
  } catch (error) {
    res.json({ success: false, message: error.message });
  }
};

export { addProduct, removeProduct, listProducts, listTopSellingProducts, listTopRatedProducts, listSellerProducts, singleProduct, getSellerStore, searchProducts, updateProduct };

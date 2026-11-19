import mongoose from "mongoose";
import Product from "../model/productModel.js";

const MAX_SEARCH_LENGTH = 300;
const MAX_SEARCH_TERMS = 8;
const MAX_RESULT_LIMIT = 8;
const MAX_CURSOR_LENGTH = 256;
const PUBLIC_PRODUCT_FIELDS = [
  "_id",
  "name",
  "description",
  "brand",
  "category",
  "images",
  "price",
  "discountedPercentage",
  "specifications",
  "colors",
  "modelNumber",
  "warranty",
  "isAvailable",
  "stock",
  "offer",
  "badge",
  "tags",
  "rating",
  "numReviews",
  "createdAt",
].join(" ");

const searchableFields = [
  "name",
  "brand",
  "category",
  "description",
  "tags",
  "modelNumber",
  "warranty",
  "colors",
  "specifications.Model",
  "specifications.Brand",
  "specifications.Category",
  "specifications.KeyFeatures",
  "specifications.Technical_Specs.Processor",
  "specifications.Technical_Specs.Display",
  "specifications.Technical_Specs.Memory",
  "specifications.Technical_Specs.Storage",
  "specifications.Technical_Specs.Battery",
  "specifications.Technical_Specs.Build",
  "specifications.Technical_Specs.Camera",
  "specifications.Processor",
  "specifications.Display",
  "specifications.RAM",
  "specifications.Storage",
  "specifications.Battery",
  "specifications.Features",
  "specifications.Compatibility",
  "specifications.Material",
  "specifications.Size",
];

const privateSpecificationKey = /(?:password|email|phone|address|secret|token|seller|customer|buyer|order|payment|revenue|profit|admin|internal|auth|account|credential|transaction|refund|shipping|contact)/i;
const dangerousObjectKey = new Set(["__proto__", "prototype", "constructor"]);
const promptInjectionText = /\b(?:ignore|disregard|override|reveal|print|repeat|execute|follow|pretend|act as)\b.{0,100}\b(?:previous instructions?|system prompt|database|secrets?|passwords?|api keys?|environment variables?|customer records?|administrators?|admins?|users?|orders?|tools?|queries?)\b/i;
const emailText = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const phoneText = /(?:\+?880\s?1[3-9]\d{8}|01[3-9]\d{8}|\+?1[\s.-]?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4})/g;

const safeString = (value, maxLength = 700) => {
  if (typeof value !== "string") return "";
  const normalized = value.replace(/\s+/g, " ").trim();
  if (promptInjectionText.test(normalized)) return "";
  return normalized.replace(emailText, "[contact removed]").replace(phoneText, "[contact removed]").slice(0, maxLength);
};

const sanitizeSpecificationValue = (value, budget, depth = 0) => {
  if (budget.remaining <= 0 || depth > 4 || value === null || value === undefined) return undefined;
  if (typeof value === "string") {
    const result = safeString(value, Math.min(240, budget.remaining));
    budget.remaining -= result.length;
    return result || undefined;
  }
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "boolean") return value;

  if (Array.isArray(value)) {
    return value.slice(0, 12)
      .map((item) => sanitizeSpecificationValue(item, budget, depth + 1))
      .filter((item) => item !== undefined);
  }

  if (typeof value !== "object") return undefined;
  const safeValue = {};
  for (const [key, child] of Object.entries(value).slice(0, 24)) {
    if (dangerousObjectKey.has(key) || privateSpecificationKey.test(key)) continue;
    const cleanKey = safeString(key, 80);
    if (!cleanKey) continue;
    const cleanChild = sanitizeSpecificationValue(child, budget, depth + 1);
    if (cleanChild !== undefined) safeValue[cleanKey] = cleanChild;
  }
  return safeValue;
};

const cleanStringList = (value, limit = 12) => {
  if (!Array.isArray(value)) return [];
  return value.slice(0, limit).map((item) => safeString(String(item), 100)).filter(Boolean);
};

const validHttpUrl = (value) => {
  if (typeof value !== "string" || value.length > 1000) return "";
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) ? url.toString() : "";
  } catch {
    return "";
  }
};

const toPublicProduct = (product) => {
  const productId = product?._id?.toString?.();
  const price = product?.price === null || product?.price === undefined || product?.price === ""
    ? Number.NaN
    : Number(product.price);
  const rawDiscount = Number(product?.discountedPercentage || 0);
  const discountPercent = Number.isFinite(rawDiscount) && rawDiscount >= 0 && rawDiscount <= 100
    ? rawDiscount
    : 0;
  const stockCount = Number(product?.stock);
  const inStock = product?.isAvailable === true && Number.isFinite(stockCount) && stockCount > 0;
  const specifications = sanitizeSpecificationValue(product?.specifications, { remaining: 2400 }) || {};
  const specificationFeatures = specifications.KeyFeatures || specifications.Features || specifications.features;

  return {
    name: safeString(product?.name, 160) || "Unnamed product",
    brand: safeString(product?.brand, 100),
    category: safeString(product?.category, 100),
    description: safeString(product?.description, 700),
    price: Number.isFinite(price) && price >= 0 ? price : null,
    originalPrice: Number.isFinite(price) && price >= 0 && discountPercent > 0
      ? Number((price * (1 + discountPercent / 100)).toFixed(2))
      : null,
    discountPercent,
    inStock,
    availability: inStock ? "In stock" : "Out of stock",
    specifications,
    features: cleanStringList(Array.isArray(specificationFeatures) ? specificationFeatures : product?.tags),
    colors: cleanStringList(product?.colors, 8),
    images: Array.isArray(product?.images)
      ? product.images.slice(0, 4).map(validHttpUrl).filter(Boolean)
      : [],
    modelNumber: safeString(product?.modelNumber, 100),
    warranty: safeString(product?.warranty, 160),
    badge: safeString(product?.badge, 60),
    offer: product?.offer === true,
    rating: product?.rating !== null && product?.rating !== undefined && Number.isFinite(Number(product.rating))
      ? Number(product.rating)
      : null,
    reviewCount: Number.isSafeInteger(Number(product?.numReviews)) ? Number(product.numReviews) : 0,
    url: mongoose.isValidObjectId(productId) ? `/product/${productId}` : "",
  };
};

const tokenize = (text) => {
  if (typeof text !== "string" || text.length > MAX_SEARCH_LENGTH) {
    throw new TypeError(`Product search text must be a string up to ${MAX_SEARCH_LENGTH} characters.`);
  }
  return [...new Set((text.match(/[\p{L}\p{N}]{2,}/gu) || []).map((term) => term.toLowerCase()))]
    .slice(0, MAX_SEARCH_TERMS);
};

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const getTermVariants = (term) => {
  const variants = new Set([term]);
  if (/ies$/i.test(term) && term.length > 4) variants.add(`${term.slice(0, -3)}y`);
  else if (/(?:ches|shes|xes|zes)$/i.test(term) && term.length > 4) variants.add(term.slice(0, -2));
  else if (/s$/i.test(term) && !/ss$/i.test(term) && term.length > 3) variants.add(term.slice(0, -1));
  else if (term.length > 2) {
    variants.add(/[^aeiou]y$/i.test(term) ? `${term.slice(0, -1)}ies` : `${term}s`);
    if (/(?:ch|sh|x|z|o)$/i.test(term)) variants.add(`${term}es`);
  }
  return [...variants];
};

const getWords = (value) => String(value || "").toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];

const validateOptionalText = (value, label) => {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value !== "string" || value.length > 100) throw new TypeError(`${label} must be a string up to 100 characters.`);
  return value.trim();
};

const validatePrice = (value, label) => {
  if (value === undefined || value === null) return undefined;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > 1_000_000_000) {
    throw new TypeError(`${label} must be a valid non-negative price.`);
  }
  return number;
};

const decodeCursor = (cursor) => {
  if (cursor === undefined || cursor === null || cursor === "") return null;
  if (typeof cursor !== "string" || cursor.length > MAX_CURSOR_LENGTH) throw new TypeError("Product search cursor is invalid.");
  try {
    const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    const date = new Date(decoded.date);
    if (!mongoose.isValidObjectId(decoded.id) || Number.isNaN(date.getTime())) throw new Error("Invalid cursor values");
    return { date, id: new mongoose.Types.ObjectId(decoded.id) };
  } catch {
    throw new TypeError("Product search cursor is invalid.");
  }
};

const relevanceScore = (product, terms) => {
  if (!terms.length) return { score: 0, matchedTerms: 0 };
  const fields = [
    [getWords(product.name), 12],
    [getWords(product.modelNumber), 12],
    [getWords(product.brand), 9],
    [getWords(product.category), 7],
    [getWords(JSON.stringify(product.tags || [])), 5],
    [getWords(JSON.stringify(product.specifications || {})), 3],
    [getWords(product.description), 1],
  ];
  let score = 0;
  let matchedTerms = 0;

  for (const term of terms) {
    const variants = getTermVariants(term);
    let termMatched = false;
    for (const [words, weight] of fields) {
      if (variants.some((variant) => words.includes(variant))) {
        score += weight;
        termMatched = true;
      }
    }
    if (termMatched) matchedTerms += 1;
  }

  // Prefer products whose names contain the full query, while still allowing
  // a brand plus model to match when the complete phrase is not in the title.
  const nameWords = getWords(product.name);
  const allTermsInName = terms.every((term) => getTermVariants(term).some((variant) => nameWords.includes(variant)));
  if (allTermsInName) score += 20;
  return { score, matchedTerms };
};

/** Read-only access to the same public product catalog used by the storefront. */
export const searchPublicProducts = async ({
  text = "",
  category,
  brand,
  minPrice,
  maxPrice,
  inStock,
  limit = 6,
  cursor,
} = {}) => {
  const terms = tokenize(text);
  const cleanCategory = validateOptionalText(category, "Category");
  const cleanBrand = validateOptionalText(brand, "Brand");
  const minimum = validatePrice(minPrice, "Minimum price");
  const maximum = validatePrice(maxPrice, "Maximum price");
  if (minimum !== undefined && maximum !== undefined && minimum > maximum) {
    throw new TypeError("Minimum price cannot exceed maximum price.");
  }
  if (inStock !== undefined && typeof inStock !== "boolean") throw new TypeError("Stock filter must be a boolean.");
  const safeLimit = Number.isInteger(limit) ? Math.max(1, Math.min(MAX_RESULT_LIMIT, limit)) : 6;
  const pageCursor = decodeCursor(cursor);

  const conditions = [];
  // The seller/owner UI treats isAvailable=false as a hidden listing. Keep
  // hidden products out of every AI search, including explicitly crafted
  // out-of-stock filters.
  conditions.push({ isAvailable: true });
  if (terms.length) {
    // Every meaningful query term must occur somewhere in the public product
    // fields. Matching any one word was returning unrelated, newer listings.
    conditions.push({ $and: terms.map((term) => ({
      $or: searchableFields.map((field) => ({
        [field]: new RegExp(`(?:${getTermVariants(term).map(escapeRegex).join("|")})`, "i"),
      })),
    })) });
  }
  if (cleanCategory) conditions.push({ category: new RegExp(`^${escapeRegex(cleanCategory)}$`, "i") });
  if (cleanBrand) conditions.push({ brand: new RegExp(`^${escapeRegex(cleanBrand)}$`, "i") });
  if (minimum !== undefined || maximum !== undefined) {
    conditions.push({ price: { ...(minimum !== undefined ? { $gte: minimum } : {}), ...(maximum !== undefined ? { $lte: maximum } : {}) } });
  }
  if (inStock === true) conditions.push({ stock: { $gt: 0 } });
  if (inStock === false) conditions.push({ stock: { $lte: 0 } });
  if (pageCursor) {
    conditions.push({ $or: [
      { createdAt: { $lt: pageCursor.date } },
      { createdAt: pageCursor.date, _id: { $lt: pageCursor.id } },
    ] });
  }

  // There is no separate publish flag: isAvailable controls listing visibility,
  // while stock zero remains a visible item that can be reported as out of stock.
  const filter = conditions.length > 1 ? { $and: conditions } : conditions[0] || {};
  const candidates = await Product.find(filter)
    .select(PUBLIC_PRODUCT_FIELDS)
    .sort({ createdAt: -1, _id: -1 })
    .limit(safeLimit + 1)
    .lean();

  const hasMore = candidates.length > safeLimit;
  if (hasMore) candidates.pop();
  const lastCandidate = candidates.at(-1);
  const nextCursor = hasMore && lastCandidate?.createdAt && mongoose.isValidObjectId(lastCandidate._id)
    ? Buffer.from(JSON.stringify({ date: lastCandidate.createdAt.toISOString(), id: lastCandidate._id.toString() })).toString("base64url")
    : null;

  const ranked = candidates
    .map((product) => ({ product, ...relevanceScore(product, terms) }))
    .filter(({ matchedTerms }) => !terms.length || matchedTerms === terms.length)
    .sort((left, right) => right.score - left.score ||
      new Date(right.product.createdAt || 0) - new Date(left.product.createdAt || 0) ||
      String(right.product._id).localeCompare(String(left.product._id)));
  return {
    products: ranked.slice(0, safeLimit).map(({ product }) => toPublicProduct(product)),
    nextCursor,
  };
};

export const getPublicProductDetails = async (productId) => {
  if (!mongoose.isValidObjectId(productId)) return null;
  const product = await Product.findOne({ _id: productId, isAvailable: true }).select(PUBLIC_PRODUCT_FIELDS).lean();
  return product ? toPublicProduct(product) : null;
};

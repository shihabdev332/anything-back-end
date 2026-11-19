import mongoose from "mongoose";

const userSchema=new mongoose.Schema({
    name: {type: String, required:true},
    email: {type: String, required:true, unique:true},
    password: {type: String, required:true},
    avatar: {type: String,},
    storeName: { type: String, trim: true, maxlength: 70, default: "" },
    storeDescription: { type: String, trim: true, maxlength: 500, default: "" },
    storeLogo: { type: String, default: "" },
    storeBanner: { type: String, default: "" },
    isAdmin:{type:Boolean},
    isOwner:{type:Boolean, default:false},
    isDeliveryMan:{type:Boolean, default:false, index:true},
    deliverySellerId:{type:mongoose.Schema.Types.ObjectId, ref:"user", default:null, index:true},
    deliveryPhone:{type:String, trim:true, default:""},
    deliveryAssignmentRevision:{type:Number, default:0},
    userCart: {type: Object, default:{}},
},
{ minimize: false, timestamps: true }
);

userSchema.index({ isAdmin: 1, isOwner: 1, createdAt: -1 });
userSchema.index({ deliverySellerId: 1, isDeliveryMan: 1, createdAt: -1 });

const userModel = mongoose.models.user || mongoose.model("user", userSchema)


export default userModel;

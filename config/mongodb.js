import mongoose from "mongoose";

// English Comment: Function to establish or reuse a MongoDB connection
const dbConnect = async () => {
    try {
        if (mongoose.connection.readyState === 1) {
            return;
        }

        // Reuse an in-progress connection and wait until it is actually ready.
        if (mongoose.connection.readyState === 2) {
            await mongoose.connection.asPromise();
            return;
        }

        mongoose.connection.on("connected", () => {
            console.log("Db is connected successfully");
        });

        mongoose.connection.on("error", (err) => {
            console.error("Mongoose connection error:", err);
        });

        await mongoose.connect(process.env.MONGODB_URL, {
            serverSelectionTimeoutMS: 5000,
        });

    } catch (error) {
        console.error("not connected", error);
        throw new Error("Database connection failed");
    }
};

export default dbConnect;

import mongoose, { type Connection } from "mongoose";

/** Opens a dedicated connection (not mongoose's global one), so tests can open their own. */
export async function connectMongo(url: string): Promise<Connection> {
  const connection = mongoose.createConnection(url, {
    serverSelectionTimeoutMS: 5000,
    // Fail fast instead of queueing operations while disconnected
    bufferCommands: false,
  });
  return connection.asPromise();
}

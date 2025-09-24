const User = require('../models/User');

// In-memory maps for quick lookup
// userId -> socketId (supports single active session per user for simplicity)
const userSocketMap = new Map();
// socketId -> userId
const socketUserMap = new Map();

module.exports = function initSocket(io) {
  io.on('connection', async (socket) => {
    try {
      const session = socket.request.session;
      const user = session?.user;
      if (!user) {
        // Not authenticated socket; ignore but allow connection for public pages if any.
        return;
      }

      // Bind user <-> socket
      userSocketMap.set(user._id, socket.id);
      socketUserMap.set(socket.id, user._id);

      // Mark online in DB and broadcast presence
      await User.updateOne({ _id: user._id }, { $set: { online: true, socketId: socket.id } });
      broadcastPresence(io, user._id);

      // Handle client asking for presence refresh
      socket.on('presence:refresh', async () => {
        broadcastPresence(io);
      });

      // Signaling events
      // payload: { toUserId, offer, metadata }
      socket.on('call-user', async (payload) => {
        const { toUserId, offer, metadata } = payload || {};
        const targetSocketId = userSocketMap.get(toUserId);
        if (!targetSocketId) {
          socket.emit('call-error', { toUserId, message: 'User is offline.' });
          return;
        }
        io.to(targetSocketId).emit('incoming-call', {
          fromUserId: user._id,
          fromName: user.name,
          offer,
          metadata: metadata || {}
        });
      });

      // payload: { toUserId, answer }
      socket.on('answer-call', (payload) => {
        const { toUserId, answer } = payload || {};
        const targetSocketId = userSocketMap.get(toUserId);
        if (!targetSocketId) return;
        io.to(targetSocketId).emit('call-answered', {
          fromUserId: user._id,
          answer
        });
      });

      // payload: { toUserId, candidate }
      socket.on('ice-candidate', (payload) => {
        const { toUserId, candidate } = payload || {};
        const targetSocketId = userSocketMap.get(toUserId);
        if (!targetSocketId) return;
        io.to(targetSocketId).emit('ice-candidate', {
          fromUserId: user._id,
          candidate
        });
      });

      // payload: { toUserId, reason }
      socket.on('end-call', (payload) => {
        const { toUserId, reason } = payload || {};
        const targetSocketId = userSocketMap.get(toUserId);
        if (targetSocketId) {
          io.to(targetSocketId).emit('call-ended', { fromUserId: user._id, reason: reason || 'ended' });
        }
      });

      socket.on('disconnect', async () => {
        const userId = socketUserMap.get(socket.id);
        if (userId) {
          userSocketMap.delete(userId);
          socketUserMap.delete(socket.id);
          await User.updateOne({ _id: userId }, { $set: { online: false, socketId: null } });
          broadcastPresence(io, userId);
        }
      });
    } catch (err) {
      console.error('Socket error:', err);
    }
  });
};

async function broadcastPresence(io, changedUserId = null) {
  try {
    // Notify all clients that presence changed; clients will fetch via REST or receive event
    io.emit('online-status', { changedUserId });
  } catch (e) {
    console.error('Presence broadcast error:', e);
  }
}

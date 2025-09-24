const User = require('../models/User');

// Return users filtered by opposite role and with online/offline status
exports.getOnlineUsers = async (req, res) => {
  try {
    const current = req.session.user;
    if (!current) return res.status(401).json({ error: 'Unauthorized' });

    const targetRole = current.role === 'client' ? 'agency' : 'client';
    const users = await User.find({ role: targetRole }).select('_id name email role online');
    return res.json({ users });
  } catch (err) {
    console.error('getOnlineUsers error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

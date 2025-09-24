const User = require('../models/User');

exports.getLogin = (req, res) => {
  res.render('pages/login', { error: null });
};

exports.getRegister = (req, res) => {
  res.render('pages/register', { error: null });
};

exports.postRegister = async (req, res) => {
  try {
    const { name, email, password, role } = req.body;
    if (!name || !email || !password || !role) {
      return res.status(400).render('pages/register', { error: 'All fields are required.' });
    }
    if (!['client', 'agency'].includes(role)) {
      return res.status(400).render('pages/register', { error: 'Invalid role selected.' });
    }
    const exists = await User.findOne({ email });
    if (exists) return res.status(400).render('pages/register', { error: 'Email already in use.' });

    const user = new User({ name, email, password, role });
    await user.save();
    return res.redirect('/auth/login');
  } catch (err) {
    console.error('Register error:', err);
    return res.status(500).render('pages/register', { error: 'Server error. Please try again.' });
  }
};

exports.postLogin = async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email });
    if (!user) return res.status(400).render('pages/login', { error: 'Invalid credentials.' });

    const match = await user.comparePassword(password);
    if (!match) return res.status(400).render('pages/login', { error: 'Invalid credentials.' });

    // Save minimal user info in session
    req.session.user = { _id: user._id.toString(), name: user.name, email: user.email, role: user.role };
    // Mark online flag - actual socket binding happens on socket connection
    await User.updateOne({ _id: user._id }, { $set: { online: true } });

    return res.redirect('/home');
  } catch (err) {
    console.error('Login error:', err);
    return res.status(500).render('pages/login', { error: 'Server error. Please try again.' });
  }
};

exports.postLogout = async (req, res) => {
  try {
    const user = req.session.user;
    if (user) {
      await User.updateOne({ _id: user._id }, { $set: { online: false, socketId: null } });
    }
    req.session.destroy(() => {
      res.redirect('/auth/login');
    });
  } catch (err) {
    console.error('Logout error:', err);
    res.redirect('/auth/login');
  }
};

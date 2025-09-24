const express = require('express');
const authController = require('../controllers/authController');

// Export a factory to receive ensureGuest if needed
module.exports = function(ensureGuest) {
  const router = express.Router();

  // Pages are handled in server.js with ensureGuest, here keep POST handlers
  router.post('/register', authController.postRegister);
  router.post('/login', authController.postLogin);
  router.post('/logout', authController.postLogout);

  return router;
};

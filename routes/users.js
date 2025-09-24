const express = require('express');
const router = express.Router();
const userController = require('../controllers/userController');

router.get('/online', userController.getOnlineUsers);

module.exports = router;

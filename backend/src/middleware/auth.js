const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');

const SECRET_KEY = process.env.JWT_SECRET || 'fallback_secret_key_for_dev';

const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (token == null) {
      req.user = null;
      return next(); // Proceed without user, we handle guest differently
  }

  jwt.verify(token, SECRET_KEY, (err, user) => {
    if (err) {
        req.user = null;
    } else {
        req.user = user;
    }
    next();
  });
};

module.exports = authenticateToken;

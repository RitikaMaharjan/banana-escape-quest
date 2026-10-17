require('dotenv').config();

module.exports = {
  port: process.env.PORT || 3000,
  sessionSecret: process.env.SESSION_SECRET,
  bananaApiUrl: process.env.BANANA_API_URL,
};
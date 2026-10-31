require('dotenv').config();

if (!process.env.SESSION_SECRET) {
  throw new Error('SESSION_SECRET is missing. Copy .env.example to .env and fill it in.');
}

module.exports = {
  port: process.env.PORT || 3000,
  sessionSecret: process.env.SESSION_SECRET,
  bananaApiUrl: process.env.BANANA_API_URL,
  isProduction: process.env.NODE_ENV === 'production',
};
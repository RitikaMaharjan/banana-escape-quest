const express = require('express');
const { getPuzzle, checkAnswer } = require('../controllers/puzzleController');

const router = express.Router();

router.get('/', getPuzzle);
router.post('/answer', checkAnswer);

module.exports = router;
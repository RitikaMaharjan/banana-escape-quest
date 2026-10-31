const express = require('express');
const requireAuth = require('../middleware/requireAuth');
const game = require('../controllers/gameController');

const router = express.Router();

router.use(requireAuth);

router.get('/state', game.getState);
router.get('/leaderboard', game.getLeaderboard);
router.post('/start', game.startRun);
router.post('/lock/:id/puzzle', game.loadLockPuzzle);
router.post('/lock/:id/hint', game.hintLock);
router.post('/lock/:id/answer', game.answerLock);

module.exports = router;
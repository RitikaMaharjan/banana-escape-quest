// Game rules live on the server so the browser can't cheat:
// the timer, the answers, the hints and the score are all decided here.
// AI-assisted (Claude, Anthropic): run/timer/hint/score/leaderboard logic was added with AI help.

const { fetchPuzzle } = require('../services/bananaService');
const db = require('../db/database');

const TOTAL_LOCKS = 3;
const STREAK_BONUS = 25; // bonus points = 25 x current streak, e.g. 25, 50, 75
const MAX_FETCH_TRIES = 5; // tries to get a puzzle the player has not seen this run

// attempts = wrong answers before a lock jams, hints = per lock, multiplier = score multiplier
const DIFFICULTIES = {
  easy: { label: 'Easy', timeMs: 5 * 60 * 1000, attempts: 7, hints: 3, multiplier: 0.8 },
  normal: { label: 'Normal', timeMs: 3 * 60 * 1000, attempts: 5, hints: 2, multiplier: 1 },
  hard: { label: 'Hard', timeMs: 2 * 60 * 1000, attempts: 3, hints: 1, multiplier: 1.5 },
};
const DEFAULT_LEVEL = 'normal';

function cfgFor(run) {
  return DIFFICULTIES[run.difficulty] || DIFFICULTIES[DEFAULT_LEVEL];
}

const getSolved = db.prepare('SELECT lock_id FROM progress WHERE user_id = ? ORDER BY lock_id');
const markSolved = db.prepare('INSERT OR IGNORE INTO progress (user_id, lock_id) VALUES (?, ?)');
const clearProgress = db.prepare('DELETE FROM progress WHERE user_id = ?');

const latestRun = db.prepare('SELECT * FROM runs WHERE user_id = ? ORDER BY id DESC LIMIT 1');
const insertRun = db.prepare('INSERT INTO runs (user_id, started_at, difficulty) VALUES (?, ?, ?)');
const finishRun = db.prepare('UPDATE runs SET status = ?, finished_at = ?, score = ? WHERE id = ?');
const addWrong = db.prepare('UPDATE runs SET wrong_answers = wrong_answers + 1, streak = 0 WHERE id = ?');
const addCorrect = db.prepare('UPDATE runs SET streak = streak + 1, bonus = bonus + ? WHERE id = ?');
const addHint = db.prepare('UPDATE runs SET hints_used = hints_used + 1 WHERE id = ?');

const topScores = db.prepare(`
  SELECT username, score, time_ms, difficulty FROM (
    SELECT u.username, r.score, r.difficulty, r.finished_at - r.started_at AS time_ms,
           ROW_NUMBER() OVER (
             PARTITION BY r.user_id
             ORDER BY r.score DESC, r.finished_at - r.started_at ASC
           ) AS rn
    FROM runs r JOIN users u ON u.id = r.user_id
    WHERE r.status = 'won'
  )
  WHERE rn = 1
  ORDER BY score DESC, time_ms ASC
  LIMIT 10
`);

// Returns the user's latest run, closing it as a timeout if the clock has run out.
function loadRun(userId) {
  const run = latestRun.get(userId);
  if (run && run.status === 'active' && Date.now() > run.started_at + cfgFor(run).timeMs) {
    finishRun.run('timeout', run.started_at + cfgFor(run).timeMs, 0, run.id);
    return latestRun.get(userId);
  }
  return run;
}

function calcScore(run, now) {
  const cfg = cfgFor(run);
  const remainingSec = Math.max(0, Math.floor((run.started_at + cfg.timeMs - now) / 1000));
  const base = 500 + remainingSec * 5 + run.bonus - run.wrong_answers * 50 - run.hints_used * 100;
  return Math.max(0, Math.round(base * cfg.multiplier));
}

function publicState(userId) {
  const run = loadRun(userId);
  const solved = getSolved.all(userId).map((row) => row.lock_id);
  const status = run ? run.status : 'idle';
  const cfg = run ? cfgFor(run) : DIFFICULTIES[DEFAULT_LEVEL];

  return {
    totalLocks: TOTAL_LOCKS,
    difficulties: DIFFICULTIES,
    difficulty: run ? run.difficulty : DEFAULT_LEVEL,
    timeLimitMs: cfg.timeMs,
    maxAttempts: cfg.attempts,
    maxHints: cfg.hints,
    status,
    solved,
    wrong: run ? run.wrong_answers : 0,
    hints: run ? run.hints_used : 0,
    streak: run ? run.streak : 0,
    bonus: run ? run.bonus : 0,
    remainingMs: status === 'active' ? Math.max(0, run.started_at + cfg.timeMs - Date.now()) : 0,
    score: run && status === 'won' ? run.score : null,
    timeTakenMs: run && status === 'won' ? run.finished_at - run.started_at : null,
  };
}

// Puzzle answers waiting to be checked. They live in the session and are never sent to the browser.
function pendingFor(req) {
  if (!req.session.pending) req.session.pending = {};
  return req.session.pending;
}

function parseLockId(req) {
  const id = Number(req.params.id);
  return Number.isInteger(id) && id >= 1 && id <= TOTAL_LOCKS ? id : null;
}

function parsePuzzle(data) {
  const solution = Number(data.solution);
  const isDigit = Number.isInteger(solution) && solution >= 0 && solution <= 9;

  let questionUrl;
  try {
    questionUrl = new URL(data.question);
  } catch (err) {
    return null;
  }

  if (!isDigit || questionUrl.protocol !== 'https:') return null;
  return { question: data.question, solution };
}

// Asks the Banana API again (up to MAX_FETCH_TRIES) if it hands back a puzzle already used this run.
async function fetchFreshPuzzle(req) {
  if (!req.session.seen) req.session.seen = [];

  let puzzle = null;
  for (let i = 0; i < MAX_FETCH_TRIES; i++) {
    puzzle = parsePuzzle(await fetchPuzzle());
    if (!puzzle) return null;
    if (!req.session.seen.includes(puzzle.question)) break;
  }
  req.session.seen.push(puzzle.question);
  return puzzle;
}

// Shared checks for the lock routes. Returns { id, run } or sends an error and returns null.
function activeLockContext(req, res) {
  const id = parseLockId(req);
  if (!id) {
    res.status(404).json({ error: 'Unknown lock' });
    return null;
  }

  const run = loadRun(req.session.userId);
  if (!run || run.status !== 'active') {
    res.status(409).json({ error: 'No game in progress (time may be up).' });
    return null;
  }

  if (getSolved.all(req.session.userId).some((row) => row.lock_id === id)) {
    res.status(400).json({ error: 'This lock is already open' });
    return null;
  }
  return { id, run };
}

function getState(req, res) {
  res.json(publicState(req.session.userId));
}

function getLeaderboard(req, res) {
  res.json({ scores: topScores.all() });
}

function startRun(req, res) {
  const userId = req.session.userId;
  const run = loadRun(userId);
  if (run && run.status === 'active') finishRun.run('abandoned', Date.now(), 0, run.id);

  const level = DIFFICULTIES[req.body && req.body.difficulty] ? req.body.difficulty : DEFAULT_LEVEL;

  clearProgress.run(userId);
  req.session.pending = {};
  req.session.seen = [];
  insertRun.run(userId, Date.now(), level);
  res.status(201).json(publicState(userId));
}

async function loadLockPuzzle(req, res) {
  const ctx = activeLockContext(req, res);
  if (!ctx) return;

  try {
    const puzzle = await fetchFreshPuzzle(req);
    if (!puzzle) {
      return res.status(502).json({ error: 'Banana API returned an unexpected format' });
    }

    pendingFor(req)[ctx.id] = { solution: puzzle.solution, attempts: 0, hints: 0 };
    const cfg = cfgFor(ctx.run);
    res.json({ question: puzzle.question, attemptsLeft: cfg.attempts, hintsLeft: cfg.hints });
  } catch (err) {
    console.error('Puzzle error:', err.message);
    res.status(err.status || 500).json({ error: err.message });
  }
}

// Each hint narrows the answer down a bit more.
function hintText(level, solution) {
  if (level === 1) return `The missing digit is ${solution % 2 === 0 ? 'even' : 'odd'}.`;
  if (level === 2) return `The missing digit is between ${solution <= 4 ? '0 and 4' : '5 and 9'}.`;
  const options = [solution, (solution + 3) % 10, (solution + 6) % 10].sort((a, b) => a - b);
  return `The missing digit is ${options[0]}, ${options[1]} or ${options[2]}.`;
}

function hintLock(req, res) {
  const ctx = activeLockContext(req, res);
  if (!ctx) return;

  const puzzle = pendingFor(req)[ctx.id];
  if (!puzzle) return res.status(400).json({ error: "Load this lock's puzzle first" });
  const maxHints = cfgFor(ctx.run).hints;
  if (puzzle.hints >= maxHints) return res.status(400).json({ error: 'No hints left for this lock' });

  puzzle.hints += 1;
  addHint.run(ctx.run.id);

  res.json({
    hint: hintText(puzzle.hints, puzzle.solution),
    hintsLeft: maxHints - puzzle.hints,
    ...publicState(req.session.userId),
  });
}

function answerLock(req, res) {
  const ctx = activeLockContext(req, res);
  if (!ctx) return;

  const puzzle = pendingFor(req)[ctx.id];
  if (!puzzle) return res.status(400).json({ error: "Load this lock's puzzle first" });

  const { answer } = req.body || {};
  const value = Number(answer);
  if (answer === undefined || answer === '' || !Number.isInteger(value)) {
    return res.status(400).json({ error: 'Answer must be a whole number' });
  }

  const userId = req.session.userId;

  if (value === puzzle.solution) {
    markSolved.run(userId, ctx.id);
    delete pendingFor(req)[ctx.id];
    addCorrect.run(STREAK_BONUS * (ctx.run.streak + 1), ctx.run.id);

    if (getSolved.all(userId).length === TOTAL_LOCKS) {
      const now = Date.now();
      finishRun.run('won', now, calcScore(latestRun.get(userId), now), ctx.run.id);
    }
    return res.json({ correct: true, ...publicState(userId) });
  }

  addWrong.run(ctx.run.id);
  puzzle.attempts += 1;

  // Too many wrong guesses: the lock jams and the puzzle is thrown away.
  const maxAttempts = cfgFor(ctx.run).attempts;
  const jammed = puzzle.attempts >= maxAttempts;
  if (jammed) delete pendingFor(req)[ctx.id];

  res.json({
    correct: false,
    jammed,
    attemptsLeft: maxAttempts - puzzle.attempts,
    ...publicState(userId),
  });
}

module.exports = { getState, getLeaderboard, startRun, loadLockPuzzle, hintLock, answerLock };
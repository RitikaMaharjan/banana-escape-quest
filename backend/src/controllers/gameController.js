// Game rules live on the server so the browser can't cheat:
// the timer, the answers, the hints and the score are all decided here.
// AI-assisted (Claude, Anthropic): run/timer/hint/score/leaderboard logic was added with AI help.

const { fetchPuzzle } = require('../services/bananaService');
const db = require('../db/database');

const TOTAL_LOCKS = 3;
const TIME_LIMIT_MS = 3 * 60 * 1000; // 3 minutes to open every lock
const MAX_ATTEMPTS = 5; // wrong answers before a lock jams and gets a new puzzle
const MAX_HINTS = 2; // hints per lock

const getSolved = db.prepare('SELECT lock_id FROM progress WHERE user_id = ? ORDER BY lock_id');
const markSolved = db.prepare('INSERT OR IGNORE INTO progress (user_id, lock_id) VALUES (?, ?)');
const clearProgress = db.prepare('DELETE FROM progress WHERE user_id = ?');

const latestRun = db.prepare('SELECT * FROM runs WHERE user_id = ? ORDER BY id DESC LIMIT 1');
const insertRun = db.prepare('INSERT INTO runs (user_id, started_at) VALUES (?, ?)');
const finishRun = db.prepare('UPDATE runs SET status = ?, finished_at = ?, score = ? WHERE id = ?');
const addWrong = db.prepare('UPDATE runs SET wrong_answers = wrong_answers + 1 WHERE id = ?');
const addHint = db.prepare('UPDATE runs SET hints_used = hints_used + 1 WHERE id = ?');

// Best finished run for each player, top 10.
const topScores = db.prepare(`
  SELECT username, score, time_ms FROM (
    SELECT u.username, r.score, r.finished_at - r.started_at AS time_ms,
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
  if (run && run.status === 'active' && Date.now() > run.started_at + TIME_LIMIT_MS) {
    finishRun.run('timeout', run.started_at + TIME_LIMIT_MS, 0, run.id);
    return latestRun.get(userId);
  }
  return run;
}

// Faster and cleaner runs score higher.
function calcScore(run, now) {
  const secondsLeft = Math.max(0, Math.floor((run.started_at + TIME_LIMIT_MS - now) / 1000));
  return Math.max(0, 500 + secondsLeft * 5 - run.wrong_answers * 50 - run.hints_used * 100);
}

function publicState(userId) {
  const run = loadRun(userId);
  const status = run ? run.status : 'idle';

  return {
    totalLocks: TOTAL_LOCKS,
    timeLimitMs: TIME_LIMIT_MS,
    status,
    solved: getSolved.all(userId).map((row) => row.lock_id),
    wrong: run ? run.wrong_answers : 0,
    hints: run ? run.hints_used : 0,
    remainingMs: status === 'active' ? Math.max(0, run.started_at + TIME_LIMIT_MS - Date.now()) : 0,
    score: status === 'won' ? run.score : null,
    timeTakenMs: status === 'won' ? run.finished_at - run.started_at : null,
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

// Asks the Banana API again (up to 5 times) if it returns a puzzle already used in this run.
async function fetchFreshPuzzle(req) {
  if (!req.session.seen) req.session.seen = [];

  let puzzle = null;
  for (let i = 0; i < 5; i++) {
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

// Starts a new run: clears old progress and starts the clock.
function startRun(req, res) {
  const userId = req.session.userId;
  const run = loadRun(userId);
  if (run && run.status === 'active') finishRun.run('abandoned', Date.now(), 0, run.id);

  clearProgress.run(userId);
  req.session.pending = {};
  req.session.seen = [];
  insertRun.run(userId, Date.now());
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
    res.json({ question: puzzle.question, attemptsLeft: MAX_ATTEMPTS, hintsLeft: MAX_HINTS });
  } catch (err) {
    console.error('Puzzle error:', err.message);
    res.status(err.status || 500).json({ error: err.message });
  }
}

// Hint 1 says odd or even, hint 2 gives a range. Each hint costs points.
function hintLock(req, res) {
  const ctx = activeLockContext(req, res);
  if (!ctx) return;

  const puzzle = pendingFor(req)[ctx.id];
  if (!puzzle) return res.status(400).json({ error: "Load this lock's puzzle first" });
  if (puzzle.hints >= MAX_HINTS) return res.status(400).json({ error: 'No hints left for this lock' });

  puzzle.hints += 1;
  addHint.run(ctx.run.id);

  const hint = puzzle.hints === 1
    ? `The missing digit is ${puzzle.solution % 2 === 0 ? 'even' : 'odd'}.`
    : `The missing digit is between ${puzzle.solution <= 4 ? '0 and 4' : '5 and 9'}.`;

  res.json({ hint, hintsLeft: MAX_HINTS - puzzle.hints, ...publicState(req.session.userId) });
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

    // All locks open: the run is won and the score is saved.
    if (getSolved.all(userId).length === TOTAL_LOCKS) {
      const now = Date.now();
      finishRun.run('won', now, calcScore(ctx.run, now), ctx.run.id);
    }
    return res.json({ correct: true, ...publicState(userId) });
  }

  addWrong.run(ctx.run.id);
  puzzle.attempts += 1;

  // Too many wrong guesses: the lock jams and the puzzle is thrown away.
  const jammed = puzzle.attempts >= MAX_ATTEMPTS;
  if (jammed) delete pendingFor(req)[ctx.id];

  res.json({
    correct: false,
    jammed,
    attemptsLeft: MAX_ATTEMPTS - puzzle.attempts,
    ...publicState(userId),
  });
}

module.exports = { getState, getLeaderboard, startRun, loadLockPuzzle, hintLock, answerLock };
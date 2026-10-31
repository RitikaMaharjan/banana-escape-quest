// Browser side of the game. The server decides everything that matters
// (timer, answers, score); this file only displays state and sends events.
// AI-assisted (Claude, Anthropic): timer, hints, shortcuts, leaderboard, difficulty, sound and confetti were added with AI help.

const $ = (id) => document.getElementById(id);
const locksEl = $('locks');
const board = $('board');
const startCard = $('startCard');
const puzzleArea = $('puzzleArea');
const answerInput = $('answerInput');
const message = $('message');

// Cosmetic lock names and the short story line shown when each one opens.
const LOCKS = [
  { name: 'Vault door', story: 'The vault door swings open and a cold draft rushes in.' },
  { name: 'Old safe', story: 'Click! Inside the safe is a rusty key. One lock to go.' },
  { name: 'Secret hatch', story: 'The hatch drops open and daylight pours in.' },
];
const lockName = (id) => (LOCKS[id - 1] ? LOCKS[id - 1].name : `Lock ${id}`);

let state = null;
let activeLock = null;
let deadline = 0;
let timerId = null;
let lastTickSecond = null;
let level = 'normal';

// ---- Sound (Web Audio API, no files needed) and confetti ----
let audioCtx = null;
let muted = false;
try {
  muted = localStorage.getItem('muted') === '1';
} catch (err) {
  // Storage unavailable: sound stays on.
}

function tone(freq, at, dur, type = 'sine') {
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(0.08, at);
  gain.gain.exponentialRampToValueAtTime(0.001, at + dur);
  osc.connect(gain);
  gain.connect(audioCtx.destination);
  osc.start(at);
  osc.stop(at + dur);
}

const SOUNDS = {
  correct: (t) => { tone(523, t, 0.12); tone(784, t + 0.12, 0.2); },
  wrong: (t) => tone(150, t, 0.25, 'sawtooth'),
  hint: (t) => tone(660, t, 0.15, 'triangle'),
  tick: (t) => tone(880, t, 0.05, 'square'),
  win: (t) => [523, 659, 784, 1047].forEach((f, i) => tone(f, t + i * 0.14, 0.25)),
  lose: (t) => { tone(300, t, 0.2, 'triangle'); tone(200, t + 0.2, 0.35, 'triangle'); },
};

function play(name) {
  if (muted) return;
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    SOUNDS[name](audioCtx.currentTime);
  } catch (err) {
    // Sound is optional.
  }
}

function confetti() {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const colors = ['#f5c518', '#4caf6a', '#e5645a', '#f4ecd8'];
  for (let i = 0; i < 70; i++) {
    const piece = document.createElement('i');
    piece.className = 'confetti';
    piece.style.left = `${Math.random() * 100}vw`;
    piece.style.background = colors[i % colors.length];
    piece.style.animationDelay = `${Math.random() * 0.8}s`;
    piece.style.animationDuration = `${2 + Math.random() * 1.5}s`;
    document.body.appendChild(piece);
    setTimeout(() => piece.remove(), 4500);
  }
}

function setMessage(text, kind) {
  message.textContent = text;
  message.className = kind || '';
}

async function api(path, options) {
  const res = await fetch(path, options);
  if (res.status === 401) {
    window.location.href = 'login.html';
    throw new Error('Not logged in');
  }
  return { ok: res.ok, data: await res.json() };
}

const post = (path, body) => api(path, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body || {}),
});

function formatClock(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// ---- Timer: a repeating event that updates the clock ----
function tick() {
  const left = deadline - Date.now();
  $('timer').textContent = formatClock(left);
  $('timer').classList.toggle('low', left <= 30000);

  const sec = Math.ceil(left / 1000);
  if (sec > 0 && sec <= 10 && sec !== lastTickSecond) {
    lastTickSecond = sec;
    play('tick');
  }
  if (left <= 0) {
    stopTimer();
    refreshState(); // let the server confirm the timeout
  }
}

function startTimer() {
  stopTimer();
  lastTickSecond = null;
  tick();
  timerId = setInterval(tick, 250);
}

function stopTimer() {
  clearInterval(timerId);
  timerId = null;
}

// ---- Rendering ----
function renderStartCard(s) {
  const solved = s.solved.length;
  const texts = {
    won: ['You escaped!', `Score ${s.score} on ${s.difficulties[s.difficulty].label} in ${(s.timeTakenMs / 1000).toFixed(1)}s. Can you beat it?`, 'Play again'],
    timeout: ["Time's up!", `You opened ${solved} of ${s.totalLocks} locks.`, 'Try again'],
  };
  const [title, text, button] = texts[s.status] || [
    'Ready to escape?',
    `Open ${s.totalLocks} locks before the clock runs out. Mistakes and hints cost points; streaks earn bonus points.`,
    'Start',
  ];
  $('startTitle').textContent = title;
  $('startText').textContent = text;
  $('startBtn').textContent = button;
  renderDifficulty(s);
}

function renderDifficulty(s) {
  const box = $('difficulty');
  box.replaceChildren();
  Object.entries(s.difficulties).forEach(([key, cfg]) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'secondary small-btn';
    if (key === level) btn.classList.add('selected');
    btn.textContent = cfg.label;
    btn.addEventListener('click', () => {
      level = key;
      renderDifficulty(s);
    });
    box.appendChild(btn);
  });
  const c = s.difficulties[level];
  $('difficultyInfo').textContent =
    `${formatClock(c.timeMs)} on the clock, ${c.attempts} attempts and ${c.hints} hints per lock, score x${c.multiplier}`;
}

function renderLocks() {
  locksEl.replaceChildren();
  for (let id = 1; id <= state.totalLocks; id++) {
    const open = state.solved.includes(id);
    const btn = document.createElement('button');
    btn.className = 'lock';
    if (open) btn.classList.add('open');
    if (id === activeLock) btn.classList.add('active');
    btn.textContent = open ? `${lockName(id)}: open` : `${lockName(id)}: locked`;
    btn.disabled = open;
    btn.addEventListener('click', () => openLock(id));
    locksEl.appendChild(btn);
  }
  $('progress').textContent = `${state.solved.length} / ${state.totalLocks}`;
  $('progressFill').style.width = `${(state.solved.length / state.totalLocks) * 100}%`;
  $('hintsUsed').textContent = state.hints;
  $('wrongCount').textContent = state.wrong;
  $('streak').textContent = state.streak;
}

function applyState(s) {
  const wasActive = state && state.status === 'active';
  state = s;
  const running = s.status === 'active';

  board.hidden = !running;
  startCard.hidden = running;

  if (running) {
    deadline = Date.now() + s.remainingMs;
    startTimer();
    renderLocks();
  } else {
    stopTimer();
    activeLock = null;
    puzzleArea.hidden = true;
    renderStartCard(s);
    if (wasActive) {
      loadLeaderboard();
      setMessage(s.status === 'won' ? 'You escaped! All locks are open.' : "Time's up!", s.status === 'won' ? 'success' : 'error');
      if (s.status === 'won') {
        play('win');
        confetti();
      } else {
        play('lose');
      }
    }
  }
}

async function refreshState() {
  try {
    applyState((await api('/api/game/state')).data);
  } catch (err) {
    if (err.message !== 'Not logged in') setMessage('Could not reach the server.', 'error');
  }
}

async function loadLeaderboard() {
  try {
    const { data } = await api('/api/game/leaderboard');
    const list = $('leaderboard');
    list.replaceChildren();
    if (data.scores.length === 0) {
      const li = document.createElement('li');
      li.className = 'muted';
      li.textContent = 'No escapes yet. Be the first!';
      list.appendChild(li);
    }
    data.scores.forEach((row) => {
      const li = document.createElement('li');
      li.innerHTML = '<span class="name"></span><span class="pts"></span><span class="muted"></span>';
      li.children[0].textContent = `${row.username} (${row.difficulty})`;
      li.children[1].textContent = `${row.score} pts`;
      li.children[2].textContent = `${(row.time_ms / 1000).toFixed(1)}s`;
      list.appendChild(li);
    });
  } catch (err) {
    // The leaderboard is optional; ignore failures.
  }
}

// ---- Game actions ----
async function startGame() {
  try {
    const { data } = await post('/api/game/start', { difficulty: level });
    setMessage('Pick a lock to begin. The clock is running!', 'info');
    applyState(data);
  } catch (err) {
    if (err.message !== 'Not logged in') setMessage('Could not reach the server.', 'error');
  }
}

async function openLock(id) {
  setMessage('Loading puzzle...', 'info');
  try {
    const { ok, data } = await post(`/api/game/lock/${id}/puzzle`);
    if (!ok) {
      setMessage(data.error || 'Could not load a puzzle.', 'error');
      if (data.error && data.error.startsWith('No game')) refreshState();
      return;
    }
    activeLock = id;
    $('puzzleTitle').textContent = lockName(id);
    $('puzzleImage').src = data.question;
    $('attempts').textContent = `Attempts left: ${data.attemptsLeft}`;
    $('hintText').textContent = '';
    $('hintBtn').disabled = false;
    answerInput.value = '';
    puzzleArea.hidden = false;
    answerInput.focus();
    setMessage('Find the missing digit and submit your answer.', 'info');
    renderLocks();
  } catch (err) {
    if (err.message !== 'Not logged in') setMessage('Could not reach the server.', 'error');
  }
}

async function useHint() {
  if (activeLock === null) return;
  try {
    const { ok, data } = await post(`/api/game/lock/${activeLock}/hint`);
    if (!ok) {
      setMessage(data.error || 'No hint available.', 'error');
      return;
    }
    play('hint');
    $('hintText').textContent = data.hint;
    $('hintBtn').disabled = data.hintsLeft === 0;
    state = { ...state, hints: data.hints };
    $('hintsUsed').textContent = data.hints;
  } catch (err) {
    if (err.message !== 'Not logged in') setMessage('Could not reach the server.', 'error');
  }
}

function shake() {
  puzzleArea.classList.remove('shake');
  void puzzleArea.offsetWidth; // restart the animation
  puzzleArea.classList.add('shake');
}

async function submitAnswer() {
  if (activeLock === null) {
    setMessage('Choose a lock first.', 'error');
    return;
  }
  const answer = answerInput.value.trim();
  if (answer === '') {
    setMessage('Please enter an answer first.', 'error');
    return;
  }

  const lockId = activeLock;
  try {
    const { ok, data } = await post(`/api/game/lock/${lockId}/answer`, { answer });
    if (!ok) {
      setMessage(data.error || 'Something went wrong.', 'error');
      if (data.error && data.error.startsWith('No game')) refreshState();
      return;
    }

    if (data.correct) {
      puzzleArea.hidden = true;
      activeLock = null;
      applyState(data);
      if (data.status === 'active') {
        play('correct');
        const streakNote = data.streak > 1 ? ` Streak x${data.streak}!` : '';
        setMessage(`${LOCKS[lockId - 1] ? LOCKS[lockId - 1].story : 'The lock opens.'}${streakNote}`, 'success');
      }
    } else if (data.jammed) {
      applyState(data);
      shake();
      play('wrong');
      setMessage('Lock jammed! Here is a fresh puzzle.', 'error');
      openLock(lockId);
    } else {
      applyState(data);
      shake();
      play('wrong');
      $('attempts').textContent = `Attempts left: ${data.attemptsLeft}`;
      answerInput.select();
      setMessage('Wrong answer. Try again.', 'error');
    }
  } catch (err) {
    if (err.message !== 'Not logged in') setMessage('Could not reach the server.', 'error');
  }
}

// ---- Events ----
$('startBtn').addEventListener('click', startGame);
$('muteBtn').addEventListener('click', () => {
  muted = !muted;
  $('muteBtn').textContent = muted ? 'Sound: off' : 'Sound: on';
  try {
    localStorage.setItem('muted', muted ? '1' : '0');
  } catch (err) {
    // Ignore storage problems.
  }
});
$('resetBtn').addEventListener('click', startGame);
$('submitBtn').addEventListener('click', submitAnswer);
$('hintBtn').addEventListener('click', useHint);
puzzleArea.addEventListener('animationend', () => puzzleArea.classList.remove('shake'));

answerInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') submitAnswer();
});

// Keyboard shortcut: 1, 2, 3 pick a lock (ignored while typing in the answer box).
document.addEventListener('keydown', (event) => {
  if (event.target === answerInput || board.hidden) return;
  const id = Number(event.key);
  if (Number.isInteger(id) && id >= 1 && id <= state.totalLocks && !state.solved.includes(id)) {
    openLock(id);
  }
});

$('logoutBtn').addEventListener('click', async () => {
  try {
    await fetch('/api/auth/logout', { method: 'POST' });
  } finally {
    window.location.href = 'login.html';
  }
});

async function init() {
  $('muteBtn').textContent = muted ? 'Sound: off' : 'Sound: on';
  try {
    const me = await api('/api/auth/me');
    $('username').textContent = me.data.username;
    await refreshState();
    loadLeaderboard();
  } catch (err) {
    if (err.message !== 'Not logged in') setMessage('Could not reach the server.', 'error');
  }
}

init();
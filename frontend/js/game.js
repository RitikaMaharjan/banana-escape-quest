// Browser side of the game. The server decides everything that matters
// (timer, answers, score); this file only displays state and sends events.
// AI-assisted (Claude, Anthropic): timer, hints, sound and leaderboard UI were added with AI help.

const $ = (id) => document.getElementById(id);
const locksEl = $('locks');
const board = $('board');
const startCard = $('startCard');
const puzzleArea = $('puzzleArea');
const answerInput = $('answerInput');
const message = $('message');

let state = null;
let activeLock = null;
let deadline = 0;
let timerId = null;

// ---- Sound: short beeps made with the Web Audio API (no sound files needed) ----
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
  correct: (t) => { tone(988, t, 0.08, 'square'); tone(1319, t + 0.08, 0.25, 'square'); },
  wrong: (t) => { tone(200, t, 0.12, 'square'); tone(150, t + 0.12, 0.2, 'square'); },
  hint: (t) => { tone(740, t, 0.08, 'square'); tone(880, t + 0.08, 0.1, 'square'); },
  win: (t) => [523, 659, 784, 1047, 784, 1047].forEach((f, i) => tone(f, t + i * 0.1, 0.15, 'square')),
  lose: (t) => [440, 370, 311, 262].forEach((f, i) => tone(f, t + i * 0.18, 0.2, 'square')),
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

// ---- Helpers ----
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

function networkError(err) {
  if (err.message !== 'Not logged in') setMessage('Could not reach the server.', 'error');
}

function formatClock(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// ---- Timer: a repeating event that updates the clock ----
function tick() {
  const left = deadline - Date.now();
  $('timer').textContent = formatClock(left);
  $('timer').classList.toggle('low', left <= 30000);
  if (left <= 0) {
    stopTimer();
    refreshState(); // let the server confirm the timeout
  }
}

function startTimer() {
  stopTimer();
  tick();
  timerId = setInterval(tick, 250);
}

function stopTimer() {
  clearInterval(timerId);
  timerId = null;
}

// ---- Rendering ----
function renderStartCard(s) {
  const texts = {
    won: ['You escaped!', `Score ${s.score} in ${(s.timeTakenMs / 1000).toFixed(1)} seconds. Can you beat it?`, 'Play again'],
    timeout: ["Time's up!", `You opened ${s.solved.length} of ${s.totalLocks} locks.`, 'Try again'],
  };
  const [title, text, button] = texts[s.status] || [
    'Ready to escape?',
    `Open ${s.totalLocks} locks in ${formatClock(s.timeLimitMs)}. Mistakes and hints cost points.`,
    'Start',
  ];
  $('startTitle').textContent = title;
  $('startText').textContent = text;
  $('startBtn').textContent = button;
}

function renderUsed(s) {
  $('usedInfo').textContent = `Mistakes: ${s.wrong}  |  Hints used: ${s.hints}`;
}

function renderLocks() {
  locksEl.replaceChildren();
  for (let id = 1; id <= state.totalLocks; id++) {
    const open = state.solved.includes(id);
    const btn = document.createElement('button');
    btn.className = 'lock';
    if (open) btn.classList.add('open');
    if (id === activeLock) btn.classList.add('active');
    btn.textContent = open ? `Lock ${id}: open` : `Lock ${id}`;
    btn.disabled = open;
    btn.addEventListener('click', () => openLock(id));
    locksEl.appendChild(btn);
  }
  $('progress').textContent = `${state.solved.length} / ${state.totalLocks}`;
  $('progressFill').style.width = `${(state.solved.length / state.totalLocks) * 100}%`;
  renderUsed(state);
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
    return;
  }

  stopTimer();
  activeLock = null;
  puzzleArea.hidden = true;
  renderStartCard(s);

  if (wasActive) {
    loadLeaderboard();
    if (s.status === 'won') {
      play('win');
      setMessage('You escaped! All locks are open.', 'success');
    } else {
      play('lose');
      setMessage("Time's up!", 'error');
    }
  }
}

async function refreshState() {
  try {
    applyState((await api('/api/game/state')).data);
  } catch (err) {
    networkError(err);
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
      li.children[0].textContent = row.username;
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
    const { data } = await post('/api/game/start');
    setMessage('Pick a lock to begin. The clock is running!', 'info');
    applyState(data);
  } catch (err) {
    networkError(err);
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
    $('puzzleTitle').textContent = `Lock ${id}`;
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
    networkError(err);
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
    renderUsed(state);
  } catch (err) {
    networkError(err);
  }
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
        setMessage('Correct! The lock opens.', 'success');
      }
    } else if (data.jammed) {
      applyState(data);
      play('wrong');
      setMessage('Lock jammed! Here is a fresh puzzle.', 'error');
      openLock(lockId);
    } else {
      applyState(data);
      play('wrong');
      $('attempts').textContent = `Attempts left: ${data.attemptsLeft}`;
      answerInput.select();
      setMessage('Wrong answer. Try again.', 'error');
    }
  } catch (err) {
    networkError(err);
  }
}

// ---- Events ----
$('startBtn').addEventListener('click', startGame);
$('resetBtn').addEventListener('click', startGame);
$('submitBtn').addEventListener('click', submitAnswer);
$('hintBtn').addEventListener('click', useHint);

answerInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') submitAnswer();
});

$('muteBtn').addEventListener('click', () => {
  muted = !muted;
  $('muteBtn').textContent = muted ? 'Sound: off' : 'Sound: on';
  try {
    localStorage.setItem('muted', muted ? '1' : '0');
  } catch (err) {
    // Ignore storage problems.
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
    networkError(err);
  }
}

init();
const { fetchPuzzle } = require('../services/bananaService');

async function getPuzzle(req, res) {
  try {
    const data = await fetchPuzzle();

    const solution = Number(data.solution);
    const isDigit = Number.isInteger(solution) && solution >= 0 && solution <= 9;

    let questionUrl;
    try {
      questionUrl = new URL(data.question);
    } catch (err) {
      questionUrl = null;
    }

    if (!isDigit || !questionUrl || questionUrl.protocol !== 'https:') {
      return res.status(502).json({ error: 'Banana API returned an unexpected format' });
    }

    // Keep the answer on the server. Never send it to the browser.
    req.session.puzzle = { solution };

    res.json({ question: data.question });
  } catch (err) {
    console.error('Puzzle error:', err.message);
    res.status(err.status || 500).json({ error: err.message });
  }
}

function checkAnswer(req, res) {
  const puzzle = req.session.puzzle;
  if (!puzzle) {
    return res.status(400).json({ error: 'No active puzzle. Load a puzzle first.' });
  }

  const { answer } = req.body || {};
  const value = Number(answer);
  if (answer === undefined || answer === '' || !Number.isInteger(value)) {
    return res.status(400).json({ error: 'Answer must be a whole number' });
  }

  const correct = value === puzzle.solution;
  if (correct) {
    delete req.session.puzzle;
  }

  res.json({ correct });
}

module.exports = { getPuzzle, checkAnswer };